// Tests of the registry, the channel and the give (channel.ts; docs/host.md,
// section 2, "The channel and the loaded chat" and "The give"; section 8, "A
// slow client"): the holders, the tenant boundary, who gets a give, the give
// lock and its one step, a full buffer, the join, the host's own frames, a
// first read's page, and the bounds of clients.

import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Scheduler, Semaphore } from "effect"
import { type Channel, type ChannelLimits, type Client, ClientRefused, makeRegistry, REASONS, type Taken } from "./channel.ts"
import { type Entry, fit, utf8 } from "./fit.ts"

const LIMITS: ChannelLimits = {
  buffer: 4_096,
  bufferBytes: 8 * 1024 * 1024,
  entry: 1024 * 1024,
  page: 1_000,
  pageBytes: 2 * 1024 * 1024,
  chatClients: 32,
  hostClients: 4_096
}

const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
const CHAT = "11111111-1111-4111-8111-111111111111"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// A numbered event's entry as the fit gives it, and one of exactly `bytes`
// bytes.
const event = (n: number): Entry => fit({ type: "start", n, turn: 1 }, LIMITS.entry) as Entry
const sized = (n: number | null, bytes: number): Entry => ({ _tag: "Entry", json: "x".repeat(bytes), bytes, n, cut: false })
const piece = (delta: string): Entry => fit({ type: "text", turn: 1, delta }, LIMITS.entry) as Entry

// Everything in a client's buffer now, and its end if it has one, with no
// wait: the reader's side.
const drain = (client: Client) =>
  Effect.gen(function*() {
    const texts: Array<string> = []
    while (client.size.entries > 0) {
      const taken = yield* client.take
      if (taken._tag === "Text") texts.push(taken.text)
    }
    const end: Taken | null = client.ended === null ? null : yield* client.take
    return { texts, end }
  })
const numbers = (texts: ReadonlyArray<string>) => texts.map((text) => (JSON.parse(text) as { n: number }).n)

// A client of `channel` that joined, with `given`.
const joined = (channel: Channel, given: number) =>
  Effect.gen(function*() {
    const client = yield* channel.addClient(given)
    expect(yield* channel.join(client)).toBe(true)
    return client
  })

// The registry
// ------------

test("two fibers that hold a chat's first channel at one time get one channel with two holders; the last letGo takes it out, and a hold after it makes a new one", async () => {
  const registry = makeRegistry(LIMITS)
  const [one, two] = await run(Effect.all([registry.hold(TENANT_A, CHAT), registry.hold(TENANT_A, CHAT)], { concurrency: 2 }))
  expect(one).toBe(two)
  expect(one.holders).toBe(2)
  expect(registry.size().channels).toBe(1)
  await run(registry.letGo(one))
  expect(one.holders).toBe(1)
  expect(registry.find(TENANT_A, CHAT)).toBe(one)
  // A hold while a holder is left finds the same channel.
  const three = await run(registry.hold(TENANT_A, CHAT))
  expect(three).toBe(one)
  await run(registry.letGo(three))
  await run(registry.letGo(one))
  expect(one.holders).toBe(0)
  expect(registry.find(TENANT_A, CHAT)).toBeUndefined()
  expect(registry.size().channels).toBe(0)
  const again = await run(registry.hold(TENANT_A, CHAT))
  expect(again).not.toBe(one)
  expect(again.holders).toBe(1)
})

test("held holds until its scope closes, and a scope that is interrupted lets go", async () => {
  const registry = makeRegistry(LIMITS)
  await run(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.scoped(Effect.andThen(registry.held(TENANT_A, CHAT), Effect.never)))
    while (registry.find(TENANT_A, CHAT)?.holders !== 1) yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
  }))
  expect(registry.find(TENANT_A, CHAT)).toBeUndefined()
  const channel = await run(Effect.scoped(registry.held(TENANT_A, CHAT)))
  expect(channel.holders).toBe(0)
  expect(registry.size().channels).toBe(0)
})

test("the same UUID under two tenants is two channels, and a give into one puts nothing into the other's clients", async () => {
  const registry = makeRegistry(LIMITS)
  const got = await run(Effect.gen(function*() {
    const a = yield* registry.hold(TENANT_A, CHAT)
    const b = yield* registry.hold(TENANT_B, CHAT)
    const ofA = yield* joined(a, 0)
    const ofB = yield* joined(b, 0)
    yield* a.give(event(1))
    yield* a.givePiece(piece("only A"))
    return { a, b, ofA: yield* drain(ofA), ofB: yield* drain(ofB) }
  }))
  expect(got.a).not.toBe(got.b)
  expect([got.a.tenant, got.b.tenant]).toEqual([TENANT_A, TENANT_B])
  expect(registry.size().channels).toBe(2)
  expect(got.ofA.texts).toEqual([event(1).json, piece("only A").json])
  expect(got.ofB.texts).toEqual([])
  expect(got.a.last).toBe(1)
  expect(got.b.last).toBeNull()
})

// The give
// --------

test("a give reaches each joined client whose given is below the number, one time, and not one whose given is at or above it; it sets given and last", async () => {
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    const below = yield* joined(channel, 4)
    const lower = yield* joined(channel, 0)
    // The two others join before the channel has a last, at 5 and 9.
    const at = yield* joined(channel, 5)
    const above = yield* joined(channel, 9)
    yield* channel.give(event(5))
    yield* channel.give(event(5))
    return {
      last: channel.last,
      given: [below.given, lower.given, at.given, above.given],
      texts: [(yield* drain(below)).texts, (yield* drain(lower)).texts, (yield* drain(at)).texts, (yield* drain(above)).texts]
    }
  }))
  expect(got.last).toBe(5)
  expect(got.given).toEqual([5, 5, 5, 9])
  expect(got.texts).toEqual([[event(5).json], [event(5).json], [], []])
})

test("a client that has not joined gets no give and no piece; a joined one gets the piece, and the piece moves no number", async () => {
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    const waiting = yield* channel.addClient(0)
    const member = yield* joined(channel, 0)
    yield* channel.give(event(1))
    yield* channel.givePiece(piece("Hel"))
    return { waiting: yield* drain(waiting), member: yield* drain(member), given: [waiting.given, member.given], last: channel.last }
  }))
  expect(got.waiting.texts).toEqual([])
  expect(got.member.texts).toEqual([event(1).json, piece("Hel").json])
  expect(got.given).toEqual([0, 1])
  expect(got.last).toBe(1)
})

