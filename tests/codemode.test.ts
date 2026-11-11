// Code mode, whole: turns with a fake wire, and with the real sandbox, the
// real functions and the output limit. What a program does to the world,
// what the model is shown, what the database keeps, and what a stop and a
// restart leave behind.

import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Ask, AskDelay } from "../src/ask.ts"
import { Cache } from "../src/cache.ts"
import { Functions } from "../src/functions.ts"
import { Limit } from "../src/limit.ts"
import { Memory } from "../src/memory.ts"
import type { Reply, Request } from "../src/request.ts"
import { Sandbox, STOPPED as FUNCTION_STOPPED } from "../src/sandbox.ts"
import { Shell } from "../src/shell.ts"
import { Store } from "../src/store.ts"
import { CUT, CUT_FUNCTION, STOPPED, Turns } from "../src/turn.ts"
import { compactor, fakeWire, newFile, options, reply, rows, write } from "./help.ts"

// One launch of the whole program but the terminal: a fake wire, and the
// work directory in the home.
const launch = <A, E>(file: string, wire: ReturnType<typeof fakeWire>, effect: Effect.Effect<A, E, Turns | Store | Limit>, limit = 2000) => {
  const cwd = path.dirname(file)
  const store = Store.layer(file, options({ runTag: "tag-" + crypto.randomUUID() }))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const limits = Limit.layer({ dir: path.join(cwd, "results"), limit }).pipe(Layer.provide(store))
  const shell = Shell.layer({ cwd, shell: "/bin/sh" }).pipe(Layer.provide(store))
  const functions = Functions.layer({ cwd }).pipe(Layer.provide(Layer.mergeAll(memory, shell, limits)))
  const sandbox = Sandbox.layer().pipe(Layer.provide(functions), Layer.provide(store))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const turns = Turns.layer().pipe(Layer.provideMerge(memory), Layer.provideMerge(limits), Layer.provide(Layer.merge(asking, sandbox)))
  return Effect.runPromise(effect.pipe(Effect.provide(turns), Effect.provideService(AskDelay, () => Effect.succeed(0))))
}

// A wire whose model runs the given programs, one per step, and then says "Done."
const model = (...programs: ReadonlyArray<string>) =>
  fakeWire((asked, n): Reply => {
    const program = programs[n - 1]
    return program === undefined
      ? reply(asked, { text: "Done.", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] })
      : reply(asked, {
        text: "",
        output: [{ type: "custom_tool_call", call_id: "call_" + n, name: "run", input: program }],
        calls: [{ id: "call_" + n, name: "run", input: program }]
      })
  })

const back = (asked: Request | undefined): string => {
  const last = asked?.items[asked.items.length - 1]
  return last?.kind === "back" ? last.results[0]?.output ?? "" : "(no result)"
}

const calls = (file: string) =>
  rows<{ id: number; parent: number | null; fn: string; status: string; output: string | null; size: number | null; shown: number | null; pgid: number | null }>(
    file,
    "select id, parent, fn, status, output, size, shown, pgid from call order by id"
  )
const messages = (file: string) => rows<{ kind: string; text: string }>(file, "select kind, text from msg_read order by i")

const eventually = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 1000 && !check(); k++) {
      yield* Effect.sleep("5 millis")
    }
    if (!check()) {
      return yield* Effect.die("the test waited 5 s for a state that did not come")
    }
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return !fs.readFileSync("/proc/" + pid + "/stat", "utf8").includes(") Z ")
  } catch {
    return false
  }
}

const say = (text: string) =>
  Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say(text)
    yield* turns.idle
  })

