// The gate of the host's HTTP routes (docs/host.md, section 3: "The checks
// of each request, in their order", "Admission" 1, 2, 3, 4, 5, 6 and 10, the
// answers' headers, "Origins"; section 4, "An error"; lead, ec-hmsqu). Each
// route of R1 to R5 runs behind it (`route`), and R6 before its upgrade
// (`socket`); R7, the preflight, is its own, and so is a request that is no
// route (`none`).
//
// `makeGate(options)` gives one gate for a host, over the secret, the list of
// origins, the limits and the `Chats` service. The gate holds the one count of
// the requests in flight, and the count of the sockets that wait for their
// `auth`. For a route it runs, before any byte of a body is read:
//
// 1. the place: at most `requests` at one time, with no queue; past it,
//    `503 busy` with `retry-after: 1` at once; then the method: each route
//    has one (R1 `POST`, R2 to R5 `GET`), and another, a `HEAD` too, gets
//    the answer of no route, `404` with no body and no CORS header, and runs
//    no check and no work;
// 2. check 1, the origin: an `Origin` that is not on the list, compared as
//    text, byte for byte, gets `403 forbidden_origin`; no `Origin` passes;
// 3. check 2, the token: the header `Authorization` is `Bearer ` and one
//    token, and `verifyToken` takes it at the time of Effect's `Clock`; any
//    failure gets one `401 unauthorized`, and one line of the log with the
//    check's number (1 for the header) and no part of the token;
// 4. check 3, the chat: the path's chat is one of the token's `chats`, and
//    `Chats.reads(tenant, chat)` finds it; else `404 no_chat`, the same bytes
//    for a chat outside the token, a chat of another tenant and a text that
//    is no UUID;
// 5. the route's own work, a function of what the checks found.
//
// The place counts work, not a connection. It goes back when the route's work
// has ended, done, failed or interrupted, never before; when the answer's
// body is a stream, when that stream has ended, or at the deadline when the
// stream never started (the gate owns the place and the deadline, not the
// stream's pull: a stream whose client went away before its head may never
// be pulled). A
// client that goes away changes one thing only: no answer is written
// (Effect's Bun server interrupts the request's fiber, and the place waits
// for the work's end). Each place that the gate takes (a request's, the place
// of `again`, the waiting place of `admit`) is taken in one step with what
// gives it back: the step cannot be interrupted, and the finalizer is in place
// before any interruptible part of the request; so an interruption at any
// point of a request leaves the counts as they were before it (lead,
// ec-w86sz, 1).
//
// The deadline: `request` from the request's head to the end of its answer.
// At the deadline the gate interrupts the work; when that work has ended, the
// answer is `503 busy` with `retry-after: 1` if no byte of it was sent, else
// the connection closes (the answer's stream is interrupted, and Bun cuts it).
//
// The work's steps (`Steps`) change that for R4 and R5. R4's `client`: the
// request is a client now, and its place goes back at once; its stream, once
// started, lives until its own end, and its `abandon` is the client's one end:
// it runs exactly one time, whatever ends the client (lead, ec-w86sz, 2 and
// 3). The request's scope owns the client's end (lead, ec-u1yzx, 1): Effect's
// server runs each request with a `Scope` of its own in the fiber's context,
// and closes it when the handler's fiber ends, failed or interrupted, or, for
// a stream answer, when that stream ends. At the client's step the gate puts
// the client's end in that scope; so an interruption at any point after the
// step, in the gate or after it returned, ends the client when the request's
// fiber ends. A failure or an interruption that the gate sees ends it at once
// too. An answer that the server sent and that nothing starts keeps its
// deadline. R5's `leave` and `again`: the
// place goes back and the deadline stops at its join, and a place is taken
// again, with a new deadline, after its wait; with no place free, `503 busy`
// at once.
//
// R6 (`socket`): the place, the method and `Upgrade: websocket`, check 1,
// then the work; at its upgrade the work's `admit` takes one of `waiting`
// places for its request's place, in one step, and the gate's deadline is
// over. Its token is its first frame: `token` runs checks 2 and 3 for it,
// with no place and no deadline.
//
// Every answer has `cache-control: no-store`, `referrer-policy: no-referrer`
// and `x-content-type-options: nosniff`. For a request whose `Origin` is on
// the list, each answer, an error too, has `access-control-allow-origin` with
// that origin and `vary: origin`. No answer allows credentials.
//
// The gate's log holds the route's name, the status, the error's code and the
// token check's number: never a query, a header's value, a token or a body.

