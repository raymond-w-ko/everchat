// Tests of the memory: the tree's math, what needs a request and what does
// not, the views' rules, and what a restart finds. They follow the tests of
// the old code (ref/src/memory.test.ts), with the store in place of files
// and a compactor service in place of a fake HTTP reply.

import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schedule } from "effect"
import { compactor, newFile, options, rows, withMemory } from "../tests/help.ts"
import {
  type Block,
  bytes,
  CompactionRetry,
  CompactorError,
  core,
  ctx,
  cut,
  HIGH,
  JOBS,
  Memory,
  NODE,
  over,
  type Part,
  partOf,
  ref,
  roots,
  SEEN,
  slot,
  span,
  task
} from "./memory.ts"
import { Store, StoreError } from "./store.ts"

// A text that makes a message of exactly `n` bytes as the model reads it
// (`user: ` is 6 bytes).
const sized = (n: number) => "m".repeat(n - 6)

// A compactor that records each request and answers with `line`.
const recorder = (line: (blocks: ReadonlyArray<Block>, node: Part) => string = () => "a summary") => {
  const asked: Array<{ node: Part; blocks: ReadonlyArray<Block> }> = []
  return { asked, layer: compactor((blocks, node) => (asked.push({ node, blocks }), line(blocks, node))) }
}

const lines = (blocks: ReadonlyArray<Block>) =>
  blocks.map((block) => block.text).join("").split("\n").filter((text) => /^\d+\+\d+\|/.test(text))

// The tree's math
// ---------------

test("a node (l, i) covers the 2^l messages from i·2^l; the model names it id+n", () => {
  expect(span({ l: 0, i: 5 })).toEqual([5, 5])
  expect(span({ l: 3, i: 2 })).toEqual([16, 23])
  expect(ref({ l: 3, i: 2 })).toBe("16+8")
  expect(partOf(100, 16, 8)).toEqual({ l: 3, i: 2 })
  expect(partOf(100, 16, 6)).toBeNull() // n is not a power of 2
  expect(partOf(100, 12, 8)).toBeNull() // id is not a multiple of n
  expect(partOf(20, 16, 8)).toBeNull() // past the chat's end
})

test("each node has its own slot", () => {
  const slots = new Set<number>()
  for (let l = 0; l < 8; l++) {
    for (let i = 0; i < 64; i++) slots.add(slot(l, i))
  }
  expect(slots.size).toBe(8 * 64)
})

test("the roots are one perfect tree per 1 bit of the count", () => {
  expect(roots(0)).toEqual([])
  expect(roots(13)).toEqual([{ l: 3, i: 0 }, { l: 2, i: 2 }, { l: 0, i: 12 }])
  expect(roots(1024)).toEqual([{ l: 10, i: 0 }])
})

test("a compaction's view ends at its node: a leaf's before its message, a merge's after its last", () => {
  expect(ctx(0, 9)).toBe(9)
  expect(ctx(2, 1)).toBe(8)
})

test("the task shows a 512-dash ruler, not a sample line", () => {
  const leaf = task(0, 7)
  expect(leaf).toStartWith("Compaction: compress message 7 into one line of at most 512 bytes")
  expect(leaf).toContain("\n" + "-".repeat(512) + "\n<input>\n")
  const merge = task(2, 3)
  expect(merge).toStartWith("Compaction: merge lines 12+2 and 14+2, adjacent, into one line")
  expect(merge).toContain("{id}".replace("{id}", "12") + " to 15")
})

test("a text is cut to 512 bytes where a character ends, and the note for a long line shows the cut", () => {
  const long = "é".repeat(300) // 600 bytes
  expect(bytes(cut(long))).toBe(512)
  expect(bytes(cut("a" + long))).toBe(511) // the 512th byte is half an é
  const note = over(long)
  expect(note).toStartWith("Too long: your last line for this <input> was 600 bytes,\nover the 512-byte limit.")
  expect(note).toEndWith(cut(long) + "| ← LIMIT")
})

// The order of merges and of compactions
// --------------------------------------

