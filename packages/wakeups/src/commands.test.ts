// Tests of the command's service of the wake-ups (commands.ts): a stop, off
// and on, each the write of a note in its one transaction; the answers of
// a state that is already so; the loop's lock against an offer, in each
// order; a row that the firer stops between the member's read and its
// note; and the list. Each case runs on a file's store, the tests' fake
// wire and the turn loop with this package's source, and no firer, on a
// `TestClock` (the store reads its time from it); each order that a case
// needs is held by a gate, never by a wait of real time.

import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as path from "node:path"
import { compactor, fakeWire, newFile, options, reply, rows, wireError } from "@everchat/local/testing"
import { limitLayer } from "@everchat/local/limitfile"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { storeLayer } from "@everchat/sqlite/bun"
import { Ask, AskDelay } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { wallClock } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { type NewWake, Store, StoreError, type Wake } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { OFF_TEXT, ON_TEXT, type Row, stopText, Wakeups } from "./commands.ts"
import { stoppedText } from "./firer.ts"
import { DAY, next, source } from "./source.ts"
import type { Chat } from "@everchat/core/store"
import { entries, type Listed } from "./functions.ts"

const M = 60_000
// 09:00 in Berlin, a Monday.
const T0 = Date.parse("2026-11-16T08:00:00Z")
const TEXT = "Read my mail and give me the plan."
const ROUTINE: NewWake = { text: TEXT, cron: "0 9 * * *", zone: "Europe/Berlin", first: T0 }
const reminder = (k: number, at: number): NewWake => ({ text: `Reminder ${k}.`, at, zone: "Europe/Berlin", first: at })

// A store over the real one: `over` gives the members that it changes.
const over = (change: (real: Store["Service"]) => Partial<Store["Service"]>): Layer.Layer<Store, never, Store> =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({ ...real, ...change(real) })
    })
  )

// What the service asked of the turn loop and the store: its notes' texts,
// its calls of `ready`, and its writes (`stopWake`, `setWakeups`).
interface Asked {
  readonly notes: Array<string>
  readies: number
  readonly writes: Array<string>
}

const asked = (): Asked => ({ notes: [], readies: 0, writes: [] })

// The service's turn loop: the real one, with each note and `ready` kept.
const turnsOf = (a: Asked): Layer.Layer<Turns, never, Turns> =>
  Layer.effect(
    Turns,
    Effect.gen(function*() {
      const real = yield* Turns
      return Turns.of({
        ...real,
        note: (text, write) => Effect.andThen(Effect.sync(() => a.notes.push(text)), real.note(text, write)),
        ready: Effect.andThen(Effect.sync(() => a.readies++), real.ready)
      })
    })
  )

// The service's store: the one that every part reads, with its writes kept.
const storeOf = (a: Asked): Layer.Layer<Store, never, Store> =>
  over((real) => ({
    stopWake: (id, why, call) => Effect.andThen(Effect.sync(() => a.writes.push(`stopWake ${id} ${why}`)), real.stopWake(id, why, call)),
    setWakeups: (on) => Effect.andThen(Effect.sync(() => a.writes.push(`setWakeups ${on}`)), real.setWakeups(on))
  }))

type Run = (program: string) => Effect.Effect<{ output: string; failed: boolean }>

// One launch: the store over `file` (with `given.store` over it), the
// memory, the ask service over the fake wire, a sandbox that runs no
// program, the turn loop with this package's source, and the service over
// the turn loop and the store as `a` keeps them, on a TestClock set to T0
// before the layers are built.
const withService = <A, E>(
  file: string,
  a: Asked,
  effect: Effect.Effect<A, E, Wakeups | Turns | Memory | Store | TestClock.TestClock>,
  given: { readonly wire?: ReturnType<typeof fakeWire>; readonly store?: Layer.Layer<Store, never, Store> } = {}
) => {
  const real = storeLayer(file, options())
  const store = given.store === undefined ? real : given.store.pipe(Layer.provide(real))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, (given.wire ?? replies()).layer)))
  const run: Run = () => Effect.die("no program was expected")
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: run as Sandbox["Service"]["run"] }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ head: head(DECLARATIONS) }).pipe(
    Layer.provide(source),
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, sandbox, limit))
  )
  const service = Wakeups.layer.pipe(Layer.provide(Layer.merge(turnsOf(a), storeOf(a))), Layer.provideMerge(turns))
  return Effect.runPromise(
    Effect.andThen(TestClock.setTime(T0), effect.pipe(Effect.provide(service))).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(AskDelay, () => Effect.succeed(0))
    )
  )
}

