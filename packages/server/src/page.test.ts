// Tests of the page's routes R8 to R10 (page.ts; docs/host.md, section 7;
// lead, ec-3jrdd): the page and its policy, a new chat with its rate, a
// token with each refusal of its body and its chats, and the token that
// opens R2. Each case calls the routes through the gate (http.ts, `local`)
// with a request of the web's `Request` and Effect's `TestClock`, over a
// SQLite store in a temporary file. The cases on a real server are in
// serve.page.test.ts. The secret is made-up bytes.

import { afterAll, expect, test } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Logger, Option, Redacted, Scope } from "effect"
import { Base64Url } from "effect/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Chats, type Pick, StoreError } from "@everchat/core/store"
import { chatsLayer } from "@everchat/sqlite/bun"
import { ERRORS, jsonAnswer, makeGate } from "./http.ts"
import { DEFAULTS, type Limits } from "./limits.ts"
import { type LocalOptions, LocalRefused, PAGE, PAGE_BODY, type PageFind, pageRoutes, TOKEN_LIFE } from "./page.ts"
import { makeToken, verifyToken } from "./token.ts"

const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 3 * i + 5))

// Now: half a second into the second `S`.
const S = 1_800_000_000
const NOW = S * 1000 + 500

const AUTHORITY = "127.0.0.1:4681"
const ORIGIN = "http://127.0.0.1:4681"
const START = "0123456789abcdef0123456789abcdef"
const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }
const TENANT = "00000000-0000-4000-8000-000000000001"
const OTHER_TENANT = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
const LOCAL: LocalOptions = { start: START, tenant: TENANT, pick: PICK, authority: AUTHORITY }

// The log: each line that the tests' logger took.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])

// The store of this file: three chats of the local tenant, one of another.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-page-"))
const scope = Effect.runSync(Scope.make())
const store = await Effect.runPromise(Layer.buildWithScope(chatsLayer(path.join(home, "chats.db")), scope))
const sqlChats = Context.get(store, Chats)
const C1 = await Effect.runPromise(sqlChats.make(TENANT, PICK))
const C2 = await Effect.runPromise(sqlChats.make(TENANT, PICK))
const C3 = await Effect.runPromise(sqlChats.make(TENANT, PICK))
const FOREIGN = await Effect.runPromise(sqlChats.make(OTHER_TENANT, PICK))
// A UUID that no chat has.
const NONE = "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f"
afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  fs.rmSync(home, { recursive: true, force: true })
})

// A `Chats` over the store that counts its calls.
const counting = (overrides: Partial<typeof Chats.Service> = {}) => {
  const calls = { make: 0, reads: [] as Array<string> }
  const chats: typeof Chats.Service = {
    ...sqlChats,
    make: (tenant, pick) =>
      Effect.suspend(() => {
        calls.make += 1
        return (overrides.make ?? sqlChats.make)(tenant, pick)
      }),
    reads: (tenant, chat) =>
      Effect.suspend(() => {
        calls.reads.push(tenant + "/" + chat)
        return sqlChats.reads(tenant, chat)
      })
  }
  return { chats, calls }
}

// The page's routes over a gate with `authority`, with a count of the
// token maker's calls.
const pageOf = async (
  { limits = {} as Partial<Limits>, overrides = {} as Partial<typeof Chats.Service>, page = PAGE } = {}
) => {
  const used: Limits = { ...DEFAULTS, ...limits }
  const { chats, calls } = counting(overrides)
  const gate = makeGate({ secret: SECRET, origins: [ORIGIN], limits: used, chats, authority: AUTHORITY })
  const made = { count: 0 }
  const find = await Effect.runPromise(pageRoutes(LOCAL, {
    gate,
    chats,
    secret: SECRET,
    limits: used,
    makeToken: (secret, claims) =>
      Effect.suspend(() => {
        made.count += 1
        return makeToken(secret, claims)
      })
  }, page))
  return { gate, find, calls, made }
}

// An answer as the web sees it. Each answer has the three headers and no
// `access-control-allow-credentials`.
const seen = async (response: HttpServerResponse.HttpServerResponse) => {
  const web = HttpServerResponse.toWeb(response)
  const headers = Object.fromEntries(web.headers)
  expect(headers["cache-control"]).toBe("no-store")
  expect(headers["referrer-policy"]).toBe("no-referrer")
  expect(headers["x-content-type-options"]).toBe("nosniff")
  expect(headers["access-control-allow-credentials"]).toBeUndefined()
  return { status: web.status, headers, text: await web.text() }
}

