// The config file
// ===============
// `config.json` in the home: the settings that the person sets. The person
// writes it by hand, and the program only reads it (the root AGENTS.md, "All
// state in the chat's database"). The command `everchat` reads it one time,
// at its start, before the database is opened; `everchat inspect` and
// `everchat serve` do not read it.
//
// No file is as the file `{}`: no setting, so the program does what it does
// with none. The form, every field optional:
//
//   model, effort, compactor   texts: each acts as its flag would, and a
//                              flag of the launch wins over the file
//   limit                      the output limit in characters, a whole
//                              number from 2,000 to 1,000,000
//   servers                    at most 16 servers, by name
//   name                       the agent's name in the system prompt, in
//                              place of "EverChat" (nameFault of the core's
//                              prompt.ts says the form)
//   rules                      the path of a file of the person's own
//                              instructions, 1 to 4,096 characters
//
// `rules` names a file, and `rulesOf` reads it: a relative path is resolved
// against the work directory, not the home. Its text, at most 32,768 bytes
// of UTF-8, joins the system prompt of every request, under its own heading
// (the core's head.ts); a blank file gives no rules. A fault of the file
// names the field `rules` and what is wrong, never a part of its content.
// Neither field takes `${NAME}`.
//
// A server's name is an identifier: it becomes the namespace of the server's
// functions. A server is a program on stdio, `{ command, args?, env?, cwd? }`,
// or one over HTTP, `{ url, headers? }` (an `http:` or `https:` address): one
// of the two, not both and not neither. Each may also have `approval` (one of
// "auto", "ask", "deny", for each of its tools) and `tools` (a tool's name to
// one of the three, which wins for that tool). With none, a tool is "auto".
// This module only decodes them: the client's load reads them.
//
// A field that is not in this list is refused, at any depth.
//
// `${NAME}` in a text of a server's `args`, `env`, `url` or `headers` is
// replaced by the variable `NAME` of the environment (`NAME` is
// `[A-Za-z_][A-Za-z0-9_]*`), one time, at the start: a value is not read
// again for a `${...}` of its own. A variable that is not set refuses the
// start; one that is set to the empty text is set. No other form: no
// default, no escape, and any other `$` is a `$`. A secret goes into the
// file only this way, so no fault holds a value of the file or of the
// environment: a fault names the file, the field and the variable only.
//
// A fault stops the start: a file that cannot be read, that is not JSON or
// not one object, a field of a wrong type or out of its bounds, an unknown
// field, an unset variable. The faults of the form come first, all of them;
// the variables and the addresses are looked at when the form is right.

import { nameFault } from "@everchat/core/head"
import { Effect, FileSystem, Path, Schema, SchemaIssue } from "effect"
import * as nodeFs from "node:fs"

// The file's name in the home.
export const FILE = "config.json"

// The bounds of the output limit, in characters.
export const LIMIT_MIN = 2_000
export const LIMIT_MAX = 1_000_000

// The most servers that the file may name.
export const SERVERS_MAX = 16

// The bounds of the rules: the most characters of the path, and the most
// bytes of the file.
export const RULES_PATH_MAX = 4_096
export const RULES_MAX = 32_768

// A server's name: the namespace of its functions.
export const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// `${NAME}` in a text.
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export type Approval = "auto" | "ask" | "deny"

interface Common {
  readonly name: string
  // For each tool of the server that `tools` does not name.
  readonly approval: Approval
  readonly tools: Readonly<Record<string, Approval>>
}

// A program on stdio, with its texts replaced.
export interface StdioServer extends Common {
  readonly kind: "stdio"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string | undefined
}

