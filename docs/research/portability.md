# One core on Bun, Node and `workerd`: what is in the way, and the seams

The operator decided (2026-11-14): one program on Bun first, `workerd`
(Cloudflare) second, maybe Node, and one process for the tenant chats of many
tenants. How? What binds `src/` to Bun, what Effect 4.1.2 and code mode give on
each runtime, how the hosted shape fits Cloudflare, what keeps tenants apart in
one Bun process, and which parts must be services with more than one
implementation (the seams). It decides nothing. It replaces
`docs/research/runtime.md`'s Question 5 ("stay on Bun") and its rejection of
`workerd`; its measurements and limits hold. `docs/research/agents.md` and
`docs/research/functions.md` are cited, not repeated.

## Today

Each file of `src/` (tests left out) that uses an API that only Bun has, or a
Node API. "Hosted" says whether the hosted use (no `shell`, no files, no
terminal) needs it.

| File | What it uses, where | Hosted |
| --- | --- | --- |
| `src/database.ts` | `@effect/sql-sqlite-bun` (on `bun:sqlite`), src/database.ts:21; `pragma synchronous = full` and `foreign_keys = on`, src/database.ts:33 | Not as is: another driver |
| `src/store.ts` | Imports `database.ts`, src/store.ts:31, so every importer of the `Store` tag loads `bun:sqlite`; `process.kill(pid, 0)` for the launch rule, src/store.ts:324; `Bun.CryptoHasher`, src/store.ts:1072; `pragma data_version`, src/store.ts:847 | The store yes; the pid rule no |
| `src/sandbox.ts` | `CodemodeSandbox` from the library's main entry, src/sandbox.ts:45, which imports `node:worker_threads` (`dist/runtime/host.js:1` of `pi-codemode`); the QuickJS file by `with { type: "file" }`, src/sandbox.ts:47; the worker file by `import.meta.url`, src/sandbox.ts:67; the compute limit by `setTimeout`, src/sandbox.ts:172 | The service yes; the worker thread not on `workerd` |
| `src/worker.ts` | The worker thread's program, src/worker.ts:14 | Bun and Node only |
| `src/turn.ts` | No Bun API, but imports `sandbox.ts` and `head.ts`, src/turn.ts:68, so it loads both above | Yes |
| `src/head.ts` | `prompt.txt` by `with { type: "text" }`, src/head.ts:24 | Yes |
| `src/cache.ts` | `Bun.CryptoHasher`, src/cache.ts:115, src/cache.ts:171; `Buffer`, src/cache.ts:174 | Yes |
| `src/memory.ts` | `Buffer` (a Node global), src/memory.ts:125, src/memory.ts:168 | Yes |
| `src/openai.ts` | `globalThis.fetch`, src/openai.ts:60 (web standard); `Buffer`, src/openai.ts:97 | Yes |
| `src/gateway.ts` | `node:fs`, `node:os`, `node:path`; the key from `process.env` or the home, src/gateway.ts:89; removes it from the environment, src/gateway.ts:91 | No: a secret for each tenant |
| `src/limit.ts` | Writes a long result to a file under `os.tmpdir()`, src/limit.ts:104, src/limit.ts:122 | No: the copy is for `shell` and `read` |
| `src/functions.ts` | `node:fs`, src/functions.ts:28; `process.cwd()`, src/functions.ts:149; imports `shell.ts` and `files.ts` | The service yes; its set of functions no |
| `src/shell.ts` | `Bun.spawn`, src/shell.ts:255; `Bun.spawnSync(["ps", ...])`, src/shell.ts:133; `process.kill`, src/shell.ts:83 | No |
| `src/files.ts` | `node:fs`, `node:path`, src/files.ts:40 | No |
| `src/main.ts` | `BunServices`, src/main.ts:297; `pid`, `os.hostname()`, src/main.ts:137; `process.cwd()`, src/main.ts:202; signals, src/main.ts:275; `import.meta.main`, src/main.ts:305 | No: each runtime has its own host |
| `src/inspector.ts` | `BunHttpServer`, src/inspector.ts:132; `Bun.CryptoHasher`, src/inspector.ts:66; an HTML file by `with { type: "text" }`, src/inspector.ts:37 | No (local) |
| `src/inspect.ts` | `os.hostname()` and the pid check, src/inspect.ts:290 | No (local) |
| `src/terminal.ts`, `src/paint.ts`, `src/pipe.ts` | `pi-tui`'s `ProcessTerminal`, src/terminal.ts:157; `pi-tui` itself imports `node:fs` and `node:child_process`; `Stdio`, src/pipe.ts:67 | No (local) |

