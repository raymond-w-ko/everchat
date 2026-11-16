// The fit and the pages
// =====================
// The fit of one entry, and the read of a chat's events from the store a
// page at a time (docs/host.md, section 8, "The bytes of one entry" and
// "Pages"; section 4, "`cut`"; lead, ec-3xoc2). Every path of the host that
// gives an event or a piece to a client fits it here, after the store's
// read or the hub's take, so a live event and the same event read later
// are equal byte for byte, `cut` too.
//
// `fit(entry, limit)`: the JSON of one `TurnEvent` and its bytes (UTF-8),
// made one time for the entry; the host puts that same text into each
// buffer. Under the limit `entry` the JSON is `JSON.stringify` of the
// event, field for field, with no field `cut`. Over it:
//
// - a `call` or an `end`: its long text (`program`; `why`) is cut to the
//   longest start whose JSON, with `"cut":true` after the text, is at most
//   the limit. The cut falls between two characters (code points), never
//   between the two halves of a pair of surrogates. It depends on the event
//   and the limit only. (F4)
// - a piece: dropped. (F3)
// - an `accepted`, a `message` or a `start` (an event written under larger
//   limits, section 8, S2), or a `call` or an `end` that does not fit even
//   with an empty text: `EntryTooLarge`, a fault with the event's number,
//   its type and its size in bytes, and no text of it.
//
// The bytes of a cut, with no JSON of each start. `JSON.stringify` writes
// each character of a string on its own, so the JSON of the cut event is
// the JSON of the event with an empty text and `"cut":true` (its `base`)
// plus, for each character of the start, the bytes of its escape: 2 for
// `"`, `\` and the five short escapes, 6 for another control character and
// for a lone half of a pair (`\u00XX`, `\udXXX`), else its UTF-8 bytes (1
// to 4). One pass over the text adds them up and stops at the first
// character that would pass the limit. Its cost: one JSON of the whole
// event (to find that it is over), one pass over the start of the text, one
// JSON of the cut event and one count of its bytes, each linear in the
// size of the event; no search and no JSON of a start but the last.
//
// `page(read, after, limits)`: the next page of the events after the number
// `after`. It asks `read` (the store's `eventsAfter`) for at most 100
// events in one call, fits each, and closes the page before the entry that
// would take it past `pageBytes` (the sum of its entries' JSON) or `page`
// entries; while the page has room it reads on. The events of a call that
// did not go into the page are not kept: the next page reads them again,
// after the page's last number. The read is at the store's end when a call
// gave fewer events than it asked for, and each of them is in the page. A
// page's first entry always fits, since `entry` ≤ `pageBytes` (the checks
// at start). An `EntryTooLarge` ends the page with that fault, and the
// entries before it are not given by it (the caller ends its client with
// `internal`).
//
// Pure code over the function that it is given: no service of the host and
// no clock.

import { Effect, Schema } from "effect"
import type { Event } from "@everchat/core/store"

// The core's `TurnEvent` (`packages/core/src/turn.ts`): the store's `Event`
// and the three pieces. It is written here, not imported: `tsc` follows an
// import of a type into `turn.ts` and its imports, which need what this
// package's program has not (`TextEncoder`, Node's modules). fit.test.ts
// checks that the two types are the same.
export type TurnEvent =
  | Event
  | { readonly type: "text" | "thought" | "program"; readonly turn: number; readonly delta: string }

// An entry that the host gives: its JSON, the bytes of that JSON, its
// number (`null` for a piece), and whether its long text was cut.
export interface Entry {
  readonly _tag: "Entry"
  readonly json: string
  readonly bytes: number
  readonly n: number | null
  readonly cut: boolean
}

// A piece whose JSON was over the limit, with its bytes.
export interface Dropped {
  readonly _tag: "Dropped"
  readonly bytes: number
}

// A numbered event that cannot be given: whole it is over the limit, and
// it has no long text to cut (or one cut to nothing is still over). It
// holds the event's number, its type and its size in bytes; no text of it.
export class EntryTooLarge extends Schema.TaggedError<EntryTooLarge>()("EntryTooLarge", {
  n: Schema.Number,
  type: Schema.String,
  bytes: Schema.Number
}) {}

// The limits that a page uses, as the host's `Limits` names them: `entry`
// in bytes, `page` in entries and `pageBytes` in bytes.
export interface PageLimits {
  readonly entry: number
  readonly page: number
  readonly pageBytes: number
}

