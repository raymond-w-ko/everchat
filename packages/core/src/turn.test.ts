// Tests of the turn loop, with a fake wire and a fake sandbox: what a turn
// sends, what it writes, how a message steers it, how it fails and stops,
// and how it goes on after a restart.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Deferred, Effect, Exit, Fiber, Layer, PubSub } from "effect"
import { TestClock } from "effect/testing"
import * as path from "node:path"
import { compactor, fakeWire, newFile, options, PICK, reply, rows, wireError } from "@everchat/local/testing"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import { head } from "./head.ts"
import { Memory } from "./memory.ts"
import type { Item, Reply, Request } from "./request.ts"
import { chatsLayer, storeLayer } from "@everchat/sqlite/bun"
import { Chats, Store, StoreError } from "./store.ts"
import { limitLayer } from "@everchat/local/limitfile"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { Sandbox } from "./sandbox.ts"
import { CUT, cutText, HEAD, type Sent, STOPPED, type TurnEvent, Turns, WHY, whyOf } from "./turn.ts"
import { Stream } from "effect"

type Run = (program: string) => Effect.Effect<{ output: string; failed: boolean }>

// One launch: the store, the memory, the ask service over a fake wire, a
// fake sandbox, and the turn loop. `over` puts a wrapper over the store or
// the memory that the turn loop gets; `over.base` is a store in place of the
// file's chat; `over.hub` is the hub's capacity; `over.clock` runs it all on
// a TestClock.
const withTurns = <A, E>(
  file: string,
  wire: ReturnType<typeof fakeWire>,
  run: Run,
  effect: Effect.Effect<A, E, Turns | Memory | Store>,
  summaries: Parameters<typeof compactor>[0] = () => "a summary",
  over: {
    readonly store?: Layer.Layer<Store, never, Store>
    readonly memory?: Layer.Layer<Memory, never, Memory>
    readonly base?: Layer.Layer<Store>
    readonly hub?: number
    readonly clock?: boolean
  } = {}
) => {
  const real = over.base ?? storeLayer(file, options())
  const store = over.store === undefined ? real : over.store.pipe(Layer.provide(real))
  const memory = (over.memory === undefined ? Memory.layer : over.memory.pipe(Layer.provide(Memory.layer))).pipe(Layer.provideMerge(store), Layer.provide(compactor(summaries)))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ declarations: DECLARATIONS, ...(over.hub === undefined ? {} : { hub: over.hub }) }).pipe(
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, sandbox, limit))
  )
  const ran = effect.pipe(Effect.provide(turns), Effect.provideService(AskDelay, () => Effect.succeed(0)))
  return Effect.runPromise(over.clock === true ? ran.pipe(Effect.provide(TestClock.layer())) : ran)
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
    assert.deepStrictEqual(written.messages.map((message) => [message.i, message.kind, message.text]), [[0, "user", "hello"]])
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
    assert.deepStrictEqual(seen[3], { type: "call", n: 3, turn: 1, call: 1, program: "return 1 + 1" })
    assert.deepStrictEqual(seen.flatMap((event) => (event.type === "message" ? [[event.message.kind, event.message.call]] : [])), [["tool", 1], ["echo", 1], ["asst", null]])
  })))
})

// The events' rows
// ----------------

type EventRow = { n: number; type: string; turn: number | null; call: number | null; msg: number | null; msg_last: number | null }

// The rows of everchat_event, in the order of their numbers.
const events = (file: string) => rows<EventRow>(file, "select n, type, turn, call, msg, msg_last from everchat_event order by n")

// What a listener got, but the pieces, as the rows that section 7 gives
// each type: `accepted` and `message` their first and last message, `start`
// and `end` their turn, `call` its turn and its call, and null for the rest.
const reported = (seen: ReadonlyArray<TurnEvent>) =>
  seen.flatMap((event): Array<EventRow> =>
    event.type === "accepted"
      ? [{ n: event.n, type: event.type, turn: null, call: null, msg: event.messages[0]!.i, msg_last: event.messages[event.messages.length - 1]!.i }]
      : event.type === "message"
      ? [{ n: event.n, type: event.type, turn: null, call: null, msg: event.message.i, msg_last: event.message.i }]
      : event.type === "start" || event.type === "end"
      ? [{ n: event.n, type: event.type, turn: event.turn, call: null, msg: null, msg_last: null }]
      : event.type === "call"
      ? [{ n: event.n, type: event.type, turn: event.turn, call: event.call, msg: null, msg_last: null }]
      : []
  )

// The numbers run from 1 with no gap, and the chat's `seq` is the last one.
const counted = (file: string) => {
  const all = events(file)
  assert.deepStrictEqual(all.map((row) => row.n), Array.from({ length: all.length }, (_, k) => k + 1))
  assert.deepStrictEqual(rows(file, "select seq from everchat_chat"), [{ seq: all.length }])
}

// A store whose `messagesAfter` runs `late.say` once, when it finds no
// message and `when` holds, then `late.then`: so a message comes after a
// turn's last steer has found none, and it waits for the next turn.
const lateStore = (late: { say: Effect.Effect<unknown, unknown> | null; then?: Effect.Effect<void, unknown> }, when: () => boolean) =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({
        ...real,
        messagesAfter: (after, kinds) =>
          Effect.gen(function*() {
            const found = yield* real.messagesAfter(after, kinds)
            const say = late.say
            if (say !== null && found.length === 0 && when()) {
              late.say = null
              yield* Effect.orDie(say)
              if (late.then !== undefined) {
                yield* Effect.orDie(late.then)
              }
            }
            return found
          })
      })
    })
  )

