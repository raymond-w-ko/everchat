// Tests of R5, the events with no stream (poll.ts; docs/host.md, section 3,
// "R5: the events, with no stream", "Admission" 3, 10 and 11; section 8,
// "Pages"; lead, ec-hmsqu): the query, the answer and its cuts, the order of
// a wait (the hold, the client, the first read, the join's check, the place
// given back and taken again), its ends, the bounds, and the two tenants of
// check 3. Each case runs the host's layer over the SQLite store of this
// file, on Effect's TestClock; the one turn runs on the core's hosted set
// over the tests' fake wire. The secret is made-up bytes.

import { afterAll, expect, test } from "bun:test"
import { Clock, Context, Effect, Exit, Fiber, Layer, Logger, Redacted, Scheduler, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, type Event, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import type { Client, Registry } from "./channel.ts"
import { type Entry, fit } from "./fit.ts"
import { ERRORS, type Gate, makeGate } from "./http.ts"
import { Host } from "./host.ts"
import { DEFAULTS, type Limits } from "./limits.ts"
import type { LoadedChat } from "./loaded.ts"
import { LIMIT, type PollLimits, pollQuery, pollRoute } from "./poll.ts"
import { makeToken } from "./token.ts"

const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 5 * i + 3))
const S = 1_800_000_000
const NOW = S * 1000 + 500
const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

// The log of the tests, as JSON lines with their annotations.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])
const parsed = (from = 0) =>
  lines.slice(from).map((line) => JSON.parse(line) as { level: string; message: unknown; annotations: Record<string, unknown> })

// The store of this file.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-poll-"))
const FILE = path.join(home, "chats.db")
const scope = Effect.runSync(Scope.make())
const built = await Effect.runPromise(Layer.buildWithScope(chatsLayer(FILE), scope))
const chats = Context.get(built, Chats)
afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  fs.rmSync(home, { recursive: true, force: true })
})

// A write to a chat through its store, for one launch.
let launches = 0
const write = <A>(tenant: string, chat: string, f: (store: typeof Store.Service) => Effect.Effect<A, unknown>) =>
  Effect.scoped(Effect.flatMap(chats.store(tenant, chat, { ...LAUNCH, runTag: "run-" + ++launches }), f)).pipe(Effect.orDie)

// `count` messages, each with its `message` event: their event numbers.
const addEvents = (tenant: string, chat: string, count: number, text = (k: number) => "event text " + k) =>
  write(tenant, chat, (store) =>
    Effect.gen(function*() {
      const messages = yield* store.append(Array.from({ length: count }, (_, k) => ({ kind: "user" as const, text: text(k) })))
      const numbers: Array<number> = []
      for (const message of messages) numbers.push(yield* store.addEvent({ type: "message", msg: message.i, msgLast: message.i }))
      return numbers
    }))

// A new chat of `tenant` with `count` events.
const newChat = (tenant: string, count = 0, text?: (k: number) => string) =>
  Effect.runPromise(Effect.gen(function*() {
    const chat = yield* chats.make(tenant, PICK)
    if (count > 0) yield* addEvents(tenant, chat, count, text)
    return chat
  }).pipe(Effect.orDie))

// The chat's events after `after` as the store gives them.
const stored = (tenant: string, chat: string, after: number, limit = 1000) =>
  Effect.flatMap(Effect.orDie(chats.reads(tenant, chat)), (reading) => Effect.orDie(reading.eventsAfter(after, limit)))

// The JSON of an event as the fit makes it under `entry`.
const fitted = (event: Event, entry = DEFAULTS.entry) => fit(event, entry) as Entry

const token = (chatsOf: ReadonlyArray<string>, exp = S + 600, tenant = TENANT_A) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(NOW), makeToken(SECRET, { tenant, chats: [...chatsOf], exp })).pipe(
    Effect.provide(TestClock.layer())
  ))

// The stack of a loaded chat: the core's hosted set over the fake wire, which
// answers each request with a line of text.
const stack = (store: typeof Store.Service) => {
  const wire = fakeWire((asked: Request) => reply(asked, { text: "A reply.", output: [{ type: "message", content: [{ type: "output_text", text: "A reply." }] }] }))
  const base = Layer.succeed(Store, store)
  const memory = Memory.layer.pipe(Layer.provideMerge(base), Layer.provide(compactor(() => "a summary")))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.succeed({ output: "2", failed: false }) }))
  const functions = hostedLayer.pipe(Layer.provide(memory))
  return Turns.layer({ declarations: HOSTED }).pipe(
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), functions))
  )
}