// A server over HTTP, with its texts replaced.
export interface HttpServer extends Common {
  readonly kind: "http"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type Server = StdioServer | HttpServer

// What the file sets. A field that the file does not give is undefined.
export interface Settings {
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly compactor: string | undefined
  readonly limit: number | undefined
  // Sorted by name.
  readonly servers: ReadonlyArray<Server>
  // The agent's name in the system prompt.
  readonly name: string | undefined
  // The path of the rules' file, as written (`rulesOf` reads it).
  readonly rules: string | undefined
}

// The settings of no file, and of `{}`.
export const NONE: Settings = { model: undefined, effort: undefined, compactor: undefined, limit: undefined, servers: [], name: undefined, rules: undefined }

// The picks of a launch's flags, or of the file: undefined when not given.
export interface Picks {
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly compactor: string | undefined
}

// A flag of the launch wins over the file.
export const picks = (flags: Picks, settings: Settings): Picks => ({
  model: flags.model ?? settings.model,
  effort: flags.effort ?? settings.effort,
  compactor: flags.compactor ?? settings.compactor
})

// The file could not be used. Each fault is one line: the field's path and
// what is wrong, never a value.
export class ConfigFault extends Schema.TaggedError<ConfigFault>()("ConfigFault", {
  file: Schema.String,
  faults: Schema.Array(Schema.String),
  message: Schema.String
}) {}

const faulted = (file: string, faults: ReadonlyArray<string>) => new ConfigFault({ file, faults, message: faults.map((one) => file + ": " + one).join("\n") })

const ApprovalSchema = Schema.Literals(["auto", "ask", "deny"])
const Texts = Schema.Record(Schema.String, Schema.String)

// The two forms of a server in one struct, so that each field's fault has
// its own path; the check says which fields go together.
const ServerSchema = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Texts),
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Texts),
  approval: Schema.optionalKey(ApprovalSchema),
  tools: Schema.optionalKey(Schema.Record(Schema.String, ApprovalSchema))
}).check(Schema.makeFilter((server) => {
  if (server.command === undefined && server.url === undefined) {
    return "Expected command (a program on stdio) or url (a server over HTTP)"
  }
  if (server.command !== undefined && server.url !== undefined) {
    return { path: ["url"], issue: "Expected command or url, not both" }
  }
  const wrong = server.url !== undefined
    ? (["args", "env", "cwd"] as const).filter((field) => server[field] !== undefined).map((field) => ({ path: [field], issue: "Expected only with command" }))
    : server.headers !== undefined
    ? [{ path: ["headers"], issue: "Expected only with url" }]
    : []
  return wrong.length === 0 ? undefined : wrong
}))

const SettingsSchema = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  compactor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: LIMIT_MIN, maximum: LIMIT_MAX }, { message: `Expected a whole number from ${LIMIT_MIN} to ${LIMIT_MAX}` }))
  ),
  servers: Schema.optionalKey(
    Schema.Record(Schema.String, ServerSchema).check(
      Schema.isMaxProperties(SERVERS_MAX, { message: `Expected at most ${SERVERS_MAX} servers` }),
      Schema.makeFilter((servers) => {
        const wrong = Object.keys(servers).filter((name) => !NAME.test(name))
        return wrong.length === 0 ? undefined : wrong.map((name) => ({ path: [name], issue: "Expected a name that is an identifier (letters, digits, _ and $, not first a digit)" }))
      })
    )
  ),
  name: Schema.optionalKey(Schema.String.check(Schema.makeFilter((name) => nameFault(name)))),
  rules: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter((rules) => (rules.length >= 1 && rules.length <= RULES_PATH_MAX ? undefined : `Expected a path of 1 to ${RULES_PATH_MAX} characters`)))
  )
})

// A path of the file, as a person would write it in code: `servers.git.args[0]`.
export const pathOf = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((part, i) =>
    typeof part === "number"
      ? "[" + part + "]"
      : typeof part === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)
      ? (i === 0 ? "" : ".") + part
      : "[" + JSON.stringify(String(part)) + "]"
  ).join("")

// The default messages but the unknown field's. None of them holds the
// input: the parse does not report it (`reportInput` is off).
const format = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => (issue._tag === "UnexpectedKey" ? "Unknown field" : SchemaIssue.defaultLeafHook(issue))
})

const line = (path: ReadonlyArray<PropertyKey>, what: string) => (path.length === 0 ? what : pathOf(path) + ": " + what)

