// Tests of the places of `reads` and of a client's first read with its join
// (reads.ts; docs/host.md, section 2, "The give"; section 3, "Admission",
// 11; section 8, the rows `reads` and "room for a page"; lead, ec-jyjxm).
// The events come from the SQLite store of a test file, or from a read over
// an array where a case needs a fault or a step between two reads. Each
// time is the TestClock's.

import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { type Event, Store, StoreError } from "@everchat/core/store"
import { newFile, options } from "@everchat/local/testing"
import { storeLayer } from "@everchat/sqlite/bun"
import { type Channel, type ChannelLimits, type Client, makeRegistry } from "./channel.ts"
import { type Entry, fit } from "./fit.ts"
import { DEFAULTS } from "./limits.ts"
import { firstRead, makeReads, type ReadLimits, type ReadPlaces, ReadsBusy } from "./reads.ts"

const TENANT = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const CHAT = "11111111-1111-4111-8111-111111111111"

// The host's limits, and a channel's and a first read's part of them.
type Small = ChannelLimits & ReadLimits
const LIMITS: Small = {
  buffer: DEFAULTS.buffer,
  bufferBytes: DEFAULTS.bufferBytes,
  entry: DEFAULTS.entry,
  page: DEFAULTS.page,
  pageBytes: DEFAULTS.pageBytes,
  chatClients: DEFAULTS.chatClients,
  hostClients: DEFAULTS.hostClients,
  room: DEFAULTS.room
}
const PLACES = { reads: DEFAULTS.reads, readsWait: DEFAULTS.readsWait }

// Runs `effect` on the TestClock.
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.provide(effect, TestClock.layer()))

// Lets the other fibers run, with no time passing: enough yields for a
// woken fiber to reach its next wait.
const settle = Effect.forEach(Array.from({ length: 200 }), () => Effect.yieldNow, { discard: true })

// What `fiber` gave, or "running".
const poll = <A, E>(fiber: Fiber.Fiber<A, E>) => {
  const exit = fiber.pollUnsafe()
  return exit === undefined ? "running" : exit
}

// The numbered event `n`, as the store gives it, and its entry.
const start = (n: number): Event => ({ type: "start", n, turn: 1 })
const entryOf = (event: Event, limit = LIMITS.entry): Entry => fit(event, limit) as Entry

// A read over the events `events` (`eventsAfter`'s contract), with
// `before(after, call)` run before each call (its count from 0).
const over = (events: ReadonlyArray<Event>, before: (after: number, call: number) => Effect.Effect<void> = () => Effect.void) => {
  let calls = 0
  const read = (after: number, limit: number): Effect.Effect<ReadonlyArray<Event>, StoreError> =>
    Effect.andThen(before(after, calls++), Effect.sync(() => events.filter((event) => event.n > after).slice(0, limit)))
  return { read, calls: () => calls }
}

// Everything in a client's buffer now, with no wait: the reader's side.
const drain = (client: Client) =>
  Effect.gen(function*() {
    const texts: Array<string> = []
    while (client.size.entries > 0) {
      const taken = yield* client.take
      if (taken._tag === "Text") texts.push(taken.text)
    }
    return texts
  })
// The next `count` texts of a client's buffer, as its reader takes them.
const takeSome = (client: Client, count: number) =>
  Effect.gen(function*() {
    const texts: Array<string> = []
    while (texts.length < count) {
      const taken = yield* client.take
      if (taken._tag === "End") break
      texts.push(taken.text)
    }
    return texts
  })
// The numbers of the texts that are events; a host's frame is "frame".
const numbers = (texts: ReadonlyArray<string>) => texts.map((text) => (text.startsWith("{") ? (JSON.parse(text) as { n: number }).n : text))
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k)

// A channel with `limits`, and a client of it with `given`.
const clientOf = (limits: Small, given = 0) =>
  Effect.gen(function*() {
    const registry = makeRegistry(limits)
    const channel: Channel = yield* registry.hold(TENANT, CHAT)
    const client = yield* channel.addClient(given)
    return { channel, client }
  })

