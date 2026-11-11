#!/usr/bin/env bun
// Main
// ====
// The program. It reads its arguments and its environment, it puts the
// parts together, and it runs the terminal until the person quits or a
// signal ends it.
//
// Usage: USAGE (`everchat --help` prints it).
//
// The parts, from the lowest
//
//   the database, the store        one launch owns the home's file
//   the diagnostics                Effect's logger, to the table `log`
//   the inference gateway, the wire, the cache watch, the ask service
//   the compactor, the memory
//   the output limit, the shell, the functions, the sandbox
//   the turn loop
//   the terminal
//
// The diagnostics' layer is under every other layer but the store, and it
// is merged into what each one gets, so that every fiber logs to the
// table (diagnostics.ts says why).
//
// How the program ends
//
// - The person quits (terminal.ts), or the process gets SIGTERM, SIGHUP
//   (its terminal closed) or SIGINT. Then the parts close, in the reverse
//   order: the terminal gives the screen back, the turn loop leaves a turn
//   that runs for the next launch, the shell stops its commands, and the
//   store ends the launch.
// - Then the process exits, and it does not wait for worker threads: a
//   stop of a program is only a request to its thread (sandbox.ts).
// - A second signal while the parts close ends the process at once. The
//   next launch then finds a crash, and cleans up.
//
// What it writes to the standard error
//
// The rule is that EverChat writes nothing to the standard output or the
// standard error, because a line there breaks the screen. This module has
// the two exceptions, both at a time when the screen is not up: the usage,
// and the reason why the program could not start or go on.
//
// Not here yet: the config file. Until then the picks come from the
// arguments, with fixed defaults.

import { Cause, Effect, Layer, Runtime } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseArgs } from "node:util"
import { Ask } from "./ask.ts"
import { Cache } from "./cache.ts"
import * as Compactor from "./compactor.ts"
import * as Database from "./database.ts"
import * as Diagnostics from "./diagnostics.ts"
import { Functions } from "./functions.ts"
import { Gateway } from "./gateway.ts"
import { Limit } from "./limit.ts"
import { Memory } from "./memory.ts"
import { OpenAI } from "./openai.ts"
import { Sandbox } from "./sandbox.ts"
import { Shell } from "./shell.ts"
import { type Pick, Store } from "./store.ts"
import { Terminal } from "./terminal.ts"
import { Turns } from "./turn.ts"

export const VERSION = "0.1.0"

// The variable that names the home, and the home when it is not set.
export const HOME_VARIABLE = "EVERCHAT_HOME"
export const HOME = path.join(os.homedir(), ".everchat")

// The picks when no argument gives them.
export const MODEL = "gpt-6.1-sol"
export const EFFORT = "medium"
export const COMPACTOR = "gpt-6-luna"

export const USAGE = `Usage: everchat [--model <model>] [--effort <effort>] [--compactor <model>]

EverChat: one chat that never ends, in a terminal.

  --model <model>       the model of the turns (default ${MODEL})
  --effort <effort>     its reasoning effort (default ${EFFORT})
  --compactor <model>   the model of the compactions (default ${COMPACTOR})
  --version             prints the version
  --help                prints this text

The chat is in the home: the directory that ${HOME_VARIABLE} names
(default ~/.everchat). Another home is another chat.
`

// The whole program for one launch.
export const layer = (given: { readonly home: string; readonly cwd: string; readonly pick: Pick | undefined; readonly compactor: Pick }) => {
  const launch = { pid: process.pid, host: os.hostname(), cwd: given.cwd, version: VERSION, runTag: crypto.randomUUID(), pick: given.pick }
  const base = Diagnostics.layer.pipe(
    Layer.provideMerge(Store.layer(path.join(given.home, Database.FILE), { launch, pick: given.pick ?? { vendor: "openai", model: MODEL, effort: EFFORT, speed: "slow" } }))
  )
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, OpenAI.layer.pipe(Layer.provide(Gateway.layer)))), Layer.provideMerge(base))
  const memory = Memory.layer.pipe(Layer.provide(Compactor.layer({ pick: given.compactor })), Layer.provideMerge(asking))
  const limits = Limit.layer().pipe(Layer.provideMerge(memory))
  const shell = Shell.layer({ cwd: given.cwd }).pipe(Layer.provideMerge(limits))
  const functions = Functions.layer({ cwd: given.cwd }).pipe(Layer.provideMerge(shell))
  const sandbox = Sandbox.layer().pipe(Layer.provideMerge(functions))
  const turns = Turns.layer().pipe(Layer.provideMerge(sandbox))
  return Terminal.layer({ cwd: given.cwd }).pipe(Layer.provideMerge(turns))
}

// What a failure says to the person, in one row.
const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { readonly _tag: string; readonly message?: unknown; readonly op?: unknown; readonly pid?: unknown; readonly cause?: unknown }
    if (tagged._tag === "LaunchLive") {
      return "another EverChat (process " + String(tagged.pid) + ") has this chat open. One chat is one process."
    }
    if (tagged._tag === "StoreError") {
      return "the database failed (" + String(tagged.op) + "): " + (tagged.cause instanceof Error ? tagged.cause.message : String(tagged.cause))
    }
    if (typeof tagged.message === "string" && tagged.message !== "") {
      return tagged.message
    }
  }
  return error instanceof Error ? error.message : String(error)
}

const say = (text: string) => void process.stderr.write(text)

// Runs `program` as the process: a signal interrupts it, and the process
// exits when it has ended.
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let asked = false
  const stop = () => {
    if (asked) {
      process.exit(1)
    }
    asked = true
    fiber.interruptUnsafe(fiber.id)
  }
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop)
  process.on("SIGINT", stop)
  fiber.addObserver((exit) => teardown(exit, (code) => process.exit(code)))
})

const main = () => {
  let args: { model?: string | undefined; effort?: string | undefined; compactor?: string | undefined; version?: boolean | undefined; help?: boolean | undefined }
  try {
    args = parseArgs({
      args: process.argv.slice(2),
      options: { model: { type: "string" }, effort: { type: "string" }, compactor: { type: "string" }, version: { type: "boolean" }, help: { type: "boolean" } },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    say("everchat: " + (error instanceof Error ? error.message : String(error)) + "\n\n" + USAGE)
    process.exit(2)
  }
  if (args.help === true) {
    say(USAGE)
    process.exit(0)
  }
  if (args.version === true) {
    say("everchat " + VERSION + "\n")
    process.exit(0)
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    say("everchat: the standard input and the standard output must be a terminal.\n")
    process.exit(2)
  }
  const home = process.env[HOME_VARIABLE] === undefined || process.env[HOME_VARIABLE] === "" ? HOME : path.resolve(process.env[HOME_VARIABLE])
  // The model and the effort of this launch only: with none, the chat's own pick.
  const pick: Pick | undefined = args.model === undefined && args.effort === undefined
    ? undefined
    : { vendor: "openai", model: args.model ?? MODEL, effort: args.effort ?? EFFORT, speed: "slow" }
  const compactor: Pick = { vendor: "openai", model: args.compactor ?? COMPACTOR, effort: "low", speed: "slow" }

  const program = Effect.gen(function*() {
    yield* Effect.try(() => fs.mkdirSync(home, { recursive: true, mode: 0o700 }))
    yield* Terminal.use((terminal) => terminal.quit).pipe(Effect.provide(layer({ home, cwd: process.cwd(), pick, compactor })))
  }).pipe(
    // The screen is given back by now.
    Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(() => say("everchat: " + reason(cause) + "\n"))))
  )
  runMain(program, { disableErrorReporting: true })
}

if (import.meta.main) {
  main()
}
