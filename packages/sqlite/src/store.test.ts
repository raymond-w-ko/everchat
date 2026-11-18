// Tests of the store: the launch that owns the file, the log, the tree, the
// views, and what a failed write leaves behind. The cases that hold for
// every store are the contract's suites (packages/sqlite/AGENTS.md, "The
// contract's suites"), which this file runs with SQLite's harness; the
// cases here need SQLite itself.

import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scheduler } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { harness, newFile, options, PICK, rows, withChats, withStore, write } from "../tests/help.ts"
import {
  CEILING_WHY,
  calls,
  crash,
  fire,
  fireSlot,
  functions,
  H,
  launches,
  made,
  owners,
  REMINDER,
  ROUTINE,
  settleBySql,
  storeCases1,
  switchBySql,
  T0,
  unsettledOf,
  wakeOf,
  withClock
} from "../tests/contract/store1.ts"
import { asUuid, keyedSay, LAUNCH, story, storeCases2, TENANT_A, TENANT_B } from "../tests/contract/store2.ts"
import { SqlClient, Statement } from "effect/sql"
import * as Database from "./database.ts"
import { VERSION } from "./schema.ts"
import { chatsLayer, chatsLayerNoDatabase, Dialect, ProcessAlive, readsLayer, SQLITE, storeLayer, storeLayerNoDatabase } from "./sqlite.ts"
import { TestClock } from "effect/testing"
import {
  Chats,
  DatabaseVersion,
  LaunchLive,
  type Message,
  Reads,
  type Reading,
  Store,
  StoreError,
  type Turn,
  type Wake,
  type WakeOf
} from "@everchat/core/store"

// The store's cases, parts 1 and 2, with SQLite's harness.
storeCases1(harness)
storeCases2(harness)

// SQLite's own text of a refusal: the driver's error (`reason`) holds it.
const sqliteText = (error: StoreError) => String((error.cause as { readonly reason?: { readonly cause?: unknown } }).reason?.cause)

// The launch
// ----------

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
  expect(await launches(file)).toEqual([{ id: 1, pid: 4242, ended: 0, why: null }])
})

// The file's tenant and its chat
// -------------------------------

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
  expect(await launches(file)).toEqual([{ id: 1, pid: process.pid, ended: 1, why: "exit" }])
  // With no launch at all, the reads still work, and they leave the launches as they are.
  expect(await withReads(file, Reads.use((reads) => reads.count))).toBe(2)
  expect(await launches(file)).toEqual([{ id: 1, pid: process.pid, ended: 1, why: "exit" }])
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

// Wake-ups
// --------

test("SQLite's text: makeWake's refusals by the schema (a turn with no call, a call with no turn, a routine with a time, a wake-up with neither, a reminder whose first slot is not its time, a turn that the chat has not) are SQLite's CHECK and FOREIGN KEY texts in the driver's cause", async () => {
  const file = newFile()
  const errors = await withClock(file, Effect.gen(function*() {
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
    return errors
  }))
  expect(errors.map((error) => [error instanceof StoreError, error.op, sqliteText(error)])).toEqual([
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (turn is null) = (call is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (turn is null) = (call is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (cron is null) <> (at is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: (cron is null) <> (at is null)")],
    [true, "makeWake", expect.stringContaining("CHECK constraint failed: at is null or first = at")],
    [true, "makeWake", expect.stringContaining("FOREIGN KEY constraint failed")]
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
  await switchBySql(file, false)
  expect(await withStore(file, Store.use(ask))).toEqual([[], [], [], [], []])
  expect(await withReads(file, Reads.use(ask))).toEqual([[], [], [], [], []])
  await switchBySql(file, true)
  expect(await withStore(file, Store.use(ask))).toEqual(on)
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
  await settleBySql(file, 3, T0)
  expect(await withStore(file, Store.use(ids))).toEqual(Option.some(3))
  expect(await withReads(file, Reads.use(ids))).toEqual(Option.some(3))
  await switchBySql(file, false)
  expect(await withStore(file, Store.use(ids))).toEqual(Option.none())
  expect(await withReads(file, Reads.use(ids))).toEqual(Option.none())
})

test("SQLite's text: a missed of null in pendWake (no fire waiting, and a fire waiting) and in fireWake's read (a newer slot waits) is refused by the table with SQLite's NOT NULL text in the driver's cause", async () => {
  const file = newFile()
  const results = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const idle = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const waits = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    const newer = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    yield* store.pendWake(waits.id, { pending: T0, missed: 2, due: T0 + H })
    yield* store.pendWake(newer.id, { pending: T0, missed: 4, due: T0 + H })
    yield* store.pendWake(newer.id, { pending: T0 + 2 * H, missed: 5, due: T0 + 3 * H })
    yield* TestClock.setTime(T0 + 2 * H + 1)
    const none = null as unknown as number
    const tries: Array<Effect.Effect<unknown, StoreError>> = [
      store.pendWake(idle.id, { pending: T0, missed: none, due: T0 + H }),
      store.pendWake(waits.id, { pending: T0 + H, missed: none, due: T0 + 2 * H }),
      fire(store, newer.id, { pending: T0, missed: none })
    ]
    const results = []
    for (const one of tries) results.push(yield* Effect.result(one))
    return results
  }))
  const refused = expect.stringContaining("NOT NULL constraint failed: everchat_wake.missed")
  expect(results.map((result) => (result._tag === "Failure" ? [result.failure.op, sqliteText(result.failure)] : ["no error", result.success]))).toEqual([
    ["pendWake", refused],
    ["pendWake", refused],
    ["fireWake", refused]
  ])
})

test("SQLite's text: fireWake with a turn that the chat has not is refused by the reference, with SQLite's FOREIGN KEY text in the driver's cause", async () => {
  const file = newFile()
  const error = await withClock(file, Effect.gen(function*() {
    const store = yield* Store
    const waits = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
    yield* store.pendWake(waits.id, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
    return yield* Effect.flip(store.fireWake(waits.id, 99, { pending: T0 + H, missed: 0 }))
  }))
  expect([error instanceof StoreError, error.op, sqliteText(error)]).toEqual([true, "fireWake", expect.stringContaining("FOREIGN KEY constraint failed")])
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

// The tag of a deployment
// -----------------------

test("Chats: the local layers still make one tenant and one chat, and the tag finds that chat", async () => {
  const file = newFile()
  const uuid = await withStore(file, Store.use((store) => Effect.map(store.chat, (chat) => chat.uuid)))
  const { chats, tenants } = await owners(file)
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
  expect(await owners(file)).toEqual({ chats, tenants })
  expect((await launches(file)).map((launch) => launch.id)).toEqual([1, 2, 3])
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

test("SQLite's text: addEvent with a last message that the chat does not have is refused by the reference, with SQLite's FOREIGN KEY text in the driver's cause", async () => {
  const file = newFile()
  const got = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    const said = yield* store.append([{ kind: "user", text: "one" }])
    yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[0]!.i })
    // Message 1 is not there: only the reference of msg_last refuses it.
    const refused = yield* Effect.flip(store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[0]!.i + 1 }))
    const message = yield* Effect.flip(store.addEvent({ type: "message", msg: said[0]!.i, msgLast: said[0]!.i + 1 }))
    return [refused, message]
  }))
  expect(got.map((error) => [error instanceof StoreError, sqliteText(error)])).toEqual([
    [true, expect.stringContaining("FOREIGN KEY")],
    [true, expect.stringContaining("FOREIGN KEY")]
  ])
})

// The events, read again
// ----------------------

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

