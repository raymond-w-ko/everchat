// Tests of the start's check (check.ts). With no server, on fixed texts and
// on the real files (`../tests/schema.ts`): the comparison of a file and a
// server's text of its table (`compare`) gives each kind of difference, one
// case each; ` AUTO_INCREMENT=<n>` is no difference; each file compared
// with itself has none; the rows of `everchat_kind` against `KINDS`
// (`compareRows`), ids of each type as texts, every row kept, the texts cut,
// the rows bounded, and the error made of any value. On each server that `EVERCHAT_MARIADB` names (`just
// test-mariadb`), each case on a schema of its own from `make`: the schema
// as made has none, also with rows; a user with `SELECT` alone gets the
// same answer, and a table on which it has no right is one that is missing;
// each change made as root gives the one difference that names it; the rows
// of `everchat_kind`, also with its id or name of another type, and 257 of
// them; five changes give one error with the five in their
// order, and its message; the check's session, and the caller's session as
// it was after it; the caller's texts. With the variable not there (the
// unit tier, the scoped check), the cases on a server skip, and their name
// says so; set with no path in it, one case fails.

import { MysqlClient } from "@effect/sql-mysql2"
import { describe, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { make, texts } from "../tests/schema.ts"
import { type Server, serverPaths, start, VARIABLE, WAIT_MAX } from "../tests/server.ts"
import { KINDS } from "@everchat/core/store"
import { check, compare, compareRows, type Difference, keyOf, ROW_TEXT_MAX, ROWS_MAX, WrongSchema } from "./check.ts"
import { client, type Options } from "./client.ts"
import { type Table, TABLES } from "./tables.ts"

const FILES = texts()

// The server's text of a table as made from its file: the file less its
// ";" and newline.
const shown = (table: Table) => FILES[table].slice(0, -2)

// `text` with `from` replaced by `to`; `from` is there once, so that a case
// changes what it names.
const swap = (text: string, from: string, to: string) => {
  expect(text.split(from).length).toBe(2)
  return text.replace(from, to)
}

// The number from 1 of the file's one line that starts with `part` after
// its indent, and that line less its indent and a last comma.
const lineOf = (table: Table, part: string) => {
  const lines = shown(table).split("\n")
  const at = lines.flatMap((line, index) => (line.trimStart().startsWith(part) ? [index + 1] : []))
  expect(at.length).toBe(1)
  const text = lines[at[0]! - 1]!.trimStart()
  return { at: at[0]!, text: text.endsWith(",") ? text.slice(0, -1) : text }
}

test("each file compared with the server's text of it (the file less ; and the newline) has no difference, for each of the 19 tables", () => {
  expect(TABLES.length).toBe(19)
  for (const table of TABLES) expect([table, compare(table, FILES[table], shown(table))]).toEqual([table, []])
})

test("each line of each file has a kind of its own (no other line), and a key that no other line of its table has", () => {
  for (const table of TABLES) {
    const keys = FILES[table].slice(0, -2).split("\n").map(keyOf)
    expect([table, keys.filter((key) => key.line === "other line")]).toEqual([table, []])
    expect([table, new Set(keys.map((key) => `${key.line} ${key.name}`)).size]).toEqual([table, keys.length])
  }
})

test("AUTO_INCREMENT=<n> in the server's options is no difference", () => {
  for (const table of ["everchat_pick", "everchat_chat"] as const) {
    const server = swap(shown(table), ") ENGINE=InnoDB DEFAULT", ") ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT")
    expect(compare(table, FILES[table], server)).toEqual([])
  }
})

test("a column's type: a line of both with another text, named, with its line in the file and both texts", () => {
  const steps = lineOf("everchat_turn", "`steps`")
  const server = swap(shown("everchat_turn"), "`steps` int(11) DEFAULT NULL", "`steps` bigint(20) DEFAULT NULL")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "other", line: "column", name: "steps", at: steps.at, file: steps.text, server: "`steps` bigint(20) DEFAULT NULL" }
  ])
})

test("a column missing: a line of the file that the server lacks", () => {
  const why = lineOf("everchat_turn", "`why`")
  const server = swap(shown("everchat_turn"), "  `why` mediumtext DEFAULT NULL,\n", "")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "lacks", line: "column", name: "why", at: why.at, file: why.text, server: null }
  ])
})

test("a column more: a line of the server that the file lacks", () => {
  const server = swap(shown("everchat_turn"), "  `tokens` bigint(20) DEFAULT NULL,\n", "  `tokens` bigint(20) DEFAULT NULL,\n  `extra` int(11) DEFAULT NULL,\n")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "more", line: "column", name: "extra", at: null, file: null, server: "`extra` int(11) DEFAULT NULL" }
  ])
})

test("a column moved: the one line at another place, and no other", () => {
  const created = lineOf("everchat_turn", "`created`")
  const without = swap(shown("everchat_turn"), "  `created` bigint(20) NOT NULL,\n", "")
  const server = swap(without, "  `chat` bigint(20) NOT NULL,\n", "  `chat` bigint(20) NOT NULL,\n  `created` bigint(20) NOT NULL,\n")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "moved", line: "column", name: "created", at: created.at, file: created.text, server: created.text }
  ])
})

test("a key missing: the file's key that the server lacks", () => {
  const key = lineOf("everchat_turn", "KEY `everchat_turn_running`")
  const server = swap(shown("everchat_turn"), "  KEY `everchat_turn_running` (`chat`,`status`),\n", "")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "lacks", line: "key", name: "everchat_turn_running", at: key.at, file: key.text, server: null }
  ])
})

test("a key's columns changed: the key of both with another text", () => {
  const key = lineOf("everchat_turn", "KEY `everchat_turn_running`")
  const server = swap(shown("everchat_turn"), "KEY `everchat_turn_running` (`chat`,`status`)", "KEY `everchat_turn_running` (`status`,`chat`)")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "other", line: "key", name: "everchat_turn_running", at: key.at, file: key.text, server: "KEY `everchat_turn_running` (`status`,`chat`)" }
  ])
})

