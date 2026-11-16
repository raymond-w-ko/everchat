// Database
// ========
// Opens the one SQLite file of a chat, and makes it ready: it sets the
// pragmas, and it makes the schema (schema.ts) on an empty file. The result
// is Effect's `SqlClient` over one connection. `sqlite.ts` is the only
// module that uses it.
//
// The driver (`@effect/sql-sqlite-bun`) waits on a locked file for the
// limit `store` (below), and starts each transaction with `BEGIN
// IMMEDIATE`. It would also set
// `journal_mode = wal` as it opens the file; we ask it not to
// (`disableWAL`), because that pragma lasts in the file and runs before any
// check. We add:
//
// - `synchronous = full`: a transaction that returned is on the disk, also
//   after a power failure. In WAL mode the default (`normal`) can lose the
//   last transactions.
// - `foreign_keys = on`: SQLite ignores references unless a connection asks
//   for the check.
// - `recursive_triggers = on`: a REPLACE (`replace into`, `insert or
//   replace`) deletes the row that it meets, and only with this pragma does
//   that delete run the table's delete trigger. So the triggers that keep a
//   message, a message's image, a node, an event and the chat's row refuse
//   a REPLACE too (docs/schema.html, section 1). The two pragmas of the
//   block of the page's section 8 are these two.
// - `journal_mode = wal`, set by `ready` only after the check of the file
//   (below) has passed: on a new file once its schema is made, and on a
//   file with the mark (where it changes nothing if the file is in WAL
//   already). The three pragmas above last only as long as the connection.
//
// The file and its mark (`pragma user_version`, schema.ts):
//
// - An empty file (no table, view, index or trigger of ours) gets the whole
//   schema and the mark VERSION in one transaction, in the journal mode
//   that the file has (a rollback journal), and then goes to WAL. A
//   statement of the transaction that fails leaves the file as it was. A
//   crash before the commit leaves an empty file. A crash after it, or a
//   change to WAL that fails (below), leaves a file with the schema and the
//   mark, in the rollback journal, with no row of a launch or a chat: the
//   next open finds the mark, writes no schema and sets the file to WAL.
//   That is the recovery.
// - A file with the mark VERSION is opened as it is, and set to WAL.
// - Any other file is refused with `DatabaseVersion`, and nothing in it
//   changes, not its bytes and not its journal mode: a file of another
//   mark, or one with tables and no mark (as Effect's migrator left it).
//   The one check is the transaction; nothing that lasts is written before
//   it passes. There is no migration: a new schema is a new file.
//
// The limit `store` (docs/host.md, section 2, "The deadline of the work
// under the lock", O3; section 9, item 9): each wait on the file ends,
// done or with `StoreError`, within `store` milliseconds, 5,000 when it is
// not given. On SQLite a statement does not yield, so no timer of Effect
// can cut it while it runs; the wait of a statement is the wait for the
// file's lock, and the driver's wait on a locked file (`busy_timeout`) is
// the store's timer. A transaction starts with `BEGIN IMMEDIATE`, so it
// waits at its start, before its first statement, and a write that fails
// so has written nothing. A call of the store waits once on the file, so
// it ends within `store`. `limits` is checked once, at the layer's start:
// a `store` that is not a whole number from 1 to 2**31 - 1 fails the layer
// with `StoreError` (`open`). So does the open itself when the driver
// fails: a lock that it waited `store` for, a file that it cannot open.
//
// The waits, each with the statement that waits, what it waits for, and
// its bound (the cases: store.test.ts, "the limit store: …"):
//
// | What                     | The statement that waits     | It waits for              | Bound       |
// | ------------------------ | ---------------------------- | ------------------------- | ----------- |
// | a write with no          | the write itself             | another connection's      | `store`     |
// | transaction              |                              | write lock                |             |
// | a transaction, and the   | its `BEGIN IMMEDIATE`        | another connection's      | `store`     |
// | store's own snapshot     |                              | write lock                |             |
// | a commit, in WAL mode    | none                         | no reader                 | none        |
// | a read and a snapshot of | none, in WAL mode            | no writer                 | none        |
// | the reads' connection    |                              |                           |             |
// | the open: its check      | the check's `BEGIN           | another connection's      | `store`     |
// |                          | IMMEDIATE`                   | write lock                |             |
// | the open, on a file in a | the check's `COMMIT`         | a reader (a commit in a   | `store`     |
// | rollback journal         |                              | rollback journal does)    |             |
// | the open, on a file in a | `pragma journal_mode = wal`  | a reader                  | `store`     |
// | rollback journal         |                              |                           |             |
// | the whole open, of a     | the three above, one after   |                           | 3 × `store` |
// | file not yet in WAL      | the other                    |                           |             |
// | the whole open, of a     | the check's `BEGIN IMMEDIATE`| (its `COMMIT` and the     | `store`     |
// | file in WAL mode         | only                         | pragma wait for none)     |             |
//
// The bounds are sums of the waits on the file; the time of the scheduler,
// of a process's start and of the statements themselves is on top.
//
// The open is not one wait: on a file that is not yet in WAL mode (its
// first open, or a file that another tool put back in a rollback journal)
// its three statements can each wait for `store`, one after the other. It
// takes another process that holds a lock on the file while it is opened,
// and the open then fails with `StoreError` (`open`). What the file holds
// then depends on the statement that failed: at the check's `BEGIN
// IMMEDIATE` or at its `COMMIT`, nothing new (the transaction is taken
// back); at the change to WAL of a new file, the schema and the mark, in
// the rollback journal, with no launch (the check committed them; the next
// open sets the file to WAL); at the change to WAL of a file that had its
// schema, nothing new, and the file in its journal mode. The open runs when
// the layer is built, not in a call of the store. `sqlite.ts` says what its layers add (the launch).
//
// The waits that `store` does not bound: the open (above), whose bound is
// 3 × `store`; a call's wait for the connection while another call of the
// same process holds it in a transaction (one connection, one call at a
// time), whose bound is the holder's own time; and the time of a statement
// that runs (it holds the process's one thread, up to its end).

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Duration, Effect, Layer } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { DatabaseVersion, StoreError } from "@everchat/core/store"
import { schema, VERSION } from "./schema.ts"

