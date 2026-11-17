// Tests of the host (host.ts; docs/host.md, section 1, `HostOptions`;
// section 2, "The deadline of the work under the lock"; section 3,
// "Admission", 4, 5 and 8; section 5): the checks of the layer's start, a
// message in (its load, its numbers, a key, its refusals, the tenant
// boundary, the wait for the lock, the deadline of the work, a caller that
// goes away, a failed write), the errors of the loader, the rate, and the
// layer's end. Each case runs on the SQLite store of a test file and Effect's
// TestClock, with a stack of the core's hosted set over the tests' fake wire.

import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Redacted, Scheduler, Scope, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import { HOSTED, hostedLayer } from "@everchat/core/functions"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Reply, Request } from "@everchat/core/request"
import { Sandbox } from "@everchat/core/sandbox"
import { Chats, LaunchLive, NoChat, SENDER_KEY, Store, StoreError } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { compactor, fakeWire, newFile, PICK, reply, rows } from "@everchat/local/testing"
import { chatsLayer, ProcessAlive } from "@everchat/sqlite/bun"
import { type Channel, type Client, ClientRefused } from "./channel.ts"
import { ChatBusy, Host, type HostOptions, MessageRefused, SecretTooShort, TooMany } from "./host.ts"
import { DEFAULTS, type Limits, LimitsRefused } from "./limits.ts"
import { type LoadedChat, LoadedFull } from "./loaded.ts"

const LAUNCH = { pid: process.pid, host: "test-host", cwd: "/work", version: "0.0.0-test" }
const SECRET = Redacted.make(new Uint8Array(32).fill(7))
const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

type Run = (program: string) => Effect.Effect<{ output: string; failed: boolean }>

const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, {
    text: "",
    output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }],
    calls: [{ id, name: "run", input: program }]
  })
const says = (asked: Request, text: string): Reply =>
  reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

// What a case changes: the wire's answers, the sandbox, the gates of the
// store's `append` (one time each): a wait before it, or a fault, and a
// wait before the load's `Chats.store` (one time).
interface World {
  answer: (asked: Request, n: number) => Reply
  run: Run
  stall: Effect.Effect<void> | undefined
  fail: boolean
  appends: number
  open: Effect.Effect<void> | undefined
  opens: number
}

const world = (over: Partial<World> = {}): World => ({
  answer: (asked) => says(asked, "A reply."),
  run: () => Effect.succeed({ output: "2", failed: false }),
  stall: undefined,
  fail: false,
  appends: 0,
  open: undefined,
  opens: 0,
  ...over
})

const stackOf = (w: World) => {
  const wire = fakeWire((asked, n) => w.answer(asked, n))
  return (store: typeof Store.Service) => {
    const base = Layer.succeed(Store, store)
    const memory = Memory.layer.pipe(Layer.provideMerge(base), Layer.provide(compactor(() => "a summary")))
    const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
    const sandbox = Layer.succeed(Sandbox, Sandbox.of({ run: (program) => w.run(program) }))
    const functions = hostedLayer.pipe(Layer.provide(memory))
    return Turns.layer({ declarations: HOSTED }).pipe(
      Layer.provideMerge(memory),
      Layer.provide(Layer.mergeAll(asking, sandbox, noFileLayer(), functions))
    )
  }
}

// `Chats` over the real one, with the gates of `w` on the store's `append`
// and before `store`.
const wrap = (real: typeof Chats.Service, w: World) =>
  Chats.of({
    make: real.make,
    reads: real.reads,
    store: (tenant, chat, launch) =>
      Effect.map(Effect.andThen(Effect.suspend(() => {
        w.opens += 1
        const open = w.open
        w.open = undefined
        return open ?? Effect.void
      }), real.store(tenant, chat, launch)), (store) => ({
        ...store,
        append: (messages, key) =>
          Effect.gen(function*() {
            w.appends += 1
            const stall = w.stall
            w.stall = undefined
            if (stall !== undefined) yield* stall
            if (w.fail) {
              w.fail = false
              return yield* new StoreError({ op: "append", cause: new Error("the test's fault") })
            }
            return yield* store.append(messages, key)
          })
      }))
  })

interface Built {
  readonly host: typeof Host.Service
  readonly real: typeof Chats.Service
  readonly close: Effect.Effect<void>
}

// The host's layer over `w`, in a scope of its own.
const build = (w: World, over: Partial<HostOptions> = {}) =>
  Effect.gen(function*() {
    const real = yield* Chats
    const scope = yield* Scope.make()
    const layer = Host.layer({ stack: stackOf(w), launch: LAUNCH, secret: SECRET, origins: [], ...over }).pipe(
      Layer.provide(Layer.succeed(Chats, wrap(real, w)))
    )
    const context = yield* Layer.buildWithScope(layer, scope)
    return { host: Context.get(context, Host), real, close: Scope.close(scope, Exit.void) } satisfies Built
  })

// Runs a case over a new file, on Effect's TestClock.
const run = <A, E>(body: (file: string) => Effect.Effect<A, E, Chats | Scope.Scope>) => {
  const file = newFile()
  return Effect.runPromise(body(file).pipe(Effect.scoped, Effect.provide(chatsLayer(file)), Effect.provide(TestClock.layer())))
}

// Waits, in real time, until `check` holds (2 s at most).
const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let k = 0; k < 2_000 && !check(); k++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
    }
    if (!check()) return yield* Effect.die(new Error("the case waited for a state that did not come"))
  })
// Lets the fibers run, in real time, with the clock still.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

// The free permits of a channel's lock (the semaphore's own count, which
// its type does not show).
const free = (channel: Channel<LoadedChat>) => (channel.lock as unknown as { readonly free: number }).free

