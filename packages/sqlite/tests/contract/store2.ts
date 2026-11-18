// The store's cases, part 2 (packages/sqlite/AGENTS.md, "The contract's
// suites"): the comparison of a wake-up's states with a model of them, the
// tag of a deployment, the events and their read, and the key of a
// message's sender. `storeCases2(h)` registers its cases for the store of
// the harness `h`; SQLite's store.test.ts runs it after `storeCases1` with
// the same harness (the helpers of part 1 that these cases use, `owners`
// and `launches`, read the harness that `storeCases1` set), and keeps the
// cases that need SQLite itself (the local layers, a second connection,
// the reads over a file, a trigger's refusal, a change of the schema, the
// driver's own text). The model of the comparison (`SEEDS`, `STEPS`,
// `seeded`, `compareSeed` and the model's functions) and the helpers that
// the test file's own cases use too are exported here: one text of each.

import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  Chats,
  type NewEvent,
  NoChat,
  Store,
  StoreError,
  type Turn,
  type UnsettledWake,
  WAKE_FAILURES,
  type Wake
} from "@everchat/core/store"
import { type Harness, options, PICK } from "./harness.ts"
import { CEILING_WHY, H, launches, owners, T0 } from "./store1.ts"

// The harness of the store under test: `storeCases2` sets it, before it
// registers a case.
let h: Harness

// The comparison of the row's states
// ----------------------------------
//
// Two pieces: the page's states of a wake-up (docs/wakeups.md, sections 2
// and 7, with the lead's rulings 2 to 4a of ec-muncvc and 1 to 4 of
// ec-w8sgt0), written below as a model of the rows of a chat with no SQL;
// and the store's members over SQLite. The relation: equal. After each
// step of a seeded sequence, over two chats of one file, each row that
// `wakes()` gives equals the model's row, and `dueWakes(now)`,
// `pendingWake()`, `unsettledWakes()` and the chat's `wakeups` equal the
// model's answers; so do the answers of `pendWake`, `settleWake`,
// `stopWake` and `setWakeups`. The oracle is the model; a `StoreError` in a
// step is a failure too (lead, ec-e75r, D1). Three claims hold after each
// step, on the store's answers: a stopped row is in no answer of
// `dueWakes` and `pendingWake`; a count of failures at `WAKE_FAILURES` is a
// row stopped with why `failed`, unless it stopped before; no row has its
// count to come (`settled` false) with no last turn.
//
// The steps: a make (a routine or a reminder); a `pendWake` of a slot
// before, at and after the row's `slot`, its waiting `pending` and its
// `due`, with a count of 0, 1, 999, 1,000 or 1,001 and a next `due` or
// none, also while the chat is off; a fire of what `pendingWake` gave, as
// an offer writes it (the turn's row, then `fireWake`, in one transaction),
// with or without a `pendWake` of the same row between the read and the
// fire, and while off a fire that the source read before the switch; a
// `settleWake` with each end, of the row's last turn, of another turn, of
// a row not there, and a second time; the end of a turn (done, failed, or
// stopped by its ceiling or the person); a `stopWake` of each kind, with
// and without `unwake`'s call, on an active row, on a stopped one and on
// one not there; `setWakeups` off and on, also to the value it had; and the
// clock moved on or back. The bounds: SEEDS sequences of STEPS steps each
// (100 of 100: 10,000 steps), fixed seeds 1 to 100, in one case with its
// own timeout (BOUND, 120 s); it ran in about 11 s at its writing (junit).
// A failure prints its seed and the whole sequence up to the step that
// failed. It found no disagreement of the model and the store, so it has
// no fixed case of its own; the planted faults that only it finds:
// `pendWake` that keeps the old `due` when a fire waits and the given
// `due` is null (ec-muncvc); `unsettledWakes` in the order of `last_turn`,
// not of the row's id (ec-w8sgt0).

export const SEEDS = Array.from({ length: 100 }, (_, k) => 1 + k)
export const STEPS = 100
export const BOUND = 120_000

// A seeded generator (mulberry32): the same seed, the same sequence.
export const seeded = (seed: number) => {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <A>(from: ReadonlyArray<A>): A => from[Math.floor(next() * from.length)]!
  return { next, pick }
}

export type Row = { -readonly [K in keyof Wake]: Wake[K] }

// The model of one chat: its switch, the counts of its turns and calls,
// the ends of its turns, the rows whose count of failures reached
// `WAKE_FAILURES` after they had stopped, and its rows.
export interface Modeled {
  on: boolean
  turns: number
  calls: number
  readonly ended: Map<number, { readonly status: Turn["status"]; readonly why: string | null }>
  readonly stoppedFirst: Set<number>
  readonly rows: Array<Row>
}

export const newModeled = (): Modeled => ({ on: true, turns: 0, calls: 0, ended: new Map(), stoppedFirst: new Set(), rows: [] })

export const MISSED_MAX = 1000

// The model's rows as `wakes()` gives them, in the order of their ids.
export const modelWakes = (chat: Modeled): Array<Wake> => chat.rows.map((row) => ({ ...row }))

export const modelMake = (chat: Modeled, wake: { readonly text: string; readonly cron: string | null; readonly at: number | null; readonly first: number }, now: number): Wake => {
  const row: Row = {
    id: chat.rows.length + 1,
    text: wake.text,
    cron: wake.cron,
    at: wake.at,
    zone: "Europe/Berlin",
    first: wake.first,
    turn: null,
    call: null,
    due: wake.first,
    slot: null,
    pending: null,
    missed: 0,
    fired: 0,
    lastTurn: null,
    settled: true,
    failed: 0,
    stopped: null,
    why: null,
    stopCall: null,
    created: now,
    updated: now
  }
  chat.rows.push(row)
  return { ...row }
}

// The table's row "its slot comes" and "another slot comes before it
// fires" (rulings 2): only an active row of a chat that is on, only a slot
// after `slot` and after the waiting `pending`.
export const modelPend = (chat: Modeled, n: number, pend: { readonly pending: number; readonly missed: number; readonly due: number | null }, now: number): boolean => {
  const row = chat.rows.find((one) => one.id === n)
  if (row === undefined || !chat.on || row.stopped !== null) return false
  if (row.slot !== null && pend.pending <= row.slot) return false
  if (row.pending !== null && pend.pending <= row.pending) return false
  row.missed = row.pending === null ? Math.min(pend.missed, MISSED_MAX) : Math.min(row.missed + 1 + pend.missed, MISSED_MAX)
  row.pending = pend.pending
  row.due = pend.due
  row.updated = now
  return true
}

