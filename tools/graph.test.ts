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
  // A directory that does not hold it is no better; one that does is. (The
  // directory is there: an entry that names nothing is a fault of the row.)
  const dir = workspace({ [B]: `export const b = 1\nimport "./a.ts"\n`, "packages/core/src/b/notes.txt": `notes\n` })
  expect(run(dir, { ...only, budgets: [{ ...only.budgets[0]!, only: ["packages/core/src/b/"] }] })).toEqual([
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
// The fault of a file of a kind that the script cannot check, at line 1.
const UNCHECKED = (file: string, name = file) => file + ":1: way out, a kind of file that the script cannot check: " + name
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
  // z.mts is itself a kind of file that no rule checks.
  expect(run(workspace(mts), only)).toEqual([UNCHECKED("packages/local/src/z.mts"), ...lost(x + ":1", "./z.mts", "@everchat/local")])
  // Through b.ts, an allowed file of the core: ./c.mts, allowed too, reaches
  // tools/outside.ts, which is not.
  const root = workspace({ [B]: `import "./c.mts"\nexport const b = 1\n`, "packages/core/src/c.mts": `import "../../../tools/outside.ts"\n` })
  expect(run(root, { ...only, budgets: [{ ...only.budgets[0]!, only: ["packages/core/src/"] }] })).toEqual([UNCHECKED("packages/core/src/c.mts"), ...lost(B + ":1", "./c.mts", "@everchat/local")])
  // With only b.ts allowed, c.mts is itself the reach outside it.
  expect(run(root, only)).toEqual([
    UNCHECKED("packages/core/src/c.mts"),
    lost(B + ":1", "./c.mts")[0]!,
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
  expect(run(workspace({ ...entry, "packages/core/package.json": exports("./src/c.js"), "packages/core/src/c.js": `export const c = 1\n` }))).toEqual([UNCHECKED("packages/core/src/c.js"), ...lost(x + ":1", "@everchat/core/c")])
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
// row may. `self`: the fault of the file itself, at its line 1, when it is
// of a kind that no rule checks, or a source that no rule can read.
const REACH = `import "../../local/src/x.ts"\n`
const CANNOT: ReadonlyArray<{ readonly specifier: string; readonly files: Record<string, string>; readonly links?: Record<string, string>; readonly self?: string }> = [
  { specifier: "./z.JS", files: { "packages/core/src/z.JS": REACH }, self: UNCHECKED("packages/core/src/z.JS") },
  { specifier: "./z.TS", files: { "packages/core/src/z.TS": REACH }, self: UNCHECKED("packages/core/src/z.TS") },
  { specifier: "./z.Mjs", files: { "packages/core/src/z.Mjs": REACH }, self: UNCHECKED("packages/core/src/z.Mjs") },
  // A file with no extension: Bun runs it as code, and picks it before zz.ts.
  { specifier: "./zz", files: { "packages/core/src/zz": REACH }, self: UNCHECKED("packages/core/src/zz") },
  { specifier: "./zz", files: { "packages/core/src/zz": REACH, "packages/core/src/zz.ts": `export const zz = 1\n` }, self: UNCHECKED("packages/core/src/zz") },
  // A link z.ts to a file with no extension: decided on the real path. The
  // link is a source by its name that no rule can read.
  { specifier: "./z.ts", files: { "packages/core/src/zz": REACH }, links: { "packages/core/src/z.ts": "zz" }, self: "packages/core/src/zz:1: way out, " + NO_FILE + ": packages/core/src/z.ts" },
  // A kind that is not on the list of those that are not code.
  { specifier: "./z.yaml", files: { "packages/core/src/z.yaml": REACH }, self: UNCHECKED("packages/core/src/z.yaml") },
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
    const self = one.self === undefined ? [] : [one.self]
    expect([one.specifier, run(root, only)]).toEqual([one.specifier, [...self, ...lost(B + ":1", one.specifier, "@everchat/local")]])
    // The core's row forbids local, and b.ts is one of its starts.
    expect([one.specifier, run(root)]).toEqual([one.specifier, [...self, ...lost(B + ":1", one.specifier, "@everchat/core")]])
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

test("budget: each way to turn a row off is a fault at tools/graph.ts:1, and the row is not walked", () => {
  // local's ./x reaches b.ts, which reaches a.ts: the row below faults there.
  const root = workspace({ [B]: `export const b = 1\nimport "./a.ts"\n` })
  const row = { package: "@everchat/local", from: ["./x"], only: [B] }
  const with_ = (budget: object) => ({ ...FIXTURE, budgets: [budget] }) as unknown as Tables
  expect(run(root, with_(row))).toEqual([B + ":2: budget, @everchat/local may reach only " + B + ", and reaches packages/core/src/a.ts: ./a.ts"])
  // An entry of from that is not in the exports (and ./x, which it no longer names).
  expect(run(root, with_({ ...row, from: ["./nope"] }))).toEqual([
    "tools/graph.ts:1: budget, not an entry of @everchat/local: ./nope",
    "tools/graph.ts:1: budget, not named by the row of @everchat/local: ./x"
  ])
  // An empty from.
  expect(run(root, with_({ ...row, from: [] }))).toEqual([
    "tools/graph.ts:1: budget, no entry in from: @everchat/local",
    "tools/graph.ts:1: budget, not named by the row of @everchat/local: ./x"
  ])
  // An empty forbid, with no only: the core's row, whose files reach local.
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts" }, dependencies: { effect: "1", "@everchat/local": "workspace:*" } })
  const reach = workspace({ "packages/core/package.json": core, [B]: `import { x } from "@everchat/local/x"\nexport const b = x\n` })
  expect(run(reach)).toEqual([B + ":1: budget, @everchat/core must not reach packages/local/: @everchat/local/x"])
  expect(run(reach, with_({ package: "@everchat/core", from: "files", forbid: [] }))).toEqual(["tools/graph.ts:1: budget, an empty forbid: @everchat/core"])
  // An empty only, given beside a forbid.
  expect(run(root, with_({ ...row, only: [], forbid: ["packages/core/src/a.ts"] }))).toEqual(["tools/graph.ts:1: budget, an empty only: @everchat/local"])
})

test("budget: a start that the script cannot read is a fault at tools/graph.ts:1, naming the entry", () => {
  const local = (exports: Record<string, string>) => JSON.stringify({ name: "@everchat/local", exports: { "./x": "./src/x.ts", ...exports }, dependencies: { "@everchat/core": "workspace:*", effect: "1" }, devDependencies: { "happy-dom": "1" } })
  const row = (entry: string): Tables => ({ ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x", entry], only: [B] }] })
  // A missing file.
  expect(run(workspace({ "packages/local/package.json": local({ "./y": "./src/y.ts" }) }), row("./y"))).toEqual([
    "tools/graph.ts:1: budget, cannot read the start of @everchat/local: ./y"
  ])
  // A file that is not .ts: code (also a kind that no rule checks), and a page.
  expect(run(workspace({ "packages/local/package.json": local({ "./y": "./src/y.js" }), "packages/local/src/y.js": `import "@everchat/core"\n` }), row("./y"))).toEqual([
    UNCHECKED("packages/local/src/y.js"),
    "tools/graph.ts:1: budget, cannot read the start of @everchat/local: ./y"
  ])
  expect(run(workspace({ "packages/local/package.json": local({ "./y": "./src/y.html" }), "packages/local/src/y.html": `<p>a page</p>\n` }), row("./y"))).toEqual([
    "tools/graph.ts:1: budget, cannot read the start of @everchat/local: ./y"
  ])
  // A .ts file that is no member: one under node_modules.
  expect(run(workspace({ "packages/local/package.json": local({ "./y": "./node_modules/y/y.ts" }), "packages/local/node_modules/y/y.ts": `import "@everchat/core"\n` }), row("./y"))).toEqual([
    "tools/graph.ts:1: budget, cannot read the start of @everchat/local: ./y"
  ])
})

test("budget: a row with entries names each entry of the exports, so that a new one cannot slip past it", () => {
  // A new entry ./extra that ./x does not import, and that reaches a.ts.
  const local = JSON.stringify({ name: "@everchat/local", exports: { "./x": "./src/x.ts", "./extra": "./src/extra.ts" }, dependencies: { "@everchat/core": "workspace:*", effect: "1" }, devDependencies: { "happy-dom": "1" } })
  const root = workspace({ "packages/local/package.json": local, "packages/local/src/extra.ts": `import { a } from "@everchat/core"\nexport const extra = a\n` })
  const row = { package: "@everchat/local", from: ["./x"], only: [B] }
  expect(run(root, { ...FIXTURE, budgets: [row] })).toEqual(["tools/graph.ts:1: budget, not named by the row of @everchat/local: ./extra"])
  // Named, it is walked, and its reach is found.
  expect(run(root, { ...FIXTURE, budgets: [{ ...row, from: ["./x", "./extra"] }] })).toEqual([
    "packages/local/src/extra.ts:1: budget, @everchat/local may reach only " + B + ", and reaches packages/core/src/a.ts: @everchat/core"
  ])
  // A string of exports is the one entry ".".
  const one = JSON.stringify({ name: "@everchat/local", exports: "./src/x.ts", dependencies: { "@everchat/core": "workspace:*", effect: "1" }, devDependencies: { "happy-dom": "1" } })
  // (The core's test imports local's ./x, which this local does not have.)
  const plain = { "packages/local/package.json": one, "packages/core/src/a.test.ts": `import { test } from "node:test"\ntest("a", () => {})\n` }
  expect(run(workspace(plain), { ...FIXTURE, budgets: [{ ...row, from: ["."] }] })).toEqual([])
  expect(run(workspace(plain), { ...FIXTURE, budgets: [{ ...row, from: [] }] })).toEqual([
    "tools/graph.ts:1: budget, no entry in from: @everchat/local",
    "tools/graph.ts:1: budget, not named by the row of @everchat/local: ."
  ])
})

test("budget: each entry of forbid and of only names what is there, or the row is a fault at tools/graph.ts:1 and is not walked", () => {
  const with_ = (budget: object) => ({ ...FIXTURE, budgets: [budget] }) as unknown as Tables
  const line = (list: string, why: string, pkg: string, entry: string) => "tools/graph.ts:1: budget, an entry of " + list + " that " + why + ": " + pkg + " " + entry
  const BAD: ReadonlyArray<readonly [string, string]> = [
    ["./packages/local/", "is not a path from the root"],
    ["packages/locale/", "names nothing"],
    ["packages/local", "names a directory with no / at its end"],
    [B + "/", "ends in / and is no directory"]
  ]
  // forbid: the core's files reach local, and the good row faults there.
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts" }, dependencies: { effect: "1", "@everchat/local": "workspace:*" } })
  const reach = workspace({ "packages/core/package.json": core, [B]: `import { x } from "@everchat/local/x"\nexport const b = x\n` })
  const forbid = (entries: ReadonlyArray<string>) => run(reach, with_({ package: "@everchat/core", from: "files", forbid: entries }))
  expect(forbid(["packages/local/"])).toEqual([B + ":1: budget, @everchat/core must not reach packages/local/: @everchat/local/x"])
  for (const [entry, why] of BAD) {
    expect(forbid([entry])).toEqual([line("forbid", why, "@everchat/core", entry)])
    expect(forbid(["packages/local/", entry])).toEqual([line("forbid", why, "@everchat/core", entry)])
  }
  // only: local's ./x reaches b.ts, which reaches a.ts, outside only.
  const root = workspace({ [B]: `export const b = 1\nimport "./a.ts"\n` })
  const only = (entries: ReadonlyArray<string>) => run(root, with_({ package: "@everchat/local", from: ["./x"], only: entries }))
  expect(only([B])).toEqual([B + ":2: budget, @everchat/local may reach only " + B + ", and reaches packages/core/src/a.ts: ./a.ts"])
  for (const [entry, why] of BAD) {
    expect(only([entry])).toEqual([line("only", why, "@everchat/local", entry)])
    expect(only([B, entry])).toEqual([line("only", why, "@everchat/local", entry)])
  }
  // A file and a directory with "/": no fault from this rule, and the row
  // is walked (forbid finds its reach; only lets it pass).
  expect(forbid(["packages/local/src/x.ts", "packages/local/"])).toEqual([B + ":1: budget, @everchat/core must not reach packages/local/src/x.ts, packages/local/: @everchat/local/x"])
  expect(only([B, "packages/core/src/"])).toEqual([])
})

test("budget: an entry of forbid or only is written as its own real path: a link, in any part of it, is a fault, and the row is not walked", () => {
  const with_ = (budget: object) => ({ ...FIXTURE, budgets: [budget] }) as unknown as Tables
  const line = (list: string, pkg: string, entry: string) => "tools/graph.ts:1: budget, an entry of " + list + " that is not the real path of what it names: " + pkg + " " + entry
  // Links at the root to each package, and a link to a file in each.
  const links = { linklocal: "packages/local", linkcore: "packages/core", "packages/local/src/link.ts": "x.ts", "packages/core/src/blink.ts": "b.ts" }
  // forbid: the core's files reach local's x.ts.
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts" }, dependencies: { effect: "1", "@everchat/local": "workspace:*" } })
  const reach = workspace({ "packages/core/package.json": core, [B]: `import { x } from "@everchat/local/x"\nexport const b = x\n` }, links)
  const forbid = (entries: ReadonlyArray<string>, root = reach) => run(root, with_({ package: "@everchat/core", from: "files", forbid: entries }))
  const caught = [B + ":1: budget, @everchat/core must not reach packages/local/: @everchat/local/x"]
  expect(forbid(["packages/local/"])).toEqual(caught)
  // only: local's ./x reaches b.ts, which reaches a.ts, outside only.
  const root = workspace({ [B]: `export const b = 1\nimport "./a.ts"\n` }, links)
  const only = (entries: ReadonlyArray<string>, at = root) => run(at, with_({ package: "@everchat/local", from: ["./x"], only: entries }))
  const outside = [B + ":2: budget, @everchat/local may reach only " + B + ", and reaches packages/core/src/a.ts: ./a.ts"]
  expect(only([B])).toEqual(outside)
  // A link to a file, a link to a directory, and an entry under a parent
  // that is a link: each is the one fault of the row, beside a good entry
  // too, and no reach is reported.
  for (const entry of ["packages/local/src/link.ts", "linklocal/", "linklocal/src/x.ts"]) {
    expect(forbid([entry])).toEqual([line("forbid", "@everchat/core", entry)])
    expect(forbid(["packages/local/", entry])).toEqual([line("forbid", "@everchat/core", entry)])
  }
  for (const entry of ["packages/core/src/blink.ts", "linkcore/", "linkcore/src/b.ts"]) {
    expect(only([entry])).toEqual([line("only", "@everchat/local", entry)])
    expect(only([B, entry])).toEqual([line("only", "@everchat/local", entry)])
  }
  // A real file and a real directory pass, also when the root is reached
  // through a link: the base is the real path of the root.
  const via = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-graph-")), "root")
  made.push(path.dirname(via))
  fs.symlinkSync(reach, via)
  expect(forbid(["packages/local/src/x.ts"], via)).toEqual([B + ":1: budget, @everchat/core must not reach packages/local/src/x.ts: @everchat/local/x"])
  expect(forbid(["packages/local/"], via)).toEqual(caught)
  const onlyVia = path.join(path.dirname(via), "only")
  fs.symlinkSync(root, onlyVia)
  expect(only([B], onlyVia)).toEqual(outside)
  expect(only([B, "packages/core/src/"], onlyVia)).toEqual([])
})

test("entry: each target of exports is a string; any other is a fault at the manifest's line 1, and so is each import and each start of it", () => {
  const local = (y: unknown) => JSON.stringify({ name: "@everchat/local", exports: { "./x": "./src/x.ts", "./y": y }, dependencies: { "@everchat/core": "workspace:*", effect: "1" }, devDependencies: { "happy-dom": "1" } })
  const files = { "packages/local/src/y.ts": `export const y = 1\n`, "packages/local/src/i.ts": `export const i = 1\n` }
  const manifest = "packages/local/package.json:1: entry, a target that is not a string, in the exports of @everchat/local: ./y"
  for (const y of [{ bun: "./src/y.ts", import: "./src/i.ts" }, ["./src/y.ts"], null]) {
    // Imported or not, once.
    expect(run(workspace({ ...files, "packages/local/package.json": local(y) }))).toEqual([manifest])
    // An import of it: the entry is not in the exports, as this script reads them.
    expect(run(workspace({ ...files, "packages/local/package.json": local(y), "packages/local/src/z.ts": `import "@everchat/local/y"\n` }))).toEqual([
      manifest,
      "packages/local/src/z.ts:1: entry, not in the exports of @everchat/local: @everchat/local/y"
    ])
    // A row that starts from it.
    const row: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x", "./y"], only: [B] }] }
    expect(run(workspace({ ...files, "packages/local/package.json": local(y) }), row)).toEqual([
      manifest,
      "tools/graph.ts:1: budget, cannot read the start of @everchat/local: ./y"
    ])
  }
  // An object of strings, and a string: no fault from this rule.
  expect(run(workspace({ ...files, "packages/local/package.json": local("./src/y.ts") }))).toEqual([])
  const one = JSON.stringify({ name: "@everchat/local", exports: "./src/x.ts", dependencies: { "@everchat/core": "workspace:*", effect: "1" }, devDependencies: { "happy-dom": "1" } })
  expect(run(workspace({ "packages/local/package.json": one, "packages/core/src/a.test.ts": `import { test } from "node:test"\ntest("a", () => {})\n` }))).toEqual([])
})

test("a file that no rule can read is a fault at its line 1: a source whose real path is not .ts, a file of a kind off the list", () => {
  // A link zz.test.ts to a file with no extension, which imports a built-in
  // off the list of the core's tests: bun test runs it by its name.
  const link = workspace({ "packages/core/src/zztest": `import * as fs from "node:fs"\nexport const z = fs\n` }, { "packages/core/src/zz.test.ts": "zztest" })
  expect(run(link)).toEqual(["packages/core/src/zztest:1: way out, " + NO_FILE + ": packages/core/src/zz.test.ts"])
  // A .mts and a .js file of a package, which nothing imports.
  const kinds = workspace({ "packages/core/src/z.mts": `import "node:fs"\n`, "packages/local/src/y.js": `export const y = 1\n` })
  expect(run(kinds)).toEqual([UNCHECKED("packages/core/src/z.mts"), UNCHECKED("packages/local/src/y.js")])
  // The kinds on the list: .ts, .d.ts, .json, .html, .txt and .md. A file under
  // node_modules is no package's own.
  const good = workspace({
    "packages/core/src/c.d.ts": `export declare const c: number\n`,
    "packages/core/src/data.json": `{}\n`,
    "packages/core/src/page.html": `<p>a page</p>\n`,
    "packages/core/src/notes.txt": `notes\n`,
    "packages/core/node_modules/z/z.js": `export const z = 1\n`
  })
  expect(run(good)).toEqual([])
  // A link of a kind on the list to a file of a kind off it: the real path
  // decides, and the file is told once.
  expect(run(workspace({ "packages/core/src/z.bin": `x\n` }, { "packages/core/src/z.txt": "z.bin" }))).toEqual([UNCHECKED("packages/core/src/z.bin")])
})

test("a file that is no checked member is of one plain kind by its name and by its real path, or it is a fault at its line 1", () => {
  // A shared test outside every package, which loads a built-in off the
  // list of the core's tests. bun test runs a link to it by its name, and
  // no rule reads it: each link is a fault at the real file's line 1,
  // naming the link.
  const SHARED = "tools/shared.ts"
  const shared = { [SHARED]: `import { test } from "node:test"\nimport * as fs from "node:fs"\ntest("s", () => void fs)\n` }
  for (const name of ["x.test.js", "x.test.mts", "x.test.tsx", "x.json"]) {
    const link = "packages/core/src/" + name
    expect(run(workspace(shared, { [link]: "../../../" + SHARED }))).toEqual([UNCHECKED(SHARED, link)])
  }
  // A link of a runnable name to a .d.ts file: the kinds differ.
  const D = "packages/core/src/c.d.ts"
  expect(run(workspace({ [D]: `export declare const c: number\n` }, { "packages/core/src/x.test.js": "c.d.ts" }))).toEqual([UNCHECKED(D, "packages/core/src/x.test.js")])
  // A link of any name to a checked member is no fault here: the member is
  // checked, and a built-in off the list in it still faults, at the member.
  const M = "packages/core/src/m.ts"
  expect(run(workspace({ [M]: `import * as fs from "node:fs"\nexport const m = fs\n` }, { "packages/core/src/x.test.js": "m.ts" }))).toEqual([
    M + ":1: built-in, not on @everchat/core's list: node:fs"
  ])
  expect(run(workspace({}, { "packages/core/src/x.test.js": "b.ts" }))).toEqual([])
  // The plain kinds under their own names, and links between two of one kind.
  const good = workspace({
    [D]: `export declare const c: number\n`,
    "packages/core/src/data.json": `{}\n`,
    "packages/core/src/page.html": `<p>a page</p>\n`,
    "packages/core/src/notes.txt": `notes\n`
  }, { "packages/core/src/e.d.ts": "c.d.ts", "packages/core/src/more.json": "data.json" })
  expect(run(good)).toEqual([])
})

test("a Markdown file is no code, as a text file is: under a package, at its root and under its sources, it passes, and an import of one is a leaf", () => {
  // At a package's root and under its sources, by its own name.
  const notes = {
    "packages/core/AGENTS.md": `# core\n`,
    "packages/core/src/AGENTS.md": `# src\n`,
    "packages/local/src/notes.md": `notes\n`
  }
  expect(run(workspace(notes))).toEqual([])
  // An import of one that exists resolves to itself, imports nothing, and
  // is no fault, under forbid and under only, as a text file's.
  const only: Tables = { ...FIXTURE, budgets: [{ package: "@everchat/local", from: ["./x"], only: ["packages/core/src/"] }] }
  const imported = { [B]: `import notes from "./notes.md" with { type: "text" }\nexport const b = notes\n`, "packages/core/src/notes.md": `notes\n` }
  expect(run(workspace(imported))).toEqual([])
  expect(run(workspace(imported), only)).toEqual([])
  // A link of the kind to a file of a kind off the list: the real path
  // decides, and the file is told once.
  expect(run(workspace({ "packages/core/src/z.bin": `x\n` }, { "packages/core/src/z.md": "z.bin" }))).toEqual([UNCHECKED("packages/core/src/z.bin")])
  // A link of another plain kind to one: the kinds differ.
  const N = "packages/local/src/notes.md"
  expect(run(workspace(notes, { "packages/core/src/x.json": "../../local/src/notes.md" }))).toEqual([UNCHECKED(N, "packages/core/src/x.json")])
})

test("the rule at line 1 judges every file found under a package, by a link into another package too", () => {
  // local's files that no rule reads: a .ts and a .js file under its
  // node_modules, which load node:fs, a .d.ts file, a text file and a JSON
  // file of its src.
  const Z = "packages/local/node_modules/z/z.ts"
  const ZJS = "packages/local/node_modules/z/z.js"
  const L = "packages/local/src/l.d.ts"
  const N = "packages/local/src/n.txt"
  const theirs = {
    [Z]: `import * as fs from "node:fs"\nexport const z = fs\n`,
    [ZJS]: `import * as fs from "node:fs"\nexport const z = fs\n`,
    [L]: `export declare const l: number\n`,
    [N]: `notes\n`,
    "packages/local/src/data.json": `{}\n`
  }
  const at = (link: string, target: string) => run(workspace(theirs, { ["packages/core/src/" + link]: target }))
  // Faults at the real file's line 1, naming the link.
  for (const name of ["x.test.js", "x.test.mts", "x.test.tsx"]) {
    expect(at(name, "../../local/node_modules/z/z.ts")).toEqual([UNCHECKED(Z, "packages/core/src/" + name)])
  }
  expect(at("x.test.js", "../../local/src/l.d.ts")).toEqual([UNCHECKED(L, "packages/core/src/x.test.js")])
  expect(at("x.test.ts", "../../local/src/l.d.ts")).toEqual([L + ":1: way out, " + NO_FILE + ": packages/core/src/x.test.ts"])
  expect(at("x.json", "../../local/src/n.txt")).toEqual([UNCHECKED(N, "packages/core/src/x.json")])
  // A linked directory, not named node_modules, into local's node_modules.
  expect(at("lib", "../../local/node_modules/z")).toEqual([
    Z + ":1: way out, " + NO_FILE + ": packages/core/src/lib/z.ts",
    UNCHECKED(ZJS, "packages/core/src/lib/z.js")
  ])
  // No fault from this rule: a link to a member of local, which local's
  // rules check, once (here with no built-in on local's list, so that its
  // node:fs faults); links of one plain kind; a linked directory to
  // local's src.
  expect(at("x.test.js", "../../local/src/x.ts")).toEqual([])
  const strict: Tables = { ...FIXTURE, builtins: { ...FIXTURE.builtins, "@everchat/local": { src: [], tests: "any" } } }
  expect(run(workspace(theirs, { "packages/core/src/x.test.js": "../../local/src/x.ts" }), strict)).toEqual([
    "packages/local/src/x.ts:2: built-in, not on @everchat/local's list: node:fs"
  ])
  expect(run(workspace(theirs, { "packages/core/src/e.d.ts": "../../local/src/l.d.ts", "packages/core/src/more.json": "../../local/src/data.json" }))).toEqual([])
  expect(at("lsrc", "../../local/src")).toEqual([])
})

test("manifest: a file that is not a test imports no test's file, relative or by an entry", () => {
  const y = "packages/local/src/y.ts"
  // local's tests/help.ts imports happy-dom, a development package.
  expect(run(workspace({ [y]: `import { w } from "../tests/help.ts"\nexport const y = w\n` }))).toEqual([
    y + ":1: manifest, a test's file, which only a test may import: ../tests/help.ts"
  ])
  expect(run(workspace({ [y]: `\nimport "./x.test.ts"\n`, "packages/local/src/x.test.ts": `export const t = 1\n` }))).toEqual([
    y + ":2: manifest, a test's file, which only a test may import: ./x.test.ts"
  ])
  // Another package's ./testing entry, which names a test's file.
  const core = JSON.stringify({ name: "@everchat/core", exports: { ".": "./src/a.ts", "./b": "./src/b.ts", "./testing": "./tests/help.ts" }, dependencies: { effect: "1" }, devDependencies: { "@everchat/local": "workspace:*" } })
  const testing = { "packages/core/package.json": core, "packages/core/tests/help.ts": `export const help = 1\n` }
  expect(run(workspace({ ...testing, [y]: `import { help } from "@everchat/core/testing"\nexport const y = help\n` }))).toEqual([
    y + ":1: manifest, a test's file, which only a test may import: @everchat/core/testing"
  ])
  // A test may import both.
  const t = "packages/local/tests/t.test.ts"
  expect(run(workspace({ ...testing, [t]: `import { w } from "./help.ts"\nimport { help } from "@everchat/core/testing"\nexport const t = [w, help]\n` }))).toEqual([])
})

// The real tables, row by row, as the documents give them, so that a row
// deleted or widened in graph.ts fails here until this case changes with
// it. The sources:
// - core: `docs/design.md`, "Packages" (no runtime API but `createHash` of
//   `node:crypto`; the tests use `node:test`), and `packages/core/AGENTS.md`,
//   "The boundaries of the core" (`node:test`, `node:assert/strict`; the
//   tests run on Bun and on Node, so no `bun:` module). The tests' other two,
//   `node:crypto` and `node:path`, are graph.ts's own. It must not reach the
//   other packages: the root `AGENTS.md`, "Be modular" (it may import
//   `effect` only).
// - server: `packages/server/AGENTS.md`, "Its imports": its files import no
//   built-in module, and must not reach local, openai, sqlite or codemode;
//   its tests may import any.
// - mcp: `packages/mcp/AGENTS.md`, "Its imports": its files import no
//   built-in module, and must not reach local, openai, sqlite, codemode or
//   server; its tests may import any. The core must not reach it, nor the
//   server: the core's row forbids both.
// - openai, sqlite, codemode: the root `AGENTS.md`, "Be modular" (openai
//   may import the core's requests; sqlite and codemode the core, so none
//   reaches the others). Their lists of built-ins are graph.ts's own: the
//   documents name none.
// - local: the root `AGENTS.md`, "Be modular": it may import every other
//   package, and runs on Bun, so it has no row of BUDGETS and any built-in.
test("the real tables are the documents' rows: each package's built-ins, for its files and its tests, and each budget", () => {
  expect(BUILTINS).toEqual({
    "@everchat/core": { src: ["node:crypto"], tests: ["node:assert/strict", "node:crypto", "node:path", "node:test"] },
    "@everchat/local": { src: "any", tests: "any" },
    "@everchat/openai": { src: [], tests: "any" },
    "@everchat/sqlite": { src: [], tests: "any" },
    "@everchat/server": { src: [], tests: "any" },
    "@everchat/mcp": { src: [], tests: "any" },
    "@everchat/codemode": { src: ["node:fs/promises", "node:module", "node:worker_threads"], tests: "any" }
  })
  expect(BUDGETS).toEqual([
    { package: "@everchat/core", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/", "packages/codemode/", "packages/server/", "packages/mcp/"] },
    { package: "@everchat/openai", from: [".", "./gateway"], only: ["packages/core/src/request.ts"] },
    { package: "@everchat/sqlite", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/codemode/"] },
    { package: "@everchat/codemode", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/"] },
    { package: "@everchat/server", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/", "packages/codemode/"] },
    { package: "@everchat/mcp", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/", "packages/codemode/", "packages/server/"] }
  ])
})

test("check takes the real tables when it is given none", () => {
  const root = workspace({ [B]: `import "typescript"\nexport const b = 1\n` })
  expect(check(root)).toEqual(check(root, { builtins: BUILTINS, budgets: BUDGETS }))
})

// A package for each row of the real BUDGETS whose package the fixture
// does not have: its name, an entry for each of the row's entries, and a
// file that imports nothing, or, with `reach`, that imports local's x.ts,
// which each real row other than local's forbids or leaves outside `only`.
// And each path that a row's `forbid` or `only` names, when the fixture
// does not have it: an entry must name what is there. So the real tables
// find every package and path that they name, whichever rows they have.
const stubs = (reach = false): Record<string, string> => {
  const files: Record<string, string> = {}
  for (const row of BUDGETS) {
    if (row.package === "@everchat/core" || row.package === "@everchat/local") continue
    const dir = "packages/" + row.package.split("/").pop()
    const entries = row.from === "files" ? ["."] : row.from
    files[dir + "/package.json"] = JSON.stringify({ name: row.package, exports: Object.fromEntries(entries.map((entry) => [entry, "./src/stub.ts"])) })
    files[dir + "/src/stub.ts"] = reach ? `import "../../local/src/x.ts"\n` : `export const stub = 1\n`
  }
  const base = workspace()
  for (const row of BUDGETS) {
    for (const entry of [...(row.forbid ?? []), ...(row.only ?? [])]) {
      if (fs.existsSync(path.join(base, entry)) || Object.keys(files).some((one) => one.startsWith(entry))) continue
      files[entry.endsWith("/") ? entry + "stub.txt" : entry] = `export const stub = 1\n`
    }
  }
  return files
}

test("the script prints the faults and fails, and passes a clean workspace", () => {
  // The command uses the real tables: what it prints is what `check` gives
  // with them. The failing tree tries each real row: the core's b.ts, and
  // each stub, reach local's x.ts.
  const script = path.join(import.meta.dir, "graph.ts")
  const failing = workspace({ ...stubs(true), [B]: `import "typescript"\nimport "../../local/src/x.ts"\n` })
  const bad = Bun.spawnSync(["bun", script, failing], { stderr: "pipe", stdout: "pipe" })
  expect(bad.exitCode).toBe(1)
  const faults = check(failing)
  const core = BUDGETS.find((row) => row.package === "@everchat/core")!
  const reach = B + ":2: budget, @everchat/core must not reach " + core.forbid!.join(", ") + ": ../../local/src/x.ts"
  expect(faults).toContain(B + ":1: manifest, not declared by @everchat/core: typescript")
  expect(faults).toContain(reach)
  expect(bad.stderr.toString().split("\n")).toContain(reach)
  // Each real row gives its budget line, through the process too.
  for (const row of BUDGETS) expect(faults.some((line) => line.includes(": budget, " + row.package + " "))).toBe(true)
  expect(bad.stderr.toString()).toBe(faults.map((line) => line + "\n").join(""))
  const clean = workspace(stubs())
  const good = Bun.spawnSync(["bun", script, clean], { stderr: "pipe", stdout: "pipe" })
  expect(good.exitCode).toBe(0)
  expect(good.stdout.toString()).toBe("graph: the packages keep their boundaries\n")
  expect(check(clean)).toEqual([])
})
