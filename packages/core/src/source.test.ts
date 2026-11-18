// Tests of the seam of a message from outside a turn (turn.ts, `Source`,
// `Offer`, `Turns.ready`), with the tests' fake wire, a fake sandbox and a
// source that the test controls: an offer waits until the chat is idle and
// starts a turn of its own; it never steers a turn that runs.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, PubSub, Scope, Stream } from "effect"
import * as path from "node:path"
import { compactor, fakeWire, newFile, options, reply, rows, wireError } from "@everchat/local/testing"
import { Approvals } from "./approval.ts"
import { pending } from "./functions.ts"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import { head } from "./head.ts"
import { Memory } from "./memory.ts"
import type { Item, Reply, Request } from "./request.ts"
import { storeLayer } from "@everchat/sqlite/bun"
import { type Kind, Store, StoreError } from "./store.ts"
import { limitLayer } from "@everchat/local/limitfile"
import type { Limit } from "./limit.ts"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { Sandbox } from "./sandbox.ts"
import { CEILING, HEAD, HEADS, LATE, type Offer, Source, type TurnEvent, Turns, WAKE } from "./turn.ts"

type Run = (program: string) => Effect.Effect<{ output: string; failed: boolean }>

// A source that the test controls: `pending` is what its next `next`
// gives (then it is gone, with its ceiling, if any), `asked` counts the
// asks, `wrote` holds what each write saw. Its write keeps "fired <page> turn <turn>" as the chat's goal,
// a row of its own in the offer's transaction, then fails when `fail`.
const fakeSource = () => {
  const state = {
    pending: null as { readonly kind: Kind; readonly text: string; readonly ceiling?: Offer["ceiling"] } | null,
    asked: 0,
    wrote: [] as Array<{ first: number; kind: Kind; turn: number; firstMsg: number }>,
    fail: false
  }
  const layer = Layer.effect(
    Source,
    Effect.gen(function*() {
      const store = yield* Store
      return Source.of({
        next: Effect.sync(() => {
          state.asked += 1
          const given = state.pending
          state.pending = null
          return given === null ? null : {
            ...given,
            write: (first, turn) =>
              Effect.gen(function*() {
                yield* store.setGoal(`fired ${first.i} turn ${turn.id}`)
                state.wrote.push({ first: first.i, kind: first.kind, turn: turn.id, firstMsg: turn.firstMsg })
                if (state.fail) {
                  return yield* new StoreError({ op: "late", cause: new Error("the source's row failed") })
                }
              })
          }
        })
      })
    })
  )
  return { state, layer }
}

// A sandbox whose program waits for `gate`; `started` is done when one runs.
const gatedSandbox = () => {
  const started = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  const run: Run = () => Effect.gen(function*() {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(gate)
    return { output: "ran", failed: false }
  })
  return { started, gate, run }
}

// One launch: as turn.test.ts's `withTurns`, with `source` (or none).
// `over.ask` runs before the n-th request of a turn goes to the wire;
// `over.store` puts a wrapper over the store.
const withSource = <A, E>(
  file: string,
  wire: ReturnType<typeof fakeWire>,
  run: Run,
  source: ReturnType<typeof fakeSource> | null,
  effect: Effect.Effect<A, E, Turns | Memory | Store>,
  over: { readonly ask?: (n: number) => Effect.Effect<void>; readonly store?: Layer.Layer<Store, never, Store> } = {}
) => {
  const real = storeLayer(file, options())
  const store = over.store === undefined ? real : over.store.pipe(Layer.provide(real))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const base = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const hook = over.ask
  const asking = hook === undefined ? base : Layer.effect(
    Ask,
    Effect.gen(function*() {
      const ask = yield* Ask
      let n = 0
      return Ask.of({ ...ask, stream: (request, how) => Stream.unwrap(Effect.as(Effect.suspend(() => hook(++n)), ask.stream(request, how))) })
    })
  ).pipe(Layer.provide(base))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ head: head(DECLARATIONS) }).pipe(
    Layer.provide(source === null ? Layer.empty : source.layer),
    Layer.provideMerge(memory),
    Layer.provide(Layer.mergeAll(asking, sandbox, limit))
  )
  return Effect.runPromise(effect.pipe(Effect.provide(turns), Effect.provideService(AskDelay, () => Effect.succeed(0))))
}

const noPrograms: Run = () => Effect.die("no program was expected")

const runs = (asked: Request, id: string, program: string, over: Partial<Reply> = {}): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }],
    ...over
  })

const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

const lastText = (item: Item | undefined) => (item?.kind === "user" ? item.blocks[item.blocks.length - 1] : undefined)

const messages = (file: string) =>
  rows<{ i: number; kind: string; turn: number | null }>(file, "select i, kind, turn from everchat_msg_read order by i").map((row) => `${row.i} ${row.kind} ${row.turn ?? "-"}`)
const turnRows = (file: string) => rows(file, "select n as id, status, first_msg from everchat_turn order by n")
const events = (file: string) =>
  rows<{ type: string; msg: number | null }>(file, "select type, msg from everchat_event order by n").map((row) => row.type + (row.msg === null ? "" : " " + row.msg))
const chat = (file: string) => rows<{ goal: string | null; taken: number }>(file, "select goal, taken from everchat_chat")[0]

test("the kinds of a turn's first item: user and work under HEAD, late under LATE, wake under WAKE", () => {
  assert.deepStrictEqual(HEADS, { user: HEAD, work: HEAD, late: LATE, wake: WAKE })
  assert.equal(LATE, "Turn: a call that waited for approval has run:\n\n")
  assert.equal(WAKE, "Turn: a wake-up fired:\n\n")
})

test("an offer while turn A runs, and a person's message that steers A: the offer is logged only after A's end, and starts turn B, whose first item is one block that starts with LATE; the source's write saw the message's first page and turn B, in the same transaction", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : n === 2 ? says(asked, "A is done.") : says(asked, "B is done.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("do it")
    yield* Deferred.await(sandbox.started)
    source.state.pending = { kind: "late", text: "send gave: ok" }
    // A runs: `ready` does nothing, and does not ask.
    yield* turns.ready
    assert.deepStrictEqual(messages(file), ["0 user -"])
    assert.equal(source.state.asked, 0)
    // The person's message steers A.
    yield* turns.say("and also that")
    yield* Deferred.succeed(sandbox.gate, undefined)
    yield* turns.idle
  }))
  assert.deepStrictEqual(messages(file), ["0 user -", "1 user -", "2 tool 1", "3 echo 1", "4 asst 1", "5 late -", "6 asst 2"])
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "done", first_msg: 0 }, { id: 2, status: "done", first_msg: 5 }])
  // A's second request has the steer; B's first is one item, its last block
  // the offer's message under LATE.
  assert.equal(wire.sent.length, 3)
  assert.deepStrictEqual(wire.sent[1]!.items.map((one) => one.kind), ["user", "turn", "back", "user"])
  assert.equal(wire.sent[2]!.items.length, 1)
  assert.deepStrictEqual(lastText(wire.sent[2]!.items[0]), { text: LATE + "send gave: ok", mark: true })
  // The write, in the transaction of the message and the turn.
  assert.deepStrictEqual(source.state.wrote, [{ first: 5, kind: "late", turn: 2, firstMsg: 5 }])
  assert.deepStrictEqual(chat(file), { goal: "fired 5 turn 2", taken: 5 })
  assert.deepStrictEqual(events(file), [
    "accepted 0",
    "start",
    "call",
    "accepted 1",
    "message 2",
    "message 3",
    "message 4",
    "end",
    "message 5",
    "start",
    "message 6",
    "end"
  ])
  // Asked at A's end (the offer) and at B's end (nothing).
  assert.equal(source.state.asked, 2)
})

test("an idle chat: ready with an offer logs it and starts its turn at once; ready with none does nothing; ready while a turn runs does nothing, and that turn's end takes the offer", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const wire = fakeWire((asked, n) => (n === 1 ? says(asked, "Seen.") : n === 2 ? runs(asked, "t1", "the program") : n === 3 ? says(asked, "Gone.") : says(asked, "Late seen.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "late", text: "the first result" }
    yield* turns.ready
    // Logged, and its turn in the log, when `ready` returns.
    assert.deepStrictEqual(messages(file), ["0 late -"])
    assert.deepStrictEqual(turnRows(file).map((row) => [row.id, row.first_msg]), [[1, 0]])
    yield* turns.idle
    assert.deepStrictEqual(lastText(wire.sent[0]!.items[0]), { text: LATE + "the first result", mark: true })
    // Nothing offered: nothing.
    yield* turns.ready
    assert.equal(source.state.asked, 3)
    assert.deepStrictEqual(messages(file), ["0 late -", "1 asst 1"])
    assert.equal(turnRows(file).length, 1)
    // While a turn runs: nothing, and no ask.
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    source.state.pending = { kind: "late", text: "the second result" }
    yield* turns.ready
    assert.equal(source.state.asked, 3)
    assert.deepStrictEqual(messages(file), ["0 late -", "1 asst 1", "2 user -"])
    yield* Deferred.succeed(sandbox.gate, undefined)
    yield* turns.idle
  }))
  assert.deepStrictEqual(messages(file), ["0 late -", "1 asst 1", "2 user -", "3 tool 2", "4 echo 2", "5 asst 2", "6 late -", "7 asst 3"])
  assert.deepStrictEqual(turnRows(file), [
    { id: 1, status: "done", first_msg: 0 },
    { id: 2, status: "done", first_msg: 2 },
    { id: 3, status: "done", first_msg: 6 }
  ])
  assert.deepStrictEqual(lastText(wire.sent[3]!.items[0]), { text: LATE + "the second result", mark: true })
  assert.deepStrictEqual(source.state.wrote.map((one) => [one.first, one.turn]), [[0, 1], [6, 3]])
})

// A store whose `runningTurns`, once armed, waits at its next call until
// the case lets it go: in a stop's end (turn.ts, `drive`), between the stop
// and the write of the stopped turn's end. `held` is done when it waits.
const heldEnd = () => {
  const state = { armed: false }
  const held = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const layer = Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({
        ...real,
        runningTurns: (agent) =>
          Effect.gen(function*() {
            if (state.armed) {
              state.armed = false
              yield* Deferred.succeed(held, undefined)
              yield* Deferred.await(release)
            }
            return yield* real.runningTurns(agent)
          })
      })
    })
  )
  return { state, held, release, layer }
}

