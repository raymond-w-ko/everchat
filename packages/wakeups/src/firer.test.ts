// Tests of the wake-ups' firer (firer.ts): a fire at its slot; a start
// after missed fires; the slots over the changes of daylight saving; a
// clock that moves back; a waiting fire that grows while its turn runs; off
// and on; a fire past the budget asked for again; a failed round; the
// sleep; and the settle: the count of each end, the settle before a fire,
// the stop at two failures with its note, the settle while off and after a
// ceiling stop. Each case runs on a file's store, the tests' fake wire and
// the turn loop with this package's source, on a `TestClock` set before the
// layers are built, with the firer forked by its layer. A restart is a new
// launch on the same file. The firer's rounds are gated: its clock tells
// each sleep (the end of a round), and the case moves the `TestClock` only
// while it sleeps. Its listener is held back (the loop's events wait behind
// a gate) but in the cases that let it go: then each `end` gives one more
// round, with no move of the clock. A turn is held by its program, which
// waits for the case.

import { expect, test } from "bun:test"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Latch, Layer, Logger, PubSub, Queue, Result } from "effect"
import { TestClock } from "effect/testing"
import * as path from "node:path"
import { compactor, fakeWire, newFile, options, reply, rows, wireError } from "@everchat/local/testing"
import { limitLayer } from "@everchat/local/limitfile"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { storeLayer } from "@everchat/sqlite/bun"
import { Ask, AskDelay } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { row as diagnosticRow } from "@everchat/core/diagnostics"
import { head } from "@everchat/core/head"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { type NewDiagnostic, type NewWake, Store, StoreError, WAKE_FAILURES, type WakeEnd, type WakePend } from "@everchat/core/store"
import { CEILING, Source, type TurnEvent, Turns } from "@everchat/core/turn"
import { endOf, firer, SLEEP, stoppedText } from "./firer.ts"
import { DAY, HOUR, source, WAKE_CEILING } from "./source.ts"
import { parse, reminderAt, zone } from "./time.ts"

const M = 60_000
// 09:00 in Berlin, a Monday.
const T0 = Date.parse("2026-11-16T08:00:00Z")
const TEXT = "Read my mail and give me the plan."
const DAILY: NewWake = { text: TEXT, cron: "0 9 * * *", zone: "Europe/Berlin", first: T0 }
const HOURLY: NewWake = { text: TEXT, cron: "0 * * * *", zone: "Europe/Berlin", first: T0 }
const reminder = (k: number, at: number, zoneName = "Europe/Berlin"): NewWake => ({ text: `Reminder ${k}.`, at, zone: zoneName, first: at })

// What a case sees of the firer: each sleep's length (`slept`, a queue that
// a case takes from to wait for a round's end), the calls of `Turns.ready`
// by the firer, the `pendWake` calls, the settles (`settleWake` that
// committed its statement: the row, the turn, the end and the row's
// `failed` after it), the writes of settles and fires in their order, the
// fiber of each `unsettledWakes` (the settle's read), the firer's fiber
// (the first of those), `stray` (done when a settle's read runs in another
// fiber), the diagnostics, as rows of the `log` table, and the gate of its
// listener (`listen`: open, the loop's events reach it).
interface Watch {
  readonly slept: Queue.Queue<number>
  readies: number
  readonly pends: Array<readonly [number, WakePend]>
  readonly settles: Array<readonly [number, number, WakeEnd, number]>
  readonly order: Array<string>
  readonly fibers: Array<number>
  readonly fiber: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>
  readonly stray: Deferred.Deferred<void>
  readonly logs: Array<NewDiagnostic>
  readonly listen: Latch.Latch
  last: number
}

const watch = (listen = false): Watch => ({
  slept: Effect.runSync(Queue.unbounded<number>()),
  readies: 0,
  pends: [],
  settles: [],
  order: [],
  fibers: [],
  fiber: Deferred.makeUnsafe(),
  stray: Deferred.makeUnsafe(),
  logs: [],
  listen: Latch.makeUnsafe(listen),
  last: SLEEP
})

// The fiber of the settle's read, and the firer's fiber, kept at its first
// round's first step; a read in another fiber is `stray`.
const keep = (w: Watch) =>
  Effect.flatMap(Effect.fiber, (fiber) =>
    Effect.gen(function*() {
      w.fibers.push(fiber.id)
      if (fiber.id !== w.fibers[0]) yield* Deferred.succeed(w.stray, undefined)
      yield* Deferred.succeed(w.fiber, fiber)
    }))

// A store over the real one: `over` gives the members that it changes.
const over = (change: (real: Store["Service"]) => Partial<Store["Service"]>): Layer.Layer<Store, never, Store> =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({ ...real, ...change(real) })
    })
  )

// The store that every part reads, with the firer's members watched: the
// fiber of each settle's read, the `pendWake` calls, and the settles and
// the fires as they are written.
const watched = (w: Watch) =>
  over((real) => ({
    unsettledWakes: () => Effect.andThen(keep(w), real.unsettledWakes()),
    pendWake: (id, pend) => Effect.andThen(Effect.sync(() => w.pends.push([id, pend])), real.pendWake(id, pend)),
    settleWake: (id, turn, end) =>
      Effect.tap(real.settleWake(id, turn, end), () =>
        Effect.map(real.wakes(), (all) => {
          w.settles.push([id, turn, end, all.find((one) => one.id === id)!.failed])
          w.order.push(`settle ${id}`)
        })),
    fireWake: (id, turn, read) => Effect.tap(real.fireWake(id, turn, read), () => Effect.sync(() => w.order.push(`fire ${id}`)))
  }))

// The firer's clock: the `TestClock`, with each sleep told before it starts.
const clockOf = (w: Watch): Layer.Layer<never> =>
  Layer.effect(
    Clock.Clock,
    Effect.clockWith((real) =>
      Effect.succeed(Object.assign(Object.create(real) as Clock.Clock, {
        sleep: (duration: Duration.Duration) =>
          Effect.gen(function*() {
            const ms = Duration.toMillis(duration)
            yield* Queue.offer(w.slept, ms)
            yield* real.sleep(duration)
          })
      }))
    )
  )

// The firer's turn loop: the real one, with each `ready` counted, and its
// subscription behind the gate `w.listen`: each event of the loop waits
// for the gate before the firer's listener gets it.
const turnsOf = (w: Watch): Layer.Layer<Turns, never, Turns> =>
  Layer.effect(
    Turns,
    Effect.gen(function*() {
      const real = yield* Turns
      const subscribe = Effect.gen(function*() {
        const events = yield* real.subscribe
        const relay = yield* PubSub.unbounded<TurnEvent>()
        const given = yield* PubSub.subscribe(relay)
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(PubSub.take(events), (event) => Effect.andThen(w.listen.await, PubSub.publish(relay, event)))))
        return given
      })
      return Turns.of({ ...real, ready: Effect.andThen(Effect.sync(() => w.readies++), real.ready), subscribe })
    })
  )

// A source that never offers: the case reads only what the firer writes.
const none: Layer.Layer<Source> = Layer.succeed(Source, Source.of({ next: Effect.succeed(null) }))

// One launch: the store over `file`, the memory, the ask service over the
// fake wire, a sandbox (`given.run`; else one that runs no program) and the
// turn loop, with this package's source (or `given.source`), and the firer
// (but with `given.firer` false), on a TestClock set to `given.at` before
// the layers are built. `given.store` puts a store over the real one.
// `given.before` is built after the turn loop and before the firer.
const launch = <A, E>(
  file: string,
  w: Watch,
  effect: Effect.Effect<A, E, Turns | Memory | Store | TestClock.TestClock>,
  given: {
    readonly at: number
    readonly source?: Layer.Layer<Source, never, Store>
    readonly store?: Layer.Layer<Store, never, Store>
    readonly firer?: boolean
    readonly wire?: ReturnType<typeof fakeWire>
    readonly run?: Run
    readonly before?: Layer.Layer<never, never, Turns | Store>
  }
) => {
  const real = storeLayer(file, options())
  const store = watched(w).pipe(Layer.provide(given.store === undefined ? real : given.store.pipe(Layer.provide(real))))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, (given.wire ?? replies()).layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: given.run ?? (() => Effect.die("no program was expected")) }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ head: head(DECLARATIONS) }).pipe(
    Layer.provide(given.source ?? source),
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, sandbox, limit))
  )
  const parts = Layer.mergeAll(clockOf(w), turnsOf(w), given.before ?? Layer.empty)
  const all = given.firer === false ? turns : firer.pipe(Layer.provide(parts), Layer.provideMerge(turns))
  const capture = Logger.layer([Logger.make((line) => void w.logs.push(diagnosticRow.log(line)))])
  return Effect.runPromise(
    Effect.andThen(TestClock.setTime(given.at), effect.pipe(Effect.provide(all))).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(AskDelay, () => Effect.succeed(0)),
      Effect.provide(capture)
    )
  )
}

