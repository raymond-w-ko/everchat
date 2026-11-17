// Tests of `serve` (serve.ts) and the `.` entry: the routes on a real Bun
// server built with `serverOptions`, a real SQLite file and the tests' fake
// wire. Each case serves the routes over 127.0.0.1 at a port that the
// system picks, with real time and small limits where a time counts.

import { expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Context, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect"
import { HttpServer, HttpServerResponse } from "effect/http"
import { createConnection, type Socket } from "node:net"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request as Asked } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import { Host, serve, serverOptions } from "./index.ts"
import type { Limits } from "./limits.ts"
import { wantsStream } from "./serve.ts"
import { makeToken } from "./token.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 7 * i + 1))
const ORIGIN = "https://app.example"
const OTHER = "https://other.example"
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

// The stack of a loaded chat: the turn loop over a fake wire that says `text`.
const stackOf = (text = "A reply.") => {
  const wire = fakeWire((asked: Asked): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] }))
  return (store: typeof Store.Service) => {
    const memory = Memory.layer.pipe(Layer.provideMerge(Layer.succeed(Store, store)), Layer.provide(compactor(() => "a summary")))
    const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
    const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.succeed({ output: "2", failed: false }) }))
    return Turns.layer({ head: head(HOSTED) }).pipe(
      Layer.provideMerge(memory),
      Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), hostedLayer(HOSTED).pipe(Layer.provide(memory))))
    )
  }
}

// The log of the file, as JSON lines.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])

// The gate's lines from `from` on, as objects.
const gateLines = (from: number) =>
  lines.slice(from).map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => JSON.stringify(line.message).includes("the gate's answer"))
const routeOf = (line: Record<string, unknown>) => (line["annotations"] as Record<string, unknown> | undefined)?.["route"]

// The `Chats` of the routes: the real one, with a count of each chat's reads.
const counted = (real: typeof Chats.Service, reads: Array<string>) =>
  Chats.of({
    ...real,
    reads: (tenant, chat) => Effect.andThen(Effect.sync(() => reads.push(tenant + "/" + chat)), real.reads(tenant, chat))
  })

interface Served {
  readonly port: number
  readonly url: string // http://127.0.0.1:<port>/v1/chats/
  readonly file: string
  readonly host: typeof Host.Service
  readonly reads: Array<string> // the gate's lookups of a chat
  readonly a1: string
  readonly b1: string
  // A token for the real clock.
  readonly token: (tenant: string, chats: ReadonlyArray<string>) => Promise<string>
  // Ends `serve`'s layer only.
  readonly end: () => Promise<void>
  // Ends all.
  readonly close: () => Promise<void>
}

// `serve` on a Bun server with `serverOptions(limits)`.
const served = async (limits: Partial<Limits> = {}, text?: string): Promise<Served> => {
  const file = newFile()
  const scope = Effect.runSync(Scope.make())
  const reads: Array<string> = []
  const built = await Effect.runPromise(Effect.gen(function*() {
    const real = Context.get(yield* Layer.buildWithScope(chatsLayer(file), scope), Chats)
    const server = yield* Layer.buildWithScope(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...serverOptions(limits) }), scope)
    const own = yield* Scope.fork(scope, "sequential")
    const context = yield* Layer.buildWithScope(
      serve({ stack: stackOf(text), launch: LAUNCH, secret: SECRET, origins: [ORIGIN], limits }).pipe(
        Layer.provide(Layer.succeed(Chats, counted(real, reads))),
        Layer.provide(Layer.succeedContext(server))
      ),
      own
    )
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
    const a1 = yield* real.make(TENANT_A, PICK)
    const b1 = yield* real.make(TENANT_B, PICK)
    return { port, host: Context.get(context, Host), own, a1, b1 }
  }).pipe(Effect.provide(capture)))
  return {
    port: built.port,
    url: `http://127.0.0.1:${built.port}/v1/chats/`,
    file,
    host: built.host,
    reads,
    a1: built.a1,
    b1: built.b1,
    token: (tenant, chats) => Effect.runPromise(Effect.orDie(makeToken(SECRET, { tenant, chats: [...chats], exp: Math.floor(Date.now() / 1000) + 600 }))),
    end: () => Effect.runPromise(Scope.close(built.own, Exit.void)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

// Waits, in real time, until `check` holds or `ms` pass; gives whether it holds.
const within = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5))
  return check()
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// An event stream (R4) read in the background: its frames and its end.
const streamOf = async (url: string, token: string, headers: Record<string, string> = {}) => {
  const controller = new AbortController()
  const t0 = Date.now()
  const response = await fetch(url, { headers: { authorization: "Bearer " + token, accept: "text/event-stream", ...headers }, signal: controller.signal })
  // `chunks`: each chunk's time from the request; `stamps`: the same, as times of the clock.
  const state = { text: "", chunks: [] as Array<number>, stamps: [] as Array<number>, ended: null as null | "done" | "error", at: 0 }
  const reader = response.body!.getReader()
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          state.ended = "done"
          break
        }
        state.chunks.push(Date.now() - t0)
        state.stamps.push(Date.now())
        state.text += new TextDecoder().decode(value)
      }
    } catch {
      state.ended = "error"
    }
    state.at = Date.now() - t0
  })()
  // The frames: each event with its id, type and data.
  const frames = () =>
    state.text.split("\n\n").filter((frame) => frame !== "").map((frame) => {
      const fields: Record<string, string> = {}
      for (const line of frame.split("\n")) {
        const colon = line.indexOf(":")
        fields[colon === 0 ? "comment" : line.slice(0, colon)] = line.slice(colon + 1).trimStart()
      }
      return fields
    })
  return { response, state, frames, stop: () => controller.abort() }
}

