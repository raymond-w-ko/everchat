`packages/core/` (`@everchat/core`): the core.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/core/` (`@everchat/core`): the core. Its modules, flat, are in
  `packages/core/src/`: the memory, the turn loop, requests, the cache, the
  head and the prompt, the cap of a result, and the tags of the seams (the
  store, the sandbox, the functions). It has no runtime API (see
  "The boundaries of the core" below). `packages/core/tsconfig.core.d.ts`
  declares, for the core's own type check only, what it may use beyond
  `ESNext`. Its entries: `.` (the turn loop) and one for each module that
  another package imports.
- A test goes with the code that it tests, so
  four tests named after a module of the core are in other packages:
  `sandbox.test.ts` in `codemode` (the engine of `thread.ts`),
  `store.test.ts` in `sqlite` (the store in `sqlite.ts`), and in `local`
  `functions.test.ts` (the local functions; the core's functions and the
  hosted set are tested in the core's own `functions.test.ts`) and
  `limit.test.ts` (most of it the files of `limitfile.ts`). The tests of the
  core reach the SQLite store and the shared test code by the names of their
  packages, as development dependencies of the core (`@everchat/sqlite/bun`,
  `@everchat/local/testing`).

## Code mode is the only primary tool

How it is built (`packages/core/src/sandbox.ts`,
`packages/codemode/src/thread.ts`, `packages/core/src/functions.ts`,
`packages/local/src/localfunctions.ts`):

- The tool's description lists the functions as TypeScript declarations
  (`packages/core/src/head.ts`), in the order of `DECLARATIONS` in
  `packages/local/src/localfunctions.ts`. That order is part of the prompt
  cache's key. To add a function that needs only the memory and the store, add
  its declaration, its arguments' schema, and its code to `core` in
  `packages/core/src/functions.ts`. To add a local one (the shell, the files,
  the work directory), add them in `packages/local/src/localfunctions.ts`.
  Either way, give it its place in `DECLARATIONS`, and add a test. A function
  that a host's chat has (one that needs only the memory and the store) also
  gets its place in `HOSTED` in `packages/core/src/functions.ts`:
  `hostedLayer` builds the functions of a host's chat from it, in its order,
  and that order is part of the prompt cache's key of a host's chat.

## One system prompt for every kind of request

The chat's turns, its compactions, and its subagents all send the same system
prompt and the same tool list. The system prompt names each kind of request
and holds its rules. A block after the view says which kind this request is
(for example, one that starts `Subagent task:`). Each stack makes the head
one time, at the load, from its list of functions (`head` in
`packages/core/src/head.ts`), and gives that one value to the turn loop and to
the compactor: the option `head` of `Turns.layer` and of `Compactor.layer`.

The reason is the prompt cache: a request can read another request's cache
only when both start with the same bytes. With one prompt, a subagent reads
the view that the chat already sent, and does not pay for it again.

Two rules follow:

- Do not give a role its own system prompt. Add a section to the shared one.
- The prompt does not enforce what a role may do. The code does: a function
  that a subagent may not use returns an error.

A computer task is the exception. It has no view and another tool, so it
keeps its own prompt.

## The memory

Keep what is EverChat's own idea: the memory (the log, the tree of summaries,
and the view that each request shows the model), and the prompt-cache rule in
`ref/src/askai.ts`.
When a library replaces code that these depend on, make sure the behavior
stays the same, and test it.

## The boundaries of the core

- The core has no runtime API, with one exception: `createHash` from
  `node:crypto`, which runs the same on Bun, Node and `workerd` [Q45].
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

## The port

- The kind of EverChat's own messages is `asst` (short for "assistant") in the
  new code. Upstream says `unii` and the old code says `ever`. Keep it at 4
  letters: the model reads each message as `<kind>: <text>`, and that whole
  line counts toward a node's 512 bytes. A longer word changes which messages
  need a compaction. When you port a test, change only this word.
- Port the memory algorithm (the tree, the views, the merge order, the
  retries, the cache marks), do not reinvent it. Its invariant tests and its
  golden test move with it. They show that the port did not change what the
  algorithm does.
