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
import { DatabaseVersion, Kind, KINDS } from "@everchat/core/store"

const withDatabase = <A, E>(file: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layer(file))))

// The names of the page's block (docs/schema.html, section 8).
const TABLES = [
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
  "everchat_view"
]

const TRIGGERS = [
  "everchat_chat_no_delete",
  "everchat_chat_no_move",
  "everchat_event_no_delete",
  "everchat_event_no_update",
  "everchat_head_no_update",
  "everchat_image_no_update",
  "everchat_kind_no_delete",
  "everchat_kind_no_update",
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
  "everchat_usage_no_update"
]

const INDEXES = [
  "everchat_call_parent",
  "everchat_call_running",
  "everchat_call_vendor",
  "everchat_chat_tenant",
  "everchat_launch_live",
  "everchat_turn_running"
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

test("a new file gets the whole schema of the page, and the mark: 17 tables, 20 triggers, 6 indexes, 1 view, each table strict", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  expect(names(file, "table")).toEqual(TABLES)
  expect(names(file, "trigger")).toEqual(TRIGGERS)
  expect(names(file, "index")).toEqual(INDEXES)
  expect(names(file, "view")).toEqual(["everchat_msg_read"])
  expect([TABLES.length, TRIGGERS.length, INDEXES.length]).toEqual([17, 20, 6])
  expect(VERSION).toBe(4)
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
  // Twelve tables refuse an update, and five may change.
  expect(seen.filter(([, , refuses]) => refuses).length).toBe(12)
  expect(seen.filter(([, changes]) => changes).map(([table]) => table)).toEqual([
    "everchat_call",
    "everchat_chat",
    "everchat_launch",
    "everchat_turn",
    "everchat_view"
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

test("a refused file in DELETE mode, with rows, keeps its bytes and its mode, and gets no file beside it: marks 0, 2 and 4, and a backup", async () => {
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

// The tenant of the rows below, and the chat's UUID: 16 bytes each.
const TENANT = "x'00112233445566778899aabbccddeeff'"
const UUID = "x'0123456789abcdef0123456789abcdef'"

// Rows that the refused writes below build on, all of chat 1. Each one is
// valid.
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
  `insert into everchat_event (chat, n, type, msg, msg_last, created) values (1, 1, 'accepted', 0, 0, 1)`
]

// Each write that the schema must refuse, and a part of the error's text.
const REFUSED: ReadonlyArray<readonly [name: string, statement: string, error: string]> = [
  ["a tenant whose id is not 16 bytes", `insert into everchat_tenant (id, created) values (x'00', 1)`, "CHECK"],
  ["a change of a tenant", `update everchat_tenant set created = 2`, "everchat_tenant is append only"],
  ["a second chat with the same UUID", `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (2, ${TENANT}, ${UUID}, 1, 1, 1)`, "UNIQUE"],
  ["a chat whose UUID is not 16 bytes", `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (2, ${TENANT}, x'01', 1, 1, 1)`, "CHECK"],
  ["a chat of a tenant that is not there", `insert into everchat_chat (id, tenant, uuid, pick, created, updated) values (2, x'ffffffffffffffffffffffffffffffff', x'ffffffffffffffffffffffffffffffff', 1, 1, 1)`, "FOREIGN KEY"],
  ["a chat with a pick that is not there", `update everchat_chat set pick = 99`, "FOREIGN KEY"],
  ["a move of the chat to another tenant", `update everchat_chat set tenant = x'ffffffffffffffffffffffffffffffff'`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a change of the chat's UUID", `update everchat_chat set uuid = x'ffffffffffffffffffffffffffffffff'`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a change of the chat's id", `update everchat_chat set id = 2`, "everchat_chat keeps its id, its tenant and its uuid"],
  ["a delete of the chat while its tenant is there", `delete from everchat_chat`, "everchat_chat is deleted only with its tenant"],
  ["a second live launch", `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (1, 2, 11, 'h', '/', '0', 't', 2)`, "UNIQUE"],
  ["a launch of a chat that is not there", `insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (9, 1, 11, 'h', '/', '0', 't', 2)`, "FOREIGN KEY"],
  ["a second pick with the same values", `insert into everchat_pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 2)`, "UNIQUE"],
  ["a change of a pick", `update everchat_pick set vendor = 'w'`, "everchat_pick is append only"],
  ["a delete of a pick", `delete from everchat_pick`, "everchat_pick is append only"],
  ["a second head with the same hash", `insert into everchat_head (chat, n, hash, body, created) values (1, 2, 'abc', '{}', 2)`, "UNIQUE"],
  ["a change of a head", `update everchat_head set body = '[]'`, "everchat_head is append only"],
  ["a second kind with the same name", `insert into everchat_kind (id, name) values (7, 'user')`, "UNIQUE"],
  ["a change of a kind", `update everchat_kind set name = 'used'`, "everchat_kind is append only"],
  ["a delete of a kind", `delete from everchat_kind where id = 6`, "everchat_kind is append only"],

  ["a change of a message", `update everchat_msg set text = 'other' where i = 0`, "msg is append only"],
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

  ["a turn with an unknown status", `update everchat_turn set status = 'paused'`, "CHECK"],
  ["a running turn with an end", `update everchat_turn set ended = 2`, "CHECK"],
  ["a done turn with no end", `update everchat_turn set status = 'done'`, "CHECK"],
  ["a turn on a pick that is not there", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created) values (1, 2, 'running', 99, 1, 0, 1, 1)`, "FOREIGN KEY"],
  ["a turn on a head that is not there", `insert into everchat_turn (chat, n, status, pick, head, first_msg, launch, created) values (1, 2, 'running', 1, 99, 0, 1, 1)`, "FOREIGN KEY"],
  ["a change of a turn item", `update everchat_turn_item set body = '[]'`, "turn_item is append only"],
  ["a turn item of an unknown kind", `insert into everchat_turn_item (chat, turn, n, kind, body, created) values (1, 1, 2, 'tool', '{}', 1)`, "CHECK"],

  ["a program with no vendor id", `insert into everchat_call (chat, n, turn, fn, input, status, launch, created) values (1, 3, 1, 'run', 'x', 'running', 1, 1)`, "CHECK"],
  ["a function with a vendor id", `insert into everchat_call (chat, n, turn, parent, vendor_id, fn, input, status, launch, created) values (1, 3, 1, 1, 'call_b', 'shell', '{}', 'running', 1, 1)`, "CHECK"],
  ["two programs with one vendor id in a turn", `insert into everchat_call (chat, n, turn, vendor_id, fn, input, status, launch, created) values (1, 3, 1, 'call_a', 'run', 'x', 'running', 1, 1)`, "UNIQUE"],
  ["a running call with an end", `update everchat_call set ended = 2 where n = 1`, "CHECK"],
  ["a done call with no end", `update everchat_call set status = 'done' where n = 1`, "CHECK"],
  ["a call with an unknown status", `update everchat_call set status = 'lost' where n = 1`, "CHECK"],

  ["a change of a usage", `update everchat_usage set output = 2`, "usage is append only"],
  ["a usage that served an unknown thing", `insert into everchat_usage (chat, n, served, pick, input, cache_read, cache_write, output, created) values (1, 2, 'chat', 1, 1, 0, 0, 1, 1)`, "CHECK"],
  ["a log row of an unknown level", `insert into everchat_log (chat, n, level, source, text, launch, created) values (1, 2, 'fatal', 's', 't', 1, 1)`, "CHECK"],
  ["a change of a log row", `update everchat_log set text = 'other'`, "everchat_log is append only"],

  ["a change of an event", `update everchat_event set type = 'end'`, "everchat_event is append only"],
  ["a delete of an event", `delete from everchat_event`, "everchat_event is append only"],
  ["an event of an unknown type", `insert into everchat_event (chat, n, type, created) values (1, 2, 'text', 1)`, "CHECK"],
  ["an event with a first message and no last", `insert into everchat_event (chat, n, type, msg, created) values (1, 2, 'message', 0, 1)`, "CHECK"]
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
  `insert into everchat_msg_image (chat, msg, n, image) values (1, 0, 1, 1)`
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
  expect(rows(file, "select count(*) as n from everchat_launch")).toEqual([{ n: 2 }])
  expect(rows(file, "select msg, n, image from everchat_msg_image order by n")).toEqual([{ msg: 0, n: 0, image: 2 }, { msg: 0, n: 1, image: 1 }])
  expect(rows(file, "select count(*) as n from everchat_event")).toEqual([{ n: 1 }])
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
  expect(rows(file, "select count(*) as n from everchat_kind")).toEqual([{ n: 6 }])
  expect(rows(file, "select count(*) as n from everchat_pick")).toEqual([{ n: 1 }])
})

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