// A socket of Bun's `WebSocket` client: its frames, parsed, and its close.
const socketOf = (port: number, chat: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chats/${chat}/socket`)
  const got: Array<Record<string, unknown>> = []
  const state: { closed: { code: number; reason: string } | undefined } = { closed: undefined }
  ws.onmessage = (event) => got.push(JSON.parse(String(event.data)))
  ws.onclose = (event) => {
    state.closed = { code: event.code, reason: event.reason }
  }
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("the socket did not open"))
  })
  return { ws, got, state, opened, types: () => got.map((frame) => frame["type"]) }
}

// R1: a message in.
const post = (s: Served, chat: string, token: string, text: string) =>
  fetch(s.url + chat + "/messages", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ text }) })

// The numbers of the numbered events, in the order given.
const numbers = (events: ReadonlyArray<{ readonly n?: unknown }>) => events.flatMap((event) => (typeof event.n === "number" ? [event.n] : []))

// The rows of the chats' tables, for a check that nothing changed.
const dump = (file: string) =>
  JSON.stringify(["everchat_chat", "everchat_msg", "everchat_event", "everchat_turn", "everchat_launch"].map((table) => rows(file, `select * from ${table} order by rowid`)))

// The routes
// ----------

test("each route over a real server: R1 logs a message; R4 (frames), R5 (JSON) and R6 (frames) give its events, each number once; R2 holds the message; R3 its page; R7 gives 204 with its headers for an origin on the list and 403 for another", async () => {
  const s = await served()
  try {
    const token = await s.token(TENANT_A, [s.a1])
    const stream = await streamOf(s.url + s.a1 + "/events?after=0", token)
    expect(stream.response.status).toBe(200)
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream")
    const socket = socketOf(s.port, s.a1)
    await socket.opened
    socket.ws.send(JSON.stringify({ type: "auth", token, after: 0 }))
    expect(await within(() => socket.types().includes("ready"), 2_000)).toBe(true)

    const sent = await post(s, s.a1, token, "hello there")
    expect(sent.status).toBe(200)
    const said = (await sent.json()) as { n: number; first: number; last: number; repeat: boolean }
    expect(said).toEqual({ n: 1, first: 0, last: 0, repeat: false })
    // The turn's end, on the stream and on the socket.
    expect(await within(() => stream.frames().some((frame) => frame["event"] === "end"), 5_000)).toBe(true)
    expect(await within(() => socket.types().includes("end"), 5_000)).toBe(true)

    const r4 = stream.frames().filter((frame) => frame["id"] !== undefined)
    const r4Numbers = r4.map((frame) => Number(frame["id"]))
    const polled = await fetch(s.url + s.a1 + "/events?after=0", { headers: { authorization: "Bearer " + token, accept: "application/json" } })
    expect(polled.status).toBe(200)
    expect(polled.headers.get("content-type")).toContain("application/json")
    const r5 = ((await polled.json()) as { events: Array<{ n: number; type: string }> }).events
    const r6 = socket.got.filter((frame) => typeof frame["n"] === "number")
    // Each number once, from 1 with no gap, the same on the three ways.
    expect(r4Numbers).toEqual(Array.from({ length: r4Numbers.length }, (_, k) => k + 1))
    expect(numbers(r5)).toEqual(r4Numbers)
    expect(numbers(r6)).toEqual(r4Numbers)
    expect(r4.map((frame) => frame["event"])).toEqual(r5.map((event) => event.type))
    expect(r4.map((frame) => frame["event"])).toEqual(["accepted", "start", "message", "end"])
    expect(r4.map((frame) => JSON.parse(frame["data"]!).n)).toEqual(r4Numbers)

    // R2 and R3.
    const snapshot = await fetch(s.url + s.a1, { headers: { authorization: "Bearer " + token } })
    expect(snapshot.status).toBe(200)
    expect(JSON.stringify(await snapshot.json())).toContain("hello there")
    const older = await fetch(s.url + s.a1 + "/messages?from=0&to=2", { headers: { authorization: "Bearer " + token } })
    expect(older.status).toBe(200)
    const page = JSON.stringify(await older.json())
    expect(page).toContain("hello there")
    expect(page).toContain("A reply.")

    // R7 on the paths of R1 to R5.
    for (const path of [s.a1, s.a1 + "/messages", s.a1 + "/events"]) {
      const listed = await fetch(s.url + path, { method: "OPTIONS", headers: { origin: ORIGIN } })
      expect(listed.status).toBe(204)
      expect(listed.headers.get("access-control-allow-origin")).toBe(ORIGIN)
      expect(listed.headers.get("access-control-allow-methods")).toBe("GET, POST")
      expect(listed.headers.get("access-control-allow-headers")).toBe("authorization, content-type, idempotency-key")
      expect(listed.headers.get("access-control-max-age")).toBe("600")
      const other = await fetch(s.url + path, { method: "OPTIONS", headers: { origin: OTHER } })
      expect(other.status).toBe(403)
      expect(((await other.json()) as { error: string }).error).toBe("forbidden_origin")
      expect(other.headers.get("access-control-allow-origin")).toBeNull()
    }
    stream.stop()
    socket.ws.close()
  } finally {
    await s.close()
  }
}, 15_000)

test("R4 or R5 by `Accept`: `text/event-stream` in its list, letter case and parameters aside, is R4 (a `q` that is no number, `q=0.001`, or one more part with no `q=0`, too); `application/json`, `*/*`, `text/event-streams`, none, and a part whose `q` is zero (`q=0` to `q=0.000`, `Q` too) are R5", async () => {
  const s = await served()
  try {
    const token = await s.token(TENANT_A, [s.a1])
    const r4 = [
      "text/event-stream",
      "TEXT/EVENT-STREAM",
      "text/event-stream;q=0.9",
      "application/json, text/event-stream;q=0.5, */*",
      "text/event-stream;q=0.001",
      "text/event-stream;q=x",
      "text/event-stream;q=0, text/event-stream"
    ]
    const r5 = [
      "application/json",
      "*/*",
      "text/event-streams",
      "text/event-stream-x, application/json",
      undefined,
      "application/json;q=1, text/event-stream;q=0",
      "text/event-stream;q=0.0",
      "text/event-stream; Q=0.000",
      "text/event-stream;q=0.00",
      "text/event-stream ; charset=utf-8 ; q=0"
    ]
    for (const accept of [...r4, ...r5]) {
      const controller = new AbortController()
      const headers: Record<string, string> = { authorization: "Bearer " + token }
      if (accept !== undefined) headers["accept"] = accept
      const response = await fetch(s.url + s.a1 + "/events?after=0", { headers, signal: controller.signal })
      expect(response.status).toBe(200)
      if (r4.includes(accept as string)) {
        expect(response.headers.get("content-type")).toBe("text/event-stream")
        controller.abort()
      } else {
        expect(response.headers.get("content-type")).toContain("application/json")
        expect(await response.json()).toEqual({ events: [] })
      }
    }
    // The choice alone.
    expect(r4.map(wantsStream)).toEqual(r4.map(() => true))
    expect(r5.map(wantsStream)).toEqual(r5.map(() => false))
    expect(wantsStream(" Text/Event-Stream ; charset=utf-8")).toBe(true)
    // Each R4 client went at its end.
    expect(await within(() => s.host.registry.size().clients === 0, 2_000)).toBe(true)
  } finally {
    await s.close()
  }
}, 15_000)

