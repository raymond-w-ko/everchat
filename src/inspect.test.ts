// Tests of what the inspector shows, as data: read from a chat that a fake
// wire made, by a process that does not own the database (`Reads`).

import { expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import * as os from "node:os"
import { compactor, fakeWire, newFile, options, reply, wireError, withChat, withMemory, withStore, write } from "../tests/help.ts"
import * as Diagnostics from "./diagnostics.ts"
import { head } from "./head.ts"
import { CELLS, Inspect, type ItemShown, ROWS } from "./inspect.ts"
import { Memory, NODE } from "./memory.ts"
import { body } from "./openai.ts"
import type { Reply, Request } from "./request.ts"
import { ProcessAlive, Reads, Store } from "./store.ts"
import { HEAD, Turns } from "./turn.ts"

// Asks the inspector about the chat in `file`, as a process of its own.
const inspect = <A, E>(file: string, ask: (inspect: Inspect["Service"]) => Effect.Effect<A, E>, alive = false) =>
  Effect.runPromise(
    Inspect.use(ask).pipe(Effect.provide(Inspect.layer.pipe(Layer.provide(Reads.layer(file)))), Effect.provideService(ProcessAlive, () => alive))
  )

const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }],
    usage: { input: 900, cacheRead: 0, cacheWrite: 800, output: 20, searches: 0 }
  })

const says = (asked: Request, text: string): Reply =>
  reply(asked, {
    text,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input: 50, cacheRead: 900, cacheWrite: 0, output: 7, searches: 0 }
  })

const LONG = "A long message. ".repeat(40) // 640 bytes: its leaf needs a compaction

// A chat of two turns. The first has a program between two steps. The
// second starts with a long message. It gives the requests that were sent.
const chat = async (file: string) => {
  const wire = fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "return 1 + 1") : says(asked, n === 2 ? "It is 2." : "I read it.")))
  await withChat(
    file,
    wire,
    () => Effect.succeed({ output: "2", failed: false }),
    Effect.gen(function*() {
      const turns = yield* Turns
      const memory = yield* Memory
      yield* turns.say("what is 1 + 1?")
      yield* turns.idle
      yield* turns.say(LONG)
      yield* turns.idle
      yield* memory.idle
    }),
    (_, node) => ({ text: "the summary of " + node.l + "/" + node.i, usage: { pick: options().pick, input: 300, cacheRead: 0, cacheWrite: 0, output: 12 } })
  )
  return wire.sent
}

test("the overview: the count, the levels, the roots, the views, and the sums of the usage", async () => {
  const file = newFile()
  await chat(file)
  const overview = await inspect(file, (ask) => ask.overview)
  // user, tool, echo, asst, user, asst
  expect(overview.count).toBe(6)
  expect(overview.node).toBe(NODE)
  expect(overview.levels).toEqual([{ l: 0, built: 6, whole: 6 }, { l: 1, built: 3, whole: 3 }, { l: 2, built: 1, whole: 1 }])
  expect(overview.roots).toEqual([{ l: 2, i: 0, built: true }, { l: 1, i: 2, built: true }])
  expect(overview.views.map((view) => [view.name, view.kept, view.parts, view.end, view.batch])).toEqual([["chat", 0, 6, 6, false], ["seen", 0, 6, 6, false]])
  expect(overview.views[0]!.high).toBe(128000)
  expect(overview.views[0]!.size).toBeGreaterThan(0)
  expect(overview.turn).toBe(null)
  // The launch ended, so it is not live, whatever its process does.
  expect(overview.launch?.why).toBe("exit")
  expect(overview.live).toBe(false)
  expect(overview.chat.pick.model).toBe("gpt-test")
  const total = (served: string) => overview.usage.find((one) => one.served === served)
  expect(total("turn")).toEqual({ served: "turn", requests: 3, input: 1000, cacheRead: 1800, cacheWrite: 800, output: 34 })
  expect(total("compaction")?.requests).toBeGreaterThan(0)
})