test("each event but a piece has its row and its number, 1, 2, 3 with no gap: the five types, the next turn of a waiting message, and a restart", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "return 1 + 1") : says(asked, "Reply " + n + ".")))
  const late: { say: Effect.Effect<unknown, unknown> | null } = { say: null }
  const seen = await withTurns(
    file,
    wire,
    () => Effect.succeed({ output: "2", failed: false }),
    Effect.scoped(Effect.gen(function*() {
      const turnsService = yield* Turns
      const subscription = yield* turnsService.subscribe
      late.say = turnsService.say("and now?")
      yield* turnsService.say("add one and one")
      yield* eventually(() => wire.sent.length === 3)
      yield* turnsService.idle
      return yield* PubSub.takeAll(subscription)
    })),
    undefined,
    { store: lateStore(late, () => wire.sent.length === 2) }
  )
  assert.equal(late.say, null)
  // The late message started turn 2, in the transaction of its `start`.
  assert.deepStrictEqual(turns(file).map((turn) => [turn.id, turn.first_msg]), [[1, 0], [2, 4]])
  assert.deepStrictEqual(seen.filter((event) => event.type !== "text").map((event) => event.type), ["accepted", "start", "call", "message", "message", "message", "accepted", "end", "start", "message", "end"])
  // Each published event's `n` is its row's, and each row holds what its type reports.
  assert.deepStrictEqual(events(file), reported(seen))
  assert.equal(events(file).length, 11)
  counted(file)

  // A restart: the cut program's `tool` and `echo` get their `message` rows,
  // and the turn that continues its `start`, after the last number.
  const cut = newFile()
  let started = false
  await withTurns(cut, fakeWire((asked) => runs(asked, "call_1", "slow()")), () => Effect.andThen(Effect.sync(() => (started = true)), Effect.never), Effect.gen(function*() {
    yield* (yield* Turns).say("do the slow thing")
    yield* eventually(() => started)
  }))
  assert.deepStrictEqual(events(cut).map((row) => [row.n, row.type]), [[1, "accepted"], [2, "start"], [3, "call"]])
  const again = await withTurns(cut, fakeWire((asked) => says(asked, "It was cut.")), noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    yield* turnsService.idle
    return yield* PubSub.takeAll(subscription)
  })))
  assert.deepStrictEqual(events(cut), [
    { n: 1, type: "accepted", turn: null, call: null, msg: 0, msg_last: 0 },
    { n: 2, type: "start", turn: 1, call: null, msg: null, msg_last: null },
    { n: 3, type: "call", turn: 1, call: 1, msg: null, msg_last: null },
    { n: 4, type: "message", turn: null, call: null, msg: 1, msg_last: 1 },
    { n: 5, type: "message", turn: null, call: null, msg: 2, msg_last: 2 },
    { n: 6, type: "start", turn: 1, call: null, msg: null, msg_last: null },
    { n: 7, type: "message", turn: null, call: null, msg: 3, msg_last: 3 },
    { n: 8, type: "end", turn: 1, call: null, msg: null, msg_last: null }
  ])
  counted(cut)
  // The restart's events came before the listener could subscribe; what it got carries the last rows' numbers.
  assert.deepStrictEqual(reported(again), events(cut).slice(6))
})

test("the store reads the events again as a listener got them: the five types, number for number and field for field, also in two parts", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "return 1 + 1") : says(asked, "Two.")))
  const got = await withTurns(
    file,
    wire,
    () => Effect.succeed({ output: "2", failed: false }),
    Effect.scoped(Effect.gen(function*() {
      const turnsService = yield* Turns
      const subscription = yield* turnsService.subscribe
      yield* turnsService.say("add one and one")
      yield* eventually(() => wire.sent.length === 2)
      yield* turnsService.idle
      const seen = yield* PubSub.takeAll(subscription)
      const store = yield* Store
      const read = yield* store.eventsAfter(0, 1000)
      const first = yield* store.eventsAfter(0, 3)
      const rest = yield* store.eventsAfter(first.at(-1)!.n, 1000)
      return { seen, read, first, rest }
    }))
  )
  // The events that the listener got, without the pieces.
  const numbered = got.seen.filter((event) => event.type !== "text" && event.type !== "thought" && event.type !== "program")
  assert.deepStrictEqual([...new Set(numbered.map((event) => event.type))].sort(), ["accepted", "call", "end", "message", "start"])
  assert.deepStrictEqual(got.read, numbered)
  assert.deepStrictEqual(got.read.map((event) => event.n), Array.from({ length: numbered.length }, (_, k) => k + 1))
  assert.equal(got.first.length, 3)
  assert.deepStrictEqual([...got.first, ...got.rest], numbered)
})