test("R4 or R5 by `Accept`, a quoted value one piece: a `;q=0` or a `,` in it ends nothing, so a stream part with one is R4; a backslash in it takes the next character, so an escaped quote ends nothing and an escaped backslash does not take the closing quote; a quoted string with no end runs to the end; a real `q=0` after a quoted value is R5", async () => {
  const s = await served()
  try {
    const token = await s.token(TENANT_A, [s.a1])
    const r4 = [
      // The review's header.
      'text/event-stream; profile="https://example.test/p;q=0;v=1"',
      // A `,` in a quoted value ends no part.
      'text/event-stream; x="a, b;q=0"',
      'text/event-stream; x="a,q=0"; y=1',
      // An escaped quote ends nothing: the `;q=0` is in the string.
      'text/event-stream; x="a\\";q=0"',
      'text/event-stream; x="a\\"; q=0, b"',
      // No end: nothing after the `"` splits.
      'text/event-stream; x="a;q=0',
      'text/event-stream; x="a, text/event-stream;q=0',
      // A quoted `q` is no weight (ruling 2 of ec-ajj5m).
      'text/event-stream; q="0"',
      // Another part names the stream after one with a quoted value.
      'application/json; x="a;b", text/event-stream'
    ]
    const r5 = [
      // The escaped backslash takes no quote: the string ended, the `q=0` is real.
      'text/event-stream; x="a\\\\";q=0',
      // A `,` in a quoted value names no type (with the `"` at its end the
      // split of the list on every `,` named none either; with a `;` before
      // it, it did).
      'application/json; x="a, text/event-stream"',
      'application/json; x="a, text/event-stream; y=1"',
      'application/json; x="a, text/event-stream',
      // A real `q=0` after a quoted value.
      'text/event-stream; profile="p;v=1"; q=0',
      'text/event-stream; x="a,b"; Q=0.000',
      // A backslash outside a quoted string takes nothing.
      "text/event-stream; x=a\\;q=0"
    ]
    for (const accept of [...r4, ...r5]) {
      const controller = new AbortController()
      const response = await fetch(s.url + s.a1 + "/events?after=0", { headers: { authorization: "Bearer " + token, accept }, signal: controller.signal })
      expect([accept, response.status]).toEqual([accept, 200])
      if (r4.includes(accept)) {
        expect([accept, response.headers.get("content-type")]).toEqual([accept, "text/event-stream"])
        controller.abort()
      } else {
        expect([accept, response.headers.get("content-type")]).toEqual([accept, "application/json; charset=utf-8"])
        expect(await response.json()).toEqual({ events: [] })
      }
    }
    // The choice alone.
    expect(r4.filter((accept) => !wantsStream(accept))).toEqual([])
    expect(r5.filter(wantsStream)).toEqual([])
    expect(await within(() => s.host.registry.size().clients === 0, 2_000)).toBe(true)
  } finally {
    await s.close()
  }
}, 15_000)

