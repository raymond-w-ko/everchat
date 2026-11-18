// The command's service of the wake-ups (docs/wakeups.md, sections 7 and
// 9): what `/wakeups` in the terminal does, with no terminal in it. It
// gives values; the terminal (packages/local/src/terminal.ts) makes the
// lines. It is the person's only control over the turns that start with no
// message of theirs.
//
// - `list`: whether the chat's wake-ups are on, and every row, the active
//   rows first, then the stopped ones, each group by id (one read).
// - `stop(id)`: the person's stop of an active row.
// - `off`, `on`: the chat's switch.
//
// A stop, off and on are each the `write` of a `Turns.note` (lead,
// ec-ur3a5, M1): the note and its write are one transaction, under the
// loop's lock, which an offer holds too (section 5). The notes are the
// page's: `stopText(id)`, `OFF_TEXT`, `ON_TEXT`.
//
// Each member reads the state first (lead, ec-kb37y0, 3). Where it is
// already what was asked (an id with no row, a row that is not active, off
// when off, on when on), it writes nothing, logs no note, and says which
// it found. A write that finds its row changed since that read (the
// firer's stop at two failures, an `unwake`, in between) changes nothing,
// and the note stays: accepted (section 7, M1 and M16).
//
// After `on`, when its note committed, the member calls `Turns.ready`, so
// that a fire that waited through the off time is offered at once (lead,
// ec-kb37y0, 4); not after `off`, a stop, or an `on` that was on already.
//
// A `StoreError` of a read, of the note or of `ready` fails the member:
// the terminal writes it as it writes its other commands' faults.

import { Context, DateTime, Effect, Layer, Option } from "effect"
import { wallClock } from "@everchat/core/functions"
import { Store, type StoreError, type Wake, type WakeWhy } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"

// The notes of the person's command (docs/wakeups.md, section 7).
export const stopText = (id: number): string => `Wake-up ${id} stopped by the person.`
export const OFF_TEXT = "The person turned the wake-ups off."
export const ON_TEXT = "The person turned the wake-ups on."

// A row as `list` gives it. `text`, `when` and `zone` are the row's own,
// exact (the terminal makes them visible): `when` is a routine's cron, or
// a reminder's time on its wall clock as `wake` takes it
// (`2026-11-18T09:00`, with `:30` when its seconds are not 0). `next`: the
// fire that waits, else `due`, else none; `last`: the last slot fired; both
// on the row's wall clock (`wallClock`). `missed`: the slots that the
// waiting fire stands for beside its own. `active`: not stopped; `why`:
// why it stopped (null while active).
export interface Row {
  readonly id: number
  readonly text: string
  readonly when: string
  readonly zone: string
  readonly next: string | null
  readonly last: string | null
  readonly missed: number
  readonly active: boolean
  readonly why: WakeWhy | null
}

// What `list` gives: the chat's switch, and the rows in their order.
export interface Listing {
  readonly on: boolean
  readonly rows: ReadonlyArray<Row>
}

// What `stop` did: `stopped` (the note is in the log), or, with no note
// and no write, `none` (no row with that id) or `inactive` (the row has
// stopped already).
export type Stopped = "stopped" | "none" | "inactive"

// What `off` and `on` did: `switched` (the note is in the log), or
// `already` (the switch was so: no note, no write).
export type Switched = "switched" | "already"

// A zone of a row (data) as the engine names it, or UTC when the engine
// does not know it, as `wallClock` reads it.
const named = (zone: string): DateTime.TimeZone.Named => Option.getOrElse(DateTime.zoneMakeNamed(zone), () => DateTime.zoneMakeNamedUnsafe("UTC"))

// A reminder's time on its zone's wall clock, as `wake` takes it.
const whenText = (at: number, zone: string): string => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: named(zone) }))
  const two = (n: number) => String(n).padStart(2, "0")
  const day = `${String(parts.year).padStart(4, "0")}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}`
  return parts.second === 0 ? day : `${day}:${two(parts.second)}`
}

// A row of the store as `list` gives it.
export const rowOf = (wake: Wake): Row => {
  const clock = (at: number | null) => (at === null ? null : wallClock(at, wake.zone))
  return {
    id: wake.id,
    text: wake.text,
    when: wake.cron ?? whenText(wake.at ?? wake.first, wake.zone),
    zone: wake.zone,
    next: clock(wake.pending ?? wake.due),
    last: clock(wake.slot),
    missed: wake.missed,
    active: wake.stopped === null,
    why: wake.why
  }
}

export class Wakeups extends Context.Service<Wakeups, {
  // The switch and every row (`Listing`). It reads only.
  readonly list: Effect.Effect<Listing, StoreError>
  // The person's stop of the active row `id`: the note `stopText(id)` with
  // `stopWake(id, "person")` as its write (`Stopped`).
  stop(id: number): Effect.Effect<Stopped, StoreError>
  // The switch off: the note `OFF_TEXT` with `setWakeups(false)`.
  readonly off: Effect.Effect<Switched, StoreError>
  // The switch on: the note `ON_TEXT` with `setWakeups(true)`, then
  // `Turns.ready`.
  readonly on: Effect.Effect<Switched, StoreError>
}>()("everchat/wakeups/Wakeups") {
  // The service over the chat's store and its turn loop.
  static readonly layer: Layer.Layer<Wakeups, never, Store | Turns> = Layer.effect(
    Wakeups,
    Effect.gen(function*() {
      const store = yield* Store
      const turns = yield* Turns

      const list = Effect.gen(function*() {
        const on = (yield* store.chat).wakeups
        // One read, so that no row is in both groups, or in neither.
        const rows = yield* store.wakes()
        return { on, rows: [...rows.filter((one) => one.stopped === null), ...rows.filter((one) => one.stopped !== null)].map(rowOf) }
      })

      const stop = (id: number) =>
        Effect.gen(function*() {
          // A number that is not a whole one over 0, safe, names no row.
          if (!Number.isSafeInteger(id) || id < 1) return "none" as const
          const found = (yield* store.wakes()).find((one) => one.id === id)
          if (found === undefined) return "none" as const
          if (found.stopped !== null) return "inactive" as const
          yield* turns.note(stopText(id), () => Effect.asVoid(store.stopWake(id, "person")))
          return "stopped" as const
        })

      const turn = (on: boolean) =>
        Effect.gen(function*() {
          if ((yield* store.chat).wakeups === on) return "already" as const
          yield* turns.note(on ? ON_TEXT : OFF_TEXT, () => Effect.asVoid(store.setWakeups(on)))
          // A fire that waited through the off time is offered now.
          if (on) yield* turns.ready
          return "switched" as const
        })

      return Wakeups.of({ list, stop, off: turn(false), on: turn(true) })
    })
  )
}