test("a program and a turn's end with a lone surrogate: the listener gets the text that the store reads again, well-formed", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) =>
    n === 1 ? runs(asked, "call_1", "p\ud800q") : n === 2 ? says(asked, "Done.") : wireError("input", { message: "bad \ud800 input" })
  )
  const ran: Array<string> = []
  const got = await withTurns(
    file,
    wire,
    (program) => Effect.sync(() => (ran.push(program), { output: "ok", failed: false })),
    Effect.scoped(Effect.gen(function*() {
      const turnsService = yield* Turns
      const subscription = yield* turnsService.subscribe
      yield* turnsService.say("run it")
      yield* eventually(() => wire.sent.length === 2)
      yield* turnsService.idle
      yield* turnsService.say("again")
      yield* turnsService.idle
      const seen = yield* PubSub.takeAll(subscription)
      const store = yield* Store
      return { seen, read: yield* store.eventsAfter(0, 1000) }
    }))
  )
  const numbered = got.seen.filter((event) => event.type !== "text" && event.type !== "thought" && event.type !== "program")
  assert.deepStrictEqual(got.read, numbered)
  const call = numbered.find((event) => event.type === "call")
  const ends = numbered.filter((event) => event.type === "end")
  assert.equal(call?.type === "call" && call.program, "p�q")
  assert.deepStrictEqual(ends.map((event) => event.type === "end" && [event.status, event.why]), [["done", null], ["failed", "bad � input"]])
  for (const event of [...numbered, ...got.read]) {
    if (event.type === "call") assert.equal(event.program.isWellFormed(), true)
    if (event.type === "end" && event.why !== null) assert.equal(event.why.isWellFormed(), true)
  }
  // The sandbox runs the program as the model gave it.
  assert.deepStrictEqual(ran, ["p\ud800q"])
})

test("a listener gets the events in the order of their numbers: a message of the person that comes while a step writes its messages", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => says(asked, "Reply " + n + "."))
  // The window: the step's `asst` page is committed, and its event is not
  // yet published. The memory's `pushWith` lets the person's message run
  // then, and waits until it is in the log or 100 ms have passed. With no
  // lock over the write and the publish, it is logged and published inside
  // the window, every time; with the lock, it waits for the step's publish.
  const window: { say: Effect.Effect<unknown, unknown> | null } = { say: null }
  let opened = false
  const memory = Layer.effect(
    Memory,
    Effect.gen(function*() {
      const real = yield* Memory
      return Memory.of({
        ...real,
        pushWith: (said, also, key, then) =>
          real.pushWith(said, also, key, (written, more) =>
            Effect.gen(function*() {
              const say = window.say
              if (say !== null && said[0]?.kind === "asst") {
                window.say = null
                opened = true
                const fiber = yield* Effect.forkDetach(say)
                yield* Effect.race(Fiber.await(fiber), Effect.sleep("100 millis"))
              }
              if (then !== undefined) yield* then(written, more)
            }))
      })
    })
  )
  const seen = await withTurns(
    file,
    wire,
    noPrograms,
    Effect.scoped(Effect.gen(function*() {
      const turnsService = yield* Turns
      const subscription = yield* turnsService.subscribe
      window.say = turnsService.say("one more thing")
      yield* turnsService.say("hello")
      yield* eventually(() => opened && messages(file).some((message) => message.text === "one more thing"))
      yield* turnsService.idle
      return yield* PubSub.takeAll(subscription)
    })),
    undefined,
    { memory }
  )
  assert.ok(opened)
  const numbers = reported(seen).map((row) => row.n)
  assert.deepStrictEqual(numbers, Array.from({ length: numbers.length }, (_, k) => k + 1))
  assert.equal(seen.filter((event) => event.type === "accepted").length, 2)
  assert.deepStrictEqual(events(file), reported(seen))
  counted(file)
})

test("the draft: a message sent when no turn runs clears it, and the turn that a waiting message starts leaves it as it was", async () => {
  const file = newFile()
  const wire = fakeWire((asked, n) => says(asked, "Reply " + n + "."))
  const drafts: Array<string | null> = []
  const late: { say: Effect.Effect<unknown, unknown> | null; then?: Effect.Effect<void, unknown> } = { say: null }
  await withTurns(
    file,
    wire,
    noPrograms,
    Effect.gen(function*() {
      const store = yield* Store
      const turnsService = yield* Turns
      yield* store.setDraft("half typed")
      late.say = Effect.andThen(Effect.flatMap(store.chat, (chat) => Effect.sync(() => drafts.push(chat.draft))), turnsService.say("and then?"))
      // What the person types after the waiting message, before the next turn starts.
      late.then = store.setDraft("typed after it")
      yield* turnsService.say("hello")
      yield* eventually(() => wire.sent.length === 2)
      yield* turnsService.idle
    }),
    undefined,
    { store: lateStore(late, () => wire.sent.length === 1) }
  )
  assert.equal(late.say, null)
  // The message sent with no turn running cleared it, in its transaction.
  assert.deepStrictEqual(drafts, [null])
  assert.deepStrictEqual(turns(file).map((turn) => [turn.id, turn.first_msg]), [[1, 0], [2, 2]])
  assert.deepStrictEqual(rows(file, "select draft from everchat_chat"), [{ draft: "typed after it" }])
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
    assert.equal(written.messages[0]!.i, 1)
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

// The sender's key
// ----------------

// The rows that a repeat must leave as they were.
const counts = (file: string) =>
  rows(file, "select (select count(*) from everchat_msg) as msgs, (select count(*) from everchat_event) as events, (select count(*) from everchat_turn) as turns")

test("a message with its sender's key gives its pages, the number of the `accepted` event that a listener got, and no repeat", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Hello to you."))
  const [sent, seen] = await withTurns(file, wire, noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    const sent = yield* turnsService.say("hello", "key-1")
    yield* turnsService.idle
    return [sent, yield* PubSub.takeAll(subscription)] as const
  })))
  const accepted = seen.filter((event) => event.type === "accepted")
  assert.equal(accepted.length, 1)
  assert.deepStrictEqual(sent, { messages: accepted[0]!.messages, accepted: accepted[0]!.n, repeat: false })
  assert.deepStrictEqual(sent.messages.map((message) => [message.i, message.kind, message.text]), [[0, "user", "hello"]])
  assert.deepStrictEqual(rows(file, "select i, sender_key from everchat_msg order by i"), [{ i: 0, sender_key: "key-1" }, { i: 1, sender_key: null }])
})

