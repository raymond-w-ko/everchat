// Tests of the real compactor and of the head, with a fake wire: the request
// that a compaction sends, and what the memory writes from its reply.

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { fakeWire, newFile, options, reply, rows, wireError } from "../tests/help.ts"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import * as RealCompactor from "./compactor.ts"
import { head, TOOL } from "./head.ts"
import { CompactionRetry, Memory } from "./memory.ts"
import { Schedule } from "effect"
import { Store } from "./store.ts"

const PICK = { vendor: "openai", model: "small", effort: "high", speed: "slow" }

// The memory with the real compactor over a fake wire, in one launch.
const withAll = <A, E>(file: string, wire: ReturnType<typeof fakeWire>, effect: Effect.Effect<A, E, Memory | Store>) => {
  const store = Store.layer(file, options())
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const compactor = RealCompactor.layer({ pick: PICK, rules: "Answer in English." }).pipe(Layer.provide(Layer.merge(asking, store)))
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor))),
      Effect.provideService(AskDelay, () => Effect.succeed(0)),
      Effect.provideService(CompactionRetry, Schedule.spaced("1 millis"))
    )
  )
}

const long = "m".repeat(700)

test("the head names the three kinds of request, has the one tool, and ends with the person's rules", () => {
  const plain = head()
  expect(plain.system).toStartWith("You are EverChat, an AI agent that works for one user in a single chat that never\nends.")
  for (const part of ["a turn, a compaction, or a subagent task", "\"Compaction:\"", "\"Subagent task:\"", "# Turns", "# Compactions", "# Subagent tasks", "- asst: EverChat's replies"]) {
    expect(plain.system).toContain(part)
  }
  expect(plain.system).not.toContain("ever:")
  expect(plain.tools.map((tool) => [tool.name, tool.schema])).toEqual([[TOOL, undefined]])
  expect(head("  Answer in English.  ").system).toBe(plain.system + "\n# The user's instructions\n\nAnswer in English.\n")
  expect(head("  ")).toEqual(plain)
})

test("a compaction is one patient request with the chat's id and head, and its usage is written with its node", async () => {
  const file = newFile()
  const wire = fakeWire((asked) => reply(asked, { text: "  the line  ", usage: { input: 50, cacheRead: 900, cacheWrite: 30, output: 12, searches: 0 }, request: "req_7" }))
  const uuid = await withAll(file, wire, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: long }])
    yield* memory.idle
    return (yield* (yield* Store).chat).uuid
  }))
  expect(wire.sent.length).toBe(1)
  const sent = wire.sent[0]!
  expect(sent.session).toBe(uuid)
  expect(sent.pick).toEqual(PICK)
  expect(sent.head).toEqual(head("Answer in English."))
  expect(sent.items.length).toBe(1)
  const blocks = sent.items[0]!.kind === "user" ? sent.items[0]!.blocks : []
  expect(blocks[0]).toEqual({ text: "<chat>\n", mark: true })
  expect(blocks[blocks.length - 1]!.text).toStartWith("Compaction: compress message 0 into one line")
  expect(rows(file, "select text from node")).toEqual([{ text: "the line" }])
  expect(rows(file, `
    select u.served, u.node_l, u.node_i, p.model, u.request, u.input, u.cache_read, u.cache_write, u.output, u.expected
    from usage u join pick p on p.id = u.pick`)).toEqual([
    { served: "compaction", node_l: 0, node_i: 0, model: "small", request: "req_7", input: 50, cache_read: 900, cache_write: 30, output: 12, expected: 0 }
  ])
})

test("a compaction that the vendor refuses for its input, or stops with its filter, gives the source, cut", async () => {
  for (const answer of [() => wireError("input"), () => wireError("policy"), (asked: any) => reply(asked, { text: "half a li", stop: "filter" as const })]) {
    const file = newFile()
    const wire = fakeWire(answer)
    await withAll(file, wire, Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.push([{ kind: "user", text: long }])
      yield* memory.idle
    }))
    expect(wire.sent.length).toBe(1)
    expect(rows<{ size: number }>(file, "select size from node")[0]!.size).toBe(512)
  }
})

test("a busy vendor only delays a node, and a used-up quota is asked again later", async () => {
  for (const kind of ["busy", "limit"] as const) {
    const file = newFile()
    const wire = fakeWire((asked, n) => (n < 4 ? wireError(kind) : reply(asked, { text: "at last" })))
    await withAll(file, wire, Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.push([{ kind: "user", text: long }])
      yield* memory.idle
    }))
    expect(wire.sent.length).toBe(4)
    expect(rows(file, "select text from node")).toEqual([{ text: "at last" }])
  }
})
