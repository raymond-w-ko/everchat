// Turn
// ====
// The turn loop: one loop of the model, from a first message, through steps
// and programs, until a step that runs no program. It is a port of the old
// code's loop (ref/src/server.ts `Chat.take`, `Chat.turn`, `Chat.call`, and
// ref/src/agent.ts `Agent.loop`), with one difference: every step is in the
// database before the next one starts, so a turn that a stop of the program
// cut goes on at the next launch.
//
// What a person's message does (`say`)
//
// - It is logged at once, with its free nodes: it is then accepted.
// - If no turn runs, a turn starts in the same transaction, and its fiber
//   in the same step that cannot be interrupted.
// - With its sender's key (the host's `Idempotency-Key`), it is logged one
//   time: a key that the chat has already gives that first message, its
//   `accepted` number, and nothing else (`Sent`, `repeat`). Its text is not
//   compared. The key is read under the loop's `lock`, so two messages of
//   one key in one process log one; the store's index is the wall between
//   two processes (store.ts, `append`). A key of another form (store.ts,
//   `SENDER_KEY`) is refused before any read or write, with the store's
//   own `StoreError`: that `say` alone fails, and the next one is logged.
//   A write that the store refuses still stops the chat's memory for good
//   (a key that a second process wrote first); its owner makes it again,
//   as a host does with an unload and a load (docs/host.md, section 2).
// - If a turn runs, the message steers it: the turn takes it in after the
//   results of its present step. A message that comes too late for the turn
//   starts the next turn.
// - While a stopped turn's end is not yet written (the stop's finalizer in
//   `drive`, after the turn's fiber is cut), it is as a message just after
//   that end: it waits for the end (written or failed), then is logged and
//   starts its turn, so its pages, their `accepted` and the turn's `start`
//   come after the stopped turn's note and `end`, and two turns never run.
//   A `say` cut while it waits writes nothing. A key that the chat has
//   answers before the wait, and a key of another form is refused before
//   it. With no turn running, a lost end (below) is written first, as
//   `ready` does: if that fails, `say` fails with its error and writes
//   nothing.
//
// A message from outside a turn (`Source`, the seam)
//
// A source (the result of a call that ran after a person's yes; a wake-up
// that came due) has a message that must start a turn of its own. It never
// steers a turn that runs: it waits until the chat is idle. The loop asks
// the source (`next`) at two places, under its `lock`: at a turn's end,
// after a failed turn always, and after a done one when no message of the
// person waits (that message starts its own turn first); and in `ready`,
// which the source's owner calls when it has something, and which does
// nothing while a turn runs (that turn's end asks). A message of the person
// that waits (after a failed turn) does not hold an offer back: the offer's
// turn takes it in, in its first item, in the order of the messages. Not
// after a stop: the offer waits for the next end or the next `ready`. An
// offer is logged with its turn in one transaction (`offer`): its pages and
// their `message` events, the turn and its `start`, then the source's own
// `write`. Several sources are one (`Source.inOrder`), asked in the order
// given. A chat with no source pays one test at a turn's end. An offer may
// carry a ceiling of steps and tokens, kept on its turn's row: the turn
// ends stopped (`CEILING`) when it reaches it, also after a restart, and
// whoever steers it (`Offer`).
//
// A stop whose end could not be written (the read of the running turn, or
// the end's write, failed) keeps a lost end: the stop's reason, with a
// diagnostic of the cause. The loop is idle then, so a host can unload the
// chat, and the next launch goes on with the turn that still runs. `ready`
// first writes a lost end (the turn read again, ended as stopped with its
// note and its `end`), so the stopped turn's `end` comes before the offer's
// message and `start`; a read that finds no running turn forgets it. If
// that read or write fails again, `ready` fails with its error, asks no
// source, writes nothing more, and the lost end waits for the next `ready`.
//
// A turn's request
//
// Its first item is: the chat's view up to the first message that goes
// whole, then the new messages whole, in one block that starts with the
// header of the kind of the turn's first message (`HEADS`); a message of
// another kind is given as `<kind>: <text>`. The turn waits until every message
// before that point has its leaf. Then each step adds what the model gave
// back, the results of its programs, and any message that steered it. The
// items are kept as sent (table `turn_item`), so a later step, and a step
// after a restart, sends the same bytes and reads the vendor's cache.
//
// What each event writes, each in one transaction (docs/schema.html,
// section 9):
//
//   a message, and no turn runs    msg, turn (running)
//   a source's offer               msg, turn (running), the source's row
//   the first request is built     turn_item 0, chat.taken
//   a model step ends              turn_item (turn), msg asst, usage
//   a program starts               call (running)
//   a program ends                 call (done or failed), msg tool and echo,
//                                  a note for each call of it that waits
//                                  for a person's answer, and a note for
//                                  each wake-up that a call of it made or
//                                  stopped
//   all results of a step are in   turn_item (back)
//   messages steer the turn        turn_item (user), chat.taken
//   a turn ends                    turn (done, stopped or failed), and a
//                                  note when it did not end well
//   a note from outside a turn     msg note (`note`), and its own
//                                  `write` (the approval's row)
//
// Two notes that approval needs. After each program, in the transaction of
// its `tool` and `echo` and after them, one note for each call that it left
// waiting for a person's yes or no (`store.approvalsOf`, in the order of
// their numbers; `waits` in functions.ts says the text): the log keeps for
// ever that a call waits, and the person sees it. A program with no such
// call logs what it did before, with one more read. Then, in the same
// transaction, one note for each wake-up that a call of the program made or
// stopped (`store.wakesOf`, in the order of those calls; `wakeNote` in
// functions.ts says the text), so the person sees what the model did, and
// a cut program's restart gives them too: one more read at each program's
// end, in every stack. And `note`: a note
// from outside a turn (a no, an expiry), logged with its `message` event
// under the loop's lock, whether a turn runs or not, and with its caller's
// `write` (which marks the approval's row as told) in the same transaction,
// after its pages and their events, as a source's `write` in an offer's: a
// failed `write` logs no page of the note and no event. It starts no turn
// and steers none: the model reads it in the view of a later request.
//
// A restart (section 8): each call that still runs is closed as cut, with a
// `tool` and an `echo` that say so. Then the turn that still runs goes on
// from its items: it builds its first item if it has none, it finishes a
// step whose results are not all in, and it sends the next step.
//
// The events of a chat
//
// Each event but a piece (`accepted`, `start`, `call`, `message`, `end`) has
// its row of `everchat_event` and its number `n`, in the transaction of what
// it reports (`store.addEvent`): `accepted` and the turn's `start`, when no
// turn runs, in the one of the person's message; each page's `message` in the
// one that logs it; `call` with the call's row; a turn's `end` after its
// note's `message`, with the turn's end; the `start` of the turn that a
// waiting message starts, with that turn's row; a `start` after a restart in
// one of its own. A piece (`text`, `thought`, `program`) has no number and no
// row. No event: a function's start and end, a compaction, the pick, the
// goal, the draft.
//
// A listener gets a chat's events in the order of their numbers. The lock
// `order` covers each event's write and its publish, and nothing can
// interrupt it between the two. The locks are always taken in one order:
// the turn loop's `lock` (the person's message, the next turn of a waiting
// message), then `order`, then the memory's own (inside `pushWith`). No one
// holds a later one and waits for an earlier one, so they cannot deadlock.
// A `say` waits for a stopped turn's end while it holds the loop's `lock`:
// that end (the stop's finalizer, on the turn's own fiber, after the
// fiber's wait for `lock`, if any, was cut and let it go) takes `order`
// and the memory's lock, never the loop's `lock`; no holder of `order` or
// of the memory's lock waits for `lock`, and the end waits for no fiber
// that does, so it ends, and the signal comes in its `ensuring`.
// Each wait for a lock can be interrupted, the memory's too (but in a part
// that cannot be, as a stopped turn's end in its handler): a write through
// the memory (a message's log, the person's message) waits for it under
// `order`, and a cut wait writes and publishes nothing and takes no
// number. Once the memory's lock is taken, its write, the publish of its
// events and what comes next (the launch of a turn) are the memory's one
// step (`pushWith`'s `then`), which nothing interrupts. A write that does
// not pass through the memory takes `order` alone (`record`).
//
// The program's own stop (the scope closes) leaves the turn running in the
// database: it is cut, and it goes on at the next launch. Only `stop`, the
// person's own, ends a turn as stopped.
//
// A program's result
//
// The sandbox runs a program and gives its whole result (sandbox.ts). The
// database keeps it whole, in the program's call. The model is shown at
// most the output limit (limit.ts), and the `echo` message is what the
// model was shown, so the memory holds what the model saw.
//
// A program that was cut, or that the person stopped, has no result. Its
// `echo` then lists the functions that it called: which ended, and which
// one was cut. The model reads that list, and decides what to do again.
//
// Not here yet: agents, hooks, and images.