import { Cause, Clock, Deferred, Effect, Exit, type Fiber, Option, type Redacted, Schema, Scope, Stream } from "effect"
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Chats, Reading } from "@everchat/core/store"
import type { Limits } from "./limits.ts"
import { type Claims, verifyToken } from "./token.ts"

// The answers
// -----------

// The eleven codes of an error (section 4), each with its status and its one
// fixed sentence. No sentence holds a value of the request.
export const ERRORS = {
  bad_request: { status: 400, message: "The request is not valid." },
  unauthorized: { status: 401, message: "The request has no valid token." },
  forbidden_origin: { status: 403, message: "This origin may not use this host." },
  no_chat: { status: 404, message: "This tenant has no chat with this UUID." },
  timeout: { status: 408, message: "The request's body took too long to come." },
  chat_elsewhere: { status: 409, message: "Another process holds this chat." },
  too_large: { status: 413, message: "The request's body is too large." },
  unsupported_type: { status: 415, message: "This route does not take a body of this type." },
  too_many: { status: 429, message: "Too many requests: try again later." },
  internal: { status: 500, message: "The host failed." },
  busy: { status: 503, message: "The host is busy: try again later." }
} as const

export type ErrorCode = keyof typeof ERRORS

export const CODES = Object.keys(ERRORS) as ReadonlyArray<ErrorCode>

// The headers of every answer (the inspector's).
export const NO_STORE = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
} as const

export const JSON_TYPE = "application/json; charset=utf-8"

// A route's work, or the body's read, fails with this to give an error
// answer: its code, a `retry-after` in whole seconds, and `close` to close
// the connection after the answer.
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  code: Schema.Literals(CODES),
  retryAfter: Schema.optionalKey(Schema.Int),
  close: Schema.optionalKey(Schema.Boolean)
}) {}

// A JSON answer: `value` as JSON, with its status, its content type and the
// three headers.
export const jsonAnswer = (value: unknown, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify(value), { status, contentType: JSON_TYPE, headers: NO_STORE })

// The error answer of `code`: `{"error": <code>, "message": <its sentence>}`.
export const errorAnswer = (
  code: ErrorCode,
  options?: { readonly retryAfter?: number; readonly close?: boolean }
): HttpServerResponse.HttpServerResponse => {
  const { status, message } = ERRORS[code]
  const headers: Record<string, string> = { ...NO_STORE }
  if (options?.retryAfter !== undefined) headers["retry-after"] = String(options.retryAfter)
  if (options?.close === true) headers["connection"] = "close"
  return HttpServerResponse.text(JSON.stringify({ error: code, message }), { status, contentType: JSON_TYPE, headers })
}

// The gate
// --------

// The routes behind the gate, by their names in section 3.
export type Route = "R1" | "R2" | "R3" | "R4" | "R5"

// Each route's one method (lead, ec-hmsqu, ruling 1). Effect's router gives
// a `HEAD` to the route of `GET`: it is no route's method, and gets the
// answer of no route.
const METHODS: Record<Route, "GET" | "POST"> = { R1: "POST", R2: "GET", R3: "GET", R4: "GET", R5: "GET" }

export interface GateOptions {
  readonly secret: Redacted.Redacted<Uint8Array>
  // The origins that may send a request with `Origin`, each as text.
  readonly origins: ReadonlyArray<string>
  readonly limits: Limits
  readonly chats: typeof Chats.Service
}

// What the checks found, for the route's work.
export interface Found {
  readonly tenant: string
  readonly chat: string // the path's chat, one of the token's `chats`
  readonly claims: Claims
  readonly reads: Reading // the chat's reads, `Chats.reads(tenant, chat)`
  readonly request: HttpServerRequest.HttpServerRequest
}

// What a socket's token found (R6): what `Found` gives but the request.
export type Authorized = Omit<Found, "request">

