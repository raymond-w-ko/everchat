// The smoke test of the host with the local stack (docs/research/portability.md,
// "The smallest smoke test"; docs/host.md, section 8, "What is not proved
// here"): `serve` on a real Bun server built with `serverOptions`, over a real
// SQLite file, with the stack of a host's chat (`hostedStack` of
// `@everchat/local/hosted`) and a fake wire in place of the gateway's. No
// request goes to a real model.
//
// The body: one message with an outside key in by R1, its turn (a program
// that calls `date`, then a text), the same whole events by R4, R5 and R6
// (each field, against one list of what the turn holds), a read again from 3
// that gives the same events whole, and the same message again. Then the measures, each one line
// of the output with the machine's load average: the time of a load, the
// memory of a loaded chat, the time of a piece to a client (asserted under
// 1 s), and the memory of 16 first reads of a chat with 5,000 events.

import { expect, test } from "bun:test"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Context, Effect, Exit, Layer, Logger, Redacted, Scope, Stream } from "effect"
import { HttpServer } from "effect/http"
import * as os from "node:os"
import { type Event as WireEvent, type Reply, type Request as Asked, VendorWire } from "@everchat/core/request"
import { Chats, type NewMessage } from "@everchat/core/store"
import { hostedStack } from "@everchat/local/hosted"
import { newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import { makeChat, makeToken } from "./backend.ts"
import { serve, serverOptions } from "./index.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 5 * i + 3))
const TENANT = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c"

// The fake wire's answers, by the chat's id (`session`): a script gives the
// events of each request of that chat; with none, the text "Done.".
type Script = (asked: Asked, n: number) => Stream.Stream<WireEvent>
const ended = (got: Reply): Stream.Stream<WireEvent> => Stream.make({ type: "end", reply: got })
const said = (asked: Asked, text: string) => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })
const runs = (asked: Asked, id: string, program: string) =>
  reply(asked, { text: "", output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }], calls: [{ id, name: "run", input: program }] })

interface Served {
  readonly port: number
  readonly url: string // http://127.0.0.1:<port>/v1/chats/
  readonly file: string
  readonly chats: typeof Chats.Service
  readonly scripts: Map<string, Script>
  readonly asked: Array<Asked>
  readonly chat: () => Promise<string>
  readonly token: (chats: ReadonlyArray<string>) => Promise<string>
  readonly close: () => Promise<void>
}

const served = async (): Promise<Served> => {
  const file = newFile()
  const scope = Effect.runSync(Scope.make())
  const scripts = new Map<string, Script>()
  const asked: Array<Asked> = []
  const counts = new Map<string, number>()
  // The wire of the vendor "openai" (the picks' vendor), as the core names it.
  const openai = VendorWire("openai")
  const wire = Layer.succeed(
    openai,
    openai.of({
      send: (request) =>
        Stream.suspend(() => {
          asked.push(request)
          const n = (counts.get(request.session) ?? 0) + 1
          counts.set(request.session, n)
          const script = scripts.get(request.session)
          return script === undefined ? ended(said(request, "Done.")) : script(request, n)
        })
    })
  )
  const built = await Effect.runPromise(Effect.gen(function*() {
    const chats = Context.get(yield* Layer.buildWithScope(chatsLayer(file), scope), Chats)
    const server = yield* Layer.buildWithScope(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...serverOptions() }), scope)
    const stack = yield* hostedStack({ compactor: PICK, hub: 1_024, wire }).pipe(Effect.provideService(Scope.Scope, scope))
    yield* Layer.buildWithScope(
      serve({ stack, launch: LAUNCH, secret: SECRET, origins: [] }).pipe(
        Layer.provide(Layer.succeed(Chats, chats)),
        Layer.provide(Layer.succeedContext(server))
      ),
      yield* Scope.fork(scope, "sequential")
    )
    return { chats, port: (Context.get(server, HttpServer.HttpServer).address as { port: number }).port }
  }).pipe(Effect.provide(Logger.layer([]))))
  return {
    port: built.port,
    url: `http://127.0.0.1:${built.port}/v1/chats/`,
    file,
    chats: built.chats,
    scripts,
    asked,
    chat: () => Effect.runPromise(makeChat(built.chats, TENANT, PICK)),
    token: (chats) => Effect.runPromise(Effect.orDie(makeToken(SECRET, { tenant: TENANT, chats: [...chats], exp: Math.floor(Date.now() / 1000) + 600 }))),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const within = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await sleep(2)
  return check()
}
const load = () => os.loadavg().map((one) => one.toFixed(2)).join(" ")
const rss = () => process.memoryUsage().rss
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + " MiB"
const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

