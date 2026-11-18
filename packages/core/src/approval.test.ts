// Tests of the answer and the run after a yes (approval.ts), with the
// SQLite store, the tests' fake wire, a sandbox whose program records a
// call of a gated function (as the sandbox's calls do: the call's row, then
// `pendCall`), and a gated function that counts its runs and keeps its
// arguments. Each wait is on a signal of the work itself: no case waits for
// time.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Clock, Deferred, Effect, Exit, Layer, Logger } from "effect"
import { compactor, fakeWire, newFile, options, reply, rows, write } from "@everchat/local/testing"
import { storeLayer } from "@everchat/sqlite/bun"
import { Approvals, CUT_RUN } from "./approval.ts"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import { type Caller, core, type Declaration, type Entry, FunctionError, Functions, make, pending, RESULT } from "./functions.ts"
import { head } from "./head.ts"
import { noFileLayer } from "./limit.ts"
import { Memory } from "./memory.ts"
import type { Item, Reply, Request } from "./request.ts"
import { Sandbox } from "./sandbox.ts"
import { Store, StoreError, WAIT } from "./store.ts"
import { LATE, Source, Turns } from "./turn.ts"

// The gated function: a send to someone.
const SEND: Declaration = {
  name: "acme.send",
  description: "Sends a text to someone.",
  inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"], additionalProperties: false }
}

const ARGS = [{ to: "ada@example.com", text: "hello" }]
const INPUT = JSON.stringify(ARGS)

type Mode = "ok" | "fail" | "die" | "hold" | "long"

// The function: each run keeps its arguments and its caller; `mode` says
// what it does. `started` is done when a run starts, and `starts[k]` when
// the k-th does; a run in "hold" waits for `gate`, or for `gates[k]` when
// the case gives the k-th its own.
const gated = (mode: Mode = "ok") => {
  const state = {
    mode,
    runs: [] as Array<{ readonly args: ReadonlyArray<unknown>; readonly caller: Caller }>,
    started: Deferred.makeUnsafe<void>(),
    starts: Array.from({ length: 8 }, () => Deferred.makeUnsafe<void>()),
    gate: Deferred.makeUnsafe<void>(),
    gates: [] as Array<Deferred.Deferred<void>>
  }
  const entry: Entry = {
    declaration: SEND,
    approval: true,
    run: (args, caller) =>
      Effect.gen(function*() {
        const k = state.runs.length
        state.runs.push({ args, caller })
        yield* Deferred.succeed(state.started, undefined)
        const start = state.starts[k]
        if (start !== undefined) yield* Deferred.succeed(start, undefined)
        switch (state.mode) {
          case "ok":
            return { sent: true, to: (args[0] as { to: string }).to }
          case "fail":
            return yield* new FunctionError({ message: "The mail server refused it." })
          case "die":
            return yield* Effect.die(new Error("boom"))
          case "hold":
            yield* Deferred.await(state.gates[k] ?? state.gate)
            return "held"
          case "long":
            return "HEAD-" + "m".repeat(6_000) + "-TAIL"
        }
      })
  }
  return { state, entry }
}

// A program: "send" records a call of the gated function with ARGS (or
// with the JSON after "send "), and the store makes it pending, as the
// sandbox's calls do; "hold" waits for `gate`.
const sandboxOf = (gate: Deferred.Deferred<void>, started: Deferred.Deferred<void>) =>
  Layer.effect(
    Sandbox,
    Effect.gen(function*() {
      const store = yield* Store
      return Sandbox.of({
        run: (program, at) =>
          Effect.gen(function*() {
            if (program === "hold") {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
              return { output: "held", failed: false }
            }
            const input = program === "send" ? INPUT : program.slice("send ".length)
            const id = yield* store.startCall({ turn: at.turn, parent: at.call, fn: SEND.name, input })
            const n = yield* store.pendCall(id, (approval) => JSON.stringify(pending(approval)))
            return { output: JSON.stringify(pending(n)), failed: false }
          }).pipe(Effect.orDie)
      })
    })
  )

const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }]
  })

const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

const firstText = (asked: Request | undefined) => {
  const item: Item | undefined = asked?.items[0]
  return item?.kind === "user" ? item.blocks[item.blocks.length - 1]?.text ?? "" : ""
}

