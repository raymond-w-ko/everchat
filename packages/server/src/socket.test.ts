// Tests of R6, the WebSocket (socket.ts; docs/host.md, section 3, "R6: the
// WebSocket", "Admission" 1, 2 and 11, "A token's place"; section 2, "The
// host's own frames"; lead, ec-hmsqu): the frames before `auth`, their size,
// form and time, the token, the admission, the snapshot, `say`, the ping,
// the ends, the two tenants, and the two measures of a real server (the
// size of a frame, the idle limit).
//
// Most cases run the route behind the gate with a socket of the test (an
// Effect `Socket` over a queue: the frames of the client in, the host's
// frames and its close out) on Effect's TestClock, over the SQLite store of
// a test file and a stack of the core's hosted set over the tests' fake
// wire. The cases that need a connection run a Bun server on 127.0.0.1 with
// Bun's `WebSocket`, in real time and with small limits. The secret is
// made-up bytes.

import { expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, Redacted, Scope, Semaphore } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, type Reading, Store, StoreError } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import type { Channel } from "./channel.ts"
import { Host, type HostOptions } from "./host.ts"
import { ERRORS, type Gate, makeGate } from "./http.ts"
import type { Limits } from "./limits.ts"
import type { LoadedChat } from "./loaded.ts"
import { CLOSES, sayCode, socketRoute, socketWork } from "./socket.ts"
import { type Claims, makeToken } from "./token.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => i + 7))
const OTHER = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 250 - i))
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
const ORIGIN = "https://app.example"

// Now: half a second into the second `S`.
const S = 1_800_000_000
const NOW = S * 1000 + 500

// The world of a case
// -------------------

const says = (asked: Request, text: string): Reply =>
  reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

// What a case changes: the wire's answer, a wait before the store's
// `append` (one time) or a fault of it, and the reads of a chat (`reading`).
interface World {
  answer: (asked: Request, n: number) => Reply
  stall: Effect.Effect<void> | undefined
  fail: boolean
  reading: (reads: Reading) => Reading
  lookups: Array<{ readonly tenant: string; readonly chat: string }>
  // While set, each lookup of a chat's reads waits for it.
  hold: Deferred.Deferred<void> | undefined
}

const world = (over: Partial<World> = {}): World => ({
  answer: (asked) => says(asked, "A reply."),
  stall: undefined,
  fail: false,
  reading: (reads) => reads,
  lookups: [],
  hold: undefined,
  ...over
})

const stackOf = (w: World) => {
  const wire = fakeWire((asked, n) => w.answer(asked, n))
  return (store: typeof Store.Service) => {
    const base = Layer.succeed(Store, store)
    const memory = Memory.layer.pipe(Layer.provideMerge(base), Layer.provide(compactor(() => "a summary")))
    const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
    const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.succeed({ output: "2", failed: false }) }))
    const functions = hostedLayer(HOSTED).pipe(Layer.provide(memory))
    return Turns.layer({ head: head(HOSTED) }).pipe(
      Layer.provideMerge(memory),
      Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), functions))
    )
  }
}

// `Chats` over the real one: each lookup of a chat's reads is noted, and its
// reads pass through `w.reading`; the store's `append` has the gates of `w`.
const wrap = (real: typeof Chats.Service, w: World) =>
  Chats.of({
    make: real.make,
    reads: (tenant, chat) =>
      Effect.suspend(() => {
        w.lookups.push({ tenant, chat })
        const hold = w.hold
        return Effect.andThen(hold === undefined ? Effect.void : Deferred.await(hold), Effect.map(real.reads(tenant, chat), (reads) => w.reading(reads)))
      }),
    store: (tenant, chat, launch) =>
      Effect.map(real.store(tenant, chat, launch), (store) => ({
        ...store,
        append: (messages, key) =>
          Effect.gen(function*() {
            const stall = w.stall
            w.stall = undefined
            if (stall !== undefined) yield* stall
            if (w.fail) {
              w.fail = false
              return yield* new StoreError({ op: "append", cause: new Error("the test's fault") })
            }
            return yield* store.append(messages, key)
          })
      }))
  })

// The log: each line of the cases' logger, as JSON with its annotations.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])

interface Rig {
  readonly w: World
  readonly host: typeof Host.Service
  readonly gate: Gate
  readonly real: typeof Chats.Service
  readonly file: string
  readonly a1: string
  readonly a2: string
  readonly b1: string
  // Ends the host's layer: each client ends with `stop`.
  readonly stop: Effect.Effect<void>
  // Each hold of a channel taken through the host's registry.
  readonly holds: { count: number }
}

// A host and a gate over a new file, with two chats of A and one of B.
const rigOf = (file: string, limits: Partial<Limits> = {}, w: World = world(), over: Partial<HostOptions> = {}) =>
  Effect.gen(function*() {
    const real = yield* Chats
    const chats = wrap(real, w)
    const scope = yield* Scope.make()
    const layer = Host.layer({ stack: stackOf(w), launch: LAUNCH, secret: SECRET, origins: [ORIGIN], limits, ...over }).pipe(
      Layer.provide(Layer.succeed(Chats, chats))
    )
    const host = Context.get(yield* Layer.buildWithScope(layer, scope), Host)
    const gate = makeGate({ secret: SECRET, origins: [ORIGIN], limits: host.limits, chats })
    const a1 = yield* real.make(TENANT_A, PICK)
    const a2 = yield* real.make(TENANT_A, PICK)
    const b1 = yield* real.make(TENANT_B, PICK)
    // The registry's object is the one that the routes use: count its holds.
    const holds = { count: 0 }
    const registry = host.registry as { held: typeof host.registry.held; hold: typeof host.registry.hold }
    const held = registry.held
    const hold = registry.hold
    registry.held = (tenant, uuid) => Effect.andThen(Effect.sync(() => holds.count++), held(tenant, uuid))
    registry.hold = (tenant, uuid) => Effect.andThen(Effect.sync(() => holds.count++), hold(tenant, uuid))
    return { w, host, gate, real, file, a1, a2, b1, stop: Scope.close(scope, Exit.void), holds } satisfies Rig
  })

// Runs a case over a new file, on Effect's TestClock at NOW.
const run = <A, E>(body: (file: string) => Effect.Effect<A, E, Chats | Scope.Scope>) => {
  const file = newFile()
  return Effect.runPromise(
    Effect.andThen(TestClock.setTime(NOW), body(file)).pipe(
      Effect.scoped,
      Effect.provide(chatsLayer(file)),
      Effect.provide(Layer.merge(TestClock.layer(), capture))
    )
  )
}

// Waits, in real time, until `check` holds (2 s at most).
const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 2_000 && !check(); k++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
    }
    if (!check()) return yield* Effect.die(new Error("the case waited for a state that did not come: " + check.toString()))
  })
// Lets the fibers run, in real time, with the clock still.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

// A token of `claims`, made now.
const mint = (claims: Claims, secret = SECRET) => Effect.orDie(makeToken(secret, claims))

// The socket of a test
// --------------------

const HANG_UP = Symbol("hang up")

interface Fake {
  readonly socket: Socket.Socket
  // A frame of the client.
  readonly send: (data: string | Uint8Array) => Effect.Effect<void>
  readonly sendJson: (value: unknown) => Effect.Effect<void>
  // The client closes the socket.
  readonly hangUp: Effect.Effect<void>
  // The host's frames, as they were written, and its close.
  readonly sent: Array<string>
  closed: { readonly code: number; readonly reason: string | undefined } | undefined
  // While set, each write of the host waits for it.
  blocked: Deferred.Deferred<void> | undefined
  readonly upgrades: { count: number }
}

const fakeSocket = Effect.gen(function*() {
  const inbox = yield* Queue.unbounded<string | Uint8Array | typeof HANG_UP>()
  const fake: Fake = {
    socket: undefined as never,
    send: (data) => Effect.asVoid(Queue.offer(inbox, data)),
    sendJson: (value) => Effect.asVoid(Queue.offer(inbox, JSON.stringify(value))),
    hangUp: Effect.asVoid(Queue.offer(inbox, HANG_UP)),
    sent: [],
    closed: undefined,
    blocked: undefined,
    upgrades: { count: 0 }
  }
  const pull = Effect.gen(function*() {
    const got = yield* Queue.take(inbox)
    if (got === HANG_UP) {
      yield* Queue.offer(inbox, HANG_UP)
      return yield* new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })
    }
    return [got] as const
  })
  const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
    Effect.gen(function*() {
      if (Socket.isCloseEvent(chunk)) {
        fake.closed = { code: chunk.code, reason: chunk.reason }
        return
      }
      const blocked = fake.blocked
      if (blocked !== undefined) yield* Deferred.await(blocked)
      fake.sent.push(typeof chunk === "string" ? chunk : "<binary>")
    })
  ;(fake as { socket: Socket.Socket }).socket = Socket.make({
    reader: Effect.succeed({ pull, upgrade: () => Effect.void }),
    writer: Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) })
  })
  return fake
})

