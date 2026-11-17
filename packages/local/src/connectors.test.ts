// The connectors (connectors.ts): the config's servers as the client's,
// with real children. The programs that the cases start are the
// repository's example server (tools/mcpexample.ts), on stdio and over HTTP
// on 127.0.0.1, and a script of the test's own directory that reads its
// input and never answers. Each child that a load starts has a mark in its
// arguments (Bun's `--conditions=<mark>`, a name of a condition of imports
// that nothing uses), so the process list shows whether one is left. The
// child's environment, work directory and standard error are read from
// /proc (Linux), as shell.test.ts does. Each load carries this file's run
// tag (RUN), and registers its sweep before the load, as main.ts does.

import { afterAll, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HOSTED } from "@everchat/core/functions"
import { load, type Loaded } from "@everchat/mcp"
import { Effect, Exit, Logger, Scope } from "effect"
import type { HttpServer, Server as Configured, StdioServer } from "./config.ts"
import { connectors, swept } from "./connectors.ts"
import { TAG } from "./shell.ts"

const EXAMPLE = path.join(import.meta.dir, "../../../tools/mcpexample.ts")
const MARK = "everchat-connectors-" + crypto.randomUUID()
const RUN = crypto.randomUUID()
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-connectors-")))
afterAll(() => {
  killMarked()
  fs.rmSync(dir, { recursive: true, force: true })
})

// A program that reads its input and never answers. It writes its pid to
// `quiet.pids` when it starts, and ends when its input does. The client
// bounds a server's close by the load's limit, so its limit here leaves the
// child time to start and to end under load.
const QUIET = path.join(dir, "quiet.ts")
const PIDS = path.join(dir, "quiet.pids")
fs.writeFileSync(
  QUIET,
  `require("node:fs").appendFileSync(${JSON.stringify(PIDS)}, process.pid + "\\n")
process.stdin.on("data", () => {})
process.stdin.on("end", () => process.exit(0))
setInterval(() => {}, 1 << 30)
`
)

// A server that starts a helper: it starts HELPER (no standard streams, not
// waited for), then runs the example as its own child on its standard
// streams, and when the example has ended (at the end of its input) writes
// its pid to `ended.pids`.
const HELPER = path.join(dir, "helper.ts")
const HELPERS = path.join(dir, "helper.pids")
const ENDED = path.join(dir, "ended.pids")
const WRAPPER = path.join(dir, "wrapper.ts")
fs.writeFileSync(HELPER, `require("node:fs").appendFileSync(${JSON.stringify(HELPERS)}, process.pid + "\\n")\nsetInterval(() => {}, 1 << 30)\n`)
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
// of its input nor SIGTERM. It writes its pid to `stubborn.pids`.
const STUBBORN = path.join(dir, "stubborn.ts")
const STUBBORNS = path.join(dir, "stubborn.pids")
fs.writeFileSync(
  STUBBORN,
  `require("node:fs").appendFileSync(${JSON.stringify(STUBBORNS)}, process.pid + "\\n")
process.on("SIGTERM", () => {})
process.stdin.on("data", () => {})
process.stdin.on("end", () => {})
setInterval(() => {}, 1 << 30)
`
)

// The pids in a file of pids, or none.
const pidsIn = (file: string): ReadonlyArray<number> =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter((one) => one !== "").map(Number) : []

// A program on stdio, run by this Bun with the mark.
const stdio = (name: string, script: string, more: Partial<StdioServer> = {}): StdioServer => ({
  kind: "stdio",
  name,
  approval: "auto",
  tools: {},
  command: process.execPath,
  args: ["--conditions=" + MARK, script],
  env: {},
  cwd: undefined,
  ...more
})

// The processes whose arguments hold the mark: their pids, or their lines
// (`<pid> <args>`).
const markedLines = (): ReadonlyArray<string> =>
  Bun.spawnSync(["ps", "-eo", "pid=,args="]).stdout.toString().split("\n").filter((line) => line.includes(MARK)).map((line) => line.trim())
