// Worker thread
// =============
// The program of the sandbox's worker thread: the QuickJS engine, and the
// channel to the functions (the adopted code, `packages/codemode/src/pi`).
// The sandbox starts one such thread for each program (thread.ts).
//
// It is a file of local's, and not the engine's own
// (`packages/codemode/src/pi/runtime/worker.ts`), because of the
// executable: `bun build --compile` puts only the entrypoints of the build
// into the executable as programs that can start, and a thread starts from
// such a program. So this file is the build's second entrypoint (the
// `justfile`, recipe `build`). A run from source uses it too, so both run
// the same way.

import "@everchat/codemode/worker"
