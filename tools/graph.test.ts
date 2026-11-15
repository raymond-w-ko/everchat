// Tests of the boundary checks (graph.ts), on small workspaces in a
// temporary directory: a clean one passes, and each rule has a change that
// fails with its line.

import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { check, imports } from "./graph.ts"

const made: Array<string> = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

// A clean workspace, with `change` written over it: a path from the root,
// and its text. `links`: symlinks to make, a path from the root and its
// target (as the link holds it, relative to the link's directory).
const workspace = (change: Record<string, string> = {}, links: Record<string, string> = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-graph-"))
  made.push(root)
  const files: Record<string, string> = {
    "packages/core/package.json": JSON.stringify({
      name: "@everchat/core",
      exports: { ".": "./src/a.ts", "./b": "./src/b.ts" },
      dependencies: { effect: "1" },
      devDependencies: { "@everchat/local": "workspace:*" }
    }),
    "packages/core/src/a.ts": [
      `import { Effect } from "effect"`,
      `import { createHash } from "node:crypto"`,
      `import { b } from "./b.ts"`,
      `import type { X } from "../../local/src/x.ts"`,
      `import { type Y } from "@everchat/local/x"`,
      `export const a = (x: X, y: Y) => [Effect, createHash, b, x, y]`
    ].join("\n"),
    "packages/core/src/b.ts": `export const b = 1\n`,
    "packages/core/src/a.test.ts": [
      `import { test } from "node:test"`,
      `import * as path from "node:path"`,
      `import { x } from "@everchat/local/x"`,
      `test("a", () => void [path, x])`
    ].join("\n"),
    "packages/local/package.json": JSON.stringify({
      name: "@everchat/local",
      exports: { "./x": "./src/x.ts" },
      dependencies: { "@everchat/core": "workspace:*", effect: "1" },
      devDependencies: { "happy-dom": "1" }
    }),
    "packages/local/src/x.ts": [
      `#!/usr/bin/env bun`,
      `import * as fs from "node:fs"`,
      `import { b } from "@everchat/core/b"`,
      `import {`,
      `  Effect`,
      `} from "effect"`,
      `export const x = [fs, b, Effect]`
    ].join("\n"),
    "packages/local/tests/help.ts": `import { Window } from "happy-dom"\nexport const w = Window\n`,
    "tools/outside.ts": `export const outside = 1\n`,
    ...change
  }
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(root, name))
  return root
}

const B = "packages/core/src/b.ts"

test("a clean workspace has no fault", () => {
  expect(check(workspace())).toEqual([])
})

test("only value imports count, as Bun's parser finds them, each at the first line with its specifier in quotes", () => {
  const text = [
    `import type { A } from "a"`,
    `import { type B } from "b"`,
    `import { C, type D } from "c"`,
    `export type { E } from "e"`,
    `export * from "f"`,
    `// import "g"`,
    `import "h"`,
    `const i = await import("i")`,
    `import {`,
    `  J as K`,
    `} from "j"`,
    `/*`,
    `import { L } from "c"`,
    `*/`,
    `const m = "import { M } from 'c'"`,
    `const n = \`\${\`import { N } from "c"\`} import { O } from "c"\``,
    `const p = /import { P } from "c"/`,
    `import { /* the name */ Q } from "q"; export { R, type S } from "r"; import.meta.url`,
    `import {} from "t"`
  ].join("\n")
  expect(imports(text).map((one) => [one.specifier, one.line])).toEqual([
    ["c", 3],
    ["f", 5],
    ["h", 7],
    ["i", 8],
    ["j", 11],
    ["q", 18],
    ["r", 18],
    ["t", 19]
  ])
})

test("manifest: a bare specifier that the package does not declare", () => {
  expect(check(workspace({ [B]: `import "typescript"\nexport const b = 1\n` }))).toEqual([
    B + ":1: manifest, not declared by @everchat/core: typescript"
  ])
  // A development dependency is for tests only.
  const local = "packages/local/src/y.ts"
  expect(check(workspace({ [local]: `\nimport { Window } from "happy-dom"\nexport const y = Window\n` }))).toEqual([
    local + ":2: manifest, not declared by @everchat/local: happy-dom"
  ])
})

test("way out: a relative specifier that leaves the package", () => {
  expect(check(workspace({ [B]: `import { outside } from "../../../tools/outside.ts"\nexport const b = outside\n` }))).toEqual([
    B + ":1: way out, outside packages/core: ../../../tools/outside.ts"
  ])
})

test("entry: a path that is not in the package's exports", () => {
  const x = "packages/local/src/x.ts"
  expect(check(workspace({ [x]: `import { a } from "@everchat/core/src/a.ts"\nexport const x = a\n` }))).toEqual([
    x + ":1: entry, not in the exports of @everchat/core: @everchat/core/src/a.ts"
  ])
})