const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

// A model that says "Reply <n>." to each request.
const replies = () => fakeWire((asked, n) => says(asked, `Reply ${n}.`))

const made = (one: { readonly _tag: string; readonly wake?: Wake }): Wake => {
  if (one._tag !== "made" || one.wake === undefined) throw new Error(`not made: ${one._tag}`)
  return one.wake
}

// The log as "<i> <kind> <turn>" (a turn of none: -).
const messages = (file: string) =>
  rows<{ i: number; kind: string; turn: number | null }>(file, "select i, kind, turn from everchat_msg_read order by i").map((row) => `${row.i} ${row.kind} ${row.turn ?? "-"}`)
// The texts of the messages of a kind, in order.
const texts = (file: string, kind: string) => rows<{ text: string }>(file, `select text from everchat_msg_read where kind = '${kind}' order by i`).map((row) => row.text)
const turnRows = (file: string) => rows(file, "select n as id, status from everchat_turn order by n")
const wakeRow = (file: string, n: number) =>
  rows(file, `select due, slot, pending, missed, fired, last_turn, settled, failed, stopped is not null as stopped, why from everchat_wake where chat = 1 and n = ${n}`)[0]
const switchOf = (file: string) => rows<{ wakeups: number }>(file, "select wakeups from everchat_chat")[0]!.wakeups

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "it did not fail"
  const error = Cause.squash(exit.cause)
  return error instanceof StoreError ? `StoreError ${error.op}` : String(error)
}

// A gate: `reached` is done when the held member is called, which then
// waits for `open`. `after`: the member runs first, and its result waits.
const gate = (after = false) => ({ reached: Deferred.makeUnsafe<void>(), open: Deferred.makeUnsafe<void>(), hold: false, after })
const held = <A, E>(one: ReturnType<typeof gate>, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    if (!one.hold) return effect
    one.hold = false
    const wait = Effect.andThen(Deferred.succeed(one.reached, undefined), Deferred.await(one.open))
    return one.after ? Effect.tap(effect, () => wait) : Effect.andThen(wait, effect)
  })

// A stop
// ------

test("a stop: the exact note, the row stopped by the person with nothing left to fire; its waiting fire is never offered; no ready", async () => {
  const file = newFile()
  const a = asked()
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const wakeups = yield* Wakeups
    made(yield* store.makeWake(ROUTINE, 20))
    yield* store.pendWake(1, { pending: T0, missed: 2, due: T0 + DAY })
    const stopped = yield* wakeups.stop(1)
    const offer = yield* next(store)
    yield* turns.ready
    yield* turns.idle
    return { stopped, offer }
  }))
  expect(got).toEqual({ stopped: "stopped", offer: null })
  expect(messages(file)).toEqual(["0 note -"])
  expect(texts(file, "note")).toEqual(["Wake-up 1 stopped by the person."])
  expect(stopText(3)).toBe("Wake-up 3 stopped by the person.")
  expect(turnRows(file)).toEqual([])
  expect(wakeRow(file, 1)).toEqual({ due: null, slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: 1, why: "person" })
  expect(a).toEqual({ notes: ["Wake-up 1 stopped by the person."], readies: 0, writes: ["stopWake 1 person"] })
})

test("a stop is one transaction: a fault in the note's transaction after the stop's statement leaves no note and the row active, its fire still waiting", async () => {
  const file = newFile()
  const a = asked()
  const fault = new StoreError({ op: "stopWake", cause: new Error("a fault after the stop's statement") })
  // The stop's statement runs, then its write fails, inside the note.
  const store = over((real) => ({ stopWake: (id, why, call) => Effect.andThen(real.stopWake(id, why, call), Effect.fail(fault)) }))
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const wakeups = yield* Wakeups
    made(yield* store.makeWake(ROUTINE, 20))
    yield* store.pendWake(1, { pending: T0, missed: 0, due: T0 + DAY })
    return failure(yield* Effect.exit(wakeups.stop(1)))
  }), { store })
  expect(got).toBe("StoreError stopWake")
  expect(messages(file)).toEqual([])
  expect(wakeRow(file, 1)).toEqual({ due: T0 + DAY, slot: null, pending: T0, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: 0, why: null })
  expect(a.notes).toEqual(["Wake-up 1 stopped by the person."])
})