No Bun or Node API in their own code: `ask.ts`, `compactor.ts`, `diagnostics.ts`,
`diff.ts`, `follow.ts`, `migrations.ts`, `pace.ts`, `pages.ts`, `request.ts`. But
`ask.ts` imports `cache.ts`, and `compactor.ts` and `diagnostics.ts` import
`store.ts`: only the other six load no Bun code (they use `import type`).

Two seams are half there: `Store.layerNoDatabase` takes any `SqlClient`
(src/store.ts:629), and `layer` (src/main.ts:136) builds one chat from values.
What is in the way is the import graph: each tag lives in the same file as its
Bun implementation.

## Facts

Effect 4.1.2 packages, read from the npm registry and the tarballs
(`npm view <name>@4.1.2 peerDependencies`). https://www.npmjs.com/package/effect

| Package | For `effect` 4.1.2 | What it gives |
| --- | --- | --- |
| `effect` 4.1.2 (core) | yes | `effect/http` (`HttpRouter.toWebHandler`: a web `fetch` handler), `FetchHttpClient`, `effect/sql`, `effect/workers`, `effect/socket`, `effect/cluster`, `effect/workflow`. The web handler and `workers` are `@stability unstable`. |
| `@effect/platform-bun` | 4.1.2 (in the checkout) | `BunHttpServer`, `BunWorker`, `BunServices`, `BunChildProcessSpawner` |
| `@effect/platform-node` | 4.1.2, peer `effect ^4.1.2` | The same for Node (`undici`) |
| `@effect/platform-cloudflare` | **none**: only 4.1.3 and 4.1.4 exist (published 2026-11-10 and 11), peer `effect ^4.1.3` / `^4.1.4`, optional peer `@alchemy.run/cloudflare` | Effect Cluster on Durable Objects ("Every entity instance is one Durable Object"; "experimental"). No HTTP server and no SQL client of its own. https://www.npmjs.com/package/@effect/platform-cloudflare |
| `@effect/sql-sqlite-bun` | 4.1.2 | `bun:sqlite` |
| `@effect/sql-sqlite-node` | 4.1.2 | `node:sqlite` (no native addon). `@stability unstable`. |
| `@effect/sql-sqlite-do` | 4.1.2 | Durable Object SQLite; transactions through `storage.transaction()`; `unstable`. https://www.npmjs.com/package/@effect/sql-sqlite-do |
| `@effect/sql-d1` | 4.1.2 | D1; "Transactions ... are not supported" (`src/D1Client.ts` of the package). https://www.npmjs.com/package/@effect/sql-d1 |
| `@effect/sql-mysql2` | 4.1.2, `mysql2 ^3.24.6` | A pool; option `disablePreparedStatements` "for proxies like Cloudflare Hyperdrive"; it sets `multipleStatements: true`. https://www.npmjs.com/package/@effect/sql-mysql2 |

Runs on this machine (Linux x86_64, 30 cores; no account, no model). Scripts in
`/tmp/ec-c387/` (`node/trial.mjs`, `cf/src/index.ts`, `spin-client.ts`). Local `workerd`
1.20261113.1 through `wrangler dev --local` 4.162.0, `compatibility_date` 2026-11-01, `nodejs_compat`.

