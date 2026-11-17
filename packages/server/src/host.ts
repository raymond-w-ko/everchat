// The host
// ========
// `Host`, the service of the loaded chats, and its layer (docs/host.md,
// section 1, `HostOptions`; section 2, "The deadline of the work under the
// lock"; section 3, "Admission", 4, 5 and 8; section 5; lead, ec-jyjxm).
// This entry, `@everchat/server`, gives `Host` and `Host.layer(options)`;
// `serve(options)`, the layer of the routes, is not here yet.
//
// `Host.layer(options)` needs `Chats`. At its start it makes the limits
// (`limits(options.limits)`: a refusal fails the layer with `LimitsRefused`)
// and checks the secret: fewer than 32 bytes fails the layer with
// `SecretTooShort`, whose text holds no byte of the secret and not its
// length. It makes one registry, one value of the places of `reads` and one
// loader for the host. The service gives what the routes need: the limits,
// the secret, the origins, the registry, the places of `reads`, a chat's
// reads, the count of a message for the rate, and the message in.
//
// A message in (`say`), for R1 and a socket's `say` alike, in this order:
//
// 1. The text is made well formed and is 1 to `text` bytes of UTF-8; a key
//    is 1 to `key` bytes of visible ASCII (0x21 to 0x7E). Else
//    `MessageRefused` (the routes: `400`), before any hold.
// 2. It holds the channel, in a scope of this call, and waits for the
//    channel's lock at most `lockWait`: past it, `ChatBusy` (the routes:
//    `503` with `retry-after: 1`), and nothing is logged.
// 3. Under the lock, with the deadline `lock` from the moment it took the
//    lock: it loads the chat when the channel has none, then `Turns.say`.
//    At the deadline it interrupts that work and waits for its end: the
//    load stops at its next wait, and so does `Turns.say` (its waits for
//    the loop's `order` and `lock`, the keyed read, the memory's lock); a
//    step of `Turns.say` that began runs whole (the core's rule). The core
//    tells the `Sent` (`told`) in the step that commits the message, so a
//    message in the log always gives its `Sent`: also when the deadline
//    passed before the work's end, and also when the work's exit is the
//    deadline's interruption (lead, ec-y11ev, 2; ec-p9osd). Work that the
//    deadline cut with no `Sent` gives `ChatBusy`, and nothing of it is in
//    the log. So a message that is in the log is never answered
//    `ChatBusy`. The loader's errors pass typed: `NoChat`,
//    `LaunchLive` (`409 chat_elsewhere`), `LoadedFull` (`503`,
//    `retry-after: 5`), `StoreError` and `StackFailed` (`500 internal`,
//    with one line of Effect's log that names the store's operation, and
//    no text of a message).
//
// A deadline asks; the work's end frees (O2, Q1). The lock and the hold go
// back when the work under the lock has ended, never before: at the
// deadline, at an interruption of the caller, at a fault. The lock goes back
// first, then the hold. Nothing is detached: each wait runs in a child
// fiber that this call interrupts at its time and waits for, and the
// fiber's exit is read only after its end (`within`). So a permit of the
// lock that the wait took just as its time passed is given back too.
// After a work that failed in the store, the host unloads the chat at once,
// under the same lock, before the lock goes back: its memory refuses each
// later write. A turn that started runs in the loaded chat's scope, and an
// end of the caller never stops it.
//
// The rate (`count`, "Admission", 8): a fixed window of `saidWindow` that
// starts at the first message counted, for a chat of a tenant (both: the
// key is the pair); past `said` in a window, `TooMany` with the whole
// seconds to the window's end, rounded up, and at least 1 (`429
// too_many`). The asked pair's window is new, its count 1 from now, when it
// has ended or when the clock is before its start (the clock stepped back;
// lead, ec-y11ev, 1). The windows are the host's, not the channel's; a
// window that has ended, or whose start is after now, leaves the map. The
// caller counts; `say` does not.
//
// The layer's end, in this order: the registry's `stop`, so that no request
// becomes a client after it (one in its checks, a socket whose `auth` comes
// late, an R5 that joins to wait: `ClientRefused`, as for a full host);
// then each client of each channel ends with `stop`; then each loaded chat
// is unloaded (the loader's end), so each launch ends (lead, ec-yculc,
// ruling 2). So each client gets `stop`, and none comes after it. The host
// keeps the channels of its registry for it: the registry that it gives
// notes each channel that it holds.