// A state in RAM with the given nodes built (100 bytes each) and the given
// parts as the chat's view.
const state = (count: number, high: number, nodes: ReadonlyArray<readonly [number, number]>, parts: ReadonlyArray<readonly [number, number]>) => {
  const mem = core.fresh(count, high)
  for (const [l, i] of nodes) mem.nodes.set(slot(l, i), "x".repeat(100))
  mem.view.parts = parts.map(([l, i]) => ({ l, i }))
  mem.view.size = 100 * parts.length
  mem.seen.parts = mem.view.parts.slice()
  return mem
}

const names = (parts: ReadonlyArray<Part>) => parts.map(ref)

test("mistake 1: at T=10 with 0+4, 4+4, 8+1, 9+1 it merges 8-9, not 0-7", () => {
  const view = [[2, 0], [2, 1], [0, 8], [0, 9]] as const
  const mem = state(10, 700, [...view, [3, 0], [1, 4]], view) // 400 bytes; one merge takes it to 300, under half of 700
  expect(names(core.merge(mem, mem.view).parts)).toEqual(["0+4", "4+4", "8+2"])
})

test("of two pairs equally due, the oldest merges first", () => {
  const view = [[1, 0], [1, 1], [0, 4], [0, 5], [0, 6]] as const // T = 7: 0+2,2+2 and 4+1,5+1 are both due 4
  const mem = state(7, 900, [...view, [2, 0], [1, 2]], view) // 500 bytes; one merge takes it to 400, under half of 900
  expect(names(core.merge(mem, mem.view).parts)).toEqual(["0+4", "4+1", "5+1", "6+1"])
})

test("a pair merges only if its parent is built, and only siblings merge", () => {
  const view = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] as const
  const mem = state(5, 100, [...view, [1, 1]], view) // 0+2 is not built; 1+1 and 2+1 are not siblings
  const merged = core.merge(mem, mem.view)
  expect(names(merged.parts)).toEqual(["0+1", "1+1", "2+2", "4+1"])
  expect(merged.size).toBe(400)
  expect(names(merged.gone)).toEqual(["2+1", "3+1"])
})

test("between messages only a whole batch is taken; at a message, a batch that a missing parent stopped goes on", () => {
  const view = [[0, 0], [0, 1], [0, 2], [0, 3]] as const
  const mem = state(4, 300, [...view, [1, 0]], view) // 400 bytes, over 300; only 0+2 can merge: 300, not half
  mem.seen.parts = [{ l: 2, i: 0 }] // the compactions' view holds none of these nodes
  core.fit(mem)
  expect(names(mem.view.parts)).toEqual(["0+1", "1+1", "2+1", "3+1"])
  expect(mem.view.batch).toBe(true)
  expect(mem.journal.views).toBe(true) // the batch flag changed
  core.fit(mem, true)
  expect(names(mem.view.parts)).toEqual(["0+2", "2+1", "3+1"])
  expect(mem.view.size).toBe(300)
  // The halves merged away are let go: no view holds them, nor a node under them.
  expect(mem.nodes.has(slot(0, 0))).toBe(false)
  expect(mem.nodes.has(slot(0, 2))).toBe(true)
})

test("compactions start in the order the messages came; at a tie, a merge first", () => {
  const mem = state(5, HIGH, [[0, 0], [0, 1], [0, 2], [0, 3]], [])
  for (const i of [0, 1, 2, 3]) mem.nodes.set(slot(0, i), "y".repeat(400))
  mem.leaves.set(4, "user: " + "z".repeat(600))
  core.ready(mem, { l: 0, i: 4 }, true) // its view ends before message 4
  core.ready(mem, { l: 1, i: 1 }, true) // 2+2: its view ends after message 3
  core.ready(mem, { l: 1, i: 0 }, true)
  expect(core.starts(mem)).toEqual([])
  expect(mem.started.map((job) => ref(job))).toEqual(["0+2", "2+2", "4+1"])
  expect(mem.busy.size).toBe(3)
  // A node that is busy is not started again.
  expect(core.starts(mem)).toEqual([])
  expect(mem.started.length).toBe(3)
})

// What needs a request
// --------------------

