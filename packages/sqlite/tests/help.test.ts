// Tests of the root that `newFile` makes when no preload made one: a run
// that does not start at the repository's root, and a plain script, leave
// nothing in the temporary directory. Each row runs a child from this
// package's directory (no bunfig.toml there, so no preload), with an empty
// directory of its own as TMPDIR, and removes that directory after.

import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PACKAGE = path.join(import.meta.dir, "..")

// Runs `args` with Bun: the exit code, what the child printed, and the
// entries that it left in its TMPDIR.
const run = (args: ReadonlyArray<string>) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "help-"))
  try {
    const child = Bun.spawnSync([process.execPath, ...args], {
      cwd: PACKAGE,
      env: { ...process.env, TMPDIR: tmp },
      stdout: "pipe",
      stderr: "pipe"
    })
    const output = child.stdout.toString() + child.stderr.toString()
    return { code: child.exitCode, output, left: fs.readdirSync(tmp) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// The child's count of passed and failed cases.
const counts = (output: string) => ({
  pass: Number(/^\s*(\d+) pass$/m.exec(output)?.[1]),
  fail: Number(/^\s*(\d+) fail$/m.exec(output)?.[1])
})

for (const flags of [[], ["--isolate"]]) {
  test(`bun test${flags.map((flag) => " " + flag).join("")} from the package's directory leaves nothing`, () => {
    const got = run(["test", ...flags, "./tests/help.fixture.ts"])
    expect({ code: got.code, ...counts(got.output) }).toEqual({ code: 0, pass: 1, fail: 0 })
    expect(got.left).toEqual([])
  }, 30_000)
}

test("a plain script that makes a home leaves nothing", () => {
  const script = `import { newFile } from "./tests/help.ts"; require("node:fs").writeFileSync(newFile(), "")`
  const got = run(["-e", script])
  expect({ code: got.code, output: got.code === 0 ? "" : got.output }).toEqual({ code: 0, output: "" })
  expect(got.left).toEqual([])
}, 30_000)
