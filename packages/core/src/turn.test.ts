// Tests of the turn loop, with a fake wire and a fake sandbox: what a turn
// sends, what it writes, how a message steers it, how it fails and stops,
// and how it goes on after a restart.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Deferred, Effect, Layer, PubSub } from "effect"
import * as path from "node:path"
import { compactor, fakeWire, newFile, options, reply, rows, wireError } from "@everchat/local/testing"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import { head } from "./head.ts"
import { Memory } from "./memory.ts"
import type { Item, Reply, Request } from "./request.ts"
import { storeLayer } from "@everchat/sqlite/bun"
import { Store } from "./store.ts"
import { limitLayer } from "@everchat/local/limitfile"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { Sandbox } from "./sandbox.ts"
import { CUT, cutText, HEAD, STOPPED, type TurnEvent, Turns } from "./turn.ts"
import { Stream } from "effect"

type Run = (program: string) => Effect.Effect<{ output: string; failed: boolean }>

// One launch: the store, the memory, the ask service over a fake wire, a
// fake sandbox, and the turn loop.
const withTurns = <A, E>(
  file: string,
  wire: ReturnType<typeof fakeWire>,
  run: Run,
  effect: Effect.Effect<A, E, Turns | Memory | Store>,
  summaries: Parameters<typeof compactor>[0] = () => "a summary"
) => {
  const store = storeLayer(file, options())
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(summaries)))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ declarations: DECLARATIONS }).pipe(Layer.provideMerge(memory), Layer.provide(Layer.mergeAll(asking, sandbox, limit)))
  return Effect.runPromise(effect.pipe(Effect.provide(turns), Effect.provideService(AskDelay, () => Effect.succeed(0))))
}

const noPrograms: Run = () => Effect.die("no program was expected")

// A reply in which the model runs one program.
const runs = (asked: Request, id: string, program: string, over: Partial<Reply> = {}): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "reasoning", id: "rs_" + id, encrypted_content: "SECRET" }, { type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }],
    ...over
  })

const says = (asked: Request, text: string): Reply =>
  reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

// Waits, in real time, until `check` is true.
const eventually = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 400 && !check(); k++) {
      yield* Effect.sleep("5 millis")
    }
    if (!check()) {
      return yield* Effect.die("the test waited 2 s for a state that did not come")
    }
  })

const lastText = (item: Item | undefined) => (item?.kind === "user" ? item.blocks[item.blocks.length - 1] : undefined)

const messages = (file: string) => rows<{ i: number; kind: string; text: string; turn: number | null; call: number | null }>(file, "select i, kind, text, turn, call from everchat_msg_read order by i")
const turns = (file: string) => rows(file, "select n as id, status, why, first_msg from everchat_turn order by n")
const items = (file: string, turn = 1) => rows<{ kind: string }>(file, `select kind from everchat_turn_item where turn = ${turn} order by n`).map((row) => row.kind)

// One turn
// --------

test("a message starts a turn: one request with the view and the message, and the reply is logged", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Hello to you."))
  const seen: Array<TurnEvent> = []
  const uuid = await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* Effect.forkChild(Stream.runForEach(turnsService.events, (event) => Effect.sync(() => seen.push(event))))
    yield* Effect.sleep("5 millis")
    const written = yield* turnsService.say("hello")
    assert.deepStrictEqual(written.map((message) => [message.i, message.kind, message.text]), [[0, "user", "hello"]])
    yield* turnsService.idle
    yield* Effect.sleep("5 millis")
    return (yield* (yield* Store).chat).uuid
  }))
  assert.equal(wire.sent.length, 1)
  const sent = wire.sent[0]!
  assert.equal(sent.session, uuid)
  assert.deepStrictEqual(sent.head, head(DECLARATIONS))
  assert.equal(sent.items.length, 1)
  // The message itself goes whole, after a view that does not hold it yet.
  assert.deepStrictEqual(lastText(sent.items[0]), { text: HEAD + "hello", mark: true })
  assert.deepStrictEqual(sent.items[0]!.kind === "user" ? sent.items[0]!.blocks[0] : null, { text: "<chat>\n", mark: true })
  assert.deepStrictEqual(messages(file), [
    { i: 0, kind: "user", text: "hello", turn: null, call: null },
    { i: 1, kind: "asst", text: "Hello to you.", turn: 1, call: null }
  ])
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }])
  assert.deepStrictEqual(items(file), ["user", "turn"])
  assert.deepStrictEqual(rows(file, "select taken, draft from everchat_chat"), [{ taken: 0, draft: null }])
  assert.deepStrictEqual(rows(file, "select served, turn, request, input, expected from everchat_usage"), [{ served: "turn", turn: 1, request: "req_1", input: 100, expected: 0 }])
  assert.deepStrictEqual(seen.map((event) => event.type), ["accepted", "start", "text", "message", "end"])
})

