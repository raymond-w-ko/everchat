// Tests of R1, a message in over HTTP (post.ts; docs/host.md, section 3, "R1:
// a message in" and "Admission", 4, 5 and 8; section 5): its numbers, a
// key, the order of its checks, the body's form, the rate, the two tenants of
// check 3, the errors of the message in, a client that ends its request, the
// answers' headers, and the log. Each case runs on the SQLite store of a
// test file, Effect's TestClock, and a stack of the core's hosted set over
// the tests' fake wire. The secret is made-up bytes.

import { expect, test } from "bun:test"
import { Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Redacted, Scope, Semaphore } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request as Asked } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, NoChat, Store, StoreError } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer, ProcessAlive } from "@everchat/sqlite/bun"
import { Host, type HostOptions } from "./host.ts"
import { ERRORS, makeGate } from "./http.ts"
import { messageRoute } from "./post.ts"
import { makeToken } from "./token.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 5 * i + 3))
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

// What a case changes: the wire's answers, the sandbox, and a wait after
// the store's `append` (one time), inside its transaction.
interface World {
  answer: (asked: Asked, n: number) => Reply
  run: (program: string) => Effect.Effect<{ output: string; failed: boolean }>
  after: Effect.Effect<void> | undefined
  fail: boolean
  gone: boolean
  appends: number
}
const world = (over: Partial<World> = {}): World => ({
  answer: (asked) => says(asked, "A reply."),
  run: () => Effect.succeed({ output: "2", failed: false }),
  after: undefined,
  fail: false,
  gone: false,
  appends: 0,
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

const wrap = (real: typeof Chats.Service, w: World) =>
  Chats.of({
    make: real.make,
    reads: real.reads,
    store: (tenant, chat, launch) =>
      Effect.map(w.gone ? Effect.fail(new NoChat()) : real.store(tenant, chat, launch), (store) => ({
        ...store,
        append: (messages, key) =>
          Effect.gen(function*() {
            w.appends += 1
            if (w.fail) {
              w.fail = false
              return yield* new StoreError({ op: "append", cause: new Error("the test's fault with SECRET-TEXT") })
            }
            const written = yield* store.append(messages, key)
            const after = w.after
            w.after = undefined
            if (after !== undefined) yield* after
            return written
          })
      }))
  })

// The log of a case, as JSON lines with their annotations.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])

interface Built {
  readonly host: typeof Host.Service
  readonly real: typeof Chats.Service
  readonly post: (chat: string, init: { body?: BodyInit | null; headers?: Record<string, string>; token?: string }) => Effect.Effect<HttpServerResponse.HttpServerResponse>
  readonly token: (tenant: string, chats: ReadonlyArray<string>) => Effect.Effect<string>
  readonly close: Effect.Effect<void>
}
type BodyInit = NonNullable<RequestInit["body"]>

// The host over `w`, a gate over it, and R1's route.
const build = (w: World, over: Partial<HostOptions> = {}) =>
  Effect.gen(function*() {
    const real = yield* Chats
    const scope = yield* Scope.make()
    const layer = Host.layer({ stack: stackOf(w), launch: LAUNCH, secret: SECRET, origins: [ORIGIN], ...over }).pipe(
      Layer.provide(Layer.succeed(Chats, wrap(real, w)))
    )
    const host = Context.get(yield* Layer.buildWithScope(layer, scope), Host)
    const gate = makeGate({ secret: host.secret, origins: host.origins, limits: host.limits, chats: real })
    const route = messageRoute(gate, host)
    const token = (tenant: string, chats: ReadonlyArray<string>) =>
      Effect.orDie(Effect.gen(function*() {
        return yield* makeToken(SECRET, { tenant, chats: [...chats], exp: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 600 })
      }))
    const post: Built["post"] = (chat, init) =>
      Effect.gen(function*() {
        const bearer = init.token ?? (yield* token(TENANT_A, [chat]))
        const request = new Request("http://127.0.0.1/v1/chats/" + chat + "/messages", {
          method: "POST",
          headers: { authorization: "Bearer " + bearer, "content-type": "application/json", ...init.headers },
          body: init.body ?? null,
          ...(init.body instanceof ReadableStream ? { duplex: "half" } : {})
        } as RequestInit)
        return yield* route(chat).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)))
      })
    return { host, real, post, token, close: Scope.close(scope, Exit.void) } satisfies Built
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

// An answer as the web sees it: each has the gate's three headers.
const seen = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.promise(async () => {
    const web = HttpServerResponse.toWeb(response)
    const headers = Object.fromEntries(web.headers)
    expect(headers["cache-control"]).toBe("no-store")
    expect(headers["referrer-policy"]).toBe("no-referrer")
    expect(headers["x-content-type-options"]).toBe("nosniff")
    return { status: web.status, headers, text: await web.text() }
  })
const errorText = (code: keyof typeof ERRORS) => JSON.stringify({ error: code, message: ERRORS[code].message })
const json = (value: unknown) => JSON.stringify(value)

const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 2_000 && !check(); k++) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
    if (!check()) return yield* Effect.die(new Error("the case waited for a state that did not come"))
  })
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

