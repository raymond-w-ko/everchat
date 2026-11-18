// Tests of the database: the schema that an empty file gets, the files that
// it refuses, the pragmas, and the writes that the schema must refuse.

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as fs from "node:fs"
import * as path from "node:path"
import { newFile, rows, write } from "../tests/help.ts"
import * as Database from "./database.ts"
import { schema, VERSION } from "./schema.ts"
import { DatabaseVersion, Kind, KINDS, StoreError } from "@everchat/core/store"

const withDatabase = <A, E>(file: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layer(file))))

// The names of the page's block (docs/schema.html, section 8).
const TABLES = [
  "everchat_approval",
  "everchat_call",
  "everchat_chat",
  "everchat_event",
  "everchat_head",
  "everchat_image",
  "everchat_kind",
  "everchat_launch",
  "everchat_log",
  "everchat_msg",
  "everchat_msg_image",
  "everchat_node",
  "everchat_pick",
  "everchat_tenant",
  "everchat_turn",
  "everchat_turn_item",
  "everchat_usage",
  "everchat_view",
  "everchat_wake"
]

const TRIGGERS = [
  "everchat_approval_no_delete",
  "everchat_approval_no_move",
  "everchat_approval_no_new_answer",
  "everchat_approval_no_new_call",
  "everchat_approval_no_new_msg",
  "everchat_approval_status_order",
  "everchat_call_no_move",
  "everchat_chat_no_delete",
  "everchat_chat_no_move",
  "everchat_chat_no_rowid",
  "everchat_event_no_delete",
  "everchat_event_no_update",
  "everchat_head_no_update",
  "everchat_image_no_update",
  "everchat_kind_no_delete",
  "everchat_kind_no_update",
  "everchat_launch_no_move",
  "everchat_log_no_update",
  "everchat_msg_image_no_delete",
  "everchat_msg_image_no_update",
  "everchat_msg_no_delete",
  "everchat_msg_no_update",
  "everchat_node_no_delete",
  "everchat_node_no_update",
  "everchat_pick_no_delete",
  "everchat_pick_no_update",
  "everchat_tenant_no_update",
  "everchat_turn_item_no_update",
  "everchat_turn_no_move",
  "everchat_turn_no_new_ceiling",
  "everchat_usage_no_update",
  "everchat_view_no_move",
  "everchat_wake_no_move",
  "everchat_wake_no_new_make"
]

const INDEXES = [
  "everchat_approval_pending",
  "everchat_call_parent",
  "everchat_call_running",
  "everchat_call_vendor",
  "everchat_chat_tenant",
  "everchat_event_msg",
  "everchat_launch_live",
  "everchat_msg_sender_key",
  "everchat_turn_running",
  "everchat_wake_due"
]

// The names in the file, of one type, but SQLite's own.
const names = (file: string, type: string) =>
  rows<{ name: string }>(file, `select name from sqlite_master where type = '${type}' order by name`)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"))

// The file's mark, and each of its names with its type and its SQL.
const state = (file: string) => ({
  mark: rows<{ user_version: number }>(file, "pragma user_version")[0]?.user_version,
  master: rows(file, "select type, name, sql from sqlite_master order by type, name")
})

// The error of an open of `file`.
const refusal = (file: string) => Effect.runPromise(Effect.flip(Effect.void.pipe(Effect.provide(Database.layer(file)))))

// The files of SQLite's journal that stand beside `file`.
const beside = (file: string) => ["-wal", "-shm", "-journal"].filter((end) => fs.existsSync(file + end))

// The journal mode of `file`, read with no connection that could change it:
// bytes 18 and 19 of the header are 2 in WAL mode, 1 in a rollback mode.
const walHeader = (file: string) => {
  const bytes = fs.readFileSync(file)
  return bytes[18] === 2 && bytes[19] === 2
}

// A file of this schema, with a row, in DELETE mode, with the mark `mark`.
const oldFile = async (mark: number) => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  write(file, "pragma journal_mode = delete")
  write(file, "insert into everchat_pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 1)")
  write(file, `pragma user_version = ${mark}`)
  return file
}

test("a new file gets the whole schema of the page, and the mark: 19 tables, 34 triggers, 10 indexes, 1 view, each table strict", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  expect(names(file, "table")).toEqual(TABLES)
  expect(names(file, "trigger")).toEqual(TRIGGERS)
  expect(names(file, "index")).toEqual(INDEXES)
  expect(names(file, "view")).toEqual(["everchat_msg_read"])
  expect([TABLES.length, TRIGGERS.length, INDEXES.length]).toEqual([19, 34, 10])
  expect(VERSION).toBe(8)
  expect(rows(file, "pragma user_version")).toEqual([{ user_version: VERSION }])
  const strict = rows<{ name: string; strict: number }>(file, "select name, strict from pragma_table_list where schema = 'main' and type = 'table'")
    .filter((row) => !row.name.startsWith("sqlite_"))
  expect(strict.map((row) => [row.name, row.strict]).sort()).toEqual(TABLES.map((name) => [name, 1]))
  // The table of usage has the column of the expected reads from the cache.
  expect(rows<{ name: string }>(file, "select name from pragma_table_info('everchat_usage')").map((row) => row.name)).toContain("expected")
})

test("the rule of created and updated, read from the file: each table has updated or ended, or its no_update trigger, never both and never neither", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  const triggers = new Set(names(file, "trigger"))
  const seen = TABLES.map((table) => {
    const columns = rows<{ name: string }>(file, `select name from pragma_table_info('${table}')`).map((row) => row.name)
    const changes = columns.includes("updated") || columns.includes("ended")
    return [table, changes, triggers.has(table + "_no_update")]
  })
  expect(seen.filter(([, changes, refuses]) => changes === refuses)).toEqual([])
  // Twelve tables refuse an update, and seven may change (the chat's row
  // and the six tables of a chat whose rows may change).
  expect(seen.filter(([, , refuses]) => refuses).length).toBe(12)
  expect(seen.filter(([, changes]) => changes).map(([table]) => table)).toEqual([
    "everchat_approval",
    "everchat_call",
    "everchat_chat",
    "everchat_launch",
    "everchat_turn",
    "everchat_view",
    "everchat_wake"
  ])
})

test("every name of ours in the file starts with everchat_: each table, the view, each index and each trigger", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  const all = rows<{ type: string; name: string }>(file, "select type, name from sqlite_master").filter((row) => !row.name.startsWith("sqlite_"))
  expect(new Set(all.map((row) => row.type))).toEqual(new Set(["table", "view", "index", "trigger"]))
  expect(all.filter((row) => !row.name.startsWith("everchat_"))).toEqual([])
  // One name for each statement that makes one: none built from a prefix.
  expect(all.length).toBe(schema.filter((statement) => /^\s*create /.test(statement)).length)
})

test("every table of ours is strict", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  const loose = rows<{ name: string; strict: number }>(file, "select name, strict from pragma_table_list where schema = 'main' and type = 'table'")
    .filter((row) => row.strict === 0 && !row.name.startsWith("sqlite_"))
    .map((row) => row.name)
  expect(loose).toEqual([])
})

test("the connection is in WAL mode, with full sync, checked references and recursive triggers", async () => {
  const pragmas = await withDatabase(
    newFile(),
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      return [
        yield* sql.unsafe("pragma journal_mode"),
        yield* sql.unsafe("pragma synchronous"),
        yield* sql.unsafe("pragma foreign_keys"),
        yield* sql.unsafe("pragma recursive_triggers")
      ]
    })
  )
  expect(pragmas).toEqual([[{ journal_mode: "wal" }], [{ synchronous: 2 }], [{ foreign_keys: 1 }], [{ recursive_triggers: 1 }]])
})

