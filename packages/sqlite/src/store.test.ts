// Tests of the store: the launch that owns the file, the log, the tree, the
// views, and what a failed write leaves behind.

import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Scheduler, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { newFile, options, PICK, rows, withChats, withStore, write } from "../tests/help.ts"
import { SqlClient } from "effect/sql"
import * as Database from "./database.ts"
import { VERSION } from "./schema.ts"
import { chatsLayer, chatsLayerNoDatabase, ProcessAlive, readsLayer, storeLayer, storeLayerNoDatabase } from "./sqlite.ts"
import { TestClock } from "effect/testing"
import {
  ANSWER_MAX,
  type Answered,
  Chats,
  DatabaseVersion,
  LaunchLive,
  type Message,
  type NewEvent,
  NoChat,
  type Part,
  Reads,
  type Reading,
  Store,
  StoreError,
  type Turn,
  type UnsettledWake,
  WAIT,
  WAKE_FAILURES,
  WAKE_TEXT_MAX,
  type Wake,
  type WakeOf,
  WHO_MAX
} from "@everchat/core/store"

const launches = (file: string) =>
  rows<{ id: number; pid: number; ended: number | null; why: string | null }>(
    file,
    "select n as id, pid, ended is not null as ended, why from everchat_launch order by n"
  )

// Leaves a launch open in the file, as a crash does: the file's chat with
// one launch, of the process `pid` of `host`, that did not end.
const crash = async (file: string, pid: number, host = "test-host") => {
  await withStore(file, Effect.void)
  write(file, "update everchat_launch set pid = ?, host = ?, run_tag = 'old', created = 1, ended = null, why = null", [pid, host])
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
  expect(rows(file, "select p.model from everchat_launch l join everchat_pick p on p.id = l.pick where l.chat = 1")).toEqual([{ model: "big" }])
})

test("a launch that fails ends with why = error, and one that is interrupted with why = signal", async () => {
  const file = newFile()
  const layer = storeLayer(file, options())
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
    Effect.flip(Effect.void.pipe(Effect.provide(storeLayer(file, options())))).pipe(
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

// The file's tenant and its chat
// -------------------------------

// The counts of the tenants and the chats in `file`, and their ids.
const owners = (file: string) => ({
  tenants: rows<{ id: string }>(file, "select hex(id) as id from everchat_tenant"),
  chats: rows<{ id: number; tenant: string; uuid: string }>(file, "select id, hex(tenant) as tenant, hex(uuid) as uuid from everchat_chat")
})

test("the first launch makes one tenant and one chat, and the second launch makes none", async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  const first = owners(file)
  expect([first.tenants.length, first.chats.length]).toEqual([1, 1])
  expect(first.chats[0]!.tenant).toBe(first.tenants[0]!.id)
  await withStore(file, Effect.void)
  expect(owners(file)).toEqual(first)
  expect(launches(file).map((launch) => launch.id)).toEqual([1, 2])
})

test("the chat's UUID is 16 bytes in the file, and the same UUID as text at the store's edge; the tenant's id is the 16 bytes of a UUIDv4", async () => {
  const file = newFile()
  const uuid = await withStore(file, Store.use((store) => Effect.map(store.chat, (chat) => chat.uuid)))
  expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(rows(file, "select typeof(uuid) as type, length(uuid) as size, lower(hex(uuid)) as hex from everchat_chat")).toEqual([
    { type: "blob", size: 16, hex: uuid.replaceAll("-", "") }
  ])
  const [tenant] = rows<{ type: string; size: number; hex: string }>(file, "select typeof(id) as type, length(id) as size, lower(hex(id)) as hex from everchat_tenant")
  expect([tenant!.type, tenant!.size]).toEqual(["blob", 16])
  // The version nibble of a UUIDv4, and its variant.
  expect(tenant!.hex).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/)
  expect(tenant!.hex).not.toBe(uuid.replaceAll("-", ""))
  // Read again by a later launch, and by the reads: the same text.
  expect(await withStore(file, Store.use((store) => Effect.map(store.chat, (chat) => chat.uuid)))).toBe(uuid)
  expect(await Effect.runPromise(Reads.use((reads) => Effect.map(reads.chat, (chat) => chat.uuid)).pipe(Effect.provide(readsLayer(file))))).toBe(uuid)
})

test("each table's first row of the chat has n 1 and the next 2; a message's i, a turn's item and a message's image start at 0", async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const a = yield* store.putImage({ name: "a.png", type: "image/png", width: 1, height: 1, source: "person", bytes: new Uint8Array([1]) })
    const b = yield* store.putImage({ name: "b.png", type: "image/png", width: 1, height: 1, source: "person", bytes: new Uint8Array([2]) })
    expect([a, b]).toEqual([1, 2])
    const messages = yield* store.append([{ kind: "user", text: "one", images: [a, b] }, { kind: "user", text: "two" }])
    expect(messages.map((message) => message.i)).toEqual([0, 1])
    expect([yield* store.putHead("{}"), yield* store.putHead("[]")]).toEqual([1, 2])
    const first = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const second = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 1 })
    expect([first.id, second.id]).toEqual([1, 2])
    expect([yield* store.addTurnItem(first.id, "user", "{}"), yield* store.addTurnItem(first.id, "turn", "{}")]).toEqual([0, 1])
    expect(yield* store.addTurnItem(second.id, "user", "{}")).toBe(0)
    const program = yield* store.startCall({ turn: first.id, vendorId: "call_1", fn: "run", input: "x" })
    expect([program, yield* store.startCall({ turn: first.id, parent: program, fn: "shell", input: "[]" })]).toEqual([1, 2])
    yield* store.addUsage({ served: "turn", turn: first.id, pick: PICK, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
    yield* store.addUsage({ served: "turn", turn: second.id, pick: PICK, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
    yield* store.addDiagnostics([{ level: "info", source: "test", text: "one", created: 1 }, { level: "info", source: "test", text: "two", created: 2 }])
  }))
  for (const table of ["everchat_launch", "everchat_head", "everchat_turn", "everchat_call", "everchat_image", "everchat_usage", "everchat_log"]) {
    expect([table, rows<{ n: number }>(file, `select n from ${table} where chat = 1 order by n`).map((row) => row.n)]).toEqual([table, [1, 2]])
  }
  expect(rows(file, "select turn, n from everchat_turn_item where chat = 1 order by turn, n")).toEqual([{ turn: 1, n: 0 }, { turn: 1, n: 1 }, { turn: 2, n: 0 }])
  expect(rows(file, "select msg, n from everchat_msg_image where chat = 1 order by n")).toEqual([{ msg: 0, n: 0 }, { msg: 0, n: 1 }])
  expect(rows(file, "select i from everchat_msg where chat = 1 order by i")).toEqual([{ i: 0 }, { i: 1 }])
})

// The store and its own connection: the `SqlClient` that it writes with.
const withConnection = <A, E>(file: string, effect: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(storeLayerNoDatabase(options()).pipe(Layer.provideMerge(Database.layer(file))))))

// The error's text of `statement` on `sql`, or "passed".
const refused = (sql: SqlClient.SqlClient, statement: string, params: ReadonlyArray<unknown> = []) =>
  Effect.map(Effect.result(sql.unsafe(statement, params)), (result) => (result._tag === "Success" ? "passed" : String(result.failure.reason.cause)))

test("through the store's own connection, a REPLACE of a message, a node and an event is refused, and so are a delete, a REPLACE and a move of the chat's row", async () => {
  const file = newFile()
  const errors = await withConnection(file, Effect.gen(function*() {
    const store = yield* Store
    const sql = yield* SqlClient.SqlClient
    yield* store.append([{ kind: "user", text: "kept" }])
    yield* store.putNodes([{ l: 0, i: 0, text: "user: kept" }])
    const [chat] = yield* sql<{ id: number; tenant: Uint8Array; uuid: Uint8Array; pick: number }>`select id, tenant, uuid, pick from everchat_chat`
    const { id, pick, tenant, uuid } = chat!
    // No statement of the store writes an event yet: one row, by hand. It
    // names no message, so that each REPLACE below meets only its own
    // table's trigger.
    yield* sql`insert into everchat_event (chat, n, type, created) values (${id}, 1, 'start', 1)`
    return {
      message: yield* refused(sql, "replace into everchat_msg (chat, i, kind, text, size, launch, created) values (?, 0, 1, 'other', 5, 1, 1)", [id]),
      message2: yield* refused(sql, "insert or replace into everchat_msg (chat, i, kind, text, size, launch, created) values (?, 0, 1, 'other', 5, 1, 1)", [id]),
      node: yield* refused(sql, "insert or replace into everchat_node (chat, l, i, text, size, created) values (?, 0, 0, 'other', 5, 1)", [id]),
      event: yield* refused(sql, "replace into everchat_event (chat, n, type, created) values (?, 1, 'end', 1)", [id]),
      deleted: yield* refused(sql, "delete from everchat_chat where tenant = ? and id = ?", [tenant, id]),
      replaced: yield* refused(sql, "replace into everchat_chat (id, tenant, uuid, pick, created, updated) values (?, ?, ?, ?, 1, 1)", [id, tenant, uuid, pick]),
      moved: yield* refused(sql, "update everchat_chat set tenant = ? where tenant = ? and id = ?", [new Uint8Array(16), tenant, id]),
      chat: yield* store.chat,
      count: yield* store.count
    }
  }))
  expect(errors.message).toContain("everchat_msg is append only")
  expect(errors.message2).toContain("everchat_msg is append only")
  expect(errors.node).toContain("everchat_node is written once")
  expect(errors.event).toContain("everchat_event is append only")
  expect(errors.deleted).toContain("everchat_chat is deleted only with its tenant")
  expect(errors.replaced).toContain("everchat_chat is deleted only with its tenant")
  expect(errors.moved).toContain("everchat_chat keeps its id, its tenant and its uuid")
  expect([errors.count, errors.chat.pick]).toEqual([1, PICK])
  expect(rows(file, "select i, text from everchat_msg")).toEqual([{ i: 0, text: "kept" }])
  expect(rows(file, "select text from everchat_node")).toEqual([{ text: "user: kept" }])
  expect(rows(file, "select type from everchat_event")).toEqual([{ type: "start" }])
  expect(rows(file, "select count(*) as n from everchat_chat")).toEqual([{ n: 1 }])
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
  expect(rows(file, "select goal, draft from everchat_chat")).toEqual([{ goal: null, draft: null }])
  expect(rows(file, "select count(*) as n from everchat_pick")).toEqual([{ n: 2 }])
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
  expect(rows(file, "select text, size, length(cast(text as blob)) as bytes, line from everchat_msg")).toEqual([
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
  expect(rows(file, "select i, text from everchat_msg order by i")).toEqual([{ i: 0, text: "kept" }, { i: 1, text: "after" }])
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
  expect(rows(file, "select count(*) as n from everchat_node")).toEqual([{ n: 3 }])
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
  expect(rows(file, "select name, parts from everchat_view order by name")).toEqual([
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
  expect(rows(file, "select i, text from everchat_msg order by i")).toEqual([{ i: 0, text: "before" }, { i: 1, text: "kept" }])
  expect(rows(file, "select l, i, text from everchat_node")).toEqual([{ l: 0, i: 1, text: "user: kept" }])
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

test("an image is stored once by name", async () => {
  const file = newFile()
  const png = new Uint8Array([1, 2, 3])
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
      bytes: png
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
  // A message's images, in their order.
  expect(rows(file, "select msg, n, image from everchat_msg_image order by n")).toEqual([{ msg: 0, n: 0, image: result.b }, { msg: 0, n: 1, image: result.a }])
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
  expect(rows(file, "select count(*) as n from everchat_pick")).toEqual([{ n: 2 }])
  expect(rows(file, `
    select u.served, u.node_l, u.node_i, p.model, u.request, u.input, u.cache_read, u.cache_write, u.output, u.searches, u.micros, u.expected
    from everchat_usage u join everchat_pick p on p.id = u.pick order by u.n`)).toEqual([
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
const withReads = <A, E>(file: string, effect: Effect.Effect<A, E, Reads>) => Effect.runPromise(effect.pipe(Effect.provide(readsLayer(file))))

// The error that the reads over `file` fail to start with.
const noReads = (file: string) => Effect.runPromise(Effect.flip(Reads.use((reads) => reads.count).pipe(Effect.provide(readsLayer(file)))))

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
  // A database with the mark of an older schema.
  await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer(file))))
  write(file, `pragma user_version = ${VERSION - 1}`)
  const older = await noReads(file)
  expect(older).toBeInstanceOf(DatabaseVersion)
  expect(older._tag === "DatabaseVersion" ? [older.have, older.want, older.file] : null).toEqual([VERSION - 1, VERSION, file])
  // A database with the mark of a schema that this program does not know.
  const newer = newFile()
  await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer(newer))))
  write(newer, `pragma user_version = ${VERSION + 1}`)
  const failed = await noReads(newer)
  expect(failed._tag === "DatabaseVersion" ? failed.have : null).toBe(VERSION + 1)
})

test("the reads' connection cannot write", async () => {
  const file = newFile()
  await withStore(file, Store.use((store) => store.append([{ kind: "user", text: "one" }])))
  const failed = await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      return yield* Effect.flip(sql`insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 1, 1, 'two', 3, 1, 1)`)
    }).pipe(Effect.provide(Database.readonly(file)))
  )
  expect(String(failed.reason.cause)).toContain("readonly database")
  expect(rows(file, "select count(*) as n from everchat_msg")).toEqual([{ n: 1 }])
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

// Approvals
// ---------

// A turn with a program and three of its functions (`send` twice and
// `read`), all running; a second program with one function. Gives their ids.
const calls = (store: typeof Store.Service) =>
  Effect.gen(function*() {
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const program = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "await send(1)" })
    const send = yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: "{\"to\":\"x\",\"text\":\"hi\"}" })
    const again = yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: "{\"to\":\"y\"}" })
    const read = yield* store.startCall({ turn: turn.id, parent: program, fn: "read", input: "{\"path\":\"a\"}" })
    const other = yield* store.startCall({ turn: turn.id, vendorId: "call_2", fn: "run", input: "await send(2)" })
    const late = yield* store.startCall({ turn: turn.id, parent: other, fn: "send", input: "{\"to\":\"z\"}" })
    return { turn: turn.id, program, send, again, read, other, late }
  })

const callRow = (file: string, n: number) =>
  rows(file, `select status, output, size, shown, ended is not null as ended from everchat_call where chat = 1 and n = ${n}`)

const approvalCount = (file: string) => rows<{ n: number }>(file, "select count(*) as n from everchat_approval")[0]!.n

test("pendCall: the approval's row takes the call's turn, function and input from the call's row; the call is pending, with its end and the text of output(n); the ids go 1, 2", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* calls(store)
    const given: Array<number> = []
    const first = yield* store.pendCall(ids.send, (n) => {
      given.push(n)
      return `send waits: approval ${n}`
    })
    const second = yield* store.pendCall(ids.late, (n) => `send waits: approval ${n}`)
    return { ids, first, second, given, approval: yield* store.approval(first), call: yield* store.call(ids.send) }
  }))
  expect([got.first, got.second, got.given]).toEqual([1, 2, [1]])
  const approval = Option.getOrThrow(got.approval)
  expect(approval).toEqual({
    id: 1,
    turn: got.ids.turn,
    call: got.ids.send,
    fn: "send",
    input: "{\"to\":\"x\",\"text\":\"hi\"}",
    status: "pending",
    who: null,
    answer: null,
    answered: null,
    output: null,
    ended: null,
    msg: null,
    created: approval.created,
    updated: approval.created
  })
  expect(approval.created).toBeGreaterThan(0)
  const call = Option.getOrThrow(got.call)
  expect([call.status, call.output, call.size, call.shown, call.ended]).toEqual(["pending", "send waits: approval 1", 22, 22, approval.created])
  // The other calls run on.
  expect(rows(file, "select n, status from everchat_call where chat = 1 order by n")).toEqual([
    { n: 1, status: "running" },
    { n: 2, status: "pending" },
    { n: 3, status: "running" },
    { n: 4, status: "running" },
    { n: 5, status: "running" },
    { n: 6, status: "pending" }
  ])
  expect(rows(file, "select n, call, fn, input from everchat_approval where chat = 1 order by n")).toEqual([
    { n: 1, call: 2, fn: "send", input: "{\"to\":\"x\",\"text\":\"hi\"}" },
    { n: 2, call: 6, fn: "send", input: "{\"to\":\"z\"}" }
  ])
})

test("pendCall: a call of a later turn gives its approval that turn, read from the call's row", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const first = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    yield* store.endTurn(first.id, "done")
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const program = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "await send(1)" })
    const send = yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: "{\"to\":\"x\"}" })
    const approval = yield* store.pendCall(send, (n) => `send waits: approval ${n}`)
    return { turns: [first.id, turn.id], send, approval: Option.getOrThrow(yield* store.approval(approval)) }
  }))
  expect(got.turns).toEqual([1, 2])
  expect([got.approval.turn, got.approval.call]).toEqual([2, got.send])
  expect(rows(file, "select turn, call from everchat_approval where chat = 1")).toEqual([{ turn: 2, call: got.send }])
})

test("pendCall: a call that is not running, a program, a call that waits already and a call that is not there are refused with StoreError, and nothing is written", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* calls(store)
    yield* store.endCall(ids.read, { status: "done", output: "a" })
    yield* store.pendCall(ids.send, (n) => `waits ${n}`)
    const tries = [ids.read, ids.program, ids.send, 99]
    const errors = []
    for (const id of tries) errors.push(yield* Effect.flip(store.pendCall(id, (n) => `again ${n}`)))
    return { ids, errors }
  }))
  for (const error of got.errors) {
    expect(error).toBeInstanceOf(StoreError)
    expect(error.op).toBe("pendCall")
  }
  expect(got.errors.map((error) => String(error.cause))).toEqual([
    `Error: the call ${got.ids.read} is done, not running`,
    `Error: the call ${got.ids.program} is a program, and only a function's call waits for an answer`,
    `Error: the call ${got.ids.send} is pending, not running`,
    "Error: the chat has no call 99"
  ])
  expect(approvalCount(file)).toBe(1)
  expect(callRow(file, got.ids.read)).toEqual([{ status: "done", output: "a", size: 1, shown: 1, ended: 1 }])
  expect(callRow(file, got.ids.program)).toEqual([{ status: "running", output: null, size: null, shown: null, ended: 0 }])
  expect(callRow(file, got.ids.send)).toEqual([{ status: "pending", output: "waits 1", size: 7, shown: 7, ended: 1 }])
})

test("pendCall: both or neither: in a transaction that fails, and with an output that throws, the call stays running and no approval is made; the next pendCall takes id 1", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* calls(store)
    const failed = yield* Effect.flip(store.transaction(Effect.andThen(store.pendCall(ids.send, (n) => `waits ${n}`), Effect.fail("no"))))
    const thrown = yield* Effect.exit(store.pendCall(ids.send, () => {
      throw new Error("no text")
    }))
    const after = { approvals: yield* store.approvals(), call: yield* store.call(ids.send) }
    const next = yield* store.pendCall(ids.send, (n) => `waits ${n}`)
    return { failed, thrown, after, next }
  }))
  expect(got.failed).toBe("no")
  expect(Exit.isFailure(got.thrown) && String(Cause.squash(got.thrown.cause))).toBe("Error: no text")
  expect(got.after.approvals).toEqual([])
  expect(Option.getOrThrow(got.after.call).status).toBe("running")
  expect(Option.getOrThrow(got.after.call).output).toBe(null)
  expect(got.next).toBe(1)
  expect(approvalCount(file)).toBe(1)
})

test("the approvals are read by id, by call, by state and by program, in the order of their ids, on the store and on the reads", async () => {
  const file = newFile()
  const ids = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* calls(store)
    yield* store.pendCall(ids.late, (n) => `waits ${n}`)
    yield* store.pendCall(ids.again, (n) => `waits ${n}`)
    yield* store.pendCall(ids.send, (n) => `waits ${n}`)
    return ids
  }))
  // The first approval is answered no, as the next bead's member will.
  write(file, "update everchat_approval set status = 'no', who = 'the person', answered = 9, updated = 9 where chat = 1 and n = 1")
  const read = (reads: Reading) =>
    Effect.gen(function*() {
      const id = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map((row) => row.id)
      return {
        one: Option.map(yield* reads.approval(1), (row) => [row.id, row.call, row.status, row.who, row.answered]),
        none: Option.isNone(yield* reads.approval(4)),
        byCall: yield* Effect.forEach([ids.send, ids.again, ids.late, ids.read, ids.program], (call) =>
          Effect.map(reads.approvalOf(call), (row) => Option.getOrNull(Option.map(row, (row) => row.id)))),
        all: id(yield* reads.approvals()),
        pending: id(yield* reads.approvals(["pending"])),
        no: id(yield* reads.approvals(["no"])),
        both: id(yield* reads.approvals(["no", "pending"])),
        nothing: id(yield* reads.approvals([])),
        done: id(yield* reads.approvals(["done"])),
        program: id(yield* reads.approvalsOf(ids.program)),
        other: id(yield* reads.approvalsOf(ids.other)),
        function: id(yield* reads.approvalsOf(ids.send))
      }
    })
  const fromStore = await withStore(file, Store.use(read))
  const fromReads = await withReads(file, Reads.use(read))
  expect(fromReads).toEqual(fromStore)
  expect(fromStore).toEqual({
    one: Option.some([1, ids.late, "no", "the person", 9]),
    none: true,
    byCall: [3, 2, 1, null, null],
    all: [1, 2, 3],
    pending: [2, 3],
    no: [1],
    both: [1, 2, 3],
    nothing: [],
    done: [],
    program: [2, 3],
    other: [1],
    function: []
  })
})

// The answer, the 7 days and the run
// ----------------------------------

// Runs `effect` with the store over `file`, on a test clock that the effect
// sets (`TestClock.setTime`): the store's members read their time from it.
const withClock = <A, E>(file: string, effect: Effect.Effect<A, E, Store | TestClock.TestClock>) =>
  withStore(file, effect.pipe(Effect.provide(TestClock.layer())))

// One program of a turn with `count` functions, all running. Gives their
// ids, in order.
const functions = (store: typeof Store.Service, count: number) =>
  Effect.gen(function*() {
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const program = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "await all()" })
    const ids: Array<number> = []
    for (let k = 1; k <= count; k++) ids.push(yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: `{"k":${k}}` }))
    return ids
  })

// The row of an answer, or null for `none`.
const rowOf = (answered: Answered) => (answered._tag === "none" ? null : answered.approval)

// The approval's row as the file has it.
const approvalRow = (file: string, n: number) =>
  rows(file, `select status, who, answer, answered, output, ended, msg, updated from everchat_approval where chat = 1 and n = ${n}`)[0]

