// The whole program in pipe mode, as a process with pipes, against a fake
// vendor on this machine: what goes to the standard output, in which
// order the messages are sent, and how the process ends.
//
// No test here sends a request to a real model (tests/vendor.ts).

import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import { rows } from "./help.ts"
import { env, place, PROGRAM, program, text, vendor } from "./vendor.ts"

const open: Array<() => unknown> = []
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close()
  }
})

const fake = (answer: Parameters<typeof vendor>[0]) => {
  const made = vendor(answer)
  open.push(made.stop)
  return made
}

// One launch in pipe mode. `input` is the whole standard input. It gives
// the standard output, the standard error, and the exit code.
const run = async (at: ReturnType<typeof place>, address: string | undefined, input: string, args: ReadonlyArray<string> = ["--model", "gpt-test"]) => {
  const proc = Bun.spawn([...PROGRAM, ...args], { cwd: at.work, env: env(at, address), stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

const messages = (file: string) => rows<{ kind: string; text: string }>(file, "select kind, text from msg_read order by i")
const launches = (file: string) => rows<{ ended: number | null; why: string | null }>(file, "select ended, why from launch order by id")
const turns = (file: string) => rows<{ id: number; status: string }>(file, "select id, status from turn order by id")

test("a line of the standard input is a message, and each message goes to the standard output as text", async () => {
  const at = place()
  const server = fake(() => text("Hello, I am **EverChat**."))
  const ran = await run(at, server.address, "hello there\n")
  // The person's message with its mark, then EverChat's words as the model wrote them.
  expect(ran).toEqual({ out: "› hello there\n\nHello, I am **EverChat**.\n", err: "", code: 0 })
  expect(server.bodies.length).toBe(1)
  expect(server.bodies[0].model).toBe("gpt-test")
  expect(messages(at.file)).toEqual([{ kind: "user", text: "hello there" }, { kind: "asst", text: "Hello, I am **EverChat**." }])
  expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "exit"]])
  expect(fs.statSync(at.home).mode & 0o777).toBe(0o700)
})

test("the lines go one after the other: a line never steers the turn of the line before it", async () => {
  const at = place()
  const server = fake((n) => text("Answer " + n + "."))
  // An empty line is nothing, a last line needs no newline, and CRLF is a newline.
  const ran = await run(at, server.address, "first question\r\n\n   \nsecond question\nthird question")
  expect(ran.out).toBe("› first question\n\nAnswer 1.\n\n› second question\n\nAnswer 2.\n\n› third question\n\nAnswer 3.\n")
  expect(ran.code).toBe(0)
  expect(turns(at.file)).toEqual([{ id: 1, status: "done" }, { id: 2, status: "done" }, { id: 3, status: "done" }])
  // The first request was sent before the second line was a message.
  expect(JSON.stringify(server.bodies[0])).not.toContain("second question")
  expect(JSON.stringify(server.bodies[1])).toContain("first question")
  expect(JSON.stringify(server.bodies[1])).not.toContain("third question")
  expect(messages(at.file).map((one) => one.kind)).toEqual(["user", "asst", "user", "asst", "user", "asst"])
})

test("a program and its result are written whole, each with its mark", async () => {
  const at = place()
  const code = "const rows = []\nfor (let k = 0; k < 40; k++) rows.push('row ' + k)\nreturn rows.join('\\n')"
  const server = fake((n) => (n === 1 ? program("call_1", code) : text("It is done.")))
  const ran = await run(at, server.address, "count the rows\n")
  expect(ran.code).toBe(0)
  const result = Array.from({ length: 40 }, (_, k) => "row " + k)
  expect(ran.out).toBe(
    "› count the rows\n\n" +
      "▸ const rows = []\n  for (let k = 0; k < 40; k++) rows.push('row ' + k)\n  return rows.join('\\n')\n\n" +
      "◂ " + result.join("\n  ") + "\n\n" +
      "It is done.\n"
  )
  expect(messages(at.file).map((one) => one.kind)).toEqual(["user", "tool", "echo", "asst"])
})

