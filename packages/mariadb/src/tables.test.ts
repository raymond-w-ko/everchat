// Tests of the schema's files (`schema/mariadb/`) and of their list
// (tables.ts). With no server: the directory holds one file for each name of
// `TABLES`, and `TABLES` is SQLite's list of tables in its order; each file
// is one `CREATE TABLE` in the server's form, with the names of its
// references and checks in the schema's form; its columns are the page's
// (`docs/schema.html`, the column tables), with the page's MariaDB types;
// its columns with `not null` and their defaults, its keys and indexes, its
// references and its checks' expressions are SQLite's
// (`@everchat/sqlite/schema`, made in memory), but for the differences named
// below. On each server that `EVERCHAT_MARIADB` names (`just test-mariadb`):
// the schema made from the files (`../tests/schema.ts`) has exactly the 19
// tables, each shown as its file; the seed gives `KINDS` and can run again;
// the references cascade; a short id is padded (what the store's edge must
// hold).
// With the variable not there (the unit tier, the scoped check), the cases
// on a server skip, and their name says so; set with no path in it, one
// case fails.

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { KINDS } from "@everchat/core/store"
import { schema } from "@everchat/sqlite/schema"
import { make, SCHEMA_DIR, seed, texts } from "../tests/schema.ts"
import { type Server, serverPaths, start, VARIABLE, WAIT_MAX } from "../tests/server.ts"
import { client } from "./client.ts"
import { type Table, TABLES } from "./tables.ts"

const PAGE = path.join(import.meta.dir, "../../../docs/schema.html")

// The options of each table (R12), its file's last line.
const OPTIONS = ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin ROW_FORMAT=DYNAMIC;"

// The number of checks of each table, in the order of `TABLES`: a change of
// a file's checks shows in this list's diff. SQLite's two checks of an id's
// 16 bytes (`everchat_tenant.id`, `everchat_chat.uuid`) have none, a
// difference from SQLite: on MariaDB the schema does not hold an id's 16
// bytes. A value of more than 16 bytes is refused; a shorter one is stored
// with zero bytes after it, with no error, and a check cannot see it. The
// length is held by the store's edge, which makes each id from a UUID before
// a statement (the case on a server "MariaDB pads a short id").
const CHECKS: Readonly<Record<Table, number>> = {
  everchat_tenant: 0,
  everchat_pick: 0,
  everchat_kind: 0,
  everchat_chat: 1,
  everchat_launch: 0,
  everchat_head: 0,
  everchat_turn: 5,
  everchat_turn_item: 1,
  everchat_call: 3,
  everchat_msg: 1,
  everchat_image: 1,
  everchat_msg_image: 0,
  everchat_node: 2,
  everchat_view: 2,
  everchat_usage: 1,
  everchat_log: 1,
  everchat_event: 3,
  everchat_approval: 4,
  everchat_wake: 13
}

// Where the files and SQLite's schema must differ, each with its reason:
// the columns that are `NOT NULL` in a file and not in SQLite. An `integer
// primary key` is SQLite's rowid, which its pragma gives as nullable, though
// it is never null; a key's column is `NOT NULL` on MariaDB.
const NOT_NULL_IN_FILE_ONLY = ["everchat_pick.id", "everchat_kind.id", "everchat_chat.id"]

// The keys that SQLite makes of a table's `unique` (its own index, named
// `sqlite_autoindex_<table>_<n>`, since its DDL gives no name), by the table
// and the key's columns in order: the name that the file gives the key.
const UNIQUE_NAMES: Readonly<Record<string, string>> = {
  "everchat_pick (vendor, model, effort, speed)": "everchat_pick_choice",
  "everchat_kind (name)": "everchat_kind_name",
  "everchat_chat (uuid)": "everchat_chat_uuid",
  "everchat_head (chat, hash)": "everchat_head_hash",
  "everchat_image (chat, name)": "everchat_image_name",
  "everchat_approval (chat, call)": "everchat_approval_call"
}

// The index that the server writes for a reference: InnoDB needs an index
// that starts with a reference's columns, and SQLite does not. A file's plain
// key named as one of its table's references, on that reference's columns,
// is such an index, and SQLite has none of it; a file has one exactly for
// each reference whose columns no other key (the primary key too) starts with.
const isReferenceIndex = (table: Table, key: Parsed["keys"][number]) =>
  !key.unique && parsed[table].references.some((ref) => ref.name === key.name && ref.columns.join() === key.columns.join())

// SQLite's checks that have no check in a file, in the normal form of
// `normal` below: the checks of an id's 16 bytes (see `CHECKS`).
const NO_FILE_CHECK = ["everchat_tenant: (length(id) = 16)", "everchat_chat: (length(uuid) = 16)"]

// A file's check that the normal form cannot compare, by its name, each with
// its reason. None today; if more than 8 of the 38 needed it, the rule of the
// pages would be made narrower instead.
const CHECKS_NOT_COMPARED: Readonly<Record<string, string>> = {}

// One table's file, read line by line in the server's form. A line of
// another form is in `unknown`.
interface Parsed {
  readonly name: string
  readonly columns: ReadonlyArray<{ readonly name: string; readonly definition: string }>
  readonly primary: ReadonlyArray<string>
  readonly keys: ReadonlyArray<{ readonly name: string; readonly unique: boolean; readonly columns: ReadonlyArray<string> }>
  readonly references: ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string>; readonly table: string; readonly to: ReadonlyArray<string>; readonly cascade: boolean }>
  readonly checks: ReadonlyArray<{ readonly name: string; readonly text: string }>
  readonly last: string
  readonly unknown: ReadonlyArray<string>
}

const names = (list: string) => list.split(",").map((one) => one.trim().replace(/^`|`$/g, ""))

