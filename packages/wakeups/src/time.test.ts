// Tests of the check of a zone and the parse of a wake-up's `when`
// (time.ts): each form taken and each refused, with the error's message.
// Then when a wake-up is due: a reminder's time, a routine's next slot, the
// missed slots, and their words. Each case gives its zone and its now: none
// reads the machine's zone or today's date. The bounds of a `when` and of a
// zone's name, the escapes of the messages, and the comparison of
// `missedOf` with a plain walk of `Cron.next`.

import { expect, test } from "bun:test"
import { visible } from "@everchat/core/functions"
import { Cron, DateTime, Option, Result } from "effect"
import {
  HORIZON_YEARS,
  isPast,
  lateText,
  machineZone,
  type Missed,
  MISSED_MAX,
  missedOf,
  missedText,
  nextSlot,
  parse,
  type Reminder,
  REMINDER_EXAMPLE,
  reminderAt,
  type Routine,
  ROUTINE_EXAMPLE,
  slotText,
  type When,
  WHEN_MAX,
  WhenError,
  zone,
  ZONE_EXAMPLE,
  ZONE_MAX,
  ZoneError
} from "./time.ts"

const BERLIN = Result.getOrThrow(zone("Europe/Berlin"))

// The error of a refused `when`, or "it was taken".
const refused = (when: string): unknown => {
  const got = parse(when, BERLIN)
  return Result.isFailure(got) ? got.failure : "it was taken"
}

// A taken `when`, or the test fails with the message.
const taken = (when: string): When => {
  const got = parse(when, BERLIN)
  if (Result.isFailure(got)) throw new Error(got.failure.message)
  return got.success
}

// A text from outside as a message shows it: between double quotes, with
// the core's escapes.
const shown = (text: string): string => `"${visible(text)}"`

const REMINDER_HELP = `A reminder's time is a local date and time with no offset and no zone, to the minute or the second, such as ${REMINDER_EXAMPLE}.`
const ROUTINE_HELP = `A routine is the 5 fields of cron (minute, hour, day of the month, month, day of the week), such as ${ROUTINE_EXAMPLE}.`

test("zone takes an IANA name that the engine knows, as the engine names it: Europe/Berlin, UTC, Etc/GMT+5, america/new_york as America/New_York", () => {
  for (const [name, named] of [["Europe/Berlin", "Europe/Berlin"], ["UTC", "UTC"], ["Etc/GMT+5", "Etc/GMT+5"], ["america/new_york", "America/New_York"]] as const) {
    const got = zone(name)
    expect([name, Result.isSuccess(got) && DateTime.isTimeZoneNamed(got.success) ? DateTime.zoneToString(got.success) : "refused"]).toEqual([name, named])
  }
})

test("zone refuses a text that is no IANA name, with a ZoneError that names it and gives an example: an offset (which Intl takes), an unknown name, spaces, a path, the empty text", () => {
  for (const name of ["+01:00", "-05:00", "+0100", "Mars/Olympus", " Europe/Berlin", "Europe/Berlin\n", "Europe/../UTC", "local", ""]) {
    const got = zone(name)
    expect(Result.isFailure(got)).toBe(true)
    const error = Result.isFailure(got) ? got.failure : null
    expect(error).toBeInstanceOf(ZoneError)
    expect([error?.zone, error?.message]).toEqual([name, `${shown(name)} is not a time zone: give an IANA name, such as ${ZONE_EXAMPLE}.`])
  }
  // Intl takes an offset as a zone: the form's test is what refuses it.
  expect(DateTime.zoneMakeNamed("+01:00")._tag).toBe("Some")
})

test("machineZone is the machine's own zone, a named one", () => {
  const got = machineZone()
  expect(DateTime.isTimeZoneNamed(got)).toBe(true)
  expect(DateTime.zoneToString(got)).toBe(DateTime.zoneToString(DateTime.zoneMakeLocal()))
})

test("a routine of 5 fields whose minute is one value is taken, with its Cron in the zone: 0 * * * *, 15 9 * * 1-5, 0 9 * * MON-FRI with spaces at its ends; the next slot is on the zone's clock", () => {
  for (const [when, minutes, hours] of [["0 * * * *", [0], []], ["15 9 * * 1-5", [15], [9]], ["  0 9 * * MON-FRI ", [0], [9]], ["5-5 */2 * * *", [5], [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]]] as const) {
    const got = taken(when)
    expect(got._tag).toBe("Routine")
    if (got._tag !== "Routine") continue
    expect([when, got.text, [...got.cron.minutes], [...got.cron.seconds], [...got.cron.hours]]).toEqual([when, when.trim(), [...minutes], [0], [...hours]])
    expect(got.zone).toBe(BERLIN)
  }
  // 09:15 in Berlin is 08:15 UTC in November: the slot after Monday 2026-11-16 07:30 UTC.
  const weekdays = taken("15 9 * * 1-5")
  expect(weekdays._tag === "Routine" ? Cron.next(weekdays.cron, new Date("2026-11-16T07:30:00Z")).toISOString() : "").toBe("2026-11-16T08:15:00.000Z")
})

test("a routine that can fire more than one time in an hour is refused, with the minute field in the message: */30 * * * *, 0,30 9 * * *, * 9 * * * (every minute), 0-1 9 * * *", () => {
  for (const when of ["*/30 * * * *", "0,30 9 * * *", "* 9 * * *", "0-1 9 * * *"]) {
    const field = when.split(" ")[0]
    expect(refused(when)).toEqual(new WhenError({
      when,
      message: `${shown(when)} is a routine that can fire more than one time in an hour: its minute field ${shown(field!)} must be one minute, such as 0 (each hour at :00) or 15. ${ROUTINE_HELP}`
    }))
  }
})

test("a routine with a seconds field (6 fields) is refused, though Cron takes it: 0 0 9 * * *, 30 15 9 * * 1-5", () => {
  for (const when of ["0 0 9 * * *", "30 15 9 * * 1-5"]) {
    expect(Result.isSuccess(Cron.parse(when, BERLIN))).toBe(true)
    expect(refused(when)).toEqual(new WhenError({ when, message: `${shown(when)} is 6 fields: a routine has no seconds field, and fires on a minute. ${ROUTINE_HELP}` }))
  }
})

