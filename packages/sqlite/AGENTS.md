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
  changes of the tables), `./testing` (`packages/sqlite/tests/help.ts`,
  what the tests that need a real store share, and `harness`, SQLite's
  harness of the contract's suites), `./contract/harness`
  (`packages/sqlite/tests/contract/harness.ts`, the type `Harness`, `PICK`
  and `options`), `./contract/store1`
  (`packages/sqlite/tests/contract/store1.ts`, the store's cases, part 1:
  the launch to a turn's ceiling, `storeCases1`), `./contract/store2`
  (`packages/sqlite/tests/contract/store2.ts`, the store's cases, part 2:
  the comparison of a wake-up's states to the key of a message's sender,
  `storeCases2`, and the model of the comparison) and `./contract/tenant`
  (`packages/sqlite/tests/contract/tenant.ts`, the suite of two tenants,
  `tenantCases`). It has no entry `.`.
- `packages/sqlite/tests/`: the tests of the store that need a second
  process. `packages/sqlite/tests/child.ts` is the program that such a
  test starts (`packages/sqlite/tests/crash.test.ts`).
- `packages/sqlite/tests/contract/`: the contract's suites ("The contract's
  suites").

## The contract's suites

- The store's contract is a set of cases that every store passes, from one
  text of them: a suite is a function of a harness, and a store runs it with
  its own. `tenantCases(h)` (`tests/contract/tenant.ts`) holds the cases of
  two tenants; `src/tenant.test.ts` runs it with SQLite's harness
  (`harness` of `tests/help.ts`) and keeps the cases that need SQLite itself.
  `storeCases1(h)` (`tests/contract/store1.ts`) holds the store's cases from
  the launch to a turn's ceiling; `src/store.test.ts` runs it so, and keeps
  the cases that need SQLite itself (the reads over a file, the probe of a
  live owner, a trigger's refusal, and SQLite's own text of a refusal that
  a case of the suite asserts only as a `StoreError` and its op).
  `storeCases2(h)` (`tests/contract/store2.ts`) holds the store's cases from
  the comparison of a wake-up's states with a model of them to the key of a
  message's sender; `src/store.test.ts` runs it after `storeCases1`, with the
  same harness (the helpers of part 1 that it uses read the harness that
  `storeCases1` set), and keeps the cases that need SQLite itself (the local
  layers, a second connection, the reads over a file, a trigger's refusal,
  a change of the schema, SQLite's own text). The model of the comparison
  (`SEEDS`, `STEPS`, `seeded`, `compareSeed` and the model's functions) is
  exported, for a comparison of two stores.
  A second store (MariaDB's, in its own package) runs a suite by giving its
  own `Harness`.
- The harness (`tests/contract/harness.ts`, the type `Harness`): `newFile()`,
  a new, empty database by a name that only the harness reads (on SQLite
  the file's path; on a server a schema's name; a case passes it on);
  `withStore(place, effect, opts?, alive?)` and `withChats(place, effect,
  alive?)`, promises, where `alive` answers the probe of a pid (a store
  with no probe does not read it); `rows(place, query)` and `write(place,
  statement, params?)`, plain SQL straight to the database with no store,
  each a promise on every store (a server has no synchronous client), a blob
  coming back as a `Uint8Array`; `copy(from)`, a new database with every row
  of another, ids too (a suite builds its databases once, and runs each
  case on a copy); and `has.version`, whether the store has `Reads.version`
  (a case that reads it is registered with `test.skipIf(!h.has.version)`,
  so its name is in the list on every store). `PICK` and `options` are of
  no database: they are the harness file's, and `tests/help.ts` gives them
  on. `tests/help.ts` keeps its synchronous `rows` and `write`, which other
  packages' tests import.
- A file of `tests/contract/` imports `bun:test`, `effect`, `effect/testing`,
  `@everchat/core/*` and the files beside it, and nothing of SQLite: not
  `bun:sqlite`, `tests/help.ts`, a file of `src/`, `node:fs` or a child
  process. What a case needs of the database comes from the harness. A
  suite's SQL is of both databases: a UUID in a statement is `X'<hex>'`,
  and a text's bytes are `octet_length(text)`. A database's own text of a
  refusal is not the suite's: a case of the suite asserts the `StoreError`
  and its op, and SQLite's test file the text. The schema's tables of a chat
  and their columns that name a pick are the suite's constants (`shape`);
  SQLite's case "the database refuses: the schema has each reference inside
  a chat that the store writes" checks them against its pragmas.
- A case is in a suite when its claim holds for every store: it uses the
  members of `Store`, `Reads` and `Chats`, the harness, and plain SQL
  through `h.rows` and `h.write`. A case stays in SQLite's test file, whole,
  when it needs one of: a pragma; a trigger's refusal of a raw statement; `rowid`;
  REPLACE; the mark (`DatabaseVersion`, `VERSION`); WAL; the limit `store`
  (`busy_timeout`); a `bun:sqlite` connection of its own; the reads' layer
  over a file or a layer with no database (`readsLayer`,
  `storeLayerNoDatabase`, `chatsLayerNoDatabase`); a child process; the
  refusal of a live owner by the probe of its pid and host (`LaunchLive`);
  the view `everchat_msg_read`; the schema's text (`schema.ts`); a
  `Dialect` of the test's own; a statement that changes the schema (`drop
  index`); the local layers' one tenant and one chat beside the tag. No case
  is cut in two.
- A move of a case into a suite keeps its name to the byte, and its text but
  for `h.` before the harness's names, `await` (and `async`), `h.copy` for
  a copy of a file, and the indent. A helper that only moved cases use moves
  with them; one that both kinds use is the suite's, and SQLite's file
  imports it. The proof of a move is the list of the names that `bun test`
  runs for the file (its JUnit report), equal before and after, with as
  many passes.

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
the root `AGENTS.md`. A change of the schema (`src/schema.ts`, `docs/schema.html`)
changes MariaDB's files of `schema/mariadb/` in the same batch. The
comparisons of `packages/mariadb/src/tables.test.ts` fail until it does for
a change of the tables; the columns with their MariaDB types (the page's),
`not null` and defaults; the primary keys; the unique keys and the indexes;
the references with their rules; the checks' expressions but the named
ones; the generated column's expression as the page writes it. The
differences that the test names, and the page's words, a person reads by
eye (`packages/mariadb/AGENTS.md`, "The schema's files").