test("answerApproval: a yes and a no are kept as given (who, answer, answered); a second answer gives closed and the row is as the first left it; a number that the chat has not gives none", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* functions(store, 2)
    yield* TestClock.setTime(1000)
    for (const id of ids) yield* store.pendCall(id, (n) => `waits ${n}`)
    yield* TestClock.setTime(5000)
    const yes = yield* store.answerApproval(1, { yes: true, who: "Zoë at the desk", text: "Go on ✓" })
    const no = yield* store.answerApproval(2, { yes: false, who: "Ada" })
    yield* TestClock.setTime(6000)
    const again = [
      yield* store.answerApproval(1, { yes: false, who: "Eve", text: "stop" }),
      yield* store.answerApproval(2, { yes: true, who: "Eve", text: null })
    ]
    const none = yield* store.answerApproval(3, { yes: true, who: "Eve" })
    return { yes, no, again, none, rows: yield* store.approvals() }
  }))
  expect(got.yes._tag).toBe("answered")
  expect(got.yes).toMatchObject({ approval: { id: 1, status: "yes", who: "Zoë at the desk", answer: "Go on ✓", answered: 5000, updated: 5000, created: 1000 } })
  expect(got.no).toMatchObject({ _tag: "answered", approval: { id: 2, status: "no", who: "Ada", answer: null, answered: 5000, updated: 5000 } })
  expect(got.again).toEqual([
    { _tag: "closed", approval: got.rows[0]! },
    { _tag: "closed", approval: got.rows[1]! }
  ])
  expect(got.rows).toEqual([rowOf(got.yes)!, rowOf(got.no)!])
  expect(got.none).toEqual({ _tag: "none" })
  expect(approvalRow(file, 1)).toEqual({ status: "yes", who: "Zoë at the desk", answer: "Go on ✓", answered: 5000, output: null, ended: null, msg: null, updated: 5000 })
  expect(approvalRow(file, 2)).toEqual({ status: "no", who: "Ada", answer: null, answered: 5000, output: null, ended: null, msg: null, updated: 5000 })
})

test("answerApproval: an answer at WAIT exactly is kept, and one 1 ms later gives expired: the row is expired at that time, with no who and no answer", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* functions(store, 2)
    yield* TestClock.setTime(1000)
    for (const id of ids) yield* store.pendCall(id, (n) => `waits ${n}`)
    yield* TestClock.setTime(1000 + WAIT)
    const kept = yield* store.answerApproval(1, { yes: true, who: "Ada", text: "in time" })
    yield* TestClock.setTime(1000 + WAIT + 1)
    const late = yield* store.answerApproval(2, { yes: true, who: "Ada", text: "too late" })
    const after = yield* store.answerApproval(2, { yes: true, who: "Ada", text: "again" })
    return { kept, late, after }
  }))
  expect(got.kept).toMatchObject({ _tag: "answered", approval: { id: 1, status: "yes", who: "Ada", answer: "in time", answered: 1000 + WAIT } })
  expect(got.late).toEqual({ _tag: "expired", approval: expect.objectContaining({ id: 2, status: "expired", who: null, answer: null, answered: 1000 + WAIT + 1 }) })
  expect(got.after).toEqual({ _tag: "closed", approval: rowOf(got.late)! })
  expect(approvalRow(file, 2)).toEqual({ status: "expired", who: null, answer: null, answered: 1000 + WAIT + 1, output: null, ended: null, msg: null, updated: 1000 + WAIT + 1 })
})

test("answerApproval: a who of 0 or 257 characters and a text of 4,097 are refused with StoreError and write nothing; a who of 256 and a text of 4,096 are kept", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* functions(store, 1)
    yield* store.pendCall(ids[0]!, (n) => `waits ${n}`)
    const refused = [
      yield* Effect.flip(store.answerApproval(1, { yes: true, who: "" })),
      yield* Effect.flip(store.answerApproval(1, { yes: true, who: "w".repeat(WHO_MAX + 1) })),
      yield* Effect.flip(store.answerApproval(1, { yes: false, who: "Ada", text: "t".repeat(ANSWER_MAX + 1) }))
    ]
    const before = yield* store.approval(1)
    const kept = yield* store.answerApproval(1, { yes: false, who: "w".repeat(WHO_MAX), text: "t".repeat(ANSWER_MAX) })
    return { refused, before, kept }
  }))
  expect(got.refused.map((error) => [error instanceof StoreError, error.op, String(error.cause)])).toEqual([
    [true, "answerApproval", "Error: who answers is a text of 1 to 256 characters, not 0"],
    [true, "answerApproval", "Error: who answers is a text of 1 to 256 characters, not 257"],
    [true, "answerApproval", "Error: an answer's text has at most 4096 characters, not 4097"]
  ])
  expect(Option.getOrThrow(got.before).status).toBe("pending")
  expect(got.kept).toMatchObject({ _tag: "answered", approval: { status: "no", who: "w".repeat(WHO_MAX), answer: "t".repeat(ANSWER_MAX) } })
})

test("expireApprovals: it takes only the pending rows that have waited more than WAIT, and gives them; a second call gives none", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* functions(store, 3)
    yield* TestClock.setTime(1000)
    yield* store.pendCall(ids[0]!, (n) => `waits ${n}`)
    yield* TestClock.setTime(2000)
    yield* store.pendCall(ids[1]!, (n) => `waits ${n}`)
    yield* store.pendCall(ids[2]!, (n) => `waits ${n}`)
    yield* store.answerApproval(3, { yes: true, who: "Ada" })
    const id = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map((row) => row.id)
    yield* TestClock.setTime(1000 + WAIT)
    const atWait = id(yield* store.expireApprovals())
    yield* TestClock.setTime(1000 + WAIT + 1)
    const first = yield* store.expireApprovals()
    const again = id(yield* store.expireApprovals())
    yield* TestClock.setTime(2000 + WAIT + 1)
    const second = yield* store.expireApprovals()
    const last = id(yield* store.expireApprovals())
    return { atWait, first, again, second, last, rows: yield* store.approvals() }
  }))
  expect(got.atWait).toEqual([])
  expect(got.first).toEqual([expect.objectContaining({ id: 1, status: "expired", who: null, answered: 1000 + WAIT + 1, updated: 1000 + WAIT + 1 })])
  expect(got.again).toEqual([])
  expect(got.second).toEqual([expect.objectContaining({ id: 2, status: "expired", who: null, answered: 2000 + WAIT + 1 })])
  expect(got.last).toEqual([])
  expect(got.rows.map((row) => [row.id, row.status])).toEqual([[1, "expired"], [2, "expired"], [3, "yes"]])
  expect(got.rows.slice(0, 2)).toEqual([...got.first, ...got.second])
})

test("the run: startApproval gives a yes row one time, and none for each other state; endApproval ends only a running row; cutApprovals takes only running rows", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* functions(store, 7)
    yield* TestClock.setTime(1000)
    yield* store.pendCall(ids[0]!, (n) => `waits ${n}`)
    yield* TestClock.setTime(1000 + WAIT)
    for (const id of ids.slice(1)) yield* store.pendCall(id, (n) => `waits ${n}`)
    yield* TestClock.setTime(1000 + WAIT + 1)
    // 1 expired, 2 no, 3 to 7 yes; 8 is no approval.
    yield* store.answerApproval(1, { yes: true, who: "Ada" })
    yield* store.answerApproval(2, { yes: false, who: "Ada" })
    for (const n of [3, 4, 5, 6, 7]) yield* store.answerApproval(n, { yes: true, who: "Ada" })
    const status = (row: Option.Option<{ readonly id: number; readonly status: string }>) => Option.getOrNull(Option.map(row, (row) => [row.id, row.status]))
    yield* TestClock.setTime(1000 + WAIT + 2)
    const started = yield* Effect.forEach([3, 3, 4, 5, 6], (n) => Effect.map(store.startApproval(n), status))
    const others = yield* Effect.forEach([1, 2, 8], (n) => Effect.map(store.startApproval(n), status))
    yield* TestClock.setTime(1000 + WAIT + 3)
    // 7 is yes and not running.
    const notRunning = yield* Effect.forEach([1, 2, 7, 8], (n) => Effect.map(store.endApproval(n, { status: "done", output: "no" }), status))
    const ended = [
      yield* store.endApproval(3, { status: "done", output: "sent ✓" }),
      yield* store.endApproval(4, { status: "failed", output: "the server said no" })
    ]
    const twice = yield* Effect.map(store.endApproval(3, { status: "failed", output: "again" }), status)
    const ranAgain = yield* Effect.map(store.startApproval(3), status)
    yield* TestClock.setTime(1000 + WAIT + 4)
    const cut = yield* store.cutApprovals("an earlier launch left the run")
    const cutAgain = yield* store.cutApprovals("again")
    return { started, others, notRunning, ended, twice, ranAgain, cut, cutAgain, rows: yield* store.approvals() }
  }))
  expect(got.started).toEqual([[3, "running"], null, [4, "running"], [5, "running"], [6, "running"]])
  expect(got.others).toEqual([null, null, null])
  expect(got.notRunning).toEqual([null, null, null, null])
  expect(got.ended.map((row) => Option.getOrThrow(row))).toEqual([
    expect.objectContaining({ id: 3, status: "done", output: "sent ✓", ended: 1000 + WAIT + 3, updated: 1000 + WAIT + 3, who: "Ada" }),
    expect.objectContaining({ id: 4, status: "failed", output: "the server said no", ended: 1000 + WAIT + 3 })
  ])
  expect([got.twice, got.ranAgain]).toEqual([null, null])
  expect(got.cut.map((row) => [row.id, row.status, row.output, row.ended])).toEqual([
    [5, "cut", "an earlier launch left the run", 1000 + WAIT + 4],
    [6, "cut", "an earlier launch left the run", 1000 + WAIT + 4]
  ])
  expect(got.cutAgain).toEqual([])
  expect(got.rows.map((row) => [row.id, row.status, row.output, row.ended])).toEqual([
    [1, "expired", null, null],
    [2, "no", null, null],
    [3, "done", "sent ✓", 1000 + WAIT + 3],
    [4, "failed", "the server said no", 1000 + WAIT + 3],
    [5, "cut", "an earlier launch left the run", 1000 + WAIT + 4],
    [6, "cut", "an earlier launch left the run", 1000 + WAIT + 4],
    [7, "yes", null, null]
  ])
})

test("tellApproval sets msg one time and refuses a pending, yes or running row; untoldApprovals lists by id and loses a row when it is told", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const ids = yield* functions(store, 8)
    yield* store.append([{ kind: "note", text: "one" }, { kind: "note", text: "two" }])
    yield* TestClock.setTime(1000)
    yield* store.pendCall(ids[4]!, (n) => `waits ${n}`) // 1: expired
    yield* TestClock.setTime(1000 + WAIT)
    for (const id of [...ids.slice(0, 4), ...ids.slice(5)]) yield* store.pendCall(id, (n) => `waits ${n}`)
    yield* TestClock.setTime(1000 + WAIT + 1)
    // 1 expired, 2 pending, 3 yes, 4 running, 5 no, 6 done, 7 failed, 8 cut.
    yield* store.answerApproval(1, { yes: true, who: "Ada" })
    for (const n of [3, 4, 6, 7, 8]) yield* store.answerApproval(n, { yes: true, who: "Ada" })
    yield* store.answerApproval(5, { yes: false, who: "Ada" })
    for (const n of [6, 7, 8]) yield* store.startApproval(n)
    yield* store.endApproval(6, { status: "done", output: "ok" })
    yield* store.endApproval(7, { status: "failed", output: "no" })
    yield* store.cutApprovals("cut")
    yield* store.startApproval(4)
    const id = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map((row) => row.id)
    const first = id(yield* store.untoldApprovals())
    const refused = yield* Effect.forEach([2, 3, 4, 9], (n) => Effect.flip(store.tellApproval(n, 0)))
    yield* TestClock.setTime(1000 + WAIT + 2)
    yield* store.tellApproval(6, 1)
    const afterOne = id(yield* store.untoldApprovals())
    const twice = yield* Effect.flip(store.tellApproval(6, 0))
    const noMessage = yield* Effect.flip(store.tellApproval(5, 99))
    for (const n of [1, 5, 7, 8]) yield* store.tellApproval(n, 0)
    const last = id(yield* store.untoldApprovals())
    return { first, refused, afterOne, twice, noMessage, last, rows: yield* store.approvals() }
  }))
  expect(got.first).toEqual([1, 5, 6, 7, 8])
  expect(got.refused.map((error) => [error instanceof StoreError, error.op, String(error.cause)])).toEqual([
    [true, "tellApproval", "Error: the approval 2 is pending, and has no end to tell"],
    [true, "tellApproval", "Error: the approval 3 is yes, and has no end to tell"],
    [true, "tellApproval", "Error: the approval 4 is running, and has no end to tell"],
    [true, "tellApproval", "Error: the chat has no approval 9"]
  ])
  expect(got.afterOne).toEqual([1, 5, 7, 8])
  expect([got.twice.op, String(got.twice.cause)]).toEqual(["tellApproval", "Error: the approval 6 was told already, at message 1"])
  expect(got.noMessage).toBeInstanceOf(StoreError)
  // The reference (chat, msg) refuses a message that the chat has not.
  expect(String((got.noMessage.cause as { readonly cause?: unknown }).cause)).toContain("ConstraintError")
  expect(got.last).toEqual([])
  expect(got.rows.map((row) => [row.id, row.status, row.msg])).toEqual([
    [1, "expired", 0],
    [2, "pending", null],
    [3, "yes", null],
    [4, "running", null],
    [5, "no", 0],
    [6, "done", 1],
    [7, "failed", 0],
    [8, "cut", 0]
  ])
  expect(approvalRow(file, 6)).toMatchObject({ msg: 1, updated: 1000 + WAIT + 2 })
})

// Wake-ups
// --------

// A wake-up's row as the file has it.
const wakeRow = (file: string, n: number) =>
  rows(file, `select chat, n, text, cron, at, zone, first, turn, call, due, slot, pending, missed, fired, last_turn, settled, failed, stopped, why, stop_call, created, updated from everchat_wake where chat = 1 and n = ${n}`)[0]

const wakeCount = (file: string) => rows<{ n: number }>(file, "select count(*) as n from everchat_wake")[0]!.n

// A routine and a reminder in Berlin, as the wake-ups' package gives them.
const ROUTINE = { text: "stand up", cron: "0 9 * * 1-5", zone: "Europe/Berlin", first: 1_800_000_000_000 }
const REMINDER = { text: "call back", at: 1_800_000_600_000, zone: "Europe/Berlin", first: 1_800_000_600_000 }

test("makeWake: a reminder and a routine that a function's call made are made with their whole rows: the ids 1 and 2, due = first, the clock's time, nothing fired; a new chat has its wake-ups on, a new turn no ceiling", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(5000)
    const reminder = yield* store.makeWake(REMINDER, 20)
    const [call] = yield* functions(store, 1)
    yield* TestClock.setTime(6000)
    const routine = yield* store.makeWake({ ...ROUTINE, turn: 1, call: call! }, 20)
    return { reminder, routine, call: call!, all: yield* store.wakes() }
  }))
  const base = { slot: null, pending: null, missed: 0, fired: 0, lastTurn: null, settled: true, failed: 0, stopped: null, why: null, stopCall: null }
  expect(got.reminder).toEqual({
    _tag: "made",
    wake: { id: 1, text: "call back", cron: null, at: REMINDER.at, zone: "Europe/Berlin", first: REMINDER.first, turn: null, call: null, due: REMINDER.first, ...base, created: 5000, updated: 5000 }
  })
  expect(got.routine).toEqual({
    _tag: "made",
    wake: { id: 2, text: "stand up", cron: "0 9 * * 1-5", at: null, zone: "Europe/Berlin", first: ROUTINE.first, turn: 1, call: got.call, due: ROUTINE.first, ...base, created: 6000, updated: 6000 }
  })
  expect(got.all).toEqual([got.reminder, got.routine].flatMap((made) => made._tag === "made" ? [made.wake] : []))
  expect(wakeRow(file, 2)).toEqual({
    chat: 1, n: 2, text: "stand up", cron: "0 9 * * 1-5", at: null, zone: "Europe/Berlin", first: ROUTINE.first, turn: 1, call: got.call, due: ROUTINE.first,
    slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: null, why: null, stop_call: null, created: 6000, updated: 6000
  })
  // A new chat's wake-ups are on, and a turn started with no ceiling has
  // none.
  expect(rows(file, "select wakeups from everchat_chat")).toEqual([{ wakeups: 1 }])
  expect(rows(file, "select steps, tokens from everchat_turn")).toEqual([{ steps: null, tokens: null }])
})

test("makeWake: a text of 0 or 2,001 characters is refused with StoreError before the transaction and writes nothing; 1 and 2,000 are kept; a lone surrogate is made well formed, and counted so", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const refused = [
      yield* Effect.exit(store.makeWake({ ...REMINDER, text: "" }, 20)),
      yield* Effect.exit(store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX + 1) }, 20)),
      yield* Effect.exit(store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX) + "\ud800" }, 20))
    ]
    const count = wakeCount(file)
    const made = [
      yield* store.makeWake({ ...REMINDER, text: "t" }, 20),
      yield* store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX) }, 20),
      yield* store.makeWake({ ...REMINDER, text: "a\ud800b" }, 20),
      yield* store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX - 1) + "\ud800" }, 20)
    ]
    return { refused, count, made }
  }))
  expect(WAKE_TEXT_MAX).toBe(2000)
  const failure = (exit: Exit.Exit<unknown, StoreError>) => {
    if (Exit.isSuccess(exit)) return "it was made"
    const error = Cause.squash(exit.cause)
    return [error instanceof StoreError, error instanceof StoreError ? error.op : null, error instanceof StoreError ? String(error.cause) : String(error)]
  }
  expect(got.refused.map(failure)).toEqual([
    [true, "makeWake", "Error: a wake-up's text is a text of 1 to 2000 characters, not 0"],
    [true, "makeWake", "Error: a wake-up's text is a text of 1 to 2000 characters, not 2001"],
    [true, "makeWake", "Error: a wake-up's text is a text of 1 to 2000 characters, not 2001"]
  ])
  expect(got.count).toBe(0)
  expect(got.made.map((made) => made._tag === "made" ? [made.wake.id, made.wake.text.length, made.wake.text.isWellFormed()] : made._tag)).toEqual([
    [1, 1, true],
    [2, 2000, true],
    [3, 3, true],
    [4, 2000, true]
  ])
  expect(rows(file, "select n, text from everchat_wake where n in (3, 4) order by n")).toEqual([
    { n: 3, text: "a\ufffdb" },
    { n: 4, text: "t".repeat(WAKE_TEXT_MAX - 1) + "\ufffd" }
  ])
})

test("makeWake: the schema refuses a turn with no call, a call with no turn, a routine with a time, a wake-up with neither, a reminder whose first slot is not its time, and a turn that the chat has not: StoreError, nothing written; the next make takes id 1", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const [call] = yield* functions(store, 1)
    const tries = [
      { ...REMINDER, turn: 1 },
      { ...REMINDER, call: call! },
      { ...ROUTINE, at: ROUTINE.first },
      { text: "neither", zone: "UTC", first: 1 },
      { ...REMINDER, first: REMINDER.first + 1 },
      { ...REMINDER, turn: 99, call: call! }
    ]
    const errors = []
    for (const wake of tries) errors.push(yield* Effect.flip(store.makeWake(wake, 20)))
    const count = wakeCount(file)
    return { errors, count, next: yield* store.makeWake(REMINDER, 20) }
  }))
  // SQLite's own text: the driver's error (`reason`) holds it.
  const sqlite = (error: StoreError) => String((error.cause as { readonly reason?: { readonly cause?: unknown } }).reason?.cause)
  expect(got.errors.map((error) => [error instanceof StoreError, error.op, sqlite(error)])).toEqual([
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (turn is null) = (call is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (turn is null) = (call is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (cron is null) <> (at is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (cron is null) <> (at is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: at is null or first = at")],
    [true, "makeWake", expect.stringContaining("FOREIGN KEY constraint failed")]
  ])
  expect(got.count).toBe(0)
  expect(got.next._tag === "made" ? got.next.wake.id : got.next._tag).toBe(1)
})

test("makeWake: full at limit active rows, and nothing is written; a row that stopped (by plain SQL) is not counted; a limit of 0 is full", async () => {
  const file = newFile()
  const made = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    return [
      yield* store.makeWake(REMINDER, 2),
      yield* store.makeWake(ROUTINE, 2),
      yield* store.makeWake({ ...REMINDER, text: "a third" }, 2),
      yield* store.makeWake({ ...REMINDER, text: "a third" }, 3)
    ]
  }))
  expect(made.map((one) => one._tag === "made" ? one.wake.id : one._tag)).toEqual([1, 2, "full", 3])
  // The person stops wake-up 2, as the cut's later member will.
  write(file, "update everchat_wake set stopped = 9, why = 'person', due = null, updated = 9 where chat = 1 and n = 2")
  const after = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    return [
      yield* store.makeWake({ ...REMINDER, text: "a fourth" }, 3),
      yield* store.makeWake({ ...REMINDER, text: "a fifth" }, 3),
      yield* store.makeWake({ ...REMINDER, text: "none" }, 0)
    ]
  }))
  expect(after.map((one) => one._tag === "made" ? one.wake.id : one._tag)).toEqual([4, "full", "full"])
  expect(rows(file, "select n, text, stopped from everchat_wake order by n")).toEqual([
    { n: 1, text: "call back", stopped: null },
    { n: 2, text: "stand up", stopped: 9 },
    { n: 3, text: "a third", stopped: null },
    { n: 4, text: "a fourth", stopped: null }
  ])
})

test("wakes: the rows in the order of their ids; active: true, those not stopped; active: false, those stopped; on the store and on the reads", async () => {
  const file = newFile()
  await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    for (const text of ["one", "two", "three", "four"]) yield* store.makeWake({ ...REMINDER, text }, 20)
  }))
  write(file, "update everchat_wake set stopped = 9, why = 'person', due = null, updated = 9 where chat = 1 and n in (2, 3)")
  const read = (reads: Reading) =>
    Effect.gen(function*() {
      const of = (wakes: ReadonlyArray<Wake>) => wakes.map((wake) => [wake.id, wake.text, wake.stopped, wake.why])
      return {
        all: of(yield* reads.wakes()),
        none: of(yield* reads.wakes({})),
        active: of(yield* reads.wakes({ active: true })),
        stopped: of(yield* reads.wakes({ active: false }))
      }
    })
  const fromStore = await withStore(file, Store.use(read))
  const fromReads = await withReads(file, Reads.use(read))
  expect(fromReads).toEqual(fromStore)
  expect(fromStore).toEqual({
    all: [[1, "one", null, null], [2, "two", 9, "person"], [3, "three", 9, "person"], [4, "four", null, null]],
    none: [[1, "one", null, null], [2, "two", 9, "person"], [3, "three", 9, "person"], [4, "four", null, null]],
    active: [[1, "one", null, null], [4, "four", null, null]],
    stopped: [[2, "two", 9, "person"], [3, "three", 9, "person"]]
  })
})

// The fire's members (docs/wakeups.md, section 3)
// ------------------------------------------------