test("ready while a stopped turn's end is not yet written: the source is not asked, no message and no turn are written, and busy is true; the stop's end comes with no start after it; then ready starts exactly one turn, whose start comes after that end", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const held = heldEnd()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Late seen.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    held.state.armed = true
    const stopping = yield* Effect.forkChild(turns.stop())
    yield* Deferred.await(held.held)
    // The stop's end waits: its turn is still running in the log.
    const before = { messages: messages(file), turns: turnRows(file), events: events(file) }
    assert.deepStrictEqual(before.turns, [{ id: 1, status: "running", first_msg: 0 }])
    source.state.pending = { kind: "late", text: "a result" }
    yield* turns.ready
    assert.equal(source.state.asked, 0)
    assert.notEqual(source.state.pending, null)
    assert.deepStrictEqual({ messages: messages(file), turns: turnRows(file), events: events(file) }, before)
    assert.equal(yield* turns.busy, true)
    yield* Deferred.succeed(held.release, undefined)
    yield* Fiber.join(stopping)
    // The stop's note and the end, and no start after them.
    assert.deepStrictEqual(events(file).slice(before.events.length), ["message 3", "end"])
    assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }])
    assert.equal(yield* turns.busy, false)
    assert.equal(source.state.asked, 0)
    // Then ready: one turn. Its end asks the source again, which has
    // nothing more.
    yield* turns.ready
    yield* turns.idle
    assert.equal(source.state.asked, 2)
    // A failed assertion lets the stop's end go too, so the launch can end.
  }).pipe(Effect.ensuring(Deferred.succeed(held.release, undefined))), { store: held.layer })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "done", first_msg: 4 }])
  const all = events(file)
  const starts = all.flatMap((one, k) => (one === "start" ? [k] : []))
  const ends = all.flatMap((one, k) => (one === "end" ? [k] : []))
  assert.equal(starts.length, 2)
  assert.ok(ends[0]! < starts[1]!, all.join(", "))
  assert.deepStrictEqual(all, ["accepted 0", "start", "call", "message 1", "message 2", "message 3", "end", "message 4", "start", "message 5", "end"])
  assert.deepStrictEqual(source.state.wrote.map((one) => [one.first, one.turn]), [[4, 2]])
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: LATE + "a result", mark: true })
})

test("ready after a stop that has ended starts exactly one turn; the stop itself takes no offer", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Late seen.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    source.state.pending = { kind: "late", text: "a result" }
    yield* turns.stop()
    assert.equal(source.state.asked, 0)
    assert.deepStrictEqual(turnRows(file).map((row) => row.status), ["stopped"])
    // One turn; its end asks the source again, which has nothing more.
    yield* turns.ready
    yield* turns.idle
    assert.equal(source.state.asked, 2)
  }))
  assert.deepStrictEqual(turnRows(file).map((row) => [row.id, row.status]), [[1, "stopped"], [2, "done"]])
  assert.deepStrictEqual(source.state.wrote.map((one) => one.turn), [2])
})

// A store whose `runningTurns` fails `state.reads` more times, and whose
// `endTurn` fails `state.ends` more times, each with a StoreError; armed by
// the case after the launch's own reads.
const failing = () => {
  const state = { reads: 0, ends: 0 }
  const layer = Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({
        ...real,
        runningTurns: (agent) =>
          Effect.suspend(() => {
            if (state.reads > 0) {
              state.reads -= 1
              return Effect.fail(new StoreError({ op: "runningTurns", cause: new Error("the read failed") }))
            }
            return real.runningTurns(agent)
          }),
        endTurn: (id, status, why) =>
          Effect.suspend(() => {
            if (state.ends > 0) {
              state.ends -= 1
              return Effect.fail(new StoreError({ op: "endTurn", cause: new Error("the write failed") }))
            }
            return real.endTurn(id, status, why)
          })
      })
    })
  )
  return { state, layer }
}

// The ask of the turn's second request waits for `gate`; `reached` is done
// when it waits.
const heldSecond = () => {
  const reached = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  return { reached, gate, ask: (n: number) => (n === 2 ? Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(gate)) : Effect.void) }
}

test("the stop's read of the running turn fails: busy is false and turn 1 still runs; ready writes turn 1's stop note and end, then the offer's message and start: one turn running, the source asked once", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const store = failing()
  const second = heldSecond()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Late seen.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    store.state.reads = 1
    yield* turns.stop("Stopped by the test.")
    assert.equal(store.state.reads, 0)
    assert.equal(yield* turns.busy, false)
    assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "running", first_msg: 0 }])
    // The cut program's tool and echo, and no stop note and no end.
    assert.deepStrictEqual(events(file), ["accepted 0", "start", "call", "message 1", "message 2"])
    source.state.pending = { kind: "late", text: "a result" }
    yield* turns.ready
    yield* Deferred.await(second.reached)
    // The end before the offer's message and start; one turn runs.
    assert.deepStrictEqual(events(file), ["accepted 0", "start", "call", "message 1", "message 2", "message 3", "end", "message 4", "start"])
    assert.deepStrictEqual(messages(file), ["0 user -", "1 tool 1", "2 echo 1", "3 note 1", "4 late -"])
    assert.equal(rows<{ text: string }>(file, "select text from everchat_msg_read where i = 3")[0]!.text, "Stopped by the test.")
    assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "running", first_msg: 4 }])
    assert.equal(source.state.asked, 1)
    yield* Deferred.succeed(second.gate, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(second.gate, undefined))), { store: store.layer, ask: second.ask })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "done", first_msg: 4 }])
  assert.deepStrictEqual(source.state.wrote.map((one) => [one.first, one.turn]), [[4, 2]])
})

test("the read fails at the stop and again at ready: ready fails with the StoreError, the source is not asked, nothing is written; a later ready whose read passes writes the end, then the offer's turn", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const store = failing()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Late seen.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    store.state.reads = 1
    yield* turns.stop()
    const before = { messages: messages(file), turns: turnRows(file), events: events(file) }
    assert.deepStrictEqual(before.turns, [{ id: 1, status: "running", first_msg: 0 }])
    source.state.pending = { kind: "late", text: "a result" }
    store.state.reads = 1
    const failed = yield* Effect.exit(turns.ready)
    assert.ok(Exit.isFailure(failed))
    const error = Cause.squash(failed.cause)
    assert.ok(error instanceof StoreError)
    assert.equal(error.op, "runningTurns")
    assert.equal(source.state.asked, 0)
    assert.notEqual(source.state.pending, null)
    assert.deepStrictEqual({ messages: messages(file), turns: turnRows(file), events: events(file) }, before)
    // The read passes: the end, then the offer's turn.
    yield* turns.ready
    yield* turns.idle
    assert.equal(source.state.asked, 2)
  }), { store: store.layer })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "done", first_msg: 4 }])
  assert.deepStrictEqual(events(file), ["accepted 0", "start", "call", "message 1", "message 2", "message 3", "end", "message 4", "start", "message 5", "end"])
})

test("the stopped end's write fails at the stop: a ready after it starts no turn and does not ask the source", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const store = failing()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Late seen.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    store.state.ends = 1
    yield* turns.stop()
    assert.equal(store.state.ends, 0)
    assert.equal(yield* turns.busy, false)
    const before = { messages: messages(file), turns: turnRows(file), events: events(file) }
    assert.deepStrictEqual(before.turns, [{ id: 1, status: "running", first_msg: 0 }])
    source.state.pending = { kind: "late", text: "a result" }
    // The memory is stopped for the launch: the end's write fails again.
    const failed = yield* Effect.exit(turns.ready)
    assert.ok(Exit.isFailure(failed))
    assert.equal(source.state.asked, 0)
    assert.notEqual(source.state.pending, null)
    assert.deepStrictEqual({ messages: messages(file), turns: turnRows(file), events: events(file) }, before)
  }), { store: store.layer })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "running", first_msg: 0 }])
})

test("after a failed turn with no waiting message the offer starts a turn", async () => {
  const file = newFile()
  const source = fakeSource()
  const wire = fakeWire((asked, n) => (n === 1 ? wireError("input") : says(asked, "Late seen.")))
  await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "late", text: "a result" }
    yield* turns.say("hello")
    yield* turns.idle
  }))
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "failed", first_msg: 0 }, { id: 2, status: "done", first_msg: 2 }])
  assert.deepStrictEqual(messages(file), ["0 user -", "1 note 1", "2 late -", "3 asst 2"])
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: LATE + "a result", mark: true })
})

// A turn that fails at its first request, while the person's second
// message waits for it (its request has not come back, so no step takes
// it in); `offered` is what the source has then. `then` runs after the
// chat is idle, in the same launch.
const failedWithWaiting = async (
  offered: { readonly kind: Kind; readonly text: string } | null,
  person: string,
  then: (turns: Turns["Service"], source: ReturnType<typeof fakeSource>, file: string) => Effect.Effect<void, StoreError> = () => Effect.void
) => {
  const file = newFile()
  const source = fakeSource()
  const reached = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  const wire = fakeWire((asked, n) => (n === 1 ? wireError("input") : says(asked, "Seen.")))
  const ask = (n: number) => (n === 1 ? Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(gate)) : Effect.void)
  await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("hello")
    yield* Deferred.await(reached)
    source.state.pending = offered
    yield* turns.say(person)
    yield* Deferred.succeed(gate, undefined)
    yield* turns.idle
    yield* then(turns, source, file)
  }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined))), { ask })
  return { file, source, wire }
}

test("after a failed turn with a waiting message of the person the source is asked, and its offer starts a turn whose first item takes that message: one block under LATE, the person's message first as user: <text>", async () => {
  const { file, source, wire } = await failedWithWaiting({ kind: "late", text: "a result" }, "are you there?")
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "failed", first_msg: 0 }, { id: 2, status: "done", first_msg: 3 }])
  assert.deepStrictEqual(messages(file), ["0 user -", "1 user -", "2 note 1", "3 late -", "4 asst 2"])
  // Asked at turn 1's end (the offer) and at turn 2's end (nothing).
  assert.equal(source.state.asked, 2)
  assert.deepStrictEqual(source.state.wrote, [{ first: 3, kind: "late", turn: 2, firstMsg: 3 }])
  assert.equal(wire.sent.length, 2)
  assert.equal(wire.sent[1]!.items.length, 1)
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: LATE + "user: are you there?\n\na result", mark: true })
  assert.equal(chat(file)!.taken, 3)
})