// Off and on (M7)
// ---------------

test("off and on: the exact notes; while off the source gives nothing; after on, a row whose slots passed fires one time with its missed count, by the member's ready alone", async () => {
  const file = newFile()
  const a = asked()
  const wire = replies()
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const wakeups = yield* Wakeups
    // A fire waits for the slot of the 18th, and stands for the two before
    // it; then the wake-ups are off.
    made(yield* store.makeWake(ROUTINE, 20))
    yield* TestClock.setTime(T0 + 2 * DAY + 5 * M)
    yield* store.pendWake(1, { pending: T0 + 2 * DAY, missed: 2, due: T0 + 3 * DAY })
    const off = yield* wakeups.off
    const afterOff = { readies: a.readies, switch: switchOf(file) }
    const whileOff = yield* next(store)
    yield* turns.ready
    yield* turns.idle
    const logOff = messages(file)
    const readiesBefore = a.readies
    const on = yield* wakeups.on
    // The member's ready offered the fire: its message is in the log now.
    const afterOn = { readies: a.readies - readiesBefore, log: messages(file) }
    yield* turns.idle
    return { off, afterOff, whileOff, logOff, on, afterOn }
  }), { wire })
  expect(got).toEqual({
    off: "switched",
    afterOff: { readies: 0, switch: 0 },
    whileOff: null,
    logOff: ["0 note -"],
    on: "switched",
    afterOn: { readies: 1, log: ["0 note -", "1 note -", "2 wake -"] }
  })
  expect(messages(file)).toEqual(["0 note -", "1 note -", "2 wake -", "3 asst 1"])
  expect(texts(file, "note")).toEqual(["The person turned the wake-ups off.", "The person turned the wake-ups on."])
  expect([OFF_TEXT, ON_TEXT]).toEqual(["The person turned the wake-ups off.", "The person turned the wake-ups on."])
  expect(texts(file, "wake")).toEqual(["[1] due 2026-11-18 09:00 Europe/Berlin, 5 min late, 2 missed: " + TEXT])
  expect(turnRows(file)).toEqual([{ id: 1, status: "done" }])
  expect(wire.sent.length).toBe(1)
  expect(switchOf(file)).toBe(1)
  expect(a.writes).toEqual(["setWakeups false", "setWakeups true"])
})

test("off and on are one transaction each: a fault in the note's transaction after the switch's statement leaves no note and the switch as it was", async () => {
  for (const on of [false, true]) {
    const file = newFile()
    const a = asked()
    const fault = new StoreError({ op: "setWakeups", cause: new Error("a fault after the switch's statement") })
    const store = over((real) => ({ setWakeups: (value) => (value === on ? Effect.andThen(real.setWakeups(value), Effect.fail(fault)) : real.setWakeups(value)) }))
    const got = await withService(file, a, Effect.gen(function*() {
      const store = yield* Store
      const wakeups = yield* Wakeups
      if (on) yield* store.setWakeups(false)
      return failure(yield* Effect.exit(on ? wakeups.on : wakeups.off))
    }), { store })
    expect({ on, got, log: messages(file), switch: switchOf(file), readies: a.readies }).toEqual({ on, got: "StoreError setWakeups", log: [], switch: on ? 0 : 1, readies: 0 })
  }
})

// Already so
// ----------

