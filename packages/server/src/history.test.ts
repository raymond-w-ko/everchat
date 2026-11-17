// Tests of R2 and R3, the snapshot and older messages (history.ts;
// docs/host.md, section 3, "R2", "R3" and "Admission", 11; section 4, "A
// message" and "The snapshot"): the queries, the cut of a snapshot in bytes,
// one state of the store, R3's range and its bound, the places of `reads`,
// and the two tenants of check 3. The chats are written through the SQLite
// store of this file; the secret is made-up bytes.

import { afterAll, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Redacted, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Chats, type Message, type Pick, type Reading, type Store, StoreError } from "@everchat/core/store"
import { chatsLayer } from "@everchat/sqlite/bun"
import { utf8 } from "./fit.ts"
import {
  cutMessages,
  cutSnapshot,
  LAST,
  messageJson,
  messagesRoute,
  SnapshotTooLarge,
  snapshotRoute
} from "./history.ts"
import { ERRORS, makeGate } from "./http.ts"
import { DEFAULTS, type Limits } from "./limits.ts"
import { makeReads, type ReadPlaces } from "./reads.ts"
import { makeToken } from "./token.ts"

const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 3 * i + 11))
const S = 1_800_000_000
const NOW = S * 1000 + 500
const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }
const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

// The log of the tests, as JSON lines with their annotations.
const lines: Array<string> = []
const capture = Logger.layer([Logger.make((options) => {
  lines.push(Logger.formatJson.log(options))
})])

const home = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-history-"))
const scope = Effect.runSync(Scope.make())
const built = await Effect.runPromise(Layer.buildWithScope(chatsLayer(path.join(home, "chats.db")), scope))
const chats = Context.get(built, Chats)
afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  fs.rmSync(home, { recursive: true, force: true })
})

// Write to a chat through its store, for one launch.
let launches = 0
const write = <A>(tenant: string, chat: string, f: (store: typeof Store.Service) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(chats.store(tenant, chat, { ...LAUNCH, runTag: "run-" + ++launches }), f)))

const newChat = (tenant: string) => Effect.runPromise(chats.make(tenant, PICK))
const texts = (store: typeof Store.Service, list: ReadonlyArray<string>) => store.append(list.map((text) => ({ kind: "user" as const, text })))

// A's chat of 120 messages and 3 events; A's empty chat; A's chat with a
// turn that runs; B's chat, whose texts are marked.
const A120 = await newChat(TENANT_A)
await write(TENANT_A, A120, (store) =>
  Effect.gen(function*() {
    yield* texts(store, Array.from({ length: 120 }, (_, i) => "message " + i))
    yield* store.addEvent({ type: "message", msg: 0, msgLast: 0 })
    yield* store.addEvent({ type: "message", msg: 1, msgLast: 1 })
    yield* store.addEvent({ type: "message", msg: 2, msgLast: 2 })
  }))
const EMPTY = await newChat(TENANT_A)
const RUNNING = await newChat(TENANT_A)
const TURN = await write(TENANT_A, RUNNING, (store) =>
  Effect.gen(function*() {
    yield* texts(store, ["hello"])
    return yield* store.startTurn({ pick: PICK, head: "{\"system\":\"HEAD-OF-THE-TURN\"}", firstMsg: 0 })
  }))
const B1 = await newChat(TENANT_B)
await write(TENANT_B, B1, (store) => texts(store, ["B-SECRET-ONE", "B-SECRET-TWO"]))

// A chat of five messages with characters of 1, 2, 3 and 4 bytes.
const FIVE = await newChat(TENANT_A)
await write(TENANT_A, FIVE, (store) => texts(store, ["a1", "é2é", "€3€€", "😀4😀", "x5é€😀\u0001\"\\"]))

// A chat of three large messages, and one at its largest: a page of 30,000
// control characters, each 6 bytes of JSON.
const LARGE = await newChat(TENANT_A)
await write(TENANT_A, LARGE, (store) => texts(store, ["y".repeat(1000), "z".repeat(1000), "w".repeat(1000), "\u0001".repeat(30_000)]))

const token = (chatsOf: ReadonlyArray<string>) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(NOW), makeToken(SECRET, { tenant: TENANT_A, chats: [...chatsOf], exp: S + 600 })).pipe(
    Effect.provide(TestClock.layer())
  ))
const TOKEN = await token([A120, EMPTY, RUNNING, FIVE, LARGE, B1])
const NOT_B = await token([A120])

const limitsOf = (given: Partial<Limits> = {}): Limits => ({ ...DEFAULTS, ...given })

