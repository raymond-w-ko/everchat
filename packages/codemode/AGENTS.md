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

## The gate of approval

`invoke` (`packages/codemode/src/calls.ts`), shared by both engines, is
the one place where a program's call of a function starts. A function
whose name is in `Functions.approval` (its entry says `approval: true`)
needs a person's yes before each run, and a program's call of it never
runs it. After the call's row is written and its arguments are a list (a
call whose arguments came in another form fails as any other, and makes no
approval), the store's `pendCall` closes the row as `pending` with the
text of `pending(n)` and makes the approval's row, with the row's exact
`input`, in one transaction; the program gets `pending(n)`
(`packages/core/src/functions.ts`) at once and goes on, and its other
calls run. The step is in the part that nothing interrupts, and the name
never joins `working`. A failure of `pendCall` gives the program the
database's `FunctionError`, as one of `startCall` does. The gate is before
`Functions.call`, never inside it: the run after a yes calls it with
`JSON.parse(input)`.

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
- Its two bounds of compute (`packages/codemode/src/thread.ts`): the
  compute limit (`compute`), a time for one stretch with no function at
  work, which starts again after each function; and the compute budget
  (`polls`), a count of the engine's polls over the whole program, also
  while a function is at work, as on the inline engine. The count is no
  time: work in a native between two polls is not counted. It has no
  default: the local use sets none, and a hosted deployment sets it after a
  measure there.