test("keyed: an update of a message's key is refused by the table", async () => {
  const file = newFile()
  await withStore(file, Store.use((store) => keyedSay(store, ["a key"], "key-fixed")))
  expect(() => write(file, "update everchat_msg set sender_key = 'key-other' where i = 0")).toThrow("everchat_msg is append only")
  expect(() => write(file, "update everchat_msg set sender_key = null where i = 0")).toThrow("everchat_msg is append only")
  expect(rows(file, "select sender_key from everchat_msg")).toEqual([{ sender_key: "key-fixed" }])
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

test("SQLite's text: the same key twice in one chat is refused by the key's unique index, with SQLite's UNIQUE text in the driver's cause", async () => {
  const file = newFile()
  const alone = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* keyedSay(store, ["first", "its second page"], "key-twice")
    return yield* Effect.flip(store.append([{ kind: "user", text: "alone" }], "key-twice"))
  }))
  expect([alone instanceof StoreError, alone.op, sqliteText(alone)]).toEqual([
    true,
    "append",
    expect.stringContaining("UNIQUE constraint failed: everchat_msg.chat, everchat_msg.sender_key")
  ])
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
  expect((await launches(file)).length).toBe(1)
  await Effect.runPromise(Effect.void.pipe(Effect.provide(limited(file))))
  expect((await launches(file)).length).toBe(2)
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
  expect((await launches(file)).length).toBe(1)
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
  expect((await launches(file)).length).toBe(1)
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
  expect(await launches(file)).toEqual([])
  expect(rows(file, "select count(*) as n from everchat_chat")).toEqual([{ n: 0 }])
  expect(rows(file, "select count(*) as n from everchat_msg")).toEqual([{ n: 0 }])
  // The reader is gone: the next open finds the mark, writes no schema, and
  // changes the file to WAL; its launch is the file's first.
  const again = await traced({}, () => Effect.runPromise(timedValue(Effect.void.pipe(Effect.provide(limited(file))))))
  expect(again.ran.filter((statement) => statement.sql.startsWith("create ") || statement.sql.startsWith("pragma user_version ="))).toEqual([])
  expect(first(again.ran, WAL).ok).toBe(true)
  expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "wal" }])
  expect(objects(file)).toEqual(objects(made))
  expect((await launches(file)).length).toBe(1)
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
  expect((await launches(file)).length).toBe(1)
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
  expect((await launches(file)).length).toBe(1)
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
  expect((await launches(file)).length).toBe(1)
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

// The dialect and the writes
// --------------------------

// A store over `file` with `dialect` (`Dialect`, read at the build), with
// the file's `SqlClient` beside it, on the real clock.
// With no dialect given, the layer reads the one by default.
const withDialect = <A, E>(file: string, dialect: Dialect | null, effect: Effect.Effect<A, E, Store | SqlClient.SqlClient>) => {
  const run = effect.pipe(Effect.provide(storeLayerNoDatabase(options()).pipe(Layer.provideMerge(Database.layer(file)))))
  return Effect.runPromise(dialect === null ? run : Effect.provideService(run, Dialect, dialect))
}

// A statement as the client ran it: its text, and whether it ran inside a
// transaction of that client.
interface Said {
  readonly text: string
  readonly inTransaction: boolean
}

// Runs `effect` with each statement that `sql` runs kept in `said`, in
// order (effect's `CurrentTransformer`, which sees each statement before
// it runs; BEGIN, SAVEPOINT and COMMIT are no statements of it).
const listened = <A, E, R>(sql: SqlClient.SqlClient, said: Array<Said>, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Statement.CurrentTransformer, (statement, _make, fiber) =>
    Effect.sync(() => {
      said.push({ text: statement.compile()[0], inTransaction: Option.isSome(Context.getOption(fiber.context, sql.transactionService)) })
      return statement
    }))

// The statement that the counting dialect's `beforeWrite` runs: its mark.
const BEFORE = "select 'before write' as mark"

// A row that the counting dialect's `beforeWrite` writes, when asked to
// (`counting(true)`): a pick of its own vendor in the shared list, so that
// a rollback shows whether it was in the member's transaction.
const BEFORE_ROW =
  "insert into everchat_pick (vendor, model, effort, speed, created) select 'before write', 'mark ' || count(*), '', '', 0 from everchat_pick where vendor = 'before write'"

// SQLite's dialect with a `beforeWrite` that keeps the tenant and the chat
// that it was given (null for both with no chat: the launch, the make),
// runs `BEFORE` (and `BEFORE_ROW` with `row`), then fails with `refusal`
// while `state.fail`.
const refusal = new StoreError({ op: "lease", cause: new Error("the lease is lost") })
const counting = (row = false) => {
  const state = { seen: [] as Array<{ tenant: string | null; chat: number | null }>, fail: false }
  const dialect: Dialect = {
    ...SQLITE,
    beforeWrite: (sql, bound) =>
      Effect.gen(function*() {
        state.seen.push(bound === null ? { tenant: null, chat: null } : { tenant: Buffer.from(bound.tenant).toString("hex"), chat: bound.chat })
        yield* sql.unsafe(BEFORE)
        if (row) yield* sql.unsafe(BEFORE_ROW)
        if (state.fail) return yield* refusal
      })
  }
  return { state, dialect }
}

// Each row of each table of the file, by the client: what a write that
// failed must leave as it was.
const everything = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const tables = yield* sql<{ name: string }>`select name from sqlite_master where type = 'table' order by name`
    const all: Record<string, Array<string>> = {}
    for (const { name } of tables) all[name] = (yield* sql.unsafe(`select * from ${name}`)).map((row) => JSON.stringify(row)).sort()
    return all
  })

type StoreService = typeof Store.Service
type Writes = Exclude<keyof StoreService, keyof Reading | "launch" | "transaction">

const SLOT = 1_800_000_000_000
const OTHER_PICK = { ...PICK, model: "gpt-other" }

// One call of each member that writes, in this order on one chat: each
// call's rows are there for the calls after it, and each call writes (or
// is a write that finds nothing to change). The type lists every member
// that is not a read, so a new member needs its call here.
const WRITE_CALLS: { readonly [K in Writes]: (s: StoreService) => Effect.Effect<unknown, unknown> } = {
  setPick: (s) => s.setPick(OTHER_PICK),
  setGoal: (s) => s.setGoal("a goal"),
  setDraft: (s) => s.setDraft("a draft"),
  append: (s) => s.append([{ kind: "user", text: "hello" }], "key-1"),
  setTaken: (s) => s.setTaken(0),
  putNodes: (s) => s.putNodes([{ l: 0, i: 0, text: "a node" }]),
  putView: (s) => s.putView({ name: "chat", parts: [[0, 0]], batch: false }),
  putImage: (s) => s.putImage({ name: "an image", type: "image/png", width: 1, height: 1, source: "person", bytes: new Uint8Array([1]) }),
  putHead: (s) => s.putHead("{\"a\":1}"),
  startTurn: (s) => s.startTurn({ pick: PICK, head: "{\"a\":2}", firstMsg: 0 }),
  addUsage: (s) => s.addUsage({ served: "turn", turn: 1, pick: PICK, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }),
  addTurnItem: (s) => s.addTurnItem(1, "user", "an item"),
  startCall: (s) => Effect.andThen(s.startCall({ turn: 1, vendorId: "v1", fn: "run", input: "a program" }), s.startCall({ turn: 1, parent: 1, fn: "send", input: "[]" })),
  setCallPgid: (s) => s.setCallPgid(2, 4242),
  pendCall: (s) => s.pendCall(2, (n) => `waits as approval ${n}`),
  answerApproval: (s) => s.answerApproval(1, { yes: true, who: "the person" }),
  startApproval: (s) => s.startApproval(1),
  endApproval: (s) => s.endApproval(1, { status: "done", output: "sent" }),
  tellApproval: (s) => s.tellApproval(1, 0),
  expireApprovals: (s) => s.expireApprovals(),
  cutApprovals: (s) => s.cutApprovals("cut"),
  endCall: (s) => s.endCall(1, { status: "done", output: "ran" }),
  makeWake: (s) => s.makeWake({ text: "wake", cron: "0 9 * * *", zone: "Europe/Berlin", first: SLOT }, 20),
  pendWake: (s) => s.pendWake(1, { pending: SLOT, missed: 0, due: SLOT + 1 }),
  fireWake: (s) => s.fireWake(1, 1, { pending: SLOT, missed: 0 }),
  settleWake: (s) => s.settleWake(1, 1, "done"),
  stopWake: (s) => s.stopWake(1, "person"),
  setWakeups: (s) => s.setWakeups(false),
  addEvent: (s) => s.addEvent({ type: "accepted", msg: 0, msgLast: 0 }),
  addDiagnostics: (s) => s.addDiagnostics([{ level: "info", source: "test", text: "a line", created: 1 }]),
  dropDiagnostics: (s) => s.dropDiagnostics(2),
  endTurn: (s) => s.endTurn(1, "done")
}

