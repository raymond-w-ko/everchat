// Words
// =====
// A check that no durable file of this repository holds a word of a list
// that lives outside it (the owner's list of words). The repository is
// public, so the list stays on the machine and is never read, printed or
// copied here: this script names no word of it, and nor does its output.
// `just check` runs it as its last step: `bun tools/words.ts`. The commit
// hook (tools/hooks/commit-msg, turned on by `just hooks`) runs it on a
// commit message: `bun tools/words.ts --message <file>`.
//
// - The list: the file that `EVERCHAT_NEVER` names when it is set and not
//   empty, else `$HOME/.config/ai/never.txt`. One word or phrase on each
//   line; a line is trimmed; an empty line and a line that starts with `#`
//   are skipped. A line with fewer than 4 letters and digits (see the match)
//   is a fault of the list: the script names the line's number, not its
//   text, and fails.
// - The list's reader (L), the same for the tree check and `--message`. The
//   list is not a file of the tree: it is read through links (an absolute or
//   a relative target, a link to a link), as the bytes of the file that its
//   path leads to. Its kind is decided before any read, so no read waits.
// - No list (W): when there is nothing at the list's path (the path itself,
//   not followed, is "no such file"), the script reads the path's parts as
//   the file system does: from the root (or the work directory, for a
//   relative path) down, each part read before the next, and a `..` applied
//   to what the part before it leads to, never taken out of the path's text
//   first. When the first part that is not there stands under a directory,
//   or under a link that leads to a directory, one line says so and the
//   script ends with 0. A person outside has no list. The owner turns the
//   check off by removing the file, never by emptying it. When a part is a
//   link that leads to nothing (a directory of a disk that is not mounted),
//   or to itself, or cannot be read, it is a fault of the list (`words: the
//   list is behind a link that leads to nothing`), as below.
// - A fault of the list: each other state is one line that names the state,
//   then `words: the list has a fault; nothing checked`, and the end code 1:
//   a link that leads to nothing, a link that leads to itself, a directory
//   (at the path or behind a link), a thing that is not a regular file (a
//   pipe, a device), a file that cannot be read, a path behind a link that
//   leads to nothing or to itself, and a list with no word after its
//   comments and empty lines. The line holds no word, no text of the list,
//   no target of a link and no part of the path.
// - The message's reader (M): the file of `--message` is read through links
//   too, by the same kinds. A message file that is not there, a link that
//   leads to nothing, a path behind one, a directory, a thing that is not a
//   regular file and a file that cannot be read each give one line and the
//   code 1.
// - What it reads of the tree (T, P, Q): each file of the checkout that
//   holds this script that git tracks, and each that git does not track and
//   does not ignore (`git ls-files -co --exclude-standard`): its path and
//   its bytes. The child `git` runs in that checkout with the caller's
//   environment less every variable whose name starts with `GIT_`, so that
//   no `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE` turns it to another
//   tree; when it fails, or is not found, the run fails. A name stays bytes:
//   each file is opened by the bytes that git gave, so a name that is not
//   valid UTF-8 opens the file that git named; for the compare and for the
//   output, it is decoded as UTF-8, with the replacement character. A file
//   that is not text is read too, as bytes (decoded as UTF-8, so a word in
//   it survives the decoding). No file is skipped by its place or its kind;
//   a file of the list that is not there (deleted and not committed: "no
//   such file" at its bytes) is skipped. A link of the tree is read as git
//   holds it, the text of its target's path, and is not followed. A file of
//   the tree that cannot be read ends the run with code 1 and one line that
//   names it: `words: a file of the tree cannot be read (<code>): <path>`.
// - The match (N, U): both sides are compared on their letters and digits
//   only, in one form: Unicode's form NFKD, then lower case, then each final
//   sigma `ς` as `σ`, then each character that is not a letter or a digit
//   (Unicode's classes `\p{L}` and `\p{N}`) taken out; the same for a
//   list's line and for the text (a file's bytes as text, a path, a
//   message). NFKD parts a letter from its marks, and a mark is no letter,
//   so the marks go: a word matches with or without its accents, composed
//   or decomposed, on either side, in full-width letters, and with a capital
//   sigma at its end.
//   A word matches wherever its characters then occur: across a line break,
//   doubled spaces, a tab, a hyphen, an underscore and the mark of a wrapped
//   comment, inside a longer word too. The line of a match is the line
//   where its first letter or digit stands.
// - The escapes (V): a text (not a list's line) is also compared in a
//   second form, where each escape of a fixed set is taken out after the
//   lower case and before the letters and digits: `\n`, `\r`, `\t` (a
//   backslash and the letter), `%20`, `%09`, `%0a`, `%0d` and `&nbsp;`, in
//   any letter case. No other escape is taken out (`&#32;`, `&#160;`,
//   `\u0020` and the like are not in the set). A match in either form
//   counts, once: the second form adds matches and takes none away (a word
//   with `n` after a backslash, as in a path of Windows, is still found by
//   the first). An escape holds no real line break, so the line of a match
//   is found as in the first form.
// - The cost: the compare also finds a word across the end of one word and
//   the start of the next, and the second form across an escape inside
//   other text, so it reports more matches inside other text; the owner
//   accepts this for a guard.
// - The message: one line for each pair of a line and a line of the list,
//   `<path>:<line>: a word of the list (line <n>)`, where `<n>` is the
//   number of the list's line; a match in a path says `path` for the line.
//   The output goes into logs and beads, so it never holds a word or the
//   text of the matched line: a printed path has each match written over
//   with `*`, from the match's first character to its last, with the
//   characters between them that the compare took out. When the places
//   cannot be mapped back (the path is not its own NFKD form, or the lower
//   case changes its length, or it matches in the second form only), or
//   when the line would still hold a word by the compare in either form,
//   the whole path is written over. A printed path holds no control
//   character: each one of Unicode's classes `Cc`, `Zl` and `Zp` is written
//   as `?`, so each match is one line of the output. Then a last line with the
//   count, and the end code 1. With no match, `words: <n> files, no word of
//   the list`, and 0.
// - `--message <file>`: checks that one file by the same rules (its path is
//   not checked) and reads no other but the list. It runs no `git`.