// What a case sees of the host: the counts of the holds R5 took, of its steps
// `leave` and `again`, and of the reads of each chat's events; a hook after
// each read of the events (by the chat and its call's number), and one after
// the step `leave`, in the request's fiber: after the join, before the
// wait's first take.
interface Counts {
  holds: number
  leaves: number
  agains: number
  readonly reads: Map<string, number>
  hook: ((chat: string, call: number) => Effect.Effect<void>) | undefined
  afterLeave: (() => Effect.Effect<void>) | undefined
}

// The host's layer with `over`, in a scope of its own; the gate over a
// `Chats` that counts the reads of events; R5 behind it, with the host's
// limits and `routeLimits` over them.
const harness = (over: Partial<Limits> = {}, routeLimits: Partial<PollLimits> = {}) =>
  Effect.gen(function*() {
    const hostScope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(
      Host.layer({ stack, launch: LAUNCH, secret: SECRET, origins: [], limits: over }).pipe(Layer.provide(Layer.succeed(Chats, chats))),
      hostScope
    )
    const host = Context.get(context, Host)
    const counts: Counts = { holds: 0, leaves: 0, agains: 0, reads: new Map(), hook: undefined, afterLeave: undefined }
    const counting: typeof Chats.Service = {
      make: chats.make,
      store: chats.store,
      reads: (tenant, chat) =>
        Effect.map(chats.reads(tenant, chat), (reading) => ({
          ...reading,
          eventsAfter: (after: number, limit: number) =>
            Effect.suspend(() => {
              const call = (counts.reads.get(chat) ?? 0) + 1
              counts.reads.set(chat, call)
              return Effect.tap(reading.eventsAfter(after, limit), () => counts.hook?.(chat, call) ?? Effect.void)
            })
        }))
    }
    const base = makeGate({ secret: SECRET, origins: [], limits: host.limits, chats: counting })
    const gate: Gate = {
      ...base,
      route: (name, chat, work) =>
        base.route(name, chat, (found, steps) =>
          work(found, {
            client: steps.client,
            leave: Effect.andThen(Effect.sync(() => counts.leaves++), steps.leave).pipe(
              Effect.andThen(Effect.suspend(() => counts.afterLeave?.() ?? Effect.void))
            ),
            again: Effect.andThen(Effect.sync(() => counts.agains++), steps.again)
          }))
    }
    const registry: Registry<LoadedChat> = {
      ...host.registry,
      held: (tenant, uuid) => Effect.tap(host.registry.held(tenant, uuid), () => Effect.sync(() => counts.holds++))
    }
    const route = pollRoute(gate, registry, host.reads, { ...host.limits, ...routeLimits })
    return { host, gate, route, counts, close: Scope.close(hostScope, Exit.void) }
  })

type Harness = Effect.Success<ReturnType<typeof harness>>

// Runs a case on Effect's TestClock, at `NOW`, with the log captured.
const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(NOW), body).pipe(Effect.scoped, Effect.provide(Layer.merge(TestClock.layer(), capture))))

// R5 for `chat` with `query`, and its answer as the web sees it: each has
// the gate's three headers.
const get = (h: Harness, chat: string, query: string, bearer: string) =>
  Effect.flatMap(
    h.route(chat).pipe(Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new globalThis.Request("http://127.0.0.1/v1/chats/" + chat + "/events" + query, { headers: { authorization: "Bearer " + bearer } }))
    )),
    (response) => Effect.promise(() => seen(response))
  )

const seen = async (response: HttpServerResponse.HttpServerResponse) => {
  const web = HttpServerResponse.toWeb(response)
  const headers = Object.fromEntries(web.headers)
  expect(headers["cache-control"]).toBe("no-store")
  expect(headers["referrer-policy"]).toBe("no-referrer")
  expect(headers["x-content-type-options"]).toBe("nosniff")
  if (web.status === 200) expect(headers["content-type"]).toBe("application/json; charset=utf-8")
  return { status: web.status, headers, text: await web.text() }
}
type Seen = Awaited<ReturnType<typeof seen>>

const errorText = (code: keyof typeof ERRORS) => JSON.stringify({ error: code, message: ERRORS[code].message })
const numbers = (answer: Seen) => (JSON.parse(answer.text).events as Array<{ n: number }>).map((event) => event.n)
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k)
// The answer of these events, byte for byte.
const eventsText = (events: ReadonlyArray<Event>, entry?: number) => "{\"events\":[" + events.map((event) => fitted(event, entry).json).join(",") + "]}"

// Waits, in real time, until `check` holds (2 s at most).
const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 2_000 && !check(); k++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
    }
    if (!check()) return yield* Effect.die(new Error("the case waited for a state that did not come"))
  })
// Lets the fibers run, in real time, with the clock still.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

