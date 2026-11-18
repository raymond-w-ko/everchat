`packages/mariadb/` (`@everchat/mariadb`): the store on MariaDB, for a hosted
deployment (`docs/design.md`, "The database"). Today it holds only the
driver's client. The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/mariadb/` (`@everchat/mariadb`): the store on MariaDB. Its two
  entries, no `.`:
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
- `./testing` (`packages/mariadb/tests/server.ts`): the tests' help, as
  sqlite's `./testing` is: `start`, which starts a private MariaDB server
  for a test ("The servers of the checks"). A file under the package's
  `tests/` is a test to `tools/graph.ts`, so it may import any built-in.
- The tests of one module sit next to it, in `packages/mariadb/src/`; the
  helper's own tests are `packages/mariadb/tests/server.test.ts`.

## What it is not

Each of these is a later bead of the plan of the store on MariaDB
(ec-dwjz):

- No store yet. The shared store is `@everchat/sqlite`'s entry `./sql`,
  with MariaDB's dialect. The client sets nothing of the session and holds
  no SQL.
- No schema's files yet, and no start's check of them.
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

## Its check

The scoped check of the package (the root `AGENTS.md`, "Checks"):
`just scoped packages/mariadb/src/client.test.ts
packages/mariadb/tests/server.test.ts`, where the cases on a server skip.
`just check` checks the types of its program. `just test-mariadb` runs them
all on the two servers.