test("R4 or R5 by `Accept` in time linear in its length: a header of 16,000 bytes of `\"`, `;` and `\\` is answered in under 100 ms", async () => {
  const s = await served()
  const sockets: Array<Socket> = []
  // A head written raw, as small as the route takes: Bun refuses a head of
  // more than 16,384 bytes (431), which a fetch's own headers pass. Its
  // answer's head, and the time from the write to its end.
  const answer = (head: string) =>
    new Promise<{ readonly head: string; readonly took: number }>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: s.port })
      sockets.push(socket)
      let got = ""
      let started = 0
      socket.on("error", reject)
      socket.on("connect", () => {
        started = performance.now()
        socket.write(head)
      })
      socket.on("data", (data) => {
        got += data.toString("latin1")
        const end = got.indexOf("\r\n\r\n")
        if (end !== -1) {
          resolve({ head: got.slice(0, end), took: performance.now() - started })
          socket.destroy()
        }
      })
    })
  try {
    const token = await s.token(TENANT_A, [s.a1])
    const type = "text/event-stream;"
    const accepts = [
      // A quoted string that never ends: each `\` in it takes a `"`, so the
      // rest is one piece and the part names the stream (R4).
      { accept: type + '"' + '\\";'.repeat(5_327), stream: true },
      // 7,988 quoted strings of one `;` each, every one its own piece, then
      // a real `q=0.00` (R5).
      { accept: type + '";'.repeat(7_988) + "q=0.00", stream: false }
    ]
    for (const { accept, stream } of accepts) {
      expect(accept.length).toBe(16_000)
      const alone = performance.now()
      expect(wantsStream(accept)).toBe(stream)
      expect(performance.now() - alone).toBeLessThan(100)
      const head = `GET /v1/chats/${s.a1}/events?after=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nAccept: ${accept}\r\n\r\n`
      expect(head.length).toBeLessThanOrEqual(16_384)
      const answered = await answer(head)
      const lines = answered.head.toLowerCase().split("\r\n")
      expect(lines[0]).toBe("http/1.1 200 ok")
      expect(lines).toContain(stream ? "content-type: text/event-stream" : "content-type: application/json; charset=utf-8")
      expect(answered.took).toBeLessThan(100)
    }
    expect(await within(() => s.host.registry.size().clients === 0, 2_000)).toBe(true)
  } finally {
    for (const socket of sockets) socket.destroy()
    await s.close()
  }
}, 15_000)

test("no route: other paths, and other methods on the routes' paths (a HEAD too, OPTIONS on R6's), get the 404 with no body and no CORS header; no check and no work runs: a bad token gets the 404, and no read, no client and no hold follow; a GET on R1's path is R3's", async () => {
  const s = await served()
  try {
    const good = await s.token(TENANT_A, [s.a1])
    const a = s.a1
    const asked: Array<readonly [string, string]> = [
      ["GET", "/v1/chats"],
      ["GET", "/v1/chats/"],
      ["GET", `/v1/chats/${a}/`],
      ["GET", `/V1/chats/${a}`],
      ["GET", `/v1/Chats/${a}`],
      ["GET", `/v1/chats/${a}/Events`],
      ["GET", `/v1/chats/${a}/events/more`],
      ["GET", `/v1/chats/${a}/messages/`],
      ["GET", `/v1/chats/${a}/x`],
      ["GET", "/"],
      ["GET", "/v2/chats/" + a],
      ["HEAD", `/v1/chats/${a}`],
      ["HEAD", `/v1/chats/${a}/messages`],
      ["HEAD", `/v1/chats/${a}/events?after=0`],
      ["HEAD", `/v1/chats/${a}/socket`],
      ["POST", `/v1/chats/${a}`],
      ["POST", `/v1/chats/${a}/events`],
      ["POST", `/v1/chats/${a}/socket`],
      ["PUT", `/v1/chats/${a}/messages`],
      ["DELETE", `/v1/chats/${a}/messages`],
      ["PATCH", `/v1/chats/${a}`],
      ["DELETE", `/v1/chats/${a}`],
      ["OPTIONS", `/v1/chats/${a}/socket`],
      ["OPTIONS", "/v1/chats"]
    ]
    const before = lines.length
    for (const [method, path] of asked) {
      for (const authorization of ["Bearer not-a-token", "Bearer " + good]) {
        const headers: Record<string, string> = { authorization, origin: ORIGIN, accept: path.includes("?") ? "text/event-stream" : "application/json" }
        const response = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers, ...(method === "POST" || method === "PUT" || method === "PATCH" ? { body: "{\"text\":\"x\"}" } : {}) })
        expect([method, path, response.status]).toEqual([method, path, 404])
        expect(await response.text()).toBe("")
        expect(response.headers.get("access-control-allow-origin")).toBeNull()
        expect(response.headers.get("cache-control")).toBe("no-store")
      }
    }
    // Each was the gate's answer of no route: no route's name, no check.
    const answered = gateLines(before)
    expect(answered.length).toBe(asked.length * 2)
    expect(answered.map(routeOf)).toEqual(Array.from({ length: asked.length * 2 }, () => "none"))
    expect(s.reads).toEqual([])
    expect(s.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    expect(rows(s.file, "select count(*) as n from everchat_msg")).toEqual([{ n: 0 }])

    // A GET on R1's path is R3: its own answer (its query, then its page),
    // and no message is logged.
    const mark = lines.length
    const noQuery = await fetch(s.url + a + "/messages", { headers: { authorization: "Bearer " + good } })
    expect(noQuery.status).toBe(400)
    expect(gateLines(mark).map(routeOf)).toEqual(["R3"])
    const r3 = await fetch(s.url + a + "/messages?from=0&to=1", { headers: { authorization: "Bearer " + good } })
    expect(r3.status).toBe(200)
    expect(Object.keys((await r3.json()) as object)).toEqual(["messages"])
    expect(rows(s.file, "select count(*) as n from everchat_msg")).toEqual([{ n: 0 }])
  } finally {
    await s.close()
  }
}, 15_000)