import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Redacted, Schema, Semaphore } from "effect"
import type { Memory } from "@everchat/core/memory"
import { Chats, type LaunchLive, type NoChat, type Reading, type Store, StoreError } from "@everchat/core/store"
import type { Sent, Turns } from "@everchat/core/turn"
import { type Channel, makeRegistry, type Registry } from "./channel.ts"
import { utf8 } from "./fit.ts"
import { type Limits, limits as makeLimits, type LimitsRefused } from "./limits.ts"
import { type LaunchFields, type LoadedChat, type LoadedFull, makeLoader, type StackFailed } from "./loaded.ts"
import { makeReads, type ReadPlaces } from "./reads.ts"

export interface HostOptions {
  // The stack of one loaded chat over its store. It gives the turn loop and
  // the memory. The caller builds process-wide values one time, outside it.
  readonly stack: (store: typeof Store.Service) => Layer.Layer<Turns | Memory, unknown>
  // What each load records in its launch row; the host adds a new run tag each time.
  readonly launch: LaunchFields
  // The secret of the deployment: 32 bytes or more.
  readonly secret: Redacted.Redacted<Uint8Array>
  // The origins that may send a request with `Origin`.
  readonly origins: ReadonlyArray<string>
  // The limits of section 8, each with its default.
  readonly limits?: Partial<Limits>
}

// The secret is shorter than 32 bytes. Neither the error nor its text holds
// a byte of the secret or its length.
export class SecretTooShort extends Schema.TaggedError<SecretTooShort>()("SecretTooShort", {}) {
  override get message() {
    return "The secret of the deployment must be 32 bytes or more."
  }
}

// A message in whose text or key is not valid: the routes answer `400`.
export class MessageRefused extends Schema.TaggedError<MessageRefused>()("MessageRefused", {
  field: Schema.Literals(["text", "key"])
}) {}

// A message in that waited `lockWait` for the channel's lock (`lock`), or
// whose work under the lock the deadline cut (`work`: its exit is not a
// success): the routes answer `503 busy` with `retry-after: 1`.
export class ChatBusy extends Schema.TaggedError<ChatBusy>()("ChatBusy", {
  at: Schema.Literals(["lock", "work"])
}) {}

// A message past the rate of its chat: the routes answer `429 too_many`
// with `retry-after: <seconds>`.
export class TooMany extends Schema.TaggedError<TooMany>()("TooMany", {
  seconds: Schema.Number
}) {}

export type SayError = MessageRefused | ChatBusy | NoChat | LaunchLive | LoadedFull | StoreError | StackFailed

// The most bytes of the secret that are too few.
const SHORT = 32

export class Host extends Context.Service<Host, {
  readonly limits: Limits
  readonly secret: Redacted.Redacted<Uint8Array>
  readonly origins: ReadonlyArray<string>
  readonly registry: Registry<LoadedChat>
  readonly reads: ReadPlaces
  // The reads of a chat of a tenant (`Chats.reads`).
  chatReads(tenant: string, chat: string): Effect.Effect<Reading, NoChat | StoreError>
  // Counts one message in for a chat of a tenant, or refuses it.
  count(tenant: string, chat: string): Effect.Effect<void, TooMany>
  // A message in (the head comment).
  say(tenant: string, chat: string, text: string, key: string | null): Effect.Effect<Sent, SayError>
}>()("everchat/server/Host") {
  static readonly layer = (options: HostOptions): Layer.Layer<Host, LimitsRefused | SecretTooShort, Chats> =>
    Layer.effect(Host, make(options))
}

