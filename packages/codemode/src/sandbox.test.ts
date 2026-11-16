// Tests of the sandbox, with real programs in the real engine and with
// fake functions: a program's result, its functions and their call rows,
// its limits, and a stop. The run cases of every engine (tests/cases.ts,
// run by thread.test.ts) are not repeated here: what is here is this
// engine's own.
//
// The bounds, by the suite's rule: the engine's clock starts before the
// boot of its worker (thread.ts), which on a loaded host can take most of
// a second, so a program that must run has a bound of BOUND, far past that
// boot, with its stretches of compute and its waits sized to it; only a
// program that a wall must stop runs under the small bound of 250 ms.

import { expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { newFile, options, PICK, rows } from "@everchat/sqlite/testing"
import { type Caller, FunctionError, Functions } from "@everchat/core/functions"
import { Sandbox, STOPPED } from "@everchat/core/sandbox"
import { storeLayer } from "@everchat/sqlite/bun"
import { Store } from "@everchat/core/store"
import { threadLayer } from "./thread.ts"

type Fake = (args: ReadonlyArray<unknown>, caller: Caller) => Effect.Effect<unknown, FunctionError>

test("the QuickJS file that the sandbox loads is the one that the adopted code was written for", async () => {
  // The sandbox imports the QuickJS file itself, so that it is in the
  // executable. The adopted code (pi/) was written for one version of
  // `quickjs-wasi`, which its notice (pi/LICENSE.md) records, and it uses
  // that library's internal exports (pi/runtime/vm.ts). So ours must be
  // exactly that one: another engine under the adopted code can fail in
  // ways that no other test here would show.
  const notice = await Bun.file(new URL("./pi/LICENSE.md", import.meta.url)).text()
  const written = /The code was written for `quickjs-wasi` (\d+\.\d+\.\d+)\./.exec(notice)?.[1]
  const ours = await Bun.file(new URL("../package.json", import.meta.url)).json()
  const loaded = await Bun.file(new URL("../node_modules/quickjs-wasi/package.json", import.meta.url)).json()
  expect(written).toBe("3.6.2")
  expect(ours.dependencies["quickjs-wasi"]).toBe(written)
  expect(loaded.version).toBe(written)
})

// Fake functions. `seen` holds what each call got.
const fakes = () => {
  const seen: Array<{ name: string; args: ReadonlyArray<unknown>; caller: Caller }> = []
  const state = { stopped: 0 }
  // When each slow function started and ended, on the host's clock.
  const times: Array<{ name: string; start: number; end: number }> = []
  const table: Record<string, Fake> = {
    add: (args) => Effect.succeed((args[0] as number) + (args[1] as number)),
    echo: (args) => Effect.succeed(args),
    nothing: () => Effect.void,
    boom: () => Effect.fail(new FunctionError({ message: "it broke" })),
    bug: () => Effect.die(new Error("a bug in EverChat")),
    slow: (args) =>
      Effect.suspend(() => {
        const start = performance.now()
        return Effect.sleep((args[0] as number | undefined) ?? 60_000).pipe(
          Effect.tap(() => Effect.sync(() => void times.push({ name: "slow", start, end: performance.now() }))),
          Effect.as("slept"),
          Effect.onInterrupt(() => Effect.sync(() => void (state.stopped += 1)))
        )
      })
  }
  const layer = Layer.succeed(
    Functions,
    Functions.of({
      declarations: Object.keys(table).map((name) => ({ name, signature: "()", description: name })),
      names: Object.keys(table),
      call: (name, args, caller) => {
        seen.push({ name, args, caller })
        return table[name]!(args, caller)
      }
    })
  )
  return { seen, state, times, layer }
}

// One launch with the sandbox. `run` runs a program in a new call of one turn.
const withSandbox = <A, E>(
  file: string,
  fake: ReturnType<typeof fakes>,
  effect: (run: (program: string) => Effect.Effect<{ output: string; failed: boolean }>) => Effect.Effect<A, E, Sandbox | Store>,
  over: { memory?: number; compute?: number; budget?: number } = {}
) => {
  const store = storeLayer(file, options())
  const sandbox = threadLayer(over).pipe(Layer.provide(fake.layer), Layer.provideMerge(store))
  let n = 0
  const body = Effect.gen(function*() {
    const db = yield* Store
    const box = yield* Sandbox
    const turn = yield* db.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const run = (program: string) =>
      Effect.gen(function*() {
        const call = yield* db.startCall({ turn: turn.id, vendorId: "call_" + ++n, fn: "run", input: program })
        return yield* box.run(program, { turn: turn.id, call })
      }).pipe(Effect.orDie)
    return yield* effect(run)
  })
  return Effect.runPromise(body.pipe(Effect.provide(sandbox)))
}

const functionRows = (file: string) =>
  rows<{ parent: number; fn: string; input: string; output: string | null; status: string }>(
    file,
    "select parent, fn, input, output, status from everchat_call where parent is not null order by n"
  )

// A program's result
// ------------------

test("the result is what the program printed, then what it returned", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      expect(yield* run("return 'a string, as it is'")).toEqual({ output: "a string, as it is", failed: false })
      expect(yield* run("return { a: 1, b: [true, null] }")).toEqual({ output: "{\n  \"a\": 1,\n  \"b\": [\n    true,\n    null\n  ]\n}", failed: false })
      expect(yield* run("console.log('one'); console.log({ two: 2 }); return 3")).toEqual({ output: "one\n{\"two\":2}\n3", failed: false })
      expect(yield* run("const unused = 1")).toEqual({ output: "(The program gave no result.)", failed: false })
      expect(yield* run("return await Promise.resolve(7)")).toEqual({ output: "7", failed: false })
    }))
})