// The two routes over a gate and the places, with `limits`.
const routes = (given: Partial<Limits> = {}, places?: ReadPlaces) => {
  const limits = limitsOf(given)
  const gate = makeGate({ secret: SECRET, origins: [], limits, chats })
  const reads = places ?? makeReads(limits)
  return { r2: snapshotRoute(gate, reads, limits), r3: messagesRoute(gate, reads, limits), places: reads, gate }
}

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.andThen(TestClock.setTime(NOW), effect).pipe(Effect.provide(Layer.merge(TestClock.layer(), capture))))

const get = (
  route: (chat: string | undefined) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>,
  chat: string,
  query = "",
  bearer = TOKEN
) =>
  route(chat).pipe(Effect.provideService(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request("http://127.0.0.1/v1/chats/" + chat + query, { headers: { authorization: "Bearer " + bearer } }))
  ))

// An answer as the web sees it: each has the gate's three headers.
const seen = async (response: HttpServerResponse.HttpServerResponse) => {
  const web = HttpServerResponse.toWeb(response)
  const headers = Object.fromEntries(web.headers)
  expect(headers["cache-control"]).toBe("no-store")
  expect(headers["referrer-policy"]).toBe("no-referrer")
  expect(headers["x-content-type-options"]).toBe("nosniff")
  const text = await web.text()
  if (web.status === 200) {
    expect(headers["content-type"]).toBe("application/json; charset=utf-8")
  }
  return { status: web.status, headers, text }
}
const call = async (effect: Effect.Effect<HttpServerResponse.HttpServerResponse>) => seen(await run(effect))
const ids = (list: ReadonlyArray<{ i: number }>) => list.map((message) => message.i)
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k)
const errorText = (code: keyof typeof ERRORS) => JSON.stringify({ error: code, message: ERRORS[code].message })

// The chat's reads of the store, as check 3 gives them.
const readsOf = (tenant: string, chat: string) => Effect.runPromise(chats.reads(tenant, chat))

// R2
// --

test("R2 on a chat of 120 messages gives the last 50, count 120 and its seq; last=200 gives 120; each message is the store's, field for field", async () => {
  const { r2 } = routes()
  const answer = await call(get(r2, A120))
  expect(answer.status).toBe(200)
  const snapshot = JSON.parse(answer.text)
  expect(Object.keys(snapshot)).toEqual(["chat", "seq", "count", "messages", "turn"])
  expect(snapshot.chat).toEqual({ uuid: A120, pick: PICK, goal: null })
  expect(snapshot.seq).toBe(3)
  expect(snapshot.count).toBe(120)
  expect(ids(snapshot.messages)).toEqual(range(70, 120))
  expect(snapshot.turn).toBeNull()
  const stored = await Effect.runPromise((await readsOf(TENANT_A, A120)).messages(70, 120))
  expect(snapshot.messages).toEqual(stored.map(messageJson))
  expect(Object.keys(snapshot.messages[0])).toEqual(["i", "kind", "text", "size", "more", "line", "turn", "call", "launch", "created"])
  expect(LAST).toBe(50)
  const all = JSON.parse((await call(get(r2, A120, "?last=200"))).text)
  expect(ids(all.messages)).toEqual(range(0, 120))
  expect(ids(JSON.parse((await call(get(r2, A120, "?last=1"))).text).messages)).toEqual([119])
  // Another parameter is not read and not refused; of a name given twice,
  // the first counts.
  expect(ids(JSON.parse((await call(get(r2, A120, "?other=x&last=3&last=999"))).text).messages)).toEqual([117, 118, 119])
})

test("R2: last=0, 201, 1.5, -1, +5, 05x, an empty last and other forms get 400 bad_request", async () => {
  const { r2 } = routes()
  for (const last of ["0", "201", "1.5", "-1", "+5", "%2B5", "05x", "", "1e2", "0x10", "%205", "5%20", "5%00", "%35%", "99999999999999999", "٥"]) {
    const answer = await call(get(r2, A120, "?last=" + last))
    expect([last, answer.status]).toEqual([last, 400])
    expect(answer.text).toBe(errorText("bad_request"))
  }
  expect((await call(get(r2, A120, "?last"))).status).toBe(400)
  expect(ids(JSON.parse((await call(get(r2, A120, "?last=005"))).text).messages)).toEqual(range(115, 120))
})

test("R2: last of 17 digits with leading zeros gets 400; of 16 digits with leading zeros and a value in range passes", async () => {
  const { r2 } = routes()
  const long = await call(get(r2, A120, "?last=" + "5".padStart(17, "0")))
  expect([long.status, long.text]).toEqual([400, errorText("bad_request")])
  const sixteen = "5".padStart(16, "0")
  expect(sixteen.length).toBe(16)
  const answer = await call(get(r2, A120, "?last=" + sixteen))
  expect(answer.status).toBe(200)
  expect(ids(JSON.parse(answer.text).messages)).toEqual(range(115, 120))
})

