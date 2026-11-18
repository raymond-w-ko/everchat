// The whole program as a process, in a real pseudo-terminal, against a
// fake vendor on this machine. What a person sees, how the process ends,
// and what a launch leaves in the database.
//
// No test here sends a request to a real model: every launch gets the fake
// vendor's address, and a home directory of its own with no gateway file.

import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { ending, terminalLost } from "../src/main.ts"
import { rows, write } from "./help.ts"
import { Pty } from "./pty.ts"
import { env, place, PROGRAM, program, text, vendor } from "./vendor.ts"

const open: Array<() => unknown> = []
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close()
  }
})

// `stderr`: a file for the program's standard error (pty.ts); with none, the terminal.
const start = (at: ReturnType<typeof place>, address: string | undefined, args: ReadonlyArray<string> = ["--model", "gpt-test"], stderr?: string) => {
  const pty = new Pty([...PROGRAM, ...args], env(at, address), at.work, 100, 30, stderr)
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

const messages = (file: string) => rows<{ kind: string; text: string }>(file, "select kind, text from everchat_msg_read order by i")
// Why a launch ended: "exit" (a quit), "signal", "error", or "crash" (the next launch found it open).
const launches = (file: string) => rows<{ id: number; ended: number | null; why: string | null }>(file, "select n as id, ended, why from everchat_launch order by n")
const turns = (file: string) => rows<{ id: number; status: string }>(file, "select n as id, status from everchat_turn order by n")

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
  expect(rows(at.file, "select fn, status from everchat_call")).toEqual([{ fn: "run", status: "running" }])
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
    expect(rows(at.file, "select level, source, text from everchat_log")).toContainEqual({ level: "info", source: "turn", text: "turn 1 was cut, and continues" })
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

// What a red run of the window-close case needs to name its cause: how the
// child ended, the launch rows as read after its exit, what it wrote to its
// standard error (a file, so what came after the close is kept; lead,
// ec-vj0kn, 1), and the last of what the terminal got.
const closeReport = (pty: Pty, launched: ReturnType<typeof launches>, stderr: string) =>
  "the child ended with the code " + pty.code + " and the signal " + pty.signal + "; the launch rows as read after its exit: " +
  JSON.stringify(launched) + "; its standard error: " + JSON.stringify(fs.existsSync(stderr) ? fs.readFileSync(stderr, "utf8") : "(no file)") +
  "; the last of what the terminal got: " + JSON.stringify(pty.raw.slice(-1500))

test("the terminal's window closes: the launch still ends cleanly", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const stderr = path.join(at.root, "stderr")
  const pty = start(at, server.address, undefined, stderr)
  await pty.sees(IDLE)
  pty.close()
  // `ends` gives back only when the system has reported the child's exit.
  await pty.ends()
  const rows = launches(at.file)
  const seen = closeReport(pty, rows, stderr)
  // The system tells the process with SIGHUP, and the read of the input
  // fails, in either order: one end, by a signal.
  expect(rows.map((one) => [one.ended !== null, one.why]), seen).toEqual([[true, "signal"]])
  // The screen cannot be given back to a lost terminal, and that is no failure.
  expect(pty.code, seen).toBe(130)
})

// The proof of that message (lead, ec-vj0kn, 4): a child that writes a named
// line to its standard error after the terminal closed, and ends with the
// launch open. A file that the program loads first (`--preload`) does it at
// the first sign of the close (SIGHUP, the input's end or its error), before
// the program's own handlers. It holds the helper, and nothing of main.ts.
const AFTER = "a named line after the close"
const LEAVES = `import * as fs from "node:fs"
const leave = () => {
  fs.writeSync(2, ${JSON.stringify(AFTER)} + "\\n")
  process.exit(1)
}
process.on("SIGHUP", leave)
process.stdin.once("end", leave)
process.stdin.once("error", leave)`

