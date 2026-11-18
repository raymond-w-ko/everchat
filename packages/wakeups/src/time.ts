// Time
// ====
// The check of a zone, the parse of a wake-up's `when`, and when a wake-up
// is due: the wake-ups by time (plan ec-e75r; docs/design.md, "Wake-ups by
// time"). A wake-up is a reminder (one time) or a routine (a time that
// comes again), and each is read on the wall clock of one zone.
//
// - A zone is an IANA name (`Europe/Berlin`, `UTC`): `zone` takes a text that
//   has the form of one and that the engine's `Intl` knows
//   (`DateTime.zoneMakeNamed`). An offset (`+01:00`) is no IANA name and is
//   refused, though `Intl` takes it: a routine's slots must follow the
//   zone's changes of time. `machineZone` is the machine's own zone.
// - A routine is the 5 fields of cron (minute, hour, day of the month,
//   month, day of the week), read by `effect`'s `Cron` in the zone. It may
//   fire at most one time in an hour, so its minute field is exactly one
//   value: `0 * * * *` and `15 9 * * 1-5` are taken; `*/30 * * * *`,
//   `0,30 9 * * *` and `* 9 * * *` (every minute) are refused. A seconds
//   field (6 fields) is refused: a routine fires on a minute.
// - A reminder is a local date and time with no offset and no zone, to the
//   minute or to the second (`2026-11-18T09:00`, `2026-11-18 09:00:30`),
//   read on the zone's wall clock. `parse` keeps its wall time's parts.
//
// When (the second part, "When it is due" below), each time is an instant
// in milliseconds:
//
// - A reminder's time (`reminderAt`) is its wall time in its zone. A wall
//   time that the zone skips (the hour of a change to summer time) moves
//   forward by the gap, as `effect`'s `compatible` rule does: 02:30 on
//   2026-03-29 in `Europe/Berlin` is 03:30. One that the zone repeats is the
//   earlier of the two. `isPast` tells a time before a given now: the caller
//   refuses a reminder in the past.
// - A routine's next slot (`nextSlot`) after a given time, in its zone
//   (`Cron.next`). A routine with no slot in the 5 years after it
//   (`HORIZON_YEARS`) is refused there, with a `WhenError`: a date that
//   never comes (`0 0 30 2 *`), which `Cron` takes. The 5 years are the
//   make's test only: `missedOf` has no horizon.
// - The missed slots (`missedOf`) of a routine whose `due` slot is at or
//   before now: the newest slot at or before now, the count of the slots
//   from `due` that it stands for beside itself, and the next slot after
//   now. The count stops at `MISSED_MAX` and then says "or more": a row
//   that slept for years costs at most that many steps. The walk and the
//   next slot have no horizon: the next is the first after now, however
//   far (`0 0 29 2 *` skips 2100, so after 2096 comes 2104). The slots are
//   walked from `due`, never found from now's time: with a now before
//   `due` (a clock set back after a fire, whose `due` is then the slot
//   after the one fired), nothing is due, so a slot is never fired twice.
// - The text of a slot (`slotText`) on the zone's wall clock,
//   `2026-11-16 09:00 Europe/Berlin`, and how late a fire is in words
//   (`lateText`: `3 min late`, `2 h late`, `4 d late`; nothing under one
//   minute), and the missed count's words (`missedText`).
//
// Each refusal is a typed error whose message says what was wrong and gives
// one right example: the model reads it, and writes the call again.
//
// The bounds and the escapes: a `when` longer than `WHEN_MAX` (200) units of
// UTF-16 and a zone's name longer than `ZONE_MAX` (100) are refused before
// anything else reads them (no trim, no regular expression, no `Cron`, no
// `Intl`), with a message that gives the length, the bound and the example,
// and no part of the text. Within the bound, each part of a message that
// came from outside (the given text, a minute field, `Cron`'s reason) goes
// through the core's `visible`, between double quotes: a code point that
// can hide a part, turn it or move the cursor is shown as its escape
// (`\x1b`, `\u{202e}`), for the model and the screen. The errors' fields
// keep the text as it came (over the bound, its first units), not escaped.
//
// Nothing here reads a clock, a store or the config: pure functions over
// their arguments (but `machineZone`, which reads the machine's zone). A
// caller gives now.

import { visible, wallClock } from "@everchat/core/functions"
import { Cron, DateTime, Option, Result, Schema } from "effect"

// Errors
// ------

// A zone that is no IANA name, or that the engine does not know: `zone` is
// the text as it came, or over `ZONE_MAX` its first `ZONE_MAX` units (one
// less when the last is a high surrogate: no pair is parted). The field is
// not escaped: only the message is.
export class ZoneError extends Schema.TaggedError<ZoneError>()("ZoneError", {
  zone: Schema.String,
  message: Schema.String
}) {}