// Ruling 1.
export const modelDue = (chat: Modeled, now: number): Array<Wake> =>
  chat.on
    ? chat.rows.filter((row) => row.stopped === null && row.due !== null && row.due <= now).sort((x, y) => x.due! - y.due! || x.id - y.id).map((row) => ({ ...row }))
    : []

// Ruling 3.
export const modelPending = (chat: Modeled): Option.Option<Wake> => {
  if (!chat.on) return Option.none()
  const waiting = chat.rows.filter((row) => row.stopped === null && row.settled && row.pending !== null).sort((x, y) => x.pending! - y.pending! || x.id - y.id)
  return waiting.length === 0 ? Option.none() : Option.some({ ...waiting[0]! })
}

// The table's row "the source offers it" (rulings 4 and 4a).
export const modelFire = (chat: Modeled, n: number, turn: number, read: { readonly pending: number; readonly missed: number }, now: number) => {
  const row = chat.rows.find((one) => one.id === n)!
  row.slot = read.pending
  row.fired += 1
  row.lastTurn = turn
  row.settled = false
  row.updated = now
  if (row.cron === null) {
    row.stopped = now
    row.why = "fired"
    row.due = null
    row.pending = null
    row.missed = 0
  } else if (row.pending === read.pending) {
    row.pending = null
    row.missed = 0
  } else if (row.missed < MISSED_MAX) {
    row.missed = Math.max(row.missed - read.missed - 1, 0)
  }
}

// The table's rows of the end of `last_turn` (ruling 1 of this bead,
// ec-w8sgt0): only the row's last turn, not counted yet; the count by the
// end; at `WAKE_FAILURES`, an active row stops, with nothing left to fire.
// The switch is not read.
export const modelSettle = (chat: Modeled, n: number, turn: number, end: "done" | "failed" | "kept", now: number) => {
  const row = chat.rows.find((one) => one.id === n)
  if (row === undefined || row.lastTurn !== turn || row.settled) return { settled: false, stopped: false }
  row.failed = end === "done" ? 0 : end === "failed" ? row.failed + 1 : row.failed
  row.settled = true
  row.updated = now
  if (row.failed >= WAKE_FAILURES && end === "failed") {
    if (row.stopped !== null) {
      chat.stoppedFirst.add(row.id)
      return { settled: true, stopped: false }
    }
    row.stopped = now
    row.why = "failed"
    row.due = null
    row.pending = null
    row.missed = 0
    return { settled: true, stopped: true }
  }
  return { settled: true, stopped: false }
}

// The table's row "active: unwake, or /wakeups stop" (ruling 3).
export const modelStop = (chat: Modeled, n: number, why: "unwake" | "person", call: number | null, now: number): boolean => {
  const row = chat.rows.find((one) => one.id === n)
  if (row === undefined || row.stopped !== null) return false
  row.stopped = now
  row.why = why
  row.stopCall = call
  row.due = null
  row.pending = null
  row.missed = 0
  row.updated = now
  return true
}

// Ruling 4: whether the value changed.
export const modelSwitch = (chat: Modeled, on: boolean): boolean => {
  const changed = chat.on !== on
  chat.on = on
  return changed
}

// Ruling 2: the rows not counted, with their last turn's end.
export const modelUnsettled = (chat: Modeled): Array<UnsettledWake> =>
  chat.rows.filter((row) => !row.settled).map((row) => ({ wake: { ...row }, ...(chat.ended.get(row.lastTurn!) ?? { status: "running" as const, why: null }) }))

// The checks of section 2, on the model's rows: a model that breaks one is
// wrong, whatever the store says.
export const modelChecks = (chat: Modeled): Array<string> =>
  chat.rows.flatMap((row) => {
    const broken: Array<string> = []
    if ((row.cron === null) === (row.at === null)) broken.push("cron or at")
    if (row.at !== null && row.first !== row.at) broken.push("first = at")
    if ((row.stopped === null) !== (row.why === null)) broken.push("stopped and why")
    if (row.stopCall !== null && row.why !== "unwake") broken.push("a stop's call only with unwake")
    if (row.stopped !== null && (row.due !== null || row.pending !== null)) broken.push("a stopped row has nothing to fire")
    if (row.pending !== null && row.slot !== null && !(row.pending > row.slot)) broken.push("pending > slot")
    if (row.lastTurn === null && !row.settled) broken.push("last_turn or settled")
    if (row.missed < 0 || row.fired < 0 || row.failed < 0) broken.push("counts 0 or more")
    return broken.map((check) => `row ${row.id}: ${check}`)
  })

