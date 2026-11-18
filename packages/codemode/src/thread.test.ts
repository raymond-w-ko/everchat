// The four run cases (tests/cases.ts) on the thread engine (thread.ts): a
// QuickJS engine in a worker thread of its own for each program. Then this
// engine's own cases of its two bounds of compute: its compute budget, the
// count of polls (the option `polls`), and its compute limit, which is not
// armed while a function is still at work (the option `compute`). Last,
// the deadline of a program (`deadline`) and the count of its calls
// (`calls`).

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Functions } from "@everchat/core/functions"
import { type Ran, Sandbox, STOPPED } from "@everchat/core/sandbox"
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
    approval: new Set(),
    call: (_name, args) => Effect.sleep(args[0] as number).pipe(Effect.as("slept"))
  })
)

// The same `slow`, and a fake `shell` beside it: the functions of a
// terminal's chat hold one of that name.
const withShell = Layer.succeed(
  Functions,
  Functions.of({
    declarations: [
      { name: "slow", signature: "(ms)", description: "slow" },
      { name: "shell", signature: "(command)", description: "shell" }
    ],
    names: ["slow", "shell"],
    approval: new Set(),
    call: (name, args) => name === "slow" ? Effect.sleep(args[0] as number).pipe(Effect.as("slept")) : Effect.succeed("")
  })
)

// Runs `program` on the thread engine with `options` and the fake `slow`
// (or the functions of `fns`), in a new store: its result, and how long it
// took.
const run = (program: string, options: Options, fns: Layer.Layer<Functions> = slow): Promise<Ran & { ms: number }> =>
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
    }).pipe(Effect.provide(threadLayer(options).pipe(Layer.provide(fns))))
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

// The least count of polls at which `ran` runs to its end: a count past
// the polls that it takes, doubled from 8, then halved down to the edge.
// Found in the case, so that it holds when the boot's cost changes.
const least = async (ran: (polls: number) => Promise<Ran>): Promise<number> => {
  let high = 8
  while ((await ran(high)).failed) high *= 2
  let low = 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((await ran(mid)).failed) low = mid + 1
    else high = mid
  }
  return low
}

test("thread: a program is never stopped before its count: at its least count it runs, and at one less it is stopped with that number", async () => {
  // About 20 polls of the loop and 4 of the boot and the prelude.
  const program = "let n = 0\nfor (let i = 0; i < 100000; i++) n += i\nreturn n"
  const thread = await least((polls) => run(program, { polls }))
  // The inline engine counts the polls of the same engine by its own code
  // (pi/runtime/inline.ts), not the worker's: the two least counts agree,
  // so the worker stops a program at its count, not one poll before.
  const wasm = loadQuickJSWasm()
  const inline = await least(async (polls) => (await runs(inlineLayer({ wasm, polls }), [program]))[0]!)
  expect(thread).toBeGreaterThan(4)
  expect(thread).toBe(inline)
  const at = await run(program, { polls: thread })
  expect({ output: at.output, failed: at.failed }).toEqual({ output: "4999950000", failed: false })
  const below = await run(program, { polls: thread - 1 })
  expect({ output: below.output, failed: below.failed }).toEqual({
    output: "The program was stopped: it computed for too long in all (" + (thread - 1) + " polls of the engine). Do less in one program.",
    failed: true
  })
}, 60_000)

// Twenty stretches of about 200 polls each, with a function waited for
// between two of them: about 4,000 polls in all, and each stretch far
// below the count.
const STRETCHES = "for (let k = 0; k < 20; k++) {\n  for (let i = 0; i < 1e6; i++) {}\n  await slow(1)\n}\nreturn 'done'"

test("thread: the count is over the whole program: a function call does not start it again", async () => {
  const got = await run(STRETCHES, { polls: POLLS })
  expect({ output: got.output, failed: got.failed }).toEqual({ output: SPENT, failed: true })
}, 30_000)

test("thread: with no count, the compute limit stops a loop as before, and a count never stops a program", async () => {
  // Its functions hold no `shell`: the text names no function.
  const loop = await run("for (;;) {}", { compute: 1000 })
  expect({ output: loop.output, failed: loop.failed }).toEqual({
    output: "The program was stopped: it computed for 1 s with no function at work. A program has no timers. Do less in one program.",
    failed: true
  })
  // The program that the count stops above runs to its end.
  const whole = await run(STRETCHES, {})
  expect({ output: whole.output, failed: whole.failed }).toEqual({ output: "done", failed: false })
}, 30_000)

