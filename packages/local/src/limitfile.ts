// Limit files
// ===========
// The layer of the output limit (limit.ts) for a local chat: it writes the
// whole text of a long result to a file, so that a program can read or
// search it with `shell` and `read`.
//
// The file is a copy, not state. It is in a private directory under the
// system's temporary directory. When it is gone (after a reboot, for
// example), `result(id)` writes it again.

import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { bytes, Limit, LIMIT, shorten } from "@everchat/core/limit"
import { Store } from "@everchat/core/store"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "limit")

export interface Options {
  readonly limit?: number | undefined // characters; the config file sets it
  readonly dir?: string | undefined // where the files go; a test gives its own
}

export const limitLayer = (options: Options = {}) =>
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
        const written = yield* put(call, text)
        if (!written) {
          yield* diagnostic(Effect.logWarning(`the whole result of call ${call} could not be written to ${file(call)}`))
        }
        const where = written
          ? "The whole result is in the file " + file(call) + ", and result(" + call + ") gives it to a program."
          : "result(" + call + ") gives the whole result to a program."
        const short = shorten(text, limit, where)
        return { text: short, shown: bytes(short) }
      })

      return Limit.of({ show, file, put })
    })
  )
