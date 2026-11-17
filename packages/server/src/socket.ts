// R6: the WebSocket, `GET /v1/chats/{chat}/socket` with `Upgrade: websocket`
// (docs/host.md, section 3, "R6: the WebSocket", "Admission" 1, 2 and 11, "A
// token's place"; section 2, "The host's own frames"; section 4; lead,
// ec-hmsqu). It runs behind the gate's member for a socket (http.ts,
// `Gate.socket`): the place, the method and `Upgrade: websocket`, the
// origin. Then, in this order:
//
// 1. The upgrade, with the gate's step `admit` first: one of the `waiting`
//    places for the request's place (past `waiting`, `503 busy` before the
//    upgrade). The host sends no frame before `ready`. A timer of `auth` ms
//    from the upgrade: no `auth` frame by then closes with `4401`. Before
//    the socket is a client the host makes no channel, adds no holder and
//    reads nothing of the store but the lookup of the token's check.
// 2. Each frame, in the order of their arrival, one at a time (the check of
//    an `auth` runs beside the reader, so a frame that comes while it runs
//    comes before `ready`): its size in
//    bytes of UTF-8 (over `early` before `ready`, over `body` after it:
//    `1009`); then its form (a binary frame, a text that is no JSON object,
//    an unknown `type`, a field that its frame does not name, a field of a
//    wrong form: `4400`); then its time (before `ready`, any frame but the
//    first `auth`, a `say` too: `4400`; a second `auth`, at any time:
//    `4400`).
// 3. `auth` (`token`, a text; `after`, a whole number from 0 to 2**53 - 1 or
//    `null`): the gate's checks of the token for the path's chat
//    (`Gate.token`): `unauthorized` closes with `4401`, `no_chat` with
//    `4404`, `internal` with `1011`. A good one: the waiting place goes back;
//    the hold of the channel; `addClient` with `after`, or 0 for `null`
//    (`ClientRefused`: `4503`); the frame `ready`.
// 4. The snapshot, when `after` was `null`, before the first read: with no
//    place held, a wait for room for a page in the client's buffer
//    (`Client.waitForPage`); then, with a place of `reads`, the read and the
//    cut (`cutSnapshot`: the frame is at most `pageBytes` bytes in all) and
//    the put (`Channel.giveTo`, with the frame as an entry of the snapshot's
//    `seq`, which sets the client's `given`). A frame that no longer fits is
//    dropped, and the snapshot starts again at its wait. No room `room` ms
//    after the socket became a client: `4408`; a wait of `readsWait` for the
//    place: `4503`; `SnapshotTooLarge`: `1011`, with a log line of its
//    bytes.
// 5. The events: the first read (`firstRead`), then the gives. One queue and
//    one writer: every frame of the host goes through the client's buffer,
//    and the writer sends each text of it as one frame, as it is.
// 6. `say` (`id`, 1 to 64 bytes of visible ASCII; `text`, a text; `key`, an
//    optional text): it counts in the chat's rate (`Host.count`); then, when
//    another `say` of this socket has no answer yet, `error` `busy` at once;
//    else `Host.say`, and its answer as one frame through the buffer:
//    `said`, or `error` with R1's code for that failure. The socket stays
//    open after an `error`. A `said` or an `error` that finds no room ends
//    the socket with `4408` (the channel ends the client as `slow`).
// 7. A `ping` frame every `ping` ms in which the host sent no frame, only
//    into an empty buffer.
// 8. The ends, each with its code and reason text: the client's end by the
//    channel (`slow` 4408, `busy` 4503, `internal` 1011, `stop` 1001,
//    `token` 4401); the token's `exp` (a timer: the client ends as
//    `token`); the faults above. The reason text never says why a token
//    failed. At each end, and when the client closes the socket or its
//    connection breaks, one time: the session's scope closes, which ends
//    its fibers (the timers, the reads, the writer, a `say` in flight), then
//    the client leaves the channel, the hold is let go, and the waiting
//    place is back. A message whose transaction was done stays logged.
//
// What holds a frame before the host sees it: Bun takes a frame whole
// before it gives it to the host, up to its own bound, `maxPayloadLength`
// of the server's `websocket` options (16 MiB by default). The caller of
// `serve` sets it to `body`: Bun then refuses a larger frame at its header,
// with `1009`, before its payload comes (socket.test.ts measures both).
//
// No log line holds a token, a text of a message or a frame.

