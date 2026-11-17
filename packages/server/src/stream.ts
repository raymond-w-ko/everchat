// R4: the event stream
// ====================
// `GET /v1/chats/{chat}/events?after={n}` with `Accept: text/event-stream`
// (docs/host.md, section 3, "R4: the event stream", "Ways and routes",
// "Admission" 3, 10 and 11, "The order and the numbers"; section 2, "The
// give" and "The host's own frames"; lead, ec-hmsqu). It runs behind the
// gate (http.ts): the place, the method, the origin, the token and the
// chat. The choice between R4 and R5 by the header `Accept` is `serve`'s.
//
// `eventsWork(host)` gives the route's work, and `eventsRoute(gate, host)`
// the route for a request, a function of the path's chat; neither
// registers a route.
//
// The work, in this order (lead, ec-hmsqu, ruling 2):
//
// 1. The query: `after`, a whole number from 0 (the gate's `wholeNumber`),
//    is required; else `400 bad_request`. Of a name given twice the first
//    counts; no other parameter is read. An `after` above the chat's `seq`
//    is not refused: that client gets no event at or below it.
// 2. The hold of the chat's channel, then `addClient(after)`: past
//    `chatClients` or `hostClients`, `503 busy` with no `retry-after`, and
//    the hold goes back. Then the gate's step "a client now", with the
//    client's end as its `abandon`; the request's place goes back. These
//    three are one step that an interruption cannot split. A client loads
//    nothing.
// 3. The first frame (ruling 9): one `: ping` told into the client's buffer,
//    empty then; then the timers of the client, in its own scope: its
//    token's `exp`, its pings, and the watch of its end.
// 4. The answer: `200`, `content-type: text/event-stream`, at once. Nothing
//    of the store is read before it: the first read starts with the
//    stream, in the client's own scope, never in the stream's pull.
//
// One queue, one writer (ruling 5). Everything that the stream writes but
// the `close` frame goes through the client's buffer, in its bounds: the
// gives of the listener, the first read's pages, and the pings. The
// stream's writer takes one text at a time (`Client.take`) and writes its
// frame (ruling 4):
//
// - a numbered event: `id: <n>`, `event: <type>`, `data: <JSON>`, a blank
//   line;
// - a piece: `event: <type>`, `data: <JSON>`, a blank line; no `id`;
// - a ping: `: ping`, a blank line.
//
// The JSON is the buffer's text as the fit made it: one line. `Last-Event-ID`
// is not read.
//
// The ping (rulings 6 and 9): the first frame is a ping, so that the head
// goes out at once; then, after each `ping` ms in which the writer wrote
// nothing, the host tells the client `: ping`, only into an empty buffer (a
// buffer with a text needs none).
//
// The ends (ruling 7). The client ends in the channel: `slow` (a give with no
// room; or its first read found no room for a page `room` ms after its last
// page), `busy` (its first read waited `readsWait` for a place), `internal`
// (an event that the fit cannot give), `stop` (the host's layer ends), or
// `token` (a timer at the claims' `exp`, at Effect's `Clock`). The writer
// then writes the last frame, `event: close` with
// `data: {"type":"close","reason":"<reason>"}`, outside the buffer, and the
// stream ends. A client that went away (the stream was interrupted or
// cancelled) ends with no frame. At each end, one time: the client leaves
// the channel, the hold is let go, and its scope closes, which ends its
// timers and its first read. None of this waits on the stream's pull: the
// watch of the end runs it when the channel ends the client, the gate's
// `abandon` when the stream ends or never starts.
//
// The log: the gate's line, and for an end with `internal` or a fault of the
// writer one warning with the route, the reason and the fault's tag; never
// a query, a text of an event or a token.

