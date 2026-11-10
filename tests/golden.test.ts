// Golden test
// ===========
// A fixed chat of 1200 messages (short, long, and pasted over pages) goes
// through the memory, against a fake compactor that sends some lines too
// long at first. The launch ends and a new one starts every 400 messages.
//
// The values in golden.json are what the OLD code made of the same chat
// (ref/, at the tag `before-rewrite`): both views part for part, their
// sizes, the whole tree, the blocks of a request, and five zooms. So this
// test shows that the port did not change what the algorithm does.
//
// The chat has no message of the kind `asst`: that word differs between the
// old code (`ever`) and the new, and the compactor's lines depend on the
// text. Change the algorithm on purpose, and these values change with it:
// say why in the commit.

import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Memory } from "../src/memory.ts"
import { newFile, rows, serialCompactor, withMemory } from "./help.ts"

const GOLD = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "golden.json"), "utf8"))

const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex")

// A line made from the task, too long at the first try of about one in five.
const fake = serialCompactor((blocks) => {
  const task = blocks.findLast((block) => block.text.startsWith("Compaction:"))?.text ?? ""
  const again = blocks[blocks.length - 1]!.text.startsWith("Too long:")
  const id = hash(task).slice(0, 12)
  const long = !again && parseInt(id, 16) % 5 === 0
  return "sum " + id + " " + "é".repeat(30) + "x".repeat(long ? 700 : 200 + (parseInt(id.slice(0, 4), 16) % 200))
})

test("a fixed chat ends in the state that the old code gave it", async () => {
  const file = newFile()
  let seed = 11
  const rand = () => ((seed = (seed * 48271) % 2147483647), seed / 2147483647)
  const kinds = ["user", "tool", "echo", "note"] as const
  const marks: Array<unknown> = []
  let last: unknown

  for (let launch = 0; launch < 3; launch++) {
    await withMemory(file, fake, Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.idle
      for (let n = launch * 400; n < (launch + 1) * 400; n++) {
        const r = rand()
        const size = r < 0.6 ? 20 + Math.floor(rand() * 200) : r < 0.97 ? 400 + Math.floor(rand() * 4000) : 31000 + Math.floor(rand() * 40000)
        const kind = kinds[Math.floor(rand() * 4)]!
        const text = kind + " " + hash(String(n)).repeat(Math.ceil(size / 64)).slice(0, size) + (rand() < 0.1 ? " ünï😀 " : "")
        yield* memory.push([{ kind, text }])
        yield* memory.idle
        if (n % 400 === 399) {
          continue // the old test read the state after its reload: see below
        }
        if (n % 100 === 99) {
          const state = yield* memory.state
          marks.push({ n, count: state.count, view: state.view.parts.length, seen: state.seen.parts.length, size: [state.view.size, state.seen.size] })
        }
      }
    }))
    // What a new launch finds is what the old code's reload found.
    last = await withMemory(file, fake, Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.idle
      const state = yield* memory.state
      marks.push({ n: (launch + 1) * 400 - 1, count: state.count, view: state.view.parts.length, seen: state.seen.parts.length, size: [state.view.size, state.seen.size] })
      const zooms = [yield* memory.zoom(0, 1, 0), yield* memory.zoom(0, 1024, 0), yield* memory.zoom(1024, 128, 0), yield* memory.zoom(7, 2, 0), yield* memory.zoom(3, 1, 0)]
      return { state, blocks: hash(JSON.stringify(yield* memory.view())), zoom: hash(zooms.join("\n---\n")) }
    }))
  }

  const { blocks, state, zoom } = last as { state: any; blocks: string; zoom: string }
  const tree = rows<{ l: number; i: number; text: string }>(file, "select l, i, text from node order by l, i")
  expect(marks).toEqual(GOLD.marks)
  expect(state.count).toBe(GOLD.count)
  expect([state.view.size, state.seen.size]).toEqual(GOLD.size)
  expect([state.view.batch, state.seen.batch]).toEqual(GOLD.batch)
  expect(state.view.parts).toEqual(GOLD.view)
  expect(state.seen.parts).toEqual(GOLD.seen)
  expect(tree.length).toBe(GOLD.nodes)
  expect(hash(tree.map((node) => node.l + "/" + node.i + ":" + node.text).join("\n"))).toBe(GOLD.tree)
  expect(blocks).toBe(GOLD.blocks)
  expect(zoom).toBe(GOLD.zoom)
  expect(rows(file, "select count(*) as n from msg")).toEqual([{ n: GOLD.count }])
}, 120_000)
