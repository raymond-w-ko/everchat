// Tests of the turn loop, with a fake wire and a fake sandbox: what a turn
// sends, what it writes, how a message steers it, how it fails and stops,
// and how it goes on after a restart.

import { expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { compactor, fakeWire, newFile, options, reply, rows, wireError } from "../tests/help.ts"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import { head } from "./head.ts"
import { Memory } from "./memory.ts"
import type { Item, Reply, Request } from "./request.ts"
import { Store } from "./store.ts"
import { CUT, HEAD, Sandbox, STOPPED, type TurnEvent, Turns } from "./turn.ts"
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
  const store = Store.layer(file, options())
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(summaries)))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run }))
  const turns = Turns.layer().pipe(Layer.provideMerge(memory), Layer.provide(Layer.merge(asking, sandbox)))
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

const messages = (file: string) => rows<{ i: number; kind: string; text: string; turn: number | null; call: number | null }>(file, "select i, kind, text, turn, call from msg_read order by i")
const turns = (file: string) => rows(file, "select id, status, why, first_msg from turn order by id")
const items = (file: string, turn = 1) => rows<{ kind: string }>(file, `select kind from turn_item where turn = ${turn} order by n`).map((row) => row.kind)

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
    expect(written.map((message) => [message.i, message.kind, message.text])).toEqual([[0, "user", "hello"]])
    yield* turnsService.idle
    yield* Effect.sleep("5 millis")
    return (yield* (yield* Store).chat).uuid
  }))
  expect(wire.sent.length).toBe(1)
  const sent = wire.sent[0]!
  expect(sent.session).toBe(uuid)
  expect(sent.head).toEqual(head())
  expect(sent.items.length).toBe(1)
  // The message itself goes whole, after a view that does not hold it yet.
  expect(lastText(sent.items[0])).toEqual({ text: HEAD + "hello", mark: true })
  expect(sent.items[0]!.kind === "user" ? sent.items[0]!.blocks[0] : null).toEqual({ text: "<chat>\n", mark: true })
  expect(messages(file)).toEqual([
    { i: 0, kind: "user", text: "hello", turn: null, call: null },
    { i: 1, kind: "asst", text: "Hello to you.", turn: 1, call: null }
  ])
  expect(turns(file)).toEqual([{ id: 1, status: "done", why: null, first_msg: 0 }])
  expect(items(file)).toEqual(["user", "turn"])
  expect(rows(file, "select taken, draft from chat")).toEqual([{ taken: 0, draft: null }])
  expect(rows(file, "select served, turn, request, input, expected from usage")).toEqual([{ served: "turn", turn: 1, request: "req_1", input: 100, expected: 0 }])
  expect(seen.map((event) => event.type)).toEqual(["accepted", "start", "text", "message", "end"])
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
  expect(programs).toEqual(["return 1 + 1", "throw new Error('boom')"])
  expect(wire.sent.length).toBe(3)
  const third = wire.sent[2]!.items
  expect(third.map((item) => item.kind)).toEqual(["user", "turn", "back", "turn", "back"])
  // The same first item in every request of the turn, and the model's own items as it gave them.
  expect(JSON.stringify(third[0])).toBe(JSON.stringify(wire.sent[0]!.items[0]))
  expect(third[1]).toEqual({ kind: "turn", output: [{ type: "reasoning", id: "rs_call_1", encrypted_content: "SECRET" }, { type: "custom_tool_call", call_id: "call_1", name: "run", input: "return 1 + 1" }] })
  expect(third[2]).toEqual({ kind: "back", results: [{ id: "call_1", output: "2" }] })
  expect(third[4]).toEqual({ kind: "back", results: [{ id: "call_2", output: "error: boom" }] })
  expect(messages(file).map((m) => [m.kind, m.text, m.call])).toEqual([
    ["user", "add one and one", null],
    ["tool", "return 1 + 1", 1],
    ["echo", "2", 1],
    ["tool", "throw new Error('boom')", 2],
    ["echo", "error: boom", 2],
    ["asst", "It is 2.", null]
  ])
  expect(rows(file, "select id, turn, parent, vendor_id, fn, input, output, size, shown, status from call order by id")).toEqual([
    { id: 1, turn: 1, parent: null, vendor_id: "call_1", fn: "run", input: "return 1 + 1", output: "2", size: 1, shown: 1, status: "done" },
    { id: 2, turn: 1, parent: null, vendor_id: "call_2", fn: "run", input: "throw new Error('boom')", output: "boom", size: 4, shown: 4, status: "failed" }
  ])
  expect(items(file)).toEqual(["user", "turn", "back", "turn", "back", "turn"])
  expect(turns(file)).toEqual([{ id: 1, status: "done", why: null, first_msg: 0 }])
  expect(rows(file, "select count(*) as n from usage where served = 'turn' and turn = 1")).toEqual([{ n: 3 }])
})