test("1,000 gives from two fibers at one time leave each client's numbers in order, from 1 to 1,000, with none twice", async () => {
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    const clients = yield* Effect.forEach([0, 0, 0, 0, 0], (given) => joined(channel, given))
    const gives = Effect.forEach(Array.from({ length: 1_000 }, (_, k) => event(k + 1)), (entry) => channel.give(entry), { discard: true })
    // Each fiber yields every three operations, so the two gives mix.
    yield* Effect.all([gives, gives], { concurrency: 2 }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
    return yield* Effect.forEach(clients, (client) => Effect.map(drain(client), ({ texts }) => numbers(texts)))
  }))
  const all = Array.from({ length: 1_000 }, (_, k) => k + 1)
  for (const seen of got) expect(seen).toEqual(all)
})

// A small generator of numbers, the same in each run.
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
  return seed / 2 ** 31
}

test("an interruption that lands in a give leaves each buffer and each given either before it or after it, never between: 200 interruptions at random points", async () => {
  const next = random(7)
  const rounds = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    const clients = yield* Effect.forEach(Array.from({ length: 12 }, () => 0), (given) => joined(channel, given))
    const rounds: Array<{ readonly k: number; readonly state: "before" | "after" | "between" }> = []
    let n = 0
    for (let round = 0; round < 200; round += 1) {
      n += 1
      // The give yields every three operations: it can be stopped between
      // two clients, but for its one step.
      const worker = yield* Effect.forkChild(channel.give(event(n)).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)))
      const k = Math.floor(next() * 12)
      for (let y = 0; y < k; y += 1) yield* Effect.yieldNow
      yield* Fiber.interrupt(worker)
      const got = yield* Effect.forEach(clients, (client) => Effect.map(drain(client), ({ texts }) => ({ texts, given: client.given })))
      const had = got.map(({ texts, given }) => texts.length === 1 && texts[0] === event(n).json && given === n)
      const none = got.map(({ texts, given }) => texts.length === 0 && given === n - 1)
      const state = had.every(Boolean) && channel.last === n ? "after" : none.every(Boolean) && channel.last === (n === 1 ? null : n - 1) ? "before" : "between"
      rounds.push({ k, state })
      // A give that was stopped before it is given again, so the clients go
      // on from n.
      if (state === "before") yield* channel.give(event(n)).pipe(Effect.andThen(Effect.forEach(clients, drain)))
    }
    return rounds
  }))
  expect(rounds.filter((round) => round.state === "between")).toEqual([])
  // The rounds reach both sides.
  expect(rounds.filter((round) => round.state === "before").length).toBeGreaterThan(0)
  expect(rounds.filter((round) => round.state === "after").length).toBeGreaterThan(0)
})

// A full buffer
// -------------

// The time that a give may take; a give that waits passes it.
const quick = <A, E>(effect: Effect.Effect<A, E>) => Effect.timeoutOrElse(effect, { duration: "1 second", orElse: () => Effect.die(new Error("the give waited")) })

test("a full buffer, by entries, ends that client as slow and frees its bytes, and the other clients go on", async () => {
  const limits = { ...LIMITS, buffer: 3 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const full = yield* joined(channel, 0)
    const reader = yield* joined(channel, 0)
    const read: Array<string> = []
    for (let n = 1; n <= 5; n += 1) {
      yield* quick(channel.give(event(n)))
      read.push(...(yield* drain(reader)).texts)
    }
    return { full, reader, read, clients: channel.clients, taken: yield* full.take }
  }))
  expect(got.full.ended).toEqual({ reason: "slow" })
  expect(got.full.size).toEqual({ entries: 0, bytes: 0 })
  expect(got.full.given).toBe(3)
  expect(got.taken).toEqual({ _tag: "End", reason: "slow" })
  expect(got.clients).toEqual([got.reader])
  expect(numbers(got.read)).toEqual([1, 2, 3, 4, 5])
  expect(got.reader.ended).toBeNull()
})

test("a full buffer, by bytes, ends that client as slow and frees its bytes, and the other clients go on", async () => {
  const limits = { ...LIMITS, bufferBytes: 100, entry: 40, page: 2, pageBytes: 80 }
  const got = await run(Effect.gen(function*() {
    const registry = makeRegistry(limits)
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const full = yield* joined(channel, 0)
    const reader = yield* joined(channel, 0)
    yield* quick(channel.give(sized(1, 40)))
    yield* quick(channel.give(sized(2, 40)))
    const before = full.size
    const read = (yield* drain(reader)).texts.length
    yield* quick(channel.give(sized(3, 40)))
    return { before, read, full, reader, after: (yield* drain(reader)).texts.length, clients: registry.size().clients }
  }))
  expect(got.before).toEqual({ entries: 2, bytes: 80 })
  expect(got.full.ended).toEqual({ reason: "slow" })
  expect(got.full.size).toEqual({ entries: 0, bytes: 0 })
  expect([got.read, got.after]).toEqual([2, 1])
  expect(got.clients).toBe(1)
})

test("a piece into a full buffer ends that client as slow too", async () => {
  const limits = { ...LIMITS, buffer: 1 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    yield* quick(channel.givePiece(piece("a")))
    yield* quick(channel.givePiece(piece("b")))
    return client.ended
  }))
  expect(got).toEqual({ reason: "slow" })
})

// A client with `pieces: false` (R5's; lead, ec-cxuj5)
// ----------------------------------------------------

