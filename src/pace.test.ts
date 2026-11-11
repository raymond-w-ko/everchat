// Tests of the pace: when a held text is given on, and when it is dropped.
// The pacer has no clock, so each test gives the times.

import { expect, test } from "bun:test"
import { LIMIT, LONG, pacer, QUIET } from "./pace.ts"
import type { Message } from "./store.ts"
import type { TurnEvent } from "./turn.ts"

type Kind = "thought" | "text" | "program"
const delta = (type: Kind, text: string, turn = 1): TurnEvent => ({ type, turn, delta: text })

const message = (kind: Message["kind"], turn: number | null = 1): TurnEvent => ({
  type: "message",
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
    { type: "accepted", messages: [] },
    { type: "start", turn: 1 },
    { type: "call", turn: 1, call: 3, program: "return 1" },
    message("tool"),
    message("echo"),
    message("asst"),
    { type: "end", turn: 1, status: "done", why: null }
  ]
  for (const event of events) {
    expect(pace.push(event, 0)).toEqual([event])
  }
  expect(pace.tick(NEVER)).toEqual([])
})

test("a text is given on at the end of a paragraph, whole, and the rest is held", () => {
  const pace = pacer()
  expect(pace.push(delta("text", "Hello "), 0)).toEqual([])
  expect(pace.push(delta("text", "world.\n"), 10)).toEqual([])
  // The empty line ends the paragraph.
  expect(given(pace.push(delta("text", "\nNext "), 20))).toEqual([["text", "Hello world.\n\n"]])
  expect(pace.push(delta("text", "block"), 30)).toEqual([])
  // Two paragraphs in one piece go on together.
  expect(given(pace.push(delta("text", " ends.\n\nA third.\n\nAnd a fou"), 40))).toEqual([["text", "Next block ends.\n\nA third.\n\n"]])
  expect(given(pace.tick(40 + QUIET))).toEqual([["text", "And a fou"]])
  // A thought has paragraphs as a text has.
  expect(given(pace.push(delta("thought", "First I look.\n\nThen"), 1000))).toEqual([["thought", "First I look.\n\n"]])
})

test("code between two fence lines is one paragraph: it is given on with its second fence line, and an empty line in it ends nothing", () => {
  const pace = pacer({ limit: NEVER, quiet: NEVER, long: NEVER })
  const push = (text: string) => given(pace.push(delta("text", text), 0))
  expect(push("Look:\n")).toEqual([])
  expect(push("\n")).toEqual([["text", "Look:\n\n"]])
  expect(push("```js\n")).toEqual([])
  expect(push("const a = 1\n")).toEqual([])
  expect(push("\n")).toEqual([])
  // A fence line of the other mark, or with a word after it, does not end the code.
  expect(push("~~~\n")).toEqual([])
  expect(push("```js\n")).toEqual([])
  expect(push("const b = 2\n")).toEqual([])
  expect(push("```\n")).toEqual([["text", "```js\nconst a = 1\n\n~~~\n```js\nconst b = 2\n```\n"]])
  // After it, an empty line ends a paragraph again.
  expect(push("Done.\n\n")).toEqual([["text", "Done.\n\n"]])
  // A longer fence needs a second line that is as long, and a fence can be indented.
  expect(push("  ~~~~\na\n~~~\n\n")).toEqual([])
  expect(push("~~~~~\n")).toEqual([["text", "  ~~~~\na\n~~~\n\n~~~~~\n"]])
})

test("a fence line that comes in pieces is still seen", () => {
  const pace = pacer({ limit: NEVER, quiet: NEVER, long: NEVER })
  const out: Array<unknown> = []
  for (const piece of ["``", "`t", "s\ncon", "st a\n", "\n", "`", "``", "\nAfter.\n", "\n"]) {
    out.push(...given(pace.push(delta("text", piece), 0)))
  }
  expect(out).toEqual([["text", "```ts\nconst a\n\n```\n"], ["text", "After.\n\n"]])
})