import { Clock, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { HttpServerResponse } from "effect/http"
import { CloseEvent, type Socket } from "effect/socket/Socket"
import type { Channel, Client, Reason } from "./channel.ts"
import { utf8 } from "./fit.ts"
import { cutSnapshot } from "./history.ts"
import type { Host } from "./host.ts"
import { type Authorized, ERRORS, type ErrorCode, type Gate, type Upgrading } from "./http.ts"
import type { LoadedChat } from "./loaded.ts"
import { firstRead } from "./reads.ts"

// The close codes and their reason texts (the page's table).
export const CLOSES = {
  unauthorized: { code: 4401, reason: "unauthorized" },
  no_chat: { code: 4404, reason: "no_chat" },
  bad_frame: { code: 4400, reason: "bad_frame" },
  too_large: { code: 1009, reason: "too_large" },
  slow: { code: 4408, reason: "slow" },
  busy: { code: 4503, reason: "busy" },
  internal: { code: 1011, reason: "internal" },
  stop: { code: 1001, reason: "stop" }
} as const

export type Close = keyof typeof CLOSES

// The close of a client's end by the channel, by its reason.
const CLOSE_OF: Record<Reason, Close> = {
  slow: "slow",
  token: "unauthorized",
  busy: "busy",
  stop: "stop",
  internal: "internal"
}

// The host's frames with no field.
const READY = "{\"type\":\"ready\"}"
const PING = "{\"type\":\"ping\"}"

// The snapshot frame's own bytes before the snapshot's fields:
// `{"type":"snapshot",` in place of the snapshot's `{`.
const SNAPSHOT_HEAD = "{\"type\":\"snapshot\","
const SNAPSHOT_EXTRA = utf8(SNAPSHOT_HEAD) - 1

// A frame of the client, as its form allows it.
type Frame =
  | { readonly type: "auth"; readonly token: string; readonly after: number | null }
  | { readonly type: "say"; readonly id: string; readonly text: string; readonly key: string | null }

// The fields of each frame of the client: those it must have, and those it
// may have.
const FIELDS = {
  auth: { required: ["type", "token", "after"], optional: [] as ReadonlyArray<string> },
  say: { required: ["type", "id", "text"], optional: ["key"] }
} as const

// An `id` of `say`: 1 to 64 bytes of visible ASCII.
const ID = /^[\x21-\x7e]{1,64}$/

// The form of a text frame (after its size): the frame, or none.
export const frameOf = (text: string): Frame | undefined => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const object = json as Record<string, unknown>
  const type = object["type"]
  if (type !== "auth" && type !== "say") return undefined
  const fields = FIELDS[type]
  const keys = Object.keys(object)
  for (const name of fields.required) if (!keys.includes(name)) return undefined
  const named: ReadonlyArray<string> = [...fields.required, ...fields.optional]
  for (const key of keys) if (!named.includes(key)) return undefined
  if (type === "auth") {
    const { token, after } = object
    if (typeof token !== "string") return undefined
    if (after !== null && !(typeof after === "number" && Number.isSafeInteger(after) && after >= 0)) return undefined
    return { type, token, after }
  }
  const { id, text: said, key } = object
  if (typeof id !== "string" || !ID.test(id) || typeof said !== "string") return undefined
  if (key !== undefined && typeof key !== "string") return undefined
  return { type, id, text: said, key: key ?? null }
}

// The code of a failure of `Host.count` or `Host.say`, as R1 gives it
// (post.ts).
export const sayCode = (tag: string): ErrorCode => {
  switch (tag) {
    case "TooMany":
      return "too_many"
    case "MessageRefused":
      return "bad_request"
    case "NoChat":
      return "no_chat"
    case "LaunchLive":
      return "chat_elsewhere"
    case "LoadedFull":
    case "ChatBusy":
      return "busy"
    default:
      return "internal"
  }
}

// A socket that is a client: what its token found, its channel, its client.
interface Joined {
  readonly found: Authorized
  readonly channel: Channel<LoadedChat>
  readonly client: Client
}

const errorFrame = (id: string, code: ErrorCode) => JSON.stringify({ type: "error", id, error: code, message: ERRORS[code].message })

