// Tests of the functions that a program can call, through the service: the
// arguments at the boundary, and what each function gives.

import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { compactor, newFile, options, PICK, rows } from "../tests/help.ts"
import { type Caller, type Declaration, type Entry, Functions, HOSTED, hostedLayer } from "@everchat/core/functions"
import { Limit } from "@everchat/core/limit"
import { limitLayer } from "./limitfile.ts"
import { DECLARATIONS, functionsLayer } from "./localfunctions.ts"
import { Memory } from "@everchat/core/memory"
import { Shell } from "./shell.ts"
import { storeLayer } from "@everchat/sqlite/bun"
import { Store } from "@everchat/core/store"

// One launch with the real functions. The work directory is the home.
// `more`: the entries after the built-ins' (functions from outside).
const functionsOf = (file: string, declarations: ReadonlyArray<Declaration> = DECLARATIONS, more?: ReadonlyArray<Entry>) => {
  const cwd = path.dirname(file)
  const store = storeLayer(file, options({ runTag: "tag-" + crypto.randomUUID() }))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const limit = limitLayer({ dir: path.join(cwd, "results"), limit: 1000 }).pipe(Layer.provide(store))
  const shell = Shell.layer({ cwd, shell: "/bin/sh" }).pipe(Layer.provide(store))
  return functionsLayer(declarations, { cwd, more }).pipe(Layer.provideMerge(Layer.mergeAll(memory, shell, limit)))
}
const withFunctions = <A, E>(file: string, effect: Effect.Effect<A, E, Functions | Store | Memory | Limit>) =>
  Effect.runPromise(effect.pipe(Effect.provide(functionsOf(file))))

const CALLER: Caller = { turn: 1, program: 1, call: 1 }

const call = (name: string, ...args: ReadonlyArray<unknown>) => Functions.use((functions) => functions.call(name, args, CALLER))

const fails = (name: string, ...args: ReadonlyArray<unknown>) =>
  Effect.map(Effect.result(call(name, ...args)), (got) => (got._tag === "Failure" ? got.failure.message : "it did not fail"))

test("each declared function can be called, and no other", async () => {
  const file = newFile()
  await withFunctions(file, Effect.gen(function*() {
    const functions = yield* Functions
    expect(functions.names).toEqual(DECLARATIONS.map((one) => one.name))
    expect(functions.names).toEqual(["shell", "read", "write", "edit", "zoom", "date", "result"])
    expect(yield* fails("spawn", "a task")).toBe("No function spawn.")
    expect(yield* fails("toString")).toBe("No function toString.")
  }))
})

test("functionsLayer takes the list of the stack's head: DECLARATIONS builds; the list in another order, or HOSTED, dies at the build with the names", async () => {
  const names = async (declarations: ReadonlyArray<Declaration>) => {
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function*() { return (yield* Functions).names }), functionsOf(newFile(), declarations)))
    return Exit.isSuccess(exit) ? exit.value : Cause.hasDies(exit.cause) ? String((Cause.squash(exit.cause) as Error).message) : "it failed"
  }
  expect(await names(DECLARATIONS)).toEqual(["shell", "read", "write", "edit", "zoom", "date", "result"])
  expect(await names([...DECLARATIONS].reverse())).toBe(
    'The functions are not the list of the head: The list has "result", "date", "zoom", "edit", "write", "read", "shell" in this order, and the entries "shell", "read", "write", "edit", "zoom", "date", "result".'
  )
  expect(await names(HOSTED)).toBe('The functions are not the list of the head: An entry has "shell", "read", "write", "edit", and the list does not.')
})

// Two functions from outside, as the client of MCP servers gives them: one
// object as the argument, with its schema.
const outside = (name: string, run: (input: { readonly a: number; readonly b: number }) => unknown): Entry => ({
  declaration: {
    name,
    description: "Adds two numbers.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }
  },
  run: (args) => Effect.sync(() => run(args[0] as { readonly a: number; readonly b: number }))
})
const ADD = outside("example.add", ({ a, b }) => ({ sum: a + b }))
const TIMES = outside("example.times", ({ a, b }) => ({ product: a * b }))

// What the layer's build gives: the names, or the message of its death.
const built = async (declarations: ReadonlyArray<Declaration>, more?: ReadonlyArray<Entry>) => {
  const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function*() { return (yield* Functions).names }), functionsOf(newFile(), declarations, more)))
  return Exit.isSuccess(exit) ? exit.value : Cause.hasDies(exit.cause) ? String((Cause.squash(exit.cause) as Error).message) : "it failed"
}

