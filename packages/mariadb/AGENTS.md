`packages/mariadb/` (`@everchat/mariadb`): the store on MariaDB, for a hosted
deployment (`docs/design.md`, "The database"). Today it holds the driver's
client, the list of the schema's tables and the start's check of a schema
against its files; the schema itself is `schema/mariadb/` at the root ("The
schema's files"). The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/mariadb/` (`@everchat/mariadb`): the store on MariaDB. Its four
  entries, no `.`:
- `./check` (`packages/mariadb/src/check.ts`): `check(texts)`, the start's
  check of the schema that the client's connection uses against each
  table's file ("The start's check"), its error `WrongSchema` and the data
  of a difference (`Difference`), and `compare`, its comparison of two
  texts with no effect.
- `./client` (`packages/mariadb/src/client.ts`): `client(options)`, the
  layer of the driver's client (`@effect/sql-mysql2`'s `MysqlClient`, and
  so `effect`'s `SqlClient`) over a server's socket file, and its type
  `Options`: `socket` (the file's path), `user`, `password` (a `Redacted`
  text; none for a user with no password) and `schema` (none when the
  caller names none). No option has a default: no user, schema or path is
  in the code. A `socket` that does not start with `/` (empty, spaces, a
  relative path) fails the layer's build with the driver's `SqlError`
  before the driver is called. The layer's build runs the driver's
  `select 1`, so a server that does not answer fails it with the driver's
  `SqlError`, not a defect. The password is in no text of that error.
- `./tables` (`packages/mariadb/src/tables.ts`): `TABLES`, the names of the
  19 tables, as a constant list in the order of the `create table`
  statements of SQLite's schema (an order in which each table's references
  are there before it), and their type `Table`. It holds no text of a file
  and imports no file of `schema/`: a caller gives the texts as a value.
- `./testing` (`packages/mariadb/tests/server.ts`): the tests' help, as
  sqlite's `./testing` is: `start`, which starts a private MariaDB server
  for a test ("The servers of the checks"). A file under the package's
  `tests/` is a test to `tools/graph.ts`, so it may import any built-in.
- `packages/mariadb/tests/schema.ts` (no entry): the tests' help of the
  schema, the one way in which a test of the package gets one: `texts()`,
  each table's file by its name; `seed()`, the seed's text; and
  `make(server, name)`, which makes the schema `name` on a server of
  `tests/server.ts` (as its root), runs each table's file in the order of
  `TABLES` with `foreign_key_checks = 1`, then the seed.
- The tests of one module sit next to it, in `packages/mariadb/src/`; the
  helper's own tests are `packages/mariadb/tests/server.test.ts`. The tests
  of the schema's files are `packages/mariadb/src/tables.test.ts`, and those
  of the start's check `packages/mariadb/src/check.test.ts`.

## What it is not

Each of these is a later bead of the plan of the store on MariaDB
(ec-dwjz):

- No store yet. The shared store is `@everchat/sqlite`'s entry `./sql`,
  with MariaDB's dialect. The client sets nothing of the session and holds
  no SQL.
- No store calls the start's check yet: the store's layer will, at its
  build.
- No config yet: the caller names the socket, the user and the schema.
- No lease yet, and no stage rule.
- No host and port: a connection over TCP needs TLS, which comes with the
  config. So a socket's path that is not absolute is refused, since the
  driver takes an empty one as TCP to port 3306 with no TLS.

## Its imports

The package's code imports `effect`, `@effect/sql-mysql2` and, when a later
bead needs them, `@everchat/core` and the shared store
(`@everchat/sqlite/sql`), and nothing else: no other file of sqlite (not
its layers over a file, not its driver), nothing of local, openai,
codemode, the server, mcp or wakeups, and no module of Bun or of Node.
`tools/graph.ts` holds it:

- The package's files (not its tests) may import no built-in module.
- They may reach only `packages/core/` and `packages/sqlite/src/sql.ts`,
  besides the package's own files.
- The rows of the core, sqlite, codemode, server, mcp and wakeups there
  forbid `packages/mariadb/`, so only `packages/local` may import the
  package today. The hosted entry is a later plan's.