test("the same with a wake-up's offer: one block under WAKE, the person's message first as user: <text>, then the fire's text", async () => {
  const fired = "[3] due 2026-11-16 09:00 Europe/Berlin, 4 min late: Read my mail and give me the plan."
  const { file, source, wire } = await failedWithWaiting({ kind: "wake", text: fired }, "Are you there?")
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "failed", first_msg: 0 }, { id: 2, status: "done", first_msg: 3 }])
  assert.deepStrictEqual(messages(file), ["0 user -", "1 user -", "2 note 1", "3 wake -", "4 asst 2"])
  assert.equal(source.state.asked, 2)
  assert.deepStrictEqual(source.state.wrote, [{ first: 3, kind: "wake", turn: 2, firstMsg: 3 }])
  assert.equal(wire.sent.length, 2)
  assert.equal(wire.sent[1]!.items.length, 1)
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), {
    text: "Turn: a wake-up fired:\n\nuser: Are you there?\n\n[3] due 2026-11-16 09:00 Europe/Berlin, 4 min late: Read my mail and give me the plan.",
    mark: true
  })
  assert.equal(chat(file)!.taken, 3)
})

test("after a failed turn with a waiting message of the person and nothing offered the row rests; a later ready's offer starts a turn whose first item takes that message", async () => {
  const { file, source, wire } = await failedWithWaiting(null, "are you there?", (turns, source, file) =>
    Effect.gen(function*() {
      // The row rests: one failed turn, the source asked once, no request.
      assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "failed", first_msg: 0 }])
      assert.deepStrictEqual(messages(file), ["0 user -", "1 user -", "2 note 1"])
      assert.equal(source.state.asked, 1)
      assert.equal(yield* turns.busy, false)
      source.state.pending = { kind: "late", text: "a result" }
      yield* turns.ready
      yield* turns.idle
    }))
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "failed", first_msg: 0 }, { id: 2, status: "done", first_msg: 3 }])
  assert.deepStrictEqual(messages(file), ["0 user -", "1 user -", "2 note 1", "3 late -", "4 asst 2"])
  // Asked at turn 1's end (nothing), at ready (the offer), at turn 2's end.
  assert.equal(source.state.asked, 3)
  assert.equal(wire.sent.length, 2)
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: LATE + "user: are you there?\n\na result", mark: true })
})

// A store whose `messagesAfter` of the waiting kinds (`user`, `work`) runs
// `late.say` the first time that it finds none: in a turn's last steer, so
// that the message comes too late for that turn.
const tooLate = (late: { say: Effect.Effect<unknown, unknown> | null }) =>
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
            if (say !== null && found.length === 0 && kinds.join() === "user,work") {
              late.say = null
              yield* Effect.orDie(say)
            }
            return found
          })
      })
    })
  )

test("after a done turn a message of the person that came too late starts its own turn first, and the source is not asked until that turn's end", async () => {
  const file = newFile()
  const source = fakeSource()
  const late: { say: Effect.Effect<unknown, unknown> | null } = { say: null }
  let askedAtSecond = -1
  const wire = fakeWire((asked, n) => {
    if (n === 2) askedAtSecond = source.state.asked
    return says(asked, "Reply " + n + ".")
  })
  await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "late", text: "a result" }
    late.say = turns.say("and now?")
    yield* turns.say("hello")
    yield* turns.idle
  }), { store: tooLate(late) })
  assert.equal(late.say, null)
  assert.deepStrictEqual(turnRows(file), [
    { id: 1, status: "done", first_msg: 0 },
    { id: 2, status: "done", first_msg: 2 },
    { id: 3, status: "done", first_msg: 4 }
  ])
  assert.deepStrictEqual(messages(file), ["0 user -", "1 asst 1", "2 user -", "3 asst 2", "4 late -", "5 asst 3"])
  // Not asked at turn 1's end; asked at turn 2's end (the offer) and at turn 3's.
  assert.equal(askedAtSecond, 0)
  assert.equal(source.state.asked, 2)
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: HEAD + "and now?", mark: true })
  assert.deepStrictEqual(lastText(wire.sent[2]!.items[0]), { text: LATE + "a result", mark: true })
})

test("a wake message in the log with no turn of its own (as after a stop before its first item) does not steer a turn that runs and starts no turn; the next turn's first item takes it as wake: <text>", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Reply " + n + ".")))
  const fired = "[1] due 2026-11-16 09:00 Europe/Berlin: Water the plants."
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    const memory = yield* Memory
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    yield* memory.push([{ kind: "wake", text: fired }])
    yield* Deferred.succeed(sandbox.gate, undefined)
    yield* turns.idle
    // Turn 1's second request has no steer, and no turn started for it.
    assert.deepStrictEqual(wire.sent[1]!.items.map((one) => one.kind), ["user", "turn", "back"])
    assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "done", first_msg: 0 }])
    assert.equal(chat(file)!.taken, 0)
    yield* turns.say("hi")
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(sandbox.gate, undefined))))
  assert.deepStrictEqual(messages(file), ["0 user -", "1 wake -", "2 tool 1", "3 echo 1", "4 asst 1", "5 user -", "6 asst 2"])
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "done", first_msg: 0 }, { id: 2, status: "done", first_msg: 5 }])
  assert.equal(wire.sent.length, 3)
  assert.deepStrictEqual(lastText(wire.sent[2]!.items[0]), { text: HEAD + "wake: " + fired + "\n\nhi", mark: true })
})

test("a person's message that comes after the offer's message and before the first item is built is in the same block, as user: <text>", async () => {
  const file = newFile()
  const source = fakeSource()
  const reached = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  const wire = fakeWire((asked) => says(asked, "Both seen."))
  // The turn's run reads its items first: it waits there, before its first
  // item is built.
  const store = Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({ ...real, turnItems: (turn) => Effect.andThen(Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(gate)), real.turnItems(turn)) })
    })
  )
  await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "late", text: "a result" }
    yield* turns.ready
    yield* Deferred.await(reached)
    yield* turns.say("and this too")
    yield* Deferred.succeed(gate, undefined)
    yield* turns.idle
  }), { store })
  assert.deepStrictEqual(messages(file), ["0 late -", "1 user -", "2 asst 1"])
  assert.equal(wire.sent.length, 1)
  assert.deepStrictEqual(lastText(wire.sent[0]!.items[0]), { text: LATE + "a result\n\nuser: and this too", mark: true })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "done", first_msg: 0 }])
  assert.equal(chat(file)!.taken, 1)
})

test("a fault in the source's write: no message, no turn, taken and the events as before, and the memory is stopped for the launch", async () => {
  const file = newFile()
  const source = fakeSource()
  const wire = fakeWire((asked) => says(asked, "never"))
  await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "late", text: "a result" }
    source.state.fail = true
    const ready = yield* Effect.exit(turns.ready)
    assert.equal(Exit.isFailure(ready) ? (Cause.squash(ready.cause) as StoreError).op : "it did not fail", "late")
    // The write ran, and its transaction was undone.
    assert.equal(source.state.wrote.length, 1)
    assert.deepStrictEqual(messages(file), [])
    assert.deepStrictEqual(turnRows(file), [])
    assert.deepStrictEqual(chat(file), { goal: null, taken: -1 })
    assert.deepStrictEqual(events(file), [])
    // The memory stopped: the person's next message fails with that error.
    const said = yield* Effect.exit(turns.say("hello"))
    assert.equal(Exit.isFailure(said) ? (Cause.squash(said.cause) as StoreError).op : "it did not fail", "late")
  }))
  assert.deepStrictEqual(messages(file), [])
  assert.equal(wire.sent.length, 0)
})

test("an offer of a kind that no source may offer (user, work, asst) is a defect, and writes nothing", async () => {
  for (const kind of ["user", "work", "asst"] as const) {
    const file = newFile()
    const source = fakeSource()
    const wire = fakeWire((asked) => says(asked, "never"))
    await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
      const turns = yield* Turns
      source.state.pending = { kind, text: "a message" }
      const ready = yield* Effect.exit(turns.ready)
      assert.equal(Exit.isFailure(ready) && Cause.hasDies(ready.cause), true, kind)
    }))
    assert.deepStrictEqual(messages(file), [])
    assert.deepStrictEqual(turnRows(file), [])
  }
})

test("no source: ready does nothing, before and after a turn", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => says(asked, "Hello."))
  await withSource(file, wire, noPrograms, null, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.ready
    assert.deepStrictEqual(messages(file), [])
    yield* turns.say("hi")
    yield* turns.idle
    yield* turns.ready
  }))
  assert.deepStrictEqual(messages(file), ["0 user -", "1 asst 1"])
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "done", first_msg: 0 }])
  assert.equal(wire.sent.length, 1)
})

// A person's message and `idle` in the gap of a stopped turn's end (turn.ts,
// `say`, `idle`): they wait for that end.

// A store that pushes "endTurn <status>" to `marks` when a turn's end is
// written.
const markedEnds = (marks: Array<string>): Layer.Layer<Store, never, Store> =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({ ...real, endTurn: (id, status, why) => Effect.tap(real.endTurn(id, status, why), () => Effect.sync(() => marks.push("endTurn " + status))) })
    })
  )

test("say while a stopped turn's end is held: nothing of it is written and busy is true; when the end is let go, the stop's note and end come, then the message's accepted and the new turn's start; one turn runs, and told ran once", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const held = heldEnd()
  const second = heldSecond()
  const told: Array<number> = []
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Seen.")))
  await withSource(file, wire, sandbox.run, null, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    held.state.armed = true
    const stopping = yield* Effect.forkChild(turns.stop())
    yield* Deferred.await(held.held)
    const before = { messages: messages(file), turns: turnRows(file), events: events(file) }
    assert.deepStrictEqual(before.turns, [{ id: 1, status: "running", first_msg: 0 }])
    // It runs at once, until it waits.
    const saying = yield* Effect.forkChild(turns.say("next", null, (sent) => Effect.sync(() => told.push(sent.accepted))), { startImmediately: true })
    assert.deepStrictEqual({ messages: messages(file), turns: turnRows(file), events: events(file) }, before)
    assert.equal(yield* turns.busy, true)
    assert.deepStrictEqual(told, [])
    yield* Deferred.succeed(held.release, undefined)
    yield* Fiber.join(stopping)
    const sent = yield* Fiber.join(saying)
    yield* Deferred.await(second.reached)
    assert.deepStrictEqual(events(file).slice(before.events.length), ["message 3", "end", "accepted 4", "start"])
    assert.deepStrictEqual(messages(file), ["0 user -", "1 tool 1", "2 echo 1", "3 note 1", "4 user -"])
    assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "running", first_msg: 4 }])
    assert.deepStrictEqual(told, [sent.accepted])
    yield* Deferred.succeed(second.gate, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(Effect.andThen(Deferred.succeed(held.release, undefined), Deferred.succeed(second.gate, undefined)))), { store: held.layer, ask: second.ask })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "done", first_msg: 4 }])
  assert.deepStrictEqual(told.length, 1)
})

