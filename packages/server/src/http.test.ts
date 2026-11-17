// Tests of the gate of the HTTP routes (http.ts; docs/host.md, section 3:
// "The checks of each request, in their order", "Admission" 3 to 6 and 10,
// the answers' headers, "Origins"; section 4, "An error"): the places in
// flight, the three checks and their order, the two tenants of check 3, the
// deadline, the body's read, the answers and their headers, R7, and the log.
// Most cases call the gate with a request of the web's `Request` and Effect's
// `TestClock`; the cases that need a connection run a Bun server on
// 127.0.0.1, on a port that the system picks. The secrets are made-up bytes.

import { afterAll, expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Option, Redacted, Scheduler, Scope, Stream } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { type Jwk, Jws } from "effect/jose"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Chats, type Pick, StoreError } from "@everchat/core/store"
import { chatsLayer } from "@everchat/sqlite/bun"
import {
  type Authorized,
  CODES,
  ERRORS,
  errorAnswer,
  type Found,
  type Gate,
  jsonAnswer,
  makeGate,
  Refused,
  type Route,
  type SocketRefused,
  type Steps,
  type Upgrading,
  wholeNumber
} from "./http.ts"
import { DEFAULTS, type Limits } from "./limits.ts"
import { type Claims, makeToken } from "./token.ts"

// Made-up secrets of 32 bytes: the deployment's, and another.
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => i + 7))
const OTHER = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 250 - i))

// Now: half a second into the second `S`.
const S = 1_800_000_000
const NOW = S * 1000 + 500

const ORIGIN = "https://app.example"
const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }

// The log: each line that the tests' logger took, as JSON with its
// annotations.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])
const parsed = () => lines.map((line) => JSON.parse(line) as { annotations: Record<string, unknown> })

// The SQLite store of this file: two tenants, A with two chats and B with one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-http-"))
const scope = Effect.runSync(Scope.make())
const store = await Effect.runPromise(Layer.buildWithScope(chatsLayer(path.join(home, "chats.db")), scope))
const sqlChats = Context.get(store, Chats)
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
const A1 = await Effect.runPromise(sqlChats.make(TENANT_A, PICK))
const A2 = await Effect.runPromise(sqlChats.make(TENANT_A, PICK))
const B1 = await Effect.runPromise(sqlChats.make(TENANT_B, PICK))
afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  fs.rmSync(home, { recursive: true, force: true })
})

// A `Chats` over the store that counts its reads: each `reads` that runs,
// and each part of a chat's reads that is used.
const counting = () => {
  const calls: Array<{ tenant: string; chat: string }> = []
  const used: Array<string> = []
  const chats: typeof Chats.Service = {
    make: sqlChats.make,
    store: sqlChats.store,
    reads: (tenant, chat) =>
      Effect.suspend(() => {
        calls.push({ tenant, chat })
        return Effect.map(sqlChats.reads(tenant, chat), (reading) =>
          new Proxy(reading, {
            get(target, key, receiver) {
              used.push(chat + ":" + String(key))
              return Reflect.get(target, key, receiver)
            }
          }))
      })
  }
  return { chats, calls, used }
}

const gateOf = (limits: Partial<Limits> = {}, chats: typeof Chats.Service = sqlChats, origins = [ORIGIN]) =>
  makeGate({ secret: SECRET, origins, limits: { ...DEFAULTS, ...limits }, chats })

// Tokens
// ------

// A token of `claims` made at `at` (ms), signed with `secret`.
const mint = (claims: Claims, { at = NOW, secret = SECRET }: { at?: number; secret?: Redacted.Redacted<Uint8Array> } = {}) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(at), makeToken(secret, claims)).pipe(Effect.provide(TestClock.layer())))

const part = (value: unknown) => Base64Url.encode(JSON.stringify(value))
// A token of any claims, signed with the secret: what `makeToken` would refuse.
const signed = (payload: unknown) =>
  Effect.runPromise(Effect.gen(function*() {
    const key = yield* Mac.key(Mac.hmacSha256, Redacted.value(SECRET))
    const jwk = { _tag: "SecretKey", algorithm: "HS256", kid: undefined, key } as Jwk.SecretKey<"HS256">
    return Redacted.value(yield* Jws.sign(new TextEncoder().encode(JSON.stringify(payload)), jwk, { typ: "JWT" }))
  }).pipe(Effect.provide(Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)))))

const GOOD: Claims = { tenant: TENANT_A, chats: [A1, B1], exp: S + 600 }
const TOKEN = await mint(GOOD)
// A token of A that does not name A2, nor B's chat.
const ONLY_A1 = await mint({ tenant: TENANT_A, chats: [A1], exp: S + 600 })

// Each failing check of `verifyToken`, 2 to 7, by its number.
const FAILING: ReadonlyArray<readonly [number, string]> = [
  [2, "a.b"],
  [3, part({ alg: "none", typ: "JWT" }) + "." + part(GOOD) + "."],
  [4, await mint(GOOD, { secret: OTHER })],
  [5, await signed({ tenant: TENANT_A, chats: [A1] })],
  [6, await mint({ tenant: TENANT_A, chats: [A1], exp: S - 540 }, { at: (S - 600) * 1000 })],
  [7, await signed({ ...GOOD, nbf: S + 60 })]
]

// Requests and answers
// --------------------

const request = (url: string, init: RequestInit & { duplex?: "half" } = {}) =>
  HttpServerRequest.fromWeb(new Request("http://127.0.0.1" + url, init))

const authorized = (extra: Record<string, string> = {}) => ({ authorization: "Bearer " + TOKEN, ...extra })

// The route's work of most cases: a JSON answer that names the chat.
let worked = 0
const ok = (found: Found) =>
  Effect.sync(() => {
    worked += 1
    return jsonAnswer({ chat: found.chat, tenant: found.tenant })
  })

// The route of a request: R1 for a `POST`, else R2 (each route has one
// method).
const call = (
  gate: Gate,
  req: HttpServerRequest.HttpServerRequest,
  chat: string | undefined,
  work: (found: Found) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown> = ok
) => gate.route(req.method === "POST" ? "R1" : "R2", chat, work).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))

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

// The places
// ----------

test("with `requests` 2, the third request at one time gets 503 busy with retry-after 1 at once, before its body is read; a place is free again after a work's end", async () => {
  const gate = gateOf({ requests: 2 })
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      controller.enqueue(new Uint8Array(10))
      controller.close()
    }
  }, { highWaterMark: 0 })
  await run(Effect.gen(function*() {
    const latch = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    let count = 0
    const held = (found: Found) =>
      Effect.andThen(Effect.suspend(() => ++count === 2 ? Deferred.succeed(started, undefined) : Effect.void), Effect.as(Deferred.await(latch), jsonAnswer({ chat: found.chat })))
    const one = yield* Effect.forkChild(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, held))
    const two = yield* Effect.forkChild(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, held))
    yield* Deferred.await(started)
    expect(gate.inFlight()).toBe(2)
    const third = request("/v1/chats/" + A1, { method: "POST", headers: authorized(), body, duplex: "half" })
    const refused = yield* call(gate, third, A1, (found) => Effect.map(gate.body(found.request), () => jsonAnswer({})))
    const answer = yield* Effect.promise(() => seen(refused))
    expect(answer.status).toBe(503)
    expect(answer.headers["retry-after"]).toBe("1")
    expect(answer.text).toBe(errorText("busy"))
    expect(pulled).toBe(0)
    expect(gate.inFlight()).toBe(2)
    yield* Deferred.succeed(latch, undefined)
    yield* Fiber.join(one)
    yield* Fiber.join(two)
    expect(gate.inFlight()).toBe(0)
    const again = yield* call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1)
    expect(again.status).toBe(200)
    expect(gate.inFlight()).toBe(0)
  }))
})

test("a place goes back after a work that failed and after a work that was interrupted, only when that work has ended", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const failedAnswer = yield* call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () => Effect.fail("the work failed"))
    expect((yield* Effect.promise(() => seen(failedAnswer))).status).toBe(500)
    yield* call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () => Effect.die("a defect"))
    expect(gate.inFlight()).toBe(0)
    // A request's fiber that is interrupted, as Effect's Bun server does when
    // its client goes away: the place stays while the work's uninterruptible
    // part runs.
    const latch = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    let after = false
    const fiber = yield* Effect.forkChild(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () =>
      Effect.uninterruptible(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(latch))).pipe(Effect.andThen(Effect.sync(() => {
        after = true
        return jsonAnswer({})
      })))))
    yield* Deferred.await(started)
    const stopping = yield* Effect.forkChild(Fiber.interrupt(fiber))
    yield* settle
    expect(gate.inFlight()).toBe(1)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(latch, undefined)
    yield* Fiber.join(stopping)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(after).toBe(false)
    expect(gate.inFlight()).toBe(0)
  }))
})

// Check 1: the origin
// -------------------

test("an origin off the list gets 403 forbidden_origin with no CORS header; one on the list gets the route's answer with its CORS headers; none passes with no CORS header", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const offAnswer = yield* Effect.flatMap(call(gate, request("/v1/chats/" + A1, { headers: authorized({ origin: "https://evil.example" }) }), A1), (r) => Effect.promise(() => seen(r)))
    expect(offAnswer.status).toBe(403)
    expect(offAnswer.text).toBe(errorText("forbidden_origin"))
    expect(offAnswer.headers["access-control-allow-origin"]).toBeUndefined()
    // The scheme is part of the text: `http://` of a listed `https://` host is
    // off the list, and so is a port, a path or a case of its own.
    for (const near of ["http://app.example", "https://app.example:443", "https://app.example/", "https://APP.example", "app.example"]) {
      const answer = yield* Effect.flatMap(call(gate, request("/v1/chats/" + A1, { headers: authorized({ origin: near }) }), A1), (r) => Effect.promise(() => seen(r)))
      expect(answer.status).toBe(403)
    }
    const on = yield* Effect.flatMap(call(gate, request("/v1/chats/" + A1, { headers: authorized({ origin: ORIGIN }) }), A1), (r) => Effect.promise(() => seen(r)))
    expect(on.status).toBe(200)
    expect(on.headers["access-control-allow-origin"]).toBe(ORIGIN)
    expect(on.headers["vary"]).toBe("origin")
    expect(on.headers["content-type"]).toBe("application/json; charset=utf-8")
    const none = yield* Effect.flatMap(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1), (r) => Effect.promise(() => seen(r)))
    expect(none.status).toBe(200)
    expect(Object.keys(none.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])
    expect(none.headers["vary"]).toBeUndefined()
  }))
})

// Check 2: the token
// ------------------

