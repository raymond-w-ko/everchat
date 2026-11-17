// Tests of the config file (config.ts): what each field sets, the order of
// a flag and the file, and each fault with its path. Each case writes a
// file in a home of its own.

import { expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Exit } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ConfigFault, FILE, NONE, picks, read, type Settings, type StdioServer } from "./config.ts"

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "everchat-config-"))

// The home's file, from a value (written as JSON) or a text (written as it is).
const write = (value: unknown) => {
  const at = home()
  fs.writeFileSync(path.join(at, FILE), typeof value === "string" ? value : JSON.stringify(value))
  return at
}

const settle = (at: string, env: Record<string, string | undefined> = {}) =>
  Effect.runPromise(Effect.exit(read(at, env)).pipe(Effect.provide(BunServices.layer)))

const settings = async (at: string, env: Record<string, string | undefined> = {}): Promise<Settings> => {
  const exit = await settle(at, env)
  if (Exit.isFailure(exit)) throw new Error("the file was refused: " + JSON.stringify(exit.cause))
  return exit.value
}

// The fault's lines, each without the file's path.
const faults = async (at: string, env: Record<string, string | undefined> = {}): Promise<ReadonlyArray<string>> => {
  const exit = await settle(at, env)
  // Only the names: a value can be a replaced one, and no output holds that.
  if (Exit.isSuccess(exit)) throw new Error("the file was taken, with the fields " + JSON.stringify(Object.keys(exit.value)) + " and the servers " + JSON.stringify(exit.value.servers.map((one) => one.name)))
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  expect(error).toBeInstanceOf(ConfigFault)
  const fault = error as ConfigFault
  expect(fault.file).toBe(path.join(at, FILE))
  // The message: each fault on its own line, with the file's path.
  expect(fault.message).toBe(fault.faults.map((one) => path.join(at, FILE) + ": " + one).join("\n"))
  return fault.faults
}

const stdio = (name: string, rest: Partial<StdioServer> = {}): StdioServer => ({ kind: "stdio", name, approval: "auto", tools: {}, command: "server-" + name, args: [], env: {}, cwd: undefined, ...rest })

test("no file and the file {} give no setting", async () => {
  expect(await settings(home())).toEqual(NONE)
  expect(await settings(write({}))).toEqual(NONE)
  expect(NONE).toEqual({ model: undefined, effort: undefined, compactor: undefined, limit: undefined, servers: [] })
})

test("each field: the picks, the limit, and a server of each form with its approvals", async () => {
  const at = write({
    model: "gpt-file",
    effort: "high",
    compactor: "gpt-file-compactor",
    limit: 12_345,
    servers: {
      git: { command: "git-server", args: ["--root", "/w"], env: { LEVEL: "2" }, cwd: "/w", approval: "ask", tools: { push: "deny", log: "auto" } },
      docs: { url: "https://docs.example/mcp", headers: { Accept: "text/event-stream" } }
    }
  })
  const got = await settings(at)
  expect(got.model).toBe("gpt-file")
  expect(got.effort).toBe("high")
  expect(got.compactor).toBe("gpt-file-compactor")
  expect(got.limit).toBe(12_345)
  expect(got.servers.map((one) => ({ ...one, ...("env" in one ? { env: { ...one.env } } : { headers: { ...one.headers } }), tools: { ...one.tools } }))).toEqual([
    { kind: "http", name: "docs", approval: "auto", tools: {}, url: "https://docs.example/mcp", headers: { Accept: "text/event-stream" } },
    { kind: "stdio", name: "git", approval: "ask", tools: { push: "deny", log: "auto" }, command: "git-server", args: ["--root", "/w"], env: { LEVEL: "2" }, cwd: "/w" }
  ])
  // The bounds of the limit are in.
  expect((await settings(write({ limit: 2_000 }))).limit).toBe(2_000)
  expect((await settings(write({ limit: 1_000_000 }))).limit).toBe(1_000_000)
})

test("a flag wins over the file, and the file gives what no flag gives", () => {
  const file: Settings = { ...NONE, model: "gpt-file", effort: "high", compactor: "gpt-file-compactor" }
  expect(picks({ model: "gpt-flag", effort: "low", compactor: "gpt-flag-compactor" }, file)).toEqual({ model: "gpt-flag", effort: "low", compactor: "gpt-flag-compactor" })
  expect(picks({ model: "gpt-flag", effort: undefined, compactor: undefined }, file)).toEqual({ model: "gpt-flag", effort: "high", compactor: "gpt-file-compactor" })
  expect(picks({ model: undefined, effort: undefined, compactor: undefined }, file)).toEqual({ model: "gpt-file", effort: "high", compactor: "gpt-file-compactor" })
  expect(picks({ model: undefined, effort: undefined, compactor: undefined }, NONE)).toEqual({ model: undefined, effort: undefined, compactor: undefined })
})

