// Tests of the real compactor and of the head, with a fake wire: the request
// that a compaction sends, and what the memory writes from its reply.

import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { Effect, Layer } from "effect"
import { fakeWire, newFile, options, reply, rows, wireError } from "@everchat/local/testing"
import { Ask, AskDelay } from "./ask.ts"
import { Cache } from "./cache.ts"
import * as RealCompactor from "./compactor.ts"
import { head, TOOL } from "./head.ts"
import { DECLARATIONS } from "@everchat/local/localfunctions"
import { limitLayer } from "@everchat/local/limitfile"
import * as path from "node:path"
import { CompactionRetry, Memory } from "./memory.ts"
import type { Head, Request } from "./request.ts"
import { Sandbox } from "./sandbox.ts"
import { Schedule } from "effect"
import { storeLayer } from "@everchat/sqlite/bun"
import { Store } from "./store.ts"
import { Turns } from "./turn.ts"

const PICK = { vendor: "openai", model: "small", effort: "high", speed: "slow" }

// The memory with the real compactor over a fake wire, in one launch.
const withAll = <A, E>(file: string, wire: ReturnType<typeof fakeWire>, effect: Effect.Effect<A, E, Memory | Store>) => {
  const store = storeLayer(file, options())
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const compactor = RealCompactor.layer({ pick: PICK, head: head(DECLARATIONS, "Answer in English.") }).pipe(Layer.provide(Layer.merge(asking, store)))
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
  const plain = head(DECLARATIONS)
  assert.ok(plain.system.startsWith("You are EverChat, an AI agent that works for one user in a single chat that never\nends."))
  for (const part of ["a turn, a compaction, or a subagent task", "\"Compaction:\"", "\"Subagent task:\"", "# Turns", "# Compactions", "# Subagent tasks", "- asst: EverChat's replies"]) {
    assert.ok(plain.system.includes(part))
  }
  assert.ok(!plain.system.includes("ever:"))
  assert.deepStrictEqual(plain.tools.map((tool) => [tool.name, tool.schema]), [[TOOL, undefined]])
  assert.equal(head(DECLARATIONS, "  Answer in English.  ").system, plain.system + "\n# The user's instructions\n\nAnswer in English.\n")
  assert.deepStrictEqual(head(DECLARATIONS, "  "), plain)
})

test("the head's bytes are the ones that the prompt cache was written for", () => {
  // A change of the prompt, of a declaration or of their order changes
  // every request's prefix, and misses the vendor's cache once for every
  // chat (packages/core/AGENTS.md, "One system prompt for every kind of
  // request"). Change this hash only on purpose.
  const hash = createHash("sha256").update(JSON.stringify(head(DECLARATIONS))).digest("hex")
  assert.equal(hash, "52cab4d3bef1ebac0fd4125fa6db9eefac15f977867448fcff28e2457136f826")
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
  assert.equal(wire.sent.length, 1)
  const sent = wire.sent[0]!
  assert.equal(sent.session, uuid)
  assert.deepStrictEqual(sent.pick, PICK)
  assert.deepStrictEqual(sent.head, head(DECLARATIONS, "Answer in English."))
  assert.equal(sent.items.length, 1)
  const blocks = sent.items[0]!.kind === "user" ? sent.items[0]!.blocks : []
  assert.deepStrictEqual(blocks[0], { text: "<chat>\n", mark: true })
  assert.ok((blocks[blocks.length - 1]!.text).startsWith("Compaction: compress message 0 into one line"))
  assert.deepStrictEqual(rows(file, "select text from everchat_node"), [{ text: "the line" }])
  assert.deepStrictEqual(rows(file, `
    select u.served, u.node_l, u.node_i, p.model, u.request, u.input, u.cache_read, u.cache_write, u.output, u.expected
    from everchat_usage u join everchat_pick p on p.id = u.pick`), [
    { served: "compaction", node_l: 0, node_i: 0, model: "small", request: "req_7", input: 50, cache_read: 900, cache_write: 30, output: 12, expected: 0 }
  ])
})

// One head for each load (ec-u3nf8): a stack makes the head one time and
// gives the one value to the turn loop and to the compactor. A head that no
// call of `head` gives shows that neither layer makes its own.
test("the head in a turn's row, the head that the turn sends and the head that the compactor sends are the one value that the stack gave", async () => {
  const given: Head = { system: "The stack's own system prompt.\n", tools: [{ name: TOOL, description: "The stack's own tool." }] }
  const compacting = (asked: Request) => {
    const last = asked.items[asked.items.length - 1]
    return last?.kind === "user" && last.blocks[last.blocks.length - 1]!.text.startsWith("Compaction:")
  }
  const file = newFile()
  const wire = fakeWire((asked) => reply(asked, { text: compacting(asked) ? "the line" : "Done." }))
  const store = storeLayer(file, options())
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const compactor = RealCompactor.layer({ pick: PICK, head: given }).pipe(Layer.provide(Layer.merge(asking, store)))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.die("no program was expected") }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ head: given }).pipe(Layer.provideMerge(memory), Layer.provide(Layer.mergeAll(asking, sandbox, limit)))
  await Effect.runPromise(
    Effect.gen(function*() {
      const service = yield* Turns
      yield* service.say(long)
      yield* service.idle
      yield* (yield* Memory).idle
    }).pipe(
      Effect.provide(turns),
      Effect.provideService(AskDelay, () => Effect.succeed(0)),
      Effect.provideService(CompactionRetry, Schedule.spaced("1 millis"))
    )
  )
  const sentTurns = wire.sent.filter((asked) => !compacting(asked))
  const sentCompactions = wire.sent.filter(compacting)
  assert.equal(sentTurns.length, 1)
  assert.ok(sentCompactions.length > 0)
  for (const asked of wire.sent) assert.deepStrictEqual(asked.head, given)
  assert.deepStrictEqual(
    rows(file, "select h.body from everchat_turn t join everchat_head h on h.chat = t.chat and h.n = t.head"),
    [{ body: JSON.stringify(given) }]
  )
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
    assert.equal(wire.sent.length, 1)
    assert.equal(rows<{ size: number }>(file, "select size from everchat_node")[0]!.size, 512)
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
    assert.equal(wire.sent.length, 4)
    assert.deepStrictEqual(rows(file, "select text from everchat_node"), [{ text: "at last" }])
  }
})
