# The accepted risks of the boundaries

This file holds what the two checks of the boundaries in `just check` (the type check of each package, and `tools/graph.ts`) do not hold.

What the two checks do not hold, each an accepted risk:

- Reflection (ec-lzw7). A file of the core reaches a runtime API by a
  name that is made at run time: through a value of type `any`, for
  example `Reflect.get(crypto, "randomUUID")()` on an import of the whole
  `node:crypto`, or `Reflect.get(globalThis, "process")` with no import
  at all; or by a computed `import(n)` (`const n = "node:fs"; await
  import(n)`), which Bun's parser does not list. All three pass `just
  check`: the type check holds the names that a file uses by their
  types, and the script holds the modules that a file imports; neither
  sees a name that is made at run time. It is rare: only code that is
  written to go around the types does this, and the type check refuses
  each other name of `node:crypto` that a file uses directly
  (`import { randomUUID }` and `crypto.randomUUID()` each fail). To
  recover, remove the line: no record is lost. The review of a change to
  the core looks for `Reflect`, `globalThis`, `any`, and an `import()`
  of no string. What would fix it is not an import check: a lint rule
  that forbids those in the core, or a run of the core where the API is
  absent (the core's tests on Node, the Cloudflare smoke test).
- An ambient import (ec-ofuo). An `import` with no `type` inside a
  `declare module "x" { ... }` block, in a `.ts` file that is not a
  `.d.ts` file, loads nothing, but Bun's parser lists it, so the script
  may print a fault for it (`manifest`, `built-in`). It is rare: the tree
  has no such block, and ambient declarations are in `.d.ts` files, which
  the script does not read. It fails safe: the check refuses, and it
  never passes a real import. Write `import type` in the block (Bun's
  parser then lists nothing), or put the block in a `.d.ts` file. What
  would fix it: an import list from a parser that knows ambient blocks.
- A library's own imports (ec-t5ss9). The two checks read only the
  workspace's own files: the walk of `tools/graph.ts` skips a specifier of
  no workspace package (`tools/graph.ts:508-509`), and the type programs
  have `skipLibCheck` (`tsconfig.json`). So a library that a package's row
  names may import what the package itself may not, and both checks pass.
  The SDK of MCP in `@everchat/mcp` does (`@modelcontextprotocol/client`
  2.4.0; the paths are of its installed files). Its entry
  `@modelcontextprotocol/client/stdio` imports `node:process`,
  `node:stream` and `cross-spawn` (`dist/stdio.mjs:2-4`), to start a
  program as a child. Its main entry imports
  `@modelcontextprotocol/client/_shims` (`dist/index.mjs:3`), whose
  conditions `node` and `default` (the `exports` of its `package.json`),
  which Node and Bun take, give a bundled validator, Ajv
  (`dist/shimsNode.mjs:1`), that makes each schema's check with `new
  Function` (`dist/ajvProvider-BIwGVY6G.mjs:2594`). It also reaches
  `pkce-challenge` 5.0.1 (`dist/index.mjs:2`, then
  `dist/public-CvV4ZHkX.mjs:3`), whose `exports` have the conditions
  `browser` and `node` only; its node file's fallback
  `import("node:crypto")` (`dist/index.node.js:2-5` of `pkce-challenge`)
  runs only when `globalThis.crypto` is missing, which Bun and current
  Node have. A file of
  `packages/mcp/src` that imports the stdio entry passes the package's
  guard (`tsc -p packages/mcp`) and the graph, though the package may
  import no built-in module; only a runtime with no child process (a
  Worker of Cloudflare) would show it. What holds the stdio entry out of
  `@everchat/mcp` is a rule of `packages/mcp/AGENTS.md` ("Its
  libraries"): only `packages/local` imports it. The reviews hold that
  rule; no check of `just check` does. The review of a change to
  `packages/mcp` looks for `@modelcontextprotocol/client/stdio`, and the
  review of a change to `bun.lock` reads each new package. What would fix
  it: a graph that follows a library's own imports by its `exports`
  conditions and refuses a built-in module there, or a list of the
  entries of a library that each row refuses.
- An attribute that names a code loader (ec-z0fwbr). An import of a file
  of a kind that `tools/graph.ts` takes as no code (`NOT_CODE`: `.html`,
  `.txt`, `.md`) with an attribute whose type is a code loader (`with {
  type: "ts" }`, or `js`, `tsx`, `jsx`), in an import statement (a side
  effect or a default import) or in a dynamic import (`await import("./c.html",
  { with: { type: "ts" } })`), makes Bun 1.4.4 run that file as code. The
  script decides on Bun's list of imports (`scanImports`), which holds no
  attribute, so it follows the file as a leaf, and the file's own imports
  (a built-in, another package's file) pass `just check`. It is rare: only
  code that is written to go around the check has such an attribute. The
  tree's imports with an attribute are three, and each names a loader that
  gives no code: `type: "text"` in `packages/local/src/inspector.ts:37` and
  `packages/server/src/page.ts:67`, and `type: "file"` in
  `packages/codemode/src/thread.ts:72`. The review of a change looks for a
  `with {` (or `with:`) whose type is not `text` or `file`. To recover,
  remove the attribute: no record is lost. What would fix it: an import
  list that holds each import's attributes, from another parser.
