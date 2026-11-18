// The source of the wake-ups (docs/wakeups.md, section 5): the chat's
// oldest waiting fire, given to the turn loop (`Source`, below `Turns`) as
// an offer of the kind `wake`, with the ceiling of a wake turn and the
// budget of fires (section 6). The firer writes the waiting fires
// (`pendWake`); this module only reads them, and its offer's `write` marks
// the row fired (`fireWake`) in the transaction that logs the message and
// starts its turn.
//
// `next` runs under the loop's lock from its read to that commit (turn.ts,
// `Source`): a person's stop, off and on are each the `write` of a
// `Turns.note`, under the same lock, so none comes between. The firer's
// `pendWake` takes no lock: a newer slot that it writes in between waits on
// with its own count, and `fireWake` consumes the slot that `next` read.

import { Clock, Effect, Layer, Option } from "effect"
import { visible, wallClock } from "@everchat/core/functions"
import { Store, type StoreError, type Wake, WAKE_MISSED_MAX, type WakeRead } from "@everchat/core/store"
import { type Offer, Source } from "@everchat/core/turn"
import { lateText, missedText } from "./time.ts"

// The ceiling of a wake turn: the most steps and tokens that it may use
// (lead, ec-e75r, N6). At either one the turn ends `stopped`, with the
// core's why `CEILING`.
export const WAKE_CEILING: { readonly steps: number; readonly tokens: number } = { steps: 20, tokens: 2_000_000 }

// The budget of fires, each counted back from now: at most `HOUR_FIRES` in
// any `HOUR` and `DAY_FIRES` in any `DAY` (milliseconds). A fire past it is
// not offered: it waits, and its text then says how late it is.
export const HOUR = 60 * 60_000
export const DAY = 24 * HOUR
export const HOUR_FIRES = 6
export const DAY_FIRES = 24

// The text of a fire: `[<id>] due <the slot on the row's wall clock>`, how
// late it is at `now` and the slots that it stands for beside its own, each
// only when it is not zero, then the row's text:
// `[3] due 2026-11-16 09:00 Europe/Berlin, 2 h late, 1 missed: Read my mail.`
// The slot and the count are `read`'s, what the source read of the row. A
// zone that the engine does not know reads as UTC (`wallClock`), with no
// throw: a row is data. A count at `WAKE_MISSED_MAX` reads "1000 or more".
// One fire is one line: the row's text goes in through the core's
// `visible`, so each line end and each hidden code point of it is its
// escape (`\x0a`, `\u{2028}`), as in a note of an approval, and a text
// with line ends never reads as a second fire. The zone is the clock's
// (`wallClock`), with no line end. The row keeps its text exact; a text
// with none of those code points is here byte for byte, and each of the
// row's 2,000 characters is at most 8 here.
export const fireText = (wake: Wake, read: WakeRead, now: number): string => {
  const parts = [wallClock(read.pending, wake.zone)]
  const late = lateText(read.pending, now)
  if (late !== undefined) parts.push(late)
  const missed = missedText({ slot: read.pending, missed: read.missed, more: read.missed >= WAKE_MISSED_MAX, next: undefined })
  if (missed !== undefined) parts.push(missed)
  return `[${wake.id}] due ${parts.join(", ")}: ${visible(wake.text)}`
}

// What the source has now, in this order: nothing while the chat's
// wake-ups are off; nothing with no waiting fire of a settled row
// (`pendingWake`, which gives settled rows only); nothing past the budget;
// else the oldest waiting fire. Its `write` is `fireWake` of the slot and
// the count read here: a row that changed since fails it with a
// `StoreError`, and the offer's transaction writes nothing (no change can
// come under the loop's lock: the head comment).
export const next = (store: Store["Service"]): Effect.Effect<Offer | null, StoreError> =>
  Effect.gen(function*() {
    const chat = yield* store.chat
    if (!chat.wakeups) return null
    const found = yield* store.pendingWake()
    if (Option.isNone(found) || found.value.pending === null) return null
    const wake = found.value
    const now = yield* Clock.currentTimeMillis
    if ((yield* store.fires(now - HOUR)) >= HOUR_FIRES) return null
    if ((yield* store.fires(now - DAY)) >= DAY_FIRES) return null
    const read: WakeRead = { pending: found.value.pending, missed: wake.missed }
    return {
      kind: "wake",
      text: fireText(wake, read, now),
      ceiling: WAKE_CEILING,
      write: (_first, turn) => store.fireWake(wake.id, turn.id, read)
    } satisfies Offer
  })

// The source as the turn loop reads it, over the store. A host with the
// approvals too joins them first: `Source.inOrder(Approvals.source, source)`.
export const source: Layer.Layer<Source, never, Store> = Layer.effect(
  Source,
  Effect.gen(function*() {
    const store = yield* Store
    return Source.of({ next: next(store) })
  })
)
