// The start's check
// =================
// The server build never changes the schema of the store on MariaDB
// (`docs/schema.html`, section 1): an administrator applies the files of
// `schema/mariadb/`. This check keeps a build from work on a schema that is
// not its own. `check(texts)` reads the schema that the client's connection
// uses, compares it with each table's file, and fails with one error,
// `WrongSchema`, that holds each difference (lead, ec-o4wom5, N1 to N9).
//
// - The texts: the text of each table's file by the table's name, given by
//   the caller (R24): this module reads no file and imports none.
// - What it reads, and only reads (N2): first the kinds of the schema's
//   objects (`show full tables`, whose names it keeps when they start with
//   `everchat_`: the prefix is compared here, since `_` is a wildcard of
//   `like`), then `show create table` of each name of `TABLES` that is not
//   there as something other than a table, then the rows of
//   `everchat_kind`. It reads nothing of `information_schema`, whose answer
//   depends on the version and the grant (ec-k5dq, finding 3), and writes
//   nothing: a user with `SELECT` alone on the tables gets the same answer.
// - A name of `TABLES` that is not a table (lead, ec-7qkego, Q1 to Q3, Q9):
//   a view, a sequence or another kind there is one difference, `NotATable`,
//   with a word of the code's list for what it is, and no text of it is
//   read into the error: a view's text names its definer, a user and a host.
//   The kinds come first, and no `show create table` is sent for such a
//   name; and `compare` takes as no table's text one whose first line is not
//   that name's `CREATE TABLE` line, or whose options mark a sequence.
// - The session (N3): the server's text depends on it (`sql_mode`,
//   `sql_quote_show_create`). The check runs each statement on one
//   connection, reads the two values first, sets them to `SESSION`'s, and
//   sets them back to what they were at its end: on a failure and on an
//   interruption too.
// - The comparison (N4, `compare`): the file's text less its last `;` and
//   newline, against the server's less ` AUTO_INCREMENT=<n>` (the server
//   adds it once a table has rows). Equal: no difference. Else each text is
//   cut into lines, each line keyed by its first word (`keyOf`), and the
//   keys compared: a line of the file that the server lacks, a line of the
//   server that the file lacks, a line of both with another text, and a
//   line at another place (the order of the columns and of the keys is the
//   schema's). No parser of SQL.
// - More than the files (N5): a table or a view of the prefix that is not in
//   `TABLES`. A table of another name is not the store's and is not read (a
//   hosted deployment may share the schema).
// - The rows of `everchat_kind` (N6, Q7): `KINDS` of the core, read whenever
//   the table is there as a table and the server's text of it has a column
//   `id` and a column `name`, also when that text is not the file's: then
//   the lines' differences and the rows' are both in the error. With one of
//   the two columns not there, the rows are not read, and the lines say why.
//   The rows are a list, compared as texts (`compareRows`, lead, ec-7qkego,
//   T1 to T5): no value of the server is made a number, no row is lost, an
//   id's and a name's text in a difference is cut at 64 characters, and at
//   most 257 rows are read (a `tinyint` has 256 values): with 257, one
//   difference says so and no row is compared.
// - The caller's texts (N7): a name of `TABLES` with no text, and a text of
//   a name that is not in `TABLES`.
// - All at once (N8): every difference, in the order of `TABLES`, then N5's,
//   then N6's, then N7's. The error holds lines of the files and of the
//   server's texts of those tables, names, and a kind's id and name: no other
//   text of a row, no value of the session, no user or host.
//
// A failure of a statement, but a table that is missing or not granted
// (errors 1146 and 1142), is the driver's `SqlError`, passed on.
//
// What it does not see: a table on which the user has no right shows as
// missing (one word for both); a table of another prefix, or of the prefix
// in another case of letters, is not read; a trigger shows in neither
// statement; a table's `AUTO_INCREMENT=` is taken out, since rows move it.

import { KINDS } from "@everchat/core/store"
import { Effect, Schema } from "effect"
import { SqlClient, type SqlConnection, type SqlError } from "effect/sql"
import { TABLES } from "./tables.ts"

// The prefix of the store's tables.
export const PREFIX = "everchat_"

// The session under which the server prints the files' form: backticks
// (`sql_quote_show_create = 1`) and a mode that changes no text of
// `show create table` (no `ANSI_QUOTES`, no `NO_KEY_OPTIONS`, ...).
export const SESSION = "set session sql_mode = 'STRICT_ALL_TABLES', sql_quote_show_create = 1"