test("the same key again, while idle and while a turn runs: nothing is written, published or started, and the first message comes back", async () => {
  const file = newFile()
  const gate = Deferred.makeUnsafe<void>()
  let started = false
  const wire = fakeWire((asked, n) => (n === 2 ? runs(asked, "call_1", "wait()") : says(asked, "Reply " + n + ".")))
  const run: Run = () => Effect.as(Effect.andThen(Effect.sync(() => (started = true)), Deferred.await(gate)), { output: "ok", failed: false })
  await withTurns(file, wire, run, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const first = yield* turnsService.say("hello", "key-1")
    yield* turnsService.idle
    // While idle.
    const before = counts(file)
    const subscription = yield* turnsService.subscribe
    assert.deepStrictEqual(yield* turnsService.say("hello", "key-1"), { ...first, repeat: true })
    assert.deepStrictEqual(counts(file), before)
    assert.deepStrictEqual(yield* PubSub.takeUpTo(subscription, 1000), [])
    assert.equal(wire.sent.length, 1)
    // While a turn runs.
    const second = yield* turnsService.say("run it", "key-2")
    yield* eventually(() => started)
    const during = counts(file)
    yield* PubSub.takeUpTo(subscription, 1000)
    assert.deepStrictEqual(yield* turnsService.say("run it", "key-2"), { ...second, repeat: true })
    assert.deepStrictEqual(yield* turnsService.say("hello", "key-1"), { ...first, repeat: true })
    assert.deepStrictEqual(counts(file), during)
    assert.deepStrictEqual(yield* PubSub.takeUpTo(subscription, 1000), [])
    yield* Deferred.succeed(gate, undefined)
    yield* turnsService.idle
  })))
  // No repeat steered the turn that ran, and none started one.
  assert.equal(wire.sent.length, 3)
  assert.deepStrictEqual(wire.sent[2]!.items.map((item) => item.kind), ["user", "turn", "back"])
  assert.deepStrictEqual(turns(file).map((turn) => [turn.id, turn.status]), [[1, "done"], [2, "done"]])
  assert.deepStrictEqual(messages(file).filter((m) => m.kind === "user").map((m) => m.text), ["hello", "run it"])
})

test("the same key with another text gives the first message, and logs nothing", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    const first = yield* turnsService.say("hello", "key-1")
    yield* turnsService.idle
    const before = counts(file)
    assert.deepStrictEqual(yield* turnsService.say("something else", "key-1"), { ...first, repeat: true })
    assert.deepStrictEqual(counts(file), before)
  }))
  assert.deepStrictEqual(messages(file).map((m) => m.text), ["hello", "Read."])
})

test("two messages of one key at the same time log one message: the key is read under the loop's lock", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  // The read of a key takes a while: with no lock over the read and the
  // write, both messages read no message, and both are written.
  const slowKeyed = Layer.effect(
    Store,
    Store.useSync((store) => Store.of({ ...store, keyed: (key) => Effect.tap(store.keyed(key), () => Effect.sleep("20 millis")) }))
  )
  const both = await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    const both = yield* Effect.all([turnsService.say("hello", "key-1"), turnsService.say("hello", "key-1")], { concurrency: "unbounded" })
    yield* turnsService.idle
    return both
  }), undefined, { store: slowKeyed })
  assert.deepStrictEqual(both.map((sent) => sent.repeat).sort(), [false, true])
  assert.deepStrictEqual(both[0]!.messages, both[1]!.messages)
  assert.equal(both[0]!.accepted, both[1]!.accepted)
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [["user", "hello"], ["asst", "Read."]])
  assert.equal(turns(file).length, 1)
})

test("the same key in a second chat is a new message there, and each chat keeps its own", async () => {
  const file = newFile()
  const tenant = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
  const made = await Effect.runPromise(
    Effect.scoped(Chats.use((chats) => Effect.all([chats.make(tenant, PICK), chats.make(tenant, PICK)]))).pipe(Effect.provide(chatsLayer(file)))
  )
  const base = (chat: string) =>
    Layer.effect(Store, Effect.orDie(Chats.use((chats) => chats.store(tenant, chat, options().launch)))).pipe(Layer.provide(chatsLayer(file)), Layer.orDie)
  const say = (chat: string) =>
    withTurns(file, fakeWire((asked) => says(asked, "Read.")), noPrograms, Effect.gen(function*() {
      const turnsService = yield* Turns
      const sent = yield* turnsService.say("hello", "key-1")
      yield* turnsService.idle
      return sent
    }), undefined, { base: base(chat) })
  const a = await say(made[0])
  const b = await say(made[1])
  const again = await say(made[0])
  assert.equal(a.repeat, false)
  assert.equal(b.repeat, false)
  assert.deepStrictEqual(again, { ...a, repeat: true })
  // One message of the key in each chat, each the first of its chat.
  assert.deepStrictEqual(rows(file, "select chat, i from everchat_msg where sender_key = 'key-1' order by chat"), [{ chat: 1, i: 0 }, { chat: 2, i: 0 }])
  assert.equal(b.messages[0]!.i, 0)
})