// The end of the firer's next round: the length of the sleep that follows
// it; "ended" when its fiber ended instead.
const rested = (w: Watch): Effect.Effect<number | "ended"> =>
  Effect.raceFirst(
    Effect.tap(Queue.take(w.slept), (ms) => Effect.sync(() => (w.last = ms))),
    Effect.as(Effect.flatMap(Deferred.await(w.fiber), Fiber.await), "ended" as const)
  )

// The end of the round that the listener's wake runs; "stray" when a
// settle's read ran in a fiber that is not the firer's first. A wake that
// never comes has no end here: the case fails by the test's own timeout.
const woke = (w: Watch): Effect.Effect<number | "ended" | "stray"> => Effect.raceFirst(rested(w), Effect.as(Deferred.await(w.stray), "stray" as const))

// The clock moved by `ms` while the firer sleeps, then the end of the round
// that it wakes for.
const after = (w: Watch, ms: number) => Effect.andThen(TestClock.adjust(ms), rested(w))

// The clock moved round by round, each move the sleep that the last round
// told, until it is at or past `to` (from T0): each round between runs at
// its time.
const walk = (w: Watch, to: number) =>
  Effect.gen(function*() {
    while ((yield* clock) < to) {
      if ((yield* after(w, w.last)) === "ended") return yield* Effect.die(new Error("the firer ended"))
    }
  })

const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

// A model that says "Reply <n>." to each request.
const replies = () => fakeWire((asked, n) => says(asked, `Reply ${n}.`))

type Run = (program: string, at?: { readonly turn: number; readonly call: number }) => Effect.Effect<{ output: string; failed: boolean }>

const runs = (asked: Request, id: string, program: string, usage?: Reply["usage"]): Reply =>
  reply(asked, { text: "", output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }], calls: [{ id, name: "run", input: program }], ...(usage === undefined ? {} : { usage }) })

// What the model does at its n-th request: `ok` says "Reply <n>." (a turn
// done); `fail` is an error of the wire that fails the turn; `hold` runs the
// program "hold", which waits for the case (`holding`); `ceiling` runs a
// program that ends at once, with the tokens of a wake turn's ceiling in
// its usage, so the turn stops with `CEILING`; `hold ceiling` is `hold`
// with that usage. Past the list: `ok`.
type Step = "ok" | "fail" | "hold" | "ceiling" | "hold ceiling"
const FULL = { input: WAKE_CEILING.tokens, cacheRead: 0, cacheWrite: 0, output: 0, searches: 0 }
const script = (...steps: ReadonlyArray<Step>) =>
  fakeWire((asked, n) => {
    const step = steps[n - 1] ?? "ok"
    return step === "fail"
      ? wireError("input")
      : step === "hold"
      ? runs(asked, `hold${n}`, "hold")
      : step === "hold ceiling"
      ? runs(asked, `hold${n}`, "hold", FULL)
      : step === "ceiling"
      ? runs(asked, `go${n}`, "go", FULL)
      : says(asked, `Reply ${n}.`)
  })

// A sandbox whose program "hold" tells `started`, then waits for `open`;
// every other program ends at once.
const holding = () => {
  const started = Deferred.makeUnsafe<void>()
  const open = Deferred.makeUnsafe<void>()
  const run: Run = (program) =>
    program === "hold"
      ? Effect.andThen(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(open)), Effect.succeed({ output: "held", failed: false }))
      : Effect.succeed({ output: "ran", failed: false })
  return { started, open, run }
}

// The notes of the wake-ups' stops, in order.
const stops = (file: string) => texts(file, "note").filter((one) => one.startsWith("Wake-up "))
// The turns with their status and why.
const ends = (file: string) => rows(file, "select n as id, status, why from everchat_turn order by n")
// The clock, as the time from T0.
const clock = Effect.map(Clock.currentTimeMillis, (now) => now - T0)

// A row with one failed end counted, made in a launch with no firer: the
// routine `HOURLY` at T0, its 09:00 fire, whose turn 1 fails, and its
// settle. Its next slot is 10:00.
const failedOnce = (file: string) =>
  launch(file, watch(), Effect.gen(function*() {
    const store = yield* Store
    made(yield* store.makeWake(HOURLY, 20))
    yield* store.pendWake(1, { pending: T0, missed: 0, due: T0 + HOUR })
    yield* (yield* Turns).ready
    yield* (yield* Turns).idle
    yield* store.settleWake(1, 1, "failed")
  }), { at: T0 + 10 * M, firer: false, wire: script("fail") })

const made = (one: { readonly _tag: string }) => {
  if (one._tag !== "made") throw new Error(`not made: ${one._tag}`)
}

// The rows made before the case, in a launch with no firer, at `at`.
const make = (file: string, at: number, wakes: ReadonlyArray<NewWake>, off = false) =>
  launch(file, watch(), Effect.gen(function*() {
    const store = yield* Store
    for (const one of wakes) made(yield* store.makeWake(one, 20))
    if (off) yield* store.setWakeups(false)
  }), { at, firer: false })

// The log as "<i> <kind> <turn>" (a turn of none: -).
const messages = (file: string) =>
  rows<{ i: number; kind: string; turn: number | null }>(file, "select i, kind, turn from everchat_msg_read order by i").map((one) => `${one.i} ${one.kind} ${one.turn ?? "-"}`)
// The texts of the messages of a kind, in order.
const texts = (file: string, kind: string) => rows<{ text: string }>(file, `select text from everchat_msg_read where kind = '${kind}' order by i`).map((one) => one.text)
// When each wake message was written, from T0, in order.
const firedAt = (file: string) =>
  rows<{ created: number }>(file, "select m.created from everchat_msg m join everchat_kind k on k.id = m.kind where k.name = 'wake' order by m.i").map((one) => one.created - T0)
const turnRows = (file: string) => rows(file, "select n as id, status, first_msg, steps, tokens from everchat_turn order by n")
const wakeRow = (file: string, n: number) =>
  rows(file, `select due, slot, pending, missed, fired, last_turn, settled, failed, stopped is not null as stopped, why from everchat_wake where chat = 1 and n = ${n}`)[0]
// The diagnostics of the wake-ups: each line's level and text.
const diagnostics = (w: Watch) => w.logs.filter((one) => one.source === "wakeups").map((one) => `${one.level} ${one.text}`)

// A fire at its slot
// ------------------

test("a fire at its slot: before the slot nothing; at it the wake message in the log and its turn, with the ceiling", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [DAILY])
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    // The first round, at the build: the slot is 30 s away. Each sleep is
    // asserted before the clock moves: a longer one would not end.
    const first = yield* rested(w)
    expect(first).toBe(30_000)
    const before = { log: messages(file), pends: [...w.pends], readies: w.readies }
    const second = yield* after(w, 30_000)
    yield* (yield* Turns).idle
    return { first, before, second }
  }), { at: T0 - 30_000 })
  expect(got).toEqual({ first: 30_000, before: { log: [], pends: [], readies: 1 }, second: SLEEP })
  expect(w.pends).toEqual([[1, { pending: T0, missed: 0, due: T0 + DAY }]])
  expect(messages(file)).toEqual(["0 wake -", "1 asst 1"])
  expect(texts(file, "wake")).toEqual(["[1] due 2026-11-16 09:00 Europe/Berlin: " + TEXT])
  expect(firedAt(file)).toEqual([0])
  expect(turnRows(file)).toEqual([{ id: 1, status: "done", first_msg: 0, steps: 20, tokens: 2_000_000 }])
  expect(wakeRow(file, 1)).toEqual({ due: T0 + DAY, slot: T0, pending: null, missed: 0, fired: 1, last_turn: 1, settled: 0, failed: 0, stopped: 0, why: null })
  expect(diagnostics(w)).toEqual([])
})