test("a tool that is not the one tool gives the model an error, and no program runs", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => (n === 1 ? reply(asked, { text: "", calls: [{ id: "call_1", name: "shell", input: "ls" }] }) : says(asked, "Sorry.")))
  await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("list")
    yield* turnsService.idle
  }))
  expect(wire.sent[1]!.items[2]).toEqual({ kind: "back", results: [{ id: "call_1", output: "error: No tool \"shell\": the one tool is \"run\"." }] })
  expect(rows(file, "select fn, status from call")).toEqual([{ fn: "shell", status: "failed" }])
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
    expect(written[0]!.i).toBe(1)
    expect(rows(file, "select count(*) as n from turn")).toEqual([{ n: 1 }])
    yield* Deferred.succeed(gate, undefined)
    yield* turnsService.idle
  }))
  expect(wire.sent.length).toBe(2)
  expect(wire.sent[1]!.items.map((item) => item.kind)).toEqual(["user", "turn", "back", "user"])
  expect(wire.sent[1]!.items[3]).toEqual({ kind: "user", blocks: [{ text: "and also that", mark: false }] })
  expect(turns(file).length).toBe(1)
  expect(rows(file, "select taken from chat")).toEqual([{ taken: 1 }])
  expect(messages(file).map((m) => m.kind)).toEqual(["user", "user", "tool", "echo", "asst"])
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
  expect(turns(file)).toEqual([{ id: 1, status: "done", why: null, first_msg: 0 }, { id: 2, status: "done", why: null, first_msg: 2 }])
  const second = wire.sent[1]!.items[0]!
  const text = second.kind === "user" ? second.blocks.map((block) => block.text).join("") : ""
  expect(text).toContain("0+1|user: first\n1+1|asst: Reply 1.\n")
  expect(lastText(second)).toEqual({ text: HEAD + "second", mark: true })
  expect(rows(file, "select taken from chat")).toEqual([{ taken: 2 }])
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
      expect(wire.sent.length).toBe(0) // the turn waits for the leaf of message 0
      yield* Deferred.succeed(gate, undefined)
      yield* turnsService.idle
    }),
    () => Effect.as(Deferred.await(gate), { text: "a summary" })
  )
  const sent = wire.sent[0]!.items[0]!
  expect(lastText(sent)).toEqual({ text: HEAD + paste, mark: true })
  const view = sent.kind === "user" ? sent.blocks.slice(0, -1).map((block) => block.text).join("") : ""
  expect(view).toBe("<chat>\n0+1|a summary\n</chat>\n")
  expect(rows(file, "select taken from chat")).toEqual([{ taken: 2 }])
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
  expect(turns(file)).toEqual([
    { id: 1, status: "failed", why: "OpenAI answered 400: Too much input.", first_msg: 0 },
    { id: 2, status: "done", why: null, first_msg: 2 }
  ])
  expect(messages(file).map((m) => [m.kind, m.text])).toEqual([
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
  expect(messages(file).map((m) => m.kind)).toEqual(["user", "asst", "note"])
  expect(turns(file)[0]).toMatchObject({ status: "failed", why: "the model reached the most tokens it may write" })
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
    expect(turns(file)).toEqual([{ id: 1, status: "stopped", why: "Stopped.", first_msg: 0 }])
  }))
  expect(rows(file, "select status, output from call")).toEqual([{ status: "cut", output: STOPPED }])
  expect(messages(file).map((m) => [m.kind, m.text])).toEqual([
    ["user", "run for ever"],
    ["tool", "forever()"],
    ["echo", STOPPED],
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
  expect(turns(file)).toEqual([{ id: 1, status: "running", why: null, first_msg: 0 }])
  expect(items(file)).toEqual(["user"])
  const wire = fakeWire((asked) => says(asked, "Here I am."))
  await withTurns(file, wire, noPrograms, Turns.use((turnsService) => turnsService.idle))
  expect(wire.sent.length).toBe(1)
  expect(JSON.stringify(wire.sent[0]!.items)).toBe(JSON.stringify(never.sent[0]!.items))
  expect(wire.sent[0]!.head).toEqual(never.sent[0]!.head)
  expect(turns(file)).toEqual([{ id: 1, status: "done", why: null, first_msg: 0 }])
  expect(messages(file).map((m) => m.kind)).toEqual(["user", "asst"])
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
  expect(rows(file, "select status from call")).toEqual([{ status: "running" }])
  expect(turns(file)[0]).toMatchObject({ status: "running" })
  const wire = fakeWire((asked) => says(asked, "It was cut, I will check."))
  await withTurns(file, wire, noPrograms, Turns.use((turnsService) => turnsService.idle))
  // The program is not run again: the model gets the cut as its result.
  expect(wire.sent.length).toBe(1)
  expect(wire.sent[0]!.items.map((item) => item.kind)).toEqual(["user", "turn", "back"])
  expect(wire.sent[0]!.items[2]).toEqual({ kind: "back", results: [{ id: "call_1", output: CUT }] })
  expect(rows(file, "select status, output from call")).toEqual([{ status: "cut", output: CUT }])
  expect(messages(file).map((m) => [m.kind, m.text])).toEqual([
    ["user", "do the slow thing"],
    ["tool", "slow()"],
    ["echo", CUT],
    ["asst", "It was cut, I will check."]
  ])
  expect(turns(file)).toEqual([{ id: 1, status: "done", why: null, first_msg: 0 }])
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
  expect(wire.sent.length).toBe(0)
  expect(turns(file)).toEqual([{ id: 1, status: "running", why: null, first_msg: 1 }])
  expect(items(file)).toEqual([])
  await withTurns(file, wire, noPrograms, Turns.use((turnsService) => turnsService.idle))
  expect(wire.sent.length).toBe(1)
  expect(lastText(wire.sent[0]!.items[0])).toEqual({ text: HEAD + "hello", mark: true })
  expect(turns(file)).toEqual([{ id: 1, status: "done", why: null, first_msg: 1 }])
})