// The upgrade's request for `chat`, whose `upgrade` gives the test's socket.
const upgradeRequest = (fake: Fake, chat: string, headers: Record<string, string> = {}, query = "") => {
  const base = HttpServerRequest.fromWeb(new Request(`http://127.0.0.1/v1/chats/${chat}/socket${query}`, { headers: { upgrade: "websocket", ...headers } }))
  return new Proxy(base, {
    get(target, key) {
      if (key === "upgrade") {
        return Effect.sync(() => {
          fake.upgrades.count += 1
          return fake.socket
        })
      }
      return Reflect.get(target, key, target)
    }
  })
}

// The live clock of the case (the TestClock), with a count of the sleeps
// that have started and not yet ended.
const countingClock = Effect.map(Clock.clockWith(Effect.succeed), (inner) => {
  const counter = { pending: 0 }
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => inner.currentTimeMillisUnsafe(),
    currentTimeMillis: inner.currentTimeMillis,
    currentTimeNanosUnsafe: () => inner.currentTimeNanosUnsafe(),
    currentTimeNanos: inner.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => inner.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: inner.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.suspend(() => {
        counter.pending += 1
        return inner.sleep(duration).pipe(Effect.ensuring(Effect.sync(() => {
          counter.pending -= 1
        })))
      })
  }
  return { clock, counter }
})

interface Opened {
  readonly fake: Fake
  readonly fiber: Fiber.Fiber<import("effect/http").HttpServerResponse.HttpServerResponse>
  readonly counter: { pending: number }
  // The host's frames, parsed.
  readonly frames: () => Array<Record<string, unknown>>
  readonly types: () => Array<unknown>
}

// Opens a socket of the test to `chat` through the gate.
const open = (rig: Rig, chat: string, headers: Record<string, string> = {}, query = "") =>
  Effect.gen(function*() {
    const fake = yield* fakeSocket
    const { clock, counter } = yield* countingClock
    const fiber = yield* Effect.forkChild(
      rig.gate.socket(chat, socketWork(rig.gate, rig.host)).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, upgradeRequest(fake, chat, headers, query)),
        Effect.provideService(Clock.Clock, clock)
      )
    )
    const frames = () => fake.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
    return { fake, fiber, counter, frames, types: () => frames().map((frame) => frame["type"]) } satisfies Opened
  })

// A good token of A for its two chats.
const tokenOf = (rig: Rig, claims: Partial<Claims> = {}) => mint({ tenant: TENANT_A, chats: [rig.a1, rig.a2], exp: S + 600, ...claims })

// Opens a socket, sends a good `auth` with `after`, and waits for `ready`.
const ready = (rig: Rig, after: number | null = 0, chat = rig.a1) =>
  Effect.gen(function*() {
    const opened = yield* open(rig, chat)
    yield* opened.fake.sendJson({ type: "auth", token: yield* tokenOf(rig), after })
    yield* until(() => opened.types().includes("ready"))
    return opened
  })

// The closes of a socket, each code and reason text as the page writes them
// (docs/host.md, section 3, the closes of R6): the cases compare a close
// with this table, never with the code's own `CLOSES` (lead, ec-ek7fa, 3).
const PAGE_CLOSES = {
  unauthorized: { code: 4401, reason: "unauthorized" },
  no_chat: { code: 4404, reason: "no_chat" },
  bad_frame: { code: 4400, reason: "bad_frame" },
  too_large: { code: 1009, reason: "too_large" },
  slow: { code: 4408, reason: "slow" },
  busy: { code: 4503, reason: "busy" },
  internal: { code: 1011, reason: "internal" },
  stop: { code: 1001, reason: "stop" }
} as const

// The socket ended with this close, and its route's fiber has ended.
const closedWith = (opened: Opened, close: keyof typeof PAGE_CLOSES) =>
  Effect.gen(function*() {
    yield* until(() => opened.fake.closed !== undefined && opened.fiber.pollUnsafe() !== undefined)
    expect(opened.fake.closed).toEqual(PAGE_CLOSES[close])
  })

// Nothing of the socket is left: no client, no channel's hold but a loaded
// chat's own, no waiting place, no place of `reads` or of `requests`, no
// sleep of its clock but the unload timer of each chat that its `say` loaded
// (`loads`: a loaded chat runs in the fiber of the message that loaded it).
const nothingLeft = (rig: Rig, opened: Opened, loads = 0) =>
  Effect.gen(function*() {
    yield* until(() => opened.fiber.pollUnsafe() !== undefined)
    yield* settle
    expect(rig.host.registry.size().clients).toBe(0)
    for (const [tenant, chat] of [[TENANT_A, rig.a1], [TENANT_A, rig.a2], [TENANT_B, rig.b1]] as const) {
      const channel = rig.host.registry.find(tenant, chat)
      if (channel !== undefined) expect(channel.holders).toBe(channel.loaded === undefined ? 0 : 1)
    }
    expect(rig.gate.waiting()).toBe(0)
    expect(rig.gate.inFlight()).toBe(0)
    expect(rig.host.reads.taken()).toBe(0)
    expect(opened.counter.pending).toBe(loads)
  })

// The channel of a chat that the host's registry has now.
const channelOf = (rig: Rig, chat: string, tenant = TENANT_A): Channel<LoadedChat> => {
  const channel = rig.host.registry.find(tenant, chat)
  if (channel === undefined) throw new Error("the host has no channel of this chat")
  return channel
}

const ERROR = (id: string, code: keyof typeof ERRORS) => ({ type: "error", id, error: code, message: ERRORS[code].message })

test("the code's closes are the page's: each code and reason text of `CLOSES` as the test's own table of literals has it, and no other close", () => {
  expect(CLOSES).toEqual(PAGE_CLOSES)
})

// Before `auth`
// -------------

test("before `auth` the host sends no frame; no `auth` in `auth` ms closes with 4401; a header Authorization and a token in the query are not read", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const token = yield* tokenOf(rig)
      for (const [headers, query] of [[{}, ""], [{ authorization: "Bearer " + token }, "?token=" + token]] as const) {
        const opened = yield* open(rig, rig.a1, headers, query)
        yield* until(() => rig.gate.waiting() === 1)
        yield* settle
        yield* TestClock.adjust(rig.host.limits.auth - 1)
        yield* settle
        expect(opened.fake.closed).toBeUndefined()
        expect(opened.fake.sent).toEqual([])
        yield* TestClock.adjust(1)
        yield* closedWith(opened, "unauthorized")
        expect(opened.fake.sent).toEqual([])
        expect(rig.w.lookups).toEqual([])
        yield* nothingLeft(rig, opened)
      }
    })
  )
})

test("a frame's form before and after `ready`: each fault closes with 4400 bad_frame", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const token = yield* tokenOf(rig)
      const early: ReadonlyArray<string | Uint8Array> = [
        JSON.stringify({ type: "say", id: "a", text: "hello" }),
        JSON.stringify({ type: "auth", token }),
        JSON.stringify({ type: "auth", token, after: -1 }),
        JSON.stringify({ type: "auth", token, after: 1.5 }),
        JSON.stringify({ type: "auth", token, after: "1" }),
        JSON.stringify({ type: "auth", token, after: 2 ** 53 }),
        JSON.stringify({ type: "auth", token: 7, after: 0 }),
        JSON.stringify({ type: "auth", token, after: 0, extra: 1 }),
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ token, after: 0 }),
        new TextEncoder().encode(JSON.stringify({ type: "auth", token, after: 0 })),
        "[]",
        "1",
        "null",
        "{not json"
      ]
      for (const frame of early) {
        const opened = yield* open(rig, rig.a1)
        yield* opened.fake.send(frame)
        yield* closedWith(opened, "bad_frame")
        expect(opened.fake.sent).toEqual([])
        yield* nothingLeft(rig, opened)
      }
      expect(rig.w.lookups).toEqual([])
      // After `ready`: a binary frame, a frame of no type, a second `auth`.
      for (const frame of [new Uint8Array([1, 2]), "{}", JSON.stringify({ type: "auth", token, after: 0 })]) {
        const opened = yield* ready(rig)
        yield* opened.fake.send(frame)
        yield* closedWith(opened, "bad_frame")
        yield* nothingLeft(rig, opened)
      }
    })
  )
})

