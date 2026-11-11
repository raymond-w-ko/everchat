// Tests of the paint: what a text becomes on its way to the screen, and the
// rows that each component gives for a width.

import { expect, test } from "bun:test"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { clean, LOOKS, message, MOST, Row, THOUGHT, TOLD, Wrapped, WRITING } from "./paint.ts"

// The rows with no ink: what a person reads.
const read = (rows: ReadonlyArray<string>) => rows.map((row) => stripTerminalSequences(row))

const numbered = (count: number) => Array.from({ length: count }, (_, k) => "row " + k).join("\n")

test("a clean text has no control character but the newline", () => {
  expect(clean("plain text\nsecond row")).toBe("plain text\nsecond row")
  // An escape sequence goes whole: a color, a cursor move, a title, a link.
  expect(clean("\u001b[31mred\u001b[0m \u001b[2J\u001b[10;10Hmoved \u001b]0;a title\u0007named \u001b]8;;https://x.test\u0007link\u001b]8;;\u0007")).toBe("red moved named link")
  expect(clean("a\tb")).toBe("a    b")
  expect(clean("windows\r\nrows\rold mac")).toBe("windows\nrows\nold mac")
  expect(clean("bell\u0007 null\u0000 backspace\u0008 delete\u007f c1\u0085\u009b end")).toBe("bell null backspace delete c1 end")
  // Every character of a text that is not a control character stays.
  expect(clean("é 日本語 😀 ‍ ─ …")).toBe("é 日本語 😀 ‍ ─ …")
  const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/
  for (let code = 0; code < 0x100; code++) {
    expect(controls.test(clean("a" + String.fromCharCode(code) + "b"))).toBe(false)
  }
})

test("a plain text is wrapped to the width, with its mark before the first row only", () => {
  const user = new Wrapped("one two three four five six seven", LOOKS.user)
  expect(read(user.render(16))).toEqual(["› one two three", "  four five six", "  seven"])
  // An empty row of the text stays, and a row never passes the width.
  const rows = new Wrapped("a\n\nb " + "W".repeat(30), LOOKS.echo).render(12)
  expect(read(rows)).toEqual(["◂ a", "", "  b", "  WWWWWWWWWW", "  WWWWWWWWWW", "  WWWWWWWWWW"])
  for (const width of [1, 2, 3, 5, 8, 13, 40]) {
    for (const row of new Wrapped("日本語 and a long " + "x".repeat(50) + " 😀😀😀", LOOKS.user).render(width)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width)
    }
  }
})

test("a text that changes is drawn again, and the same text and width are not", () => {
  const one = new Wrapped("first", TOLD)
  const drawn = one.render(20)
  expect(one.render(20)).toBe(drawn)
  expect(read(drawn)).toEqual(["  first"])
  one.setText("first")
  expect(one.render(20)).toBe(drawn)
  one.setText("second")
  expect(read(one.render(20))).toEqual(["  second"])
  expect(one.render(10)).not.toBe(one.render(20))
  one.invalidate()
  expect(read(one.render(20))).toEqual(["  second"])
})

test("a long program or result keeps its first rows and its last two, and says how many are left out", () => {
  expect(read(new Wrapped(numbered(MOST), LOOKS.echo).render(40)).length).toBe(MOST)
  const rows = read(new Wrapped(numbered(MOST + 1), LOOKS.echo).render(40))
  expect(rows.length).toBe(MOST)
  expect(rows.slice(0, 2)).toEqual(["◂ row 0", "  row 1"])
  expect(rows.slice(MOST - 4)).toEqual(["  row 8", "  … 2 more rows", "  row 11", "  row 12"])
  // The rows shown and the rows left out are all of them.
  expect((MOST - 1) + 2).toBe(MOST + 1)
  const many = read(new Wrapped(numbered(100), LOOKS.tool).render(40))
  expect(many.length).toBe(MOST)
  expect(many[MOST - 3]).toBe("  … 89 more rows")
  // The rows of the screen count, not those of the text: a long row is many.
  expect(read(new Wrapped("x".repeat(400), LOOKS.echo).render(12)).length).toBe(MOST)
})

test("what streams keeps its last rows", () => {
  const rows = read(new Wrapped(numbered(30), WRITING).render(40))
  expect(rows.length).toBe(MOST)
  expect(rows[0]).toBe("▸ … 19 rows above")
  expect(rows.slice(1, 3)).toEqual(["  row 19", "  row 20"])
  expect(rows[MOST - 1]).toBe("  row 29")
  const thought = read(new Wrapped(numbered(30), THOUGHT).render(40))
  expect(thought.length).toBe(6)
  expect(thought[5]).toBe("  row 29")
})

test("each kind has its own look, and a person's or a program's text is never read as markdown", () => {
  expect(read(message("user", "**not bold** `x`").render(40))).toEqual(["› **not bold** `x`"])
  expect(read(message("tool", "return a * b // **").render(40))).toEqual(["▸ return a * b // **"])
  expect(read(message("echo", "# not a title").render(40))).toEqual(["◂ # not a title"])
  expect(read(message("note", "Stopped.").render(40))).toEqual(["· Stopped."])
  expect(read(message("asst", "It is **bold**.").render(40)).map((row) => row.trimEnd())).toEqual(["It is bold."])
  expect(read(message("work", "[CalmOtter] `done`").render(40)).map((row) => row.trimEnd())).toEqual(["[CalmOtter] done"])
  // EverChat's words are cleaned too.
  expect(message("asst", "a \u001b[31mred\u0007 word").render(40).join("")).not.toMatch(/\u001b\[31m|\u0007/)
})

test("the one row of the status is never wrapped: what does not fit is left out", () => {
  const row = new Row()
  row.setText("idle · gpt-test medium")
  expect(row.render(40)).toEqual(["idle · gpt-test medium"])
  expect(read(row.render(10))).toEqual(["idle · gp…"])
  expect(row.render(10).length).toBe(1)
})