// One call of each read.
const READ_CALLS: { readonly [K in keyof Reading]: (r: Reading) => Effect.Effect<unknown, unknown> } = {
  snapshot: (r) => r.snapshot(r.chat),
  version: (r) => r.version,
  chat: (r) => r.chat,
  eventsAfter: (r) => r.eventsAfter(0, 10),
  count: (r) => r.count,
  messages: (r) => r.messages(0, 1),
  messagesAfter: (r) => r.messagesAfter(-1, ["user"]),
  imagesOf: (r) => r.imagesOf(0),
  keyed: (r) => r.keyed("key-1"),
  node: (r) => r.node(0, 0),
  nodes: (r) => r.nodes([[0, 0]]),
  nodesIn: (r) => r.nodesIn(0, 0, 1),
  levels: (r) => r.levels,
  view: (r) => r.view("chat"),
  image: (r) => r.image(1),
  head: (r) => r.head(1),
  turn: (r) => r.turn(1),
  turns: (r) => r.turns(null, 10),
  runningTurns: (r) => r.runningTurns(null),
  turnItems: (r) => r.turnItems(1),
  calls: (r) => r.calls(1),
  call: (r) => r.call(1),
  approval: (r) => r.approval(1),
  approvalOf: (r) => r.approvalOf(2),
  approvals: (r) => r.approvals(),
  approvalsOf: (r) => r.approvalsOf(1),
  untoldApprovals: (r) => r.untoldApprovals(),
  wakes: (r) => r.wakes(),
  dueWakes: (r) => r.dueWakes(SLOT),
  pendingWake: (r) => r.pendingWake(),
  fires: (r) => r.fires(0),
  unsettledWakes: (r) => r.unsettledWakes(),
  wakesOf: (r) => r.wakesOf(1),
  usage: (r) => r.usage(),
  usageTotals: (r) => r.usageTotals,
  launches: (r) => r.launches(10),
  endedRunTags: (r) => r.endedRunTags,
  diagnostics: (r) => r.diagnostics(),
  lastDiagnostics: (r) => r.lastDiagnostics(10)
}

const tenantOf = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ id: Uint8Array }>`select id from everchat_tenant`, (rows) => Buffer.from(rows[0]!.id).toString("hex"))

test("the writes, swept: each member that writes runs beforeWrite once for each call, as the first statement of its transaction, with the store's tenant and chat, and each of its statements in that transaction; a beforeWrite that fails leaves every row as it was, and the member fails with its error; every member of the store is a read, a write of the sweep, launch or transaction", async () => {
  const file = newFile()
  const { state, dialect } = counting()
  const got = await withDialect(file, dialect, Effect.gen(function*() {
    const store = yield* Store
    const sql = yield* SqlClient.SqlClient
    const tenant = yield* tenantOf(sql)
    const rows: Array<unknown> = []
    for (const [member, call] of Object.entries(WRITE_CALLS) as Array<[Writes, (s: StoreService) => Effect.Effect<unknown, unknown>]>) {
      // Refused first: nothing written, the member's error with the refusal as its cause.
      const before = yield* everything(sql)
      state.fail = true
      state.seen.length = 0
      const refused = yield* Effect.exit(call(store))
      state.fail = false
      const error = Exit.isFailure(refused) ? Cause.squash(refused.cause) : undefined
      const kept = yield* everything(sql)
      // Then written.
      state.seen.length = 0
      const said: Array<Said> = []
      const exit = yield* Effect.exit(listened(sql, said, call(store)))
      rows.push({
        member,
        refused: error instanceof StoreError ? [error.op, error.cause === refusal] : String(error),
        kept: JSON.stringify(kept) === JSON.stringify(before),
        ok: Exit.isSuccess(exit) ? true : String(Cause.squash(exit.cause)),
        seen: state.seen.map((one) => [one.tenant === tenant, one.chat]),
        first: said[0]?.text,
        marks: said.filter((one) => one.text === BEFORE).length,
        after: said.length > 1,
        inTransaction: said.every((one) => one.inTransaction)
      })
    }
    return { rows, members: Object.keys(store).sort() }
  }))
  const want = (member: string) => {
    // startCall's call makes two calls, so two writes.
    const twice = member === "startCall"
    return {
      member,
      refused: [member, true],
      kept: true,
      ok: true,
      seen: twice ? [[true, 1], [true, 1]] : [[true, 1]],
      first: BEFORE,
      marks: twice ? 2 : 1,
      after: true,
      inTransaction: true
    }
  }
  for (const row of got.rows as Array<Record<string, unknown>>) expect(row).toEqual(want(String(row.member)))
  expect(got.rows.length).toBe(Object.keys(WRITE_CALLS).length)
  const cased = new Set([...Object.keys(WRITE_CALLS), ...Object.keys(READ_CALLS), "launch", "transaction"])
  expect(got.members.filter((member) => !cased.has(member))).toEqual([])
})

test("the store's transaction with three writes, one of which calls another (startTurn, putHead): beforeWrite runs once, as its first statement; a failed beforeWrite leaves none of the three, and the transaction fails with its error", async () => {
  const file = newFile()
  const { state, dialect } = counting()
  const got = await withDialect(file, dialect, Effect.gen(function*() {
    const store = yield* Store
    const sql = yield* SqlClient.SqlClient
    const three = store.transaction(Effect.all([
      store.setGoal("in a transaction"),
      store.append([{ kind: "user", text: "in a transaction" }]),
      store.startTurn({ pick: PICK, head: "{\"t\":1}", firstMsg: 0 })
    ]))
    const before = yield* everything(sql)
    state.fail = true
    const refused = yield* Effect.exit(three)
    state.fail = false
    const kept = JSON.stringify(yield* everything(sql)) === JSON.stringify(before)
    state.seen.length = 0
    const said: Array<Said> = []
    yield* listened(sql, said, three)
    return {
      // The store's transaction keeps a StoreError as it is.
      refused: Exit.isFailure(refused) ? Cause.squash(refused.cause) === refusal : "it did not fail",
      kept,
      seen: state.seen.length,
      first: said[0]?.text,
      marks: said.filter((one) => one.text === BEFORE).length,
      statements: said.length,
      inTransaction: said.every((one) => one.inTransaction),
      goal: (yield* store.chat).goal,
      turns: (yield* store.turns(null, 10)).length
    }
  }))
  expect(got).toMatchObject({ refused: true, kept: true, seen: 1, first: BEFORE, marks: 1, inTransaction: true, goal: "in a transaction", turns: 1 })
  expect(got.statements).toBeGreaterThan(4)
})