const errorText = (code: keyof typeof ERRORS) => JSON.stringify({ error: code, message: ERRORS[code].message })

// Run at `at` on the test clock, with the tests' logger.
const run = <A, E>(effect: Effect.Effect<A, E>, at = NOW) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(at), effect).pipe(Effect.provide(Layer.merge(TestClock.layer(), capture))))

type Body = NonNullable<RequestInit["body"]>

// A request of the page's routes at `path` (under the start value), with
// the page's headers.
const ask = (
  find: PageFind,
  route: "" | "chats" | "token",
  { method = route === "" ? "GET" : "POST", body, headers = {}, at = NOW }: { method?: string; body?: Body; headers?: Record<string, string>; at?: number } = {}
) => {
  const handler = find("/" + START + "/" + route)
  if (handler === undefined) throw new Error("no page's route for this path")
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: { host: AUTHORITY, origin: ORIGIN, ...(route === "token" ? { "content-type": "application/json" } : {}), ...headers }
  }
  if (body !== undefined) {
    init.body = body
    init.duplex = "half"
  }
  const req = HttpServerRequest.fromWeb(new Request("http://127.0.0.1/" + START + "/" + route, init))
  return run(handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req)), at).then(seen)
}

const tokenBody = (chats: unknown) => JSON.stringify({ chats })

// The claims of a token, read from its middle part.
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8"))

// R8: the page
// ------------

test("(a) R8 answers the page's bytes with text/html, the three headers and the inspector's policy, whose script-src is the SHA-256 of the file's one script; with a listed origin it has its CORS headers", async () => {
  const { find } = await pageOf()
  const file = fs.readFileSync(path.join(import.meta.dir, "client.html"), "utf8")
  expect(PAGE).toBe(file)
  const script = /<script>([\s\S]*?)<\/script>/.exec(file)?.[1]
  expect(script).toBeDefined()
  const hash = new Bun.CryptoHasher("sha256").update(script!).digest("base64")
  const answer = await ask(find, "")
  expect(answer.status).toBe(200)
  expect(answer.text).toBe(file)
  expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8")
  expect(answer.headers["content-security-policy"]!.split("; ")).toEqual([
    "default-src 'none'",
    "script-src 'sha256-" + hash + "'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ])
  // No Origin: a person's click.
  const plain = await run(find("/" + START + "/")!.pipe(Effect.provideService(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request("http://127.0.0.1/" + START + "/", { headers: { host: AUTHORITY } }))
  ))).then(seen)
  expect([plain.status, plain.text === file, plain.headers["access-control-allow-origin"]]).toEqual([200, true, undefined])
  const listed = await ask(find, "")
  expect([listed.status, listed.headers["access-control-allow-origin"], listed.headers["vary"]]).toEqual([200, ORIGIN, "origin"])
})

test("(a) a page with no script, two scripts, a script with a src, or a script with no end fails the start with LocalRefused page; a start value of another form fails it with LocalRefused start", async () => {
  const gate = makeGate({ secret: SECRET, origins: [ORIGIN], limits: DEFAULTS, chats: sqlChats, authority: AUTHORITY })
  const start = (local: LocalOptions, page: string) =>
    Effect.runPromise(Effect.exit(pageRoutes(local, { gate, chats: sqlChats, secret: SECRET, limits: DEFAULTS }, page)))
  const reasonOf = (exit: Exit.Exit<unknown, LocalRefused>) =>
    Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.reason : "started"
  for (
    const page of [
      "<p>no script</p>",
      "<script>a()</script><script>b()</script>",
      "<script src=\"x.js\"></script>",
      "<SCRIPT SRC=x.js></SCRIPT>",
      "<script>a()</script><script src=\"x.js\"></script>",
      "<script>a()",
      "</script>a()<script>"
    ]
  ) {
    expect([page, reasonOf(await start(LOCAL, page))]).toEqual([page, "page"])
  }
  expect(reasonOf(await start(LOCAL, "<script>a()</script>"))).toBe("started")
  for (const value of [START.toUpperCase(), START.slice(1), START + "0", "g" + START.slice(1), "", "0123456789abcdef-123456789abcdef"]) {
    expect([value, reasonOf(await start({ ...LOCAL, start: value }, PAGE))]).toEqual([value, "start"])
  }
  // The error's text holds no value.
  expect(new LocalRefused({ reason: "start" }).message).not.toContain(START)
})

// R9: a new chat
// --------------

test("(b) R9 makes a chat of the local tenant with the pick, which Chats.reads finds for that tenant only; its body is read and not used, and one over 16,384 bytes is 413", async () => {
  const { find, calls } = await pageOf()
  const answer = await ask(find, "chats", { body: "{}" })
  expect(answer.status).toBe(200)
  const { chat } = JSON.parse(answer.text) as { chat: string }
  expect(Object.keys(JSON.parse(answer.text))).toEqual(["chat"])
  expect(chat).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const row = await Effect.runPromise(Effect.flatMap(sqlChats.reads(TENANT, chat), (reading) => reading.chat))
  expect([row.uuid, row.pick]).toEqual([chat, PICK])
  const elsewhere = await Effect.runPromise(Effect.exit(sqlChats.reads(OTHER_TENANT, chat)))
  expect(Exit.isFailure(elsewhere)).toBe(true)
  // A body of no JSON, and none: the same.
  expect((await ask(find, "chats", { body: "not json" })).status).toBe(200)
  expect((await ask(find, "chats")).status).toBe(200)
  expect((await ask(find, "chats", { body: new Uint8Array(PAGE_BODY).fill(97) })).status).toBe(200)
  expect(calls.make).toBe(4)
  const large = await ask(find, "chats", { body: new Uint8Array(PAGE_BODY + 1).fill(97) })
  expect([large.status, large.text, large.headers["connection"]]).toEqual([413, errorText("too_large"), "close"])
  expect(calls.make).toBe(4)
})

// A body that fails as it is read: `first` bytes, then the stream's error
// (a client that resets in the middle of its body); with no bytes, at once.
const broken = (first: number) => {
  let pulled = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      if (pulled === 1 && first > 0) controller.enqueue(new Uint8Array(first).fill(97))
      else controller.error(new Error("the client reset"))
    }
  })
}