// One socket's session, from its upgrade to its end (the head comment).
const session = (
  gate: Gate,
  host: typeof Host.Service,
  upgrading: Upgrading,
  socket: Socket,
  leaveWaiting: Effect.Effect<void>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const { limits, registry } = host
    const places = host.reads
    const scope = yield* Effect.scope
    const writer = yield* socket.writer
    // The end, one time: the close to send, or none (the client closed the
    // socket, or its connection broke).
    const finished = yield* Deferred.make<Close | null>()
    const finish = (close: Close | null) => Deferred.succeed(finished, close)
    // Each fiber of the session runs in its scope, so its end ends them.
    const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.forkIn(effect, scope)

    // The state that the frames change.
    let authed = false
    let ready = false
    let saying = false
    let lastSent = 0
    let client: Joined | undefined

    // No `auth` in `auth` ms: `4401`.
    const authTimer = yield* fork(Effect.andThen(Effect.sleep(limits.auth), Effect.suspend(() => authed ? Effect.void : finish("unauthorized"))))

    // The writer: each text of the client's buffer as one frame, and the
    // client's end as its close.
    const write = (from: Joined) =>
      Effect.gen(function*() {
        while (true) {
          const taken = yield* from.client.take
          if (taken._tag === "End") return yield* finish(taken.reason === null ? null : CLOSE_OF[taken.reason])
          const sent = yield* Effect.exit(writer.write(taken.text))
          if (Exit.isFailure(sent)) return yield* finish(null)
          lastSent = yield* Clock.currentTimeMillis
        }
      })

    // The ping: every `ping` ms with no frame sent, into an empty buffer
    // only, by one step of the give lock (`tellIfEmpty`): a ping never ends
    // the client.
    const ping = (from: Joined) =>
      Effect.gen(function*() {
        while (true) {
          const now = yield* Clock.currentTimeMillis
          const due = lastSent + limits.ping
          if (now < due) {
            yield* Effect.sleep(due - now)
            continue
          }
          yield* from.channel.tellIfEmpty(from.client, PING)
          // A frame waits in the buffer, or the ping was put: either is sent
          // now, and the next ping is due `ping` ms from here at the latest.
          lastSent = Math.max(lastSent, now)
          yield* Effect.sleep(limits.ping)
        }
      })

    // The snapshot (the head comment, 4): `true` when it was put.
    const snapshot = (from: Joined) =>
      Effect.gen(function*() {
        const { channel, client: own, found } = from
        const since = yield* Clock.currentTimeMillis
        while (true) {
          if (own.ended !== null) return false
          if (!own.hasRoom(limits.page, limits.pageBytes)) {
            const left = since + limits.room - (yield* Clock.currentTimeMillis)
            const room = left <= 0
              ? "late" as const
              : yield* Effect.timeoutOrElse(own.waitForPage, { duration: left, orElse: () => Effect.succeed("late" as const) })
            if (room === "late") {
              yield* channel.removeClient(own, "slow")
              return false
            }
            if (!room) return false
          }
          const put = yield* Effect.result(places.withPlace(Effect.gen(function*() {
            const text = yield* cutSnapshot(found.reads, limits.history, limits.pageBytes - SNAPSHOT_EXTRA)
            const seq = (JSON.parse(text) as { readonly seq: number }).seq
            const frame = SNAPSHOT_HEAD + text.slice(1)
            return yield* channel.giveTo(own, [{ _tag: "Entry", json: frame, bytes: utf8(frame), n: seq, cut: false }])
          })))
          if (put._tag === "Failure") {
            const fault = put.failure
            switch (fault._tag) {
              case "ReadsBusy":
                yield* channel.removeClient(own, "busy")
                return false
              case "SnapshotTooLarge":
                yield* Effect.logWarning("the socket's snapshot passes its room: the socket ends as internal").pipe(
                  Effect.annotateLogs({ bytes: fault.bytes + SNAPSHOT_EXTRA, room: limits.pageBytes })
                )
                yield* channel.removeClient(own, "internal")
                return false
              case "StoreError":
                yield* Effect.logWarning(`the socket's snapshot's call of the store failed (${fault.op}): the socket ends as internal`)
                yield* channel.removeClient(own, "internal")
                return false
            }
          }
          if (put.success === "given") return true
          if (put.success === "ended") return false
          // `noRoom`: a frame of the host took the room; again from the wait.
        }
      })

    // The reads: the snapshot when `after` was `null`, then the first read.
    const reads = (from: Joined, after: number | null) =>
      Effect.gen(function*() {
        if (after === null && !(yield* snapshot(from))) return
        yield* firstRead({
          channel: from.channel,
          client: from.client,
          read: (after, limit) => from.found.reads.eventsAfter(after, limit),
          places,
          limits
        })
      })

    // The token's end: at its `exp`, the client ends as `token`.
    const expiry = (from: Joined) =>
      Effect.gen(function*() {
        const left = from.found.claims.exp * 1000 - (yield* Clock.currentTimeMillis)
        if (left > 0) yield* Effect.sleep(left)
        yield* from.channel.removeClient(from.client, "token")
      })

    // `auth` (the head comment, 3).
    const auth = (frame: Extract<Frame, { type: "auth" }>) =>
      Effect.gen(function*() {
        yield* Fiber.interrupt(authTimer)
        const checked = yield* Effect.result(gate.token(frame.token, upgrading.chat))
        if (checked._tag === "Failure") return yield* finish(checked.failure.code)
        const found = checked.success
        yield* leaveWaiting
        const channel = yield* Effect.provideService(registry.held(found.tenant, found.chat), Scope.Scope, scope)
        const added = yield* Effect.result(
          Effect.provideService(Effect.acquireRelease(channel.addClient(frame.after ?? 0), (own) => channel.removeClient(own)), Scope.Scope, scope)
        )
        if (added._tag === "Failure") return yield* finish("busy")
        const from: Joined = { found, channel, client: added.success }
        client = from
        if ((yield* channel.tell(from.client, READY)) === "ended") return
        ready = true
        lastSent = yield* Clock.currentTimeMillis
        yield* fork(write(from))
        yield* fork(ping(from))
        yield* fork(expiry(from))
        yield* fork(reads(from, frame.after))
      })

    // `say` (the head comment, 6).
    const say = (frame: Extract<Frame, { type: "say" }>, from: Joined) =>
      Effect.gen(function*() {
        const { tenant, chat } = from.found
        const answer = (text: string) => Effect.asVoid(from.channel.tell(from.client, text))
        const counted = yield* Effect.result(host.count(tenant, chat))
        if (counted._tag === "Failure") return yield* answer(errorFrame(frame.id, "too_many"))
        if (saying) return yield* answer(errorFrame(frame.id, "busy"))
        saying = true
        yield* fork(Effect.gen(function*() {
          const sent = yield* Effect.result(host.say(tenant, chat, frame.text, frame.key))
          if (sent._tag === "Failure") return yield* answer(errorFrame(frame.id, sayCode(sent.failure._tag)))
          const first = sent.success.messages[0]
          const last = sent.success.messages[sent.success.messages.length - 1]
          if (first === undefined || last === undefined) return yield* answer(errorFrame(frame.id, "internal"))
          return yield* answer(JSON.stringify({ type: "said", id: frame.id, n: sent.success.accepted, first: first.i, last: last.i, repeat: sent.success.repeat }))
        }).pipe(Effect.ensuring(Effect.sync(() => {
          saying = false
        }))))
      })

    // One frame of the client (the head comment, 2).
    const take = (data: Uint8Array | string) =>
      Effect.gen(function*() {
        const bytes = typeof data === "string" ? utf8(data) : data.byteLength
        if (bytes > (ready ? limits.body : limits.early)) return yield* finish("too_large")
        if (typeof data !== "string") return yield* finish("bad_frame")
        const frame = frameOf(data)
        if (frame === undefined) return yield* finish("bad_frame")
        if (frame.type === "auth") {
          if (authed) return yield* finish("bad_frame")
          // The check runs in its own fiber: a frame that comes while it runs
          // comes before `ready`, and is judged so.
          authed = true
          return yield* Effect.asVoid(fork(auth(frame)))
        }
        if (!ready || client === undefined) return yield* finish("bad_frame")
        return yield* say(frame, client)
      })

    // The reader: the frames in their order, until the end.
    const reader = yield* Effect.result(socket.reader)
    if (reader._tag === "Failure") {
      yield* finish(null)
    } else {
      const pull = reader.success.pull
      yield* fork(Effect.gen(function*() {
        while (true) {
          const got = yield* Effect.result(pull)
          if (got._tag === "Failure") return yield* finish(null)
          for (const data of got.success) {
            if (Option.isSome(yield* Deferred.poll(finished))) return
            yield* take(data)
          }
        }
      }))
    }

    const close = yield* Deferred.await(finished)
    if (close !== null) yield* Effect.ignore(writer.write(new CloseEvent(CLOSES[close].code, CLOSES[close].reason)))
  })

// R6's work, behind the gate's member for a socket: the step `admit`, the
// upgrade, then the session in a scope of its own, whose end frees all.
export const socketWork = (gate: Gate, host: typeof Host.Service) => (upgrading: Upgrading) =>
  Effect.scoped(Effect.gen(function*() {
    const leave = yield* upgrading.admit
    yield* Effect.addFinalizer(() => leave)
    const socket = yield* upgrading.request.upgrade
    yield* session(gate, host, upgrading, socket, leave)
    return HttpServerResponse.empty()
  }))

// R6 behind the gate: the route for a request, as a function of the path's
// chat.
export const socketRoute = (gate: Gate, host: typeof Host.Service) => (chat: string | undefined) => gate.socket(chat, socketWork(gate, host))