export { VERSION }

// The name of the database in a home.
export const FILE = "everchat.db"

// The limits of the store over a file. `store`: the most milliseconds that
// one call of the store waits for the file's lock (above).
export interface Limits {
  readonly store?: number | undefined
}

// The layer `made` with the limit `store` of `limits`, built at once: a
// limit out of its range, and a fault of the driver at the open, fail it
// with `StoreError` (`open`).
const withLimit = <ROut, E>(limits: Limits, made: (busyTimeout: Duration.Duration) => Layer.Layer<ROut, E>) =>
  Layer.effectContext(
    Effect.flatMap(storeLimit(limits), (busyTimeout) => Layer.build(made(busyTimeout))).pipe(
      Effect.mapError((error) => (SqlError.isSqlError(error) ? new StoreError({ op: "open", cause: error }) : error))
    )
  )

// The default of `store`, and its largest value (the driver's too).
export const STORE = 5000
export const STORE_MAX = 2 ** 31 - 1

// The limit `store` of `limits`, checked: the driver's wait.
export const storeLimit = (limits: Limits) => {
  const store = limits.store ?? STORE
  return Number.isInteger(store) && store >= 1 && store <= STORE_MAX
    ? Effect.succeed(Duration.millis(store))
    : Effect.fail(
      new StoreError({ op: "open", cause: new RangeError(`the limit store is a whole number of milliseconds from 1 to ${STORE_MAX}, not ${store}`) })
    )
}

// The mark of the database: its `pragma user_version`.
export const version = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ user_version: number }>`pragma user_version`
  return rows[0]?.user_version ?? 0
})

// The count of the names in the file that are not SQLite's own.
const names = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ n: number }>`select count(*) as n from sqlite_master where substr(name, 1, 7) <> 'sqlite_'`
  return rows[0]?.n ?? 0
})

const ready = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("pragma synchronous = full")
      yield* sql.unsafe("pragma foreign_keys = on")
      yield* sql.unsafe("pragma recursive_triggers = on")
      yield* sql.withTransaction(Effect.gen(function*() {
        const have = yield* version
        if (have === VERSION) return
        if (have !== 0 || (yield* names) > 0) {
          return yield* new DatabaseVersion({ have, want: VERSION, file: filename })
        }
        for (const statement of schema) yield* sql.unsafe(statement)
        yield* sql.unsafe(`pragma user_version = ${VERSION}`)
      }))
      // Only now that the file is ours and of this version.
      yield* sql.unsafe("pragma journal_mode = wal")
    })
  )

// The database in the file `filename`, for reads only: for a process that
// does not own the file. The file must be there. Nothing is set and no
// schema is made, because this connection cannot write. A transaction on it
// starts with `BEGIN` (the driver does that), so it is a snapshot that takes
// no lock from the launch that writes. It waits on a locked file as the
// store does, for `limits.store`.
export const readonly = (filename: string, limits: Limits = {}) =>
  withLimit(limits, (busyTimeout) => SqliteClient.layer({ filename, readonly: true, busyTimeout }))

// The layer for the database in the file `filename`. It makes the file when
// it is not there. Each call waits on a locked file for `limits.store`.
export const layer = (filename: string, limits: Limits = {}) =>
  withLimit(
    limits,
    (busyTimeout) => ready(filename).pipe(Layer.provideMerge(SqliteClient.layer({ filename, disableWAL: true, busyTimeout })))
  )
