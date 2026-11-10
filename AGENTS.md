# AGENTS.md

## What this project is

EverChat is a hard fork of UniiChat.

- Upstream: https://github.com/VictorTaelin/uniichat
- Our fork: https://github.com/raymond-w-ko/everchat

A hard fork means we do not plan to merge back into upstream. We also do not
plan to track upstream closely. We can pull an upstream change when it is
useful. We do not have to.

EverChat is an LLM agent harness. Its core idea: the chat itself is the memory.
There is one chat that never ends. A cheap model compresses the log into a tree
of summaries, and the agent zooms into that tree when it needs detail.

## Words

[GLOSSARY.md](GLOSSARY.md) is the dictionary of this project. Read it first.
Use its names exactly, in code, in documents, and in replies. If you need a
name that is not there, add it there first. Its last section lists the words
that we do not use.

## Tools

- [Bun](https://bun.sh) is the runtime, package manager, test runner, and
  bundler. Do not use Node, npm, yarn, or pnpm.
- [just](https://github.com/casey/just) is the command runner. Put common
  tasks in the `justfile` as recipes.
- [Effect](https://effect.website) (the `effect` package, version 4) is the
  library we write the program with. See "Use Effect as much as possible"
  below.
- TypeScript (`tsc`) checks the types. Bun runs the code without a check, so
  `just check` is a separate step.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Layout

The new code:

- `src/`: all TypeScript modules, flat, plus the files they import.
- `src/x.test.ts`: the tests of one module sit next to it (`x.ts`).
- `tests/`: tests that cover many modules at once, or that need a second
  process. `tests/help.ts` holds what the tests share, and `tests/child.ts`
  is the program that such a test starts.

Run `just test` and `just check` (the type check) before you say that a
change is done.

File names are lowercase. Multi-word names are written as one word
(`askai.ts`, `openai.ts`).

The rest:

- `docs/`: the design documents.
- `tools/`: scripts that are not part of the program, of the type check, or
  of the tests. `tools/golden.ts` makes `tests/golden.json` from the old
  code. `tools/probe.ts` sends real requests to a vendor (see "Model access
  through the author's inference gateway").
- `ref/`: the old code, for reading only. See "A rewrite, in place". It has
  the same layout inside (`ref/src/`, `ref/tests/`), and also the old site
  (`ref/web/`), the old iOS app (`ref/ios/`, which follows Swift naming), and
  the old `README.md`, `ISSUES.md`, and `justfile`.

## The original concept

The original design document is
[docs/references/optchat.md](docs/references/optchat.md). It was downloaded from
upstream. Read it before you make design changes.

Treat it as the starting point, not as a spec we must follow. When our design
differs from it, write down the difference and the reason.

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

This is the high-level goal. It is a direction, not a finished plan. Each step
toward it still needs its own design.

### How EverChat will be used

EverChat will run in our software factory, next to the `claude` (Claude Code)
and `codex` harnesses. Its role there is a chief of staff: one agent with a
long memory that hands coding work to the mature harnesses, and does not do
all of that work itself. So do not build what those harnesses already do well
(for example, background shells) before the core is solid.

EverChat must also work alone, with no factory, for example as a person's
main assistant. There it has no other harness to hand work to, so it uses its
own subagents a lot. Keep both uses in mind: subagents must be cheap and
solid, and nothing in the core may need the factory.

The factory uses all three in the same way:

- It runs each harness interactively, in a real PTY (pseudo-terminal: the
  operating system's stand-in for a terminal). A Ghostty terminal, compiled to
  WASM, shows the screen.
- It sends commands to the harness, as a person at the keyboard would.
- It listens to the harness's hooks. A hook is a command that the harness runs
  at a fixed point, for example when a turn starts, when a tool runs, or when a
  turn ends. Hooks tell the factory what the harness is doing.

So EverChat must:

- Work fully as an interactive terminal program in a PTY, as one process. No
  separate server to start, and no browser sign-in.
- Have hooks, like the hooks in `claude` and `codex`. We have not built them
  yet.

The terminal is the primary interface. The web and iOS clients are secondary.
Keep them working where it is cheap, but do not let them shape the design.

The factory (the `everturn` repository) has written down what it needs from a
harness. Read these before you design a part that the factory touches (the
launch, the hooks, the shell, the transcript):

- `~/src/everturn/docs/decisions/0186-harness-interface.md`: the decision
  (ADR 0186).
- `~/src/everturn/packages/bridge/src/runtime/types.ts`: the interface,
  `SeatRuntime`.
- `~/src/everturn/docs/references/seat-runtime.md`: the requirements, R1 to
  R34.

EverChat must be able to meet this interface. It must also stay a good program
when it runs alone, with no factory.

### Code mode is the only primary tool

In code mode, the model writes a short program that calls functions. A
sandbox runs the program. The model does not ask for one function at a time.

Code mode is the only primary tool that EverChat gives the model. What the old
code gives the model as separate tools (shell, read, write, edit, and the
memory tools) become functions that the program can call.

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
- Other pi packages where they fit (for example `pi-mcp` or `pi-tui`). Check
  each one against our needs before you adopt it.

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
  memory on a fixed chat and writes what it made to `tests/golden.json`. The
  golden test (`tests/golden.test.ts`) runs the new memory on the same chat
  and compares. The file goes away when `ref/` does.
- The documents in `docs/` that describe the old code cite its files without
  `ref/` (for example `src/memory.ts`). Read such a path as a path in `ref/`.
  The line numbers stay exact, because `ref/` does not change.
- This is greenfield. There are no existing chats to keep, so we do not read
  the old file formats and we do not write a migration from them.
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

### All state in one SQLite file

One chat is one database, in one home directory that the variable
`EVERCHAT_HOME` names. A second, independent chat is a second home. Do not put
two chats in one database.

Almost all state lives in one SQLite database. This gives two things:

- Restart: when the process is interrupted, crashes, or restarts, it reads the
  database and continues from where it was. It loses at most the work that was
  in flight (for example, a request that had not finished), and it can see
  what that work was so that it can start it again.
- Backup and moving hosts: an install is one to three files. These are one
  executable (`bun build --compile`), one SQLite database, and maybe one config
  file.

The rule: the program writes its state to the database. The person writes the
config file by hand, and the program only reads it. Do not keep state in
other files, in other directories, or only in memory, unless you write down
why.

Design the schema before the code that uses it. Each table has a written
purpose, and each schema change has a migration and a test.

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
