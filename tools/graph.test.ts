// Tests of the boundary checks (graph.ts), on small workspaces in a
// temporary directory: a clean one passes, and each rule has a change that
// fails with its line.

import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { BUDGETS, BUILTINS, check, imports, type Tables } from "./graph.ts"

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

// The tables of the fixtures, written out: a change of the real tables
// (graph.ts) does not change what these tests check.
const FIXTURE: Tables = {
  builtins: {
    "@everchat/core": { src: ["node:crypto"], tests: ["node:assert/strict", "node:crypto", "node:path", "node:test"] },
    "@everchat/local": { src: "any", tests: "any" }
  },
  budgets: [{ package: "@everchat/core", from: "files", forbid: ["packages/local/"] }]
}

const run = (root: string, tables: Tables = FIXTURE) => check(root, tables)

test("a clean workspace has no fault", () => {
  expect(run(workspace())).toEqual([])
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
  expect(run(workspace({ [B]: `import "typescript"\nexport const b = 1\n` }))).toEqual([
    B + ":1: manifest, not declared by @everchat/core: typescript"
  ])
  // A development dependency is for tests only.
  const local = "packages/local/src/y.ts"
  expect(run(workspace({ [local]: `\nimport { Window } from "happy-dom"\nexport const y = Window\n` }))).toEqual([
    local + ":2: manifest, not declared by @everchat/local: happy-dom"
  ])
})

test("way out: a relative specifier that leaves the package", () => {
  // tools/outside.ts is no package's source, so the core's row cannot follow
  // it either.
  expect(run(workspace({ [B]: `import { outside } from "../../../tools/outside.ts"\nexport const b = outside\n` }))).toEqual([
    B + ":1: way out, outside packages/core: ../../../tools/outside.ts",
    B + ":1: budget, @everchat/core cannot follow it: it names no .ts file (write the file's path, with .ts): ../../../tools/outside.ts"
  ])
})

test("entry: a path that is not in the package's exports", () => {
  const x = "packages/local/src/x.ts"
  expect(run(workspace({ [x]: `import { a } from "@everchat/core/src/a.ts"\nexport const x = a\n` }))).toEqual([
    x + ":1: entry, not in the exports of @everchat/core: @everchat/core/src/a.ts"
  ])
})

test("built-in: a module that is not on the package's list", () => {
  expect(run(workspace({ [B]: `import * as fs from "node:fs"\nimport { Database } from "bun:sqlite"\nexport const b = [fs, Database]\n` }))).toEqual([
    B + ":1: built-in, not on @everchat/core's list: node:fs",
    B + ":2: built-in, not on @everchat/core's list: bun:sqlite"
  ])
  // The list names modules. Which names of `node:crypto` the core may use is
  // the core's type check's rule, so any of them, or all, pass here.
  expect(run(workspace({ [B]: `import { createHash, randomUUID } from "node:crypto"\nimport * as c from "crypto"\nexport const b = [createHash, randomUUID, c]\n` }))).toEqual([])
})

