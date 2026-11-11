// Worker thread
// =============
// The program of the sandbox's worker thread: the QuickJS engine, and the
// channel to the functions (the library `pi-codemode`). The sandbox starts
// one such thread for each program (sandbox.ts).
//
// It is a file of ours, and not the library's own, because of the
// executable: `bun build --compile` puts only the entrypoints of the build
// into the executable as programs that can start, and a thread starts from
// such a program. So this file is the build's second entrypoint (the
// `justfile`, recipe `build`). A run from source uses it too, so both run
// the same way.

import "@earendil-works/pi-codemode/worker"
