// Tests of the inline engine (inline.ts), with real programs and fake
// functions: the four run cases of every engine (tests/cases.ts), then this
// engine's own: a program's result, its functions and their call rows, a
// stop, and its limits. The cases of the thread engine's file
// (sandbox.test.ts) that are true of any engine are the model.

import { expect, test } from "bun:test"
import { loadQuickJSWasm } from "./pi/index.ts"
import { Effect, Exit, Fiber, Layer } from "effect"
import { newFile, options, PICK, rows } from "@everchat/sqlite/testing"
import { type Caller, type Declaration, ENGINE_GLOBALS, type Entry, FunctionError, Functions, INHERITED, make, pending, RESERVED, RESERVED_WORDS, Shortened } from "@everchat/core/functions"
import { given } from "@everchat/core/limit"
import { Sandbox, STOPPED } from "@everchat/core/sandbox"
import { storeLayer } from "@everchat/sqlite/bun"
import { Store, StoreError } from "@everchat/core/store"
import { cases, STOP } from "../tests/cases.ts"
import { inlineLayer } from "./inline.ts"

// The QuickJS file, compiled once, from `node_modules` (a run from source).
const wasm = loadQuickJSWasm()

// The suite's bound of compute is in milliseconds of the thread engine;
// this engine counts polls. 40 polls for each: the suite's 250 gives 10,000
// polls, which stopped a loop after about 0.3 s and the slow regular
// expression after about 2.6 s here.
const POLLS_PER_UNIT = 40
const POLLS = 250 * POLLS_PER_UNIT

cases("inline", (limits) => inlineLayer({ memory: limits.memory, polls: limits.compute * POLLS_PER_UNIT, wasm }))

type Fake = (args: ReadonlyArray<unknown>, caller: Caller) => Effect.Effect<unknown, FunctionError>

// Fake functions, and `more` of a test's own. `seen` holds what each call got.
const fakes = (more: Record<string, Fake> = {}) => {
  const seen: Array<{ name: string; args: ReadonlyArray<unknown>; caller: Caller }> = []
  const state = { stopped: 0 }
  const table: Record<string, Fake> = {
    add: (args) => Effect.succeed((args[0] as number) + (args[1] as number)),
    echo: (args) => Effect.succeed(args),
    nothing: () => Effect.void,
    boom: () => Effect.fail(new FunctionError({ message: "it broke" })),
    bug: () => Effect.die(new Error("a bug in EverChat")),
    slow: (args) =>
      Effect.sleep((args[0] as number | undefined) ?? 60_000).pipe(
        Effect.as("slept"),
        Effect.onInterrupt(() => Effect.sync(() => void (state.stopped += 1)))
      ),
    ...more
  }
  const layer = Layer.succeed(
    Functions,
    Functions.of({
      declarations: Object.keys(table).map((name) => ({ name, signature: "()", description: name })),
      names: Object.keys(table),
      approval: new Set(),
      call: (name, args, caller) => {
        seen.push({ name, args, caller })
        return table[name]!(args, caller)
      }
    })
  )
  return { seen, state, layer }
}

// One launch with the sandbox. `run` runs a program in a new call of one turn.
const withSandbox = <A, E>(
  file: string,
  fake: { readonly layer: ReturnType<typeof fakes>["layer"] },
  effect: (run: (program: string) => Effect.Effect<{ output: string; failed: boolean }>) => Effect.Effect<A, E, Sandbox | Store>,
  over: { memory?: number; polls?: number } = {},
  store: ReturnType<typeof storeLayer> = storeLayer(file, options())
) => {
  const sandbox = inlineLayer({ polls: POLLS, ...over, wasm }).pipe(Layer.provide(fake.layer), Layer.provideMerge(store))
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

// What the result says when the polls are used up.
const SPENT = `The program was stopped: it computed for too long in all (${POLLS} polls of the engine). Do less in one program.`

// A program's result
// ------------------

test("inline: the result is what the program printed, then what it returned", async () => {
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      expect(yield* run("return 'a string, as it is'")).toEqual({ output: "a string, as it is", failed: false })
      expect(yield* run("return { a: 1, b: [true, null] }")).toEqual({ output: "{\n  \"a\": 1,\n  \"b\": [\n    true,\n    null\n  ]\n}", failed: false })
      expect(yield* run("console.log('one'); console.log({ two: 2 }); return 3")).toEqual({ output: "one\n{\"two\":2}\n3", failed: false })
      expect(yield* run("const unused = 1")).toEqual({ output: "(The program gave no result.)", failed: false })
      expect(yield* run("return await Promise.resolve(7)")).toEqual({ output: "7", failed: false })
    }))
})