test("a second open of a file with the mark changes nothing in its schema and keeps the data", async () => {
  const file = newFile()
  const insert = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into everchat_pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 1)`
  })
  await withDatabase(file, insert)
  const first = state(file)
  await withDatabase(file, Effect.void)
  expect(state(file)).toEqual(first)
  expect(rows(file, "select vendor from everchat_pick")).toEqual([{ vendor: "v" }])
})

test("a file with tables and no mark, as Effect's migrator left it, is refused, and not changed", async () => {
  const file = newFile()
  // Tables of the old names, as the migrator made them, and no mark.
  write(file, "create table pick (id integer primary key, vendor text not null) strict")
  write(file, "create table chat (id integer primary key check (id = 1), pick integer not null references pick (id)) strict")
  const bytes = fs.readFileSync(file)
  const before = state(file)
  const refused = await refusal(file)
  expect(refused).toBeInstanceOf(DatabaseVersion)
  expect(refused._tag === "DatabaseVersion" ? [refused.have, refused.want, refused.file] : null).toEqual([0, VERSION, file])
  expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  expect(state(file)).toEqual(before)
})

test("a file of mark 7, the schema before the wake-ups, and one of mark 6, before the approvals, are refused, and not changed; a new file has mark 8", async () => {
  for (const mark of [7, 6]) {
    const file = newFile()
    await withDatabase(file, Effect.void)
    expect(rows(file, "pragma user_version")).toEqual([{ user_version: 8 }])
    write(file, `pragma user_version = ${mark}`)
    const bytes = fs.readFileSync(file)
    const refused = await refusal(file)
    expect(refused._tag === "DatabaseVersion" ? [refused.have, refused.want] : null).toEqual([mark, 8])
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  }
})

test("a file with another mark is refused, and not changed", async () => {
  for (const mark of [VERSION - 1, VERSION + 1]) {
    const file = newFile()
    await withDatabase(file, Effect.void)
    write(file, `pragma user_version = ${mark}`)
    const bytes = fs.readFileSync(file)
    const before = state(file)
    const refused = await refusal(file)
    expect(refused).toBeInstanceOf(DatabaseVersion)
    expect(refused._tag === "DatabaseVersion" ? [refused.have, refused.want] : null).toEqual([mark, VERSION])
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)
    expect(state(file)).toEqual(before)
  }
})

test(`a refused file in DELETE mode, with rows, keeps its bytes and its mode, and gets no file beside it: marks 0, ${VERSION - 1} and ${VERSION + 1}, and a backup`, async () => {
  // Mark 0: tables of the old names, a row, and no mark.
  const none = newFile()
  write(none, "create table pick (id integer primary key, vendor text not null) strict")
  write(none, "insert into pick (vendor) values ('v')")
  // A backup, as a person makes one: `vacuum into` of a file in WAL mode.
  const live = await oldFile(VERSION - 1)
  write(live, "pragma journal_mode = wal")
  const backup = live + ".backup"
  write(live, `vacuum into '${backup}'`)
  const files = [none, await oldFile(VERSION - 1), await oldFile(VERSION + 1), backup]
  for (const file of files) {
    const mark = rows<{ user_version: number }>(file, "pragma user_version")[0]!.user_version
    const bytes = fs.readFileSync(file)
    expect([file, walHeader(file), beside(file)]).toEqual([file, false, []])
    const refused = await refusal(file)
    expect(refused._tag === "DatabaseVersion" ? [refused.have, refused.file] : null).toEqual([mark, file])
    expect([file, fs.readFileSync(file).equals(bytes), beside(file)]).toEqual([file, true, []])
    expect(rows(file, "pragma journal_mode")).toEqual([{ journal_mode: "delete" }])
  }
})

test("a refused file in WAL mode keeps its bytes", async () => {
  const file = await oldFile(VERSION + 1)
  write(file, "pragma journal_mode = wal")
  expect(walHeader(file)).toBe(true)
  const bytes = fs.readFileSync(file)
  const refused = await refusal(file)
  expect(refused).toBeInstanceOf(DatabaseVersion)
  expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  expect(beside(file)).toEqual([])
})

test("a new file, and a file with the mark in DELETE mode, are in WAL mode after the open", async () => {
  const fresh = newFile()
  await withDatabase(fresh, Effect.void)
  expect(rows(fresh, "pragma journal_mode")).toEqual([{ journal_mode: "wal" }])
  const marked = await oldFile(VERSION)
  expect(rows(marked, "pragma journal_mode")).toEqual([{ journal_mode: "delete" }])
  await withDatabase(marked, Effect.void)
  expect(rows(marked, "pragma journal_mode")).toEqual([{ journal_mode: "wal" }])
  expect(rows(marked, "select vendor from everchat_pick")).toEqual([{ vendor: "v" }])
})

test("a clean close leaves one file", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  expect(fs.readdirSync(path.dirname(file))).toEqual([Database.FILE])
})

test("the kinds in the table are the kinds in the code", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  const table = rows<{ id: number; name: string }>(file, "select id, name from everchat_kind order by id")
  expect(table).toEqual(Object.entries(KINDS).map(([name, id]) => ({ id, name })))
  expect(table.map((row) => row.name)).toEqual([...Kind.literals])
  // The kind counts toward a node's 512 bytes, so every kind has 4 letters.
  expect(table.every((row) => row.name.length === 4)).toBe(true)
})

// The page's block (docs/schema.html, section 8, `<pre id="ddl-sqlite">`)
// and the code's statements: the same statements in the same order, white
// space apart, once the two pragmas at the head of the block are left out
// (they hold for a connection, and database.ts sets them).
test("the DDL of the page is the code's schema, statement for statement and in its order", () => {
  const page = fs.readFileSync(path.join(import.meta.dir, "..", "..", "..", "docs", "schema.html"), "utf8")
  const block = page.match(/<pre id="ddl-sqlite"><code>([\s\S]*?)<\/code><\/pre>/)?.[1]
  expect(block).toBeDefined()
  const squeeze = (text: string) => text.replace(/\s+/g, " ").trim()
  const statements = block!
    .replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
    .split("\n").filter((line) => !line.startsWith("--")).join("\n")
    .split(/;\s*$/m).map(squeeze).filter((statement) => statement !== "")
  expect(statements.slice(0, 2)).toEqual(["pragma foreign_keys = on", "pragma recursive_triggers = on"])
  expect(statements.slice(2)).toEqual(schema.map(squeeze))
})

// The tenant of the rows below, and the chat's UUID: 16 bytes each. Then a
// second tenant, its chat's UUID, and the UUID of a third chat.
const TENANT = "x'00112233445566778899aabbccddeeff'"
const UUID = "x'0123456789abcdef0123456789abcdef'"
const OTHER = "x'ffeeddccbbaa99887766554433221100'"
const UUID2 = "x'2222222222222222222222222222222a'"
const UUID3 = "x'3333333333333333333333333333333a'"

// Rows that the refused writes below build on, most of chat 1. Each one is
// valid. Chat 2, of another tenant, has its own launch, head, turn, call and
// view, so that a move of a row of chat 1 into it finds the row's parents and
// reaches the guard, not a missing parent; chat 3, of the first tenant, has no
// rows. Chat 1's launch 3 and turn 3 have no child, as its call 2 has none.
// Chat 1's launch 4 and its turn 4 hold the approvals: a program (call 4)
// and three of its functions that wait (calls 5, 6 and 7), whose approvals
// are 1, pending, 2, answered no, with the message that told the chat of
// it, and 3, pending, the target of the refused changes of state only.
// Chat 1's turn 5 runs with a ceiling. Chat 1's wake-ups: 1, a routine that
// the program of turn 4 (call 4) made, and 2, a reminder made otherwise;
// chat 2 has its own wake-up 1.
const BASE = [
  `insert into everchat_pick (id, vendor, model, effort, speed, created) values (1, 'v', 'm', 'e', 's', 1)`,
  `insert into everchat_tenant (id, created) values (${TENANT}, 1)`,
  `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (1, ${TENANT}, ${UUID}, 1, 1, 1)`,
  `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (1, 1, 10, 'h', '/', '0', 't', 1)`,
  `insert into everchat_head (chat, n, hash, body, created) values (1, 1, 'abc', '{}', 1)`,
  `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created) values (1, 1, 'running', 1, 1, 0, 1, 1)`,
  `insert into everchat_turn_item (chat, turn, n, kind, body, created) values (1, 1, 0, 'user', '{}', 1)`,
  `insert into everchat_call (chat, n, turn, vendor_id, fn, input, status, launch, created) values (1, 1, 1, 'call_a', 'run', 'x', 'running', 1, 1)`,
  `insert into everchat_call (chat, n, turn, parent, fn, input, status, launch, created) values (1, 2, 1, 1, 'shell', '{}', 'running', 1, 1)`,
  `insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 0, 1, 'hello', 5, 1, 1)`,
  `insert into everchat_node (chat, l, i, text, size, created) values (1, 0, 0, 'user: hello', 11, 1)`,
  `insert into everchat_view (chat, name, parts, created, updated) values (1, 'chat', '[[0,0]]', 1, 1)`,
  `insert into everchat_image (chat, n, name, type, width, height, source, created, bytes) values (1, 1, 'a.png', 'image/png', 1, 1, 'person', 1, x'00')`,
  `insert into everchat_image (chat, n, name, type, width, height, source, created, bytes) values (1, 2, 'b.png', 'image/png', 1, 1, 'person', 1, x'00')`,
  `insert into everchat_msg_image (chat, msg, n, image) values (1, 0, 0, 2)`,
  `insert into everchat_usage (chat, n, served, pick, input, cache_read, cache_write, output, created) values (1, 1, 'turn', 1, 1, 0, 0, 1, 1)`,
  `insert into everchat_log (chat, n, level, source, text, launch, created) values (1, 1, 'info', 's', 't', 1, 1)`,
  `insert into everchat_event (chat, n, type, msg, msg_last, created) values (1, 1, 'accepted', 0, 0, 1)`,
  `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created, ended, why) values (1, 3, 9, 'h', '/', '0', 't', 1, 1, 'exit')`,
  `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, ended) values (1, 3, 'done', 1, 1, 0, 1, 1, 1)`,
  `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created, ended, why) values (1, 4, 8, 'h', '/', '0', 't', 1, 1, 'exit')`,
  `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, ended) values (1, 4, 'done', 1, 1, 0, 4, 1, 1)`,
  `insert into everchat_call (chat, n, turn, vendor_id, fn, input, output, status, launch, created, ended) values (1, 4, 4, 'call_c', 'run', 'x', 'ok', 'done', 4, 1, 1)`,
  `insert into everchat_call (chat, n, turn, parent, fn, input, output, status, launch, created, ended) values (1, 5, 4, 4, 'send', '{"to":"x"}', 'waits as approval 1', 'pending', 4, 1, 1)`,
  `insert into everchat_call (chat, n, turn, parent, fn, input, output, status, launch, created, ended) values (1, 6, 4, 4, 'send', '{"to":"y"}', 'waits as approval 2', 'pending', 4, 1, 1)`,
  `insert into everchat_approval (chat, n, turn, call, fn, input, status, created, updated) values (1, 1, 4, 5, 'send', '{"to":"x"}', 'pending', 1, 1)`,
  `insert into everchat_approval (chat, n, turn, call, fn, input, status, who, answer, answered, msg, created, updated) values (1, 2, 4, 6, 'send', '{"to":"y"}', 'no', 'the person', 'not now', 2, 0, 1, 2)`,
  `insert into everchat_call (chat, n, turn, parent, fn, input, output, status, launch, created, ended) values (1, 7, 4, 4, 'send', '{"to":"w"}', 'waits as approval 3', 'pending', 4, 1, 1)`,
  `insert into everchat_approval (chat, n, turn, call, fn, input, status, created, updated) values (1, 3, 4, 7, 'send', '{"to":"w"}', 'pending', 1, 1)`,
  `insert into everchat_tenant (id, created) values (${OTHER}, 1)`,
  `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (2, ${OTHER}, ${UUID2}, 1, 1, 1)`,
  `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (3, ${TENANT}, ${UUID3}, 1, 1, 1)`,
  `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (2, 1, 20, 'h', '/', '0', 'u', 1)`,
  `insert into everchat_head (chat, n, hash, body, created) values (2, 1, 'abc', '{}', 1)`,
  `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created) values (2, 1, 'running', 1, 1, 0, 1, 1)`,
  `insert into everchat_call (chat, n, turn, vendor_id, fn, input, status, launch, created) values (2, 1, 1, 'call_a', 'run', 'x', 'running', 1, 1)`,
  `insert into everchat_view (chat, name, parts, created, updated) values (2, 'chat', '[[0,0]]', 1, 1)`,
  `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, steps, tokens) values (1, 5, 'running', 1, 1, 0, 1, 1, 20, 2000000)`,
  `insert into everchat_wake (chat, n, text, cron, zone, first, turn, call, due, created, updated) values (1, 1, 'stand up', '0 9 * * *', 'Europe/Berlin', 1000, 4, 4, 1000, 1, 1)`,
  `insert into everchat_wake (chat, n, text, at, zone, first, due, created, updated) values (1, 2, 'call back', 2000, 'UTC', 2000, 2000, 1, 1)`,
  `insert into everchat_wake (chat, n, text, at, zone, first, due, created, updated) values (2, 1, 'hers', 3000, 'UTC', 3000, 3000, 1, 1)`
]

// Each write that the schema must refuse, and a part of the error's text.
const REFUSED: ReadonlyArray<readonly [name: string, statement: string, error: string]> = [
  ["a tenant whose id is not 16 bytes", `insert into everchat_tenant (id, created) values (x'00', 1)`, "CHECK"],
  ["a change of a tenant", `update everchat_tenant set created = 2`, "everchat_tenant is append only"],
  ["a second chat with the same UUID", `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (4, ${TENANT}, ${UUID}, 1, 1, 1)`, "UNIQUE"],
  ["a chat whose UUID is not 16 bytes", `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (4, ${TENANT}, x'01', 1, 1, 1)`, "CHECK"],
  ["a chat of a tenant that is not there", `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (4, x'ffffffffffffffffffffffffffffffff', x'ffffffffffffffffffffffffffffffff', 1, 1, 1)`, "FOREIGN KEY"],
  ["a chat with a pick that is not there", `update everchat_chat set pick = 99`, "FOREIGN KEY"],
  ["a move of the chat to another tenant", `update everchat_chat set tenant = x'ffffffffffffffffffffffffffffffff'`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a change of the chat's UUID", `update everchat_chat set uuid = x'ffffffffffffffffffffffffffffffff'`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a change of the chat's id", `update everchat_chat set id = 4 where id = 1`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a change of the rowid of a chat with no rows", `update everchat_chat set rowid = 7 where id = 3`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a change of the oid of a chat with no rows", `update everchat_chat set oid = 7 where id = 3`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a change of the _rowid_ of a chat with no rows", `update everchat_chat set _rowid_ = 7 where id = 3`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a delete of the chat while its tenant is there", `delete from everchat_chat`, "everchat_chat is deleted only with its tenant"],
  ["a second live launch", `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (1, 2, 11, 'h', '/', '0', 't', 2)`, "UNIQUE"],
  ["a move of a launch to another tenant's chat", `update everchat_launch set chat = 2 where chat = 1 and n = 3`, "everchat_launch keeps its chat and its n"],
  ["a move of a launch onto another tenant's launch, with or replace", `update or replace everchat_launch set chat = 2, n = 1 where chat = 1 and n = 3`, "everchat_launch keeps its chat and its n"],
  ["a change of a launch's n", `update everchat_launch set n = 9 where chat = 1 and n = 3`, "everchat_launch keeps its chat and its n"],
  ["a move of a launch by the do update of an upsert", `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (1, 3, 9, 'h', '/', '0', 't', 1) on conflict (chat, n) do update set chat = 3`, "everchat_launch keeps its chat and its n"],
  ["a launch of a chat that is not there", `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (9, 1, 11, 'h', '/', '0', 't', 2)`, "FOREIGN KEY"],
  ["a second pick with the same values", `insert into everchat_pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 2)`, "UNIQUE"],
  ["a change of a pick", `update everchat_pick set vendor = 'w'`, "everchat_pick is append only"],
  ["a delete of a pick", `delete from everchat_pick`, "everchat_pick is append only"],
  ["a second head with the same hash", `insert into everchat_head (chat, n, hash, body, created) values (1, 2, 'abc', '{}', 2)`, "UNIQUE"],
  ["a change of a head", `update everchat_head set body = '[]'`, "everchat_head is append only"],
  ["a second kind with the same name", `insert into everchat_kind (id, name) values (9, 'user')`, "UNIQUE"],
  ["a change of a kind", `update everchat_kind set name = 'used'`, "everchat_kind is append only"],
  ["a delete of a kind", `delete from everchat_kind where id = 6`, "everchat_kind is append only"],

  ["a change of a message", `update everchat_msg set text = 'other' where i = 0`, "msg is append only"],
  ["a sender's key set on a message after its insert", `update everchat_msg set sender_key = 'key-late' where i = 0`, "msg is append only"],
  ["a delete of a message", `delete from everchat_msg where i = 0`, "msg is append only"],
  ["a message of a kind that is not there", `insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 1, 99, 'x', 1, 1, 1)`, "FOREIGN KEY"],
  ["a message of a launch that is not there", `insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 1, 1, 'x', 1, 99, 1)`, "FOREIGN KEY"],
  ["a message with a flag that is not 0 or 1", `insert into everchat_msg (chat, i, kind, text, size, more, launch, created) values (1, 1, 1, 'x', 1, 2, 1, 1)`, "CHECK"],
  ["a message with an id that is used", `insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 0, 1, 'x', 1, 1, 1)`, "UNIQUE"],
  ["a message whose text is not text", `insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 1, 1, x'00', 1, 1, 1)`, "cannot store BLOB"],
  ["a message with an image that is not there", `insert into everchat_msg_image (chat, msg, n, image) values (1, 0, 2, 99)`, "FOREIGN KEY"],
  ["a change of a message's image", `update everchat_msg_image set image = 1`, "everchat_msg_image is append only"],
  ["a delete of a message's image", `delete from everchat_msg_image`, "everchat_msg_image is append only"],
  ["a delete of an image that a message names", `delete from everchat_image where n = 2`, "everchat_msg_image is append only"],
  ["an image from an unknown source", `insert into everchat_image (chat, n, name, type, width, height, source, created, bytes) values (1, 3, 'c', 't', 1, 1, 'web', 1, x'00')`, "CHECK"],
  ["a change of an image", `update everchat_image set name = 'z.png' where n = 1`, "everchat_image is append only"],

  ["a change of a node", `update everchat_node set text = 'other' where l = 0 and i = 0`, "node is written once"],
  ["a delete of a node", `delete from everchat_node where l = 0 and i = 0`, "node is written once"],
  ["a second write of a node", `insert into everchat_node (chat, l, i, text, size, created) values (1, 0, 0, 'again', 5, 2)`, "UNIQUE"],
  ["a node below level 0", `insert into everchat_node (chat, l, i, text, size, created) values (1, -1, 0, 'x', 1, 1)`, "CHECK"],
  ["a node before message 0", `insert into everchat_node (chat, l, i, text, size, created) values (1, 0, -1, 'x', 1, 1)`, "CHECK"],
  ["a view with another name", `insert into everchat_view (chat, name, parts, created, updated) values (1, 'other', '[]', 1, 1)`, "CHECK"],
  ["a view with a flag that is not 0 or 1", `update everchat_view set batch = 2`, "CHECK"],
  ["a move of a view to a chat with no views", `update everchat_view set chat = 3 where chat = 1`, "everchat_view keeps its chat and its name"],
  ["a move of a view onto another tenant's view, with or replace", `update or replace everchat_view set chat = 2 where chat = 1`, "everchat_view keeps its chat and its name"],
  ["a change of a view's name", `update everchat_view set name = 'seen' where chat = 1`, "everchat_view keeps its chat and its name"],
  ["a move of a view by the do update of an upsert", `insert into everchat_view (chat, name, parts, created, updated) values (1, 'chat', '[]', 1, 1) on conflict (chat, name) do update set chat = 3`, "everchat_view keeps its chat and its name"],

  ["a turn with an unknown status", `update everchat_turn set status = 'paused'`, "CHECK"],
  ["a running turn with an end", `update everchat_turn set ended = 2`, "CHECK"],
  ["a done turn with no end", `update everchat_turn set status = 'done'`, "CHECK"],
  ["a turn on a pick that is not there", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created) values (1, 2, 'running', 99, 1, 0, 1, 1)`, "FOREIGN KEY"],
  ["a turn on a head that is not there", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created) values (1, 2, 'running', 1, 99, 0, 1, 1)`, "FOREIGN KEY"],
  ["a move of a turn to another tenant's chat", `update everchat_turn set chat = 2 where chat = 1 and n = 3`, "everchat_turn keeps its chat and its n"],
  ["a move of a turn onto another tenant's turn, with or replace", `update or replace everchat_turn set chat = 2, n = 1 where chat = 1 and n = 3`, "everchat_turn keeps its chat and its n"],
  ["a change of a turn's n", `update everchat_turn set n = 9 where chat = 1 and n = 3`, "everchat_turn keeps its chat and its n"],
  ["a move of a turn by the do update of an upsert", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, ended) values (1, 3, 'done', 1, 1, 0, 1, 1, 1) on conflict (chat, n) do update set chat = 3`, "everchat_turn keeps its chat and its n"],
  ["a change of a turn item", `update everchat_turn_item set body = '[]'`, "turn_item is append only"],
  ["a turn item of an unknown kind", `insert into everchat_turn_item (chat, turn, n, kind, body, created) values (1, 1, 2, 'tool', '{}', 1)`, "CHECK"],

  ["a program with no vendor id", `insert into everchat_call (chat, n, turn, fn, input, status, launch, created) values (1, 3, 1, 'run', 'x', 'running', 1, 1)`, "CHECK"],
  ["a function with a vendor id", `insert into everchat_call (chat, n, turn, parent, vendor_id, fn, input, status, launch, created) values (1, 3, 1, 1, 'call_b', 'shell', '{}', 'running', 1, 1)`, "CHECK"],
  ["two programs with one vendor id in a turn", `insert into everchat_call (chat, n, turn, vendor_id, fn, input, status, launch, created) values (1, 3, 1, 'call_a', 'run', 'x', 'running', 1, 1)`, "UNIQUE"],
  ["a running call with an end", `update everchat_call set ended = 2 where n = 1`, "CHECK"],
  ["a done call with no end", `update everchat_call set status = 'done' where n = 1`, "CHECK"],
  ["a call with an unknown status", `update everchat_call set status = 'lost' where n = 1`, "CHECK"],
  ["a move of a call to another tenant's chat", `update everchat_call set chat = 2 where chat = 1 and n = 2`, "everchat_call keeps its chat and its n"],
  ["a move of a call onto another tenant's call, with or replace", `update or replace everchat_call set chat = 2, n = 1 where chat = 1 and n = 2`, "everchat_call keeps its chat and its n"],
  ["a change of a call's n", `update everchat_call set n = 9 where chat = 1 and n = 2`, "everchat_call keeps its chat and its n"],
  ["a move of a call by the do update of an upsert", `insert into everchat_call (chat, n, turn, parent, fn, input, status, launch, created) values (1, 2, 1, 1, 'shell', '{}', 'running', 1, 1) on conflict (chat, n) do update set chat = 3`, "everchat_call keeps its chat and its n"],
  ["a pending call with no end", `update everchat_call set status = 'pending' where chat = 1 and n = 1`, "CHECK"],

  ["an approval of a call that is not there", `insert into everchat_approval (chat, n, turn, call, fn, input, status, created, updated) values (1, 9, 4, 99, 'send', '{}', 'pending', 1, 1)`, "FOREIGN KEY"],
  ["a second approval of one call", `insert into everchat_approval (chat, n, turn, call, fn, input, status, created, updated) values (1, 9, 4, 5, 'send', '{}', 'pending', 1, 1)`, "UNIQUE"],
  ["an approval with an unknown status", `insert into everchat_approval (chat, n, turn, call, fn, input, status, created, updated) values (1, 9, 4, 4, 'send', '{}', 'lost', 1, 1)`, "CHECK"],
  ["a pending approval with an answer's time", `update everchat_approval set answered = 2 where chat = 1 and n = 1`, "CHECK"],
  ["an answered approval with no answer's time", `update everchat_approval set status = 'no' where chat = 1 and n = 1`, "CHECK"],
  ["an approval that ended with no end", `insert into everchat_approval (chat, n, turn, call, fn, input, status, answered, created, updated) values (1, 9, 4, 4, 'send', '{}', 'done', 2, 1, 1)`, "CHECK"],
  ["an approval that did not end with an end", `insert into everchat_approval (chat, n, turn, call, fn, input, status, answered, ended, created, updated) values (1, 9, 4, 4, 'send', '{}', 'yes', 2, 2, 1, 1)`, "CHECK"],
  ["an expired approval that names who answered", `insert into everchat_approval (chat, n, turn, call, fn, input, status, who, answered, created, updated) values (1, 9, 4, 4, 'send', '{}', 'expired', 'the person', 2, 1, 1)`, "CHECK"],
  ["a move of an approval to another tenant's chat", `update everchat_approval set chat = 2 where chat = 1 and n = 1`, "everchat_approval keeps its chat and its n"],
  ["a move of an approval to another tenant's chat, with or replace", `update or replace everchat_approval set chat = 2 where chat = 1 and n = 2`, "everchat_approval keeps its chat and its n"],
  ["a change of an approval's n", `update everchat_approval set n = 9 where chat = 1 and n = 1`, "everchat_approval keeps its chat and its n"],
  ["a move of an approval by the do update of an upsert", `insert into everchat_approval (chat, n, turn, call, fn, input, status, created, updated) values (1, 1, 4, 5, 'send', '{}', 'pending', 1, 1) on conflict (chat, n) do update set chat = 3`, "everchat_approval keeps its chat and its n"],
  ["a change of an approval's turn", `update everchat_approval set turn = 1 where chat = 1 and n = 1`, "everchat_approval keeps its call as it was recorded"],
  ["a change of an approval's call", `update everchat_approval set call = 4 where chat = 1 and n = 1`, "everchat_approval keeps its call as it was recorded"],
  ["a change of an approval's function", `update everchat_approval set fn = 'shell' where chat = 1 and n = 1`, "everchat_approval keeps its call as it was recorded"],
  ["a change of an approval's input, the call that a yes runs", `update everchat_approval set input = '{"to":"z"}' where chat = 1 and n = 1`, "everchat_approval keeps its call as it was recorded"],
  ["a change of who answered, once answered", `update everchat_approval set who = 'someone else' where chat = 1 and n = 2`, "everchat_approval keeps its answer"],
  ["a change of the answer's text, once answered", `update everchat_approval set answer = 'yes, send it' where chat = 1 and n = 2`, "everchat_approval keeps its answer"],
  ["a change of the answer's time, once answered", `update everchat_approval set answered = 3 where chat = 1 and n = 2`, "everchat_approval keeps its answer"],
  ["a pending approval that runs with no yes", `update everchat_approval set status = 'running', answered = 3 where chat = 1 and n = 3`, "everchat_approval changes its status only in its order"],
  ["a pending approval that is done with no yes", `update everchat_approval set status = 'done', answered = 3, ended = 3 where chat = 1 and n = 3`, "everchat_approval changes its status only in its order"],
  ["a no that becomes a yes", `update everchat_approval set status = 'yes' where chat = 1 and n = 2`, "everchat_approval changes its status only in its order"],
  ["a change of the message that told the chat of the end, once set", `update everchat_approval set msg = null where chat = 1 and n = 2`, "everchat_approval keeps its msg"],
  ["a delete of an approval", `delete from everchat_approval where chat = 1 and n = 1`, "everchat_approval is kept for ever"],
  ["a delete of a call that an approval names", `delete from everchat_call where chat = 1 and n = 5`, "everchat_approval is kept for ever"],

  ["a change of a usage", `update everchat_usage set output = 2`, "usage is append only"],
  ["a usage that served an unknown thing", `insert into everchat_usage (chat, n, served, pick, input, cache_read, cache_write, output, created) values (1, 2, 'chat', 1, 1, 0, 0, 1, 1)`, "CHECK"],
  ["a log row of an unknown level", `insert into everchat_log (chat, n, level, source, text, launch, created) values (1, 2, 'fatal', 's', 't', 1, 1)`, "CHECK"],
  ["a change of a log row", `update everchat_log set text = 'other'`, "everchat_log is append only"],

  ["a change of an event", `update everchat_event set type = 'end'`, "everchat_event is append only"],
  ["a delete of an event", `delete from everchat_event`, "everchat_event is append only"],
  ["an event of an unknown type", `insert into everchat_event (chat, n, type, created) values (1, 2, 'text', 1)`, "CHECK"],
  ["an event with a first message and no last", `insert into everchat_event (chat, n, type, msg, created) values (1, 2, 'message', 0, 1)`, "CHECK"],
  ["an event whose last message the chat does not have", `insert into everchat_event (chat, n, type, msg, msg_last, created) values (1, 3, 'accepted', 0, 1, 1)`, "FOREIGN KEY"],

  ["the chat's flag of the wake-ups that is not 0 or 1", `update everchat_chat set wakeups = 2 where id = 1`, "CHECK"],
  ["a turn with a ceiling of 0 steps", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, steps, tokens) values (1, 6, 'running', 1, 1, 0, 1, 1, 0, 100)`, "CHECK"],
  ["a turn with a ceiling of 0 tokens", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, steps, tokens) values (1, 6, 'running', 1, 1, 0, 1, 1, 20, 0)`, "CHECK"],
  ["a turn with a ceiling of steps and none of tokens", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, steps) values (1, 6, 'running', 1, 1, 0, 1, 1, 20)`, "CHECK"],
  ["a turn with a ceiling of tokens and none of steps", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, tokens) values (1, 6, 'running', 1, 1, 0, 1, 1, 100)`, "CHECK"],
  ["a ceiling set on a turn after its insert", `update everchat_turn set steps = 20, tokens = 100 where chat = 1 and n = 1`, "everchat_turn keeps its ceiling"],
  ["a change of a turn's steps", `update everchat_turn set steps = 21 where chat = 1 and n = 5`, "everchat_turn keeps its ceiling"],
  ["a change of a turn's tokens", `update everchat_turn set tokens = 100 where chat = 1 and n = 5`, "everchat_turn keeps its ceiling"],
  ["a ceiling taken off a turn", `update everchat_turn set steps = null, tokens = null where chat = 1 and n = 5`, "everchat_turn keeps its ceiling"],
  ["a write of a turn's steps with the value that it has", `update everchat_turn set steps = steps where chat = 1 and n = 5`, "everchat_turn keeps its ceiling"],

  ["a wake-up that is a routine and a reminder", `insert into everchat_wake (chat, n, text, cron, at, zone, first, created, updated) values (1, 9, 'x', '0 9 * * *', 5, 'UTC', 5, 1, 1)`, "CHECK"],
  ["a wake-up that is neither a routine nor a reminder", `insert into everchat_wake (chat, n, text, zone, first, created, updated) values (1, 9, 'x', 'UTC', 5, 1, 1)`, "CHECK"],
  ["a reminder whose first slot is not its time", `insert into everchat_wake (chat, n, text, at, zone, first, created, updated) values (1, 9, 'x', 5, 'UTC', 6, 1, 1)`, "CHECK"],
  ["a wake-up with the turn that made it and no call", `insert into everchat_wake (chat, n, text, at, zone, first, turn, created, updated) values (1, 9, 'x', 5, 'UTC', 5, 4, 1, 1)`, "CHECK"],
  ["a wake-up with the call that made it and no turn", `insert into everchat_wake (chat, n, text, at, zone, first, call, created, updated) values (1, 9, 'x', 5, 'UTC', 5, 4, 1, 1)`, "CHECK"],
  ["a wake-up of a turn that is not there", `insert into everchat_wake (chat, n, text, at, zone, first, turn, call, created, updated) values (1, 9, 'x', 5, 'UTC', 5, 99, 4, 1, 1)`, "FOREIGN KEY"],
  ["a wake-up stopped with no why", `update everchat_wake set stopped = 5, due = null where chat = 1 and n = 2`, "CHECK"],
  ["a wake-up with a why and no stop", `update everchat_wake set why = 'person' where chat = 1 and n = 2`, "CHECK"],
  ["a wake-up stopped for an unknown why", `update everchat_wake set stopped = 5, why = 'tired', due = null where chat = 1 and n = 2`, "CHECK"],
  ["a stop's call on an active row", `update everchat_wake set stop_call = 5 where chat = 1 and n = 1`, "CHECK"],
  ["a stop's call on a wake-up that the person stopped", `update everchat_wake set stopped = 5, why = 'person', stop_call = 5, due = null where chat = 1 and n = 2`, "CHECK"],
  ["a stopped wake-up with a slot to come", `update everchat_wake set stopped = 5, why = 'person' where chat = 1 and n = 2`, "CHECK"],
  ["a stopped wake-up with a fire that waits", `update everchat_wake set stopped = 5, why = 'person', due = null, pending = 2000 where chat = 1 and n = 2`, "CHECK"],
  ["a fire that waits for the slot that fired", `update everchat_wake set slot = 1000, pending = 1000 where chat = 1 and n = 1`, "CHECK"],
  ["a fire that waits for a slot before the one that fired", `update everchat_wake set slot = 1000, pending = 999 where chat = 1 and n = 1`, "CHECK"],
  ["a wake-up whose last turn's end is not counted, with no last turn", `update everchat_wake set settled = 0 where chat = 1 and n = 1`, "CHECK"],
  ["a wake-up's settled flag that is not 0 or 1", `update everchat_wake set settled = 2, last_turn = 4 where chat = 1 and n = 1`, "CHECK"],
  ["a wake-up's missed count below 0", `update everchat_wake set missed = -1 where chat = 1 and n = 1`, "CHECK"],
  ["a wake-up's count of fires below 0", `update everchat_wake set fired = -1 where chat = 1 and n = 1`, "CHECK"],
  ["a wake-up's count of failures below 0", `update everchat_wake set failed = -1 where chat = 1 and n = 1`, "CHECK"],
  ["a move of a wake-up to another tenant's chat", `update everchat_wake set chat = 2 where chat = 1 and n = 2`, "everchat_wake keeps its chat and its n"],
  ["a move of a wake-up onto another tenant's wake-up, with or replace", `update or replace everchat_wake set chat = 2, n = 1 where chat = 1 and n = 2`, "everchat_wake keeps its chat and its n"],
  ["a change of a wake-up's n", `update everchat_wake set n = 9 where chat = 1 and n = 2`, "everchat_wake keeps its chat and its n"],
  ["a move of a wake-up by the do update of an upsert", `insert into everchat_wake (chat, n, text, at, zone, first, created, updated) values (1, 2, 'x', 5, 'UTC', 5, 1, 1) on conflict (chat, n) do update set chat = 3`, "everchat_wake keeps its chat and its n"],
  ["a change of a wake-up's text", `update everchat_wake set text = 'sit down' where chat = 1 and n = 1`, "everchat_wake keeps what its make wrote"],
  ["a write of a wake-up's text with the value that it has", `update everchat_wake set text = text where chat = 1 and n = 1`, "everchat_wake keeps what its make wrote"],
  ["a change of a wake-up's cron", `update everchat_wake set cron = '0 10 * * *' where chat = 1 and n = 1`, "everchat_wake keeps what its make wrote"],
  ["a change of a reminder's time", `update everchat_wake set at = 2001 where chat = 1 and n = 2`, "everchat_wake keeps what its make wrote"],
  ["a change of a wake-up's zone", `update everchat_wake set zone = 'Asia/Tokyo' where chat = 1 and n = 1`, "everchat_wake keeps what its make wrote"],
  ["a change of a wake-up's first slot", `update everchat_wake set first = 1001 where chat = 1 and n = 1`, "everchat_wake keeps what its make wrote"],
  ["a change of the turn that made a wake-up", `update everchat_wake set turn = 1 where chat = 1 and n = 1`, "everchat_wake keeps what its make wrote"],
  ["a change of the call that made a wake-up", `update everchat_wake set call = 1 where chat = 1 and n = 1`, "everchat_wake keeps what its make wrote"],
  ["a turn and a call set on a wake-up made otherwise", `update everchat_wake set turn = 4, call = 4 where chat = 1 and n = 2`, "everchat_wake keeps what its make wrote"]
]