test("a reference whose ON DELETE CASCADE went: the reference of both with another text", () => {
  const reference = lineOf("everchat_turn", "CONSTRAINT `everchat_turn_head_fk`")
  const server = swap(shown("everchat_turn"), "REFERENCES `everchat_head` (`chat`, `n`) ON DELETE CASCADE", "REFERENCES `everchat_head` (`chat`, `n`)")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    {
      _tag: "Line",
      table: "everchat_turn",
      change: "other",
      line: "reference",
      name: "everchat_turn_head_fk",
      at: reference.at,
      file: reference.text,
      server: "CONSTRAINT `everchat_turn_head_fk` FOREIGN KEY (`chat`, `head`) REFERENCES `everchat_head` (`chat`, `n`)"
    }
  ])
})

test("a reference missing: the file's reference that the server lacks", () => {
  const reference = lineOf("everchat_turn", "CONSTRAINT `everchat_turn_pick_fk`")
  const server = swap(shown("everchat_turn"), "  CONSTRAINT `everchat_turn_pick_fk` FOREIGN KEY (`pick`) REFERENCES `everchat_pick` (`id`),\n", "")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "lacks", line: "reference", name: "everchat_turn_pick_fk", at: reference.at, file: reference.text, server: null }
  ])
})

test("a check's text changed: the check of both with another text", () => {
  const ck = lineOf("everchat_turn", "CONSTRAINT `everchat_turn_ck2`")
  const server = swap(shown("everchat_turn"), "CHECK (`steps` > 0)", "CHECK (`steps` > 1)")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "other", line: "check", name: "everchat_turn_ck2", at: ck.at, file: ck.text, server: "CONSTRAINT `everchat_turn_ck2` CHECK (`steps` > 1)" }
  ])
})

test("a check missing: the file's check that the server lacks, also the last line before the options", () => {
  const ck = lineOf("everchat_turn", "CONSTRAINT `everchat_turn_ck5`")
  // The line before it loses its comma, which is no difference.
  const server = swap(shown("everchat_turn"), ",\n  CONSTRAINT `everchat_turn_ck5` CHECK (`steps` is null = (`tokens` is null))\n", "\n")
  expect(compare("everchat_turn", FILES.everchat_turn, server)).toEqual([
    { _tag: "Line", table: "everchat_turn", change: "lacks", line: "check", name: "everchat_turn_ck5", at: ck.at, file: ck.text, server: null }
  ])
})

test("the collation of the table: the options, the last line, of both with another text", () => {
  const options = lineOf("everchat_tenant", ") ENGINE=")
  const server = swap(shown("everchat_tenant"), "COLLATE=utf8mb4_nopad_bin", "COLLATE=utf8mb4_bin")
  expect(compare("everchat_tenant", FILES.everchat_tenant, server)).toEqual([
    {
      _tag: "Line",
      table: "everchat_tenant",
      change: "other",
      line: "options",
      name: "",
      at: options.at,
      file: options.text,
      server: ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC"
    }
  ])
})

test("the collation of one column: the column of both with another text", () => {
  const name = lineOf("everchat_kind", "`name`")
  const server = swap(shown("everchat_kind"), "`name` varchar(16) NOT NULL", "`name` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL")
  expect(compare("everchat_kind", FILES.everchat_kind, server)).toEqual([
    { _tag: "Line", table: "everchat_kind", change: "other", line: "column", name: "name", at: name.at, file: name.text, server: "`name` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL" }
  ])
})

test("two texts that differ where the cut of lines looks past (an indent, a comma) give one difference of the whole text", () => {
  for (const server of [swap(shown("everchat_kind"), "  `name`", "    `name`"), swap(shown("everchat_kind"), "NOT NULL,\n  PRIMARY", "NOT NULL\n  PRIMARY")]) {
    expect(compare("everchat_kind", FILES.everchat_kind, server)).toEqual([
      { _tag: "Line", table: "everchat_kind", change: "other", line: "text", name: "", at: null, file: shown("everchat_kind"), server }
    ])
  }
})

test("the error's message has one line for each difference, in its order", () => {
  const error = new WrongSchema({
    differences: [
      { _tag: "Missing", table: "everchat_wake" },
      { _tag: "Unlisted", table: "everchat_seen", view: true },
      { _tag: "KindRow", id: "8", code: "wake", server: null },
      { _tag: "NoText", table: "everchat_view" },
      { _tag: "NoTable", table: "everchat_more" }
    ]
  })
  expect(error.message.split("\n")).toEqual([
    "everchat_wake: missing, or the user has no right on it",
    "\"everchat_seen\": a view of the prefix everchat_ that is not in the list of tables",
    "everchat_kind, the row \"8\": the code has \"wake\", the server has none",
    "everchat_view: the caller gave no text of its file",
    "\"everchat_more\": the caller gave a text, and the list of tables has no such table"
  ])
})

// What the server prints at a listed name that is not a table (10.11.18 and
// 11.8.9 alike): a view with a definer of two made-up words, and a sequence,
// whose text starts as a table's.
const VIEW_TEXT = "CREATE ALGORITHM=UNDEFINED DEFINER=`quill`@`marsh` SQL SECURITY INVOKER VIEW `everchat_wake` AS select 1 AS `n`"
const SEQUENCE_TEXT = [
  "CREATE TABLE `everchat_wake` (",
  "  `next_not_cached_value` bigint(21) NOT NULL,",
  "  `minimum_value` bigint(21) NOT NULL,",
  "  `maximum_value` bigint(21) NOT NULL,",
  "  `start_value` bigint(21) NOT NULL COMMENT 'start value when sequences is created or value if RESTART is used',",
  "  `increment` bigint(21) NOT NULL COMMENT 'increment value',",
  "  `cache_size` bigint(21) unsigned NOT NULL,",
  "  `cycle_option` tinyint(1) unsigned NOT NULL COMMENT '0 if no cycles are allowed, 1 if the sequence should begin a new cycle when maximum_value is passed',",
  "  `cycle_count` bigint(21) NOT NULL COMMENT 'How many cycles have been done'",
  ") ENGINE=InnoDB SEQUENCE=1"
].join("\n")

