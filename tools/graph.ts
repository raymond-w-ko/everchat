// Graph
// =====
// The two checks of the packages' boundaries that the type checks and Bun's
// linker let through (docs/design.md, "Packages"; docs/research/packages.md,
// "How a check enforces the boundaries", K3 and K5). `just check` runs it:
// `bun tools/graph.ts [root]`. It prints one line for each fault,
// `<file>:<line>: <rule>: <specifier>`, and fails if there is one.
//
// - manifest (K5): a bare specifier names the package itself or one of its
//   `dependencies`, `peerDependencies` or `optionalDependencies`. A test
//   may also use `devDependencies`. So a file that is not a test imports
//   no test's file, relative or by an entry (`./testing`): it would bring
//   the tests' development packages and built-ins into run-time code.
// - way out (K3): a relative specifier stays in its package's directory.
//   It, or an entry of a workspace package, also names a file that this
//   script can follow (`kind`: a `.ts` file of a package's own, or a kind on
//   the list of those that are not code, NOT_CODE): one that it cannot is a
//   way out of its sight, since Bun may load what the script never reads
//   (`./z.js` runs `z.ts`, which may be a link out; a file with no extension
//   runs as code). The script reads the imports of the packages' own source
//   files only, the files that every rule checks: a value import of any
//   other `.ts` file, a `.d.ts` or one under `node_modules`, is one that it
//   cannot follow. A file that no rule can read is a fault at its line 1:
//   a source whose real path is not a `.ts` file (a link `zz.test.ts` to a
//   file `zztest`, which `bun test` runs by its name), and a file that is
//   not a checked member and is not, by its name and by its real path, of
//   the same plain kind (`.d.ts`, `.json`, or NOT_CODE): a `.js` or `.mts`
//   file, a file with no extension, or a link `x.test.js` to a `.ts` file
//   that no rule reads. The rule judges every file found under a package's
//   directory, by a link into another package too (its `.d.ts` files, its
//   `node_modules`); ownership decides only whose member a file is.
// - entry (K3): an import of a workspace package names a path of its
//   `exports`. Each target of `exports` is a string: any other (an object
//   of conditions, a list, null) is a fault at line 1 of the manifest, for
//   each key, since Bun's order of conditions is not this script's.
// - built-in (K3): a `node:` or `bun:` module is on its package's list
//   (BUILTINS). The list names modules only. Which names of `node:crypto`
//   the core may use (`createHash`) is the core's type check's rule
//   (packages/core/tsconfig.json, packages/core/tsconfig.core.d.ts), not
//   this script's.
// - budget (K3): the files that a budget starts from do not reach, through
//   value imports and across packages, a file that it forbids, or, when it
//   names the only files allowed, a file outside them and outside its own
//   package (BUDGETS). The walk fails closed: an import of the workspace
//   that it cannot follow to a file is a fault of each budget that reaches
//   it. A row that the script could not hold is a fault at
//   `tools/graph.ts:1`, and is not walked: a package that the tree lacks,
//   no `forbid` and no `only`, an empty `from`, `forbid` or `only`, an
//   entry of `from` that is not in the exports, or whose file the script
//   cannot read; a `from` that lists entries but not each entry of the
//   package's `exports`, so that a new entry cannot slip past the row; and
//   an entry of `forbid` or `only` that does not name what is there (a
//   file, or a directory that ends in "/"), or that is not written as its
//   real path (through a link, or in another case of letters), since it
//   would match nothing.
//
// `check` takes the tables (BUILTINS, BUDGETS) as a parameter, so that a
// test gives tables that fit its fixture; the command uses the real ones.
//
// One parser decides what a file imports: Bun's
// (`Bun.Transpiler.scanImports`). It gives the specifiers that the file
// loads: the value imports, also an unused one, a side effect, a re-export,
// a dynamic import and a `require`. It drops `import type`, `export type`,
// and a list of names that are all `type`: those load nothing at run time,
// and the type checks see them. One exception: it also lists an import with
// no `type` in a `declare module` block, which loads nothing (that limit
// and the other one, reflection, are in docs/boundaries.md). Each
// rule is decided on that list, and on nothing else: no verdict depends on
// text that this script finds itself.
//
// A limit of that list: it holds no import's attributes (`with { type:
// "text" }`), so the script does not see the type of an import. An import
// of an `.html` file is a leaf to it whatever its type; but to Bun an HTML
// import with no `type: "text"` is a bundle, whose scripts the walk does
// not read. The tree imports its page as text.
//
// The line of a fault is a hint, not a verdict: the first line of the file
// where the specifier stands in quotes, else 1. A decoy in a comment, a
// string or a regular expression may move the hint; it never adds or
// removes a fault.
//
// Paths are real paths: a symlink is followed, and a file belongs to the
// package that holds its real path. So a link out of a package is a way
// out, and a link into `local` is in the budget's reach.
//
// A test is a `*.test.ts` file, or a file under a package's `tests/`.