test("no Authorization, Basic, two tokens, an empty token and each failing check of verifyToken (2 to 7) get one 401 with equal bodies, and a log line with the check's number and no part of the token", async () => {
  const gate = gateOf()
  const headers: ReadonlyArray<readonly [number, Record<string, string>]> = [
    [1, {}],
    [1, { authorization: "Basic " + btoa("user:" + TOKEN) }],
    [1, { authorization: "Bearer " + TOKEN + " " + TOKEN }],
    [1, { authorization: "Bearer " + TOKEN + ", Bearer " + TOKEN }],
    [1, { authorization: "Bearer " }],
    [1, { authorization: "Bearer" }],
    [1, { authorization: "bearer " + TOKEN }],
    ...FAILING.map(([check, token]) => [check, { authorization: "Bearer " + token }] as const)
  ]
  const before = worked
  const bodies = new Set<string>()
  for (const [check, header] of headers) {
    lines.length = 0
    const answer = await seen(await run(call(gate, request("/v1/chats/" + A1, { headers: header }), A1)))
    expect(answer.status).toBe(401)
    bodies.add(answer.text)
    const logged = parsed()
    expect(logged.length).toBe(1)
    expect(logged[0]?.annotations).toMatchObject({ route: "R2", status: 401, error: "unauthorized", check })
    const value = header.authorization
    if (value !== undefined && value.length > 7) {
      for (const piece of value.slice(7).split(/[ .,]/).filter((p) => p.length >= 8)) expect(lines[0]).not.toContain(piece)
    }
  }
  expect([...bodies]).toEqual([errorText("unauthorized")])
  expect(worked).toBe(before)
})

test("a token in the query alone is 401: no route reads a token there", async () => {
  const gate = gateOf()
  for (const name of ["token", "access_token", "authorization"]) {
    const answer = await seen(await run(call(gate, request("/v1/chats/" + A1 + "?" + name + "=" + TOKEN), A1)))
    expect(answer.status).toBe(401)
  }
})

test("a token that ends after its request's head was checked still gets its answer", async () => {
  const gate = gateOf()
  const short = await mint({ tenant: TENANT_A, chats: [A1], exp: S + 1 })
  const answer = await seen(await run(call(gate, request("/v1/chats/" + A1, { headers: { authorization: "Bearer " + short } }), A1, (found) =>
    Effect.andThen(TestClock.adjust(5_000), Effect.succeed(jsonAnswer({ chat: found.chat }))))))
  expect(answer.status).toBe(200)
  expect(JSON.parse(answer.text)).toEqual({ chat: A1 })
})

// Check 3: the chat, and the two tenants
// --------------------------------------

test("a chat outside the token, a chat of another tenant named in the token, and a text that is no UUID get 404 no_chat, equal byte for byte; the work does not run, and nothing of B's chat is read", async () => {
  const { chats, calls, used } = counting()
  const gate = gateOf({}, chats)
  const before = worked
  // A's own chat A2, outside a token that names A1 only: the claim alone
  // refuses it.
  const outside = await seen(await run(call(gate, request("/v1/chats/" + A2, { headers: { authorization: "Bearer " + ONLY_A1 } }), A2)))
  // B's chat with a token of A that does not name it.
  const notNamed = await seen(await run(call(gate, request("/v1/chats/" + B1, { headers: { authorization: "Bearer " + ONLY_A1 } }), B1)))
  expect(calls).toEqual([])
  // B's chat named in a token of A: the store finds no chat of A with it.
  const named = await seen(await run(call(gate, request("/v1/chats/" + B1, { headers: authorized() }), B1)))
  expect(calls).toEqual([{ tenant: TENANT_A, chat: B1 }])
  const noForm = await seen(await run(call(gate, request("/v1/chats/not-a-uuid", { headers: authorized() }), "not-a-uuid")))
  const upper = await seen(await run(call(gate, request("/v1/chats/" + A1.toUpperCase(), { headers: authorized() }), A1.toUpperCase())))
  const none = await seen(await run(call(gate, request("/v1/chats", { headers: authorized() }), undefined)))
  for (const answer of [outside, notNamed, named, noForm, upper, none]) {
    expect(answer.status).toBe(404)
    expect(answer.text).toBe(errorText("no_chat"))
    expect(answer.headers).toEqual(outside.headers)
  }
  expect(worked).toBe(before)
  expect(calls).toEqual([{ tenant: TENANT_A, chat: B1 }])
  expect(used).toEqual([])
  // The same token for its own chat: the store's reads, and the work.
  const own = await seen(await run(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1)))
  expect(own.status).toBe(200)
  expect(JSON.parse(own.text)).toEqual({ chat: A1, tenant: TENANT_A })
  expect(worked).toBe(before + 1)
})

test("the work gets the tenant, the chat, the claims and the chat's own reads", async () => {
  const gate = gateOf()
  const got = await run(Effect.gen(function*() {
    let found: Found | undefined
    yield* call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, (f) =>
      Effect.sync(() => {
        found = f
        return jsonAnswer({})
      }))
    const chat = yield* (found as Found).reads.chat
    return { found: found as Found, chat }
  }))
  expect(got.found.tenant).toBe(TENANT_A)
  expect(got.found.chat).toBe(A1)
  expect(got.found.claims).toEqual(GOOD)
  expect(got.chat.uuid).toBe(A1)
})

// The order
// ---------

test("the order: a bad origin with a bad token is 403; a bad token with another tenant's chat is 401; with no good token no read of the store happens", async () => {
  const { chats, calls } = counting()
  const gate = gateOf({}, chats)
  const both = await seen(await run(call(gate, request("/v1/chats/" + B1, { headers: { origin: "https://evil.example", authorization: "Bearer a.b" } }), B1)))
  expect(both.status).toBe(403)
  const badToken = await seen(await run(call(gate, request("/v1/chats/" + B1, { headers: { authorization: "Bearer " + FAILING[2]?.[1] } }), B1)))
  expect(badToken.status).toBe(401)
  for (const [, token] of FAILING) {
    for (const chat of [A1, B1]) {
      expect((await run(call(gate, request("/v1/chats/" + chat, { headers: { authorization: "Bearer " + token } }), chat))).status).toBe(401)
    }
  }
  expect((await run(call(gate, request("/v1/chats/" + A1), A1))).status).toBe(401)
  expect(calls).toEqual([])
})

// The deadline
// ------------

test("at the deadline a work with no byte sent is interrupted, and the answer is 503 busy with retry-after 1", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    let interrupted = false
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () =>
      Effect.andThen(Deferred.succeed(started, undefined), Effect.sleep(60_000)).pipe(Effect.as(jsonAnswer({})), Effect.onInterrupt(() => Effect.sync(() => {
        interrupted = true
      })))))
    yield* Deferred.await(started)
    yield* settle
    yield* TestClock.adjust(DEFAULTS.request - 1)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    const answer = yield* Effect.flatMap(Fiber.join(fiber), (r) => Effect.promise(() => seen(r)))
    expect(interrupted).toBe(true)
    expect(answer.status).toBe(503)
    expect(answer.headers["retry-after"]).toBe("1")
    expect(answer.text).toBe(errorText("busy"))
    expect(gate.inFlight()).toBe(0)
  }))
})

test("the deadline counts the checks too: a store's read that stalls past it gives 503 busy", async () => {
  const called = Effect.runSync(Deferred.make<void>())
  const stalled: typeof Chats.Service = { ...sqlChats, reads: () => Effect.andThen(Deferred.succeed(called, undefined), Effect.never) }
  const gate = gateOf({}, stalled)
  await run(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1))
    yield* Deferred.await(called)
    yield* settle
    yield* TestClock.adjust(DEFAULTS.request)
    expect((yield* Fiber.join(fiber)).status).toBe(503)
  }))
})

test("at the deadline the place goes back only when the interrupted work has ended: a work with an uninterruptible part", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () =>
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
    const answer = yield* Fiber.join(fiber)
    expect(answer.status).toBe(503)
    expect(gate.inFlight()).toBe(0)
  }))
})

// The body
// --------

const post = (body: NonNullable<RequestInit["body"]>, headers: Record<string, string> = {}) =>
  request("/v1/chats/" + A1 + "/messages", { method: "POST", headers: authorized(headers), body, duplex: "half" })

// A body in chunks of 64 KiB, with no content-length.
const chunked = (size: number) => {
  let left = size
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left === 0) return controller.close()
      const chunk = Math.min(left, 65_536)
      left -= chunk
      controller.enqueue(new Uint8Array(chunk).fill(97))
    }
  })
}

const readBody = (gate: Gate) => (found: Found) => Effect.map(gate.body(found.request), (bytes) => jsonAnswer({ size: bytes.length }))

test("a body of `body` bytes passes and one of `body` + 1 gets 413 too_large, with content-length and without", async () => {
  const gate = gateOf()
  const limit = DEFAULTS.body
  for (const size of [0, 1, limit]) {
    const withLength = await seen(await run(call(gate, post(new Uint8Array(size).fill(97), { "content-length": String(size) }), A1, readBody(gate))))
    expect(JSON.parse(withLength.text)).toEqual({ size })
    const without = await seen(await run(call(gate, post(chunked(size)), A1, readBody(gate))))
    expect(JSON.parse(without.text)).toEqual({ size })
  }
  // By content-length first: no byte is read.
  let pulled = 0
  const never = new ReadableStream<Uint8Array>({
    pull() {
      pulled += 1
    }
  }, { highWaterMark: 0 })
  const byLength = await seen(await run(call(gate, post(never, { "content-length": String(limit + 1) }), A1, readBody(gate))))
  expect(byLength.status).toBe(413)
  expect(byLength.text).toBe(errorText("too_large"))
  expect(pulled).toBe(0)
  // By the count of the bytes read: no content-length, or one that is too
  // small.
  const byCount = await seen(await run(call(gate, post(chunked(limit + 1)), A1, readBody(gate))))
  expect(byCount.status).toBe(413)
  const lying = await seen(await run(call(gate, post(chunked(limit + 1), { "content-length": "10" }), A1, readBody(gate))))
  expect(lying.status).toBe(413)
  // The read stops at the chunk that passes the bound: it never takes the
  // rest of a large body.
  let given = 0
  const large = new ReadableStream<Uint8Array>({
    pull(controller) {
      given += 65_536
      controller.enqueue(new Uint8Array(65_536))
    }
  })
  expect((await run(call(gate, post(large), A1, readBody(gate)))).status).toBe(413)
  expect(given).toBeLessThanOrEqual(limit + 3 * 65_536)
})

test("a body that comes too slowly gets 408 timeout with connection: close, at `bodyRead`", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3))
      }
    })
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(call(gate, post(slow, { "content-length": "10" }), A1, (found) => Effect.andThen(Deferred.succeed(started, undefined), readBody(gate)(found))))
    yield* Deferred.await(started)
    yield* settle
    yield* TestClock.adjust(DEFAULTS.bodyRead - 1)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    const answer = yield* Effect.flatMap(Fiber.join(fiber), (r) => Effect.promise(() => seen(r)))
    expect(answer.status).toBe(408)
    expect(answer.headers["connection"]).toBe("close")
    expect(answer.text).toBe(errorText("timeout"))
  }))
})

// The answers
// -----------

test("each of the eleven errors has its status and its one sentence, with the three headers and its JSON type; a Refused of the work gives that answer", async () => {
  expect(CODES).toEqual(["bad_request", "unauthorized", "forbidden_origin", "no_chat", "timeout", "chat_elsewhere", "too_large", "unsupported_type", "too_many", "internal", "busy"])
  const statuses = { bad_request: 400, unauthorized: 401, forbidden_origin: 403, no_chat: 404, timeout: 408, chat_elsewhere: 409, too_large: 413, unsupported_type: 415, too_many: 429, internal: 500, busy: 503 }
  const gate = gateOf()
  const sentences = new Set<string>()
  for (const code of CODES) {
    const plain = await seen(errorAnswer(code))
    expect(plain.status).toBe(statuses[code])
    expect(plain.headers["content-type"]).toBe("application/json; charset=utf-8")
    expect(JSON.parse(plain.text)).toEqual({ error: code, message: ERRORS[code].message })
    expect(Object.keys(JSON.parse(plain.text))).toEqual(["error", "message"])
    sentences.add(ERRORS[code].message)
    const fromWork = await seen(await run(call(gate, request("/v1/chats/" + A1, { headers: authorized({ origin: ORIGIN }) }), A1, () => Effect.fail(new Refused({ code, retryAfter: 5 })))))
    expect(fromWork.status).toBe(statuses[code])
    expect(fromWork.text).toBe(plain.text)
    expect(fromWork.headers["retry-after"]).toBe("5")
    expect(fromWork.headers["access-control-allow-origin"]).toBe(ORIGIN)
  }
  expect(sentences.size).toBe(11)
  // No sentence holds a value of the request: each is fixed, a full sentence.
  for (const message of sentences) expect(message).toMatch(/^[A-Z][^{}<>]*\.$/)
})

