// SQLite
// ======
// The store over SQLite: SQLite's dialect (`SQLITE`) and the layers over a
// file, with Bun's driver. The SQL of `Store` and `Reads` (store.ts) over
// Effect's `SqlClient`, which SQLite and MariaDB share, is in `sql.ts`; no
// other module uses SQL. The rules that the store keeps are in `store.ts`;
// the tables are in `schema.ts`, and the file, its driver and its pragmas
// in `database.ts`.
//
// Each call of the store ends, done or with `StoreError` and its `op`,
// within the limit `store` (`Database.Limits`, 5,000 ms when it is not
// given), which each layer over a file takes as its last argument: the
// driver's wait on a locked file is the timer (database.ts says what it
// bounds and what it does not, statement by statement). A transaction is
// one call: it waits at its `BEGIN IMMEDIATE`, and one that fails there
// has written nothing. A layer of the store, when it is built, first opens
// the file (database.ts: its three waits, within 3 × `store` on a file not
// yet in WAL mode, within `store` on one in WAL mode); then the store's
// launch (`open`, sql.ts) is a transaction of its own, which waits at its
// `BEGIN IMMEDIATE` within `store` and fails with `StoreError` (`launch`).
// So `storeLayer` is built within 4 × `store` on a file not yet in WAL
// mode, within 2 × `store` on one in WAL mode; `chatsLayer` within the
// open's bound, and each launch of `Chats.store` within `store`. These
// bounds are sums of the waits on the file; the time of the scheduler, of a
// process's start and of the statements themselves is on top. An open that
// fails writes no launch; database.ts says what the file holds then (on a
// new file whose change to WAL fails: the schema and the mark).
//
// The local file has one tenant and one chat: the first launch makes them
// (`bind`), and the local layers then take the path of the tag `Chats`
// (`open`, `reading`, in `sql.ts`).

import { Clock, Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "./database.ts"
import {
  Chats,
  DatabaseVersion,
  type Options,
  Pick,
  Reads,
  Store,
  StoreError
} from "@everchat/core/store"
import { type Bound, chatsOf, type Dialect as DialectOf, failed, find, newChat, only, open, reading, uuidBytes } from "./sql.ts"

// The shared store's `Dialect` (sql.ts), and the row of a view that a
// dialect writes.
export type Dialect = DialectOf
export type { ViewWrite } from "./sql.ts"

// Does a process of this host run? A test can replace it.
export const ProcessAlive = Context.Reference<(pid: number) => boolean>("everchat/store/ProcessAlive", {
  defaultValue: () => (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: it runs, and it is not ours to signal.
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
})

// The file's chat
// ---------------

// The file's tenant, when it has one. The local file has at most one.
const theTenant = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const rows = yield* sql<{ id: Uint8Array }>`select id from everchat_tenant`
    if (rows.length > 1) return yield* Effect.die(new Error(`the local file holds one tenant, and this one holds ${rows.length}`))
    return Option.fromUndefinedOr(rows[0]?.id)
  })

// The UUID of the chat of `tenant`, when it has one. In the local file a
// tenant has at most one.
const theChat = (sql: SqlClient.SqlClient, tenant: Uint8Array) =>
  Effect.gen(function*() {
    const rows = yield* sql<{ uuid: Uint8Array }>`select uuid from everchat_chat where tenant = ${tenant}`
    if (rows.length > 1) return yield* Effect.die(new Error(`the local file holds one chat, and this one holds ${rows.length}`))
    return Option.fromUndefinedOr(rows[0]?.uuid)
  })

// The file's one chat, when it has one: its tenant and its UUID, then the
// chat by both (`find`), as `Chats` finds a chat.
const bound = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const tenant = yield* theTenant(sql)
    if (Option.isNone(tenant)) return Option.none<Bound>()
    const uuid = yield* theChat(sql, tenant.value)
    return Option.isNone(uuid) ? Option.none<Bound>() : yield* find(sql, tenant.value, uuid.value)
  })

// The dialect
// -----------