const parse = (text: string): Parsed => {
  const lines = text.split("\n")
  const head = /^CREATE TABLE `(\w+)` \($/.exec(lines[0] ?? "")
  const body = lines.slice(1, -2)
  const columns: Array<Parsed["columns"][number]> = []
  const primary: Array<string> = []
  const keys: Array<Parsed["keys"][number]> = []
  const references: Array<Parsed["references"][number]> = []
  const checks: Array<Parsed["checks"][number]> = []
  const unknown: Array<string> = []
  for (const raw of body) {
    const line = raw.replace(/,$/, "")
    let m: RegExpExecArray | null
    if ((m = /^ {2}`(\w+)` (.+)$/.exec(line))) columns.push({ name: m[1]!, definition: m[2]! })
    else if ((m = /^ {2}PRIMARY KEY \((.+)\)$/.exec(line))) primary.push(...names(m[1]!))
    else if ((m = /^ {2}(UNIQUE )?KEY `(\w+)` \((.+)\)$/.exec(line))) keys.push({ name: m[2]!, unique: m[1] !== undefined, columns: names(m[3]!) })
    else if ((m = /^ {2}CONSTRAINT `(\w+)` FOREIGN KEY \(([^)]+)\) REFERENCES `(\w+)` \(([^)]+)\)( ON DELETE CASCADE)?$/.exec(line))) {
      references.push({ name: m[1]!, columns: names(m[2]!), table: m[3]!, to: names(m[4]!), cascade: m[5] !== undefined })
    } else if ((m = /^ {2}CONSTRAINT `(\w+)` CHECK \((.+)\)$/.exec(line))) checks.push({ name: m[1]!, text: m[2]! })
    else unknown.push(raw)
  }
  return { name: head?.[1] ?? "(no CREATE TABLE line)", columns, primary, keys, references, checks, last: lines.at(-2) ?? "", unknown }
}

// Each table's file, read here so that a missing one fails a case (its text
// is then empty), not the load of this file.
const files = Object.fromEntries(
  TABLES.map((table) => {
    const file = path.join(SCHEMA_DIR, table + ".sql")
    return [table, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""]
  })
) as Record<Table, string>
const parsed = Object.fromEntries(TABLES.map((table) => [table, parse(files[table])])) as Record<Table, Parsed>

test("the directory holds .skeema and one file <name>.sql for each name of TABLES, and nothing else; skeema's tree holds only it and its .skeema; TABLES is SQLite's tables in their order", () => {
  expect(fs.readdirSync(SCHEMA_DIR).sort()).toEqual([".skeema", ...TABLES.map((table) => table + ".sql")].sort())
  // `schema/mariadb/` is skeema's tree: the server's `.skeema` and the
  // schema's directory. The seed is beside it (`schema/mariadb-admin/`).
  expect(fs.readdirSync(path.dirname(SCHEMA_DIR)).sort()).toEqual([".skeema", "everchat"])
  const sqlite = schema.flatMap((statement) => /^create table (\w+) \(/.exec(statement)?.[1] ?? [])
  expect<ReadonlyArray<string>>([...TABLES]).toEqual(sqlite)
  expect(TABLES.length).toBe(19)
})

test("each file is one CREATE TABLE of its own name, ends with ; and one newline, holds no comment and no second statement, and its names of references and checks have the schema's form", () => {
  for (const table of TABLES) {
    const text = files[table]
    const one = parsed[table]
    expect([table, one.name]).toEqual([table, table])
    expect([table, text.endsWith(");\n") || text.endsWith("ROW_FORMAT=DYNAMIC;\n"), text.indexOf(";") === text.length - 2]).toEqual([table, true, true])
    expect([table, text.match(/CREATE TABLE/g)?.length]).toEqual([table, 1])
    expect([table, /--|\/\*|#/.test(text)]).toEqual([table, false])
    expect([table, one.last]).toEqual([table, OPTIONS])
    expect([table, one.unknown]).toEqual([table, []])
    // Each reference `<table>_<column>_fk`, its column the last of its own;
    // each check `<table>_ck<n>`, n from 1 in order; none of the server's.
    expect([table, one.references.map((ref) => ref.name).sort()]).toEqual([table, one.references.map((ref) => `${table}_${ref.columns.at(-1)}_fk`).sort()])
    expect([table, one.checks.map((check) => check.name)]).toEqual([table, one.checks.map((_, i) => `${table}_ck${i + 1}`)])
    expect([table, /CONSTRAINT_\d|_ibfk_/.test(text)]).toEqual([table, false])
  }
})

test("each table's number of checks is the list's", () => {
  expect(Object.fromEntries(TABLES.map((table) => [table, parsed[table].checks.length]))).toEqual(CHECKS)
})

// The page's column tables (sections 4 to 7): each table's columns in
// order, each with its MariaDB type. A row of two or more columns gives each
// one its type, or, when the cell holds as many types as the row's columns,
// each its own (`steps, tokens`: `int, bigint`).
const pageColumns = (): Record<string, Array<{ readonly name: string; readonly type: string }>> => {
  const text = fs.readFileSync(PAGE, "utf8")
  const plain = (cell: string) =>
    cell.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").trim()
  const out: Record<string, Array<{ name: string; type: string }>> = {}
  for (const m of text.matchAll(/<h3><code>(everchat_\w+)<\/code><\/h3>([\s\S]*?)<\/table>/g)) {
    const rows: Array<{ name: string; type: string }> = []
    for (const row of m[2]!.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td>/g)) {
      const columns = plain(row[1]!).split(", ")
      const type = plain(row[3]!)
      const types = type.split(", ")
      columns.forEach((column, i) => rows.push({ name: column, type: columns.length > 1 && types.length === columns.length ? types[i]! : type }))
    }
    out[m[1]!] = rows
  }
  return out
}

// A file's column's default, in the server's form: a number, a quoted text
// or `NULL`. `defaultOf` gives it, as SQLite's `dflt_value` writes it, or
// null for none: the server's `DEFAULT NULL` of a column that may be null is
// no default. A `DEFAULT` of another form is given as such, and so fails the
// comparison with SQLite.
const DEFAULT = / DEFAULT (NULL|-?\d+|'(?:[^']|'')*')(?= |$)/
const defaultOf = (definition: string): string | null => {
  if (!definition.includes(" DEFAULT ")) return null
  const m = DEFAULT.exec(definition)
  if (m === null) return `(a DEFAULT of another form: ${definition})`
  return m[1] === "NULL" && !/ NOT NULL/.test(definition) ? null : m[1]!
}

// A file's column as the page writes its type: lowercase, no quotes, the
// width that the server adds to an integer gone, no `NOT NULL` and no
// default (the page's column tables give none: each default is compared
// with SQLite's, by `defaultOf`, in its own case); `GENERATED ALWAYS AS` is
// `as`; no space after a comma.
const typeOf = (definition: string) =>
  definition
    .replace(/ NOT NULL/, "")
    .replace(DEFAULT, "")
    .replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, "$1")
    .replace("GENERATED ALWAYS AS", "as")
    .replaceAll("`", "")
    .toLowerCase()
    .replace(/,\s+/g, ",")
