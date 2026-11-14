// Database
// ========
// Opens the one SQLite file of a chat, and makes it ready: it sets the
// pragmas, and it runs the migrations that the file has not run yet. The
// result is Effect's `SqlClient` over one connection. `store.ts` is the only
// module that uses it.
//
// The driver (`@effect/sql-sqlite-bun`) sets `journal_mode = wal`, waits up
// to 5 s on a locked file, and starts each transaction with `BEGIN
// IMMEDIATE`. We add:
//
// - `synchronous = full`: a transaction that returned is on the disk, also
//   after a power failure. In WAL mode the default (`normal`) can lose the
//   last transactions.
// - `foreign_keys = on`: SQLite ignores references unless a connection asks
//   for the check.
//
// All pending migrations run in one transaction (Effect's migrator does
// that). A migration that fails leaves the file as it was.

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { migrations } from "./migrations.ts"

// The name of the database in a home.
export const FILE = "everchat.db"

const ready = (all: Parameters<typeof SqliteMigrator.fromRecord>[0]) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("pragma synchronous = full")
      yield* sql.unsafe("pragma foreign_keys = on")
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(all) })
    })
  )

// The count of the migrations that this program knows. A database that has
// run them all is of this program's version.
export const VERSION = Object.keys(migrations).length

// The count of the migrations that the database has run.
export const version = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ n: number }>`select count(*) as n from effect_sql_migrations`
  return rows[0]?.n ?? 0
})

// The database in the file `filename`, for reads only: for a process that
// does not own the file. The file must be there. Nothing is set and no
// migration runs, because this connection cannot write. A transaction on it
// starts with `BEGIN` (the driver does that), so it is a snapshot that takes
// no lock from the launch that writes.
export const readonly = (filename: string) => SqliteClient.layer({ filename, readonly: true })

// The layer for the database in the file `filename`. It makes the file when
// it is not there. `all`: the migrations to run (a test gives fewer, to make
// a database as an older version of the program left it).
export const layer = (filename: string, all: Parameters<typeof SqliteMigrator.fromRecord>[0] = migrations) =>
  ready(all).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
