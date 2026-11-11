// Limit
// =====
// The output limit: the most text of a program's result that the model is
// shown (docs/schema.html, "The output limit"). The database keeps a result
// whole. When a result is over the limit:
//
// - the model gets its head and its tail, with a line between them that
//   says how much was left out and where the whole text is;
// - the whole text is written to a file, so that a program can read or
//   search it with `shell` and `read`;
// - `result(id)` gives the whole text to a program too, from the database.
//
// The file is a copy, not state. It is in a private directory under the
// system's temporary directory. When it is gone (after a reboot, for
// example), `result(id)` writes it again.
//
// The limit is on what the model reads, not on what a program gets: a
// function gives its whole result to the program that called it. A second,
// hard limit keeps a command that never stops printing from filling the
// memory and the database.

import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Store } from "./store.ts"

// The most characters of a result that the model is shown, when the config
// gives no other number. Three harnesses agree on about this size.
export const LIMIT = 30000

// The most bytes that one call may produce: the hard limit.
export const HARD = 64 * 1024 * 1024

// The characters that the line between the head and the tail may take.
const ROOM = 512

const bytes = (text: string) => Buffer.byteLength(text, "utf8")

// True when a cut at `at` would part the two halves of a surrogate pair.
const parts = (text: string, at: number) => at > 0 && at < text.length && text.charCodeAt(at) >> 10 === 0x37

// A result as the model is shown it: whole when it fits in `limit`
// characters, else its head and its tail (half each), with `where` in the
// line between them. `where` says how to get the whole text.
export const shorten = (text: string, limit: number, where: string): string => {
  if (text.length <= limit) {
    return text
  }
  const half = Math.floor(limit / 2)
  let head = half
  let tail = text.length - Math.max(0, half - ROOM)
  if (parts(text, head)) head -= 1
  if (parts(text, tail)) tail += 1
  const out = tail - head
  return text.slice(0, head) + "\n[... " + out + " of " + text.length + " characters left out. " + where + " ...]\n" + text.slice(tail)
}

// A text of at most `most` bytes: the start of `text`, never with half a
// character at its end.
export const capped = (text: string, most: number): string => {
  if (bytes(text) <= most) {
    return text
  }
  let [low, high] = [0, text.length]
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (bytes(text.slice(0, middle)) <= most) low = middle
    else high = middle - 1
  }
  return text.slice(0, parts(text, low) ? low - 1 : low)
}

export interface Shown {
  readonly text: string // what the model reads
  readonly shown: number // its bytes
}

export interface Options {
  readonly limit?: number | undefined // characters; the config file sets it
  readonly dir?: string | undefined // where the files go; a test gives its own
}

export class Limit extends Context.Service<Limit, {
  // A call's result as the model is shown it. A result over the limit is
  // shortened, and its whole text is written to the call's file. This never
  // fails: with no file, the line names only `result(id)`.
  show(call: number, text: string): Effect.Effect<Shown>
  // The path of a call's file, whether it exists or not.
  file(call: number): string
  // Writes a call's whole result to its file again. False: it could not.
  put(call: number, text: string): Effect.Effect<boolean>
}>()("everchat/limit/Limit") {
  static readonly layer = (options: Options = {}) =>
    Layer.effect(
      Limit,
      Effect.gen(function*() {
        const store = yield* Store
        const limit = options.limit ?? LIMIT
        const uid = process.getuid?.() ?? 0
        const dir = options.dir ?? path.join(os.tmpdir(), "everchat-" + uid, (yield* Effect.orDie(store.chat)).uuid)
        const file = (call: number) => path.join(dir, call + ".txt")

        // The directory is under a place that every user can write to. So
        // it is ours only if we own it and no one else can enter it, at
        // each level that we make.
        const ours = (at: string) => {
          fs.mkdirSync(at, { recursive: true, mode: 0o700 })
          const stat = fs.lstatSync(at)
          return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0
        }

        const put = (call: number, text: string) =>
          Effect.sync(() => {
            try {
              if (!(options.dir === undefined ? ours(path.dirname(dir)) && ours(dir) : ours(dir))) {
                return false
              }
              fs.writeFileSync(file(call), text, { mode: 0o600 })
              return true
            } catch {
              return false
            }
          })

        const show = Effect.fn("Limit.show")(function*(call: number, text: string) {
          if (text.length <= limit) {
            return { text, shown: bytes(text) }
          }
          const where = (yield* put(call, text))
            ? "The whole result is in the file " + file(call) + ", and result(" + call + ") gives it to a program."
            : "result(" + call + ") gives the whole result to a program."
          const short = shorten(text, limit, where)
          return { text: short, shown: bytes(short) }
        })

        return Limit.of({ show, file, put })
      })
    )
}