test("a joined client with pieces: false gets each numbered event and frame as any client; a flood of pieces past both bounds of its buffer, with no pause, leaves it at 0 entries and 0 bytes and does not end it, while a client of the same channel with no option ends as slow", async () => {
  const limits = { ...LIMITS, buffer: 4, bufferBytes: 1_000, entry: 400, page: 2, pageBytes: 800 }
  const got = await run(Effect.gen(function*() {
    const registry = makeRegistry(limits)
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const plain = yield* joined(channel, 0)
    const none = yield* channel.addClient(0, { pieces: false })
    expect(yield* channel.join(none)).toBe(true)
    // Its reader waits in take while the pieces come.
    const reader = yield* Effect.forkChild(none.take)
    yield* Effect.yieldNow
    // More entries than `buffer` (4) and more bytes than `bufferBytes`
    // (1,000): 40 pieces of 300 bytes, one give after the other.
    const sizes: Array<{ entries: number; bytes: number }> = []
    for (let k = 0; k < 40; k += 1) {
      yield* quick(channel.givePiece(sized(null, 300)))
      sizes.push(none.size)
    }
    const flood = { plain: plain.ended, none: none.ended, reading: reader.pollUnsafe() === undefined, clients: channel.clients.length }
    // The numbered events, and a frame of the host, as for any client.
    yield* quick(channel.give(event(1)))
    const first = yield* quick(Fiber.join(reader))
    const told = yield* channel.tell(none, ": ping")
    yield* quick(channel.give(event(2)))
    yield* quick(channel.give(event(3)))
    const sizeAfter = none.size
    const rest = yield* drain(none)
    return { sizes, flood, first, told, sizeAfter, rest, given: none.given, last: channel.last, ended: none.ended, clients: registry.size().clients }
  }))
  expect(got.sizes).toEqual(Array.from({ length: 40 }, () => ({ entries: 0, bytes: 0 })))
  expect(got.flood).toEqual({ plain: { reason: "slow" }, none: null, reading: true, clients: 1 })
  expect(got.first).toEqual({ _tag: "Text", text: event(1).json, bytes: event(1).bytes })
  expect(got.told).toBe("told")
  expect(got.sizeAfter).toEqual({ entries: 3, bytes: utf8(": ping") + event(2).bytes + event(3).bytes })
  expect(got.rest.texts).toEqual([": ping", event(2).json, event(3).json])
  expect(got.rest.end).toBeNull()
  expect([got.given, got.last]).toEqual([3, 3])
  expect(got.ended).toBeNull()
  expect(got.clients).toBe(1)
})

test("a client with pieces: false is filled by numbered events alone: past its buffer it ends as slow, as any client", async () => {
  const limits = { ...LIMITS, buffer: 2 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const none = yield* channel.addClient(0, { pieces: false })
    expect(yield* channel.join(none)).toBe(true)
    for (let k = 0; k < 10; k += 1) yield* quick(channel.givePiece(piece("p" + k)))
    const before = none.ended
    for (let n = 1; n <= 3; n += 1) yield* quick(channel.give(event(n)))
    return { before, after: none.ended, given: none.given, taken: yield* none.take }
  }))
  expect(got).toEqual({ before: null, after: { reason: "slow" }, given: 2, taken: { _tag: "End", reason: "slow" } })
})

test("the clients' limits count a client with pieces: false as any client, and each of its ends gives its place back", async () => {
  const limits = { ...LIMITS, buffer: 1, chatClients: 2, hostClients: 3 }
  const registry = makeRegistry(limits)
  const got = await run(Effect.gen(function*() {
    const a = yield* registry.hold(TENANT_A, CHAT)
    const b = yield* registry.hold(TENANT_B, CHAT)
    const one = yield* a.addClient(0, { pieces: false })
    yield* a.addClient(0, { pieces: false })
    const pastChat = yield* Effect.flip(a.addClient(0))
    const pastChatNone = yield* Effect.flip(a.addClient(0, { pieces: false }))
    const three = yield* b.addClient(0, { pieces: false })
    const pastHost = yield* Effect.flip(b.addClient(0))
    const pastHostNone = yield* Effect.flip(b.addClient(0, { pieces: false }))
    const counted = registry.size().clients
    // A remove gives its place back.
    yield* a.removeClient(one)
    const afterRemove = registry.size().clients
    const inA = yield* Effect.exit(a.addClient(0, { pieces: false }))
    // So does a slow end by numbered events.
    expect(yield* b.join(three)).toBe(true)
    yield* b.give(event(1))
    yield* b.give(event(2))
    const afterSlow = registry.size().clients
    const inB = yield* Effect.exit(b.addClient(0))
    return {
      bounds: [pastChat.bound, pastChatNone.bound, pastHost.bound, pastHostNone.bound],
      counted,
      afterRemove,
      inA: Exit.isSuccess(inA),
      slow: three.ended,
      afterSlow,
      inB: Exit.isSuccess(inB),
      after: registry.size().clients
    }
  }))
  expect(got).toEqual({
    bounds: ["chat", "chat", "host", "host"],
    counted: 3,
    afterRemove: 2,
    inA: true,
    slow: { reason: "slow" },
    afterSlow: 2,
    inB: true,
    after: 3
  })
})

test("a reader that waits gets the next give, and the end of its client", async () => {
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    const first = yield* Effect.forkChild(client.take)
    yield* Effect.yieldNow
    yield* channel.give(event(1))
    const taken = yield* Fiber.join(first)
    const second = yield* Effect.forkChild(client.take)
    yield* Effect.yieldNow
    yield* channel.removeClient(client, "token")
    return { taken, end: yield* Fiber.join(second) }
  }))
  expect(got.taken).toEqual({ _tag: "Text", text: event(1).json, bytes: event(1).bytes })
  expect(got.end).toEqual({ _tag: "End", reason: "token" })
})

// The join
// --------

test("join: at last it joins, below last it does not, and with no last it joins; at last with less room than entry, by bytes or by count, it does not", async () => {
  const limits = { ...LIMITS, buffer: 3, bufferBytes: 100, entry: 30, page: 2, pageBytes: 60 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const early = yield* channel.addClient(0)
    const noLast = yield* channel.join(early)
    // A give sets last at 7.
    yield* channel.give(sized(7, 10))
    const at = yield* channel.addClient(7)
    const below = yield* channel.addClient(6)
    const atLast = yield* channel.join(at)
    const belowLast = yield* channel.join(below)
    // 71 bytes leave 29, less than entry's 30.
    const tight = yield* channel.addClient(7)
    yield* channel.tell(tight, "y".repeat(71))
    const lessBytes = yield* channel.join(tight)
    // Its reader takes the frame: 100 bytes of room, and it joins.
    yield* tight.take
    const roomAgain = yield* channel.join(tight)
    // Three entries in a buffer of three: no room in count.
    const counted = yield* channel.addClient(7)
    for (const text of ["a", "b", "c"]) yield* channel.tell(counted, text)
    const lessCount = yield* channel.join(counted)
    // Exactly 30 bytes of room: it joins.
    const edge = yield* channel.addClient(7)
    yield* channel.tell(edge, "z".repeat(70))
    const atEdge = yield* channel.join(edge)
    return { noLast, atLast, belowLast, lessBytes, roomAgain, lessCount, atEdge, joined: [early, at, below, tight, counted, edge].map((c) => c.joined) }
  }))
  expect(got).toEqual({
    noLast: true,
    atLast: true,
    belowLast: false,
    lessBytes: false,
    roomAgain: true,
    lessCount: false,
    atEdge: true,
    joined: [true, true, false, true, false, true]
  })
})

