// Tests of the gate for the local command (http.ts; docs/host.md, section 7:
// "127.0.0.1 only", "The start value and the page's routes"; lead, ec-g3gkl):
// the check of the header `Host` with `authority`, on each member that takes a
// place, and the member `local` of the page's routes R8 to R10, its order, its
// origin, its deadline, its body's bound, its failures, an interruption at
// each of its steps, and the log. The cases follow the helpers of
// http.test.ts: a request of the web's `Request` and Effect's `TestClock`;
// one case runs a Bun server on 127.0.0.1, on a port that the system picks.
// The secret is made-up bytes.

import { afterAll, expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Redacted, Scheduler, Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Chats, type Pick } from "@everchat/core/store"
import { chatsLayer } from "@everchat/sqlite/bun"
import { ERRORS, type Gate, jsonAnswer, type Local, makeGate, type PageRoute, Refused, type Route } from "./http.ts"
import { DEFAULTS, type Limits } from "./limits.ts"
import { makeToken } from "./token.ts"

const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => i + 11))

// Now: half a second into the second `S`.
const S = 1_800_000_000
const NOW = S * 1000 + 500

// The local command's authority and origin, at a made-up port.
const AUTHORITY = "127.0.0.1:4681"
const ORIGIN = "http://127.0.0.1:4681"
// An authority with letters, for the letter case.
const NAMED = "Host.test:4681"
const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }

// Each wrong `Host` of ruling 1, for its authority: another letter case,
// another port, no port, a name that points at 127.0.0.1, `localhost`, two
// values, none.
const WRONG: ReadonlyArray<readonly [authority: string, host: string | undefined]> = [
  [AUTHORITY, "127.0.0.1:4682"],
  [AUTHORITY, "127.0.0.1"],
  [AUTHORITY, "127.0.0.1:04681"],
  [AUTHORITY, "evil.example:4681"],
  [AUTHORITY, "localhost:4681"],
  [AUTHORITY, "localhost"],
  [AUTHORITY, "[::1]:4681"],
  [AUTHORITY, AUTHORITY + ", " + AUTHORITY],
  [AUTHORITY, undefined],
  [NAMED, "host.test:4681"],
  [NAMED, "HOST.TEST:4681"],
  [NAMED, "Host.test:4682"],
  [NAMED, undefined]
]

// The log: each line that the tests' logger took, as JSON with its
// annotations.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])
const parsed = () => lines.map((line) => JSON.parse(line) as { annotations: Record<string, unknown> })

// The SQLite store of this file: one tenant with one chat, for the routes'
// checks when the `Host` passes.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-http-local-"))
const scope = Effect.runSync(Scope.make())
const store = await Effect.runPromise(Layer.buildWithScope(chatsLayer(path.join(home, "chats.db")), scope))
const sqlChats = Context.get(store, Chats)
const TENANT = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c"
const CHAT = await Effect.runPromise(sqlChats.make(TENANT, PICK))
afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  fs.rmSync(home, { recursive: true, force: true })
})

const TOKEN = await Effect.runPromise(
  Effect.andThen(TestClock.setTime(NOW), makeToken(SECRET, { tenant: TENANT, chats: [CHAT], exp: S + 600 })).pipe(Effect.provide(TestClock.layer()))
)

// A `Chats` over the store that counts its reads.
const counting = () => {
  const calls = { count: 0 }
  const chats: typeof Chats.Service = {
    ...sqlChats,
    reads: (tenant, chat) =>
      Effect.suspend(() => {
        calls.count += 1
        return sqlChats.reads(tenant, chat)
      })
  }
  return { chats, calls }
}

// A gate with `authority` (null: none).
const gateOf = (
  { authority = AUTHORITY as string | null, limits = {} as Partial<Limits>, chats = sqlChats as typeof Chats.Service } = {}
) =>
  makeGate({
    secret: SECRET,
    origins: [ORIGIN],
    limits: { ...DEFAULTS, ...limits },
    chats,
    ...(authority === null ? {} : { authority })
  })

// Requests and answers
// --------------------

const request = (url: string, init: RequestInit & { duplex?: "half" } = {}) =>
  HttpServerRequest.fromWeb(new Request("http://127.0.0.1" + url, init))

// Headers with a `Host` (undefined: none).
const withHost = (host: string | undefined, headers: Record<string, string> = {}) =>
  host === undefined ? headers : { host, ...headers }

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

