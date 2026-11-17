// Tests of the stack of a host's chat (hosted.ts): a chat built over the
// store that `Chats.store` gives, over a real SQLite file and the tests'
// fake wire (or the fake vendor, for the comparison with the terminal's
// stack), with the real sandbox's thread. No request goes to a real model.

import { expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, PubSub, Scope } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Ask, AskDelay } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { LIMIT } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request, VendorWire } from "@everchat/core/request"
import { Chats, type Event, type Message, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { OpenAI } from "@everchat/openai"
import { chatsLayer } from "@everchat/sqlite/bun"
import { fakeWire, newFile, PICK, reply, rows, wireError } from "../tests/help.ts"
import { program as vendorProgram, text as vendorText, vendor } from "../tests/vendor.ts"
import { CALLS, DEADLINE, engineOptions, hostedStack, MAX } from "./hosted.ts"
import { KEY_VARIABLE, URL_VARIABLE } from "./gateway.ts"
import { layer as terminalLayer } from "./main.ts"

const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
const COMPACTOR = { ...PICK, model: "gpt-test-compactor" }
const launchOf = () => ({ pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test", runTag: "tag-" + crypto.randomUUID() })

// Answers of the fake wire.
const done = (asked: Request): Reply => reply(asked, { text: "Done.", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] })
const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, { text: "", output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }], calls: [{ id, name: "run", input: program }] })
// A compaction's request: its last block holds a compaction's task.
const isCompaction = (asked: Request) => JSON.stringify(asked.items).includes("Compaction: ")
// A model that runs `programs`, one per step of a chat's turns, then says
// "Done."; a compaction gets a line.
const model = (...programs: ReadonlyArray<string>) => {
  const steps = new Map<string, number>()
  return fakeWire((asked): Reply => {
    if (isCompaction(asked)) return reply(asked, { text: "a line" })
    const step = (steps.get(asked.session) ?? 0) + 1
    steps.set(asked.session, step)
    const program = programs[step - 1]
    return program === undefined ? done(asked) : runs(asked, "call_" + step, program)
  })
}
const turnsOf = (sent: ReadonlyArray<Request>) => sent.filter((asked) => !isCompaction(asked))
// What the model was shown of the last program: its result.
const back = (asked: Request | undefined): string => {
  const last = asked?.items[asked.items.length - 1]
  return last?.kind === "back" ? last.results[0]?.output ?? "" : "(no result)"
}

interface Chat {
  readonly uuid: string
  readonly store: typeof Store.Service
  readonly context: Context.Context<Turns | Memory>
  readonly turns: typeof Turns.Service
}

// A host's file: `Chats` over a new SQLite file, the stack with `options`,
// and `open`, which makes a chat of a tenant and builds its stack over the
// store that `Chats.store` gives, in the case's scope.
const hosted = <A, E>(
  options: {
    readonly wire?: Layer.Layer<VendorWire> | undefined
    readonly hub?: number
    readonly max?: number | undefined
    readonly calls?: number | undefined
    readonly deadline?: number | undefined
  },
  body: (open: (tenant: string) => Effect.Effect<Chat, unknown, Scope.Scope>) => Effect.Effect<A, E, Scope.Scope>,
  file = newFile()
) =>
  Effect.runPromise(Effect.gen(function*() {
    const chats = Context.get(yield* Layer.build(chatsLayer(file)), Chats)
    const stack = yield* hostedStack({ compactor: COMPACTOR, hub: options.hub ?? 1_024, max: options.max, calls: options.calls, deadline: options.deadline, wire: options.wire })
    const open = (tenant: string) =>
      Effect.gen(function*() {
        const uuid = yield* chats.make(tenant, PICK)
        const store = yield* chats.store(tenant, uuid, launchOf())
        const context = yield* Layer.build(stack(store))
        return { uuid, store, context, turns: Context.get(context, Turns) }
      })
    return yield* body(open)
  }).pipe(Effect.scoped, Effect.provideService(AskDelay, () => Effect.succeed(0))))