// The host's own frames, and a first read's page
// ----------------------------------------------

test("tell reaches a client that has not joined, counts in its bytes and moves no number, and into a full buffer ends that client as slow", async () => {
  const limits = { ...LIMITS, bufferBytes: 100, entry: 50, page: 2, pageBytes: 100 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const client = yield* channel.addClient(3)
    const ready = JSON.stringify({ type: "ready", note: "é".repeat(20) })
    const told = yield* channel.tell(client, ready)
    const size = client.size
    const given = client.given
    const over = yield* channel.tell(client, "w".repeat(100 - size.bytes + 1))
    return { told, size, bytes: Buffer.byteLength(ready), given, over, ended: client.ended, clients: channel.clients.length }
  }))
  expect(got.told).toBe("told")
  expect(got.size).toEqual({ entries: 1, bytes: got.bytes })
  expect(got.given).toBe(3)
  expect(got.over).toBe("ended")
  expect(got.ended).toEqual({ reason: "slow" })
  expect(got.clients).toBe(0)
})

test("tellIfEmpty puts a text into an empty buffer (told); into a buffer that holds a text it puts nothing (waiting), also when the text would fit; with no room in the empty buffer, waiting; for a client that ended, ended; it never ends a client", async () => {
  const limits = { ...LIMITS, buffer: 2, bufferBytes: 100, entry: 50, page: 1, pageBytes: 50 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    const into = yield* channel.tellIfEmpty(client, ": ping")
    const first = client.size
    // The ping is in the buffer: a second waits, though one more entry of
    // 6 bytes fits.
    const fits = client.hasRoom(1, utf8(": ping"))
    const again = yield* channel.tellIfEmpty(client, ": ping")
    const second = client.size
    const taken = yield* drain(client)
    // An event in the buffer: a ping waits.
    yield* channel.give(event(1))
    const behind = yield* channel.tellIfEmpty(client, ": ping")
    const third = client.size
    yield* drain(client)
    // An empty buffer with no room for the text: nothing put, the client
    // stays.
    const big = yield* channel.tellIfEmpty(client, "x".repeat(101))
    const fourth = client.size
    const alive = { ended: client.ended, clients: channel.clients.length }
    // A client that ended, one that had joined and one that had not.
    const notJoined = yield* channel.addClient(0)
    yield* channel.removeClient(client, "stop")
    yield* channel.removeClient(notJoined, null)
    const ended = [yield* channel.tellIfEmpty(client, ": ping"), yield* channel.tellIfEmpty(notJoined, ": ping")]
    return { into, first, fits, again, second, taken, behind, third, big, fourth, alive, ended, sizes: [client.size, notJoined.size], ends: [client.ended, notJoined.ended] }
  }))
  expect(got.into).toBe("told")
  expect(got.first).toEqual({ entries: 1, bytes: 6 })
  expect(got.fits).toBe(true)
  expect(got.again).toBe("waiting")
  expect(got.second).toEqual({ entries: 1, bytes: 6 })
  expect(got.taken.texts).toEqual([": ping"])
  expect(got.behind).toBe("waiting")
  expect(got.third).toEqual({ entries: 1, bytes: event(1).bytes })
  expect(got.big).toBe("waiting")
  expect(got.fourth).toEqual({ entries: 0, bytes: 0 })
  expect(got.alive).toEqual({ ended: null, clients: 1 })
  expect(got.ended).toEqual(["ended", "ended"])
  expect(got.sizes).toEqual([{ entries: 0, bytes: 0 }, { entries: 0, bytes: 0 }])
  expect(got.ends).toEqual([{ reason: "stop" }, { reason: null }])
})

test("with the give lock held, a give and a tellIfEmpty queued behind it in that order: the event is in the buffer, the answer is waiting, and the client has not ended (buffer 1, page 1)", async () => {
  const limits = { ...LIMITS, buffer: 1, page: 1 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    const waiters = () => (channel.giveLock as unknown as { readonly waiters: Set<unknown> }).waiters.size
    yield* Semaphore.take(channel.giveLock, 1)
    const giving = yield* Effect.forkChild(channel.give(event(1)))
    while (waiters() < 1) yield* Effect.yieldNow
    const telling = yield* Effect.forkChild(channel.tellIfEmpty(client, ": ping"))
    while (waiters() < 2) yield* Effect.yieldNow
    // Both wait on the lock, and the buffer is still empty.
    const before = client.size
    yield* Semaphore.release(channel.giveLock, 1)
    yield* Fiber.join(giving)
    const told = yield* Fiber.join(telling)
    return { before, told, size: client.size, given: client.given, ended: client.ended, clients: channel.clients.length, texts: (yield* drain(client)).texts }
  }))
  expect(got.before).toEqual({ entries: 0, bytes: 0 })
  expect(got.told).toBe("waiting")
  expect(got.size).toEqual({ entries: 1, bytes: event(1).bytes })
  expect(got.given).toBe(1)
  expect(got.ended).toBeNull()
  expect(got.clients).toBe(1)
  expect(got.texts).toEqual([event(1).json])
})