test("no read runs beforeWrite: each member of the reads, swept, on a chat with a row of each kind, and the same reads inside a snapshot", async () => {
  const file = newFile()
  const { state, dialect } = counting()
  const got = await withDialect(file, dialect, Effect.gen(function*() {
    const store = yield* Store
    const sql = yield* SqlClient.SqlClient
    for (const call of Object.values(WRITE_CALLS)) yield* call(store)
    state.seen.length = 0
    const rows: Array<unknown> = []
    for (const [member, call] of Object.entries(READ_CALLS) as Array<[string, (r: Reading) => Effect.Effect<unknown, unknown>]>) {
      const said: Array<Said> = []
      const exit = yield* Effect.exit(listened(sql, said, call(store)))
      rows.push({ member, ok: Exit.isSuccess(exit), seen: state.seen.length, marks: said.filter((one) => one.text === BEFORE).length })
    }
    yield* store.snapshot(Effect.forEach(Object.values(READ_CALLS), (call) => Effect.exit(call(store))))
    return { rows, seen: state.seen.length }
  }))
  for (const row of got.rows as Array<Record<string, unknown>>) expect(row).toEqual({ member: row.member, ok: true, seen: 0, marks: 0 })
  expect(got.rows.length).toBe(Object.keys(READ_CALLS).length)
  expect(got.seen).toBe(0)
})

test("SQLite's dialect: no beforeWrite; setDraft and putView are each the one statement of before this bead, in no transaction (no begin); the store's layers read it by default", async () => {
  expect(SQLITE.beforeWrite).toBeUndefined()
  expect(SQLITE.forUpdate).toBe("")
  const file = newFile()
  const got = await withDialect(file, null, Effect.gen(function*() {
    const store = yield* Store
    const sql = yield* SqlClient.SqlClient
    const draft: Array<Said> = []
    yield* listened(sql, draft, store.setDraft("a draft"))
    const view: Array<Said> = []
    yield* listened(sql, view, store.putView({ name: "chat", parts: [[0, 0]], batch: false }))
    yield* listened(sql, view, store.putView({ name: "chat", parts: [[0, 1]], batch: true }))
    return { draft, view, dialect: yield* Dialect }
  }))
  expect(got.dialect).toBe(SQLITE)
  expect(got.draft).toEqual([{ text: "update everchat_chat set draft = ?, updated = ? where tenant = ? and id = ?", inTransaction: false }])
  const upsert = "\n      insert into everchat_view (\"chat\",\"name\",\"parts\",\"batch\",\"created\",\"updated\") VALUES (?,?,?,?,?,?)\n      on conflict (chat, name) do update\n      set parts = excluded.parts, batch = excluded.batch, updated = excluded.updated"
  expect(got.view).toEqual([{ text: upsert, inTransaction: false }, { text: upsert, inTransaction: false }])
})

// One transaction, and the writes with no chat (lead, ec-9qt2rc, W5, W6)
// ---------------------------------------------------------------------

// What `BEFORE_ROW` wrote and kept: its picks in the shared list.
const beforeRows = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ n: number }>`select count(*) as n from everchat_pick where vendor = 'before write'`, (rows) => rows[0]!.n)
const beforeRowsIn = (file: string) => rows<{ n: number }>(file, "select count(*) as n from everchat_pick where vendor = 'before write'")[0]!.n

// A statement that the database refuses (no such table).
const BROKEN = "insert into no_such_table values (1)"

// A transformer that keeps each statement of the run, with whether it ran
// inside a transaction of its client, in `said`; and runs `BROKEN` in place
// of the statement for which `breaks(text, said)` is true. Given to a whole
// run, it sees the layer's build and the scope's finalizers too.
const hearing = (said: Array<Said>, breaks?: (text: string, said: ReadonlyArray<Said>) => boolean): Statement.Transformer => (statement, make, fiber) =>
  Effect.sync(() => {
    const text = statement.compile()[0]
    const client = Context.getOption(fiber.context, SqlClient.SqlClient)
    const inTransaction = Option.isSome(client) && Option.isSome(Context.getOption(fiber.context, client.value.transactionService))
    if (breaks !== undefined && breaks(text, said)) {
      said.push({ text: BROKEN, inTransaction })
      return make.unsafe(BROKEN)
    }
    said.push({ text, inTransaction })
    return statement
  })

// The texts of `said`, but the pragmas of the file's open (database.ts).
const unpragma = (said: ReadonlyArray<Said>) => said.filter((one) => !one.text.startsWith("pragma"))

// A layer's launch, with nothing more.
const taken = Effect.gen(function*() {
  yield* Store
})

const INSERT_HEAD = "insert into everchat_head "
const countIn = (sql: SqlClient.SqlClient, table: string) => Effect.map(sql.unsafe<{ n: number }>(`select count(*) as n from ${table}`), (rows) => rows[0]!.n)
const END = "update everchat_launch set ended = ?, why = ? where chat = ? and n = ? and ended is null"
const B = { text: BEFORE, inTransaction: true }
const BR = { text: BEFORE_ROW, inTransaction: true }

// The store's layer over `file`, its launch and its end, with `dialect`
// (SQLite's by default) and `transformer` over the whole run.
const launched = <A, E>(file: string, dialect: Dialect | null, transformer: Statement.Transformer, effect: Effect.Effect<A, E, Store | SqlClient.SqlClient>) => {
  const run = effect.pipe(
    Effect.provide(storeLayerNoDatabase(options()).pipe(Layer.provideMerge(Database.layer(file)))),
    Effect.provideService(Statement.CurrentTransformer, transformer)
  )
  return Effect.runPromise(Effect.exit(dialect === null ? run : Effect.provideService(run, Dialect, dialect)))
}

test("one transaction (W5): a statement member (setGoal) and a transaction member (startTurn, after its head's insert) that fail after beforeWrite wrote its row leave neither beforeWrite's row nor a row of the member; written whole, each keeps its row", async () => {
  const file = newFile()
  const { dialect } = counting(true)
  const got = await withDialect(file, dialect, Effect.gen(function*() {
    const store = yield* Store
    const sql = yield* SqlClient.SqlClient
    // The launch's own row (W6).
    const start = yield* beforeRows(sql)
    // setGoal, a statement member: its one statement fails.
    const goal: Array<Said> = []
    const goalExit = yield* Effect.exit(Effect.provideService(store.setGoal("a goal"), Statement.CurrentTransformer, hearing(goal, (text) => text === GOAL)))
    const afterGoal = { rows: yield* beforeRows(sql), goal: (yield* store.chat).goal }
    // startTurn, a transaction member: the statement after its head's insert fails.
    const turn: Array<Said> = []
    const turnExit = yield* Effect.exit(Effect.provideService(
      store.startTurn({ pick: PICK, head: "{\"w\":5}", firstMsg: 0 }),
      Statement.CurrentTransformer,
      hearing(turn, (_text, said) => said.some((one) => one.text.startsWith(INSERT_HEAD)))
    ))
    const afterTurn = { rows: yield* beforeRows(sql), heads: yield* countIn(sql, "everchat_head"), turns: yield* countIn(sql, "everchat_turn") }
    // Whole: each write keeps beforeWrite's row and its own.
    yield* store.setGoal("a goal")
    yield* store.startTurn({ pick: PICK, head: "{\"w\":5}", firstMsg: 0 })
    return {
      start,
      goal: goal.map((one) => one.text),
      goalInTransaction: goal.every((one) => one.inTransaction),
      goalFailed: Exit.isFailure(goalExit) ? String((Cause.squash(goalExit.cause) as StoreError).op) : "it did not fail",
      afterGoal,
      turn: turn.slice(0, 2).map((one) => one.text),
      turnHead: turn.filter((one) => one.text.startsWith(INSERT_HEAD)).length,
      turnLast: turn[turn.length - 1]?.text,
      turnInTransaction: turn.every((one) => one.inTransaction),
      turnFailed: Exit.isFailure(turnExit) ? String((Cause.squash(turnExit.cause) as StoreError).op) : "it did not fail",
      afterTurn,
      whole: { rows: yield* beforeRows(sql), goal: (yield* store.chat).goal, heads: yield* countIn(sql, "everchat_head"), turns: yield* countIn(sql, "everchat_turn") }
    }
  }))
  expect(got).toEqual({
    start: 1,
    goal: [BEFORE, BEFORE_ROW, BROKEN],
    goalInTransaction: true,
    goalFailed: "setGoal",
    afterGoal: { rows: 1, goal: null },
    turn: [BEFORE, BEFORE_ROW],
    turnHead: 1,
    turnLast: BROKEN,
    turnInTransaction: true,
    turnFailed: "startTurn",
    afterTurn: { rows: 1, heads: 0, turns: 0 },
    whole: { rows: 3, goal: "a goal", heads: 1, turns: 1 }
  })
})