// A start after missed fires
// --------------------------

test("a start after missed fires: the layer built late gives a routine one waiting fire with its missed count and one turn, and a reminder whose time passed one late fire", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [DAILY, reminder(2, T0 + HOUR)])
  const w = watch()
  // 11:00 in Berlin, three days and two hours after the routine's first slot.
  const late = T0 + 3 * DAY + 2 * HOUR
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    yield* (yield* Turns).idle
    // The next round: both ends counted, and nothing new.
    const second = yield* after(w, SLEEP)
    yield* (yield* Turns).idle
    return [first, second]
  }), { at: late })
  expect(got).toEqual([SLEEP, SLEEP])
  expect(w.pends).toEqual([
    [1, { pending: T0 + 3 * DAY, missed: 3, due: T0 + 4 * DAY }],
    [2, { pending: T0 + HOUR, missed: 0, due: null }]
  ])
  expect(w.readies).toBe(2)
  // The oldest waiting fire first: the reminder, then the routine.
  expect(messages(file)).toEqual(["0 wake -", "1 asst 1", "2 wake -", "3 asst 2"])
  expect(texts(file, "wake")).toEqual([
    "[2] due 2026-11-16 10:00 Europe/Berlin, 3 d late: Reminder 2.",
    "[1] due 2026-11-19 09:00 Europe/Berlin, 2 h late, 3 missed: " + TEXT
  ])
  expect(w.settles).toEqual([[1, 2, "done", 0], [2, 1, "done", 0]])
  expect(wakeRow(file, 1)).toEqual({ due: T0 + 4 * DAY, slot: T0 + 3 * DAY, pending: null, missed: 0, fired: 1, last_turn: 2, settled: 1, failed: 0, stopped: 0, why: null })
  expect(wakeRow(file, 2)).toEqual({ due: null, slot: T0 + HOUR, pending: null, missed: 0, fired: 1, last_turn: 1, settled: 1, failed: 0, stopped: 1, why: "fired" })
})

// Daylight saving
// ---------------

// The rows of a zone: a routine at 02:30 and one at 09:00, a reminder in
// the gap of the spring's change and one in the overlap of the autumn's.
const seasons = [
  {
    zone: "America/New_York",
    // 2026-03-01 00:00 EST.
    made: "2026-03-01T05:00:00Z",
    first: ["2026-03-01T07:30:00Z", "2026-03-01T14:00:00Z"],
    gap: { wall: "2026-03-08T02:30", at: "2026-03-08T07:30:00Z" }, // 03:30 EDT
    overlap: { wall: "2026-11-01T01:30", at: "2026-11-01T05:30:00Z" }, // 01:30 EDT, the earlier
    // Each launch at 04:00 on the zone's wall clock, after both 02:30s of a
    // repeated hour, before 09:00: the pends of that round, by id (the
    // firer writes them in the order of `due`).
    launches: [
      {
        at: "2026-03-08T08:00:00Z", // 04:00 EDT, the day the clock skips 02:00 to 03:00
        pends: [
          [1, "2026-03-08T07:30:00Z", 7, "2026-03-09T06:30:00Z"], // 02:30 skipped: 03:30 EDT
          [2, "2026-03-07T14:00:00Z", 6, "2026-03-08T13:00:00Z"], // 09:00 EST, then 09:00 EDT
          [3, "2026-03-08T07:30:00Z", 0, null]
        ]
      },
      {
        at: "2026-03-29T08:00:00Z",
        pends: [
          [1, "2026-03-29T06:30:00Z", 20, "2026-03-30T06:30:00Z"],
          [2, "2026-03-28T13:00:00Z", 20, "2026-03-29T13:00:00Z"]
        ]
      },
      {
        at: "2026-10-25T08:00:00Z",
        pends: [
          [1, "2026-10-25T06:30:00Z", 209, "2026-10-26T06:30:00Z"],
          [2, "2026-10-24T13:00:00Z", 209, "2026-10-25T13:00:00Z"]
        ]
      },
      {
        at: "2026-11-01T09:00:00Z", // 04:00 EST, the day the clock repeats 01:00 to 02:00
        pends: [
          [1, "2026-11-01T07:30:00Z", 6, "2026-11-02T07:30:00Z"], // 02:30 EST
          [2, "2026-10-31T13:00:00Z", 6, "2026-11-01T14:00:00Z"], // 09:00 EDT, then 09:00 EST
          [4, "2026-11-01T05:30:00Z", 0, null]
        ]
      }
    ]
  },
  {
    zone: "Europe/Berlin",
    // 2026-03-01 00:00 CET.
    made: "2026-02-28T23:00:00Z",
    first: ["2026-03-01T01:30:00Z", "2026-03-01T08:00:00Z"],
    gap: { wall: "2026-03-29T02:30", at: "2026-03-29T01:30:00Z" }, // 03:30 CEST
    overlap: { wall: "2026-10-25T02:30", at: "2026-10-25T00:30:00Z" }, // 02:30 CEST, the earlier
    launches: [
      {
        at: "2026-03-08T03:00:00Z",
        pends: [
          [1, "2026-03-08T01:30:00Z", 7, "2026-03-09T01:30:00Z"],
          [2, "2026-03-07T08:00:00Z", 6, "2026-03-08T08:00:00Z"]
        ]
      },
      {
        at: "2026-03-29T02:00:00Z", // 04:00 CEST, the day the clock skips 02:00 to 03:00
        pends: [
          [1, "2026-03-29T01:30:00Z", 20, "2026-03-30T00:30:00Z"], // 02:30 skipped: 03:30 CEST
          [2, "2026-03-28T08:00:00Z", 20, "2026-03-29T07:00:00Z"], // 09:00 CET, then 09:00 CEST
          [3, "2026-03-29T01:30:00Z", 0, null]
        ]
      },
      {
        at: "2026-10-25T03:00:00Z", // 04:00 CET, the day the clock repeats 02:00 to 03:00
        pends: [
          // 02:30 once, at the earlier: the next is the 26th, not 02:30 CET of the 25th.
          [1, "2026-10-25T00:30:00Z", 209, "2026-10-26T01:30:00Z"],
          [2, "2026-10-24T07:00:00Z", 209, "2026-10-25T08:00:00Z"], // 09:00 CEST, then 09:00 CET
          [4, "2026-10-25T00:30:00Z", 0, null]
        ]
      },
      {
        at: "2026-11-01T03:00:00Z",
        pends: [
          [1, "2026-11-01T01:30:00Z", 6, "2026-11-02T01:30:00Z"],
          [2, "2026-10-31T08:00:00Z", 6, "2026-11-01T08:00:00Z"]
        ]
      }
    ]
  }
] as const

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().replace(".000Z", "Z"))

for (const season of seasons) {
  test(`daylight saving in ${season.zone}: the pending and the due that the firer writes for a routine at 02:30 and at 09:00, a reminder in the gap and one in the overlap, over 2026-03-08, 2026-03-29, 2026-10-25 and 2026-11-01`, async () => {
    const file = newFile()
    const named = zone(season.zone)
    if (Result.isFailure(named)) throw named.failure
    const at = (wall: string) => {
      const when = parse(wall, named.success)
      if (Result.isFailure(when) || when.success._tag !== "Reminder") throw new Error(`no reminder ${wall}`)
      return reminderAt(when.success)
    }
    // The reminders' times, as the make computes them: the gap's 02:30 is
    // 03:30; the overlap's is the earlier.
    expect([iso(at(season.gap.wall)), iso(at(season.overlap.wall))]).toEqual([season.gap.at, season.overlap.at])
    await make(file, Date.parse(season.made), [
      { text: "At 02:30.", cron: "30 2 * * *", zone: season.zone, first: Date.parse(season.first[0]) },
      { text: "At 09:00.", cron: "0 9 * * *", zone: season.zone, first: Date.parse(season.first[1]) },
      reminder(3, at(season.gap.wall), season.zone),
      reminder(4, at(season.overlap.wall), season.zone)
    ])
    for (const one of season.launches) {
      const w = watch()
      const slept = await launch(file, w, rested(w), { at: Date.parse(one.at), source: none })
      expect({ at: one.at, slept, pends: [...w.pends].sort((a, b) => a[0] - b[0]).map(([id, pend]) => [id, iso(pend.pending), pend.missed, iso(pend.due)]) }).toEqual({
        at: one.at,
        slept: SLEEP,
        pends: one.pends.map((pend) => [...pend])
      })
      expect(diagnostics(w)).toEqual([])
    }
  })
}