interface LaunchRow {
  readonly pid: number
  readonly ended: number | null
  readonly why: string | null
}
const launches = (file: string) => rows<LaunchRow>(file, "select pid, ended, why from everchat_launch order by chat, n")
const events = (file: string) => rows<{ n: number; type: string }>(file, "select n, type from everchat_event order by chat, n")

const logged = <A, E, R>(effect: Effect.Effect<A, E, R>, lines: Array<string>) => {
  const logger = Logger.make((line) => {
    const message = line.message
    lines.push(`${line.logLevel}: ${Array.isArray(message) ? message.join(" ") : String(message)}`)
  })
  return Effect.provide(effect, Logger.layer([logger]))
}

// The channel of a chat that the host's registry has now.
const channelOf = (b: Built, tenant: string, uuid: string) => {
  const channel = b.host.registry.find(tenant, uuid)
  if (channel === undefined) throw new Error("the host has no channel of this chat")
  return channel
}
const loadedOf = (b: Built, tenant: string, uuid: string) => {
  const chat = channelOf(b, tenant, uuid).loaded
  if (chat === undefined) throw new Error("the chat is not loaded")
  return chat
}

// Counts each hold that the host's registry gives from now on: `say` takes
// its hold with `registry.held` of the object that `Host` gives, so a hold
// is counted when it is taken.
const countHolds = (b: Built) => {
  const registry = b.host.registry as { held: typeof b.host.registry.held }
  const held = registry.held
  const counter = { holds: 0 }
  registry.held = (tenant, uuid) =>
    Effect.tap(held(tenant, uuid), () =>
      Effect.sync(() => {
        counter.holds += 1
      }))
  return counter
}

// The layer's start
// -----------------

test("a secret of 31 bytes fails the layer, and the error's text has no byte of it and not its length", async () => {
  await run(() =>
    Effect.gen(function*() {
      const bytes = new TextEncoder().encode("Zq9".repeat(10) + "W")
      expect(bytes.length).toBe(31)
      const error = yield* Effect.flip(build(world(), { secret: Redacted.make(bytes) }))
      expect(error).toBeInstanceOf(SecretTooShort)
      const texts = [String(error), error.message, JSON.stringify(error), Bun.inspect(error)].join("\n")
      expect(texts).not.toContain("Zq9")
      expect(texts).not.toContain("W")
      expect(texts).not.toContain("31")
      // 32 bytes start.
      const b = yield* build(world(), { secret: Redacted.make(new Uint8Array(32)) })
      yield* b.close
    })
  )
})

test("limits that break a relation fail the layer", async () => {
  await run(() =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(build(world(), { limits: { body: 100, text: 100 } }))
      expect(error).toBeInstanceOf(LimitsRefused)
      expect((error as LimitsRefused).limits).toEqual(["body", "text"])
    })
  )
})

test("limits with key 129 fail the layer with LimitsRefused that names key: no channel, launch row or log line of a message exists after it", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const uuid = yield* (yield* Chats).make(TENANT_A, PICK)
      const error = yield* Effect.flip(logged(build(world(), { limits: { key: 129 } }), lines))
      expect(error).toBeInstanceOf(LimitsRefused)
      expect({ limits: (error as LimitsRefused).limits, rule: (error as LimitsRefused).rule }).toEqual({
        limits: ["key"],
        rule: "a whole number from 1 to 128"
      })
      expect(launches(file)).toEqual([])
      expect(events(file)).toEqual([])
      expect(lines).toEqual([])
      // 128 starts, and its chat has no channel until a message comes.
      const b = yield* build(world(), { limits: { key: 128 } })
      expect(b.host.limits.key).toBe(128)
      expect(b.host.registry.find(TENANT_A, uuid)).toBeUndefined()
      yield* b.close
    })
  )
})

// A message in
// ------------

test("a first message loads the chat and gives its accepted number and its pages; its turn runs after the answer; a second finds the loaded chat", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const w = world({
        answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
        run: () => Effect.as(Deferred.await(release), { output: "2", failed: false })
      })
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const sent = yield* b.host.say(TENANT_A, uuid, "hello", null)
      expect({ accepted: sent.accepted, repeat: sent.repeat, pages: sent.messages.map((m) => [m.i, m.kind, m.text]) }).toEqual({
        accepted: 1,
        repeat: false,
        pages: [[0, "user", "hello"]]
      })
      const chat = loadedOf(b, TENANT_A, uuid)
      // The answer came before the turn's end.
      yield* until(() => events(file).some((row) => row.type === "call"))
      expect(events(file).map((row) => row.type)).not.toContain("end")
      expect(yield* chat.turns.busy).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* chat.turns.idle
      expect(events(file).map((row) => row.type)).toContain("end")
      // The second finds the loaded chat: one launch row, the say's hold let go.
      const second = yield* b.host.say(TENANT_A, uuid, "and again", null)
      expect(second.repeat).toBe(false)
      expect(loadedOf(b, TENANT_A, uuid)).toBe(chat)
      expect(launches(file).length).toBe(1)
      expect(channelOf(b, TENANT_A, uuid).holders).toBe(1)
      yield* chat.turns.idle
      yield* b.close
    })
  )
})

test("a message with a key that the chat has gives the first numbers with repeat true and writes nothing", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const first = yield* b.host.say(TENANT_A, uuid, "hello", "key-1")
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      const before = { events: events(file), appends: w.appends }
      const again = yield* b.host.say(TENANT_A, uuid, "another text", "key-1")
      expect(again).toEqual({ messages: first.messages, accepted: first.accepted, repeat: true })
      expect({ events: events(file), appends: w.appends }).toEqual(before)
      yield* b.close
    })
  )
})