test("built-in: the core's tests have their own list, with no Bun module", () => {
  const T = "packages/core/src/a.test.ts"
  // Bun's own module: the core's tests also run on Node.
  expect(run(workspace({ [T]: `import { Database } from "bun:sqlite"\nimport { test } from "node:test"\ntest("a", () => void Database)\n` }))).toEqual([
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
  expect(run(workspace({ [T]: four }))).toEqual([])
  // A module is matched whole: `node:assert` is not `node:assert/strict`.
  expect(run(workspace({ [T]: `import * as assert from "node:assert"\nimport * as fs from "fs"\nexport const a = [assert, fs]\n` }))).toEqual([
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
  expect(run(workspace({ [B]: real }))).toEqual([
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
  expect(run(workspace({ [B]: decoys }))).toEqual([])
  // A decoy before the real import moves the line, a hint, and the fault
  // stays one.
  const moved = `// "node:fs"\nexport const b = 1\nimport * as fs from "node:fs"; void fs\n`
  expect(run(workspace({ [B]: moved }))).toEqual([
    B + ":1: built-in, not on @everchat/core's list: node:fs"
  ])
  // The decoys of the old rule on names: an allowed module in a comment,
  // and the real import of it with a comment in its list; two imports of it
  // on one line; strings that hold imports of it. No fault.
  const comment = [`/*`, `import { createHash } from "node:crypto"`, `*/`, `import { /* the function */ randomUUID } from "node:crypto"; void randomUUID`].join("\n")
  expect(run(workspace({ [B]: comment + "\nexport const b = 1\n" }))).toEqual([])
  const two = `import { createHash } from "node:crypto"; import { randomUUID } from "node:crypto"; void [createHash, randomUUID]`
  expect(run(workspace({ [B]: two + "\nexport const b = 1\n" }))).toEqual([])
  const strings = [
    `// import * as c from "node:crypto"`,
    `const s = 'import { randomUUID } from "node:crypto"'`,
    `const t = \``,
    `import { randomBytes } from "node:crypto"`,
    `\``,
    `import { /* the hash */ createHash /* only */ } from "node:crypto"`,
    `export const b = [s, t, createHash]`
  ].join("\n")
  expect(run(workspace({ [B]: strings }))).toEqual([])
})

test("built-in: a type-only import of a module off the list loads nothing, and is no fault", () => {
  const types = `import type { Stats } from "node:fs"\nimport { type Dirent } from "fs"\nexport type { Mode } from "node:fs"\nexport const b = (s: Stats, d: Dirent) => [s, d]\n`
  expect(run(workspace({ [B]: types }))).toEqual([])
})

test("symlinks: a link out of a package is a way out, and a link into local is in the budget's reach", () => {
  // A file of the core that is a link to a file of local.
  const linked = workspace({ [B]: `export const b = 1\nimport "./review-link.ts"\n` }, { "packages/core/src/review-link.ts": "../../local/src/x.ts" })
  expect(run(linked)).toEqual([
    B + ":2: way out, outside packages/core: ./review-link.ts",
    B + ":2: budget, @everchat/core must not reach packages/local/: ./review-link.ts"
  ])
  // A link to a directory out of the package.
  const directory = workspace({ [B]: `import { x } from "./sub/x.ts"\nexport const b = x\n` }, { "packages/core/src/sub": "../../local/src" })
  expect(run(directory)).toEqual([
    B + ":1: way out, outside packages/core: ./sub/x.ts",
    B + ":1: budget, @everchat/core must not reach packages/local/: ./sub/x.ts"
  ])
  // A link to a directory out of every package: its files are checked as
  // the core's, though nothing imports them.
  const outside = workspace({ "tools/fs.ts": `import * as fs from "node:fs"\nexport const f = fs\n` }, { "packages/core/src/tools": "../../../tools" })
  expect(run(outside)).toEqual([
    "tools/fs.ts:1: built-in, not on @everchat/core's list: node:fs"
  ])
  // An entry of the core whose real file is a file of local.
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts", "./l": "./src/l.ts" }, dependencies: { effect: "1" }, devDependencies: { "@everchat/local": "workspace:*" } })
  const entry = workspace({ "packages/core/package.json": core, [B]: `import { x } from "@everchat/core/l"\nexport const b = x\n` }, { "packages/core/src/l.ts": "../../local/src/x.ts" })
  expect(run(entry)).toEqual([
    B + ":1: way out, outside packages/core: @everchat/core/l",
    B + ":1: budget, @everchat/core must not reach packages/local/: @everchat/core/l"
  ])
})

test("symlinks: a link inside its package is followed, and its file is checked once, at its real path", () => {
  const c = "packages/core/src/c.ts"
  const root = workspace({ [B]: `import { c } from "./alias.ts"\nexport const b = c\n`, [c]: `\nimport * as fs from "node:fs"\nexport const c = fs\n` }, { "packages/core/src/alias.ts": "c.ts" })
  expect(run(root)).toEqual([
    c + ":2: built-in, not on @everchat/core's list: node:fs"
  ])
  expect(run(workspace({ [B]: `import { b2 } from "./alias.ts"\nexport const b = b2\n`, "packages/core/src/c.ts": `export const b2 = 2\n` }, { "packages/core/src/alias.ts": "c.ts" }))).toEqual([])
})

test("budget: a file of the core that reaches a file of local, through any chain", () => {
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts" }, dependencies: { effect: "1", "@everchat/local": "workspace:*" } })
  expect(run(workspace({ "packages/core/package.json": core, [B]: `import { x } from "@everchat/local/x"\nexport const b = x\n` }))).toEqual([
    B + ":1: budget, @everchat/core must not reach packages/local/: @everchat/local/x"
  ])
  // A relative way into local breaks two rules.
  expect(run(workspace({ [B]: `import "../../local/src/x.ts"\nexport const b = 1\n` }))).toEqual([
    B + ":1: way out, outside packages/core: ../../local/src/x.ts",
    B + ":1: budget, @everchat/core must not reach packages/local/: ../../local/src/x.ts"
  ])
})

test("budget, only: the reach stays in the files named, or in the row's own package", () => {
  // local's entry ./x reaches @everchat/core/b, and b.ts reaches nothing.
  const only = (paths: ReadonlyArray<string>): Tables => ({ ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: paths }] })
  expect(run(workspace(), only([B]))).toEqual([])
  expect(run(workspace(), only(["packages/core/src/"]))).toEqual([])
  // The row's own package is always in reach: local's files reach each other.
  const own = { "packages/local/src/x.ts": `import { y } from "./y.ts"\nimport { b } from "@everchat/core/b"\nexport const x = [y, b]\n`, "packages/local/src/y.ts": `export const y = 1\n` }
  expect(run(workspace(own), only([B]))).toEqual([])
})

test("budget, only: a start that reaches, through another package's file, a file outside them fails, at the importing line", () => {
  const only: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: [B] }] }
  // x.ts (local) reaches b.ts (core, allowed), and b.ts reaches a.ts (core, not named).
  const root = workspace({ [B]: `export const b = 1\nimport "./a.ts"\n` })
  expect(run(root, only)).toEqual([
    B + ":2: budget, @everchat/local may reach only " + B + ", and reaches packages/core/src/a.ts: ./a.ts"
  ])
  // A directory that does not hold it is no better; one that does is.
  expect(run(root, { ...only, budgets: [{ ...only.budgets[0]!, only: ["packages/core/src/b/"] }] })).toEqual([
    "packages/local/src/x.ts:3: budget, @everchat/local may reach only packages/core/src/b/, and reaches " + B + ": @everchat/core/b"
  ])
  expect(run(root, { ...only, budgets: [{ ...only.budgets[0]!, only: ["packages/core/src/"] }] })).toEqual([])
  // With `forbid` too, a forbidden file is a fault of `forbid`.
  const both: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: [B], forbid: ["packages/core/src/a.ts"] }] }
  expect(run(root, both)).toEqual([
    B + ":2: budget, @everchat/local must not reach packages/core/src/a.ts: ./a.ts"
  ])
})