test("a program changes files and runs commands, and only the program and its result enter the log", async () => {
  const file = newFile()
  const cwd = path.dirname(file)
  const program = [
    "await write('greeting.txt', 'hello\\n')",
    "const listing = await shell('cat greeting.txt; ls greeting.txt')",
    "await edit([{ path: 'greeting.txt', old: 'hello', new: 'goodbye' }])",
    "console.log(listing.split('\\n').slice(0, 2).join(' / '))",
    "return await read('greeting.txt')"
  ].join("\n")
  const wire = model(program)
  await launch(file, wire, say("make the file"))
  expect(fs.readFileSync(path.join(cwd, "greeting.txt"), "utf8")).toBe("goodbye\n")
  // The model is shown what the program printed, then what it returned.
  expect(back(wire.sent[1])).toBe("hello / greeting.txt\ngoodbye\n")
  expect(messages(file)).toEqual([
    { kind: "user", text: "make the file" },
    { kind: "tool", text: program },
    { kind: "echo", text: "hello / greeting.txt\ngoodbye\n" },
    { kind: "asst", text: "Done." }
  ])
  // The program is one call, and each function is a call under it.
  expect(calls(file).map((row) => [row.id, row.parent, row.fn, row.status])).toEqual([
    [1, null, "run", "done"],
    [2, 1, "write", "done"],
    [3, 1, "shell", "done"],
    [4, 1, "edit", "done"],
    [5, 1, "read", "done"]
  ])
  expect(calls(file)[4]).toMatchObject({ output: "goodbye\n", size: 8, shown: 8, pgid: null })
  expect(rows(file, "select status from turn")).toEqual([{ status: "done" }])
})

test("a program that fails gives the model its error, and the turn goes on", async () => {
  const file = newFile()
  const wire = model("const text = await read('missing.txt')\nreturn text", "return await zoom(0)")
  await launch(file, wire, say("read it"))
  expect(back(wire.sent[1])).toStartWith("Error: ENOENT: no such file or directory")
  expect(back(wire.sent[2])).toBe("0+0|user: read it")
  expect(calls(file).map((row) => [row.fn, row.status])).toEqual([["run", "failed"], ["read", "failed"], ["run", "done"], ["zoom", "done"]])
  expect(messages(file).map((message) => message.kind)).toEqual(["user", "tool", "echo", "tool", "echo", "asst"])
})

test("a long result: the model and the log get its head and tail, the database and a file keep it whole, and a program can get it", async () => {
  const file = newFile()
  const long = "return Array.from({ length: 1000 }, (_, k) => 'row ' + k).join('\\n')"
  const wire = model(long, "const whole = await result(1)\nreturn whole.split('\\n').filter((row) => row.endsWith('77')).join(' ')")
  await launch(file, wire, Effect.gen(function*() {
    yield* say("list the rows")
    const limit = yield* Limit
    const whole = Array.from({ length: 1000 }, (_, k) => "row " + k).join("\n")
    const seen = back(wire.sent[1])
    expect(seen.length).toBeLessThanOrEqual(2000)
    expect(seen).toStartWith("row 0\nrow 1\n")
    expect(seen).toEndWith("row 998\nrow 999")
    expect(seen).toContain("characters left out. The whole result is in the file " + limit.file(1) + ", and result(1) gives it to a program. ...]")
    // The memory holds what the model saw.
    expect(messages(file)[2]).toEqual({ kind: "echo", text: seen })
    // The database holds all of it, and says how much the model got.
    expect(calls(file)[0]).toMatchObject({ output: whole, size: whole.length, shown: Buffer.byteLength(seen) })
    expect(fs.readFileSync(limit.file(1), "utf8")).toBe(whole)
    // The next program got the whole text, and gave back a part of it.
    expect(back(wire.sent[2])).toBe("row 77 row 177 row 277 row 377 row 477 row 577 row 677 row 777 row 877 row 977")
  }))
})

test("the person's stop kills a running command, and the model reads later what the program did", async () => {
  const file = newFile()
  const cwd = path.dirname(file)
  const program = "await write('a.txt', 'A')\nawait shell('echo $$ > pid; exec sleep 60')\nawait write('b.txt', 'B')"
  const wire = model(program)
  await launch(file, wire, Effect.gen(function*() {
    const turns = yield* Turns
    yield* turns.say("work")
    yield* eventually(() => fs.existsSync(path.join(cwd, "pid")) && fs.readFileSync(path.join(cwd, "pid"), "utf8").trim() !== "")
    const pid = Number(fs.readFileSync(path.join(cwd, "pid"), "utf8"))
    expect(alive(pid)).toBe(true)
    expect(calls(file)[2]).toMatchObject({ fn: "shell", status: "running", pgid: pid })
    yield* turns.stop()
    yield* turns.idle
    yield* eventually(() => !alive(pid))
  }))
  expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false)
  expect(calls(file).map((row) => [row.fn, row.status, row.pgid])).toEqual([["run", "cut", null], ["write", "done", null], ["shell", "cut", null]])
  expect(calls(file)[2]!.output).toBe(FUNCTION_STOPPED)
  const echo = messages(file)[2]!
  expect(echo.kind).toBe("echo")
  expect(echo.text).toBe(
    STOPPED + "\nThe functions that it called (result(id) gives a whole result):\n" +
      "- call 2, write(\"a.txt\",\"A\") ended: --- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+A\n\\ No newline at end of file\n" +
      "- call 3, shell(\"echo $$ > pid; exec sleep 60\") was cut: it may or may not have finished."
  )
  expect(messages(file).map((message) => message.kind)).toEqual(["user", "tool", "echo", "note"])
  expect(rows(file, "select status from turn")).toEqual([{ status: "stopped" }])
})