// A wire for the cases: a turn whose request starts with LATE gets "Late
// seen." and marks `late` (the first such turn) and `lates[k]` (the k-th);
// any other turn's first request runs `programs`' next program (none left:
// "Seen."), and its second says "It waits.".
const wireOf = (...programs: ReadonlyArray<string>) => {
  const lates = Array.from({ length: 8 }, () => Deferred.makeUnsafe<void>())
  const late = lates[0]!
  let seen = 0
  let next = 0
  const made = fakeWire((asked, n) => {
    if (firstText(asked).startsWith(LATE)) {
      const mark = lates[seen++]
      if (mark !== undefined) Deferred.doneUnsafe(mark, Exit.void)
      return says(asked, "Late seen.")
    }
    if (asked.items.length > 1) return says(asked, "It waits.")
    const program = programs[next++]
    return program === undefined ? says(asked, "Seen.") : runs(asked, "t" + n, program)
  })
  return { ...made, late, lates }
}

interface Over {
  // No layer of approvals (and no source): a launch of an older program, or
  // one that stops before its load.
  readonly approvals?: boolean
  readonly limit?: number
  // A wrapper over the store.
  readonly store?: Layer.Layer<Store, never, Store>
  // The sandbox's "hold".
  readonly hold?: { readonly gate: Deferred.Deferred<void>; readonly started: Deferred.Deferred<void> }
  // Two layers of approvals over one turn loop: two loads at one time.
  readonly twice?: boolean
  // The log's lines: each line's level and message.
  readonly logs?: Array<{ readonly level: string; readonly message: unknown }>
}

// One launch: the store, the memory, the functions (result and the gated
// one), the limit, the turn loop with the approvals' source below it, and
// the approvals over it. The effect's end is the unload.
const launch = <A, E>(
  file: string,
  wire: ReturnType<typeof wireOf>,
  fn: ReturnType<typeof gated>,
  effect: Effect.Effect<A, E, Turns | Store | Approvals | Functions>,
  over: Over = {}
) => {
  const real = storeLayer(file, options())
  const store = over.store === undefined ? real : over.store.pipe(Layer.provide(real))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const functions = Layer.effect(
    Functions,
    Effect.gen(function*() {
      const { result } = yield* core
      return make([RESULT, SEND], [result, fn.entry])
    })
  )
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const hold = over.hold ?? { gate: Deferred.makeUnsafe<void>(), started: Deferred.makeUnsafe<void>() }
  const base = Layer.mergeAll(functions, noFileLayer({ limit: over.limit ?? 30_000 }), asking, sandboxOf(hold.gate, hold.started)).pipe(Layer.provideMerge(memory))
  const withApprovals = over.approvals ?? true
  const turns = Turns.layer({ head: head([RESULT, SEND]) }).pipe(
    Layer.provide(withApprovals ? Approvals.source : Layer.empty),
    Layer.provideMerge(base)
  )
  const all = withApprovals
    ? (over.twice === true ? Layer.merge(Approvals.layer, Layer.fresh(Approvals.layer)) : Approvals.layer).pipe(Layer.provideMerge(turns))
    : Layer.merge(turns, Layer.succeed(Approvals, Approvals.of({ waiting: Effect.die("no approvals"), answer: () => Effect.die("no approvals") })))
  const logs = over.logs
  const capture = logs === undefined
    ? Layer.empty
    : Logger.layer([Logger.make((line) => {
      const { level, message } = JSON.parse(Logger.formatJson.log(line)) as { level: string; message: unknown }
      logs.push({ level, message })
    })])
  return Effect.runPromise(effect.pipe(Effect.provide(all), Effect.provideService(AskDelay, () => Effect.succeed(0)), Effect.provide(capture)))
}

