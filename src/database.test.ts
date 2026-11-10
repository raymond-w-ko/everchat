// Tests of the database: the migration, the pragmas, and the writes that the
// schema must refuse.

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as fs from "node:fs"
import * as path from "node:path"
import { newFile, rows } from "../tests/help.ts"
import * as Database from "./database.ts"
import { KINDS, migrations } from "./migrations.ts"
import { Kind } from "./store.ts"

const withDatabase = <A, E>(file: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layer(file))))

const TABLES = [
  "agent",
  "agent_msg",
  "call",
  "chat",
  "effect_sql_migrations",
  "head",
  "image",
  "image_original",
  "kind",
  "launch",
  "log",
  "msg",
  "msg_image",
  "node",
  "pick",
  "turn",
  "turn_item",
  "usage",
  "view"
]

test("a new file gets the whole schema", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  const names = (type: string) =>
    rows<{ name: string }>(file, `select name from sqlite_master where type = '${type}' order by name`)
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_"))
  expect(names("table")).toEqual(TABLES)
  expect(names("trigger")).toEqual([
    "agent_msg_no_delete",
    "agent_msg_no_update",
    "msg_no_delete",
    "msg_no_update",
    "node_no_delete",
    "node_no_update",
    "turn_item_no_update",
    "usage_no_update"
  ])
  expect(names("index")).toEqual(["call_parent", "call_running", "call_vendor", "launch_live", "turn_running"])
  expect(names("view")).toEqual(["msg_read"])
  expect(rows(file, "select migration_id, name from effect_sql_migrations")).toEqual([
    { migration_id: 1, name: "schema" },
    { migration_id: 2, name: "usage_expected" }
  ])
})

