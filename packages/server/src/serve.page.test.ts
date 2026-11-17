// Tests of `serve`'s second argument (serve.ts; page.ts; docs/host.md,
// section 7; lead, ec-3jrdd): the page's routes R8 to R10 under the start
// value on a real Bun server, their paths and methods, the check of `Host`
// on every route, the layer with no second argument, a start value of a
// wrong form, the log, and the page's routes at the layer's end. Each case
// serves the routes on a Bun server built with `serverOptions`, over a real
// SQLite file and the tests' fake wire, at 127.0.0.1 and a port that the
// system picks.

import { expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Context, Deferred, Effect, Exit, Layer, Logger, Redacted, Scope } from "effect"
import { HttpServer } from "effect/http"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { head as makeHead } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request as Asked } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import { ERRORS } from "./http.ts"
import { type LocalOptions, LocalRefused, serve, serverOptions } from "./index.ts"
import { makeToken } from "./token.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 5 * i + 2))
const TENANT = "00000000-0000-4000-8000-000000000001"
const START = "fedcba9876543210fedcba9876543210"
const BUSY = JSON.stringify({ error: "busy", message: ERRORS.busy.message })
const FORBIDDEN = JSON.stringify({ error: "forbidden_origin", message: ERRORS.forbidden_origin.message })

// The stack of a loaded chat: the turn loop over a fake wire that says a line.
const stack = (store: typeof Store.Service) => {
  const wire = fakeWire((asked: Asked): Reply => reply(asked, { text: "A reply.", output: [{ type: "message", content: [{ type: "output_text", text: "A reply." }] }] }))
  const memory = Memory.layer.pipe(Layer.provideMerge(Layer.succeed(Store, store)), Layer.provide(compactor(() => "a summary")))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.succeed({ output: "2", failed: false }) }))
  return Turns.layer({ head: makeHead(HOSTED) }).pipe(
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), hostedLayer(HOSTED).pipe(Layer.provide(memory))))
  )
}

// The log of the file, as JSON lines; the gate's lines from `from` on.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])
const gateLines = (from: number) => lines.slice(from).filter((line) => line.includes("the gate's answer")).length

interface Served {
  readonly port: number
  readonly base: string // http://127.0.0.1:<port>
  readonly origin: string // the host's own origin
  readonly chat: string // a chat of the local tenant
  // The next `Chats.store` (a load's) waits first for this, with no
  // interruption: it holds the loader's end.
  hold: Effect.Effect<void> | undefined
  opens: number
  readonly end: () => Promise<void>
  readonly close: () => Promise<void>
}

// `serve` on a Bun server, with the page's routes when `local` is not
// false; the origins are the host's own.
const served = async (local: boolean | Partial<LocalOptions> = true): Promise<Served> => {
  const file = newFile()
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(Effect.gen(function*() {
    const real = Context.get(yield* Layer.buildWithScope(chatsLayer(file), scope), Chats)
    const server = yield* Layer.buildWithScope(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...serverOptions() }), scope)
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
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
    const options: LocalOptions = { start: START, tenant: TENANT, pick: PICK, authority: "127.0.0.1:" + port, ...(typeof local === "object" ? local : {}) }
    yield* Layer.buildWithScope(
      serve({ stack, launch: LAUNCH, secret: SECRET, origins: ["http://127.0.0.1:" + port] }, local === false ? undefined : options).pipe(
        Layer.provide(Layer.succeed(Chats, gated)),
        Layer.provide(Layer.succeedContext(server))
      ),
      own
    )
    return { port, own, chat: yield* real.make(TENANT, PICK) }
  }).pipe(
    Effect.provide(capture),
    // A layer that fails at its start: its scope ends here, with the server.
    Effect.tapError(() => Scope.close(scope, Exit.void))
  ))
  const s: Served = {
    port: built.port,
    base: "http://127.0.0.1:" + built.port,
    origin: "http://127.0.0.1:" + built.port,
    chat: built.chat,
    hold: undefined,
    opens: 0,
    end: () => Effect.runPromise(Scope.close(built.own, Exit.void)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
  return s
}

// Raw bytes to the port: the answer's status line and its whole text.
const raw = (port: number, text: string) =>
  new Promise<{ status: string; text: string }>((resolve) => {
    let got = ""
    let done = false
    const end = () => {
      if (done) return
      done = true
      resolve({ status: got.split("\r\n")[0] ?? "", text: got })
    }
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(text)
        },
        data(_socket, data) {
          got += new TextDecoder().decode(data)
          // One answer is enough: its body is short.
          if (/\r\n\r\n/.test(got) && (/content-length: 0\r\n/i.test(got) || got.endsWith("}") || got.endsWith("</html>\n"))) end()
        },
        close: end,
        error: end
      }
    }).then((socket) =>
      setTimeout(() => {
        end()
        socket.end()
      }, 1_000)
    )
  })

