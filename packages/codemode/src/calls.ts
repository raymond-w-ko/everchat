// Calls
// =====
// The code that both engines of the sandbox share (thread.ts and
// inline.ts): the call rows of a program's functions, the program's result
// as the caller gets it, and the check of an engine's options. It is no entry of the package: each engine
// imports it, and neither engine imports the other. It imports no built-in
// module, so the inline engine still runs where none exists.

import type { CodemodeResult } from "./pi/portable.ts"
import { Effect, FiberSet } from "effect"
import { FunctionError, Functions } from "@everchat/core/functions"
import { type Ran, render, STOPPED } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "sandbox")

// A function's result as the database keeps it.
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? "")

// The calls of a program's functions, for both engines. `call` runs one:
// its row under the program's call, its work, its row again. `working`
// holds the functions at work, by their row. The scope's end stops each one that is
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

// The check of an engine's options
// ----------------------------------
// One rule for every numeric option of an engine: when given, it is an
// integer from 1 to LARGEST (2**31 - 1). Such a number reaches the engine
// as it is, through each conversion on its way:
//
// - The memory limit goes to QuickJS's WebAssembly export as a 32-bit
//   parameter (`qjs_set_memory_limit` of quickjs-wasi). A larger value
//   wraps, and a value below 1 becomes 0, which is no limit at all.
// - A time goes to `setTimeout`, whose largest delay is 2**31 - 1 ms; a
//   larger one is set to 1 ms.
//
// A value outside the domain is refused, never changed. The check is by
// field: each engine lists its numeric fields beside its `Options`
// (`Fields`, which the type check holds to exactly those fields), and the
// check reads each of them as the engine would (an inherited property and a
// getter too). `undefined` keeps the default; any other value that is not
// such a number, of any type, is refused. The check gives back the numbers
// that it read, and the engine uses only those: no numeric option is read
// twice, so a getter cannot give the engine a value that was not checked.

// The largest value of an engine's numeric option.
export const LARGEST = 2 ** 31 - 1

// The numeric fields of the options `T`.
type Numeric<T> = { [K in keyof T]-?: NonNullable<T[K]> extends number ? K : never }[keyof T]

// The list of the numeric fields of the options `T`: each of them, and no
// other name.
export type Fields<T> = { readonly [K in Numeric<T>]: true }

// A value in a message: a text in quotes, a bigint with its `n`.
const shown = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "bigint") return String(value) + "n"
  try {
    return String(value)
  } catch {
    return "a value of type " + typeof value
  }
}

// The numeric options of the engine `engine`, checked, at the call of its
// layer and before any layer is built. A field that is not given (or is
// `undefined`) is not in the result. It throws a RangeError for any other
// value outside the domain, with the option's name and the value.
export const numbers = <T extends object>(engine: string, options: T, fields: Fields<T>): { readonly [K in Numeric<T>]?: number } => {
  const checked: Record<string, number> = {}
  for (const name of Object.keys(fields)) {
    const value: unknown = (options as Record<string, unknown>)[name]
    if (value === undefined) continue
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LARGEST) {
      throw new RangeError("The option `" + name + "` of the " + engine + " engine must be an integer from 1 to " + LARGEST + ", not " + shown(value) + ".")
    }
    checked[name] = value
  }
  return checked as { readonly [K in Numeric<T>]?: number }
}