test("R2 on a chat with no message and no event gives an empty list, seq 0, count 0 and turn null", async () => {
  const { r2 } = routes()
  const snapshot = JSON.parse((await call(get(r2, EMPTY))).text)
  expect(snapshot).toEqual({ chat: { uuid: EMPTY, pick: PICK, goal: null }, seq: 0, count: 0, messages: [], turn: null })
})

test("a turn that runs is in turn with its four fields, and not its head", async () => {
  const { r2 } = routes()
  const answer = await call(get(r2, RUNNING))
  const snapshot = JSON.parse(answer.text)
  expect(snapshot.turn).toEqual({ id: TURN.id, pick: PICK, firstMsg: 0, created: TURN.created })
  expect(answer.text).not.toContain("HEAD-OF-THE-TURN")
  expect(answer.text).not.toContain("head")
})

test("the snapshot is one state: its four reads of the store all run inside Reading.snapshot", async () => {
  const reads = await readsOf(TENANT_A, A120)
  let inside = 0
  const outside: Array<string> = []
  const watched = new Proxy(reads, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key === "snapshot") {
        return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          target.snapshot(Effect.acquireUseRelease(Effect.sync(() => inside++), () => effect, () => Effect.sync(() => inside--)))
      }
      const note = () => {
        if (inside === 0) outside.push(String(key))
      }
      if (Effect.isEffect(value)) return Effect.andThen(Effect.sync(note), value)
      if (typeof value === "function") {
        return (...args: Array<unknown>) => Effect.andThen(Effect.sync(note), (value as (...a: Array<unknown>) => Effect.Effect<unknown>).apply(target, args))
      }
      return value
    }
  }) as Reading
  const text = await Effect.runPromise(cutSnapshot(watched, 50, DEFAULTS.pageBytes))
  expect(JSON.parse(text).count).toBe(120)
  expect(outside).toEqual([])
})

// The cut
// -------


test("a room that holds three of five messages gives the newest three, its text at most the room in bytes; one byte less gives two", async () => {
  const reads = await readsOf(TENANT_A, FIVE)
  const full = JSON.parse(await Effect.runPromise(cutSnapshot(reads, 50, DEFAULTS.pageBytes)))
  expect(ids(full.messages)).toEqual([0, 1, 2, 3, 4])
  const base = utf8(JSON.stringify({ ...full, messages: [] }))
  const sizes = full.messages.map((message: Message) => utf8(JSON.stringify(message)))
  const three = base + sizes[2] + sizes[3] + sizes[4] + 2
  const cut = await Effect.runPromise(cutSnapshot(reads, 50, three))
  expect(utf8(cut)).toBe(three)
  expect(ids(JSON.parse(cut).messages)).toEqual([2, 3, 4])
  const less = await Effect.runPromise(cutSnapshot(reads, 50, three - 1))
  expect(utf8(less)).toBeLessThanOrEqual(three - 1)
  expect(ids(JSON.parse(less).messages)).toEqual([3, 4])
  // `last` bounds the run too.
  expect(ids(JSON.parse(await Effect.runPromise(cutSnapshot(reads, 2, DEFAULTS.pageBytes))).messages)).toEqual([3, 4])
})

test("a room that holds the other fields and not the newest message gives an empty list; a room under the other fields gives SnapshotTooLarge with the size", async () => {
  const reads = await readsOf(TENANT_A, FIVE)
  const full = JSON.parse(await Effect.runPromise(cutSnapshot(reads, 50, DEFAULTS.pageBytes)))
  const base = utf8(JSON.stringify({ ...full, messages: [] }))
  const newest = utf8(JSON.stringify(full.messages[4]))
  const empty = await Effect.runPromise(cutSnapshot(reads, 50, base + newest - 1))
  expect(JSON.parse(empty).messages).toEqual([])
  expect(utf8(empty)).toBe(base)
  expect(JSON.parse(await Effect.runPromise(cutSnapshot(reads, 50, base))).messages).toEqual([])
  const fault = await Effect.runPromise(Effect.flip(cutSnapshot(reads, 50, base - 1)))
  expect(fault).toBeInstanceOf(SnapshotTooLarge)
  expect(fault).toMatchObject({ _tag: "SnapshotTooLarge", bytes: base })
})