// R1: a message in, with a key when given.
const post = (s: Served, chat: string, token: string, text: string, key?: string) =>
  fetch(s.url + chat + "/messages", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) },
    body: JSON.stringify({ text })
  })

// An event stream (R4) read in the background: its frames as they come,
// each with the time it came.
const streamOf = async (url: string, token: string) => {
  const controller = new AbortController()
  const response = await fetch(url, { headers: { authorization: "Bearer " + token, accept: "text/event-stream" }, signal: controller.signal })
  const frames: Array<{ readonly id: number | null; readonly event: string; readonly data: Record<string, unknown>; readonly at: number }> = []
  let rest = ""
  void (async () => {
    try {
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const at = performance.now()
        rest += decoder.decode(value, { stream: true })
        const parts = rest.split("\n\n")
        rest = parts.pop() ?? ""
        for (const part of parts) {
          const fields: Record<string, string> = {}
          for (const line of part.split("\n")) {
            const colon = line.indexOf(":")
            if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart()
          }
          if (fields["data"] === undefined) continue
          frames.push({ id: fields["id"] === undefined ? null : Number(fields["id"]), event: fields["event"] ?? "", data: JSON.parse(fields["data"]), at })
        }
      }
    } catch {
      // Stopped by the case.
    }
  })()
  return { response, frames, numbered: () => frames.filter((frame) => frame.id !== null), stop: () => controller.abort() }
}