test("a program runs between two requests: its call is written, and the model's items go back as received", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "return 1 + 1") : n === 2 ? runs(asked, "call_2", "throw new Error('boom')") : says(asked, "It is 2.")))
  const programs: Array<string> = []
  const run: Run = (program) => Effect.sync(() => (programs.push(program), program.includes("throw") ? { output: "boom", failed: true } : { output: "2", failed: false }))
  await withTurns(file, wire, run, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("add one and one")
    yield* turnsService.idle
  }))
  assert.deepStrictEqual(programs, ["return 1 + 1", "throw new Error('boom')"])
  assert.equal(wire.sent.length, 3)
  const third = wire.sent[2]!.items
  assert.deepStrictEqual(third.map((item) => item.kind), ["user", "turn", "back", "turn", "back"])
  // The same first item in every request of the turn, and the model's own items as it gave them.
  assert.equal(JSON.stringify(third[0]), JSON.stringify(wire.sent[0]!.items[0]))
  assert.deepStrictEqual(third[1], { kind: "turn", output: [{ type: "reasoning", id: "rs_call_1", encrypted_content: "SECRET" }, { type: "custom_tool_call", call_id: "call_1", name: "run", input: "return 1 + 1" }] })
  assert.deepStrictEqual(third[2], { kind: "back", results: [{ id: "call_1", output: "2" }] })
  assert.deepStrictEqual(third[4], { kind: "back", results: [{ id: "call_2", output: "boom" }] })
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text, m.call]), [
    ["user", "add one and one", null],
    ["tool", "return 1 + 1", 1],
    ["echo", "2", 1],
    ["tool", "throw new Error('boom')", 2],
    ["echo", "boom", 2],
    ["asst", "It is 2.", null]
  ])
  assert.deepStrictEqual(rows(file, "select n as id, turn, parent, vendor_id, fn, input, output, size, shown, status from everchat_call order by n"), [
    { id: 1, turn: 1, parent: null, vendor_id: "call_1", fn: "run", input: "return 1 + 1", output: "2", size: 1, shown: 1, status: "done" },
    { id: 2, turn: 1, parent: null, vendor_id: "call_2", fn: "run", input: "throw new Error('boom')", output: "boom", size: 4, shown: 4, status: "failed" }
  ])
  assert.deepStrictEqual(items(file), ["user", "turn", "back", "turn", "back", "turn"])
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }])
  assert.deepStrictEqual(rows(file, "select count(*) as n from everchat_usage where served = 'turn' and turn = 1"), [{ n: 3 }])
})

test("a listener that subscribes before a message misses no event, and a program's start is one of them", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "return 1 + 1") : says(asked, "It is 2.")))
  await withTurns(file, wire, () => Effect.succeed({ output: "2", failed: false }), Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    // The subscription is there when this ends: nothing has to wait for it.
    const subscription = yield* turnsService.subscribe
    yield* turnsService.say("add one and one")
    yield* turnsService.idle
    const seen: ReadonlyArray<TurnEvent> = yield* PubSub.takeAll(subscription)
    assert.deepStrictEqual(seen.map((event) => event.type), ["accepted", "start", "text", "call", "message", "message", "text", "message", "end"])
    // The program's call is known when it starts, before its messages are in the log.
    assert.deepStrictEqual(seen[3], { type: "call", turn: 1, call: 1, program: "return 1 + 1" })
    assert.deepStrictEqual(seen.flatMap((event) => (event.type === "message" ? [[event.message.kind, event.message.call]] : [])), [["tool", 1], ["echo", 1], ["asst", null]])
  })))
})

test("a tool that is not the one tool gives the model an error, and no program runs", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => (n === 1 ? reply(asked, { text: "", calls: [{ id: "call_1", name: "shell", input: "ls" }] }) : says(asked, "Sorry.")))
  await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("list")
    yield* turnsService.idle
  }))
  assert.deepStrictEqual(wire.sent[1]!.items[2], { kind: "back", results: [{ id: "call_1", output: "No tool \"shell\": the one tool is \"run\"." }] })
  assert.deepStrictEqual(rows(file, "select fn, status from everchat_call"), [{ fn: "shell", status: "failed" }])
})

// More messages
// -------------