// Run with the test clock at NOW and the tests' logger.
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(NOW), effect).pipe(Effect.provide(Layer.merge(TestClock.layer(), capture))))

// Let forked fibers run to their waits.
const settle = Effect.repeat(Effect.yieldNow, { times: 50 })

const errorText = (code: keyof typeof ERRORS) => JSON.stringify({ error: code, message: ERRORS[code].message })

// The page's routes' paths, under a made-up start value.
const START = "0123456789abcdef0123456789abcdef"
const PAGE_PATHS: Record<PageRoute, string> = { R8: "/" + START + "/", R9: "/" + START + "/chats", R10: "/" + START + "/token" }
const PAGE_METHODS: Record<PageRoute, string> = { R8: "GET", R9: "POST", R10: "POST" }

// A page's route with the request `req`.
const paged = (
  gate: Gate,
  name: PageRoute,
  req: HttpServerRequest.HttpServerRequest,
  work: (local: Local) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>
) => gate.local(name, work).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))

// A request of a page's route.
const pageRequest = (
  name: PageRoute,
  headers: Record<string, string>,
  { method = PAGE_METHODS[name], body }: { method?: string; body?: NonNullable<RequestInit["body"]> } = {}
) => request(PAGE_PATHS[name], body === undefined ? { method, headers } : { method, headers, body, duplex: "half" })

// The members of the gate that take a place
// ------------------------------------------

// Each member, with its method, another method, the headers that it needs,
// the log's name and its answer when every check passes.
interface Member {
  readonly name: string
  readonly path: string
  readonly method: string
  readonly other: string
  readonly extra: Record<string, string>
  readonly passes: number
  readonly call: (gate: Gate, req: HttpServerRequest.HttpServerRequest, work: Effect.Effect<HttpServerResponse.HttpServerResponse>) => Effect.Effect<HttpServerResponse.HttpServerResponse>
}

const ROUTE_METHODS: Record<Route, string> = { R1: "POST", R2: "GET", R3: "GET", R4: "GET", R5: "GET" }

const MEMBERS: ReadonlyArray<Member> = [
  ...(["R1", "R2", "R3", "R4", "R5"] as const).map((name): Member => ({
    name,
    path: "/v1/chats/" + CHAT,
    method: ROUTE_METHODS[name],
    other: ROUTE_METHODS[name] === "GET" ? "POST" : "GET",
    extra: {},
    passes: 200,
    call: (gate, req, work) => gate.route(name, CHAT, () => work).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))
  })),
  {
    name: "none",
    path: "/v1/nothing",
    method: "GET",
    other: "DELETE",
    extra: {},
    passes: 404,
    call: (gate, req) => gate.none.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))
  },
  {
    name: "R6",
    path: "/v1/chats/" + CHAT + "/socket",
    method: "GET",
    other: "POST",
    extra: { upgrade: "websocket" },
    passes: 200,
    call: (gate, req, work) => gate.socket(CHAT, () => work).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))
  },
  {
    name: "R7",
    path: "/v1/chats/" + CHAT,
    method: "OPTIONS",
    other: "GET",
    extra: {},
    passes: 204,
    call: (gate, req) => gate.preflight.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))
  },
  ...(["R8", "R9", "R10"] as const).map((name): Member => ({
    name,
    path: PAGE_PATHS[name],
    method: PAGE_METHODS[name],
    other: PAGE_METHODS[name] === "GET" ? "POST" : "GET",
    extra: {},
    passes: 200,
    call: (gate, req, work) => paged(gate, name, req, () => work)
  }))
]

// A request to a member: `good` (its method, a listed origin, a good token)
// or `bad` (another method, an origin off the list, a bad token).
const memberRequest = (member: Member, host: string | undefined, kind: "good" | "bad") =>
  request(member.path, {
    method: kind === "good" ? member.method : member.other,
    headers: withHost(host, {
      ...member.extra,
      origin: kind === "good" ? ORIGIN : "https://evil.example",
      authorization: kind === "good" ? "Bearer " + TOKEN : "Bearer bad.token"
    })
  })

// A work that counts its runs.
const worker = () => {
  const runs = { count: 0 }
  const work = Effect.sync(() => {
    runs.count += 1
    return jsonAnswer({ worked: true })
  })
  return { runs, work }
}

// The last line of the log.
const lastLine = () => parsed().at(-1)?.annotations