// A socket (R6) with its `auth` from `after`: its frames, each with the time it came.
const socketOf = async (s: Served, chat: string, token: string, after: number) => {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/v1/chats/${chat}/socket`)
  const frames: Array<{ readonly data: Record<string, unknown>; readonly at: number }> = []
  ws.onmessage = (event) => frames.push({ data: JSON.parse(String(event.data)), at: performance.now() })
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("the socket did not open"))
  })
  ws.send(JSON.stringify({ type: "auth", token, after }))
  expect(await within(() => frames.some((frame) => frame.data["type"] === "ready"), 2_000)).toBe(true)
  return { ws, frames, numbered: () => frames.filter((frame) => typeof frame.data["n"] === "number") }
}

// R5: the events after `after`, with no wait.
const polled = async (s: Served, chat: string, token: string, after: number) => {
  const got = await fetch(s.url + chat + "/events?after=" + after, { headers: { authorization: "Bearer " + token } })
  expect(got.status).toBe(200)
  return ((await got.json()) as { events: Array<{ n: number; type: string }> }).events
}

const BIN = (uuid: string) => "x'" + uuid.replaceAll("-", "") + "'"
const kinds = (s: Served, chat: string) =>
  rows<{ kind: string }>(
    s.file,
    `select k.name as kind from everchat_msg m join everchat_kind k on k.id = m.kind where m.chat = (select id from everchat_chat where uuid = ${BIN(chat)}) order by m.i`
  ).map((row) => row.kind)
// Each call's row: the program's, and each function's under it.
const calls = (s: Served, chat: string) =>
  rows<{ n: number; parent: number | null; fn: string; status: string }>(
    s.file,
    `select n, parent, fn, status from everchat_call where chat = (select id from everchat_chat where uuid = ${BIN(chat)}) order by n`
  ).map((row) => [row.n, row.parent, row.fn, row.status])
const ends = (s: Served) => rows<{ n: number }>(s.file, "select count(*) as n from everchat_event where type = 'end'")[0]!.n

const TYPES = ["accepted", "start", "call", "message", "message", "message", "end"]
const SEVEN = [1, 2, 3, 4, 5, 6, 7]

// The body's program, and what the person and the model say around it.
const ASKED = "what is the date?"
const PROGRAM = "return await date(0)"
const ANSWERED = "It is that date."

// What the run makes and no test can know before it: the turn's number, the
// call's, the launch's, each message's time (in the order of the log) and the
// echo's text (the date that the program's `date(0)` gave).
interface Made {
  readonly turn: number
  readonly call: number
  readonly launch: number
  readonly created: readonly [number, number, number, number]
  readonly date: string
}

// The seven events of the body's turn (docs/host.md, section 5, "The
// events"), field for field, with the made values in their places: the
// person's message in `accepted`, the turn's `start`, the program's `call`,
// its three messages (the program as `tool`, its output as `echo`, the
// model's text as `asst`), and `end`, done, with no `why`.
const message = (i: number, kind: string, text: string, turn: number | null, call: number | null, launch: number, created: number) => ({
  i,
  kind,
  text,
  size: text.length,
  more: false,
  line: null,
  turn,
  call,
  launch,
  created
})
const sevenOf = (made: Made) => [
  { type: "accepted", n: 1, messages: [message(0, "user", ASKED, null, null, made.launch, made.created[0])] },
  { type: "start", n: 2, turn: made.turn },
  { type: "call", n: 3, turn: made.turn, call: made.call, program: PROGRAM },
  { type: "message", n: 4, message: message(1, "tool", PROGRAM, made.turn, made.call, made.launch, made.created[1]) },
  { type: "message", n: 5, message: message(2, "echo", made.date, made.turn, made.call, made.launch, made.created[2]) },
  { type: "message", n: 6, message: message(3, "asst", ANSWERED, made.turn, null, made.launch, made.created[3]) },
  { type: "end", n: 7, turn: made.turn, status: "done", why: null }
]

// The made values of a list of the seven events, each checked by its form:
// the turn, the call and the launch whole numbers of 1 or more; the times
// whole milliseconds since 1970, not before the case began and not after now,
// in the order of the log; the date as `date` gives it.
const madeOf = (events: ReadonlyArray<Record<string, unknown>>, began: number): Made => {
  const messageAt = (k: number) => (k === 0 ? (events[0]!["messages"] as Array<Record<string, unknown>>)[0]! : (events[k + 2]!["message"] as Record<string, unknown>))
  const made: Made = {
    turn: events[1]!["turn"] as number,
    call: events[2]!["call"] as number,
    launch: messageAt(0)["launch"] as number,
    created: [0, 1, 2, 3].map((k) => messageAt(k)["created"] as number) as unknown as Made["created"],
    date: messageAt(2)["text"] as string
  }
  for (const id of [made.turn, made.call, made.launch]) expect([id, Number.isSafeInteger(id) && id >= 1]).toEqual([id, true])
  for (const at of made.created) expect([at, Number.isSafeInteger(at) && at >= began && at <= Date.now()]).toEqual([at, true])
  expect([...made.created].sort((a, b) => a - b)).toEqual([...made.created])
  expect(made.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  return made
}

// An R4 frame's event: its `data`, after its frame fields `id` and `event`
// are checked against the event's `n` and `type`.
const eventOf = (frame: { readonly id: number | null; readonly event: string; readonly data: Record<string, unknown> }) => {
  expect([frame.id, frame.event]).toEqual([frame.data["n"] as number, frame.data["type"] as string])
  return frame.data
}

test("the smoke test: one message with an outside key in by R1; the log has user, tool, echo, asst; the call is done; the events are accepted, start, call, three messages and end, numbered 1 to 7, the same by R4, R5 and R6; a listener that reads again from 3 gets 3 to 7 and drops none as a duplicate; the same message again adds nothing and answers as a repeat", async () => {
  const began = Date.now()
  const s = await served()
  try {
    const chat = await s.chat()
    const token = await s.token([chat])
    // A program that calls `date`, then a text.
    s.scripts.set(chat, (asked, n) => ended(n === 1 ? runs(asked, "call_1", PROGRAM) : said(asked, ANSWERED)))
    const stream = await streamOf(s.url + chat + "/events?after=0", token)
    expect(stream.response.status).toBe(200)
    const socket = await socketOf(s, chat, token, 0)
    const sent = await post(s, chat, token, "what is the date?", "key-1")
    expect(sent.status).toBe(200)
    const first = (await sent.json()) as Record<string, unknown>
    expect(first).toMatchObject({ n: 1, repeat: false })
    expect(await within(() => stream.numbered().length === 7 && socket.numbered().length === 7, 5_000)).toBe(true)

    expect(kinds(s, chat)).toEqual(["user", "tool", "echo", "asst"])
    // The program's call is done, and so is its call of `date`.
    expect(calls(s, chat)).toEqual([[1, null, "run", "done"], [2, 1, "date", "done"]])
    const r4 = stream.numbered()
    const r5 = await polled(s, chat, token, 0)
    const r6 = socket.numbered()
    expect([r4.map((frame) => frame.id), r4.map((frame) => frame.event)]).toEqual([SEVEN, TYPES])
    expect([r5.map((event) => event.n), r5.map((event) => event.type)]).toEqual([SEVEN, TYPES])
    expect([r6.map((frame) => frame.data["n"]), r6.map((frame) => frame.data["type"])]).toEqual([SEVEN, TYPES])
    // The whole events, the same by the three ways and as the turn made them:
    // the made values are read from R4's and checked by their form; each way
    // must then give the seven events of `sevenOf`, field for field.
    const r4Events = r4.map(eventOf)
    const r6Events = r6.map((frame) => frame.data)
    const seven = sevenOf(madeOf(r4Events, began))
    expect([r4Events, r5, r6Events]).toEqual([seven, seven, seven])

    // A listener that has 1 and 2 reads again from 3, by each way: it gets
    // 3 to 7, each one time, and drops none as a duplicate.
    const again = async (numbers: ReadonlyArray<number>) => {
      const seen = new Set([1, 2])
      const dropped = numbers.filter((n) => seen.has(n))
      for (const n of numbers) seen.add(n)
      return { numbers, dropped }
    }
    const fromThree = { numbers: [3, 4, 5, 6, 7], dropped: [] }
    const polled2 = await polled(s, chat, token, 2)
    expect(await again(polled2.map((event) => event.n))).toEqual(fromThree)
    const stream2 = await streamOf(s.url + chat + "/events?after=2", token)
    const socket2 = await socketOf(s, chat, token, 2)
    expect(await within(() => stream2.numbered().length >= 5 && socket2.numbered().length >= 5, 2_000)).toBe(true)
    await sleep(50)
    expect(await again(stream2.numbered().map((frame) => frame.id!))).toEqual(fromThree)
    expect(await again(socket2.numbered().map((frame) => frame.data["n"] as number))).toEqual(fromThree)
    // The read again gives 3 to 7 whole, as the first read gave them.
    const fromThreeEvents = seven.slice(2)
    expect([stream2.numbered().map(eventOf), polled2, socket2.numbered().map((frame) => frame.data)]).toEqual([
      fromThreeEvents,
      fromThreeEvents,
      fromThreeEvents
    ])

    // The same message again, with the same key: a repeat, and nothing more.
    const requests = s.asked.length
    const repeat = await post(s, chat, token, "what is the date?", "key-1")
    expect(repeat.status).toBe(200)
    expect(await repeat.json()).toEqual({ ...first, repeat: true })
    await sleep(50)
    expect(kinds(s, chat)).toEqual(["user", "tool", "echo", "asst"])
    expect((await polled(s, chat, token, 0)).map((event) => event.n)).toEqual(SEVEN)
    expect(s.asked.length).toBe(requests)
    for (const one of [stream, stream2]) one.stop()
    for (const one of [socket, socket2]) one.ws.close()
  } finally {
    await s.close()
  }
}, 15_000)

test("the measures: the time of a load (a chat that is not loaded, and one that is, the median of 20 each), the memory of a loaded chat (50 chats loaded and idle), and a piece's time to an R4 and an R6 client (the largest of 100: under 1 s)", async () => {
  const s = await served()
  try {
    const chats = await Promise.all(Array.from({ length: 50 }, () => s.chat()))
    const tokens = await Promise.all(chats.map((chat) => s.token([chat])))
    // The time of a load: R1's head to its `200`.
    const timed = async (k: number, text: string) => {
      const at = performance.now()
      const got = await post(s, chats[k]!, tokens[k]!, text)
      expect(got.status).toBe(200)
      await got.arrayBuffer()
      return performance.now() - at
    }
    Bun.gc(true)
    const before = rss()
    const cold: Array<number> = []
    for (let k = 0; k < chats.length; k++) cold.push(await timed(k, "hello"))
    expect(await within(() => ends(s) === chats.length, 5_000)).toBe(true)
    await sleep(100)
    Bun.gc(true)
    const after = rss()
    const warm: Array<number> = []
    for (let k = 0; k < 20; k++) warm.push(await timed(k, "again"))
    console.log(
      `measure: the time of a load: R1 to 200, the median of 20: not loaded ${median(cold.slice(0, 20)).toFixed(1)} ms, loaded ${
        median(warm).toFixed(1)
      } ms; load average ${load()}`
    )
    console.log(
      `measure: the memory of a loaded chat: resident ${mib(before)} before, ${mib(after)} with 50 chats loaded and idle: ${
        ((after - before) / 50 / 1024 / 1024).toFixed(2)
      } MiB a chat; load average ${load()}`
    )

    // A piece: 100 of them, 3 ms apart, from the fake wire's give to an R4
    // and an R6 client.
    const chat = chats[49]!
    const token = tokens[49]!
    const given = new Map<string, number>()
    s.scripts.set(chat, (asked) =>
      Stream.fromIterable(Array.from({ length: 100 }, (_, k) => k)).pipe(
        Stream.mapEffect((k) =>
          Effect.as(
            Effect.andThen(Effect.sleep("3 millis"), Effect.sync(() => given.set(`<${k}>`, performance.now()))),
            { type: "text", delta: `<${k}>` } as WireEvent
          )
        ),
        Stream.concat(ended(said(asked, Array.from({ length: 100 }, (_, k) => `<${k}>`).join(""))))
      ))
    const stream = await streamOf(s.url + chat + "/events?after=0", token)
    const socket = await socketOf(s, chat, token, 0)
    expect((await post(s, chat, token, "a hundred pieces")).status).toBe(200)
    const pieceAt = (frames: ReadonlyArray<{ readonly data: Record<string, unknown>; readonly at: number }>) => {
      const at = new Map<string, number>()
      for (const frame of frames) if (frame.data["type"] === "text") at.set(String(frame.data["delta"]), frame.at)
      return at
    }
    expect(await within(() => pieceAt(stream.frames).size === 100 && pieceAt(socket.frames).size === 100, 5_000)).toBe(true)
    const largest = (at: Map<string, number>) => Math.max(...[...given].map(([delta, time]) => at.get(delta)! - time))
    const r4 = largest(pieceAt(stream.frames))
    const r6 = largest(pieceAt(socket.frames))
    console.log(`measure: a piece, the fake wire's give to the client, the largest of 100: R4 ${r4.toFixed(1)} ms, R6 ${r6.toFixed(1)} ms; load average ${load()}`)
    expect(r4).toBeLessThan(1_000)
    expect(r6).toBeLessThan(1_000)
    stream.stop()
    socket.ws.close()
  } finally {
    await s.close()
  }
}, 15_000)

