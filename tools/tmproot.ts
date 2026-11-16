// Temporary root
// ==============
// The preload of every test run (`bunfig.toml`, `[test]`): the tests make
// their temporary files under one directory of their own, and that
// directory is removed at the end. Without it, each case that makes a
// directory with `os.tmpdir()` leaves it in the machine's temporary
// directory for good.
//
// At its load, this file makes one directory, the root, under
// `os.tmpdir()`, and sets `TMPDIR` to it. Bun's `os.tmpdir()` reads
// `TMPDIR` at each call, so each later call of the run gives the root,
// with no change of the file that calls it.
//
// The rule: whoever made a root removes it, with all that it holds, at
// each end that it can see. The removal is synchronous, and a fault of it
// changes nothing of the run's result.
//
// - The end of the file's cases, as they passed or failed, and also when
//   the file threw outside a case: an `afterAll` of this file, which runs
//   after the file's own. `bun test` runs no `exit` or `beforeExit`
//   listener of a preload, so no such listener can do it.
// - SIGINT and SIGTERM: the listener removes the root, then ends the
//   process with the same signal, so its exit code is the signal's usual
//   one.
// - SIGKILL ends the process before anything runs: the root stays, one
//   directory for the file, not one for each case.
//
// When it runs: `just test` runs `bun test --isolate`, which loads this
// file again for each test file, in the same process, with a new global
// state and `process.env` as at the start. So each test file has its own
// root, made at its load and removed at its end. A plain `bun test` loads
// it once: one root for the run.
//
// A child process: `env: process.env` (or a copy of it) passes the root
// on, and so do the `node:child_process` functions with no `env`.
// `Bun.spawn` and `Bun.spawnSync` with no `env` give the child the
// environment that the process started with, without the root.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll } from "bun:test"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-run-"))
process.env.TMPDIR = root

const remove = (): void => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // The run's result stands: a root that stays is no failure of a case.
  }
}

afterAll(remove)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const end = (): void => {
    remove()
    process.removeListener(signal, end)
    process.kill(process.pid, signal)
  }
  process.on(signal, end)
}