import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, PubSub, Schema, Scope, Semaphore, Stream } from "effect"
import { Ask } from "./ask.ts"
import { waits, wakeNote } from "./functions.ts"
import { TOOL } from "./head.ts"
import { Limit } from "./limit.ts"
import { Memory, type Said } from "./memory.ts"
import type { Call, Head, Item, Reply, Result } from "./request.ts"
import { Sandbox } from "./sandbox.ts"
import { type Call as CallRow, type Event, type Kind, type Message, SENDER_KEY, Store, StoreError, type Turn } from "./store.ts"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "turn")

// The start of the block with the person's new message, after the view.
export const HEAD = "Turn: the user's new message:\n\n"

// The start of the block of a turn that the result of a call that ran
// after a person's yes starts (the kind `late`).
export const LATE = "Turn: a call that waited for approval has run:\n\n"

// The start of the block of a turn that a wake-up starts (the kind `wake`).
export const WAKE = "Turn: a wake-up fired:\n\n"

// The kinds of message that a turn's first item takes in, each with the
// header of a block that a message of that kind starts. A source may offer
// each of them but `user` and `work` (`Offer`).
export const HEADS = { user: HEAD, work: HEAD, late: LATE, wake: WAKE } as const satisfies Partial<Record<Kind, string>>

// The kinds that `HEADS` has, in its order.
const TAKEN: ReadonlyArray<Kind> = Object.keys(HEADS) as Array<keyof typeof HEADS>

// What a call's result says when the program stopped while it ran.
export const CUT = "The program was cut when EverChat stopped. It may or may not have finished."

// What a function's result says in that case.
export const CUT_FUNCTION = "The function was cut when EverChat stopped. It may or may not have finished."

// What it says when the person stopped the turn while it ran.
export const STOPPED = "The program was stopped. It may or may not have finished."

// The most characters of a function's arguments, and of its result, in the
// list of a cut program's functions.
const BRIEF = 300

const brief = (text: string): string => (text.length <= BRIEF ? text : text.slice(0, BRIEF) + "... (" + text.length + " characters)")

// What a cut program's `echo` says: why it has no result, then the
// functions that it called, in order.
export const cutText = (why: string, functions: ReadonlyArray<CallRow>): string => {
  if (functions.length === 0) {
    return why + "\nIt called no function."
  }
  const lines = functions.map((row) => {
    const head = "- call " + row.id + ", " + row.fn + "(" + brief(row.input.slice(1, -1)) + ")"
    return row.status === "cut" || row.status === "running"
      ? head + " was cut: it may or may not have finished."
      : head + " " + (row.status === "done" ? "ended" : row.status) + ": " + brief(row.output ?? "")
  })
  return why + "\nThe functions that it called (result(id) gives a whole result):\n" + lines.join("\n")
}

// What the terminal shows as it happens: the events (store.ts, `Event`),
// each with its event number in its chat, the `n` of its row, and the
// pieces, which have none.
export type TurnEvent =
  | Event
  | { readonly type: "text" | "thought" | "program"; readonly turn: number; readonly delta: string }

// A turn's items as they are kept. A `turn` item also keeps the calls that
// the wire read from the vendor's output, so that a restart does not have
// to read a vendor's format again.
export const Kept = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), blocks: Schema.Array(Schema.Struct({ text: Schema.String, mark: Schema.Boolean })) }),
  Schema.Struct({
    kind: Schema.Literal("turn"),
    output: Schema.Array(Schema.Unknown),
    calls: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, input: Schema.String }))
  }),
  Schema.Struct({ kind: Schema.Literal("back"), results: Schema.Array(Schema.Struct({ id: Schema.String, output: Schema.String })) })
])
export type Kept = typeof Kept.Type

const KeptHead = Schema.fromJsonString(Schema.Struct({
  system: Schema.String,
  tools: Schema.Array(Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
  }))
}))

// A turn item's body, and a turn's head, from their JSON in the database.
export const decodeKept = Schema.decodeUnknownEffect(Schema.fromJsonString(Kept))
export const decodeHead = Schema.decodeUnknownEffect(KeptHead)

