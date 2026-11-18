// Tests of the wake-ups' functions (functions.ts): `wake` makes a reminder
// or a routine, with its zone, its first fire and the caller's turn and
// call; each refusal, with its exact text, writes no row; the arguments;
// off; `wakes`, the active rows first; `unwake`, with its call; the notes
// of a make and of a stop at the program's close; a chain of reminders
// with the source and the firer; the names; seeded inputs; and the size of
// `wakes`' result. Each case runs on a file's store, the tests' fake wire
// and the turn loop with this package's source, on a `TestClock` set before
// the layers are built. A program is a fake sandbox's: each of its calls
// is a row of the store under the program's call, and runs the entry with
// that caller, as the sandbox's `invoke` does (packages/codemode/src/
// calls.ts). The chain's firer tells each sleep, and the case moves the
// clock only while it sleeps.

import { expect, test } from "bun:test"
import { Cause, Clock, DateTime, Duration, Effect, Exit, Layer, PubSub, Queue, Result } from "effect"
import { TestClock } from "effect/testing"
import * as path from "node:path"
import { compactor, fakeWire, newFile, options, reply, rows, write } from "@everchat/local/testing"
import { limitLayer } from "@everchat/local/limitfile"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { storeLayer } from "@everchat/sqlite/bun"
import { Ask, AskDelay } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { type Entry, FunctionError, HOSTED, mismatches, pending, refusals, wallClock } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { LIMIT } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Store, WAKE_TEXT_MAX } from "@everchat/core/store"
import { type TurnEvent, Turns } from "@everchat/core/turn"
import { firer } from "./firer.ts"
import { ACTIVE_MAX, declarations, entries, type Options, SHOWN_MAX } from "./functions.ts"
import { source } from "./source.ts"
import { machineZone, nextSlot, parse, reminderAt, type When, WHEN_MAX, zone, ZONE_MAX } from "./time.ts"

const M = 60_000
const HOUR = 60 * M
const DAY = 24 * HOUR
// 09:00 in Berlin, a Monday.
const T0 = Date.parse("2026-11-16T08:00:00Z")

// The texts that time.ts gives a refusal of `when`.
const REMINDER_HELP = "A reminder's time is a local date and time with no offset and no zone, to the minute or the second, such as 2026-11-18T09:00."
const ROUTINE_HELP = "A routine is the 5 fields of cron (minute, hour, day of the month, month, day of the week), such as 15 9 * * 1-5."
const WAKE_EXAMPLE = `wake({ when: "2026-11-18T09:00", text: "Call the bank." })`
const WHEN_HELP = `give a reminder's time, such as "2026-11-18T09:00", or a routine, such as "15 9 * * 1-5"`
const ID_AGAIN = "Give the id of an active wake-up, such as unwake({ id: 3 }); wakes() lists them."
const FULL = "20 wake-ups are active, the most that a chat may have: stop one with unwake, such as unwake({ id: 3 }), to free a place; wakes() lists them."

// What a call gave the program: its result (`ok`), the message of its
// `FunctionError` (`error`), or any other failure (`other`), which no case
// expects.
type Outcome = { readonly ok: unknown } | { readonly error: string } | { readonly other: string }

// A call of a function by a program, with the arguments as the program gave
// them.
type Call = (name: string, ...args: ReadonlyArray<unknown>) => Effect.Effect<Outcome>

// A program: its calls, and the store; it gives the program's output, or
// "ran".
type Program = (call: Call, store: Store["Service"], at: { readonly turn: number; readonly call: number }) => Effect.Effect<string | void, unknown>

// What a launch keeps: the store and the entries (made over it, with the
// launch's options), and each call with what it gave, in order.
interface Held {
  store: Store["Service"] | null
  entries: ReadonlyArray<Entry> | null
  readonly calls: Array<readonly [string, Outcome]>
}

const holder = (): Held => ({ store: null, entries: null, calls: [] })

// The fake sandbox: each run takes the next program (`next`). A call is the
// row of the store under the program's call, the entry run with the caller
// (the turn, the program, the call's row), and the row's end, as the
// sandbox's `invoke` does.
const sandbox = (held: Held, next: () => Program | undefined): Sandbox["Service"]["run"] => (_program, at) =>
  Effect.gen(function*() {
    const store = held.store!
    const program = next()
    if (program === undefined) return { output: "no program", failed: true }
    const call: Call = (name, ...args) =>
      Effect.gen(function*() {
        const id = yield* store.startCall({ turn: at.turn, parent: at.call, fn: name, input: JSON.stringify(args) })
        const entry = held.entries!.find((one) => one.declaration.name === name)!
        const exit = yield* Effect.exit(entry.run(args, { turn: at.turn, program: at.call, call: id }))
        let outcome: Outcome
        if (Exit.isSuccess(exit)) {
          outcome = { ok: exit.value }
          yield* store.endCall(id, { status: "done", output: JSON.stringify(exit.value) })
        } else {
          const error = Cause.squash(exit.cause)
          outcome = error instanceof FunctionError ? { error: error.message } : { other: String(error) }
          yield* store.endCall(id, { status: "failed", output: String(error) })
        }
        held.calls.push([name, outcome])
        return outcome
      }).pipe(Effect.orDie)
    const output = yield* program(call, store, at)
    return { output: typeof output === "string" ? output : "ran", failed: false }
  }).pipe(Effect.orDie)