// The channel of a chat that the host's registry has now, or none.
const channelOf = (h: Harness, tenant: string, chat: string) => h.host.registry.find(tenant, chat)
// R5 waits: its client of `chat` joined, and the gate holds no place.
const waiting = (h: Harness, chat: string, tenant = TENANT_A) =>
  Effect.andThen(
    until(() => (channelOf(h, tenant, chat)?.clients.some((client) => client.joined) ?? false) && h.gate.inFlight() === 0),
    settle
  )
// Nothing of a request is left: no channel, no client, no place of either kind.
const nothingLeft = (h: Harness) => {
  expect(h.host.registry.size()).toEqual({ channels: 0, clients: 0 })
  expect(h.gate.inFlight()).toBe(0)
  expect(h.host.reads.taken()).toBe(0)
  expect(h.host.reads.waiting()).toBe(0)
}

// Effect's TestClock, with a count of the sleeps that have started and not
// yet ended: a timer of a request that still waits is one of them.
const countingClock = Effect.map(TestClock.testClockWith(Effect.succeed), (base) => {
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
})

// The chats of the cases.
const A150 = await newChat(TENANT_A, 150)
const A10 = await newChat(TENANT_A, 10)
const B3 = await newChat(TENANT_B, 3, (k) => "B-SECRET-" + k)
const TOKEN_A = await token([A150, A10, B3])

// The query
// ---------

test("the query: each bad form of after, limit and wait gets 400, with no hold, no client and no read", async () => {
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const bad = [
      "?wait=5",
      "?after=-1&wait=5",
      "?after=1.5&wait=5",
      "?after=" + "1".repeat(17) + "&wait=5",
      "?after=" + "0".repeat(16) + "1",
      "?after=abc&wait=5",
      "?after=&wait=5",
      "?after",
      "?after=%2B1&wait=5",
      "?after=0&limit=0&wait=5",
      "?after=0&limit=1001&wait=5",
      "?after=0&limit=1.5&wait=5",
      "?after=0&limit=&wait=5",
      "?after=0&wait=26",
      "?after=0&wait=-1",
      "?after=0&wait=0.5",
      "?after=0&wait=abc",
      "?after=0&wait=",
      "?after=0&wait=1e1"
    ]
    for (const query of bad) {
      const answer = yield* get(h, A150, query, TOKEN_A)
      expect([query, answer.status, answer.text]).toEqual([query, 400, errorText("bad_request")])
      expect(answer.headers["retry-after"]).toBeUndefined()
    }
    expect(h.counts.holds).toBe(0)
    expect(h.counts.reads.size).toBe(0)
    nothingLeft(h)
    yield* h.close
  }))
})

test("the query: limit defaults to 100 and wait to 0; of a name given twice the first counts; another name is not read", async () => {
  expect(LIMIT).toBe(100)
  const limits = { events: 1000, wait: 25_000 }
  expect(pollQuery("/x?after=0", limits)).toEqual({ after: 0, limit: 100, wait: 0 })
  expect(pollQuery("/x?after=7&limit=1000&wait=25", limits)).toEqual({ after: 7, limit: 1000, wait: 25 })
  expect(pollQuery("/x?after=2&after=x&limit=3&limit=0&wait=1&wait=99&other=1", limits)).toEqual({ after: 2, limit: 3, wait: 1 })
  expect(pollQuery("/x?after=9007199254740991", limits)?.after).toBe(9007199254740991)
  expect(pollQuery("/x?after=9007199254740992", limits)).toBeUndefined()
  // The limit `wait` is in ms: its whole seconds, rounded down.
  expect(pollQuery("/x?after=0&wait=2", { events: 10, wait: 2_999 })?.wait).toBe(2)
  expect(pollQuery("/x?after=0&wait=3", { events: 10, wait: 2_999 })).toBeUndefined()
  expect(pollQuery("/x?after=0&limit=11", { events: 10, wait: 2_999 })).toBeUndefined()
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const all = yield* stored(TENANT_A, A150, 0)
    const first = yield* get(h, A150, "?after=0", TOKEN_A)
    expect(first.status).toBe(200)
    expect(first.text).toBe(eventsText(all.slice(0, 100)))
    const twice = yield* get(h, A150, "?after=2&after=0&limit=3&limit=50&wait=0&wait=5&other=x", TOKEN_A)
    expect(numbers(twice)).toEqual([3, 4, 5])
    // `wait` 0 is the default: no client, no hold.
    expect(h.counts.holds).toBe(0)
    nothingLeft(h)
    yield* h.close
  }))
})

// With wait 0
// -----------

