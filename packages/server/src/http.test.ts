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
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Redacted, Scope, Stream } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { type Jwk, Jws } from "effect/jose"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Chats, type Pick } from "@everchat/core/store"
import { chatsLayer } from "@everchat/sqlite/bun"
import { CODES, ERRORS, errorAnswer, type Found, type Gate, jsonAnswer, makeGate, Refused } from "./http.ts"
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

const call = (
  gate: Gate,
  req: HttpServerRequest.HttpServerRequest,
  chat: string | undefined,
  work: (found: Found) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown> = ok
) => gate.route("R2", chat, work).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))

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

test("over a connection: a HEAD to a route whose work answers with a stream, one that ends and one that never ends, gives each place back by the deadline at the latest", async () => {
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
      const head = (url: string) => `HEAD ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n\r\n`
      // Each client keeps its connection open past the deadline, and reads
      // no body: nothing pulls the stream.
      const answers = Promise.all([
        ...Array.from({ length: 3 }, () => raw(port, head(`/v1/chats/${A1}/ends`), 1_000)),
        ...Array.from({ length: 3 }, () => raw(port, head(`/v1/chats/${A1}/never`), 1_000))
      ])
      expect(yield* until(() => worked === 6, 5_000)).toBe(true)
      // Every place back while the connections are still open: at the
      // deadline, not at their close.
      expect(yield* until(() => gate.inFlight() === 0, 900)).toBe(true)
      const got = yield* Effect.promise(() => answers)
      for (const answer of got) expect(answer.got).toStartWith("HTTP/1.1 200")
      // The deadline's line for each, with the route and no more.
      expect(deadlineLines(from).map((line) => line.annotations["route"])).toEqual(Array(6).fill("R4"))
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