test("more: the entries after the built-ins', in the list's order, are the functions after them, and a program's call reaches each", async () => {
  const list = [...DECLARATIONS, ADD.declaration, TIMES.declaration]
  expect(await built(list, [ADD, TIMES])).toEqual(["shell", "read", "write", "edit", "zoom", "date", "result", "example.add", "example.times"])
  const got = await Effect.runPromise(Effect.provide(
    Effect.gen(function*() {
      const functions = yield* Functions
      return [yield* functions.call("example.add", [{ a: 2, b: 3 }], CALLER), yield* functions.call("example.times", [{ a: 2, b: 3 }], CALLER)]
    }),
    functionsOf(newFile(), list, [ADD, TIMES])
  ))
  expect(got).toEqual([{ sum: 5 }, { product: 6 }])
  // The list with them before the built-ins, or in another order, is not the entries'.
  expect(await built([ADD.declaration, TIMES.declaration, ...DECLARATIONS], [ADD, TIMES])).toStartWith(
    'The functions are not the list of the head: The list has "example.add", "example.times", "shell",'
  )
  expect(await built([...DECLARATIONS, TIMES.declaration, ADD.declaration], [ADD, TIMES])).toStartWith("The functions are not the list of the head: ")
})

test("make dies at the build for a list that has a function with no entry, and for an entry that the list does not have", async () => {
  expect(await built([...DECLARATIONS, ADD.declaration])).toBe('The functions are not the list of the head: The list has "example.add", and no entry.')
  expect(await built([...DECLARATIONS, ADD.declaration], [])).toBe('The functions are not the list of the head: The list has "example.add", and no entry.')
  expect(await built(DECLARATIONS, [ADD])).toBe('The functions are not the list of the head: An entry has "example.add", and the list does not.')
})

test("a wrong argument is an error that names the argument and shows the signature", async () => {
  const file = newFile()
  await withFunctions(file, Effect.gen(function*() {
    expect(yield* fails("shell", 3)).toBe("Wrong arguments: Expected string at [0]. Use shell(command: string, seconds?: number): Promise<string>.")
    expect(yield* fails("shell")).toBe("Wrong arguments: Missing key at [0]. Use shell(command: string, seconds?: number): Promise<string>.")
    expect(yield* fails("write", "a.txt")).toContain("Missing key at [1]")
    expect(yield* fails("write", "a.txt", "text", "more")).toContain("at [2]")
    expect(yield* fails("edit", { path: "a", old: "b", new: "c" })).toContain("Expected array at [0]")
    expect(yield* fails("date", 1.5)).toContain("Expected an integer at [0]")
    // What a program left out, or gave as undefined, arrives as nothing or as null.
    expect(yield* call("shell", "echo hi", null)).toStartWith("hi\n(exit 0")
  }))
})

test("the file functions work in the work directory", async () => {
  const file = newFile()
  const cwd = path.dirname(file)
  await withFunctions(file, Effect.gen(function*() {
    expect(yield* call("write", "notes/a.txt", "one\ntwo\n")).toBe("--- notes/a.txt\n+++ notes/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two")
    expect(fs.readFileSync(path.join(cwd, "notes/a.txt"), "utf8")).toBe("one\ntwo\n")
    expect(yield* call("read", "notes/a.txt")).toBe("one\ntwo\n")
    expect(yield* call("read", "notes/a.txt", 2, 1)).toBe("two")
    expect(yield* call("read", "notes/a.txt", null, 1)).toBe("one")
    expect(yield* call("edit", [{ path: "notes/a.txt", old: "two", new: "2" }])).toContain("-two\n+2")
    expect(yield* fails("edit", [{ path: "notes/a.txt", old: "nine", new: "9" }])).toBe("Edit 1 (notes/a.txt): old was not found. No file was changed.")
    expect(yield* fails("read", "missing.txt")).toContain("no such file")
    expect(yield* call("shell", "cat notes/a.txt")).toStartWith("one\n2\n(exit 0")
  }))
})

test("a shell command's process group is in its call's row while it runs", async () => {
  const file = newFile()
  await withFunctions(file, Effect.gen(function*() {
    const store = yield* Store
    const functions = yield* Functions
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const program = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    const id = yield* store.startCall({ turn: turn.id, parent: program, fn: "shell", input: "[]" })
    const fiber = yield* Effect.forkChild(functions.call("shell", ["sleep 60"], { turn: turn.id, program, call: id }))
    const pgid = () => rows<{ pgid: number | null }>(file, `select pgid from everchat_call where n = ${id}`)[0]!.pgid
    for (let k = 0; k < 400 && pgid() === null; k++) {
      yield* Effect.sleep("5 millis")
    }
    const group = pgid()!
    expect(group).toBeGreaterThan(1)
    // The group is that of a live process.
    expect(() => process.kill(-group, 0)).not.toThrow()
    yield* Fiber.interrupt(fiber)
    yield* store.endCall(id, { status: "cut", output: "stopped" })
    expect(pgid()).toBe(null)
  }))
})

