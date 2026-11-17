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
// The bounds of compute:
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
// Neither bound stops work in a native while a function is at work: the
// compute limit's clock is stopped then, and the count does not see work
// between two polls. A review's probe, `slow(25000); for (;;)
// 'x'.repeat(1e5)` with `{ polls: 1000 }`, ran for 85 s. Nor does either
// bound a program that calls functions in a loop: each call stops the
// compute limit's clock, and a wait for a function takes no poll. A
// review's probe, `for (;;) { await result(1) }`, ran on for 8 s and wrote
// 2,136 call rows (ec-ihoya). Two more bounds, none by default, so the
// local use is unchanged:
//
// - The deadline of a program (`deadline`, docs/design.md, "Limits for
//   hosted programs"): a time over the whole program, a function at work
//   too. Its clock starts when the worker has booted (`onStarted`), as the
//   compute limit's. At it the program is stopped as the compute limit
//   stops it, and a function at work then is stopped as at every other end
//   of a program (its row is closed as cut). The result says the limit and
//   how long functions were at work in that time, so the model can tell a
//   slow function from its own compute.
// - The count of the calls of one program (`calls`): the call that would
//   pass it is not made (no row of it is written), and the program is
//   stopped. With it, the bytes of one program's calls are at most `calls`
//   times the largest input and output of one call.
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
  // says what it bounds): work in a native between two polls is not
  // counted, while a function is at work too (the head says what bounds
  // it then). None when not given: the worker then counts nothing. The
  // local use sets none; a hosted deployment sets it.
  readonly polls?: number | undefined
  // The deadline of a program (the head comment), in milliseconds: none
  // when not given. A hosted deployment sets it (10 minutes, the design's).
  readonly deadline?: number | undefined
  // The count of the calls of functions in one program (the head comment):
  // none when not given.
  readonly calls?: number | undefined
  readonly worker?: URL | undefined // the program of the worker thread
  readonly quickjs?: string | undefined // the path of the QuickJS file
}

// The numeric fields of `Options`: the type check holds this list to them.
// A name that is not on it (the old time budget, `budget`, too) is no
// option: the type check refuses it, and the engine does not read it.
const NUMBERS: Fields<Options> = { memory: true, compute: true, polls: true, deadline: true, calls: true }

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
      const deadline = given.deadline
      const most = given.calls
      const worker = options.worker
      const quickjs = options.quickjs ?? QUICKJS

      // The program that the count stopped: the inline engine's text, to
      // the byte (inline.ts), not the adopted code's, which names its
      // option. With no count, no program ends so.
      const spent = "The program was stopped: it computed for too long in all (" + polls +
        " polls of the engine). Do less in one program."

      // The two texts of the deadline and the count: one for every use,
      // with no word of the use and no name of a function. The deadline in
      // whole seconds, rounded up (a limit is never "0 s"); the time of the
      // functions at work rounded.
      const late = (working: number) =>
        "The program was stopped: it ran for " + Math.ceil((deadline ?? 0) / 1000) + " s, the limit of one program, and functions were at work for " +
        Math.round(working / 1000) + " s of that time. Do less in one program."
      const many = "The program was stopped: it reached the limit of " + most + " calls of functions in one program. Call fewer functions in one program."

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
        // The functions' time at work: the time while at least one ran.
        let worked = 0
        let since = 0
        // The calls made, for the count.
        let made = 0
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined
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
        // At the boot's end (`onStarted`): the compute limit's clock, and the
        // deadline's, which no function stops.
        const started = () => {
          arm()
          if (deadline !== undefined) {
            deadlineTimer = setTimeout(() => {
              const now = performance.now()
              controller.abort(new Error(late(worked + (pending > 0 ? now - since : 0))))
            }, deadline)
          }
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
              // The call past the count is not made: no row, and the
              // program is stopped.
              if (most !== undefined && made >= most) {
                const stop = new Error(many)
                controller.abort(stop)
                return Promise.reject(stop)
              }
              made += 1
              disarm()
              if (pending === 0) since = performance.now()
              pending += 1
              return calls.call(name, given).finally(() => {
                pending -= 1
                if (pending === 0) worked += performance.now() - since
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
          return vm.execute(program, { signal: controller.signal, onStarted: started })
        }).pipe(
          Effect.ensuring(Effect.sync(() => {
            over = true
            disarm()
            clearTimeout(deadlineTimer)
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