| Run | Result |
| --- | --- |
| Node 24.22.2: `CodemodeSandbox` 1.5.2, a program that calls one function and prints | `ok`, value 30, 96 ms |
| Node: `for (;;) {}` with `timeoutMs: 2000`, a 10 ms timer on the main thread | `timeout` after 2001 ms; the timer ran 198 times: the main thread stayed free |
| Node: `@effect/sql-sqlite-node` 4.1.2: the two pragmas of src/database.ts:33-34, a migration, a `strict` table, a transaction | All pass; `journal_mode` `wal`, `synchronous` 2 |
| Bun 1.4.4: the same script | The same results: Bun's `node:sqlite` runs Effect's Node client |
| Node: `import t from "./p.txt" with { type: "text" }` | `ERR_UNKNOWN_FILE_EXTENSION` |
| `createHash("sha256")` of `node:crypto` on Bun, Node and `workerd` | The same digest on all three |
| `workerd`: `node:worker_threads` | It imports; `new Worker(...)` throws "The Worker method is not implemented"; no global `Worker` |
| `workerd`: `WebAssembly.compile(bytes)`; Wrangler's import of `quickjs-wasi/quickjs.wasm` and of a `.txt` with `type: "text"` | "Wasm code generation disallowed by embedder"; both imports work (Wrangler's bundler) |
| `workerd`: global `Buffer`; `process.pid`; `HttpRouter.toWebHandler` of `effect` 4.1.2 as the Worker's `fetch` | Present; present; it answers |
| `workerd`, Durable Object, `@effect/sql-sqlite-do` 4.1.2 with `effect` 4.1.2: `SqliteMigrator`, `strict` tables, a `before delete` trigger, a foreign key, `withTransaction` | All work; `foreign_keys` is 1; the trigger and the foreign key refuse as on a file; a failed transaction rolls back |
| The same: `pragma synchronous = full`, `pragma journal_mode`; `pragma data_version` | `not authorized: SQLITE_AUTH`; `data_version` works |
| The same: raw `begin immediate` | Refused: "please use the state.storage.transaction() or state.storage.transactionSync() APIs" |
| `workerd`: `InlineCodemodeSandbox` (`createInlineCodemodeSandbox`), one program, one function | `ok`, value 30, 38 ms |
| `workerd`: inline, a program that allocates past 32 MiB | `InternalError: out of memory` after 235 ms; the object lives on |
| `workerd`: inline `for (;;) {}`, budget 100,000 / 500,000 / 1,500,000 polls | `timeout` after 7.8 s / 25 s / 78 s |
| `workerd`: during that spin, a request to the same object, to another chat's object, and to the stateless `fetch` | All three answered only when the spin ended (after 7.5 s, 24.7 s, 78 s) |
| `workerd`: the 78 s spin against `limits.cpu_ms` 30,000 | Not stopped: the local runtime did not apply the CPU limit |

Code mode (`pi-codemode` 1.5.2, its `README.md` and `dist/`):
https://github.com/earendil-works/pi/tree/main/packages/codemode

- Three sandboxes, one API: `CodemodeSandbox` (a worker thread; Node, Bun),
  `RemoteCodemodeSandbox` (another isolate, usually a Durable Object of a
  separate Worker), `InlineCodemodeSandbox` (the calling thread). The last
  two come from `/portable`, which "has no Node imports".
- Inline, a program that computes "blocks the caller until it awaits a tool
  or uses up its `interruptBudget`". The budget counts polls over the whole
  program and never resets (`dist/runtime/inline.js:27`); 100,000 polls is
  "about 2 seconds" on an M-series laptop, "about 10 seconds on Cloudflare".
- Remote: a VM that computes "keeps running until it calls a tool or uses
  up its budget"; 32 MiB by default; billed "including time spent waiting
  on tools".
- No Dynamic Worker sandbox in the library (no `LOADER` in `dist/`).
  `@cloudflare/codemode` 0.5.6 has `DynamicWorkerExecutor` (network blocked
  and a 60,000 ms `timeout` by default). https://www.npmjs.com/package/@cloudflare/codemode

Cloudflare, then Node and Bun (pages read 2026-11-14):

- A Durable Object is "single-threaded and cooperatively multi-tasked"; it
  has "a globally-unique name"; "In-memory state is reset when the Durable
  Object hibernates". https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