import * as fs from "node:fs"
import { isBuiltin } from "node:module"
import * as path from "node:path"

// The built-in modules that each package may import, by its name: "any",
// or a list of modules. A test of the package has its own list. A module
// is matched whole, with its `node:` prefix (`fs` is `node:fs`): a subpath
// is a module of its own, so `node:assert/strict` allows neither
// `node:assert` nor the other way around. The core's tests run on Bun and
// on Node, so their list holds no `bun:` module.
export const BUILTINS: Builtins = {
  "@everchat/core": { src: ["node:crypto"], tests: ["node:assert/strict", "node:crypto", "node:path", "node:test"] },
  "@everchat/local": { src: "any", tests: "any" },
  "@everchat/openai": { src: [], tests: "any" },
  "@everchat/sqlite": { src: [], tests: "any" },
  "@everchat/server": { src: [], tests: "any" },
  "@everchat/codemode": { src: ["node:fs/promises", "node:module", "node:worker_threads"], tests: "any" }
}
type Rule = "any" | ReadonlyArray<string>
export type Builtins = Readonly<Record<string, { readonly src: Rule; readonly tests: Rule }>>

// The budgets. `from`: a package, and its entries (keys of its `exports`),
// or "files" for each of its files that is not a test. `forbid`: paths from
// the root; a file under one of them must not be reached. `only`: paths
// from the root, each a file or a directory that ends in "/"; each file
// that the starts reach must be under one of them, or in the row's own
// package. A row has `forbid`, `only`, or both, none of them empty, each
// entry a path from the root (no leading "./") that names a file, or a
// directory when it ends in "/", written as its real path; a `from` that
// lists entries names each of the package's. A row for a package that the
// tree does not have is a fault, and so is each other row that breaks
// these: a wrong name must not turn a budget off.
export type Budget = {
  readonly package: string
  readonly from: "files" | ReadonlyArray<string>
} & ({ readonly forbid: ReadonlyArray<string>; readonly only?: ReadonlyArray<string> } | { readonly forbid?: ReadonlyArray<string>; readonly only: ReadonlyArray<string> })