test("R2 whose other fields pass pageBytes answers 500 internal, with a log line that has the size in bytes and no text", async () => {
  const { r2 } = routes({ pageBytes: 60 })
  lines.length = 0
  const answer = await call(get(r2, FIVE))
  expect(answer.status).toBe(500)
  expect(answer.text).toBe(errorText("internal"))
  const full = JSON.parse(await Effect.runPromise(cutSnapshot(await readsOf(TENANT_A, FIVE), 50, DEFAULTS.pageBytes)))
  const base = utf8(JSON.stringify({ ...full, messages: [] }))
  const sized = lines.map((line) => JSON.parse(line)).filter((line) => line.annotations?.bytes !== undefined)
  expect(sized.length).toBe(1)
  expect(sized[0].annotations.bytes).toBe(base)
  const all = lines.join("\n")
  for (const text of [FIVE, "gpt-test", "openai", "a1", "é2é"]) expect(all).not.toContain(text)
})

// R3
// --

test("R3 gives the messages from `from` up to and not with `to`, in order; a range past the chat's last id gives fewer or none", async () => {
  const { r3 } = routes()
  const answer = await call(get(r3, A120, "?from=10&to=20"))
  expect(answer.status).toBe(200)
  const got = JSON.parse(answer.text)
  expect(Object.keys(got)).toEqual(["messages"])
  expect(ids(got.messages)).toEqual(range(10, 20))
  const stored = await Effect.runPromise((await readsOf(TENANT_A, A120)).messages(10, 20))
  expect(got.messages).toEqual(stored.map(messageJson))
  expect(ids(JSON.parse((await call(get(r3, A120, "?to=1&from=0"))).text).messages)).toEqual([0])
  expect(ids(JSON.parse((await call(get(r3, A120, "?from=0&to=200"))).text).messages)).toEqual(range(0, 120))
  expect(ids(JSON.parse((await call(get(r3, A120, "?from=115&to=130"))).text).messages)).toEqual(range(115, 120))
  expect((await call(get(r3, A120, "?from=120&to=130"))).text).toBe("{\"messages\":[]}")
  expect((await call(get(r3, A120, "?from=9007199254740990&to=9007199254740991"))).text).toBe("{\"messages\":[]}")
})

test("R3: to - from of 201, from equal to to, from above to, a missing from or to, 17 digits and a negative number get 400", async () => {
  const { r3 } = routes()
  for (const query of [
    "?from=0&to=201",
    "?from=5&to=5",
    "?from=6&to=5",
    "?from=0",
    "?to=5",
    "",
    "?from=&to=5",
    "?from=0&to=10000000000000000",
    "?from=00000000000000001&to=5",
    "?from=-1&to=5",
    "?from=0&to=-5",
    "?from=1.0&to=5",
    "?from=+1&to=5",
    "?from=9007199254740992&to=9007199254740993"
  ]) {
    const answer = await call(get(r3, A120, query))
    expect([query, answer.status]).toEqual([query, 400])
  }
  expect(ids(JSON.parse((await call(get(r3, A120, "?from=0&to=200"))).text).messages).length).toBe(120)
})


test("R3 with large messages closes before the message that would pass pageBytes; one message at its largest fits", async () => {
  const reads = await readsOf(TENANT_A, LARGE)
  const all = await Effect.runPromise(reads.messages(0, 4))
  const json = all.map((message) => JSON.stringify(messageJson(message)))
  const two = utf8("{\"messages\":[" + json[0] + "," + json[1] + "]}")
  for (const [room, want] of [[two, [0, 1]], [two - 1, [0]], [two + utf8(json[2] as string), [0, 1]], [two + utf8(json[2] as string) + 1, [0, 1, 2]]] as const) {
    const { r3 } = routes({ pageBytes: room })
    const answer = await call(get(r3, LARGE, "?from=0&to=3"))
    expect(answer.status).toBe(200)
    expect(utf8(answer.text)).toBeLessThanOrEqual(room)
    expect(ids(JSON.parse(answer.text).messages)).toEqual([...want])
  }
  // The largest message: 180,000 bytes of its text alone, and it fits in
  // `entry`, the least `pageBytes` that the relations allow.
  const largest = utf8(json[3] as string)
  expect(largest).toBeGreaterThan(180_000)
  expect(largest).toBeLessThanOrEqual(DEFAULTS.entry)
  const { r3 } = routes({ pageBytes: DEFAULTS.entry })
  const answer = JSON.parse((await call(get(r3, LARGE, "?from=3&to=4"))).text)
  expect(ids(answer.messages)).toEqual([3])
  expect(answer.messages[0].text).toBe("\u0001".repeat(30_000))
  // Exactly its own bytes: it is given whole.
  const exact = await Effect.runPromise(cutMessages(reads, 3, 4, utf8("{\"messages\":[" + json[3] + "]}")))
  expect(ids(JSON.parse(exact).messages)).toEqual([3])
})

