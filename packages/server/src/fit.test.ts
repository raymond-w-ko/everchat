// Tests of the fit and the pages (fit.ts; docs/host.md, section 8, "The
// bytes of one entry" and "Pages"): each type of entry under the limit, the
// cut of a `call` and an `end`, the pieces and the events that cannot be
// given, and the pages over a store that is a list of made-up events.

import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event, Message } from "@everchat/core/store"
import type { TurnEvent as CoreTurnEvent } from "@everchat/core/turn"
import { CALL, type Entry, EntryTooLarge, fit, page, type PageLimits, type TurnEvent, utf8 } from "./fit.ts"

// fit.ts's `TurnEvent` is the core's, both ways: a change of one fails the
// type check of the tests.
const same: [CoreTurnEvent] extends [TurnEvent] ? ([TurnEvent] extends [CoreTurnEvent] ? true : false) : false = true
void same

const KiB = 1024
const MiB = 1024 * 1024
const LIMITS: PageLimits = { entry: MiB, page: 1_000, pageBytes: 2 * MiB }

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8")

const message = (i: number, text: string): Message => ({
  i,
  kind: "user",
  text,
  size: bytesOf(text),
  more: false,
  line: null,
  turn: null,
  call: null,
  launch: 7,
  created: 1_763_300_000_000
})

type Call = Extract<Event, { readonly type: "call" }>
type End = Extract<Event, { readonly type: "end" }>
const call = (n: number, program: string): Call => ({ type: "call", n, turn: 9, call: 17, program })
const end = (n: number, why: string | null): End => ({ type: "end", n, turn: 9, status: "failed", why })

// The entry that `fit` gave, or a failure of the case.
const given = (fitted: ReturnType<typeof fit>): Entry => {
  expect(fitted._tag).toBe("Entry")
  return fitted as Entry
}

// The fit
// -------

test("under the limit, each of the five numbered events and the three pieces is its JSON.stringify, field for field, with its bytes and no field cut", () => {
  const entries: ReadonlyArray<TurnEvent> = [
    { type: "accepted", n: 41, messages: [message(118, "Hello"), message(119, "é \"quoted\" \n 😀")] },
    { type: "start", n: 42, turn: 9 },
    call(43, "await zoo.list()"),
    { type: "message", n: 44, message: message(120, "the reply") },
    { type: "end", n: 45, turn: 9, status: "done", why: null },
    { type: "text", turn: 9, delta: "Hel" },
    { type: "thought", turn: 9, delta: "..." },
    { type: "program", turn: 9, delta: "await zoo" }
  ]
  for (const event of entries) {
    const got = given(fit(event, MiB))
    expect(got.json).toBe(JSON.stringify(event))
    expect(JSON.parse(got.json)).toEqual(event)
    expect(got.bytes).toBe(bytesOf(got.json))
    expect(got.n).toBe("n" in event ? event.n : null)
    expect(got.cut).toBe(false)
    expect("cut" in JSON.parse(got.json)).toBe(false)
  }
})

test("an event of exactly the limit is given whole, and one byte less of limit cuts it", () => {
  const event = call(43, "x".repeat(1_000))
  const bytes = bytesOf(JSON.stringify(event))
  expect(given(fit(event, bytes)).cut).toBe(false)
  expect(given(fit(event, bytes - 1)).cut).toBe(true)
})

// The checks of a cut of `event`'s text `field` to `limit`: at most the
// limit, `"cut":true` at the end, a JSON that parses to the event with a
// start of its text, a well formed start, and one more character of the
// text would pass the limit. Gives the start.
const checkCut = (event: Call | End, field: "program" | "why", limit: number) => {
  const whole = (event as unknown as Record<string, string>)[field] as string
  const got = given(fit(event, limit))
  expect(got.cut).toBe(true)
  expect(got.n).toBe(event.n)
  expect(got.bytes).toBe(bytesOf(got.json))
  expect(got.bytes).toBeLessThanOrEqual(limit)
  expect(got.json.endsWith(`,"cut":true}`)).toBe(true)
  const parsed = JSON.parse(got.json) as Record<string, unknown>
  const start = parsed[field] as string
  expect(parsed).toEqual({ ...event, [field]: start, cut: true })
  expect(got.json).toBe(JSON.stringify({ ...event, [field]: start, cut: true }))
  expect(whole.startsWith(start)).toBe(true)
  expect(start.length).toBeLessThan(whole.length)
  expect(start.isWellFormed()).toBe(true)
  const next = String.fromCodePoint(whole.codePointAt(start.length) as number)
  expect(bytesOf(JSON.stringify({ ...event, [field]: start + next, cut: true }))).toBeGreaterThan(limit)
  return start
}

