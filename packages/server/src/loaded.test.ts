// Tests of the loaded chat (loaded.ts; docs/host.md, section 2, "Load",
// "Work, and the 6 minutes", "Unload", "Load again" and the last paragraph
// of "The give"): the launch row and its run tag, the listener (its start,
// its read, the live events, a loss of the hub, pieces), the timer, the
// unload and its read, the bound of loaded chats, a load that fails or is
// stopped, an event that cannot be given, the tenant boundary, and the
// loader's end. Each case runs on the SQLite store of a test file, with a
// stack of the core's hosted set over the tests' fake wire.

import { expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Scope, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, type Event, LaunchLive, NoChat, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer, ProcessAlive } from "@everchat/sqlite/bun"
import { type Channel, type Client, makeRegistry, type Registry } from "./channel.ts"
import { fit } from "./fit.ts"
import { DEFAULTS, type Limits } from "./limits.ts"
import { type LoadedChat, LoadedFull, type Loader, makeLoader } from "./loaded.ts"

const LIMITS: Limits = DEFAULTS
const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

type Run = (program: string) => Effect.Effect<{ output: string; failed: boolean }>

// A reply that runs one program, and one that says a text.
const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }]
  })
const says = (asked: Request, text: string): Reply =>
  reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

// What a case changes between its loads: the wire's answers, the sandbox,
// the hub, and the gates that hold a load at one of its steps. `reads`:
// the `after` of each read of the events of a loaded chat's store.
interface World {
  answer: (asked: Request, n: number) => Reply
  run: Run
  hub: number | undefined
  gate: {
    store?: Effect.Effect<void> | undefined
    stack?: Effect.Effect<void> | undefined
    beforeRead?: (() => Effect.Effect<void>) | undefined
    afterRead?: (() => Effect.Effect<void>) | undefined
  }
  reads: Array<number>
  turns: typeof Turns.Service | undefined
}

const world = (over: Partial<World> = {}): World => ({
  answer: (asked) => says(asked, "A reply."),
  run: () => Effect.succeed({ output: "2", failed: false }),
  hub: undefined,
  gate: {},
  reads: [],
  turns: undefined,
  ...over
})

// The stack of a loaded chat over its store: the memory, the ask service
// over the fake wire, a fake sandbox, the hosted set, and the turn loop.
// It keeps the turn loop of the last load in `w.turns`.
const stackOf = (w: World) => {
  const wire = fakeWire((asked, n) => w.answer(asked, n))
  return (store: typeof Store.Service) => {
    const base = Layer.succeed(Store, store)
    const memory = Memory.layer.pipe(Layer.provideMerge(base), Layer.provide(compactor(() => "a summary")))
    const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
    const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: (program) => w.run(program) }))
    const functions = hostedLayer(HOSTED).pipe(Layer.provide(memory))
    const turns = Turns.layer({ head: head(HOSTED), hub: w.hub }).pipe(
      Layer.provideMerge(memory),
      Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), functions)),
      Layer.tap((context) => Effect.sync(() => (w.turns = Context.get(context, Turns))))
    )
    const gate = w.gate.stack
    return gate === undefined ? turns : Layer.merge(Layer.effectDiscard(gate), turns)
  }
}

// `Chats` over the real one, with the gates of `w` and its count of reads.
const wrap = (real: typeof Chats.Service, w: World) =>
  Chats.of({
    make: real.make,
    reads: real.reads,
    store: (tenant, chat, launch) =>
      Effect.gen(function*() {
        const store = yield* real.store(tenant, chat, launch)
        if (w.gate.store !== undefined) yield* w.gate.store
        const eventsAfter = (after: number, limit: number) =>
          Effect.gen(function*() {
            w.reads.push(after)
            const before = w.gate.beforeRead
            if (before !== undefined) yield* before()
            const events = yield* store.eventsAfter(after, limit)
            const later = w.gate.afterRead
            if (later !== undefined) yield* later()
            return events
          })
        return { ...store, eventsAfter }
      })
  })

interface Setup {
  readonly real: typeof Chats.Service
  readonly registry: Registry<LoadedChat>
  readonly loader: Loader
}

// A registry and a loader over `w`, in the caller's scope.
const setup = (w: World, limits: Limits = LIMITS) =>
  Effect.gen(function*() {
    const real = yield* Chats
    const registry = makeRegistry<LoadedChat>(limits)
    const loader = yield* makeLoader({ stack: stackOf(w), launch: LAUNCH, limits, registry }).pipe(
      Effect.provideService(Chats, wrap(real, w))
    )
    return { real, registry, loader } satisfies Setup
  })

// Runs a case over a new file.
const run = <A, E>(body: (file: string) => Effect.Effect<A, E, Chats | Scope.Scope>, clock = false) => {
  const file = newFile()
  const ran = body(file).pipe(Effect.scoped, Effect.provide(chatsLayer(file)))
  return Effect.runPromise(clock ? ran.pipe(Effect.provide(TestClock.layer())) : ran)
}