test("a message while a turn runs is logged at once", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const w = world({
        answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { output: "2", failed: false }))
      })
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "do the slow thing", null)
      yield* Deferred.await(started)
      const steer = yield* b.host.say(TENANT_A, uuid, "and this too", null)
      const chat = loadedOf(b, TENANT_A, uuid)
      expect(yield* chat.turns.busy).toBe(true)
      expect(events(file).find((row) => row.n === steer.accepted)?.type).toBe("accepted")
      yield* Deferred.succeed(release, undefined)
      yield* chat.turns.idle
      yield* b.close
    })
  )
})

test("the refusals of a text and a key come before any hold or write: 0 bytes, text + 1 bytes, a key of 129 bytes, with a space, with a byte above 0x7E", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const counter = countHolds(b)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const text = b.host.limits.text
      const cases: Array<[string, string | null, "text" | "key"]> = [
        ["", null, "text"],
        ["a".repeat(text + 1), null, "text"],
        // A lone surrogate is 3 bytes once well formed: 65,535 + 3 bytes.
        ["a".repeat(text - 2) + "\ud800", null, "text"],
        ["hello", "", "key"],
        ["hello", "k".repeat(129), "key"],
        ["hello", "a key", "key"],
        ["hello", "key\u007f", "key"],
        ["hello", "clé", "key"]
      ]
      for (const [given, key, field] of cases) {
        const error = yield* Effect.flip(b.host.say(TENANT_A, uuid, given, key))
        expect(error).toEqual(new MessageRefused({ field }))
      }
      expect(b.host.registry.size().channels).toBe(0)
      expect(launches(file)).toEqual([])
      // No refusal took a hold, not even one that it let go before its end.
      expect(counter.holds).toBe(0)
      // At the bounds: `text` bytes, a lone surrogate alone, a key of 128 bytes.
      yield* b.host.say(TENANT_A, uuid, "a".repeat(text), null)
      expect(counter.holds).toBe(1)
      const lone = yield* b.host.say(TENANT_A, uuid, "\ud800", "k".repeat(128))
      expect(lone.messages.map((m) => m.text)).toEqual(["�"])
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      yield* b.close
    })
  )
})

test("with key 16, a key of 17 bytes is MessageRefused (key) with no hold, on a cold chat and on a chat whose turn runs: the turn goes on and its launch row stays live", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      let stopped = false
      const w = world({
        answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
        run: () =>
          Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { output: "2", failed: false })).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                stopped = true
              })
            )
          )
      })
      const b = yield* build(w, { limits: { key: 16 } })
      const counter = countHolds(b)
      const cold = yield* b.real.make(TENANT_A, PICK)
      const busy = yield* b.real.make(TENANT_A, PICK)
      // A cold chat: refused before any hold; no channel and no launch row.
      expect(yield* Effect.flip(b.host.say(TENANT_A, cold, "hello", "k".repeat(17)))).toEqual(new MessageRefused({ field: "key" }))
      expect(counter.holds).toBe(0)
      expect(b.host.registry.find(TENANT_A, cold)).toBeUndefined()
      expect(launches(file)).toEqual([])
      // A chat whose turn runs.
      yield* b.host.say(TENANT_A, busy, "do the slow thing", null)
      yield* Deferred.await(started)
      const chat = loadedOf(b, TENANT_A, busy)
      const held = counter.holds
      expect(yield* Effect.flip(b.host.say(TENANT_A, busy, "and this", "k".repeat(17)))).toEqual(new MessageRefused({ field: "key" }))
      expect(counter.holds).toBe(held)
      expect(stopped).toBe(false)
      expect(yield* chat.turns.busy).toBe(true)
      expect(loadedOf(b, TENANT_A, busy)).toBe(chat)
      expect(launches(file)).toEqual([{ pid: process.pid, ended: null, why: null }])
      // A key of 16 bytes passes, on the same chat while its turn runs.
      const sent = yield* b.host.say(TENANT_A, busy, "and this", "k".repeat(16))
      expect(sent.repeat).toBe(false)
      expect(counter.holds).toBe(held + 1)
      yield* Deferred.succeed(release, undefined)
      yield* chat.turns.idle
      expect(stopped).toBe(false)
      expect(events(file).map((row) => row.type)).toContain("end")
      yield* b.close
    })
  )
})

test("the limit key's largest number is the core's bound of a sender's key: a key of 128 bytes is logged by say, and the core refuses one of 129", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const most = "k".repeat(b.host.limits.key)
      expect(b.host.limits.key).toBe(128)
      // The host's largest key: the core logs it.
      const sent = yield* b.host.say(TENANT_A, uuid, "hello", most)
      expect(events(file).find((row) => row.n === sent.accepted)?.type).toBe("accepted")
      const chat = loadedOf(b, TENANT_A, uuid)
      yield* chat.turns.idle
      // One byte more: the core's own check refuses it, and so does its say,
      // with StoreError, on the chat that the host loaded.
      expect(SENDER_KEY.test(most)).toBe(true)
      expect(SENDER_KEY.test(most + "k")).toBe(false)
      const refused = yield* Effect.flip(chat.turns.say("hello", most + "k"))
      expect(refused).toBeInstanceOf(StoreError)
      yield* b.close
    })
  )
})

test("a message of tenant A for a chat of tenant B gives NoChat, and B's rows are the same before and after", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      yield* b.real.make(TENANT_A, PICK)
      const uuid = yield* b.real.make(TENANT_B, PICK)
      yield* b.host.say(TENANT_B, uuid, "a message of B", null)
      yield* loadedOf(b, TENANT_B, uuid).turns.idle
      const state = () =>
        Effect.gen(function*() {
          const reads = yield* Effect.orDie(b.real.reads(TENANT_B, uuid))
          return {
            messages: yield* Effect.orDie(reads.messages(0, 100)),
            events: yield* Effect.orDie(reads.eventsAfter(0, 1000)),
            launches: yield* Effect.orDie(reads.launches(100)),
            rows: launches(file)
          }
        })
      const before = yield* state()
      expect(yield* Effect.flip(b.host.say(TENANT_A, uuid, "a message of A", null))).toBeInstanceOf(NoChat)
      expect(yield* state()).toEqual(before)
      expect(b.host.registry.find(TENANT_A, uuid)).toBeUndefined()
      yield* b.close
    })
  )
})

