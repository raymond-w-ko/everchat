// Sends a few REAL requests to OpenAI through the inference gateway, with our own
// wire, to learn how the vendor behaves where its documents are silent or
// disagree. It costs money. The owner allowed it for OpenAI, within reason
// (AGENTS.md, "Model access through the author's inference gateway"). Do not point it at
// Anthropic.
//
//   bun tools/probe.ts models           the model ids that the inference gateway offers
//   bun tools/probe.ts cache <model>    which cache marks are written and read
//   bun tools/probe.ts tool <model>     a program sent back as received
//   bun tools/probe.ts watch <model>    our cache watch against the real vendor
//   bun tools/probe.ts burst <model> <all|slow|late|groups> <b>
//                                       one request, then b more with the
//                                       same prefix, released in four ways
//   bun tools/probe.ts compact <model> <count> <shorts>
//                                       the real memory and compactor: `count`
//                                       compactions that start together
//   PROBE_EFFORT=high bun tools/probe.ts reason <model>
//                                       a turn with thinking and two programs
//   bun tools/probe.ts raw <model> <form> <count> <same|grow> <gap ms>
//                                       other forms of the request
//
// It prints one JSON line per request. It never prints the key.

import { Effect, Layer, Redacted, Stream } from "effect"
import * as crypto from "node:crypto"
import { Database as Sqlite } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Ask } from "../src/ask.ts"
import { Cache } from "../src/cache.ts"
import * as RealCompactor from "../src/compactor.ts"
import { Memory } from "../src/memory.ts"
import { Store } from "../src/store.ts"
import { Gateway } from "../src/gateway.ts"
import { head as realHead } from "../src/head.ts"
import { Fetch, type Fetcher, OpenAI } from "../src/openai.ts"
import type { Block, Head, Item, Reply, Request } from "../src/request.ts"

const [mode, model = ""] = process.argv.slice(2)
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex")
const nonce = hash(String(Date.now()) + Math.random()).slice(0, 12)

// The last event of each reply, as the vendor sent it.
let last: any = null
// A change of the request's body, for a test of another form of request.
let variant: (body: any) => any = (body) => body
// A run stops itself when it has sent this many requests. Say how many a
// run should need before you start it, and set PROBE_LIMIT to a little more.
// The default is small on purpose: a probe once sent 313 requests where 63
// were planned.
const LIMIT = Number(process.env.PROBE_LIMIT ?? 20)
let requests = 0
const tee: Fetcher = async (url, init) => {
  if (++requests > LIMIT) {
    console.log(JSON.stringify({ stopped: `the limit of ${LIMIT} requests is reached (PROBE_LIMIT)` }))
    process.exit(2)
  }
  init = { ...init, body: JSON.stringify(variant(JSON.parse(init.body as string))) }
  const response = await fetch(url, init)
  response.clone().text().then((text) => {
    // The last event that carries a response. Some routes end with `data: [DONE]`.
    for (const line of text.split("\n").filter((line) => line.startsWith("data: "))) {
      try {
        const event = JSON.parse(line.slice(6))
        if (event?.response !== undefined) last = event
      } catch {}
    }
  }).catch(() => {})
  return response
}

// Where the requests go: the author's inference gateway, or OpenRouter when PROBE=openrouter
// (its key is OPENROUTER_API_KEY, which Bun reads from the file .env).
const openrouter = Layer.sync(Gateway, () => {
  const key = process.env.OPENROUTER_API_KEY
  if (key === undefined || key === "") throw new Error("OPENROUTER_API_KEY is not set")
  return Gateway.of({ address: "https://openrouter.ai/api", key: Redacted.make(key) })
})
const layer = OpenAI.layer.pipe(Layer.provideMerge(process.env.PROBE === "openrouter" ? openrouter : Gateway.layer))
const run = <A>(effect: Effect.Effect<A, unknown, OpenAI | Gateway>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provideService(Fetch, tee)))

// A system prompt of about 2,000 tokens, new for each run, so that the first
// request of a run reads nothing from an older run.
const system = (salt: string) =>
  `You are a test assistant. Run ${nonce}-${salt}.\n` +
  Array.from({ length: 150 }, (_, n) => `Rule ${n + 1}: unless a message says otherwise, answer with the single word ok.`).join("\n")