// The load and the unload under the channel's lock, as the routes run them.
const load = (s: Setup, channel: Channel<LoadedChat>) => Semaphore.withPermit(channel.lock, s.loader.load(channel))
const unload = (s: Setup, channel: Channel<LoadedChat>) => Semaphore.withPermit(channel.lock, s.loader.unload(channel))

// A new chat of `tenant`, and its channel, held until the case ends.
const chatOf = (s: Setup, tenant = TENANT_A) =>
  Effect.gen(function*() {
    const uuid = yield* s.real.make(tenant, PICK)
    const channel = yield* s.registry.held(tenant, uuid)
    return { uuid, channel }
  })

// A client of `channel` that joined, with `given`.
const joined = (channel: Channel<LoadedChat>, given: number) =>
  Effect.gen(function*() {
    const client = yield* channel.addClient(given)
    expect(yield* channel.join(client)).toBe(true)
    return client
  })

// Everything in a client's buffer now, with no wait.
const drain = (client: Client) =>
  Effect.gen(function*() {
    const texts: Array<string> = []
    while (client.size.entries > 0) {
      const taken = yield* client.take
      if (taken._tag === "Text") texts.push(taken.text)
    }
    return texts
  })
const parsed = (texts: ReadonlyArray<string>) => texts.map((text) => JSON.parse(text) as { type: string; n?: number })
const numbers = (texts: ReadonlyArray<string>) => parsed(texts).filter((one) => one.n !== undefined).map((one) => one.n as number)
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k)

// Waits, in real time, until `check` holds (2 s at most).
const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 2_000 && !check(); k++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
    }
    if (!check()) return yield* Effect.die(new Error("the case waited for a state that did not come"))
  })

// The chat's `seq` and its events, read from the store.
const seqOf = (s: Setup, tenant: string, uuid: string) =>
  Effect.flatMap(Effect.orDie(s.real.reads(tenant, uuid)), (reads) => Effect.map(Effect.orDie(reads.chat), (chat) => chat.seq))

// The launch rows of the file.
interface LaunchRow {
  readonly pid: number
  readonly run_tag: string
  readonly ended: number | null
  readonly why: string | null
}
const launches = (file: string) => rows<LaunchRow>(file, "select pid, run_tag, ended, why from everchat_launch order by chat, n")

// The turn loop of the last load, and a message that runs a whole turn.
const turnsOf = (w: World) => {
  if (w.turns === undefined) throw new Error("no load has built a turn loop")
  return w.turns
}
const sayAll = (w: World, text: string) =>
  Effect.gen(function*() {
    const turns = turnsOf(w)
    yield* Effect.orDie(turns.say(text))
    yield* turns.idle
  })

// The lines of Effect's log while `effect` runs, and its value. The fibers
// that it forks keep the logger.
const logged = <A, E, R>(effect: Effect.Effect<A, E, R>, lines: Array<string>) => {
  const logger = Logger.make((line) => {
    const message = line.message
    lines.push(`${line.logLevel}: ${Array.isArray(message) ? message.join(" ") : String(message)}`)
  })
  return Effect.provide(effect, Logger.layer([logger]))
}

// The launch row and the run tag
// ------------------------------

test("each load writes a launch row with a new run tag, and its unload ends it", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { channel } = yield* chatOf(s)
      const one = yield* load(s, channel)
      expect(channel.loaded).toBe(one)
      expect(launches(file)).toEqual([{ pid: process.pid, run_tag: one.runTag, ended: null, why: null }])
      yield* unload(s, channel)
      const two = yield* load(s, channel)
      yield* unload(s, channel)
      expect(two.runTag).not.toBe(one.runTag)
      const rowsNow = launches(file)
      expect(rowsNow.map((row) => [row.run_tag, row.why])).toEqual([[one.runTag, "exit"], [two.runTag, "exit"]])
      expect(rowsNow.every((row) => row.ended !== null)).toBe(true)
    })
  )
})

// The listener
// ------------

test("the events that a restart of a cut turn writes before the listener subscribes reach a client that joined, each once, in order", async () => {
  await run(() =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const w = world({
        answer: (asked) => runs(asked, "call_1", "slow()"),
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
      })
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      yield* load(s, channel)
      yield* Effect.orDie(turnsOf(w).say("do the slow thing"))
      yield* Deferred.await(started)
      // The unload cuts the turn: its program runs.
      yield* unload(s, channel)
      expect(numbers(yield* drain(client))).toEqual([1, 2, 3])
      w.answer = (asked) => says(asked, "It was cut.")
      // The restart writes its events while the stack is built, before any
      // listener; the read after `last` gives them.
      let restarted = -1
      w.gate.beforeRead = () =>
        Effect.gen(function*() {
          w.gate.beforeRead = undefined
          restarted = yield* seqOf(s, TENANT_A, uuid)
        })
      yield* load(s, channel)
      yield* turnsOf(w).idle
      const seq = yield* seqOf(s, TENANT_A, uuid)
      yield* until(() => client.given === seq)
      expect(restarted).toBeGreaterThanOrEqual(6)
      expect(seq).toBe(8)
      expect(numbers(yield* drain(client))).toEqual(range(4, 8))
      yield* unload(s, channel)
    })
  )
})