test("inline: a program that throws, or that is not JavaScript, fails with its error and what it printed before", async () => {
  await withSandbox(newFile(), fakes(), (run) =>
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

test("inline: a program waits for nothing that cannot come, and keeps nothing from the one before it", async () => {
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      const dead = yield* run("await new Promise(() => {})")
      expect(dead.failed).toBe(true)
      yield* run("globalThis.kept = 1")
      expect((yield* run("return typeof kept")).output).toBe("undefined")
    }))
})

// Functions
// ---------

test("inline: a function gets the program's arguments, and each call is a row under the program's call", async () => {
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

// Fake functions with a schema beside one with a signature (lead,
// ec-qakol): `ns.member` gives back the list that it got, `echo` is spread.
const schemaFakes = () => {
  const seen: Array<{ name: string; args: ReadonlyArray<unknown> }> = []
  const table: Record<string, Fake> = {
    "ns.member": (args) => Effect.succeed(args),
    echo: (args) => Effect.succeed(args)
  }
  const layer = Layer.succeed(
    Functions,
    Functions.of({
      declarations: [
        { name: "ns.member", description: "member", inputSchema: { type: "object", properties: { a: { type: "number" } } } },
        { name: "echo", description: "echo", signature: "(...args: unknown[]): Promise<unknown[]>" }
      ],
      names: Object.keys(table),
      approval: new Set(),
      call: (name, args) => {
        seen.push({ name, args })
        return table[name]!(args, { turn: 0, program: 0, call: 0 })
      }
    })
  )
  return { seen, layer }
}

// A result kept whole and given short (functions.ts, `Shortened`): the
// call's row keeps the whole text, and the program gets the text `given`.
const WHOLE = "head " + "w".repeat(300) + " tail"
const short: Fake = (_args, caller) => Effect.succeed(new Shortened(WHOLE, given(caller.call, WHOLE, 100)))

test("inline: a function that gives a Shortened has a done row whose output is whole, and the program gets the text given (a string, not an object); a plain value goes as before", async () => {
  const file = newFile()
  const fake = fakes({ short, plain: () => Effect.succeed({ a: [1] }) })
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      expect(yield* run("const t = await short(); return JSON.stringify([typeof t, t])")).toEqual({ output: JSON.stringify(["string", given(2, WHOLE, 100)]), failed: false })
      expect(yield* run("const t = await plain(); return JSON.stringify([typeof t, t])")).toEqual({ output: JSON.stringify(["object", { a: [1] }]), failed: false })
    }))
  expect(given(2, WHOLE, 100)).toContain("result(2, from, to) gives a part of the whole result to a program.")
  expect(given(2, WHOLE, 100).length).toBeLessThan(WHOLE.length)
  expect(functionRows(file)).toEqual([
    { parent: 1, fn: "short", input: "[]", output: WHOLE, status: "done" },
    { parent: 3, fn: "plain", input: "[]", output: "{\"a\":[1]}", status: "done" }
  ])
})

