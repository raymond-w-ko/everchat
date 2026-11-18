// Tests of the config file (config.ts): what each field sets, the order of
// a flag and the file, and each fault with its path. Each case writes a
// file in a home of its own.

import { expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Exit, FileSystem, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ConfigFault, FILE, NONE, picks, read, RULES_IO, RULES_MAX, rulesOf, type RulesIo, type Settings, type StdioServer } from "./config.ts"
import { KEY_VARIABLE } from "./gateway.ts"

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
  expect(Object.entries(NONE)).toEqual([["model", undefined], ["effort", undefined], ["compactor", undefined], ["limit", undefined], ["servers", []], ["name", undefined], ["rules", undefined]])
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

test("a fault: a link to no file; a link to a file is read, and no file is the defaults", async () => {
  const at = home()
  fs.symlinkSync(path.join(at, "gone.json"), path.join(at, FILE))
  expect(await faults(at)).toEqual(["a link to no file"])
  // The same link, once its target exists, is followed.
  fs.writeFileSync(path.join(at, "gone.json"), JSON.stringify({ model: "gpt-linked" }))
  expect((await settings(at)).model).toBe("gpt-linked")
  // A home that does not exist has no file.
  expect(await settings(path.join(home(), "none"))).toEqual(NONE)
})

test("a fault: an unknown field at the top, and inside a server", async () => {
  expect(await faults(write({ model: "gpt", nick: "me" }))).toEqual(["nick: Unknown field"])
  expect(await faults(write({ servers: { git: { command: "git-server", timeout: 5 } } }))).toEqual(["servers.git.timeout: Unknown field"])
  expect(await faults(write({ servers: { git: { command: "git-server", tools: { push: "deny" }, env: { A: "1" } } }, prompt: "x" }))).toEqual(["prompt: Unknown field"])
  // The two fields of the system prompt are known, and a field beside them is not.
  expect(await faults(write({ name: "Ada", rules: "AGENTS.md", system: "x" }))).toEqual(["system: Unknown field"])
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

test("a fault: a variable that the environment only inherits, such as ${toString}, is not set", async () => {
  const at = write({ servers: { git: { command: "c", args: ["${toString}", "${INHERITED}"] } } })
  // A plain object inherits `toString`; this one inherits `INHERITED` too.
  const env: Record<string, string | undefined> = Object.create({ INHERITED: "from-the-prototype" })
  expect("toString" in env && "INHERITED" in env).toBe(true)
  expect(await faults(at, env)).toEqual([
    "servers.git.args[0]: the variable toString is not set",
    "servers.git.args[1]: the variable INHERITED is not set"
  ])
  expect(await faults(at, {})).toEqual([
    "servers.git.args[0]: the variable toString is not set",
    "servers.git.args[1]: the variable INHERITED is not set"
  ])
})

test("a fault: the gateway's key as a variable, set and unset, in each of the four places; never replaced", async () => {
  const KEY = "${" + KEY_VARIABLE + "}"
  const WHY = `the variable ${KEY_VARIABLE} is the key of the author's inference gateway, which is not given to a server`
  const MARKER = "marker-gateway-key-4c2e"
  const at = write({
    servers: {
      git: { command: "c", args: ["--token=" + KEY, KEY + KEY], env: { TOKEN: KEY, OTHER: "${A}" } },
      web: { url: "https://h.example/" + KEY, headers: { Authorization: "Bearer " + KEY } }
    }
  })
  const expected = [
    "servers.git.args[0]: " + WHY,
    "servers.git.args[1]: " + WHY,
    "servers.git.env.TOKEN: " + WHY,
    "servers.web.url: " + WHY,
    "servers.web.headers.Authorization: " + WHY
  ]
  for (const env of [{ A: "1" }, { A: "1", [KEY_VARIABLE]: MARKER }, { A: "1", [KEY_VARIABLE]: "" }]) {
    expect(await faults(at, env)).toEqual(expected)
    const exit = await settle(at, env)
    const said = Exit.isFailure(exit) ? JSON.stringify(exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? { ...reason.error, message: (reason.error as Error).message } : reason))) : ""
    expect(said).toContain(KEY_VARIABLE)
    expect(said).not.toContain(MARKER)
  }
  // Each place alone, with the key set: a fault at that place only.
  const one = [
    [{ git: { command: "c", args: [KEY] } }, "servers.git.args[0]"],
    [{ git: { command: "c", env: { K: KEY } } }, "servers.git.env.K"],
    [{ web: { url: KEY } }, "servers.web.url"],
    [{ web: { url: "https://h.example", headers: { K: KEY } } }, "servers.web.headers.K"]
  ] as const
  for (const [servers, at] of one) {
    expect(await faults(write({ servers }), { [KEY_VARIABLE]: MARKER })).toEqual([at + ": " + WHY])
  }
  // Beside an unset variable in one text: both faults, the key's not as unset.
  expect(await faults(write({ servers: { git: { command: "c", args: ["${UNSET}" + KEY] } } }), { [KEY_VARIABLE]: MARKER })).toEqual([
    "servers.git.args[0]: the variable UNSET is not set",
    "servers.git.args[0]: " + WHY
  ])
  // Another gateway variable is an ordinary one.
  expect((await settings(write({ servers: { git: { command: "c", args: ["${EVERCHAT_GATEWAY_URL}"] } } }), { EVERCHAT_GATEWAY_URL: "u" })).servers[0]).toMatchObject({ args: ["u"] })
})