test("two messages at one time for a chat that is not loaded load it once", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const both = yield* Effect.all([b.host.say(TENANT_A, uuid, "one", null), b.host.say(TENANT_A, uuid, "two", null)], { concurrency: 2 })
      expect(both.map((sent) => sent.repeat)).toEqual([false, false])
      expect(launches(file).length).toBe(1)
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      yield* b.close
    })
  )
})

// The lock and the deadline
// -------------------------

test("a message that waits lockWait for the lock gets busy and logs nothing", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const channel = yield* b.host.registry.held(TENANT_A, uuid)
      yield* Semaphore.take(channel.lock, 1)
      const waiting = yield* Effect.forkChild(Effect.flip(b.host.say(TENANT_A, uuid, "hello", null)))
      yield* settle
      yield* TestClock.adjust(b.host.limits.lockWait - 1)
      yield* settle
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(waiting)).toEqual(new ChatBusy({ at: "lock" }))
      expect({ events: events(file), launches: launches(file), holders: channel.holders, free: free(channel) }).toEqual({ events: [], launches: [], holders: 1, free: 0 })
      yield* Semaphore.release(channel.lock, 1)
      yield* b.close
    })
  )
})

test("work that passes lock is asked to stop; the lock and the hold are free only when it has ended, the lock first", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const channel = yield* b.host.registry.held(TENANT_A, uuid)
      // Each let go of a holder notes whether the lock was free then.
      const atLetGo: Array<number> = []
      const removeHolder = channel.removeHolder.bind(channel)
      channel.removeHolder = () => {
        atLetGo.push(free(channel))
        return removeHolder()
      }
      yield* b.host.say(TENANT_A, uuid, "load it", null)
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      expect(atLetGo).toEqual([1])
      const appends = w.appends
      w.stall = Effect.sleep("25 seconds")
      const saying = yield* Effect.forkChild(b.host.say(TENANT_A, uuid, "stalled", null))
      yield* until(() => w.appends > appends)
      yield* TestClock.adjust(b.host.limits.lock)
      yield* settle
      // The deadline asked; the append cannot be cut: all is still held.
      expect({ done: saying.pollUnsafe() !== undefined, free: free(channel), holders: channel.holders }).toEqual({ done: false, free: 0, holders: 3 })
      yield* TestClock.adjust("5 seconds")
      // The append committed: the work ended with success, and its end
      // decides (lead, ec-y11ev, 2).
      const sent = yield* Fiber.join(saying)
      expect(sent.repeat).toBe(false)
      expect(events(file).find((row) => row.n === sent.accepted)?.type).toBe("accepted")
      expect({ free: free(channel), holders: channel.holders, atLetGo }).toEqual({ free: 1, holders: 2, atLetGo: [1, 1] })
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      yield* b.close
    })
  )
})

test("a caller that is interrupted while its append stalls: the lock stays held until the append ends, and the next message then takes it", async () => {
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "load it", null)
      const channel = channelOf(b, TENANT_A, uuid)
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      const appends = w.appends
      w.stall = Effect.sleep("5 seconds")
      const first = yield* Effect.forkChild(b.host.say(TENANT_A, uuid, "stalled", null))
      yield* until(() => w.appends > appends)
      const stopping = yield* Effect.forkChild(Fiber.interrupt(first))
      const next = yield* Effect.forkChild(b.host.say(TENANT_A, uuid, "next", null))
      yield* settle
      expect({ stopped: stopping.pollUnsafe() !== undefined, next: next.pollUnsafe() !== undefined, free: free(channel) }).toEqual({ stopped: false, next: false, free: 0 })
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.join(stopping)
      expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
      const sent = yield* Fiber.join(next)
      expect(sent.repeat).toBe(false)
      expect({ free: free(channel), holders: channel.holders }).toEqual({ free: 1, holders: 1 })
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      yield* b.close
    })
  )
})

test("after a failed write the chat is unloaded under the same lock, with a log line of the store's operation and no text; the next message loads it again", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "load it", null)
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      const channel = channelOf(b, TENANT_A, uuid)
      w.fail = true
      const lines: Array<string> = []
      const error = yield* logged(Effect.flip(b.host.say(TENANT_A, uuid, "a private text", null)), lines)
      expect(error).toBeInstanceOf(StoreError)
      expect(channel.loaded).toBeUndefined()
      expect(free(channel)).toBe(1)
      expect(launches(file).map((row) => row.why)).toEqual(["exit"])
      expect(lines).toEqual(["Warn: a message in failed in the store's append"])
      const again = yield* b.host.say(TENANT_A, uuid, "again", null)
      expect(again.repeat).toBe(false)
      expect(launches(file).map((row) => row.why)).toEqual(["exit", null])
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      yield* b.close
    })
  )
})

test("a turn that started goes on after its caller was interrupted", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const w = world({
        answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { output: "2", failed: false }))
      })
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const caller = yield* Effect.forkChild(Effect.andThen(b.host.say(TENANT_A, uuid, "do the slow thing", null), Effect.never))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(caller)
      const chat = loadedOf(b, TENANT_A, uuid)
      expect(yield* chat.turns.busy).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* chat.turns.idle
      expect(rows<{ status: string }>(file, "select status from everchat_turn")).toEqual([{ status: "done" }])
      yield* b.close
    })
  )
})