import { Effect, Predicate, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// A word of the list: its letters and digits in lower case, and its line in
// the list.
export interface Word {
  readonly text: string
  readonly line: number
}

// A match: the line of the file (or "path"), and the line of the list.
export interface Match {
  readonly line: number | "path"
  readonly entry: number
}

// What a run prints, and its end code. `out` goes to the standard output,
// `err` to the standard error.
export interface Report {
  readonly out: ReadonlyArray<string>
  readonly err: ReadonlyArray<string>
  readonly code: number
}

// A fault of the list: its lines, each of which names a state or a line's
// number, and no text of the list.
export class ListFault extends Schema.TaggedError<ListFault>()("ListFault", {
  lines: Schema.Array(Schema.String)
}) {}

// A file that the script must read and cannot, or a call that it cannot
// make. The message names no word.
export class ReadFault extends Schema.TaggedError<ReadFault>()("ReadFault", {
  message: Schema.String
}) {}

// A file of the tree that cannot be read, by the code of the error; the run
// names the file (X1).
export class EntryFault extends Schema.TaggedError<EntryFault>()("EntryFault", {
  code: Schema.String
}) {}

export const SHORTEST = 4

export const NO_LIST = "words: no list on this machine; nothing checked"

// The path of the list, by rule 1.
export const listPath = (env: Record<string, string | undefined>): string => {
  const named = env.EVERCHAT_NEVER
  if (named !== undefined && named !== "") return named
  return path.join(env.HOME !== undefined && env.HOME !== "" ? env.HOME : os.homedir(), ".config", "ai", "never.txt")
}

// A form of the compare: its letters and digits, and for each line of the
// text where it starts in `flat`.
export interface Form {
  readonly flat: string
  readonly starts: ReadonlyArray<number>
}

// The compare's first steps (U1): Unicode's form NFKD, lower case, and each
// final sigma as a sigma.
export const lower = (text: string): string => text.normalize("NFKD").toLowerCase().replaceAll("ς", "σ")

// The escapes that the second form takes out (V2), on a text in lower case.
const ESCAPES = /\\[nrt]|%(?:20|09|0a|0d)|&nbsp;/g
const ESCAPE = /\\[nrt]|%(?:20|09|0a|0d)|&nbsp;/

// The last step (N1): the letters and digits of a text in lower case, by its
// lines. NFKD changes no line break, so the lines are the text's own.
const letters = (lowered: string): Form => {
  const lines = lowered.replace(/[^\p{L}\p{N}\n]+/gu, "").split("\n")
  const starts: Array<number> = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length
  }
  return { flat: lines.join(""), starts }
}