test("a program that throws, or that is not JavaScript, fails with its error and what it printed before", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      const thrown = yield* run("console.log('before')\nthrow new TypeError('bad thing')")
      expect(thrown.failed).toBe(true)
      expect(thrown.output).toStartWith("before\nTypeError: bad thing\n    at ")
      expect(thrown.output).toContain("codemode.js:2")
      const syntax = yield* run("const = 3")
      expect(syntax.failed).toBe(true)
      expect(syntax.output).toStartWith("SyntaxError: ")
    }))
})

// Its globals, the way out that is not a function, are the suite's case of
// an escape.
test("a program that waits for nothing that can come fails at once, and a program starts with nothing from the one before it", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      const dead = yield* run("await new Promise(() => {})")
      expect(dead.failed).toBe(true)
      // A program starts with nothing from the one before it.
      yield* run("globalThis.kept = 1")
      expect((yield* run("return typeof kept")).output).toBe("undefined")
    }))
})

// Functions
// ---------

test("a function gets the program's arguments, and each call is a row under the program's call", async () => {
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      expect((yield* run("return await add(2, 3)")).output).toBe("5")
      expect((yield* run("return await echo('a', { b: [1] }, undefined)")).output).toBe("[\n  \"a\",\n  {\n    \"b\": [\n      1\n    ]\n  },\n  null\n]")
      expect((yield* run("return String(await nothing())")).output).toBe("undefined")
    }))
  expect(fake.seen.map((one) => [one.name, one.args])).toEqual([["add", [2, 3]], ["echo", ["a", { b: [1] }, null]], ["nothing", []]])
  // The caller: the turn, the program's call, and the function's own call.
  expect(fake.seen.map((one) => one.caller)).toEqual([{ turn: 1, program: 1, call: 2 }, { turn: 1, program: 3, call: 4 }, { turn: 1, program: 5, call: 6 }])
  expect(functionRows(file)).toEqual([
    { parent: 1, fn: "add", input: "[2,3]", output: "5", status: "done" },
    { parent: 3, fn: "echo", input: "[\"a\",{\"b\":[1]},null]", output: "[\"a\",{\"b\":[1]},null]", status: "done" },
    { parent: 5, fn: "nothing", input: "[]", output: "", status: "done" }
  ])
  expect(rows(file, "select count(*) as n from everchat_call where parent is not null and (ended is null or size is null)")).toEqual([{ n: 0 }])
})

