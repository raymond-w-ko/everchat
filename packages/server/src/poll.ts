// The events with no stream: R5 (docs/host.md, section 3, "R5: the events,
// with no stream", "Ways and routes", "Admission" 3, 10 and 11; section 8,
// "Pages"; lead, ec-hmsqu). `GET /v1/chats/{chat}/events?after={n}&limit={k}
// &wait={s}`, behind the gate (http.ts); the choice between R4 and R5 by the
// header `Accept` is `serve`'s.
//
// The query: `after`, required, a whole number from 0; `limit`, from 1 to
// the limit `events`, 100 when it is not given; `wait`, whole seconds from 0
// to the limit `wait` (in ms) over 1,000, rounded down, 0 when it is not
// given. Each is read by the gate's `wholeNumber`; another value gets
// `400 bad_request`, before any hold, client or read. Of a name given twice
// the first counts; another name is not read and not refused. An `after`
// above the chat's `seq` is not refused.
//
// The answer: `200`, `{"events":[...]}`, the chat's numbered events after
// `after` in the order of their numbers, each as the fit made it, at most
// `limit` of them and at most `pageBytes` bytes of their JSON in all (fit.ts,
// `page`: the first always fits). No piece. Fewer than `limit` is no end.
// An event over `entry` that the fit cannot cut: `500 internal`, with one
// warning of Effect's log with its number and its size, and no text.
//
// A read takes a place of `reads` for its read and its fit only; `ReadsBusy`
// gives `503 busy` with `retry-after: 1`. The answer is written with none.
//
// With `wait` 0: never a client; no channel is held; one read, the answer.
//
// With a `wait` above 0, in this order: the hold of the channel;
// `addClient(after, { pieces: false })`, a client that gets no piece
// (`ClientRefused`: `503 busy` with no `retry-after`); the first read. With
// events: the answer. With none, the join's check: when it does not join
// (an event came between: the channel's `last` is above `after`), it reads
// again and answers, in the same place of `requests` and the same deadline.
// When it joins: the gate's step `leave` gives the place of `requests` back
// and stops the deadline; it waits, with no place of `requests` or of
// `reads`, for the first numbered event that is given to it, or for `wait`
// seconds. The channel gives it no piece (lead, ec-cxuj5): a burst of
// pieces, also one between the join and its first take, puts nothing into
// its buffer and cannot end it. Then it is a client no more (it
// leaves the channel, and the hold is let go), takes a place again by the
// gate's step `again` (none free: `503 busy` with `retry-after: 1`), with a
// new deadline, reads and answers, possibly `{"events":[]}`.
//
// The ends of the wait: the host's stop (the client ends with `stop`) gives
// `503 busy` with `retry-after: 1`; any other end of the client (an event
// that cannot be given, `internal`; `slow`, which with no piece only
// numbered events can cause) reads and answers as after an event. An
// interruption (its client went away) ends the wait: the client leaves the
// channel and the hold is let go, in the scope's finalizers. The token's
// `exp` is not looked at again: a request that began before it is answered.
//
// The log holds the gate's line and, for an event over `entry`, the event's
// number and size: never a query, a text or a token.

import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import type { Client, Reason, Registry } from "./channel.ts"
import { page, type Page } from "./fit.ts"
import { type Found, type Gate, JSON_TYPE, NO_STORE, Refused, type Steps, wholeNumber } from "./http.ts"
import type { Limits } from "./limits.ts"
import type { ReadPlaces } from "./reads.ts"

// R5's `limit` when it is not given.
export const LIMIT = 100

// The limits that R5 uses, as the host's `Limits` names them.
export type PollLimits = Pick<Limits, "entry" | "pageBytes" | "events" | "wait">

// The query of R5: `wait` in whole seconds.
export interface PollQuery {
  readonly after: number
  readonly limit: number
  readonly wait: number
}

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

// R5's query from a request's URL, or undefined when it is not valid.
export const pollQuery = (url: string, limits: Pick<Limits, "events" | "wait">): PollQuery | undefined => {
  const query = queryOf(url)
  const after = wholeNumber(query.get("after"))
  if (after === undefined) return undefined
  let limit = LIMIT
  if (query.has("limit")) {
    const given = wholeNumber(query.get("limit"))
    if (given === undefined || given < 1 || given > limits.events) return undefined
    limit = given
  }
  let wait = 0
  if (query.has("wait")) {
    const given = wholeNumber(query.get("wait"))
    if (given === undefined || given > Math.floor(limits.wait / 1000)) return undefined
    wait = given
  }
  return { after, limit, wait }
}