const tools = [{ name: "run", description: "Runs a JavaScript program and returns what it returns." }]

// A view of `n` blocks of 4 lines (about 450 tokens a block), as the memory
// makes it: one mark, on the last whole block.
const view = (salt: string, n: number): Array<Block> => [
  { text: "<chat>\n", mark: n === 0 },
  ...Array.from({ length: n }, (_, k) => ({
    text: Array.from({ length: 4 }, (_, j) => `${4 * k + j}+1|` + hash(salt + k + "/" + j).repeat(6) + "\n").join(""),
    mark: k === n - 1
  })),
  { text: "</chat>\n", mark: false }
]

const ask = async (label: string, request: Request): Promise<Reply | null> => {
  const started = Date.now()
  const result = await run(Effect.result(OpenAI.use((wire) => Stream.runCollect(wire.send(request)))))
  const ms = Date.now() - started
  if (result._tag === "Failure") {
    const { after, began, code, kind, message, retry, status } = result.failure as any
    console.log(JSON.stringify({ label, failed: { kind, status, code, retry, began, after, message: String(message).slice(0, 300) }, ms }))
    return null
  }
  const end = result.success.at(-1)
  const reply = end?.type === "end" ? end.reply : null
  await new Promise((ok) => setTimeout(ok, 300)) // the copy of the stream
  console.log(JSON.stringify({
    label,
    stop: reply?.stop,
    text: reply?.text.slice(0, 80),
    calls: reply?.calls,
    usage: reply?.usage,
    diagnosis: reply?.diagnosis,
    speed: reply?.pick.speed,
    context: last?.response?.reasoning?.context,
    items: reply?.output.map((item: any) => ({ type: item.type, keys: Object.keys(item).sort().join(","), status: item.status, encrypted: item.encrypted_content?.length })),
    ms
  }))
  await new Promise((ok) => setTimeout(ok, 5000))
  return reply
}

const request = (head: Head, items: ReadonlyArray<Item>, baseline?: string | null): Request => ({
  session: "everchat-probe-" + nonce,
  pick: { vendor: "openai", model, effort: process.env.PROBE_EFFORT ?? "low", speed: "slow" },
  head,
  items,
  max: process.env.PROBE_EFFORT === undefined ? 2000 : 8000,
  baseline
})

const user = (blocks: Array<Block>, text = "user: say ok"): Item => ({ kind: "user", blocks: [...blocks, { text, mark: false }] })