const say = (chat: { readonly turns: typeof Turns.Service }, text: string) => Effect.andThen(chat.turns.say(text), chat.turns.idle)

// Waits, in real time, until `check` holds (5 s at most).
const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 1_000 && !check(); k++) yield* Effect.sleep("5 millis")
    if (!check()) return yield* Effect.die(new Error("the case waited for a state that did not come"))
  })

// The log and the events of a chat, with what differs between two runs
// aside: the times, the launch, and a time of day that `date` gives.
const DATE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, field) => (key === "created" || key === "launch" ? undefined : field)).replace(DATE, "<date>"))
const stateOf = (store: typeof Store.Service) =>
  Effect.gen(function*() {
    const count = yield* store.count
    const log: Array<Message> = yield* store.messages(0, count + 1)
    const events: Array<Event> = yield* store.eventsAfter(0, 1_000)
    return plain({ log, events }) as { log: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> }
  })

// Each `Bun.spawn` and `Bun.spawnSync` from `watch` on, until `restore`.
const watchSpawns = () => {
  const bun = Bun as unknown as Record<"spawn" | "spawnSync", (...args: Array<unknown>) => unknown>
  const original = { spawn: bun.spawn, spawnSync: bun.spawnSync }
  const seen: Array<unknown> = []
  bun.spawn = (...args) => {
    seen.push(args[0])
    return original.spawn(...args)
  }
  bun.spawnSync = (...args) => {
    seen.push(args[0])
    return original.spawnSync(...args)
  }
  return {
    seen,
    restore: () => {
      bun.spawn = original.spawn
      bun.spawnSync = original.spawnSync
    }
  }
}

// The files under `dir`, by their paths from it.
const listing = (dir: string): Array<string> => fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as Array<string>).sort() : []

// (a)
test("a message to a chat built over Chats.store runs a turn whose programs call date and result: the log and the events are those of the terminal's stack for the same answers (the fake vendor, over the gateway's wire)", async () => {
  const PROGRAMS = ["return 'the first result'", "return [await date(1), await result(1)].join(' | ')"]
  const answers = (n: number) => (n <= PROGRAMS.length ? vendorProgram("c" + n, PROGRAMS[n - 1]!) : vendorText("Done."))
  const setGateway = (address: string) => {
    process.env[URL_VARIABLE] = address
    process.env[KEY_VARIABLE] = "test-key"
  }
  const terminalVendor = vendor((n) => answers(n))
  const hostVendor = vendor((n) => answers(n))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-hosted-"))
  try {
    // The terminal's stack (main.ts, `layer`), over its own file.
    setGateway(terminalVendor.address)
    const terminal = await Effect.runPromise(Effect.gen(function*() {
      yield* say({ turns: yield* Turns }, "what is the date?")
      return yield* stateOf(yield* Store)
    }).pipe(
      Effect.provide(terminalLayer({ home: root, file: path.join(root, "terminal.db"), cwd: root, pick: PICK, compactor: COMPACTOR })),
      Effect.provideService(AskDelay, () => Effect.succeed(0))
    ))
    // The host's stack, with the gateway's wire (no `wire` given).
    setGateway(hostVendor.address)
    const host = await hosted({}, (open) =>
      Effect.gen(function*() {
        const chat = yield* open(TENANT_A)
        yield* say(chat, "what is the date?")
        return yield* stateOf(chat.store)
      }))
    // The second program got the date of message 1 and the first result.
    const echoes = host.log.filter((message) => message["kind"] === "echo").map((message) => message["text"])
    expect(echoes).toEqual(["the first result", "<date> | the first result"])
    expect(host.events.map((event) => event["type"])).toEqual(terminal.events.map((event) => event["type"]))
    expect(host).toEqual(terminal)
    // Each vendor got the three requests of the turn.
    expect([terminalVendor.bodies.length, hostVendor.bodies.length]).toEqual([3, 3])
  } finally {
    terminalVendor.stop()
    hostVendor.stop()
    delete process.env[URL_VARIABLE]
    delete process.env[KEY_VARIABLE]
  }
}, 20_000)

