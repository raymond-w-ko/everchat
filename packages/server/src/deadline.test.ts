// The measures of the lock's deadline (docs/host.md, section 2, "The
// deadline of the work under the lock", its table of four sums, and
// "Accepted risks", 1 and 2; section 8, "What is not proved here", "The two
// cases that pass the deadline's sums"; lead, ec-jyjxm). No code of the host
// changes here: each case runs the host's own message in (`Host.say`) over a
// model of a slow store, reads the times, and asserts the bound that the
// measure shows, so that a later change that makes one worse fails.
//
// A wait for the core's memory lock can be interrupted (memory.ts,
// `pushWith`; lead, ec-pqhgg): the last two cases measure that. A stopped
// load whose restart has 12 compactions answered frees the lock as risk 1
// does, at lock + 6 × store (the compaction writes still queued when the
// close reaches them are cut), not at 90 s as when the wait could not be
// cut. Risk 2 is gone: a log that waits behind a compaction's write is cut
// at the deadline, writes nothing and gives `ChatBusy`, and the lock is
// free at the deadline itself.
//
// The model of a slow store (the lead's ruling 1): a wrapper over the store's
// service that the stack gets, as turn.test.ts and host.test.ts wrap theirs.
// Each call of the store waits a given time on the TestClock before it runs,
// cannot be interrupted while it waits or runs, and fails with `StoreError`
// when its wait would pass the limit `store` (it then fails at `store`). A
// transaction and a snapshot are one call: the calls inside them do not
// wait again. Three calls that the store's service does not show are
// modelled as calls too: the launch row's write (`Chats.store`, "launch"),
// the end of the launch row when the loaded chat's scope closes ("launch
// end"), and the flush of the diagnostics batch at that close
// ("addDiagnostics": the stack writes one row then, as the diagnostics
// layer's batch does). A case gives each call its wait by the call's name,
// its start, and whether the chat is loaded. The times are the TestClock's:
// no real wait.
//
// The driver moves the TestClock from one due time to the next (each
// model call's end, and each deadline that the case names), and lets the
// fibers run in real time between two steps, so that every time read is the
// time of an event of the model.

import { expect, test } from "bun:test"
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Logger, Redacted, Scope, Semaphore, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { type Compaction, Compactor, Memory } from "@everchat/core/memory"
import type { Reply, Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, Store, StoreError } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { fakeWire, newFile, PICK, reply } from "@everchat/local/testing"
import { chatsLayer } from "@everchat/sqlite/bun"
import type { Channel } from "./channel.ts"
import { Host } from "./host.ts"
import { DEFAULTS } from "./limits.ts"
import type { LoadedChat } from "./loaded.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(new Uint8Array(32).fill(7))
const TENANT = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const STORE = DEFAULTS.store
// "Nearly its whole timer": 1 ms under `store`.
const NEARLY = STORE - 1

const says = (asked: Request, text: string): Reply =>
  reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

// The model
// ---------

// A call of the model, as the trace keeps it.
interface Call {
  readonly op: string
  readonly start: number
  readonly loaded: boolean
  end: number | null
  failed: boolean
}

interface Model {
  // The wait of a call (ms), by its name, its start, and whether the
  // chat was loaded when it started.
  wait: (op: string, start: number, loaded: boolean) => number
  readonly trace: Array<Call>
  // The ends of the waits under way.
  readonly dues: Array<number>
  // Whether the chat is loaded now (the case sets it from the channel).
  loaded: () => boolean
}

const model = (): Model => ({ wait: () => 0, trace: [], dues: [], loaded: () => false })

// True inside a transaction or a snapshot of the model: a call there waits
// no more.
const InCall = Context.Reference<boolean>("test/deadline/InCall", { defaultValue: () => false })