// `effect` at the time `ms` of Effect's `Clock`: the store keeps it as an
// answer's `answered`, so a case orders its answers with no wait.
const at = (ms: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.clockWith((real) =>
    Effect.provideService(effect, Clock.Clock, Object.assign(Object.create(real) as Clock.Clock, { currentTimeMillisUnsafe: () => ms, currentTimeMillis: Effect.succeed(ms) }))
  )

// A store whose `startApproval` marks `tried[k]` when its k-th call has
// written.
const startsOf = () => {
  const tried = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
  let calls = 0
  const layer = Layer.effect(
    Store,
    Effect.gen(function*() {
      const store = yield* Store
      return Store.of({
        ...store,
        startApproval: (id) => Effect.tap(store.startApproval(id), () => Effect.suspend(() => Deferred.succeed(tried[calls++] ?? Deferred.makeUnsafe<void>(), undefined)))
      })
    })
  )
  return { tried, layer }
}

// A store whose `endApproval` marks `ended` when it has written.
const endsOf = () => {
  const ended = Deferred.makeUnsafe<void>()
  const layer = Layer.effect(
    Store,
    Effect.gen(function*() {
      const store = yield* Store
      return Store.of({ ...store, endApproval: (id, end) => Effect.tap(store.endApproval(id, end), () => Deferred.succeed(ended, undefined)) })
    })
  )
  return { ended, layer }
}

interface Row {
  readonly n: number
  readonly call: number
  readonly turn: number
  readonly fn: string
  readonly input: string
  readonly status: string
  readonly who: string | null
  readonly answer: string | null
  readonly output: string | null
  readonly msg: number | null
}
const approvals = (file: string) => rows<Row>(file, "select n, call, turn, fn, input, status, who, answer, output, msg from everchat_approval order by n")
const calls = (file: string) => rows<{ n: number; parent: number | null; status: string; output: string | null }>(file, "select n, parent, status, output from everchat_call order by n")
const messages = (file: string) => rows<{ i: number; kind: string; text: string; turn: number | null }>(file, "select i, kind, text, turn from everchat_msg_read order by i")
const turnRows = (file: string) => rows<{ n: number; status: string; first_msg: number }>(file, "select n, status, first_msg from everchat_turn order by n")

// A first turn whose program makes approval 1, then the chat is idle.
const pendOne = Effect.gen(function*() {
  const turns = yield* Turns
  yield* turns.say("send it")
  yield* turns.idle
})

// The approval's row is older than its 7 days.
const age = (file: string) => write(file, "update everchat_approval set created = created - ?", [WAIT + 1])

const YES = { yes: true, who: "Ada" } as const

test("a yes: the function runs one time with the recorded arguments; the row is done; a late message starts a turn under LATE with the result and is the row's msg; the call stays pending, and result(call) gives the output", async () => {
  const file = newFile()
  const wire = wireOf("send")
  const fn = gated()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* pendOne
    const service = yield* Approvals
    assert.deepStrictEqual((yield* service.waiting).map((one) => [one.id, one.status]), [[1, "pending"]])
    const got = yield* service.answer(1, YES)
    assert.equal(got._tag, "answered")
    yield* Deferred.await(wire.late)
    yield* (yield* Turns).idle
    assert.deepStrictEqual(yield* service.waiting, [])
    // result(<call>) reads the run's output from the approval.
    const [row] = approvals(file)
    const functions = yield* Functions
    assert.equal(yield* functions.call("result", [row!.call], { turn: 1, program: 1, call: 99 }), "{\"sent\":true,\"to\":\"ada@example.com\"}")
  }))
  assert.equal(fn.state.runs.length, 1)
  assert.deepStrictEqual(fn.state.runs[0]!.args, ARGS)
  const [row] = approvals(file)
  assert.deepStrictEqual({ ...row, msg: null }, { n: 1, call: 2, turn: 1, fn: SEND.name, input: INPUT, status: "done", who: "Ada", answer: null, output: "{\"sent\":true,\"to\":\"ada@example.com\"}", msg: null })
  // The caller: the turn, the program and the call of the recorded row.
  assert.deepStrictEqual(fn.state.runs[0]!.caller, { turn: 1, program: 1, call: 2 })
  // The call's row is still pending, with what the program got.
  assert.deepStrictEqual(calls(file).find((one) => one.n === 2), { n: 2, parent: 1, status: "pending", output: JSON.stringify(pending(1)) })
  // The late message: its turn, its text, and the row's msg.
  const late = messages(file).filter((one) => one.kind === "late")
  assert.equal(late.length, 1)
  assert.equal(row!.msg, late[0]!.i)
  const text = "Approval 1: acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"}) ran after a yes by Ada.\nResult:\n{\"sent\":true,\"to\":\"ada@example.com\"}"
  assert.equal(late[0]!.text, text)
  const lateTurn = turnRows(file).find((one) => one.first_msg === late[0]!.i)
  assert.ok(lateTurn !== undefined)
  const asked = wire.sent.find((one) => firstText(one).startsWith(LATE))
  assert.equal(firstText(asked), LATE + text)
})