// The two faults of an import that the script cannot follow to a .ts file:
// the way out, and the budget of `row` when its walk passes it.
const NO_FILE = "names no .ts file (write the file's path, with .ts)"
const lost = (at: string, specifier: string, row?: string) => [
  at + ": way out, " + NO_FILE + ": " + specifier,
  ...(row === undefined ? [] : [at + ": budget, " + row + " cannot follow it: it " + NO_FILE + ": " + specifier])
]

test("budget fails closed: a start that reaches a file outside only through ./z.js, with z.ts on disk, fails at the importing line", () => {
  const only: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: [B] }] }
  // x.ts (local) imports ./z.js; Bun runs z.ts, which reaches a.ts (core, not named).
  const x = "packages/local/src/x.ts"
  const z = { [x]: `import { b } from "@everchat/core/b"\nimport { z } from "./z.js"\nexport const x = [b, z]\n`, "packages/local/src/z.ts": `import { a } from "@everchat/core"\nexport const z = a\n` }
  expect(run(workspace(z), only)).toEqual(lost(x + ":2", "./z.js", "@everchat/local"))
  // With the path written with .ts, the walk finds the reach.
  expect(run(workspace({ ...z, [x]: z[x]!.replace("./z.js", "./z.ts") }), only)).toEqual([
    "packages/local/src/z.ts:1: budget, @everchat/local may reach only " + B + ", and reaches packages/core/src/a.ts: @everchat/core"
  ])
  // Through an allowed entry of another package: x.ts reaches b.ts (core,
  // allowed), and b.ts imports ./a.js, which Bun runs as a.ts. The core's
  // own row (from its files) fails there too.
  const root = workspace({ [B]: `export const b = 1\nimport "./a.js"\n` })
  expect(run(root, only)).toEqual(lost(B + ":2", "./a.js", "@everchat/local"))
  expect(run(root, { ...FIXTURE, budgets: [...only.budgets, ...FIXTURE.budgets] })).toEqual([
    ...lost(B + ":2", "./a.js", "@everchat/local"),
    B + ":2: budget, @everchat/core cannot follow it: it " + NO_FILE + ": ./a.js"
  ])
})

