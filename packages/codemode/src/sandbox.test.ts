// Tests of the sandbox, with real programs in the real engine and with
// fake functions: a program's result, its functions and their call rows,
// its limits, and a stop. The run cases of every engine (tests/cases.ts,
// run by thread.test.ts) are not repeated here: what is here is this
// engine's own.
//
// The bounds, by the suite's rule: the engine's clock starts after the
// boot of its worker (thread.ts, `onStarted`), so the boot, which on a
// loaded host can take most of a second, is not counted (a case below
// holds the boot back past the limit). A loaded host slows the compute
// itself too, so a program that must run has a bound of BOUND, with its
// stretches of compute and its waits sized to it; only a program that a
// wall must stop runs under the small bound of 250 ms.

import { expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { newFile, options, PICK, rows } from "@everchat/sqlite/testing"
import { type Caller, type Declaration, ENGINE_GLOBALS, type Entry, FunctionError, Functions, INHERITED, make, pending, RESERVED, RESERVED_WORDS, Shortened } from "@everchat/core/functions"
import { given } from "@everchat/core/limit"
import { Sandbox, STOPPED } from "@everchat/core/sandbox"
import { storeLayer } from "@everchat/sqlite/bun"
import { Store, StoreError } from "@everchat/core/store"
import { CodemodeSandbox, loadQuickJSWasm } from "./pi/index.ts"
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

// Fake functions, and `more` of a test's own. `seen` holds what each call got.
const fakes = (more: Record<string, Fake> = {}) => {
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
      }),
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
  return { seen, state, times, layer }
}