test("the window-close case's message keeps the child's standard error: a child that writes a named line to it after the terminal closed, and ends with its launch open, gives that line, the code and the open row", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const preload = path.join(at.root, "leaves.ts")
  fs.writeFileSync(preload, LEAVES)
  const stderr = path.join(at.root, "stderr")
  const pty = new Pty([process.execPath, "--preload", preload, path.join(import.meta.dir, "..", "src", "main.ts"), "--model", "gpt-test"], env(at, server.address), at.work, 100, 30, stderr)
  open.push(async () => {
    if (pty.code === null) {
      pty.kill("SIGKILL")
      await pty.ends()
    }
  })
  await pty.sees(IDLE)
  pty.close()
  await pty.ends()
  const rows = launches(at.file)
  const seen = closeReport(pty, rows, stderr)
  expect([pty.code, rows.map((one) => [one.ended !== null, one.why])], seen).toEqual([1, [[false, null]]])
  expect(seen).toContain(JSON.stringify(AFTER + "\n"))
  expect(seen).toContain("the code 1 ")
  expect(seen).toContain(JSON.stringify(rows))
  expect(seen).toContain('"ended":null')
  // Not on the terminal: it had closed.
  expect(pty.raw).not.toContain(AFTER)
})

// The loss of the terminal with the read's failure first, for sure, and not
// by the luck of a load. A parent that ignores SIGHUP runs the program in a
// session of its own, so the closed terminal is not its controlling one and
// no SIGHUP comes; the parent exits with the program's code. The read of a
// closed terminal fails (EIO) or ends (EOF), as the system's race falls; a
// file that the program loads first (`--preload`) makes an end that failure.
// It notes each SIGHUP that the process hears in the file `heard`. The
// program runs from its source.
const DETACHED = `process.on("SIGHUP", () => {})
const child = Bun.spawn(process.argv.slice(1), { stdio: ["inherit", "inherit", "inherit"], detached: true })
process.exit(await child.exited)`
const FAILS = `import * as fs from "node:fs"
process.stdin.once("end", () => process.stdin.emit("error", Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", errno: -5, syscall: "read" })))
process.on("SIGHUP", () => fs.appendFileSync(process.env.HEARD!, "SIGHUP\\n"))`

test("the terminal is lost, and the read of its input fails first: the launch ends by a signal, with 130", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const preload = path.join(at.root, "fails.ts")
  fs.writeFileSync(preload, FAILS)
  const heard = path.join(at.root, "heard")
  const main = path.join(import.meta.dir, "..", "src", "main.ts")
  const pty = new Pty([process.execPath, "-e", DETACHED, process.execPath, "--preload", preload, main, "--model", "gpt-test"], { ...env(at, server.address), HEARD: heard }, at.work)
  open.push(async () => {
    if (pty.code === null) {
      pty.kill("SIGKILL")
      await pty.ends()
    }
    // The program, in its own session, if its parent left it.
    for (const one of fs.existsSync(at.file) ? rows<{ pid: number; ended: number | null }>(at.file, "select pid, ended from everchat_launch") : []) {
      if (one.ended === null) {
        try {
          process.kill(one.pid, "SIGKILL")
        } catch {}
      }
    }
  })
  await pty.sees(IDLE)
  pty.close()
  await pty.ends()
  // No SIGHUP came: the read's failure alone ended the launch.
  expect(fs.existsSync(heard)).toBe(false)
  expect(launches(at.file).map((one) => [one.ended !== null, one.why])).toEqual([[true, "signal"]])
  expect(pty.code).toBe(130)
})

// The two signs in a row, on the rule of the end itself (`ending`, which
// runMain uses). In the whole program a SIGHUP that comes while the parts
// close is heard only after they closed: the close runs to the exit with no
// turn of the event loop, so no signal handler runs in it. The one sign
// inside the close is the give-back's failure, on the input's stream: the
// two cases above hold that one.
test("the read of the input fails, and then SIGHUP comes while the parts close: the parts still close; a second signal ends at once", () => {
  const did: Array<string> = []
  const ends = ending(() => did.push("interrupt"), (code) => did.push("exit " + code))
  ends.lost()
  ends.signal()
  // The failure asked for the close; SIGHUP was the first signal, so nothing more.
  expect(did).toEqual(["interrupt"])
  ends.lost()
  expect(did).toEqual(["interrupt"])
  ends.signal()
  expect(did).toEqual(["interrupt", "exit 1"])
  // SIGHUP first, and then the failure: one close too.
  const other: Array<string> = []
  const second = ending(() => other.push("interrupt"), (code) => other.push("exit " + code))
  second.signal()
  second.lost()
  expect(other).toEqual(["interrupt"])
  second.signal()
  expect(other).toEqual(["interrupt", "exit 1"])
})

