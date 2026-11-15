// The four run cases (tests/cases.ts) on the thread engine (thread.ts): a
// QuickJS engine in a worker thread of its own for each program. Then this
// engine's own case of the compute budget with functions at work at once.

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Functions } from "@everchat/core/functions"
import { Sandbox } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"
import { newFile, PICK, withStore } from "@everchat/sqlite/testing"
import { cases } from "../tests/cases.ts"
import { threadLayer } from "./thread.ts"

cases("thread", (limits) => threadLayer({ memory: limits.memory, compute: limits.compute }))

// A fake function: `slow(ms)` sleeps for `ms` milliseconds.
const slow = Layer.succeed(
  Functions,
  Functions.of({
    declarations: [{ name: "slow", signature: "(ms)", description: "slow" }],
    names: ["slow"],
    call: (_name, args) => Effect.sleep(args[0] as number).pipe(Effect.as("slept"))
  })
)

// The budget counts each stretch of compute with no function at work once,
// also when two functions start at once or overlap: the clock is disarmed
// at the first call and stays so until the last one ends. The program
// computes 3 times 50 ms with no function at work; the budget, 4 s, is far
// above that and the boot of the worker (which the clock counts too, at
// `arm()` in thread.ts). Between the start of `a` and of the next function,
// the program computes 4.5 s while `a` is at work: a clock that counted
// that span (a disarm that took the time since the last arm again, while
// already disarmed) uses the budget up, on any host.
const BUDGET = 4000
const program = [
  "const burn = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} }",
  "burn(50)",
  "await Promise.all([slow(100), slow(100)])",
  "burn(50)",
  "const a = slow(4700)",
  "burn(4500)",
  "await Promise.all([a, slow(100)])",
  "burn(50)",
  "return 'done'"
].join("\n")

test("thread: the budget counts each stretch once, with functions at work at once", async () => {
  const got = await withStore(
    newFile(),
    Effect.gen(function*() {
      const store = yield* Store
      const box = yield* Sandbox
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const call = yield* store.startCall({ turn: turn.id, vendorId: "call_0", fn: "run", input: program })
      return yield* box.run(program, { turn: turn.id, call })
    }).pipe(Effect.provide(threadLayer({ budget: BUDGET }).pipe(Layer.provide(slow))))
  )
  expect(got).toEqual({ output: "done", failed: false })
}, 30_000)
