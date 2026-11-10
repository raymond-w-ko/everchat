// Tests of the store: the launch that owns the file, the log, the tree, the
// views, and what a failed write leaves behind.

import { expect, test } from "bun:test"
import { Effect, Exit, Option, Schema } from "effect"
import { newFile, options, PICK, rows, withStore, write } from "../tests/help.ts"
import * as Database from "./database.ts"
import { LaunchLive, type Part, ProcessAlive, Store, StoreError } from "./store.ts"

const launches = (file: string) =>
  rows<{ id: number; pid: number; ended: number | null; why: string | null }>(
    file,
    "select id, pid, ended is not null as ended, why from launch order by id"
  )

// Leaves a launch open in the file, as a crash does.
const crash = async (file: string, pid: number, host = "test-host") => {
  await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer(file))))
  write(file, "insert into launch (pid, host, cwd, version, run_tag, created) values (?, ?, '/work', '0', 'old', 1)", [
    pid,
    host
  ])
}

// The launch
// ----------

test("the first launch makes the chat's row, and the next launch keeps it", async () => {
  const file = newFile()
  const first = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    return { launch: store.launch, chat: yield* store.chat }
  }))
  expect(first.launch.id).toBe(1)
  expect(first.chat.pick).toEqual(PICK)
  expect(first.chat.uuid).toMatch(/^[0-9a-f-]{36}$/)
  expect(first.chat).toMatchObject({ goal: null, draft: null, taken: -1 })

  const other = { vendor: "anthropic", model: "other", effort: "low", speed: "slow" }
  const second = await withStore(
    file,
    Effect.gen(function*() {
      const store = yield* Store
      return { launch: store.launch, chat: yield* store.chat }
    }),
    { ...options(), pick: other }
  )
  expect(second.launch.id).toBe(2)
  // The pick of a new chat is used once. The chat's id never changes.
  expect(second.chat.pick).toEqual(PICK)
  expect(second.chat.uuid).toBe(first.chat.uuid)
  expect(launches(file)).toEqual([
    { id: 1, pid: process.pid, ended: 1, why: "exit" },
    { id: 2, pid: process.pid, ended: 1, why: "exit" }
  ])
})

test("a launch records its pick from the command line", async () => {
  const file = newFile()
  const pick = { vendor: "openai", model: "big", effort: "high", speed: "fast" }
  const launch = await withStore(file, Store.useSync((store) => store.launch), options({ pick }))
  expect(launch.pick).toEqual(pick)
  expect(rows(file, "select p.model from launch l join pick p on p.id = l.pick")).toEqual([{ model: "big" }])
})

test("a launch that fails ends with why = error, and one that is interrupted with why = signal", async () => {
  const file = newFile()
  const layer = Store.layer(file, options())
  const failed = await Effect.runPromiseExit(Effect.fail("boom").pipe(Effect.provide(layer)))
  expect(Exit.isFailure(failed)).toBe(true)
  const interrupted = await Effect.runPromiseExit(Effect.interrupt.pipe(Effect.provide(layer)))
  expect(Exit.isFailure(interrupted)).toBe(true)
  expect(launches(file).map((launch) => launch.why)).toEqual(["error", "signal"])
})

test("a start closes the launch that a crash left open", async () => {
  const file = newFile()
  await crash(file, 4242)
  expect(launches(file)).toEqual([{ id: 1, pid: 4242, ended: 0, why: null }])
  const launch = await withStore(file, Store.useSync((store) => store.launch), options(), () => false)
  expect(launch.id).toBe(2)
  expect(launches(file)).toEqual([
    { id: 1, pid: 4242, ended: 1, why: "crash" },
    { id: 2, pid: process.pid, ended: 1, why: "exit" }
  ])
})

test("a start stops when another process of this host has the file, and writes nothing", async () => {
  const file = newFile()
  await crash(file, 4242)
  const error = await Effect.runPromise(
    Effect.flip(Effect.void.pipe(Effect.provide(Store.layer(file, options())))).pipe(
      Effect.provideService(ProcessAlive, (pid) => pid === 4242)
    )
  )
  expect(error).toBeInstanceOf(LaunchLive)
  expect(error).toMatchObject({ pid: 4242, host: "test-host" })
  expect(launches(file)).toEqual([{ id: 1, pid: 4242, ended: 0, why: null }])
})