test("a message that fits in 512 bytes (its kind too) is its own line, with no request; one byte more is a request", async () => {
  const file = newFile()
  const { asked, layer } = recorder()
  await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: sized(NODE) }])
    yield* memory.idle
    expect(asked.length).toBe(0)
    yield* memory.push([{ kind: "user", text: sized(NODE + 1) }])
    yield* memory.idle
  }))
  expect(asked.map((ask) => ask.node)).toEqual([{ l: 0, i: 1 }, { l: 1, i: 0 }])
  expect(rows(file, "select l, i, size from node order by l, i")).toEqual([
    { l: 0, i: 0, size: 512 },
    { l: 0, i: 1, size: 9 },
    { l: 1, i: 0, size: 9 }
  ])
})

test("two short lines that fit together are joined by a newline, with no request", async () => {
  const file = newFile()
  const { asked, layer } = recorder()
  await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: "fix the build" }, { kind: "asst", text: "on it" }])
    yield* memory.idle
  }))
  expect(asked).toEqual([])
  expect(rows(file, "select l, i, text from node order by l, i")).toEqual([
    { l: 0, i: 0, text: "user: fix the build" },
    { l: 0, i: 1, text: "asst: on it" },
    { l: 1, i: 0, text: "user: fix the build\nasst: on it" }
  ])
})

test("a message logged with its own line has that line as its leaf", async () => {
  const file = newFile()
  const { asked, layer } = recorder()
  await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "tool", text: "x".repeat(5000), line: "tool: ran the tests" }])
    yield* memory.idle
  }))
  expect(asked).toEqual([])
  expect(rows(file, "select text from node")).toEqual([{ text: "tool: ran the tests" }])
  expect(rows(file, "select line from msg")).toEqual([{ line: "tool: ran the tests" }])
})

test("a merge's source is its two halves, each on one line, after the compactions' view", async () => {
  const { asked, layer } = recorder((_, node) => (node.l === 0 ? "line " + node.i + "\nwith a break" : "merged"))
  await withMemory(newFile(), layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: sized(600) }, { kind: "user", text: sized(600) + "y".repeat(400) }])
    yield* memory.idle
  }))
  // The two leaves' lines are short, so their merge is free.
  expect(asked.map((ask) => ask.node)).toEqual([{ l: 0, i: 0 }, { l: 0, i: 1 }])
  const leaf = asked[1]!.blocks
  expect(leaf[0]).toEqual({ text: "<chat>\n", mark: true })
  expect(leaf[leaf.length - 1]!.text).toBe(task(0, 1) + "user: " + sized(600) + "y".repeat(400) + "\n</input>")
  expect(leaf.every((block) => !block.text.includes("\n0+1|") || block.mark === false)).toBe(true)
})

test("every node is asked for once (a retry aside), and only once its halves are built", async () => {
  const built = new Set<string>()
  const early: Array<Part> = []
  const { asked, layer } = recorder((_, node) => {
    const [a, b] = [`${node.l - 1}/${2 * node.i}`, `${node.l - 1}/${2 * node.i + 1}`]
    if (node.l > 0 && !(built.has(a) && built.has(b))) early.push(node)
    built.add(`${node.l}/${node.i}`)
    return "s".repeat(400)
  })
  await withMemory(newFile(), layer, Effect.gen(function*() {
    const memory = yield* Memory
    for (let n = 0; n < 64; n++) {
      yield* memory.push([{ kind: "user", text: sized(600) }])
    }
    yield* memory.idle
  }))
  const names = asked.map((ask) => `${ask.node.l}/${ask.node.i}`)
  expect(new Set(names).size).toBe(names.length)
  expect(names.length).toBe(127) // the whole tree over 64 messages
  expect(early).toEqual([])
})

test("a line too long is asked again: the same request plus a note; the shortest of 5 lines is kept", async () => {
  const file = newFile()
  const sizes = [900, 800, 700, 650, 720, 100]
  let k = 0
  const { asked, layer } = recorder(() => "z".repeat(sizes[k++]!))
  await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: sized(2000) }])
    yield* memory.idle
  }))
  expect(asked.length).toBe(5)
  const first = asked[0]!.blocks
  for (const [n, ask] of asked.entries()) {
    expect(ask.blocks.slice(0, first.length)).toEqual([...first])
    expect(ask.blocks.length).toBe(n === 0 ? first.length : first.length + 1)
  }
  expect(asked[3]!.blocks[first.length]).toEqual({ text: over("z".repeat(700)), mark: false })
  expect(rows(file, "select size from node")).toEqual([{ size: 650 }])
})