test("a launch that did not end is live only while its process runs on this host", async () => {
  const file = newFile()
  await chat(file)
  // A launch that ended is not live, also when a process has its number again.
  write(file, "update launch set host = ?", [os.hostname()])
  expect((await inspect(file, (ask) => ask.overview, true)).live).toBe(false)
  write(file, "update launch set ended = null, why = null")
  expect((await inspect(file, (ask) => ask.overview, true)).live).toBe(true)
  expect((await inspect(file, (ask) => ask.overview, false)).live).toBe(false)
  write(file, "update launch set host = 'another-host'")
  expect((await inspect(file, (ask) => ask.overview, true)).live).toBe(false)
})

test("a node says what it was built from, and whether a compaction wrote it", async () => {
  const file = newFile()
  await chat(file)
  // A short message is its own leaf.
  const short = (await inspect(file, (ask) => ask.node(0, 0)))!
  expect(short.ref).toBe("0+1")
  expect([short.first, short.last]).toEqual([0, 0])
  expect(short.message?.text).toBe("what is 1 + 1?")
  expect(short.source).toBe("user: what is 1 + 1?")
  expect(short.node?.text).toBe("user: what is 1 + 1?")
  expect(short.how).toBe("source")
  expect(short.requests).toEqual([])
  expect(short.halves).toEqual([])
  expect(short.above).toEqual({ l: 1, i: 0, built: true })
  expect([short.chat, short.seen]).toEqual([true, true])
  // A long message has a summary, and the request that wrote it.
  const long = (await inspect(file, (ask) => ask.node(0, 4)))!
  expect(long.source).toBe("user: " + LONG)
  expect(long.node?.text).toBe("the summary of 0/4")
  expect(long.how).toBe("summary")
  expect(long.requests.map((one) => [one.served, one.node, one.input, one.output])).toEqual([["compaction", [0, 4], 300, 12]])
  // A higher node's source is the lines of its halves.
  const pair = (await inspect(file, (ask) => ask.node(1, 0)))!
  expect(pair.ref).toBe("0+2")
  expect([pair.first, pair.last]).toEqual([0, 1])
  expect(pair.source).toBe("user: what is 1 + 1?\ntool: return 1 + 1")
  expect(pair.how).toBe("source")
  expect(pair.halves).toEqual([{ l: 0, i: 0, built: true }, { l: 0, i: 1, built: true }])
  expect(pair.message).toBe(null)
  expect([pair.chat, pair.seen]).toEqual([false, false])
  // A root has no node above it. The chat has no node for messages that are not there.
  expect((await inspect(file, (ask) => ask.node(2, 0)))!.above).toBe(null)
  expect(await inspect(file, (ask) => ask.node(3, 0))).toBe(null)
  expect(await inspect(file, (ask) => ask.node(0, 6))).toBe(null)
  expect(await inspect(file, (ask) => ask.node(0, 0.5))).toBe(null)
  expect(await inspect(file, (ask) => ask.node(-1, 0))).toBe(null)
  expect(await inspect(file, (ask) => ask.node(0.5, 0))).toBe(null)
  expect(await inspect(file, (ask) => ask.node(31, 0))).toBe(null)
})

