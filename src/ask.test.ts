// Tests of the ask service: which failures it tries again, and how often.

import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { fakeWire, reply, wireError } from "../tests/help.ts"
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
  expect(wire.sent.length).toBe(3)
  expect(events.map((event) => event.type)).toEqual(["text", "end"])
  expect(events[1]).toMatchObject({ reply: { text: "third", cache: { verdict: "first" } } })
})

test("a failure that no try can help ends the request at once, patient or not", async () => {
  for (const kind of ["limit", "auth", "input", "policy"] as const) {
    for (const patient of [false, true]) {
      const wire = fakeWire(() => wireError(kind))
      const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request(), { patient }))), wire)
      expect(error.kind).toBe(kind)
      expect(wire.sent.length).toBe(1)
    }
  }
})

test("once the model has begun to answer, only a patient request is sent again", async () => {
  const cut = fakeWire((asked, n) => (n === 1 ? wireError("cut", { began: true }) : reply(asked)))
  const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request()))), cut)
  expect(error).toMatchObject({ kind: "cut", began: true })
  expect(cut.sent.length).toBe(1)
  const patient = fakeWire((asked, n) => (n === 1 ? wireError("cut", { began: true }) : reply(asked)))
  expect((await run(Ask.use((ask) => ask.ask(request(), { patient: true })), patient)).text).toBe("a line")
  expect(patient.sent.length).toBe(2)
})

test("a turn's request is tried 5 times at most, and a patient one until it is answered", async () => {
  const down = fakeWire(() => wireError("busy"))
  const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request()))), down)
  expect(error.kind).toBe("busy")
  expect(down.sent.length).toBe(TRIES)
  const long = fakeWire((asked, n) => (n < 40 ? wireError("busy") : reply(asked)))
  await run(Ask.use((ask) => ask.ask(request(), { patient: true })), long)
  expect(long.sent.length).toBe(40)
})

test("when the vendor names a time to wait, the next try comes after it", async () => {
  const wire = fakeWire((asked, n) => (n === 1 ? wireError("busy", { after: 7 }) : reply(asked)))
  await Effect.runPromise(
    Effect.gen(function*() {
      const ask = yield* Ask
      const asking = yield* Effect.forkChild(ask.ask(request()))
      yield* TestClock.adjust(6999)
      expect(wire.sent.length).toBe(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(asking)
      expect(wire.sent.length).toBe(2)
    }).pipe(Effect.provide(Layer.merge(Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer))), TestClock.layer())))
  )
})

test("a pick of a vendor with no wire is refused", async () => {
  const wire = fakeWire((asked) => reply(asked))
  const error = await run(Effect.flip(Ask.use((ask) => ask.ask(request({ pick: { vendor: "nobody", model: "m", effort: "low", speed: "slow" } })))), wire)
  expect(error).toMatchObject({ kind: "input", retry: false })
  expect(wire.sent.length).toBe(0)
})