test("the other paths are the gate's: with every place of `requests` taken, a request that is no route gets `503 busy`, as a route's does", async () => {
  const s = await served({ requests: 1, bodyRead: 2_000 })
  let holder: Socket | undefined
  try {
    const token = await s.token(TENANT_A, [s.a1])
    // R1 whose body does not come: it holds the one place while it reads.
    holder = createConnection({ host: "127.0.0.1", port: s.port })
    holder.on("error", () => {})
    holder.write(`POST /v1/chats/${s.a1}/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"te`)
    expect(await within(() => s.reads.length === 1, 2_000)).toBe(true)
    const none = await fetch(`http://127.0.0.1:${s.port}/nothing`)
    expect(none.status).toBe(503)
    expect(none.headers.get("retry-after")).toBe("1")
    const route = await fetch(s.url + s.a1, { headers: { authorization: "Bearer " + token } })
    expect(route.status).toBe(503)
  } finally {
    holder?.destroy()
    await s.close()
  }
}, 15_000)

test("two tenants, every route and the socket: a token of tenant A on a chat of tenant B gets `404 no_chat` (R6: 4404), and B's rows are the same before and after", async () => {
  const s = await served()
  try {
    // B's chat with a message and its turn, by B's own token.
    const tokenB = await s.token(TENANT_B, [s.b1])
    expect((await post(s, s.b1, tokenB, "B's own")).status).toBe(200)
    expect(await within(() => rows<{ status: string }>(s.file, "select status from everchat_turn")[0]?.status === "done", 5_000)).toBe(true)
    const before = dump(s.file)
    const readsBefore = s.reads.length
    // A's token that names B's chat, and A's token for A's chat on B's path.
    for (const token of [await s.token(TENANT_A, [s.b1]), await s.token(TENANT_A, [s.a1, s.b1])]) {
      const auth = { authorization: "Bearer " + token }
      const answers = [
        await post(s, s.b1, token, "not for B"),
        await fetch(s.url + s.b1, { headers: auth }),
        await fetch(s.url + s.b1 + "/messages?from=0&to=1", { headers: auth }),
        await fetch(s.url + s.b1 + "/events?after=0", { headers: { ...auth, accept: "text/event-stream" } }),
        await fetch(s.url + s.b1 + "/events?after=0&wait=1", { headers: { ...auth, accept: "application/json" } })
      ]
      for (const answer of answers) {
        expect(answer.status).toBe(404)
        expect(((await answer.json()) as { error: string }).error).toBe("no_chat")
      }
      const socket = socketOf(s.port, s.b1)
      await socket.opened
      socket.ws.send(JSON.stringify({ type: "auth", token, after: 0 }))
      expect(await within(() => socket.state.closed !== undefined, 2_000)).toBe(true)
      expect(socket.state.closed?.code).toBe(4404)
      expect(socket.got).toEqual([])
    }
    expect(dump(s.file)).toBe(before)
    // The lookups of the checks only: one per request and socket.
    expect(s.reads.length - readsBefore).toBe(12)
    // No client, and no channel of A: the one channel is B's own loaded chat.
    expect(s.host.registry.size()).toEqual({ channels: 1, clients: 0 })
    expect(s.host.registry.find(TENANT_A, s.b1)).toBeUndefined()
    expect(s.host.registry.find(TENANT_B, s.b1)?.clients).toEqual([])
  } finally {
    await s.close()
  }
}, 15_000)

