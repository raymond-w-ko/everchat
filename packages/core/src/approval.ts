// Approval
// ========
// A person's yes or no for a call that waits (`pending`), and the run of
// the recorded call after a yes (packages/core/AGENTS.md, "Approval";
// docs/design.md, "Functions, approval, programs").
//
// A program's call of a function that needs approval does not run: the
// sandbox records it, and the store makes its approval (`pendCall`). Here:
//
// - The answer (`Approvals.answer`): the store records it (`answerApproval`)
//   and it returns. A no is told to the chat as a note at once. A yes wakes
//   the layer's one worker. Only the record can fail the answer: a step
//   after it (the note of this answer, the expiry of the others and their
//   notes) that fails is a diagnostic, and the answer gives what the store
//   recorded, for the person's answer stands. Nothing is lost by it: a note
//   that fails is given by the next load, and the 7 days are checked again
//   at the next answer and at a load.
// - The run: one at a time for a chat, in the order of the answers as the
//   store keeps them, in the worker, a fiber of the layer's scope. At each
//   wake, and after each run, the worker reads the rows still `yes` and
//   runs the one with the least `answered` (of two with one time, the least
//   number), until none is left. A read that fails, or a start that fails,
//   is a diagnostic, and the worker waits for its next wake (an answer, or
//   the next load). `startApproval` makes the row `running` only from
//   `yes`, so a run starts one time whatever comes between (two answers, a
//   stop, a crash, a second launch). The function is called with
//   the row's own `fn` and `input`, nothing else: `Functions.call(fn,
//   JSON.parse(input), caller)`, as the program would have. Its end is
//   recorded on the approval's row only (`endApproval`): `done` with the
//   result's text, `failed` with the error's message, `cut` when the run is
//   interrupted (the layer's scope ends: EverChat stops). The call's own
//   row stays `pending`; `result(<call>)` reads the run's output from the
//   approval (functions.ts). Then the turn loop is told (`Turns.ready`).
// - The source (`Approvals.source`, the seam of turn.ts): the oldest run
//   that has ended and is not told yet becomes a message of the kind
//   `late`, which waits until the chat is idle and starts a turn of its
//   own. Its `write` marks the row as told (`tellApproval`) in the
//   transaction that logs the message, so a run's result is told one time.
// - A no and an expiry are a note (`Turns.note`), which starts no turn; its
//   `write` marks the row as told with the note's first page, in the
//   transaction that logs the note: a row is told exactly when its note is
//   in the log, and a note that fails is given by the next load.
// - The 7 days (`WAIT`) are checked at a load and at an answer; nothing
//   waits in memory, so an unload, a crash or an upgrade loses no approval.
//   `waiting` leaves out a `pending` row whose 7 days are over, by the
//   store's own test (`now - created > WAIT`, with Effect's `Clock`), and
//   writes nothing: the expiry and its note stay at an answer and at a load.
// - A load (the layer's build), in this order: a run that an earlier launch
//   left (`running`) is `cut`, never run again; the approvals past their 7
//   days expire, each with its note; the worker is woken for the rows still
//   `yes` (a stop between the answer and the run); each `no` and `expired`
//   row not told yet gets its note; then `Turns.ready`, for a run that
//   ended and was not told.

import { Clock, Context, Effect, Layer, Option, Queue } from "effect"
import { type Caller, FunctionError, Functions, Shortened, shownInput } from "./functions.ts"
import { Limit } from "./limit.ts"
import { type Answered, type Approval, type ApprovalAnswer, type ApprovalEnd, Store, type StoreError, WAIT } from "./store.ts"
import { CUT_FUNCTION, type Offer, Source, Turns } from "./turn.ts"

const diagnostic = Effect.annotateLogs("source", "approval")

// What a run that was cut when EverChat stopped says: at an unload, and at
// the next load for a run that a crash left.
export const CUT_RUN = CUT_FUNCTION

// The note of a no, and its words, if the person gave any.
export const noNote = (approval: Approval): string =>
  "Approval " + approval.id + ": " + (approval.who ?? "someone") + " said no to " + approval.fn + "(" + shownInput(approval.input) + ")." +
  (approval.answer === null || approval.answer === "" ? "" : " " + JSON.stringify(approval.answer))

// The note of an approval that waited 7 days with no answer.
export const expiredNote = (approval: Approval): string =>
  "Approval " + approval.id + " expired after 7 days with no answer: " + approval.fn + "(" + shownInput(approval.input) + "). The call did not run."