test("already so: an id with no row, a row that has stopped, a fired reminder, off when off, on when on: no note, no write, no ready, and the member's answer", async () => {
  const file = newFile()
  const a = asked()
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const wakeups = yield* Wakeups
    // 1: stopped before; 2: a reminder that fired; 3: active.
    made(yield* store.makeWake(ROUTINE, 20))
    yield* store.stopWake(1, "person")
    made(yield* store.makeWake(reminder(2, T0 + M), 20))
    yield* store.pendWake(2, { pending: T0 + M, missed: 0, due: null })
    yield* TestClock.setTime(T0 + M)
    yield* turns.ready
    yield* turns.idle
    made(yield* store.makeWake(ROUTINE, 20))
    const before = { log: messages(file), wakes: rows(file, "select * from everchat_wake order by n"), chat: rows(file, "select * from everchat_chat") }
    const answers = {
      none: yield* wakeups.stop(9),
      zero: yield* wakeups.stop(0),
      stopped: yield* wakeups.stop(1),
      fired: yield* wakeups.stop(2),
      on: yield* wakeups.on
    }
    const after = { log: messages(file), wakes: rows(file, "select * from everchat_wake order by n"), chat: rows(file, "select * from everchat_chat") }
    return { answers, same: JSON.stringify(after) === JSON.stringify(before), before }
  }))
  expect(got.answers).toEqual({ none: "none", zero: "none", stopped: "inactive", fired: "inactive", on: "already" })
  expect(got.same).toBe(true)
  expect(got.before.log).toEqual(["0 wake -", "1 asst 1"])
  expect(wakeRow(file, 2)).toMatchObject({ stopped: 1, why: "fired" })
  expect(a).toEqual({ notes: [], readies: 0, writes: [] })
  // Off when off: the switch's note once, then nothing.
  const b = asked()
  const off = await withService(file, b, Effect.gen(function*() {
    const wakeups = yield* Wakeups
    return [yield* wakeups.off, yield* wakeups.off]
  }))
  expect(off).toEqual(["switched", "already"])
  expect(b).toEqual({ notes: ["The person turned the wake-ups off."], readies: 0, writes: ["setWakeups false"] })
  expect(texts(file, "note")).toEqual(["The person turned the wake-ups off."])
})

// The loop's lock (M1, M14)
// -------------------------

test("the lock, the offer first: a stop asked while the offer holds the loop's lock waits; the fire is in the log, then the stop's note, and the row is fired and then stopped", async () => {
  const file = newFile()
  const a = asked()
  const read = gate()
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const wakeups = yield* Wakeups
    made(yield* store.makeWake(ROUTINE, 20))
    yield* store.pendWake(1, { pending: T0, missed: 0, due: T0 + DAY })
    read.hold = true
    const offer = yield* Effect.forkChild(turns.ready, { startImmediately: true })
    yield* Deferred.await(read.reached)
    const stop = yield* Effect.forkChild(wakeups.stop(1), { startImmediately: true })
    // Both wait: the offer for its read, the stop behind it.
    const waiting = { offer: offer.pollUnsafe() === undefined, stop: stop.pollUnsafe() === undefined, log: messages(file) }
    yield* Deferred.succeed(read.open, undefined)
    yield* Fiber.join(offer)
    const stopped = yield* Fiber.join(stop)
    yield* turns.idle
    return { waiting, stopped }
  }), { store: over((real) => ({ pendingWake: () => held(read, real.pendingWake()) })) })
  expect(got).toEqual({ waiting: { offer: true, stop: true, log: [] }, stopped: "stopped" })
  const log = messages(file)
  expect(log[0]).toBe("0 wake -")
  expect(log.filter((one) => one.endsWith(" note -")).length).toBe(1)
  expect(log.indexOf("0 wake -")).toBeLessThan(log.findIndex((one) => one.endsWith(" note -")))
  expect(texts(file, "note")).toEqual(["Wake-up 1 stopped by the person."])
  expect(turnRows(file)).toEqual([{ id: 1, status: "done" }])
  expect(wakeRow(file, 1)).toMatchObject({ slot: T0, pending: null, fired: 1, last_turn: 1, stopped: 1, why: "person" })
})