test("the launch's end (W5): beforeWrite with the store's tenant and chat runs first, in one transaction with the end; refused, the launch stays not ended; the end broken, neither the end nor beforeWrite's row is written", async () => {
  const run = async (how: "whole" | "refused" | "broken") => {
    const file = newFile()
    const { state, dialect } = counting(true)
    const said: Array<Said> = []
    let at = -1
    let tenant = ""
    const exit = await launched(file, dialect, hearing(said, how === "broken" ? (text) => text === END : undefined), Effect.gen(function*() {
      yield* Store
      tenant = yield* tenantOf(yield* SqlClient.SqlClient)
      state.seen.length = 0
      at = said.length
      if (how === "refused") state.fail = true
    }))
    return {
      exit: Exit.isSuccess(exit),
      end: said.slice(at),
      seen: state.seen.map((one) => [one.tenant === tenant, one.chat]),
      ended: rows<{ ended: number | null }>(file, "select ended from everchat_launch").map((one) => one.ended !== null),
      rows: beforeRowsIn(file)
    }
  }
  expect(await run("whole")).toEqual({ exit: true, end: [B, BR, { text: END, inTransaction: true }], seen: [[true, 1]], ended: [true], rows: 2 })
  expect(await run("refused")).toEqual({ exit: true, end: [B, BR], seen: [[true, 1]], ended: [false], rows: 1 })
  expect(await run("broken")).toEqual({ exit: true, end: [B, BR, { text: BROKEN, inTransaction: true }], seen: [[true, 1]], ended: [false], rows: 1 })
})

// The launch's transaction as SQLite runs it on a file with a chat (the
// statements of before ec-9qt2rc), and the end, in no transaction.
const SQLITE_LAUNCH: ReadonlyArray<Said> = [
  { text: "select id from everchat_tenant", inTransaction: true },
  { text: "select uuid from everchat_chat where tenant = ?", inTransaction: true },
  { text: "select id from everchat_chat where tenant = ? and uuid = ?", inTransaction: true },
  { text: "\n      select n, pid, host, created from everchat_launch where chat = ? and ended is null", inTransaction: true },
  { text: "select coalesce(max(n), 0) + 1 as next from everchat_launch where chat = ?", inTransaction: true },
  { text: "insert into everchat_launch (\"chat\",\"n\",\"pid\",\"host\",\"cwd\",\"version\",\"run_tag\",\"pick\",\"created\") VALUES (?,?,?,?,?,?,?,?,?)", inTransaction: true }
]

test("the launch (W6): beforeWrite with no chat is the first statement of the launch's transaction, before the chat is found; armed, the launch fails with its StoreError and writes nothing, and a launch of before that is not ended stays not ended", async () => {
  // A file whose first launch's end is undone: a crash.
  const file = newFile()
  await withStore(file, Effect.void)
  write(file, "update everchat_launch set ended = null, why = null")
  const picks = rows(file, "select * from everchat_pick")
  const armed = counting(true)
  armed.state.fail = true
  const refusedSaid: Array<Said> = []
  const refused = await launched(file, armed.dialect, hearing(refusedSaid), taken)
  expect({
    refused: Exit.isFailure(refused) ? refusedBy(Cause.squash(refused.cause), "launch") : "it did not fail",
    said: unpragma(refusedSaid),
    seen: armed.state.seen,
    launches: rows(file, "select n, ended, why from everchat_launch"),
    picks: rows(file, "select * from everchat_pick")
  }).toEqual({
    refused: true,
    said: [B, BR],
    seen: [{ tenant: null, chat: null }],
    launches: [{ n: 1, ended: null, why: null }],
    picks
  })
  // A new file, armed: no tenant, chat, pick or launch.
  const empty = newFile()
  const none = counting(true)
  none.state.fail = true
  const fresh = await launched(empty, none.dialect, hearing([]), taken)
  expect({
    refused: Exit.isFailure(fresh) ? refusedBy(Cause.squash(fresh.cause), "launch") : "it did not fail",
    rows: ["tenant", "chat", "pick", "launch"].map((table) => rows<{ n: number }>(empty, `select count(*) as n from everchat_${table}`)[0]!.n)
  }).toEqual({ refused: true, rows: [0, 0, 0, 0] })
  // Not armed: beforeWrite, then the launch's statements, in its one
  // transaction; the launch of before closed as a crash.
  const open = counting(true)
  const said: Array<Said> = []
  let launch: Array<Said> = []
  const done = await launched(file, open.dialect, hearing(said), Effect.andThen(taken, Effect.sync(() => launch = unpragma(said))))
  expect({ done: Exit.isSuccess(done), launch, seen: open.state.seen[0] }).toEqual({
    done: true,
    launch: [B, BR, ...SQLITE_LAUNCH.slice(0, 4), { text: "update everchat_launch set ended = ?, why = 'crash' where chat = ? and n = ?", inTransaction: true }, ...SQLITE_LAUNCH.slice(4)],
    seen: { tenant: null, chat: null }
  })
  expect(rows(file, "select n, ended is not null as ended, why from everchat_launch order by n")).toEqual([{ n: 1, ended: 1, why: "crash" }, { n: 2, ended: 1, why: "exit" }])
})

// Chats.make and Chats.store as SQLite runs them (before ec-9qt2rc).
const SQLITE_MAKE: ReadonlyArray<Said> = [
  { text: "select id from everchat_tenant where id = ?", inTransaction: true },
  { text: "insert into everchat_tenant (\"id\",\"created\") VALUES (?,?)", inTransaction: true },
  { text: "insert into everchat_pick (\"vendor\",\"model\",\"effort\",\"speed\",\"created\") VALUES (?,?,?,?,?) on conflict do nothing", inTransaction: true },
  { text: "\n        select id from everchat_pick\n        where vendor = ? and model = ? and effort = ? and speed = ?", inTransaction: true },
  { text: "insert into everchat_chat (\"tenant\",\"uuid\",\"pick\",\"created\",\"updated\") VALUES (?,?,?,?,?)", inTransaction: true },
  { text: "select id from everchat_chat where tenant = ? and uuid = ?", inTransaction: true }
]
const SQLITE_STORE: ReadonlyArray<Said> = [
  { text: "select id from everchat_chat where tenant = ? and uuid = ?", inTransaction: true },
  ...SQLITE_LAUNCH.slice(3)
]

