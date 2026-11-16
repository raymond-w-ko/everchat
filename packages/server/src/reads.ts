// The places of reads and a client's first read
// =============================================
// The places of `reads`, and a client's own first read with its join
// (docs/host.md, section 2, "The give", the item of the client's own first
// read; section 3, "Admission", 11; section 8, the rows `reads` and "room
// for a page"; lead, ec-jyjxm). R4 and R6 run the first read; R2, R3 and
// R5 take the places only.
//
// The places (`makeReads`): one value for a host. `withPlace(effect)` runs
// `effect` with a place: at most `reads` run at one time. A wait for a
// place is first come, first served: a new comer finds a free place only
// when no one waits, and a place given back goes straight to the first
// waiter (the count of places taken does not fall in between). A wait of
// more than `readsWait` fails with `ReadsBusy`, and the waiter leaves the
// queue; so does an interrupted waiter, and it takes no place. A place
// that was handed to a waiter as it left (its time ran out, or it was
// interrupted, in the same turn) goes on to the next. The place goes back
// when the effect has ended (done, failed, or interrupted and its
// finalizers run), never before.
//
// The first read (`firstRead`): it gives a client the events after its
// `given` from the store, a page at a time, and then joins it to the
// listener's gives. For each page:
//
// 1. With no place and no lock held, it waits until the client's buffer
//    has room for the largest page (`page` entries and `pageBytes` bytes;
//    `Client.waitForPage`).
// 2. It takes a place, reads one page after the client's `given` (fit.ts,
//    `page`), gives it with `Channel.giveTo`, and gives the place back.
//    `noRoom` (a frame of the host took the room between the two steps):
//    the page is dropped, the client stays, and the read starts again at
//    step 1. No place is held across a wait on a client.
//
// `slow`: the client is ended as `slow` when its buffer has no room for a
// page `room` ms after the last page was given to it, or after the first
// read began. A page that was dropped does not start that time again, nor
// does a page with no entry (the read was at the store's end): it gave the
// client nothing to read.
//
// The join: when a page says that the read is at the store's end, the read
// calls `Channel.join`. `true`: the first read is done. `false` (the
// client's `given` is below `last`, or its buffer has no room for one
// entry): it reads on from its `given`, by the two steps, and checks again.
//
// Its ends: the function never fails; it gives how it ended, joined or
// ended with the reason. `ReadsBusy` ends the client as `busy`;
// `EntryTooLarge` and `StoreError` end it as `internal`, with one warning of
// Effect's log that names the event's number, its type and its size in
// bytes, or the store's operation, and no text of an event. A client that
// ended by another path (it went away, a give ended it as `slow`) stops the
// read at its next step, which then holds no place. An interruption (the
// route ends) gives the place back when the read under it has ended, and
// leaves the client as it is: the caller removes it.

import { Clock, Deferred, Effect, Exit, Schema } from "effect"
import type { Event, StoreError } from "@everchat/core/store"
import type { Channel, Client, Reason } from "./channel.ts"
import { type EntryTooLarge, page } from "./fit.ts"
import type { Limits } from "./limits.ts"

// A wait for a place of `reads` that passed `readsWait` (`waited`, in ms).
export class ReadsBusy extends Schema.TaggedError<ReadsBusy>()("ReadsBusy", {
  waited: Schema.Number
}) {}

export interface ReadPlaces {
  // Runs `effect` with a place (above).
  readonly withPlace: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ReadsBusy, R>
  // The places taken now, and the waiters in the queue now.
  readonly taken: () => number
  readonly waiting: () => number
}

// A waiter for a place: it waits until a place is handed to it.
interface Waiter {
  granted: boolean
  readonly handed: Deferred.Deferred<void>
}

// The places of a host, with the limits `reads` and `readsWait`.
export const makeReads = (limits: Pick<Limits, "reads" | "readsWait">): ReadPlaces => {
  let taken = 0
  const queue: Array<Waiter> = []

  // One place back: to the first waiter, else free. Synchronous.
  const giveBack = (): void => {
    const next = queue.shift()
    if (next === undefined) {
      taken -= 1
      return
    }
    next.granted = true
    Deferred.doneUnsafe(next.handed, Exit.void)
  }

  // Takes a place, or waits for one in the queue. The check, the count and
  // the entry into the queue are one synchronous body, under the mask of
  // `withPlace`; only the wait is interruptible (`restore`).
  const take = (restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
    Effect.suspend((): Effect.Effect<void, ReadsBusy> => {
      if (taken < limits.reads && queue.length === 0) {
        taken += 1
        return Effect.void
      }
      const waiter: Waiter = { granted: false, handed: Deferred.makeUnsafe<void>() }
      queue.push(waiter)
      const wait = Effect.timeoutOrElse(Deferred.await(waiter.handed), {
        duration: limits.readsWait,
        orElse: () => Effect.fail(new ReadsBusy({ waited: limits.readsWait }))
      })
      return restore(wait).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) return
            if (waiter.granted) {
              // Handed a place as it left: the place goes on.
              giveBack()
              return
            }
            const at = queue.indexOf(waiter)
            if (at >= 0) queue.splice(at, 1)
          })
        )
      )
    })

  return {
    withPlace: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(take(restore), () => restore(effect).pipe(Effect.ensuring(Effect.sync(giveBack))))
      ),
    taken: () => taken,
    waiting: () => queue.length
  }
}