test("idle asked while a stopped turn's end is held ends after that end is written", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const held = heldEnd()
  const marks: Array<string> = []
  const wire = fakeWire((asked) => runs(asked, "t1", "the program"))
  await withSource(file, wire, sandbox.run, null, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    held.state.armed = true
    const stopping = yield* Effect.forkChild(turns.stop())
    yield* Deferred.await(held.held)
    // It runs at once, until it waits.
    const idling = yield* Effect.forkChild(Effect.andThen(turns.idle, Effect.sync(() => marks.push("idle"))), { startImmediately: true })
    marks.push("release")
    yield* Deferred.succeed(held.release, undefined)
    yield* Fiber.join(stopping)
    yield* Fiber.join(idling)
    assert.equal(yield* turns.busy, false)
  }).pipe(Effect.ensuring(Deferred.succeed(held.release, undefined))), { store: markedEnds(marks).pipe(Layer.provide(held.layer)) })
  assert.deepStrictEqual(marks, ["release", "endTurn stopped", "idle"])
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }])
})

test("a say cut while it waits for a stopped turn's end writes nothing, and told does not run; a later say starts one turn", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const held = heldEnd()
  let told = 0
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Seen.")))
  await withSource(file, wire, sandbox.run, null, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    held.state.armed = true
    const stopping = yield* Effect.forkChild(turns.stop())
    yield* Deferred.await(held.held)
    const before = events(file)
    // It runs at once, until it waits; then it is cut.
    const saying = yield* Effect.forkChild(turns.say("cut", null, () => Effect.sync(() => (told += 1))), { startImmediately: true })
    const cut = yield* Fiber.interrupt(saying).pipe(Effect.andThen(Fiber.await(saying)))
    assert.ok(Exit.hasInterrupts(cut))
    yield* Deferred.succeed(held.release, undefined)
    yield* Fiber.join(stopping)
    assert.deepStrictEqual(events(file).slice(before.length), ["message 3", "end"])
    assert.deepStrictEqual(messages(file), ["0 user -", "1 tool 1", "2 echo 1", "3 note 1"])
    yield* turns.say("again")
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(held.release, undefined))), { store: held.layer })
  assert.equal(told, 0)
  assert.deepStrictEqual(messages(file), ["0 user -", "1 tool 1", "2 echo 1", "3 note 1", "4 user -", "5 asst 2"])
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "done", first_msg: 4 }])
  assert.deepStrictEqual(events(file), ["accepted 0", "start", "call", "message 1", "message 2", "message 3", "end", "accepted 4", "start", "message 5", "end"])
})

test("the stop's read of the running turn fails: a say whose read fails again fails with the StoreError and writes nothing; a say whose read passes writes turn 1's stop note and end, then the message's accepted and start: one turn running", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const store = failing()
  const second = heldSecond()
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "the program") : says(asked, "Seen.")))
  await withSource(file, wire, sandbox.run, null, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("go")
    yield* Deferred.await(sandbox.started)
    store.state.reads = 1
    yield* turns.stop("Stopped by the test.")
    assert.equal(store.state.reads, 0)
    const before = { messages: messages(file), turns: turnRows(file), events: events(file) }
    assert.deepStrictEqual(before.turns, [{ id: 1, status: "running", first_msg: 0 }])
    assert.deepStrictEqual(before.events, ["accepted 0", "start", "call", "message 1", "message 2"])
    // The read fails again: `say` fails, and nothing is written.
    store.state.reads = 1
    const failed = yield* Effect.exit(turns.say("not yet"))
    assert.ok(Exit.isFailure(failed))
    const error = Cause.squash(failed.cause)
    assert.ok(error instanceof StoreError)
    assert.equal(error.op, "runningTurns")
    assert.deepStrictEqual({ messages: messages(file), turns: turnRows(file), events: events(file) }, before)
    // The read passes: the end, then the message and its turn.
    yield* turns.say("next")
    yield* Deferred.await(second.reached)
    assert.deepStrictEqual(events(file), ["accepted 0", "start", "call", "message 1", "message 2", "message 3", "end", "accepted 4", "start"])
    assert.deepStrictEqual(messages(file), ["0 user -", "1 tool 1", "2 echo 1", "3 note 1", "4 user -"])
    assert.equal(rows<{ text: string }>(file, "select text from everchat_msg_read where i = 3")[0]!.text, "Stopped by the test.")
    assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "running", first_msg: 4 }])
    yield* Deferred.succeed(second.gate, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(second.gate, undefined))), { store: store.layer, ask: second.ask })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "stopped", first_msg: 0 }, { id: 2, status: "done", first_msg: 4 }])
})

// Several sources as one (turn.ts, `Source.inOrder`).

// A source for these cases: each of its `next`s gives the next of `gives`
// (a text: a `late` offer of it; "fail": a StoreError of op `name`), then
// null. It marks its build, each ask and its finalizer in `marks`.
const listed = (name: string, gives: Array<string | null>, marks: Array<string>) => {
  const state = { asked: 0 }
  const layer = Layer.effect(
    Source,
    Effect.gen(function*() {
      marks.push(name + " built")
      yield* Effect.addFinalizer(() => Effect.sync(() => marks.push(name + " closed")))
      return Source.of({
        next: Effect.suspend(() => {
          state.asked += 1
          marks.push(name + " asked")
          const given = gives.shift() ?? null
          return given === "fail"
            ? Effect.fail(new StoreError({ op: name, cause: new Error("the source failed") }))
            : Effect.succeed(given === null ? null : { kind: "late" as const, text: given, write: () => Effect.void })
        })
      })
    })
  )
  return { state, layer }
}

// The texts that `n` asks of the joined source give (null: none), or the
// failure's op; then what `marks` holds after the layer's scope closed.
const asks = async (layer: Layer.Layer<Source>, n: number, marks: Array<string>) => {
  const given = await Effect.runPromise(
    Effect.gen(function*() {
      const source = yield* Source
      const out: Array<string | null> = []
      for (let k = 0; k < n; k++) {
        const exit = yield* Effect.exit(source.next)
        out.push(Exit.isSuccess(exit) ? exit.value?.text ?? null : "failed: " + (Cause.squash(exit.cause) as StoreError).op)
      }
      marks.push("the program ended")
      return out
    }).pipe(Effect.provide(layer))
  )
  return given
}

// True when the two types are the same.
type Same<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false

test("Source.inOrder keeps the layers' errors and needs in its type", () => {
  class Boom extends Error {}
  const other = Layer.effect(Source, Effect.fail(new Boom()))
  const approvals: Same<ReturnType<typeof Source.inOrder<[typeof Approvals.source]>>, Layer.Layer<Source, never, Store | Limit>> = true
  const both = Source.inOrder(Approvals.source, other)
  const kept: Same<typeof both, Layer.Layer<Source, Boom, Store | Limit>> = true
  const empty = Source.inOrder()
  const nothing: Same<typeof empty, Layer.Layer<Source, never, never>> = true
  assert.deepStrictEqual([approvals, kept, nothing], [true, true, true])
})

test("Source.inOrder asks the sources in the order given and gives the first offer that is not null; the sources after it are not asked", async () => {
  const marks: Array<string> = []
  const a = listed("a", [null, null], marks)
  const b = listed("b", ["from b", null], marks)
  const c = listed("c", ["from c"], marks)
  const given = await asks(Source.inOrder(a.layer, b.layer, c.layer), 3, marks)
  assert.deepStrictEqual(given, ["from b", "from c", null])
  assert.deepStrictEqual([a.state.asked, b.state.asked, c.state.asked], [3, 3, 2])
  assert.deepStrictEqual(marks, [
    "a built",
    "b built",
    "c built",
    "a asked",
    "b asked",
    "a asked",
    "b asked",
    "c asked",
    "a asked",
    "b asked",
    "c asked",
    "the program ended",
    "c closed",
    "b closed",
    "a closed"
  ])
})

test("Source.inOrder: a next that fails fails the joined next, and the sources after it are not asked", async () => {
  const marks: Array<string> = []
  const a = listed("a", [null, null], marks)
  const b = listed("b", ["fail", null], marks)
  const c = listed("c", ["from c", "from c again"], marks)
  const given = await asks(Source.inOrder(a.layer, b.layer, c.layer), 2, marks)
  assert.deepStrictEqual(given, ["failed: b", "from c"])
  assert.deepStrictEqual([a.state.asked, b.state.asked, c.state.asked], [2, 2, 1])
  assert.deepStrictEqual(marks.slice(3, 8), ["a asked", "b asked", "a asked", "b asked", "c asked"])
})

test("Source.inOrder with no source gives null; with one it gives that source's offers", async () => {
  const marks: Array<string> = []
  assert.deepStrictEqual(await asks(Source.inOrder(), 2, marks), [null, null])
  assert.deepStrictEqual(marks, ["the program ended"])
  const one = listed("one", ["x"], marks)
  assert.deepStrictEqual(await asks(Source.inOrder(one.layer), 2, marks), ["x", null])
  assert.equal(one.state.asked, 2)
  assert.deepStrictEqual(marks.slice(1), ["one built", "one asked", "one asked", "the program ended", "one closed"])
})

test("Source.inOrder builds each layer in the joined layer's scope: no finalizer runs before that scope closes, and each runs at its close", async () => {
  const marks: Array<string> = []
  const a = listed("a", [], marks)
  const b = listed("b", [], marks)
  const scope = await Effect.runPromise(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(Source.inOrder(a.layer, b.layer), scope))
  assert.deepStrictEqual(marks, ["a built", "b built"])
  assert.equal(await Effect.runPromise(Context.get(context, Source).next), null)
  assert.deepStrictEqual(marks, ["a built", "b built", "a asked", "b asked"])
  await Effect.runPromise(Scope.close(scope, Exit.void))
  assert.deepStrictEqual(marks, ["a built", "b built", "a asked", "b asked", "b closed", "a closed"])
})

