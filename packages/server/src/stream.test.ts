// Tests of R4, the event stream (stream.ts; docs/host.md, section 3, "R4:
// the event stream"; section 2, "The give" and "The host's own frames";
// lead, ec-hmsqu, rulings 1 to 10): the frames byte for byte, the query,
// the first frame and the pings, each end, the bounds of clients, a client
// that goes away, the two tenants, and a reader that stops on a real
// server. Each case runs the host (`Host.layer`) over the SQLite store of a
// test file and a stack of the core's hosted set over the tests' fake wire,
// with the gate of http.ts in front of R4's route; all but the real
// server's on Effect's TestClock.

import { expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Redacted, Scope, Semaphore } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { createConnection } from "node:net"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request as Asked } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, type Event, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import type { Channel, Client } from "./channel.ts"
import { Host } from "./host.ts"
import { ERRORS, makeGate } from "./http.ts"
import type { Limits } from "./limits.ts"
import type { LoadedChat } from "./loaded.ts"
import { eventsRoute } from "./stream.ts"
import { makeToken } from "./token.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 7 * i + 1))
const ORIGIN = "https://app.example"
const S = 1_800_000_000
const NOW = S * 1000
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

const says = (asked: Asked, text: string): Reply =>
  reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })
const runs = (asked: Asked, id: string, program: string): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }]
  })

// What a case changes: the wire's answers and the sandbox.
interface World {
  answer: (asked: Asked, n: number) => Reply
  run: (program: string) => Effect.Effect<{ output: string; failed: boolean }>
}
const world = (over: Partial<World> = {}): World => ({
  answer: (asked) => says(asked, "A reply."),
  run: () => Effect.succeed({ output: "2", failed: false }),
  ...over
})

const stackOf = (w: World) => {
  const wire = fakeWire((asked, n) => w.answer(asked, n))
  return (store: typeof Store.Service) => {
    const base = Layer.succeed(Store, store)
    const memory = Memory.layer.pipe(Layer.provideMerge(base), Layer.provide(compactor(() => "a summary")))
    const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
    const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: (program) => w.run(program) }))
    const functions = hostedLayer(HOSTED).pipe(Layer.provide(memory))
    return Turns.layer({ head: head(HOSTED) }).pipe(
      Layer.provideMerge(memory),
      Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), functions))
    )
  }
}

// The gate's `Chats`: the real one, with a count of the reads of events of
// each chat, and a wait (one time) before a read of events.
interface Spy {
  reads: Array<string>
  stall: Effect.Effect<void> | undefined
}
const spied = (real: typeof Chats.Service, spy: Spy) =>
  Chats.of({
    make: real.make,
    store: real.store,
    reads: (tenant, chat) =>
      Effect.map(real.reads(tenant, chat), (reading) => ({
        ...reading,
        eventsAfter: (after: number, limit: number) =>
          Effect.gen(function*() {
            spy.reads.push(tenant + "/" + chat)
            const stall = spy.stall
            spy.stall = undefined
            if (stall !== undefined) yield* stall
            return yield* reading.eventsAfter(after, limit)
          })
      }))
  })

// The log of a case, as JSON lines.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])

// A clock over the case's own (the TestClock, or the live one) that counts
// the sleeps that have started and not ended: a timer of a client that
// still waits is one of them. Given to the route only.
const counting = (base: Clock.Clock) => {
  const counter = { pending: 0 }
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: base.currentTimeMillis,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.suspend(() => {
        counter.pending += 1
        return base.sleep(duration).pipe(Effect.ensuring(Effect.sync(() => {
          counter.pending -= 1
        })))
      })
  }
  return { clock, counter }
}

interface Built {
  readonly host: typeof Host.Service
  readonly real: typeof Chats.Service
  readonly spy: Spy
  readonly timers: { pending: number }
  readonly gate: ReturnType<typeof makeGate>
  // R4 for `chat`, with `query`, a token of `tenant` for `chats` (the
  // chat), and more headers.
  readonly get: (
    chat: string,
    query: string,
    init?: { readonly tenant?: string; readonly chats?: ReadonlyArray<string>; readonly exp?: number; readonly headers?: Record<string, string> }
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>
  readonly route: (chat: string | undefined) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
  readonly close: Effect.Effect<void>
}

// The host with `limits`, a gate over it, and R4's route.
const build = (limits: Partial<Limits> = {}, w: World = world()) =>
  Effect.gen(function*() {
    const real = yield* Chats
    const scope = yield* Scope.make()
    const layer = Host.layer({ stack: stackOf(w), launch: LAUNCH, secret: SECRET, origins: [ORIGIN], limits }).pipe(
      Layer.provide(Layer.succeed(Chats, real))
    )
    const host = Context.get(yield* Layer.buildWithScope(layer, scope), Host)
    const spy: Spy = { reads: [], stall: undefined }
    const gate = makeGate({ secret: host.secret, origins: host.origins, limits: host.limits, chats: spied(real, spy) })
    const { clock, counter } = counting(yield* Clock.clockWith(Effect.succeed))
    const route = (chat: string | undefined) => eventsRoute(gate, host)(chat).pipe(Effect.provideService(Clock.Clock, clock))
    const get: Built["get"] = (chat, query, init = {}) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const token = yield* Effect.orDie(makeToken(SECRET, {
          tenant: init.tenant ?? TENANT_A,
          chats: [...(init.chats ?? [chat])],
          exp: init.exp ?? Math.floor(now / 1000) + 600
        }))
        const request = new Request("http://127.0.0.1/v1/chats/" + chat + "/events" + query, {
          headers: { authorization: "Bearer " + token, accept: "text/event-stream", ...init.headers }
        })
        return yield* route(chat).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)))
      })
    return { host, real, spy, timers: counter, gate, get, route, close: Scope.close(scope, Exit.void) } satisfies Built
  })

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