test("inline: a function with an input schema gets the program's one object as [object], and its row's input is [{\"a\":1}]; a second argument is dropped by the adopted prelude (pi/runtime/prelude-source.ts:204, `spread ? args : args[0]`), so the function and its row get [first]; a spread function still gets its list", async () => {
  const file = newFile()
  const fake = schemaFakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      expect((yield* run("return JSON.stringify(await ns.member({ a: 1 }))")).output).toBe("[{\"a\":1}]")
      expect((yield* run("return JSON.stringify(await ns.member({ a: 2 }, { a: 3 }))")).output).toBe("[{\"a\":2}]")
      expect((yield* run("return JSON.stringify(await ns.member(null))")).output).toBe("[null]")
      expect((yield* run("return JSON.stringify(await echo({ a: 1 }, 2))")).output).toBe("[{\"a\":1},2]")
      expect((yield* run("return JSON.stringify(await echo())")).output).toBe("[]")
    }))
  expect(fake.seen).toEqual([
    { name: "ns.member", args: [{ a: 1 }] },
    { name: "ns.member", args: [{ a: 2 }] },
    { name: "ns.member", args: [null] },
    { name: "echo", args: [{ a: 1 }, 2] },
    { name: "echo", args: [] }
  ])
  expect(functionRows(file)).toEqual([
    { parent: 1, fn: "ns.member", input: "[{\"a\":1}]", output: "[{\"a\":1}]", status: "done" },
    { parent: 3, fn: "ns.member", input: "[{\"a\":2}]", output: "[{\"a\":2}]", status: "done" },
    { parent: 5, fn: "ns.member", input: "[null]", output: "[null]", status: "done" },
    { parent: 7, fn: "echo", input: "[{\"a\":1},2]", output: "[{\"a\":1},2]", status: "done" },
    { parent: 9, fn: "echo", input: "[]", output: "[]", status: "done" }
  ])
  expect(functionRows(file).map((row) => JSON.parse(row.input))).toEqual(fake.seen.map((one) => one.args))
})

test("inline: a function with an input schema called with no argument (or undefined) is a FunctionError that names it in the program, and a failed row; the function is not run", async () => {
  const file = newFile()
  const fake = schemaFakes()
  const none = "ns.member takes one argument, an object: it was called with none, or with a value that JSON cannot carry (a function, a symbol)."
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      expect(yield* run("try { await ns.member() } catch (error) { return 'caught: ' + error.message }")).toEqual({ output: "caught: " + none, failed: false })
      expect(yield* run("try { await ns.member(undefined) } catch (error) { return 'caught: ' + error.message }")).toEqual({ output: "caught: " + none, failed: false })
      const loose = yield* run("await ns.member()")
      expect(loose.failed).toBe(true)
      expect(loose.output).toStartWith("Error: " + none)
    }))
  expect(fake.seen).toEqual([])
  expect(functionRows(file)).toEqual([1, 3, 5].map((parent) => ({ parent, fn: "ns.member", input: "[]", output: none, status: "failed" })))
})