test("built-in: a module that is not on the package's list", () => {
  expect(check(workspace({ [B]: `import * as fs from "node:fs"\nimport { Database } from "bun:sqlite"\nexport const b = [fs, Database]\n` }))).toEqual([
    B + ":1: built-in, not on @everchat/core's list: node:fs",
    B + ":2: built-in, not on @everchat/core's list: bun:sqlite"
  ])
  // The list names modules. Which names of `node:crypto` the core may use is
  // the core's type check's rule, so any of them, or all, pass here.
  expect(check(workspace({ [B]: `import { createHash, randomUUID } from "node:crypto"\nimport * as c from "crypto"\nexport const b = [createHash, randomUUID, c]\n` }))).toEqual([])
})

test("built-in: the core's tests have their own list, with no Bun module", () => {
  const T = "packages/core/src/a.test.ts"
  // Bun's own module: the core's tests also run on Node.
  expect(check(workspace({ [T]: `import { Database } from "bun:sqlite"\nimport { test } from "node:test"\ntest("a", () => void Database)\n` }))).toEqual([
    T + ":1: built-in, not on @everchat/core's list: bun:sqlite"
  ])
  // The four modules that they use pass.
  const four = [
    `import * as assert from "node:assert/strict"`,
    `import { createHash } from "node:crypto"`,
    `import * as path from "node:path"`,
    `import { test } from "node:test"`,
    `test("a", () => void [assert, createHash, path])`
  ].join("\n")
  expect(check(workspace({ [T]: four }))).toEqual([])
  // A module is matched whole: `node:assert` is not `node:assert/strict`.
  expect(check(workspace({ [T]: `import * as assert from "node:assert"\nimport * as fs from "fs"\nexport const a = [assert, fs]\n` }))).toEqual([
    T + ":1: built-in, not on @everchat/core's list: node:assert",
    T + ":2: built-in, not on @everchat/core's list: fs"
  ])
})

test("built-in: the real import counts, whatever comments, strings, templates and regular expressions hold", () => {
  // Allowed imports in a comment, a string, a template, and a regular
  // expression after `if (...)`; the real import of `node:fs` after
  // `n++ / 2`, on a line with regular expressions.
  const real = [
    `// import { createHash } from "node:crypto"`,
    `const s = 'import { createHash } from "node:crypto"'`,
    `const t = \`import * as c from "node:crypto"\``,
    `if (true) /import { createHash } from "node:crypto"/.test("code");`,
    `let n = 1; n++ / 2; import * as fs from "node:fs"; /x/.test("code"); void fs;`,
    `export const b = [s, t]`
  ].join("\n")
  expect(check(workspace({ [B]: real }))).toEqual([
    B + ":5: built-in, not on @everchat/core's list: node:fs"
  ])
  // Import text of `node:fs` in the same places, and no real import of it:
  // no fault.
  const decoys = [
    `/* import * as fs from "node:fs" */`,
    `const s = 'import * as fs from "node:fs"'`,
    `const t = \`import { readFileSync } from "node:fs"\``,
    `if (true) /import * as fs from "node:fs"/.test("code");`,
    `let n = 1; n++ / 2; /import "node:fs"/.test("code");`,
    `export const b = [s, t, n]`
  ].join("\n")
  expect(check(workspace({ [B]: decoys }))).toEqual([])
  // A decoy before the real import moves the line, a hint, and the fault
  // stays one.
  const moved = `// "node:fs"\nexport const b = 1\nimport * as fs from "node:fs"; void fs\n`
  expect(check(workspace({ [B]: moved }))).toEqual([
    B + ":1: built-in, not on @everchat/core's list: node:fs"
  ])
  // The decoys of the old rule on names: an allowed module in a comment,
  // and the real import of it with a comment in its list; two imports of it
  // on one line; strings that hold imports of it. No fault.
  const comment = [`/*`, `import { createHash } from "node:crypto"`, `*/`, `import { /* the function */ randomUUID } from "node:crypto"; void randomUUID`].join("\n")
  expect(check(workspace({ [B]: comment + "\nexport const b = 1\n" }))).toEqual([])
  const two = `import { createHash } from "node:crypto"; import { randomUUID } from "node:crypto"; void [createHash, randomUUID]`
  expect(check(workspace({ [B]: two + "\nexport const b = 1\n" }))).toEqual([])
  const strings = [
    `// import * as c from "node:crypto"`,
    `const s = 'import { randomUUID } from "node:crypto"'`,
    `const t = \``,
    `import { randomBytes } from "node:crypto"`,
    `\``,
    `import { /* the hash */ createHash /* only */ } from "node:crypto"`,
    `export const b = [s, t, createHash]`
  ].join("\n")
  expect(check(workspace({ [B]: strings }))).toEqual([])
})