test("a second `auth` while the first is checked, and a `say` then, come before `ready`: 4400, and no `ready` is sent", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const rig = yield* rigOf(file, {}, w)
      const token = yield* tokenOf(rig)
      for (const second of [{ type: "auth", token, after: 0 }, { type: "say", id: "a", text: "hello" }]) {
        // The token's lookup waits until the second frame was judged.
        const hold = yield* Deferred.make<void>()
        w.hold = hold
        const opened = yield* open(rig, rig.a1)
        yield* opened.fake.sendJson({ type: "auth", token, after: 0 })
        yield* until(() => w.lookups.length > 0)
        yield* opened.fake.sendJson(second)
        yield* closedWith(opened, "bad_frame")
        yield* Deferred.succeed(hold, undefined)
        w.hold = undefined
        expect(opened.types()).not.toContain("ready")
        yield* nothingLeft(rig, opened)
        w.lookups.length = 0
      }
    })
  )
})

// The size of a frame
// -------------------

// `value` as JSON, with spaces after it to `bytes` bytes in all.
const padded = (value: unknown, bytes: number) => {
  const text = JSON.stringify(value)
  return text + " ".repeat(bytes - new TextEncoder().encode(text).length)
}

test("a frame of `early` + 1 bytes before `ready` closes with 1009, before its form is read; one of `early` passes; after `ready`, `body` + 1 closes with 1009 and `body` passes", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const { early, body } = rig.host.limits
      const token = yield* tokenOf(rig)
      // Over the bound, and no JSON: the size first.
      for (const frame of [padded({ type: "auth", token, after: 0 }, early + 1), "x".repeat(early + 1)]) {
        const opened = yield* open(rig, rig.a1)
        yield* opened.fake.send(frame)
        yield* closedWith(opened, "too_large")
        expect(opened.fake.sent).toEqual([])
        yield* nothingLeft(rig, opened)
      }
      const atBound = yield* open(rig, rig.a1)
      yield* atBound.fake.send(padded({ type: "auth", token, after: 0 }, early))
      yield* until(() => atBound.types().includes("ready"))
      // After `ready`, a frame of `body` bytes is a `say` like any other.
      yield* atBound.fake.send(padded({ type: "say", id: "big", text: "hello" }, body))
      yield* until(() => atBound.types().includes("said"))
      yield* atBound.fake.send("x".repeat(body + 1))
      yield* closedWith(atBound, "too_large")
      yield* nothingLeft(rig, atBound, 1)
    })
  )
})

// The sweep's case (ec-eutgw, 1; draft ec-geivc, 1): a frame's size is its
// UTF-8 bytes, not its length in UTF-16 units. Each frame below has 1,000
// characters of 2 bytes ("é"), so its length is at most the bound and its
// bytes are the bound + 1.
test("a frame's size is its bytes of UTF-8: a frame of 2-byte characters whose length is at most `early` and whose bytes are `early` + 1 closes with 1009 before `ready`; the same against `body` after `ready`", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const { early, body } = rig.host.limits
      const token = yield* tokenOf(rig)
      const wide = "é".repeat(1_000)
      const before = padded({ type: "auth", token: token + wide, after: 0 }, early + 1)
      expect([before.length <= early, new TextEncoder().encode(before).length]).toEqual([true, early + 1])
      const opened = yield* open(rig, rig.a1)
      yield* opened.fake.send(before)
      yield* closedWith(opened, "too_large")
      expect(opened.fake.sent).toEqual([])
      expect(rig.w.lookups).toEqual([])
      yield* nothingLeft(rig, opened)
      const after = padded({ type: "say", id: "wide", text: wide }, body + 1)
      expect([after.length <= body, new TextEncoder().encode(after).length]).toEqual([true, body + 1])
      const joined = yield* ready(rig)
      yield* joined.fake.send(after)
      // The mark: the socket's close, or the `say`'s answer when the frame
      // passed.
      yield* until(() => joined.fake.closed !== undefined || joined.types().includes("said") || joined.types().includes("error"))
      expect(joined.types()).toEqual(["ready"])
      yield* closedWith(joined, "too_large")
      yield* nothingLeft(rig, joined)
    })
  )
})

// The token
// ---------

test("each cause of a token's failure closes with 4401 and the same reason text, with no channel and no client", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const part = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_")
      const good = yield* tokenOf(rig)
      // A token that ended: made earlier, with its `exp` before now.
      yield* TestClock.setTime(NOW - 7_200_000)
      const ended = yield* tokenOf(rig, { exp: S - 3_600 })
      yield* TestClock.setTime(NOW)
      const causes = [
        "",
        "a.b",
        good + "x",
        part({ alg: "none", typ: "JWT" }) + "." + part({ tenant: TENANT_A, chats: [rig.a1], exp: S + 600 }) + ".",
        yield* mint({ tenant: TENANT_A, chats: [rig.a1], exp: S + 600 }, OTHER),
        ended,
        "x".repeat(5_000)
      ]
      for (const token of causes) {
        const opened = yield* open(rig, rig.a1)
        yield* opened.fake.sendJson({ type: "auth", token, after: 0 })
        yield* closedWith(opened, "unauthorized")
        expect(opened.fake.closed).toEqual({ code: 4401, reason: "unauthorized" })
        expect(opened.fake.sent).toEqual([])
        yield* nothingLeft(rig, opened)
      }
      expect(rig.w.lookups).toEqual([])
      expect(rig.holds.count).toBe(0)
      // No line of the log holds a token or a part of one.
      const all = lines.join("\n")
      for (const token of causes) for (const piece of token.split(".").filter((p) => p.length >= 8)) expect(all).not.toContain(piece)
    })
  )
})

test("a token whose `exp` passes after `ready` closes the socket with 4401 at that second, and nothing is left", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const opened = yield* ready(rig)
      yield* settle
      yield* TestClock.adjust((S + 600) * 1000 - NOW - 1)
      yield* settle
      expect(opened.fake.closed).toBeUndefined()
      yield* TestClock.adjust(1)
      yield* closedWith(opened, "unauthorized")
      yield* nothingLeft(rig, opened)
    })
  )
})

// The admission
// -------------

test("an origin off the list gets 403 before the upgrade; past `waiting` a socket gets 503 busy with no retry-after before the upgrade; a socket that waits holds no place of `requests`, no channel and no read of the store; a good `auth` gives its waiting place back", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file, { waiting: 1 })
      const off = yield* open(rig, rig.a1, { origin: "https://evil.example" })
      const offAnswer = yield* Fiber.join(off.fiber)
      expect(offAnswer.status).toBe(403)
      expect(off.fake.upgrades.count).toBe(0)
      const first = yield* open(rig, rig.a1, { origin: ORIGIN })
      yield* until(() => first.fake.upgrades.count === 1)
      expect(rig.gate.waiting()).toBe(1)
      expect(rig.gate.inFlight()).toBe(0)
      expect(rig.host.registry.size()).toEqual({ channels: 0, clients: 0 })
      const second = yield* open(rig, rig.a1)
      const busy = yield* Fiber.join(second.fiber)
      expect(busy.status).toBe(503)
      expect(busy.headers["retry-after"]).toBeUndefined()
      expect(second.fake.upgrades.count).toBe(0)
      yield* settle
      expect(rig.w.lookups).toEqual([])
      expect(rig.holds.count).toBe(0)
      yield* first.fake.sendJson({ type: "auth", token: yield* tokenOf(rig), after: 0 })
      yield* until(() => first.types().includes("ready"))
      expect(rig.w.lookups).toEqual([{ tenant: TENANT_A, chat: rig.a1 }])
      expect(rig.gate.waiting()).toBe(0)
      expect(rig.host.registry.size()).toEqual({ channels: 1, clients: 1 })
      // The waiting place is free again: a third socket waits.
      const third = yield* open(rig, rig.a1)
      yield* until(() => third.fake.upgrades.count === 1)
      expect(rig.gate.waiting()).toBe(1)
      yield* first.fake.hangUp
      yield* third.fake.hangUp
      yield* nothingLeft(rig, first)
      yield* nothingLeft(rig, third)
    })
  )
})

