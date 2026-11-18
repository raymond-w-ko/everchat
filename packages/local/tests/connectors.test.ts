// A launch with connectors (main.ts, "The connectors"): the config's servers
// are loaded before the layers that take the chat's list, and their
// functions join that one list after the built-ins. The cases run the
// terminal's stack (main.ts, `layer`) in this process, and the whole program
// in pipe mode, each with the fake vendor (over the gateway's wire) and the
// repository's example server (tools/mcpexample.ts) as the config's server.
// No request goes to a real model.
//
// Each child that a launch starts has a mark in its arguments (Bun's
// `--conditions=<mark>`, a name of a condition of imports that nothing
// uses), so the process list shows whether one is left (as in
// connectors.test.ts of src). The servers that start a helper, that hear
// neither the end of their input nor SIGTERM, or that relay the example,
// are scripts of the test's own directory. The SDK starts each program
// twice for a load (its probe of the version runs on a process of its own).

import { afterAll, expect, test } from "bun:test"
import { Clock, Duration, Effect, type Fiber, Option, Queue, Result } from "effect"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AskDelay } from "@everchat/core/ask"
import { Functions } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import type { Head } from "@everchat/core/request"
import { type NewWake, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { Wakeups } from "@everchat/wakeups/commands"
import { SLEEP } from "@everchat/wakeups/firer"
import { declarations as WAKE_DECLARATIONS } from "@everchat/wakeups/functions"
import { zone } from "@everchat/wakeups/time"
import type { StdioServer } from "../src/config.ts"
import { KEY_VARIABLE, URL_VARIABLE } from "../src/gateway.ts"
import { DECLARATIONS } from "../src/localfunctions.ts"
import { layer, type WakeupsOption, wakeupsOf } from "../src/main.ts"
import { fakeWire, PICK, reply, rows, withChat } from "./help.ts"
import { env, place, PROGRAM, program, type Sent, text, vendor } from "./vendor.ts"

const EXAMPLE = path.join(import.meta.dir, "../../../tools/mcpexample.ts")
const MAIN = path.join(import.meta.dir, "../src/main.ts")
const MARK = "everchat-launch-" + crypto.randomUUID()
const COMPACTOR = { ...PICK, model: "gpt-test-compactor" }
const BUILT_INS = ["shell", "read", "write", "edit", "zoom", "date", "result"]

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-launch-")))
const stops: Array<() => void> = []

// The processes whose arguments hold the mark.
const marked = (): ReadonlyArray<number> =>
  Bun.spawnSync(["ps", "-eo", "pid=,args="]).stdout.toString().split("\n").filter((line) => line.includes(MARK)).map((line) =>
    Number(line.trim().split(" ")[0])
  )

afterAll(() => {
  for (const stop of stops) stop()
  // A red case may leave a child: none outlives the file.
  for (const pid of marked()) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

// A program on stdio, run by this Bun with the mark: the example, or a
// script.
const stdio = (name: string, script: string): StdioServer => ({
  kind: "stdio",
  name,
  approval: "auto",
  tools: {},
  command: process.execPath,
  args: ["--conditions=" + MARK, script],
  env: {},
  cwd: undefined
})

// A server that starts a helper: it starts HELPER (no standard streams, not
// waited for), then runs the example as its own child on its standard
// streams, and when the example has ended (at the end of its input) writes
// its pid to `ended.pids`.
const HELPER = path.join(dir, "helper.ts")
const ENDED = path.join(dir, "ended.pids")
const WRAPPER = path.join(dir, "wrapper.ts")
fs.writeFileSync(HELPER, `setInterval(() => {}, 1 << 30)\n`)
fs.writeFileSync(
  WRAPPER,
  `Bun.spawn([process.execPath, ${JSON.stringify("--conditions=" + MARK)}, ${JSON.stringify(HELPER)}], { stdio: ["ignore", "ignore", "ignore"] }).unref()
const example = Bun.spawn([process.execPath, ${JSON.stringify("--conditions=" + MARK)}, ${JSON.stringify(EXAMPLE)}], { stdio: ["inherit", "inherit", "ignore"] })
await example.exited
require("node:fs").appendFileSync(${JSON.stringify(ENDED)}, process.pid + "\\n")
process.exit(0)
`
)

// A program that reads its input, never answers, and hears neither the end
// of its input nor SIGTERM.
const STUBBORN = path.join(dir, "stubborn.ts")
fs.writeFileSync(
  STUBBORN,
  `process.on("SIGTERM", () => {})\nprocess.stdin.on("data", () => {})\nprocess.stdin.on("end", () => {})\nsetInterval(() => {}, 1 << 30)\n`
)

// A relay of the example: it writes its pid to `relay.pids` at its start,
// runs the example as its child, and passes each line of the protocol on,
// both ways, but a request of `tools/list`, which it drops. It hears
// neither the end of its input nor SIGTERM. Unlike STUBBORN, it answers the
// SDK's probe of the version and the handshake, so the client's own
// transport starts, and its load fails only at the load's limit: the close
// of that transport then takes the SDK's every step.
const RELAY = path.join(dir, "relay.ts")
const RELAYS = path.join(dir, "relay.pids")
fs.writeFileSync(
  RELAY,
  `require("node:fs").appendFileSync(${JSON.stringify(RELAYS)}, process.pid + "\\n")
process.on("SIGTERM", () => {})
const child = Bun.spawn([process.execPath, ${JSON.stringify("--conditions=" + MARK)}, ${JSON.stringify(EXAMPLE)}], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
;(async () => { for await (const chunk of child.stdout) process.stdout.write(chunk) })()
let buffer = ""
process.stdin.on("data", (data) => {
  buffer += data.toString()
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, at + 1)
    buffer = buffer.slice(at + 1)
    if (!line.includes('"tools/list"')) {
      child.stdin.write(line)
      child.stdin.flush()
    }
  }
})
process.stdin.on("end", () => {})
setInterval(() => {}, 1 << 30)
`
)

// Whether a process runs: one that has ended but that its parent has not
// yet reaped (a zombie) does not.
const alive = (pid: number) => {
  try {
    return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))
  } catch {
    return false
  }
}

// The pids in a file of pids, or none.
const pidsIn = (file: string): ReadonlyArray<number> =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter((one) => one !== "").map(Number) : []

// The marked processes that still run after a short wait: a SIGKILL takes
// effect when the process next runs, not at the call. 300 ms is far under
// the SDK's own steps (1 s to 4 s).
const left = async () => {
  for (let k = 0; k < 30 && marked().length > 0; k++) await Bun.sleep(10)
  return marked()
}

// Kills each marked process, and waits until none runs: a case that fails
// leaves no child to the next one.
const stopMarked = async () => {
  for (const pid of marked()) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  await left()
}

// The live processes of the wrapper (WRAPPER) among the marked ones.
const wrappers = () =>
  Bun.spawnSync(["ps", "-eo", "pid=,stat=,args="]).stdout.toString().split("\n").map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.at(-1) === WRAPPER && cols.includes("--conditions=" + MARK) && !cols[1]!.startsWith("Z")).map((cols) => Number(cols[0]))