test("a message with no key is logged each time", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  const sent = await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    const one = yield* turnsService.say("hello")
    yield* turnsService.idle
    const two = yield* turnsService.say("hello")
    yield* turnsService.idle
    return [one, two]
  }))
  assert.deepStrictEqual(sent.map((one) => [one.messages[0]!.i, one.repeat]), [[0, false], [2, false]])
  assert.notEqual(sent[0]!.accepted, sent[1]!.accepted)
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [["user", "hello"], ["asst", "Read."], ["user", "hello"], ["asst", "Read."]])
  assert.deepStrictEqual(rows(file, "select count(*) as n from everchat_msg where sender_key is not null"), [{ n: 0 }])
})

test("a message of more than one page with a key: `keyed` gives all its pages, and a repeat gives them back", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  const paste = Array.from({ length: 900 }, (_, n) => "line " + n + " " + "p".repeat(40)).join("\n") // two pages
  await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    const sent = yield* turnsService.say(paste, "key-1")
    yield* turnsService.idle
    assert.deepStrictEqual(sent.messages.map((message) => [message.i, message.more]), [[0, true], [1, false]])
    assert.equal(sent.messages.map((message) => message.text).join(""), paste)
    const keyed = yield* (yield* Store).keyed("key-1")
    assert.deepStrictEqual(keyed._tag === "Some" ? keyed.value : null, { messages: sent.messages, accepted: sent.accepted })
    assert.deepStrictEqual(yield* turnsService.say(paste, "key-1"), { ...sent, repeat: true })
  }))
  assert.deepStrictEqual(rows(file, "select i, sender_key from everchat_msg order by i"), [{ i: 0, sender_key: "key-1" }, { i: 1, sender_key: null }, { i: 2, sender_key: null }])
})

test("a key of another form is the store's to refuse: its error reaches the caller, and nothing is logged", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  const error = await withTurns(file, wire, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    return yield* Effect.flip(turnsService.say("hello", "a key"))
  }))
  assert.ok(error instanceof StoreError)
  assert.deepStrictEqual(counts(file), [{ msgs: 0, events: 0, turns: 0 }])
  assert.equal(wire.sent.length, 0)
})

// `say` refuses a key of another form before the store and the memory
// (lead, ec-p8n7o, 1): that say alone fails, and the memory goes on.
test("after a refused key of another form, a say with no key logs its message and gives its accepted; the refused say wrote nothing", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  const got = await withTurns(file, wire, noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    const refused = yield* Effect.flip(turnsService.say("hello", "a key"))
    const after = counts(file)
    const sent = yield* turnsService.say("hello again")
    const accepted = (yield* PubSub.takeUpTo(subscription, 10)).filter((event) => event.type === "accepted")
    yield* turnsService.idle
    return { refused, after, sent, accepted }
  })))
  assert.ok(got.refused instanceof StoreError)
  assert.equal(got.refused.op, "append")
  assert.equal(String(got.refused.cause), "Error: the sender's key is not 1 to 128 bytes of visible ASCII")
  assert.deepStrictEqual(got.after, [{ msgs: 0, events: 0, turns: 0 }])
  assert.equal(got.sent.repeat, false)
  assert.deepStrictEqual(got.sent.messages.map((message) => [message.i, message.text]), [[0, "hello again"]])
  assert.deepStrictEqual(got.accepted.map((event) => event.type === "accepted" ? [event.n, event.messages.map((message) => message.i)] : null), [[got.sent.accepted, [0]]])
  // Message 0 is the say's; the turn's reply follows it.
  assert.deepStrictEqual(rows(file, "select i, text, sender_key from everchat_msg where i = 0"), [{ i: 0, text: "hello again", sender_key: null }])
  assert.deepStrictEqual(rows(file, "select count(*) as n from everchat_msg where text = 'hello'"), [{ n: 0 }])
  assert.deepStrictEqual(rows(file, "select n, type from everchat_event where n = " + got.sent.accepted), [{ n: got.sent.accepted, type: "accepted" }])
})

test("a message that is interrupted while its log writes is logged, its `start` is published, and its turn runs to its end", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  // The person's message: once its log has committed, the step waits.
  const inside = Deferred.makeUnsafe<void>()
  const memory = Layer.effect(
    Memory,
    Memory.useSync((real) =>
      Memory.of({
        ...real,
        pushWith: (said, also, key, then) =>
          said[0]?.kind !== "user" ? real.pushWith(said, also, key, then) : real.pushWith(said, also, key, (written, more) =>
            Effect.gen(function*() {
              yield* Deferred.succeed(inside, undefined)
              yield* Effect.sleep("50 millis")
              if (then !== undefined) yield* then(written, more)
            }))
      }))
  )
  const seen = await withTurns(file, wire, noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    const fiber = yield* Effect.forkChild(turnsService.say("hello"))
    yield* Deferred.await(inside)
    yield* Fiber.interrupt(fiber)
    yield* eventually(() => turns(file)[0]?.status === "done")
    yield* turnsService.idle
    return yield* PubSub.takeAll(subscription)
  })), undefined, { memory })
  assert.deepStrictEqual(seen.map((event) => event.type), ["accepted", "start", "text", "message", "end"])
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [["user", "hello"], ["asst", "Read."]])
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }])
})

