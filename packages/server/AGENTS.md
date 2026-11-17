`packages/server/` (`@everchat/server`): the host, which serves many chats over HTTP and WebSocket.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/server/` (`@everchat/server`): the host. It loads a chat of
  the database by its tenant and its UUID, with the stack that its caller
  gives, and serves it over HTTP and WebSocket. Its entries: `.`
  (`packages/server/src/index.ts`), `./token`
  (`packages/server/src/token.ts`: `makeToken` and `verifyToken`), and
  `./backend` (`packages/server/src/backend.ts`: `makeTenant`, `makeChat`,
  and `makeToken` again). The `.` entry gives each name of `host.ts`
  (`Host` and `Host.layer`, with the message in under a channel's lock,
  `HostOptions` and the errors of a message in), `serve(options, local?)`,
  the layer that serves the routes R1 to R7 over the `HttpServer` of its
  context, and with its option `local` (`LocalOptions`: the start value, the
  local tenant, the pick of a new chat and the one value of `Host`) the
  page's routes R8 to R10 too and the gate's check of `Host`, with
  `LocalRefused`, its error at the start; and `serverOptions(limits)`, the
  numbers of that server.
- The modules of the host, one line each:
  - `packages/server/src/reads.ts`: the places of `reads`, and a client's
    own first read with its join.
  - `packages/server/src/loaded.ts`: the loader of a chat: its load, its
    listener, its timer and its unload, and the bound of loaded chats.
  - `packages/server/src/host.ts`: `Host` and its layer, the rate of
    messages in, and a message in under the channel's lock.
  - `packages/server/src/http.ts`: the gate of the routes: the place, the
    method, the checks of origin, token and chat, the deadline, the
    preflight (R7) and the answer of no route.
  - `packages/server/src/history.ts`: R2, the snapshot, and R3, older
    messages.
  - `packages/server/src/post.ts`: R1, a message in.
  - `packages/server/src/stream.ts`: R4, the event stream.
  - `packages/server/src/poll.ts`: R5, the events with no stream.
  - `packages/server/src/socket.ts`: R6, the WebSocket.
  - `packages/server/src/page.ts`: R8 to R10, the local command's page with
    its policy, a new chat and a token, under the start value.
  - `packages/server/src/client.html`: the page, the reference client, one
    file with its style and its one script, served by R8.
  - `packages/server/src/serve.ts`: `serve`, the routes by their paths and
    methods over one gate, the end in its order, and `serverOptions`.
  - `packages/server/src/index.ts`: the `.` entry.
- The tests of one module sit next to it, in `packages/server/src/`.

## Its server

`serve` cannot read the options of the server that its caller built, so the
caller builds its `BunHttpServer` with `serverOptions(limits)`, for the same
limits as `HostOptions.limits`: `idleTimeout` (`idle` in whole seconds, 190
at the defaults), and for `websocket` its `idleTimeout` (`socketIdle`, 120),
`maxPayloadLength` (`body`), `closeOnBackpressureLimit: true` and
`backpressureLimit` (`bufferBytes`). A server with other numbers breaks the
page's sums (`docs/host.md`, section 3, "Admission" 9): a shorter idle limit
resets an answer within the page's silences, and a larger frame bound lets
Bun hold more than `body` of a frame.

- A slow socket: Effect's Bun writer moves each text into Bun's send buffer
  at once and does not read the result of `sendText`, so a socket's bound of
  a slow reader is Bun's. With Bun's defaults a socket that falls 16 MiB
  behind stays open and loses frames (a hole); with the two options above
  Bun ends it instead, with `1006` and no close frame on both sides, so the
  host cannot send `4408 slow` for it or tell it from a client that went
  away, and the client connects again from its last number. A server built
  with other numbers can give a client a hole.
- Bun's idle limit of HTTP (Bun 1.4.4) counts in ticks of 4 s: an
  `idleTimeout` of 4 or less resets every answer at 4 s, whatever it
  writes, so an `idle` under 5,000 ms cannot hold a stream there.
- The paths as Bun gives them (lead, ec-5tdje): Bun parses a request's
  target as a URL before any code of Effect or the host runs, and `serve`
  matches its exact paths on that text. A target that the parsing makes
  equal to a route's path is that route's request, with every check on the
  parsed text: a dot segment (`./`, `../`, also as `%2e` or `%2E`), a
  backslash for a slash, and the absolute form (its host is dropped). Two
  slashes, a slash at the end, another letter case, `;` and a percent
  escape other than a dot's stay as they came, and get no route (in
  `{chat}`: the gate's check of that text). A front of a hosted deployment
  must not decide access by a path's spelling.
- The server's own answers are not the host's requests: Effect's Bun server
  answers `CONNECT` with `501` before the host's handler, and Bun a head
  that it cannot parse (a method name that it does not know, lowercase too:
  the connection closes with no answer; a tab or a space in the target:
  `505`; `*` or a target that starts with a backslash: `400`). No place, no
  check and no line of the gate's log, at any load. "Every other method" of
  the routes is every method that the server gives the handler.

## Its imports

The host's code imports `effect` and `@everchat/core`, and nothing else: no
store, no wire, no engine, nothing of the local build, and no module of Bun
or of Node. So the same host serves the local SQLite file now and MariaDB
later; only the store and the stack that the caller gives change. Two
checks hold it. `tools/graph.ts`: the package's files (not its tests) may
import no built-in module, and must not reach `packages/local/`,
`packages/openai/`, `packages/sqlite/` or `packages/codemode/`. The type
program `packages/server/tsconfig.json`: its files are checked with no Bun
and no Node types. The program lists two files of declarations: the core's,
`packages/core/tsconfig.core.d.ts`, and its own,
`packages/server/tsconfig.server.d.ts`; a new global goes into the server's
file, never into a source file. The type program passes what those
declarations name, the core's `node:crypto` too, and refuses only a module
that none names: the list of built-ins of `tools/graph.ts`, which gives the
server's files none, is what refuses each module of Bun or of Node there.
Its tests may import any of them, with the Bun types
(`packages/server/tsconfig.test.json`). The page, `client.html`, is taken in
as text (`with { type: "text" }`, as the inspector's), with no build step;
`tsconfig.server.d.ts` declares such an import as a text, and `crypto.subtle`
for its script's hash.

## Its design

`docs/host.md`: the parts and who gives what (section 1), the life of a
chat in the host (section 2), the client's interface (section 3), the
tokens and the backend's functions (section 6), and the limits (section 8).