test("a fault: an empty command, at its path", async () => {
  expect(await faults(write({ servers: { git: { command: "" } } }))).toEqual(["servers.git.command: Expected a command that is not empty"])
  expect(await faults(write({ servers: { git: { command: "", args: [1] }, ok: { command: "c" } } }))).toEqual([
    "servers.git.command: Expected a command that is not empty",
    "servers.git.args[0]: Expected string"
  ])
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

test("name and rules are decoded as written: no ${VAR} in either", async () => {
  const got = await settings(write({ name: "Zo\u00eb 2", rules: "../notes/${RULES}.md" }), { RULES: "never" })
  expect([got.name, got.rules]).toEqual(["Zo\u00eb 2", "../notes/${RULES}.md"])
  const ada = await settings(write({ name: "my-agent_1.0", rules: "/abs/AGENTS.md" }))
  expect([ada.name, ada.rules]).toEqual(["my-agent_1.0", "/abs/AGENTS.md"])
  expect((await settings(write({ rules: "r".repeat(4_096) }))).rules?.length).toBe(4_096)
})

test("a fault: a name that the prompt refuses, an empty or a long rules path, and a wrong type, each naming its field", async () => {
  const FORM = "name: Expected a name of letters and digits, with one space, ., _ or - between two of them"
  expect(await faults(write({ name: "" }))).toEqual(["name: Expected a name of 1 to 64 characters"])
  expect(await faults(write({ name: "a".repeat(65) }))).toEqual(["name: Expected a name of 1 to 64 characters"])
  for (const name of ["Ada\nLovelace", "Ada\t", "Ada\u009b", " Ada", "Ada!", "${NAME}"]) expect(await faults(write({ name }), { NAME: "Ada" })).toEqual([FORM])
  expect(await faults(write({ rules: "" }))).toEqual(["rules: Expected a path of 1 to 4096 characters"])
  expect(await faults(write({ rules: "r".repeat(4_097) }))).toEqual(["rules: Expected a path of 1 to 4096 characters"])
  expect(await faults(write({ name: 5, rules: ["a"] }))).toEqual(["name: Expected string", "rules: Expected string"])
})

// rulesOf: a work directory and a home, each in a root of its own case.
const rooms = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-rules-"))
  const work = path.join(root, "work")
  const home = path.join(root, "home")
  fs.mkdirSync(work)
  fs.mkdirSync(home)
  return { root, work, home, config: path.join(home, FILE) }
}

const rulesExit = (rules: string | undefined, cwd: string, config: string) =>
  Effect.runPromise(Effect.exit(rulesOf({ ...NONE, rules }, cwd, config)).pipe(Effect.provide(BunServices.layer)))

const rulesText = async (rules: string | undefined, cwd: string, config: string) => {
  const exit = await rulesExit(rules, cwd, config)
  if (Exit.isFailure(exit)) throw new Error("the rules were refused: " + JSON.stringify(exit.cause))
  return exit.value
}

// The fault's lines; its file is the config file, and no line holds the content.
const rulesFaults = async (rules: string, cwd: string, config: string, content?: string) => {
  const exit = await rulesExit(rules, cwd, config)
  if (Exit.isSuccess(exit)) throw new Error("the rules were taken, " + String(exit.value?.length) + " characters")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  expect(error).toBeInstanceOf(ConfigFault)
  const fault = error as ConfigFault
  expect(fault.file).toBe(config)
  expect(fault.message).toBe(fault.faults.map((one) => config + ": " + one).join("\n"))
  if (content !== undefined) expect(JSON.stringify({ ...fault, message: fault.message })).not.toContain(content)
  return fault.faults
}

test("rulesOf: no rules gives none; a relative path is read against the work directory, never the home", async () => {
  const at = rooms()
  expect(await rulesText(undefined, at.work, at.config)).toBeUndefined()
  fs.writeFileSync(path.join(at.work, "AGENTS.md"), "Rules of the work.\n")
  fs.writeFileSync(path.join(at.home, "AGENTS.md"), "Rules of the home.\n")
  expect(await rulesText("AGENTS.md", at.work, at.config)).toBe("Rules of the work.\n")
  fs.mkdirSync(path.join(at.work, "docs"))
  fs.writeFileSync(path.join(at.work, "docs", "me.md"), "Deeper.")
  expect(await rulesText("./docs/me.md", at.work, at.config)).toBe("Deeper.")
  expect(await rulesText("../home/AGENTS.md", at.work, at.config)).toBe("Rules of the home.\n")
  // Only in the home: the work directory has none, so there is no such file.
  fs.writeFileSync(path.join(at.home, "only-home.md"), "Home only.")
  expect(await rulesFaults("only-home.md", at.work, at.config)).toEqual(["rules: no such file"])
})

test("rulesOf: an absolute path is read as it is", async () => {
  const at = rooms()
  const file = path.join(at.root, "elsewhere.md")
  fs.writeFileSync(file, "Absolute rules.")
  expect(await rulesText(file, at.work, at.config)).toBe("Absolute rules.")
  expect(await rulesText(file, at.home, at.config)).toBe("Absolute rules.")
})

test("rulesOf: a fault for no such file and for a directory, naming the field and not the path", async () => {
  const at = rooms()
  expect(await rulesFaults("missing.md", at.work, at.config)).toEqual(["rules: no such file"])
  expect(await rulesFaults(path.join(at.root, "missing.md"), at.work, at.config)).toEqual(["rules: no such file"])
  fs.mkdirSync(path.join(at.work, "dir"))
  const faulted = await rulesFaults("dir", at.work, at.config)
  expect(faulted).toEqual(["rules: not a file"])
  expect(faulted.join("")).not.toContain(at.work)
})

// rulesOf with the platform's files, but a `stat` that runs `after` once
// the real one has looked at the path: a path that changes between the
// first check and the open. `reopened`, when given, runs before each other
// way of the platform to open or read the path, so that a read that is not
// of the one descriptor sees another object.
const rulesSwapped = (rules: string, cwd: string, config: string, after: (file: string) => void, reopened?: (file: string) => void, io: RulesIo = RULES_IO) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const real = yield* FileSystem.FileSystem
      const before = (file: string) => Effect.sync(() => reopened?.(file))
      const swapped: FileSystem.FileSystem = {
        ...real,
        stat: (file) => real.stat(file).pipe(Effect.tap(() => Effect.sync(() => after(file)))),
        open: (file, options) => Effect.andThen(before(file), real.open(file, options)),
        readFile: (file) => Effect.andThen(before(file), real.readFile(file)),
        readFileString: (file, encoding) => Effect.andThen(before(file), real.readFileString(file, encoding)),
        stream: (file, options) => Stream.unwrap(Effect.as(before(file), real.stream(file, options)))
      }
      return yield* Effect.exit(rulesOf({ ...NONE, rules }, cwd, config, io).pipe(Effect.provideService(FileSystem.FileSystem, swapped)))
    }).pipe(Effect.provide(BunServices.layer))
  )

