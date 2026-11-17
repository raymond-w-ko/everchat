// Serve
// =====
// `everchat serve`: the host on this machine, for the reference client's page
// (docs/host.md, section 7). It is for development. main.ts loads this module
// by a dynamic import, only for this command, as it loads the inspector: a
// launch of the chat, of pipe mode or of the inspector loads no module of the
// host.
//
// What it is
//
// - Its file: `serve.db` in the home, next to the terminal's `everchat.db`
//   (the local layers refuse a file with more than one chat). main.ts makes
//   the home, mode 0700, when it is not there; this module makes the file,
//   mode 0600, when it is not there, and SQLite gives its journal files the
//   same mode.
// - Its tenant: one, `TENANT`, a constant, so the page's chats are there at
//   the next start.
// - Its server: Bun's, on 127.0.0.1 only, with the numbers of `serverOptions`
//   and no others. The port that it got (for `--port 0` too) makes the one
//   origin, `http://127.0.0.1:<port>`, and the one value of `Host` that the
//   gate takes, `127.0.0.1:<port>`: a page of a web site that points its own
//   name at 127.0.0.1 gets `403`. A port in use fails the start with
//   `NoPort`, as the inspector's, before anything is printed. So does the
//   port 80, before anything listens: a browser gives no port in `Host` for
//   it, so the gate would refuse each request of the page.
// - Its secret and its start value: 32 random bytes and 32 random hex
//   digits, each new at each start, from the system's random source
//   (`crypto.getRandomValues`), held in memory only (the secret as a
//   `Redacted`). So a token or a page's address of an earlier start opens
//   nothing.
// - Its stack: `hostedStack` (hosted.ts), with the compactor's pick and the
//   pick of a new chat that main.ts gives (the terminal's defaults), the hub
//   of the host's limits and the default cap of one answer. The launch's
//   fields are the terminal's: the pid, the host's name, the version; the
//   work directory is the home (a host's chat has none of its own).
// - The host's limits: the defaults, but `hub` and `store`, which this module
//   needs before the host is made (the stack's hub, the file's store limit):
//   it gives those two to the host with the defaults' values (`LIMITS`), so
//   the host's limits are the ones that the stack and the file use.
//
// What it prints
//
// On the standard output one line, the page's address with its start value,
// `http://127.0.0.1:<port>/<start>/`, once the server listens, and nothing
// else, ever. On the standard error one line for the person, then the host's
// own diagnostics (those of no chat) by Effect's logger, in logfmt. A chat's
// diagnostics go into its log, through the stack. No line of either holds a
// token, the secret, the text of a message, or the start value but in the
// one printed line.
//
// Its stop
//
// A signal interrupts it (main.ts), and the scope closes in reverse: first
// `serve`'s end (each stream gets `stop`, each socket `1001`, each loaded
// chat is unloaded, so each launch ends), then the wires, the server and the
// file.
//
// One process for a home. The command does not lock its file. A second
// `everchat serve` on the same home needs another port; then a chat that one
// process has loaded answers `409 chat_elsewhere` to a message in the other,
// and the other's clients get no live event of it until they connect again.
// No data is lost. A lease is the server plan's.

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Cause, Console, Context, Effect, Layer, Logger, Redacted } from "effect"
import { HttpServer } from "effect/http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Chats, type Pick } from "@everchat/core/store"
import { serve, serverOptions } from "@everchat/server"
import { chatsLayer } from "@everchat/sqlite/bun"
import { hostedStack } from "./hosted.ts"
import { NoPort } from "./inspector.ts"

// The port when no argument gives one (the inspector's is 4680).
export const PORT = 4681

// The host's file in the home.
export const FILE = "serve.db"

// The one local tenant.
export const TENANT = "00000000-0000-4000-8000-000000000001"

// The two limits of the host that are needed before the host is made, at the
// values of its defaults (packages/server/src/limits.ts, `DEFAULTS`).
export const LIMITS = { hub: 1_024, store: 5_000 }

export interface ServeOptions {
  readonly home: string // the home, which is there
  readonly port: number // 0: any free port
  readonly pick: Pick // the pick of a new chat
  readonly compactor: Pick // the compactor's pick
  readonly version: string
}

// Hex digits of `bytes`, in lower case.
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

// The host's own diagnostics: to the standard error, in logfmt.
const STDERR = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])

// The host, until an interruption ends it.
export const host = (given: ServeOptions): Effect.Effect<never, unknown> =>
  Effect.scoped(Effect.gen(function*() {
    // A browser sends `Host: 127.0.0.1`, with no port, for the port 80, and
    // the gate takes only `127.0.0.1:<port>`: refused before the server is
    // made, as a port in use.
    if (given.port === 80) {
      return yield* new NoPort({ port: 80, message: "the host cannot serve the page on port 80: a browser gives no port in Host for port 80, and the gate takes only 127.0.0.1:<port>" })
    }
    const file = path.join(given.home, FILE)
    // Made with no access for another account, when it is not there; one
    // that is there keeps its mode.
    fs.closeSync(fs.openSync(file, "a", 0o600))
    const chats = Context.get(yield* Layer.build(chatsLayer(file, { store: LIMITS.store })), Chats)
    // The server fails a port that is in use with a defect: make it the
    // inspector's error, which main.ts shows.
    const server = yield* Layer.build(BunHttpServer.layer({ hostname: "127.0.0.1", port: given.port, ...serverOptions(LIMITS) })).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return Effect.fail(
          new NoPort({ port: given.port, message: `the host could not listen on port ${given.port} (${error instanceof Error ? error.message : String(error)})` })
        )
      })
    )
    const port = (Context.get(server, HttpServer.HttpServer).address as { readonly port: number }).port
    const authority = `127.0.0.1:${port}`
    const origin = `http://${authority}`
    const secret = Redacted.make(crypto.getRandomValues(new Uint8Array(32)))
    const start = hex(crypto.getRandomValues(new Uint8Array(16)))
    const stack = yield* hostedStack({ compactor: given.compactor, hub: LIMITS.hub })
    yield* Layer.build(
      serve(
        { stack, launch: { pid: process.pid, host: os.hostname(), cwd: given.home, version: given.version }, secret, origins: [origin], limits: LIMITS },
        { start, tenant: TENANT, pick: given.pick, authority }
      ).pipe(Layer.provide(Layer.succeed(Chats, chats)), Layer.provide(Layer.succeedContext(server)))
    )
    // The address alone on the standard output, for a script. The rest is for the person.
    yield* Console.log(`${origin}/${start}/`)
    yield* Console.error(`The host serves the chats of ${given.home}, on this machine only, for development. Ctrl+C ends it.`)
    return yield* Effect.never
  })).pipe(Effect.provide(STDERR))