// A `when` that is neither a reminder's time nor a routine: `when` is the
// text as it came, or over `WHEN_MAX` its first `WHEN_MAX` units (one less
// when the last is a high surrogate: no pair is parted). The field is not
// escaped: only the message is.
export class WhenError extends Schema.TaggedError<WhenError>()("WhenError", {
  when: Schema.String,
  message: Schema.String
}) {}

// The examples that the messages give.
export const ZONE_EXAMPLE = "Europe/Berlin"
export const REMINDER_EXAMPLE = "2026-11-18T09:00"
export const ROUTINE_EXAMPLE = "15 9 * * 1-5"

// The longest zone's name and `when`, in UTF-16 units (`.length`) of the
// text as it came: a longer one is refused before anything reads it.
export const ZONE_MAX = 100
export const WHEN_MAX = 200

// The first `max` units of a text, with no pair of surrogates parted: one
// unit less when the last one is a high surrogate.
const head = (text: string, max: number): string => {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

// A text from outside as a message shows it: its escapes (`visible`),
// between double quotes. A `"` or a `\` of the text stays as it is.
const quoted = (text: string): string => `"${visible(text)}"`

// Zones
// -----

// The form of an IANA name: parts of letters, digits, `_`, `-` and `+`,
// with `/` between them, the first part from a letter (`America/New_York`,
// `Etc/GMT+5`, `UTC`). An offset (`+01:00`) has another form.
const IANA = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/

// The zone of an IANA name, as the engine names it (`america/new_york` is
// `America/New_York`), or the error that names the text. A name over
// `ZONE_MAX` is refused first, and its message holds no part of it.
export const zone = (name: string): Result.Result<DateTime.TimeZone.Named, ZoneError> => {
  if (name.length > ZONE_MAX) {
    return Result.fail(
      new ZoneError({
        zone: head(name, ZONE_MAX),
        message: `A time zone's name of ${name.length} characters is over the bound of ${ZONE_MAX}: give an IANA name, such as ${ZONE_EXAMPLE}.`
      })
    )
  }
  const found = IANA.test(name) ? DateTime.zoneMakeNamed(name) : Option.none()
  return Option.isSome(found)
    ? Result.succeed(found.value)
    : Result.fail(new ZoneError({ zone: name, message: `${quoted(name)} is not a time zone: give an IANA name, such as ${ZONE_EXAMPLE}.` }))
}

// The machine's own zone (the engine's `Intl`).
export const machineZone = (): DateTime.TimeZone.Named => DateTime.zoneMakeLocal()

// When
// ----

// A reminder's wall time, on its zone's clock: month 1 to 12, seconds 0
// when the text gave none.
export interface Wall {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
}

// A `when`, parsed in its zone: a routine with its `Cron`, or a reminder
// with its wall time. `text` is the `when` without the spaces at its ends.
export type When =
  | { readonly _tag: "Routine"; readonly text: string; readonly zone: DateTime.TimeZone.Named; readonly cron: Cron.Cron }
  | { readonly _tag: "Reminder"; readonly text: string; readonly zone: DateTime.TimeZone.Named; readonly wall: Wall }

const REMINDER = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

// A text that begins as a date: it is meant as a reminder.
const DATED = /^\d{4}-\d/

const reminderHelp = `A reminder's time is a local date and time with no offset and no zone, to the minute or the second, such as ${REMINDER_EXAMPLE}.`
const routineHelp = `A routine is the 5 fields of cron (minute, hour, day of the month, month, day of the week), such as ${ROUTINE_EXAMPLE}.`

// The days of a month of a year (month 1 to 12).
const leap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const daysOf = (year: number, month: number): number => month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31

const reminder = (when: string, text: string, zone: DateTime.TimeZone.Named): Result.Result<When, WhenError> => {
  const fail = (what: string) => Result.fail(new WhenError({ when, message: `${quoted(when)} is ${what}. ${reminderHelp}` }))
  const found = REMINDER.exec(text)
  if (found === null) {
    // An offset or a zone at the end: `Z`, `+01:00`, `[Europe/Berlin]`. The
    // bracket reads from the last `[` (on the last line) to the end, never
    // past another `[`, so the test is linear on any text: the same texts as
    // `\[.*\]$`, without its quadratic time on many `[`.
    return /(?:Z|[+-]\d{2}(?::?\d{2})?|\[[^[\n\r\u2028\u2029]*\])$/.test(text) && /[T ]\d{2}:\d{2}/.test(text)
      ? fail("a time with an offset or a zone: the reminder's zone gives it")
      : fail("not a date and a time of that form")
  }
  const [year, month, day, hours, minutes, seconds] = found.slice(1).map((part) => (part === undefined ? 0 : Number(part))) as [number, number, number, number, number, number]
  if (month < 1 || month > 12) return fail(`no date: there is no month ${month}`)
  if (day < 1 || day > daysOf(year, month)) return fail(`no date: the month ${month} of ${year} has no day ${day}`)
  if (hours > 23 || minutes > 59 || seconds > 59) return fail("no time of a day: the hours are 00 to 23, the minutes and the seconds 00 to 59")
  return Result.succeed({ _tag: "Reminder", text, zone, wall: { year, month, day, hours, minutes, seconds } })
}

const routine = (when: string, text: string, zone: DateTime.TimeZone.Named): Result.Result<When, WhenError> => {
  const fail = (what: string) => Result.fail(new WhenError({ when, message: `${quoted(when)} is ${what}. ${routineHelp}` }))
  const fields = text.split(/\s+/).filter((one) => one !== "")
  if (fields.length === 6) return fail("6 fields: a routine has no seconds field, and fires on a minute")
  if (fields.length !== 5) return fail(`${fields.length} field${fields.length === 1 ? "" : "s"}, neither a reminder's time nor a routine`)
  const parsed = Cron.parse(fields.join(" "), zone)
  // Cron's reason may name a part of the fields: it is escaped too.
  if (Result.isFailure(parsed)) return fail(`no routine: ${visible(parsed.failure.message.replace(/\.$/, ""))}`)
  const cron = parsed.success
  // A wildcard field is an empty set: every minute.
  if (cron.minutes.size !== 1) {
    return fail(`a routine that can fire more than one time in an hour: its minute field ${quoted(fields[0]!)} must be one minute, such as 0 (each hour at :00) or 15`)
  }
  return Result.succeed({ _tag: "Routine", text, zone, cron })
}

// `when` in `zone`: a reminder's time (a text that begins as a date) or a
// routine's 5 fields, or the error that says what was wrong. A `when` over
// `WHEN_MAX` is refused first, and its message holds no part of it.
export const parse = (when: string, zone: DateTime.TimeZone.Named): Result.Result<When, WhenError> => {
  if (when.length > WHEN_MAX) {
    return Result.fail(
      new WhenError({
        when: head(when, WHEN_MAX),
        message: `A when of ${when.length} characters is over the bound of ${WHEN_MAX}. ${reminderHelp} ${routineHelp}`
      })
    )
  }
  const text = when.trim()
  return DATED.test(text) ? reminder(when, text, zone) : routine(when, text, zone)
}

// When it is due
// --------------

// The years after a time in which a routine must have a slot.
export const HORIZON_YEARS = 5

// The most missed slots that `missedOf` counts one by one.
export const MISSED_MAX = 1_000

// A reminder, and a routine, as `parse` gives them.
export type Reminder = Extract<When, { readonly _tag: "Reminder" }>
export type Routine = Extract<When, { readonly _tag: "Routine" }>

// A reminder's time: its wall time in its zone, in milliseconds. A time that
// the zone skips moves forward by the gap; one that it repeats is the
// earlier (`compatible`).
export const reminderAt = (reminder: Reminder): number => {
  const { year, month, day, hours, minutes, seconds } = reminder.wall
  const at = DateTime.makeZoned({ year, month, day, hour: hours, minute: minutes, second: seconds, millisecond: 0 }, {
    timeZone: reminder.zone,
    adjustForTimeZone: true,
    disambiguation: "compatible"
  })
  // `compatible` gives a time for every wall time of a real date.
  if (Option.isNone(at)) throw new Error(`no time for ${reminder.text} in ${DateTime.zoneToString(reminder.zone)}`)
  return DateTime.toEpochMillis(at.value)
}

// Whether `at` is before `now`.
export const isPast = (at: number, now: number): boolean => at < now

// The time `HORIZON_YEARS` after `at`.
const horizon = (at: number): number => {
  const date = new Date(at)
  date.setUTCFullYear(date.getUTCFullYear() + HORIZON_YEARS)
  return date.getTime()
}

// `Cron.next` from `after`: a slot after it, however far, or undefined when
// `Cron.next` finds none at all (it throws). From a slot, it is the slot
// after it: a walk of these steps gives the routine's slots (`missedOf`).
// From a time inside the gap of a change of time (after the clock's jump,
// before the slot that the jump moved), it skips that moved slot:
// `nextWithin` finds the next slot by a walk from the slot before.
const nextOf = (routine: Routine, after: number): number | undefined => {
  try {
    return Cron.next(routine.cron, new Date(after)).getTime()
  } catch {
    return undefined
  }
}

// The routine's newest slot before `before`, or undefined when `Cron.prev`
// finds none (it throws).
const prevOf = (routine: Routine, before: number): number | undefined => {
  try {
    return Cron.prev(routine.cron, new Date(before)).getTime()
  } catch {
    return undefined
  }
}

// The routine's first slot after `after`, or undefined with none in the
// `HORIZON_YEARS` after it: the make's test (`nextSlot`), and no other. The
// slot is the walk's (`nextOf`): from the newest slot at or before `after`
// (`prevOf(after + 1)`), steps of `nextOf`, 3 at most, to the first slot
// after `after`. So a skipped 02:30 fires at 03:30 from every time asked, a
// time inside the gap too, where `Cron.next` from that time alone gives
// the next day's slot. With no slot at all (`Cron.next` throws) nothing
// more is read; with no slot before, or none after `after` in the 3 steps,
// the slot is `Cron.next`'s from `after`.
const nextWithin = (routine: Routine, after: number): number | undefined => {
  const first = nextOf(routine, after)
  if (first === undefined) return undefined
  let next = first
  let slot = prevOf(routine, after + 1)
  for (let step = 0; slot !== undefined && step < 3; step++) {
    slot = nextOf(routine, slot)
    if (slot !== undefined && slot > after) {
      next = slot
      break
    }
  }
  return next <= horizon(after) ? next : undefined
}

// The routine's first slot after `after`, or a `WhenError` when it has none
// in the `HORIZON_YEARS` after it. The slot is the walk's from the slot
// before (`nextWithin`).
export const nextSlot = (routine: Routine, after: number): Result.Result<number, WhenError> => {
  const next = nextWithin(routine, after)
  return next !== undefined
    ? Result.succeed(next)
    : Result.fail(
      new WhenError({
        when: routine.text,
        message: `${quoted(routine.text)} is a routine with no time in the ${HORIZON_YEARS} years after ${slotText(after, routine.zone)}: it names a date that never comes, such as 30 February. ${routineHelp}`
      })
    )
}

// What a routine missed: `slot` is the newest slot at or before now, the
// one to fire; `missed` the slots from `due` before it (exact, or with
// `more` at least that many); `next` the first slot after now, however far
// (no `HORIZON_YEARS` here: that is the make's test), undefined only when
// `Cron.next` finds no date at all.
export interface Missed {
  readonly slot: number
  readonly missed: number
  readonly more: boolean
  readonly next: number | undefined
}

// The missed slots of a routine whose `due` slot is at or before `now`, or
// none when `due` is after `now`. The slots are walked from `due` with
// `Cron.next` itself, with no horizon (a row was taken with it, and its
// slots may be years apart: `0 0 29 2 *` skips 2100), one by one up to
// `MISSED_MAX`, so the slot found is never before `due`; past the bound,
// one `Cron.prev` and one `Cron.next`: the newest slot at or before now is
// `Cron.prev`'s, and not before the walk's last.
export const missedOf = (routine: Routine, due: number, now: number): Option.Option<Missed> => {
  if (due > now) return Option.none()
  let slot = due
  let missed = 0
  while (true) {
    const after = nextOf(routine, slot)
    if (after === undefined || after > now) return Option.some({ slot, missed, more: false, next: after })
    if (missed === MISSED_MAX) break
    missed++
    slot = after
  }
  // Past the bound: the newest slot at or before now (`Cron.prev` is the
  // slot before the time it is given).
  const newest = Math.max(slot, prevOf(routine, now + 1) ?? slot)
  return Option.some({ slot: newest, missed, more: true, next: nextOf(routine, newest) })
}

// A slot on the zone's wall clock, to the minute, with the zone's name:
// `2026-11-16 09:00 Europe/Berlin`. A time that the zone repeats has one
// text for its two instants.
export const slotText = (at: number, zone: DateTime.TimeZone.Named): string => wallClock(at, DateTime.zoneToString(zone))

// How late a fire at `now` is for its `slot`, in words, or undefined under
// one minute: whole minutes under an hour, whole hours under two days, then
// whole days.
export const lateText = (slot: number, now: number): string | undefined => {
  const minutes = Math.floor((now - slot) / 60_000)
  if (minutes < 1) return undefined
  if (minutes < 60) return `${minutes} min late`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h late` : `${Math.floor(hours / 24)} d late`
}

// The missed count in words, or undefined with none: `2 missed`, or at the
// bound `1000 or more missed`.
export const missedText = (missed: Missed): string | undefined =>
  missed.missed === 0 ? undefined : `${missed.missed}${missed.more ? " or more" : ""} missed`
