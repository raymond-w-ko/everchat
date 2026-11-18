// Tests of the seam of a message from outside a turn (turn.ts, `Source`,
// `Offer`, `Turns.ready`), with the tests' fake wire, a fake sandbox and a
// source that the test controls: an offer waits until the chat is idle and
// starts a turn of its own; it never steers a turn that runs.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as path from "node:path"
import { compactor, fakeWire, newFile, options, reply, rows, wireError } from "@everchat/local/testing"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import { head } from "./head.ts"
import { Memory } from "./memory.ts"
import type { Item, Reply, Request } from "./request.ts"
import { storeLayer } from "@everchat/sqlite/bun"
import { type Kind, Store, StoreError } from "./store.ts"
import { limitLayer } from "@everchat/local/limitfile"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { Sandbox } from "./sandbox.ts"
import { HEAD, HEADS, LATE, Source, Turns } from "./turn.ts"

type Run = (program: string) => Effect.Effect<{ output: string; failed: boolean }>

// A source that the test controls: `pending` is what its next `next`
// gives (then it is gone), `asked` counts the asks, `wrote` holds what each
// write saw. Its write keeps "fired <page> turn <turn>" as the chat's goal,
// a row of its own in the offer's transaction, then fails when `fail`.
const fakeSource = () => {
  const state = {
    pending: null as { readonly kind: Kind; readonly text: string } | null,
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

const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }]
  })

const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

const lastText = (item: Item | undefined) => (item?.kind === "user" ? item.blocks[item.blocks.length - 1] : undefined)

const messages = (file: string) =>
  rows<{ i: number; kind: string; turn: number | null }>(file, "select i, kind, turn from everchat_msg_read order by i").map((row) => `${row.i} ${row.kind} ${row.turn ?? "-"}`)
const turnRows = (file: string) => rows(file, "select n as id, status, first_msg from everchat_turn order by n")
const events = (file: string) =>
  rows<{ type: string; msg: number | null }>(file, "select type, msg from everchat_event order by n").map((row) => row.type + (row.msg === null ? "" : " " + row.msg))
const chat = (file: string) => rows<{ goal: string | null; taken: number }>(file, "select goal, taken from everchat_chat")[0]

test("the kinds of a turn's first item: user and work under HEAD, late under LATE", () => {
  assert.deepStrictEqual(HEADS, { user: HEAD, work: HEAD, late: LATE })
  assert.equal(LATE, "Turn: a call that waited for approval has run:\n\n")
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

test("after a failed turn with a waiting message of the person the offer does not start a turn, and the source is not asked", async () => {
  const file = newFile()
  const source = fakeSource()
  const reached = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  const wire = fakeWire(() => wireError("input"))
  const ask = (n: number) => (n === 1 ? Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(gate)) : Effect.void)
  await withSource(file, wire, noPrograms, source, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("hello")
    yield* Deferred.await(reached)
    source.state.pending = { kind: "late", text: "a result" }
    // It waits: the turn's request has not come back, so no step takes it.
    yield* turns.say("are you there?")
    yield* Deferred.succeed(gate, undefined)
    yield* turns.idle
  }), { ask })
  assert.deepStrictEqual(turnRows(file), [{ id: 1, status: "failed", first_msg: 0 }])
  assert.deepStrictEqual(messages(file), ["0 user -", "1 user -", "2 note 1"])
  assert.equal(source.state.asked, 0)
  assert.notEqual(source.state.pending, null)
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