test("a message that comes while a turn runs steers it, and starts no turn of its own", async () => {
  const file = newFile()
  const gate = Deferred.makeUnsafe<void>()
  let started = false
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "wait()") : says(asked, "Both done.")))
  const run: Run = () => Effect.as(Effect.andThen(Effect.sync(() => (started = true)), Deferred.await(gate)), { output: "ok", failed: false })
  await withTurns(file, wire, run, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("do this")
    yield* eventually(() => started)
    const written = yield* turnsService.say("and also that") // logged at once, while the program runs
    assert.equal(written[0]!.i, 1)
    assert.deepStrictEqual(rows(file, "select count(*) as n from everchat_turn"), [{ n: 1 }])
    yield* Deferred.succeed(gate, undefined)
    yield* turnsService.idle
  }))
  assert.equal(wire.sent.length, 2)
  assert.deepStrictEqual(wire.sent[1]!.items.map((item) => item.kind), ["user", "turn", "back", "user"])
  assert.deepStrictEqual(wire.sent[1]!.items[3], { kind: "user", blocks: [{ text: "and also that", mark: false }] })
  assert.equal(turns(file).length, 1)
  assert.deepStrictEqual(rows(file, "select taken from everchat_chat"), [{ taken: 1 }])
  assert.deepStrictEqual(messages(file).map((m) => m.kind), ["user", "user", "tool", "echo", "asst"])
})

test("a message after a turn has ended starts the next turn, with the earlier ones in its view", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => says(asked, "Reply " + n + "."))
  await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("first")
    yield* turnsService.idle
    yield* turnsService.say("second")
    yield* turnsService.idle
  }))
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }, { id: 2, status: "done", why: null, first_msg: 2 }])
  const second = wire.sent[1]!.items[0]!
  const text = second.kind === "user" ? second.blocks.map((block) => block.text).join("") : ""
  assert.ok(text.includes("0+1|user: first\n1+1|asst: Reply 1.\n"))
  assert.deepStrictEqual(lastText(second), { text: HEAD + "second", mark: true })
  assert.deepStrictEqual(rows(file, "select taken from everchat_chat"), [{ taken: 2 }])
})

test("a long message goes in pages, and a turn waits until the messages before its own have their leaves", async () => {
  const file = newFile()
  const gate = Deferred.makeUnsafe<void>()
  const wire = fakeWire((asked) => says(asked, "Read."))
  const paste = Array.from({ length: 900 }, (_, n) => "line " + n + " " + "p".repeat(40)).join("\n") // two pages
  await withTurns(
    file,
    wire,
    noPrograms,
    Effect.gen(function*() {
      const memory = yield* Memory
      const turnsService = yield* Turns
      yield* memory.push([{ kind: "note", text: "n".repeat(700) }]) // its leaf needs a compaction, which waits at the gate
      yield* turnsService.say(paste)
      yield* Effect.sleep("30 millis")
      assert.equal(wire.sent.length, 0) // the turn waits for the leaf of message 0
      yield* Deferred.succeed(gate, undefined)
      yield* turnsService.idle
    }),
    () => Effect.as(Deferred.await(gate), { text: "a summary" })
  )
  const sent = wire.sent[0]!.items[0]!
  assert.deepStrictEqual(lastText(sent), { text: HEAD + paste, mark: true })
  const view = sent.kind === "user" ? sent.blocks.slice(0, -1).map((block) => block.text).join("") : ""
  assert.equal(view, "<chat>\n0+1|a summary\n</chat>\n")
  assert.deepStrictEqual(rows(file, "select taken from everchat_chat"), [{ taken: 2 }])
})

// Ends that are not good
// ----------------------

test("a request that fails ends the turn as failed, with a note, and the next message starts a new turn", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => (n === 1 ? wireError("input", { message: "OpenAI answered 400: Too much input." }) : says(asked, "Now it works.")))
  await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("hello")
    yield* turnsService.idle
    yield* turnsService.say("again")
    yield* turnsService.idle
  }))
  assert.deepStrictEqual(turns(file), [
    { id: 1, status: "failed", why: "OpenAI answered 400: Too much input.", first_msg: 0 },
    { id: 2, status: "done", why: null, first_msg: 2 }
  ])
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [
    ["user", "hello"],
    ["note", "No reply: OpenAI answered 400: Too much input. Send a message to try again."],
    ["user", "again"],
    ["asst", "Now it works."]
  ])
})

test("a reply that stops at the token limit is logged, and the turn fails", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => reply(asked, { text: "Half a", stop: "max" }))
  await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("write a lot")
    yield* turnsService.idle
  }))
  assert.deepStrictEqual(messages(file).map((m) => m.kind), ["user", "asst", "note"])
  assert.partialDeepStrictEqual({ ...turns(file)[0] }, { status: "failed", why: "the model reached the most tokens it may write" })
})

