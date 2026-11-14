#!/usr/bin/env bun
// Sample
// ======
// Makes a chat with no model, to look at in the inspector: a home with a
// database that the real store, the real memory and the real turn loop
// wrote, over a fake wire, a fake sandbox and a fake compactor. It sends
// nothing to a vendor and it costs nothing.
//
//   bun tools/sample.ts <home> [turns]        (default: 200 turns)
//   EVERCHAT_HOME=<home> just run inspect
//
// Each turn has a message of the person, one or two programs with their
// results, and a reply: about five messages. The texts are made of random
// words, long enough that most leaves need a compaction. The fake
// compactor gives a line of 120 to 400 bytes for each. With 200 turns the
// chat view passes its limit, so the views show batches of merges.
//
// What it shows is how the memory behaves, and not how a model writes: the
// summaries are words of the source, and the usage is made up.

import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { FILE } from "../src/database.ts"
import { Memory } from "../src/memory.ts"
import type { Reply, Request } from "../src/request.ts"
import { Turns } from "../src/turn.ts"
import { fakeWire, reply, withChat } from "../tests/help.ts"

const [home, turnsArg] = process.argv.slice(2)
if (home === undefined) {
  console.error("usage: bun tools/sample.ts <home> [turns]")
  process.exit(2)
}
const TURNS = Math.max(1, Number(turnsArg ?? 200))
const file = path.join(path.resolve(home), FILE)
if (fs.existsSync(file)) {
  console.error(`${file} is there already: give a home with no chat`)
  process.exit(1)
}
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })

// The same chat each time.
let seed = 20261112
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const WORDS = "the memory keeps every message and builds a tree of lines above the log so that old detail fades while the newest stays whole a request shows the view first and then the new message the cache reads the same prefix again when only the end of the view changed".split(" ")
const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ")
const sentence = (n: number) => {
  const text = words(n)
  return text[0]!.toUpperCase() + text.slice(1) + "."
}

let calls = 0
const usage = (asked: Request, first: boolean) => {
  const size = Math.round(JSON.stringify(asked.items).length / 4)
  // The first step of a turn reads the view from the cache, but its end.
  return first
    ? { input: 600, cacheRead: Math.max(0, size - 600), cacheWrite: 600, output: 80, searches: 0 }
    : { input: 300, cacheRead: Math.max(0, size - 300), cacheWrite: 300, output: 120, searches: 0 }
}
// How many programs each turn runs before it answers.
const programs = new Map<number, number>()
const wire = fakeWire((asked): Reply => {
  const steps = asked.items.filter((item) => item.kind === "turn").length
  const turn = wire.sent.filter((one) => one.items.length === 1).length
  if (!programs.has(turn)) programs.set(turn, random() < 0.3 ? 2 : random() < 0.8 ? 1 : 0)
  if (steps < programs.get(turn)!) {
    const id = "call_" + ++calls
    const program = `const found = await shell(${JSON.stringify("grep -rn " + words(2) + " src/")})\nreturn found.split("\\n").slice(0, ${5 + Math.floor(random() * 20)}).join("\\n")`
    return reply(asked, {
      text: "",
      output: [{ type: "reasoning", id: "rs_" + id, summary: [], encrypted_content: "(encrypted)" }, { type: "custom_tool_call", call_id: id, name: "run", input: program }],
      calls: [{ id, name: "run", input: program }],
      usage: usage(asked, steps === 0),
      id: "resp_" + id,
      request: "req_" + id
    })
  }
  const text = Array.from({ length: 2 + Math.floor(random() * 5) }, () => sentence(8 + Math.floor(random() * 14))).join(" ")
  return reply(asked, {
    text,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: usage(asked, steps === 0),
    id: "resp_t" + turn + "_" + steps,
    request: "req_t" + turn + "_" + steps
  })
})

// A program's result: rows as a search gives them.
const result = () =>
  Effect.sync(() => ({
    output: Array.from({ length: 3 + Math.floor(random() * 30) }, (_, k) => `src/${words(1)}.ts:${10 + k * 7}:  ${words(6 + Math.floor(random() * 8))}`).join("\n"),
    failed: random() < 0.05
  }))

// A line for a node: some words of its source, shorter than the limit.
const summary = (blocks: ReadonlyArray<{ readonly text: string }>) => {
  const source = blocks[blocks.length - 1]!.text
  const input = source.slice(source.indexOf("<input>\n") + 8, source.lastIndexOf("\n</input>"))
  const from = input.replace(/\s+/g, " ").split(" ")
  const size = 120 + Math.floor(random() * 280)
  let line = ""
  for (let k = 0; k < from.length && line.length < size; k += 1 + Math.floor(random() * 4)) {
    line += (line === "" ? "" : " ") + from[k]
  }
  return { text: line.slice(0, size), usage: { pick: { vendor: "openai", model: "gpt-sample-small", effort: "low", speed: "slow" }, input: 200, cacheRead: Math.round(input.length / 4) + 4000, cacheWrite: 0, output: Math.round(size / 4) } }
}

await withChat(
  file,
  wire,
  result,
  Effect.gen(function*() {
    const turns = yield* Turns
    const memory = yield* Memory
    for (let k = 0; k < TURNS; k++) {
      yield* turns.say(Array.from({ length: 1 + Math.floor(random() * 4) }, () => sentence(6 + Math.floor(random() * 30))).join(" "))
      yield* turns.idle
    }
    yield* memory.idle
    const state = yield* memory.state
    console.log(`${state.count} messages in ${TURNS} turns. The chat view has ${state.view.parts.length} parts and ${state.view.size} bytes.`)
  }),
  summary
)
console.log(`The chat is in ${path.dirname(file)}. To look at it: EVERCHAT_HOME=${path.dirname(file)} just run inspect`)