test("(a) with `authority`, each wrong Host gets 403 forbidden_origin with no CORS header on R1 to R5, none, the socket, the preflight and R8 to R10, with no check and no work after it and its place given back: a good request and one with a bad token, an origin off the list and a wrong method alike; the right Host passes", async () => {
  const failures: Array<unknown> = []
  for (const member of MEMBERS) {
    for (const [authority, host] of WRONG) {
      for (const kind of ["good", "bad"] as const) {
        const { chats, calls } = counting()
        const gate = gateOf({ authority, chats })
        const { runs, work } = worker()
        const from = lines.length
        const answer = await seen(await run(member.call(gate, memberRequest(member, host, kind), work)))
        const got = {
          status: answer.status,
          text: answer.text,
          cors: answer.headers["access-control-allow-origin"] ?? null,
          vary: answer.headers["vary"] ?? null,
          worked: runs.count,
          reads: calls.count,
          inFlight: gate.inFlight(),
          log: parsed().slice(from).map((line) => line.annotations)
        }
        const want = {
          status: 403,
          text: errorText("forbidden_origin"),
          cors: null,
          vary: null,
          worked: 0,
          reads: 0,
          inFlight: 0,
          log: [{ route: member.name, status: 403, error: "forbidden_origin" }]
        }
        if (JSON.stringify(got) !== JSON.stringify(want)) failures.push({ member: member.name, authority, host, kind, got })
      }
    }
    // The right Host passes: the member's own answer, with the origin's
    // headers but for `none`.
    for (const authority of [AUTHORITY, NAMED]) {
      const gate = gateOf({ authority })
      const { runs, work } = worker()
      const answer = await seen(await run(member.call(gate, memberRequest(member, authority, "good"), work)))
      const want = member.passes === 200 ? 1 : 0
      if (answer.status !== member.passes || runs.count !== want || gate.inFlight() !== 0) {
        failures.push({ member: member.name, authority, right: answer.status, worked: runs.count })
      }
      if (member.name !== "none" && answer.headers["access-control-allow-origin"] !== ORIGIN) failures.push({ member: member.name, cors: answer.headers })
    }
  }
  expect(failures).toEqual([])
})

test("(a) with no `authority` a wrong Host changes nothing: each member gives its own answer", async () => {
  const failures: Array<unknown> = []
  for (const member of MEMBERS) {
    for (const [, host] of WRONG) {
      const gate = gateOf({ authority: null })
      const { runs, work } = worker()
      const answer = await seen(await run(member.call(gate, memberRequest(member, host, "good"), work)))
      if (answer.status !== member.passes || runs.count !== (member.passes === 200 ? 1 : 0)) failures.push({ member: member.name, host, status: answer.status })
    }
  }
  expect(failures).toEqual([])
})

// A local work that holds its place until `latch` is done.
const holder = (gate: Gate) =>
  Effect.gen(function*() {
    const latch = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(paged(gate, "R8", pageRequest("R8", { host: AUTHORITY }), () =>
      Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(latch), jsonAnswer({})))))
    yield* Deferred.await(started)
    return { release: Effect.andThen(Deferred.succeed(latch, undefined), Fiber.join(fiber)) }
  })

test("(a) the Host is checked after the place: with every place taken, each member with a wrong Host gets 503 busy with retry-after 1", async () => {
  const gate = gateOf({ limits: { requests: 1 } })
  await run(Effect.gen(function*() {
    const held = yield* holder(gate)
    expect(gate.inFlight()).toBe(1)
    const failures: Array<unknown> = []
    for (const member of MEMBERS) {
      for (const [, host] of WRONG.filter(([authority]) => authority === AUTHORITY)) {
        const { work } = worker()
        const answer = yield* Effect.promise(async () => seen(await run(member.call(gate, memberRequest(member, host, "bad"), work))))
        if (answer.status !== 503 || answer.headers["retry-after"] !== "1" || answer.text !== errorText("busy")) {
          failures.push({ member: member.name, host, status: answer.status })
        }
      }
    }
    expect(failures).toEqual([])
    expect((yield* held.release).status).toBe(200)
    expect(gate.inFlight()).toBe(0)
  }))
})

// The page's routes
// -----------------