// Slots: a time in 2027, and an hour.
const T0 = 1_800_000_000_000
const H = 3_600_000

// The chat's switch of its wake-ups, by plain SQL, so that the cases of the
// fire's members do not rest on `setWakeups` (its own cases are below).
const switchBySql = (file: string, on: boolean, chat = 1) => write(file, "update everchat_chat set wakeups = ? where id = ?", [on ? 1 : 0, chat])

// The count of a fire's end, by plain SQL, as `settleWake` counts the end
// `kept`: `settled` 1, `updated` the time given; so that the cases of the
// fire's members do not rest on `settleWake` (its own cases are below).
const settleBySql = (file: string, n: number, at: number, chat = 1) =>
  write(file, "update everchat_wake set settled = 1, updated = ? where chat = ? and n = ? and settled = 0", [at, chat, n])

// A fire as an offer writes it: the turn's row, then the fire, in one
// transaction. Gives the turn's id.
const fire = (store: typeof Store.Service, n: number, read: { readonly pending: number; readonly missed: number }) =>
  store.transaction(Effect.gen(function*() {
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    yield* store.fireWake(n, turn.id, read)
    return turn.id
  }))

// One wake-up's row, by the store.
const wakeOf = (store: typeof Store.Service, n: number) => Effect.map(store.wakes(), (all) => all.find((wake) => wake.id === n))

// A row as `makeWake` gives it, with what is given over it.
const made = (one: { readonly _tag: string; readonly wake?: Wake }) => {
  if (one._tag !== "made" || one.wake === undefined) throw new Error(`not made: ${one._tag}`)
  return one.wake
}

test("dueWakes: the active rows whose due is at or before now, in the order of due, then of n; a stopped row, a row with no due and a row due later are left out; none while the chat's wake-ups are off; the same on the reads", async () => {
  const file = newFile()
  await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.makeWake({ ...ROUTINE, text: "1", first: T0 + 2 * H }, 20)
    yield* store.makeWake({ ...REMINDER, text: "2", at: T0 + H, first: T0 + H }, 20)
    yield* store.makeWake({ ...ROUTINE, text: "3", first: T0 + H }, 20)
    yield* store.makeWake({ ...REMINDER, text: "4", at: T0, first: T0 }, 20)
    yield* store.makeWake({ ...ROUTINE, text: "5", first: T0 + 3 * H }, 20)
    yield* store.makeWake({ ...ROUTINE, text: "6", first: T0 }, 20)
  }))
  write(file, "update everchat_wake set stopped = 9, why = 'person', due = null, updated = 9 where chat = 1 and n = 4")
  write(file, "update everchat_wake set due = null where chat = 1 and n = 6")
  const ask = (reads: Reading) =>
    Effect.gen(function*() {
      const ids = (wakes: ReadonlyArray<Wake>) => wakes.map((wake) => wake.id)
      return [
        ids(yield* reads.dueWakes(T0 + H - 1)),
        ids(yield* reads.dueWakes(T0 + H)),
        ids(yield* reads.dueWakes(T0 + 2 * H - 1)),
        ids(yield* reads.dueWakes(T0 + 2 * H)),
        ids(yield* reads.dueWakes(Number.MAX_SAFE_INTEGER))
      ]
    })
  const on = [[], [2, 3], [2, 3], [2, 3, 1], [2, 3, 1, 5]]
  expect(await withStore(file, Store.use(ask))).toEqual(on)
  expect(await withReads(file, Reads.use(ask))).toEqual(on)
  // The rows are whole.
  const due = await withStore(file, Store.use((store) => store.dueWakes(T0 + H)))
  const all = await withStore(file, Store.use((store) => store.wakes()))
  expect(due).toEqual([all[1]!, all[2]!])
  switchBySql(file, false)
  expect(await withStore(file, Store.use(ask))).toEqual([[], [], [], [], []])
  expect(await withReads(file, Reads.use(ask))).toEqual([[], [], [], [], []])
  switchBySql(file, true)
  expect(await withStore(file, Store.use(ask))).toEqual(on)
})

test("pendWake with no fire waiting: pending, missed and due as given, updated the clock's time, and true; missed 0, 1, 999 and 1,000 as given, 1,001 kept at 1,000; a reminder's due may be null", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const rows = []
    for (const missed of [0, 1, 999, 1000, 1001]) rows.push(made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20)))
    const reminder = made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
    yield* TestClock.setTime(T0 + 5)
    const answers = []
    for (const [k, missed] of [0, 1, 999, 1000, 1001].entries()) answers.push(yield* store.pendWake(rows[k]!.id, { pending: T0, missed, due: T0 + H }))
    answers.push(yield* store.pendWake(reminder.id, { pending: T0, missed: 0, due: null }))
    return { rows, reminder, answers, after: yield* store.wakes() }
  }))
  expect(got.answers).toEqual([true, true, true, true, true, true])
  expect(got.after).toEqual([
    ...[0, 1, 999, 1000, 1000].map((missed, k) => ({ ...got.rows[k]!, pending: T0, missed, due: T0 + H, updated: T0 + 5 })),
    { ...got.reminder, pending: T0, missed: 0, due: null, updated: T0 + 5 }
  ])
})

test("pendWake with a fire waiting: one fire still waits, pending the given slot, missed the old missed + 1 + the given count, at most 1,000, due as given", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const row = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const capped = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const full = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    yield* store.pendWake(row.id, { pending: T0, missed: 3, due: T0 + H })
    yield* store.pendWake(capped.id, { pending: T0, missed: 3, due: T0 + H })
    yield* store.pendWake(full.id, { pending: T0, missed: 1000, due: T0 + H })
    yield* TestClock.setTime(T0 + 7)
    const answers = [
      yield* store.pendWake(row.id, { pending: T0 + 2 * H, missed: 5, due: T0 + 3 * H }),
      yield* store.pendWake(capped.id, { pending: T0 + 2 * H, missed: 996, due: T0 + 3 * H }),
      yield* store.pendWake(full.id, { pending: T0 + 2 * H, missed: 0, due: T0 + 3 * H })
    ]
    const once = yield* store.wakes()
    yield* TestClock.setTime(T0 + 8)
    answers.push(yield* store.pendWake(capped.id, { pending: T0 + 3 * H, missed: 0, due: T0 + 4 * H }))
    return { rows: [row, capped, full], answers, once, twice: yield* wakeOf(store, capped.id) }
  }))
  expect(got.answers).toEqual([true, true, true, true])
  const [row, capped, full] = got.rows
  expect(got.once).toEqual([
    { ...row!, pending: T0 + 2 * H, missed: 3 + 1 + 5, due: T0 + 3 * H, updated: T0 + 7 },
    { ...capped!, pending: T0 + 2 * H, missed: 1000, due: T0 + 3 * H, updated: T0 + 7 },
    { ...full!, pending: T0 + 2 * H, missed: 1000, due: T0 + 3 * H, updated: T0 + 7 }
  ])
  // 3 + 1 + 996 is the bound itself; one more slot stays at it.
  expect(got.twice).toEqual({ ...capped!, pending: T0 + 3 * H, missed: 1000, due: T0 + 4 * H, updated: T0 + 8 })
})

test("pendWake changes nothing and gives false, with no StoreError: a slot at or before the waiting pending, at or before the row's slot, a stopped row, a row that is not there, and a chat whose wake-ups are off; then on, the same slot is taken", async () => {
  const file = newFile()
  const first = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const waiting = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const fired = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const stopped = made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
    yield* store.pendWake(waiting.id, { pending: T0, missed: 2, due: T0 + H })
    yield* store.pendWake(fired.id, { pending: T0, missed: 2, due: T0 + H })
    yield* fire(store, fired.id, { pending: T0, missed: 2 })
    yield* store.pendWake(stopped.id, { pending: T0, missed: 0, due: null })
    yield* fire(store, stopped.id, { pending: T0, missed: 0 })
    const before = yield* store.wakes()
    yield* TestClock.setTime(T0 + 9)
    const answers = [
      yield* store.pendWake(waiting.id, { pending: T0, missed: 0, due: T0 + 2 * H }),
      yield* store.pendWake(waiting.id, { pending: T0 - 1, missed: 0, due: T0 + 2 * H }),
      yield* store.pendWake(fired.id, { pending: T0, missed: 0, due: T0 + 2 * H }),
      yield* store.pendWake(fired.id, { pending: T0 - H, missed: 0, due: T0 + 2 * H }),
      yield* store.pendWake(stopped.id, { pending: T0 + H, missed: 0, due: null }),
      yield* store.pendWake(9, { pending: T0 + H, missed: 0, due: null })
    ]
    return { before, answers, after: yield* store.wakes() }
  }))
  expect(first.before.map((wake) => [wake.id, wake.slot, wake.pending, wake.stopped !== null])).toEqual([[1, null, T0, false], [2, T0, null, false], [3, T0, null, true]])
  expect(first.answers).toEqual([false, false, false, false, false, false])
  expect(first.after).toEqual(first.before)
  switchBySql(file, false)
  const off = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0 + 10)
    return {
      answers: [
        yield* store.pendWake(1, { pending: T0 + H, missed: 0, due: T0 + 2 * H }),
        yield* store.pendWake(2, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
      ],
      after: yield* store.wakes()
    }
  }))
  expect(off.answers).toEqual([false, false])
  expect(off.after).toEqual(first.before)
  switchBySql(file, true)
  const on = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0 + 11)
    return {
      answers: [
        yield* store.pendWake(1, { pending: T0 + H, missed: 0, due: T0 + 2 * H }),
        yield* store.pendWake(2, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
      ],
      after: yield* store.wakes()
    }
  }))
  expect(on.answers).toEqual([true, true])
  expect(on.after).toEqual([
    { ...first.before[0]!, pending: T0 + H, missed: 2 + 1 + 0, due: T0 + 2 * H, updated: T0 + 11 },
    { ...first.before[1]!, pending: T0 + H, missed: 0, due: T0 + 2 * H, updated: T0 + 11 },
    first.before[2]!
  ])
})

test("pendingWake: the least pending, then the least n, of the active rows whose last end is counted; a row with settled = 0 is left out until its end is counted (plain SQL); none while the chat's wake-ups are off, and none with no fire waiting; the same on the reads", async () => {
  const file = newFile()
  const ids = (reads: Reading) => Effect.map(reads.pendingWake(), Option.map((wake) => wake.id))
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const answers = []
    for (const text of ["1", "2", "3"]) yield* store.makeWake({ ...ROUTINE, text, first: T0 }, 20)
    answers.push(yield* ids(store))
    yield* store.pendWake(1, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
    yield* store.pendWake(2, { pending: T0, missed: 0, due: T0 + H })
    yield* store.pendWake(3, { pending: T0, missed: 0, due: T0 + H })
    // The oldest fire: 2 and 3 wait at one slot, before 1's; 2 has the least n.
    answers.push(yield* ids(store))
    const whole = { given: yield* store.pendingWake(), row: yield* wakeOf(store, 2) }
    yield* fire(store, 2, { pending: T0, missed: 0 })
    answers.push(yield* ids(store))
    // 3 fires, and waits again at a slot before 1's, with its end not counted.
    yield* fire(store, 3, { pending: T0, missed: 0 })
    yield* store.pendWake(3, { pending: T0 + H / 2, missed: 0, due: T0 + H })
    answers.push(yield* ids(store))
    return { answers, whole }
  }))
  expect(got.answers).toEqual([Option.none(), Option.some(2), Option.some(3), Option.some(1)])
  // The whole row, with the pending and missed that a source hands on.
  expect(got.whole.given).toEqual(Option.some(got.whole.row!))
  expect(got.whole.row).toMatchObject({ pending: T0, missed: 0, settled: true })
  expect(await withReads(file, Reads.use(ids))).toEqual(Option.some(1))
  settleBySql(file, 3, T0)
  expect(await withStore(file, Store.use(ids))).toEqual(Option.some(3))
  expect(await withReads(file, Reads.use(ids))).toEqual(Option.some(3))
  switchBySql(file, false)
  expect(await withStore(file, Store.use(ids))).toEqual(Option.none())
  expect(await withReads(file, Reads.use(ids))).toEqual(Option.none())
})

test("fireWake: the fire goes in the offer's transaction, after the turn's row: slot the slot read, pending null, missed 0, fired + 1, lastTurn the turn, settled false, due kept, updated the clock's time; a failed transaction writes neither the turn nor the fire", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const row = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    yield* store.pendWake(row.id, { pending: T0, missed: 4, due: T0 + H })
    const read = Option.getOrThrow(yield* store.pendingWake())
    const before = yield* wakeOf(store, row.id)
    const failed = yield* Effect.exit(store.transaction(Effect.gen(function*() {
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      yield* store.fireWake(row.id, turn.id, { pending: read.pending!, missed: read.missed })
      return yield* Effect.fail("a later write of the offer failed")
    })))
    const kept = { wake: yield* wakeOf(store, row.id), turns: (yield* store.turns(null, 10)).length }
    yield* TestClock.setTime(T0 + 3)
    const turn = yield* fire(store, row.id, { pending: read.pending!, missed: read.missed })
    return { row, before, failed, kept, turn, after: yield* wakeOf(store, row.id) }
  }))
  expect(Exit.isFailure(got.failed)).toBe(true)
  expect(got.kept).toEqual({ wake: got.before, turns: 0 })
  expect(got.after).toEqual({ ...got.before!, slot: T0, pending: null, missed: 0, fired: 1, lastTurn: got.turn, settled: false, due: T0 + H, updated: T0 + 3 })
  // Its end counted, the next slot fires again.
  settleBySql(file, 1, T0 + 4)
  const again = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.pendWake(1, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
    yield* TestClock.setTime(T0 + H)
    const turn = yield* fire(store, 1, { pending: T0 + H, missed: 0 })
    return { turn, after: yield* wakeOf(store, 1) }
  }))
  expect(again.after).toEqual({ ...got.after!, slot: T0 + H, fired: 2, lastTurn: again.turn, due: T0 + 2 * H, updated: T0 + H })
})

test("fireWake with a newer slot written between the read and the fire: slot the slot read, the newer slot waits on, and missed loses the read's missed + 1; not below 0; a count at 1,000 stays", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const newer = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const stale = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const capped = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    for (const [row, missed] of [[newer, 4], [stale, 4], [capped, 998]] as const) {
      yield* store.pendWake(row.id, { pending: T0, missed, due: T0 + H })
    }
    const reads = [yield* wakeOf(store, newer.id), yield* wakeOf(store, stale.id), yield* wakeOf(store, capped.id)]
    // The firer writes a newer slot of each before the fire.
    for (const row of [newer, stale, capped]) yield* store.pendWake(row.id, { pending: T0 + 2 * H, missed: 5, due: T0 + 3 * H })
    yield* TestClock.setTime(T0 + 2 * H + 1)
    const turns = [
      yield* fire(store, newer.id, { pending: T0, missed: 4 }),
      // A read whose missed is past the row's: missed stops at 0.
      yield* fire(store, stale.id, { pending: T0, missed: 50 }),
      yield* fire(store, capped.id, { pending: T0, missed: 998 })
    ]
    return { reads, turns, after: yield* store.wakes() }
  }))
  const [newer, stale, capped] = got.reads
  expect([newer!.missed, stale!.missed, capped!.missed]).toEqual([4, 4, 998])
  const fired = { slot: T0, pending: T0 + 2 * H, fired: 1, settled: false, due: T0 + 3 * H, updated: T0 + 2 * H + 1 }
  expect(got.after).toEqual([
    // 4 + 1 + 5 = 10 before the fire; the fire takes 4 + 1.
    { ...newer!, ...fired, missed: 5, lastTurn: got.turns[0]! },
    { ...stale!, ...fired, missed: 0, lastTurn: got.turns[1]! },
    // 998 + 1 + 5 is past the bound: it stays at 1,000.
    { ...capped!, ...fired, missed: 1000, lastTurn: got.turns[2]! }
  ])
})

test("fireWake of a reminder stops it, why fired, with nothing left to fire; also a reminder whose pendWake gave a due, and one with a newer pending written between the read and the fire (ruling 4a): no StoreError", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const plain = made(yield* store.makeWake({ ...REMINDER, text: "plain", at: T0, first: T0 }, 20))
    const withDue = made(yield* store.makeWake({ ...REMINDER, text: "with a due", at: T0, first: T0 }, 20))
    const newer = made(yield* store.makeWake({ ...REMINDER, text: "a newer slot", at: T0, first: T0 }, 20))
    yield* store.pendWake(plain.id, { pending: T0, missed: 0, due: null })
    yield* store.pendWake(withDue.id, { pending: T0, missed: 0, due: T0 + H })
    yield* store.pendWake(newer.id, { pending: T0, missed: 1, due: null })
    yield* store.pendWake(newer.id, { pending: T0 + H, missed: 2, due: null })
    yield* TestClock.setTime(T0 + H + 1)
    const exits = [
      yield* Effect.exit(fire(store, plain.id, { pending: T0, missed: 0 })),
      yield* Effect.exit(fire(store, withDue.id, { pending: T0, missed: 0 })),
      yield* Effect.exit(fire(store, newer.id, { pending: T0, missed: 1 }))
    ]
    return { rows: [plain, withDue, newer], exits, after: yield* store.wakes(), active: yield* store.wakes({ active: true }) }
  }))
  expect(got.exits.map((exit) => Exit.isSuccess(exit) ? "fired" : String(Cause.squash(exit.cause)))).toEqual(["fired", "fired", "fired"])
  const turns = got.exits.map((exit) => (Exit.isSuccess(exit) ? exit.value : null))
  const stopped = { slot: T0, pending: null, missed: 0, due: null, fired: 1, settled: false, stopped: T0 + H + 1, why: "fired" as const, updated: T0 + H + 1 }
  expect(got.after).toEqual(got.rows.map((row, k) => ({ ...row, ...stopped, lastTurn: turns[k] ?? null })))
  expect(got.active).toEqual([])
})

test("fireWake fails with StoreError and writes nothing for a row that is not there, a stopped row, a row whose end is not counted, a row with no fire waiting, a read of a slot that is not the row's waiting one or older, and a turn that the chat has not", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const waits = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const unsettled = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const idle = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const reminder = made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
    yield* store.pendWake(waits.id, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
    yield* store.pendWake(unsettled.id, { pending: T0, missed: 0, due: T0 + H })
    yield* fire(store, unsettled.id, { pending: T0, missed: 0 })
    yield* store.pendWake(unsettled.id, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
    yield* store.pendWake(reminder.id, { pending: T0, missed: 0, due: null })
    yield* fire(store, reminder.id, { pending: T0, missed: 0 })
    const before = { wakes: yield* store.wakes(), turns: (yield* store.turns(null, 10)).length }
    const [turn] = yield* store.turns(null, 1)
    const tries = [
      store.fireWake(9, turn!.id, { pending: T0 + H, missed: 0 }),
      store.fireWake(reminder.id, turn!.id, { pending: T0, missed: 0 }),
      store.fireWake(unsettled.id, turn!.id, { pending: T0 + H, missed: 0 }),
      store.fireWake(idle.id, turn!.id, { pending: T0, missed: 0 }),
      store.fireWake(waits.id, turn!.id, { pending: T0 + 2 * H, missed: 0 }),
      store.fireWake(waits.id, 99, { pending: T0 + H, missed: 0 })
    ]
    const errors = []
    for (const one of tries) errors.push(yield* Effect.flip(one))
    return { before, errors, after: { wakes: yield* store.wakes(), turns: (yield* store.turns(null, 10)).length } }
  }))
  // SQLite's own text: the driver's error (`reason`) holds it.
  const sqlite = (error: StoreError) => String((error.cause as { readonly reason?: { readonly cause?: unknown } }).reason?.cause)
  expect(got.errors.map((error, k) => [error instanceof StoreError, error.op, k < 5 ? String(error.cause) : sqlite(error)])).toEqual([
    [true, "fireWake", "Error: the chat has no wake-up 9"],
    [true, "fireWake", "Error: the wake-up 4 stopped, and has no fire"],
    [true, "fireWake", "Error: the wake-up 2's last fire is not settled"],
    [true, "fireWake", `Error: the wake-up 3 has no fire of the slot ${T0} waiting`],
    [true, "fireWake", `Error: the wake-up 1 has no fire of the slot ${T0 + 2 * H} waiting`],
    [true, "fireWake", expect.stringContaining("FOREIGN KEY constraint failed")]
  ])
  expect(got.after).toEqual(got.before)
})

test("fires: the wake messages created at or after since, each counted once at its last page; a page with more = 1 and a message of another kind are not counted; since exactly counts, 1 ms after it does not; the same on the reads", async () => {
  const file = newFile()
  await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0)
    yield* store.append([{ kind: "wake", text: "page 1", more: true }, { kind: "wake", text: "page 2" }])
    yield* TestClock.setTime(T0 + 1)
    yield* store.append([{ kind: "wake", text: "one page" }])
    yield* store.append([{ kind: "note", text: "a note" }, { kind: "user", text: "a word" }])
    yield* TestClock.setTime(T0 + 2)
    yield* store.append([{ kind: "late", text: "a late result" }])
  }))
  const ask = (reads: Reading) => Effect.all([reads.fires(0), reads.fires(T0 - 1), reads.fires(T0), reads.fires(T0 + 1), reads.fires(T0 + 2)])
  expect(rows(file, "select k.name as kind, m.more, m.created from everchat_msg m join everchat_kind k on k.id = m.kind order by m.i")).toEqual([
    { kind: "wake", more: 1, created: T0 },
    { kind: "wake", more: 0, created: T0 },
    { kind: "wake", more: 0, created: T0 + 1 },
    { kind: "note", more: 0, created: T0 + 1 },
    { kind: "user", more: 0, created: T0 + 1 },
    { kind: "late", more: 0, created: T0 + 2 }
  ])
  expect(await withStore(file, Store.use(ask))).toEqual([2, 2, 2, 1, 0])
  expect(await withReads(file, Reads.use(ask))).toEqual([2, 2, 2, 1, 0])
})

// The settle, the stops, the switch, the rows of a program (docs/wakeups.md,
// sections 3 and 7)
// --------------------------------------------------------------------------

// A slot `slot` of the wake-up `n` comes (`pendWake`, the next slot an hour
// on) and fires, as an offer writes it: gives the turn that the fire
// started. The row's end is not counted yet.
const fireSlot = (store: typeof Store.Service, n: number, slot: number) =>
  Effect.andThen(store.pendWake(n, { pending: slot, missed: 0, due: slot + H }), fire(store, n, { pending: slot, missed: 0 }))

// The why of a turn that its ceiling stopped, as the turn loop will write it
// (docs/wakeups.md, section 6).
const CEILING_WHY = "Stopped: this wake-up's turn reached its ceiling of steps or tokens."

// What a row of `unsettledWakes` says.
const unsettledOf = (rows: ReadonlyArray<UnsettledWake>) => rows.map((row) => [row.wake.id, row.wake.lastTurn, row.status, row.why, row.wake.failed])