// No `word` in any field of any difference, in the whole as JSON, or in the
// error's message.
const holdsNone = (differences: ReadonlyArray<Difference>, words: ReadonlyArray<string>) => {
  const message = new WrongSchema({ differences }).message
  const texts = [...differences.flatMap((one) => Object.values(one).map(String)), JSON.stringify(differences), message]
  return words.filter((word) => texts.some((text) => text.includes(word)))
}

test("a server's text that is a view's is one difference, not a table: a view, and no word of its definer is in the difference or in the message", () => {
  const found = compare("everchat_wake", FILES.everchat_wake, VIEW_TEXT)
  expect(found).toEqual([{ _tag: "NotATable", table: "everchat_wake", what: "view" }])
  expect(holdsNone(found, ["quill", "marsh", "DEFINER", "select 1"])).toEqual([])
  expect(new WrongSchema({ differences: found }).message).toBe("everchat_wake: not a table: a view stands at its name")
})

test("a server's text that is a sequence's (the first line a table's, the options SEQUENCE=1) is one difference, not a table: a sequence, with none of its lines", () => {
  const found = compare("everchat_wake", FILES.everchat_wake, SEQUENCE_TEXT)
  expect(found).toEqual([{ _tag: "NotATable", table: "everchat_wake", what: "sequence" }])
  expect(holdsNone(found, ["next_not_cached_value", "RESTART", "ENGINE"])).toEqual([])
})

test("a text whose first line is no CREATE TABLE line of that name is not cut into lines: not a table, something else", () => {
  for (const server of [swap(shown("everchat_kind"), "CREATE TABLE `everchat_kind` (", "CREATE TABLE `everchat_kinds` ("), "CREATE SOMETHING `everchat_kind`"]) {
    const found = compare("everchat_kind", FILES.everchat_kind, server)
    expect(found).toEqual([{ _tag: "NotATable", table: "everchat_kind", what: "other" }])
    expect(holdsNone(found, ["everchat_kinds", "SOMETHING", "varchar"])).toEqual([])
  }
})

test("a table whose column's comment or table's comment holds SEQUENCE=1 is a table: its lines are compared", () => {
  const column = swap(shown("everchat_kind"), "`name` varchar(16) NOT NULL", "`name` varchar(16) NOT NULL COMMENT ') ENGINE=InnoDB SEQUENCE=1'")
  expect(compare("everchat_kind", FILES.everchat_kind, column).map((one) => one._tag === "Line" ? [one.change, one.line, one.name] : one._tag)).toEqual([["other", "column", "name"]])
  const table = swap(shown("everchat_kind"), "ROW_FORMAT=DYNAMIC", "ROW_FORMAT=DYNAMIC COMMENT='a SEQUENCE=1, it''s no sequence'")
  expect(compare("everchat_kind", FILES.everchat_kind, table).map((one) => one._tag === "Line" ? [one.change, one.line, one.name] : one._tag)).toEqual([["other", "options", ""]])
})

test("a file whose CREATE TABLE line is of another form is the head's difference (the server's text is the table's)", () => {
  const file = swap(FILES.everchat_kind, "CREATE TABLE `everchat_kind` (", "CREATE TABLE IF NOT EXISTS `everchat_kind` (")
  expect(compare("everchat_kind", file, shown("everchat_kind"))).toEqual([
    { _tag: "Line", table: "everchat_kind", change: "other", line: "head", name: "", at: 1, file: "CREATE TABLE IF NOT EXISTS `everchat_kind` (", server: "CREATE TABLE `everchat_kind` (" }
  ])
})

// The rows of `everchat_kind` as the seed makes them, `[id, name]` in the
// order of the ids, each id as the driver gives a `tinyint`: a number.
const SEEDED: ReadonlyArray<readonly [number, string]> = Object.entries(KINDS).map(([name, id]) => [id, name] as const).sort((a, b) => a[0] - b[0])

// The eight rows that are missing, when no row of the server is a kind's.
const ALL_MISSING = SEEDED.map(([id, name]) => ({ _tag: "KindRow" as const, id: String(id), code: name, server: null }))

// The differences of `rows`, and the error made of them, which never throws
// (T3), with one line of its message for each.
const rowsOf = (rows: ReadonlyArray<ReadonlyArray<unknown>>) => {
  const found = compareRows(rows)
  expect(new WrongSchema({ differences: found }).message.split("\n").length).toBe(Math.max(found.length, 1))
  return found
}

test("the rows of everchat_kind as seeded have no difference, with each id as a number, a bigint or a text", () => {
  expect(SEEDED.length).toBe(8)
  expect(rowsOf(SEEDED)).toEqual([])
  expect(rowsOf(SEEDED.map(([id, name]) => [BigInt(id), name]))).toEqual([])
  expect(rowsOf(SEEDED.map(([id, name]) => [String(id), name]))).toEqual([])
})

test("a row renamed, a row missing and a row more: the code's ids in their order, then the rows more in the server's order, each id a text", () => {
  const rows = [...SEEDED.filter(([id]) => id !== 8).map(([id, name]) => [id, id === 3 ? "tools" : name]), [10, "ten"], [9, "nine"]]
  expect(rowsOf(rows)).toEqual([
    { _tag: "KindRow", id: "3", code: "tool", server: "tools" },
    { _tag: "KindRow", id: "8", code: "wake", server: null },
    { _tag: "KindRow", id: "10", code: null, server: "ten" },
    { _tag: "KindRow", id: "9", code: null, server: "nine" }
  ])
})

test("an id of 16 bytes (a binary(16) column), the one row: the eight rows missing and one row more, its id 0x and 32 hex digits", () => {
  const found = rowsOf([[Buffer.from("00112233445566778899aabbccddeeff", "hex"), "extra"]])
  expect(found).toEqual([...ALL_MISSING, { _tag: "KindRow", id: "0x00112233445566778899aabbccddeeff", code: null, server: "extra" }])
  // The same of bytes that are not a Buffer.
  expect(rowsOf([[new Uint8Array([0, 255, 16]), "x"]]).at(-1)).toEqual({ _tag: "KindRow", id: "0x00ff10", code: null, server: "x" })
})