if (mode === "models") {
  const ids = await run(Effect.gen(function*() {
    const gateway = yield* Gateway
    const response = yield* Effect.promise(() =>
      fetch(gateway.address + "/v1/models", { headers: { authorization: "Bearer " + Redacted.value(gateway.key) } })
    )
    const body: any = yield* Effect.promise(() => response.json().catch(() => null))
    return { status: response.status, ids: (body?.data ?? []).map((one: any) => one.id) }
  }))
  console.log(JSON.stringify(ids))
} else if (mode === "cache" && model !== "") {
  // PROBE_MARKS=last3: only the system prompt and the last three marked
  // blocks keep their mark, so that the system prompt is among the four
  // marks that the vendor writes.
  if (process.env.PROBE_MARKS === "last3") {
    variant = (body) => {
      for (const item of body.input.slice(1)) {
        const marked = (item.content ?? []).filter((part: any) => part.prompt_cache_breakpoint !== undefined)
        for (const part of marked.slice(0, -3)) delete part.prompt_cache_breakpoint
      }
      return body
    }
  }
  // Many marks: the system prompt and 12 view blocks.
  const head: Head = { system: system("many"), tools }
  const a = await ask("A: 12 blocks, the first request", request(head, [user(view("v", 12))]))
  const b = await ask("B: A and one more block", request(head, [user(view("v", 13))], a?.id))
  await ask("C: the same head, another view", request(head, [user(view("w", 12))], b?.id))
  // Few marks: the system prompt and 2 view blocks, so every mark is among the latest four.
  const few: Head = { system: system("few"), tools }
  const d = await ask("D: 2 blocks, the first request", request(few, [user(view("v", 2))]))
  await ask("E: the same head, another view", request(few, [user(view("w", 2))], d?.id))
  // One block that grows: the old end is inside the block.
  const grow: Head = { system: system("grow"), tools }
  const whole = (n: number): Array<Block> => [{ text: view("v", n).map((block) => block.text).join(""), mark: true }]
  const f = await ask("F: one big block", request(grow, [user(whole(12))]))
  await ask("G: the same block, longer", request(grow, [user(whole(13))], f?.id))
} else if (mode === "raw" && model !== "") {
  // Two requests, the second one block longer, in another form of request.
  // It prints the vendor's own usage object.
  const strip = (body: any) => {
    delete body.prompt_cache_options
    for (const item of body.input) for (const part of item.content ?? []) delete part.prompt_cache_breakpoint
    return body
  }
  // wire: as the wire sends it (marks and a cache key). The others take
  // the marks, the key, or both away.
  const forms: Record<string, (body: any) => any> = {
    wire: (body) => body,
    marks: (body) => {
      delete body.prompt_cache_key
      return body
    },
    key: (body) => strip(body),
    none: (body) => {
      delete body.prompt_cache_key
      return strip(body)
    }
  }
  variant = forms[process.argv[4] ?? "wire"]!
  const head: Head = { system: system(process.argv[4] ?? "wire"), tools }
  let before: string | null = null
  const gap = Number(process.argv[7] ?? 0)
  const same = process.argv[6] === "same"
  for (const n of Array.from({ length: Number(process.argv[5] ?? 3) }, (_, k) => (same ? 12 : 12 + k))) {
    await new Promise((ok) => setTimeout(ok, gap))
    const reply = await ask(`${process.argv[4]}: ${n} blocks`, request(head, [user(view("v", n))], before))
    before = reply?.id ?? before
    console.log(JSON.stringify({ n, in: last?.response?.usage?.input_tokens, cached: last?.response?.usage?.input_tokens_details?.cached_tokens, written: last?.response?.usage?.input_tokens_details?.cache_write_tokens, diagnostics: last?.response?.prompt_cache_diagnostics, tier: last?.response?.service_tier }))
    if (process.argv[6] === "full") console.log(JSON.stringify({ raw: last?.response?.usage, diagnostics: last?.response?.prompt_cache_diagnostics, key: last?.response?.prompt_cache_key, options: last?.response?.prompt_cache_options, model: last?.response?.model, id: reply?.id }))
  }
} else if (mode === "watch" && model !== "") {
  // Our own watch (src/cache.ts) against the real vendor: five requests,
  // each one block longer, 6 s apart; then one with another view.
  const head: Head = { system: system("watch"), tools }
  await Effect.runPromise(Effect.gen(function*() {
    const cache = yield* Cache
    const wire = cache.watch(yield* OpenAI)
    for (const [label, blocks] of [...[12, 13, 14, 15, 16].map((n) => [`${n} blocks`, view("v", n)] as const), ["another view", view("w", 12)] as const]) {
      const events = yield* Stream.runCollect(wire.send(request(head, [user([...blocks])])))
      const end = events.at(-1)
      if (end?.type === "end") console.log(JSON.stringify({ label, usage: end.reply.usage, cache: end.reply.cache }))
      yield* Effect.sleep("6 seconds")
    }
  }).pipe(Effect.provide(Layer.merge(layer, Cache.layer)), Effect.provideService(Fetch, tee)))
} else if (mode === "reason" && model !== "") {
  // One turn of several steps, with thinking (run it with PROBE_EFFORT=high).
  // Each step sends back every item that the model gave before, as received.
  // It shows whether the vendor accepts them, whether each step reads the
  // cache up to the step before, and whether the reasoning items count in
  // the next step's input (if they do not, something dropped them).
  const head: Head = { system: system("reason"), tools }
  const first = user(
    view("v", 4),
    "user: Do this in two steps, and think each one through.\nStep 1: work out the 12th prime number, and call the tool `run` with a program that returns it. Wait for the result.\nStep 2: multiply that result by the 9th prime number, and call `run` again with a program that returns the product.\nThen tell me the product."
  )
  // Each result is long (about 1,500 tokens), so that a cache entry that
  // ends at a result shows in the counts.
  const long = (answer: string) => answer + "\n" + Array.from({ length: 12 }, (_, k) => hash(answer + k).repeat(6)).join("\n")
  const results = [long("37"), long("851")]
  let items: Array<Item> = [first]
  let before: string | null = null
  let earlier: { all: number; out: number } | null = null
  for (let step = 1; step <= 4; step++) {
    const reply = await ask(`step ${step}`, request(head, items, before))
    if (reply === null) break
    const usage = last?.response?.usage
    const all = usage?.input_tokens ?? 0
    console.log(JSON.stringify({
      step,
      input: all,
      cached: usage?.input_tokens_details?.cached_tokens,
      written: usage?.input_tokens_details?.cache_write_tokens,
      output: usage?.output_tokens,
      reasoning: usage?.output_tokens_details?.reasoning_tokens,
      // How much the input grew since the step before, next to what that step wrote.
      grew: earlier === null ? null : all - earlier.all,
      wroteBefore: earlier?.out ?? null,
      ids: reply.output.map((item: any) => String(item.id ?? "").slice(0, 6) + "(" + String(item.id ?? "").length + ")")
    }))
    earlier = { all, out: usage?.output_tokens ?? 0 }
    before = reply.id
    if (reply.calls.length === 0) break
    items = [...items, { kind: "turn", output: reply.output }, { kind: "back", results: reply.calls.map((call) => ({ id: call.id, output: results.shift() ?? "0" })) }]
  }
} else if (mode === "compact" && model !== "") {
  // The real stack on a new chat in a temporary home: 150 short messages
  // make a view with no request, then `count` long messages are logged at
  // once. Their compactions all start together on one prefix (the head and
  // the whole view). It prints what each request read from the cache.
  const count = Number(process.argv[4] ?? 32)
  const shorts = Number(process.argv[5] ?? 150)
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-probe-")), "everchat.db")
  const pick = { vendor: "openai", model, effort: "low", speed: "slow" }
  const store = Store.layer(file, { launch: { pid: process.pid, host: "probe", cwd: process.cwd(), version: "probe", runTag: "probe" }, pick })
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, layer)))
  const compactor = RealCompactor.layer({ pick }).pipe(Layer.provide(Layer.merge(asking, store)))
  const words = "the quick brown fox jumps over the lazy dog while a small boat drifts past an old stone bridge".split(" ")
  const prose = (seed: string, n: number) => Array.from({ length: n }, (_, k) => words[parseInt(hash(seed + k).slice(0, 6), 16) % words.length]).join(" ")
  const started = Date.now()
  let pushed = 0
  await Effect.runPromise(Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push(Array.from({ length: shorts }, (_, k) => ({ kind: "user" as const, text: `${nonce} note ${k}: ` + prose("short" + k, 22) })))
    yield* memory.idle
    pushed = Date.now()
    yield* memory.push(Array.from({ length: count }, (_, k) => ({ kind: "user" as const, text: `${nonce} report ${k}: ` + prose("long" + k, 140) })))
    yield* memory.idle
  }).pipe(Effect.provide(Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor))), Effect.provideService(Fetch, tee)))
  const db = new Sqlite(file, { readonly: true })
  const usage = db.query("select node_l as l, node_i as i, input, cache_read as read, expected, created from usage order by id").all() as Array<any>
  const nodes = db.query("select count(*) as n, max(size) as big from node").get() as any
  db.close()
  const by = (rows: Array<any>) => ({ requests: rows.length, read: rows.filter((row) => row.read > 0).length, missed: rows.filter((row) => row.expected >= 1024 && row.read === 0).length, input: rows.reduce((n, row) => n + row.input, 0), cached: rows.reduce((n, row) => n + row.read, 0) })
  console.log(JSON.stringify({ seconds: Math.round((Date.now() - pushed) / 1000), setup: Math.round((pushed - started) / 1000), nodes: nodes.n, longest: nodes.big, leaves: by(usage.filter((row) => row.l === 0)), merges: by(usage.filter((row) => row.l > 0)) }))
  const first = usage[0]?.created ?? 0
  console.log(usage.slice(0, 40).map((row) => `${row.l}/${row.i}@${((row.created - first) / 1000).toFixed(1)}s in=${row.input} read=${row.read} exp=${row.expected}`).join("\n"))
} else if (mode === "burst" && model !== "") {
  // One request goes first, and `b` more with the same long prefix follow
  // in one of four ways. It shows which way lets the followers read the
  // prefix from the cache. It sends 1 + b requests.
  //   all     all together, 5 s after the first was sent
  //   slow    one every 250 ms, from 5 s after the first was sent
  //   late    all together, 5 s after the first reply ended
  //   groups  four at a time, each group when the one before has ended
  const [way = "all", size = "16"] = process.argv.slice(4)
  const b = Number(size)
  // PROBE_HEAD=real: the program's own head (src/head.ts) and an empty view,
  // so that the followers share only the head. A line with the run's nonce
  // goes at the end of the system prompt, so that an older run is not read.
  const real = process.env.PROBE_HEAD === "real"
  const head: Head = real ? realHead(`Run ${nonce}.`) : { system: system("burst-" + way), tools }
  const blocks = view("burst", real ? 0 : 3)
  const fire = async (k: number) => {
    const sent = Date.now()
    const result = await run(Effect.result(OpenAI.use((wire) => Stream.runCollect(wire.send(request(head, [user(blocks, `user: say ok ${k}`)]))))))
    if (result._tag === "Failure") return { k, failed: (result.failure as any).kind, sent }
    const end = result.success.at(-1)
    const usage = end?.type === "end" ? end.reply.usage : null
    return { k, read: usage?.cacheRead ?? 0, input: usage?.input ?? 0, sent, ms: Date.now() - sent }
  }
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
  const zero = Date.now()
  const first = await fire(0)
  const ended = Date.now()
  let rest: Array<any> = []
  if (way === "late") {
    await sleep(5000)
    rest = await Promise.all(Array.from({ length: b }, (_, k) => fire(k + 1)))
  } else {
    await sleep(Math.max(0, zero + 5000 - Date.now()))
    if (way === "all") {
      rest = await Promise.all(Array.from({ length: b }, (_, k) => fire(k + 1)))
    } else if (way === "slow") {
      rest = await Promise.all(Array.from({ length: b }, async (_, k) => (await sleep(250 * k), fire(k + 1))))
    } else {
      for (let at = 0; at < b; at += 4) {
        rest.push(...(await Promise.all(Array.from({ length: Math.min(4, b - at) }, (_, k) => fire(at + k + 1)))))
      }
    }
  }
  const all = (first as any).input + (first as any).read
  console.log(JSON.stringify({
    way,
    tokens: all,
    firstTook: ended - zero,
    hits: rest.filter((one) => one.read > 0).length + "/" + b,
    // For each follower: seconds after the first request was sent, and what it read.
    followers: rest.map((one) => ((one.sent - zero) / 1000).toFixed(1) + "s:" + (one.failed ?? one.read)).join(" ")
  }))
} else if (mode === "tool" && model !== "") {
  const head: Head = { system: system("tool"), tools }
  const first = user(view("v", 4), "user: Call the tool `run` once, with exactly this program as its input: return 1 + 1\nThen tell me the result.")
  const a = await ask("A: asks for a program", request(head, [first]))
  if (a !== null && a.calls.length > 0) {
    const back: Item = { kind: "back", results: a.calls.map((call) => ({ id: call.id, output: "2" })) }
    const b = await ask("B: the items as received, and the result", request(head, [first, { kind: "turn", output: a.output }, back], a.id))
    if (b === null) {
      const bare = a.output.map((item: any) => (item.type === "custom_tool_call" ? { ...item, status: undefined } : item))
      await ask("B2: the same, with no status on the program", request(head, [first, { kind: "turn", output: JSON.parse(JSON.stringify(bare)) }, back], a.id))
    }
  }
} else {
  console.log("usage: bun tools/probe.ts models | cache <model> | tool <model>")
}
process.exit(0)
