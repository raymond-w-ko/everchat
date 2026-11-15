// Tests of the pace: when a held text is given on, and when it is dropped.
// The pacer has no clock, so each test gives the times.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { LIMIT, LONG, pacer, QUIET } from "./pace.ts"
import type { Message } from "./store.ts"
import type { TurnEvent } from "./turn.ts"

type Kind = "thought" | "text" | "program"
const delta = (type: Kind, text: string, turn = 1): TurnEvent => ({ type, turn, delta: text })

const message = (kind: Message["kind"], turn: number | null = 1): TurnEvent => ({
  type: "message",
  n: 1,
  message: { i: 5, kind, text: "a message", size: 9, more: false, line: null, turn, call: null, launch: 1, created: 0 }
})

// What was given on, as [type, delta], and the type alone of the other events.
const given = (events: ReadonlyArray<TurnEvent>) =>
  events.map((event) => (event.type === "thought" || event.type === "text" || event.type === "program" ? [event.type, event.delta] : event.type))

// A pacer that only the end of a paragraph, or the rules under test, make give a text on.
const NEVER = 1e12

test("an event that is not a piece of what streams goes on as it is, at once", () => {
  const pace = pacer()
  const events: Array<TurnEvent> = [
    { type: "accepted", n: 1, messages: [] },
    { type: "start", n: 1, turn: 1 },
    { type: "call", n: 1, turn: 1, call: 3, program: "return 1" },
    message("tool"),
    message("echo"),
    message("asst"),
    { type: "end", n: 1, turn: 1, status: "done", why: null }
  ]
  for (const event of events) {
    assert.deepStrictEqual(pace.push(event, 0), [event])
  }
  assert.deepStrictEqual(pace.tick(NEVER), [])
})

test("a text is given on at the end of a paragraph, whole, and the rest is held", () => {
  const pace = pacer()
  assert.deepStrictEqual(pace.push(delta("text", "Hello "), 0), [])
  assert.deepStrictEqual(pace.push(delta("text", "world.\n"), 10), [])
  // The empty line ends the paragraph.
  assert.deepStrictEqual(given(pace.push(delta("text", "\nNext "), 20)), [["text", "Hello world.\n\n"]])
  assert.deepStrictEqual(pace.push(delta("text", "block"), 30), [])
  // Two paragraphs in one piece go on together.
  assert.deepStrictEqual(given(pace.push(delta("text", " ends.\n\nA third.\n\nAnd a fou"), 40)), [["text", "Next block ends.\n\nA third.\n\n"]])
  assert.deepStrictEqual(given(pace.tick(40 + QUIET)), [["text", "And a fou"]])
  // A thought has paragraphs as a text has.
  assert.deepStrictEqual(given(pace.push(delta("thought", "First I look.\n\nThen"), 1000)), [["thought", "First I look.\n\n"]])
})

test("code between two fence lines is one paragraph: it is given on with its second fence line, and an empty line in it ends nothing", () => {
  const pace = pacer({ limit: NEVER, quiet: NEVER, long: NEVER })
  const push = (text: string) => given(pace.push(delta("text", text), 0))
  assert.deepStrictEqual(push("Look:\n"), [])
  assert.deepStrictEqual(push("\n"), [["text", "Look:\n\n"]])
  assert.deepStrictEqual(push("```js\n"), [])
  assert.deepStrictEqual(push("const a = 1\n"), [])
  assert.deepStrictEqual(push("\n"), [])
  // A fence line of the other mark, or with a word after it, does not end the code.
  assert.deepStrictEqual(push("~~~\n"), [])
  assert.deepStrictEqual(push("```js\n"), [])
  assert.deepStrictEqual(push("const b = 2\n"), [])
  assert.deepStrictEqual(push("```\n"), [["text", "```js\nconst a = 1\n\n~~~\n```js\nconst b = 2\n```\n"]])
  // After it, an empty line ends a paragraph again.
  assert.deepStrictEqual(push("Done.\n\n"), [["text", "Done.\n\n"]])
  // A longer fence needs a second line that is as long, and a fence can be indented.
  assert.deepStrictEqual(push("  ~~~~\na\n~~~\n\n"), [])
  assert.deepStrictEqual(push("~~~~~\n"), [["text", "  ~~~~\na\n~~~\n\n~~~~~\n"]])
})

test("a fence line that comes in pieces is still seen", () => {
  const pace = pacer({ limit: NEVER, quiet: NEVER, long: NEVER })
  const out: Array<unknown> = []
  for (const piece of ["``", "`t", "s\ncon", "st a\n", "\n", "`", "``", "\nAfter.\n", "\n"]) {
    out.push(...given(pace.push(delta("text", piece), 0)))
  }
  assert.deepStrictEqual(out, [["text", "```ts\nconst a\n\n```\n"], ["text", "After.\n\n"]])
})