test("a token in the query of each route is not read: R1 to R5 get `401`, R6 waits for its `auth` and closes with 4401; no log line holds a query, a header's value or a token", async () => {
  const s = await served({ auth: 300 })
  const before = lines.length
  try {
    const token = await s.token(TENANT_A, [s.a1])
    const q = "?token=" + token + "&access_token=" + token + "&after=0&from=0&to=1"
    const headers = { origin: ORIGIN, "x-secret-header": "a-header-value" }
    const answers = [
      await fetch(s.url + s.a1 + "/messages" + q, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{\"text\":\"x\"}" }),
      await fetch(s.url + s.a1 + q, { headers }),
      await fetch(s.url + s.a1 + "/messages" + q, { headers }),
      await fetch(s.url + s.a1 + "/events" + q, { headers: { ...headers, accept: "text/event-stream" } }),
      await fetch(s.url + s.a1 + "/events" + q, { headers: { ...headers, accept: "application/json" } })
    ]
    for (const answer of answers) {
      expect(answer.status).toBe(401)
      expect(((await answer.json()) as { error: string }).error).toBe("unauthorized")
    }
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/v1/chats/${s.a1}/socket${q}`, { headers: { authorization: "Bearer " + token } } as unknown as string[])
    const closed = await new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)))
    expect(closed).toBe(4401)
    // A good request with its headers, for the log too.
    expect((await fetch(s.url + s.a1 + "?last=1", { headers: { ...headers, authorization: "Bearer " + token } })).status).toBe(200)
    const logged = lines.slice(before).join("\n")
    expect(logged.length).toBeGreaterThan(0)
    for (const secret of [token, token.slice(0, 20), "token=", "access_token", "?", "a-header-value", ORIGIN, "Bearer"]) {
      expect(logged.includes(secret) ? secret : null).toBeNull()
    }
    expect(s.host.registry.size()).toEqual({ channels: 0, clients: 0 })
  } finally {
    await s.close()
  }
}, 15_000)

// The start and the end
// ---------------------

test("the start: a secret that is too short and a limit that breaks a relation fail the layer, and no request is served", async () => {
  const file = newFile()
  const failures = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const real = Context.get(yield* Layer.build(chatsLayer(file)), Chats)
    const server = yield* Layer.build(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...serverOptions() }))
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
    const start = (secret: Redacted.Redacted<Uint8Array>, limits: Partial<Limits>) =>
      Effect.flip(Effect.scoped(Layer.build(serve({ stack: stackOf(), launch: LAUNCH, secret, origins: [ORIGIN], limits }).pipe(
        Layer.provide(Layer.succeed(Chats, real)),
        Layer.provide(Layer.succeedContext(server))
      ))))
    const short = yield* start(Redacted.make(new Uint8Array(31)), {})
    const broken = yield* start(SECRET, { idle: 60_000 })
    const before = lines.length
    // The server answers with Effect's own handler of no app: no route of the host.
    const answer = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/v1/chats/${TENANT_A}`).then(async (r) => [r.status, await r.text()] as const))
    return { short: short._tag, broken: broken._tag, answer, gate: gateLines(before).length }
  }).pipe(Effect.provide(capture))))
  expect(failures.short).toBe("SecretTooShort")
  expect(failures.broken).toBe("LimitsRefused")
  expect(failures.answer).toEqual([404, "not found"])
  expect(failures.gate).toBe(0)
}, 15_000)