// A clock that moves back
// -----------------------

test("a clock that moves back fires no slot twice: the slots are walked from the row's due, and a slot fires only after the clock passes it", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY])
  // 11:10 in Berlin: the 09:00 and 10:00 slots missed, 11:00 fires.
  const first = watch()
  await launch(file, first, Effect.gen(function*() {
    yield* rested(first)
    yield* (yield* Turns).idle
  }), { at: T0 + 2 * HOUR + 10 * M })
  expect(first.pends).toEqual([[1, { pending: T0 + 2 * HOUR, missed: 2, due: T0 + 3 * HOUR }]])
  expect(texts(file, "wake")).toEqual(["[1] due 2026-11-16 11:00 Europe/Berlin, 10 min late, 2 missed: " + TEXT])
  // The clock back at 09:30, before the slot that fired: two rounds, the
  // first of which counts the end of turn 1 (so only the clock holds the
  // next fire back), and nothing more.
  const back = watch()
  const rounds = await launch(file, back, Effect.gen(function*() {
    const one = yield* rested(back)
    const two = yield* after(back, SLEEP)
    return [one, two]
  }), { at: T0 + 30 * M })
  expect({ rounds, pends: back.pends, readies: back.readies, settles: back.settles }).toEqual({ rounds: [SLEEP, SLEEP], pends: [], readies: 2, settles: [[1, 1, "done", 0]] })
  expect(messages(file)).toEqual(["0 wake -", "1 asst 1"])
  expect(wakeRow(file, 1)).toEqual({ due: T0 + 3 * HOUR, slot: T0 + 2 * HOUR, pending: null, missed: 0, fired: 1, last_turn: 1, settled: 1, failed: 0, stopped: 0, why: null })
  // The clock past the next slot, 12:00: its one fire.
  const on = watch()
  await launch(file, on, Effect.gen(function*() {
    yield* rested(on)
    yield* (yield* Turns).idle
  }), { at: T0 + 3 * HOUR + 5 * M })
  expect(on.pends).toEqual([[1, { pending: T0 + 3 * HOUR, missed: 0, due: T0 + 4 * HOUR }]])
  expect(texts(file, "wake")).toEqual([
    "[1] due 2026-11-16 11:00 Europe/Berlin, 10 min late, 2 missed: " + TEXT,
    "[1] due 2026-11-16 12:00 Europe/Berlin, 5 min late: " + TEXT
  ])
})

// A waiting fire that is not taken
// --------------------------------

test("a waiting fire that is not taken grows missed and stays one fire: while its row's turn has not ended, the row is not settled and not offered, and the slots that come wait as one fire with their count; after the end, one fire", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY])
  const w = watch()
  const sandbox = holding()
  const got = await launch(file, w, Effect.gen(function*() {
    // 09:10: the 09:00 fire, whose turn runs its program and holds.
    yield* rested(w)
    yield* Deferred.await(sandbox.started)
    // 10:10 and 12:10: the slots wait as one fire; the turn has not ended.
    yield* walk(w, HOUR + 10 * M)
    const one = wakeRow(file, 1)
    yield* walk(w, 3 * HOUR + 10 * M)
    const three = { row: wakeRow(file, 1), log: messages(file), turns: ends(file), settles: [...w.settles] }
    // The turn ends; the next round counts it, and offers the one fire.
    yield* Deferred.succeed(sandbox.open, undefined)
    yield* (yield* Turns).idle
    yield* after(w, SLEEP)
    yield* (yield* Turns).idle
    return { one, three }
  }), { at: T0 + 10 * M, run: sandbox.run, wire: script("hold") })
  expect(got).toEqual({
    one: { due: T0 + 2 * HOUR, slot: T0, pending: T0 + HOUR, missed: 0, fired: 1, last_turn: 1, settled: 0, failed: 0, stopped: 0, why: null },
    three: {
      row: { due: T0 + 4 * HOUR, slot: T0, pending: T0 + 3 * HOUR, missed: 2, fired: 1, last_turn: 1, settled: 0, failed: 0, stopped: 0, why: null },
      log: ["0 wake -"],
      turns: [{ id: 1, status: "running", why: null }],
      settles: []
    }
  })
  expect(w.pends).toEqual([
    [1, { pending: T0, missed: 0, due: T0 + HOUR }],
    [1, { pending: T0 + HOUR, missed: 0, due: T0 + 2 * HOUR }],
    [1, { pending: T0 + 2 * HOUR, missed: 0, due: T0 + 3 * HOUR }],
    [1, { pending: T0 + 3 * HOUR, missed: 0, due: T0 + 4 * HOUR }]
  ])
  expect(w.settles).toEqual([[1, 1, "done", 0]])
  expect(w.order).toEqual(["fire 1", "settle 1", "fire 1"])
  expect(texts(file, "wake")).toEqual([
    "[1] due 2026-11-16 09:00 Europe/Berlin, 10 min late: " + TEXT,
    "[1] due 2026-11-16 12:00 Europe/Berlin, 11 min late, 2 missed: " + TEXT
  ])
  expect(wakeRow(file, 1)).toEqual({ due: T0 + 4 * HOUR, slot: T0 + 3 * HOUR, pending: null, missed: 0, fired: 2, last_turn: 2, settled: 0, failed: 0, stopped: 0, why: null })
})

// Off and on
// ----------

test("off: the firer pends nothing and still calls ready; after on, the next round, within 60 s, gives each row whose slots passed one waiting fire with its missed count, and a reminder whose time passed fires late", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY, reminder(2, T0 + 30 * M)], true)
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    const off = { pends: [...w.pends], readies: w.readies, rows: [wakeRow(file, 1), wakeRow(file, 2)] }
    yield* (yield* Store).setWakeups(true)
    const second = yield* after(w, SLEEP)
    yield* (yield* Turns).idle
    return { first, off, second }
  }), { at: T0 + 2 * HOUR + 10 * M })
  expect(got).toEqual({
    first: SLEEP,
    off: {
      pends: [],
      readies: 1,
      rows: [
        { due: T0, slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: 0, why: null },
        { due: T0 + 30 * M, slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: 0, why: null }
      ]
    },
    second: SLEEP
  })
  expect(w.pends).toEqual([
    [1, { pending: T0 + 2 * HOUR, missed: 2, due: T0 + 3 * HOUR }],
    [2, { pending: T0 + 30 * M, missed: 0, due: null }]
  ])
  expect(w.readies).toBe(2)
  expect(texts(file, "wake")).toEqual([
    "[2] due 2026-11-16 09:30 Europe/Berlin, 1 h late: Reminder 2.",
    "[1] due 2026-11-16 11:00 Europe/Berlin, 11 min late, 2 missed: " + TEXT
  ])
})

test("off, with a store whose dueWakes ignores the switch: the firer still pends nothing, and calls ready", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY, reminder(2, T0 + 30 * M)], true)
  const blind = over((real) => ({
    dueWakes: (now) => Effect.map(real.wakes({ active: true }), (all) => all.filter((one) => one.due !== null && one.due <= now))
  }))
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    const second = yield* after(w, SLEEP)
    return [first, second]
  }), { at: T0 + 2 * HOUR + 10 * M, store: blind })
  expect({ got, pends: w.pends, readies: w.readies, log: messages(file) }).toEqual({ got: [SLEEP, SLEEP], pends: [], readies: 2, log: [] })
})

// Asked again
// -----------

