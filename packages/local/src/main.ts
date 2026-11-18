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
// `everchat serve` does not start the chat either. It serves the host on
// this machine, for the reference client's page, for development: chats of
// one local tenant in the home's `serve.db`, over HTTP on 127.0.0.1. It
// prints the page's address, and it runs until a signal ends it (serve.ts).
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
// needed: the migrator that the database had then logged a line, and it
// went to the standard output.
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
// - The terminal is lost (its window closed): one event with two signs,
//   in either order. The read of the standard input fails, and the system
//   sends SIGHUP. The program ends once, as for SIGHUP: the parts close
//   (the screen cannot be given back to it, and that is no failure), the
//   launch ends by a signal, and the code is 130. The read's failure
//   is no signal: it asks for the stop if none was asked, and it never
//   counts as the first of two signals, so a SIGHUP before it or after it
//   lets the parts close (`ending` holds the rule). In the terminal's mode
//   only: elsewhere a failed read of the standard input is that mode's own.
// - Only the error of a terminal that is gone is its loss (`terminalLost`).
//   Any other error of the terminal's input is a failure of the program
//   (`InputFailed`): the parts close, the launch ends with an error, the
//   reason is on the standard error, and the code is 1. Such an error
//   after a stop was asked (a signal, or the loss) does not change the
//   end: the parts close in full, the launch ends by a signal, the code is
//   130, and it never counts as a signal. A signal heard while the parts
//   close after such an error is the first signal: the close goes on, the
//   launch ends with the error, and the code is 130. In every order the
//   first such error is told on the standard error, in one line, after the
//   screen is given back, and no later one.
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
// The config file
//
// `everchat` reads `config.json` in the home (config.ts) one time, at its
// start, before it opens the database: the picks, the output limit, the
// servers, the agent's name and the rules. A flag of the launch wins over
// the file, and the file over the fixed defaults. The file of the rules
// (the config's `rules`, a relative path against the work directory) is
// read one time too, right after the config: the name and its text make
// the one head of the launch, so a change of either applies at the next
// launch. A fault of the file, or of the rules' file, ends the start, with
// each fault on the standard error and the code 1. `everchat inspect` and
// `everchat serve` do not read them.
//
// The connectors
//
// The servers that the config file names (connectors.ts) are loaded once
// for each launch of `everchat` (the terminal and pipe mode), in `layer`:
// after the store and the diagnostics, before the layers that take the
// chat's list of functions. Their functions come after the built-ins in
// that one list, so the head is fixed for the launch, and changes only at
// the next load. The connections and the children of the servers live in
// the launch's scope: they end with the launch, at a quit, at a signal or
// at a failure. Each program of a server carries the launch's run tag, and
// at the end, after the client's close, the sweep of the tag kills what is
// left: a server that did not end, and each process that a server started
// (connectors.ts). A server that does not answer within the load's limit
// (`@everchat/mcp`) gives no function, and the chat loads without it; its
// refusal is in the log (the source `mcp`), not on the screen. With no
// server, a start loads no module of the client: it is imported only when
// a server is named. `everchat inspect` and `everchat serve` start none.
//
// The wake-ups
//
// The config file's `wakeups` (docs/wakeups.md, section 9) gives `layer` its
// option, in each branch of the test of the terminal. With `on: false`, no
// option: no function, no source, no firer and no service of the wake-ups,
// and the launch is as it was before them. On (the default), the chat's one
// list is the built-ins, then `wake`, `wakes` and `unwake`, then the
// functions from outside, for the head of the turns, the compactor's head
// and the sandbox, in the terminal and in pipe mode alike. The terminal
// alone also has the wake-ups' source, asked after the approvals'
// (`Source.inOrder`), the firer, whose fiber ends with the launch's scope,
// and the service of `/wakeups`. Pipe mode has none of the three: its end
// waits for the turn loop's idle, so a source there would chain a wake
// turn into it, and a wake-up made there fires at the next start of the
// terminal. `everchat inspect` and `everchat serve` get nothing.