test("a fault: a file that is not JSON", async () => {
  expect(await faults(write("{ \"model\": \"gpt\", }"))).toEqual(["Expected JSON"])
  expect(await faults(write(""))).toEqual(["Expected JSON"])
})

test("a fault: a file that is not one object", async () => {
  for (const value of [[], [{}], "\"text\"", "null", "3"]) {
    expect(await faults(write(typeof value === "string" ? value : JSON.stringify(value)))).toEqual(["Expected object"])
  }
})

test("a fault: a file that cannot be read", async () => {
  const at = home()
  fs.mkdirSync(path.join(at, FILE))
  expect(await faults(at)).toEqual(["cannot be read (BadResource)"])
})

test("a fault: an unknown field at the top, and inside a server", async () => {
  expect(await faults(write({ model: "gpt", name: "me" }))).toEqual(["name: Unknown field"])
  expect(await faults(write({ servers: { git: { command: "git-server", timeout: 5 } } }))).toEqual(["servers.git.timeout: Unknown field"])
  expect(await faults(write({ servers: { git: { command: "git-server", tools: { push: "deny" }, env: { A: "1" } } }, rules: "x" }))).toEqual(["rules: Unknown field"])
})

test("a fault: a field of a wrong type, at each depth, all of them", async () => {
  expect(await faults(write({ model: 5, effort: ["high"], compactor: null, limit: "30000", servers: [] }))).toEqual([
    "model: Expected string",
    "effort: Expected string",
    "compactor: Expected string",
    "limit: Expected number",
    "servers: Expected object"
  ])
  expect(await faults(write({ servers: { git: { command: "git-server", args: ["a", 2], env: { A: 1 }, cwd: false } } }))).toEqual([
    "servers.git.args[1]: Expected string",
    "servers.git.env.A: Expected string",
    "servers.git.cwd: Expected string"
  ])
  expect(await faults(write({ servers: { docs: { url: "https://docs.example", headers: { "X-Key": true } } } }))).toEqual([
    "servers.docs.headers[\"X-Key\"]: Expected string"
  ])
})

test("a fault: a limit out of its bounds, or not a whole number", async () => {
  for (const limit of [1_999, 1_000_001, 0, -5]) {
    expect(await faults(write({ limit }))).toEqual(["limit: Expected a whole number from 2000 to 1000000"])
  }
  expect(await faults(write({ limit: 2_000.5 }))).toEqual(["limit: Expected an integer"])
})

test("a fault: 17 servers; 16 are taken", async () => {
  const servers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["s" + String(i).padStart(2, "0"), { command: "c" }]))
  expect(await faults(write({ servers: servers(17) }))).toEqual(["servers: Expected at most 16 servers"])
  expect((await settings(write({ servers: servers(16) }))).servers.length).toBe(16)
})

test("a fault: a server's name that is no identifier; an identifier is taken", async () => {
  const WHY = "Expected a name that is an identifier (letters, digits, _ and $, not first a digit)"
  expect(await faults(write({ servers: { "my-git": { command: "c" }, "2nd": { command: "c" }, "": { command: "c" }, ok: { command: "c" } } }))).toEqual([
    "servers[\"my-git\"]: " + WHY,
    "servers[\"2nd\"]: " + WHY,
    "servers[\"\"]: " + WHY
  ])
  const names = (await settings(write({ servers: { _a: { command: "c" }, $b: { command: "c" }, C9: { command: "c" } } }))).servers.map((one) => one.name)
  expect(names).toEqual(["$b", "C9", "_a"])
})

test("a fault: a server with command and url, and one with neither", async () => {
  expect(await faults(write({ servers: { both: { command: "c", url: "https://a.example" } } }))).toEqual(["servers.both.url: Expected command or url, not both"])
  expect(await faults(write({ servers: { none: { approval: "ask" } } }))).toEqual([
    "servers.none: Expected command (a program on stdio) or url (a server over HTTP)"
  ])
  // The fields of the other form.
  expect(await faults(write({ servers: { web: { url: "https://a.example", args: [], env: {}, cwd: "/" }, cli: { command: "c", headers: {} } } }))).toEqual([
    "servers.web.args: Expected only with command",
    "servers.web.env: Expected only with command",
    "servers.web.cwd: Expected only with command",
    "servers.cli.headers: Expected only with url"
  ])
})

test("a fault: an approval that is none of the three words, for the server and for a tool", async () => {
  expect(await faults(write({ servers: { git: { command: "c", approval: "yes", tools: { push: "never", log: "ask" } } } }))).toEqual([
    "servers.git.approval: Expected \"auto\" | \"ask\" | \"deny\"",
    "servers.git.tools.push: Expected \"auto\" | \"ask\" | \"deny\""
  ])
})

