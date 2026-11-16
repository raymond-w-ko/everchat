`packages/codemode/` (`@everchat/codemode`): the engines of the sandbox.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/codemode/` (`@everchat/codemode`): the engines of the sandbox.
  Its entries: `./thread` (`packages/codemode/src/thread.ts`, the engine
  in a worker thread, which a local chat runs) and `./inline`
  (`packages/codemode/src/inline.ts`, the engine in the caller's own
  thread). `packages/codemode/src/calls.ts` is no entry: the code that both
  engines share. `packages/codemode/tests/` holds `cases.ts`, the run cases
  that every engine must pass. A case of every engine goes into
  `tests/cases.ts`; a case of one engine goes into that engine's test file:
  `src/thread.test.ts` (the thread engine; its first cases are in
  `src/sandbox.test.ts`) or `src/inline.test.ts`.
- `packages/codemode/src/pi/` is adopted code: the engine's part, as
  adopted from the library `pi-codemode` 1.5.2 (MIT, its notice in
  `src/pi/LICENSE.md`). Each change of it is listed in that notice, and
  gets one review from each vendor.

## The thread engine

- The worker thread's program is our own `packages/local/src/worker.ts`, the
  second entrypoint of the build, which `packages/local/src/main.ts` gives as
  the option `worker`; with none, the package's own worker runs,
  `packages/codemode/src/pi/runtime/worker.ts` (the tests of `codemode`
  use that).
- `quickjs-wasi` is in `packages/codemode/package.json` for the import of
  the QuickJS file in `packages/codemode/src/thread.ts`. Its version must
  be the one that the adopted code was written for, which its notice
  records, and a test checks it (`packages/codemode/src/sandbox.test.ts`).
  Change both together.