// The compare's form of a list's line, or of a text in its first form (U1).
export const flatten = (text: string): Form => letters(lower(text))

// The forms of a text (V1): the first, and the second when the text holds an
// escape of the set; a text with none has one form.
export const forms = (text: string): Array<Form> => {
  const lowered = lower(text)
  const first = letters(lowered)
  return ESCAPE.test(lowered) ? [first, letters(lowered.replace(ESCAPES, ""))] : [first]
}

// The line (from 1) of the character at `at` of `flat`: the last line that
// starts at or before it. An empty line starts where the next one does, so
// the last such line is the one that holds the character.
const lineOf = (starts: ReadonlyArray<number>, at: number): number => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= at) low = middle
    else high = middle - 1
  }
  return low + 1
}

// The words of a list's text, or its faults: the lines that are too short,
// else a list with no word.
export const parse = Effect.fnUntraced(function*(text: string): Effect.fn.Return<ReadonlyArray<Word>, ListFault> {
  const words: Array<Word> = []
  const short: Array<number> = []
  text.split("\n").forEach((raw, k) => {
    const one = raw.trim()
    if (one === "" || one.startsWith("#")) return
    const flat = flatten(one).flat
    if ([...flat].length < SHORTEST) short.push(k + 1)
    else words.push({ text: flat, line: k + 1 })
  })
  if (short.length > 0) {
    return yield* new ListFault({
      lines: short.map((line) => `words: line ${line} of the list has fewer than ${SHORTEST} letters and digits`)
    })
  }
  if (words.length === 0) return yield* new ListFault({ lines: ["words: the list has no word"] })
  return words
})