// (b)
test("the declarations of every request are HOSTED's three and no other, a turn's and a compaction's; a program that calls shell, read, write or edit fails for each with the sandbox's error for a name that is not there: no file appears under the watched directory, the file there is the same, and no child process starts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-hosted-watch-"))
  fs.writeFileSync(path.join(dir, "kept.txt"), "kept\n")
  const programs = [
    `return await shell("touch ${dir}/shell.txt")`,
    `return await read("${dir}/kept.txt")`,
    `return await write("${dir}/write.txt", "x")`,
    `return await edit([{ path: "${dir}/kept.txt", old: "kept", new: "changed" }])`
  ]
  const wire = model(...programs)
  const spawns = watchSpawns()
  try {
    await hosted({ wire: wire.layer }, (open) =>
      Effect.gen(function*() {
        const chat = yield* open(TENANT_A)
        // A message longer than a node: its leaf is a compaction.
        yield* say(chat, "call them all " + "and more ".repeat(80))
        yield* until(() => wire.sent.some(isCompaction))
      }))
    const turns = turnsOf(wire.sent)
    expect(turns.length).toBe(programs.length + 1)
    // Each program's result is the sandbox's error for its name.
    const results = turns.slice(1).map(back)
    for (const [k, name] of ["shell", "read", "write", "edit"].entries()) {
      expect([name, results[k]]).toEqual([name, expect.stringMatching(new RegExp(`${name}.*not defined|not defined.*${name}`))])
    }
    // Every request shows the head of HOSTED, and its tool names no other function.
    const hosted3 = head(HOSTED)
    expect(wire.sent.filter((asked) => JSON.stringify(asked.head) !== JSON.stringify(hosted3))).toEqual([])
    const tool = hosted3.tools[0]!.description
    for (const name of ["zoom", "date", "result"]) expect(tool).toContain(name + "(")
    for (const name of ["shell", "read", "write", "edit"]) expect(tool).not.toContain(name + "(")
    expect(listing(dir)).toEqual(["kept.txt"])
    expect(fs.readFileSync(path.join(dir, "kept.txt"), "utf8")).toBe("kept\n")
    expect(spawns.seen).toEqual([])
  } finally {
    spawns.restore()
  }
}, 20_000)

// (c)
test("a long result is shortened and names result(id), and no file is written: no directory of the chat's results under the system's temporary directory", async () => {
  const wire = model(`return "x".repeat(${LIMIT * 2})`)
  const uid = process.getuid?.() ?? 0
  const got = await hosted({ wire: wire.layer }, (open) =>
    Effect.gen(function*() {
      const chat = yield* open(TENANT_A)
      yield* say(chat, "a long one")
      return { uuid: chat.uuid }
    }))
  const shown = back(turnsOf(wire.sent)[1])
  expect(shown.length).toBeLessThan(LIMIT * 2)
  expect(shown).toContain("result(1)")
  expect(shown).not.toContain(".txt")
  expect(fs.existsSync(path.join(os.tmpdir(), "everchat-" + uid, got.uuid))).toBe(false)
})

