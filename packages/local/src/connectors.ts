// The connectors
// ==============
// The servers of the config file (config.ts) as the servers of the client of
// functions from outside (`@everchat/mcp`): each with its transport, made by
// this module. A server is a program on stdio, which the load starts as a
// child, or an address over HTTP. This is the only module of the repository
// that imports the SDK's stdio entry (packages/mcp/AGENTS.md); the client
// itself makes no transport.
//
// A program on stdio
//
// - It runs the server's `command` with its `args`, in its `cwd` (a relative
//   one from the launch's work directory), or in the launch's work
//   directory when it has none. No shell reads the command.
// - Its environment is the SDK's short list of variables that a child may
//   inherit (the SDK's `getDefaultEnvironment`: `HOME`, `LOGNAME`, `PATH`,
//   `SHELL`, `TERM`, `USER` on this kind of system), over it the server's
//   `env`, and over both the launch's run tag (the variable `TAG` of
//   shell.ts), as a command of the shell has it: a config's `env` can
//   neither replace the tag nor take it away. Never the whole environment
//   of EverChat, which may hold what a server must not get (the key of the
//   inference gateway, for one).
// - Its standard error is dropped: a line there would break the screen.
//
// An address over HTTP
//
// - The SDK's transport of its main entry, with the server's `url`, and its
//   `headers` on each request. No sign-in flow.
//
// The end: the client closes each transport when the load's scope closes,
// and at once for a server whose load failed (packages/mcp/src/client.ts);
// the SDK's close of a program on stdio ends its input, then sends SIGTERM,
// then SIGKILL. That close signals only the one process that it started,
// and its last steps run on timers that an exit drops. So the load gets an
// end of its own (`swept`), registered in its scope before the load: it
// runs after the client closed the connections, and kills at once every
// process that still carries the tag (shell.ts, `sweep`): a server that did
// not end, and each process that a server started. A server refused at the
// load is closed at once by the SDK; one that hears neither the end of its
// input nor SIGTERM lives until the SDK's last step or this sweep, whichever
// comes first. The next launch's sweep of the ended run tags (shell.ts)
// stops what a launch that was killed left. A process that takes the tag
// out of its environment is not found.
//
// The config's texts of a server (its `args`, `env`, `url` and `headers`)
// may hold a secret of the person: nothing of this module writes one to a
// log, a fault or a row. A refusal of the load names a server by its name
// only.

import path from "node:path"
import type { Server } from "@everchat/mcp"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Effect, type Scope } from "effect"
import type { Server as Configured } from "./config.ts"
import { sweep, TAG } from "./shell.ts"

// Code units, not a locale: the same on every machine.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// The servers of the config file as the client's, sorted by name. `work`:
// the launch's work directory, where a program on stdio runs when its
// server gives no `cwd`. `tag`: the launch's run tag, which each program on
// stdio gets.
export const connectors = (configured: ReadonlyArray<Configured>, work: string, tag: string): ReadonlyArray<Server> =>
  [...configured].sort((a, b) => compare(a.name, b.name)).map((server): Server => ({
    name: server.name,
    approval: server.approval,
    tools: server.tools,
    transport: () =>
      server.kind === "stdio"
        ? new StdioClientTransport({
          command: server.command,
          args: [...server.args],
          // The SDK puts its default list under this, never the whole
          // environment. The tag comes last: the server's `env` cannot
          // replace it.
          env: { ...server.env, [TAG]: tag },
          cwd: path.resolve(work, server.cwd ?? "."),
          stderr: "ignore"
        })
        : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { ...server.headers } } })
  }))

// The end of a launch's load: when the scope closes, every process that
// still carries the tag is killed, in one synchronous step that waits for
// no timer of the SDK. Run it in the load's scope before the load, so that
// it runs after the client has closed the connections.
export const swept = (tag: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer(() => Effect.asVoid(sweep(new Set([tag]))))