// A kept item as it goes into a request.
export const item = (kept: Kept): Item =>
  kept.kind === "turn" ? { kind: "turn", output: kept.output } : kept.kind === "user" ? { kind: "user", blocks: kept.blocks } : { kind: "back", results: kept.results }

// What `say` gives: the message's pages, the number of its `accepted`
// event, and whether its key was the key of a message logged before (then
// both are that message's, and nothing was written).
export interface Sent {
  readonly messages: ReadonlyArray<Message>
  readonly accepted: number
  readonly repeat: boolean
}

// The most characters (UTF-16 units) of a turn's `why` that the loop
// keeps: a longer one is cut, never inside a pair of surrogates.
export const WHY = 2000

// A `why` as the loop keeps it: well-formed, and at most WHY characters.
export const whyOf = (given: string): string => {
  const why = given.toWellFormed()
  if (why.length <= WHY) return why
  // A well-formed text has a high surrogate only before its low one.
  const code = why.charCodeAt(WHY - 1)
  return why.slice(0, code >= 0xd800 && code <= 0xdbff ? WHY - 1 : WHY)
}

// The `why` of a turn that reached its ceiling (`Offer`), and its note. It
// names no number: the numbers are the source's.
export const CEILING = "Stopped: this wake-up's turn reached its ceiling of steps or tokens."

// The largest capacity of the hub: a bounded hub allocates its whole capacity when it is made.
const LARGEST = 65_536

export interface Options {
  // The head of the chat (head.ts, `head`): the stack makes it one time, at
  // the load, from the functions of the sandbox, in their order, and gives
  // the same value to the compactor. A new turn stores it in its row; a
  // turn keeps the head of its row across a restart.
  readonly head: Head
  // The hub's capacity in events, for a listener that may fall behind: with
  // it, a full hub drops its oldest event (`PubSub.sliding`), so a turn
  // never waits for a listener; with none, the hub keeps every event. A
  // whole number from 1 to 65,536; another value is a defect of the
  // layer.
  readonly hub?: number | undefined
}

// A message that a source outside a turn gives: its kind (a key of
// `HEADS` but `user` and `work`; another is a defect), its text, and the
// source's own write, which marks its row. `write` runs in the transaction
// that logs the message and starts its turn, with the message's first page
// and that turn. A failed `write` fails that transaction, and stops the
// memory for the launch (memory.ts, `pushWith`). The turn's first item
// takes the message in with the person's messages that wait before it
// (after a failed turn), in their order, under the header of its kind.
// `ceiling`: the most steps and tokens that the turn may use, both whole
// numbers over 0 (another is a defect), written on the turn's row with it;
// none: the turn has none, as a person's turn. A turn with a ceiling counts,
// before each request, its steps (its items of the kind `turn`) and its
// tokens (`input + cacheRead + cacheWrite + output` of its usage rows, read
// from the store each time, after a restart too); at either one it ends
// `stopped` with the why `CEILING`, and the loop goes on as after a done
// turn. A person's message that it takes or that steers it runs under it;
// at its ceiling it takes no steer: a message that comes during its last
// step waits, and starts the person's turn after the turn's end.
export interface Offer {
  readonly kind: Kind
  readonly text: string
  readonly write: (first: Message, turn: Turn) => Effect.Effect<void, StoreError>
  readonly ceiling?: { readonly steps: number; readonly tokens: number } | undefined
}

// The seam of a message from outside a turn. `next` gives what the source
// has now, or null; it decides before it returns, and is asked only under
// the loop's lock with no turn running, also while a message of the person
// waits after a failed turn (its turn takes that message in). The turn loop
// reads it at its build, if it is there (`Effect.serviceOption`). A host with
// more than one source gives one: `Source.inOrder`.
export class Source extends Context.Service<Source, {
  readonly next: Effect.Effect<Offer | null, StoreError>
}>()("everchat/turn/Source") {
  // Several sources as one, asked in the order given. Each layer is built
  // in the scope of the layer that this gives, in that order, and with the
  // one memo map of that build, as the members of `Layer.mergeAll` are: a
  // layer that two sources share, or that a source shares with the rest of
  // the stack, is built one time, and its finalizers run one time, when
  // that scope closes. Its `next` asks each
  // source's `next` in turn and gives the first offer that is not null; the
  // sources after it are not asked. A `next` that fails fails it, and the
  // sources after that one are not asked. With no source it gives null. The
  // layer keeps the errors and the needs of the layers given.
  static readonly inOrder = <const Layers extends ReadonlyArray<Layer.Layer<Source, unknown, unknown>>>(
    ...sources: Layers
  ): Layer.Layer<Source, Layer.Error<Layers[number]>, Layer.Services<Layers[number]>> =>
    Layer.fromBuildMemo((memoMap, scope) =>
      Effect.gen(function*() {
        // Each layer is one of these: the types of its own error and needs
        // are parts of the unions that the layer given keeps.
        const layers = sources as ReadonlyArray<Layer.Layer<Source, Layer.Error<Layers[number]>, Layer.Services<Layers[number]>>>
        const each: Array<Source["Service"]> = []
        for (const layer of layers) {
          each.push(Context.get(yield* Layer.buildWithMemoMap(layer, memoMap, scope), Source))
        }
        return Context.make(
          Source,
          Source.of({
            next: Effect.gen(function*() {
              for (const one of each) {
                const offered = yield* one.next
                if (offered !== null) {
                  return offered
                }
              }
              return null
            })
          })
        )
      })
    )
}