test("a line that was given on in part is still seen whole: a fence line, and the empty line after it", () => {
  const pace = pacer()
  // The model stops in the middle of a fence line, and the half is given on.
  assert.deepStrictEqual(pace.push(delta("text", "``"), 0), [])
  assert.deepStrictEqual(given(pace.tick(QUIET)), [["text", "``"]])
  // The rest of the line makes it a fence line: the empty line after it ends nothing.
  assert.deepStrictEqual(pace.push(delta("text", "`js\ncode\n\nmore\n"), QUIET), [])
  assert.deepStrictEqual(given(pace.push(delta("text", "```\n"), QUIET)), [["text", "`js\ncode\n\nmore\n```\n"]])
  // The line after it starts new: its empty line ends a paragraph.
  assert.deepStrictEqual(given(pace.push(delta("text", "Done.\n\n"), QUIET)), [["text", "Done.\n\n"]])
})

test("the first piece of a text is new, whenever it comes", () => {
  const pace = pacer({ quiet: NEVER })
  // Long after the launch, and long after the text before it.
  assert.deepStrictEqual(pace.push(delta("text", "- one\n- tw"), 50 * LIMIT), [])
  assert.deepStrictEqual(pace.tick(51 * LIMIT - 1), [])
  assert.deepStrictEqual(given(pace.tick(51 * LIMIT)), [["text", "- one\n"]])
  assert.deepStrictEqual(given(pace.push(delta("text", "o\n\n"), 51 * LIMIT)), [["text", "- two\n\n"]])
  assert.deepStrictEqual(pace.push(delta("text", "- three\n- fo"), 90 * LIMIT), [])
})

test("a text with no end of a paragraph is given on after LIMIT: its whole lines, or else its last sentence", () => {
  const lines = pacer({ quiet: NEVER })
  assert.deepStrictEqual(lines.push(delta("text", "- one\n- two\n- thr"), 0), [])
  assert.deepStrictEqual(lines.push(delta("text", "ee"), LIMIT - 1), [])
  assert.deepStrictEqual(given(lines.push(delta("text", " and"), LIMIT)), [["text", "- one\n- two\n"]])
  // The rest is new: it waits for LIMIT again.
  assert.deepStrictEqual(lines.tick(2 * LIMIT - 1), [])
  assert.deepStrictEqual(lines.push(delta("text", " more\n"), 2 * LIMIT - 1), [])
  assert.deepStrictEqual(given(lines.tick(2 * LIMIT)), [["text", "- three and more\n"]])

  const sentences = pacer({ quiet: NEVER })
  assert.deepStrictEqual(sentences.push(delta("text", "A sentence (with \"marks\".) Anoth"), 0), [])
  assert.deepStrictEqual(given(sentences.push(delta("text", "er one"), LIMIT)), [["text", "A sentence (with \"marks\".) "]])
  // A sentence of a language with no spaces.
  const wide = pacer({ quiet: NEVER })
  assert.deepStrictEqual(wide.push(delta("text", "これは文です。次の"), 0), [])
  assert.deepStrictEqual(given(wide.tick(LIMIT)), [["text", "これは文です。"]])
})

test("a text with no boundary at all is held until LONG, and then given on up to its last space", () => {
  const pace = pacer({ quiet: NEVER })
  assert.deepStrictEqual(pace.push(delta("text", "one long sentence that has no end"), 0), [])
  assert.deepStrictEqual(pace.tick(LIMIT), [])
  assert.deepStrictEqual(pace.tick(LONG - 1), [])
  assert.deepStrictEqual(given(pace.tick(LONG)), [["text", "one long sentence that has no "]])
  // With no space, all of it.
  const word = pacer({ quiet: NEVER })
  assert.deepStrictEqual(word.push(delta("text", "aaaa"), 0), [])
  assert.deepStrictEqual(given(word.push(delta("text", "bbbb"), LONG)), [["text", "aaaabbbb"]])
})

test("when nothing comes for QUIET, all that is held is given on", () => {
  const pace = pacer()
  assert.deepStrictEqual(pace.push(delta("text", "Half a wor"), 0), [])
  assert.deepStrictEqual(pace.tick(QUIET - 1), [])
  // A new piece starts the wait again.
  assert.deepStrictEqual(pace.push(delta("text", "d"), QUIET - 1), [])
  assert.deepStrictEqual(pace.tick(2 * QUIET - 2), [])
  assert.deepStrictEqual(given(pace.tick(2 * QUIET - 1)), [["text", "Half a word"]])
  assert.deepStrictEqual(pace.tick(NEVER), [])
})

test("when the model goes on to another thing, what is held of the one before is given on first", () => {
  const pace = pacer()
  assert.deepStrictEqual(pace.push(delta("thought", "I think about it"), 0), [])
  assert.deepStrictEqual(given(pace.push(delta("text", "Hello"), 10)), [["thought", "I think about it"]])
  assert.deepStrictEqual(given(pace.push(delta("program", "const a"), 20)), [["text", "Hello"]])
  // The paragraph of the new one that ended in the same piece comes after.
  const both = pacer()
  assert.deepStrictEqual(both.push(delta("thought", "A thought"), 0), [])
  assert.deepStrictEqual(given(both.push(delta("text", "A block.\n\nMore"), 10)), [["thought", "A thought"], ["text", "A block.\n\n"]])
})