// The operations of `RULES_IO`, each forwarded to it, with a log: the
// descriptor that each open gave, and the descriptor of each fstat, read and
// close. `afterFstat` runs at once after the real fstat has returned.
const watched = (afterFstat: () => void = () => {}) => {
  const log = { opens: [] as Array<number>, fstats: [] as Array<number>, reads: [] as Array<number>, closes: [] as Array<number> }
  const io: RulesIo = {
    open: (file) => {
      const fd = RULES_IO.open(file)
      log.opens.push(fd)
      return fd
    },
    fstat: (fd) => {
      const stats = RULES_IO.fstat(fd)
      log.fstats.push(fd)
      afterFstat()
      return stats
    },
    read: (fd, bytes, offset, length, position) => {
      log.reads.push(fd)
      return RULES_IO.read(fd, bytes, offset, length, position)
    },
    close: (fd) => {
      log.closes.push(fd)
      RULES_IO.close(fd)
    }
  }
  return { io, log }
}

// What the log says of the one descriptor: opened once, its fstat, its
// reads (each of that descriptor), and its closes.
const once = (log: ReturnType<typeof watched>["log"]) => ({
  opens: log.opens.length,
  fstatOfIt: log.fstats.length === 1 && log.fstats[0] === log.opens[0],
  reads: log.reads.length,
  readsOfIt: log.reads.every((fd) => fd === log.opens[0]),
  closedOnce: log.closes.length === 1 && log.closes[0] === log.opens[0]
})