test("(b) local's order, step by step: the place before the Host, the Host before the method, the method before the origin, the origin before the work", async () => {
  const gate = gateOf({ limits: { requests: 1 } })
  for (const name of ["R8", "R9", "R10"] as const) {
    const other = PAGE_METHODS[name] === "GET" ? "POST" : "GET"
    const { runs, work } = worker()
    const ask = (headers: Record<string, string>, method?: string) =>
      run(paged(gate, name, pageRequest(name, headers, method === undefined ? {} : { method }), () => work)).then(seen)
    const evil = { origin: "https://evil.example" }
    await run(Effect.gen(function*() {
      // 1. No place: busy, before a wrong Host, a wrong method and a bad origin.
      const held = yield* holder(gate)
      expect((yield* Effect.promise(() => ask(withHost("localhost:4681", evil), other))).status).toBe(503)
      yield* held.release
    }))
    // 2. The Host before the method and the origin: 403, not the 404 of a
    // wrong method.
    const host = await ask(withHost("localhost:4681", evil), other)
    expect([host.status, host.text]).toEqual([403, errorText("forbidden_origin")])
    expect(lastLine()).toEqual({ route: name, status: 403, error: "forbidden_origin" })
    // 3. The method before the origin: 404 with no body and no CORS header,
    // also for an origin off the list and for none.
    for (const headers of [{ host: AUTHORITY, ...evil }, { host: AUTHORITY }]) {
      const method = await ask(headers, other)
      expect([method.status, method.text, method.headers["access-control-allow-origin"]]).toEqual([404, "", undefined])
      expect(lastLine()).toEqual({ route: name, status: 404 })
    }
    // 4. The origin before the work.
    const origin = await ask({ host: AUTHORITY, ...evil })
    expect([origin.status, origin.text, origin.headers["access-control-allow-origin"]]).toEqual([403, errorText("forbidden_origin"), undefined])
    expect(runs.count).toBe(0)
    // 5. The work.
    const passed = await ask({ host: AUTHORITY, origin: ORIGIN })
    expect([passed.status, passed.headers["access-control-allow-origin"], passed.headers["vary"]]).toEqual([200, ORIGIN, "origin"])
    expect(runs.count).toBe(1)
    expect(gate.inFlight()).toBe(0)
  }
})

test("(c) R9 and R10 with no Origin and with one off the list get 403 forbidden_origin and run no work; R8 with none runs its work, with no CORS header; a header Authorization changes nothing", async () => {
  const gate = gateOf()
  const { runs, work } = worker()
  for (const name of ["R9", "R10"] as const) {
    for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }, { origin: ORIGIN.toUpperCase() }, { origin: "http://localhost:4681" }]) {
      const from = lines.length
      const answer = await seen(await run(paged(gate, name, pageRequest(name, { host: AUTHORITY, ...headers }), () => work)))
      expect([name, answer.status, answer.text, answer.headers["access-control-allow-origin"]]).toEqual([name, 403, errorText("forbidden_origin"), undefined])
      expect(parsed().slice(from).map((line) => line.annotations)).toEqual([{ route: name, status: 403, error: "forbidden_origin" }])
    }
  }
  expect(runs.count).toBe(0)
  // R8: none passes; one off the list does not.
  const none = await seen(await run(paged(gate, "R8", pageRequest("R8", { host: AUTHORITY }), () => work)))
  expect([none.status, none.headers["access-control-allow-origin"]]).toEqual([200, undefined])
  expect(runs.count).toBe(1)
  const evil = await seen(await run(paged(gate, "R8", pageRequest("R8", { host: AUTHORITY, origin: "https://evil.example" }), () => work)))
  expect([evil.status, evil.text]).toEqual([403, errorText("forbidden_origin")])
  expect(runs.count).toBe(1)
  // No token is read: a bad one, a good one or none give the same answer.
  for (const authorization of ["Bearer bad.token", "Bearer " + TOKEN, "Basic x"]) {
    for (const name of ["R8", "R9", "R10"] as const) {
      const answer = await seen(await run(paged(gate, name, pageRequest(name, { host: AUTHORITY, origin: ORIGIN, authorization }), () => work)))
      expect([name, answer.status]).toEqual([name, 200])
    }
  }
  expect(runs.count).toBe(10)
  expect(gate.inFlight()).toBe(0)
})