// Effect's TestClock, with the due times of the sleeps that have started
// and not ended: a timer of a request that waits is one of them. A sleep
// fixes its due time in the step that notes it, so a move of the clock
// that comes before the TestClock holds the sleep still wakes it at that
// time.
const countingClock = Effect.map(TestClock.testClockWith(Effect.succeed), (base) => {
  const pending: Array<number> = []
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: base.currentTimeMillis,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.suspend(() => {
        const due = base.currentTimeMillisUnsafe() + Duration.toMillis(duration)
        pending.push(due)
        return Effect.suspend(() => base.sleep(Duration.millis(Math.max(0, due - base.currentTimeMillisUnsafe())))).pipe(
          Effect.ensuring(Effect.sync(() => {
            pending.splice(pending.indexOf(due), 1)
          }))
        )
      })
  }
  return { clock, pending }
})

const events = (file: string) => rows<{ n: number; type: string }>(file, "select n, type from everchat_event order by chat, n")
const messages = (file: string) => rows<{ chat: number; i: number; text: string }>(file, "select chat, i, text from everchat_msg order by chat, i")
const launches = (file: string) => rows<{ pid: number; ended: number | null }>(file, "select pid, ended from everchat_launch order by chat, n")

// Waits until the loaded chat's turn has ended.
const idle = (b: Built, tenant: string, chat: string) =>
  Effect.gen(function*() {
    const loaded = b.host.registry.find(tenant, chat)?.loaded
    if (loaded !== undefined) yield* loaded.turns.idle
  })

// A message in
// ------------

test("a message gives 200 with its numbers, and the store has its pages and its accepted event with that number", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      const answer = yield* seen(yield* b.post(chat, { body: json({ text: "hello" }) }))
      expect(answer.status).toBe(200)
      expect(answer.headers["content-type"]).toBe("application/json; charset=utf-8")
      expect(JSON.parse(answer.text)).toEqual({ n: 1, first: 0, last: 0, repeat: false })
      expect(Object.keys(JSON.parse(answer.text))).toEqual(["n", "first", "last", "repeat"])
      const reads = yield* b.host.chatReads(TENANT_A, chat)
      expect((yield* reads.messages(0, 1)).map((m) => [m.i, m.kind, m.text])).toEqual([[0, "user", "hello"]])
      const [accepted] = yield* reads.eventsAfter(0, 1)
      expect(accepted).toMatchObject({ type: "accepted", n: 1 })
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})

test("a text of three pages gives first and last two apart", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      const answer = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text: "a".repeat(60_001) }) }))).text)
      expect(answer).toEqual({ n: 1, first: 0, last: 2, repeat: false })
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})