- SQLite in an object: `sql.exec()` "cannot execute ... `BEGIN TRANSACTION`
  or `SAVEPOINT`"; queries "complete synchronously"; "fully consume cursors
  synchronously before the next `await`". For `put()`, `delete()`, writes
  pause "outgoing network messages ... until all previous writes have been
  confirmed flushed to disk" (for `sql.exec`: not proved from the page).
  The page lists no pragmas. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Limits of a SQLite object: 30 s of CPU by default, 5 min at most; "Each
  incoming HTTP request or WebSocket message resets the remaining available
  CPU time"; 10 GB; a row, string or `BLOB` of at most 8 MB; 100 columns;
  100 bound parameters; a soft limit of 1,000 requests a second. https://developers.cloudflare.com/durable-objects/platform/limits/
- An isolate has 128 MB, "including the JavaScript heap and WebAssembly
  allocations", "per-isolate, not per-invocation"; waiting on the network
  is not CPU time; "up to six connections simultaneously waiting for
  response headers" for each invocation. https://developers.cloudflare.com/workers/platform/limits/
- WebSocket hibernation (`ctx.acceptWebSocket`): "Clients remain connected
  while the Durable Object is not in memory"; no duration charge then; the
  constructor runs again; "Outgoing WebSockets do not hibernate", and timers
  prevent it. https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Alarms: "guaranteed at-least-once execution", "up to 6 retries"; one for
  each object; `setAlarm` replaces it. https://developers.cloudflare.com/durable-objects/api/alarms/
- Queues: "at least once delivery", "in rare occasions, may be delivered
  more than once"; order: not stated. https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- Hyperdrive: MySQL 5.7 to 8.x, "MariaDB is also supported". Not
  supported: "Multi-statement queries", `USE`, SQL and "protocol-level
  prepared statements". The pool "operates in transaction mode"; after each
  transaction the connection is reset, so `SET` does not carry over. https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
  https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/
- `mysql2` through Hyperdrive: "v3.13.0 or later", `nodejs_compat`, and
  `disableEval: true` ("Required ... for Workers"). https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/mysql-drivers-and-libraries/mysql2/
- Dynamic Workers: `env.LOADER.get(id, callback)` "caches a Dynamic Worker
  by ID"; code as module strings; `globalOutbound: null` blocks the
  network; the parent calls `worker.getEntrypoint()`. That it is a V8
  isolate: from `runtime.md` (Workers run in isolates), not stated on these
  pages. https://developers.cloudflare.com/dynamic-workers/getting-started/
- Self-hosted `workerd` is "not a hardened sandbox"; the README does not
  describe its threads. https://github.com/cloudflare/workerd
- `node:sqlite`: "Stability: 1.2 - Release candidate" (since v25.7.0); "All
  APIs exposed by this class execute synchronously". https://nodejs.org/api/sqlite.html
- Bun: `node:sqlite` "Fully implemented"; `Worker` "ignores the
  `resourceLimits`" option. https://bun.com/docs/runtime/nodejs-compat

## Options

| How the code is cut (the whole program) | Gives | Costs | Rules out |
| --- | --- | --- | --- |
| P1. One core of services, a host for each runtime (Bun local, Bun hosted, `workerd`, later Node) | One chat logic, tested once with fakes; the runtime is a layer | Move each tag out of its Bun file; a type check of the core with no Bun types | Nothing |
| P2. Today's Bun program, and a second program for Cloudflare | No change to the local use | Two chat logics that drift; every fix twice | "One program" |
| P3. Effect Cluster as the host everywhere (`@effect/platform-cloudflare` on `workerd`, SQL storage on Bun) | Entities, mailboxes, alarms, the same model on both | `effect` 4.1.4 at least; two `experimental`/`unstable` stacks; `agents.md` found that it does not fence the store's writes | Staying on 4.1.2 |
| P4. Run the Bun program on `workerd` with `nodejs_compat` | Little code | Fails: no worker threads, no compile of WebAssembly, no `BEGIN`, no processes (Facts) | — |