// The first read of `client`, forked.
const fork = (channel: Channel, client: Client, read: (after: number, limit: number) => Effect.Effect<ReadonlyArray<Event>, StoreError>, places: ReadPlaces, limits: Small = LIMITS) =>
  Effect.forkChild(firstRead({ channel, client, read, places, limits }))

// A store of a new file with `count` events, numbered from 1, each a
// `start` of one turn; `effect` runs with it.
const withEvents = <A, E>(count: number, effect: (store: typeof Store.Service) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const store = yield* Store
    yield* store.transaction(Effect.gen(function*() {
      const turn = yield* store.startTurn({ pick: options().pick, head: "{}", firstMsg: 0 })
      for (let k = 0; k < count; k++) yield* store.addEvent({ type: "start", turn: turn.id })
    }))
    return yield* effect(store)
  }).pipe(Effect.provide(storeLayer(newFile(), options())))

// An effect that holds a place until `gate` is done.
const holder = (places: ReadPlaces, gate: Deferred.Deferred<void>) => Effect.forkChild(places.withPlace(Deferred.await(gate)))

// The places
// ----------

test("the 17th effect waits, and runs when a place is free", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads(PLACES)
    const gates = yield* Effect.forEach(range(1, 16), () => Deferred.make<void>())
    yield* Effect.forEach(gates, (gate) => holder(places, gate))
    yield* settle
    expect(places.taken()).toBe(16)
    const seventeenth = yield* Effect.forkChild(places.withPlace(Effect.succeed("ran")))
    yield* settle
    expect({ taken: places.taken(), waiting: places.waiting(), seventeenth: poll(seventeenth) }).toEqual({ taken: 16, waiting: 1, seventeenth: "running" })
    yield* Deferred.succeed(gates[0]!, undefined)
    expect(yield* Fiber.join(seventeenth)).toBe("ran")
    yield* settle
    expect({ taken: places.taken(), waiting: places.waiting() }).toEqual({ taken: 15, waiting: 0 })
    yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined))
    yield* settle
    expect(places.taken()).toBe(0)
  }))
})

test("three waiters run in the order of their coming, and a first read takes its turn again behind them for its next page", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads({ ...PLACES, reads: 1 })
    const order: Array<string> = []
    const gate = yield* Deferred.make<void>()
    const limits: Small = { ...LIMITS, page: 2 }
    const { channel, client } = yield* clientOf(limits)
    const { read } = over(range(1, 4).map(start), (after, call) =>
      Effect.andThen(Effect.sync(() => order.push(`read after ${after}`)), call === 0 ? Deferred.await(gate) : Effect.void))
    const reader = yield* fork(channel, client, read, places, limits)
    yield* settle
    expect(places.taken()).toBe(1)
    for (const name of ["first", "second", "third"]) {
      yield* Effect.forkChild(places.withPlace(Effect.sync(() => order.push(name))))
      yield* settle
    }
    expect(places.waiting()).toBe(3)
    yield* Deferred.succeed(gate, undefined)
    expect(yield* Fiber.join(reader)).toEqual({ _tag: "Joined" })
    expect(order).toEqual(["read after 0", "first", "second", "third", "read after 2", "read after 4"])
    expect(numbers(yield* drain(client))).toEqual([1, 2, 3, 4])
    expect(places.taken()).toBe(0)
  }))
})

test("a wait past readsWait fails with ReadsBusy at 30 s, and the queue goes on", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads({ ...PLACES, reads: 1 })
    const gate = yield* Deferred.make<void>()
    yield* holder(places, gate)
    yield* settle
    const first = yield* Effect.forkChild(places.withPlace(Effect.succeed("first")))
    yield* TestClock.adjust(10_000)
    const second = yield* Effect.forkChild(places.withPlace(Effect.succeed("second")))
    yield* settle
    expect(places.waiting()).toBe(2)
    yield* TestClock.adjust(19_999)
    yield* settle
    expect(poll(first)).toBe("running")
    yield* TestClock.adjust(1)
    yield* settle
    const failed = poll(first)
    expect(failed !== "running" && Exit.isFailure(failed)).toBe(true)
    expect(yield* Effect.flip(Fiber.join(first))).toEqual(new ReadsBusy({ waited: 30_000 }))
    expect({ taken: places.taken(), waiting: places.waiting(), second: poll(second) }).toEqual({ taken: 1, waiting: 1, second: "running" })
    yield* Deferred.succeed(gate, undefined)
    expect(yield* Fiber.join(second)).toBe("second")
    yield* settle
    expect({ taken: places.taken(), waiting: places.waiting() }).toEqual({ taken: 0, waiting: 0 })
  }))
})