// The firer's clock: the `TestClock`, with each sleep told before it starts.
const told = (slept: Queue.Queue<number>): Layer.Layer<never> =>
  Layer.effect(
    Clock.Clock,
    Effect.clockWith((real) =>
      Effect.succeed(Object.assign(Object.create(real) as Clock.Clock, {
        sleep: (duration: Duration.Duration) => Effect.andThen(Queue.offer(slept, Duration.toMillis(duration)), real.sleep(duration))
      }))
    )
  )

// The turn loop as the firer sees it: its listener gets no event, so only
// the clock's rounds run.
const muted: Layer.Layer<Turns, never, Turns> = Layer.effect(
  Turns,
  Effect.gen(function*() {
    const real = yield* Turns
    return Turns.of({ ...real, subscribe: Effect.flatMap(PubSub.unbounded<TurnEvent>(), (hub) => PubSub.subscribe(hub)) })
  })
)

// A store over the real one: `over` gives the members that it changes.
const over = (change: (real: Store["Service"]) => Partial<Store["Service"]>): Layer.Layer<Store, never, Store> =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({ ...real, ...change(real) })
    })
  )

// One launch: the store over `file`, the memory, the ask service over the
// fake wire, the fake sandbox and the turn loop with this package's source,
// its head with the local declarations and these; the firer too when
// `given.slept` is given (its sleeps told there); on a TestClock set to
// `given.at` (T0) before the layers are built. The entries are made over
// the launch's store, with `given.options`.
const launch = <A, E>(
  file: string,
  held: Held,
  next: () => Program | undefined,
  wire: ReturnType<typeof fakeWire>,
  effect: Effect.Effect<A, E, Turns | Memory | Store | TestClock.TestClock>,
  given: {
    readonly options?: Options
    readonly store?: Layer.Layer<Store, never, Store>
    readonly at?: number
    readonly slept?: Queue.Queue<number>
  } = {}
) => {
  const real = storeLayer(file, options())
  const store = given.store === undefined ? real : given.store.pipe(Layer.provide(real))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const fake = Layer.succeed(Sandbox, Sandbox.of({ run: sandbox(held, next) }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ head: head([...DECLARATIONS, ...declarations]) }).pipe(
    Layer.provide(source),
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, fake, limit))
  )
  const all = given.slept === undefined ? turns : firer.pipe(Layer.provide(Layer.merge(told(given.slept), muted)), Layer.provideMerge(turns))
  const body = Effect.gen(function*() {
    held.store = yield* Store
    held.entries = entries(held.store, given.options)
    return yield* effect
  })
  return Effect.runPromise(
    Effect.andThen(TestClock.setTime(given.at ?? T0), body.pipe(Effect.provide(all))).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(AskDelay, () => Effect.succeed(0))
    )
  )
}

const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, { text: "", output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }], calls: [{ id, name: "run", input: program }] })

// A model that runs `count` programs, one at each request, then says it is
// done.
const programs = (count: number) => fakeWire((asked, n) => (n <= count ? runs(asked, "p" + n, "program " + n) : says(asked, "Done.")))

// One turn of the person's message "go", whose programs are `list`, in
// order; `then` runs after the turn, in the launch.
const turn = async (
  list: ReadonlyArray<Program>,
  given: Parameters<typeof launch>[5] & { readonly file?: string; readonly then?: Effect.Effect<void, unknown, Store | Turns> } = {}
) => {
  const file = given.file ?? newFile()
  const held = holder()
  const queue = [...list]
  const wire = programs(list.length)
  await launch(file, held, () => queue.shift(), wire, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* turns.idle
    if (given.then !== undefined) yield* given.then
  }), given)
  return { file, calls: held.calls, wire }
}

// The rows of the wake-ups, as kept.
const wakeRows = (file: string) =>
  rows(file, "select n as id, text, cron, at, zone, first, turn, call, due, pending, stopped, why, stop_call from everchat_wake order by n")
const countRows = (file: string) => rows<{ n: number }>(file, "select count(*) as n from everchat_wake")[0]!.n
// The function calls of the programs: their row, function, program and state.
const callRows = (file: string) => rows(file, "select n as id, fn, parent, status from everchat_call where parent is not null order by n")
// The log: each message as "<i> <kind> <call> <text>" (a call of none: -).
const logOf = (file: string) =>
  rows<{ i: number; kind: string; call: number | null; text: string }>(file, "select i, kind, call, text from everchat_msg_read order by i").map((row) =>
    `${row.i} ${row.kind} ${row.call ?? "-"} ${row.text}`
  )
const events = (file: string) =>
  rows<{ type: string; msg: number | null }>(file, "select type, msg from everchat_event order by n").map((row) => row.type + (row.msg === null ? "" : " " + row.msg))
const kinds = (file: string) => rows<{ kind: string }>(file, "select kind from everchat_msg_read order by i").map((row) => row.kind)
// When each wake message was written, from T0, in order.
const firedAt = (file: string) =>
  rows<{ created: number }>(file, "select m.created from everchat_msg m join everchat_kind k on k.id = m.kind where k.name = 'wake' order by m.i").map((one) => one.created - T0)

// A time on Berlin's wall clock as a reminder's `when`: `2026-11-16T09:01`.
const berlin = (at: number) => wallClock(at, "Europe/Berlin").slice(0, 16).replace(" ", "T")

// The make
// --------