test("no control character of a text goes to the standard output", async () => {
  const at = place()
  const server = fake((n) => (n === 1 ? program("call_1", "return '\\u001b[31mred\\u001b[0m \\u001b]0;a title\\u0007and a bell\\u0007'") : text("A \u001b[2Jclear\tand a tab.")))
  const ran = await run(at, server.address, "show it\n")
  expect(ran.out).toContain("◂ red and a bell\n")
  expect(ran.out).toContain("A clear    and a tab.\n")
  expect(ran.out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  // The log holds each text as it was.
  expect(messages(at.file)[3]?.text).toBe("A \u001b[2Jclear\tand a tab.")
})

test("a long text reaches the standard output whole, before the process ends", async () => {
  const at = place()
  const long = Array.from({ length: 20_000 }, (_, k) => "This is row " + k + " of a long reply.").join("\n")
  const server = fake(() => text(long))
  const ran = await run(at, server.address, "say much\n")
  expect(ran.code).toBe(0)
  expect(ran.out.length).toBe("› say much\n\n".length + long.length + 1)
  expect(ran.out.endsWith("This is row 19999 of a long reply.\n")).toBe(true)
})

test("a turn that failed leaves its note in the output, and the exit code is 1", async () => {
  const at = place()
  const server = fake((n) => (n === 1 ? new Response(JSON.stringify({ error: { message: "the key is not known" } }), { status: 401 }) : text("Not asked.")))
  const ran = await run(at, server.address, "hello\nare you there?\n")
  expect(ran.code).toBe(1)
  expect(ran.err).toBe("")
  expect(turns(at.file).map((one) => one.status)).toEqual(["failed", "done"])
  expect(ran.out).toStartWith("› hello\n\n· ")
  expect(ran.out).toContain("the key is not known")
  // The lines after it are still sent.
  expect(ran.out).toEndWith("› are you there?\n\nNot asked.\n")
  // The launch itself ended cleanly.
  expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "exit"]])
})

test("an empty standard input sends nothing, and a launch writes nothing of the log from before it", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  expect(await run(at, server.address, "hello\n")).toEqual({ out: "› hello\n\nHello.\n", err: "", code: 0 })
  expect(await run(at, server.address, "")).toEqual({ out: "", err: "", code: 0 })
  expect(server.bodies.length).toBe(1)
  expect(await run(at, server.address, "again\n")).toEqual({ out: "› again\n\nHello.\n", err: "", code: 0 })
  expect(launches(at.file).length).toBe(3)
})

test("a signal while a turn runs ends the process, and the next launch goes on with the turn before it reads a line", async () => {
  const at = place()
  let hold = true
  const server = fake((n) => (hold ? "hold" : text("Answer to request " + n + ".")))
  const first = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, server.address), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  first.stdin.write("are you there?\n")
  await first.stdin.flush()
  for (let k = 0; k < 1000 && server.bodies.length === 0; k++) {
    await Bun.sleep(10)
  }
  expect(server.bodies.length).toBe(1)
  first.kill("SIGTERM")
  expect(await first.exited).toBe(130)
  expect(await new Response(first.stdout).text()).toBe("› are you there?\n")
  expect(await new Response(first.stderr).text()).toBe("")
  expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "signal"]])
  expect(turns(at.file)).toEqual([{ id: 1, status: "running" }])

  hold = false
  const second = await run(at, server.address, "and now?\n")
  // The cut turn's reply first, then the new line's turn.
  expect(second).toEqual({ out: "Answer to request 2.\n\n› and now?\n\nAnswer to request 3.\n", err: "", code: 0 })
  expect(turns(at.file)).toEqual([{ id: 1, status: "done" }, { id: 2, status: "done" }])
  expect(JSON.stringify(server.bodies[1])).not.toContain("and now?")
  // What the program says about its own work is in the table, and not in the output.
  expect(rows(at.file, "select level, source, text from log")).toContainEqual({ level: "info", source: "turn", text: "turn 1 was cut, and continues" })
})

test("the reader of the standard output goes away: the program ends at once with the reason, and the log holds what was not written", async () => {
  const at = place()
  const gone = Promise.withResolvers<void>()
  // The second request never ends: a program that went on with the next
  // line would not end either.
  const server = fake(async (n) => {
    if (n > 1) {
      return "hold"
    }
    await gone.promise
    return text("An answer that nobody reads.")
  })
  const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, server.address), stdin: new Blob(["one\ntwo\n"]), stdout: "pipe", stderr: "pipe" })
  // The reader takes the first message, and goes away while the turn runs.
  const reader = proc.stdout.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("› one\n")
  await reader.cancel()
  gone.resolve()
  expect(await proc.exited).toBe(1)
  expect(await new Response(proc.stderr).text()).toBe("everchat: the standard output cannot be written to: its reader went away\n")
  expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "error"]])
  expect(messages(at.file).slice(0, 2).map((one) => one.text)).toEqual(["one", "An answer that nobody reads."])
  // A turn of the second line, if it started, was cut: the next launch goes on with it.
  expect(turns(at.file).map((one) => one.status).filter((status) => status !== "running")).toEqual(["done"])
})