// A text of `bytes` or more, of ASCII, escapes, two-, three- and four-byte
// characters, mixed.
const mixed = (bytes: number) => {
  const unit = "let a = \"é\";\n\tconst 中 = '😀' \\ \u0001;\r\n"
  return unit.repeat(Math.ceil(bytes / bytesOf(unit)))
}

test("a call whose program is 3 MiB, under a limit of 1 MiB: the JSON is at most the limit, ends with \"cut\":true, parses, and one more character would pass the limit", () => {
  const program = mixed(3 * MiB)
  expect(bytesOf(program)).toBeGreaterThanOrEqual(3 * MiB)
  const start = checkCut(call(43, program), "program", MiB)
  expect(bytesOf(start)).toBeGreaterThan(MiB / 2)
  // Of plain ASCII the cut fills the limit to the byte.
  const plain = given(fit(call(43, "a".repeat(3 * MiB)), MiB))
  expect(plain.bytes).toBe(MiB)
})

test("an end whose why is 3 MiB, under a limit of 1 MiB: the same", () => {
  checkCut(end(45, mixed(3 * MiB)), "why", MiB)
  expect(given(fit(end(45, "b".repeat(3 * MiB)), MiB)).bytes).toBe(MiB)
})

test("a cut that would fall inside a pair of surrogates falls before it", () => {
  const event = call(43, "a".repeat(10) + "😀".repeat(10))
  const base = bytesOf(JSON.stringify({ ...event, program: "", cut: true }))
  // Room for the ten a's and 1, 2 or 3 bytes more: the four bytes of 😀 do
  // not fit, and neither does half of it.
  for (const room of [1, 2, 3]) {
    const start = checkCut(event, "program", base + 10 + room)
    expect(start).toBe("a".repeat(10))
  }
  // Room for one 😀 whole.
  expect(checkCut(event, "program", base + 14)).toBe("a".repeat(10) + "😀")
  // Even with room for a lone half's escape (6 bytes), no half is given.
  expect(checkCut(event, "program", base + 10 + 6)).toBe("a".repeat(10) + "😀")
})

test("a text of control characters, 6 bytes of JSON each, and one of 4-byte characters", () => {
  const controls = end(45, "\u0001\u0002\u001f".repeat(100_000))
  const base = bytesOf(JSON.stringify({ ...controls, why: "", cut: true }))
  const start = checkCut(controls, "why", base + 6 * 1_000 + 5)
  expect(start.length).toBe(1_000)
  const astral = call(43, "😀𝄞".repeat(100_000))
  const baseAstral = bytesOf(JSON.stringify({ ...astral, program: "", cut: true }))
  const startAstral = checkCut(astral, "program", baseAstral + 4 * 999 + 3)
  expect([...startAstral].length).toBe(999)
  // The short escapes are 2 bytes each.
  const short = call(43, "\n\"\\\t".repeat(100_000))
  const baseShort = bytesOf(JSON.stringify({ ...short, program: "", cut: true }))
  expect(checkCut(short, "program", baseShort + 2 * 777 + 1).length).toBe(777)
})

test("a lone half of a pair in a text is counted as JSON.stringify writes it, 6 bytes", () => {
  const event = call(43, "a\ud83d" + "b".repeat(1_000))
  const base = bytesOf(JSON.stringify({ ...event, program: "", cut: true }))
  const got = given(fit(event, base + 1 + 6 + 10))
  expect(got.bytes).toBe(bytesOf(got.json))
  expect(JSON.parse(got.json).program).toBe("a\ud83d" + "b".repeat(10))
})