// `Chats.make` of TENANT_A, then its store, then a make of TENANT_B
// armed, with `dialect` (SQLite's by default): their statements, and the
// make's exit.
const madeWith = (file: string, counted: ReturnType<typeof counting> | null) => {
  const said: Array<Said> = []
  const run = Effect.scoped(Effect.gen(function*() {
    const chats = yield* Chats
    // The file's open (database.ts) is not the make's.
    said.length = 0
    const uuid = yield* chats.make(TENANT_A, PICK)
    const make = said.slice()
    said.length = 0
    yield* chats.store(TENANT_A, uuid, LAUNCH)
    const store = said.slice()
    if (counted !== null) counted.state.fail = true
    const armed = yield* Effect.exit(chats.make(TENANT_B, PICK))
    if (counted !== null) counted.state.fail = false
    return { make, store, armed: Exit.isFailure(armed) ? refusedBy(Cause.squash(armed.cause), "make") : "done" }
  })).pipe(
    Effect.provide(chatsLayerNoDatabase.pipe(Layer.provideMerge(Database.layer(file)))),
    Effect.provideService(Statement.CurrentTransformer, hearing(said))
  )
  return Effect.runPromise(counted === null ? run : Effect.provideService(run, Dialect, counted.dialect))
}

test("the make (W6): Chats.make runs beforeWrite with no chat as the first statement of its transaction; armed, it fails with the make's StoreError and writes no tenant, pick or chat; Chats.store's launch runs it first too", async () => {
  const file = newFile()
  const counted = counting(true)
  const got = await madeWith(file, counted)
  expect(got).toEqual({ make: [B, BR, ...SQLITE_MAKE], store: [B, BR, ...SQLITE_STORE], armed: true })
  expect(counted.state.seen.slice(0, 2)).toEqual([{ tenant: null, chat: null }, { tenant: null, chat: null }])
  expect(rows(file, "select count(*) as n from everchat_tenant")).toEqual([{ n: 1 }])
  expect(rows(file, "select count(*) as n from everchat_chat")).toEqual([{ n: 1 }])
  // PICK, and the rows of the beforeWrite of the make, of the store's
  // launch and of its end; none of the refused make.
  expect(rows(file, "select vendor, model from everchat_pick order by id")).toEqual([
    { vendor: "before write", model: "mark 0" },
    { vendor: PICK.vendor, model: PICK.model },
    { vendor: "before write", model: "mark 1" },
    { vendor: "before write", model: "mark 2" }
  ])
})

// One transaction (lead, ec-95bdxx, W8)
// --------------------------------------

// Breaks the first statement after `BEFORE_ROW`, once, and only after
// `on()` is true: in the launch's transaction or the make's.
const afterRow = (on: () => boolean = () => true) => (_text: string, said: ReadonlyArray<Said>) =>
  on() && said[said.length - 1]?.text === BEFORE_ROW && !said.some((one) => one.text === BROKEN)

// The error of a launch or a make that a broken statement failed: its own
// StoreError, the database's error as its cause (not the refusal).
const brokenBy = (error: unknown, op: string) =>
  error instanceof StoreError && error.op === op && error.cause !== refusal && (error.cause as { _tag?: string } | undefined)?._tag === "SqlError"

test("the launch (W8): not armed, the statement after beforeWrite's row breaks; the launch fails with its StoreError, beforeWrite's row is rolled back with it, no launch is written and a launch of before that is not ended stays not ended", async () => {
  // A file whose first launch's end is undone: a crash.
  const file = newFile()
  await withStore(file, Effect.void)
  write(file, "update everchat_launch set ended = null, why = null")
  const picks = rows(file, "select * from everchat_pick")
  const counted = counting(true)
  const said: Array<Said> = []
  const exit = await launched(file, counted.dialect, hearing(said, afterRow()), taken)
  expect({
    broken: Exit.isFailure(exit) ? brokenBy(Cause.squash(exit.cause), "launch") : "it did not fail",
    said: unpragma(said),
    seen: counted.state.seen,
    rows: beforeRowsIn(file),
    launches: rows(file, "select n, ended, why from everchat_launch"),
    picks: rows(file, "select * from everchat_pick")
  }).toEqual({
    broken: true,
    said: [B, BR, { text: BROKEN, inTransaction: true }],
    seen: [{ tenant: null, chat: null }],
    rows: 0,
    launches: [{ n: 1, ended: null, why: null }],
    picks
  })
  // A new file: no tenant, chat, pick or launch, and no row of beforeWrite.
  const empty = newFile()
  const fresh = await launched(empty, counting(true).dialect, hearing([], afterRow()), taken)
  expect({
    broken: Exit.isFailure(fresh) ? brokenBy(Cause.squash(fresh.cause), "launch") : "it did not fail",
    rows: ["tenant", "chat", "pick", "launch"].map((table) => rows<{ n: number }>(empty, `select count(*) as n from everchat_${table}`)[0]!.n)
  }).toEqual({ broken: true, rows: [0, 0, 0, 0] })
})

test("the make (W8): not armed, the statement after beforeWrite's row breaks; the make fails with its StoreError, beforeWrite's row is rolled back with it, and no tenant, pick or chat is written", async () => {
  const file = newFile()
  const counted = counting(true)
  const said: Array<Said> = []
  let on = false
  let at = -1
  const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const chats = yield* Chats
    // The file's open (database.ts) is not the make's.
    at = said.length
    on = true
    return yield* Effect.exit(chats.make(TENANT_A, PICK))
  })).pipe(
    Effect.provide(chatsLayerNoDatabase.pipe(Layer.provideMerge(Database.layer(file)))),
    Effect.provideService(Statement.CurrentTransformer, hearing(said, afterRow(() => on))),
    Effect.provideService(Dialect, counted.dialect)
  ))
  expect({
    broken: Exit.isFailure(exit) ? brokenBy(Cause.squash(exit.cause), "make") : "it did not fail",
    said: said.slice(at),
    seen: counted.state.seen,
    rows: ["tenant", "chat", "pick"].map((table) => rows<{ n: number }>(file, `select count(*) as n from everchat_${table}`)[0]!.n)
  }).toEqual({
    broken: true,
    said: [B, BR, { text: BROKEN, inTransaction: true }],
    seen: [{ tenant: null, chat: null }],
    rows: [0, 0, 0]
  })
})

// One transaction, proved at the last write (lead, ec-d2eh7h, W9)
// ---------------------------------------------------------------
// When the transaction's last write breaks and beforeWrite's row goes with
// it, each statement between them ran in that one transaction, wherever a
// split would be. Each case finds that write itself, from a run with
// nothing broken, and says which statement it is today: a write that a
// later change puts after it fails the case, and is seen.

// A write of SQL: an insert, an update or a delete.
const WRITES = /^\s*(insert|update|delete)\b/i

// The last write that ran inside a transaction after the first
// `BEFORE_ROW`: of the statements after it, up to the first one outside a
// transaction or the next `BEFORE`, which opens the next guarded write's
// transaction (the launch's end, after its commit).
const lastWrite = (said: ReadonlyArray<Said>): string | undefined => {
  const at = said.findIndex((one) => one.text === BEFORE_ROW)
  if (at < 0) return undefined
  let last: string | undefined
  for (const one of said.slice(at + 1)) {
    if (!one.inTransaction || one.text === BEFORE) break
    if (WRITES.test(one.text)) last = one.text
  }
  return last
}

// Breaks the statement `text`, once, after `BEFORE_ROW` ran.
const atWrite = (text: string | undefined) => (seen: string, said: ReadonlyArray<Said>) =>
  seen === text && said.some((one) => one.text === BEFORE_ROW) && !said.some((one) => one.text === BROKEN)

// The rows that a launch or a make writes, but the launches: a count of
// each table.
const written = (file: string) => Object.fromEntries(["tenant", "chat", "pick"].map((table) => [table, rows<{ n: number }>(file, `select count(*) as n from everchat_${table}`)[0]!.n]))

