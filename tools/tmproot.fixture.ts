// The fixture of tools/tmproot.test.ts: a test file that makes a
// directory under `os.tmpdir()` at its top, before any hook of a pass,
// and another in its one case. Its name has no `.test.`, so no run takes
// it by itself: the test runs it as a child, with its own TMPDIR.

import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const top = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-x-"))

test("a directory under the temporary root, at the file's top and in a case", () => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-x-"))
  fs.writeFileSync(path.join(made, "a.txt"), "a")
  expect(fs.existsSync(top)).toBe(true)
  expect(path.dirname(made)).toBe(path.dirname(top))
})