// Each text with its variables replaced, or the names of the unset ones.
const replace = (text: string, env: Readonly<Record<string, string | undefined>>): { readonly text: string; readonly unset: ReadonlyArray<string> } => {
  const unset: Array<string> = []
  const replaced = text.replace(VARIABLE, (whole, name: string) => {
    const value = Object.hasOwn(env, name) ? env[name] : undefined
    if (value === undefined) {
      if (!unset.includes(name)) unset.push(name)
      return whole
    }
    return value
  })
  return { text: replaced, unset }
}

type Decoded = typeof SettingsSchema.Type
type DecodedServer = typeof ServerSchema.Type

// The servers with their texts replaced, sorted by name, or the faults.
const servers = (decoded: Decoded["servers"], env: Readonly<Record<string, string | undefined>>): { readonly servers: ReadonlyArray<Server>; readonly faults: ReadonlyArray<string> } => {
  const faults: Array<string> = []
  const text = (path: ReadonlyArray<PropertyKey>, value: string) => {
    const { text: replaced, unset } = replace(value, env)
    for (const name of unset) faults.push(line(path, `the variable ${name} is not set`))
    return replaced
  }
  // A null prototype, so that a key such as `__proto__` is a key.
  const texts = (path: ReadonlyArray<PropertyKey>, values: Readonly<Record<string, string>> | undefined) => {
    const out: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(values ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[key] = text([...path, key], value)
    return out
  }
  const one = (name: string, server: DecodedServer): Server => {
    const at = ["servers", name]
    const common = { name, approval: server.approval ?? "auto", tools: server.tools ?? {} }
    if (server.url !== undefined) {
      const before = faults.length
      const url = text([...at, "url"], server.url)
      // An address with an unset variable is not looked at: its fault is said.
      if (faults.length === before && !isHttp(url)) faults.push(line([...at, "url"], "Expected an http: or https: address"))
      return { kind: "http", ...common, url, headers: texts([...at, "headers"], server.headers) }
    }
    return {
      kind: "stdio",
      ...common,
      command: server.command!,
      args: (server.args ?? []).map((arg, i) => text([...at, "args", i], arg)),
      env: texts([...at, "env"], server.env),
      cwd: server.cwd
    }
  }
  const sorted = Object.entries(decoded ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return { servers: sorted.map(([name, server]) => one(name, server)), faults }
}

const isHttp = (text: string): boolean => {
  try {
    const url = new URL(text)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

// The settings of the home's config file, with the variables of `env`.
export const read = Effect.fnUntraced(function*(home: string, env: Readonly<Record<string, string | undefined>>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(home, FILE)
  const content = yield* fs.readFileString(file).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(faulted(file, ["cannot be read (" + error.reason._tag + ")"])))
  )
  if (content === undefined) return NONE
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    // Not the parser's message: it can quote the file.
    return yield* faulted(file, ["Expected JSON"])
  }
  const decoded = Schema.decodeUnknownExit(SettingsSchema)(json, { errors: "all", onExcessProperty: "error" })
  if (decoded._tag === "Failure") {
    const error = decoded.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    const faults = error === undefined
      ? ["Expected one object"]
      : format(error.issue).issues.map((issue) => line((issue.path ?? []).map((part) => (typeof part === "object" ? part.key : part)), issue.message))
    return yield* faulted(file, faults)
  }
  const settings = decoded.value
  const made = servers(settings.servers, env)
  if (made.faults.length > 0) return yield* faulted(file, made.faults)
  return {
    model: settings.model,
    effort: settings.effort,
    compactor: settings.compactor,
    limit: settings.limit,
    servers: made.servers,
    name: settings.name,
    rules: settings.rules
  } satisfies Settings
})

// The text of the rules' file that `settings` names, or undefined with no
// `rules` and for a blank file. A relative path is resolved against `cwd`,
// the work directory. It reads at most `RULES_MAX` + 1 bytes, so a larger
// file costs no more. A fault is a `ConfigFault` of `config`, the config
// file's path, with one line: the field `rules` and what is wrong (no such
// file, not a file, cannot be read, over the cap, not UTF-8), never a part
// of the content, nor the path.
//
// Two checks of the type. The first is of the path: in the ordinary case a
// device, a pipe or a directory is refused and never opened. The one that
// decides is of the file that was opened (`fstat` of its descriptor), and
// the bytes come from that same descriptor: a path or a link that changes
// after the first check cannot make another object pass as the file. The
// open is read-only and does not wait (`O_NONBLOCK`), so a device or a pipe
// that took the path's place is opened at once and refused, nothing of it
// is read, and a pipe with no writer does not hold the start. A link to an
// ordinary file is followed. The descriptor is closed in every case. The
// four operations on the descriptor are `io`'s: `RULES_IO`, unless a test
// gives its own.
export const rulesOf = Effect.fnUntraced(function*(settings: Settings, cwd: string, config: string = FILE, io: RulesIo = RULES_IO) {
  if (settings.rules === undefined) return undefined
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.resolve(cwd, settings.rules)
  const fault = (what: string) => faulted(config, ["rules: " + what])
  // The errors of the open and the reads, as the platform's tags; never the
  // path, which the error's own message holds.
  const failed = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === "ENOENT" ? fault("no such file") : fault("cannot be read (" + tagOf(code) + ")")
  }
  const info = yield* fs.stat(file).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(error.reason._tag === "NotFound" ? fault("no such file") : fault("cannot be read (" + error.reason._tag + ")")))
  )
  if (info.type !== "File") return yield* fault("not a file")
  const bytes = yield* Effect.acquireUseRelease(
    Effect.try({ try: () => io.open(file), catch: failed }),
    (fd) =>
      Effect.gen(function*() {
        const opened = yield* Effect.try({ try: () => io.fstat(fd), catch: failed })
        if (!opened.isFile()) return yield* fault("not a file")
        return yield* Effect.try({ try: () => readUpTo(io, fd, RULES_MAX + 1), catch: failed })
      }),
    (fd) => Effect.sync(() => io.close(fd))
  )
  if (bytes.length > RULES_MAX) return yield* fault(`Expected a file of at most ${RULES_MAX} bytes`)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return yield* fault("Expected a file of UTF-8 text")
  }
  return text.trim() === "" ? undefined : text
})

