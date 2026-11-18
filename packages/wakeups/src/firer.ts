// The firer of the wake-ups (docs/wakeups.md, section 5): one fiber above
// `Turns`, in the terminal only, that writes each due row's waiting fire
// (`pendWake`) and asks the turn loop (`Turns.ready`) at each round. The
// source (source.ts) gives the waiting fires to the loop; the firer starts
// no turn and logs no message itself.
//
// A round, in its one fiber:
//
// 1. The settle (section 7), with no read of the switch: off stops fires,
//    not the count. It reads `unsettledWakes()`, and counts the end of each
//    row's last turn that has ended (`settleWake`, by `endOf`); a turn that
//    has not ended (its end not yet written, a lost end too) is left for a
//    later round. When the end counts as failed and the row that it read is
//    active with `WAKE_FAILURES - 1` failures, the settle is the `write` of
//    a note (`Turns.note`, `stoppedText`): the row's stop and its note are
//    one transaction. A row read as stopped already is settled with no note.
// 2. It reads the chat's `wakeups`: while off it pends nothing.
// 3. It reads `dueWakes(now)`. For each row, time (time.ts) gives the
//    newest slot at or before now, the count of the slots before it and
//    the next slot, each walked from the row's `due`, never found from
//    now: a clock that moves back fires nothing twice. A reminder gives
//    its time, no count and no next. Each goes to `pendWake`.
// 4. It calls `Turns.ready`, at each round, on or off, with new rows or
//    none: a fire that waits past the budget, after a fault or from before
//    a start is asked for again within `SLEEP`.
//
// Then it sleeps until the next `due` of an active row, and `SLEEP` (60 s)
// when that is later or there is none. The first round runs at once. An
// `end` event of the turn loop (`Turns.subscribe`, made at the layer's
// build) only ends the sleep sooner: a listener fiber tells the firer's
// fiber, and the settles run in that one fiber, in its round, one at a
// time. An event that the hub dropped, an end that came while the round
// ran, and an end from before the listener are the next round's.
//
// A round that fails does not end the firer (lead, ec-hvsq7, M15): a
// failure of a member, of a settle's note or of `Turns.ready` is one
// diagnostic (the source
// `wakeups`), and the next round runs after the sleep. A row whose `cron`
// or zone no longer parses (a row is data) is a diagnostic for that row,
// one time in a launch (the row stays due, and each round reads it), and
// the round's other rows are still written. The fiber ends with the
// layer's scope, and never on a `StoreError`.

import { Clock, Effect, Layer, Option, PubSub, Queue, Result } from "effect"
import { Store, type UnsettledWake, type Wake, type WakeEnd, WAKE_FAILURES, type WakePend } from "@everchat/core/store"
import { CEILING, Turns } from "@everchat/core/turn"
import { missedOf, parse, zone } from "./time.ts"

// This module's diagnostics name the wake-ups as their source
// (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "wakeups")

// The longest sleep between two rounds, in milliseconds: a fire is up to
// this late, plus the turns that run before it (docs/wakeups.md, section 6).
export const SLEEP = 60_000

// What the firer writes for a due row at `now` (`pendWake`): a reminder's
// time, with no count and no next slot; a routine's newest slot at or
// before now, the count of its slots before it from `due` on, and its next
// slot (`missedOf`, walked from `due`). Null when nothing is due (`due`
// after now, or none). A row whose `cron` or zone does not parse gives the
// error's message: a row is data, and its fault is the row's.
export const pendOf = (wake: Wake, now: number): Result.Result<WakePend | null, string> => {
  if (wake.due === null || wake.due > now) return Result.succeed(null)
  if (wake.at !== null) return Result.succeed({ pending: wake.at, missed: 0, due: null })
  const named = zone(wake.zone)
  if (Result.isFailure(named)) return Result.fail(named.failure.message)
  const when = parse(wake.cron ?? "", named.success)
  if (Result.isFailure(when)) return Result.fail(when.failure.message)
  if (when.success._tag !== "Routine") return Result.fail(`its cron is a reminder's time, not a routine`)
  const found = missedOf(when.success, wake.due, now)
  if (Option.isNone(found)) return Result.succeed(null)
  return Result.succeed({ pending: found.value.slot, missed: found.value.missed, due: found.value.next ?? null })
}

