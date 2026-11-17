// Tests of `serve`'s end under traffic (serve.ts, the head comment's end;
// host.ts, the layer's end; channel.ts, the registry's `stop`; lead,
// ec-yculc): requests of every kind that come while the layer ends. No
// request becomes a client after the host's stop, each client of before
// gets `stop`, a request after the end's mark gets `503 busy` from `serve`
// itself, and the end is short. Each case serves the routes on a real Bun
// server built with `serverOptions`, over a real SQLite file and the tests'
// fake wire, at 127.0.0.1 and a port that the system picks.

import { expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Context, Deferred, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect"
import { HttpServer } from "effect/http"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request as Asked } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import { Channel, type Client } from "./channel.ts"
import { ERRORS } from "./http.ts"
import { Host, serve, serverOptions } from "./index.ts"
import type { Limits } from "./limits.ts"
import { makeToken } from "./token.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 7 * i + 1))
const ORIGIN = "https://app.example"
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
const BUSY = JSON.stringify({ error: "busy", message: ERRORS.busy.message })

// The stack of a loaded chat: the turn loop over a fake wire that says a line.
const stack = (store: typeof Store.Service) => {
  const wire = fakeWire((asked: Asked): Reply => reply(asked, { text: "A reply.", output: [{ type: "message", content: [{ type: "output_text", text: "A reply." }] }] }))
  const memory = Memory.layer.pipe(Layer.provideMerge(Layer.succeed(Store, store)), Layer.provide(compactor(() => "a summary")))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.succeed({ output: "2", failed: false }) }))
  return Turns.layer({ declarations: HOSTED }).pipe(
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), hostedLayer.pipe(Layer.provide(memory))))
  )
}

// The log of the file, as JSON lines; the gate's lines from `from` on.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])
const gateLines = (from: number, to = lines.length) =>
  lines.slice(from, to).filter((line) => line.includes("the gate's answer")).length

interface Served {
  readonly port: number
  readonly url: string // http://127.0.0.1:<port>/v1/chats/
  readonly file: string
  readonly host: typeof Host.Service
  readonly a1: string
  readonly a2: string
  readonly b1: string
  readonly token: (tenant: string, chats: ReadonlyArray<string>) => Promise<string>
  // The next `Chats.store` (a load's) waits first for this, with no
  // interruption: it holds the loader's end.
  hold: Effect.Effect<void> | undefined
  opens: number
  readonly end: () => Promise<void>
  readonly close: () => Promise<void>
}