// A key: 1 to `most` bytes of visible ASCII.
const keyIsValid = (key: string, most: number): boolean => {
  if (key.length < 1 || key.length > most) return false
  for (let k = 0; k < key.length; k++) {
    const code = key.charCodeAt(k)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

// What `within` saw: the work's exit, whether its time passed, and the
// caller's interruption, if one came.
interface Within<A, E> {
  readonly exit: Exit.Exit<A, E>
  readonly late: boolean
  readonly stopped: Cause.Cause<never> | null
}

// Runs `work` in a child fiber for at most `ms` milliseconds of Effect's
// clock. At that time, or at an interruption of the caller, it interrupts
// the work and waits for its end; it gives the exit only then. Run it in an
// uninterruptible region: its own waits are interruptible.
const within = <A, E>(work: Effect.Effect<A, E>, ms: number): Effect.Effect<Within<A, E>> =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.interruptible(work))
    const timer = yield* Effect.forkChild(Effect.interruptible(Effect.sleep(ms)))
    const first = yield* Effect.exit(Effect.interruptible(
      Effect.raceFirst(Fiber.await(fiber), Effect.as(Fiber.await(timer), null))
    ))
    const done = Exit.isSuccess(first) && first.value !== null
    if (!done) yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    yield* Fiber.interrupt(timer)
    return {
      exit,
      late: Exit.isSuccess(first) && first.value === null,
      stopped: Exit.isFailure(first) ? first.cause : null
    }
  })

// One window of the rate: its start, and the messages counted in it.
interface Window {
  readonly start: number
  count: number
}

