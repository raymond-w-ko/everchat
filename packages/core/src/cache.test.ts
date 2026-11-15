// Tests of the watch on the prompt cache: what a request should read, and
// the verdict of its reply.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Clock, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ALIVE, Cache, GAIN, judge, LOOK, MIN, parts, READY, WORTH } from "./cache.ts"
import { type Block, type Event, type Reply, type Request, type Usage, type Wire, WireError } from "./request.ts"

const blocks = (n: number): Array<Block> => Array.from({ length: n }, (_, k) => ({ text: `block ${k} ` + "x".repeat(1000) + "\n", mark: k === n - 1 }))

const request = (n: number, over: Partial<Request> = {}): Request => ({
  session: "chat-1",
  pick: { vendor: "openai", model: "m", effort: "low", speed: "slow" },
  head: { system: "s".repeat(4000), tools: [{ name: "run", description: "d" }] },
  items: [{ kind: "user", blocks: [...blocks(n), { text: "user: hi " + n, mark: false }] }],
  ...over
})

const usage = (input: number, cacheRead: number): Usage => ({ input, cacheRead, cacheWrite: 0, output: 5, searches: 0 })

const run = <A>(effect: Effect.Effect<A, unknown, Cache>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(Cache.layer, TestClock.layer()))))

test("the parts of a request are its head with all that the vendor matches, then each block and item", () => {
  const one = parts(request(2))
  assert.equal(one.length, 4)
  assert.deepStrictEqual(one.slice(1), ["block 0 " + "x".repeat(1000) + "\n", "block 1 " + "x".repeat(1000) + "\n", "user: hi 2"])
  for (const other of [{ session: "chat-2" }, { pick: { ...request(2).pick, speed: "fast" } }, { pick: { ...request(2).pick, effort: "high" } }, { head: { system: "other", tools: [] } }]) {
    assert.notEqual(parts(request(2, other))[0], one[0])
  }
  const turn = parts(request(1, { items: [{ kind: "turn", output: [{ id: "a" }, { id: "b" }] }, { kind: "back", results: [{ id: "c", output: "2" }] }] }))
  assert.deepStrictEqual(turn.slice(1), ["{\"id\":\"a\"}", "{\"id\":\"b\"}", "[\"c\",\"2\",0]"])
})

test("a picture's part is its type and the SHA-256 of its bytes, in hex: the cache's fingerprints depend on these bytes", () => {
  const pictures = [{ type: "image/png", bytes: new Uint8Array([0, 1, 2, 250, 251, 255]) }]
  const one = parts(request(0, { items: [{ kind: "user", blocks: [{ text: "user: see", mark: false }], pictures }] }))
  assert.deepStrictEqual(one.slice(1), ["user: see", "image/png:8a093e615781748bc6c04956a5a729eddd74643ddaf3da4afdf3da3a1801750f"])
})

test("a request should read the longest prefix that an earlier request sent, once that one is old enough", async () => {
  await run(Effect.gen(function*() {
    const cache = yield* Cache
    const first = yield* cache.expect(request(8))
    assert.partialDeepStrictEqual({ ...first }, { bytes: 0, age: null })
    assert.ok(first.total > 12000)
    // Too soon: the entry of the first request is not readable yet.
    yield* TestClock.adjust(READY - 1)
    assert.equal((yield* cache.expect(request(9))).bytes, 0)
    yield* TestClock.adjust(1)
    const grown = yield* cache.expect(request(9))
    // The head and the 8 blocks that the first request had.
    assert.equal(grown.bytes, parts(request(8)).slice(0, 9).reduce((n, part) => n + Buffer.byteLength(part), 0))
    assert.equal(grown.age, READY)
    // Another view under the same head should read the head only.
    yield* TestClock.adjust(READY)
    const other = request(8)
    const changed = { ...other, items: [{ kind: "user" as const, blocks: [{ text: "another view", mark: true }] }] }
    assert.equal((yield* cache.expect(changed)).bytes, Buffer.byteLength(parts(other)[0]!))
    // Another chat, or another speed, should read nothing.
    assert.equal((yield* cache.expect(request(8, { session: "chat-2" }))).bytes, 0)
    assert.equal((yield* cache.expect(request(8, { pick: { ...other.pick, speed: "fast" } }))).bytes, 0)
  }))
})

test("a prefix that no request sent for 30 minutes is expected no more, and one that was read lives on", async () => {
  await run(Effect.gen(function*() {
    const cache = yield* Cache
    yield* cache.expect(request(8))
    yield* TestClock.adjust(ALIVE - 1000)
    assert.ok((yield* cache.expect(request(8))).bytes > 0) // this request sends it again
    yield* TestClock.adjust(ALIVE - 1000)
    assert.ok((yield* cache.expect(request(8))).bytes > 0)
    yield* TestClock.adjust(ALIVE + 1)
    assert.equal((yield* cache.expect(request(8))).bytes, 0)
  }))
})