test("a log that commits after lock gives Sent with its numbers, and the same key again gives them with repeat true", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "load it", null)
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      const channel = channelOf(b, TENANT_A, uuid)
      const appends = w.appends
      w.stall = Effect.sleep(b.host.limits.lock + 5_000)
      const saying = yield* Effect.forkChild(b.host.say(TENANT_A, uuid, "late", "key-late"))
      yield* until(() => w.appends > appends)
      yield* TestClock.adjust(b.host.limits.lock)
      yield* settle
      expect(saying.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(5_000)
      const sent = yield* Fiber.join(saying)
      expect({ repeat: sent.repeat, pages: sent.messages.map((m) => m.text) }).toEqual({ repeat: false, pages: ["late"] })
      expect(events(file).find((row) => row.n === sent.accepted)?.type).toBe("accepted")
      expect({ loaded: channel.loaded !== undefined, free: free(channel) }).toEqual({ loaded: true, free: 1 })
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      const before = events(file)
      const again = yield* b.host.say(TENANT_A, uuid, "late", "key-late")
      expect(again).toEqual({ messages: sent.messages, accepted: sent.accepted, repeat: true })
      expect(events(file)).toEqual(before)
      yield* b.close
    })
  )
})

test("work that the deadline cut (a load whose Chats.store waits past lock) gives ChatBusy at work and logs nothing; the next message loads the chat", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world({ open: Effect.sleep("1 hour") })
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const channel = yield* b.host.registry.held(TENANT_A, uuid)
      const saying = yield* Effect.forkChild(Effect.flip(b.host.say(TENANT_A, uuid, "cut", "key-cut")))
      yield* until(() => w.opens > 0)
      yield* settle
      yield* TestClock.adjust(b.host.limits.lock - 1)
      yield* settle
      expect(saying.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(saying)).toEqual(new ChatBusy({ at: "work" }))
      expect({ events: events(file), launches: launches(file), appends: w.appends, loaded: channel.loaded, free: free(channel) }).toEqual({
        events: [],
        launches: [],
        appends: 0,
        loaded: undefined,
        free: 1
      })
      // The same key again is a new message: nothing was logged.
      const sent = yield* b.host.say(TENANT_A, uuid, "cut", "key-cut")
      expect(sent.repeat).toBe(false)
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      yield* b.close
    })
  )
})

// The deadline cuts say's waits (lead, ec-p9osd)
// ----------------------------------------------
// `Turns.say` runs with no uninterruptible region around it: the deadline
// cuts each of its waits, and the core tells the `Sent` (`told`) in the
// step that commits the message.

const texts = (file: string) => rows<{ text: string }>(file, "select text from everchat_msg order by chat, i").map((row) => row.text)
const accepted = (file: string) => events(file).filter((row) => row.type === "accepted").length

// A cut `say` of the loaded chat `uuid` while `holder` holds a lock that its
// `Turns.say` waits for: `ChatBusy` at work at the deadline, not before;
// nothing of it in the log; the channel's lock free and its hold given back
// while the holder still holds. Then `gate` lets the holder go, and the
// same key is a new message. A failed check lets the holder go too, so the
// case's scope can close.
const cutWhileHeld = (b: Built, file: string, uuid: string, holder: Fiber.Fiber<unknown, unknown>, gate: Deferred.Deferred<void>) =>
  Effect.gen(function*() {
    const channel = channelOf(b, TENANT_A, uuid)
    const before = { texts: texts(file), accepted: accepted(file) }
    const saying = yield* Effect.forkChild(Effect.flip(b.host.say(TENANT_A, uuid, "cut", "key-cut")))
    yield* settle
    expect(free(channel)).toBe(0)
    yield* TestClock.adjust(b.host.limits.lock - 1)
    yield* settle
    expect(saying.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    yield* until(() => saying.pollUnsafe() !== undefined)
    expect(yield* Fiber.join(saying)).toEqual(new ChatBusy({ at: "work" }))
    // The holder still holds; the channel's lock and the hold are back.
    expect({ holder: holder.pollUnsafe(), free: free(channel), holders: channel.holders }).toEqual({ holder: undefined, free: 1, holders: 1 })
    expect({ texts: texts(file), accepted: accepted(file) }).toEqual(before)
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.join(holder)
    expect(texts(file)).not.toContain("cut")
    // Nothing was logged: the same key again is a new message, one time.
    const again = yield* b.host.say(TENANT_A, uuid, "cut", "key-cut")
    expect(again.repeat).toBe(false)
    expect(texts(file).filter((text) => text === "cut")).toEqual(["cut"])
    yield* loadedOf(b, TENANT_A, uuid).turns.idle
  }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))

test("a say whose wait for the memory's lock, behind a held write, passes the deadline is cut there: ChatBusy at work, nothing in the log, and the channel's lock is free before the holder ends", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "load it", null)
      const chat = loadedOf(b, TENANT_A, uuid)
      yield* chat.turns.idle
      // A write of the memory whose append waits for the gate: it holds the
      // memory's lock, and not the loop's `lock` or `order`.
      const gate = yield* Deferred.make<void>()
      const appends = w.appends
      w.stall = Deferred.await(gate)
      const holder = yield* Effect.forkChild(chat.memory.push([{ kind: "user", text: "held" }]))
      yield* until(() => w.appends > appends)
      yield* cutWhileHeld(b, file, uuid, holder, gate)
      // The held write is in the log before the message that was cut and sent again.
      expect(texts(file).filter((text) => text === "held" || text === "cut")).toEqual(["held", "cut"])
      yield* b.close
    })
  )
})