test("a text that is no routine and no reminder's time is refused, with the count of its fields or Cron's reason: 61 9 * * *, 0 9 * *, every day at nine, tomorrow, the empty text, seven fields", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["61 9 * * *", "no routine: Expected a value between 0 and 59"],
    ["0 25 * * *", "no routine: Expected a value between 0 and 23"],
    ["0 9 * * funday", "no routine: Expected a positive integer"],
    ["0 9 * *", "4 fields, neither a reminder's time nor a routine"],
    ["every day at nine", "4 fields, neither a reminder's time nor a routine"],
    ["tomorrow", "1 field, neither a reminder's time nor a routine"],
    ["", "0 fields, neither a reminder's time nor a routine"],
    ["0 9 * * * * *", "7 fields, neither a reminder's time nor a routine"]
  ]
  for (const [when, what] of cases) {
    const got = refused(when)
    expect(got).toBeInstanceOf(WhenError)
    expect([when, (got as WhenError).message]).toEqual([when, `${shown(when)} is ${what}. ${ROUTINE_HELP}`])
  }
})

test("a reminder's time with no offset and no zone, to the minute or the second, is taken with its wall time: 2026-11-18T09:00, 2026-11-18 09:00:30, 2028-02-29T23:59:59, 2026-12-31T00:00", () => {
  const cases: ReadonlyArray<readonly [string, readonly [number, number, number, number, number, number]]> = [
    ["2026-11-18T09:00", [2026, 11, 18, 9, 0, 0]],
    ["2026-11-18 09:00:30", [2026, 11, 18, 9, 0, 30]],
    ["2028-02-29T23:59:59", [2028, 2, 29, 23, 59, 59]],
    ["2000-02-29T12:00", [2000, 2, 29, 12, 0, 0]],
    [" 2026-12-31T00:00 ", [2026, 12, 31, 0, 0, 0]]
  ]
  for (const [when, [year, month, day, hours, minutes, seconds]] of cases) {
    const got = taken(when)
    expect([when, got]).toEqual([when, { _tag: "Reminder", text: when.trim(), zone: BERLIN, wall: { year, month, day, hours, minutes, seconds } }])
  }
})

test("a reminder's time of another form is refused, with what was wrong and an example: an offset, Z, a zone, milliseconds, a date alone, no month 13, no 29 February 2026 or 1900, no 30 April 31, no hour 24, no minute 60, an hour of one digit", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["2026-11-18T09:00+01:00", "a time with an offset or a zone: the reminder's zone gives it"],
    ["2026-11-18T09:00:00-0500", "a time with an offset or a zone: the reminder's zone gives it"],
    ["2026-11-18T09:00Z", "a time with an offset or a zone: the reminder's zone gives it"],
    ["2026-11-18T09:00[Europe/Berlin]", "a time with an offset or a zone: the reminder's zone gives it"],
    ["2026-11-18T09:00:00.000", "not a date and a time of that form"],
    ["2026-11-18", "not a date and a time of that form"],
    ["2026-11-18T9:00", "not a date and a time of that form"],
    ["2026-11-18T09:00 tomorrow", "not a date and a time of that form"],
    ["2026-13-01T09:00", "no date: there is no month 13"],
    ["2026-00-01T09:00", "no date: there is no month 0"],
    ["2026-02-29T09:00", "no date: the month 2 of 2026 has no day 29"],
    ["1900-02-29T09:00", "no date: the month 2 of 1900 has no day 29"],
    ["2026-04-31T09:00", "no date: the month 4 of 2026 has no day 31"],
    ["2026-11-00T09:00", "no date: the month 11 of 2026 has no day 0"],
    ["2026-11-18T24:00", "no time of a day: the hours are 00 to 23, the minutes and the seconds 00 to 59"],
    ["2026-11-18T09:60", "no time of a day: the hours are 00 to 23, the minutes and the seconds 00 to 59"],
    ["2026-11-18T09:00:60", "no time of a day: the hours are 00 to 23, the minutes and the seconds 00 to 59"]
  ]
  for (const [when, what] of cases) {
    const got = refused(when)
    expect(got).toBeInstanceOf(WhenError)
    expect([when, (got as WhenError).when, (got as WhenError).message]).toEqual([when, when, `${shown(when)} is ${what}. ${REMINDER_HELP}`])
  }
})

// The bounds and the escapes
// --------------------------

// The refusals of a text over its bound, with its length for `%d`.
const OVER_WHEN = `A when of %d characters is over the bound of ${WHEN_MAX}. ${REMINDER_HELP} ${ROUTINE_HELP}`
const OVER_ZONE = `A time zone's name of %d characters is over the bound of ${ZONE_MAX}: give an IANA name, such as ${ZONE_EXAMPLE}.`

test("the bound of a when: 200 units go on to the tests of the form, 201 are refused with the length, the bound and both examples; spaces at the ends count, the trim comes after", () => {
  expect(WHEN_MAX).toBe(200)
  // 200 units: the tests of the form, a routine taken, a reminder's form refused, a field count.
  const routine200 = "0 9 * * *" + " ".repeat(191)
  expect(routine200.length).toBe(200)
  expect(taken(routine200)._tag).toBe("Routine")
  const dated200 = "2026-1" + "[".repeat(194)
  expect(refused(dated200)).toEqual(new WhenError({ when: dated200, message: `${shown(dated200)} is not a date and a time of that form. ${REMINDER_HELP}` }))
  const word200 = "x".repeat(200)
  expect(refused(word200)).toEqual(new WhenError({ when: word200, message: `${shown(word200)} is 1 field, neither a reminder's time nor a routine. ${ROUTINE_HELP}` }))
  // 201 units: the bound, though the trim would make a routine of the first two.
  for (const when of ["0 9 * * *" + " ".repeat(192), " ".repeat(192) + "0 9 * * *", "x".repeat(201), "2026-11-18T09:00" + "[".repeat(185)]) {
    expect([when.length, refused(when)]).toEqual([201, new WhenError({ when: when.slice(0, 200), message: OVER_WHEN.replace("%d", "201") })])
  }
})