test("the listener subscribes before its read: events of a turn that runs while it reads reach a joined client live, each once, in order", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      // After the store's read of the load, and before it is given, a whole
      // turn runs: its events are published, never read by the listener's read.
      w.gate.afterRead = () =>
        Effect.gen(function*() {
          w.gate.afterRead = undefined
          yield* sayAll(w, "hello")
        })
      yield* load(s, channel)
      const seq = yield* seqOf(s, TENANT_A, uuid)
      expect(seq).toBe(4)
      yield* until(() => client.given === seq)
      expect(numbers(yield* drain(client))).toEqual(range(1, 4))
      yield* unload(s, channel)
    })
  )
})

test("a live event at or below last is dropped: the listener gives each number once", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      const given: Array<number> = []
      const give = channel.give.bind(channel)
      channel.give = (entry) => Effect.andThen(Effect.sync(() => given.push(entry.n as number)), give(entry))
      // A whole turn runs before the store's read: its events come from the
      // read, and again live, at or below `last`.
      w.gate.beforeRead = () =>
        Effect.gen(function*() {
          w.gate.beforeRead = undefined
          yield* sayAll(w, "hello")
        })
      yield* load(s, channel)
      const seq = yield* seqOf(s, TENANT_A, uuid)
      // One more live event after them, so the listener has taken the old ones.
      yield* sayAll(w, "and again")
      const after = yield* seqOf(s, TENANT_A, uuid)
      yield* until(() => client.given === after)
      expect(seq).toBe(4)
      expect(given).toEqual(range(1, after))
      expect(numbers(yield* drain(client))).toEqual(range(1, after))
      yield* unload(s, channel)
    })
  )
})

test("the listener's start: with no client that joined it reads after the store's seq, and a client that has not joined does not count", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      yield* load(s, channel)
      yield* sayAll(w, "hello")
      yield* unload(s, channel)
      const seq = yield* seqOf(s, TENANT_A, uuid)
      expect(seq).toBe(4)
      // A client that has not joined, at 0: the next load reads after `seq`.
      const waiting = yield* channel.addClient(0)
      w.reads.length = 0
      yield* load(s, channel)
      expect(w.reads[0]).toBe(seq)
      expect(channel.last).toBe(seq)
      expect(waiting.size.entries).toBe(0)
      yield* unload(s, channel)
      // Two clients that joined, at 1 and 3, and one that has not, at 0: it
      // reads after 1, and each gets the events above its own `given`. They
      // join on a channel with no `last`: a new channel of the same chat, in
      // a registry of its own.
      w.reads.length = 0
      const fresh = makeRegistry<LoadedChat>(LIMITS)
      const other = yield* fresh.held(TENANT_A, uuid)
      const a = yield* joined(other, 1)
      const b = yield* joined(other, 3)
      yield* other.addClient(0)
      const loader = yield* makeLoader({ stack: stackOf(w), launch: LAUNCH, limits: LIMITS, registry: fresh }).pipe(
        Effect.provideService(Chats, wrap(s.real, w))
      )
      yield* Semaphore.withPermit(other.lock, loader.load(other))
      expect(w.reads[0]).toBe(1)
      expect(numbers(yield* drain(a))).toEqual([2, 3, 4])
      expect(numbers(yield* drain(b))).toEqual([4])
      yield* Semaphore.withPermit(other.lock, loader.unload(other))
    })
  )
})

test("a hub of 4 entries and the listener held: in a burst of 40 numbered events each joined client gets each number once, in order, and the lost ones came from the store", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world({ hub: 4 })
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const one = yield* joined(channel, 0)
      const two = yield* joined(channel, 0)
      yield* load(s, channel)
      w.reads.length = 0
      // The listener waits for the give lock while the turns run.
      yield* Semaphore.take(channel.giveLock, 1)
      for (let k = 0; k < 10; k++) yield* sayAll(w, "message " + k)
      const seq = yield* seqOf(s, TENANT_A, uuid)
      expect(seq).toBe(40)
      yield* Semaphore.release(channel.giveLock, 1)
      yield* until(() => one.given === seq && two.given === seq)
      expect(numbers(yield* drain(one))).toEqual(range(1, 40))
      expect(numbers(yield* drain(two))).toEqual(range(1, 40))
      expect(w.reads.length).toBeGreaterThan(0)
      yield* unload(s, channel)
    })
  )
})

test("a piece reaches the clients that joined and no other", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const member = yield* joined(channel, 0)
      const waiting = yield* channel.addClient(0)
      yield* load(s, channel)
      yield* sayAll(w, "hello")
      const seq = yield* seqOf(s, TENANT_A, uuid)
      yield* until(() => member.given === seq)
      const got = parsed(yield* drain(member))
      expect(got.map((one) => one.type)).toEqual(["accepted", "start", "text", "message", "end"])
      expect(waiting.size.entries).toBe(0)
      yield* unload(s, channel)
    })
  )
})

// The timer
// ---------