test("an open launch with our own pid, or of another host, is a crash", async () => {
  const start = (file: string) => withStore(file, Store.useSync((store) => store.launch.id), options(), () => true)

  const reused = newFile()
  await crash(reused, process.pid)
  expect(await start(reused)).toBe(2)
  expect(launches(reused)[0]).toMatchObject({ why: "crash" })

  const moved = newFile()
  await crash(moved, 4242, "another-host")
  expect(await start(moved)).toBe(2)
  expect(launches(moved)[0]).toMatchObject({ why: "crash" })
})

// The chat's row
// --------------

test("the chat's row keeps the pick, the goal, the draft, and the last message taken", async () => {
  const file = newFile()
  const pick = { vendor: "anthropic", model: "claude-test", effort: "high", speed: "slow" }
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.setPick(pick)
    yield* store.setGoal("ship it \ud800")
    yield* store.setDraft("half a sent")
    yield* store.setTaken(7)
  }))
  const chat = await withStore(file, Store.use((store) => store.chat))
  expect(chat).toMatchObject({ pick, goal: "ship it �", draft: "half a sent", taken: 7 })
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.setGoal(null)
    yield* store.setDraft(null)
  }))
  expect(rows(file, "select goal, draft from chat")).toEqual([{ goal: null, draft: null }])
  expect(rows(file, "select count(*) as n from pick")).toEqual([{ n: 2 }])
})

// The log
// -------

test("append gives ids 0, 1, 2 with no gap, and returns what it wrote", async () => {
  const file = newFile()
  const result = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const a = yield* store.append([{ kind: "user", text: "héllo" }])
    const b = yield* store.append([
      { kind: "asst", text: "page one", more: true, line: "a summary" },
      { kind: "asst", text: "page two" },
      { kind: "note", text: "" }
    ])
    return { a, b, count: yield* store.count, read: yield* store.messages(0, 10), some: yield* store.messages(1, 3) }
  }))
  expect(result.count).toBe(4)
  expect(result.read).toEqual([...result.a, ...result.b])
  expect(result.read.map((m) => [m.i, m.kind, m.text, m.size, m.more, m.line])).toEqual([
    [0, "user", "héllo", 6, false, null],
    [1, "asst", "page one", 8, true, "a summary"],
    [2, "asst", "page two", 8, false, null],
    [3, "note", "", 0, false, null]
  ])
  expect(result.some.map((m) => m.i)).toEqual([1, 2])
  expect(result.read.every((m) => m.launch === 1 && m.turn === null && m.call === null)).toBe(true)
})

test("the text on disk is the text that append returns: well formed, with its size in bytes", async () => {
  const file = newFile()
  const lone = "a\ud83db" // a lone surrogate between two letters
  const written = await withStore(file, Store.use((store) => store.append([{ kind: "user", text: lone, line: lone }])))
  expect(written[0]).toMatchObject({ text: "a�b", size: 5, line: "a�b" })
  expect(rows(file, "select text, size, length(cast(text as blob)) as bytes, line from msg")).toEqual([
    { text: "a�b", size: 5, bytes: 5, line: "a�b" }
  ])
})

test("an append that fails writes none of its messages", async () => {
  const file = newFile()
  const result = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append([{ kind: "user", text: "kept" }])
    const error = yield* Effect.flip(store.append([
      { kind: "user", text: "page one", more: true },
      { kind: "user", text: "page two", images: [99] } // no such image
    ]))
    return { error, count: yield* store.count, next: yield* store.append([{ kind: "asst", text: "after" }]) }
  }))
  expect(result.error).toBeInstanceOf(StoreError)
  expect(result.error.op).toBe("append")
  expect(result.count).toBe(1)
  expect(result.next[0]?.i).toBe(1)
  expect(rows(file, "select i, text from msg order by i")).toEqual([{ i: 0, text: "kept" }, { i: 1, text: "after" }])
})

// The tree and the views
// ----------------------

test("a node is written once, and read back as written", async () => {
  const file = newFile()
  const result = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const written = yield* store.putNodes([
      { l: 0, i: 0, text: "user: hi" },
      { l: 0, i: 1, text: "asst: hello \ud800" },
      { l: 1, i: 0, text: "greetings" }
    ])
    const again = yield* Effect.flip(store.putNodes([{ l: 2, i: 0, text: "new" }, { l: 0, i: 1, text: "other" }]))
    return {
      written,
      again,
      one: yield* store.node(0, 1),
      none: yield* store.node(2, 0),
      some: yield* store.nodes([[1, 0], [0, 0], [5, 5]])
    }
  }))
  expect(result.written.map((n) => [n.l, n.i, n.text, n.size])).toEqual([
    [0, 0, "user: hi", 8],
    [0, 1, "asst: hello �", 15],
    [1, 0, "greetings", 9]
  ])
  expect(result.again).toBeInstanceOf(StoreError)
  expect(Option.getOrUndefined(result.one)).toEqual(result.written[1])
  // The failed write took its first node back too.
  expect(Option.isNone(result.none)).toBe(true)
  expect(result.some.map((n) => [n.l, n.i]).sort()).toEqual([[0, 0], [1, 0]])
  expect(rows(file, "select count(*) as n from node")).toEqual([{ n: 3 }])
})

