// Thread
// ======
// The engine of the sandbox (sandbox.ts) for a local chat: a QuickJS engine
// that is compiled to WebAssembly, in a worker thread of its own for each
// program (the library `pi-codemode`).
//
// The two files of the engine
//
// The library looks for its worker thread's program and for the QuickJS
// file in `node_modules`. The executable has no `node_modules`. So both are
// parameters of the engine, in a way that holds in a run from source and in
// the executable:
//
// - QUICKJS: the QuickJS file, imported as a file. The build puts it into
//   the executable, and the import gives its path in there. It is the
//   default.
// - `worker`: the program of the worker thread, which the caller gives.
//   The executable's is local's worker.ts, the build's second entrypoint
//   (worker.ts says why, and main.ts gives it). With none, the library's
//   own worker runs, from `node_modules`.
//
// The limits of memory and compute are parameters too, with defaults.
//
// The call rows of the functions and the result are calls.ts's code, which
// both engines use.

/// <reference path="./assets.d.ts" />

import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode"
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
  readonly compute?: number | undefined // milliseconds
  // The compute budget, in milliseconds: the most time that a program may
  // compute with no function at work, summed over the whole program (the
  // compute limit bounds one such stretch). It does not bound what a
  // program computes while a function is at work: a program that starts a
  // function, does not wait for it, and computes, is not stopped by the
  // budget. Today nothing bounds what a program computes while a function
  // is at work; the deadline of a program, which a hosted deployment will
  // have, will bound it (docs/design.md, "Limits for hosted programs": 10
  // minutes; not built yet). None when not given: the local use has none,
  // and a hosted deployment sets it.
  readonly budget?: number | undefined
  readonly worker?: URL | undefined // the program of the worker thread
  readonly quickjs?: string | undefined // the path of the QuickJS file
}

// The numeric fields of `Options`: the type check holds this list to them.
const NUMBERS: Fields<Options> = { memory: true, compute: true, budget: true }

// A time for a person: seconds, with a tenth below 10 s.
const seconds = (ms: number): string => (ms >= 10_000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 100) / 10)) + " s"

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
      const budget = given.budget
      const worker = options.worker
      const quickjs = options.quickjs ?? QUICKJS

      const run = Effect.fn("Sandbox.run")(function*(program: string, at: { readonly turn: number; readonly call: number }) {
        // The functions at work, and one call of a function: its row, its
        // work, its row again (calls.ts).
        const calls = yield* functionCalls(at).pipe(
          Effect.provideService(Functions, functions),
          Effect.provideService(Store, store)
        )

        // The compute limit and the compute budget: a clock that runs only
        // while no function is at work. The limit starts again at each arm;
        // the budget is what is left of it, and each disarm takes from it
        // the time since the arm.
        const controller = new AbortController()
        let pending = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        let armed: number | null = null // when the clock was armed
        let left = budget ?? Number.POSITIVE_INFINITY
        let over = false
        const arm = () => {
          armed = performance.now()
          const spent = left <= compute
          timer = setTimeout(() => {
            controller.abort(new Error(
              spent
                ? "The program was stopped: it used up its compute budget, " + seconds(budget ?? 0) + " of compute in all with no function at work. Do less in one program."
                : "The program was stopped: it computed for " + Math.round(compute / 1000) + " s with no function at work. A program has no timers: to wait, call shell(\"sleep 5\")."
            ))
          }, Math.max(0, Math.min(compute, left)))
        }
        const disarm = () => {
          clearTimeout(timer)
          timer = undefined
          if (armed !== null) {
            left -= performance.now() - armed
            armed = null
          }
        }

        const vm = new CodemodeSandbox({
          timeoutMs: Number.POSITIVE_INFINITY,
          memoryLimitBytes: memory,
          // Read and compiled once: the library keeps it by its path.
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
          // The clock counts the boot of the worker too: `vm.execute` starts
          // a new worker and loads QuickJS, and on a loaded host that can
          // take most of the limit. The library's `execute` gives no point
          // after the boot; its `start` does (`onStarted`), but only in its
          // deterministic mode, which changes what a program sees. That is
          // the draft ec-q2nbc.
          arm()
          return vm.execute(program, { signal: controller.signal })
        }).pipe(
          Effect.ensuring(Effect.sync(() => {
            over = true
            disarm()
          }))
        )
        return yield* ran(result, calls.working)
      }, Effect.scoped)

      return Sandbox.of({ run })
    })
  )
}