// The sweep's case (ec-eutgw, 2; draft ec-geivc, 2): the waiting place goes
// back only after the token's check, so a socket whose `auth` is checked
// still holds it.
test("while an `auth` is checked (its lookup held), the socket keeps its waiting place: past `waiting` a new socket gets 503 busy before the upgrade; after `ready` the place is back", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const rig = yield* rigOf(file, { waiting: 1 }, w)
      const hold = yield* Deferred.make<void>()
      w.hold = hold
      const first = yield* open(rig, rig.a1)
      yield* until(() => first.fake.upgrades.count === 1)
      yield* first.fake.sendJson({ type: "auth", token: yield* tokenOf(rig), after: 0 })
      // The mark: the token's lookup has started, and waits for `hold`.
      yield* until(() => w.lookups.length === 1)
      expect(rig.gate.waiting()).toBe(1)
      const second = yield* open(rig, rig.a1)
      const busy = yield* Fiber.join(second.fiber)
      expect(busy.status).toBe(503)
      expect(second.fake.upgrades.count).toBe(0)
      expect(first.types()).toEqual([])
      yield* Deferred.succeed(hold, undefined)
      w.hold = undefined
      yield* until(() => first.types().includes("ready"))
      expect(rig.gate.waiting()).toBe(0)
      const third = yield* open(rig, rig.a1)
      yield* until(() => third.fake.upgrades.count === 1)
      expect(rig.gate.waiting()).toBe(1)
      yield* first.fake.hangUp
      yield* third.fake.hangUp
      yield* nothingLeft(rig, first)
      yield* nothingLeft(rig, third)
    })
  )
})

test("past `chatClients` and past `hostClients` a socket closes with 4503 after its `auth`", async () => {
  for (const [limits, other] of [[{ chatClients: 1 }, false], [{ hostClients: 1 }, true]] as const) {
    await run((file) =>
      Effect.gen(function*() {
        const rig = yield* rigOf(file, limits)
        const first = yield* ready(rig)
        const second = yield* open(rig, other ? rig.a2 : rig.a1)
        yield* second.fake.sendJson({ type: "auth", token: yield* tokenOf(rig), after: 0 })
        yield* closedWith(second, "busy")
        expect(second.fake.sent).toEqual([])
        expect(rig.host.registry.size()).toEqual({ channels: 1, clients: 1 })
        yield* first.fake.hangUp
        yield* nothingLeft(rig, first)
        yield* nothingLeft(rig, second)
      })
    )
  }
})

// The two tenants
// ---------------

test("a token of A on the path of B's chat, and A's token that names B's chat, close with 4404: no channel, no client, no frame, and nothing of B is read but the lookup", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const rowsOfB = () => Effect.flatMap(rig.real.reads(TENANT_B, rig.b1), (reads) => Effect.map(Effect.all([reads.chat, reads.messages(0, 1000), reads.eventsAfter(0, 1000)]), (all) => JSON.stringify(all)))
      const before = yield* rowsOfB()
      const used: Array<string> = []
      rig.w.reading = (reads) =>
        new Proxy(reads, {
          get(target, key, receiver) {
            used.push(String(key))
            return Reflect.get(target, key, receiver)
          }
        })
      for (const chats of [[rig.a1], [rig.a1, rig.b1]]) {
        const token = yield* mint({ tenant: TENANT_A, chats, exp: S + 600 })
        for (const path of [rig.b1, "not-a-uuid", rig.a2]) {
          const opened = yield* open(rig, path)
          yield* opened.fake.sendJson({ type: "auth", token, after: 0 })
          yield* closedWith(opened, "no_chat")
          expect(opened.fake.sent).toEqual([])
          yield* nothingLeft(rig, opened)
        }
      }
      // Only the lookup of B's chat named in A's token: A's tenant has none.
      expect(rig.w.lookups).toEqual([{ tenant: TENANT_A, chat: rig.b1 }])
      expect(rig.holds.count).toBe(0)
      expect(rig.host.registry.size()).toEqual({ channels: 0, clients: 0 })
      expect(used).toEqual([])
      expect(yield* rowsOfB()).toBe(before)
    })
  )
})

// The snapshot
// ------------

// Reads whose chat has `count` messages of `size` bytes of text each (made
// up), and whose `snapshot` waits for `stall` (one time) and counts.
const largeChat = (count: number, size: number, counter: { snapshots: number }, stall?: Deferred.Deferred<void>) => {
  let stalled = stall
  return (reads: Reading): Reading =>
    new Proxy(reads, {
      get(target, key, receiver) {
        if (key === "count") return Effect.succeed(count)
        if (key === "messages") {
          return (from: number, to: number) =>
            Effect.succeed(Array.from({ length: Math.max(0, to - from) }, (_, k) => ({
              i: from + k,
              kind: "user" as const,
              text: String(from + k).padEnd(size, "m"),
              size,
              more: false,
              line: null,
              turn: null,
              call: null,
              launch: 1,
              created: 1
            })))
        }
        if (key === "snapshot") {
          return <A, E>(effect: Effect.Effect<A, E>) =>
            Effect.suspend(() => {
              counter.snapshots += 1
              const wait = stalled
              stalled = undefined
              return Effect.andThen(wait === undefined ? Effect.void : Deferred.await(wait), target.snapshot(effect))
            })
        }
        return Reflect.get(target, key, receiver)
      }
    })
}

test("`after: null`: `ready`, then the snapshot, at most `pageBytes` bytes with the newest messages that fit; its `seq` sets the client's `given`, so no event at or below it comes again", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      // Events in the chat: a message of another socket.
      const writer = yield* ready(rig)
      yield* writer.fake.sendJson({ type: "say", id: "one", text: "hello" })
      yield* until(() => writer.frames().some((frame) => frame["type"] === "end"))
      const seq = (yield* (yield* rig.real.reads(TENANT_A, rig.a1)).chat).seq
      expect(seq).toBeGreaterThan(2)
      const reader = yield* ready(rig, null)
      yield* until(() => reader.types().includes("snapshot"))
      yield* settle
      const [first, second, ...rest] = reader.frames()
      expect(first).toEqual({ type: "ready" })
      expect(second?.["type"]).toBe("snapshot")
      expect(second?.["seq"]).toBe(seq)
      expect(Object.keys(second ?? {})).toEqual(["type", "chat", "seq", "count", "messages", "turn"])
      expect(rest.filter((frame) => typeof frame["n"] === "number")).toEqual([])
      // A new message: its events come, each above `seq`, each once, in order.
      yield* writer.fake.sendJson({ type: "say", id: "two", text: "again" })
      yield* until(() => reader.frames().some((frame) => frame["type"] === "end"))
      const numbers = reader.frames().filter((frame) => typeof frame["n"] === "number" && frame["type"] !== "said").map((frame) => frame["n"] as number)
      expect(numbers[0]).toBe(seq + 1)
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, k) => seq + 1 + k))
      yield* reader.fake.hangUp
      yield* writer.fake.hangUp
      yield* nothingLeft(rig, reader)
      yield* nothingLeft(rig, writer, 1)
    })
  )
})

test("the snapshot holds the newest messages that fit in `pageBytes`, the frame's own bytes counted", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const counter = { snapshots: 0 }
      const rig = yield* rigOf(file, {}, world({ reading: largeChat(100, 50_000, counter) }))
      const opened = yield* ready(rig, null)
      yield* until(() => opened.types().includes("snapshot"))
      const text = opened.fake.sent[1] as string
      const bytes = new TextEncoder().encode(text).length
      const pageBytes = rig.host.limits.pageBytes
      expect(bytes).toBeLessThanOrEqual(pageBytes)
      const frame = JSON.parse(text) as { messages: Array<{ i: number; text: string }>; count: number }
      expect(frame.count).toBe(100)
      const ids = frame.messages.map((message) => message.i)
      expect(ids.at(-1)).toBe(99)
      expect(ids).toEqual(Array.from({ length: ids.length }, (_, k) => 100 - ids.length + k))
      // One more message would pass the bound.
      const one = new TextEncoder().encode(JSON.stringify(frame.messages[0])).length + 1
      expect(bytes + one).toBeGreaterThan(pageBytes)
      expect(counter.snapshots).toBe(1)
      yield* opened.fake.hangUp
      yield* nothingLeft(rig, opened)
    })
  )
})

