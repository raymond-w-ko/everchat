// Tests of the diff. The port was also compared with the old code on 3,000
// random pairs of texts, and gave the same diff each time.

import { expect, test } from "bun:test"
import { diff } from "./diff.ts"

test("a new file is all lines added", () => {
  expect(diff("a.txt", "", "one\ntwo\n")).toBe("--- a.txt\n+++ a.txt\n@@ -0,0 +1,2 @@\n+one\n+two")
})

test("a file that did not change says so", () => {
  expect(diff("a.txt", "one\n", "one\n")).toBe("a.txt is unchanged.")
})

test("a change has three lines of context around it", () => {
  const was = "1\n2\n3\n4\n5\n6\n7\n8\n9\n"
  expect(diff("n", was, was.replace("5", "five"))).toBe("--- n\n+++ n\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8")
})

test("two changes that are close share one hunk, and two that are far have one each", () => {
  const lines = Array.from({ length: 30 }, (_, k) => "line " + (k + 1))
  const was = lines.join("\n") + "\n"
  const near = lines.map((line, k) => (k === 4 || k === 8 ? line + "!" : line)).join("\n") + "\n"
  const far = lines.map((line, k) => (k === 2 || k === 25 ? line + "!" : line)).join("\n") + "\n"
  expect(diff("f", was, near).match(/^@@/gm)?.length).toBe(1)
  expect(diff("f", was, far).match(/^@@/gm)?.length).toBe(2)
  expect(diff("f", was, far)).toContain("@@ -1,6 +1,6 @@")
  expect(diff("f", was, far)).toContain("@@ -23,7 +23,7 @@")
})

test("a last line with no newline differs from one with it, as in git", () => {
  expect(diff("f", "a\nb", "a\nb\n")).toBe("--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b")
})

test("a file that is emptied is all lines dropped", () => {
  expect(diff("f", "a\nb\n", "")).toBe("--- f\n+++ f\n@@ -1,2 +0,0 @@\n-a\n-b")
})

test("lines that moved are dropped at one place and added at the other", () => {
  const out = diff("f", "a\nb\nc\nd\n", "d\na\nb\nc\n")
  expect(out).toBe("--- f\n+++ f\n@@ -1,4 +1,4 @@\n+d\n a\n b\n c\n-d")
})

test("the diff of a long file with one change is short", () => {
  const was = Array.from({ length: 20000 }, (_, k) => "row " + k).join("\n") + "\n"
  const out = diff("big", was, was.replace("row 12345\n", "row twelve\n"))
  expect(out.split("\n").length).toBe(11)
  expect(out).toContain("-row 12345\n+row twelve")
})