import { Cause, Clock, Effect, Exit, Option, Scope, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import type { Channel, Client, Reason, Taken } from "./channel.ts"
import type { Host } from "./host.ts"
import { type Found, type Gate, Refused, type Steps, wholeNumber } from "./http.ts"
import type { LoadedChat } from "./loaded.ts"
import { firstRead } from "./reads.ts"

// What R4 uses of the host.
export type EventsHost = Pick<typeof Host.Service, "registry" | "reads" | "limits">

// The text of a ping in a client's buffer, and of its frame.
const PING = ": ping"

// The query of a request: the first value of each name, decoded; undefined
// for a value that is no text of percent-escapes. The same rule as R2's and
// R3's (history.ts).
const queryOf = (url: string): Map<string, string | undefined> => {
  const query = new Map<string, string | undefined>()
  const at = url.indexOf("?")
  if (at === -1) return query
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text.replaceAll("+", " "))
    } catch {
      return undefined
    }
  }
  for (const pair of url.slice(at + 1).split("&")) {
    if (pair === "") continue
    const equals = pair.indexOf("=")
    const name = decode(equals === -1 ? pair : pair.slice(0, equals))
    if (name === undefined || query.has(name)) continue
    query.set(name, decode(equals === -1 ? "" : pair.slice(equals + 1)))
  }
  return query
}

// The frame of one text of the buffer: a ping, or an entry's JSON (a
// numbered event has `n`, a piece has none).
const frameOf = (text: string): string => {
  if (text === PING) return PING + "\n\n"
  const entry = JSON.parse(text) as { readonly type: string; readonly n?: unknown }
  const id = typeof entry.n === "number" ? "id: " + entry.n + "\n" : ""
  return id + "event: " + entry.type + "\ndata: " + text + "\n\n"
}

// The last frame.
const closeFrame = (reason: Reason): string => "event: close\ndata: " + JSON.stringify({ type: "close", reason }) + "\n\n"

const encoder = new TextEncoder()

// The name of a fault for the log: its tag, never its message.
const faultOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") return error._tag
  return Cause.hasInterrupts(cause) ? "interrupted" : "defect"
}

// One warning of the log for an end of R4.
const warn = (fields: { readonly reason: Reason; readonly fault?: string }) =>
  Effect.logWarning("an event stream ended").pipe(Effect.annotateLogs({ route: "R4", ...fields }))

// A client of R4: its channel, its scope, and what its writer wrote last.
interface Held {
  readonly channel: Channel<LoadedChat>
  readonly client: Client
  readonly scope: Scope.Closeable
  // The client's end, one time (the head comment).
  readonly end: Effect.Effect<void>
  // The time of the writer's last frame.
  wrote: number
}

// Step 2: the hold, the client and the gate's step, as one step.
const admit = (host: EventsHost, found: Found, steps: Steps, after: number): Effect.Effect<Held, Refused> =>
  Effect.uninterruptible(Effect.gen(function*() {
    const channel = yield* host.registry.hold(found.tenant, found.chat)
    const added = yield* Effect.result(channel.addClient(after))
    if (added._tag === "Failure") {
      yield* host.registry.letGo(channel)
      return yield* new Refused({ code: "busy" })
    }
    const client = added.success
    const scope = yield* Scope.make()
    let over = false
    const end = Effect.uninterruptible(Effect.suspend(() => {
      if (over) return Effect.void
      over = true
      return Effect.gen(function*() {
        yield* channel.removeClient(client, null)
        if (client.ended?.reason === "internal") yield* warn({ reason: "internal" })
        yield* Scope.close(scope, Exit.void)
        yield* host.registry.letGo(channel)
      })
    }))
    yield* steps.client(end)
    return { channel, client, scope, end, wrote: yield* Clock.currentTimeMillis }
  }))