// Only this module of the package: its index loads all of it (an HTTP
// server, sockets, a cluster), and each start would pay for that.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Config, Console, type DateTime, Deferred, Effect, Exit, FileSystem, Layer, Logger, Option, Path, Runtime, Schema, Stdio } from "effect"
import { CliConfig, CliError, Command, Flag, GlobalFlag } from "effect/cli"
import * as fs from "node:fs"
import * as os from "node:os"
import { Approvals } from "@everchat/core/approval"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import * as Compactor from "@everchat/core/compactor"
import * as ConfigFile from "./config.ts"
import * as Database from "@everchat/sqlite/database"
import * as Diagnostics from "@everchat/core/diagnostics"
import type { Declaration, Entry } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { Inspect } from "./inspect.ts"
import { gatewayLayer } from "./gateway.ts"
import { limitLayer } from "./limitfile.ts"
import { DECLARATIONS, functionsLayer } from "./localfunctions.ts"
import { Memory } from "@everchat/core/memory"
import { openaiLayer } from "@everchat/openai"
import { Pipe } from "./pipe.ts"
import { Shell } from "./shell.ts"
import { readsLayer, storeLayer } from "@everchat/sqlite/bun"
import { type Pick, Store } from "@everchat/core/store"
import { Terminal } from "./terminal.ts"
import { threadLayer } from "@everchat/codemode/thread"
import { Source, Turns } from "@everchat/core/turn"
import { Wakeups } from "@everchat/wakeups/commands"
import { firer } from "@everchat/wakeups/firer"
import * as WakeFunctions from "@everchat/wakeups/functions"
import { source as wakeSource } from "@everchat/wakeups/source"

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

// The host's port when no argument gives one (serve.ts, `PORT`).
export const SERVE_PORT = 4681

export const ABOUT = `EverChat: one chat that never ends.

In a terminal, it shows the chat and reads the keys. With no terminal (the
standard input or the standard output is a pipe or a file), it works in pipe
mode: each line of the standard input is a message, and each message goes to
the standard output as text.

The chat is in the home: the directory that ${HOME_VARIABLE} names (default
~/${HOME}). Another home is another chat. The file ${ConfigFile.FILE} in the home,
if it is there, sets the picks and the output limit; a flag wins over it.`

export const ABOUT_INSPECT = `Serves the inspector: a page in a browser that shows the state of the chat in
the home. It shows the log, the tree, the views, each turn's request, and the
usage. It only reads the database, so it can run while EverChat runs, and it
changes nothing.

It prints the page's address. The address holds a token that is new at each
start: only who has the address can read the chat. The server listens on this
machine only (127.0.0.1).`

export const ABOUT_SERVE = `Serves the host on this machine, for development: the chats of one local
tenant, in the file serve.db in the home, and the page of the reference
client, in a browser, which makes chats and talks to them. A chat's turns call
only zoom, date and result: no shell and no file.

It prints the page's address. The address holds a value that is new at each
start: only who has the address can open the page. The server listens on this
machine only (127.0.0.1), and takes only that address as the request's host.

Run one everchat serve for a home: a second one on the same home, on another
port, gets an answer of "chat_elsewhere" for a chat that the first has
loaded, and its page then gets no live event of that chat.`

// The program of the sandbox's worker thread. In the executable, every
// module's address is the executable's own, and Bun finds an entrypoint of
// the build by its path from the first entrypoint's directory. So worker.ts
// must stay next to this file. (The adopted default finds the same file in
// the executable today, but only because of that file's name.)
const WORKER = new URL("./worker.ts", import.meta.url)

// The functions of the config's servers, loaded in the scope that the
// effect runs in: their connections close with it. Loaded only here: with
// no server, a start pays for no module of the client (the SDK too).
// `limit`: the load's time limit in ms; the client's when not given. Each
// program on stdio gets the launch's run tag, and the sweep of that tag is
// registered before the load: at the scope's end it runs after the client
// has closed the connections, and kills what is left (connectors.ts).
// `beside`: the chat's own functions (the built-ins, and the wake-ups' when
// on), whose names a server's function may not take.
const connect = (servers: ReadonlyArray<ConfigFile.Server>, cwd: string, limit: number | undefined, beside: ReadonlyArray<Declaration>) =>
  Effect.gen(function*() {
    const tag = (yield* Store).launch.runTag
    const [{ connectors, swept }, { load }] = yield* Effect.promise(() => Promise.all([import("./connectors.ts"), import("@everchat/mcp")]))
    yield* swept(tag)
    return yield* load(connectors(servers, cwd, tag), limit === undefined ? { beside } : { beside, load: limit })
  })