test("the launch (W9): not armed, the last write of the launch's transaction breaks (the insert of its launch, found from a run with nothing broken); the launch fails with its StoreError and beforeWrite's row goes with it, on a new file (no tenant, chat, pick or launch) and on one whose launch of before is not ended (it stays not ended, the picks as they were)", async () => {
  // A new file, or one whose first launch's end is undone: a crash, whose
  // close is a write of the transaction too.
  const files = {
    new: async () => newFile(),
    crashed: async () => {
      const file = newFile()
      await withStore(file, Effect.void)
      write(file, "update everchat_launch set ended = null, why = null")
      return file
    }
  }
  const got: Array<unknown> = []
  for (const [kind, made] of Object.entries(files)) {
    // Whole: the transaction's last write.
    const heard: Array<Said> = []
    const whole = await launched(await made(), counting(true).dialect, hearing(heard), taken)
    const last = lastWrite(heard)
    // Broken at it, on a file of the same kind.
    const file = await made()
    // A new file is not there before its launch.
    const before = kind === "new" ? null : { launches: rows(file, "select n, ended, why from everchat_launch"), picks: rows(file, "select * from everchat_pick"), counts: written(file) }
    const counted = counting(true)
    const said: Array<Said> = []
    const exit = await launched(file, counted.dialect, hearing(said, atWrite(last)), taken)
    got.push({
      kind,
      whole: Exit.isSuccess(whole),
      last,
      broken: Exit.isFailure(exit) ? brokenBy(Cause.squash(exit.cause), "launch") : "it did not fail",
      at: said.findIndex((one) => one.text === BROKEN) > said.findIndex((one) => one.text === BEFORE_ROW) && said.find((one) => one.text === BROKEN)?.inTransaction,
      seen: counted.state.seen,
      rows: beforeRowsIn(file),
      after: { launches: rows(file, "select n, ended, why from everchat_launch"), picks: rows(file, "select * from everchat_pick"), counts: written(file) },
      before
    })
  }
  const insert = SQLITE_LAUNCH[SQLITE_LAUNCH.length - 1]!.text
  expect(insert.startsWith("insert into everchat_launch ")).toBe(true)
  const crashed = { launches: [{ n: 1, ended: null, why: null }], picks: (got[1] as { before: { picks: unknown } }).before.picks, counts: { tenant: 1, chat: 1, pick: 1 } }
  expect(got).toEqual([
    {
      kind: "new",
      whole: true,
      last: insert,
      broken: true,
      at: true,
      seen: [{ tenant: null, chat: null }],
      rows: 0,
      after: { launches: [], picks: [], counts: { tenant: 0, chat: 0, pick: 0 } },
      before: null
    },
    { kind: "crashed", whole: true, last: insert, broken: true, at: true, seen: [{ tenant: null, chat: null }], rows: 0, after: crashed, before: crashed }
  ])
})

test("the make (W9): not armed, the last write of the make's transaction breaks (the insert of its chat, found from a run with nothing broken); the make fails with its StoreError, beforeWrite's row goes with it, and no tenant, pick or chat is written", async () => {
  // `Chats.make` of TENANT_A on `file`: its exit and its statements (the
  // file's open is not the make's), `breaks` asked only for the make's.
  const making = async (file: string, breaks?: (text: string, said: ReadonlyArray<Said>) => boolean) => {
    const counted = counting(true)
    const said: Array<Said> = []
    let on = false
    let at = -1
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const chats = yield* Chats
      at = said.length
      on = true
      return yield* Effect.exit(chats.make(TENANT_A, PICK))
    })).pipe(
      Effect.provide(chatsLayerNoDatabase.pipe(Layer.provideMerge(Database.layer(file)))),
      Effect.provideService(Statement.CurrentTransformer, hearing(said, breaks === undefined ? undefined : (text, heard) => on && breaks(text, heard))),
      Effect.provideService(Dialect, counted.dialect)
    ))
    return { exit, said: said.slice(at), seen: counted.state.seen }
  }
  const whole = await making(newFile())
  const last = lastWrite(whole.said)
  const file = newFile()
  const broken = await making(file, atWrite(last))
  const insert = SQLITE_MAKE.find((one) => one.text.startsWith("insert into everchat_chat "))!.text
  expect({
    whole: Exit.isSuccess(whole.exit),
    last,
    broken: Exit.isFailure(broken.exit) ? brokenBy(Cause.squash(broken.exit.cause), "make") : "it did not fail",
    at: broken.said.findIndex((one) => one.text === BROKEN) > broken.said.findIndex((one) => one.text === BEFORE_ROW) && broken.said.find((one) => one.text === BROKEN)?.inTransaction,
    seen: broken.seen,
    rows: beforeRowsIn(file),
    counts: written(file)
  }).toEqual({
    whole: true,
    last: insert,
    broken: true,
    at: true,
    seen: [{ tenant: null, chat: null }],
    rows: 0,
    counts: { tenant: 0, chat: 0, pick: 0 }
  })
})

test("SQLite's dialect (W6): the launch's transaction, Chats.make and Chats.store run the statements of before ec-9qt2rc, with no beforeWrite", async () => {
  const file = newFile()
  await withStore(file, Effect.void)
  const said: Array<Said> = []
  const exit = await launched(file, null, hearing(said), taken)
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(unpragma(said)).toEqual([...SQLITE_LAUNCH, { text: END, inTransaction: false }])
  const other = newFile()
  expect(await madeWith(other, null)).toEqual({ make: [...SQLITE_MAKE], store: [...SQLITE_STORE], armed: "done" })
})

// Writes after a guarded write's COMMIT (lead, ec-9e7436, W1)
// -----------------------------------------------------------

