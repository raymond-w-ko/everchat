// Tests of the pages of a long text.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { PAGE, page, pageEnd, pages } from "./pages.ts"

test("a text of at most PAGE characters is one page, and an empty text is one empty page", () => {
  assert.deepStrictEqual(pages(""), [""])
  assert.deepStrictEqual(pages("short"), ["short"])
  assert.deepStrictEqual(pages("x".repeat(PAGE)), ["x".repeat(PAGE)])
})

test("the pages of a text, joined, are the text", () => {
  const text = Array.from({ length: 5000 }, (_, n) => "line " + n + " é😀").join("\n")
  const all = pages(text)
  assert.equal(all.join(""), text)
  assert.ok(all.length > 1)
  assert.equal(all.every((one) => one.length <= PAGE), true)
  // Each page but the last ends after a newline.
  assert.equal(all.slice(0, -1).every((one) => one.endsWith("\n")), true)
})

test("a page with no newline ends where a character ends", () => {
  const text = "x".repeat(PAGE - 1) + "😀" + "y".repeat(10) // the emoji's two halves are at PAGE - 1 and PAGE
  assert.equal(pageEnd(text, 0), PAGE - 1)
  assert.deepStrictEqual(pages(text), ["x".repeat(PAGE - 1), "😀" + "y".repeat(10)])
  assert.deepStrictEqual(pages("x".repeat(PAGE + 1)), ["x".repeat(PAGE), "x"])
})

test("a page from the middle of a text says where to go on", () => {
  const text = "a".repeat(PAGE) + "b".repeat(PAGE) + "c".repeat(5)
  assert.equal(page(text, 0), "a".repeat(PAGE) + "\n[characters 1-30000 of 60005; go on with at 30000]")
  assert.equal(page(text, PAGE), "b".repeat(PAGE) + "\n[characters 30001-60000 of 60005; go on with at 60000]")
  assert.equal(page(text, 2 * PAGE), "ccccc")
})
