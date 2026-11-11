// Files
// =====
// The functions that read and change files: `read`, `write` and `edit`.
// Ported from the old code (ref/src/machine.ts: Machine.read, write, edit),
// with two differences that come from code mode:
//
// - `read` gives the text exactly, with no line at its end that says which
//   lines it shows. A program often parses what it reads, and such a line
//   would break that. The output limit shortens what the model is shown.
// - No function shortens or pages its result. The hard limit is the only
//   one: a file over it is not read whole.
//
// A path is taken from the work directory, unless it starts at the root.
// A file that changed (`write` over one, `edit`) answers as a unified diff.

import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { diff } from "./diff.ts"
import { HARD } from "./limit.ts"

// Why a file function did not do its work. The program that called it gets
// the message as an error.
export class FileError extends Schema.TaggedError<FileError>()("FileError", {
  message: Schema.String
}) {}

// What the system says about a failed file operation, with its code
// (ENOENT, EACCES): a model knows these codes.
const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const attempt = <A>(work: () => A): Effect.Effect<A, FileError> =>
  Effect.try({ try: work, catch: (cause) => (cause instanceof FileError ? cause : new FileError({ message: reason(cause) })) })

// The lines of the file `file`, exactly: `limit` lines from line `offset`
// (from 1). With no `offset` and no `limit`, the whole content, byte for
// byte.
export const read = (cwd: string, file: string, offset?: number, limit?: number): Effect.Effect<string, FileError> =>
  attempt(() => {
    const full = path.resolve(cwd, file)
    const size = fs.statSync(full).size
    if (size > HARD) {
      throw new FileError({ message: "The file has " + size + " bytes, over the most that a call may give (" + HARD + "). Use shell to read a part of it." })
    }
    const data = fs.readFileSync(full)
    if (data.includes(0)) {
      throw new FileError({ message: "A binary file of " + data.length + " bytes." })
    }
    const text = data.toString("utf8")
    if (offset === undefined && limit === undefined) {
      return text
    }
    const lines = text.replace(/\n$/, "").split("\n")
    const from = Math.max(1, offset ?? 1)
    const rows = lines.slice(from - 1, limit === undefined ? undefined : from - 1 + Math.max(0, limit))
    if (rows.length === 0) {
      throw new FileError({ message: "No lines from line " + from + ": the file has " + lines.length + "." })
    }
    return rows.join("\n")
  })

// Writes the file whole, and makes its directories. The answer is its
// diff (for a new file, all its lines added), so a write reads as an edit.
export const write = (cwd: string, file: string, content: string): Effect.Effect<string, FileError> =>
  attempt(() => {
    const full = path.resolve(cwd, file)
    const was = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : ""
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    return diff(file, was, content)
  })

export interface Edit {
  readonly path: string
  readonly old: string
  readonly new: string
  readonly all?: boolean | undefined
}

// The edits, in order, each on its file as the edits before it left it.
// Every file is written only when all of them apply, so a failed edit
// changes no file. Each file, named as its first edit gives it, answers
// its diff.
export const edit = (cwd: string, edits: ReadonlyArray<Edit>): Effect.Effect<string, FileError> =>
  attempt(() => {
    const files = new Map<string, { shown: string; was: string; text: string }>()
    edits.forEach((one, k) => {
      const full = path.resolve(cwd, one.path)
      const known = files.get(full)
      const was = known?.was ?? (fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null)
      const text = known?.text ?? was ?? ""
      const count = one.old === "" ? 0 : text.split(one.old).length - 1
      const why = was === null
        ? "no such file"
        : count === 0
        ? "old was not found"
        : count > 1 && one.all !== true
        ? "old matches " + count + " times; give more context, or all"
        : null
      if (why !== null || was === null) {
        throw new FileError({ message: "Edit " + (k + 1) + " (" + one.path + "): " + why + ". No file was changed." })
      }
      files.set(full, { shown: known?.shown ?? one.path, was, text: text.split(one.old).join(one.new) })
    })
    if (files.size === 0) {
      throw new FileError({ message: "edits is empty: give a list of {path, old, new}." })
    }
    for (const [full, file] of files) {
      fs.writeFileSync(full, file.text)
    }
    return [...files.values()].map((file) => diff(file.shown, file.was, file.text)).join("\n")
  })
