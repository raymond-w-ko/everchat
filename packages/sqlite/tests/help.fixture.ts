// The fixture of help.test.ts: a test file that makes a new home with
// `newFile`, and writes to it. Its name has no `.test.`, so no run takes it
// by itself: the test runs it as a child, with its own TMPDIR, from this
// package's directory (where Bun reads no bunfig.toml, so no preload).

import { expect, test } from "bun:test"
import fs from "node:fs"
import { newFile } from "./help.ts"

test("a new home, under the root of the run", () => {
  const file = newFile()
  fs.writeFileSync(file, "")
  expect(fs.existsSync(file)).toBe(true)
})