test("the lock, the stop first: the note's write held inside the loop's lock, then ready waits for it; the stop commits, and ready gives no wake message and no turn", async () => {
  const file = newFile()
  const a = asked()
  const write = gate()
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const wakeups = yield* Wakeups
    made(yield* store.makeWake(ROUTINE, 20))
    yield* store.pendWake(1, { pending: T0, missed: 0, due: T0 + DAY })
    write.hold = true
    const stop = yield* Effect.forkChild(wakeups.stop(1), { startImmediately: true })
    yield* Deferred.await(write.reached)
    const offer = yield* Effect.forkChild(turns.ready, { startImmediately: true })
    const waiting = { offer: offer.pollUnsafe() === undefined, stop: stop.pollUnsafe() === undefined, log: messages(file) }
    yield* Deferred.succeed(write.open, undefined)
    const stopped = yield* Fiber.join(stop)
    yield* Fiber.join(offer)
    yield* turns.idle
    return { waiting, stopped }
  }), { store: over((real) => ({ stopWake: (id, why, call) => held(write, real.stopWake(id, why, call)) })) })
  expect(got).toEqual({ waiting: { offer: true, stop: true, log: [] }, stopped: "stopped" })
  expect(messages(file)).toEqual(["0 note -"])
  expect(turnRows(file)).toEqual([])
  expect(wakeRow(file, 1)).toMatchObject({ slot: null, pending: null, fired: 0, stopped: 1, why: "person" })
})

// A row changed since the read (section 7, M1, M16)
// -------------------------------------------------

test("a row changed since the read: the firer's stop at two failures commits between the member's read and its note; the stop's note stays after the firer's, and the row keeps its first why", async () => {
  const file = newFile()
  const a = asked()
  const read = gate(true)
  // Turns 1 and 2 fail; the rest say a reply.
  const wire = fakeWire((asked, n) => (n <= 2 ? wireError("input") : says(asked, `Reply ${n}.`)))
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const wakeups = yield* Wakeups
    // Two fires whose turns fail; the first end is counted.
    made(yield* store.makeWake(ROUTINE, 20))
    yield* store.pendWake(1, { pending: T0, missed: 0, due: T0 + DAY })
    yield* turns.ready
    yield* turns.idle
    yield* store.settleWake(1, 1, "failed")
    yield* TestClock.setTime(T0 + DAY)
    yield* store.pendWake(1, { pending: T0 + DAY, missed: 0, due: T0 + 2 * DAY })
    yield* turns.ready
    yield* turns.idle
    const before = wakeRow(file, 1)
    // The member reads the row as active; then the firer's stop commits.
    read.hold = true
    const stop = yield* Effect.forkChild(wakeups.stop(1), { startImmediately: true })
    yield* Deferred.await(read.reached)
    yield* turns.note(stoppedText(1), () => Effect.asVoid(store.settleWake(1, 2, "failed")))
    yield* Deferred.succeed(read.open, undefined)
    return { before, stopped: yield* Fiber.join(stop) }
  }), { wire, store: over((real) => ({ wakes: (filter) => held(read, real.wakes(filter)) })) })
  expect(got.before).toMatchObject({ last_turn: 2, settled: 0, failed: 1, stopped: 0, why: null })
  expect(got.stopped).toBe("stopped")
  expect(texts(file, "note").filter((one) => one.startsWith("Wake-up "))).toEqual([stoppedText(1), "Wake-up 1 stopped by the person."])
  expect(wakeRow(file, 1)).toMatchObject({ settled: 1, failed: 2, stopped: 1, why: "failed" })
  expect(a.writes).toEqual(["stopWake 1 person"])
})

// The list
// --------