const faultsOf = (exit: Exit.Exit<string | undefined, ConfigFault>) => {
  if (Exit.isSuccess(exit)) throw new Error("the rules were taken, " + String(exit.value?.length) + " characters")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  expect(error).toBeInstanceOf(ConfigFault)
  return (error as ConfigFault).faults
}

// A link `rules.md` in the work directory to an ordinary file with a marker.
const linked = () => {
  const at = rooms()
  fs.writeFileSync(path.join(at.root, "first.md"), "marker-first-41d9")
  fs.symlinkSync(path.join(at.root, "first.md"), path.join(at.work, "rules.md"))
  return at
}

const retarget = (link: string, to: string) => {
  fs.unlinkSync(link)
  fs.symlinkSync(to, link)
}

const HAS_FIFO = Bun.which("mkfifo") !== null
const fifo = (at: string) => {
  const made = Bun.spawnSync(["mkfifo", at])
  if (made.exitCode !== 0) throw new Error("mkfifo failed")
  return at
}

// The bound of time of a case with a pipe: rulesOf runs in a child, so that
// an open that waits holds the child and not this run; past the bound the
// child is killed and the case fails. The child gives the faults (or the
// text) as JSON on its output.
const BOUND = 20_000
const inChild = async (rules: string, cwd: string, config: string, retargetTo: string | undefined) => {
  const code = `
    import * as BunServices from ${JSON.stringify(import.meta.resolve("@effect/platform-bun/BunServices"))}
    import { Effect, Exit, FileSystem } from ${JSON.stringify(import.meta.resolve("effect"))}
    import * as fs from "node:fs"
    import { NONE, RULES_IO, rulesOf } from ${JSON.stringify(import.meta.resolve("./config.ts"))}
    const [rules, cwd, config, to] = process.argv.slice(-4)
    const log = { opens: [], reads: [], closes: [] }
    const io = {
      open: (file) => { const fd = RULES_IO.open(file); log.opens.push(fd); return fd },
      fstat: (fd) => RULES_IO.fstat(fd),
      read: (fd, bytes, offset, length, position) => { log.reads.push(fd); return RULES_IO.read(fd, bytes, offset, length, position) },
      close: (fd) => { log.closes.push(fd); RULES_IO.close(fd) }
    }
    const exit = await Effect.runPromise(Effect.gen(function*() {
      const real = yield* FileSystem.FileSystem
      const swapped = { ...real, stat: (file) => real.stat(file).pipe(Effect.tap(() => Effect.sync(() => {
        if (to !== "") { fs.unlinkSync(file); fs.symlinkSync(to, file) }
      }))) }
      return yield* Effect.exit(rulesOf({ ...NONE, rules }, cwd, config, io).pipe(Effect.provideService(FileSystem.FileSystem, swapped)))
    }).pipe(Effect.provide(BunServices.layer)))
    const error = Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined
    const opened = { opens: log.opens.length, reads: log.reads.length, closedOnce: log.closes.length === 1 && log.closes[0] === log.opens[0] }
    console.log(JSON.stringify({ ...(Exit.isSuccess(exit) ? { text: exit.value ?? null } : { faults: error?.faults ?? null }), opened }))
  `
  const child = Bun.spawn([process.execPath, "-e", code, rules, cwd, config, retargetTo ?? ""], { cwd, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" })
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    child.kill("SIGKILL")
  }, BOUND)
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  if (killed) throw new Error("rulesOf waited: the child was killed after " + BOUND + " ms")
  if (child.exitCode !== 0) throw new Error("the child failed: " + err)
  return JSON.parse(out) as {
    readonly text?: string | null
    readonly faults?: ReadonlyArray<string> | null
    readonly opened: { readonly opens: number; readonly reads: number; readonly closedOnce: boolean }
  }
}

