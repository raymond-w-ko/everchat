// The snapshot and older messages: R2 and R3 (docs/host.md, section 3, "R2"
// and "R3", "Admission", 11; section 4, "A message" and "The snapshot";
// lead, ec-jyjxm). Both read a chat with no load and no channel, behind the
// gate (http.ts), with a place of `reads` (reads.ts) for their read of the
// store and their cut only: none is held while the answer is written. Both
// give at most `pageBytes` bytes of JSON.
//
// `cutSnapshot(reads, last, room)` reads the five fields of a snapshot in
// one snapshot of the store (`Reading.snapshot`) and gives its JSON text, at
// most `room` bytes, whole: its `messages` are the longest run that ends at
// the chat's last message, is at most `last` long and fits beside the other
// fields; it may be empty. When the other fields alone pass `room`, it fails
// with `SnapshotTooLarge`, which holds the size in bytes and no text. R2
// gives it `pageBytes`; the socket's snapshot frame gives `pageBytes` less
// its own bytes.
//
// `snapshotRoute(gate, places, limits)` (R2) and `messagesRoute(gate,
// places, limits)` (R3) each give the route for a request: a function of
// the path's chat that runs the gate and then the route's work. They
// register no route: `serve` does.
//
// R2's query: `last`, a whole number from 1 to `history`, decimal digits
// only; 50 when it is not given; else `400 bad_request`. R3's: `from` and
// `to`, both there, decimal digits only, at most 16 of them, with
// `0 <= from < to` and `to - from <= history`; else `400 bad_request`. A
// number of 16 digits above 2**53 - 1 is refused too: no message has such
// an id. Another query parameter is not read and not refused; of a name
// given twice, the first counts.
//
// R3's answer is `{"messages": [...]}`, the messages from `from` up to and
// not with `to`, in the order of their ids; it closes before the message
// that would pass `pageBytes`. Its first message is always given: the
// relations of the limits hold `pageBytes` at or above `entry`, and `entry`
// at or above the largest message.
//
// The answers of a failure: `ReadsBusy` gets `503 busy` with
// `retry-after: 1`; a fault of the store `500 internal` (the gate's);
// `SnapshotTooLarge` `500 internal`, with one warning of Effect's log that
// has the size in bytes and no text.

import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import type { Message, Reading, StoreError, Turn } from "@everchat/core/store"
import { utf8 } from "./fit.ts"
import { type Found, type Gate, JSON_TYPE, NO_STORE, Refused } from "./http.ts"
import type { Limits } from "./limits.ts"
import type { ReadPlaces } from "./reads.ts"

// R2's `last` when it is not given.
export const LAST = 50

// The other fields of a snapshot alone pass its room: `bytes` is their size
// with an empty list.
export class SnapshotTooLarge extends Schema.TaggedError<SnapshotTooLarge>()("SnapshotTooLarge", {
  bytes: Schema.Int
}) {}

// A message's JSON: the store's `Message`, field for field (section 4, "A
// message").
export const messageJson = (message: Message) => ({
  i: message.i,
  kind: message.kind,
  text: message.text,
  size: message.size,
  more: message.more,
  line: message.line,
  turn: message.turn,
  call: message.call,
  launch: message.launch,
  created: message.created
})

// The turn of a snapshot: its four fields, and not its head.
const turnJson = (turn: Turn) => ({ id: turn.id, pick: turn.pick, firstMsg: turn.firstMsg, created: turn.created })

// The JSON text of a list's items, newest kept: the longest run that ends
// at the last item and whose bytes, with a comma between two, are at most
// `room`.
const newest = (items: ReadonlyArray<string>, room: number): Array<string> => {
  const kept: Array<string> = []
  let used = 0
  for (let k = items.length - 1; k >= 0; k--) {
    const text = items[k] as string
    const bytes = utf8(text) + (kept.length > 0 ? 1 : 0)
    if (used + bytes > room) break
    used += bytes
    kept.push(text)
  }
  return kept.reverse()
}

export const cutSnapshot = (
  reads: Reading,
  last: number,
  room: number
): Effect.Effect<string, SnapshotTooLarge | StoreError> =>
  Effect.gen(function*() {
    const { chat, count, messages, running } = yield* reads.snapshot(Effect.gen(function*() {
      const chat = yield* reads.chat
      const count = yield* reads.count
      const messages = yield* reads.messages(Math.max(0, count - last), count)
      const running = yield* reads.runningTurns(null)
      return { chat, count, messages, running }
    }))
    const turn = running[0]
    // The text with a list's items, in the fields' order of section 4: as
    // `JSON.stringify` of the whole would give it.
    const head = "{\"chat\":" + JSON.stringify({ uuid: chat.uuid, pick: chat.pick, goal: chat.goal }) + ",\"seq\":" + JSON.stringify(chat.seq) +
      ",\"count\":" + JSON.stringify(count) + ",\"messages\":["
    const tail = "],\"turn\":" + JSON.stringify(turn === undefined ? null : turnJson(turn)) + "}"
    const text = (list: string) => head + list + tail
    const bytes = utf8(text(""))
    if (bytes > room) return yield* new SnapshotTooLarge({ bytes })
    const kept = newest(messages.map((message) => JSON.stringify(messageJson(message))), room - bytes)
    return text(kept.join(","))
  })