test("an interrupted waiter takes no place and loses none: after it, 16 run at one time again", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads(PLACES)
    const gates = yield* Effect.forEach(range(1, 16), () => Deferred.make<void>())
    yield* Effect.forEach(gates, (gate) => holder(places, gate))
    yield* settle
    const ran: Array<string> = []
    const waiter = yield* Effect.forkChild(places.withPlace(Effect.sync(() => ran.push("waiter"))))
    yield* settle
    expect(places.waiting()).toBe(1)
    yield* Fiber.interrupt(waiter)
    expect({ taken: places.taken(), waiting: places.waiting() }).toEqual({ taken: 16, waiting: 0 })
    yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined))
    yield* settle
    expect({ taken: places.taken(), ran }).toEqual({ taken: 0, ran: [] })
    // Again: 16 at one time, and the 17th waits.
    const again = yield* Effect.forEach(range(1, 17), () => Deferred.make<void>())
    yield* Effect.forEach(again, (gate) => holder(places, gate))
    yield* settle
    expect({ taken: places.taken(), waiting: places.waiting() }).toEqual({ taken: 16, waiting: 1 })
    yield* Effect.forEach(again, (gate) => Deferred.succeed(gate, undefined))
    yield* settle
    expect({ taken: places.taken(), waiting: places.waiting() }).toEqual({ taken: 0, waiting: 0 })
  }))
})

test("a place goes back after a failure and after an interruption, and only when the effect has ended", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads({ ...PLACES, reads: 1 })
    // A failure.
    expect(yield* Effect.flip(places.withPlace(Effect.fail("failed")))).toBe("failed")
    expect(places.taken()).toBe(0)
    // An interruption, whose finalizer waits: the place is held until it ends.
    const finalizer = yield* Deferred.make<void>()
    const cut = yield* Effect.forkChild(places.withPlace(Effect.onInterrupt(Effect.never, () => Deferred.await(finalizer))))
    yield* settle
    const next = yield* Effect.forkChild(places.withPlace(Effect.succeed("next")))
    yield* settle
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(cut))
    yield* settle
    expect({ taken: places.taken(), waiting: places.waiting(), next: poll(next) }).toEqual({ taken: 1, waiting: 1, next: "running" })
    yield* Deferred.succeed(finalizer, undefined)
    yield* Fiber.join(interrupting)
    expect(yield* Fiber.join(next)).toBe("next")
    yield* settle
    expect(places.taken()).toBe(0)
  }))
})

// The first read
// --------------

test("a client with after 0 on a chat of 2,500 events gets each number once, in order, then joins", async () => {
  await run(withEvents(2_500, (store) =>
    Effect.gen(function*() {
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(LIMITS)
      // `last` is the store's end: the listener gave it to no client.
      yield* channel.give(entryOf(start(2_500)))
      expect(channel.last).toBe(2_500)
      const end = yield* firstRead({ channel, client, read: (after, limit) => store.eventsAfter(after, limit), places, limits: LIMITS })
      expect(end).toEqual({ _tag: "Joined" })
      expect({ joined: client.joined, given: client.given, taken: places.taken() }).toEqual({ joined: true, given: 2_500, taken: 0 })
      const texts = yield* drain(client)
      expect(numbers(texts)).toEqual(range(1, 2_500))
      // Byte for byte the fit's JSON of the store's event.
      expect(texts[0]).toBe(JSON.stringify({ type: "start", n: 1, turn: 1 }))
    })))
})