test("rulesOf: a link to an ordinary file is followed", async () => {
  const at = linked()
  expect(await rulesText("rules.md", at.work, at.config)).toBe("marker-first-41d9")
})

test("rulesOf: a device named at once is refused, never opened", async () => {
  const at = rooms()
  expect(await rulesFaults("/dev/null", at.work, at.config)).toEqual(["rules: not a file"])
})

test.skipIf(!HAS_FIFO)("rulesOf: a FIFO with no writer named at once is refused, within the case's bound", async () => {
  const at = rooms()
  fifo(path.join(at.work, "pipe.md"))
  expect(await inChild("pipe.md", at.work, at.config, undefined)).toEqual({ faults: ["rules: not a file"], opened: { opens: 0, reads: 0, closedOnce: false } })
}, BOUND + 10_000)

test("rulesOf: a link that points to a device after the first check is refused, and nothing of it is read", async () => {
  const at = linked()
  let swapped = false
  const { io, log } = watched()
  const exit = await rulesSwapped("rules.md", at.work, at.config, (file) => {
    retarget(file, "/dev/null")
    swapped = true
  }, undefined, io)
  expect(swapped).toBe(true)
  const faults = faultsOf(exit)
  expect(faults).toEqual(["rules: not a file"])
  // The device was opened, and its fstat refused it: no read at all, and
  // its descriptor closed one time.
  expect(once(log)).toEqual({ opens: 1, fstatOfIt: true, reads: 0, readsOfIt: true, closedOnce: true })
  expect(JSON.stringify(faults)).not.toContain("marker-first")
  expect(JSON.stringify(faults)).not.toContain(at.root)
})

test.skipIf(!HAS_FIFO)("rulesOf: a link that points to a FIFO with no writer after the first check is refused without a wait", async () => {
  const at = linked()
  const pipe = fifo(path.join(at.root, "pipe"))
  // Opened without a wait, refused by its fstat: no read, closed one time.
  expect(await inChild("rules.md", at.work, at.config, pipe)).toEqual({ faults: ["rules: not a file"], opened: { opens: 1, reads: 0, closedOnce: true } })
  // The child did retarget the link.
  expect(fs.readlinkSync(path.join(at.work, "rules.md"))).toBe(pipe)
}, BOUND + 10_000)

test("rulesOf: a link that points to another ordinary file after the first check gives that file's text, read from the one descriptor", async () => {
  const at = linked()
  fs.writeFileSync(path.join(at.root, "second.md"), "marker-second-8a3c")
  const link = path.join(at.work, "rules.md")
  // Any other open or read of the path through the platform finds a device:
  // the text comes only from the descriptor that was checked.
  const exit = await rulesSwapped("rules.md", at.work, at.config, (file) => retarget(file, path.join(at.root, "second.md")), (file) => retarget(file, "/dev/null"))
  expect(exit).toEqual(Exit.succeed("marker-second-8a3c"))
  expect(fs.readlinkSync(link)).toBe(path.join(at.root, "second.md"))
})

// rulesOf with the platform's files and the operations `io`.
const rulesWith = (rules: string, cwd: string, config: string, io: RulesIo) =>
  Effect.runPromise(Effect.exit(rulesOf({ ...NONE, rules }, cwd, config, io)).pipe(Effect.provide(BunServices.layer)))

test("rulesOf: a link that points to another ordinary file at once after the fstat of the opened file gives the first file's text: one open, each read of its descriptor, closed one time", async () => {
  const at = linked()
  const second = path.join(at.root, "second.md")
  fs.writeFileSync(second, "marker-second-8a3c")
  const link = path.join(at.work, "rules.md")
  const { io, log } = watched(() => retarget(link, second))
  const exit = await rulesWith("rules.md", at.work, at.config, io)
  // The link did point to the second file while the bytes were read.
  expect(fs.readlinkSync(link)).toBe(second)
  expect(exit).toEqual(Exit.succeed("marker-first-41d9"))
  expect(once(log)).toEqual({ opens: 1, fstatOfIt: true, reads: log.reads.length, readsOfIt: true, closedOnce: true })
  expect(log.reads.length).toBeGreaterThan(0)
})