// What a line of a table's text is, by its first word.
export const LineKind = Schema.Literals(["head", "column", "primary key", "key", "reference", "check", "options", "other line", "text"])
export type LineKind = typeof LineKind.Type

// A line of a table: the file's that the server lacks (`lacks`), the
// server's that the file lacks (`more`), one of both with another text
// (`other`), or one of both at another place (`moved`). `at` is the line's
// number in the file, where the file has it; `file` and `server` are the
// two texts of the line, less its indent and a last comma, where each has
// it. The line `text` is the whole text, when the two differ and no line
// does (an indent, a comma).
export const LineDifference = Schema.TaggedStruct("Line", {
  table: Schema.String,
  change: Schema.Literals(["lacks", "more", "other", "moved"]),
  line: LineKind,
  name: Schema.String,
  at: Schema.NullOr(Schema.Int),
  file: Schema.NullOr(Schema.String),
  server: Schema.NullOr(Schema.String)
})
export type LineDifference = typeof LineDifference.Type

// A table of `TABLES` that is missing, or on which the user has no right.
export const Missing = Schema.TaggedStruct("Missing", { table: Schema.String })
// A table or a view of the prefix that is not in `TABLES`.
export const Unlisted = Schema.TaggedStruct("Unlisted", { table: Schema.String, view: Schema.Boolean })
// A row of `everchat_kind` by its id: the code's name and the server's, or
// null where one has no row. The id and the server's name are texts in the
// form of `textOf`, each cut at `ROW_TEXT_MAX` (`cutText`).
export const KindRow = Schema.TaggedStruct("KindRow", { id: Schema.String, code: Schema.NullOr(Schema.String), server: Schema.NullOr(Schema.String) })
export type KindRow = typeof KindRow.Type
// `everchat_kind` holds `ROWS_MAX` rows or more, more than a kind's id can
// number: its rows are not compared. No text of a row.
export const TooManyRows = Schema.TaggedStruct("TooManyRows", { table: Schema.String })
export type TooManyRows = typeof TooManyRows.Type
// A name of `TABLES` that the schema holds as something other than a
// table: what stands there, as a word of the code's list. No text of the
// server: a view's names its definer.
export const NotATable = Schema.TaggedStruct("NotATable", { table: Schema.String, what: Schema.Literals(["view", "sequence", "other"]) })
export type NotATable = typeof NotATable.Type
// A name of `TABLES` for which the caller gave no text.
export const NoText = Schema.TaggedStruct("NoText", { table: Schema.String })
// A text that the caller gave for a name that is not in `TABLES`.
export const NoTable = Schema.TaggedStruct("NoTable", { table: Schema.String })

export const Difference = Schema.Union([LineDifference, Missing, NotATable, Unlisted, KindRow, TooManyRows, NoText, NoTable])
export type Difference = typeof Difference.Type

// One line of the message for a difference. Each text from the server or
// the caller is quoted, so that a line holds one difference.
export const describe = (difference: Difference): string => {
  const q = (text: string | null) => (text === null ? "none" : JSON.stringify(text))
  switch (difference._tag) {
    case "Missing":
      return `${difference.table}: missing, or the user has no right on it`
    case "NotATable":
      return `${difference.table}: not a table: ${difference.what === "other" ? "something else" : `a ${difference.what}`} stands at its name`
    case "Unlisted":
      return `${q(difference.table)}: a ${difference.view ? "view" : "table"} of the prefix ${PREFIX} that is not in the list of tables`
    case "KindRow":
      return `everchat_kind, the row ${q(difference.id)}: the code has ${q(difference.code)}, the server has ${q(difference.server)}`
    case "TooManyRows":
      return `${difference.table}: ${ROWS_MAX} rows or more, more than a kind's id can number: its rows are not compared`
    case "NoText":
      return `${difference.table}: the caller gave no text of its file`
    case "NoTable":
      return `${q(difference.table)}: the caller gave a text, and the list of tables has no such table`
    case "Line": {
      const what = difference.name === "" ? difference.line : `${difference.line} ${q(difference.name)}`
      const at = difference.at === null ? "" : `, line ${difference.at} of the file`
      switch (difference.change) {
        case "lacks":
          return `${difference.table}: ${what}${at}: the server lacks it: the file has ${q(difference.file)}`
        case "more":
          return `${difference.table}: ${what}: the file lacks it: the server has ${q(difference.server)}`
        case "other":
          return `${difference.table}: ${what}${at}: the file has ${q(difference.file)}, the server has ${q(difference.server)}`
        case "moved":
          return `${difference.table}: ${what}${at}: at another place on the server`
      }
    }
  }
}

