#!/usr/bin/env bun
// Main
// ====
// The program. It reads its arguments and its environment, it puts the
// parts together, and it runs one interface until the person quits, the
// input ends, or a signal ends the process.
//
// `everchat --help` prints the usage. The arguments are read with Effect's
// own module (`effect/cli`), so the help, the version, the completions for
// a shell and the errors of an argument come from there.
//
// `everchat inspect` does not start the chat. It serves the inspector: a
// page in a browser that shows the state of the chat in the home (the log,
// the tree, the views, each turn's request, the usage). It only reads the
// database, so it runs next to a launch of the chat, or with none. It
// prints the page's address, and it runs until a signal ends it.
//
// The two interfaces
//
// - The terminal (terminal.ts), when the standard input and the standard
//   output are both a terminal.
// - Pipe mode (pipe.ts), when one of them is not: each line of the
//   standard input is a message, and each message goes to the standard
//   output as text.
//
// The parts, from the lowest
//
//   the database, the store        one launch owns the home's file
//   the diagnostics                Effect's logger, to the table `log`
//   the inference gateway, the wire, the cache watch, the ask service
//   the compactor, the memory
//   the output limit, the shell, the functions, the sandbox
//   the turn loop
//   the terminal, or pipe mode
//
// The diagnostics' layer is under every other layer but the store, and it
// is merged into what each one gets, so that every fiber logs to the
// table (diagnostics.ts says why).
//
// What runs outside that layer (this module, `effect/cli`, and the store
// while it opens the database) has no logger at all: QUIET takes the place
// of Effect's default logger, which writes to the console. So a line that
// is logged there is dropped. `--log-level debug` showed why this is
// needed: the database's migrator then logs a line, and it went to the
// standard output.
//
// How the program ends
//
// - The person quits (terminal.ts), the input ends (pipe.ts), or the
//   process gets SIGTERM, SIGHUP (its terminal closed) or SIGINT. Then the
//   parts close, in the reverse order: the terminal gives the screen back,
//   the turn loop leaves a turn that runs for the next launch, the shell
//   stops its commands, and the store ends the launch.
// - Then the process exits, and it does not wait for worker threads: a
//   stop of a program is only a request to its thread (sandbox.ts).
// - A second signal while the parts close ends the process at once. The
//   next launch then finds a crash, and cleans up.
//
// Effect's own runner for Bun (`BunRuntime.runMain`) is not used, for
// those rules: it does not hear SIGHUP, it has no second signal, and after
// a clean end it waits for all threads.
//
// The exit code: 0 for a clean end, 1 for a failure (also a turn that
// failed in pipe mode), 2 for a wrong argument, 130 for a signal.
//
// What it writes to the standard error
//
// The rule is that EverChat writes nothing to the standard output or the
// standard error, because a line there breaks the screen. This module
// writes only when the screen is not up: the usage and what else
// `effect/cli` prints for an argument, and the reason why the program
// could not start or go on. Pipe mode's output is pipe.ts's own.
//
// Not here yet: the config file. Until then the picks come from the
// arguments, with fixed defaults.

// Only this module of the package: its index loads all of it (an HTTP
// server, sockets, a cluster), and each start would pay for that.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Config, Console, Effect, Exit, FileSystem, Layer, Logger, Option, Path, Runtime, Schema, Stdio } from "effect"
import { CliConfig, CliError, Command, Flag, GlobalFlag } from "effect/cli"
import * as os from "node:os"
import { Ask } from "./ask.ts"
import { Cache } from "./cache.ts"
import * as Compactor from "./compactor.ts"
import * as Database from "./database.ts"
import * as Diagnostics from "./diagnostics.ts"
import { Functions } from "./functions.ts"
import { Inspect } from "./inspect.ts"
import { Gateway } from "./gateway.ts"
import { Limit } from "./limit.ts"
import { Memory } from "./memory.ts"
import { OpenAI } from "./openai.ts"
import { Pipe } from "./pipe.ts"
import { Sandbox } from "./sandbox.ts"
import { Shell } from "./shell.ts"
import { type Pick, Reads, Store } from "./store.ts"
import { Terminal } from "./terminal.ts"
import { Turns } from "./turn.ts"

export const VERSION = "0.1.0"

// The variable that names the home, and the home's name in the person's
// own directory when it is not set.
export const HOME_VARIABLE = "EVERCHAT_HOME"
export const HOME = ".everchat"