test("two sources through Turns: an approval's result and a wake-up both wait; the first source's turn comes first, and the second's at its end", async () => {
  const file = newFile()
  const approvals = fakeSource()
  const wakeups = fakeSource()
  const fired = "[1] due 2026-11-16 09:00 Europe/Berlin: Water the plants."
  const wire = fakeWire((asked, n) => says(asked, "Reply " + n + "."))
  const joined = { state: approvals.state, layer: Source.inOrder(approvals.layer, wakeups.layer) }
  await withSource(file, wire, noPrograms, joined, Effect.gen(function*() {
    const turns = yield* Turns
    approvals.state.pending = { kind: "late", text: "send gave: ok" }
    wakeups.state.pending = { kind: "wake", text: fired }
    yield* turns.ready
    // The first offer is logged; the second source was not asked.
    assert.deepStrictEqual(messages(file), ["0 late -"])
    assert.deepStrictEqual([approvals.state.asked, wakeups.state.asked], [1, 0])
    yield* turns.idle
  }))
  assert.deepStrictEqual(messages(file), ["0 late -", "1 asst 1", "2 wake -", "3 asst 2"])
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "done", first_msg: 0 }, { id: 2, status: "done", first_msg: 2 }])
  // Turn 1's end: the first had nothing, the second its fire; turn 2's end: both asked.
  assert.deepStrictEqual([approvals.state.asked, wakeups.state.asked], [3, 2])
  assert.deepStrictEqual(approvals.state.wrote.map((one) => [one.first, one.turn]), [[0, 1]])
  assert.deepStrictEqual(wakeups.state.wrote.map((one) => [one.first, one.kind, one.turn]), [[2, "wake", 2]])
  assert.deepStrictEqual(lastText(wire.sent[0]!.items[0]), { text: LATE + "send gave: ok", mark: true })
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: WAKE + fired, mark: true })
})

// The ceiling of a wake turn
// --------------------------

const FIRED = "[2] due 2026-11-16 09:00 Europe/Berlin: Read my mail and give me the plan."

// A reply's usage: its four counts of tokens.
const use = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input, cacheRead, cacheWrite, output, searches: 0 })

// Programs that end at once.
const ran: Run = () => Effect.succeed({ output: "ran", failed: false })

// A model that runs a program at each request, each reply with `usage`,
// until the `most`-th request, which says it is done: a turn that no
// ceiling stops ends done there. The calls' ids start with `name`.
const busy = (usage: ReturnType<typeof use>, most = 8, name = "t") =>
  fakeWire((asked, n) => (n < most ? runs(asked, name + n, "step " + n, { usage }) : { ...says(asked, "Done."), usage }))

// A store that counts the reads of the usage.
const counted = (count: { usage: number }) =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({ ...real, usage: (filter) => Effect.andThen(Effect.sync(() => (count.usage += 1)), real.usage(filter)) })
    })
  )

const ceilings = (file: string) => rows(file, "select n as id, status, why, steps, tokens from everchat_turn order by n")
const notes = (file: string) => rows(file, "select text, turn from everchat_msg_read where kind = 'note' order by i")
const kinds = (file: string, turn = 1) => rows<{ kind: string }>(file, `select kind from everchat_turn_item where turn = ${turn} order by n`).map((row) => row.kind)
const endsOf = (seen: ReadonlyArray<TurnEvent>) => seen.flatMap((event) => (event.type === "end" ? [[event.turn, event.status, event.why]] : []))

// A wake-up's offer with `ceiling`, at `ready` on an idle chat, until the
// chat is idle: the file, the source, the `end` events that a listener got,
// and the reads of the usage.
const wakeTurn = async (ceiling: Offer["ceiling"], wire: ReturnType<typeof fakeWire>) => {
  const file = newFile()
  const source = fakeSource()
  const count = { usage: 0 }
  const seen = await withSource(file, wire, ran, source, Effect.scoped(Effect.gen(function*() {
    const turns = yield* Turns
    const subscription = yield* turns.subscribe
    source.state.pending = { kind: "wake", text: FIRED, ceiling }
    yield* turns.ready
    yield* turns.idle
    return yield* PubSub.takeAll(subscription)
  })), { store: counted(count) })
  return { file, source, count, ends: endsOf(seen) }
}

test("a wake turn stops at its ceiling of steps: the request after the last allowed step is never made; stopped with CEILING as the row's why, the end event's why and the note; one step under it goes on, and the first step always runs", async () => {
  for (const steps of [3, 1]) {
    const wire = busy(use(10, 0, 0, 1))
    const { file, ends, source } = await wakeTurn({ steps, tokens: 1_000_000 }, wire)
    assert.equal(wire.sent.length, steps, `steps ${steps}`)
    assert.deepStrictEqual(ceilings(file), [{ id: 1, status: "stopped", why: CEILING, steps, tokens: 1_000_000 }])
    assert.deepStrictEqual(ends, [[1, "stopped", CEILING]])
    assert.deepStrictEqual(notes(file), [{ text: CEILING, turn: 1 }])
    assert.deepStrictEqual(kinds(file), ["user", ...Array.from({ length: steps }, () => ["turn", "back"]).flat()])
    // Asked at ready (the offer) and at the stopped turn's end (nothing).
    assert.equal(source.state.asked, 2)
  }
  assert.equal(CEILING, "Stopped: this wake-up's turn reached its ceiling of steps or tokens.")
})

test("a wake turn stops at its ceiling of tokens, the sum of input, cacheRead, cacheWrite and output over its usage rows: at exactly the ceiling it stops; one token under it goes on", async () => {
  // 100 tokens a step.
  for (const [tokens, requests] of [[300, 3], [301, 4]] as const) {
    const wire = busy(use(10, 20, 30, 40))
    const { file, ends } = await wakeTurn({ steps: 100, tokens }, wire)
    assert.equal(wire.sent.length, requests, `tokens ${tokens}`)
    assert.deepStrictEqual(ceilings(file), [{ id: 1, status: "stopped", why: CEILING, steps: 100, tokens }])
    assert.deepStrictEqual(ends, [[1, "stopped", CEILING]])
    assert.deepStrictEqual(notes(file), [{ text: CEILING, turn: 1 }])
  }
})

test("each of the four counts of a usage row counts toward the ceiling of tokens", async () => {
  const each = { input: use(100, 0, 0, 0), cacheRead: use(0, 100, 0, 0), cacheWrite: use(0, 0, 100, 0), output: use(0, 0, 0, 100) }
  for (const [field, usage] of Object.entries(each)) {
    const wire = busy(usage)
    const { file } = await wakeTurn({ steps: 6, tokens: 200 }, wire)
    // At 200 tokens after two steps; without the field, at 6 steps.
    assert.equal(wire.sent.length, 2, field)
    assert.deepStrictEqual(ceilings(file).map((row) => [row.status, row.why]), [["stopped", CEILING]], field)
  }
})

test("a step whose results end the turn ends it done at its ceiling, of steps and of tokens", async () => {
  const atSteps = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "step 1") : says(asked, "Done.")))
  const steps = await wakeTurn({ steps: 2, tokens: 1_000_000 }, atSteps)
  const atTokens = fakeWire((asked) => ({ ...says(asked, "Done."), usage: use(500, 500, 500, 500) }))
  const tokens = await wakeTurn({ steps: 5, tokens: 100 }, atTokens)
  for (const [one, wire, ceiling] of [[steps, atSteps, [2, 1_000_000]], [tokens, atTokens, [5, 100]]] as const) {
    assert.equal(wire.sent.length, ceiling[0] === 2 ? 2 : 1)
    assert.deepStrictEqual(ceilings(one.file), [{ id: 1, status: "done", why: null, steps: ceiling[0], tokens: ceiling[1] }])
    assert.deepStrictEqual(one.ends, [[1, "done", null]])
    assert.deepStrictEqual(notes(one.file), [])
  }
})

test("a turn with no ceiling runs past both numbers and reads no usage: a wake turn offered with none, and a person's turn", async () => {
  const big = use(1_000_000, 1_000_000, 1_000_000, 1_000_000)
  const wire = busy(big, 6)
  const { file, ends, count } = await wakeTurn(undefined, wire)
  assert.equal(wire.sent.length, 6)
  assert.deepStrictEqual(ceilings(file), [{ id: 1, status: "done", why: null, steps: null, tokens: null }])
  assert.deepStrictEqual(ends, [[1, "done", null]])
  assert.equal(count.usage, 0)
  const person = newFile()
  const theirs = busy(big, 6)
  const read = { usage: 0 }
  await withSource(person, theirs, ran, null, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("hello")
    yield* turns.idle
  }), { store: counted(read) })
  assert.equal(theirs.sent.length, 6)
  assert.deepStrictEqual(ceilings(person), [{ id: 1, status: "done", why: null, steps: null, tokens: null }])
  assert.equal(read.usage, 0)
})

test("after a ceiling stop a message of the person that waits starts its turn, and the source is not asked until that turn's end", async () => {
  const file = newFile()
  const source = fakeSource()
  // The person's message comes in turn 1's last steer, too late for it.
  const late: { say: Effect.Effect<unknown, unknown> | null } = { say: null }
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "step 1") : says(asked, "Hi.")))
  await withSource(file, wire, ran, source, Effect.gen(function*() {
    const turns = yield* Turns
    late.say = turns.say("and now?")
    source.state.pending = { kind: "wake", text: FIRED, ceiling: { steps: 1, tokens: 1_000_000 } }
    yield* turns.ready
    yield* turns.idle
  }), { store: tooLate(late) })
  assert.equal(late.say, null)
  assert.deepStrictEqual(ceilings(file), [
    { id: 1, status: "stopped", why: CEILING, steps: 1, tokens: 1_000_000 },
    { id: 2, status: "done", why: null, steps: null, tokens: null }
  ])
  assert.deepStrictEqual(messages(file), ["0 wake -", "1 tool 1", "2 echo 1", "3 user -", "4 note 1", "5 asst 2"])
  assert.deepStrictEqual(turnRows(file).map((row) => row.first_msg), [0, 3])
  assert.equal(wire.sent.length, 2)
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: HEAD + "and now?", mark: true })
  // Asked at ready, then only at turn 2's end.
  assert.equal(source.state.asked, 2)
})