| The engine for programs | Where | A program that computes | Memory | Same program as on Bun |
| --- | --- | --- | --- | --- |
| E1. QuickJS in a worker thread (today) | Bun, Node | Its own thread; today's compute limit restarts after each function (src/sandbox.ts:172), so it bounds nothing for sure (`functions.md`) | 512 MiB (src/sandbox.ts:56) | Yes |
| E2. QuickJS inline | Anywhere | Holds the thread: locally every object and the stateless handler waited (Facts); bounded by the budget | Set by the caller; inside the 128 MB isolate | Yes |
| E3. QuickJS in a Durable Object of a separate Worker (`RemoteCodemodeSandbox`) | Cloudflare | The agent's object stays free: a 10 s spin delayed it about 50 ms (README, on Cloudflare, October 2026), against 10 s in the same object. Other sandbox objects: not proved, as objects of one class "may run in the same isolate" (Limits). Budget; `cpu_ms` resets the object | 32 MiB default; all VMs of an isolate share its 128 MB (README) | Yes: the same prelude and engine |
| E4. A Dynamic Worker (V8) | Cloudflare | `cpuMs` (`runtime.md`), a `timeout` (`@cloudflare/codemode`) | The isolate's 128 MB | No: V8 with a JIT (faster), the Workers APIs and timers inside (not run), other errors and stack traces; no `store()`/`load()` or deterministic `start()` of `pi-codemode` (`functions.md`, option D); a second prelude to write |

| The chat's database | Runtime | Fits | Does not fit |
| --- | --- | --- | --- |
| S1. `bun:sqlite` file (today) | Bun | The local use | Anything but Bun |
| S2. `node:sqlite` file (`@effect/sql-sqlite-node`) | Node and Bun (run) | One driver for both | `node:sqlite` is a release candidate only since Node 25.7.0; `unstable` |
| S3. Durable Object SQLite (`@effect/sql-sqlite-do`) | Cloudflare | The rule "state lives in the chat's database": one object, one database; the schema, triggers and transactions run (Facts) | `synchronous = full` (src/database.ts:33) and `journal_mode` (`SQLITE_AUTH`; `foreign_keys = on`, src/database.ts:34, works and reads 1); rows over 8 MB (the `image` table keeps bytes); 100 parameters for each query |
| S4. D1 | Cloudflare | — | No transactions; the store opens many (src/store.ts:911) |
| S5. Shared MySQL or MariaDB (`@effect/sql-mysql2`) | Bun; Cloudflare through Hyperdrive | Many chats in shared tables (`store.md`, B3) | Through Hyperdrive: `disablePreparedStatements`, one statement for each query, no session state; `disableEval` is a pool option that Effect passes only without `url` (not run) |

## What fits, what does not

**P1, one core and a host for each runtime.** It is the only option that keeps
one chat logic. Most of the core is neutral already (Today); the work is the
import graph, not the logic.

**Many tenants in one Bun process** (no `shell`, no files):

| Part | What keeps tenants apart | What does not | A test that can prove it |
| --- | --- | --- | --- |
| A program's state | Each program has a new QuickJS engine with its own WebAssembly memory, in its own worker thread (README, "How it works") | A pool of kept threads would add host code that outlives a tenant (`functions.md`) | Tenant A's program sets a global; B's next program cannot see it |
| Secrets | Each function closes over its tenant's secret; the program never holds it (`functions.md`, S1) | One heap: a defect's text reaches the program (src/sandbox.ts:151); `process.env` is one for all (src/gateway.ts:89) | A function that fails with the secret in its error; the program's result and the database have no secret |
| The store's queries | A chat key on each query (`store.md`, B3) | On MySQL nothing else: no row-level security | Two tenants; every `Store` method with A's handle returns none of B's rows |
| Memory | 512 MiB for each engine | The process's heap is one; N programs can take N x 512 MiB | A runs K large programs; admission (`acquireWorker`) refuses A's next one, and B's program still starts |
| A program that computes long | Its own thread: the main thread stays free (`runtime.md`) | Cores are shared, with no quota; the compute limit restarts | A spins with a function not awaited; B's turn answers in time, and a total budget stops A |
| A crash | Each chat restarts from its database | A crash of Bun ends every tenant of the process | Kill the process during two tenants' turns; after the restart both go on, each with its own log |
| Process values | — | `pid` and host as the owner (src/store.ts:922), `process.cwd()` (src/functions.ts:149), files under `os.tmpdir()` (src/limit.ts:104) | Two chats in one process with two keys; a fake gateway sees each request with its own key |