test("the timer unloads 6 minutes after the last work, and a message at minute 5 moves it", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { channel } = yield* chatOf(s)
      yield* load(s, channel)
      yield* sayAll(w, "hello")
      yield* TestClock.adjust("5 minutes")
      yield* sayAll(w, "at minute 5")
      yield* TestClock.adjust("1 minute")
      yield* settle
      expect(channel.loaded).toBeDefined()
      yield* TestClock.adjust(5 * 60_000 - 1)
      yield* settle
      expect(channel.loaded).toBeDefined()
      yield* TestClock.adjust(1)
      yield* until(() => channel.loaded === undefined)
      expect(s.loader.loaded()).toBe(0)
      expect(launches(file).map((row) => [row.ended, row.why])).toEqual([[11 * 60_000, "exit"]])
      expect(channel.holders).toBe(1)
    }), true)
})

test("the timer does not unload while a turn runs: it takes the lock, finds work, and unloads 6 minutes after the turn's end", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const w = world({
        answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { output: "2", failed: false }))
      })
      const s = yield* setup(w)
      const { channel } = yield* chatOf(s)
      yield* load(s, channel)
      yield* TestClock.adjust(6 * 60_000 - 1)
      // The timer wakes at minute 6 and waits for the lock; meanwhile a turn starts.
      yield* Semaphore.take(channel.lock, 1)
      yield* TestClock.adjust(1)
      yield* settle
      yield* Effect.orDie(turnsOf(w).say("do the slow thing"))
      yield* Deferred.await(started)
      yield* Semaphore.release(channel.lock, 1)
      yield* settle
      expect(channel.loaded).toBeDefined()
      yield* TestClock.adjust("20 minutes")
      yield* settle
      expect(channel.loaded).toBeDefined()
      // The turn ends at minute 26; the chat unloads at minute 32.
      yield* Deferred.succeed(release, undefined)
      yield* turnsOf(w).idle
      yield* TestClock.adjust(6 * 60_000 - 1)
      yield* settle
      expect(channel.loaded).toBeDefined()
      yield* TestClock.adjust(1)
      yield* until(() => channel.loaded === undefined)
      expect(launches(file).map((row) => row.ended)).toEqual([32 * 60_000])
    }), true)
})

// Lets the fibers run, in real time, with the clock still.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

// The unload
// ----------

test("the unload ends the launch row; the client stays a client of its channel, and the channel leaves the registry only with its last holder", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const uuid = yield* s.real.make(TENANT_A, PICK)
      const scope = yield* Scope.make()
      const channel = yield* Scope.provide(scope)(s.registry.held(TENANT_A, uuid))
      const client = yield* joined(channel, 0)
      yield* load(s, channel)
      expect(channel.holders).toBe(2)
      yield* unload(s, channel)
      expect(launches(file).map((row) => row.why)).toEqual(["exit"])
      expect(channel.loaded).toBeUndefined()
      expect(client.ended).toBeNull()
      expect(channel.clients).toEqual([client])
      expect(channel.holders).toBe(1)
      expect(s.registry.find(TENANT_A, uuid)).toBe(channel)
      expect(s.loader.loaded()).toBe(0)
      // A second unload does nothing.
      yield* unload(s, channel)
      expect(channel.holders).toBe(1)
      yield* Scope.close(scope, Exit.void)
      expect(s.registry.find(TENANT_A, uuid)).toBeUndefined()
    })
  )
})

test("after an unload a joined client has every event up to the store's seq, the end of the last turn too", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      yield* load(s, channel)
      // The listener is held at its first give; the unload stops it there.
      yield* Semaphore.take(channel.giveLock, 1)
      yield* sayAll(w, "hello")
      const unloading = yield* Effect.forkChild(unload(s, channel))
      yield* settle
      yield* Semaphore.release(channel.giveLock, 1)
      yield* Fiber.join(unloading)
      const seq = yield* seqOf(s, TENANT_A, uuid)
      expect(seq).toBe(4)
      const got = parsed(yield* drain(client))
      expect(got.filter((one) => one.n !== undefined).map((one) => [one.n, one.type])).toEqual([[1, "accepted"], [2, "start"], [3, "message"], [4, "end"]])
      expect(client.given).toBe(4)
      expect(channel.last).toBe(4)
    })
  )
})

test("an unload with no client that joined reads nothing", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { channel } = yield* chatOf(s)
      const waiting = yield* channel.addClient(0)
      yield* load(s, channel)
      yield* sayAll(w, "hello")
      w.reads.length = 0
      yield* unload(s, channel)
      expect(w.reads).toEqual([])
      expect(waiting.size.entries).toBe(0)
    })
  )
})

test("one client across three loads and unloads gets each event once, in order", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      const texts: Array<string> = []
      for (let k = 0; k < 3; k++) {
        yield* load(s, channel)
        yield* sayAll(w, "message " + k)
        yield* unload(s, channel)
        texts.push(...(yield* drain(client)))
      }
      const seq = yield* seqOf(s, TENANT_A, uuid)
      expect(seq).toBe(12)
      expect(numbers(texts)).toEqual(range(1, 12))
    })
  )
})