test("a node whose compaction gave no line is its source, cut, and a node not built has no text", async () => {
  const file = newFile()
  const release = Effect.runSync(Deferred.make<void>())
  await withMemory(
    file,
    // The first long message gets no line. The second one waits.
    compactor((_, node) => (node.l > 0 ? "both" : node.i === 0 ? "" : Effect.as(Deferred.await(release), { text: "late" }))),
    Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.push([{ kind: "user", text: LONG }, { kind: "user", text: LONG }])
      yield* memory.settle(1)
      const cut = (yield* Effect.promise(() => inspect(file, (ask) => ask.node(0, 0))))!
      expect(cut.how).toBe("cut")
      expect(cut.node?.size).toBeLessThanOrEqual(NODE)
      expect(("user: " + LONG).startsWith(cut.node!.text)).toBe(true)
      const waits = (yield* Effect.promise(() => inspect(file, (ask) => ask.node(0, 1))))!
      expect([waits.node, waits.how]).toEqual([null, null])
      expect(waits.source).toBe("user: " + LONG)
      const above = (yield* Effect.promise(() => inspect(file, (ask) => ask.node(1, 0))))!
      expect([above.node, above.source, above.how]).toEqual([null, null, null])
      expect(above.halves).toEqual([{ l: 0, i: 0, built: true }, { l: 0, i: 1, built: false }])
      // The overview and the window show the same hole.
      const overview = yield* Effect.promise(() => inspect(file, (ask) => ask.overview))
      expect(overview.levels).toEqual([{ l: 0, built: 1, whole: 2 }, { l: 1, built: 0, whole: 1 }])
      expect(overview.roots).toEqual([{ l: 1, i: 0, built: false }])
      const window = yield* Effect.promise(() => inspect(file, (ask) => ask.window(0, 2)))
      expect(window.nodes.map((node) => [node.l, node.i])).toEqual([[0, 0]])
      // The chat view goes to the last message. The compaction view ends before the leaf that is not built.
      const state = yield* memory.state
      expect([window.chat, window.seen]).toEqual([[[0, 0], [0, 1]], [[0, 0]]])
      expect([window.chat, window.seen]).toEqual([state.view.parts, state.seen.parts])
      const chat = yield* Effect.promise(() => inspect(file, (ask) => ask.view("chat")))
      expect(chat.lines.map((one) => [one.i, one.text === null])).toEqual([[0, false], [1, true]])
      expect([chat.end, chat.size]).toEqual([2, state.view.size])
      // A part that is not built is not in a request.
      expect(chat.blocks).toEqual(yield* memory.view())
      expect(chat.blocks.map((block) => block.text).join("")).not.toContain("1+1|")
      const seen = yield* Effect.promise(() => inspect(file, (ask) => ask.view("seen")))
      expect([seen.lines.map((one) => one.i), seen.end, seen.size]).toEqual([[0], 1, state.seen.size])
      expect([waits.chat, waits.seen, cut.chat, cut.seen]).toEqual([true, false, true, true])
      yield* Deferred.succeed(release, undefined)
      yield* memory.idle
    })
  )
  // The two lines are too long together, so a compaction merged them.
  const merged = (await inspect(file, (ask) => ask.node(1, 0)))!
  expect([merged.node?.text, merged.how, merged.requests.length]).toEqual(["both", "summary", 0])
})

test("a window gives the nodes over a range of messages, and the parts of the views there", async () => {
  const file = newFile()
  await withMemory(file, compactor(() => "a summary"), Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push(Array.from({ length: 40 }, (_, k) => ({ kind: "user" as const, text: "message " + k })))
    yield* memory.idle
  }))
  // A view with merged parts, as a batch leaves it: 32 messages in one node, then 4, then leaves.
  write(file, "update view set parts = ? where name = 'chat'", [JSON.stringify([[5, 0], [2, 8], [0, 36], [0, 37], [0, 38], [0, 39]])])
  const all = await inspect(file, (ask) => ask.window(0, 40))
  expect([all.count, all.from, all.to, all.floor, all.top]).toEqual([40, 0, 40, 0, 5])
  const at = (l: number) => all.nodes.filter((node) => node.l === l).map((node) => node.i)
  expect(at(0)).toEqual(Array.from({ length: 40 }, (_, k) => k))
  expect(at(3)).toEqual([0, 1, 2, 3, 4])
  expect(at(5)).toEqual([0])
  expect(all.chat).toEqual([[5, 0], [2, 8], [0, 36], [0, 37], [0, 38], [0, 39]])
  expect(all.seen.length).toBe(40)
  // A part of the range: only the nodes that cover a message of it.
  const some = await inspect(file, (ask) => ask.window(33, 37, 1))
  expect([some.from, some.to, some.floor]).toEqual([33, 37, 1])
  expect(some.nodes.map((node) => [node.l, node.i])).toEqual([[1, 16], [1, 17], [1, 18], [2, 8], [2, 9], [3, 4]])
  expect(some.chat).toEqual([[2, 8], [0, 36]])
  // A range outside the chat is taken as far as the chat goes.
  const past = await inspect(file, (ask) => ask.window(-5, 1000))
  expect([past.from, past.to]).toEqual([0, 40])
  const none = await inspect(file, (ask) => ask.window(50, 60))
  expect([none.from, none.to, none.nodes.length]).toEqual([40, 40, 0])
  // The view itself: its lines, merged, and its blocks as a request gets them.
  const view = await inspect(file, (ask) => ask.view("chat"))
  expect(view.lines.map((one) => [one.l, one.i])).toEqual([[5, 0], [2, 8], [0, 36], [0, 37], [0, 38], [0, 39]])
  expect(view.end).toBe(40)
  expect(view.blocks.map((block) => block.mark)).toEqual([false, true, false])
  expect(view.blocks[1]!.text.split("\n").slice(0, 4).map((row) => row.split("|")[0])).toEqual(["0+32", "32+4", "36+1", "37+1"])
  expect(view.blocks[2]!.text).toBe("38+1|user: message 38\n39+1|user: message 39\n</chat>\n")
})