test("a make: a reminder, a routine and a reminder to the second, each row as kept (its text, its routine or its time, its zone as the engine names it, first and due, the program's turn and the function's call) and the result's id and next on the row's wall clock", async () => {
  const { file, calls } = await turn([(call) =>
    Effect.gen(function*() {
      yield* call("wake", { when: "2026-11-16T10:30", text: "Call the bank.", zone: "Europe/Berlin" })
      yield* call("wake", { when: " 15 9 * * 1-5 ", text: "Standup.", zone: "america/new_york" })
      yield* call("wake", { when: "2026-11-17 09:00:30", text: "Seconds.", zone: "Asia/Tokyo" })
    })])
  expect(calls).toStrictEqual([
    ["wake", { ok: { id: 1, next: "2026-11-16 10:30 Europe/Berlin" } }],
    ["wake", { ok: { id: 2, next: "2026-11-16 09:15 America/New_York" } }],
    ["wake", { ok: { id: 3, next: "2026-11-17 09:00 Asia/Tokyo" } }]
  ])
  const at1 = Date.parse("2026-11-16T09:30:00Z")
  const first2 = Date.parse("2026-11-16T14:15:00Z")
  const at3 = Date.parse("2026-11-17T00:00:30Z")
  const active = { pending: null, stopped: null, why: null, stop_call: null }
  expect(wakeRows(file)).toEqual([
    { id: 1, text: "Call the bank.", cron: null, at: at1, zone: "Europe/Berlin", first: at1, turn: 1, call: 2, due: at1, ...active },
    { id: 2, text: "Standup.", cron: "15 9 * * 1-5", at: null, zone: "America/New_York", first: first2, turn: 1, call: 3, due: first2, ...active },
    { id: 3, text: "Seconds.", cron: null, at: at3, zone: "Asia/Tokyo", first: at3, turn: 1, call: 4, due: at3, ...active }
  ])
  expect(callRows(file)).toEqual([2, 3, 4].map((id) => ({ id, fn: "wake", parent: 1, status: "done" })))
})

test("the zone's order: the argument's, else the option's (the config file's), with null as none, else the machine's; and the option never before the argument's", async () => {
  const machine = DateTime.zoneToString(machineZone())
  // Three zones that differ from one another and from the machine's.
  const [option, argument] = ["Asia/Tokyo", "America/New_York", "Pacific/Auckland"].filter((one) => one !== machine) as [string, string]
  const when = "2026-11-17T09:00"
  const zoned = await turn([(call) =>
    Effect.gen(function*() {
      yield* call("wake", { when, text: "a", zone: argument })
      yield* call("wake", { when, text: "b" })
      yield* call("wake", { when, text: "c", zone: null })
    })], { options: { zone: DateTime.zoneMakeNamedUnsafe(option) } })
  expect(zoned.calls).toStrictEqual([
    ["wake", { ok: { id: 1, next: `2026-11-17 09:00 ${argument}` } }],
    ["wake", { ok: { id: 2, next: `2026-11-17 09:00 ${option}` } }],
    ["wake", { ok: { id: 3, next: `2026-11-17 09:00 ${option}` } }]
  ])
  expect(rows(zoned.file, "select zone from everchat_wake order by n")).toEqual([{ zone: argument }, { zone: option }, { zone: option }])
  const plain = await turn([(call) => Effect.asVoid(call("wake", { when, text: "d" }))])
  expect(plain.calls).toStrictEqual([["wake", { ok: { id: 1, next: `2026-11-17 09:00 ${machine}` } }]])
  expect(rows(plain.file, "select zone, first from everchat_wake")).toEqual([{ zone: machine, first: reminderAt(Result.getOrThrow(parse(when, machineZone())) as Extract<When, { readonly _tag: "Reminder" }>) }])
})

test("the result's next is the row's first, as the make's note: a store that gives the made row with another due still gives first", async () => {
  const { calls } = await turn([(call) => Effect.asVoid(call("wake", { when: "2026-11-16T10:30", text: "Call the bank.", zone: "Europe/Berlin" }))], {
    store: over((real) => ({
      makeWake: (wake, limit) => Effect.map(real.makeWake(wake, limit), (made) => (made._tag === "made" ? { _tag: "made" as const, wake: { ...made.wake, due: made.wake.first + DAY } } : made))
    }))
  })
  expect(calls).toStrictEqual([["wake", { ok: { id: 1, next: "2026-11-16 10:30 Europe/Berlin" } }]])
})

// The refusals of wake
// --------------------