test("(b) R9: a body whose read fails in its middle or at once is 400 bad_request with close, makes no chat, and has counted; a request with no stream, or with a content-length of 0, has no body and makes its chat", async () => {
  const { find, calls } = await pageOf({ limits: { newChats: 5 } })
  for (const first of [1_000, 0]) {
    const failed = await ask(find, "chats", { body: broken(first) })
    expect([first, failed.status, failed.text, failed.headers["connection"]]).toEqual([first, 400, errorText("bad_request"), "close"])
  }
  expect(calls.make).toBe(0)
  // No stream, and a length of 0 (its stream is not read).
  expect((await ask(find, "chats")).status).toBe(200)
  expect((await ask(find, "chats", { body: broken(0), headers: { "content-length": "0" } })).status).toBe(200)
  expect(calls.make).toBe(2)
  // The two failed reads counted: the window's 5 are used.
  expect((await ask(find, "chats")).status).toBe(200)
  expect((await ask(find, "chats")).status).toBe(429)
  expect(calls.make).toBe(3)
  expect(lines.join("\n")).not.toContain("the client reset")
})

test("(b) R9's rate: 10 in a window of a minute; the 11th is 429 with its seconds, rounded up (1 at 500 ms, 2 at 1,300 ms and at 1,500 ms before the window's end), 1 in its last millisecond; the window's end and a clock that steps back give a new window; a store's failure is 500 and has counted", async () => {
  const { find, calls } = await pageOf()
  for (let k = 0; k < 10; k++) expect((await ask(find, "chats")).status).toBe(200)
  const many = await ask(find, "chats")
  expect([many.status, many.headers["retry-after"], many.text]).toEqual([429, "60", errorText("too_many")])
  expect(calls.make).toBe(10)
  const late = await ask(find, "chats", { at: NOW + 59_999 })
  expect([late.status, late.headers["retry-after"]]).toEqual([429, "1"])
  // In the middle of a second of the window: rounded up. At 1,300 ms a
  // rounding to the nearest would give 1 (ec-6wsu1, 3).
  for (const [before, seconds] of [[500, "1"], [1_300, "2"], [1_500, "2"]] as const) {
    const mid = await ask(find, "chats", { at: NOW + 60_000 - before })
    expect([before, mid.status, mid.headers["retry-after"]]).toEqual([before, 429, seconds])
  }
  expect(calls.make).toBe(10)
  // The window's end: a new window from now.
  const next = NOW + 60_000
  for (let k = 0; k < 10; k++) expect((await ask(find, "chats", { at: next })).status).toBe(200)
  expect((await ask(find, "chats", { at: next + 1 })).status).toBe(429)
  // A clock before the window's start: a new window.
  expect((await ask(find, "chats", { at: next - 1 })).status).toBe(200)
  expect(calls.make).toBe(21)
  // A store's failure: 500 internal, and it counted.
  const failing = await pageOf({ limits: { newChats: 2 }, overrides: { make: () => Effect.fail(new StoreError({ op: "make", cause: new Error("the disk failed") })) } })
  const failed = await ask(failing.find, "chats")
  expect([failed.status, failed.text]).toEqual([500, errorText("internal")])
  expect((await ask(failing.find, "chats")).status).toBe(500)
  expect((await ask(failing.find, "chats")).status).toBe(429)
  expect(lines.join("\n")).not.toContain("the disk failed")
})

