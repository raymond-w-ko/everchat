// Tests of the functions that a program can call, through the service: the
// arguments at the boundary, and what each function gives.

import { expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { compactor, newFile, options, PICK, rows } from "../tests/help.ts"
import { type Caller, DECLARATIONS, Functions } from "./functions.ts"
import { Limit } from "./limit.ts"
import { Memory } from "./memory.ts"
import { Shell } from "./shell.ts"
import { Store } from "./store.ts"

// One launch with the real functions. The work directory is the home.
const withFunctions = <A, E>(file: string, effect: Effect.Effect<A, E, Functions | Store | Memory | Limit>) => {
  const cwd = path.dirname(file)
  const store = Store.layer(file, options({ runTag: "tag-" + crypto.randomUUID() }))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const limit = Limit.layer({ dir: path.join(cwd, "results"), limit: 1000 }).pipe(Layer.provide(store))
  const shell = Shell.layer({ cwd, shell: "/bin/sh" }).pipe(Layer.provide(store))
  const functions = Functions.layer({ cwd }).pipe(Layer.provideMerge(Layer.mergeAll(memory, shell, limit)))
  return Effect.runPromise(effect.pipe(Effect.provide(functions)))
}

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
    const pgid = () => rows<{ pgid: number | null }>(file, `select pgid from call where id = ${id}`)[0]!.pgid
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