// The schema that the connection uses is not the files': each difference,
// in the order of N8; the message has one line for each.
export class WrongSchema extends Schema.TaggedError<WrongSchema>()("WrongSchema", {
  differences: Schema.Array(Difference)
}) {
  override get message() {
    return this.differences.map(describe).join("\n")
  }
}

// What a line is, and its name, by its first word.
const NAMED = "`((?:[^`]|``)*)`"
const KEY = new RegExp(`^(?:UNIQUE |FULLTEXT |SPATIAL )?KEY ${NAMED}`)
const CONSTRAINT = new RegExp(`^CONSTRAINT ${NAMED} (FOREIGN KEY|CHECK)`)
const COLUMN = new RegExp(`^${NAMED}`)
export const keyOf = (line: string): { readonly line: LineKind; readonly name: string } => {
  const text = line.trimStart()
  if (text.startsWith("CREATE ")) return { line: "head", name: "" }
  if (text.startsWith(")")) return { line: "options", name: "" }
  if (text.startsWith("PRIMARY KEY")) return { line: "primary key", name: "" }
  const column = COLUMN.exec(text)
  if (column !== null) return { line: "column", name: column[1]! }
  const key = KEY.exec(text)
  if (key !== null) return { line: "key", name: key[1]! }
  const constraint = CONSTRAINT.exec(text)
  if (constraint !== null) return { line: constraint[2] === "CHECK" ? "check" : "reference", name: constraint[1]! }
  return { line: "other line", name: text }
}

interface Keyed {
  readonly id: string
  readonly line: LineKind
  readonly name: string
  readonly text: string
  readonly at: number
}

