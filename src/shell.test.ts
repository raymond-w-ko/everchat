// Tests of the shell function, with real commands: its result, its three
// limits, a stop, and the processes that it must not leave behind.

import { expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { newFile, options, write } from "../tests/help.ts"
import { Shell, sweep, TAG } from "./shell.ts"
import { Store } from "./store.ts"

const withShell = <A, E>(
  file: string,
  effect: Effect.Effect<A, E, Shell | Store>,
  over: { hard?: number; runTag?: string } = {}
) => {
  const store = Store.layer(file, options({ runTag: over.runTag ?? "tag-" + crypto.randomUUID() }))
  const shell = Shell.layer({ cwd: path.dirname(file), shell: "/bin/sh", hard: over.hard }).pipe(Layer.provideMerge(store))
  return Effect.runPromise(effect.pipe(Effect.provide(shell)))
}

const run = (command: string, seconds?: number) => Shell.use((shell) => shell.run(command, { seconds }))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    // A process that was killed and not yet collected still has an id.
    return !fs.readFileSync("/proc/" + pid + "/stat", "utf8").includes(") Z ")
  } catch {
    return false
  }
}

const eventually = async (check: () => boolean) => {
  for (let k = 0; k < 400 && !check(); k++) {
    await Bun.sleep(5)
  }
  return check()
}

test("a command gives its output, stdout and stderr as one, then how it ended", async () => {
  const file = newFile()
  await withShell(file, Effect.gen(function*() {
    expect(yield* run("echo out; echo err >&2")).toMatch(/^out\nerr\n\(exit 0 in \d+\.\d s\)$/)
    expect(yield* run("true")).toMatch(/^\(exit 0 in \d+\.\d s\)$/)
    // A command that fails is a result, with its exit code.
    expect(yield* run("echo no; exit 3")).toMatch(/^no\n\(exit 3 in \d+\.\d s\)$/)
    expect(yield* run("kill -TERM $$")).toMatch(/^\(killed by SIGTERM in \d+\.\d s\)$/)
    // It runs in the work directory, with no stdin.
    expect(yield* run("pwd")).toStartWith(fs.realpathSync(path.dirname(file)) + "\n")
    expect(yield* run("cat; echo done")).toStartWith("done\n")
  }))
})

test("a character that comes in two reads stays whole", async () => {
  const file = newFile()
  await withShell(file, Effect.gen(function*() {
    expect(yield* run("printf 'a\\303'; sleep 0.1; printf '\\251b'")).toStartWith("aéb\n(exit 0")
  }))
})

test("a command does not get the gateway's address and key, and it carries the run tag", async () => {
  const file = newFile()
  process.env.EVERCHAT_GATEWAY_KEY = "secret-key"
  process.env.EVERCHAT_GATEWAY_URL = "http://secret"
  try {
    await withShell(file, Effect.gen(function*() {
      const out = yield* run("env")
      expect(out).not.toContain("secret")
      expect(out).toContain(TAG + "=the-tag\n")
      expect(out).toContain("PATH=")
    }), { runTag: "the-tag" })
  } finally {
    delete process.env.EVERCHAT_GATEWAY_KEY
    delete process.env.EVERCHAT_GATEWAY_URL
  }
})

test("the time limit stops a command, and the result says how to give more time", async () => {
  const file = newFile()
  await withShell(file, Effect.gen(function*() {
    const started = performance.now()
    const out = yield* run("echo before; sleep 30; echo after", 0.2)
    expect(out).toBe("before\n(stopped after 0.2 s, the time limit: give more seconds as the second argument)")
    expect(performance.now() - started).toBeLessThan(5000)
  }))
})