test("a yes while a turn runs: the run ends, and its message is logged only after that turn's end", async () => {
  const file = newFile()
  const ends = endsOf()
  const hold = { gate: Deferred.makeUnsafe<void>(), started: Deferred.makeUnsafe<void>() }
  const wire = wireOf("send", "hold")
  const fn = gated()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* pendOne
    const turns = yield* Turns
    yield* turns.say("hold on")
    yield* Deferred.await(hold.started)
    yield* (yield* Approvals).answer(1, YES)
    yield* Deferred.await(ends.ended)
    // The run has ended while turn 2 runs: no late message yet.
    assert.equal(approvals(file)[0]!.status, "done")
    assert.deepStrictEqual(messages(file).filter((one) => one.kind === "late"), [])
    assert.equal(yield* turns.busy, true)
    yield* Deferred.succeed(hold.gate, undefined)
    yield* Deferred.await(wire.late)
    yield* turns.idle
  }), { store: ends.layer, hold })
  assert.equal(fn.state.runs.length, 1)
  const log = messages(file)
  const late = log.find((one) => one.kind === "late")!
  // Turn 2's own reply is before it; the late message starts turn 3.
  const second = log.filter((one) => one.turn === 2)
  assert.ok(second.length > 0 && second.every((one) => one.i < late.i))
  assert.deepStrictEqual(turnRows(file).map((one) => [one.n, one.status, one.first_msg === late.i]), [[1, "done", false], [2, "done", false], [3, "done", true]])
  assert.equal(approvals(file)[0]!.msg, late.i)
})

for (const words of [undefined, "Not to Ada, please."]) {
  test(`a no${words === undefined ? "" : ", with words"}: nothing runs; the note is logged and is the row's msg; no turn starts`, async () => {
    const file = newFile()
    const wire = wireOf("send")
    const fn = gated()
    await launch(file, wire, fn, Effect.gen(function*() {
      yield* pendOne
      const got = yield* (yield* Approvals).answer(1, { yes: false, who: "Ada", ...(words === undefined ? {} : { text: words }) })
      assert.equal(got._tag, "answered")
      yield* (yield* Turns).idle
    }))
    assert.equal(fn.state.runs.length, 0)
    const [row] = approvals(file)
    assert.equal(row!.status, "no")
    const note = messages(file).at(-1)!
    assert.equal(note.kind, "note")
    assert.equal(note.text, "Approval 1: Ada said no to acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"})." + (words === undefined ? "" : " \"" + words + "\""))
    assert.equal(row!.msg, note.i)
    assert.equal(turnRows(file).length, 1)
    assert.equal(wire.sent.length, 2)
  })
}

test("a second answer, and two answers at one time: one is kept, the other is closed, and the function runs one time", async () => {
  const file = newFile()
  const wire = wireOf("send", "send")
  const fn = gated()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* pendOne
    yield* pendOne
    const approvals = yield* Approvals
    // Approval 1: a yes and a no at one time.
    const both = yield* Effect.all([approvals.answer(1, YES), approvals.answer(1, { yes: false, who: "Bo" })], { concurrency: "unbounded" })
    assert.deepStrictEqual(both.map((one) => one._tag).sort(), ["answered", "closed"])
    // Approval 2: two yeses at one time, then a third.
    const yeses = yield* Effect.all([approvals.answer(2, YES), approvals.answer(2, { yes: true, who: "Bo" })], { concurrency: "unbounded" })
    assert.deepStrictEqual(yeses.map((one) => one._tag).sort(), ["answered", "closed"])
    assert.equal((yield* approvals.answer(2, YES))._tag, "closed")
    // A late turn for each run: two when approval 1 kept its yes.
    const kept = both.find((one) => one._tag === "answered")
    const expected = kept?._tag === "answered" && kept.approval.status === "yes" ? 2 : 1
    for (let k = 0; k < expected; k++) yield* Deferred.await(wire.lates[k]!)
    yield* (yield* Turns).idle
  }))
  const [one, two] = approvals(file)
  // Approval 2 ran one time; approval 1 ran at most one time, as its kept answer says.
  assert.equal(two!.status, "done")
  assert.equal(fn.state.runs.filter((run) => run.caller.call === two!.call).length, 1)
  assert.equal(fn.state.runs.filter((run) => run.caller.call === one!.call).length, one!.status === "done" ? 1 : 0)
  assert.equal(fn.state.runs.length, one!.status === "done" ? 2 : 1)
})

test("an expiry at an answer: the answer is not kept, the expiry's note is logged and is the row's msg, nothing runs", async () => {
  const file = newFile()
  const wire = wireOf("send")
  const fn = gated()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* pendOne
    age(file)
    const got = yield* (yield* Approvals).answer(1, YES)
    assert.equal(got._tag, "expired")
    yield* (yield* Turns).idle
  }))
  assert.equal(fn.state.runs.length, 0)
  const [row] = approvals(file)
  assert.deepStrictEqual([row!.status, row!.who], ["expired", null])
  const note = messages(file).at(-1)!
  assert.deepStrictEqual([note.kind, note.text], ["note", "Approval 1 expired after 7 days with no answer: acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"}). The call did not run."])
  assert.equal(row!.msg, note.i)
  assert.equal(turnRows(file).length, 1)
})