test("the same key again gives the same numbers with repeat true and writes nothing, also with another text; in another chat it is another message; no key twice is two messages", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const chat = yield* b.real.make(TENANT_A, PICK)
      const other = yield* b.real.make(TENANT_A, PICK)
      const key = { "idempotency-key": "key-1" }
      const first = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text: "hello" }), headers: key }))).text)
      expect(first.repeat).toBe(false)
      yield* idle(b, TENANT_A, chat)
      const before = { events: events(file), messages: messages(file), appends: w.appends }
      for (const text of ["hello", "another text"]) {
        const again = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text }), headers: key }))).text)
        expect(again).toEqual({ ...first, repeat: true })
      }
      expect({ events: events(file), messages: messages(file), appends: w.appends }).toEqual(before)
      // The same key in another chat.
      const elsewhere = JSON.parse((yield* seen(yield* b.post(other, { body: json({ text: "hello" }), headers: key }))).text)
      expect(elsewhere).toEqual({ n: 1, first: 0, last: 0, repeat: false })
      yield* idle(b, TENANT_A, other)
      // No key, twice: two messages.
      const one = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text: "same" }) }))).text)
      yield* idle(b, TENANT_A, chat)
      const two = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text: "same" }) }))).text)
      expect(two.first).toBeGreaterThan(one.last)
      expect(two.n).toBeGreaterThan(one.n)
      expect([one.repeat, two.repeat]).toEqual([false, false])
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})

test("text/plain gets 415; application/json with charset=utf-8 passes; a key of 129 bytes, an empty key and a key with a space get 400 and nothing of the body is read", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      for (const type of ["text/plain", "application/json; charset=latin1", "application/jsonx", "application/json; boundary=x", ""]) {
        const answer = yield* seen(yield* b.post(chat, { body: json({ text: "hello" }), headers: { "content-type": type } }))
        expect([type, answer.status, answer.text]).toEqual([type, 415, errorText("unsupported_type")])
      }
      for (const type of ["application/json; charset=utf-8", "Application/JSON;charset=UTF-8", "application/json"]) {
        const answer = yield* seen(yield* b.post(chat, { body: json({ text: "hello " + type }), headers: { "content-type": type } }))
        expect([type, answer.status]).toEqual([type, 200])
        yield* idle(b, TENANT_A, chat)
      }
      const before = messages(file)
      for (const key of ["k".repeat(129), "", "a key", "clé"]) {
        let pulled = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1
            controller.enqueue(new TextEncoder().encode(json({ text: "hello" })))
            controller.close()
          }
        }, { highWaterMark: 0 })
        const answer = yield* seen(yield* b.post(chat, { body, headers: { "idempotency-key": key } }))
        expect([key, answer.status, answer.text]).toEqual([key, 400, errorText("bad_request")])
        expect(pulled).toBe(0)
      }
      expect(messages(file)).toEqual(before)
      // A key of 128 bytes passes.
      expect((yield* seen(yield* b.post(chat, { body: json({ text: "keyed" }), headers: { "idempotency-key": "k".repeat(128) } }))).status).toBe(200)
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})

test("a body type that is not JSON with a key that is not valid gets 415, not 400, and nothing of the body is read", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      for (const key of ["k".repeat(129), "", "a key"]) {
        let pulled = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1
            controller.enqueue(new TextEncoder().encode(json({ text: "hello" })))
            controller.close()
          }
        }, { highWaterMark: 0 })
        const answer = yield* seen(yield* b.post(chat, { body, headers: { "content-type": "text/plain", "idempotency-key": key } }))
        expect([key, answer.status, answer.text]).toEqual([key, 415, errorText("unsupported_type")])
        expect(pulled).toBe(0)
      }
      expect(messages(file)).toEqual([])
      yield* b.close
    }))
})