test("every table of ours is strict", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  const loose = rows<{ name: string; strict: number }>(file, "select name, strict from pragma_table_list where schema = 'main' and type = 'table'")
    .filter((row) => row.strict === 0 && !row.name.startsWith("sqlite_"))
    .map((row) => row.name)
  // The migrator makes its own table, and it is not strict.
  expect(loose).toEqual(["effect_sql_migrations"])
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

test("a second open runs no migration and keeps the data", async () => {
  const file = newFile()
  const insert = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 1)`
  })
  await withDatabase(file, insert)
  await withDatabase(file, Effect.void)
  expect(rows(file, "select count(*) as n from effect_sql_migrations")).toEqual([{ n: 2 }])
  expect(rows(file, "select vendor from pick")).toEqual([{ vendor: "v" }])
})

test("a clean close leaves one file", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  expect(fs.readdirSync(path.dirname(file))).toEqual([Database.FILE])
})

test("the kinds in the table are the kinds in the code", async () => {
  const file = newFile()
  await withDatabase(file, Effect.void)
  const table = rows<{ id: number; name: string }>(file, "select id, name from kind order by id")
  expect(table).toEqual(Object.entries(KINDS).map(([name, id]) => ({ id, name })))
  expect(table.map((row) => row.name)).toEqual([...Kind.literals])
  // The kind counts toward a node's 512 bytes, so every kind has 4 letters.
  expect(table.every((row) => row.name.length === 4)).toBe(true)
})

test("migration 2 adds usage.expected to a database of migration 1, and keeps its rows", async () => {
  const file = newFile()
  const first = { "0001_schema": migrations["0001_schema"] }
  await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`insert into pick (id, vendor, model, effort, speed, created) values (1, 'v', 'm', 'e', 's', 1)`
      yield* sql`insert into usage (served, pick, input, cache_read, cache_write, output, created) values ('turn', 1, 10, 0, 0, 1, 1)`
    }).pipe(Effect.provide(Database.layer(file, first)))
  )
  expect(rows<{ name: string }>(file, "select name from pragma_table_info('usage')").map((row) => row.name)).not.toContain("expected")
  await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`insert into usage (served, pick, input, cache_read, cache_write, output, expected, created) values ('turn', 1, 10, 0, 0, 1, 9000, 2)`
    })
  )
  expect(rows(file, "select input, expected from usage order by id")).toEqual([{ input: 10, expected: null }, { input: 10, expected: 9000 }])
  // The query that finds a miss: something to read was expected, and nothing was read.
  expect(rows(file, "select id from usage where expected >= 1024 and cache_read = 0")).toEqual([{ id: 2 }])
})

// Rows that the refused writes below build on. Each one is valid.
const BASE = [
  `insert into pick (id, vendor, model, effort, speed, created) values (1, 'v', 'm', 'e', 's', 1)`,
  `insert into chat (id, uuid, pick, created, updated) values (1, 'u', 1, 1, 1)`,
  `insert into launch (id, pid, host, cwd, version, run_tag, created) values (1, 10, 'h', '/', '0', 't', 1)`,
  `insert into head (id, hash, body, created) values (1, 'abc', '{}', 1)`,
  `insert into turn (id, status, pick, head, first_msg, launch, created) values (1, 'running', 1, 1, 0, 1, 1)`,
  `insert into turn_item (turn, n, kind, body, created) values (1, 0, 'user', '{}', 1)`,
  `insert into call (id, turn, vendor_id, fn, input, status, launch, created) values (1, 1, 'call_a', 'run', 'x', 'running', 1, 1)`,
  `insert into call (id, turn, parent, fn, input, status, launch, created) values (2, 1, 1, 'shell', '{}', 'running', 1, 1)`,
  `insert into msg (i, kind, text, size, launch, created) values (0, 1, 'hello', 5, 1, 1)`,
  `insert into node (l, i, text, size, created) values (0, 0, 'user: hello', 11, 1)`,
  `insert into view (name, parts, created, updated) values ('chat', '[[0,0]]', 1, 1)`,
  `insert into image (id, name, type, width, height, source, created, bytes) values (1, 'a.png', 'image/png', 1, 1, 'person', 1, x'00')`,
  `insert into agent (id, name, role, created, updated) values (1, 'CalmOtter', 'sub', 1, 1)`,
  `insert into agent_msg (agent, i, kind, text, size, created) values (1, 0, 6, 'note', 4, 1)`,
  `insert into usage (id, served, pick, input, cache_read, cache_write, output, created) values (1, 'turn', 1, 1, 0, 0, 1, 1)`
]

// Each write that the schema must refuse, and a part of the error's text.
const REFUSED: ReadonlyArray<readonly [name: string, statement: string, error: string]> = [
  ["a second chat", `insert into chat (id, uuid, pick, created, updated) values (2, 'u', 1, 1, 1)`, "CHECK"],
  ["a chat with a pick that is not there", `update chat set pick = 99`, "FOREIGN KEY"],
  ["a second live launch", `insert into launch (pid, host, cwd, version, run_tag, created) values (11, 'h', '/', '0', 't', 2)`, "UNIQUE"],
  ["a second pick with the same values", `insert into pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 2)`, "UNIQUE"],
  ["a second head with the same hash", `insert into head (hash, body, created) values ('abc', '{}', 2)`, "UNIQUE"],
  ["a second kind with the same name", `insert into kind (id, name) values (7, 'user')`, "UNIQUE"],

  ["a change of a message", `update msg set text = 'other' where i = 0`, "msg is append only"],
  ["a delete of a message", `delete from msg where i = 0`, "msg is append only"],
  ["a message of a kind that is not there", `insert into msg (i, kind, text, size, launch, created) values (1, 99, 'x', 1, 1, 1)`, "FOREIGN KEY"],
  ["a message of a launch that is not there", `insert into msg (i, kind, text, size, launch, created) values (1, 1, 'x', 1, 99, 1)`, "FOREIGN KEY"],
  ["a message with a flag that is not 0 or 1", `insert into msg (i, kind, text, size, more, launch, created) values (1, 1, 'x', 1, 2, 1, 1)`, "CHECK"],
  ["a message with an id that is used", `insert into msg (i, kind, text, size, launch, created) values (0, 1, 'x', 1, 1, 1)`, "UNIQUE"],
  ["a message whose text is not text", `insert into msg (i, kind, text, size, launch, created) values (1, 1, x'00', 1, 1, 1)`, "cannot store BLOB"],
  ["a message with an image that is not there", `insert into msg_image (msg, n, image) values (0, 0, 99)`, "FOREIGN KEY"],
  ["an original of an image that is not there", `insert into image_original (image, type, width, height, bytes) values (99, 't', 1, 1, x'00')`, "FOREIGN KEY"],
  ["an image from an unknown source", `insert into image (name, type, width, height, source, created, bytes) values ('b', 't', 1, 1, 'web', 1, x'00')`, "CHECK"],

  ["a change of a node", `update node set text = 'other' where l = 0 and i = 0`, "node is written once"],
  ["a delete of a node", `delete from node where l = 0 and i = 0`, "node is written once"],
  ["a second write of a node", `insert into node (l, i, text, size, created) values (0, 0, 'again', 5, 2)`, "UNIQUE"],
  ["a node below level 0", `insert into node (l, i, text, size, created) values (-1, 0, 'x', 1, 1)`, "CHECK"],
  ["a node before message 0", `insert into node (l, i, text, size, created) values (0, -1, 'x', 1, 1)`, "CHECK"],
  ["a view with another name", `insert into view (name, parts, created, updated) values ('other', '[]', 1, 1)`, "CHECK"],
  ["a view with a flag that is not 0 or 1", `update view set batch = 2`, "CHECK"],

  ["a turn with an unknown status", `update turn set status = 'paused'`, "CHECK"],
  ["a running turn with an end", `update turn set ended = 2`, "CHECK"],
  ["a done turn with no end", `update turn set status = 'done'`, "CHECK"],
  ["a turn on a pick that is not there", `insert into turn (status, pick, head, first_msg, launch, created) values ('running', 99, 1, 0, 1, 1)`, "FOREIGN KEY"],
  ["a change of a turn item", `update turn_item set body = '[]'`, "turn_item is append only"],
  ["a turn item of an unknown kind", `insert into turn_item (turn, n, kind, body, created) values (1, 1, 'tool', '{}', 1)`, "CHECK"],

  ["a program with no vendor id", `insert into call (turn, fn, input, status, launch, created) values (1, 'run', 'x', 'running', 1, 1)`, "CHECK"],
  ["a function with a vendor id", `insert into call (turn, parent, vendor_id, fn, input, status, launch, created) values (1, 1, 'call_b', 'shell', '{}', 'running', 1, 1)`, "CHECK"],
  ["two programs with one vendor id in a turn", `insert into call (turn, vendor_id, fn, input, status, launch, created) values (1, 'call_a', 'run', 'x', 'running', 1, 1)`, "UNIQUE"],
  ["a running call with an end", `update call set ended = 2 where id = 1`, "CHECK"],
  ["a done call with no end", `update call set status = 'done' where id = 1`, "CHECK"],
  ["a call with an unknown status", `update call set status = 'lost' where id = 1`, "CHECK"],

  ["an agent with an unknown role", `insert into agent (name, role, created, updated) values ('A', 'boss', 1, 1)`, "CHECK"],
  ["a computer task with no device", `insert into agent (name, role, created, updated) values ('A', 'hands', 1, 1)`, "CHECK"],
  ["a subagent with a device", `insert into agent (name, role, device, created, updated) values ('A', 'sub', 'mac', 1, 1)`, "CHECK"],
  ["two agents with one name", `insert into agent (name, role, created, updated) values ('CalmOtter', 'sub', 1, 1)`, "UNIQUE"],
  ["an agent with a flag that is not 0 or 1", `update agent set stop = 2`, "CHECK"],
  ["a change of an agent's message", `update agent_msg set text = 'other'`, "agent_msg is append only"],
  ["a delete of an agent's message", `delete from agent_msg`, "agent_msg is append only"],

  ["a change of a usage", `update usage set output = 2`, "usage is append only"],
  ["a usage that served an unknown thing", `insert into usage (served, pick, input, cache_read, cache_write, output, created) values ('chat', 1, 1, 0, 0, 1, 1)`, "CHECK"],
  ["a log row of an unknown level", `insert into log (level, source, text, launch, created) values ('fatal', 's', 't', 1, 1)`, "CHECK"]
]

// Writes that must stay possible.
const ALLOWED = [
  `update turn set status = 'done', ended = 2 where id = 1`,
  `update call set status = 'cut', ended = 2 where id = 2`,
  `delete from turn_item where turn = 1`,
  `update launch set ended = 2, why = 'exit' where id = 1`,
  `insert into launch (pid, host, cwd, version, run_tag, created) values (11, 'h', '/', '0', 't', 2)`,
  `insert into image_original (image, type, width, height, bytes) values (1, 't', 2, 2, x'0000')`,
  `insert into msg_image (msg, n, image) values (0, 0, 1)`
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
  expect(rows(file, "select text from msg")).toEqual([{ text: "hello" }])
  expect(rows(file, "select text from node")).toEqual([{ text: "user: hello" }])
  expect(rows(file, "select count(*) as n from launch")).toEqual([{ n: 2 }])
})

test("the readable query shows a kind as a word and a time as text", async () => {
  const file = newFile()
  await withDatabase(
    file,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const statement of BASE.slice(0, 3)) yield* sql.unsafe(statement)
      yield* sql`insert into msg (i, kind, text, size, launch, created) values (0, 2, 'hi', 2, 1, 1700000000000)`
    })
  )
  expect(rows(file, "select i, kind, at, text from msg_read")).toEqual([
    { i: 0, kind: "asst", at: "2023-11-14 22:13:20", text: "hi" }
  ])
})
