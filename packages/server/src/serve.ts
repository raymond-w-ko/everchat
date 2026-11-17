// Serve
// =====
// `serve(options)`, the layer that serves the host's routes R1 to R7 over the
// `HttpServer` of its context, and `serverOptions(limits)`, the numbers of
// that server (docs/host.md, section 1, the table of entries; section 3,
// "Ways and routes", "Origins", "Admission" 9; lead, ec-hmsqu).
//
// `serve(options)` needs `Chats` and `HttpServer.HttpServer`, and gives
// `Host`. At its start it builds `Host.layer(options)`, which fails with
// `LimitsRefused` or `SecretTooShort` before anything is served, then one
// gate over the host's secret, origins and limits and the `Chats` service
// (http.ts, `makeGate`), then it serves the routes for as long as the layer
// lives.
//
// `serve(options, local)`: with `local` (page.ts, `LocalOptions`: the start
// value, the local tenant, the pick of a new chat and the one value of
// `Host`), the gate is made with `authority` (http.ts: every member checks the
// header `Host`), and three more routes are served, each through the gate's
// `local`: R8 `GET /<start>/`, the page; R9 `POST /<start>/chats`, a new
// chat; R10 `POST /<start>/token`, a token (docs/host.md, section 7; lead,
// ec-3jrdd, 1). A start value of another form than 32 hex digits in lower
// case, or a page that has not exactly one `<script>`, fails the layer at
// its start with `LocalRefused`, before anything is served. Every other path
// under the start value, a wrong start value and `/<start>` with no slash at
// its end get the gate's answer of no route; the start value is compared
// over its whole length, with no early end (`pageRoutes`). With no `local`,
// there is no such route and no check of `Host`.
//
// The routes, each path exact on the target as the server gives it: no
// other letter case, no slash at its end, no part more. `{chat}` is that
// text, and the gate checks it (lead, ec-5tdje, 1). Bun parses a request's
// target as a URL before any code of Effect or the host runs (Effect's Bun
// server takes `request.url` without its host), so the wire's spelling is
// not there to read. A target that this parsing makes equal to a route's
// path is that route's request, with the route's method rule, its checks in
// their order on the parsed text, its places and its work: a dot segment
// (`./` or `../`, in any place; each dot of one as `.`, `%2e` or `%2E`, in
// any mix: `%2e/`, `.%2e/`, `%2e./`, `%2e%2E/`), a backslash for a slash,
// the absolute form (`GET http://any.host/v1/...`).
// Two slashes, another letter case, `;`, an encoded slash and any other
// percent escape stay as they came: no route, or, in `{chat}`, a text that
// the gate's check of the chat refuses. No check is passed by a spelling. A
// front of a hosted deployment must not decide access by a path's spelling.
//
// | Method and path | Route |
// | --- | --- |
// | `POST /v1/chats/{chat}/messages` | R1, `messageRoute` (post.ts) |
// | `GET /v1/chats/{chat}` | R2, `snapshotRoute` (history.ts) |
// | `GET /v1/chats/{chat}/messages` | R3, `messagesRoute` (history.ts) |
// | `GET /v1/chats/{chat}/events`, `Accept` names `text/event-stream` | R4, `eventsRoute` (stream.ts) |
// | `GET /v1/chats/{chat}/events`, any other `Accept` or none | R5, `pollRoute` (poll.ts) |
// | `GET /v1/chats/{chat}/socket` | R6, `socketRoute` (socket.ts) |
// | `OPTIONS` on the paths of R1 to R5 | R7, the gate's `preflight` |
// | `GET /<start>/` (with `local`) | R8, the page (page.ts) |
// | `POST /<start>/chats` (with `local`) | R9, a new chat (page.ts) |
// | `POST /<start>/token` (with `local`) | R10, a token (page.ts) |
//
// Every other path, and every other method on these paths (a `HEAD` too, and
// `OPTIONS` on R6's path), gets the gate's answer of no route (`none`: a
// place, then `404` with no body): no check and no work of a route runs for
// it. "Every other method" is every method that the server gives the
// handler: the server's own answers are not the host's requests (lead,
// ec-5tdje, 2). Effect's Bun server answers `CONNECT` with `501` and no body
// before the handler, and Bun a head that it cannot parse (a method name
// that it does not know, lowercase too: the connection closes with no
// answer; a tab or a space in the target: `505`; `*`: `400`): no place of
// the gate, no check, no work, no line of the gate's log, at any load. R4 or
// R5: R4 when the header `Accept` names the media type
// `text/event-stream` in its list, letter case and parameters aside
// (`text/event-stream;q=0.9` too), but for a part whose `q` is zero (`q=0`,
// `q=0.0` to `q=0.000`, `Q` too: that part does not name it; a `q` that is
// no number names it); else R5, with no `Accept` too (lead, ec-ajj5m, 2).
//
// The end. The host's layer ends each client with `stop` (host.ts), and each
// such end is written while the server still serves: R4's `close` frame and
// R6's `1001`. So the end runs in this order: first a mark, from which on
// this layer gives no request to a route: a request that comes after it
// gets `503 busy` with `retry-after: 1` from this layer itself, with no
// route, no gate, no place, no upgrade and no line of the gate's log (lead,
// ec-yculc, ruling 3), with the origin's headers as the gate gives them
// (`busyAnswer`; lead, ec-ajj5m, 1); then the host's end, which stops its
// registry first,
// so that no request becomes a client after it (one that came before the
// mark and is still in its checks, a socket whose `auth` comes late, an R5
// that joins to wait: each is refused as by a full host); then a wait,
// at most `request` ms, until each answer's stream that this layer gave has
// ended (R4's, with its `close` frame); then this layer interrupts each
// request of its routes that still runs, and waits for its end; then the
// server stops serving these routes. A socket closes at that interruption
// with `1001` (socket.ts, the reader's finalizer): a client's that its
// `stop` did not close yet, and one that has not become a client (before its
// `auth`, or in its token's check), which the host's stop does not end. So
// no socket and no client outlives this layer. The interruption is this
// layer's own: Effect's server, when its last app ends, first waits for
// Bun's graceful stop (up to 20 s, while a socket stays open), and only then
// interrupts what is left.
//
// The server's numbers (`serverOptions`). This layer cannot read the options
// of the server that its caller built, so the caller builds its server with
// the numbers that `serverOptions` gives for the same limits:
//
// - `idleTimeout`: `idle` in whole seconds, rounded up (190 at the
//   defaults). Bun's idle limit of HTTP closes a connection with no request,
//   and an answer that sends no byte for that long. The page's sums of the
//   longest silences (section 3, "Admission" 9) hold only when it is at
//   least `idle`.
// - `websocket.idleTimeout`: `socketIdle` in whole seconds, rounded up (120).
// - `websocket.maxPayloadLength`: `body` (524,288): Bun refuses a larger
//   frame at its header, before its payload comes, with `1009` (socket.ts;
//   the measure of ec-1d6p0). With Bun's own bound (16 MiB) Bun holds a
//   frame whole first.
// - `websocket.closeOnBackpressureLimit: true` and
//   `websocket.backpressureLimit`: `bufferBytes` (8 MiB). Effect's Bun writer
//   moves each text of a socket's buffer into Bun's send buffer at once and
//   does not read the result of Bun's `sendText`, so a socket's bound of a
//   slow reader is Bun's, not the host's buffer. With Bun's defaults a
//   socket that falls 16 MiB behind stays open and loses the frames past
//   it: a hole in its events. With these two Bun ends it instead, with
//   `1006` and no close frame on both sides, so the host cannot send `4408
//   slow` for it and cannot tell it from a client that went away; the client
//   connects again from its last number (lead, ec-fhomd, ruling 8; the probe
//   of ec-fhomd).
//
// A server with other numbers breaks the page's sums: a shorter idle limit
// resets an answer that waits within the page's silences, a larger frame
// bound lets Bun hold more than `body` of a frame, and a socket with Bun's
// own backpressure options can get a hole. Each time is rounded up, never 0:
// Bun takes 0 as no limit at all.
//
// Bun's idle limit of HTTP (Bun 1.4.4; the probes of ec-fhomd) counts in
// ticks of 4 s: a quiet answer is reset at the tick after the limit (1 to 4
// at 4 s, 5 and 8 at 8 s; 190 is 48 ticks, so between 188 and 192 s: a
// connection idle after a `401` closed at 192.1 s), and an `idleTimeout`
// of 4 or less resets every answer at 4 s whatever it writes. So an `idle`
// under 5,000 ms cannot hold a stream there. From two ticks on, an answer's
// own writes keep it (8, with a write each second: open at 20 s).