The type program `packages/mariadb/tsconfig.json` checks its sources and
its tests with the Bun types. The driver's declarations need Node's types,
and the store will send an id as a `Buffer`. So the package has no guard
with no types: the list of built-ins of `tools/graph.ts`, which gives the
package's files none, is what refuses a module of Bun or of Node there. Its
tests may import any of them.

The driver, `@effect/sql-mysql2` 4.1.2 (MIT), brings 11 packages into
`bun.lock`. None has an install script or native code:

| Package | Version | Licence |
| --- | --- | --- |
| `@effect/sql-mysql2` | 4.1.2 | MIT |
| `mysql2` | 3.24.6 | MIT |
| `aws-ssl-profiles` | 1.1.2 | MIT |
| `generate-function` | 2.3.1 | MIT |
| `is-property` | 1.0.2 | MIT |
| `iconv-lite` | 0.7.3 | MIT |
| `safer-buffer` | 2.1.2 | MIT |
| `lru.min` | 1.1.5 | MIT |
| `named-placeholders` | 1.1.6 | MIT |
| `sql-escaper` | 1.5.2 | MIT |
| `long` | 5.3.2 | Apache-2.0 |

**The pin.** The root `package.json` pins `sql-escaper` at 1.5.2
(`"overrides"`). `mysql2`'s range (`^1.5.1`) would take a release of the
last days, and new code in the escape of SQL text waits the root
`AGENTS.md`'s 14 days ("Be modular"). The pin goes when `mysql2`'s own
range starts at a version that the registry has had for 14 days, or when
the package moves to a `mysql2` that needs a newer one.

## The servers of the checks

`packages/mariadb/tests/server.ts` starts a private MariaDB server for a
test, from a server's Nix output path (`start(server, under)`):

- in a new directory under the one that the caller gives (the test's
  temporary directory), with its data, its logs and its temporary files
  inside it;
- on a socket file in that directory, with no TCP port
  (`--skip-networking`), and with no option file of the machine
  (`--no-defaults`);
- as a server whose root has no password and reaches only the socket.

It gives the socket's path, the version, `query`, which runs SQL as root
with the server's own client, and `stop`. `serverPaths` reads the servers'
paths from `EVERCHAT_MARIADB`, separated by spaces.

A test of the package that needs a server imports the helper from
`../tests/server.ts`, runs its cases for each path of `EVERCHAT_MARIADB`,
and skips them, with a name that says so, when the variable is not set
(the unit tier, the scoped check). `just test-mariadb` gives the two pinned
servers, 10.11 and 11.8, from Nix, and runs every test of the package.

The helper's rule: no server and no client outlives its test. The kernel
kills the server, and each run of the server's client, when the process
that started it dies, also by SIGKILL (`setpriv --pdeathsig`); the
installer of the data directory runs in a process group of its own, under a
watcher that kills the group at the caller's end. A test stops each server
that it started, in a `finally`. The head of the helper holds the whole
rule and the closed list of the processes that it starts.

## The schema's files

The schema of the store on MariaDB at the mark 8 (`docs/schema.html`) is a
set of files at the root of the repository, not in the package:

- `schema/mariadb/` is `skeema`'s tree, and holds only what `skeema` reads.
  `schema/mariadb/.skeema` names the server by the variables of the
  administrator's environment (`host=$EVERCHAT_DB_HOST`,
  `port=$EVERCHAT_DB_PORT`, `user=$EVERCHAT_DB_USER`), with no `flavor`:
  `skeema` reads it from the server, and a hosted deployment's version is
  not the repository's to name. `schema/mariadb/everchat/.skeema` names the
  schema (`schema=$EVERCHAT_DB_SCHEMA`, `temp-schema=$EVERCHAT_SKEEMA_TMP`),
  its character set and collation, and `ignore-table`, which leaves alone
  each table whose name does not start with `everchat_` (a hosted
  deployment may share the schema with other tables). Its three lint lines
  each state a choice of the page: `allow-charset=utf8mb4,ascii` (the
  character set of `sender_key`), `allow-auto-inc=bigint` (the ids, a
  `bigint auto_increment`) and `lint-reserved-word=ignore` (the column
  `call`, which a statement always quotes). No file names a host, a port, a
  user, a schema or a password.
