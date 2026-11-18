// The test of two tenants (docs/schema.html, section 1, "The tenant
// boundary"), on SQLite: the contract's suite (tests/contract/tenant.ts,
// `tenantCases`) with SQLite's harness, and here the cases that need SQLite
// itself (a `bun:sqlite` connection of their own, a pragma). The suite: on the code's own file, no member of the store reaches a row
// of another chat. One database holds tenant A and tenant B, a chat of
// B, three chats of A (a second one made before the chat under test, the
// chat under test, and a third one made after it), a second chat of B made
// after the chat under test, and rows of each chat in every table of a
// chat, its events too, written through the store; B has more rows than A
// in each, so B has row numbers that A does not have, and so has A's third
// chat. A launch of B, one of A's second chat and one of A's third chat are
// live while every case runs, on the host of A's launch, with the number
// that A's launch takes.
//
// "Another chat" is B's chat and A's other chats alike: the test catches a
// statement that has no condition on its chat (B shows it), one that
// reaches every chat of its tenant (A's second chat shows it), one that
// takes the chats from A's on (`chat >=`: B's second chat and A's third
// show it), and one that takes the chats up to A's (`chat <=`: B's and A's
// second show it). A's third chat shows a statement on the chat's table
// that keeps its tenant and takes its tenant's chats from A's on (`id >=`
// in place of `id =`): it would give A's third chat A's `seq` and
// `updated`, or give A's read two rows, which `only` refuses.
//
// - Reads: each member of `Reading`, on A's store and on A's reads, gives
//   the same answer with B's rows there as on a file that has only A's.
// - A row number of another chat: each member that takes a row's number,
//   given on A's store a number that only B has, or that only A's second
//   chat has, finds nothing or fails, and the other chats' rows stay as
//   they were.
// - Writes: after each write member has run on A's store, every row that is
//   not of A's chat is as it was, and each call's answer and A's rows are
//   those of the same calls on a file of A alone.
// - Launches: A's store opens while the launches of B and of A's second
//   chat are live, and leaves them so; a launch of A that a crash left is
//   closed as a crash, and only it.
// - No member is left out: the members of the store, taken at run time,
//   each have a case here.
// - The database refuses: a row of A that names a row only B has, for each
//   reference inside a chat of the schema.
// - The tag: tenant A with the UUID of B's chat gets `NoChat`, as for a
//   UUID that no chat has; with the UUID of its second chat, it gets that
//   chat.
//
// The times come from a test clock, so that the two files give the same
// answers to the millisecond. Each case runs on its own copy of a file that
// is built once. The building never fails the file's `beforeAll`: each
// write's failure is kept, and a case of the file names it.

import { Database as Sqlite } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { copy, harness, rows } from "../tests/help.ts"
import { A, both, chatId, notA, run, shape as contractShape, TENANT_A, tenantCases } from "../tests/contract/tenant.ts"
import { schema } from "./schema.ts"
import { Chats } from "@everchat/core/store"

// The schema's tables of a chat (those with a column `chat`), and each
// reference inside a chat: a foreign key (chat, x) to the parent's key
// (chat, n). Read from the schema itself, on a database in memory.
const shape = (() => {
  const db = new Sqlite(":memory:")
  try {
    for (const statement of schema) db.run(statement)
    const tables = db.query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name").all().map((row) => row.name)
    const ofChat = tables.filter((table) => db.query<{ name: string }, []>(`pragma table_info(${table})`).all().some((column) => column.name === "chat"))
    const references = ofChat.flatMap((table) => {
      const keys = db.query<{ id: number; table: string; from: string; to: string }, []>(`pragma foreign_key_list(${table})`).all()
      const ids = [...new Set(keys.map((key) => key.id))]
      return ids.flatMap((id) => {
        const parts = keys.filter((key) => key.id === id)
        const other = parts.find((key) => key.from !== "chat")
        return parts.length === 2 && parts.some((key) => key.from === "chat" && key.to === "chat") && other !== undefined
          ? [{ table, column: other.from, parent: other.table, key: other.to }]
          : []
      })
    })
    const keys = Object.fromEntries(
      ofChat.map((table) => [table, db.query<{ name: string; pk: number }, []>(`pragma table_info(${table})`).all().filter((column) => column.pk > 0).map((column) => column.name)])
    )
    // The columns of a table of a chat that name a pick: their ids depend
    // on the file (on the picks that came first), and not on the chat.
    const picks = Object.fromEntries(
      [...ofChat, "everchat_chat"].map((table) => [
        table,
        db.query<{ table: string; from: string }, []>(`pragma foreign_key_list(${table})`).all().filter((key) => key.table === "everchat_pick").map((key) => key.from)
      ])
    )
    return { ofChat, references, keys, picks }
  } finally {
    db.close()
  }
})()

// The suite, with SQLite's harness.
tenantCases(harness)

// Reads and writes
// ----------------