test("functions run at the same time", async () => {
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      const out = yield* run("return (await Promise.all([slow(150), slow(150), slow(150), add(1, 1)])).join(' ')")
      expect(out.output).toBe("slept slept slept 2")
    }))
  // Each of the three slow functions started before any of them ended: the
  // times are the fakes' own, so the boot of the worker is not in them.
  const slow = fake.times.filter((one) => one.name === "slow")
  expect(slow).toHaveLength(3)
  expect(Math.max(...slow.map((one) => one.start))).toBeLessThan(Math.min(...slow.map((one) => one.end)))
  expect(functionRows(file).map((row) => row.status)).toEqual(["done", "done", "done", "done"])
})

test("a function that fails is an error that the program can catch, and its row says failed", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      expect(yield* run("try { await boom() } catch (error) { return 'caught: ' + error.message }")).toEqual({ output: "caught: it broke", failed: false })
      const loose = yield* run("await boom()")
      expect(loose.failed).toBe(true)
      expect(loose.output).toStartWith("Error: it broke")
      // A bug in a function is an error of that function, not the end of EverChat.
      const bug = yield* run("try { await bug() } catch (error) { return error.message }")
      expect(bug.output).toBe("EverChat failed in this function: Error: a bug in EverChat")
    }))
  expect(functionRows(file).map((row) => [row.fn, row.status, row.output])).toEqual([
    ["boom", "failed", "it broke"],
    ["boom", "failed", "it broke"],
    ["bug", "failed", "EverChat failed in this function: Error: a bug in EverChat"]
  ])
})

test("a function that the program did not wait for is stopped, and the result says so", async () => {
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      const out = yield* run("slow(); slow(); return 'done early'")
      expect(out.failed).toBe(false)
      expect(out.output).toBe(
        "done early\n(The program ended while 2 functions still ran: slow, slow. Each was stopped, and may or may not have finished. Wait for every function with `await`.)"
      )
      // By the time the result is there, each function is stopped and its row is closed.
      expect(fake.state.stopped).toBe(2)
      expect(functionRows(file).map((row) => [row.status, row.output])).toEqual([["cut", STOPPED], ["cut", STOPPED]])
    }))
})

// Limits and stops
// ----------------

// The bound of a test whose programs must run: far past the boot of a
// worker on a loaded host (most of a second), and short enough that the
// file runs in well under 30 s. Its stops say "2 s".
const BOUND = 2000

test("the compute limit stops a program that loops, and not one that waits for a function", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      const started = performance.now()
      const loop = yield* run("for (;;) {}")
      expect(loop).toEqual({
        output: "The program was stopped: it computed for 2 s with no function at work. A program has no timers: to wait, call shell(\"sleep 5\").",
        failed: true
      })
      expect(performance.now() - started).toBeLessThan(BOUND + 1000)
      // A function may take longer than the limit, and so may two in a row.
      expect((yield* run(`await slow(${BOUND + 200}); return await slow(${BOUND + 200})`)).output).toBe("slept")
      // The clock starts again after each function.
      const late = yield* run("await slow(10); for (;;) {}")
      expect(late.failed).toBe(true)
      expect(late.output).toStartWith("The program was stopped: it computed")
    }), { compute: BOUND })
}, 60_000)

// A program that computes for about `ms` milliseconds, `times` times, and
// calls a function after each. The sandbox has no timers, so it waits on
// the clock: `Date.now()` is the host's in there.
const busy = (ms: number, times: number) =>
  `for (let i = 0; i < ${times}; i++) { const end = Date.now() + ${ms}; while (Date.now() < end) {} await nothing() }\nreturn "done"`

