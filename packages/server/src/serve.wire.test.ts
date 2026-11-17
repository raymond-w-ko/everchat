// Tests of `serve` (serve.ts) on the wire: what a request's target becomes
// on a real Bun server, and which route it reaches (lead, ec-5tdje). Bun
// parses a request's target as a URL before any code of Effect or the host
// runs, and `serve` matches its paths on the text that it gets: a target
// that this parsing makes equal to a route's path is that route's request,
// with all of its checks on that text; one that it does not is no route.
// Effect's Bun server answers `CONNECT` itself, and Bun a head that it
// cannot parse: neither reaches the host. Each case speaks raw HTTP/1.1
// over TCP (`fetch` and Bun's `WebSocket` parse the target on the client's
// side) to its own server on 127.0.0.1, at a port that the system picks,
// over a real SQLite file and the tests' fake wire.

import { expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Context, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect"
import { HttpServer } from "effect/http"
import { createConnection, createServer, type Socket } from "node:net"
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
import { ERRORS } from "./http.ts"
import { Host, serve, serverOptions } from "./index.ts"
import type { Limits } from "./limits.ts"
import { makeToken } from "./token.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 3 * i + 11))
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

// The stack of a loaded chat: the turn loop over a fake wire.
const stackOf = () => {
  const wire = fakeWire((asked: Asked): Reply => reply(asked, { text: "A reply.", output: [{ type: "message", content: [{ type: "output_text", text: "A reply." }] }] }))
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

// The routes of the gate's lines from `from` on.
const gateRoutes = (from: number) =>
  lines.slice(from).map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => JSON.stringify(line["message"]).includes("the gate's answer")).map((
    line
  ) => (line["annotations"] as Record<string, unknown> | undefined)?.["route"])

interface Served {
  readonly port: number
  readonly file: string
  readonly host: typeof Host.Service
  readonly reads: Array<string> // the gate's lookups of a chat
  readonly a1: string
  readonly b1: string
  readonly token: (tenant: string, chats: ReadonlyArray<string>) => Promise<string>
  readonly close: () => Promise<void>
}

// `serve` on a Bun server with `serverOptions(limits)`; `Chats` counts each
// lookup of a chat.
const served = async (limits: Partial<Limits> = {}): Promise<Served> => {
  const file = newFile()
  const scope = Effect.runSync(Scope.make())
  const reads: Array<string> = []
  const built = await Effect.runPromise(Effect.gen(function*() {
    const real = Context.get(yield* Layer.buildWithScope(chatsLayer(file), scope), Chats)
    const counted = Chats.of({
      ...real,
      reads: (tenant, chat) => Effect.andThen(Effect.sync(() => reads.push(tenant + "/" + chat)), real.reads(tenant, chat))
    })
    const server = yield* Layer.buildWithScope(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...serverOptions(limits) }), scope)
    const context = yield* Layer.buildWithScope(
      serve({ stack: stackOf(), launch: LAUNCH, secret: SECRET, origins: [], limits }).pipe(
        Layer.provide(Layer.succeed(Chats, counted)),
        Layer.provide(Layer.succeedContext(server))
      ),
      yield* Scope.fork(scope, "sequential")
    )
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
    return { port, host: Context.get(context, Host), a1: yield* real.make(TENANT_A, PICK), b1: yield* real.make(TENANT_B, PICK) }
  }).pipe(Effect.provide(capture)))
  return {
    ...built,
    file,
    reads,
    token: (tenant, chats) => Effect.runPromise(Effect.orDie(makeToken(SECRET, { tenant, chats: [...chats], exp: Math.floor(Date.now() / 1000) + 600 }))),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

// The rows of the chats' tables, for a check that nothing changed.
const dump = (file: string) =>
  JSON.stringify(["everchat_chat", "everchat_msg", "everchat_event", "everchat_turn", "everchat_launch"].map((table) => rows(file, `select * from ${table} order by rowid`)))
// The rows of tenant B's chats only.
const B_ID = "x'" + TENANT_B.replaceAll("-", "") + "'"
const dumpB = (file: string) =>
  JSON.stringify([
    rows(file, `select * from everchat_chat where tenant = ${B_ID} order by rowid`),
    ...["everchat_msg", "everchat_event", "everchat_turn", "everchat_launch"].map((table) =>
      rows(file, `select * from ${table} where chat in (select id from everchat_chat where tenant = ${B_ID}) order by rowid`)
    )
  ])
const said = (file: string, text: string) => rows<{ n: number }>(file, `select count(*) as n from everchat_msg where text = '${text}'`)[0]!.n

const errorText = (code: keyof typeof ERRORS) => JSON.stringify({ error: code, message: ERRORS[code].message })

// Raw HTTP/1.1
// ------------

// A connection to the test's server (or the test's own peer); it is closed
// in the case (`end`). `closed`: the peer's close was seen, at `closedAt`.
const connect = (port: number) => {
  const socket = createConnection({ host: "127.0.0.1", port })
  const state = { got: Buffer.alloc(0), closed: false, closedAt: 0 }
  socket.on("data", (data: Buffer) => {
    state.got = Buffer.concat([state.got, data])
  })
  socket.on("error", () => {})
  socket.on("close", () => {
    state.closed = true
    state.closedAt = Date.now()
  })
  // Whether `check` held within `ms`. Each caller reads it (lead, ec-im5b8,
  // 1): a wait that ran out is a failure, never an answer.
  const until = async (check: () => boolean, ms: number) => {
    const end = Date.now() + ms
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 1))
    return check()
  }
  return { socket, state, until, end: () => socket.destroy() }
}