test("budget fails closed: the same through ./z.mts, a kind of code that the script does not read", () => {
  const only: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: [B] }] }
  const x = "packages/local/src/x.ts"
  const mts = { [x]: `import { z } from "./z.mts"\nexport const x = z\n`, "packages/local/src/z.mts": `import { a } from "@everchat/core"\nexport const z = a\n` }
  expect(run(workspace(mts), only)).toEqual(lost(x + ":1", "./z.mts", "@everchat/local"))
  // Through b.ts, an allowed file of the core: ./c.mts, allowed too, reaches
  // tools/outside.ts, which is not.
  const root = workspace({ [B]: `import "./c.mts"\nexport const b = 1\n`, "packages/core/src/c.mts": `import "../../../tools/outside.ts"\n` })
  expect(run(root, { ...only, budgets: [{ ...only.budgets[0]!, only: ["packages/core/src/"] }] })).toEqual(lost(B + ":1", "./c.mts", "@everchat/local"))
  // With only b.ts allowed, c.mts is itself the reach outside it.
  expect(run(root, only)).toEqual([
    lost(B + ":1", "./c.mts")[0],
    B + ":1: budget, @everchat/local may reach only " + B + ", and reaches packages/core/src/c.mts: ./c.mts"
  ])
  // And ./z.mts with only z.ts on disk: no file.
  expect(run(workspace({ [B]: `import "./a.mts"\nexport const b = 1\n` }), only)).toEqual(lost(B + ":1", "./a.mts", "@everchat/local"))
})

