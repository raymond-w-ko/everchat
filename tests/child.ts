// A small program for the tests that need a real second process, or a real
// executable. Usage: `bun tests/child.ts <mode> <database file>`.
//
// - `count`: appends one message, prints `count <n>`, and ends cleanly.
// - `idle`: appends one message, prints `ready`, and waits with no
//   transaction open.
// - `hang`: writes one whole event, starts a second event, prints `ready`
//   in the middle of it, and waits there with the transaction open.

import { Effect } from "effect"
import { type Options, Store } from "../src/store.ts"

const [mode, file] = process.argv.slice(2)
if (mode === undefined || file === undefined) throw new Error("usage: child.ts <mode> <database file>")

const options: Options = {
  launch: { pid: process.pid, host: "test-host", cwd: process.cwd(), version: "0.0.0-test", runTag: "child" },
  pick: { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }
}

const say = (text: string) => Effect.sync(() => console.log(text))

const program = Effect.gen(function*() {
  const store = yield* Store
  if (mode === "count") {
    yield* store.append([{ kind: "user", text: "from the executable" }])
    yield* say(`count ${yield* store.count}`)
    return
  }
  yield* store.transaction(Effect.gen(function*() {
    yield* store.append([{ kind: "user", text: "whole" }])
    yield* store.putNodes([{ l: 0, i: 0, text: "user: whole" }])
  }))
  if (mode === "idle") {
    yield* say("ready")
    yield* Effect.sleep("1 hour")
    return
  }
  yield* store.transaction(Effect.gen(function*() {
    yield* store.append([{ kind: "asst", text: "half" }])
    yield* store.putNodes([{ l: 0, i: 1, text: "asst: half" }])
    yield* say("ready")
    yield* Effect.sleep("1 hour")
  }))
})

await Effect.runPromise(program.pipe(Effect.provide(Store.layer(file, options))))
