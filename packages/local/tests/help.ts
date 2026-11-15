// Shared parts of the tests: a new home, a launch, and a run of an effect
// with the store.

import { Context, Effect, Exit, Layer, Scope, Semaphore, Stream } from "effect"
import * as path from "node:path"
import { Ask, AskDelay } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { Inspect } from "../src/inspect.ts"
import { Inspector } from "../src/inspector.ts"
import { limitLayer } from "../src/limitfile.ts"
import { DECLARATIONS } from "../src/localfunctions.ts"
import { OpenAI } from "@everchat/openai"
import { type Event, type Reply, type Request, type Wire, WireError } from "@everchat/core/request"
import { type Block, type Compaction, Compactor, type CompactorError, Memory, type Part } from "@everchat/core/memory"
import { Sandbox } from "@everchat/core/sandbox"
import { readsLayer, storeLayer } from "@everchat/sqlite/bun"
import { options } from "@everchat/sqlite/testing"
import { Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"

// The helpers of the store (`@everchat/sqlite/testing`), for the tests of
// this package and of the core.
export { newFile, options, PICK, rows, withStore, write } from "@everchat/sqlite/testing"

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
      Effect.provide(Memory.layer.pipe(Layer.provideMerge(storeLayer(file, options())), Layer.provide(compactor)))
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

// A reply of a fake wire.
export const reply = (asked: Request, over: Partial<Reply> = {}): Reply => ({
  output: [],
  text: "a line",
  calls: [],
  stop: "done",
  usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 5, searches: 0 },
  diagnosis: null,
  pick: asked.pick,
  id: "resp_1",
  request: "req_1",
  ...over
})

// A fake OpenAI wire: `answer` gives the reply to the n-th send (1, 2, ...),
// or the error it fails with. `sent` holds the requests.
export const fakeWire = (answer: (asked: Request, n: number) => Reply | WireError) => {
  const sent: Array<Request> = []
  const wire: Wire = {
    send: (asked) =>
      Stream.suspend(() => {
        sent.push(asked)
        const got = answer(asked, sent.length)
        return got instanceof WireError ? Stream.fail(got) : Stream.make<Array<Event>>({ type: "text", delta: got.text }, { type: "end", reply: got })
      })
  }
  return { sent, wire, layer: Layer.succeed(OpenAI, OpenAI.of(wire)) }
}

export const wireError = (kind: WireError["kind"], over: Partial<WireError> = {}) =>
  new WireError({ kind, message: "it failed", retry: kind === "busy" || kind === "cut", began: false, after: null, status: null, code: null, request: null, ...over })

// One launch of a whole chat with no real model: the store, the memory, the
// ask service over a fake wire, a fake sandbox (`run` gives a program's
// result), and the turn loop. `summaries` answers the compactions.
export const withChat = <A, E>(
  file: string,
  wire: ReturnType<typeof fakeWire>,
  run: (program: string) => Effect.Effect<{ output: string; failed: boolean }>,
  effect: Effect.Effect<A, E, Turns | Memory | Store>,
  summaries: Parameters<typeof compactor>[0] = () => "a summary"
) => {
  const store = storeLayer(file, options())
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(summaries)))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run }))
  const limit = limitLayer({ dir: path.join(path.dirname(file), "results") }).pipe(Layer.provide(store))
  const turns = Turns.layer({ declarations: DECLARATIONS }).pipe(Layer.provideMerge(memory), Layer.provide(Layer.mergeAll(asking, sandbox, limit)))
  return Effect.runPromise(effect.pipe(Effect.provide(turns), Effect.provideService(AskDelay, () => Effect.succeed(0))))
}

// The inspector over the chat in `file`, on a free port, until `close`.
export const inspector = async (file: string) => {
  const scope = Effect.runSync(Scope.make())
  const serving = Inspector.layer({ port: 0 }).pipe(Layer.provide(Inspect.layer), Layer.provide(readsLayer(file)))
  const context = await Effect.runPromise(Layer.buildWithScope(serving, scope))
  return { url: Context.get(context, Inspector).url, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}
