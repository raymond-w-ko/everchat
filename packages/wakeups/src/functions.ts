// The functions of the wake-ups (docs/wakeups.md, section 8): `wake`,
// `wakes` and `unwake`, with which the model makes, lists and stops the
// wake-ups of its chat. They are the only way to make a row; the firer and
// the source (firer.ts, source.ts) fire them.
//
// - `declarations`: the three declarations, in the order `wake`, `wakes`,
//   `unwake`, each with a hand-written signature (one object argument for
//   `wake` and `unwake`, none for `wakes`) and no approval.
// - `entries(store, options)`: their entries, in the same order, over the
//   store's service and the config file's zone (`options.zone`). Now is the
//   `Clock`'s.
//
// `wake` takes the zone of its argument, else `options.zone`, else the
// machine's (`machineZone`), and keeps it on the row. `when` and the zone go
// through time.ts (`zone`, `parse`, bounds first). A reminder's first fire
// is its time (`reminderAt`), refused in the past; a routine's is its next
// slot after now (`nextSlot`), refused with none in `HORIZON_YEARS`; time.ts
// refuses a routine more than hourly. The text is 1 to `WAKE_TEXT_MAX`
// characters, checked before the store is asked. The row gets the caller's
// turn and call, and `makeWake` counts the `ACTIVE_MAX` active rows in its
// transaction. The result: the row's id and its first fire on its wall
// clock (`next`), with `off: true` when the chat's wake-ups are off at the
// make: the row is made, and fires only after `/wakeups on`.
//
// `wakes` gives every row, the active rows first, then the stopped rows,
// each group by id, as data for the program: the row's text is exact.
// `unwake` stops an active row with the caller's call (`stopWake(id,
// "unwake", call)`), so that `wakesOf` finds the stop.
//
// Each refusal is a `FunctionError` whose message the model reads: it names
// the field, says what is wrong and gives a right example. A text of the
// model's input that a message repeats goes through the core's `visible`,
// cut to `SHOWN_MAX` characters first. A `StoreError` is no refusal: the call
// fails as the other functions' store faults do (`stored`).
//
// No function writes to the log (the notes of a make and of a stop are the
// turn loop's, at the program's close, from `wakesOf`), reads the config
// file, or needs an approval.

import { Clock, DateTime, Effect, Option, Result } from "effect"
import { type Caller, type Declaration, type Entry, FunctionError, stored, visible, wallClock } from "@everchat/core/functions"
import { type NewWake, Store, type Wake, WAKE_TEXT_MAX, type WakeWhy } from "@everchat/core/store"
import { isPast, machineZone, nextSlot, parse, reminderAt, zone as zoneOf } from "./time.ts"

// The most active wake-ups of a chat: `wake` is refused past it.
export const ACTIVE_MAX = 20

// The most characters of a text of the model's input that a refusal
// repeats.
export const SHOWN_MAX = 200

// The declarations
// ----------------

const WAKE = {
  name: "wake",
  signature: "(args: { when: string; text: string; zone?: string }): Promise<{ id: number; next: string; off?: true }>",
  description: "Sets a wake-up of this chat: at its time a new turn starts with its text. `when` is a reminder, one time: a local date and time with no offset and no zone, to the minute or the second, such as 2026-11-18T09:00 or 2026-11-18 09:00:30; or a routine: the 5 fields of cron (minute, hour, day of the month, month, day of the week), such as 15 9 * * 1-5 (09:15 on each weekday) or 0 * * * * (each hour at :00). A routine fires at most one time in an hour: its minute field is one minute. `zone` is an IANA time zone, such as Europe/Berlin; when not given, the zone of EverChat's config file, else the machine's. `text` is what the wake-up's turn reads, 1 to 2000 characters. At most 20 wake-ups are active at one time: unwake stops one. It gives the wake-up's id and its first time on its zone's clock, with `off: true` when the person has turned this chat's wake-ups off: then none fires until they turn them on."
} as const satisfies Declaration