test("with wait 0: the events after after, at most limit, each as the fit made it, byte for byte; no hold and no client at any moment", async () => {
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const all = yield* stored(TENANT_A, A150, 0)
    expect(all.map((event) => event.n)).toEqual(range(1, 151))
    let clientsSeen = 0
    h.counts.hook = () => Effect.sync(() => {
      clientsSeen += h.host.registry.size().clients + h.host.registry.size().channels
    })
    const ten = yield* get(h, A150, "?after=140&limit=1000", TOKEN_A)
    expect(ten.text).toBe(eventsText(all.slice(140)))
    const five = yield* get(h, A150, "?after=7&limit=5", TOKEN_A)
    expect(five.text).toBe(eventsText(all.slice(7, 12)))
    const most = yield* get(h, A150, "?after=0&limit=1000", TOKEN_A)
    expect(numbers(most)).toEqual(range(1, 151))
    // An after at the end, or above the chat's seq: no event, not refused.
    expect((yield* get(h, A150, "?after=150", TOKEN_A)).text).toBe("{\"events\":[]}")
    expect((yield* get(h, A150, "?after=9999", TOKEN_A)).text).toBe("{\"events\":[]}")
    expect(clientsSeen).toBe(0)
    expect(h.counts.holds).toBe(0)
    expect(h.counts.leaves + h.counts.agains).toBe(0)
    nothingLeft(h)
    yield* h.close
  }))
})

test("with wait 0: the answer ends before the event that would pass pageBytes, and the next request goes on after its last number", async () => {
  await run(Effect.gen(function*() {
    const all = yield* stored(TENANT_A, A10, 0)
    const sizes = all.map((event) => fitted(event).bytes)
    // Room for the first three and not the fourth.
    const room = sizes[0]! + sizes[1]! + sizes[2]! + sizes[3]! - 1
    const h = yield* harness({}, { entry: room, pageBytes: room })
    const first = yield* get(h, A10, "?after=0&limit=10", TOKEN_A)
    expect(first.text).toBe(eventsText(all.slice(0, 3)))
    const next = yield* get(h, A10, "?after=3&limit=10", TOKEN_A)
    expect(numbers(next)).toEqual([4, 5, 6])
    expect(next.text).toBe(eventsText(all.slice(3, 6)))
    nothingLeft(h)
    yield* h.close
  }))
})

test("an event over entry that the fit cannot cut gives 500 internal; its log line has its number and size and no text", async () => {
  const chat = await newChat(TENANT_A, 3, (k) => "SECRET-TEXT-" + k + "-" + "q".repeat(300))
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const all = yield* stored(TENANT_A, chat, 0)
    const h = yield* harness({}, { entry: 200 })
    for (const wait of ["0", "5"]) {
      const from = lines.length
      const answer = yield* get(h, chat, "?after=1&wait=" + wait, bearer)
      expect([answer.status, answer.text]).toEqual([500, errorText("internal")])
      const logged = parsed(from)
      const fault = logged.filter((line) => line.annotations["n"] !== undefined)
      expect(fault.map((line) => line.annotations)).toEqual([{ n: 2, bytes: utf8Bytes(JSON.stringify(all[1])) }])
      expect(logged.some((line) => line.annotations["status"] === 500)).toBe(true)
      expect(lines.slice(from).join("\n")).not.toContain("SECRET-TEXT")
      expect(lines.slice(from).join("\n")).not.toContain("after=")
      nothingLeft(h)
    }
    yield* h.close
  }))
})
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length

// With a wait above 0
// -------------------

test("with a wait above 0 and events there: the answer at once; the client and the hold are gone after it", async () => {
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const all = yield* stored(TENANT_A, A10, 0)
    let during = { clients: 0, channels: 0 }
    h.counts.hook = () => Effect.sync(() => {
      during = h.host.registry.size()
    })
    const answer = yield* get(h, A10, "?after=4&wait=25", TOKEN_A)
    expect(answer.text).toBe(eventsText(all.slice(4)))
    // It was a client during its read, and is none after.
    expect(during).toEqual({ channels: 1, clients: 1 })
    expect(h.counts.holds).toBe(1)
    expect(h.counts.leaves + h.counts.agains).toBe(0)
    nothingLeft(h)
    yield* h.close
  }))
})

test("an event committed between the first read and the join's check: R5 does not join, reads again and answers with it, in the same place and deadline", async () => {
  const chat = await newChat(TENANT_A, 2)
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const placesInHook: Array<number> = []
    h.counts.hook = (read, call) =>
      Effect.gen(function*() {
        placesInHook.push(h.gate.inFlight())
        if (read !== chat || call !== 1) return
        // The listener's part: the event is in the store, then given.
        const [n] = yield* addEvents(TENANT_A, chat, 1)
        const [event] = yield* stored(TENANT_A, chat, n! - 1, 1)
        const channel = channelOf(h, TENANT_A, chat)!
        yield* channel.give(fitted(event!))
      })
    // It answers with the clock still: it does not wait the event out.
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=2&wait=10", bearer))
    yield* until(() => fiber.pollUnsafe() !== undefined)
    const answer = yield* Fiber.join(fiber)
    const [event] = yield* stored(TENANT_A, chat, 2)
    expect(answer.text).toBe(eventsText([event!]))
    expect(h.counts.reads.get(chat)).toBe(2)
    expect(placesInHook).toEqual([1, 1])
    expect(h.counts.leaves + h.counts.agains).toBe(0)
    nothingLeft(h)
    yield* h.close
  }))
})