test("the bound of a zone's name: 100 units go on to the tests of the form, 101 are refused with the length, the bound and the example", () => {
  expect(ZONE_MAX).toBe(100)
  const name100 = "A".repeat(100)
  const at100 = zone(name100)
  expect(Result.isFailure(at100) ? at100.failure : "it was taken").toEqual(new ZoneError({ zone: name100, message: `${shown(name100)} is not a time zone: give an IANA name, such as ${ZONE_EXAMPLE}.` }))
  for (const name of ["A".repeat(101), "Europe/Berlin" + " ".repeat(88), "Europe/Berlin".padEnd(101, "/")]) {
    const got = zone(name)
    expect([name.length, Result.isFailure(got) ? got.failure : "it was taken"]).toEqual([101, new ZoneError({ zone: name.slice(0, 100), message: OVER_ZONE.replace("%d", "101") })])
  }
})

test("a when of 1 MiB of [ after the start of a date is refused by the bound: a message of at most 300 units with no part of the text, a when field of 200; a zone's name of 1 MiB too", () => {
  for (const when of ["2026-1" + "[".repeat(1_048_576), "2026-11-18T09:00" + "[".repeat(1_048_576)]) {
    const got = refused(when) as WhenError
    expect(got).toBeInstanceOf(WhenError)
    expect([got.message, got.when]).toEqual([OVER_WHEN.replace("%d", String(when.length)), when.slice(0, 200)])
    expect(got.message.length).toBeLessThanOrEqual(300)
    expect(got.message).not.toContain("[")
  }
  const name = "Europe/" + "A".repeat(1_048_576)
  const got = zone(name)
  const error = Result.isFailure(got) ? got.failure : null
  expect([error?.message, error?.zone]).toEqual([OVER_ZONE.replace("%d", String(name.length)), name.slice(0, 100)])
  expect(error!.message.length).toBeLessThanOrEqual(300)
})

test("an over-long text whose last unit in the bound is a high surrogate: the field is cut one unit early, with no lone surrogate at its end", () => {
  // U+1F600 is the pair D83D DE00: its high surrogate is unit 200 (of a when) or 100 (of a zone).
  const when = "x".repeat(199) + "\u{1f600}" + "y"
  const got = refused(when) as WhenError
  expect([got.when, got.message]).toEqual(["x".repeat(199), OVER_WHEN.replace("%d", "202")])
  const name = "A".repeat(99) + "\u{1f600}"
  const at = zone(name)
  expect(Result.isFailure(at) ? at.failure : "it was taken").toEqual(new ZoneError({ zone: "A".repeat(99), message: OVER_ZONE.replace("%d", "101") }))
  // A pair that ends at the bound stays whole.
  const whole = "x".repeat(198) + "\u{1f600}" + "y"
  expect((refused(whole) as WhenError).when).toBe("x".repeat(198) + "\u{1f600}")
})

test("an over-long when or zone is refused before anything reads it: no trim and no regular expression sees a text over the bound", () => {
  const trim = String.prototype.trim
  const exec = RegExp.prototype.exec
  // What a trim or a regular expression read, with the text's length.
  const read: Array<readonly [string, number]> = []
  String.prototype.trim = function(this: string) {
    read.push(["trim", this.length])
    return trim.call(this)
  }
  RegExp.prototype.exec = function(this: RegExp, text: string) {
    read.push([this.source, text.length])
    return exec.call(this, text)
  }
  // Over the bound: three whens and a zone's name, by their lengths.
  const whens = ["0 9 * * *" + " ".repeat(192), "2026-11-18T09:00" + "[".repeat(185), "x".repeat(201)]
  const name = "Europe/Berlin".padEnd(101, "/")
  const lengths = new Set([...whens, name].map((one) => one.length))
  let over: ReadonlyArray<readonly [string, number]> = []
  try {
    for (const when of whens) parse(when, BERLIN)
    zone(name)
    over = read.splice(0).filter(([, length]) => lengths.has(length))
    // The spies see what they spy on: a text in the bound is read.
    parse("x".repeat(200), BERLIN)
  } finally {
    String.prototype.trim = trim
    RegExp.prototype.exec = exec
  }
  expect([over, read.slice(0, 2)]).toEqual([[], [["trim", 200], ["^\\d{4}-\\d", 200]]])
})

// The code points that can hide a part, turn it or move the cursor, and
// their escapes: C0, DEL and C1 controls, the soft hyphen, zero-width and
// bidi controls, U+FEFF, a tag, a lone surrogate.
const HIDDEN: ReadonlyArray<readonly [string, string]> = [
  ["\x1b", "\\x1b"],
  ["\x7f", "\\x7f"],
  ["\x80", "\\x80"],
  ["\x85", "\\x85"],
  ["\x9b", "\\x9b"],
  ["\x9d", "\\x9d"],
  ["\xad", "\\xad"],
  ["\u200b", "\\u{200b}"],
  ["\u200e", "\\u{200e}"],
  ["\u202e", "\\u{202e}"],
  ["\u2066", "\\u{2066}"],
  ["\ufeff", "\\u{feff}"],
  ["\u{e0041}", "\\u{e0041}"],
  ["\ud800", "\\u{d800}"]
]

// Five of them in one text (ESC, CSI, RLO, ZWSP, a lone surrogate), and how
// a message shows them.
const FIVE = "\x1b\x9b\u202e\u200b\ud800"
const FIVE_SHOWN = "\\x1b\\x9b\\u{202e}\\u{200b}\\u{d800}"