test("a reader that does not read: the first read holds no place while it waits, and ends the client as slow 30 s after its last page", async () => {
  await run(withEvents(30, (store) =>
    Effect.gen(function*() {
      const limits: Small = { ...LIMITS, page: 10, buffer: 15 }
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      const reader = yield* fork(channel, client, (after, limit) => store.eventsAfter(after, limit), places, limits)
      yield* settle
      expect({ given: client.given, buffered: client.size.entries, taken: places.taken(), reader: poll(reader) }).toEqual({
        given: 10,
        buffered: 10,
        taken: 0,
        reader: "running"
      })
      yield* TestClock.adjust(29_999)
      yield* settle
      expect({ ended: client.ended, taken: places.taken(), reader: poll(reader) }).toEqual({ ended: null, taken: 0, reader: "running" })
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(reader)).toEqual({ _tag: "Ended", reason: "slow" })
      expect({ ended: client.ended, clients: channel.clients.length, taken: places.taken() }).toEqual({ ended: { reason: "slow" }, clients: 0, taken: 0 })
    })))
})

test("the 30 s run from the last page given: a reader that takes entries in time keeps its client", async () => {
  await run(withEvents(30, (store) =>
    Effect.gen(function*() {
      const limits: Small = { ...LIMITS, page: 10, buffer: 15 }
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      const reader = yield* fork(channel, client, (after, limit) => store.eventsAfter(after, limit), places, limits)
      yield* settle
      // At 20 s the reader takes 10: the next page goes in, and its 30 s
      // start then.
      yield* TestClock.adjust(20_000)
      expect(numbers(yield* takeSome(client, 10))).toEqual(range(1, 10))
      yield* settle
      expect(client.given).toBe(20)
      yield* TestClock.adjust(29_999)
      yield* settle
      expect({ ended: client.ended, reader: poll(reader) }).toEqual({ ended: null, reader: "running" })
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(reader)).toEqual({ _tag: "Ended", reason: "slow" })
    })))
})

test("a tell between step 1 and step 2 that takes the room: the page is not given, the client is not ended, and it gets the page after its reader took entries", async () => {
  await run(withEvents(10, (store) =>
    Effect.gen(function*() {
      const limits: Small = { ...LIMITS, page: 10, buffer: 10 }
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      let calls = 0
      // The host's frame comes after the wait for room, before the give.
      const read = (after: number, limit: number) =>
        Effect.andThen(calls++ === 0 ? channel.tell(client, "frame") : Effect.void, store.eventsAfter(after, limit))
      const reader = yield* fork(channel, client, read, places, limits)
      yield* settle
      expect({ given: client.given, buffered: client.size.entries, ended: client.ended, taken: places.taken(), reader: poll(reader) }).toEqual({
        given: 0,
        buffered: 1,
        ended: null,
        taken: 0,
        reader: "running"
      })
      expect(numbers(yield* takeSome(client, 1))).toEqual(["frame"])
      // The page fills the buffer; the read joins once the reader took it.
      expect(numbers(yield* takeSome(client, 10))).toEqual(range(1, 10))
      expect(yield* Fiber.join(reader)).toEqual({ _tag: "Joined" })
      expect({ calls, ended: client.ended, buffered: client.size.entries }).toEqual({ calls: 3, ended: null, buffered: 0 })
    })))
})