// One call of the model over `effect` (above).
const slow = <A, E, R>(m: Model, op: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
  Effect.uninterruptible(Effect.gen(function*() {
    if (yield* InCall) return yield* effect
    const start = yield* Clock.currentTimeMillis
    const loaded = m.loaded()
    const asked = m.wait(op, start, loaded)
    const call: Call = { op, start, loaded, end: null, failed: false }
    m.trace.push(call)
    const wait = Math.min(asked, STORE)
    m.dues.push(start + wait)
    yield* Effect.sleep(wait)
    m.dues.splice(m.dues.indexOf(start + wait), 1)
    if (asked >= STORE) {
      call.end = yield* Clock.currentTimeMillis
      call.failed = true
      return yield* new StoreError({ op, cause: new Error("the model's timer") })
    }
    const result = yield* Effect.exit(effect)
    call.end = yield* Clock.currentTimeMillis
    call.failed = Exit.isFailure(result)
    return yield* result
  }))

// The store's service with each call slowed by `m`.
const slowStore = (m: Model, store: typeof Store.Service): typeof Store.Service => {
  const wrapped: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(store)) {
    if (name === "transaction" || name === "snapshot") {
      wrapped[name] = (body: Effect.Effect<unknown, unknown, unknown>) =>
        slow(m, name, (store[name] as (b: typeof body) => typeof body)(Effect.provideService(body, InCall, true)))
    } else if (typeof value === "function") {
      wrapped[name] = (...args: Array<unknown>) => {
        const got = (value as (...a: Array<unknown>) => unknown).apply(store, args)
        return Effect.isEffect(got) ? slow(m, name, got) : got
      }
    } else if (Effect.isEffect(value)) {
      wrapped[name] = slow(m, name, value)
    } else {
      wrapped[name] = value
    }
  }
  return wrapped as unknown as typeof Store.Service
}

// `Chats` over the real one, its stores slowed by `m`.
const slowChats = (m: Model, real: typeof Chats.Service) =>
  Chats.of({
    make: real.make,
    reads: real.reads,
    store: (tenant, chat, launch) =>
      Effect.gen(function*() {
        // Registered first, so it runs after the real end of the launch row.
        yield* Effect.addFinalizer(() => Effect.orDie(slow(m, "launch end", Effect.void)))
        const store = yield* slow(m, "launch", real.store(tenant, chat, launch))
        return slowStore(m, store)
      })
  })

// The stack
// ---------

// The compactor's answer: at once (`null`), or at a time of the clock, or
// never. `asks`: the model answers, or never does (a turn then waits on
// the wire, and writes nothing more).
interface World {
  compactAt: number | "never" | null
  asks: boolean
}

const stackOf = (w: World) => {
  const wire = fakeWire((asked) => says(asked, "A reply."))
  const compactor = Layer.succeed(Compactor, Compactor.of({
    compact: () =>
      Effect.gen(function*() {
        const at = w.compactAt
        if (at === "never") return yield* Effect.never
        if (at !== null) yield* Effect.sleep(Math.max(0, at - (yield* Clock.currentTimeMillis)))
        return { text: "a summary" } satisfies Compaction
      })
  }))
  return (store: typeof Store.Service) => {
    const base = Layer.succeed(Store, store)
    // The diagnostics batch's flush at the scope's close: one call.
    const flush = Layer.effectDiscard(Effect.addFinalizer(() =>
      Effect.ignore(Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.addDiagnostics([{ level: "info", source: "test", text: "the batch", created: now }])))
    ))
    const memory = Memory.layer.pipe(Layer.provideMerge(base), Layer.provide(compactor))
    const asking = w.asks
      ? Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
      : Layer.succeed(Ask, Ask.of({ stream: () => Stream.never, ask: () => Effect.never }))
    const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.succeed({ output: "2", failed: false }) }))
    const functions = hostedLayer(HOSTED).pipe(Layer.provide(memory))
    return Turns.layer({ head: head(HOSTED) }).pipe(
      Layer.provideMerge(memory),
      Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), functions)),
      Layer.provideMerge(flush)
    )
  }
}

interface Built {
  readonly host: typeof Host.Service
  readonly real: typeof Chats.Service
  readonly uuid: string
  readonly channel: Channel<LoadedChat>
}

// The host's layer over the model `m`, in the case's scope, and a chat of
// the tenant whose channel the case holds.
const build = (m: Model, w: World) =>
  Effect.gen(function*() {
    const real = yield* Chats
    const layer = Host.layer({ stack: stackOf(w), launch: LAUNCH, secret: SECRET, origins: [] }).pipe(
      Layer.provide(Layer.succeed(Chats, slowChats(m, real)))
    )
    const context = yield* Layer.build(layer)
    const host = Context.get(context, Host)
    const uuid = yield* real.make(TENANT, PICK)
    const channel = yield* host.registry.held(TENANT, uuid)
    m.loaded = () => channel.loaded !== undefined
    return { host, real, uuid, channel } satisfies Built
  })

// Runs a case over a new file, on Effect's TestClock, with no logger: the
// host's and the turn loop's lines are not what a case measures.
const run = <A, E>(body: Effect.Effect<A, E, Chats | Scope.Scope>) => {
  const file = newFile()
  return Effect.runPromise(
    body.pipe(Effect.scoped, Effect.provide(chatsLayer(file)), Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])))
  )
}