import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { HttpBody, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Chats } from "@everchat/core/store"
import { messagesRoute, snapshotRoute } from "./history.ts"
import { Host, type HostOptions, type SecretTooShort } from "./host.ts"
import { errorAnswer, type Gate, makeGate } from "./http.ts"
import { DEFAULTS, type Limits, type LimitsRefused } from "./limits.ts"
import { type LocalOptions, type LocalRefused, type PageFind, pageRoutes } from "./page.ts"
import { pollRoute } from "./poll.ts"
import { messageRoute } from "./post.ts"
import { socketRoute } from "./socket.ts"
import { eventsRoute } from "./stream.ts"

// The numbers of the caller's server
// ----------------------------------

// The options of the HTTP server that `serve` needs, as plain numbers.
export interface ServerOptions {
  readonly idleTimeout: number // seconds
  readonly websocket: {
    readonly idleTimeout: number // seconds
    readonly maxPayloadLength: number // bytes
    readonly closeOnBackpressureLimit: true
    readonly backpressureLimit: number // bytes
  }
}

// Whole seconds of `ms`, rounded up.
const seconds = (ms: number) => Math.ceil(ms / 1000)

// The numbers of the server for the limits in use: the defaults with the
// given ones over them, as `HostOptions.limits` gives them (the head
// comment). It checks nothing: `serve` refuses limits that break a relation.
export const serverOptions = (given: Partial<Limits> = {}): ServerOptions => {
  const used: Limits = { ...DEFAULTS, ...given }
  return {
    idleTimeout: seconds(used.idle),
    websocket: {
      idleTimeout: seconds(used.socketIdle),
      maxPayloadLength: used.body,
      closeOnBackpressureLimit: true,
      backpressureLimit: used.bufferBytes
    }
  }
}