test("asked again (M8): a fire past the budget is offered at the first round with room, with no new due row", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, Array.from({ length: 7 }, (_, k) => reminder(k + 1, T0 + k * M)))
  // 09:10: seven fires wait; six fire, and the budget holds the seventh.
  const full = watch()
  await launch(file, full, Effect.gen(function*() {
    yield* rested(full)
    yield* (yield* Turns).idle
  }), { at: T0 + 10 * M })
  expect(full.pends.length).toBe(7)
  expect(firedAt(file)).toEqual([10, 10, 10, 10, 10, 10].map((one) => one * M))
  // A start at 10:09:30: the six fires of 09:10 still fill the hour; the
  // round 60 s later has room.
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    const held = messages(file).length
    const second = yield* after(w, SLEEP)
    yield* (yield* Turns).idle
    return { first, held, second }
  }), { at: T0 + 69 * M + 30_000 })
  expect(got).toEqual({ first: SLEEP, held: 12, second: SLEEP })
  expect({ pends: w.pends, readies: w.readies }).toEqual({ pends: [], readies: 2 })
  expect(firedAt(file)).toEqual([...[10, 10, 10, 10, 10, 10].map((one) => one * M), 70 * M + 30_000])
  expect(texts(file, "wake")[6]).toBe("[7] due 2026-11-16 09:06 Europe/Berlin, 1 h late: Reminder 7.")
})

// A failed round
// --------------

test("a failed round (M15): a member that fails one time is one diagnostic of the source wakeups, and the next round runs and fires", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY])
  let failures = 1
  const failing = over((real) => ({
    dueWakes: (now) =>
      Effect.suspend(() => failures-- > 0 ? Effect.fail(new StoreError({ op: "dueWakes", cause: new Error("the disk is gone") })) : real.dueWakes(now))
  }))
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    // The fiber sleeps: it did not end.
    expect(first).toBe(SLEEP)
    const failed = { log: messages(file), readies: w.readies, diagnostics: diagnostics(w).length }
    const second = yield* after(w, SLEEP)
    yield* (yield* Turns).idle
    return { first, failed, second }
  }), { at: T0 + 10 * M, store: failing })
  expect(got).toEqual({ first: SLEEP, failed: { log: [], readies: 0, diagnostics: 1 }, second: SLEEP })
  const lines = diagnostics(w)
  expect(lines.length).toBe(1)
  expect(lines[0]!.split("\n")[0]).toBe("error a round of the wake-ups failed: the next round tries again")
  expect(lines[0]).toContain("the disk is gone")
  expect(w.pends).toEqual([[1, { pending: T0, missed: 0, due: T0 + HOUR }]])
  expect(texts(file, "wake")).toEqual(["[1] due 2026-11-16 09:00 Europe/Berlin, 11 min late: " + TEXT])
})

test("a failed round (M15): a row whose cron or zone does not parse is its diagnostic, one time in a launch, and the round's other row is written and fires", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [
    { ...HOURLY, cron: "61 * * * *" },
    HOURLY,
    { ...HOURLY, zone: "Mars/Olympus" }
  ])
  const w = watch()
  await launch(file, w, Effect.gen(function*() {
    yield* rested(w)
    yield* (yield* Turns).idle
    // The next round reads the rows again: no second diagnostic.
    yield* after(w, SLEEP)
  }), { at: T0 + 10 * M })
  expect(diagnostics(w)).toEqual([
    `error wake-up 1 was not pended: "61 * * * *" is no routine: Expected a value between 0 and 59. A routine is the 5 fields of cron (minute, hour, day of the month, month, day of the week), such as 15 9 * * 1-5.`,
    `error wake-up 3 was not pended: "Mars/Olympus" is not a time zone: give an IANA name, such as Europe/Berlin.`
  ])
  expect(w.pends).toEqual([[2, { pending: T0, missed: 0, due: T0 + HOUR }]])
  expect(w.readies).toBe(2)
  expect(texts(file, "wake")).toEqual(["[2] due 2026-11-16 09:00 Europe/Berlin, 10 min late: " + TEXT])
})

test("a failed round (M15): a row whose fault was told already is passed over, and a row after it that comes due in a later round of the launch is pended in that round", async () => {
  const file = newFile()
  // Row 1: a zone that does not parse, due. Row 2: a reminder at 09:10:30,
  // after the first round at 09:10.
  await make(file, T0 - HOUR, [{ ...HOURLY, zone: "Mars/Olympus" }, reminder(2, T0 + 10 * M + 30_000)])
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    const pends = [...w.pends]
    const second = yield* after(w, first as number)
    yield* (yield* Turns).idle
    return { first, pends, second, at: yield* clock }
  }), { at: T0 + 10 * M })
  // The second round, at 09:10:30, has row 1 told, then row 2 due.
  expect(got).toEqual({ first: 30_000, pends: [], second: SLEEP, at: 10 * M + 30_000 })
  expect(w.pends).toEqual([[2, { pending: T0 + 10 * M + 30_000, missed: 0, due: null }]])
  expect(diagnostics(w)).toEqual([`error wake-up 1 was not pended: "Mars/Olympus" is not a time zone: give an IANA name, such as Europe/Berlin.`])
  expect(firedAt(file)).toEqual([10 * M + 30_000])
  expect(texts(file, "wake")).toEqual(["[2] due 2026-11-16 09:10 Europe/Berlin: Reminder 2."])
})

test("a routine with no next slot (0 0 30 2 *, a row as data) is pended one time, with due null, and not again at the next round", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [{ ...HOURLY, cron: "0 0 30 2 *" }])
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    yield* (yield* Turns).idle
    const pended = wakeRow(file, 1)
    const second = yield* after(w, SLEEP)
    yield* (yield* Turns).idle
    return { first, pended, second }
  }), { at: T0 + 10 * M })
  expect(got).toEqual({
    first: SLEEP,
    pended: { due: null, slot: T0, pending: null, missed: 0, fired: 1, last_turn: 1, settled: 0, failed: 0, stopped: 0, why: null },
    second: SLEEP
  })
  expect(w.pends).toEqual([[1, { pending: T0, missed: 0, due: null }]])
  expect(w.readies).toBe(2)
  expect(texts(file, "wake")).toEqual(["[1] due 2026-11-16 09:00 Europe/Berlin, 10 min late: " + TEXT])
  expect(wakeRow(file, 1)).toMatchObject({ due: null, pending: null, fired: 1, settled: 1 })
  expect(diagnostics(w)).toEqual([])
})

test("a routine's cron that parses as a reminder's time is the row's diagnostic, one time in a launch: no pendWake of it, and the round's other row is written and fires", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [{ ...HOURLY, cron: "2026-11-16T09:00" }, HOURLY])
  expect(Result.getOrThrow(parse("2026-11-16T09:00", Result.getOrThrow(zone("Europe/Berlin"))))._tag).toBe("Reminder")
  const w = watch()
  await launch(file, w, Effect.gen(function*() {
    yield* rested(w)
    yield* (yield* Turns).idle
    yield* after(w, SLEEP)
  }), { at: T0 + 10 * M })
  expect(diagnostics(w)).toEqual(["error wake-up 1 was not pended: its cron is a reminder's time, not a routine"])
  expect(w.pends).toEqual([[2, { pending: T0, missed: 0, due: T0 + HOUR }]])
  expect(wakeRow(file, 1)).toMatchObject({ due: T0, pending: null, fired: 0 })
  expect(w.readies).toBe(2)
  expect(texts(file, "wake")).toEqual(["[2] due 2026-11-16 09:00 Europe/Berlin, 10 min late: " + TEXT])
})

// The sleep
// ---------

test("the sleep: with a slot in 10 s the next round is at that slot; with none, in 60 s; the fiber is gone when the scope closes", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [DAILY])
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    expect(first).toBe(10_000)
    const second = yield* after(w, 10_000)
    yield* (yield* Turns).idle
    const third = yield* after(w, SLEEP)
    return [first, second, third]
  }), { at: T0 - 10_000 })
  // At 08:59:50 the slot is 10 s away; after it, the next is a day away.
  expect(got).toEqual([10_000, SLEEP, SLEEP])
  expect(firedAt(file)).toEqual([0])
  expect(w.readies).toBe(3)
  const empty = newFile()
  const v = watch()
  const rounds = await launch(empty, v, Effect.gen(function*() {
    const first = yield* rested(v)
    const second = yield* after(v, SLEEP)
    return [first, second, v.readies]
  }), { at: T0 })
  expect(rounds).toEqual([SLEEP, SLEEP, 2])
  // The launch's end closed the layer's scope: the fiber was cut in its sleep.
  for (const one of [w, v]) {
    const exit = await Effect.runPromise(Effect.flatMap(Deferred.await(one.fiber), Fiber.await))
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }
})