test("giveTo puts a page that fits whole and sets given; with less room than its page it puts no part of it and leaves the client", async () => {
  const limits = { ...LIMITS, buffer: 5, bufferBytes: 100, entry: 20, page: 5, pageBytes: 100 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const client = yield* channel.addClient(0)
    const first = yield* channel.giveTo(client, [sized(1, 20), sized(2, 20), sized(3, 20)])
    const afterFirst = { size: client.size, given: client.given }
    // 60 bytes in the buffer: a page of 60 more does not fit, by bytes; one
    // of three more does not fit, by count.
    const byBytes = yield* channel.giveTo(client, [sized(4, 20), sized(5, 40)])
    const byCount = yield* channel.giveTo(client, [sized(4, 1), sized(5, 1), sized(6, 1)])
    return { first, afterFirst, byBytes, byCount, size: client.size, given: client.given, ended: client.ended, clients: channel.clients.length }
  }))
  expect(got.first).toBe("given")
  expect(got.afterFirst).toEqual({ size: { entries: 3, bytes: 60 }, given: 3 })
  expect([got.byBytes, got.byCount]).toEqual(["noRoom", "noRoom"])
  expect(got.size).toEqual({ entries: 3, bytes: 60 })
  expect(got.given).toBe(3)
  expect(got.ended).toBeNull()
  expect(got.clients).toBe(1)
})

test("waitForPage waits until the buffer has room for a page, and ends with false at the client's end", async () => {
  const limits = { ...LIMITS, buffer: 4, bufferBytes: 100, entry: 20, page: 2, pageBytes: 40 }
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(limits).hold(TENANT_A, CHAT)
    const client = yield* channel.addClient(0)
    yield* channel.giveTo(client, [sized(1, 20), sized(2, 20), sized(3, 20)])
    const waiter = yield* Effect.forkChild(client.waitForPage)
    yield* Effect.yieldNow
    // 3 entries, 60 bytes: no room for 2 more entries.
    const before = waiter.pollUnsafe() === undefined
    yield* client.take
    const room = yield* Fiber.join(waiter)
    const other = yield* channel.addClient(0)
    yield* channel.giveTo(other, [sized(1, 50), sized(2, 40)])
    const second = yield* Effect.forkChild(other.waitForPage)
    yield* Effect.yieldNow
    yield* channel.removeClient(other, "stop")
    return { before, room, ended: yield* Fiber.join(second) }
  }))
  expect(got).toEqual({ before: true, room: true, ended: false })
})

// The steps of the load and the unload
// ------------------------------------

test("listen sets last to the lowest given of the clients that joined, a client that has not joined does not count, with none it is the store's seq, and it may set last lower", async () => {
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    // With no `last`, a client with room joins at once, at its `given`.
    const five = yield* joined(channel, 5)
    const three = yield* joined(channel, 3)
    const waiting = yield* channel.addClient(1)
    const two = { value: yield* channel.listen(10), last: channel.last }
    yield* channel.removeClient(five)
    yield* channel.removeClient(three)
    const none = { value: yield* channel.listen(10), last: channel.last }
    yield* channel.give(event(12))
    const raised = channel.last
    const lower = { value: yield* channel.listen(7), last: channel.last }
    return { two, none, raised, lower, waiting: waiting.joined }
  }))
  expect(got).toEqual({ two: { value: 3, last: 3 }, none: { value: 10, last: 10 }, raised: 12, lower: { value: 7, last: 7 }, waiting: false })
})

test("lowestGiven is the lowest given of the clients that joined, or null; a client that has not joined does not count", async () => {
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    const empty = yield* channel.lowestGiven
    yield* channel.addClient(0)
    const onlyWaiting = yield* channel.lowestGiven
    yield* joined(channel, 7)
    yield* joined(channel, 4)
    return { empty, onlyWaiting, two: yield* channel.lowestGiven }
  }))
  expect(got).toEqual({ empty: null, onlyWaiting: null, two: 4 })
})

test("listen never sets last above the store's seq: one joined client above seq gives seq; one below and one above give the lower given", async () => {
  const got = await run(Effect.gen(function*() {
    const registry = makeRegistry(LIMITS)
    const one = yield* registry.hold(TENANT_A, CHAT)
    yield* joined(one, 1_000_000_000)
    const alone = { value: yield* one.listen(10), last: one.last }
    // Both join on a channel with no `last` yet.
    const channel = yield* registry.hold(TENANT_B, CHAT)
    const above = yield* joined(channel, 1_000_000_000)
    const below = yield* joined(channel, 4)
    const two = { value: yield* channel.listen(10), last: channel.last }
    // The give skips the client above: it stays joined, with its `given`.
    yield* channel.give(event(5))
    return { alone, two, above: { given: above.given, joined: above.joined, ended: above.ended, buffered: above.size.entries }, below: below.given }
  }))
  expect(got).toEqual({
    alone: { value: 10, last: 10 },
    two: { value: 4, last: 4 },
    above: { given: 1_000_000_000, joined: true, ended: null, buffered: 0 },
    below: 5
  })
})

test("cannotGive ends with internal each client that joined and whose given is below the number, sets last when higher, and leaves the others as they are", async () => {
  const got = await run(Effect.gen(function*() {
    const channel = yield* makeRegistry(LIMITS).hold(TENANT_A, CHAT)
    const below = yield* joined(channel, 2)
    const at = yield* joined(channel, 5)
    const above = yield* joined(channel, 9)
    const waiting = yield* channel.addClient(0)
    yield* channel.cannotGive(5)
    const first = { last: channel.last, ended: [below.ended, at.ended, above.ended, waiting.ended], clients: channel.clients.length }
    yield* channel.cannotGive(3)
    const second = { last: channel.last, clients: channel.clients.length }
    // The next give reaches those left, after the number.
    yield* channel.give(event(6))
    return { first, second, at: (yield* drain(at)).texts.length, above: (yield* drain(above)).texts.length, waiting: waiting.size.entries }
  }))
  expect(got).toEqual({
    first: { last: 5, ended: [{ reason: "internal" }, null, null, null], clients: 3 },
    second: { last: 5, clients: 3 },
    at: 1,
    above: 0,
    waiting: 0
  })
})

// The bounds of clients
// ---------------------