// Writes that must stay possible.
const ALLOWED = [
  `update everchat_turn set status = 'done', ended = 2 where chat = 1 and n = 1`,
  `update everchat_call set status = 'cut', ended = 2 where chat = 1 and n = 2`,
  `update everchat_chat set goal = 'g', draft = 'd', taken = 0, seq = 1, updated = 2 where tenant = ${TENANT} and id = 1`,
  `delete from everchat_turn_item where chat = 1 and turn = 1`,
  `delete from everchat_log where chat = 1 and created < 2`,
  `update everchat_launch set ended = 2, why = 'exit' where chat = 1 and n = 1`,
  `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (1, 2, 11, 'h', '/', '0', 't', 2)`,
  `insert into everchat_msg_image (chat, msg, n, image) values (1, 0, 1, 1)`,
  // An approval's way, in its order: a yes, the run, its end and its message.
  `update everchat_approval set status = 'yes', who = 'the person', answered = 3, updated = 3 where chat = 1 and n = 1`,
  `update everchat_approval set status = 'running', updated = 4 where chat = 1 and n = 1`,
  `update everchat_approval set status = 'done', output = 'sent', ended = 5, updated = 5 where chat = 1 and n = 1`,
  `update everchat_approval set msg = 0, updated = 6 where chat = 1 and n = 1`,
  // The chat's wake-ups off; a turn with a ceiling, and a turn's end that
  // keeps it.
  `update everchat_chat set wakeups = 0, updated = 3 where tenant = ${TENANT} and id = 1`,
  `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created, steps, tokens) values (1, 6, 'running', 1, 1, 0, 1, 1, 20, 2000000)`,
  `update everchat_turn set status = 'stopped', ended = 3, why = 'ceiling' where chat = 1 and n = 5`,
  // A routine's way: a fire waits, it fires, a newer slot waits, the end
  // is counted as a failure, and `unwake` stops it.
  `update everchat_wake set pending = 1000, missed = 2, due = 4000, updated = 2 where chat = 1 and n = 1`,
  `update everchat_wake set slot = 1000, pending = null, missed = 0, fired = 1, last_turn = 4, settled = 0, updated = 3 where chat = 1 and n = 1`,
  `update everchat_wake set pending = 4000, due = 5000, updated = 4 where chat = 1 and n = 1`,
  `update everchat_wake set settled = 1, failed = 1, updated = 5 where chat = 1 and n = 1`,
  `update everchat_wake set stopped = 6, why = 'unwake', stop_call = 5, due = null, pending = null, missed = 0, updated = 6 where chat = 1 and n = 1`,
  // A reminder's one fire stops it; a wake-up that a call made.
  `update everchat_wake set slot = 2000, fired = 1, last_turn = 4, settled = 0, due = null, stopped = 3, why = 'fired', updated = 3 where chat = 1 and n = 2`,
  `insert into everchat_wake (chat, n, text, cron, zone, first, turn, call, due, created, updated) values (1, 3, 'water', '30 8 * * 1-5', 'UTC', 7000, 1, 2, 7000, 4, 4)`
]