test("rulesOf: a link that points to a device at once after the fstat of the opened file gives the first file's text: the path is not looked at again", async () => {
  const at = linked()
  const link = path.join(at.work, "rules.md")
  const { io, log } = watched(() => retarget(link, "/dev/null"))
  const exit = await rulesWith("rules.md", at.work, at.config, io)
  expect(fs.readlinkSync(link)).toBe("/dev/null")
  expect(exit).toEqual(Exit.succeed("marker-first-41d9"))
  expect(once(log)).toEqual({ opens: 1, fstatOfIt: true, reads: log.reads.length, readsOfIt: true, closedOnce: true })
  expect(log.reads.length).toBeGreaterThan(0)
})

test("rulesOf: a file that grows past the cap after the first check is refused", async () => {
  const at = rooms()
  fs.writeFileSync(path.join(at.work, "growing.md"), "a")
  const exit = await rulesSwapped("growing.md", at.work, at.config, (file) => fs.writeFileSync(file, "g".repeat(RULES_MAX + 1)))
  expect(faultsOf(exit)).toEqual(["rules: Expected a file of at most 32768 bytes"])
})

test("rulesOf: a file of 32,768 bytes is taken, one of 32,769 is refused", async () => {
  const at = rooms()
  // A two-byte character at the end, so that the cap is in bytes, not characters.
  const full = "r".repeat(RULES_MAX - 2) + "\u00e9"
  expect(Buffer.byteLength(full)).toBe(32_768)
  fs.writeFileSync(path.join(at.work, "full.md"), full)
  expect(await rulesText("full.md", at.work, at.config)).toBe(full)
  const over = "s".repeat(RULES_MAX - 1) + "\u00e9"
  expect(Buffer.byteLength(over)).toBe(32_769)
  fs.writeFileSync(path.join(at.work, "over.md"), over)
  expect(await rulesFaults("over.md", at.work, at.config, "sss")).toEqual(["rules: Expected a file of at most 32768 bytes"])
  // A much larger file is refused the same way.
  fs.writeFileSync(path.join(at.work, "huge.md"), "h".repeat(1_000_000))
  expect(await rulesFaults("huge.md", at.work, at.config, "hhh")).toEqual(["rules: Expected a file of at most 32768 bytes"])
})

test("rulesOf: the reads of a file of 1 MB ask for at most RULES_MAX + 1 bytes in all, and the fault is the cap's", async () => {
  const at = rooms()
  fs.writeFileSync(path.join(at.work, "huge.md"), "h".repeat(1_000_000))
  // The operations of `RULES_IO`, with the sum of the lengths that the reads ask for.
  let asked = 0
  let reads = 0
  const io: RulesIo = {
    ...RULES_IO,
    read: (fd, bytes, offset, length, position) => {
      asked += length
      reads += 1
      return RULES_IO.read(fd, bytes, offset, length, position)
    }
  }
  const exit = await rulesWith("huge.md", at.work, at.config, io)
  expect(faultsOf(exit)).toEqual(["rules: Expected a file of at most 32768 bytes"])
  expect(reads).toBeGreaterThan(0)
  expect(asked).toBeLessThanOrEqual(RULES_MAX + 1)
})

test("rulesOf: bytes that are not UTF-8 are refused, without the content", async () => {
  const at = rooms()
  fs.writeFileSync(path.join(at.work, "latin1.md"), Buffer.concat([Buffer.from("marker-rules-7c2e "), Buffer.from([0xe9, 0x74, 0xe9])]))
  expect(await rulesFaults("latin1.md", at.work, at.config, "marker-rules-7c2e")).toEqual(["rules: Expected a file of UTF-8 text"])
  // A sequence cut at the end is not UTF-8 either.
  fs.writeFileSync(path.join(at.work, "cut.md"), Buffer.from([0x41, 0xc3]))
  expect(await rulesFaults("cut.md", at.work, at.config)).toEqual(["rules: Expected a file of UTF-8 text"])
})

test("rulesOf: a blank file gives no rules", async () => {
  const at = rooms()
  fs.writeFileSync(path.join(at.work, "empty.md"), "")
  fs.writeFileSync(path.join(at.work, "blank.md"), "  \n\t\n  ")
  expect(await rulesText("empty.md", at.work, at.config)).toBeUndefined()
  expect(await rulesText("blank.md", at.work, at.config)).toBeUndefined()
})