test("the same event and limit give the same bytes 100 times", () => {
  const event = call(43, mixed(2 * MiB))
  const first = given(fit(event, MiB))
  for (let k = 0; k < 100; k += 1) {
    const again = given(fit({ ...event }, MiB))
    expect(again.json === first.json).toBe(true)
    expect(again.bytes).toBe(first.bytes)
  }
})

test("a piece over the limit is dropped, with its bytes", () => {
  for (const type of ["text", "thought", "program"] as const) {
    const piece: TurnEvent = { type, turn: 9, delta: "d".repeat(2 * KiB) }
    expect(fit(piece, KiB)).toEqual({ _tag: "Dropped", bytes: bytesOf(JSON.stringify(piece)) })
  }
})

test("an accepted, a message and a start over the limit are the fault with their number and size, and no text of them", () => {
  const secret = "the person's own words"
  const events: ReadonlyArray<Event> = [
    { type: "accepted", n: 41, messages: [message(118, secret.repeat(1_000))] },
    { type: "message", n: 44, message: message(120, secret.repeat(1_000)) },
    { type: "start", n: 42, turn: 9 }
  ]
  for (const event of events) {
    const limit = event.type === "start" ? 20 : KiB
    const fault = fit(event, limit)
    expect(fault).toBeInstanceOf(EntryTooLarge)
    const { n, type, bytes } = fault as EntryTooLarge
    expect({ n, type, bytes }).toEqual({ n: event.n, type: event.type, bytes: bytesOf(JSON.stringify(event)) })
    expect(JSON.stringify(fault).includes("person")).toBe(false)
    expect(String(fault).includes("person")).toBe(false)
  }
  // A call or an end that does not fit even with an empty text, and an end
  // over the limit with no why, are the fault too.
  expect(fit(call(43, "p".repeat(100)), 30)).toBeInstanceOf(EntryTooLarge)
  expect(fit(end(45, null), 30)).toBeInstanceOf(EntryTooLarge)
})

test("utf8 counts as Buffer.byteLength does", () => {
  for (const text of ["", "a", "é", "中", "😀", mixed(10 * KiB), "\u0000\u007f\u0080߿ࠀ￿"]) {
    expect(utf8(text)).toBe(bytesOf(text))
  }
})

// The pages
// ---------

// A store of `events`: `eventsAfter(after, limit)` as the store's, and the
// calls that it was asked, each with what it gave.
const store = (events: ReadonlyArray<Event>) => {
  const calls: Array<{ readonly after: number; readonly limit: number; readonly gave: ReadonlyArray<number> }> = []
  const read = (after: number, limit: number) =>
    Effect.sync(() => {
      const gave = events.filter((event) => event.n > after).slice(0, limit)
      calls.push({ after, limit, gave: gave.map((event) => event.n) })
      return gave
    })
  return { read, calls }
}

const starts = (count: number, from = 1): Array<Event> => Array.from({ length: count }, (_, k) => ({ type: "start", n: from + k, turn: 9 }))

const numbers = (entries: ReadonlyArray<Entry>) => entries.map((entry) => entry.n)
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k)

test("250 small events give one page of 250, at the store's end, after 3 calls", async () => {
  const { read, calls } = store(starts(250))
  const got = await Effect.runPromise(page(read, 0, LIMITS))
  expect(numbers(got.entries)).toEqual(range(1, 250))
  expect(got.last).toBe(250)
  expect(got.end).toBe(true)
  expect(calls.map(({ after, limit, gave }) => [after, limit, gave.length])).toEqual([[0, CALL, 100], [100, CALL, 100], [200, CALL, 50]])
  for (const entry of got.entries) expect(entry.json).toBe(JSON.stringify({ type: "start", n: entry.n, turn: 9 }))
})