test("an import of the workspace that names no file is a fault; an import of a text file that exists is not", () => {
  // A relative import of a file that does not exist: the way out, and the
  // core's row, whose walk passes it.
  expect(run(workspace({ [B]: `import "./nope.ts"\nexport const b = 1\n` }))).toEqual(lost(B + ":1", "./nope.ts", "@everchat/core"))
  // In a file that no budget walks, the way out alone.
  const y = "packages/local/src/y.ts"
  expect(run(workspace({ [y]: `\nimport "./nope"\nexport const y = 1\n` }))).toEqual(lost(y + ":2", "./nope"))
  // An entry of the exports whose file does not exist, or is not .ts.
  const x = "packages/local/src/x.ts"
  const exports = (file: string) => JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts", "./c": file }, dependencies: { effect: "1" }, devDependencies: { "@everchat/local": "workspace:*" } })
  const entry = { [x]: `import { c } from "@everchat/core/c"\nexport const x = c\n` }
  expect(run(workspace({ ...entry, "packages/core/package.json": exports("./src/c.ts") }))).toEqual(lost(x + ":1", "@everchat/core/c"))
  expect(run(workspace({ ...entry, "packages/core/package.json": exports("./src/c.js"), "packages/core/src/c.js": `export const c = 1\n` }))).toEqual(lost(x + ":1", "@everchat/core/c"))
  // Through a walk, an entry with no file fails the budget too.
  const only: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: ["packages/core/src/"] }] }
  expect(run(workspace({ ...entry, "packages/core/package.json": exports("./src/c.ts") }), only)).toEqual(lost(x + ":1", "@everchat/core/c", "@everchat/local"))
  // A page and a text file that exist resolve to themselves, import
  // nothing, and are no fault, under forbid and under only. The page is
  // imported as text, as the tree does: the script does not see an import's
  // type, and to Bun an HTML import with none is a bundle.
  const texts = { [B]: `import page from "./page.html" with { type: "text" }\nimport notes from "./notes.txt" with { type: "text" }\nexport const b = [page, notes]\n`, "packages/core/src/page.html": `<p>a page</p>\n`, "packages/core/src/notes.txt": `notes\n` }
  expect(run(workspace(texts))).toEqual([])
  expect(run(workspace(texts), only)).toEqual([])
})

// Each file that Bun runs as code and that the script does not read: one
// whose real name does not end in exactly .ts, or a .ts file that is no
// package's own source (a .d.ts, one under node_modules). The import of it,
// at b.ts:1, and the files on disk. Each file reaches local, which neither
// row may.
const REACH = `import "../../local/src/x.ts"\n`
const CANNOT: ReadonlyArray<{ readonly specifier: string; readonly files: Record<string, string>; readonly links?: Record<string, string> }> = [
  { specifier: "./z.JS", files: { "packages/core/src/z.JS": REACH } },
  { specifier: "./z.TS", files: { "packages/core/src/z.TS": REACH } },
  { specifier: "./z.Mjs", files: { "packages/core/src/z.Mjs": REACH } },
  // A file with no extension: Bun runs it as code, and picks it before zz.ts.
  { specifier: "./zz", files: { "packages/core/src/zz": REACH } },
  { specifier: "./zz", files: { "packages/core/src/zz": REACH, "packages/core/src/zz.ts": `export const zz = 1\n` } },
  // A link z.ts to a file with no extension: decided on the real path.
  { specifier: "./z.ts", files: { "packages/core/src/zz": REACH }, links: { "packages/core/src/z.ts": "zz" } },
  // A kind that is not on the list of those that are not code.
  { specifier: "./z.yaml", files: { "packages/core/src/z.yaml": REACH } },
  // A declaration file: its name ends in .ts, but it is no source of the
  // package, so no rule reads its imports. Bun runs it as code.
  { specifier: "./z.d.ts", files: { "packages/core/src/z.d.ts": REACH } },
  // A .ts file under the package's own node_modules, a real directory.
  { specifier: "../node_modules/z/z.ts", files: { "packages/core/node_modules/z/z.ts": `import "../../../local/src/x.ts"\n` } }
]

test("the script follows only a .ts file of a package's own or a kind on its list: any other file fails at the importing line, under only and under forbid", () => {
  const only: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: ["packages/core/"] }] }
  for (const one of CANNOT) {
    const root = workspace({ ...one.files, [B]: `import "${one.specifier}"\nexport const b = 1\n` }, one.links)
    // local's x.ts reaches b.ts; b.ts imports the file. Both are in the
    // core, which the row allows: the one fault is that the walk cannot
    // follow the file.
    expect([one.specifier, run(root, only)]).toEqual([one.specifier, lost(B + ":1", one.specifier, "@everchat/local")])
    // The core's row forbids local, and b.ts is one of its starts.
    expect([one.specifier, run(root)]).toEqual([one.specifier, lost(B + ":1", one.specifier, "@everchat/core")])
  }
  // A directory is no file either.
  const directory = workspace({ [B]: `import "./d"\nexport const b = 1\n`, "packages/core/src/d/x.txt": `text\n` })
  expect(run(directory)).toEqual(lost(B + ":1", "./d", "@everchat/core"))
})