test("each refusal of wake, with its exact text, writes no row: a when of neither form, one over WHEN_MAX, a zone that is not IANA, one over ZONE_MAX, a routine of two minutes, a seconds field, a reminder in the past, a routine with no slot in 5 years, an empty text, a text of 2,001 characters; a text of 2,000 is made", async () => {
  const wake = (when: string, text = "Call the bank.", zoneName: string = "Europe/Berlin") => ({ when, text, zone: zoneName })
  const refused: Array<Outcome> = []
  let written = -1
  const { file, calls } = await turn([(call, store) =>
    Effect.gen(function*() {
      for (
        const args of [
          wake("next tuesday"),
          wake("x".repeat(WHEN_MAX + 1)),
          wake("2026-11-17T09:00", "a", "+01:00"),
          wake("2026-11-17T09:00", "a", "A".repeat(ZONE_MAX + 1)),
          wake("*/2 * * * *"),
          wake("0 0 9 * * *"),
          wake("2026-11-16T08:59"),
          wake("0 0 30 2 *"),
          wake("2026-11-17T09:00", ""),
          wake("2026-11-17T09:00", "t".repeat(WAKE_TEXT_MAX + 1))
        ]
      ) refused.push(yield* call("wake", args))
      // No refused call wrote a row.
      written = (yield* store.wakes()).length
      yield* call("wake", wake("2026-11-17T09:00", "t".repeat(WAKE_TEXT_MAX)))
    })])
  expect(refused).toEqual([
    { error: `The field when of wake: "next tuesday" is 2 fields, neither a reminder's time nor a routine. ${ROUTINE_HELP}` },
    { error: `The field when of wake: A when of 201 characters is over the bound of 200. ${REMINDER_HELP} ${ROUTINE_HELP}` },
    { error: `The field zone of wake: "+01:00" is not a time zone: give an IANA name, such as Europe/Berlin.` },
    { error: `The field zone of wake: A time zone's name of 101 characters is over the bound of 100: give an IANA name, such as Europe/Berlin.` },
    {
      error:
        `The field when of wake: "*/2 * * * *" is a routine that can fire more than one time in an hour: its minute field "*/2" must be one minute, such as 0 (each hour at :00) or 15. ${ROUTINE_HELP}`
    },
    { error: `The field when of wake: "0 0 9 * * *" is 6 fields: a routine has no seconds field, and fires on a minute. ${ROUTINE_HELP}` },
    {
      error:
        `The field when of wake: "2026-11-16T08:59" is in the past: it was 2026-11-16 08:59 Europe/Berlin, and now is 2026-11-16 09:00 Europe/Berlin. Give a time to come, such as "2026-11-17T09:00".`
    },
    {
      error:
        `The field when of wake: "0 0 30 2 *" is a routine with no time in the 5 years after 2026-11-16 09:00 Europe/Berlin: it names a date that never comes, such as 30 February. ${ROUTINE_HELP}`
    },
    { error: `The field text of wake is empty: give what the wake-up's turn reads, a text of 1 to 2000 characters, such as "Call the bank".` },
    { error: `The field text of wake has 2001 characters, over the bound of 2000: give a shorter text, such as "Call the bank".` }
  ])
  expect(written).toBe(0)
  expect(calls[10]).toStrictEqual(["wake", { ok: { id: 1, next: "2026-11-17 09:00 Europe/Berlin" } }])
  expect(rows(file, "select n, length(text) as size from everchat_wake")).toEqual([{ n: 1, size: 2000 }])
  // Each refused call's row is failed, with the message.
  expect(rows<{ status: string }>(file, "select status from everchat_call where parent is not null order by n").map((one) => one.status)).toEqual([...Array<string>(10).fill("failed"), "done"])
})

test("the 21st active row is refused, with its text and no row; after an unwake the next make is made; a stopped row does not count", async () => {
  const outcomes: Array<Outcome> = []
  const { file } = await turn([(call) =>
    Effect.gen(function*() {
      for (let k = 1; k <= ACTIVE_MAX; k++) outcomes.push(yield* call("wake", { when: "2026-11-17T09:00", text: `Row ${k}.`, zone: "Europe/Berlin" }))
      outcomes.push(yield* call("wake", { when: "2026-11-17T09:00", text: "Row 21.", zone: "Europe/Berlin" }))
      outcomes.push(yield* call("unwake", { id: 1 }))
      outcomes.push(yield* call("wake", { when: "2026-11-17T09:00", text: "Row 21, again.", zone: "Europe/Berlin" }))
      outcomes.push(yield* call("wake", { when: "2026-11-17T09:00", text: "Row 22.", zone: "Europe/Berlin" }))
    })])
  expect(ACTIVE_MAX).toBe(20)
  expect(outcomes.slice(0, 20).map((one) => ("ok" in one ? (one.ok as { id: number }).id : one))).toEqual(Array.from({ length: 20 }, (_, k) => k + 1))
  expect(outcomes.slice(20)).toStrictEqual([
    { error: FULL },
    { ok: { id: 1, stopped: true } },
    { ok: { id: 21, next: "2026-11-17 09:00 Europe/Berlin" } },
    { error: FULL }
  ])
  expect(rows(file, "select count(*) as rows, sum(stopped is null) as active from everchat_wake")).toEqual([{ rows: 21, active: 20 }])
  expect(rows(file, "select text from everchat_wake where n = 21")).toEqual([{ text: "Row 21, again." }])
})

// The arguments
// -------------