test(`the schema refuses ${REFUSED.length} kinds of bad write, and each leaves the data as it was`, async () => {
  const file = newFile()
  const failures = await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE) yield* sql.unsafe(statement)
      const failures: Array<string> = []
      for (const [name, statement, error] of REFUSED) {
        const result = yield* Effect.result(sql.unsafe(statement))
        if (result._tag === "Success") {
          failures.push(`${name}: was not refused`)
        } else if (!String(result.failure.reason.cause).includes(error)) {
          failures.push(`${name}: refused with "${result.failure.reason.cause}", expected "${error}"`)
        }
      }
      for (const statement of ALLOWED) yield* sql.unsafe(statement)
      return failures
    })
  )
  expect(failures).toEqual([])
  expect(rows(file, "select text from everchat_msg")).toEqual([{ text: "hello" }])
  expect(rows(file, "select text from everchat_node")).toEqual([{ text: "user: hello" }])
  expect(rows(file, "select count(*) as n from everchat_launch")).toEqual([{ n: 5 }])
  expect(rows(file, "select chat, name from everchat_view order by chat")).toEqual([{ chat: 1, name: "chat" }, { chat: 2, name: "chat" }])
  expect(rows(file, "select id from everchat_chat order by id")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  expect(rows(file, "select msg, n, image from everchat_msg_image order by n")).toEqual([{ msg: 0, n: 0, image: 2 }, { msg: 0, n: 1, image: 1 }])
  expect(rows(file, "select count(*) as n from everchat_event")).toEqual([{ n: 1 }])
  // The approvals: the first went its way (ALLOWED), the second is as it was.
  expect(rows(file, "select chat, n, turn, call, fn, input, status, who, answer, answered, output, ended, msg, updated from everchat_approval order by chat, n")).toEqual([
    { chat: 1, n: 1, turn: 4, call: 5, fn: "send", input: '{"to":"x"}', status: "done", who: "the person", answer: null, answered: 3, output: "sent", ended: 5, msg: 0, updated: 6 },
    { chat: 1, n: 2, turn: 4, call: 6, fn: "send", input: '{"to":"y"}', status: "no", who: "the person", answer: "not now", answered: 2, output: null, ended: null, msg: 0, updated: 2 },
    { chat: 1, n: 3, turn: 4, call: 7, fn: "send", input: '{"to":"w"}', status: "pending", who: null, answer: null, answered: null, output: null, ended: null, msg: null, updated: 1 }
  ])
  expect(rows(file, "select n, status from everchat_call where chat = 1 and n in (5, 6, 7) order by n")).toEqual([{ n: 5, status: "pending" }, { n: 6, status: "pending" }, { n: 7, status: "pending" }])
  // The wake-ups: each went its way (ALLOWED), and chat 2's is as it was.
  expect(rows(file, "select chat, n, text, cron, at, zone, first, turn, call, due, slot, pending, missed, fired, last_turn, settled, failed, stopped, why, stop_call, updated from everchat_wake order by chat, n")).toEqual([
    { chat: 1, n: 1, text: "stand up", cron: "0 9 * * *", at: null, zone: "Europe/Berlin", first: 1000, turn: 4, call: 4, due: null, slot: 1000, pending: null, missed: 0, fired: 1, last_turn: 4, settled: 1, failed: 1, stopped: 6, why: "unwake", stop_call: 5, updated: 6 },
    { chat: 1, n: 2, text: "call back", cron: null, at: 2000, zone: "UTC", first: 2000, turn: null, call: null, due: null, slot: 2000, pending: null, missed: 0, fired: 1, last_turn: 4, settled: 0, failed: 0, stopped: 3, why: "fired", stop_call: null, updated: 3 },
    { chat: 1, n: 3, text: "water", cron: "30 8 * * 1-5", at: null, zone: "UTC", first: 7000, turn: 1, call: 2, due: 7000, slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: null, why: null, stop_call: null, updated: 4 },
    { chat: 2, n: 1, text: "hers", cron: null, at: 3000, zone: "UTC", first: 3000, turn: null, call: null, due: 3000, slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: null, why: null, stop_call: null, updated: 1 }
  ])
  expect(rows(file, "select n, status, steps, tokens from everchat_turn where chat = 1 and n >= 5 order by n")).toEqual([
    { n: 5, status: "stopped", steps: 20, tokens: 2000000 },
    { n: 6, status: "running", steps: 20, tokens: 2000000 }
  ])
  expect(rows(file, "select id, wakeups from everchat_chat order by id")).toEqual([{ id: 1, wakeups: 0 }, { id: 2, wakeups: 1 }, { id: 3, wakeups: 1 }])
})