// The bound of each wait of the helpers, when a case gives none.
const WAIT = 2_000

// A wait that ran out: the case fails here, with the request it waited for.
const ranOut = (what: string, ms: number) => new Error(`${what}: no whole answer and no close within ${ms} ms`)

interface Answer {
  readonly status: number | null // null: the peer's close was seen, with no byte before it
  readonly headers: Record<string, string>
  readonly body: string
  readonly ms: number // from the write to the whole answer, or to the seen close
}

// The answer at the head of `bytes`, once it is whole (by its length, or
// its chunks), else undefined.
const parse = (bytes: Buffer): Omit<Answer, "ms"> | undefined => {
  const head = bytes.indexOf("\r\n\r\n")
  if (head === -1) return undefined
  const [first, ...fields] = bytes.subarray(0, head).toString("latin1").split("\r\n")
  const headers: Record<string, string> = {}
  for (const field of fields) {
    const colon = field.indexOf(":")
    headers[field.slice(0, colon).toLowerCase()] = field.slice(colon + 1).trim()
  }
  const status = Number(first!.split(" ")[1])
  const rest = bytes.subarray(head + 4)
  if (headers["transfer-encoding"] === "chunked") {
    let body = ""
    let at = 0
    while (true) {
      const line = rest.indexOf("\r\n", at)
      if (line === -1) return undefined
      const size = parseInt(rest.subarray(at, line).toString("latin1"), 16)
      if (size === 0) return { status, headers, body }
      if (rest.length < line + 2 + size + 2) return undefined
      body += rest.subarray(line + 2, line + 2 + size).toString("utf8")
      at = line + 2 + size + 2
    }
  }
  const length = Number(headers["content-length"] ?? 0)
  if (rest.length < length) return undefined
  return { status, headers, body: rest.subarray(0, length).toString("utf8") }
}

// One request with this request line's method and target, as its bytes are
// written, on a new connection that is closed after its answer. It waits at
// most `wait` ms for a whole answer or the peer's close. A wait that ran out
// fails; so do bytes that are no whole answer at the peer's close. Only a
// seen close with no byte before it gives `status: null` (lead, ec-im5b8, 2).
const exchange = async (
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body = "",
  wait = WAIT
): Promise<Answer> => {
  const c = connect(port)
  try {
    const fields = Object.entries({ host: "127.0.0.1", connection: "close", ...headers, ...(body === "" ? {} : { "content-length": String(Buffer.byteLength(body)) }) })
      .map(([name, value]) => `${name}: ${value}\r\n`).join("")
    const written = Date.now()
    c.socket.write(`${method} ${target} HTTP/1.1\r\n${fields}\r\n${body}`)
    const done = await c.until(() => c.state.closed || parse(c.state.got) !== undefined, wait)
    if (!done) throw ranOut(`${method} ${target}`, wait)
    const answer = parse(c.state.got)
    if (answer !== undefined) return { ...answer, ms: Date.now() - written }
    if (c.state.closed && c.state.got.length === 0) return { status: null, headers: {}, body: "", ms: c.state.closedAt - written }
    throw new Error(`${method} ${target}: the peer closed after ${c.state.got.length} bytes that are no whole answer`)
  } finally {
    c.end()
  }
}