// The driver
// ----------

// Lets the fibers run, in real time, with the clock still.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))

// The free permits of a channel's lock (the semaphore's own count).
const free = (channel: Channel<LoadedChat>) => (channel.lock as unknown as { readonly free: number }).free

// What the driver saw: when the lock was taken and given back, and when the
// fiber ended.
interface Seen {
  taken: number | null
  freed: number | null
  ended: number | null
}

// What has happened, as a text that changes when anything of the case
// changes: the model's calls, started and ended, the lock, the fiber.
const state = <A, E>(m: Model, channel: Channel<LoadedChat>, fiber: Fiber.Fiber<A, E>) =>
  `${m.trace.length} ${m.trace.filter((call) => call.end !== null).length} ${free(channel)} ${fiber.pollUnsafe() !== undefined}`

// Lets the fibers run until nothing changes for four settles in a row:
// each fiber that the last step woke has then reached its next wait.
const quiet = <A, E>(m: Model, channel: Channel<LoadedChat>, fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function*() {
    let last = ""
    for (let same = 0; same < 4;) {
      yield* settle
      const now = state(m, channel, fiber)
      same = now === last ? same + 1 : 0
      last = now
    }
  })

// Moves the clock until `fiber` has ended: each step goes to the next end
// of a model call, or to the next of `marks`, whichever comes first.
const drive = <A, E>(m: Model, channel: Channel<LoadedChat>, fiber: Fiber.Fiber<A, E>, marks: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    const seen: Seen = { taken: null, freed: null, ended: null }
    for (let step = 0; step < 2_000; step++) {
      yield* quiet(m, channel, fiber)
      const now = yield* Clock.currentTimeMillis
      if (seen.taken === null && free(channel) === 0) seen.taken = now
      if (seen.taken !== null && seen.freed === null && free(channel) === 1) seen.freed = now
      if (fiber.pollUnsafe() !== undefined) {
        seen.ended = now
        return seen
      }
      const next = Math.min(...[...m.dues, ...marks].filter((at) => at > now))
      if (!Number.isFinite(next)) return yield* Effect.die(new Error(`the case is stuck at ${now}`))
      yield* TestClock.adjust(next - now)
    }
    return yield* Effect.die(new Error("the case took more than 2,000 steps"))
  })

// The trace in one line: each call's name, start and end, in seconds.
const traced = (m: Model, from: number) =>
  m.trace.map((call) =>
    `${call.op}${call.loaded ? "" : "*"} ${((call.start - from) / 1000).toFixed(3)}-${call.end === null ? "?" : ((call.end - from) / 1000).toFixed(3)}${call.failed ? "!" : ""}`
  ).join(", ")

// The cases
// ---------

// Writes `body` with a store of the chat's own, outside the host: a launch
// that ends when it is done.
const before = <A, E>(b: Built, body: (store: typeof Store.Service) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(b.real.store(TENANT, b.uuid, { ...LAUNCH, runTag: "before" }), body))

// A client of the channel that joined, with `given`: so the unload reads
// (Unload, step 2).
const joined = (channel: Channel<LoadedChat>, given: number) =>
  Effect.gen(function*() {
    const client = yield* channel.addClient(given)
    expect(yield* channel.join(client)).toBe(true)
    return client
  })

// A turn that a crash left running, with its program running: `input` of
// `pages` pages of 30,000 characters. Gives the chat's `seq` after it.
const crashed = (b: Built, pages: number, char: string) =>
  before(b, (store) =>
    Effect.gen(function*() {
      const [said] = yield* store.append([{ kind: "user", text: "run it" }])
      const turn = yield* store.startTurn({ pick: PICK, head: JSON.stringify(head(HOSTED)), firstMsg: said!.i })
      yield* store.addEvent({ type: "start", turn: turn.id })
      yield* store.startCall({ turn: turn.id, vendorId: "c1", fn: "run", input: char.repeat(pages * 30_000) })
      return (yield* store.chat).seq
    }))

// The wait of a call of the load that fills the time up to `at`: nearly
// `store` at most, and none past `at`.
const fill = (at: number, start: number) => Math.max(0, Math.min(NEARLY, at - start))

// After the measure: no call waits any more, and the clock moves on until
// each wait under way has ended, so that the scope's end (the host's end)
// does not wait on a clock that no one moves.
const finish = (m: Model) =>
  Effect.gen(function*() {
    m.wait = () => 0
    for (let k = 0; k < 20; k++) {
      yield* settle
      yield* TestClock.adjust(STORE)
    }
  })