test("zoom gives a message whole and a line's two halves, and date gives a message's time", async () => {
  const file = newFile()
  await withFunctions(file, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: "hello" }, { kind: "asst", text: "hi there" }])
    yield* memory.idle
    expect(yield* call("zoom", 0)).toBe("0+0|user: hello")
    expect(yield* call("zoom", 1, 1)).toBe("1+0|asst: hi there")
    expect(yield* call("zoom", "1")).toBe("1+0|asst: hi there")
    expect(yield* call("zoom", 0, 2)).toBe("0+1|user: hello\n1+1|asst: hi there")
    expect(yield* call("zoom", 0, 3)).toStartWith("No line 0+3: n is a power of 2")
    expect(yield* fails("zoom", "CalmOtter")).toBe("No agent CalmOtter.")
    expect(yield* call("date", 1)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    expect(yield* fails("date", 2)).toBe("No message 2.")
    expect(yield* fails("date", -1)).toBe("No message -1.")
  }))
})

test("result gives a call's whole result, and writes its file again when the file is gone", async () => {
  const file = newFile()
  await withFunctions(file, Effect.gen(function*() {
    const store = yield* Store
    const limit = yield* Limit
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const done = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    const open = yield* store.startCall({ turn: turn.id, vendorId: "call_2", fn: "run", input: "" })
    const whole = "a long result\n".repeat(500)
    yield* store.endCall(done, { status: "done", output: whole, shown: 1000 })
    expect(fs.existsSync(limit.file(done))).toBe(false)
    expect(yield* call("result", done)).toBe(whole)
    expect(fs.readFileSync(limit.file(done), "utf8")).toBe(whole)
    expect(yield* fails("result", open)).toBe("Call " + open + " still runs: it has no result yet.")
    expect(yield* fails("result", 99)).toBe("No call 99.")
  }))
})

test("result with a range gives the part, and writes the whole text, never the part, to the file that was gone", async () => {
  const file = newFile()
  await withFunctions(file, Effect.gen(function*() {
    const store = yield* Store
    const limit = yield* Limit
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const done = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    const whole = Array.from({ length: 500 }, (_, k) => "line " + k).join("\n")
    yield* store.endCall(done, { status: "done", output: whole, shown: 1000 })
    expect(fs.existsSync(limit.file(done))).toBe(false)
    expect(yield* call("result", done, 100, 200)).toBe(whole.slice(100, 200))
    expect(fs.readFileSync(limit.file(done), "utf8")).toBe(whole)
    // A file that is there is left as it is.
    fs.writeFileSync(limit.file(done), "kept")
    expect(yield* call("result", done, 0, 10)).toBe(whole.slice(0, 10))
    expect(fs.readFileSync(limit.file(done), "utf8")).toBe("kept")
    fs.rmSync(limit.file(done))
    expect(yield* call("result", done, 1000)).toBe(whole.slice(1000))
    expect(fs.readFileSync(limit.file(done), "utf8")).toBe(whole)
    // A refusal writes no file.
    fs.rmSync(limit.file(done))
    expect(yield* fails("result", done, 5, 3)).toBe("Wrong arguments: from (5) is over to (3). Use result(id: number, from?: number, to?: number): Promise<string>.")
    expect(fs.existsSync(limit.file(done))).toBe(false)
  }))
})

test("a host's result, the core's, gives the output and makes no file in any directory", async () => {
  const file = newFile()
  const home = path.dirname(file)
  const store = storeLayer(file, options())
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const uuid = await Effect.runPromise(Effect.gen(function*() {
    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const done = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    const open = yield* store.startCall({ turn: turn.id, vendorId: "call_2", fn: "run", input: "" })
    const whole = "a long result\n".repeat(5000)
    yield* store.endCall(done, { status: "done", output: whole, shown: 1000 })
    expect(yield* call("result", done)).toBe(whole)
    expect(yield* call("result", done, 14, 28)).toBe("a long result\n")
    expect(yield* fails("result", open)).toBe("Call " + open + " still runs: it has no result yet.")
    expect(yield* fails("result", 99)).toBe("No call 99.")
    return (yield* store.chat).uuid
  }).pipe(Effect.provide(hostedLayer(HOSTED).pipe(Layer.provideMerge(memory)))))
  // The home holds the database's files only, and the chat has no
  // directory of results (limitfile.ts).
  expect(fs.readdirSync(home).filter((name) => !name.startsWith(path.basename(file)))).toEqual([])
  expect(fs.existsSync(path.join(os.tmpdir(), "everchat-" + process.getuid!(), uuid))).toBe(false)
})