test("requests that come together do not push back the time at which their prefix is ready", async () => {
  await run(Effect.gen(function*() {
    const cache = yield* Cache
    yield* cache.expect(request(8))
    yield* TestClock.adjust(READY - 1000)
    yield* cache.expect(request(8)) // too soon to read, and it must not reset the clock
    yield* TestClock.adjust(1000)
    assert.equal((yield* cache.expect(request(8))).age, READY)
  }))
})

test("a reply is first, a hit, a partial read, or a miss", () => {
  const expectation = { bytes: 9000, total: 10000, age: 6000 }
  // 13,000 tokens in all, so about 11,700 should come from the cache.
  assert.deepStrictEqual(judge(expectation, usage(1300, 11700)), { verdict: "hit", expected: 11700, read: 11700 })
  assert.equal(judge(expectation, usage(1560, 11440)).verdict, "hit") // the vendor caches in steps of 128 tokens
  assert.deepStrictEqual(judge(expectation, usage(10440, 2560)), { verdict: "partial", expected: 11700, read: 2560 })
  assert.deepStrictEqual(judge(expectation, usage(13000, 0)), { verdict: "miss", expected: 11700, read: 0 })
  assert.equal(judge({ bytes: 0, total: 10000, age: null }, usage(13000, 0)).verdict, "first")
  // A small part that is not read is not a miss; one that is read is a hit.
  assert.deepStrictEqual(judge({ bytes: 1500, total: 10000, age: 6000 }, usage(13000, 0)), { verdict: "small", expected: 1950, read: 0 })
  assert.equal(judge({ bytes: 1500, total: 10000, age: 6000 }, usage(11720, 1280)).verdict, "hit")
  assert.equal(judge({ bytes: 1600, total: 10000, age: 6000 }, usage(13000, 0)).verdict, "miss") // 2,080 tokens: counted on
  assert.equal(WORTH, 2048)
  // A prefix shorter than the vendor's minimum is never cached: no miss.
  assert.deepStrictEqual(judge({ bytes: 700, total: 10000, age: 6000 }, usage(13000, 0)), { verdict: "first", expected: 910, read: 0 })
  assert.equal(MIN, 1024)
})

test("a watched wire puts its judgment in the reply, and logs a miss", async () => {
  const reads = [0, 12000, 0]
  const fake: Wire = {
    send: (asked) => {
      const reply: Reply = { output: [], text: "ok", calls: [], stop: "done", usage: usage(13000 - reads[0]!, reads.shift()!), diagnosis: null, pick: asked.pick, id: "resp_1", request: "req_1" }
      return Stream.make<Array<Event>>({ type: "text", delta: "ok" }, { type: "end", reply })
    }
  }
  const judged = await run(Effect.gen(function*() {
    const cache = yield* Cache
    const wire = cache.watch(fake)
    const out: Array<unknown> = []
    for (let k = 0; k < 3; k++) {
      const events = yield* Stream.runCollect(wire.send(request(8)))
      assert.deepStrictEqual(events[0], { type: "text", delta: "ok" })
      const last = events[events.length - 1]!
      out.push(last.type === "end" ? last.reply.cache : null)
      yield* TestClock.adjust(READY)
    }
    return out
  }))
  assert.deepStrictEqual(judged, [
    { verdict: "first", expected: 0, read: 0 },
    // The same request again: all of it should come from the cache.
    { verdict: "hit", expected: 13000, read: 12000 },
    { verdict: "miss", expected: 13000, read: 0 }
  ])
})

// Single flight
// -------------

test("a request that can wait does so until a long prefix of its own is readable; a turn goes at once", async () => {
  const times: Array<[string, number]> = []
  const fake: Wire = {
    send: (asked) =>
      Stream.unwrap(Effect.map(Clock.currentTimeMillis, (now) => {
        times.push([asked.session + "/" + (asked.items[0] as any).blocks.length, now])
        const reply: Reply = { output: [], text: "ok", calls: [], stop: "done", usage: usage(13000, 0), diagnosis: null, pick: asked.pick, id: "r", request: "q" }
        return Stream.make<Array<Event>>({ type: "end", reply })
      }))
  }
  await run(Effect.gen(function*() {
    const cache = yield* Cache
    const go = (asked: Request, patient: boolean) => Effect.forkChild(Stream.runDrain(cache.send(fake, asked, patient)))
    yield* go(request(8), true) // the first of its kind: it goes
    yield* TestClock.adjust(1000)
    const follower = yield* go(request(9), true) // 8 of its blocks were sent 1 s ago: it waits
    const turn = yield* go(request(10), false) // a turn does not wait
    const other = yield* go(request(8, { session: "chat-2" }), true) // another chat shares nothing
    yield* TestClock.adjust(READY - 1001)
    assert.deepStrictEqual(times.map(([name]) => name), ["chat-1/9", "chat-1/11", "chat-2/9"])
    yield* TestClock.adjust(1)
    yield* Fiber.join(follower)
    yield* Fiber.join(turn)
    yield* Fiber.join(other)
  }))
  assert.deepStrictEqual(times, [["chat-1/9", 0], ["chat-1/11", 1000], ["chat-2/9", 1000], ["chat-1/10", READY]])
})