// R10: a token
// ------------

test("(c) R10 refuses each wrong body with its code, reads no chat for it and makes no token: 415, 413, and 400 for each form that is not one field chats of 1 to 64 lower-case UUIDs, none twice", async () => {
  const { find, calls, made } = await pageOf({ limits: { newTokens: 1_000 } })
  const many = Array.from({ length: 65 }, (_, i) => "00000000-0000-4000-8000-" + String(i).padStart(12, "0"))
  const cases: ReadonlyArray<readonly [string, { body?: Body; headers?: Record<string, string> }, keyof typeof ERRORS]> = [
    ["no content-type", { body: tokenBody([C1]), headers: { "content-type": "" } }, "unsupported_type"],
    ["text/plain", { body: tokenBody([C1]), headers: { "content-type": "text/plain" } }, "unsupported_type"],
    ["another charset", { body: tokenBody([C1]), headers: { "content-type": "application/json; charset=latin1" } }, "unsupported_type"],
    ["one byte over the bound", { body: tokenBody([C1]) + " ".repeat(PAGE_BODY + 1 - tokenBody([C1]).length) }, "too_large"],
    ["no JSON", { body: "chats" }, "bad_request"],
    ["no UTF-8", { body: new Uint8Array([0x7b, 0xff, 0x7d]) }, "bad_request"],
    ["no body", {}, "bad_request"],
    ["a list", { body: JSON.stringify([C1]) }, "bad_request"],
    ["no field", { body: "{}" }, "bad_request"],
    ["another field too", { body: JSON.stringify({ chats: [C1], tenant: TENANT }) }, "bad_request"],
    ["another name", { body: JSON.stringify({ Chats: [C1] }) }, "bad_request"],
    ["a text", { body: JSON.stringify({ chats: C1 }) }, "bad_request"],
    ["no chat", { body: tokenBody([]) }, "bad_request"],
    ["65 chats", { body: tokenBody(many) }, "bad_request"],
    ["a chat twice", { body: tokenBody([C1, C2, C1]) }, "bad_request"],
    ["upper case", { body: tokenBody([C1.toUpperCase()]) }, "bad_request"],
    ["no UUID", { body: tokenBody(["chat-one"]) }, "bad_request"],
    ["a number", { body: tokenBody([7]) }, "bad_request"],
    ["null", { body: "null" }, "bad_request"]
  ]
  for (const [name, init, code] of cases) {
    const answer = await ask(find, "token", init)
    expect([name, answer.status, answer.text]).toEqual([name, ERRORS[code].status, errorText(code)])
  }
  expect(calls.reads).toEqual([])
  expect(made.count).toBe(0)
})

test("(c) R10: a chat of another tenant, a chat that is not there, and either beside the tenant's own get 404 no_chat, and no token is made", async () => {
  const { find, made } = await pageOf()
  for (const chats of [[FOREIGN], [NONE], [C1, FOREIGN], [NONE, C1, C2]]) {
    const answer = await ask(find, "token", { body: tokenBody(chats) })
    expect([chats, answer.status, answer.text]).toEqual([chats, 404, errorText("no_chat")])
  }
  expect(made.count).toBe(0)
  // B's chat stays B's: it was found for no tenant but its own.
  expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(sqlChats.reads(OTHER_TENANT, FOREIGN))))).toBe(true)
})

