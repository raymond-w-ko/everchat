// The gate of the host's HTTP routes (docs/host.md, section 3: "The checks
// of each request, in their order", "Admission" 3, 4, 5, 6 and 10, the
// answers' headers, "Origins"; section 4, "An error"). Each route of R1 to R5
// runs behind it; R7, the preflight, is its own.
//
// `makeGate(options)` gives one gate for a host, over the secret, the list of
// origins, the limits and the `Chats` service. The gate holds the one count of
// the requests in flight. For a route it runs, before any byte of a body is
// read:
//
// 1. the place: at most `requests` at one time, with no queue; past it,
//    `503 busy` with `retry-after: 1` at once;
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
// stream's pull: a `HEAD` is answered with no body, and nothing pulls it). A
// client that goes away changes one thing only: no answer is written
// (Effect's Bun server interrupts the request's fiber, and the place waits
// for the work's end).
//
// The deadline: `request` from the request's head to the end of its answer.
// At the deadline the gate interrupts the work; when that work has ended, the
// answer is `503 busy` with `retry-after: 1` if no byte of it was sent, else
// the connection closes (the answer's stream is interrupted, and Bun cuts it).
//
// Every answer has `cache-control: no-store`, `referrer-policy: no-referrer`
// and `x-content-type-options: nosniff`. For a request whose `Origin` is on
// the list, each answer, an error too, has `access-control-allow-origin` with
// that origin and `vary: origin`. No answer allows credentials.
//
// The gate's log holds the route's name, the status, the error's code and the
// token check's number: never a query, a header's value, a token or a body.

import { Cause, Clock, Deferred, Effect, Exit, type Fiber, Option, type Redacted, Schema, Stream } from "effect"
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

export interface Gate {
  // R1 to R5: the place, the three checks, then `work`, under the deadline.
  // `chat` is the path's chat, as text (undefined: none). It never fails: a
  // `Refused` of the work gives its error answer, any other failure
  // `500 internal`.
  readonly route: <E, R>(
    route: Route,
    chat: string | undefined,
    work: (found: Found) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | HttpServerRequest.HttpServerRequest>
  // R7: a place and check 1 only.
  readonly preflight: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
  // The body of R1: at most `body` bytes, read in at most `bodyRead`; else
  // `Refused` `too_large`, or `timeout` with `close`.
  readonly body: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Uint8Array, Refused>
  // The places taken now.
  readonly inFlight: () => number
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

export const makeGate = (options: GateOptions): Gate => {
  const { secret, origins, limits, chats } = options
  let taken = 0

  // The place: one, or none when all are taken. `give` gives it back once.
  const take = (): (() => void) | null => {
    if (taken >= limits.requests) return null
    taken += 1
    let given = false
    return () => {
      if (given) return
      given = true
      taken -= 1
    }
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
  const failed = (route: Route, cause: Cause.Cause<unknown>) => {
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
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const { origin, listed } = originOf(request)
      const give = take()
      if (give === null) {
        yield* note({ route: name, status: 503, error: "busy" })
        return finish(errorAnswer("busy", { retryAfter: 1 }), origin, listed)
      }
      // The place goes to the answer's stream when there is one; else it
      // goes back when this fiber ends, after the work has ended.
      let handed = false
      return yield* Effect.gen(function*() {
        const start = yield* Clock.currentTimeMillis
        const ended = yield* Effect.timeoutOption(Effect.exit(checked(chat, request, origin, listed, work)), limits.request)
        if (ended._tag === "None") {
          yield* note({ route: name, status: 503, error: "busy", fault: "deadline" })
          return finish(errorAnswer("busy", { retryAfter: 1 }), origin, listed)
        }
        const exit = ended.value
        if (Exit.isFailure(exit)) return finish(yield* failed(name, exit.cause), origin, listed)
        const response = exit.value
        if (response.body._tag !== "Stream") return finish(response, origin, listed)
        // The answer's bytes are sent after this fiber ends, by a fiber of the
        // server that runs the stream (`runner`) when the server starts it,
        // and pulls it when the client takes bytes. The gate, not that pull,
        // owns the place and the rest of the deadline: a stream that is never
        // started or never pulled (Bun answers a `HEAD` with no body, and never
        // starts its stream) still gives them back. The place goes back once,
        // at the first of:
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
        const left = Math.max(0, start + limits.request - (yield* Clock.currentTimeMillis))
        let runner: Fiber.Fiber<unknown, unknown> | undefined
        let late = false
        let over = false
        const cut = Deferred.makeUnsafe<never, DeadlinePassed>()
        const timer = yield* Effect.forkDetach(Effect.andThen(
          Effect.sleep(left),
          Effect.suspend(() => {
            if (over) return Effect.void
            late = true
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
        ), { startImmediately: true })
        const finished = Effect.sync(() => {
          over = true
          give()
          timer.interruptUnsafe()
        })
        const body = response.body
        const stream = Stream.unwrap(Effect.withFiber((fiber) => {
          if (late) return Effect.succeed(Stream.fail(new DeadlinePassed()))
          runner = fiber
          return Effect.succeed(Stream.interruptWhen(body.stream, Deferred.await(cut)))
        })).pipe(Stream.ensuring(finished))
        handed = true
        return finish(HttpServerResponse.setBody(response, HttpBody.stream(stream, body.contentType, body.contentLength)), origin, listed)
      }).pipe(Effect.onExit(() => Effect.sync(() => {
        if (!handed) give()
      })))
    })

  const preflight: Gate["preflight"] = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { origin, listed } = originOf(request)
    const give = take()
    if (give === null) {
      yield* note({ route: "R7", status: 503, error: "busy" })
      return finish(errorAnswer("busy", { retryAfter: 1 }), origin, listed)
    }
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

  return { route, preflight, body, inFlight: () => taken }
}
