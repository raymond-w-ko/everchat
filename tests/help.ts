// Shared parts of the tests: a new home, a launch, and a run of an effect
// with the store.

import { Database as Sqlite } from "bun:sqlite"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as Database from "../src/database.ts"
import { type LaunchInput, type Options, type Pick, ProcessAlive, Store } from "../src/store.ts"

export const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }

// The path of the database in a new, empty home.
export const newFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-test-")), Database.FILE)

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
  const run = effect.pipe(Effect.provide(Store.layer(file, opts)))
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