test("(d) at the deadline a local work that stalls is interrupted and gets 503 busy with retry-after 1; its place goes back only when it has ended", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    let interrupted = false
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(paged(gate, "R9", pageRequest("R9", { host: AUTHORITY, origin: ORIGIN }), () =>
      Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true
        })
      ))))
    yield* Deferred.await(started)
    yield* settle
    expect(gate.inFlight()).toBe(1)
    yield* TestClock.adjust(DEFAULTS.request - 1)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    yield* settle
    // The deadline ended it.
    expect(fiber.pollUnsafe()).toBeDefined()
    const answer = yield* Effect.flatMap(Fiber.join(fiber), (r) => Effect.promise(() => seen(r)))
    expect(interrupted).toBe(true)
    expect([answer.status, answer.headers["retry-after"], answer.text, answer.headers["access-control-allow-origin"]]).toEqual([503, "1", errorText("busy"), ORIGIN])
    expect(lastLine()).toEqual({ route: "R9", status: 503, error: "busy", fault: "deadline" })
    expect(gate.inFlight()).toBe(0)
  }))
  // A work with an uninterruptible part: the place waits for its end.
  await run(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(paged(gate, "R10", pageRequest("R10", { host: AUTHORITY, origin: ORIGIN }), () =>
      Effect.uninterruptible(Effect.andThen(Deferred.succeed(started, undefined), Effect.sleep(40_000))).pipe(Effect.as(jsonAnswer({})))))
    yield* Deferred.await(started)
    yield* settle
    yield* TestClock.adjust(DEFAULTS.request)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    expect(gate.inFlight()).toBe(1)
    yield* TestClock.adjust(10_000 - 1)
    yield* settle
    expect(gate.inFlight()).toBe(1)
    yield* TestClock.adjust(1)
    expect((yield* Fiber.join(fiber)).status).toBe(503)
    expect(gate.inFlight()).toBe(0)
  }))
})

// The body
// --------

// R10's bound (section 7).
const R10_BODY = 16_384

// A body in chunks of 4 KiB, with no content-length.
const chunked = (size: number) => {
  let left = size
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left === 0) return controller.close()
      const chunk = Math.min(left, 4_096)
      left -= chunk
      controller.enqueue(new Uint8Array(chunk).fill(97))
    }
  })
}

const sized = (local: Local) => Effect.map(local.body(R10_BODY), (bytes) => jsonAnswer({ size: bytes.length }))

const posted = (gate: Gate, body: NonNullable<RequestInit["body"]>, headers: Record<string, string> = {}) =>
  run(paged(gate, "R10", pageRequest("R10", { host: AUTHORITY, origin: ORIGIN, ...headers }, { body }), sized)).then(seen)

test("(e) the body reader takes at most its bound: 16,384 bytes pass and 16,385 get 413 too_large, with content-length and without; its bound is its own, not `body`'s", async () => {
  const gate = gateOf()
  for (const size of [0, 1, R10_BODY]) {
    expect(JSON.parse((await posted(gate, new Uint8Array(size).fill(97), { "content-length": String(size) })).text)).toEqual({ size })
    expect(JSON.parse((await posted(gate, chunked(size))).text)).toEqual({ size })
  }
  // By the count of the bytes read: none, and a content-length that is too
  // small.
  expect((await posted(gate, chunked(R10_BODY + 1))).status).toBe(413)
  expect((await posted(gate, chunked(R10_BODY + 1), { "content-length": "10" })).status).toBe(413)
  expect(lastLine()).toEqual({ route: "R10", status: 413, error: "too_large" })
  // By content-length: no byte is read.
  let pulled = 0
  const never = new ReadableStream<Uint8Array>({
    pull() {
      pulled += 1
    }
  }, { highWaterMark: 0 })
  const byLength = await posted(gate, never, { "content-length": String(R10_BODY + 1) })
  expect([byLength.status, byLength.text, byLength.headers["connection"], byLength.headers["access-control-allow-origin"]]).toEqual([413, errorText("too_large"), "close", ORIGIN])
  expect(pulled).toBe(0)
  // A bound below `body` and one above it: each reader's own.
  const small = await run(paged(gate, "R10", pageRequest("R10", { host: AUTHORITY, origin: ORIGIN }, { body: chunked(11) }), (local) =>
    Effect.map(local.body(10), (bytes) => jsonAnswer({ size: bytes.length })))).then(seen)
  expect(small.status).toBe(413)
  const large = await run(paged(gate, "R10", pageRequest("R10", { host: AUTHORITY, origin: ORIGIN }, { body: chunked(DEFAULTS.body + 1) }), (local) =>
    Effect.map(local.body(DEFAULTS.body + 1), (bytes) => jsonAnswer({ size: bytes.length })))).then(seen)
  expect(JSON.parse(large.text)).toEqual({ size: DEFAULTS.body + 1 })
  expect(gate.inFlight()).toBe(0)
})