test("it joins and an event comes at 3 s of a wait of 10: the answer at 3 s; while it waits it holds no place; pieces, more than buffer, never reach its buffer, do not end it and are not in the answer", async () => {
  const chat = await newChat(TENANT_A)
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const h = yield* harness({ buffer: 16, page: 16 })
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=0&wait=10", bearer))
    yield* waiting(h, chat)
    expect(h.gate.inFlight()).toBe(0)
    expect(h.host.reads.taken()).toBe(0)
    expect(h.counts.leaves).toBe(1)
    yield* TestClock.adjust(1_000)
    const channel = channelOf(h, TENANT_A, chat)!
    const client = channel.clients[0]!
    for (let k = 0; k < 3 * 16; k++) {
      yield* channel.givePiece(fitted({ type: "text", turn: 1, delta: "piece " + k } as never))
      expect(client.size).toEqual({ entries: 0, bytes: 0 })
      yield* settle
    }
    expect(client.ended).toBeNull()
    expect(client.size).toEqual({ entries: 0, bytes: 0 })
    yield* TestClock.adjust(2_000)
    expect(fiber.pollUnsafe()).toBeUndefined()
    // At 3 s, a message in: the chat loads, its turn runs, and the listener
    // gives its events.
    const sent = yield* h.host.say(TENANT_A, chat, "hello", null)
    yield* until(() => fiber.pollUnsafe() !== undefined)
    const answer = yield* Fiber.join(fiber)
    expect(yield* Clock.currentTimeMillis).toBe(NOW + 3_000)
    expect(answer.status).toBe(200)
    const events = JSON.parse(answer.text).events as Array<{ n: number; type: string }>
    expect(events.length).toBeGreaterThan(0)
    expect(events.map((event) => event.n)).toEqual(range(1, events.length + 1))
    expect(events.every((event) => ["accepted", "message", "start", "call", "end"].includes(event.type))).toBe(true)
    expect(sent).toBeDefined()
    // It left the channel; the loaded chat's own hold stays.
    expect(channel.clients).toEqual([])
    expect(h.counts.agains).toBe(1)
    expect(h.gate.inFlight()).toBe(0)
    expect(h.host.reads.taken()).toBe(0)
    yield* h.close
    nothingLeft(h)
  }))
})

test("it joins and no event comes: {\"events\":[]} at wait seconds, not before", async () => {
  const chat = await newChat(TENANT_A, 4)
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=4&wait=5", bearer))
    yield* waiting(h, chat)
    yield* TestClock.adjust(4_999)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    const answer = yield* Fiber.join(fiber)
    expect([answer.status, answer.text]).toEqual([200, "{\"events\":[]}"])
    expect(h.counts.reads.get(chat)).toBe(2)
    expect([h.counts.leaves, h.counts.agains]).toEqual([1, 1])
    nothingLeft(h)
    yield* h.close
  }))
})

// A burst of pieces after the join (lead, ec-cxuj5)
// --------------------------------------------------
// R5's client gets no piece: a burst between the join and the wait's first
// take (the review's finding, ec-ekvu7) puts nothing into its buffer, so it
// cannot end the wait as `slow` and the answer comes with the first numbered
// event or at `wait`, not before.

// The two bursts: with `buffer` and `page` of 1, two small pieces; with every
// default limit, thirteen pieces of 700,000 bytes of text, each within
// `entry`, all past `bufferBytes`.
const BURSTS = [
  { name: "buffer and page of 1, two small pieces", over: { buffer: 1, page: 1 }, delta: "a piece", count: 2 },
  { name: "every default limit, thirteen pieces of 700,000 bytes", over: {}, delta: "x".repeat(700_000), count: 13 }
] as const
const burstPiece = (delta: string) => fitted({ type: "text", turn: 1, delta } as never)

// What a case saw of R5's client right after a burst.
interface AfterBurst {
  readonly given: number
  readonly size: { readonly entries: number; readonly bytes: number }
  readonly ended: unknown
}