test("settleWake: each end of section 7's table: a done turn sets failed to 0, a failed turn and one that its ceiling stopped (end failed) add 1, a turn that the person stopped (end kept) keeps the count; each sets settled, updated the clock's time, and gives settled and not stopped", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    const ends = [
      { status: "failed", why: "the model failed", end: "failed" },
      { status: "done", why: null, end: "done" },
      { status: "stopped", why: CEILING_WHY, end: "failed" },
      { status: "stopped", why: "Stopped.", end: "kept" },
      { status: "done", why: null, end: "done" }
    ] as const
    const seen = []
    for (const [k, { end, status, why }] of ends.entries()) {
      const slot = T0 + k * H
      yield* TestClock.setTime(slot)
      const turn = yield* fireSlot(store, 1, slot)
      yield* store.endTurn(turn, status, why)
      const unsettled = unsettledOf(yield* store.unsettledWakes())
      yield* TestClock.setTime(slot + 1)
      const answer = yield* store.settleWake(1, turn, end)
      const row = (yield* wakeOf(store, 1))!
      seen.push({ unsettled, answer, row: [row.failed, row.settled, row.updated, row.stopped, row.why, row.lastTurn, row.fired] })
    }
    return seen
  }))
  expect(got).toEqual([
    { unsettled: [[1, 1, "failed", "the model failed", 0]], answer: { settled: true, stopped: false }, row: [1, true, T0 + 1, null, null, 1, 1] },
    { unsettled: [[1, 2, "done", null, 1]], answer: { settled: true, stopped: false }, row: [0, true, T0 + H + 1, null, null, 2, 2] },
    { unsettled: [[1, 3, "stopped", CEILING_WHY, 0]], answer: { settled: true, stopped: false }, row: [1, true, T0 + 2 * H + 1, null, null, 3, 3] },
    { unsettled: [[1, 4, "stopped", "Stopped.", 1]], answer: { settled: true, stopped: false }, row: [1, true, T0 + 3 * H + 1, null, null, 4, 4] },
    { unsettled: [[1, 5, "done", null, 1]], answer: { settled: true, stopped: false }, row: [0, true, T0 + 4 * H + 1, null, null, 5, 5] }
  ])
})

test(`settleWake: the second failure in a row (WAKE_FAILURES) stops the active row in the same statement, why failed, at the clock's time, with its waiting fire cleared (due, pending null, missed 0); it gives settled and stopped, and the row is in no answer of dueWakes, pendingWake or wakes({ active: true })`, async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    const first = yield* fireSlot(store, 1, T0)
    const once = yield* store.settleWake(1, first, "failed")
    yield* TestClock.setTime(T0 + H)
    const second = yield* fireSlot(store, 1, T0 + H)
    // While the turn runs, a newer slot comes and waits, with 4 missed.
    yield* TestClock.setTime(T0 + 3 * H)
    const pended = yield* store.pendWake(1, { pending: T0 + 3 * H, missed: 4, due: T0 + 4 * H })
    const waiting = (yield* wakeOf(store, 1))!
    yield* TestClock.setTime(T0 + 3 * H + 5)
    const twice = yield* store.settleWake(1, second, "failed")
    return {
      once,
      pended,
      waiting: [waiting.pending, waiting.missed, waiting.due],
      twice,
      row: (yield* wakeOf(store, 1))!,
      due: yield* store.dueWakes(Number.MAX_SAFE_INTEGER),
      pending: yield* store.pendingWake(),
      active: yield* store.wakes({ active: true })
    }
  }))
  expect(WAKE_FAILURES).toBe(2)
  expect(got.once).toEqual({ settled: true, stopped: false })
  expect(got.pended).toBe(true)
  expect(got.waiting).toEqual([T0 + 3 * H, 4, T0 + 4 * H])
  expect(got.twice).toEqual({ settled: true, stopped: true })
  expect(got.row).toMatchObject({
    failed: 2,
    settled: true,
    stopped: T0 + 3 * H + 5,
    why: "failed",
    stopCall: null,
    due: null,
    pending: null,
    missed: 0,
    slot: T0 + H,
    fired: 2,
    lastTurn: 2,
    updated: T0 + 3 * H + 5
  })
  expect(got.due).toEqual([])
  expect(Option.isNone(got.pending)).toBe(true)
  expect(got.active).toEqual([])
})

test("settleWake of a row stopped in between (by the person, by unwake, a reminder that fired) counts the end and settles it, and the row keeps its first stopped and why: a count that reaches 2 then stops nothing, and the answer is settled and not stopped", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const [call] = yield* functions(store, 1)
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "the third" }, 20))
    made(yield* store.makeWake({ ...REMINDER, at: T0 + 2 * H, first: T0 + 2 * H }, 20))
    // Routines 2 and 3 have failed once; each fires again.
    const turns: Array<number> = []
    for (const n of [2, 3]) {
      yield* store.settleWake(n, yield* fireSlot(store, n, T0), "failed")
      turns.push(yield* fireSlot(store, n, T0 + H))
    }
    // The reminder fires: it stops, why fired.
    const reminder = yield* fireSlot(store, 4, T0 + 2 * H)
    yield* TestClock.setTime(T0 + 3 * H)
    const stops = [yield* store.stopWake(2, "person"), yield* store.stopWake(3, "unwake", call!)]
    yield* TestClock.setTime(T0 + 4 * H)
    const answers = [
      yield* store.settleWake(2, turns[0]!, "failed"),
      yield* store.settleWake(3, turns[1]!, "failed"),
      yield* store.settleWake(4, reminder, "failed")
    ]
    const rows = (yield* store.wakes()).filter((wake) => wake.id > 1)
    return { stops, answers, rows: rows.map((row) => [row.id, row.failed, row.settled, row.stopped, row.why, row.stopCall, row.updated]) }
  }))
  expect(got.stops).toEqual([true, true])
  expect(got.answers).toEqual([{ settled: true, stopped: false }, { settled: true, stopped: false }, { settled: true, stopped: false }])
  expect(got.rows).toEqual([
    [2, 2, true, T0 + 3 * H, "person", null, T0 + 4 * H],
    [3, 2, true, T0 + 3 * H, "unwake", 2, T0 + 4 * H],
    [4, 1, true, T0, "fired", null, T0 + 4 * H]
  ])
})

test("settleWake while the chat's wake-ups are off: the end is counted, and the second failure stops the row, as when on (the switch is not read)", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
    const one = yield* fireSlot(store, 1, T0)
    const two = yield* fireSlot(store, 2, T0)
    const off = yield* store.setWakeups(false)
    const done = yield* store.settleWake(1, one, "done")
    const failed = yield* store.settleWake(2, two, "failed")
    // Off: no fire is pended; on, routine 2 fires again; off, its second
    // failure is counted.
    yield* store.setWakeups(true)
    const again = yield* fireSlot(store, 2, T0 + H)
    yield* store.setWakeups(false)
    const stopped = yield* store.settleWake(2, again, "failed")
    return { off, done, failed, stopped, chat: (yield* store.chat).wakeups, rows: (yield* store.wakes()).map((row) => [row.id, row.failed, row.settled, row.why]) }
  }))
  expect(got).toEqual({
    off: true,
    done: { settled: true, stopped: false },
    failed: { settled: true, stopped: false },
    stopped: { settled: true, stopped: true },
    chat: false,
    rows: [[1, 0, true, null], [2, 2, true, "failed"]]
  })
})

test("settleWake changes nothing, and gives not settled, for another turn than the row's last, an older one, a second settle, a row that never fired, and a row that is not there: the row and its updated as they were", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "never fired" }, 20))
    const first = yield* fireSlot(store, 1, T0)
    yield* store.settleWake(1, first, "failed")
    yield* TestClock.setTime(T0 + H)
    const last = yield* fireSlot(store, 1, T0 + H)
    // A turn of no fire of this row.
    const other = (yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })).id
    const before = wakeRow(file, 1)
    yield* TestClock.setTime(T0 + 2 * H)
    const refused = [
      yield* store.settleWake(1, other, "failed"),
      yield* store.settleWake(1, first, "failed"),
      yield* store.settleWake(1, 99, "done"),
      yield* store.settleWake(2, last, "failed"),
      yield* store.settleWake(9, last, "failed")
    ]
    const unchanged = wakeRow(file, 1)
    const settled = yield* store.settleWake(1, last, "done")
    const after = wakeRow(file, 1)
    yield* TestClock.setTime(T0 + 3 * H)
    const twice = [yield* store.settleWake(1, last, "failed"), yield* store.settleWake(1, last, "done")]
    return { before, refused, unchanged, settled, after, twice, again: wakeRow(file, 1), never: wakeRow(file, 2) }
  }))
  const none = { settled: false, stopped: false }
  expect(got.refused).toEqual([none, none, none, none, none])
  expect(got.unchanged).toEqual(got.before)
  expect(got.before).toMatchObject({ failed: 1, settled: 0, last_turn: 2 })
  expect(got.settled).toEqual({ settled: true, stopped: false })
  expect(got.after).toMatchObject({ failed: 0, settled: 1, last_turn: 2, updated: T0 + 2 * H })
  expect(got.twice).toEqual([none, none])
  expect(got.again).toEqual(got.after)
  expect(got.never).toMatchObject({ failed: 0, settled: 1, last_turn: null, updated: T0 })
})

test("settleWake, stopWake and setWakeups are each the write of a note: in the note's transaction they commit with its page, and a transaction that fails after them leaves neither the page nor their change", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
    yield* store.settleWake(1, yield* fireSlot(store, 1, T0), "failed")
    const turn = yield* fireSlot(store, 1, T0 + H)
    // The form of `Turns.note`'s `write` (turn.ts).
    const writes: ReadonlyArray<readonly [string, (first: Message) => Effect.Effect<void, StoreError>]> = [
      ["Wake-up 1 stopped: two of its turns in a row failed or reached the ceiling.", () => store.settleWake(1, turn, "failed")],
      ["Wake-up 2 stopped by the person.", () => store.stopWake(2, "person")],
      ["The person turned the wake-ups off.", () => store.setWakeups(false)]
    ]
    // As `Turns.note` logs a note: its page, then the write, in one
    // transaction.
    const note = (text: string, write: (first: Message) => Effect.Effect<void, StoreError>) =>
      store.transaction(Effect.flatMap(store.append([{ kind: "note", text }]), (written) => write(written[0]!)))
    const failed = []
    for (const [text, write] of writes) failed.push(yield* Effect.flip(store.transaction(Effect.andThen(note(text, write), Effect.fail("after the write")))))
    const kept = { rows: [wakeRow(file, 1), wakeRow(file, 2)], chat: (yield* store.chat).wakeups, count: yield* store.count }
    for (const [text, write] of writes) yield* note(text, write)
    const notes = (yield* store.messages(0, 100)).filter((message) => message.kind === "note").map((message) => message.text)
    return { failed, kept, notes, rows: (yield* store.wakes()).map((row) => [row.id, row.settled, row.failed, row.why]), chat: (yield* store.chat).wakeups }
  }))
  expect(got.failed).toEqual(["after the write", "after the write", "after the write"])
  expect(got.kept.rows[0]).toMatchObject({ settled: 0, failed: 1, stopped: null })
  expect(got.kept.rows[1]).toMatchObject({ stopped: null, why: null })
  expect(got.kept.chat).toBe(true)
  expect(got.kept.count).toBe(0)
  expect(got.notes).toEqual([
    "Wake-up 1 stopped: two of its turns in a row failed or reached the ceiling.",
    "Wake-up 2 stopped by the person.",
    "The person turned the wake-ups off."
  ])
  expect(got.rows).toEqual([[1, true, 2, "failed"], [2, true, 0, "person"]])
  expect(got.chat).toBe(false)
})

test("unsettledWakes: the rows whose end is not counted, in the order of their ids, each with its last turn's status and why and its failed count; a settled row and a row that never fired are left out; the switch is not read; the same on the reads", async () => {
  const file = newFile()
  await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    yield* TestClock.setTime(T0)
    for (const text of ["one", "two", "three", "four", "five"]) made(yield* store.makeWake({ ...ROUTINE, text }, 20))
    // 1: fired, its turn runs. 2: fired once and failed, settled; fired
    // again, its turn failed. 3: never fired. 4: fired, settled. 5: fired,
    // its turn stopped by the ceiling.
    yield* fireSlot(store, 1, T0)
    yield* store.settleWake(2, yield* fireSlot(store, 2, T0), "failed")
    yield* store.endTurn(yield* fireSlot(store, 2, T0 + H), "failed", "the model failed")
    yield* store.settleWake(4, yield* fireSlot(store, 4, T0), "done")
    yield* store.endTurn(yield* fireSlot(store, 5, T0), "stopped", CEILING_WHY)
    yield* store.setWakeups(false)
  }))
  const read = (reads: Reading) => Effect.map(reads.unsettledWakes(), (rows) => ({ rows: unsettledOf(rows), wakes: rows.map((row) => row.wake) }))
  const fromStore = await withStore(file, Store.use((store) => Effect.all({ got: read(store), wakes: store.wakes() })))
  const fromReads = await withReads(file, Reads.use(read))
  expect(fromStore.got.rows).toEqual([
    [1, 1, "running", null, 0],
    [2, 3, "failed", "the model failed", 1],
    [5, 5, "stopped", CEILING_WHY, 0]
  ])
  // Each row whole, as `wakes` gives it.
  expect(fromStore.got.wakes).toEqual(fromStore.wakes.filter((wake) => [1, 2, 5].includes(wake.id)))
  expect(fromReads).toEqual(fromStore.got)
})

test("stopWake: an active row stops at the clock's time, why unwake with the function's call or person with none, with its waiting fire cleared (due, pending null, missed 0), and gives true; it is in no answer of dueWakes or pendingWake; its end, if not counted, stays to count", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const [call] = yield* functions(store, 1)
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
    // 1: fired, and a newer slot waits, with 3 missed; its end not counted.
    const turn = yield* fireSlot(store, 1, T0)
    yield* store.pendWake(1, { pending: T0 + H, missed: 3, due: T0 + 2 * H })
    // 2: a fire waits.
    yield* store.pendWake(2, { pending: T0, missed: 1, due: T0 + H })
    yield* TestClock.setTime(T0 + 2 * H)
    const before = { due: (yield* store.dueWakes(T0 + 2 * H)).map((wake) => wake.id), pending: Option.map(yield* store.pendingWake(), (wake) => wake.id) }
    const stops = [yield* store.stopWake(1, "unwake", call!), yield* store.stopWake(2, "person")]
    return {
      before,
      stops,
      rows: yield* store.wakes(),
      due: yield* store.dueWakes(Number.MAX_SAFE_INTEGER),
      pending: yield* store.pendingWake(),
      unsettled: unsettledOf(yield* store.unsettledWakes()),
      turn,
      call: call!
    }
  }))
  expect(got.before).toEqual({ due: [2, 1], pending: Option.some(2) })
  expect(got.stops).toEqual([true, true])
  const stopped = { stopped: T0 + 2 * H, due: null, pending: null, missed: 0, updated: T0 + 2 * H }
  expect(got.rows[0]).toMatchObject({ ...stopped, why: "unwake", stopCall: got.call, settled: false, lastTurn: got.turn, slot: T0, fired: 1 })
  expect(got.rows[1]).toMatchObject({ ...stopped, why: "person", stopCall: null, settled: true, lastTurn: null, slot: null, fired: 0 })
  expect(got.due).toEqual([])
  expect(Option.isNone(got.pending)).toBe(true)
  expect(got.unsettled).toEqual([[1, got.turn, "running", null, 0]])
})

test("stopWake changes nothing and gives false for a row that stopped already (each why, each kind of stop) and a row that is not there; the person's stop with a call fails with StoreError and writes nothing; a call that the chat has not is refused by the reference", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const [call] = yield* functions(store, 1)
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake(ROUTINE, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "two" }, 20))
    made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "four" }, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "five" }, 20))
    yield* store.stopWake(1, "unwake", call!)
    yield* store.stopWake(2, "person")
    yield* fireSlot(store, 3, T0)
    // 4 stops at its second failure.
    yield* store.settleWake(4, yield* fireSlot(store, 4, T0), "failed")
    yield* store.settleWake(4, yield* fireSlot(store, 4, T0 + H), "failed")
    const before = [1, 2, 3, 4].map((n) => wakeRow(file, n))
    yield* TestClock.setTime(T0 + 5 * H)
    const again = []
    for (const n of [1, 2, 3, 4]) again.push(yield* store.stopWake(n, "person"), yield* store.stopWake(n, "unwake", call!), yield* store.stopWake(n, "unwake"))
    const missing = [yield* store.stopWake(9, "person"), yield* store.stopWake(9, "unwake", call!)]
    const after = [1, 2, 3, 4].map((n) => wakeRow(file, n))
    const five = wakeRow(file, 5)
    const refused = [yield* Effect.flip(store.stopWake(5, "person", call!)), yield* Effect.flip(store.stopWake(5, "unwake", 99))]
    return { before, again, missing, after, five, refused, still: wakeRow(file, 5) }
  }))
  expect(got.before.map((row) => row!["why"])).toEqual(["unwake", "person", "fired", "failed"])
  expect(got.again).toEqual(Array.from({ length: 12 }, () => false))
  expect(got.missing).toEqual([false, false])
  expect(got.after).toEqual(got.before)
  expect(got.refused.map((error) => [error instanceof StoreError, error.op])).toEqual([[true, "stopWake"], [true, "stopWake"]])
  expect(String(got.refused[0]!.cause)).toBe("Error: the person's stop of a wake-up has no call")
  expect(String((got.refused[1]!.cause as { readonly cause?: unknown }).cause)).toContain("ConstraintError")
  expect(got.still).toEqual(got.five)
  expect(got.five).toMatchObject({ stopped: null, why: null, stop_call: null })
})

test("setWakeups: off and on, each gives true, sets the chat's wakeups and updated; the same value again gives false and changes nothing, updated too; read by chat on the store and on the reads", async () => {
  const file = newFile()
  const got = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const read = Effect.map(store.chat, (chat) => [chat.wakeups, chat.updated])
    const fresh = yield* read
    const seen = []
    for (const [at, on] of [[1000, false], [2000, false], [3000, true], [4000, true], [5000, false]] as const) {
      yield* TestClock.setTime(at)
      seen.push([on, yield* store.setWakeups(on), ...(yield* read)])
    }
    return { fresh, seen }
  }))
  expect(got.fresh[0]).toBe(true)
  expect(got.seen).toEqual([
    [false, true, false, 1000],
    [false, false, false, 1000],
    [true, true, true, 3000],
    [true, false, true, 3000],
    [false, true, false, 5000]
  ])
  expect(rows(file, "select wakeups, updated from everchat_chat")).toEqual([{ wakeups: 0, updated: 5000 }])
  expect((await withReads(file, Reads.use((reads) => reads.chat))).wakeups).toBe(false)
})

test("wakesOf: the rows that a function call of the program made or stopped, in the order of those calls, each with which and the call; a row made and stopped by one program is given two times; a row made by the program's own call, by another program, or otherwise is not; a function or no call gives none; the same on the reads", async () => {
  const file = newFile()
  const want = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    // Program 1 with its functions 2, 3, 4 and 5; program 6 with its 7.
    const [f1, f2, f3, f4] = yield* functions(store, 4)
    const [g1] = yield* functions(store, 1)
    yield* TestClock.setTime(T0)
    made(yield* store.makeWake({ ...ROUTINE, text: "made by 4, stopped by 5", turn: 1, call: f3! }, 20))
    made(yield* store.makeWake({ ...REMINDER, text: "made by 2", turn: 1, call: f1! }, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "made otherwise, stopped by 3" }, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "made by 7", turn: 2, call: g1! }, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "made by program 1 itself", turn: 1, call: 1 }, 20))
    made(yield* store.makeWake({ ...ROUTINE, text: "stopped by the person" }, 20))
    yield* store.stopWake(3, "unwake", f2!)
    yield* store.stopWake(1, "unwake", f4!)
    yield* store.stopWake(6, "person")
    const all = yield* store.wakes()
    const of = (n: number) => all.find((wake) => wake.id === n)!
    const wants: Record<1 | 6, Array<WakeOf>> = {
      1: [{ wake: of(2), by: "made", call: 2 }, { wake: of(3), by: "stopped", call: 3 }, { wake: of(1), by: "made", call: 4 }, { wake: of(1), by: "stopped", call: 5 }],
      6: [{ wake: of(4), by: "made", call: 7 }]
    }
    return wants
  }))
  const read = (reads: Reading) => Effect.all([1, 6, 2, 5, 7, 99].map((program) => reads.wakesOf(program)))
  const fromStore = await withStore(file, Store.use(read))
  const fromReads = await withReads(file, Reads.use(read))
  expect(fromStore).toEqual([want[1], want[6], [], [], [], []])
  expect(fromReads).toEqual(fromStore)
})

// A turn's ceiling (docs/wakeups.md, sections 3 and 6)
// ----------------------------------------------------

test("startTurn with a ceiling: the turn is given with its steps and tokens by startTurn, turn, turns and runningTurns, on the store and on the reads, and after the store is opened again; a turn started with none has both null, and the ceiling stays when the turn ends", async () => {
  const file = newFile()
  const started = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const wake = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0, steps: 20, tokens: 2_000_000 })
    const person = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const given = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0, steps: null, tokens: null })
    const ended = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0, steps: 1, tokens: Number.MAX_SAFE_INTEGER })
    yield* store.endTurn(ended.id, "stopped", CEILING_WHY)
    return [wake, person, given, ended].map((turn) => [turn.id, turn.steps, turn.tokens])
  }))
  expect(started).toEqual([[1, 20, 2_000_000], [2, null, null], [3, null, null], [4, 1, Number.MAX_SAFE_INTEGER]])
  const want = [[1, 20, 2_000_000], [2, null, null], [3, null, null], [4, 1, Number.MAX_SAFE_INTEGER]]
  const read = (reads: Reading) =>
    Effect.gen(function*() {
      const ceiling = (turn: Turn) => [turn.id, turn.steps, turn.tokens]
      const one = []
      for (const n of [1, 2, 3, 4]) one.push(Option.map(yield* reads.turn(n), ceiling))
      return {
        turn: one,
        turns: (yield* reads.turns(null, 10)).map(ceiling),
        running: (yield* reads.runningTurns(null)).map(ceiling)
      }
    })
  const fromStore = await withStore(file, Store.use(read))
  const fromReads = await withReads(file, Reads.use(read))
  expect(fromStore).toEqual({
    turn: want.map((turn) => Option.some(turn)),
    turns: [...want].reverse(),
    running: want.slice(0, 3)
  })
  expect(fromReads).toEqual(fromStore)
  expect(rows(file, "select n, steps, tokens from everchat_turn order by n")).toEqual(want.map(([n, steps, tokens]) => ({ n, steps, tokens })))
})

