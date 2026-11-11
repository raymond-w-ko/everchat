// Sandbox
// =======
// The closed place where a program runs. A program is JavaScript that the
// model wrote. It runs in a QuickJS engine that is compiled to WebAssembly,
// in a worker thread of its own (the library `pi-codemode`). In there it
// has no files, no network, no timers, and no way to start a process. It
// can reach the world only through the functions (functions.ts), and each
// function runs here, on EverChat's side.
//
// What this module adds to the library
//
// - A call row for each function: written when the function starts, and
//   closed when it ends, with its whole result (docs/schema.html, `call`).
//   The hooks will run at the same two points.
// - The program's result as one text: what it printed, then what it
//   returned, or its error.
// - A memory limit, always. Without one, a program can take 4 GiB.
// - The compute limit, in place of a deadline for the whole program. A
//   program may wait for a function as long as that function takes (a
//   build, a test run), but it may not compute for more than COMPUTE with
//   no function at work. The sandbox has no timers, so a program that
//   computes for that long is in a loop.
// - No function is left at work. When a program ends, the functions that
//   it did not wait for are stopped, and the result says so. When a
//   program is stopped, its functions are stopped too. A function that was
//   stopped is closed as cut.
//
// A stop is a request. The library asks the worker thread to end and does
// not wait for it: a long built-in operation can keep the thread busy.
// The program's result does not wait for the thread, and the thread can
// do nothing more, because every function call goes through this module.
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

import { CodemodeSandbox, type CodemodeResult, loadQuickJSWasm } from "@earendil-works/pi-codemode"
import { Context, Effect, FiberSet, Layer } from "effect"
import QUICKJS from "quickjs-wasi/quickjs.wasm" with { type: "file" }
import { FunctionError, Functions } from "./functions.ts"
import { capped, HARD } from "./limit.ts"
import { Store } from "./store.ts"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "sandbox")

// The most memory that a program's engine may take.
export const MEMORY = 512 * 1024 * 1024

// The compute limit: the most time that a program may run with no function
// at work.
export const COMPUTE = 60_000

// The program of the worker thread. In the executable, every module's
// address is the executable's own, and Bun finds an entrypoint of the build
// by its path from the first entrypoint's directory. So worker.ts must
// stay next to main.ts. (The library's own default finds the same file in
// the executable today, but only because of that file's name.)
const WORKER = new URL("./worker.ts", import.meta.url)

// What the result of a function says when it was stopped.
export const STOPPED = "The function was stopped before it ended. It may or may not have finished."

export interface Ran {
  readonly output: string // the whole result, as text
  readonly failed: boolean
}

export interface Options {
  readonly memory?: number | undefined // bytes
  readonly compute?: number | undefined // milliseconds
}

// A function's result as the database keeps it.
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? "")

// The program's result as one text: what it printed, in order, then what it
// returned (a string as it is, another value as JSON), or its error.
// `left`: the functions that still ran when the program ended.
export const render = (result: CodemodeResult, left: ReadonlyArray<string>): Ran => {
  const parts: Array<string> = []
  for (const item of result.output) {
    parts.push(item.type === "text" ? item.text : "(An image was left out: a program cannot give images yet.)")
  }
  if (result.ok) {
    if (result.value !== undefined) {
      parts.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2))
    }
    if (left.length > 0) {
      parts.push(
        "(The program ended while " + left.length + (left.length === 1 ? " function" : " functions") + " still ran: " + left.join(", ") +
          ". Each was stopped, and may or may not have finished. Wait for every function with `await`.)"
      )
    }
  } else {
    const error = result.error
    parts.push(
      error.kind === "script"
        ? error.stack ?? (error.name === undefined ? "" : error.name + ": ") + error.message
        : error.kind === "sandbox"
        ? "The sandbox failed: " + error.message
        : error.message
    )
  }
  const whole = parts.join("\n")
  return { output: whole === "" ? "(The program gave no result.)" : capped(whole, HARD), failed: !result.ok }
}

export class Sandbox extends Context.Service<Sandbox, {
  // Runs a program to its end. `call` is the program's own call row. A
  // program that fails is a result, not an error.
  run(program: string, at: { readonly turn: number; readonly call: number }): Effect.Effect<Ran>
}>()("everchat/sandbox/Sandbox") {
  static readonly layer = (options: Options = {}) =>
    Layer.effect(
      Sandbox,
      Effect.gen(function*() {
        const functions = yield* Functions
        const store = yield* Store
        const memory = options.memory ?? MEMORY
        const compute = options.compute ?? COMPUTE

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
            wasm: loadQuickJSWasm(QUICKJS),
            workerUrl: WORKER,
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
}