// The end of a wait that a burst did not end, by `end`: a numbered event (the
// answer at once, with it, with the clock still), or the wait's 10 s (the
// empty answer at 10 s, not before). Then nothing of the request is left: no
// channel, client, hold, place or timer, and its fiber is done.
const endOfWait = (
  h: Harness,
  chat: string,
  fiber: Fiber.Fiber<Seen, unknown>,
  counter: { readonly pending: number },
  end: "event" | "wait"
) =>
  Effect.gen(function*() {
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    expect(counter.pending).toBe(1)
    const start = yield* Clock.currentTimeMillis
    if (end === "event") {
      const [n] = yield* addEvents(TENANT_A, chat, 1)
      const [event] = yield* stored(TENANT_A, chat, n! - 1, 1)
      yield* channelOf(h, TENANT_A, chat)!.give(fitted(event!))
      yield* until(() => fiber.pollUnsafe() !== undefined)
      const answer = yield* Fiber.join(fiber)
      expect([answer.status, answer.text]).toEqual([200, eventsText([event!])])
      expect(yield* Clock.currentTimeMillis).toBe(start)
    } else {
      yield* TestClock.adjust(9_999)
      yield* settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const answer = yield* Fiber.join(fiber)
      expect([answer.status, answer.text]).toEqual([200, "{\"events\":[]}"])
      expect(yield* Clock.currentTimeMillis).toBe(start + 10_000)
    }
    yield* settle
    expect(counter.pending).toBe(0)
    expect([h.counts.leaves, h.counts.agains]).toEqual([1, 1])
    nothingLeft(h)
  })

test("a burst of pieces between the join and the first take, with no pause, with buffer and page of 1 and with every default limit: the poll stays pending, answers the event when one comes, and {\"events\":[]} at wait, not before; nothing is left", async () => {
  const big = burstPiece(BURSTS[1].delta)
  expect(big.bytes).toBeLessThanOrEqual(DEFAULTS.entry)
  expect(BURSTS[1].count * big.bytes).toBeGreaterThan(DEFAULTS.bufferBytes)
  expect(BURSTS[1].count).toBeGreaterThan(0)
  const seenAll: Array<string> = []
  for (const burst of BURSTS) {
    for (const end of ["event", "wait"] as const) {
      const chat = await newChat(TENANT_A)
      const bearer = await token([chat])
      await run(Effect.gen(function*() {
        const h = yield* harness(burst.over)
        const { clock, counter } = yield* countingClock
        const piece = burstPiece(burst.delta)
        let after: AfterBurst | undefined
        // In the request's fiber, after the join: the pieces, one give after
        // the other, before the wait takes.
        h.counts.afterLeave = () =>
          Effect.gen(function*() {
            const channel = channelOf(h, TENANT_A, chat)!
            const client = channel.clients[0]!
            expect(client.joined).toBe(true)
            for (let k = 0; k < burst.count; k++) yield* channel.givePiece(piece)
            after = { given: client.given, size: client.size, ended: client.ended }
          })
        const fiber = yield* Effect.forkChild(get(h, chat, "?after=0&wait=10", bearer).pipe(Effect.provideService(Clock.Clock, clock)))
        yield* until(() => after !== undefined)
        expect([burst.name, after]).toEqual([burst.name, { given: 0, size: { entries: 0, bytes: 0 }, ended: null }])
        yield* endOfWait(h, chat, fiber, counter, end)
        seenAll.push(burst.name + ": " + end)
        yield* h.close
      }))
    }
  }
  expect(seenAll.length).toBe(4)
})

test("the review's probe: a producer that runs in a pause of the scheduler after the join, with every default limit: the poll stays pending, answers the event when one comes, and {\"events\":[]} at wait, not before; nothing is left", async () => {
  const piece = burstPiece(BURSTS[1].delta)
  for (let trial = 0; trial < 10; trial++) {
    const end = trial % 2 === 0 ? "event" : "wait"
    const chat = await newChat(TENANT_A)
    const bearer = await token([chat])
    await run(Effect.gen(function*() {
      const h = yield* harness()
      const { clock, counter } = yield* countingClock
      const context = yield* Effect.context<never>()
      let paused = false
      let after: AfterBurst | undefined
      let producer: Fiber.Fiber<void> | undefined
      // The request's scheduler: once its client joined and the step `leave`
      // ran, the request yields one time, and another fiber, of its own
      // runtime, gives thirteen pieces before it runs on.
      const scheduler = new Scheduler.MixedScheduler()
      const normal = scheduler.shouldYield.bind(scheduler)
      scheduler.shouldYield = (fiber) => {
        const channel = channelOf(h, TENANT_A, chat)
        const client: Client | undefined = channel?.clients[0]
        if (!paused && channel !== undefined && client?.joined === true && h.counts.leaves === 1) {
          paused = true
          queueMicrotask(() => {
            producer = Effect.runFork(Effect.gen(function*() {
              for (let k = 0; k < 13; k++) yield* channel.givePiece(piece)
              after = { given: client.given, size: client.size, ended: client.ended }
            }).pipe(Effect.provideContext(context)))
          })
          return true
        }
        return normal(fiber)
      }
      const fiber = Effect.runFork(
        get(h, chat, "?after=0&wait=10", bearer).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provideContext(Context.add(context, Scheduler.Scheduler, scheduler))
        ),
        { scheduler }
      )
      yield* until(() => after !== undefined)
      expect([trial, after]).toEqual([trial, { given: 0, size: { entries: 0, bytes: 0 }, ended: null }])
      yield* endOfWait(h, chat, fiber, counter, end)
      expect(producer!.pollUnsafe()).toBeDefined()
      yield* h.close
    }))
  }
})