const decoder = new TextDecoder()

// The answer's stream, read in the background into `text`, in the case's
// context (its clock), from when `pump` is called.
interface Opened {
  readonly status: number
  readonly headers: Record<string, string>
  readonly web: Response
  // Starts the reads in the background.
  readonly pump: () => Read
}
interface Read {
  text: string
  done: boolean
  failed: boolean
  readonly cancel: () => Promise<void>
}
const open = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const web = HttpServerResponse.toWeb(response, { context })
    const pump = (): Read => {
      const reader = web.body!.getReader()
      const read: Read = { text: "", done: false, failed: false, cancel: () => reader.cancel() }
      void (async () => {
        try {
          for (;;) {
            const got = await reader.read()
            if (got.done) break
            read.text += decoder.decode(got.value, { stream: true })
          }
        } catch {
          read.failed = true
        }
        read.done = true
      })()
      return read
    }
    return { status: web.status, headers: Object.fromEntries(web.headers), web, pump } satisfies Opened
  })

// The whole frames read so far.
const framesOf = (read: Read) => read.text.split("\n\n").slice(0, -1).map((frame) => frame + "\n\n")

// Waits, in real time, until `check` holds (2 s at most).
const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 2_000 && !check(); k++) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
    if (!check()) return yield* Effect.die(new Error("the case waited for a state that did not come"))
  })
// Lets the fibers run, in real time, with the clock still.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

