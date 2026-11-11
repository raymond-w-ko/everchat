// Follow
// ======
// The messages of the log for an interface that shows them (the terminal,
// pipe mode): each one once, in the order of the ids, and each text whole.
//
// The log is the truth of what an interface shows. The turn loop's events
// say when a message entered the log, but events alone are not enough:
//
// - An event can come for a message that the interface has read from the
//   log already. It is dropped.
// - A message can enter the log with no event for this listener, for
//   example before it subscribed. When an event's id is above the next id
//   expected, the messages in between are read from the log first.
// - A text of many pages is many messages, and one thing to show. Its
//   pages are joined, and it is given when its last page is there.
//
// So an interface subscribes to the turn loop first, then reads the log's
// count, and then gives every message that it reads or gets to this
// module. No message is then shown twice or left out.

import { Effect } from "effect"
import type { Kind, Message, StoreError } from "./store.ts"

// One message as an interface shows it. `call`: the call of a program's
// message (`tool`, `echo`).
export interface Shown {
  readonly kind: Kind
  readonly text: string
  readonly call: number | null
}

export interface Follow {
  // Messages that were read from the log, in order, from the next id on.
  join(messages: ReadonlyArray<Message>): Array<Shown>
  // A message that an event brought. It gives what to show now: nothing,
  // or first the messages before it that no event brought.
  take(message: Message): Effect.Effect<Array<Shown>, StoreError>
}

// `read` is the store's `messages`. `from` is the id of the first message
// to show. It must be the first page of its text.
export const follow = (read: (from: number, to: number) => Effect.Effect<Array<Message>, StoreError>, from: number): Follow => {
  let next = from
  let page: { readonly kind: Kind; readonly text: string } | null = null // the pages so far of a text that has more

  const one = (message: Message): Array<Shown> => {
    next = message.i + 1
    const text = (page !== null && page.kind === message.kind ? page.text : "") + message.text
    if (message.more) {
      page = { kind: message.kind, text }
      return []
    }
    page = null
    return [{ kind: message.kind, text, call: message.call }]
  }

  const join = (messages: ReadonlyArray<Message>): Array<Shown> => messages.flatMap(one)

  const take = Effect.fnUntraced(function*(message: Message) {
    if (message.i < next) {
      return []
    }
    const missed = message.i > next ? yield* read(next, message.i) : []
    return join([...missed, message])
  })

  return { join, take }
}