test("a line that fits ends the tries, and an answer with no line makes the node its source, cut", async () => {
  const file = newFile()
  const answers = ["z".repeat(600), "  fits  ", "   ", "both"]
  let k = 0
  const { asked, layer } = recorder(() => answers[k++]!)
  await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: sized(2000) }])
    yield* memory.idle
    yield* memory.push([{ kind: "user", text: "a\nb " + "é".repeat(400) }])
    yield* memory.idle
  }))
  expect(asked.map((ask) => ask.node)).toEqual([{ l: 0, i: 0 }, { l: 0, i: 0 }, { l: 0, i: 1 }, { l: 1, i: 0 }])
  const nodes = rows<{ i: number; text: string }>(file, "select i, text from node where l = 0 order by i")
  expect(nodes[0]!.text).toBe("fits")
  expect(nodes[1]!.text).toBe(cut("user: a b " + "é".repeat(400)))
  expect(bytes(nodes[1]!.text)).toBeLessThanOrEqual(NODE)
})

test("a leaf starts only while fewer than JOBS leaves before it are not built", async () => {
  const gate = Deferred.makeUnsafe<void>()
  let asked = 0
  const held = compactor(() => (asked++, Effect.as(Deferred.await(gate), { text: "s" })))
  await withMemory(newFile(), held, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push(Array.from({ length: JOBS + 36 }, () => ({ kind: "user" as const, text: sized(600) })))
    yield* Effect.sleep("20 millis")
    expect(asked).toBe(JOBS)
    expect((yield* memory.state).busy).toBe(JOBS)
    yield* Deferred.succeed(gate, undefined)
    yield* memory.idle
    expect((yield* memory.state).busy).toBe(0)
  }))
  expect(asked).toBe(JOBS + 36) // every leaf once; the merges of such short lines are free
})

// The views
// ---------

test("a view covers the chat from message 0 to its end, in order, and never passes its limit; between batches it only grows at its end", async () => {
  const file = newFile()
  const { layer } = recorder((_, node) => "n" + node.l + "/" + node.i + " " + "s".repeat(380))
  const batches = { view: 0, seen: 0 }
  await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    let last = yield* memory.state
    for (let n = 0; n < 700; n++) {
      yield* memory.push([{ kind: "user", text: sized(600) + n }])
      yield* memory.idle
      const state = yield* memory.state
      for (const name of ["view", "seen"] as const) {
        const [now, before] = [state[name], last[name]]
        const high = name === "view" ? HIGH : SEEN
        let at = 0
        const whole = now.parts.every(([l, i]) => {
          const ok = i * 2 ** l === at
          at += 2 ** l
          return ok
        })
        const grew = now.size >= before.size
        const kept = before.parts.every((part, k) => part[0] === now.parts[k]?.[0] && part[1] === now.parts[k]?.[1])
        if (!grew) batches[name] += 1
        // No gap and no overlap, to the chat's end; never past its limit;
        // a batch takes it to half at most; else its old parts stay.
        const ok = whole && at === state.count && now.size <= high && (grew ? kept : now.size <= high / 2)
        if (!ok) expect(JSON.stringify({ n, name, whole, at, size: now.size, grew, kept })).toBe("a valid view")
      }
      last = state
    }
  }))
  expect(batches.view).toBeGreaterThanOrEqual(1)
  expect(batches.seen).toBeGreaterThanOrEqual(8)
  // A view's size is the bytes of its lines, also after a restart.
  const sizes = new Map(rows<{ l: number; i: number; size: number }>(file, "select l, i, size from node").map((node) => [`${node.l}/${node.i}`, node.size]))
  const state = await withMemory(file, layer, Memory.use((memory) => memory.state))
  const sum = state.view.parts.reduce((n, [l, i]) => n + sizes.get(`${l}/${i}`)!, 0)
  expect(state.view.size).toBe(sum)
}, 60_000)