test("the hard limit ends the output there and stops the command", async () => {
  const file = newFile()
  await withShell(file, Effect.gen(function*() {
    const started = performance.now()
    const out = yield* run("yes 0123456789")
    expect(out.endsWith("\n(stopped: the output passed 4096 bytes, the most that a call may give)")).toBe(true)
    expect(Buffer.byteLength(out.slice(0, out.lastIndexOf("\n(stopped")))).toBeLessThanOrEqual(4096)
    expect(out.length).toBeGreaterThan(4000)
    expect(performance.now() - started).toBeLessThan(5000)
  }), { hard: 4096 })
})

test("a stop kills the command and what it started, and the call's process group is told first", async () => {
  const file = newFile()
  const pidFile = path.join(path.dirname(file), "pid")
  let pgid = 0
  await withShell(file, Effect.gen(function*() {
    const shell = yield* Shell
    const fiber = yield* Effect.forkChild(
      shell.run("sleep 60 & echo $! > pid; wait", { started: (id) => Effect.sync(() => (pgid = id)) })
    )
    yield* Effect.promise(() => eventually(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== ""))
    const child = Number(fs.readFileSync(pidFile, "utf8"))
    expect(pgid).toBeGreaterThan(0)
    expect(alive(child)).toBe(true)
    yield* Fiber.interrupt(fiber)
    expect(yield* Effect.promise(() => eventually(() => !alive(child)))).toBe(true)
    expect(alive(pgid)).toBe(false)
  }))
})

test("a background job with its own output file lives on while EverChat runs, and dies when it ends", async () => {
  const file = newFile()
  const pidFile = path.join(path.dirname(file), "pid")
  let child = 0
  await withShell(file, Effect.gen(function*() {
    // The call returns at once: nothing holds its output.
    const out = yield* run("sleep 60 > /dev/null 2>&1 & echo $! > pid; echo started")
    expect(out).toStartWith("started\n(exit 0")
    child = Number(fs.readFileSync(pidFile, "utf8"))
    expect(alive(child)).toBe(true)
  }))
  expect(await eventually(() => !alive(child))).toBe(true)
})

test("the end of the program kills a process that left its group, by its run tag", async () => {
  const file = newFile()
  const pidFile = path.join(path.dirname(file), "pid")
  let child = 0
  await withShell(file, Effect.gen(function*() {
    // setsid puts the job in a new session: no kill of the group reaches it.
    let pgid = 0
    yield* Shell.use((shell) =>
      shell.run("setsid sh -c 'echo $$ > pid; exec sleep 60' > /dev/null 2>&1 & while [ ! -s pid ]; do sleep 0.01; done", {
        started: (id) => Effect.sync(() => (pgid = id))
      })
    )
    child = Number(fs.readFileSync(pidFile, "utf8"))
    expect(alive(child)).toBe(true)
    // It is in a process group of its own, not in the command's.
    const group = Number(fs.readFileSync("/proc/" + child + "/stat", "utf8").split(") ")[1]!.split(" ")[2])
    expect(group).toBe(child)
    expect(group).not.toBe(pgid)
  }))
  expect(await eventually(() => !alive(child))).toBe(true)
})

test("a launch kills what a crashed launch left behind, and nothing else", async () => {
  const file = newFile()
  const [crashed, other] = ["crashed-" + crypto.randomUUID(), "other-" + crypto.randomUUID()]
  // A database with one launch that ended, as a crash leaves it.
  await withShell(file, Effect.void, { runTag: "first" })
  write(file, "update launch set run_tag = ?", [crashed])
  const spawn = (tag: string) => Bun.spawn(["sleep", "60"], { env: { ...process.env, [TAG]: tag }, stdout: "ignore", stderr: "ignore" })
  const [left, bystander] = [spawn(crashed), spawn(other)]
  try {
    await withShell(file, Effect.void)
    await left.exited
    expect(left.signalCode).toBe("SIGKILL")
    expect(bystander.exitCode).toBe(null)
    expect(bystander.signalCode).toBe(null)
    // With no tag, nothing is killed.
    expect(await Effect.runPromise(sweep(new Set()))).toBe(0)
  } finally {
    bystander.kill("SIGKILL")
    left.kill("SIGKILL")
  }
})