test("the escapes of a zone's message: a name with ESC, CSI, RLO, ZWSP and a lone surrogate is shown with their escapes; the field holds the name as it came; a quote and a backslash stay", () => {
  const name = `Europe/${FIVE}Berlin`
  const got = zone(name)
  expect(Result.isFailure(got) ? got.failure : "it was taken").toEqual(new ZoneError({
    zone: name,
    message: `"Europe/${FIVE_SHOWN}Berlin" is not a time zone: give an IANA name, such as ${ZONE_EXAMPLE}.`
  }))
  const plain = zone(`Europe/"Ber\\lin`)
  expect(Result.isFailure(plain) ? plain.failure.message : "it was taken").toBe(`"Europe/"Ber\\lin" is not a time zone: give an IANA name, such as ${ZONE_EXAMPLE}.`)
})

test("the escapes of a when's message: a refused reminder (its form, an offset) and a refused routine (its count of fields, a reason of Cron) with ESC, CSI, RLO, ZWSP and a lone surrogate show their escapes; the field holds the text as it came; a quote and a backslash stay", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [`2026-11-18T09:${FIVE}00`, `"2026-11-18T09:${FIVE_SHOWN}00" is not a date and a time of that form. ${REMINDER_HELP}`],
    [`2026-11-18T09:00[Europe/${FIVE}Berlin]`, `"2026-11-18T09:00[Europe/${FIVE_SHOWN}Berlin]" is a time with an offset or a zone: the reminder's zone gives it. ${REMINDER_HELP}`],
    [`every${FIVE} day at nine`, `"every${FIVE_SHOWN} day at nine" is 4 fields, neither a reminder's time nor a routine. ${ROUTINE_HELP}`],
    [`61${FIVE} 9 * * *`, `"61${FIVE_SHOWN} 9 * * *" is no routine: Expected a positive integer. ${ROUTINE_HELP}`],
    [`*/30${FIVE} * * * *`, `"*/30${FIVE_SHOWN} * * * *" is no routine: Expected step value to be a positive integer. ${ROUTINE_HELP}`],
    [`0 9 * * ${FIVE}mon`, `"0 9 * * ${FIVE_SHOWN}mon" is no routine: Expected a positive integer. ${ROUTINE_HELP}`]
  ]
  for (const [when, message] of cases) {
    expect([when, refused(when)]).toEqual([when, new WhenError({ when, message })])
  }
  expect((refused(`"every\\day"`) as WhenError).message).toBe(`""every\\day"" is 1 field, neither a reminder's time nor a routine. ${ROUTINE_HELP}`)
})

test("each hidden code point on each path of a message (the zone, a refused reminder, a refused routine by its fields, by Cron, by its minute) comes out as its escape: visible leaves the message as it is, the example stays, the field is the text as it came", () => {
  for (const [one, escape] of HIDDEN) {
    const zoned = zone(`Europe/${one}Berlin`)
    const got: ReadonlyArray<readonly [string, unknown]> = [
      [`Europe/${one}Berlin`, Result.isFailure(zoned) ? zoned.failure : "it was taken"],
      ...[`2026-11-18T09:${one}00`, `2026-11-18T09:00[Europe/${one}Berlin]`, `every day${one} at nine`, `61${one} 9 * * *`, `*/30${one} 9 * * *`, `0,${one}30 9 * * *`]
        .map((when) => [when, refused(when)] as const)
    ]
    for (const [text, error] of got) {
      const label = [escape, text]
      if (!(error instanceof ZoneError || error instanceof WhenError)) throw new Error(`${escape} ${text} was taken`)
      const example = error instanceof ZoneError ? `such as ${ZONE_EXAMPLE}.` : text.startsWith("2026") ? REMINDER_HELP : ROUTINE_HELP
      expect([label, error instanceof ZoneError ? error.zone : error.when, visible(error.message) === error.message, error.message.includes(escape), error.message.startsWith(`${shown(text)} is `), error.message.endsWith(example)])
        .toEqual([label, text, true, true, true, true])
    }
  }
})

test("a minute field that Cron takes is digits, *, /, a comma and - only: a hidden code point in the minute is refused by Cron's reason, before the minute's own refusal, so that refusal never shows one", () => {
  for (const [one, escape] of HIDDEN) {
    // U+FEFF is a space to the split of the fields: the minute is then plain.
    if (one === "\ufeff") continue
    for (const field of [`*/30${one}`, `0,${one}30`, `${one}0-1`, `0${one}-1`, `${one}*`]) {
      const message = (refused(`${field} 9 * * *`) as WhenError).message
      expect([escape, field, message.slice(message.indexOf(" is ") + 4, message.indexOf(" is ") + 16)]).toEqual([escape, field, "no routine: "])
    }
  }
})

test("the WhenError of a routine with no time in 5 years shows its text with the escapes (U+2028 and U+FEFF between its fields; U+3000, a space, as it is); its text is at most the parse's 200 units", () => {
  const text = "0\u20280\u300030 2\ufeff*"
  const routine = routineIn(text, BERLIN)
  const after = utc("2026-11-17T12:00:00Z")
  const got = nextSlot(routine, after)
  const message = `"0\\u{2028}0\u300030 2\\u{feff}*" is a routine with no time in the 5 years after ${slotText(after, BERLIN)}: it names a date that never comes, such as 30 February. ${ROUTINE_HELP}`
  expect(Result.isFailure(got) ? got.failure : "it was taken").toEqual(new WhenError({ when: text, message }))
  expect(visible(message)).toBe(message)
  // A routine comes only from parse: its text is at most 200 units, its spaces too.
  const wide = "0" + " ".repeat(191) + "0 30 2 *"
  expect(wide.length).toBe(WHEN_MAX)
  const most = nextSlot(routineIn(wide, BERLIN), after)
  expect(Result.isFailure(most) ? most.failure.message : "it was taken").toBe(`"${wide}" is a routine with no time in the 5 years after ${slotText(after, BERLIN)}: it names a date that never comes, such as 30 February. ${ROUTINE_HELP}`)
  expect((refused("0" + " ".repeat(192) + "0 30 2 *") as WhenError).message).toBe(OVER_WHEN.replace("%d", "201"))
})

// When it is due
// --------------

const NEW_YORK = Result.getOrThrow(zone("America/New_York"))

