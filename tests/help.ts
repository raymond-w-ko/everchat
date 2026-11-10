// Shared parts of the tests: a new home, a launch, and a run of an effect
// with the store.

import { Database as Sqlite } from "bun:sqlite"
import { Effect, Layer, Semaphore } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as Database from "../src/database.ts"
import { type Block, type Compaction, Compactor, type CompactorError, Memory, type Part } from "../src/memory.ts"
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

// A compactor for tests: `line` gives the answer to one request.
export const compactor = (
  line: (blocks: ReadonlyArray<Block>, node: Part) => string | Compaction | Effect.Effect<Compaction, CompactorError>
) =>
  Layer.succeed(
    Compactor,
    Compactor.of({
      compact: (blocks, node) => {
        const got = line(blocks, node)
        return typeof got === "string" ? Effect.succeed({ text: got }) : Effect.isEffect(got) ? got : Effect.succeed(got)
      }
    })
  )

// Runs `effect` with the memory over the store over `file`: one launch.
export const withMemory = <A, E>(
  file: string,
  compactor: Layer.Layer<Compactor>,
  effect: Effect.Effect<A, E, Memory | Store>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Memory.layer.pipe(Layer.provideMerge(Store.layer(file, options())), Layer.provide(compactor)))
    )
  )

// A compactor that answers one request at a time, in the order asked, and
// gives the memory time to handle each answer before the next. The order in
// which compactions end changes the compactions' view, so a test that
// compares states needs a fixed order.
export const serialCompactor = (line: (blocks: ReadonlyArray<Block>, node: Part) => string) =>
  Layer.effect(
    Compactor,
    Effect.gen(function*() {
      const turn = yield* Semaphore.make(1)
      return Compactor.of({
        compact: (blocks, node) =>
          turn.withPermits(1)(Effect.gen(function*() {
            for (let k = 0; k < 50; k++) {
              yield* Effect.yieldNow
            }
            return { text: line(blocks, node) }
          }))
      })
    })
  )