// How a first read ended: the client joined, or it ended with the reason
// (`null`: removed with none, as when it went away).
export type ReadEnd =
  | { readonly _tag: "Joined" }
  | { readonly _tag: "Ended"; readonly reason: Reason | null }

// The limits that a first read uses, as the host's `Limits` names them.
export type ReadLimits = Pick<Limits, "entry" | "page" | "pageBytes" | "room">

export interface FirstRead<L> {
  readonly channel: Channel<L>
  readonly client: Client
  // The chat's events after `after`, at most `limit` (`Reading.eventsAfter`
  // of the chat's reads: this module opens no store).
  readonly read: (after: number, limit: number) => Effect.Effect<ReadonlyArray<Event>, StoreError>
  readonly places: ReadPlaces
  readonly limits: ReadLimits
}

// What step 2 gave: no read (the client had ended), or the page and what
// `giveTo` did with it.
type Step =
  | { readonly _tag: "Ended" }
  | { readonly _tag: "Read"; readonly outcome: "given" | "noRoom" | "ended"; readonly end: boolean; readonly entries: number }

// The first read of `client` (above).
export const firstRead = <L>(input: FirstRead<L>): Effect.Effect<ReadEnd> => {
  const { channel, client, read, places, limits } = input
  const ended = (): ReadEnd => ({ _tag: "Ended", reason: client.ended?.reason ?? null })
  // Ends the client with `reason`; a client that had ended keeps its own.
  const end = (reason: Reason): Effect.Effect<ReadEnd> => Effect.andThen(channel.removeClient(client, reason), Effect.sync(ended))

  // Step 2: one page, under a place.
  const step: Effect.Effect<Step, ReadsBusy | EntryTooLarge | StoreError> = places.withPlace(
    Effect.suspend(() => {
      if (client.ended !== null) return Effect.succeed<Step>({ _tag: "Ended" })
      return Effect.flatMap(page(read, client.given, limits), (got) =>
        Effect.map(channel.giveTo(client, got.entries), (outcome): Step => ({ _tag: "Read", outcome, end: got.end, entries: got.entries.length })))
    })
  )

  return Effect.gen(function*() {
    let since = yield* Clock.currentTimeMillis
    while (true) {
      if (client.ended !== null) return ended()
      // Step 1: room for a page, with no place held, until `room` ms after
      // `since`.
      if (!client.hasRoom(limits.page, limits.pageBytes)) {
        const left = since + limits.room - (yield* Clock.currentTimeMillis)
        const room = left <= 0
          ? "late" as const
          : yield* Effect.timeoutOrElse(client.waitForPage, { duration: left, orElse: () => Effect.succeed("late" as const) })
        if (room === "late") return yield* end("slow")
        if (!room) return ended()
      }
      // Step 2.
      const result = yield* Effect.result(step)
      if (result._tag === "Failure") {
        const fault = result.failure
        switch (fault._tag) {
          case "ReadsBusy":
            return yield* end("busy")
          case "EntryTooLarge":
            yield* Effect.logWarning(
              `a first read met event ${fault.n} (${fault.type}) of ${fault.bytes} bytes, over the limit entry: the client ends as internal`
            )
            return yield* end("internal")
          case "StoreError":
            yield* Effect.logWarning(`a first read's call of the store failed (${fault.op}): the client ends as internal`)
            return yield* end("internal")
        }
      }
      const got = result.success
      if (got._tag === "Ended" || got.outcome === "ended") return ended()
      // A page that no longer fits is dropped: back to step 1, with the
      // same `since`.
      if (got.outcome === "noRoom") continue
      if (got.entries > 0) since = yield* Clock.currentTimeMillis
      if (got.end && (yield* channel.join(client))) return { _tag: "Joined" }
    }
  })
}