// (d)
test("two chats of two stores at one time: each one's log, events and diagnostics are its own; the wire was built one time, and the cache watch and the memory one time for each chat", async () => {
  const file = newFile()
  let wires = 0
  // Each chat's first request fails once, with its own text: the ask
  // service's diagnostic of that retry goes into that chat's log.
  const failed = new Set<string>()
  const answer = (asked: Request) => {
    if (isCompaction(asked)) return reply(asked, { text: "a line" })
    if (!failed.has(asked.session)) {
      failed.add(asked.session)
      return wireError("busy", { message: "an outage of " + asked.session })
    }
    const said = JSON.stringify(asked.items)
    return said.includes("\"back\"") ? done(asked) : runs(asked, "call_1", `return "worked for " + ${JSON.stringify(asked.session)}`)
  }
  const wire = fakeWire(answer)
  const counted = Layer.effect(OpenAI, Effect.sync(() => {
    wires += 1
    return OpenAI.of(wire.wire)
  }))
  // The builds of the cache watch and of the memory, from the core's layers.
  const builds = { cache: 0, memory: 0 }
  const layers = { cache: Cache.layer, memory: Memory.layer }
  const patch = (target: object, layer: Layer.Layer<never> | Layer.Layer<any, any, any>, count: () => void) =>
    Object.defineProperty(target, "layer", { value: Layer.merge(layer, Layer.effectDiscard(Effect.sync(count))), configurable: true, writable: true })
  patch(Cache, layers.cache, () => builds.cache++)
  patch(Memory, layers.memory, () => builds.memory++)
  try {
    const got = await hosted({ wire: counted }, (open) =>
      Effect.gen(function*() {
        const [a, b] = yield* Effect.all([open(TENANT_A), open(TENANT_B)], { concurrency: 2 })
        yield* Effect.all([say(a, "hello from A"), say(b, "hello from B")], { concurrency: 2 })
        return { a: { uuid: a.uuid, ...(yield* stateOf(a.store)) }, b: { uuid: b.uuid, ...(yield* stateOf(b.store)) } }
      }), file)
    expect({ wires, ...builds }).toEqual({ wires: 1, cache: 2, memory: 2 })
    for (const [own, other, said] of [[got.a, got.b, "hello from A"], [got.b, got.a, "hello from B"]] as const) {
      const texts = own.log.map((message) => message["text"])
      expect(texts).toEqual([said, `return "worked for " + ${JSON.stringify(own.uuid)}`, "worked for " + own.uuid, "Done."])
      expect(JSON.stringify(own)).not.toContain(other.uuid)
      expect(own.events.map((event) => event["type"])).toEqual(["accepted", "start", "call", "message", "message", "message", "end"])
    }
    // The diagnostics, by chat: each has its own outage and not the other's.
    const lines = (uuid: string) =>
      rows<{ text: string }>(file, `select text from everchat_log where chat = (select id from everchat_chat where uuid = x'${uuid.replaceAll("-", "")}') order by n`).map((row) => row.text)
    const ofA = lines(got.a.uuid).join("\n")
    const ofB = lines(got.b.uuid).join("\n")
    expect(ofA).toContain("an outage of " + got.a.uuid)
    expect(ofA).not.toContain(got.b.uuid)
    expect(ofB).toContain("an outage of " + got.b.uuid)
    expect(ofB).not.toContain(got.a.uuid)
  } finally {
    Object.defineProperty(Cache, "layer", { value: layers.cache, configurable: true, writable: true })
    Object.defineProperty(Memory, "layer", { value: layers.memory, configurable: true, writable: true })
  }
}, 20_000)

// (e)
test("the hub: with the capacity 2 and a listener that does not take, a turn ends without a wait, and the listener holds only the two newest events", async () => {
  const wire = model("return 1", "return 2")
  const got = await hosted({ wire: wire.layer, hub: 2 }, (open) =>
    Effect.gen(function*() {
      const chat = yield* open(TENANT_A)
      const listener = yield* chat.turns.subscribe
      const ended = yield* Effect.timeoutOption(say(chat, "two programs"), "5 seconds")
      const held = yield* PubSub.remaining(listener)
      const newest = yield* PubSub.takeAll(listener)
      const events = yield* chat.store.eventsAfter(0, 1_000)
      return { ended: ended._tag, held, newest: newest.map((event) => event.type), all: events.length, last: events.slice(-2).map((event) => event.type) }
    }))
  expect(got.ended).toBe("Some")
  expect(got.all).toBeGreaterThan(2)
  expect(got.held).toBe(2)
  expect(got.newest).toEqual(got.last)
})