const pageType = (type: string) => type.toLowerCase().replace(/,\s+/g, ",")

test("each table's columns are the page's, in order, each with the page's MariaDB type", () => {
  const page = pageColumns()
  for (const table of TABLES) {
    const want = (page[table] ?? []).map((column) => `${table}.${column.name}: ${pageType(column.type)}`)
    const have = parsed[table].columns.map((column) => `${table}.${column.name}: ${typeOf(column.definition)}`)
    expect(have).toEqual(want)
  }
  expect(Object.keys(page).sort()).toEqual([...TABLES].sort())
})

// A check's expression in a normal form, the same for a file's text and for
// SQLite's: the text is read as a tree, by its own dialect's precedence of
// the operators, and written again with each operation in one pair of
// parentheses. So the letters' case, the spaces, the backticks and the
// parentheses that the server takes out (or that SQLite's text has more) do
// not count; the operators, their operands and their order do. Words are
// lowercase; one space around an operator and a word, none after a comma or
// a parenthesis; `!=` and `==` are `<>` and `=` (the server writes `<>`). No
// two names of a function are the same today (none of the files has a
// function). A text that it cannot read throws, naming the text.
//
// The normal form holds the tree of a text, not the server's rewrites of
// it. The server shows `not a = b` as `` `a` <> `b` ``: such a check fails
// the checks' case with one meaning, and is then written in SQLite's schema
// in the form that the server shows, or named in `CHECKS_NOT_COMPARED` with
// its reason. The cases "the normal form keeps a text's meaning" compare its
// reading with each engine's own, on texts made at random and on fixed ones.
type Dialect = "mariadb" | "sqlite"
const WORDS = new Set(["and", "or", "not", "is", "in", "null"])
// The operators of a comparison, by level of precedence, the loosest first.
// MariaDB: the comparisons and `is`, then `in`. Its rule: the right side of
// a comparison is a predicate, which may be an `in`; the left side of an
// `in` holds no comparison and no `is` but in parentheses (`a = b in (0,1)`
// is `a = (b in (0,1))`, and `a is null in (0,1)` is refused). SQLite:
// `=`, `<>`, `is` and `in` at one level, and `<`, `<=`, `>`, `>=` tighter
// (`a = b in (0,1)` is `(a = b) in (0,1)`).
const LEVELS: Readonly<Record<Dialect, ReadonlyArray<ReadonlyArray<string>>>> = {
  mariadb: [["=", "==", "<>", "!=", "is", "<", "<=", ">", ">="], ["in"]],
  sqlite: [["=", "==", "<>", "!=", "is", "in"], ["<", "<=", ">", ">="]]
}
const normal = (text: string, dialect: Dialect): string => {
  // Each token: a word (of WORDS), a name, a number, a quoted text or a sign.
  const tokens: Array<{ readonly kind: "word" | "name" | "value" | "sign"; readonly text: string }> = []
  const lexer = /\s+|('(?:[^']|'')*')|`(\w+)`|([A-Za-z_]\w*)|(\d+)|(<>|!=|>=|<=|==|[=<>(),-])/y
  while (lexer.lastIndex < text.length) {
    const at = lexer.lastIndex
    const m = lexer.exec(text)
    if (m === null) throw new Error(`The normal form cannot read ${JSON.stringify(text)} at ${at}`)
    if (m[1] !== undefined || m[4] !== undefined) tokens.push({ kind: "value", text: m[1] ?? m[4]! })
    else if (m[2] !== undefined) tokens.push({ kind: "name", text: m[2].toLowerCase() })
    else if (m[3] !== undefined) tokens.push({ kind: WORDS.has(m[3].toLowerCase()) ? "word" : "name", text: m[3].toLowerCase() })
    else if (m[5] !== undefined) tokens.push({ kind: "sign", text: m[5] })
  }
  let i = 0
  const fail = (): never => {
    throw new Error(`The normal form cannot read ${JSON.stringify(text)} at its token ${i} (${tokens[i]?.text ?? "the end"})`)
  }
  const is = (kind: string, one: string) => tokens[i]?.kind === kind && tokens[i]?.text === one
  const take = (kind: string, one: string) => (is(kind, one) ? void i++ : fail())
  const or = (): string => {
    let left = and()
    while (is("word", "or")) (i++, left = `(${left} or ${and()})`)
    return left
  }
  const and = (): string => {
    let left = not()
    while (is("word", "and")) (i++, left = `(${left} and ${not()})`)
    return left
  }
  const not = (): string => (is("word", "not") ? (i++, `(not ${not()})`) : compare(0))
  const list = (): string => {
    take("sign", "(")
    const items = [or()]
    while (is("sign", ",")) (i++, items.push(or()))
    take("sign", ")")
    return `(${items.join(",")})`
  }
  const compare = (level: number): string => {
    const signs = LEVELS[dialect][level]
    if (signs === undefined) return operand()
    let left = compare(level + 1)
    for (;;) {
      const one = tokens[i]
      if (one === undefined || !signs.includes(one.text) || one.kind === "name" || one.kind === "value") return left
      i++
      if (one.text === "is") {
        const negated = is("word", "not") ? (i++, true) : false
        take("word", "null")
        left = `(${left} is ${negated ? "not " : ""}null)`
      } else if (one.text === "in") left = `(${left} in ${list()})`
      else left = `(${left} ${one.text === "==" ? "=" : one.text === "!=" ? "<>" : one.text} ${compare(level + 1)})`
    }
  }
  const operand = (): string => {
    const one = tokens[i]
    if (one === undefined) return fail()
    if (one.kind === "sign" && one.text === "(") {
      i++
      const inner = or()
      take("sign", ")")
      return inner
    }
    if (one.kind === "sign" && one.text === "-" && /^\d+$/.test(tokens[i + 1]?.text ?? "")) return (i += 2, `-${tokens[i - 1]!.text}`)
    if (one.kind === "value") return (i++, one.text)
    if (one.kind === "word" && one.text === "null") return (i++, "null")
    if (one.kind === "name") return (i++, is("sign", "(") ? `${one.text}${list()}` : one.text)
    return fail()
  }
  const out = or()
  if (i !== tokens.length) fail()
  return out
}