// The compute limit's text names `shell` only where the program has it
// (review ec-ihoya): the text of a terminal's chat, to the byte. A limit
// of 100 ms, said as "0 s", keeps the file's time.
test("thread: with a function named shell, the compute limit's text says to wait with it", async () => {
  const loop = await run("for (;;) {}", { compute: 100 }, withShell)
  expect({ output: loop.output, failed: loop.failed }).toEqual({
    output: "The program was stopped: it computed for 0 s with no function at work. A program has no timers: to wait, call shell(\"sleep 5\").",
    failed: true
  })
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

// The deadline of a program and the count of its calls (the options
// `deadline` and `calls`; review ec-ihoya). Each case runs `program` and
// reads the rows of the functions that it called.
const withRows = (program: string, options: Options): Promise<Ran & { ms: number; rows: Array<{ status: string; output: string | null }> }> =>
  withStore(
    newFile(),
    Effect.gen(function*() {
      const store = yield* Store
      const box = yield* Sandbox
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const call = yield* store.startCall({ turn: turn.id, vendorId: "call_0", fn: "run", input: program })
      const started = performance.now()
      const got = yield* box.run(program, { turn: turn.id, call })
      const ms = Math.round(performance.now() - started)
      const rows = (yield* store.calls(turn.id)).filter((row) => row.parent === call).map((row) => ({ status: row.status, output: row.output }))
      return { ...got, ms, rows }
    }).pipe(Effect.provide(threadLayer(options).pipe(Layer.provide(slow))))
  )

// The deadline of the cases in which a function is at work when it falls:
// the time at work is most of it, said as 1 or 2 s by its form (the short
// gaps of compute before the long call grow under load).
const DEADLINE = 2000
const LATE = /^The program was stopped: it ran for 2 s, the limit of one program, and functions were at work for [12] s of that time\. Do less in one program\.$/

const late = (working: number) =>
  "The program was stopped: it ran for 1 s, the limit of one program, and functions were at work for " + working + " s of that time. Do less in one program."

// (a)
test("thread: with a deadline, a program that calls a slow function in a loop is stopped at it; the result says the limit and the time that functions were at work, and the function at work then is stopped, its row cut", async () => {
  // Two calls that end at once, then one that outlasts the deadline by far:
  // a function is at work when the deadline falls, at any load, with no two
  // timers that must stay in step.
  const got = await withRows("for (let i = 0; i < 2; i++) await slow(0)\nfor (;;) await slow(600000)", { deadline: DEADLINE })
  expect(got.failed).toBe(true)
  // The time that functions were at work is most of the deadline, and the
  // call at work when it falls is counted: not 0 s.
  expect(got.output).toMatch(LATE)
  // The function at work then is stopped, and its row is cut; the ones before it ended.
  const last = got.rows[got.rows.length - 1]!
  expect(last).toEqual({ status: "cut", output: STOPPED })
  expect(got.rows.slice(0, -1).every((row) => row.status === "done" && row.output === "slept")).toBe(true)
  expect(got.rows.length).toBeGreaterThanOrEqual(1)
  expect(got.rows.length).toBeLessThanOrEqual(3)
  expect(got.ms).toBeGreaterThanOrEqual(DEADLINE)
  expect(got.ms).toBeLessThan(20_000)
  // A loop with no function: the deadline stops it too, before the compute
  // limit (60 s), with 0 s of functions.
  const loop = await withRows("for (;;) {}", { deadline: 1000 })
  expect({ output: loop.output, failed: loop.failed, rows: loop.rows }).toEqual({ output: late(0), failed: true, rows: [] })
}, 30_000)

// (a2)
test("thread: with a deadline, calls at work at one time are counted from the first one's start: a call not waited for, then short calls until the deadline", async () => {
  // The first call is at work from the start to the deadline; the short
  // ones start and end inside it, so no function is ever idle.
  const got = await withRows("slow(600000)\nfor (;;) await slow(200)", { deadline: DEADLINE })
  expect(got.failed).toBe(true)
  expect(got.output).toMatch(LATE)
  // The call not waited for is stopped at the program's end, its row cut;
  // the short ones before the last ended.
  expect(got.rows.length).toBeGreaterThanOrEqual(2)
  expect(got.rows[0]).toEqual({ status: "cut", output: STOPPED })
  expect(got.rows.slice(1, -1).every((row) => row.status === "done" && row.output === "slept")).toBe(true)
  expect(got.ms).toBeGreaterThanOrEqual(DEADLINE)
  expect(got.ms).toBeLessThan(20_000)
}, 30_000)

// (b)
test("thread: with a deadline, a program that ends before it has the result that it has with none", async () => {
  const program = "const got = await slow(10)\nreturn got + ' ' + [1, 2].join()"
  const bounded = await withRows(program, { deadline: 1000 })
  const free = await withRows(program, {})
  expect({ output: bounded.output, failed: bounded.failed, rows: bounded.rows }).toEqual({ output: free.output, failed: free.failed, rows: free.rows })
  expect(bounded.output).toBe("slept 1,2")
}, 30_000)

// A loop of ten calls that ends by itself.
const TEN = "for (let i = 0; i < 10; i++) await slow(1)\nreturn 'ten'"

// (c)
test("thread: with calls 3, a loop of calls makes 3 calls and writes 3 rows; the call past the count is not made, and the result says the limit", async () => {
  const got = await withRows(TEN, { calls: 3 })
  expect({ output: got.output, failed: got.failed }).toEqual({
    output: "The program was stopped: it reached the limit of 3 calls of functions in one program. Call fewer functions in one program.",
    failed: true
  })
  expect(got.rows).toEqual([1, 2, 3].map(() => ({ status: "done", output: "slept" })))
}, 30_000)

// (d)
test("thread: with neither option, the same loop makes its ten calls and ends", async () => {
  const got = await withRows(TEN, {})
  expect({ output: got.output, failed: got.failed }).toEqual({ output: "ten", failed: false })
  expect(got.rows.length).toBe(10)
}, 30_000)