// A text cut into lines, each with its key (unique: a second line of the
// same key gets its count), its text less its indent and a last comma
// (which depends only on whether a line follows), and its number from 1.
// A difference in those alone is the whole text's (`compare`).
const cut = (text: string): ReadonlyArray<Keyed> => {
  const seen = new Map<string, number>()
  return text.split("\n").map((raw, index) => {
    const { line, name } = keyOf(raw)
    const base = `${line}\u0000${name}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const bare = raw.trimStart()
    return { id: count === 1 ? base : `${base}\u0000${count}`, line, name, text: bare.endsWith(",") ? bare.slice(0, -1) : bare, at: index + 1 }
  })
}

// The keys of `a` that are not in a longest common subsequence of `a` and
// `b` (the same keys, in two orders): the lines at another place.
const outOfPlace = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlySet<string> => {
  const n = a.length
  const m = b.length
  const lengths = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const kept = new Set<string>()
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      kept.add(a[i]!)
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++
    else j++
  }
  return new Set(a.filter((key) => !kept.has(key)))
}

// What stands at a name of `TABLES`, by the server's word for it in
// `show full tables`: a table (null), or a word of the code's list.
const standing = (type: unknown): NotATable["what"] | null =>
  type === "BASE TABLE" ? null : type === "VIEW" ? "view" : type === "SEQUENCE" ? "sequence" : "other"

// The server's text of `table` is no table's (Q2, Q9): its first line is not
// that name's `CREATE TABLE` line (a view's text), or its options, the last
// line, hold ` SEQUENCE=` outside a quoted text (a sequence's text, which
// starts as a table's). What it is, by those lines alone; null for a table.
const notATable = (table: string, server: string): NotATable["what"] | null => {
  const first = server.slice(0, server.indexOf("\n") === -1 ? undefined : server.indexOf("\n"))
  if (first !== "CREATE TABLE `" + table + "` (") return /^CREATE (?:.* )?VIEW /.test(first) ? "view" : "other"
  const options = server.slice(server.lastIndexOf("\n") + 1).replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
  return options.startsWith(")") && / SEQUENCE=/.test(options) ? "sequence" : null
}

// The differences of one table's file and the server's text of it (N4),
// with no effect: in the file's order, each line's `lacks`, `other` and
// `moved`; then the server's lines that the file lacks, in its order. A
// server's text that is no table's is one difference, `NotATable`, and no
// part of it is in the result.
export const compare = (table: string, file: string, server: string): ReadonlyArray<LineDifference | NotATable> => {
  const what = notATable(table, server)
  if (what !== null) return [{ _tag: "NotATable", table, what }]
  const want = file.endsWith(";\n") ? file.slice(0, -2) : file
  // On the last line only: the table's options.
  const have = server.replace(/ AUTO_INCREMENT=[0-9]+(?=[^\n]*$)/, "")
  if (want === have) return []
  const mine = cut(want)
  const theirs = cut(have)
  const byId = new Map(theirs.map((line) => [line.id, line]))
  const inFile = new Set(mine.map((line) => line.id))
  const moved = outOfPlace(mine.filter((line) => byId.has(line.id)).map((line) => line.id), theirs.filter((line) => inFile.has(line.id)).map((line) => line.id))
  const found: Array<LineDifference> = []
  const of = (change: LineDifference["change"], line: Keyed, at: number | null, fileText: string | null, serverText: string | null): LineDifference =>
    ({ _tag: "Line", table, change, line: line.line, name: line.name, at, file: fileText, server: serverText })
  for (const line of mine) {
    const other = byId.get(line.id)
    if (other === undefined) found.push(of("lacks", line, line.at, line.text, null))
    else {
      if (other.text !== line.text) found.push(of("other", line, line.at, line.text, other.text))
      if (moved.has(line.id)) found.push(of("moved", line, line.at, line.text, other.text))
    }
  }
  for (const line of theirs) if (!inFile.has(line.id)) found.push(of("more", line, null, null, line.text))
  // Two texts that differ have a difference, also where no line does (an
  // indent or a comma, which the cut leaves out).
  if (found.length === 0) {
    found.push({ _tag: "Line", table, change: "other", line: "text", name: "", at: null, file: want, server: have })
  }
  return found
}

// Whether a table's text has a column of each of `names`, by its lines' keys.
const hasColumns = (text: string, names: ReadonlyArray<string>): boolean => {
  const columns = new Set(cut(text).filter((line) => line.line === "column").map((line) => line.name))
  return names.every((name) => columns.has(name))
}

// The most rows of `everchat_kind` that the check reads (T5): a `tinyint`,
// the file's type of `id`, has 256 values, so `ROWS_MAX` rows are more than
// the kinds can be.
export const ROWS_MAX = 257

// The most characters of an id's or a name's text in a difference (T4).
export const ROW_TEXT_MAX = 64

// The driver's text of a value, which never throws (an object with no
// prototype has no `toString`).
const stringOf = (value: unknown): string => {
  try {
    return String(value)
  } catch {
    return "(a value with no text)"
  }
}

// A value of the server as a text that keeps two different values different
// (T1): a number or a bigint by its decimal digits, a text as it is, bytes
// as `0x` and their hex digits, any other value by the driver's text of it.
export const textOf = (value: unknown): string => {
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value).toString() : String(value)
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return "0x" + Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return stringOf(value)
}

// A text of at most `ROW_TEXT_MAX` characters (code points): a longer one is
// cut there and ends with `…` (T4).
export const cutText = (text: string): string => {
  const characters = Array.from(text)
  return characters.length > ROW_TEXT_MAX ? characters.slice(0, ROW_TEXT_MAX).join("") + "…" : text
}

// The rows of `everchat_kind` as the server gave them (each `[id, name]`)
// against `KINDS`, with no effect (T2, T5): `ROWS_MAX` rows or more are one
// difference, `TooManyRows`. Else a row whose id's text is a code's id, not
// yet met, is that kind's row, and its name is compared; each other row is a
// row more. The code's ids in their order first (a name that differs, a
// row that is missing), then the rows more in the server's order. The match
// is by the whole texts; the cut is the difference's.
export const compareRows = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<KindRow | TooManyRows> => {
  if (rows.length >= ROWS_MAX) return [{ _tag: "TooManyRows", table: "everchat_kind" }]
  const code = Object.entries(KINDS).map(([name, id]) => ({ id, name })).sort((a, b) => a.id - b.id)
  const ids = new Set(code.map((kind) => String(kind.id)))
  const met = new Map<string, string>()
  const more: Array<{ readonly id: string; readonly name: string }> = []
  for (const row of rows) {
    const id = textOf(row[0])
    const name = textOf(row[1])
    if (ids.has(id) && !met.has(id)) met.set(id, name)
    else more.push({ id, name })
  }
  const found: Array<KindRow> = []
  const of = (id: string, want: string | null, have: string | null): KindRow =>
    ({ _tag: "KindRow", id: cutText(id), code: want === null ? null : cutText(want), server: have === null ? null : cutText(have) })
  for (const kind of code) {
    const id = String(kind.id)
    const have = met.get(id) ?? null
    if (have !== kind.name) found.push(of(id, kind.name, have))
  }
  for (const row of more) found.push(of(row.id, null, row.name))
  return found
}

// A table that is missing (1146) or on which the user has no right (1142).
const absent = (error: SqlError.SqlError): boolean => {
  const cause = error.reason.cause
  const errno = typeof cause === "object" && cause !== null && "errno" in cause ? cause.errno : undefined
  return errno === 1146 || errno === 1142
}

// The reads of N2 on one connection, under the check's session: each
// difference, in N8's order.
const read = (connection: SqlConnection.Connection, texts: Readonly<Record<string, string>>) =>
  Effect.gen(function*() {
    const listed = new Set<string>(TABLES)
    const found: Array<Difference> = []
    // Q1: the kinds of the schema's objects first, read once for Q1 and N5.
    const all = yield* connection.executeValuesUnprepared("show full tables", [])
    const kinds = new Map(all.map(([name, type]) => [stringOf(name), type]))
    // The server's text of `everchat_kind`, when it is a table's.
    let kindText: string | null = null
    for (const table of TABLES) {
      if (!Object.hasOwn(texts, table)) continue
      const what = kinds.has(table) ? standing(kinds.get(table)) : null
      if (what !== null) {
        found.push({ _tag: "NotATable", table, what })
        continue
      }
      const shown = yield* connection.executeValuesUnprepared(`show create table \`${table}\``, []).pipe(
        Effect.catchIf(absent, () => Effect.succeed(null))
      )
      if (shown === null) {
        found.push({ _tag: "Missing", table })
        continue
      }
      const value = shown[0]?.[1]
      const text = typeof value === "string" ? value : stringOf(value)
      const differences = compare(table, texts[table]!, text)
      found.push(...differences)
      if (table === "everchat_kind" && !differences.some((one) => one._tag === "NotATable")) kindText = text
    }
    // N5: the tables and views of the prefix that are not the list's.
    const more = [...kinds]
      .map(([name, type]) => ({ name, view: type === "VIEW" }))
      .filter((one) => one.name.startsWith(PREFIX) && !listed.has(one.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const one of more) found.push({ _tag: "Unlisted", table: one.name, view: one.view })
    // N6, Q7: the rows of the kinds, against the code's, when the table is
    // there as a table with its two columns, whatever else its lines say.
    if (kindText !== null && hasColumns(kindText, ["id", "name"])) {
      const rows = yield* connection.executeValuesUnprepared(`select id, name from everchat_kind order by id limit ${ROWS_MAX}`, [])
      found.push(...compareRows(rows))
    }
    // N7: the caller's texts.
    for (const table of TABLES) if (!Object.hasOwn(texts, table)) found.push({ _tag: "NoText", table })
    for (const table of Object.keys(texts).sort()) if (!listed.has(table)) found.push({ _tag: "NoTable", table })
    return found
  })

// Runs `body` on `connection` under the check's session, and sets the two
// values back to what they were at its end, whatever the end.
const underSession = <A, E>(connection: SqlConnection.Connection, body: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.map(
      connection.executeValuesUnprepared("select @@session.sql_mode, @@session.sql_quote_show_create", []),
      (rows) => ({ mode: rows[0]?.[0], quote: rows[0]?.[1] })
    ),
    () => Effect.andThen(connection.executeUnprepared(SESSION, [], undefined), body),
    (was) => connection.executeUnprepared("set session sql_mode = ?, sql_quote_show_create = ?", [was.mode, was.quote], undefined)
  )

// The check: nothing when the schema that the client's connection uses is
// the files', `WrongSchema` with each difference when it is not.
export const check = (texts: Readonly<Record<string, string>>): Effect.Effect<void, WrongSchema | SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const differences = yield* Effect.scoped(Effect.flatMap(sql.reserve, (connection) => underSession(connection, read(connection, texts))))
    if (differences.length > 0) return yield* Effect.fail(new WrongSchema({ differences }))
  })