test("after a ceiling stop with no message of the person waiting the source is asked again, and its offer starts the next turn", async () => {
  const file = newFile()
  const source = fakeSource()
  // Turn 1's program leaves a second offer with the source.
  const run: Run = () => Effect.sync(() => ((source.state.pending = { kind: "late", text: "a result" }), { output: "ran", failed: false }))
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "t1", "step 1") : says(asked, "Late seen.")))
  await withSource(file, wire, run, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "wake", text: FIRED, ceiling: { steps: 1, tokens: 1_000_000 } }
    yield* turns.ready
    yield* turns.idle
  }))
  assert.deepStrictEqual(ceilings(file), [
    { id: 1, status: "stopped", why: CEILING, steps: 1, tokens: 1_000_000 },
    { id: 2, status: "done", why: null, steps: null, tokens: null }
  ])
  assert.deepStrictEqual(messages(file), ["0 wake -", "1 tool 1", "2 echo 1", "3 note 1", "4 late -", "5 asst 2"])
  assert.equal(wire.sent.length, 2)
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: LATE + "a result", mark: true })
  // Asked at ready, at turn 1's end (the offer), at turn 2's end.
  assert.equal(source.state.asked, 3)
})

test("a restart of a wake turn at its ceiling stops it with no request; one under it goes on and stops later; the counts come from the rows of the store opened again", async () => {
  const cases = [
    { ceiling: { steps: 1, tokens: 1_000_000 }, requests: 0 },
    { ceiling: { steps: 2, tokens: 1_000_000 }, requests: 1 },
    { ceiling: { steps: 100, tokens: 100 }, requests: 0 },
    { ceiling: { steps: 100, tokens: 101 }, requests: 1 }
  ]
  for (const { ceiling, requests } of cases) {
    const file = newFile()
    const sandbox = gatedSandbox()
    const first = fakeSource()
    // Launch 1: a step of 100 tokens, then its program runs when the launch ends.
    const once = busy(use(25, 25, 25, 25))
    await withSource(file, once, sandbox.run, first, Effect.gen(function*() {
      const turns = yield* Turns
      first.state.pending = { kind: "wake", text: FIRED, ceiling }
      yield* turns.ready
      yield* Deferred.await(sandbox.started)
    }))
    assert.equal(once.sent.length, 1)
    assert.deepStrictEqual(ceilings(file), [{ id: 1, status: "running", why: null, ...ceiling }])
    assert.deepStrictEqual(rows(file, "select status from everchat_call"), [{ status: "running" }])
    // Launch 2: the turn goes on from its rows, with calls of new ids.
    const again = busy(use(25, 25, 25, 25), 8, "r")
    await withSource(file, again, ran, fakeSource(), Turns.use((turns) => turns.idle))
    assert.equal(again.sent.length, requests, JSON.stringify(ceiling))
    assert.deepStrictEqual(ceilings(file), [{ id: 1, status: "stopped", why: CEILING, ...ceiling }], JSON.stringify(ceiling))
    assert.deepStrictEqual(notes(file), [{ text: CEILING, turn: 1 }])
    assert.deepStrictEqual(rows(file, "select status from everchat_call order by n"), Array.from({ length: 1 + requests }, (_, k) => ({ status: k === 0 ? "cut" : "done" })))
  }
})

test("a wake turn that a person's message steers stays under its ceiling: the steer goes in the next request, and the turn stops at the ceiling", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const wire = busy(use(10, 0, 0, 1))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "wake", text: FIRED, ceiling: { steps: 2, tokens: 1_000_000 } }
    yield* turns.ready
    yield* Deferred.await(sandbox.started)
    yield* turns.say("and this too")
    yield* Deferred.succeed(sandbox.gate, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(sandbox.gate, undefined))))
  assert.equal(wire.sent.length, 2)
  assert.deepStrictEqual(wire.sent[1]!.items.map((one) => one.kind), ["user", "turn", "back", "user"])
  assert.deepStrictEqual(ceilings(file), [{ id: 1, status: "stopped", why: CEILING, steps: 2, tokens: 1_000_000 }])
  assert.deepStrictEqual(notes(file), [{ text: CEILING, turn: 1 }])
  assert.deepStrictEqual(messages(file), ["0 wake -", "1 user -", "2 tool 1", "3 echo 1", "4 tool 1", "5 echo 1", "6 note 1"])
})

// A turn at its ceiling takes no steer (lead, ec-bhtag1): a person's
// message that comes during its last allowed step waits, and starts the
// person's turn after the stop.
// ----------------------------------------------------------------------

// A store that counts the reads of the usage, and keeps each `setTaken`
// with the number of turns started before it.
const watched = (seen: { usage: number; taken: Array<[number, number]> }) =>
  Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      let started = 0
      return Store.of({
        ...real,
        usage: (filter) => Effect.andThen(Effect.sync(() => (seen.usage += 1)), real.usage(filter)),
        startTurn: (turn) => Effect.tap(real.startTurn(turn), () => Effect.sync(() => (started += 1))),
        setTaken: (i) => Effect.andThen(Effect.sync(() => seen.taken.push([i, started])), real.setTaken(i))
      })
    })
  )

// A sandbox whose k-th program (from 0) waits for `gates[k]`; `started[k]`
// is done when it runs.
const steppedSandbox = (count: number) => {
  const started = Array.from({ length: count }, () => Deferred.makeUnsafe<void>())
  const gates = Array.from({ length: count }, () => Deferred.makeUnsafe<void>())
  let k = 0
  const run: Run = () => Effect.gen(function*() {
    const at = k++
    yield* Deferred.succeed(started[at]!, undefined)
    yield* Deferred.await(gates[at]!)
    return { output: "ran", failed: false }
  })
  const open = Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined), { discard: true })
  return { started, gates, run, open }
}

const LAST = "and one more thing"

// A wake turn with `ceiling` whose first step runs a program, each reply
// with `usage`; the person's message comes while that program runs (the
// program waits until the message is in). Then the chat is idle. The
// source's count of asks at the second request is kept.
const lastStep = async (ceiling: NonNullable<Offer["ceiling"]>, usage: ReturnType<typeof use>) => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const source = fakeSource()
  const seen = { usage: 0, taken: [] as Array<[number, number]> }
  const asked: Array<number> = []
  const wire = fakeWire((request, n) => (n === 1 ? runs(request, "t1", "step 1", { usage }) : { ...says(request, "Seen."), usage }))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "wake", text: FIRED, ceiling }
    yield* turns.ready
    yield* Deferred.await(sandbox.started)
    yield* turns.say(LAST)
    yield* Deferred.succeed(sandbox.gate, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(sandbox.gate, undefined))), {
    store: watched(seen),
    ask: () => Effect.sync(() => asked.push(source.state.asked))
  })
  return { file, source, seen, asked, wire }
}

// What each of the two cases at the ceiling of a wake turn of one step
// shows: one request in the wake turn, stopped with CEILING; the message
// is no item of it and `taken` is not past it while it runs; the person's
// turn starts after it, with the message in its first request, and the
// source is not asked before that turn's end.
const atTheCeiling = (got: Awaited<ReturnType<typeof lastStep>>, ceiling: NonNullable<Offer["ceiling"]>) => {
  const { file, source, seen, asked, wire } = got
  assert.deepStrictEqual(ceilings(file), [
    { id: 1, status: "stopped", why: CEILING, ...ceiling },
    { id: 2, status: "done", why: null, steps: null, tokens: null }
  ])
  assert.deepStrictEqual(messages(file), ["0 wake -", "1 user -", "2 tool 1", "3 echo 1", "4 note 1", "5 asst 2"])
  assert.deepStrictEqual(kinds(file, 1), ["user", "turn", "back"])
  assert.deepStrictEqual(turnRows(file).map((row) => row.first_msg), [0, 1])
  // Turn 1 took the wake message only; turn 2 took the person's.
  assert.deepStrictEqual(seen.taken, [[0, 1], [1, 2]])
  // Two requests: turn 1's one, then turn 2's first, which holds the message.
  assert.equal(wire.sent.length, 2)
  assert.deepStrictEqual(wire.sent[0]!.items.map((one) => one.kind), ["user"])
  assert.deepStrictEqual(wire.sent[1]!.items.map((one) => one.kind), ["user"])
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[0]), { text: HEAD + LAST, mark: true })
  // Asked at ready only, before turn 2's request; then at turn 2's end.
  assert.deepStrictEqual(asked, [1, 1])
  assert.equal(source.state.asked, 2)
}

test("at the ceiling of steps (1), a person's message during the last step's program is not taken by the wake turn: it ends stopped with CEILING after one request, `taken` not past the message, and the message starts the person's turn, whose first request holds it", async () => {
  const ceiling = { steps: 1, tokens: 1_000_000 }
  atTheCeiling(await lastStep(ceiling, use(10, 0, 0, 1)), ceiling)
})

test("at the ceiling of tokens, reached by the step's usage, a person's message during the step's program is not taken by the wake turn: it ends stopped with CEILING, and the message starts the person's turn", async () => {
  // 100 tokens in the first step: at the ceiling of 100, under the steps.
  const ceiling = { steps: 100, tokens: 100 }
  atTheCeiling(await lastStep(ceiling, use(25, 25, 25, 25)), ceiling)
})

test("a ceiling of 2 steps: a message during step 1 steers (request 2 holds it); a message during step 2 is not taken, and starts its own turn", async () => {
  const file = newFile()
  const sandbox = steppedSandbox(2)
  const source = fakeSource()
  const wire = fakeWire((request, n) => (n <= 2 ? runs(request, "t" + n, "step " + n) : says(request, "Seen.")))
  await withSource(file, wire, sandbox.run, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "wake", text: FIRED, ceiling: { steps: 2, tokens: 1_000_000 } }
    yield* turns.ready
    yield* Deferred.await(sandbox.started[0]!)
    yield* turns.say("during step 1")
    yield* Deferred.succeed(sandbox.gates[0]!, undefined)
    yield* Deferred.await(sandbox.started[1]!)
    yield* turns.say("during step 2")
    yield* Deferred.succeed(sandbox.gates[1]!, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(sandbox.open)))
  assert.equal(wire.sent.length, 3)
  assert.deepStrictEqual(wire.sent[1]!.items.map((one) => one.kind), ["user", "turn", "back", "user"])
  assert.deepStrictEqual(lastText(wire.sent[1]!.items[3]), { text: "during step 1", mark: false })
  assert.deepStrictEqual(kinds(file, 1), ["user", "turn", "back", "user", "turn", "back"])
  assert.deepStrictEqual(wire.sent[2]!.items.map((one) => one.kind), ["user"])
  assert.deepStrictEqual(lastText(wire.sent[2]!.items[0]), { text: HEAD + "during step 2", mark: true })
  assert.deepStrictEqual(ceilings(file), [
    { id: 1, status: "stopped", why: CEILING, steps: 2, tokens: 1_000_000 },
    { id: 2, status: "done", why: null, steps: null, tokens: null }
  ])
  assert.deepStrictEqual(turnRows(file).map((row) => row.first_msg), [0, 4])
  assert.deepStrictEqual(messages(file), [
    "0 wake -", "1 user -", "2 tool 1", "3 echo 1", "4 user -", "5 tool 1", "6 echo 1", "7 note 1", "8 asst 2"
  ])
})