// How the settle counts the end of a wake turn (docs/wakeups.md, section
// 7): `done` is done; `failed`, and `stopped` with the core's why
// `CEILING`, are failed; `stopped` with another why (the person: Esc,
// `/stop`) is kept. Null for a turn that has not ended (`running`): its row
// waits for a later round.
export const endOf = (status: UnsettledWake["status"], why: string | null): WakeEnd | null =>
  status === "done" ? "done" : status === "failed" ? "failed" : status === "stopped" ? (why === CEILING ? "failed" : "kept") : null

// The note of a row that the settle stops, at its `WAKE_FAILURES`-th
// failed end in a row.
export const stoppedText = (id: number): string => `Wake-up ${id} stopped: two of its turns in a row failed or reached the ceiling.`

// Step 1 of a round (the head comment): each row whose last turn has
// ended, in the order of their ids, one at a time. The note's path is
// chosen from the row as read here; `settleWake` changes nothing for a row
// that changed since, and the note then stays (accepted: section 7, M1 and
// M16).
const settle = (store: Store["Service"], turns: Turns["Service"]): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    for (const { wake, status, why } of yield* store.unsettledWakes()) {
      const end = endOf(status, why)
      const turn = wake.lastTurn
      if (end === null || turn === null) continue
      const write = Effect.asVoid(store.settleWake(wake.id, turn, end))
      if (end === "failed" && wake.stopped === null && wake.failed === WAKE_FAILURES - 1) {
        yield* turns.note(stoppedText(wake.id), () => write)
      } else {
        yield* write
      }
    }
  })

// One round (the head comment): it gives how long to sleep after it.
// `told`: the rows whose fault this launch has logged.
const round = (store: Store["Service"], turns: Turns["Service"], told: Set<number>): Effect.Effect<number, unknown> =>
  Effect.gen(function*() {
    // 1. The settle, before the switch is read.
    yield* settle(store, turns)
    // 2 and 3. The due rows, while on.
    if ((yield* store.chat).wakeups) {
      const now = yield* Clock.currentTimeMillis
      for (const wake of yield* store.dueWakes(now)) {
        const pend = pendOf(wake, now)
        if (Result.isFailure(pend)) {
          if (told.has(wake.id)) continue
          told.add(wake.id)
          yield* diagnostic(Effect.logError(`wake-up ${wake.id} was not pended: ${pend.failure}`))
        } else if (pend.success !== null) {
          yield* store.pendWake(wake.id, pend.success)
        }
      }
    }
    // 4. The turn loop, at each round.
    yield* turns.ready
    // The sleep: to the next `due` of an active row, at most `SLEEP`. A row
    // still due (its fault, or a write that changed nothing) waits for the
    // next round, as with none.
    const now = yield* Clock.currentTimeMillis
    let sleep = SLEEP
    for (const wake of yield* store.wakes({ active: true })) {
      if (wake.due !== null && wake.due > now) sleep = Math.min(sleep, wake.due - now)
    }
    return sleep
  })

// The firer: a layer that forks its listener and its one fiber in its
// scope. Its first round runs at once; each round that fails is one
// diagnostic, and the next round runs after `SLEEP`, or at an `end` event.
export const firer: Layer.Layer<never, never, Store | Turns> = Layer.effectDiscard(
  Effect.gen(function*() {
    const store = yield* Store
    const turns = yield* Turns
    const told = new Set<number>()
    // The listener: subscribed before the first round, it tells the
    // firer's fiber of each `end`, and settles nothing itself. Ends that
    // come while the firer runs a round are one wake, after that round.
    const woken = yield* Queue.sliding<void>(1)
    const events = yield* turns.subscribe
    yield* Effect.forkScoped(Effect.forever(Effect.flatMap(PubSub.take(events), (event) => (event.type === "end" ? Queue.offer(woken, undefined) : Effect.void))))
    const once = round(store, turns, told).pipe(
      Effect.catchCause((cause) => Effect.as(diagnostic(Effect.logError("a round of the wake-ups failed: the next round tries again", cause)), SLEEP))
    )
    const rest = (ms: number) => Effect.asVoid(Effect.raceFirst(Effect.sleep(ms), Queue.take(woken)))
    yield* Effect.forkScoped(Effect.forever(Effect.flatMap(once, rest)))
  })
)