// The picks when no argument gives them.
export const MODEL = "gpt-6.1-sol"
export const EFFORT = "medium"
export const COMPACTOR = "gpt-6-luna"

// The inspector's port when no argument gives one.
export const INSPECT_PORT = 4680

export const ABOUT = `EverChat: one chat that never ends.

In a terminal, it shows the chat and reads the keys. With no terminal (the
standard input or the standard output is a pipe or a file), it works in pipe
mode: each line of the standard input is a message, and each message goes to
the standard output as text.

The chat is in the home: the directory that ${HOME_VARIABLE} names (default
~/${HOME}). Another home is another chat.`

export const ABOUT_INSPECT = `Serves the inspector: a page in a browser that shows the state of the chat in
the home. It shows the log, the tree, the views, each turn's request, and the
usage. It only reads the database, so it can run while EverChat runs, and it
changes nothing.

It prints the page's address. The address holds a token that is new at each
start: only who has the address can read the chat. The server listens on this
machine only (127.0.0.1).`

// The program but its interface, for one launch.
export const layer = (given: { readonly home: string; readonly file: string; readonly cwd: string; readonly pick: Pick | undefined; readonly compactor: Pick }) => {
  const launch = { pid: process.pid, host: os.hostname(), cwd: given.cwd, version: VERSION, runTag: crypto.randomUUID(), pick: given.pick }
  const base = Diagnostics.layer.pipe(
    Layer.provideMerge(Store.layer(given.file, { launch, pick: given.pick ?? { vendor: "openai", model: MODEL, effort: EFFORT, speed: "slow" } }))
  )
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, OpenAI.layer.pipe(Layer.provide(Gateway.layer)))), Layer.provideMerge(base))
  const memory = Memory.layer.pipe(Layer.provide(Compactor.layer({ pick: given.compactor })), Layer.provideMerge(asking))
  const limits = Limit.layer().pipe(Layer.provideMerge(memory))
  const shell = Shell.layer({ cwd: given.cwd }).pipe(Layer.provideMerge(limits))
  const functions = Functions.layer({ cwd: given.cwd }).pipe(Layer.provideMerge(shell))
  const sandbox = Sandbox.layer().pipe(Layer.provideMerge(functions))
  return Turns.layer().pipe(Layer.provideMerge(sandbox))
}

// Pipe mode ended, and a turn of this launch had failed. The output holds
// the turn's note, so nothing more is said: only the exit code tells it.
export class TurnFailed extends Schema.TaggedError<TurnFailed>()("TurnFailed", {}) {}

// What a failure says to the person, in one row.
const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { readonly _tag: string; readonly message?: unknown; readonly op?: unknown; readonly pid?: unknown; readonly cause?: unknown }
    if (tagged._tag === "LaunchLive") {
      return "another EverChat (process " + String(tagged.pid) + ") has this chat open. One chat is one process."
    }
    if (tagged._tag === "DatabaseVersion") {
      const { have, want } = tagged as unknown as { readonly have: number; readonly want: number }
      return have < want
        ? "the database is from an older EverChat. Start EverChat once on this home: it brings the database up to date."
        : "the database is from a newer EverChat than this program."
    }
    if (tagged._tag === "NoPort") {
      return String(tagged.message) + ". Give another port with --port."
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

// The home's directory.
const homeOf = Effect.gen(function*() {
  const path = yield* Path.Path
  // An empty variable is as none: Effect's config reads it so.
  const named = yield* Config.option(Config.String(HOME_VARIABLE))
  return Option.match(named, { onNone: () => path.join(os.homedir(), HOME), onSome: (name) => path.resolve(name) })
})

// One launch: the home, the picks, and then the interface that fits.
const launch = Effect.fnUntraced(function*(given: { readonly model: Option.Option<string>; readonly effort: Option.Option<string>; readonly compactor: string }) {
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* homeOf
  // The home holds the chat: no other account may read it.
  yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 })
  // The model and the effort of this launch only: with none, the chat's own pick.
  const pick: Pick | undefined = Option.isNone(given.model) && Option.isNone(given.effort)
    ? undefined
    : { vendor: "openai", model: Option.getOrElse(given.model, () => MODEL), effort: Option.getOrElse(given.effort, () => EFFORT), speed: "slow" }
  const compactor: Pick = { vendor: "openai", model: given.compactor, effort: "low", speed: "slow" }
  const cwd = process.cwd()
  const parts = layer({ home, file: path.join(home, Database.FILE), cwd, pick, compactor })

  if ((yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal)) {
    return yield* Terminal.use((terminal) => terminal.quit).pipe(Effect.provide(Terminal.layer({ cwd }).pipe(Layer.provideMerge(parts))))
  }
  const well = yield* Pipe.use((pipe) => pipe.end).pipe(Effect.provide(Pipe.layer.pipe(Layer.provideMerge(parts))))
  if (!well) {
    return yield* new TurnFailed()
  }
})