test("a wide window starts at a higher level, so that no level has too many nodes", async () => {
  const file = newFile()
  const count = 3 * CELLS
  await withMemory(file, compactor(() => "a summary"), Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push(Array.from({ length: count }, (_, k) => ({ kind: "note" as const, text: "n" + k })))
    yield* memory.idle
  }))
  const all = await inspect(file, (ask) => ask.window(0, count))
  expect(all.floor).toBe(2)
  expect(Math.min(...all.nodes.map((node) => node.l))).toBe(2)
  expect(all.nodes.filter((node) => node.l === 2).length).toBe(count / 4)
  // A range of CELLS messages still starts at the leaves.
  const narrow = await inspect(file, (ask) => ask.window(CELLS, 2 * CELLS))
  expect(narrow.floor).toBe(0)
  expect(narrow.nodes.filter((node) => node.l === 0).length).toBe(CELLS)
  // The messages come at most ROWS at a time.
  const messages = await inspect(file, (ask) => ask.messages(10, count))
  expect([messages.length, messages[0]?.i, messages[0]?.text]).toEqual([ROWS, 10, "n10"])
  expect((await inspect(file, (ask) => ask.messages(count - 2, count + 9))).map((one) => one.i)).toEqual([count - 2, count - 1])
})

test("the view in the database is the view that the memory gives a request", async () => {
  const file = newFile()
  await withMemory(file, compactor(() => "a summary"), Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push(Array.from({ length: 11 }, (_, k) => ({ kind: "user" as const, text: k % 3 === 0 ? LONG : "message " + k })))
    yield* memory.idle
    const view = yield* Effect.promise(() => inspect(file, (ask) => ask.view("chat")))
    expect(view.blocks).toEqual(yield* memory.view())
    expect(view.size).toBe((yield* memory.state).view.size)
    expect(view.lines.length).toBe(11)
    // The database's row is from the launch's start: the 11 leaves came after it.
    expect([view.kept, view.parts]).toEqual([0, 11])
  }))
})