const PING = ": ping\n\n"
const closeOf = (reason: string) => `event: close\ndata: {"type":"close","reason":"${reason}"}\n\n`
const frameOf = (event: Event) => `id: ${event.n}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const errorText = (code: keyof typeof ERRORS) => JSON.stringify({ error: code, message: ERRORS[code].message })

// The chat's events after `after`, from the store.
const stored = (b: Built, tenant: string, chat: string, after = 0) =>
  Effect.gen(function*() {
    const reads = yield* Effect.orDie(b.real.reads(tenant, chat))
    return yield* Effect.orDie(reads.eventsAfter(after, 1000))
  })

// The numbers of the frames that have an `id`.
const ids = (frames: ReadonlyArray<string>) => frames.filter((frame) => frame.startsWith("id: ")).map((frame) => Number(frame.slice(4, frame.indexOf("\n"))))

const channelOf = (b: Built, tenant: string, chat: string): Channel<LoadedChat> => {
  const channel = b.host.registry.find(tenant, chat)
  if (channel === undefined) throw new Error("the registry has no channel of this chat")
  return channel
}
const clientOf = (b: Built, tenant: string, chat: string): Client => {
  const client = channelOf(b, tenant, chat).clients[0]
  if (client === undefined) throw new Error("the chat has no client")
  return client
}
// The waiters on a client's signal (a wait for its end among them).
const waitersOf = (client: Client) => (client as unknown as { readonly changed: { readonly size: number } }).changed.size

// A message in through the host, the end of its turn, and the listener's
// give of the turn's last event. The turn's end does not wait for the
// listener: until it has given that event, a piece of the turn may still
// come to a client that joins, after the turn's end that the client read
// from the store (docs/host.md, "The order and the numbers", 4). The
// listener takes in the hub's order, so each piece of the turn is given by
// then.
const said = (b: Built, tenant: string, chat: string, text: string) =>
  Effect.gen(function*() {
    const sent = yield* Effect.orDie(b.host.say(tenant, chat, text, null))
    const channel = b.host.registry.find(tenant, chat)
    const loaded = channel?.loaded
    if (channel !== undefined && loaded !== undefined) {
      yield* loaded.turns.idle
      const last = (yield* stored(b, tenant, chat)).at(-1)?.n ?? null
      yield* until(() => channel.last === last)
    }
    return sent
  })

// Nothing of a request is left: no client, no hold, no place of a request
// or of `reads`, no timer. `channels`: those of the loaded chats, each with
// the loader's one hold.
const nothingLeft = (b: Built, channels = 0) => {
  expect({
    registry: b.host.registry.size(),
    inFlight: b.gate.inFlight(),
    reads: b.host.reads.taken(),
    readsWaiting: b.host.reads.waiting(),
    timers: b.timers.pending
  }).toEqual({ registry: { channels, clients: 0 }, inFlight: 0, reads: 0, readsWaiting: 0, timers: 0 })
}
// The holders of the chat's channel: the loaded chat's one, or none.
const holdersOf = (b: Built, tenant: string, chat: string) => b.host.registry.find(tenant, chat)?.holders ?? 0

// The frames
// ----------

test("the frames, byte for byte: the first ping, the events after `after` from the store with their ids, then a turn's events live with its piece among them and no id; the head at once with nothing read before it", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      yield* said(b, TENANT_A, chat, "first")
      const before = yield* stored(b, TENANT_A, chat)
      expect(before.length).toBeGreaterThan(2)
      const after = before[0]!.n
      b.spy.reads.length = 0
      const response = yield* b.get(chat, "?after=" + after)
      // The answer at once, and nothing of the store read before it.
      expect(b.spy.reads).toEqual([])
      const opened = yield* open(response)
      expect(opened.status).toBe(200)
      expect(opened.headers["content-type"]).toBe("text/event-stream")
      expect(opened.headers["cache-control"]).toBe("no-store")
      expect(b.gate.inFlight()).toBe(0)
      const read = opened.pump()
      yield* until(() => framesOf(read).length >= before.length)
      expect(framesOf(read)).toEqual([PING, ...before.slice(1).map(frameOf)])
      // Live: a turn's events, with its piece.
      yield* said(b, TENANT_A, chat, "second")
      const all = yield* stored(b, TENANT_A, chat)
      const live = all.slice(before.length)
      yield* until(() => ids(framesOf(read)).length === all.length - 1)
      yield* settle
      const frames = framesOf(read).slice(before.length)
      expect(frames.filter((frame) => frame.startsWith("id: "))).toEqual(live.map(frameOf))
      const pieces = frames.filter((frame) => !frame.startsWith("id: "))
      expect(pieces.length).toBeGreaterThan(0)
      for (const piece of pieces) {
        expect(piece).toMatch(/^event: text\ndata: \{"type":"text",[^\n]*\}\n\n$/)
        const value = JSON.parse(piece.slice(piece.indexOf("data: ") + 6))
        expect(value.n).toBeUndefined()
        expect(piece).toBe(`event: text\ndata: ${JSON.stringify(value)}\n\n`)
      }
      // The piece comes between the turn's start and its end, and is that turn's.
      const at = (match: (frame: string) => boolean) => frames.findIndex(match)
      const started = live.find((event): event is Extract<Event, { type: "start" }> => event.type === "start")!
      for (const piece of pieces) expect(JSON.parse(piece.slice(piece.indexOf("data: ") + 6)).turn).toBe(started.turn)
      expect(at((frame) => frame.startsWith("event: text"))).toBeGreaterThan(at((frame) => frame.includes("event: start")))
      expect(at((frame) => frame.startsWith("event: text"))).toBeLessThan(at((frame) => frame.includes("event: end")))
      yield* Effect.promise(() => read.cancel())
      yield* until(() => b.host.registry.size().clients === 0)
      yield* b.close
    })
  )
})

test("a turn that runs while the first read reads: each number once, in order, across the first read and the join", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      yield* said(b, TENANT_A, chat, "first")
      // The first read's first call of the store waits until a turn has run.
      const release = yield* Deferred.make<void>()
      b.spy.stall = Deferred.await(release)
      const read = (yield* open(yield* b.get(chat, "?after=0"))).pump()
      yield* until(() => b.spy.reads.length === 1)
      yield* said(b, TENANT_A, chat, "second")
      yield* said(b, TENANT_A, chat, "third")
      yield* Deferred.succeed(release, undefined)
      const all = yield* stored(b, TENANT_A, chat)
      yield* until(() => ids(framesOf(read)).length >= all.length)
      yield* said(b, TENANT_A, chat, "fourth")
      const more = yield* stored(b, TENANT_A, chat)
      yield* until(() => ids(framesOf(read)).length >= more.length)
      yield* settle
      expect(ids(framesOf(read))).toEqual(more.map((event) => event.n))
      expect(framesOf(read).filter((frame) => frame.startsWith("id: "))).toEqual(more.map(frameOf))
      yield* Effect.promise(() => read.cancel())
      yield* until(() => b.host.registry.size().clients === 0)
      yield* b.close
    })
  )
})

test("a history larger than the buffer reaches a reader that reads, whole and in order, with no step of the clock: the first read runs beside the writer", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build({ buffer: 8, page: 4 })
      const chat = yield* b.real.make(TENANT_A, PICK)
      for (let k = 0; k < 6; k++) yield* said(b, TENANT_A, chat, "message " + k)
      const events = yield* stored(b, TENANT_A, chat)
      expect(events.length).toBe(3 * 8)
      const read = (yield* open(yield* b.get(chat, "?after=0"))).pump()
      yield* until(() => ids(framesOf(read)).length === events.length)
      expect(framesOf(read)).toEqual([PING, ...events.map(frameOf)])
      yield* until(() => clientOf(b, TENANT_A, chat).joined)
      yield* Effect.promise(() => read.cancel())
      yield* until(() => b.host.registry.size().clients === 0)
      yield* b.close
    })
  )
})

// The query
// ---------

test("the query: no after, -1, 1.5, 17 digits and a text get 400 and make no client; after given twice takes the first", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      yield* said(b, TENANT_A, chat, "first")
      const events = yield* stored(b, TENANT_A, chat)
      for (const query of ["", "?other=1", "?after", "?after=", "?after=-1", "?after=1.5", "?after=" + "1".repeat(17), "?after=one", "?after=%2B1", "?after=1e2"]) {
        const opened = yield* open(yield* b.get(chat, query))
        expect([query, opened.status, yield* Effect.promise(() => opened.web.text())]).toEqual([query, 400, errorText("bad_request")])
        expect({ clients: b.host.registry.size().clients, holders: holdersOf(b, TENANT_A, chat) }).toEqual({ clients: 0, holders: 1 })
      }
      expect(b.spy.reads).toEqual([])
      nothingLeft(b, 1)
      // Twice: the first counts.
      const last = events[events.length - 1]!.n
      const read = (yield* open(yield* b.get(chat, `?after=${last - 1}&after=0`))).pump()
      yield* until(() => framesOf(read).length >= 2)
      yield* settle
      expect(framesOf(read)).toEqual([PING, frameOf(events[events.length - 1]!)])
      yield* Effect.promise(() => read.cancel())
      yield* until(() => b.host.registry.size().clients === 0)
      yield* b.close
    })
  )
})

test("an after above seq joins and gets no event at or below it; a second client of the chat gets its events live", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      yield* said(b, TENANT_A, chat, "first")
      const high = (yield* open(yield* b.get(chat, "?after=1000"))).pump()
      const low = (yield* open(yield* b.get(chat, "?after=0"))).pump()
      const before = yield* stored(b, TENANT_A, chat)
      yield* until(() => ids(framesOf(low)).length === before.length)
      yield* until(() => channelOf(b, TENANT_A, chat).clients.every((client) => client.joined))
      yield* said(b, TENANT_A, chat, "second")
      const all = yield* stored(b, TENANT_A, chat)
      yield* until(() => ids(framesOf(low)).length === all.length)
      yield* settle
      expect(ids(framesOf(low))).toEqual(all.map((event) => event.n))
      // A piece has no number: it reaches each client that joined.
      expect(ids(framesOf(high))).toEqual([])
      expect(framesOf(high)[0]).toBe(PING)
      expect(framesOf(high).slice(1).every((frame) => frame.startsWith("event: text\n"))).toBe(true)
      expect(channelOf(b, TENANT_A, chat).clients.length).toBe(2)
      yield* Effect.promise(() => high.cancel())
      yield* Effect.promise(() => low.cancel())
      yield* until(() => b.host.registry.size().clients === 0)
      yield* b.close
    })
  )
})

// The ping
// --------

test("the ping: the first frame, with nothing read before it, for an empty chat and for after at seq; then one each ping ms of silence for 60 s, none before", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const empty = yield* b.real.make(TENANT_A, PICK)
      const full = yield* b.real.make(TENANT_A, PICK)
      yield* said(b, TENANT_A, full, "first")
      const seq = (yield* stored(b, TENANT_A, full)).length
      b.spy.reads.length = 0
      for (const [chat, after] of [[empty, 0], [full, seq]] as const) {
        b.spy.reads.length = 0
        const response = yield* b.get(chat, "?after=" + after)
        expect(b.spy.reads).toEqual([])
        const read = (yield* open(response)).pump()
        yield* until(() => framesOf(read).length === 1 && b.spy.reads.length > 0)
        expect(framesOf(read)).toEqual([PING])
        const ping = b.host.limits.ping
        let pings = 1
        for (let k = 0; k < 4; k++) {
          yield* TestClock.adjust(ping - 1)
          yield* settle
          expect(framesOf(read).length).toBe(pings)
          yield* TestClock.adjust(1)
          pings += 1
          yield* until(() => framesOf(read).length === pings)
        }
        expect(framesOf(read)).toEqual(Array(5).fill(PING))
        yield* Effect.promise(() => read.cancel())
        yield* until(() => b.host.registry.size().clients === 0)
      }
      yield* b.close
    })
  )
})

test("no ping while texts wait in the buffer: a stream that nothing pulls for 60 s gets none, and after it is read the next comes ping ms after the last write", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const opened = yield* open(yield* b.get(chat, "?after=0"))
      yield* until(() => channelOf(b, TENANT_A, chat).clients[0]?.joined === true)
      yield* said(b, TENANT_A, chat, "first")
      const client = clientOf(b, TENANT_A, chat)
      const events = yield* stored(b, TENANT_A, chat)
      yield* until(() => client.size.entries > events.length)
      const waiting = client.size
      for (let k = 0; k < 4; k++) {
        yield* TestClock.adjust(b.host.limits.ping)
        yield* settle
      }
      expect(client.size).toEqual(waiting)
      const read = opened.pump()
      yield* until(() => ids(framesOf(read)).length === events.length)
      yield* settle
      const frames = framesOf(read)
      expect(frames[0]).toBe(PING)
      expect(frames.slice(1).filter((frame) => frame === PING)).toEqual([])
      const count = frames.length
      yield* TestClock.adjust(b.host.limits.ping - 1)
      yield* settle
      expect(framesOf(read).length).toBe(count)
      yield* TestClock.adjust(1)
      yield* until(() => framesOf(read).length === count + 1)
      expect(framesOf(read)[count]).toBe(PING)
      yield* Effect.promise(() => read.cancel())
      yield* until(() => b.host.registry.size().clients === 0)
      yield* b.close
    })
  )
})

// The review's case (ec-wl95b; lead, ec-ek7fa): a ping that falls due while
// an event waits on the give lock, with a buffer of one entry. The event is
// given first; the ping finds a text in the buffer, puts nothing and does
// not end the client. At 999 ms, the control: no ping is due yet.
for (const due of [1_000, 999]) {
  test(`an event that waits on the give lock while a ping falls due (at ${due} ms after the first ping) is given, and the ping puts nothing and ends nothing: buffer 1, page 1`, async () => {
    await run(() =>
      Effect.gen(function*() {
        const b = yield* build({ buffer: 1, page: 1, ping: 1_000 })
        const chat = yield* b.real.make(TENANT_A, PICK)
        const opened = yield* open(yield* b.get(chat, "?after=0"))
        yield* until(() => {
          const client = b.host.registry.find(TENANT_A, chat)?.clients[0]
          return client !== undefined && client.joined && client.size.entries === 0
        })
        const channel = channelOf(b, TENANT_A, chat)
        const client = clientOf(b, TENANT_A, chat)
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
        const read = opened.pump()
        yield* until(() => ids(framesOf(read)).length === 1)
        yield* settle
        expect(framesOf(read)).toEqual([PING, `id: 1\nevent: start\ndata: ${json}\n\n`])
        yield* Effect.promise(() => read.cancel())
        yield* until(() => b.host.registry.size().clients === 0 && b.timers.pending === 0)
        nothingLeft(b)
        yield* b.close
      })
    )
  })
}

// The ends
// --------

// The frames of a stream that was opened before its client's end and read
// after it: the close frame, after the first ping when the web stream took
// it by itself (it pulls once unasked); the end freed the rest.
const lastOnly = (read: Read) => framesOf(read).filter((frame, at) => !(at === 0 && frame === PING))

// After an end: the last frame was `close` with `reason`, the stream ended,
// and nothing of the request is left.
const endedWith = (b: Built, read: Read, reason: string) =>
  Effect.gen(function*() {
    yield* until(() => read.done)
    const frames = framesOf(read)
    expect(frames[frames.length - 1]).toBe(closeOf(reason))
    expect(frames.filter((frame) => frame.startsWith("event: close")).length).toBe(1)
    expect(read.text.endsWith(closeOf(reason))).toBe(true)
    yield* until(() => b.timers.pending === 0 && b.host.registry.size().channels === 0)
    nothingLeft(b)
  })

test("token: the client ends at the claims' exp, not before, with close token as the last frame", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const exp = S + 100
      const read = (yield* open(yield* b.get(chat, "?after=0", { exp }))).pump()
      yield* until(() => framesOf(read).length === 1)
      yield* TestClock.adjust(exp * 1000 - NOW - 1)
      yield* settle
      expect(read.done).toBe(false)
      expect(framesOf(read).includes(closeOf("token"))).toBe(false)
      yield* TestClock.adjust(1)
      yield* endedWith(b, read, "token")
      yield* b.close
    })
  )
})

test("token, with nothing pulled: at the exp the client ends, its hold, its timers and its watch are gone with no pull; read later, its last frame is close token", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const exp = S + 100
      const opened = yield* open(yield* b.get(chat, "?after=0", { exp }))
      yield* until(() => channelOf(b, TENANT_A, chat).clients[0]?.joined === true)
      const client = clientOf(b, TENANT_A, chat)
      yield* TestClock.adjust(exp * 1000 - NOW - 1)
      yield* settle
      expect(client.ended).toBeNull()
      yield* TestClock.adjust(1)
      yield* until(() => b.timers.pending === 0 && b.host.registry.size().channels === 0)
      expect(client.ended).toEqual({ reason: "token" })
      expect(waitersOf(client)).toBe(0)
      nothingLeft(b)
      const read = opened.pump()
      yield* until(() => read.done)
      expect(lastOnly(read)).toEqual([closeOf("token")])
      yield* b.close
    })
  )
})

test("slow, by a give: a client whose buffer is full ends as slow; with nothing pulled its hold, its timers and its watch are gone at once; when read, its last frame is close slow", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build({ buffer: 8, page: 4 })
      const chat = yield* b.real.make(TENANT_A, PICK)
      const opened = yield* open(yield* b.get(chat, "?after=0"))
      yield* until(() => channelOf(b, TENANT_A, chat).clients[0]?.joined === true)
      const client = clientOf(b, TENANT_A, chat)
      for (let k = 0; k < 5 && client.ended === null; k++) yield* said(b, TENANT_A, chat, "message " + k)
      expect(client.ended).toEqual({ reason: "slow" })
      // No pull and no step of the clock: all of it is gone; the loaded
      // chat's hold stays.
      yield* until(() => b.timers.pending === 0)
      expect(channelOf(b, TENANT_A, chat).holders).toBe(1)
      expect(channelOf(b, TENANT_A, chat).clients).toEqual([])
      expect(waitersOf(client)).toBe(0)
      const read = opened.pump()
      yield* until(() => read.done)
      expect(lastOnly(read)).toEqual([closeOf("slow")])
      nothingLeft(b, 1)
      yield* b.close
    })
  )
})

test("slow, by the first read: no room for a page room ms after its last page ends the client as slow, not before", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build({ buffer: 8, page: 4 })
      const chat = yield* b.real.make(TENANT_A, PICK)
      for (let k = 0; k < 3; k++) yield* said(b, TENANT_A, chat, "message " + k)
      // Nothing pulls: a page and the first ping fill the room of a page.
      const opened = yield* open(yield* b.get(chat, "?after=0"))
      // The pages until the buffer has no room for one more.
      yield* until(() => {
        const client = b.host.registry.find(TENANT_A, chat)?.clients[0]
        return client !== undefined && !client.hasRoom(b.host.limits.page, b.host.limits.pageBytes)
      })
      yield* settle
      const client = clientOf(b, TENANT_A, chat)
      expect(client.joined).toBe(false)
      yield* TestClock.adjust(b.host.limits.room - 1)
      yield* settle
      expect(client.ended).toBeNull()
      yield* TestClock.adjust(1)
      yield* until(() => client.ended !== null)
      expect(client.ended).toEqual({ reason: "slow" })
      yield* until(() => b.timers.pending === 0 && b.host.registry.size().clients === 0 && holdersOf(b, TENANT_A, chat) === 1)
      expect(waitersOf(client)).toBe(0)
      const read = opened.pump()
      yield* until(() => read.done)
      expect(lastOnly(read)).toEqual([closeOf("slow")])
      nothingLeft(b, 1)
      yield* b.close
    })
  )
})

test("busy: a first read that waits readsWait for a place of reads ends the client as busy", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build({ reads: 1 })
      const chat = yield* b.real.make(TENANT_A, PICK)
      const latch = yield* Deferred.make<void>()
      const holding = yield* Effect.forkChild(b.host.reads.withPlace(Deferred.await(latch)))
      yield* until(() => b.host.reads.taken() === 1)
      const read = (yield* open(yield* b.get(chat, "?after=0"))).pump()
      yield* until(() => b.host.reads.waiting() === 1)
      yield* TestClock.adjust(b.host.limits.readsWait - 1)
      yield* settle
      expect(read.done).toBe(false)
      yield* TestClock.adjust(1)
      yield* until(() => read.done)
      yield* Deferred.succeed(latch, undefined)
      yield* Fiber.join(holding)
      const frames = framesOf(read)
      expect(frames.slice(0, -1).every((frame) => frame === PING)).toBe(true)
      yield* endedWith(b, read, "busy")
      yield* b.close
    })
  )
})

test("internal: an event over entry that the fit cannot cut, in the first read, ends the client as internal, with a warning of the route and the reason and no text of the event", async () => {
  await run(() =>
    Effect.gen(function*() {
      // The message is written under the default limits; the host's are smaller.
      const b = yield* build({ text: 1_000, entry: 200_000, pageBytes: 200_000, bufferBytes: 400_000 })
      const chat = yield* b.real.make(TENANT_A, PICK)
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* Effect.orDie(b.real.store(TENANT_A, chat, { ...LAUNCH, runTag: "before" }))
        const [first] = yield* Effect.orDie(store.append([{ kind: "user", text: "\u0001".repeat(60_000) + "SECRET-TEXT" }]))
        yield* Effect.orDie(store.addEvent({ type: "accepted", msg: first!.i, msgLast: first!.i }))
      }))
      lines.length = 0
      const read = (yield* open(yield* b.get(chat, "?after=0"))).pump()
      yield* endedWith(b, read, "internal")
      expect(framesOf(read)).toEqual([PING, closeOf("internal")])
      const warned = lines.map((line) => JSON.parse(line)).filter((line) => line.annotations?.route === "R4")
      expect(warned.map((line) => line.annotations)).toEqual([{ route: "R4", reason: "internal" }])
      expect(lines.join("\n")).not.toContain("SECRET-TEXT")
      expect(lines.join("\n")).not.toContain("after=")
      yield* b.close
    })
  )
})

test("internal, by cannotGive, with nothing pulled: the hold, the timers and the watch are gone at once", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const opened = yield* open(yield* b.get(chat, "?after=0"))
      yield* until(() => channelOf(b, TENANT_A, chat).clients[0]?.joined === true)
      const channel = channelOf(b, TENANT_A, chat)
      const client = clientOf(b, TENANT_A, chat)
      yield* channel.cannotGive(5)
      yield* until(() => b.timers.pending === 0 && b.host.registry.size().channels === 0)
      expect(waitersOf(client)).toBe(0)
      nothingLeft(b)
      const read = opened.pump()
      yield* until(() => read.done)
      expect(lastOnly(read)).toEqual([closeOf("internal")])
      yield* b.close
    })
  )
})

test("stop: the host's layer ends each client with stop; read, its last frame is close stop; with nothing pulled, the hold and the timers are gone at once", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const read = (yield* open(yield* b.get(chat, "?after=0"))).pump()
      const quiet = yield* open(yield* b.get(chat, "?after=0"))
      yield* until(() => channelOf(b, TENANT_A, chat).clients.length === 2 && framesOf(read).length === 1)
      const clients = channelOf(b, TENANT_A, chat).clients
      yield* b.close
      yield* endedWith(b, read, "stop")
      expect(clients.map((client) => client.ended)).toEqual([{ reason: "stop" }, { reason: "stop" }])
      expect(clients.map(waitersOf)).toEqual([0, 0])
      const late = quiet.pump()
      yield* until(() => late.done)
      // Its end freed its buffer, the first ping too: the close frame only.
      expect(lastOnly(late)).toEqual([closeOf("stop")])
    })
  )
})

// The bounds
// ----------

test("the bounds: the 2nd client with chatClients 1 and a client past hostClients get 503 busy with no retry-after, and nothing is left; the place of requests is back while the stream runs", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build({ chatClients: 1, hostClients: 2 })
      const one = yield* b.real.make(TENANT_A, PICK)
      const two = yield* b.real.make(TENANT_A, PICK)
      const three = yield* b.real.make(TENANT_A, PICK)
      const first = (yield* open(yield* b.get(one, "?after=0"))).pump()
      expect(b.gate.inFlight()).toBe(0)
      const refused = yield* open(yield* b.get(one, "?after=0"))
      expect([refused.status, refused.headers["retry-after"], yield* Effect.promise(() => refused.web.text())]).toEqual([503, undefined, errorText("busy")])
      expect(channelOf(b, TENANT_A, one).holders).toBe(1)
      const second = (yield* open(yield* b.get(two, "?after=0"))).pump()
      const past = yield* open(yield* b.get(three, "?after=0"))
      expect([past.status, past.headers["retry-after"]]).toEqual([503, undefined])
      expect(b.host.registry.find(TENANT_A, three)).toBeUndefined()
      expect(b.host.registry.size()).toEqual({ channels: 2, clients: 2 })
      expect(b.gate.inFlight()).toBe(0)
      yield* Effect.promise(() => first.cancel())
      yield* Effect.promise(() => second.cancel())
      yield* until(() => b.host.registry.size().channels === 0)
      yield* until(() => b.timers.pending === 0)
      nothingLeft(b)
      yield* b.close
    })
  )
})

test("the order of the work: a request keeps its place of requests until it is a client; while its addClient waits for the give lock, the place is still taken", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const channel = yield* b.host.registry.hold(TENANT_A, chat)
      yield* Semaphore.take(channel.giveLock, 1)
      const getting = yield* Effect.forkChild(b.get(chat, "?after=0"))
      yield* settle
      expect({ inFlight: b.gate.inFlight(), clients: channel.clients.length, holders: channel.holders, done: getting.pollUnsafe() !== undefined }).toEqual({
        inFlight: 1,
        clients: 0,
        holders: 2,
        done: false
      })
      yield* Semaphore.release(channel.giveLock, 1)
      const read = (yield* open(yield* Fiber.join(getting))).pump()
      expect({ inFlight: b.gate.inFlight(), clients: channel.clients.length }).toEqual({ inFlight: 0, clients: 1 })
      yield* until(() => framesOf(read).length === 1)
      yield* Effect.promise(() => read.cancel())
      yield* until(() => channel.holders === 1 && b.timers.pending === 0)
      yield* b.host.registry.letGo(channel)
      nothingLeft(b)
      yield* b.close
    })
  )
})

test("the 33rd client of a chat gets 503 busy", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const reads: Array<Read> = []
      for (let k = 0; k < 32; k++) reads.push((yield* open(yield* b.get(chat, "?after=0"))).pump())
      const refused = yield* open(yield* b.get(chat, "?after=0"))
      expect([refused.status, refused.headers["retry-after"]]).toEqual([503, undefined])
      expect(channelOf(b, TENANT_A, chat).clients.length).toBe(32)
      expect(channelOf(b, TENANT_A, chat).holders).toBe(32)
      for (const read of reads) yield* Effect.promise(() => read.cancel())
      yield* until(() => b.host.registry.size().channels === 0 && b.timers.pending === 0)
      nothingLeft(b)
      yield* b.close
    })
  )
})

// A client that goes away
// -----------------------

test("a client that goes away: the client leaves the channel and nothing is left", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      yield* said(b, TENANT_A, chat, "first")
      const read = (yield* open(yield* b.get(chat, "?after=0"))).pump()
      yield* until(() => framesOf(read).length > 1)
      const client = clientOf(b, TENANT_A, chat)
      yield* Effect.promise(() => read.cancel())
      yield* until(() => b.host.registry.size().clients === 0 && holdersOf(b, TENANT_A, chat) === 1 && b.timers.pending === 0)
      expect(client.ended).toEqual({ reason: null })
      expect(waitersOf(client)).toBe(0)
      nothingLeft(b, 1)
      yield* b.close
    })
  )
})

test("a stream that nothing pulls is ended by abandon at the gate's deadline, and a later start ends at once", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      // The answer is not turned into a web stream: nothing starts it.
      const response = yield* b.get(chat, "?after=0")
      const client = clientOf(b, TENANT_A, chat)
      yield* TestClock.adjust(b.host.limits.request - 1)
      yield* settle
      expect(client.ended).toBeNull()
      yield* TestClock.adjust(1)
      yield* until(() => b.host.registry.size().channels === 0 && b.timers.pending === 0)
      expect(client.ended).toEqual({ reason: null })
      expect(b.spy.reads).toEqual([])
      nothingLeft(b)
      const read = (yield* open(response)).pump()
      yield* until(() => read.done)
      expect(framesOf(read)).toEqual([])
      yield* b.close
    })
  )
})

// The sweep's case (ec-eutgw, 3; draft ec-usk8k, 2; the review's probe M22,
// ec-03djn): `admit` is one uninterruptible step. The test holds the
// channel's give lock, so `addClient` waits for it after the hold; the gate's
// deadline passes then, and its interruption of the work is the mark; then
// the lock is let go.
test("admit is one step: the gate's deadline passes while addClient waits for the give lock; the answer is 503, and the channel has the test's one holder and no client", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build()
      const chat = yield* b.real.make(TENANT_A, PICK)
      const channel = yield* b.host.registry.hold(TENANT_A, chat)
      // The fiber of the work: the one that takes the request's hold.
      const registry = b.host.registry as { hold: typeof b.host.registry.hold }
      const hold = registry.hold
      let work: Fiber.Fiber<unknown, unknown> | undefined
      registry.hold = (tenant, uuid) =>
        Effect.andThen(
          Effect.withFiber((fiber) =>
            Effect.sync(() => {
              work = fiber
            })
          ),
          hold(tenant, uuid)
        )
      yield* Semaphore.take(channel.giveLock, 1)
      const getting = yield* Effect.forkChild(b.get(chat, "?after=0"))
      yield* until(() => channel.holders === 2)
      expect(channel.clients.length).toBe(0)
      yield* TestClock.adjust(b.host.limits.request)
      // The mark: the gate has asked the work to stop (Effect's fiber notes
      // an interruption that it cannot take yet).
      yield* until(() => (work as unknown as { readonly _interruptedCause: unknown } | undefined)?._interruptedCause !== undefined)
      yield* Semaphore.release(channel.giveLock, 1)
      const response = yield* Fiber.join(getting)
      expect(response.status).toBe(503)
      expect({ holders: channel.holders, clients: channel.clients.length, inFlight: b.gate.inFlight(), timers: b.timers.pending }).toEqual({
        holders: 1,
        clients: 0,
        inFlight: 0,
        timers: 0
      })
      registry.hold = hold
      yield* b.host.registry.letGo(channel)
      nothingLeft(b)
      yield* b.close
    })
  )
})

// The two tenants
// ---------------

test("a token of tenant A for a chat of tenant B, named in its chats or not, gets 404 no_chat, makes no channel and no client, and reads nothing of B", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build()
      const mine = yield* b.real.make(TENANT_A, PICK)
      const theirs = yield* b.real.make(TENANT_B, PICK)
      yield* said(b, TENANT_B, theirs, "a message of B")
      const state = () => ({ events: rows(file, "select chat, n, type from everchat_event order by chat, n"), launches: rows(file, "select chat, n, ended from everchat_launch order by chat, n") })
      const before = state()
      b.spy.reads.length = 0
      for (const chats of [[theirs], [mine, theirs]]) {
        const opened = yield* open(yield* b.get(theirs, "?after=0", { tenant: TENANT_A, chats }))
        expect([opened.status, yield* Effect.promise(() => opened.web.text())]).toEqual([404, errorText("no_chat")])
      }
      expect(b.host.registry.find(TENANT_A, theirs)).toBeUndefined()
      expect(b.host.registry.find(TENANT_B, theirs)?.clients ?? []).toEqual([])
      expect(b.spy.reads).toEqual([])
      expect(state()).toEqual(before)
      yield* b.close
    })
  )
})

// The slow reader, on a real server
// ---------------------------------

test("over a connection: a reader that stops: each give ends at once, a second reader gets every event, the stopped client ends as slow, and nothing of it is left", async () => {
  const file = newFile()
  const big = "x".repeat(60_000)
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const release = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const w = world({
      answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
      run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { output: "2", failed: false }))
    })
    const b = yield* build({ entry: 400_000, pageBytes: 400_000, bufferBytes: 400_000, buffer: 64, page: 64 }, w)
    const chat = yield* b.real.make(TENANT_A, PICK)
    const server = yield* Layer.build(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))
    yield* Layer.build(HttpRouter.serve(HttpRouter.addAll([
      HttpRouter.route("GET", "/v1/chats/:chat/events", Effect.flatMap(HttpRouter.params, (params) => b.route(params["chat"])))
    ]), { disableLogger: true, disableListenLog: true })).pipe(Effect.provide(server))
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
    const token = yield* Effect.orDie(makeToken(SECRET, { tenant: TENANT_A, chats: [chat], exp: Math.floor(Date.now() / 1000) + 600 }))
    const head = `GET /v1/chats/${chat}/events?after=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nAccept: text/event-stream\r\n\r\n`
    // The stopped reader: it reads the head, then stops reading.
    let stoppedGot = ""
    const stopped = createConnection({ host: "127.0.0.1", port }, () => stopped.write(head))
    stopped.on("data", (data) => {
      stoppedGot += data.toString()
      if (stoppedGot.includes("\r\n\r\n")) stopped.pause()
    })
    yield* until(() => stoppedGot.includes("\r\n\r\n"))
    expect(stoppedGot.startsWith("HTTP/1.1 200")).toBe(true)
    // The reader that reads.
    const reading = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/v1/chats/${chat}/events?after=0`, { headers: { authorization: "Bearer " + token } }))
    const reader = reading.body!.getReader()
    const read: Read = { text: "", done: false, failed: false, cancel: () => reader.cancel() }
    void (async () => {
      try {
        for (;;) {
          const got = await reader.read()
          if (got.done) break
          read.text += decoder.decode(got.value, { stream: true })
        }
      } catch {
        read.failed = true
      }
      read.done = true
    })()
    yield* until(() => b.host.registry.size().clients === 2 && channelOf(b, TENANT_A, chat).clients.every((client) => client.joined))
    const channel = channelOf(b, TENANT_A, chat)
    const [slowClient] = channel.clients
    // Each give, timed, and the bytes given to the stopped client.
    const gives: Array<number> = []
    let givenBytes = 0
    const give = channel.give.bind(channel)
    channel.give = (entry) =>
      Effect.suspend(() => {
        const at = performance.now()
        const joined = slowClient!.ended === null && slowClient!.joined
        return Effect.ensuring(
          give(entry),
          Effect.sync(() => {
            gives.push(performance.now() - at)
            if (joined && slowClient!.ended === null) givenBytes += entry.bytes
          })
        )
      })
    let peak = 0
    let left = 0
    let given = 0
    // A turn that runs, so that each message in is one `accepted`.
    yield* Effect.orDie(b.host.say(TENANT_A, chat, "start", null))
    yield* Deferred.await(started)
    const t0 = performance.now()
    let messages = 0
    while (slowClient!.ended === null && messages < 600) {
      yield* Effect.orDie(b.host.say(TENANT_A, chat, big, null))
      messages += 1
      if (slowClient!.ended === null) left = slowClient!.size.bytes
      peak = Math.max(peak, left)
      given = messages
    }
    const elapsed = performance.now() - t0
    expect(slowClient!.ended).toEqual({ reason: "slow" })
    yield* Deferred.succeed(release, undefined)
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
    yield* until(() => b.host.registry.size().clients === 1)
    // The reader that reads got every event of the chat.
    const all = yield* stored(b, TENANT_A, chat)
    yield* until(() => ids(framesOf(read)).length === all.length)
    expect(ids(framesOf(read))).toEqual(all.map((event) => event.n))
    // The bytes of the stopped client: those in its buffer (at most
    // `bufferBytes`), and those that its writer gave to Bun (the JSON given
    // to it, less what was left in its buffer before its end).
    const longest = Math.max(...gives)
    const numbers = {
      messages: given,
      events: all.length,
      gives: gives.length,
      longestGiveMs: Number(longest.toFixed(3)),
      bufferBytes: b.host.limits.bufferBytes,
      peakBufferBytes: peak,
      givenToStoppedBytes: givenBytes,
      takenByBunBytes: givenBytes - left,
      stoppedReadBytes: stoppedGot.length,
      elapsedMs: Math.round(elapsed)
    }
    console.log("slow reader:", JSON.stringify(numbers))
    // A give never waits on a reader: a give that waited would wait here for
    // good. The bound is wide for a loaded machine's pauses.
    expect(longest).toBeLessThan(100)
    expect(peak).toBeLessThanOrEqual(b.host.limits.bufferBytes)
    stopped.destroy()
    yield* Effect.promise(() => read.cancel())
    // Nothing of either client is left; the loaded chat keeps its hold.
    yield* until(() => b.host.registry.size().clients === 0 && holdersOf(b, TENANT_A, chat) === 1 && b.timers.pending === 0)
    expect(waitersOf(slowClient!)).toBe(0)
    nothingLeft(b, 1)
    yield* b.close
  })).pipe(Effect.provide(chatsLayer(file)), Effect.provide(capture)))
}, 20_000)