// A taken reminder and routine in a zone.
const reminderIn = (when: string, at: DateTime.TimeZone.Named): Reminder => {
  const got = Result.getOrThrow(parse(when, at))
  if (got._tag !== "Reminder") throw new Error(`${when} is no reminder`)
  return got
}
const routineIn = (when: string, at: DateTime.TimeZone.Named): Routine => {
  const got = Result.getOrThrow(parse(when, at))
  if (got._tag !== "Routine") throw new Error(`${when} is no routine`)
  return got
}

// An instant on a zone's clock, with its offset: `2026-03-29T03:30:00.000+02:00[Europe/Berlin]`.
const iso = (at: number, zone: DateTime.TimeZone.Named): string => DateTime.formatIsoZoned(DateTime.makeZonedUnsafe(at, { timeZone: zone }))

const utc = (text: string): number => new Date(text).getTime()

test("a reminder's time on the four days of a change in both zones: a time that the zone skips moves forward by the gap (03:30 pinned), a repeated one is the earlier, another is as written", () => {
  const cases: ReadonlyArray<readonly [string, DateTime.TimeZone.Named, string]> = [
    // Berlin: summer time from 2026-03-29 02:00 (to 03:00), back on 2026-10-25 03:00 (to 02:00).
    ["2026-03-08T02:30", BERLIN, "2026-03-08T02:30:00.000+01:00[Europe/Berlin]"],
    ["2026-03-29T02:30", BERLIN, "2026-03-29T03:30:00.000+02:00[Europe/Berlin]"],
    ["2026-10-25T02:30", BERLIN, "2026-10-25T02:30:00.000+02:00[Europe/Berlin]"],
    ["2026-11-01T02:30", BERLIN, "2026-11-01T02:30:00.000+01:00[Europe/Berlin]"],
    // New York: summer time from 2026-03-08 02:00 (to 03:00), back on 2026-11-01 02:00 (to 01:00).
    ["2026-03-08T02:30", NEW_YORK, "2026-03-08T03:30:00.000-04:00[America/New_York]"],
    ["2026-03-29T02:30", NEW_YORK, "2026-03-29T02:30:00.000-04:00[America/New_York]"],
    ["2026-10-25T02:30", NEW_YORK, "2026-10-25T02:30:00.000-04:00[America/New_York]"],
    ["2026-11-01T01:30", NEW_YORK, "2026-11-01T01:30:00.000-04:00[America/New_York]"],
    ["2026-11-01T02:30", NEW_YORK, "2026-11-01T02:30:00.000-05:00[America/New_York]"],
    ["2026-11-16T09:00:30", BERLIN, "2026-11-16T09:00:30.000+01:00[Europe/Berlin]"]
  ]
  for (const [when, at, expected] of cases) {
    expect([when, DateTime.zoneToString(at), iso(reminderAt(reminderIn(when, at)), at)]).toEqual([when, DateTime.zoneToString(at), expected])
  }
  // 03:30 in the gap, as milliseconds; and the earlier of the two 02:30s of 2026-10-25 (00:30 UTC, not 01:30).
  expect(reminderAt(reminderIn("2026-03-29T02:30", BERLIN))).toBe(utc("2026-03-29T01:30:00Z"))
  expect(reminderAt(reminderIn("2026-10-25T02:30", BERLIN))).toBe(utc("2026-10-25T00:30:00Z"))
})

test("isPast: a time before now is past; the same time, or a later one, is not", () => {
  const at = reminderAt(reminderIn("2026-11-16T15:00", BERLIN))
  expect([isPast(at, at + 1), isPast(at, at), isPast(at, at - 1)]).toEqual([true, false, false])
})

test("a routine's next slot at 02:30 and at 09:00 in both zones on the four days: the skipped 02:30 is 03:30, the repeated 02:30 (01:30 in New York) comes once, the earlier", () => {
  // The routine, its zone, the time after which (on the day before, after
  // that day's slot on the zone's clock), and its next two slots.
  const cases: ReadonlyArray<readonly [string, DateTime.TimeZone.Named, string, string, string]> = [
    ["30 2 * * *", BERLIN, "2026-03-07T12:00:00Z", "2026-03-08T02:30:00.000+01:00[Europe/Berlin]", "2026-03-09T02:30:00.000+01:00[Europe/Berlin]"],
    ["30 2 * * *", BERLIN, "2026-03-28T12:00:00Z", "2026-03-29T03:30:00.000+02:00[Europe/Berlin]", "2026-03-30T02:30:00.000+02:00[Europe/Berlin]"],
    ["30 2 * * *", BERLIN, "2026-10-24T12:00:00Z", "2026-10-25T02:30:00.000+02:00[Europe/Berlin]", "2026-10-26T02:30:00.000+01:00[Europe/Berlin]"],
    ["30 2 * * *", BERLIN, "2026-10-31T12:00:00Z", "2026-11-01T02:30:00.000+01:00[Europe/Berlin]", "2026-11-02T02:30:00.000+01:00[Europe/Berlin]"],
    ["0 9 * * *", BERLIN, "2026-03-07T12:00:00Z", "2026-03-08T09:00:00.000+01:00[Europe/Berlin]", "2026-03-09T09:00:00.000+01:00[Europe/Berlin]"],
    ["0 9 * * *", BERLIN, "2026-03-28T12:00:00Z", "2026-03-29T09:00:00.000+02:00[Europe/Berlin]", "2026-03-30T09:00:00.000+02:00[Europe/Berlin]"],
    ["0 9 * * *", BERLIN, "2026-10-24T12:00:00Z", "2026-10-25T09:00:00.000+01:00[Europe/Berlin]", "2026-10-26T09:00:00.000+01:00[Europe/Berlin]"],
    ["0 9 * * *", BERLIN, "2026-10-31T12:00:00Z", "2026-11-01T09:00:00.000+01:00[Europe/Berlin]", "2026-11-02T09:00:00.000+01:00[Europe/Berlin]"],
    ["30 2 * * *", NEW_YORK, "2026-03-07T12:00:00Z", "2026-03-08T03:30:00.000-04:00[America/New_York]", "2026-03-09T02:30:00.000-04:00[America/New_York]"],
    ["30 2 * * *", NEW_YORK, "2026-03-28T12:00:00Z", "2026-03-29T02:30:00.000-04:00[America/New_York]", "2026-03-30T02:30:00.000-04:00[America/New_York]"],
    ["30 2 * * *", NEW_YORK, "2026-10-24T12:00:00Z", "2026-10-25T02:30:00.000-04:00[America/New_York]", "2026-10-26T02:30:00.000-04:00[America/New_York]"],
    ["30 2 * * *", NEW_YORK, "2026-10-31T12:00:00Z", "2026-11-01T02:30:00.000-05:00[America/New_York]", "2026-11-02T02:30:00.000-05:00[America/New_York]"],
    ["30 1 * * *", NEW_YORK, "2026-10-31T12:00:00Z", "2026-11-01T01:30:00.000-04:00[America/New_York]", "2026-11-02T01:30:00.000-05:00[America/New_York]"],
    ["0 9 * * *", NEW_YORK, "2026-03-07T17:00:00Z", "2026-03-08T09:00:00.000-04:00[America/New_York]", "2026-03-09T09:00:00.000-04:00[America/New_York]"],
    ["0 9 * * *", NEW_YORK, "2026-03-28T17:00:00Z", "2026-03-29T09:00:00.000-04:00[America/New_York]", "2026-03-30T09:00:00.000-04:00[America/New_York]"],
    ["0 9 * * *", NEW_YORK, "2026-10-24T17:00:00Z", "2026-10-25T09:00:00.000-04:00[America/New_York]", "2026-10-26T09:00:00.000-04:00[America/New_York]"],
    ["0 9 * * *", NEW_YORK, "2026-10-31T17:00:00Z", "2026-11-01T09:00:00.000-05:00[America/New_York]", "2026-11-02T09:00:00.000-05:00[America/New_York]"]
  ]
  for (const [when, at, after, first, second] of cases) {
    const routine = routineIn(when, at)
    const one = Result.getOrThrow(nextSlot(routine, utc(after)))
    const two = Result.getOrThrow(nextSlot(routine, one))
    expect([when, after, iso(one, at), iso(two, at)]).toEqual([when, after, first, second])
  }
})