test("for a listed origin, a 200 and an error both have the CORS headers; a request with no Origin has none; no answer allows credentials", async () => {
  const gate = gateOf()
  const withCredentials = () => Effect.succeed(HttpServerResponse.setHeader(jsonAnswer({}), "access-control-allow-credentials", "true"))
  const good = await seen(await run(call(gate, request("/v1/chats/" + A1, { headers: authorized({ origin: ORIGIN }) }), A1, withCredentials)))
  expect(good.status).toBe(200)
  expect(good.headers["access-control-allow-origin"]).toBe(ORIGIN)
  expect(good.headers["vary"]).toBe("origin")
  for (const answer of [
    await seen(await run(call(gate, request("/v1/chats/" + A1, { headers: { origin: ORIGIN } }), A1))),
    await seen(await run(call(gate, request("/v1/chats/" + B1, { headers: authorized({ origin: ORIGIN }) }), B1)))
  ]) {
    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(answer.headers["access-control-allow-origin"]).toBe(ORIGIN)
    expect(answer.headers["vary"]).toBe("origin")
  }
  const plain = await seen(await run(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, withCredentials)))
  expect(Object.keys(plain.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])
})

// R7
// --

test("R7: 204 with the preflight headers for a listed origin, 403 for another, and 204 with no access-control header with no Origin; it takes a place and reads nothing", async () => {
  const { chats, calls } = counting()
  const gate = gateOf({}, chats)
  const preflight = (headers: Record<string, string>) =>
    run(gate.preflight.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request("/v1/chats/" + A1, { method: "OPTIONS", headers }))))
  const listed = await seen(await preflight({ origin: ORIGIN, "access-control-request-method": "POST" }))
  expect(listed.status).toBe(204)
  expect(listed.headers).toMatchObject({
    "access-control-allow-origin": ORIGIN,
    vary: "origin",
    "access-control-allow-methods": "GET, POST",
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
    "access-control-max-age": "600"
  })
  const other = await seen(await preflight({ origin: "https://evil.example" }))
  expect(other.status).toBe(403)
  expect(other.text).toBe(errorText("forbidden_origin"))
  expect(Object.keys(other.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])
  const none = await seen(await preflight({}))
  expect(none.status).toBe(204)
  expect(Object.keys(none.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])
  expect(calls).toEqual([])
  expect(gate.inFlight()).toBe(0)
  // At the bound it is 503 too.
  const full = gateOf({ requests: 1 })
  await run(Effect.gen(function*() {
    const latch = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const held = yield* Effect.forkChild(call(full, request("/v1/chats/" + A1, { headers: authorized() }), A1, () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(latch), jsonAnswer({})))))
    yield* Deferred.await(started)
    const busy = yield* full.preflight.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request("/", { method: "OPTIONS", headers: { origin: ORIGIN } })))
    expect(busy.status).toBe(503)
    yield* Deferred.succeed(latch, undefined)
    yield* Fiber.join(held)
  }))
})

// Over a connection
// -----------------

// A Bun server of the gate's routes on 127.0.0.1, with real time and small
// limits, for the cases that need a connection.
const serving = <A, E>(gate: Gate, routes: ReadonlyArray<HttpRouter.Route<any, any>>, body: (port: number) => Effect.Effect<A, E>) =>
  Effect.runPromise<A, unknown>(Effect.scoped(Effect.gen(function*() {
    const server = yield* Layer.build(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))
    yield* Layer.build(HttpRouter.serve(HttpRouter.addAll(routes), { disableLogger: true, disableListenLog: true }).pipe(Layer.provide(capture))).pipe(
      Effect.provide(server)
    )
    const address = Context.get(server, HttpServer.HttpServer).address
    return yield* body((address as { port: number }).port)
  })) as Effect.Effect<A, unknown>)

// Raw bytes to the port; what came back, and whether the server closed the
// connection within `wait` ms.
const raw = (port: number, text: string, wait: number) =>
  new Promise<{ got: string; closed: boolean }>((resolve) => {
    let got = ""
    let done = false
    const end = (closed: boolean) => {
      if (done) return
      done = true
      resolve({ got, closed })
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
        close() {
          end(true)
        },
        error() {
          end(true)
        }
      }
    }).then((socket) =>
      setTimeout(() => {
        end(false)
        socket.end()
      }, wait)
    )
  })

const chatOf = Effect.map(HttpRouter.params, (params) => params["chat"])

// A token for the real clock, for the cases over a connection.
const realToken = () => mint({ tenant: TENANT_A, chats: [A1], exp: Math.floor(Date.now() / 1000) + 600 }, { at: Date.now() })

test("over a connection: past the deadline with bytes sent, the connection closes; with none, 503; a body that comes too slowly gets 408 and the connection closes", async () => {
  const gate = gateOf({ request: 400, bodyRead: 200 })
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat/events", Effect.flatMap(chatOf, (chat) =>
      gate.route("R4", chat, () =>
        Effect.succeed(HttpServerResponse.stream(Stream.concat(Stream.make(new TextEncoder().encode("partial")), Stream.never), { contentType: "text/event-stream" }))))),
    HttpRouter.route("GET", "/v1/chats/:chat", Effect.flatMap(chatOf, (chat) => gate.route("R2", chat, () => Effect.as(Effect.never, jsonAnswer({}))))),
    HttpRouter.route("POST", "/v1/chats/:chat/messages", Effect.flatMap(chatOf, (chat) => gate.route("R1", chat, readBody(gate))))
  ]
  const token = await realToken()
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      const head = (method: string, url: string, extra = "") => `${method} ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n${extra}\r\n`
      const [sent, unsent, slow] = yield* Effect.promise(() =>
        Promise.all([
          raw(port, head("GET", `/v1/chats/${A1}/events`), 1_500),
          raw(port, head("GET", `/v1/chats/${A1}`), 1_500),
          raw(port, head("POST", `/v1/chats/${A1}/messages`, "Content-Type: application/json\r\nContent-Length: 10\r\n") + "abc", 1_500)
        ])
      )
      // The stream sent its head and a first chunk, then was cut: no last
      // chunk, and the connection closed.
      expect(sent.got).toStartWith("HTTP/1.1 200")
      expect(sent.got).toContain("partial")
      expect(sent.got).not.toContain("\r\n0\r\n\r\n")
      expect(sent.closed).toBe(true)
      expect(unsent.got).toStartWith("HTTP/1.1 503")
      expect(unsent.got.toLowerCase()).toContain("retry-after: 1")
      expect(slow.got).toStartWith("HTTP/1.1 408")
      expect(slow.got).toContain(errorText("timeout"))
      expect(slow.closed).toBe(true)
      // Each place went back: the stream's when it was cut.
      expect(gate.inFlight()).toBe(0)
    }))
})

test("over a connection: a request whose client went away holds its place until its work has ended, and its work is asked to stop", async () => {
  const gate = gateOf()
  const latch = Effect.runSync(Deferred.make<void>())
  const started = Effect.runSync(Deferred.make<void>())
  let after = false
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat", Effect.flatMap(chatOf, (chat) =>
      gate.route("R2", chat, () =>
        Effect.uninterruptible(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(latch))).pipe(
          Effect.andThen(Effect.sync(() => {
            after = true
            return jsonAnswer({})
          }))
        ))))
  ]
  const token = await realToken()
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      const controller = new AbortController()
      const fetched = fetch(`http://127.0.0.1:${port}/v1/chats/${A1}`, { headers: { authorization: "Bearer " + token }, signal: controller.signal }).catch(() => "aborted")
      yield* Deferred.await(started)
      expect(gate.inFlight()).toBe(1)
      controller.abort()
      expect(yield* Effect.promise(() => fetched)).toBe("aborted")
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
      expect(gate.inFlight()).toBe(1)
      yield* Deferred.succeed(latch, undefined)
      for (let i = 0; i < 100 && gate.inFlight() > 0; i++) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
      expect(gate.inFlight()).toBe(0)
      expect(after).toBe(false)
    }))
})

// A stream answer: the gate, not the stream's pull, owns the place and the
// deadline (http.ts, the place).

// Waits, on the real clock, until `check` holds or `ms` have passed; gives
// whether it holds.
const until = (check: () => boolean, ms: number) =>
  Effect.promise(async () => {
    const end = Date.now() + ms
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5))
    return check()
  })

// The lines of the log since `from`, of the gate's deadline for a stream.
const deadlineLines = (from: number) =>
  parsed().slice(from).filter((line) => line.annotations["fault"] === "deadline")

// The live clock, with a count of the sleeps that have started and not yet
// ended: a timer of a request that still waits is one of them.
const countingClock = () => {
  const live = Effect.runSync(Clock.clockWith(Effect.succeed))
  const counter = { pending: 0 }
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
    currentTimeMillis: live.currentTimeMillis,
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.suspend(() => {
        counter.pending += 1
        return live.sleep(duration).pipe(Effect.ensuring(Effect.sync(() => {
          counter.pending -= 1
        })))
      })
  }
  return { clock, counter }
}

// A `HEAD` is no route's method (lead, ec-hmsqu, ruling 1): Bun pulls no
// stream answer for a `HEAD`, so the gate answers it before any check and any
// work, with the answer of no route.
test("over a connection: a HEAD to a route whose work would answer a stream, one that ends and one that never ends, gets 404 with no body, runs no check and no work, and holds no place; a GET to it runs its work", async () => {
  const gate = gateOf({ request: 300 })
  let worked = 0
  const streaming = (stream: Stream.Stream<Uint8Array>) =>
    Effect.flatMap(chatOf, (chat) =>
      gate.route("R4", chat, () =>
        Effect.sync(() => {
          worked += 1
          return HttpServerResponse.stream(stream, { contentType: "text/plain" })
        })))
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat/ends", streaming(Stream.make(new TextEncoder().encode("one")))),
    HttpRouter.route("GET", "/v1/chats/:chat/never", streaming(Stream.concat(Stream.make(new TextEncoder().encode("one")), Stream.never)))
  ]
  const token = await realToken()
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      const from = lines.length
      const head = (url: string, auth: string) => `HEAD ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${auth}\r\n\r\n`
      // A good token and a bad one: the same 404, before check 2.
      const got = yield* Effect.promise(() =>
        Promise.all([
          ...[token, "a.b"].map((auth) => raw(port, head(`/v1/chats/${A1}/ends`, auth), 300)),
          ...[token, "a.b"].map((auth) => raw(port, head(`/v1/chats/${A1}/never`, auth), 300))
        ])
      )
      for (const answer of got) {
        expect(answer.got).toStartWith("HTTP/1.1 404")
        expect(answer.got.toLowerCase()).toContain("cache-control: no-store")
        expect(answer.got.toLowerCase()).not.toContain("access-control-")
      }
      expect(worked).toBe(0)
      expect(gate.inFlight()).toBe(0)
      expect(parsed().slice(from).map((line) => line.annotations)).toEqual(Array(4).fill({ route: "R4", status: 404 }))
      const text = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/v1/chats/${A1}/ends`, { headers: { authorization: "Bearer " + token } }).then((r) => r.text()))
      expect(text).toBe("one")
      expect(worked).toBe(1)
      expect(yield* until(() => gate.inFlight() === 0, 2_000)).toBe(true)
    }))
})

test("over a connection: a GET whose stream is read to its end gives the place back at the stream's end, before the deadline", async () => {
  const gate = gateOf({ request: 10_000 })
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat/ends", Effect.flatMap(chatOf, (chat) =>
      gate.route("R4", chat, () =>
        Effect.succeed(HttpServerResponse.stream(Stream.make(new TextEncoder().encode("one"), new TextEncoder().encode("two")), { contentType: "text/plain" })))))
  ]
  const token = await realToken()
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      const from = lines.length
      const start = Date.now()
      const text = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/v1/chats/${A1}/ends`, { headers: { authorization: "Bearer " + token } }).then((r) => r.text()))
      expect(text).toBe("onetwo")
      expect(yield* until(() => gate.inFlight() === 0, 2_000)).toBe(true)
      expect(Date.now() - start).toBeLessThan(10_000)
      expect(deadlineLines(from)).toEqual([])
    }))
})