// The store's transaction with `first` and a callback of `sql.afterCommit`
// that runs `then` (armed first when `arm`): what each part ran, the
// statements, and the beforeWrite calls. The callback's exit is kept.
const committed = <A>(
  dialect: ReturnType<typeof counting> | null,
  arm: boolean,
  first: (s: StoreService) => Effect.Effect<unknown, unknown>,
  then: (s: StoreService, sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>,
  read: (s: StoreService) => Effect.Effect<unknown, unknown>
) => {
  const file = newFile()
  return withDialect(file, dialect === null ? null : dialect.dialect, Effect.gen(function*() {
    const store = yield* Store
    const sql = yield* SqlClient.SqlClient
    // The launch's beforeWrite, with no chat (ec-9qt2rc, W6), is not this
    // helper's.
    if (dialect !== null) dialect.state.seen.length = 0
    const said: Array<Said> = []
    // Where the callback's statements start in `said`.
    let at = -1
    let callback: Exit.Exit<A, unknown> | undefined
    const before = yield* read(store)
    const outer = yield* Effect.exit(listened(sql, said, store.transaction(Effect.andThen(
      first(store),
      sql.afterCommit(Effect.gen(function*() {
        at = said.length
        if (dialect !== null && arm) dialect.state.fail = true
        callback = yield* Effect.exit(then(store, sql))
      }))
    ))))
    if (dialect !== null) dialect.state.fail = false
    return {
      outer: Exit.isSuccess(outer),
      callback: callback === undefined ? "never ran" : Exit.isSuccess(callback) ? "done" : Cause.squash(callback.cause),
      first: said.slice(0, at),
      after: said.slice(at),
      seen: dialect === null ? 0 : dialect.state.seen.length,
      before,
      read: yield* read(store)
    }
  }))
}

// The error of a member whose beforeWrite refused: the member's own
// StoreError, the refusal as its cause.
const refusedBy = (error: unknown, op: string) => error instanceof StoreError && error.op === op && error.cause === refusal

const goalOf = (s: StoreService) => Effect.map(s.chat, (chat) => chat.goal)
const countOf = (s: StoreService) => s.count
const GOAL = "update everchat_chat set goal = ?, updated = ? where tenant = ? and id = ?"

test("a statement member after the COMMIT: a write in a callback of sql.afterCommit runs beforeWrite again, as the first statement of a transaction of its own; armed, it fails with the refusal, the goal is as before, and what the first transaction wrote stays", async () => {
  const first = (s: StoreService) => s.append([{ kind: "user", text: "in the first" }])
  const plain = await committed(counting(), false, first, (s) => s.setGoal("after the commit"), goalOf)
  expect(plain.outer).toBe(true)
  expect(plain.callback).toBe("done")
  expect(plain.seen).toBe(2)
  expect(plain.first[0]).toEqual({ text: BEFORE, inTransaction: true })
  expect(plain.after).toEqual([{ text: BEFORE, inTransaction: true }, { text: GOAL, inTransaction: true }])
  expect(plain.read).toBe("after the commit")
  const armed = await committed(counting(), true, first, (s) => s.setGoal("after the commit"), (s) => Effect.all([goalOf(s), countOf(s)]))
  expect(armed.outer).toBe(true)
  expect(refusedBy(armed.callback, "setGoal")).toBe(true)
  expect(armed.seen).toBe(2)
  expect(armed.after).toEqual([{ text: BEFORE, inTransaction: true }])
  // The goal as before; the first transaction's message stays.
  expect(armed.before).toEqual([null, 0])
  expect(armed.read).toEqual([null, 1])
})

test("a transaction member after the COMMIT: append in a callback of sql.afterCommit runs beforeWrite again, first in its own transaction; armed, it fails with the refusal and writes nothing, and the first transaction's message stays", async () => {
  const first = (s: StoreService) => s.append([{ kind: "user", text: "in the first" }])
  const then = (s: StoreService) => s.append([{ kind: "user", text: "after the commit" }])
  const plain = await committed(counting(), false, first, then, countOf)
  expect([plain.outer, plain.callback, plain.seen]).toEqual([true, "done", 2])
  expect(plain.after[0]).toEqual({ text: BEFORE, inTransaction: true })
  expect(plain.after.length).toBeGreaterThan(1)
  expect(plain.after.every((one) => one.inTransaction)).toBe(true)
  expect([plain.before, plain.read]).toEqual([0, 2])
  const armed = await committed(counting(), true, first, then, countOf)
  expect(armed.outer).toBe(true)
  expect(refusedBy(armed.callback, "append")).toBe(true)
  expect(armed.after).toEqual([{ text: BEFORE, inTransaction: true }])
  expect([armed.before, armed.read]).toEqual([0, 1])
})

test("a callback that registers afterCommit again: three guarded writes, beforeWrite three times, each the first statement of its own transaction", async () => {
  const counted = counting()
  const got = await committed(
    counted,
    false,
    (s) => s.setGoal("first"),
    (s, sql) =>
      s.transaction(Effect.andThen(
        s.setDraft("second"),
        sql.afterCommit(Effect.asVoid(Effect.exit(s.setTaken(0))))
      )),
    (s) => Effect.map(s.chat, (chat) => [chat.goal, chat.draft, chat.taken])
  )
  expect([got.outer, got.callback, got.seen]).toEqual([true, "done", 3])
  const all = [...got.first, ...got.after]
  expect(all).toEqual([
    { text: BEFORE, inTransaction: true },
    { text: GOAL, inTransaction: true },
    { text: BEFORE, inTransaction: true },
    { text: "update everchat_chat set draft = ?, updated = ? where tenant = ? and id = ?", inTransaction: true },
    { text: BEFORE, inTransaction: true },
    { text: "update everchat_chat set taken = ?, updated = ? where tenant = ? and id = ?", inTransaction: true }
  ])
  expect(got.read).toEqual(["first", "second", 0])
})

test("a callback that opens the client's transaction itself and writes in it: beforeWrite runs in it before each member's first statement; armed, nothing of it is written", async () => {
  const then = (s: StoreService, sql: SqlClient.SqlClient) => sql.withTransaction(Effect.andThen(s.setGoal("in the callback's own"), s.append([{ kind: "user", text: "in the callback's own" }])))
  const read = (s: StoreService) => Effect.all([goalOf(s), countOf(s)])
  const plain = await committed(counting(), false, (s) => s.setDraft("first"), then, read)
  // Each of its two writes is an outermost write of the store: each runs
  // beforeWrite, in its savepoint, before its first statement.
  expect([plain.outer, plain.callback, plain.seen]).toEqual([true, "done", 3])
  expect(plain.after.slice(0, 3)).toEqual([{ text: BEFORE, inTransaction: true }, { text: GOAL, inTransaction: true }, { text: BEFORE, inTransaction: true }])
  expect(plain.after.filter((one) => one.text === BEFORE).length).toBe(2)
  expect(plain.after.every((one) => one.inTransaction)).toBe(true)
  expect(plain.read).toEqual(["in the callback's own", 1])
  const armed = await committed(counting(), true, (s) => s.setDraft("first"), then, read)
  expect(armed.outer).toBe(true)
  expect(refusedBy(armed.callback, "setGoal")).toBe(true)
  expect(armed.after).toEqual([{ text: BEFORE, inTransaction: true }])
  expect(armed.read).toEqual([null, 0])
})

test("SQLite's dialect: a setGoal in a callback of sql.afterCommit is the one update, in no transaction, as for a plain call", async () => {
  const got = await committed(null, false, (s) => s.setDraft("first"), (s) => s.setGoal("after the commit"), goalOf)
  expect([got.outer, got.callback]).toEqual([true, "done"])
  expect(got.after).toEqual([{ text: GOAL, inTransaction: false }])
  expect(got.read).toBe("after the commit")
})

test("two stores on one client: a write of chat B inside chat A's guarded transaction runs B's beforeWrite, with B's tenant and chat; A's runs once", async () => {
  const file = newFile()
  const counted = counting()
  const got = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const chats = yield* Chats
    const sql = yield* SqlClient.SqlClient
    const a = yield* chats.store(TENANT_A, yield* chats.make(TENANT_A, PICK), LAUNCH)
    const b = yield* chats.store(TENANT_B, yield* chats.make(TENANT_B, PICK), LAUNCH)
    counted.state.seen.length = 0
    const said: Array<Said> = []
    yield* listened(sql, said, a.transaction(Effect.all([a.setGoal("A's"), b.setGoal("B's"), a.setDraft("A's")])))
    const armed = yield* Effect.exit(a.transaction(Effect.andThen(a.setGoal("A's again"), Effect.suspend(() => {
      counted.state.fail = true
      return b.setGoal("B's again")
    }))))
    counted.state.fail = false
    return {
      seen: counted.state.seen.map((one) => one.chat),
      tenants: counted.state.seen.slice(0, 2).map((one) => one.tenant),
      marks: said.filter((one) => one.text === BEFORE).length,
      armed: Exit.isFailure(armed) && refusedBy(Cause.squash(armed.cause), "setGoal"),
      goals: [(yield* a.chat).goal, (yield* b.chat).goal]
    }
  })).pipe(
    Effect.provide(chatsLayerNoDatabase.pipe(Layer.provideMerge(Database.layer(file)))),
    Effect.provideService(Dialect, counted.dialect)
  ))
  // A's transaction, then B's write inside it; then A's again, B's again.
  expect(got.seen).toEqual([1, 2, 1, 2])
  expect(got.tenants).toEqual([TENANT_A.replaceAll("-", ""), TENANT_B.replaceAll("-", "")])
  expect(got.marks).toBe(2)
  // B's refusal fails A's transaction whole.
  expect(got.armed).toBe(true)
  expect(got.goals).toEqual(["A's", "B's"])
})