test("the person stops a turn: the program that runs is closed as cut, and the turn is stopped", async () => {
  const file = newFile()
  let started = false
  const wire = fakeWire((asked) => runs(asked, "call_1", "forever()"))
  const run: Run = () => Effect.andThen(Effect.sync(() => (started = true)), Effect.never)
  await withTurns(file, wire, run, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("run for ever")
    yield* eventually(() => started)
    yield* turnsService.stop()
    yield* turnsService.idle
    // A stopped turn is over: a new message starts a new turn.
    assert.deepStrictEqual(turns(file), [{ id: 1, status: "stopped", why: "Stopped.", first_msg: 0 }])
  }))
  assert.deepStrictEqual(rows(file, "select status, output from everchat_call"), [{ status: "cut", output: cutText(STOPPED, []) }])
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [
    ["user", "run for ever"],
    ["tool", "forever()"],
    ["echo", cutText(STOPPED, [])],
    ["note", "Stopped."]
  ])
})

// A restart
// ---------

test("a turn that the program's stop cut during a request goes on at the next launch, with the same bytes", async () => {
  const file = newFile()
  const never = fakeWire(() => reply({} as Request))
  never.wire.send = (asked) => (never.sent.push(asked), Stream.never)
  await withTurns(file, never, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("hello")
    yield* eventually(() => never.sent.length === 1)
  }))
  // The launch ended in the middle of the request: the turn still runs.
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "running", why: null, first_msg: 0 }])
  assert.deepStrictEqual(items(file), ["user"])
  const wire = fakeWire((asked) => says(asked, "Here I am."))
  await withTurns(file, wire, noPrograms, Turns.use((turnsService) => turnsService.idle))
  assert.equal(wire.sent.length, 1)
  assert.equal(JSON.stringify(wire.sent[0]!.items), JSON.stringify(never.sent[0]!.items))
  assert.deepStrictEqual(wire.sent[0]!.head, never.sent[0]!.head)
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }])
  assert.deepStrictEqual(messages(file).map((m) => m.kind), ["user", "asst"])
})

test("a program that ran when the program stopped is closed as cut at the next launch, and the model is told", async () => {
  const file = newFile()
  let started = false
  const first = fakeWire((asked) => runs(asked, "call_1", "slow()"))
  await withTurns(file, first, () => Effect.andThen(Effect.sync(() => (started = true)), Effect.never), Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("do the slow thing")
    yield* eventually(() => started)
  }))
  assert.deepStrictEqual(rows(file, "select status from everchat_call"), [{ status: "running" }])
  assert.partialDeepStrictEqual({ ...turns(file)[0] }, { status: "running" })
  const wire = fakeWire((asked) => says(asked, "It was cut, I will check."))
  await withTurns(file, wire, noPrograms, Turns.use((turnsService) => turnsService.idle))
  // The program is not run again: the model gets the cut as its result.
  assert.equal(wire.sent.length, 1)
  assert.deepStrictEqual(wire.sent[0]!.items.map((item) => item.kind), ["user", "turn", "back"])
  assert.deepStrictEqual(wire.sent[0]!.items[2], { kind: "back", results: [{ id: "call_1", output: cutText(CUT, []) }] })
  assert.deepStrictEqual(rows(file, "select status, output from everchat_call"), [{ status: "cut", output: cutText(CUT, []) }])
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [
    ["user", "do the slow thing"],
    ["tool", "slow()"],
    ["echo", cutText(CUT, [])],
    ["asst", "It was cut, I will check."]
  ])
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }])
})

test("a turn that was cut before its first request was built builds it at the next launch", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Hello."))
  await withTurns(
    file,
    wire,
    noPrograms,
    Effect.gen(function*() {
      const memory = yield* Memory
      const turnsService = yield* Turns
      yield* memory.push([{ kind: "note", text: "n".repeat(700) }])
      yield* turnsService.say("hello")
      yield* Effect.sleep("30 millis")
    }),
    () => Effect.never // the leaf of message 0 is never built in this launch
  )
  assert.equal(wire.sent.length, 0)
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "running", why: null, first_msg: 1 }])
  assert.deepStrictEqual(items(file), [])
  await withTurns(file, wire, noPrograms, Turns.use((turnsService) => turnsService.idle))
  assert.equal(wire.sent.length, 1)
  assert.deepStrictEqual(lastText(wire.sent[0]!.items[0]), { text: HEAD + "hello", mark: true })
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 1 }])
})