test("a step with no call at the ceiling, with a person's message waiting: the wake turn ends done, takes no steer, and the message starts its own turn", async () => {
  const file = newFile()
  const source = fakeSource()
  // The message comes while turn 1's second (last) request is made.
  const asking = Deferred.makeUnsafe<void>()
  const go = Deferred.makeUnsafe<void>()
  const wire = fakeWire((request, n) => (n === 1 ? runs(request, "t1", "step 1") : says(request, n === 2 ? "Done." : "Seen.")))
  await withSource(file, wire, ran, source, Effect.gen(function*() {
    const turns = yield* Turns
    source.state.pending = { kind: "wake", text: FIRED, ceiling: { steps: 2, tokens: 1_000_000 } }
    yield* turns.ready
    yield* Deferred.await(asking)
    yield* turns.say(LAST)
    yield* Deferred.succeed(go, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))), {
    ask: (n) => (n === 2 ? Effect.andThen(Deferred.succeed(asking, undefined), Deferred.await(go)) : Effect.void)
  })
  assert.equal(wire.sent.length, 3)
  assert.deepStrictEqual(kinds(file, 1), ["user", "turn", "back", "turn"])
  assert.deepStrictEqual(ceilings(file), [
    { id: 1, status: "done", why: null, steps: 2, tokens: 1_000_000 },
    { id: 2, status: "done", why: null, steps: null, tokens: null }
  ])
  assert.deepStrictEqual(notes(file), [])
  assert.deepStrictEqual(wire.sent[2]!.items.map((one) => one.kind), ["user"])
  assert.deepStrictEqual(lastText(wire.sent[2]!.items[0]), { text: HEAD + LAST, mark: true })
  assert.deepStrictEqual(messages(file), ["0 wake -", "1 tool 1", "2 echo 1", "3 user -", "4 asst 1", "5 asst 2"])
})

test("a restart of a wake turn at its ceiling whose last step's results are not all in, with a person's message waiting: the results are kept, no steer, the turn ends stopped, and the message starts its own turn", async () => {
  const file = newFile()
  const sandbox = gatedSandbox()
  const first = fakeSource()
  // Launch 1: one step, whose program still runs when the launch ends; the
  // message comes while it runs.
  const once = fakeWire((request) => runs(request, "t1", "step 1"))
  await withSource(file, once, sandbox.run, first, Effect.gen(function*() {
    const turns = yield* Turns
    first.state.pending = { kind: "wake", text: FIRED, ceiling: { steps: 1, tokens: 1_000_000 } }
    yield* turns.ready
    yield* Deferred.await(sandbox.started)
    yield* turns.say(LAST)
  }))
  assert.equal(once.sent.length, 1)
  assert.deepStrictEqual(ceilings(file), [{ id: 1, status: "running", why: null, steps: 1, tokens: 1_000_000 }])
  assert.deepStrictEqual(kinds(file, 1), ["user", "turn"])
  // Launch 2: the turn goes on from its rows.
  const seen = { usage: 0, taken: [] as Array<[number, number]> }
  const again = fakeWire((request) => says(request, "Seen."))
  await withSource(file, again, ran, fakeSource(), Turns.use((turns) => turns.idle), { store: watched(seen) })
  assert.deepStrictEqual(kinds(file, 1), ["user", "turn", "back"])
  assert.deepStrictEqual(rows(file, "select status from everchat_call order by n"), [{ status: "cut" }])
  assert.deepStrictEqual(ceilings(file), [
    { id: 1, status: "stopped", why: CEILING, steps: 1, tokens: 1_000_000 },
    { id: 2, status: "done", why: null, steps: null, tokens: null }
  ])
  assert.deepStrictEqual(notes(file), [{ text: CEILING, turn: 1 }])
  // In launch 2, `taken` moves only for turn 2, to the message.
  assert.deepStrictEqual(seen.taken, [[1, 1]])
  assert.equal(again.sent.length, 1)
  assert.deepStrictEqual(again.sent[0]!.items.map((one) => one.kind), ["user"])
  assert.deepStrictEqual(lastText(again.sent[0]!.items[0]), { text: HEAD + LAST, mark: true })
})

test("the cost of the test at a steer: a wake turn under its ceiling with no message waiting reads the usage once a request, as before a request only; a turn with no ceiling that a message steers reads none", async () => {
  // Four requests under a ceiling of 10 steps: one read before each.
  const wire = busy(use(10, 0, 0, 1), 4)
  const { file, count } = await wakeTurn({ steps: 10, tokens: 1_000_000 }, wire)
  assert.equal(wire.sent.length, 4)
  assert.deepStrictEqual(ceilings(file).map((row) => row.status), ["done"])
  assert.equal(count.usage, 4)
  // A person's turn, steered during its first program: no read.
  const person = newFile()
  const sandbox = gatedSandbox()
  const theirs = fakeWire((request, n) => (n === 1 ? runs(request, "t1", "step 1") : says(request, "Seen.")))
  const read = { usage: 0 }
  await withSource(person, theirs, sandbox.run, null, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("hello")
    yield* Deferred.await(sandbox.started)
    yield* turns.say(LAST)
    yield* Deferred.succeed(sandbox.gate, undefined)
    yield* turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(sandbox.gate, undefined))), { store: counted(read) })
  assert.deepStrictEqual(theirs.sent[1]!.items.map((one) => one.kind), ["user", "turn", "back", "user"])
  assert.equal(read.usage, 0)
})

test("an offer's ceiling of 0, below 0, a fraction, or one field alone is a defect of the source: nothing is written, and the source's write does not run", async () => {
  const bad = [
    { steps: 0, tokens: 5 },
    { steps: 5, tokens: 0 },
    { steps: -1, tokens: 5 },
    { steps: 1.5, tokens: 5 },
    { steps: 5, tokens: 2.5 },
    { steps: 5 },
    { tokens: 5 }
  ]
  for (const ceiling of bad) {
    const file = newFile()
    const source = fakeSource()
    const wire = fakeWire((asked) => says(asked, "never"))
    await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
      const turns = yield* Turns
      source.state.pending = { kind: "wake", text: FIRED, ceiling: ceiling as Offer["ceiling"] }
      const ready = yield* Effect.exit(turns.ready)
      assert.equal(Exit.isFailure(ready) && Cause.hasDies(ready.cause), true, JSON.stringify(ceiling))
    }))
    assert.deepStrictEqual(messages(file), [])
    assert.deepStrictEqual(turnRows(file), [])
    assert.deepStrictEqual(source.state.wrote, [])
    assert.equal(wire.sent.length, 0)
  }
})

// The wake-ups' notes at a program's close (turn.ts, `ended`)
// -----------------------------------------------------------

// The first slot of the rows that the programs make: 09:00 in Berlin.
const FIRST = Date.parse("2026-11-16T08:00:00Z")
const SET_1 = "Wake-up 1 set: next 2026-11-16 09:00 Europe/Berlin"

// One step of a program of these cases, each a function call of the program
// (the store's `startCall` with the program as its parent, as the sandbox's
// `invoke` does): `make` a row (a routine at 09:00, of `zone`, first
// `first`; FIRST in Berlin by default), `stop` the row `id` as the model
// (`unwake`), or `pend` a call that waits for a person's yes or no.
type Act =
  | { readonly make: { readonly zone?: string; readonly first?: number } }
  | { readonly stop: number }
  | { readonly pend: string }

// The programs, one for each run, in order: each does its steps, then
// `then` (inside the program, before its close). `store` is the launch's.
const acting = (holder: { store: Store["Service"] | null }, programs: Array<{ readonly acts: ReadonlyArray<Act>; readonly then?: Effect.Effect<void, StoreError> }>): Run =>
  ((_program: string, at?: { readonly turn: number; readonly call: number }) =>
    Effect.gen(function*() {
      const store = holder.store!
      const parent = at!.call
      const one = programs.shift() ?? { acts: [] }
      for (const act of one.acts) {
        if ("make" in act) {
          const call = yield* store.startCall({ turn: at!.turn, parent, fn: "wake", input: "[{}]" })
          const made = yield* store.makeWake({ text: "Read my mail.", cron: "0 9 * * *", zone: act.make.zone ?? "Europe/Berlin", first: act.make.first ?? FIRST, turn: at!.turn, call }, 20)
          yield* store.endCall(call, { status: "done", output: made._tag })
        } else if ("stop" in act) {
          const call = yield* store.startCall({ turn: at!.turn, parent, fn: "unwake", input: `[{"id":${act.stop}}]` })
          yield* store.stopWake(act.stop, "unwake", call)
          yield* store.endCall(call, { status: "done", output: "stopped" })
        } else {
          const call = yield* store.startCall({ turn: at!.turn, parent, fn: "send", input: JSON.stringify([act.pend]) })
          yield* store.pendCall(call, (n) => JSON.stringify(pending(n)))
        }
      }
      if (one.then !== undefined) yield* one.then
      return { output: "ran", failed: false }
    }).pipe(Effect.orDie)) as Run

// The log: each message as "<i> <kind> <call> <text>" (a call of none: -).
const logOf = (file: string) =>
  rows<{ i: number; kind: string; call: number | null; text: string }>(file, "select i, kind, call, text from everchat_msg_read order by i").map((row) =>
    `${row.i} ${row.kind} ${row.call ?? "-"} ${row.text}`
  )

// A model that runs `count` programs, one at each request, then says it is done.
const programs = (count: number) => fakeWire((asked, n) => (n <= count ? runs(asked, "p" + n, "program " + n) : says(asked, "Done.")))

// One turn of the person's message, whose programs are `given`.
const noted = async (given: Array<{ readonly acts: ReadonlyArray<Act>; readonly then?: Effect.Effect<void, StoreError> }>) => {
  const file = newFile()
  const holder: { store: Store["Service"] | null } = { store: null }
  const wire = programs(given.length)
  await withSource(file, wire, acting(holder, given), null, Effect.gen(function*() {
    holder.store = yield* Store
    const turns = yield* Turns
    yield* turns.say("set it")
    yield* turns.idle
  }))
  return { file, wire }
}