// One launch with the sandbox. `run` runs a program in a new call of one turn.
const withSandbox = <A, E>(
  file: string,
  fake: { readonly layer: ReturnType<typeof fakes>["layer"] },
  effect: (run: (program: string) => Effect.Effect<{ output: string; failed: boolean }>) => Effect.Effect<A, E, Sandbox | Store>,
  over: { memory?: number; compute?: number; polls?: number; calls?: number; worker?: URL } = {},
  store: ReturnType<typeof storeLayer> = storeLayer(file, options())
) => {
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

// Fake functions with schemas beside ones with signatures (lead,
// ec-qakol): `ns.member` gives back the list that it got, `ns.slow` sleeps
// its object's `ms`, `echo` is spread. `seen` holds what each call got.
const schemaFakes = () => {
  const seen: Array<{ name: string; args: ReadonlyArray<unknown> }> = []
  const table: Record<string, Fake> = {
    "ns.member": (args) => Effect.succeed(args),
    "ns.slow": (args) => Effect.sleep((args[0] as { ms: number }).ms).pipe(Effect.as("slept")),
    echo: (args) => Effect.succeed(args)
  }
  const object = { type: "object", properties: { a: { type: "number" } } }
  const layer = Layer.succeed(
    Functions,
    Functions.of({
      declarations: [
        { name: "ns.member", description: "member", inputSchema: object },
        { name: "ns.slow", description: "slow", inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } },
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

// A result kept whole and given short (functions.ts, `Shortened`): the
// call's row keeps the whole text, and the program gets the text `given`.
const WHOLE = "head " + "w".repeat(300) + " tail"
const short: Fake = (_args, caller) => Effect.succeed(new Shortened(WHOLE, given(caller.call, WHOLE, 100)))

test("a function that gives a Shortened has a done row whose output is whole, and the program gets the text given (a string, not an object); a plain value goes as before", async () => {
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

test("a function with an input schema gets the program's one object as [object], and its row's input is [{\"a\":1}]; a second argument is dropped by the adopted prelude (pi/runtime/prelude-source.ts:204, `spread ? args : args[0]`), so the function and its row get [first]; a spread function still gets its list", async () => {
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
  // A later run of a recorded call takes its input as it is: the list.
  expect(functionRows(file).map((row) => JSON.parse(row.input))).toEqual(fake.seen.map((one) => one.args))
})

test("a function with an input schema called with no argument (or undefined) is a FunctionError that names it in the program, and a failed row; the function is not run", async () => {
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

test("the wrapper of a global holds for a function with an input schema: the count of calls counts its call, and its time at work is no compute", async () => {
  const file = newFile()
  const fake = schemaFakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      // The count: 2 calls; the third, of a schema function, is not made.
      expect(yield* run("await ns.member({ a: 1 }); await echo(1); await ns.member({ a: 2 }); return 'done'")).toEqual({
        output: "The program was stopped: it reached the limit of 2 calls of functions in one program. Call fewer functions in one program.",
        failed: true
      })
      expect(fake.seen.map((one) => one.name)).toEqual(["ns.member", "echo"])
      // A wait for a schema function longer than the compute limit is no compute.
      expect(yield* run("return await ns.slow({ ms: 600 })")).toEqual({ output: "slept", failed: false })
    }), { compute: 250, calls: 2 })
  expect(functionRows(file).map((row) => [row.fn, row.status])).toEqual([["ns.member", "done"], ["echo", "done"], ["ns.slow", "done"]])
})

test("the core's reserved names (functions.ts, RESERVED) are the sandbox's, RESERVED_GLOBALS of the adopted code (pi/runtime/execution.ts)", async () => {
  const source = await Bun.file(new URL("./pi/runtime/execution.ts", import.meta.url)).text()
  const list = /const RESERVED_GLOBALS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1]
  expect(list).toBeDefined()
  const sandbox = [...list!.matchAll(/"([^"]*)"/g)].map((one) => one[1]!)
  expect(sandbox.length).toBeGreaterThan(5)
  expect(list!.replace(/"[^"]*"|[\s,]/g, "")).toBe("")
  expect([...RESERVED]).toEqual(sandbox)
})

test("the core's list covers the engine: each own name of the global object at a program's boot is in ENGINE_GLOBALS, in RESERVED or a function of the chat (here the namespace ns), and each own name of each prototype of the global object is in INHERITED; and ns.JSON, ns.toString and ns.valueOf, members named as a global and as inherited names, pass make and are called", async () => {
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

test("a member named then is called by an await of its namespace, a call that the program never wrote: a schema one's row is failed, a spread one runs with [null,null]; Promise.race calls it too; the core's list now refuses it at the build", async () => {
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

test("a program calls a member named as a reserved word (ns.delete, ns.class, ns.await), which make builds; and each word of RESERVED_WORDS is no name of a binding in the body of an async function in strict mode", async () => {
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

test("a function with an input schema called with a function or a symbol gets the sentence that says so: such a value comes as none (the prelude carries JSON); the function is not run", async () => {
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

// The bound of a test whose programs must run: far past a stretch of their
// compute on a loaded host, and short enough that the file runs in well
// under 30 s. Its stops say "2 s".
const BOUND = 2000

test("the compute limit stops a program that loops, and not one that waits for a function", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      const started = performance.now()
      const loop = yield* run("for (;;) {}")
      // The fakes hold no `shell`: the text names no function.
      expect(loop).toEqual({
        output: "The program was stopped: it computed for 2 s with no function at work. A program has no timers. Do less in one program.",
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

// The compute budget is a count of the engine's polls (thread.ts). A poll
// is the engine's check for an interrupt, made as a program computes: a
// loop of 1,000,000 steps takes about 200 of them, the same number on each
// run, and the boot and the prelude about 3. So the count of these cases,
// 1,000, is far above what a small program takes, and a loop of 1,500,000
// steps (`steps`) takes about 0.3 of it.
const POLLS = 1000
const steps = (n: number) => `for (let i = 0; i < ${n}; i++) {}`

// The stop of the count (the inline engine's text, as the engine writes it).
const spent = (polls: number) =>
  `The program was stopped: it computed for too long in all (${polls} polls of the engine). Do less in one program.`

test("with no count, the compute limit starts again after each function", async () => {
  const file = newFile()
  await withSandbox(file, fakes(), (run) =>
    Effect.gen(function*() {
      // 5 times a quarter of the bound: more than the limit in all, less in
      // each stretch.
      expect(yield* run(busy(BOUND / 4, 5))).toEqual({ output: "done", failed: false })
    }), { compute: BOUND })
}, 60_000)

test("the count stops a program that computes too long in all, and not one that waits", async () => {
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      // 8 stretches of about 0.3 of the count, a function after each: more
      // than twice the count in all. The boot takes about 3 polls and no
      // clock, so three stretches end and call the function, and the count
      // runs out in the fourth: exactly 3 calls.
      expect(yield* run(`for (let k = 0; k < 8; k++) { ${steps(1_500_000)} await nothing() }\nreturn "done"`)).toEqual({ output: spent(POLLS), failed: true })
      expect(fake.seen.map((one) => one.name)).toEqual(["nothing", "nothing", "nothing"])
      // A wait for a function is no poll: after a wait longer than the
      // compute limit, the program still computes a little, and is not
      // stopped.
      const waits = `const got = await slow(${BOUND + 200}); ${steps(100_000)}\nreturn got`
      expect(yield* run(waits)).toEqual({ output: "slept", failed: false })
    }), { compute: BOUND, polls: POLLS })
}, 60_000)

test("a count alone stops a loop after an await, and the limit still speaks when it is the nearer one", async () => {
  const file = newFile()
  const fake = fakes()
  await withSandbox(file, fake, (run) =>
    Effect.gen(function*() {
      const started = performance.now()
      expect(yield* run("await nothing(); for (;;) {}")).toEqual({ output: spent(POLLS), failed: true })
      expect(performance.now() - started).toBeLessThan(3000)
      // The stop comes after the await: the function was called, once.
      expect(fake.seen.map((one) => one.name)).toEqual(["nothing"])
    }), { polls: POLLS })
  // 100,000 polls take about 4 s of this loop; the limit, 250 ms, comes
  // first.
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      const loop = yield* run("for (;;) {}")
      expect(loop.failed).toBe(true)
      expect(loop.output).toStartWith("The program was stopped: it computed for 0 s with no function at work.")
    }), { compute: 250, polls: 100_000 })
})

// The count is the worker's, and it goes on while a function is at work: a
// program that starts a function, does not wait for it, and computes, is
// stopped by it. The compute limit does not run then, so before the count
// (ec-x0cm) no limit of the engine stopped it.
test("the count stops a program that computes while a function is at work", async () => {
  // About 20 times the count (about 0.8 s on an idle host), while `slow` is
  // at work: `slow()` waits 60 s, and the end of the program stops it.
  const program = `slow(); ${steps(100_000_000)}\nreturn 'done'`
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      expect(yield* run(program)).toEqual({ output: spent(POLLS), failed: true })
    }), { compute: BOUND, polls: POLLS })
  // With no count, a program that computes for longer than the compute
  // limit while `slow` is at work runs to its end: the limit waits while
  // the function is at work. The stretch is timed by the clock, so that a
  // loaded host does not change its length.
  const longer = `slow(); const end = Date.now() + ${BOUND + 500}; while (Date.now() < end) {}\nreturn 'done'`
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      const out = yield* run(longer)
      expect(out.failed).toBe(false)
      expect(out.output).toStartWith("done")
    }), { compute: BOUND })
}, 60_000)

// A worker program for the cases below, in a directory of its own: it
// waits, then runs the adopted code's worker, or never runs it.
const ADOPTED = new URL("./pi/runtime/worker.ts", import.meta.url)
const workerFile = (body: string) => {
  const file = path.join(path.dirname(newFile()), "worker.ts")
  fs.writeFileSync(file, body)
  return new URL("file://" + file)
}

test("the compute limit's clock starts after the boot: a boot longer than the limit stops no program", async () => {
  // The boot is held back for 1 s, four times the limit, before the
  // adopted worker starts.
  const held = workerFile(`await new Promise((done) => setTimeout(done, 1000))\nawait import(${JSON.stringify(ADOPTED.href)})\n`)
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      const started = performance.now()
      expect(yield* run("return 1")).toEqual({ output: "1", failed: false })
      // The run had the held boot in it.
      expect(performance.now() - started).toBeGreaterThanOrEqual(1000)
      // After the boot the clock runs: a loop is stopped by it.
      const loop = yield* run("for (;;) {}")
      expect(loop.failed).toBe(true)
      expect(loop.output).toStartWith("The program was stopped: it computed for 0 s with no function at work.")
    }), { compute: 250, worker: held })
}, 60_000)

// The point that the clock starts at (`onStarted`, pi/runtime/vm.ts): once
// for each run, after the prelude has run. A memory limit of 64 KiB lets
// QuickJS start and its prelude run out of memory: such a VM never gives
// the point.
test("the point after the boot comes once, after the prelude: a VM whose prelude fails never gives it", async () => {
  const wasm = loadQuickJSWasm()
  const run = async (memoryLimitBytes: number) => {
    let started = 0
    const result = await new CodemodeSandbox({ timeoutMs: 30_000, wasm, memoryLimitBytes }).execute("return 1", { onStarted: () => void started++ })
    return { ok: result.ok, started }
  }
  expect(await run(64 * 1024)).toEqual({ ok: false, started: 0 })
  expect(await run(32 * 1024 * 1024)).toEqual({ ok: true, started: 1 })
}, 60_000)

test("the point after the boot comes before the program is compiled: a program with a syntax error gives it once, and fails", async () => {
  let started = 0
  const result = await new CodemodeSandbox({ timeoutMs: 30_000, wasm: loadQuickJSWasm() }).execute("return (", { onStarted: () => void started++ })
  expect(started).toBe(1)
  expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "SyntaxError" } })
}, 60_000)

