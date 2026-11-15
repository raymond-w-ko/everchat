// Tests of the ask service: which failures it tries again, and how often.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { fakeWire, reply, wireError } from "@everchat/local/testing"
import { Ask, AskDelay, TRIES } from "./ask.ts"
import { Cache } from "./cache.ts"
import type { Request } from "./request.ts"

const request = (over: Partial<Request> = {}): Request => ({
  session: "chat-1",
  pick: { vendor: "openai", model: "m", effort: "low", speed: "slow" },
  head: { system: "s", tools: [] },
  items: [{ kind: "user", blocks: [{ text: "user: hi", mark: false }] }],
  ...over
})

const run = <A, E>(effect: Effect.Effect<A, E, Ask>, wire: ReturnType<typeof fakeWire>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))),
      Effect.provideService(AskDelay, () => Effect.succeed(0))
    )
  )

test("a request that fails as busy is sent again, and the reply of the try that worked is the result", async () => {
  const wire = fakeWire((asked, n) => (n < 3 ? wireError("busy") : reply(asked, { text: "third" })))
  const events = await run(Ask.use((ask) => Stream.runCollect(ask.stream(request()))), wire)
  assert.equal(wire.sent.length, 3)
  assert.deepStrictEqual(events.map((event) => event.type), ["text", "end"])
  assert.partialDeepStrictEqual({ ...events[1] }, { reply: { text: "third", cache: { verdict: "first" } } })
})

test("a failure that no try can help ends the request at once, patient or not", async () => {
  for (const kind of ["limit", "auth", "input", "policy"] as const) {
    for (const patient of [false, true]) {
      const wire = fakeWire(() => wireError(kind))
      const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request(), { patient }))), wire)
      assert.equal(error.kind, kind)
      assert.equal(wire.sent.length, 1)
    }
  }
})

test("once the model has begun to answer, only a patient request is sent again", async () => {
  const cut = fakeWire((asked, n) => (n === 1 ? wireError("cut", { began: true }) : reply(asked)))
  const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request()))), cut)
  assert.partialDeepStrictEqual({ ...error }, { kind: "cut", began: true })
  assert.equal(cut.sent.length, 1)
  const patient = fakeWire((asked, n) => (n === 1 ? wireError("cut", { began: true }) : reply(asked)))
  assert.equal((await run(Ask.use((ask) => ask.ask(request(), { patient: true })), patient)).text, "a line")
  assert.equal(patient.sent.length, 2)
})

test("a turn's request is tried 5 times at most, and a patient one until it is answered", async () => {
  const down = fakeWire(() => wireError("busy"))
  const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request()))), down)
  assert.equal(error.kind, "busy")
  assert.equal(down.sent.length, TRIES)
  const long = fakeWire((asked, n) => (n < 40 ? wireError("busy") : reply(asked)))
  await run(Ask.use((ask) => ask.ask(request(), { patient: true })), long)
  assert.equal(long.sent.length, 40)
})

test("when the vendor names a time to wait, the next try comes after it", async () => {
  const wire = fakeWire((asked, n) => (n === 1 ? wireError("busy", { after: 7 }) : reply(asked)))
  await Effect.runPromise(
    Effect.gen(function*() {
      const ask = yield* Ask
      const asking = yield* Effect.forkChild(ask.ask(request()))
      yield* TestClock.adjust(6999)
      assert.equal(wire.sent.length, 1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(asking)
      assert.equal(wire.sent.length, 2)
    }).pipe(Effect.provide(Layer.merge(Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer))), TestClock.layer())))
  )
})

test("a pick of a vendor with no wire is refused", async () => {
  const wire = fakeWire((asked) => reply(asked))
  const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request({ pick: { vendor: "nobody", model: "m", effort: "low", speed: "slow" } })))), wire)
  assert.partialDeepStrictEqual({ ...error }, { kind: "input", retry: false })
  assert.equal(wire.sent.length, 0)
})