// The steps of a route's work with its place and its deadline (lead,
// ec-hmsqu, rulings 2 and 3).
export interface Steps {
  // R4: this request is a client now; `abandon` ends that client. One time:
  // a second call does nothing. The place goes back at once, once. From here
  // the request's deadline ends the work, and the answer's stream when it has
  // not started by then (`abandon` runs, and a later start fails at once);
  // a stream that started lives until its own end. `abandon` is the client's
  // one end (lead, ec-w86sz, 2): the gate runs it exactly one time, never
  // two, whatever ends the client: the work's failure or interruption after
  // this step, or one before the answer left the gate (at once, with no
  // timer left), an answer that is no stream, the deadline with no start of
  // the stream, and the stream's end, done, failed or interrupted. A route
  // puts its client's end in `abandon`, and needs no finalizer of its own in
  // the stream for it. So no client is left.
  //
  // The request's scope (lead, ec-u1yzx, 1 and 2): no code of the gate's own
  // effect sees an interruption that lands as its last uncut step ends (its
  // end has seen a success, and handed the client to a stream that no one
  // will get). So, at this step, the gate puts the client's end into the
  // `Scope` of the fiber's context, where Effect's server puts the request's
  // scope; it runs when that scope closes: at the end of the handler's fiber
  // (an interruption too), or at the end of a stream answer that the server
  // took. With no scope there (a caller that is not Effect's server), the
  // gate's own end decides alone, and that one point remains: the client
  // then ends at the request's deadline, as an answer that nothing starts.
  readonly client: (abandon: Effect.Effect<void>) => Effect.Effect<void>
  // R5: give the place back and stop the deadline. With no place held, it
  // does nothing.
  readonly leave: Effect.Effect<void>
  // R5: take a place again, with a new deadline of `request` from now. With
  // no place free, `Refused` `busy` with `retry-after: 1` at once: there is no
  // queue. With a place held, it does nothing.
  readonly again: Effect.Effect<void, Refused>
}

// What a socket's work gets (R6), before its upgrade.
export interface Upgrading {
  readonly chat: string | undefined // the path's chat, as text
  readonly request: HttpServerRequest.HttpServerRequest
  // The step that the work runs at its upgrade, before it: one of the
  // `waiting` places, and the request's place back, as one step; the
  // gate's deadline is over. Past `waiting`, `Refused` `busy` with no
  // `retry-after`, and the request keeps its place until its answer. It
  // gives the second step, which gives the waiting place back, once (at the
  // socket's good `auth`, or its end). Run again, it gives the same second
  // step and takes nothing.
  readonly admit: Effect.Effect<Effect.Effect<void>, Refused>
}

// A socket's token that does not pass (R6): `unauthorized` (any failure of
// the token; the reason is only in the log), `no_chat` (a chat outside the
// token, a chat of another tenant, a text that is no UUID), `internal` (a
// fault of the store).
export class SocketRefused extends Schema.TaggedError<SocketRefused>()("SocketRefused", {
  code: Schema.Literals(["unauthorized", "no_chat", "internal"])
}) {}

export interface Gate {
  // R1 to R5: the place, the method, the three checks, then `work`, under
  // the deadline. `chat` is the path's chat, as text (undefined: none). It
  // never fails: a `Refused` of the work gives its error answer, any other
  // failure `500 internal`. A method that is not the route's gets the answer
  // of `none`, after the place and before check 1.
  readonly route: <E, R>(
    route: Route,
    chat: string | undefined,
    work: (found: Found, steps: Steps) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | HttpServerRequest.HttpServerRequest>
  // A request that is no route: a place, then `404` with the three headers,
  // no body and no CORS header; past the bound of places, `503 busy` as a
  // route's.
  readonly none: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
  // R6, before its upgrade: the place; `GET` with `Upgrade: websocket`
  // (letter case aside), else the answer of `none`; check 1; then `work`,
  // under the deadline until its `admit`. No header `Authorization` is read.
  readonly socket: <E, R>(
    chat: string | undefined,
    work: (upgrading: Upgrading) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | HttpServerRequest.HttpServerRequest>
  // R6's `auth`: checks 2 and 3 for a token's text and the path's chat, at the
  // time of Effect's `Clock`, with the log lines of `route`. No place, no
  // deadline.
  readonly token: (text: string, chat: string | undefined) => Effect.Effect<Authorized, SocketRefused>
  // R7: a place and check 1 only.
  readonly preflight: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
  // The body of R1: at most `body` bytes, read in at most `bodyRead`; else
  // `Refused` `too_large`, or `timeout` with `close`.
  readonly body: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Uint8Array, Refused>
  // The places taken now.
  readonly inFlight: () => number
  // The waiting places of the sockets taken now.
  readonly waiting: () => number
}

// A whole number of a query (`after`, `limit`, `wait`): decimal digits only,
// at most 16 of them, with a value at most 2**53 - 1; else undefined (a sign,
// a space, a fraction, an exponent, a letter, an empty text).
export const wholeNumber = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^[0-9]{1,16}$/.test(text)) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : undefined
}

