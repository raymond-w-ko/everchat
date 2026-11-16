// The loaded chat
// ===============
// The load of a chat, its listener, its timer and its unload (docs/host.md,
// section 2, "Load", "Work, and the 6 minutes", "Unload", "Load again", and
// the last paragraph of "The give"; lead, ec-jyjxm). It is the tenant
// boundary of the host's writes: the chat is found by `Chats.store` with the
// channel's tenant and UUID, both, and a chat that is not the tenant's is
// `NoChat`, with nothing of it read or written.
//
// `makeLoader(options)` gives one loader for a host, over the `Chats` in the
// context and a scope of its own, a child of the caller's: `load(channel)`,
// `unload(channel)`, the count of loaded chats, and `end`. The caller holds
// the channel's lock around `load` and `unload`; the timer takes it itself.
//
// Load (steps 1 to 3 of the page):
//
// - The bound first: a place of `loaded`, taken in the same step as its
//   check, or `LoadedFull` before any read or write (no launch row). Then a
//   hold of the channel (the loaded chat's, from its load to its unload).
// - The loaded chat's scope, a child of the loader's scope, never of the
//   fiber that loads: a request's end never closes it.
// - `Chats.store` with a new run tag (the launch row), in that scope; then
//   the stack over that store, built in that scope.
// - The listener: it subscribes to the turn loop, reads the chat's `seq`,
//   sets `last` (the channel's `listen`), reads the events after `last` in
//   pages and gives each. Then it runs in the loaded chat's scope: a live
//   numbered event at or below `last` is dropped; `last` plus one is given;
//   a higher one shows a loss of the hub, so the events after `last` up to
//   it are read from the store and given first. A piece goes by
//   `givePiece`, unless the fit drops it.
// - The publication, its last step: the listener's fiber (in the loaded
//   chat's scope) and the timer's (in the loader's) start, then one step
//   sets `channel.loaded` and puts the chat in the loader's list.
//
// A load that fails or is stopped at any step before its publication closes
// what it made, as an unload does, before it returns ("a deadline asks; the
// work's end frees"): after `NoChat` and `LaunchLive` no launch row of this
// host, no hold and no place are left. The errors of `Chats.store` pass
// typed; a failure of the stack is `StackFailed`.
//
// The publication is the load's point of no return (lead, ec-mhmpr, B). A
// load that published is a loaded chat, whole: its listener runs,
// `channel.loaded` is set, its timer runs, and its hold and its place are the
// loaded chat's. The publication is one step that no interruption splits. An
// interruption that comes in it or after it is given to the caller and does
// not undo the load: the next load of the channel gives the same loaded chat
// with no second launch row, and the timer unloads it `unload` ms after the
// last work. To undo a whole load at a late interruption would cost an
// unload's calls of the store under an interruption, and the state is safe
// and bounded (the bound of loaded chats, the timer).
//
// An event that cannot be given (`EntryTooLarge`, in any read or live): the
// channel's `cannotGive`, one line of Effect's log with the event's number,
// its type and its size in bytes (no text of it), and the read goes on after
// it. A store's fault in the listener's read after a loss is the same for the
// events that it could not read.
//
// The timer: a fiber of the loader's scope (not of the loaded chat's, which
// it closes). It sleeps until `unload` ms after the last work (the later of
// `Turns.worked` and `Memory.worked`), takes the channel's lock, and unloads
// when neither is busy and the last work is `unload` ms old or more; else it
// sleeps again. An unload by another path ends it.
//
// Unload (steps 1 to 3 of the page), one piece of work that no interruption
// splits: close the loaded chat's scope (the launch row ends, the listener
// stops); read the events after the lowest `given` of the clients that
// joined, in pages, and give them (none joined: no read); clear
// `channel.loaded`, let go of the hold, give the place back. On a channel
// with no loaded chat it does nothing.
//
// The loader's end (its scope closes, or `end`; lead, ec-mhmpr, A). The
// loader knows each load under way, from the step that takes its place to
// the step that publishes it or gives its place back. The end, in this
// order: it refuses new loads (the defect "the loader has ended"); it asks
// each load under way to stop, as a deadline does: the steps of a load that
// wait (`Chats.store`, the stack's build, the read of `seq`, the read after
// `last`) are interrupted, and the load fails with the same defect, closing
// what it made in its caller's fiber, under the lock that its caller holds;
// it waits until no load is under way (a part of a step that an interruption
// cannot stop keeps it waiting: the end has no deadline); then it reads the
// list of the loaded chats, unloads each under its channel's lock (a load
// that passed its last check of the end when the end began has published,
// and is among them), and closes its scope. The end takes no lock of a load
// under way, closes none of its scopes and ends none of its launch rows. It
// is one piece of work that an interruption does not split; it runs one
// time, and each call, also at one time, returns only when it is whole: no
// place is taken and the loader holds no channel.