// An error of the terminal's input while the terminal is there, with no
// signal: a file that the program loads first (`--preload`) emits it on the
// input's stream when the person types MARK. Only `EIO`, the error of a
// terminal that is gone, is the terminal's loss.
const MARK = "fail-the-read"
const failing = (code: string) =>
  `process.stdin.on("data", (data) => { if (String(data).includes(${JSON.stringify(MARK)})) process.stdin.emit("error", Object.assign(new Error(${
    JSON.stringify(code + ": read failed")
  }), { code: ${JSON.stringify(code)}, syscall: "read" })) })`

const failAt = async (code: string) => {
  const at = place()
  const server = fake(() => text("Hello."))
  const preload = path.join(at.root, "failing.ts")
  fs.writeFileSync(preload, failing(code))
  const pty = new Pty([process.execPath, "--preload", preload, path.join(import.meta.dir, "..", "src", "main.ts"), "--model", "gpt-test"], env(at, server.address), at.work)
  open.push(async () => {
    if (pty.code === null) {
      pty.kill("SIGKILL")
      await pty.ends()
    }
  })
  await pty.sees(IDLE)
  pty.type(MARK)
  await pty.ends()
  return { pty, launches: launches(at.file) }
}

for (const code of ["EBADF", "EACCES"]) {
  test(`at a terminal that is there, a read of its input that fails with ${code} is a failure of the program: the code 1, its text on the standard error, the launch ended with an error`, async () => {
    const { pty, launches: got } = await failAt(code)
    expect(pty.code).toBe(1)
    expect(pty.raw).toContain(`everchat: the read of the terminal failed: ${code}: read failed`)
    // The parts closed: the launch ended, and not by a signal.
    expect(got.map((one) => [one.ended !== null, one.why])).toEqual([[true, "error"]])
    // The screen was given back.
    for (const sequence of RESTORED) expect(pty.raw).toContain(sequence)
  })
}

test("a read of the terminal's input that fails with EIO, with no signal, is the terminal's loss: the launch ends by a signal, with 130", async () => {
  const { pty, launches: got } = await failAt("EIO")
  expect(got.map((one) => [one.ended !== null, one.why])).toEqual([[true, "signal"]])
  expect(pty.code).toBe(130)
  expect(pty.raw).not.toContain("everchat:")
})

// An error of the terminal's input after a stop that a signal asked. A file
// that the program loads first (`--preload`) arms when the person types
// MARK; the test waits for MARK on the screen and then sends the real
// signal. The give-back of the screen (`setRawMode(false)`, in the close of
// the parts) then emits each of `errors` on the input's stream, in order,
// one time. `HEARD`: the file where it notes each SIGTERM that the process
// hears; `SIGNAL`, when set: the give-back sends that real signal to its own
// process before it emits, so that it comes while the parts close.
const GIVING_BACK = (errors: ReadonlyArray<string>) => `import * as fs from "node:fs"
let armed = false
process.stdin.on("data", (data) => { if (String(data).includes(${JSON.stringify(MARK)})) armed = true })
process.on("SIGTERM", () => fs.appendFileSync(process.env.HEARD!, "SIGTERM\\n"))
const setRawMode = process.stdin.setRawMode
process.stdin.setRawMode = function(mode) {
  const done = setRawMode.call(this, mode)
  if (armed && !mode) {
    armed = false
    if (process.env.SIGNAL) process.kill(process.pid, process.env.SIGNAL)
    for (const message of ${JSON.stringify(errors)}) process.stdin.emit("error", new Error(message))
  }
  return done
}`

// The close of the parts, held: the same file, with this added, wraps the
// terminal's layer in one more finalizer. It runs first in the close, before
// the screen is given back: it writes the file `GATE`, and it waits until the
// file `RELEASE` is there. Both the program and this file take Effect and
// terminal.ts by the same path, so they share one instance of each.
const GATED = `import { Effect, Layer } from ${JSON.stringify(Bun.resolveSync("effect", path.join(import.meta.dir, "..", "src")))}
import { Terminal } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "terminal.ts"))}
const terminalLayer = Terminal.layer
Object.defineProperty(Terminal, "layer", {
  value: (options) => Layer.tap(terminalLayer(options), () => Effect.addFinalizer(() => Effect.promise(async () => {
    fs.writeFileSync(process.env.GATE!, "waiting")
    while (!fs.existsSync(process.env.RELEASE!)) await Bun.sleep(5)
  })))
})`