test("--log-level sets the lowest level of the diagnostics, and no level puts a line on the standard output", async () => {
  const diagnostics = async (...level: Array<string>) => {
    const at = place()
    let hold = true
    const server = fake(() => (hold ? "hold" : text("Here I am again.")))
    // A cut turn: the launch that continues it logs one diagnostic, of the level info.
    const first = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, server.address), stdin: new Blob(["are you there?\n"]), stdout: "pipe", stderr: "pipe" })
    for (let k = 0; k < 1000 && server.bodies.length === 0; k++) {
      await Bun.sleep(10)
    }
    first.kill("SIGTERM")
    await first.exited
    hold = false
    expect(await run(at, server.address, "", ["--model", "gpt-test", ...level])).toEqual({ out: "Here I am again.\n", err: "", code: 0 })
    return rows<{ level: string }>(at.file, "select level from log").map((one) => one.level)
  }
  expect(await diagnostics()).toEqual(["info"])
  expect(await diagnostics("--log-level", "error")).toEqual([])
  // The store logs a line of the level debug while it opens the database,
  // before the diagnostics' logger is there. It must go nowhere.
  expect(await diagnostics("--log-level", "debug")).toContain("info")
})

test("the home is the directory that EVERCHAT_HOME names, and with none or an empty one it is .everchat in the person's own directory", async () => {
  const server = fake(() => text("Hello."))
  for (const named of [undefined, ""]) {
    const at = place()
    const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: { ...env(at, server.address), EVERCHAT_HOME: named }, stdin: new Blob(["hello\n"]), stdout: "pipe", stderr: "pipe" })
    expect(await proc.exited).toBe(0)
    expect(fs.existsSync(at.home)).toBe(false)
    expect(messages(at.root + "/.everchat/everchat.db").length).toBe(2)
    // Nothing was made in the work directory.
    expect(fs.readdirSync(at.work)).toEqual([])
  }
})

test("the program that cannot start says why in one line of the standard error", async () => {
  const at = place()
  const none = await run(at, undefined, "hello\n")
  expect(none.code).toBe(1)
  expect(none.out).toBe("")
  expect(none.err).toStartWith("everchat: set EVERCHAT_GATEWAY_URL and EVERCHAT_GATEWAY_KEY, or write the inference gateway file")
  expect(none.err.trimEnd().split("\n").length).toBe(1)
  expect(launches(at.file).every((one) => one.ended !== null)).toBe(true)
})

test("the arguments: the usage, the version, the completions, and a wrong one", async () => {
  const at = place()
  const help = await run(at, "http://127.0.0.1:1", "", ["--help"])
  expect(help.code).toBe(0)
  expect(help.err).toBe("")
  for (const part of ["EverChat: one chat that never ends.", "pipe", "EVERCHAT_HOME", "--model", "--effort", "--compactor", "--version", "--completions", "--log-level"]) {
    expect(help.out).toContain(part)
  }
  expect(help.out).not.toContain("--wizard")
  expect(await run(at, "http://127.0.0.1:1", "", ["--version"])).toEqual({ out: "everchat v0.1.0\n", err: "", code: 0 })
  const fish = await run(at, "http://127.0.0.1:1", "", ["--completions", "fish"])
  expect(fish.code).toBe(0)
  expect(fish.out).toContain("complete -c everchat")
  const unknown = await run(at, "http://127.0.0.1:1", "", ["--nope"])
  expect(unknown.code).toBe(2)
  expect(unknown.err).toContain("Unrecognized flag: --nope")
  expect(unknown.err).not.toContain("everchat:")
  expect((await run(at, "http://127.0.0.1:1", "", ["--model"])).code).toBe(2)
  expect((await run(at, "http://127.0.0.1:1", "", ["a message"])).code).toBe(2)
  // None of them made a home.
  expect(fs.existsSync(at.home)).toBe(false)
})