test("a fault: an unset variable, with the field and the variable's name; a variable set to the empty text is set", async () => {
  const at = write({ servers: { git: { command: "c", args: ["--token=${TOKEN}", "${OTHER}${TOKEN}"] }, web: { url: "https://${HOST}/mcp" } } })
  expect(await faults(at, { OTHER: "o" })).toEqual([
    "servers.git.args[0]: the variable TOKEN is not set",
    "servers.git.args[1]: the variable TOKEN is not set",
    "servers.web.url: the variable HOST is not set"
  ])
  const got = await settings(at, { TOKEN: "", OTHER: "o", HOST: "h.example" })
  expect(got.servers).toEqual([stdio("git", { command: "c", args: ["--token=", "o"] }), { kind: "http", name: "web", approval: "auto", tools: {}, url: "https://h.example/mcp", headers: {} }])
})

test("${VAR} is replaced in each of the four places, one time, and no other form is", async () => {
  const at = write({
    servers: {
      git: { command: "${CMD}", args: ["a=${A}", "$A", "${A", "$${A}", "${1A}", "${A}${A}"], env: { KEY: "${KEY}", PLAIN: "${A}-x" }, cwd: "${A}" },
      web: { url: "${SCHEME}://h.example/${PATH_PART}", headers: { Authorization: "Bearer ${KEY}" } }
    }
  })
  const got = await settings(at, { A: "1", KEY: "k-${A}", SCHEME: "https", PATH_PART: "mcp", CMD: "never" })
  const [git, web] = got.servers
  expect(git?.kind === "stdio" && { command: git.command, args: git.args, env: { ...git.env }, cwd: git.cwd }).toEqual({
    // Only the four places: not the command, not the directory.
    command: "${CMD}",
    args: ["a=1", "$A", "${A", "$1", "${1A}", "11"],
    // A value is not read again for a `${...}` of its own.
    env: { KEY: "k-${A}", PLAIN: "1-x" },
    cwd: "${A}"
  })
  expect(web?.kind === "http" && { url: web.url, headers: { ...web.headers } }).toEqual({ url: "https://h.example/mcp", headers: { Authorization: "Bearer k-${A}" } })
})

test("a fault: an address that is not http: or https:, after the replacement", async () => {
  for (const url of ["file:///etc/passwd", "ftp://a.example", "not an address", "${S}://a.example"]) {
    expect(await faults(write({ servers: { web: { url } } }), { S: "javascript" })).toEqual(["servers.web.url: Expected an http: or https: address"])
  }
  expect((await settings(write({ servers: { web: { url: "${S}://a.example" } } }), { S: "http" })).servers[0]).toMatchObject({ url: "http://a.example" })
})

test("no fault holds a replaced value or a value of the file", async () => {
  const MARKER = "marker-6b1f-secret"
  const env = { SECRET: MARKER }
  const cases: ReadonlyArray<unknown> = [
    // A fault in another field, next to a replaced value in each place.
    { limit: 5, servers: { git: { command: "c", args: ["${SECRET}"], env: { K: "${SECRET}" } }, web: { url: "https://h.example", headers: { A: "${SECRET}" } } } },
    { servers: { git: { command: "c", args: ["${SECRET}"], env: { K: "${SECRET}" } }, web: { url: "${SECRET}" } } },
    { servers: { git: { command: "c", args: ["${SECRET}", "${UNSET}"] } } },
    // The marker in the file itself, where a fault is.
    { model: 5, effort: MARKER, servers: { git: { command: MARKER, approval: MARKER, timeout: MARKER } } },
    { limit: MARKER },
    "{ \"model\": \"" + MARKER + "\" ",
    "[\"" + MARKER + "\"]"
  ]
  for (const value of cases) {
    const exit = await settle(write(value), env)
    expect(Exit.isFailure(exit)).toBe(true)
    const said = Exit.isFailure(exit) ? JSON.stringify(exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? { ...reason.error, message: (reason.error as Error).message } : reason))) : ""
    expect(said.length).toBeGreaterThan(0)
    expect(said).not.toContain(MARKER)
  }
})

test("the servers come sorted by name", async () => {
  const at = write({ servers: { zeta: { command: "c" }, Alpha: { command: "c" }, beta: { url: "https://b.example" }, _under: { command: "c" }, alpha: { command: "c" } } })
  expect((await settings(at)).servers.map((one) => one.name)).toEqual(["Alpha", "_under", "alpha", "beta", "zeta"])
})

test("a key such as __proto__ is a key, in the servers, a server's texts and its tools", async () => {
  const at = write("{\"servers\": {\"__proto__\": {\"command\": \"c\", \"env\": {\"__proto__\": \"${A}\"}, \"tools\": {\"__proto__\": \"deny\"}}}}")
  const [server] = (await settings(at, { A: "v" })).servers
  expect(server?.name).toBe("__proto__")
  expect(server?.kind === "stdio" && Object.entries(server.env)).toEqual([["__proto__", "v"]])
  expect(server && Object.entries(server.tools)).toEqual([["__proto__", "deny"]])
})