// Waits until `file` is there.
const appears = async (file: string) => {
  for (let k = 0; k < 1500 && !fs.existsSync(file); k++) {
    await Bun.sleep(10)
  }
  expect(fs.existsSync(file), "the file " + file + " never came").toBe(true)
}

// `gate` (with `first`): the close of the parts is held (GATED); the test
// waits until it waits, sends the real SIGTERM, waits until the program has
// heard it while the close still waits, and then lets the close go on.
const giveBackFails = async (errors: ReadonlyArray<string>, given: { readonly signal?: "SIGTERM"; readonly first?: string; readonly gate?: boolean } = {}) => {
  const at = place()
  const server = fake(() => text("Hello."))
  const preload = path.join(at.root, "giving-back.ts")
  // `first`: an error of the read that the program gets when MARK is typed, before any signal.
  fs.writeFileSync(preload, GIVING_BACK(errors) + (given.first === undefined ? "" : "\n" + failing(given.first)) + (given.gate === true ? "\n" + GATED : ""))
  const heard = path.join(at.root, "heard")
  const gate = path.join(at.root, "gate")
  const release = path.join(at.root, "release")
  const pty = new Pty(
    [process.execPath, "--preload", preload, path.join(import.meta.dir, "..", "src", "main.ts"), "--model", "gpt-test"],
    { ...env(at, server.address), HEARD: heard, GATE: gate, RELEASE: release, ...(given.signal === undefined ? {} : { SIGNAL: given.signal }) },
    at.work
  )
  open.push(async () => {
    fs.writeFileSync(release, "go")
    if (pty.code === null) {
      pty.kill("SIGKILL")
      await pty.ends()
    }
  })
  await pty.sees(IDLE)
  pty.type(MARK)
  if (given.first === undefined) {
    await pty.sees(MARK)
    pty.kill("SIGTERM")
  }
  if (given.gate === true) {
    await appears(gate)
    pty.kill("SIGTERM")
    await appears(heard)
    // Heard while the close waits: the process has not ended.
    expect([fs.readFileSync(heard, "utf8"), pty.code]).toEqual(["SIGTERM\n", null])
    fs.writeFileSync(release, "go")
  }
  await pty.ends()
  const got = launches(at.file).map((one) => [one.ended !== null, one.why])
  const heardOf = fs.existsSync(heard) ? fs.readFileSync(heard, "utf8") : ""
  return { pty, launches: got, heard: heardOf, seen: JSON.stringify({ code: pty.code, launches: got, heard: heardOf, raw: pty.raw.slice(-1500) }) }
}

// How often `line` is in `raw`.
const count = (raw: string, line: string) => raw.split(line).length - 1

test("SIGTERM, and then an error of the input that is no loss (the give-back's errno 9): the program ends as the signal asked, with 130, and tells the first such error in one line after the screen is given back", async () => {
  const { pty, launches: got, heard, seen } = await giveBackFails(["setRawMode failed with errno: 9", "setRawMode failed with errno: 25"])
  expect(heard, seen).toBe("SIGTERM\n")
  expect(pty.code, seen).toBe(130)
  // The parts closed in full: the launch ended, by the signal.
  expect(got, seen).toEqual([[true, "signal"]])
  const line = "everchat: the read of the terminal failed: setRawMode failed with errno: 9"
  expect(count(pty.raw, line), seen).toBe(1)
  // One line for one stop: a later error is not told.
  expect(pty.raw, seen).not.toContain("errno: 25")
  expect(count(pty.raw, "everchat:"), seen).toBe(1)
  // Never into the screen: after the sequences that give it back.
  for (const sequence of RESTORED) expect(pty.raw.lastIndexOf(sequence), seen).toBeLessThan(pty.raw.indexOf(line))
})

test("SIGTERM, and then the give-back's errno 5 (the terminal is lost): 130, the launch ended by the signal, and no line", async () => {
  const { pty, launches: got, heard, seen } = await giveBackFails(["setRawMode failed with errno: 5"])
  expect(heard, seen).toBe("SIGTERM\n")
  expect(pty.code, seen).toBe(130)
  expect(got, seen).toEqual([[true, "signal"]])
  expect(pty.raw, seen).not.toContain("everchat:")
  for (const sequence of RESTORED) expect(pty.raw, seen).toContain(sequence)
})