// A worker program that never runs the adopted worker, so no `started`
// comes, and that beats: it appends one byte to a file every 50 ms while
// its thread lives. The file is in the worker's own directory, under the
// run's temporary root. `size` reads the file's size (0 before the first
// beat).
const beatingWorker = () => {
  const dir = path.dirname(newFile())
  const beat = path.join(dir, "beat.txt")
  const file = path.join(dir, "worker.ts")
  fs.writeFileSync(file, `import * as fs from "node:fs"\nsetInterval(() => fs.appendFileSync(${JSON.stringify(beat)}, "x"), 50)\n`)
  return { url: new URL("file://" + file), size: () => (fs.existsSync(beat) ? fs.statSync(beat).size : 0) }
}

// Waits for the worker's first beat; fails if none comes within BOUND.
const beats = (size: () => number) =>
  Effect.gen(function*() {
    const start = performance.now()
    while (size() === 0) {
      if (performance.now() - start > BOUND) return yield* Effect.die(new Error(`the worker did not beat within ${BOUND} ms`))
      yield* Effect.sleep("20 millis")
    }
  })

// Waits until the worker beats no more: two reads 500 ms apart (ten beats)
// that are equal. No single wait decides it, so a loaded host does not;
// fails if no such pair comes within BOUND.
const stops = (size: () => number) =>
  Effect.gen(function*() {
    const start = performance.now()
    let last = size()
    for (;;) {
      yield* Effect.sleep("500 millis")
      const now = size()
      if (now === last) return
      if (performance.now() - start > BOUND) {
        return yield* Effect.die(new Error(`the worker still beats ${BOUND} ms after the stop (${last} then ${now} bytes)`))
      }
      last = now
    }
  })