test("the 33rd client of a chat and the client past the host's bound are refused with busy, and a client's end gives its place back", async () => {
  const limits = { ...LIMITS, hostClients: 40 }
  const registry = makeRegistry(limits)
  const got = await run(Effect.gen(function*() {
    const a = yield* registry.hold(TENANT_A, CHAT)
    const b = yield* registry.hold(TENANT_B, CHAT)
    const ofA = yield* Effect.forEach(Array.from({ length: 32 }), () => a.addClient(0))
    const thirtyThird = yield* Effect.flip(a.addClient(0))
    const ofB = yield* Effect.forEach(Array.from({ length: 8 }), () => b.addClient(0))
    const pastHost = yield* Effect.flip(b.addClient(0))
    const counted = registry.size().clients
    // An end of each kind gives a place back.
    yield* a.removeClient(ofA[0] as Client, "stop")
    const inA = yield* Effect.exit(a.addClient(0))
    yield* b.removeClient(ofB[0] as Client)
    const inB = yield* Effect.exit(b.addClient(0))
    return { thirtyThird, pastHost, counted, inA: Exit.isSuccess(inA), inB: Exit.isSuccess(inB), after: registry.size().clients }
  }))
  expect(got.thirtyThird).toBeInstanceOf(ClientRefused)
  expect([got.thirtyThird.reason, got.thirtyThird.bound]).toEqual(["busy", "chat"])
  expect([got.pastHost.reason, got.pastHost.bound]).toEqual(["busy", "host"])
  expect(got.counted).toBe(40)
  expect([got.inA, got.inB]).toEqual([true, true])
  expect(got.after).toBe(40)
})

test("a slow end gives the host's place back too, and the reasons are the closed set", async () => {
  const limits = { ...LIMITS, buffer: 1, hostClients: 1 }
  const registry = makeRegistry(limits)
  const got = await run(Effect.gen(function*() {
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    const refused = yield* Effect.flip(channel.addClient(0))
    yield* channel.give(event(1))
    yield* channel.give(event(2))
    const next = yield* Effect.exit(channel.addClient(0))
    return { refused: refused.bound, ended: client.ended, next: Exit.isSuccess(next) }
  }))
  expect(got).toEqual({ refused: "host", ended: { reason: "slow" }, next: true })
  expect([...REASONS]).toEqual(["slow", "token", "busy", "stop", "internal"])
})

test("after the registry's stop, addClient on a channel that it had and on one that it holds later fails with ClientRefused busy host, with and without pieces: false; the clients that were there are as they were, and the counts too; a second stop changes nothing", async () => {
  const limits = { ...LIMITS, buffer: 8 }
  const registry = makeRegistry(limits)
  // Each `addClient`, with no option and with `pieces: false`: its refusal,
  // or "a client".
  const refusedBy = (channel: Channel) =>
    Effect.forEach([undefined, { pieces: false }], (options) =>
      Effect.map(Effect.result(channel.addClient(0, options)), (result) =>
        result._tag === "Success"
          ? "a client"
          : { refused: result.failure instanceof ClientRefused, reason: result.failure.reason, bound: result.failure.bound }))
  const host = { refused: true, reason: "busy", bound: "host" } as const
  const got = await run(Effect.gen(function*() {
    const had = yield* registry.hold(TENANT_A, CHAT)
    const member = yield* joined(had, 0)
    const quiet = yield* had.addClient(0, { pieces: false })
    yield* had.give(event(1))
    yield* had.givePiece(piece("p"))
    const state = () => ({
      size: registry.size(),
      clients: had.clients.length,
      member: { size: member.size, given: member.given, ended: member.ended, joined: member.joined },
      quiet: { size: quiet.size, given: quiet.given, ended: quiet.ended, joined: quiet.joined },
      last: had.last,
      holders: had.holders
    })
    const before = state()
    yield* registry.stop
    const afterStop = state()
    const onHad = yield* refusedBy(had)
    // A channel that the registry makes after its stop.
    const later = yield* registry.hold(TENANT_B, CHAT)
    const onLater = yield* refusedBy(later)
    const afterRefusals = state()
    yield* registry.stop
    const afterSecond = state()
    const again = [...(yield* refusedBy(had)), ...(yield* refusedBy(later))]
    // The clients that were there go on: a give reaches the member, and an
    // end gives its place back.
    yield* had.give(event(2))
    const read = (yield* drain(member)).texts
    yield* had.removeClient(quiet)
    return { before, afterStop, onHad, onLater, afterRefusals, afterSecond, again, read, end: registry.size(), laterClients: later.clients.length }
  }))
  expect(got.before).toEqual({
    size: { channels: 1, clients: 2 },
    clients: 2,
    member: { size: { entries: 2, bytes: event(1).bytes + piece("p").bytes }, given: 1, ended: null, joined: true },
    quiet: { size: { entries: 0, bytes: 0 }, given: 0, ended: null, joined: false },
    last: 1,
    holders: 1
  })
  expect(got.afterStop).toEqual(got.before)
  expect(got.onHad).toEqual([host, host])
  expect(got.onLater).toEqual([host, host])
  expect(got.afterRefusals).toEqual({ ...got.before, size: { channels: 2, clients: 2 } })
  expect(got.afterSecond).toEqual(got.afterRefusals)
  expect(got.again).toEqual([host, host, host, host])
  expect(got.read).toEqual([event(1).json, piece("p").json, event(2).json])
  expect(got.end).toEqual({ channels: 2, clients: 1 })
  expect(got.laterClients).toBe(0)
})

// The rules that hold the counts and the order
// --------------------------------------------

const CHAT_2 = "22222222-2222-4222-8222-222222222222"

test("letGo of one chat of a tenant leaves the tenant's other held chats in the registry", async () => {
  const registry = makeRegistry(LIMITS)
  const got = await run(Effect.gen(function*() {
    const one = yield* registry.hold(TENANT_A, CHAT)
    const two = yield* registry.hold(TENANT_A, CHAT_2)
    yield* registry.letGo(one)
    const found = registry.find(TENANT_A, CHAT_2)
    // A hold of the other chat finds its channel, not a new one.
    const again = yield* registry.hold(TENANT_A, CHAT_2)
    return { gone: registry.find(TENANT_A, CHAT), found: found === two, again: again === two, holders: two.holders, channels: registry.size().channels }
  }))
  expect(got).toEqual({ gone: undefined, found: true, again: true, holders: 2, channels: 1 })
})

