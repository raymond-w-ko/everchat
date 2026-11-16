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
// A file that runs more than one time (`--rerun-each N`), as measured on
// Bun 1.4.4: Bun runs the file's top again for each pass, before any hook
// of a pass, and does not load this file again. With `--isolate`, this
// file's `afterAll` runs at the end of each pass of each file; without it,
// at the end of each pass of the last file only. So the root must be there
// again when the `afterAll` of a pass ends: it is emptied and made again,
// and only the last `afterAll` removes it. No hook and no timer tells the
// last pass from the others (a tick, a microtask and an immediate run
// after each of them, the last too), and `process.argv` does not hold the
// flag. So the count of passes is read from the process's command line,
// where the system gives it (`/proc/self/cmdline`, on Linux; `passesOf`).
// Where it cannot be read, or the flag holds no whole number, the count is
// 1, so a normal run leaves nothing on each system (lead, ec-h8l1e,
// ruling 3). Two risks are accepted with it:
//
// - On Linux, a file that throws at its top under `--rerun-each` leaves one
//   empty root: Bun runs only its first pass, and the root was made again
//   for a second.
// - Off Linux, `--rerun-each` is not held: its later passes fail with
//   ENOENT, as before this rule, and leave nothing.
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

// The count of passes of `--rerun-each` in the command line `args`
// (`--rerun-each N` or `--rerun-each=N`): 1 when there is no such flag,
// when its value is no whole number from 1, and when the command line
// could not be read (`undefined`).
export const passesOf = (args: ReadonlyArray<string> | undefined): number => {
  for (const [at, arg] of (args ?? []).entries()) {
    const value = arg === "--rerun-each" ? args?.[at + 1] : arg.startsWith("--rerun-each=") ? arg.slice("--rerun-each=".length) : undefined
    if (value !== undefined) {
      const count = /^\d+$/.test(value) ? Number(value) : Number.NaN
      return Number.isSafeInteger(count) && count >= 1 ? count : 1
    }
  }
  return 1
}

const passes = passesOf((() => {
  try {
    return fs.readFileSync("/proc/self/cmdline", "utf8").split("\0")
  } catch {
    return undefined
  }
})())

const remove = (): void => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // The run's result stands: a root that stays is no failure of a case.
  }
}

let ended = 0
afterAll(() => {
  ended += 1
  remove()
  if (ended < passes) {
    try {
      // The next pass runs its file's top before any hook.
      fs.mkdirSync(root, { mode: 0o700 })
    } catch {
      // As above: a pass with no root fails its own cases, nothing more.
    }
  }
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const end = (): void => {
    remove()
    process.removeListener(signal, end)
    process.kill(process.pid, signal)
  }
  process.on(signal, end)
}