// One sequence: its steps as text, and the first disagreement, if any.
export const compareSeed = (seed: number) => {
  const file = h.newFile()
  const random = seeded(seed)
  const steps: Array<string> = []
  const model: Array<Modeled> = [newModeled(), newModeled()]
  // What the sequence reached, for the case's check of its reach.
  const seen = new Set<string>()
  const run = Effect.gen(function*() {
    const chats = yield* Chats
    const uuids = [yield* chats.make(TENANT_A, PICK), yield* chats.make(TENANT_B, PICK)]
    const stores = [yield* chats.store(TENANT_A, uuids[0]!, LAUNCH), yield* chats.store(TENANT_B, uuids[1]!, LAUNCH)]
    // The two chats are the file's first two: ids 1 and 2.
    const ids = (yield* Effect.promise(() => h.rows<{ id: number }>(file, "select id from everchat_chat order by id"))).map((row) => row.id)
    if (ids.join() !== "1,2") return `the chats are ${ids.join()}`
    let now = T0
    yield* TestClock.setTime(now)

    // A step of the store that fails is a disagreement (D1).
    const why = (error: unknown): string =>
      error instanceof StoreError ? `${error.op}: ${why(error.cause)}` : `${String(error)}${error instanceof Error && error.cause !== undefined ? ` (${why(error.cause)})` : ""}`
    const step = <A>(effect: Effect.Effect<A, unknown>) =>
      Effect.map(Effect.exit(effect), (exit) => (Exit.isSuccess(exit) ? { ok: true as const, value: exit.value } : { ok: false as const, error: why(Cause.squash(exit.cause)) }))

    // The slots a pendWake may give a row: before, at and after its slot,
    // its waiting pending and its due, and now.
    const slots = (row: Row | undefined) => {
      const bases = [row?.slot, row?.pending, row?.due, now].filter((base): base is number => base !== null && base !== undefined)
      return bases.flatMap((base) => [base - H, base - 1, base, base + 1, base + H])
    }
    const pendOf = (row: Row | undefined) => ({
      pending: random.pick(slots(row)),
      missed: random.pick([0, 1, 999, 1000, 1001]),
      due: random.pick([null, now + H, now + 2 * H, now - H])
    })

    for (let k = 0; k < STEPS; k++) {
      const c = random.pick([0, 1])
      const chat = model[c]!
      const store = stores[c]!
      const kind = random.pick(["make", "pend", "pend", "pend", "fire", "fire", "fire", "settle", "settle", "end", "stop", "switch", "clock"] as const)
      if (kind === "make" && chat.rows.length < 4) {
        const routine = random.next() < 0.5
        const first = now + random.pick([-2 * H, -H, 0, H, 3 * H])
        const wake = { text: `${c}.${chat.rows.length + 1}`, cron: routine ? "0 * * * *" : null, at: routine ? null : first, first }
        steps.push(`chat ${c + 1}: makeWake(${JSON.stringify(wake)}) at ${now - T0}`)
        seen.add(routine ? "a routine made" : "a reminder made")
        const got = yield* step(store.makeWake({ ...wake, zone: "Europe/Berlin" }, 20))
        const want = modelMake(chat, wake, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (!Equal(got.value, { _tag: "made", wake: want })) return `makeWake gave ${JSON.stringify(got.value)}, the model ${JSON.stringify(want)}`
      } else if (kind === "pend" || kind === "make") {
        const n = 1 + Math.floor(random.next() * (chat.rows.length + 1))
        const row = chat.rows.find((one) => one.id === n)
        const pend = pendOf(row)
        steps.push(`chat ${c + 1}: pendWake(${n}, ${JSON.stringify({ ...pend, pending: pend.pending - T0 })} from T0) at ${now - T0}`)
        const waited = row?.pending !== null && row?.pending !== undefined
        const got = yield* step(store.pendWake(n, pend))
        const want = modelPend(chat, n, pend, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (got.value !== want) return `pendWake gave ${got.value}, the model ${want}`
        seen.add(want ? (waited ? "a slot taken while a fire waits" : "a slot taken") : "a slot refused")
        if (!chat.on && row !== undefined && row.stopped === null) seen.add("a slot refused while off")
        if (want && row!.missed === MISSED_MAX) seen.add("missed at the bound")
      } else if (kind === "fire") {
        const read = yield* step(store.pendingWake())
        if (!read.ok) return `a StoreError: ${read.error}`
        // While off, the source reads none; a fire that it read before the
        // switch still comes (fireWake does not read the switch).
        const late = chat.rows.filter((row) => row.stopped === null && row.settled && row.pending !== null)
        if (Option.isNone(read.value) && (chat.on || late.length === 0 || random.next() < 0.5)) {
          steps.push(`chat ${c + 1}: pendingWake() gave none`)
          if (!chat.on && late.length > 0) seen.add("a fire waits while off")
          continue
        }
        const given = Option.isSome(read.value) ? read.value.value : random.pick(late)
        const handed = { pending: given.pending!, missed: given.missed }
        if (Option.isNone(read.value)) {
          steps.push(`chat ${c + 1}: pendingWake() gave none; the source read ${given.id} ${JSON.stringify({ ...handed, pending: handed.pending - T0 })} from T0 before the switch went off`)
          seen.add("a fire while off")
        } else steps.push(`chat ${c + 1}: pendingWake() gave ${given.id} ${JSON.stringify({ ...handed, pending: handed.pending - T0 })} from T0`)
        if (random.next() < 0.5) {
          const pend = pendOf(chat.rows.find((one) => one.id === given.id))
          steps.push(`chat ${c + 1}: between the read and the fire, pendWake(${given.id}, ${JSON.stringify({ ...pend, pending: pend.pending - T0 })} from T0)`)
          const got = yield* step(store.pendWake(given.id, pend))
          const want = modelPend(chat, given.id, pend, now)
          if (!got.ok) return `a StoreError: ${got.error}`
          if (got.value !== want) return `pendWake gave ${got.value}, the model ${want}`
          if (want) seen.add("a newer slot between the read and the fire")
        }
        steps.push(`chat ${c + 1}: the offer: startTurn, fireWake(${given.id}) at ${now - T0}`)
        const got = yield* step(store.transaction(Effect.gen(function*() {
          const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
          yield* store.fireWake(given.id, turn.id, handed)
          return turn.id
        })))
        if (!got.ok) return `a StoreError: ${got.error}`
        chat.turns += 1
        if (got.value !== chat.turns) return `the offer's turn is ${got.value}, the model's ${chat.turns}`
        const row = chat.rows.find((one) => one.id === given.id)!
        seen.add(row.cron === null ? "a reminder fired" : row.pending === handed.pending ? "a fire went" : "a fire went, a newer one waits")
        modelFire(chat, given.id, chat.turns, handed, now)
      } else if (kind === "settle") {
        // Mostly a row that fired, with its last turn; else another turn
        // (an older one, one of no fire, one not there), or a row that is
        // not there. A row settled already is a second settle.
        const fired = chat.rows.filter((row) => row.lastTurn !== null)
        const row = fired.length === 0 || random.next() < 0.1 ? undefined : random.pick(fired)
        const n = row?.id ?? 1 + Math.floor(random.next() * (chat.rows.length + 1))
        const turn = row !== undefined && random.next() < 0.8 ? row.lastTurn! : 1 + Math.floor(random.next() * (chat.turns + 1))
        const end = random.pick(["done", "failed", "failed", "failed", "kept"] as const)
        const was = chat.rows.find((one) => one.id === n)
        const before = was === undefined ? undefined : { ...was }
        steps.push(`chat ${c + 1}: settleWake(${n}, ${turn}, ${end}) at ${now - T0}`)
        const got = yield* step(store.settleWake(n, turn, end))
        const want = modelSettle(chat, n, turn, end, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (!Equal(got.value, want)) return `settleWake gave ${JSON.stringify(got.value)}, the model ${JSON.stringify(want)}`
        if (!want.settled) {
          seen.add(before !== undefined && before.lastTurn === turn && before.settled ? "a second settle refused" : "a settle refused")
        } else {
          seen.add(`an end counted: ${end}`)
          if (want.stopped) seen.add(before!.pending !== null ? "a stop at two failures, a fire waiting" : "a stop at two failures")
          if (before!.stopped !== null) seen.add(chat.stoppedFirst.has(n) ? "two failures of a stopped row, its why kept" : "an end of a stopped row counted")
          if (!chat.on) seen.add("an end counted while off")
        }
      } else if (kind === "end") {
        // A turn of the chat ends (a second end changes nothing).
        if (chat.turns === 0) continue
        const turn = 1 + Math.floor(random.next() * chat.turns)
        const { status, why } = random.pick([
          { status: "done", why: null },
          { status: "failed", why: "the model failed" },
          { status: "stopped", why: CEILING_WHY },
          { status: "stopped", why: "Stopped." }
        ] as const)
        steps.push(`chat ${c + 1}: endTurn(${turn}, ${status}, ${why}) at ${now - T0}`)
        const got = yield* step(store.endTurn(turn, status, why))
        if (!got.ok) return `a StoreError: ${got.error}`
        if (!chat.ended.has(turn)) chat.ended.set(turn, { status, why })
        seen.add("a turn ended")
      } else if (kind === "stop") {
        // Half the time a row whose end is not counted (a stop between a
        // fire and its settle), else any number.
        const open = chat.rows.filter((row) => !row.settled && row.stopped === null)
        const n = open.length > 0 && random.next() < 0.5 ? random.pick(open).id : 1 + Math.floor(random.next() * (chat.rows.length + 1))
        const why = random.pick(["unwake", "person"] as const)
        // `unwake`'s call, mostly, in a turn that runs (a call starts only
        // in one).
        let call: number | null = null
        const running = Array.from({ length: chat.turns }, (_, k) => k + 1).filter((turn) => !chat.ended.has(turn))
        if (why === "unwake" && running.length > 0 && random.next() < 0.7) {
          const turn = random.pick(running)
          steps.push(`chat ${c + 1}: startCall in turn ${turn}`)
          const made = yield* step(store.startCall({ turn, vendorId: `call_${chat.calls + 1}`, fn: "run", input: "unwake" }))
          if (!made.ok) return `a StoreError: ${made.error}`
          chat.calls += 1
          if (made.value !== chat.calls) return `the call is ${made.value}, the model's ${chat.calls}`
          call = made.value
        }
        const was = chat.rows.find((one) => one.id === n)
        const waited = was !== undefined && was.pending !== null
        steps.push(`chat ${c + 1}: stopWake(${n}, ${why}, ${call}) at ${now - T0}`)
        const got = yield* step(store.stopWake(n, why, call))
        const want = modelStop(chat, n, why, call, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (got.value !== want) return `stopWake gave ${got.value}, the model ${want}`
        seen.add(want ? `a stop by ${why}${call === null ? "" : " with its call"}${waited ? ", a fire waiting" : ""}` : "a stop refused")
      } else if (kind === "switch") {
        const on = random.pick([true, false])
        steps.push(`chat ${c + 1}: setWakeups(${on})`)
        const got = yield* step(store.setWakeups(on))
        const want = modelSwitch(chat, on)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (got.value !== want) return `setWakeups gave ${got.value}, the model ${want}`
        seen.add(want ? (on ? "on" : "off") : "a switch to the value it had")
      } else {
        const by = random.pick([-2 * H, -1, 1, H, 3 * H])
        now += by
        seen.add(by < 0 ? "the clock back" : "the clock on")
        steps.push(`the clock moves to ${now - T0} from T0`)
        yield* TestClock.setTime(now)
      }
      const broken = model.flatMap((one, m) => modelChecks(one).map((check) => `chat ${m + 1}, the model: ${check}`))
      if (broken.length > 0) return broken.join("; ")
      // Each chat's rows, due rows, waiting fire, rows not counted and
      // switch, against the model.
      for (const [m, one] of model.entries()) {
        const s = stores[m]!
        const got = yield* step(Effect.all({
          wakes: s.wakes(),
          due: s.dueWakes(now),
          pending: s.pendingWake(),
          unsettled: s.unsettledWakes(),
          on: Effect.map(s.chat, (chat) => chat.wakeups)
        }))
        if (!got.ok) return `a StoreError: ${got.error}`
        const want = { wakes: modelWakes(one), due: modelDue(one, now), pending: modelPending(one), unsettled: modelUnsettled(one), on: one.on }
        if (want.due.length > 0) seen.add("rows due")
        if (want.unsettled.some((row) => row.status !== "running")) seen.add("a row not counted, its turn ended")
        for (const what of ["wakes", "due", "pending", "unsettled", "on"] as const) {
          if (!Equal(got.value[what], want[what])) {
            return `chat ${m + 1}, ${what}: the store gave ${JSON.stringify(got.value[what])}, the model ${JSON.stringify(want[what])}`
          }
        }
        // The claims that hold after each step, on the store's answers: a
        // stopped row is in no answer of dueWakes or pendingWake; a count of
        // failures at WAKE_FAILURES is a row stopped, why failed, unless it
        // stopped before; no row waits for a count with no last turn.
        const pending = Option.toArray(got.value.pending)
        if ([...got.value.due, ...pending].some((wake) => wake.stopped !== null)) return `chat ${m + 1}: a stopped row is due or waits`
        for (const wake of got.value.wakes) {
          if (wake.failed >= WAKE_FAILURES && (wake.stopped === null || (wake.why !== "failed" && !one.stoppedFirst.has(wake.id)))) {
            return `chat ${m + 1}: row ${wake.id} has ${wake.failed} failures, stopped ${wake.stopped}, why ${wake.why}`
          }
          if (!wake.settled && wake.lastTurn === null) return `chat ${m + 1}: row ${wake.id} is not settled, with no last turn`
          if (wake.failed >= WAKE_FAILURES) seen.add(wake.why === "failed" ? "a row stopped by two failures" : "a row at two failures that stopped before")
        }
      }
    }
    return null
  })
  return h.withChats(file, run.pipe(Effect.scoped, Effect.provide(TestClock.layer()))).then((disagreement) => ({ steps, disagreement, seen }))
}

// Deep equality, as `toEqual` reads it.
export const Equal = (x: unknown, y: unknown): boolean => Bun.deepEquals(x, y)

// Two tenants of a hosted deployment, by their UUIDs.
export const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
export const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
export const LAUNCH = options().launch

// A UUID of the file's hex, as text.
export const asUuid = (hex: string) => {
  const h = hex.toLowerCase()
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-")
}

const eventRows = (file: string) =>
  h.rows(file, "select chat, n, type, turn, call, msg, msg_last as msgLast from everchat_event order by n")

// Writes `rounds` rounds of the five types of event through the store's own
// members, each in the transaction of what it reports, as the turn loop
// writes them: a turn starts, two messages of the person are accepted, a
// program starts, a reply is in the log, and the turn ends. Five events
// each round.
export const story = (store: typeof Store.Service, rounds: number) =>
  Effect.gen(function*() {
    for (let r = 1; r <= rounds; r++) {
      const turn = yield* store.transaction(Effect.gen(function*() {
        const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: yield* store.count })
        yield* store.addEvent({ type: "start", turn: turn.id })
        return turn.id
      }))
      yield* store.transaction(Effect.gen(function*() {
        const said = yield* store.append([{ kind: "user", text: `one ${r}`, turn }, { kind: "user", text: `two ${r}`, turn }])
        yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[1]!.i })
      }))
      yield* store.transaction(Effect.gen(function*() {
        const call = yield* store.startCall({ turn, vendorId: `v${r}`, fn: "run", input: `program ${r}` })
        yield* store.addEvent({ type: "call", turn, call })
      }))
      yield* store.transaction(Effect.gen(function*() {
        const [reply] = yield* store.append([{ kind: "asst", text: `reply ${r}`, turn }])
        yield* store.addEvent({ type: "message", msg: reply!.i, msgLast: reply!.i })
      }))
      yield* store.transaction(Effect.andThen(store.endTurn(turn, r % 2 === 0 ? "failed" : "done", r % 2 === 0 ? `why ${r}` : null), store.addEvent({ type: "end", turn })))
    }
  })