// The key of a message's sender (docs/schema.html, everchat_msg): unique in
// its chat, by its bytes; many messages have none; the same key in another
// chat, of another tenant (chat 2) or of the same one (chat 3), is another
// message; and the table refuses its update.
test("the sender's key: unique in its chat by its bytes, null on many rows, the same key in another chat is another message, and no update sets it", async () => {
  const file = newFile()
  const got = await withDatabase(file, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (const statement of BASE) yield* sql.unsafe(statement)
    yield* sql.unsafe(`insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (3, 1, 30, 'h', '/', '0', 'v', 1)`)
    const message = (chat: number, i: number, key: string | null) =>
      sql`insert into everchat_msg (chat, i, kind, text, size, sender_key, launch, created) values (${chat}, ${i}, 1, 'x', 1, ${key}, 1, 1)`
    yield* message(1, 1, null)
    yield* message(1, 2, null)
    yield* message(1, 3, "key-1")
    yield* message(1, 4, "KEY-1")
    yield* message(2, 0, "key-1")
    yield* message(3, 0, "key-1")
    const again = yield* Effect.flip(message(1, 5, "key-1"))
    const update = yield* Effect.flip(sql`update everchat_msg set sender_key = null where chat = 1 and i = 3`)
    return { again: String(again.reason.cause), update: String(update.reason.cause) }
  }))
  expect(got.again).toContain("UNIQUE constraint failed: everchat_msg.chat, everchat_msg.sender_key")
  expect(got.update).toContain("everchat_msg is append only")
  expect(rows(file, "select chat, i, sender_key from everchat_msg order by chat, i")).toEqual([
    { chat: 1, i: 0, sender_key: null },
    { chat: 1, i: 1, sender_key: null },
    { chat: 1, i: 2, sender_key: null },
    { chat: 1, i: 3, sender_key: "key-1" },
    { chat: 1, i: 4, sender_key: "KEY-1" },
    { chat: 2, i: 0, sender_key: "key-1" },
    { chat: 3, i: 0, sender_key: "key-1" }
  ])
})

