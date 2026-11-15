// Tests of the file functions: `read`, `write` and `edit`.

import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { edit, read, write } from "./files.ts"

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "everchat-files-"))
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fails = async <A, E>(effect: Effect.Effect<A, E>) => {
  const got = await Effect.runPromise(Effect.result(effect))
  return got._tag === "Failure" ? (got.failure as { message: string }).message : "it did not fail"
}

test("read gives the content exactly, so that a program can parse it", async () => {
  const cwd = dir()
  fs.writeFileSync(path.join(cwd, "a.json"), "{\"a\": 1}\n")
  expect(await run(read(cwd, "a.json"))).toBe("{\"a\": 1}\n")
  fs.writeFileSync(path.join(cwd, "none.txt"), "no newline")
  expect(await run(read(cwd, "none.txt"))).toBe("no newline")
  expect(await run(read(cwd, path.join(cwd, "a.json")))).toBe("{\"a\": 1}\n")
})

test("read gives lines from an offset, and at most a limit of them", async () => {
  const cwd = dir()
  fs.writeFileSync(path.join(cwd, "f"), "a\nb\nc\nd\n")
  expect(await run(read(cwd, "f", 2))).toBe("b\nc\nd")
  expect(await run(read(cwd, "f", 2, 2))).toBe("b\nc")
  expect(await run(read(cwd, "f", undefined, 1))).toBe("a")
  expect(await fails(read(cwd, "f", 9))).toBe("No lines from line 9: the file has 4.")
  expect(await fails(read(cwd, "f", 2, 0))).toBe("No lines from line 2: the file has 4.")
})

test("read refuses a binary file, and says why a file cannot be read", async () => {
  const cwd = dir()
  fs.writeFileSync(path.join(cwd, "bin"), new Uint8Array([1, 0, 2]))
  expect(await fails(read(cwd, "bin"))).toBe("A binary file of 3 bytes.")
  expect(await fails(read(cwd, "missing"))).toContain("no such file or directory")
  expect(await fails(read(cwd, "."))).toContain("directory")
})

test("write makes the directories, and answers with a diff", async () => {
  const cwd = dir()
  expect(await run(write(cwd, "deep/er/a.txt", "one\n"))).toBe("--- deep/er/a.txt\n+++ deep/er/a.txt\n@@ -0,0 +1,1 @@\n+one")
  expect(fs.readFileSync(path.join(cwd, "deep/er/a.txt"), "utf8")).toBe("one\n")
  expect(await run(write(cwd, "deep/er/a.txt", "two\n"))).toBe("--- deep/er/a.txt\n+++ deep/er/a.txt\n@@ -1,1 +1,1 @@\n-one\n+two")
  expect(await run(write(cwd, "deep/er/a.txt", "two\n"))).toBe("deep/er/a.txt is unchanged.")
})

test("edit replaces text that matches once, in order, and answers with each file's diff", async () => {
  const cwd = dir()
  fs.writeFileSync(path.join(cwd, "a"), "red\ngreen\n")
  fs.writeFileSync(path.join(cwd, "b"), "x x\n")
  const out = await run(edit(cwd, [
    { path: "a", old: "red", new: "blue" },
    // The second edit of a file sees what the first one left.
    { path: "a", old: "blue\ngreen", new: "blue\nteal" },
    { path: "b", old: "x", new: "y", all: true }
  ]))
  expect(fs.readFileSync(path.join(cwd, "a"), "utf8")).toBe("blue\nteal\n")
  expect(fs.readFileSync(path.join(cwd, "b"), "utf8")).toBe("y y\n")
  expect(out).toBe("--- a\n+++ a\n@@ -1,2 +1,2 @@\n-red\n-green\n+blue\n+teal\n--- b\n+++ b\n@@ -1,1 +1,1 @@\n-x x\n+y y")
})

test("an edit that fails changes no file", async () => {
  const cwd = dir()
  fs.writeFileSync(path.join(cwd, "a"), "red\n")
  fs.writeFileSync(path.join(cwd, "b"), "x x\n")
  const twice = await fails(edit(cwd, [{ path: "a", old: "red", new: "blue" }, { path: "b", old: "x", new: "y" }]))
  expect(twice).toBe("Edit 2 (b): old matches 2 times; give more context, or all. No file was changed.")
  expect(fs.readFileSync(path.join(cwd, "a"), "utf8")).toBe("red\n")
  expect(await fails(edit(cwd, [{ path: "a", old: "pink", new: "blue" }]))).toBe("Edit 1 (a): old was not found. No file was changed.")
  expect(await fails(edit(cwd, [{ path: "none", old: "a", new: "b" }]))).toBe("Edit 1 (none): no such file. No file was changed.")
  expect(await fails(edit(cwd, [{ path: "a", old: "", new: "b" }]))).toBe("Edit 1 (a): old was not found. No file was changed.")
  expect(await fails(edit(cwd, []))).toBe("edits is empty: give a list of {path, old, new}.")
})