test("the end: with an R4 client and an R6 client, the layer's end gives R4 its `close` frame with `stop` and R6 the code 1001; a socket before its `auth` is closed with 1001 too, and an `auth` after the host's stop makes no client; nothing is left", async () => {
  const s = await served()
  try {
    const token = await s.token(TENANT_A, [s.a1])
    expect((await post(s, s.a1, token, "hello")).status).toBe(200)
    const stream = await streamOf(s.url + s.a1 + "/events?after=0", token)
    const client = socketOf(s.port, s.a1)
    await client.opened
    client.ws.send(JSON.stringify({ type: "auth", token, after: 0 }))
    const waiting = socketOf(s.port, s.a1)
    await waiting.opened
    expect(await within(() => client.types().includes("ready") && stream.frames().some((frame) => frame["event"] === "end"), 5_000)).toBe(true)
    expect(s.host.registry.size()).toEqual({ channels: 1, clients: 2 })
    // The `auth` of the waiting socket goes as the stream gets its `close`:
    // after the host's stop.
    let sentAt = -1
    const watch = (async () => {
      await within(() => stream.frames().some((frame) => frame["event"] === "close"), 5_000)
      sentAt = Date.now()
      if (waiting.ws.readyState === WebSocket.OPEN) waiting.ws.send(JSON.stringify({ type: "auth", token, after: 0 }))
    })()
    await s.end()
    await watch
    expect(stream.frames().at(-1)).toEqual({ event: "close", data: "{\"type\":\"close\",\"reason\":\"stop\"}" })
    expect(await within(() => stream.state.ended !== null, 2_000)).toBe(true)
    expect(await within(() => client.state.closed !== undefined && waiting.state.closed !== undefined, 2_000)).toBe(true)
    expect(client.state.closed?.code).toBe(1001)
    expect(waiting.state.closed?.code).toBe(1001)
    expect(sentAt).toBeGreaterThan(0)
    // No `ready` and no event after an `auth` of the stopped host: it makes
    // no client (lead, ec-yculc).
    expect(waiting.got).toEqual([])
    expect(s.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    expect(s.host.reads.taken()).toBe(0)
    // Each launch ended.
    expect(rows(s.file, "select count(*) as n from everchat_launch where ended is null")).toEqual([{ n: 0 }])
  } finally {
    await s.close()
  }
}, 15_000)

// The server's numbers
// --------------------

test("`serverOptions`: at the defaults 190, 120, the frame's bound and Bun's bound of a slow socket at `bufferBytes`; at other limits their numbers, each time rounded up and never 0", () => {
  expect(serverOptions()).toEqual({
    idleTimeout: 190,
    websocket: { idleTimeout: 120, maxPayloadLength: 524_288, closeOnBackpressureLimit: true, backpressureLimit: 8_388_608 }
  })
  expect(serverOptions({ idle: 1_500, socketIdle: 30_001, body: 70_000, bufferBytes: 1_000_000 })).toEqual({
    idleTimeout: 2,
    websocket: { idleTimeout: 31, maxPayloadLength: 70_000, closeOnBackpressureLimit: true, backpressureLimit: 1_000_000 }
  })
  expect(serverOptions({ idle: 1, socketIdle: 1 })).toMatchObject({ idleTimeout: 1, websocket: { idleTimeout: 1 } })
  expect(serverOptions({ idle: 255_000 }).idleTimeout).toBe(255)
})

test("R4's first byte: a stream of a chat with no event after `after` (an empty chat, and `after` at `seq`) has its `200` head and `: ping` within 1 s, long before `ping` ms", async () => {
  const s = await served()
  try {
    const token = await s.token(TENANT_A, [s.a1, s.b1])
    const empty = await streamOf(s.url + s.a1 + "/events?after=0", token)
    expect(empty.response.status).toBe(200)
    expect(await within(() => empty.state.text.length > 0, 1_000)).toBe(true)
    expect(empty.state.text).toBe(": ping\n\n")
    expect(empty.state.chunks[0]).toBeLessThan(1_000)
    // `after` at `seq`.
    expect((await post(s, s.b1, await s.token(TENANT_B, [s.b1]), "hi")).status).toBe(200)
    const tokenB = await s.token(TENANT_B, [s.b1])
    expect(await within(() => rows<{ status: string }>(s.file, "select status from everchat_turn")[0]?.status === "done", 5_000)).toBe(true)
    const polled = await fetch(s.url + s.b1 + "/events?after=0", { headers: { authorization: "Bearer " + tokenB } })
    const seq = Math.max(...numbers(((await polled.json()) as { events: Array<{ n: number }> }).events))
    expect(seq).toBeGreaterThanOrEqual(4)
    const atSeq = await streamOf(s.url + s.b1 + "/events?after=" + seq, tokenB)
    expect(await within(() => atSeq.state.text.length > 0, 1_000)).toBe(true)
    expect(atSeq.state.text).toBe(": ping\n\n")
    empty.stop()
    atSeq.stop()
  } finally {
    await s.close()
  }
}, 15_000)

// The measures at a small scale (ruling 6): a server with `serverOptions`
// of `idle` 5 s, whose sums hold (`idle` ≥ 2 × (`wait` + 2 × (`request` +
// `store`)) = 4.8 s), and `ping` 1 s. Bun counts its idle limit in ticks of
// 4 s, and resets every answer at its first tick when the limit is one tick
// (4 s or less; ec-fhomd's probe): 5 s is two ticks, the least at which a
// stream's own writes keep it. The case asserts the order, not Bun's clock
// (lead, ec-fhomd): the control's reset comes before the watch ends, and the
// stream is whole, with its pings, after it.
test("the idle limit at a small scale: an R4 stream with no event is whole by its pings after the point where a quiet answer on a server with the same numbers was reset (a watch of 10 s); an R5 that waits answers whole", async () => {
  const limits: Partial<Limits> = { idle: 5_000, wait: 1_000, request: 400, store: 300, ping: 1_000, socketIdle: 2_000 }
  expect(serverOptions(limits).idleTimeout).toBe(5)
  const s = await served(limits)
  // The control: a server with the same numbers, whose answer comes after 12 s.
  const control = Effect.runSync(Scope.make())
  const controlPort = await Effect.runPromise(Effect.gen(function*() {
    const server = yield* Layer.buildWithScope(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...serverOptions(limits) }), control)
    yield* Layer.buildWithScope(HttpServer.serve(Effect.as(Effect.sleep(12_000), HttpServerResponse.text("late"))).pipe(Layer.provide(Layer.succeedContext(server))), control)
    return (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
  }))
  try {
    const token = await s.token(TENANT_A, [s.a1])
    const t0 = Date.now()
    const quiet = fetch(`http://127.0.0.1:${controlPort}/`).then(
      async (r) => ({ answered: await r.text(), at: Date.now() - t0 }),
      () => ({ answered: null, at: Date.now() - t0 })
    )
    const stream = await streamOf(s.url + s.a1 + "/events?after=0", token)
    const polled = fetch(s.url + s.a1 + "/events?after=0&wait=1", { headers: { authorization: "Bearer " + token, accept: "application/json" } }).then(
      async (r) => ({ status: r.status, body: await r.json(), at: Date.now() - t0 })
    )
    await sleep(10_000)
    const watched = Date.now() - t0
    // The control was reset before the watch ended.
    const reset = await Promise.race([quiet, Promise.resolve({ answered: "not reset yet", at: watched })])
    expect(reset.answered).toBeNull()
    expect(reset.at).toBeLessThan(watched)
    // The stream has no end, and its pings go on after the control's reset.
    expect(stream.state.ended).toBeNull()
    const pings = (stream.state.text.match(/: ping\n\n/g) ?? []).length
    expect(stream.state.text).toBe(": ping\n\n".repeat(pings))
    expect(stream.state.stamps.filter((at) => at > t0 + reset.at).length).toBeGreaterThanOrEqual(1)
    const r5 = await polled
    expect(r5).toMatchObject({ status: 200, body: { events: [] } })
    expect(r5.at).toBeGreaterThanOrEqual(1_000)
    console.log(`the idle limit at idleTimeout 5: the stream was whole at 10 s with ${pings} pings; R5 answered at ${r5.at} ms; the control was reset at ${reset.at} ms`)
    stream.stop()
  } finally {
    await Effect.runPromise(Scope.close(control, Exit.void))
    await s.close()
  }
}, 20_000)