test("startTurn refuses a ceiling of steps with no tokens, tokens with no steps, 0, a negative number, a fraction, NaN and Infinity with StoreError before its transaction: no turn, head or pick is written; the next turn takes id 1", async () => {
  const file = newFile()
  const tries: ReadonlyArray<{ readonly steps?: number | null; readonly tokens?: number | null }> = [
    { steps: 20 },
    { steps: 20, tokens: null },
    { tokens: 100 },
    { steps: null, tokens: 100 },
    { steps: 0, tokens: 100 },
    { steps: 20, tokens: 0 },
    { steps: -1, tokens: 100 },
    { steps: 20, tokens: -100 },
    { steps: 1.5, tokens: 100 },
    { steps: 20, tokens: 100.25 },
    { steps: Number.NaN, tokens: 100 },
    { steps: 20, tokens: Number.POSITIVE_INFINITY }
  ]
  const counts = () => rows(file, "select (select count(*) from everchat_turn) as turns, (select count(*) from everchat_head) as heads, (select count(*) from everchat_pick) as picks")[0]
  await withStore(file, Effect.void)
  const before = counts()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const errors = []
    for (const [k, ceiling] of tries.entries()) {
      errors.push(yield* Effect.flip(store.startTurn({ pick: { ...PICK, model: `refused ${k}` }, head: `{"refused":${k}}`, firstMsg: 0, ...ceiling })))
    }
    const after = counts()
    return { errors, after, next: yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0, steps: 20, tokens: 100 }) }
  }))
  expect(got.errors.map((error) => [error instanceof StoreError, error.op])).toEqual(tries.map(() => [true, "startTurn"]))
  expect(got.errors.map((error) => String(error.cause))).toEqual(tries.map((ceiling) =>
    `Error: a turn's ceiling is both steps and tokens, each a whole number over 0, or neither, not ${ceiling.steps ?? null} steps and ${ceiling.tokens ?? null} tokens`
  ))
  expect(got.after).toEqual(before)
  expect([got.next.id, got.next.steps, got.next.tokens]).toEqual([1, 20, 100])
})

// The comparison of the row's states
// ----------------------------------
//
// Two pieces: the page's states of a wake-up (docs/wakeups.md, sections 2
// and 7, with the lead's rulings 2 to 4a of ec-muncvc and 1 to 4 of
// ec-w8sgt0), written below as a model of the rows of a chat with no SQL;
// and the store's members over SQLite. The relation: equal. After each
// step of a seeded sequence, over two chats of one file, each row that
// `wakes()` gives equals the model's row, and `dueWakes(now)`,
// `pendingWake()`, `unsettledWakes()` and the chat's `wakeups` equal the
// model's answers; so do the answers of `pendWake`, `settleWake`,
// `stopWake` and `setWakeups`. The oracle is the model; a `StoreError` in a
// step is a failure too (lead, ec-e75r, D1). Three claims hold after each
// step, on the store's answers: a stopped row is in no answer of
// `dueWakes` and `pendingWake`; a count of failures at `WAKE_FAILURES` is a
// row stopped with why `failed`, unless it stopped before; no row has its
// count to come (`settled` false) with no last turn.
//
// The steps: a make (a routine or a reminder); a `pendWake` of a slot
// before, at and after the row's `slot`, its waiting `pending` and its
// `due`, with a count of 0, 1, 999, 1,000 or 1,001 and a next `due` or
// none, also while the chat is off; a fire of what `pendingWake` gave, as
// an offer writes it (the turn's row, then `fireWake`, in one transaction),
// with or without a `pendWake` of the same row between the read and the
// fire, and while off a fire that the source read before the switch; a
// `settleWake` with each end, of the row's last turn, of another turn, of
// a row not there, and a second time; the end of a turn (done, failed, or
// stopped by its ceiling or the person); a `stopWake` of each kind, with
// and without `unwake`'s call, on an active row, on a stopped one and on
// one not there; `setWakeups` off and on, also to the value it had; and the
// clock moved on or back. The bounds: SEEDS sequences of STEPS steps each
// (100 of 100: 10,000 steps), fixed seeds 1 to 100, in one case with its
// own timeout (BOUND, 120 s); it ran in about 11 s at its writing (junit).
// A failure prints its seed and the whole sequence up to the step that
// failed. It found no disagreement of the model and the store, so it has
// no fixed case of its own; the planted faults that only it finds:
// `pendWake` that keeps the old `due` when a fire waits and the given
// `due` is null (ec-muncvc); `unsettledWakes` in the order of `last_turn`,
// not of the row's id (ec-w8sgt0).

const SEEDS = Array.from({ length: 100 }, (_, k) => 1 + k)
const STEPS = 100
const BOUND = 120_000

// A seeded generator (mulberry32): the same seed, the same sequence.
const seeded = (seed: number) => {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <A>(from: ReadonlyArray<A>): A => from[Math.floor(next() * from.length)]!
  return { next, pick }
}

type Row = { -readonly [K in keyof Wake]: Wake[K] }

// The model of one chat: its switch, the counts of its turns and calls,
// the ends of its turns, the rows whose count of failures reached
// `WAKE_FAILURES` after they had stopped, and its rows.
interface Modeled {
  on: boolean
  turns: number
  calls: number
  readonly ended: Map<number, { readonly status: Turn["status"]; readonly why: string | null }>
  readonly stoppedFirst: Set<number>
  readonly rows: Array<Row>
}

const newModeled = (): Modeled => ({ on: true, turns: 0, calls: 0, ended: new Map(), stoppedFirst: new Set(), rows: [] })

const MISSED_MAX = 1000

// The model's rows as `wakes()` gives them, in the order of their ids.
const modelWakes = (chat: Modeled): Array<Wake> => chat.rows.map((row) => ({ ...row }))

const modelMake = (chat: Modeled, wake: { readonly text: string; readonly cron: string | null; readonly at: number | null; readonly first: number }, now: number): Wake => {
  const row: Row = {
    id: chat.rows.length + 1,
    text: wake.text,
    cron: wake.cron,
    at: wake.at,
    zone: "Europe/Berlin",
    first: wake.first,
    turn: null,
    call: null,
    due: wake.first,
    slot: null,
    pending: null,
    missed: 0,
    fired: 0,
    lastTurn: null,
    settled: true,
    failed: 0,
    stopped: null,
    why: null,
    stopCall: null,
    created: now,
    updated: now
  }
  chat.rows.push(row)
  return { ...row }
}

// The table's row "its slot comes" and "another slot comes before it
// fires" (rulings 2): only an active row of a chat that is on, only a slot
// after `slot` and after the waiting `pending`.
const modelPend = (chat: Modeled, n: number, pend: { readonly pending: number; readonly missed: number; readonly due: number | null }, now: number): boolean => {
  const row = chat.rows.find((one) => one.id === n)
  if (row === undefined || !chat.on || row.stopped !== null) return false
  if (row.slot !== null && pend.pending <= row.slot) return false
  if (row.pending !== null && pend.pending <= row.pending) return false
  row.missed = row.pending === null ? Math.min(pend.missed, MISSED_MAX) : Math.min(row.missed + 1 + pend.missed, MISSED_MAX)
  row.pending = pend.pending
  row.due = pend.due
  row.updated = now
  return true
}

// Ruling 1.
const modelDue = (chat: Modeled, now: number): Array<Wake> =>
  chat.on
    ? chat.rows.filter((row) => row.stopped === null && row.due !== null && row.due <= now).sort((x, y) => x.due! - y.due! || x.id - y.id).map((row) => ({ ...row }))
    : []

// Ruling 3.
const modelPending = (chat: Modeled): Option.Option<Wake> => {
  if (!chat.on) return Option.none()
  const waiting = chat.rows.filter((row) => row.stopped === null && row.settled && row.pending !== null).sort((x, y) => x.pending! - y.pending! || x.id - y.id)
  return waiting.length === 0 ? Option.none() : Option.some({ ...waiting[0]! })
}

// The table's row "the source offers it" (rulings 4 and 4a).
const modelFire = (chat: Modeled, n: number, turn: number, read: { readonly pending: number; readonly missed: number }, now: number) => {
  const row = chat.rows.find((one) => one.id === n)!
  row.slot = read.pending
  row.fired += 1
  row.lastTurn = turn
  row.settled = false
  row.updated = now
  if (row.cron === null) {
    row.stopped = now
    row.why = "fired"
    row.due = null
    row.pending = null
    row.missed = 0
  } else if (row.pending === read.pending) {
    row.pending = null
    row.missed = 0
  } else if (row.missed < MISSED_MAX) {
    row.missed = Math.max(row.missed - read.missed - 1, 0)
  }
}

// The table's rows of the end of `last_turn` (ruling 1 of this bead,
// ec-w8sgt0): only the row's last turn, not counted yet; the count by the
// end; at `WAKE_FAILURES`, an active row stops, with nothing left to fire.
// The switch is not read.
const modelSettle = (chat: Modeled, n: number, turn: number, end: "done" | "failed" | "kept", now: number) => {
  const row = chat.rows.find((one) => one.id === n)
  if (row === undefined || row.lastTurn !== turn || row.settled) return { settled: false, stopped: false }
  row.failed = end === "done" ? 0 : end === "failed" ? row.failed + 1 : row.failed
  row.settled = true
  row.updated = now
  if (row.failed >= WAKE_FAILURES && end === "failed") {
    if (row.stopped !== null) {
      chat.stoppedFirst.add(row.id)
      return { settled: true, stopped: false }
    }
    row.stopped = now
    row.why = "failed"
    row.due = null
    row.pending = null
    row.missed = 0
    return { settled: true, stopped: true }
  }
  return { settled: true, stopped: false }
}

// The table's row "active: unwake, or /wakeups stop" (ruling 3).
const modelStop = (chat: Modeled, n: number, why: "unwake" | "person", call: number | null, now: number): boolean => {
  const row = chat.rows.find((one) => one.id === n)
  if (row === undefined || row.stopped !== null) return false
  row.stopped = now
  row.why = why
  row.stopCall = call
  row.due = null
  row.pending = null
  row.missed = 0
  row.updated = now
  return true
}

// Ruling 4: whether the value changed.
const modelSwitch = (chat: Modeled, on: boolean): boolean => {
  const changed = chat.on !== on
  chat.on = on
  return changed
}

// Ruling 2: the rows not counted, with their last turn's end.
const modelUnsettled = (chat: Modeled): Array<UnsettledWake> =>
  chat.rows.filter((row) => !row.settled).map((row) => ({ wake: { ...row }, ...(chat.ended.get(row.lastTurn!) ?? { status: "running" as const, why: null }) }))

// The checks of section 2, on the model's rows: a model that breaks one is
// wrong, whatever the store says.
const modelChecks = (chat: Modeled): Array<string> =>
  chat.rows.flatMap((row) => {
    const broken: Array<string> = []
    if ((row.cron === null) === (row.at === null)) broken.push("cron or at")
    if (row.at !== null && row.first !== row.at) broken.push("first = at")
    if ((row.stopped === null) !== (row.why === null)) broken.push("stopped and why")
    if (row.stopCall !== null && row.why !== "unwake") broken.push("a stop's call only with unwake")
    if (row.stopped !== null && (row.due !== null || row.pending !== null)) broken.push("a stopped row has nothing to fire")
    if (row.pending !== null && row.slot !== null && !(row.pending > row.slot)) broken.push("pending > slot")
    if (row.lastTurn === null && !row.settled) broken.push("last_turn or settled")
    if (row.missed < 0 || row.fired < 0 || row.failed < 0) broken.push("counts 0 or more")
    return broken.map((check) => `row ${row.id}: ${check}`)
  })