const make = (options: HostOptions) =>
  Effect.gen(function*() {
    const limits = yield* makeLimits(options.limits)
    if (Redacted.value(options.secret).length < SHORT) return yield* new SecretTooShort()
    const chats = yield* Chats
    const reads = makeReads(limits)

    // The registry, with the channels that it holds noted, for the end.
    const base = makeRegistry<LoadedChat>(limits)
    const channels = new Set<Channel<LoadedChat>>()
    const hold = (tenant: string, uuid: string) =>
      Effect.uninterruptible(Effect.tap(base.hold(tenant, uuid), (channel) => Effect.sync(() => channels.add(channel))))
    const letGo = (channel: Channel<LoadedChat>) =>
      Effect.uninterruptible(Effect.tap(base.letGo(channel), () =>
        Effect.sync(() => {
          if (channel.holders === 0) channels.delete(channel)
        })))
    const registry: Registry<LoadedChat> = {
      hold,
      letGo,
      held: (tenant, uuid) => Effect.acquireRelease(hold(tenant, uuid), letGo),
      find: base.find,
      size: base.size,
      stop: base.stop
    }

    const loader = yield* makeLoader({ stack: options.stack, launch: options.launch, limits, registry })

    // The rate: the windows by the pair, in the order of their start while
    // the clock does not step back; `latest` is the time of the last count.
    const windows = new Map<string, Window>()
    let latest = Number.NEGATIVE_INFINITY
    // Drops each window that has ended and each whose start is after `now`.
    // In the order of their start, a window that has neither means that no
    // later one has: the sweep stops there. After the clock stepped back, the
    // order may not hold, so it goes through all; what stays then starts at
    // or before `now`, in order, and the order holds again.
    const sweep = (now: number) => {
      const stepped = now < latest
      latest = now
      for (const [key, window] of windows) {
        const live = window.start <= now && now < window.start + limits.saidWindow
        if (live && !stepped) break
        if (!live) windows.delete(key)
      }
    }
    const count = (tenant: string, chat: string) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const key = JSON.stringify([tenant, chat])
        const window = windows.get(key)
        let refused: TooMany | undefined
        if (window === undefined || now < window.start || now >= window.start + limits.saidWindow) {
          // A new window, from now, at the map's end.
          windows.delete(key)
          windows.set(key, { start: now, count: 1 })
        } else if (window.count >= limits.said) {
          refused = new TooMany({ seconds: Math.max(1, Math.ceil((window.start + limits.saidWindow - now) / 1000)) })
        } else {
          window.count += 1
        }
        sweep(now)
        if (refused !== undefined) return yield* refused
      })

    // The work under the lock: the load when the channel has no loaded
    // chat, then the message's log and the start of its turn. Both can be
    // cut at their waits. An interruption that lands as `Turns.say`'s commit
    // step ends would drop its `Sent`, though its message is in the log: so
    // `said` gets the `Sent` from the core's `told`, which runs in that step.
    const work = (channel: Channel<LoadedChat>, text: string, key: string | null, said: (sent: Sent) => void) =>
      Effect.gen(function*() {
        const chat = channel.loaded ?? (yield* loader.load(channel))
        return yield* chat.turns.say(text, key, (sent) => Effect.sync(() => said(sent)))
      })

    // The end of a failed work: one line of the log, with no text of a message.
    const logged = (error: SayError) => {
      if (error instanceof StoreError) return Effect.logWarning(`a message in failed in the store's ${error.op}`)
      if (error._tag === "StackFailed") return Effect.logWarning("a message in failed: the stack of its chat did not build")
      return Effect.void
    }

    const say = (tenant: string, uuid: string, given: string, key: string | null): Effect.Effect<Sent, SayError> =>
      Effect.gen(function*() {
        const text = given.toWellFormed()
        const bytes = utf8(text)
        if (bytes < 1 || bytes > limits.text) return yield* new MessageRefused({ field: "text" })
        if (key !== null && !keyIsValid(key, limits.key)) return yield* new MessageRefused({ field: "key" })
        return yield* Effect.scoped(Effect.uninterruptible(Effect.gen(function*() {
          const channel = yield* registry.held(tenant, uuid)
          // The wait for the lock, at most `lockWait`.
          const waited = yield* within(Semaphore.take(channel.lock, 1), limits.lockWait)
          if (Exit.isSuccess(waited.exit)) yield* Effect.addFinalizer(() => Semaphore.release(channel.lock, 1))
          if (waited.stopped !== null) return yield* Effect.failCause(waited.stopped)
          if (Exit.isFailure(waited.exit)) return yield* new ChatBusy({ at: "lock" })
          // The work under the lock, with its deadline.
          let sent: Sent | undefined
          const done = yield* within(work(channel, text, key, (given) => {
            sent = given
          }), limits.lock)
          if (Exit.isFailure(done.exit)) {
            const error = Cause.findErrorOption(done.exit.cause)
            // Every `StoreError` unloads, also the core's refusal of a key's
            // form, which fails that say alone: the core gives it as a failed
            // `append` with a plain error, as a write that failed may be, and
            // only its text tells them apart; no input reaches it here (the
            // key's check above, and the limit `key` at most 128).
            if (error._tag === "Some" && error.value instanceof StoreError) yield* loader.unload(channel)
            if (error._tag === "Some") yield* logged(error.value)
          }
          if (done.stopped !== null) return yield* Effect.failCause(done.stopped)
          // A message in the log: its `Sent`, late or not, also when the
          // work's exit is the deadline's interruption.
          if (sent !== undefined) return sent
          if (done.late) return yield* new ChatBusy({ at: "work" })
          return yield* done.exit
        })))
      })

    // The layer's end: the registry's stop, then each client ends with
    // `stop`, then the loader's end.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        yield* base.stop
        for (const channel of [...channels]) {
          for (const client of channel.clients) yield* channel.removeClient(client, "stop")
        }
        yield* loader.end
      })
    )

    return Host.of({
      limits,
      secret: options.secret,
      origins: options.origins,
      registry,
      reads,
      chatReads: (tenant, chat) => chats.reads(tenant, chat),
      count,
      say
    })
  })
