# AGENTS.md

## What this project is

EverChat is a hard fork of UniiChat.

- Upstream: https://github.com/VictorTaelin/uniichat
- Our fork: https://github.com/raymond-w-ko/everchat

EverChat is an LLM agent harness. Its core idea: the chat itself is the memory.
A chat never ends. A cheap model compresses the log into a tree
of summaries, and the agent zooms into that tree when it needs detail.

This codebase is yours: what it's for and how it's built are your call, and
you'll keep building on it.

## Words

[GLOSSARY.md](GLOSSARY.md) is the dictionary of this project. Read it first.

## Tools

- [Bun](https://bun.sh) stays the runtime, package manager, test runner, and
  bundler of the project. Do not use npm, yarn, pnpm, or Deno.
- [just](https://github.com/casey/just) is the command runner. Put common
  tasks in the `justfile` as recipes.
- [Effect](https://effect.website) (the `effect` package, version 4.1.2) is
  the library we write the program with. It stays at 4.1.2: the Cloudflare
  build needs no upgrade [Q38]. See "Use Effect as much as possible"
  below.
- TypeScript (`tsc`) checks the types. Bun runs the code without a check, so
  `just check` is a separate step; the `justfile` names its programs. The
  tools' program leaves out `tools/golden.ts`, which imports the old code in
  `ref/`.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Layout

The new code is a Bun workspace (`"workspaces"` in the root `package.json`)
with six packages, each in `packages/<name>/` with its own `package.json`.
A package's entries are the keys of its `exports` (see "Be modular").
Each package's own matter, its entries too, is in its `AGENTS.md`:

- `packages/core/AGENTS.md`: `@everchat/core`, the core.
- `packages/openai/AGENTS.md`: `@everchat/openai`, the wire for OpenAI.
- `packages/sqlite/AGENTS.md`: `@everchat/sqlite`, the store on SQLite.
- `packages/codemode/AGENTS.md`: `@everchat/codemode`, the engines of the sandbox.
- `packages/local/AGENTS.md`: `@everchat/local`, the rest, the local build.
- `packages/server/AGENTS.md`: `@everchat/server`, the host of many chats over HTTP and WebSocket.
- `packages/<name>/src/x.test.ts`: the tests of one module sit next to it
  (`x.ts`), in its package. A test goes with the code that it tests.

Today five of them exist: `@everchat/core`, `@everchat/openai`,
`@everchat/sqlite`, `@everchat/codemode` and `@everchat/local` ("Be modular" has all nine).
Each of the three cut out of `local` holds less than its row says:
`openai` has the wire for OpenAI and none for Anthropic, `sqlite` an
entry for Bun only (`./bun`), and `codemode` two engines, `./thread`
(the engine in a worker thread) and `./inline` (the engine in the
caller's own thread), but none in a separate Worker.
`mariadb`, `server`, `cloudflare` and `wakeups` do not exist yet.

Run the full check (see "Checks") before you say that a change is done.

After a change to the sandbox, the build, or the dependencies, run
`just test-build`: `just test` runs from source, and does not show a
fault that only the executable has.

File names are lowercase. Multi-word names are written as one word
(`askai.ts`, `openai.ts`).

The rest:

- `docs/`: the design documents.
- `docs/notes.md`: facts about the tools that cost time to find. Read it
  before you work on the store, the inspector, or their tests.
- `tools/`: scripts outside the packages, which import them by their names
  (the root `package.json` names all five); `just check` checks the types of
  all but `golden.ts` (`tools/tsconfig.json`). `tools/graph.ts` is a step of
  `just check` (see "Be modular"), and `tools/graph.test.ts` its tests.
  `tools/golden.ts` makes `packages/local/tests/golden.json` from the old
  code. `tools/probe.ts` sends real requests to a vendor (see "Model access
  through the author's inference gateway"). `tools/sample.ts` makes a chat
  with no model, to look at in the inspector (`just sample <home>`).
- `ref/`: the old code, for reading only, outside the packages. See
  `docs/history.md`, "A rewrite, in place". It has the old layout inside (`ref/src/`,
  `ref/tests/`), and also the old site (`ref/web/`), the old iOS app
  (`ref/ios/`, which follows Swift naming), and the old `README.md`,
  `ISSUES.md`, and `justfile`.
- The old code is in `ref/`. The git tag `before-rewrite` marks the last
  commit before the move. `ref/` is for reading only: do not edit it, and do
  not import from it. Keep it out of the build, the type check, and the tests
  (`bunfig.toml` keeps it out of `just test`). When the new code no longer
  needs it, we delete `ref/` in one commit.
- The old code still runs from inside `ref/`. `cd ref && just test` runs its
  tests. Use this to compare the port with the old behavior.
- The documents in `docs/` that describe the old code cite its files without
  `ref/` (for example `src/memory.ts`). Read such a path as a path in `ref/`.
  The line numbers stay exact, because `ref/` does not change.

## Checks

- Full check: `just full`, about 150 s (near 60 s of it are the adopted
  tests under `packages/codemode/tests/pi`; 228 s was measured once, on a
  loaded machine).
- Scoped check: `just scoped <test files>`, for the files of one change,
  with their paths from the root (for example
  `just scoped packages/core/src/memory.test.ts` or
  `just scoped packages/sqlite/src/store.test.ts`). It runs `just check`
  first.
- Full check in a worktree: yes
- Worktree setup: `bun install --frozen-lockfile`

## Read before you work on

- a design change: `docs/design.md`, `docs/references/optchat.md`, `docs/history.md`.
- a part that the factory touches: `docs/factory.md`.
- the store or the inspector: `docs/notes.md`.
- the schema: `docs/schema.html`.
- a fault of `tools/graph.ts`: its header, and `docs/boundaries.md` for its accepted risks.
- a package: its `AGENTS.md`.

## Where we are going

Our goal is to make EverChat "battle hardened" and fit our own needs:

- Correct under failure: crashes, partial writes, network errors, bad model
  output.
- Tested: each fix comes with a test that fails without the fix.
- Clear: code and docs that a new reader can follow.
- Shaped to our use, even when that means we diverge from upstream.

This is the high-level goal. `docs/design.md` holds its settled design. Each
step toward it still needs its own design, inside that one.

A real run needs the owner's yes first. Do not start a run of EverChat with
a real model (a chat, in either interface, that sends requests to a real
model), and do not deploy to the owner's Cloudflare account, until the
owner has said yes. In the factory, that yes is an approval card [Q53]
(`docs/design.md`, "The goal and the order"). A run with a fake vendor, as
in the tests, needs no yes. A probe (`tools/probe.ts`) is not such a run:
it keeps its own rule, the list of probes by vendor in the section on
model access, below.

To run the program by hand against no real model, start a fake vendor, give
its address as `EVERCHAT_GATEWAY_URL`, and name a new home with
`EVERCHAT_HOME`, as these tests do. `just run` with neither sends real
requests through the inference gateway and writes the chat in `~/.everchat`,
the person's own chat.

### How EverChat will be used

Keep all the uses in mind: subagents must be cheap and solid, and nothing in
the core may need the factory, or one host.

How the factory runs a harness, and what it needs from one: `docs/factory.md`.

### Use other libraries where they fit

Use a library instead of handwritten code where it does the job and does not
take control that the memory needs:

- Code mode is EverChat's own code: the code of `pi-codemode` 1.5.2 (from the
  [pi libraries](https://github.com/earendil-works/pi),
  `@earendil-works/pi-*` on npm; MIT), adopted. The engine's part is in
  `packages/codemode/src/pi`, the core's part in `packages/core/src/codemode`,
  each with its notice `LICENSE.md`. Each change of it is listed in the notice
  and gets one review from each vendor. A correction of upstream is merged by
  hand: the notice says how to see them.
- `pi-tui` for the terminal's screen and keys (see "The terminal and pipe
  mode" in `packages/local/AGENTS.md`).
- `pi-schema` for JSON Schema that comes from outside (a provider's
  definitions): the engine does not check it [Q45].
- For MCP, the official SDK, not `pi-mcp` for now: `pi-mcp` speaks only an
  old version of the protocol [Q45].
- Other pi packages where they fit. Check each one against our needs before
  you adopt it.

### Be modular

Each part must have a clear boundary, so that we can test it alone and replace
it. In particular, the core (the memory and the agent loop) must not depend on
the server, the web, accounts, or billing. In the old code the chat logic
lives in `ref/src/server.ts`, so this is a large change.

The nine packages of the design (`docs/design.md`, "Packages"), and what each
may import:

| Package | Holds | May import |
| --- | --- | --- |
| `@everchat/core` | the memory, the turn loop, requests, the cache, the head, the tags of the seams | `effect` |
| `@everchat/openai` | the wire for OpenAI; Anthropic's comes next to it | `core` (its requests) |
| `@everchat/sqlite` | the store on SQLite: an entry each for Bun, Node and a Durable Object | `core` |
| `@everchat/mariadb` | the store on MariaDB | `core`, `@effect/sql-mysql2` |
| `@everchat/codemode` | the engine: in a worker thread, or in a separate Worker | `core`, `quickjs-wasi` |
| `@everchat/local` | the terminal, the shell, the files, the inspector, the executable | `core`, `openai`, `sqlite`, `codemode`, `pi-tui`, `@effect/platform-bun` |
| `@everchat/server` | HTTP and WebSocket, the lease, the provider | `core`, `openai`, `mariadb`, `codemode` |
| `@everchat/cloudflare` | the Durable Object of a chat | `core`, `openai`, `sqlite`, `codemode` |
| `@everchat/wakeups` | reminders and routines, optional | `core` |

The rules that keep the boundaries:

- No relative import leaves its package. Import another package by its name
  and an entry of its `exports` (`@everchat/core/memory`). `exports` is the
  package's contract: one entry for each module that another package may
  import, each a `.ts` source. A module that another package needs gets its
  entry; the core has no index that loads all of it.
- A dependency goes in the `package.json` of the package that imports it,
  at an exact version (`"effect": "4.1.2"`); a dependency that only the
  tests use is one of its `devDependencies`. Another package of the
  workspace is `"workspace:*"`. After a change of a manifest, run
  `bun install`, so that `bun.lock` and `node_modules` fit it.
- When `tools/graph.ts` fails, fix the import that its line names: declare the
  dependency, import by the package's name and an entry, or keep the code
  that needs a module out of the core.

### Greenfield: no backward compatibility

- The project is greenfield. No user and no stored chat depends on today's
  code, schema, file formats, commands or interfaces.
- A full refactor or a rewrite of any part is authorized when it gives better
  code. Do not keep an old interface, a shim, a flag or a migration path only
  for compatibility.
- Invest in good code now: a clean, modular design comes before a small change.
- What still holds: the checks must pass, each schema change is designed and
  tested ("All state in the chat's database"), and the factory's harness
  interface must still be met ("How EverChat will be used").

### All state in the chat's database

The rule: the program writes its state to the database. The person writes the
config file by hand, and the program only reads it. Do not keep state in
other files, in other directories, or only in memory, unless you write down
why.

The schema (the rest of its rules: `docs/schema.html`; the SQLite file: `packages/sqlite/AGENTS.md`):

- Design the schema before the code that uses it. Each table has a written
  purpose, and each schema change is designed and tested.

### Model access through the author's inference gateway

For now, every request to a model goes through the author's inference gateway, with an
API key, for both vendors. The program reads the inference gateway's address and key
from its environment (`EVERCHAT_GATEWAY_URL`, `EVERCHAT_GATEWAY_KEY`). When
they are not there, it reads `$HOME/.config/ai/proxy.json` (this path on
Windows too). That file has two keys, `base_url` and `api_key`.

The values are secrets. Do not print them, do not log them, and do not put
them in the database. To learn the file's shape, read its key names only.
The same holds for the file `.env` in this repository, which holds the keys
of other services for probes (`OPENROUTER_API_KEY`). Git ignores it. Bun
reads it into the environment of every `bun` command.

The repository is public. In each file, test and commit message, name the
inference gateway only as "the inference gateway" or "the author's inference
gateway". Do not write the name of its program or of its host, and do not
say how it routes requests or signs in. If you are about to write one of
these, write "the inference gateway" instead. A seat can edit the passages
about the gateway. This rule holds for each edit.

A check holds the rule: `just check` fails when a file of the tree holds a
word of the owner's list, in any letter case (`tools/words.ts`). The list is
a file outside the repository, `$HOME/.config/ai/never.txt`; with no list
the check says so and passes. Its message gives the place and never the
word. A hook does the same for a commit message (`just hooks` turns it on in
a clone).

Signing in with a ChatGPT plan comes later. Its tokens will then go in the
database, because the program writes them.

Each request carries the chat's id (`chat.uuid`): as the header
`X-Session-ID`, which the inference gateway needs, and as the vendor's cache key. Without
the cache key, requests read almost nothing from the prompt cache.

Tests use fake vendors: `just test` sends nothing to a real model. Real
requests are for probes only (`tools/probe.ts`), to learn how a vendor
behaves where its documents are silent:

- OpenAI: allowed, within reason. Keep a probe small, use a cheap model, and
  write down what it showed (`docs/api-audit.md`). A probe can go through
  the author's inference gateway, or through OpenRouter (`PROBE=openrouter`), which reaches
  OpenAI's plain API. The two routes do not behave the same.
- Anthropic (Claude): needs the owner's explicit approval each time.

Which route is for what:

- Day to day, EverChat runs through the author's inference gateway. That
  route removes the cache marks, and its cache finds a request by the cache
  key. The wire may carry code for what this route needs.
- The cache design is tested through OpenRouter, because the plain API
  respects every cache mark and reports cache writes. A change to where the
  marks go needs a probe there.

### Use Effect as much as possible

Write the new code with Effect. In particular:

- Model each part (the store, the memory, the vendor wires, the agent loop,
  the terminal, the hooks) as a service with a layer. A test can then replace
  any part with a fake.
- Give errors types (`Schema.TaggedError`), so that a failure such as a
  network error or bad model output is part of the function's type.
- Describe the data that crosses a boundary (database rows, vendor requests
  and replies, the config file, hook payloads) with `Schema`, and decode it
  at the boundary.
- Use Effect's resource scopes, fibers, and retries for open files, the
  database, running requests, and interrupts, not hand-written versions.
- Use Effect's own modules (for example `effect/sql`, `effect/cli`) before
  other libraries, where they fit.
- Do not write to stdout or stderr (`console.log`, `process.stderr`). EverChat
  is one process in a terminal, and such a line breaks the screen. Two modules
  may: `packages/local/src/main.ts`, and only when the screen is not up (the
  usage and what else `effect/cli` prints, the reason why the program could not
  start, and the inspector's address), and `packages/local/src/pipe.ts`, whose
  output is the standard output. To say something about the program's own work,
  log it with Effect (`Effect.logWarning`, `Effect.logError`), with the
  module's name as the annotation `source`. The logger writes it to the table
  `log` (`packages/core/src/diagnostics.ts`). That file also says where the
  logger's layer must go, so that every fiber has it.