test("a turn's request: the head, the view's lines with their nodes, the steps, the calls, and the usage", async () => {
  const file = newFile()
  const sent = await chat(file)
  const turns = await inspect(file, (ask) => ask.turns(null))
  expect(turns.map((turn) => [turn.id, turn.status, turn.firstMsg, turn.said])).toEqual([[2, "done", 4, LONG.slice(0, 200) + "…"], [1, "done", 0, "what is 1 + 1?"]])
  expect(turns[0]).not.toHaveProperty("head")
  expect((await inspect(file, (ask) => ask.turns(2))).map((turn) => turn.id)).toEqual([1])
  expect((await inspect(file, (ask) => ask.turns(null, 1))).map((turn) => turn.id)).toEqual([2])

  const first = (await inspect(file, (ask) => ask.turn(1)))!
  expect(first.head).toEqual(head())
  expect(first.turn.said).toBe("what is 1 + 1?")
  expect(first.asked).toBe(null)
  expect(first.items.map((one) => one.kind)).toEqual(["user", "turn", "back", "turn"])
  const user = first.items[0] as Extract<ItemShown, { kind: "user" }>
  // The view was empty, and the message goes whole in the last block.
  expect(user.blocks).toEqual([{ text: "<chat>\n", mark: true, lines: [] }, { text: "</chat>\n", mark: false, lines: [] }, { text: HEAD + "what is 1 + 1?", mark: true, lines: null }])
  const step = first.items[1] as Extract<ItemShown, { kind: "turn" }>
  expect(step.step).toBe(1)
  expect(step.calls).toEqual([{ id: "call_1", name: "run", input: "return 1 + 1" }])
  expect(step.output).toEqual([{ type: "custom_tool_call", call_id: "call_1", name: "run", input: "return 1 + 1" }])
  expect([step.usage?.input, step.usage?.cacheWrite]).toEqual([900, 800])
  expect(first.items[2]).toMatchObject({ kind: "back", results: [{ id: "call_1", output: "2" }] })
  const last = first.items[3] as Extract<ItemShown, { kind: "turn" }>
  expect([last.step, last.usage?.cacheRead]).toEqual([2, 900])
  expect(first.calls.map((call) => [call.id, call.fn, call.input, call.output, call.status, call.size, call.ended !== null])).toEqual([[1, "run", "return 1 + 1", "2", "done", 1, true]])
  expect(first.usage.map((one) => one.input)).toEqual([900, 50])

  // The second turn's view holds the first turn, line by line, each with its node.
  const second = (await inspect(file, (ask) => ask.turn(2)))!
  const blocks = (second.items[0] as Extract<ItemShown, { kind: "user" }>).blocks
  expect(blocks.map((block) => block.lines?.length ?? null)).toEqual([0, 4, 0, null])
  expect(blocks[1]!.lines).toEqual([
    { l: 0, i: 0, ref: "0+1", text: "user: what is 1 + 1?" },
    { l: 0, i: 1, ref: "1+1", text: "tool: return 1 + 1" },
    { l: 0, i: 2, ref: "2+1", text: "echo: 2" },
    { l: 0, i: 3, ref: "3+1", text: "asst: It is 2." }
  ])
  expect(blocks[3]!.text).toBe(HEAD + LONG)
  expect(await inspect(file, (ask) => ask.turn(3))).toBe(null)

  // The body of each step's request is the one that the wire builds from what was sent.
  expect(sent.length).toBe(3)
  const built = await inspect(file, (ask) => ask.body(1, 1))
  expect(built).toEqual({ upto: 1, vendor: "openai", body: await Effect.runPromise(body(sent[0]!)), error: null })
  expect((await inspect(file, (ask) => ask.body(1, 3)))!.body).toEqual(await Effect.runPromise(body(sent[1]!)))
  expect((await inspect(file, (ask) => ask.body(2, null)))!.upto).toBe(2)
  expect((await inspect(file, (ask) => ask.body(2, 1)))!.body).toEqual(await Effect.runPromise(body(sent[2]!)))
  expect(await inspect(file, (ask) => ask.body(9, null))).toBe(null)
  // A body that the wire cannot build says why.
  write(file, "update pick set vendor = 'anthropic'")
  expect(await inspect(file, (ask) => ask.body(1, 1))).toEqual({ upto: 1, vendor: "anthropic", body: null, error: 'no wire for the vendor "anthropic"' })
})

test("while a turn runs, another process reads its request, and what is asked now", async () => {
  const file = newFile()
  const held = Effect.runSync(Deferred.make<void>())
  const started = Effect.runSync(Deferred.make<void>())
  await withChat(
    file,
    fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "wait()") : says(asked, "Done."))),
    () => Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(held)
      return { output: "ok", failed: false }
    }),
    Effect.gen(function*() {
      const turns = yield* Turns
      const store = yield* Store
      // The model runs a program, and the program does not end yet.
      yield* turns.say("run it")
      yield* Deferred.await(started)
      // The launch of a test names another host: give it this one.
      write(file, "update launch set host = ?", [os.hostname()])
      const before = yield* store.version
      const running = (yield* Effect.promise(() => inspect(file, (ask) => ask.turn(1), true)))!
      expect(running.turn.status).toBe("running")
      expect(running.items.map((one) => one.kind)).toEqual(["user", "turn"])
      // A program runs: no request is asked.
      expect(running.asked).toBe(null)
      expect(running.calls.map((call) => [call.fn, call.status, call.output, call.ended])).toEqual([["run", "running", null, null]])
      const overview = yield* Effect.promise(() => inspect(file, (ask) => ask.overview, true))
      expect([overview.turn, overview.live, overview.launch?.ended]).toEqual([1, true, null])
      // The reader took nothing from the launch that writes.
      expect(yield* store.version).toBe(before)
      yield* Deferred.succeed(held, undefined)
      yield* turns.idle
    })
  )
  const done = (await inspect(file, (ask) => ask.turn(1)))!
  expect(done.turn.status).toBe("done")
  expect(done.items.map((one) => one.kind)).toEqual(["user", "turn", "back", "turn"])
})