test("a body of the wrong form gets 400; a body past `body` gets 413", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      const text = b.host.limits.text
      const bodies: Array<BodyInit> = [
        json({ text: "" }),
        json({ text: "a".repeat(text + 1) }),
        json({ text: 1 }),
        json({ text: null }),
        json({ text: "a", images: [] }),
        json({ text: "a", x: 1 }),
        json({}),
        json([]),
        json(["text"]),
        json("text"),
        "null",
        "{\"text\": \"a\"",
        "not json",
        "",
        new Uint8Array([0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])
      ]
      for (const body of bodies) {
        const answer = yield* seen(yield* b.post(chat, { body }))
        expect([String(body).slice(0, 40), answer.status, answer.text]).toEqual([String(body).slice(0, 40), 400, errorText("bad_request")])
      }
      const large = yield* seen(yield* b.post(chat, { body: json({ text: "a".repeat(b.host.limits.body) }) }))
      expect([large.status, large.text]).toEqual([413, errorText("too_large")])
      expect(messages(file)).toEqual([])
      yield* b.close
    }))
})

// The rate
// --------

test("the 31st request of a window gets 429 with the seconds to its end; requests that got 400 and 415 counted", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      for (let k = 0; k < 30; k++) {
        const answer = yield* b.post(chat, k % 2 === 0 ? { body: "not json" } : { body: json({ text: "a" }), headers: { "content-type": "text/plain" } })
        expect(answer.status).toBe(k % 2 === 0 ? 400 : 415)
      }
      const refused = yield* seen(yield* b.post(chat, { body: json({ text: "hello" }) }))
      expect([refused.status, refused.headers["retry-after"], refused.text]).toEqual([429, "60", errorText("too_many")])
      yield* TestClock.adjust(20_500)
      const later = yield* seen(yield* b.post(chat, { body: json({ text: "hello" }) }))
      expect([later.status, later.headers["retry-after"]]).toEqual([429, "40"])
      // A refused request counts too: the window is still full.
      yield* TestClock.adjust(39_500)
      const next = yield* seen(yield* b.post(chat, { body: json({ text: "hello" }) }))
      expect(next.status).toBe(200)
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})

test("a repeat of a key counts: 30 requests of one key, then the 31st gets 429", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      for (let k = 0; k < 30; k++) {
        const answer = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text: "hello" }), headers: { "idempotency-key": "one-key" } }))).text)
        expect(answer.repeat).toBe(k > 0)
        if (k === 0) yield* idle(b, TENANT_A, chat)
      }
      const refused = yield* seen(yield* b.post(chat, { body: json({ text: "hello" }), headers: { "idempotency-key": "one-key" } }))
      expect([refused.status, refused.headers["retry-after"]]).toEqual([429, "60"])
      yield* b.close
    }))
})

// The two tenants
// ---------------

test("NoChat of the message in (the chat went away after the gate's check) gets the gate's own 404, byte for byte", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const chat = yield* b.real.make(TENANT_A, PICK)
      const other = yield* b.real.make(TENANT_A, PICK)
      const gates = yield* seen(yield* b.post(other, { body: json({ text: "hello" }), token: yield* b.token(TENANT_A, [chat]) }))
      expect(gates.status).toBe(404)
      w.gone = true
      const said = yield* seen(yield* b.post(chat, { body: json({ text: "hello" }) }))
      expect(said).toEqual(gates)
      yield* b.close
    }))
})

