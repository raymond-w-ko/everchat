// Request
// =======
// One request to a vendor's model, and its reply, in a form that is the same
// for every vendor. A wire (openai.ts) turns a request into the vendor's
// bytes, and the vendor's stream into events.
//
// Three rules shape these types:
//
// - The vendor's own items go back untouched. A reply holds the model's
//   output items exactly as the vendor sent them (`output`), and the next
//   request of the turn sends them back in a `turn` item. The wire never
//   builds them again from our own fields: reasoning items carry encrypted
//   content, and any change makes the vendor drop them.
// - A request is append only inside a turn. Its items are the turn items of
//   the database (docs/schema.html, `turn_item`): `user`, `turn`, `back`.
// - The memory decides where a cache entry may end (`Block.mark`). The wire
//   turns that into the vendor's own marks.
//
// A wire sends one request once. It does not send it again: its error says
// whether another try can help (`retry`), and whether the model had already
// begun to answer (`began`). The code that owns the request decides.

import { Schema } from "effect"
import type { Stream } from "effect"
import type { Pick } from "./store.ts"

// One piece of text in a request. `mark`: a cache entry may end after it.
export interface Block {
  readonly text: string
  readonly mark: boolean
}

// An image in a request, as stored: its MIME type and its bytes.
export interface Picture {
  readonly type: string
  readonly bytes: Uint8Array
}

// A tool that the model may call. With no `schema`, its input is free text
// (code mode: the input is the program). With a schema, its input is JSON.
export interface Tool {
  readonly name: string
  readonly description: string
  readonly schema?: Record<string, unknown> | undefined
}

// The part of a request before the messages. Turns, compactions and
// subagents all send the same head, so that they share one cache prefix.
export interface Head {
  readonly system: string
  readonly tools: ReadonlyArray<Tool>
}

// The result of one program, by the id of the model's call.
export interface Result {
  readonly id: string
  readonly output: string
  readonly pictures?: ReadonlyArray<Picture> | undefined
}

export type Item =
  // What we say: the view's blocks, then the new text.
  | { readonly kind: "user"; readonly blocks: ReadonlyArray<Block>; readonly pictures?: ReadonlyArray<Picture> | undefined }
  // What the model gave back in an earlier step: the vendor's items, as received.
  | { readonly kind: "turn"; readonly output: ReadonlyArray<unknown> }
  // The results of that step's programs.
  | { readonly kind: "back"; readonly results: ReadonlyArray<Result> }

export interface Request {
  // The chat's id (`chat.uuid`). Turns, compactions and subagents
  // of one chat all send the chat's id.
  readonly session: string
  readonly pick: Pick
  readonly head: Head
  readonly items: ReadonlyArray<Item>
  readonly max?: number | undefined // the most tokens the model may write
  // The vendor's id of an earlier reply whose prefix this request expects to
  // read from the cache. The vendor then says in the reply whether it did,
  // and if not, why (`Reply.diagnosis`).
  readonly baseline?: string | null | undefined
}

// What the vendor says about the cache, against the baseline. `type` is the
// vendor's word: for OpenAI `cache_hit`, `cache_miss`,
// `comparison_response_not_found` or `unavailable`. A miss has a reason, for
// example `input_changed` (our request differs: a bug of ours) or
// `service_tier_changed`.
export interface Diagnosis {
  readonly type: string
  readonly reason: string | null
  readonly missed: number | null // tokens of the baseline's prefix that were not reused
  readonly reusable: number | null // tokens of the baseline's reusable prefix
}

// A program (or a function with JSON input) that the model wants to run.
export interface Call {
  readonly id: string // the vendor's id of the call: its result names it
  readonly name: string
  readonly input: string
}

// The tokens of one request. `input` has no cached part: the whole input is
// input + cacheRead + cacheWrite.
export interface Usage {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly searches: number
}

// Why the model stopped. `max`: it reached the most tokens it may write.
// `filter`: the vendor's content filter stopped it.
export type Stop = "done" | "max" | "filter"

export interface Reply {
  readonly output: ReadonlyArray<unknown> // the vendor's items, as received
  readonly text: string // what the model said, a refusal too
  readonly calls: ReadonlyArray<Call>
  readonly stop: Stop
  readonly usage: Usage | null // null: the vendor gave none
  readonly diagnosis: Diagnosis | null // null: none was asked for, or the vendor gave none
  // Our own judgment of the cache (cache.ts): what the reply should have
  // read, and whether it did. Absent when no watch judged the reply.
  readonly cache?: { readonly verdict: "first" | "small" | "hit" | "partial" | "miss"; readonly expected: number; readonly read: number } | undefined
  readonly pick: Pick // as it ran: the speed can differ from the one asked
  readonly id: string | null // the vendor's id of the reply
  readonly request: string | null // the vendor's id of the HTTP request
}

export type Event =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thought"; readonly delta: string }
  | { readonly type: "program"; readonly delta: string } // the input of a call, as the model writes it
  | { readonly type: "end"; readonly reply: Reply }

// Why a request failed.
//
// - busy: the vendor or the network could not serve it now.
// - limit: the account's quota or budget is used up. A person must act.
// - input: the vendor refused the request itself (a bad field, an input
//   that is too long).
// - auth: the key was refused.
// - policy: the vendor's rules stopped it.
// - cut: the stream ended before the reply did.
// - protocol: the vendor sent something that this wire does not understand.
export const WireErrorKind = Schema.Literals(["busy", "limit", "input", "auth", "policy", "cut", "protocol"])
export type WireErrorKind = typeof WireErrorKind.Type

export class WireError extends Schema.TaggedError<WireError>()("WireError", {
  kind: WireErrorKind,
  message: Schema.String,
  retry: Schema.Boolean, // another try can help
  began: Schema.Boolean, // the model had begun to answer: do not send the same request again blindly
  after: Schema.NullOr(Schema.Number), // seconds to wait first, when the vendor says so
  status: Schema.NullOr(Schema.Int), // the HTTP status
  code: Schema.NullOr(Schema.String), // the vendor's error code
  request: Schema.NullOr(Schema.String) // the vendor's id of the HTTP request
}) {}

// Our code for one vendor's API.
export interface Wire {
  send(request: Request): Stream.Stream<Event, WireError>
}