test("ids as texts (a varchar column) with 03 beside 3: exactly one row more, 03, and 3 is kind 3's row", () => {
  // The server's order by a text: '03' before '1'.
  const rows = [["03", "extra"], ...SEEDED.map(([id, name]) => [String(id), name])]
  const found = rowsOf(rows)
  expect(found).toEqual([{ _tag: "KindRow", id: "03", code: null, server: "extra" }])
  expect(new WrongSchema({ differences: found }).message).toBe("everchat_kind, the row \"03\": the code has none, the server has \"extra\"")
})

test("two rows of one id's text: the first is the kind's row, the second a row more, whichever name each has", () => {
  const rest = SEEDED.filter(([id]) => id !== 3)
  expect(rowsOf([[3, "tool"], [3, "again"], ...rest])).toEqual([{ _tag: "KindRow", id: "3", code: null, server: "again" }])
  expect(rowsOf([[3, "again"], [3, "tool"], ...rest])).toEqual([
    { _tag: "KindRow", id: "3", code: "tool", server: "again" },
    { _tag: "KindRow", id: "3", code: null, server: "tool" }
  ])
})

test(`an id's and a name's text in a difference is at most ${ROW_TEXT_MAX} characters, cut there with …; the match is by the whole text`, () => {
  expect(ROW_TEXT_MAX).toBe(64)
  const long = "n".repeat(200)
  const id = "7".repeat(200)
  const found = rowsOf([...SEEDED.map(([one, name]) => [one, one === 3 ? long : name]), [id, long], ["8" + "\u{1F600}".repeat(70), "x"]])
  expect(found).toEqual([
    { _tag: "KindRow", id: "3", code: "tool", server: "n".repeat(64) + "…" },
    { _tag: "KindRow", id: "7".repeat(64) + "…", code: null, server: "n".repeat(64) + "…" },
    // The cut counts characters, not halves of one.
    { _tag: "KindRow", id: "8" + "\u{1F600}".repeat(63) + "…", code: null, server: "x" }
  ])
  // A name of 64 characters is whole; one that a cut would make equal to
  // the code's is still another name.
  expect(rowsOf([...SEEDED.filter(([one]) => one !== 3), [3, "t".repeat(64)]])).toEqual([{ _tag: "KindRow", id: "3", code: "tool", server: "t".repeat(64) }])
  expect(rowsOf([...SEEDED.filter(([one]) => one !== 3), [3, "tool" + " ".repeat(70)]])).toEqual([{ _tag: "KindRow", id: "3", code: "tool", server: "tool" + " ".repeat(60) + "…" }])
})

test(`${ROWS_MAX} rows (a tinyint has 256 values) are one difference, TooManyRows, and no row is compared; 256 rows are compared`, () => {
  expect(ROWS_MAX).toBe(257)
  const many = (count: number) => Array.from({ length: count }, (_, index) => [index + 1, index < 8 ? SEEDED[index]![1] : `k${index + 1}`])
  const found = rowsOf(many(257))
  expect(found).toEqual([{ _tag: "TooManyRows", table: "everchat_kind" }])
  expect(new WrongSchema({ differences: found }).message).toBe("everchat_kind: 257 rows or more, more than a kind's id can number: its rows are not compared")
  const fewer = rowsOf(many(256))
  expect([fewer.length, fewer.every((one) => one._tag === "KindRow" && one.code === null)]).toEqual([248, true])
})

test("an id that is null, a float, an object or an object with no prototype: each a row more with the driver's text of it, and the error is made (never a defect)", () => {
  const bare = Object.create(null)
  const found = rowsOf([...SEEDED, [null, "a"], [3.5, "b"], [{}, "c"], [bare, "d"], [Number.NaN, "e"], [2 ** 70, "f"], [4, null]])
  expect(found).toEqual([
    { _tag: "KindRow", id: "null", code: null, server: "a" },
    { _tag: "KindRow", id: "3.5", code: null, server: "b" },
    { _tag: "KindRow", id: "[object Object]", code: null, server: "c" },
    { _tag: "KindRow", id: "(a value with no text)", code: null, server: "d" },
    { _tag: "KindRow", id: "NaN", code: null, server: "e" },
    { _tag: "KindRow", id: "1180591620717411303424", code: null, server: "f" },
    { _tag: "KindRow", id: "4", code: null, server: "null" }
  ])
})

test("a text of a row with a newline is quoted in the message: one line for each difference", () => {
  const message = new WrongSchema({ differences: rowsOf([...SEEDED, ["9\nx", "a\nb"]]) }).message
  expect(message).toBe("everchat_kind, the row \"9\\nx\": the code has none, the server has \"a\\nb\"")
})

// The cases on a server, in the form of `client.test.ts`: the variable not
// there (they skip), there with no path in it (a case fails: nothing skips
// in silence), or the paths that it names (they run).
const GIVEN = process.env[VARIABLE]
const PATHS = serverPaths(process.env)

// The hang limit of a case that starts a server: a start makes a data
// directory. No measure of speed.
const SLOW = 4 * WAIT_MAX

const versionOf = (server: string) => /-mariadb-server-([0-9.]+)$/.exec(server)?.[1] ?? "(no version in the path)"

// A server of `server`, started under a new directory of the case's
// temporary root, with the schema `acme_dev` made from the files, for
// `body`; stopped in a `finally`.
const onSchema = async (server: string, body: (one: Server) => Promise<void>) => {
  const one = await start(server, fs.mkdtempSync(path.join(os.tmpdir(), "db-")))
  try {
    await make(one, "acme_dev")
    await body(one)
  } finally {
    await one.stop()
  }
}

// The differences that the check gives through a client of `options` (none
// when it ends with nothing). Any other failure, a defect too, rejects.
const differences = (options: Options, given: Readonly<Record<string, string>> = FILES): Promise<ReadonlyArray<Difference>> =>
  Effect.runPromise(
    check(given).pipe(
      Effect.as<ReadonlyArray<Difference>>([]),
      Effect.catchTag("WrongSchema", (error) => Effect.succeed(error.differences)),
      Effect.provide(client(options))
    )
  )