// A load that is refused, fails or is stopped
// --------------------------------------------

test("a chat that another live launch holds gives LaunchLive, and nothing is held", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const other = yield* Scope.make()
      yield* Scope.provide(other)(Effect.orDie(s.real.store(TENANT_A, uuid, { ...LAUNCH, pid: 999_999, runTag: "other" })))
      const error = yield* Effect.flip(load(s, channel))
      expect(error).toBeInstanceOf(LaunchLive)
      expect({ loaded: channel.loaded, places: s.loader.loaded(), holders: channel.holders }).toEqual({ loaded: undefined, places: 0, holders: 1 })
      expect(launches(file).map((row) => [row.pid, row.ended])).toEqual([[999_999, null]])
      yield* Scope.close(other, Exit.void)
    }).pipe(Effect.provideService(ProcessAlive, () => true))
  )
})

test("the load past the bound is refused before the store, with no launch row; of two loads at one time for one place one passes", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w, { ...LIMITS, loaded: 1 })
      const a = yield* chatOf(s)
      const b = yield* chatOf(s)
      yield* load(s, a.channel)
      const error = yield* Effect.flip(load(s, b.channel))
      expect(error).toBeInstanceOf(LoadedFull)
      expect(launches(file).length).toBe(1)
      expect(b.channel.holders).toBe(1)
      yield* unload(s, a.channel)
      expect(s.loader.loaded()).toBe(0)
      const both = yield* Effect.all([Effect.result(load(s, a.channel)), Effect.result(load(s, b.channel))], { concurrency: 2 })
      expect(both.map((one) => one._tag).sort()).toEqual(["Failure", "Success"])
      expect(s.loader.loaded()).toBe(1)
      expect(launches(file).length).toBe(2)
      expect([a.channel.loaded, b.channel.loaded].filter((one) => one !== undefined).length).toBe(1)
      yield* unload(s, a.channel)
      yield* unload(s, b.channel)
    })
  )
})

test("the 201st load is refused", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const channels: Array<Channel<LoadedChat>> = []
      for (let k = 0; k < 201; k++) channels.push((yield* chatOf(s)).channel)
      for (const channel of channels.slice(0, 200)) yield* load(s, channel)
      expect(s.loader.loaded()).toBe(200)
      expect(yield* Effect.flip(load(s, channels[200] as Channel<LoadedChat>))).toBeInstanceOf(LoadedFull)
    })
  )
}, 20_000)

for (const step of ["store", "stack", "read"] as const) {
  test(`a load that is stopped while ${step === "store" ? "Chats.store runs" : step === "stack" ? "the stack is built" : "the listener reads"} leaves no loaded chat, an ended launch row, no hold and its place back, and the next load works`, async () => {
    await run((file) =>
      Effect.gen(function*() {
        const w = world()
        const s = yield* setup(w)
        const { channel } = yield* chatOf(s)
        const reached = yield* Deferred.make<void>()
        const hold = Effect.andThen(Deferred.succeed(reached, undefined), Effect.never)
        if (step === "store") w.gate.store = hold
        if (step === "stack") w.gate.stack = hold
        if (step === "read") w.gate.beforeRead = () => hold
        const loading = yield* Effect.forkChild(load(s, channel))
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(loading)
        expect({ loaded: channel.loaded, places: s.loader.loaded(), holders: channel.holders }).toEqual({ loaded: undefined, places: 0, holders: 1 })
        expect(launches(file).map((row) => [row.ended !== null, row.why])).toEqual([[true, "signal"]])
        w.gate = {}
        const chat = yield* load(s, channel)
        expect(channel.loaded).toBe(chat)
        yield* unload(s, channel)
        expect(launches(file).map((row) => row.why)).toEqual(["signal", "exit"])
      })
    )
  })
}

test("a load whose stack fails gives StackFailed and leaves nothing held", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { channel } = yield* chatOf(s)
      w.gate.stack = Effect.die("no") as Effect.Effect<void>
      const exit = yield* Effect.exit(load(s, channel))
      expect(Exit.isFailure(exit)).toBe(true)
      expect({ loaded: channel.loaded, places: s.loader.loaded(), holders: channel.holders }).toEqual({ loaded: undefined, places: 0, holders: 1 })
      expect(launches(file).map((row) => row.ended !== null)).toEqual([true])
    })
  )
})

// An event that cannot be given
// -----------------------------