// A slow socket (ruling 8)
// ------------------------

// A raw WebSocket client: the upgrade, then frames sent masked; it reads only
// while `reading`. Its text frames, parsed, and whether a close frame came.
const rawSocket = (port: number, chat: string) => {
  const socket = createConnection({ host: "127.0.0.1", port })
  socket.on("error", () => {})
  const state = { buffer: Buffer.alloc(0), upgraded: false, frames: [] as Array<Record<string, unknown>>, closeFrame: null as number | null, ended: false }
  const parse = () => {
    while (state.buffer.length >= 2) {
      const opcode = state.buffer[0]! & 0x0f
      let length = state.buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (state.buffer.length < 4) return
        length = state.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (state.buffer.length < 10) return
        length = Number(state.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (state.buffer.length < offset + length) return
      const payload = state.buffer.subarray(offset, offset + length)
      state.buffer = state.buffer.subarray(offset + length)
      if (opcode === 1) state.frames.push(JSON.parse(payload.toString()))
      if (opcode === 8) state.closeFrame = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
    }
  }
  socket.on("data", (data: Buffer) => {
    state.buffer = Buffer.concat([state.buffer, data])
    if (!state.upgraded) {
      const end = state.buffer.indexOf("\r\n\r\n")
      if (end === -1) return
      state.upgraded = true
      state.buffer = state.buffer.subarray(end + 4)
    }
    parse()
  })
  socket.on("close", () => (state.ended = true))
  socket.write(
    `GET /v1/chats/${chat}/socket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
  )
  const send = (text: string) => {
    const mask = Buffer.from([9, 8, 7, 6])
    const body = Buffer.from(text)
    const masked = Buffer.from(body.map((byte, k) => byte ^ mask[k % 4]!))
    const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 0xff])
    socket.write(Buffer.concat([head, mask, masked]))
  }
  return { socket, state, send }
}

test("a socket after `ready` that reads nothing while events pass Bun's bound of a slow socket (`bufferBytes`) is ended by Bun; the frames that it got are in the order of their numbers with no hole; nothing of it is left", async () => {
  // Messages of 199,000 characters: their `accepted` events pass the kernel's
  // buffers and Bun's bound (1.4 MB) together.
  const limits: Partial<Limits> = { text: 200_000, body: 200_011, entry: 1_300_000, pageBytes: 1_300_000, bufferBytes: 1_400_000, said: 1_000 }
  const s = await served(limits)
  try {
    const token = await s.token(TENANT_A, [s.a1])
    const raw = rawSocket(s.port, s.a1)
    expect(await within(() => raw.state.upgraded, 2_000)).toBe(true)
    raw.send(JSON.stringify({ type: "auth", token, after: 0 }))
    expect(await within(() => raw.state.frames.some((frame) => frame["type"] === "ready"), 2_000)).toBe(true)
    expect(s.host.registry.size().clients).toBe(1)
    raw.socket.pause()
    const big = "x".repeat(199_000)
    let posted = 0
    for (; posted < 60 && s.host.registry.size().clients === 1; posted++) {
      expect((await post(s, s.a1, token, big + posted)).status).toBe(200)
    }
    // Bun ended it: the host's session saw its close, and the client left.
    expect(await within(() => s.host.registry.size().clients === 0, 5_000)).toBe(true)
    raw.socket.resume()
    expect(await within(() => raw.state.ended, 5_000)).toBe(true)
    const got = numbers(raw.state.frames as Array<{ n?: unknown }>)
    expect(got.length).toBeGreaterThan(0)
    expect(got).toEqual(Array.from({ length: got.length }, (_, k) => k + 1))
    // Ended with no close frame: the host could not send `4408` for it.
    expect(raw.state.closeFrame).toBeNull()
    // No client, and no hold of the socket: the one holder left is the
    // loaded chat's (its load by R1).
    expect(s.host.registry.size()).toEqual({ channels: 1, clients: 0 })
    expect(s.host.registry.find(TENANT_A, s.a1)?.holders).toBe(1)
    console.log(`a slow socket: ${posted} messages of 199,000 characters posted, ${got.length} numbered events read, then Bun ended it`)
  } finally {
    await s.close()
  }
}, 20_000)
