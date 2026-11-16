`packages/server/` (`@everchat/server`): the host, which serves many chats over HTTP and WebSocket.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/server/` (`@everchat/server`): the host. It loads a chat of
  the database by its tenant and its UUID, with the stack that its caller
  gives, and serves it over HTTP and WebSocket. Its entries: `.`
  (`packages/server/src/host.ts`: `Host`, the service of the loaded chats,
  and `serve`, the layer of its routes), `./token`
  (`packages/server/src/token.ts`: `makeToken` and `verifyToken`), and
  `./backend` (`packages/server/src/backend.ts`: `makeTenant`, `makeChat`,
  and `makeToken` again). The entries are empty for now: the beads of the
  host fill them.
- The tests of one module sit next to it, in `packages/server/src/`.

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
file, never into a source file. Its tests may import any of them, with the Bun types
(`packages/server/tsconfig.test.json`).

## Its design

`docs/host.md`: the parts and who gives what (section 1), the life of a
chat in the host (section 2), the client's interface (section 3), the
tokens and the backend's functions (section 6), and the limits (section 8).