// `serve` on a Bun server with `serverOptions(limits)`.
const served = async (limits: Partial<Limits>): Promise<Served> => {
  const file = newFile()
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(Effect.gen(function*() {
    const real = Context.get(yield* Layer.buildWithScope(chatsLayer(file), scope), Chats)
    const server = yield* Layer.buildWithScope(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...serverOptions(limits) }), scope)
    const own = yield* Scope.fork(scope, "sequential")
    const gated = Chats.of({
      ...real,
      store: (tenant, chat, launch) =>
        Effect.andThen(Effect.suspend(() => {
          s.opens += 1
          const hold = s.hold
          s.hold = undefined
          return hold ?? Effect.void
        }), real.store(tenant, chat, launch))
    })
    const context = yield* Layer.buildWithScope(
      serve({ stack, launch: LAUNCH, secret: SECRET, origins: [ORIGIN], limits }).pipe(
        Layer.provide(Layer.succeed(Chats, gated)),
        Layer.provide(Layer.succeedContext(server))
      ),
      own
    )
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
    return { port, host: Context.get(context, Host), own, a1: yield* real.make(TENANT_A, PICK), a2: yield* real.make(TENANT_A, PICK), b1: yield* real.make(TENANT_B, PICK) }
  }).pipe(Effect.provide(capture)))
  const s: Served = {
    port: built.port,
    url: `http://127.0.0.1:${built.port}/v1/chats/`,
    file,
    host: built.host,
    a1: built.a1,
    a2: built.a2,
    b1: built.b1,
    token: (tenant, chats) => Effect.runPromise(Effect.orDie(makeToken(SECRET, { tenant, chats: [...chats], exp: Math.floor(Date.now() / 1000) + 600 }))),
    hold: undefined,
    opens: 0,
    end: () => Effect.runPromise(Scope.close(built.own, Exit.void)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
  return s
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// Waits, in real time, until `check` holds or `ms` pass; gives whether it holds.
const within = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await sleep(2)
  return check()
}

// An event stream (R4) read in the background: its text and its end.
const streamOf = async (url: string, token: string) => {
  const controller = new AbortController()
  const response = await fetch(url, { headers: { authorization: "Bearer " + token, accept: "text/event-stream" }, signal: controller.signal })
  const state = { text: "", ended: null as null | "done" | "error" }
  if (response.body !== null) {
    const reader = response.body.getReader()
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          state.text += new TextDecoder().decode(value)
        }
        state.ended = "done"
      } catch {
        state.ended = "error"
      }
    })()
  }
  const last = () => state.text.split("\n\n").filter((frame) => frame !== "").at(-1)
  return { response, state, last, stop: () => controller.abort() }
}
const CLOSE_STOP = "event: close\ndata: {\"type\":\"close\",\"reason\":\"stop\"}"