test("an expiry at a load: the note, nothing runs", async () => {
  const file = newFile()
  const fn = gated()
  await launch(file, wireOf("send"), fn, pendOne)
  age(file)
  await launch(file, wireOf(), fn, Effect.gen(function*() {
    assert.deepStrictEqual(yield* (yield* Approvals).waiting, [])
  }))
  assert.equal(fn.state.runs.length, 0)
  const [row] = approvals(file)
  assert.equal(row!.status, "expired")
  const note = messages(file).at(-1)!
  assert.equal(note.text, "Approval 1 expired after 7 days with no answer: acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"}). The call did not run.")
  assert.equal(row!.msg, note.i)
})

test("a load with a running row (a crash during the run): it becomes cut, its late message says so, and the function does not run again", async () => {
  const file = newFile()
  const fn = gated()
  // A launch with no approvals' layer: the answer and the run's start as a
  // launch that crashed would leave them.
  await launch(file, wireOf("send"), fn, Effect.gen(function*() {
    yield* pendOne
    const store = yield* Store
    assert.equal((yield* store.answerApproval(1, YES))._tag, "answered")
    assert.equal((yield* store.startApproval(1))._tag, "Some")
  }), { approvals: false })
  const wire = wireOf()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* Deferred.await(wire.late)
    yield* (yield* Turns).idle
  }))
  assert.equal(fn.state.runs.length, 0)
  const [row] = approvals(file)
  assert.deepStrictEqual([row!.status, row!.output], ["cut", CUT_RUN])
  const late = messages(file).find((one) => one.kind === "late")!
  assert.equal(late.text, "Approval 1: acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"}) ran after a yes by Ada.\n" + CUT_RUN)
  assert.equal(row!.msg, late.i)
  // A third launch runs nothing and tells nothing again.
  await launch(file, wireOf(), fn, Effect.void)
  assert.equal(fn.state.runs.length, 0)
  assert.equal(messages(file).filter((one) => one.kind === "late").length, 1)
})

test("a load with a yes row (a stop between the answer and the run): it runs one time, and a later load runs it no more", async () => {
  const file = newFile()
  const fn = gated()
  await launch(file, wireOf("send"), fn, Effect.gen(function*() {
    yield* pendOne
    assert.equal((yield* (yield* Store).answerApproval(1, YES))._tag, "answered")
  }), { approvals: false })
  const wire = wireOf()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* Deferred.await(wire.late)
    yield* (yield* Turns).idle
  }))
  assert.equal(fn.state.runs.length, 1)
  assert.deepStrictEqual(fn.state.runs[0]!.args, ARGS)
  assert.equal(approvals(file)[0]!.status, "done")
  await launch(file, wireOf(), fn, Effect.void)
  assert.equal(fn.state.runs.length, 1)
})

for (const [mode, message] of [["fail", "The mail server refused it."], ["die", "EverChat failed in this function: Error: boom"]] as const) {
  test(`a function that ${mode === "fail" ? "fails" : "dies"}: the row is failed with the message, and the late message says so`, async () => {
    const file = newFile()
    const wire = wireOf("send")
    const fn = gated(mode)
    await launch(file, wire, fn, Effect.gen(function*() {
      yield* pendOne
      yield* (yield* Approvals).answer(1, YES)
      yield* Deferred.await(wire.late)
      yield* (yield* Turns).idle
    }))
    assert.equal(fn.state.runs.length, 1)
    const [row] = approvals(file)
    assert.deepStrictEqual([row!.status, row!.output], ["failed", message])
    const late = messages(file).find((one) => one.kind === "late")!
    assert.equal(late.text, "Approval 1: acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"}) ran after a yes by Ada.\nIt failed:\n" + message)
    assert.equal(row!.msg, late.i)
  })
}

test("a result over the limit: the late message has its head, its tail and the line of result; result(call, from, to) reads the rest", async () => {
  const file = newFile()
  const wire = wireOf("send")
  const fn = gated("long")
  const whole = "HEAD-" + "m".repeat(6_000) + "-TAIL"
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* pendOne
    yield* (yield* Approvals).answer(1, YES)
    yield* Deferred.await(wire.late)
    yield* (yield* Turns).idle
    const call = approvals(file)[0]!.call
    const functions = yield* Functions
    assert.equal(yield* functions.call("result", [call, 2_000, 2_010], { turn: 1, program: 1, call: 99 }), whole.slice(2_000, 2_010))
    assert.equal(yield* functions.call("result", [call], { turn: 1, program: 1, call: 99 }), whole)
  }), { limit: 2_000 })
  const [row] = approvals(file)
  assert.equal(row!.output, whole)
  const late = messages(file).filter((one) => one.kind === "late").map((one) => one.text).join("")
  assert.ok(late.includes("Result:\nHEAD-m"))
  assert.ok(late.endsWith("m-TAIL"))
  assert.ok(late.includes("result(" + row!.call + ", from, to)"))
  assert.ok(late.length < whole.length)
})