// One measure: `setup` gives the model's waits; then a message in, from
// `t0`, after a lock that the case holds until `held` ms (0: none). Gives
// the times, from `t0`, and the trace.
const measure = (setup: (b: Built, m: Model, w: World, t0: number) => Effect.Effect<ReadonlyArray<number>, unknown, Scope.Scope>, held = 0) =>
  run(Effect.gen(function*() {
    const m = model()
    const w: World = { compactAt: null, asks: true }
    const b = yield* build(m, w)
    const t0 = yield* Clock.currentTimeMillis
    const marks = yield* setup(b, m, w, t0)
    // The stack reads `w` at each load, and the compactor at each answer.
    if (held > 0) {
      yield* Semaphore.take(b.channel.lock, 1)
      yield* Effect.forkChild(Effect.andThen(Effect.sleep(held), Semaphore.release(b.channel.lock, 1)))
    }
    const said = yield* Effect.forkChild(Effect.exit(b.host.say(TENANT, b.uuid, "hello", null)))
    const seen = yield* drive(m, b.channel, said, [t0 + held, t0 + held + DEFAULTS.lock, ...marks])
    const exit = yield* Fiber.join(said)
    const trace = traced(m, t0)
    yield* finish(m)
    if (process.env["DEADLINE_TRACE"] !== undefined) console.log(JSON.stringify(seen), "\n", trace)
    // `freed` and `ended` from `t0`. With a lock of the case's own, the
    // lock is first freed at `held`: the place's rows read `ended`.
    return {
      freed: seen.freed! - t0,
      ended: seen.ended! - t0,
      exit,
      trace
    }
  }))

// The bound that a measure shows: at most the page's sum, and within 20 ms
// of it, so that the case measures what it names.
const near = (got: number, sum: number) => {
  expect(got).toBeLessThanOrEqual(sum)
  expect(got).toBeGreaterThan(sum - 20)
}

// The four sums
// -------------

test("the lock, for a log whose append takes nearly store: free at lock + store (25 s)", async () => {
  const got = await measure((_b, m, _w, t0) =>
    Effect.sync(() => {
      // The load fills the time to 19.99 s; then the log, at nearly store.
      m.wait = (_op, start, loaded) => (loaded ? NEARLY : fill(t0 + 19_990, start))
      return []
    }))
  near(got.freed, DEFAULTS.lock + STORE)
  expect(got.trace).toContain("transaction 19.990-24.989")
})

test("the lock, for a load that is stopped at its deadline: free at lock + 4 × store (40 s)", async () => {
  const got = await measure((b, m) =>
    Effect.gen(function*() {
      yield* joined(b.channel, 0)
      m.wait = () => NEARLY
      return []
    }))
  near(got.freed, DEFAULTS.lock + 4 * STORE)
  expect(got.trace).toMatch(/addDiagnostics\* [\d.]+-[\d.]+, launch end\* [\d.]+-[\d.]+, eventsAfter\* [\d.]+-39\.992$/)
})

test("the lock, for a log whose write fails: free at lock + 4 × store (40 s)", async () => {
  const got = await measure((b, m, _w, t0) =>
    Effect.gen(function*() {
      yield* joined(b.channel, 0)
      let failed = false
      m.wait = (op, start, loaded) => {
        if (!loaded) return fill(t0 + 19_990, start)
        if (op === "transaction" && !failed) {
          failed = true
          return STORE
        }
        return NEARLY
      }
      return []
    }))
  near(got.freed, DEFAULTS.lock + 4 * STORE)
  expect(got.trace).toContain("transaction 19.990-24.990!")
})

test("a request's place and its holder, for a log: free at request + store after its head (35 s)", async () => {
  const held = DEFAULTS.lockWait - 1
  const got = await measure((_b, m, _w, t0) =>
    Effect.sync(() => {
      m.wait = (_op, start, loaded) => (loaded ? NEARLY : fill(t0 + held + 19_990, start))
      return []
    }), held)
  near(got.ended, DEFAULTS.request + STORE)
})

test("a request's place and its holder, for a load that is stopped: free at request + 4 × store after its head (50 s)", async () => {
  const held = DEFAULTS.lockWait - 1
  const got = await measure((b, m) =>
    Effect.gen(function*() {
      yield* joined(b.channel, 0)
      m.wait = () => NEARLY
      return []
    }), held)
  near(got.ended, DEFAULTS.request + 4 * STORE)
})