test("inline: the core's list covers the engine: each own name of the global object at a program's boot is in ENGINE_GLOBALS, in RESERVED or a function of the chat (here the namespace ns), and each own name of each prototype of the global object is in INHERITED; and ns.JSON, ns.toString and ns.valueOf, members named as a global and as inherited names, pass make and are called", async () => {
  const file = newFile()
  const member = (name: string) => ({ declaration: { name, description: "A member.", inputSchema: { type: "object" } }, run: (args: ReadonlyArray<unknown>) => Effect.succeed([name, ...args]) })
  const layer = Layer.succeed(Functions, make(["ns.JSON", "ns.toString", "ns.valueOf"].map((name) => member(name).declaration), [member("ns.JSON"), member("ns.toString"), member("ns.valueOf")]))
  const got = await withSandbox(file, { layer }, (run) =>
    run(
      "const chain = []\n" +
        "for (let p = Object.getPrototypeOf(globalThis); p !== null; p = Object.getPrototypeOf(p)) chain.push({ object: p === Object.prototype, names: Object.getOwnPropertyNames(p), symbols: Object.getOwnPropertySymbols(p).length })\n" +
        "return JSON.stringify({ names: Object.getOwnPropertyNames(globalThis), chain, got: await ns.JSON({ a: 1 }), more: [await ns.toString({ b: 2 }), await ns.valueOf({ c: 3 })], text: String(globalThis) })"
    ))
  expect(got.failed).toBe(false)
  const { names, chain, got: value, more, text } = JSON.parse(got.output) as {
    names: Array<string>
    chain: Array<{ object: boolean; names: Array<string>; symbols: number }>
    got: unknown
    more: unknown
    text: string
  }
  expect(value).toEqual(["ns.JSON", { a: 1 }])
  expect(more).toEqual([["ns.toString", { b: 2 }], ["ns.valueOf", { c: 3 }]])
  expect(text).toBe("[object global]")
  // The global object's prototypes: one, Object.prototype, whose 12 own names are each in the core's list.
  expect(chain.map((one) => [one.object, one.names.length, one.symbols])).toEqual([[true, 12, 0]])
  expect(chain.flatMap((one) => one.names.filter((name) => !INHERITED.includes(name)))).toEqual([])
  expect(names).toContain("JSON")
  expect(names).toContain("ns")
  expect(names.length).toBeGreaterThan(60)
  expect(names.filter((name) => !ENGINE_GLOBALS.includes(name) && !RESERVED.includes(name) && name !== "ns")).toEqual([])
})

// A member named as a name of CALLED (functions.ts), with no `make`: the
// layer of a list that the core's check no longer builds.
const thenFakes = () => {
  const seen: Array<{ name: string; args: ReadonlyArray<unknown> }> = []
  const declarations: ReadonlyArray<Declaration> = [
    { name: "z.then", description: "A schema member then.", inputSchema: { type: "object" } },
    { name: "z.other", description: "Another member.", inputSchema: { type: "object" } },
    { name: "s.then", description: "A spread member then.", signature: "(...args: unknown[]): Promise<unknown>" }
  ]
  const layer = Layer.succeed(
    Functions,
    Functions.of({
      declarations,
      names: declarations.map((one) => one.name),
      approval: new Set(),
      call: (name, args) => {
        seen.push({ name, args })
        return Effect.succeed([name, ...args])
      }
    })
  )
  return { seen, layer, declarations }
}

test("inline: a member named then is called by an await of its namespace, a call that the program never wrote: a schema one's row is failed, a spread one runs with [null,null]; Promise.race calls it too; the core's list now refuses it at the build", async () => {
  const file = newFile()
  const fake = thenFakes()
  const never = "Error: The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here."
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      expect(yield* run("await z")).toEqual({ output: never, failed: true })
      expect(yield* run("await s")).toEqual({ output: never, failed: true })
      expect(yield* run("return await Promise.race([z, Promise.resolve('raced')])")).toEqual({ output: "raced", failed: false })
    }))
  expect(fake.seen).toEqual([{ name: "s.then", args: [null, null] }])
  const none = "z.then takes one argument, an object: it was called with none, or with a value that JSON cannot carry (a function, a symbol)."
  expect(functionRows(file)).toEqual([
    { parent: 1, fn: "z.then", input: "[]", output: none, status: "failed" },
    { parent: 3, fn: "s.then", input: "[null,null]", output: "[\"s.then\",null,null]", status: "done" },
    { parent: 5, fn: "z.then", input: "[]", output: none, status: "failed" }
  ])
  // The core's check refuses both at the build.
  const called = "\"then\" is a name that the sandbox's engine calls by itself."
  expect(() => make(fake.declarations, fake.declarations.map((declaration) => ({ declaration, run: () => Effect.succeed(null) })))).toThrow(
    "The list of functions is refused: \"z.then\": " + called + " \"s.then\": " + called
  )
})