import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, PubSub, Schema, Scope, Semaphore } from "effect"
import { Memory } from "@everchat/core/memory"
import { Chats, type Event, type LaunchLive, type NoChat, type Store, StoreError } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import type { Channel, Registry } from "./channel.ts"
import { type Entry, EntryTooLarge, fit, page, type PageLimits, type TurnEvent } from "./fit.ts"
import type { Limits } from "./limits.ts"

// What a message in needs of a loaded chat.
export interface LoadedChat {
  readonly runTag: string
  readonly store: typeof Store.Service
  readonly turns: typeof Turns.Service
  readonly memory: typeof Memory.Service
}

// What a load records in its launch row; the loader adds a new run tag.
export interface LaunchFields {
  readonly pid: number
  readonly host: string
  readonly cwd: string
  readonly version: string
}

export interface LoaderOptions {
  // The stack of one loaded chat over its store.
  readonly stack: (store: typeof Store.Service) => Layer.Layer<Turns | Memory, unknown>
  readonly launch: LaunchFields
  readonly limits: Limits
  readonly registry: Registry<LoadedChat>
}

// A load past `loaded`: the route answers `503 busy` with `retry-after: 5`.
export class LoadedFull extends Schema.TaggedError<LoadedFull>()("LoadedFull", {
  loaded: Schema.Number
}) {}

// The stack of a chat failed to build.
export class StackFailed extends Schema.TaggedError<StackFailed>()("StackFailed", {
  cause: Schema.Defect()
}) {}

export type LoadError = LoadedFull | NoChat | LaunchLive | StoreError | StackFailed

export interface Loader {
  // Loads the chat of `channel`, under its lock (the caller's); a loaded
  // chat is given as it is.
  readonly load: (channel: Channel<LoadedChat>) => Effect.Effect<LoadedChat, LoadError>
  // Unloads it, under its lock (the caller's); nothing when it is not loaded.
  readonly unload: (channel: Channel<LoadedChat>) => Effect.Effect<void>
  // The places of `loaded` taken: the loaded chats and the loads under way.
  readonly loaded: () => number
  // Unloads each loaded chat, each under its channel's lock, and ends the
  // loader: a load after it is a defect.
  readonly end: Effect.Effect<void>
}

type Read = (after: number, limit: number) => Effect.Effect<ReadonlyArray<Event>, StoreError>

// The one line of the log for an event that cannot be given: its number,
// its type and its size, and no text of it.
const tooLarge = (channel: Channel<LoadedChat>, fault: EntryTooLarge, limits: PageLimits) =>
  Effect.andThen(
    Effect.logWarning(`event ${fault.n} (${fault.type}) is ${fault.bytes} bytes, over the limit entry of ${limits.entry}: it is not given`),
    channel.cannotGive(fault.n)
  )

// Reads the events after `after` with `read`, a page at a time, up to the
// number `upTo` (or to the store's end), and gives each. An event that
// cannot be given: the events before it are given, then `tooLarge`, and the
// read goes on after it.
const readOn = (channel: Channel<LoadedChat>, read: Read, after: number, upTo: number | null, limits: PageLimits) =>
  Effect.gen(function*() {
    let at = after
    let large: EntryTooLarge | null = null
    while (upTo === null || at < upTo) {
      if (large !== null && large.n === at + 1) {
        yield* tooLarge(channel, large, limits)
        at = large.n
        large = null
        continue
      }
      const bound = large !== null ? large.n - 1 : upTo
      const capped: Read = bound === null
        ? read
        : (from, limit) => (bound - from < 1 ? Effect.succeed([]) : read(from, Math.min(limit, bound - from)))
      const got = yield* page(capped, at, limits).pipe(Effect.catchTag("EntryTooLarge", (fault) => Effect.succeed(fault)))
      if (got instanceof EntryTooLarge) {
        large = got
        continue
      }
      for (const entry of got.entries) yield* channel.give(entry)
      if (large !== null) {
        // The store gave nothing before the event that is too large: no
        // event is between, so it is next.
        if (got.last === at) {
          yield* tooLarge(channel, large, limits)
          at = large.n
          large = null
        } else {
          at = got.last
        }
        continue
      }
      at = got.last
      if (got.end) return
    }
  })

// One loaded chat, as the loader holds it.
interface Held {
  readonly channel: Channel<LoadedChat>
  readonly scope: Scope.Closeable
  store: typeof Store.Service | undefined
  chat: LoadedChat | undefined
  timer: Fiber.Fiber<void> | undefined
  // A load under way: from its place to its publication or its release.
  underWay: boolean
}