test("a routine with no slot in the 5 years after the time asked is refused with a WhenError: 0 0 30 2 * (a date that never comes); 0 0 29 2 * has one from 2026, none from 2097 (the next is in 2104)", () => {
  expect(HORIZON_YEARS).toBe(5)
  for (const [when, after] of [["0 0 30 2 *", "2026-11-17T12:00:00Z"], ["0 0 29 2 *", "2097-01-01T00:00:00Z"]] as const) {
    const got = nextSlot(routineIn(when, BERLIN), utc(after))
    expect(Result.isFailure(got) ? got.failure : "it was taken").toEqual(new WhenError({
      when,
      message: `${shown(when)} is a routine with no time in the 5 years after ${slotText(utc(after), BERLIN)}: it names a date that never comes, such as 30 February. ${ROUTINE_HELP}`
    }))
  }
  expect(iso(Result.getOrThrow(nextSlot(routineIn("0 0 29 2 *", BERLIN), utc("2026-11-17T12:00:00Z"))), BERLIN)).toBe("2028-02-29T00:00:00.000+01:00[Europe/Berlin]")
})

// What `missedOf` gave, as texts on the zone's clock.
const seen = (got: Option.Option<Missed>, at: DateTime.TimeZone.Named) =>
  Option.match(got, {
    onNone: () => "nothing due",
    onSome: (one) => ({ slot: slotText(one.slot, at), missed: one.missed, more: one.more, next: one.next === undefined ? undefined : slotText(one.next, at) })
  })

test("missed slots: a daily 09:00 last fired on Monday, due Tuesday, asked on Thursday at 10:00 Berlin: one fire for Thursday's slot, 2 missed, the next on Friday, 1 h late", () => {
  const daily = routineIn("0 9 * * *", BERLIN)
  const due = Result.getOrThrow(nextSlot(daily, utc("2026-11-16T08:00:00Z")))
  expect(slotText(due, BERLIN)).toBe("2026-11-17 09:00 Europe/Berlin")
  const now = utc("2026-11-19T09:00:00Z")
  const got = missedOf(daily, due, now)
  expect(seen(got, BERLIN)).toEqual({ slot: "2026-11-19 09:00 Europe/Berlin", missed: 2, more: false, next: "2026-11-20 09:00 Europe/Berlin" })
  const one = Option.getOrThrow(got)
  expect([lateText(one.slot, now), missedText(one)]).toEqual(["1 h late", "2 missed"])
  // Due at now: that slot, none missed.
  expect(seen(missedOf(daily, due, due), BERLIN)).toEqual({ slot: "2026-11-17 09:00 Europe/Berlin", missed: 0, more: false, next: "2026-11-18 09:00 Europe/Berlin" })
  expect(missedText(Option.getOrThrow(missedOf(daily, due, due)))).toBeUndefined()
  // Due after now: nothing.
  expect(seen(missedOf(daily, due, due - 1), BERLIN)).toBe("nothing due")
})

test("a now that moves back: after the fire for Thursday's slot (due is Friday's), a clock set back to Wednesday 10:00, or to Thursday 09:30, gives nothing due, never Wednesday's or Thursday's slot again", () => {
  const daily = routineIn("0 9 * * *", BERLIN)
  const fired = Option.getOrThrow(missedOf(daily, utc("2026-11-17T08:00:00Z"), utc("2026-11-19T09:00:00Z")))
  const due = fired.next!
  expect(slotText(due, BERLIN)).toBe("2026-11-20 09:00 Europe/Berlin")
  for (const now of ["2026-11-18T09:00:00Z", "2026-11-19T08:30:00Z", "2026-11-19T08:00:00Z"]) {
    expect([now, seen(missedOf(daily, due, utc(now)), BERLIN)]).toEqual([now, "nothing due"])
  }
  // Forward again: Friday's slot, none missed.
  expect(seen(missedOf(daily, due, utc("2026-11-20T08:05:00Z")), BERLIN)).toEqual({ slot: "2026-11-20 09:00 Europe/Berlin", missed: 0, more: false, next: "2026-11-21 09:00 Europe/Berlin" })
})