// (f)
test("the cap of one answer: a turn's and a compaction's request get max at most the cap; through the chat's ask service a request with none or a larger gets the cap, one with a smaller keeps its own; with no max given the cap is 16,384", async () => {
  const ask = (chat: Chat) => Context.get(chat.context as unknown as Context.Context<Ask>, Ask)
  const asked = (wire: ReturnType<typeof fakeWire>, chat: Chat, max: number | undefined) =>
    Effect.gen(function*() {
      const from = wire.sent.length
      yield* ask(chat).ask({ session: chat.uuid, pick: PICK, head: head(HOSTED), items: [{ kind: "user", blocks: [{ text: "x", mark: false }] }], ...(max === undefined ? {} : { max }) })
      return wire.sent[from]?.max
    })
  for (const [cap, given] of [[1_000, 1_000], [MAX, undefined]] as const) {
    const wire = model()
    const got = await hosted({ wire: wire.layer, max: given }, (open) =>
      Effect.gen(function*() {
        const chat = yield* open(TENANT_A)
        // A message longer than a node: its leaf is a compaction.
        yield* say(chat, "a long message " + "and more ".repeat(80))
        yield* until(() => wire.sent.some(isCompaction))
        return [yield* asked(wire, chat, undefined), yield* asked(wire, chat, cap + 1), yield* asked(wire, chat, cap - 1), yield* asked(wire, chat, cap)]
      }))
    const turn = wire.sent.find((one) => !isCompaction(one))
    const compaction = wire.sent.find(isCompaction)
    expect([cap, turn?.max, compaction?.max]).toEqual([cap, cap, cap])
    expect([cap, got]).toEqual([cap, [cap, cap, cap - 1, cap]])
  }
}, 20_000)

// (f), ruling 5's measure
test("the measure of the cap in bytes: an answer of 393,216 bytes (16,384 tokens at 24 bytes) in one program gives a call event whose JSON is under 394,452 bytes, the largest accepted at the defaults", async () => {
  const BYTES = MAX * 24
  const prefix = "return 1\n//"
  const program = prefix + "x".repeat(BYTES - prefix.length)
  expect(new TextEncoder().encode(program).length).toBe(393_216)
  const wire = model(program)
  const size = await hosted({ wire: wire.layer }, (open) =>
    Effect.gen(function*() {
      const chat = yield* open(TENANT_A)
      yield* say(chat, "a long program")
      const call = (yield* chat.store.eventsAfter(0, 1_000)).find((event) => event.type === "call")
      return new TextEncoder().encode(JSON.stringify(call)).length
    }))
  console.log("the call event's JSON of a 393,216-byte program:", size, "bytes")
  expect(size).toBeGreaterThan(393_216)
  expect(size).toBeLessThan(394_452)
}, 20_000)

// The bounds of one program (review ec-ihoya): the program's own call row
// and the rows of the functions that it called, by the program's text.
const programRows = (file: string, program: string) => {
  const own = rows<{ n: number; input: string }>(file, "select n, input from everchat_call where parent is null").find((row) => row.input === program)
  return own === undefined ? [] : rows<{ status: string; bytes: number }>(
    file,
    "select status, coalesce(length(input), 0) + coalesce(length(output), 0) as bytes from everchat_call where parent = " + own.n
  )
}
const fileBytes = (file: string) => fs.statSync(file).size + (fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0)
const MANY = (most: number) => "The program was stopped: it reached the limit of " + most + " calls of functions in one program. Call fewer functions in one program."
const LATE = (seconds: number, working: number) =>
  "The program was stopped: it ran for " + seconds + " s, the limit of one program, and functions were at work for " + working + " s of that time. Do less in one program."