test("the snapshot waits for room with no place held; a `said` that takes its room makes it start again; the first read's `room` runs from the frame's put; with no room the first read ends the socket with 4408", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const counter = { snapshots: 0 }
      const stall = yield* Deferred.make<void>()
      // A buffer of one entry: a `said` in it leaves no room for the frame.
      const rig = yield* rigOf(file, { buffer: 1, page: 1 }, world({ reading: largeChat(3, 10, counter, stall) }))
      const fake = yield* fakeSocket
      // The writer waits on its first frame, `ready`.
      const first = yield* Deferred.make<void>()
      fake.blocked = first
      const { clock, counter: sleeps } = yield* countingClock
      const fiber = yield* Effect.forkChild(
        rig.gate.socket(rig.a1, socketWork(rig.gate, rig.host)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, upgradeRequest(fake, rig.a1)),
          Effect.provideService(Clock.Clock, clock)
        )
      )
      const opened: Opened = { fake, fiber, counter: sleeps, frames: () => fake.sent.map((t) => JSON.parse(t)), types: () => fake.sent.map((t) => JSON.parse(t)["type"]) }
      yield* fake.sendJson({ type: "auth", token: yield* tokenOf(rig), after: null })
      // The snapshot's read waits; a `said` comes into the buffer meanwhile.
      yield* until(() => counter.snapshots === 1)
      yield* fake.sendJson({ type: "say", id: "s1", text: "hello" })
      const client = () => channelOf(rig, rig.a1).clients[0]!
      yield* until(() => client().size.entries === 1)
      yield* Deferred.succeed(stall, undefined)
      // No room for the frame: dropped; the snapshot waits, with no place.
      yield* settle
      expect(rig.host.reads.taken()).toBe(0)
      expect(counter.snapshots).toBe(1)
      const start = yield* Clock.currentTimeMillis
      yield* TestClock.adjust(20_000)
      yield* settle
      expect(fake.closed).toBeUndefined()
      // The writer goes on, and waits again on its next frame: the `said`
      // leaves the buffer, the snapshot is read again and put, and stays.
      const second = yield* Deferred.make<void>()
      fake.blocked = second
      yield* Deferred.succeed(first, undefined)
      yield* until(() => counter.snapshots === 2 && client().size.entries === 1)
      expect(fake.sent).toEqual([JSON.stringify({ type: "ready" })])
      // The first read waits for room from the put: `room` from here, not
      // from the socket's start.
      yield* settle
      yield* TestClock.adjust(rig.host.limits.room - 1)
      yield* settle
      expect(fake.closed).toBeUndefined()
      expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThan(rig.host.limits.room)
      yield* TestClock.adjust(1)
      yield* Deferred.succeed(second, undefined)
      yield* closedWith(opened, "slow")
      yield* nothingLeft(rig, opened, 1)
    })
  )
})

test("the snapshot: no room `room` ms after the socket became a client closes with 4408; a wait of `readsWait` for its place, 4503; `SnapshotTooLarge`, 1011 with a log line of its bytes", async () => {
  await run((file) =>
    Effect.gen(function*() {
      // No room: a frame of the host stays in a buffer of one entry.
      const rig = yield* rigOf(file, { buffer: 1, page: 1 })
      const fake = yield* fakeSocket
      const held = yield* Deferred.make<void>()
      fake.blocked = held
      const opened = yield* Effect.gen(function*() {
        const { clock, counter } = yield* countingClock
        const fiber = yield* Effect.forkChild(
          rig.gate.socket(rig.a1, socketWork(rig.gate, rig.host)).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, upgradeRequest(fake, rig.a1)),
            Effect.provideService(Clock.Clock, clock)
          )
        )
        return { fake, fiber, counter, frames: () => [], types: () => [] } satisfies Opened
      })
      yield* fake.sendJson({ type: "auth", token: yield* tokenOf(rig), after: null })
      yield* until(() => rig.host.registry.size().clients === 1)
      yield* settle
      yield* channelOf(rig, rig.a1).tell(channelOf(rig, rig.a1).clients[0]!, "{\"type\":\"filler\"}")
      yield* settle
      yield* TestClock.adjust(rig.host.limits.room - 1)
      yield* settle
      expect(fake.closed).toBeUndefined()
      yield* TestClock.adjust(1)
      yield* Deferred.succeed(held, undefined)
      yield* closedWith(opened, "slow")
      yield* nothingLeft(rig, opened)
    })
  )
  await run((file) =>
    Effect.gen(function*() {
      // The one place of `reads` is taken.
      const rig = yield* rigOf(file, { reads: 1 })
      const latch = yield* Deferred.make<void>()
      const holding = yield* Effect.forkChild(rig.host.reads.withPlace(Deferred.await(latch)))
      const opened = yield* ready(rig, null)
      yield* settle
      yield* TestClock.adjust(rig.host.limits.readsWait)
      yield* closedWith(opened, "busy")
      expect(opened.types().filter((type) => type !== "ping")).toEqual(["ready"])
      yield* Deferred.succeed(latch, undefined)
      yield* Fiber.join(holding)
      yield* nothingLeft(rig, opened)
    })
  )
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const rig = yield* rigOf(file, {}, w)
      const pageBytes = rig.host.limits.pageBytes
      w.reading = (reads) =>
        new Proxy(reads, {
          get(target, key, receiver) {
            if (key === "chat") return Effect.map(target.chat, (chat) => ({ ...chat, goal: "g".repeat(pageBytes) }))
            return Reflect.get(target, key, receiver)
          }
        })
      lines.length = 0
      const opened = yield* ready(rig, null)
      yield* closedWith(opened, "internal")
      const logged = lines.map((line) => JSON.parse(line) as { annotations: Record<string, unknown> }).filter((line) => line.annotations["bytes"] !== undefined)
      expect(logged.length).toBe(1)
      expect(logged[0]?.annotations["bytes"]).toBeGreaterThan(pageBytes)
      expect(lines.join("\n")).not.toContain("ggggggggg")
      yield* nothingLeft(rig, opened)
    })
  )
})

// `say`
// -----

test("`say`: `said` and the turn's events and pieces, each number once and in order; a `say` again with its key gives `repeat: true` and the same numbers", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const opened = yield* ready(rig)
      yield* opened.fake.sendJson({ type: "say", id: "first", text: "hello", key: "k-1" })
      yield* until(() => opened.frames().some((frame) => frame["type"] === "end"))
      const said = opened.frames().find((frame) => frame["type"] === "said")
      expect(said).toMatchObject({ type: "said", id: "first", repeat: false })
      expect(Object.keys(said ?? {})).toEqual(["type", "id", "n", "first", "last", "repeat"])
      const events = opened.frames().filter((frame) => frame["type"] !== "said" && frame["type"] !== "ready" && frame["type"] !== "ping")
      const numbers = events.filter((frame) => typeof frame["n"] === "number").map((frame) => frame["n"])
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, k) => k + 1))
      expect(numbers[0]).toBe(said?.["n"])
      expect(events.map((frame) => frame["type"])).toContain("text")
      yield* opened.fake.sendJson({ type: "say", id: "again", text: "hello", key: "k-1" })
      yield* until(() => opened.frames().filter((frame) => frame["type"] === "said").length === 2)
      const again = opened.frames().filter((frame) => frame["type"] === "said")[1]
      expect(again).toEqual({ ...said, id: "again", repeat: true })
      yield* opened.fake.hangUp
      yield* nothingLeft(rig, opened, 1)
    })
  )
})

test("`say`'s form: each fault closes with 4400", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const faults: ReadonlyArray<Record<string, unknown>> = [
        { type: "say", id: "", text: "a" },
        { type: "say", id: "x".repeat(65), text: "a" },
        { type: "say", id: "with space", text: "a" },
        { type: "say", id: "é", text: "a" },
        { type: "say", id: 1, text: "a" },
        { type: "say", text: "a" },
        { type: "say", id: "a" },
        { type: "say", id: "a", text: 1 },
        { type: "say", id: "a", text: "a", key: 1 },
        { type: "say", id: "a", text: "a", key: null },
        { type: "say", id: "a", text: "a", extra: true }
      ]
      for (const frame of faults) {
        const opened = yield* ready(rig)
        yield* opened.fake.sendJson(frame)
        yield* closedWith(opened, "bad_frame")
        expect(opened.types()).toEqual(["ready"])
        yield* nothingLeft(rig, opened)
      }
      // At the bound of `id`: 64 bytes of visible ASCII.
      const opened = yield* ready(rig)
      yield* opened.fake.sendJson({ type: "say", id: "~".repeat(64), text: "" })
      yield* until(() => opened.types().includes("error"))
      expect(opened.fake.closed).toBeUndefined()
      yield* opened.fake.hangUp
      yield* nothingLeft(rig, opened)
    })
  )
})

