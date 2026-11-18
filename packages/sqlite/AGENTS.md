`packages/sqlite/` (`@everchat/sqlite`): the store on SQLite, with Bun's driver.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/sqlite/` (`@everchat/sqlite`): the store on SQLite, with Bun's
  driver. Its entries: `./bun` (`packages/sqlite/src/sqlite.ts`, the
  store on SQLite), `./sql` (`packages/sqlite/src/sql.ts`, the store that
  SQLite and MariaDB share), `./database` (`packages/sqlite/src/database.ts`,
  it opens the file, makes the schema on an empty one, and refuses a file
  of another version), `./schema` (`packages/sqlite/src/schema.ts`, the
  schema whole: the tables in one list of statements, and its mark; no
  changes of the tables), and `./testing` (`packages/sqlite/tests/help.ts`,
  what the tests that need a real store share). It has no entry `.`.
- `packages/sqlite/tests/`: the tests of the store that need a second
  process. `packages/sqlite/tests/child.ts` is the program that such a
  test starts (`packages/sqlite/tests/crash.test.ts`).

## The two files of the store

- `sql.ts` (`./sql`), the shared store: all that is written over Effect's
  `SqlClient` and the `Dialect`. The rows and their decoders; the helpers
  (`only`, `failed`, `uuidBytes`, `uuidText`, `parsed`, `find`); the reads
  of a chat (`reading`); the store of a chat for a launch (`open`, then
  `storeOf`); every write behind `writer` (the dialect's `beforeWrite`);
  the tag `Chats` (`chatsOf`); and the `Dialect`'s type. It imports
  `effect` and `@everchat/core` only: not `@effect/sql-sqlite-bun`, not
  `bun:sqlite`, not `./database.ts`. The package `@everchat/mariadb`
  imports it.
- `sqlite.ts` (`./bun`), SQLite's part: its dialect (`SQLITE`, with
  `ProcessAlive` for its `ownerLive`), the reference `Dialect` (SQLite's
  unless one is given), the local file's one chat (`theTenant`,
  `theChat`, `bind`), `readsOf`, and the layers over a file
  (`storeLayer`, `readsLayer`, `chatsLayer` and their `NoDatabase`
  forms). It gives the type `Dialect` and `ViewWrite` again, from
  `sql.ts`.

## The one form

Every statement of `sql.ts`, now and later, has one form for SQLite and
MariaDB (lead, ec-dwjz, R2; the full list is at the head of `sql.ts`):

- No `update ... returning`: MariaDB refuses it. A write that needs the
  rows it changes first selects their keys with the update's conditions
  and the dialect's `forUpdate`, then updates by those keys, in one
  transaction.
- No `set` that reads a column which an earlier assignment of the same
  `set` wrote: SQLite reads the old row, MariaDB the new value.
- No scalar `min(a, b)` or `max(a, b)`, no `in (values ...)`, and a `sum`
  cast to a whole number.
- What the two databases say in their own ways is a member of the
  `Dialect`, and only there: `forUpdate`, `pickOf`, `putView`, `version`,
  `ownerLive` and `beforeWrite`.
- With a `beforeWrite`, a write of the store skips it only while a
  guarded write's body runs, before that write's COMMIT or ROLLBACK; every
  other write (one in a callback of `sql.afterCommit` too) opens its own
  transaction, runs `beforeWrite` first, and writes nothing when it fails
  (lead, ec-9e7436, W1).
- A write with no chat yet runs `beforeWrite` too, given null: it is the
  first statement of the launch's transaction of `open` (before the chat
  is found) and of the transaction of `Chats.make`, and a failure of it
  writes nothing and fails the launch or the make; these two transactions
  are not writes of `writer`, and put no mark (lead, ec-9qt2rc, W6).

## The chat's database

All state of a chat lives in its database (see "All state in the chat's
database" in the root `AGENTS.md`). This gives two things:

- Restart: when the process is interrupted, crashes, or restarts, it reads the
  database and continues from where it was. It loses at most the work that was
  in flight (for example, a request that had not finished), and it can see
  what that work was so that it can start it again.
- Backup and moving hosts: a local install is one to three files. These are
  one executable (`bun build --compile`), one SQLite database, and maybe one
  config file. On MariaDB, the product's backups of its schema include the
  chats [Q47].

The schema: `docs/schema.html`, and "All state in the chat's database" in
the root `AGENTS.md`.