// The signal here is sent inside the give-back, which is synchronous: the
// close then runs to the exit with no turn of the event loop, so its handler
// is never heard, and the code stays 1. It does not reach a signal that is
// heard while the close waits: the case after it holds that one.
test("an error of the input that is no loss (EBADF), with no stop asked, and then SIGTERM while the parts close: the code 1, the launch ended with an error, its line once", async () => {
  const { pty, launches: got, seen } = await giveBackFails([], { signal: "SIGTERM", first: "EBADF" })
  expect(pty.code, seen).toBe(1)
  expect(got, seen).toEqual([[true, "error"]])
  expect(count(pty.raw, "everchat: the read of the terminal failed: EBADF: read failed"), seen).toBe(1)
  expect(count(pty.raw, "everchat:"), seen).toBe(1)
  for (const sequence of RESTORED) expect(pty.raw.lastIndexOf(sequence), seen).toBeLessThan(pty.raw.indexOf("everchat:"))
})

test("an error of the input that is no loss (EBADF) starts the close, and SIGTERM is heard while the close waits: the code 130, the launch ended with an error, its line once after the screen is given back", async () => {
  const { pty, launches: got, seen } = await giveBackFails([], { first: "EBADF", gate: true })
  expect(pty.code, seen).toBe(130)
  expect(got, seen).toEqual([[true, "error"]])
  const line = "everchat: the read of the terminal failed: EBADF: read failed"
  expect(count(pty.raw, line), seen).toBe(1)
  expect(count(pty.raw, "everchat:"), seen).toBe(1)
  for (const sequence of RESTORED) expect(pty.raw.lastIndexOf(sequence), seen).toBeLessThan(pty.raw.indexOf(line))
})

test("the loss of the terminal is the error of a terminal that is gone: EIO, or the give-back's errno 5, and no other", () => {
  expect(terminalLost(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }))).toBe(true)
  expect(terminalLost(new Error("setRawMode failed with errno: 5"))).toBe(true)
  for (const other of [Object.assign(new Error("EBADF: read failed"), { code: "EBADF" }), Object.assign(new Error("x"), { code: "EACCES" }), new Error("setRawMode failed with errno: 9"), new Error("EIO"), "EIO", null, undefined]) {
    expect(terminalLost(other)).toBe(false)
  }
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

// The home's config file (config.ts), before a launch.
const configure = (at: ReturnType<typeof place>, value: unknown) => {
  fs.mkdirSync(at.home, { recursive: true, mode: 0o700 })
  const file = path.join(at.home, "config.json")
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

test("a config file with faults: the program ends with 1, each fault and its field on the standard error, with no screen and no database", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const config = configure(at, { limit: 5, nope: true, servers: { git: { command: "c", args: [3] } } })
  const stderr = path.join(at.root, "stderr")
  const pty = start(at, server.address, undefined, stderr)
  await pty.ends()
  expect(pty.code).toBe(1)
  expect(fs.readFileSync(stderr, "utf8").split("\n").sort()).toEqual([
    "",
    "everchat: " + config + ": limit: Expected a whole number from 2000 to 1000000",
    "everchat: " + config + ": nope: Unknown field",
    "everchat: " + config + ": servers.git.args[0]: Expected string"
  ])
  // No screen: the paste was never bracketed.
  expect(pty.raw).not.toContain("\x1b[?2004h")
  expect(fs.existsSync(at.file)).toBe(false)
  expect(server.bodies.length).toBe(0)
})

test("a config file sets the picks and the output limit, and a flag wins over it", async () => {
  const at = place()
  // The compactions' requests are answered apart, whenever they come.
  let turns = 0
  const server = fake((_, body) => (body.model === "gpt-file-compactor" ? text("A summary.") : ++turns === 1 ? program("call_1", "return 'y'.repeat(5000)") : text("It is done.")))
  configure(at, { model: "gpt-file", effort: "high", compactor: "gpt-file-compactor", limit: 2_000 })
  const pty = start(at, server.address, ["--model", "gpt-test"])
  await pty.sees("idle · gpt-test high")
  pty.type("run it\r")
  await pty.sees("It is done.", "idle · gpt-test high")
  const asked = server.bodies.filter((body) => body.model !== "gpt-file-compactor")
  expect(asked.map((body) => [body.model, body.reasoning.effort])).toEqual([["gpt-test", "high"], ["gpt-test", "high"]])
  // A compaction, if one came, asked the file's compactor.
  for (const body of server.bodies.filter((one) => !asked.includes(one))) expect(body.reasoning.effort).toBe("low")
  // The program's result was shortened to the file's limit (the default is 30,000).
  const output = JSON.stringify(asked[1].input)
  expect(output).toContain("y".repeat(900))
  expect(output).not.toContain("y".repeat(2_000))
  pty.type("/quit\r")
  await pty.ends()
  expect(pty.code).toBe(0)
})