test("a line that was given on in part is still seen whole: a fence line, and the empty line after it", () => {
  const pace = pacer()
  // The model stops in the middle of a fence line, and the half is given on.
  expect(pace.push(delta("text", "``"), 0)).toEqual([])
  expect(given(pace.tick(QUIET))).toEqual([["text", "``"]])
  // The rest of the line makes it a fence line: the empty line after it ends nothing.
  expect(pace.push(delta("text", "`js\ncode\n\nmore\n"), QUIET)).toEqual([])
  expect(given(pace.push(delta("text", "```\n"), QUIET))).toEqual([["text", "`js\ncode\n\nmore\n```\n"]])
  // The line after it starts new: its empty line ends a paragraph.
  expect(given(pace.push(delta("text", "Done.\n\n"), QUIET))).toEqual([["text", "Done.\n\n"]])
})

test("the first piece of a text is new, whenever it comes", () => {
  const pace = pacer({ quiet: NEVER })
  // Long after the launch, and long after the text before it.
  expect(pace.push(delta("text", "- one\n- tw"), 50 * LIMIT)).toEqual([])
  expect(pace.tick(51 * LIMIT - 1)).toEqual([])
  expect(given(pace.tick(51 * LIMIT))).toEqual([["text", "- one\n"]])
  expect(given(pace.push(delta("text", "o\n\n"), 51 * LIMIT))).toEqual([["text", "- two\n\n"]])
  expect(pace.push(delta("text", "- three\n- fo"), 90 * LIMIT)).toEqual([])
})

test("a text with no end of a paragraph is given on after LIMIT: its whole lines, or else its last sentence", () => {
  const lines = pacer({ quiet: NEVER })
  expect(lines.push(delta("text", "- one\n- two\n- thr"), 0)).toEqual([])
  expect(lines.push(delta("text", "ee"), LIMIT - 1)).toEqual([])
  expect(given(lines.push(delta("text", " and"), LIMIT))).toEqual([["text", "- one\n- two\n"]])
  // The rest is new: it waits for LIMIT again.
  expect(lines.tick(2 * LIMIT - 1)).toEqual([])
  expect(lines.push(delta("text", " more\n"), 2 * LIMIT - 1)).toEqual([])
  expect(given(lines.tick(2 * LIMIT))).toEqual([["text", "- three and more\n"]])

  const sentences = pacer({ quiet: NEVER })
  expect(sentences.push(delta("text", "A sentence (with \"marks\".) Anoth"), 0)).toEqual([])
  expect(given(sentences.push(delta("text", "er one"), LIMIT))).toEqual([["text", "A sentence (with \"marks\".) "]])
  // A sentence of a language with no spaces.
  const wide = pacer({ quiet: NEVER })
  expect(wide.push(delta("text", "これは文です。次の"), 0)).toEqual([])
  expect(given(wide.tick(LIMIT))).toEqual([["text", "これは文です。"]])
})

test("a text with no boundary at all is held until LONG, and then given on up to its last space", () => {
  const pace = pacer({ quiet: NEVER })
  expect(pace.push(delta("text", "one long sentence that has no end"), 0)).toEqual([])
  expect(pace.tick(LIMIT)).toEqual([])
  expect(pace.tick(LONG - 1)).toEqual([])
  expect(given(pace.tick(LONG))).toEqual([["text", "one long sentence that has no "]])
  // With no space, all of it.
  const word = pacer({ quiet: NEVER })
  expect(word.push(delta("text", "aaaa"), 0)).toEqual([])
  expect(given(word.push(delta("text", "bbbb"), LONG))).toEqual([["text", "aaaabbbb"]])
})

test("when nothing comes for QUIET, all that is held is given on", () => {
  const pace = pacer()
  expect(pace.push(delta("text", "Half a wor"), 0)).toEqual([])
  expect(pace.tick(QUIET - 1)).toEqual([])
  // A new piece starts the wait again.
  expect(pace.push(delta("text", "d"), QUIET - 1)).toEqual([])
  expect(pace.tick(2 * QUIET - 2)).toEqual([])
  expect(given(pace.tick(2 * QUIET - 1))).toEqual([["text", "Half a word"]])
  expect(pace.tick(NEVER)).toEqual([])
})

