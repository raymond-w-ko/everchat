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

## The thread engine

- The worker thread's program is our own `packages/local/src/worker.ts`, the
  second entrypoint of the build, which `packages/local/src/main.ts` gives as
  the option `worker`; with none, the library's own worker runs, from
  `node_modules` (the tests of `codemode` use that).
- `quickjs-wasi` is in `packages/codemode/package.json` for the import of
  the QuickJS file in `packages/codemode/src/thread.ts`. Its version must
  be the one that `pi-codemode` names, and a test checks it
  (`packages/codemode/src/sandbox.test.ts`). Change both together.
