// R1: a message in over HTTP, `POST /v1/chats/{chat}/messages` (docs/host.md,
// section 3, "R1: a message in"; section 5; lead, ec-jyjxm). It runs behind
// the gate (http.ts): the place, the origin, the token and the chat. Then,
// in this order:
//
// 1. the count of the rate (`Host.count`): each request that passed the
//    gate's three checks counts, a repeat of a key too, and one that then
//    fails; past the limit, `429 too_many` with `retry-after`, the whole
//    seconds to the window's end;
// 2. `Content-Type` is `application/json`, with no parameter or with
//    `charset=utf-8` alone (letter case aside), else
//    `415 unsupported_type`: a body of another charset is no UTF-8;
// 3. `Idempotency-Key`, when it is there, is 1 to `key` bytes of visible
//    ASCII (0x21 to 0x7E), else `400 bad_request`;
// 4. the body, by the gate's read (`408 timeout`, `413 too_large`);
// 5. the body's form: UTF-8, JSON, an object with the one field `text`, a
//    string; anything else (another field, `images` too, no field, another
//    type, bytes that are no UTF-8 or no JSON) is `400 bad_request`;
// 6. the message in (`Host.say`).
//
// `200` is `{"n": <the accepted event's number>, "first": <the id of the
// first page>, "last": <the id of the last page>, "repeat": <boolean>}`.
// The errors of the message in: `MessageRefused` (the text or the key)
// `400 bad_request`; `NoChat` `404 no_chat`, the gate's own answer;
// `LaunchLive` `409 chat_elsewhere`; `LoadedFull` `503 busy` with
// `retry-after: 5`; `ChatBusy` `503 busy` with `retry-after: 1`;
// `StoreError` and `StackFailed` `500 internal` (the host logs the store's
// operation). No answer and no log line of this file holds the message's
// text or the key.
//
// A client that ends its request: the gate's fiber is interrupted, the host
// waits for the work under the lock, and no answer is written. A message
// whose transaction was done stays logged; its key gives its numbers again.

import { Effect } from "effect"
import { Host } from "./host.ts"
import { type Found, type Gate, jsonAnswer, Refused } from "./http.ts"

// `application/json`, and at most a parameter `charset=utf-8`.
const JSON_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i

// A key: 1 to `most` bytes of visible ASCII.
const keyIsValid = (key: string, most: number): boolean => key.length >= 1 && key.length <= most && /^[\x21-\x7e]+$/.test(key)

// The text of a body of the form `{"text": <string>}`, else undefined.
const textOf = (body: Uint8Array): string | undefined => {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } catch {
    return undefined
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const keys = Object.keys(json)
  if (keys.length !== 1 || keys[0] !== "text") return undefined
  const text = (json as { readonly text: unknown }).text
  return typeof text === "string" ? text : undefined
}

const refuse = (code: Refused["code"], retryAfter?: number) =>
  Effect.fail(retryAfter === undefined ? new Refused({ code }) : new Refused({ code, retryAfter }))

// R1's work, after the gate's checks.
export const messageWork = (gate: Gate, host: typeof Host.Service) => (found: Found) =>
  Effect.gen(function*() {
    const { request, tenant, chat } = found
    yield* host.count(tenant, chat).pipe(Effect.catchTag("TooMany", (error) => refuse("too_many", error.seconds)))
    if (!JSON_TYPE.test(request.headers["content-type"] ?? "")) return yield* refuse("unsupported_type")
    const key = request.headers["idempotency-key"]
    if (key !== undefined && !keyIsValid(key, host.limits.key)) return yield* refuse("bad_request")
    const text = textOf(yield* gate.body(request))
    if (text === undefined) return yield* refuse("bad_request")
    const sent = yield* host.say(tenant, chat, text, key ?? null).pipe(
      Effect.catchTags({
        MessageRefused: () => refuse("bad_request"),
        NoChat: () => refuse("no_chat"),
        LaunchLive: () => refuse("chat_elsewhere"),
        LoadedFull: () => refuse("busy", 5),
        ChatBusy: () => refuse("busy", 1),
        StoreError: () => refuse("internal"),
        StackFailed: () => refuse("internal")
      })
    )
    const first = sent.messages[0]
    const last = sent.messages[sent.messages.length - 1]
    // A message has one page at least: none is a fault of the host.
    if (first === undefined || last === undefined) return yield* refuse("internal")
    return jsonAnswer({ n: sent.accepted, first: first.i, last: last.i, repeat: sent.repeat })
  })

// R1 behind the gate: the route for a request, as a function of the path's
// chat.
export const messageRoute = (gate: Gate, host: typeof Host.Service) => (chat: string | undefined) =>
  gate.route("R1", chat, messageWork(gate, host))