test("over a connection: a stream that ends before the deadline leaves no timer of its request", async () => {
  const gate = gateOf({ request: 10_000 })
  const { clock, counter } = countingClock()
  const sent = Effect.runSync(Deferred.make<void>())
  const finish = Effect.runSync(Deferred.make<void>())
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat/ends", Effect.flatMap(chatOf, (chat) =>
      gate.route("R4", chat, () =>
        Effect.succeed(HttpServerResponse.stream(
          Stream.make(new TextEncoder().encode("one")).pipe(
            Stream.concat(Stream.fromEffect(Effect.andThen(Deferred.succeed(sent, undefined), Deferred.await(finish)).pipe(Effect.as(new TextEncoder().encode("two")))))
          ),
          { contentType: "text/plain" }
        )))).pipe(
        Effect.provideService(Clock.Clock, clock)
      ))
  ]
  const token = await realToken()
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      const answer = fetch(`http://127.0.0.1:${port}/v1/chats/${A1}/ends`, { headers: { authorization: "Bearer " + token } }).then((r) => r.text())
      // While the stream runs, the deadline's timer waits, on this clock.
      yield* Deferred.await(sent)
      expect(counter.pending).toBe(1)
      expect(gate.inFlight()).toBe(1)
      yield* Deferred.succeed(finish, undefined)
      expect(yield* Effect.promise(() => answer)).toBe("onetwo")
      expect(yield* until(() => gate.inFlight() === 0, 2_000)).toBe(true)
      // Once the stream has ended, no sleep of the request waits.
      expect(yield* until(() => counter.pending === 0, 2_000)).toBe(true)
    }))
})

test("over a connection: a GET whose stream runs at the deadline is interrupted, and its place goes back only when it has ended", async () => {
  const gate = gateOf({ request: 300 })
  const inside = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  let heldAtEnd: number | undefined
  let after = false
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat/runs", Effect.flatMap(chatOf, (chat) =>
      gate.route("R4", chat, () =>
        Effect.succeed(HttpServerResponse.stream(
          Stream.make(new TextEncoder().encode("partial")).pipe(
            // A part of the stream that no interrupt stops: it runs past the
            // deadline, until the test lets it end.
            Stream.concat(Stream.fromEffect(Effect.uninterruptible(Effect.andThen(Deferred.succeed(inside, undefined), Deferred.await(release)).pipe(
              Effect.andThen(Effect.sync(() => {
                heldAtEnd = gate.inFlight()
                return new TextEncoder().encode("")
              }))
            )))),
            Stream.concat(Stream.fromEffect(Effect.sync(() => {
              after = true
              return new TextEncoder().encode("after")
            })))
          ),
          { contentType: "text/plain" }
        )))))
  ]
  const token = await realToken()
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      const from = lines.length
      const answer = raw(port, `GET /v1/chats/${A1}/runs HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n\r\n`, 5_000)
      yield* Deferred.await(inside)
      // The deadline passes while that part runs: the place is still held.
      expect(yield* until(() => deadlineLines(from).length === 1, 5_000)).toBe(true)
      expect(gate.inFlight()).toBe(1)
      yield* Deferred.succeed(release, undefined)
      expect(yield* until(() => gate.inFlight() === 0, 2_000)).toBe(true)
      // The place was held to the end of the part, and the stream stopped
      // there: nothing after it ran, and the connection closed with no last
      // chunk.
      expect(heldAtEnd).toBe(1)
      expect(after).toBe(false)
      const got = yield* Effect.promise(() => answer)
      expect(got.got).toStartWith("HTTP/1.1 200")
      expect(got.got).toContain("partial")
      expect(got.got).not.toContain("after")
      expect(got.got).not.toContain("\r\n0\r\n\r\n")
      expect(got.closed).toBe(true)
      expect(deadlineLines(from).map((line) => line.annotations)).toEqual([{ route: "R4", status: 200, fault: "deadline", closed: true }])
    }))
})

test("a stream answer that started and is not pulled at the deadline (its client reads no more) is stopped there, and its place goes back", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    let made = 0
    const response = yield* call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () =>
      Effect.succeed(HttpServerResponse.stream(Stream.fromEffectRepeat(Effect.sync(() => new TextEncoder().encode(String(made++)))), { contentType: "text/plain" })))
    const reader = HttpServerResponse.toWeb(response).body!.getReader()
    expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
    yield* settle
    // The client reads no more: the stream waits for a pull.
    const before = made
    yield* settle
    expect(made).toBe(before)
    expect(gate.inFlight()).toBe(1)
    yield* TestClock.adjust(DEFAULTS.request)
    yield* settle
    expect(gate.inFlight()).toBe(0)
    expect(made).toBe(before)
    // What was queued, then the end of the stream: it failed, and nothing
    // more of it ran.
    const rest = yield* Effect.promise(async () => {
      try {
        for (;;) if ((await reader.read()).done) return "done"
      } catch {
        return "failed"
      }
    })
    expect(rest).toBe("failed")
    expect(made).toBe(before)
  }))
})

test("a stream answer that nothing starts gives its place back at the deadline, and fails if it starts later: no work of it runs", async () => {
  const gate = gateOf()
  let ran = false
  await run(Effect.gen(function*() {
    const response = yield* call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () =>
      Effect.succeed(HttpServerResponse.stream(Stream.fromEffect(Effect.sync(() => {
        ran = true
        return new TextEncoder().encode("late")
      })), { contentType: "text/plain" })))
    expect(gate.inFlight()).toBe(1)
    yield* TestClock.adjust(DEFAULTS.request - 1)
    yield* settle
    expect(gate.inFlight()).toBe(1)
    yield* TestClock.adjust(1)
    yield* settle
    expect(gate.inFlight()).toBe(0)
    // Started after its deadline, the stream fails at once.
    const read = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text().then(() => "read", () => "failed"))
    expect(read).toBe("failed")
    expect(ran).toBe(false)
    expect(gate.inFlight()).toBe(0)
  }))
})

// No route, and the method (lead, ec-hmsqu, ruling 1)
// ----------------------------------------------------

const routed = (
  gate: Gate,
  name: Route,
  req: HttpServerRequest.HttpServerRequest,
  chat: string | undefined,
  work: (found: Found, steps: Steps) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown> = ok
) => gate.route(name, chat, work).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))

// A work that holds its place until `latch` is done; `started` when it runs.
const holder = (gate: Gate) =>
  Effect.gen(function*() {
    const latch = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () =>
      Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(latch), jsonAnswer({})))))
    yield* Deferred.await(started)
    return { release: Effect.andThen(Deferred.succeed(latch, undefined), Fiber.join(fiber)) }
  })

test("a request that is no route gets 404 with the three headers, no body and no CORS header, and takes a place and gives it back; with `requests` 1 and the place taken it gets 503 busy with retry-after 1", async () => {
  const gate = gateOf({ requests: 1 })
  const none = (headers: Record<string, string>) =>
    gate.none.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request("/v1/nothing/here", { headers })))
  await run(Effect.gen(function*() {
    const from = lines.length
    for (const headers of [{}, { origin: ORIGIN }, authorized({ origin: "https://evil.example" })]) {
      const answer = yield* Effect.flatMap(none(headers), (r) => Effect.promise(() => seen(r)))
      expect(answer.status).toBe(404)
      expect(answer.text).toBe("")
      expect(Object.keys(answer.headers).filter((name) => name.startsWith("access-control-") || name === "vary")).toEqual([])
      expect(gate.inFlight()).toBe(0)
    }
    expect(parsed().slice(from).map((line) => line.annotations)).toEqual(Array(3).fill({ route: "none", status: 404 }))
    // The one place taken: no room for it.
    const held = yield* holder(gate)
    const busy = yield* Effect.flatMap(none({ origin: ORIGIN }), (r) => Effect.promise(() => seen(r)))
    expect(busy.status).toBe(503)
    expect(busy.headers["retry-after"]).toBe("1")
    expect(busy.text).toBe(errorText("busy"))
    expect(busy.headers["access-control-allow-origin"]).toBe(ORIGIN)
    expect(gate.inFlight()).toBe(1)
    yield* held.release
    expect(gate.inFlight()).toBe(0)
    expect((yield* none({})).status).toBe(404)
  }))
})

test("a method that is not its route's (HEAD, PUT, DELETE to R2 to R5, GET to R1) gets the 404 of no route after its place, and runs no check and no work: a bad token and an origin off the list get it too", async () => {
  const { chats, calls } = counting()
  const gate = gateOf({}, chats)
  const before = worked
  const cases: ReadonlyArray<readonly [Route, string]> = [
    ...(["R2", "R3", "R4", "R5"] as const).flatMap((name) => ["HEAD", "PUT", "DELETE"].map((method) => [name, method] as const)),
    ["R1", "GET"],
    ["R1", "HEAD"]
  ]
  for (const [name, method] of cases) {
    for (const headers of [authorized(), { authorization: "Bearer a.b" }, authorized({ origin: "https://evil.example" }), { authorization: "Bearer " + FAILING[2]?.[1] }]) {
      lines.length = 0
      const answer = await seen(await run(routed(gate, name, request("/v1/chats/" + A1, { method, headers }), A1)))
      expect(answer.status).toBe(404)
      expect(answer.text).toBe("")
      expect(Object.keys(answer.headers).filter((key) => key.startsWith("access-control-"))).toEqual([])
      expect(parsed().map((line) => line.annotations)).toEqual([{ route: name, status: 404 }])
      expect(gate.inFlight()).toBe(0)
    }
  }
  expect(worked).toBe(before)
  expect(calls).toEqual([])
  // Each route's own method passes to its checks: a bad token is 401 there.
  for (const [name, method] of [["R1", "POST"], ["R2", "GET"], ["R3", "GET"], ["R4", "GET"], ["R5", "GET"]] as const) {
    expect((await run(routed(gate, name, request("/v1/chats/" + A1, { method, headers: { authorization: "Bearer a.b" } }), A1))).status).toBe(401)
    expect((await run(routed(gate, name, request("/v1/chats/" + A1, { method, headers: authorized() }), A1))).status).toBe(200)
  }
  expect(worked).toBe(before + 5)
})