// The two accepted risks
// ----------------------

// A restart of a cut program of 12 pages of control characters (6 bytes of
// JSON each): its tool's 12 pages, the echo and the start are 14 events,
// over `page` bytes together, so a read of them takes 2 calls. The launch
// and the memory's first call take nearly store, the load's calls up to the
// restart's `start` none, and its calls after it fill the time to 19.99 s;
// from then on each call takes nearly store: the listener's first read is
// in flight at the deadline, then come the unload's calls.
const replay = (w: World, compactAt: World["compactAt"]) => (b: Built, m: Model, _w: World, t0: number) =>
  Effect.gen(function*() {
    w.asks = false
    w.compactAt = compactAt
    const seq = yield* crashed(b, 12, "\u0001")
    yield* joined(b.channel, seq)
    let restarted = false
    m.wait = (op, start) => {
      if (op === "launch" || op === "count" || start >= t0 + 19_990) return NEARLY
      if (op === "addEvent") restarted = true
      return restarted ? fill(t0 + 19_990, start) : 0
    }
    return []
  })

test("risk 1: a load stopped while it replays a restart of 14 large events reads them again in 2 calls, after the restarted turn's own call: the lock is free at 50 s (the page: 44.5 s)", async () => {
  const got = await measure((b, m, w, t0) => replay(w, "never")(b, m, w, t0))
  // The listener's read in flight at the deadline; the restarted turn's
  // call that started as the close began; the close (the flush, the
  // launch's end); the unload's read of the 14 events: 2 calls.
  near(got.freed, 49_984)
  expect(got.trace).toMatch(
    /eventsAfter\* 19\.990-24\.989, messagesAfter\* 24\.989-29\.988, addDiagnostics\* 29\.988-34\.987, launch end\* 34\.987-39\.986, eventsAfter\* 39\.986-44\.985, eventsAfter\* 44\.985-49\.984$/
  )
}, 20_000)

test("the same stopped load with the 12 compactions of its restart answered: the close cuts the compaction writes that wait for the memory's lock; only the one that takes it as the close begins runs, beside the restarted turn's call: the lock is free at lock + 6 × store (50 s), as in risk 1", async () => {
  const got = await measure((b, m, w, t0) => replay(w, null)(b, m, w, t0))
  // The load's call in flight at the deadline ends at 24.989 s, and the
  // close begins. The compaction write in flight then (19.990 s) frees the
  // memory's lock at that moment, and the next queued write takes it before
  // the close reaches the compactions: it runs beside the restarted turn's
  // `messagesAfter` and costs no time of its own. Every other queued write
  // is cut: none starts from 25 s on.
  near(got.freed, 49_984)
  expect(got.trace).toContain("messagesAfter* 24.989-29.988, transaction* 24.989-29.988, addDiagnostics* 29.988-34.987")
  expect(got.trace.match(/transaction\* (2[5-9]|[3-9]\d|\d{3,})\./g)).toBeNull()
}, 20_000)

test("risk 2 no more: a log that waits for the memory's own lock behind a compaction's write is cut at the deadline, logs nothing, and the lock is free at 20 s", async () => {
  const got = await measure((b, m, w, t0) =>
    Effect.gen(function*() {
      // The restart's log starts the compaction of its program's leaf, which
      // answers at 19.985 s; its write then takes nearly store, under the
      // memory's lock.
      w.asks = false
      yield* crashed(b, 1, "x")
      w.compactAt = t0 + 19_985
      // The launch takes nearly store; the load's calls up to the restart's
      // `start` none (so its log starts the compaction early); its calls
      // after it fill the time to 19.99 s. From 19.985 s each call takes
      // nearly store: the compaction's write, then the message's log.
      let restarted = false
      m.wait = (op, start, loaded) => {
        if (loaded || start >= t0 + 19_985) return NEARLY
        if (op === "launch") return NEARLY
        if (op === "addEvent") restarted = true
        return restarted ? fill(t0 + 19_990, start) : 0
      }
      return [t0 + 19_985]
    }))
  // The compaction's write from 19.985 s; the log's wait for the memory's
  // lock is cut at the deadline: no write of the log, `ChatBusy`.
  near(got.freed, DEFAULTS.lock)
  expect(got.trace).toContain("transaction* 19.985-")
  expect(got.trace).not.toMatch(/transaction \d/)
  expect(Exit.isFailure(got.exit) && Cause.findErrorOption(got.exit.cause)).toMatchObject({ _tag: "Some", value: { _tag: "ChatBusy" } })
}, 20_000)