test("the list: the switch, the active rows first, then the stopped ones, each by id, with each field; off gives on false", async () => {
  const file = newFile()
  const a = asked()
  const got = await withService(file, a, Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const wakeups = yield* Wakeups
    const empty = yield* wakeups.list
    // 1: a routine that the person stops; 2: a reminder at 09:30:30 on the
    // 18th; 3: a routine that fired at T0, whose next fire waits with a
    // count; 4: a routine in Tokyo.
    made(yield* store.makeWake(ROUTINE, 20))
    made(yield* store.makeWake(reminder(2, Date.parse("2026-11-18T08:30:30Z")), 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "Third." }, 20))
    yield* store.pendWake(3, { pending: T0, missed: 0, due: T0 + DAY })
    yield* turns.ready
    yield* turns.idle
    yield* store.settleWake(3, 1, "done")
    yield* store.pendWake(3, { pending: T0 + 3 * DAY, missed: 2, due: T0 + 4 * DAY })
    made(yield* store.makeWake({ text: "Tokyo.", cron: "30 7 * * 1-5", zone: "Asia/Tokyo", first: Date.parse("2026-11-16T22:30:00Z") }, 20))
    yield* wakeups.stop(1)
    const on = yield* wakeups.list
    yield* wakeups.off
    return { empty, on, off: (yield* wakeups.list).on }
  }))
  expect(got.empty).toEqual({ on: true, rows: [] })
  expect(got.off).toBe(false)
  expect(got.on).toEqual({
    on: true,
    rows: [
      { id: 2, text: "Reminder 2.", when: "2026-11-18T09:30:30", zone: "Europe/Berlin", next: "2026-11-18 09:30 Europe/Berlin", last: null, missed: 0, active: true, why: null },
      { id: 3, text: "Third.", when: "0 9 * * *", zone: "Europe/Berlin", next: "2026-11-19 09:00 Europe/Berlin", last: "2026-11-16 09:00 Europe/Berlin", missed: 2, active: true, why: null },
      { id: 4, text: "Tokyo.", when: "30 7 * * 1-5", zone: "Asia/Tokyo", next: "2026-11-17 07:30 Asia/Tokyo", last: null, missed: 0, active: true, why: null },
      { id: 1, text: TEXT, when: "0 9 * * *", zone: "Europe/Berlin", next: null, last: null, missed: 0, active: false, why: "person" }
    ] satisfies Array<Row>
  })
  expect(wallClock(T0, "Europe/Berlin")).toBe("2026-11-16 09:00 Europe/Berlin")
})

// The two lists compared (lead, ec-h66pfl, T4 to T6)
// ---------------------------------------------------

// The person reads the chat's wake-ups by `/wakeups` (`Wakeups.list`); the
// model reads them by `wakes()` (the entry of functions.ts), the oracle.
// For each list of rows the two give the same count of rows in the same
// order; the k-th rows are equal in id, text, when, zone, next, last,
// missed and why; the command's `active` is true exactly when the model's
// `stopped` is null. The model's `fired`, and its `stopped` as a time, have
// no field in the command's row. The listing's `on` is the chat's switch.

// The seed of the comparison: each compared value names it, so a failure
// prints it.
const SEED = 0x3c6ef372

// A generator of numbers in [0, 1) from a seed (a linear congruential one).
const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

// An instant whose year is `year` (a year of fewer than 4 digits too), on
// June 15th at 10:20 UTC.
const inYear = (year: number) => {
  const day = new Date(Date.UTC(2000, 5, 15, 10, 20, 0))
  day.setUTCFullYear(year)
  return day.getTime()
}

// The instants that the rows are made of, each to the minute: the gap and
// the repeated hour of Berlin (2026-03-29, 2026-10-25), of New York
// (2026-03-08, 2026-11-01) and of Lord Howe, whose clock moves by 30
// minutes (2026-04-05, 2026-10-04); a plain day; years of 1, 2 and 3
// digits; and years far ahead.
const INSTANTS = [
  Date.parse("2026-03-29T00:59:00Z"),
  Date.parse("2026-03-29T01:30:00Z"),
  Date.parse("2026-10-25T00:30:00Z"),
  Date.parse("2026-10-25T01:30:00Z"),
  Date.parse("2026-03-08T07:30:00Z"),
  Date.parse("2026-11-01T05:30:00Z"),
  Date.parse("2026-11-01T06:30:00Z"),
  Date.parse("2026-04-04T14:45:00Z"),
  Date.parse("2026-10-03T15:45:00Z"),
  Date.parse("2026-11-16T08:00:00Z"),
  inYear(7),
  inYear(50),
  inYear(999),
  inYear(2999),
  inYear(9999)
]

// The zones: whole hours (Berlin, New York, UTC), 5:45 and a clock that
// moves by 30 minutes (Kathmandu, Lord Howe), and names that the engine
// does not know (a row is data: both pieces read them as UTC).
const ZONES = ["Europe/Berlin", "America/New_York", "UTC", "Asia/Kathmandu", "Australia/Lord_Howe", "Mars/Base", "Europe/Berlin\nX"]

// The parts of a text: a line end, a control code, U+202E, a character
// outside the BMP, a lone surrogate, plain words.
const PARTS = ["line\nend", "\u0007", "\u202e", "\u{1f600}", "\ud800", "Read my mail.", " "]