// The query of a request: the first value of each name, decoded. Undefined
// for a value that is no text of percent-escapes.
const queryOf = (url: string): Map<string, string | undefined> => {
  const query = new Map<string, string | undefined>()
  const at = url.indexOf("?")
  if (at === -1) return query
  for (const pair of url.slice(at + 1).split("&")) {
    if (pair === "") continue
    const equals = pair.indexOf("=")
    const decode = (text: string) => {
      try {
        return decodeURIComponent(text.replaceAll("+", " "))
      } catch {
        return undefined
      }
    }
    const name = decode(equals === -1 ? pair : pair.slice(0, equals))
    if (name === undefined || query.has(name)) continue
    query.set(name, decode(equals === -1 ? "" : pair.slice(equals + 1)))
  }
  return query
}

// A whole number of decimal digits only, at most 16 of them, and at most
// 2**53 - 1; else undefined.
const whole = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^[0-9]{1,16}$/.test(text)) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : undefined
}

const bad = () => Effect.fail(new Refused({ code: "bad_request" }))

// A JSON text as the answer.
const answer = (text: string) => HttpServerResponse.text(text, { contentType: JSON_TYPE, headers: NO_STORE })

// The read and the cut, with a place of `reads`; `ReadsBusy` is `503 busy`.
const placed = <A, E>(places: ReadPlaces, effect: Effect.Effect<A, E>) =>
  places.withPlace(effect).pipe(
    Effect.catchTag("ReadsBusy", () => Effect.fail(new Refused({ code: "busy", retryAfter: 1 })))
  )

// R2's work.
export const snapshotWork = (places: ReadPlaces, limits: Pick<Limits, "history" | "pageBytes">) => (found: Found) =>
  Effect.gen(function*() {
    const query = queryOf(found.request.url)
    let last = LAST
    if (query.has("last")) {
      const given = whole(query.get("last"))
      if (given === undefined || given < 1 || given > limits.history) return yield* bad()
      last = given
    }
    const text = yield* placed(places, cutSnapshot(found.reads, last, limits.pageBytes)).pipe(
      Effect.catchTag("SnapshotTooLarge", (error) =>
        Effect.logWarning("the snapshot passes its room").pipe(
          Effect.annotateLogs({ bytes: error.bytes, room: limits.pageBytes }),
          Effect.andThen(Effect.fail(new Refused({ code: "internal" })))
        ))
    )
    return answer(text)
  })

// R3's read and cut: `{"messages": [...]}`, at most `room` bytes but for
// its first message.
export const cutMessages = (reads: Reading, from: number, to: number, room: number): Effect.Effect<string, StoreError> =>
  Effect.map(reads.messages(from, to), (messages) => {
    const kept: Array<string> = []
    let used = utf8("{\"messages\":[]}")
    for (const message of messages) {
      const text = JSON.stringify(messageJson(message))
      const bytes = utf8(text) + (kept.length > 0 ? 1 : 0)
      if (kept.length > 0 && used + bytes > room) break
      used += bytes
      kept.push(text)
    }
    return "{\"messages\":[" + kept.join(",") + "]}"
  })

// R3's work.
export const messagesWork = (places: ReadPlaces, limits: Pick<Limits, "history" | "pageBytes">) => (found: Found) =>
  Effect.gen(function*() {
    const query = queryOf(found.request.url)
    const from = whole(query.get("from"))
    const to = whole(query.get("to"))
    if (from === undefined || to === undefined || from >= to || to - from > limits.history) return yield* bad()
    return answer(yield* placed(places, cutMessages(found.reads, from, to, limits.pageBytes)))
  })

// R2 and R3 behind the gate: the route for a request, as a function of the
// path's chat.
export const snapshotRoute = (gate: Gate, places: ReadPlaces, limits: Pick<Limits, "history" | "pageBytes">) => (chat: string | undefined) =>
  gate.route("R2", chat, snapshotWork(places, limits))

export const messagesRoute = (gate: Gate, places: ReadPlaces, limits: Pick<Limits, "history" | "pageBytes">) => (chat: string | undefined) =>
  gate.route("R3", chat, messagesWork(places, limits))