// The same servers as `config.json` names them.
const configOf = (servers: ReadonlyArray<StdioServer>) =>
  JSON.stringify({ servers: Object.fromEntries(servers.map((one) => [one.name, { command: one.command, args: one.args }])) })

const isCompaction = (body: unknown) => JSON.stringify(body).includes("Compaction: ")

// A fake vendor: a compaction gets a line; the n-th request of a turn runs
// `programs[n - 1]`, and then the model says "Done.". "hold": the reply
// starts and never ends. `compacted`: an effect that ends when the first
// compaction's request has come (lead, ec-p4rfa4, V1); its body is then in
// `bodies`, which `vendor` fills before it calls back. One that never comes
// is the case's own timeout (V3).
const fake = (...programs: ReadonlyArray<string | "hold">) => {
  let step = 0
  const compaction = Promise.withResolvers<void>()
  const made = vendor((_n, body): Array<Sent> | "hold" => {
    if (isCompaction(body)) {
      compaction.resolve()
      return text("a line")
    }
    step += 1
    const one = programs[step - 1]
    return one === undefined ? text("Done.") : one === "hold" ? "hold" : program("c" + step, one)
  })
  stops.push(made.stop)
  return { ...made, compacted: Effect.promise(() => compaction.promise) }
}

const say = (message: string) =>
  Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say(message)
    yield* turns.idle
  })

// One launch of the terminal's stack in this process, with `servers` as
// the config's, until `effect` ends. `wakeups`: the launch's wake-ups (main.ts,
// `WakeupsOption`); none when not given. `file`: the chat's file, for a case
// that writes it before the start; a new one when not given. `clock`: the
// launch's clock, for a case that watches the firer's sleeps.
const launch = async <A, E>(
  address: string,
  servers: ReadonlyArray<StdioServer>,
  effect: Effect.Effect<A, E, Turns | Functions | Store>,
  load?: number,
  more: { readonly wakeups?: WakeupsOption | undefined; readonly file?: string; readonly clock?: Clock.Clock } = {}
) => {
  const root = fs.mkdtempSync(path.join(dir, "home-"))
  const file = more.file ?? path.join(root, "chat.db")
  process.env[URL_VARIABLE] = address
  process.env[KEY_VARIABLE] = "test-key"
  try {
    const run = effect.pipe(
      Effect.provide(layer({ home: root, file, cwd: root, pick: PICK, compactor: COMPACTOR, servers, load, wakeups: more.wakeups })),
      Effect.provideService(AskDelay, () => Effect.succeed(0))
    )
    const exit = await Effect.runPromiseExit(more.clock === undefined ? run : Effect.provideService(run, Clock.Clock, more.clock))
    return { exit, file }
  } finally {
    delete process.env[URL_VARIABLE]
    delete process.env[KEY_VARIABLE]
  }
}