test("the sleep while off, with a row due at exactly now: 60 s, not 0 (the row is due, not in the future)", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [reminder(1, T0)], true)
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const now = yield* clock
    const first = yield* rested(w)
    return { now, first, row: wakeRow(file, 1) }
  }), { at: T0 })
  // The firer's clock told the round's sleep: the row's due is now.
  expect(got).toEqual({
    now: 0,
    first: SLEEP,
    row: { due: T0, slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: 0, why: null }
  })
  expect({ pends: w.pends, readies: w.readies }).toEqual({ pends: [], readies: 1 })
})

// The stops
// ---------

test("the stops: the end of a wake turn counted by the next round, done (the count to 0), failed (+ 1), stopped by its ceiling (+ 1) and stopped by the person (kept); an end that came while EverChat was down is counted at the start's first round, before its row fires", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY])
  const w = watch()
  const sandbox = holding()
  await launch(file, w, Effect.gen(function*() {
    const turns = yield* Turns
    // 09:10: turn 1 fails. 10:00: turn 2 is done. 11:00: turn 3 reaches its
    // ceiling. 12:00: the person stops turn 4. Each round counts the end
    // before it.
    yield* rested(w)
    yield* turns.idle
    yield* walk(w, HOUR)
    yield* turns.idle
    yield* walk(w, 2 * HOUR)
    yield* turns.idle
    yield* walk(w, 3 * HOUR)
    yield* Deferred.await(sandbox.started)
    yield* turns.stop()
    yield* turns.idle
    yield* after(w, w.last)
  }), { at: T0 + 10 * M, run: sandbox.run, wire: script("fail", "ok", "ceiling", "hold") })
  expect(ends(file)).toEqual([
    { id: 1, status: "failed", why: "it failed" },
    { id: 2, status: "done", why: null },
    { id: 3, status: "stopped", why: CEILING },
    { id: 4, status: "stopped", why: "Stopped." }
  ])
  expect(w.settles).toEqual([[1, 1, "failed", 1], [1, 2, "done", 0], [1, 3, "failed", 1], [1, 4, "kept", 1]])
  expect(w.order).toEqual(["fire 1", "settle 1", "fire 1", "settle 1", "fire 1", "settle 1", "fire 1", "settle 1"])
  expect(stops(file)).toEqual([])
  expect(wakeRow(file, 1)).toMatchObject({ fired: 4, last_turn: 4, settled: 1, failed: 1, stopped: 0, why: null })
  // Down: a launch with no firer fires the row, and its turn fails.
  const down = newFile()
  await make(down, T0 - HOUR, [HOURLY])
  await launch(down, watch(), Effect.gen(function*() {
    yield* (yield* Store).pendWake(1, { pending: T0, missed: 0, due: T0 + HOUR })
    yield* (yield* Turns).ready
    yield* (yield* Turns).idle
  }), { at: T0 + 10 * M, firer: false, wire: script("fail") })
  expect(wakeRow(down, 1)).toMatchObject({ fired: 1, last_turn: 1, settled: 0, failed: 0 })
  // The start at 10:05: its first round counts the end, then fires 10:00.
  const v = watch()
  const first = await launch(down, v, Effect.gen(function*() {
    const slept = yield* rested(v)
    yield* (yield* Turns).idle
    return slept
  }), { at: T0 + HOUR + 5 * M })
  expect({ first, settles: v.settles, order: v.order, readies: v.readies }).toEqual({ first: SLEEP, settles: [[1, 1, "failed", 1]], order: ["settle 1", "fire 1"], readies: 1 })
  expect(texts(down, "wake")).toEqual(["[1] due 2026-11-16 09:00 Europe/Berlin, 10 min late: " + TEXT, "[1] due 2026-11-16 10:00 Europe/Berlin, 5 min late: " + TEXT])

  // The table of the settle, as `endOf` reads it; a turn that runs has none.
  expect([endOf("done", null), endOf("failed", "it failed"), endOf("stopped", CEILING), endOf("stopped", "Stopped."), endOf("running", null)]).toEqual(["done", "failed", "failed", "kept", null])
})

// The settle (M3, M4)
// -------------------

// The note of the stop at two failures.
const STOPPED = "Wake-up 1 stopped: two of its turns in a row failed or reached the ceiling."

// The row after its stop at two failures: nothing left to fire.
const STOPPED_ROW = { due: null, slot: T0 + HOUR, pending: null, missed: 0, fired: 2, last_turn: 2, settled: 1, failed: 2, stopped: 1, why: "failed" }

// After `failedOnce`: a launch with no firer at 10:10 fires 10:00, whose
// turn 2 fails, then 11:00 waits (written at 11:05): the row is not
// settled, with a fire waiting.
const failedTwice = (file: string) =>
  launch(file, watch(), Effect.gen(function*() {
    const store = yield* Store
    yield* store.pendWake(1, { pending: T0 + HOUR, missed: 0, due: T0 + 2 * HOUR })
    yield* (yield* Turns).ready
    yield* (yield* Turns).idle
    yield* TestClock.setTime(T0 + 2 * HOUR + 5 * M)
    yield* store.pendWake(1, { pending: T0 + 2 * HOUR, missed: 0, due: T0 + 3 * HOUR })
  }), { at: T0 + HOUR + 10 * M, firer: false, wire: script("fail") })

for (const listen of [false, true]) {
  test(`the settle before a fire (M3), ${listen ? "by the listener's wake, the sleep not over" : "by the round, the listener held back"}: a row whose fire waits when its turn ends failed is settled, and stops at 2 with its note, before it fires again; no slot of it is pended after its end`, async () => {
    const file = newFile()
    await failedOnce(file)
    expect(wakeRow(file, 1)).toMatchObject({ settled: 1, failed: 1, due: T0 + HOUR })
    const w = watch(listen)
    const sandbox = holding()
    const got = await launch(file, w, Effect.gen(function*() {
      const turns = yield* Turns
      // 10:10: the 10:00 fire; turn 2 holds. 11:00 waits for it. 11:59: the
      // last round before 12:00.
      yield* rested(w)
      yield* Deferred.await(sandbox.started)
      yield* walk(w, 2 * HOUR + 59 * M)
      const waits = wakeRow(file, 1)
      // Turn 2 fails.
      yield* Deferred.succeed(sandbox.open, undefined)
      yield* turns.idle
      const failed = wakeRow(file, 1)
      // The listener's wake, at once; else the round at 12:00, when 12:00
      // is due.
      const slept = listen ? yield* woke(w) : yield* after(w, w.last)
      yield* turns.idle
      return { waits, failed, slept, at: yield* clock, firer: (yield* Deferred.await(w.fiber)).id }
    }), { at: T0 + HOUR + 10 * M, run: sandbox.run, wire: script("hold", "fail") })
    expect(got.waits).toEqual({ due: T0 + 3 * HOUR, slot: T0 + HOUR, pending: T0 + 2 * HOUR, missed: 0, fired: 2, last_turn: 2, settled: 0, failed: 1, stopped: 0, why: null })
    // The failed end changes nothing of the row: its end is not counted.
    expect(got.failed).toEqual(got.waits)
    expect({ slept: got.slept, at: got.at }).toEqual(listen ? { slept: SLEEP, at: 2 * HOUR + 59 * M } : { slept: SLEEP, at: 3 * HOUR })
    expect(wakeRow(file, 1)).toEqual(STOPPED_ROW)
    expect(stops(file)).toEqual([STOPPED])
    expect(stoppedText(1)).toBe(STOPPED)
    expect(texts(file, "wake").length).toBe(2)
    expect(w.order).toEqual(["fire 1", "settle 1"])
    expect(w.settles).toEqual([[1, 2, "failed", 2]])
    expect(w.pends).toEqual([
      [1, { pending: T0 + HOUR, missed: 0, due: T0 + 2 * HOUR }],
      [1, { pending: T0 + 2 * HOUR, missed: 0, due: T0 + 3 * HOUR }]
    ])
    // Turn 1 and its failure (`failedOnce`), turn 2 and its failure, then
    // the stop's note, with no turn. Each settle's read ran in the firer's
    // one fiber.
    expect(messages(file)).toEqual(["0 wake -", "1 note 1", "2 wake -", "3 tool 2", "4 echo 2", "5 note 2", "6 note -"])
    expect(new Set(w.fibers)).toEqual(new Set([got.firer]))
    expect(diagnostics(w)).toEqual([])
  })
}