test("result(call) of a pending call before its run's end, after a no, and after an expiry: an error that says which", async () => {
  const file = newFile()
  const fn = gated()
  await launch(file, wireOf("send", "send", "send"), fn, Effect.gen(function*() {
    yield* pendOne
    yield* pendOne
    yield* pendOne
    const approvals = yield* Approvals
    const functions = yield* Functions
    const [one, two, three] = yield* approvals.waiting
    const error = (call: number) => Effect.flip(functions.call("result", [call], { turn: 1, program: 1, call: 99 })).pipe(Effect.map((e) => e.message))
    assert.equal(yield* error(one!.call), "Call " + one!.call + " waits for approval 1: it has no result yet.")
    yield* approvals.answer(2, { yes: false, who: "Ada" })
    assert.equal(yield* error(two!.call), "Call " + two!.call + " did not run: the person said no to approval 2.")
    age(file)
    yield* approvals.answer(3, YES)
    assert.equal(yield* error(three!.call), "Call " + three!.call + " did not run: approval 3 expired with no answer.")
  }))
  assert.equal(fn.state.runs.length, 0)
})

test("the unload: the layer's scope ends while a run is at work, and the row is cut; the next load tells it, and runs nothing", async () => {
  const file = newFile()
  const fn = gated("hold")
  await launch(file, wireOf("send"), fn, Effect.gen(function*() {
    yield* pendOne
    yield* (yield* Approvals).answer(1, YES)
    yield* Deferred.await(fn.state.started)
    assert.equal(approvals(file)[0]!.status, "running")
  }))
  const [row] = approvals(file)
  assert.deepStrictEqual([row!.status, row!.output, row!.msg], ["cut", CUT_RUN, null])
  assert.equal(fn.state.runs.length, 1)
  const wire = wireOf()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* Deferred.await(wire.late)
    yield* (yield* Turns).idle
  }))
  assert.equal(fn.state.runs.length, 1)
  assert.equal(approvals(file)[0]!.msg, messages(file).find((one) => one.kind === "late")!.i)
})

test("two loads at one time see one yes row: each worker reads it as yes, each tries its run, and the function runs one time", async () => {
  const file = newFile()
  const fn = gated()
  await launch(file, wireOf("send"), fn, Effect.gen(function*() {
    yield* pendOne
    assert.equal((yield* (yield* Store).answerApproval(1, YES))._tag, "answered")
  }), { approvals: false })
  // Each worker's first read of the yes rows waits for the other's: both
  // see row 1 as yes before either tries to start it.
  const both = Deferred.makeUnsafe<void>()
  let reads = 0
  const starts = startsOf()
  const barrier = Layer.effect(
    Store,
    Effect.gen(function*() {
      const store = yield* Store
      return Store.of({
        ...store,
        approvals: (statuses) =>
          Effect.tap(store.approvals(statuses), (got) =>
            statuses?.includes("yes") === true && got.length > 0 && reads < 2
              ? Effect.suspend(() => (++reads === 2 ? Deferred.succeed(both, undefined) : Deferred.await(both)))
              : Effect.void)
      })
    })
  )
  const wire = wireOf()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* Deferred.await(starts.tried[0]!)
    yield* Deferred.await(starts.tried[1]!)
    yield* Deferred.await(wire.late)
    yield* (yield* Turns).idle
  }), { twice: true, store: Layer.provide(starts.layer, barrier) })
  assert.equal(reads, 2)
  assert.equal(fn.state.runs.length, 1)
  assert.equal(approvals(file)[0]!.status, "done")
  assert.equal(messages(file).filter((one) => one.kind === "late").length, 1)
})