// The memory's lock (lead, ec-pqhgg, 3): a write through the memory waits
// for it, and that wait can be interrupted.

// Holds the memory's lock until `gate`: a note's write whose `then` waits
// (`then` runs under the lock). It returns once the lock is held.
const hold = (gate: Deferred.Deferred<void>) =>
  Effect.gen(function*() {
    const memory = yield* Memory
    const held = Deferred.makeUnsafe<void>()
    const fiber = yield* Effect.forkDetach(
      memory.pushWith([{ kind: "note", text: "held" }], () => Effect.void, null, () => Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(gate)))
    )
    yield* Deferred.await(held)
    return fiber
  })

test("a message cut while it waits for the memory's lock logs nothing and takes no event number, and the same key then logs it one time", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  const gate = Deferred.makeUnsafe<void>()
  const got = await withTurns(file, wire, noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    const holder = yield* hold(gate)
    const cut = yield* Effect.forkChild(turnsService.say("hello", "key-1"))
    // It reads its key, then waits for the memory's lock.
    yield* Effect.sleep("20 millis")
    const waits = cut.pollUnsafe() === undefined
    // The interruption is asked for, not awaited: the say has to end while
    // the lock is still held.
    yield* Effect.forkChild(Fiber.interrupt(cut))
    yield* eventually(() => cut.pollUnsafe() !== undefined)
    const exit = cut.pollUnsafe()
    const after = counts(file)
    const heard = yield* PubSub.remaining(subscription)
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.join(holder)
    const sent = yield* turnsService.say("hello", "key-1")
    yield* turnsService.idle
    return { waits, exit, after, heard, sent, later: yield* PubSub.takeAll(subscription) }
  }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))))
  assert.equal(got.waits, true)
  assert.ok(got.exit !== undefined && Exit.hasInterrupts(got.exit))
  // The held note alone: no message of the say, no event, no turn.
  assert.deepStrictEqual(got.after, [{ msgs: 1, events: 0, turns: 0 }])
  assert.equal(got.heard, 0)
  assert.equal(got.sent.repeat, false)
  assert.equal(got.sent.accepted, 1)
  assert.deepStrictEqual(rows(file, "select i, text, sender_key from everchat_msg where i < 2 order by i"), [
    { i: 0, text: "held", sender_key: null },
    { i: 1, text: "hello", sender_key: "key-1" }
  ])
  assert.deepStrictEqual(rows(file, "select count(*) as n from everchat_msg where text = 'hello'"), [{ n: 1 }])
  assert.deepStrictEqual(events(file).map((row) => [row.n, row.type]), [[1, "accepted"], [2, "start"], [3, "message"], [4, "end"]])
  assert.deepStrictEqual(events(file), reported(got.later))
  counted(file)
})

test("a turn cut while a log of it waits for the memory's lock leaves no row of that log, and its restart numbers its events with no hole and no number twice", async () => {
  const file = newFile()
  const gate = Deferred.makeUnsafe<void>()
  const go = Deferred.makeUnsafe<void>()
  // The model answers only once the test holds the memory's lock.
  const first = fakeWire((asked) => says(asked, "Hi."))
  const send = first.wire.send
  let asking = false
  first.wire.send = (asked) => Stream.unwrap(Effect.andThen(Effect.sync(() => (asking = true)), Effect.as(Deferred.await(go), send(asked))))
  // The memory's wrapper lets the lock go when its scope closes: after the
  // turn loop's (whose close interrupts the turn), before the memory's.
  let released = false
  const memory = Layer.effect(
    Memory,
    Effect.gen(function*() {
      const real = yield* Memory
      yield* Effect.addFinalizer(() => Effect.andThen(Effect.sync(() => (released = true)), Deferred.succeed(gate, undefined)))
      return real
    })
  )
  // If the close cannot end (the turn's wait cannot be cut), a watch lets
  // the lock go after 2 s, and the case fails.
  let stuck = false
  await withTurns(file, first, noPrograms, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("hello")
    yield* eventually(() => asking)
    yield* hold(gate)
    yield* Deferred.succeed(go, undefined)
    // The step's answer is in; its log waits for the memory's lock.
    yield* Effect.sleep("20 millis")
    yield* Effect.forkDetach(Effect.gen(function*() {
      for (let k = 0; k < 400 && !released; k++) yield* Effect.sleep("5 millis")
      if (!released) {
        stuck = true
        yield* Deferred.succeed(gate, undefined)
      }
    }))
  }), undefined, { memory })
  assert.equal(stuck, false)
  // No row of the step's log: no message, no event, no usage; the turn runs.
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [["user", "hello"], ["note", "held"]])
  assert.deepStrictEqual(events(file).map((row) => [row.n, row.type]), [[1, "accepted"], [2, "start"]])
  assert.deepStrictEqual(rows(file, "select count(*) as n from everchat_usage"), [{ n: 0 }])
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "running", why: null, first_msg: 0 }])
  assert.deepStrictEqual(items(file), ["user"])
  // The restart asks again and logs the step once.
  const again = fakeWire((asked) => says(asked, "Hi again."))
  await withTurns(file, again, noPrograms, Turns.use((turnsService) => turnsService.idle))
  assert.equal(again.sent.length, 1)
  assert.deepStrictEqual(messages(file).map((m) => [m.kind, m.text]), [["user", "hello"], ["note", "held"], ["asst", "Hi again."]])
  assert.deepStrictEqual(events(file).map((row) => [row.n, row.type]), [[1, "accepted"], [2, "start"], [3, "start"], [4, "message"], [5, "end"]])
  counted(file)
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }])
})