test("(c) R10 gives a token of the local tenant for the body's chats with exp 600 s from Effect's Clock in whole seconds; it passes verifyToken at that instant; 64 chats pass", async () => {
  const { find, calls, made } = await pageOf()
  const answer = await ask(find, "token", { body: tokenBody([C1, C2]) })
  expect(answer.status).toBe(200)
  const body = JSON.parse(answer.text) as { token: string; exp: number }
  expect(Object.keys(body)).toEqual(["token", "exp"])
  expect(body.exp).toBe(S + TOKEN_LIFE)
  expect(TOKEN_LIFE).toBe(600)
  expect(claimsOf(body.token)).toEqual({ tenant: TENANT, chats: [C1, C2], exp: S + 600 })
  const verified = await run(verifyToken(SECRET, body.token, NOW))
  expect(verified).toEqual({ tenant: TENANT, chats: [C1, C2], exp: S + 600 })
  expect(calls.reads).toEqual([TENANT + "/" + C1, TENANT + "/" + C2])
  expect(made.count).toBe(1)
  // 64 chats of the tenant.
  const all = [C1, C2, C3]
  while (all.length < 64) all.push(await Effect.runPromise(sqlChats.make(TENANT, PICK)))
  const wide = await ask(find, "token", { body: tokenBody(all) })
  expect(wide.status).toBe(200)
  expect(claimsOf((JSON.parse(wide.text) as { token: string }).token).chats).toEqual(all)
})

test("(c) R10's rate: 60 in a minute; the 61st is 429 with its seconds, rounded up (1 at 500 ms, 2 at 1,300 ms and at 1,500 ms before the window's end), before its body's checks; a refused body counted too", async () => {
  const { find, made } = await pageOf()
  for (let k = 0; k < 59; k++) expect((await ask(find, "token", { body: tokenBody([C1]) })).status).toBe(200)
  expect((await ask(find, "token", { body: "no json" })).status).toBe(400)
  const many = await ask(find, "token", { body: "no json" })
  expect([many.status, many.headers["retry-after"], many.text]).toEqual([429, "60", errorText("too_many")])
  expect((await ask(find, "token", { body: tokenBody([C1]), at: NOW + 30_000 })).headers["retry-after"]).toBe("30")
  for (const [before, seconds] of [[500, "1"], [1_300, "2"], [1_500, "2"]] as const) {
    const mid = await ask(find, "token", { body: tokenBody([C1]), at: NOW + 60_000 - before })
    expect([before, mid.status, mid.headers["retry-after"]]).toEqual([before, 429, seconds])
  }
  expect(made.count).toBe(59)
  expect((await ask(find, "token", { body: tokenBody([C1]), at: NOW + 60_000 })).status).toBe(200)
})

test("(d) R10's token opens R2 for each of its chats at that instant, and not for another chat of the tenant", async () => {
  const { gate, find } = await pageOf()
  const { token } = JSON.parse((await ask(find, "token", { body: tokenBody([C1, C2]) })).text) as { token: string }
  const r2 = (chat: string) =>
    run(gate.route("R2", chat, (found) => Effect.succeed(jsonAnswer({ chat: found.chat, tenant: found.tenant }))).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://127.0.0.1/v1/chats/" + chat, { headers: { host: AUTHORITY, authorization: "Bearer " + token } }))
      )
    )).then(seen)
  for (const chat of [C1, C2]) {
    const answer = await r2(chat)
    expect([answer.status, JSON.parse(answer.text)]).toEqual([200, { chat, tenant: TENANT }])
  }
  for (const chat of [C3, FOREIGN]) {
    const answer = await r2(chat)
    expect([chat, answer.status, answer.text]).toEqual([chat, 404, errorText("no_chat")])
  }
})

test("no line of this file's log holds the start value, a token, a body or the secret", async () => {
  const { find } = await pageOf()
  const { token } = JSON.parse((await ask(find, "token", { body: tokenBody([C1]) })).text) as { token: string }
  await ask(find, "token", { body: JSON.stringify({ chats: ["bodyvalue1234"] }) })
  await ask(find, "chats", { body: "bodyvalue1234" })
  const all = lines.join("\n")
  expect(lines.length).toBeGreaterThan(0)
  for (const secret of [START, token, ...token.split("."), "bodyvalue1234", C1, Base64Url.encode(Redacted.value(SECRET))]) {
    expect([secret.slice(0, 12), all.includes(secret)]).toEqual([secret.slice(0, 12), false])
  }
})