const WAKES = {
  name: "wakes",
  signature: "(): Promise<Array<{ id: number; text: string; when: string; zone: string; next: string | null; last: string | null; fired: number; missed: number; stopped: string | null; why: \"fired\" | \"unwake\" | \"person\" | \"failed\" | null }>>",
  description: "The wake-ups of this chat: the active ones first, then the stopped ones, each in the order of their ids. Each has its text, `when` and zone as wake took them; `next`, its next fire on its zone's clock, or null; `last`, its last fire, or null; `fired`, the count of its fires; `missed`, the times that its waiting fire stands for beside its own; `stopped`, when it stopped, or null; and `why`: fired (a reminder that fired), unwake, person (the person stopped it) or failed (two of its turns in a row failed)."
} as const satisfies Declaration

const UNWAKE = {
  name: "unwake",
  signature: "(args: { id: number }): Promise<{ id: number; stopped: true }>",
  description: "Stops the active wake-up `id` of this chat (its id from wake or wakes): it fires no more, and a fire that waits is dropped. A turn that it started goes on."
} as const satisfies Declaration

// The declarations of the wake-ups' functions, in the head's order.
export const declarations = [WAKE, WAKES, UNWAKE] as const satisfies ReadonlyArray<Declaration>

// The options of the entries: the config file's zone, or none.
export interface Options {
  readonly zone?: DateTime.TimeZone.Named | undefined
}

// A row of `wakes`.
export interface Listed {
  readonly id: number
  readonly text: string
  readonly when: string
  readonly zone: string
  readonly next: string | null
  readonly last: string | null
  readonly fired: number
  readonly missed: number
  readonly stopped: string | null
  readonly why: WakeWhy | null
}

// The messages
// ------------

const WAKE_EXAMPLE = `wake({ when: "2026-11-18T09:00", text: "Call the bank." })`
const UNWAKE_EXAMPLE = `unwake({ id: 3 })`
const WHEN_HELP = `give a reminder's time, such as "2026-11-18T09:00", or a routine, such as "15 9 * * 1-5"`
const TEXT_HELP = `give what the wake-up's turn reads, a text of 1 to ${WAKE_TEXT_MAX} characters, such as "Call the bank"`
const ZONE_HELP = `give an IANA time zone, such as "Europe/Berlin", or leave it out`
const ID_HELP = `give the id of an active wake-up, such as ${UNWAKE_EXAMPLE}; wakes() lists them`
const ID_AGAIN = `Give the id of an active wake-up, such as ${UNWAKE_EXAMPLE}; wakes() lists them.`

const refuse = (message: string) => Effect.fail(new FunctionError({ message }))

// A text of the model's input as a message repeats it: at most `SHOWN_MAX`
// characters (a cut ends with "…" and parts no pair of surrogates), then
// its escapes (`visible`), between double quotes.
const shown = (text: string): string => {
  if (text.length <= SHOWN_MAX) return `"${visible(text)}"`
  const code = text.charCodeAt(SHOWN_MAX - 1)
  return `"${visible(text.slice(0, code >= 0xd800 && code <= 0xdbff ? SHOWN_MAX - 1 : SHOWN_MAX))}…"`
}

// What a value of the model's input is, in words.
const kindOf = (value: unknown): string =>
  value === null || value === undefined
    ? "null"
    : Array.isArray(value)
    ? "a list"
    : typeof value === "string"
    ? "a text"
    : typeof value === "number"
    ? "a number"
    : typeof value === "boolean"
    ? "a boolean"
    : "an object"

// The arguments
// -------------

// The arguments that the program gave: a trailing null is an argument left
// out (an `undefined` crosses the boundary as null).
const given = (args: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
  let end = args.length
  while (end > 0 && (args[end - 1] === null || args[end - 1] === undefined)) end--
  return args.slice(0, end)
}