// The functions from outside of a launch: none, with no server.
interface Outside {
  readonly declarations: ReadonlyArray<Declaration>
  readonly entries: ReadonlyArray<Entry>
}
const NOTHING: Outside = { declarations: [], entries: [] }

// The wake-ups of a launch (the head comment, "The wake-ups"): `layer`'s
// option. None (not given): the config file's `on: false`. "functions":
// the three functions only, for pipe mode. "all": the functions, the
// source, the firer and the service of `/wakeups`, for the terminal.
// `zone`: the config file's zone, for `wake`; null with none.
export interface WakeupsOption {
  readonly with: "functions" | "all"
  readonly zone: DateTime.TimeZone.Named | null
}

// The option of a launch from the config file's section: none when off.
export const wakeupsOf = (settings: ConfigFile.Wakeups, mode: WakeupsOption["with"]): WakeupsOption | undefined =>
  settings.on ? { with: mode, zone: settings.zone } : undefined

// The program but its interface, for one launch.
// `limit`: the output limit in characters; with none, limit.ts's.
// `servers`: the config's servers, whose functions the launch loads
// (connectors.ts); none when not given. `load`: the load's time limit in
// ms, for a test; the client's when not given. `name`, `rules`: the
// agent's name and the text of the person's rules, for the head; none when
// not given. `wakeups`: the wake-ups of the launch (`WakeupsOption`); none
// when not given.
export const layer = (given: {
  readonly home: string
  readonly file: string
  readonly cwd: string
  readonly pick: Pick | undefined
  readonly compactor: Pick
  readonly limit?: number | undefined
  readonly servers?: ReadonlyArray<ConfigFile.Server> | undefined
  readonly load?: number | undefined
  readonly name?: string | undefined
  readonly rules?: string | undefined
  readonly wakeups?: WakeupsOption | undefined
}) => {
  const launch = { pid: process.pid, host: os.hostname(), cwd: given.cwd, version: VERSION, runTag: crypto.randomUUID(), pick: given.pick }
  const base = Diagnostics.layer.pipe(
    Layer.provideMerge(storeLayer(given.file, { launch, pick: given.pick ?? { vendor: "openai", model: MODEL, effort: EFFORT, speed: "slow" } }))
  )
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, openaiLayer.pipe(Layer.provide(gatewayLayer)))), Layer.provideMerge(base))
  const wakeups = given.wakeups
  // The chat's own functions: the built-ins, then the wake-ups' three when
  // they are on. A server's function may not take one of their names.
  const own: ReadonlyArray<Declaration> = wakeups === undefined ? DECLARATIONS : [...DECLARATIONS, ...WakeFunctions.declarations]
  // The chat's functions: one list, for the head and the sandbox
  // (functions.ts, "One list for each stack"): the built-ins, then the
  // wake-ups' three when on, then the functions from outside, with the
  // entries in that same order. The head is made one time, from that list,
  // the rules and the name, for the turns and the compactions. `wakes`:
  // the entries of the wake-ups' three, over the store; none when off.
  const stack = (outside: Outside, wakes: ReadonlyArray<Entry>) => {
    const declarations: ReadonlyArray<Declaration> = [...own, ...outside.declarations]
    const made = head(declarations, given.rules ?? null, given.name)
    const memory = Memory.layer.pipe(Layer.provide(Compactor.layer({ pick: given.compactor, head: made })))
    const limits = limitLayer({ limit: given.limit }).pipe(Layer.provideMerge(memory))
    const functions = functionsLayer(declarations, { cwd: given.cwd, more: [...wakes, ...outside.entries] }).pipe(Layer.provideMerge(limits))
    const sandbox = threadLayer({ worker: WORKER }).pipe(Layer.provideMerge(functions))
    // The approvals (approval.ts): their source, the result of a run after
    // a yes, below the turn loop; the answers and the runs over it. Its
    // build is a load: a run that a crash left is cut, the expired ones get
    // their notes, a yes that did not run yet runs. In the terminal with
    // the wake-ups on, the sources in order, the approvals' first: an
    // approval's result that waits starts its turn before a wake-up's fire.
    const sources = wakeups?.with === "all" ? Source.inOrder(Approvals.source, wakeSource) : Approvals.source
    const turns = Turns.layer({ head: made }).pipe(Layer.provide(sources), Layer.provideMerge(sandbox))
    // Over the turn loop: the approvals' answers and runs; in the terminal
    // with the wake-ups on, beside them the firer (its fiber ends with the
    // launch's scope, before the store closes) and the service of
    // `/wakeups`, which the terminal reads at its build.
    const above = wakeups?.with === "all" ? Layer.mergeAll(Approvals.layer, firer, Wakeups.layer) : Approvals.layer
    return above.pipe(Layer.provideMerge(turns))
  }
  // The shell is built before the load, and so ends after it: its end
  // kills what carries the run tag, and the servers carry it too, so the
  // client must have closed them first (connectors.ts).
  const shell = Shell.layer({ cwd: given.cwd }).pipe(Layer.provideMerge(asking))
  const servers = given.servers ?? []
  // The load runs where the diagnostics are up, so its refusals are in the
  // log, and its scope is the layer's: the launch's. The wake-ups' entries
  // need the store's service: they are made in the same step, where the
  // store is up, with no server too.
  const entriesOf = Effect.map(Store, (store) => wakeups === undefined ? [] : WakeFunctions.entries(store, wakeups.zone === null ? {} : { zone: wakeups.zone }))
  const loaded = servers.length === 0
    ? wakeups === undefined ? stack(NOTHING, []) : Layer.unwrap(Effect.map(entriesOf, (wakes) => stack(NOTHING, wakes)))
    : Layer.unwrap(Effect.flatMap(connect(servers, given.cwd, given.load, own), (outside) => Effect.map(entriesOf, (wakes) => stack(outside, wakes))))
  return loaded.pipe(Layer.provideMerge(shell))
}

