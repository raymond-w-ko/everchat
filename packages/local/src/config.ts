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

import { Effect, FileSystem, Path, Schema, SchemaIssue } from "effect"

// The file's name in the home.
export const FILE = "config.json"

// The bounds of the output limit, in characters.
export const LIMIT_MIN = 2_000
export const LIMIT_MAX = 1_000_000

// The most servers that the file may name.
export const SERVERS_MAX = 16

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
}

// The settings of no file, and of `{}`.
export const NONE: Settings = { model: undefined, effort: undefined, compactor: undefined, limit: undefined, servers: [] }

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
    servers: made.servers
  } satisfies Settings
})