test("built-in: a type-only import of a module off the list loads nothing, and is no fault", () => {
  const types = `import type { Stats } from "node:fs"\nimport { type Dirent } from "fs"\nexport type { Mode } from "node:fs"\nexport const b = (s: Stats, d: Dirent) => [s, d]\n`
  expect(check(workspace({ [B]: types }))).toEqual([])
})

test("symlinks: a link out of a package is a way out, and a link into local is in the budget's reach", () => {
  // A file of the core that is a link to a file of local.
  const linked = workspace({ [B]: `export const b = 1\nimport "./review-link.ts"\n` }, { "packages/core/src/review-link.ts": "../../local/src/x.ts" })
  expect(check(linked)).toEqual([
    B + ":2: way out, outside packages/core: ./review-link.ts",
    B + ":2: budget, @everchat/core must not reach packages/local/: ./review-link.ts"
  ])
  // A link to a directory out of the package.
  const directory = workspace({ [B]: `import { x } from "./sub/x.ts"\nexport const b = x\n` }, { "packages/core/src/sub": "../../local/src" })
  expect(check(directory)).toEqual([
    B + ":1: way out, outside packages/core: ./sub/x.ts",
    B + ":1: budget, @everchat/core must not reach packages/local/: ./sub/x.ts"
  ])
  // A link to a directory out of every package: its files are checked as
  // the core's, though nothing imports them.
  const outside = workspace({ "tools/fs.ts": `import * as fs from "node:fs"\nexport const f = fs\n` }, { "packages/core/src/tools": "../../../tools" })
  expect(check(outside)).toEqual([
    "tools/fs.ts:1: built-in, not on @everchat/core's list: node:fs"
  ])
  // An entry of the core whose real file is a file of local.
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts", "./l": "./src/l.ts" }, dependencies: { effect: "1" }, devDependencies: { "@everchat/local": "workspace:*" } })
  const entry = workspace({ "packages/core/package.json": core, [B]: `import { x } from "@everchat/core/l"\nexport const b = x\n` }, { "packages/core/src/l.ts": "../../local/src/x.ts" })
  expect(check(entry)).toEqual([
    B + ":1: way out, outside packages/core: @everchat/core/l",
    B + ":1: budget, @everchat/core must not reach packages/local/: @everchat/core/l"
  ])
})

test("symlinks: a link inside its package is followed, and its file is checked once, at its real path", () => {
  const c = "packages/core/src/c.ts"
  const root = workspace({ [B]: `import { c } from "./alias.ts"\nexport const b = c\n`, [c]: `\nimport * as fs from "node:fs"\nexport const c = fs\n` }, { "packages/core/src/alias.ts": "c.ts" })
  expect(check(root)).toEqual([
    c + ":2: built-in, not on @everchat/core's list: node:fs"
  ])
  expect(check(workspace({ [B]: `import { b2 } from "./alias.ts"\nexport const b = b2\n`, "packages/core/src/c.ts": `export const b2 = 2\n` }, { "packages/core/src/alias.ts": "c.ts" }))).toEqual([])
})

test("budget: a file of the core that reaches a file of local, through any chain", () => {
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts" }, dependencies: { effect: "1", "@everchat/local": "workspace:*" } })
  expect(check(workspace({ "packages/core/package.json": core, [B]: `import { x } from "@everchat/local/x"\nexport const b = x\n` }))).toEqual([
    B + ":1: budget, @everchat/core must not reach packages/local/: @everchat/local/x"
  ])
  // A relative way into local breaks two rules.
  expect(check(workspace({ [B]: `import "../../local/src/x.ts"\nexport const b = 1\n` }))).toEqual([
    B + ":1: way out, outside packages/core: ../../local/src/x.ts",
    B + ":1: budget, @everchat/core must not reach packages/local/: ../../local/src/x.ts"
  ])
})

test("the script prints the faults and fails, and passes a clean workspace", () => {
  const script = path.join(import.meta.dir, "graph.ts")
  const bad = Bun.spawnSync(["bun", script, workspace({ [B]: `import "typescript"\n` })], { stderr: "pipe", stdout: "pipe" })
  expect(bad.exitCode).toBe(1)
  expect(bad.stderr.toString()).toBe(B + ":1: manifest, not declared by @everchat/core: typescript\n")
  const good = Bun.spawnSync(["bun", script, workspace()], { stderr: "pipe", stdout: "pipe" })
  expect(good.exitCode).toBe(0)
})