// The answer of a page: its entries' JSON, as the fit made it.
const answer = (got: Page) =>
  HttpServerResponse.text("{\"events\":[" + got.entries.map((entry) => entry.json).join(",") + "]}", {
    contentType: JSON_TYPE,
    headers: NO_STORE
  })

// How a wait ended: an event came, its time passed, or the client ended.
type Waited = { readonly _tag: "Event" } | { readonly _tag: "Time" } | { readonly _tag: "Ended"; readonly reason: Reason | null }

// Waits for the first numbered event given to `client`, or its end. The
// client gets no piece and no frame of the host: each text that it takes is
// a numbered event above `after` (the give skips a client at or above the
// event's number). Its `given` is not read here: the buffer's put wakes the
// reader, and Effect runs a woken fiber at once, inside the give's step and
// before that step sets `given` (lead, ec-cxuj5).
const waitForEvent = (client: Client): Effect.Effect<Waited> =>
  Effect.map(client.take, (taken): Waited => (taken._tag === "End" ? { _tag: "Ended", reason: taken.reason } : { _tag: "Event" }))

// What the part as a client gave: a page to answer, or the end of a wait.
type AsClient = { readonly _tag: "Answer"; readonly page: Page } | { readonly _tag: "Waited"; readonly waited: Waited }

// R5's work.
export const pollWork = <L>(registry: Registry<L>, places: ReadPlaces, limits: PollLimits) => (found: Found, steps: Steps) =>
  Effect.gen(function*() {
    const query = pollQuery(found.request.url, limits)
    if (query === undefined) return yield* new Refused({ code: "bad_request" })
    const { after, limit, wait } = query
    // One read of a page after `after`, with a place of `reads` for the read
    // and the fit only.
    const read = places.withPlace(
      page((from, most) => found.reads.eventsAfter(from, most), after, { entry: limits.entry, page: limit, pageBytes: limits.pageBytes })
    ).pipe(
      Effect.catchTag("ReadsBusy", () => Effect.fail(new Refused({ code: "busy", retryAfter: 1 }))),
      Effect.catchTag("EntryTooLarge", (fault) =>
        Effect.logWarning("an event of R5's read is over the limit entry").pipe(
          Effect.annotateLogs({ n: fault.n, bytes: fault.bytes }),
          Effect.andThen(Effect.fail(new Refused({ code: "internal" })))
        ))
    )
    if (wait === 0) return answer(yield* read)
    const asClient = yield* Effect.scoped(Effect.gen(function*() {
      const channel = yield* registry.held(found.tenant, found.chat)
      const client = yield* Effect.acquireRelease(
        channel.addClient(after, { pieces: false }).pipe(Effect.catchTag("ClientRefused", () => Effect.fail(new Refused({ code: "busy" })))),
        (client) => channel.removeClient(client)
      )
      const first = yield* read
      if (first.entries.length > 0) return { _tag: "Answer", page: first } as AsClient
      // An event came between the read and the check: read again, in the
      // same place and deadline.
      if (!(yield* channel.join(client))) return { _tag: "Answer", page: yield* read } as AsClient
      yield* steps.leave
      const waited = yield* Effect.timeoutOrElse(waitForEvent(client), {
        duration: wait * 1000,
        orElse: () => Effect.succeed({ _tag: "Time" } as const)
      })
      return { _tag: "Waited", waited } as AsClient
    }))
    if (asClient._tag === "Answer") return answer(asClient.page)
    const waited = asClient.waited
    if (waited._tag === "Ended" && waited.reason === "stop") return yield* new Refused({ code: "busy", retryAfter: 1 })
    yield* steps.again
    return answer(yield* read)
  })

// R5 behind the gate: the route for a request, as a function of the path's
// chat.
export const pollRoute = <L>(gate: Gate, registry: Registry<L>, places: ReadPlaces, limits: PollLimits) => (chat: string | undefined) =>
  gate.route("R5", chat, pollWork(registry, places, limits))
