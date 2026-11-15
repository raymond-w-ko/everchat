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

const TABLES = [
  "everchat_agent",
  "everchat_agent_msg",
  "everchat_call",
  "everchat_chat",
  "everchat_head",
  "everchat_image",
  "everchat_image_original",
  "everchat_kind",
  "everchat_launch",
  "everchat_log",
  "everchat_msg",
  "everchat_msg_image",
  "everchat_node",
  "everchat_pick",
  "everchat_turn",
  "everchat_turn_item",
  "everchat_usage",
  "everchat_view"
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

test("a new file gets the whole schema, and the mark", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  expect(names(file, "table")).toEqual(TABLES)
  expect(names(file, "trigger")).toEqual([
    "everchat_agent_msg_no_delete",
    "everchat_agent_msg_no_update",
    "everchat_msg_no_delete",
    "everchat_msg_no_update",
    "everchat_node_no_delete",
    "everchat_node_no_update",
    "everchat_turn_item_no_update",
    "everchat_usage_no_update"
  ])
  expect(names(file, "index")).toEqual([
    "everchat_call_parent",
    "everchat_call_running",
    "everchat_call_vendor",
    "everchat_launch_live",
    "everchat_turn_running"
  ])
  expect(names(file, "view")).toEqual(["everchat_msg_read"])
  expect(VERSION).toBe(3)
  expect(rows(file, "pragma user_version")).toEqual([{ user_version: VERSION }])
  // The table of usage has the column of the expected reads from the cache.
  expect(rows<{ name: string }>(file, "select name from pragma_table_info('everchat_usage')").map((row) => row.name)).toContain("expected")
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

test("the connection is in WAL mode, with full sync and checked references", async () => {
  const pragmas = await withDatabase(
    newFile(),
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      return [
        yield* sql.unsafe("pragma journal_mode"),
        yield* sql.unsafe("pragma synchronous"),
        yield* sql.unsafe("pragma foreign_keys")
      ]
    })
  )
  expect(pragmas).toEqual([[{ journal_mode: "wal" }], [{ synchronous: 2 }], [{ foreign_keys: 1 }]])
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

// Rows that the refused writes below build on. Each one is valid.
const BASE = [
  `insert into everchat_pick (id, vendor, model, effort, speed, created) values (1, 'v', 'm', 'e', 's', 1)`,
  `insert into everchat_chat (id, uuid, pick, created, updated) values (1, 'u', 1, 1, 1)`,
  `insert into everchat_launch (id, pid, host, cwd, version, run_tag, created) values (1, 10, 'h', '/', '0', 't', 1)`,
  `insert into everchat_head (id, hash, body, created) values (1, 'abc', '{}', 1)`,
  `insert into everchat_turn (id, status, pick, head, first_msg, launch, created) values (1, 'running', 1, 1, 0, 1, 1)`,
  `insert into everchat_turn_item (turn, n, kind, body, created) values (1, 0, 'user', '{}', 1)`,
  `insert into everchat_call (id, turn, vendor_id, fn, input, status, launch, created) values (1, 1, 'call_a', 'run', 'x', 'running', 1, 1)`,
  `insert into everchat_call (id, turn, parent, fn, input, status, launch, created) values (2, 1, 1, 'shell', '{}', 'running', 1, 1)`,
  `insert into everchat_msg (i, kind, text, size, launch, created) values (0, 1, 'hello', 5, 1, 1)`,
  `insert into everchat_node (l, i, text, size, created) values (0, 0, 'user: hello', 11, 1)`,
  `insert into everchat_view (name, parts, created, updated) values ('chat', '[[0,0]]', 1, 1)`,
  `insert into everchat_image (id, name, type, width, height, source, created, bytes) values (1, 'a.png', 'image/png', 1, 1, 'person', 1, x'00')`,
  `insert into everchat_agent (id, name, role, created, updated) values (1, 'CalmOtter', 'sub', 1, 1)`,
  `insert into everchat_agent_msg (agent, i, kind, text, size, created) values (1, 0, 6, 'note', 4, 1)`,
  `insert into everchat_usage (id, served, pick, input, cache_read, cache_write, output, created) values (1, 'turn', 1, 1, 0, 0, 1, 1)`
]

// Each write that the schema must refuse, and a part of the error's text.
const REFUSED: ReadonlyArray<readonly [name: string, statement: string, error: string]> = [
  ["a second chat", `insert into everchat_chat (id, uuid, pick, created, updated) values (2, 'u', 1, 1, 1)`, "CHECK"],
  ["a chat with a pick that is not there", `update everchat_chat set pick = 99`, "FOREIGN KEY"],
  ["a second live launch", `insert into everchat_launch (pid, host, cwd, version, run_tag, created) values (11, 'h', '/', '0', 't', 2)`, "UNIQUE"],
  ["a second pick with the same values", `insert into everchat_pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 2)`, "UNIQUE"],
  ["a second head with the same hash", `insert into everchat_head (hash, body, created) values ('abc', '{}', 2)`, "UNIQUE"],
  ["a second kind with the same name", `insert into everchat_kind (id, name) values (7, 'user')`, "UNIQUE"],

  ["a change of a message", `update everchat_msg set text = 'other' where i = 0`, "msg is append only"],
  ["a delete of a message", `delete from everchat_msg where i = 0`, "msg is append only"],
  ["a message of a kind that is not there", `insert into everchat_msg (i, kind, text, size, launch, created) values (1, 99, 'x', 1, 1, 1)`, "FOREIGN KEY"],
  ["a message of a launch that is not there", `insert into everchat_msg (i, kind, text, size, launch, created) values (1, 1, 'x', 1, 99, 1)`, "FOREIGN KEY"],
  ["a message with a flag that is not 0 or 1", `insert into everchat_msg (i, kind, text, size, more, launch, created) values (1, 1, 'x', 1, 2, 1, 1)`, "CHECK"],
  ["a message with an id that is used", `insert into everchat_msg (i, kind, text, size, launch, created) values (0, 1, 'x', 1, 1, 1)`, "UNIQUE"],
  ["a message whose text is not text", `insert into everchat_msg (i, kind, text, size, launch, created) values (1, 1, x'00', 1, 1, 1)`, "cannot store BLOB"],
  ["a message with an image that is not there", `insert into everchat_msg_image (msg, n, image) values (0, 0, 99)`, "FOREIGN KEY"],
  ["an original of an image that is not there", `insert into everchat_image_original (image, type, width, height, bytes) values (99, 't', 1, 1, x'00')`, "FOREIGN KEY"],
  ["an image from an unknown source", `insert into everchat_image (name, type, width, height, source, created, bytes) values ('b', 't', 1, 1, 'web', 1, x'00')`, "CHECK"],

  ["a change of a node", `update everchat_node set text = 'other' where l = 0 and i = 0`, "node is written once"],
  ["a delete of a node", `delete from everchat_node where l = 0 and i = 0`, "node is written once"],
  ["a second write of a node", `insert into everchat_node (l, i, text, size, created) values (0, 0, 'again', 5, 2)`, "UNIQUE"],
  ["a node below level 0", `insert into everchat_node (l, i, text, size, created) values (-1, 0, 'x', 1, 1)`, "CHECK"],
  ["a node before message 0", `insert into everchat_node (l, i, text, size, created) values (0, -1, 'x', 1, 1)`, "CHECK"],
  ["a view with another name", `insert into everchat_view (name, parts, created, updated) values ('other', '[]', 1, 1)`, "CHECK"],
  ["a view with a flag that is not 0 or 1", `update everchat_view set batch = 2`, "CHECK"],

  ["a turn with an unknown status", `update everchat_turn set status = 'paused'`, "CHECK"],
  ["a running turn with an end", `update everchat_turn set ended = 2`, "CHECK"],
  ["a done turn with no end", `update everchat_turn set status = 'done'`, "CHECK"],
  ["a turn on a pick that is not there", `insert into everchat_turn (status, pick, head, first_msg, launch, created) values ('running', 99, 1, 0, 1, 1)`, "FOREIGN KEY"],
  ["a change of a turn item", `update everchat_turn_item set body = '[]'`, "turn_item is append only"],
  ["a turn item of an unknown kind", `insert into everchat_turn_item (turn, n, kind, body, created) values (1, 1, 'tool', '{}', 1)`, "CHECK"],

  ["a program with no vendor id", `insert into everchat_call (turn, fn, input, status, launch, created) values (1, 'run', 'x', 'running', 1, 1)`, "CHECK"],
  ["a function with a vendor id", `insert into everchat_call (turn, parent, vendor_id, fn, input, status, launch, created) values (1, 1, 'call_b', 'shell', '{}', 'running', 1, 1)`, "CHECK"],
  ["two programs with one vendor id in a turn", `insert into everchat_call (turn, vendor_id, fn, input, status, launch, created) values (1, 'call_a', 'run', 'x', 'running', 1, 1)`, "UNIQUE"],
  ["a running call with an end", `update everchat_call set ended = 2 where id = 1`, "CHECK"],
  ["a done call with no end", `update everchat_call set status = 'done' where id = 1`, "CHECK"],
  ["a call with an unknown status", `update everchat_call set status = 'lost' where id = 1`, "CHECK"],

  ["an agent with an unknown role", `insert into everchat_agent (name, role, created, updated) values ('A', 'boss', 1, 1)`, "CHECK"],
  ["a computer task with no device", `insert into everchat_agent (name, role, created, updated) values ('A', 'hands', 1, 1)`, "CHECK"],
  ["a subagent with a device", `insert into everchat_agent (name, role, device, created, updated) values ('A', 'sub', 'mac', 1, 1)`, "CHECK"],
  ["two agents with one name", `insert into everchat_agent (name, role, created, updated) values ('CalmOtter', 'sub', 1, 1)`, "UNIQUE"],
  ["an agent with a flag that is not 0 or 1", `update everchat_agent set stop = 2`, "CHECK"],
  ["a change of an agent's message", `update everchat_agent_msg set text = 'other'`, "agent_msg is append only"],
  ["a delete of an agent's message", `delete from everchat_agent_msg`, "agent_msg is append only"],

  ["a change of a usage", `update everchat_usage set output = 2`, "usage is append only"],
  ["a usage that served an unknown thing", `insert into everchat_usage (served, pick, input, cache_read, cache_write, output, created) values ('chat', 1, 1, 0, 0, 1, 1)`, "CHECK"],
  ["a log row of an unknown level", `insert into everchat_log (level, source, text, launch, created) values ('fatal', 's', 't', 1, 1)`, "CHECK"]
]

// Writes that must stay possible.
const ALLOWED = [
  `update everchat_turn set status = 'done', ended = 2 where id = 1`,
  `update everchat_call set status = 'cut', ended = 2 where id = 2`,
  `delete from everchat_turn_item where turn = 1`,
  `update everchat_launch set ended = 2, why = 'exit' where id = 1`,
  `insert into everchat_launch (pid, host, cwd, version, run_tag, created) values (11, 'h', '/', '0', 't', 2)`,
  `insert into everchat_image_original (image, type, width, height, bytes) values (1, 't', 2, 2, x'0000')`,
  `insert into everchat_msg_image (msg, n, image) values (0, 0, 1)`
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
})

test("the readable query shows a kind as a word and a time as text", async () => {
  const file = newFile()
  await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE.slice(0, 3)) yield* sql.unsafe(statement)
      yield* sql`insert into everchat_msg (i, kind, text, size, launch, created) values (0, 2, 'hi', 2, 1, 1700000000000)`
    })
  )
  expect(rows(file, "select i, kind, at, text from everchat_msg_read")).toEqual([
    { i: 0, kind: "asst", at: "2023-11-14 22:13:20", text: "hi" }
  ])
})