// The first line of the message of a run's end.
export const ranLine = (approval: Approval): string =>
  "Approval " + approval.id + ": " + approval.fn + "(" + shownInput(approval.input) + ") ran after a yes by " + (approval.who ?? "someone") + "."

// A function's value as the call's row keeps it (as the sandbox's calls do).
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? "")

// The states of a run's end, which the source tells.
const ENDED: ReadonlyArray<Approval["status"]> = ["done", "failed", "cut"]

export class Approvals extends Context.Service<Approvals, {
  // The approvals that wait for an answer, in the order of their ids: the
  // `pending` rows whose 7 days are not over (the store's test, at the
  // time of Effect's `Clock`). It reads only: a row past its 7 days stays
  // `pending` in the store until the next answer or load expires it.
  readonly waiting: Effect.Effect<ReadonlyArray<Approval>, StoreError>
  // A person's answer to the approval `n`, as the store records it
  // (`answerApproval`). It returns when the answer is recorded, and a no's
  // note is in the log. A yes wakes the layer's worker, which runs it in
  // its turn. An answer that comes after the 7 days is `expired`, and is
  // told as an expiry. It fails only when the record fails: a failure of a
  // step after it (a note, the expiry of the others) is a diagnostic, the
  // answer stands and is given, and the next answer or load does the step
  // again (an untold row's note, the 7 days).
  answer(n: number, answer: ApprovalAnswer): Effect.Effect<Answered, StoreError>
}>()("everchat/approval/Approvals") {
  // The answers and the runs, over the turn loop. Its build is a load (the
  // head comment). Its scope holds the runs: when it ends, a run at work is
  // cut, and its row says so.
  static readonly layer: Layer.Layer<Approvals, StoreError, Store | Functions | Turns> = Layer.effect(
    Approvals,
    Effect.gen(function*() {
      const store = yield* Store
      const functions = yield* Functions
      const turns = yield* Turns
      // The worker's wakes. One that waits is enough: the worker reads the
      // store at each.
      const wake = yield* Queue.dropping<void>(1)

      // A note to the chat for a row's end that starts no turn; its `write`
      // marks the row as told with the note's first page, in the note's one
      // transaction.
      const tell = (approval: Approval, note: string) => turns.note(note, (first) => store.tellApproval(approval.id, first.i))
      const noted = (approval: Approval, note: string) =>
        tell(approval, note).pipe(
          Effect.catchCause((cause) => diagnostic(Effect.logError(`the note of approval ${approval.id} was not logged`, cause)))
        )

      // The run of one approval after a yes (the head comment): false when
      // `startApproval` refuses it (the row is no more `yes`). A start that
      // fails fails it; a failure after the start is a diagnostic.
      const run = (n: number): Effect.Effect<boolean, StoreError> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const started = yield* store.startApproval(n)
            if (Option.isNone(started)) return false
            const approval = started.value
            yield* Effect.gen(function*() {
              const call = yield* store.call(approval.call)
              const caller: Caller = {
                turn: approval.turn,
                program: Option.match(call, { onNone: () => approval.call, onSome: (row) => row.parent ?? approval.call }),
                call: approval.call
              }
              const end = (how: ApprovalEnd) => Effect.asVoid(store.endApproval(n, how))
              const args = argsOf(approval.input)
              const work = args instanceof FunctionError
                ? Effect.fail(args)
                : functions.call(approval.fn, args, caller).pipe(
                  Effect.catchDefect((defect) => Effect.fail(new FunctionError({ message: "EverChat failed in this function: " + String(defect) })))
                )
              const got = yield* Effect.result(restore(work).pipe(Effect.onInterrupt(() => Effect.ignore(end({ status: "cut", output: CUT_RUN })))))
              if (got._tag === "Failure") {
                yield* end({ status: "failed", output: got.failure.message })
              } else {
                const value = got.success
                yield* end({ status: "done", output: value instanceof Shortened ? value.whole : text(value) })
              }
              yield* restore(turns.ready)
            }).pipe(
              Effect.catchCause((cause) => diagnostic(Effect.logError(`the run of approval ${n} failed`, cause)))
            )
            return true
          })
        )

      // The rows still `yes`, each run in its turn: the least `answered`
      // first, and of two with one time, the least number; then the store
      // is read again, until no row is `yes`. A row that `startApproval`
      // refuses (it is no more `yes`) is passed. A read or a start that
      // fails ends the round with a diagnostic.
      const round = Effect.gen(function*() {
        const passed = new Set<number>()
        while (true) {
          const rows = (yield* store.approvals(["yes"])).filter((one) => !passed.has(one.id))
          const next = rows.reduce<Approval | undefined>((least, one) =>
            least === undefined || (one.answered ?? 0) < (least.answered ?? 0) || (one.answered === least.answered && one.id < least.id) ? one : least, undefined)
          if (next === undefined) return
          if (!(yield* run(next.id))) passed.add(next.id)
        }
      }).pipe(
        Effect.catchCause((cause) => diagnostic(Effect.logError("the approvals said yes to were not run: the next answer or load tries again", cause)))
      )

      // The one worker: a round at each wake, one run at a time.
      yield* Effect.forkScoped(Effect.forever(Effect.andThen(Queue.take(wake), round)))

      const expire = Effect.flatMap(store.expireApprovals(), (rows) => Effect.forEach(rows, (one) => noted(one, expiredNote(one)), { discard: true }))

      // The load.
      const cut = yield* store.cutApprovals(CUT_RUN)
      if (cut.length > 0) {
        yield* diagnostic(Effect.logInfo(`the runs of approvals ${cut.map((one) => one.id).join(", ")} were cut when EverChat stopped`))
      }
      yield* expire
      yield* Queue.offer(wake, undefined)
      for (const one of yield* store.untoldApprovals()) {
        if (one.status === "no") yield* noted(one, noNote(one))
        if (one.status === "expired") yield* noted(one, expiredNote(one))
      }
      yield* turns.ready

      const answer = (n: number, given: ApprovalAnswer) =>
        Effect.gen(function*() {
          const got = yield* store.answerApproval(n, given)
          if (got._tag === "answered") {
            if (got.approval.status === "yes") yield* Queue.offer(wake, undefined)
            else yield* noted(got.approval, noNote(got.approval))
          } else if (got._tag === "expired") {
            yield* noted(got.approval, expiredNote(got.approval))
          }
          // The 7 days of the others; a failure is a diagnostic, for the
          // answer is recorded (the next answer or load expires them).
          yield* expire.pipe(
            Effect.catchCause((cause) =>
              diagnostic(Effect.logError("the approvals past their 7 days were not expired at this answer: the next answer or load tries again", cause))
            )
          )
          return got
        })

      // The pending rows whose 7 days are not over, by the store's test.
      const waiting = Effect.gen(function*() {
        const rows = yield* store.approvals(["pending"])
        const at = yield* Clock.currentTimeMillis
        return rows.filter((one) => !(at - one.created > WAIT))
      })

      return Approvals.of({ waiting, answer })
    })
  )

  // The seam's source (turn.ts, `Source`): the oldest run that has ended
  // and is not told yet, as a `late` message. A result over the limit is
  // shown by the rule of every call's result (`Limit.show`): its head, its
  // tail, and a line that names `result(<call>)` and `result(<call>, from,
  // to)`, which read the whole from the approval's row.
  static readonly source: Layer.Layer<Source, never, Store | Limit> = Layer.effect(
    Source,
    Effect.gen(function*() {
      const store = yield* Store
      const limit = yield* Limit
      const next: Effect.Effect<Offer | null, StoreError> = Effect.gen(function*() {
        const approval = (yield* store.untoldApprovals()).find((one) => ENDED.includes(one.status))
        if (approval === undefined) return null
        return { kind: "late", text: yield* lateText(limit, approval), write: (first) => store.tellApproval(approval.id, first.i) } satisfies Offer
      })
      return Source.of({ next })
    })
  )
}

// The text of a run's end: what ran, by whose yes, and its result, its
// error or its cut.
export const lateText = (limit: Limit["Service"], approval: Approval): Effect.Effect<string> =>
  Effect.map(limit.show(approval.call, approval.output ?? ""), (shown) =>
    ranLine(approval) + "\n" +
    (approval.status === "done" ? "Result:\n" + shown.text : approval.status === "failed" ? "It failed:\n" + shown.text : shown.text))

// The recorded arguments as a list (functions.ts, `Entry`: a row's `input`
// is the list as JSON), or why they cannot be run.
const argsOf = (input: string): ReadonlyArray<unknown> | FunctionError => {
  try {
    const args: unknown = JSON.parse(input)
    return Array.isArray(args) ? args : new FunctionError({ message: "The recorded arguments are not a list." })
  } catch {
    return new FunctionError({ message: "The recorded arguments are not JSON." })
  }
}
