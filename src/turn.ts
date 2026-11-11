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
// - If no turn runs, a turn starts in the same transaction.
// - If a turn runs, the message steers it: the turn takes it in after the
//   results of its present step. A message that comes too late for the turn
//   starts the next turn.
//
// A turn's request
//
// Its first item is: the chat's view up to the first message that goes
// whole, then the new messages whole. The turn waits until every message
// before that point has its leaf. Then each step adds what the model gave
// back, the results of its programs, and any message that steered it. The
// items are kept as sent (table `turn_item`), so a later step, and a step
// after a restart, sends the same bytes and reads the vendor's cache.
//
// What each event writes, each in one transaction (docs/schema.html,
// section 7):
//
//   a message, and no turn runs    msg, turn (running)
//   the first request is built     turn_item 0, chat.taken
//   a model step ends              turn_item (turn), msg asst, usage
//   a program starts               call (running)
//   a program ends                 call (done or failed), msg tool and echo
//   all results of a step are in   turn_item (back)
//   messages steer the turn        turn_item (user), chat.taken
//   a turn ends                    turn (done, stopped or failed), and a
//                                  note when it did not end well
//
// A restart (section 8): each call that still runs is closed as cut, with a
// `tool` and an `echo` that say so. Then the turn that still runs goes on
// from its items: it builds its first item if it has none, it finishes a
// step whose results are not all in, and it sends the next step.
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

import { Context, Effect, Fiber, Layer, PubSub, Schema, type Scope, Semaphore, Stream } from "effect"
import { Ask } from "./ask.ts"
import { head as makeHead, TOOL } from "./head.ts"
import { Limit } from "./limit.ts"
import { Memory, type Said } from "./memory.ts"
import type { Call, Head, Item, Reply, Result } from "./request.ts"
import { Sandbox } from "./sandbox.ts"
import { type Call as CallRow, type Message, Store, StoreError, type Turn } from "./store.ts"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "turn")

// The start of the block with the person's new message, after the view.
export const HEAD = "Turn: the user's new message:\n\n"

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

// What the terminal shows as it happens.
export type TurnEvent =
  | { readonly type: "accepted"; readonly messages: ReadonlyArray<Message> } // a message of the person is in the log
  | { readonly type: "start"; readonly turn: number }
  | { readonly type: "text" | "thought" | "program"; readonly turn: number; readonly delta: string }
  | { readonly type: "call"; readonly turn: number; readonly call: number; readonly program: string } // a program starts to run
  | { readonly type: "message"; readonly message: Message } // a reply, a program, a result, or a note is in the log
  | { readonly type: "end"; readonly turn: number; readonly status: "done" | "stopped" | "failed"; readonly why: string | null }

// A turn's items as they are kept. A `turn` item also keeps the calls that
// the wire read from the vendor's output, so that a restart does not have
// to read a vendor's format again.
const Kept = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), blocks: Schema.Array(Schema.Struct({ text: Schema.String, mark: Schema.Boolean })) }),
  Schema.Struct({
    kind: Schema.Literal("turn"),
    output: Schema.Array(Schema.Unknown),
    calls: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, input: Schema.String }))
  }),
  Schema.Struct({ kind: Schema.Literal("back"), results: Schema.Array(Schema.Struct({ id: Schema.String, output: Schema.String })) })
])
type Kept = typeof Kept.Type

const KeptHead = Schema.fromJsonString(Schema.Struct({
  system: Schema.String,
  tools: Schema.Array(Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
  }))
}))

const decodeKept = Schema.decodeUnknownEffect(Schema.fromJsonString(Kept))
const decodeHead = Schema.decodeUnknownEffect(KeptHead)

const item = (kept: Kept): Item =>
  kept.kind === "turn" ? { kind: "turn", output: kept.output } : kept.kind === "user" ? { kind: "user", blocks: kept.blocks } : { kind: "back", results: kept.results }

export interface Options {
  readonly rules?: string | null | undefined // the person's own instructions, for the head
}

