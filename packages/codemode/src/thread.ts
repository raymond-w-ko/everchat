// Thread
// ======
// The engine of the sandbox (sandbox.ts) for a local chat: a QuickJS engine
// that is compiled to WebAssembly, in a worker thread of its own for each
// program (the code adopted from the library `pi-codemode`, in `pi/`).
//
// The two files of the engine
//
// The adopted code looks for its worker thread's program next to its own
// file (`pi/runtime/worker.ts`), and for the QuickJS file in `node_modules`.
// The executable has neither: a thread starts only from an entrypoint of
// the build, and it has no `node_modules`. So both are parameters of the
// engine, in a way that holds in a run from source and in the executable:
//
// - QUICKJS: the QuickJS file, imported as a file. The build puts it into
//   the executable, and the import gives its path in there. It is the
//   default.
// - `worker`: the program of the worker thread, which the caller gives.
//   The executable's is local's worker.ts, the build's second entrypoint
//   (worker.ts says why, and main.ts gives it). With none, the adopted
//   code's own worker runs, `pi/runtime/worker.ts` (the tests use that).
//
// The limits of memory and compute are parameters too, with defaults.
//
// The two bounds of compute:
//
// - The compute limit (`compute`, COMPUTE by default): a time, 60 s for one
//   stretch of compute with no function at work. Its clock starts when the
//   worker has booted (`onStarted`), not before; it stops while a function
//   is at work, and starts again after each function.
// - The compute budget (`polls`, none by default): a count of the engine's
//   interrupt polls over the whole program, also while a function is at
//   work; past it the program is stopped, with the inline engine's text.
//   It bounds bytecode work, not time: work in a native between two polls
//   (`repeat`, a string join, `JSON.parse`) is not counted (inline.ts). The
//   investigation's measures, on its machine (ec-mgwvn, K8): 100,000 polls
//   stop `for (;;) {}` after about 4.2 s, and do not stop
//   `for (;;) Date.now()` within 60 s, where the compute limit stops it.
//   The boot and the prelude take about 3 polls. The local use sets none;
//   a hosted deployment sets it after a measure there.
//
// The call rows of the functions and the result are calls.ts's code, which
// both engines use.

/// <reference path="./assets.d.ts" />

import { CodemodeSandbox, loadQuickJSWasm } from "./pi/index.ts"
import { Effect, Layer } from "effect"
import QUICKJS from "quickjs-wasi/quickjs.wasm" with { type: "file" }
import { Functions } from "@everchat/core/functions"
import { COMPUTE, MEMORY, Sandbox } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"
import { type Fields, functionCalls, numbers, ran } from "./calls.ts"

// Each number, when given, is an integer from 1 to 2**31 - 1: `threadLayer`
// throws a RangeError for any other value (calls.ts, `numbers`).
export interface Options {
  readonly memory?: number | undefined // bytes
  readonly compute?: number | undefined // milliseconds: the compute limit
  // The compute budget: the count of the engine's interrupt polls over the
  // whole program, also while a function is at work; past it the program
  // is stopped. A count, not a time, as on the inline engine (inline.ts
  // says what it bounds). None when not given: the worker then counts
  // nothing. The local use sets none; a hosted deployment sets it.
  readonly polls?: number | undefined
  readonly worker?: URL | undefined // the program of the worker thread
  readonly quickjs?: string | undefined // the path of the QuickJS file
}

// The numeric fields of `Options`: the type check holds this list to them.
// A name that is not on it (the old time budget, `budget`, too) is no
// option: the type check refuses it, and the engine does not read it.
const NUMBERS: Fields<Options> = { memory: true, compute: true, polls: true }

export const threadLayer = (options: Options = {}) => {
  // Read once, here: the engine uses only these.
  const given = numbers("thread", options, NUMBERS)
  return Layer.effect(
    Sandbox,
    Effect.gen(function*() {
      const functions = yield* Functions
      const store = yield* Store
      const memory = given.memory ?? MEMORY
      const compute = given.compute ?? COMPUTE
      const polls = given.polls
      const worker = options.worker
      const quickjs = options.quickjs ?? QUICKJS

      // The program that the count stopped: the inline engine's text, to
      // the byte (inline.ts), not the adopted code's, which names its
      // option. With no count, no program ends so.
      const spent = "The program was stopped: it computed for too long in all (" + polls +
        " polls of the engine). Do less in one program."

      const run = Effect.fn("Sandbox.run")(function*(program: string, at: { readonly turn: number; readonly call: number }) {
        // The functions at work, and one call of a function: its row, its
        // work, its row again (calls.ts).
        const calls = yield* functionCalls(at).pipe(
          Effect.provideService(Functions, functions),
          Effect.provideService(Store, store)
        )

        // The compute limit: a clock that runs only while no function is at
        // work, and starts again at each arm. The count of polls is the
        // worker's, and no function stops it.
        const controller = new AbortController()
        let pending = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        let over = false
        const arm = () => {
          timer = setTimeout(() => {
            controller.abort(new Error(
              "The program was stopped: it computed for " + Math.round(compute / 1000) + " s with no function at work. A program has no timers: to wait, call shell(\"sleep 5\")."
            ))
          }, compute)
        }
        const disarm = () => {
          clearTimeout(timer)
          timer = undefined
        }

        const vm = new CodemodeSandbox({
          timeoutMs: Number.POSITIVE_INFINITY,
          memoryLimitBytes: memory,
          ...(polls === undefined ? {} : { interruptBudget: polls }),
          // Read and compiled once: the adopted code keeps it by its path.
          wasm: loadQuickJSWasm(quickjs),
          ...(worker === undefined ? {} : { workerUrl: worker }),
          globals: calls.names.map((name) => ({
            name,
            spread: true,
            execute: (given: unknown) => {
              disarm()
              pending += 1
              return calls.call(name, given).finally(() => {
                pending -= 1
                if (pending === 0 && !over) arm()
              })
            }
          }))
        })

        const result = yield* Effect.promise((signal) => {
          signal.addEventListener("abort", () => controller.abort(new Error("The program was stopped.")), { once: true })
          // The clock starts after the boot: `vm.execute` starts a new
          // worker and loads QuickJS, which on a loaded host can take most
          // of the limit, and `onStarted` comes once, when the prelude has
          // run and before the program is compiled (pi/runtime/vm.ts). So
          // no clock runs for a worker that never starts. What ends such a
          // run is the stop: the fiber's interruption, or the end of the
          // scope that runs it, aborts `controller` (above), and the adopted
          // code then stops the worker. A worker that fails in its boot
          // ends the run with its crash.
          return vm.execute(program, { signal: controller.signal, onStarted: arm })
        }).pipe(
          Effect.ensuring(Effect.sync(() => {
            over = true
            disarm()
          }))
        )
        // With no deadline (`timeoutMs`), only the count ends a program as
        // a `timeout`.
        return yield* ran(
          polls !== undefined && !result.ok && result.error.kind === "timeout" ? { ...result, error: { ...result.error, message: spent } } : result,
          calls.working
        )
      }, Effect.scoped)

      return Sandbox.of({ run })
    })
  )
}