test("a say whose wait for the loop's lock (a say of the core that holds it) or for order (a turn's log that holds it) passes the deadline is cut there: ChatBusy at work, nothing in the log, and the channel's lock is free before the holder ends", async () => {
  // The loop's `lock`: a `Turns.say` of the core itself, outside the
  // channel's lock, whose append waits for the gate.
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "load it", null)
      const chat = loadedOf(b, TENANT_A, uuid)
      yield* chat.turns.idle
      const gate = yield* Deferred.make<void>()
      const appends = w.appends
      w.stall = Deferred.await(gate)
      const holder = yield* Effect.forkChild(chat.turns.say("held"))
      yield* until(() => w.appends > appends)
      yield* cutWhileHeld(b, file, uuid, holder, gate)
      yield* b.close
    })
  )
  // `order`: a turn's log of its call's output, whose append waits for the
  // gate; the turn runs outside the loop's `lock`.
  await run((file) =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const w = world({
        answer: (asked, n) => (n === 1 ? runs(asked, "call_1", "slow()") : says(asked, "Done.")),
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { output: "2", failed: false }))
      })
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "do the slow thing", null)
      const chat = loadedOf(b, TENANT_A, uuid)
      yield* Deferred.await(started)
      const gate = yield* Deferred.make<void>()
      const appends = w.appends
      w.stall = Deferred.await(gate)
      yield* Deferred.succeed(release, undefined)
      yield* until(() => w.appends > appends)
      expect(yield* chat.turns.busy).toBe(true)
      // The turn's own fiber holds `order`; it ends when the turn ends.
      const holder = yield* Effect.forkChild(chat.turns.idle)
      yield* cutWhileHeld(b, file, uuid, holder, gate)
      expect(rows<{ status: string }>(file, "select status from everchat_turn order by rowid")[0]).toEqual({ status: "done" })
      yield* b.close
    })
  )
})

test("a deadline that comes while the commit's step runs gives Sent: the message is in the log one time and its turn started", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "load it", null)
      const chat = loadedOf(b, TENANT_A, uuid)
      yield* chat.turns.idle
      const channel = channelOf(b, TENANT_A, uuid)
      const turns = rows(file, "select * from everchat_turn").length
      // The append runs in the memory's step, under its lock: the step that
      // commits the message. It waits for the gate past the deadline.
      const gate = yield* Deferred.make<void>()
      const appends = w.appends
      w.stall = Deferred.await(gate)
      const saying = yield* Effect.forkChild(b.host.say(TENANT_A, uuid, "in the step", "key-step"))
      yield* until(() => w.appends > appends)
      yield* TestClock.adjust(b.host.limits.lock)
      yield* settle
      // The deadline asked; the step runs whole: all is still held.
      expect({ done: saying.pollUnsafe(), free: free(channel) }).toEqual({ done: undefined, free: 0 })
      yield* Deferred.succeed(gate, undefined)
      const exit = yield* Fiber.await(saying)
      expect(Exit.isSuccess(exit) ? "Sent" : exit.cause).toBe("Sent")
      if (!Exit.isSuccess(exit)) return
      const sent = exit.value
      expect({ repeat: sent.repeat, pages: sent.messages.map((m) => m.text) }).toEqual({ repeat: false, pages: ["in the step"] })
      expect(events(file).find((row) => row.n === sent.accepted)?.type).toBe("accepted")
      expect(texts(file).filter((text) => text === "in the step")).toEqual(["in the step"])
      // Its turn started: a new turn row, and a `start` after `accepted`.
      expect(rows(file, "select * from everchat_turn").length).toBe(turns + 1)
      expect(events(file).some((row) => row.n > sent.accepted && row.type === "start")).toBe(true)
      expect(free(channel)).toBe(1)
      yield* chat.turns.idle
      expect(rows<{ status: string }>(file, "select status from everchat_turn order by rowid").at(-1)).toEqual({ status: "done" })
      // The same key again: a repeat, and nothing more in the log.
      const again = yield* b.host.say(TENANT_A, uuid, "in the step", "key-step")
      expect(again).toEqual({ messages: sent.messages, accepted: sent.accepted, repeat: true })
      yield* b.close
    })
  )
})

// The end and the registry's stop (lead, ec-yculc)
// ------------------------------------------------
// The layer's end stops the registry first: after it, no `addClient` of a
// channel of the host's registry adds a client; then each client ends with
// `stop`; then the loader's end.

// An `addClient` of `channel`, as its outcome: a client, or the refusal's
// reason and bound.
const tryAdd = (channel: Channel<LoadedChat>) =>
  Effect.map(Effect.result(channel.addClient(0)), (result) =>
    result._tag === "Success"
      ? { _tag: "Client" as const, client: result.success }
      : { _tag: "Refused" as const, refused: result.failure instanceof ClientRefused, reason: result.failure.reason, bound: result.failure.bound })
const refusedByHost = { _tag: "Refused", refused: true, reason: "busy", bound: "host" } as const