// A REPLACE (docs/schema.html, section 1, the tenant boundary): it is no
// update, so no guard of a row's chat or key runs for it; it deletes each row
// that it meets and inserts its own, and passes where those statements pass.
// Through a row's hidden rowid, it moves the row to another chat. Each case
// runs on a new file with BASE and its own rows: `moves` names the table and
// the condition of the row that must come out of chat 1 into chat 2 with its
// rowid, `refused` the text that refuses it, and `gone` the counts of chat
// 1's rows that the cascade must leave.
const REPLACES: ReadonlyArray<{
  readonly name: string
  readonly extra?: ReadonlyArray<string>
  readonly table: string
  readonly where: string
  readonly set?: Readonly<Record<string, string>>
  readonly refused?: string
  readonly left?: Readonly<Record<string, number>>
}> = [
  { name: "the schema allows it: a launch with no child moves to another tenant's chat, as its delete and an insert each pass", table: "everchat_launch", where: "n = 3" },
  { name: "the schema allows it: a turn with no child moves to another tenant's chat, as its delete and an insert each pass", table: "everchat_turn", where: "n = 3" },
  { name: "the schema allows it: a call with no child moves to another tenant's chat, as its delete and an insert each pass", table: "everchat_call", where: "n = 2" },
  {
    name: "the schema allows it: a turn whose children may all be deleted moves, and the cascade deletes its item and its calls, as a delete of it does",
    table: "everchat_turn",
    where: "n = 1",
    set: { n: "5" },
    // The calls of turn 4 (the approvals') stay; turn 1's two are gone.
    left: { everchat_turn_item: 0, everchat_call: 4 }
  },
  {
    name: "the schema allows it: a head that no turn names moves, as its delete and an insert each pass",
    extra: [`insert into everchat_head (chat, n, hash, body, created) values (1, 2, 'def', '[]', 1)`],
    table: "everchat_head",
    where: "n = 2"
  },
  { name: "the schema allows it: a turn's item moves to a turn of another tenant's chat", table: "everchat_turn_item", where: "turn = 1 and n = 0" },
  { name: "the schema allows it: an image that no message names moves", table: "everchat_image", where: "n = 1" },
  { name: "the schema allows it: a usage row moves", table: "everchat_usage", where: "n = 1" },
  { name: "the schema allows it: a log row moves", table: "everchat_log", where: "n = 1" },
  { name: "the schema allows it: a wake-up that names no turn and no call moves", table: "everchat_wake", where: "n = 2" },
  { name: "the delete trigger of a message refuses it: a launch that a message names", table: "everchat_launch", where: "n = 1", refused: "everchat_msg is append only" },
  {
    name: "the delete trigger of a message refuses it: a call that a message names",
    extra: [`insert into everchat_msg (chat, i, kind, text, size, call, launch, created) values (1, 1, 4, 'echo', 4, 2, 1, 1)`],
    table: "everchat_call",
    where: "n = 2",
    refused: "everchat_msg is append only"
  },
  {
    name: "the delete trigger of an event refuses it: a turn that an event names",
    extra: [`insert into everchat_event (chat, n, type, turn, created) values (1, 2, 'start', 3, 1)`],
    table: "everchat_turn",
    where: "n = 3",
    refused: "everchat_event is append only"
  },
  { name: "the delete trigger of a message's image refuses it: an image that a message names", table: "everchat_image", where: "n = 2", refused: "everchat_msg_image is append only" },
  { name: "the delete trigger of a message refuses it: a message", table: "everchat_msg", where: "i = 0", refused: "everchat_msg is append only" },
  { name: "the delete trigger of an approval refuses it: an approval", table: "everchat_approval", where: "n = 1", refused: "everchat_approval is kept for ever" },
  { name: "the delete trigger of an approval refuses it: a call that an approval names", table: "everchat_call", where: "n = 5", refused: "everchat_approval is kept for ever" },
  {
    name: "the delete trigger of an event refuses it: an event",
    table: "everchat_event",
    where: "n = 1",
    set: { type: "'start'", msg: "null", msg_last: "null" },
    refused: "everchat_event is append only"
  },
  {
    name: "the delete of the row that it meets in the other chat is refused: a launch onto another tenant's launch that a message names",
    extra: [`insert into everchat_msg (chat, i, kind, text, size, launch, created) values (2, 0, 1, 'hers', 4, 1, 1)`],
    table: "everchat_launch",
    where: "n = 3",
    set: { n: "1" },
    refused: "everchat_msg is append only"
  }
]

