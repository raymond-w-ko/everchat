// Database
// ========
// Opens the one SQLite file of a chat, and makes it ready: it sets the
// pragmas, and it makes the schema (schema.ts) on an empty file. The result
// is Effect's `SqlClient` over one connection. `sqlite.ts` is the only
// module that uses it.
//
// The driver (`@effect/sql-sqlite-bun`) waits up to 5 s on a locked file,
// and starts each transaction with `BEGIN IMMEDIATE`. It would also set
// `journal_mode = wal` as it opens the file; we ask it not to
// (`disableWAL`), because that pragma lasts in the file and runs before any
// check. We add:
//
// - `synchronous = full`: a transaction that returned is on the disk, also
//   after a power failure. In WAL mode the default (`normal`) can lose the
//   last transactions.
// - `foreign_keys = on`: SQLite ignores references unless a connection asks
//   for the check.
// - `journal_mode = wal`, set by `ready` only after the check of the file
//   (below) has passed: on a new file once its schema is made, and on a
//   file with the mark (where it changes nothing if the file is in WAL
//   already). The two pragmas above last only as long as the connection.
//
// The file and its mark (`pragma user_version`, schema.ts):
//
// - An empty file (no table, view, index or trigger of ours) gets the whole
//   schema and the mark VERSION in one transaction, in the journal mode
//   that the file has (a rollback journal), and then goes to WAL. A
//   statement that fails leaves the file as it was. A crash before the
//   commit leaves an empty file; a crash after it, a file with the mark,
//   which the next open sets to WAL.
// - A file with the mark VERSION is opened as it is, and set to WAL.
// - Any other file is refused with `DatabaseVersion`, and nothing in it
//   changes, not its bytes and not its journal mode: a file of another
//   mark, or one with tables and no mark (as Effect's migrator left it).
//   The one check is the transaction; nothing that lasts is written before
//   it passes. There is no migration: a new schema is a new file.

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseVersion } from "@everchat/core/store"
import { schema, VERSION } from "./schema.ts"

export { VERSION }

// The name of the database in a home.
export const FILE = "everchat.db"

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
// no lock from the launch that writes.
export const readonly = (filename: string) => SqliteClient.layer({ filename, readonly: true })

// The layer for the database in the file `filename`. It makes the file when
// it is not there.
export const layer = (filename: string) => ready(filename).pipe(Layer.provideMerge(SqliteClient.layer({ filename, disableWAL: true })))