test("an import of a .d.ts file is a fault, and the imports in it, which no rule reads, are not", () => {
  // e.d.ts imports a built-in off the core's list and a package that the
  // core does not declare. Bun runs it as code; the script cannot follow it:
  // the one fault is the import of it, the way out, and the core's row.
  const root = workspace({
    [B]: `import "./e.d.ts"\nexport const b = 1\n`,
    "packages/core/src/e.d.ts": `import "node:fs"\nimport "typescript"\nexport declare const e: number\n`
  })
  expect(run(root)).toEqual(lost(B + ":1", "./e.d.ts", "@everchat/core"))
  // A type-only import of it loads nothing, and is no fault.
  expect(run(workspace({ [B]: `import type { e } from "./e.d.ts"\nexport const b: typeof e = 1\n`, "packages/core/src/e.d.ts": `import "node:fs"\nexport declare const e: number\n` }))).toEqual([])
})

test("budget: a row for a package that the tree does not have, or with no rule, is a fault", () => {
  const missing: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/openai", from: ["."], only: ["packages/core/src/request.ts"] }] }
  expect(run(workspace(), missing)).toEqual(["tools/graph.ts:1: budget, no package: @everchat/openai"])
  const none = { ...FIXTURE, budgets: [{ package: "@everchat/core", from: "files" }] } as unknown as Tables
  expect(run(workspace(), none)).toEqual(["tools/graph.ts:1: budget, neither forbid nor only: @everchat/core"])
})

test("check takes the real tables when it is given none", () => {
  const root = workspace({ [B]: `import "typescript"\nexport const b = 1\n` })
  expect(check(root)).toEqual(check(root, { builtins: BUILTINS, budgets: BUDGETS }))
})

// A package for each row of the real BUDGETS whose package the fixture
// does not have: its name, an entry for each of the row's entries, and a
// file that imports nothing. So the real tables find every package that
// they name, whichever rows they have.
const stubs = (): Record<string, string> => {
  const files: Record<string, string> = {}
  for (const row of BUDGETS) {
    if (row.package === "@everchat/core" || row.package === "@everchat/local") continue
    const dir = "packages/" + row.package.split("/").pop()
    const entries = row.from === "files" ? ["."] : row.from
    files[dir + "/package.json"] = JSON.stringify({ name: row.package, exports: Object.fromEntries(entries.map((entry) => [entry, "./src/stub.ts"])) })
    files[dir + "/src/stub.ts"] = `export const stub = 1\n`
  }
  return files
}

test("the script prints the faults and fails, and passes a clean workspace", () => {
  // The command uses the real tables: what it prints is what `check` gives
  // with them.
  const script = path.join(import.meta.dir, "graph.ts")
  const failing = workspace({ ...stubs(), [B]: `import "typescript"\n` })
  const bad = Bun.spawnSync(["bun", script, failing], { stderr: "pipe", stdout: "pipe" })
  expect(bad.exitCode).toBe(1)
  expect(bad.stderr.toString()).toBe(B + ":1: manifest, not declared by @everchat/core: typescript\n")
  expect(check(failing)).toEqual([B + ":1: manifest, not declared by @everchat/core: typescript"])
  const clean = workspace(stubs())
  const good = Bun.spawnSync(["bun", script, clean], { stderr: "pipe", stdout: "pipe" })
  expect(good.exitCode).toBe(0)
  expect(good.stdout.toString()).toBe("graph: the packages keep their boundaries\n")
  expect(check(clean)).toEqual([])
})