// The matches of the words in a text, one for each line of the text where a
// match starts and line of the list, in the text's order: over both forms
// together (V4), so a match that both find is one.
export const scan = (text: string, words: ReadonlyArray<Word>): Array<Match> => {
  const seen = new Set<string>()
  const found: Array<Match> = []
  for (const { flat, starts } of forms(text)) {
    for (const word of words) {
      for (let at = flat.indexOf(word.text); at !== -1; at = flat.indexOf(word.text, at + 1)) {
        const line = lineOf(starts, at)
        const key = `${line}:${word.line}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({ line, entry: word.line })
      }
    }
  }
  return found.sort((a, b) => (a.line as number) - (b.line as number) || a.entry - b.entry)
}

// Whether a text holds a word by the compare, in either form (V5).
const holds = (text: string, words: ReadonlyArray<Word>) =>
  forms(text).some(({ flat }) => words.some((word) => flat.includes(word.text)))

const stars = (name: string) => "*".repeat([...name].length)

// A path as it is printed (X2): each control character, line break of
// Unicode and paragraph break as `?`, so that each match is one line.
const marks = (name: string) => name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "?")

// A path to print (N5, U5, V5, X2): each match of the first form written over
// with `*`, from its first character to its last. If the path is not its own
// NFKD form, or the lower case changes its length, the places cannot be
// mapped back; nor can those of a match of the second form only: then the
// whole path is written over.
export const mask = (name: string, words: ReadonlyArray<Word>): string => marks(masked(name, words))

const masked = (name: string, words: ReadonlyArray<Word>): string => {
  const lowered = lower(name)
  if (name.normalize("NFKD") !== name || lowered.length !== name.length) return holds(name, words) ? stars(name) : name
  // For each unit of the compare's form, its place in the name.
  const places: Array<readonly [number, number]> = []
  let flat = ""
  for (const one of lowered.matchAll(/[\p{L}\p{N}]/gu)) {
    flat += one[0]
    for (let k = 0; k < one[0].length; k++) places.push([one.index, one.index + one[0].length])
  }
  const chars = name.split("")
  for (const word of words) {
    for (let at = flat.indexOf(word.text); at !== -1; at = flat.indexOf(word.text, at + 1)) {
      for (let k = places[at]![0]; k < places[at + word.text.length - 1]![1]; k++) chars[k] = "*"
    }
  }
  const shown = chars.join("")
  return holds(shown, words) ? stars(name) : shown
}

const decoder = new TextDecoder("utf-8")

const code = (error: unknown): string =>
  Predicate.hasProperty(error, "code") ? String(error.code) : "an error"

// A file read through links (L, M, W): its bytes, null when there is
// nothing at the path, or the state that it is in instead. The kind is
// decided before the file is opened, and again on what was opened.
type Followed = { readonly bytes: Uint8Array } | { readonly state: string } | null

// What the walk of a path reads with (W1, W2): the flavor of its paths and
// three calls of the file system. The real ones, but in the tests, which
// give the Windows flavor and a file system of their own on any machine.
export interface Walk {
  readonly path: typeof path.posix
  readonly lstatSync: (file: string) => unknown
  readonly statSync: (file: string) => { isDirectory(): boolean }
  readonly realpathSync: (file: string) => string
}

const REAL: Walk = {
  path,
  lstatSync: (file) => fs.lstatSync(file),
  statSync: (file) => fs.statSync(file),
  realpathSync: (file) => fs.realpathSync(file)
}

// Where the walk of a path starts, decided on the path's text alone (as
// `nothing` says), before any call of the file system: the root, and
// whether the path is absolute; null when the walk refuses the root.
const start = (file: string, flavor: typeof path.posix): { readonly root: string; readonly absolute: boolean } | null => {
  const absolute = flavor.isAbsolute(file)
  if (flavor.sep !== "\\" || !absolute) return { root: flavor.parse(file).root, absolute }
  const drive = /^[A-Za-z]:[\\/]/.exec(file)
  if (drive !== null) return { root: drive[0], absolute }
  const share = /^[\\/]{2}([^\\/]+)[\\/][^\\/]+(?:[\\/]|$)/.exec(file)
  if (share !== null && share[1] !== "?" && share[1] !== ".") return { root: share[0], absolute }
  return null
}

// When there is nothing at a path (W1, W2): its parts read as the file
// system reads them, from the root (or the work directory) down. The root
// is read one time: the parts are those of the path after its root, cut at
// each separator that the flavor takes (`\` and `/` on Windows, `/` alone
// on POSIX, where a `\` is a letter of a name). `at` is always a real path,
// with no link in it, so a `..` is applied to what the part before it leads
// to. Null when the first part that is not there stands under a directory
// (or a link that leads to one); else the state of the part that stopped
// the walk. No state names the part.
//
// The root (`start`, one call, on the text): on POSIX it is `/`. On Windows
// the walk reads an absolute path only under one of two plain kinds of
// root: a drive (`X:` and a separator: `C:\`, `c:/`), or a plain share (two
// separators, a server's name that is not `?` and not `.`, a separator, a
// share's name: `\\server\share\`). Each other root is refused with
// nothing read: the namespace and device forms (`\\?\UNC\server\share\`,
// `\\?\C:\`, `\\.\C:\`, `\\?\Volume{...}\`), a path from the root of the
// drive in use (`\work`), and each other form. (`node:path` gives some of
// them a root that is no directory, `\\?\UNC\`, under which the walk would
// answer "no list" before it read a link that leads to nothing.) The state
// is `is at a path whose root this check does not read`, a fault of the
// list as the others are, also when nothing at all is at the path: under
// such a root there is no "no list". The owner gives the list's path in a
// plain form. A relative path (also `C:work`) starts at the work directory.
const nothing = (file: string, walk: Walk): Followed => {
  const failed = (error: unknown): Followed => ({ state: `cannot be read (${code(error)})` })
  const flavor = walk.path
  const from = start(file, flavor)
  if (from === null) return { state: "is at a path whose root this check does not read" }
  // A relative path on Windows can have a root too (`C:work`): it is no
  // part, and the walk starts at the work directory.
  let at: string
  try {
    at = from.absolute ? from.root : walk.realpathSync(".")
  } catch (error) {
    return failed(error)
  }
  const rest = file.slice(from.root.length)
  for (const part of flavor.sep === "\\" ? rest.split(/[\\/]/) : rest.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      at = flavor.dirname(at)
      continue
    }
    const next = flavor.join(at, part)
    try {
      walk.lstatSync(next)
    } catch (error) {
      return code(error) === "ENOENT" ? null : failed(error)
    }
    try {
      if (!walk.statSync(next).isDirectory()) return { state: "cannot be read (ENOTDIR)" }
      at = walk.realpathSync(next)
    } catch (error) {
      return code(error) === "ENOENT"
        ? { state: "is behind a link that leads to nothing" }
        : code(error) === "ELOOP"
        ? { state: "is behind a link that leads to itself" }
        : failed(error)
    }
  }
  return null
}

const follow = (file: string, walk: Walk): Followed => {
  try {
    walk.lstatSync(file)
  } catch (error) {
    return code(error) === "ENOENT"
      ? nothing(file, walk)
      : code(error) === "ELOOP"
      ? { state: "is behind a link that leads to itself" }
      : { state: `cannot be read (${code(error)})` }
  }
  const kind = (stat: fs.Stats) =>
    stat.isDirectory() ? { state: "is a directory" } : stat.isFile() ? null : { state: "is not a regular file" }
  const failed = (error: unknown) =>
    code(error) === "ENOENT"
      ? { state: "is a link that leads to nothing" }
      : code(error) === "ELOOP"
      ? { state: "is a link that leads to itself" }
      : { state: `cannot be read (${code(error)})` }
  let fd: number
  try {
    const before = kind(fs.statSync(file))
    if (before !== null) return before
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY)
  } catch (error) {
    return failed(error)
  }
  try {
    const after = kind(fs.fstatSync(fd))
    return after ?? { bytes: fs.readFileSync(fd) }
  } catch (error) {
    return failed(error)
  } finally {
    fs.closeSync(fd)
  }
}

// The list's words, or none when there is no list.
const words = Effect.fnUntraced(function*(list: string, walk: Walk): Effect.fn.Return<ReadonlyArray<Word> | null, ListFault> {
  const got = follow(list, walk)
  if (got === null) return null
  if ("state" in got) return yield* new ListFault({ lines: [`words: the list ${got.state}`] })
  return yield* parse(decoder.decode(got.bytes))
})

// The message's text (M).
const messageText = Effect.fnUntraced(function*(file: string, walk: Walk): Effect.fn.Return<string, ReadFault> {
  const got = follow(file, walk)
  if (got === null) return yield* new ReadFault({ message: "words: the message is not there" })
  if ("state" in got) return yield* new ReadFault({ message: `words: the message ${got.state}` })
  return decoder.decode(got.bytes)
})

// A file of the tree (T), by the bytes of its name: its bytes as git would
// hold them (a link: the path it points to), as text; none if the file is
// not there.
const entry = (file: Buffer) =>
  Effect.try({
    try: (): string | null => {
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) return decoder.decode(fs.readlinkSync(file, { encoding: "buffer" }))
      if (stat.isDirectory()) return null
      return decoder.decode(fs.readFileSync(file))
    },
    catch: (error) => error
  }).pipe(
    Effect.catch((error) => code(error) === "ENOENT" ? Effect.succeed(null) : Effect.fail(new EntryFault({ code: code(error) })))
  )

// The caller's environment less every variable whose name starts with
// `GIT_` (Q1).
export const gitEnvironment = (env: Record<string, string | undefined>): Record<string, string> => {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (!name.startsWith("GIT_") && value !== undefined) kept[name] = value
  return kept
}

// The names of the files of the checkout at `root` (rule 3), as git's bytes.
const files = (root: string, env: Record<string, string | undefined>) =>
  Effect.try({
    try: () =>
      Bun.spawnSync(["git", "ls-files", "-z", "-co", "--exclude-standard"], {
        cwd: root,
        env: gitEnvironment(env),
        stdout: "pipe",
        stderr: "pipe"
      }),
    catch: () => new ReadFault({ message: "words: git cannot be run" })
  }).pipe(
    Effect.flatMap((done) => {
      if (done.exitCode !== 0) {
        return Effect.fail(new ReadFault({ message: `words: git ls-files failed with code ${done.exitCode}` }))
      }
      const out = Buffer.from(done.stdout)
      const names = new Map<string, Buffer>()
      for (let at = 0; at < out.length;) {
        let end = out.indexOf(0, at)
        if (end === -1) end = out.length
        const name = out.subarray(at, end)
        if (name.length > 0) names.set(name.toString("latin1"), name)
        at = end + 1
      }
      return Effect.succeed([...names.values()])
    })
  )

// A line of the output: when it would still hold a word by the compare, its
// path is written over whole.
const faultLine = (shown: string, match: Match, words: ReadonlyArray<Word>) => {
  const rest = `:${match.line}: a word of the list (line ${match.entry})`
  return holds(shown + rest, words) ? stars(shown) + rest : shown + rest
}

// The line of a file of the tree that cannot be read (X1), by the same
// guard.
const entryLine = (shown: string, fault: EntryFault, words: ReadonlyArray<Word>) => {
  const head = `words: a file of the tree cannot be read (${fault.code}): `
  return holds(head + shown, words) ? head + stars(shown) : head + shown
}

const found = (lines: ReadonlyArray<string>, count: number, things: string): Report => ({
  out: [],
  err: [...lines, `words: ${count} ${count === 1 ? "match" : "matches"} of the list in ${things}`],
  code: 1
})

// One run, by its arguments: `[]` checks the checkout at `root`,
// `["--message", file]` checks the file. `list` is the list's path; `env`
// is the environment that the child `git` gets, less its `GIT_` variables.
// `walk` is what the walk of a path that is not there reads with (`nothing`).
export const run = Effect.fn("run")(function*(
  args: ReadonlyArray<string>,
  root: string,
  list: string,
  env: Record<string, string | undefined> = process.env,
  walk: Walk = REAL
): Effect.fn.Return<Report> {
  const message = args[0] === "--message" && args.length === 2 ? args[1] ?? null : null
  if (args.length > 0 && message === null) {
    return { out: [], err: ["usage: bun tools/words.ts [--message <file>]"], code: 1 }
  }
  return yield* Effect.gen(function*() {
    const all = yield* words(list, walk)
    if (all === null) return { out: [NO_LIST], err: [], code: 0 }
    if (message !== null) {
      const text = yield* messageText(message, walk)
      const matches = scan(text, all)
      if (matches.length === 0) return { out: ["words: the message holds no word of the list"], err: [], code: 0 }
      const shown = mask(message, all)
      return found(matches.map((match) => faultLine(shown, match, all)), matches.length, "the message")
    }
    const names = yield* files(root, env)
    const base = Buffer.from(root.endsWith("/") ? root : root + "/")
    const lines: Array<string> = []
    for (const bytes of names) {
      const name = decoder.decode(bytes)
      const shown = mask(name, all)
      for (const match of scan(name, all)) lines.push(faultLine(shown, { line: "path", entry: match.entry }, all))
      const text = yield* entry(Buffer.concat([base, bytes])).pipe(
        Effect.catchTag("EntryFault", (fault) => Effect.fail(new ReadFault({ message: entryLine(shown, fault, all) })))
      )
      if (text === null) continue
      for (const match of scan(text, all)) lines.push(faultLine(shown, match, all))
    }
    if (lines.length === 0) return { out: [`words: ${names.length} files, no word of the list`], err: [], code: 0 }
    return found(lines, lines.length, `${names.length} files`)
  }).pipe(
    Effect.catchTag("ListFault", (fault) =>
      Effect.succeed<Report>({
        out: [],
        err: [...fault.lines, "words: the list has a fault; nothing checked"],
        code: 1
      })),
    Effect.catchTag("ReadFault", (fault) => Effect.succeed<Report>({ out: [], err: [fault.message], code: 1 }))
  )
})

if (import.meta.main) {
  const report = await Effect.runPromise(run(process.argv.slice(2), path.join(import.meta.dir, ".."), listPath(process.env)))
  for (const line of report.err) console.error(line)
  for (const line of report.out) console.log(line)
  process.exit(report.code)
}