// The routes
// ----------

// A path of the routes: `/v1/chats/{chat}`, then nothing or one of the three
// last parts. Letter case counts; no slash at its end. It is matched on the
// path as the server gives it, after Bun's parsing of the target (the head
// comment): a dot segment is gone by then, and a percent escape is not
// decoded.
const PATH = /^\/v1\/chats\/([^/]+)(?:\/(messages|events|socket))?$/

// The path of a request's target: up to its query.
const pathOf = (url: string) => {
  const query = url.indexOf("?")
  return query === -1 ? url : url.slice(0, query)
}

// A `q` of zero, as RFC 9110 writes a weight: `0`, then at most three
// zeros after a dot.
const ZERO = /^0(?:\.0{0,3})?$/

// The parts of `Accept`'s list, each as its pieces: its type, then each
// parameter. One pass over the text: a `,` ends a part and a `;` a piece,
// but not inside a quoted string (RFC 9110): a `"` opens one, the next `"`
// that no backslash takes ends it, and in it a backslash takes the next
// character with it. A quoted string with no end runs to the text's end.
const partsOf = (accept: string): ReadonlyArray<ReadonlyArray<string>> => {
  const parts: Array<Array<string>> = []
  let pieces: Array<string> = []
  let start = 0
  let quoted = false
  for (let at = 0; at < accept.length; at++) {
    const char = accept[at]
    if (quoted) {
      if (char === "\\") at++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === ";" || char === ",") {
      pieces.push(accept.slice(start, at))
      start = at + 1
      if (char === ",") {
        parts.push(pieces)
        pieces = []
      }
    }
  }
  pieces.push(accept.slice(start))
  parts.push(pieces)
  return parts
}

// Whether `Accept` names `text/event-stream` in its list, letter case and
// parameters aside, but for `q` of zero: a part with it does not name the
// type. A `q` that is no weight (`q=x`, `q="0"`) is aside as every other
// parameter. A quoted value is one piece (`partsOf`): a `,` or `;q=0` in it
// ends nothing.
export const wantsStream = (accept: string | undefined): boolean =>
  accept !== undefined &&
  partsOf(accept).some(([type, ...parameters]) => {
    if ((type ?? "").trim().toLowerCase() !== "text/event-stream") return false
    return !parameters.some((parameter) => {
      const at = parameter.indexOf("=")
      return at !== -1 && parameter.slice(0, at).trim().toLowerCase() === "q" && ZERO.test(parameter.slice(at + 1).trim())
    })
  })

// The answer after the end's mark: the gate's `503 busy` with
// `retry-after: 1`, with its headers for the origin of the request (http.ts,
// `finish`): for an `Origin` that is on the list, byte for byte,
// `access-control-allow-origin` with it and `vary: origin`; for another or
// none, neither; never `access-control-allow-credentials`. Every method
// gets it, an `OPTIONS` too: it is no preflight. A case of serve.end.test.ts
// compares it with the gate's own `503 busy`, header for header.
const busyAnswer = (request: HttpServerRequest.HttpServerRequest, origins: ReadonlyArray<string>) => {
  const answer = errorAnswer("busy", { retryAfter: 1 })
  const origin = request.headers["origin"]
  return origin !== undefined && origins.includes(origin)
    ? HttpServerResponse.setHeaders(answer, { "access-control-allow-origin": origin, vary: "origin" })
    : answer
}

