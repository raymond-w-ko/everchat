// Tests of the store: the launch that owns the file, the log, the tree, the
// views, and what a failed write leaves behind.

import { expect, test } from "bun:test"
import { Effect, Exit, Option, Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { newFile, options, PICK, rows, withStore, write } from "../tests/help.ts"
import { SqlClient } from "effect/sql"
import * as Database from "./database.ts"
import { migrations } from "./migrations.ts"
import { DatabaseVersion, LaunchLive, type Part, ProcessAlive, Reads, Store, StoreError } from "./store.ts"

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
    yield* store.addUsage({ ...usage, node: [0, 1], micros: 1234, expected: 9100 })
  }))
  expect(rows(file, "select count(*) as n from pick")).toEqual([{ n: 2 }])
  expect(rows(file, `
    select u.served, u.node_l, u.node_i, p.model, u.request, u.input, u.cache_read, u.cache_write, u.output, u.searches, u.micros, u.expected
    from usage u join pick p on p.id = u.pick order by u.id`)).toEqual([
    { served: "compaction", node_l: 0, node_i: 0, model: "small", request: "req_1", input: 100, cache_read: 9000, cache_write: 50, output: 40, searches: 0, micros: null, expected: null },
    { served: "compaction", node_l: 0, node_i: 1, model: "small", request: null, input: 100, cache_read: 9000, cache_write: 50, output: 40, searches: 0, micros: 1234, expected: 9100 }
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

// The reads, for a process that does not own the file
// ---------------------------------------------------

// Runs `effect` with the store's reads over `file`, as a second process does.
const withReads = <A, E>(file: string, effect: Effect.Effect<A, E, Reads>) => Effect.runPromise(effect.pipe(Effect.provide(Reads.layer(file))))

// The error that the reads over `file` fail to start with.
const noReads = (file: string) => Effect.runPromise(Effect.flip(Reads.use((reads) => reads.count).pipe(Effect.provide(Reads.layer(file)))))

test("the reads take no launch, also while a launch has the file, and they see what it wrote", async () => {
  const file = newFile()
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append([{ kind: "user", text: "one" }])
    const seen = yield* Effect.promise(() => withReads(file, Effect.gen(function*() {
      const reads = yield* Reads
      return { count: yield* reads.count, texts: (yield* reads.messages(0, 9)).map((message) => message.text), pick: (yield* reads.chat).pick, launches: yield* reads.launches(9) }
    })))
    expect(seen.count).toBe(1)
    expect(seen.texts).toEqual(["one"])
    expect(seen.pick).toEqual(PICK)
    // The one launch is the store's, and it still runs.
    expect(seen.launches.map((one) => [one.id, one.pid, one.ended, one.why])).toEqual([[1, process.pid, null, null]])
    // The launch writes on, with the reads' connection closed or open.
    yield* store.append([{ kind: "user", text: "two" }])
  }))
  expect(launches(file)).toEqual([{ id: 1, pid: process.pid, ended: 1, why: "exit" }])
  // With no launch at all, the reads still work, and they leave the launches as they are.
  expect(await withReads(file, Reads.use((reads) => reads.count))).toBe(2)
  expect(launches(file)).toEqual([{ id: 1, pid: process.pid, ended: 1, why: "exit" }])
})

test("the reads do not make a file that is not there", async () => {
  const file = newFile()
  const failed = await noReads(file)
  expect(failed).toBeInstanceOf(StoreError)
  expect(failed._tag === "StoreError" ? failed.op : null).toBe("open")
  expect(fs.readdirSync(path.dirname(file))).toEqual([])
})

test("the reads refuse a database of another version of the program", async () => {
  const file = newFile()
  await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer(file, { "0001_schema": migrations["0001_schema"] }))))
  const older = await noReads(file)
  expect(older).toBeInstanceOf(DatabaseVersion)
  expect(older._tag === "DatabaseVersion" ? [older.have, older.want] : null).toEqual([1, Object.keys(migrations).length])
  // A database that ran a migration that this program does not know.
  const newer = newFile()
  await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer(newer, { ...migrations, "0099_later": Effect.void }))))
  const failed = await noReads(newer)
  expect(failed._tag === "DatabaseVersion" ? failed.have : null).toBe(Object.keys(migrations).length + 1)
})

test("the reads' connection cannot write", async () => {
  const file = newFile()
  await withStore(file, Store.use((store) => store.append([{ kind: "user", text: "one" }])))
  const failed = await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      return yield* Effect.flip(sql`insert into msg (i, kind, text, size, launch, created) values (1, 1, 'two', 3, 1, 1)`)
    }).pipe(Effect.provide(Database.readonly(file)))
  )
  expect(String(failed.reason.cause)).toContain("readonly database")
  expect(rows(file, "select count(*) as n from msg")).toEqual([{ n: 1 }])
})

test("a snapshot is one state of the database: a write of the launch shows only after it", async () => {
  const file = newFile()
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append([{ kind: "user", text: "one" }])
    const seen = yield* Effect.promise(() => withReads(file, Effect.gen(function*() {
      const reads = yield* Reads
      const first = yield* reads.version
      const still = yield* reads.version
      const inside = yield* reads.snapshot(Effect.gen(function*() {
        const before = yield* reads.count
        // The launch writes while the snapshot is open: the reader does not block it.
        yield* Effect.promise(() => Effect.runPromise(store.append([{ kind: "user", text: "two" }])))
        return [before, yield* reads.count, (yield* reads.messages(0, 9)).length]
      }))
      return { first, still, inside, after: yield* reads.count, later: yield* reads.version }
    })))
    expect(seen.inside).toEqual([1, 1, 1])
    expect(seen.after).toBe(2)
    // The version changes with a write of another connection, and only then.
    expect(seen.still).toBe(seen.first)
    expect(seen.later).not.toBe(seen.first)
  }))
})