// A client's answer (R4; lead, ec-hmsqu, ruling 2)
// ------------------------------------------------

const encode = (text: string) => new TextEncoder().encode(text)
const get = (headers: Record<string, string> = authorized()) => request("/v1/chats/" + A1 + "/events", { headers })

// R4's work in the tests: the checks passed, it says "a client now" with an
// `abandon` that counts, and answers `stream`.
const clientWork = (abandoned: { count: number }, stream: Stream.Stream<Uint8Array, unknown>) => (_found: Found, steps: Steps) =>
  Effect.andThen(
    steps.client(Effect.sync(() => {
      abandoned.count += 1
    })),
    Effect.succeed(HttpServerResponse.stream(stream, { contentType: "text/event-stream" }))
  )

test("after the client's step its place goes back, once, while its stream runs; the stream runs past `request` and the gate does not end it; `abandon` runs one time at the stream's end", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const held = yield* holder(gate)
    const abandoned = { count: 0 }
    let made = 0
    const counts: Array<number> = []
    const response = yield* routed(gate, "R4", get(), A1, (found, steps) =>
      Effect.andThen(Effect.sync(() => counts.push(gate.inFlight())), clientWork(abandoned, Stream.fromEffectRepeat(Effect.sync(() => encode(String(made++)))))(found, steps)).pipe(
        // A second step changes nothing.
        Effect.tap(() => steps.client(Effect.sync(() => abandoned.count += 100))),
        Effect.tap(() => Effect.sync(() => counts.push(gate.inFlight())))
      ))
    expect(counts).toEqual([2, 1])
    expect(gate.inFlight()).toBe(1)
    const reader = HttpServerResponse.toWeb(response).body!.getReader()
    expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
    expect(gate.inFlight()).toBe(1)
    yield* held.release
    expect(gate.inFlight()).toBe(0)
    const from = lines.length
    yield* TestClock.adjust(3 * DEFAULTS.request)
    yield* settle
    const before = made
    expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
    yield* settle
    expect(made).toBeGreaterThan(before)
    expect(deadlineLines(from)).toEqual([])
    expect(abandoned.count).toBe(0)
    expect(gate.inFlight()).toBe(0)
    yield* Effect.promise(() => reader.cancel())
    yield* settle
    expect(abandoned.count).toBe(1)
    expect(gate.inFlight()).toBe(0)
  }))
})

test("a client's stream that has not started at the deadline: `abandon` runs one time there, and a start after it fails at once and runs none of its work", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const abandoned = { count: 0 }
    let ran = false
    const from = lines.length
    const response = yield* routed(gate, "R4", get(), A1, clientWork(abandoned, Stream.fromEffect(Effect.sync(() => {
      ran = true
      return encode("late")
    }))))
    expect(gate.inFlight()).toBe(0)
    yield* TestClock.adjust(DEFAULTS.request - 1)
    yield* settle
    expect(abandoned.count).toBe(0)
    yield* TestClock.adjust(1)
    yield* settle
    expect(abandoned.count).toBe(1)
    expect(deadlineLines(from).map((line) => line.annotations)).toEqual([{ route: "R4", status: 200, fault: "deadline" }])
    const read = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text().then(() => "read", () => "failed"))
    yield* settle
    expect(read).toBe("failed")
    expect(ran).toBe(false)
    expect(abandoned.count).toBe(1)
    expect(gate.inFlight()).toBe(0)
  }))
})

test("a work that fails after the client's step gets its error answer, or 500 internal; `abandon` runs one time and its place does not go back twice; an answer that is no stream runs `abandon` too", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const held = yield* holder(gate)
    const works: ReadonlyArray<readonly [number, (abandoned: { count: number }) => (found: Found, steps: Steps) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>]> = [
      [429, (a) => (f, s) => Effect.andThen(clientWork(a, Stream.never)(f, s), Effect.fail(new Refused({ code: "too_many", retryAfter: 3 })))],
      [500, (a) => (f, s) => Effect.andThen(clientWork(a, Stream.never)(f, s), Effect.fail("a fault"))],
      [500, (a) => (f, s) => Effect.andThen(clientWork(a, Stream.never)(f, s), Effect.die("a defect"))],
      [200, (a) => (f, s) => Effect.andThen(clientWork(a, Stream.never)(f, s), Effect.succeed(jsonAnswer({})))]
    ]
    for (const [status, work] of works) {
      const abandoned = { count: 0 }
      const answer = yield* Effect.flatMap(routed(gate, "R4", get(), A1, work(abandoned)), (r) => Effect.promise(() => seen(r)))
      expect(answer.status).toBe(status)
      yield* settle
      expect(abandoned.count).toBe(1)
      expect(gate.inFlight()).toBe(1)
    }
    yield* held.release
    expect(gate.inFlight()).toBe(0)
  }))
})

test("an interruption between the client's step and its stream's start (its client went away) runs `abandon` one time; so does the deadline in that span, with 503 busy", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const held = yield* holder(gate)
    const abandoned = { count: 0 }
    const stepped = yield* Deferred.make<void>()
    const waits = (found: Found, steps: Steps) =>
      Effect.andThen(clientWork(abandoned, Stream.never)(found, steps), Effect.andThen(Deferred.succeed(stepped, undefined), Effect.never))
    const fiber = yield* Effect.forkChild(routed(gate, "R4", get(), A1, waits))
    yield* Deferred.await(stepped)
    expect(gate.inFlight()).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(abandoned.count).toBe(1)
    expect(gate.inFlight()).toBe(1)
    yield* held.release
    expect(gate.inFlight()).toBe(0)
    // The deadline: the work is interrupted, and the answer is 503.
    const late = { count: 0 }
    const latch = yield* Deferred.make<void>()
    const timed = yield* Effect.forkChild(routed(gate, "R4", get(), A1, (found, steps) =>
      Effect.andThen(clientWork(late, Stream.never)(found, steps), Effect.andThen(Deferred.succeed(latch, undefined), Effect.never))))
    yield* Deferred.await(latch)
    yield* settle
    yield* TestClock.adjust(DEFAULTS.request)
    const answer = yield* Effect.flatMap(Fiber.join(timed), (r) => Effect.promise(() => seen(r)))
    expect(answer.status).toBe(503)
    expect(answer.headers["retry-after"]).toBe("1")
    expect(late.count).toBe(1)
    expect(gate.inFlight()).toBe(0)
  }))
})

test("a stream answer of a work that did not run the client's step keeps its place and its deadline", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    let made = 0
    const response = yield* routed(gate, "R4", get(), A1, () =>
      Effect.succeed(HttpServerResponse.stream(Stream.fromEffectRepeat(Effect.sync(() => encode(String(made++)))), { contentType: "text/event-stream" })))
    expect(gate.inFlight()).toBe(1)
    const reader = HttpServerResponse.toWeb(response).body!.getReader()
    expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
    expect(gate.inFlight()).toBe(1)
    yield* TestClock.adjust(DEFAULTS.request)
    yield* settle
    expect(gate.inFlight()).toBe(0)
    const rest = yield* Effect.promise(async () => {
      try {
        for (;;) if ((await reader.read()).done) return "done"
      } catch {
        return "failed"
      }
    })
    expect(rest).toBe("failed")
  }))
})

// On a real server a client's stream that nothing pulls does not occur: Effect
// starts the stream of a `Response` at once, a web stream pulls once by
// itself, and Effect's Bun server interrupts the request's fiber, or the
// stream, when its client goes away. So a client that goes away before its
// head ends its client at once, through the work's interruption or the
// stream's end; the deadline's case is the TestClock's, above.
test("over a connection: a client that goes away after its step and before its head: `abandon` runs one time, and not again at the deadline; no place and no timer of it is left", async () => {
  const gate = gateOf({ request: 300 })
  const { clock, counter } = countingClock()
  const abandoned = { count: 0 }
  let stepped = false
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat/events", Effect.flatMap(chatOf, (chat) =>
      gate.route("R4", chat, (found, steps) =>
        Effect.andThen(clientWork(abandoned, Stream.never)(found, steps), Effect.andThen(Effect.sync(() => {
          stepped = true
        }), Effect.never)))).pipe(Effect.provideService(Clock.Clock, clock)))
  ]
  const token = await realToken()
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      let got = ""
      const closed = new Promise<void>((resolve) => {
        void Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(socket) {
              socket.write(`GET /v1/chats/${A1}/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n\r\n`)
              const wait = setInterval(() => {
                if (!stepped) return
                clearInterval(wait)
                socket.end()
              }, 2)
            },
            data(_socket, data) {
              got += new TextDecoder().decode(data)
            },
            close() {
              resolve()
            }
          }
        })
      })
      yield* Effect.promise(() => closed)
      expect(got).toBe("")
      expect(yield* until(() => abandoned.count === 1, 2_000)).toBe(true)
      expect(gate.inFlight()).toBe(0)
      // Past the deadline: no second run, and no timer waits.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)))
      expect(abandoned.count).toBe(1)
      expect(counter.pending).toBe(0)
    }))
})

// A place again (R5; lead, ec-hmsqu, ruling 3)
// --------------------------------------------

test("R5's `leave` gives the place back and stops the deadline: its wait runs past `request`; `again` takes a place with a new deadline of `request` from that moment", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const left = yield* Deferred.make<void>()
    const woke = yield* Deferred.make<void>()
    const taken = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(routed(gate, "R5", get(), A1, (_found, steps) =>
      Effect.gen(function*() {
        yield* steps.leave
        yield* steps.leave
        yield* Deferred.succeed(left, undefined)
        yield* Deferred.await(woke)
        yield* steps.again
        yield* steps.again
        yield* Deferred.succeed(taken, undefined)
        return yield* Effect.as(Effect.never, jsonAnswer({}))
      })))
    yield* Deferred.await(left)
    expect(gate.inFlight()).toBe(0)
    yield* settle
    yield* TestClock.adjust(3 * DEFAULTS.request)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(woke, undefined)
    yield* Deferred.await(taken)
    expect(gate.inFlight()).toBe(1)
    yield* settle
    yield* TestClock.adjust(DEFAULTS.request - 1)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    yield* settle
    expect(fiber.pollUnsafe()).toBeDefined()
    const answer = yield* Effect.flatMap(Fiber.join(fiber), (r) => Effect.promise(() => seen(r)))
    expect(answer.status).toBe(503)
    expect(answer.headers["retry-after"]).toBe("1")
    expect(gate.inFlight()).toBe(0)
  }))
})