test("after the layer's end, and inside it (after the registry's stop, while a load under way holds the loader's end), addClient on a channel of the host's registry is refused; the clients of before end with stop, and no client is left", async () => {
  // A failed check lets the load go too, so the case's scope can close.
  const gate = Deferred.makeUnsafe<void>()
  await run(() =>
    Effect.gen(function*() {
      const w = world()
      const b = yield* build(w)
      const loaded = yield* b.real.make(TENANT_A, PICK)
      const cold = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, loaded, "load it", null)
      yield* loadedOf(b, TENANT_A, loaded).turns.idle
      const channel = channelOf(b, TENANT_A, loaded)
      const before = yield* channel.addClient(0)
      // A load of the cold chat whose `Chats.store` waits for the gate with no
      // interruption: the loader's end waits for it.
      w.open = Effect.uninterruptible(Deferred.await(gate))
      const loading = yield* Effect.forkChild(b.host.say(TENANT_A, cold, "a cold chat", null))
      yield* until(() => w.opens > 1)
      const ending = yield* Effect.forkChild(b.close)
      // Inside the end: the client of before got `stop`, and the end waits.
      yield* until(() => before.ended !== null)
      yield* settle
      expect(ending.pollUnsafe()).toBeUndefined()
      expect(before.ended).toEqual({ reason: "stop" })
      const inside = yield* tryAdd(channel)
      const coldChannel = channelOf(b, TENANT_A, cold)
      const insideCold = yield* tryAdd(coldChannel)
      // A channel that the registry makes inside the end.
      const other = yield* b.real.make(TENANT_B, PICK)
      const made = yield* b.host.registry.hold(TENANT_B, other)
      const insideMade = yield* tryAdd(made)
      const during = b.host.registry.size().clients
      yield* b.host.registry.letGo(made)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(ending)
      yield* Fiber.await(loading)
      // After the end.
      const after = yield* tryAdd(channel)
      expect({ inside, insideCold, insideMade, during, after }).toEqual({
        inside: refusedByHost,
        insideCold: refusedByHost,
        insideMade: refusedByHost,
        during: 0,
        after: refusedByHost
      })
      expect(b.host.registry.size()).toEqual({ channels: 0, clients: 0 })
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
  )
})

test("Host's registry has the real stop: host.registry.stop on a live host refuses addClient on a channel of the host's registry with busy host, and the clients that were there are as they were", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const uuid = yield* b.real.make(TENANT_A, PICK)
      const channel = yield* b.host.registry.hold(TENANT_A, uuid)
      const one = yield* channel.addClient(0)
      const two = yield* channel.addClient(0, { pieces: false })
      const state = () => ({
        size: b.host.registry.size(),
        clients: channel.clients.length,
        ended: [one.ended, two.ended],
        given: [one.given, two.given]
      })
      const before = state()
      yield* b.host.registry.stop
      const refused = yield* tryAdd(channel)
      const after = state()
      expect(before).toEqual({ size: { channels: 1, clients: 2 }, clients: 2, ended: [null, null], given: [0, 0] })
      expect(refused).toEqual(refusedByHost)
      expect(after).toEqual(before)
      yield* b.host.registry.letGo(channel)
      yield* b.close
    })
  )
})

test("an addClient that races the layer's end, at each order that a Deferred and the steps between make: the client gets stop or is refused, never a client with no end", async () => {
  const tally = { stop: 0, refused: 0 }
  await run(() =>
    Effect.gen(function*() {
      const uuid = yield* (yield* Chats).make(TENANT_A, PICK)
      for (const first of ["add", "end"] as const) {
        for (let k = 0; k <= 120; k++) {
          const b = yield* build(world())
          const channel = yield* b.host.registry.hold(TENANT_A, uuid)
          // A client of before, so that the end's loop over the clients has
          // steps of its own.
          const old = yield* channel.addClient(0)
          const goAdd = yield* Deferred.make<void>()
          const goEnd = yield* Deferred.make<void>()
          // Few steps before each yield: each step of the two fibers can
          // fall between two of the other.
          const few = Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)
          const adder = yield* Effect.forkChild(few(Effect.andThen(Deferred.await(goAdd), tryAdd(channel))))
          const ender = yield* Effect.forkChild(few(Effect.andThen(Deferred.await(goEnd), b.close)))
          yield* Deferred.succeed(first === "add" ? goAdd : goEnd, undefined)
          for (let n = 0; n < k; n++) yield* Effect.yieldNow
          yield* Deferred.succeed(first === "add" ? goEnd : goAdd, undefined)
          const added = yield* Fiber.join(adder)
          yield* Fiber.join(ender)
          expect(old.ended).toEqual({ reason: "stop" })
          if (added._tag === "Client") {
            const client: Client = added.client
            expect([first, k, client.ended]).toEqual([first, k, { reason: "stop" }])
            tally.stop += 1
          } else {
            expect([first, k, added]).toEqual([first, k, refusedByHost])
            tally.refused += 1
          }
          expect(b.host.registry.size().clients).toBe(0)
          yield* b.host.registry.letGo(channel)
        }
      }
    })
  )
  console.log("the race of addClient and the end:", JSON.stringify(tally))
  // Both outcomes happen.
  expect(tally.stop).toBeGreaterThan(0)
  expect(tally.refused).toBeGreaterThan(0)
  expect(tally.stop + tally.refused).toBe(2 * 121)
}, 20_000)

// The loader's errors
// -------------------

test("the chat held by another launch gives LaunchLive (409), and the bound of loaded chats gives LoadedFull (503, 5)", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world(), { limits: { loaded: 1 } })
      const one = yield* b.real.make(TENANT_A, PICK)
      const two = yield* b.real.make(TENANT_A, PICK)
      const three = yield* b.real.make(TENANT_A, PICK)
      const other = yield* Scope.make()
      yield* Scope.provide(other)(Effect.orDie(b.real.store(TENANT_A, three, { ...LAUNCH, pid: 999_999, runTag: "other" })))
      expect(yield* Effect.flip(b.host.say(TENANT_A, three, "hello", null))).toBeInstanceOf(LaunchLive)
      yield* b.host.say(TENANT_A, one, "hello", null)
      expect(yield* Effect.flip(b.host.say(TENANT_A, two, "hello", null))).toEqual(new LoadedFull({ loaded: 1 }))
      yield* loadedOf(b, TENANT_A, one).turns.idle
      yield* Scope.close(other, Exit.void)
      yield* b.close
    }).pipe(Effect.provideService(ProcessAlive, () => true))
  )
})

// The rate
// --------

