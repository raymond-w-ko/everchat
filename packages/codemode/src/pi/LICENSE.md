MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Upstream

The files of this directory are code of the library `@earendil-works/pi-codemode` 1.5.2, under the MIT license above: https://github.com/earendil-works/pi, directory `packages/codemode`, tag `v1.5.2`, commit `b4afdddf44e059c67ccf5097e5317d913521b470`. Each file keeps its path under upstream's `packages/codemode/src`: `index.ts` is `packages/codemode/src/index.ts`, `runtime/vm.ts` is `packages/codemode/src/runtime/vm.ts`, and so on for `portable.ts`, `source.ts`, `types.ts`, `wasm.ts` and `runtime/{execution,host,inline,prelude-source,protocol,remote,worker}.ts`. This `LICENSE.md` is upstream's `LICENSE` (the text above).

The code was written for `quickjs-wasi` 3.6.2. `runtime/vm.ts` uses that library's internal exports, so the version in `packages/codemode/package.json` is exactly this one, and a test (`packages/codemode/src/sandbox.test.ts`) checks that the manifest, the loaded `quickjs-wasi` and this line agree.

Left out of this directory:

- `declarations.ts` and `identifier.ts`, and the types of a tool, of a result, and `CodemodeDuring` (upstream `types.ts`, its lines 3 to 109 and 200 to 204): the core's part, in `packages/core/src/codemode` (its own `LICENSE.md` lists them).
- `cloudflare.ts` and `cloudflare-modules.d.ts`: they import `cloudflare:workers`, which no package of this tree may import until the Cloudflare package exists.
- Upstream's `packages/codemode/test/declarations.test.ts`: the core's part, in `packages/core/src/codemode` (its own `LICENSE.md` lists it). Upstream's other tests are in this tree, outside this directory (below, "The tests").

## Local changes