test("inline: a program calls a member named as a reserved word (ns.delete, ns.class, ns.await), which make builds; and each word of RESERVED_WORDS is no name of a binding in the body of an async function in strict mode", async () => {
  const file = newFile()
  const member = (name: string) => ({ declaration: { name, description: "A member.", inputSchema: { type: "object" } }, run: (args: ReadonlyArray<unknown>) => Effect.succeed([name, ...args]) })
  const entries = ["ns.delete", "ns.class", "ns.await"].map(member)
  const layer = Layer.succeed(Functions, make(entries.map((one) => one.declaration), entries))
  await withSandbox(file, { layer }, (run) =>
    Effect.gen(function*() {
      expect((yield* run("return JSON.stringify([await ns.delete({ a: 1 }), await ns.class({ b: 2 }), await ns.await({ c: 3 })])")).output).toBe(
        JSON.stringify([["ns.delete", { a: 1 }], ["ns.class", { b: 2 }], ["ns.await", { c: 3 }]])
      )
      // Each word, as a name: a SyntaxError (none is left in the list that the program gives back).
      const bound = yield* run(
        "const AsyncFunction = (async () => {}).constructor\n" +
          "const left = []\n" +
          "for (const word of " + JSON.stringify(RESERVED_WORDS) + ") { try { new AsyncFunction('\"use strict\"; var ' + word + ' = 1'); left.push(word) } catch (error) { if (!(error instanceof SyntaxError)) left.push(word + ': ' + error) } }\n" +
          "try { new AsyncFunction('\"use strict\"; var async = 1'); left.push('async is a name') } catch (error) { left.push('async: ' + error) }\n" +
          "return JSON.stringify(left)"
      )
      expect(bound).toEqual({ output: JSON.stringify(["async is a name"]), failed: false })
    }))
  expect(RESERVED_WORDS.length).toBe(46)
})

test("inline: a function with an input schema called with a function or a symbol gets the sentence that says so: such a value comes as none (the prelude carries JSON); the function is not run", async () => {
  const file = newFile()
  const fake = schemaFakes()
  const none = "ns.member takes one argument, an object: it was called with none, or with a value that JSON cannot carry (a function, a symbol)."
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      expect(yield* run("try { await ns.member(() => 1) } catch (error) { return 'caught: ' + error.message }")).toEqual({ output: "caught: " + none, failed: false })
      expect(yield* run("try { await ns.member(Symbol('x')) } catch (error) { return 'caught: ' + error.message }")).toEqual({ output: "caught: " + none, failed: false })
    }))
  expect(fake.seen).toEqual([])
  expect(functionRows(file)).toEqual([1, 3].map((parent) => ({ parent, fn: "ns.member", input: "[]", output: none, status: "failed" })))
})

test("inline: functions run at the same time", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      const started = performance.now()
      const out = yield* run("return (await Promise.all([slow(150), slow(150), slow(150), add(1, 1)])).join(' ')")
      expect(out.output).toBe("slept slept slept 2")
      expect(performance.now() - started).toBeLessThan(400)
    }))
  expect(functionRows(file).map((row) => row.status)).toEqual(["done", "done", "done", "done"])
})

test("inline: a function that fails is an error that the program can catch, and its row says failed", async () => {
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

test("inline: a function that the program did not wait for is stopped, and the result says so", async () => {
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

test("inline: a stop ends a program that waits for a function, stops its functions, and closes their rows as cut", async () => {
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
    }))
})

test("inline: a program that takes too much memory fails, and EverChat goes on", async () => {
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      const out = yield* run("const all = []; for (;;) all.push('x'.repeat(1000000) + all.length)")
      expect(out.failed).toBe(true)
      expect(out.output).toContain("out of memory")
      expect((yield* run("return 1")).output).toBe("1")
    }), { memory: 32 * 1024 * 1024 })
})

test("inline: the polls stop a program that loops, with a message that names them, and the next program runs", async () => {
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      expect(yield* run("for (;;) {}")).toEqual({ output: SPENT, failed: true })
      expect(SPENT).toStartWith(STOP)
      expect(yield* run("return 1")).toEqual({ output: "1", failed: false })
    }))
})