// SQLite's dialect: a transaction holds the file's write lock from its
// `BEGIN IMMEDIATE`, so a `select` of keys needs no lock of its own, and
// a write needs no statement before it.
export const SQLITE: Dialect = {
  forUpdate: "",
  pickOf: (sql, pick) =>
    Effect.gen(function*() {
      const { effort, model, speed, vendor } = pick
      const created = yield* Clock.currentTimeMillis
      yield* sql`insert into everchat_pick ${sql.insert({ vendor, model, effort, speed, created })} on conflict do nothing`
      const row = yield* only(
        yield* sql<{ id: number }>`
        select id from everchat_pick
        where vendor = ${vendor} and model = ${model} and effort = ${effort} and speed = ${speed}`
      )
      return row.id
    }),
  putView: (sql, row) =>
    Effect.asVoid(sql`
      insert into everchat_view ${sql.insert({ ...row })}
      on conflict (chat, name) do update
      set parts = excluded.parts, batch = excluded.batch, updated = excluded.updated`),
  version: (sql) =>
    Effect.gen(function*() {
      const row = yield* only(yield* sql<{ data_version: number }>`pragma data_version`)
      return row.data_version
    }),
  // A launch with our own pid is not another process: the pid was used
  // again (in a container, the program is always process 1). A launch of
  // another host cannot be checked, so the chat moved here.
  ownerLive: (open, input) =>
    Effect.gen(function*() {
      const alive = yield* ProcessAlive
      return open.host === input.host && open.pid !== input.pid && alive(open.pid)
    })
}

// The dialect of the stores, the reads and the chats that the layers of
// this module build, read at each build: SQLite's unless one is given.
export const Dialect = Context.Reference<Dialect>("everchat/store/Dialect", { defaultValue: () => SQLITE })

// The file's one chat, made when the file has none: a new tenant (the 16
// bytes of a new UUIDv4) and its chat. Only inside the transaction of the
// first launch.
const bind = (sql: SqlClient.SqlClient, dialect: Dialect, pick: Pick) =>
  Effect.gen(function*() {
    const found = yield* bound(sql)
    if (Option.isSome(found)) return found.value
    const have = yield* theTenant(sql)
    const tenant = Option.isSome(have) ? have.value : uuidBytes(crypto.randomUUID())
    return (yield* newChat(sql, dialect, tenant, pick)).bound
  })

// The layers
// ----------

// The reads of the file's one chat, over the `SqlClient` in the context,
// found as `Chats` finds a chat. It fails when the file has no chat yet: a
// launch makes it.
const readsOf = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const dialect = yield* Dialect
    const found = yield* bound(sql).pipe(failed("open"))
    if (Option.isNone(found)) {
      return yield* new StoreError({ op: "open", cause: new Error("the file has no chat yet: a launch makes it") })
    }
    return Reads.of(reading(sql, dialect, found.value))
  })

// The reads over the `SqlClient` in the context.
export const readsLayerNoDatabase = Layer.effect(Reads, Effect.flatMap(SqlClient.SqlClient, readsOf))

// The reads over the database in the file `filename`, which must be there.
// It fails when the file's mark is not this program's (schema.ts): a read of
// tables that this program does not know gives wrong answers.
export const readsLayer = (filename: string, limits: Database.Limits = {}) =>
  Layer.effect(
    Reads,
    Effect.gen(function*() {
      const database = yield* Layer.build(Database.readonly(filename, limits))
      const have = yield* Database.version.pipe(Effect.provide(database), failed("open"))
      if (have !== Database.VERSION) {
        return yield* new DatabaseVersion({ have, want: Database.VERSION, file: filename })
      }
      return yield* readsOf(Context.get(database, SqlClient.SqlClient))
    })
  )

// The store over the `SqlClient` in the context: the file's one chat, made
// at the first launch.
export const storeLayerNoDatabase = (options: Options) =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const dialect = yield* Dialect
      return yield* open(sql, dialect, bind(sql, dialect, options.pick), options.launch)
    })
  )

// The store over the database in the file `filename`.
export const storeLayer = (filename: string, options: Options, limits: Database.Limits = {}) =>
  storeLayerNoDatabase(options).pipe(Layer.provide(Database.layer(filename, limits)))

export const chatsLayerNoDatabase = Layer.effect(
  Chats,
  Effect.gen(function*() {
    return chatsOf(yield* SqlClient.SqlClient, yield* Dialect)
  })
)

// The tag over the database in the file `filename`, made when it is empty.
export const chatsLayer = (filename: string, limits: Database.Limits = {}) =>
  chatsLayerNoDatabase.pipe(Layer.provide(Database.layer(filename, limits)))