test("a request does not wait for a gain of a few lines", async () => {
  const sends: Array<number> = []
  const fake: Wire = {
    send: (asked) =>
      Stream.unwrap(Effect.map(Clock.currentTimeMillis, (now) => {
        sends.push(now)
        const reply: Reply = { output: [], text: "ok", calls: [], stop: "done", usage: usage(13000, 0), diagnosis: null, pick: asked.pick, id: "r", request: "q" }
        return Stream.make<Array<Event>>({ type: "end", reply })
      }))
  }
  await run(Effect.gen(function*() {
    const cache = yield* Cache
    yield* Stream.runDrain(cache.send(fake, request(8), true))
    yield* TestClock.adjust(READY) // all of the first request is readable now
    yield* Stream.runDrain(cache.send(fake, request(9), true)) // it adds one block of about 1 KB
    yield* TestClock.adjust(1000)
    // One more block, sent 1 s ago, is less than GAIN bytes: no wait.
    yield* Stream.runDrain(cache.send(fake, request(10), true))
  }))
  assert.deepStrictEqual(sends, [0, READY, READY + 1000])
  assert.equal(GAIN, 4096)
})

test("a request that failed before the model began is forgotten: the next one does not wait for it", async () => {
  const sends: Array<number> = []
  let n = 0
  const fake: Wire = {
    send: (asked) =>
      Stream.unwrap(Effect.map(Clock.currentTimeMillis, (now) => {
        sends.push(now)
        if (++n === 1) {
          return Stream.fail(new WireError({ kind: "busy", message: "down", retry: true, began: false, after: null, status: 503, code: null, request: null }))
        }
        const reply: Reply = { output: [], text: "ok", calls: [], stop: "done", usage: usage(13000, 0), diagnosis: null, pick: asked.pick, id: "r", request: "q" }
        return Stream.make<Array<Event>>({ type: "end", reply })
      }))
  }
  await run(Effect.gen(function*() {
    const cache = yield* Cache
    yield* Effect.flip(Stream.runDrain(cache.send(fake, request(8), true)))
    yield* TestClock.adjust(1000)
    yield* Stream.runDrain(cache.send(fake, request(8), true)) // the same request again, 1 s later
  }))
  assert.deepStrictEqual(sends, [0, 1000])
})


test("a request waits for the end of the first reply when that comes later than READY, and an interrupt ends the wait", async () => {
  const sends: Array<[number, number]> = []
  const slow = (seconds: number): Wire => ({
    send: (asked) =>
      Stream.unwrap(Effect.gen(function*() {
        sends.push([(asked.items[0] as any).blocks.length, yield* Clock.currentTimeMillis])
        yield* Effect.sleep(seconds * 1000)
        const reply: Reply = { output: [], text: "ok", calls: [], stop: "done", usage: usage(13000, 0), diagnosis: null, pick: asked.pick, id: "r", request: "q" }
        return Stream.make<Array<Event>>({ type: "end", reply })
      }))
  })
  await run(Effect.gen(function*() {
    const cache = yield* Cache
    const first = yield* Effect.forkChild(Stream.runDrain(cache.send(slow(8), request(8), true)))
    yield* TestClock.adjust(100)
    const follower = yield* Effect.forkChild(Stream.runDrain(cache.send(slow(0), request(8), true)))
    yield* TestClock.adjust(READY + 1000) // past READY: the first request still runs
    assert.equal(sends.length, 1)
    yield* TestClock.adjust(2000) // the first reply ends at 8 s
    yield* Fiber.join(first)
    yield* TestClock.adjust(LOOK)
    yield* Fiber.join(follower)
    assert.ok(sends[1]![1] >= 8000)
    assert.ok(sends[1]![1] <= 8000 + LOOK)

    // A request that is interrupted is closed too: the next one goes, READY after it was sent.
    const cut = yield* Effect.forkChild(Stream.runDrain(cache.send(slow(3600), request(8, { session: "chat-3" }), true)))
    yield* TestClock.adjust(1000)
    yield* Fiber.interrupt(cut)
    const next = yield* Effect.forkChild(Stream.runDrain(cache.send(slow(0), request(8, { session: "chat-3" }), true)))
    yield* TestClock.adjust(READY)
    yield* Fiber.join(next)
  }))
  assert.equal(sends.length, 4)
})