// The system text of each turn's head, as its row holds it.
const heads = (file: string) =>
  rows<{ body: string }>(file, "select h.body from everchat_turn t join everchat_head h on h.chat = t.chat and h.n = t.head order by t.n").map((one) => (JSON.parse(one.body) as { system: string }).system)

test("a config file names the agent and a rules file in the work directory: the head of the turn's row has both", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  configure(at, { name: "Ada", rules: "RULES.md" })
  fs.writeFileSync(path.join(at.work, "RULES.md"), "Answer in haiku.\n")
  // A file of the same name in the home is not the one read.
  fs.writeFileSync(path.join(at.home, "RULES.md"), "Answer in prose.\n")
  const pty = start(at, server.address)
  await pty.sees(IDLE)
  pty.type("hello\r")
  await pty.sees("Hello.", IDLE)
  pty.type("/quit\r")
  await pty.ends()
  expect(pty.code).toBe(0)
  const [system, ...more] = heads(at.file)
  expect(more).toEqual([])
  expect(system!.startsWith("You are Ada, an AI agent")).toBe(true)
  expect(system!.split("Ada").length - 1).toBe(16)
  expect(system).not.toContain("EverChat")
  expect(system!.endsWith("\n# The user's instructions\n\nAnswer in haiku.\n")).toBe(true)
  expect(system).not.toContain("prose")
  // The request carried that head.
  expect(JSON.stringify(server.bodies[0])).toContain("You are Ada, an AI agent")
})

test("a launch whose rules file is missing does not start: the code 1, the field rules on the standard error, no screen and no database", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const config = configure(at, { name: "Ada", rules: "missing.md" })
  const stderr = path.join(at.root, "stderr")
  const pty = start(at, server.address, undefined, stderr)
  await pty.ends()
  expect(pty.code).toBe(1)
  expect(fs.readFileSync(stderr, "utf8")).toBe("everchat: " + config + ": rules: no such file\n")
  expect(pty.raw).not.toContain("\x1b[?2004h")
  expect(fs.existsSync(at.file)).toBe(false)
  expect(server.bodies.length).toBe(0)
})

// The repository's example server (tools/mcpexample.ts), as a config's server.
const EXAMPLE = path.join(import.meta.dir, "../../../tools/mcpexample.ts")
const isCompaction = (body: unknown) => JSON.stringify(body).includes("Compaction: ")

test("a launch with a gated function (the example's tools, approval ask): a program's call waits; after a yes, the next launch's load runs it one time and its result starts a turn of its own", async () => {
  const at = place()
  configure(at, { servers: { example: { command: process.execPath, args: [EXAMPLE], approval: "ask" } } })
  let turns = 0
  const server = fake((_, body) =>
    isCompaction(body)
      ? text("a line")
      : JSON.stringify(body).includes("a call that waited for approval has run")
      ? text("Late seen.")
      : ++turns === 1
      ? program("call_1", "return await example.send({ to: 'ada', text: 'hi' })")
      : text("It waits.")
  )
  const first = start(at, server.address)
  await first.sees(IDLE)
  first.type("send it\r")
  await first.sees("It waits.", IDLE)
  first.type("/quit\r")
  await first.ends()
  expect(first.code).toBe(0)
  const approval = () => rows<{ n: number; fn: string; input: string; status: string; output: string | null; msg: number | null }>(at.file, "select n, fn, input, status, output, msg from everchat_approval")
  expect(approval()).toEqual([{ n: 1, fn: "example.send", input: "[{\"to\":\"ada\",\"text\":\"hi\"}]", status: "pending", output: null, msg: null }])
  // A person's yes, as the store's answer writes it.
  write(at.file, "update everchat_approval set status = 'yes', who = 'Ada', answered = ? where n = 1", [Date.now()])
  const second = start(at, server.address)
  await second.sees("Late seen.", IDLE)
  second.type("/quit\r")
  await second.ends()
  expect(second.code).toBe(0)
  const [row] = approval()
  expect([row!.status, row!.output]).toEqual(["done", "Not sent (an example): 2 characters to \"ada\"."])
  const late = messages(at.file).filter((one) => one.kind === "late")
  expect(late.map((one) => one.text)).toEqual(["Approval 1: example.send({\"to\":\"ada\",\"text\":\"hi\"}) ran after a yes by Ada.\nResult:\nNot sent (an example): 2 characters to \"ada\"."])
  expect(rows<{ msg: number }>(at.file, "select msg from everchat_approval")[0]!.msg).toBe(rows<{ i: number }>(at.file, "select i from everchat_msg_read where kind = 'late'")[0]!.i)
  // The call's own row still waits; the turn of the late message ran.
  expect(rows<{ status: string }>(at.file, "select status from everchat_call where fn = 'example.send'")).toEqual([{ status: "pending" }])
  expect(server.bodies.filter((body) => JSON.stringify(body).includes("a call that waited for approval has run")).length).toBe(1)
})