// The functions that a head names, in its order: each `declare function`,
// and each member of a `declare const` namespace.
const named = (shown: Head): ReadonlyArray<string> => {
  const names: Array<string> = []
  let space: string | undefined
  for (const line of (shown.tools[0]?.description ?? "").split("\n")) {
    const fn = /^declare function ([A-Za-z_$][\w$]*)\(/.exec(line)
    const ns = /^declare const ([A-Za-z_$][\w$]*): \{$/.exec(line)
    const member = /^  ([A-Za-z_$][\w$]*)\(/.exec(line)
    if (fn !== null) names.push(fn[1]!)
    else if (ns !== null) space = ns[1]
    else if (line === "};") space = undefined
    else if (member !== null && space !== undefined) names.push(space + "." + member[1])
  }
  return names
}

// The heads of the turns' rows, in their order: each row names its head's.
const turnHeads = (file: string) =>
  rows<{ body: string }>(file, "select h.body from everchat_turn t join everchat_head h on h.chat = t.chat and h.n = t.head order by t.n").map((one) => one.body)

// The head of a request's body: its developer message and its tools.
type Tool = { readonly name: string; readonly description: string }
const headOf = (body: any): Head => ({ system: body.input[0].content[0].text, tools: body.tools.map((tool: Tool) => ({ name: tool.name, description: tool.description })) })

// The cases
// ---------

test("the terminal's stack with the example as the config's server: the head of the turn's row, the head that the compactor sends and Functions.names name the built-ins, then example.add and example.send; after the launch's end no child is left", async () => {
  const vendor = fake()
  const { exit, file } = await launch(vendor.address, [stdio("example", EXAMPLE)], Effect.gen(function*() {
    // A message longer than a node: its leaf is a compaction.
    yield* say("a long one " + "and more ".repeat(80))
    yield* vendor.compacted
    expect(marked().length).toBe(1)
    return yield* Functions
  }))
  expect(exit._tag).toBe("Success")
  const functions = exit._tag === "Success" ? exit.value : undefined
  const names = [...BUILT_INS, "example.add", "example.send"]
  expect(functions?.names).toEqual(names)
  const shown = head(functions?.declarations ?? [])
  expect(named(shown)).toEqual(names)
  // The turn's row and every compaction's request hold that head.
  const turns = turnHeads(file).map((body) => JSON.parse(body) as Head)
  expect(turns.length).toBe(1)
  expect(turns.map(named)).toEqual([names])
  expect(turns).toEqual([shown])
  const compactions = vendor.bodies.filter(isCompaction).map(headOf)
  expect(compactions.length).toBeGreaterThan(0)
  expect(compactions).toEqual(compactions.map(() => shown))
  expect(vendor.bodies.filter((body) => !isCompaction(body)).map(headOf)).toEqual([shown])
  expect(marked()).toEqual([])
}, 20_000)

test("a program in the thread engine calls example.add({ a: 2, b: 3 }) and gets { sum: 5 }, and the call's row has the input [{\"a\":2,\"b\":3}]", async () => {
  const vendor = fake("return await example.add({ a: 2, b: 3 })")
  const { exit, file } = await launch(vendor.address, [stdio("example", EXAMPLE)], say("add two and three"))
  expect(exit._tag).toBe("Success")
  expect(rows(file, "select fn, input, status from everchat_call where parent is not null")).toEqual([
    { fn: "example.add", input: '[{"a":2,"b":3}]', status: "done" }
  ])
  // The program gave the object back, and the model was shown it.
  const echoes = rows<{ text: string }>(file, "select text from everchat_msg_read where kind = 'echo'").map((one) => JSON.parse(one.text))
  expect(echoes).toEqual([{ sum: 5 }])
  expect(marked()).toEqual([])
}, 20_000)

test("a server that never answers beside the example: the launch has the example's functions, after the load's limit at most, and the refusal is in the log (the source mcp), naming the server only; no child is left", async () => {
  const vendor = fake()
  const started = performance.now()
  const { exit, file } = await launch(vendor.address, [stdio("example", EXAMPLE), stdio("quiet", STUBBORN)], Functions.use(Effect.succeed), 2_000)
  const took = performance.now() - started
  expect(exit._tag).toBe("Success")
  expect(exit._tag === "Success" ? exit.value.names : []).toEqual([...BUILT_INS, "example.add", "example.send"])
  // The server never answers the SDK's probe of the version, which runs on
  // a process of its own, so the client's own transport never starts and
  // its close returns at once: this case does not reach the SDK's wait
  // before SIGTERM and SIGKILL (with that wait put back in the load, it
  // still passes). The relay's case below does.
  expect(took).toBeLessThan(2_000 + 3_000)
  const logged = rows<{ level: string; source: string; text: string }>(file, "select level, source, text from everchat_log where source = 'mcp'")
  expect(logged.length).toBe(1)
  expect(logged[0]).toMatchObject({ level: "warn", source: "mcp" })
  expect(logged[0]!.text).toContain('server "quiet"')
  expect(logged[0]!.text).not.toContain(STUBBORN)
  expect(logged[0]!.text).not.toContain(MARK)
  expect(marked()).toEqual([])
}, 20_000)

test("a launch that fails after the load: no child is left", async () => {
  const vendor = fake()
  const { exit } = await launch(vendor.address, [stdio("example", EXAMPLE)], Effect.gen(function*() {
    yield* Functions
    expect(marked().length).toBe(1)
    return yield* Effect.fail("a failure of the launch")
  }))
  expect(exit._tag).toBe("Failure")
  expect(marked()).toEqual([])
}, 20_000)

test("the terminal's stack with a server that starts a helper: a call answers; after the launch's end no process of the server or of the helper is left, and the server heard the end of its input before the sweep", async () => {
  fs.rmSync(ENDED, { force: true })
  const vendor = fake("return await helped.add({ a: 2, b: 3 })")
  let wrapper = 0
  const { exit, file } = await launch(vendor.address, [stdio("helped", WRAPPER)], Effect.gen(function*() {
    yield* say("add two and three")
    const alive = wrappers()
    expect(alive.length).toBe(1)
    wrapper = alive[0]!
  }))
  expect(exit._tag).toBe("Success")
  expect(rows(file, "select fn, output, status from everchat_call where parent is not null")).toEqual([
    { fn: "helped.add", output: '{"sum":5}', status: "done" }
  ])
  expect(await left()).toEqual([])
  expect(pidsIn(ENDED)).toContain(wrapper)
}, 20_000)

// The wake-ups at a launch (main.ts, "The wake-ups")
// -------------------------------------------------

const WAKE_NAMES = ["wake", "wakes", "unwake"]
// The wake-ups of the terminal and of pipe mode, with no zone of the config.
const ALL: WakeupsOption = { with: "all", zone: null }
const M = 60_000
// A reminder whose time passed a minute before the start: due already, so
// the firer's first round pends it.
const due = (): NewWake => {
  const at = Date.now() - M
  return { text: "Water the plants.", at, zone: "UTC", first: at }
}

test("on, the default, in the terminal's stack with the example as the config's server: the head of the turn's row, the head that the compactor sends and Functions.names are one list: the built-ins, then wake, wakes and unwake, then example.add and example.send", async () => {
  const vendor = fake()
  const { exit, file } = await launch(vendor.address, [stdio("example", EXAMPLE)], Effect.gen(function*() {
    yield* say("a long one " + "and more ".repeat(80))
    yield* vendor.compacted
    return yield* Functions
  }), undefined, { wakeups: ALL })
  expect(exit._tag).toBe("Success")
  const functions = exit._tag === "Success" ? exit.value : undefined
  const names = [...BUILT_INS, ...WAKE_NAMES, "example.add", "example.send"]
  expect(functions?.names).toEqual(names)
  const shown = head(functions?.declarations ?? [])
  expect(named(shown)).toEqual(names)
  expect(functions?.declarations.slice(BUILT_INS.length, BUILT_INS.length + 3)).toEqual([...WAKE_DECLARATIONS])
  const turns = turnHeads(file).map((body) => JSON.parse(body) as Head)
  expect(turns).toEqual([shown])
  const compactions = vendor.bodies.filter(isCompaction).map(headOf)
  expect(compactions.length).toBeGreaterThan(0)
  expect(compactions).toEqual(compactions.map(() => shown))
  expect(vendor.bodies.filter((body) => !isCompaction(body)).map(headOf)).toEqual([shown])
  expect(marked()).toEqual([])
}, 20_000)

test("on, the default, in the terminal's stack with no server: the head and Functions.names are the built-ins, then wake, wakes and unwake; the service of /wakeups is there, and a program's wake makes a row in the config's zone", async () => {
  const vendor = fake('return await wake({ when: "2030-01-01T09:00", text: "Call the bank." })')
  const { exit, file } = await launch(vendor.address, [], Effect.gen(function*() {
    yield* say("remind me")
    const service = yield* Effect.serviceOption(Wakeups)
    const listed = Option.isSome(service) ? yield* service.value.list : null
    return { names: (yield* Functions).names, service: Option.isSome(service), listed }
  }), undefined, { wakeups: { with: "all", zone: Result.getOrThrow(zone("Asia/Tokyo")) } })
  expect(exit._tag).toBe("Success")
  const got = exit._tag === "Success" ? exit.value : undefined
  expect(got?.names).toEqual([...BUILT_INS, ...WAKE_NAMES])
  expect(got?.service).toBe(true)
  expect(got?.listed?.on).toBe(true)
  expect(got?.listed?.rows.map((one) => [one.id, one.text, one.zone, one.next, one.active])).toEqual([[1, "Call the bank.", "Asia/Tokyo", "2030-01-01 09:00 Asia/Tokyo", true]])
  expect(turnHeads(file).map((body) => named(JSON.parse(body) as Head))).toEqual([[...BUILT_INS, ...WAKE_NAMES]])
  expect(rows(file, "select fn, status from everchat_call where parent is not null")).toEqual([{ fn: "wake", status: "done" }])
  expect(rows<{ text: string }>(file, "select text from everchat_msg_read where kind = 'note'").map((one) => one.text)).toEqual(["Wake-up 1 set: next 2030-01-01 09:00 Asia/Tokyo"])
}, 20_000)

test("on: false: the config's section gives no option, and the stack is today's: the head is head(DECLARATIONS) for the turn and the compactor, Functions.names has none of the three, no service of /wakeups, and a program that calls wake fails as a call of an unknown name does", async () => {
  expect(wakeupsOf({ on: false, zone: null }, "all")).toBeUndefined()
  expect(wakeupsOf({ on: false, zone: null }, "functions")).toBeUndefined()
  expect(wakeupsOf({ on: true, zone: null }, "functions")).toEqual({ with: "functions", zone: null })
  const vendor = fake('return await wake({ when: "2030-01-01T09:00", text: "Call the bank." })', "return await nosuch({ when: 1 })")
  const { exit, file } = await launch(vendor.address, [], Effect.gen(function*() {
    yield* say("remind me")
    yield* say("a long one " + "and more ".repeat(80))
    yield* vendor.compacted
    return { names: (yield* Functions).names, service: Option.isSome(yield* Effect.serviceOption(Wakeups)) }
  }), undefined, { wakeups: wakeupsOf({ on: false, zone: null }, "all") })
  expect(exit._tag).toBe("Success")
  expect(exit._tag === "Success" ? exit.value : undefined).toEqual({ names: BUILT_INS, service: false })
  const today = head(DECLARATIONS)
  expect(turnHeads(file).map((body) => JSON.parse(body))).toEqual([today, today])
  const compactions = vendor.bodies.filter(isCompaction).map(headOf)
  expect(compactions.length).toBeGreaterThan(0)
  expect(compactions).toEqual(compactions.map(() => today))
  // The two calls fail alike: each name is unknown to the program.
  const echoes = rows<{ text: string }>(file, "select text from everchat_msg_read where kind = 'echo' order by i").map((one) => one.text)
  expect(echoes.length).toBe(2)
  expect(echoes[1]!.replaceAll("nosuch", "wake")).toBe(echoes[0]!)
  expect(echoes[0]).toContain("wake")
  expect(rows(file, "select count(*) as n from everchat_wake")).toEqual([{ n: 0 }])
}, 20_000)

// The firer's sleeps, as a queue: the clock of the launch, whose `sleep`
// of `SLEEP` (the firer's, after a round with no row due sooner) offers its
// fiber before it sleeps. Every other sleep is the clock's own.
const watchedClock = (asleep: Queue.Queue<Fiber.Fiber<unknown, unknown>>): Clock.Clock => {
  const real = Effect.runSync(Clock.clockWith(Effect.succeed))
  return Object.assign(Object.create(real) as Clock.Clock, {
    sleep: (duration: Duration.Duration) =>
      Duration.toMillis(duration) === SLEEP
        ? Effect.andThen(Effect.flatMap(Effect.fiber, (fiber) => Queue.offer(asleep, fiber)), real.sleep(duration))
        : real.sleep(duration)
  })
}

test("two sources, in the terminal's stack: an approval's result and a wake-up's fire both wait at the start; the approval's turn comes first, then the wake's", async () => {
  const file = path.join(fs.mkdtempSync(path.join(dir, "home-")), "chat.db")
  // A launch with no source: a program's send waits for a yes, the yes
  // comes and its run ends done, not told; a reminder's fire waits.
  const holder: { store: Store["Service"] | null } = { store: null }
  const wire = fakeWire((asked, n) =>
    n === 1
      ? reply(asked, { text: "", output: [{ type: "custom_tool_call", call_id: "t1", name: "run", input: "send('hi')" }], calls: [{ id: "t1", name: "run", input: "send('hi')" }] })
      : reply(asked, { text: "Sent." })
  )
  await withChat(file, wire, (_program) =>
    Effect.gen(function*() {
      const store = holder.store!
      const turn = (yield* store.runningTurns(null))[0]!
      const program = (yield* store.calls(turn.id)).find((one) => one.parent === null)!
      const call = yield* store.startCall({ turn: turn.id, parent: program.id, fn: "send", input: JSON.stringify(["hi"]) })
      const n = yield* store.pendCall(call, () => "{}")
      yield* store.answerApproval(n, { yes: true, who: "the person" })
      yield* store.startApproval(n)
      yield* store.endApproval(n, { status: "done", output: "sent" })
      return { output: "ran", failed: false }
    }).pipe(Effect.orDie), Effect.gen(function*() {
      const store = yield* Store
      holder.store = store
      const reminder = due()
      yield* store.makeWake(reminder, 20)
      yield* store.pendWake(1, { pending: reminder.at!, missed: 0, due: null })
      yield* (yield* Turns).say("send hi")
      yield* (yield* Turns).idle
    }))
  const before = rows<{ kind: string }>(file, "select kind from everchat_msg_read order by i").length
  const vendor = fake()
  const { exit } = await launch(vendor.address, [], Effect.gen(function*() {
    yield* (yield* Turns).idle
  }), undefined, { wakeups: ALL, file })
  expect(exit._tag).toBe("Success")
  const log = rows<{ kind: string; turn: number | null }>(file, `select kind, turn from everchat_msg_read where i >= ${before} and kind in ('late', 'wake', 'asst') order by i`)
  expect(log).toEqual([
    { kind: "late", turn: null },
    { kind: "asst", turn: 2 },
    { kind: "wake", turn: null },
    { kind: "asst", turn: 3 }
  ])
}, 20_000)

test("the end, in the terminal's stack: the launch ends while the firer sleeps; the firer's fiber was cut before the store closed, and nothing was written after the launch's end", async () => {
  const asleep = Effect.runSync(Queue.unbounded<Fiber.Fiber<unknown, unknown>>())
  const vendor = fake()
  const { exit, file } = await launch(vendor.address, [], Effect.gen(function*() {
    // The firer's first round, then its sleep.
    return yield* Queue.take(asleep)
  }), undefined, { wakeups: ALL, clock: watchedClock(asleep) })
  expect(exit._tag).toBe("Success")
  const firer = exit._tag === "Success" ? exit.value : undefined
  // The run gave back after the layer's scope closed: the fiber had ended,
  // cut.
  const ended = firer?.pollUnsafe()
  expect(ended !== undefined && ended._tag === "Failure").toBe(true)
  expect(ended !== undefined && ended._tag === "Failure" ? ended.cause.reasons.every((one) => one._tag === "Interrupt") : false).toBe(true)
  const launches = rows<{ ended: number | null; why: string | null }>(file, "select ended, why from everchat_launch")
  expect(launches.map((one) => one.ended !== null)).toEqual([true])
  const last = launches[0]!.ended!
  expect(rows(file, `select count(*) as n from everchat_log where created > ${last}`)).toEqual([{ n: 0 }])
}, 20_000)

// The whole program, in pipe mode
// -------------------------------

// One launch in pipe mode, with `input` as the whole standard input: from
// the source, or the executable that EVERCHAT_BIN names.
const run = async (at: ReturnType<typeof place>, address: string, input: string) => {
  const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, address), stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

// The head of compactor.test.ts's hash case: the bytes of the head of a
// chat with no server, as it was before the wake-ups, and as it is with the
// config's `wakeups: { on: false }`.
const TODAY = "eebd350dbe3dc76071fca1dc6db7997d1f496f58302b131a5a77ee46e317da79"
// The bytes of the head of a chat with no server and the wake-ups on (the
// default): the built-ins, then wake, wakes and unwake. It changed on
// purpose with the wake-ups' launch (docs/wakeups.md, section 9).
const WAKING = "faa7199c4586331828dfd093d0cade1ce5628562372c290bd6467889e04f01b0"

// Writes, at the process's exit, the modules that it loaded.
const MODULES = path.join(dir, "modules.ts")
fs.writeFileSync(
  MODULES,
  `process.on("exit", () => require("node:fs").writeFileSync(process.env.EVERCHAT_TEST_MODULES, Object.keys(require.cache).join("\\n")))\n`
)
const loadedBy = async (at: ReturnType<typeof place>, address: string) => {
  const list = path.join(at.root, "modules.txt")
  const proc = Bun.spawn([process.execPath, "--preload", MODULES, MAIN, "--model", "gpt-test"], {
    cwd: at.work,
    env: { ...env(at, address), EVERCHAT_TEST_MODULES: list },
    stdin: new Blob(["hello\n"]),
    stdout: "pipe",
    stderr: "pipe"
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  expect({ err, code }).toEqual({ err: "", code: 0 })
  return fs.readFileSync(list, "utf8").split("\n")
}
const client = (modules: ReadonlyArray<string>) => modules.filter((one) => one.includes("/packages/mcp/") || one.includes("@modelcontextprotocol"))

test("with no server, the head is the built-ins and the wake-ups' three (the hash; with the config's wakeups on false, today's), and no module of the client is loaded; with one, the client is loaded", async () => {
  const none = place()
  const modules = await loadedBy(none, fake().address)
  expect(modules).toContain(MAIN)
  expect(client(modules)).toEqual([])
  expect(modules.filter((one) => one.endsWith("/connectors.ts"))).toEqual([])
  // The wake-ups are on by default: the head changed on purpose, from
  // TODAY to WAKING.
  const heads = turnHeads(none.file)
  expect(heads.map((body) => createHash("sha256").update(body).digest("hex"))).toEqual([WAKING])
  expect(heads.map((body) => JSON.parse(body))).toEqual([head([...DECLARATIONS, ...WAKE_DECLARATIONS])])
  // Off in the config file: the head of before the wake-ups, byte for byte.
  const off = place()
  fs.mkdirSync(off.home, { recursive: true })
  fs.writeFileSync(path.join(off.home, "config.json"), JSON.stringify({ wakeups: { on: false } }))
  await loadedBy(off, fake().address)
  const offHeads = turnHeads(off.file)
  expect(offHeads.map((body) => createHash("sha256").update(body).digest("hex"))).toEqual([TODAY])
  expect(offHeads.map((body) => JSON.parse(body))).toEqual([head(DECLARATIONS)])

  // The probe sees the client when a server is named.
  const one = place()
  fs.mkdirSync(one.home, { recursive: true })
  fs.writeFileSync(path.join(one.home, "config.json"), configOf([stdio("example", EXAMPLE)]))
  const seen = await loadedBy(one, fake().address)
  expect(client(seen)).toContainEqual(expect.stringContaining("/packages/mcp/src/client.ts"))
  expect(client(seen)).toContainEqual(expect.stringContaining("@modelcontextprotocol"))
  expect(marked()).toEqual([])
}, 20_000)

test("pipe mode with the example in config.json: a program calls example.add, and after the launch's end no child is left", async () => {
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("example", EXAMPLE)]))
  const ran = await run(at, fake("return await example.add({ a: 2, b: 3 })").address, "add two and three\n")
  expect(ran.code).toBe(0)
  expect(rows(at.file, "select fn, input, output, status from everchat_call where parent is not null")).toEqual([
    { fn: "example.add", input: '[{"a":2,"b":3}]', output: '{"sum":5}', status: "done" }
  ])
  expect(marked()).toEqual([])
}, 20_000)

test("pipe mode: a signal while a turn runs ends the launch, and no child is left", async () => {
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("example", EXAMPLE)]))
  const vendor = fake("hold")
  const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, vendor.address), stdin: "pipe", stdout: "ignore", stderr: "ignore" })
  try {
    proc.stdin.write("are you there?\n")
    proc.stdin.flush()
    for (let k = 0; k < 1000 && vendor.bodies.length === 0; k++) await Bun.sleep(10)
    expect(vendor.bodies.length).toBe(1)
    expect(marked().length).toBe(1)
    proc.kill("SIGTERM")
    expect(await proc.exited).toBe(130)
    expect(marked()).toEqual([])
  } finally {
    proc.kill("SIGKILL")
  }
}, 20_000)