**The seams.** Each row is a service with more than one implementation.

| Seam | Implementations | Its interface must not expose | Today |
| --- | --- | --- | --- |
| The chat's database (`SqlClient` for `Store`) | S1 or S2 (local), S5 (hosted Bun), S3 (`workerd`) | A file path; a pid; a synchronous call; raw `BEGIN`; `synchronous` or `journal_mode`, which S3 refuses | `Store.layerNoDatabase` (src/store.ts:629); `synchronous = full` at src/database.ts:33 (`foreign_keys`, src/database.ts:34, runs on S3) |
| The engine for programs (`Sandbox`) | E1 (Bun, Node), E3 (`workerd`); E2 for tests | A worker URL, a WebAssembly path, a timer; the budget is the engine's parameter | `run(program, at)` (src/sandbox.ts:117) is neutral; the implementation is not |
| Secrets (the gateway's key, each function's token) | Environment and home (local); a store for each tenant (hosted) | `process.env`, a home path, the value to a program | src/gateway.ts:89 |
| The set of functions | Local (`shell`, `read`, `write`, `edit` and the rest); hosted (network calls) | `node:fs`, a work directory | `Functions` imports `shell.ts` and `files.ts` (src/functions.ts:28) |
| The host: loads a chat, takes a message, sends events | Local launch (one chat, a PTY); Bun hosted (a lease with an epoch, `agents.md`); a Durable Object for each chat | A pid, a signal, `Stdio`, `process` | src/main.ts:136 builds one chat; src/main.ts:275 owns the signals |
| Hashes and bytes | `node:crypto` `createHash` (the same on all three, run); `Buffer` | `Bun.CryptoHasher`; Web Crypto's `async` digest where today's code is synchronous | src/store.ts:1072, src/cache.ts:171 |
| Text assets | A TypeScript module that exports the text | An import attribute that Node refuses | src/head.ts:24 |

The smallest smoke test, one body for each host: a fake wire (no model) answers
with one program that calls one fake function, then with a text. One message
with an outside key goes in; the log has `user`, `tool`, `echo`, `asst`; the
call row is `done`; the events are `accepted`, `start`, `call`, three `message`s
and `end`, numbered 1 to 7 in that order; a listener that reads again from 3
gets 3 to 7 and drops none as a duplicate; the same message again adds nothing.
Bun: `bun test`. Node: E1 and S2. `workerd`: a chat object with S3 that calls a
sandbox object of a second Worker by RPC (E3), both under a local `workerd`
(`wrangler dev --local`: not run with two Workers), or Cloudflare's Vitest pool,
which "runs your Vitest tests inside the Workers runtime" (object SQLite in it:
not proved); E2 only for unit tests.
https://developers.cloudflare.com/workers/testing/vitest-integration/

**The hosted shape on Cloudflare.** A Durable Object for each chat, with S3 as
its database. The object is the single owner by its name, so it needs no lease
and no epoch (`agents.md`'s hardest part); an idle object hibernates; an alarm
restarts cut work. A message gets in by RPC to `CHAT.getByName(chat)`; the
object writes it with its outside key in one transaction, then says `accepted`
(that the answer waits for the write: not proved for SQL, Facts). Log ids number
messages only: `start`, `call` and a `done` end log none (src/turn.ts:355,
src/turn.ts:262, src/turn.ts:251). So each event of src/turn.ts:108 but a piece
gets a row `(chat, n)`, `n` from the object (the one writer), in the transaction
of what it reports (`accepted` and `start` with the message and the turn's row,
src/turn.ts:442; a `message` row names its log id): seven numbers for the smoke
test's turn. An alarm pushes the rows from the last acknowledged `n` (at least
once, with retries) or sends them to a queue; a listener drops a seen `n`,
restores the order that Queues does not promise, and reads again from its cursor
after a gap. This is option E1 of `docs/research/mysql.md`, measured there on
MySQL (its cost on S3: not proved). Pieces go on a WebSocket that the listener
holds to the object (best effort). The shared MySQL (Hyperdrive) holds only what
crosses chats: tenants, their chats, listener cursors. E3 is the engine: E2 held
every object locally.