test("what is held is dropped when the step's streams are over: EverChat's message, a program's start, the turn's end", () => {
  for (
    const over of [
      message("asst"),
      { type: "call", n: 1, turn: 1, call: 3, program: "return 1" },
      { type: "end", n: 1, turn: 1, status: "stopped", why: "Stopped." }
    ] as Array<TurnEvent>
  ) {
    const pace = pacer()
    assert.deepStrictEqual(pace.push(delta("thought", "a thought"), 0), [])
    assert.equal(pace.push(delta("text", "a text"), 0).length, 1)
    assert.equal(pace.push(delta("program", "a program"), 0).length, 1)
    assert.deepStrictEqual(pace.push(over, 10), [over])
    assert.deepStrictEqual(pace.tick(NEVER), [])
    // The next step starts with nothing: no fence is open, and no line is half given.
    assert.deepStrictEqual(given(pace.push(delta("text", "New.\n\n"), 20)), [["text", "New.\n\n"]])
  }
  // Another message does not end the streams: a note, or a message of the person.
  for (const other of [message("note"), message("user", null), { type: "accepted", n: 1, messages: [] }, { type: "start", n: 1, turn: 1 }] as Array<TurnEvent>) {
    const pace = pacer()
    assert.deepStrictEqual(pace.push(delta("text", "a text"), 0), [])
    assert.deepStrictEqual(pace.push(other, 10), [other])
    assert.deepStrictEqual(given(pace.tick(10 + QUIET)), [["text", "a text"]])
  }
})

test("code that was open when the step ended is not open in the next step", () => {
  const pace = pacer({ limit: NEVER, quiet: NEVER, long: NEVER })
  assert.deepStrictEqual(pace.push(delta("text", "```\ncode\n"), 0), [])
  pace.push(message("asst"), 0)
  assert.deepStrictEqual(given(pace.push(delta("text", "A block.\n\n"), 0)), [["text", "A block.\n\n"]])
})

test("a program has no paragraphs: it is given on in whole lines, by the time", () => {
  const pace = pacer({ quiet: NEVER })
  assert.deepStrictEqual(pace.push(delta("program", "const a = 1\n\nconst b"), 0), [])
  assert.deepStrictEqual(given(pace.push(delta("program", " = 2"), LIMIT)), [["program", "const a = 1\n\n"]])
  // A sentence end in a line of code is no boundary. At LONG, all of it.
  assert.deepStrictEqual(pace.tick(2 * LIMIT), [])
  assert.deepStrictEqual(pace.push(delta("program", " // done. Really"), 2 * LIMIT), [])
  assert.deepStrictEqual(given(pace.tick(LIMIT + LONG)), [["program", "const b = 2 // done. Really"]])
})

test("white space is never given on alone: it goes with the next text", () => {
  const pace = pacer()
  assert.deepStrictEqual(pace.push(delta("text", "\n\n"), 0), [])
  assert.deepStrictEqual(pace.tick(NEVER / 2), [])
  assert.deepStrictEqual(given(pace.push(delta("text", "Hello.\n\n"), NEVER / 2 + 1)), [["text", "\n\nHello.\n\n"]])
})

test("the streams of two turns are held apart", () => {
  const pace = pacer()
  assert.deepStrictEqual(pace.push(delta("text", "of one", 1), 0), [])
  assert.deepStrictEqual(pace.push(delta("text", "of two", 2), 0), [])
  const end: TurnEvent = { type: "end", n: 1, turn: 1, status: "done", why: null }
  assert.deepStrictEqual(pace.push(end, 10), [end])
  assert.deepStrictEqual(pace.tick(QUIET), [delta("text", "of two", 2)])
})

test("whatever the pieces and the times are, the text that is given on is the text that came, once and in order", () => {
  const whole = [
    "# A title",
    "",
    "A first block, with two sentences. Here is the second one, which is longer than the first.",
    "",
    "- one",
    "- two",
    "",
    "```ts",
    "const a = 1",
    "",
    "const b = `~~~`",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "    indented code",
    "",
    "~~~",
    "```",
    "~~~",
    "A last line with no newline"
  ].join("\n")
  // A fixed sequence of numbers, so that a failure can be seen again.
  let seed = 12345
  const random = (below: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % below
  }
  for (let run = 0; run < 200; run++) {
    const pace = pacer()
    let now = 0
    let out = ""
    const take = (events: ReadonlyArray<TurnEvent>) => {
      for (const event of events) {
        if (event.type !== "text") {
          throw new Error("an event of another type: " + event.type)
        }
        assert.notEqual(event.delta.trim(), "")
        out += event.delta
      }
    }
    for (let at = 0; at < whole.length;) {
      const size = 1 + random(run % 2 === 0 ? 6 : 60)
      now += random(run % 3 === 0 ? 700 : 40)
      take(pace.tick(now))
      take(pace.push(delta("text", whole.slice(at, at + size)), now))
      at += size
    }
    take(pace.tick(now + QUIET))
    assert.equal(out, whole)
    assert.deepStrictEqual(pace.tick(NEVER), [])
  }
})