// R6 over a raw connection: the upgrade, then an `auth` frame with `token`.
// Gives the upgrade's status and, after it, the frames that came until the
// first `ready` or the close (its code).
const socketAuth = async (port: number, target: string, token: string, wait = WAIT) => {
  const c = connect(port)
  try {
    c.socket.write(
      `GET ${target} HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`
    )
    if (!(await c.until(() => c.state.closed || c.state.got.indexOf("\r\n\r\n") !== -1, wait))) throw ranOut(`the upgrade at ${target}`, wait)
    const head = c.state.got.indexOf("\r\n\r\n")
    const status = head === -1 ? null : Number(c.state.got.subarray(0, head).toString("latin1").split(" ")[1])
    if (status !== 101) return { status, frames: [] as Array<string>, close: null as number | null }
    // A masked text frame, as a client sends it.
    const payload = Buffer.from(JSON.stringify({ type: "auth", token, after: null }))
    const mask = Buffer.from([1, 2, 3, 4])
    const length = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff])
    c.socket.write(Buffer.concat([Buffer.from([0x81]), length, mask, payload.map((byte, i) => byte ^ mask[i % 4]!)]))
    // The server's frames: not masked.
    const frames: Array<string> = []
    let close: number | null = null
    const read = () => {
      let at = head + 4
      frames.length = 0
      while (at + 2 <= c.state.got.length) {
        const opcode = c.state.got[at]! & 0x0f
        let size = c.state.got[at + 1]! & 0x7f
        let start = at + 2
        if (size === 126) {
          size = c.state.got.readUInt16BE(at + 2)
          start = at + 4
        } else if (size === 127) {
          size = Number(c.state.got.readBigUInt64BE(at + 2))
          start = at + 10
        }
        if (c.state.got.length < start + size) return
        const data = c.state.got.subarray(start, start + size)
        if (opcode === 8) close = data.readUInt16BE(0)
        else if (opcode === 1) frames.push(data.toString("utf8"))
        at = start + size
      }
    }
    const done = await c.until(() => {
      read()
      return c.state.closed || close !== null || frames.some((frame) => frame.includes("\"ready\""))
    }, wait)
    if (!done) throw ranOut(`the frames after the auth at ${target}`, wait)
    return { status, frames: [...frames], close }
  } finally {
    c.end()
  }
}

// The routes and the spellings
// ----------------------------

interface RouteCase {
  readonly name: "R1" | "R2" | "R3" | "R5" | "R6"
  readonly method: "GET" | "POST"
  readonly last: "" | "/messages" | "/events" | "/socket"
  readonly query: string
}
const ROUTES: ReadonlyArray<RouteCase> = [
  { name: "R1", method: "POST", last: "/messages", query: "" },
  { name: "R2", method: "GET", last: "", query: "" },
  { name: "R3", method: "GET", last: "/messages", query: "?from=0&to=1" },
  { name: "R5", method: "GET", last: "/events", query: "?after=0" },
  { name: "R6", method: "GET", last: "/socket", query: "" }
]

