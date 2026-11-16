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