test("pipe mode with a server that starts a helper: at a normal end and at a signal, no process of the server or of the helper is left", async () => {
  fs.rmSync(ENDED, { force: true })
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("helped", WRAPPER)]))
  const ran = await run(at, fake("return await helped.add({ a: 2, b: 3 })").address, "add two and three\n")
  expect(ran.code).toBe(0)
  expect(rows(at.file, "select fn, output, status from everchat_call where parent is not null")).toEqual([
    { fn: "helped.add", output: '{"sum":5}', status: "done" }
  ])
  expect(await left()).toEqual([])
  // The server saw its input end before the sweep.
  expect(pidsIn(ENDED).length).toBeGreaterThan(0)

  const vendor = fake("hold")
  const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, vendor.address), stdin: "pipe", stdout: "ignore", stderr: "ignore" })
  try {
    proc.stdin.write("are you there?\n")
    proc.stdin.flush()
    for (let k = 0; k < 1000 && vendor.bodies.length === 0; k++) await Bun.sleep(10)
    expect(vendor.bodies.length).toBe(1)
    expect(wrappers().length).toBe(1)
    proc.kill("SIGTERM")
    expect(await proc.exited).toBe(130)
    expect(await left()).toEqual([])
  } finally {
    proc.kill("SIGKILL")
  }
}, 20_000)