// The home has no chat to inspect.
export class NoChat extends Schema.TaggedError<NoChat>()("NoChat", { message: Schema.String }) {}

// The inspector, until a signal ends it. It takes no launch and makes no
// home: it reads the database that is there.
const inspect = Effect.fnUntraced(function*(given: { readonly port: number }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* homeOf
  const file = path.join(home, Database.FILE)
  if (!(yield* fs.exists(file))) {
    return yield* new NoChat({ message: `no chat in ${home}: the inspector shows a chat that EverChat has started. ${HOME_VARIABLE} names another home.` })
  }
  // Loaded only here: the HTTP server is not part of a launch of the chat.
  const { Inspector } = yield* Effect.promise(() => import("./inspector.ts"))
  const serving = Inspector.layer({ port: given.port }).pipe(Layer.provide(Inspect.layer), Layer.provide(Reads.layer(file)))
  yield* Effect.gen(function*() {
    const inspector = yield* Inspector
    // The address alone on the standard output, for a script. The rest is for the person.
    yield* Console.log(inspector.url)
    yield* Console.error(`The inspector shows the chat in ${home}. It only reads. Ctrl+C ends it.`)
    return yield* Effect.never
  }).pipe(Effect.provide(serving))
})

const inspectCommand = Command.make(
  "inspect",
  { port: Flag.Int("port").pipe(Flag.withDescription(`The port on this machine (default: ${INSPECT_PORT}). 0: any free port`), Flag.withDefault(INSPECT_PORT)) },
  inspect
).pipe(Command.withDescription(ABOUT_INSPECT))

export const command = Command.make(
  "everchat",
  {
    model: Flag.String("model").pipe(Flag.withDescription(`The model of the turns, for this launch. With none: the chat's own, which is ${MODEL} at first`), Flag.optional),
    effort: Flag.String("effort").pipe(Flag.withDescription(`Its reasoning effort, for this launch. With none: the chat's own, which is ${EFFORT} at first`), Flag.optional),
    compactor: Flag.String("compactor").pipe(Flag.withDescription(`The model of the compactions (default: ${COMPACTOR})`), Flag.withDefault(COMPACTOR))
  },
  launch
).pipe(Command.withDescription(ABOUT), Command.withSubcommands([inspectCommand]))

// The flags that `effect/cli` adds to each command, but its wizard: that
// one asks for each argument in turn, and this program has three.
// `--log-level` sets the lowest level of the diagnostics that are written.
const BUILT_INS = [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions, GlobalFlag.LogLevel]

// No logger: nothing that is logged outside the diagnostics' layer goes to
// the console.
const QUIET = Logger.layer([])

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

// A wrong argument is 2. The rest is Effect's own: 0, 130 for an
// interrupt, and 1 for a failure.
const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) && CliError.isCliError(Cause.squash(exit.cause))
    ? onExit(2)
    : Runtime.defaultTeardown(exit, onExit)

// What `effect/cli` or pipe mode has told the person already.
const told = (cause: Cause.Cause<unknown>): boolean => {
  const error = Cause.squash(cause)
  return Cause.hasInterruptsOnly(cause) || CliError.isCliError(error) || error instanceof TurnFailed
}

const main = () => {
  const program = Command.run(command, { version: VERSION }).pipe(
    Effect.provide(CliConfig.layer({ builtIns: BUILT_INS })),
    Effect.provide(BunServices.layer),
    Effect.provide(QUIET),
    // The screen is given back by now.
    Effect.tapCause((cause) => (told(cause) ? Effect.void : Console.error("everchat: " + reason(cause))))
  )
  runMain(program, { disableErrorReporting: true, teardown })
}

if (import.meta.main) {
  main()
}