test("an event over entry that cannot be cut, in the listener's read, ends the clients that would get it with internal; the log line has its number and size, no text; a client above it goes on", async () => {
  await run(() =>
    Effect.gen(function*() {
      const limits: Limits = { ...LIMITS, entry: 2_000 }
      const w = world()
      // The events are written by another loader, on a channel of its own.
      const writer = yield* setup(w, limits)
      const s = yield* setup(w, limits)
      const uuid = yield* s.real.make(TENANT_A, PICK)
      const channel = yield* s.registry.held(TENANT_A, uuid)
      const below = yield* joined(channel, 0)
      const above = yield* joined(channel, 1)
      const other = yield* writer.registry.held(TENANT_A, uuid)
      yield* load(writer, other)
      yield* sayAll(w, "a private text ".repeat(200))
      yield* unload(writer, other)
      const [accepted] = yield* Effect.orDie(Effect.flatMap(Effect.orDie(s.real.reads(TENANT_A, uuid)), (reads) => reads.eventsAfter(0, 1)))
      const bytes = (fit(accepted as Event, 1e9) as { bytes: number }).bytes
      expect(bytes).toBeGreaterThan(limits.entry)
      const lines: Array<string> = []
      yield* logged(load(s, channel), lines)
      expect(below.ended).toEqual({ reason: "internal" })
      expect(above.ended).toBeNull()
      expect(numbers(yield* drain(above))).toEqual([2, 3, 4])
      expect(lines).toEqual([`Warn: event 1 (accepted) is ${bytes} bytes, over the limit entry of 2000: it is not given`])
      expect(lines.join("\n")).not.toContain("private")
      yield* unload(s, channel)
    })
  )
})

test("an event over entry that comes live ends the joined clients below it with internal, and the next one is given", async () => {
  await run(() =>
    Effect.gen(function*() {
      const limits: Limits = { ...LIMITS, entry: 2_000 }
      const w = world()
      const s = yield* setup(w, limits)
      const { channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      const lines: Array<string> = []
      yield* logged(load(s, channel), lines)
      yield* sayAll(w, "a private text ".repeat(200))
      yield* until(() => client.ended !== null)
      expect(client.ended).toEqual({ reason: "internal" })
      expect(channel.last).toBeGreaterThanOrEqual(1)
      expect(lines.length).toBe(1)
      expect(lines[0]).toContain("event 1 (accepted)")
      expect(lines.join("\n")).not.toContain("private")
      const late = yield* channel.addClient(1)
      yield* until(() => channel.last === 4)
      expect(yield* channel.join(late)).toBe(false)
      yield* unload(s, channel)
    })
  )
})

// The tenant boundary
// -------------------

test("the tenant boundary: a channel of tenant A with the UUID of tenant B's chat gives NoChat to load, and unload does nothing; B's rows are the same", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      yield* s.real.make(TENANT_A, PICK)
      const b = yield* chatOf(s, TENANT_B)
      yield* load(s, b.channel)
      yield* sayAll(w, "a message of B")
      yield* unload(s, b.channel)
      const state = () =>
        Effect.gen(function*() {
          const reads = yield* Effect.orDie(s.real.reads(TENANT_B, b.uuid))
          return {
            messages: yield* Effect.orDie(reads.messages(0, 100)),
            events: yield* Effect.orDie(reads.eventsAfter(0, 1000)),
            launches: yield* Effect.orDie(reads.launches(100)),
            rows: launches(file)
          }
        })
      const before = yield* state()
      expect(before.events.length).toBe(4)
      const crossed = yield* s.registry.held(TENANT_A, b.uuid)
      expect(crossed).not.toBe(b.channel)
      const client = yield* joined(crossed, 0)
      w.reads.length = 0
      // Each call of the loader that takes a channel.
      expect(yield* Effect.flip(load(s, crossed))).toBeInstanceOf(NoChat)
      yield* unload(s, crossed)
      expect(yield* state()).toEqual(before)
      expect(w.reads).toEqual([])
      expect({ loaded: crossed.loaded, places: s.loader.loaded(), holders: crossed.holders, buffered: client.size.entries }).toEqual({ loaded: undefined, places: 0, holders: 1, buffered: 0 })
    })
  )
})

// The loader's end
// ----------------

test("the loader's end unloads each loaded chat, each under its channel's lock", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const inner = yield* Scope.make()
      const s = yield* Scope.provide(inner)(setup(w))
      const a = yield* chatOf(s)
      const b = yield* chatOf(s)
      const client = yield* joined(a.channel, 0)
      yield* load(s, a.channel)
      yield* sayAll(w, "hello")
      yield* load(s, b.channel)
      // The lock of a's channel is held: the end waits for it.
      yield* Semaphore.take(a.channel.lock, 1)
      const ending = yield* Effect.forkChild(Scope.close(inner, Exit.void))
      yield* settle
      expect(a.channel.loaded).toBeDefined()
      yield* Semaphore.release(a.channel.lock, 1)
      yield* Fiber.join(ending)
      expect([a.channel.loaded, b.channel.loaded]).toEqual([undefined, undefined])
      expect([a.channel.holders, b.channel.holders, s.loader.loaded()]).toEqual([1, 1, 0])
      expect(launches(file).map((row) => row.why)).toEqual(["exit", "exit"])
      expect(numbers(yield* drain(client))).toEqual(range(1, 4))
    })
  )
})

// The end and the loads under way (lead, ec-mhmpr, A)
// ----------------------------------------------------

// The defect of a load that the end stopped.
const endedDefect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error).message) : "success"

