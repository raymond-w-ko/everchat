// Tests of the limits and their check at the start: the defaults, the sums,
// each relation on both sides of its edge, and the values that a field
// refuses (docs/host.md, section 8).

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { accepted, DEFAULTS, end, largest, type Limits, limits, LimitsRefused, message, pages, RELATIONS, start } from "./limits.ts"

const KiB = 1024
const MiB = 1024 * 1024

// The limits in use for `given`, or the refusal as plain data.
const used = (given?: Partial<Limits>) => Effect.runSync(limits(given))
const refused = (given: unknown) => {
  const error = Effect.runSync(Effect.flip(limits(given as Partial<Limits>)))
  expect(error).toBeInstanceOf(LimitsRefused)
  return { limits: [...error.limits], rule: error.rule }
}

// The defaults
// ------------

test("the defaults pass, and each is the page's number, times in milliseconds", () => {
  expect(DEFAULTS).toEqual({
    text: 65_536,
    body: 524_288,
    early: 8_192,
    key: 128,
    token: 4_096,
    life: 3_600_000,
    chats: 64,
    said: 30,
    saidWindow: 60_000,
    newChats: 10,
    newChatsWindow: 60_000,
    newTokens: 60,
    newTokensWindow: 60_000,
    requests: 256,
    waiting: 256,
    bodyRead: 10_000,
    lockWait: 10_000,
    hub: 1_024,
    buffer: 4_096,
    bufferBytes: 8_388_608,
    entry: 1_048_576,
    page: 1_000,
    pageBytes: 2_097_152,
    room: 30_000,
    reads: 16,
    readsWait: 30_000,
    request: 30_000,
    lock: 20_000,
    store: 5_000,
    idle: 190_000,
    socketIdle: 120_000,
    chatClients: 32,
    hostClients: 4_096,
    loaded: 200,
    wait: 25_000,
    events: 1_000,
    history: 200,
    auth: 5_000,
    ping: 15_000,
    unload: 360_000
  })
  expect(used()).toEqual(DEFAULTS)
  expect(used({})).toEqual(DEFAULTS)
})

test("a given field is used over its default, and the others keep theirs", () => {
  expect(used({ loaded: 50, text: 1_000 })).toEqual({ ...DEFAULTS, loaded: 50, text: 1_000 })
})

// The sums
// --------

test("the sums at the defaults are the page's: P(65,536) 6, accepted 394,452, message 180,246, end 12,087, start 61", () => {
  expect(pages(65_536)).toBe(6)
  expect(accepted(DEFAULTS)).toBe(394_452)
  expect(message(DEFAULTS)).toBe(180_246)
  expect(end(DEFAULTS)).toBe(12_087)
  expect(start(DEFAULTS)).toBe(61)
  expect(largest(DEFAULTS)).toBe(394_452)
})

test("P(T) counts two pages for each 30,000 bytes past the first, and two for the first", () => {
  expect([1, 30_000, 30_001, 60_000, 60_001].map(pages)).toEqual([2, 2, 4, 4, 6])
})

test("the largest of the sums rises with text; a text of 192 KiB with the default entry is refused", () => {
  const at = (text: number) => largest({ ...DEFAULTS, text })
  const texts = [1, 1_000, 29_000, 30_000, 30_001, 65_536, 100_000, 192 * KiB]
  // accepted rises with each text; the largest never falls, and rises once
  // accepted passes message, the largest below it.
  const sums = texts.map(at)
  const accepteds = texts.map((text) => accepted({ ...DEFAULTS, text }))
  for (let i = 1; i < texts.length; i++) {
    expect(accepteds[i]!).toBeGreaterThan(accepteds[i - 1]!)
    expect(sums[i]!).toBeGreaterThanOrEqual(sums[i - 1]!)
  }
  expect(at(1)).toBe(180_246)
  expect(at(29_000)).toBe(180_246)
  expect(accepted({ ...DEFAULTS, text: 29_000 })).toBe(174_448)
  expect(at(30_001)).toBe(180_848)
  expect(at(192 * KiB)).toBe(54 + 14 * 197 + 6 * 192 * KiB)
  expect(at(192 * KiB)).toBeGreaterThan(MiB)
  expect(refused({ text: 192 * KiB })).toEqual({
    limits: ["entry", "text"],
    rule: "`entry` ≥ the largest of `accepted`, `message`, `end` and `start`"
  })
})

// The relations
// -------------

// Each row of P3: the set at its edge passes, and one step past it is the
// row's error.
const RULES = {
  body: { limits: ["body", "text"], rule: "`body` ≥ `text` + 11" },
  entry: { limits: ["entry", "text"], rule: "`entry` ≥ the largest of `accepted`, `message`, `end` and `start`" },
  entryBuffer: { limits: ["entry", "buffer"], rule: "`entry` ≤ `buffer` in bytes" },
  pageEntry: { limits: ["page", "entry"], rule: "`page` ≥ `entry`" },
  pageBuffer: { limits: ["page", "buffer"], rule: "`page` ≤ `buffer` in bytes, and `page` in events ≤ `buffer` in entries" },
  idle: {
    limits: ["idle", "wait", "request", "store", "ping"],
    rule: "`idle` ≥ 2 × (`wait` + 2 × (`request` + `store`)), and `idle` ≥ 2 × `ping`, and `idle` ≤ 255,000"
  },
  socketIdle: { limits: ["socketIdle", "ping"], rule: "the WebSocket's idle limit (`socketIdle`) ≥ 2 × `ping`, and ≤ 960,000" }
} as const

