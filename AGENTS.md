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

## Tools

- [Bun](https://bun.sh) is the runtime, package manager, test runner, and
  bundler. Do not use Node, npm, yarn, or pnpm.
- [just](https://github.com/casey/just) is the command runner. Put common
  tasks in the `justfile` as recipes.

## Layout

- `src/`: all TypeScript modules, flat, plus the files they import
  (`computer.swift`, `prompt.txt`, `hello.md`).
- `src/x.test.ts`: the tests of one module sit next to it (`x.ts`).
- `tests/`: tests that cover many modules at once.
- `web/`: the site's static files. `web/src/` is the browser code, built into
  `web/app.js` (`just web`).
- `ios/`: the iOS app.

File names are lowercase. Multi-word names are written as one word
(`askai.ts`, `openai.ts`).

The exception is `ios/`, which follows Swift naming. Swift files and folders
use UpperCamelCase, and a file is named after the main type it defines
(`Site.swift` holds `Site`). Do not rename the names Xcode expects
(`Assets.xcassets`, `Info.plist`). `src/computer.swift` is not part of the iOS
app, so it follows the lowercase rule.

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
and `codex` harnesses. The factory uses all three in the same way:

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

### Code mode is the only primary tool

In code mode, the model writes a short program that calls tools as functions.
A sandbox runs the program. The model does not make one tool call per step.

Code mode is the only primary tool that EverChat gives the model. The other
tools (shell, read, write, edit, and the memory tools) become functions that
the program can call.

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
and the view that each call sees), and the prompt-cache rule in `askai.ts`.
When a library replaces code that these depend on, make sure the behavior
stays the same, and test it.

### Be modular

Each part must have a clear boundary, so that we can test it alone and replace
it. In particular, the core (the memory and the agent loop) must not depend on
the server, the web, accounts, or billing. Today the chat logic lives in
`src/server.ts`, so this is a large change.

### A rewrite, in place

We write a new, clean, modular implementation in this repository. We do not
refactor the old code step by step.

- The old code moves to `ref/`, and a git tag marks the last commit before
  the move. `ref/` is for reading only: do not edit it, and do not import from
  it. Keep it out of the build, the type check, and the tests. When the new
  code no longer needs it, we delete `ref/` in one commit.
- This is greenfield. There are no existing chats to keep, so we do not read
  the old file formats and we do not write a migration from them.
- Port the memory algorithm (the tree, the views, the merge order, the
  retries, the cache marks), do not reinvent it. Its invariant tests and its
  golden test move with it. They show that the port did not change what the
  algorithm does.

### OpenAI first, then Anthropic

We support both vendors. We do OpenAI first, because a person can use an
OpenAI subscription from a third-party harness such as EverChat.

### All state in one SQLite file

Almost all state lives in one SQLite database. This gives two things:

- Restart: when the process is interrupted, crashes, or restarts, it reads the
  database and continues from where it was. It loses at most the work that was
  in flight (for example, a model call that had not finished), and it can see
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
  database, running calls, and interrupts, not hand-written versions.
- Use Effect's own modules (for example `effect/sql`, `effect/cli`) before
  other libraries, where they fit.