for (const step of ["store", "stack", "read"] as const) {
  test(`the end asks a load that waits in ${step === "store" ? "Chats.store" : step === "stack" ? "the stack's build" : "its first read"} to stop: the load fails with the defect, and at the end's return no place, the caller's one holder, no loaded chat and no live launch row`, async () => {
    await run((file) =>
      Effect.gen(function*() {
        const w = world()
        const s = yield* setup(w)
        const { channel } = yield* chatOf(s)
        const reached = yield* Deferred.make<void>()
        const gate = Effect.andThen(Deferred.succeed(reached, undefined), Effect.never)
        if (step === "store") w.gate.store = gate
        if (step === "stack") w.gate.stack = gate
        if (step === "read") w.gate.beforeRead = () => gate
        const loading = yield* Effect.forkChild(load(s, channel))
        yield* Deferred.await(reached)
        expect({ places: s.loader.loaded(), holders: channel.holders }).toEqual({ places: 1, holders: 2 })
        yield* s.loader.end
        const atReturn = {
          places: s.loader.loaded(),
          holders: channel.holders,
          loaded: channel.loaded,
          live: launches(file).filter((row) => row.ended === null).length,
          rows: launches(file).length
        }
        expect(atReturn).toEqual({ places: 0, holders: 1, loaded: undefined, live: 0, rows: 1 })
        expect(endedDefect(yield* Fiber.await(loading))).toBe("the loader has ended")
        // A load after the end is refused.
        expect(endedDefect(yield* Effect.exit(load(s, channel)))).toBe("the loader has ended")
      }), true)
  })
}

test("the end waits for a step of a load that an interruption cannot stop: the launch row stays live and the place and the hold are the load's until the step ends; then the load closes what it made", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { channel } = yield* chatOf(s)
      const reached = yield* Deferred.make<void>()
      const open = yield* Deferred.make<void>()
      w.gate.stack = Effect.uninterruptible(Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(open)))
      const loading = yield* Effect.forkChild(load(s, channel))
      yield* Deferred.await(reached)
      const ending = yield* Effect.forkChild(s.loader.end)
      yield* settle
      expect({
        ended: ending.pollUnsafe() !== undefined,
        live: launches(file).map((row) => row.ended),
        places: s.loader.loaded(),
        holders: channel.holders
      }).toEqual({ ended: false, live: [null], places: 1, holders: 2 })
      yield* Deferred.succeed(open, undefined)
      yield* Fiber.join(ending)
      expect({ places: s.loader.loaded(), holders: channel.holders, loaded: channel.loaded, ended: launches(file).every((row) => row.ended !== null) })
        .toEqual({ places: 0, holders: 1, loaded: undefined, ended: true })
      expect(endedDefect(yield* Fiber.await(loading))).toBe("the loader has ended")
    }), true)
})

test("the end with one loaded chat and one load under way on another channel: the load stops, the chat unloads, and the end returns with no place and each caller's one holder", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const a = yield* chatOf(s)
      const b = yield* chatOf(s)
      const client = yield* joined(a.channel, 0)
      yield* load(s, a.channel)
      yield* sayAll(w, "hello")
      const reached = yield* Deferred.make<void>()
      // One read only: the end's unload of a reads too.
      w.gate.beforeRead = () => {
        w.gate.beforeRead = undefined
        return Effect.andThen(Deferred.succeed(reached, undefined), Effect.never)
      }
      const loading = yield* Effect.forkChild(load(s, b.channel))
      yield* Deferred.await(reached)
      yield* s.loader.end
      expect({
        places: s.loader.loaded(),
        holders: [a.channel.holders, b.channel.holders],
        loaded: [a.channel.loaded, b.channel.loaded],
        launches: launches(file).map((row) => row.ended !== null)
      }).toEqual({ places: 0, holders: [1, 1], loaded: [undefined, undefined], launches: [true, true] })
      expect(endedDefect(yield* Fiber.await(loading))).toBe("the loader has ended")
      expect(numbers(yield* drain(client))).toEqual(range(1, 4))
    }), true)
})

test("two calls of the end at one time: each returns only when the end is whole", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const a = yield* chatOf(s)
      const b = yield* chatOf(s)
      yield* load(s, a.channel)
      const reached = yield* Deferred.make<void>()
      const open = yield* Deferred.make<void>()
      w.gate.stack = Effect.uninterruptible(Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(open)))
      const loading = yield* Effect.forkChild(load(s, b.channel))
      yield* Deferred.await(reached)
      const one = yield* Effect.forkChild(s.loader.end)
      const two = yield* Effect.forkChild(s.loader.end)
      yield* settle
      expect([one.pollUnsafe() !== undefined, two.pollUnsafe() !== undefined]).toEqual([false, false])
      yield* Deferred.succeed(open, undefined)
      yield* Fiber.join(two)
      const atTwo = { places: s.loader.loaded(), loaded: a.channel.loaded, holders: [a.channel.holders, b.channel.holders] }
      yield* Fiber.join(one)
      expect(atTwo).toEqual({ places: 0, loaded: undefined, holders: [1, 1] })
      expect(launches(file).every((row) => row.ended !== null)).toBe(true)
      expect(endedDefect(yield* Fiber.await(loading))).toBe("the loader has ended")
    }), true)
})