test("the source offers only a run's end: a no, an expiry, a pending and a yes row that are not told are never a late message", async () => {
  const file = newFile()
  const fn = gated()
  await launch(file, wireOf("send", "send", "send", "send", "send"), fn, Effect.gen(function*() {
    for (let k = 0; k < 5; k++) yield* pendOne
    const store = yield* Store
    // 1: no; 2: expired; 3: pending; 4: yes; 5: done. None is told.
    yield* store.answerApproval(1, { yes: false, who: "Ada" })
    yield* store.answerApproval(4, YES)
    yield* store.answerApproval(5, YES)
    yield* store.startApproval(5)
    yield* store.endApproval(5, { status: "done", output: "sent" })
    write(file, "update everchat_approval set created = created - ? where n = 2", [WAIT + 1])
    assert.deepStrictEqual((yield* store.expireApprovals()).map((one) => one.id), [2])
    const source = yield* Effect.provide(
      Effect.gen(function*() {
        return yield* Source
      }),
      Approvals.source.pipe(Layer.provide(Layer.merge(Layer.succeed(Store, store), noFileLayer())))
    )
    const offer = yield* source.next
    assert.equal(offer?.kind, "late")
    assert.equal(offer?.text, "Approval 5: acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"}) ran after a yes by Ada.\nResult:\nsent")
    // Told (the write marks the row; it reads no turn): the source has
    // nothing more, though 1 and 2 are not told.
    const page = (yield* store.messages(0, 1))[0]!
    yield* offer!.write(page, undefined as never)
    assert.equal(yield* source.next, null)
    assert.deepStrictEqual((yield* store.untoldApprovals()).map((one) => [one.id, one.status]), [[1, "no"], [2, "expired"]])
  }), { approvals: false })
  assert.equal(fn.state.runs.length, 0)
})

// The calls of the rows `ns`, in that order.
const callsOf = (file: string, ns: ReadonlyArray<number>) => ns.map((n) => approvals(file).find((one) => one.n === n)!.call)

test("a load with two yes rows, 2 answered before 1: the calls run in the order of the answers", async () => {
  const file = newFile()
  const fn = gated()
  await launch(file, wireOf("send", "send"), fn, Effect.gen(function*() {
    yield* pendOne
    yield* pendOne
    const store = yield* Store
    const now = yield* Clock.currentTimeMillis
    assert.equal((yield* at(now + 1_000)(store.answerApproval(2, YES)))._tag, "answered")
    assert.equal((yield* at(now + 2_000)(store.answerApproval(1, YES)))._tag, "answered")
  }), { approvals: false })
  const wire = wireOf()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* Deferred.await(wire.lates[1]!)
    yield* (yield* Turns).idle
  }))
  assert.deepStrictEqual(fn.state.runs.map((one) => one.caller.call), callsOf(file, [2, 1]))
  assert.deepStrictEqual(approvals(file).map((one) => one.status), ["done", "done"])
})

test("in a launch, with the worker held in a run: a yes for 3, then a yes for 2, wait and then run as 3, then 2, one at a time; two rows with one answered time run by their numbers", async () => {
  const file = newFile()
  const fn = gated("hold")
  fn.state.gates = Array.from({ length: 5 }, () => Deferred.makeUnsafe<void>())
  const wire = wireOf("send", "send", "send", "send", "send")
  await launch(file, wire, fn, Effect.gen(function*() {
    for (let k = 0; k < 5; k++) yield* pendOne
    const service = yield* Approvals
    yield* service.answer(1, YES)
    yield* Deferred.await(fn.state.starts[0]!)
    const now = yield* Clock.currentTimeMillis
    yield* at(now + 1_000)(service.answer(3, YES))
    yield* at(now + 2_000)(service.answer(2, YES))
    // 5 before 4, at one time.
    yield* at(now + 3_000)(service.answer(5, YES))
    yield* at(now + 3_000)(service.answer(4, YES))
    // The first run is held: a turn of the person runs to its end, and no
    // other run has started.
    const turns = yield* Turns
    yield* turns.say("Are you there?")
    yield* turns.idle
    assert.equal(fn.state.runs.length, 1)
    assert.deepStrictEqual(approvals(file).map((one) => one.status), ["running", "yes", "yes", "yes", "yes"])
    yield* Deferred.succeed(fn.state.gates[0]!, undefined)
    // 3's run is held: after the late turn of 1 and a turn of the person,
    // 2 is still yes.
    yield* Deferred.await(fn.state.starts[1]!)
    yield* Deferred.await(wire.lates[0]!)
    yield* turns.say("And now?")
    yield* turns.idle
    assert.equal(fn.state.runs.length, 2)
    assert.deepStrictEqual(approvals(file).map((one) => one.status), ["done", "yes", "running", "yes", "yes"])
    yield* Deferred.succeed(fn.state.gates[1]!, undefined)
    // 2 starts only after 3 is done.
    yield* Deferred.await(fn.state.starts[2]!)
    assert.equal(fn.state.runs.length, 3)
    assert.deepStrictEqual(approvals(file).map((one) => one.status), ["done", "running", "done", "yes", "yes"])
    for (const gate of fn.state.gates) yield* Deferred.succeed(gate, undefined)
    yield* Deferred.await(wire.lates[4]!)
    yield* turns.idle
  }).pipe(Effect.ensuring(Effect.forEach(fn.state.gates, (gate) => Deferred.succeed(gate, undefined)))))
  assert.deepStrictEqual(fn.state.runs.map((one) => one.caller.call), callsOf(file, [1, 3, 2, 4, 5]))
  assert.deepStrictEqual(approvals(file).map((one) => one.status), ["done", "done", "done", "done", "done"])
})

