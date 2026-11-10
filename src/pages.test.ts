// Tests of the pages of a long text.

import { expect, test } from "bun:test"
import { PAGE, page, pageEnd, pages } from "./pages.ts"

test("a text of at most PAGE characters is one page, and an empty text is one empty page", () => {
  expect(pages("")).toEqual([""])
  expect(pages("short")).toEqual(["short"])
  expect(pages("x".repeat(PAGE))).toEqual(["x".repeat(PAGE)])
})

test("the pages of a text, joined, are the text", () => {
  const text = Array.from({ length: 5000 }, (_, n) => "line " + n + " é😀").join("\n")
  const all = pages(text)
  expect(all.join("")).toBe(text)
  expect(all.length).toBeGreaterThan(1)
  expect(all.every((one) => one.length <= PAGE)).toBe(true)
  // Each page but the last ends after a newline.
  expect(all.slice(0, -1).every((one) => one.endsWith("\n"))).toBe(true)
})

test("a page with no newline ends where a character ends", () => {
  const text = "x".repeat(PAGE - 1) + "😀" + "y".repeat(10) // the emoji's two halves are at PAGE - 1 and PAGE
  expect(pageEnd(text, 0)).toBe(PAGE - 1)
  expect(pages(text)).toEqual(["x".repeat(PAGE - 1), "😀" + "y".repeat(10)])
  expect(pages("x".repeat(PAGE + 1))).toEqual(["x".repeat(PAGE), "x"])
})

test("a page from the middle of a text says where to go on", () => {
  const text = "a".repeat(PAGE) + "b".repeat(PAGE) + "c".repeat(5)
  expect(page(text, 0)).toBe("a".repeat(PAGE) + "\n[characters 1-30000 of 60005; go on with at 30000]")
  expect(page(text, PAGE)).toBe("b".repeat(PAGE) + "\n[characters 30001-60000 of 60005; go on with at 60000]")
  expect(page(text, 2 * PAGE)).toBe("ccccc")
})