// A message of the person as the turn loop logs it: its pages with the key
// on the first, and its `accepted` event, in one transaction. Its
// `accepted` number.
export const keyedSay = (store: typeof Store.Service, texts: ReadonlyArray<string>, key: string | null) =>
  store.transaction(Effect.gen(function*() {
    const said = yield* store.append(texts.map((text, k) => ({ kind: "user" as const, text, more: k < texts.length - 1 })), key)
    return yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[said.length - 1]!.i })
  }))

// The counts of the chat's messages and events, and its seq.
const counts = async (file: string) =>
  (await h.rows<{ messages: number; events: number; seq: number }>(
    file,
    "select (select count(*) from everchat_msg) as messages, (select count(*) from everchat_event) as events, (select seq from everchat_chat) as seq"
  ))[0]

export const storeCases2 = (harness: Harness) => {
  h = harness

  // The comparison of the row's states
  // ----------------------------------

  test(`the comparison: the page's states of a wake-up (a model with no SQL) and the store's members over SQLite agree after each step of ${SEEDS.length} seeded sequences of ${STEPS} steps over two chats: wakes, dueWakes, pendingWake, unsettledWakes, the chat's switch and the answers of pendWake, settleWake, stopWake and setWakeups, with no StoreError; a stopped row is never due or waiting, two failures are a stop, and no row waits for a count with no last turn`, async () => {
    const reached = new Set<string>()
    for (const seed of SEEDS) {
      const { steps, disagreement, seen } = await compareSeed(seed)
      for (const one of seen) reached.add(one)
      expect(disagreement, `seed ${seed}, its ${steps.length} steps:\n${steps.join("\n")}`).toBeNull()
    }
    // The sequences reach each kind of step and each branch of the table.
    expect([...reached].sort()).toEqual([
      "a fire waits while off",
      "a fire went",
      "a fire went, a newer one waits",
      "a fire while off",
      "a newer slot between the read and the fire",
      "a reminder fired",
      "a reminder made",
      "a routine made",
      "a row at two failures that stopped before",
      "a row not counted, its turn ended",
      "a row stopped by two failures",
      "a second settle refused",
      "a settle refused",
      "a slot refused",
      "a slot refused while off",
      "a slot taken",
      "a slot taken while a fire waits",
      "a stop at two failures",
      "a stop at two failures, a fire waiting",
      "a stop by person",
      "a stop by person, a fire waiting",
      "a stop by unwake",
      "a stop by unwake with its call",
      "a stop by unwake with its call, a fire waiting",
      "a stop by unwake, a fire waiting",
      "a stop refused",
      "a switch to the value it had",
      "a turn ended",
      "an end counted while off",
      "an end counted: done",
      "an end counted: failed",
      "an end counted: kept",
      "an end of a stopped row counted",
      "missed at the bound",
      "off",
      "on",
      "rows due",
      "the clock back",
      "the clock on",
      "two failures of a stopped row, its why kept"
    ])
  }, BOUND)

  // The tag of a deployment
  // -----------------------

  test("Chats: two tenants with a chat each in one file", async () => {
    const file = h.newFile()
    const made = await h.withChats(file, Effect.gen(function*() {
      const chats = yield* Chats
      const a = yield* chats.make(TENANT_A, PICK)
      const b = yield* chats.make(TENANT_B, { ...PICK, model: "gpt-other" })
      const storeA = yield* chats.store(TENANT_A, a, LAUNCH)
      const storeB = yield* chats.store(TENANT_B, b, LAUNCH)
      const readsA = yield* chats.reads(TENANT_A, a)
      return {
        a,
        b,
        seen: [(yield* storeA.chat).uuid, (yield* storeB.chat).uuid, (yield* readsA.chat).uuid],
        models: [(yield* storeA.chat).pick.model, (yield* storeB.chat).pick.model]
      }
    }))
    expect(made.a).not.toBe(made.b)
    expect(made.seen).toEqual([made.a, made.b, made.a])
    expect(made.models).toEqual(["gpt-test", "gpt-other"])
    const { chats, tenants } = await owners(file)
    expect(tenants.map((tenant) => asUuid(tenant.id)).sort()).toEqual([TENANT_A, TENANT_B])
    expect(chats.map((chat) => [asUuid(chat.tenant), asUuid(chat.uuid)]).sort()).toEqual([[TENANT_A, made.a], [TENANT_B, made.b]])
  })

  test("Chats: store and reads with tenant A and the UUID of B's chat fail with NoChat, equal in every field to a UUID that no chat has and a text that is no UUID", async () => {
    const file = h.newFile()
    const failures = await h.withChats(file, Effect.gen(function*() {
      const chats = yield* Chats
      const a = yield* chats.make(TENANT_A, PICK)
      const b = yield* chats.make(TENANT_B, PICK)
      // The tenant and the chat that each call names.
      const asked: ReadonlyArray<readonly [string, string]> = [
        [TENANT_A, b], // B's chat
        [TENANT_A, crypto.randomUUID()], // no chat has it
        [TENANT_A, "not a uuid"], // no UUID
        [TENANT_A, a.toUpperCase() + "0"], // no UUID: one digit too many
        [crypto.randomUUID(), a], // a tenant that is not there
        [TENANT_B, a] // A's chat, asked by B
      ]
      const got: Array<unknown> = []
      for (const [tenant, chat] of asked) {
        got.push(yield* Effect.flip(chats.store(tenant, chat, LAUNCH)))
        got.push(yield* Effect.flip(chats.reads(tenant, chat)))
      }
      return got
    }))
    expect(failures).toHaveLength(12)
    const shape = (error: unknown) => ({
      isNoChat: error instanceof NoChat,
      tag: (error as NoChat)._tag,
      message: (error as NoChat).message,
      keys: Object.keys(error as object),
      json: JSON.stringify(error),
      text: String(error)
    })
    const first = shape(failures[0])
    expect(first).toEqual({
      isNoChat: true,
      tag: "NoChat",
      message: "This tenant has no chat with this UUID.",
      keys: ["_tag"],
      json: "{\"_tag\":\"NoChat\"}",
      text: "NoChat: This tenant has no chat with this UUID."
    })
    for (const failure of failures) expect(shape(failure)).toEqual(first)
    // A store that was refused took no launch.
    expect(await launches(file)).toEqual([])
  })

  test("Chats: make for a tenant that is there makes no second tenant's row", async () => {
    const file = h.newFile()
    const made = await h.withChats(file, Effect.gen(function*() {
      const chats = yield* Chats
      return [yield* chats.make(TENANT_A, PICK), yield* chats.make(TENANT_A, PICK)]
    }))
    const { chats, tenants } = await owners(file)
    expect(tenants.map((tenant) => asUuid(tenant.id))).toEqual([TENANT_A])
    expect(chats.map((chat) => asUuid(chat.uuid)).sort()).toEqual([...made].sort())
    expect(chats.every((chat) => asUuid(chat.tenant) === TENANT_A)).toBe(true)
    // A tenant that is no UUID makes nothing.
    const refused = await h.withChats(file, Effect.flip(Chats.use((chats) => chats.make("not a uuid", PICK))))
    expect(refused).toBeInstanceOf(StoreError)
    expect((await owners(file)).chats).toHaveLength(2)
  })

  test("Chats: two stores of two chats, open at the same time, each with its own launch, write and read their own rows", async () => {
    const file = h.newFile()
    const seen = await h.withChats(file, Effect.gen(function*() {
      const chats = yield* Chats
      const a = yield* chats.store(TENANT_A, yield* chats.make(TENANT_A, PICK), LAUNCH)
      const b = yield* chats.store(TENANT_B, yield* chats.make(TENANT_B, PICK), LAUNCH)
      const say = (store: typeof a, text: string) => store.append([{ kind: "user", text, line: null, turn: null, call: null }])
      // The writes interleave: a, b, a, b.
      yield* say(a, "a 1")
      yield* say(b, "b 1")
      const turnA = yield* a.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      yield* say(b, "b 2")
      const turnB = yield* b.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      yield* say(a, "a 2")
      yield* a.addDiagnostics([{ level: "info", source: "test", text: "from a", created: 1 }])
      yield* b.addDiagnostics([{ level: "info", source: "test", text: "from b", created: 1 }])
      const of = (store: typeof a) =>
        Effect.gen(function*() {
          return {
            launch: store.launch.id,
            texts: (yield* store.messages(0, 10)).map((message) => message.text),
            turns: (yield* store.turns(null, 10)).map((turn) => turn.id),
            diagnostics: (yield* store.diagnostics()).map((line) => line.text),
            launches: (yield* store.launches(10)).map((launch) => [launch.id, launch.ended])
          }
        })
      return { a: yield* of(a), b: yield* of(b), turns: [turnA.id, turnB.id] }
    }))
    expect(seen.turns).toEqual([1, 1])
    expect(seen.a).toEqual({ launch: 1, texts: ["a 1", "a 2"], turns: [1], diagnostics: ["from a"], launches: [[1, null]] })
    expect(seen.b).toEqual({ launch: 1, texts: ["b 1", "b 2"], turns: [1], diagnostics: ["from b"], launches: [[1, null]] })
    // Two launch rows, one for each chat, both ended with the scope.
    expect(await h.rows(file, "select chat, n, why from everchat_launch order by chat")).toEqual([
      { chat: 1, n: 1, why: "exit" },
      { chat: 2, n: 1, why: "exit" }
    ])
  })

  // Events
  // ------

  test("addEvent: three events get 1, 2, 3 with no gap, seq is 3, and the chat's updated moved to the last one's time", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const before = (yield* store.chat).updated
      // The next millisecond at least, so that a move of `updated` shows.
      yield* Effect.sleep("5 millis")
      const numbers = [
        yield* store.addEvent({ type: "start", turn: turn.id }),
        yield* store.transaction(store.addEvent({ type: "end", turn: turn.id })),
        yield* store.addEvent({ type: "start", turn: turn.id })
      ]
      return { before, numbers, after: (yield* store.chat).updated }
    }))
    expect(got.numbers).toEqual([1, 2, 3])
    expect(await h.rows(file, "select n from everchat_event order by n")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    const [chat] = await h.rows<{ seq: number; updated: number }>(file, "select seq, updated from everchat_chat")
    const [last] = await h.rows<{ created: number }>(file, "select created from everchat_event where n = 3")
    expect(chat!.seq).toBe(3)
    expect(chat!.updated).toBeGreaterThan(got.before)
    expect(chat!.updated).toBe(last!.created)
    expect(got.after).toBe(chat!.updated)
  })

  test("addEvent: each type's row holds what the union gives, and null for the rest", async () => {
    // The type refuses a row that section 7 does not have: a message's row
    // copies no turn.
    // @ts-expect-error: a `message` row has no turn
    const refused: NewEvent = { type: "message", msg: 0, msgLast: 0, turn: 1 }
    expect(refused.type).toBe("message")
    const file = h.newFile()
    await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const said = yield* store.append([{ kind: "user", text: "one" }, { kind: "user", text: "two" }, { kind: "asst", text: "three" }])
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const call = yield* store.startCall({ turn: turn.id, vendorId: "v1", fn: "run", input: "1" })
      yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[1]!.i })
      yield* store.addEvent({ type: "start", turn: turn.id })
      yield* store.addEvent({ type: "call", turn: turn.id, call })
      yield* store.addEvent({ type: "message", msg: said[2]!.i, msgLast: said[2]!.i })
      yield* store.addEvent({ type: "end", turn: turn.id })
    }))
    expect(await eventRows(file)).toEqual([
      { chat: 1, n: 1, type: "accepted", turn: null, call: null, msg: 0, msgLast: 1 },
      { chat: 1, n: 2, type: "start", turn: 1, call: null, msg: null, msgLast: null },
      { chat: 1, n: 3, type: "call", turn: 1, call: 1, msg: null, msgLast: null },
      { chat: 1, n: 4, type: "message", turn: null, call: null, msg: 2, msgLast: 2 },
      { chat: 1, n: 5, type: "end", turn: 1, call: null, msg: null, msgLast: null }
    ])
  })

  test("addEvent: an event whose last message the chat does not have is refused, and the next event takes the next number, with no gap", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const said = yield* store.append([{ kind: "user", text: "one" }])
      const first = yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[0]!.i })
      const before = yield* Effect.promise(() => h.rows(file, "select seq, updated from everchat_chat"))
      yield* Effect.sleep("5 millis")
      // Message 1 is not there: only the reference of msg_last refuses it.
      const refused = yield* Effect.flip(store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[0]!.i + 1 }))
      const message = yield* Effect.flip(store.addEvent({ type: "message", msg: said[0]!.i, msgLast: said[0]!.i + 1 }))
      const after = yield* Effect.promise(() => h.rows(file, "select seq, updated from everchat_chat"))
      const next = yield* store.addEvent({ type: "message", msg: said[0]!.i, msgLast: said[0]!.i })
      return { first, refused, message, before, after, next }
    }))
    expect(got.refused).toBeInstanceOf(StoreError)
    expect(got.message).toBeInstanceOf(StoreError)
    expect(got.after).toEqual(got.before)
    expect([got.first, got.next]).toEqual([1, 2])
    expect(await eventRows(file)).toEqual([
      { chat: 1, n: 1, type: "accepted", turn: null, call: null, msg: 0, msgLast: 0 },
      { chat: 1, n: 2, type: "message", turn: null, call: null, msg: 0, msgLast: 0 }
    ])
    expect(await h.rows(file, "select seq from everchat_chat")).toEqual([{ seq: 2 }])
  })

  test("addEvent: a transaction that fails after addEvent leaves no row, and seq and updated as they were", async () => {
    const file = h.newFile()
    const failed = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      yield* store.addEvent({ type: "start", turn: turn.id })
      const before = yield* Effect.promise(() => h.rows(file, "select seq, updated from everchat_chat"))
      yield* Effect.sleep("5 millis")
      const error = yield* Effect.flip(store.transaction(Effect.gen(function*() {
        yield* store.addEvent({ type: "end", turn: turn.id })
        yield* store.endTurn(turn.id, "done")
        return yield* Effect.fail("no" as const)
      })))
      return { error, before, after: yield* Effect.promise(() => h.rows(file, "select seq, updated from everchat_chat")), status: Option.map(yield* store.turn(turn.id), (t) => t.status) }
    }))
    expect(failed.error).toBe("no")
    expect(failed.after).toEqual(failed.before)
    expect(failed.after).toEqual([{ seq: 1, updated: expect.any(Number) }])
    expect(failed.status).toEqual(Option.some("running"))
    expect((await eventRows(file)).map((row) => row.n)).toEqual([1])
  })

  // The events, read again
  // ----------------------

  test("eventsAfter: the five types come back with what each reports, in the order of their numbers", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* story(store, 2)
      return { events: yield* store.eventsAfter(0, 1000), messages: yield* store.messages(0, 100) }
    }))
    const [m0, m1, m2, m3, m4, m5] = got.messages
    expect(got.events).toEqual([
      { type: "start", n: 1, turn: 1 },
      { type: "accepted", n: 2, messages: [m0!, m1!] },
      { type: "call", n: 3, turn: 1, call: 1, program: "program 1" },
      { type: "message", n: 4, message: m2! },
      { type: "end", n: 5, turn: 1, status: "done", why: null },
      { type: "start", n: 6, turn: 2 },
      { type: "accepted", n: 7, messages: [m3!, m4!] },
      { type: "call", n: 8, turn: 2, call: 2, program: "program 2" },
      { type: "message", n: 9, message: m5! },
      { type: "end", n: 10, turn: 2, status: "failed", why: "why 2" }
    ])
    expect(got.messages.map((message) => message.text)).toEqual(["one 1", "two 1", "reply 1", "one 2", "two 2", "reply 2"])
  })

  test("eventsAfter: after the last event number gives none, and so does a number past it", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* story(store, 1)
      return { last: yield* store.eventsAfter(4, 1000), at: yield* store.eventsAfter(5, 1000), past: yield* store.eventsAfter(6, 1000) }
    }))
    expect(got.last.map((event) => event.n)).toEqual([5])
    expect(got.at).toEqual([])
    expect(got.past).toEqual([])
  })

  test("eventsAfter: limit cuts at exactly that count, and the next read from the last number continues with no gap and no repeat", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* story(store, 3)
      const whole = yield* store.eventsAfter(0, 1000)
      const parts: Array<Array<number>> = []
      const read: Array<unknown> = []
      let after = 0
      for (;;) {
        const part = yield* store.eventsAfter(after, 4)
        if (part.length === 0) break
        parts.push(part.map((event) => event.n))
        read.push(...part)
        after = part.at(-1)!.n
      }
      return { whole, parts, read, one: yield* store.eventsAfter(7, 1) }
    }))
    expect(got.whole.map((event) => event.n)).toEqual(Array.from({ length: 15 }, (_, k) => k + 1))
    expect(got.parts).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15]])
    expect(got.read).toEqual(got.whole)
    expect(got.one).toEqual([got.whole[7]!])
  })

  test("eventsAfter: an after or a limit out of its range is a defect that names the field, and the edges of each range pass", async () => {
    const file = h.newFile()
    const BAD = [0.5, -1, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY]
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* story(store, 1)
      const defect = (after: number, limit: number) =>
        Effect.map(Effect.exit(store.eventsAfter(after, limit)), (exit) =>
          Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause) ? String(Cause.squash(exit.cause)) : "no defect")
      return {
        after: yield* Effect.forEach(BAD, (after) => defect(after, 10)),
        limit: yield* Effect.forEach([...BAD, 0, 1001], (limit) => defect(0, limit)),
        edges: [
          (yield* store.eventsAfter(0, 1)).length,
          (yield* store.eventsAfter(0, 1000)).length,
          (yield* store.eventsAfter(Number.MAX_SAFE_INTEGER, 1000)).length
        ]
      }
    }))
    expect(got.after).toHaveLength(5)
    expect(got.after.filter((text) => !/^Error: eventsAfter: after must be an integer from 0, and it is /.test(text))).toEqual([])
    expect(got.limit).toHaveLength(7)
    expect(got.limit.filter((text) => !/^Error: eventsAfter: limit must be an integer from 1 to 1000, and it is /.test(text))).toEqual([])
    expect(got.edges).toEqual([1, 5, 0])
  })

  // The key of a message's sender
  // ------------------------------

  test("keyed: a message of three pages with a key gives its pages and its accepted number; the key is on its first row only", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* story(store, 1)
      const accepted = yield* keyedSay(store, ["page one", "page two", "page three"], "key-3-pages")
      yield* keyedSay(store, ["after it"], null)
      return { accepted, keyed: yield* store.keyed("key-3-pages"), pages: yield* store.messages(3, 6) }
    }))
    expect(got.accepted).toBe(6)
    expect(got.keyed).toEqual(Option.some({ messages: got.pages, accepted: 6 }))
    expect(got.pages.map((page) => [page.i, page.text, page.more])).toEqual([[3, "page one", true], [4, "page two", true], [5, "page three", false]])
    expect(await h.rows(file, "select i, sender_key from everchat_msg where i >= 3 order by i")).toEqual([
      { i: 3, sender_key: "key-3-pages" },
      { i: 4, sender_key: null },
      { i: 5, sender_key: null },
      { i: 6, sender_key: null }
    ])
  })

  test("keyed: the same key twice in one chat: the second write fails with StoreError, and the counts of messages and events are as before it", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* keyedSay(store, ["first", "its second page"], "key-twice")
      const before = { count: yield* store.count, seq: (yield* store.chat).seq }
      const error = yield* Effect.flip(keyedSay(store, ["second", "its second page"], "key-twice"))
      const alone = yield* Effect.flip(store.append([{ kind: "user", text: "alone" }], "key-twice"))
      return { before, error, alone, count: yield* store.count, seq: (yield* store.chat).seq, keyed: yield* store.keyed("key-twice") }
    }))
    expect(got.error).toBeInstanceOf(StoreError)
    expect(got.alone).toBeInstanceOf(StoreError)
    expect(got.alone.op).toBe("append")
    expect({ count: got.count, seq: got.seq }).toEqual(got.before)
    expect(await counts(file)).toEqual({ messages: 2, events: 1, seq: 1 })
    expect(Option.map(got.keyed, (one) => [one.messages.map((page) => page.text), one.accepted])).toEqual(Option.some([["first", "its second page"], 1]))
  })

  test("keyed: two keys that differ in letter case are two messages", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* keyedSay(store, ["small"], "key-case")
      yield* keyedSay(store, ["large"], "KEY-CASE")
      yield* keyedSay(store, ["mixed"], "Key-Case")
      return yield* Effect.forEach(["key-case", "KEY-CASE", "Key-Case"], (key) => store.keyed(key))
    }))
    expect(got.map((one) => Option.map(one, (it) => [it.messages[0]!.text, it.accepted]))).toEqual([
      Option.some(["small", 1]),
      Option.some(["large", 2]),
      Option.some(["mixed", 3])
    ])
  })

  test("keyed: a key of 129 bytes, an empty one, one with a space, one with a byte under 0x21 or over 0x7E, and a key with no message are refused, and nothing is written; 1 and 128 bytes from ! to ~ pass", async () => {
    const file = h.newFile()
    const bad = ["k".repeat(129), "", "key one", "key\tone", "key\x7fone", "kéy", "key\u{1F600}", "\x20", "key\none"]
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const refused = yield* Effect.forEach(bad, (key) => Effect.flip(keyedSay(store, ["refused", "page two"], key)))
      const empty = yield* Effect.flip(store.append([], "key-of-nothing"))
      const after = { count: yield* store.count, seq: (yield* store.chat).seq }
      yield* keyedSay(store, ["edges"], "!".repeat(64) + "~".repeat(64))
      yield* keyedSay(store, ["one byte"], "~")
      yield* keyedSay(store, ["the range"], Array.from({ length: 94 }, (_, k) => String.fromCharCode(0x21 + k)).join(""))
      return { refused, empty, after, keys: yield* Effect.forEach(["!".repeat(64) + "~".repeat(64), "~"], (key) => store.keyed(key)) }
    }))
    expect(got.refused.map((error) => [error instanceof StoreError, error.op])).toEqual(bad.map(() => [true, "append"]))
    expect(got.refused.map((error) => String(error.cause))).toEqual(bad.map(() => "Error: the sender's key is not 1 to 128 bytes of visible ASCII"))
    expect([got.empty instanceof StoreError, String(got.empty.cause)]).toEqual([true, "Error: the sender's key has no message"])
    expect(got.after).toEqual({ count: 0, seq: 0 })
    expect(got.keys.map(Option.isSome)).toEqual([true, true])
    expect(await h.rows(file, "select i, length(sender_key) as bytes from everchat_msg order by i")).toEqual([{ i: 0, bytes: 128 }, { i: 1, bytes: 1 }, { i: 2, bytes: 94 }])
  })

  test("keyed: a keyed append after an append that ended with more 1 fails with StoreError and writes nothing; the same append with no key passes, and a key after the message's last page passes", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.append([{ kind: "user", text: "page one", more: true }])
      const before = yield* Effect.promise(() => counts(file))
      const keyed = yield* Effect.flip(keyedSay(store, ["not a start"], "key-continued"))
      const alone = yield* Effect.flip(store.append([{ kind: "user", text: "not a start" }], "key-continued"))
      const after = yield* Effect.promise(() => counts(file))
      const plain = yield* store.append([{ kind: "user", text: "page two" }])
      const later = yield* keyedSay(store, ["a start"], "key-continued")
      return { before, keyed, alone, after, plain, later, found: yield* store.keyed("key-continued") }
    }))
    for (const error of [got.keyed, got.alone]) {
      expect(error).toBeInstanceOf(StoreError)
      expect([(error as StoreError).op, String((error as StoreError).cause)]).toEqual(["append", "Error: the sender's key is not at a message's start"])
    }
    expect(got.before).toEqual({ messages: 1, events: 0, seq: 0 })
    expect(got.after).toEqual(got.before)
    expect(got.plain.map((message) => [message.i, message.text, message.more])).toEqual([[1, "page two", false]])
    expect(got.later).toBe(1)
    expect(Option.map(got.found, (one) => [one.messages.map((page) => [page.i, page.text]), one.accepted])).toEqual(Option.some([[[2, "a start"]], 1]))
    expect(await h.rows(file, "select i, more, sender_key from everchat_msg order by i")).toEqual([
      { i: 0, more: 1, sender_key: null },
      { i: 1, more: 0, sender_key: null },
      { i: 2, more: 0, sender_key: "key-continued" }
    ])
  })

  test("keyed: an event of another type whose msg is the keyed message's first page is not its accepted: keyed gives the accepted number", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const accepted = yield* keyedSay(store, ["the message", "its second page"], "key-typed")
      const other = yield* store.addEvent({ type: "message", msg: 0, msgLast: 1 })
      return { accepted, other, keyed: yield* store.keyed("key-typed") }
    }))
    expect([got.accepted, got.other]).toEqual([1, 2])
    expect(await h.rows(file, "select n, type, msg from everchat_event order by n")).toEqual([{ n: 1, type: "accepted", msg: 0 }, { n: 2, type: "message", msg: 0 }])
    expect(Option.map(got.keyed, (one) => one.accepted)).toEqual(Option.some(1))
  })
}