// A page: its entries, the number of its last entry (`after` when it has
// none), and whether the read is at the store's end.
export interface Page {
  readonly entries: ReadonlyArray<Entry>
  readonly last: number
  readonly end: boolean
}

// The most events that a page asks the store for in one call.
export const CALL = 100

// The bytes of `text` in UTF-8. A lone half of a pair counts 3, as
// U+FFFD; the JSON of `JSON.stringify` has none.
export const utf8 = (text: string): number => {
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0) as number
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

// The bytes that one character (a code point, or a lone half of a pair)
// takes inside a string of `JSON.stringify`.
const escaped = (code: number): number => {
  if (code === 0x22 || code === 0x5c) return 2 // \" and \\
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2 // \b \t \n \f \r
  if (code < 0x20) return 6 // \u00XX
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code >= 0xd800 && code <= 0xdfff) return 6 // a lone half: \udXXX
  return code < 0x10000 ? 3 : 4
}

const entry = (json: string, bytes: number, n: number | null, cut: boolean): Entry => ({ _tag: "Entry", json, bytes, n, cut })

// The event `event` with its long text `field` cut to fit `limit`, or the
// fault when even an empty text does not fit.
const cut = <A extends { readonly type: string; readonly n: number }>(event: A, field: "program" | "why", text: string, limit: number, whole: number) => {
  const base = utf8(JSON.stringify({ ...event, [field]: "", cut: true }))
  if (base > limit) return new EntryTooLarge({ n: event.n, type: event.type, bytes: whole })
  let bytes = base
  let end = 0
  for (const character of text) {
    const more = escaped(character.codePointAt(0) as number)
    if (bytes + more > limit) break
    bytes += more
    end += character.length
  }
  const json = JSON.stringify({ ...event, [field]: text.slice(0, end), cut: true })
  const counted = utf8(json)
  // The sum and the count are the same by the escapes above; a difference
  // is a fault of this module.
  if (counted !== bytes) throw new Error(`the fit counted ${bytes} bytes for a cut, and its JSON has ${counted}`)
  return entry(json, counted, event.n, true)
}

// The fit of one entry to the limit `limit`, in bytes (above).
export const fit = (event: TurnEvent, limit: number): Entry | Dropped | EntryTooLarge => {
  const json = JSON.stringify(event)
  const bytes = utf8(json)
  const n = "n" in event ? event.n : null
  if (bytes <= limit) return entry(json, bytes, n, false)
  switch (event.type) {
    case "text":
    case "thought":
    case "program":
      return { _tag: "Dropped", bytes }
    case "call":
      return cut(event, "program", event.program, limit, bytes)
    case "end":
      return event.why === null ? new EntryTooLarge({ n: event.n, type: event.type, bytes }) : cut(event, "why", event.why, limit, bytes)
    case "accepted":
    case "message":
    case "start":
      return new EntryTooLarge({ n: event.n, type: event.type, bytes })
  }
}

// The next page of the events after `after`, read with `read` (above).
export const page = <E, R>(
  read: (after: number, limit: number) => Effect.Effect<ReadonlyArray<Event>, E, R>,
  after: number,
  limits: PageLimits
): Effect.Effect<Page, E | EntryTooLarge, R> =>
  Effect.gen(function*() {
    if (limits.entry > limits.pageBytes || limits.page < 1) {
      return yield* Effect.die(new Error(`a page needs entry ≤ pageBytes and page ≥ 1, not ${limits.entry}, ${limits.pageBytes} and ${limits.page}`))
    }
    const entries: Array<Entry> = []
    let bytes = 0
    let last = after
    while (true) {
      const asked = Math.min(CALL, limits.page - entries.length)
      const events = yield* read(last, asked)
      for (const event of events) {
        const fitted = fit(event, limits.entry)
        if (fitted._tag === "EntryTooLarge") return yield* fitted
        // A numbered event is never dropped; an `Entry` is all that is left.
        const given = fitted as Entry
        if (entries.length === limits.page || bytes + given.bytes > limits.pageBytes) return { entries, last, end: false }
        entries.push(given)
        bytes += given.bytes
        last = event.n
      }
      if (events.length < asked) return { entries, last, end: true }
      if (entries.length === limits.page) return { entries, last, end: false }
    }
  })