// The publication (lead, ec-mhmpr, B)
// -----------------------------------

// After a load that published while its caller was interrupted or ended:
// one loaded chat, whole. A second load gives it again, a turn reaches a
// joined client live, and the timer unloads it `unload` ms after the work.
const whole = (file: string, w: World, s: Setup, uuid: string, channel: Channel<LoadedChat>, client: Client) =>
  Effect.gen(function*() {
    const chat = channel.loaded
    expect(chat).toBeDefined()
    expect({ live: launches(file).map((row) => row.ended), places: s.loader.loaded(), holders: channel.holders }).toEqual({ live: [null], places: 1, holders: 2 })
    expect(yield* load(s, channel)).toBe(chat as LoadedChat)
    expect(launches(file).length).toBe(1)
    yield* sayAll(w, "hello")
    const seq = yield* seqOf(s, TENANT_A, uuid)
    yield* until(() => client.given === seq)
    expect(numbers(yield* drain(client))).toEqual(range(1, seq))
    yield* TestClock.adjust(LIMITS.unload)
    yield* until(() => channel.loaded === undefined)
    expect({ places: s.loader.loaded(), holders: channel.holders, ended: launches(file).map((row) => row.why) }).toEqual({ places: 0, holders: 1, ended: ["exit"] })
  })

test("a load whose caller is interrupted in its publication stays a loaded chat, whole: the caller has the interruption, and the timer unloads it", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      // The interruption is pending when the load leaves its last step.
      let published: LoadedChat | undefined
      let target: Fiber.Fiber<unknown, unknown> | undefined
      let injected = false
      Object.defineProperty(channel, "loaded", {
        configurable: true,
        get: () => published,
        set: (chat: LoadedChat | undefined) => {
          published = chat
          if (chat !== undefined && target !== undefined && !injected) {
            injected = true
            target.interruptUnsafe()
          }
        }
      })
      const loading = yield* Effect.forkChild(Effect.withFiber((fiber) => {
        target = fiber
        return load(s, channel)
      }))
      const exit = yield* Fiber.await(loading)
      expect(injected).toBe(true)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      yield* whole(file, w, s, uuid, channel, client)
    }), true)
})

test("a load whose fiber ends after it stays a loaded chat, whole: its listener and its timer are not the fiber's", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      const client = yield* joined(channel, 0)
      const loading = yield* Effect.forkChild(load(s, channel))
      yield* Fiber.join(loading)
      yield* settle
      yield* whole(file, w, s, uuid, channel, client)
    }), true)
})

// `last` under the store's `seq` (lead, ec-mhmpr, C)
// -------------------------------------------------

test("a joined client with given 1e9 alone at a load does not raise last: a client at the store's seq joins and gets a turn live, each once, in order; the first gets none and stays joined; after an unload and a load, the same", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { uuid, channel } = yield* chatOf(s)
      yield* load(s, channel)
      yield* sayAll(w, "before")
      yield* unload(s, channel)
      const seq = yield* seqOf(s, TENANT_A, uuid)
      expect(seq).toBe(4)
      const above = yield* joined(channel, 1_000_000_000)
      yield* load(s, channel)
      expect(channel.last).toBe(seq)
      const honest = yield* channel.addClient(seq)
      expect(yield* channel.join(honest)).toBe(true)
      for (const round of [1, 2]) {
        const from = yield* seqOf(s, TENANT_A, uuid)
        yield* sayAll(w, "round " + round)
        const to = yield* seqOf(s, TENANT_A, uuid)
        yield* until(() => honest.given === to)
        expect(numbers(yield* drain(honest))).toEqual(range(from + 1, to))
        // A piece has no number: it reaches each client that joined.
        expect({ given: above.given, joined: above.joined, ended: above.ended, numbered: numbers(yield* drain(above)) }).toEqual({ given: 1_000_000_000, joined: true, ended: null, numbered: [] })
        yield* unload(s, channel)
        yield* load(s, channel)
        expect(channel.last).toBe(to)
      }
      yield* unload(s, channel)
    }), true)
})

test("a load that passed its last check when the end began publishes, and the end unloads it with the others", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const s = yield* setup(w)
      const { channel } = yield* chatOf(s)
      // The end begins inside the publication, after the last check.
      let published: LoadedChat | undefined
      let ending: Fiber.Fiber<void> | undefined
      Object.defineProperty(channel, "loaded", {
        configurable: true,
        get: () => published,
        set: (chat: LoadedChat | undefined) => {
          published = chat
          if (chat !== undefined && ending === undefined) ending = Effect.runFork(s.loader.end)
        }
      })
      const chat = yield* load(s, channel)
      expect(chat).toBeDefined()
      expect(ending).toBeDefined()
      yield* Fiber.join(ending as Fiber.Fiber<void>)
      expect({ loaded: channel.loaded, places: s.loader.loaded(), holders: channel.holders, launches: launches(file).map((row) => row.why) })
        .toEqual({ loaded: undefined, places: 0, holders: 1, launches: ["exit"] })
    }), true)
})