test("a compaction's request has the same head as the turn's: the config's name and rules, and the functions", async () => {
  const at = place()
  configure(at, { name: "Ada", rules: "RULES.md" })
  fs.writeFileSync(path.join(at.work, "RULES.md"), "Answer in haiku.\n")
  // A message of more than NODE (512) bytes needs a compaction of its own,
  // for sure. The turn's reply waits until that compaction was asked, so
  // its request is in `bodies` once the reply is on the screen.
  let compacted!: () => void
  const compaction = new Promise<void>((resolve) => {
    compacted = resolve
  })
  const server = fake(async (_, body) => {
    if (isCompaction(body)) {
      compacted()
      return text("a line")
    }
    await compaction
    return text("Hello.")
  })
  const pty = start(at, server.address)
  await pty.sees(IDLE)
  pty.type("hello " + "word ".repeat(120) + "\r")
  await pty.sees("Hello.", IDLE)
  pty.type("/quit\r")
  await pty.ends()
  expect(pty.code).toBe(0)
  const compactions = server.bodies.filter(isCompaction)
  const [turn, ...others] = server.bodies.filter((body) => !isCompaction(body))
  expect(others).toEqual([])
  expect(compactions.length).toBeGreaterThan(0)
  const system: string = turn.input[0].content[0].text
  expect(system.startsWith("You are Ada, an AI agent")).toBe(true)
  expect(system.endsWith("\n# The user's instructions\n\nAnswer in haiku.\n")).toBe(true)
  for (const body of compactions) {
    expect(body.input[0]).toEqual(turn.input[0])
    expect(body.tools).toEqual(turn.tools)
  }
})

test("when only one of the standard input and the standard output is a terminal, the program works in pipe mode", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const command = PROGRAM.map((part) => "'" + part + "'").join(" ") + " --model gpt-test"
  const shell = (line: string) => {
    const pty = new Pty(["sh", "-c", line], env(at, server.address), at.work)
    open.push(async () => {
      if (pty.code === null) {
        pty.kill("SIGKILL")
        await pty.ends()
      }
    })
    return pty
  }
  // The standard input is a pipe, and the standard output is the terminal.
  const piped = shell("printf 'hello\\n' | " + command)
  await piped.ends()
  expect(piped.code).toBe(0)
  expect(await piped.text()).toBe("› hello\n\nHello.")
  // No screen was drawn: the terminal's modes were not touched.
  expect(piped.raw).not.toContain("\x1b[?2004h")

  // The standard input is the terminal, and the standard output is a file.
  const file = path.join(at.root, "out.txt")
  const typed = shell(command + " > '" + file + "'")
  typed.type("again\n")
  for (let k = 0; k < 1000 && !(fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("Hello.")); k++) {
    await Bun.sleep(10)
  }
  // Ctrl+D on an empty line ends the input.
  typed.type("\x04")
  await typed.ends()
  expect(typed.code).toBe(0)
  expect(fs.readFileSync(file, "utf8")).toBe("› again\n\nHello.\n")
  expect(messages(at.file).map((one) => one.text)).toEqual(["hello", "Hello.", "again", "Hello."])
})