// `told` (lead, ec-fjqiq, ruling 5): the caller learns of each message that
// is in the log, also when it interrupts `say` in the step of its commit.
test("`told` gets the `Sent` of a say interrupted while its log writes, though its exit is an interruption; a say cut in its wait for the memory's lock does not call it; a repeat calls it with `repeat`", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Read."))
  // The person's message "hello": once its log has committed, the step waits.
  const inside = Deferred.makeUnsafe<void>()
  const memory = Layer.effect(
    Memory,
    Memory.useSync((real) =>
      Memory.of({
        ...real,
        pushWith: (said, also, key, then) =>
          said[0]?.kind !== "user" || said[0].text !== "hello" ? real.pushWith(said, also, key, then) : real.pushWith(said, also, key, (written, more) =>
            Effect.gen(function*() {
              yield* Deferred.succeed(inside, undefined)
              yield* Effect.sleep("50 millis")
              if (then !== undefined) yield* then(written, more)
            }))
      }))
  )
  const gate = Deferred.makeUnsafe<void>()
  const told: Array<{ readonly which: string; readonly sent: Sent }> = []
  const tell = (which: string) => (sent: Sent) => Effect.sync(() => told.push({ which, sent }))
  const got = await withTurns(file, wire, noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    // Interrupted while its log writes.
    const logging = yield* Effect.forkChild(turnsService.say("hello", "key-1", tell("logging")))
    yield* Deferred.await(inside)
    yield* Fiber.interrupt(logging)
    const interrupted = yield* Fiber.await(logging)
    yield* turnsService.idle
    const heard = (yield* PubSub.takeAll(subscription)).map((event) => event.type)
    // Cut in its wait for the memory's lock.
    const holder = yield* hold(gate)
    const waiting = yield* Effect.forkChild(turnsService.say("later", null, tell("waiting")))
    yield* Effect.sleep("20 millis")
    const waits = waiting.pollUnsafe() === undefined
    yield* Effect.forkChild(Fiber.interrupt(waiting))
    yield* eventually(() => waiting.pollUnsafe() !== undefined)
    const cut = waiting.pollUnsafe()
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.join(holder)
    // A repeat of the first key.
    const repeat = yield* turnsService.say("hello", "key-1", tell("repeat"))
    return { interrupted, heard, waits, cut, repeat }
  }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))), undefined, { memory })
  assert.ok(Exit.hasInterrupts(got.interrupted))
  assert.deepStrictEqual(got.heard, ["accepted", "start", "text", "message", "end"])
  assert.deepStrictEqual(turns(file), [{ id: 1, status: "done", why: null, first_msg: 0 }])
  assert.equal(got.waits, true)
  assert.ok(got.cut !== undefined && Exit.hasInterrupts(got.cut))
  assert.deepStrictEqual(rows(file, "select count(*) as n from everchat_msg where text = 'later'"), [{ n: 0 }])
  assert.deepStrictEqual(told.map(({ which, sent }) => [which, sent.messages.map((message) => [message.i, message.text]), sent.accepted, sent.repeat]), [
    ["logging", [[0, "hello"]], 1, false],
    ["repeat", [[0, "hello"]], 1, true]
  ])
  assert.equal(told[1]!.sent, got.repeat)
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
  // The note's `message`, then the `end`, in the transaction of the turn's end.
  assert.deepStrictEqual(events(file).map((row) => [row.n, row.type, row.turn, row.call, row.msg]), [
    [1, "accepted", null, null, 0],
    [2, "start", 1, null, null],
    [3, "call", 1, 1, null],
    [4, "message", null, null, 1],
    [5, "message", null, null, 2],
    [6, "message", null, null, 3],
    [7, "end", 1, null, null]
  ])
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

// Busy now, and the last work
// ---------------------------

