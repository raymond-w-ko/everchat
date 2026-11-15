# MariaDB 10.11, newer versions, and prefixed tables in a shared schema

The operator's server database is MariaDB 10.11, and EverChat's tables live
inside the schema of another product, each with the table prefix `everchat_`.
This document answers four questions. Does `docs/research/mysql.md` hold on
10.11? What do the newer versions give, and what does an upgrade cost? What
does a table prefix in a shared schema cost (names, code, migrations, rights,
defaults, the product's tools)? What would we do first? It decides nothing.
Runs: under `/tmp/ec-hp2e/`, MariaDB 10.11.18 and 11.8.9 from nixpkgs (the
newest that Nix gives), private servers on 127.0.0.1, Bun 1.4.4, `mysql2` 3.24.6, `@effect/sql-mysql2` 4.1.2.
10.11.18 is two releases after 10.11.16 (10.11.17 on 2026-05-18, 10.11.18 on 2026-05-27, a "corrective release" for Galera) and one before the newest, 10.11.19 (2026-08-24).
https://mariadb.com/docs/release-notes/community-server/10.11/10.11.18 , https://mariadb.com/docs/release-notes/community-server/10.11/10.11.19 .
The schema names `acme_dev` and `acme_qa` are invented. The operator's
decisions replace `mysql.md`'s "SQL for both" (A1) and "deploy MySQL 8.4":
the server is MariaDB only, so its extras may be used where they help.

## Today

| Today | Where | With a table prefix |
|---|---|---|
| The table names are written out in each statement: 54 statements (`sql`, `sql<...>` and `sql.unsafe` sites); 58 names after `from`, `into`, `update` or `join`, outside comments (grep) | src/store.ts:653, src/store.ts:674, src/store.ts:927 | Each name changes |
| Two statements are text joined at run time, for `sql.unsafe` | src/store.ts:655, src/store.ts:665 | Each name in the text changes |
| The tests write the same names: 177 lines in 17 test files, and 6 in a tool (grep, same pattern) | src/database.test.ts:94, tools/probe.ts | Each name changes |
| The migrations are text, run by `sql.unsafe` | src/migrations.ts:276 | Each name in the text changes |
| A trigger's name is made from its table's name: `${table}_no_${on}` | src/migrations.ts:28 | Gets the table prefix from its table |
| References have no names (`references launch (id)`) | src/migrations.ts:113 | InnoDB names them `<table>_ibfk_<n>` (Facts): they get the table prefix |
| Index names (`launch_live`) | src/migrations.ts:69 | Unique in a table only (run): no change |
| One view, `msg_read` | src/migrations.ts:266 | Shares the tables' names (Facts): needs the table prefix |
| Effect's migrator, default table `effect_sql_migrations`, read by name | src/database.ts:35, src/database.ts:46 | The migrator takes another name (below) |

Only `src/store.ts`, `src/database.ts` and `src/migrations.ts` read or write
tables (`src/database.ts:6`). Effect 4.1.2 (`node_modules/effect/src/sql/`):

- `sql(name)` is an identifier (`Statement.ts:260`). The compiler gives it to
  the dialect's `onIdentifier` (`Statement.ts:997`). MySQL's escapes it with
  backticks, doubles a backtick, and turns a dot into two parts
  (`Statement.ts:1241`; `MysqlClient.ts:516`). Run: `sql("everchat_a")` gave
  `` `everchat_a` ``, and `sql("acme_dev.everchat_a")` gave `` `acme_dev`.`everchat_a` ``.
- `transformQueryNames` (`MysqlClient.ts:220`, `SqliteClient.ts:113`) maps
  each identifier fragment, `sql("name")`, columns too (`MysqlClient.ts:503-507`).
  A name in a statement's own text (src/store.ts:927) is a literal and goes as
  it is (`Statement.ts:988-999`), as does the text of `sql.unsafe`. Run, compile
  only (`/tmp/ec-jguj/proj/transform.ts`): `` sql`select id from chat` `` and
  `sql.unsafe` gave `select id from chat`; fragments gave `` select `everchat_id` from `everchat_chat` ``.
- The migrator takes `table?: string` (`Migrator.ts:32`), default
  `effect_sql_migrations` (`Migrator.ts:126`), and quotes it with `sql(table)`.
- `mysql2` sets the connection to `UTF8MB4_UNICODE_CI` when no charset is given
  (`mysql2/lib/connection_config.js:176`).

## Facts

### Versions (pages read 2026-11-14)

| | End of community binaries | RDS end of standard support |
|---|---|---|
| 10.11 | 2028-02-16 | February 2028 |
| 11.4 | 2029-05-29 (5 years "For releases up to MariaDB 11.4") | May 2029 |
| 11.8 | 2028-06-04 (3 years after GA) | June 2028 |
| 12.3 (LTS, GA 2026-05-28) | 2029-06-12 | June 2029 (on RDS since 2026-08-07) |
| 13.0, 13.1 | Rolling releases: 13.0.2 GA; 13.1.1 RC | Not listed |

https://mariadb.org/about/#maintenance-policy , https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MariaDB.Concepts.VersionMgmt.html .
RDS lists the 10.11 minors 10.11.13 to 10.11.19 (no 10.11.17), and 10.5, 10.6 until 2026.
RDS upgrades in place from "Any MariaDB version" to 10.11, 11.4, 11.8 or 12.3; major upgrades are never automatic and need downtime; replicas first.
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.MariaDB.Major.html ,
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.MariaDB.html .
Aurora is "compatible with MySQL and PostgreSQL"; the page does not name MariaDB.
https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_AuroraOverview.html

### Does `mysql.md` hold on 10.11? (run on 10.11.18; 11.8.9 the same unless said)

| Statement of `mysql.md` (11.4.13) | 10.11.18 | Agrees |
|---|---|---|
| `insert ... returning`, one-table `delete ... returning` run | Run, also an `insert` of 3 rows. `update ... returning`: syntax error (11.8 too) | Yes |
| `uuid` type (16 bytes); no `uuid_to_bin`; `binary(16)` keys | The same | Yes |
| JSON is text with a `JSON_VALID` check; `check` is enforced | Bad JSON and `n = -1` refused (error 4025) | Yes |
| No partial index; a generated `live` column and `unique (chat, live)` replace `launch_live` | Syntax error; the replacement refused a second live launch, kept two ended ones | Yes |
| `skip locked`, `nowait` | Run | Yes |
| `lock in share mode` only; `for share` is a syntax error | The same (11.8 too) | Yes |
| `create sequence` | Runs | Yes |
| `(a, b) in ((?, ?))` runs; `values row(...)` does not | The same; `in (values (?, ?))` runs too | Yes |
| `call`, `usage` need backticks | The same | Yes |
| `signal sqlstate '45000'` in a trigger refuses a delete; a cascade does not fire it | Refused (1644); the cascade deleted both rows | Yes |
| DDL commits a transaction | An insert before `create table` stayed after `rollback` | Yes |
| A failed `create or replace table` leaves no table (only crash-safe) | No table left (11.8 too) | Yes |
| Atomic `alter`, `rename` | A failed two-part `alter` left the table as it was; a failed two-table `rename` renamed none | Yes (a crash: not run) |
| `REPEATABLE READ`; `innodb_autoinc_lock_mode` 1; binary log off, `MIXED` | The same. `@@transaction_isolation` is unknown on 10.11 (`@@tx_isolation` works); 11.8 has both | Yes |
| Lease: the old owner is refused at epoch 2; a plain `select` sees epoch 1, `lock in share mode` sees 2; a take waits for a write in flight | The same; the take waited 304 ms; the check cost 0.11 ms a write (0.619 to 0.729 ms). On 11.8: the locking read fails with error 1020 (below) | Yes |
| `AUTO_INCREMENT`: a later id commits first; a rollback leaves a gap | The same | Yes |
| E1 with F2: the poll loses the late commit; the sweep finds it; a rollback gives nothing | The same; the sweep read 100,000 chat rows in 21.7 ms; one connection wrote 1,117 events /s | Yes |
| Effect's migrator records a failed migration as done; its first tables stay | The same; a second run skipped migration 2 | Yes |

`innodb_snapshot_isolation` exists since 10.11.8 and is `ON` by default from 11.6.2: "an error ... is raised if an attempt is made to acquire a lock on a
record that does not exist in the current read view", "treated in the same way as a deadlock, and the transaction is rolled back". Run: 0 on 10.11.18, 1 on 11.8.9.
https://mariadb.com/docs/server/server-usage/storage-engines/innodb/innodb-system-variables

### What the newer versions give

| Feature | From | Source |
|---|---|---|
| `ALTER TABLE` "can now do most operations with `ALGORITHM=COPY, LOCK=NONE`"; not for tables with `CASCADE` foreign keys | 11.2 | https://mariadb.com/docs/server/reference/sql-statements/data-definition/alter/alter-table/online-schema-change |
| `JSON_SCHEMA_VALID` (Draft 2020, gives only true or false) | 11.1 | https://mariadb.com/docs/server/reference/sql-functions/special-functions/json-functions/json_schema_valid |
| `UUID_v4()`, `UUID_v7()` ("sortable by creation time") | 11.7 (run on 11.8; missing on 10.11) | https://mariadb.com/docs/server/reference/sql-functions/secondary-functions/miscellaneous-functions/uuid_v7 |
| Snapshot isolation on by default | 11.6.2 | Above |
| `utf8mb4` and `utf8mb4_uca1400_ai_ci` as defaults; "11.8 is the first long-term support release containing either change" | 11.6 | https://mariadb.com/docs/server/reference/data-types/string-data-types/character-sets/setting-character-sets-and-collations |
| Foreign-key names "unique per table", not per database | 12.1 | https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/optimization-and-indexes/foreign-keys |
| `mariadb-dump --wildcards`: patterns that select tables to dump, not to leave out | 12.1 | https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump |
| `UPDATE ... RETURNING`, one table | 13.0 (rolling) | https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/changing-deleting-data/update |
| Atomic `CREATE OR REPLACE TABLE` | 13.2 on the Atomic DDL page; 13.0's notes list it: conflict | https://mariadb.com/docs/server/reference/sql-statements/data-definition/atomic-ddl |
| `DENY`, "negative grants" | 13.1 (RC) | https://mariadb.com/docs/release-notes/community-server/13.1/mariadb-13.1-changes-and-improvements |

What an upgrade from 10.11 costs:

- To 11.4: "On most servers upgrading from 10.11 should be painless". Removed:
  the `innodb_defragment*` variables, `old_alter_table`; new `optimizer_switch`
  defaults and the optimizer cost model of 11.0; `tx_isolation` deprecated.
  https://mariadb.com/docs/server/server-management/install-and-upgrade-mariadb/upgrading/mariadb-community-server-upgrade-paths/upgrading-from-mariadb-10-11-to-mariadb-11-4
- 11.4: "SSL is now enabled in the server by default"; "Clients now require SSL
  and have --ssl-verify-server-cert enabled by default".
  https://mariadb.com/docs/release-notes/community-server/11.4/what-is-mariadb-114
- To 11.8: snapshot isolation on ("ERROR 1020 ... Record has changed since last
  read"), and the new default character set and collation. On RDS, 11.8 sets
  `require_secure_transport` to 1 (the RDS upgrade page above).
  https://mariadb.com/docs/server/server-management/install-and-upgrade-mariadb/upgrading/mariadb-community-server-upgrade-paths/upgrading-from-mariadb-11-4-to-mariadb-11-8
- To 12.3: `CONVERSION` and `TO_DATE` are reserved words.
  https://mariadb.com/docs/server/server-management/install-and-upgrade-mariadb/upgrading/mariadb-community-server-upgrade-paths/upgrading-from-mariadb-11-8-to-mariadb-12-3
- A community upgrade from 10.11 straight to 11.8: `not proved`. The pages
  document only neighbouring long-term versions (10.11 to 11.4, 11.4 to 11.8).

### Names in one schema (run on 10.11.18 and 11.8.9, the same)

| Name | Unique in | Run: the product has it first | Source |
|---|---|---|---|
| Table, view, sequence | The schema: one namespace | `create view report`, `create sequence orders`: error 1050 | https://mariadb.com/docs/server/server-usage/views/create-view , https://mariadb.com/docs/server/reference/sql-structure/sequences/sequence-overview |
| Foreign-key constraint | The schema before 12.1 | `constraint chat_fk` on an EverChat table: errno 121. An unnamed one became `everchat_msg_ibfk_1` | https://mariadb.com/docs/server/architecture/server-constraints/foreign-key-constraints |
| Trigger | The schema | `msg_no_update` on `everchat_msg`: error 1359 | MySQL, the same rule: https://dev.mysql.com/doc/refman/8.4/en/create-trigger.html |
| Event | The schema | `nightly`: error 1537 | https://mariadb.com/docs/server/reference/sql-statements/data-definition/create/create-event |
| `check` constraint, index | The table | Two tables, each with `ck_x` and index `launch_live`: both run (MySQL: `check` names per schema) | MariaDB: `not proved` from a page |
| `GET_LOCK` name | The server | `acme_dev` holds `everchat-migrate`; `acme_qa` gets 0; `concat(database(), '.everchat-migrate')` gets 1 | — |
| User, role | The server | — | https://mariadb.com/docs/server/reference/sql-statements/account-management-sql-statements/create-role |

- A check at start, as root, found a product table `everchat_x` with
  `table_name like 'everchat\_%'` and not in the program's list. Unescaped,
  `like 'everchat_%'` also matched `everchatXy`: `_` is a wildcard (run).
  `lower_case_table_names` was 0 here: names are case-sensitive (run).

### Rights (run on 10.11.18 and 11.8.9, the same)

- `GRANT` takes `%` and `_` in database names only. Run: ``on acme_dev.`everchat\_%` `` gave
  "Table ... doesn't exist" (1146); `on acme_dev.everchat_%` a syntax error.
  https://mariadb.com/docs/server/reference/sql-statements/account-management-sql-statements/grant
- A grant on a table that does not exist yet is accepted (run). A user with
  `create, alter, index, references, drop, trigger, select, insert` on
  `everchat_p` and `everchat_q` only made both tables, a foreign key between
  them, and a trigger, altered and dropped one. It was refused `create table
  everchat_r` and `select ... from orders` (1142).
- A user with rights on `acme_dev.*` read `orders`, copied it to a new table,
  and dropped that table (run).
- A role took the rights of one table and gave them to the user (run).
- What a user sees (run on both as B2's users, `/tmp/ec-jguj/run.sh`): `information_schema.tables` and `show tables` list only the tables that the user has a right on. The runtime user saw `everchat_chat`, `everchat_msg`, not the product's `everchat_x`; it saw the triggers on its tables, the product's too. The migration user, granted the next release's name `everchat_x`, saw it and its columns; `create table` gave 1050, `create table if not exists` only a note 1050, and the product's table stayed. A `sql security definer` view of `information_schema.tables` that root made listed `everchat_x` to the runtime user, which still could not read it (1142).

### The schema's defaults

- A table with no character set takes the schema's; "Naming a character set
  without a `COLLATE` clause does **not** inherit the database's collation"
  (the map, from 11.5). Before 11.6 the server default is `latin1`,
  `latin1_swedish_ci`; "Defaults may be different on some systems". Run: this
  build of both versions had `utf8mb4_unicode_ci`; a table in a `latin1`
  schema became `latin1_swedish_ci` and refused an emoji (1366); a table that
  states `utf8mb4` took it. The 10.11 command-line client talks `utf8mb3` and
  11.8's `utf8mb4` (run).
  https://mariadb.com/docs/server/reference/data-types/string-data-types/character-sets/setting-character-sets-and-collations
- `innodb_default_row_format` is `dynamic` (run, both).
  https://mariadb.com/docs/server/server-usage/storage-engines/innodb/innodb-row-formats/innodb-row-formats-overview
- `sql_mode` default: `STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION`
  (run, both); "Stored programs and views always use the SQL_MODE that was
  active when they were created": a trigger keeps it (run).
  https://mariadb.com/docs/server/server-management/variables-and-modes/sql_mode

### The product's tools

- `mariadb-dump acme_dev` dumped each `everchat_` table and trigger (run).
  `--ignore-table` takes one `database.table` each time; run:
  `--ignore-table='acme_dev.everchat_%'` left out none of 6 tables. One option
  for each exact name left out all (run again, both versions: 4 of 4; only `orders` stayed).
- No version takes a pattern in `--ignore-table`. The page: "Each table must be specified with both database and table names". 12.3's source keeps each in a hash and looks up the exact `database.table` (`mysqldump.cc:1027-1036`, `:5805-5807`). `--wildcards` (12.1) only selects: the names given to dump become `LIKE` patterns joined by `or` (`:7444-7500`, `:7781-7788`). https://github.com/MariaDB/server/blob/12.3/client/mysqldump.cc . `--wildcards` is an unknown option on 10.11 and 11.8 (run); a 12.x binary: not run (nixpkgs has none).

## Options

### A. Where the table prefix lives in the code

| | A1. Fixed names, `everchat_msg`, in each build | A2. A value in one place: `${sql(t.msg)}` | A3. `transformQueryNames` | A4. On the server only |
|---|---|---|---|---|
| Gives | One name in all code, tests, SQLite and the Durable Object (one chat each: only longer names); grep finds each use | Any table prefix for each deployment | One map for every name, once each name is a fragment | SQLite as it is |
| Costs | One rename: 58 names in `src/store.ts`, the migrations, 183 test and tool lines | Each statement interpolates; the `sql.unsafe` texts (src/store.ts:655) and migrations join strings; a test for each table prefix | A2's edit too: each table name in the tagged text (src/store.ts:653, src/store.ts:674) becomes a fragment, or it does not change (run); column fragments change too; `sql.unsafe` text does not | Two sets of names; the store's statements differ by build in one more way |
| Rules out | Two EverChat deployments in one schema | Nothing | — | One store module for all builds |

### B. Rights

| | B1. One user, rights on `acme_dev.*` | B2. Grants on each named table, two users | B3. B2 through roles |
|---|---|---|---|
| How | `grant ... on acme_dev.*` | A database administrator runs, before each release, the grants that the release prints: DDL rights to `everchat_migrate`, `select, insert, update, delete` to `everchat` | The same grants to `everchat_ddl` and `everchat_rw` roles |
| EverChat's bug can | Read, change or drop the product's tables (run) | Touch only its own named tables (run) | The same as B2 |
| Costs | Nothing | A step by a person at each release that adds a table | One more name on the server |

### C. The migrator's state

| | C1. Effect's migrator, `table: "everchat_migrations"` | C2. Own steps (`mysql.md`, C2) |
|---|---|---|
| Run | Made `everchat_migrations` beside `orders`; a failed migration stays recorded | Not run again |
| State | One row for each migration | A row for each step in an `everchat_` table, written after the step |
| Lock | None | `GET_LOCK` with the schema in its name: the name is server-wide (run) |

### D. The product's tools

| Event | What happens | Guard |
|---|---|---|
| Backup of `acme_dev` | Holds the tenants' chats | The program prints the `--ignore-table` list, one exact name each, on every version (Facts) |
| Restore of production into `acme_qa` | QA gets the tenants' chats and their leases; when the leases end, QA's EverChat takes the chats and may send to the tenants' webhooks | A deployment row (schema name and a deployment id from the config) checked at start; no send on a mismatch: `not proved` |
| Restore of an older dump | `everchat_migrations` and the tables go back; the code may be newer | The migrator runs; a newer schema than the code: refuse to start |
| Drop and make the schema again | All chats gone | Only the product's procedure; EverChat cannot guard it |
| The product makes `everchat_x` later | A collision at a later migration, or a foreign table in EverChat's checks | B2's runtime user cannot see it (Rights): the administrator's check at each release lists every `everchat\_%` name against the release's list; on a granted name the migration's `create` fails (1050), but `if not exists` keeps the product's table |

### E. The server version

| | E1. 10.11 | E2. 11.4 | E3. 11.8 | E4. 12.3 |
|---|---|---|---|---|
| Ends (community) | 2028-02-16 | 2029-05-29 | 2028-06-04 | 2029-06-12 |
| Gives | All that `mysql.md` needs (run) | Online `alter`, TLS by default | UUIDv7, snapshot isolation, `utf8mb4` defaults | FK names per table, dump selection by pattern (no exclusion) |
| Costs | An upgrade within 15 months | "Painless" | Error 1020 to retry; new collation default; TLS on RDS | Two reserved words; least tried |

## What fits, what does not

- 10.11 is enough. Each decisive trial of `mysql.md` gives the same result on
  10.11.18 (the table above). No newer feature changes a recommendation of
  `mysql.md`: with keys `(chat, n)` made by the program, `UPDATE ... RETURNING`
  and `UUID_v7()` are not needed; the tenant's UUIDv4 comes from outside. Plan
  an upgrade before 2028-02-16: E2 (11.4) is the shortest step and lasts to
  2029-05-29.
- Check on 10.11 and 11.8. 11.8 differs where it counts: with snapshot
  isolation, a stale owner's locking read fails (1020) and does not read the
  new epoch. Both refuse the write, so the fence holds; the store must treat
  1020 as a deadlock: roll back, read the lease again.
- A1 first: `everchat_` written out in every build. A table prefix that never
  changes costs one rename, and one name for all builds keeps one store. A2
  buys only a second deployment in one schema, which nothing asks for; A3 needs A2's edit too.
- Every name that is unique in the schema carries the table prefix: tables,
  the view, triggers (src/migrations.ts:28 already derives them), named
  foreign keys (or leave them unnamed: InnoDB derives them), and the
  `GET_LOCK` name gets the schema too. Index and `check` names need none.
- Each table states `engine = InnoDB default charset = utf8mb4 collate = <one
  collation> row_format = dynamic`, and the store sets its connection's
  `sql_mode`: an old schema may be `latin1`.
- B2: the runner can then touch nothing of the product's. The grants come
  from a list that the release prints. B1 lets a bug in EverChat drop the
  product's tables.
- C1 with `everchat_migrations` works; `mysql.md`'s C2 holds for the reasons it gives.
- At start, the program refuses to run on what B2 lets it see: a trigger of
  another name on its tables, a table of its list with other columns, or a
  deployment row of another schema (the guard against a restored copy that
  sends to tenants). A foreign `everchat_` table it cannot see: the
  administrator's check before each release finds it, or a definer view that
  the administrator gives (run); not rights on the schema. C2's `if not exists` steps need a column check after.

## Limits

- No `GRANT` pattern for table names: each new table needs a grant by a person (B2), or the runner gets the whole schema (B1). With B2, the program sees only its own tables: a whole check of the table prefix is the administrator's.
- The product's backups hold the tenants' chats unless each table is left out by its exact name (no version takes a pattern to leave out).
- A restore across stages copies tenants' data between stages; EverChat can refuse to act on it, not prevent it.
- A drop of the schema by the product's tools removes all chats; nothing in MariaDB guards it.
- Users, roles and `GET_LOCK` names are server-wide, and the given case puts `acme_dev` and `acme_qa` on one server (production on a second): each of the two stages needs its own user pair and a lock name with its schema in it.
- 10.11's community support ends 2028-02-16: one upgrade is certain.
- Not run again on 10.11: crash safety of DDL (no server was killed during DDL), `mysql.md`'s sizes and its 1 M-row cascade.

## Questions for the operator

1. Stay on 10.11 for the first version? Recommended: yes; check each change
   on 10.11 and 11.8; upgrade to 11.4 or later before 2028-02-16.
2. Is the table prefix always `everchat_`, in every build, also the local
   SQLite file? Recommended: yes (A1), written out in the statements.
3. May a database administrator run grants for each new table at a release?
   Recommended: yes, B2, with two users: `everchat_migrate` for DDL, `everchat` for rows.
4. Must the product's backups and restores between stages leave out
   EverChat's tables? Recommended: yes; the program prints the
   `--ignore-table` list, and refuses to send when its deployment row names
   another schema.

## Words

| Word | Meaning |
|---|---|
| table prefix | The text `everchat_` at the start of each name of EverChat's in a shared schema. Not the cache's prefix (`GLOSSARY.md`). |
| shared schema | A MariaDB schema that holds another product's tables and EverChat's. |
| product | The other program whose schema EverChat shares. |
| stage | One copy of a product: development, QA or production, each its own schema. |
| grant | A right on a schema or a table that a database user gets with `GRANT`. |
| collision | Two objects that want one name in a schema; the second `create` fails. |
| snapshot isolation | MariaDB's check that refuses a lock on a row changed after the transaction's snapshot (error 1020). |
| deployment row | A row that names the schema and the deployment that made EverChat's tables, checked at start. |
