// Thread
// ======
// The engine of the sandbox (sandbox.ts) for a local chat: a QuickJS engine
// that is compiled to WebAssembly, in a worker thread of its own for each
// program (the library `pi-codemode`).
//
// The two files of the engine
//
// The library looks for its worker thread's program and for the QuickJS
// file in `node_modules`. The executable has no `node_modules`. So this
// module names both itself, in a way that holds in a run from source and
// in the executable:
//
// - QUICKJS: the QuickJS file, imported as a file. The build puts it into
//   the executable, and the import gives its path in there.
// - WORKER: our own worker.ts, next to this file. It is the build's second
//   entrypoint, and worker.ts says why.
//
// Both are parameters of the engine, as are its limits of memory and
// compute: these are their defaults.

import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode"
import { Effect, FiberSet, Layer } from "effect"
import QUICKJS from "quickjs-wasi/quickjs.wasm" with { type: "file" }
import { FunctionError, Functions } from "./functions.ts"
import { COMPUTE, MEMORY, render, Sandbox, STOPPED } from "./sandbox.ts"
import { Store } from "./store.ts"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "sandbox")

// The program of the worker thread. In the executable, every module's
// address is the executable's own, and Bun finds an entrypoint of the build
// by its path from the first entrypoint's directory. So worker.ts must
// stay next to main.ts. (The library's own default finds the same file in
// the executable today, but only because of that file's name.)
const WORKER = new URL("./worker.ts", import.meta.url)

export interface Options {
  readonly memory?: number | undefined // bytes
  readonly compute?: number | undefined // milliseconds
  readonly worker?: URL | undefined // the program of the worker thread
  readonly quickjs?: string | undefined // the path of the QuickJS file
}

// A function's result as the database keeps it.
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? "")

export const threadLayer = (options: Options = {}) =>
  Layer.effect(
    Sandbox,
    Effect.gen(function*() {
      const functions = yield* Functions
      const store = yield* Store
      const memory = options.memory ?? MEMORY
      const compute = options.compute ?? COMPUTE
      const worker = options.worker ?? WORKER
      const quickjs = options.quickjs ?? QUICKJS

      const broken = (op: string) => new FunctionError({ message: "EverChat's database failed (" + op + ")." })

      const run = Effect.fn("Sandbox.run")(function*(program: string, at: { readonly turn: number; readonly call: number }) {
        // The functions at work, by their call. The scope's end stops
        // each one that is left, and waits until its row is closed.
        const fibers = yield* FiberSet.make<unknown, FunctionError>()
        const promise = yield* FiberSet.runtimePromise(fibers)<never>()
        const working = new Map<number, string>()

        // One call of a function: its row, its work, its row again.
        const invoke = (name: string, given: unknown) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function*() {
              const args: ReadonlyArray<unknown> = Array.isArray(given) ? given : []
              const id = yield* Effect.mapError(
                store.startCall({ turn: at.turn, parent: at.call, fn: name, input: JSON.stringify(args) }),
                () => broken("startCall")
              )
              working.set(id, name)
              const work = restore(functions.call(name, args, { turn: at.turn, program: at.call, call: id })).pipe(
                Effect.catchDefect((defect) => Effect.fail(new FunctionError({ message: "EverChat failed in this function: " + String(defect) }))),
                Effect.onInterrupt(() => Effect.ignore(store.endCall(id, { status: "cut", output: STOPPED })))
              )
              const got = yield* Effect.result(work)
              working.delete(id)
              if (got._tag === "Failure") {
                yield* Effect.mapError(store.endCall(id, { status: "failed", output: got.failure.message }), () => broken("endCall"))
                return yield* Effect.fail(got.failure)
              }
              yield* Effect.mapError(store.endCall(id, { status: "done", output: text(got.success) }), () => broken("endCall"))
              return got.success
            })
          )

        // The compute limit: a clock that runs only while no function is
        // at work.
        const controller = new AbortController()
        let pending = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        let over = false
        const arm = () => {
          timer = setTimeout(() => {
            controller.abort(new Error("The program was stopped: it computed for " + Math.round(compute / 1000) + " s with no function at work. A program has no timers: to wait, call shell(\"sleep 5\")."))
          }, compute)
        }
        const disarm = () => {
          clearTimeout(timer)
          timer = undefined
        }

        const vm = new CodemodeSandbox({
          timeoutMs: Number.POSITIVE_INFINITY,
          memoryLimitBytes: memory,
          // Read and compiled once: the library keeps it by its path.
          wasm: loadQuickJSWasm(quickjs),
          workerUrl: worker,
          globals: functions.names.map((name) => ({
            name,
            spread: true,
            execute: (given: unknown) => {
              disarm()
              pending += 1
              return promise(invoke(name, given)).finally(() => {
                pending -= 1
                if (pending === 0 && !over) arm()
              })
            }
          }))
        })

        const result = yield* Effect.promise((signal) => {
          signal.addEventListener("abort", () => controller.abort(new Error("The program was stopped.")), { once: true })
          arm()
          return vm.execute(program, { signal: controller.signal })
        }).pipe(
          Effect.ensuring(Effect.sync(() => {
            over = true
            disarm()
          }))
        )
        if (!result.ok && result.error.kind === "sandbox") {
          yield* diagnostic(Effect.logError(`the sandbox failed: ${result.error.message}`))
        }
        return render(result, [...working.values()])
      }, Effect.scoped)

      return Sandbox.of({ run })
    })
  )