test("a restart: the cut program is not run again, and the model is told which of its functions ended and which was cut", async () => {
  const file = newFile()
  const cwd = path.dirname(file)
  const program = "await write('a.txt', 'A')\nawait shell('echo $$ > pid; exec sleep 60')\nawait write('b.txt', 'B')"
  let pid = 0
  await launch(file, model(program), Effect.gen(function*() {
    yield* Turns.use((turns) => turns.say("work"))
    yield* eventually(() => fs.existsSync(path.join(cwd, "pid")) && fs.readFileSync(path.join(cwd, "pid"), "utf8").trim() !== "")
    pid = Number(fs.readFileSync(path.join(cwd, "pid"), "utf8"))
  }))
  // The launch ended with the program at work. No command of it is left.
  expect(alive(pid)).toBe(false)
  expect(rows(file, "select status from turn")).toEqual([{ status: "running" }])
  expect(calls(file)[0]).toMatchObject({ fn: "run", status: "running" })
  // A crash closes nothing: put the command's row back as a crash leaves it.
  write(file, "update call set status = 'running', output = null, size = null, shown = null, ended = null, pgid = ? where fn = 'shell'", [pid])
  const wire = model()
  await launch(file, wire, Turns.use((turns) => turns.idle))
  expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false)
  const told = CUT + "\nThe functions that it called (result(id) gives a whole result):\n" +
    "- call 2, write(\"a.txt\",\"A\") ended: --- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+A\n\\ No newline at end of file\n" +
    "- call 3, shell(\"echo $$ > pid; exec sleep 60\") was cut: it may or may not have finished."
  expect(wire.sent.length).toBe(1)
  expect(back(wire.sent[0])).toBe(told)
  expect(calls(file).map((row) => [row.fn, row.status, row.output, row.pgid])).toEqual([
    ["run", "cut", told, null],
    ["write", "done", "--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+A\n\\ No newline at end of file", null],
    ["shell", "cut", CUT_FUNCTION, null]
  ])
  expect(messages(file)).toEqual([
    { kind: "user", text: "work" },
    { kind: "tool", text: program },
    { kind: "echo", text: told },
    { kind: "asst", text: "Done." }
  ])
  expect(rows(file, "select status from turn")).toEqual([{ status: "done" }])
})

test("a program that ended before a restart is shown again as it was, shortened in the same way", async () => {
  const file = newFile()
  const long = "return 'x'.repeat(5000)"
  const stuck = model(long)
  // The first launch ends while the second request runs: the program's
  // result is in the database, and the turn has not kept it yet.
  const send = stuck.wire.send
  stuck.wire.send = (request) => (stuck.sent.length === 0 ? send(request) : (stuck.sent.push(request), Stream.never))
  await launch(file, stuck, Effect.gen(function*() {
    yield* Turns.use((turns) => turns.say("print"))
    yield* eventually(() => stuck.sent.length === 2)
  }))
  write(file, "delete from turn_item where kind = 'back'")
  const wire = model()
  await launch(file, wire, Turns.use((turns) => turns.idle))
  expect(wire.sent.length).toBe(1)
  expect(back(wire.sent[0])).toBe(back(stuck.sent[1]))
  expect(back(wire.sent[0]).length).toBeLessThanOrEqual(2000)
  expect(calls(file).map((row) => [row.fn, row.status])).toEqual([["run", "done"]])
})