test("a dropped page does not start the 30 s again: they run from the last page given", async () => {
  await run(withEvents(20, (store) =>
    Effect.gen(function*() {
      const limits: Small = { ...LIMITS, page: 5, buffer: 10 }
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      let calls = 0
      // The third page's read: a frame takes the room first, and the page
      // is dropped.
      const read = (after: number, limit: number) =>
        Effect.andThen(calls++ === 2 ? channel.tell(client, "frame") : Effect.void, store.eventsAfter(after, limit))
      const reader = yield* fork(channel, client, read, places, limits)
      yield* settle
      expect(client.given).toBe(10)
      yield* TestClock.adjust(20_000)
      // At 20 s the reader takes 5: room for a page, but a frame takes room
      // before the give, and the page is dropped.
      expect(numbers(yield* takeSome(client, 5))).toEqual(range(1, 5))
      yield* settle
      expect({ calls, given: client.given, buffered: client.size.entries, ended: client.ended }).toEqual({ calls: 3, given: 10, buffered: 6, ended: null })
      // 30 s from the last page given (at 0), not from the drop (at 20 s).
      yield* TestClock.adjust(9_999)
      yield* settle
      expect({ ended: client.ended, reader: poll(reader) }).toEqual({ ended: null, reader: "running" })
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(reader)).toEqual({ _tag: "Ended", reason: "slow" })
      expect(places.taken()).toBe(0)
    })))
})

test("the join with last none: a client with room joins at the store's end", async () => {
  await run(withEvents(3, (store) =>
    Effect.gen(function*() {
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(LIMITS)
      expect(channel.last).toBe(null)
      expect(yield* firstRead({ channel, client, read: (after, limit) => store.eventsAfter(after, limit), places, limits: LIMITS })).toEqual({ _tag: "Joined" })
      expect(numbers(yield* drain(client))).toEqual([1, 2, 3])
    })))
})

test("the join at last: it joins, and the listener's next give reaches it", async () => {
  await run(withEvents(3, (store) =>
    Effect.gen(function*() {
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(LIMITS)
      yield* channel.give(entryOf(start(3)))
      expect(yield* firstRead({ channel, client, read: (after, limit) => store.eventsAfter(after, limit), places, limits: LIMITS })).toEqual({ _tag: "Joined" })
      yield* channel.give(entryOf(start(4)))
      expect(numbers(yield* drain(client))).toEqual([1, 2, 3, 4])
    })))
})

test("the join below last: it does not join, reads on from its given, then joins", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads(PLACES)
    const { channel, client } = yield* clientOf(LIMITS)
    const events = range(1, 3).map(start)
    // During the first read's first page, the turn loop writes 4 and 5,
    // and the listener gives them: to no client, since none joined.
    const { read, calls } = over(events, (_, call) =>
      call === 0
        ? Effect.gen(function*() {
          for (const n of [4, 5]) {
            yield* channel.give(entryOf(start(n)))
          }
        })
        : Effect.void)
    // The store holds 4 and 5 only from the second call on.
    const store = (after: number, limit: number) =>
      Effect.tap(read(after, limit), () => Effect.sync(() => {
        if (events.length === 3) events.push(start(4), start(5))
      }))
    expect(yield* firstRead({ channel, client, read: store, places, limits: LIMITS })).toEqual({ _tag: "Joined" })
    expect(numbers(yield* drain(client))).toEqual([1, 2, 3, 4, 5])
    expect(calls()).toBe(2)
    expect({ last: channel.last, given: client.given }).toEqual({ last: 5, given: 5 })
  }))
})

test("1,000 gives of the listener from another fiber while a first read runs: the client's numbers run with no gap and none twice", async () => {
  await run(withEvents(2_500, (store) =>
    Effect.gen(function*() {
      const limits: Small = { ...LIMITS, page: 10 }
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      const turn = (yield* store.turns(null, 1))[0]!.id
      yield* channel.give(entryOf(start(2_500)))
      // The listener: each event is in the store before it is given.
      const listener = yield* Effect.forkChild(Effect.forEach(range(1, 1_000), () =>
        Effect.gen(function*() {
          const n = yield* store.addEvent({ type: "start", turn })
          yield* channel.give(entryOf({ type: "start", n, turn }))
          yield* Effect.yieldNow
        }), { discard: true }))
      // The reader takes as it comes.
      const got: Array<string> = []
      const taker = yield* Effect.forkChild(Effect.gen(function*() {
        while (got.length < 3_500) {
          const taken = yield* client.take
          if (taken._tag === "End") return
          got.push(taken.text)
        }
      }))
      // Each call of the store lets the other fibers run first, as a store
      // over a connection does.
      const read = (after: number, limit: number) => Effect.andThen(Effect.yieldNow, store.eventsAfter(after, limit))
      const end = yield* firstRead({ channel, client, read, places, limits })
      expect(end).toEqual({ _tag: "Joined" })
      // The listener gave during the read: some of its events came by the
      // read, the rest by the join.
      const atJoin = client.given
      yield* Fiber.join(listener)
      yield* Fiber.join(taker)
      expect(numbers(got)).toEqual(range(1, 3_500))
      expect(client.ended).toBe(null)
      expect(atJoin).toBeGreaterThan(2_500)
      expect(atJoin).toBeLessThan(3_500)
    })))
})