- `schema/mariadb/everchat/everchat_<table>.sql`, one for each table: its
  bytes are the server's `show create table` text of the table in a fresh
  schema, then `;` and one newline, and nothing else (no comment, no `use`,
  no second statement): the form that `skeema format` writes. The text is
  the same on 10.11 and on 11.8, since each table states its collation:
  `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin
  ROW_FORMAT=DYNAMIC`. Each reference is named
  `everchat_<table>_<column>_fk`, with the index that the server adds for
  it written out; each check `everchat_<table>_ck<n>`, n from 1 in the
  order of the table's checks in the page's section 8 that have one here.
  SQLite's checks of an id's 16 bytes (`everchat_tenant.id`,
  `everchat_chat.uuid`) have none, a difference from SQLite: on MariaDB the
  schema does not hold an id's 16 bytes. A value of more than 16 bytes is
  refused; a shorter one is stored with zero bytes after it, with no error,
  and a check cannot see it. The length is held by the store's edge, which
  makes each id from a UUID before a statement. No view, no trigger.
- `schema/mariadb-admin/` holds the administrator's statements that are
  rows or rights, beside `skeema`'s tree (whose `lint` warns of a file of
  rows): today `seed.sql`, the 8 rows of `everchat_kind` (the ids and names
  of `KINDS`). It names no schema (the administrator's client does), and it
  can run again: it adds each row that is not there, changes no row that
  is, and gives no error. It is no `insert ignore` (which cuts a text with
  no error), no `replace` and no upsert.

An administrator applies them: `skeema push` in `schema/mariadb/`, then the
seed. The server build never changes the schema. No `.sql` file is under
`packages/`: Bun runs a `.sql` file as code when a file loads it in some
ways, so `tools/graph.ts` has no rule for one, a `.sql` file under a
package is a fault of `just check`, and no file of a package names one by
an import.
A test reads the files by their path from the root (`tests/schema.ts`).

**A change of the schema** (`packages/sqlite/src/schema.ts`,
`docs/schema.html`) **changes the files of `schema/mariadb/` in the same
batch**. The comparisons of `src/tables.test.ts` (with the page's column
tables, and with SQLite's schema made in memory) fail until it does for a
change of:

- the tables, their names and their order;
- the columns, in order, with their MariaDB types (the page's column
  tables), `not null` and their defaults;
- the primary keys;
- the unique keys and the plain indexes, by name and columns in order;
- the references, with their columns and their rules (`on delete`,
  `on update`);
- the checks' expressions, in a normal form, in their order;
- the generated column's expression, as the page writes it.

The differences that the comparisons name (in `src/tables.test.ts`, each
with its reason) are not compared: the `not null` of a rowid's column, the
names of SQLite's own keys of a `unique`, the server's index of a
reference, and SQLite's two checks of an id's 16 bytes. A person still
reads by eye, at a change of the schema, each named difference and the
page's words on the two texts ("Two DDL texts").

## The start's check

The server build never changes the schema: an administrator applies the
files. What keeps a build from work on a schema that is not its own is
`check(texts)` (`src/check.ts`), which the store's layer will run at its
build: an effect that needs `effect`'s `SqlClient`, ends with nothing when
the schema that the client's connection uses is the files', and fails with
`WrongSchema` when it is not. Another failure of a statement is the
driver's `SqlError`, passed on.

- **The texts.** The caller gives the text of each table's file by the
  table's name; the module reads no file and imports none. A name of
  `TABLES` with no text, and a text of a name that is not in `TABLES`, are
  each a difference: the build that calls the check is wrong.
- **What it reads.** First `show full tables`, the kinds of the schema's
  objects, of which it keeps the names that start with `everchat_` (compared
  in the code: `_` is a wildcard of `like`); then `show create table` of
  each name of `TABLES` that is not there as something other than a table;
  then `select id, name from everchat_kind order by id limit 257`, whenever
  that table is there as a table and the server's text of it has a column
  `id` and a column `name`, also when the text is not the file's: the lines'
  differences and the rows' are then both in the error. A row's id and name
  are texts in a difference, of any column's type (a number by its digits,
  bytes as `0x` and hex digits), compared whole, no row lost, and cut at 64
  characters with `…`; 257 rows, more than a `tinyint` id can number, are
  one difference, and no row is compared. With one of the two
  columns not there, the rows are not read, and the lines name why. Nothing
  of `information_schema`, whose answer depends on the version and on the
  grant. It writes nothing, and needs `SELECT` alone: a user with `SELECT`
  and no other right gets the same answer as root.
- **A name of the list that is not a table.** A view, a sequence or another
  kind of object at a name of `TABLES` is one difference, `NotATable`, which
  says what stands there by a word of the code's list (a view, a sequence,
  something else), and no text of it goes into the error: a view's text
  names its definer, a user and a host. The check sends no `show create
  table` for such a name, and its comparison takes as no table's text one
  whose first line is not that name's `CREATE TABLE` line, or whose options
  mark a sequence (`SEQUENCE=`, outside a quoted text): a sequence's text
  starts as a table's.