test("the measure of the reads under load: 16 clients' first reads at one time of a chat with 5,000 events: the resident size before and at the most", async () => {
  const s = await served()
  try {
    const chat = await s.chat()
    const token = await s.token([chat])
    // 5,000 messages and their events, written by a launch of the chat that
    // ends before the host loads it.
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const store = yield* s.chats.store(TENANT, chat, { ...LAUNCH, runTag: "fill" })
      yield* store.transaction(Effect.gen(function*() {
        const messages: Array<NewMessage> = Array.from({ length: 5_000 }, (_, k) => ({ kind: k % 2 === 0 ? "user" : "asst", text: `message ${k} ` + "x".repeat(200) }))
        const logged = yield* store.append(messages)
        for (const message of logged) yield* store.addEvent({ type: k(message.kind), msg: message.i, msgLast: message.i })
      }))
    })))
    expect(rows<{ n: number }>(s.file, "select count(*) as n from everchat_event")[0]!.n).toBe(5_000)
    Bun.gc(true)
    const before = rss()
    let most = before
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        most = Math.max(most, rss())
        await sleep(5)
      }
    })()
    const t0 = performance.now()
    const streams = await Promise.all(Array.from({ length: 16 }, () => streamOf(s.url + chat + "/events?after=0", token)))
    for (const one of streams) expect(one.response.status).toBe(200)
    expect(await within(() => streams.every((one) => one.numbered().length === 5_000), 10_000)).toBe(true)
    const took = performance.now() - t0
    sampling = false
    await sampler
    for (const one of streams) expect(one.numbered().map((frame) => frame.id)).toEqual(Array.from({ length: 5_000 }, (_, n) => n + 1))
    console.log(
      `measure: the reads under load: 16 first reads of 5,000 events at one time in ${(took / 1000).toFixed(2)} s: resident ${mib(before)} before, ${
        mib(most)
      } at the most (+${mib(most - before)}); load average ${load()}`
    )
    for (const one of streams) one.stop()
  } finally {
    await s.close()
  }
}, 15_000)

// The event of a filled message: `accepted` for the person's, `message` for a reply.
const k = (kind: string): "accepted" | "message" => (kind === "user" ? "accepted" : "message")