test("inline: the polls count over the whole program, also while a function is at work", async () => {
  // The thread engine's count counts this case too (sandbox.test.ts, "the
  // count stops a program that computes while a function is at work"):
  // each engine polls while a program computes.
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      const out = yield* run("slow(2000); for (;;) {}")
      expect(out).toEqual({ output: SPENT, failed: true })
      expect(fake.state.stopped).toBe(1)
      expect(functionRows(file).map((row) => [row.fn, row.status])).toEqual([["slow", "cut"]])
    }))
})

test("inline: the limit of this engine: it blocks its host while a program computes, so neither a timer nor a stop of the host reaches a loop; the polls end it", async () => {
  type Result = { output: string; failed: boolean }
  let result: Result | undefined
  let program: Fiber.Fiber<Result> | undefined
  // Whether the program's result was there when the host's timer ran.
  let there: boolean | undefined
  let timed!: () => void
  const timer = new Promise<void>((resolve) => {
    timed = resolve
  })
  // The program's first step, before it computes: a timer of the host, due
  // at once, and a stop of the program, asked for after it. Both are armed
  // from inside the program, so nothing before the loop can let them run.
  const mark: Fake = () =>
    Effect.sync(() => {
      setTimeout(() => {
        there = result !== undefined
        timed()
      }, 0)
      setTimeout(() => void Effect.runFork(Fiber.interrupt(program!)), 0)
    })
  await withSandbox(newFile(), fakes({ mark }), (run) =>
    Effect.gen(function*() {
      program = yield* Effect.forkChild(run("await mark(); for (;;) {}").pipe(Effect.tap((got) => Effect.sync(() => void (result = got)))))
      const exit = yield* Fiber.await(program)
      yield* Effect.promise(() => timer)
      // The order: the host's timer ran only once the result was there.
      expect(there).toBe(true)
      // The stop did not end the loop: the polls did.
      expect(result).toEqual({ output: SPENT, failed: true })
      if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ output: SPENT, failed: true })
      expect(yield* run("return 1")).toEqual({ output: "1", failed: false })
    }))
})

// A call that needs approval (calls.ts, the gate in `invoke`)
// ------------------------------------------------------------

// Functions by the core's `make`, where `send` (a schema function) and
// `post` (spread) need a person's yes before each run and `echo` does not.
// `ran` holds the name of each entry's run.
const gated = () => {
  const ran: Array<string> = []
  const entry = (declaration: Declaration, approval: boolean): Entry => ({
    declaration,
    run: (args) => Effect.sync(() => (ran.push(declaration.name), args)),
    ...(approval ? { approval } : {})
  })
  const declarations: ReadonlyArray<Declaration> = [
    { name: "send", description: "send", inputSchema: { type: "object", properties: { to: { type: "string" } } } },
    { name: "post", description: "post", signature: "(...args: unknown[]): Promise<unknown>" },
    { name: "echo", description: "echo", signature: "(...args: unknown[]): Promise<unknown[]>" }
  ]
  const layer = Layer.succeed(Functions, make(declarations, [entry(declarations[0]!, true), entry(declarations[1]!, true), entry(declarations[2]!, false)]))
  return { ran, layer }
}

// One launch with the gated functions; with `broken`, the store's
// `pendCall` fails, and the rest of the store is the real one.
const withGated = <A, E>(
  file: string,
  fake: ReturnType<typeof gated>,
  effect: (run: (program: string) => Effect.Effect<{ output: string; failed: boolean }>) => Effect.Effect<A, E, Sandbox | Store>,
  broken = false
) => {
  const real = storeLayer(file, options())
  const store = broken
    ? Layer.effect(Store, Effect.gen(function*() {
      const one = yield* Store
      return Store.of({ ...one, pendCall: () => Effect.fail(new StoreError({ op: "pendCall", cause: "broken" })) })
    })).pipe(Layer.provide(real))
    : real
  return withSandbox(file, fake, effect, {}, store)
}