test("a request that is asked now is the turn's items so far", async () => {
  const file = newFile()
  // A turn as a stop of the program leaves it while its first request is asked.
  await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    yield* store.append([{ kind: "user", text: "are you there?" }])
    const turn = yield* store.startTurn({ pick: options().pick, head: JSON.stringify(head()), firstMsg: 0 })
    const blocks = [{ text: "<chat>\n", mark: true }, { text: "</chat>\n", mark: false }, { text: HEAD + "are you there?", mark: true }]
    yield* store.addTurnItem(turn.id, "user", JSON.stringify({ kind: "user", blocks }))
  }))
  const cut = (await inspect(file, (ask) => ask.turn(1)))!
  expect([cut.turn.status, cut.turn.ended, cut.asked]).toEqual(["running", null, 1])
  expect((await inspect(file, (ask) => ask.body(1, null)))!.upto).toBe(1)
})

test("the usage and the diagnostics come newest first, in parts", async () => {
  const file = newFile()
  await chat(file)
  const usage = await inspect(file, (ask) => ask.usage(null))
  expect(usage.length).toBeGreaterThanOrEqual(4)
  expect(usage.map((one) => one.id)).toEqual([...usage.map((one) => one.id)].sort((a, b) => b - a))
  expect(usage.filter((one) => one.served === "turn").map((one) => [one.turn, one.input, one.expected !== null])).toEqual([[2, 50, true], [1, 50, true], [1, 900, true]])
  const older = await inspect(file, (ask) => ask.usage(usage[1]!.id, 2))
  expect(older.map((one) => one.id)).toEqual(usage.slice(2, 4).map((one) => one.id))
  expect((await inspect(file, (ask) => ask.launches())).map((one) => [one.id, one.why])).toEqual([[1, "exit"]])
  expect(await inspect(file, (ask) => ask.diagnostics(5))).toEqual([])
  // After a second launch, the newest launch is the first one, and the overview names it.
  await withStore(file, Effect.logWarning("a warning of the second launch").pipe(Effect.annotateLogs("source", "test"), Effect.provide(Diagnostics.layer)))
  expect((await inspect(file, (ask) => ask.launches())).map((one) => one.id)).toEqual([2, 1])
  expect((await inspect(file, (ask) => ask.launches(1))).map((one) => one.id)).toEqual([2])
  expect((await inspect(file, (ask) => ask.overview)).launch?.id).toBe(2)
  expect((await inspect(file, (ask) => ask.diagnostics(5))).map((one) => [one.level, one.source, one.launch, one.text])).toEqual([["warn", "test", 2, "a warning of the second launch"]])
})

test("a turn that failed at its first request asks nothing now", async () => {
  const file = newFile()
  await withChat(
    file,
    fakeWire(() => wireError("input")),
    () => Effect.die("no program was expected"),
    Effect.gen(function*() {
      const turns = yield* Turns
      yield* turns.say("hello")
      yield* turns.idle
    })
  )
  const failed = (await inspect(file, (ask) => ask.turn(1)))!
  // Its last item is not a reply, as with a request that is asked. But it does not run.
  expect([failed.turn.status, failed.items.map((one) => one.kind), failed.asked]).toEqual(["failed", ["user"], null])
  expect(failed.turn.why).toBe("it failed")
})