test("a request's view holds built lines only, in blocks of 4, with one mark on the last whole block", async () => {
  const gate = Deferred.makeUnsafe<void>()
  const slow = compactor(() => Effect.as(Deferred.await(gate), { text: "late" }))
  await withMemory(newFile(), slow, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push(Array.from({ length: 10 }, (_, n) => ({ kind: "user" as const, text: "short " + n })))
    yield* memory.push([{ kind: "user", text: sized(600) }]) // its compaction waits at the gate
    const blocks = yield* memory.view()
    expect(blocks.map((block) => block.mark)).toEqual([false, false, true, false])
    expect(blocks[0]!.text).toBe("<chat>\n")
    expect(blocks[1]!.text.split("\n").length - 1).toBe(4)
    expect(blocks[3]!.text).toEndWith("</chat>\n")
    // Message 10 is being summarized: the view leaves it out.
    expect(lines(blocks).map((text) => text.split("|")[0])).toEqual(["0+1", "1+1", "2+1", "3+1", "4+1", "5+1", "6+1", "7+1", "8+1", "9+1"])
    expect(blocks.map((block) => block.text).join("")).not.toContain("not summarized yet")
    // A view before message 3 has fewer than 4 lines: the mark is on the opening block.
    expect((yield* memory.view(3)).map((block) => block.mark)).toEqual([true, false])
    yield* Deferred.succeed(gate, undefined)
    yield* memory.idle
    expect(lines(yield* memory.view()).length).toBe(11)
  }))
})

test("a turn waits until every message before it is summarized", async () => {
  const gate = Deferred.makeUnsafe<void>()
  const slow = compactor(() => Effect.as(Deferred.await(gate), { text: "late" }))
  await withMemory(newFile(), slow, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: sized(600) }, { kind: "user", text: "short" }])
    yield* memory.settle(0)
    let settled = false
    const waiting = yield* Effect.forkChild(Effect.andThen(memory.settle(2), Effect.sync(() => (settled = true))))
    yield* Effect.sleep("20 millis")
    expect(settled).toBe(false)
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.join(waiting)
    expect(settled).toBe(true)
  }))
})

test("a paste is logged as pages, none of them in a view whole, and a zoom reads it page by page", async () => {
  const file = newFile()
  const paste = Array.from({ length: 1400 }, (_, n) => "line " + n + " " + "p".repeat(40)).join("\n") // about 70,000 characters
  const { asked, layer } = recorder()
  await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    const written = yield* memory.push([{ kind: "user", text: paste }])
    expect(written.map((message) => message.more)).toEqual([true, true, false])
    expect(written.map((message) => message.text).join("")).toBe(paste)
    expect(written.every((message) => message.text.length <= 30000)).toBe(true)
    yield* memory.idle
    for (const text of lines(yield* memory.view())) {
      expect(bytes(text)).toBeLessThan(NODE + 20)
    }
    const whole = yield* memory.zoom(0, 1, 0)
    expect(whole).toStartWith("0+0|user: line 0 ")
    expect(whole.length).toBeLessThan(30100)
    expect(yield* memory.zoom(2, 1, 0)).toBe("2+0|user: " + written[2]!.text)
    expect(yield* memory.zoom(0, 2, 0)).toBe("0+1|a summary\n1+1|a summary")
    expect(yield* memory.zoom(1, 2, 0)).toBe("No line 1+2: n is a power of 2, id a multiple of n. The tree's roots: 0+2, 2+1.")
  }))
  expect(asked.length).toBe(3)
})

test("a page ends after its last newline", async () => {
  await withMemory(newFile(), recorder().layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "echo", text: "q".repeat(29999) + "\n" + "r".repeat(10) }])
    expect(yield* memory.zoom(0, 1, 0)).toBe("0+0|echo: " + "q".repeat(29999) + "\n")
    expect(yield* memory.zoom(1, 1, 0)).toBe("1+0|echo: " + "r".repeat(10))
  }))
})

// One event, one transaction; and a restart
// -----------------------------------------

test("a message is written with its free nodes, and a compaction with its usage", async () => {
  const file = newFile()
  const pick = { vendor: "openai", model: "small", effort: "low", speed: "slow" }
  const paid = compactor(() => ({ text: "a summary", usage: { pick, input: 10, cacheRead: 900, cacheWrite: 5, output: 7, request: "req_1" } }))
  await withMemory(file, paid, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: "hi" }])
    expect(rows(file, "select l, i, text from node")).toEqual([{ l: 0, i: 0, text: "user: hi" }])
    yield* memory.push([{ kind: "user", text: sized(600) }])
    yield* memory.idle
  }))
  expect(rows(file, "select served, node_l, node_i, cache_read, request from usage order by id")).toEqual([
    { served: "compaction", node_l: 0, node_i: 1, cache_read: 900, request: "req_1" }
  ])
})