// Pipe mode ended, and a turn of this launch had failed. The output holds
// the turn's note, so nothing more is said: only the exit code tells it.
export class TurnFailed extends Schema.TaggedError<TurnFailed>()("TurnFailed", {}) {}

// The read of the terminal's input failed, and the terminal is there.
export class InputFailed extends Schema.TaggedError<InputFailed>()("InputFailed", { message: Schema.String }) {}

// Whether an error of the standard input is the loss of the terminal: the
// error of a terminal that is gone. A pseudo-terminal whose other end has
// closed gives `EIO` to a read and to `tcsetattr`, so the two forms are the
// read's error, whose `code` is `EIO`, and the give-back's, which Bun emits
// on the stream with no code: `setRawMode failed with errno: 5` (5 is
// `EIO`). Every other error is a failure of the program.
export const terminalLost = (error: unknown): boolean =>
  typeof error === "object" && error !== null &&
  ((error as { readonly code?: unknown }).code === "EIO" || (error instanceof Error && error.message === "setRawMode failed with errno: 5"))

// The first of `<file>.old`, `<file>.old.2`, ..., `<file>.old.1000` that
// names nothing in its directory now, or undefined when none of them is
// free. A link that points nowhere is in use, and so is a name that cannot
// be looked at (only "no such file" frees it). It gives only a name that it
// looked at, so it stops after 1000, and a directory where every look fails
// does not loop forever.
const free = (file: string): string | undefined => {
  const used = (name: string) => {
    try {
      fs.lstatSync(name)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT"
    }
  }
  for (let n = 1; n <= 1000; n++) {
    const name = file + ".old" + (n === 1 ? "" : "." + n)
    if (!used(name)) return name
  }
  return undefined
}