// The handler of all routes for one request; with `page`, the page's routes
// first (R8 to R10).
const routes = (gate: Gate, host: typeof Host.Service, page: PageFind | undefined) => {
  const r1 = messageRoute(gate, host)
  const r2 = snapshotRoute(gate, host.reads, host.limits)
  const r3 = messagesRoute(gate, host.reads, host.limits)
  const r4 = eventsRoute(gate, host)
  const r5 = pollRoute(gate, host.registry, host.reads, host.limits)
  const r6 = socketRoute(gate, host)
  return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const path = pathOf(request.url)
    const paged = page?.(path)
    if (paged !== undefined) return paged
    const found = PATH.exec(path)
    if (found === null) return gate.none
    const chat = found[1] as string
    const method = request.method
    switch (found[2]) {
      case undefined:
        return method === "GET" ? r2(chat) : method === "OPTIONS" ? gate.preflight : gate.none
      case "messages":
        return method === "POST" ? r1(chat) : method === "GET" ? r3(chat) : method === "OPTIONS" ? gate.preflight : gate.none
      case "events":
        return method === "GET"
          ? (wantsStream(request.headers["accept"]) ? r4(chat) : r5(chat))
          : method === "OPTIONS"
          ? gate.preflight
          : gate.none
      default:
        return method === "GET" ? r6(chat) : gate.none
    }
  })
}

// The requests of the routes and the answers' streams that the layer gave:
// `track` wraps the handler, and answers each request after `mark` with
// `503 busy` and `retry-after: 1` at once (`busyAnswer`, with the origin's
// headers), with no handler; `drained` waits
// until no stream is open, at
// most `ms`; `stop` interrupts each request that still runs (its handler:
// a socket's whole session, or a request with no answer yet) and waits for
// its end. The handler runs interruptible, as `HttpRouter` runs a route's:
// Effect's server starts each request's fiber uninterruptible
// (`HttpEffect.toHandled`), and the gate and the routes take their own
// uninterruptible steps where they need them. So a client that goes away,
// the gate's deadline and this layer's end can interrupt a request.
const tracker = (origins: ReadonlyArray<string>) => {
  const running = new Set<Fiber.Fiber<unknown, unknown>>()
  let ending = false
  let open = 0
  let empty: Deferred.Deferred<void> | null = null
  const done = () => {
    let once = false
    return () => {
      if (once) return
      once = true
      open -= 1
      if (open === 0 && empty !== null) Deferred.doneUnsafe(empty, Exit.void)
    }
  }
  const track = <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
    Effect.suspend((): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
      ending
        ? Effect.map(HttpServerRequest.HttpServerRequest, (request) => busyAnswer(request, origins))
        : tracked(handler)
    )
  const tracked = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.withFiber((fiber) => {
      running.add(fiber)
      return Effect.interruptible(handler).pipe(Effect.ensuring(Effect.sync(() => running.delete(fiber))))
    }).pipe(Effect.map((response) => {
      const body = response.body
      if (body._tag !== "Stream") return response
      // Counted from here; the stream's end, however it ends, counts it out.
      open += 1
      const end = done()
      return HttpServerResponse.setBody(
        response,
        HttpBody.stream(Stream.ensuring(body.stream, Effect.sync(end)), body.contentType, body.contentLength)
      )
    }))
  const drained = (ms: number) =>
    Effect.suspend(() => {
      if (open === 0) return Effect.void
      empty = Deferred.makeUnsafe<void>()
      return Effect.ignore(Effect.timeoutOption(Deferred.await(empty), ms))
    })
  const stop = Effect.suspend(() => Fiber.interruptAll([...running]))
  // The end's first step: no new request goes to a route after it.
  const mark = Effect.sync(() => {
    ending = true
  })
  return { track, mark, drained, stop }
}

// The layer
// ---------

export const serve = (
  options: HostOptions,
  local?: LocalOptions
): Layer.Layer<Host, LimitsRefused | SecretTooShort | LocalRefused, Chats | HttpServer.HttpServer> =>
  Layer.effectContext(Effect.gen(function*() {
    const scope = yield* Effect.scope
    // The host's scope, closed first at the end, before the server stops
    // serving (the head comment).
    const own = yield* Scope.fork(scope, "sequential")
    const context = yield* Layer.buildWithScope(Host.layer(options), own)
    const host = Context.get(context, Host)
    const chats = yield* Chats
    const gate = makeGate({
      secret: host.secret,
      origins: host.origins,
      limits: host.limits,
      chats,
      ...(local === undefined ? {} : { authority: local.authority })
    })
    const page = local === undefined ? undefined : yield* pageRoutes(local, { gate, chats, secret: host.secret, limits: host.limits })
    const requests = tracker(host.origins)
    yield* HttpServer.serveEffect(requests.track(routes(gate, host, page)))
    // Added last, so run first: the mark, the host's end, the wait for the
    // streams and the interruption of the requests, then the server's own
    // finalizers of these routes.
    yield* Scope.addFinalizerExit(scope, (exit) =>
      Effect.andThen(
        requests.mark,
        Effect.andThen(Scope.close(own, exit), Effect.andThen(requests.drained(host.limits.request), requests.stop))
      ))
    return context
  }))