test("a join with less room than entry: no join; it reads on when its reader took entries, then joins", async () => {
  await run(withEvents(10, (store) =>
    Effect.gen(function*() {
      // The first page holds the 10 events (about 35 bytes each) and is at
      // the store's end (it asked for 11); it fits in step 1's room, and
      // after it the buffer has less room than one entry.
      const limits: Small = { ...LIMITS, entry: 400, page: 11, pageBytes: 400, buffer: 100, bufferBytes: 500 }
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      let calls = 0
      const reader = yield* fork(channel, client, (after, limit) => Effect.andThen(Effect.sync(() => calls++), store.eventsAfter(after, limit)), places, limits)
      yield* settle
      expect({ given: client.given, joined: client.joined, calls, reader: poll(reader) }).toEqual({ given: 10, joined: false, calls: 1, reader: "running" })
      expect(client.size.bytes + limits.entry).toBeGreaterThan(limits.bufferBytes)
      expect(numbers(yield* drain(client))).toEqual(range(1, 10))
      expect(yield* Fiber.join(reader)).toEqual({ _tag: "Joined" })
      expect(calls).toBe(2)
    })))
})

// The captured lines of Effect's log while `effect` runs.
const logged = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const lines: Array<string> = []
    const logger = Logger.make((line) => {
      const message = line.message
      lines.push(`${line.logLevel}: ${Array.isArray(message) ? message.join(" ") : String(message)}`)
    })
    const value = yield* Effect.provide(effect, Logger.layer([logger]))
    return { value, lines }
  })

test("an event over entry that cannot be cut ends the client as internal; the log line has its number and its size, and no text of it", async () => {
  await run(Effect.gen(function*() {
    const limits: Small = { ...LIMITS, entry: 400, pageBytes: 400 }
    const places = makeReads(PLACES)
    const { channel, client } = yield* clientOf(limits)
    const text = "a private text ".repeat(40)
    const message = { i: 1, kind: "user" as const, text, size: text.length, more: false, line: null, turn: null, call: null, launch: 1, created: 1 }
    const accepted: Event = { type: "accepted", n: 2, messages: [message] }
    const bytes = entryOf(accepted, 1e9).bytes
    const { read } = over([start(1), accepted, start(3)])
    const { value, lines } = yield* logged(firstRead({ channel, client, read, places, limits }))
    expect(value).toEqual({ _tag: "Ended", reason: "internal" })
    expect({ ended: client.ended, taken: places.taken(), buffered: client.size.entries }).toEqual({ ended: { reason: "internal" }, taken: 0, buffered: 0 })
    expect(lines).toEqual([`Warn: a first read met event 2 (accepted) of ${bytes} bytes, over the limit entry: the client ends as internal`])
    expect(lines.join("\n")).not.toContain("private")
  }))
})

test("a fault of the store ends the client as internal; the log line names the store's operation, and no text", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads(PLACES)
    const { channel, client } = yield* clientOf(LIMITS)
    const read = () => Effect.fail(new StoreError({ op: "eventsAfter", cause: new Error("a private row") }))
    const { value, lines } = yield* logged(firstRead({ channel, client, read, places, limits: LIMITS }))
    expect(value).toEqual({ _tag: "Ended", reason: "internal" })
    expect({ ended: client.ended, taken: places.taken() }).toEqual({ ended: { reason: "internal" }, taken: 0 })
    expect(lines).toEqual(["Warn: a first read's call of the store failed (eventsAfter): the client ends as internal"])
  }))
})