- **The session.** The server's text depends on `sql_mode` and
  `sql_quote_show_create`. The check runs each statement on one connection
  of the pool, reads the two values, sets `sql_mode = 'STRICT_ALL_TABLES'`
  and `sql_quote_show_create = 1`, and sets the two back to what they were
  at its end, on a failure and on an interruption too.
- **The comparison.** The file's text less its last `;` and newline,
  against the server's less ` AUTO_INCREMENT=<n>` (added once a table has
  rows). When they differ, each text is cut into lines, each keyed by its
  first word: a column by its name, the primary key, a key by its name, a
  reference and a check by their names, and the last line (the options).
  No parser of SQL.
- **What a difference names.** A table that is missing or on which the user
  has no right (errors 1146 and 1142: one word for both); a line of the
  file that the server lacks, a line of the server that the file lacks, a
  line of both with another text, or a line at another place (the order of
  the columns and of the keys is part of the schema), each with its table,
  what the line is, its name, its number in the file where the file has it,
  and the two texts; a table or a view of the prefix that is not in
  `TABLES`; a row of `everchat_kind` that is missing, has another name or
  is one more than `KINDS` (`@everchat/core/store`), with the id and the
  two names. Two texts that differ only in a line's indent or comma are one
  difference of the whole text.
- **All at once.** The error holds every difference, in the order of
  `TABLES`, then the tables of the prefix, then the rows of the kinds, then
  the caller's texts; its message has one line for each. It holds lines of
  the files and of the server's texts of those tables, names, and a kind's
  id and name: no other text of a row, no value of the session, no user and
  no host.
- **What it does not see.** A table on which the user has no right shows as
  missing, and is not in `show full tables`. A table or a view of another
  prefix is not read: a hosted deployment may share the schema with the
  tables of the product. The prefix is compared as it is written, so a table
  of the prefix in another case of letters (`EVERCHAT_X`, on a server that
  keeps the case of names) is not read either. A view of the prefix is a
  difference: MariaDB has none in the first version. A trigger on a listed
  table is not seen: `show create table` and `show full tables` do not show
  it (a review's probe made a `before insert` trigger on `everchat_kind`,
  and the check found no difference, on both versions); the store's user has
  no right to make one, and the files hold none. A table's `AUTO_INCREMENT=`
  option is not compared, by design: rows move it. It reads no seed: the
  rows are `KINDS`.

## Its check

The scoped check of the package (the root `AGENTS.md`, "Checks"):
`just scoped packages/mariadb/src/check.test.ts
packages/mariadb/src/client.test.ts packages/mariadb/src/tables.test.ts
packages/mariadb/tests/server.test.ts`, where the cases on a server skip.
`just check` checks the types of its program. `just test-mariadb` runs them
all on the two servers.
