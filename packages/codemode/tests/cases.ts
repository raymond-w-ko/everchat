// Cases
// =====
// The four run cases that every engine of the sandbox must pass
// (docs/research/engines.md, the run cases): an escape, a loop after an
// `await`, a memory bomb and a slow regular expression. An engine's test
// file runs them with `cases(name, make)`, where `make` gives the engine's
// layer for the limits of a case.
//
// A case asserts on the result of `Sandbox.run` only: "stopped" and
// "failed", never a time, and not that the host stays free (an engine in
// the host's own thread blocks it while a program computes). A compute
// stop's message starts with STOP; a memory stop's message is the engine's
// own.
//
// Each case has one wall, and the other wall is far away: the loop and the
// slow regular expression have the small bound of compute and allocate
// nothing that nears the memory limit; the memory bomb has the small memory
// and a bound of compute that it cannot reach before the memory stop.
//
// The memory case pins two things. The limit's value: a program that holds
// about twice the limit fails, not by the compute stop, and one that holds
// about a quarter of it runs; both sizes come from the case's `memory`. And
// that a program with no end is ended by memory, not by the compute stop.
//
// One rule over every program of the suite: a program that the compute
// wall must stop runs under the small bound of compute (LIMITS), and every
// other program runs with the bound far away (FAR). Why: the thread
// engine's clock starts before the boot of its worker (thread.ts), so the
// boot counts against the bound, and on a loaded host the small bound can
// stop a program that computes nothing. So the escape case's programs run
// under FAR, and the `return 1` after a compute stop runs in a call of
// `runs` of its own, under FAR: it shows that the process's engine runs a
// program after a stop. What the suite then does not show: that one
// sandbox runs its next program after a compute stop on the same layer.
// That is each engine's own test: sandbox.test.ts, "the compute limit
// ...", and inline.test.ts, "the polls stop a program that loops ... and
// the next program runs".

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FunctionError, Functions } from "@everchat/core/functions"
import { type Ran, Sandbox } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"
import { newFile, PICK, withStore } from "@everchat/sqlite/testing"

// The limits of a case. `compute`: the engine's own bound of compute, in
// milliseconds of the thread engine; an engine that counts otherwise maps
// it itself.
export interface Limits {
  readonly memory: number // bytes
  readonly compute: number
}

export type Make = (limits: Limits) => Layer.Layer<Sandbox, never, Functions | Store>

// Small limits, so that each case ends in well under 3 s: for a program
// that the compute wall must stop.
const LIMITS: Limits = { memory: 32 * 1024 * 1024, compute: 250 }

// The far bound, for every other program: the same memory, and a bound of
// compute 40 times the small one. It is far past the memory stop (which
// comes in about 0.2 s), so that only the memory wall can end the memory
// bomb, and far past the boot of a worker on a loaded host.
const FAR: Limits = { memory: LIMITS.memory, compute: 10_000 }

// A program that holds `megabytes` strings of 1 MiB at once, then returns
// how many it holds.
const MiB = 2 ** 20
const hold = (megabytes: number) =>
  `const all = []; for (let i = 0; i < ${megabytes}; i++) all.push('x'.repeat(${MiB}) + i); return all.length`

// How the result of a stopped program begins, on every engine.
export const STOP = "The program was stopped"

// Fake functions: `echo` gives back its arguments, `nothing` gives nothing.
const functions = Layer.succeed(
  Functions,
  Functions.of({
    declarations: [
      { name: "echo", signature: "(...args)", description: "echo" },
      { name: "nothing", signature: "()", description: "nothing" }
    ],
    names: ["echo", "nothing"],
    approval: new Set(),
    call: (name, args) =>
      name === "echo" ? Effect.succeed(args) : name === "nothing" ? Effect.void : Effect.fail(new FunctionError({ message: "no such function" }))
  })
)

// Runs `programs` one after the other in the engine of `make`, with
// `limits` (by the rule above), each in a new call of one turn, in a new
// store, and gives their results.
const runs = (make: Make, programs: ReadonlyArray<string>, limits: Limits): Promise<Array<Ran>> =>
  withStore(
    newFile(),
    Effect.gen(function*() {
      const store = yield* Store
      const box = yield* Sandbox
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const results: Array<Ran> = []
      for (const [n, program] of programs.entries()) {
        const call = yield* store.startCall({ turn: turn.id, vendorId: "call_" + n, fn: "run", input: program })
        results.push(yield* box.run(program, { turn: turn.id, call }))
      }
      return results
    }).pipe(Effect.provide(make(limits).pipe(Layer.provide(functions))))
  )

