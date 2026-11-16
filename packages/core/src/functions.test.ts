// Tests of the core's functions, the whole list of a host's chat: `zoom`,
// `date` and `result`, over the store and the memory. The core imports no
// file system (tools/graph.ts); that a host's `result` makes no file is
// checked with one, in packages/local/src/functions.test.ts.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer } from "effect"
import { compactor, newFile, options, PICK } from "@everchat/local/testing"
import { type Caller, Functions, HOSTED, hostedLayer } from "./functions.ts"
import { Memory } from "./memory.ts"
import { storeLayer } from "@everchat/sqlite/bun"
import { Store } from "./store.ts"

// One launch of a host's chat: the store, the memory, and the hosted set.
const withHosted = <A, E>(file: string, effect: Effect.Effect<A, E, Functions | Store | Memory>) => {
  const store = storeLayer(file, options())
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  return Effect.runPromise(effect.pipe(Effect.provide(hostedLayer.pipe(Layer.provideMerge(memory)))))
}

const CALLER: Caller = { turn: 1, program: 1, call: 1 }

const call = (name: string, ...args: ReadonlyArray<unknown>) => Functions.use((functions) => functions.call(name, args, CALLER))

const fails = (name: string, ...args: ReadonlyArray<unknown>) =>
  Effect.map(Effect.result(call(name, ...args)), (got) => (got._tag === "Failure" ? got.failure.message : "it did not fail"))

test("the hosted set declares zoom, date and result, in this order, and runs each", async () => {
  const file = newFile()
  await withHosted(file, Effect.gen(function*() {
    const functions = yield* Functions
    assert.deepEqual(HOSTED.map((one) => one.name), ["zoom", "date", "result"])
    assert.deepEqual(functions.declarations, HOSTED)
    assert.deepEqual(functions.names, ["zoom", "date", "result"])
    assert.equal(yield* fails("shell", "echo hi"), "No function shell.")
    assert.equal(yield* fails("read", "a.txt"), "No function read.")

    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: "hello" }, { kind: "asst", text: "hi there" }])
    yield* memory.idle
    assert.equal(yield* call("zoom", 0), "0+0|user: hello")
    assert.match(String(yield* call("date", 1)), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)

    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const done = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    yield* store.endCall(done, { status: "done", output: "the output", shown: 10 })
    assert.equal(yield* call("result", done), "the output")
  }))
})

test("result gives a call's whole output from the store, and says when there is none", async () => {
  const file = newFile()
  await withHosted(file, Effect.gen(function*() {
    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const done = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    const open = yield* store.startCall({ turn: turn.id, vendorId: "call_2", fn: "run", input: "" })
    const whole = "a long result\n".repeat(5000)
    yield* store.endCall(done, { status: "done", output: whole, shown: 1000 })
    assert.equal(yield* call("result", done), whole)
    assert.equal(yield* fails("result", open), "Call " + open + " still runs: it has no result yet.")
    assert.equal(yield* fails("result", 99), "No call 99.")
    assert.equal(yield* fails("result", "1"), "Wrong arguments: Expected number at [0]. Use result(id: number): Promise<string>.")
  }))
})