// A request's head as raw text, with `Connection: close`.
const head = (method: string, target: string, headers: Record<string, string>) =>
  method + " " + target + " HTTP/1.1\r\n" + Object.entries(headers).map(([name, value]) => name + ": " + value + "\r\n").join("") + "Connection: close\r\n\r\n"

// R10 over fetch: a token for `chats`.
const tokenOf = async (s: Served, chats: ReadonlyArray<string>) => {
  const answer = await fetch(s.base + "/" + START + "/token", {
    method: "POST",
    headers: { origin: s.origin, "content-type": "application/json" },
    body: JSON.stringify({ chats })
  })
  expect(answer.status).toBe(200)
  return (await answer.json() as { token: string }).token
}

test("(e) R8, R9 and R10 answer on a real server, each by its own method alone; /<start>, /<start>/x, upper case, a wrong start value of the same length and of another length, and //<start>/ get the 404 of no route", async () => {
  const s = await served()
  try {
    const page = await fetch(s.base + "/" + START + "/")
    expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"])
    expect(page.headers.get("content-security-policy")).toContain("script-src 'sha256-")
    expect(await page.text()).toContain("<script>")
    // R9 with no body, as the page sends it.
    const chat = await fetch(s.base + "/" + START + "/chats", { method: "POST", headers: { origin: s.origin } })
    expect(chat.status).toBe(200)
    const made = (await chat.json() as { chat: string }).chat
    const token = await tokenOf(s, [made, s.chat])
    // R10's token opens R2 for its chat on the same server.
    const r2 = await fetch(s.base + "/v1/chats/" + made, { headers: { authorization: "Bearer " + token } })
    expect(r2.status).toBe(200)
    // Each other method gets the 404 of no route, with no body.
    for (
      const [method, part] of [
        ["POST", ""],
        ["HEAD", ""],
        ["PUT", ""],
        ["GET", "chats"],
        ["OPTIONS", "chats"],
        ["DELETE", "chats"],
        ["GET", "token"],
        ["OPTIONS", "token"]
      ] as const
    ) {
      const answer = await fetch(s.base + "/" + START + "/" + part, { method, headers: { origin: s.origin } })
      expect([method, part, answer.status, await answer.text()]).toEqual([method, part, 404, ""])
    }
    // No route: by raw targets, as they came.
    const wrong = START.slice(0, 31) + (START.endsWith("0") ? "1" : "0")
    const nine = START.slice(0, 8) + "0".repeat(24)
    for (
      const target of [
        "/" + START,
        "/" + START + "/x",
        "/" + START + "/chats/",
        "/" + START.toUpperCase() + "/",
        "/" + wrong + "/",
        "/" + nine + "/",
        "/" + START.slice(0, 31) + "/",
        "/" + START + "0/",
        "//" + START + "/",
        "/" + START + "//"
      ]
    ) {
      const answer = await raw(s.port, head("GET", target, { host: "127.0.0.1:" + s.port }))
      expect([target, answer.status, /content-length: 0\r\n/i.test(answer.text)]).toEqual([target, "HTTP/1.1 404 Not Found", true])
    }
  } finally {
    await s.close()
  }
})