// What a program sees of the world: `typeof` of each global that would be a
// way out, as one JSON text.
const GLOBALS = ["fetch", "require", "process", "setTimeout", "setInterval", "Bun", "Deno", "WebAssembly", "XMLHttpRequest", "WebSocket", "module"]
const globals = `return JSON.stringify([${GLOBALS.map((name) => "typeof " + name).join(", ")}])`

// The routes to the constructor of `Function`: through a function that the
// program is given, through values that a function gives back and their
// prototypes, and through the program's own functions. Each builds a
// function from text and runs it: that function runs in the engine, as the
// program does, or it fails. What it sees of the host's globals is written
// down; a route that fails is "failed".
const ROUTES = [
  "echo.constructor",
  "echo.constructor.constructor",
  "Object.getPrototypeOf(echo).constructor",
  "given.constructor.constructor",
  "given[0].constructor.constructor",
  "Object.getPrototypeOf(given[0]).constructor.constructor",
  "given[1].constructor.constructor",
  "given[2].constructor.constructor",
  "(function () {}).constructor",
  "(async function () {}).constructor",
  "(function* () {}).constructor"
]
const routes = [
  `const given = await echo({ a: 1 }, [1], "text")`,
  `const seen = []`,
  `for (const [route, make] of [${ROUTES.map((route) => "[" + JSON.stringify(route) + ", () => " + route + "]").join(", ")}]) {`,
  `  try {`,
  `    let got = make()("return [typeof process, typeof Bun, typeof require, typeof fetch, typeof this?.process, typeof globalThis.Bun]")()`,
  `    if (got && typeof got.then === "function") got = await got`,
  `    else if (got && typeof got.next === "function") got = got.next().value`,
  `    seen.push([route, got])`,
  `  } catch (error) {`,
  `    seen.push([route, "failed"])`,
  `  }`,
  `}`,
  `return JSON.stringify(seen)`
].join("\n")

// The four cases, for the engine `name`.
export const cases = (name: string, make: Make) => {
  test(`${name}: an escape: a program has no way out but its functions, by its globals or by a constructor`, async () => {
    const [seen, through] = await runs(make, [globals, routes], FAR)
    expect(seen!.failed).toBe(false)
    expect(JSON.parse(seen!.output)).toEqual(GLOBALS.map(() => "undefined"))
    expect(through!.failed).toBe(false)
    const got: Array<[string, unknown]> = JSON.parse(through!.output)
    expect(got.map(([route]) => route)).toEqual(ROUTES)
    // Each route builds a function that runs in the engine and sees none of
    // the host's globals, or it fails.
    for (const [route, one] of got) {
      if (one !== "failed") expect([route, one]).toEqual([route, ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]])
    }
    // At least one route reaches the engine's own constructor: the case
    // tries the wall, not a route that is closed before it.
    expect(got.some(([, one]) => one !== "failed")).toBe(true)
  })

  test(`${name}: a loop after an await is stopped, and the result failed`, async () => {
    const [loop] = await runs(make, ["await nothing(); for (;;) {}"], LIMITS)
    const [next] = await runs(make, ["return 1"], FAR)
    expect(loop!.failed).toBe(true)
    expect(loop!.output).toStartWith(STOP)
    expect(next).toEqual({ output: "1", failed: false })
  })

  test(`${name}: the memory wall: a program that holds twice the limit fails, a quarter of it runs, and a bomb fails by it`, async () => {
    // The limit's value, first: with no wall, the program of twice the limit
    // returns, and the case fails here, before the bomb.
    const twice = Math.round((2 * FAR.memory) / MiB)
    const quarter = Math.round(FAR.memory / 4 / MiB)
    const [over, under] = await runs(make, [hold(twice), hold(quarter)], FAR)
    expect(over!.failed).toBe(true)
    expect(over!.output).not.toStartWith(STOP)
    expect(under).toEqual({ output: String(quarter), failed: false })
    // A program with no end is ended by the memory wall, and the next one runs.
    const [bomb, next] = await runs(make, ["const all = []; for (;;) all.push('x'.repeat(1000000) + all.length)", "return 1"], FAR)
    expect(bomb!.failed).toBe(true)
    // Not the compute stop: the memory wall ended it.
    expect(bomb!.output).not.toStartWith(STOP)
    expect(next).toEqual({ output: "1", failed: false })
  })

  test(`${name}: a slow regular expression is stopped, the result failed, and the next program runs`, async () => {
    const [slow] = await runs(make, ["return /^(a+)+$/.test('a'.repeat(40) + '!')"], LIMITS)
    const [next] = await runs(make, ["return 1"], FAR)
    expect(slow!.failed).toBe(true)
    expect(slow!.output).toStartWith(STOP)
    expect(next).toEqual({ output: "1", failed: false })
  })
}