test("the tree by level, the turns, the calls, the usage and the launches are read as they were written", async () => {
  const file = newFile()
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append(Array.from({ length: 5 }, (_, k) => ({ kind: "user" as const, text: "m" + k })))
    yield* store.putNodes([{ l: 0, i: 0, text: "a" }, { l: 0, i: 1, text: "b" }, { l: 0, i: 3, text: "d" }, { l: 1, i: 0, text: "ab" }, { l: 2, i: 0, text: "abcd" }])
    const first = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    expect([first.ended, first.why]).toEqual([null, null])
    const program = yield* store.startCall({ turn: first.id, vendorId: "call_1", fn: "run", input: "return 1" })
    const inner = yield* store.startCall({ turn: first.id, parent: program, fn: "shell", input: "[\"ls\"]" })
    yield* store.endCall(inner, { status: "done", output: "a\nb" })
    yield* store.endCall(program, { status: "done", output: "a long result", shown: 6 })
    yield* store.addTurnItem(first.id, "user", "{}")
    yield* store.endTurn(first.id, "failed", "it broke")
    const second = yield* store.startTurn({ pick: { ...PICK, model: "other" }, head: "{}", firstMsg: 3 })
    yield* store.addUsage({ served: "turn", turn: first.id, pick: PICK, request: "req_1", input: 10, cacheRead: 20, cacheWrite: 30, output: 4, expected: 25 })
    yield* store.addUsage({ served: "turn", turn: second.id, pick: PICK, input: 1, cacheRead: 2, cacheWrite: 3, output: 4 })
    yield* store.addUsage({ served: "compaction", node: [1, 0], pick: PICK, input: 100, cacheRead: 0, cacheWrite: 0, output: 9, micros: 7 })
    // Two more nodes that share a level or a number with that one.
    yield* store.addUsage({ served: "compaction", node: [1, 5], pick: PICK, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
    yield* store.addUsage({ served: "compaction", node: [2, 0], pick: PICK, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
  }))
  await withReads(file, Effect.gen(function*() {
    const reads = yield* Reads
    expect(yield* reads.levels).toEqual([{ l: 0, built: 3 }, { l: 1, built: 1 }, { l: 2, built: 1 }])
    expect((yield* reads.nodesIn(0, 0, 4)).map((node) => [node.i, node.text])).toEqual([[0, "a"], [1, "b"], [3, "d"]])
    expect((yield* reads.nodesIn(0, 1, 3)).map((node) => node.i)).toEqual([1])
    expect(yield* reads.nodesIn(3, 0, 9)).toEqual([])
    // Turns, newest first.
    const turns = yield* reads.turns(null, 10)
    expect(turns.map((turn) => [turn.id, turn.status, turn.why, turn.ended !== null, turn.pick.model, turn.firstMsg])).toEqual([[2, "running", null, false, "other", 3], [1, "failed", "it broke", true, PICK.model, 0]])
    expect((yield* reads.turns(2, 10)).map((turn) => turn.id)).toEqual([1])
    expect((yield* reads.turns(null, 1)).map((turn) => turn.id)).toEqual([2])
    expect(Option.getOrNull(yield* reads.turn(1))?.why).toBe("it broke")
    expect(Option.isNone(yield* reads.turn(3))).toBe(true)
    expect((yield* reads.turnItems(1)).map((one) => [one.n, one.kind, one.body, one.created > 0])).toEqual([[0, "user", "{}", true]])
    // A call has its sizes and its times.
    const calls = yield* reads.calls(1)
    expect(calls.map((call) => [call.fn, call.status, call.size, call.shown, call.created > 0, call.ended !== null])).toEqual([["run", "done", 13, 6, true, true], ["shell", "done", 3, 3, true, true]])
    // The usage, newest first, and by turn or node.
    const usage = (yield* reads.usage()).slice(2)
    expect(usage.map((one) => [one.id, one.served, one.turn, one.node, one.input, one.cacheRead, one.cacheWrite, one.output, one.expected, one.micros, one.request])).toEqual([
      [3, "compaction", null, [1, 0], 100, 0, 0, 9, null, 7, null],
      [2, "turn", 2, null, 1, 2, 3, 4, null, null, null],
      [1, "turn", 1, null, 10, 20, 30, 4, 25, null, "req_1"]
    ])
    expect(usage[0]!.pick).toEqual(PICK)
    expect((yield* reads.usage({ turn: 1 })).map((one) => one.id)).toEqual([1])
    expect((yield* reads.usage({ node: [1, 0] })).map((one) => one.id)).toEqual([3])
    expect((yield* reads.usage()).map((one) => one.id)).toEqual([5, 4, 3, 2, 1])
    expect((yield* reads.usage({ node: [0, 1] })).length).toBe(0)
    expect((yield* reads.usage({ before: 3, limit: 1 })).map((one) => one.id)).toEqual([2])
    expect(yield* reads.usageTotals).toEqual([
      { served: "compaction", requests: 3, input: 102, cacheRead: 0, cacheWrite: 0, output: 11 },
      { served: "turn", requests: 2, input: 11, cacheRead: 22, cacheWrite: 33, output: 8 }
    ])
    expect((yield* reads.launches(5)).map((one) => [one.id, one.host, one.cwd, one.version, one.why])).toEqual([[1, "test-host", "/work", "0.0.0-test", "exit"]])
  }))
})