export const BUDGETS: ReadonlyArray<Budget> = [
  { package: "@everchat/core", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/", "packages/codemode/"] },
  { package: "@everchat/openai", from: [".", "./gateway"], only: ["packages/core/src/request.ts"] },
  { package: "@everchat/sqlite", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/codemode/"] },
  { package: "@everchat/codemode", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/"] },
  { package: "@everchat/server", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/", "packages/codemode/"] }
]

export interface Tables {
  readonly builtins: Builtins
  readonly budgets: ReadonlyArray<Budget>
}

const TABLES: Tables = { builtins: BUILTINS, budgets: BUDGETS }

interface Package {
  readonly name: string
  readonly dir: string // absolute
  readonly manifest: Record<string, any>
}

interface Import {
  readonly specifier: string
  readonly line: number // a hint: the first line with the specifier in quotes, else 1
}

const scanner = new Bun.Transpiler({ loader: "ts" })

// The value imports of a TypeScript file, as Bun's parser finds them, in its
// order, one for each import.
export const imports = (text: string): Array<Import> =>
  scanner.scanImports(text.replace(/^#!.*/, "")).map((one) => ({ specifier: one.path, line: lineOf(text, one.path) }))

// The first line of `text` where `specifier` stands in quotes, else 1.
const lineOf = (text: string, specifier: string): number => {
  const at = ['"', "'", "`"].map((quote) => text.indexOf(quote + specifier + quote)).filter((one) => one >= 0)
  return at.length === 0 ? 1 : text.slice(0, Math.min(...at)).split("\n").length
}

// Paths
// -----

// The real path: each symlink followed. A path that does not exist yet is
// its parent's real path, and its name.
const real = (file: string): string => {
  try {
    return fs.realpathSync(file)
  } catch {
    const parent = path.dirname(file)
    return parent === file ? file : path.join(real(parent), path.basename(file))
  }
}

// True when `file` is in `dir`, or is `dir`.
const inside = (dir: string, file: string) => {
  const relative = path.relative(dir, file)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

const isTest = (pkg: Package, file: string) =>
  file.endsWith(".test.ts") || (inside(pkg.dir, file) && path.relative(pkg.dir, file).split(path.sep)[0] === "tests")

// The files under `dir`, through symlinks too (each real directory once),
// not under `node_modules`: the path by which each is found (`name`), and
// its real path (`at`).
interface Found {
  readonly name: string
  readonly at: string
}
const files = (dir: string, seen = new Set<string>()): Array<Found> => {
  const at = real(dir)
  if (seen.has(at)) return []
  seen.add(at)
  // By name, so that the faults come in the same order on every file system.
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      return [] // a broken link: nothing can load it
    }
    if (stat.isDirectory()) return entry.name === "node_modules" ? [] : files(full, seen)
    return stat.isFile() ? [{ name: full, at: real(full) }] : []
  })
}

// A TypeScript source, by the name that it is found by: it ends in `.ts`,
// not `.d.ts`. A runner loads a file by that name (`bun test`, an entry).
const isSource = (found: Found) => found.name.endsWith(".ts") && !found.name.endsWith(".d.ts")

const nameOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

const isFile = (file: string) => fs.existsSync(file) && fs.statSync(file).isFile()

// An object of JSON that is not a list and not null.
const isMap = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

// The kinds of file that are not code, by extension, matched exactly: the
// script follows an import of one as a leaf, which imports nothing. Bun runs
// as code a name that it does not know (no extension, `.JS`, `.TS`), so a
// kind joins this list only by an edit of it, with its reason here:
// - `.html`: the inspector's page, imported as text
//   (packages/local/src/inspector.ts).
// - `.txt`: a text file (the fixtures of graph.test.ts).
// - `.md`: a Markdown file (a package's notes for its readers, at its root
//   or under its sources).
const NOT_CODE = new Set([".html", ".txt", ".md"])

// The plain kinds of file, which are not source, matched exactly on a path's
// end: `.d.ts` (which the type checks read), `.json` (a manifest, a type
// program), and the kinds of NOT_CODE. A file of a package that is not a
// checked member must be of one of them by its name and by its real path,
// the same: a runner loads a file by its name, and what it loads is the
// real file. Any other file is one that no rule checks, and Bun may run it
// (a `.js`, `.mts` or `.tsx` file, a file with no extension, a link of such
// a name to a `.ts` file that is no member, a link of any name to one).
const plain = (file: string): string | null => {
  if (file.endsWith(".d.ts")) return ".d.ts"
  const ext = path.extname(file)
  return ext === ".json" || NOT_CODE.has(ext) ? ext : null
}

const NO_FILE = "names no .ts file (write the file's path, with .ts)"
const NOT_STRING = "a target that is not a string, in the exports of "
const UNCHECKED = "a kind of file that the script cannot check"
const TEST = "manifest, a test's file, which only a test may import"

// The faults of the packages under `root`, as lines, by `tables`.
export const check = (given: string, tables: Tables = TABLES): Array<string> => {
  const root = real(given)
  const base = path.join(root, "packages")
  // In the order of their directories' names, so that the faults come in
  // the same order on every file system.
  const packages: Array<Package> = fs.readdirSync(base).sort()
    .filter((name) => isFile(path.join(base, name, "package.json")))
    .map((name) => {
      const dir = real(path.join(base, name))
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
      return { name: manifest.name, dir, manifest }
    })
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  // The package that holds a file's real path.
  const owner = (file: string) => packages.find((pkg) => inside(pkg.dir, file))
  // A package's files: those under its directory that are its own, or no
  // package's (a link to a file outside every package is checked as the
  // package's that links it). A link to another package's file is that
  // package's.
  // The files found under each package's directory, whoever owns them: the
  // rule at line 1 judges each of them. Ownership decides only whose member
  // a file is.
  const found = new Map(packages.map((pkg) => [pkg, files(pkg.dir)]))
  const own = new Map(packages.map((pkg) => [pkg, found.get(pkg)!.filter((one) => (owner(one.at) ?? pkg) === pkg)]))
  const members = new Map(packages.map((pkg) => [pkg, [...new Set(own.get(pkg)!.filter(isSource).map((one) => one.at))]]))
  // The files that the rules of each file check: every package's own. The
  // one set of the files that the script reads.
  const readable = new Set([...members.values()].flat())
  // What the script does with a file, decided on its real path: "read" a
  // file of `readable`, follow a kind that is not code as a "leaf", or null:
  // it cannot follow it (no file, a directory, a `.ts` file that is not in
  // the set, as a `.d.ts` or one under `node_modules`, any other name). The
  // one test of "can follow", for `read` and for every rule. As the
  // repository writes its imports with `.ts`, a fault on null tells the
  // writer to name the `.ts` file.
  const kind = (file: string): "read" | "leaf" | null => {
    const at = real(file)
    if (!isFile(at)) return null
    if (at.endsWith(".ts")) return readable.has(at) ? "read" : null
    return NOT_CODE.has(path.extname(at)) ? "leaf" : null
  }
  // A file whose imports the script knows.
  const followable = (file: string) => kind(file) !== null
  const faults: Array<string> = []
  const fault = (file: string, line: number, rule: string, specifier: string) =>
    faults.push(path.relative(root, file) + ":" + line + ": " + rule + ": " + specifier)
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/")
  // What is wrong with an entry of `forbid` or `only`, or null: it is a
  // path from the root with no `.`, `..` or empty part, it names a file, or
  // a directory when it ends in "/", and it is written as its own real path
  // from the real root, byte for byte. `forbidden` and `outside` compare an
  // entry as text with real paths, so an entry through a link (in any of
  // its parts), or in another case of letters than the file system holds,
  // would match nothing.
  const named = (entry: string): string | null => {
    const bare = entry.endsWith("/") ? entry.slice(0, -1) : entry
    if (bare === "" || path.posix.isAbsolute(entry) || bare.split("/").some((part) => part === "" || part === "." || part === "..")) return "is not a path from the root"
    let stat: fs.Stats
    try {
      stat = fs.statSync(path.join(root, bare))
    } catch {
      return "names nothing"
    }
    if (entry.endsWith("/") && !stat.isDirectory()) return "ends in / and is no directory"
    if (!entry.endsWith("/")) {
      if (stat.isDirectory()) return "names a directory with no / at its end"
      if (!stat.isFile()) return "names nothing"
    }
    return relative(fs.realpathSync.native(path.join(root, bare))) === bare ? null : "is not the real path of what it names"
  }
  const parsed = new Map<string, Array<Import>>()
  const read = (file: string) => {
    let got = parsed.get(file)
    if (got === undefined) parsed.set(file, got = kind(file) === "read" ? imports(fs.readFileSync(real(file), "utf8")) : [])
    return got
  }

  // The real path of the file that a specifier names, if it is one of the
  // workspace's (a relative one, or a workspace package's entry). Null for
  // a relative path that is no file, an entry that is not in the exports,
  // and a specifier of no workspace package. An entry's file may not exist:
  // `followable` decides.
  const resolve = (from: string, specifier: string): string | null => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const target = path.resolve(path.dirname(from), specifier)
      const file = [target, target + ".ts", path.join(target, "index.ts")].find(isFile)
      return file === undefined ? null : real(file)
    }
    const pkg = byName.get(nameOf(specifier))
    if (pkg === undefined) return null
    const entry = "." + specifier.slice(pkg.name.length)
    const exports = pkg.manifest.exports
    // A string target only: an object of conditions, a list or null is an
    // `entry` fault of the manifest, and no file of this script's.
    const target = typeof exports === "string" ? (entry === "." ? exports : undefined) : isMap(exports) && Object.hasOwn(exports, entry) ? exports[entry] : undefined
    return typeof target === "string" ? real(path.resolve(pkg.dir, target)) : null
  }

  for (const pkg of packages) {
    // Each target of `exports` is a string: Bun takes the first key of an
    // object of conditions that is one of its own (`bun` is one), and this
    // script does not follow that order, so it would check one file while
    // Bun loads another. Once for each key, imported or not.
    const exports = pkg.manifest.exports
    const manifestFile = path.join(pkg.dir, "package.json")
    if (exports !== undefined && typeof exports !== "string") {
      if (!isMap(exports)) fault(manifestFile, 1, "entry, " + NOT_STRING + pkg.name, ".")
      else for (const [key, target] of Object.entries(exports)) if (typeof target !== "string") fault(manifestFile, 1, "entry, " + NOT_STRING + pkg.name, key)
    }
    // The files that no rule can read, at the real file's line 1, each
    // once for each package that it is found under: every file found under
    // the package's directory, by a link into another package too. One
    // whose real path the rules read (a member of any package) is checked
    // by its owner's rules, whatever name led to it. Else first a source
    // name (a link `zz.test.ts` to a file `zztest`, which a runner loads by
    // its name); then each other file, whose name and real path are of the
    // same plain kind (`plain`), or it is a fault.
    const told = new Set<string>()
    for (const one of found.get(pkg)!) {
      if (told.has(one.at) || !isSource(one) || kind(one.at) === "read") continue
      told.add(one.at)
      fault(one.at, 1, "way out, " + NO_FILE, relative(one.name))
    }
    for (const one of found.get(pkg)!) {
      if (told.has(one.at) || kind(one.at) === "read") continue
      const named = plain(one.name)
      if (named !== null && named === plain(one.at)) continue
      told.add(one.at)
      fault(one.at, 1, "way out, " + UNCHECKED, relative(one.name))
    }
    const manifest = pkg.manifest
    for (const file of members.get(pkg)!) {
      const test = isTest(pkg, file)
      const declared = new Set([
        pkg.name,
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...(test ? Object.keys(manifest.devDependencies ?? {}) : [])
      ])
      const rule = tables.builtins[pkg.name]?.[test ? "tests" : "src"] ?? []
      for (const one of read(file)) {
        const { specifier } = one
        if (specifier.startsWith("node:") || specifier.startsWith("bun:") || isBuiltin(specifier)) {
          const module = specifier.includes(":") ? specifier : "node:" + specifier
          if (rule !== "any" && !rule.includes(module)) {
            fault(file, one.line, "built-in, not on " + pkg.name + "'s list", specifier)
          }
        } else if (specifier.startsWith(".") || specifier.startsWith("/")) {
          // The real target: a link that leaves the package is a way out,
          // and so is a path that the script cannot follow.
          const found = resolve(file, specifier)
          const target = found ?? real(path.resolve(path.dirname(file), specifier))
          if (!inside(pkg.dir, target)) {
            fault(file, one.line, "way out, outside " + path.relative(root, pkg.dir), specifier)
          } else if (found === null || !followable(found)) {
            fault(file, one.line, "way out, " + NO_FILE, specifier)
          }
          // A file that is not a test imports a test's file.
          if (!test && found !== null && isTest(owner(found) ?? pkg, found)) {
            fault(file, one.line, TEST, specifier)
          }
        } else {
          if (!declared.has(nameOf(specifier))) {
            fault(file, one.line, "manifest, not declared by " + pkg.name, specifier)
          }
          const target = byName.get(nameOf(specifier))
          const entry = target === undefined ? null : resolve(file, specifier)
          if (target !== undefined && entry === null) {
            fault(file, one.line, "entry, not in the exports of " + target.name, specifier)
          } else if (target !== undefined && entry !== null && !inside(target.dir, entry)) {
            // An entry whose real file is not in its package.
            fault(file, one.line, "way out, outside " + path.relative(root, target.dir), specifier)
          } else if (target !== undefined && entry !== null && !followable(entry)) {
            // An entry whose file is missing, or is code that the script
            // does not read.
            fault(file, one.line, "way out, " + NO_FILE, specifier)
          }
          // A file that is not a test imports a test's file, by an entry.
          if (!test && target !== undefined && entry !== null && isTest(target, entry)) {
            fault(file, one.line, TEST, specifier)
          }
        }
      }
    }
  }

  // The budgets: a walk of the value imports from each start. A fault is an
  // import that reaches a forbidden file, or a file outside `only` and the
  // row's package, or that the walk cannot follow (a relative path or an
  // entry of a workspace package that names no file that the script can
  // follow), once for each budget. The walk does not go on past it.
  for (const budget of tables.budgets) {
    const pkg = byName.get(budget.package)
    if (pkg === undefined) {
      faults.push("tools/graph.ts:1: budget, no package: " + budget.package)
      continue
    }
    if (budget.forbid === undefined && budget.only === undefined) {
      faults.push("tools/graph.ts:1: budget, neither forbid nor only: " + budget.package)
      continue
    }
    // The faults of the row itself, each of which would turn it off, or let
    // an entry past it: a row with one is not walked.
    const row: Array<string> = []
    const wrong = (why: string, what: string) => row.push("tools/graph.ts:1: budget, " + why + ": " + what)
    const startOf = (entry: string) => resolve(pkg.dir, pkg.name + entry.slice(1))
    if (budget.from !== "files") {
      const keys = typeof pkg.manifest.exports === "string" ? ["."] : Object.keys(pkg.manifest.exports ?? {})
      if (budget.from.length === 0) wrong("no entry in from", budget.package)
      for (const entry of budget.from) {
        const start = keys.includes(entry) ? startOf(entry) : null
        if (!keys.includes(entry)) wrong("not an entry of " + budget.package, entry)
        else if (start === null || kind(start) !== "read") wrong("cannot read the start of " + budget.package, entry)
      }
      // Each entry, so that the next one cannot slip past the row.
      for (const entry of keys) if (!budget.from.includes(entry)) wrong("not named by the row of " + budget.package, entry)
    }
    if (budget.forbid !== undefined && budget.forbid.length === 0) wrong("an empty forbid", budget.package)
    if (budget.only !== undefined && budget.only.length === 0) wrong("an empty only", budget.package)
    // Each entry of forbid and of only names what is there, as the table
    // writes a path from the root: a file, or a directory that ends in "/".
    // A wrong entry matches nothing, and so turns its part of the row off.
    for (const [list, entries] of [["forbid", budget.forbid], ["only", budget.only]] as const) {
      for (const entry of entries ?? []) {
        const why = named(entry)
        if (why !== null) wrong("an entry of " + list + " that " + why, budget.package + " " + entry)
      }
    }
    if (row.length > 0) {
      faults.push(...row)
      continue
    }
    const starts = budget.from === "files"
      ? members.get(pkg)!.filter((file) => !isTest(pkg, file))
      : budget.from.map((entry) => startOf(entry)!)
    const forbidden = (file: string) => (budget.forbid ?? []).some((prefix) => relative(file).startsWith(prefix))
    // Outside `only`, and outside the row's own package.
    const outside = (file: string) =>
      budget.only !== undefined && !inside(pkg.dir, file) && !budget.only.some((one) => (one.endsWith("/") ? relative(file).startsWith(one) : relative(file) === one))
    const lost = "budget, " + budget.package + " cannot follow it: it " + NO_FILE
    const seen = new Set<string>()
    const reported = new Set<string>()
    const queue = [...starts]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const one of read(file)) {
        const { specifier } = one
        const target = resolve(file, specifier)
        // Of the workspace: a relative path, or a workspace package's.
        const ours = specifier.startsWith(".") || specifier.startsWith("/") || byName.has(nameOf(specifier))
        if (target === null && !ours) continue
        const why = target === null
          ? lost
          : forbidden(target)
          ? "budget, " + budget.package + " must not reach " + (budget.forbid ?? []).join(", ")
          : outside(target)
          ? "budget, " + budget.package + " may reach only " + (budget.only ?? []).join(", ") + ", and reaches " + relative(target)
          : !followable(target)
          ? lost
          : null
        if (why !== null) {
          const key = file + "\0" + one.specifier
          if (!reported.has(key)) {
            reported.add(key)
            fault(file, one.line, why, one.specifier)
          }
        } else {
          // why is null only where target is not.
          queue.push(target!)
        }
      }
    }
  }
  return faults
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] ?? path.join(import.meta.dir, ".."))
  const faults = check(root)
  for (const line of faults) console.error(line)
  if (faults.length > 0) process.exit(1)
  console.log("graph: the packages keep their boundaries")
}