// One sequence: its steps as text, and the first disagreement, if any.
const compareSeed = (seed: number) => {
  const file = newFile()
  const random = seeded(seed)
  const steps: Array<string> = []
  const model: Array<Modeled> = [newModeled(), newModeled()]
  // What the sequence reached, for the case's check of its reach.
  const seen = new Set<string>()
  const run = Effect.gen(function*() {
    const chats = yield* Chats
    const uuids = [yield* chats.make(TENANT_A, PICK), yield* chats.make(TENANT_B, PICK)]
    const stores = [yield* chats.store(TENANT_A, uuids[0]!, LAUNCH), yield* chats.store(TENANT_B, uuids[1]!, LAUNCH)]
    // The two chats are the file's first two: ids 1 and 2.
    const ids = rows<{ id: number }>(file, "select id from everchat_chat order by id").map((row) => row.id)
    if (ids.join() !== "1,2") return `the chats are ${ids.join()}`
    let now = T0
    yield* TestClock.setTime(now)

    // A step of the store that fails is a disagreement (D1).
    const why = (error: unknown): string =>
      error instanceof StoreError ? `${error.op}: ${why(error.cause)}` : `${String(error)}${error instanceof Error && error.cause !== undefined ? ` (${why(error.cause)})` : ""}`
    const step = <A>(effect: Effect.Effect<A, unknown>) =>
      Effect.map(Effect.exit(effect), (exit) => (Exit.isSuccess(exit) ? { ok: true as const, value: exit.value } : { ok: false as const, error: why(Cause.squash(exit.cause)) }))

    // The slots a pendWake may give a row: before, at and after its slot,
    // its waiting pending and its due, and now.
    const slots = (row: Row | undefined) => {
      const bases = [row?.slot, row?.pending, row?.due, now].filter((base): base is number => base !== null && base !== undefined)
      return bases.flatMap((base) => [base - H, base - 1, base, base + 1, base + H])
    }
    const pendOf = (row: Row | undefined) => ({
      pending: random.pick(slots(row)),
      missed: random.pick([0, 1, 999, 1000, 1001]),
      due: random.pick([null, now + H, now + 2 * H, now - H])
    })

    for (let k = 0; k < STEPS; k++) {
      const c = random.pick([0, 1])
      const chat = model[c]!
      const store = stores[c]!
      const kind = random.pick(["make", "pend", "pend", "pend", "fire", "fire", "fire", "settle", "settle", "end", "stop", "switch", "clock"] as const)
      if (kind === "make" && chat.rows.length < 4) {
        const routine = random.next() < 0.5
        const first = now + random.pick([-2 * H, -H, 0, H, 3 * H])
        const wake = { text: `${c}.${chat.rows.length + 1}`, cron: routine ? "0 * * * *" : null, at: routine ? null : first, first }
        steps.push(`chat ${c + 1}: makeWake(${JSON.stringify(wake)}) at ${now - T0}`)
        seen.add(routine ? "a routine made" : "a reminder made")
        const got = yield* step(store.makeWake({ ...wake, zone: "Europe/Berlin" }, 20))
        const want = modelMake(chat, wake, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (!Equal(got.value, { _tag: "made", wake: want })) return `makeWake gave ${JSON.stringify(got.value)}, the model ${JSON.stringify(want)}`
      } else if (kind === "pend" || kind === "make") {
        const n = 1 + Math.floor(random.next() * (chat.rows.length + 1))
        const row = chat.rows.find((one) => one.id === n)
        const pend = pendOf(row)
        steps.push(`chat ${c + 1}: pendWake(${n}, ${JSON.stringify({ ...pend, pending: pend.pending - T0 })} from T0) at ${now - T0}`)
        const waited = row?.pending !== null && row?.pending !== undefined
        const got = yield* step(store.pendWake(n, pend))
        const want = modelPend(chat, n, pend, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (got.value !== want) return `pendWake gave ${got.value}, the model ${want}`
        seen.add(want ? (waited ? "a slot taken while a fire waits" : "a slot taken") : "a slot refused")
        if (!chat.on && row !== undefined && row.stopped === null) seen.add("a slot refused while off")
        if (want && row!.missed === MISSED_MAX) seen.add("missed at the bound")
      } else if (kind === "fire") {
        const read = yield* step(store.pendingWake())
        if (!read.ok) return `a StoreError: ${read.error}`
        // While off, the source reads none; a fire that it read before the
        // switch still comes (fireWake does not read the switch).
        const late = chat.rows.filter((row) => row.stopped === null && row.settled && row.pending !== null)
        if (Option.isNone(read.value) && (chat.on || late.length === 0 || random.next() < 0.5)) {
          steps.push(`chat ${c + 1}: pendingWake() gave none`)
          if (!chat.on && late.length > 0) seen.add("a fire waits while off")
          continue
        }
        const given = Option.isSome(read.value) ? read.value.value : random.pick(late)
        const handed = { pending: given.pending!, missed: given.missed }
        if (Option.isNone(read.value)) {
          steps.push(`chat ${c + 1}: pendingWake() gave none; the source read ${given.id} ${JSON.stringify({ ...handed, pending: handed.pending - T0 })} from T0 before the switch went off`)
          seen.add("a fire while off")
        } else steps.push(`chat ${c + 1}: pendingWake() gave ${given.id} ${JSON.stringify({ ...handed, pending: handed.pending - T0 })} from T0`)
        if (random.next() < 0.5) {
          const pend = pendOf(chat.rows.find((one) => one.id === given.id))
          steps.push(`chat ${c + 1}: between the read and the fire, pendWake(${given.id}, ${JSON.stringify({ ...pend, pending: pend.pending - T0 })} from T0)`)
          const got = yield* step(store.pendWake(given.id, pend))
          const want = modelPend(chat, given.id, pend, now)
          if (!got.ok) return `a StoreError: ${got.error}`
          if (got.value !== want) return `pendWake gave ${got.value}, the model ${want}`
          if (want) seen.add("a newer slot between the read and the fire")
        }
        steps.push(`chat ${c + 1}: the offer: startTurn, fireWake(${given.id}) at ${now - T0}`)
        const got = yield* step(store.transaction(Effect.gen(function*() {
          const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
          yield* store.fireWake(given.id, turn.id, handed)
          return turn.id
        })))
        if (!got.ok) return `a StoreError: ${got.error}`
        chat.turns += 1
        if (got.value !== chat.turns) return `the offer's turn is ${got.value}, the model's ${chat.turns}`
        const row = chat.rows.find((one) => one.id === given.id)!
        seen.add(row.cron === null ? "a reminder fired" : row.pending === handed.pending ? "a fire went" : "a fire went, a newer one waits")
        modelFire(chat, given.id, chat.turns, handed, now)
      } else if (kind === "settle") {
        // Mostly a row that fired, with its last turn; else another turn
        // (an older one, one of no fire, one not there), or a row that is
        // not there. A row settled already is a second settle.
        const fired = chat.rows.filter((row) => row.lastTurn !== null)
        const row = fired.length === 0 || random.next() < 0.1 ? undefined : random.pick(fired)
        const n = row?.id ?? 1 + Math.floor(random.next() * (chat.rows.length + 1))
        const turn = row !== undefined && random.next() < 0.8 ? row.lastTurn! : 1 + Math.floor(random.next() * (chat.turns + 1))
        const end = random.pick(["done", "failed", "failed", "failed", "kept"] as const)
        const was = chat.rows.find((one) => one.id === n)
        const before = was === undefined ? undefined : { ...was }
        steps.push(`chat ${c + 1}: settleWake(${n}, ${turn}, ${end}) at ${now - T0}`)
        const got = yield* step(store.settleWake(n, turn, end))
        const want = modelSettle(chat, n, turn, end, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (!Equal(got.value, want)) return `settleWake gave ${JSON.stringify(got.value)}, the model ${JSON.stringify(want)}`
        if (!want.settled) {
          seen.add(before !== undefined && before.lastTurn === turn && before.settled ? "a second settle refused" : "a settle refused")
        } else {
          seen.add(`an end counted: ${end}`)
          if (want.stopped) seen.add(before!.pending !== null ? "a stop at two failures, a fire waiting" : "a stop at two failures")
          if (before!.stopped !== null) seen.add(chat.stoppedFirst.has(n) ? "two failures of a stopped row, its why kept" : "an end of a stopped row counted")
          if (!chat.on) seen.add("an end counted while off")
        }
      } else if (kind === "end") {
        // A turn of the chat ends (a second end changes nothing).
        if (chat.turns === 0) continue
        const turn = 1 + Math.floor(random.next() * chat.turns)
        const { status, why } = random.pick([
          { status: "done", why: null },
          { status: "failed", why: "the model failed" },
          { status: "stopped", why: CEILING_WHY },
          { status: "stopped", why: "Stopped." }
        ] as const)
        steps.push(`chat ${c + 1}: endTurn(${turn}, ${status}, ${why}) at ${now - T0}`)
        const got = yield* step(store.endTurn(turn, status, why))
        if (!got.ok) return `a StoreError: ${got.error}`
        if (!chat.ended.has(turn)) chat.ended.set(turn, { status, why })
        seen.add("a turn ended")
      } else if (kind === "stop") {
        // Half the time a row whose end is not counted (a stop between a
        // fire and its settle), else any number.
        const open = chat.rows.filter((row) => !row.settled && row.stopped === null)
        const n = open.length > 0 && random.next() < 0.5 ? random.pick(open).id : 1 + Math.floor(random.next() * (chat.rows.length + 1))
        const why = random.pick(["unwake", "person"] as const)
        // `unwake`'s call, mostly, in a turn that runs (a call starts only
        // in one).
        let call: number | null = null
        const running = Array.from({ length: chat.turns }, (_, k) => k + 1).filter((turn) => !chat.ended.has(turn))
        if (why === "unwake" && running.length > 0 && random.next() < 0.7) {
          const turn = random.pick(running)
          steps.push(`chat ${c + 1}: startCall in turn ${turn}`)
          const made = yield* step(store.startCall({ turn, vendorId: `call_${chat.calls + 1}`, fn: "run", input: "unwake" }))
          if (!made.ok) return `a StoreError: ${made.error}`
          chat.calls += 1
          if (made.value !== chat.calls) return `the call is ${made.value}, the model's ${chat.calls}`
          call = made.value
        }
        const was = chat.rows.find((one) => one.id === n)
        const waited = was !== undefined && was.pending !== null
        steps.push(`chat ${c + 1}: stopWake(${n}, ${why}, ${call}) at ${now - T0}`)
        const got = yield* step(store.stopWake(n, why, call))
        const want = modelStop(chat, n, why, call, now)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (got.value !== want) return `stopWake gave ${got.value}, the model ${want}`
        seen.add(want ? `a stop by ${why}${call === null ? "" : " with its call"}${waited ? ", a fire waiting" : ""}` : "a stop refused")
      } else if (kind === "switch") {
        const on = random.pick([true, false])
        steps.push(`chat ${c + 1}: setWakeups(${on})`)
        const got = yield* step(store.setWakeups(on))
        const want = modelSwitch(chat, on)
        if (!got.ok) return `a StoreError: ${got.error}`
        if (got.value !== want) return `setWakeups gave ${got.value}, the model ${want}`
        seen.add(want ? (on ? "on" : "off") : "a switch to the value it had")
      } else {
        const by = random.pick([-2 * H, -1, 1, H, 3 * H])
        now += by
        seen.add(by < 0 ? "the clock back" : "the clock on")
        steps.push(`the clock moves to ${now - T0} from T0`)
        yield* TestClock.setTime(now)
      }
      const broken = model.flatMap((one, m) => modelChecks(one).map((check) => `chat ${m + 1}, the model: ${check}`))
      if (broken.length > 0) return broken.join("; ")
      // Each chat's rows, due rows, waiting fire, rows not counted and
      // switch, against the model.
      for (const [m, one] of model.entries()) {
        const s = stores[m]!
        const got = yield* step(Effect.all({
          wakes: s.wakes(),
          due: s.dueWakes(now),
          pending: s.pendingWake(),
          unsettled: s.unsettledWakes(),
          on: Effect.map(s.chat, (chat) => chat.wakeups)
        }))
        if (!got.ok) return `a StoreError: ${got.error}`
        const want = { wakes: modelWakes(one), due: modelDue(one, now), pending: modelPending(one), unsettled: modelUnsettled(one), on: one.on }
        if (want.due.length > 0) seen.add("rows due")
        if (want.unsettled.some((row) => row.status !== "running")) seen.add("a row not counted, its turn ended")
        for (const what of ["wakes", "due", "pending", "unsettled", "on"] as const) {
          if (!Equal(got.value[what], want[what])) {
            return `chat ${m + 1}, ${what}: the store gave ${JSON.stringify(got.value[what])}, the model ${JSON.stringify(want[what])}`
          }
        }
        // The claims that hold after each step, on the store's answers: a
        // stopped row is in no answer of dueWakes or pendingWake; a count of
        // failures at WAKE_FAILURES is a row stopped, why failed, unless it
        // stopped before; no row waits for a count with no last turn.
        const pending = Option.toArray(got.value.pending)
        if ([...got.value.due, ...pending].some((wake) => wake.stopped !== null)) return `chat ${m + 1}: a stopped row is due or waits`
        for (const wake of got.value.wakes) {
          if (wake.failed >= WAKE_FAILURES && (wake.stopped === null || (wake.why !== "failed" && !one.stoppedFirst.has(wake.id)))) {
            return `chat ${m + 1}: row ${wake.id} has ${wake.failed} failures, stopped ${wake.stopped}, why ${wake.why}`
          }
          if (!wake.settled && wake.lastTurn === null) return `chat ${m + 1}: row ${wake.id} is not settled, with no last turn`
          if (wake.failed >= WAKE_FAILURES) seen.add(wake.why === "failed" ? "a row stopped by two failures" : "a row at two failures that stopped before")
        }
      }
    }
    return null
  })
  return Effect.runPromise(run.pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(chatsLayer(file)))).then((disagreement) => ({ steps, disagreement, seen }))
}

// Deep equality, as `toEqual` reads it.
const Equal = (x: unknown, y: unknown): boolean => Bun.deepEquals(x, y)

test(`the comparison: the page's states of a wake-up (a model with no SQL) and the store's members over SQLite agree after each step of ${SEEDS.length} seeded sequences of ${STEPS} steps over two chats: wakes, dueWakes, pendingWake, unsettledWakes, the chat's switch and the answers of pendWake, settleWake, stopWake and setWakeups, with no StoreError; a stopped row is never due or waiting, two failures are a stop, and no row waits for a count with no last turn`, async () => {
  const reached = new Set<string>()
  for (const seed of SEEDS) {
    const { steps, disagreement, seen } = await compareSeed(seed)
    for (const one of seen) reached.add(one)
    expect(disagreement, `seed ${seed}, its ${steps.length} steps:\n${steps.join("\n")}`).toBeNull()
  }
  // The sequences reach each kind of step and each branch of the table.
  expect([...reached].sort()).toEqual([
    "a fire waits while off",
    "a fire went",
    "a fire went, a newer one waits",
    "a fire while off",
    "a newer slot between the read and the fire",
    "a reminder fired",
    "a reminder made",
    "a routine made",
    "a row at two failures that stopped before",
    "a row not counted, its turn ended",
    "a row stopped by two failures",
    "a second settle refused",
    "a settle refused",
    "a slot refused",
    "a slot refused while off",
    "a slot taken",
    "a slot taken while a fire waits",
    "a stop at two failures",
    "a stop at two failures, a fire waiting",
    "a stop by person",
    "a stop by person, a fire waiting",
    "a stop by unwake",
    "a stop by unwake with its call",
    "a stop by unwake with its call, a fire waiting",
    "a stop by unwake, a fire waiting",
    "a stop refused",
    "a switch to the value it had",
    "a turn ended",
    "an end counted while off",
    "an end counted: done",
    "an end counted: failed",
    "an end counted: kept",
    "an end of a stopped row counted",
    "missed at the bound",
    "off",
    "on",
    "rows due",
    "the clock back",
    "the clock on",
    "two failures of a stopped row, its why kept"
  ])
}, BOUND)

// The tag of a deployment
// -----------------------

// Two tenants of a hosted deployment, by their UUIDs.
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
const LAUNCH = options().launch

// A UUID of the file's hex, as text.
const asUuid = (hex: string) => {
  const h = hex.toLowerCase()
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-")
}

test("Chats: two tenants with a chat each in one file", async () => {
  const file = newFile()
  const made = await withChats(file, Effect.gen(function*() {
    const chats = yield* Chats
    const a = yield* chats.make(TENANT_A, PICK)
    const b = yield* chats.make(TENANT_B, { ...PICK, model: "gpt-other" })
    const storeA = yield* chats.store(TENANT_A, a, LAUNCH)
    const storeB = yield* chats.store(TENANT_B, b, LAUNCH)
    const readsA = yield* chats.reads(TENANT_A, a)
    return {
      a,
      b,
      seen: [(yield* storeA.chat).uuid, (yield* storeB.chat).uuid, (yield* readsA.chat).uuid],
      models: [(yield* storeA.chat).pick.model, (yield* storeB.chat).pick.model]
    }
  }))
  expect(made.a).not.toBe(made.b)
  expect(made.seen).toEqual([made.a, made.b, made.a])
  expect(made.models).toEqual(["gpt-test", "gpt-other"])
  const { chats, tenants } = owners(file)
  expect(tenants.map((tenant) => asUuid(tenant.id)).sort()).toEqual([TENANT_A, TENANT_B])
  expect(chats.map((chat) => [asUuid(chat.tenant), asUuid(chat.uuid)]).sort()).toEqual([[TENANT_A, made.a], [TENANT_B, made.b]])
})

test("Chats: store and reads with tenant A and the UUID of B's chat fail with NoChat, equal in every field to a UUID that no chat has and a text that is no UUID", async () => {
  const file = newFile()
  const failures = await withChats(file, Effect.gen(function*() {
    const chats = yield* Chats
    const a = yield* chats.make(TENANT_A, PICK)
    const b = yield* chats.make(TENANT_B, PICK)
    // The tenant and the chat that each call names.
    const asked: ReadonlyArray<readonly [string, string]> = [
      [TENANT_A, b], // B's chat
      [TENANT_A, crypto.randomUUID()], // no chat has it
      [TENANT_A, "not a uuid"], // no UUID
      [TENANT_A, a.toUpperCase() + "0"], // no UUID: one digit too many
      [crypto.randomUUID(), a], // a tenant that is not there
      [TENANT_B, a] // A's chat, asked by B
    ]
    const got: Array<unknown> = []
    for (const [tenant, chat] of asked) {
      got.push(yield* Effect.flip(chats.store(tenant, chat, LAUNCH)))
      got.push(yield* Effect.flip(chats.reads(tenant, chat)))
    }
    return got
  }))
  expect(failures).toHaveLength(12)
  const shape = (error: unknown) => ({
    isNoChat: error instanceof NoChat,
    tag: (error as NoChat)._tag,
    message: (error as NoChat).message,
    keys: Object.keys(error as object),
    json: JSON.stringify(error),
    text: String(error)
  })
  const first = shape(failures[0])
  expect(first).toEqual({
    isNoChat: true,
    tag: "NoChat",
    message: "This tenant has no chat with this UUID.",
    keys: ["_tag"],
    json: "{\"_tag\":\"NoChat\"}",
    text: "NoChat: This tenant has no chat with this UUID."
  })
  for (const failure of failures) expect(shape(failure)).toEqual(first)
  // A store that was refused took no launch.
  expect(launches(file)).toEqual([])
})

test("Chats: make for a tenant that is there makes no second tenant's row", async () => {
  const file = newFile()
  const made = await withChats(file, Effect.gen(function*() {
    const chats = yield* Chats
    return [yield* chats.make(TENANT_A, PICK), yield* chats.make(TENANT_A, PICK)]
  }))
  const { chats, tenants } = owners(file)
  expect(tenants.map((tenant) => asUuid(tenant.id))).toEqual([TENANT_A])
  expect(chats.map((chat) => asUuid(chat.uuid)).sort()).toEqual([...made].sort())
  expect(chats.every((chat) => asUuid(chat.tenant) === TENANT_A)).toBe(true)
  // A tenant that is no UUID makes nothing.
  const refused = await withChats(file, Effect.flip(Chats.use((chats) => chats.make("not a uuid", PICK))))
  expect(refused).toBeInstanceOf(StoreError)
  expect(owners(file).chats).toHaveLength(2)
})

test("Chats: two stores of two chats, open at the same time, each with its own launch, write and read their own rows", async () => {
  const file = newFile()
  const seen = await withChats(file, Effect.gen(function*() {
    const chats = yield* Chats
    const a = yield* chats.store(TENANT_A, yield* chats.make(TENANT_A, PICK), LAUNCH)
    const b = yield* chats.store(TENANT_B, yield* chats.make(TENANT_B, PICK), LAUNCH)
    const say = (store: typeof a, text: string) => store.append([{ kind: "user", text, line: null, turn: null, call: null }])
    // The writes interleave: a, b, a, b.
    yield* say(a, "a 1")
    yield* say(b, "b 1")
    const turnA = yield* a.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    yield* say(b, "b 2")
    const turnB = yield* b.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    yield* say(a, "a 2")
    yield* a.addDiagnostics([{ level: "info", source: "test", text: "from a", created: 1 }])
    yield* b.addDiagnostics([{ level: "info", source: "test", text: "from b", created: 1 }])
    const of = (store: typeof a) =>
      Effect.gen(function*() {
        return {
          launch: store.launch.id,
          texts: (yield* store.messages(0, 10)).map((message) => message.text),
          turns: (yield* store.turns(null, 10)).map((turn) => turn.id),
          diagnostics: (yield* store.diagnostics()).map((line) => line.text),
          launches: (yield* store.launches(10)).map((launch) => [launch.id, launch.ended])
        }
      })
    return { a: yield* of(a), b: yield* of(b), turns: [turnA.id, turnB.id] }
  }))
  expect(seen.turns).toEqual([1, 1])
  expect(seen.a).toEqual({ launch: 1, texts: ["a 1", "a 2"], turns: [1], diagnostics: ["from a"], launches: [[1, null]] })
  expect(seen.b).toEqual({ launch: 1, texts: ["b 1", "b 2"], turns: [1], diagnostics: ["from b"], launches: [[1, null]] })
  // Two launch rows, one for each chat, both ended with the scope.
  expect(rows(file, "select chat, n, why from everchat_launch order by chat")).toEqual([
    { chat: 1, n: 1, why: "exit" },
    { chat: 2, n: 1, why: "exit" }
  ])
})

test("Chats: the local layers still make one tenant and one chat, and the tag finds that chat", async () => {
  const file = newFile()
  const uuid = await withStore(file, Store.use((store) => Effect.map(store.chat, (chat) => chat.uuid)))
  const { chats, tenants } = owners(file)
  expect([tenants.length, chats.length]).toEqual([1, 1])
  const tenant = asUuid(tenants[0]!.id)
  // The tag finds the local chat by its tenant and its UUID, and its store
  // takes the next launch of the file.
  const found = await withChats(file, Effect.gen(function*() {
    const chats = yield* Chats
    const store = yield* chats.store(tenant, uuid, LAUNCH)
    return [(yield* store.chat).uuid, store.launch.id, (yield* (yield* chats.reads(tenant, uuid)).chat).uuid]
  }))
  expect(found).toEqual([uuid, 2, uuid])
  await withStore(file, Effect.void)
  expect(owners(file)).toEqual({ chats, tenants })
  expect(launches(file).map((launch) => launch.id)).toEqual([1, 2, 3])
})

// A load that is cancelled
// ------------------------

const TENANT_C = "55555555-5555-4555-8555-555555555555"

// The launches of `file`, through a second connection, read-only, while the
// store's own connection is open.
const observed = (observer: Sqlite) =>
  observer.query("select chat, n, ended is not null as ended, why from everchat_launch order by chat, n").all() as Array<
    { chat: number; n: number; ended: number; why: string | null }
  >

// The opening of a store, in a scope of its own that stays open, in a fiber
// that yields after every `ops` operations, so that a test can interrupt it
// between two of its steps.
const opening = (chats: typeof Chats.Service, chat: string, ops: number) =>
  Effect.forkChild(
    chats.store(TENANT_C, chat, LAUNCH).pipe(
      Effect.andThen(Effect.never),
      Effect.scoped,
      Effect.provideService(Scheduler.MaxOpsBeforeYield, ops)
    )
  )

test("Chats: an opening interrupted after its launch is visible to a second connection ends that launch as signal", async () => {
  // The case of the review ec-dhlup (F1). The opening fiber yields every 64
  // operations, and this fiber polls the file between its yields: it
  // interrupts at the first yield after the commit shows, the window
  // between the commit and the registration of the launch's end that the
  // old `open` left. With the end registered at the commit, any point
  // after it gives `signal`.
  const file = newFile()
  await withChats(file, Effect.gen(function*() {
    const chats = yield* Chats
    const chat = yield* chats.make(TENANT_C, PICK)
    const observer = new Sqlite(file, { readonly: true })
    try {
      const worker = yield* opening(chats, chat, 64)
      let visible = false
      for (let k = 0; k < 2000 && !visible; k++) {
        visible = observed(observer).length > 0
        if (!visible) yield* Effect.yieldNow
      }
      yield* Fiber.interrupt(worker)
      expect(visible).toBe(true)
      const launches = observed(observer)
      expect(launches).toEqual([{ chat: 1, n: 1, ended: 1, why: "signal" }])
    } finally {
      observer.close()
    }
  }))
})

test("Chats: an opening interrupted before its commit leaves no row of everchat_launch, and its wait for the connection is interruptible", async () => {
  // The window is sure: another transaction holds the store's one
  // connection, so the opening waits for it, before its first write, until
  // the interruption.
  const file = newFile()
  const layer = chatsLayerNoDatabase.pipe(Layer.provideMerge(Database.layer(file)))
  await Effect.runPromise(Effect.gen(function*() {
    const chats = yield* Chats
    const sql = yield* SqlClient.SqlClient
    const chat = yield* chats.make(TENANT_C, PICK)
    const release = yield* Deferred.make<void>()
    const held = yield* Deferred.make<void>()
    const holder = yield* Effect.forkChild(sql.withTransaction(Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))))
    yield* Deferred.await(held)
    const worker = yield* opening(chats, chat, 64)
    yield* Effect.sleep("50 millis")
    // Still waiting: it has not ended.
    expect(worker.pollUnsafe()).toBeUndefined()
    const stopped = yield* Fiber.interrupt(worker).pipe(Effect.timeoutOption("2 seconds"))
    expect(Option.isSome(stopped)).toBe(true)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    const observer = new Sqlite(file, { readonly: true })
    try {
      expect(observed(observer)).toEqual([])
    } finally {
      observer.close()
    }
  }).pipe(Effect.provide(layer)))
})

test("Chats: an opening interrupted at any point leaves no launch, or one that ended as signal; never one that is live", async () => {
  // Each round interrupts a new opening after k yields of this fiber, with
  // the opening yielding every 8 operations: the rounds cover the points
  // before the transaction, inside it, at the commit, and after the store
  // is made. Whatever the point, a closed scope leaves no live launch and
  // no crash.
  const file = newFile()
  const outcomes = await withChats(file, Effect.gen(function*() {
    const chats = yield* Chats
    const observer = new Sqlite(file, { readonly: true })
    const seen: Array<string> = []
    try {
      for (let k = 0; k < 120; k++) {
        const chat = yield* chats.make(TENANT_C, PICK)
        const id = (observer.query("select max(id) as id from everchat_chat").get() as { id: number }).id
        const worker = yield* opening(chats, chat, 8)
        for (let y = 0; y < k; y++) yield* Effect.yieldNow
        yield* Fiber.interrupt(worker)
        const launches = observed(observer).filter((launch) => launch.chat === id)
        seen.push(
          launches.length === 0 ? "none" : launches.length === 1 && launches[0]!.ended === 1 && launches[0]!.why === "signal" ? "signal" : JSON.stringify(launches)
        )
      }
    } finally {
      observer.close()
    }
    return seen
  }))
  expect(outcomes.filter((outcome) => outcome !== "none" && outcome !== "signal")).toEqual([])
  // The rounds reach both sides of the commit.
  expect(outcomes[0]).toBe("none")
  expect(outcomes.at(-1)).toBe("signal")
})

// Events
// ------

const eventRows = (file: string) =>
  rows(file, "select chat, n, type, turn, call, msg, msg_last as msgLast from everchat_event order by n")

test("addEvent: three events get 1, 2, 3 with no gap, seq is 3, and the chat's updated moved to the last one's time", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const before = (yield* store.chat).updated
    // The next millisecond at least, so that a move of `updated` shows.
    yield* Effect.sleep("5 millis")
    const numbers = [
      yield* store.addEvent({ type: "start", turn: turn.id }),
      yield* store.transaction(store.addEvent({ type: "end", turn: turn.id })),
      yield* store.addEvent({ type: "start", turn: turn.id })
    ]
    return { before, numbers, after: (yield* store.chat).updated }
  }))
  expect(got.numbers).toEqual([1, 2, 3])
  expect(rows(file, "select n from everchat_event order by n")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  const [chat] = rows<{ seq: number; updated: number }>(file, "select seq, updated from everchat_chat")
  const [last] = rows<{ created: number }>(file, "select created from everchat_event where n = 3")
  expect(chat!.seq).toBe(3)
  expect(chat!.updated).toBeGreaterThan(got.before)
  expect(chat!.updated).toBe(last!.created)
  expect(got.after).toBe(chat!.updated)
})

test("addEvent: each type's row holds what the union gives, and null for the rest", async () => {
  // The type refuses a row that section 7 does not have: a message's row
  // copies no turn.
  // @ts-expect-error: a `message` row has no turn
  const refused: NewEvent = { type: "message", msg: 0, msgLast: 0, turn: 1 }
  expect(refused.type).toBe("message")
  const file = newFile()
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const said = yield* store.append([{ kind: "user", text: "one" }, { kind: "user", text: "two" }, { kind: "asst", text: "three" }])
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const call = yield* store.startCall({ turn: turn.id, vendorId: "v1", fn: "run", input: "1" })
    yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[1]!.i })
    yield* store.addEvent({ type: "start", turn: turn.id })
    yield* store.addEvent({ type: "call", turn: turn.id, call })
    yield* store.addEvent({ type: "message", msg: said[2]!.i, msgLast: said[2]!.i })
    yield* store.addEvent({ type: "end", turn: turn.id })
  }))
  expect(eventRows(file)).toEqual([
    { chat: 1, n: 1, type: "accepted", turn: null, call: null, msg: 0, msgLast: 1 },
    { chat: 1, n: 2, type: "start", turn: 1, call: null, msg: null, msgLast: null },
    { chat: 1, n: 3, type: "call", turn: 1, call: 1, msg: null, msgLast: null },
    { chat: 1, n: 4, type: "message", turn: null, call: null, msg: 2, msgLast: 2 },
    { chat: 1, n: 5, type: "end", turn: 1, call: null, msg: null, msgLast: null }
  ])
})

test("addEvent: an event whose last message the chat does not have is refused, and the next event takes the next number, with no gap", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const said = yield* store.append([{ kind: "user", text: "one" }])
    const first = yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[0]!.i })
    const before = rows(file, "select seq, updated from everchat_chat")
    yield* Effect.sleep("5 millis")
    // Message 1 is not there: only the reference of msg_last refuses it.
    const refused = yield* Effect.flip(store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[0]!.i + 1 }))
    const message = yield* Effect.flip(store.addEvent({ type: "message", msg: said[0]!.i, msgLast: said[0]!.i + 1 }))
    const after = rows(file, "select seq, updated from everchat_chat")
    const next = yield* store.addEvent({ type: "message", msg: said[0]!.i, msgLast: said[0]!.i })
    return { first, refused, message, before, after, next }
  }))
  expect(got.refused).toBeInstanceOf(StoreError)
  expect(got.message).toBeInstanceOf(StoreError)
  // The store's error carries the driver's: its text is SQLite's.
  for (const error of [got.refused, got.message]) {
    expect(String((error.cause as { reason?: { cause?: unknown } }).reason?.cause)).toContain("FOREIGN KEY")
  }
  expect(got.after).toEqual(got.before)
  expect([got.first, got.next]).toEqual([1, 2])
  expect(eventRows(file)).toEqual([
    { chat: 1, n: 1, type: "accepted", turn: null, call: null, msg: 0, msgLast: 0 },
    { chat: 1, n: 2, type: "message", turn: null, call: null, msg: 0, msgLast: 0 }
  ])
  expect(rows(file, "select seq from everchat_chat")).toEqual([{ seq: 2 }])
})

test("addEvent: a transaction that fails after addEvent leaves no row, and seq and updated as they were", async () => {
  const file = newFile()
  const failed = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    yield* store.addEvent({ type: "start", turn: turn.id })
    const before = rows(file, "select seq, updated from everchat_chat")
    yield* Effect.sleep("5 millis")
    const error = yield* Effect.flip(store.transaction(Effect.gen(function*() {
      yield* store.addEvent({ type: "end", turn: turn.id })
      yield* store.endTurn(turn.id, "done")
      return yield* Effect.fail("no" as const)
    })))
    return { error, before, after: rows(file, "select seq, updated from everchat_chat"), status: Option.map(yield* store.turn(turn.id), (t) => t.status) }
  }))
  expect(failed.error).toBe("no")
  expect(failed.after).toEqual(failed.before)
  expect(failed.after).toEqual([{ seq: 1, updated: expect.any(Number) }])
  expect(failed.status).toEqual(Option.some("running"))
  expect(eventRows(file).map((row) => row.n)).toEqual([1])
})

