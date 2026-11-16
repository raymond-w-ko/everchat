// The four run cases (tests/cases.ts) on the thread engine (thread.ts): a
// QuickJS engine in a worker thread of its own for each program. Then this
// engine's own cases of its compute budget, the count of polls (the option
// `polls`).

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Functions } from "@everchat/core/functions"
import { type Ran, Sandbox } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"
import { newFile, PICK, withStore } from "@everchat/sqlite/testing"
import { cases } from "../tests/cases.ts"
import { inlineLayer } from "./inline.ts"
import { loadQuickJSWasm } from "./pi/index.ts"
import { threadLayer, type Options } from "./thread.ts"

cases("thread", (limits) => threadLayer({ memory: limits.memory, compute: limits.compute }))

// A fake function: `slow(ms)` sleeps for `ms` milliseconds.
const slow = Layer.succeed(
  Functions,
  Functions.of({
    declarations: [{ name: "slow", signature: "(ms)", description: "slow" }],
    names: ["slow"],
    call: (_name, args) => Effect.sleep(args[0] as number).pipe(Effect.as("slept"))
  })
)

// Runs `program` on the thread engine with `options` and the fake `slow`,
// in a new store: its result, and how long it took.
const run = (program: string, options: Options): Promise<Ran & { ms: number }> =>
  withStore(
    newFile(),
    Effect.gen(function*() {
      const store = yield* Store
      const box = yield* Sandbox
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const call = yield* store.startCall({ turn: turn.id, vendorId: "call_0", fn: "run", input: program })
      const started = performance.now()
      const got = yield* box.run(program, { turn: turn.id, call })
      return { ...got, ms: Math.round(performance.now() - started) }
    }).pipe(Effect.provide(threadLayer(options).pipe(Layer.provide(slow))))
  )

// Runs `programs` one after the other on the sandbox of `layer`, each in a
// new call of one turn, in a new store, with the fake `slow`.
const runs = (layer: Layer.Layer<Sandbox, never, Functions | Store>, programs: ReadonlyArray<string>): Promise<Array<Ran>> =>
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
    }).pipe(Effect.provide(layer.pipe(Layer.provide(slow))))
  )

// The count of polls. A poll is the engine's check for an interrupt, made
// as a program computes; a loop of 1,000,000 steps takes about 200 polls on
// this engine, the same number on each run, and a program that only
// returns takes 4 (the boot and the prelude take most of them). So the
// count of these cases, 1,000, is far above what a small program takes.
const POLLS = 1000
const SPENT = "The program was stopped: it computed for too long in all (1000 polls of the engine). Do less in one program."

test("thread: the count stops a program that starts a function, does not wait for it, and computes with no end", async () => {
  // No time limit stops this one: the compute limit waits while a function
  // is at work.
  const got = await run("slow(600000); for (;;) {}", { polls: POLLS })
  expect({ output: got.output, failed: got.failed }).toEqual({ output: SPENT, failed: true })
  expect(got.ms).toBeLessThan(20_000)
}, 30_000)

test("thread: the text of a program that the count stopped is the inline engine's, to the byte", async () => {
  const thread = await run("for (;;) {}", { polls: POLLS })
  const [inline] = await runs(inlineLayer({ wasm: loadQuickJSWasm(), polls: POLLS }), ["for (;;) {}"])
  expect(thread.output).toBe(SPENT)
  expect(inline).toEqual({ output: thread.output, failed: true })
}, 30_000)

test("thread: a program that waits for a slow function and then computes little is not stopped by the same count", async () => {
  const got = await run("const got = await slow(3000)\nlet n = 0\nfor (let i = 0; i < 1000; i++) n += i\nreturn got + ' ' + n", { polls: POLLS })
  expect({ output: got.output, failed: got.failed }).toEqual({ output: "slept 499500", failed: false })
  expect(got.ms).toBeGreaterThanOrEqual(3000)
}, 30_000)

// Twenty stretches of about 200 polls each, with a function waited for
// between two of them: about 4,000 polls in all, and each stretch far
// below the count.
const STRETCHES = "for (let k = 0; k < 20; k++) {\n  for (let i = 0; i < 1e6; i++) {}\n  await slow(1)\n}\nreturn 'done'"

test("thread: the count is over the whole program: a function call does not start it again", async () => {
  const got = await run(STRETCHES, { polls: POLLS })
  expect({ output: got.output, failed: got.failed }).toEqual({ output: SPENT, failed: true })
}, 30_000)

test("thread: with no count, the compute limit stops a loop as before, and a count never stops a program", async () => {
  const loop = await run("for (;;) {}", { compute: 1000 })
  expect({ output: loop.output, failed: loop.failed }).toEqual({
    output: "The program was stopped: it computed for 1 s with no function at work. A program has no timers: to wait, call shell(\"sleep 5\").",
    failed: true
  })
  // The program that the count stops above runs to its end.
  const whole = await run(STRETCHES, {})
  expect({ output: whole.output, failed: whole.failed }).toEqual({ output: "done", failed: false })
}, 30_000)


// The bound of a program that must run, as in sandbox.test.ts: far past a
// stretch of its compute on a loaded host.
const BOUND = 2000

test("thread: the compute limit is not armed while a function is still at work", async () => {
  // `a` is at work for three times the limit; `slow(10)` ends while it is.
  // The program computes nothing after that, so only a clock armed at the
  // first end, with `a` still at work, could stop it.
  const got = await run(`const a = slow(${3 * BOUND}); await slow(10); await a; return 'done'`, { compute: BOUND })
  expect({ output: got.output, failed: got.failed }).toEqual({ output: "done", failed: false })
  expect(got.ms).toBeGreaterThanOrEqual(3 * BOUND)
}, 30_000)
