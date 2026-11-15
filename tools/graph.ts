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
// - entry (K3): an import of a workspace package names a path of its
//   `exports`.
// - built-in (K3): a `node:` or `bun:` module is on its package's list
//   (BUILTINS). The list names modules only. Which names of `node:crypto`
//   the core may use (`createHash`) is the core's type check's rule
//   (packages/core/tsconfig.json, packages/core/tsconfig.core.d.ts), not
//   this script's.
// - budget (K3): the files that a budget starts from do not reach, through
//   value imports and across packages, a file that it forbids (BUDGETS).
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
// or a list of modules. A test of the package has its own list.
export const BUILTINS: Record<string, { readonly src: Rule; readonly tests: Rule }> = {
  "@everchat/core": { src: ["node:crypto"], tests: "any" },
  "@everchat/local": { src: "any", tests: "any" }
}
type Rule = "any" | ReadonlyArray<string>

// The budgets. `from`: a package, and its entries (keys of its `exports`),
// or "files" for each of its files that is not a test. `forbid`: paths from
// the root; a file under one of them must not be reached.
export const BUDGETS: ReadonlyArray<{ readonly package: string; readonly from: "files" | ReadonlyArray<string>; readonly forbid: ReadonlyArray<string> }> = [
  { package: "@everchat/core", from: "files", forbid: ["packages/local/"] }
]

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

// The faults of the packages under `root`, as lines.
export const check = (given: string): Array<string> => {
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
  const members = (pkg: Package) => [...new Set(sources(pkg.dir))].filter((file) => (owner(file) ?? pkg) === pkg)
  const faults: Array<string> = []
  const fault = (file: string, line: number, rule: string, specifier: string) =>
    faults.push(path.relative(root, file) + ":" + line + ": " + rule + ": " + specifier)
  const parsed = new Map<string, Array<Import>>()
  const read = (file: string) => {
    let got = parsed.get(file)
    if (got === undefined) parsed.set(file, got = file.endsWith(".ts") && isFile(file) ? imports(fs.readFileSync(file, "utf8")) : [])
    return got
  }

  // The real path of the file that a specifier names, if it is one of the
  // workspace's (a relative one, or a workspace package's entry).
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
    for (const file of members(pkg)) {
      const test = isTest(pkg, file)
      const declared = new Set([
        pkg.name,
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...(test ? Object.keys(manifest.devDependencies ?? {}) : [])
      ])
      const rule = BUILTINS[pkg.name]?.[test ? "tests" : "src"] ?? []
      for (const one of read(file)) {
        const { specifier } = one
        if (specifier.startsWith("node:") || specifier.startsWith("bun:") || isBuiltin(specifier)) {
          const module = specifier.includes(":") ? specifier : "node:" + specifier
          if (rule !== "any" && !rule.includes(module)) {
            fault(file, one.line, "built-in, not on " + pkg.name + "'s list", specifier)
          }
        } else if (specifier.startsWith(".") || specifier.startsWith("/")) {
          // The real target: a link that leaves the package is a way out.
          const target = resolve(file, specifier) ?? real(path.resolve(path.dirname(file), specifier))
          if (!inside(pkg.dir, target)) {
            fault(file, one.line, "way out, outside " + path.relative(root, pkg.dir), specifier)
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
          }
        }
      }
    }
  }

  // The budgets: a walk of the value imports from each start. A fault is an
  // import that reaches a forbidden file, once for each budget.
  for (const budget of BUDGETS) {
    const pkg = byName.get(budget.package)
    if (pkg === undefined) {
      faults.push("tools/graph.ts:1: budget, no package: " + budget.package)
      continue
    }
    const starts = budget.from === "files"
      ? members(pkg).filter((file) => !isTest(pkg, file))
      : budget.from.map((entry) => resolve(pkg.dir, pkg.name + entry.slice(1))).filter((file): file is string => file !== null)
    const forbidden = (file: string) => budget.forbid.some((prefix) => path.relative(root, file).split(path.sep).join("/").startsWith(prefix))
    const seen = new Set<string>()
    const reported = new Set<string>()
    const queue = [...starts]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const one of read(file)) {
        const target = resolve(file, one.specifier)
        if (target === null) continue
        if (forbidden(target)) {
          const key = file + "\0" + one.specifier
          if (!reported.has(key)) {
            reported.add(key)
            fault(file, one.line, "budget, " + budget.package + " must not reach " + budget.forbid.join(", "), one.specifier)
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
