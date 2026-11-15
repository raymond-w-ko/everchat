# Packages: how `pi` lays out its packages, and a layout for EverChat

The operator wants EverChat cut into packages with clear boundaries and APIs
that others can use piece by piece, as `~/src/pi` has under `packages/`. How
does `pi` do it, what keeps its boundaries, and what helps or hurts there?
Which of its packages can EverChat use? How do Bun workspaces work with `bun
test`, `tsc`, `bun build --compile`, Node and `workerd`? Which cut fits the
core and the three builds? It decides nothing. It builds on
`docs/research/portability.md` and does not repeat it. The operator's decisions
of 2026-11-14 and 2026-11-15 are given.

## Today

EverChat is one package: one `package.json` with six dependencies and no
`"type"` (Node warns `MODULE_TYPELESS_PACKAGE_JSON` at each load), one
type-check program over `src` and `tests` with the Bun types (`tsconfig.json`;
`justfile` `check`), and one executable from two entrypoints (`justfile`
`build`). `src/` is flat (`AGENTS.md`, "Layout"). What binds the files:

| Coupling | Where | What it means for a cut |
| --- | --- | --- |
| The `Store` tag and its SQLite driver are one import | src/store.ts:31 imports src/database.ts:21 (`@effect/sql-sqlite-bun`) | Every importer of the tag loads `bun:sqlite` (`portability.md`) |
| The memory needs the store | src/memory.ts:41, src/memory.ts:596: it uses 9 members (`append`, `messages`, `node`, `putNodes`, `view`, ...) of a tag with about 43 (src/store.ts:486, src/store.ts:576; a count by `grep`) | "Only the memory" needs a smaller store interface, or all of `Store` |
| The store's SQL is neutral | src/store.ts:30 uses `SqlClient` of `effect/sql`; only src/database.ts:21 names a driver | The SQLite SQL can live apart from each driver |
| The turn loop loads the engine and the head | src/turn.ts:63 to src/turn.ts:69 (`Ask`, `head`, `Limit`, `Memory`, `Sandbox`, `Store`) | The turn loop is the center: it imports most of the core |
| The head joins the functions and the prompt | src/head.ts:23 (`DECLARATIONS` of `functions.ts`), src/head.ts:24 (`prompt.txt` as text) | The head moves with the core; the text must be a module (Node refuses the import) |
| The set of functions holds the local ones | src/functions.ts:29 (`files.ts`), src/functions.ts:32 (`shell.ts`) | The `Functions` tag must leave the local functions behind |
| The engine finds its two files by path | src/sandbox.ts:47 (QuickJS, `type: "file"`), src/sandbox.ts:67 (`worker.ts` by `import.meta.url`) | The worker thread's file must stay next to the executable's first entry |
| A long result goes to a file | src/limit.ts:104 (`os.tmpdir()`) | The cap is core; the file copy is local |
| The read module knows the host | src/inspect.ts:290 (`os.hostname()`, the pid) | The inspector is local |
| One chat is built from values | src/main.ts:135 (`layer`) | The seed of each host |
| Tests import by path | tests/help.ts:9 to tests/help.ts:18 (`../src/...`); src/sandbox.test.ts:21 reads `../node_modules/quickjs-wasi/package.json` | Paths change in a split |

A run (Node 24.22.2, no flags): Node loads `diff.ts`, `pages.ts`, `pace.ts`,
`request.ts`, `cache.ts` and `follow.ts` from `src/` by type stripping;
`memory.ts` fails (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, "Received protocol
'bun:'") through src/store.ts:31. A search found no `enum`, `namespace` or
parameter property in `src/` (`grep`, not a type check): erasable syntax.

## Facts

**pi's packages** (checkout `1818f3d`, 2026-11-14; size: lines and files of
`.ts` under `src/`, by `wc`; "pi deps": the other `@earendil-works/*` only).