// The place again
// ---------------

test("the place again: with every place of requests taken at the wait's end, 503 busy with retry-after 1, and nothing is left", async () => {
  const chat = await newChat(TENANT_A, 1)
  const bearer = await token([chat, A10])
  await run(Effect.gen(function*() {
    const h = yield* harness({ requests: 1 })
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=1&wait=5", bearer))
    yield* waiting(h, chat)
    // Another request takes the one place while R5 waits.
    const blocker = yield* Effect.forkChild(h.gate.route("R3", A10, () => Effect.never).pipe(Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new globalThis.Request("http://127.0.0.1/v1/chats/" + A10 + "/messages", { headers: { authorization: "Bearer " + bearer } }))
    )))
    yield* until(() => h.gate.inFlight() === 1)
    yield* TestClock.adjust(5_000)
    const answer = yield* Fiber.join(fiber)
    expect([answer.status, answer.text, answer.headers["retry-after"]]).toEqual([503, errorText("busy"), "1"])
    expect(h.counts.reads.get(chat)).toBe(1)
    expect(h.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    expect(h.gate.inFlight()).toBe(1)
    yield* Fiber.interrupt(blocker)
    nothingLeft(h)
    yield* h.close
  }))
})

test("the place again: its deadline is a new request from the wait's end, not the first", async () => {
  const chat = await newChat(TENANT_A, 1)
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const h = yield* harness({ request: 30_000 })
    // The read after the wait does not end.
    h.counts.hook = (read, call) => (read === chat && call === 2 ? Effect.never : Effect.void)
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=1&wait=20", bearer))
    yield* waiting(h, chat)
    yield* TestClock.adjust(20_000)
    yield* until(() => h.host.reads.taken() === 1)
    expect(h.gate.inFlight()).toBe(1)
    // 30 s from the head: the first deadline, which no longer holds.
    yield* TestClock.adjust(10_000)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(19_999)
    yield* settle
    expect(fiber.pollUnsafe()).toBeUndefined()
    // 30 s from the wait's end.
    yield* TestClock.adjust(1)
    const answer = yield* Fiber.join(fiber)
    expect([answer.status, answer.text, answer.headers["retry-after"]]).toEqual([503, errorText("busy"), "1"])
    nothingLeft(h)
    yield* h.close
  }))
})

// The bounds
// ----------

test("the bounds: a client past chatClients and past hostClients gets 503 busy with no retry-after, also with events there; a read that waits readsWait gets 503 with retry-after 1", async () => {
  await run(Effect.gen(function*() {
    const h = yield* harness({ chatClients: 1, hostClients: 1 })
    const first = yield* Effect.forkChild(get(h, A10, "?after=10&wait=5", TOKEN_A))
    yield* waiting(h, A10)
    // The chat's second client, with events after its after.
    const chat = yield* get(h, A10, "?after=0&wait=5", TOKEN_A)
    expect([chat.status, chat.text, chat.headers["retry-after"]]).toEqual([503, errorText("busy"), undefined])
    // A client of another chat, past the host's bound.
    const host = yield* get(h, A150, "?after=0&wait=5", TOKEN_A)
    expect([host.status, host.text, host.headers["retry-after"]]).toEqual([503, errorText("busy"), undefined])
    expect(h.counts.reads.get(A150)).toBeUndefined()
    expect(h.counts.reads.get(A10)).toBe(1)
    expect(h.host.registry.size()).toEqual({ channels: 1, clients: 1 })
    yield* TestClock.adjust(5_000)
    expect((yield* Fiber.join(first)).text).toBe("{\"events\":[]}")
    nothingLeft(h)
    yield* h.close
  }))
  await run(Effect.gen(function*() {
    const h = yield* harness({ reads: 1, readsWait: 1_000 })
    const holder = yield* Effect.forkChild(h.host.reads.withPlace(Effect.never))
    yield* until(() => h.host.reads.taken() === 1)
    for (const wait of ["0", "5"]) {
      const fiber = yield* Effect.forkChild(get(h, A10, "?after=0&wait=" + wait, TOKEN_A))
      yield* until(() => h.host.reads.waiting() === 1)
      yield* settle
      yield* TestClock.adjust(999)
      yield* settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const answer = yield* Fiber.join(fiber)
      expect([answer.status, answer.text, answer.headers["retry-after"]]).toEqual([503, errorText("busy"), "1"])
      expect(h.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    }
    yield* Fiber.interrupt(holder)
    nothingLeft(h)
    yield* h.close
  }))
})

// The ends of a wait
// ------------------

test("the host's stop while it waits: 503 busy with retry-after 1", async () => {
  const chat = await newChat(TENANT_A)
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=0&wait=10", bearer))
    yield* waiting(h, chat)
    yield* h.close
    const answer = yield* Fiber.join(fiber)
    expect([answer.status, answer.text, answer.headers["retry-after"]]).toEqual([503, errorText("busy"), "1"])
    expect(h.counts.agains).toBe(0)
    nothingLeft(h)
  }))
})