test("last never goes down by a give: a give of a number below last leaves last as it is, and one above it raises it", async () => {
  const registry = makeRegistry(LIMITS)
  const got = await run(Effect.gen(function*() {
    const channel = yield* registry.hold(TENANT_A, CHAT)
    yield* channel.give(event(5))
    const atFive = channel.last
    yield* channel.give(event(3))
    const afterThree = channel.last
    yield* channel.give(event(7))
    return [atFive, afterThree, channel.last]
  }))
  expect(got).toEqual([5, 5, 7])
})

test("a second removeClient of one client takes the host's count down one time only, and keeps the first reason; so does a removeClient after a slow end", async () => {
  const registry = makeRegistry({ ...LIMITS, buffer: 1 })
  const got = await run(Effect.gen(function*() {
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const one = yield* channel.addClient(0)
    yield* channel.addClient(0)
    const slow = yield* joined(channel, 0)
    const start = registry.size().clients
    yield* channel.removeClient(one, "stop")
    yield* channel.removeClient(one, "token")
    const afterTwo = registry.size().clients
    // The joined client ends as slow at its second entry; a removeClient after it counts nothing.
    yield* channel.give(event(1))
    yield* channel.give(event(2))
    const afterSlow = registry.size().clients
    yield* channel.removeClient(slow, "stop")
    return { start, afterTwo, afterSlow, afterAll: registry.size().clients, members: channel.clients.length, one: one.ended, slow: slow.ended }
  }))
  expect(got).toEqual({ start: 3, afterTwo: 2, afterSlow: 1, afterAll: 1, members: 1, one: { reason: "stop" }, slow: { reason: "slow" } })
})

test("tell, giveTo and join on a client that ended: each says so, puts nothing into its buffer, and joins nothing, for a client that had joined and one that had not", async () => {
  const registry = makeRegistry(LIMITS)
  const got = await run(Effect.gen(function*() {
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const was = yield* joined(channel, 0)
    const never = yield* channel.addClient(0)
    yield* channel.removeClient(was, "stop")
    yield* channel.removeClient(never, "stop")
    const each = []
    for (const client of [was, never]) {
      each.push({
        tell: yield* channel.tell(client, "{\"type\":\"ping\"}"),
        giveTo: yield* channel.giveTo(client, [event(1), event(2)]),
        join: yield* channel.join(client),
        joined: client.joined,
        size: client.size,
        given: client.given,
        taken: yield* client.take
      })
    }
    return { each, clients: registry.size().clients }
  }))
  const end: Taken = { _tag: "End", reason: "stop" }
  expect(got).toEqual({
    each: [
      { tell: "ended", giveTo: "ended", join: false, joined: true, size: { entries: 0, bytes: 0 }, given: 0, taken: end },
      { tell: "ended", giveTo: "ended", join: false, joined: false, size: { entries: 0, bytes: 0 }, given: 0, taken: end }
    ],
    clients: 0
  })
})

test("a reader that takes more than 1,024 entries from one buffer gets each, in order, with none twice: the buffer's compaction keeps each entry", async () => {
  const registry = makeRegistry(LIMITS)
  const got = await run(Effect.gen(function*() {
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    const texts: Array<string> = []
    const take = (count: number) =>
      Effect.gen(function*() {
        for (let k = 0; k < count; k++) {
          const taken = yield* client.take
          if (taken._tag === "Text") texts.push(taken.text)
        }
      })
    // 3,000 entries, then 1,500 taken (the compaction runs past 1,024), then
    // 2,000 more while 1,500 wait, then the rest.
    for (let n = 1; n <= 3_000; n++) yield* channel.give(event(n))
    yield* take(1_500)
    for (let n = 3_001; n <= 5_000; n++) yield* channel.give(event(n))
    yield* take(3_500)
    return { numbers: numbers(texts), left: client.size, ended: client.ended }
  }))
  expect(got.numbers).toEqual(range(1, 5_000))
  expect(got.left).toEqual({ entries: 0, bytes: 0 })
  expect(got.ended).toBeNull()
})

// A reader's wait and the wake that it waits for
// ----------------------------------------------
//
// Effect's fiber loop yields after a budget of steps (on the default
// scheduler, after 2,048). A reader whose check found nothing and whose
// wait were registered in a later step could yield between the two; a wake
// in that gap would find no waiter, and the reader would wait for good. So
// each case puts `steps` synchronous steps before the reader's wait, for
// each count from 0 to 2,100: the yield falls at each point of the reader's
// check and registration, whatever the number of steps of Effect's that
// make them. Each count asserts what the reader gets.

const STEPS = range(0, 2_100)
const SMALL: ChannelLimits = { ...LIMITS, buffer: 8, bufferBytes: 1_000, entry: 100, page: 8, pageBytes: 1_000 }

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, k) => from + k)
}

// `effect` after `steps` synchronous steps of Effect.
const afterSteps = <A>(steps: number, effect: Effect.Effect<A>) =>
  Effect.andThen(Effect.forEach(Array.from({ length: steps }), () => Effect.void, { discard: true }), effect)

// What `fiber` gave, once it is done; "waiting" if it is not done after 200
// yields (a woken reader is done after a few).
const settled = <A>(fiber: Fiber.Fiber<A>) =>
  Effect.gen(function*() {
    for (let k = 0; k < 200; k++) {
      const exit = fiber.pollUnsafe()
      if (exit !== undefined) return Exit.isSuccess(exit) ? exit.value : "failed"
      yield* Effect.yieldNow
    }
    return "waiting"
  })

// For each count of steps: a joined client of a new channel (with a frame
// in its buffer when `full`, so that it has no room for a page), its reader
// (`read`) forked after the steps, then `act` on the channel and the
// client; what the reader got. The reader is interrupted, the client
// removed and the channel let go at each count's end. Gives the counts
// whose reader did not get `want`.
const sweep = async <A>(
  read: (client: Client) => Effect.Effect<A>,
  act: (channel: Channel, client: Client) => Effect.Effect<unknown>,
  want: A,
  full = false
) => {
  const wrong: Array<{ readonly steps: number; readonly got: unknown }> = []
  for (const steps of STEPS) {
    const got = await run(Effect.gen(function*() {
      const registry = makeRegistry(SMALL)
      const channel = yield* registry.hold(TENANT_A, CHAT)
      const client = yield* joined(channel, 0)
      if (full) yield* channel.tell(client, "a frame")
      const reader = yield* Effect.forkChild(afterSteps(steps, read(client)))
      yield* Effect.yieldNow
      yield* act(channel, client)
      const got = yield* settled(reader)
      yield* Fiber.interrupt(reader)
      yield* channel.removeClient(client)
      yield* registry.letGo(channel)
      return got
    }))
    if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push({ steps, got })
  }
  return wrong
}