test("the arguments: none, two, a text for the object, a field of the wrong type or missing, a field that is not known (its name escaped and cut), an id of 1.5, 0 and a text, and an argument of wakes: each refused with its text, nothing written or stopped", async () => {
  const hidden = "\u202e" + "k".repeat(300)
  const { file, calls } = await turn([(call) =>
    Effect.gen(function*() {
      yield* call("wake", { when: "2026-11-17T09:00", text: "Kept.", zone: "Europe/Berlin" })
      yield* call("wake")
      yield* call("wake", { when: "2026-11-17T09:00", text: "a" }, { when: "2026-11-17T09:00", text: "b" })
      yield* call("wake", "2026-11-17T09:00")
      yield* call("wake", [{ when: "2026-11-17T09:00", text: "a" }])
      yield* call("wake", { when: 5, text: "a" })
      yield* call("wake", { text: "a" })
      yield* call("wake", { when: "2026-11-17T09:00", text: ["a"] })
      yield* call("wake", { when: "2026-11-17T09:00", text: "a", zone: 1 })
      yield* call("wake", { when: "2026-11-17T09:00", text: "a", at: 1 })
      yield* call("wake", { when: "2026-11-17T09:00", text: "a", [hidden]: 1 })
      yield* call("unwake", { id: 1.5 })
      yield* call("unwake", { id: 0 })
      yield* call("unwake", { id: "1" })
      yield* call("unwake", {})
      yield* call("unwake")
      yield* call("unwake", { id: 1, why: "done" })
      yield* call("wakes", 1)
      // A trailing argument left out (null) is none.
      yield* call("wakes", null)
    })])
  expect(calls.slice(1, 18).map(([name, outcome]) => [name, "error" in outcome ? outcome.error : outcome])).toEqual([
    ["wake", `wake takes one argument, an object, and got none: such as ${WAKE_EXAMPLE}.`],
    ["wake", `wake takes one argument, an object, and got 2: such as ${WAKE_EXAMPLE}.`],
    ["wake", `wake takes one argument, an object, and got a text: such as ${WAKE_EXAMPLE}.`],
    ["wake", `wake takes one argument, an object, and got a list: such as ${WAKE_EXAMPLE}.`],
    ["wake", `The field when of wake is a number, not a text: ${WHEN_HELP}.`],
    ["wake", `The field when of wake is missing: ${WHEN_HELP}.`],
    ["wake", `The field text of wake is a list, not a text: give what the wake-up's turn reads, a text of 1 to 2000 characters, such as "Call the bank".`],
    ["wake", `The field zone of wake is a number, not a text: give an IANA time zone, such as "Europe/Berlin", or leave it out.`],
    ["wake", `wake has no field "at": its fields are when, text and zone, such as ${WAKE_EXAMPLE}.`],
    ["wake", `wake has no field "\\u{202e}${"k".repeat(SHOWN_MAX - 1)}…": its fields are when, text and zone, such as ${WAKE_EXAMPLE}.`],
    ["unwake", `The field id of unwake is 1.5, not a whole number over 0: give the id of an active wake-up, such as unwake({ id: 3 }); wakes() lists them.`],
    ["unwake", `The field id of unwake is 0, not a whole number over 0: give the id of an active wake-up, such as unwake({ id: 3 }); wakes() lists them.`],
    ["unwake", `The field id of unwake is the text "1", not a whole number over 0: give the id of an active wake-up, such as unwake({ id: 3 }); wakes() lists them.`],
    ["unwake", `The field id of unwake is missing: give the id of an active wake-up, such as unwake({ id: 3 }); wakes() lists them.`],
    ["unwake", `unwake takes one argument, an object, and got none: such as unwake({ id: 3 }).`],
    ["unwake", `unwake has no field "why": its one field is id, such as unwake({ id: 3 }).`],
    ["wakes", `wakes takes no argument, and got 1: call wakes().`]
  ])
  expect(calls[18]![1]).toEqual({ ok: [expect.objectContaining({ id: 1, text: "Kept." })] })
  expect(wakeRows(file)).toEqual([expect.objectContaining({ id: 1, text: "Kept.", stopped: null })])
})

// Off
// ---

test("off (M7): with the chat's wake-ups off, wake makes the row and gives off: true; with them on, the result has no off", async () => {
  const { file, calls } = await turn([(call, store) =>
    Effect.gen(function*() {
      yield* store.setWakeups(false)
      yield* call("wake", { when: "2026-11-17T09:00", text: "Off.", zone: "Europe/Berlin" })
      yield* store.setWakeups(true)
      yield* call("wake", { when: "2026-11-17T09:30", text: "On.", zone: "Europe/Berlin" })
    })])
  expect(calls).toStrictEqual([
    ["wake", { ok: { id: 1, next: "2026-11-17 09:00 Europe/Berlin", off: true } }],
    ["wake", { ok: { id: 2, next: "2026-11-17 09:30 Europe/Berlin" } }]
  ])
  expect(rows(file, "select n, text, stopped from everchat_wake order by n")).toEqual([{ n: 1, text: "Off.", stopped: null }, { n: 2, text: "On.", stopped: null }])
})

// wakes
// -----

