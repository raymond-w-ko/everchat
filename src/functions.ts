// Functions
// =========
// What a program can call. In code mode the model has one tool, and what
// the old code gave it as separate tools (shell, read, write, edit, zoom)
// are functions (AGENTS.md, "Code mode is the only primary tool").
//
// Two parts are here:
//
// - The declarations: each function's name, its signature in TypeScript,
//   and what it does. They are text that the program owns. The head shows
//   them to the model (head.ts), so they must not change from one request
//   to the next.
// - The service `Functions`: it runs a function by its name, with the
//   arguments that a program gave. The sandbox calls it, and a test can
//   give other functions.
//
// A program's arguments cross a boundary (they come out of the sandbox as
// JSON), so each function decodes them with a schema. An argument that the
// program left out, or gave as `undefined`, arrives as nothing or as null.
//
// A function gives its whole result to the program. The output limit
// applies to the program's own result (limit.ts).
//
// Not here yet: the functions for agents (to start one, to tell one
// something), and `zoom` of an agent's chat.

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as Files from "./files.ts"
import { Limit } from "./limit.ts"
import { Memory } from "./memory.ts"
import { SECONDS, Shell } from "./shell.ts"
import { Store, type StoreError } from "./store.ts"

// Declarations
// ------------

export interface Declaration {
  readonly name: string
  readonly signature: string // the parameter list and the return type, in TypeScript
  readonly description: string
}

export const DECLARATIONS = [
  {
    name: "shell",
    signature: "(command: string, seconds?: number): Promise<string>",
    description: "Runs a command with the user's shell ($SHELL -c) in the work directory, and gives its output (stdout and stderr together), then one last line that says how it ended, as `(exit 0 in 0.4 s)`. A command that fails does not throw: read the last line. Each call is a new shell. The call waits until the command and everything that holds its output end, so give a background job its own output file. The command is stopped after `seconds` (" + SECONDS + " when not given). Background jobs live only while EverChat runs."
  },
  {
    name: "read",
    signature: "(path: string, offset?: number, limit?: number): Promise<string>",
    description: "Gives the content of a text file, exactly. `offset`: the first line to give (from 1). `limit`: how many lines."
  },
  {
    name: "write",
    signature: "(path: string, content: string): Promise<string>",
    description: "Writes a whole file, and makes its directories. Gives a unified diff of what changed (for a new file, all its lines added)."
  },
  {
    name: "edit",
    signature: "(edits: Array<{ path: string; old: string; new: string; all?: boolean }>): Promise<string>",
    description: "Replaces text in files: the edits in order, each on its file as the edits before it left it. `old` must match exactly, whitespace too, and only once, unless `all` is true, which replaces every match. If one edit fails, no file is changed. Gives a unified diff of each file."
  },
  {
    name: "zoom",
    signature: "(id: number, n?: number, at?: number): Promise<string>",
    description: "Opens the line id+n of the view into the two lines of n/2 messages below it. With n = 1 (or not given), it gives message id whole. A long message comes in pages from character `at`, and says where to go on."
  },
  {
    name: "date",
    signature: "(id: number): Promise<string>",
    description: "The date and time of message id."
  },
  {
    name: "result",
    signature: "(id: number): Promise<string>",
    description: "The whole result of an earlier program or function, by the number that a shortened result names."
  }
] as const satisfies ReadonlyArray<Declaration>

export type Name = (typeof DECLARATIONS)[number]["name"]

// Errors and types
// ----------------

// Why a function did not do its work. The program that called it gets the
// message as an error that it can catch.
export class FunctionError extends Schema.TaggedError<FunctionError>()("FunctionError", {
  message: Schema.String
}) {}

// Who calls: the turn, the program (its call), and this function's own call.
export interface Caller {
  readonly turn: number
  readonly program: number
  readonly call: number
}

// Arguments
// ---------

// A parameter that the program may leave out.
const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

const ARGS = {
  shell: Schema.Tuple([Schema.String, maybe(Schema.Number)]),
  read: Schema.Tuple([Schema.String, maybe(Schema.Int), maybe(Schema.Int)]),
  write: Schema.Tuple([Schema.String, Schema.String]),
  edit: Schema.Tuple([
    Schema.Array(Schema.Struct({ path: Schema.String, old: Schema.String, new: Schema.String, all: maybe(Schema.Boolean) }))
  ]),
  zoom: Schema.Tuple([Schema.Union([Schema.Int, Schema.String]), maybe(Schema.Int), maybe(Schema.Int)]),
  date: Schema.Tuple([Schema.Int]),
  result: Schema.Tuple([Schema.Int])
} satisfies Record<Name, Schema.Top>

const signature = (name: string) => DECLARATIONS.find((one) => one.name === name)?.signature ?? "()"