test("a second `say` before the first's answer gets `error` `busy` at once, and the first still gets its `said`; the 31st `say` of a window gets `error` `too_many`", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const rig = yield* rigOf(file, {}, w)
      const opened = yield* ready(rig)
      const latch = yield* Deferred.make<void>()
      w.stall = Deferred.await(latch)
      yield* opened.fake.sendJson({ type: "say", id: "s1", text: "one" })
      for (let k = 2; k <= 31; k++) yield* opened.fake.sendJson({ type: "say", id: "s" + k, text: "more" })
      yield* until(() => opened.types().filter((type) => type === "error").length === 30)
      const errors = opened.frames().filter((frame) => frame["type"] === "error")
      expect(errors.slice(0, 29)).toEqual(Array.from({ length: 29 }, (_, k) => ERROR("s" + (k + 2), "busy")))
      expect(errors[29]).toEqual(ERROR("s31", "too_many"))
      expect(opened.types()).not.toContain("said")
      yield* Deferred.succeed(latch, undefined)
      yield* until(() => opened.types().includes("said"))
      expect(opened.frames().find((frame) => frame["type"] === "said")?.["id"]).toBe("s1")
      expect(opened.fake.closed).toBeUndefined()
      yield* opened.fake.hangUp
      yield* nothingLeft(rig, opened, 1)
    })
  )
})

test("each failure of `say` gives R1's code in an `error` frame, and the socket stays open; a fault of the store is `internal`, a held lock `busy`, an empty text `bad_request`", async () => {
  expect(["TooMany", "MessageRefused", "NoChat", "LaunchLive", "LoadedFull", "ChatBusy", "StoreError", "StackFailed"].map(sayCode)).toEqual([
    "too_many",
    "bad_request",
    "no_chat",
    "chat_elsewhere",
    "busy",
    "busy",
    "internal",
    "internal"
  ])
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const rig = yield* rigOf(file, {}, w)
      const opened = yield* ready(rig)
      const errorOf = (id: string) => opened.frames().find((frame) => frame["id"] === id)
      yield* opened.fake.sendJson({ type: "say", id: "empty", text: "" })
      yield* until(() => errorOf("empty") !== undefined)
      expect(errorOf("empty")).toEqual(ERROR("empty", "bad_request"))
      w.fail = true
      yield* opened.fake.sendJson({ type: "say", id: "fault", text: "hello" })
      yield* until(() => errorOf("fault") !== undefined)
      expect(errorOf("fault")).toEqual(ERROR("fault", "internal"))
      // The channel's lock held past `lockWait`.
      const channel = channelOf(rig, rig.a1)
      const release = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(channel.lock.withPermits(1)(Deferred.await(release)))
      yield* settle
      yield* opened.fake.sendJson({ type: "say", id: "held", text: "hello" })
      yield* settle
      yield* TestClock.adjust(rig.host.limits.lockWait)
      yield* until(() => errorOf("held") !== undefined)
      expect(errorOf("held")).toEqual(ERROR("held", "busy"))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      // Still open: a good `say` is answered.
      yield* opened.fake.sendJson({ type: "say", id: "good", text: "hello" })
      yield* until(() => errorOf("good")?.["type"] === "said")
      expect(opened.fake.closed).toBeUndefined()
      yield* opened.fake.hangUp
      yield* nothingLeft(rig, opened, 1)
    })
  )
})

test("a `said` that finds no room in the buffer ends the socket with 4408", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file, { buffer: 1, page: 1 })
      // Events in the chat, from another socket.
      const other = yield* ready(rig)
      yield* other.fake.sendJson({ type: "say", id: "one", text: "hello" })
      yield* until(() => other.frames().some((frame) => frame["type"] === "end"))
      yield* other.fake.hangUp
      // This socket's writer waits on `ready`; its first read puts one event
      // into its buffer of one entry and waits for room: it has not joined.
      const fake = yield* fakeSocket
      const held = yield* Deferred.make<void>()
      fake.blocked = held
      const { clock, counter } = yield* countingClock
      const fiber = yield* Effect.forkChild(
        rig.gate.socket(rig.a1, socketWork(rig.gate, rig.host)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, upgradeRequest(fake, rig.a1)),
          Effect.provideService(Clock.Clock, clock)
        )
      )
      const opened: Opened = { fake, fiber, counter, frames: () => [], types: () => [] }
      yield* fake.sendJson({ type: "auth", token: yield* tokenOf(rig), after: 0 })
      yield* until(() => rig.host.registry.find(TENANT_A, rig.a1)?.clients.length === 1 && channelOf(rig, rig.a1).clients[0]!.size.entries === 1)
      const client = channelOf(rig, rig.a1).clients[0]!
      expect(client.joined).toBe(false)
      yield* fake.sendJson({ type: "say", id: "two", text: "hello" })
      // The `said` found no room: the channel ended the client as `slow`.
      yield* until(() => client.ended !== null)
      expect(client.ended).toEqual({ reason: "slow" })
      yield* Deferred.succeed(held, undefined)
      yield* closedWith(opened, "slow")
      expect(fake.sent.map((text) => JSON.parse(text)["type"])).toEqual(["ready"])
      yield* nothingLeft(rig, opened)
      yield* nothingLeft(rig, other, 1)
    })
  )
})

// The ping
// --------

test("a `ping` each `ping` ms in which the host sent no frame, and none into a buffer that holds a text", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const { ping } = rig.host.limits
      const opened = yield* ready(rig)
      yield* settle
      yield* TestClock.adjust(ping - 1)
      yield* settle
      expect(opened.types()).toEqual(["ready"])
      yield* TestClock.adjust(1)
      yield* until(() => opened.types().length === 2)
      expect(opened.types()).toEqual(["ready", "ping"])
      yield* settle
      yield* TestClock.adjust(ping)
      yield* until(() => opened.types().length === 3)
      expect(opened.types()).toEqual(["ready", "ping", "ping"])
      // The writer waits on a text, and another text waits in the buffer.
      const held = yield* Deferred.make<void>()
      opened.fake.blocked = held
      const channel = channelOf(rig, rig.a1)
      const client = channel.clients[0]!
      yield* channel.tell(client, "{\"type\":\"one\"}")
      yield* channel.tell(client, "{\"type\":\"two\"}")
      yield* until(() => client.size.entries === 1)
      yield* settle
      yield* TestClock.adjust(ping)
      yield* settle
      expect(client.size.entries).toBe(1)
      yield* Deferred.succeed(held, undefined)
      opened.fake.blocked = undefined
      yield* until(() => opened.types().length === 5)
      expect(opened.types()).toEqual(["ready", "ping", "ping", "one", "two"])
      yield* opened.fake.hangUp
      yield* nothingLeft(rig, opened)
    })
  )
})