// Each `check (...)` of an SQLite `create table` text, in its order: the
// text in its parentheses. A quote opens or closes a quoted text (its `''`
// closes and opens one), in which no word and no parenthesis counts.
const checksOf = (statement: string): Array<string> => {
  const out: Array<string> = []
  let quoted = false
  for (let at = 0; at < statement.length; at++) {
    if (statement[at] === "'") quoted = !quoted
    const m = quoted ? null : /^check\s*\(/i.exec(statement.slice(at))
    if (m === null || /\w/.test(statement[at - 1] ?? "")) continue
    let depth = 0
    let end = at + m[0].length - 1
    for (; end < statement.length; end++) {
      if (statement[end] === "'") quoted = !quoted
      else if (!quoted && statement[end] === "(") depth++
      else if (!quoted && statement[end] === ")" && --depth === 0) break
    }
    out.push(statement.slice(at + m[0].length, end))
    at = end
  }
  return out
}

// SQLite's schema, made in memory, read by its pragmas, and its checks from
// each table's text.
const sqlite = () => {
  const db = new Database(":memory:")
  for (const statement of schema) db.run(statement)
  const out: Record<string, {
    columns: Array<string>
    primary: Array<string>
    references: Array<string>
    defaults: Array<string>
    keys: Array<string>
    unnamed: Array<string>
    checks: Array<string>
  }> = {}
  for (const table of TABLES) {
    const columns = db.query<{ name: string; notnull: number; pk: number; dflt_value: string | null }, []>(`pragma table_xinfo(${table})`).all()
    // Each index but the primary key's (compared as the primary key): its
    // name (SQLite's own key of a `unique` by `UNIQUE_NAMES`), whether it is
    // unique, its columns in order; a partial index says so, and no file has
    // one.
    const unnamed: Array<string> = []
    const keys = db.query<{ name: string; unique: number; origin: string; partial: number }, []>(`pragma index_list(${table})`).all()
      .filter((index) => index.origin !== "pk")
      .map((index) => {
        const on = db.query<{ seqno: number; name: string | null }, []>(`pragma index_info(${index.name})`).all()
          .sort((a, b) => a.seqno - b.seqno)
          .map((column) => column.name ?? "(an expression)")
          .join(", ")
        let name = index.name
        if (index.origin === "u") {
          unnamed.push(`${table} (${on})`)
          name = UNIQUE_NAMES[`${table} (${on})`] ?? `(SQLite's own ${index.name}, not in UNIQUE_NAMES)`
        }
        return `${index.unique ? "unique key" : "key"} ${name} (${on})${index.partial ? " where (a partial index)" : ""}`
      })
      .sort()
    const text = db.query<{ sql: string }, []>(`select sql from sqlite_schema where type = 'table' and name = '${table}'`).get()!.sql
    const references = db.query<{ id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string }, []>(`pragma foreign_key_list(${table})`).all()
    const grouped = new Map<number, typeof references>()
    for (const one of references) grouped.set(one.id, [...(grouped.get(one.id) ?? []), one])
    out[table] = {
      columns: columns.map((column) => `${column.name}${column.notnull ? " not null" : ""}`),
      primary: columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
      references: [...grouped.values()].map((parts) => {
        const sorted = parts.sort((a, b) => a.seq - b.seq)
        // A file's reference has no rule or `ON DELETE CASCADE` (another
        // line is in `unknown`): SQLite's other rules are written out, so
        // that they differ.
        const { on_delete, on_update } = sorted[0]!
        const rule = (on_delete === "CASCADE" ? " cascade" : on_delete === "NO ACTION" ? "" : ` on delete ${on_delete}`) + (on_update === "NO ACTION" ? "" : ` on update ${on_update}`)
        return `(${sorted.map((one) => one.from).join(", ")}) -> ${sorted[0]!.table} (${sorted.map((one) => one.to).join(", ")})${rule}`
      }).sort(),
      defaults: columns.map((column) => `${table}.${column.name}: ${column.dflt_value ?? "none"}`),
      keys,
      unnamed,
      checks: checksOf(text).map((check) => normal(check, "sqlite"))
    }
  }
  db.close()
  return out
}

test("each table's columns with not null, its primary key and its references are SQLite's, but for the differences named", () => {
  const lite = sqlite()
  for (const table of TABLES) {
    const one = parsed[table]
    const columns = one.columns.map((column) => {
      const notNull = / NOT NULL/.test(column.definition) && !NOT_NULL_IN_FILE_ONLY.includes(`${table}.${column.name}`)
      return `${column.name}${notNull ? " not null" : ""}`
    })
    expect([table, columns]).toEqual([table, lite[table]!.columns])
    expect([table, one.primary]).toEqual([table, lite[table]!.primary])
    const references = one.references.map((ref) => `(${ref.columns.join(", ")}) -> ${ref.table} (${ref.to.join(", ")})${ref.cascade ? " cascade" : ""}`).sort()
    expect([table, references]).toEqual([table, lite[table]!.references])
  }
  // Each named difference is one: the file says NOT NULL, SQLite does not.
  for (const name of NOT_NULL_IN_FILE_ONLY) {
    const [table, column] = name.split(".") as [Table, string]
    expect([name, / NOT NULL/.test(parsed[table].columns.find((one) => one.name === column)!.definition), lite[table]!.columns.includes(column)]).toEqual([name, true, true])
  }
})

test("each column's default is SQLite's (pragma table_xinfo); the server's DEFAULT NULL of a column that may be null is none", () => {
  const lite = sqlite()
  for (const table of TABLES) {
    const defaults = parsed[table].columns.map((column) => `${table}.${column.name}: ${defaultOf(column.definition) ?? "none"}`)
    expect(defaults).toEqual(lite[table]!.defaults)
  }
})

test("each table's unique keys and plain indexes are SQLite's, by name and columns in order, but for the differences named: the server's index of a reference, the names of SQLite's own keys", () => {
  const lite = sqlite()
  for (const table of TABLES) {
    const one = parsed[table]
    const keys = one.keys
      .filter((key) => !isReferenceIndex(table, key))
      .map((key) => `${key.unique ? "unique key" : "key"} ${key.name} (${key.columns.join(", ")})`)
      .sort()
    expect([table, keys]).toEqual([table, lite[table]!.keys])
    // The server's indexes of references: one for each reference whose
    // columns no other key starts with, and no other.
    const starts = (columns: ReadonlyArray<string>, key: ReadonlyArray<string>) => columns.every((column, i) => key[i] === column)
    const others = [one.primary, ...one.keys.filter((key) => !isReferenceIndex(table, key)).map((key) => key.columns)]
    const needed = one.references.filter((ref) => !others.some((key) => starts(ref.columns, key))).map((ref) => ref.name).sort()
    expect([table, one.keys.filter((key) => isReferenceIndex(table, key)).map((key) => key.name).sort()]).toEqual([table, needed])
  }
  // Each name of UNIQUE_NAMES is of one key of SQLite's own making.
  expect(TABLES.flatMap((table) => lite[table]!.unnamed).sort()).toEqual(Object.keys(UNIQUE_NAMES).sort())
})

test("each table's checks are SQLite's, in its order (section 8's, which the names <table>_ck<n> follow), each in the normal form, but for the differences named", () => {
  const lite = sqlite()
  const named: Array<string> = []
  for (const table of TABLES) {
    const want = lite[table]!.checks
      .filter((check) => {
        const none = NO_FILE_CHECK.includes(`${table}: ${check}`)
        if (none) named.push(`${table}: ${check}`)
        return !none
      })
      .map((check, i) => `${table}_ck${i + 1}: ${check}`)
      .filter((check) => !(check.split(":")[0]! in CHECKS_NOT_COMPARED))
    const have = parsed[table].checks
      .filter((check) => !(check.name in CHECKS_NOT_COMPARED))
      .map((check) => `${check.name}: ${normal(check.text, "mariadb")}`)
    expect(have).toEqual(want)
  }
  // Each named difference is one: an SQLite check that is there.
  expect(named.sort()).toEqual([...NO_FILE_CHECK].sort())
})

test("the normal form of a check: the server's text and SQLite's give one text when they are one tree, and two when they are not", () => {
  const both = (file: string, lite: string) => [normal(file, "mariadb"), normal(lite, "sqlite")]
  // The parentheses that the server takes out, the backticks, the case, the spaces.
  expect(both("`status` = 'pending' = (`answered` is null)", "(status = 'pending') = (answered is null)")).toEqual([
    "((status = 'pending') = (answered is null))",
    "((status = 'pending') = (answered is null))"
  ])
  expect(both("`stop_call` is null or `why` is not null and `why` = 'unwake'", "stop_call IS NULL or (why is not null and why = 'unwake')")).toEqual([
    "((stop_call is null) or ((why is not null) and (why = 'unwake')))",
    "((stop_call is null) or ((why is not null) and (why = 'unwake')))"
  ])
  expect(both("`status` in ('done','failed','cut') = (`ended` is not null)", "(status in ('done', 'failed', 'cut')) = (ended is not null)")).toEqual([
    "((status in ('done','failed','cut')) = (ended is not null))",
    "((status in ('done','failed','cut')) = (ended is not null))"
  ])
  // Another tree, another operator, another value: another text.
  const [a, b] = both("`stop_call` is null or `why` is not null and `why` = 'unwake'", "(stop_call is null or why is not null) and why = 'unwake'")
  expect(a).not.toBe(b!)
  expect(normal("`steps` > 0", "mariadb")).not.toBe(normal("steps >= 0", "sqlite"))
  expect(normal("`x` in (0,1)", "mariadb")).not.toBe(normal("x in (0, 2)", "sqlite"))
  expect(normal("`s` = 'A'", "mariadb")).not.toBe(normal("s = 'a'", "sqlite"))
  // Each dialect's own precedence: SQLite binds < tighter than =.
  expect(normal("a = b < c", "sqlite")).toBe("(a = (b < c))")
  expect(normal("`a` = `b` < `c`", "mariadb")).toBe("((a = b) < c)")
  // A text that it cannot read throws.
  expect(() => normal("`a` like 'b%'", "mariadb")).toThrow("The normal form cannot read")
  expect(() => normal("a + 1 > 0", "sqlite")).toThrow("The normal form cannot read")
  // MariaDB binds `in` tighter than a comparison; SQLite does not.
  for (const sign of ["=", "<>"]) {
    expect(normal(`\`a\` ${sign} \`b\` in (0,1)`, "mariadb")).toBe(`(a ${sign} (b in (0,1)))`)
    expect(normal(`a ${sign} b in (0,1)`, "sqlite")).toBe(`((a ${sign} b) in (0,1))`)
    expect(normal(`a ${sign} b in (0,1)`, "sqlite")).not.toBe(normal(`\`a\` ${sign} \`b\` in (0,1)`, "mariadb"))
    expect(normal(`a ${sign} (b in (0,1))`, "sqlite")).toBe(normal(`\`a\` ${sign} \`b\` in (0,1)`, "mariadb"))
  }
  expect(() => normal("`a` is not null in (0,1)", "mariadb")).toThrow("The normal form cannot read")
})

// The normal form against the engines. Two readers of one text: an engine
// and the normal form. For a text T of `d`'s dialect that the engine
// accepts and `normal` reads: (1) the engine gives the same values for T and
// for `normal(T, d)` on each row of `GRID`; (2) MariaDB and SQLite give the
// same values for `normal(T, d)`. A null is a value: null is null, and not
// 0. A text that the engine accepts and `normal` cannot read is allowed (the
// checks' case then fails), and one that the engine refuses claims nothing:
// both are counted, and each seed must give at least `ENOUGH` texts read.

// The rows: `a`, `b` and `c` each null, 0, 1 or 2, in the order of `k`.
const GRID_VALUES = [null, 0, 1, 2]
const GRID = GRID_VALUES.flatMap((a) => GRID_VALUES.flatMap((b) => GRID_VALUES.map((c) => ({ a, b, c })))).map((row, k) => ({ k, ...row }))
const GRID_TABLE = "create table grid (k int not null primary key, a int, b int, c int)"
const GRID_INSERT = "insert into grid (k, a, b, c) values " +
  GRID.map((row) => `(${[row.k, row.a, row.b, row.c].map((v) => (v === null ? "null" : String(v))).join(", ")})`).join(", ")
// The statement of a text's values, one for each row, in the order of `k`.
const gridSelect = (text: string) => `select ${text} as v from grid order by k`
const gridValue = (v: unknown) => (v === null ? null : String(v))

// The seeds of the random texts, the number of texts of each seed and
// dialect, and how many of them each engine must accept and `normal` read.
const SEEDS = [20261118, 7340033]
const COUNT = 300
const ENOUGH = 200

// A small generator of numbers from a seed (mulberry32): `next(n)` gives an
// integer from 0 to n - 1.
const seeded = (seed: number) => {
  let state = seed >>> 0
  return (n: number): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
}

// `COUNT` texts of `dialect` from `seed`: each a random tree of depth 1 to
// 4 of the names `a`, `b`, `c` (in MariaDB's, in backticks at random), the
// values 0, 1, 2, -1 and null, the comparisons, `is null`, `is not null`,
// `in` with a list of one to three names or values, `not`, `and` and `or`,
// written with a pair of parentheses around a part only at random (about
// one part in four), so that most texts leave the reading to the
// precedence. No quoted text and no function.
const randomTexts = (seed: number, dialect: Dialect): Array<string> => {
  const next = seeded(seed)
  const signs = dialect === "sqlite" ? ["=", "<>", "<", "<=", ">", ">=", "==", "!="] : ["=", "<>", "<", "<=", ">", ">="]
  const name = () => {
    const one = ["a", "b", "c"][next(3)]!
    return dialect === "mariadb" && next(2) === 0 ? `\`${one}\`` : one
  }
  const leaf = () => (next(2) === 0 ? name() : ["0", "1", "2", "-1", "null"][next(5)]!)
  const part = (depth: number): string => {
    const text = tree(depth)
    return next(4) === 0 ? `(${text})` : text
  }
  // A tree of exactly `depth`: one side of an operation of two is one level
  // less deep, the other at most that.
  const tree = (depth: number): string => {
    if (depth === 0) return leaf()
    const deep = next(2) === 0
    const left = () => part(deep ? depth - 1 : next(depth))
    const right = () => part(deep ? next(depth) : depth - 1)
    switch (next(8)) {
      case 0:
      case 1:
        return `${left()} ${signs[next(signs.length)]} ${right()}`
      case 2:
        return `${part(depth - 1)} is ${next(2) === 0 ? "" : "not "}null`
      case 3:
        return `${part(depth - 1)} in (${Array.from({ length: 1 + next(3) }, leaf).join(", ")})`
      case 4:
        return `not ${part(depth - 1)}`
      case 5:
      case 6:
        return `${left()} and ${right()}`
      default:
        return `${left()} or ${right()}`
    }
  }
  return Array.from({ length: COUNT }, () => tree(1 + next(4)))
}

// The fixed texts, the same in both dialects. (a) Each ordered pair of two
// operators on `a`, `b` and `c`, with no parentheses, each in its shape:
// `not` before its operand, `is null`, `is not null` and `in (0,1)` after
// it, the others between two (`a = b in (0,1)`, `a in (0,1) = b`,
// `not a = b`, `a < b = c`). (b) The texts of the review that found that
// MariaDB binds `in` tighter than a comparison, which this file had read at
// one level with it.
const OPERATORS = ["=", "<>", "<", "<=", ">", ">=", "is null", "is not null", "in (0,1)", "not", "and", "or"]
const pairText = (first: string, second: string) => {
  const names = ["a", "b", "c"]
  let n = 0
  const apply = (text: string | undefined, op: string) => {
    if (op === "not") return `not ${text ?? names[n++]!}`
    const left = text ?? names[n++]!
    return op.startsWith("is ") || op.startsWith("in ") ? `${left} ${op}` : `${left} ${op} ${names[n++]!}`
  }
  return apply(apply(undefined, first), second)
}
const REVIEWED = [
  "a = b in (0,1)",
  "(a = b) in (0,1)",
  "a = (b in (0,1))",
  "a <> b in (0,1)",
  "a in (0,1) = b",
  "a = b is null",
  "a = (b is null)",
  "a is null = b",
  "a = b < c",
  "a = (b < c)",
  "not a = b",
  "a < b in (0,1)"
]
const FIXED = [...new Set([...OPERATORS.flatMap((first) => OPERATORS.map((second) => pairText(first, second))), ...REVIEWED])]
// The texts that each engine must accept and `normal` read: the finding's.
const MUST_COMPARE = ["a = b in (0,1)", "a <> b in (0,1)", "a < b in (0,1)", "a = (b in (0,1))"]

// Two lists of values are the same: null only where null, each other value
// as a text.
const same = (a: ReadonlyArray<string | null>, b: ReadonlyArray<string | null> | undefined) =>
  b !== undefined && a.length === b.length && a.every((v, i) => v === b[i])

// One engine's reading of the texts of one dialect, by relation 1: `values`
// gives a text's values, or undefined when the engine refuses it. Gives
// each text compared with its normal form and the engine's values of that
// form (for relation 2), the counts, and each fault of relation 1 (with the
// seed or "fixed", and the text).
interface Reading {
  readonly compared: Map<string, { readonly normal: string; readonly values: ReadonlyArray<string | null> }>
  readonly counts: Record<string, { compared: number; thrown: number; refused: number }>
  readonly faults: Array<string>
}
const readAll = async (
  dialect: Dialect,
  values: (text: string) => Promise<ReadonlyArray<string | null> | undefined>
): Promise<Reading> => {
  const reading: Reading = { compared: new Map(), counts: {}, faults: [] }
  const sets: Array<[string, ReadonlyArray<string>]> = [["fixed", FIXED], ...SEEDS.map((seed): [string, ReadonlyArray<string>] => [String(seed), randomTexts(seed, dialect)])]
  for (const [from, texts] of sets) {
    const count = (reading.counts[from] = { compared: 0, thrown: 0, refused: 0 })
    for (const text of texts) {
      const engine = await values(text)
      if (engine === undefined) {
        count.refused++
        continue
      }
      let form: string
      try {
        form = normal(text, dialect)
      } catch {
        count.thrown++
        continue
      }
      count.compared++
      const again = await values(form)
      if (!same(engine, again)) {
        reading.faults.push(`${dialect} ${from}: ${JSON.stringify(text)} gives ${JSON.stringify(engine)}, its normal form ${JSON.stringify(form)} ${again === undefined ? "is refused" : "gives " + JSON.stringify(again)}`)
      }
      if (again !== undefined) reading.compared.set(text, { normal: form, values: again })
    }
  }
  return reading
}

// The checks of `readAll`'s counts: each seed's texts compared, and the
// texts that must be.
const expectEnough = (reading: Reading, dialect: Dialect) => {
  for (const seed of SEEDS) expect([dialect, seed, reading.counts[String(seed)]!.compared >= ENOUGH]).toEqual([dialect, seed, true])
  expect([dialect, MUST_COMPARE.filter((text) => !reading.compared.has(text))]).toEqual([dialect, []])
}

// SQLite in memory with the rows of `GRID`, and its values of a text.
const liteGrid = () => {
  const db = new Database(":memory:")
  db.run(GRID_TABLE)
  db.run(GRID_INSERT)
  const values = (text: string): ReadonlyArray<string | null> | undefined => {
    try {
      return db.prepare<{ v: unknown }, []>(gridSelect(text)).all().map((row) => gridValue(row.v))
    } catch {
      return undefined
    }
  }
  return { db, values }
}

test("the normal form keeps a text's meaning in SQLite: on each row, a text of SQLite's that it reads gives the values of its normal form (the fixed texts and each seed's)", async () => {
  const lite = liteGrid()
  try {
    const reading = await readAll("sqlite", async (text) => lite.values(text))
    console.log(`the normal form against SQLite: ${JSON.stringify(reading.counts)}`)
    expect(reading.faults).toEqual([])
    expectEnough(reading, "sqlite")
  } finally {
    lite.db.close()
  }
})

test("the seed names each id and name of KINDS, once", () => {
  const rows = [...seed().matchAll(/(?:select|union all select) (\d+)(?: as id)?, '(\w+)'/g)].map((m) => [Number(m[1]), m[2]])
  expect(rows).toEqual(Object.entries(KINDS).map(([name, id]) => [id, name]))
})

// The cases on a server, in the form of `./client.test.ts`: the variable not
// there (they skip), there with no path in it (a case fails: nothing skips
// in silence), or the paths that it names (they run).
const GIVEN = process.env[VARIABLE]
const PATHS = serverPaths(process.env)

// The hang limit of a case that starts a server: a start makes a data
// directory. No measure of speed.
const SLOW = 4 * WAIT_MAX

const versionOf = (server: string) => /-mariadb-server-([0-9.]+)$/.exec(server)?.[1] ?? "(no version in the path)"

// A server of `server`, started under a new directory of the case's
// temporary root, for `body`; stopped in a `finally`.
const onServer = async (server: string, body: (one: Server) => Promise<void>) => {
  const one = await start(server, fs.mkdtempSync(path.join(os.tmpdir(), "db-")))
  try {
    await body(one)
  } finally {
    await one.stop()
  }
}

// What the client prints of `sql` in the schema `name`, as rows of fields.
const rows = async (one: Server, name: string, sql: string) =>
  (await one.query(`use \`${name}\`; ${sql}`)).split("\n").filter((line) => line !== "").map((line) => line.split("\t"))

if (GIVEN === undefined) {
  const why = `the cases on a server: skipped, ${VARIABLE} is not set (just test-mariadb sets it)`
  // `bun test` prints no skipped case's name: the output says it too.
  console.log("packages/mariadb/src/tables.test.ts: " + why)
  test.skip(why, () => {})
} else if (PATHS.length === 0) {
  test(`the cases on a server: ${VARIABLE} is set and names no server`, () => {
    throw new Error(`${VARIABLE} is set and names no server (${JSON.stringify(GIVEN)}): give the servers' paths, separated by spaces, or leave it unset to skip the cases on a server`)
  })
}

for (const server of PATHS) {
  describe(`the schema's files on MariaDB ${versionOf(server)} (${server})`, () => {
    test("make gives a schema of exactly the 19 tables and no view, and show create table of each is its file less ; and the newline", async () => {
      await onServer(server, async (one) => {
        await make(one, "acme_dev")
        expect(await rows(one, "acme_dev", "select table_name, table_type from information_schema.tables where table_schema = 'acme_dev' order by table_name")).toEqual(
          [...TABLES].sort().map((table) => [table, "BASE TABLE"])
        )
        const shown = await Effect.runPromise(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const out: Record<string, string> = {}
            for (const table of TABLES) {
              const got = yield* sql.unsafe<Record<string, string>>("show create table `" + table + "`")
              out[table] = got[0]!["Create Table"]!
            }
            return out
          }).pipe(Effect.provide(client({ socket: one.socket, user: "root", schema: "acme_dev" })))
        )
        // The helper's texts, which `make` ran: each file less its ";\n".
        const given = texts()
        expect(shown).toEqual(Object.fromEntries(TABLES.map((table) => [table, given[table].slice(0, -2)])))
      })
    }, SLOW)

    test("the seed gives the rows of KINDS; run again it gives no error and the same rows; it changes no row that is there", async () => {
      await onServer(server, async (one) => {
        await make(one, "acme_qa")
        const kinds = Object.entries(KINDS).map(([name, id]) => [String(id), name])
        const kindRows = () => rows(one, "acme_qa", "select id, name from everchat_kind order by id")
        expect(await kindRows()).toEqual(kinds)
        await one.query(`use acme_qa; ${seed()}`)
        expect(await kindRows()).toEqual(kinds)
        await one.query("use acme_qa; update everchat_kind set name = 'tool_old' where id = 3")
        await one.query(`use acme_qa; ${seed()}`)
        expect(await kindRows()).toEqual(kinds.map(([id, name]) => [id!, id === "3" ? "tool_old" : name!]))
      })
    }, SLOW)

    test("the references are real: a delete of a tenant with a chat, a launch and a message leaves no row of the three, and keeps the shared lists", async () => {
      await onServer(server, async (one) => {
        await make(one, "acme_dev")
        await one.query(
          [
            "use acme_dev",
            "insert into everchat_tenant (id, created) values (unhex('00112233445566778899aabbccddeeff'), 1)",
            "insert into everchat_pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 1)",
            "insert into everchat_chat (tenant, uuid, pick, created, updated) values (unhex('00112233445566778899aabbccddeeff'), unhex('ffeeddccbbaa99887766554433221100'), 1, 1, 1)",
            "insert into everchat_launch (chat, n, pid, host, cwd, version, run_tag, created) values (1, 1, 1, 'a host', '/', '0.1.0', 'a run', 1)",
            "insert into everchat_msg (chat, i, kind, text, size, launch, created) values (1, 0, 1, 'a message', 9, 1, 1)"
          ].join("; ")
        )
        const counts = () =>
          rows(one, "acme_dev", "select (select count(*) from everchat_chat), (select count(*) from everchat_launch), (select count(*) from everchat_msg), (select count(*) from everchat_pick), (select count(*) from everchat_kind)")
        expect(await counts()).toEqual([["1", "1", "1", "1", "8"]])
        await one.query("use acme_dev; delete from everchat_tenant")
        expect(await counts()).toEqual([["0", "0", "0", "1", "8"]])
      })
    }, SLOW)

    test("the normal form keeps a text's meaning in MariaDB: on each row, a text of MariaDB's that it reads gives the values of its normal form; and the normal form of each text read, of either dialect, gives the same values in MariaDB and in SQLite", async () => {
      await onServer(server, async (one) => {
        await one.query(`create database acme_dev; use acme_dev; ${GRID_TABLE}; ${GRID_INSERT}`)
        const lite = liteGrid()
        try {
          await Effect.runPromise(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              // One statement for each text: a refused one fails its own.
              const maria = (text: string) =>
                Effect.runPromise(
                  sql.unsafe<{ v: unknown }>(gridSelect(text)).pipe(
                    Effect.match({ onFailure: () => undefined, onSuccess: (got) => got.map((row) => gridValue(row.v)) })
                  )
                )
              const mariaReading = yield* Effect.promise(() => readAll("mariadb", maria))
              const liteReading = yield* Effect.promise(() => readAll("sqlite", async (text) => lite.values(text)))
              console.log(`the normal form against MariaDB ${versionOf(server)}: ${JSON.stringify(mariaReading.counts)}`)
              expect(mariaReading.faults).toEqual([])
              expectEnough(mariaReading, "mariadb")
              // Relation 2: each normal form read, in the other engine.
              const faults: Array<string> = []
              for (const [reading, dialect, other] of [[mariaReading, "mariadb", lite.values], [liteReading, "sqlite", maria]] as const) {
                for (const [text, { normal: form, values }] of reading.compared) {
                  const there = yield* Effect.promise(async () => other(form))
                  if (!same(values, there)) {
                    faults.push(`${dialect}: ${JSON.stringify(text)}, normal form ${JSON.stringify(form)}: ${dialect} gives ${JSON.stringify(values)}, the other ${there === undefined ? "refuses it" : "gives " + JSON.stringify(there)}`)
                  }
                }
              }
              expect(faults).toEqual([])
            }).pipe(Effect.provide(client({ socket: one.socket, user: "root", schema: "acme_dev" })))
          )
        } finally {
          lite.db.close()
        }
      })
    }, SLOW)

    // Not a wanted behaviour: what the store's edge must hold (see `CHECKS`).
    test("MariaDB pads a short id, which the store's edge must hold: in strict mode, a tenant's id and a chat's uuid of 1 and of 2 bytes are each stored as 16 bytes with zero bytes after, a select by the 2 bytes finds no row, and 17 bytes are refused", async () => {
      await onServer(server, async (one) => {
        await make(one, "acme_dev")
        expect((await rows(one, "acme_dev", "select @@session.sql_mode"))[0]![0]!.split(",")).toContain("STRICT_TRANS_TABLES")
        const tenant = "00112233445566778899aabbccddeeff"
        const seventeen = tenant + "00"
        await one.query(
          [
            "use acme_dev",
            "insert into everchat_tenant (id, created) values (x'01', 1), (x'0102', 1), (x'" + tenant + "', 1)",
            "insert into everchat_pick (vendor, model, effort, speed, created) values ('v', 'm', 'e', 's', 1)",
            "insert into everchat_chat (tenant, uuid, pick, created, updated) values (x'" + tenant + "', x'01', 1, 1, 1), (x'" + tenant + "', x'0102', 1, 1, 1)"
          ].join("; ")
        )
        const padded = ["01" + "00".repeat(15), "16"]
        const padded2 = ["0102" + "00".repeat(14), "16"]
        expect(await rows(one, "acme_dev", `select hex(id), length(id) from everchat_tenant where id <> x'${tenant}' order by id`)).toEqual([padded, padded2])
        expect(await rows(one, "acme_dev", "select hex(uuid), length(uuid) from everchat_chat order by uuid")).toEqual([padded, padded2])
        expect(await rows(one, "acme_dev", "select (select count(*) from everchat_tenant where id = x'0102'), (select count(*) from everchat_chat where uuid = x'0102')")).toEqual([["0", "0"]])
        await expect(one.query(`use acme_dev; insert into everchat_tenant (id, created) values (x'${seventeen}', 1)`)).rejects.toThrow("Data too long for column 'id'")
        await expect(one.query(`use acme_dev; insert into everchat_chat (tenant, uuid, pick, created, updated) values (x'${tenant}', x'${seventeen}', 1, 1, 1)`)).rejects.toThrow(
          "Data too long for column 'uuid'"
        )
        expect(await rows(one, "acme_dev", "select (select count(*) from everchat_tenant), (select count(*) from everchat_chat)")).toEqual([["3", "2"]])
      })
    }, SLOW)
  })
}