export class Turns extends Context.Service<Turns, {
  // The person says something. It returns when the message is in the log.
  say(text: string): Effect.Effect<Array<Message>, StoreError>
  // The person stops the turn that runs.
  stop(why?: string): Effect.Effect<void>
  // Waits until no turn runs.
  readonly idle: Effect.Effect<void>
  // What happens, as it happens.
  readonly events: Stream.Stream<TurnEvent>
  // The same, for a listener that must miss nothing from a known moment on:
  // the subscription is made when this effect ends, not when a stream starts.
  readonly subscribe: Effect.Effect<PubSub.Subscription<TurnEvent>, never, Scope.Scope>
}>()("everchat/turn/Turns") {
  static readonly layer = (options: Options = {}) =>
    Layer.effect(
      Turns,
      Effect.gen(function*() {
        const store = yield* Store
        const memory = yield* Memory
        const ask = yield* Ask
        const sandbox = yield* Sandbox
        const limit = yield* Limit
        const scope = yield* Effect.scope
        const lock = yield* Semaphore.make(1)
        const hub = yield* PubSub.unbounded<TurnEvent>()
        const emit = (event: TurnEvent) => Effect.asVoid(PubSub.publish(hub, event))
        const session = (yield* store.chat).uuid

        // The turn that runs, its fiber, and why the person stopped it.
        let running: { turn: number; fiber: Fiber.Fiber<void> | null; stop: string | null } | null = null

        const broken = (op: string) => (cause: unknown) => new StoreError({ op, cause })

        // Messages in the log, with more writes of the same event.
        const log = <B>(said: ReadonlyArray<Said>, also: Effect.Effect<B, StoreError>) =>
          Effect.gen(function*() {
            const [written, more] = yield* memory.pushWith(said, () => also)
            for (const message of written) {
              yield* emit({ type: "message", message })
            }
            return more
          })

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

        // A turn's first item: the view, then the new messages whole.
        const first = Effect.fnUntraced(function*(turn: Turn) {
          const messages = yield* waiting
          const start = messages[0]?.i ?? turn.firstMsg
          // The messages from `from` on go whole. Every message before it
          // must have its leaf, and a message that comes meanwhile can move it.
          let from = -1
          for (let next = yield* memory.whole(start); next !== from; next = yield* memory.whole(start)) {
            from = next
            yield* memory.settle(from)
          }
          const text = texts(messages.length === 0 ? yield* store.messages(turn.firstMsg, turn.firstMsg + 1) : messages, from).join("\n\n")
          const kept: Kept = { kind: "user", blocks: [...(yield* memory.view(from)), { text: HEAD + text, mark: true }] }
          const last = messages[messages.length - 1]?.i ?? turn.firstMsg
          yield* store.transaction(Effect.andThen(keep(turn.id, kept), store.setTaken(last)))
          return kept
        })

        // The messages that came while the turn ran: it takes them in.
        const steer = Effect.fnUntraced(function*(turn: Turn) {
          const messages = yield* waiting
          const last = messages[messages.length - 1]
          if (last === undefined) {
            return null
          }
          const kept: Kept = { kind: "user", blocks: texts(messages, 0).map((text) => ({ text, mark: false })) }
          yield* store.transaction(Effect.andThen(keep(turn.id, kept), store.setTaken(last.i)))
          return kept
        })

        // A turn ends. One that did not end well leaves a note in the log.
        const end = Effect.fnUntraced(function*(turn: Turn, status: "done" | "stopped" | "failed", why: string | null) {
          const note = status === "failed"
            ? "No reply: " + (why ?? "it failed").replace(/\.$/, "") + ". Send a message to try again."
            : status === "stopped"
            ? why ?? "Stopped."
            : null
          yield* log(note === null ? [] : [{ kind: "note", text: note, turn: turn.id }], store.endTurn(turn.id, status, why))
          yield* emit({ type: "end", turn: turn.id, status, why })
        })

        // The functions that program `id` called.
        const functionsOf = (turn: number, id: number) => Effect.map(store.calls(turn), (rows) => rows.filter((row) => row.parent === id))

        // One program of the model: its call is written when it starts, and
        // its `tool` and `echo` when it ends.
        const program = Effect.fnUntraced(function*(turn: Turn, call: Call) {
          const id = yield* store.startCall({ turn: turn.id, vendorId: call.id, fn: call.name, input: call.input })
          yield* emit({ type: "call", turn: turn.id, call: id, program: call.input })
          const close = (status: "done" | "failed" | "cut", output: string, text: string, bytes?: number) =>
            log(
              [{ kind: "tool", text: call.input, turn: turn.id, call: id }, { kind: "echo", text, turn: turn.id, call: id }],
              store.endCall(id, { status, output, shown: bytes })
            )
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
          const steered = yield* steer(turn)
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

        // A turn, from where its items are, to its end.
        const run = Effect.fnUntraced(function*(turn: Turn) {
          yield* emit({ type: "start", turn: turn.id })
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

        const begin = (firstMsg: number) =>
          Effect.gen(function*() {
            const chat = yield* store.chat
            yield* store.setDraft(null)
            return yield* store.startTurn({ pick: store.launch.pick ?? chat.pick, head: JSON.stringify(makeHead(options.rules ?? null)), firstMsg })
          })

        // Turns, one after the other, while messages wait. A turn that
        // failed ends the row: the person must speak again.
        const drive = (turn: Turn): Effect.Effect<void> =>
          Effect.gen(function*() {
            let current: Turn | null = turn
            while (current !== null) {
              running = { turn: current.id, fiber: running?.fiber ?? null, stop: null }
              const status: "done" | "failed" = yield* run(current)
              const following: Effect.Effect<Turn | null, StoreError> = Effect.gen(function*() {
                // A message that came too late for the turn starts the next one.
                const next: Message | undefined = status === "done" ? (yield* waiting)[0] : undefined
                if (next === undefined) {
                  running = null
                  return null
                }
                return yield* begin(next.i)
              })
              current = yield* lock.withPermits(1)(following)
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function*() {
                const stopped = running
                running = null
                // The program's own stop leaves the turn running, for the next launch.
                if (stopped === null || stopped.stop === null) {
                  return
                }
                const [turn] = yield* store.runningTurns(null)
                if (turn !== undefined) {
                  yield* end(turn, "stopped", stopped.stop)
                }
              }).pipe(Effect.ignore)
            ),
            Effect.catchCause((cause) =>
              Effect.gen(function*() {
                running = null
                yield* diagnostic(Effect.logError("the turn loop stopped", cause))
              })
            )
          )

        const launch = (turn: Turn) =>
          Effect.gen(function*() {
            running = { turn: turn.id, fiber: null, stop: null }
            const fiber = yield* Effect.forkIn(drive(turn), scope)
            if (running !== null) {
              running.fiber = fiber
            }
          })

        const say = (text: string) =>
          lock.withPermits(1)(Effect.gen(function*() {
            const idle = running === null
            const [written, turn] = yield* memory.pushWith(
              [{ kind: "user", text }],
              (written): Effect.Effect<Turn | null, StoreError> => idle && written[0] !== undefined ? begin(written[0].i) : Effect.succeed(null)
            )
            yield* emit({ type: "accepted", messages: written })
            if (turn !== null) {
              yield* launch(turn)
            }
            return written
          }))

        const stop = (why = "Stopped.") =>
          Effect.suspend(() => {
            if (running === null || running.fiber === null) {
              return Effect.void
            }
            running.stop = why
            return Fiber.interrupt(running.fiber)
          })

        const idle: Effect.Effect<void> = Effect.suspend(() =>
          running === null || running.fiber === null ? Effect.void : Effect.andThen(Fiber.await(running.fiber), idle)
        )

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
            yield* log(
              [{ kind: "tool", text: call.input, turn: turn.id, call: call.id }, { kind: "echo", text, turn: turn.id, call: call.id }],
              store.endCall(call.id, { status: "cut", output: text })
            )
          }
        }
        const [cut] = yield* store.runningTurns(null)
        if (cut !== undefined) {
          yield* diagnostic(Effect.logInfo(`turn ${cut.id} was cut, and continues`))
          yield* launch(cut)
        }

        return Turns.of({ say, stop, idle, events: Stream.fromPubSub(hub), subscribe: PubSub.subscribe(hub) })
      })
    )
}