test("busy is false when idle, true while a request waits and while a call runs, and false after the end; worked follows the clock", async () => {
  const file = newFile()
  const seen: Record<string, unknown> = {}
  let service: Turns["Service"] | null = null
  // Read while the loop waits for the request: the wire's answer runs then.
  const now = () => ({ busy: Effect.runSync(service!.busy), worked: Effect.runSync(service!.worked) })
  const wire = fakeWire((asked, n) => {
    seen["request " + n] = now()
    return n === 1 ? runs(asked, "call_1", "return 1") : says(asked, "Done.")
  })
  const run: Run = () =>
    Effect.gen(function*() {
      // The clock moves while the call runs: worked is the clock's now.
      yield* TestClock.adjust(5000)
      seen.call = now()
      return { output: "1", failed: false }
    })
  await withTurns(file, wire, run, Effect.gen(function*() {
    const turnsService = yield* Turns
    service = turnsService
    // The layer's start, with no work: the clock moves, worked does not.
    const start = yield* turnsService.worked
    yield* TestClock.adjust(60_000)
    assert.deepStrictEqual({ busy: yield* turnsService.busy, worked: yield* turnsService.worked }, { busy: false, worked: start })
    yield* turnsService.say("hello")
    yield* turnsService.idle
    assert.deepStrictEqual(seen, {
      "request 1": { busy: true, worked: start + 60_000 },
      call: { busy: true, worked: start + 65_000 },
      "request 2": { busy: true, worked: start + 65_000 }
    })
    // After the end: the end's time, also when the clock has moved by 7
    // minutes since.
    assert.deepStrictEqual({ busy: yield* turnsService.busy, worked: yield* turnsService.worked }, { busy: false, worked: start + 65_000 })
    yield* TestClock.adjust(7 * 60_000)
    assert.deepStrictEqual({ busy: yield* turnsService.busy, worked: yield* turnsService.worked }, { busy: false, worked: start + 65_000 })
  }), undefined, { clock: true })
})

// The hub's bound
// ---------------

// The types of what a subscriber that does not read holds after one turn
// that says one thing: 5 events in all.
const held = async (hub: number | undefined) => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Hi."))
  return withTurns(file, wire, noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    yield* turnsService.say("hello")
    // The turn ends: nothing waits for the subscriber.
    yield* turnsService.idle
    return (yield* PubSub.takeAll(subscription)).map((event) => event.type)
  })), undefined, hub === undefined ? {} : { hub })
}

test("a hub of capacity 4: a turn that publishes 5 events ends, and a subscriber that did not read gets the last 4", async () => {
  assert.deepStrictEqual(await held(4), ["start", "text", "message", "end"])
})

test("with no capacity, the hub keeps every event, as before", async () => {
  assert.deepStrictEqual(await held(undefined), ["accepted", "start", "text", "message", "end"])
})

test("a capacity of 0, 1.5, 65,537 or 2**31 is a defect of the layer, with a message; 1 and 65,536 are taken", async () => {
  for (const hub of [0, 1.5, 65_537, 2 ** 31]) {
    await assert.rejects(held(hub), (error: unknown) => {
      assert.ok(error instanceof RangeError, String(error))
      assert.equal(error.message, "The option `hub` of the turn loop must be a whole number from 1 to 65536, not " + String(hub) + ".")
      return true
    })
  }
  // Both ends of the range are taken (a bounded hub allocates its whole
  // capacity when it is made: 65,536 is about 1.5 MB).
  assert.deepStrictEqual(await held(1), ["end"])
  assert.deepStrictEqual(await held(65_536), ["accepted", "start", "text", "message", "end"])
})

// The why's bound
// ---------------

// A turn whose request fails with `message`: the turn's row's `why`, the
// `end` event's, and the note.
const failedWith = async (message: string) => {
  const file = newFile()
  const wire = fakeWire(() => wireError("input", { message }))
  const ends = await withTurns(file, wire, noPrograms, Effect.scoped(Effect.gen(function*() {
    const turnsService = yield* Turns
    const subscription = yield* turnsService.subscribe
    yield* turnsService.say("hello")
    yield* turnsService.idle
    return (yield* PubSub.takeAll(subscription)).flatMap((event) => (event.type === "end" ? [event.why] : []))
  })))
  const row = turns(file)[0] as { why: string }
  const note = messages(file).find((m) => m.kind === "note")?.text
  return { row: row.why, event: ends[0], ends: ends.length, note }
}

test("a vendor's error of 100,000 characters: the row, the end event and the note keep the same first 2,000", async () => {
  const got = await failedWith("w".repeat(100_000))
  const why = "w".repeat(WHY)
  assert.equal(WHY, 2000)
  assert.deepStrictEqual(got, { row: why, event: why, ends: 1, note: "No reply: " + why + ". Send a message to try again." })
})

test("a why with a pair of surrogates across the 2,000th place is cut before the pair: no lone half", async () => {
  // The pair is at 1,999 and 2,000 (from 0): its first half is the 2,000th character.
  const given = "a".repeat(WHY - 1) + "😀" + "b".repeat(10)
  const got = await failedWith(given)
  assert.equal(got.row, "a".repeat(WHY - 1))
  assert.equal(got.event, got.row)
  assert.ok(got.row.isWellFormed())
  // The pair one place earlier fits whole.
  assert.equal(whyOf("a".repeat(WHY - 2) + "😀" + "b"), "a".repeat(WHY - 2) + "😀")
  // A lone half is made well formed first, then cut.
  assert.equal(whyOf("a".repeat(WHY - 1) + "\ud83d" + "b"), "a".repeat(WHY - 1) + "\ufffd")
})

test("a why of 2,000 characters or fewer does not change", async () => {
  const exact = "x".repeat(WHY)
  assert.equal(whyOf(exact), exact)
  assert.equal(whyOf("short"), "short")
  const got = await failedWith("OpenAI answered 400: Too much input.")
  assert.deepStrictEqual({ row: got.row, event: got.event }, { row: "OpenAI answered 400: Too much input.", event: "OpenAI answered 400: Too much input." })
})