| Package | For (its own words, shortened) | pi deps | `exports` | Size | Source |
| --- | --- | --- | --- | --- | --- |
| `pi-telemetry` | Telemetry contracts, a no-op and an in-memory adapter; "no exporter" | none | `.`, `/render`, `/testing` | 1,630 / 8 | pi:packages/telemetry/package.json:4 |
| `pi-schema` | "JSON Schema validation without eval" | none | `.`, `/formats` | 4,852 / 43 | pi:packages/schema/package.json:4 |
| `chord` | "Object runtime for apps across processes" | schema, telemetry | 26: `.` (Node and browsers), `/sqlite` (any adapter), `/sqlite/node`, `/sqlite/cloudflare`, `/http` (Node), `/web`, `/react` | 61,560 / 299 | pi:packages/chord/package.json:172, pi:packages/chord/README.md:16 |
| `pi-tui` | Terminal UI with differential rendering | none | none: `main` only | 20,062 / 46 | pi:packages/tui/package.json:6 |
| `pi-codemode` | Sandboxed JavaScript; "the only capability is calling injected tools" | none (`quickjs-wasi`) | `.` (worker thread), `/declarations`, `/source`, `/portable` (no Node imports), `/cloudflare`, `/worker` | 3,051 / 17 | pi:packages/codemode/package.json:8 |
| `pi-mcp` | "Standalone Model Context Protocol client" | none (`cross-spawn`) | `.`, `/oauth`, `/testing` | 4,746 / 28 | pi:packages/mcp/package.json:53 |
| `pi-ai` | LLM API for many providers, model catalog | schema, telemetry | 12, with `./providers/*`, `./api/*`, `./utils/*`, `/bun-oauth` | 29,097 / 211 | pi:packages/ai/package.json:81 |
| `pi-durable` | "Durable conversation, task, and document runtime" | chord, ai, codemode, schema, telemetry | 18; storage `/memory`, `/indexeddb`, `/jsonl/node`, `/sqlite`, `/sqlite/node`, `/sqlite/cloudflare` | 35,610 / 102 | pi:packages/durable/package.json:160 |
| `pi-env` | Remote execution over SSH: a Rust daemon and its client | chord, durable | `.` | 2,575 / 9 | pi:packages/env/package.json:47 |
| `pi-agent-core` | A general agent with a transport abstraction | ai, schema | `.` | 2,548 / 6 | pi:packages/agent/package.json:25 |
| `pi-coding-agent` | The `pi` coding agent (binary `pi`) | agent-core, ai, codemode, mcp, tui | `.`, `/rpc-entry` | 78,801 / 265 | pi:packages/coding-agent/package.json:43 |
| `pi-evals` | Evaluations; private, not published | none | none | 1,447 / 5 | pi:packages/evals/package.json:4 |

Runtime code sits in its own files behind its own entries: for example the 40
files of `chord/src/node/` that import `node:*`, and `chord/src/sqlite/node.ts`.
A portable entry never imports them.

**What keeps the boundaries**, as each script reads:

| Script | What it enforces | Where |
| --- | --- | --- |
| `check-entry-graphs.mjs` | "Entry points are cost contracts": it walks the value imports of each listed entry (type imports do not count) across packages, and fails over a file budget or on a forbidden file. `pi-codemode`'s `.` must not reach `cloudflare.ts`; `/portable` and `/cloudflare` must not reach the worker-thread host or the file-based WebAssembly loader | pi:scripts/check-entry-graphs.mjs:3, pi:scripts/check-entry-graphs.mjs:60, pi:scripts/check-entry-graphs.mjs:185 |
| `check-runtime-deps.mjs` | Each value import of a public package names the package itself or one of its `dependencies`, `optionalDependencies`, `peerDependencies` (not `devDependencies`; `node:` and `cloudflare:` built-ins pass); a file that the build excludes but imports fails | pi:scripts/check-runtime-deps.mjs:26, pi:scripts/check-runtime-deps.mjs:38, pi:scripts/check-runtime-deps.mjs:126 |
| `check-ts-relative-imports.mjs` | No relative `.js` specifier in a `.ts` file (sources import `.ts`; the build rewrites them) | pi:scripts/check-ts-relative-imports.mjs:37 |
| `check-pinned-deps.mjs` | Each registry dependency in `dependencies`, `devDependencies` and `optionalDependencies` of every `package.json` is an exact version; `peerDependencies` are not checked (`chord`'s are ranges: `esbuild`, `react`, `ws`) | pi:scripts/check-pinned-deps.mjs:4, pi:packages/chord/package.json:176 |
| `check-browser-smoke.mjs` | esbuild bundles three entries for `platform: "browser"`; Durable's bundle must hold its portable storages and none of its `node.ts` adapters; the agent bundle holds one provider SDK only | pi:scripts/check-browser-smoke.mjs:45, pi:scripts/check-browser-smoke.mjs:79, pi:scripts/check-browser-smoke.mjs:127 |
| `check-package-install.mjs` (not in `check`) | Packs each package and installs it alone in an empty consumer | pi:scripts/check-package-install.mjs:12 |
| `check-released-changelogs.mjs` (CI only) | Released sections of each changelog equal the newest tag's | pi:scripts/check-released-changelogs.mjs:9 |
| `check` | Formats, the checks above that it names, one `tsc --noEmit` over all packages with the Node types, the browser smoke | pi:package.json:20, pi:tsconfig.base.json:21 |

**Build, versions, tests, AGENTS.md:**

| Subject | What `pi` does | Where |
| --- | --- | --- |
| Build | Each package: `tsc -p tsconfig.build.json` into `dist/`. The root: 11 builds in one order, written by hand | pi:packages/codemode/package.json:46, pi:packages/codemode/tsconfig.build.json:4, pi:package.json:15 |
| Sources while developing | A custom `source` condition in `exports`, which Vitest reads. The same map of entries to sources again in the root `paths`, in Vitest aliases, and in the walker's own list. `pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` have no `source` condition (`grep`) | pi:packages/codemode/package.json:10, pi:packages/codemode/vitest.config.ts:9, pi:tsconfig.json:7, pi:vitest.base.ts:4, pi:scripts/check-entry-graphs.mjs:21 |
| `dist/` first | "Run `npm run build` whenever something needs built output"; Durable "imports pi-ai's `utils/*`, which have no source export" | pi:AGENTS.md:49 |
| Published tarball | `source` names `./src/index.ts`, but `files` is `dist` and `README.md`: EverChat's `node_modules/@earendil-works/pi-codemode` has no `src/` | pi:packages/codemode/package.json:40 |
| Versions | Lockstep: the sync fails when two public packages differ; `version:patch` bumps all. On npm the eleven public packages (all but `pi-evals`, which npm does not have) are 1.5.2, published 2026-11-10 from 12:20 to 12:25 UTC (https://registry.npmjs.org/@earendil-works/pi-mcp, the same for each). The 1.5.2 sections of the `telemetry`, `schema`, `codemode`, `mcp` changelogs are empty | pi:scripts/sync-versions.js:44, pi:package.json:43, pi:packages/telemetry/CHANGELOG.md:5 |
| Changelogs | One for each package; entries under `## [Unreleased]`; released sections fixed | pi:AGENTS.md:129, pi:AGENTS.md:136 |
| Tests | `npm test` runs each workspace's `test`; `./test.sh` with an empty environment and a temporary home; one file from the package root | pi:package.json:40, pi:test.sh:87, pi:AGENTS.md:52 |
| A change | `npm run check`; erasable syntax only; exact versions; no inline import | pi:AGENTS.md:47, pi:AGENTS.md:25, pi:AGENTS.md:62, pi:AGENTS.md:22 |

**The six candidates, read:**

| Package | What its files say | Where |
| --- | --- | --- |
| `pi-mcp` | No official MCP SDK, no other pi package. The root re-exports the stdio transport, which imports `node:child_process` and `cross-spawn`. The HTTP transport calls `fetch` without a receiver, because Workers refuse it otherwise | pi:packages/mcp/README.md:3, pi:packages/mcp/src/index.ts:82, pi:packages/mcp/src/transports/stdio.ts:1, pi:packages/mcp/src/transports/streamable-http.ts:266 |
| `pi-schema` | Builds and checks JSON Schema "without `eval`", no dependencies | pi:packages/schema/README.md:3 |
| `pi-telemetry` | The root is "suitable for Node.js, Bun, browsers, and workers" | pi:packages/telemetry/README.md:519 |
| `pi-durable` | "Experimental"; storages: memory, IndexedDB, SQLite, JSONL, a Durable Object; a table prefix option; portable cores "run without Node APIs, for example on Bun"; needs `pi-ai` | pi:packages/durable/README.md:3, pi:packages/durable/README.md:1012, pi:packages/durable/README.md:1024, pi:packages/durable/README.md:1041 |
| `chord` | Objects in many processes, a store, links, plugins, HTTP; a portable SQLite facade with Node and Durable Object adapters | pi:packages/chord/README.md:3, pi:packages/chord/README.md:37 |
| `pi-env` | Tools on another machine through a daemon over SSH | pi:packages/env/README.md:3 |

**Runs** (this machine; Bun 1.4.4, TypeScript 7.0.2, Node 24.22.2, Wrangler
4.162.0 with `workerd` 1.20261113.1; no account, no model). A workspace in
`/tmp/ec-sagu/ws/`: `core` (with `effect` 4.1.2, no runtime API; `exports` name
`.ts` files), a Bun host, a Node host, a Cloudflare host.

| Run | Result |
| --- | --- |
| `bun install` (lockfile `configVersion` 1) | The isolated linker: each package's own `node_modules` holds only its declared dependencies; one copy of `effect@4.1.2` for all. The root's `node_modules` stays above each package (Other sources) |
| `bun test --isolate` at the root; in `packages/core`; one file by path | Finds the tests of every package; works in a package; works for one file |
| `bun` runs the host: `@ec/core` from its `.ts` sources, a text import, a worker thread | Works. No build step |
| `bun build --compile` of the host's two entries, run from `/` | 253 modules; the executable runs, the worker thread too |
| `node` runs the Node host from source | Works: the workspace link resolves to `packages/core`, outside `node_modules` |
| An outside project: `bun pm pack` of `core`, `bun add` of the tarball | Bun runs it; Node: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |
| An import of a sibling package that only `cf` declares (`pi-schema`), and of a path not in `exports` | Bun: "Cannot find module"; Node: `ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`; `tsc`: TS2307 |
| An import in `core` of `typescript`, which only the root declares (review ec-hd8t; again in `/tmp/ec-b4jt/`, also with `hoist = false`) | Bun, Node and `core`'s own `tsc` all accept it. pi's `check-runtime-deps.mjs`, run on the workspace, refuses it: "typescript is not declared in @ec/core's runtime dependencies" |
| A relative import into another package (`../../core/src/prompt.ts`) | Bun, Node and `tsc` all accept it |
| One `tsc` program (Bun types) with `Bun.spawn` and `node:fs` in `core` | Passes |
| `core`'s own program (`"types": []`) | Refuses `Bun` (TS2868) and `node:fs` (TS2591); refuses `TextEncoder` (TS2304) until `"lib"` has `DOM` |
| `tsc -b` with project references (`composite`, `emitDeclarationOnly`) | Builds both, writes `.d.ts` files |
| A test with `node:test` and `node:assert` | Passes under `bun test` and `node --test`. A `bun:test` file fails on Node (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) |
| `pi-mcp` (a client over its in-memory pair, one tool listed and called), `pi-schema` (a check), `pi-telemetry` (an in-memory context), on Bun, Node, `workerd` | The same result on all three; on `workerd` also with no `nodejs_compat` |
| `wrangler deploy --dry-run --outdir` (needs no account) | 369.85 KiB. No `node:child_process` in it: 5 files of `pi-mcp` are in. Its `package.json` says `"sideEffects": false` (pi:packages/mcp/package.json:25); that this is why: not proved |

**Other sources:**

| Source | It says |
| --- | --- |
| https://bun.com/docs/install/isolated | "Isolated installs are the default for new workspace/monorepo projects (with configVersion = 1 in the lockfile)"; also with `install.hoist = false`, the root's "direct dependencies, publicHoistPattern matches, and workspace packages" "stay resolvable" |
| https://bun.com/docs/install/workspaces | "When publishing, Bun replaces `workspace:` versions with the package's package.json version" |
| https://nodejs.org/api/typescript.html | Node "refuses to handle TypeScript files inside folders under a node_modules path" |
| https://developers.cloudflare.com/workers/runtime-apis/web-standards/ | Workers: "the following are not allowed: eval() new Function WebAssembly.compile ..." |

## Options

Today's files go as below; new code is in italics. All three put the SQLite
SQL (`store.ts`, `migrations.ts`) apart from its drivers, as `effect/sql`
allows (Today). "None" as runtime APIs means `effect` and web standards only.

**F. Few, large (4 packages).**

| Package | Holds | May import | Runtime APIs |
| --- | --- | --- | --- |
| `core` | `memory`, `pages`, `request`, `cache`, `ask`, `openai`, `compactor`, `turn`, `head` (prompt as a module), `follow`, `pace`, `diagnostics`, `store` and `migrations` (SQLite SQL), the cap of `limit`, the tags `Store`, `Reads`, `Sandbox`, `Functions`, a secrets tag | `effect`, `pi-codemode/declarations` | none |
| `local` | `main`, `terminal`, `paint`, `pipe`, `shell`, `files`, `diff`, `gateway`, `inspect`, `inspector`, `sandbox` (worker thread), `worker`, `database` (`bun:sqlite`), the file copy of `limit`; `tests/` | `core`, `pi-tui`, `pi-codemode`, `@effect/platform-bun`, `@effect/sql-sqlite-bun` | Bun, `node:*` |
| `server` | *HTTP in and out, the lease and epoch, the MariaDB store, secrets for each tenant* | `core`, `@effect/sql-mysql2` | Bun |
| `cloudflare` | *A Durable Object for each chat, its SQLite, the remote engine* | `core`, `@effect/sql-sqlite-do`, `pi-codemode/cloudflare` | `workerd` |

**M. In between (9 packages).**

| Package | Holds | May import | Runtime APIs |
| --- | --- | --- | --- |
| `core` | `memory`, `pages`, `request`, `cache`, `ask`, `compactor`, `turn`, `head`, `follow`, `pace`, `diagnostics`, the cap of `limit`, the tags. Entries `.`, `/memory`, `/turn`, `/request` | `effect`, `pi-codemode/declarations` | none |
| `openai` | `openai.ts` (a wire); later `anthropic` beside it | `core/request` only | `fetch` |
| `sqlite` | `store.ts`, `migrations.ts`; entries `/bun` (`database.ts`), `/node` (`@effect/sql-sqlite-node`), `/durable-object` (`@effect/sql-sqlite-do`) | `core` | each entry its own |
| `mariadb` | *The store on MariaDB with prefixed tables* (`mysql.md`) | `core`, `@effect/sql-mysql2` | Bun (Node: not run) |
| `codemode` | `sandbox.ts`, split: `/thread` (with `worker.ts`; Bun, Node), `/remote` (`workerd`), `/inline` (tests) | `core`, `pi-codemode` | each entry its own |
| `local` | `main`, `terminal`, `paint`, `pipe`, `shell`, `files`, `diff`, `gateway`, `inspect`, `inspector`, the file copy of `limit`; `tests/`; the executable | `core`, `openai`, `sqlite/bun`, `codemode/thread`, `pi-tui`, `@effect/platform-bun` | Bun |
| `server` | *HTTP in and out, the lease, secrets for each tenant* | `core`, `openai`, `mariadb`, `codemode/thread` | Bun |
| `cloudflare` | *The chat's Durable Object* | `core`, `openai`, `sqlite/durable-object`, `codemode/remote` | `workerd` |
| `wakeups` | *Reminders and routines, optional, local first* | `core` | none in `.`; a timer seam |

**S. Many, small (about 20 packages).** One package for each concept:
`request` (with the row types of `store.ts` that every part names), `memory`,
`cache`, `ask`, `openai`, `turn`, `compactor`, `follow`, `pace`,
`diagnostics`, `store` (the tags only), `sqlite`, `mariadb`, `codemode`,
`localfunctions` (`shell`, `files`, `diff`), `terminal` (with `paint`,
`pipe`), `inspector`, `local`, `server`, `cloudflare`, `wakeups`.

| | F | M | S |
| --- | --- | --- | --- |
| Manifests, `tsconfig`s to keep | 4 | 9 | about 20 |
| Fits the seams of `portability.md` | The store driver and the engine stay inside each host | One package or entry for each seam | Yes, with more cuts than seams |
| Files that change together, in one package | Yes | Mostly (`turn`, `ask`, `compactor` together) | No: a change of a turn touches 4 to 6 packages |
| Cost | Least | A store tag apart from its driver (needed in all three) | Each row type in one package that all import; no cycles between packages |
| Rules out | A store or an engine for a person outside without a host's dependencies | Little | Little, at a cost |

**How a person outside uses one piece alone:**

| Piece | F | M | S |
| --- | --- | --- | --- |
| Only the memory | `@everchat/core/memory` and a `Store` layer of their own, or core's SQL with a driver that they name | `@everchat/core/memory` with `@everchat/sqlite/node` | `@everchat/memory` with `@everchat/sqlite` |
| Only a wire | `@everchat/core/openai`; an entry budget keeps the memory out | `@everchat/openai` | `@everchat/openai` |
| Only the store | `@everchat/core/store` and a driver layer | `@everchat/sqlite/bun` (or `/node`, `/durable-object`) | `@everchat/sqlite` |
| Only code mode | Not without `local` (Bun) | `@everchat/codemode/thread` or `/remote` | `@everchat/codemode` |

**How a check enforces the boundaries** (all options):

| Check | Catches | Proved here |
| --- | --- | --- |
| K1. One `tsc --noEmit -p` for each package, with its own `types` and `lib` (`core`: no Bun types) | A Bun or `node:` API in a package that may not use it | Yes: TS2868, TS2591 |
| K2. The isolated linker and `exports` | An undeclared sibling package; a path that is not an entry. Not a dependency of the root, a hoisted one or a workspace package | Yes: in Bun, Node and `tsc`; the root's `typescript` passed all three |
| K5. A manifest check, as pi's `check-runtime-deps.mjs` (pi:scripts/check-runtime-deps.mjs:26): each value import names a dependency of the package's own `package.json` | What K2 lets through: an import that works in the workspace and fails when the package is installed alone | Yes: refused the root's `typescript` |
| K3. An import walker, as pi's `check-entry-graphs.mjs` | A relative import out of a package; an entry that reaches a forbidden file (`openai` reaching `turn.ts`); a `node:` module not on a package's list | Needed: the relative escape passed all three |
| K4. `wrangler deploy --dry-run` of `cloudflare`; `core`'s tests under `node --test` | What the bundler or Node refuses | The dry run needs no account; `node:test` files run on both |

## What fits, what does not

**From pi, take:** `exports` as each package's contract, with one entry for
each runtime (`/node`, `/durable-object`), so that a portable entry never loads
a runtime file (as `pi-codemode` does; EverChat already uses
`pi-codemode/declarations`, src/head.ts:22); an import walker with budgets
(K3), the only check in the runs that saw a relative import across packages; a
manifest check (K5), since K2 lets root dependencies through; exact versions
(pi:AGENTS.md:62), so one `effect` serves all packages.


**Do not take:** a build before use (pi needs `dist/` for some tests, keeps
the entry map four times by hand, and publishes a `source` condition that
names files the tarball lacks), when Bun, Node and `workerd` all ran `.ts`
sources from a workspace with no build; a build order by hand
(pi:package.json:15); lockstep versions while nothing is published (the empty
1.5.2 sections); one type-check program for all packages (pi:package.json:20),
which the run shows cannot see a Bun API in the core. K1 is what
`portability.md`'s first step ("type-check the core with no Bun types") needs.

**pi packages for EverChat:**

| Package | Runs on | Would bring | Fit |
| --- | --- | --- | --- |
| `pi-mcp` | Bun, Node, `workerd` (Runs: only its in-memory transport); stdio needs processes (local); HTTP on `workerd`: not proved | MCP servers as functions, OAuth | Not now: it speaks MCP 2025-11-25 (pi:packages/mcp/src/protocol/types.ts:4) and sends arguments unchecked (pi:packages/mcp/src/client.ts:384); `docs/research/function-sources.md` takes the official SDK v2 and checks with `pi-schema`. Again when `pi-mcp` speaks 2026-07-28 |
| `pi-schema` | Bun, Node, `workerd` (Runs) | Checks of a JSON Schema that comes from outside at a load (MCP tools, a hosted set of functions), with no `eval`, which Workers forbid | Only for schemas from outside; Effect `Schema` stays for our own data (`AGENTS.md`) |
| `pi-telemetry` | All three (Runs) | Spans and metrics contracts | No: Effect's logging and spans do this, and diagnostics are ours |
| `pi-durable` | Portable cores on Bun and in an object (README; not run) | A whole agent harness with its own transcript and compaction | No: it needs `pi-ai`, against "Our own vendor wires", and replaces the memory, EverChat's own idea; no MariaDB storage |
| `chord` | Root: Node and browsers (README); Bun: not proved | Objects across processes, a store, HTTP | No: it overlaps Effect (layers, `effect/sql`, `effect/http`) |
| `pi-env` | Node, with a Rust daemon | Functions on another machine over SSH | No for now: hosted chats have no shell; it depends on `pi-durable` |

**Which option first: M.** Only in M is each seam of `portability.md` (the
store's driver, the engine, the wire, the host) one package or one entry, so
each build is a host package and a list of implementations: local is `local`
with `sqlite/bun` and `codemode/thread`; server is `server` with `mariadb`;
Cloudflare is `cloudflare` with `sqlite/durable-object` and `codemode/remote`.
Each piece that a person outside asks for (the memory, a wire, the store) is one
import. F is cheaper, but the store is not a piece there. S cuts files that
change together, for no use that M does not give. Two decisions sit well in M:
`wakeups` as an optional package, and a head that takes a name and an appended
text (src/head.ts:24 becomes a module with two parameters).

**First, in this order:** (1) a workspace of two packages, `core` and `local`
(files as in M; the rest in `local`), `"type": "module"` in each, `just full`
green, K1 for `core`; this needs `portability.md`'s step 1 (each tag apart from
its Bun file) at the same time; (2) K3 (about 100 lines, after
pi:scripts/check-entry-graphs.mjs:103) and K5 as `tools/graph.ts` in `just
check`; (3) the core's tests on `node:test` and `node:assert`, run under `node
--test` too; (4) cut `sqlite`, `codemode` and `openai` out; then `mariadb`,
`server`, `cloudflare` (with K4) and `wakeups`, each as it is built.


## Limits

- A person outside, on Node, cannot import a package of `.ts` files from
  `node_modules` (Facts, Runs). To publish for Node, each package needs a build
  into JavaScript and `.d.ts`, with pi's costs. Programs on Bun, and bundlers,
  need none.
- No check sees everything: `tsc` sees types, the linker and K5 names, the
  walker imports. A runtime API reached through `globalThis` or a dependency's
  own import passes K1 and K3; only a run on each runtime shows it (K4,
  `portability.md`'s smoke test). K1's time on EverChat: not measured.
- A bundler drops unused modules (Runs); Bun and Node load every module of an
  entry. An entry that is portable only after a bundler is not portable.
- A `bun:test` file cannot run on Node; that `bun:test`'s mocks and snapshots
  have a `node:test` twin that runs on both: not proved.
- `src/worker.ts` must stay next to the executable's first entry (`AGENTS.md`,
  "Code mode"): in M it goes to `local` with `main.ts`, and `codemode/thread`
  takes its URL as a parameter.
- `ref/` and `tools/golden.ts` import the old code by path; they stay outside
  the workspace until `ref/` is deleted.

## Questions for the operator

1. Which cut first? Recommended: M (nine packages), in the order above.
2. Publish to npm in the first version? Recommended: no: each package
   `"private": true`, with `exports` designed as if public; a build into
   `dist/` for Node when a person outside asks.
3. Names: `@everchat/<name>` in `packages/<name>/`? Recommended: yes.
4. Versions and changelogs while unpublished? Recommended: `workspace:*` links,
   one version, no changelog for each package; lockstep at the first publish.
5. The core has "no runtime API", but `portability.md` picked `node:crypto`'s
   `createHash` for the hashes (src/cache.ts:171). Allow that one `node:`
   module in the core, on K3's list? Recommended: yes, as the one named
   exception: it ran the same on Bun, Node and `workerd`, and Web Crypto's
   digest is asynchronous where today's code is not.
6. The core's tests on `node:test` and `node:assert`, so that one file runs
   under both runners? Recommended: yes for `core`; the others keep `bun:test`.
7. `pi-schema` only for JSON Schema from outside, and which MCP client?
   Recommended: `pi-schema` yes; the SDK v2 first (`function-sources.md`).
8. K3 and K5 in `tools/`, in `just check`? Recommended: yes; K5 is required.

## Words

| Term | Meaning |
| --- | --- |
| package | A directory under `packages/` with its own `package.json`, `exports` and type-check program; a unit that another package may depend on. |
| workspace | The repository as a set of packages that Bun installs and links together (`"workspaces"` in the root `package.json`). |
| entry | One path of a package's `exports` (`.`, `/memory`, `/bun`): the only way in from outside. |
| entry budget | The files that an entry may reach, and the ones it must not, as an import walker checks them. |
| isolated linker | Bun's install mode in which a package's own `node_modules` holds only the dependencies that it declares; the root's dependencies and the workspace packages stay reachable. |
| build (one of three) | One way to run EverChat: local, server or Cloudflare; a host package and its implementations. |
| core, host, seam | As `portability.md` defines them: the services of a chat with no runtime API; the code of one runtime that loads chats; a service with more than one implementation. |