test("ReadsBusy ends the client as busy, after 30 s of wait for a place", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads({ ...PLACES, reads: 1 })
    const gate = yield* Deferred.make<void>()
    yield* holder(places, gate)
    const { channel, client } = yield* clientOf(LIMITS)
    const { read, calls } = over([start(1)])
    const reader = yield* fork(channel, client, read, places)
    yield* settle
    yield* TestClock.adjust(29_999)
    yield* settle
    expect({ reader: poll(reader), ended: client.ended }).toEqual({ reader: "running", ended: null })
    yield* TestClock.adjust(1)
    expect(yield* Fiber.join(reader)).toEqual({ _tag: "Ended", reason: "busy" })
    expect({ ended: client.ended, calls: calls(), taken: places.taken(), waiting: places.waiting() }).toEqual({ ended: { reason: "busy" }, calls: 0, taken: 1, waiting: 0 })
    yield* Deferred.succeed(gate, undefined)
  }))
})

test("a client that is removed in the middle stops the read with no place held: in its wait for room, in its wait for a place, and in its read", async () => {
  await run(Effect.gen(function*() {
    const limits: Small = { ...LIMITS, page: 5, buffer: 5 }
    // In the wait for room.
    {
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      const reader = yield* fork(channel, client, over(range(1, 10).map(start)).read, places, limits)
      yield* settle
      expect({ given: client.given, taken: places.taken(), reader: poll(reader) }).toEqual({ given: 5, taken: 0, reader: "running" })
      yield* channel.removeClient(client)
      expect(yield* Fiber.join(reader)).toEqual({ _tag: "Ended", reason: null })
      expect(places.taken()).toBe(0)
    }
    // In the wait for a place: it gets one, reads nothing, and gives it back.
    {
      const places = makeReads({ ...PLACES, reads: 1 })
      const gate = yield* Deferred.make<void>()
      yield* holder(places, gate)
      const { channel, client } = yield* clientOf(limits)
      const { read, calls } = over(range(1, 10).map(start))
      const reader = yield* fork(channel, client, read, places, limits)
      yield* settle
      expect(places.waiting()).toBe(1)
      yield* channel.removeClient(client, "token")
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(reader)).toEqual({ _tag: "Ended", reason: "token" })
      yield* settle
      expect({ calls: calls(), taken: places.taken() }).toEqual({ calls: 0, taken: 0 })
    }
    // In its read: the page finds the client ended.
    {
      const places = makeReads(PLACES)
      const { channel, client } = yield* clientOf(limits)
      const { read } = over(range(1, 10).map(start), () => channel.removeClient(client, "slow"))
      expect(yield* firstRead({ channel, client, read, places, limits })).toEqual({ _tag: "Ended", reason: "slow" })
      expect({ taken: places.taken(), buffered: client.size.entries }).toEqual({ taken: 0, buffered: 0 })
    }
  }))
})

test("an interruption of the first read gives its place back when its read has ended, and leaves the client as it is", async () => {
  await run(Effect.gen(function*() {
    const places = makeReads({ ...PLACES, reads: 1 })
    const { channel, client } = yield* clientOf(LIMITS)
    const reading = yield* Deferred.make<void>()
    const finalizer = yield* Deferred.make<void>()
    // A read that is cut in its call, and whose cleanup waits.
    const read = () => Effect.andThen(Deferred.succeed(reading, undefined), Effect.onInterrupt(Effect.never, () => Deferred.await(finalizer)))
    const reader = yield* fork(channel, client, read, places)
    yield* Deferred.await(reading)
    expect(places.taken()).toBe(1)
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(reader))
    yield* settle
    expect(places.taken()).toBe(1)
    yield* Deferred.succeed(finalizer, undefined)
    yield* Fiber.join(interrupting)
    expect({ taken: places.taken(), ended: client.ended, clients: channel.clients.length }).toEqual({ taken: 0, ended: null, clients: 1 })
  }))
})