test("R5's `again` with no place free gets 503 busy with retry-after 1 at once, with no queue; with one free, the work goes on", async () => {
  const gate = gateOf({ requests: 1 })
  await run(Effect.gen(function*() {
    const left = yield* Deferred.make<void>()
    const woke = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(routed(gate, "R5", get(), A1, (_found, steps) =>
      Effect.gen(function*() {
        yield* steps.leave
        yield* Deferred.succeed(left, undefined)
        yield* Deferred.await(woke)
        yield* steps.again
        return jsonAnswer({ again: true })
      })))
    yield* Deferred.await(left)
    // Another request takes the one place while the R5 waits.
    const held = yield* holder(gate)
    yield* Deferred.succeed(woke, undefined)
    yield* settle
    expect(fiber.pollUnsafe()).toBeDefined()
    const answer = yield* Effect.flatMap(Fiber.join(fiber), (r) => Effect.promise(() => seen(r)))
    expect(answer.status).toBe(503)
    expect(answer.headers["retry-after"]).toBe("1")
    expect(answer.text).toBe(errorText("busy"))
    expect(gate.inFlight()).toBe(1)
    yield* held.release
    expect(gate.inFlight()).toBe(0)
    // With the place free, `again` takes it.
    const free = yield* Effect.flatMap(routed(gate, "R5", get(), A1, (_found, steps) =>
      Effect.andThen(Effect.andThen(steps.leave, steps.again), Effect.sync(() => jsonAnswer({ inFlight: gate.inFlight() })))), (r) => Effect.promise(() => seen(r)))
    expect(JSON.parse(free.text)).toEqual({ inFlight: 1 })
    expect(gate.inFlight()).toBe(0)
  }))
})

test("an interruption between `leave` and `again` leaves `inFlight` at 0, and one after `again` gives the place back once", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const held = yield* holder(gate)
    for (const takeAgain of [false, true]) {
      const waiting = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(routed(gate, "R5", get(), A1, (_found, steps) =>
        Effect.gen(function*() {
          yield* steps.leave
          if (takeAgain) yield* steps.again
          yield* Deferred.succeed(waiting, undefined)
          return yield* Effect.as(Effect.never, jsonAnswer({}))
        })))
      yield* Deferred.await(waiting)
      expect(gate.inFlight()).toBe(takeAgain ? 2 : 1)
      yield* Fiber.interrupt(fiber)
      expect(gate.inFlight()).toBe(1)
    }
    yield* held.release
    expect(gate.inFlight()).toBe(0)
  }))
})

// The socket's admission (R6; lead, ec-hmsqu, ruling 4)
// -----------------------------------------------------

const upgradeRequest = (headers: Record<string, string> = {}, method = "GET") =>
  request("/v1/chats/" + A1 + "/socket", { method, headers: { upgrade: "websocket", ...headers } })

const socketCall = (
  gate: Gate,
  req: HttpServerRequest.HttpServerRequest,
  work: (upgrading: Upgrading) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>
) => gate.socket(A1, work).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))

test("R6: no Upgrade header, another upgrade or another method gets the 404 of no route; an origin off the list gets 403 before the work; a header Authorization, good or bad, changes nothing", async () => {
  const { chats, calls } = counting()
  const gate = gateOf({}, chats)
  let ran = 0
  const work = (upgrading: Upgrading) =>
    Effect.sync(() => {
      ran += 1
      return jsonAnswer({ chat: upgrading.chat })
    })
  for (const req of [
    request("/v1/chats/" + A1 + "/socket", { headers: authorized() }),
    upgradeRequest({ upgrade: "h2c" }),
    upgradeRequest({}, "POST"),
    upgradeRequest({}, "HEAD"),
    upgradeRequest({}, "PUT")
  ]) {
    lines.length = 0
    const answer = await seen(await run(socketCall(gate, req, work)))
    expect(answer.status).toBe(404)
    expect(answer.text).toBe("")
    expect(parsed().map((line) => line.annotations)).toEqual([{ route: "R6", status: 404 }])
  }
  expect(ran).toBe(0)
  lines.length = 0
  const off = await seen(await run(socketCall(gate, upgradeRequest({ origin: "https://evil.example" }), work)))
  expect(off.status).toBe(403)
  expect(off.text).toBe(errorText("forbidden_origin"))
  expect(parsed().map((line) => line.annotations)).toEqual([{ route: "R6", status: 403, error: "forbidden_origin" }])
  expect(ran).toBe(0)
  const answers = []
  for (const headers of [{}, authorized(), { authorization: "Bearer a.b" }, { authorization: "Basic x" }, { upgrade: "WebSocket", origin: ORIGIN }]) {
    answers.push(await seen(await run(socketCall(gate, upgradeRequest(headers), work))))
  }
  for (const answer of answers) {
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.text)).toEqual({ chat: A1 })
  }
  expect(ran).toBe(5)
  expect(calls).toEqual([])
  expect(gate.inFlight()).toBe(0)
})

test("R6's `admit` takes a waiting place and gives the request's place back in one step, and ends the gate's deadline; past `waiting` it gets 503 busy with no retry-after, keeps its place until its answer and holds no waiting place; the second step gives the waiting place back one time, also run twice", async () => {
  const gate = gateOf({ waiting: 1 })
  await run(Effect.gen(function*() {
    const admitted = yield* Deferred.make<Effect.Effect<void>>()
    const hold = yield* Deferred.make<void>()
    const counts: Array<readonly [number, number]> = []
    const first = yield* Effect.forkChild(socketCall(gate, upgradeRequest(), (upgrading) =>
      Effect.gen(function*() {
        counts.push([gate.inFlight(), gate.waiting()])
        const done = yield* upgrading.admit
        counts.push([gate.inFlight(), gate.waiting()])
        // Again: the same second step, and nothing taken.
        const same = yield* upgrading.admit
        counts.push([gate.inFlight(), gate.waiting()])
        expect(same).toBeDefined()
        yield* Deferred.succeed(admitted, done)
        yield* Deferred.await(hold)
        return HttpServerResponse.empty()
      })))
    const done = yield* Deferred.await(admitted)
    expect(counts).toEqual([[1, 0], [0, 1], [0, 1]])
    // From the upgrade the gate's deadline is over.
    yield* settle
    yield* TestClock.adjust(3 * DEFAULTS.request)
    yield* settle
    expect(first.pollUnsafe()).toBeUndefined()
    // A second socket: no waiting place.
    let atRefusal: number | undefined
    let after = false
    const refused = yield* Effect.flatMap(socketCall(gate, upgradeRequest(), (upgrading) =>
      Effect.gen(function*() {
        const tried = yield* Effect.exit(upgrading.admit)
        atRefusal = gate.inFlight()
        yield* tried
        after = true
        return HttpServerResponse.empty()
      })), (r) => Effect.promise(() => seen(r)))
    expect(refused.status).toBe(503)
    expect(refused.text).toBe(errorText("busy"))
    expect(refused.headers["retry-after"]).toBeUndefined()
    expect(atRefusal).toBe(1)
    expect(after).toBe(false)
    expect(gate.waiting()).toBe(1)
    expect(gate.inFlight()).toBe(0)
    // The second step, twice: the waiting place goes back once.
    yield* done
    yield* done
    expect(gate.waiting()).toBe(0)
    yield* Deferred.succeed(hold, undefined)
    yield* Fiber.join(first)
    expect(gate.waiting()).toBe(0)
    expect(gate.inFlight()).toBe(0)
    // A socket whose work ends with no second step gives its waiting place
    // back at its end; one that never admits is ended at the deadline.
    yield* socketCall(gate, upgradeRequest(), (upgrading) => Effect.as(upgrading.admit, HttpServerResponse.empty()))
    expect(gate.waiting()).toBe(0)
    const slow = yield* Effect.forkChild(socketCall(gate, upgradeRequest(), () => Effect.as(Effect.never, HttpServerResponse.empty())))
    yield* settle
    yield* TestClock.adjust(DEFAULTS.request)
    const timed = yield* Fiber.join(slow)
    expect(timed.status).toBe(503)
    expect(gate.inFlight()).toBe(0)
  }))
})