test("a program that makes a row: its tool, its echo, then the make's note with the row's first on its wall clock, each with its event, in the program's transaction", async () => {
  const { file } = await noted([{ acts: [{ make: {} }] }])
  assert.deepStrictEqual(logOf(file), ["0 user - set it", "1 tool 1 program 1", "2 echo 1 ran", "3 note 1 " + SET_1, "4 asst - Done."])
  assert.deepStrictEqual(events(file), ["accepted 0", "start", "call", "message 1", "message 2", "message 3", "message 4", "end"])
})

test("a program that stops a row that an earlier program made: the stop's note alone; the make's note is the earlier program's", async () => {
  const { file } = await noted([{ acts: [{ make: {} }] }, { acts: [{ stop: 1 }] }])
  assert.deepStrictEqual(logOf(file), [
    "0 user - set it",
    "1 tool 1 program 1",
    "2 echo 1 ran",
    "3 note 1 " + SET_1,
    "4 tool 3 program 2",
    "5 echo 3 ran",
    "6 note 3 Wake-up 1 stopped.",
    "7 asst - Done."
  ])
})

test("one program that makes two rows and stops the first: a note for each call, in the order of the calls; the stopped row's make still gives its first", async () => {
  const { file } = await noted([{ acts: [{ make: {} }, { make: { zone: "America/New_York", first: Date.parse("2026-12-01T14:30:00Z") } }, { stop: 1 }] }])
  assert.deepStrictEqual(logOf(file).slice(1, 6), [
    "1 tool 1 program 1",
    "2 echo 1 ran",
    "3 note 1 " + SET_1,
    "4 note 1 Wake-up 2 set: next 2026-12-01 09:30 America/New_York",
    "5 note 1 Wake-up 1 stopped."
  ])
})

test("the wake-ups' notes come after the approvals' notes of the same program, whatever the order of the calls", async () => {
  const { file } = await noted([{ acts: [{ make: {} }, { pend: "y" }] }])
  assert.deepStrictEqual(logOf(file).slice(1, 5), [
    "1 tool 1 program 1",
    "2 echo 1 ran",
    "3 note 1 Approval 1 waits for a person's yes or no: send(\"y\"). The call did not run.",
    "4 note 1 " + SET_1
  ])
})

test("a stop of the person before the program's close: the make's note with the row's first, and no stop's note", async () => {
  const holder: { store: Store["Service"] | null } = { store: null }
  const stop = Effect.suspend(() => Effect.asVoid(holder.store!.stopWake(1, "person")))
  const file = newFile()
  await withSource(file, programs(1), acting(holder, [{ acts: [{ make: {} }], then: stop }]), null, Effect.gen(function*() {
    holder.store = yield* Store
    const turns = yield* Turns
    yield* turns.say("set it")
    yield* turns.idle
    // The row stopped, with no due: the note's time is its first.
    const [row] = yield* holder.store.wakes()
    assert.deepStrictEqual([row!.why, row!.due, row!.first, row!.stopCall], ["person", null, FIRST, null])
  }))
  assert.deepStrictEqual(logOf(file), ["0 user - set it", "1 tool 1 program 1", "2 echo 1 ran", "3 note 1 " + SET_1, "4 asst - Done."])
})

test("a slot of the firer that moves the row's due before the program's close: the make's note still gives the row's first", async () => {
  const holder: { store: Store["Service"] | null } = { store: null }
  const next = Date.parse("2026-11-17T08:00:00Z")
  const pend = Effect.suspend(() => Effect.asVoid(holder.store!.pendWake(1, { pending: FIRST, missed: 0, due: next })))
  const file = newFile()
  await withSource(file, programs(1), acting(holder, [{ acts: [{ make: {} }], then: pend }]), null, Effect.gen(function*() {
    holder.store = yield* Store
    const turns = yield* Turns
    yield* turns.say("set it")
    yield* turns.idle
    const [row] = yield* holder.store.wakes()
    assert.deepStrictEqual([row!.first, row!.due, row!.pending], [FIRST, next, FIRST])
  }))
  assert.deepStrictEqual(logOf(file), ["0 user - set it", "1 tool 1 program 1", "2 echo 1 ran", "3 note 1 " + SET_1, "4 asst - Done."])
})

test("a program with no row logs its tool and echo alone, as before", async () => {
  const { file } = await noted([{ acts: [] }, { acts: [{ make: {} }] }, { acts: [] }])
  assert.deepStrictEqual(logOf(file), [
    "0 user - set it",
    "1 tool 1 program 1",
    "2 echo 1 ran",
    "3 tool 2 program 2",
    "4 echo 2 ran",
    "5 note 2 " + SET_1,
    "6 tool 4 program 3",
    "7 echo 4 ran",
    "8 asst - Done."
  ])
})

test("a program cut while it runs, after it made a row: no note at the launch; the restart closes it with its tool, its echo and the make's note, one time", async () => {
  const file = newFile()
  const holder: { store: Store["Service"] | null } = { store: null }
  const started = Deferred.makeUnsafe<void>()
  const hang = Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
  await withSource(file, programs(1), acting(holder, [{ acts: [{ make: {} }], then: hang }]), null, Effect.gen(function*() {
    holder.store = yield* Store
    yield* (yield* Turns).say("set it")
    yield* Deferred.await(started)
  }))
  assert.deepStrictEqual(logOf(file), ["0 user - set it"])
  const again = fakeWire((asked) => says(asked, "It was cut."))
  await withSource(file, again, noPrograms, null, Effect.gen(function*() {
    yield* (yield* Turns).idle
  }))
  const [tool, echo, note, asst] = logOf(file).slice(1)
  assert.equal(tool, "1 tool 1 program 1")
  assert.ok(echo!.startsWith("2 echo 1 The program was cut when EverChat stopped."), String(echo))
  assert.equal(note, "3 note 1 " + SET_1)
  assert.equal(asst, "4 asst - It was cut.")
  assert.equal(logOf(file).length, 5)
  // A third launch: nothing more.
  await withSource(file, fakeWire((asked) => says(asked, "never")), noPrograms, null, Effect.gen(function*() {
    yield* (yield* Turns).idle
  }))
  assert.equal(logOf(file).filter((line) => line.includes("Wake-up")).length, 1)
})

test("a fault of the store in the program's close: no tool, no echo and no note; the row that the program made stays", async () => {
  const file = newFile()
  const holder: { store: Store["Service"] | null } = { store: null }
  // The program's call is the turn's first call: its end fails.
  const store = Layer.effect(
    Store,
    Effect.gen(function*() {
      const real = yield* Store
      return Store.of({
        ...real,
        endCall: (id, end) => (id === 1 ? Effect.fail(new StoreError({ op: "endCall", cause: new Error("the close failed") })) : real.endCall(id, end))
      })
    })
  )
  await withSource(file, programs(1), acting(holder, [{ acts: [{ make: {} }] }]), null, Effect.gen(function*() {
    holder.store = yield* Store
    const turns = yield* Turns
    yield* turns.say("set it")
    yield* turns.idle
    assert.deepStrictEqual((yield* holder.store.wakes()).map((row) => [row.id, row.call]), [[1, 2]])
  }), { store })
  assert.deepStrictEqual(logOf(file), ["0 user - set it"])
  assert.deepStrictEqual(events(file), ["accepted 0", "start", "call"])
})

// `Source.inOrder` with layers that share a layer: one memo map.

class Shared extends Context.Service<Shared, { readonly n: number }>()("everchat/test/Shared") {}

// A layer that counts its builds and its finalizers: `Shared`, or a source.
const tally = () => {
  const state = { built: 0, closed: 0 }
  const make = Effect.gen(function*() {
    state.built += 1
    yield* Effect.addFinalizer(() => Effect.sync(() => (state.closed += 1)))
  })
  const shared = Layer.effect(Shared, Effect.as(make, Shared.of({ n: 1 })))
  const source = Layer.effect(Source, Effect.as(make, Source.of({ next: Effect.succeed(null) })))
  return { state, shared, source }
}

// A source over `Shared`, with nothing to offer.
const overShared = () =>
  Layer.effect(
    Source,
    Effect.gen(function*() {
      yield* Shared
      return Source.of({ next: Effect.succeed(null) })
    })
  )

// Builds `layer` in a scope of its own: the counts after the build, after
// a `next`, and after the scope's close.
const lifetime = async <R>(layer: Layer.Layer<R>, counts: { readonly built: number; readonly closed: number }) => {
  const scope = await Effect.runPromise(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const built = { ...counts }
  await Effect.runPromise(Context.get(context as Context.Context<Source>, Source).next)
  const used = { ...counts }
  await Effect.runPromise(Scope.close(scope, Exit.void))
  return { built, used, closed: { ...counts } }
}

test("Source.inOrder with one source's layer given two times builds it one time, and its finalizer runs one time, at the joined scope's close", async () => {
  const one = tally()
  const seen = await lifetime(Source.inOrder(one.source, one.source), one.state)
  assert.deepStrictEqual(seen, { built: { built: 1, closed: 0 }, used: { built: 1, closed: 0 }, closed: { built: 1, closed: 1 } })
})

test("Source.inOrder with two sources that each have the same layer under them builds that layer one time, and closes it one time, at the joined scope's close", async () => {
  const shared = tally()
  const seen = await lifetime(Source.inOrder(overShared().pipe(Layer.provide(shared.shared)), overShared().pipe(Layer.provide(shared.shared))), shared.state)
  assert.deepStrictEqual(seen, { built: { built: 1, closed: 0 }, used: { built: 1, closed: 0 }, closed: { built: 1, closed: 1 } })
})

test("Source.inOrder beside another layer of the same stack, both over the same layer: that layer is built one time, and closed one time, at the stack's close", async () => {
  class Other extends Context.Service<Other, { readonly n: number }>()("everchat/test/Other") {}
  const shared = tally()
  const other = Layer.effect(
    Other,
    Effect.gen(function*() {
      const one = yield* Shared
      return Other.of({ n: one.n })
    })
  ).pipe(Layer.provide(shared.shared))
  const joined = Source.inOrder(overShared().pipe(Layer.provide(shared.shared)))
  for (const stack of [Layer.mergeAll(other, joined), Layer.mergeAll(joined, other)]) {
    shared.state.built = 0
    shared.state.closed = 0
    const seen = await lifetime(stack, shared.state)
    assert.deepStrictEqual(seen, { built: { built: 1, closed: 0 }, used: { built: 1, closed: 0 }, closed: { built: 1, closed: 1 } })
  }
})