// The arguments of `name`, decoded. A wrong argument says which one, and
// shows the signature.
const decode = <N extends Name>(name: N, args: ReadonlyArray<unknown>): Effect.Effect<(typeof ARGS)[N]["Type"], FunctionError> =>
  Effect.mapError(
    Schema.decodeUnknownEffect(ARGS[name] as Schema.Codec<(typeof ARGS)[N]["Type"]>)(args),
    (cause) => new FunctionError({ message: "Wrong arguments: " + cause.message.replace(/\s*\n\s*/g, " ") + ". Use " + name + signature(name) + "." })
  )

// Service
// -------

export interface Options {
  readonly cwd?: string | undefined // the work directory of the file functions; the program's own when not given
}

export class Functions extends Context.Service<Functions, {
  // The functions that a program can call.
  readonly names: ReadonlyArray<string>
  // Runs one function. A result must be a JSON value.
  call(name: string, args: ReadonlyArray<unknown>, caller: Caller): Effect.Effect<unknown, FunctionError>
}>()("everchat/functions/Functions") {
  static readonly layer = (options: Options = {}): Layer.Layer<Functions, never, Store | Memory | Shell | Limit> =>
    Layer.effect(
      Functions,
      Effect.gen(function*() {
        const store = yield* Store
        const memory = yield* Memory
        const shell = yield* Shell
        const limit = yield* Limit
        const cwd = options.cwd ?? process.cwd()

        const stored = <A>(effect: Effect.Effect<A, StoreError>) =>
          Effect.mapError(effect, (cause) => new FunctionError({ message: "EverChat's database failed (" + cause.op + ")." }))

        const filed = <A>(effect: Effect.Effect<A, Files.FileError>) =>
          Effect.mapError(effect, (cause) => new FunctionError({ message: cause.message }))

        const run: { readonly [N in Name]: (args: ReadonlyArray<unknown>, caller: Caller) => Effect.Effect<unknown, FunctionError> } = {
          shell: Effect.fnUntraced(function*(args, caller) {
            const [command, seconds] = yield* decode("shell", args)
            return yield* shell.run(command, {
              seconds: seconds ?? undefined,
              started: (pgid) => Effect.ignore(store.setCallPgid(caller.call, pgid))
            })
          }),

          read: Effect.fnUntraced(function*(args) {
            const [path, offset, count] = yield* decode("read", args)
            return yield* filed(Files.read(cwd, path, offset ?? undefined, count ?? undefined))
          }),

          write: Effect.fnUntraced(function*(args) {
            const [path, content] = yield* decode("write", args)
            return yield* filed(Files.write(cwd, path, content))
          }),

          edit: Effect.fnUntraced(function*(args) {
            const [edits] = yield* decode("edit", args)
            return yield* filed(Files.edit(cwd, edits.map((one) => ({ path: one.path, old: one.old, new: one.new, all: one.all === true }))))
          }),

          zoom: Effect.fnUntraced(function*(args) {
            const [id, n, at] = yield* decode("zoom", args)
            const message = typeof id === "number" ? id : /^\d+$/.test(id) ? Number(id) : null
            if (message === null) {
              return yield* new FunctionError({ message: "No agent " + id + "." })
            }
            return yield* stored(memory.zoom(message, n ?? 1, at ?? 0))
          }),

          date: Effect.fnUntraced(function*(args) {
            const [id] = yield* decode("date", args)
            const [message] = id < 0 ? [] : yield* stored(store.messages(id, id + 1))
            if (message === undefined) {
              return yield* new FunctionError({ message: "No message " + id + "." })
            }
            return DateTime.formatLocal(DateTime.makeUnsafe(message.created), { locale: "sv-SE", dateStyle: "short", timeStyle: "medium" })
          }),

          result: Effect.fnUntraced(function*(args) {
            const [id] = yield* decode("result", args)
            const call = yield* stored(store.call(id))
            if (call._tag === "None") {
              return yield* new FunctionError({ message: "No call " + id + "." })
            }
            const output = call.value.output
            if (output === null) {
              return yield* new FunctionError({ message: "Call " + id + " still runs: it has no result yet." })
            }
            // The file is a copy that the system may delete.
            if (!fs.existsSync(limit.file(id))) {
              yield* limit.put(id, output)
            }
            return output
          })
        }

        const names: ReadonlyArray<string> = DECLARATIONS.map((one) => one.name)

        return Functions.of({
          names,
          call: (name, args, caller) => {
            const found = names.includes(name) ? run[name as Name] : undefined
            return found === undefined ? Effect.fail(new FunctionError({ message: "No function " + name + "." })) : found(args, caller)
          }
        })
      })
    )
}