// The stop of a budget of `seconds` (as the engine writes them).
const budgetStop = (seconds: string) =>
  `The program was stopped: it used up its compute budget, ${seconds} of compute in all with no function at work. Do less in one program.`

test("with no budget, the compute limit starts again after each function", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      // 5 times a quarter of the bound: more than the limit in all, less in
      // each stretch, also in the first, which has the boot in it.
      expect(yield* run(busy(BOUND / 4, 5))).toEqual({ output: "done", failed: false })
    }), { compute: BOUND })
}, 60_000)

test("the compute budget stops a program that computes too long in all, and not one that waits", async () => {
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      // 8 stretches of 0.3 of the budget, a function after each: twice the
      // budget in all. With the boot at most 0.7 of it, at least one
      // function is called; and the budget runs out in the fourth stretch at
      // the latest, so no more than 3 are.
      expect(yield* run(busy(0.3 * BOUND, 8))).toEqual({ output: budgetStop("2 s"), failed: true })
      expect(fake.seen.every((one) => one.name === "nothing")).toBe(true)
      expect(fake.seen.length).toBeGreaterThanOrEqual(1)
      expect(fake.seen.length).toBeLessThanOrEqual(3)
      // A wait for a function is not compute time: after a wait longer than
      // the budget, the program still computes, and is not stopped.
      const waits = `const got = await slow(${BOUND + 200}); const end = Date.now() + 200; while (Date.now() < end) {}\nreturn got`
      expect(yield* run(waits)).toEqual({ output: "slept", failed: false })
    }), { compute: BOUND, budget: BOUND })
}, 60_000)

test("a budget alone stops a loop after an await, and the limit still speaks when it is the nearer one", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      const started = performance.now()
      expect(yield* run("await nothing(); for (;;) {}")).toEqual({ output: budgetStop("0.3 s"), failed: true })
      expect(performance.now() - started).toBeLessThan(3000)
    }), { budget: 250 })
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      const loop = yield* run("for (;;) {}")
      expect(loop.failed).toBe(true)
      expect(loop.output).toStartWith("The program was stopped: it computed for 0 s with no function at work.")
    }), { compute: 250, budget: 5000 })
})

// The known limit of the budget (ec-x0cm): the clock is on the host, and it
// does not run while a function is at work, so a program that computes
// then is not stopped. A change of the engine that bounds it fails here.
test("the known limit (ec-x0cm): the budget does not count what a program computes while a function is at work", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      // It computes for longer than its budget while the function is at work.
      const out = yield* run(`slow(${2 * BOUND}); const end = Date.now() + ${BOUND + 500}; while (Date.now() < end) {}\nreturn 'done'`)
      expect(out.failed).toBe(false)
      expect(out.output).toStartWith("done")
    }), { budget: BOUND })
}, 60_000)

test("a program that takes too much memory fails, and EverChat goes on", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      const out = yield* run("const all = []; for (;;) all.push('x'.repeat(1000000) + all.length)")
      expect(out.failed).toBe(true)
      expect(out.output).toContain("out of memory")
      expect((yield* run("return 1")).output).toBe("1")
    }), { memory: 32 * 1024 * 1024 })
})

test("a stop ends the program, stops its functions, and closes their rows as cut", async () => {
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(run("await add(1, 2); await slow(); return 'never'"))
      for (let k = 0; k < 400 && fake.seen.length < 2; k++) {
        yield* Effect.sleep("5 millis")
      }
      yield* Fiber.interrupt(fiber)
      expect(fake.state.stopped).toBe(1)
      expect(functionRows(file).map((row) => [row.fn, row.status, row.output])).toEqual([["add", "done", "3"], ["slow", "cut", STOPPED]])
      // A stop of a program that only computes.
      const spin = yield* Effect.forkChild(run("for (;;) {}"))
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(spin)
    }))
})