const edge = (pass: Partial<Limits>, fail: Partial<Limits>, rule: { readonly limits: ReadonlyArray<string>; readonly rule: string }) => {
  expect(used(pass)).toEqual({ ...DEFAULTS, ...pass })
  expect(refused(fail)).toEqual({ limits: [...rule.limits], rule: rule.rule })
}

test("1. body ≥ text + 11: at the edge it passes, one byte under it is refused", () => {
  edge({ body: 65_536 + 11 }, { body: 65_536 + 10 }, RULES.body)
  edge({ text: 1_000, body: 1_011 }, { text: 1_001, body: 1_011 }, RULES.body)
})

test("2. entry ≥ the largest sum: at 394,452 it passes, at 394,451 it is refused", () => {
  edge({ entry: 394_452 }, { entry: 394_451 }, RULES.entry)
  // With a small text, message is the largest.
  edge({ text: 1_000, entry: 180_246 }, { text: 1_000, entry: 180_245 }, RULES.entry)
})

test("3. entry ≤ buffer in bytes: at the edge it passes, one byte over it is refused", () => {
  edge({ bufferBytes: MiB, pageBytes: MiB }, { bufferBytes: MiB - 1, pageBytes: MiB - 1 }, RULES.entryBuffer)
  edge({ entry: 8 * MiB, pageBytes: 8 * MiB }, { entry: 8 * MiB + 1, pageBytes: 8 * MiB + 1 }, RULES.entryBuffer)
})

test("4. page ≥ entry: at the edge it passes, one byte under it is refused", () => {
  edge({ pageBytes: MiB }, { pageBytes: MiB - 1 }, RULES.pageEntry)
})

test("5. page ≤ buffer, in bytes and in entries: at each edge it passes, one past it is refused", () => {
  edge({ pageBytes: 8 * MiB }, { pageBytes: 8 * MiB + 1 }, RULES.pageBuffer)
  edge({ buffer: 1_000 }, { buffer: 999 }, RULES.pageBuffer)
  edge({ page: 4_096 }, { page: 4_097 }, RULES.pageBuffer)
})

test("6. idle: ≥ 2 × (wait + 2 × (request + store)), ≥ 2 × ping, ≤ 255,000; each edge passes, one past it is refused", () => {
  edge({ idle: 190_000 }, { idle: 189_999 }, RULES.idle)
  edge({ wait: 20_000, idle: 180_000 }, { wait: 20_001, idle: 180_000 }, RULES.idle)
  edge({ request: 20_000, idle: 150_000 }, { request: 20_001, idle: 150_000 }, RULES.idle)
  edge({ store: 1_000, idle: 174_000 }, { store: 1_001, idle: 174_000 }, RULES.idle)
  // ping at half of idle; the WebSocket's limit rises with it, so that only idle's row is in play.
  edge({ ping: 95_000, socketIdle: 190_000 }, { ping: 95_001, socketIdle: 190_002 }, RULES.idle)
  edge({ idle: 255_000 }, { idle: 255_001 }, RULES.idle)
})

test("7. the WebSocket's idle limit: ≥ 2 × ping and ≤ 960,000; each edge passes, one past it is refused", () => {
  edge({ socketIdle: 30_000 }, { socketIdle: 29_999 }, RULES.socketIdle)
  edge({ ping: 60_000 }, { ping: 60_001 }, RULES.socketIdle)
  edge({ socketIdle: 960_000 }, { socketIdle: 960_001 }, RULES.socketIdle)
})

test("8. hub ≥ 1: 1 passes; 0 is refused, by the field's own range first", () => {
  expect(used({ hub: 1 })).toEqual({ ...DEFAULTS, hub: 1 })
  expect(refused({ hub: 0 })).toEqual({ limits: ["hub"], rule: "a whole number from 1 to 65536" })
})

test("the table of relations has the page's eight rows, in its order; each holds at the defaults, and the hub's row refuses 0 by itself", () => {
  expect(RELATIONS.map((row) => [row.limits, row.rule])).toEqual([
    ...[RULES.body, RULES.entry, RULES.entryBuffer, RULES.pageEntry, RULES.pageBuffer, RULES.idle, RULES.socketIdle].map((row) => [row.limits, row.rule]),
    [["hub"], "`hub` ≥ 1"]
  ])
  for (const row of RELATIONS) expect(row.holds(DEFAULTS)).toBe(true)
  const hub = RELATIONS[7]!
  expect(hub.holds({ ...DEFAULTS, hub: 1 })).toBe(true)
  expect(hub.holds({ ...DEFAULTS, hub: 0 })).toBe(false)
})

