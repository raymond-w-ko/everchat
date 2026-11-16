// Shared parts of the tests of the store, and of the packages that need a
// real store in their tests: a new home, a launch, a run of an effect with
// the store or with the tag of a deployment, and reads and writes straight
// to the file.

import { Database as Sqlite } from "bun:sqlite"
import { afterAll } from "bun:test"
import { Effect, type Scope } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as Database from "../src/database.ts"
import { chatsLayer, ProcessAlive, storeLayer } from "../src/sqlite.ts"
import { type Chats, type LaunchInput, type Options, type Pick, Store } from "@everchat/core/store"

export const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }

// The temporary root, when no preload made one. A `bun test` started at
// the repository's root loads `tools/tmproot.ts` (bunfig.toml), which sets
// TMPDIR to a root of the run, `everchat-run-*`, and removes it at the end.
// Bun reads bunfig.toml only in the directory where `bun test` starts, so a
// run started in a package's directory, or in a copy with no bunfig.toml,
// has no such root; nor has a plain `bun <script>.ts`. There, this file
// makes the root itself, as the preload does, and removes it at the end
// that it can see: the end of the test file that loaded it (an `afterAll`),
// or the exit of a script (SIGINT and SIGTERM too). Several files in one
// process with no `--isolate`, or a file under `--rerun-each`, load this
// file once: its `afterAll` runs at the end of the first file or pass, and
// the next `newFile` makes a root again, which stays: one directory for the
// run, not one for each case.
const RUN = "everchat-run-"
let own: string | undefined
// TMPDIR as it was before this file set it to `own`.
let before: string | undefined

const remove = (): void => {
  if (own === undefined) return
  try {
    fs.rmSync(own, { recursive: true, force: true })
  } catch {
    // A root that stays is no failure of a case.
  }
  // Give TMPDIR back only when it is still ours: a case that set its own
  // keeps it.
  if (process.env.TMPDIR === own) {
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
  }
  own = undefined
}

const root = (): void => {
  if (own !== undefined) {
    if (fs.existsSync(own)) return
    // Removed by someone else: give TMPDIR back, and make it again.
    remove()
  }
  if (path.basename(os.tmpdir()).startsWith(RUN)) return
  before = process.env.TMPDIR
  own = fs.mkdtempSync(path.join(os.tmpdir(), RUN))
  process.env.TMPDIR = own
}

root()
try {
  afterAll(remove)
} catch {
  // Not under `bun test`: a script.
  process.on("exit", remove)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const end = (): void => {
      remove()
      process.removeListener(signal, end)
      process.kill(process.pid, signal)
    }
    process.on(signal, end)
  }
}

// The path of the database in a new, empty home, under the run's root.
export const newFile = () => {
  root()
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-test-")), Database.FILE)
}

export const options = (launch: Partial<LaunchInput> = {}): Options => ({
  launch: { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test", runTag: "tag", ...launch },
  pick: PICK
})

// Runs `effect` with the store over `file`: one launch, from its start to
// its end. `alive` replaces the check for a process that still runs.
export const withStore = <A, E>(
  file: string,
  effect: Effect.Effect<A, E, Store>,
  opts: Options = options(),
  alive?: (pid: number) => boolean
) => {
  const run = effect.pipe(Effect.provide(storeLayer(file, opts)))
  return Effect.runPromise(alive === undefined ? run : Effect.provideService(run, ProcessAlive, alive))
}

// Runs `effect` with the tag `Chats` over `file`, in one scope: a store
// that it takes ends its launch when the effect ends. `alive` as in
// `withStore`.
export const withChats = <A, E>(
  file: string,
  effect: Effect.Effect<A, E, Chats | Scope.Scope>,
  alive?: (pid: number) => boolean
) => {
  const run = effect.pipe(Effect.scoped, Effect.provide(chatsLayer(file)))
  return Effect.runPromise(alive === undefined ? run : Effect.provideService(run, ProcessAlive, alive))
}

// Reads rows straight from the file, with no store. Use it only when no
// store has the file open.
export const rows = <A = Record<string, unknown>>(file: string, query: string): Array<A> => {
  const db = new Sqlite(file, { readonly: true })
  try {
    return db.query(query).all() as Array<A>
  } finally {
    db.close()
  }
}

// Writes straight to the file, with no store. Use it to build a state that
// the store itself never leaves behind.
export const write = (file: string, statement: string, params: Array<string | number> = []) => {
  const db = new Sqlite(file)
  try {
    db.run(statement, params)
  } finally {
    db.close()
  }
}