// The spellings that Bun's parsing makes equal to a route's path (the probe
// of ec-5tdje): a dot segment, `./` or `../`, in each place; `%2e` or `%2E`
// for the dot of one; a backslash for a slash; the absolute form, whose host
// is dropped. Each gives the target for a chat and a last part.
const another = (last: RouteCase["last"]) => (last === "/events" ? "/socket" : "/events")
const EQUAL: ReadonlyArray<readonly [string, (chat: string, last: RouteCase["last"]) => string]> = [
  ["./ before v1", (chat, last) => `/./v1/chats/${chat}${last}`],
  ["../ before v1", (chat, last) => `/x/../v1/chats/${chat}${last}`],
  ["../ above the root", (chat, last) => `/../v1/chats/${chat}${last}`],
  ["./ between the fixed parts", (chat, last) => `/v1/./chats/${chat}${last}`],
  ["../ between the fixed parts", (chat, last) => `/v1/x/../chats/${chat}${last}`],
  ["./ before {chat}", (chat, last) => `/v1/chats/./${chat}${last}`],
  ["../ before {chat}", (chat, last) => `/v1/chats/x/../${chat}${last}`],
  ["./ after {chat}", (chat, last) => (last === "" ? `/v1/chats/${chat}/./../${chat}` : `/v1/chats/${chat}/.${last}`)],
  ["../ after {chat}", (chat, last) => (last === "" ? `/v1/chats/${chat}/x/../../${chat}` : `/v1/chats/${chat}${another(last)}/..${last}`)],
  ["%2e", (chat, last) => `/v1/chats/%2e/${chat}${last}`],
  ["%2E", (chat, last) => `/v1/chats/%2E/${chat}${last}`],
  [".%2e", (chat, last) => `/v1/x/.%2e/chats/${chat}${last}`],
  ["%2e%2e", (chat, last) => `/v1/x/%2e%2e/chats/${chat}${last}`],
  ["%2E%2E", (chat, last) => `/v1/x/%2E%2E/chats/${chat}${last}`],
  ["%2e.", (chat, last) => `/v1/x/%2e./chats/${chat}${last}`],
  ["%2e%2E", (chat, last) => `/v1/x/%2e%2E/chats/${chat}${last}`],
  ["a backslash for each slash after the first", (chat, last) => `/v1\\chats\\${chat}${last.replace("/", "\\")}`],
  ["the absolute form", (chat, last) => `http://other.example/v1/chats/${chat}${last}`]
]

// Text of a target that no log line may hold.
const MARKS = ["/./", "/../", "%2e", "%2E", "\\", "other.example", "/x/"]

// What a request of `route` at `target` with `token` got: its status (R6:
// the upgrade's), its body (R6: the close code, or its first frame), and the
// gate's lines' routes.
const ask = async (s: Served, route: RouteCase, target: string, token: string, text = "hello") => {
  const from = lines.length
  if (route.name === "R6") {
    const got = await socketAuth(s.port, target, token)
    return { status: got.status, body: got.close !== null ? "close " + got.close : got.frames[0] ?? "", routes: gateRoutes(from) }
  }
  const answer = await exchange(s.port, route.method, target + route.query, {
    authorization: "Bearer " + token,
    ...(route.method === "POST" ? { "content-type": "application/json" } : {})
  }, route.method === "POST" ? JSON.stringify({ text }) : "")
  return { status: answer.status, body: answer.body, routes: gateRoutes(from) }
}

// (a)
test("each spelling that Bun's parsing makes equal to a route's path is that route's request, on R1, R2, R3, R5 and R6's upgrade: with a bad token the route's `401` (R6: 4401, as its path), and the gate's line names the route; with a token of tenant A on B's chat `404 no_chat` (R6: 4404) and B's rows the same; with a good token the route's answer in its form, the work done one time (R1: one message), and no log line holds a text of the target", async () => {
  const s = await served({ said: 1_000 })
  try {
    const good = await s.token(TENANT_A, [s.a1])
    const onB = await s.token(TENANT_A, [s.b1])
    for (const route of ROUTES) {
      const canonical = (chat: string) => `/v1/chats/${chat}${route.last}`
      // The answers of the route's own path.
      const bad = await ask(s, route, canonical(s.a1), "not-a-token")
      expect([route.name, bad.status, bad.body, bad.routes]).toEqual(
        route.name === "R6" ? [route.name, 101, "close 4401", ["R6"]] : [route.name, 401, errorText("unauthorized"), [route.name]]
      )
      const other = await ask(s, route, canonical(s.b1), onB)
      expect([route.name, other.status, other.body, other.routes]).toEqual(
        route.name === "R6" ? [route.name, 101, "close 4404", ["R6"]] : [route.name, 404, errorText("no_chat"), [route.name]]
      )
      // A good answer has no line of the gate: its form is the route's.
      const formOf = (got: { status: number | null; body: string }) =>
        [got.status, route.name === "R6" ? got.body : Object.keys(JSON.parse(got.body) as object).sort()]
      const form = formOf(await ask(s, route, canonical(s.a1), good, `${route.name} canonical`))
      // B's rows: the same before and after every spelling of A's token on B's chat.
      const rowsOfB = dumpB(s.file)
      expect(rowsOfB).toContain("\"id\"")
      for (const [spelling, spell] of EQUAL) {
        const target = spell(s.b1, route.last)
        expect([route.name, spelling, await ask(s, route, target, "not-a-token")]).toEqual([route.name, spelling, bad])
        expect([route.name, spelling, await ask(s, route, target, onB)]).toEqual([route.name, spelling, other])
      }
      expect([route.name, dumpB(s.file) === rowsOfB]).toEqual([route.name, true])
      // A good token: the route's answer and its work, one time.
      for (const [spelling, spell] of EQUAL) {
        const target = spell(s.a1, route.last)
        const from = lines.length
        const text = `${route.name} ${spelling}`.replace(/[^a-zA-Z0-9 ]/g, "_")
        const got = await ask(s, route, target, good, text)
        expect([route.name, spelling, formOf(got)]).toEqual([route.name, spelling, form])
        expect([route.name, spelling, got.status]).toEqual([route.name, spelling, route.name === "R6" ? 101 : 200])
        if (route.name === "R6") expect([spelling, got.body]).toEqual([spelling, "{\"type\":\"ready\"}"])
        if (route.name === "R1") expect([spelling, said(s.file, text)]).toEqual([spelling, 1])
        for (const line of lines.slice(from)) for (const mark of MARKS) expect([spelling, line.includes(mark)]).toEqual([spelling, false])
      }
    }
    // Each lookup of a chat was of the canonical text: A's or B's.
    expect(s.reads.filter((read) => read !== TENANT_A + "/" + s.a1 && read !== TENANT_A + "/" + s.b1)).toEqual([])
  } finally {
    await s.close()
  }
}, 15_000)