for (const { extra = [], left = {}, name, refused, set = {}, table, where } of REPLACES) {
  test(`a REPLACE through the rowid, ${name}`, async () => {
    const file = newFile()
    const got = await withDatabase(
      file,
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        for (const statement of [...BASE, ...extra]) yield* sql.unsafe(statement)
        const columns = (yield* sql.unsafe<{ name: string }>(`select name from pragma_table_xinfo('${table}') where hidden = 0`)).map((column) => column.name)
        const values = columns.map((column) => (column === "chat" ? "2" : set[column] ?? column))
        const [row] = yield* sql.unsafe<{ rowid: number }>(`select rowid from ${table} where chat = 1 and ${where}`)
        const statement = `insert or replace into ${table} (rowid, ${columns.join(", ")}) select rowid, ${values.join(", ")} from ${table} where chat = 1 and ${where}`
        const result = yield* Effect.result(sql.unsafe(statement))
        const after = yield* sql.unsafe<{ chat: number }>(`select chat from ${table} where rowid = ${row!.rowid}`)
        const counts: Record<string, number> = {}
        for (const other of Object.keys(left)) counts[other] = (yield* sql.unsafe<{ n: number }>(`select count(*) as n from ${other} where chat = 1`))[0]!.n
        return { error: result._tag === "Success" ? null : String(result.failure.reason.cause), chat: after[0]?.chat, counts }
      })
    )
    if (refused === undefined) {
      // It passed, and the row with the same rowid is now chat 2's.
      expect(got).toEqual({ error: null, chat: 2, counts: left })
    } else {
      expect(got.error).toContain(refused)
      expect(got.chat).toBe(1)
    }
  })
}

