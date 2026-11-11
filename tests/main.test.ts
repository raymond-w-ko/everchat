// The whole program as a process, in a real pseudo-terminal, against a
// fake vendor on this machine. What a person sees, how the process ends,
// and what a launch leaves in the database.
//
// No test here sends a request to a real model: every launch gets the fake
// vendor's address, and a home directory of its own with no gateway file.

import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FILE } from "../src/database.ts"
import { rows } from "./help.ts"
import { Pty } from "./pty.ts"

// The program: from its source, or the executable that EVERCHAT_BIN names
// (`just build` makes one), to run these same tests on it.
const PROGRAM = process.env.EVERCHAT_BIN === undefined || process.env.EVERCHAT_BIN === ""
  ? [process.execPath, path.join(import.meta.dir, "..", "src", "main.ts")]
  : [path.resolve(process.env.EVERCHAT_BIN)]

// One event of a streamed reply, as OpenAI's documents frame it.
type Sent = Record<string, unknown>
const frame = (event: Sent) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`

const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 105 }
const completed = (output: ReadonlyArray<Sent>): Sent => ({ type: "response.completed", response: { id: "resp_1", status: "completed", output, usage, service_tier: "default" } })

// A reply of text, in two parts.
const text = (said: string): Array<Sent> => {
  const half = Math.ceil(said.length / 2)
  return [
    { type: "response.output_text.delta", delta: said.slice(0, half) },
    { type: "response.output_text.delta", delta: said.slice(half) },
    completed([{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: said, annotations: [] }] }])
  ]
}

// A reply that runs one program.
const program = (id: string, code: string): Array<Sent> => [
  { type: "response.custom_tool_call_input.delta", delta: code },
  completed([{ id: "ctc_" + id, type: "custom_tool_call", call_id: id, name: "run", input: code }])
]

// A fake vendor: `answer` gives the events of the n-th request (1, 2, ...),
// or "hold": the reply then starts and never ends.
const vendor = (answer: (n: number, body: any) => Array<Sent> | "hold") => {
  const bodies: Array<any> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (request) => {
      const body = await request.json()
      bodies.push(body)
      const got = answer(bodies.length, body)
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (got === "hold") {
            controller.enqueue(encoder.encode(frame({ type: "response.output_text.delta", delta: "I am still " })))
            return
          }
          for (const event of got) {
            controller.enqueue(encoder.encode(frame(event)))
          }
          controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_" + bodies.length } })
    }
  })
  return { bodies, address: "http://127.0.0.1:" + server.port, stop: () => server.stop(true) }
}

const open: Array<() => unknown> = []
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close()
  }
})

// A new place for one chat: its home, a work directory, and a home
// directory of the user with no gateway file in it.
const place = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-main-"))
  const home = path.join(root, "home")
  const work = path.join(root, "work")
  fs.mkdirSync(work)
  return { root, home, work, file: path.join(home, FILE) }
}

const env = (at: ReturnType<typeof place>, address: string | undefined): Record<string, string | undefined> => ({
  PATH: process.env.PATH,
  HOME: at.root,
  EVERCHAT_HOME: at.home,
  EVERCHAT_GATEWAY_URL: address,
  EVERCHAT_GATEWAY_KEY: address === undefined ? undefined : "test-key"
})

const start = (at: ReturnType<typeof place>, address: string | undefined, args: ReadonlyArray<string> = ["--model", "gpt-test"]) => {
  const pty = new Pty([...PROGRAM, ...args], env(at, address), at.work)
  open.push(async () => {
    if (pty.code === null) {
      pty.kill("SIGKILL")
      await pty.ends()
    }
  })
  return pty
}

const fake = (answer: Parameters<typeof vendor>[0]) => {
  const made = vendor(answer)
  open.push(made.stop)
  return made
}

const IDLE = "idle · gpt-test medium"
// What a terminal gets back when the program ends: the cursor is shown,
// and a paste is no longer bracketed.
const RESTORED = ["\x1b[?25h", "\x1b[?2004l"]

const messages = (file: string) => rows<{ kind: string; text: string }>(file, "select kind, text from msg_read order by i")
// Why a launch ended: "exit" (a quit), "signal", "error", or "crash" (the next launch found it open).
const launches = (file: string) => rows<{ id: number; ended: number | null; why: string | null }>(file, "select id, ended, why from launch order by id")
const turns = (file: string) => rows<{ id: number; status: string }>(file, "select id, status from turn order by id")

test("a launch in a terminal: a message, the reply as it streams, and a clean quit", async () => {
  const at = place()
  const server = fake(() => text("Hello, I am **EverChat**."))
  const pty = start(at, server.address)
  await pty.sees(IDLE)
  pty.type("hello there")
  await pty.sees("hello there")
  pty.type("\r")
  const screen = await pty.sees("› hello there", "Hello, I am EverChat.", IDLE)
  // The reply is on the screen once.
  expect(screen.split("Hello, I am EverChat.").length).toBe(2)
  expect(server.bodies.length).toBe(1)
  expect(server.bodies[0].model).toBe("gpt-test")
  pty.type("\x04")
  await pty.ends()
  expect(pty.code).toBe(0)
  for (const mode of RESTORED) {
    expect(pty.raw.lastIndexOf(mode)).toBeGreaterThan(pty.raw.lastIndexOf("Hello, I am"))
  }
  expect(messages(at.file)).toEqual([{ kind: "user", text: "hello there" }, { kind: "asst", text: "Hello, I am **EverChat**." }])
  expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "exit"]])
  expect(fs.statSync(at.home).mode & 0o777).toBe(0o700)
})

test("a program runs in the sandbox, and a quit after it does not wait for the sandbox's thread", async () => {
  const at = place()
  const server = fake((n) => (n === 1 ? program("call_1", "return await shell('echo from the sandbox')") : text("It is done.")))
  const pty = start(at, server.address)
  await pty.sees(IDLE)
  pty.type("run it\r")
  await pty.sees("▸ return await shell('echo from the sandbox')", "◂ from the sandbox", "It is done.", IDLE)
  pty.type("/quit\r")
  expect(await pty.ends()).toBeLessThan(3000)
  expect(pty.code).toBe(0)
  expect(messages(at.file).map((one) => one.kind)).toEqual(["user", "tool", "echo", "asst"])
})

test("a quit while a program computes ends the process at once", async () => {
  const at = place()
  const server = fake(() => program("call_1", "for (;;) {}"))
  const pty = start(at, server.address)
  await pty.sees(IDLE)
  pty.type("count for ever\r")
  await pty.sees("▸ for (;;) {}", "turn 1 · runs a program")
  pty.type("/quit\r")
  expect(await pty.ends()).toBeLessThan(3000)
  expect(pty.code).toBe(0)
  // The turn is cut, and so is its program: the next launch goes on with them.
  expect(turns(at.file)).toEqual([{ id: 1, status: "running" }])
  expect(rows(at.file, "select fn, status from call")).toEqual([{ fn: "run", status: "running" }])
})

for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
  test(signal + " while a turn runs: the screen is given back, the launch ends, and the next launch goes on with the turn", async () => {
    const at = place()
    let hold = true
    const server = fake(() => (hold ? "hold" : text("Here I am again.")))
    const first = start(at, server.address)
    await first.sees(IDLE)
    first.type("are you there?\r")
    await first.sees("I am still", "turn 1")
    first.kill(signal)
    expect(await first.ends()).toBeLessThan(5000)
    for (const mode of RESTORED) {
      expect(first.raw.lastIndexOf(mode)).toBeGreaterThan(first.raw.lastIndexOf("I am still"))
    }
    // The launch ended by a signal, and it was no crash. The turn still runs.
    expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "signal"]])
    expect(turns(at.file)).toEqual([{ id: 1, status: "running" }])

    hold = false
    const second = start(at, server.address)
    await second.sees("› are you there?", "Here I am again.", IDLE)
    second.type("\x04")
    await second.ends()
    expect(turns(at.file)).toEqual([{ id: 1, status: "done" }])
    expect(messages(at.file)).toEqual([{ kind: "user", text: "are you there?" }, { kind: "asst", text: "Here I am again." }])
    // What the program says about its own work is in the table, and not on the screen.
    expect(rows(at.file, "select level, source, text from log")).toContainEqual({ level: "info", source: "turn", text: "turn 1 was cut, and continues" })
    expect(second.raw).not.toContain("was cut, and continues")
  })
}

test("the keys of a real terminal: Esc stops the turn, the input can be edited, and Ctrl+C twice quits", async () => {
  const at = place()
  const server = fake(() => "hold")
  const pty = start(at, server.address)
  await pty.sees(IDLE)
  pty.type("say it all\r")
  await pty.sees("I am still", "turn 1")
  pty.type("\x1b")
  await pty.sees("· Stopped.", IDLE)
  expect(turns(at.file)).toEqual([{ id: 1, status: "stopped" }])
  // A paste of two rows stays in the input until Enter, and Ctrl+C empties the input.
  pty.type("\x1b[200~row one\nrow two\x1b[201~")
  const pasted = await pty.sees("row one", "row two")
  expect(pasted).not.toContain("› row one")
  pty.type("\x03")
  for (let k = 0; k < 500 && (await pty.text()).includes("row two"); k++) {
    await Bun.sleep(10)
  }
  expect(await pty.text()).not.toContain("row two")
  pty.type("\x03")
  await pty.sees("Press Ctrl+C again to quit")
  pty.type("\x03")
  await pty.ends()
  expect(pty.code).toBe(0)
  expect(messages(at.file).map((one) => one.kind)).toEqual(["user", "note"])
})

test("the terminal's window closes: the launch still ends cleanly", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const pty = start(at, server.address)
  await pty.sees(IDLE)
  pty.close()
  await pty.ends()
  // The system tells the process with SIGHUP.
  expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "signal"]])
})

test("a second process on the same home is refused, in one row, with no screen", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const first = start(at, server.address)
  await first.sees(IDLE)
  const second = start(at, server.address)
  await second.ends()
  expect(second.code).toBe(1)
  expect(await second.text()).toBe("everchat: another EverChat (process " + first.pid + ") has this chat open. One chat is one process.")
  // The first one still works.
  first.type("hello\r")
  await first.sees("Hello.", IDLE)
})

test("with no inference gateway to read, the program says what to set, and ends", async () => {
  const at = place()
  const pty = start(at, undefined)
  await pty.ends()
  expect(pty.code).toBe(1)
  const said = await pty.text()
  expect(said).toStartWith("everchat: set EVERCHAT_GATEWAY_URL and EVERCHAT_GATEWAY_KEY, or write the inference gateway file")
  // A launch that could not start leaves no live launch behind.
  expect(launches(at.file).every((one) => one.ended !== null)).toBe(true)
})

test("the arguments: the usage, the version, an unknown one, and no terminal", async () => {
  const at = place()
  const run = async (...args: Array<string>) => {
    const proc = Bun.spawn([...PROGRAM, ...args], { cwd: at.work, env: env(at, "http://127.0.0.1:1"), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { out, err, code }
  }
  const help = await run("--help")
  expect(help.code).toBe(0)
  expect(help.err).toStartWith("Usage: everchat [--model <model>]")
  expect(await run("--version")).toEqual({ out: "", err: "everchat 0.1.0\n", code: 0 })
  const unknown = await run("--nope")
  expect(unknown.code).toBe(2)
  expect(unknown.err).toStartWith("everchat: Unknown option '--nope'")
  expect(unknown.err).toContain("Usage: everchat")
  expect(await run()).toEqual({ out: "", err: "everchat: the standard input and the standard output must be a terminal.\n", code: 2 })
  // None of them made a home.
  expect(fs.existsSync(at.home)).toBe(false)
})