test("the settle before a fire (M4), at a start: the approvals' ready before the firer's first round offers nothing of the row whose end is not counted; the first round settles it, and it stops at 2 with its note", async () => {
  const file = newFile()
  await failedOnce(file)
  await failedTwice(file)
  expect(wakeRow(file, 1)).toEqual({ due: T0 + 3 * HOUR, slot: T0 + HOUR, pending: T0 + 2 * HOUR, missed: 0, fired: 2, last_turn: 2, settled: 0, failed: 1, stopped: 0, why: null })
  const before = messages(file)
  const early: Array<unknown> = []
  // As the approvals' load: `ready` at the build, before the firer's.
  const approvals = Layer.effectDiscard(Effect.gen(function*() {
    yield* (yield* Turns).ready
    early.push({ log: messages(file), row: wakeRow(file, 1) })
  }).pipe(Effect.orDie))
  const w = watch()
  await launch(file, w, Effect.gen(function*() {
    yield* rested(w)
    yield* (yield* Turns).idle
  }), { at: T0 + 2 * HOUR + 10 * M, before: approvals })
  expect(early).toEqual([{ log: before, row: { due: T0 + 3 * HOUR, slot: T0 + HOUR, pending: T0 + 2 * HOUR, missed: 0, fired: 2, last_turn: 2, settled: 0, failed: 1, stopped: 0, why: null } }])
  expect(wakeRow(file, 1)).toEqual(STOPPED_ROW)
  expect(stops(file)).toEqual([STOPPED])
  expect(messages(file)).toEqual([...before, `${before.length} note -`])
  expect({ settles: w.settles, order: w.order, pends: w.pends }).toEqual({ settles: [[1, 2, "failed", 2]], order: ["settle 1"], pends: [] })
})

// The note at two failures (M5)
// -----------------------------

// The faults of the note's one transaction: in its `write` (the row's
// stop, `settleWake`), and in its own page's `message` event, before its
// `write` runs. A stop written in a transaction of its own would survive the
// second and leave the row stopped with no note, for ever.
const noteFaults: ReadonlyArray<readonly [string, Layer.Layer<Store, never, Store>]> = [
  ["in its write, settleWake", over(() => ({ settleWake: () => Effect.fail(new StoreError({ op: "settleWake", cause: new Error("the disk is gone") })) }))],
  [
    "in its own page's message event, before its write",
    over((real) => ({
      addEvent: (event) => (event.type === "message" ? Effect.fail(new StoreError({ op: "addEvent", cause: new Error("the disk is gone") })) : real.addEvent(event))
    }))
  ]
]

for (const [where, faulty] of noteFaults) {
  test(`the note at two failures (M5): a fault in the note's transaction, ${where}, leaves no note and the row not settled, one diagnostic; the next launch writes the one note with the row's stop; a second round writes no second note`, async () => {
    const file = newFile()
    await failedOnce(file)
    await failedTwice(file)
    const before = messages(file)
    const w = watch()
    const first = await launch(file, w, Effect.gen(function*() {
      const slept = yield* rested(w)
      yield* (yield* Turns).idle
      return slept
    }), { at: T0 + 2 * HOUR + 10 * M, store: faulty })
    expect(first).toBe(SLEEP)
    expect(messages(file)).toEqual(before)
    expect(wakeRow(file, 1)).toEqual({ due: T0 + 3 * HOUR, slot: T0 + HOUR, pending: T0 + 2 * HOUR, missed: 0, fired: 2, last_turn: 2, settled: 0, failed: 1, stopped: 0, why: null })
    // The row and the log above are the claim: no settle committed, and the
    // stop went with the note. `w.settles` records a settle when
    // `settleWake` returns (not when its transaction commits): here none
    // returned, as the fault came in it or before it ran.
    expect(w.settles).toEqual([])
    const lines = diagnostics(w)
    expect(lines.length).toBe(1)
    expect(lines[0]!.split("\n")[0]).toBe("error a round of the wake-ups failed: the next round tries again")
    expect(lines[0]).toContain("the disk is gone")
    // The next launch: the one note, then a round with nothing to settle.
    const v = watch()
    const rounds = await launch(file, v, Effect.gen(function*() {
      const one = yield* rested(v)
      const two = yield* after(v, v.last)
      yield* (yield* Turns).idle
      return [one, two]
    }), { at: T0 + 2 * HOUR + 20 * M })
    expect(rounds).toEqual([SLEEP, SLEEP])
    expect(v.fibers.length).toBe(2)
    expect(messages(file)).toEqual([...before, `${before.length} note -`])
    expect(stops(file)).toEqual([STOPPED])
    expect(wakeRow(file, 1)).toEqual(STOPPED_ROW)
    expect({ settles: v.settles, order: v.order, pends: v.pends }).toEqual({ settles: [[1, 2, "failed", 2]], order: ["settle 1"], pends: [] })
    expect(WAKE_FAILURES).toBe(2)
  })
}

test("a row that the person stopped between its fire and its turn's second failed end is settled with no note, its stopped and why kept; a reminder that fired and whose turn failed is settled with no note", async () => {
  const file = newFile()
  await failedOnce(file)
  const w = watch()
  const sandbox = holding()
  await launch(file, w, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    yield* rested(w)
    yield* Deferred.await(sandbox.started)
    yield* turns.note("Wake-up 1 stopped by the person.", () => Effect.asVoid(store.stopWake(1, "person")))
    yield* Deferred.succeed(sandbox.open, undefined)
    yield* turns.idle
    yield* after(w, w.last)
  }), { at: T0 + HOUR + 10 * M, run: sandbox.run, wire: script("hold", "fail") })
  expect(ends(file).map((one) => one.status)).toEqual(["failed", "failed"])
  expect(w.settles).toEqual([[1, 2, "failed", 2]])
  expect(stops(file)).toEqual(["Wake-up 1 stopped by the person."])
  expect(wakeRow(file, 1)).toEqual({ due: null, slot: T0 + HOUR, pending: null, missed: 0, fired: 2, last_turn: 2, settled: 1, failed: 2, stopped: 1, why: "person" })
  const once = newFile()
  await make(once, T0 - HOUR, [reminder(1, T0)])
  const v = watch()
  await launch(once, v, Effect.gen(function*() {
    yield* rested(v)
    yield* (yield* Turns).idle
    yield* after(v, v.last)
  }), { at: T0 + 10 * M, wire: script("fail") })
  expect(v.settles).toEqual([[1, 1, "failed", 1]])
  expect(stops(once)).toEqual([])
  expect(wakeRow(once, 1)).toEqual({ due: null, slot: T0, pending: null, missed: 0, fired: 1, last_turn: 1, settled: 1, failed: 1, stopped: 1, why: "fired" })
})

test("a fault in a plain settle (no note) is the round's one diagnostic: the row is not settled, and the next round settles it", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY])
  // With no firer: the 09:00 fire, and its turn 1 is done, not settled.
  await launch(file, watch(), Effect.gen(function*() {
    yield* (yield* Store).pendWake(1, { pending: T0, missed: 0, due: T0 + HOUR })
    yield* (yield* Turns).ready
    yield* (yield* Turns).idle
  }), { at: T0 + 10 * M, firer: false })
  const fired = { due: T0 + HOUR, slot: T0, pending: null, missed: 0, fired: 1, last_turn: 1, settled: 0, failed: 0, stopped: 0, why: null }
  expect(wakeRow(file, 1)).toEqual(fired)
  let failures = 1
  const failing = over((real) => ({
    settleWake: (id, turn, end) =>
      Effect.suspend(() => failures-- > 0 ? Effect.fail(new StoreError({ op: "settleWake", cause: new Error("the disk is gone") })) : real.settleWake(id, turn, end))
  }))
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const first = yield* rested(w)
    const failed = { row: wakeRow(file, 1), diagnostics: diagnostics(w).length, settles: [...w.settles] }
    const second = yield* after(w, first as number)
    return { first, failed, second }
  }), { at: T0 + 20 * M, store: failing })
  expect(got).toEqual({ first: SLEEP, failed: { row: fired, diagnostics: 1, settles: [] }, second: SLEEP })
  const lines = diagnostics(w)
  expect(lines.length).toBe(1)
  expect(lines[0]!.split("\n")[0]).toBe("error a round of the wake-ups failed: the next round tries again")
  expect(lines[0]).toContain("the disk is gone")
  expect(w.settles).toEqual([[1, 1, "done", 0]])
  expect(wakeRow(file, 1)).toEqual({ ...fired, settled: 1 })
  expect(stops(file)).toEqual([])
})