test("events of 600 KiB under a page of 2 MiB give pages of 3, each call's rest read again, no number twice and none missed", async () => {
  const events = Array.from({ length: 10 }, (_, k) => call(k + 1, String.fromCharCode(97 + k).repeat(600 * KiB)))
  const { read, calls } = store(events)
  const pages = []
  let after = 0
  while (true) {
    const got = await Effect.runPromise(page(read, after, LIMITS))
    pages.push(got)
    const bytes = got.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    expect(bytes).toBeLessThanOrEqual(LIMITS.pageBytes)
    for (const entry of got.entries) expect(entry.cut).toBe(false)
    after = got.last
    if (got.end) break
  }
  expect(pages.map((got) => numbers(got.entries))).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]])
  expect(pages.map((got) => got.end)).toEqual([false, false, false, true])
  // Each call gave the rest of the store, and the next page read from the
  // page's last number: the events that did not fit came again.
  expect(calls.map(({ after, gave }) => [after, gave[0]])).toEqual([[0, 1], [3, 4], [6, 7], [9, 10]])
  expect(pages.flatMap((got) => numbers(got.entries))).toEqual(range(1, 10))
})

test("1,500 small events give a page of 1,000 and then one of 500", async () => {
  const { read, calls } = store(starts(1_500))
  const first = await Effect.runPromise(page(read, 0, LIMITS))
  expect(numbers(first.entries)).toEqual(range(1, 1_000))
  expect(first.end).toBe(false)
  expect(first.last).toBe(1_000)
  const second = await Effect.runPromise(page(read, first.last, LIMITS))
  expect(numbers(second.entries)).toEqual(range(1_001, 1_500))
  expect(second.end).toBe(true)
  expect(calls.every((one) => one.limit <= CALL)).toBe(true)
})

test("a page of exactly 1,000 at the store's end, and a page closed by its count, say what they know", async () => {
  // 1,000 events: the tenth call gives its full count, so the page cannot
  // say that it is at the end; the next page is empty, at the end.
  const { read } = store(starts(1_000))
  const first = await Effect.runPromise(page(read, 0, LIMITS))
  expect(first.entries.length).toBe(1_000)
  expect(first.end).toBe(false)
  const next = await Effect.runPromise(page(read, first.last, LIMITS))
  expect(next).toEqual({ entries: [], last: 1_000, end: true })
})

test("an empty store gives an empty page at the end", async () => {
  const { read, calls } = store([])
  expect(await Effect.runPromise(page(read, 0, LIMITS))).toEqual({ entries: [], last: 0, end: true })
  expect(await Effect.runPromise(page(read, 41, LIMITS))).toEqual({ entries: [], last: 41, end: true })
  expect(calls.length).toBe(2)
})

test("a page whose last call gave fewer events than it asked, but not all of them fit, is not at the end", async () => {
  // Five events of 600 KiB: one call gives all five, the page takes three.
  const { read } = store(Array.from({ length: 5 }, (_, k) => call(k + 1, "c".repeat(600 * KiB))))
  const got = await Effect.runPromise(page(read, 0, LIMITS))
  expect(numbers(got.entries)).toEqual([1, 2, 3])
  expect(got.end).toBe(false)
})

test("a call cut to the limit is one entry of the page, as the fit gives it", async () => {
  const events = [...starts(2), call(3, "q".repeat(3 * MiB)), ...starts(2, 4)]
  const { read } = store(events)
  const got = await Effect.runPromise(page(read, 0, LIMITS))
  expect(numbers(got.entries)).toEqual([1, 2, 3, 4, 5])
  expect(got.entries[2]).toEqual(given(fit(events[2] as Event, LIMITS.entry)))
  expect(got.entries[2]?.cut).toBe(true)
  expect(got.end).toBe(true)
})

test("a fault in the middle ends the page with it, and gives no entry", async () => {
  const events = [...starts(49), { type: "accepted", n: 50, messages: [message(1, "w".repeat(2 * MiB))] } as Event, ...starts(50, 51)]
  const { read } = store(events)
  const fault = await Effect.runPromise(Effect.flip(page(read, 0, LIMITS)))
  expect(fault).toBeInstanceOf(EntryTooLarge)
  const { n, type, bytes } = fault as EntryTooLarge
  expect({ n, type, bytes }).toEqual({ n: 50, type: "accepted", bytes: bytesOf(JSON.stringify(events[49])) })
})

test("a store's own fault ends the page with it", async () => {
  const fault = await Effect.runPromise(Effect.flip(page(() => Effect.fail("the store failed" as const), 0, LIMITS)))
  expect(fault).toBe("the store failed")
})
