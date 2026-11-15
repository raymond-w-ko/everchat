// Inline
// ======
// The second engine of the sandbox (sandbox.ts): a QuickJS engine that is
// compiled to WebAssembly, in the caller's own thread (the library
// `pi-codemode`, `InlineCodemodeSandbox` of its entry `/portable`). It needs
// no worker thread, no file and no built-in module of Node or Bun, so it
// runs where threads do not exist: in tests now, and later on the server
// side of a separate Worker (the Cloudflare build). The executable does not
// use it; a local chat runs on the thread engine (thread.ts).
//
// For all that a caller sees, it keeps the thread engine's contract: the
// result (what the program printed, then what it returned), a failed
// program, a row for each call of a function under the program's call,
// functions at the same time, a function that fails, a function that the
// program did not wait for, a stop. The code of the call rows and of the
// result is this file's, and thread.ts uses it too.
//
// Its limits differ from the thread engine's:
//
// - Compute: `polls`, a count of the engine's interrupt checks over the
//   whole program, also while a function is at work; not a time. QuickJS
//   checks every so many bytecode steps, and work in a native between two
//   checks (`repeat`, a string join, `JSON.parse`) is not counted. So the
//   polls do not bound a program's time: one line can block its host for
//   minutes. Measured in the review ec-oibo3, with 10,000 polls and 32 MiB
//   of memory: `for (;;) {}` was stopped after 0.42 s, and the slow regular
//   expression of tests/cases.ts after 2.6 s, but `for (;;)
//   'x'.repeat(1e5)` still ran after 100 s.
// - This engine has no limit in time and no compute budget. Where it is
//   used, a limit of the platform on CPU time must bound it, or the thread
//   engine is used.
// - It blocks its host while a program computes: no timer and no other
//   work of the host runs until the program waits for a function or uses up
//   its polls. So a stop does not reach a program that loops. A stop
//   reaches a program while it waits for a function.
// - Memory: `memory`, as on the thread engine.
//
// The QuickJS file: the library needs it compiled, as a WebAssembly module
// (`wasm`), and this engine cannot read a file. The caller gives it: from
// source on Bun or Node, `loadQuickJSWasm()` of the library's main entry
// (which reads the file of `quickjs-wasi` from `node_modules`); on
// Cloudflare, the module that Wrangler compiles.

import { type CodemodeResult, type CodemodeWasmModule, DEFAULT_INTERRUPT_BUDGET, InlineCodemodeSandbox } from "@earendil-works/pi-codemode/portable"
import { Effect, FiberSet, Layer } from "effect"
import { FunctionError, Functions } from "@everchat/core/functions"
import { MEMORY, type Ran, render, Sandbox, STOPPED } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "sandbox")

export interface Options {
  readonly memory?: number | undefined // bytes
  readonly polls?: number | undefined // interrupt polls over the whole program
  readonly wasm: CodemodeWasmModule | Promise<CodemodeWasmModule> // the compiled QuickJS file
}

// The default count of polls: the library's. A count of the engine's
// interrupt checks, not a time (the header says why).
export const POLLS = DEFAULT_INTERRUPT_BUDGET

// A function's result as the database keeps it.
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? "")

// The calls of a program's functions, for both engines (this one and
// thread.ts; not an entry of the package). `call` runs one: its row under
// the program's call, its work, its row again. `working` holds the
// functions at work, by their row. The scope's end stops each one that is
// left, and waits until its row is closed.
export const functionCalls = (at: { readonly turn: number; readonly call: number }) =>
  Effect.gen(function*() {
    const functions = yield* Functions
    const store = yield* Store
    const fibers = yield* FiberSet.make<unknown, FunctionError>()
    const promise = yield* FiberSet.runtimePromise(fibers)<never>()
    const working = new Map<number, string>()
    const broken = (op: string) => new FunctionError({ message: "EverChat's database failed (" + op + ")." })

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

    return {
      names: functions.names,
      call: (name: string, given: unknown): Promise<unknown> => promise(invoke(name, given)),
      working
    }
  })

// The program's result as the caller gets it, for both engines: a failure
// of the sandbox itself is also a diagnostic.
export const ran = (result: CodemodeResult, working: ReadonlyMap<number, string>): Effect.Effect<Ran> =>
  Effect.gen(function*() {
    if (!result.ok && result.error.kind === "sandbox") {
      yield* diagnostic(Effect.logError(`the sandbox failed: ${result.error.message}`))
    }
    return render(result, [...working.values()])
  })

export const inlineLayer = (options: Options) =>
  Layer.effect(
    Sandbox,
    Effect.gen(function*() {
      const functions = yield* Functions
      const store = yield* Store
      const memory = options.memory ?? MEMORY
      const polls = options.polls ?? POLLS
      const wasm = options.wasm

      // The library's message for the polls names its option; the model
      // reads this one.
      const spent = "The program was stopped: it computed for too long in all (" + polls +
        " polls of the engine). Do less in one program."

      const run = Effect.fn("Sandbox.run")(function*(program: string, at: { readonly turn: number; readonly call: number }) {
        const calls = yield* functionCalls(at).pipe(
          Effect.provideService(Functions, functions),
          Effect.provideService(Store, store)
        )
        const vm = new InlineCodemodeSandbox({
          timeoutMs: Number.POSITIVE_INFINITY,
          memoryLimitBytes: memory,
          interruptBudget: polls,
          wasm,
          globals: calls.names.map((name) => ({ name, spread: true, execute: (given: unknown) => calls.call(name, given) }))
        })
        const controller = new AbortController()
        const result = yield* Effect.promise((signal) => {
          signal.addEventListener("abort", () => controller.abort(new Error("The program was stopped.")), { once: true })
          return vm.execute(program, { signal: controller.signal })
        })
        return yield* ran(
          !result.ok && result.error.kind === "timeout" ? { ...result, error: { ...result.error, message: spent } } : result,
          calls.working
        )
      }, Effect.scoped)

      return Sandbox.of({ run })
    })
  )