// R7's answer for an origin on the list.
const PREFLIGHT = {
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "authorization, content-type, idempotency-key",
  "access-control-max-age": "600"
} as const

// A token check that failed: its number, 1 (the header) to 7.
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  check: Schema.Int
}) {}

// The deadline passed while the answer's stream was sent.
class DeadlinePassed extends Schema.TaggedError<DeadlinePassed>()("DeadlinePassed", {}) {}

// `Bearer ` and one token: no space, tab or line break in it.
const BEARER = /^Bearer ([^\s]+)$/

// The name of a failure for the log: its tag, never its message.
const faultOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") return error._tag
  return Cause.hasInterrupts(cause) ? "interrupted" : "defect"
}

// One line of the gate's log, with these fields only.
const note = (fields: {
  readonly route: string
  readonly status: number
  readonly error?: ErrorCode
  readonly check?: number
  readonly fault?: string
  readonly closed?: true
}) => (fields.status >= 500 || fields.closed === true ? Effect.logWarning : Effect.logInfo)("the gate's answer").pipe(Effect.annotateLogs(fields))

// An action that runs one time.
const once = (action: () => void): (() => void) => {
  let done = false
  return () => {
    if (done) return
    done = true
    action()
  }
}

export const makeGate = (options: GateOptions): Gate => {
  const { secret, origins, limits, chats } = options
  let taken = 0
  let waiting = 0

  // The place: one, or none when all are taken. `give` gives it back once.
  const take = (): (() => void) | null => {
    if (taken >= limits.requests) return null
    taken += 1
    return once(() => {
      taken -= 1
    })
  }

  // The request's `Origin`, and whether it is on the list (text, byte for
  // byte).
  const originOf = (request: HttpServerRequest.HttpServerRequest) => {
    const origin = request.headers["origin"]
    return { origin, listed: origin !== undefined && origins.includes(origin) }
  }

  // The headers of every answer, and the origin's when it is on the list.
  const finish = (response: HttpServerResponse.HttpServerResponse, origin: string | undefined, listed: boolean) => {
    let answer = HttpServerResponse.setHeaders(response, NO_STORE)
    answer = HttpServerResponse.removeHeader(answer, "access-control-allow-credentials")
    return listed && origin !== undefined
      ? HttpServerResponse.setHeaders(answer, { "access-control-allow-origin": origin, vary: "origin" })
      : HttpServerResponse.removeHeader(answer, "access-control-allow-origin")
  }

  // The answer of no route: `404`, the three headers, no body, no CORS
  // header. It is none of the error codes: their JSON is the routes'.
  const notFound = (route: string) =>
    Effect.as(note({ route, status: 404 }), finish(HttpServerResponse.empty({ status: 404 }), undefined, false))

  // `503 busy` past the bound of places.
  const full = (route: string, origin: string | undefined, listed: boolean) =>
    Effect.as(note({ route, status: 503, error: "busy" }), finish(errorAnswer("busy", { retryAfter: 1 }), origin, listed))

  // The place and the deadline of one request that holds `give`. The
  // deadline is `request` from `arm`; `fired` is done when it passes, and
  // ends the work's race (`within`). `disarm` stops its timer, so that no
  // timer outlives its request; `giveBack` gives the place back, once, and
  // keeps the deadline; `release` does both.
  const holding = (give: () => void) => {
    const state = {
      give: give as (() => void) | null,
      start: 0,
      timer: undefined as Fiber.Fiber<unknown> | undefined
    }
    const fired = Deferred.makeUnsafe<void>()
    const disarm = () => {
      const timer = state.timer
      state.timer = undefined
      timer?.interruptUnsafe()
    }
    const arm = Effect.uninterruptible(Effect.gen(function*() {
      disarm()
      state.start = yield* Clock.currentTimeMillis
      state.timer = yield* Effect.forkDetach(Effect.andThen(Effect.sleep(limits.request), Deferred.succeed(fired, undefined)), {
        startImmediately: true
      })
    }))
    const giveBack = () => {
      const held = state.give
      state.give = null
      held?.()
    }
    const release = () => {
      disarm()
      giveBack()
    }
    // The work, from the first deadline: Some of its exit, or None when a
    // deadline passed first (the work was interrupted and has ended).
    const within = <A, E, R>(work: Effect.Effect<A, E, R>) =>
      Effect.andThen(
        arm,
        Effect.raceFirst(Effect.asSome(Effect.exit(work)), Effect.as(Deferred.await(fired), Option.none()))
      ).pipe(Effect.ensuring(Effect.sync(disarm)))
    // R5's steps.
    const leave = Effect.sync(release)
    const again: Effect.Effect<void, Refused> = Effect.uninterruptible(Effect.suspend(() => {
      if (state.give !== null) return Effect.void
      const next = take()
      if (next === null) return Effect.fail(new Refused({ code: "busy", retryAfter: 1 }))
      state.give = next
      return arm
    }))
    return { state, within, giveBack, release, leave, again }
  }

  // Checks 1 to 3, then the work.
  const checked = <E, R>(
    chat: string | undefined,
    request: HttpServerRequest.HttpServerRequest,
    origin: string | undefined,
    listed: boolean,
    work: (found: Found) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R> =>
    Effect.gen(function*() {
      // Check 1: the origin.
      if (origin !== undefined && !listed) return yield* new Refused({ code: "forbidden_origin" })
      // Check 2: the token, from the header `Authorization` only.
      const header = BEARER.exec(request.headers["authorization"] ?? "")
      if (header === null) return yield* new Unauthorized({ check: 1 })
      const now = yield* Clock.currentTimeMillis
      const claims = yield* Effect.mapError(verifyToken(secret, header[1] as string, now), (failed) => new Unauthorized({ check: failed.check }))
      // Check 3: the chat, in the token, then in the store for its tenant.
      if (chat === undefined || !claims.chats.includes(chat)) return yield* new Refused({ code: "no_chat" })
      const reads = yield* chats.reads(claims.tenant, chat).pipe(
        Effect.catchTag("NoChat", () => Effect.fail(new Refused({ code: "no_chat" })))
      )
      return yield* work({ tenant: claims.tenant, chat, claims, reads, request })
    })

  // The answer of a work that failed.
  const failed = (route: Route | "R6", cause: Cause.Cause<unknown>) => {
    const error = Option.getOrUndefined(Cause.findErrorOption(cause))
    if (error instanceof Refused) {
      const options: { retryAfter?: number; close?: boolean } = {}
      if (error.retryAfter !== undefined) options.retryAfter = error.retryAfter
      if (error.close !== undefined) options.close = error.close
      return Effect.as(note({ route, status: ERRORS[error.code].status, error: error.code }), errorAnswer(error.code, options))
    }
    if (error instanceof Unauthorized) {
      return Effect.as(note({ route, status: 401, error: "unauthorized", check: error.check }), errorAnswer("unauthorized"))
    }
    return Effect.as(note({ route, status: 500, error: "internal", fault: faultOf(cause) }), errorAnswer("internal"))
  }

  const route: Gate["route"] = (name, chat, work) =>
    Effect.flatMap(Effect.zip(HttpServerRequest.HttpServerRequest, Effect.serviceOption(Scope.Scope)), ([request, owner]) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const { origin, listed } = originOf(request)
          // The place and its give-back are one step: the place is taken in
          // this uninterruptible body, and the finalizer that gives it back
          // is in place before any part of the request can be interrupted.
          const give = take()
          if (give === null) return full(name, origin, listed)
          // The method, after the place and before check 1: no check and no
          // work runs for another.
          if (request.method !== METHODS[name]) {
            give()
            return notFound(name)
          }
          const held = holding(give)
          // A client's answer (R4): its `abandon`, run one time.
          let abandon: Effect.Effect<void> | undefined
          let abandoned = false
          const runAbandon = Effect.suspend(() => {
            if (abandon === undefined || abandoned) return Effect.void
            abandoned = true
            return abandon
          })
          // A stream answer's handoff: the timer of its deadline, and the place
          // that it took (a stream of a work that did not run the client's
          // step). `handed` is set as the body returns the answer; the
          // finalizer hands them to the stream only when the body's exit is
          // that success, and else ends them itself.
          let timer: Fiber.Fiber<unknown> | undefined
          let streamGive: (() => void) | undefined
          let handed = false
          // A client's stream: whether it started, and whether its client
          // ended first (a start then fails at once, with no work of it).
          let started = false
          let late = false
          // The end of what the answer would own: its timer stopped, the place
          // that its stream took given back, and the client's `abandon`, each
          // one time in all with the stream's own ends.
          const end = Effect.suspend(() => {
            if (!started) late = true
            timer?.interruptUnsafe()
            streamGive?.()
            return runAbandon
          })
          const steps: Steps = {
            // The client, its place back, and its end in the request's scope,
            // in one step (see `Steps.client`).
            client: (given) =>
              Effect.uninterruptible(Effect.suspend(() => {
                if (abandon !== undefined) return Effect.void
                abandon = given
                held.giveBack()
                return owner._tag === "Some" ? Scope.addFinalizer(owner.value, end) : Effect.void
              })),
            leave: held.leave,
            again: held.again
          }
          // What follows the place is interruptible (`restore`), the handoff of
          // the answer too: an interruption at any point of it ends the body,
          // and the finalizer, which sees that exit, ends what the answer would
          // have owned. Each timer is made and noted in one step, so the
          // finalizer always finds it.
          const noted = (fork: Effect.Effect<Fiber.Fiber<unknown>>) =>
            Effect.uninterruptible(Effect.map(fork, (fiber) => {
              timer = fiber
              return fiber
            }))
          return restore(Effect.gen(function*() {
            const ended = yield* held.within(checked(chat, request, origin, listed, (found) => work(found, steps)))
            if (ended._tag === "None") {
              yield* note({ route: name, status: 503, error: "busy", fault: "deadline" })
              return finish(errorAnswer("busy", { retryAfter: 1 }), origin, listed)
            }
            const exit = ended.value
            if (Exit.isFailure(exit)) return finish(yield* failed(name, exit.cause), origin, listed)
            const response = exit.value
            if (response.body._tag !== "Stream") return finish(response, origin, listed)
            const body = response.body
            const left = Math.max(0, held.state.start + limits.request - (yield* Clock.currentTimeMillis))
            const streamed = (stream: Stream.Stream<Uint8Array, unknown>) =>
              finish(HttpServerResponse.setBody(response, HttpBody.stream(stream, body.contentType, body.contentLength)), origin, listed)
            if (abandon !== undefined) {
              // A client's stream (R4). Its place went back at the step. Until the
              // stream starts, the deadline holds: at it, `abandon` runs one
              // time, and a start after that fails at once, with no work of the
              // stream. A stream that started lives until its own end, done,
              // failed or interrupted, with no deadline of the gate (its timer
              // stops at the start); `abandon` runs one time at that end. A
              // stream whose client went away before its head still starts
              // (Effect starts the stream of a `Response` at once, and a web
              // stream pulls once by itself), and Effect's Bun server interrupts
              // it then: so its `abandon` runs at once. The request's scope
              // ends the client too (`end`), when an interruption after this
              // point ends the request's fiber.
              const clientTimer = yield* noted(Effect.forkDetach(Effect.andThen(
                Effect.sleep(left),
                Effect.suspend(() => {
                  if (started) return Effect.void
                  late = true
                  return Effect.andThen(note({ route: name, status: response.status, fault: "deadline" }), runAbandon)
                })
              ), { startImmediately: true }))
              const answer = streamed(Stream.unwrap(Effect.sync(() => {
                if (late) return Stream.fail(new DeadlinePassed())
                started = true
                clientTimer.interruptUnsafe()
                return body.stream
              })).pipe(Stream.ensuring(runAbandon)))
              handed = true
              return answer
            }
            const give = held.state.give
            // No place held (R5 left it and did not take one again): the answer is
            // the work's, with no place and no deadline of the gate.
            if (give === null) return streamed(body.stream)
            held.state.give = null
            streamGive = give
            // The answer's bytes are sent after this fiber ends, by a fiber of the
            // server that runs the stream (`runner`) when the server starts it,
            // and pulls it when the client takes bytes. The gate, not that pull,
            // owns the place and the rest of the deadline: a stream that is never
            // started or never pulled still gives them back. The place goes back
            // once, at the first of:
            // - the stream's end, done, failed or interrupted (`finished`); the
            //   timer of the deadline is then stopped, so it does not outlive the
            //   stream;
            // - the deadline (`timer`): a stream that has started is stopped, and
            //   gives the place back when it has ended, never before; one that
            //   never started gives it back at once, and fails if it starts later,
            //   so that no work of it runs after its place went back.
            // A started stream is stopped in two steps. First it fails with
            // `DeadlinePassed` (`cut`), which ends a stream that is pulled now as
            // it did before; then, if it has not ended after a few turns of the
            // scheduler (it is not pulled, or a part of it is uninterruptible),
            // its fiber is interrupted, which ends it where it waits. The second
            // step alone would do; the first keeps Bun from printing an
            // interruption for each stream cut at the deadline.
            let runner: Fiber.Fiber<unknown, unknown> | undefined
            let past = false
            let over = false
            const cut = Deferred.makeUnsafe<never, DeadlinePassed>()
            const streamTimer = yield* noted(Effect.forkDetach(Effect.andThen(
              Effect.sleep(left),
              Effect.suspend(() => {
                if (over) return Effect.void
                past = true
                const running = runner
                if (running === undefined) {
                  give()
                  return note({ route: name, status: response.status, fault: "deadline" })
                }
                Deferred.doneUnsafe(cut, Exit.fail(new DeadlinePassed()))
                return Effect.repeat(Effect.yieldNow, { times: 10 }).pipe(
                  Effect.andThen(Effect.sync(() => {
                    if (!over) running.interruptUnsafe()
                  })),
                  Effect.andThen(note({ route: name, status: response.status, fault: "deadline", closed: true }))
                )
              })
            ), { startImmediately: true }))
            const finished = Effect.sync(() => {
              over = true
              give()
              streamTimer.interruptUnsafe()
            })
            const answer = streamed(Stream.unwrap(Effect.withFiber((fiber) => {
              if (past) return Effect.succeed(Stream.fail(new DeadlinePassed()))
              runner = fiber
              return Effect.succeed(Stream.interruptWhen(body.stream, Deferred.await(cut)))
            })).pipe(Stream.ensuring(finished)))
            handed = true
            return answer
          })).pipe(Effect.onExit((exit) =>
            Effect.suspend(() => {
              held.release()
              if (Exit.isSuccess(exit) && handed) return Effect.void
              // The answer did not leave the gate (the work failed, the request
              // was interrupted, or the answer is no stream): no stream owns the
              // timer, the place or the client, so they end here, at once.
              return end
            })
          ))
        })))

  const none: Gate["none"] = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { origin, listed } = originOf(request)
    const give = take()
    if (give === null) return yield* full("none", origin, listed)
    // No work: the place goes back at once.
    give()
    return yield* notFound("none")
  })

  const socket: Gate["socket"] = (chat, work) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const { origin, listed } = originOf(request)
          // The place and its give-back are one step, as in `route`.
          const give = take()
          if (give === null) return full("R6", origin, listed)
          if (request.method !== "GET" || request.headers["upgrade"]?.toLowerCase() !== "websocket") {
            give()
            return notFound("R6")
          }
          const held = holding(give)
          // The waiting place, from `admit` to its second step or the work's end.
          // `admit` is one synchronous step: the waiting place is taken and the
          // request's place given back with no point between them where
          // another fiber runs or an interruption lands.
          let leaveWaiting: (() => void) | undefined
          const admit: Upgrading["admit"] = Effect.suspend(() => {
            if (leaveWaiting === undefined) {
              if (waiting >= limits.waiting) return Effect.fail(new Refused({ code: "busy" }))
              waiting += 1
              leaveWaiting = once(() => {
                waiting -= 1
              })
              held.release()
            }
            return Effect.succeed(Effect.sync(leaveWaiting))
          })
          return Effect.gen(function*() {
            // Check 1: the origin, before the upgrade. No check 2: the token is
            // the socket's first frame (`token`).
            if (origin !== undefined && !listed) {
              yield* note({ route: "R6", status: 403, error: "forbidden_origin" })
              return finish(errorAnswer("forbidden_origin"), origin, listed)
            }
            const ended = yield* restore(held.within(work({ chat, request, admit })))
            if (ended._tag === "None") {
              yield* note({ route: "R6", status: 503, error: "busy", fault: "deadline" })
              return finish(errorAnswer("busy", { retryAfter: 1 }), origin, listed)
            }
            const exit = ended.value
            if (Exit.isFailure(exit)) return finish(yield* failed("R6", exit.cause), origin, listed)
            return finish(exit.value, origin, listed)
          }).pipe(Effect.onExit(() =>
            Effect.sync(() => {
              held.release()
              leaveWaiting?.()
            })
          ))
        })))

  const token: Gate["token"] = (text, chat) =>
    Effect.gen(function*() {
      const refuse = (code: SocketRefused["code"], fields: Omit<Parameters<typeof note>[0], "route">) =>
        Effect.andThen(note({ route: "R6", ...fields }), Effect.fail(new SocketRefused({ code })))
      // Check 2: the token, at the time of Effect's `Clock`.
      const now = yield* Clock.currentTimeMillis
      const claims = yield* verifyToken(secret, text, now).pipe(
        Effect.catch((failure) => refuse("unauthorized", { status: 401, error: "unauthorized", check: failure.check }))
      )
      // Check 3: the chat, in the token, then in the store for its tenant.
      if (chat === undefined || !claims.chats.includes(chat)) return yield* refuse("no_chat", { status: 404, error: "no_chat" })
      const reads = yield* chats.reads(claims.tenant, chat).pipe(
        Effect.catch((failure) =>
          failure._tag === "NoChat"
            ? refuse("no_chat", { status: 404, error: "no_chat" })
            : refuse("internal", { status: 500, error: "internal", fault: failure._tag })
        )
      )
      return { tenant: claims.tenant, chat, claims, reads }
    })

  const preflight: Gate["preflight"] = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { origin, listed } = originOf(request)
    const give = take()
    if (give === null) return yield* full("R7", origin, listed)
    // Check 1 only, with no wait: the place goes back at once.
    give()
    if (origin === undefined) return finish(HttpServerResponse.empty({ status: 204 }), origin, listed)
    if (!listed) {
      yield* note({ route: "R7", status: 403, error: "forbidden_origin" })
      return finish(errorAnswer("forbidden_origin"), origin, listed)
    }
    return finish(HttpServerResponse.empty({ status: 204, headers: PREFLIGHT }), origin, listed)
  })

  const body: Gate["body"] = (request) =>
    Effect.gen(function*() {
      const length = request.headers["content-length"]
      if (length !== undefined && /^\d+$/.test(length) && Number(length) > limits.body) {
        return yield* new Refused({ code: "too_large", close: true })
      }
      // The chunks while their sum is at most `body`; the chunk that passes
      // it is not kept, and the read stops there.
      const chunks: Array<Uint8Array> = []
      let size = 0
      const read = Stream.runForEachWhile(request.stream, (chunk) =>
        Effect.sync(() => {
          size += chunk.length
          if (size > limits.body) return false
          chunks.push(chunk)
          return true
        })).pipe(Effect.mapError(() => new Refused({ code: "bad_request", close: true })))
      const done = yield* Effect.timeoutOption(read, limits.bodyRead)
      if (done._tag === "None") return yield* new Refused({ code: "timeout", close: true })
      if (size > limits.body) return yield* new Refused({ code: "too_large", close: true })
      const bytes = new Uint8Array(size)
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.length
      }
      return bytes
    })

  return { route, none, socket, token, preflight, body, inFlight: () => taken, waiting: () => waiting }
}