// The one object argument of `name`, with no field but `fields`, or its
// refusal.
const objectOf = (name: string, args: ReadonlyArray<unknown>, fields: ReadonlyArray<string>, example: string) =>
  Effect.gen(function*() {
    const list = given(args)
    if (list.length !== 1) {
      return yield* refuse(`${name} takes one argument, an object, and got ${list.length === 0 ? "none" : list.length}: such as ${example}.`)
    }
    const one = list[0]
    if (typeof one !== "object" || one === null || Array.isArray(one)) {
      return yield* refuse(`${name} takes one argument, an object, and got ${kindOf(one)}: such as ${example}.`)
    }
    const unknown = Object.keys(one).find((key) => !fields.includes(key))
    if (unknown !== undefined) {
      const known = fields.length === 1 ? `its one field is ${fields[0]}` : `its fields are ${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`
      return yield* refuse(`${name} has no field ${shown(unknown)}: ${known}, such as ${example}.`)
    }
    return one as Readonly<Record<string, unknown>>
  })

// A field that must be a text: its value, or the refusal that names it.
const textField = (name: string, field: string, value: unknown, help: string) =>
  typeof value === "string"
    ? Effect.succeed(value)
    : refuse(`The field ${field} of ${name} is ${value === undefined ? "missing" : kindOf(value) + ", not a text"}: ${help}.`)

const wakeArgs = Effect.fnUntraced(function*(args: ReadonlyArray<unknown>) {
  const one = yield* objectOf("wake", args, ["when", "text", "zone"], WAKE_EXAMPLE)
  const when = yield* textField("wake", "when", one.when, WHEN_HELP)
  const text = yield* textField("wake", "text", one.text, TEXT_HELP)
  // A zone left out, or given as null, is none.
  const zone = one.zone === undefined || one.zone === null ? undefined : yield* textField("wake", "zone", one.zone, ZONE_HELP)
  return { when, text, zone }
})

const unwakeArgs = Effect.fnUntraced(function*(args: ReadonlyArray<unknown>) {
  const one = yield* objectOf("unwake", args, ["id"], UNWAKE_EXAMPLE)
  const id = one.id
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id
  const what = id === undefined ? "missing" : `${typeof id === "number" ? String(id) : typeof id === "string" ? "the text " + shown(id) : kindOf(id)}, not a whole number over 0`
  return yield* refuse(`The field id of unwake is ${what}: ${ID_HELP}.`)
})

// The texts of a row
// ------------------

// A zone of a row (data) as the engine names it, or UTC when the engine
// does not know it, as `wallClock` reads it.
const named = (zone: string): DateTime.TimeZone.Named => Option.getOrElse(DateTime.zoneMakeNamed(zone), () => DateTime.zoneMakeNamedUnsafe("UTC"))

// A time on a zone's wall clock as a reminder's `when`, as `wake` takes it:
// `2026-11-18T09:00`, with `:30` when its seconds are not 0.
const whenText = (at: number, zone: string): string => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: named(zone) }))
  const two = (n: number) => String(n).padStart(2, "0")
  const day = `${String(parts.year).padStart(4, "0")}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}`
  return parts.second === 0 ? day : `${day}:${two(parts.second)}`
}

// A row as `wakes` gives it: `when`, its routine or its reminder's time;
// `next`, the fire that waits, else `due`; `last`, the last slot fired;
// `stopped`, when it stopped; each time on the row's wall clock.
const listed = (wake: Wake): Listed => {
  const clock = (at: number | null) => (at === null ? null : wallClock(at, wake.zone))
  return {
    id: wake.id,
    text: wake.text,
    when: wake.cron ?? whenText(wake.at ?? wake.first, wake.zone),
    zone: wake.zone,
    next: clock(wake.pending ?? wake.due),
    last: clock(wake.slot),
    fired: wake.fired,
    missed: wake.missed,
    stopped: clock(wake.stopped),
    why: wake.why
  }
}

// The entries
// -----------