test("addEvent: one interrupted at any point, with no transaction of the caller's, leaves no row or its whole event; the chat's rows of everchat_event are its seq, and the next event takes seq + 1", async () => {
  // addEvent is a transaction of its own: its row and the chat's new `seq`
  // go together. Each round forks a new addEvent in a fiber that yields
  // after every three operations (`MaxOpsBeforeYield` 3, the least that
  // lets it run one), and interrupts it after `k` yields of this fiber, from
  // 0 on: the rounds reach each of its yields (before its transaction,
  // between its select, its insert and its update, at the commit and after
  // it), until a round in which it ends before the interruption. The
  // statements of bun:sqlite run in one operation, so the points are the
  // same in each run. After each round a second connection reads the chat's
  // events and its `seq`, and the next addEvent of this fiber takes
  // `seq + 1`. Without its transaction, a round stops it between its
  // insert and its update, and leaves the row `n` with `seq` at `n - 1`.
  const file = newFile()
  const rounds = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append([{ kind: "user", text: "one" }])
    const event = store.addEvent({ type: "message", msg: 0, msgLast: 0 })
    const observer = new Sqlite(file, { readonly: true })
    const state = () => ({
      events: (observer.query("select n from everchat_event order by n").all() as Array<{ n: number }>).map((row) => row.n),
      seq: (observer.query("select seq from everchat_chat").get() as { seq: number }).seq
    })
    const rounds: Array<{ k: number; ended: boolean; before: number; events: Array<number>; seq: number; next: number }> = []
    try {
      for (let k = 0; k < 1000; k++) {
        const before = state().seq
        const worker = yield* Effect.forkChild(event.pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)))
        for (let y = 0; y < k; y++) yield* Effect.yieldNow
        yield* Fiber.interrupt(worker)
        const exit = yield* Fiber.await(worker)
        const after = state()
        const next = yield* event
        rounds.push({ k, ended: Exit.isSuccess(exit), before, ...after, next })
        if (Exit.isSuccess(exit)) break
      }
    } finally {
      observer.close()
    }
    return rounds
  }))
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k)
  // Each round: the events run from 1 to seq with no gap, the interrupted
  // addEvent wrote its whole event or nothing, and the next one is seq + 1.
  expect(rounds.filter((round) => round.events.join() !== range(1, round.seq).join() || round.seq - round.before > 1 || round.next !== round.seq + 1))
    .toEqual([])
  // The rounds reach both sides of the commit: the first stops it before
  // its transaction, many stop it inside, which writes nothing, some stop
  // it after its commit, and the last lets it end.
  const interrupted = rounds.filter((round) => !round.ended)
  expect(rounds[0]).toMatchObject({ ended: false, before: 0, seq: 0 })
  expect(interrupted.filter((round) => round.seq === round.before).length).toBeGreaterThan(20)
  expect(interrupted.filter((round) => round.seq === round.before + 1).length).toBeGreaterThan(0)
  expect(rounds.at(-1)).toMatchObject({ ended: true })
  expect(rounds.at(-1)!.seq).toBe(rounds.at(-1)!.before + 1)
})

// The events, read again
// ----------------------

// Writes `rounds` rounds of the five types of event through the store's own
// members, each in the transaction of what it reports, as the turn loop
// writes them: a turn starts, two messages of the person are accepted, a
// program starts, a reply is in the log, and the turn ends. Five events
// each round.
const story = (store: typeof Store.Service, rounds: number) =>
  Effect.gen(function*() {
    for (let r = 1; r <= rounds; r++) {
      const turn = yield* store.transaction(Effect.gen(function*() {
        const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: yield* store.count })
        yield* store.addEvent({ type: "start", turn: turn.id })
        return turn.id
      }))
      yield* store.transaction(Effect.gen(function*() {
        const said = yield* store.append([{ kind: "user", text: `one ${r}`, turn }, { kind: "user", text: `two ${r}`, turn }])
        yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[1]!.i })
      }))
      yield* store.transaction(Effect.gen(function*() {
        const call = yield* store.startCall({ turn, vendorId: `v${r}`, fn: "run", input: `program ${r}` })
        yield* store.addEvent({ type: "call", turn, call })
      }))
      yield* store.transaction(Effect.gen(function*() {
        const [reply] = yield* store.append([{ kind: "asst", text: `reply ${r}`, turn }])
        yield* store.addEvent({ type: "message", msg: reply!.i, msgLast: reply!.i })
      }))
      yield* store.transaction(Effect.andThen(store.endTurn(turn, r % 2 === 0 ? "failed" : "done", r % 2 === 0 ? `why ${r}` : null), store.addEvent({ type: "end", turn })))
    }
  })

test("eventsAfter: the five types come back with what each reports, in the order of their numbers", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* story(store, 2)
    return { events: yield* store.eventsAfter(0, 1000), messages: yield* store.messages(0, 100) }
  }))
  const [m0, m1, m2, m3, m4, m5] = got.messages
  expect(got.events).toEqual([
    { type: "start", n: 1, turn: 1 },
    { type: "accepted", n: 2, messages: [m0!, m1!] },
    { type: "call", n: 3, turn: 1, call: 1, program: "program 1" },
    { type: "message", n: 4, message: m2! },
    { type: "end", n: 5, turn: 1, status: "done", why: null },
    { type: "start", n: 6, turn: 2 },
    { type: "accepted", n: 7, messages: [m3!, m4!] },
    { type: "call", n: 8, turn: 2, call: 2, program: "program 2" },
    { type: "message", n: 9, message: m5! },
    { type: "end", n: 10, turn: 2, status: "failed", why: "why 2" }
  ])
  expect(got.messages.map((message) => message.text)).toEqual(["one 1", "two 1", "reply 1", "one 2", "two 2", "reply 2"])
})

test("eventsAfter: after the last event number gives none, and so does a number past it", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* story(store, 1)
    return { last: yield* store.eventsAfter(4, 1000), at: yield* store.eventsAfter(5, 1000), past: yield* store.eventsAfter(6, 1000) }
  }))
  expect(got.last.map((event) => event.n)).toEqual([5])
  expect(got.at).toEqual([])
  expect(got.past).toEqual([])
})

test("eventsAfter: limit cuts at exactly that count, and the next read from the last number continues with no gap and no repeat", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* story(store, 3)
    const whole = yield* store.eventsAfter(0, 1000)
    const parts: Array<Array<number>> = []
    const read: Array<unknown> = []
    let after = 0
    for (;;) {
      const part = yield* store.eventsAfter(after, 4)
      if (part.length === 0) break
      parts.push(part.map((event) => event.n))
      read.push(...part)
      after = part.at(-1)!.n
    }
    return { whole, parts, read, one: yield* store.eventsAfter(7, 1) }
  }))
  expect(got.whole.map((event) => event.n)).toEqual(Array.from({ length: 15 }, (_, k) => k + 1))
  expect(got.parts).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15]])
  expect(got.read).toEqual(got.whole)
  expect(got.one).toEqual([got.whole[7]!])
})

test("eventsAfter: an after or a limit out of its range is a defect that names the field, and the edges of each range pass", async () => {
  const file = newFile()
  const BAD = [0.5, -1, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY]
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* story(store, 1)
    const defect = (after: number, limit: number) =>
      Effect.map(Effect.exit(store.eventsAfter(after, limit)), (exit) =>
        Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause) ? String(Cause.squash(exit.cause)) : "no defect")
    return {
      after: yield* Effect.forEach(BAD, (after) => defect(after, 10)),
      limit: yield* Effect.forEach([...BAD, 0, 1001], (limit) => defect(0, limit)),
      edges: [
        (yield* store.eventsAfter(0, 1)).length,
        (yield* store.eventsAfter(0, 1000)).length,
        (yield* store.eventsAfter(Number.MAX_SAFE_INTEGER, 1000)).length
      ]
    }
  }))
  expect(got.after).toHaveLength(5)
  expect(got.after.filter((text) => !/^Error: eventsAfter: after must be an integer from 0, and it is /.test(text))).toEqual([])
  expect(got.limit).toHaveLength(7)
  expect(got.limit.filter((text) => !/^Error: eventsAfter: limit must be an integer from 1 to 1000, and it is /.test(text))).toEqual([])
  expect(got.edges).toEqual([1, 5, 0])
})

test("the chat's seq is 0 for a new chat, with no event to read, and then the count of its events, on the store and on the reads", async () => {
  const file = newFile()
  const fresh = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    return { seq: (yield* store.chat).seq, events: yield* store.eventsAfter(0, 1000) }
  }))
  expect(fresh).toEqual({ seq: 0, events: [] })
  const written = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* story(store, 2)
    return { seq: (yield* store.chat).seq, last: (yield* store.eventsAfter(0, 1000)).at(-1)!.n }
  }))
  const reads = await withReads(file, Effect.gen(function*() {
    const reads = yield* Reads
    return (yield* reads.chat).seq
  }))
  const [count] = rows<{ n: number }>(file, "select count(*) as n from everchat_event")
  expect(count!.n).toBe(10)
  expect(written).toEqual({ seq: 10, last: 10 })
  expect(reads).toBe(10)
})

// The key of a message's sender
// ------------------------------

// A message of the person as the turn loop logs it: its pages with the key
// on the first, and its `accepted` event, in one transaction. Its
// `accepted` number.
const keyedSay = (store: typeof Store.Service, texts: ReadonlyArray<string>, key: string | null) =>
  store.transaction(Effect.gen(function*() {
    const said = yield* store.append(texts.map((text, k) => ({ kind: "user" as const, text, more: k < texts.length - 1 })), key)
    return yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[said.length - 1]!.i })
  }))

// The counts of the chat's messages and events, and its seq.
const counts = (file: string) =>
  rows<{ messages: number; events: number; seq: number }>(
    file,
    "select (select count(*) from everchat_msg) as messages, (select count(*) from everchat_event) as events, (select seq from everchat_chat) as seq"
  )[0]

test("keyed: a message of three pages with a key gives its pages and its accepted number; the key is on its first row only", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* story(store, 1)
    const accepted = yield* keyedSay(store, ["page one", "page two", "page three"], "key-3-pages")
    yield* keyedSay(store, ["after it"], null)
    return { accepted, keyed: yield* store.keyed("key-3-pages"), pages: yield* store.messages(3, 6) }
  }))
  expect(got.accepted).toBe(6)
  expect(got.keyed).toEqual(Option.some({ messages: got.pages, accepted: 6 }))
  expect(got.pages.map((page) => [page.i, page.text, page.more])).toEqual([[3, "page one", true], [4, "page two", true], [5, "page three", false]])
  expect(rows(file, "select i, sender_key from everchat_msg where i >= 3 order by i")).toEqual([
    { i: 3, sender_key: "key-3-pages" },
    { i: 4, sender_key: null },
    { i: 5, sender_key: null },
    { i: 6, sender_key: null }
  ])
})

test("keyed: a message with no key has null, and the key of no message gives none, on the store and on the reads", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* keyedSay(store, ["no key"], null)
    yield* keyedSay(store, ["a key"], "key-one")
    return { unknown: yield* store.keyed("key-none"), cased: yield* store.keyed("KEY-ONE"), one: yield* store.keyed("key-one") }
  }))
  expect(got.unknown).toEqual(Option.none())
  expect(got.cased).toEqual(Option.none())
  expect(Option.map(got.one, (one) => [one.messages.map((page) => page.text), one.accepted])).toEqual(Option.some([["a key"], 2]))
  expect(rows(file, "select i, sender_key from everchat_msg order by i")).toEqual([{ i: 0, sender_key: null }, { i: 1, sender_key: "key-one" }])
  const reads = await withReads(file, Effect.gen(function*() {
    const reads = yield* Reads
    return { one: yield* reads.keyed("key-one"), unknown: yield* reads.keyed("key-none") }
  }))
  expect(reads.unknown).toEqual(Option.none())
  expect(Option.map(reads.one, (one) => one.accepted)).toEqual(Option.some(2))
})

test("keyed: the same key twice in one chat: the second write fails with StoreError, and the counts of messages and events are as before it", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* keyedSay(store, ["first", "its second page"], "key-twice")
    const before = { count: yield* store.count, seq: (yield* store.chat).seq }
    const error = yield* Effect.flip(keyedSay(store, ["second", "its second page"], "key-twice"))
    const alone = yield* Effect.flip(store.append([{ kind: "user", text: "alone" }], "key-twice"))
    return { before, error, alone, count: yield* store.count, seq: (yield* store.chat).seq, keyed: yield* store.keyed("key-twice") }
  }))
  expect(got.error).toBeInstanceOf(StoreError)
  expect(got.alone).toBeInstanceOf(StoreError)
  expect(got.alone.op).toBe("append")
  expect(String((got.alone.cause as { reason: { cause: unknown } }).reason.cause)).toContain("UNIQUE constraint failed: everchat_msg.chat, everchat_msg.sender_key")
  expect({ count: got.count, seq: got.seq }).toEqual(got.before)
  expect(counts(file)).toEqual({ messages: 2, events: 1, seq: 1 })
  expect(Option.map(got.keyed, (one) => [one.messages.map((page) => page.text), one.accepted])).toEqual(Option.some([["first", "its second page"], 1]))
})

test("keyed: two keys that differ in letter case are two messages", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* keyedSay(store, ["small"], "key-case")
    yield* keyedSay(store, ["large"], "KEY-CASE")
    yield* keyedSay(store, ["mixed"], "Key-Case")
    return yield* Effect.forEach(["key-case", "KEY-CASE", "Key-Case"], (key) => store.keyed(key))
  }))
  expect(got.map((one) => Option.map(one, (it) => [it.messages[0]!.text, it.accepted]))).toEqual([
    Option.some(["small", 1]),
    Option.some(["large", 2]),
    Option.some(["mixed", 3])
  ])
})

test("keyed: a key of 129 bytes, an empty one, one with a space, one with a byte under 0x21 or over 0x7E, and a key with no message are refused, and nothing is written; 1 and 128 bytes from ! to ~ pass", async () => {
  const file = newFile()
  const bad = ["k".repeat(129), "", "key one", "key\tone", "key\x7fone", "kéy", "key\u{1F600}", "\x20", "key\none"]
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const refused = yield* Effect.forEach(bad, (key) => Effect.flip(keyedSay(store, ["refused", "page two"], key)))
    const empty = yield* Effect.flip(store.append([], "key-of-nothing"))
    const after = { count: yield* store.count, seq: (yield* store.chat).seq }
    yield* keyedSay(store, ["edges"], "!".repeat(64) + "~".repeat(64))
    yield* keyedSay(store, ["one byte"], "~")
    yield* keyedSay(store, ["the range"], Array.from({ length: 94 }, (_, k) => String.fromCharCode(0x21 + k)).join(""))
    return { refused, empty, after, keys: yield* Effect.forEach(["!".repeat(64) + "~".repeat(64), "~"], (key) => store.keyed(key)) }
  }))
  expect(got.refused.map((error) => [error instanceof StoreError, error.op])).toEqual(bad.map(() => [true, "append"]))
  expect(got.refused.map((error) => String(error.cause))).toEqual(bad.map(() => "Error: the sender's key is not 1 to 128 bytes of visible ASCII"))
  expect([got.empty instanceof StoreError, String(got.empty.cause)]).toEqual([true, "Error: the sender's key has no message"])
  expect(got.after).toEqual({ count: 0, seq: 0 })
  expect(got.keys.map(Option.isSome)).toEqual([true, true])
  expect(rows(file, "select i, length(sender_key) as bytes from everchat_msg order by i")).toEqual([{ i: 0, bytes: 128 }, { i: 1, bytes: 1 }, { i: 2, bytes: 94 }])
})

test("keyed: an update of a message's key is refused by the table", async () => {
  const file = newFile()
  await withStore(file, Store.use((store) => keyedSay(store, ["a key"], "key-fixed")))
  expect(() => write(file, "update everchat_msg set sender_key = 'key-other' where i = 0")).toThrow("everchat_msg is append only")
  expect(() => write(file, "update everchat_msg set sender_key = null where i = 0")).toThrow("everchat_msg is append only")
  expect(rows(file, "select sender_key from everchat_msg")).toEqual([{ sender_key: "key-fixed" }])
})

test("keyed: a keyed append after an append that ended with more 1 fails with StoreError and writes nothing; the same append with no key passes, and a key after the message's last page passes", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append([{ kind: "user", text: "page one", more: true }])
    const before = counts(file)
    const keyed = yield* Effect.flip(keyedSay(store, ["not a start"], "key-continued"))
    const alone = yield* Effect.flip(store.append([{ kind: "user", text: "not a start" }], "key-continued"))
    const after = counts(file)
    const plain = yield* store.append([{ kind: "user", text: "page two" }])
    const later = yield* keyedSay(store, ["a start"], "key-continued")
    return { before, keyed, alone, after, plain, later, found: yield* store.keyed("key-continued") }
  }))
  for (const error of [got.keyed, got.alone]) {
    expect(error).toBeInstanceOf(StoreError)
    expect([(error as StoreError).op, String((error as StoreError).cause)]).toEqual(["append", "Error: the sender's key is not at a message's start"])
  }
  expect(got.before).toEqual({ messages: 1, events: 0, seq: 0 })
  expect(got.after).toEqual(got.before)
  expect(got.plain.map((message) => [message.i, message.text, message.more])).toEqual([[1, "page two", false]])
  expect(got.later).toBe(1)
  expect(Option.map(got.found, (one) => [one.messages.map((page) => [page.i, page.text]), one.accepted])).toEqual(Option.some([[[2, "a start"]], 1]))
  expect(rows(file, "select i, more, sender_key from everchat_msg order by i")).toEqual([
    { i: 0, more: 1, sender_key: null },
    { i: 1, more: 0, sender_key: null },
    { i: 2, more: 0, sender_key: "key-continued" }
  ])
})

test("keyed: an event of another type whose msg is the keyed message's first page is not its accepted: keyed gives the accepted number", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const accepted = yield* keyedSay(store, ["the message", "its second page"], "key-typed")
    const other = yield* store.addEvent({ type: "message", msg: 0, msgLast: 1 })
    return { accepted, other, keyed: yield* store.keyed("key-typed") }
  }))
  expect([got.accepted, got.other]).toEqual([1, 2])
  expect(rows(file, "select n, type, msg from everchat_event order by n")).toEqual([{ n: 1, type: "accepted", msg: 0 }, { n: 2, type: "message", msg: 0 }])
  expect(Option.map(got.keyed, (one) => one.accepted)).toEqual(Option.some(1))
})

// `only` (sqlite.ts): a statement that must give one row and gives two is a
// defect, whose message holds the count. The file's guards give no such
// rows, so the test drops one in its own file: the unique index of the
// key (chat, sender_key). A second keyed append then writes the key again,
// and the first statement of `keyed` gives two rows.
test("keyed: a statement that must give one row and gives two is a defect with the count: with the key's unique index dropped in the test's file, a second message with the key makes keyed die", async () => {
  const file = newFile()
  await withStore(file, Store.use((store) => keyedSay(store, ["first"], "key-two-rows")))
  write(file, "drop index everchat_msg_sender_key")
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* keyedSay(store, ["second"], "key-two-rows")
    return yield* Effect.exit(store.keyed("key-two-rows"))
  }))
  expect(rows(file, "select i from everchat_msg where sender_key = 'key-two-rows' order by i")).toEqual([{ i: 0 }, { i: 1 }])
  expect(Exit.isFailure(got) && Cause.hasDies(got.cause) && !Cause.hasFails(got.cause) ? String(Cause.squash(got.cause)) : "no defect").toBe(
    "Error: the store expected one row and got 2"
  )
})

// The limit store
// ---------------
// Each call of the store ends, done or with `StoreError`, within the limit
// `store` (database.ts): on SQLite, the driver's wait on a locked file. The
// cases give a small limit; a second connection of the test, on the test's
// own file, holds the lock or a read.

const LIMIT = 200
const limited = (file: string) => storeLayer(file, options(), { store: LIMIT })

// The test's own connections, which `traced` (below) does not record.
const ours = new WeakSet<Sqlite>()

// A second connection that holds the file's write lock, with a write of its
// own that it has not committed.
const holdLock = (file: string) => {
  const other = new Sqlite(file)
  ours.add(other)
  other.run("begin immediate")
  other.run("update everchat_chat set goal = 'held'")
  return other
}

// The time of `effect`, in milliseconds, and its error or its value.
const timedError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const start = performance.now()
    const error = yield* Effect.flip(effect)
    return { error, ms: performance.now() - start }
  })
const timedValue = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const start = performance.now()
    const value = yield* effect
    return { value, ms: performance.now() - start }
  })

// The bounds of database.ts are sums of the waits on the file; the time of
// the scheduler, of a process's start and of the statements themselves is
// on top. So a case gives a wait `SLACK` ms over its bound, and a wait that
// fails `CLOCK` ms under `store` (the tolerance of a clock, and of two
// processes' clocks).
const SLACK = 1000
const CLOCK = 2

// A call that waited for the lock: `StoreError` with its `op`, after
// `store` and before `store` + `SLACK`.
const waitedLimit = (got: { readonly error: unknown; readonly ms: number }, op: string) => {
  expect(got.error).toBeInstanceOf(StoreError)
  expect((got.error as StoreError).op).toBe(op)
  expect(got.ms).toBeGreaterThanOrEqual(LIMIT - CLOCK)
  expect(got.ms).toBeLessThan(LIMIT + SLACK)
}

test("the limit store: under a write lock that another connection holds, a write waits for store, fails with StoreError and writes nothing", async () => {
  const file = newFile()
  const got = await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    const other = holdLock(file)
    const write = yield* timedError(store.setGoal("mine"))
    const append = yield* timedError(store.append([{ kind: "user", text: "mine" }]))
    other.run("rollback")
    other.close()
    return { write, append, goal: (yield* store.chat).goal, count: yield* store.count }
  }).pipe(Effect.provide(limited(file))))
  waitedLimit(got.write, "setGoal")
  waitedLimit(got.append, "append")
  expect(got.goal).toBeNull()
  expect(got.count).toBe(0)
  expect(rows(file, "select count(*) as n from everchat_msg")).toEqual([{ n: 0 }])
})

test("the limit store: a transaction waits at its start (BEGIN IMMEDIATE): under a held lock its body never runs, and it fails with StoreError after store", async () => {
  const file = newFile()
  const got = await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    let ran = 0
    const body = Effect.gen(function*() {
      ran += 1
      yield* store.setGoal("in the transaction")
      yield* store.append([{ kind: "user", text: "in the transaction" }])
    })
    const other = holdLock(file)
    const failed = yield* timedError(store.transaction(body))
    other.run("rollback")
    other.close()
    return { failed, ran, goal: (yield* store.chat).goal, count: yield* store.count }
  }).pipe(Effect.provide(limited(file))))
  waitedLimit(got.failed, "transaction")
  expect(got.ran).toBe(0)
  expect(got.goal).toBeNull()
  expect(got.count).toBe(0)
})

test("the limit store: when the lock is free again, the next call of the same store runs at once: a write, a transaction and a snapshot", async () => {
  const file = newFile()
  const got = await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    const other = holdLock(file)
    const failed = yield* timedError(store.setGoal("mine"))
    other.run("rollback")
    other.close()
    yield* store.setGoal("next")
    yield* store.transaction(store.append([{ kind: "user", text: "next" }]))
    const snapshot = yield* store.snapshot(store.chat)
    return { failed, goal: snapshot.goal, count: yield* store.count }
  }).pipe(Effect.provide(limited(file))))
  waitedLimit(got.failed, "setGoal")
  // Each of the three calls waited for no lock, and that is proved with no
  // clock: the lock is free before the first, and no other connection has
  // the file open, so a wait could end only at store, with StoreError, and
  // the run would fail. The write and the transaction ran (the goal, the
  // count). No bound of time is put on them: a write's time is the disk's,
  // and on a loaded machine that is not short.
  expect(got.goal).toBe("next")
  expect(got.count).toBe(1)
})