test("a worker that never starts is not stopped by the clock, and the stop ends its run", async () => {
  // It keeps its thread alive, and never runs the adopted worker: no
  // `started` comes.
  const never = beatingWorker()
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(run("return 1"))
      // Four times the limit: no clock ends it.
      yield* Effect.sleep("1 second")
      expect(fiber.pollUnsafe()).toBeUndefined()
      // The worker runs: the case cannot pass with one that never ran.
      yield* beats(never.size)
      expect(never.size()).toBeGreaterThan(0)
      const started = performance.now()
      yield* Fiber.interrupt(fiber)
      expect(performance.now() - started).toBeLessThan(1000)
      // The stop aborts the run, and the adopted code ends the worker.
      yield* stops(never.size)
    }), { compute: 250, worker: never.url })
}, 60_000)

test("the end of a run's scope ends a worker that never starts", async () => {
  const never = beatingWorker()
  await withSandbox(newFile(), fakes(), (run) =>
    Effect.gen(function*() {
      // A run forked in a scope, and not stopped by hand: the end of the
      // scope stops it.
      yield* Effect.scoped(Effect.gen(function*() {
        yield* Effect.forkScoped(run("return 1"))
        yield* beats(never.size)
      }))
      yield* stops(never.size)
    }), { compute: 250, worker: never.url })
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

test("a gated call does not run: beside another call in Promise.all, the other runs, the program gets pending(n) at once and goes on; the call's row is pending with its end and that text; the approval's row has the call, the name and the exact input", async () => {
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

test("two gated calls of one program give two approvals, a schema function's input [object] and a spread one's list; a schema function's gated call with no argument fails as today and makes no approval", async () => {
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

test("a pendCall that fails gives the program the database's error, and the gated function does not run", async () => {
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