test("(e) a body that comes too slowly gets 408 timeout with connection: close, at `bodyRead`", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3))
      }
    })
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(paged(gate, "R10", pageRequest("R10", { host: AUTHORITY, origin: ORIGIN, "content-length": "10" }, { body: slow }), (local) =>
      Effect.andThen(Deferred.succeed(started, undefined), sized(local))))
    yield* Deferred.await(started)
    yield* settle
    yield* TestClock.adjust(DEFAULTS.bodyRead - 1)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    const answer = yield* Effect.flatMap(Fiber.join(fiber), (r) => Effect.promise(() => seen(r)))
    expect([answer.status, answer.headers["connection"], answer.text]).toEqual([408, "close", errorText("timeout")])
    expect(lastLine()).toEqual({ route: "R10", status: 408, error: "timeout" })
    expect(gate.inFlight()).toBe(0)
  }))
})

test("(f) a Refused of the work gives its error answer with the origin's headers; a failure and a defect of the work give 500 internal; each gives its place back", async () => {
  const gate = gateOf()
  const ask = (work: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>) =>
    run(paged(gate, "R9", pageRequest("R9", { host: AUTHORITY, origin: ORIGIN }), () => work)).then(seen)
  const bad = await ask(Effect.fail(new Refused({ code: "bad_request" })))
  expect([bad.status, bad.text, bad.headers["access-control-allow-origin"], bad.headers["vary"]]).toEqual([400, errorText("bad_request"), ORIGIN, "origin"])
  expect(lastLine()).toEqual({ route: "R9", status: 400, error: "bad_request" })
  const many = await ask(Effect.fail(new Refused({ code: "too_many", retryAfter: 7 })))
  expect([many.status, many.headers["retry-after"], many.text]).toEqual([429, "7", errorText("too_many")])
  const none = await ask(Effect.fail(new Refused({ code: "no_chat" })))
  expect([none.status, none.text]).toEqual([404, errorText("no_chat")])
  const failed = await ask(Effect.fail(new Error("a failure with secretvalue1234")))
  expect([failed.status, failed.text, failed.headers["access-control-allow-origin"]]).toEqual([500, errorText("internal"), ORIGIN])
  expect(lastLine()).toEqual({ route: "R9", status: 500, error: "internal", fault: "defect" })
  const died = await ask(Effect.die(new Error("a defect with secretvalue1234")))
  expect([died.status, died.text]).toEqual([500, errorText("internal")])
  expect(lastLine()).toEqual({ route: "R9", status: 500, error: "internal", fault: "defect" })
  expect(lines.join("\n")).not.toContain("secretvalue1234")
  expect(gate.inFlight()).toBe(0)
})

// Over a connection
// -----------------

// Raw bytes to the port: what came back within `wait` ms.
const raw = (port: number, text: string, wait: number) =>
  new Promise<string>((resolve) => {
    let got = ""
    let done = false
    const end = () => {
      if (done) return
      done = true
      resolve(got)
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
        },
        close: end,
        error: end
      }
    }).then((socket) =>
      setTimeout(() => {
        end()
        socket.end()
      }, wait)
    )
  })

test("over a connection: with `authority` 127.0.0.1:<port>, a request to 127.0.0.1 passes; one with another Host (a name that points at 127.0.0.1, localhost, another port) gets 403 and no work", async () => {
  let worked = 0
  // The gate, made when the port is known.
  const gates: Array<Gate> = []
  const route = HttpRouter.route("GET", `/${START}/`, Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) =>
    Effect.suspend(() => gates[0]!.local("R8", () =>
      Effect.sync(() => {
        worked += 1
        return HttpServerResponse.text("the page")
      })).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req)))))
  await Effect.runPromise<void, unknown>(Effect.scoped(Effect.gen(function*() {
    const server = yield* Layer.build(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))
    const port = (Context.get(server, HttpServer.HttpServer).address as { port: number }).port
    gates.push(gateOf({ authority: "127.0.0.1:" + port, limits: { request: 2_000 } }))
    yield* Layer.build(HttpRouter.serve(HttpRouter.addAll([route]), { disableLogger: true, disableListenLog: true }).pipe(Layer.provide(capture))).pipe(
      Effect.provide(server)
    )
    yield* Effect.promise(async () => {
      const passed = await fetch("http://127.0.0.1:" + port + "/" + START + "/")
      expect([passed.status, await passed.text()]).toEqual([200, "the page"])
      expect(worked).toBe(1)
      for (const host of ["evil.example:" + port, "localhost:" + port, "127.0.0.1:" + (port + 1), "127.0.0.1"]) {
        const got = await raw(port, "GET /" + START + "/ HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n", 300)
        expect([host, got.split("\r\n")[0]]).toEqual([host, "HTTP/1.1 403 Forbidden"])
        expect(got).toContain(errorText("forbidden_origin"))
      }
      expect(worked).toBe(1)
      expect(gates[0]!.inFlight()).toBe(0)
    })
  })))
})