test("the relations are checked in the page's order: the first that fails is the error", () => {
  // body, entry and idle all fail: body's row is first.
  expect(refused({ text: 192 * KiB, body: 100, idle: 1 })).toEqual({ limits: [...RULES.body.limits], rule: RULES.body.rule })
  // entry and idle fail: entry's row comes before idle's.
  expect(refused({ entry: 1_000, pageBytes: 1_000, idle: 1 })).toEqual({ limits: [...RULES.entry.limits], rule: RULES.entry.rule })
})

// The values of a field
// ---------------------

test("each field is a whole number from 1 to 2**31 - 1: 0, a fraction, NaN, 2**31, a text are each refused, never clamped", () => {
  const rule = "a whole number from 1 to 2147483647"
  expect(refused({ loaded: 0 })).toEqual({ limits: ["loaded"], rule })
  expect(refused({ said: 1.5 })).toEqual({ limits: ["said"], rule })
  expect(refused({ reads: Number.NaN })).toEqual({ limits: ["reads"], rule })
  expect(refused({ history: 2 ** 31 })).toEqual({ limits: ["history"], rule })
  expect(refused({ token: "4096" })).toEqual({ limits: ["token"], rule })
  expect(refused({ auth: -5_000 })).toEqual({ limits: ["auth"], rule })
  expect(refused({ events: Number.POSITIVE_INFINITY })).toEqual({ limits: ["events"], rule })
  expect(refused({ chats: undefined })).toEqual({ limits: ["chats"], rule })
  expect(refused({ token: null })).toEqual({ limits: ["token"], rule })
  // Both ends are taken.
  expect(used({ loaded: 1, hostClients: 2 ** 31 - 1 })).toEqual({ ...DEFAULTS, loaded: 1, hostClients: 2 ** 31 - 1 })
})

test("readsWait: 30,000 ms by default (the row `reads`: the next waits at most 30 s); a given wait is used, and is held to the range of the other waits", () => {
  expect(DEFAULTS.readsWait).toBe(30_000)
  expect(used({ readsWait: 1 })).toEqual({ ...DEFAULTS, readsWait: 1 })
  expect(used({ readsWait: 2 ** 31 - 1 })).toEqual({ ...DEFAULTS, readsWait: 2 ** 31 - 1 })
  const rule = "a whole number from 1 to 2147483647"
  for (const value of [0, 2.5, 2 ** 31, "30000"]) {
    expect(refused({ readsWait: value })).toEqual({ limits: ["readsWait"], rule })
    expect(refused({ lockWait: value })).toEqual({ limits: ["lockWait"], rule })
  }
})

test("hub: 65,536 passes, 65,537 is refused", () => {
  expect(used({ hub: 65_536 })).toEqual({ ...DEFAULTS, hub: 65_536 })
  expect(refused({ hub: 65_537 })).toEqual({ limits: ["hub"], rule: "a whole number from 1 to 65536" })
  expect(refused({ hub: 2 ** 31 - 1 })).toEqual({ limits: ["hub"], rule: "a whole number from 1 to 65536" })
})

test("key: a whole number from 1 to 128, the core's bound of a sender's key: 128 and 1 pass; 129, 0, 1.5, 2**31 - 1 and a text are refused by the field's own range; the relations keep their eight rows", () => {
  expect(used({ key: 128 })).toEqual({ ...DEFAULTS, key: 128 })
  expect(used({ key: 1 })).toEqual({ ...DEFAULTS, key: 1 })
  const rule = "a whole number from 1 to 128"
  for (const value of [129, 0, 1.5, 2 ** 31 - 1, "128"]) {
    expect(refused({ key: value })).toEqual({ limits: ["key"], rule })
  }
  // The field's own check, not a ninth row of the relations.
  expect(RELATIONS.length).toBe(8)
  expect(RELATIONS.some((row) => row.limits.includes("key"))).toBe(false)
})

test("a name that is no limit is refused, also in an object that the type check did not see", () => {
  expect(refused({ loads: 200 })).toEqual({ limits: ["loads"], rule: "no such limit" })
  // A deployment's numbers, read as JSON: a typo, and a name of Object's own.
  expect(refused(JSON.parse(`{"text": 1000, "bufer": 10}`))).toEqual({ limits: ["bufer"], rule: "no such limit" })
  expect(refused(JSON.parse(`{"__proto__": 5}`))).toEqual({ limits: ["__proto__"], rule: "no such limit" })
  expect(refused({ toString: 5 })).toEqual({ limits: ["toString"], rule: "no such limit" })
})

test("each given field is read one time", () => {
  let reads = 0
  const given = Object.defineProperty({}, "loaded", { enumerable: true, get: () => (++reads, 7) })
  expect(used(given as Partial<Limits>).loaded).toBe(7)
  expect(reads).toBe(1)
})