test("the bound of the missed count: an hourly routine with 1,000 missed slots counts them; with 1,001, or two months of them, it counts 1,000 and says or more, and the slot is still the newest at or before now", () => {
  expect(MISSED_MAX).toBe(1_000)
  const hourly = routineIn("0 * * * *", BERLIN)
  const due = utc("2026-01-01T00:00:00Z")
  const hour = 3_600_000
  // 1,000 missed: the slots due .. due + 1,000 h are at or before now.
  const exact = Option.getOrThrow(missedOf(hourly, due, due + 1_000 * hour + 30 * 60_000))
  expect([exact.slot, exact.missed, exact.more, exact.next, missedText(exact)]).toEqual([due + 1_000 * hour, 1_000, false, due + 1_001 * hour, "1000 missed"])
  const over = Option.getOrThrow(missedOf(hourly, due, due + 1_001 * hour + 30 * 60_000))
  expect([over.slot, over.missed, over.more, over.next, missedText(over)]).toEqual([due + 1_001 * hour, 1_000, true, due + 1_002 * hour, "1000 or more missed"])
  // Two months asleep (1,416 slots): the walk stops at 1,000.
  const now = utc("2026-03-01T00:30:00Z")
  expect(seen(missedOf(hourly, due, now), BERLIN)).toEqual({ slot: "2026-03-01 01:00 Europe/Berlin", missed: 1_000, more: true, next: "2026-03-01 02:00 Europe/Berlin" })
})

test("the text of a slot is its zone's wall clock to the minute with the zone's name; the two instants of a repeated 02:30 have one text", () => {
  expect(slotText(utc("2026-11-16T08:00:00Z"), BERLIN)).toBe("2026-11-16 09:00 Europe/Berlin")
  expect(slotText(utc("2026-11-16T08:00:59Z"), BERLIN)).toBe("2026-11-16 09:00 Europe/Berlin")
  expect(slotText(utc("2026-12-31T23:30:00Z"), BERLIN)).toBe("2027-01-01 00:30 Europe/Berlin")
  expect(slotText(utc("2026-12-31T23:30:00Z"), NEW_YORK)).toBe("2026-12-31 18:30 America/New_York")
  expect([slotText(utc("2026-10-25T00:30:00Z"), BERLIN), slotText(utc("2026-10-25T01:30:00Z"), BERLIN)]).toEqual(["2026-10-25 02:30 Europe/Berlin", "2026-10-25 02:30 Europe/Berlin"])
})

test("how late in words: nothing under one minute, whole minutes under an hour, whole hours under two days, then whole days", () => {
  const slot = utc("2026-11-16T08:00:00Z")
  const minute = 60_000
  const cases: ReadonlyArray<readonly [number, string | undefined]> = [
    [-minute, undefined],
    [0, undefined],
    [minute - 1, undefined],
    [minute, "1 min late"],
    [3 * minute + 59_000, "3 min late"],
    [59 * minute, "59 min late"],
    [60 * minute, "1 h late"],
    [2 * 60 * minute + 59 * minute, "2 h late"],
    [47 * 60 * minute, "47 h late"],
    [48 * 60 * minute, "2 d late"],
    [3 * 365 * 24 * 60 * minute, "1095 d late"]
  ]
  for (const [late, words] of cases) expect([late, lateText(slot, slot + late)]).toEqual([late, words])
})

// The walk past 5 years
// ---------------------

const UTC = Result.getOrThrow(zone("UTC"))

test("missed slots have no horizon: 0 0 29 2 * in UTC, due 2096-02-29, asked in 2106 (no 29 February in 2100): the slot of 2104, 1 missed, the next in 2108; and 1 ms before the slot of 2104, at it, 1 ms after it", () => {
  const leap = routineIn("0 0 29 2 *", UTC)
  const due = utc("2096-02-29T00:00:00Z")
  const slot = utc("2104-02-29T00:00:00Z")
  const cases: ReadonlyArray<readonly [number, ReturnType<typeof seen>]> = [
    [utc("2106-02-28T00:00:00Z"), { slot: "2104-02-29 00:00 UTC", missed: 1, more: false, next: "2108-02-29 00:00 UTC" }],
    [slot - 1, { slot: "2096-02-29 00:00 UTC", missed: 0, more: false, next: "2104-02-29 00:00 UTC" }],
    [slot, { slot: "2104-02-29 00:00 UTC", missed: 1, more: false, next: "2108-02-29 00:00 UTC" }],
    [slot + 1, { slot: "2104-02-29 00:00 UTC", missed: 1, more: false, next: "2108-02-29 00:00 UTC" }]
  ]
  for (const [now, expected] of cases) {
    expect([new Date(now).toISOString(), seen(missedOf(leap, due, now), UTC)]).toEqual([new Date(now).toISOString(), expected])
  }
  // The make keeps its 5 years: none from 2097, none ever for 30 February.
  for (const [when, after] of [["0 0 29 2 *", "2097-01-01T00:00:00Z"], ["0 0 30 2 *", "2026-11-17T12:00:00Z"]] as const) {
    const got = nextSlot(routineIn(when, UTC), utc(after))
    expect([when, Result.isFailure(got) ? got.failure.message : "it was taken"]).toEqual([
      when,
      `"${when}" is a routine with no time in the 5 years after ${slotText(utc(after), UTC)}: it names a date that never comes, such as 30 February. ${ROUTINE_HELP}`
    ])
  }
})

// The comparison: `missedOf` against a plain walk of `Cron.next` from `due`
// (the slow way), on inputs from a seeded generator. On a failure the case
// prints the seed and the whole input. The walk's steps of one run are
// bounded (`STEPS_MAX`); no case reads the time of a run.
const SEED = 0x31d4a2f9
const STEPS_MAX = 200_000

