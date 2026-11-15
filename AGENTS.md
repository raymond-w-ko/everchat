# AGENTS.md

## What this project is

EverChat is a hard fork of UniiChat.

- Upstream: https://github.com/VictorTaelin/uniichat
- Our fork: https://github.com/raymond-w-ko/everchat

A hard fork means we do not plan to merge back into upstream. We also do not
plan to track upstream closely. We can pull an upstream change when it is
useful. We do not have to.

EverChat is an LLM agent harness. Its core idea: the chat itself is the memory.
A chat never ends. A cheap model compresses the log into a tree
of summaries, and the agent zooms into that tree when it needs detail.

This codebase is yours: what it's for and how it's built are your call, and
you'll keep building on it.

## Words

[GLOSSARY.md](GLOSSARY.md) is the dictionary of this project. Read it first.
Use its names exactly, in code, in documents, and in replies. If you need a
name that is not there, add it there first. Its last section lists the words
that we do not use.

## Tools

- [Bun](https://bun.sh) stays the runtime, package manager, test runner, and
  bundler of the project. Do not use npm, yarn, pnpm, or Deno. The one place
  for Node: the core's checks also run on Node, to show that the core needs
  no Bun [Q14].
- [just](https://github.com/casey/just) is the command runner. Put common
  tasks in the `justfile` as recipes.
- [Effect](https://effect.website) (the `effect` package, version 4.1.2) is
  the library we write the program with. It stays at 4.1.2: the Cloudflare
  build needs no upgrade [Q38]. See "Use Effect as much as possible"
  below.
- TypeScript (`tsc`) checks the types. Bun runs the code without a check, so
  `just check` is a separate step. It runs one program for each package:
  the core's files with no Bun and no Node types
  (`packages/core/tsconfig.json`), the core's tests with the Bun types
  (`packages/core/tsconfig.test.json`), then `openai`, `sqlite`, `codemode`
  and `local`, each with its tests and with the Bun types for now
  (`packages/openai/tsconfig.json`, `packages/sqlite/tsconfig.json`,
  `packages/codemode/tsconfig.json`, `packages/local/tsconfig.json`). Then
  `tools/graph.ts` checks
  what the types do not see: the imports and the manifests of the packages
  (see "Be modular").

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Layout

The new code is a Bun workspace (`"workspaces"` in the root `package.json`)
with five packages, each in `packages/<name>/` with its own `package.json`.
A package's entries are the keys of its `exports` (see "Be modular"):

- `packages/core/` (`@everchat/core`): the core. Its modules, flat, are in
  `packages/core/src/`: the memory, the turn loop, requests, the cache, the
  head and the prompt, the cap of a result, and the tags of the seams (the
  store, the sandbox, the functions). It has no runtime API (see "Be
  modular"). `packages/core/tsconfig.core.d.ts` declares, for the core's
  own type check only, what it may use beyond `ESNext`. Its entries: `.`
  (the turn loop) and one for each module that another package imports.
- `packages/openai/` (`@everchat/openai`): the wire for OpenAI. Its
  entries: `.` (`packages/openai/src/openai.ts`, the wire), and one for
  the tag of the address and the key that each request goes to, its
  error, and the one form of the address (see the section on model
  access). Where the address and the key come from is `local`'s.
- `packages/sqlite/` (`@everchat/sqlite`): the store on SQLite, with Bun's
  driver. Its entries: `./bun` (`packages/sqlite/src/sqlite.ts`, the
  store), `./database` (`packages/sqlite/src/database.ts`, it opens the
  file, makes the schema on an empty one, and refuses a file of another
  version), `./schema` (`packages/sqlite/src/schema.ts`, the schema whole:
  the tables in one list of statements, and its mark; no changes of the
  tables), and `./testing` (`packages/sqlite/tests/help.ts`, what the
  tests that need a real store share). It has no entry `.`.
- `packages/codemode/` (`@everchat/codemode`): the engine of the sandbox,
  in a worker thread. Its entry: `./thread`
  (`packages/codemode/src/thread.ts`).
- `packages/local/` (`@everchat/local`): the rest, the local build. Its
  modules, flat, are in `packages/local/src/`: the terminal, pipe mode, the
  shell and the file functions, the inspector, the reading of the address
  and the key from the environment and a file, the worker thread's
  program (`packages/local/src/worker.ts`, see "Code mode is the only
  primary tool"), and the entry of the program. Its entries: `./limitfile`,
  `./localfunctions`, `./shell`, `./testing` (`packages/local/tests/help.ts`),
  and the one for that reading.
- `packages/<name>/src/x.test.ts`: the tests of one module sit next to it
  (`x.ts`), in its package. A test goes with the code that it tests, so
  four tests named after a module of the core are in other packages:
  `sandbox.test.ts` in `codemode` (the engine of `thread.ts`),
  `store.test.ts` in `sqlite` (the store in `sqlite.ts`), and in `local`
  `functions.test.ts` (most of it the local functions) and `limit.test.ts`
  (most of it the files of `limitfile.ts`). The tests of the core reach the
  SQLite store and the shared test code by the names of their packages,
  as development dependencies of the core (`@everchat/sqlite/bun`,
  `@everchat/local/testing`).
- `packages/sqlite/tests/`: the tests of the store that need a second
  process. `packages/sqlite/tests/child.ts` is the program that such a
  test starts (`packages/sqlite/tests/crash.test.ts`).
- `packages/local/tests/`: tests of the whole program, or of many modules
  at once, or that need a second process. `packages/local/tests/help.ts`
  holds what the tests share, and exports again the helpers of
  `packages/sqlite/tests/help.ts`. `packages/local/tests/screen.ts` is a
  terminal in memory, `packages/local/tests/pty.ts` runs a process in a real
  pseudo-terminal, and `packages/local/tests/vendor.ts` is a fake vendor for
  a whole process (see "The terminal and pipe mode").
- `packages/local/src/main.ts`: the program's entry. `just run` starts it
  from its source, and `just build` makes the executable `everchat`.
  `just test-build` builds it and runs the tests of the whole program on
  it.
- `packages/local/src/inspector.html`: the inspector's page (see "The
  inspector"). It is the one file of the packages that a browser runs.

Run the full check (see "Checks") before you say that a change is done.

File names are lowercase. Multi-word names are written as one word
(`askai.ts`, `openai.ts`).

The rest:

- `docs/`: the design documents.
- `docs/notes.md`: facts about the tools that cost time to find. Read it
  before you work on the store, the inspector, or their tests.
- `tools/`: scripts outside the packages, which import them by their names
  (the root `package.json` names all five). `tools/graph.ts` is a step of
  `just check` (see "Be modular"), and `tools/graph.test.ts` its tests.
  `tools/golden.ts` makes `packages/local/tests/golden.json` from the old
  code. `tools/probe.ts` sends real requests to a vendor (see "Model access
  through the author's inference gateway"). `tools/sample.ts` makes a chat
  with no model, to look at in the inspector (`just sample <home>`).
- `ref/`: the old code, for reading only, outside the packages. See "A
  rewrite, in place". It has the old layout inside (`ref/src/`,
  `ref/tests/`), and also the old site (`ref/web/`), the old iOS app
  (`ref/ios/`, which follows Swift naming), and the old `README.md`,
  `ISSUES.md`, and `justfile`.

## Checks

- Full check: `just full`, about 70 s (68 s after the move into packages:
  the same as before).
- Scoped check: `just scoped <test files>`, for the files of one change,
  with their paths from the root (for example
  `just scoped packages/core/src/memory.test.ts` or
  `just scoped packages/sqlite/src/store.test.ts`). It runs `just check`
  first.
- Full check in a worktree: yes
- Worktree setup: `bun install --frozen-lockfile`

## The original concept

The original design document is
[docs/references/optchat.md](docs/references/optchat.md). It was downloaded from
upstream. Read it before you make design changes.

Treat it as the starting point, not as a spec we must follow. When our design
differs from it, write down the difference and the reason.

The settled design is [docs/design.md](docs/design.md): what the owner decided
for the local use, the hosted use and the factory, each decision with its
question number (`[Q22]`) and its reason. Read it too before you make a design
change. Where it differs from the original concept or from the research in
`docs/research/`, it holds. Only a decision of the owner changes it.

When the upstream code and this document disagree, the code is canonical. The
code came later, and the upstream author uses it every day. So treat the
document as a guide to the intent, and the code as the truth about the
behavior.

## Why we forked

We hard fork because upstream is unlikely to change. The upstream author is
hard at work on [Bend2](https://github.com/bendlang/bend) and Bend3 (still in
incubation), not on UniiChat.

The upstream author also often releases good ideas but does not take outside
feedback or improvements. So we polish the idea ourselves.

Our goal is to make EverChat "battle hardened" and fit our own needs:

- Correct under failure: crashes, partial writes, network errors, bad model
  output.
- Tested: each fix comes with a test that fails without the fix.
- Clear: code and docs that a new reader can follow.
- Shaped to our use, even when that means we diverge from upstream.

## Where we are going

This is the high-level goal. `docs/design.md` holds its settled design. Each
step toward it still needs its own design, inside that one.

EverChat has three uses, in this order [Q52, Q56]:

1. The local use: one person on the person's own computer, with the local
   build (Bun, one SQLite file, the terminal, the shell).
2. The hosted use, for work: a hosted deployment with many tenants, with the
   server build (Bun, MariaDB, HTTP and WebSocket, many tenants in one
   process).
3. The factory, with its hooks. It starts after the first two.

A hosted chat has no hooks, no shell and no file functions [Q5, Q52]. Only
code keeps tenants apart, and the shell is the hole: a command runs as
EverChat's user of the system, and can read the files and the environment of
the other tenants. A hosted chat needs no hooks: its provider sees each call,
and approval is the gate.

### How EverChat will be used

In the local use, EverChat is a person's main assistant, a chief of staff.
There it has no other harness to hand work to, so it uses its own subagents a
lot.

In the factory, EverChat runs next to the `claude` (Claude Code) and `codex`
harnesses, as a drop-in for them [Q56]. There it is one agent with a long
memory that hands coding work to the mature harnesses, and does not do all of
that work itself. So do not build what those harnesses already do well before
the core is solid. Background shells and monitors come later, for the local
use only, after the wake-ups [Q54].

Keep all the uses in mind: subagents must be cheap and solid, and nothing in
the core may need the factory, or one host.

The factory uses all three in the same way:

- It runs each harness interactively, in a real PTY (pseudo-terminal: the
  operating system's stand-in for a terminal). A Ghostty terminal, compiled to
  WASM, shows the screen.
- It sends commands to the harness, as a person at the keyboard would.
- It listens to the harness's hooks. A hook is a command that the harness runs
  at a fixed point, for example when a turn starts, when a tool runs, or when a
  turn ends. Hooks tell the factory what the harness is doing.

So the local build must:

- Work fully as an interactive terminal program in a PTY, as one process. No
  separate server to start, and no browser sign-in.
- Have hooks, like the hooks in `claude` and `codex`. We have not built them
  yet. A hosted chat has none.

In the local use, the terminal is the primary interface. The hosted use has
no terminal: browsers connect to EverChat directly, over a WebSocket first and
plain HTTP as the fallback, with the same events [Q18, Q19, Q25, Q40]. The
repository's client for it is a small web page, for development only [Q27].
The old web and iOS clients (`ref/`) do not shape the design.

The factory has written down what it needs from a harness: the launch, the
hooks, the shell and the transcript. Read that interface before you design a
part that the factory touches.

EverChat must be able to meet this interface. It must also stay a good program
when it runs alone, with no factory.

### Code mode is the only primary tool

In code mode, the model writes a short program that calls functions. A
sandbox runs the program. The model does not ask for one function at a time.

Code mode is the only primary tool that EverChat gives the model. What the old
code gives the model as separate tools (shell, read, write, edit, and the
memory tools) become functions that the program can call.

How it is built (`packages/core/src/sandbox.ts`,
`packages/codemode/src/thread.ts`, `packages/core/src/functions.ts`,
`packages/local/src/localfunctions.ts`):

- A program is JavaScript. It runs in a QuickJS engine that is compiled to
  WebAssembly, in a worker thread (the library `pi-codemode`). In there it has
  no files, no network, and no timers. `packages/core/src/sandbox.ts` holds the
  tag `Sandbox`; the engine of a local chat is `threadLayer` in
  `packages/codemode/src/thread.ts`.
- A program has a memory limit and a compute limit (`MEMORY` and `COMPUTE`
  in `packages/core/src/sandbox.ts`; see the glossary). The compute limit
  bounds one stretch of compute with no function at work, and starts again
  after each function. The engine also takes a compute budget (the option
  `budget` of `threadLayer`): the most time that a program may compute
  with no function at work, summed over the whole program. It does not
  bound what a program computes while a function is at work. The local
  use has none.
- The engine is QuickJS on all builds, so the model's programs behave the
  same on each [Q38]. Each program gets a new engine [Q8]. On Cloudflare,
  programs run in a separate Worker: a program that computes inside the
  chat's Durable Object stops the other objects.
- Each function runs on EverChat's side. It is a row in `call` from its
  start, and the hooks will run there. So no command can pass a hook unseen.
- The tool's description lists the functions as TypeScript declarations
  (`packages/core/src/head.ts`), in the order of `DECLARATIONS` in
  `packages/local/src/localfunctions.ts`. That order is part of the prompt
  cache's key. To add a function that needs only the memory and the store, add
  its declaration, its arguments' schema, and its code to `core` in
  `packages/core/src/functions.ts`. To add a local one (the shell, the files,
  the work directory), add them in `packages/local/src/localfunctions.ts`.
  Either way, give it its place in `DECLARATIONS`, and add a test.
- A hosted chat has no `shell` and no file functions. It gets a common set
  of functions, and the functions of its provider over MCP; EverChat
  validates their definitions, the arguments, and the results [Q21, Q28,
  Q48].
- A stop of a program is a request: the library asks the worker thread to
  end and does not wait for it. So the program's exit must not wait for
  worker threads.
- The executable (`bun build --compile`) has no `node_modules`, where the
  library looks for its two files. So both are options of `threadLayer`, in
  a way that holds from source and in the executable. The QuickJS file is
  imported as a file in `packages/codemode/src/thread.ts`, so the build puts
  it into the executable; it is the default. The worker thread's program is
  our own `packages/local/src/worker.ts`, the second entrypoint of the
  build, which `packages/local/src/main.ts` gives as the option `worker`;
  with none, the library's own worker runs, from `node_modules` (the tests
  of `codemode` use that). `packages/local/src/worker.ts` must stay next to
  `packages/local/src/main.ts`.
- `quickjs-wasi` is in `packages/codemode/package.json` for that import. Its
  version must be the one that `pi-codemode` names, and a test checks it
  (`packages/codemode/src/sandbox.test.ts`). Change both together.
- After a change to the sandbox, the build, or the dependencies, run
  `just test-build`: `just test` runs from source, and does not show a
  fault that only the executable has.

### The terminal and pipe mode

The local build has two interfaces, and one launch has one of them
(`packages/local/src/main.ts` chooses): the terminal, when the standard input
and the standard output are both a terminal, and pipe mode, when one of them is
not.

The terminal is the person's interface, and the one that the factory uses. How
it is built (`packages/local/src/terminal.ts`, `packages/local/src/paint.ts`):

- The library `pi-tui` draws the screen and reads the keys: the input with
  its editing keys, the markdown, and a renderer that writes only the rows
  that changed. Our code says what is on the screen and what a key does.
- It draws on the terminal's main screen, not on the alternate one. So the
  messages are in the terminal's own scrollback, and the terminal's scroll,
  select and copy work on them.
- A row that a component gives must not be wider than the screen: `pi-tui`
  fails on such a row. `Wrapped` and `Row` in `packages/local/src/paint.ts`
  keep to that.

Pipe mode is for scripts and for tests (`packages/local/src/pipe.ts`): each
line of the standard input is a message, one after the other, and each message
that enters the log goes to the standard output as text. It is the same chat
with the same parts, so it is the cheap way to run the whole program: no
pseudo-terminal and no terminal emulator.

A real run needs the owner's yes first. Do not start a run of EverChat with
a real model (a chat, in either interface, that sends requests to a real
model), and do not deploy to the owner's Cloudflare account, until the
owner has said yes. In the factory, that yes is an approval card [Q53]
(`docs/design.md`, "The goal and the order"). A run with a fake vendor, as
in the tests, needs no yes. A probe (`tools/probe.ts`) is not such a run:
it keeps its own rule, the list of probes by vendor in the section on
model access, the one after "OpenAI first, then Anthropic".

What holds for both:

- The log is the truth of what an interface shows. The turn loop's events
  say when a message entered the log, and carry what streams. An interface
  subscribes first, then reads the log, and shows each message once, in
  the order of the ids (`packages/core/src/follow.ts`). Use that module in a new
  interface, and do not show a message from an event alone.
- No control character of a text reaches the terminal or the standard output
  (`clean` in `packages/local/src/paint.ts`). Use it for every text that you
  show.
- What streams (the thought, the text, the program that the model writes) is
  never in the database. A step is written when it ends, whole. An interface
  that shows what streams shows it paced (`packages/core/src/pace.ts`): a whole
  paragraph at a time, and not each word. That module knows no terminal, so a
  later interface can use it as it is. The terminal shows the thought and the
  text paced, and a program whole when it starts to run. Pipe mode shows
  nothing that streams: only whole messages.

How to test them:

- `packages/local/tests/pipe.test.ts` runs the whole program in pipe mode, as a
  process with pipes, against a fake vendor on this machine
  (`packages/local/tests/vendor.ts`). Use it first for anything that does not
  need the screen or the keys: a turn, a program, a restart, a signal, the
  arguments, the exit code.
- `packages/local/tests/screen.ts` is a terminal in memory (xterm.js with no
  window). A test gives it to the terminal's layer, types with `type`, and
  reads the rows that a person would see. Use it for what the screen shows and
  what a key does (`packages/local/tests/terminal.test.ts`).
- `packages/local/tests/pty.ts` runs the whole program as a process in a real
  pseudo-terminal (`packages/local/tests/main.test.ts`). Use it for what only a
  real terminal shows: the launch of the screen, the signals, a closed window.
- `just test-build` runs the whole-program files on the executable
  (`EVERCHAT_BIN=<file>` names the program to start).

To run the program by hand against no real model, start a fake vendor, give
its address as `EVERCHAT_GATEWAY_URL`, and name a new home with
`EVERCHAT_HOME`, as these tests do. `just run` with neither sends real
requests through the inference gateway and writes the chat in `~/.everchat`,
the person's own chat.

### The inspector

The inspector is a page in a browser that shows the state of a chat: the
log, the tree, the two views, each turn's request, the usage, and the
diagnostics. It is for the person who studies the memory, or who looks for
a fault. `everchat inspect` serves it. It is not an interface: it sends no
message, and it changes nothing.

How it is built, in four parts that each know only the one before:

- The store's reads (`Reads` in `packages/core/src/store.ts`, its SQL in
  `packages/sqlite/src/sqlite.ts`): the store with no launch and no write, over
  a connection that cannot write. So the inspector is a process of its own. It
  runs next to a launch of the chat, or with none, and the chat's process has
  no server in it. A new query for the inspector goes in
  `packages/sqlite/src/sqlite.ts`, because no other module uses SQL.
- The read module (`packages/local/src/inspect.ts`): it turns the reads into
  what the page shows, as plain data. It knows no HTTP. Test it directly.
- The server (`packages/local/src/inspector.ts`): the page, and the read
  module's answers as JSON. Every route is a GET. Only `everchat inspect` loads
  this module (a dynamic import in `packages/local/src/main.ts`), so a launch
  of the chat does not load an HTTP server.
- The page (`packages/local/src/inspector.html`): one file with its style and
  its script, no framework and no build step. The build puts it into the
  executable as text.

The rules that it keeps:

- It only reads. Do not add a route that changes the chat: to send a
  message from a browser is a third interface, and that needs its own
  design.
- The chat is private, and a port is not. The server listens on
  127.0.0.1 only, and every path starts with a token that is new at each
  start. Keep both.
- The page puts every text of the chat on the page as text, never as HTML
  (`h` in the page's script makes each element). The content security
  policy lets only the page's own script run, by its hash. So the page has
  exactly one `<script>`, and it loads nothing from another place.
- A view is shown as it is now, which is more than the database's row. The row
  is written only when a batch changes a view. Between batches, a view grows by
  one leaf for each new message (`grown` in `packages/core/src/memory.ts`).
- The body of a request is the one that the wire builds now from the kept
  turn items. It is not a copy of the bytes that were sent.
- What streams is not in the database, so the inspector does not show it.
  The request of a compaction is not kept either: only its node and its
  usage.

How to test it:

- `packages/local/src/inspect.test.ts` asks the read module about a chat that a
  fake wire made (`withChat` in `packages/local/tests/help.ts`).
- `packages/local/src/inspector.test.ts` asks the server: who may read, and
  what each route answers.
- `packages/local/tests/page.test.ts` runs the page's script in a browser with
  no window (the library `happy-dom`) against the real server, and reads what a
  person would see. That browser has no layout. After a change to how the page
  looks, look at it in a real browser: `just sample <home>` makes a chat to
  look at, with no model.
- `packages/local/tests/inspect.test.ts` runs `everchat inspect` as a process,
  next to a launch of the chat. `just test-build` runs it on the executable
  too.

### One system prompt for every kind of request

The chat's turns, its compactions, and its subagents all send the same system
prompt and the same tool list. The system prompt names each kind of request
and holds its rules. A block after the view says which kind this request is
(for example, one that starts `Subagent task:`).

The reason is the prompt cache: a request can read another request's cache
only when both start with the same bytes. With one prompt, a subagent reads
the view that the chat already sent, and does not pay for it again.

Two rules follow:

- Do not give a role its own system prompt. Add a section to the shared one.
- The prompt does not enforce what a role may do. The code does: a function
  that a subagent may not use returns an error.

A computer task is the exception. It has no view and another tool, so it
keeps its own prompt.

The head is EverChat's fixed text with named fields, and an appended text
[Q29]. The fixed text holds the rules of the memory and of code mode, so it
cannot be replaced; the name falls back to "EverChat". The appended text
comes, in the local use, from a file that the config file names, and in the
factory from `AGENTS.md` in the working directory [Q50]. A change applies at
the next load: it costs a new head and one cache write.

### Our own vendor wires

We write and keep our own code for each model vendor's API (a "wire": it
builds the request and reads the streamed reply). We do not use a general
library for this, such as `pi-ai` or Effect's `effect/ai`.

The reason: the memory depends on exact control of each request. It decides
where the cache marks go, it counts the bytes, and it needs every field that
the vendor gives back. A general library hides or changes some of these. We
support only two vendors (OpenAI and Anthropic), so the cost of our own wires
is small.

Base each wire on the vendor's official documentation, not on memory or on
another library's code. When the documentation and our code disagree, the
documentation wins, and the fix comes with a test.

### Use other libraries where they fit

Use a library instead of handwritten code where it does the job and does not
take control that the memory needs:

- `pi-codemode` (from the [pi libraries](https://github.com/earendil-works/pi),
  `@earendil-works/pi-*` on npm) for code mode. It does not depend on `pi-ai`.
- `pi-tui` for the terminal's screen and keys (see "The terminal and pipe
  mode").
- `pi-schema` for JSON Schema that comes from outside (a provider's
  definitions): `pi-codemode` does not check it [Q45].
- For MCP, the official SDK, not `pi-mcp` for now: `pi-mcp` speaks only an
  old version of the protocol [Q45].
- Other pi packages where they fit. Check each one against our needs before
  you adopt it.

Keep what is EverChat's own idea: the memory (the log, the tree of summaries,
and the view that each request shows the model), and the prompt-cache rule in
`ref/src/askai.ts`.
When a library replaces code that these depend on, make sure the behavior
stays the same, and test it.

### Be modular

Each part must have a clear boundary, so that we can test it alone and replace
it. In particular, the core (the memory and the agent loop) must not depend on
the server, the web, accounts, or billing. In the old code the chat logic
lives in `ref/src/server.ts`, so this is a large change.

The target: one repository with workspaces, and nine packages named
`@everchat/<name>`, with one version [Q31, Q45]. The packages import the
TypeScript sources of each other, with no build step, and nothing goes to npm
at first. A person outside can then use one package at a time.

| Package | Holds | May import |
| --- | --- | --- |
| `@everchat/core` | the memory, the turn loop, requests, the cache, the head, the tags of the seams | `effect`, `pi-codemode/declarations` |
| `@everchat/openai` | the wire for OpenAI; Anthropic's comes next to it | `core` (its requests) |
| `@everchat/sqlite` | the store on SQLite: an entry each for Bun, Node and a Durable Object | `core` |
| `@everchat/mariadb` | the store on MariaDB | `core`, `@effect/sql-mysql2` |
| `@everchat/codemode` | the engine: in a worker thread, or in a separate Worker | `core`, `pi-codemode` |
| `@everchat/local` | the terminal, the shell, the files, the inspector, the executable | `core`, `openai`, `sqlite`, `codemode`, `pi-tui`, `@effect/platform-bun` |
| `@everchat/server` | HTTP and WebSocket, the lease, the provider | `core`, `openai`, `mariadb`, `codemode` |
| `@everchat/cloudflare` | the Durable Object of a chat | `core`, `openai`, `sqlite`, `codemode` |
| `@everchat/wakeups` | reminders and routines, optional | `core` |

Today five of them exist: `@everchat/core`, `@everchat/openai`,
`@everchat/sqlite`, `@everchat/codemode` and `@everchat/local` ("Layout").
Each of the three cut out of `local` holds less than its row says:
`openai` has the wire for OpenAI and none for Anthropic, `sqlite` an
entry for Bun only (`./bun`), and `codemode` the engine in a worker thread
only (`./thread`).
`mariadb`, `server`, `cloudflare` and `wakeups` do not exist yet.

The rules that keep the boundaries:

- The core has no runtime API, with one exception: `createHash` from
  `node:crypto`, which runs the same on Bun, Node and `workerd` [Q45].
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
- The tests of the core use `node:test` and `node:assert`, so that they run
  on Bun and on Node: `test`, `beforeEach` and `afterEach` from `node:test`,
  each assertion from `node:assert/strict` (`import * as assert`), and a
  timeout as `test(name, { timeout: 60_000 }, fn)`. A helper module for the
  tests in `packages/core/src/` is not a test: it is in the core's own type
  check, which has no Node types, and under the list of built-ins of the
  core's files, so a helper that imports `node:test` or `node:assert` fails
  both checks; a helper that needs neither passes. A test of the core
  that imports `@everchat/sqlite` or `@everchat/local` (the SQLite store,
  the shared test code) reaches `bun:sqlite`, so it runs on Bun only for
  now.
- Two checks hold the boundaries [Q45], in `just check`: the type check of
  each package (the core's has no Bun and no Node types), and
  `tools/graph.ts`, for what the types do not see. Bun's parser
  (`Bun.Transpiler.scanImports`) alone decides what each file of each
  package imports. The script sees value imports only: a type-only import
  (`import type`, `export type`, a list of only `type` names) and a `.d.ts`
  file are the type check's. The script does not see an import's type: it
  takes an `.html` import as a page that imports nothing, but Bun bundles
  an HTML import that has no `with { type: "text" }`, and the walk does not
  read the scripts of that bundle; import a page as text. It prints one line for each fault,
  `<file>:<line>: <rule>: <specifier>`; the line is a hint. The rules:
  `manifest` (a package imports only itself and its own dependencies; a
  test may also use its
  `devDependencies`), `way out` (a relative import stays in its package;
  it, or an entry of a workspace package, names a `.ts` file of a
  package's own sources or an existing file of a kind that is not code,
  on the script's list `NOT_CODE` (`.html`, `.txt`: the inspector's page),
  since the script cannot follow another one),
  `entry` (an import of a workspace package names an entry of its
  `exports`; each target of `exports` is a string, and any other, such as
  an object of conditions, is a fault at line 1 of the manifest, since Bun
  may load another file than the one that the script checks),
  `built-in` (a `node:` or `bun:` module is on its package's
  list: for the core's tests, `node:assert/strict`, `node:crypto`,
  `node:path` and `node:test`, and no `bun:` module, so that they run on
  Node too; for the core's files, `node:crypto` only; which of its names the
  core may use, `createHash`, is held by the core's type check, for a name
  that a file uses by its type, but not for a name made at run time: see
  "Reflection" below; for the files of `openai`, `sqlite` and `codemode`,
  none, and any for their tests; for `local`, any), and
  `budget` (the files that a row starts from, through their value imports
  and across packages, reach no file under its `forbid`, and, when it has
  `only`, no file outside those paths and its own package; the walk
  fails closed: an import of the workspace that it cannot follow is a
  fault of each row whose walk reaches it). The rows of
  `budget`: no file of the core that is not a test reaches
  `packages/local/`, `packages/openai/`, `packages/sqlite/` or
  `packages/codemode/`; no such file of `sqlite` or `codemode` reaches
  `packages/local/` or the other two of the three; and each entry of
  `openai` (the row names them all) reaches only its own files and
  `packages/core/src/request.ts`.
  A row needs `forbid`, `only`, or both, and a row for a package that the
  tree lacks is a fault. A row is also a fault at `tools/graph.ts:1`, and
  is not walked, when its `from`, `forbid` or `only` is given and empty,
  or when an entry of its `from` is not in the package's `exports` or
  names a file that the script cannot read, or when an entry of its
  `forbid` or `only` does not name what is there: a path from the root
  with no leading `./`, of a file, or of a directory when it ends in `/`,
  written as its real path (no link in any part, the case of letters that
  the file system holds).
  A row that lists entries names each entry of the package's `exports`, so
  that a new entry cannot slip past it. A file that is not a test imports
  no test's file, relative or by an entry such as `./testing`
  (`manifest`): that would bring the tests' development packages into
  run-time code. A source whose real
  path is not a `.ts` file (a link `zz.test.ts` to a file `zztest`, which
  `bun test` still runs) is a `way out` fault at its line 1, since no rule
  can read it. So is any other file found under a package's directory,
  by a link into another package too, that the rules do not read, unless
  it is, by its name and by its real path, of the same kind: `.d.ts`,
  `.json`, or a kind on `NOT_CODE` (so a `.js` or `.mts` file, a file with
  no extension, and a link `x.test.js` to a `.ts` file that no rule reads,
  outside the packages or under another package's `node_modules`, are
  faults): no rule could check it. The lists are the
  tables `BUILTINS` and `BUDGETS` at the top of the file. `check` takes
  its tables as a parameter (`check(root, tables)`), so that a test gives
  tables that fit its fixture; the command uses the real ones. Write a
  relative import with the `.ts` file's path: `tools/graph.ts` faults on
  one that names no `.ts` file (`./x.js`, `./x.mts`, `./x` with no extension, a
  missing file), since it cannot follow it. It reads the imports of the
  packages' own source files only, so a value import of any other `.ts`
  file, of a `.d.ts` file or of one under `node_modules` is a fault too:
  write a `.d.ts` import as `import type`. When it fails, fix the
  import that its line names: declare the dependency, import by the
  package's name and an entry, or keep the code that needs a module out of
  the core. What the two checks do not hold, each an accepted risk:
  - Reflection (ec-lzw7). A file of the core reaches a runtime API by a
    name that is made at run time: through a value of type `any`, for
    example `Reflect.get(crypto, "randomUUID")()` on an import of the whole
    `node:crypto`, or `Reflect.get(globalThis, "process")` with no import
    at all; or by a computed `import(n)` (`const n = "node:fs"; await
    import(n)`), which Bun's parser does not list. All three pass `just
    check`: the type check holds the names that a file uses by their
    types, and the script holds the modules that a file imports; neither
    sees a name that is made at run time. It is rare: only code that is
    written to go around the types does this, and the type check refuses
    each other name of `node:crypto` that a file uses directly
    (`import { randomUUID }` and `crypto.randomUUID()` each fail). To
    recover, remove the line: no record is lost. The review of a change to
    the core looks for `Reflect`, `globalThis`, `any`, and an `import()`
    of no string. What would fix it is not an import check: a lint rule
    that forbids those in the core, or a run of the core where the API is
    absent (the core's tests on Node, the Cloudflare smoke test).
  - An ambient import (ec-ofuo). An `import` with no `type` inside a
    `declare module "x" { ... }` block, in a `.ts` file that is not a
    `.d.ts` file, loads nothing, but Bun's parser lists it, so the script
    may print a fault for it (`manifest`, `built-in`). It is rare: the tree
    has no such block, and ambient declarations are in `.d.ts` files, which
    the script does not read. It fails safe: the check refuses, and it
    never passes a real import. Write `import type` in the block (Bun's
    parser then lists nothing), or put the block in a `.d.ts` file. What
    would fix it: an import list from a parser that knows ambient blocks.
- Three builds prove the design [Q4, Q6, Q14]: local, server, and a
  Cloudflare smoke test (`workerd`, a Durable Object for each chat with its
  own SQLite). Each build is one host with its own implementations of the
  seams, so the three together show that the core holds no runtime API.

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

### A rewrite, in place

We write a new, clean, modular implementation in this repository. We do not
refactor the old code step by step.

- The old code is in `ref/`. The git tag `before-rewrite` marks the last
  commit before the move. `ref/` is for reading only: do not edit it, and do
  not import from it. Keep it out of the build, the type check, and the tests
  (`bunfig.toml` keeps it out of `just test`). When the new code no longer
  needs it, we delete `ref/` in one commit.
- The old code still runs from inside `ref/`. `cd ref && just test` runs its
  tests. Use this to compare the port with the old behavior.
- One file outside `ref/` imports from it: `tools/golden.ts`. It runs the old
  memory on a fixed chat and writes what it made to
  `packages/local/tests/golden.json`. The golden test
  (`packages/local/tests/golden.test.ts`) runs the new memory on the same chat
  and compares. The file goes away when `ref/` does.
- The documents in `docs/` that describe the old code cite its files without
  `ref/` (for example `src/memory.ts`). Read such a path as a path in `ref/`.
  The line numbers stay exact, because `ref/` does not change.
- This is greenfield. There are no existing chats to keep, so we do not read
  the old file formats and we do not write a migration from them (see
  "Greenfield: no backward compatibility").
- Importing the sessions of other harnesses (Claude Code, Codex) is out of
  scope. Do not port the old import code.
- The kind of EverChat's own messages is `asst` (short for "assistant") in the
  new code. Upstream says `unii` and the old code says `ever`. Keep it at 4
  letters: the model reads each message as `<kind>: <text>`, and that whole
  line counts toward a node's 512 bytes. A longer word changes which messages
  need a compaction. When you port a test, change only this word.
- Port the memory algorithm (the tree, the views, the merge order, the
  retries, the cache marks), do not reinvent it. Its invariant tests and its
  golden test move with it. They show that the port did not change what the
  algorithm does.

### OpenAI first, then Anthropic

We support both vendors. We do OpenAI first, because a person can use an
OpenAI subscription from a third-party harness such as EverChat.

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

The repository is public. Name the inference gateway only as "the author's
inference gateway". Do not name its program or its host, and do not say how
it routes requests or signs in, in any file, test or commit message. The
owner makes the edits of the passages about the gateway.

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

### All state in the chat's database

All state of a chat lives in its database. One schema serves all builds
[Q15, Q24]: in the local build, one SQLite file in one home directory that
the variable `EVERCHAT_HOME` names; in the server build, EverChat's tables in
the product's schema on MariaDB; on Cloudflare, the SQLite of the chat's
Durable Object. A database can hold many chats.

This gives two things:

- Restart: when the process is interrupted, crashes, or restarts, it reads the
  database and continues from where it was. It loses at most the work that was
  in flight (for example, a request that had not finished), and it can see
  what that work was so that it can start it again.
- Backup and moving hosts: a local install is one to three files. These are
  one executable (`bun build --compile`), one SQLite database, and maybe one
  config file. On MariaDB, the product's backups of its schema include the
  chats [Q47].

The rule: the program writes its state to the database. The person writes the
config file by hand, and the program only reads it. Do not keep state in
other files, in other directories, or only in memory, unless you write down
why.

The schema:

- Each table has the fixed table prefix `everchat_`, in all builds, written
  out in each statement (`everchat_msg`) [Q46]. No statement builds a name.
  Every name that is unique in a schema gets the prefix.
- Design the schema before the code that uses it. Each table has a written
  purpose, and each schema change is designed and tested.
- No migration. In the local build, EverChat makes its own schema, and for
  now a change of the schema means a new SQLite file [Q55]. On MariaDB, the
  schema is `.sql` files in the form of `skeema`, one for each table, always
  the current schema; an administrator applies them with `skeema`. The
  server build never changes the schema: at each start it compares each of
  its tables in the database with its files, and stops with an error that
  names a difference [Q55].

### A chat is loaded and unloaded

A process loads a chat to work on it, and unloads it after 6 minutes with no
work [Q12, Q20]. An idle chat uses no memory. A load makes all again from the
database: the chat and each agent carry a recipe, not values. So an unload
saves nothing and loses nothing. Do not keep a value in memory that a load
cannot make again, such as a secret; keep what makes it.

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
- The arguments are read with `effect/cli`, and the standard input, the
  standard output, the file system and the paths in
  `packages/local/src/main.ts` and `packages/local/src/pipe.ts` are Effect's
  services (`Stdio`, `FileSystem`, `Path`), from `@effect/platform-bun`. Import
  one module of that package (`@effect/platform-bun/BunServices`), not its
  index: the index loads all of it, and each start pays for that.
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