// The data that a case asserts of a difference: its table, its kind, its
// name.
const brief = (difference: Difference) => {
  switch (difference._tag) {
    case "Line":
      return [difference.table, difference.change, difference.line, difference.name]
    case "KindRow":
      return ["everchat_kind", "row", difference.id, difference.code, difference.server]
    case "Unlisted":
      return [difference.table, difference.view ? "view" : "table"]
    case "NotATable":
      return [difference.table, "not a table", difference.what]
    default:
      return [difference.table, difference._tag]
  }
}

const root = (one: Server): Options => ({ socket: one.socket, user: "root", schema: "acme_dev" })

// What the check ends with through a client of `options`, as a value: its
// differences and its message, nothing for a pass, or the text of another
// failure (so that a case asserts it). A defect rejects.
const settled = (options: Options, given: Readonly<Record<string, string>> = FILES): Promise<{ readonly differences?: ReadonlyArray<Difference>; readonly message?: string; readonly failed?: string }> =>
  Effect.runPromise(
    check(given).pipe(
      Effect.as({}),
      Effect.catchTag("WrongSchema", (error) => Effect.succeed({ differences: error.differences, message: error.message })),
      Effect.catch((error) => Effect.succeed({ failed: String(error) })),
      Effect.provide(client(options))
    )
  )

// Each change of the schema, made as root, and the one difference that names
// it.
const CHANGES: ReadonlyArray<{ readonly name: string; readonly sql: string; readonly want: Array<Array<string>> }> = [
  { name: "a table dropped", sql: "set foreign_key_checks = 0; drop table everchat_wake", want: [["everchat_wake", "Missing"]] },
  { name: "a column's type altered", sql: "alter table everchat_turn modify `steps` bigint(20) DEFAULT NULL", want: [["everchat_turn", "other", "column", "steps"]] },
  { name: "a column added", sql: "alter table everchat_turn add column `extra` int", want: [["everchat_turn", "more", "column", "extra"]] },
  { name: "a column moved", sql: "alter table everchat_turn modify `created` bigint(20) NOT NULL after `chat`", want: [["everchat_turn", "moved", "column", "created"]] },
  { name: "a key dropped", sql: "alter table everchat_turn drop key everchat_turn_running", want: [["everchat_turn", "lacks", "key", "everchat_turn_running"]] },
  { name: "a key added", sql: "alter table everchat_turn add key everchat_turn_extra (`created`)", want: [["everchat_turn", "more", "key", "everchat_turn_extra"]] },
  {
    name: "a reference dropped and made again with no cascade",
    sql: "alter table everchat_turn drop foreign key everchat_turn_head_fk; alter table everchat_turn add constraint everchat_turn_head_fk foreign key (`chat`, `head`) references everchat_head (`chat`, `n`)",
    want: [["everchat_turn", "other", "reference", "everchat_turn_head_fk"]]
  },
  { name: "a check dropped", sql: "alter table everchat_turn drop constraint everchat_turn_ck2", want: [["everchat_turn", "lacks", "check", "everchat_turn_ck2"]] },
  {
    // The last check: a check made again goes to the end of the list.
    name: "a check's expression changed",
    sql: "alter table everchat_turn drop constraint everchat_turn_ck5, add constraint everchat_turn_ck5 check (`steps` is null = (`tokens` is not null))",
    want: [["everchat_turn", "other", "check", "everchat_turn_ck5"]]
  },
  {
    // A table with no column of text: a table's collation that is not its
    // columns' makes the server name each one's.
    name: "the table's collation changed",
    sql: "alter table everchat_tenant collate utf8mb4_bin",
    want: [["everchat_tenant", "other", "options", ""]]
  },
  {
    name: "one column's collation changed",
    sql: "alter table everchat_kind modify `name` varchar(16) collate utf8mb4_bin not null",
    want: [["everchat_kind", "other", "column", "name"]]
  },
  { name: "a table everchat_more made", sql: "create table everchat_more (id int primary key)", want: [["everchat_more", "table"]] },
  { name: "a view everchat_seen made", sql: "create view everchat_seen as select id from everchat_kind", want: [["everchat_seen", "view"]] },
  { name: "a table orders made (another prefix: no difference)", sql: "create table orders (id int primary key)", want: [] },
  { name: "a table everchatx made (no underscore: not the prefix, no difference)", sql: "create table everchatx (id int primary key)", want: [] }
]

if (GIVEN === undefined) {
  const why = `the cases on a server: skipped, ${VARIABLE} is not set (just test-mariadb sets it)`
  // `bun test` prints no skipped case's name: the output says it too.
  console.log("packages/mariadb/src/check.test.ts: " + why)
  test.skip(why, () => {})
} else if (PATHS.length === 0) {
  test(`the cases on a server: ${VARIABLE} is set and names no server`, () => {
    throw new Error(`${VARIABLE} is set and names no server (${JSON.stringify(GIVEN)}): give the servers' paths, separated by spaces, or leave it unset to skip the cases on a server`)
  })
}