test("with a token of tenant A, a POST for a chat of tenant B, named in the token's chats or not, gets 404 no_chat; B's rows are the same, and B's rate is not counted", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const own = yield* b.real.make(TENANT_A, PICK)
      const theirs = yield* b.real.make(TENANT_B, PICK)
      // B's chat has a message and a launch.
      const bToken = yield* b.token(TENANT_B, [theirs])
      expect((yield* b.post(theirs, { body: json({ text: "B-SECRET" }), token: bToken })).status).toBe(200)
      yield* idle(b, TENANT_B, theirs)
      const before = { messages: messages(file), events: events(file), launches: launches(file) }
      const named = yield* b.token(TENANT_A, [own, theirs])
      const notNamed = yield* b.token(TENANT_A, [own])
      for (let k = 0; k < 31; k++) {
        for (const token of [named, notNamed]) {
          const answer = yield* seen(yield* b.post(theirs, { body: json({ text: "from A" }), headers: { "idempotency-key": "key-" + k }, token }))
          expect([answer.status, answer.text]).toEqual([404, errorText("no_chat")])
          expect(answer.text).not.toContain("B-SECRET")
        }
      }
      expect({ messages: messages(file), events: events(file), launches: launches(file) }).toEqual(before)
      // B's window has its own one message: 29 more pass, the 30th does not.
      for (let k = 0; k < 29; k++) yield* b.host.count(TENANT_B, theirs)
      expect((yield* Effect.flip(b.host.count(TENANT_B, theirs)))._tag).toBe("TooMany")
      yield* b.close
    }))
})

// The errors of the message in
// ----------------------------

test("a chat that another launch holds gets 409; with `loaded` 1 and another chat loaded, 503 with retry-after 5", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world(), { limits: { loaded: 1 } })
      const one = yield* b.real.make(TENANT_A, PICK)
      const two = yield* b.real.make(TENANT_A, PICK)
      const held = yield* b.real.make(TENANT_A, PICK)
      const other = yield* Scope.make()
      yield* Scope.provide(other)(Effect.orDie(b.real.store(TENANT_A, held, { ...LAUNCH, pid: 999_999, runTag: "other" })))
      const elsewhere = yield* seen(yield* b.post(held, { body: json({ text: "hello" }) }))
      expect([elsewhere.status, elsewhere.text]).toEqual([409, errorText("chat_elsewhere")])
      expect((yield* b.post(one, { body: json({ text: "hello" }) })).status).toBe(200)
      const full = yield* seen(yield* b.post(two, { body: json({ text: "hello" }) }))
      expect([full.status, full.headers["retry-after"], full.text]).toEqual([503, "5", errorText("busy")])
      yield* idle(b, TENANT_A, one)
      yield* Scope.close(other, Exit.void)
      yield* b.close
    }).pipe(Effect.provideService(ProcessAlive, () => true)))
})

test("a message that waits past lockWait gets 503 with retry-after 1 and logs nothing", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world(), { limits: { lockWait: 500 } })
      const chat = yield* b.real.make(TENANT_A, PICK)
      const channel = yield* b.host.registry.held(TENANT_A, chat)
      yield* Semaphore.take(channel.lock, 1)
      const { clock, pending } = yield* countingClock
      const waiting = yield* Effect.forkChild(
        Effect.flatMap(b.post(chat, { body: json({ text: "hello" }) }).pipe(Effect.provideService(Clock.Clock, clock)), seen)
      )
      // The request waits for the lock: its `lockWait` timer has started.
      yield* until(() => pending.includes(NOW + 500))
      yield* TestClock.adjust(499)
      yield* settle
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const answer = yield* Fiber.join(waiting)
      expect([answer.status, answer.headers["retry-after"], answer.text]).toEqual([503, "1", errorText("busy")])
      expect({ messages: messages(file), events: events(file) }).toEqual({ messages: [], events: [] })
      yield* Semaphore.release(channel.lock, 1)
      yield* b.host.registry.letGo(channel)
      yield* b.close
    }))
})

test("a fault of the store gets 500 internal, with no text of the fault or of the message in the answer or the log", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const chat = yield* b.real.make(TENANT_A, PICK)
      w.fail = true
      lines.length = 0
      const answer = yield* seen(yield* b.post(chat, { body: json({ text: "MESSAGE-TEXT" }), headers: { "idempotency-key": "KEY-TEXT" } }))
      expect([answer.status, answer.text]).toEqual([500, errorText("internal")])
      const all = lines.join("\n")
      for (const secret of ["SECRET-TEXT", "MESSAGE-TEXT", "KEY-TEXT"]) expect(all).not.toContain(secret)
      yield* b.close
    }))
})