test("a read of the worker that fails once: a diagnostic, nothing runs, and the next wake runs the row", async () => {
  const file = newFile()
  const fn = gated()
  await launch(file, wireOf("send", "send"), fn, Effect.gen(function*() {
    yield* pendOne
    yield* pendOne
    assert.equal((yield* (yield* Store).answerApproval(1, YES))._tag, "answered")
  }), { approvals: false })
  // The first read of the yes rows fails.
  const failed = Deferred.makeUnsafe<void>()
  let fail = true
  const refusing = Layer.effect(
    Store,
    Effect.gen(function*() {
      const store = yield* Store
      return Store.of({
        ...store,
        approvals: (statuses) =>
          Effect.suspend(() => {
            if (statuses?.includes("yes") !== true || !fail) return store.approvals(statuses)
            fail = false
            return Effect.andThen(Deferred.succeed(failed, undefined), Effect.fail(new StoreError({ op: "approvals", cause: new Error("refused") })))
          })
      })
    })
  )
  const logs: Array<{ readonly level: string; readonly message: unknown }> = []
  const wire = wireOf()
  await launch(file, wire, fn, Effect.gen(function*() {
    yield* Deferred.await(failed)
    assert.equal(fn.state.runs.length, 0)
    assert.equal(approvals(file)[0]!.status, "yes")
    // The next wake: a yes for 2.
    yield* (yield* Approvals).answer(2, YES)
    yield* Deferred.await(wire.lates[1]!)
    yield* (yield* Turns).idle
  }), { store: refusing, logs })
  assert.deepStrictEqual(fn.state.runs.map((one) => one.caller.call), callsOf(file, [1, 2]))
  assert.deepStrictEqual(approvals(file).map((one) => one.status), ["done", "done"])
  assert.deepStrictEqual(
    logs.filter((line) => line.level === "ERROR").map((line) => line.message),
    ["the approvals said yes to were not run: the next answer or load tries again"]
  )
})

for (const kind of ["no", "expiry"] as const) {
  test(`${kind === "no" ? "a no" : "an expiry"} whose tellApproval fails once: no note in the log and msg null; after the next load, the note one time, and msg is its page`, async () => {
    const file = newFile()
    const fn = gated()
    let fail = true
    const refusing = Layer.effect(
      Store,
      Effect.gen(function*() {
        const store = yield* Store
        return Store.of({
          ...store,
          tellApproval: (n, msg) =>
            Effect.suspend(() => {
              if (!fail) return store.tellApproval(n, msg)
              fail = false
              return Effect.fail(new StoreError({ op: "tellApproval", cause: new Error("refused") }))
            })
        })
      })
    )
    const text = kind === "no"
      ? "Approval 1: Ada said no to acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"})."
      : "Approval 1 expired after 7 days with no answer: acme.send({\"to\":\"ada@example.com\",\"text\":\"hello\"}). The call did not run."
    const notes = () => messages(file).filter((one) => one.kind === "note" && one.text === text)
    await launch(file, wireOf("send"), fn, Effect.gen(function*() {
      yield* pendOne
      if (kind === "expiry") age(file)
      const got = yield* (yield* Approvals).answer(1, kind === "no" ? { yes: false, who: "Ada" } : YES)
      assert.equal(got._tag, kind === "no" ? "answered" : "expired")
      assert.deepStrictEqual(notes(), [])
      assert.equal(approvals(file)[0]!.msg, null)
    }), { store: refusing })
    assert.deepStrictEqual(notes(), [])
    assert.deepStrictEqual([approvals(file)[0]!.status, approvals(file)[0]!.msg], [kind === "no" ? "no" : "expired", null])
    await launch(file, wireOf(), fn, Effect.void)
    const told = notes()
    assert.equal(told.length, 1)
    assert.equal(approvals(file)[0]!.msg, told[0]!.i)
    // A third load tells it no more.
    await launch(file, wireOf(), fn, Effect.void)
    assert.equal(notes().length, 1)
    assert.equal(fn.state.runs.length, 0)
  })
}