// The entries of `declarations`, in its order, over the store's service:
// `options.zone` is the config file's zone.
export const entries = (store: Store["Service"], options: Options = {}): ReadonlyArray<Entry> => {
  const wake = Effect.fnUntraced(function*(args: ReadonlyArray<unknown>, caller: Caller) {
    const asked = yield* wakeArgs(args)
    // The text first: nothing reads a text out of its bounds further.
    const size = asked.text.toWellFormed().length
    if (size === 0) return yield* refuse(`The field text of wake is empty: ${TEXT_HELP}.`)
    if (size > WAKE_TEXT_MAX) {
      return yield* refuse(`The field text of wake has ${size} characters, over the bound of ${WAKE_TEXT_MAX}: give a shorter text, such as "Call the bank".`)
    }
    // The zone: the argument's, else the config file's, else the machine's.
    let zone: DateTime.TimeZone.Named
    if (asked.zone !== undefined) {
      const found = zoneOf(asked.zone)
      if (Result.isFailure(found)) return yield* refuse(`The field zone of wake: ${found.failure.message}`)
      zone = found.success
    } else {
      zone = options.zone ?? machineZone()
    }
    const parsed = parse(asked.when, zone)
    if (Result.isFailure(parsed)) return yield* refuse(`The field when of wake: ${parsed.failure.message}`)
    const when = parsed.success
    const now = yield* Clock.currentTimeMillis
    const name = DateTime.zoneToString(zone)
    const row: { cron?: string; at?: number; first: number } = { first: 0 }
    if (when._tag === "Reminder") {
      const at = reminderAt(when)
      if (isPast(at, now)) {
        return yield* refuse(
          `The field when of wake: ${shown(asked.when)} is in the past: it was ${wallClock(at, name)}, and now is ${wallClock(now, name)}. Give a time to come, such as "${
            whenText(now + 24 * 60 * 60_000 - (now % 60_000), name)
          }".`
        )
      }
      row.at = at
      row.first = at
    } else {
      const slot = nextSlot(when, now)
      if (Result.isFailure(slot)) return yield* refuse(`The field when of wake: ${slot.failure.message}`)
      row.cron = when.text
      row.first = slot.success
    }
    const made = yield* stored(store.makeWake({ text: asked.text, zone: name, turn: caller.turn, call: caller.call, ...row } satisfies NewWake, ACTIVE_MAX))
    if (made._tag === "full") {
      return yield* refuse(`${ACTIVE_MAX} wake-ups are active, the most that a chat may have: stop one with unwake, such as ${UNWAKE_EXAMPLE}, to free a place; wakes() lists them.`)
    }
    const chat = yield* stored(store.chat)
    // The note of the make gives the same time: the row's `first`.
    const next = wallClock(made.wake.first, made.wake.zone)
    return chat.wakeups ? { id: made.wake.id, next } : { id: made.wake.id, next, off: true as const }
  })

  const wakes = Effect.fnUntraced(function*(args: ReadonlyArray<unknown>) {
    const list = given(args)
    if (list.length > 0) return yield* refuse(`wakes takes no argument, and got ${list.length}: call wakes().`)
    // One read, so that no row is in both groups, or in neither.
    const rows = yield* stored(store.wakes())
    return [...rows.filter((one) => one.stopped === null), ...rows.filter((one) => one.stopped !== null)].map(listed)
  })

  const unwake = Effect.fnUntraced(function*(args: ReadonlyArray<unknown>, caller: Caller) {
    const id = yield* unwakeArgs(args)
    // A whole number past the safe ones names no row.
    if (Number.isSafeInteger(id) && (yield* stored(store.stopWake(id, "unwake", caller.call)))) return { id, stopped: true as const }
    const found = Number.isSafeInteger(id) ? (yield* stored(store.wakes())).find((one) => one.id === id) : undefined
    if (found === undefined) return yield* refuse(`The field id of unwake: this chat has no wake-up ${id}. ${ID_AGAIN}`)
    return yield* refuse(
      `The field id of unwake: wake-up ${id} has stopped already${found.why === null ? "" : ` (why: ${found.why})`}. ${ID_AGAIN}`
    )
  })

  return [
    { declaration: WAKE, run: wake },
    { declaration: WAKES, run: (args) => wakes(args) },
    { declaration: UNWAKE, run: unwake }
  ]
}