// The places of reads
// -------------------

test("each handler holds no place of reads while its answer is written: with every place taken after the work, the answer's body is still read whole", async () => {
  const places = makeReads(limitsOf({ reads: 1, readsWait: 1_000 }))
  const { r2, r3 } = routes({ reads: 1, readsWait: 1_000 }, places)
  await run(Effect.gen(function*() {
    for (const effect of [get(r2, A120), get(r3, A120, "?from=0&to=10")]) {
      const response = yield* effect
      expect(places.taken()).toBe(0)
      const latch = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(places.withPlace(Deferred.await(latch)))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      expect(places.taken()).toBe(1)
      const answer = yield* Effect.promise(() => seen(response))
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.text).messages.length).toBeGreaterThan(0)
      yield* Deferred.succeed(latch, undefined)
      yield* Fiber.join(holder)
      expect(places.taken()).toBe(0)
    }
  }))
})

test("with the places full, R2 and R3 wait for a place and get 503 busy with retry-after 1 at readsWait", async () => {
  const places = makeReads(limitsOf({ reads: 1, readsWait: 1_000 }))
  const { r2, r3 } = routes({ reads: 1, readsWait: 1_000 }, places)
  await run(Effect.gen(function*() {
    const latch = yield* Deferred.make<void>()
    const holder = yield* Effect.forkChild(places.withPlace(Deferred.await(latch)))
    yield* Effect.repeat(Effect.yieldNow, { times: 20 })
    for (const effect of [get(r2, A120), get(r3, A120, "?from=0&to=10")]) {
      const fiber = yield* Effect.forkChild(effect)
      for (let k = 0; k < 1_000 && places.waiting() === 0; k++) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
      expect(places.waiting()).toBe(1)
      yield* TestClock.adjust(999)
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const answer = yield* Effect.flatMap(Fiber.join(fiber), (response) => Effect.promise(() => seen(response)))
      expect(answer.status).toBe(503)
      expect(answer.headers["retry-after"]).toBe("1")
      expect(answer.text).toBe(errorText("busy"))
      expect(places.waiting()).toBe(0)
    }
    yield* Deferred.succeed(latch, undefined)
    yield* Fiber.join(holder)
    // A free place: the read runs.
    expect((yield* get(r2, A120)).status).toBe(200)
  }))
})

test("a fault of the store in the handler's read gets 500 internal, and the place goes back", async () => {
  // A `Chats` whose chat's reads fail with a typed fault of the store.
  const fault = new StoreError({ op: "messages", cause: new Error("the disk failed") })
  const failing: typeof Chats.Service = {
    ...chats,
    reads: (tenant, chat) =>
      Effect.map(chats.reads(tenant, chat), (reads): Reading => ({
        ...reads,
        snapshot: () => Effect.fail(fault),
        messages: () => Effect.fail(fault)
      }))
  }
  const limits = limitsOf()
  const gate = makeGate({ secret: SECRET, origins: [], limits, chats: failing })
  const places = makeReads(limits)
  for (const [route, query] of [[snapshotRoute(gate, places, limits), ""], [messagesRoute(gate, places, limits), "?from=0&to=5"]] as const) {
    const answer = await call(get(route, A120, query))
    expect(answer.status).toBe(500)
    expect(answer.text).toBe(errorText("internal"))
  }
  expect(places.taken()).toBe(0)
})

// The two tenants
// ---------------

test("with a token of tenant A, R2 and R3 for B's chat, named in the token's chats or not, get 404 no_chat, and no byte of B's messages is in any answer", async () => {
  const { r2, r3 } = routes()
  const answers = [
    await call(get(r2, B1)),
    await call(get(r2, B1, "?last=200")),
    await call(get(r3, B1, "?from=0&to=2")),
    await call(get(r2, B1, "", NOT_B)),
    await call(get(r3, B1, "?from=0&to=2", NOT_B))
  ]
  for (const answer of answers) {
    expect(answer.status).toBe(404)
    expect(answer.text).toBe(errorText("no_chat"))
    expect(answer.text).not.toContain("B-SECRET")
  }
  // B's own reads hold them: the test's marks are real.
  const own = await Effect.runPromise((await readsOf(TENANT_B, B1)).messages(0, 2))
  expect(own.map((message) => message.text)).toEqual(["B-SECRET-ONE", "B-SECRET-TWO"])
})