test("nodes reads more parts than one statement can take", async () => {
  const many = 12_000
  const found = await withStore(newFile(), Effect.gen(function*() {
    const store = yield* Store
    yield* store.putNodes(Array.from({ length: many }, (_, i) => ({ l: 0, i, text: `n${i}` })))
    return yield* store.nodes(Array.from({ length: many + 5 }, (_, i): Part => [0, i]))
  }))
  expect(found.length).toBe(many)
  expect(new Set(found.map((n) => n.i)).size).toBe(many)
})

test("a view comes back part for part, and a second write replaces it", async () => {
  const file = newFile()
  const parts: Array<Part> = [[3, 0], [2, 2], [0, 12], [0, 13]]
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    expect(Option.isNone(yield* store.view("chat"))).toBe(true)
    yield* store.putView({ name: "chat", parts: [[0, 0]], batch: false })
    yield* store.putView({ name: "chat", parts, batch: true })
    yield* store.putView({ name: "seen", parts: [], batch: false })
  }))
  const views = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    return [yield* store.view("chat"), yield* store.view("seen")].map(Option.getOrUndefined)
  }))
  expect(views).toEqual([{ name: "chat", parts, batch: true }, { name: "seen", parts: [], batch: false }])
  expect(rows(file, "select name, parts from view order by name")).toEqual([
    { name: "chat", parts: "[[3,0],[2,2],[0,12],[0,13]]" },
    { name: "seen", parts: "[]" }
  ])
})

// One event, one transaction
// --------------------------

class Stop extends Schema.TaggedError<Stop>()("Stop", {}) {}

test("a transaction that fails takes back every write, and gives the caller its own error", async () => {
  const file = newFile()
  const result = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append([{ kind: "user", text: "before" }])
    const error = yield* Effect.flip(store.transaction(Effect.gen(function*() {
      yield* store.append([{ kind: "user", text: "lost" }])
      yield* store.putNodes([{ l: 0, i: 1, text: "user: lost" }])
      yield* store.putView({ name: "chat", parts: [[0, 1]], batch: false })
      yield* store.setTaken(1)
      return yield* new Stop()
    })))
    const done = yield* store.transaction(Effect.gen(function*() {
      const [message] = yield* store.append([{ kind: "user", text: "kept" }])
      yield* store.putNodes([{ l: 0, i: message!.i, text: "user: kept" }])
      return message!.i
    }))
    return { error, done, chat: yield* store.chat, view: yield* store.view("chat") }
  }))
  expect(result.error).toBeInstanceOf(Stop)
  expect(result.done).toBe(1)
  expect(result.chat.taken).toBe(-1)
  expect(Option.isNone(result.view)).toBe(true)
  expect(rows(file, "select i, text from msg order by i")).toEqual([{ i: 0, text: "before" }, { i: 1, text: "kept" }])
  expect(rows(file, "select l, i, text from node")).toEqual([{ l: 0, i: 1, text: "user: kept" }])
})

test("a store error inside a transaction takes back the writes before it", async () => {
  const file = newFile()
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.putNodes([{ l: 0, i: 0, text: "first" }])
    const error = yield* Effect.flip(store.transaction(Effect.gen(function*() {
      yield* store.append([{ kind: "user", text: "lost" }])
      yield* store.putNodes([{ l: 0, i: 0, text: "second write" }])
    })))
    expect(error).toBeInstanceOf(StoreError)
    expect(yield* store.count).toBe(0)
  }))
})

// Images, heads, usage
// --------------------

