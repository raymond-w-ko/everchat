# Engines for code mode: `node:vm`, V8, an interpreter of one's own, QuickJS

A public post says that four harnesses run the model's program in four kinds of
engine: Claude Code in `node:vm` inside Bun, Codex in V8, OpenCode in an
interpreter of its own, `pi` in QuickJS. Is each claim true, by the harness's
own sources? What does each kind of engine give and cost, as a wall around a
program and as a place to run it? And which fits EverChat's local use (one
person; the model has `shell`) and its hosted use (competitors' chats in one
process; no `shell`)? It decides nothing. It builds on `code-mode.md` (Claude
Code's page), `functions.md` (QuickJS costs, snapshot, stop),
`portability.md` (the engine on `workerd`) and `runtime.md` (isolates,
`isolated-vm`), and does not repeat them. The decision of round 3 (on
Cloudflare, programs run in a separate Worker with the same QuickJS engine as
on Bun) is given.

## Today

| Fact | Where |
| --- | --- |
| A program runs in QuickJS compiled to WebAssembly, through `pi-codemode`'s `CodemodeSandbox` | `src/sandbox.ts:45`, `src/sandbox.ts:47` |
| A new sandbox, so a new worker thread and engine, for each program | `src/sandbox.ts:181`, `src/worker.ts:14` |
| 512 MiB for the engine; no deadline (`timeoutMs: Infinity`); the compute limit of 60 s, a timer that runs only while no function is at work | `src/sandbox.ts:56`, `src/sandbox.ts:182`, `src/sandbox.ts:60`, `src/sandbox.ts:172` |
| The globals are the `Functions` service's names; each call is a row | `src/sandbox.ts:187`, `src/sandbox.ts:146` |
| A stop is a request: the library asks the worker thread to end and does not wait | `src/sandbox.ts:28` |
| The model is told: `Promise.all()`, no state between programs, no timers, `fetch()`, `require()` or modules | `src/head.ts:35`, `src/head.ts:37`, `src/head.ts:38` |

## Facts

**What each harness does, by its own sources** (read 2026-11-14 and 15):

| Harness | Engine | Where it runs | Limits | Source |
| --- | --- | --- | --- | --- |
| Claude Code | Not named. The Code Mode page and all of the documentation (`llms-full.txt`, searched for `vm`, `isolate`, `REPL`) name no engine. Bun: "Claude Code ships as a Bun executable". So `node:vm` in Bun: not proved; its program is not open | "runs that code in your session" | Stops "after ten minutes", or up to two hours in the background | https://code.claude.com/docs/en/code-mode; https://code.claude.com/docs/llms-full.txt; https://bun.com/blog/bun-joins-anthropic |
| Codex | V8, through the `v8` crate (rusty_v8) `=152.2.0` from a fork, with `v8_enable_sandbox`. "Evaluates the provided JavaScript code in a fresh V8 isolate as an async module" | A standalone host process (`codex-code-mode-host`, gRPC over stdio); in it, an OS thread and a new isolate for each `exec` | `CreateParams::default()`; the protocol carries `max_heap_size_bytes`, which the runtime crate sets to `None` (`grep`); imports refused; `setTimeout` given; `exit()` calls `terminate_execution`. The feature `code_mode` is "under development", off by default | codex `b016cd1`: [Cargo.toml:571](https://github.com/openai/codex/blob/b016cd18472588606c04af565528c4cd6746a41f/codex-rs/Cargo.toml#L571), [runtime/mod.rs:191](https://github.com/openai/codex/blob/b016cd18472588606c04af565528c4cd6746a41f/codex-rs/code-mode-runtime/src/runtime/mod.rs#L191), [description.rs:25](https://github.com/openai/codex/blob/b016cd18472588606c04af565528c4cd6746a41f/codex-rs/code-mode-protocol/src/description.rs#L25), [features/lib.rs:150](https://github.com/openai/codex/blob/b016cd18472588606c04af565528c4cd6746a41f/codex-rs/features/src/lib.rs#L150) |
| OpenCode | `@opencode/codemode` 2.3.0: "a lightweight, pure interpreter for a JavaScript-like language", in TypeScript, on Effect, parser `acorn`. "Rather than trying to sandbox arbitrary JavaScript, CodeMode only runs the language features we implement" | In process: "the program shares the thread with the caller" | A cooperative timeout "between interpreter steps"; caps on one built-in (strings 2^24, arrays 10,000,000, 10,000 pending promises); no heap limit. OpenCode's core gives programs `fetch` (30 s timeout) | opencode `d432a06`: [codemode/README.md:3](https://github.com/anomalyco/opencode/blob/d432a06b9c07bab0be4e8d642173b1cb14137f11/packages/codemode/README.md), [interpreter-support.md:42](https://github.com/anomalyco/opencode/blob/d432a06b9c07bab0be4e8d642173b1cb14137f11/packages/codemode/interpreter-support.md), `src/runtime/limits.ts:3`, `packages/core/src/codemode/tool.ts:281` |
| `pi` | QuickJS (QuickJS-NG, `quickjs-wasi` 3.6.2) "compiled to WebAssembly" | "a worker thread per execution" on Node and Bun; inline or a separate Durable Object on Cloudflare | `memoryLimitBytes` "caps the VM's heap"; an interrupt budget; "no timers, `fetch`, `process`, `require`, modules, or `WebAssembly`" | pi:packages/codemode/README.md:3, :11, :56, :60, :216 |
| Cloudflare's Code Mode | A Worker from the Worker Loader (V8 isolates), network blocked by default, a 60,000 ms `timeout` | Cloudflare | As `code-mode.md` and `runtime.md` give | `code-mode.md`, `runtime.md` |

- Codex starts the host as a program next to its executable and speaks gRPC to
  it over stdio (`--listen`, `stdio` or `grpc+stdio://`).
  https://github.com/openai/codex/blob/b016cd18472588606c04af565528c4cd6746a41f/codex-rs/code-mode-host/src/main.rs#L28
- The published `@opencode/codemode` 2.3.0 (2026-11-13) depends on `acorn`
  8.15.0 and on `effect` 4.1.0 exactly, so EverChat (on 4.1.2) would hold two
  copies of Effect. https://registry.npmjs.org/@opencode%2Fcodemode
- `quickjs-wasi`: "QuickJS-ng disables `JS_SetMaxStackSize` on WASI, so deep
  recursion causes a WASM trap (not a catchable exception)". Through
  `pi-codemode` the run below got a catchable "Maximum call stack size
  exceeded". https://github.com/vercel-labs/quickjs-wasi

**The picture's other claims about Claude Code**, against its page
(https://code.claude.com/docs/en/code-mode):

| Claim | Finding |
| --- | --- |
| One tool, `REPL`, runs JavaScript | Yes: "a `PreToolUse` hook that matches `REPL`, the tool that runs Claude's code". (An older `REPL` tool was "Removed in v2.1.275": https://code.claude.com/docs/en/agent-sdk/typescript) |
| Each call in a script goes through hooks and permissions | Yes: "goes through your `deny` and `ask` permission rules and your `PreToolUse` hooks" |
| Stopped after 600 s | Yes: "stops after ten minutes" (two hours in the background, auto or `bypassPermissions` only) |
| Experimental, behind `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` | Yes |
| `$` with `.text()`, `.nothrow()`; `edit(p, old, new)` | Yes, in the page's example |
| Runs in the Claude Code process, in a `vm` context with frozen built-ins; `import`, `require`, `import()` blocked; no separate sandbox or container | Not proved: no published source says it |
| `file`, `write`, `tools.X`, `searchTools`, `describeTool`, `spawnContext`, `log`, `preview`, `running` | Not proved: not on the page |

**Outside sources:**

- Node: "The node:vm module is not a security mechanism. Do not use it to run
  untrusted code." By default promises run after the evaluation, "This allows
  escaping the functionality of the timeout"; with `microtaskMode:
  'afterEvaluate'` the context has its own microtask queue, run inside each
  evaluation and under its `timeout`. But a promise shared between contexts then
  waits "indefinitely" unless the host schedules another `runInContext()` to
  "manually drain the inner context microtask queue"; timers or
  `queueMicrotask` passed in use the global queues, outside the timeout.
  https://nodejs.org/api/vm.html
- Bun: `node:vm` "Fully implemented"; "The `timeout`, `breakOnSigint`,
  `cachedData`, `microtaskMode` and `codeGeneration` options are supported";
  `importModuleDynamically` too. Bun runs on JavaScriptCore (`runtime.md`).
  https://bun.com/docs/runtime/nodejs-compat
- `isolated-vm`: "currently in *maintenance mode*"; "requires nodejs"; it "does
  not automatically make your application safe", and a leaked `Reference` is "a
  springboard back into the nodejs isolate"; `memoryLimit` is "more of a
  guideline", "2-3 times this limit". https://github.com/laverdet/isolated-vm
- V8's own sandbox (Codex's `v8_enable_sandbox`): "a lightweight, in-process
  sandbox for V8", with "a number of issues to resolve before it becomes a
  strong security boundary" (April 2024). https://v8.dev/blog/sandbox
- QuickJS-NG "aims to support the latest ECMAScript specification".
  https://github.com/quickjs-ng/quickjs

**Runs** (Bun 1.4.4, Node 24.22.2, Linux x86_64; `/tmp/ec-4wn5/`; each case a
child process, killed at a deadline or at 1.5 to 3 GB of RSS):

| Engine and case | Bun | Node |
| --- | --- | --- |
| `node:vm`: a context, frozen built-ins (all globals but `globalThis`, and their prototypes) | `Array.prototype.x = 1` throws; no `require`, `process`, `fetch`, `setTimeout`; `WebAssembly` is there. `Object.freeze(globalThis)` makes every global `undefined` | The same; `Object.freeze(globalThis)` throws "Cannot freeze" |
| `node:vm`: a host function passed in, `tool.constructor("return process.pid")()` | The host's pid, also with frozen built-ins | The same |
| `node:vm`: `this.constructor.constructor(...)` in an empty context | The host's pid | The same |
| `node:vm`: `while (true) {}`, `timeout: 500` | Stopped at 501 ms; the host's 10 ms timer ran 0 times meanwhile | The same |
| `node:vm`, default mode: the loop after `await null` | Not stopped: killed at 5 s | The same |
| `node:vm`, `afterEvaluate`: the same loop | Stopped by the `timeout` at 501 ms, no kill | At 502 ms |
| `node:vm`, `afterEvaluate`: a program that awaits a host function | Undrained, it waits at the `await`: each later evaluation runs one more step. Drained (`/tmp/ec-01f6/trial/pump.mjs`): after the host's promise resolved, `runInContext('void 0', ctx, {timeout: 100})` resumed it and stopped its loop, 121 ms in all | The same |
| `node:vm`: an array of 8 MB arrays, `timeout: 20000` | Not stopped: killed at 1.5 GB after 2.2 s | Killed at 1.5 GB after 1.5 s |
| `node:vm`: a context and `1+1`, 200 of them | 0.15 ms and about 110 KB each | 0.56 ms and about 208 KB each |
| `isolated-vm` 7.0.2: an isolate, a context, `1+1`, 50 of them | Does not load (`undefined symbol: _ZN2v8...`) | 2.97 ms and 1.24 MB each |
| `isolated-vm`: loop, `timeout: 2000`; bomb, `memoryLimit: 64` | — | Loop stopped at 2001 ms, host free (198 ticks); bomb stopped after 147 ms: "Isolate was disposed during execution due to memory limit" |
| `isolated-vm`: `Promise.all` of three host waits of 200 ms; a loop after an `await`, `timeout: 1000` | — | 201 ms; the loop not stopped by the timeout, host free (297 ticks in 3 s), the host's `dispose()` ended it |
| OpenCode's interpreter: `return 1 + 1`; with one function | First 52.6 ms, then 1.09 ms (median of 11); 2.22 ms | Not run |
| OpenCode's interpreter: loop, `timeoutMs: 2000`; `Promise.all` of three 200 ms waits | `TimeoutExceeded` at 2054 ms, host free (188 ticks); 256 ms | — |
| OpenCode's interpreter: arrays of 0.8 MB, `timeoutMs: 3000` | `TimeoutExceeded` at 6770 ms; the host's 1 s timer fired once; 451 MB | — |
| OpenCode's interpreter: arrays of 8 MB, `timeoutMs` 3000 or 20000 | Not stopped: killed at 15 s and 20 s (1.1 GB); the host's 1 s timer never fired | — |
| OpenCode's interpreter: `class`; a getter; `10n ** 20n`; `/(a+)+$/` on 29 characters | `UnsupportedSyntax`; "Only init object properties are supported"; "BigInt literals are not supported"; `false` after 974 ms (no interrupt in a match, as its checklist says) | — |
| QuickJS (`pi-codemode` 1.5.2, 64 MiB, `timeoutMs: 3000`): `class`, a getter, BigInt, `Promise.all` | All work; `Promise.all` of three 200 ms waits in 241 ms | The same, 254 ms |
| QuickJS: the same regex; `while (true) {}`; recursion 100,000 deep | Both stopped at 3000 ms, host free (297 ticks); "Maximum call stack size exceeded", caught as a script error | The same |
| A process: `bun -e 0` / `node -e 0`, start and exit | 18.7 ms, 19 MB max RSS | 32.4 ms, 47 MB |

QuickJS's own costs (32 ms a program, 6 MB while it waits, a stop at once, a
1.3 MiB snapshot) are in `functions.md`, with their conditions.

## Options

**The kinds of engine:**

| Kind | A wall? | Memory limit | Stop of a loop; host free? | Async functions, `Promise.all` | Language |
| --- | --- | --- | --- | --- | --- |
| `node:vm` (a context in the host's engine) | No: Node says so; a passed function or a prototype reaches `process` (Runs) | None: the process's heap (Runs) | Default mode: only synchronous code; a loop after an `await` escapes. `afterEvaluate`: each evaluation's `timeout` also covers the context's microtasks, if the host drains the queue with a new `runInContext` after each of its promises settles (Runs). The host waits during each evaluation | Yes; a timeout after an `await` only with `afterEvaluate` and that drain | All of the host engine's (JavaScriptCore on Bun, V8 on Node), with `WebAssembly` |
| A V8 isolate in the process (`isolated-vm`, or a binding as Codex has) | Its own heap; a leaked reference ends it (its README) | A guideline, 2-3 times over | Yes for a script, host free; after an `await`, only the host's `dispose()` (Runs) | Yes, through references | All of V8's |
| A V8 isolate that the platform gives (Dynamic Workers) | The platform's | 128 MB an isolate (`runtime.md`) | `cpuMs` (`runtime.md`), a `timeout` (`code-mode.md`) | Yes | V8, with the Workers APIs |
| An interpreter of one's own (OpenCode's) | Only what it implements runs; values cross as copies | None; caps on one built-in | Between steps only; late or never under allocation, never in a regex match (Runs) | Yes | A subset: no classes, getters, BigInt, symbols |
| QuickJS in WebAssembly | Its own WebAssembly memory; no host object inside | Yes (`memoryLimitBytes`) | Yes in a worker thread, host free; inline it blocks the caller (`portability.md`) | Yes | ES with classes, getters, BigInt; no JIT |
| A process or container for each program | The OS's | The OS's (cgroup, `ulimit`) | A kill | Over a pipe or a socket | Whatever runs in it |

| Kind | Start, memory for each program | Snapshot of a waiting program | Bun / Node / `workerd` | What the harness builds and keeps |
| --- | --- | --- | --- | --- |
| `node:vm` | 0.15 ms, 110 KB (Bun) | No | Yes / yes / not proved | The globals and a watchdog; it cannot fix the wall |
| V8 isolate in the process | 3 ms, 1.2 MB (Node) | No (`isolated-vm`) | No (Runs) / yes / no | A native addon in maintenance, or a V8 binding of one's own (Codex: a Rust host process) |
| Platform V8 isolate | "Milliseconds" (`runtime.md`) | No | No / no / yes | Little; a second prelude (`portability.md`, E4) |
| Interpreter of one's own | 1 ms (Bun); memory not measured | Yes: JSON, "on the same build" (its README) | Yes / not run / not proved | All of a language: 20,750 lines of TypeScript in its `src/` at OpenCode |
| QuickJS in WebAssembly | 32 ms and 6 MB in a worker thread (`functions.md`) | In `quickjs-wasi`, not exposed by `pi-codemode` (`functions.md`) | Yes / yes / yes (inline or another object) | The service around `pi-codemode` |
| A process | 19 ms, 19 MB (Bun) | No | Yes / yes / no | Spawn, a protocol, a pool |

**What EverChat can do:**

| Option | Gives | Costs | Rules out |
| --- | --- | --- | --- |
| Q. Stay with QuickJS in both uses | One engine and one behavior on Bun, Node and `workerd` (the decision of round 3); a memory limit and a stop that the runs proved | 32 ms a program; no JIT | Nothing that is decided |
| Q+V. QuickJS, and `node:vm` behind the same `Sandbox` for the local use | Programs start in 0.15 ms and compute with a JIT | Two behaviors: a program that works locally may fail hosted; no memory limit; a stop of an async program only with `afterEvaluate` and a drain the host writes after each function call, each step under its own `timeout`, the host blocked meanwhile | The same program on every build |
| Q+P. QuickJS worker threads in a separate process for the hosted use | An OS wall between the engine and the process that holds the tenants' secrets and database | A protocol and a pool; a crash of the engine process ends every running program | Nothing |
| I. OpenCode's interpreter in place of QuickJS | Effect-native; a program as JSON at a suspend, which fits approval options C and D of `functions.md` | A subset of JavaScript; no heap limit; a timeout that allocation defeats; `workerd` not proved | A memory limit for each program |
| V8. A V8 isolate in the process | V8's speed and language; a heap of its own | Node only (not Bun, not `workerd`); a guideline limit; maintenance mode | Bun as the server runtime |

## What fits, what does not

- **The post is right on four of five counts, as far as sources go.** Codex
  runs V8 (out of process, a new isolate for each `exec`); OpenCode runs an
  interpreter of its own; `pi` runs QuickJS in WebAssembly. That Claude Code
  uses `node:vm` in Bun is not in any source of its owner: only that it ships
  as a Bun executable.
- **Hosted: only QuickJS, of what runs on Bun, is a wall that the runs could
  not break.** `node:vm` let a program reach `process` through a passed
  function and had no memory limit, on both runtimes; its timeout held after an
  `await` only with `afterEvaluate` and the host draining the context's queue,
  and the host's thread is blocked while a program computes. OpenCode's interpreter has no heap limit, and its timeout
  came late or never under allocation, with the host's thread blocked: one
  tenant's program would stall every chat in the process. `isolated-vm` does
  not load on Bun. QuickJS kept its 64 MiB limit, stopped a loop and a bad
  regex at the deadline, and left the host free.
- **Local: the engine is not the wall** (the model has `shell`), so `node:vm`
  would be safe enough, and 200 times faster to start. But a program waits on
  functions most of its time (a build, a search), and 32 ms is small next to a
  request to a model. QuickJS ran every case that a model writes (classes,
  getters, BigInt, `Promise.all`). A second engine would make a program behave
  differently between the local and hosted builds, against the decision of
  round 3.
- **Take from OpenCode the idea, not the engine.** Its JSON snapshot with
  idempotent and durable functions solves what approval option D needs
  (`functions.md`). QuickJS can snapshot too (`quickjs-wasi`), so the same idea
  can come to `pi-codemode` later.
- **First: Q.** Keep QuickJS for both uses, keep `Sandbox` as the one service
  for an engine, and add the run cases above (escape, loop after `await`,
  bomb, regex) to the sandbox's tests, so that any second engine must pass
  them. Q+P is the next wall for the hosted use, when it is measured.

## Limits

- No engine in the process is a hard wall: QuickJS's wall is its WebAssembly
  memory and the code of `pi-codemode`'s host side; a defect there reaches the
  process. Only Q+P or a VM for each tenant adds an OS wall (`runtime.md`).
- QuickJS has no JIT: a program that computes much runs slower than in V8 or
  JavaScriptCore. How much slower: not measured.
- `node:vm` cannot be made a wall by freezing: the passed functions belong to
  the host's realm (Runs).
- A stop of a QuickJS worker thread is a request: a long built-in can keep the
  thread busy (`functions.md`).
- What Claude Code really runs cannot be shown: its program is not open, and
  this research read no decompiled source.

## Questions for the operator

1. Keep QuickJS as the one engine for the local and the hosted use? Recommended:
   yes.
2. A second, faster engine (`node:vm`) for the local use only? Recommended: no:
   the speed is small next to a request, and programs would behave differently
   between builds.
3. Put the hosted engine's worker threads in a separate process (Q+P)?
   Recommended: not first; measure it after the hosted build runs.
4. Study OpenCode's JSON snapshot and durable functions for approval option D?
   Recommended: yes, as a design for `pi-codemode` with QuickJS's snapshot, not
   as a change of engine.
5. Make the run cases of this document (escape, loop after `await`, bomb,
   regex) tests that every engine behind `Sandbox` must pass? Recommended: yes.

## Words

| Term | Meaning |
| --- | --- |
| engine | As `portability.md` defines it: what runs a program (QuickJS, V8, JavaScriptCore, an interpreter). |
| vm context | Node's and Bun's name (`node:vm`) for a second set of globals inside the host's own engine. |
| isolate | V8's unit with its own heap; one process can hold many. |
| interpreter of one's own | An engine that a harness writes itself, which runs only the part of JavaScript that it implements. |
| escape | A program that reaches the host's objects (`process`) from inside its engine. |
| memory bomb | A program that allocates without end, to see whether its engine stops it. |
| wall | What keeps a program from the host process and from other tenants' data. |