test("(f) a wrong Host gets 403 forbidden_origin on R1 to R10 and on a path that is no route; R9 and R10 with no Origin get the 403", async () => {
  const s = await served()
  try {
    const token = await tokenOf(s, [s.chat])
    const chat = "/v1/chats/" + s.chat
    const bearer = { authorization: "Bearer " + token }
    const requests: ReadonlyArray<readonly [string, string, string, Record<string, string>]> = [
      ["R1", "POST", chat + "/messages", { ...bearer, "content-type": "application/json", "content-length": "2" }],
      ["R2", "GET", chat, bearer],
      ["R3", "GET", chat + "/messages", bearer],
      ["R4", "GET", chat + "/events", { ...bearer, accept: "text/event-stream" }],
      ["R5", "GET", chat + "/events", bearer],
      ["R6", "GET", chat + "/socket", { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" }],
      ["R7", "OPTIONS", chat, { origin: s.origin, "access-control-request-method": "GET" }],
      ["R8", "GET", "/" + START + "/", {}],
      ["R9", "POST", "/" + START + "/chats", { origin: s.origin, "content-length": "0" }],
      ["R10", "POST", "/" + START + "/token", { origin: s.origin, "content-type": "application/json", "content-length": "2" }],
      ["none", "GET", "/nothing/here", {}]
    ]
    for (const host of ["localhost:" + s.port, "evil.example:" + s.port, "127.0.0.1:" + (s.port + 1), "127.0.0.1"]) {
      for (const [name, method, target, headers] of requests) {
        const text = head(method, target, { host, ...headers }).replace("Connection: close\r\n\r\n", "Connection: close\r\n\r\n" + (headers["content-length"] === "2" ? "{}" : ""))
        const answer = await raw(s.port, text)
        expect([host, name, answer.status, answer.text.endsWith(FORBIDDEN)]).toEqual([host, name, "HTTP/1.1 403 Forbidden", true])
        expect(/access-control-allow-origin/i.test(answer.text)).toBe(false)
      }
    }
    // The right Host on each: no 403 (R1's body `{}` is a 400).
    for (const [name, method, target, headers] of requests) {
      if (name === "R4" || name === "R6") continue
      const text = head(method, target, { host: "127.0.0.1:" + s.port, ...headers }).replace("Connection: close\r\n\r\n", "Connection: close\r\n\r\n" + (headers["content-length"] === "2" ? "{}" : ""))
      const answer = await raw(s.port, text)
      expect([name, answer.status === "HTTP/1.1 403 Forbidden"]).toEqual([name, false])
    }
    // R9 and R10 with no Origin, and one off the list.
    for (const origin of [undefined, "https://evil.example", "http://localhost:" + s.port]) {
      for (const part of ["chats", "token"]) {
        const answer = await fetch(s.base + "/" + START + "/" + part, {
          method: "POST",
          headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
          body: JSON.stringify({ chats: [s.chat] })
        })
        expect([origin ?? "none", part, answer.status, await answer.text()]).toEqual([origin ?? "none", part, 403, FORBIDDEN])
      }
    }
  } finally {
    await s.close()
  }
})

test("(g) with no second argument the paths of R8 to R10 are no route, and a wrong Host changes nothing", async () => {
  const s = await served(false)
  try {
    for (const [method, part] of [["GET", ""], ["POST", "chats"], ["POST", "token"]] as const) {
      const answer = await fetch(s.base + "/" + START + "/" + part, {
        method,
        headers: { origin: s.origin, "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({ chats: [s.chat] })
      })
      expect([part, answer.status, await answer.text()]).toEqual([part, 404, ""])
    }
    const token = await Effect.runPromise(Effect.orDie(makeToken(SECRET, { tenant: TENANT, chats: [s.chat], exp: Math.floor(Date.now() / 1000) + 600 })))
    const r2 = await raw(s.port, head("GET", "/v1/chats/" + s.chat, { host: "localhost:" + s.port, authorization: "Bearer " + token }))
    expect(r2.status).toBe("HTTP/1.1 200 OK")
    const none = await raw(s.port, head("GET", "/nothing", { host: "evil.example" }))
    expect(none.status).toBe("HTTP/1.1 404 Not Found")
  } finally {
    await s.close()
  }
})

test("(h) a start value of a wrong form fails the layer at its start with LocalRefused start, and its text holds no value", async () => {
  for (const start of [START.toUpperCase(), START.slice(2), START + "00", "z".repeat(32)]) {
    const found = await served({ start }).then(async (s) => {
      await s.close()
      return "served"
    }, (error: unknown) => error)
    expect([start, found instanceof LocalRefused ? found.reason : String(found)]).toEqual([start, "start"])
    expect((found as LocalRefused).message).not.toContain(start)
  }
})

test("(j) the page's routes at the layer's end: after the mark, R8, R9 and R10 get serve's 503 busy with retry-after 1, with no gate line", async () => {
  const s = await served()
  const gate = Effect.runSync(Deferred.make<void>())
  try {
    const token = await tokenOf(s, [s.chat])
    // A load of a cold chat that the end cannot stop until the gate opens.
    s.hold = Effect.uninterruptible(Deferred.await(gate))
    const opens = s.opens
    const loading = fetch(s.base + "/v1/chats/" + s.chat + "/messages", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ text: "cold" })
    }).then((response) => response.status, () => null)
    const until = Date.now() + 2_000
    while (s.opens === opens && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(s.opens).toBeGreaterThan(opens)
    const ending = s.end()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const from = lines.length
    const answers = await Promise.all([
      fetch(s.base + "/" + START + "/"),
      fetch(s.base + "/" + START + "/chats", { method: "POST", headers: { origin: s.origin } }),
      fetch(s.base + "/" + START + "/token", { method: "POST", headers: { origin: s.origin, "content-type": "application/json" }, body: JSON.stringify({ chats: [s.chat] }) })
    ])
    const seen = await Promise.all(answers.map(async (answer) => [answer.status, answer.headers.get("retry-after"), await answer.text()]))
    expect(seen).toEqual([[503, "1", BUSY], [503, "1", BUSY], [503, "1", BUSY]])
    expect(gateLines(from)).toBe(0)
    Effect.runSync(Deferred.succeed(gate, undefined))
    await ending
    await loading
  } finally {
    Effect.runSync(Deferred.succeed(gate, undefined))
    await s.close()
  }
})

test("(i) no log line of the cases holds the start value, a token or a body", async () => {
  const s = await served()
  let token = ""
  try {
    token = await tokenOf(s, [s.chat])
    await fetch(s.base + "/" + START + "/token", { method: "POST", headers: { origin: s.origin, "content-type": "application/json" }, body: "bodyvalue1234" })
    await fetch(s.base + "/" + START + "/chats", { method: "POST", headers: { origin: s.origin }, body: "bodyvalue1234" })
    await fetch(s.base + "/" + START + "/token?q=queryvalue1234", { method: "POST", headers: { origin: "https://evil.example" }, body: "bodyvalue1234" })
  } finally {
    await s.close()
  }
  const all = lines.join("\n")
  expect(lines.length).toBeGreaterThan(0)
  for (const secret of [START, START.toUpperCase(), token, ...token.split("."), "bodyvalue1234", "queryvalue1234", "evil.example"]) {
    expect([secret.slice(0, 12), all.includes(secret)]).toEqual([secret.slice(0, 12), false])
  }
})