// The settle while off (M13)
// --------------------------

for (const listen of [true, false]) {
  test(`the settle while off (M13), ${listen ? "by the listener's wake" : "by the round, the listener held back"}: off commits while a wake turn runs; the turn fails; the row is settled while off, in the firer's one fiber; no pendWake and no offer while off`, async () => {
    const file = newFile()
    await make(file, T0 - HOUR, [HOURLY])
    const w = watch(listen)
    const sandbox = holding()
    const got = await launch(file, w, Effect.gen(function*() {
      const store = yield* Store
      const turns = yield* Turns
      yield* rested(w)
      yield* Deferred.await(sandbox.started)
      yield* turns.note("The person turned the wake-ups off.", () => Effect.asVoid(store.setWakeups(false)))
      yield* Deferred.succeed(sandbox.open, undefined)
      yield* turns.idle
      const slept = listen ? yield* woke(w) : yield* after(w, w.last)
      const settled = { at: yield* clock, row: wakeRow(file, 1), chat: (yield* store.chat).wakeups }
      // Off past two slots: nothing is pended, nothing fires.
      yield* walk(w, 2 * HOUR + 10 * M)
      return { slept, settled, firer: (yield* Deferred.await(w.fiber)).id }
    }), { at: T0 + 10 * M, run: sandbox.run, wire: script("hold", "fail") })
    expect(got.slept).toBe(SLEEP)
    expect(got.settled).toEqual({
      at: listen ? 10 * M : 11 * M,
      row: { due: T0 + HOUR, slot: T0, pending: null, missed: 0, fired: 1, last_turn: 1, settled: 1, failed: 1, stopped: 0, why: null },
      chat: false
    })
    expect(w.settles).toEqual([[1, 1, "failed", 1]])
    expect(w.pends).toEqual([[1, { pending: T0, missed: 0, due: T0 + HOUR }]])
    expect(w.order).toEqual(["fire 1", "settle 1"])
    expect(texts(file, "wake").length).toBe(1)
    expect(new Set(w.fibers)).toEqual(new Set([got.firer]))
    expect(wakeRow(file, 1)).toEqual(got.settled.row)
  })
}

test("the settle while off (M13), a restart before the settle: the first round, still off, settles each row, and the row at its second failure stops with its one note; no pendWake and no offer while off; then on: the stopped row does not fire, and the other fires one time with its missed count, after its end was counted", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY, HOURLY])
  // With no firer: row 1 fails once (turn 1, counted); at 10:10 row 1 and
  // row 2 fire, and both turns fail (2 and 3); then off.
  await launch(file, watch(), Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    yield* store.pendWake(1, { pending: T0, missed: 0, due: T0 + HOUR })
    yield* turns.ready
    yield* turns.idle
    yield* store.settleWake(1, 1, "failed")
    yield* TestClock.setTime(T0 + HOUR + 10 * M)
    yield* store.pendWake(1, { pending: T0 + HOUR, missed: 0, due: T0 + 2 * HOUR })
    yield* store.pendWake(2, { pending: T0 + HOUR, missed: 1, due: T0 + 2 * HOUR })
    yield* turns.ready
    yield* turns.idle
    yield* turns.note("The person turned the wake-ups off.", () => Effect.asVoid(store.setWakeups(false)))
  }), { at: T0 + 10 * M, firer: false, wire: script("fail", "fail", "fail") })
  expect([wakeRow(file, 1), wakeRow(file, 2)]).toMatchObject([{ last_turn: 2, settled: 0, failed: 1 }, { last_turn: 3, settled: 0, failed: 0 }])
  const w = watch()
  const got = await launch(file, w, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    yield* rested(w)
    const first = { settles: [...w.settles], stops: stops(file), rows: [wakeRow(file, 1), wakeRow(file, 2)] }
    // Off past three slots.
    yield* walk(w, 4 * HOUR + 20 * M)
    const off = { pends: [...w.pends], wakes: texts(file, "wake").length }
    // On, as the command: its note, then ready; the next round pends.
    yield* turns.note("The person turned the wake-ups on.", () => Effect.asVoid(store.setWakeups(true)))
    yield* turns.ready
    yield* after(w, w.last)
    yield* turns.idle
    return { first, off }
  }), { at: T0 + HOUR + 20 * M })
  expect(got.first).toEqual({
    settles: [[1, 2, "failed", 2], [2, 3, "failed", 1]],
    stops: [STOPPED],
    rows: [
      { due: null, slot: T0 + HOUR, pending: null, missed: 0, fired: 2, last_turn: 2, settled: 1, failed: 2, stopped: 1, why: "failed" },
      { due: T0 + 2 * HOUR, slot: T0 + HOUR, pending: null, missed: 0, fired: 1, last_turn: 3, settled: 1, failed: 1, stopped: 0, why: null }
    ]
  })
  expect(got.off).toEqual({ pends: [], wakes: 3 })
  expect(w.pends).toEqual([[2, { pending: T0 + 4 * HOUR, missed: 2, due: T0 + 5 * HOUR }]])
  expect(w.order).toEqual(["settle 1", "settle 2", "fire 2"])
  expect(texts(file, "wake").slice(3)).toEqual(["[2] due 2026-11-16 13:00 Europe/Berlin, 21 min late, 2 missed: " + TEXT])
  expect(stops(file)).toEqual([STOPPED])
  expect(texts(file, "note").filter((one) => !one.startsWith("No reply"))).toEqual(["The person turned the wake-ups off.", STOPPED, "The person turned the wake-ups on."])
  expect(wakeRow(file, 1)).toEqual(got.first.rows[0])
})

// After a ceiling stop (M9)
// -------------------------

test("after a ceiling stop (M9): a message of the person that waits during the wake turn's last step starts its turn after the stop, and the stop counts against the row", async () => {
  const file = newFile()
  await make(file, T0 - HOUR, [HOURLY])
  const w = watch()
  const sandbox = holding()
  const wire = script("hold ceiling", "ok")
  await launch(file, w, Effect.gen(function*() {
    const turns = yield* Turns
    yield* rested(w)
    yield* Deferred.await(sandbox.started)
    yield* turns.say("Are you there?")
    yield* Deferred.succeed(sandbox.open, undefined)
    yield* turns.idle
    yield* after(w, w.last)
  }), { at: T0 + 10 * M, run: sandbox.run, wire })
  expect(ends(file)).toEqual([{ id: 1, status: "stopped", why: CEILING }, { id: 2, status: "done", why: null }])
  expect(turnRows(file)).toEqual([
    { id: 1, status: "stopped", first_msg: 0, steps: 20, tokens: 2_000_000 },
    { id: 2, status: "done", first_msg: 1, steps: null, tokens: null }
  ])
  // The person's message waits while turn 1 runs its last step, then the
  // stop's note, then the person's turn.
  expect(messages(file)).toEqual(["0 wake -", "1 user -", "2 tool 1", "3 echo 1", "4 note 1", "5 asst 2"])
  expect(texts(file, "note")).toEqual([CEILING])
  expect(wire.sent.length).toBe(2)
  expect(w.settles).toEqual([[1, 1, "failed", 1]])
  expect(wakeRow(file, 1)).toMatchObject({ last_turn: 1, settled: 1, failed: 1, stopped: 0 })
  expect(stops(file)).toEqual([])
})