test("pipe mode with empty input and a server that hears neither the end of its input nor SIGTERM, at the real limit of the load: after the exit no process of the server is left", async () => {
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("stubborn", STUBBORN)]))
  const started = performance.now()
  const ran = await run(at, fake().address, "")
  expect(ran.code).toBe(0)
  expect(performance.now() - started).toBeGreaterThanOrEqual(10_000)
  expect(await left()).toEqual([])
}, 30_000)

test("pipe mode: a signal during the load (SIGTERM, SIGHUP, SIGINT) leaves no process of the server", async () => {
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("stubborn", STUBBORN)]))
  const vendor = fake()
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, vendor.address), stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    try {
      for (let k = 0; k < 1000 && marked().length === 0; k++) await Bun.sleep(10)
      expect(marked().length).toBeGreaterThan(0)
      proc.kill(signal)
      await proc.exited
      expect({ signal, left: await left() }).toEqual({ signal, left: [] })
    } finally {
      proc.kill("SIGKILL")
    }
  }
}, 20_000)

test("pipe mode with a relay of the example that drops tools/list and hears neither the end of its input nor SIGTERM: the load gives it up at its limit and does not wait for its close, so the relay still runs when the launch shows the message; after the exit no process of it is left", async () => {
  fs.rmSync(RELAYS, { force: true })
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("relay", RELAY)]))
  const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, fake().address), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  try {
    proc.stdin.write("hello\n")
    proc.stdin.flush()
    // What the launch shows first, the message, follows the load. The
    // load gives the relay up at its limit and starts the SDK's close,
    // which ends the relay's input, waits 2 s, sends SIGTERM, waits 2 s,
    // and sends SIGKILL (`StdioClientTransport.close` in the installed
    // @modelcontextprotocol/client 2.4.0, dist/stdio.mjs, its two waits of
    // 2e3 ms). So the relay runs for 4 s after the load's end: the margin
    // of this check. A load that waited for that close would end only
    // after the SIGKILL, and show the message to a relay that is gone.
    // The relay's process for the SDK's probe is gone by then: one runs.
    const reader = proc.stdout.getReader()
    const first = await reader.read()
    const running = pidsIn(RELAYS).filter(alive)
    expect(running.length).toBe(1)
    proc.stdin.end()
    const read = async () => {
      let out = new TextDecoder().decode(first.value)
      for (let got = await reader.read(); !got.done; got = await reader.read()) out += new TextDecoder().decode(got.value)
      return out
    }
    const [out, err, code] = await Promise.all([read(), new Response(proc.stderr).text(), proc.exited])
    expect({ out, err, code }).toEqual({ out: "› hello\n\nDone.\n", err: "", code: 0 })
    expect(rows(at.file, "select level, text from everchat_log where source = 'mcp'")).toEqual([
      { level: "warn", text: 'A function from outside is refused: server "relay": It did not load in 10000 ms.' }
    ])
    expect(await left()).toEqual([])
    expect(pidsIn(RELAYS).filter(alive)).toEqual([])
  } finally {
    proc.kill("SIGKILL")
    await proc.exited
    await stopMarked()
  }
}, 40_000)