test("wakes: the active rows first, then the stopped, each by id, with each field: a routine whose fire waits (next its pending, not due), a reminder to the second, a fired reminder, a row stopped by the person, one by unwake; a text with line ends comes back exact", async () => {
  const listed: Array<Outcome> = []
  await turn([(call, store, at) =>
    Effect.gen(function*() {
      yield* call("wake", { when: "0 9 * * *", text: "Daily.\nTwo lines.\u2028", zone: "Europe/Berlin" })
      yield* call("wake", { when: "2026-11-16T09:30", text: "Remind.", zone: "Europe/Berlin" })
      yield* call("wake", { when: "2026-11-16T12:00", text: "Person stops.", zone: "Europe/Berlin" })
      yield* call("wake", { when: "30 * * * *", text: "Hourly.", zone: "UTC" })
      yield* call("wake", { when: "2026-11-18T09:00:30", text: "Later.", zone: "Europe/Berlin" })
      // Row 1: a fire waits, two slots missed, and its due after it.
      yield* store.pendWake(1, { pending: T0 + DAY, missed: 2, due: T0 + 2 * DAY })
      // Row 2: fired, so stopped, why fired.
      yield* store.pendWake(2, { pending: T0 + 30 * M, missed: 0, due: null })
      yield* store.fireWake(2, at.turn, { pending: T0 + 30 * M, missed: 0 })
      yield* store.stopWake(3, "person")
      yield* call("unwake", { id: 4 })
      listed.push(yield* call("wakes"))
    })])
  const none = { last: null, fired: 0, missed: 0, stopped: null, why: null }
  expect(listed).toStrictEqual([{
    ok: [
      { id: 1, text: "Daily.\nTwo lines.\u2028", when: "0 9 * * *", zone: "Europe/Berlin", next: "2026-11-17 09:00 Europe/Berlin", ...none, missed: 2 },
      { id: 5, text: "Later.", when: "2026-11-18T09:00:30", zone: "Europe/Berlin", next: "2026-11-18 09:00 Europe/Berlin", ...none },
      {
        id: 2,
        text: "Remind.",
        when: "2026-11-16T09:30",
        zone: "Europe/Berlin",
        next: null,
        last: "2026-11-16 09:30 Europe/Berlin",
        fired: 1,
        missed: 0,
        stopped: "2026-11-16 09:00 Europe/Berlin",
        why: "fired"
      },
      { id: 3, text: "Person stops.", when: "2026-11-16T12:00", zone: "Europe/Berlin", next: null, ...none, stopped: "2026-11-16 09:00 Europe/Berlin", why: "person" },
      { id: 4, text: "Hourly.", when: "30 * * * *", zone: "UTC", next: null, ...none, stopped: "2026-11-16 08:00 UTC", why: "unwake" }
    ]
  }])
})

test("the size of wakes' result: 1,000 stopped rows of 2,000 characters reach the program whole, the call's row keeps the whole, and the cut of the echo (LIMIT) holds what the model reads of a program that returns it", async () => {
  const file = newFile()
  const text = (k: number) => String(k).padStart(4, "0") + "x".repeat(WAKE_TEXT_MAX - 4)
  // The chat's row, then the rows in one statement: 1,000 makes and stops
  // through the store would take a transaction each.
  await launch(file, holder(), () => undefined, programs(0), Effect.void)
  write(
    file,
    `with recursive k(n) as (select 1 union all select n + 1 from k where n < 1000)
     insert into everchat_wake (chat, n, text, at, zone, first, stopped, why, created, updated)
     select (select id from everchat_chat), n, printf('%04d', n) || replace(printf('%${WAKE_TEXT_MAX - 4}s', ''), ' ', 'x'), ?1, 'Europe/Berlin', ?1, ?2, 'person', ?2, ?2 from k`,
    [T0 + DAY, T0]
  )
  const held = holder()
  let got: Outcome = { other: "no call" }
  const wire = programs(1)
  await launch(file, held, () => (call) =>
    Effect.gen(function*() {
      got = yield* call("wakes")
      return JSON.stringify("ok" in got ? got.ok : got)
    }), wire, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* turns.idle
  }))
  const list = ("ok" in got ? got.ok : []) as ReadonlyArray<{ readonly id: number; readonly text: string; readonly why: string }>
  expect(list.length).toBe(1000)
  expect(list.every((one, k) => one.id === k + 1 && one.text === text(k + 1) && one.why === "person")).toBe(true)
  const size = JSON.stringify(list).length
  expect(size).toBeGreaterThan(1000 * WAKE_TEXT_MAX)
  // The call's row and the program's row keep the whole result.
  expect(rows(file, "select fn, length(output) as size from everchat_call order by n")).toEqual([{ fn: "run", size }, { fn: "wakes", size }])
  // The echo, which the model reads, is cut to the output limit.
  const [echo] = rows<{ text: string }>(file, "select text from everchat_msg_read where kind = 'echo'")
  expect(echo!.text.length).toBeLessThanOrEqual(LIMIT)
  expect(echo!.text).toContain(`characters left out.`)
  expect(JSON.stringify(wire.sent[1]!.items).length).toBeLessThan(LIMIT + 10_000)
})

// unwake
// ------

test("unwake: the row stopped with why unwake and the call as its stop_call; wakesOf gives the make and the stop by their calls; the notes at the program's close; its waiting fire is never offered; a row that has stopped and an id that is not there are refused", async () => {
  const { file, calls, wire } = await turn([(call, store) =>
    Effect.gen(function*() {
      yield* call("wake", { when: "0 9 * * *", text: "Daily.", zone: "Europe/Berlin" })
      // A fire waits.
      yield* store.pendWake(1, { pending: T0, missed: 0, due: T0 + DAY })
      yield* call("unwake", { id: 1 })
      yield* call("unwake", { id: 1 })
      yield* call("unwake", { id: 7 })
      yield* call("unwake", { id: 2 ** 60 })
    })], {
    then: Effect.gen(function*() {
      const store = yield* Store
      const of = yield* store.wakesOf(1)
      expect(of.map((one) => [one.by, one.call, one.wake.id, one.wake.why, one.wake.stopCall])).toEqual([["made", 2, 1, "unwake", 3], ["stopped", 3, 1, "unwake", 3]])
      // Asked again: the stopped row's fire is never offered.
      yield* (yield* Turns).ready
      yield* (yield* Turns).idle
    })
  })
  expect(calls.slice(1)).toStrictEqual([
    ["unwake", { ok: { id: 1, stopped: true } }],
    ["unwake", { error: `The field id of unwake: wake-up 1 has stopped already (why: unwake). ${ID_AGAIN}` }],
    ["unwake", { error: `The field id of unwake: this chat has no wake-up 7. ${ID_AGAIN}` }],
    ["unwake", { error: `The field id of unwake: this chat has no wake-up ${2 ** 60}. ${ID_AGAIN}` }]
  ])
  expect(wakeRows(file)).toEqual([
    expect.objectContaining({ id: 1, due: null, pending: null, why: "unwake", stop_call: 3, stopped: T0 })
  ])
  expect(logOf(file)).toEqual([
    "0 user - go",
    "1 tool 1 program 1",
    "2 echo 1 ran",
    "3 note 1 Wake-up 1 set: next 2026-11-17 09:00 Europe/Berlin",
    "4 note 1 Wake-up 1 stopped.",
    "5 asst - Done."
  ])
  expect(wire.sent.length).toBe(2)
})