const marked = (): ReadonlyArray<number> => markedLines().map((line) => Number(line.split(" ")[0]))

// Kills each marked process: a red case leaves none.
const killMarked = () => {
  for (const pid of marked()) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

// A process's environment, from /proc.
const environOf = (pid: number): Record<string, string> =>
  Object.fromEntries(
    fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((one) => one !== "").map((one) => {
      const at = one.indexOf("=")
      return [one.slice(0, at), one.slice(at + 1)]
    })
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

// The pids of `pids` that still run after a short wait, and the marked
// processes then: a SIGKILL takes effect when the process next runs, not at
// the call. 300 ms is far under the SDK's own steps (1 s to 4 s).
const left = async (pids: ReadonlyArray<number> = []) => {
  for (let k = 0; k < 30 && (pids.some(alive) || marked().length > 0); k++) await Bun.sleep(10)
  return { pids: pids.filter(alive), marked: marked() }
}

// The time that the last scope's close of `loaded` took, in ms.
let closing = 0

// A load of `configured` in a scope of its own, with the sweep of RUN
// registered before it; `inside` runs before the scope closes. The load's
// work directory is the test's directory.
const loaded = async (
  configured: ReadonlyArray<Configured>,
  inside: (got: Loaded) => Promise<void> = async () => {},
  limit = 10_000
) => {
  const scope = await Effect.runPromise(Scope.make())
  try {
    const got = await Effect.runPromise(
      Effect.gen(function*() {
        yield* swept(RUN)
        return yield* load(connectors(configured, dir, RUN), { beside: HOSTED, load: limit })
      }).pipe(Scope.provide(scope), Effect.provide(Logger.layer([])))
    )
    await inside(got)
    return got
  } finally {
    const started = performance.now()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    closing = performance.now() - started
  }
}

const names = (got: Loaded) => got.declarations.map((one) => one.name)

// `example.add` with a + b.
const add = (got: Loaded, a: number, b: number) =>
  Effect.runPromise(got.entries.find((one) => one.tool === "add")!.run([{ a, b }], { turn: 1, program: 1, call: 1 }))

// The cases
// ---------

test("the servers come sorted by name, with their settings", () => {
  const given = connectors([
    stdio("zeta", EXAMPLE, { approval: "ask" }),
    { kind: "http", name: "alpha", approval: "auto", tools: { send: "deny" }, url: "http://127.0.0.1:1/mcp", headers: {} }
  ], dir, RUN)
  expect(given.map((one) => [one.name, one.approval, one.tools])).toEqual([["alpha", "auto", { send: "deny" }], ["zeta", "ask", {}]])
})

test("the example on stdio: example.add and example.send, and example.add with { a: 2, b: 3 } gives { sum: 5 }; no child is left", async () => {
  const got = await loaded([stdio("example", EXAMPLE)], async (got) => {
    expect(marked().length).toBe(1)
    expect(await add(got, 2, 3)).toEqual({ sum: 5 })
  })
  expect(names(got)).toEqual(["example.add", "example.send"])
  expect(got.refused).toEqual([])
  expect(marked()).toEqual([])
})

test("the example over HTTP (--port 0, its address from its first line): the same", async () => {
  const child = Bun.spawn([process.execPath, EXAMPLE, "--port", "0"], { stdout: "pipe", stderr: "ignore" })
  try {
    const reader = child.stdout.getReader()
    let text = ""
    while (!text.includes("\n")) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    reader.releaseLock()
    const url = text.split("\n")[0]!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const web: HttpServer = { kind: "http", name: "web", approval: "auto", tools: {}, url, headers: { "x-everchat-test": "1" } }
    const got = await loaded([web], async (got) => {
      expect(await add(got, 2, 3)).toEqual({ sum: 5 })
    })
    expect(names(got)).toEqual(["web.add", "web.send"])
    expect(got.refused).toEqual([])
  } finally {
    child.kill("SIGTERM")
    await child.exited
  }
})

test("a server whose program does not exist: no function, a refusal, and the other server loads; no child is left", async () => {
  const missing = path.join(dir, "no-such-program-" + MARK)
  const got = await loaded([stdio("example", EXAMPLE), { ...stdio("missing", EXAMPLE), command: missing, args: [] }])
  expect(names(got)).toEqual(["example.add", "example.send"])
  expect(got.refused).toEqual([{ server: "missing", reason: "It did not connect." }])
  expect(JSON.stringify(got.refused)).not.toContain(missing)
  expect(marked()).toEqual([])
})

test("a program that reads its input and never answers: given up after the limit; no child is left", async () => {
  fs.rmSync(PIDS, { force: true })
  const started = Date.now()
  const got = await loaded([stdio("quiet", QUIET)], async () => {}, 2_000)
  const took = Date.now() - started
  expect(took).toBeGreaterThanOrEqual(1_990)
  expect(took).toBeLessThan(10_000)
  expect(names(got)).toEqual([])
  expect(got.refused).toEqual([{ server: "quiet", reason: "It did not load in 2000 ms." }])
  const pids = fs.readFileSync(PIDS, "utf8").trim().split("\n").map(Number)
  expect(pids.length).toBeGreaterThan(0)
  expect(pids.filter(alive)).toEqual([])
  expect(marked()).toEqual([])
})

test("the three together, in one load: the example loads; after the scope's end no child is left", async () => {
  fs.rmSync(PIDS, { force: true })
  const missing = path.join(dir, "no-such-program-" + MARK)
  const got = await loaded(
    [stdio("quiet", QUIET), stdio("example", EXAMPLE), { ...stdio("missing", EXAMPLE), command: missing, args: [] }],
    async () => {
      // The example's own process serves, alive. The refused `quiet` (and
      // the SDK's probe of it) may still run inside the scope: its close
      // started at once, and the load did not wait for it (K4 of ec-bts5o).
      const examples = markedLines().filter((line) => line.endsWith(EXAMPLE)).map((line) => Number(line.split(" ")[0]))
      expect(examples.length).toBe(1)
      expect(alive(examples[0]!)).toBe(true)
    },
    3_000
  )
  expect(names(got)).toEqual(["example.add", "example.send"])
  expect(got.refused.map((one) => one.server)).toEqual(["missing", "quiet"])
  expect(fs.readFileSync(PIDS, "utf8").trim().split("\n").map(Number).filter(alive)).toEqual([])
  expect(marked()).toEqual([])
})

test("the child has the server's env, the SDK's short list, the run tag, its work directory, no standard error, and no variable that only the test's process has", async () => {
  const only = "EVERCHAT_CONNECTORS_TEST_ONLY"
  process.env[only] = "only-the-test-" + MARK
  try {
    const server = stdio("example", EXAMPLE, { env: { EVERCHAT_GIVEN: "given-" + MARK } })
    await loaded([server], async () => {
      const pids = marked()
      expect(pids.length).toBe(1)
      const pid = pids[0]!
      const env = environOf(pid)
      expect(env.EVERCHAT_GIVEN).toBe("given-" + MARK)
      expect(env[only]).toBeUndefined()
      expect(env.PATH).toBe(process.env.PATH!)
      expect(env[TAG]).toBe(RUN)
      expect(Object.keys(env).filter((key) => !["EVERCHAT_GIVEN", TAG, "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"].includes(key))).toEqual([])
      expect(fs.readlinkSync(`/proc/${pid}/cwd`)).toBe(dir)
      expect(fs.readlinkSync(`/proc/${pid}/fd/2`)).toBe("/dev/null")
    })
  } finally {
    delete process.env[only]
  }
  expect(marked()).toEqual([])
})

test("a relative cwd is from the launch's work directory", async () => {
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true })
  await loaded([stdio("example", EXAMPLE, { cwd: "sub" })], async () => {
    expect(fs.readlinkSync(`/proc/${marked()[0]!}/cwd`)).toBe(path.join(dir, "sub"))
  })
})