const approvalRows = (file: string) =>
  rows<{ n: number; turn: number; call: number; fn: string; input: string; status: string; answered: number | null; output: string | null }>(
    file,
    "select n, turn, call, fn, input, status, answered, output from everchat_approval order by n"
  )

test("inline: a gated call does not run: beside another call in Promise.all, the other runs, the program gets pending(n) at once and goes on; the call's row is pending with its end and that text; the approval's row has the call, the name and the exact input", async () => {
  const file = newFile()
  const fake = gated()
  await withGated(file, fake, (run) =>
    Effect.gen(function*() {
      expect(yield* run("const [a, b] = await Promise.all([send({ to: 'ann' }), echo(1, 'x')]); return JSON.stringify({ a, b })")).toEqual({
        output: JSON.stringify({ a: pending(1), b: [1, "x"] }),
        failed: false
      })
    }))
  expect(fake.ran).toEqual(["echo"])
  expect(functionRows(file)).toEqual([
    { parent: 1, fn: "send", input: "[{\"to\":\"ann\"}]", output: JSON.stringify(pending(1)), status: "pending" },
    { parent: 1, fn: "echo", input: "[1,\"x\"]", output: "[1,\"x\"]", status: "done" }
  ])
  expect(rows(file, "select n, status, ended is not null as ended from everchat_call order by n")).toEqual([
    { n: 1, status: "running", ended: 0 },
    { n: 2, status: "pending", ended: 1 },
    { n: 3, status: "done", ended: 1 }
  ])
  expect(approvalRows(file)).toEqual([{ n: 1, turn: 1, call: 2, fn: "send", input: "[{\"to\":\"ann\"}]", status: "pending", answered: null, output: null }])
})

test("inline: two gated calls of one program give two approvals, a schema function's input [object] and a spread one's list; a schema function's gated call with no argument fails as today and makes no approval", async () => {
  const file = newFile()
  const fake = gated()
  await withGated(file, fake, (run) =>
    Effect.gen(function*() {
      expect(yield* run("const a = await send({ to: 'bo' }); const b = await post(1, [2], { c: null }); return JSON.stringify([a, b])")).toEqual({
        output: JSON.stringify([pending(1), pending(2)]),
        failed: false
      })
      expect(yield* run("try { await send() } catch (e) { return 'caught: ' + e.message }")).toEqual({
        output: "caught: send takes one argument, an object: it was called with none, or with a value that JSON cannot carry (a function, a symbol).",
        failed: false
      })
    }))
  expect(fake.ran).toEqual([])
  expect(functionRows(file)).toEqual([
    { parent: 1, fn: "send", input: "[{\"to\":\"bo\"}]", output: JSON.stringify(pending(1)), status: "pending" },
    { parent: 1, fn: "post", input: "[1,[2],{\"c\":null}]", output: JSON.stringify(pending(2)), status: "pending" },
    { parent: 4, fn: "send", input: "[]", output: "send takes one argument, an object: it was called with none, or with a value that JSON cannot carry (a function, a symbol).", status: "failed" }
  ])
  expect(approvalRows(file).map((one) => [one.n, one.call, one.fn, one.input, one.status])).toEqual([
    [1, 2, "send", "[{\"to\":\"bo\"}]", "pending"],
    [2, 3, "post", "[1,[2],{\"c\":null}]", "pending"]
  ])
})

test("inline: a pendCall that fails gives the program the database's error, and the gated function does not run", async () => {
  const file = newFile()
  const fake = gated()
  await withGated(file, fake, (run) =>
    Effect.gen(function*() {
      expect(yield* run("try { await send({ to: 'cy' }) } catch (e) { return 'caught: ' + e.message }")).toEqual({
        output: "caught: EverChat's database failed (pendCall).",
        failed: false
      })
    }), true)
  expect(fake.ran).toEqual([])
  expect(approvalRows(file)).toEqual([])
})