// The notes
// ---------

test("the make's note (M6), through the turn loop: after the approvals' notes, in the program's transaction; a make and an unwake in one program give both notes in the calls' order; no function wrote a message", async () => {
  const { file } = await turn([
    (call, store, at) =>
      Effect.gen(function*() {
        yield* call("wake", { when: "2026-11-16T10:30", text: "Call the bank.", zone: "Europe/Berlin" })
        const id = yield* store.startCall({ turn: at.turn, parent: at.call, fn: "send", input: JSON.stringify(["y"]) })
        yield* store.pendCall(id, (n) => JSON.stringify(pending(n)))
      }),
    (call) =>
      Effect.gen(function*() {
        yield* call("wake", { when: "15 9 * * 1-5", text: "Standup.", zone: "America/New_York" })
        yield* call("unwake", { id: 2 })
      })
  ])
  expect(logOf(file)).toEqual([
    "0 user - go",
    "1 tool 1 program 1",
    "2 echo 1 ran",
    "3 note 1 Approval 1 waits for a person's yes or no: send(\"y\"). The call did not run.",
    "4 note 1 Wake-up 1 set: next 2026-11-16 10:30 Europe/Berlin",
    "5 tool 4 program 2",
    "6 echo 4 ran",
    "7 note 4 Wake-up 2 set: next 2026-11-16 09:15 America/New_York",
    "8 note 4 Wake-up 2 stopped.",
    "9 asst - Done."
  ])
  // Each program's messages and their events come together, after its
  // calls: one transaction at its close.
  expect(events(file)).toEqual(["accepted 0", "start", "call", "message 1", "message 2", "message 3", "message 4", "call", "message 5", "message 6", "message 7", "message 8", "message 9", "end"])
  expect(kinds(file)).toEqual(["user", "tool", "echo", "note", "note", "tool", "echo", "note", "note", "asst"])
})

// A chain of reminders
// --------------------

test("a chain of reminders (section 11), with the source and the firer: each wake turn makes the next reminder for one minute later; 6 fire in 60 minutes, and the 7th waits for the first minute with room", async () => {
  const file = newFile()
  const held = holder()
  const slept = Effect.runSync(Queue.unbounded<number>())
  let k = 0
  // The model runs a program at each turn's first request, then is done.
  const wire = fakeWire((asked, n) => (n % 2 === 1 ? runs(asked, "p" + n, "program") : says(asked, "Done.")))
  const chain: Program = (call) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      k++
      const got = yield* call("wake", { when: berlin(now + M), text: `Chain ${k}.`, zone: "Europe/Berlin" })
      if (!("ok" in got)) return yield* Effect.die(new Error(JSON.stringify(got)))
    })
  await launch(file, held, () => chain, wire, Effect.gen(function*() {
    const turns = yield* Turns
    // The firer's first round, at the build: nothing to fire.
    expect(yield* Queue.take(slept)).toBe(60_000)
    yield* turns.say("go")
    yield* turns.idle
    let ms = 60_000
    while ((yield* Clock.currentTimeMillis) < T0 + 62 * M) {
      yield* TestClock.adjust(ms)
      ms = yield* Queue.take(slept)
      yield* turns.idle
    }
  }), { slept })
  expect(firedAt(file)).toEqual([1, 2, 3, 4, 5, 6, 62].map((one) => one * M))
  expect(rows<{ text: string }>(file, "select text from everchat_msg_read where kind = 'wake' order by i").map((one) => one.text)).toEqual([
    "[1] due 2026-11-16 09:01 Europe/Berlin: Chain 1.",
    "[2] due 2026-11-16 09:02 Europe/Berlin: Chain 2.",
    "[3] due 2026-11-16 09:03 Europe/Berlin: Chain 3.",
    "[4] due 2026-11-16 09:04 Europe/Berlin: Chain 4.",
    "[5] due 2026-11-16 09:05 Europe/Berlin: Chain 5.",
    "[6] due 2026-11-16 09:06 Europe/Berlin: Chain 6.",
    "[7] due 2026-11-16 09:07 Europe/Berlin, 55 min late: Chain 7."
  ])
  // The 7th's turn made the 8th, which waits.
  expect(rows(file, "select n, stopped is null as active, due from everchat_wake where n >= 7 order by n")).toEqual([
    { n: 7, active: 0, due: null },
    { n: 8, active: 1, due: T0 + 63 * M }
  ])
})

// The names
// ---------

