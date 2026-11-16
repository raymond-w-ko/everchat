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
import { Chats, DatabaseVersion, LaunchLive, type NewEvent, NoChat, type Part, Reads, Store, StoreError } from "@everchat/core/store"

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