test("the comparison: missedOf against a plain walk of Cron.next from due, on seeded inputs in both zones (hour patterns, the days of the changes of time, counts of 999, 1,000 and 1,001, a now at a slot and 1 ms beside it, a now before due, the leap day over the century)", () => {
  let state = SEED
  // xorshift32: a number in 0 .. n - 1.
  const rand = (n: number): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
  const pick = <A,>(list: ReadonlyArray<A>): A => list[rand(list.length)]!
  let steps = 0
  // The slots of a routine from `due`, walked with Cron.next one by one, and
  // kept: `slotsOf(...)[k]` is the k-th slot after `due`.
  const walked = new Map<string, Array<number>>()
  const slotsOf = (routine: Routine, due: number, upTo: (slots: ReadonlyArray<number>) => boolean): ReadonlyArray<number> => {
    const key = `${routine.text} ${DateTime.zoneToString(routine.zone)} ${due}`
    const slots = walked.get(key) ?? [due]
    walked.set(key, slots)
    while (!upTo(slots)) {
      steps++
      if (steps > STEPS_MAX) throw new Error(`the walk took more than ${STEPS_MAX} steps (seed ${SEED})`)
      slots.push(Cron.next(routine.cron, new Date(slots.at(-1)!)).getTime())
    }
    return slots
  }
  // What the slow way says: nothing due before `due`; else the newest slot
  // at or before now, the count before it (at most 1,000, `more` past it),
  // the first slot after now.
  const walk = (routine: Routine, due: number, now: number): Missed | "nothing due" => {
    if (due > now) return "nothing due"
    const slots = slotsOf(routine, due, (all) => all.at(-1)! > now)
    // The first slot after now; the count is the slots before the newest.
    const after = slots.findIndex((one) => one > now)
    const count = after - 1
    return { slot: slots[after - 1]!, missed: Math.min(count, MISSED_MAX), more: count > MISSED_MAX, next: slots[after]! }
  }

  const zones = [BERLIN, NEW_YORK] as const
  const minutes = ["0", "15", "30", "59"] as const
  const hours = ["*", "1", "2", "9", "*/2", "1,9,23", "2-3"] as const
  const days = ["* * *", "* * 1-5", "* * 0", "1,15 * *"] as const
  // The changes of time of 2026: New York's and Berlin's, to summer and back.
  const changes = ["2026-03-08T07:00:00Z", "2026-03-29T01:00:00Z", "2026-10-25T01:00:00Z", "2026-11-01T06:00:00Z"].map(utc)
  const hour = 3_600_000

  type Input = { readonly routine: Routine; readonly due: number; readonly now: number }
  const inputs: Array<Input> = []
  const routineOf = (): Routine => routineIn(`${pick(minutes)} ${pick(hours)} ${pick(days)}`, pick(zones))
  // A due slot a few days before a change of time.
  const dueOf = (routine: Routine): number => Result.getOrThrow(nextSlot(routine, pick(changes) - rand(96) * hour))
  // At the k-th slot after due, and 1 ms beside it: counts of 999, 1,000
  // and 1,001 in each zone, and none (a now before due).
  for (const at of zones) {
    const routine = routineIn(`${pick(minutes)} ${pick(hours)} ${pick(days)}`, at)
    const due = dueOf(routine)
    const slots = slotsOf(routine, due, (all) => all.length > 1_002)
    for (const k of [0, 1, 999, 1_000, 1_001]) for (const delta of [-1, 0, 1]) inputs.push({ routine, due, now: slots[k]! + delta })
  }
  // The leap day of T7 over the century: 2100 has none, 2400 has one.
  const leap = routineIn("0 0 29 2 *", UTC)
  for (const due of ["2096-02-29T00:00:00Z", "2396-02-29T00:00:00Z"].map(utc)) {
    const slots = slotsOf(leap, due, (all) => all.length > 1_002)
    for (const k of [0, 1, 2, 999, 1_000, 1_001]) for (const delta of [-1, 0, 1]) inputs.push({ routine: leap, due, now: slots[k]! + delta })
    inputs.push({ routine: leap, due, now: due + 10 * 365 * 24 * hour })
  }
  // Random ones: a few slots or many after due, at a slot or 1 ms beside
  // it or between two; at a change of time; before due.
  for (let i = 0; i < 40; i++) {
    const routine = routineOf()
    const due = dueOf(routine)
    const kind = rand(4)
    if (kind === 0) {
      const k = pick([0, 1, 2, 3, rand(30), rand(1_500)])
      const slots = slotsOf(routine, due, (all) => all.length > k + 1)
      inputs.push({ routine, due, now: slots[k]! + pick([-1, 0, 1, Math.floor((slots[k + 1]! - slots[k]!) / 2)]) })
    } else if (kind === 1) {
      inputs.push({ routine, due, now: pick(changes) + pick([-hour, -1, 0, 1, hour, 7 * 24 * hour]) })
    } else if (kind === 2) {
      inputs.push({ routine, due, now: due - 1 - rand(48 * hour) })
    } else {
      inputs.push({ routine, due, now: due + rand(90 * 24) * hour + pick([-1, 0, 1]) })
    }
  }

  let compared = 0
  for (const [i, { routine, due, now }] of inputs.entries()) {
    const input = { seed: `0x${SEED.toString(16)}`, i, when: routine.text, zone: DateTime.zoneToString(routine.zone), due: new Date(due).toISOString(), now: new Date(now).toISOString() }
    const got = Option.match(missedOf(routine, due, now), { onNone: () => "nothing due" as const, onSome: (one) => ({ ...one }) })
    expect([input, got]).toEqual([input, walk(routine, due, now)])
    compared++
  }
  // Each kind came: a count over 1,000, exactly 1,000, a now before due.
  const outcomes = inputs.map(({ routine, due, now }) => walk(routine, due, now))
  expect([
    compared,
    outcomes.some((one) => one !== "nothing due" && one.more),
    outcomes.some((one) => one !== "nothing due" && one.missed === MISSED_MAX && !one.more),
    outcomes.includes("nothing due"),
    steps <= STEPS_MAX
  ]).toEqual([inputs.length, true, true, true, true])
})