// The review's case (ec-wl95b; lead, ec-ek7fa), for a socket after `ready`:
// a ping that falls due while an event waits on the give lock, with a
// buffer of one entry. The event is given first; the ping finds a text in
// the buffer, puts nothing and does not end the client. At 999 ms, the
// control: no ping is due yet.
for (const due of [1_000, 999]) {
  test(`after \`ready\`, an event that waits on the give lock while a ping falls due (at ${due} ms after \`ready\`) is given, and the ping puts nothing and ends nothing: buffer 1, page 1`, async () => {
    await run((file) =>
      Effect.gen(function*() {
        const rig = yield* rigOf(file, { buffer: 1, page: 1, ping: 1_000 })
        const opened = yield* ready(rig)
        yield* settle
        const channel = channelOf(rig, rig.a1)
        const client = channel.clients[0]!
        expect({ joined: client.joined, size: client.size }).toEqual({ joined: true, size: { entries: 0, bytes: 0 } })
        // The writer takes one text and waits on its write: nothing pulls.
        const held = yield* Deferred.make<void>()
        opened.fake.blocked = held
        yield* channel.tell(client, "{\"type\":\"one\"}")
        yield* until(() => client.size.entries === 0)
        const waiters = () => (channel.giveLock as unknown as { readonly waiters: Set<unknown> }).waiters.size
        yield* Semaphore.take(channel.giveLock, 1)
        const json = JSON.stringify({ type: "start", n: 1, turn: 1 })
        const giving = yield* Effect.forkChild(channel.give({ _tag: "Entry", json, bytes: Buffer.byteLength(json), n: 1, cut: false }))
        yield* until(() => waiters() === 1)
        yield* TestClock.adjust(due)
        // At 1,000 ms the ping waits on the lock behind the event.
        if (due === 1_000) yield* until(() => waiters() === 2)
        else {
          yield* settle
          expect(waiters()).toBe(1)
        }
        yield* Semaphore.release(channel.giveLock, 1)
        yield* Fiber.join(giving)
        yield* settle
        expect({ ended: client.ended, size: client.size, clients: channel.clients.length }).toEqual({
          ended: null,
          size: { entries: 1, bytes: Buffer.byteLength(json) },
          clients: 1
        })
        yield* Deferred.succeed(held, undefined)
        opened.fake.blocked = undefined
        yield* until(() => opened.types().length === 3)
        yield* settle
        expect(opened.types()).toEqual(["ready", "one", "start"])
        expect(opened.fake.closed).toBeUndefined()
        yield* opened.fake.hangUp
        yield* nothingLeft(rig, opened)
      })
    )
  })
}

// The ends
// --------

test("each end, with its code and reason text, and nothing left after it: `slow`, `busy`, `internal`, `stop`, the client's close", async () => {
  // `slow`: a full buffer.
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file, { buffer: 1, page: 1 })
      const opened = yield* ready(rig)
      opened.fake.blocked = yield* Deferred.make<void>()
      const channel = channelOf(rig, rig.a1)
      const client = channel.clients[0]!
      yield* channel.tell(client, "{\"type\":\"one\"}")
      yield* until(() => client.size.entries === 0)
      yield* channel.tell(client, "{\"type\":\"two\"}")
      yield* channel.tell(client, "{\"type\":\"three\"}")
      yield* Deferred.succeed(opened.fake.blocked, undefined)
      yield* closedWith(opened, "slow")
      yield* nothingLeft(rig, opened)
    })
  )
  // `busy`: the first read waits `readsWait` for a place.
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file, { reads: 1 })
      const latch = yield* Deferred.make<void>()
      const holding = yield* Effect.forkChild(rig.host.reads.withPlace(Deferred.await(latch)))
      const opened = yield* ready(rig)
      yield* settle
      yield* TestClock.adjust(rig.host.limits.readsWait)
      yield* closedWith(opened, "busy")
      yield* Deferred.succeed(latch, undefined)
      yield* Fiber.join(holding)
      yield* nothingLeft(rig, opened)
    })
  )
  // `internal`: an event that cannot be given; `stop`: the host's end; and
  // the client's own close, which sends no close.
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const broken = yield* ready(rig)
      yield* until(() => channelOf(rig, rig.a1).clients[0]?.joined === true)
      yield* channelOf(rig, rig.a1).cannotGive(1)
      yield* closedWith(broken, "internal")
      yield* nothingLeft(rig, broken)
    })
  )
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const stopped = yield* ready(rig)
      const leaving = yield* ready(rig)
      yield* leaving.fake.hangUp
      yield* until(() => leaving.fiber.pollUnsafe() !== undefined)
      expect(leaving.fake.closed).toBeUndefined()
      yield* settle
      expect(rig.host.registry.size().clients).toBe(1)
      expect(channelOf(rig, rig.a1).holders).toBe(1)
      expect(leaving.counter.pending).toBe(0)
      yield* rig.stop
      yield* closedWith(stopped, "stop")
      yield* until(() => stopped.fiber.pollUnsafe() !== undefined)
      expect(rig.host.registry.size().clients).toBe(0)
      expect(rig.gate.waiting()).toBe(0)
      expect(stopped.counter.pending).toBe(0)
    })
  )
})

// The numbers
// -----------

test("an `after` above the chat's `seq` joins and gets no event at or below it; a second socket of the chat gets the events live", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const rig = yield* rigOf(file)
      const live = yield* ready(rig, 0)
      const high = yield* ready(rig, 2)
      yield* until(() => channelOf(rig, rig.a1).clients.every((client) => client.joined))
      yield* live.fake.sendJson({ type: "say", id: "one", text: "hello" })
      yield* until(() => live.frames().some((frame) => frame["type"] === "end"))
      yield* settle
      const numbered = (opened: Opened) => opened.frames().filter((frame) => typeof frame["n"] === "number" && frame["type"] !== "said").map((frame) => frame["n"] as number)
      const all = numbered(live)
      expect(all).toEqual(Array.from({ length: all.length }, (_, k) => k + 1))
      expect(all.length).toBeGreaterThan(2)
      expect(numbered(high)).toEqual(all.filter((n) => n > 2))
      yield* live.fake.hangUp
      yield* high.fake.hangUp
      yield* nothingLeft(rig, live, 1)
      yield* nothingLeft(rig, high)
    })
  )
})

// Over a connection
// -----------------