test("the limit store: each layer over a file refuses a store of 0 at its start, with StoreError (open)", async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  const refused = await Promise.all([
    Effect.runPromise(Effect.flip(Effect.void.pipe(Effect.provide(storeLayer(file, options(), { store: 0 }))))),
    Effect.runPromise(Effect.flip(Effect.void.pipe(Effect.provide(chatsLayer(file, { store: 0 }))))),
    Effect.runPromise(Effect.flip(Effect.void.pipe(Effect.provide(readsLayer(file, { store: 0 })))))
  ])
  for (const error of refused) {
    expect(error).toBeInstanceOf(StoreError)
    expect(error._tag === "StoreError" ? [error.op, String(error.cause)] : null).toEqual(["open", "RangeError: the limit store is a whole number of milliseconds from 1 to 2147483647, not 0"])
  }
})

// The other waits of a call (database.ts, the table of waits). Each ends
// within store, but the open's (below, within 3 × store) and the wait for
// the one connection (the last case).

test("the limit store: the reads' connection waits for no writer: under a held write lock it opens, reads and takes a snapshot at once, and sees the last commit", async () => {
  const file = newFile()
  await withStore(file, Store.use((store) => store.setGoal("committed")))
  const other = holdLock(file)
  try {
    const got = await Effect.runPromise(timedValue(Effect.gen(function*() {
      const reads = yield* Reads
      return [(yield* reads.chat).goal, (yield* reads.snapshot(reads.chat)).goal, yield* reads.count]
    })).pipe(Effect.provide(readsLayer(file, { store: LIMIT }))))
    expect(got.value).toEqual(["committed", "committed", 0])
    expect(got.ms).toBeLessThan(LIMIT)
    // The writer commits: the next read sees it, at once.
    other.run("commit")
    const after = await Effect.runPromise(timedValue(Reads.use((reads) => reads.chat)).pipe(Effect.provide(readsLayer(file, { store: LIMIT }))))
    expect(after.value.goal).toBe("held")
    expect(after.ms).toBeLessThan(LIMIT)
  } finally {
    other.close()
  }
})

test("the limit store: on the store's own connection a snapshot waits for the lock as a write does, and a read outside it does not", async () => {
  const file = newFile()
  const got = await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    const other = holdLock(file)
    const snapshot = yield* timedError(store.snapshot(store.chat))
    const read = yield* timedValue(store.chat)
    other.run("rollback")
    other.close()
    return { snapshot, read }
  }).pipe(Effect.provide(limited(file))))
  waitedLimit(got.snapshot, "snapshot")
  expect(got.read.value.goal).toBeNull()
  expect(got.read.ms).toBeLessThan(LIMIT)
})

test("the limit store: a commit waits for no reader: while another connection holds a read, a write of the store commits at once, and the reader keeps its state", async () => {
  const file = newFile()
  const got = await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    const reader = new Sqlite(file, { readonly: true })
    reader.run("begin")
    const before = reader.query("select goal from everchat_chat").all()
    yield* store.transaction(Effect.gen(function*() {
      yield* store.setGoal("written")
      yield* store.append([{ kind: "user", text: "written" }])
    }))
    const during = reader.query("select goal from everchat_chat").all()
    reader.run("commit")
    const after = reader.query("select goal from everchat_chat").all()
    reader.close()
    return { before, during, after }
  }).pipe(Effect.provide(limited(file))))
  // The commit waited for no reader, and that is proved with no clock: the
  // reader holds its read until the write has returned, and SQLite's wait
  // holds the test's thread, so a wait could end only at store, with
  // StoreError, and the run would fail. The reader kept its state while the
  // write committed (`during`), and sees the write after its read (`after`).
  // No bound of time is put on the write: its time is the disk's, and on a
  // loaded machine that is not short.
  expect(got.before).toEqual([{ goal: null }])
  expect(got.during).toEqual([{ goal: null }])
  expect(got.after).toEqual([{ goal: "written" }])
})

test("the limit store: the open of a store waits for the lock: under a held write lock it fails with StoreError (open) after store, and opens when the lock is free", async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  const other = holdLock(file)
  const got = await Effect.runPromise(timedError(Effect.void.pipe(Effect.provide(limited(file)))))
  other.run("rollback")
  other.close()
  waitedLimit(got, "open")
  expect(launches(file).length).toBe(1)
  await Effect.runPromise(Effect.void.pipe(Effect.provide(limited(file))))
  expect(launches(file).length).toBe(2)
})

// The open's waits (database.ts, the table of waits). On a file that is not
// yet in WAL mode three statements of the open can each wait on the file
// for store, one after the other: the check's BEGIN IMMEDIATE, its COMMIT
// (in a rollback journal a commit waits for a reader) and the change to
// WAL. The cases below name the statement that waits: `traced` gives each
// statement that the store's connections ran, with its time.

// A file of the store, with one launch, put back in a rollback journal
// (DELETE mode), as another tool can leave it.
const rollbackFile = async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  write(file, "pragma journal_mode = delete")
  return file
}

// A connection of the test that holds a read of `file` until `end`: a
// shared lock in a rollback journal, a snapshot in WAL mode.
const holdRead = (file: string) => {
  const reader = new Sqlite(file, { readonly: true })
  ours.add(reader)
  reader.run("begin")
  reader.query("select count(*) as n from everchat_chat").all()
  return {
    end: () => {
      reader.run("commit")
      reader.close()
    }
  }
}

// The time now, in milliseconds since 1970, on the clock that the test's
// process and a holder's share.
const now = () => performance.timeOrigin + performance.now()

// A statement that a connection of the store ran: its text, its time in
// milliseconds, whether it passed, and its start and end (`now`).
interface Ran {
  readonly sql: string
  readonly ms: number
  readonly ok: boolean
  readonly start: number
  readonly end: number
}

// The trace that runs now, and the statements that `traced` has wrapped.
let tracing: {
  readonly ran: Array<Ran>
  readonly before: Map<string, () => void>
  readonly after: Map<string, () => void>
} | undefined
const wrapped = new WeakSet<object>()

// What a trace does around the statements of the store: `before[sql]` runs
// once, right before the first run of the statement `sql` (so a holder is
// told that the statement starts); `after[sql]` runs once, right after the
// first run of `sql` that passed (so a test's lock starts between two
// statements of the open).
interface Hooks {
  readonly before?: Readonly<Record<string, () => void>>
  readonly after?: Readonly<Record<string, () => void>>
}

// Runs `body`, and gives its value and the statements that the store's
// connections ran while it ran. The driver prepares each statement with
// Bun's `query`, and runs it with `all` or `values`.
const traced = async <A>(hooks: Hooks, body: () => Promise<A>) => {
  const native = Sqlite.prototype.query
  const trace = { ran: new Array<Ran>(), before: new Map(Object.entries(hooks.before ?? {})), after: new Map(Object.entries(hooks.after ?? {})) }
  Sqlite.prototype.query = function(this: Sqlite, sql: string) {
    const statement = native.call(this, sql)
    if (!ours.has(this) && !wrapped.has(statement)) {
      wrapped.add(statement)
      const methods = statement as unknown as Record<"all" | "values", (...args: Array<unknown>) => unknown>
      for (const name of ["all", "values"] as const) {
        const run = methods[name]
        methods[name] = function(this: unknown, ...args: Array<unknown>) {
          const first = tracing?.before.get(sql)
          if (first !== undefined) {
            tracing?.before.delete(sql)
            first()
          }
          const start = now()
          let ok = false
          try {
            const result = run.apply(this, args)
            ok = true
            return result
          } finally {
            const end = now()
            const trace = tracing
            if (trace !== undefined) {
              trace.ran.push({ sql, ms: end - start, ok, start, end })
              const then = ok ? trace.after.get(sql) : undefined
              if (then !== undefined) {
                trace.after.delete(sql)
                then()
              }
            }
          }
        }
      }
    }
    return statement
  } as typeof native
  tracing = trace
  try {
    return { value: await body(), ran: trace.ran }
  } finally {
    tracing = undefined
    Sqlite.prototype.query = native
  }
}

// The first run of the statement `sql` in `ran`.
const first = (ran: ReadonlyArray<Ran>, sql: string) => {
  const found = ran.find((statement) => statement.sql === sql)
  expect(found).toBeDefined()
  return found as Ran
}

// The statements of the open that wait on the file (database.ts).
const BEGIN = "BEGIN IMMEDIATE"
const COMMIT = "COMMIT"
const WAL = "pragma journal_mode = wal"

// A statement that waited for a holder's lock and then passed: it started
// before the holder let the lock go (`released`, on the holder's clock) and
// ended after it, within store and `SLACK`. One that did not wait: it
// passed within `NO_WAIT` ms. One that waited and failed: after store
// (less `CLOCK`), before store and `SLACK`.
const NO_WAIT = 50
const waitedAndPassed = (statement: Ran, released: number | undefined) => {
  expect(released).toBeDefined()
  expect(statement.ok).toBe(true)
  expect(statement.start).toBeLessThan(released as number)
  expect(statement.end).toBeGreaterThanOrEqual((released as number) - CLOCK)
  expect(statement.ms).toBeLessThan(LIMIT + SLACK)
}
const noWait = (statement: Ran) => {
  expect(statement.ok).toBe(true)
  expect(statement.ms).toBeLessThan(NO_WAIT)
}
const waitedAndFailed = (statement: Ran) => {
  expect(statement.ok).toBe(false)
  expect(statement.ms).toBeGreaterThanOrEqual(LIMIT - CLOCK)
  expect(statement.ms).toBeLessThan(LIMIT + SLACK)
}

// The program of another process that holds locks on a file: a write
// reservation (BEGIN IMMEDIATE) and a read, each when its time is given
// (HOLD_WRITE, HOLD_READ). It holds each lock until the test tells it that
// the statement that is to wait for it starts (the word: a file `write` or
// `read` in HOLD_DIR), and then for its time, counted from the word; so the
// wait is there for the statement to make, whatever the time of the
// holder's own start. It says when it lets each lock go, on the clock that
// the test shares (`<lock> released <time>`), and then it ends. With no
// word in 10 s it lets the lock go and says `<lock> untold`. A lock of the
// test's own process could not end while the open waits: SQLite's wait
// holds the process's thread.
const HOLDER = `
const { Database } = require("bun:sqlite")
const fs = require("node:fs")
const file = process.env.HOLD_FILE
const now = () => performance.timeOrigin + performance.now()
const hold = (name, ms, take) => {
  if (ms === "") return
  const db = new Database(file)
  take(db)
  const word = process.env.HOLD_DIR + "/" + name
  const start = now()
  const poll = setInterval(() => {
    const told = fs.existsSync(word)
    if (!told && now() - start < 10000) return
    clearInterval(poll)
    setTimeout(() => {
      const at = now()
      db.run("rollback")
      db.close()
      console.log(told ? name + " released " + at : name + " untold")
    }, told ? Number(ms) : 0)
  }, 1)
}
hold("write", process.env.HOLD_WRITE, (db) => db.run("begin immediate"))
hold("read", process.env.HOLD_READ, (db) => { db.run("begin"); db.query("select count(*) as n from everchat_chat").all() })
console.log("held")
`

// The locks of a holder, and when it let each go (`now`).
type Lock = "write" | "read"
type Released = Partial<Record<Lock, number>>

// Starts the holder on `file`, and waits until it holds its locks. `tell`
// gives it the word of a lock (from the hook `before` of a statement).
// `end` waits for its end (it ends it if it still runs after 2 s), and
// gives when it let each lock go.
const holdElsewhere = async (file: string, hold: Readonly<Partial<Record<Lock, number>>>) => {
  const words = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-hold-"))
  const child = Bun.spawn([process.execPath, "-e", HOLDER], {
    env: { ...process.env, HOLD_FILE: file, HOLD_DIR: words, HOLD_WRITE: String(hold.write ?? ""), HOLD_READ: String(hold.read ?? "") },
    stdout: "pipe",
    stderr: "inherit"
  })
  const reader = child.stdout.getReader()
  let said = ""
  const read = async (until: (text: string) => boolean) => {
    while (!until(said)) {
      const { done, value } = await reader.read()
      if (done) break
      said += new TextDecoder().decode(value)
    }
  }
  await read((text) => text.includes("\n"))
  if (said !== "held\n") {
    child.kill()
    await child.exited
    throw new Error(`the holder said ${JSON.stringify(said)}, not that it holds`)
  }
  const tell = (lock: Lock) => fs.writeFileSync(path.join(words, lock), "")
  const end = async (): Promise<Released> => {
    const timer = setTimeout(() => child.kill(), 2000)
    await read(() => false)
    await child.exited
    clearTimeout(timer)
    fs.rmSync(words, { recursive: true, force: true })
    const released: Record<string, number> = {}
    for (const line of said.split("\n")) {
      const [lock, word, at] = line.split(" ")
      if (word === "released") released[lock as string] = Number(at)
    }
    return released
  }
  return { tell, end }
}

// Runs `body` with a holder on `file`; gives its value and when the holder
// let each lock go. The holder is gone when it returns.
const withHolder = async <A>(
  file: string,
  hold: Readonly<Partial<Record<Lock, number>>>,
  body: (tell: (lock: Lock) => void) => Promise<A>
) => {
  const other = await holdElsewhere(file, hold)
  const value = await body(other.tell).catch(async (error: unknown) => {
    await other.end()
    throw error
  })
  return { value, released: await other.end() }
}

// The open of the store over `file`, timed, and its error.
const failedOpen = (file: string) => Effect.runPromise(timedError(Effect.void.pipe(Effect.provide(limited(file)))))

// The bytes of `file`, and of its journal and its WAL when it has them.
const bytes = (file: string) =>
  ["", "-journal", "-wal"].map((suffix) => (fs.existsSync(file + suffix) ? Array.from(fs.readFileSync(file + suffix)) : null))

// The schema of `file`: each object of `sqlite_master`, by its name.
const objects = (file: string) => rows(file, "select type, name, tbl_name, sql from sqlite_master order by name")

test("the limit store: the open's commit of its check, on a file in a rollback journal that another connection reads, waits at the COMMIT: StoreError (open) after store, the change to WAL never runs, and the file is as it was", async () => {
  const file = await rollbackFile()
  const before = bytes(file)
  const reader = holdRead(file)
  const got = await traced({}, () => failedOpen(file)).finally(reader.end)
  waitedLimit(got.value, "open")
  noWait(first(got.ran, BEGIN))
  waitedAndFailed(first(got.ran, COMMIT))
  expect(got.ran.filter((statement) => statement.sql === WAL)).toEqual([])
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "delete" }])
  expect(launches(file).length).toBe(1)
  // A file that had its schema keeps its bytes.
  expect(bytes(file)).toEqual(before)
})

test("the limit store: the open's change to WAL, of a file in a rollback journal that a connection starts to read right after the check's commit, waits at pragma journal_mode = wal: StoreError (open) after store, and the file is as it was", async () => {
  const file = await rollbackFile()
  const before = bytes(file)
  let reader: { readonly end: () => void } | undefined
  const got = await traced({ after: { [COMMIT]: () => reader = holdRead(file) } }, () => failedOpen(file)).finally(() => reader?.end())
  expect(reader).toBeDefined()
  waitedLimit(got.value, "open")
  noWait(first(got.ran, BEGIN))
  noWait(first(got.ran, COMMIT))
  waitedAndFailed(first(got.ran, WAL))
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "delete" }])
  expect(launches(file).length).toBe(1)
  // A file that had its schema keeps its bytes.
  expect(bytes(file)).toEqual(before)
})

test("the limit store: the first open of a new file, whose change to WAL waits for a reader that starts right after the check's commit: StoreError (open) after store; the file keeps the schema and the mark of this version, in a rollback journal, with no launch and no message; the next open writes no schema and changes it to WAL", async () => {
  const file = newFile()
  expect(fs.existsSync(file)).toBe(false)
  let reader: { readonly end: () => void } | undefined
  const got = await traced({ after: { [COMMIT]: () => reader = holdRead(file) } }, () => failedOpen(file)).finally(() => reader?.end())
  expect(reader).toBeDefined()
  waitedLimit(got.value, "open")
  noWait(first(got.ran, BEGIN))
  expect(got.ran.filter((statement) => statement.sql.startsWith("create ")).length).toBeGreaterThan(0)
  // The commit waited for no lock, and that is proved with no clock: no
  // other connection has the file open until the reader starts, in the hook
  // after the commit (`reader` is defined only if the commit passed), so a
  // wait could end only at store and fail the commit; and the commit
  // passed. The commit writes the whole schema, so its time is the disk's
  // (410 ms seen at a load of 24): no bound of time is put on it.
  expect(first(got.ran, COMMIT).ok).toBe(true)
  waitedAndFailed(first(got.ran, WAL))
  // What the failed open left: the schema and the mark, committed by the
  // check, in the journal mode of a new file; no row of a launch or a chat.
  const made = newFile()
  await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer(made))))
  expect(rows(file, "pragma user_version")).toEqual([{ user_version: VERSION }])
  expect(objects(file)).toEqual(objects(made))
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "delete" }])
  expect(launches(file)).toEqual([])
  expect(rows(file, "select count(*) as n from everchat_chat")).toEqual([{ n: 0 }])
  expect(rows(file, "select count(*) as n from everchat_msg")).toEqual([{ n: 0 }])
  // The reader is gone: the next open finds the mark, writes no schema, and
  // changes the file to WAL; its launch is the file's first.
  const again = await traced({}, () => Effect.runPromise(timedValue(Effect.void.pipe(Effect.provide(limited(file))))))
  expect(again.ran.filter((statement) => statement.sql.startsWith("create ") || statement.sql.startsWith("pragma user_version ="))).toEqual([])
  expect(first(again.ran, WAL).ok).toBe(true)
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "wal" }])
  expect(objects(file)).toEqual(objects(made))
  expect(launches(file).length).toBe(1)
})

test("the limit store: the whole open, on a file in a rollback journal, waits two times in a row: at its BEGIN IMMEDIATE for another process's write of 100 ms, then at its COMMIT for a reader; it ends with StoreError (open) within 3 × store", async () => {
  const file = await rollbackFile()
  const reader = holdRead(file)
  try {
    const { value: got, released } = await withHolder(
      file,
      { write: 100 },
      (tell) => traced({ before: { [BEGIN]: () => tell("write") } }, () => failedOpen(file))
    )
    waitedAndPassed(first(got.ran, BEGIN), released.write)
    waitedAndFailed(first(got.ran, COMMIT))
    expect(got.ran.filter((statement) => statement.sql === WAL)).toEqual([])
    waitedLimit(got.value, "open")
    // Two waits.
    expect(got.value.ms).toBeLessThan(2 * LIMIT + SLACK)
  } finally {
    reader.end()
  }
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "delete" }])
  expect(launches(file).length).toBe(1)
})

test("the limit store: the whole open, on a file in a rollback journal, waits three times in a row: at its BEGIN IMMEDIATE for another process's write of 100 ms, at its COMMIT for that process's read of 100 ms, then at the change to WAL for a reader; it ends with StoreError (open) within 3 × store", async () => {
  const file = await rollbackFile()
  let reader: { readonly end: () => void } | undefined
  const { value: got, released } = await withHolder(
    file,
    { write: 100, read: 100 },
    (tell) =>
      traced({
        before: { [BEGIN]: () => tell("write"), [COMMIT]: () => tell("read") },
        after: { [COMMIT]: () => reader = holdRead(file) }
      }, () => failedOpen(file)).finally(() => reader?.end())
  )
  waitedAndPassed(first(got.ran, BEGIN), released.write)
  waitedAndPassed(first(got.ran, COMMIT), released.read)
  waitedAndFailed(first(got.ran, WAL))
  waitedLimit(got.value, "open")
  // Three waits.
  expect(got.value.ms).toBeLessThan(3 * LIMIT + SLACK)
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "delete" }])
  expect(launches(file).length).toBe(1)
})

test("the limit store: on a file in WAL mode the open waits only at its BEGIN IMMEDIATE: it waits for another process's write of 100 ms, and then its COMMIT and its change to WAL wait for no reader and no writer", async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  const reader = holdRead(file)
  let writer: Sqlite | undefined
  try {
    const { value: got, released } = await withHolder(
      file,
      { write: 100 },
      (tell) =>
        traced({
          before: { [BEGIN]: () => tell("write") },
          after: {
            [COMMIT]: () => {
              writer = holdLock(file)
            }
          }
        }, () => Effect.runPromise(timedValue(Effect.void.pipe(Effect.provide(Database.layer(file, { store: LIMIT }))))))
    )
    expect(writer).toBeDefined()
    waitedAndPassed(first(got.ran, BEGIN), released.write)
    noWait(first(got.ran, COMMIT))
    noWait(first(got.ran, WAL))
    // One wait.
    expect(got.value.ms).toBeLessThan(LIMIT + SLACK)
  } finally {
    writer?.run("rollback")
    writer?.close()
    reader.end()
  }
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "wal" }])
})

test("the limit store: the store's launch, after the open, is a call of its own: on a file in WAL mode the layer waits at the open's BEGIN IMMEDIATE for another process's write of 100 ms, then at the launch's BEGIN IMMEDIATE for a write that starts after the change to WAL, and ends with StoreError (launch) within 2 × store", async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  let writer: Sqlite | undefined
  try {
    const { value: got, released } = await withHolder(
      file,
      { write: 100 },
      (tell) =>
        traced({
          before: { [BEGIN]: () => tell("write") },
          after: {
            [WAL]: () => {
              writer = holdLock(file)
            }
          }
        }, () => failedOpen(file))
    )
    expect(writer).toBeDefined()
    const begins = got.ran.filter((statement) => statement.sql === BEGIN)
    expect(begins.length).toBe(2)
    waitedAndPassed(begins[0] as Ran, released.write)
    noWait(first(got.ran, WAL))
    waitedAndFailed(begins[1] as Ran)
    waitedLimit(got.value, "launch")
    // Two waits.
    expect(got.value.ms).toBeLessThan(2 * LIMIT + SLACK)
  } finally {
    writer?.run("rollback")
    writer?.close()
  }
  expect(launches(file).length).toBe(1)
})

// The one wait of a call that store does not bound: the store has one connection,
// and a call waits for it while another call of the same process holds
// it, here a transaction of 600 ms. The holder's own time bounds that
// wait, not the store's timer (database.ts).
test("the limit store: a call waits for the connection while a transaction of the same process holds it, past store, and then runs", async () => {
  const file = newFile()
  const got = await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    const holder = yield* Effect.forkChild(store.transaction(Effect.sleep("600 millis")))
    yield* Effect.sleep("20 millis")
    const write = yield* timedValue(store.setGoal("after the holder"))
    yield* Fiber.join(holder)
    return { write: write.ms, goal: (yield* store.chat).goal }
  }).pipe(Effect.provide(limited(file))))
  expect(got.write).toBeGreaterThan(LIMIT)
  expect(got.write).toBeLessThan(1500)
  expect(got.goal).toBe("after the holder")
})