test("pipe mode with a server named as a built-in function (shell): the load refuses each of its functions with its sentence, the launch goes on with the chat's own functions, and the head of its turn is that of a chat with no server; no child is left", async () => {
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("shell", EXAMPLE)]))
  try {
    const ran = await run(at, fake().address, "hello\n")
    expect(ran).toEqual({ out: "› hello\n\nDone.\n", err: "", code: 0 })
    expect(rows(at.file, "select level, text from everchat_log where source = 'mcp' order by n")).toEqual([
      { level: "warn", text: 'A function from outside is refused: server "shell", tool "add": Its namespace "shell" is the name of another function.' },
      { level: "warn", text: 'A function from outside is refused: server "shell", tool "send": Its namespace "shell" is the name of another function.' }
    ])
    // The head of a chat with no server, as the core makes it: the
    // built-ins, then the wake-ups' three, which are on by default (it
    // changed on purpose with the wake-ups' launch).
    const heads = turnHeads(at.file)
    expect(heads.map((body) => JSON.parse(body))).toEqual([head([...DECLARATIONS, ...WAKE_DECLARATIONS])])
    expect(heads.map((body) => named(JSON.parse(body) as Head))).toEqual([[...BUILT_INS, ...WAKE_NAMES]])
    expect(marked()).toEqual([])
  } finally {
    await stopMarked()
  }
}, 20_000)