test("a message while a turn runs gets 200 at once", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const w = world({
        answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { output: "2", failed: false }))
      })
      const b = yield* build(w)
      const chat = yield* b.real.make(TENANT_A, PICK)
      expect((yield* b.post(chat, { body: json({ text: "do the slow thing" }) })).status).toBe(200)
      yield* Deferred.await(started)
      const steer = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text: "and this too" }) }))).text)
      expect(steer.repeat).toBe(false)
      expect(yield* b.host.registry.find(TENANT_A, chat)!.loaded!.turns.busy).toBe(true)
      expect(events(file).find((row) => row.n === steer.n)?.type).toBe("accepted")
      yield* Deferred.succeed(release, undefined)
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})

test("a client that ends its request after the commit: the message is logged once, and the same key then gives its numbers", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const chat = yield* b.real.make(TENANT_A, PICK)
      // The append is written; then it waits 5 s inside its transaction.
      const { clock, pending } = yield* countingClock
      w.after = Effect.provideService(Effect.sleep("5 seconds"), Clock.Clock, clock)
      const request = yield* Effect.forkChild(b.post(chat, { body: json({ text: "hello" }), headers: { "idempotency-key": "key-gone" } }))
      yield* until(() => pending.includes(NOW + 5_000))
      const stopping = yield* Effect.forkChild(Fiber.interrupt(request))
      yield* settle
      expect(stopping.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.join(stopping)
      expect(Exit.hasInterrupts(yield* Fiber.await(request))).toBe(true)
      expect(messages(file).filter((row) => row.text === "hello").length).toBe(1)
      const again = JSON.parse((yield* seen(yield* b.post(chat, { body: json({ text: "hello" }), headers: { "idempotency-key": "key-gone" } }))).text)
      expect(again).toEqual({ n: 1, first: 0, last: 0, repeat: true })
      expect(messages(file).filter((row) => row.text === "hello").length).toBe(1)
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})

// The answers and the log
// -----------------------

test("for a listed origin every answer, 200 and errors, has the CORS headers; no log line holds the text or the key", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = yield* b.real.make(TENANT_A, PICK)
      lines.length = 0
      const origin = { origin: ORIGIN, "idempotency-key": "THE-KEY-1" }
      const answers = [
        yield* seen(yield* b.post(chat, { body: json({ text: "THE-TEXT-1" }), headers: origin })),
        yield* seen(yield* b.post(chat, { body: json({ text: "THE-TEXT-1" }), headers: { ...origin, "content-type": "text/plain" } })),
        yield* seen(yield* b.post(chat, { body: json({ text: "THE-TEXT-1", x: "THE-TEXT-2" }), headers: { ...origin, "idempotency-key": "THE-KEY-2" } })),
        yield* seen(yield* b.post(chat, { body: json({ text: "THE-TEXT-1" }), headers: { ...origin, "idempotency-key": "THE KEY 3" } }))
      ]
      expect(answers.map((answer) => answer.status)).toEqual([200, 415, 400, 400])
      for (const answer of answers) {
        expect(answer.headers["access-control-allow-origin"]).toBe(ORIGIN)
        expect(answer.headers["vary"]).toBe("origin")
        expect(answer.text).not.toContain("THE-")
      }
      yield* idle(b, TENANT_A, chat)
      const all = lines.join("\n")
      for (const secret of ["THE-TEXT", "THE-KEY", "THE KEY"]) expect(all).not.toContain(secret)
      // With no Origin, none.
      const plain = yield* seen(yield* b.post(chat, { body: json({ text: "plain" }) }))
      expect(Object.keys(plain.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])
      yield* idle(b, TENANT_A, chat)
      yield* b.close
    }))
})