test("an event that cannot be given while it waits: it reads and answers as after an event, and its read gives 500", async () => {
  const chat = await newChat(TENANT_A, 1, () => "SECRET-LARGE-" + "z".repeat(300))
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const h = yield* harness({}, { entry: 200 })
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=1&wait=10", bearer))
    yield* waiting(h, chat)
    const [n] = yield* addEvents(TENANT_A, chat, 1, () => "SECRET-LARGE-" + "y".repeat(300))
    const from = lines.length
    yield* channelOf(h, TENANT_A, chat)!.cannotGive(n!)
    const answer = yield* Fiber.join(fiber)
    expect([answer.status, answer.text]).toEqual([500, errorText("internal")])
    expect(h.counts.agains).toBe(1)
    expect(parsed(from).filter((line) => line.annotations["n"] !== undefined).map((line) => line.annotations["n"])).toEqual([2])
    expect(lines.slice(from).join("\n")).not.toContain("SECRET-LARGE")
    nothingLeft(h)
    yield* h.close
  }))
})

test("a client that goes away while it waits: no client, no hold, no place, no fiber or timer is left", async () => {
  const chat = await newChat(TENANT_A)
  const bearer = await token([chat])
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const { clock, counter } = yield* countingClock
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=0&wait=10", bearer).pipe(Effect.provideService(Clock.Clock, clock)))
    yield* waiting(h, chat)
    // The wait's timer waits; the gate's deadline stopped at the join.
    expect(counter.pending).toBe(1)
    yield* Fiber.interrupt(fiber)
    yield* settle
    expect(counter.pending).toBe(0)
    nothingLeft(h)
    expect(h.counts.agains).toBe(0)
    yield* h.close
  }))
})

test("a token whose exp passes while it waits: the request is answered", async () => {
  const chat = await newChat(TENANT_A, 2)
  const bearer = await token([chat], S + 3)
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const { clock, counter } = yield* countingClock
    const fiber = yield* Effect.forkChild(get(h, chat, "?after=2&wait=10", bearer).pipe(Effect.provideService(Clock.Clock, clock)))
    yield* waiting(h, chat)
    yield* TestClock.adjust(10_000)
    const answer = yield* Fiber.join(fiber)
    expect([answer.status, answer.text]).toEqual([200, "{\"events\":[]}"])
    yield* settle
    expect(counter.pending).toBe(0)
    nothingLeft(h)
    // The same token, now, is refused.
    expect((yield* get(h, chat, "?after=2", bearer)).status).toBe(401)
    yield* h.close
  }))
})

// The two tenants
// ---------------

// Every row of the tables that a read of events touches, and the chats' and
// launches'.
const everyRow = () => ["everchat_event", "everchat_msg", "everchat_chat", "everchat_launch"].map((table) => rows(FILE, "select * from " + table + " order by rowid"))

test("the two tenants: a token of A for B's chat, and A's token that names B's chat, get 404 no_chat with wait 0 and wait 5, and read nothing of B", async () => {
  const notB = await token([A10])
  const before = everyRow()
  await run(Effect.gen(function*() {
    const h = yield* harness()
    for (const bearer of [notB, TOKEN_A]) {
      for (const wait of ["0", "5"]) {
        const answer = yield* get(h, B3, "?after=0&wait=" + wait, bearer)
        expect([answer.status, answer.text]).toEqual([404, errorText("no_chat")])
      }
    }
    expect(h.counts.holds).toBe(0)
    expect(h.counts.reads.size).toBe(0)
    nothingLeft(h)
    yield* h.close
  }))
  const after = everyRow()
  expect(after).toEqual(before)
  // B's own token reads them.
  const own = await token([B3], S + 600, TENANT_B)
  await run(Effect.gen(function*() {
    const h = yield* harness()
    const answer = yield* get(h, B3, "?after=0", own)
    expect(numbers(answer)).toEqual([1, 2, 3])
    yield* h.close
  }))
})