test("over a connection: a socket admitted by the gate upgrades, waits in a waiting place for its first frame, and gives it back", async () => {
  const gate = gateOf()
  const routes = [
    HttpRouter.route("GET", "/v1/chats/:chat/socket", Effect.flatMap(chatOf, (chat) =>
      gate.socket(chat, (upgrading) =>
        Effect.scoped(Effect.gen(function*() {
          const done = yield* upgrading.admit
          const socket = yield* upgrading.request.upgrade
          const reader = yield* socket.reader
          const writer = yield* socket.writer
          yield* reader.pull
          yield* done
          yield* writer.write("ready")
          yield* Effect.ignore(reader.pull)
          return HttpServerResponse.empty()
        })))))
  ]
  await serving(gate, routes, (port) =>
    Effect.gen(function*() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chats/${A1}/socket`)
      const got: Array<string> = []
      ws.onmessage = (event) => got.push(String(event.data))
      yield* Effect.promise(() => new Promise((resolve) => (ws.onopen = resolve)))
      expect(yield* until(() => gate.waiting() === 1, 2_000)).toBe(true)
      expect(gate.inFlight()).toBe(0)
      ws.send(JSON.stringify({ type: "auth" }))
      expect(yield* until(() => got.length === 1, 2_000)).toBe(true)
      expect(got).toEqual(["ready"])
      expect(gate.waiting()).toBe(0)
      ws.close()
      expect(yield* until(() => gate.inFlight() === 0 && gate.waiting() === 0, 2_000)).toBe(true)
    }))
})

// The socket's token (R6; lead, ec-hmsqu, ruling 5)
// -------------------------------------------------

const checkToken = (gate: Gate, text: string, chat: string | undefined, at = NOW) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(at), Effect.exit(gate.token(text, chat))).pipe(Effect.provide(Layer.merge(TestClock.layer(), capture))))

const refusalOf = (exit: Exit.Exit<Authorized, SocketRefused>) => Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : "passed"

test("R6's token: each cause of a failure gives `unauthorized` and one log line with its check's number and no part of the token; an `exp` that passed on the TestClock too", async () => {
  const gate = gateOf()
  const cases: ReadonlyArray<readonly [number, string]> = [...FAILING, [2, ""], [2, "Bearer " + TOKEN], [2, TOKEN + " "]]
  for (const [check, text] of cases) {
    lines.length = 0
    expect(refusalOf(await checkToken(gate, text, A1))).toBe("unauthorized")
    expect(parsed().map((line) => line.annotations)).toEqual([{ route: "R6", status: 401, error: "unauthorized", check }])
    for (const piece of text.split(/[ .]/).filter((p) => p.length >= 8)) expect(lines[0]).not.toContain(piece)
  }
  // `exp` is S + 600: good one second before, refused at it.
  expect(refusalOf(await checkToken(gate, TOKEN, A1, (S + 599) * 1000))).toBe("passed")
  lines.length = 0
  expect(refusalOf(await checkToken(gate, TOKEN, A1, (S + 600) * 1000))).toBe("unauthorized")
  expect(parsed().map((line) => line.annotations)).toEqual([{ route: "R6", status: 401, error: "unauthorized", check: 6 }])
  expect(gate.inFlight()).toBe(0)
})

test("R6's token: a chat outside the token, B's chat with a token of A (named or not) and a text that is no UUID give the same `no_chat`; nothing of B's chat is read but the lookup that finds none, and B's rows stay; a good token gives the four fields", async () => {
  const { chats, calls, used } = counting()
  const gate = gateOf({}, chats)
  const rowsOfB = () => Effect.runPromise(Effect.flatMap(sqlChats.reads(TENANT_B, B1), (reads) => Effect.map(Effect.all([reads.chat, reads.messages(0, 1000), reads.eventsAfter(0, 1000)]), (all) => JSON.stringify(all))))
  const before = await rowsOfB()
  const refusals = [
    await checkToken(gate, ONLY_A1, A2),
    await checkToken(gate, ONLY_A1, B1),
    await checkToken(gate, TOKEN, B1),
    await checkToken(gate, TOKEN, "not-a-uuid"),
    await checkToken(gate, TOKEN, A1.toUpperCase()),
    await checkToken(gate, TOKEN, undefined)
  ]
  for (const exit of refusals) expect(refusalOf(exit)).toBe("no_chat")
  expect(calls).toEqual([{ tenant: TENANT_A, chat: B1 }])
  expect(used).toEqual([])
  expect(await rowsOfB()).toBe(before)
  const good = await checkToken(gate, TOKEN, A1)
  expect(Exit.isSuccess(good)).toBe(true)
  const found = Exit.isSuccess(good) ? good.value : undefined
  expect(Object.keys(found ?? {}).sort()).toEqual(["chat", "claims", "reads", "tenant"])
  expect(found?.tenant).toBe(TENANT_A)
  expect(found?.chat).toBe(A1)
  expect(found?.claims).toEqual(GOOD)
  expect((await Effect.runPromise(found!.reads.chat)).uuid).toBe(A1)
})

test("R6's token: a fault of the store gives `internal` with its log line", async () => {
  const broken: typeof Chats.Service = { ...sqlChats, reads: () => Effect.fail(new StoreError({ op: "reads", cause: new Error("headervalue1234") })) }
  const gate = gateOf({}, broken)
  lines.length = 0
  expect(refusalOf(await checkToken(gate, TOKEN, A1))).toBe("internal")
  expect(parsed().map((line) => line.annotations)).toEqual([{ route: "R6", status: 500, error: "internal", fault: "StoreError" }])
})

// A whole number of a query (lead, ec-hmsqu, ruling 6)
// ----------------------------------------------------

test("wholeNumber: decimal digits only, at most 16, at most 2**53 - 1", () => {
  for (const [text, value] of [["0", 0], ["7", 7], ["9007199254740991", 9007199254740991], ["0000000000000042", 42], ["0000000000000000", 0]] as const) {
    expect(wholeNumber(text)).toBe(value)
  }
  for (const text of ["9007199254740992", "9999999999999999", "00000000000000001", "12345678901234567", "-1", "+1", "1.5", "1e3", " 1", "1 ", "", "١", "0x10", "1_000", "Infinity", "NaN"]) {
    expect(wholeNumber(text)).toBeUndefined()
  }
  expect(wholeNumber(undefined)).toBeUndefined()
})

// No timer or fiber of a request is left after its end
// ----------------------------------------------------

test("no timer of a request is left after its end: a plain answer, a client's stream read to its end, one that never starts, R5's leave and again, and a socket", async () => {
  const gate = gateOf({ request: 200 })
  const { clock, counter } = countingClock()
  const live = <A, E>(effect: Effect.Effect<A, E, HttpServerRequest.HttpServerRequest>, req: HttpServerRequest.HttpServerRequest) =>
    Effect.runPromise(effect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req), Effect.provideService(Clock.Clock, clock), Effect.provide(capture)))
  const token = await realToken()
  const auth = { authorization: "Bearer " + token }
  const real = (url: string) => request(url, { headers: auth })
  const idle = () => new Promise((resolve) => setTimeout(resolve, 20))
  // A plain answer.
  expect((await live(gate.route("R2", A1, ok), real("/v1/chats/" + A1))).status).toBe(200)
  await idle()
  expect(counter.pending).toBe(0)
  // A client's stream read to its end.
  const abandoned = { count: 0 }
  const streamed = await live(gate.route("R4", A1, clientWork(abandoned, Stream.make(encode("one")))), real("/v1/chats/" + A1))
  expect(counter.pending).toBe(1)
  expect(await HttpServerResponse.toWeb(streamed).text()).toBe("one")
  await idle()
  expect(counter.pending).toBe(0)
  expect(abandoned.count).toBe(1)
  // A client's stream that never starts: its timer until the deadline.
  const never = { count: 0 }
  await live(gate.route("R4", A1, clientWork(never, Stream.make(encode("one")))), real("/v1/chats/" + A1))
  expect(counter.pending).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(counter.pending).toBe(0)
  expect(never.count).toBe(1)
  // R5's leave and again.
  expect((await live(gate.route("R5", A1, (_found, steps) => Effect.andThen(Effect.andThen(steps.leave, steps.again), Effect.succeed(jsonAnswer({})))), real("/v1/chats/" + A1))).status).toBe(200)
  await idle()
  expect(counter.pending).toBe(0)
  // A socket.
  await live(gate.socket(A1, (upgrading) => Effect.flatMap(upgrading.admit, (done) => Effect.as(done, HttpServerResponse.empty()))), upgradeRequest())
  await idle()
  expect(counter.pending).toBe(0)
  expect(gate.inFlight()).toBe(0)
  expect(gate.waiting()).toBe(0)
})

// Interruption at each step (lead, ec-w86sz)
// ------------------------------------------
// A request is run on Effect's ordinary scheduler, whose `shouldYield` is
// stepped: it counts the operations of the request's own fiber (the first
// that runs) and, at the operation `stop`, yields there and interrupts that
// fiber while it waits, as a client that goes away does. A run with no stop
// counts the operations of each kind of request; the sweep then stops at each
// of them. The clock is fixed at `NOW` and its sleeps are real timers that
// it counts, so a timer of the request that is left shows.

// A clock at `NOW` whose sleeps are real timers, with a count of those that
// have started and not ended.
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

// The kinds of a request of the sweep: no route; a route's work with a JSON
// answer; the socket's member with no `admit`, and with `admit` and its second
// step; a client's step with a stream answer; R5's `leave` and `again`.
const KINDS = ["none", "route", "socket", "admit", "client", "again"] as const
type Kind = (typeof KINDS)[number]

// The `request` of the sweep's gate, in real ms: the deadline of an answer
// that the server took and that nothing starts, and of a client of a direct
// call at the one point of ruling 2 (ec-u1yzx).
const SWEEP_REQUEST = 150

// What is left of a request: the places, the timers and the fibers, and the
// runs of `abandon`.
interface Rest {
  readonly requests: number
  readonly waiting: number
  readonly timers: number
  readonly fibers: number
  readonly abandoned: number
}

// How a trial runs the gate (lead, ec-u1yzx, 4). `server`: as Effect's
// server runs it, the router's handler of the request's path under
// `HttpEffect.toHandled`, which runs it in the request's scope and closes
// that scope when the handler's fiber ends; the answer is taken as Bun's
// server takes it (`scopeTransferToStream`: a stream answer's end closes the
// scope), and read to its end, as Bun's server starts each stream answer.
// `direct`: the gate's effect alone, with no scope in the context.
type Way = "server" | "direct"

// `handler` for the request `req` as Effect's server runs it: the router's
// handler of one route at the request's path, under `HttpEffect.toHandled`
// (no middleware), with the answer taken as Bun's server takes it. The
// router is built in the scope of the context.
const asServer = (handler: Effect.Effect<HttpServerResponse.HttpServerResponse>, req: HttpServerRequest.HttpServerRequest) =>
  Effect.map(HttpRouter.toHttpEffect(HttpRouter.addAll([HttpRouter.route("*", req.url as `/${string}`, handler)])), (app) => {
    const answer: { sent: Response | undefined } = { sent: undefined }
    const program = HttpEffect.toHandled(app, (taken, response) =>
      Effect.sync(() => {
        answer.sent = HttpServerResponse.omitsBody(response, taken.method === "HEAD")
          ? HttpServerResponse.toWeb(response, { withoutBody: true })
          : HttpServerResponse.toWeb(HttpEffect.scopeTransferToStream(response))
      })).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req)) as Effect.Effect<void>
    return { program, answer }
  })

interface Trial {
  readonly stop: number | undefined
  // The request's fiber: its operations, whether it was interrupted, and its
  // exit.
  readonly ops: number
  readonly interrupted: boolean
  readonly exit: Exit.Exit<unknown, unknown>
  // Whether the request's fiber could be interrupted at the stop (Effect's
  // fiber holds that flag; it is not in the `Fiber` interface): false in an
  // uncut step, where the interruption waits for the step's end.
  readonly cutAtStop: boolean | undefined
  // The operation at which the client's step had run (0: it did not run).
  readonly steppedAt: number
  // Whether the first continuation of the gate's result ran (its answer left
  // the gate), and the operation at which it ran.
  readonly delivered: boolean
  readonly leftAt: number
  // What was left when the request's fiber had ended (two turns of the event
  // loop: no wait, no timer's end), and then after the answer that the server
  // took was read to its end.
  readonly atEnd: Rest
  readonly after: Rest
  // For each run of `abandon`, whether the request's fiber still ran.
  readonly abandonedWhileRunning: ReadonlyArray<boolean>
  readonly gate: Gate
  readonly rest: () => Rest
}

const trial = async (kind: Kind, stop: number | undefined, way: Way = "server"): Promise<Trial> => {
  const gate = gateOf({ requests: 1, request: SWEEP_REQUEST })
  const { clock, counter } = timerClock()
  let ops = 0
  let interrupted = false
  let cutAtStop: boolean | undefined
  let steppedAt = 0
  let delivered = false
  let leftAt = 0
  let abandoned = 0
  const abandonedWhileRunning: Array<boolean> = []
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
      cutAtStop = (fiber as unknown as { readonly interruptible: boolean }).interruptible
      queueMicrotask(() => fiber.interruptUnsafe())
      return true
    }
    return fiber.currentOpCount >= 64
  }
  const abandon = Effect.sync(() => {
    abandoned += 1
    abandonedWhileRunning.push(request?.pollUnsafe() === undefined)
  })
  const req = kind === "socket" || kind === "admit" ? upgradeRequest() : get()
  const action: Effect.Effect<HttpServerResponse.HttpServerResponse> = kind === "none"
    ? gate.none.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))
    : kind === "route"
    ? routed(gate, "R2", req, A1, () => Effect.succeed(jsonAnswer({})))
    : kind === "socket"
    ? socketCall(gate, req, () => Effect.succeed(HttpServerResponse.empty()))
    : kind === "admit"
    ? socketCall(gate, req, (upgrading) => Effect.flatMap(upgrading.admit, (done) => Effect.as(done, HttpServerResponse.empty())))
    : kind === "client"
    ? routed(gate, "R4", req, A1, (_found, steps) =>
      Effect.andThen(
        Effect.andThen(steps.client(abandon), Effect.sync(() => {
          steppedAt = ops
        })),
        Effect.succeed(HttpServerResponse.stream(Stream.make(encode("one")), { contentType: "text/event-stream" }))
      ))
    : routed(gate, "R5", req, A1, (_found, steps) => Effect.andThen(Effect.andThen(steps.leave, steps.again), Effect.succeed(jsonAnswer({}))))
  // The marker: the first continuation of the gate's result.
  const marked = Effect.map(action, (response) => {
    delivered = true
    leftAt = ops
    return response
  })
  const routers = Scope.makeUnsafe()
  const served = way === "server" ? await Effect.runPromise(asServer(marked, req).pipe(Effect.provideService(Scope.Scope, routers))) : undefined
  const program: Effect.Effect<unknown> = served?.program ?? marked
  const fiber = Effect.runFork(program.pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(capture)), { scheduler })
  const exit = await Effect.runPromise(Fiber.await(fiber))
  const rest = (): Rest => ({
    requests: gate.inFlight(),
    waiting: gate.waiting(),
    timers: counter.pending,
    fibers: [...fibers].filter((each) => each.pollUnsafe() === undefined).length,
    abandoned
  })
  await turn()
  await turn()
  const atEnd = rest()
  let sent = served?.answer.sent
  if (way === "direct" && Exit.isSuccess(exit) && delivered) {
    const response = exit.value as HttpServerResponse.HttpServerResponse
    if (response.body._tag === "Stream") sent = HttpServerResponse.toWeb(response)
  }
  if (sent?.body != null) await sent.text().catch(() => "")
  await turn()
  await turn()
  const after = rest()
  await Effect.runPromise(Scope.close(routers, Exit.void))
  return { stop, ops, interrupted, cutAtStop, exit, steppedAt, delivered, leftAt, atEnd, after, abandonedWhileRunning, gate, rest }
}

// The operations of a request of `kind` with no stop.
const dryRun = async (kind: Kind, way: Way = "server") => {
  const dry = await trial(kind, undefined, way)
  expect(dry.interrupted).toBe(false)
  expect(Exit.isSuccess(dry.exit)).toBe(true)
  expect(dry.delivered).toBe(true)
  return dry
}

const cleanOf = (abandoned: number): Rest => ({ requests: 0, waiting: 0, timers: 0, fibers: 0, abandoned })

test("an interruption at each operation of a request run as Effect's server runs it (no route, a route, the socket's member, its admit, the client's step, leave and again): when the gate's answer has not left it, nothing of the request is left when its fiber ends, and abandon has run one time while it ran if the client's step ran; with any stop, nothing is left after the answer's end; the next request is answered", async () => {
  const failures: Array<unknown> = []
  const before: Record<string, number> = {}
  for (const kind of KINDS) {
    const total = (await dryRun(kind)).ops
    before[kind] = 0
    for (let stop = 1; stop <= total + 1; stop++) {
      const t = await trial(kind, stop)
      const clean = cleanOf(kind === "client" && t.steppedAt > 0 ? 1 : 0)
      if (!t.delivered) {
        before[kind] += 1
        // No wait and no deadline: all ended with the request's fiber.
        if (JSON.stringify(t.atEnd) !== JSON.stringify(clean)) failures.push({ kind, stop, ops: total, exit: t.exit._tag, atEnd: t.atEnd })
        if (!t.abandonedWhileRunning.every((running) => running)) failures.push({ kind, stop, abandonedAfterTheEnd: t.abandonedWhileRunning })
      }
      if (JSON.stringify(t.after) !== JSON.stringify(clean)) failures.push({ kind, stop, ops: total, exit: t.exit._tag, after: t.after })
      // The next request gets its answer, not 503.
      const next = await Effect.runPromise(t.gate.none.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, get()), Effect.provide(capture)))
      if (next.status !== 404) failures.push({ kind, stop, next: next.status })
    }
  }
  expect(failures).toEqual([])
  // Each kind had stops before its answer left the gate.
  for (const kind of KINDS) expect([kind, before[kind]! > 0]).toEqual([kind, true])
}, 20_000)

test("an interruption at each operation from the client's step to the first continuation of the gate's result, run as Effect's server runs it, runs abandon one time while the request's fiber runs, and leaves no timer and no fiber when it has ended, before any timer's end", async () => {
  const dry = await dryRun("client")
  expect(dry.steppedAt).toBeGreaterThan(0)
  let seen = 0
  for (let stop = dry.steppedAt + 1; stop <= dry.leftAt; stop++) {
    const t = await trial("client", stop)
    expect([stop, t.interrupted, t.delivered, Exit.isFailure(t.exit)]).toEqual([stop, true, false, true])
    expect([stop, t.abandonedWhileRunning]).toEqual([stop, [true]])
    expect([stop, t.atEnd]).toEqual([stop, cleanOf(1)])
    seen += 1
  }
  expect(seen).toBe(dry.leftAt - dry.steppedAt)
}, 20_000)

test("with no scope in the context (a direct call of the gate, not Effect's server), the one point of ruling 2: an interruption in the gate's last uncut step, after its end saw its answer, leaves the client to the request's deadline, where abandon runs one time and no timer is left; every other stop from the client's step ends it at once, also one that the gate's end sees", async () => {
  const dry = await dryRun("client", "direct")
  const points: Array<number> = []
  const atOnce: Array<number> = []
  for (let stop = dry.steppedAt + 1; stop <= dry.leftAt; stop++) {
    const t = await trial("client", stop, "direct")
    expect([stop, t.interrupted, t.delivered]).toEqual([stop, true, false])
    if (JSON.stringify(t.atEnd) === JSON.stringify(cleanOf(1))) {
      atOnce.push(stop)
      continue
    }
    // The point: the gate's end handed the client to an answer that no one
    // gets; its timer holds it. The stop is in an uncut step: the
    // interruption lands as it ends, after the gate's end.
    expect([stop, t.atEnd]).toEqual([stop, { requests: 0, waiting: 0, timers: 1, fibers: 1, abandoned: 0 }])
    expect([stop, t.cutAtStop]).toEqual([stop, false])
    points.push(stop)
    for (let k = 0; k < 100 && t.rest().timers > 0; k++) await new Promise((resolve) => setTimeout(resolve, 5))
    await turn()
    expect([stop, t.rest()]).toEqual([stop, cleanOf(1)])
  }
  expect(points.length).toBeGreaterThan(0)
  expect(atOnce.length).toBeGreaterThan(0)
  // It is the last uncut step: each stop before it ends the client at once.
  expect(Math.max(...atOnce)).toBeLessThan(Math.min(...points))
}, 20_000)

test("abandon is the client's one end: a client's stream that ran to its end, one that failed and one that was interrupted each run abandon one time, called directly and as Effect's server runs it (the request's scope then closes at the stream's end); a deadline with no start and a late start after it run it one time in all", async () => {
  const gate = gateOf()
  await run(Effect.gen(function*() {
    const streams = {
      end: Stream.make(encode("one"), encode("two")),
      failed: Stream.concat(Stream.make(encode("one")), Stream.fail(new Error("the stream's fault"))),
      interrupted: Stream.concat(Stream.make(encode("one")), Stream.never)
    }
    const routers = yield* Scope.make()
    for (const [way, [name, stream]] of (["direct", "server"] as const).flatMap((way) => Object.entries(streams).map((each) => [way, each] as const))) {
      const abandoned = { count: 0 }
      let cleaned = 0
      const req = get()
      const handler = routed(gate, "R4", req, A1, clientWork(abandoned, stream.pipe(Stream.ensuring(Effect.sync(() => cleaned++)))))
      let web: Response
      if (way === "direct") web = HttpServerResponse.toWeb(yield* handler)
      else {
        const served = yield* asServer(Effect.orDie(handler), req).pipe(Effect.provideService(Scope.Scope, routers))
        yield* served.program
        web = served.answer.sent!
      }
      const label = way + ": " + name
      const reader = web.body!.getReader()
      expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
      expect([label, abandoned.count]).toEqual([label, 0])
      if (name === "interrupted") yield* Effect.promise(() => reader.cancel())
      else yield* Effect.promise(async () => {
        while (true) {
          const got = await reader.read().catch(() => ({ done: true }))
          if (got.done) return
        }
      })
      yield* settle
      expect([label, abandoned.count, cleaned]).toEqual([label, 1, 1])
      expect(gate.inFlight()).toBe(0)
    }
    // A deadline with no start: one time there, none at a late start.
    const abandoned = { count: 0 }
    const response = yield* routed(gate, "R4", get(), A1, clientWork(abandoned, Stream.make(encode("one"))))
    yield* TestClock.adjust(DEFAULTS.request)
    yield* settle
    expect(abandoned.count).toBe(1)
    const late = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text().then(() => "read", () => "failed"))
    expect(late).toBe("failed")
    yield* settle
    expect(abandoned.count).toBe(1)
    yield* Scope.close(routers, Exit.void)
  }))
})

// Samples the gate's two counts at each point where a fiber of the socket's
// request yields (the scheduler steps each fiber: the work runs in a child of
// the request's fiber), and gives the samples with repeats dropped.
const admissionSamples = async (gate: Gate) => {
  const samples: Array<string> = []
  const calls = new WeakMap<object, number>()
  const scheduler = new Scheduler.MixedScheduler()
  scheduler.shouldYield = (fiber) => {
    // A yield before each operation: after a yield, the resumed fiber's first
    // step only ends that yield, and its second is the operation.
    const count = (calls.get(fiber) ?? 0) + 1
    calls.set(fiber, count)
    if (count % 3 !== 0) return false
    queueMicrotask(() => {
      const sample = `${gate.inFlight()},${gate.waiting()}`
      if (samples[samples.length - 1] !== sample) samples.push(sample)
    })
    return true
  }
  const fiber = Effect.runFork(socketCall(gate, upgradeRequest(), (upgrading) =>
    Effect.flatMap(upgrading.admit, (done) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 3 }), Effect.as(done, HttpServerResponse.empty())))).pipe(Effect.provide(capture)), { scheduler })
  const exit = await Effect.runPromise(Fiber.await(fiber))
  expect(Exit.isSuccess(exit)).toBe(true)
  return samples
}

test("R6's admit, seen at each point where its request yields: the request's place, then the waiting place, never both and never neither between them", async () => {
  const gate = gateOf()
  const samples = await admissionSamples(gate)
  // `1,0` before the step, `0,1` after it, `0,0` at the end: in this order,
  // with nothing between the first two.
  expect(samples.filter((sample) => sample !== "0,0")).toEqual(["1,0", "0,1"])
  expect(samples.slice(samples.indexOf("1,0"), samples.indexOf("0,1") + 1)).toEqual(["1,0", "0,1"])
  expect(samples).not.toContain("1,1")
  expect([gate.inFlight(), gate.waiting()]).toEqual([0, 0])
})

// The log
// -------

test("no line of the log holds a query, a header's value, a token or a body", async () => {
  // A last round of each kind, then the sweep over every line that the
  // tests' logger took in this file.
  const gate = gateOf()
  await run(call(gate, request("/v1/chats/" + A1 + "?secretquery=queryvalue1234", { headers: { authorization: "Bearer " + TOKEN, "x-probe": "headervalue1234", origin: "https://evil.example" } }), A1))
  await run(call(gate, request("/v1/chats/" + A1 + "?token=" + TOKEN, { headers: { "x-probe": "headervalue1234" } }), A1))
  await run(call(gate, post("bodyvalue1234".repeat(50_000)), A1, readBody(gate)))
  await run(call(gate, request("/v1/chats/" + A1, { headers: authorized() }), A1, () => Effect.fail(new Error("a fault with headervalue1234"))))
  const all = lines.join("\n")
  expect(lines.length).toBeGreaterThan(0)
  for (const secret of ["queryvalue1234", "secretquery", "headervalue1234", "evil.example", "bodyvalue1234", "Bearer", TOKEN, ONLY_A1, ...FAILING.map(([, token]) => token)]) {
    expect(all).not.toContain(secret)
  }
  for (const token of [TOKEN, ONLY_A1, ...FAILING.map(([, t]) => t)]) {
    for (const piece of token.split(".").filter((p) => p.length >= 8)) expect(all).not.toContain(piece)
  }
  for (const line of parsed()) {
    expect(Object.keys(line.annotations).every((key) => ["route", "status", "error", "check", "fault", "closed"].includes(key))).toBe(true)
  }
})