test("the names: the three declarations, wake, wakes and unwake, each with a signature, pass the core's name rule beside the built-in declarations, local and hosted; entries gives them in the declarations' order", () => {
  expect(declarations.map((one) => [one.name, one.signature.startsWith(one.name === "wakes" ? "(): " : "(args: { ")])).toEqual([["wake", true], ["wakes", true], ["unwake", true]])
  expect(refusals([...DECLARATIONS, ...declarations])).toEqual([])
  expect(refusals([...HOSTED, ...declarations])).toEqual([])
  const made = entries({} as Store["Service"])
  expect(made.map((one) => one.declaration)).toEqual([...declarations])
  expect(mismatches(declarations, made)).toEqual([])
  expect(made.every((one) => one.approval === undefined)).toBe(true)
})

// Seeded inputs
// -------------

// A generator of numbers in [0, 1) from a seed (mulberry32).
const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test("seeded inputs: each when, zone and text makes a row whose first is what time.ts gives for it, or is refused with a FunctionError, as time.ts and the text's bounds say; never another failure", async () => {
  const seed = 20261118
  const random = seeded(seed)
  const pick = <A>(list: ReadonlyArray<A>): A => list[Math.floor(random() * list.length)]!
  const two = (n: number) => String(n).padStart(2, "0")
  const whens = () =>
    pick([
      () => `2026-${two(pick([10, 11, 12, 13]))}-${two(1 + Math.floor(random() * 31))}${pick(["T", " "])}${two(Math.floor(random() * 25))}:${two(Math.floor(random() * 60))}${pick(["", ":30"])}`,
      () => `${pick(["0", "15", "59", "*/2", "*", "0,30", "60"])} ${pick(["*", "9", "0-23", "25"])} ${pick(["*", "30", "1"])} ${pick(["*", "2", "13"])} ${pick(["*", "1-5", "MON"])}`,
      () => pick(["0 0 30 2 *", "0 0 29 2 *", "0 0 9 * * *", "soon", "", " ", "x".repeat(WHEN_MAX + 1), "2026-11-17T09:00Z", "2026-11-17T09:00\n", "\u202e0 9 * * *"])
    ])()
  const zones = [undefined, null, "Europe/Berlin", "america/new_york", "UTC", "Asia/Kathmandu", "Australia/Lord_Howe", "+01:00", "Mars/Base", "A".repeat(ZONE_MAX + 1), ""]
  const texts = ["", "a", "Line one.\nLine two.", "\u202e\u0000x", "\ud800", "t".repeat(WAKE_TEXT_MAX), "t".repeat(WAKE_TEXT_MAX + 1)]
  const option = DateTime.zoneMakeNamedUnsafe("Asia/Tokyo")
  const wrong: Array<string> = []
  let made = 0
  let refused = 0
  await turn([(_call, store, at) =>
    Effect.gen(function*() {
      // The entries run directly, with the program's own call as the
      // caller's: a call's row each would take two transactions more.
      const [wake, , unwake] = entries(store, { zone: option })
      const caller = { turn: at.turn, program: at.call, call: at.call }
      const call = (entry: Entry, args: unknown): Effect.Effect<Outcome> =>
        Effect.map(Effect.exit(entry!.run([args], caller)), (exit) => {
          if (Exit.isSuccess(exit)) return { ok: exit.value }
          const error = Cause.squash(exit.cause)
          return error instanceof FunctionError ? { error: error.message } : { other: String(error) }
        })
      for (let n = 0; n < 300; n++) {
        const args = { when: whens(), text: pick(texts), zone: pick(zones) }
        // What time.ts and the bounds give.
        const named = args.zone === undefined || args.zone === null ? Result.succeed(option) : zone(args.zone)
        const parsed = Result.isSuccess(named) ? parse(args.when, named.success) : undefined
        const first = parsed === undefined || Result.isFailure(parsed)
          ? undefined
          : parsed.success._tag === "Reminder"
          ? (reminderAt(parsed.success) >= T0 ? reminderAt(parsed.success) : undefined)
          : Result.getOrUndefined(nextSlot(parsed.success, T0))
        const expected = args.text.length >= 1 && args.text.length <= WAKE_TEXT_MAX ? first : undefined
        const before = (yield* store.wakes()).length
        const got = yield* call(wake!, args)
        const after = yield* store.wakes()
        const shown = JSON.stringify(args).slice(0, 300)
        if ("other" in got) wrong.push(`${shown}: ${got.other}`)
        else if ("error" in got) {
          refused++
          if (expected !== undefined) wrong.push(`${shown}: refused, time.ts gives ${expected}: ${got.error}`)
          if (after.length !== before) wrong.push(`${shown}: refused, and a row written`)
        } else {
          made++
          const result = got.ok as { readonly id: number; readonly next: string }
          const row = after.find((one) => one.id === result.id)
          if (expected === undefined || row === undefined || row.first !== expected || result.next !== wallClock(expected, row.zone)) {
            wrong.push(`${shown}: made ${JSON.stringify(result)} with first ${row?.first}, time.ts gives ${expected}`)
          }
          // A place for the next make.
          const stopped = yield* call(unwake!, { id: result.id })
          if (!("ok" in stopped)) wrong.push(`${shown}: unwake ${JSON.stringify(stopped)}`)
        }
      }
    })])
  expect({ seed, wrong }).toEqual({ seed, wrong: [] })
  // The inputs reach both outcomes.
  expect({ seed, made: made > 10, refused: refused > 10 }).toEqual({ seed, made: true, refused: true })
})