// What a failure says to the person, in one row; the faults of the config
// file in one row each.
const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (error instanceof ConfigFile.ConfigFault) {
    // One fault on each line, each with the file's path.
    return error.faults.map((fault) => error.file + ": " + fault).join("\neverchat: ")
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { readonly _tag: string; readonly message?: unknown; readonly op?: unknown; readonly pid?: unknown; readonly cause?: unknown }
    if (tagged._tag === "LaunchLive") {
      return "another EverChat (process " + String(tagged.pid) + ") has this chat open. One chat is one process."
    }
    if (tagged._tag === "DatabaseVersion") {
      const { file } = tagged as unknown as { readonly file: string }
      // Both paths as they are: the words give no command, so nothing is
      // quoted. The program moves nothing. With no free name that it looked
      // at, the sentence names none.
      const aside = free(file)
      return "the database " + file + " is from another version of EverChat. To start a new chat, move it aside, to a name that is not in use" + (aside === undefined ? "." : ": " + aside)
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
const launch = Effect.fnUntraced(function*(given: { readonly model: Option.Option<string>; readonly effort: Option.Option<string>; readonly compactor: Option.Option<string> }) {
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* homeOf
  // Before the database is opened: a fault of the file leaves no launch.
  const settings = yield* ConfigFile.read(home, process.env)
  const cwd = process.cwd()
  // The rules' file, against the work directory: a fault stops the start too.
  const rules = yield* ConfigFile.rulesOf(settings, cwd, path.join(home, ConfigFile.FILE))
  const { model, effort, compactor: compacting } = ConfigFile.picks(
    { model: Option.getOrUndefined(given.model), effort: Option.getOrUndefined(given.effort), compactor: Option.getOrUndefined(given.compactor) },
    settings
  )
  // The home holds the chat: no other account may read it.
  yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 })
  // The model and the effort of this launch only: with none, the chat's own pick.
  const pick: Pick | undefined = model === undefined && effort === undefined
    ? undefined
    : { vendor: "openai", model: model ?? MODEL, effort: effort ?? EFFORT, speed: "slow" }
  const compactor: Pick = { vendor: "openai", model: compacting ?? COMPACTOR, effort: "low", speed: "slow" }
  // The parts of the launch, with the wake-ups of its interface (the head
  // comment, "The wake-ups"): built in each branch below.
  const parts = (mode: WakeupsOption["with"]) =>
    layer({ home, file: path.join(home, Database.FILE), cwd, pick, compactor, limit: settings.limit, servers: settings.servers, name: settings.name, rules, wakeups: wakeupsOf(settings.wakeups, mode) })

  if ((yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal)) {
    // The failures of the terminal's input, until the process ends
    // (`setRawMode` tells its failure on the stream, and throws it only when
    // nothing listens). The loss of the terminal (`terminalLost`) asks for
    // the stop as a signal does. Any other is a failure of the program: the
    // first one ends it as a failure of its own effect does, so the parts
    // close and the launch ends with an error; one that comes while the
    // parts close after a quit fails the program when they have closed.
    // One that comes after a stop was asked (a signal, or the loss) does not
    // change the end: the stop interrupts the race, so the check after it
    // never runs, and the program ends as the stop asked.
    // The first such error is told here, in every order, and only here:
    // when the parts have closed (the screen is given back by then), however
    // the race and the close ended. A signal heard while the parts close
    // after the error replaces the error in the end's cause, so `main`
    // could not tell it; `main` tells no `InputFailed` (`told`).
    const failed = yield* Deferred.make<never, InputFailed>()
    yield* Effect.sync(() =>
      process.stdin.on("error", (error: unknown) => {
        if (terminalLost(error)) lost()
        else Deferred.doneUnsafe(failed, Exit.fail(new InputFailed({ message: "the read of the terminal failed: " + (error instanceof Error ? error.message : String(error)) })))
      })
    )
    yield* Effect.raceFirst(Terminal.use((terminal) => terminal.quit), Deferred.await(failed)).pipe(
      Effect.provide(Terminal.layer({ cwd }).pipe(Layer.provideMerge(parts("all")))),
      // The check after it reads `failed` in the same run of the fiber, so
      // what this tells is what the launch fails with: no error is told
      // twice, and none is left.
      Effect.onExit(() =>
        Effect.flatMap(Deferred.isDone(failed), (done) => done ? Effect.flatMap(Effect.flip(Deferred.await(failed)), (error) => Console.error("everchat: " + error.message)) : Effect.void)
      )
    )
    if (yield* Deferred.isDone(failed)) return yield* Deferred.await(failed)
    return
  }
  const well = yield* Pipe.use((pipe) => pipe.end).pipe(Effect.provide(Pipe.layer.pipe(Layer.provideMerge(parts("functions")))))
  if (!well) {
    return yield* new TurnFailed()
  }
})

// The home has no chat to inspect.
export class NoHome extends Schema.TaggedError<NoHome>()("NoHome", { message: Schema.String }) {}

