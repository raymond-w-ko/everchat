# The store on PostgreSQL, MySQL or MariaDB, and tenancy

What would it take for the store to keep many chats, of many tenants, in one
server database (PostgreSQL, MySQL or MariaDB) on AWS, while the local chat
stays one SQLite file? What binds the store to SQLite, what Effect 4 and Bun
give, four ways to separate tenants, what shared tables need, and the
credentials. It decides nothing. Runs: under `/tmp/ec-unda/` with PGlite
0.5.16 (PostgreSQL 18.6, in-process) on Bun 1.4.4; no MySQL or MariaDB server.
Other documents: `docs/research/runtime.md` (the process),
`docs/research/agents.md` (load, lease), `docs/research/functions.md`.

## Today

The store is one module over Effect's `SqlClient`, on one SQLite file per chat.

| What binds it to SQLite | Where |
|---|---|
| The driver is `@effect/sql-sqlite-bun` (`bun:sqlite`), the only database package | `src/database.ts:21`, `package.json` |
| The driver sets WAL, a 5 s busy wait, and `BEGIN IMMEDIATE` for each transaction | `src/database.ts:8` |
| Pragmas `synchronous = full` and `foreign_keys = on` | `src/database.ts:33`, `src/database.ts:34` |
| All pending migrations run in one transaction (Effect's migrator) | `src/database.ts:18`, `src/database.ts:35` |
| `Reads` opens a second, read-only connection; WAL lets it read while the launch writes | `src/database.ts:55`, `src/store.ts:22` |
| `Reads.version` is `pragma data_version` (the inspector polls it to see a change) | `src/store.ts:847` |
| A chat is a file: the home holds `everchat.db` | `src/database.ts:27`, `src/main.ts:223` |
| "One launch owns the file": the check of a live launch is by pid and host | `src/store.ts:911`, `src/store.ts:922` |
| `chat` has exactly one row (`check (id = 1)`) | `src/migrations.ts:46` |

SQL that another dialect does not take as it is:

| SQL | Where | PostgreSQL (run on PGlite) | MySQL 8.4 / MariaDB |
|---|---|---|---|
| `strict` and `without rowid` on each table | `src/migrations.ts:42`, `src/migrations.ts:198` | syntax error, each of 18 tables | not valid (no such option) |
| `integer primary key` makes the id (rowid alias) | `src/migrations.ts:35`, `src/store.ts:946` | no id is made: "null value in column id" | needs `auto_increment` |
| Times in ms in `integer` | `src/migrations.ts:40`, `src/store.ts:19` | "out of range for type integer" (32 bits) | `int` is 32 bits too: use `bigint` |
| `agent.turn` references `turn`, made after it | `src/migrations.ts:95` | "relation turn does not exist" | the same order problem |
| Triggers with `raise(abort, ...)` for append-only tables | `src/migrations.ts:28` | needs a PL/pgSQL function (ran) | needs `SIGNAL` (not proved) |
| `blob` | `src/migrations.ts:180` | no type `blob`: `bytea` | `longblob` |
| Unique partial index `launch_live ... ((1)) where ended is null` | `src/migrations.ts:69` | ran as it is | no partial index |
| Partial indexes `call_vendor`, `call_parent`, `call_running`, `turn_running` | `src/migrations.ts:119`, `src/migrations.ts:151` | ran | no partial index |
| `datetime(m.created / 1000, 'unixepoch')` in view `msg_read` | `src/migrations.ts:267` | "function datetime does not exist" | not valid |
| `insert ... returning id`; `delete ... returning seq` | `src/store.ts:946`, `src/store.ts:1059`, `src/store.ts:1115`, `src/store.ts:1151`; `src/store.ts:1185` | `insert` ran; `delete` not run | MySQL: no `returning`; MariaDB: `insert`/`delete ... returning` (not proved) |
| `on conflict do nothing`, `on conflict (name) do update set ... excluded.` | `src/store.ts:899`, `src/store.ts:1046`, `src/store.ts:1073` | ran | `insert ignore`, `on duplicate key update` |
| `?` markers in raw `sql.unsafe` SQL, e.g. `(l, i) in (values (?, ?), ...)` | `src/store.ts:661`, `src/store.ts:714`, `src/store.ts:752`, `src/store.ts:758`, `src/store.ts:815` | fails: "syntax error at or near ","" (42601); only a copy with `$1::integer, $2::integer` ran | MySQL takes `?` (row values: not proved) |
| Next id as `coalesce(max(i), -1) + 1` in the transaction | `src/store.ts:653`, `src/store.ts:1129` | safe only with one writer per chat | the same |
| 10,000 keys per query, for SQLite's 32,766 values | `src/store.ts:478` | other limit (not proved) | other limit (not proved) |
| A lone surrogate is written as U+FFFD, so text is made well formed | `src/store.ts:16` | keep it | keep it |

The store uses no JSON function of SQL: it writes JSON as text
(`src/store.ts:1040`). The row decoders read numbers as `Schema.Int`
(`src/store.ts:337`). `@effect/sql-pg` gives a `bigint` column as a JS
`bigint` (run: `typeof id` printed `bigint`), so each decoder of a `bigint`
column needs a change, or a type parser.

## Facts

Effect 4 and Bun:

- `@effect/sql-pg` and `@effect/sql-mysql2` have a 4.1.2 that needs `effect ^4.1.2`; the latest is 4.1.4, which needs `effect ^4.1.4`. https://registry.npmjs.org/@effect/sql-pg/4.1.2 , https://registry.npmjs.org/@effect/sql-mysql2/4.1.2
- `@effect/sql-pg` 4.1.2 has its own wire client (no `pg` package). It has MD5 and SCRAM-SHA-256, a pool, `LISTEN` and `NOTIFY`, and `multiplex`. Its `password` is a `Redacted` "or an Effect evaluated for each connection attempt". `prepare: false` is for poolers that drop named statements. Source: its `src/PgClient.ts` and `src/PgAuth.ts` in the package. https://registry.npmjs.org/@effect/sql-pg/4.1.2
- Run: `@effect/sql-pg` 4.1.2 on Bun 1.4.4 connected over TCP to PGlite's socket server, ran `select`, a transaction and `insert ... returning id`.
- `@effect/sql-mysql2` 4.1.2 wraps `mysql2 ^3.24.6`. Its `password` is a static `Redacted` only. Its compiler drops `returning` (`onRecordUpdate` gives an empty string). Source: its `src/MysqlClient.ts`. https://registry.npmjs.org/@effect/sql-mysql2/4.1.2
- No `@effect/sql-mariadb` package is on npm; MariaDB goes through `mysql2` (not proved by a run). https://registry.npmjs.org/@effect/sql-mariadb
- Effect's migrator locks its table on PostgreSQL (`LOCK TABLE ... IN ACCESS EXCLUSIVE MODE`), and runs the pending migrations in one transaction. Source: `effect/src/sql/Migrator.ts` in `effect` 4.1.2.
- MySQL commits before each DDL statement: they "implicitly end any transaction active in the current session". So on MySQL, a failed migration can leave the schema half changed. https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
- The statement compiler of Effect knows `sqlite`, `pg`, `mysql`, `mssql` and `clickhouse`, and `sql.onDialectOrElse` picks SQL by dialect. It makes a dialect's bind marker only for a parameter of a template (`${x}`); the text of `sql.unsafe` goes out as it is (`Statement.ts:989`). Source: `effect/src/sql/Statement.ts` in the checkout's `node_modules`.
- PostgreSQL parameters are referred to "by position, using `$1`, `$2`, etc."; `?` is not a marker. https://www.postgresql.org/docs/current/sql-prepare.html
- Run (review ec-wh0e, reproduced here): Effect's PG compiler gave the raw text with `?` unchanged; PGlite refused it (42601).
- `@effect/sql-kysely` (0.48.0) and `@effect/sql-drizzle` (0.51.0) need `effect ^3.22.0`: there is no version for Effect 4. https://registry.npmjs.org/@effect/sql-kysely , https://registry.npmjs.org/@effect/sql-drizzle
- Kysely has core dialects for PostgreSQL, MySQL, MSSQL, SQLite and PGlite. https://kysely.dev/docs/dialects
- Bun's `Bun.SQL` "supports PostgreSQL, MySQL, MariaDB, and SQLite", has a pool, and takes a password as a function, "at connection time". No Effect layer wraps it (not proved: none found). https://bun.com/docs/runtime/sql

SQLite, MySQL and MariaDB syntax:

- `STRICT` is an SQLite table option since 3.37.0. A one-column `INTEGER` primary key "becomes an alias for the rowid", and a NULL there gets a value. https://www.sqlite.org/stricttables.html , https://www.sqlite.org/lang_createtable.html
- MySQL 8.4 `CREATE INDEX` has no `WHERE`. Its `INSERT` has no `RETURNING`; the upsert is `ON DUPLICATE KEY UPDATE`. https://dev.mysql.com/doc/refman/8.4/en/create-index.html , https://dev.mysql.com/doc/refman/8.4/en/insert.html
- MariaDB has `INSERT ... RETURNING` (since which version: not proved from this page). https://mariadb.com/kb/en/insertreturning/

Tenancy limits:

- Claim (a) is correct. AWS: "We recommend having fewer than 10,000 tables total across all of the databases in a DB instance." The same section says "MySQL has no limit on the number of tables". The cause is the work of opening and closing table files. MariaDB has the same text ("fewer than ten thousand tables"). The PostgreSQL section gives no count. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html
- InnoDB makes a file per table by default; "mysqld must keep an open file handle for each file-per-table tablespace". `table_open_cache` defaults to 4000, `max_connections` to 151, with a thread for each connection. https://dev.mysql.com/doc/refman/8.4/en/innodb-file-per-table-tablespaces.html , https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html
- Claim (b) is correct. The finest MySQL privilege is a column; MariaDB: "globally, for an entire database, for a table or routine, or for individual columns". A view with `SQL SECURITY DEFINER` is the usual way around this. https://dev.mysql.com/doc/refman/8.4/en/privileges-provided.html , https://mariadb.com/kb/en/grant/
- PostgreSQL row-level security: with no policy, "a default-deny policy is used". Superusers and `BYPASSRLS` roles always bypass it; a table owner bypasses it unless `FORCE ROW LEVEL SECURITY`. https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Run: a policy `chat = current_setting('app.chat', true)::bigint`, with `set_config(..., true)` in the transaction, gave a role only its chat's rows. A write to another chat failed ("violates row-level security policy"), and no setting failed the query. The superuser saw all rows, also with `FORCE`.
- PostgreSQL limits: 4,294,950,911 databases, 1,431,650,303 relations per database, but "practical limits ... may apply before absolute hard limits". https://www.postgresql.org/docs/current/limits.html
- A PostgreSQL connection reaches one database only: "It is not possible to access more than one database per connection." Each connection is a process; `max_connections` is "typically 100". https://www.postgresql.org/docs/current/manage-ag-overview.html , https://www.postgresql.org/docs/current/runtime-config-connection.html
- Schemas let "many users ... use one database without interfering"; `search_path` picks the schema of an unqualified name. https://www.postgresql.org/docs/current/ddl-schemas.html
- Autovacuum tries one worker in each database each `autovacuum_naptime`: with N databases, a worker starts each naptime/N. https://www.postgresql.org/docs/current/routine-vacuuming.html
- `CREATE DATABASE` copies `template1`. `pg_dump` dumps one database, or one schema with `-n`; `mysqldump` takes one database. https://www.postgresql.org/docs/current/manage-ag-templatedbs.html , https://www.postgresql.org/docs/current/app-pgdump.html , https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html
- RDS default `max_connections`: MySQL `DBInstanceClassMemory/12582880`; MariaDB 10.5+ `LEAST(DBInstanceClassMemory/25165760, 12000)`; PostgreSQL `LEAST(DBInstanceClassMemory/9531392, 5000)`. The quotas page gives no limit of databases or tables for these engines. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html

Credentials on AWS:

- IAM database authentication works with MariaDB, MySQL and PostgreSQL. A token lives 15 minutes and is used only to open a connection. It needs 300 to 1000 MiB more memory on the database. The old advice of fewer than 200 new connections each second: not proved on the current page. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html
- RDS Proxy pools connections and signs in with IAM or with Secrets Manager secrets, at most 200 secrets for each proxy. It pins a session (no more sharing) on prepared statements, temporary tables and `SET`; on PostgreSQL also on `LISTEN` and session advisory locks. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html , https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html
- Whether RDS Proxy pins on protocol-level named statements, as `@effect/sql-pg` makes by default: not proved.
- Secrets Manager rotation: single user has "a low risk of the database denying calls that use the rotated credentials", fixed by a retry. With alternating users, both users are valid after a rotation. An RDS-managed master password rotates "every seven days by default". https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotation-strategy.html , https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html
- AWS recommends a cache of secrets, updated "only when required". https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html
- Effect's `Redacted` "shows a redacted placeholder in string, JSON, and inspection output". Source: `effect/src/Redacted.ts`.

## Options

### A. How the store reaches more than one dialect

| Option | Gives | Costs | Rules out |
|---|---|---|---|
| A1. One `Store` service; a layer for each dialect (`SqliteClient`, `PgClient`, `MysqlClient`); shared SQL, `sql.onDialectOrElse` for the few differences | No new package; keeps "use Effect's own modules"; the store stays the only SQL module | Each query is checked in each dialect by tests; `returning` and upserts need branches for MySQL | Nothing |
| A2. A query builder (Kysely, Drizzle) under the store | One query text for many dialects; typed queries | No Effect 4 bridge today: hand-made glue; a second model of rows next to `Schema`; triggers and partial indexes still by hand | Effect's migrator, unless glued |
| A3. `Bun.SQL` under a hand-made `SqlClient` | One client for all four databases; password function | Writing and keeping a driver layer; Effect's spans and errors by hand | Nothing, but it is the most new code |

A1 needs one change of the queries first: the raw `?` sites (`turnRows` at
`src/store.ts:661`, and its callers; `src/store.ts:714`, `src/store.ts:752`,
`src/store.ts:758`, `src/store.ts:815`) become template parameters or
fragments (`sql.in`, `sql.and`), so that the compiler writes `$n` or `?`.

Migrations for more than one dialect: one list for each dialect (`0001_schema`
for SQLite stays as it is, since "Never change a migration that a database may
have run", `src/migrations.ts:8`), and the same numbers and names in each list,
so that `Database.VERSION` (`src/database.ts:41`) means the same in each.

### B. Tenancy

Unit for each row: one tenant with one chat. 18 tables, plus
`effect_sql_migrations`, make 19 tables for each chat.

| | B1. A database for each chat, with its own user | B2. A schema for each chat (PostgreSQL) | B3. Shared tables, a `chat` key | B4. Hybrid: B3 first, B1 for some tenants |
|---|---|---|---|---|
| Isolation | Grants: strong | Grants on the schema: strong | PostgreSQL: row-level security as a second wall; MySQL: only the program's own `where` | B3's, and B1's for the chosen tenants |
| Limit on RDS MySQL/MariaDB | 10,000 tables / 19 = about 520 chats for each instance (guidance) | MySQL has no schemas apart from databases: the same as B1 | Tables do not grow with chats | B3's |
| Limit on PostgreSQL | No count limit; autovacuum visits each database; a pool for each database | No count limit documented; catalog grows with 19 tables, their indexes and TOAST tables per chat (size not proved) | Rows only | B3's |
| Cost of an idle chat | Its catalog and files; a connection only when loaded, but no pool is shared | Its catalog; `SET search_path` pins RDS Proxy | Rows on disk only | B3's |
| Backup and move of one chat | `pg_dump` / `mysqldump` of one database | `pg_dump -n` | A `where chat = ?` export, by the program | Move between B3 and B1 by the program |
| Remove one tenant | `drop database` | `drop schema ... cascade` | Not by `delete`: `msg`, `node`, `agent_msg` refuse it (append-only triggers); needs a privileged erasure path, or is not supported | B1's, or B3's |
| Noisy neighbour | Same instance: shares CPU, I/O, WAL | Same | Same, and shared indexes | Move the noisy tenant to B1 |
| Migrations | Once for each database: N runs, N failure points | Once for each schema: N runs | One run for all | Two kinds of run |
| Connections | One database for each connection (PostgreSQL) | One pool for all, with `search_path` per transaction | One pool for all | Two kinds of pool |

### C. What shared tables (B3) need from the schema

The rule for all: each table of a chat gets a `chat` column, also where a
parent key already gives the chat. Row-level security reads one column, and
export of a chat becomes one `where` for each table (removal does not: see
the hard cases). Times and ids become `bigint`.

| Table | Chat key | The primary key, and the hard part |
|---|---|---|
| `pick` | none: a shared lookup | `unique (vendor, model, effort, speed)` stays |
| `kind` | none: a shared constant | stays |
| `chat` | is the key | `check (id = 1)` goes; `id bigint`, `uuid` unique, a `tenant` column |
| `launch` | yes | `launch_live` becomes `unique (chat) where ended is null`; MySQL needs another form. The pid and host check becomes a lease (`docs/research/agents.md`) |
| `head` | yes | `unique (chat, hash)`. Shared across chats would save space, but its body has a tenant's own text |
| `agent` | yes | `unique (chat, name)` |
| `turn`, `call`, `usage`, `log` | yes | an id from the database (identity) works, with `chat` beside it; partial indexes gain `chat` |
| `turn_item` | yes | `(turn, n)` stays |
| `msg` | yes | `(chat, i)`: `i` is 0, 1, 2, ... in each chat, and the tree uses it (node `(l, i)` covers messages from i·2^l) |
| `msg_image` | yes | `(chat, msg, n)`, its reference `(chat, msg)` to `msg (chat, i)` |
| `node` | yes | `(chat, l, i)` |
| `view` | yes | `(chat, name)` |
| `agent_msg` | yes | `(agent, i)` stays |
| `image` | yes | `unique (chat, name)`; `bytes` in `bytea` / `longblob`, or out of the database (an object store), which breaks "state lives in the database" |
| `image_original` | yes | `(image)` stays |

Hard cases:

- Ids made by the database are unique in one database only. A move of a chat
  between databases (B3 to B1, or SQLite to a server) must change each id and
  each reference. Keys of the form `(chat, n)` for all tables avoid this; the
  program then makes each `n`, as `append` does now (`src/store.ts:653`).
- `coalesce(max(i), -1) + 1` is correct only with one writer for each chat. In
  SQLite, `BEGIN IMMEDIATE` makes this true. On a server, two processes of one
  chat would make the same `i`; the second fails on the key. The lease must
  make sure that only one process writes a chat.
- Each reference must stay in its chat; row-level security does not check
  it: "foreign key references, always bypass row security". Run (ec-wh0e): a
  role of chat 1 inserted a child that references a hidden parent of chat 2.
  Run here: a key `(chat, parent)` to the parent's `unique (chat, id)` refused
  it (23503), and took a same-chat one. So each reference gains `chat`:
  `turn_item.turn`, `agent_msg.agent`/`.turn`/`.call`, `image_original.image`,
  `msg_image`, `turn.agent`/`.launch`/`.head`, `agent.turn`, `call.turn`/
  `.parent`/`.launch`, `msg.turn`/`.call`/`.launch`, `usage.turn`, `log.launch`.
  https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Removal of a tenant: `msg`, `node` and `agent_msg` refuse a delete
  (`src/migrations.ts:169`, `src/migrations.ts:210`, `src/migrations.ts:234`),
  as "a message ... is never deleted" (`GLOSSARY.md:21`) says; the order of
  deletes cannot change that, and `agent.turn` and `turn.agent` reference
  each other (`src/migrations.ts:95`, `src/migrations.ts:108`). Options: no
  erasure; or one privileged path (a role that may disable the triggers for one
  chat, in one transaction), never the normal writes.
- `dropDiagnostics` deletes by time over the whole table (`src/store.ts:1185`).
  With shared tables it must name the chat, or be a task of the operator.
- `Reads` today is "a connection that cannot write". On a server this becomes a
  database user with only `select`, and row-level security for its chat.
- `pragma data_version` (`src/store.ts:847`) has no match; a server needs a
  counter column, or `LISTEN`/`NOTIFY` on PostgreSQL.

Rules that change: in `AGENTS.md`, "All state in one SQLite file": "One chat
is one database", "Do not put two chats in one database", and "an install is
one to three files" (`AGENTS.md:476`, `AGENTS.md:486`). In `GLOSSARY.md`:
chat ("One chat is one database in one home"), home, database ("The one SQLite
file"), store (the read-only connection), launch ("At most one launch of a
chat is live" stays, but the check changes), inspector, and log ("never
deleted", `GLOSSARY.md:21`) if a tenant can be erased.

### D. Database credentials on AWS

| Option | Gives | Costs |
|---|---|---|
| D1. A Secrets Manager secret, read at start | One user for each process; rotation by AWS | A retry when a rotation denies a connection; the process reads the secret again then |
| D2. IAM database authentication | No password stored; the process role signs a token | A new token each 15 minutes for new connections; more memory on the database |
| D3. RDS Proxy in front (with D1 or D2) | Many processes share few database connections | Pinning on `SET`, prepared statements and `LISTEN`; at most 200 secrets for each proxy |

Where the credential lives in the program: the config file or the environment
names the secret (its ARN) or the IAM role, never the value. The value lives
only in memory, as `Redacted`, inside the database layer. `@effect/sql-pg`
takes `password` as an Effect run for each connection attempt, so a fresh
token or a refreshed secret needs no new layer. `@effect/sql-mysql2` takes only
a static value, so a rotation there means a new pool (not proved otherwise).
The rule of `AGENTS.md:437` (not printed, not logged, not in the database)
holds; a test must prove that `StoreError.cause` and the `log` table never
hold it.

## What fits, what does not

- Take PostgreSQL first, and B3 (shared tables) with row-level security,
  on two conditions: every reference is chat-qualified (row-level security does
  not check references), and the erasure of a tenant is decided first. B3 has
  no table count that grows with chats, one migration run, and one pool. Many
  idle chats then cost only rows. MySQL and MariaDB give no row-level security.
- B1 on RDS MySQL or MariaDB does not fit the many idle chats: AWS's guidance
  stops at about 520 chats for each instance with 19 tables. B2 fits a few
  hundred chats, but each migration runs once for each chat, and
  `search_path` pins RDS Proxy.
- Keep B4 as the way out: a tenant that needs its own database gets the same
  schema in a database of its own. Keys of the form `(chat, n)` make this move
  a copy, not a rewrite.
- Take A1: one `Store`, a layer for each dialect, `onDialectOrElse` for the
  differences, after the raw `?` sites become template parameters. A2 has no
  Effect 4 bridge, and A3 is a driver to write.
- MySQL or MariaDB is second. Each DDL statement commits, so a failed migration
  leaves a half-changed schema; there are no partial indexes; and isolation is
  only the program's `where`.
- One code path for queries: the local SQLite file gets the same `chat`
  column, always 1. This needs a migration that makes each table again (SQLite
  cannot change a primary key), which is the largest single cost of one path.
- Tests: PGlite runs in the test process and speaks the wire protocol
  (`pglite-socket`), so `@effect/sql-pg` can be tested with no service to
  start. MySQL or MariaDB needs a real server for each check (a container or a
  binary), so a check would have to start one.

## Limits

- No row-level security in MySQL or MariaDB: with shared tables, a bug in one
  `where` shows one tenant's data to another.
- MySQL migrations cannot be one transaction: DDL commits.
- B1 on RDS MySQL/MariaDB: about 520 chats for each instance before AWS's
  guidance. More means more instances.
- A database for each chat on PostgreSQL cannot share a pool: a connection
  reaches one database.
- The superuser and the table owner (without `FORCE`) bypass row-level
  security: the program must connect as a role that owns nothing.
- Images in the database make the shared tables large; out of the database,
  they break "state lives in the database".
- An RDS Proxy pins on `LISTEN`: an event channel on PostgreSQL needs its own
  connection, not the proxy (`docs/research/agents.md` for events).

## Questions for the operator

1. Which server database? Recommended: PostgreSQL (RDS or Aurora), for
   row-level security and transactional migrations.
2. Which tenancy? Recommended: shared tables with a `chat` key and row-level
   security (B3), and a dedicated database for a tenant that asks (B4).
3. Keys: ids made by the database, or `(chat, n)` made by the program?
   Recommended: `(chat, n)`, so that a chat can move whole.
4. Does the local SQLite file take the `chat` column too, for one code path?
   Recommended: yes, in one migration that makes each table again.
5. Can a tenant have more than one chat? Recommended: yes in the schema
   (`chat.tenant`), one chat for each person at first.
6. Images: in the database, or in an object store? Recommended: in the
   database at first, with a size limit, and measure.
7. Credentials: Secrets Manager or IAM database authentication, and RDS Proxy
   or not? Recommended: IAM authentication with a token for each connection,
   no proxy until the count of processes needs one.
8. Must a check start a PostgreSQL server? Recommended: no; PGlite in the test
   process, and a real server only in a separate, rarer check.
9. What is the removal of a tenant, against "a message ... is never deleted"?
   Recommended: no erasure in the first version (a tenant is closed, its rows
   kept); if law or contract needs it, one privileged erasure path, tested.

## Words

| Word | Meaning |
|---|---|
| tenant | A person or a team of a company deployment. It owns one or more chats. Not an agent (`GLOSSARY.md`: a helper that EverChat starts). |
| company deployment | EverChat run for many tenants, on a server database, with many chats that are idle most of the time. |
| dialect | The SQL of one database product (SQLite, PostgreSQL, MySQL). |
| shared tables | One set of tables for all chats, each row with its chat's key. |
| row-level security | A PostgreSQL rule, on a table, that limits the rows that a role can read and write. |
| pinning | RDS Proxy keeps one database connection for one client session, and shares it no more. |
| lease | A row that says which process writes a chat now, and until when. |
| PGlite | PostgreSQL compiled to WebAssembly, run inside a JS process. |