test("deny leaves a tool out", async () => {
  const got = await loaded([stdio("example", EXAMPLE, { tools: { send: "deny" } })])
  expect(names(got)).toEqual(["example.add"])
  expect(got.refused).toEqual([])
  expect(marked()).toEqual([])
})

test("a config's env that names the tag's variable does not replace the launch's tag", async () => {
  await loaded([stdio("example", EXAMPLE, { env: { [TAG]: "from-the-config-" + MARK } })], async () => {
    const pids = marked()
    expect(pids.length).toBe(1)
    expect(environOf(pids[0]!)[TAG]).toBe(RUN)
  })
  expect(marked()).toEqual([])
})

// The SDK starts each program twice for a load: its probe of the version
// (`server/discover`) runs on a process of its own, which it then ends. So
// a load of WRAPPER starts two helpers, and the cases find the server that
// serves by the one wrapper that is alive inside the scope.
test("a server that starts a helper: its functions load and a call answers; right after the scope's end the server and the helper are gone, and the server heard the end of its input first", async () => {
  fs.rmSync(HELPERS, { force: true })
  fs.rmSync(ENDED, { force: true })
  try {
    let wrapper = 0
    const got = await loaded([stdio("helped", WRAPPER)], async (got) => {
      expect(await add(got, 2, 3)).toEqual({ sum: 5 })
      for (let k = 0; k < 500 && pidsIn(HELPERS).filter(alive).length === 0; k++) await Bun.sleep(10)
      expect(pidsIn(HELPERS).filter(alive).length).toBeGreaterThan(0)
      const wrappers = markedLines().filter((line) => line.endsWith(WRAPPER)).map((line) => Number(line.split(" ")[0])).filter(alive)
      expect(wrappers.length).toBe(1)
      wrapper = wrappers[0]!
    })
    expect(names(got)).toEqual(["helped.add", "helped.send"])
    expect(got.refused).toEqual([])
    const helpers = pidsIn(HELPERS)
    expect(helpers.length).toBeGreaterThan(0)
    expect(await left(helpers)).toEqual({ pids: [], marked: [] })
    // The client's close came first: the server saw its input end.
    expect(pidsIn(ENDED)).toContain(wrapper)
  } finally {
    killMarked()
  }
})