// The operations of `rulesOf` on the rules' file: an open that is
// read-only and does not wait, the stat of the descriptor, a read at a
// position of the file into `bytes` from `offset` (the count it read; 0 at
// the end), and the close.
export interface RulesIo {
  readonly open: (file: string) => number
  readonly fstat: (fd: number) => nodeFs.Stats
  readonly read: (fd: number, bytes: Uint8Array, offset: number, length: number, position: number) => number
  readonly close: (fd: number) => void
}

export const RULES_IO: RulesIo = {
  open: (file) => nodeFs.openSync(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NONBLOCK ?? 0)),
  fstat: (fd) => nodeFs.fstatSync(fd),
  read: (fd, bytes, offset, length, position) => nodeFs.readSync(fd, bytes, offset, length, position),
  close: (fd) => nodeFs.closeSync(fd)
}

// The bytes of a descriptor from its start, up to `most` of them or its end.
const readUpTo = (io: RulesIo, fd: number, most: number): Uint8Array => {
  const bytes = new Uint8Array(most)
  let at = 0
  while (at < most) {
    const got = io.read(fd, bytes, at, most - at, at)
    if (got === 0) break
    at += got
  }
  return bytes.subarray(0, at)
}

// An error's code as the platform's tag (as `FileSystem` names it).
const tagOf = (code: string | undefined): string =>
  code === "EACCES" || code === "EPERM"
    ? "PermissionDenied"
    : code === "EISDIR" || code === "ENOTDIR" || code === "ELOOP"
    ? "BadResource"
    : code === "EBUSY"
    ? "Busy"
    : code === "EAGAIN"
    ? "WouldBlock"
    : "Unknown"