export const makeLoader = (options: LoaderOptions): Effect.Effect<Loader, never, Chats | Scope.Scope> =>
  Effect.gen(function*() {
    const chats = yield* Chats
    const { limits, registry } = options
    const own = yield* Scope.fork(yield* Effect.scope, "sequential")
    const loads = new Map<Channel<LoadedChat>, Held>()
    let places = 0
    let ended = false
    // The loads under way, and the waits of the end for none.
    let underWay = 0
    let drainers: Array<Deferred.Deferred<void>> = []
    const finished = () => {
      underWay -= 1
      if (underWay > 0) return
      const waiting = drainers
      drainers = []
      for (const drainer of waiting) Deferred.doneUnsafe(drainer, Exit.void)
    }
    // Until no load is under way.
    const drained: Effect.Effect<void> = Effect.suspend(() => {
      if (underWay === 0) return Effect.void
      const drainer = Deferred.makeUnsafe<void>()
      drainers.push(drainer)
      return Effect.andThen(Deferred.await(drainer), drained)
    })
    // The end's ask: done when the end begins.
    const ending = Deferred.makeUnsafe<void>()
    const endedError = () => new Error("the loader has ended")

    // A step of a load that waits, which the end can stop: it runs in a
    // child fiber, and when the end asks (or the caller is interrupted), the
    // step is interrupted and waited for; at the end's ask the load then
    // fails with the defect "the loader has ended". A part of the step that
    // an interruption cannot stop keeps the end waiting.
    const stoppable = <A, E>(restore: <X, Y, Z>(effect: Effect.Effect<X, Y, Z>) => Effect.Effect<X, Y, Z>, step: Effect.Effect<A, E>) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.interruptible(step))
        const first = yield* Effect.exit(restore(Effect.raceFirst(
          Effect.interruptible(Fiber.await(fiber)),
          Effect.interruptible(Effect.as(Deferred.await(ending), null))
        )))
        const done = Exit.isSuccess(first) && first.value !== null
        if (!done) yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        if (Exit.isFailure(first)) return yield* Effect.failCause(first.cause)
        if (!done) return yield* Effect.die(endedError())
        return yield* exit
      })

    // The unload's read (Unload, step 2), and a stopped load's.
    const readAtUnload = (channel: Channel<LoadedChat>, store: typeof Store.Service) =>
      Effect.gen(function*() {
        const lowest = yield* channel.lowestGiven
        if (lowest === null) return
        yield* readOn(channel, (after, limit) => store.eventsAfter(after, limit), lowest, null, limits).pipe(
          Effect.catchTag("StoreError", (fault) =>
            Effect.gen(function*() {
              // The clients that joined may miss events: each ends.
              yield* Effect.logWarning(`the read of an unload failed in the store's ${fault.op}: the clients that joined end`)
              for (const client of channel.clients) {
                if (client.joined) yield* channel.removeClient(client, "internal")
              }
            }))
        )
      })

    // Closes what a load made, as an unload does: the scope (the launch row
    // ends), the read, `channel.loaded`, the hold, the place. Not
    // interruptible: its caller runs it so.
    const release = (held: Held, exit: Exit.Exit<unknown, unknown>) =>
      Effect.gen(function*() {
        if (held.timer !== undefined) yield* Fiber.interrupt(held.timer)
        yield* Scope.close(held.scope, exit)
        if (held.store !== undefined) yield* readAtUnload(held.channel, held.store)
        if (held.chat !== undefined && held.channel.loaded === held.chat) held.channel.loaded = undefined
        yield* registry.letGo(held.channel)
        places -= 1
        if (held.underWay) {
          held.underWay = false
          finished()
        }
      })

    // The unload of `held`, one piece of work. `timer`: the timer of `held`
    // runs it, so it is not interrupted.
    const unloadHeld = (held: Held, timer: boolean) =>
      Effect.uninterruptible(Effect.suspend(() => {
        if (loads.get(held.channel) !== held) return Effect.void
        loads.delete(held.channel)
        if (timer) held.timer = undefined
        return release(held, Exit.void)
      }))

    // The last work of a loaded chat: the later of the two.
    const worked = (chat: LoadedChat) =>
      Effect.zipWith(chat.turns.worked, chat.memory.worked, (a, b) => Math.max(a, b))
    const busy = (chat: LoadedChat) =>
      Effect.zipWith(chat.turns.busy, chat.memory.busy, (a, b) => a || b)

    // The timer of `held` (above).
    const timer = (held: Held, chat: LoadedChat): Effect.Effect<void> =>
      Effect.gen(function*() {
        while (true) {
          const at = (yield* worked(chat)) + limits.unload
          const now = yield* Clock.currentTimeMillis
          if (now < at) {
            yield* Effect.sleep(at - now)
            continue
          }
          const done = yield* Semaphore.withPermit(
            held.channel.lock,
            Effect.gen(function*() {
              if (loads.get(held.channel) !== held) return true
              if (yield* busy(chat)) return false
              if ((yield* Clock.currentTimeMillis) - (yield* worked(chat)) < limits.unload) return false
              yield* unloadHeld(held, true)
              return true
            })
          )
          if (done) return
        }
      })

    // The listener's live part: each event of the subscription (above).
    const listen = (channel: Channel<LoadedChat>, events: PubSub.Subscription<TurnEvent>, read: Read): Effect.Effect<never> =>
      Effect.forever(Effect.gen(function*() {
        const event = yield* PubSub.take(events)
        if (!("n" in event)) {
          const fitted = fit(event, limits.entry)
          if (fitted._tag === "Entry") yield* channel.givePiece(fitted)
          return
        }
        const last = channel.last ?? 0
        if (event.n <= last) return
        if (event.n > last + 1) {
          // A loss of the hub: the events between come from the store.
          yield* readOn(channel, read, last, event.n - 1, limits).pipe(
            Effect.catchTag("StoreError", (fault) =>
              Effect.andThen(
                Effect.logWarning(`the read after a loss, up to event ${event.n - 1}, failed in the store's ${fault.op}`),
                channel.cannotGive(event.n - 1)
              ))
          )
        }
        const fitted = fit(event, limits.entry)
        if (fitted._tag === "EntryTooLarge") yield* tooLarge(channel, fitted, limits)
        else yield* channel.give(fitted as Entry)
      }))

    const load = (channel: Channel<LoadedChat>): Effect.Effect<LoadedChat, LoadError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          if (ended) return yield* Effect.die(endedError())
          const found = loads.get(channel)
          if (found !== undefined && found.chat !== undefined) return found.chat
          // The bound: the check and the place in one step.
          if (places >= limits.loaded) return yield* new LoadedFull({ loaded: limits.loaded })
          places += 1
          underWay += 1
          const holding = yield* registry.hold(channel.tenant, channel.uuid)
          if (holding !== channel) {
            yield* registry.letGo(holding)
            places -= 1
            finished()
            return yield* Effect.die(new Error("the channel to load is not the registry's channel of its chat"))
          }
          const held: Held = { channel, scope: yield* Scope.fork(own, "sequential"), store: undefined, chat: undefined, timer: undefined, underWay: true }
          const steps = Effect.gen(function*() {
            const runTag = crypto.randomUUID()
            held.store = yield* stoppable(restore, Scope.provide(held.scope)(chats.store(channel.tenant, channel.uuid, { ...options.launch, runTag })))
            const store = held.store
            const context = yield* stoppable(restore, Layer.buildWithScope(options.stack(store), held.scope)).pipe(
              Effect.mapError((cause) => new StackFailed({ cause }))
            )
            const chat: LoadedChat = { runTag, store, turns: Context.get(context, Turns), memory: Context.get(context, Memory) }
            // The listener: subscribe first, then `seq`, then `last`.
            const events = yield* Scope.provide(held.scope)(chat.turns.subscribe)
            const seq = (yield* stoppable(restore, store.chat)).seq
            const last = yield* channel.listen(seq)
            const read: Read = (after, limit) => store.eventsAfter(after, limit)
            yield* stoppable(restore, readOn(channel, read, last, null, limits))
            // The last check of the end. Past it the load publishes.
            if (ended) return yield* Effect.die(endedError())
            // The publication (the head comment): the listener and the timer
            // first, in scopes that are not the caller's, then one step that
            // makes the load a loaded chat. No end and no interruption can
            // come between its parts.
            yield* Effect.forkIn(listen(channel, events, read), held.scope)
            held.timer = yield* Effect.forkIn(timer(held, chat), own)
            yield* Effect.sync(() => {
              held.chat = chat
              channel.loaded = chat
              loads.set(channel, held)
              held.underWay = false
              finished()
            })
            return chat
          })
          return yield* steps.pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : release(held, exit))))
        })
      )

    const unload = (channel: Channel<LoadedChat>) =>
      Effect.suspend(() => {
        const held = loads.get(channel)
        return held === undefined ? Effect.void : unloadHeld(held, false)
      })

    // The end (the head comment): once, and each call waits until it is whole.
    let whole: Deferred.Deferred<void> | undefined
    const end = Effect.uninterruptible(Effect.suspend(() => {
      if (whole !== undefined) return Deferred.await(whole)
      const done = Deferred.makeUnsafe<void>()
      whole = done
      return Effect.gen(function*() {
        ended = true
        Deferred.doneUnsafe(ending, Exit.void)
        yield* drained
        for (const held of [...loads.values()]) {
          yield* Semaphore.withPermit(held.channel.lock, unloadHeld(held, false))
        }
        yield* Scope.close(own, Exit.void)
      }).pipe(Effect.ensuring(Deferred.done(done, Exit.void)))
    }))
    yield* Effect.addFinalizer(() => end)

    return { load, unload, loaded: () => places, end }
  })