// (b)
test("each spelling that Bun's parsing does not make equal (another letter case, a slash at the end, two slashes, an encoded slash, an encoded letter in a fixed part, a parameter, a part more) gets the 404 of no route with no body, with a place taken and given back, and no check and no work (a bad token gets the 404); an encoded letter, a parameter or a fragment in `{chat}` gets the gate's check of that text, and no work", async () => {
  const s = await served({ requests: 1, bodyRead: 2_000 })
  let holder: Socket | undefined
  try {
    const good = await s.token(TENANT_A, [s.a1])
    const a = s.a1
    const other: ReadonlyArray<readonly [string, string]> = [
      ["GET", `/V1/chats/${a}`],
      ["GET", `/v1/Chats/${a}`],
      ["POST", `/v1/chats/${a}/Messages`],
      ["GET", `/v1/chats/${a}/`],
      ["GET", `/v1/chats/${a}/messages/`],
      ["GET", `/v1/chats/${a}/.`],
      ["GET", `/v1/chats/${a}/messages/..`],
      ["GET", `/v1/chats/${a}/%2e`],
      ["GET", `/v1/chats/%252e/${a}`],
      ["GET", `//v1/chats/${a}`],
      ["GET", `/v1//chats/${a}`],
      ["GET", `/v1/chats//${a}`],
      ["POST", `/v1/chats/${a}//messages`],
      ["GET", `/v1/chats%2f${a}`],
      ["POST", `/v1/chats/${a}%2Fmessages`],
      ["GET", `/v1/ch%61ts/${a}`],
      ["POST", `/v1/chats/${a}/%6dessages`],
      ["GET", `/v1/chats;x/${a}`],
      ["POST", `/v1/chats/${a}/messages;x`],
      ["GET", `/v1/chats/${a}/events/more`],
      ["POST", `/v1/chats/${a}/x/../messages/more`],
      ["GET", `//other.example/v1/chats/${a}`]
    ]
    const before = dump(s.file)
    const from = lines.length
    for (const [method, target] of other) {
      for (const token of ["not-a-token", good]) {
        const got = await exchange(s.port, method, target, { authorization: "Bearer " + token, "content-type": "application/json" }, method === "POST" ? "{\"text\":\"x\"}" : "")
        expect([method, target, got.status, got.body]).toEqual([method, target, 404, ""])
      }
    }
    // Each was the gate's answer of no route, one after another with the one
    // place of `requests`: each took it and gave it back.
    expect(gateRoutes(from)).toEqual(Array.from({ length: other.length * 2 }, () => "none"))
    expect(s.reads).toEqual([])
    expect(s.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    expect(dump(s.file)).toEqual(before)

    // `{chat}` with another spelling of the chat: the gate checks that text.
    // A bad token: the route's `401`; a good token (it names the chat as the
    // store has it): `404 no_chat`, with no lookup and no work.
    // The chat with its first letter, and its first digit, as a percent escape.
    const escaped = (pattern: RegExp) => {
      const at = a.search(pattern)
      return a.slice(0, at) + "%" + a.charCodeAt(at).toString(16) + a.slice(at + 1)
    }
    const chats = [escaped(/[a-f]/), escaped(/[0-9]/), `${a};x=1`, `${a}%20`, `${a}#x`]
    for (const chat of chats) {
      for (const [name, method, last] of [["R1", "POST", "/messages"], ["R2", "GET", ""]] as const) {
        const mark = lines.length
        const target = `/v1/chats/${chat}${last}`
        const body = method === "POST" ? "{\"text\":\"x\"}" : ""
        const bad = await exchange(s.port, method, target, { authorization: "Bearer not-a-token", "content-type": "application/json" }, body)
        expect([target, bad.status, bad.body]).toEqual([target, 401, errorText("unauthorized")])
        const checked = await exchange(s.port, method, target, { authorization: "Bearer " + good, "content-type": "application/json" }, body)
        expect([target, checked.status, checked.body]).toEqual([target, 404, errorText("no_chat")])
        expect([target, gateRoutes(mark)]).toEqual([target, [name, name]])
      }
    }
    expect(s.reads).toEqual([])
    expect(dump(s.file)).toEqual(before)

    // The place: with the one place held (an R1 whose body does not come), a
    // spelling that is no route gets `503 busy`, as a route does.
    holder = createConnection({ host: "127.0.0.1", port: s.port })
    holder.on("error", () => {})
    holder.write(`POST /v1/chats/${a}/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${good}\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"te`)
    const end = Date.now() + 2_000
    while (s.reads.length === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(s.reads.length).toBe(1)
    for (const [method, target] of other.slice(0, 4)) {
      const got = await exchange(s.port, method, target, { authorization: "Bearer not-a-token" })
      expect([target, got.status, got.headers["retry-after"]]).toEqual([target, 503, "1"])
    }
  } finally {
    holder?.destroy()
    await s.close()
  }
}, 15_000)

// (c)
test("`CONNECT` is the server's own: authority-form and origin-form on each route's path get `501` with no body before the host's handler: no line of the gate's log, no client, no read, no row changed; with the one place of `requests` held it is still `501` while an unknown path gets `503 busy`; after it, on a new connection, a route answers", async () => {
  const s = await served({ requests: 1, bodyRead: 2_000 })
  let holder: Socket | undefined
  try {
    const good = await s.token(TENANT_A, [s.a1])
    const a = s.a1
    const targets = [`127.0.0.1:${s.port}`, `/v1/chats/${a}`, `/v1/chats/${a}/messages`, `/v1/chats/${a}/events`, `/v1/chats/${a}/socket`, "/nothing"]
    const before = dump(s.file)
    const from = lines.length
    for (const target of targets) {
      const got = await exchange(s.port, "CONNECT", target, { authorization: "Bearer " + good })
      expect([target, got.status, got.body]).toEqual([target, 501, ""])
    }
    expect(gateRoutes(from)).toEqual([])
    expect(s.reads).toEqual([])
    expect(s.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    expect(dump(s.file)).toEqual(before)

    // The one place held: `CONNECT` is still `501`; a request that is no
    // route is the gate's, `503 busy`.
    holder = createConnection({ host: "127.0.0.1", port: s.port })
    holder.on("error", () => {})
    holder.write(`POST /v1/chats/${a}/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${good}\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"te`)
    const end = Date.now() + 2_000
    while (s.reads.length === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(s.reads.length).toBe(1)
    for (const target of targets) expect([target, (await exchange(s.port, "CONNECT", target)).status]).toEqual([target, 501])
    const none = await exchange(s.port, "GET", "/nothing")
    expect([none.status, none.headers["retry-after"]]).toEqual([503, "1"])
    holder.destroy()
    holder = undefined
    // The place is back when the held request has ended: a route answers.
    let answered: number | null = null
    for (let k = 0; k < 200 && answered !== 200; k++) {
      answered = (await exchange(s.port, "GET", `/v1/chats/${a}`, { authorization: "Bearer " + good })).status
      if (answered !== 200) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(answered).toBe(200)
  } finally {
    holder?.destroy()
    await s.close()
  }
}, 15_000)

// (d)
test("a head that Bun cannot parse is Bun's own, on a route's path too: a method name that it does not know (`FOO`, `get`, `PRI`) closes the connection with no answer; a tab or a space in the target gets `505`; `*` and a target that starts with a backslash get `400`; no line of the gate's log and no read", async () => {
  const s = await served()
  try {
    const good = await s.token(TENANT_A, [s.a1])
    const a = s.a1
    const from = lines.length
    for (const method of ["FOO", "get", "PRI"]) {
      const got = await exchange(s.port, method, `/v1/chats/${a}`, { authorization: "Bearer " + good })
      expect([method, got.status]).toEqual([method, null])
      // The server's close, seen within 1 s of the write (ec-5tdje: 0 to 1 ms).
      expect([method, got.ms < 1_000]).toEqual([method, true])
    }
    for (const [target, status] of [[`/v1/chats/\t${a}`, 505], [`/v1/chats/ ${a}`, 505], ["*", 400], [`\\v1/chats/${a}`, 400]] as const) {
      const got = await exchange(s.port, "GET", target, { authorization: "Bearer " + good })
      expect([target, got.status]).toEqual([target, status])
    }
    expect(gateRoutes(from)).toEqual([])
    expect(s.reads).toEqual([])
  } finally {
    await s.close()
  }
}, 15_000)

// (e)
test("the helper `exchange` takes only a seen close for no answer: a peer that takes the head, sends nothing and stays open makes it fail at its bound (200 ms), with the peer still open; a peer that sends half of a head and stays open, or closes after it, makes it fail; a peer that closes with no byte gives `status: null`; a peer that answers whole gives the answer", async () => {
  type Mode = "silent" | "half" | "half, then a close" | "a close" | "whole"
  const HALF = "HTTP/1.1 200 OK\r\ncontent-le"
  let mode: Mode = "silent"
  const peer = { heads: 0, closedAt: 0 }
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    peer.closedAt = 0
    socket.on("error", () => {})
    socket.on("close", () => {
      peer.closedAt = Date.now()
      sockets.delete(socket)
    })
    socket.once("data", () => {
      peer.heads += 1
      if (mode === "half") socket.write(HALF)
      else if (mode === "half, then a close") socket.end(HALF)
      else if (mode === "a close") socket.destroy()
      else if (mode === "whole") socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  try {
    // Silent and open: a failure at the bound, naming the method and the
    // target; the peer had not closed by then.
    mode = "silent"
    const t0 = Date.now()
    const silent = await exchange(port, "FOO", "/silent", {}, "", 200).then(() => "answered", (error: Error) => error.message)
    const failedAfter = Date.now() - t0
    const openAtFailure = peer.closedAt === 0
    expect(silent).toBe("FOO /silent: no whole answer and no close within 200 ms")
    expect([failedAfter >= 200, failedAfter < 1_000, openAtFailure, peer.heads]).toEqual([true, true, true, 1])
    // Half of a head, open: a failure at the bound.
    mode = "half"
    expect(await exchange(port, "GET", "/half", {}, "", 200).then(() => "answered", (error: Error) => error.message))
      .toBe("GET /half: no whole answer and no close within 200 ms")
    // Half of a head, then the peer's close: a failure, not the sentinel.
    mode = "half, then a close"
    expect(await exchange(port, "GET", "/half-closed", {}, "", 200).then(() => "answered", (error: Error) => error.message))
      .toBe(`GET /half-closed: the peer closed after ${HALF.length} bytes that are no whole answer`)
    // A close with no byte: the sentinel.
    mode = "a close"
    const closed = await exchange(port, "GET", "/closed", {}, "", 200)
    expect([closed.status, closed.body, closed.ms < 200]).toEqual([null, "", true])
    // A whole answer.
    mode = "whole"
    const whole = await exchange(port, "GET", "/whole", {}, "", 200)
    expect([whole.status, whole.body]).toEqual([200, "ok"])
    expect(peer.heads).toBe(5)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