test("a REPLACE of a view, which has no rowid, writes only the view of the chat that it names, and the view that it copies stays", async () => {
  const file = newFile()
  const views = await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE) yield* sql.unsafe(statement)
      // Over chat 2's own view of the same name, then a new view of chat 3.
      yield* sql.unsafe(`insert or replace into everchat_view (chat, name, parts, batch, created, updated) select 2, name, '[[9,9]]', batch, created, updated from everchat_view where chat = 1`)
      yield* sql.unsafe(`replace into everchat_view (chat, name, parts, batch, created, updated) select 3, name, parts, batch, created, updated from everchat_view where chat = 1`)
      const named = yield* Effect.flip(sql.unsafe(`insert or replace into everchat_view (rowid, chat, name, parts, created, updated) select rowid, 2, name, parts, created, updated from everchat_view where chat = 1`))
      return { views: yield* sql.unsafe(`select chat, name, parts from everchat_view order by chat`), named: String(named.reason.cause) }
    })
  )
  expect(views.views).toEqual([
    { chat: 1, name: "chat", parts: "[[0,0]]" },
    { chat: 2, name: "chat", parts: "[[9,9]]" },
    { chat: 3, name: "chat", parts: "[[0,0]]" }
  ])
  expect(views.named).toContain("no column named rowid")
})

test("one rule, read from the file: each table with a column chat refuses an update that names chat or a column of its key, and everchat_chat its key and its rowid", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  // Each update sets a column to the value that the row has, so only a
  // trigger can refuse it: no reference, key or check is broken. The rowid is
  // the one exception (a trigger by name never sees it): chat 3 has no rows,
  // so no reference refuses its change either.
  const updates: Array<readonly [table: string, statement: string]> = []
  for (const table of names(file, "table")) {
    const columns = rows<{ name: string; pk: number }>(file, `select name, pk from pragma_table_info('${table}')`)
    if (table !== "everchat_chat" && !columns.some((column) => column.name === "chat")) continue
    const named = new Set([...(table === "everchat_chat" ? [] : ["chat"]), ...columns.filter((column) => column.pk > 0).map((column) => column.name)])
    for (const column of named) updates.push([table, `update ${table} set ${column} = ${column}`])
  }
  for (const alias of ["rowid", "oid", "_rowid_"]) updates.push(["everchat_chat", `update everchat_chat set ${alias} = 7 where id = 3`])
  // Every table but the tenants and the shared lists.
  expect([...new Set(updates.map(([table]) => table))]).toEqual(TABLES.filter((table) => !["everchat_kind", "everchat_pick", "everchat_tenant"].includes(table)))
  const failures = await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE) yield* sql.unsafe(statement)
      const failures: Array<string> = []
      for (const [table, statement] of updates) {
        const result = yield* Effect.result(sql.unsafe(statement))
        if (result._tag === "Success") {
          failures.push(`${statement}: was not refused`)
        } else if (!String(result.failure.reason.cause).includes(`${table} `)) {
          failures.push(`${statement}: refused with "${result.failure.reason.cause}", not by a trigger of ${table}`)
        }
      }
      return failures
    })
  )
  expect(failures).toEqual([])
  // The 15 tables of a chat: chat and the rest of each key (33); the chat's id;
  // its rowid by three names.
  expect(updates.length).toBe(37)
})

test("the delete of the tenant erases its chat and every row of the chat, and leaves the shared lists", async () => {
  const file = newFile()
  await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE) yield* sql.unsafe(statement)
      yield* sql.unsafe(`delete from everchat_tenant`)
    })
  )
  for (const table of TABLES.filter((table) => table !== "everchat_kind" && table !== "everchat_pick")) {
    expect([table, rows(file, `select count(*) as n from ${table}`)]).toEqual([table, [{ n: 0 }]])
  }
  expect(rows(file, "select count(*) as n from everchat_kind")).toEqual([{ n: 8 }])
  expect(rows(file, "select count(*) as n from everchat_pick")).toEqual([{ n: 1 }])
})

// The four references of a wake-up to the rows of its chat (the turn and
// the call that made it, the turn of its last fire, the call that stopped
// it) cascade: the delete of that turn or call takes the wake-up, and only
// it. Each case: one wake-up that names the row, and one that does not.
const CASCADES: ReadonlyArray<readonly [reference: string, wake: string, deleted: string]> = [
  [
    "turn",
    `insert into everchat_wake (chat, n, text, turn, call, at, zone, first, created, updated) values (1, 9, 'x', 3, 2, 5, 'UTC', 5, 1, 1)`,
    "delete from everchat_turn where chat = 1 and n = 3"
  ],
  [
    "call",
    `insert into everchat_wake (chat, n, text, turn, call, at, zone, first, created, updated) values (1, 9, 'x', 3, 2, 5, 'UTC', 5, 1, 1)`,
    "delete from everchat_call where chat = 1 and n = 2"
  ],
  [
    "last_turn",
    `insert into everchat_wake (chat, n, text, last_turn, settled, at, zone, first, created, updated) values (1, 9, 'x', 3, 0, 5, 'UTC', 5, 1, 1)`,
    "delete from everchat_turn where chat = 1 and n = 3"
  ],
  [
    "stop_call",
    `insert into everchat_wake (chat, n, text, stop_call, stopped, why, at, zone, first, created, updated) values (1, 9, 'x', 2, 5, 'unwake', 5, 'UTC', 5, 1, 1)`,
    "delete from everchat_call where chat = 1 and n = 2"
  ]
]

for (const [reference, wake, deleted] of CASCADES) {
  test(`a wake-up's reference ${reference} cascades: the delete of the row that it names takes the wake-up, and the other wake-ups stay`, async () => {
    const file = newFile()
    await withDatabase(file, Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE) yield* sql.unsafe(statement)
      yield* sql.unsafe(wake)
      expect(rows(file, "select n from everchat_wake where chat = 1 and n = 9")).toEqual([{ n: 9 }])
      yield* sql.unsafe(deleted)
    }))
    expect(rows(file, "select chat, n from everchat_wake order by chat, n")).toEqual([{ chat: 1, n: 1 }, { chat: 1, n: 2 }, { chat: 2, n: 1 }])
  })
}

test("the readable query shows a kind as a word and a time as text", async () => {
  const file = newFile()
  await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE.slice(0, 4)) yield* sql.unsafe(statement)
      yield* sql`insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 0, 2, 'hi', 2, 1, 1700000000000)`
    })
  )
  expect(rows(file, "select chat, i, kind, at, text from everchat_msg_read")).toEqual([
    { chat: 1, i: 0, kind: "asst", at: "2023-11-14 22:13:20", text: "hi" }
  ])
})

// The limit store (database.ts): the driver's wait on a locked file.

const busy = (layer: ReturnType<typeof Database.layer>) =>
  Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return (yield* sql<{ timeout: number }>`pragma busy_timeout`)[0]?.timeout
  }).pipe(Effect.provide(layer)))

test("the limit store: with none the driver waits 5,000 ms on a locked file; a store that is given is the wait, on the database and on its reads' connection", async () => {
  const file = newFile()
  expect(await busy(Database.layer(file))).toBe(5000)
  expect(Database.STORE).toBe(5000)
  expect(await busy(Database.layer(file, { store: 200 }))).toBe(200)
  expect(await busy(Database.readonly(file))).toBe(5000)
  expect(await busy(Database.readonly(file, { store: 200 }))).toBe(200)
  // The edges of the range pass.
  expect(await busy(Database.layer(file, { store: 1 }))).toBe(1)
  expect(await busy(Database.layer(file, { store: 2 ** 31 - 1 }))).toBe(2 ** 31 - 1)
})

test("the limit store: 0, 1.5 and 2**31 are refused at the layer's start with StoreError (open), before the file is opened", async () => {
  for (const store of [0, 1.5, 2 ** 31, -1, Number.NaN]) {
    const file = newFile()
    for (const layer of [Database.layer(file, { store }), Database.readonly(file, { store })]) {
      const error = await Effect.runPromise(Effect.flip(Effect.void.pipe(Effect.provide(layer))))
      expect(error).toBeInstanceOf(StoreError)
      expect(error._tag === "StoreError" ? [error.op, String(error.cause)] : null).toEqual([
        "open",
        `RangeError: the limit store is a whole number of milliseconds from 1 to 2147483647, not ${store}`
      ])
    }
    // Nothing was made.
    expect(fs.existsSync(file)).toBe(false)
  }
})
