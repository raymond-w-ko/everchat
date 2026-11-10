// Tests with a real second process: a kill in the middle of an event, a
// start while another process has the file, and the store inside one
// compiled executable.

import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { LaunchLive, Store } from "../src/store.ts"
import { newFile, options, rows, withStore } from "./help.ts"

const CHILD = path.join(import.meta.dir, "child.ts")

// Starts the child and waits until it prints `ready`.
const start = async (mode: string, file: string) => {
  const child = Bun.spawn([process.execPath, CHILD, mode, file], { stdout: "pipe", stderr: "inherit" })
  const reader = child.stdout.getReader()
  let seen = ""
  while (!seen.includes("ready")) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`the child ended before it was ready: ${seen}`)
    seen += new TextDecoder().decode(value)
  }
  return child
}

const kill = async (child: Bun.Subprocess) => {
  child.kill("SIGKILL")
  await child.exited
}

test("a kill in the middle of an event leaves the event before it whole, and nothing of the cut one", async () => {
  const file = newFile()
  const child = await start("hang", file)
  await kill(child)

  const after = await withStore(file, Effect.gen(function*() {
    const store = yield* Store
    return {
      launch: store.launch.id,
      messages: yield* store.messages(0, yield* store.count),
      whole: yield* store.node(0, 0),
      half: yield* store.node(0, 1),
      next: yield* store.append([{ kind: "user", text: "after the crash" }])
    }
  }))
  expect(after.messages.map((m) => [m.i, m.text])).toEqual([[0, "whole"]])
  expect(Option.getOrUndefined(after.whole)?.text).toBe("user: whole")
  expect(Option.isNone(after.half)).toBe(true)
  // The id of the cut message is free again: the log has no gap.
  expect(after.next[0]?.i).toBe(1)
  expect(after.launch).toBe(2)
  expect(rows(file, "select id, pid, why from launch order by id")).toEqual([
    { id: 1, pid: child.pid, why: "crash" },
    { id: 2, pid: process.pid, why: "exit" }
  ])
})

test("a start while another process has the file stops, and a start after its death takes the file", async () => {
  const file = newFile()
  const child = await start("idle", file)
  try {
    const error = await Effect.runPromise(Effect.flip(Effect.void.pipe(Effect.provide(Store.layer(file, options())))))
    expect(error).toBeInstanceOf(LaunchLive)
    expect(error).toMatchObject({ pid: child.pid })
  } finally {
    await kill(child)
  }
  const launch = await withStore(file, Store.useSync((store) => store.launch.id))
  expect(launch).toBe(2)
  expect(rows(file, "select why from launch order by id")).toEqual([{ why: "crash" }, { why: "exit" }])
})

test("the store works inside one compiled executable, away from node_modules", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-compile-"))
  const exe = path.join(dir, "child")
  const build = Bun.spawnSync([process.execPath, "build", "--compile", CHILD, "--outfile", exe], {
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(build.exitCode, build.stderr.toString()).toBe(0)

  const file = path.join(dir, "home", "everchat.db")
  fs.mkdirSync(path.dirname(file))
  const run = () => Bun.spawnSync([exe, "count", file], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const first = run()
  expect(first.stderr.toString()).toBe("")
  expect(first.stdout.toString()).toBe("count 1\n")
  expect(run().stdout.toString()).toBe("count 2\n")
  expect(fs.readdirSync(path.dirname(file))).toEqual(["everchat.db"])
  expect(rows(file, "select count(*) as n from launch where why = 'exit'")).toEqual([{ n: 2 }])
}, 60_000)