test("the 31st count in a window is refused with the whole seconds to its end, rounded up; a window that ended starts again", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = "11111111-1111-4111-8111-111111111111"
      yield* b.host.count(TENANT_A, chat)
      yield* TestClock.adjust("20 seconds")
      for (let k = 0; k < 29; k++) yield* b.host.count(TENANT_A, chat)
      yield* TestClock.adjust(30_500)
      expect(yield* Effect.flip(b.host.count(TENANT_A, chat))).toEqual(new TooMany({ seconds: 10 }))
      yield* TestClock.adjust(9_499)
      expect(yield* Effect.flip(b.host.count(TENANT_A, chat))).toEqual(new TooMany({ seconds: 1 }))
      yield* TestClock.adjust(1)
      // A new window, from now.
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, chat)
      expect(yield* Effect.flip(b.host.count(TENANT_A, chat))).toEqual(new TooMany({ seconds: 60 }))
      yield* b.close
    })
  )
})

test("two tenants with one UUID text have two windows; a message in does not count", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const uuid = yield* b.real.make(TENANT_A, PICK)
      yield* b.host.say(TENANT_A, uuid, "not counted", null)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, uuid)
      expect(yield* Effect.flip(b.host.count(TENANT_A, uuid))).toBeInstanceOf(TooMany)
      yield* b.host.count(TENANT_B, uuid)
      yield* loadedOf(b, TENANT_A, uuid).turns.idle
      yield* b.close
    })
  )
})

// The reviewer's probe (lead, ec-y11ev, 1): X counted at 1,000 s, the clock
// set back to 0, Y counted 30 times; at 100 s Y's window has ended.
test("the clock set back: Y's window counts from 1 again at 100 s with no refusal under 1 second, and ends saidWindow after its own start", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const x = "11111111-1111-4111-8111-111111111111"
      const y = "22222222-2222-4222-8222-222222222222"
      yield* TestClock.setTime(1_000_000)
      yield* b.host.count(TENANT_A, x)
      yield* TestClock.setTime(0)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, y)
      expect(yield* Effect.flip(b.host.count(TENANT_A, y))).toEqual(new TooMany({ seconds: 60 }))
      yield* TestClock.setTime(100_000)
      // A new window from 100 s: 30 pass, then the refusal's seconds.
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, y)
      expect(yield* Effect.flip(b.host.count(TENANT_A, y))).toEqual(new TooMany({ seconds: 60 }))
      yield* TestClock.setTime(159_999)
      expect(yield* Effect.flip(b.host.count(TENANT_A, y))).toEqual(new TooMany({ seconds: 1 }))
      yield* TestClock.setTime(160_000)
      yield* b.host.count(TENANT_A, y)
      yield* b.close
    })
  )
})

test("a pair whose window ended counts from 1 again though another pair's window, counted before it, has not ended", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const x = "11111111-1111-4111-8111-111111111111"
      const y = "22222222-2222-4222-8222-222222222222"
      yield* TestClock.setTime(1_000_000)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, x)
      yield* TestClock.setTime(0)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, y)
      yield* TestClock.setTime(60_000)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, y)
      expect(yield* Effect.flip(b.host.count(TENANT_A, y))).toEqual(new TooMany({ seconds: 60 }))
      // X's window started after now: X too counts from 1, from now.
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, x)
      expect(yield* Effect.flip(b.host.count(TENANT_A, x))).toEqual(new TooMany({ seconds: 60 }))
      yield* b.close
    })
  )
})

test("a clock that steps back before the asked pair's start gives a new window from now; seconds is 1 in its last millisecond", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const chat = "11111111-1111-4111-8111-111111111111"
      yield* TestClock.setTime(50_000)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, chat)
      expect(yield* Effect.flip(b.host.count(TENANT_A, chat))).toEqual(new TooMany({ seconds: 60 }))
      yield* TestClock.setTime(49_999)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, chat)
      expect(yield* Effect.flip(b.host.count(TENANT_A, chat))).toEqual(new TooMany({ seconds: 60 }))
      yield* TestClock.setTime(109_998)
      expect(yield* Effect.flip(b.host.count(TENANT_A, chat))).toEqual(new TooMany({ seconds: 1 }))
      yield* TestClock.setTime(109_999)
      yield* b.host.count(TENANT_A, chat)
      yield* b.close
    })
  )
})

test("two chats of one tenant have two windows: 30 of each pass", async () => {
  await run(() =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const one = "11111111-1111-4111-8111-111111111111"
      const two = "22222222-2222-4222-8222-222222222222"
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, one)
      for (let k = 0; k < 30; k++) yield* b.host.count(TENANT_A, two)
      expect(yield* Effect.flip(b.host.count(TENANT_A, one))).toBeInstanceOf(TooMany)
      expect(yield* Effect.flip(b.host.count(TENANT_A, two))).toBeInstanceOf(TooMany)
      yield* b.close
    })
  )
})

// The layer's end
// ---------------

test("the layer's end ends each client with stop and ends each launch row", async () => {
  await run((file) =>
    Effect.gen(function*() {
      const b = yield* build(world())
      const one = yield* b.real.make(TENANT_A, PICK)
      const two = yield* b.real.make(TENANT_B, PICK)
      const channel = yield* b.host.registry.held(TENANT_A, one)
      const client = yield* channel.addClient(0)
      const waiting = yield* channel.addClient(0)
      yield* b.host.say(TENANT_A, one, "hello", null)
      yield* b.host.say(TENANT_B, two, "hello", null)
      yield* loadedOf(b, TENANT_A, one).turns.idle
      yield* loadedOf(b, TENANT_B, two).turns.idle
      yield* b.close
      expect([client.ended, waiting.ended]).toEqual([{ reason: "stop" }, { reason: "stop" }])
      expect(launches(file).map((row) => [row.ended !== null, row.why])).toEqual([[true, "exit"], [true, "exit"]])
      expect(channel.loaded).toBeUndefined()
    })
  )
})
