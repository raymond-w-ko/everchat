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
//   may also use `devDependencies`.
// - way out (K3): a relative specifier stays in its package's directory.
//   It, or an entry of a workspace package, also names a file that this
//   script can follow (`kind`: a `.ts` file of a package's own, or a kind on
//   the list of those that are not code, NOT_CODE): one that it cannot is a
//   way out of its sight, since Bun may load what the script never reads
//   (`./z.js` runs `z.ts`, which may be a link out; a file with no extension
//   runs as code). The script reads the imports of the packages' own source
//   files only, the files that every rule checks: a value import of any
//   other `.ts` file, a `.d.ts` or one under `node_modules`, is one that it
//   cannot follow.
// - entry (K3): an import of a workspace package names a path of its
//   `exports`.
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
//   it.
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
// and the other one, reflection, are in AGENTS.md, "Be modular"). Each
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
  "@everchat/codemode": { src: [], tests: "any" }
}
type Rule = "any" | ReadonlyArray<string>
export type Builtins = Readonly<Record<string, { readonly src: Rule; readonly tests: Rule }>>

// The budgets. `from`: a package, and its entries (keys of its `exports`),
// or "files" for each of its files that is not a test. `forbid`: paths from
// the root; a file under one of them must not be reached. `only`: paths
// from the root, each a file or a directory that ends in "/"; each file
// that the starts reach must be under one of them, or in the row's own
// package. A row has `forbid`, `only`, or both. A row for a package that
// the tree does not have is a fault: a wrong name must not turn a budget
// off.
export type Budget = {
  readonly package: string
  readonly from: "files" | ReadonlyArray<string>
} & ({ readonly forbid: ReadonlyArray<string>; readonly only?: ReadonlyArray<string> } | { readonly forbid?: ReadonlyArray<string>; readonly only: ReadonlyArray<string> })

export const BUDGETS: ReadonlyArray<Budget> = [
  { package: "@everchat/core", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/", "packages/codemode/"] },
  { package: "@everchat/openai", from: ["."], only: ["packages/core/src/request.ts"] },
  { package: "@everchat/sqlite", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/codemode/"] },
  { package: "@everchat/codemode", from: "files", forbid: ["packages/local/", "packages/openai/", "packages/sqlite/"] }
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

// The real paths of the TypeScript files under `dir`, through symlinks too
// (each real directory once). Not `node_modules`, not `.d.ts`.
const sources = (dir: string, seen = new Set<string>()): Array<string> => {
  const at = real(dir)
  if (seen.has(at)) return []
  seen.add(at)
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      return [] // a broken link: nothing can load it
    }
    if (stat.isDirectory()) return entry.name === "node_modules" ? [] : sources(full, seen)
    return stat.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [real(full)] : []
  })
}

const nameOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

const isFile = (file: string) => fs.existsSync(file) && fs.statSync(file).isFile()

// The kinds of file that are not code, by extension, matched exactly: the
// script follows an import of one as a leaf, which imports nothing. Bun runs
// as code a name that it does not know (no extension, `.JS`, `.TS`), so a
// kind joins this list only by an edit of it, with its reason here:
// - `.html`: the inspector's page, imported as text
//   (packages/local/src/inspector.ts).
// - `.txt`: a text file (the fixtures of graph.test.ts).
const NOT_CODE = new Set([".html", ".txt"])

const NO_FILE = "names no .ts file (write the file's path, with .ts)"

// The faults of the packages under `root`, as lines, by `tables`.
export const check = (given: string, tables: Tables = TABLES): Array<string> => {
  const root = real(given)
  const base = path.join(root, "packages")
  const packages: Array<Package> = fs.readdirSync(base)
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
  const members = new Map(packages.map((pkg) => [pkg, [...new Set(sources(pkg.dir))].filter((file) => (owner(file) ?? pkg) === pkg)]))
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
    const target = typeof pkg.manifest.exports === "string" && entry === "." ? pkg.manifest.exports : pkg.manifest.exports?.[entry]
    const file = typeof target === "string" ? target : target?.import ?? target?.default
    return typeof file === "string" ? real(path.resolve(pkg.dir, file)) : null
  }

  for (const pkg of packages) {
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
    const starts = budget.from === "files"
      ? members.get(pkg)!.filter((file) => !isTest(pkg, file))
      : budget.from.map((entry) => resolve(pkg.dir, pkg.name + entry.slice(1))).filter((file): file is string => file !== null)
    const relative = (file: string) => path.relative(root, file).split(path.sep).join("/")
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
          queue.push(target)
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