for (const server of PATHS) {
  describe(`the start's check on MariaDB ${versionOf(server)} (${server})`, () => {
    test("the schema as made has no difference; with a pick and a chat inserted (the tables with auto_increment) it has none", async () => {
      await onSchema(server, async (one) => {
        expect(await differences(root(one))).toEqual([])
        await one.query(
          [
            "use acme_dev",
            "insert into everchat_tenant (id, created) values (unhex('00112233445566778899aabbccddeeff'), 1)",
            "insert into everchat_pick (vendor, model, effort, speed, created) values ('acme', 'm1', 'high', 'normal', 1)",
            "insert into everchat_chat (tenant, uuid, pick, created, updated) values (unhex('00112233445566778899aabbccddeeff'), unhex('ffeeddccbbaa99887766554433221100'), 1, 1, 1)"
          ].join("; ")
        )
        // The server's text of both now has AUTO_INCREMENT=2.
        expect((await one.query("show create table acme_dev.everchat_chat")).includes(" AUTO_INCREMENT=2 ")).toBe(true)
        expect(await differences(root(one))).toEqual([])
      })
    }, SLOW)

    test("a user with SELECT on the schema and no other right gets the same answer: none on the schema as made, and the differences on a changed one", async () => {
      await onSchema(server, async (one) => {
        const password = "pw-" + crypto.randomUUID()
        // The password goes through the driver, not the helper's command line.
        await Effect.runPromise(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe(`create user 'acme_reader'@'localhost' identified by '${password}'`)
          }).pipe(Effect.provide(client({ socket: one.socket, user: "root" })))
        )
        await one.query("grant select on acme_dev.* to 'acme_reader'@'localhost'")
        expect((await one.query("show grants for 'acme_reader'@'localhost'")).split("\n").filter((line) => line.startsWith("GRANT ") && !line.startsWith("GRANT USAGE"))).toEqual([
          "GRANT SELECT ON `acme_dev`.* TO `acme_reader`@`localhost`"
        ])
        const asReader: Options = { socket: one.socket, user: "acme_reader", password: Redacted.make(password), schema: "acme_dev" }
        expect(await differences(asReader)).toEqual([])
        await one.query(
          [
            "use acme_dev",
            "alter table everchat_turn modify `steps` bigint(20) DEFAULT NULL",
            "create table everchat_more (id int primary key)",
            "update everchat_kind set name = 'tools' where id = 3"
          ].join("; ")
        )
        const seen = await differences(asReader)
        expect(seen.map(brief)).toEqual([
          ["everchat_turn", "other", "column", "steps"],
          ["everchat_more", "table"],
          ["everchat_kind", "row", "3", "tool", "tools"]
        ])
        expect(seen).toEqual(await differences(root(one)))
      })
    }, SLOW)

    test("a table on which the user has no right (SELECT granted on each other table) is the same difference as a table that is missing", async () => {
      await onSchema(server, async (one) => {
        const password = "pw-" + crypto.randomUUID()
        await Effect.runPromise(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe(`create user 'acme_reader'@'localhost' identified by '${password}'`)
          }).pipe(Effect.provide(client({ socket: one.socket, user: "root" })))
        )
        await one.query(TABLES.filter((table) => table !== "everchat_wake").map((table) => `grant select on acme_dev.${table} to 'acme_reader'@'localhost'`).join("; "))
        expect(await differences({ socket: one.socket, user: "acme_reader", password: Redacted.make(password), schema: "acme_dev" })).toEqual([
          { _tag: "Missing", table: "everchat_wake" }
        ])
      })
    }, SLOW)

    for (const change of CHANGES) {
      test(`${change.name}, made as root, gives the one difference that names it`, async () => {
        await onSchema(server, async (one) => {
          await one.query(`use acme_dev; ${change.sql}`)
          expect((await differences(root(one))).map(brief)).toEqual(change.want)
        })
      }, SLOW)
    }

    test("the rows of everchat_kind: one deleted, one renamed and one more give three differences, each with the id and the two names", async () => {
      await onSchema(server, async (one) => {
        await one.query("use acme_dev; delete from everchat_kind where id = 8; update everchat_kind set name = 'tools' where id = 3; insert into everchat_kind (id, name) values (9, 'more')")
        expect(await differences(root(one))).toEqual([
          { _tag: "KindRow", id: "3", code: "tool", server: "tools" },
          { _tag: "KindRow", id: "8", code: "wake", server: null },
          { _tag: "KindRow", id: "9", code: null, server: "more" }
        ])
      })
    }, SLOW)

    test("five changes at once give one error with the five, in the order of TABLES, then the tables of the prefix, then the rows; its message has one line for each", async () => {
      await onSchema(server, async (one) => {
        // Made in another order than the error's.
        await one.query(
          [
            "use acme_dev",
            "update everchat_kind set name = 'tools' where id = 3",
            "create table everchat_more (id int primary key)",
            "set foreign_key_checks = 0",
            "drop table everchat_wake",
            "alter table everchat_turn add column `extra` int",
            "alter table everchat_chat modify `goal` text DEFAULT NULL"
          ].join("; ")
        )
        const failed = await Effect.runPromise(Effect.flip(check(FILES)).pipe(Effect.provide(client(root(one)))))
        expect(failed).toBeInstanceOf(WrongSchema)
        const error = failed as WrongSchema
        expect(error.differences.map(brief)).toEqual([
          ["everchat_chat", "other", "column", "goal"],
          ["everchat_turn", "more", "column", "extra"],
          ["everchat_wake", "Missing"],
          ["everchat_more", "table"],
          ["everchat_kind", "row", "3", "tool", "tools"]
        ])
        const goal = lineOf("everchat_chat", "`goal`")
        expect(error.message.split("\n")).toEqual([
          `everchat_chat: column "goal", line ${goal.at} of the file: the file has "\`goal\` mediumtext DEFAULT NULL", the server has "\`goal\` text DEFAULT NULL"`,
          `everchat_turn: column "extra": the file lacks it: the server has "\`extra\` int(11) DEFAULT NULL"`,
          "everchat_wake: missing, or the user has no right on it",
          "\"everchat_more\": a table of the prefix everchat_ that is not in the list of tables",
          "everchat_kind, the row \"3\": the code has \"tool\", the server has \"tools\""
        ])
        console.log("packages/mariadb/src/check.test.ts: the message of five changes:\n" + error.message)
      })
    }, SLOW)

    test("on a connection whose session has sql_mode ANSI and sql_quote_show_create 0, the schema as made has no difference, and the session's two values are as before after the check; after a check that failed, too", async () => {
      await onSchema(server, async (one) => {
        // A pool of one connection: the check's is the case's.
        const single = MysqlClient.layer({ username: "root", database: "acme_dev", maxConnections: 1, poolConfig: { socketPath: one.socket } })
        const read = Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql.unsafe<{ id: number; mode: string; quote: number }>(
            "select connection_id() as id, @@session.sql_mode as mode, @@session.sql_quote_show_create as quote"
          )
          return rows[0]!
        })
        const seen = await Effect.runPromise(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe("set session sql_mode = 'ANSI', sql_quote_show_create = 0")
            const before = yield* read
            const passed = yield* Effect.result(check(FILES))
            const afterPass = yield* read
            yield* Effect.promise(() => one.query("use acme_dev; alter table everchat_turn add column `extra` int"))
            const failed = yield* Effect.flip(check(FILES))
            const afterFail = yield* read
            return { before, passed: passed._tag, afterPass, failed: failed instanceof WrongSchema ? failed.differences.map(brief) : String(failed), afterFail }
          }).pipe(Effect.provide(single))
        )
        expect(seen.before.mode.split(",")).toContain("ANSI_QUOTES")
        expect(seen.before.quote).toBe(0)
        expect(seen.passed).toBe("Success")
        expect(seen.afterPass).toEqual(seen.before)
        // Under the caller's session every text would differ: one difference
        // says that the check's own session was set.
        expect(seen.failed).toEqual([["everchat_turn", "more", "column", "extra"]])
        expect(seen.afterFail).toEqual(seen.before)
      })
    }, SLOW)

    test("the caller's texts: with one table's text left out, and with a text of one name more, each is the difference that names it", async () => {
      await onSchema(server, async (one) => {
        const { everchat_view: _, ...less } = FILES
        expect(await differences(root(one), less)).toEqual([{ _tag: "NoText", table: "everchat_view" }])
        expect(await differences(root(one), { ...FILES, everchat_more: "CREATE TABLE `everchat_more` (\n  `id` int(11) NOT NULL\n);\n" })).toEqual([
          { _tag: "NoTable", table: "everchat_more" }
        ])
      })
    }, SLOW)

    // A user with SELECT alone on the schema, its password a random value
    // that goes through the driver.
    const selectOnly = async (one: Server): Promise<Options> => {
      const password = "pw-" + crypto.randomUUID()
      await Effect.runPromise(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql.unsafe(`create user 'acme_reader'@'localhost' identified by '${password}'`)
        }).pipe(Effect.provide(client({ socket: one.socket, user: "root" })))
      )
      await one.query("grant select on acme_dev.* to 'acme_reader'@'localhost'")
      return { socket: one.socket, user: "acme_reader", password: Redacted.make(password), schema: "acme_dev" }
    }

    // A view at `everchat_wake` (the references' check off), with a definer
    // of two made-up words.
    const VIEW_AT_WAKE = "set foreign_key_checks = 0; drop table everchat_wake; create definer = 'quill'@'marsh' sql security invoker view everchat_wake as select 1 as n"

    test("a view at a listed name, with a definer of two words: one difference, not a table: a view, with neither word in the error's data or message; the same as a user with SELECT alone", async () => {
      await onSchema(server, async (one) => {
        const reader = await selectOnly(one)
        await one.query(`use acme_dev; ${VIEW_AT_WAKE}`)
        for (const options of [root(one), reader]) {
          const seen = await settled(options)
          expect([options.user, seen.differences]).toEqual([options.user, [{ _tag: "NotATable", table: "everchat_wake", what: "view" }]])
          expect([options.user, holdsNone(seen.differences ?? [], ["quill", "marsh"]), seen.message?.includes("quill") || seen.message?.includes("marsh")]).toEqual([options.user, [], false])
        }
      })
    }, SLOW)

    test("a view at a listed name with four other changes at once: the five in N8's order, neither word of the definer in the error; the same as a user with SELECT alone", async () => {
      await onSchema(server, async (one) => {
        const reader = await selectOnly(one)
        await one.query(
          [
            "use acme_dev",
            "update everchat_kind set name = 'tools' where id = 3",
            "create table everchat_more (id int primary key)",
            VIEW_AT_WAKE,
            "alter table everchat_turn add column `extra` int",
            "alter table everchat_chat modify `goal` text DEFAULT NULL"
          ].join("; ")
        )
        const seen = await settled(root(one))
        expect(seen.differences?.map(brief)).toEqual([
          ["everchat_chat", "other", "column", "goal"],
          ["everchat_turn", "more", "column", "extra"],
          ["everchat_wake", "not a table", "view"],
          ["everchat_more", "table"],
          ["everchat_kind", "row", "3", "tool", "tools"]
        ])
        expect(holdsNone(seen.differences ?? [], ["quill", "marsh"])).toEqual([])
        expect(seen.message?.split("\n")[2]).toBe("everchat_wake: not a table: a view stands at its name")
        expect(await settled(reader)).toEqual(seen)
        console.log("packages/mariadb/src/check.test.ts: the message of a view and four changes:\n" + seen.message)
      })
    }, SLOW)

    test("a sequence at a listed name: one difference, not a table: a sequence", async () => {
      await onSchema(server, async (one) => {
        await one.query("use acme_dev; set foreign_key_checks = 0; drop table everchat_wake; create sequence everchat_wake")
        expect((await settled(root(one))).differences).toEqual([{ _tag: "NotATable", table: "everchat_wake", what: "sequence" }])
      })
    }, SLOW)

    test("a view at everchat_kind, with columns id and name: not a table, and its rows are not read", async () => {
      await onSchema(server, async (one) => {
        await one.query("use acme_dev; set foreign_key_checks = 0; drop table everchat_kind; create view everchat_kind as select 3 as id, 'tools' as name")
        expect((await settled(root(one))).differences).toEqual([{ _tag: "NotATable", table: "everchat_kind", what: "view" }])
      })
    }, SLOW)

    test("everchat_kind's name widened to varchar(17), row 3 renamed, row 8 deleted and a row 9 added: the column's difference and the three rows'", async () => {
      await onSchema(server, async (one) => {
        await one.query(
          "use acme_dev; alter table everchat_kind modify `name` varchar(17) not null; update everchat_kind set name = 'tools' where id = 3; delete from everchat_kind where id = 8; insert into everchat_kind (id, name) values (9, 'more')"
        )
        const name = lineOf("everchat_kind", "`name`")
        expect((await settled(root(one))).differences).toEqual([
          { _tag: "Line", table: "everchat_kind", change: "other", line: "column", name: "name", at: name.at, file: name.text, server: "`name` varchar(17) NOT NULL" },
          { _tag: "KindRow", id: "3", code: "tool", server: "tools" },
          { _tag: "KindRow", id: "8", code: "wake", server: null },
          { _tag: "KindRow", id: "9", code: null, server: "more" }
        ])
      })
    }, SLOW)

    test("the caller's texts with two names more, given out of order: the two differences in the names' order", async () => {
      await onSchema(server, async (one) => {
        const more = "CREATE TABLE `x` (\n  `id` int(11) NOT NULL\n);\n"
        expect((await settled(root(one), { ...FILES, everchat_zz: more, everchat_aa: more })).differences).toEqual([
          { _tag: "NoTable", table: "everchat_aa" },
          { _tag: "NoTable", table: "everchat_zz" }
        ])
      })
    }, SLOW)

    test("everchat_kind's column name renamed: the lines' differences, no difference of a row, and no error of the select", async () => {
      await onSchema(server, async (one) => {
        await one.query("use acme_dev; alter table everchat_kind change `name` `label` varchar(16) not null; update everchat_kind set label = 'tools' where id = 3")
        expect((await settled(root(one))).differences?.map(brief)).toEqual([
          ["everchat_kind", "lacks", "column", "name"],
          ["everchat_kind", "other", "key", "everchat_kind_name"],
          ["everchat_kind", "more", "column", "label"]
        ])
      })
    }, SLOW)

    // T6: everchat_kind made again or altered so that its ids or names are
    // of another type; the outcome is read as a value, and is WrongSchema
    // (never a defect, never a SqlError).
    const kindAs = async (one: Server, sql: string) => {
      await one.query(`use acme_dev; set foreign_key_checks = 0; ${sql}`)
      const seen = await settled(root(one))
      expect([seen.failed, seen.differences === undefined]).toEqual([undefined, false])
      return seen
    }

    test("the review's first probe: everchat_kind made again with id binary(16) and one row of 16 bytes: the lines' differences, the eight rows missing, and the row more with its id as 0x and 32 hex digits", async () => {
      await onSchema(server, async (one) => {
        const seen = await kindAs(one, "drop table everchat_kind; create table everchat_kind (id binary(16) primary key, name varchar(32)); insert into everchat_kind values (unhex('00112233445566778899aabbccddeeff'), 'extra')")
        expect(seen.differences?.map(brief)).toEqual([
          ["everchat_kind", "other", "column", "id"],
          ["everchat_kind", "other", "column", "name"],
          ["everchat_kind", "lacks", "key", "everchat_kind_name"],
          ["everchat_kind", "other", "options", ""],
          ...Object.entries(KINDS).map(([name, id]) => ["everchat_kind", "row", String(id), name, null]),
          ["everchat_kind", "row", "0x00112233445566778899aabbccddeeff", null, "extra"]
        ])
        expect(seen.differences?.at(-1)).toEqual({ _tag: "KindRow", id: "0x00112233445566778899aabbccddeeff", code: null, server: "extra" })
      })
    }, SLOW)

    test("the review's second probe: everchat_kind made again with id varchar(32), the eight rows as texts and ('03', 'extra'): the lines' differences and exactly one row more, 03", async () => {
      await onSchema(server, async (one) => {
        const rows = Object.entries(KINDS).map(([name, id]) => `('${id}', '${name}')`).join(", ")
        const seen = await kindAs(one, `drop table everchat_kind; create table everchat_kind (id varchar(32) primary key, name varchar(32)); insert into everchat_kind values ${rows}, ('03', 'extra')`)
        expect(seen.differences?.map(brief)).toEqual([
          ["everchat_kind", "other", "column", "id"],
          ["everchat_kind", "other", "column", "name"],
          ["everchat_kind", "lacks", "key", "everchat_kind_name"],
          ["everchat_kind", "other", "options", ""],
          ["everchat_kind", "row", "03", null, "extra"]
        ])
        expect(seen.differences?.at(-1)).toEqual({ _tag: "KindRow", id: "03", code: null, server: "extra" })
        expect(seen.message?.split("\n").at(-1)).toBe("everchat_kind, the row \"03\": the code has none, the server has \"extra\"")
        console.log("packages/mariadb/src/check.test.ts: the message of ids as texts with 03:\n" + seen.message)
      })
    }, SLOW)

    test("everchat_kind's name made a text and row 3's name 200 characters long: the column's difference, and the row's with 64 characters of the name and …", async () => {
      await onSchema(server, async (one) => {
        const seen = await kindAs(one, `alter table everchat_kind modify \`name\` text not null; update everchat_kind set name = repeat('n', 200) where id = 3`)
        expect(seen.differences?.map(brief)).toEqual([
          ["everchat_kind", "other", "column", "name"],
          ["everchat_kind", "other", "key", "everchat_kind_name"],
          ["everchat_kind", "row", "3", "tool", "n".repeat(64) + "…"]
        ])
      })
    }, SLOW)

    test("257 rows in everchat_kind (its id made a smallint): the column's difference and one difference that the rows are too many, with no row's", async () => {
      await onSchema(server, async (one) => {
        // Made again from its file with the one column changed: a reference
        // of everchat_msg holds the column, so an alter is refused (1833).
        const rows = Array.from({ length: 257 }, (_, index) => `(${index + 1}, '${index < 8 ? SEEDED[index]![1] : `k${index + 1}`}')`).join(", ")
        const file = swap(FILES.everchat_kind, "`id` tinyint(4) NOT NULL", "`id` smallint(6) NOT NULL")
        const seen = await kindAs(one, `drop table everchat_kind; ${file} insert into everchat_kind (id, name) values ${rows}`)
        expect((await one.query("select count(*), max(id) from acme_dev.everchat_kind")).trim().split("\n").at(-1)).toBe("257\t257")
        expect(seen.differences?.map(brief)).toEqual([
          ["everchat_kind", "other", "column", "id"],
          ["everchat_kind", "TooManyRows"]
        ])
      })
    }, SLOW)
  })
}