// The chat's switch of its wake-ups, which no member sets yet (plain SQL
// here): with A's off and every other chat's on, A's reads of due and
// waiting fires give none and a slot of A's changes nothing; so a statement
// whose test of the switch reads another chat's row shows.
test("reads and writes: with A's wake-ups off and the other chats' on, dueWakes and pendingWake on A's store give none, pendWake changes nothing, and every row that is not A's is as it was", async () => {
  const file = copy(both.file)
  const off = new Sqlite(file)
  try {
    off.run("update everchat_chat set wakeups = 0 where id = ?", [await chatId(file, both.a)])
  } finally {
    off.close()
  }
  expect(rows(file, "select count(*) as n from everchat_chat where wakeups = 1")).toEqual([{ n: 4 }])
  const before = await notA(file, both.a)
  const wakes = async () => rows(file, `select * from everchat_wake where chat = ${await chatId(file, both.a)} order by n`)
  const own = await wakes()
  const got = await run(file, Effect.gen(function*() {
    const chats = yield* Chats
    const store = yield* chats.store(TENANT_A, both.a, A.launch)
    const reads = yield* chats.reads(TENANT_A, both.a)
    return {
      due: [yield* store.dueWakes(Number.MAX_SAFE_INTEGER), yield* reads.dueWakes(Number.MAX_SAFE_INTEGER)],
      pending: [Option.isNone(yield* store.pendingWake()), Option.isNone(yield* reads.pendingWake())],
      pended: [yield* store.pendWake(1, { pending: 60_000, missed: 0, due: null }), yield* store.pendWake(2, { pending: 180_000, missed: 0, due: null })]
    }
  }))
  expect(got).toEqual({ due: [[], []], pending: [true, true], pended: [false, false] })
  expect(await wakes()).toEqual(own)
  expect(await notA(file, both.a)).toEqual(before)
})

// The database refuses
// --------------------

for (const { column, key, parent, table } of shape.references) {
  test(`the database refuses: a row of A in ${table} whose (chat, ${column}) names a row of ${parent} that only B has; A's own row passes`, async () => {
    const file = copy(both.file)
    const a = await chatId(file, both.a)
    const b = await chatId(file, both.b)
    const db = new Sqlite(file)
    try {
      // As the store's connection does (database.ts).
      db.run("pragma foreign_keys = on")
      const values = (query: string) => db.query<{ v: number | null }, []>(query).all().map((row) => row.v)
      const own = values(`select min(${key}) as v from ${parent} where chat = ${a}`)[0]
      const theirs = values(`select max(${key}) as v from ${parent} where chat = ${b} and ${key} not in (select ${key} from ${parent} where chat = ${a})`)[0]
      expect(own ?? null).not.toBeNull()
      expect(theirs ?? null).not.toBeNull()
      // A row of A to copy: for a call, a function's row (it has a parent
      // and no vendor's id, so no unique key holds it).
      // For a wake-up, one that a call made (it has a turn and a call).
      const template = db.query<Record<string, unknown>, []>(
        `select * from ${table} where chat = ${a} ${table === "everchat_call" ? "and parent is not null" : table === "everchat_wake" ? "and turn is not null" : ""} limit 1`
      ).get()
      expect(template).not.toBeNull()
      const insert = (value: number) => {
        const row: Record<string, unknown> = { ...template, [column]: value }
        // A new key: each column of the key that is not a reference keeps
        // no value of a row that is there.
        const refs = shape.references.filter((ref) => ref.table === table).map((ref) => ref.column)
        for (const part of shape.keys[table] ?? []) {
          if (part !== "chat" && !refs.includes(part)) row[part] = (values(`select max(${part}) as v from ${table}`)[0] ?? 0) + 1000
        }
        // An event's messages: the other one is A's own, so that only the
        // reference under test can refuse the row (and msg_last >= msg).
        if (table === "everchat_event" && column === "msg") row["msg_last"] = value
        if (table === "everchat_event" && column === "msg_last") row["msg"] = own
        delete row["live"]
        // A copy of a message has no sender's key: the index (chat,
        // sender_key) holds the one of the row that it copies.
        if (table === "everchat_msg") row["sender_key"] = null
        // A copy of an approval names a call of A that has none (the
        // key (chat, call)), but in the case of the call itself.
        if (table === "everchat_approval" && column !== "call") {
          row["call"] = values(`select min(n) as v from everchat_call where chat = ${a} and n not in (select call from everchat_approval where chat = ${a})`)[0]
        }
        // A wake-up's stop's call is set only on a row that `unwake` stopped,
        // with nothing to fire.
        if (table === "everchat_wake" && column === "stop_call") Object.assign(row, { stopped: 1, why: "unwake", due: null, pending: null })
        const names = Object.keys(row)
        db.run(`insert into ${table} (${names.join(", ")}) values (${names.map(() => "?").join(", ")})`, names.map((name) => row[name]) as Array<never>)
      }
      expect(() => insert(theirs!)).toThrow(/FOREIGN KEY constraint failed/)
      insert(own!)
    } finally {
      db.close()
    }
  })
}

test("the database refuses: the schema has each reference inside a chat that the store writes", () => {
  expect(shape.references.map((ref) => `${ref.table}.${ref.column}`).sort()).toEqual([
    "everchat_approval.call",
    "everchat_approval.msg",
    "everchat_approval.turn",
    "everchat_call.launch",
    "everchat_call.parent",
    "everchat_call.turn",
    "everchat_event.call",
    "everchat_event.msg",
    "everchat_event.msg_last",
    "everchat_event.turn",
    "everchat_log.launch",
    "everchat_msg.call",
    "everchat_msg.launch",
    "everchat_msg.turn",
    "everchat_msg_image.image",
    "everchat_msg_image.msg",
    "everchat_turn.head",
    "everchat_turn.launch",
    "everchat_turn_item.turn",
    "everchat_usage.turn",
    "everchat_wake.call",
    "everchat_wake.last_turn",
    "everchat_wake.stop_call",
    "everchat_wake.turn"
  ])
  // The contract's suite holds the tables of a chat and their picks' columns
  // as constants (tests/contract/tenant.ts, `shape`): they are the schema's.
  expect<unknown>({ ofChat: shape.ofChat, picks: shape.picks }).toEqual(contractShape)
})