test("when the model goes on to another thing, what is held of the one before is given on first", () => {
  const pace = pacer()
  expect(pace.push(delta("thought", "I think about it"), 0)).toEqual([])
  expect(given(pace.push(delta("text", "Hello"), 10))).toEqual([["thought", "I think about it"]])
  expect(given(pace.push(delta("program", "const a"), 20))).toEqual([["text", "Hello"]])
  // The paragraph of the new one that ended in the same piece comes after.
  const both = pacer()
  expect(both.push(delta("thought", "A thought"), 0)).toEqual([])
  expect(given(both.push(delta("text", "A block.\n\nMore"), 10))).toEqual([["thought", "A thought"], ["text", "A block.\n\n"]])
})

test("what is held is dropped when the step's streams are over: EverChat's message, a program's start, the turn's end", () => {
  for (
    const over of [
      message("asst"),
      { type: "call", turn: 1, call: 3, program: "return 1" },
      { type: "end", turn: 1, status: "stopped", why: "Stopped." }
    ] as Array<TurnEvent>
  ) {
    const pace = pacer()
    expect(pace.push(delta("thought", "a thought"), 0)).toEqual([])
    expect(pace.push(delta("text", "a text"), 0).length).toBe(1)
    expect(pace.push(delta("program", "a program"), 0).length).toBe(1)
    expect(pace.push(over, 10)).toEqual([over])
    expect(pace.tick(NEVER)).toEqual([])
    // The next step starts with nothing: no fence is open, and no line is half given.
    expect(given(pace.push(delta("text", "New.\n\n"), 20))).toEqual([["text", "New.\n\n"]])
  }
  // Another message does not end the streams: a note, or a message of the person.
  for (const other of [message("note"), message("user", null), { type: "accepted", messages: [] }, { type: "start", turn: 1 }] as Array<TurnEvent>) {
    const pace = pacer()
    expect(pace.push(delta("text", "a text"), 0)).toEqual([])
    expect(pace.push(other, 10)).toEqual([other])
    expect(given(pace.tick(10 + QUIET))).toEqual([["text", "a text"]])
  }
})

test("code that was open when the step ended is not open in the next step", () => {
  const pace = pacer({ limit: NEVER, quiet: NEVER, long: NEVER })
  expect(pace.push(delta("text", "```\ncode\n"), 0)).toEqual([])
  pace.push(message("asst"), 0)
  expect(given(pace.push(delta("text", "A block.\n\n"), 0))).toEqual([["text", "A block.\n\n"]])
})

test("a program has no paragraphs: it is given on in whole lines, by the time", () => {
  const pace = pacer({ quiet: NEVER })
  expect(pace.push(delta("program", "const a = 1\n\nconst b"), 0)).toEqual([])
  expect(given(pace.push(delta("program", " = 2"), LIMIT))).toEqual([["program", "const a = 1\n\n"]])
  // A sentence end in a line of code is no boundary. At LONG, all of it.
  expect(pace.tick(2 * LIMIT)).toEqual([])
  expect(pace.push(delta("program", " // done. Really"), 2 * LIMIT)).toEqual([])
  expect(given(pace.tick(LIMIT + LONG))).toEqual([["program", "const b = 2 // done. Really"]])
})

test("white space is never given on alone: it goes with the next text", () => {
  const pace = pacer()
  expect(pace.push(delta("text", "\n\n"), 0)).toEqual([])
  expect(pace.tick(NEVER / 2)).toEqual([])
  expect(given(pace.push(delta("text", "Hello.\n\n"), NEVER / 2 + 1))).toEqual([["text", "\n\nHello.\n\n"]])
})

test("the streams of two turns are held apart", () => {
  const pace = pacer()
  expect(pace.push(delta("text", "of one", 1), 0)).toEqual([])
  expect(pace.push(delta("text", "of two", 2), 0)).toEqual([])
  const end: TurnEvent = { type: "end", turn: 1, status: "done", why: null }
  expect(pace.push(end, 10)).toEqual([end])
  expect(pace.tick(QUIET)).toEqual([delta("text", "of two", 2)])
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
        expect(event.delta.trim()).not.toBe("")
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
    expect(out).toBe(whole)
    expect(pace.tick(NEVER)).toEqual([])
  }
})
