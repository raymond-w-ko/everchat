// Tests of the follow: which messages an interface shows, for each order
// in which the log and the events can give them.

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { follow } from "./follow.ts"
import type { Kind, Message } from "./store.ts"

const message = (i: number, kind: Kind, text: string, more = false, call: number | null = null): Message => ({
  i,
  kind,
  text,
  size: text.length,
  more,
  line: null,
  turn: 1,
  call,
  launch: 1,
  created: 0
})

// A log, and the reads that were made of it.
const logOf = (messages: ReadonlyArray<Message>) => {
  const reads: Array<[number, number]> = []
  const read = (from: number, to: number) =>
    Effect.sync(() => {
      reads.push([from, to])
      return messages.filter((one) => one.i >= from && one.i < to)
    })
  return { read, reads }
}

const texts = (shown: ReadonlyArray<{ kind: Kind; text: string }>) => shown.map((one) => one.kind + ": " + one.text)

test("messages in order are given as they come, each once, with no read of the log", async () => {
  const all = [message(0, "user", "hello"), message(1, "tool", "return 1", false, 7), message(2, "echo", "1", false, 7), message(3, "asst", "It is 1.")]
  const log = logOf(all)
  const followed = follow(log.read, 0)
  const shown = []
  for (const one of all) {
    shown.push(...(await Effect.runPromise(followed.take(one))))
  }
  expect(texts(shown)).toEqual(["user: hello", "tool: return 1", "echo: 1", "asst: It is 1."])
  expect(shown.map((one) => one.call)).toEqual([null, 7, 7, null])
  expect(log.reads).toEqual([])
})

test("an event of a message that was given already is dropped", async () => {
  const all = [message(0, "user", "hello"), message(1, "asst", "Hello.")]
  const log = logOf(all)
  // The log was read up to its end before the events came.
  const followed = follow(log.read, 0)
  expect(texts(followed.join(all))).toEqual(["user: hello", "asst: Hello."])
  expect(await Effect.runPromise(followed.take(all[0]!))).toEqual([])
  expect(await Effect.runPromise(followed.take(all[1]!))).toEqual([])
  expect(log.reads).toEqual([])
})

test("when an id was skipped, the messages in between are read from the log first", async () => {
  const all = [message(0, "user", "one"), message(1, "asst", "One."), message(2, "user", "two"), message(3, "note", "A note."), message(4, "asst", "Two.")]
  const log = logOf(all)
  const followed = follow(log.read, 1)
  // Nothing before the first id to show, and the event of message 4 is the first that comes.
  expect(texts(await Effect.runPromise(followed.take(all[4]!)))).toEqual(["asst: One.", "user: two", "note: A note.", "asst: Two."])
  expect(log.reads).toEqual([[1, 4]])
  // The events of the messages in between come late, and are dropped.
  expect(await Effect.runPromise(followed.take(all[2]!))).toEqual([])
  expect(await Effect.runPromise(followed.take(all[4]!))).toEqual([])
})

test("a text of many pages is one, and it is given when its last page is there", async () => {
  const all = [
    message(0, "user", "say much"),
    message(1, "asst", "page one, ", true),
    message(2, "asst", "page two, ", true),
    message(3, "asst", "page three."),
    message(4, "asst", "Another text.")
  ]
  const log = logOf(all)
  const followed = follow(log.read, 0)
  expect(texts(await Effect.runPromise(followed.take(all[0]!)))).toEqual(["user: say much"])
  expect(await Effect.runPromise(followed.take(all[1]!))).toEqual([])
  expect(await Effect.runPromise(followed.take(all[2]!))).toEqual([])
  expect(texts(await Effect.runPromise(followed.take(all[3]!)))).toEqual(["asst: page one, page two, page three."])
  // The next text of the same kind is its own.
  expect(texts(await Effect.runPromise(followed.take(all[4]!)))).toEqual(["asst: Another text."])
  // The same from a read of the log, and across a read and an event.
  expect(texts(follow(log.read, 0).join(all))).toEqual(["user: say much", "asst: page one, page two, page three.", "asst: Another text."])
  const mixed = follow(log.read, 0)
  expect(texts(mixed.join(all.slice(0, 2)))).toEqual(["user: say much"])
  expect(texts(await Effect.runPromise(mixed.take(all[3]!)))).toEqual(["asst: page one, page two, page three."])
})

test("a failed read of the log is the caller's to handle, and nothing is given or lost", async () => {
  const all = [message(0, "user", "one"), message(1, "asst", "One."), message(2, "user", "two")]
  let fails = true
  const followed = follow((from, to) => (fails ? Effect.fail({ _tag: "StoreError", op: "messages" } as never) : Effect.succeed(all.filter((one) => one.i >= from && one.i < to))), 0)
  expect((await Effect.runPromiseExit(followed.take(all[2]!)))._tag).toBe("Failure")
  // The next event gives all of them.
  fails = false
  expect(texts(await Effect.runPromise(followed.take(all[2]!)))).toEqual(["user: one", "asst: One.", "user: two"])
})