// A host and a gate over a new file, with R6 on a Bun server on 127.0.0.1,
// in real time; `websocket` is Bun's options of the server's sockets.
const serveHost = async (limits: Partial<Limits> = {}, websocket: BunHttpServer.WebSocketOptions = {}) => {
  const file = newFile()
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(Effect.gen(function*() {
    const context = yield* Layer.buildWithScope(chatsLayer(file), scope)
    const real = Context.get(context, Chats)
    const host = Context.get(
      yield* Layer.buildWithScope(Host.layer({ stack: stackOf(world()), launch: LAUNCH, secret: SECRET, origins: [ORIGIN], limits }).pipe(Layer.provide(Layer.succeed(Chats, real))), scope),
      Host
    )
    const gate = makeGate({ secret: SECRET, origins: [ORIGIN], limits: host.limits, chats: real })
    const server = yield* Layer.buildWithScope(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, websocket }), scope)
    const route = HttpRouter.route("GET", "/v1/chats/:chat/socket", Effect.flatMap(HttpRouter.params, (params) => socketRoute(gate, host)(params["chat"])))
    yield* Layer.buildWithScope(HttpRouter.serve(HttpRouter.addAll([route]), { disableLogger: true, disableListenLog: true }).pipe(Layer.provide(capture)), scope).pipe(
      Effect.provide(server)
    )
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
    const a1 = yield* real.make(TENANT_A, PICK)
    const token = yield* Effect.orDie(makeToken(SECRET, { tenant: TENANT_A, chats: [a1], exp: Math.floor(Date.now() / 1000) + 600 }))
    return { host, gate, port, a1, token }
  }))
  return { ...built, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

// A socket of Bun's `WebSocket` client: its frames, parsed, and its close.
const connect = (port: number, chat: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chats/${chat}/socket`)
  const got: Array<Record<string, unknown>> = []
  const state: { closed: { code: number; reason: string } | undefined; at: number | undefined } = { closed: undefined, at: undefined }
  ws.onmessage = (event) => got.push(JSON.parse(String(event.data)))
  ws.onclose = (event) => {
    state.closed = { code: event.code, reason: event.reason }
    state.at = Date.now()
  }
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("the socket did not open"))
  })
  return { ws, got, state, opened, types: () => got.map((frame) => frame["type"]) }
}

// Waits, in real time, until `check` holds or `ms` pass; gives whether it holds.
const within = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5))
  return check()
}

test("over a connection, the whole way: `auth` with `after: null` gives `ready` and the snapshot; a `say` gives `said` and the turn's events and pieces, each number once, in order; `auth` with a number gives `ready` and the events after it, no snapshot; a `say` again with its key gives `repeat: true`", async () => {
  const served = await serveHost()
  try {
    const one = connect(served.port, served.a1)
    await one.opened
    one.ws.send(JSON.stringify({ type: "auth", token: served.token, after: null }))
    expect(await within(() => one.got.length >= 2, 2_000)).toBe(true)
    expect(one.types().slice(0, 2)).toEqual(["ready", "snapshot"])
    expect(one.got[1]?.["seq"]).toBe(0)
    one.ws.send(JSON.stringify({ type: "say", id: "m1", text: "hello", key: "key-1" }))
    expect(await within(() => one.types().includes("end") && one.types().includes("said"), 3_000)).toBe(true)
    const said = one.got.find((frame) => frame["type"] === "said")
    expect(said).toMatchObject({ type: "said", id: "m1", n: 1, repeat: false })
    const numbers = one.got.filter((frame) => typeof frame["n"] === "number" && frame["type"] !== "said").map((frame) => frame["n"])
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, k) => k + 1))
    expect(one.types()).toContain("text")
    // A second socket from event 2: the events after it, from the store.
    const two = connect(served.port, served.a1)
    await two.opened
    two.ws.send(JSON.stringify({ type: "auth", token: served.token, after: 2 }))
    expect(await within(() => two.got.filter((frame) => typeof frame["n"] === "number").length === numbers.length - 2, 2_000)).toBe(true)
    expect(two.types()[0]).toBe("ready")
    expect(two.types()).not.toContain("snapshot")
    expect(two.got.filter((frame) => typeof frame["n"] === "number").map((frame) => frame["n"])).toEqual(numbers.slice(2))
    // The same key again: the first message's numbers.
    one.ws.send(JSON.stringify({ type: "say", id: "m2", text: "hello", key: "key-1" }))
    expect(await within(() => one.got.filter((frame) => frame["type"] === "said").length === 2, 2_000)).toBe(true)
    expect(one.got.filter((frame) => frame["type"] === "said")[1]).toEqual({ ...said, id: "m2", repeat: true })
    one.ws.close()
    two.ws.close()
    expect(await within(() => served.host.registry.size().clients === 0 && served.gate.waiting() === 0, 2_000)).toBe(true)
  } finally {
    await served.close()
  }
})

// A raw client: the handshake, then one masked text frame of `size` bytes,
// sent as its header and its first 1,024 bytes; the rest 300 ms later, if
// the connection is still open. It gives what came back: the close frame's
// code, whether the rest was sent, and the ms from the header to the close.
const rawFrame = (port: number, path: string, size: number) =>
  new Promise<{ code: number | undefined; restSent: boolean; ms: number | undefined }>((resolve) => {
    let got = Buffer.alloc(0)
    let upgraded = false
    let restSent = false
    let code: number | undefined
    let sentAt = 0
    let closedAt: number | undefined
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
        },
        data(socket, data) {
          got = Buffer.concat([got, Buffer.from(data)])
          if (!upgraded) {
            const at = got.indexOf("\r\n\r\n")
            if (at < 0) return
            upgraded = true
            got = got.subarray(at + 4)
            const head = Buffer.alloc(14)
            head[0] = 0x81
            head[1] = 0x80 | 127
            head.writeBigUInt64BE(BigInt(size), 2)
            const body = Buffer.alloc(size, 0x61)
            socket.write(Buffer.concat([head, body.subarray(0, 1024)]))
            sentAt = Date.now()
            setTimeout(() => {
              if (closedAt !== undefined) return
              socket.write(body.subarray(1024))
              restSent = true
            }, 300)
          }
          if (got.length >= 4 && (got[0]! & 0x0f) === 0x8) code = got.readUInt16BE(2)
        },
        close() {
          closedAt = Date.now()
          resolve({ code, restSent, ms: closedAt - sentAt })
        }
      }
    })
    setTimeout(() => resolve({ code, restSent, ms: undefined }), 1_500)
  })

// Measure 9: what holds a frame before the host sees it (lead, ec-hmsqu).
test("over a connection, the size of a frame: with Bun's `maxPayloadLength` at `body`, a frame of `body` + 1 is refused at its header with 1009, before its payload comes; with Bun's own bound, Bun holds a frame whole and the host closes with 1009 when it gets it", async () => {
  const bound = await serveHost({}, { maxPayloadLength: 524_288 })
  const open = await serveHost()
  try {
    const { body, early } = bound.host.limits
    expect(body).toBe(524_288)
    const refused = await rawFrame(bound.port, `/v1/chats/${bound.a1}/socket`, body + 1)
    expect(refused.code).toBe(1009)
    expect(refused.restSent).toBe(false)
    expect(refused.ms).toBeLessThan(300)
    // Bun's own bound (16 MiB): the frame reaches the host whole, before
    // `ready` over `early` and after it over `body`.
    const beforeReady = connect(open.port, open.a1)
    await beforeReady.opened
    beforeReady.ws.send("x".repeat(early + 1))
    expect(await within(() => beforeReady.state.closed !== undefined, 2_000)).toBe(true)
    expect(beforeReady.state.closed).toEqual({ code: 1009, reason: "too_large" })
    const afterReady = connect(open.port, open.a1)
    await afterReady.opened
    afterReady.ws.send(JSON.stringify({ type: "auth", token: open.token, after: 0 }))
    expect(await within(() => afterReady.types().includes("ready"), 2_000)).toBe(true)
    afterReady.ws.send("x".repeat(body + 1))
    expect(await within(() => afterReady.state.closed !== undefined, 2_000)).toBe(true)
    expect(afterReady.state.closed).toEqual({ code: 1009, reason: "too_large" })
  } finally {
    await bound.close()
    await open.close()
  }
})

// Measure 10: the WebSocket's idle limit (lead, ec-hmsqu). Bun's idle limit
// of a socket has a floor of about 8 s: an `idleTimeout` of 1, 4 or 8 each
// closed an idle socket at 8.0 s (Bun 1.4.4). Three sockets after `ready`,
// each on a server with `idleTimeout: 8`, none of which sends a frame:
// (A) the host's pings on (every second), Bun's `sendPings` off; (B) no
// pings at all, the control; (C) Bun's pings only, which Bun's client
// answers. When B closes, A and C are open. The measure starts when the file
// is loaded, so its wait runs beside the other cases; its case reads it.
const measureIdle = async () => {
  const servers = [
    await serveHost({ ping: 1_000 }, { idleTimeout: 8, sendPings: false }),
    await serveHost({ ping: 60_000 }, { idleTimeout: 8, sendPings: false }),
    await serveHost({ ping: 60_000 }, { idleTimeout: 8, sendPings: true })
  ] as const
  try {
    const sockets = servers.map((served) => connect(served.port, served.a1))
    await Promise.all(sockets.map((socket) => socket.opened))
    sockets.forEach((socket, k) => socket.ws.send(JSON.stringify({ type: "auth", token: servers[k]!.token, after: 0 })))
    await within(() => sockets.every((socket) => socket.types().includes("ready")), 2_000)
    const start = Date.now()
    const [a, b, c] = sockets as [ReturnType<typeof connect>, ReturnType<typeof connect>, ReturnType<typeof connect>]
    const closed = await within(() => b.state.closed !== undefined, 15_000)
    const result = {
      ready: sockets.map((socket) => socket.types()[0]),
      controlClosed: closed,
      controlCode: b.state.closed?.code,
      controlMs: b.state.at === undefined ? undefined : b.state.at - start,
      hostPingsOpen: a.state.closed === undefined,
      hostPings: a.types().filter((type) => type === "ping").length,
      bunPingsOpen: c.state.closed === undefined,
      bunPingsFrames: c.got.length
    }
    for (const socket of sockets) socket.ws.close()
    return result
  } finally {
    for (const served of servers) await served.close()
  }
}
const idle = measureIdle().then((result) => ({ result }), (error: unknown) => ({ error }))

test("over a connection, the idle limit: at the close of the socket with no pings (Bun's idle limit), the socket with the host's pings and the one with Bun's pings only are open", async () => {
  const measured = await idle
  if ("error" in measured) throw measured.error
  const { result } = measured
  expect(result.ready).toEqual(["ready", "ready", "ready"])
  expect(result.controlClosed).toBe(true)
  expect(result.controlCode).toBe(1006)
  expect(result.controlMs).toBeGreaterThanOrEqual(7_000)
  expect(result.hostPingsOpen).toBe(true)
  expect(result.hostPings).toBeGreaterThanOrEqual(6)
  expect(result.bunPingsOpen).toBe(true)
  expect(result.bunPingsFrames).toBe(1)
  console.log(`the idle limit: the control closed with ${result.controlCode} after ${result.controlMs} ms; the host's pings: ${result.hostPings}, open; Bun's pings only: open`)
}, 20_000)