// Interruption at each step (the sweep's pattern of http.test.ts)
// ---------------------------------------------------------------
// A request is run on Effect's ordinary scheduler, whose `shouldYield` is
// stepped: it counts the operations of the request's own fiber (the first
// that runs) and, at the operation `stop`, yields there and interrupts that
// fiber while it waits, as a client that goes away does. A run with no stop
// counts the operations of each kind of request; the sweep then stops at each
// of them. The clock is fixed at `NOW` and its sleeps are real timers that it
// counts, so a timer of the request that is left shows.

const timerClock = () => {
  const counter = { pending: 0 }
  const live = Effect.runSync(Clock.clockWith(Effect.succeed))
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => NOW,
    currentTimeMillis: Effect.succeed(NOW),
    currentTimeNanosUnsafe: () => BigInt(NOW) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(NOW) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        let active = true
        counter.pending += 1
        const timer = setTimeout(() => {
          active = false
          counter.pending -= 1
          resume(Effect.void)
        }, Duration.toMillis(duration))
        return Effect.sync(() => {
          if (!active) return
          active = false
          counter.pending -= 1
          clearTimeout(timer)
        })
      })
  }
  return { clock, counter }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

// The kinds of a request of the sweep: R8's page; R10 with its body's read;
// R9 with a work that fails; R9 refused by its origin; R8 with another
// method; and a wrong Host on R2, none, the socket, the preflight and R10.
const KINDS = ["page", "body", "fails", "origin", "method", "hostRoute", "hostNone", "hostSocket", "hostPreflight", "hostLocal"] as const
type Kind = (typeof KINDS)[number]

const action = (gate: Gate, kind: Kind): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const good = { host: AUTHORITY, origin: ORIGIN }
  const wrong = { host: "localhost:4681", origin: ORIGIN }
  const member = (name: string) => MEMBERS.find((each) => each.name === name)!
  switch (kind) {
    case "page":
      return paged(gate, "R8", pageRequest("R8", { host: AUTHORITY }), () => Effect.succeed(HttpServerResponse.text("the page")))
    case "body":
      return paged(gate, "R10", pageRequest("R10", good, { body: JSON.stringify({ chats: [CHAT] }) }), sized)
    case "fails":
      return paged(gate, "R9", pageRequest("R9", good), () => Effect.fail(new Refused({ code: "bad_request" })))
    case "origin":
      return paged(gate, "R9", pageRequest("R9", { host: AUTHORITY }), () => Effect.succeed(jsonAnswer({})))
    case "method":
      return paged(gate, "R8", pageRequest("R8", { host: AUTHORITY }, { method: "POST" }), () => Effect.succeed(jsonAnswer({})))
    case "hostRoute":
      return member("R2").call(gate, request("/v1/chats/" + CHAT, { headers: wrong }), Effect.succeed(jsonAnswer({})))
    case "hostNone":
      return member("none").call(gate, request("/v1/nothing", { headers: wrong }), Effect.succeed(jsonAnswer({})))
    case "hostSocket":
      return member("R6").call(gate, request("/v1/chats/" + CHAT + "/socket", { headers: { ...wrong, upgrade: "websocket" } }), Effect.succeed(jsonAnswer({})))
    case "hostPreflight":
      return member("R7").call(gate, request("/v1/chats/" + CHAT, { method: "OPTIONS", headers: wrong }), Effect.succeed(jsonAnswer({})))
    case "hostLocal":
      return paged(gate, "R10", pageRequest("R10", wrong, { body: "{}" }), sized)
  }
}

interface Rest {
  readonly requests: number
  readonly timers: number
  readonly fibers: number
}