export class Turns extends Context.Service<Turns, {
  // The person says something. It returns when the message is in the log.
  // While a stopped turn's end is not yet written, it waits for that end
  // first, then starts its turn after it (the head comment).
  // `key`: its sender's key (the head comment). `told`: run with the `Sent`
  // that `say` gives. For a new message it runs in the step that nothing
  // interrupts, after the commit, the publish and the launch of the turn,
  // so a caller that interrupts `say` still learns of a message that is in
  // the log; for a key that the chat has, before `say` returns. A `say`
  // that fails, or whose wait is cut, never runs it. It must not call
  // `Turns` or the memory: their locks are held, so it would wait for
  // itself.
  say(text: string, key?: string | null, told?: (sent: Sent) => Effect.Effect<void>): Effect.Effect<Sent, StoreError>
  // The person stops the turn that runs.
  stop(why?: string): Effect.Effect<void>
  // A note from outside a turn (a no, an expiry), with its `message`
  // event, under the loop's lock: it gives the note's first page. `write`,
  // if given, runs with that first page in the note's one transaction,
  // after its pages and their events (as a source's `write` in an offer's):
  // when it fails, the note fails whole, with no page and no event written,
  // and the memory stops for the launch, as after every failed write. It
  // starts no turn and steers none. Not from inside the loop's lock (a
  // source's `write`): it would wait for itself.
  note(text: string, write?: (first: Message) => Effect.Effect<void, StoreError>): Effect.Effect<Message, StoreError>
  // The source (`Source`) has something: with no turn running, its offer
  // is logged and starts its turn. While a turn runs it does nothing: that
  // turn's end asks the source. With no source, it does nothing. A stopped
  // turn's end that the stop could not write is written first; if that
  // fails, `ready` fails with its error and asks no source (the head
  // comment).
  readonly ready: Effect.Effect<void, StoreError>
  // Waits until no turn runs: until `busy` is false, a stopped turn's end
  // written too.
  readonly idle: Effect.Effect<void>
  // True while a turn runs (a request, a call, its end, a stopped turn's
  // end not yet written), with no wait.
  readonly busy: Effect.Effect<boolean>
  // When the loop was last busy, in milliseconds of Effect's `Clock`: now
  // while a turn runs, else when the last one ended, else when the layer
  // started.
  readonly worked: Effect.Effect<number>
  // What happens, as it happens.
  readonly events: Stream.Stream<TurnEvent>
  // The same, for a listener that must miss nothing from a known moment on:
  // the subscription is made when this effect ends, not when a stream starts.
  readonly subscribe: Effect.Effect<PubSub.Subscription<TurnEvent>, never, Scope.Scope>
}>()("everchat/turn/Turns") {
  static readonly layer = (options: Options) =>
    Layer.effect(
      Turns,
      Effect.gen(function*() {
        const store = yield* Store
        const memory = yield* Memory
        const ask = yield* Ask
        const sandbox = yield* Sandbox
        const limit = yield* Limit
        const source = Option.getOrNull(yield* Effect.serviceOption(Source))
        const scope = yield* Effect.scope
        // The turns' fibers run in a scope of their own, a child of the
        // layer's. The layer's close closes it and cuts the memory's
        // compactions at one time (`Memory.cut`; the finalizer at the end of
        // the build).
        const turns = yield* Scope.fork(scope, "sequential")
        const lock = yield* Semaphore.make(1)
        const capacity = options.hub
        if (capacity !== undefined && !(Number.isInteger(capacity) && capacity >= 1 && capacity <= LARGEST)) {
          return yield* Effect.die(new RangeError("The option `hub` of the turn loop must be a whole number from 1 to " + LARGEST + ", not " + String(capacity) + "."))
        }
        const hub = yield* (capacity === undefined ? PubSub.unbounded<TurnEvent>() : PubSub.sliding<TurnEvent>(capacity))
        const emit = (event: TurnEvent) => Effect.asVoid(PubSub.publish(hub, event))
        const order = yield* Semaphore.make(1)
        const session = (yield* store.chat).uuid

        // The turn that runs, its fiber, and why the person stopped it.
        let running: { turn: number; fiber: Fiber.Fiber<void> | null; stop: string | null } | null = null
        // True while a stopped turn's end is written, after `running` is
        // null; and the signal of that end, done when it is written or has
        // failed (the stop's `ensuring`): `say` and `idle` wait for it.
        let ending = false
        let ends: Deferred.Deferred<void> | null = null
        // The reason of a stop whose end could not be written: `ready`
        // writes it before it asks the source (the head comment).
        let lost: string | null = null
        const clock = yield* Clock.Clock
        // When the last turn ended; the layer's start before any.
        let rested = clock.currentTimeMillisUnsafe()
        // No turn runs from now on.
        const rest = () => {
          running = null
          rested = clock.currentTimeMillisUnsafe()
        }

        const broken = (op: string) => (cause: unknown) => new StoreError({ op, cause })

        // An event's write and its publish, under `order`, with no
        // interruption between the commit and the publish (the head comment).
        // `write` commits the rows, and gives its result and the events, in
        // the order of their numbers. `next` runs after the publish, in the
        // same step that nothing interrupts.
        const record = <A>(
          write: Effect.Effect<readonly [A, ReadonlyArray<TurnEvent>], StoreError>,
          next: (result: A) => Effect.Effect<void> = () => Effect.void
        ): Effect.Effect<A, StoreError> =>
          order.withPermits(1)(Effect.uninterruptible(Effect.gen(function*() {
            const [result, events] = yield* write
            for (const event of events) {
              yield* emit(event)
            }
            yield* next(result)
            return result
          })))

        // The same for a write through the memory (`pushWith`): under
        // `order`, the wait for the memory's lock can be interrupted, and
        // nothing is written then; the write, the publish and `next` are the
        // memory's one step (memory.ts, `apply`), so nothing interrupts them
        // between the commit and the publish.
        const recordPush = <B, A>(
          said: ReadonlyArray<Said>,
          also: (written: Array<Message>) => Effect.Effect<B, StoreError>,
          key: string | null,
          shape: (written: Array<Message>, more: B) => readonly [A, ReadonlyArray<TurnEvent>],
          next: (result: A) => Effect.Effect<void> = () => Effect.void
        ): Effect.Effect<A, StoreError> =>
          order.withPermits(1)(Effect.suspend(() => {
            let out: { readonly result: A } | null = null
            return Effect.map(
              memory.pushWith(said, also, key, (written, more) =>
                Effect.gen(function*() {
                  const [result, events] = shape(written, more)
                  out = { result }
                  for (const event of events) {
                    yield* emit(event)
                  }
                  yield* next(result)
                })),
              () => out!.result
            )
          }))

        // Messages in the log, each page with its `message` row, then more
        // writes of the same event, in one transaction. `then` gives the
        // events that come after the messages' (a turn's `end`).
        const log = <B>(said: ReadonlyArray<Said>, also: Effect.Effect<B, StoreError>, then: (more: B) => ReadonlyArray<TurnEvent> = () => []) =>
          recordPush(
            said,
            (written) =>
              Effect.gen(function*() {
                const numbers = yield* Effect.forEach(written, (message) => store.addEvent({ type: "message", msg: message.i, msgLast: message.i }))
                return [numbers, yield* also] as const
              }),
            null,
            (written, [numbers, more]) =>
              [more, [...written.map((message, k): TurnEvent => ({ type: "message", n: numbers[k]!, message })), ...then(more)]] as const
          )

        // The messages that no request has taken in: the person's and the agents' reports.
        const waiting = Effect.flatMap(store.chat, (chat) => store.messagesAfter(chat.taken, ["user", "work"]))

        // The pages of each message as one text, from page `from` on.
        const texts = (messages: ReadonlyArray<Message>, from: number): Array<string> => {
          const out: Array<string> = []
          let text = ""
          for (const message of messages) {
            if (message.i >= from) text += message.text
            if (!message.more) {
              if (text !== "") out.push(text)
              text = ""
            }
          }
          if (text !== "") out.push(text)
          return out
        }

        const keep = (turn: number, kept: Kept) => store.addTurnItem(turn, kept.kind, JSON.stringify(kept))

        // The pages of each message as one text with its kind, from page
        // `from` on.
        const parts = (messages: ReadonlyArray<Message>, from: number): Array<{ readonly kind: Kind; readonly text: string }> => {
          const out: Array<{ readonly kind: Kind; readonly text: string }> = []
          let text = ""
          for (const message of messages) {
            if (message.i >= from) text += message.text
            if (!message.more) {
              if (text !== "") out.push({ kind: message.kind, text })
              text = ""
            }
          }
          const last = messages[messages.length - 1]
          if (text !== "" && last !== undefined) out.push({ kind: last.kind, text })
          return out
        }

        // A turn's first item: the view, then the new messages whole, of
        // the kinds of `HEADS`, under the header of the kind of the turn's
        // first message; a message of another kind says its kind.
        const first = Effect.fnUntraced(function*(turn: Turn) {
          const messages = yield* Effect.flatMap(store.chat, (chat) => store.messagesAfter(chat.taken, TAKEN))
          const start = messages[0]?.i ?? turn.firstMsg
          // The messages from `from` on go whole. Every message before it
          // must have its leaf, and a message that comes meanwhile can move it.
          let from = -1
          for (let next = yield* memory.whole(start); next !== from; next = yield* memory.whole(start)) {
            from = next
            yield* memory.settle(from)
          }
          const own = messages.find((message) => message.i === turn.firstMsg) ?? (yield* store.messages(turn.firstMsg, turn.firstMsg + 1))[0]
          const kind = own?.kind ?? "user"
          const header = (HEADS as Partial<Record<Kind, string>>)[kind] ?? HEAD
          const text = parts(messages.length === 0 ? yield* store.messages(turn.firstMsg, turn.firstMsg + 1) : messages, from)
            .map((one) => (one.kind === kind ? one.text : one.kind + ": " + one.text))
            .join("\n\n")
          const kept: Kept = { kind: "user", blocks: [...(yield* memory.view(from)), { text: header + text, mark: true }] }
          const last = messages[messages.length - 1]?.i ?? turn.firstMsg
          yield* store.transaction(Effect.andThen(keep(turn.id, kept), store.setTaken(last)))
          return kept
        })

        // A turn's ceiling, from its row: its steps (its items of the kind
        // `turn`) and its tokens (the sum over its usage rows, read from the
        // store each time, so the same after a restart). True: it reached
        // either one. It only reads; the one test of the ceiling, for a
        // request (`reached`) and for a steer (`steer`). A turn with none
        // pays nothing: no read of the store; the tokens are read only when
        // the steps are under theirs.
        const atCeiling = Effect.fnUntraced(function*(turn: Turn, items: ReadonlyArray<Kept>) {
          if (turn.steps === null || turn.tokens === null) {
            return false
          }
          const steps = items.filter((one) => one.kind === "turn").length
          if (steps >= turn.steps) {
            return true
          }
          // Each of its steps adds at most one row: no limit cuts the sum.
          const used = yield* store.usage({ turn: turn.id, limit: Number.MAX_SAFE_INTEGER })
          const tokens = used.reduce((sum, row) => sum + row.input + row.cacheRead + row.cacheWrite + row.output, 0)
          return tokens >= turn.tokens
        })

        // The messages that came while the turn ran: it takes them in. Not
        // at its ceiling (`atCeiling`, tested only when a message waits):
        // there it takes no steer, so the messages wait, `taken` stays, and
        // after the turn's end they start the person's turn.
        const steer = Effect.fnUntraced(function*(turn: Turn, items: ReadonlyArray<Kept>) {
          const messages = yield* waiting
          const last = messages[messages.length - 1]
          if (last === undefined || (yield* atCeiling(turn, items))) {
            return null
          }
          const kept: Kept = { kind: "user", blocks: texts(messages, 0).map((text) => ({ text, mark: false })) }
          yield* store.transaction(Effect.andThen(keep(turn.id, kept), store.setTaken(last.i)))
          return kept
        })

        // A turn ends. One that did not end well leaves a note in the log.
        // `why` is made well-formed and cut to WHY characters once
        // (`whyOf`), so that the row, the event and the note hold the same
        // text (the store makes it well-formed too).
        const end = Effect.fnUntraced(function*(turn: Turn, status: "done" | "stopped" | "failed", given: string | null) {
          const why = given === null ? null : whyOf(given)
          const note = status === "failed"
            ? "No reply: " + (why ?? "it failed").replace(/\.$/, "") + ". Send a message to try again."
            : status === "stopped"
            ? why ?? "Stopped."
            : null
          yield* log(
            note === null ? [] : [{ kind: "note", text: note, turn: turn.id }],
            Effect.andThen(store.endTurn(turn.id, status, why), store.addEvent({ type: "end", turn: turn.id })),
            (n) => [{ type: "end", n, turn: turn.id, status, why }]
          )
        })

        // The functions that program `id` called.
        const functionsOf = (turn: number, id: number) => Effect.map(store.calls(turn), (rows) => rows.filter((row) => row.parent === id))

        // A program's end: its `tool` and `echo`, then a note for each call
        // of it that waits for a person's answer, then a note for each
        // wake-up that a call of it made or stopped, in the order of those
        // calls, each with its event, and `also`, in one transaction.
        const ended = (turn: number, id: number, input: string, echo: string, also: Effect.Effect<void, StoreError>) =>
          Effect.gen(function*() {
            const waiting = yield* store.approvalsOf(id)
            const wakes = yield* store.wakesOf(id)
            yield* log(
              [
                { kind: "tool", text: input, turn, call: id },
                { kind: "echo", text: echo, turn, call: id },
                ...waiting.map((approval) => ({ kind: "note" as const, text: waits(approval), turn, call: id })),
                ...wakes.map((of) => ({ kind: "note" as const, text: wakeNote(of), turn, call: id }))
              ],
              also
            )
          })

        // One program of the model: its call is written when it starts, and
        // its `tool` and `echo` when it ends. The row and the event hold the
        // program made well-formed once, the same text; the sandbox runs it as
        // the model gave it.
        const program = Effect.fnUntraced(function*(turn: Turn, call: Call) {
          const shown = call.input.toWellFormed()
          const id = yield* record(store.transaction(Effect.gen(function*() {
            const id = yield* store.startCall({ turn: turn.id, vendorId: call.id, fn: call.name, input: shown })
            const n = yield* store.addEvent({ type: "call", turn: turn.id, call: id })
            return [id, [{ type: "call", n, turn: turn.id, call: id, program: shown }]] as const
          })))
          const close = (status: "done" | "failed" | "cut", output: string, text: string, bytes?: number) =>
            ended(turn.id, id, call.input, text, store.endCall(id, { status, output, shown: bytes }))
          // The person stopped the turn: the call is closed, with the list
          // of its functions. The sandbox has closed those by then. The
          // program's own stop leaves the call running, for the next launch
          // to close.
          const stopped = Effect.gen(function*() {
            if (running === null || running.stop === null) {
              return
            }
            const text = (yield* limit.show(id, cutText(STOPPED, yield* functionsOf(turn.id, id)))).text
            yield* close("cut", text, text)
          })
          const result = call.name === TOOL
            ? yield* sandbox.run(call.input, { turn: turn.id, call: id }).pipe(Effect.onInterrupt(() => Effect.ignore(stopped)))
            : { output: `No tool "${call.name}": the one tool is "${TOOL}".`, failed: true }
          // A failed program's result is its error, as text: nothing marks it
          // apart from that. The call's status says that it failed.
          const seen = yield* limit.show(id, result.output)
          yield* close(result.failed ? "failed" : "done", result.output, seen.text, seen.shown)
          return { id: call.id, output: seen.text }
        })

        // After a model step: its programs run, their results are kept, and
        // waiting messages steer the turn. True: the turn is done.
        const after = Effect.fnUntraced(function*(turn: Turn, items: Array<Kept>, calls: ReadonlyArray<Call>) {
          const results: Array<Result> = []
          // After a restart, a program of this step may have ended already.
          const known = (yield* store.calls(turn.id)).filter((row) => row.parent === null)
          for (const call of calls) {
            const row = known.find((one) => one.vendorId === call.id)
            // A program that ended is shown as it was then. One that was
            // cut has its list of functions as its result.
            results.push(
              row === undefined
                ? yield* program(turn, call)
                : { id: call.id, output: row.status === "cut" ? row.output ?? "" : (yield* limit.show(row.id, row.output ?? "")).text }
            )
          }
          if (results.length > 0) {
            const back: Kept = { kind: "back", results }
            yield* keep(turn.id, back)
            items.push(back)
          }
          const steered = yield* steer(turn, items)
          if (steered !== null) {
            items.push(steered)
          }
          if (results.length === 0 && steered === null) {
            yield* end(turn, "done", null)
            return true
          }
          return false
        })

        // One request of the turn. Null: the turn failed, and is ended.
        const step = Effect.fnUntraced(function*(turn: Turn, head: Head, items: ReadonlyArray<Kept>) {
          let reply: Reply | null = null
          const asked = yield* Effect.result(Stream.runForEach(ask.stream({ session, pick: turn.pick, head, items: items.map(item) }), (event) => {
            if (event.type === "end") {
              reply = event.reply
              return Effect.void
            }
            return emit({ type: event.type, turn: turn.id, delta: event.delta })
          }))
          const got = reply as Reply | null
          if (asked._tag === "Failure" || got === null) {
            yield* end(turn, "failed", asked._tag === "Failure" ? asked.failure.message : "the model gave no reply")
            return null
          }
          const kept: Kept = { kind: "turn", output: [...got.output], calls: [...got.calls] }
          yield* log(
            got.text.trim() === "" ? [] : [{ kind: "asst", text: got.text, turn: turn.id }],
            Effect.gen(function*() {
              yield* keep(turn.id, kept)
              if (got.usage !== null) {
                yield* store.addUsage({ served: "turn", turn: turn.id, pick: got.pick, request: got.request, ...got.usage, expected: got.cache?.expected ?? null })
              }
            })
          )
          if (got.stop !== "done") {
            yield* end(turn, "failed", got.stop === "max" ? "the model reached the most tokens it may write" : "the vendor's content filter stopped the reply")
            return null
          }
          return kept
        })

        // Before each request: a turn at its ceiling (`atCeiling`) ends
        // stopped with `CEILING`, and true is given.
        const reached = Effect.fnUntraced(function*(turn: Turn, items: ReadonlyArray<Kept>) {
          const over = yield* atCeiling(turn, items)
          if (over) {
            yield* end(turn, "stopped", CEILING)
          }
          return over
        })

        // A turn, from where its items are, to its end. Its `start` is
        // written and published by what starts it. A turn that reaches its
        // ceiling (`reached`) ends stopped, and gives "done": the loop goes
        // on as after a done turn.
        const run = Effect.fnUntraced(function*(turn: Turn) {
          const head = yield* Effect.mapError(decodeHead(turn.head), broken("head"))
          const items: Array<Kept> = []
          for (const row of yield* store.turnItems(turn.id)) {
            items.push(yield* Effect.mapError(decodeKept(row.body), broken("turnItem")))
          }
          if (items.length === 0) {
            items.push(yield* first(turn))
          }
          // A step that a restart found with its results not all in.
          const last = items[items.length - 1]
          if (last !== undefined && last.kind === "turn" && (yield* after(turn, items, last.calls))) {
            return "done" as const
          }
          for (;;) {
            if (yield* reached(turn, items)) {
              return "done" as const
            }
            const kept = yield* step(turn, head, items)
            if (kept === null || kept.kind !== "turn") {
              return "failed" as const
            }
            items.push(kept)
            if (yield* after(turn, items, kept.calls)) {
              return "done" as const
            }
          }
        })

        // A new turn's row and its `start` row, in the caller's transaction,
        // with an offer's ceiling, if any.
        const begin = (firstMsg: number, ceiling?: Offer["ceiling"]) =>
          Effect.gen(function*() {
            const chat = yield* store.chat
            const pick = store.launch.pick ?? chat.pick
            const head = JSON.stringify(options.head)
            const turn = yield* store.startTurn(
              ceiling === undefined ? { pick, head, firstMsg } : { pick, head, firstMsg, steps: ceiling.steps, tokens: ceiling.tokens }
            )
            return { turn, n: yield* store.addEvent({ type: "start", turn: turn.id }) }
          })
        const started = (begun: { readonly turn: Turn; readonly n: number }): TurnEvent => ({ type: "start", n: begun.n, turn: begun.turn.id })

        // The source's offer, under the loop's `lock`, with no turn running:
        // nothing with no source, or with nothing offered (null). Else, in
        // one transaction, the offer's message (its pages and their `message`
        // events), the new turn and its `start`, and the source's `write`;
        // then `next` with the turn, in the step that nothing interrupts
        // after the commit and the publish. A message of the person that
        // waits (after a failed turn) does not hold it back: the new turn's
        // first item takes that message in before the offer's (`first`).
        const offer = (next: (turn: Turn) => Effect.Effect<void> = () => Effect.void): Effect.Effect<Turn | null, StoreError> =>
          Effect.gen(function*() {
            if (source === null) {
              return null
            }
            const offered = yield* source.next
            if (offered === null) {
              return null
            }
            if (!Object.hasOwn(HEADS, offered.kind) || offered.kind === "user" || offered.kind === "work") {
              return yield* Effect.die(new Error("a source offered a message of the kind " + offered.kind + ", which no source may offer"))
            }
            // A ceiling the store would refuse: the source's defect, before
            // the push, so that it never fails the offer's transaction.
            const ceiling = offered.ceiling
            const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0
            if (ceiling !== undefined && !(typeof ceiling === "object" && ceiling !== null && whole(ceiling.steps) && whole(ceiling.tokens))) {
              return yield* Effect.die(new Error("a source offered a ceiling that is not whole numbers of steps and tokens over 0"))
            }
            return yield* recordPush(
              [{ kind: offered.kind, text: offered.text }],
              (written) =>
                Effect.gen(function*() {
                  const first = written[0]
                  if (first === undefined) {
                    return yield* Effect.die(new Error("a source's message logged no page"))
                  }
                  const numbers = yield* Effect.forEach(written, (message) => store.addEvent({ type: "message", msg: message.i, msgLast: message.i }))
                  const begun = yield* begin(first.i, ceiling)
                  yield* offered.write(first, begun.turn)
                  return [numbers, begun] as const
                }),
              null,
              (written, [numbers, begun]) =>
                [
                  begun.turn,
                  [...written.map((message, k): TurnEvent => ({ type: "message", n: numbers[k]!, message })), started(begun)]
                ] as const,
              next
            )
          })

        // Turns, one after the other, while messages wait. After a turn that
        // failed, only the source's offer starts the next one (its turn takes
        // in a message of the person that waits); with nothing offered the
        // row ends: the person must speak again. A turn stopped at its
        // ceiling (`reached`) is as a done one here.
        const drive = (turn: Turn): Effect.Effect<void> =>
          Effect.gen(function*() {
            let current: Turn | null = turn
            while (current !== null) {
              running = { turn: current.id, fiber: running?.fiber ?? null, stop: null }
              const status: "done" | "failed" = yield* run(current)
              const following: Effect.Effect<Turn | null, StoreError> = Effect.gen(function*() {
                // A message that came too late for a done turn starts the next one.
                const next: Message | undefined = status === "done" ? (yield* waiting)[0] : undefined
                if (next === undefined) {
                  // After a done turn with no message of the person waiting,
                  // or after a failed turn, the source's offer starts the
                  // next turn.
                  const offered = source === null ? null : yield* offer()
                  if (offered === null) {
                    rest()
                  }
                  return offered
                }
                // Its turn and its `start`, in one transaction. The draft
                // stays: it is what the person typed after that message.
                return yield* record(Effect.map(store.transaction(begin(next.i)), (begun) => [begun.turn, [started(begun)]] as const))
              })
              current = yield* lock.withPermits(1)(following)
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function*() {
                const stopped = running
                ending = true
                ends = Deferred.makeUnsafe<void>()
                rest()
                // The program's own stop leaves the turn running, for the next launch.
                if (stopped === null || stopped.stop === null) {
                  return
                }
                const why = stopped.stop
                yield* Effect.gen(function*() {
                  const [turn] = yield* store.runningTurns(null)
                  if (turn !== undefined) {
                    yield* end(turn, "stopped", why)
                  }
                }).pipe(
                  // Kept: `ready` writes it before it asks the source.
                  Effect.catchCause((cause) =>
                    Effect.andThen(Effect.sync(() => (lost = why)), diagnostic(Effect.logError("the end of a stopped turn was not written", cause)))
                  )
                )
              }).pipe(
                Effect.ignore,
                Effect.ensuring(Effect.sync(() => {
                  ending = false
                  rested = clock.currentTimeMillisUnsafe()
                  if (ends !== null) {
                    Deferred.doneUnsafe(ends, Exit.void)
                    ends = null
                  }
                }))
              )
            ),
            Effect.catchCause((cause) =>
              Effect.gen(function*() {
                rest()
                yield* diagnostic(Effect.logError("the turn loop stopped", cause))
              })
            )
          )

        // A lost end (the head comment), written as the stop would have: the
        // running turn read again, ended as stopped with the kept reason; a
        // read that finds none forgets it. If the read or the write fails,
        // the error is the caller's, and the lost end stays. Under the loop's
        // `lock`, with no turn running and no end pending.
        const writeLost = Effect.gen(function*() {
          if (lost === null) {
            return
          }
          const why = lost
          const [turn] = yield* store.runningTurns(null)
          if (turn !== undefined) {
            yield* end(turn, "stopped", why)
          }
          lost = null
        })

        const launch = (turn: Turn) =>
          Effect.gen(function*() {
            running = { turn: turn.id, fiber: null, stop: null }
            const fiber = yield* Effect.forkIn(drive(turn), turns)
            if (running !== null) {
              running.fiber = fiber
            }
          })

        const say = (text: string, key?: string | null, told: (sent: Sent) => Effect.Effect<void> = () => Effect.void) =>
          lock.withPermits(1)(Effect.gen(function*() {
            // A key of another form: refused here, before the store and the
            // memory, with the error that the store's `append` gives for it;
            // the store keeps its own check for every other caller.
            if (key !== undefined && key !== null && !SENDER_KEY.test(key)) {
              return yield* new StoreError({ op: "append", cause: new Error("the sender's key is not 1 to 128 bytes of visible ASCII") })
            }
            // A key that the chat has: its first message, and nothing more.
            if (key !== undefined && key !== null) {
              const known = Option.getOrNull(yield* store.keyed(key))
              if (known !== null) {
                const sent: Sent = { messages: known.messages, accepted: known.accepted, repeat: true }
                yield* told(sent)
                return sent
              }
            }
            // A stopped turn whose end is not yet written: the message waits
            // for that end, as if it came just after it (the head comment),
            // then goes on as here. A cut wait writes nothing.
            while (ends !== null) {
              yield* Deferred.await(ends)
            }
            // With no turn running, a lost end first: if it fails, `say`
            // fails with its error and writes nothing.
            if (running === null) {
              yield* writeLost
            }
            const idle = running === null
            // Its pages with its key, their `accepted`, and, when no turn
            // runs, the clear of the draft (the draft was this message) and a
            // turn with its `start`, in one transaction. The turn's fiber
            // starts in the same step, then `told` runs: no interruption of
            // `say` leaves a turn running in the log with no fiber, or a
            // message in the log that `told` did not get.
            const [sent] = yield* recordPush(
              [{ kind: "user", text }],
              (written) =>
                Effect.gen(function*() {
                  const first = written[0]
                  const last = written[written.length - 1]
                  if (first === undefined || last === undefined) {
                    return yield* Effect.die(new Error("a message of the person logged no page"))
                  }
                  const accepted = yield* store.addEvent({ type: "accepted", msg: first.i, msgLast: last.i })
                  if (!idle) {
                    return [accepted, null] as const
                  }
                  yield* store.setDraft(null)
                  return [accepted, yield* begin(first.i)] as const
                }),
              key ?? null,
              (written, [accepted, begun]) =>
                [
                  [{ messages: written, accepted, repeat: false } satisfies Sent, begun?.turn ?? null] as const,
                  [{ type: "accepted", n: accepted, messages: written }, ...(begun === null ? [] : [started(begun)])]
                ] as const,
              ([sent, turn]) => Effect.andThen(turn === null ? Effect.void : launch(turn), told(sent))
            )
            return sent
          }))

        // A note from outside a turn: its pages, each with its `message`
        // event, then the caller's `write` with the first page, in one
        // transaction, under the lock.
        const note = (text: string, write?: (first: Message) => Effect.Effect<void, StoreError>): Effect.Effect<Message, StoreError> =>
          lock.withPermits(1)(recordPush(
            [{ kind: "note", text }],
            (written) =>
              Effect.gen(function*() {
                const first = written[0]
                if (first === undefined) {
                  return yield* Effect.die(new Error("a note logged no page"))
                }
                const numbers = yield* Effect.forEach(written, (message) => store.addEvent({ type: "message", msg: message.i, msgLast: message.i }))
                if (write !== undefined) yield* write(first)
                return numbers
              }),
            null,
            (written, numbers) => [written[0]!, written.map((message, k): TurnEvent => ({ type: "message", n: numbers[k]!, message }))] as const
          ))

        const stop = (why = "Stopped.") =>
          Effect.suspend(() => {
            if (running === null || running.fiber === null) {
              return Effect.void
            }
            running.stop = why
            return Fiber.interrupt(running.fiber)
          })

        // The source has something: with no turn running, its offer starts
        // a turn, as a person's message does (`say`). A stopped turn whose
        // end is not yet written still runs, as for `busy`: the source is
        // not asked then, and nothing is written. A stop takes no offer by
        // itself: the next `ready` does, or a later turn's end. A lost end
        // (the head comment) is written first, as the stop would have: if
        // its read or its write fails, `ready` fails, the source is not
        // asked, and the lost end stays.
        const ready: Effect.Effect<void, StoreError> = lock.withPermits(1)(Effect.suspend(() => {
          if (source === null || running !== null || ending) {
            return Effect.void
          }
          return Effect.gen(function*() {
            yield* writeLost
            yield* offer(launch)
          })
        }))

        // It waits for a turn's fiber, then for a stopped turn's end, until
        // `busy` is false.
        const idle: Effect.Effect<void> = Effect.suspend(() =>
          running !== null && running.fiber !== null
            ? Effect.andThen(Fiber.await(running.fiber), idle)
            : ends !== null
            ? Effect.andThen(Deferred.await(ends), idle)
            : Effect.void
        )

        const busy = Effect.sync(() => running !== null || ending)
        const worked = Effect.sync(() => (running !== null || ending ? clock.currentTimeMillisUnsafe() : rested))

        // A restart: close the calls that still run, then go on with the
        // turn that still runs.
        for (const turn of yield* store.runningTurns(null)) {
          const open = (yield* store.calls(turn.id)).filter((row) => row.status === "running")
          // The functions first, so that a program's list shows them as cut.
          for (const call of open.filter((row) => row.parent !== null)) {
            yield* store.endCall(call.id, { status: "cut", output: CUT_FUNCTION })
          }
          for (const call of open.filter((row) => row.parent === null)) {
            const text = (yield* limit.show(call.id, cutText(CUT, yield* functionsOf(turn.id, call.id)))).text
            yield* ended(turn.id, call.id, call.input, text, store.endCall(call.id, { status: "cut", output: text }))
          }
        }
        const [cut] = yield* store.runningTurns(null)
        if (cut !== undefined) {
          yield* diagnostic(Effect.logInfo(`turn ${cut.id} was cut, and continues`))
          // Its `start`, in a transaction of its own.
          yield* record(Effect.map(store.addEvent({ type: "start", turn: cut.id }), (n) => [undefined, [{ type: "start", n, turn: cut.id }]] as const))
          yield* launch(cut)
        }

        // The close: the first thing that the layer's close does (added last,
        // it runs before the close of `turns` that `Scope.fork` registered,
        // the only other finalizer of the layer's scope). It cuts the turn
        // and the queued compaction writes at one time: a compaction's write
        // that waits for the memory's lock is cut as the close begins, not
        // after the turn's call in flight.
        yield* Effect.addFinalizer(() => Effect.all([memory.cut, Scope.close(turns, Exit.void)], { concurrency: 2, discard: true }))

        return Turns.of({ say, stop, note, ready, idle, busy, worked, events: Stream.fromPubSub(hub), subscribe: PubSub.subscribe(hub) })
      })
    )
}