// A socket of Bun's `WebSocket` client: its frames' types and its close.
const socketOf = (port: number, chat: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chats/${chat}/socket`)
  const state = { types: [] as Array<unknown>, closed: undefined as number | undefined, readyAt: -1 }
  ws.onmessage = (event) => {
    const type = (JSON.parse(String(event.data)) as { type: unknown }).type
    if (type === "ready") state.readyAt = performance.now()
    state.types.push(type)
  }
  ws.onclose = (event) => {
    state.closed = event.code
  }
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
  })
  return { ws, state, opened }
}

// The clients that the channels add and their ends, seen from the class
// itself: each client with the time of its add, and the time of the first
// and of the last `stop` that a channel gave. Restored by `restore`.
const watchClients = () => {
  const added: Array<{ readonly client: Client; readonly at: number }> = []
  const seen = { firstStop: Infinity, lastStop: -Infinity }
  const addClient = Channel.prototype.addClient
  const removeClient = Channel.prototype.removeClient
  Channel.prototype.addClient = function(this: Channel, given, options) {
    return Effect.tap(addClient.call(this, given, options), (client) => Effect.sync(() => added.push({ client, at: performance.now() })))
  }
  // A `stop` counts from the call (`firstStop`) to the end of its step
  // (`lastStop`): a step waits for the give lock.
  Channel.prototype.removeClient = function(this: Channel, client, reason) {
    if (reason !== "stop") return removeClient.call(this, client, reason)
    seen.firstStop = Math.min(seen.firstStop, performance.now())
    return Effect.tap(removeClient.call(this, client, reason), () =>
      Effect.sync(() => {
        seen.lastStop = performance.now()
      }))
  }
  return {
    added,
    seen,
    restore: () => {
      Channel.prototype.addClient = addClient
      Channel.prototype.removeClient = removeClient
    }
  }
}

// An answer of a plain request, as the test sees it.
interface Answered {
  readonly kind: string
  readonly sentAt: number
  readonly at: number
  readonly status: number
  readonly retryAfter: string | null
  readonly text: string
}
const answered = async (kind: string, url: string, init: RequestInit = {}): Promise<Answered | null> => {
  const sentAt = performance.now()
  try {
    const response = await fetch(url, init)
    // A stream's body is not read: only its head.
    const stream = response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("text/event-stream")
    const text = stream ? "" : await response.text()
    if (stream) await response.body?.cancel()
    return { kind, sentAt, at: performance.now(), status: response.status, retryAfter: response.headers.get("retry-after"), text }
  } catch {
    return null
  }
}

test("the review's probe at a small scale: R4 streams, R5s that wait, R6 sockets with their auth and R1s on two tenants' chats, from before the end until it returns: the end takes under 2 s; each R4 with 200 ends with its close frame and stop; each R6 with ready closes with 1001; no client after the host's stop; a request after the mark gets 503 busy with retry-after 1 and no gate line; nothing is left", async () => {
  const s = await served({ request: 4_000 })
  const watch = watchClients()
  const streams: Array<{ readonly at: number; readonly stream: Awaited<ReturnType<typeof streamOf>> }> = []
  const sockets: Array<{ readonly at: number; readonly socket: ReturnType<typeof socketOf> }> = []
  const plain: Array<Answered> = []
  // Set at the end of the case, or when a check fails: the loops stop.
  let flooding = true
  let ended = false
  try {
    const tokens = { A: await s.token(TENANT_A, [s.a1]), B: await s.token(TENANT_B, [s.b1]) }
    const chats = { A: s.a1, B: s.b1 }
    for (const tenant of ["A", "B"] as const) {
      const sent = await fetch(s.url + chats[tenant] + "/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + tokens[tenant], "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" })
      })
      expect(sent.status).toBe(200)
    }
    const auth = (tenant: "A" | "B") => JSON.stringify({ type: "auth", token: tokens[tenant], after: 0 })
    // Clients of before, on both chats, sure to be there at the end: two
    // R4 streams and two R6 sockets with `ready` of each tenant.
    for (const tenant of ["A", "B", "A", "B"] as const) {
      const stream = await streamOf(s.url + chats[tenant] + "/events?after=0", tokens[tenant])
      expect(stream.response.status).toBe(200)
      streams.push({ at: performance.now(), stream })
      const socket = socketOf(s.port, chats[tenant])
      sockets.push({ at: performance.now(), socket })
      expect(await socket.opened).toBe(true)
      socket.ws.send(auth(tenant))
      expect(await within(() => socket.state.readyAt >= 0, 2_000)).toBe(true)
    }
    // Twelve loops: R4, R5 with a wait, R6 with its auth, R1; tenant A for
    // the first four and the last four, B for the four between.
    const pumps = Array.from({ length: 12 }, (_, k) => (async () => {
      const tenant = Math.floor(k / 4) % 2 === 0 ? "A" : "B"
      const chat = s.url + chats[tenant]
      const bearer = { authorization: "Bearer " + tokens[tenant] }
      while (flooding) {
        const at = performance.now()
        switch (k % 4) {
          case 0: {
            const stream = await streamOf(chat + "/events?after=0", tokens[tenant]).catch(() => null)
            if (stream !== null) streams.push({ at, stream })
            else await sleep(1)
            break
          }
          case 1: {
            const got = await answered("R5", chat + "/events?after=1000000&wait=2", { headers: bearer })
            if (got !== null) plain.push(got)
            break
          }
          case 2: {
            const socket = socketOf(s.port, chats[tenant])
            sockets.push({ at, socket })
            if (await socket.opened) socket.ws.send(auth(tenant))
            await sleep(2)
            break
          }
          default: {
            const got = await answered("R1", chat + "/messages", {
              method: "POST",
              headers: { ...bearer, "content-type": "application/json" },
              body: JSON.stringify({ text: "more" })
            })
            if (got !== null) plain.push(got)
          }
        }
      }
    })())
    await sleep(300)
    const t0 = performance.now()
    const linesAtEnd = lines.length
    let endAt = Infinity
    const ending = s.end().then(() => {
      endAt = performance.now()
      ended = true
    })
    // The registry's clients, every 2 ms, until the end returns.
    const samples: Array<{ readonly at: number; readonly clients: number }> = []
    const sampler = (async () => {
      while (endAt === Infinity && flooding) {
        samples.push({ at: performance.now(), clients: s.host.registry.size().clients })
        await sleep(2)
      }
    })()
    // A request of no route, again and again: the gate gives it `404`, and
    // after the mark `serve` gives it `503`. Its first `503` dates the mark.
    let markAt = Infinity
    while (endAt === Infinity && performance.now() - t0 < 2_000) {
      const got = await answered("none", s.url + "x/none")
      if (got === null) continue
      plain.push(got)
      if (got.status === 503 && markAt === Infinity) markAt = got.sentAt
      if (markAt !== Infinity) break
    }
    // The end is short: it returns within 2 s.
    await Promise.race([ending, sleep(2_000)])
    expect(ended).toBe(true)
    await sampler
    flooding = false
    await Promise.all(pumps)
    expect(endAt - t0).toBeLessThan(2_000)
    // Each R4 with `200` ends with its `close` frame and `stop`, and none
    // with an error.
    const ok = streams.filter((x) => x.stream.response.status === 200)
    expect(await within(() => ok.every((x) => x.stream.state.ended !== null), 2_000)).toBe(true)
    expect(ok.length).toBeGreaterThan(0)
    expect(ok.filter((x) => x.stream.state.ended !== "done" || x.stream.last() !== CLOSE_STOP).map((x) => [x.at - t0, x.stream.state.ended, x.stream.last()])).toEqual([])
    expect(streams.filter((x) => x.stream.response.status !== 200 && x.stream.response.status !== 503).map((x) => x.stream.response.status)).toEqual([])
    // Each R6 with `ready` closes with `1001`.
    expect(await within(() => sockets.every((x) => x.socket.state.closed !== undefined), 2_000)).toBe(true)
    const ready = sockets.filter((x) => x.socket.state.readyAt >= 0)
    expect(ready.length).toBeGreaterThan(0)
    expect(ready.filter((x) => x.socket.state.closed !== 1001).map((x) => [x.at - t0, x.socket.state.closed])).toEqual([])
    // No client after the host's stop: no client added from the first
    // `stop` on but one that got `stop` (one added before the registry's
    // stop, whose add was seen late), and no client in any sample after the
    // last `stop`.
    expect(watch.seen.lastStop).toBeGreaterThan(t0)
    expect(watch.added.filter((x) => x.at >= watch.seen.firstStop && x.client.ended?.reason !== "stop").length).toBe(0)
    expect(watch.added.every((x) => x.client.ended !== null)).toBe(true)
    expect(samples.filter((x) => x.at > watch.seen.lastStop && x.clients !== 0)).toEqual([])
    expect(samples.some((x) => x.at > watch.seen.lastStop)).toBe(true)
    // A request sent after the mark and answered before the end returned
    // gets `503 busy` with `retry-after: 1` from `serve`.
    expect(markAt).toBeLessThan(endAt)
    const late = plain.filter((x) => x.sentAt > markAt && x.at < endAt)
    expect(late.length).toBeGreaterThan(0)
    expect(late.filter((x) => x.status !== 503 || x.retryAfter !== "1" || x.text !== BUSY)).toEqual([])
    // No gate line for them: from the end's start, the gate wrote at most a
    // line for each request and socket that it had when the mark came.
    const before = plain.filter((x) => x.sentAt < markAt && x.at > t0).length +
      streams.filter((x) => x.at < markAt).length + sockets.filter((x) => x.at < markAt).length
    expect(gateLines(linesAtEnd)).toBeLessThanOrEqual(before)
    // Nothing is left.
    expect(s.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    expect([s.host.reads.taken(), s.host.reads.waiting()]).toEqual([0, 0])
    expect(rows(s.file, "select count(*) as n from everchat_launch where ended is null")).toEqual([{ n: 0 }])
    console.log("the end under traffic:", JSON.stringify({
      endMs: Math.round(endAt - t0),
      r4: streams.length,
      r4Ok: ok.length,
      r6: sockets.length,
      r6Ready: ready.length,
      late: late.length,
      added: watch.added.length
    }))
  } finally {
    flooding = false
    watch.restore()
    for (const x of streams) x.stream.stop()
    for (const x of sockets) x.socket.ws.close()
    // An end that did not return in time is not waited for here: the case
    // has failed already, and its server ends with the process.
    if (ended) await s.close()
  }
}, 15_000)

test("a socket that connected before the end and sends its auth after the host's stop gets no ready; while the end waits for a load, each request gets 503 busy with retry-after 1 from serve, with no gate line", async () => {
  const s = await served({ request: 4_000 })
  const gate = Effect.runSync(Deferred.make<void>())
  try {
    const token = await s.token(TENANT_A, [s.a1, s.a2])
    const bearer = { authorization: "Bearer " + token }
    expect((await fetch(s.url + s.a1 + "/messages", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) })).status).toBe(200)
    // A client: its `close` frame says that the host has stopped.
    const stream = await streamOf(s.url + s.a1 + "/events?after=0", token)
    expect(stream.response.status).toBe(200)
    // A socket before its `auth`.
    const waiting = socketOf(s.port, s.a1)
    expect(await waiting.opened).toBe(true)
    // A load of a cold chat that the end cannot stop until the gate opens.
    s.hold = Effect.uninterruptible(Deferred.await(gate))
    const opens = s.opens
    const loading = fetch(s.url + s.a2 + "/messages", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ text: "cold" }) }).then(
      (response) => response.status,
      () => null
    )
    expect(await within(() => s.opens > opens, 2_000)).toBe(true)
    let ended = false
    const ending = s.end().then(() => {
      ended = true
    })
    expect(await within(() => stream.last() === CLOSE_STOP, 2_000)).toBe(true)
    // After the host's stop: the `auth` gets no `ready` (the registry
    // refuses its client: `4503`).
    waiting.ws.send(JSON.stringify({ type: "auth", token, after: 0 }))
    expect(await within(() => waiting.state.closed !== undefined, 2_000)).toBe(true)
    expect({ closed: waiting.state.closed, types: waiting.state.types }).toEqual({ closed: 4503, types: [] })
    expect(ended).toBe(false)
    // Each kind of request, while the end waits: `serve` answers it.
    await sleep(20)
    const from = lines.length
    const kinds = await Promise.all([
      answered("R1", s.url + s.a1 + "/messages", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ text: "late" }) }),
      answered("R2", s.url + s.a1, { headers: bearer }),
      answered("R3", s.url + s.a1 + "/messages", { headers: bearer }),
      answered("R4", s.url + s.a1 + "/events?after=0", { headers: { ...bearer, accept: "text/event-stream" } }),
      answered("R5", s.url + s.a1 + "/events?after=0&wait=2", { headers: bearer }),
      answered("R6", s.url + s.a1 + "/socket", { headers: bearer }),
      answered("R7", s.url + s.a1 + "/messages", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } }),
      answered("none", s.url + "x/none")
    ])
    const late = socketOf(s.port, s.a1)
    const lateOpened = await late.opened
    expect(kinds.map((x) => x === null ? null : [x.kind, x.status, x.retryAfter, x.text])).toEqual(
      ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "none"].map((kind) => [kind, 503, "1", BUSY])
    )
    expect(lateOpened).toBe(false)
    expect(ended).toBe(false)
    expect(gateLines(from)).toBe(0)
    expect(s.host.registry.size().clients).toBe(0)
    Effect.runSync(Deferred.succeed(gate, undefined))
    await ending
    await loading
    expect(s.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    expect(rows(s.file, "select count(*) as n from everchat_launch where ended is null")).toEqual([{ n: 0 }])
  } finally {
    Effect.runSync(Deferred.succeed(gate, undefined))
    await s.close()
  }
}, 15_000)