test("an image is stored once by name, with its original only when one is given", async () => {
  const file = newFile()
  const png = new Uint8Array([1, 2, 3])
  const big = new Uint8Array(100_000).fill(7)
  const result = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const sent = { name: "aa.png", type: "image/png", width: 2, height: 1, source: "person" as const, bytes: png }
    const a = yield* store.putImage(sent)
    const again = yield* store.putImage({ ...sent, bytes: new Uint8Array([9]) })
    const b = yield* store.putImage({
      name: "bb.jpg",
      type: "image/jpeg",
      width: 1568,
      height: 1000,
      source: "tool",
      bytes: png,
      original: { type: "image/png", width: 4000, height: 2551, bytes: big }
    })
    const [message] = yield* store.append([{ kind: "user", text: "look", images: [b, a] }])
    return { a, again, b, image: yield* store.image(a), none: yield* store.image(99), of: yield* store.imagesOf(message!.i) }
  }))
  expect(result.again).toBe(result.a)
  expect(result.of).toEqual([result.b, result.a])
  expect(Option.isNone(result.none)).toBe(true)
  const image = Option.getOrThrow(result.image)
  expect([image.name, image.type, image.width, image.height, image.source]).toEqual(["aa.png", "image/png", 2, 1, "person"])
  expect([...image.bytes]).toEqual([1, 2, 3])
  expect(rows(file, "select image, width, length(bytes) as n from image_original")).toEqual([
    { image: result.b, width: 4000, n: 100_000 }
  ])
})

test("a head is stored once, and found by its text", async () => {
  const result = await withStore(newFile(), Effect.gen(function*() {
    const store = yield* Store
    const a = yield* store.putHead(`{"system":"one"}`)
    const b = yield* store.putHead(`{"system":"two"}`)
    return { a, b, again: yield* store.putHead(`{"system":"one"}`), body: yield* store.head(b), none: yield* store.head(99) }
  }))
  expect(result.again).toBe(result.a)
  expect(result.b).not.toBe(result.a)
  expect(Option.getOrUndefined(result.body)).toBe(`{"system":"two"}`)
  expect(Option.isNone(result.none)).toBe(true)
})

test("a usage row points to its pick, and equal picks are one row", async () => {
  const file = newFile()
  const cheap = { vendor: "openai", model: "small", effort: "low", speed: "slow" }
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.putNodes([{ l: 0, i: 0, text: "a line" }])
    const usage = { served: "compaction" as const, pick: cheap, input: 100, cacheRead: 9000, cacheWrite: 50, output: 40 }
    yield* store.addUsage({ ...usage, node: [0, 0], request: "req_1" })
    yield* store.addUsage({ ...usage, node: [0, 1], micros: 1234 })
  }))
  expect(rows(file, "select count(*) as n from pick")).toEqual([{ n: 2 }])
  expect(rows(file, `
    select u.served, u.node_l, u.node_i, p.model, u.request, u.input, u.cache_read, u.cache_write, u.output, u.searches, u.micros
    from usage u join pick p on p.id = u.pick order by u.id`)).toEqual([
    { served: "compaction", node_l: 0, node_i: 0, model: "small", request: "req_1", input: 100, cache_read: 9000, cache_write: 50, output: 40, searches: 0, micros: null },
    { served: "compaction", node_l: 0, node_i: 1, model: "small", request: null, input: 100, cache_read: 9000, cache_write: 50, output: 40, searches: 0, micros: 1234 }
  ])
})

// A restart
// ---------

test("a restart finds the log, the tree and the views as they were, and the ids go on", async () => {
  const file = newFile()
  const parts: Array<Part> = [[1, 0], [0, 2]]
  const before = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const messages = yield* store.append([
      { kind: "user", text: "one" },
      { kind: "asst", text: "two" },
      { kind: "user", text: "three" }
    ])
    const nodes = yield* store.putNodes([
      { l: 0, i: 0, text: "user: one" },
      { l: 0, i: 1, text: "asst: two" },
      { l: 0, i: 2, text: "user: three" },
      { l: 1, i: 0, text: "a talk" }
    ])
    yield* store.putView({ name: "chat", parts, batch: false })
    return { messages, nodes }
  }))
  const after = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    return {
      messages: yield* store.messages(0, yield* store.count),
      nodes: yield* store.nodes([[0, 0], [0, 1], [0, 2], [1, 0]]),
      view: yield* store.view("chat"),
      next: yield* store.append([{ kind: "asst", text: "four" }])
    }
  }))
  expect(after.messages).toEqual(before.messages)
  expect(after.nodes).toEqual(before.nodes)
  expect(Option.getOrUndefined(after.view)?.parts).toEqual(parts)
  expect(after.next[0]).toMatchObject({ i: 3, launch: 2 })
})
