// Local functions
// ===============
// The functions that need this machine: the shell, the files, and the work
// directory (`shell`, `read`, `write`, `edit`). With the core's own
// (functions.ts: `zoom`, `date`, `result`), they make the list of a local
// chat, and its layer of `Functions`. A local chat's `result` is the core's,
// and then it writes the result's file again when the file is gone
// (limitfile.ts).
//
// The order of the list is the order in which the head shows the
// declarations, so it is part of the prompt cache's key (head.ts).

import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as Files from "./files.ts"
import { core, DATE, type Declaration, decoder, type Entry, FunctionError, Functions, make, maybe, RESULT, ZOOM } from "@everchat/core/functions"
import { Limit } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import { SECONDS, Shell } from "./shell.ts"
import { Store } from "@everchat/core/store"

// Declarations
// ------------

export const SHELL = {
  name: "shell",
  signature: "(command: string, seconds?: number): Promise<string>",
  description: "Runs a command with the user's shell ($SHELL -c) in the work directory, and gives its output (stdout and stderr together), then one last line that says how it ended, as `(exit 0 in 0.4 s)`. A command that fails does not throw: read the last line. Each call is a new shell. The call waits until the command and everything that holds its output end, so give a background job its own output file. The command is stopped after `seconds` (" + SECONDS + " when not given). Background jobs live only while EverChat runs."
} as const satisfies Declaration

export const READ = {
  name: "read",
  signature: "(path: string, offset?: number, limit?: number): Promise<string>",
  description: "Gives the content of a text file, exactly. `offset`: the first line to give (from 1). `limit`: how many lines."
} as const satisfies Declaration

export const WRITE = {
  name: "write",
  signature: "(path: string, content: string): Promise<string>",
  description: "Writes a whole file, and makes its directories. Gives a unified diff of what changed (for a new file, all its lines added)."
} as const satisfies Declaration

export const EDIT = {
  name: "edit",
  signature: "(edits: Array<{ path: string; old: string; new: string; all?: boolean }>): Promise<string>",
  description: "Replaces text in files: the edits in order, each on its file as the edits before it left it. `old` must match exactly, whitespace too, and only once, unless `all` is true, which replaces every match. If one edit fails, no file is changed. Gives a unified diff of each file."
} as const satisfies Declaration

// The declarations of a local chat's functions, in the head's order.
export const DECLARATIONS = [SHELL, READ, WRITE, EDIT, ZOOM, DATE, RESULT] as const satisfies ReadonlyArray<Declaration>

// Arguments
// ---------

const shellArgs = decoder(SHELL, Schema.Tuple([Schema.String, maybe(Schema.Number)]))
const readArgs = decoder(READ, Schema.Tuple([Schema.String, maybe(Schema.Int), maybe(Schema.Int)]))
const writeArgs = decoder(WRITE, Schema.Tuple([Schema.String, Schema.String]))
const editArgs = decoder(
  EDIT,
  Schema.Tuple([Schema.Array(Schema.Struct({ path: Schema.String, old: Schema.String, new: Schema.String, all: maybe(Schema.Boolean) }))])
)

// Layer
// -----

export interface Options {
  readonly cwd?: string | undefined // the work directory of the file functions; the program's own when not given
}

// The functions of a local chat: the core's, and these.
export const functionsLayer = (options: Options = {}): Layer.Layer<Functions, never, Store | Memory | Shell | Limit> =>
  Layer.effect(
    Functions,
    Effect.gen(function*() {
      const store = yield* Store
      const shell = yield* Shell
      const limit = yield* Limit
      const { zoom, date, result } = yield* core
      const cwd = options.cwd ?? process.cwd()

      const filed = <A>(effect: Effect.Effect<A, Files.FileError>) =>
        Effect.mapError(effect, (cause) => new FunctionError({ message: cause.message }))

      const entries: { readonly [N in (typeof DECLARATIONS)[number]["name"]]: Entry } = {
        shell: {
          declaration: SHELL,
          run: Effect.fnUntraced(function*(args, caller) {
            const [command, seconds] = yield* shellArgs(args)
            return yield* shell.run(command, {
              seconds: seconds ?? undefined,
              started: (pgid) => Effect.ignore(store.setCallPgid(caller.call, pgid))
            })
          })
        },

        read: {
          declaration: READ,
          run: Effect.fnUntraced(function*(args) {
            const [path, offset, count] = yield* readArgs(args)
            return yield* filed(Files.read(cwd, path, offset ?? undefined, count ?? undefined))
          })
        },

        write: {
          declaration: WRITE,
          run: Effect.fnUntraced(function*(args) {
            const [path, content] = yield* writeArgs(args)
            return yield* filed(Files.write(cwd, path, content))
          })
        },

        edit: {
          declaration: EDIT,
          run: Effect.fnUntraced(function*(args) {
            const [edits] = yield* editArgs(args)
            return yield* filed(Files.edit(cwd, edits.map((one) => ({ path: one.path, old: one.old, new: one.new, all: one.all === true }))))
          })
        },

        zoom,
        date,

        result: {
          declaration: RESULT,
          run: Effect.fnUntraced(function*(args) {
            const output = yield* result.run(args)
            // The core's `result` decoded the id. The file is a copy that
            // the system may delete.
            const id = args[0] as number
            const at = limit.file(id)
            if (at !== "" && !fs.existsSync(at)) {
              yield* limit.put(id, output)
            }
            return output
          })
        }
      }

      return make(DECLARATIONS.map((one) => entries[one.name]))
    })
  )