// The inspector, until a signal ends it. It takes no launch and makes no
// home: it reads the database that is there.
const inspect = Effect.fnUntraced(function*(given: { readonly port: number }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* homeOf
  const file = path.join(home, Database.FILE)
  if (!(yield* fs.exists(file))) {
    return yield* new NoHome({ message: `no chat in ${home}: the inspector shows a chat that EverChat has started. ${HOME_VARIABLE} names another home.` })
  }
  // Loaded only here: the HTTP server is not part of a launch of the chat.
  const { Inspector } = yield* Effect.promise(() => import("./inspector.ts"))
  const serving = Inspector.layer({ port: given.port }).pipe(Layer.provide(Inspect.layer), Layer.provide(readsLayer(file)))
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

// The host, until a signal ends it. It takes a launch for each chat that it
// loads, in its own file.
const serveHost = Effect.fnUntraced(function*(given: { readonly port: number }) {
  const fs = yield* FileSystem.FileSystem
  const home = yield* homeOf
  // The home holds the chats: no other account may read it.
  yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 })
  // Loaded only here: the host is not part of a launch of the chat, nor of the inspector.
  const { host } = yield* Effect.promise(() => import("./serve.ts"))
  return yield* host({
    home,
    port: given.port,
    pick: { vendor: "openai", model: MODEL, effort: EFFORT, speed: "slow" },
    compactor: { vendor: "openai", model: COMPACTOR, effort: "low", speed: "slow" },
    version: VERSION
  })
})

const serveCommand = Command.make(
  "serve",
  { port: Flag.Int("port").pipe(Flag.withDescription(`The port on this machine (default: ${SERVE_PORT}). 0: any free port`), Flag.withDefault(SERVE_PORT)) },
  serveHost
).pipe(Command.withDescription(ABOUT_SERVE))

export const command = Command.make(
  "everchat",
  {
    model: Flag.String("model").pipe(Flag.withDescription(`The model of the turns, for this launch. With none: the config file's, else the chat's own, which is ${MODEL} at first`), Flag.optional),
    effort: Flag.String("effort").pipe(Flag.withDescription(`Its reasoning effort, for this launch. With none: the config file's, else the chat's own, which is ${EFFORT} at first`), Flag.optional),
    compactor: Flag.String("compactor").pipe(Flag.withDescription(`The model of the compactions. With none: the config file's, else ${COMPACTOR}`), Flag.optional)
  },
  launch
).pipe(Command.withDescription(ABOUT), Command.withSubcommands([inspectCommand, serveCommand]))

// The flags that `effect/cli` adds to each command, but its wizard: that
// one asks for each argument in turn, and this program has three.
// `--log-level` sets the lowest level of the diagnostics that are written.
const BUILT_INS = [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions, GlobalFlag.LogLevel]

// No logger: nothing that is logged outside the diagnostics' layer goes to
// the console.
const QUIET = Logger.layer([])

// The rule of the end (the head comment), for one run: `interrupt` starts
// the close of the parts, once, and `exit` ends the process at once.
export const ending = (interrupt: () => void, exit: (code: number) => void) => {
  let stopping = false
  const end = () => {
    if (!stopping) {
      stopping = true
      interrupt()
    }
  }
  let asked = false
  return {
    // SIGTERM, SIGHUP or SIGINT: the second one ends the process at once.
    signal: () => {
      if (asked) {
        exit(1)
        return
      }
      asked = true
      end()
    },
    // The read of the terminal's input failed: no signal, and never the
    // first of two.
    lost: end
  }
}

// The loss of the terminal in this run (runMain's `ending`).
let lost = () => {}

// Runs `program` as the process: a signal or the loss of the terminal
// interrupts it, once, and the process exits when it has ended.
const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  const ends = ending(() => fiber.interruptUnsafe(fiber.id), (code) => process.exit(code))
  lost = ends.lost
  process.on("SIGTERM", ends.signal)
  process.on("SIGHUP", ends.signal)
  process.on("SIGINT", ends.signal)
  fiber.addObserver((exit) => teardown(exit, (code) => process.exit(code)))
})

// A wrong argument is 2. The rest is Effect's own: 0, 130 for an
// interrupt, and 1 for a failure.
const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) && CliError.isCliError(Cause.squash(exit.cause))
    ? onExit(2)
    : Runtime.defaultTeardown(exit, onExit)

// What `effect/cli`, pipe mode or the terminal's launch has told the person
// already: the launch tells an `InputFailed` itself, in every order.
const told = (cause: Cause.Cause<unknown>): boolean => {
  const error = Cause.squash(cause)
  return Cause.hasInterruptsOnly(cause) || CliError.isCliError(error) || error instanceof TurnFailed || error instanceof InputFailed
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
