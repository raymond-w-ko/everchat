# The store, the ownership and the events on MySQL and MariaDB

MySQL or MariaDB as the first server database, with no feature that only
PostgreSQL has: which of the two, through which client, how shared tables keep
tenants apart with no row-level security, how migrations work when each DDL
statement commits, how one process owns a chat with no advisory lock, and how
events reach a listener in order with no `NOTIFY`. It decides nothing. Runs:
under `/tmp/ec-wdp2/`, MySQL 8.4.11 and MariaDB 11.4.13 from nixpkgs,
throwaway servers on 127.0.0.1 with default settings (Facts, "Binary log by
default"), Bun 1.4.4, `@effect/sql-mysql2` 4.1.2, local disk: times are of
this machine, not of RDS. The operator's decisions replace the "PostgreSQL
first", row-level security, `NOTIFY` and advisory locks of
`docs/research/store.md` and `docs/research/agents.md`; the rest holds.

## Today

| Today (each server's result: run) | Where | MySQL 8.4 | MariaDB 11.4 |
|---|---|---|---|
| Next message id: `coalesce(max(i), -1) + 1` in the transaction | src/store.ts:653 | runs; correct only with one writer for each chat | the same |
| `insert ... returning id` | src/store.ts:946, src/store.ts:1115, src/store.ts:1151 | syntax error | runs |
| `delete ... returning seq` | src/store.ts:1185 | syntax error | runs |
| Raw `?` markers in `sql.unsafe` | src/store.ts:661, src/store.ts:752 | run as they are: `?` is the MySQL compiler's marker | the same |
| `(l, i) in (values (?, ?), ...)` | src/store.ts:714 | syntax error (needs `values row(?, ?)`); `(l, i) in ((?, ?), ...)` runs | runs; the second form too |
| Tables named `call` and `usage` | src/migrations.ts:133, src/migrations.ts:237 | reserved words: syntax error without backticks | the same |
| Append-only triggers, `raise(abort, ...)` | src/migrations.ts:28 | `signal sqlstate '45000'` runs and refuses a delete | the same |
| Partial indexes (`launch_live`, `call_vendor`, `turn_running`) | src/migrations.ts:69, src/migrations.ts:151, src/migrations.ts:119 | syntax error. In place of `launch_live` (run, both): `live tinyint as (if(ended is null, 1, null))` and `unique (chat, live)` refused a second live launch and kept many ended ones (a unique key allows many NULLs) | syntax error; the same replacement runs |
| All pending migrations in one transaction | src/database.ts:18, src/database.ts:35 | DDL commits: see "Facts" for what Effect's migrator then records | the same |
| `pragma data_version` for the inspector | src/store.ts:847 | no match | no match |
| The owner check: pid and host of the open launch | src/store.ts:911, src/store.ts:922 | a lease (below) | the same |
| Row decoders read numbers as `Schema.Int` | src/store.ts:75 | `mysql2` gives a `bigint` as a number up to 2^53, as a string above (run) | the same |

Events today live in one process. The turn loop publishes `TurnEvent`s to an
in-memory `PubSub` (src/turn.ts:108, src/turn.ts:175). A turn's start is only
emitted (src/turn.ts:355); its end updates the `turn` row (src/store.ts:1121)
and is emitted (src/turn.ts:252). An interface reads the log to fill a gap
between events (src/follow.ts:59). No event has a number of its own.

## Facts

Versions (pages read 2026-11-14):

| | MySQL | MariaDB |
|---|---|---|
| Long-term | 8.4 LTS, 9.7 LTS; 8.0 in Oracle Sustaining Support since 2026-04-21. https://www.mysql.com/support/eol-notice.html | 10.6 (to 2026-07-06), 10.11 (2028-02-16), 11.4 (2029-05-29), 11.8 (2028-06-04), 12.3 (2029-06-12). https://mariadb.org/about/#maintenance-policy |
| RDS | 8.4 (standard support to 2029-07-31); 8.0 only in Extended Support; no 9.x: the Database Preview environment (no production use) has 26.10 now, and lists 9.1 to 9.7 and 26.7 as deprecated there. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MySQL.Concepts.VersionMgmt.html | 12.3, 11.8, 11.4, 10.11, 10.6. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MariaDB.Concepts.VersionMgmt.html |
| Aurora | 3.x "wire-compatible with MySQL 8.0.23 or higher"; versions `8.4.mysql_aurora.*`. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Updates.Versions.html | None: Aurora is "compatible with MySQL and PostgreSQL". https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_AuroraOverview.html |

What the store needs ("run": on 8.4.11 and 11.4.13 here):

| | MySQL 8.4 | MariaDB 11.4 |
|---|---|---|
| `returning` | None (run) | `insert` since 10.5, one-table `delete` (run). https://mariadb.com/kb/en/mariadb-1050-release-notes/ , https://mariadb.com/kb/en/delete/ |
| A UUID type | None: `binary(16)` (run) | `uuid` since 10.7, "stored in an index-friendly manner"; no `uuid_to_bin` (run). https://mariadb.com/kb/en/uuid-data-type/ |
| JSON | A type; bad JSON refused (run) | "an alias for `LONGTEXT`" with a `JSON_VALID` check (run). https://mariadb.com/kb/en/json-data-type/ |
| `check` | Enforced since 8.0.16 (run). https://dev.mysql.com/doc/refman/8.0/en/create-table-check-constraints.html | Enforced (run) |
| Expression index | Functional key parts since 8.0.13 (run). https://dev.mysql.com/doc/refman/8.0/en/create-index.html | None (run); an index on a generated column, a "poor man's partial index". https://mariadb.com/kb/en/generated-columns/ |
| `skip locked`, `nowait` | Both (run). https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html | Both (run). https://mariadb.com/kb/en/select/ |
| Shared locking read | `for share`; `lock in share mode` "remains available" (same page) | `lock in share mode` only: `for share` is a syntax error (run) |
| Sequences | None (run) | `create sequence` since 10.3 (run). https://mariadb.com/kb/en/mariadb-1030-release-notes/ |
| `GET_LOCK` | Ends with the session, "not released when transactions commit or roll back"; names up to 64 characters. https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html | Ends with the session (run) |
| DDL in a transaction | "Atomic DDL is not transactional DDL": each DDL commits first (run). Atomic: a statement is "committed ... or is rolled back, even if the server halts", for InnoDB tables only, and not for plugin or `SERVER` statements. https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html | Since 10.6.1, atomic ("succeeds ... or is completely reversed") for listed statements: `CREATE`, `ALTER`, `RENAME`, `DROP` of one table, views, triggers. Only crash-safe: `DROP` of many tables, `DROP DATABASE`, and `CREATE OR REPLACE TABLE` "Before MariaDB 13.2", which drops the old table first. Run (11.4.13, review ec-pphn): a failed `create or replace` left no table. DDL commits (run). https://mariadb.com/kb/en/atomic-ddl/ |
| Isolation, gaps | `REPEATABLE READ` (run); next-key locks, a record and its gap. https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html | `REPEATABLE READ` (run) |
| `innodb_autoinc_lock_mode` | 2, "interleaved" (run); a rollback's values are "lost". https://dev.mysql.com/doc/refman/8.4/en/innodb-auto-increment-handling.html | 1, "consecutive" (run). https://mariadb.com/kb/en/auto_increment-handling-in-innodb/ |
| Binary log by default | On, `ROW` (run) | Off, `MIXED` (run) |

- A consistent read reads "the snapshot established by the first such read in
  that transaction"; a `FOR SHARE` read "blocks until the transaction containing the freshest rows ends". https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html
- "each record in a secondary index contains the primary key columns". https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html
- "Cascaded foreign key actions do not activate triggers" (MariaDB: "Triggers are not activated by foreign key actions"), and cascades "may not be nested more than 15 levels deep".
  https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html , https://mariadb.com/kb/en/trigger-limitations/ , https://dev.mysql.com/doc/refman/8.4/en/ansi-diff-foreign-keys.html
- Cascaded deletes "are handled internally by the InnoDB storage engine, which means that none of the changes are logged" (in an example of a MyISAM replica).
  Run: a cascade of 1 M rows added 288 bytes to MySQL's binary log. https://dev.mysql.com/doc/refman/8.4/en/innodb-and-mysql-replication.html
- With `binlog_order_commits` (default on), "transactions are always committed in the same order as they are written to the binary log". https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html
- A view's `SELECT` "cannot refer to system variables or user-defined variables": no row filter by a session's chat. https://dev.mysql.com/doc/refman/8.4/en/create-view.html
- RDS Proxy, MariaDB and MySQL: "Prepared statements cause the proxy to pin the session", also by "the binary protocol"; `GET_LOCK` pins too. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html
- Debezium reads the binary log, with a connector for MySQL and one for MariaDB. https://debezium.io/documentation/reference/stable/connectors/mysql.html , https://debezium.io/documentation/reference/stable/connectors/mariadb.html

The client (the `.ts` paths are in the packages under `node_modules`):

- `@effect/sql-mysql2` 4.1.2 ran on Bun 1.4.4 against both (run); its latest, 4.1.4, needs `effect ^4.1.4`. https://registry.npmjs.org/@effect/sql-mysql2
- Its dialect is `mysql`, marker `?` (`MysqlClient.ts:499`). Effect knows `sqlite`, `pg`, `mysql`, `mssql`, `clickhouse` (`sql/Statement.ts:101`): `onDialectOrElse` sees MariaDB as `mysql`.
- A statement with no result set gives `[]` (`MysqlClient.ts:288`; run: an `insert` gave `[]`, its `.raw` the server's header).
- It prepares each statement unless `disablePreparedStatements` (`MysqlClient.ts:240`): through RDS Proxy, each connection is pinned.
- No `@effect/sql-mariadb` and no `@effect/sql-bun` (404). https://registry.npmjs.org/@effect/sql-mariadb , https://registry.npmjs.org/@effect/sql-bun
- `Bun.SQL` "supports PostgreSQL, MySQL, MariaDB, and SQLite" (run: a transaction on both); no Effect layer wraps it. https://bun.com/docs/runtime/sql

Effect's migrator (4.1.2) runs all pending migrations in one transaction on each dialect but ClickHouse, and writes their rows first (`sql/Migrator.ts:260`, `sql/Migrator.ts:304`, `sql/Migrator.ts:352`). Run on both: migration 2 made table `b`, inserted a row, then failed on table `c`. After it, `effect_sql_migrations` held 1 and 2, and `b` and the row stayed: the first DDL had committed the migrator's rows.

Sizes (run, `/tmp/ec-wdp2/size.sql`: each table 1 M rows of 200-byte text,
1,000 chats written in turn, `index (turn)`; the `.ibd` file):

| Primary key | MySQL 8.4 | MariaDB 11.4 |
|---|---|---|
| `(tenant binary(16), chat binary(16), i)` | 445 MB | 398 MB |
| `(chat binary(16), i)` | 394 MB | 357 MB |
| `(chat bigint, i)` | 369 MB | 336 MB |
| `id` by `AUTO_INCREMENT`, and `unique (chat, i)`: two secondary indexes, not one | 352 MB | 352 MB |

A chat of `just sample` (200 turns, no model) has 4,850 rows; 16.2 MB of its
18 MB SQLite file are `turn_item` bodies.

Tests: no MySQL in the test process was found. `mysql-memory-server` starts a real `mysqld`; `@adrianfalleiro/mariadb-wasm` 0.1.2 (2026-10-24, GPL-2.0) says it runs MariaDB 11.8.9 as WebAssembly: `not proved` (not run). https://registry.npmjs.org/mysql-memory-server , https://registry.npmjs.org/@adrianfalleiro/mariadb-wasm

## Options

### A. MySQL, MariaDB, or one subset for both

| | A1. One subset for both | A2. MariaDB only | A3. MySQL only |
|---|---|---|---|
| Gives | Either server, RDS for both, Aurora | `returning`, `uuid`, sequences, `if not exists` for indexes and columns (steps that can run twice) | Aurora; functional indexes; `for share` |
| SQL | No `returning`: ids made by the program; `lock in share mode`; `(a, b) in ((?, ?))`; `binary(16)`; a generated column for each expression index | All of A1, and the extras | A1, and functional indexes |
| Costs | Each check on two servers; the features above unused | No Aurora; Effect sees `mysql` (no MariaDB dialect): a branch by `select version()` | No `returning`; a step that can run twice needs a look in `information_schema` first |
| Rules out | Nothing | Aurora MySQL | MariaDB |

### B. Keys and the tenant

Each table of a chat gets the chat's key; `chat` gets `tenant`, with
`foreign key (tenant) references tenant (id) on delete cascade on update
restrict`, and each other table `foreign key (chat) references chat (id)` the
same way. Keys `(chat, n)`, with `n` from the program, as `append` does now.

| | B1. Tenant and chat UUID in each row: `(tenant, chat, n)` | B2. Chat UUID in each row: `(chat, n)`; tenant in `chat` only | B3. A `bigint` chat id: `(chat, n)`; UUID in `chat` only |
|---|---|---|---|
| Size for each row (run: a key and one secondary index; each more index holds the key again) | +76 B (MySQL), +62 B (MariaDB) against B3 | +25 B, +21 B against B3 | the base |
| 100,000 chats like the sample (485 M rows) | +37 GB, +30 GB | +12 GB, +10 GB | the base |
| A chat moves to another database | As it is | As it is | Each id and each reference changes |
| A query for one tenant's chats | One `where tenant = ?` on each table | A join to `chat` | A join to `chat` |
| A wrong `where` | Shows the tenant's other chats, or another tenant's | The same | The same |

The random 16-byte key costs less than a random key usually does: `n` grows
in a chat, so inserts go to one place for each chat that works, not to a
random page each. Run: the load of B2 took about 5% longer than B3.

What keeps one tenant's rows from another with no row-level security:

1. A store bound to one chat when it is made: each statement gets `chat =
   ${key}` from one helper; no store operation takes a chat key from a caller.
2. A test that runs each store operation for chat A with chat B's rows
   present, and fails on any row of B.
3. Each reference names the chat (`store.md`, "Hard cases"); the runners'
   database user has no `drop`, `alter` or `grant`.

The removal of a tenant:

| | One delete, cascade | In parts |
|---|---|---|
| Statement | `delete from tenant where id = ?` | Mark the chats `erasing`; delete each table's rows of each chat, 10,000 at a time, each part its own transaction; then the tenant |
| 1 M rows (run) | 6.7 s (MySQL), 5.6 s (MariaDB), one transaction | 30 s (MySQL), 19 s (MariaDB), 110 parts, the longest 365 ms |
| Locks | Each row, until the end | A part's rows, for one part |
| Append-only triggers | Not fired by the cascade (run): the delete passes | Fire; the trigger lets a delete pass only when the chat is `erasing` (run: refused otherwise) |
| Replica | The binary log holds the parent's delete only (run: +288 bytes); the replica does the cascade itself, about as long | Lag of about one part |

### C. Migrations when DDL commits

| | C1. Effect's migrator as it is | C2. Own steps | C3. Expand, then contract |
|---|---|---|---|
| How | All pending migrations in one transaction | One DDL statement for each step; a step's row is written after the step ran; a named lock (`GET_LOCK('everchat-migrate', ...)`) keeps one runner | Add new tables and columns; the code works with both; remove the old ones in a later release |
| A failed step leaves | The schema half changed, and the failed migration recorded as done (run): the next run skips it | The steps before it done and recorded; the failed step undone only if it is atomic; a crash after a step and before its row leaves it done and not recorded | The same as C2 |
| Needs | Nothing | Steps that can run twice from any partial state: `if not exists` (MariaDB), or a look in `information_schema` (MySQL); no step of MariaDB's only crash-safe statements (above); data in a step of its own, apart from DDL | C2, and two releases for each removal |

### D. Ownership

The lease row and its check, on both servers (run):

```sql
-- take: one row, 1 = taken
update lease set owner = ?, epoch = epoch + 1, until = now(3) + interval 30 second
 where chat = ? and (until < now(3) or owner = ?);
-- the first statement of each write transaction of the owner
select epoch from lease where chat = ? lock in share mode;  -- not my epoch: roll back, unload
-- renew: 0 rows = lost
update lease set until = now(3) + interval 30 second where chat = ? and epoch = ?;
```

The test, run on both: A takes (epoch 1) and writes; A's lease ends while A
is paused; B takes (epoch 2); A wakes and writes: refused. A take waits for a
write in flight to commit (306 ms in the run). The clock is the database's
(`now(3)`). The check cost 0.12 ms for each write transaction (MySQL 1.48 to
1.60 ms, MariaDB 0.58 to 0.70 ms, one connection). The trap: a plain `select`
reads the transaction's snapshot. Run: it gave epoch 1 after B took 2.

| | D1. A lease for each chat | D2. One lease for the deployment | D3. `GET_LOCK` for each chat | D4. Effect's cluster on MySQL |
|---|---|---|---|---|
| Owner | Many runners, each its chats | One active process; a second one waits | Many runners | Shards over runners |
| Fence | The epoch check | The same check on one row | None: a lost session frees the lock at once, and the old owner's other connections still write (run) | Shard locks by `GET_LOCK`, or rows; no epoch (`agents.md`) |
| Cost | One row for each loaded chat, renewed each 10 s | One row; all chats move at a failover | A held session for each lock; pins RDS Proxy | A second message store; `unstable` |
| Rules out | Nothing | More than one machine of work | Pooled connections for the lock | Nothing, with D1's check added |

Effect's cluster storage supports MySQL in 4.1.2: a named lock for each shard
(`SqlRunnerStorage.ts:491`), `wait_timeout` set to the lock's expiry so that a
frozen runner's session closes (`SqlRunnerStorage.ts:159`), or lock rows with
`shardLockDisableAdvisory` (`SqlRunnerStorage.ts:72`); `SqlMessageStorage`
has MySQL branches (`SqlMessageStorage.ts:359`). Run: both made their six
`cluster_*` tables on each server.

### E. Event numbers

| Run: 100 chats at once, back to back | E1. A number for each chat | E2. `AUTO_INCREMENT` for all | E3. One counter row for all |
|---|---|---|---|
| How | `n` in the event's transaction, from the owner (as `append` makes `i`) or `chat.seq + 1` | The table's `id` | `update counter set n = n + 1` in each transaction |
| MySQL | 5,510 /s, p99 27 ms | 6,570 /s, p99 82 ms | 580 /s, p99 276 ms |
| MariaDB | 6,898 /s, p99 25 ms | 7,059 /s, p99 26 ms | 2,704 /s, p99 45 ms |
| Order | Commit order in the chat: one writer, the lease | Not commit order: a higher id can commit first; a rollback leaves a gap (run) | Commit order for all: the row lock holds to the commit |
| A bottleneck | No | No | Yes: all events of all chats wait on one row |

A feed by `id` alone can lose an event: `AUTO_INCREMENT` values are "unique
and monotonically increasing" as they are given, before the commit, with no
word on commit order (Facts), and nothing bounds an open transaction. The
review's case (ec-pphn; run again in `/tmp/ec-mu40/`, both): A inserts id 1,
open; B commits id 2; the reader passes to 2; A commits, and its owner crashes
before the hint; A stays quiet. Each later `id > 2` poll is empty: no wait at
a gap fixes it, and src/follow.ts:59 repairs a gap only when a later message
comes.

| A late commit is found by | A's event | Holds back other chats | Costs (run) |
|---|---|---|---|
| F1. A mark from the writers: the lowest `id` still open; the reader stops there | Found, if every open transaction is known: one active process (D2), or a mark row for each runner, ended by a lost lease | Yes: all wait for the slowest open transaction | Numbers given at commit, one at a time: 544 /s (MySQL), 1,326 /s (MariaDB), against E1's 5,510 /s in parallel |
| F2. A sweep: each chat's highest `n` in its `chat` row (in the event's transaction) against the `n` that the listener acknowledged (F3), and a read of each chat behind | Found at the first sweep after the commit, with no hint and no later event; a rollback's gap gives nothing | No: the feed never waits at a gap | One read of 100,000 chat rows: 17.5 to 18.5 ms (client round trip) |
| F3. The listener acknowledges `(chat, n)`; what is not acknowledged is sent again | Only with F1 or F2 to see what exists | No | A write for each acknowledgment |

How a listener learns of new events in less than 1 s:

| | Gives | Costs | Rules out |
|---|---|---|---|
| Poll one feed table (`id > ? order by id limit 100`) | Each event that commits in `id` order; with the sweep (F2), every event | 0.16 to 0.19 ms a poll that gave 5 rows: the mean client round trip of 2,000 polls in turn on one connection, 1 M rows (`/tmp/ec-wdp2/proj/seq.ts`); the server's CPU: not measured. At most 100 rows a poll: a busy feed polls again at once while a poll gives 100 | Nothing |
| Push from the owner, the table as the truth | Pieces and hints at once; whole messages read from the table after a gap or a reconnect | A connection from each runner to the listener | Nothing: the poll and the sweep stay as the safety net |
| The binary log (Debezium) | Commit order, no poll | One more service; `ROW` format; a privileged user | Nothing |
| A broker | `agents.md`, "Events out" | One more service, an outbox relay | Nothing |

### F. A server for the checks

No MySQL or MariaDB binary is on this machine, and the project has no Nix
file; `docker` exists. `nix build nixpkgs#mariadb_114` and `nixpkgs#mysql84`
(out-links in `/tmp/ec-wdp2/`) took 2 to 4 s each. A new data directory, then
a start to the first `select 1`: MariaDB 0.85 s + 0.88 s, MySQL 2.54 s +
0.83 s. A check needs the binaries, a socket, a data directory in `/tmp`, and
a stop at the end.

## What fits, what does not

- A1 first: one subset of SQL for both, checked on MySQL 8.4 and MariaDB 11.4.
  With keys `(chat, n)` the program makes each id, so `returning` and
  sequences, MariaDB's main extras, are not needed; A1 keeps RDS for both and Aurora.
- B2: the chat's UUID as `binary(16)` in each row, the tenant in `chat` only.
  It costs about 12 GB at 100,000 chats against B3, and a chat moves whole.
  B1's tenant in each row buys only a join less. The store bound to one chat,
  and its test, are the only wall: plan them first.
- C2 on the server: Effect's migrator records a failed migration as done (run).
- D1: a lease for each loaded chat, taken at load and given back at unload,
  checked by a locking read in each write transaction. One process holds all
  the leases at first; a second process needs no new code. `GET_LOCK` is no
  fence (run), and Effect's cluster is not needed for 100 working chats.
- E1, a feed and F2: `(chat, n)` and `chat.seq = n` in the event's
  transaction, an `id` by `AUTO_INCREMENT` for the feed. The owner pushes a
  hint; the reader polls each 200 ms, never waits at a gap, and reads the ids
  it passed again for a while (a speed-up only; run: found A at once); the sweep is
  the truth: a quiet or new chat, a lost hint, a crash (run). Unrelated events wait
  for nothing (B in 2.5 to 4 ms): they meet the 1 s; a late commit waits one
  sweep period at most. Not F1: one slow transaction holds every chat. Not E3:
  one row for all (580 /s on MySQL).
- Removal: the cascade for a small tenant; in parts, under `erasing`, for a
  large one, so that no transaction holds locks or the replica for seconds.

## Limits

- No row-level security: a wrong `where` in the program shows one tenant's rows to another.
- DDL commits: a failed migration leaves a half-changed schema, and a crash-safe statement can leave a part of itself; only steps that can run twice repair it.
- No partial index; no `returning` on MySQL; `call` and `usage` need backticks or new names.
- No commit order across chats from `AUTO_INCREMENT`, so the feed alone can skip a late commit for ever; commit order for all costs one hot row.
- A tenant's cascade is one transaction that the replica runs again, about as long (6.7 s for 1 M rows here).
- No server in the test process: each server check starts one (1.7 s to 3.4 s here).

## Questions for the operator

1. MySQL or MariaDB in the deployment? Recommended: SQL for both (A1), checked
   on both; deploy MySQL 8.4 on RDS, which keeps Aurora open.
2. Is the event number one for each chat or one for all? Recommended: `(chat,
   n)` gives the order; the feed's `id` is only a fast cursor, with gaps; a
   sweep of each chat's `n` (F2) finds every event, at most one period late.
3. May a tenant's removal delete its log, against "a message ... is never
   deleted" (`GLOSSARY.md`)? Recommended: yes, only as the removal of the whole
   tenant; in parts above 100,000 rows. The tenant's UUID stays in `chat` only (B2).
4. Must the full check start the two servers? Recommended: yes, from nixpkgs,
   in a recipe of its own; the scoped check stays on SQLite.

## Words

| Word | Meaning |
|---|---|
| tenant | A company that uses a hosted deployment. It owns chats. Tenants may be competitors. |
| hosted chat | A chat that a runner holds with chats of other tenants (`agents.md`). |
| runner | A process that holds many hosted chats (`agents.md`). |
| lease | A row that names a chat's owner until a time, renewed by the owner. |
| epoch | The number of a lease; it grows at each new owner. A write with an old epoch is refused. |
| fence | A check that refuses the writes of an owner that lost its lease. |
| event number | A number of an event that only grows: in a chat (`n`), or in the feed (`id`). |
| feed | The table of events that a listener reads, by its `id`. The sweep (F2) finds what the feed passed. |
| atomic DDL | A server's promise that one supported DDL statement is done whole or not at all, also at a crash (MySQL: InnoDB only; MariaDB: listed statements). Not a transaction of many statements. MariaDB's "crash-safe" is less: consistent tables after a crash, the statement maybe done in part. |
| named lock | A lock by a name that a session takes with `GET_LOCK`; it ends with the session. |