**First, in this order:** (1) move each tag (`Store`, `Sandbox`, `Functions`) to
a file with no Bun import, and type-check the core with no Bun types, as the
guard; (2) `createHash` for `Bun.CryptoHasher`, modules for the text imports;
(3) a total compute budget for each program, so the bound means the same on each
runtime; (4) the Bun host with two chats in one process, and the smoke test; (5)
the `workerd` spike: one object, S3, E3, the same smoke test. Node then costs a
host and one CI run: S2 and E1 run there already.

## Limits

- `workerd`: no worker threads, no compile of WebAssembly at run time, no
  processes, so no E1, no `shell`, no file functions (Facts).
- Object SQLite: durability is Cloudflare's (no `synchronous = full`); an image
  over 8 MB cannot be one row. D1 cannot hold the store at all.
- Through Hyperdrive: MySQL `GET_LOCK` or other session locks: not stated, and
  the pool's transaction mode makes them unsafe to count on.
- An inline program holds its thread, so a host with more than one chat on a
  thread cannot use E2.
- E3 keeps the agent's object free, not other tenants' programs: many objects of
  one class "may run in the same isolate on the same physical machine and share
  the 128 MB of memory"; that a spin does not delay another sandbox object: not
  proved. Trial, on Cloudflare only (locally all waited): N sandbox objects, one
  spins to its budget, time a one-line program in each other.
  https://developers.cloudflare.com/durable-objects/platform/pricing/
- The budget is a count, not a time: 100,000 polls was 7.8 s here; the local
  `workerd` did not apply `cpu_ms`: only Cloudflare can test it.
- In one Bun process: no CPU quota or heap limit for each tenant, and one crash
  ends all; only a process or a microVM for each tenant gives these (`runtime.md`).

## Questions for the operator

1. On Cloudflare, is a chat's state in its object's SQLite or in the shared
   MySQL? Recommended: the object's SQLite (S3); MySQL only what crosses chats.
2. Which engine on Cloudflare? Recommended: E3, the same engine and prelude as
   on Bun; E4 only if programs need V8's speed.
3. One bound for a program on every runtime: a total compute budget (it replaces
   today's limit that restarts)? Recommended: yes.
4. Node: a host now, or only a core free of Bun? Recommended: only the core,
   checked by the type check; a Node host when a use needs it.
5. May one hosted Bun process hold competitors' chats with only the protections
   above, no OS boundary? Recommended: yes for the first version, with each
   named test in the check.
6. May a check install and run a local `workerd` (Wrangler as a development
   dependency)? Recommended: yes, a recipe of its own, not in `just full`.
7. Upgrade `effect` to 4.1.4 for `@effect/platform-cloudflare`? Recommended: no:
   the object is the single owner already, and `sql-sqlite-do` 4.1.2 is enough.

## Words

| Term | Meaning |
| --- | --- |
| tenant | A separate company whose tenant chats share a host and must be kept from other tenants (operator, 2026-11-14). |
| tenant chat | One chat of a tenant in the hosted use (`runtime.md`). |
| core | The services of a chat (memory, turns, wires, store logic) with no import of a runtime's API. |
| host | The code of one runtime that loads chats, gives them messages, and sends their events out. |
| seam | A service of the core with more than one implementation, one for each runtime or use. |
| engine | What runs a program: QuickJS in a worker thread, inline, in another object, or a Dynamic Worker. |
| interrupt budget | The count of interrupt polls that an inline or remote QuickJS engine allows a whole program. |
| Durable Object | Cloudflare's single-threaded object with a unique name and its own SQLite. |
