// Tests of the output limit: what is shortened, what the line between the
// head and the tail says, and where the whole text goes.

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { newFile, options } from "../tests/help.ts"
import { capped, Limit, LIMIT, shorten } from "./limit.ts"
import { Store } from "./store.ts"

const withLimit = <A, E>(file: string, effect: Effect.Effect<A, E, Limit | Store>, over: { limit?: number; dir?: string } = {}) => {
  const store = Store.layer(file, options())
  const limit = Limit.layer({ dir: path.join(path.dirname(file), "results"), ...over }).pipe(Layer.provideMerge(store))
  return Effect.runPromise(effect.pipe(Effect.provide(limit)))
}

test("a text within the limit is shown whole", () => {
  const text = "x".repeat(LIMIT)
  expect(shorten(text, LIMIT, "where")).toBe(text)
})

test("a text over the limit keeps its head and its tail, and says what was left out", () => {
  const text = "H".repeat(10000) + "m".repeat(80000) + "T".repeat(10000)
  const short = shorten(text, 20000, "Read it there.")
  expect(short.length).toBeLessThanOrEqual(20000)
  expect(short.startsWith("H".repeat(10000) + "\n[... ")).toBe(true)
  expect(short.endsWith(" ...]\n" + "T".repeat(9488))).toBe(true)
  // The numbers are true: the head, the part left out, and the tail are the whole text.
  const [, out, total] = /\[\.\.\. (\d+) of (\d+) characters left out\. Read it there\. \.\.\.\]/.exec(short)!
  expect(Number(total)).toBe(text.length)
  expect(10000 + Number(out) + 9488).toBe(text.length)
})

test("a cut never parts the two halves of one character", () => {
  // Each of these characters is two UTF-16 units.
  const text = "😀".repeat(5000)
  // With one letter before them, a cut at an even place parts a character:
  // the first limit puts the head's end there, the second the tail's start.
  for (const limit of [3001, 3002]) {
    const short = shorten("a" + text, limit, "w")
    expect(short.isWellFormed()).toBe(true)
    expect(short.length).toBeLessThanOrEqual(limit)
    expect(short.replace(/\n\[.*\]\n/, "").replace("a", "").replaceAll("😀", "")).toBe("")
  }
  expect(capped(text, 10).isWellFormed()).toBe(true)
  expect(capped(text, 10)).toBe("😀😀")
  expect(capped("abc", 10)).toBe("abc")
  expect(Buffer.byteLength(capped("é".repeat(100), 51))).toBe(50)
})

test("a short result has no file, and its bytes are counted", async () => {
  const file = newFile()
  await withLimit(file, Effect.gen(function*() {
    const limit = yield* Limit
    expect(yield* limit.show(7, "héllo")).toEqual({ text: "héllo", shown: 6 })
    expect(fs.existsSync(limit.file(7))).toBe(false)
  }))
})

test("a long result is shortened, and its whole text is in a file that only the owner can read", async () => {
  const file = newFile()
  await withLimit(file, Effect.gen(function*() {
    const limit = yield* Limit
    const text = Array.from({ length: 2000 }, (_, k) => "line " + k).join("\n")
    const seen = yield* limit.show(7, text)
    expect(seen.text.length).toBeLessThanOrEqual(1000)
    expect(seen.shown).toBe(Buffer.byteLength(seen.text))
    expect(seen.text).toContain("The whole result is in the file " + limit.file(7) + ", and result(7) gives it to a program.")
    expect(fs.readFileSync(limit.file(7), "utf8")).toBe(text)
    expect(fs.statSync(limit.file(7)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(limit.file(7))).mode & 0o777).toBe(0o700)
  }), { limit: 1000 })
})

test("a directory that others can enter is not used: the result names only result(id)", async () => {
  const file = newFile()
  const dir = path.join(path.dirname(file), "open")
  fs.mkdirSync(dir, { mode: 0o777 })
  fs.chmodSync(dir, 0o777)
  await withLimit(file, Effect.gen(function*() {
    const limit = yield* Limit
    const seen = yield* limit.show(3, "y".repeat(5000))
    expect(seen.text).toContain("result(3) gives the whole result to a program.")
    expect(seen.text).not.toContain("file")
    expect(fs.existsSync(limit.file(3))).toBe(false)
    expect(yield* limit.put(3, "text")).toBe(false)
  }), { limit: 1000, dir })
})

test("with no directory given, the files are under the system's temporary directory, by user and by chat", async () => {
  const file = newFile()
  await withLimit(file, Effect.gen(function*() {
    const limit = yield* Limit
    const uuid = (yield* Store.use((store) => store.chat)).uuid
    expect(limit.file(12).endsWith(path.join("everchat-" + process.getuid!(), uuid, "12.txt"))).toBe(true)
  }), { dir: undefined as unknown as string })
})