test("a helper behind sh -c: right after the scope's end it is gone", async () => {
  fs.rmSync(HELPERS, { force: true })
  const bun = JSON.stringify(process.execPath)
  const line = `${bun} --conditions=${MARK} ${JSON.stringify(HELPER)} </dev/null >/dev/null 2>&1 & exec ${bun} --conditions=${MARK} ${JSON.stringify(EXAMPLE)}`
  try {
    const got = await loaded([{ ...stdio("shell", EXAMPLE), command: "/bin/sh", args: ["-c", line] }], async () => {
      for (let k = 0; k < 500 && pidsIn(HELPERS).filter(alive).length === 0; k++) await Bun.sleep(10)
      expect(pidsIn(HELPERS).filter(alive).length).toBeGreaterThan(0)
    })
    expect(names(got)).toEqual(["shell.add", "shell.send"])
    expect(await left(pidsIn(HELPERS))).toEqual({ pids: [], marked: [] })
  } finally {
    killMarked()
  }
})

test("a server that never answers and hears neither the end of its input nor SIGTERM: refused after the limit; right after the scope's end it is gone, with no wait for the SDK's timers", async () => {
  fs.rmSync(STUBBORNS, { force: true })
  try {
    const got = await loaded([stdio("stubborn", STUBBORN)], async () => {}, 2_000)
    expect(got.refused).toEqual([{ server: "stubborn", reason: "It did not load in 2000 ms." }])
    const pids = pidsIn(STUBBORNS)
    expect(pids.length).toBeGreaterThan(0)
    expect(await left(pids)).toEqual({ pids: [], marked: [] })
    expect(closing).toBeLessThan(1_000)
  } finally {
    killMarked()
  }
})