test("a restart loads the views as they were, never rebuilt, and asks again for a compaction that a stop cut", async () => {
  const file = newFile()
  const never = compactor(() => Effect.never)
  const { layer } = recorder((_, node) => "n" + node.l + "/" + node.i + " " + "s".repeat(380))
  const before = await withMemory(file, layer, Effect.gen(function*() {
    const memory = yield* Memory
    for (let n = 0; n < 300; n++) {
      yield* memory.push([{ kind: "user", text: sized(600) + n }])
    }
    yield* memory.idle
    return yield* memory.state
  }))
  expect(before.seen.parts.length).toBeLessThan(150) // the compactions' view has merged
  // A launch whose compactor never answers: the message is logged, its leaf is not built.
  const cut = await withMemory(file, never, Effect.gen(function*() {
    const memory = yield* Memory
    expect(yield* memory.state).toEqual(before)
    yield* memory.push([{ kind: "user", text: sized(600) }])
    return yield* memory.state
  }))
  expect(cut.busy).toBe(1)
  expect(rows(file, "select count(*) as n from node where l = 0 and i = 300")).toEqual([{ n: 0 }])
  const again = recorder(() => "asked again")
  const after = await withMemory(file, again.layer, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.idle
    return yield* memory.state
  }))
  expect(again.asked[0]!.node).toEqual({ l: 0, i: 300 })
  expect(after.view.parts).toEqual(cut.view.parts)
  expect(after.seen.parts.slice(0, cut.seen.parts.length)).toEqual([...cut.seen.parts])
  expect(rows(file, "select text from node where l = 0 and i = 300")).toEqual([{ text: "asked again" }])
})

test("a compaction that fails is asked again until it answers", async () => {
  const file = newFile()
  let tries = 0
  const flaky = compactor(() => (++tries < 3 ? Effect.fail(new CompactorError({ cause: "the inference gateway is down" })) : { text: "third time" }))
  await Effect.runPromise(
    Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.push([{ kind: "user", text: sized(600) }])
      yield* memory.idle
    }).pipe(
      Effect.provide(Memory.layer.pipe(Layer.provideMerge(Store.layer(file, options())), Layer.provide(flaky))),
      Effect.provideService(CompactionRetry, Schedule.spaced("1 millis"))
    )
  )
  expect(tries).toBe(3)
  expect(rows(file, "select text from node")).toEqual([{ text: "third time" }])
})

test("a write that fails stops the memory for good, and the database keeps the last whole event", async () => {
  const file = newFile()
  let fail = false
  // The store, with a transaction that fails on demand.
  const faulty = Layer.effect(
    Store,
    Store.useSync((store) =>
      Store.of({
        ...store,
        transaction: (effect) =>
          Effect.suspend(() => fail ? Effect.fail(new StoreError({ op: "transaction", cause: "disk full" })) : store.transaction(effect))
      }))
  ).pipe(Layer.provide(Store.layer(file, options())))
  await Effect.runPromise(
    Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.push([{ kind: "user", text: "kept" }])
      fail = true
      const error = yield* Effect.flip(memory.push([{ kind: "user", text: "lost" }]))
      expect(error).toBeInstanceOf(StoreError)
      fail = false
      // The state in RAM is ahead of the database now, so the memory refuses to go on.
      expect(yield* Effect.flip(memory.push([{ kind: "user", text: "after" }]))).toBe(error)
      expect(yield* Effect.flip(memory.settle(5))).toBe(error)
    }).pipe(Effect.provide(Memory.layer.pipe(Layer.provide(faulty), Layer.provide(recorder().layer))))
  )
  expect(rows(file, "select i, text from msg")).toEqual([{ i: 0, text: "kept" }])
  // A new launch reads the true state and goes on.
  const next = await withMemory(file, recorder().layer, Memory.use((memory) => memory.push([{ kind: "user", text: "after" }])))
  expect(next[0]!.i).toBe(1)
})