test("take after a give: for each count of steps before the reader's wait, from 0 to 2,100, the reader gets the given text", async () => {
  const wrong = await sweep((client) => client.take, (channel) => channel.give(event(1)), { _tag: "Text", text: event(1).json, bytes: event(1).bytes })
  expect(wrong).toEqual([])
})

test("take after the client's end: for each count of steps before the reader's wait, from 0 to 2,100, the reader gets End with the reason", async () => {
  const wrong = await sweep((client) => client.take, (channel, client) => channel.removeClient(client, "slow"), { _tag: "End", reason: "slow" })
  expect(wrong).toEqual([])
})

test("waitForPage after a take freed the room: for each count of steps before the reader's wait, from 0 to 2,100, the reader gets true", async () => {
  const wrong = await sweep((client) => client.waitForPage, (_, client) => client.take, true, true)
  expect(wrong).toEqual([])
})

test("waitForPage after the client's end: for each count of steps before the reader's wait, from 0 to 2,100, the reader gets false", async () => {
  const wrong = await sweep((client) => client.waitForPage, (channel, client) => channel.removeClient(client, "token"), false, true)
  expect(wrong).toEqual([])
})

// The waiters in a client's list now (its signal's, which no export shows).
const waiters = (client: Client) => (client as unknown as { readonly changed: { readonly size: number } }).changed.size

test("a wait that is interrupted leaves no waiter in the list, and a later wait of the same client still wakes", async () => {
  const got = await run(Effect.gen(function*() {
    const registry = makeRegistry(SMALL)
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    const first = yield* Effect.forkChild(client.take)
    yield* Effect.yieldNow
    const parked = { take: first.pollUnsafe() === undefined, waiters: waiters(client) }
    yield* Fiber.interrupt(first)
    const afterOne = waiters(client)
    const second = yield* Effect.forkChild(client.take)
    yield* Effect.yieldNow
    const again = waiters(client)
    yield* channel.give(event(1))
    const taken = yield* settled(second)
    const afterTake = waiters(client)
    yield* Fiber.interrupt(second)
    yield* channel.removeClient(client)
    yield* registry.letGo(channel)
    return { parked, afterOne, again, taken, afterTake }
  }))
  expect(got).toEqual({
    parked: { take: true, waiters: 1 },
    afterOne: 0,
    again: 1,
    taken: { _tag: "Text", text: event(1).json, bytes: event(1).bytes },
    afterTake: 0
  })
})

// The wait for a client's end (lead, ec-5njke, ruling 10)
// --------------------------------------------------------

test("whenEnded gives the reason of an end by a give (slow), by the host's stop, by cannotGive (internal), and null for a remove with none", async () => {
  const got = await run(Effect.gen(function*() {
    const registry = makeRegistry(SMALL)
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const slow = yield* joined(channel, 0)
    const stop = yield* joined(channel, 0)
    const internal = yield* joined(channel, 0)
    const gone = yield* joined(channel, 0)
    const waits = yield* Effect.forEach([slow, stop, internal, gone], (client) => Effect.forkChild(client.whenEnded))
    yield* Effect.yieldNow
    const before = yield* Effect.forEach(waits, settled)
    // A give with no room ends `slow` alone: the others have read theirs.
    for (let n = 1; n <= SMALL.buffer + 1; n++) {
      yield* channel.give(event(n))
      for (const client of [stop, internal, gone]) yield* drain(client)
    }
    yield* channel.removeClient(stop, "stop")
    yield* channel.removeClient(gone)
    yield* channel.cannotGive(SMALL.buffer + 2)
    const after = yield* Effect.forEach(waits, settled)
    yield* registry.letGo(channel)
    return { before, after }
  }))
  expect(got).toEqual({ before: ["waiting", "waiting", "waiting", "waiting"], after: ["slow", "stop", "internal", null] })
})

test("whenEnded after the end answers at once; a wait takes no text: the buffer's size and the next take are as before", async () => {
  const got = await run(Effect.gen(function*() {
    const registry = makeRegistry(SMALL)
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    yield* channel.give(event(1))
    yield* channel.give(event(2))
    const wait = yield* Effect.forkChild(client.whenEnded)
    yield* Effect.yieldNow
    // Each give wakes the wait, and it takes nothing.
    yield* channel.give(event(3))
    yield* Effect.yieldNow
    const waiting = { state: yield* settled(wait), size: client.size, waiters: waiters(client) }
    const next = yield* client.take
    yield* Fiber.interrupt(wait)
    const ended = yield* channel.addClient(0)
    yield* channel.removeClient(ended, "token")
    const late = yield* Effect.forkChild(ended.whenEnded)
    const lateGot = yield* settled(late)
    yield* channel.removeClient(client)
    yield* registry.letGo(channel)
    return { waiting, next: next._tag === "Text" ? numbers([next.text]) : next, lateGot }
  }))
  expect(got).toEqual({
    waiting: { state: "waiting", size: { entries: 3, bytes: 3 * event(1).bytes }, waiters: 1 },
    next: [1],
    lateGot: "token"
  })
})

test("a wait for the end that is interrupted leaves no waiter, and the client's reader still gets its texts and its end", async () => {
  const got = await run(Effect.gen(function*() {
    const registry = makeRegistry(SMALL)
    const channel = yield* registry.hold(TENANT_A, CHAT)
    const client = yield* joined(channel, 0)
    const wait = yield* Effect.forkChild(client.whenEnded)
    yield* Effect.yieldNow
    const parked = waiters(client)
    yield* Fiber.interrupt(wait)
    const afterInterrupt = waiters(client)
    yield* channel.give(event(1))
    yield* channel.removeClient(client, "stop")
    const read = yield* drain(client)
    yield* registry.letGo(channel)
    return { parked, afterInterrupt, read: { texts: numbers(read.texts), end: read.end } }
  }))
  expect(got).toEqual({ parked: 1, afterInterrupt: 0, read: { texts: [], end: { _tag: "End", reason: "stop" } } })
})