// (e) of ec-4g2dv
test("the review's programs with calls 8: a result of 50,000 bytes, then a loop of result(1) with no end: the turn ends, the store holds 8 call rows of the loop, and the model is told the limit", async () => {
  const LOOP = "for (;;) { await result(1) }"
  const file = newFile()
  const wire = model(`return "y".repeat(50000)`, LOOP)
  const got = await hosted({ wire: wire.layer, calls: 8 }, (open) =>
    Effect.gen(function*() {
      const chat = yield* open(TENANT_A)
      const ended = yield* Effect.timeoutOption(say(chat, "loop"), "10 seconds")
      return { ended: ended._tag, busy: yield* chat.turns.busy }
    }), file)
  expect(got).toEqual({ ended: "Some", busy: false })
  const loop = programRows(file, LOOP)
  expect(loop.length).toBe(8)
  expect(loop.every((row) => row.status === "done")).toBe(true)
  expect(back(turnsOf(wire.sent)[2])).toBe(MANY(8))
  const all = rows<{ n: number; bytes: number }>(file, "select count(*) as n, coalesce(sum(length(input)), 0) + coalesce(sum(length(output)), 0) as bytes from everchat_call")[0]!
  console.log("calls 8: the loop's rows", loop.length, "with", loop.reduce((sum, row) => sum + row.bytes, 0), "bytes; all call rows", all.n, "with", all.bytes, "bytes; the file and its WAL", fileBytes(file), "bytes")
}, 30_000)

// (f) of ec-4g2dv
test("hostedStack with no option gives the thread engine the deadline 600,000 ms and the count 256: a loop of date(0) makes 256 calls and is stopped (the deadline at work is (g)'s)", async () => {
  const engine = engineOptions({ compactor: COMPACTOR, hub: 1_024 })
  expect([DEADLINE, CALLS]).toEqual([600_000, 256])
  expect({ deadline: engine.deadline, calls: engine.calls }).toEqual({ deadline: 600_000, calls: 256 })
  expect(engine.worker?.pathname.endsWith("/packages/local/src/worker.ts")).toBe(true)
  // The count at work in a stack built with no option.
  const LOOP = "for (;;) { await date(0) }"
  const file = newFile()
  const wire = model(LOOP)
  const ended = await hosted({ wire: wire.layer }, (open) =>
    Effect.gen(function*() {
      const chat = yield* open(TENANT_A)
      return (yield* Effect.timeoutOption(say(chat, "loop"), "10 seconds"))._tag
    }), file)
  expect(ended).toBe("Some")
  expect(programRows(file, LOOP).length).toBe(256)
  expect(back(turnsOf(wire.sent)[1])).toBe(MANY(256))
}, 30_000)

// (g) of ec-1t1qi: the deadline at work, through hostedStack. The program
// calls no function, so the time of the functions at work is 0 s at any
// load, and the limit's seconds come from the option: the text is exact.
test("hostedStack with deadline 1,000 ms: a program that does not end and calls no function is stopped, the turn ends, the chat is not busy, and the model is told the deadline's text with 1 s and 0 s at work", async () => {
  const LOOP = "for (;;) {}"
  const wire = model(LOOP)
  const started = performance.now()
  const got = await hosted({ wire: wire.layer, deadline: 1_000 }, (open) =>
    Effect.gen(function*() {
      const chat = yield* open(TENANT_A)
      const ended = yield* Effect.timeoutOption(say(chat, "loop"), "10 seconds")
      return { ended: ended._tag, busy: yield* chat.turns.busy }
    }))
  console.log("deadline 1,000 ms: the turn ended in", Math.round(performance.now() - started), "ms")
  expect(got).toEqual({ ended: "Some", busy: false })
  expect(back(turnsOf(wire.sent)[1])).toBe(LATE(1, 0))
}, 30_000)
