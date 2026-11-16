// Inline
// ======
// The second engine of the sandbox (sandbox.ts): a QuickJS engine that is
// compiled to WebAssembly, in the caller's own thread
// (`InlineCodemodeSandbox` of `pi/portable.ts`, adopted from `pi-codemode`).
// It needs no worker thread, no file and no built-in module of Node or
// Bun, so it runs where threads do not exist: in tests now, and later on
// the server side of a separate Worker (the Cloudflare build). The
// executable does not use it; a local chat runs on the thread engine
// (thread.ts).
//
// For all that a caller sees, it keeps the thread engine's contract: the
// result (what the program printed, then what it returned), a failed
// program, a row for each call of a function under the program's call,
// functions at the same time, a function that fails, a function that the
// program did not wait for, a stop. The code of the call rows and of the
// result is calls.ts's, which both engines use.
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
// - This engine has no limit in time. Its compute budget is the count of
//   polls, `polls` (above). Where it is
//   used, a limit of the platform on CPU time must bound it, or the thread
//   engine is used.
// - It blocks its host while a program computes: no timer and no other
//   work of the host runs until the program waits for a function or uses up
//   its polls. So a stop does not reach a program that loops. A stop
//   reaches a program while it waits for a function.
// - Memory: `memory`, as on the thread engine.
//
// The QuickJS file: the adopted code needs it compiled, as a WebAssembly
// module (`wasm`), and this engine cannot read a file. The caller gives it:
// from source on Bun or Node, `loadQuickJSWasm()` of `pi/index.ts` (which
// reads the file of `quickjs-wasi` from `node_modules`); on
// Cloudflare, the module that Wrangler compiles.

import { type CodemodeWasmModule, DEFAULT_INTERRUPT_BUDGET, InlineCodemodeSandbox } from "./pi/portable.ts"
import { Effect, Layer } from "effect"
import { Functions } from "@everchat/core/functions"
import { MEMORY, Sandbox } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"
import { type Fields, functionCalls, numbers, ran } from "./calls.ts"

// Each number, when given, is an integer from 1 to 2**31 - 1: `inlineLayer`
// throws a RangeError for any other value (calls.ts, `numbers`).
export interface Options {
  readonly memory?: number | undefined // bytes
  readonly polls?: number | undefined // interrupt polls over the whole program
  readonly wasm: CodemodeWasmModule | Promise<CodemodeWasmModule> // the compiled QuickJS file
}

// The numeric fields of `Options`: the type check holds this list to them.
const NUMBERS: Fields<Options> = { memory: true, polls: true }

// The default count of polls: the adopted code's. A count of the engine's
// interrupt checks, not a time (the header says why).
export const POLLS = DEFAULT_INTERRUPT_BUDGET

export const inlineLayer = (options: Options) => {
  // Read once, here: the engine uses only these.
  const given = numbers("inline", options, NUMBERS)
  return Layer.effect(
    Sandbox,
    Effect.gen(function*() {
      const functions = yield* Functions
      const store = yield* Store
      const memory = given.memory ?? MEMORY
      const polls = given.polls ?? POLLS
      const wasm = options.wasm

      // The adopted code's message for the polls names its option; the
      // model reads this one.
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
}