const trial = async (kind: Kind, stop: number | undefined) => {
  const gate = gateOf({ limits: { requests: 1, request: 150 } })
  const { clock, counter } = timerClock()
  let ops = 0
  let interrupted = false
  let request: Fiber.Fiber<unknown, unknown> | undefined
  const fibers = new Set<Fiber.Fiber<unknown, unknown>>()
  const scheduler = new Scheduler.MixedScheduler()
  scheduler.shouldYield = (fiber) => {
    fibers.add(fiber)
    request ??= fiber
    if (fiber !== request) return fiber.currentOpCount >= 64
    ops += 1
    if (!interrupted && ops === stop) {
      interrupted = true
      queueMicrotask(() => fiber.interruptUnsafe())
      return true
    }
    return fiber.currentOpCount >= 64
  }
  const fiber = Effect.runFork(action(gate, kind).pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(capture)), { scheduler })
  const exit = await Effect.runPromise(Fiber.await(fiber))
  await turn()
  await turn()
  const rest: Rest = {
    requests: gate.inFlight(),
    timers: counter.pending,
    fibers: [...fibers].filter((each) => each.pollUnsafe() === undefined).length
  }
  return { ops, interrupted, exit, rest, gate }
}

test("(d) an interruption at each operation of a page's route and of a wrong Host's refusal leaves no place, no timer and no fiber when the request's fiber has ended; the next request is answered", async () => {
  const failures: Array<unknown> = []
  const clean: Rest = { requests: 0, timers: 0, fibers: 0 }
  const counts: Record<string, number> = {}
  for (const kind of KINDS) {
    const dry = await trial(kind, undefined)
    expect([kind, dry.interrupted, Exit.isSuccess(dry.exit)]).toEqual([kind, false, true])
    counts[kind] = dry.ops
    let cut = 0
    for (let stop = 1; stop <= dry.ops + 1; stop++) {
      const t = await trial(kind, stop)
      if (Exit.isFailure(t.exit)) cut += 1
      if (JSON.stringify(t.rest) !== JSON.stringify(clean)) failures.push({ kind, stop, ops: dry.ops, exit: t.exit._tag, rest: t.rest })
      const next = await Effect.runPromise(
        paged(t.gate, "R8", pageRequest("R8", { host: AUTHORITY }), () => Effect.succeed(jsonAnswer({}))).pipe(Effect.provide(capture))
      )
      if (next.status !== 200) failures.push({ kind, stop, next: next.status })
    }
    // Each kind was cut at some stop.
    if (cut === 0) failures.push({ kind, cut })
  }
  expect(failures).toEqual([])
  expect(Object.values(counts).every((count) => count > 0)).toBe(true)
}, 20_000)

// The log
// -------

test("(g) no line of the log holds a path, a query, a header's value or a body", async () => {
  // A last round of each kind, then the sweep over every line that the
  // tests' logger took in this file.
  const gate = gateOf()
  const probe = { "x-probe": "headervalue1234", cookie: "cookievalue1234" }
  const path = "/" + START + "/pathvalue1234?secretquery=queryvalue1234"
  for (const name of ["R8", "R9", "R10"] as const) {
    for (const headers of [
      { host: AUTHORITY, origin: ORIGIN, ...probe },
      { host: "hostvalue1234.example:4681", origin: ORIGIN, ...probe },
      { host: AUTHORITY, origin: "https://originvalue1234.example", ...probe }
    ]) {
      const init = name === "R8"
        ? { method: "GET", headers }
        : { method: "POST", headers, body: "bodyvalue1234".repeat(2_000), duplex: "half" as const }
      await run(paged(gate, name, request(path, init), (local) => Effect.map(local.body(R10_BODY), () => jsonAnswer({}))))
    }
  }
  for (const member of MEMBERS) {
    await run(member.call(gate, request(path, { method: member.method, headers: { host: "hostvalue1234.example", ...member.extra, ...probe } }), Effect.succeed(jsonAnswer({}))))
  }
  const all = lines.join("\n")
  expect(lines.length).toBeGreaterThan(0)
  for (const secret of [START, "pathvalue1234", "secretquery", "queryvalue1234", "headervalue1234", "cookievalue1234", "hostvalue1234", "originvalue1234", "bodyvalue1234", "127.0.0.1", "Bearer", TOKEN]) {
    expect([secret, all.includes(secret)]).toEqual([secret, false])
  }
  for (const line of parsed()) {
    expect(Object.keys(line.annotations).every((key) => ["route", "status", "error", "check", "fault", "closed"].includes(key))).toBe(true)
  }
})