- `index.ts`, `portable.ts`, `runtime/execution.ts`: the imports of `./declarations.ts`, `./identifier.ts` and `../identifier.ts` name `@everchat/core/declarations` (the core's part, which exports `toCodemodeIdentifier` too). Nothing else of `index.ts` and `portable.ts` changes.
- `types.ts`: upstream's lines 3 to 110 (the tool and result types and the empty line after them) and 200 to 205 (`CodemodeDuring` and the empty line after it) are not here. In their place: a type import of `CodemodeResult` and `CodemodeTool` from `@everchat/core/codemode`, before the import of `./wasm.ts` (line 1), and after that import a type re-export of the eleven types that the core holds, so that `index.ts` and `portable.ts` export them from `./types.ts` as upstream does.
- `runtime/execution.ts`: `parts[0]!` (upstream's `parts[0]`, at its lines 157 and 161), for this project's `noUncheckedIndexedAccess`; and `type Control = { [K in "onStarted" | "onCall" | "onIdle"]: CodemodeRunOptions[K] };` (upstream's `Pick<CodemodeRunOptions, "onStarted" | "onCall" | "onIdle">`, its line 170), for this project's `exactOptionalPropertyTypes`. The JavaScript is the same.
- `source.ts`: `lines[0]!` (upstream's `lines[0]`, its line 117), for `noUncheckedIndexedAccess`. The JavaScript is the same.
- The thread engine counts polls, as the inline and the remote engines do, so that a program's compute has one bound in polls on each runtime, also while a tool is at work; with no count given, nothing changes:
  - `types.ts`: `CodemodeSandboxOptions` has the option `interruptBudget?: number | undefined` (no count by default).
  - `runtime/protocol.ts`: `WorkerData` has `interruptBudget?: number | undefined`; a new message of the worker, `WorkerExhaustedMessage` (`{ type: "exhausted"; budget }`), and its check `isWorkerExhaustedMessage`. It is no `WorkerToHostMessage`: the host reads it before the execution checks those.
  - `runtime/worker.ts`: with a budget, `shouldInterrupt` counts the polls over the whole execution and interrupts past the budget, as `runtime/inline.ts` does; once it has, a `done` or `crash` is posted as the `exhausted` message instead; it passes the budget to `startVm` (the deterministic fingerprint names it). The import of `./protocol.ts` names the new type, and `post` takes `WorkerToHostMessage | WorkerExhaustedMessage` (upstream's `WorkerToHostMessage`, its line 17).
  - `runtime/host.ts`: its import of `./protocol.ts` is `import { isWorkerExhaustedMessage, type WorkerData }` (upstream's `import type { WorkerData }`, its line 5); it passes `interruptBudget` to the worker, and turns the `exhausted` message into a `timeout` failure with the text of `runtime/inline.ts` ("Execution exceeded its interrupt budget of N"), before the execution reads the message; a comment says that the worker and the host come from one build.
- The thread engine starts its compute limit's clock after the worker's boot, so `execute()` gets the point after the boot that `start()` has; nothing else of the deterministic mode changes:
  - `runtime/vm.ts`: `started` is posted in both modes, after the prelude and before the script is compiled. Upstream posts it only in the deterministic mode (`if (clock) {`, its line 314); that line is now `{`, so the block keeps its other lines and the fingerprint is the same in both modes.
  - `types.ts`: `CodemodeExecuteOptions` has `onStarted?(fingerprint: string): void`.
  - `runtime/execution.ts`: `ExecutionOptions` has `onStarted`; `Execution` gives the `started` message to the run's `control.onStarted`, or else to `execute()`'s `onStarted` (a new field, set in the constructor); `execute()` passes its `onStarted`.
- The other files: no change.

## The tests

Upstream's other tests are in `packages/codemode/tests/pi`. Each keeps its path under upstream's `packages/codemode/test`: `sandbox.test.ts` is `packages/codemode/test/sandbox.test.ts`, and so on for `deterministic.test.ts`, `portable.test.ts`, `source.test.ts`, `worker-lifetime.test.ts` and `fixtures/{raw-worker,worker-process-exit}.ts`. They were adopted at a445f6b, and two files changed again at 4642986. Their local changes:

- Each test file: `bun:test` in place of `vitest` in its first import, and the imports of upstream's `../src/...` name `../../src/pi/...` (`fixtures/worker-process-exit.ts`: `../../../src/pi/runtime/host.ts`). `fixtures/raw-worker.ts` is upstream's, with no change.
- `sandbox.test.ts`: `BACKENDS[backend]!` (upstream's `BACKENDS[backend]`, its line 46), for `noUncheckedIndexedAccess`; and the worker's path in its line 829 names `../../src/pi/runtime/worker.ts`.
- `worker-lifetime.test.ts`, at a445f6b:
  - The `!`s of its `invocationCallOrder[0]`, `result`, `lines[0]` and `lines[1]` (upstream's lines 141, 148, 220 and 221), for `noUncheckedIndexedAccess`.
  - The fake timers: upstream's `await vi.advanceTimersByTimeAsync(100)` and `await vi.advanceTimersByTimeAsync(0)` (its lines 124 and 130) are `vi.advanceTimersByTime(...)` and then 20 turns of `await Promise.resolve()`, as Bun's fake timers have no async form.
  - The Node row runs `node` when `node --version` succeeds (upstream's `process.execPath`, always run, its line 206): under Bun, `process.execPath` is Bun.
- `worker-lifetime.test.ts` and `fixtures/worker-process-exit.ts`, at 4642986: time limits that hold on a loaded machine.
  - The fixture records `readyMs`, the time of the script's first tool call.
  - The case bounds an abort and a close from `readyMs`, not from the process's start; the deadline keeps upstream's bound from the start of `execute`.
  - The Bun rows give the child 120 s and the case 125 s (upstream: 20 s and 25 s for each row).
  - A comment block says what each row proves.

## Upstream's later changes

A person, not a seat of the factory (a fetch is a remote act), sees what upstream changed in these files since the commit above, in a clone of upstream (the owner's is `~/src/pi`, with the remote `upstream`):

```
git -C ~/src/pi fetch upstream
git -C ~/src/pi log --oneline b4afdddf44e059c67ccf5097e5317d913521b470..upstream/main -- packages/codemode/src packages/codemode/test
git -C ~/src/pi diff b4afdddf44e059c67ccf5097e5317d913521b470 upstream/main -- packages/codemode/src packages/codemode/test
```

Or, with no clone: `gh api repos/earendil-works/pi/compare/b4afdddf44e059c67ccf5097e5317d913521b470...main --jq '.files[].filename' | grep '^packages/codemode/'`.
