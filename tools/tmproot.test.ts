// Tests of the temporary root (tmproot.ts): the count of passes that it
// reads from the command line, then that a run of a test file leaves
// nothing in the temporary directory, and each pass of `--rerun-each`, with
// `--isolate` and without, has its root from the file's top on. Each row
// runs `bun test` on tmproot.fixture.ts as a child, from the repository's
// root (so with its preload), with an empty directory of its own as TMPDIR.

import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { passesOf } from "./tmproot.ts"

const ROOT = path.join(import.meta.dir, "..")

test("the count of passes is the flag's whole number, and 1 in each other case", () => {
  const bun = ["bun", "test", "--isolate"]
  expect(passesOf([...bun, "--rerun-each", "20", "a.test.ts"])).toBe(20)
  expect(passesOf([...bun, "--rerun-each=20", "a.test.ts"])).toBe(20)
  // The flag absent, or the command line not read.
  expect(passesOf([...bun, "a.test.ts"])).toBe(1)
  expect(passesOf([])).toBe(1)
  expect(passesOf(undefined)).toBe(1)
  // A value that is no whole number from 1.
  for (const value of ["x", "2.5", "0", "-3", "", "1e3", " 4", "99999999999999999999"]) {
    expect([value, passesOf([...bun, "--rerun-each", value])]).toEqual([value, 1])
    expect([value, passesOf([...bun, "--rerun-each=" + value])]).toEqual([value, 1])
  }
  // The flag as the last word, with no value.
  expect(passesOf([...bun, "--rerun-each"])).toBe(1)
})

// Runs the fixture with `flags`: the exit code, what the child printed,
// and the entries that it left in its TMPDIR.
const run = (flags: ReadonlyArray<string>) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmproot-"))
  const child = Bun.spawnSync(["bun", "test", ...flags, "./tools/tmproot.fixture.ts"], {
    cwd: ROOT,
    env: { ...process.env, TMPDIR: tmp },
    stdout: "pipe",
    stderr: "pipe"
  })
  const output = child.stdout.toString() + child.stderr.toString()
  return { code: child.exitCode, output, left: fs.readdirSync(tmp) }
}

// The child's count of passed and failed cases.
const counts = (output: string) => ({
  pass: Number(/^\s*(\d+) pass$/m.exec(output)?.[1]),
  fail: Number(/^\s*(\d+) fail$/m.exec(output)?.[1])
})

for (const flags of [["--rerun-each", "3"], ["--isolate", "--rerun-each", "3"], ["--isolate", "--rerun-each=3"]]) {
  test(`bun test ${flags.join(" ")}: each pass has its root, and nothing is left`, () => {
    const got = run(flags)
    expect({ code: got.code, ...counts(got.output) }).toEqual({ code: 0, pass: 3, fail: 0 })
    expect(got.output).not.toContain("ENOENT")
    expect(got.left).toEqual([])
  }, 30_000)
}

test("a plain run of the file leaves nothing", () => {
  const got = run([])
  expect({ code: got.code, ...counts(got.output) }).toEqual({ code: 0, pass: 1, fail: 0 })
  expect(got.left).toEqual([])
}, 30_000)