test("pipe mode with a server named as a wake-ups' function (wake) beside the example: the load refuses each of its functions with the client's sentence, the example loads, the launch does not die, and the head is the built-ins, the three, then the example's; no child is left", async () => {
  const at = place()
  fs.mkdirSync(at.home, { recursive: true })
  fs.writeFileSync(path.join(at.home, "config.json"), configOf([stdio("wake", EXAMPLE), stdio("example", EXAMPLE)]))
  try {
    const ran = await run(at, fake("return await example.add({ a: 2, b: 3 })").address, "add two and three\n")
    expect({ err: ran.err, code: ran.code }).toEqual({ err: "", code: 0 })
    expect(rows(at.file, "select level, text from everchat_log where source = 'mcp' order by n")).toEqual([
      { level: "warn", text: 'A function from outside is refused: server "wake", tool "add": Its namespace "wake" is the name of another function.' },
      { level: "warn", text: 'A function from outside is refused: server "wake", tool "send": Its namespace "wake" is the name of another function.' }
    ])
    expect(rows(at.file, "select fn, output, status from everchat_call where parent is not null")).toEqual([{ fn: "example.add", output: '{"sum":5}', status: "done" }])
    const heads = turnHeads(at.file)
    expect(heads.map((body) => named(JSON.parse(body) as Head))).toEqual([[...BUILT_INS, ...WAKE_NAMES, "example.add", "example.send"]])
    expect(marked()).toEqual([])
  } finally {
    await stopMarked()
  }
}, 20_000)