const CRONS = ["0 9 * * *", "0 * * * *", "15 9 * * 1-5", "30 7 * * 1-5"]
const WHYS = ["fired", "unwake", "person", "failed"] as const
const MISSED = [0, 1, 999, 1000, 1500]

// The rows of the lists: `count` lists of mixed sizes (the empty list and
// a list of one row first), each with the chat's switch, its rows in the
// order of their ids, active and stopped ones mixed.
const generated = (seed: number, count: number) => {
  const random = seeded(seed)
  const pick = <A>(all: ReadonlyArray<A>): A => all[Math.floor(random() * all.length)]!
  const maybe = <A>(value: A): A | null => (random() < 0.5 ? null : value)
  const text = (): string => {
    const kind = random()
    if (kind < 0.1) return "x".repeat(2000)
    if (kind < 0.15) return "\u{1f600}".repeat(1000)
    return Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(PARTS)).join("")
  }
  const row = (id: number): Wake => {
    // A reminder's time with seconds that are not 0, or 0; a routine.
    const first = pick(INSTANTS) + pick([0, 0, 30_000, 59_000])
    const reminder = random() < 0.5
    const due = maybe(first + pick([0, 3_600_000, 86_400_000]))
    const pending = pick([null, due, first + 7_200_000])
    const stopped = maybe(first + 3_600_000)
    return {
      id,
      text: text(),
      cron: reminder ? null : pick(CRONS),
      at: reminder ? first : null,
      zone: pick(ZONES),
      first,
      turn: null,
      call: null,
      due,
      slot: maybe(first - 3_600_000),
      pending,
      missed: pick(MISSED),
      fired: Math.floor(random() * 50),
      lastTurn: null,
      settled: true,
      failed: 0,
      stopped,
      why: stopped === null ? null : pick(WHYS),
      stopCall: null,
      created: first,
      updated: first
    }
  }
  return Array.from({ length: count }, (_, k) => {
    const size = k === 0 ? 0 : k === 1 ? 1 : 1 + Math.floor(random() * 40)
    let id = 0
    const rows = Array.from({ length: size }, () => row(id += 1 + Math.floor(random() * 3)))
    return { on: random() < 0.5, rows }
  })
}

test("the two lists compared: /wakeups (Wakeups.list) and the model's wakes() over the same rows, seeded: the same rows in the same order, each field equal, active exactly when not stopped, the switch as on", async () => {
  const lists = generated(SEED, 30)
  const count = lists.reduce((sum, one) => sum + one.rows.length, 0)
  // At least 400 rows, the empty list and a list of one row among them.
  expect({ seed: SEED, enough: count >= 400, sizes: [lists[0]!.rows.length, lists[1]!.rows.length] }).toEqual({ seed: SEED, enough: true, sizes: [0, 1] })
  for (const [k, one] of lists.entries()) {
    // `list` and `wakes` read the store only by `chat` and `wakes()`: one
    // store value answers those two from the generated rows, with no
    // database (the store's contract suite proves that a real store gives
    // such rows). No clock and no signal is waited on.
    const store = {
      chat: Effect.succeed({ wakeups: one.on } as Chat),
      wakes: () => Effect.succeed([...one.rows])
    } as unknown as Store["Service"]
    const wakes = entries(store).find((entry) => entry.declaration.name === "wakes")!
    const model = (await Effect.runPromise(wakes.run([], { turn: 1, program: 1, call: 1 }))) as ReadonlyArray<Listed>
    const command = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* Wakeups).list
    }).pipe(
      Effect.provide(Wakeups.layer.pipe(Layer.provide(Layer.merge(Layer.succeed(Store, store), Layer.succeed(Turns, {} as Turns["Service"])))))
    ))
    const expected = model.map(({ id, text, when, zone, next, last, missed, why, stopped }): Row => ({ id, text, when, zone, next, last, missed, active: stopped === null, why }))
    expect({ seed: SEED, list: k, listing: command }, `seed 0x${SEED.toString(16)}, list ${k}`).toEqual({ seed: SEED, list: k, listing: { on: one.on, rows: expected } })
  }
})
