// Sandbox
// =======
// The closed place where a program runs. A program is JavaScript that the
// model wrote. It runs in a QuickJS engine that is compiled to WebAssembly,
// in a worker thread of its own (the library `pi-codemode`). In there it
// has no files, no network, no timers, and no way to start a process. It
// can reach the world only through the functions (functions.ts), and each
// function runs here, on EverChat's side.
//
// This file is the core's part: the tag, the limits, and how a result
// reads. The engine of a local chat, a QuickJS engine in a worker thread,
// is in thread.ts. What the engine adds to the library:
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
// do nothing more, because every function call goes through the engine.

import type { CodemodeResult } from "@earendil-works/pi-codemode/portable"
import { Context, type Effect } from "effect"
import { capped, HARD } from "./limit.ts"

// The most memory that a program's engine may take.
export const MEMORY = 512 * 1024 * 1024

// The compute limit: the most time that a program may run with no function
// at work.
export const COMPUTE = 60_000

// What the result of a function says when it was stopped.
export const STOPPED = "The function was stopped before it ended. It may or may not have finished."

export interface Ran {
  readonly output: string // the whole result, as text
  readonly failed: boolean
}

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
}>()("everchat/sandbox/Sandbox") {}