// Step 3: the first frame and the timers, in the client's scope.
const start = (host: EventsHost, found: Found, held: Held) =>
  Effect.gen(function*() {
    const { channel, client, scope } = held
    const { limits } = host
    // Ruling 9: Bun writes the head of a streamed answer only with its
    // first chunk that is not empty (an empty chunk does not send it), so
    // the first frame is a ping, told before the first read starts: the
    // head and the first bytes go out at once.
    yield* channel.tell(client, PING)
    const now = yield* Clock.currentTimeMillis
    // The token's `exp`.
    yield* Effect.forkIn(Effect.andThen(Effect.sleep(Math.max(0, found.claims.exp * 1000 - now)), channel.removeClient(client, "token")), scope)
    // The pings: after `ping` ms in which the writer wrote nothing, one, into
    // an empty buffer only, by one step of the give lock (`tellIfEmpty`): a
    // ping never ends the client. A text that waits counts as the ping.
    let checked = now
    yield* Effect.forkIn(
      Effect.gen(function*() {
        while (client.ended === null) {
          const at = yield* Clock.currentTimeMillis
          const due = Math.max(held.wrote, checked) + limits.ping
          if (at < due) {
            yield* Effect.sleep(due - at)
            continue
          }
          checked = at
          if ((yield* channel.tellIfEmpty(client, PING)) === "ended") return
        }
      }),
      scope
    )
    // The watch of the end (ruling 10): when the channel ends the client
    // (`slow` by a give, `stop` by the host, `internal` by `cannotGive`), its
    // end runs, in a fiber of its own, since it closes this scope. The writer
    // cannot see those ends in time: Effect's `Stream.toReadableStreamWith`
    // runs the stream's fiber behind a latch that only the web stream's
    // `pull` opens, so when the reader stops, Bun stops pulling, and the
    // writer waits on that latch, not in `Client.take`.
    yield* Effect.forkIn(Effect.andThen(client.whenEnded, Effect.forkDetach(held.end)), scope)
  })

// The stream: at its start, the first read, in the client's scope; then the
// writer.
const streamOf = (host: EventsHost, found: Found, held: Held): Stream.Stream<Uint8Array> => {
  const { channel, client, scope } = held
  const { limits, reads } = host
  const write = (text: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      held.wrote = now
      return encoder.encode(text)
    })
  // One text of the buffer, and whether the writer goes on.
  type Next = readonly [ReadonlyArray<Uint8Array>, Option.Option<void>]
  const next = (taken: Taken): Effect.Effect<Next> => {
    if (taken._tag === "Text") return Effect.map(write(frameOf(taken.text)), (bytes): Next => [[bytes], Option.some(undefined)])
    if (taken.reason === null) return Effect.succeed<Next>([[], Option.none()])
    return Effect.map(write(closeFrame(taken.reason)), (bytes): Next => [[bytes], Option.none()])
  }
  const frames = Stream.paginate<void, Uint8Array>(undefined, () => Effect.flatMap(client.take, next))
  return Stream.unwrap(Effect.as(
    Effect.forkIn(
      firstRead({ channel, client, read: (after, limit) => found.reads.eventsAfter(after, limit), places: reads, limits }),
      scope
    ),
    frames
  )).pipe(
    // A fault of the writer: the client ends as `internal`, with its frame.
    Stream.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Stream.failCause(cause)
        : Stream.unwrap(Effect.gen(function*() {
          yield* warn({ reason: "internal", fault: faultOf(cause) })
          yield* channel.removeClient(client, "internal")
          return Stream.make(encoder.encode(closeFrame("internal")))
        }))
    )
  )
}

// R4's work (the head comment).
export const eventsWork = (host: EventsHost) => (found: Found, steps: Steps) =>
  Effect.gen(function*() {
    const after = wholeNumber(queryOf(found.request.url).get("after"))
    if (after === undefined) return yield* new Refused({ code: "bad_request" })
    const held = yield* admit(host, found, steps, after)
    yield* start(host, found, held)
    return HttpServerResponse.stream(streamOf(host, found, held), { contentType: "text/event-stream" })
  })

// R4 behind the gate: the route for a request, as a function of the path's
// chat.
export const eventsRoute = (gate: Gate, host: EventsHost) => (chat: string | undefined) => gate.route("R4", chat, eventsWork(host))
