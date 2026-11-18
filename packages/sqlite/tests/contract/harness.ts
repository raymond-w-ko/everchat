// The harness of the store's contract (packages/sqlite/AGENTS.md, "The
// contract's suites"): what a suite of cases needs of a store and of its
// database, so that one text of the cases runs on every store. SQLite's is
// `harness` of the package's test helpers (the entry `./testing`); a
// second store gives its own.
//
// This file imports `effect` and `@everchat/core/store`, and types only:
// nothing of a database. So do the suites beside it: what a case needs of
// the database comes from the harness.

import type { Effect, Scope } from "effect"
import type { Chats, LaunchInput, Options, Pick, Store } from "@everchat/core/store"

export const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }

// A launch's input for the tests, with `launch` over the fixed one.
export const options = (launch: Partial<LaunchInput> = {}): Options => ({
  launch: { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test", runTag: "tag", ...launch },
  pick: PICK
})

// The answer of the probe of a process: whether the process `pid` runs. A
// store with no probe does not read it.
export type Alive = (pid: number) => boolean

export interface Harness {
  // A new, empty database, by a name that only the harness reads (on
  // SQLite the file's path; on a server a schema's name). A case passes it
  // on and never reads it.
  readonly newFile: () => string
  // Runs `effect` with the store over the database `place`: one launch,
  // from its start to its end.
  readonly withStore: <A, E>(place: string, effect: Effect.Effect<A, E, Store>, opts?: Options, alive?: Alive) => Promise<A>
  // Runs `effect` with the tag `Chats` over `place`, in one scope: a store
  // that it takes ends its launch when the effect ends.
  readonly withChats: <A, E>(place: string, effect: Effect.Effect<A, E, Chats | Scope.Scope>, alive?: Alive) => Promise<A>
  // Plain SQL straight to the database, with no store: the rows of a
  // query (a blob as a `Uint8Array`), and a statement with its values.
  readonly rows: <A = Record<string, unknown>>(place: string, query: string) => Promise<Array<A>>
  readonly write: (place: string, statement: string, params?: Array<string | number>) => Promise<void>
  // A new database with every row of `from`, its ids too. No store may
  // have `from` open.
  readonly copy: (from: string) => Promise<string>
  // What the store has: `version`, whether `Reads.version` gives a number.
  // A case that reads it is registered with `test.skipIf(!h.has.version)`.
  readonly has: { readonly version: boolean }
}
