// Tests of the check of the list of words (words.ts), with a list of made-up
// words in a temporary directory and a temporary git checkout of their own.
// No test reads the owner's list: each run is given its list's path.
//
// The sweep, CASES, holds one row for each form of each rule: a reviewer
// adds a row. The rows of the list's states (LISTS) run in both modes, the
// tree check and `--message`. For each row that fails, the output holds the
// place and holds no word of the list, in any letter case and with no mark
// inside it.

import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { type Report, listPath, mask, NO_LIST, run, type Walk } from "./words.ts"

const made: Array<string> = []
afterAll(() => {
  for (const dir of made) {
    // A row makes a file of mode 000; give it back its mode to remove it.
    Bun.spawnSync(["chmod", "-R", "u+rwx", dir])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-words-"))
  made.push(dir)
  return dir
}

// The made-up words of the tests' lists.
const WORDS = ["zorblat", "glim vortan", "quexxu"]
const LIST = WORDS.join("\n") + "\n"

// A list in a temporary directory, by its text; its path.
const list = (text: string) => {
  const file = path.join(temp(), "list.txt")
  fs.writeFileSync(file, text)
  return file
}

// The environment with no variable of git's own: the tests' git runs where
// it is told.
const noGit = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")))

const git = (root: string, ...args: Array<string>) => {
  const done = Bun.spawnSync(["git", ...args], { cwd: root, env: noGit(), stdout: "pipe", stderr: "pipe" })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
}

type Files = Record<string, string | Uint8Array>

// A git checkout: `tracked` files are added to the index, `untracked` are
// written only; `.gitignore` is one of them when given. `setup` runs last.
const checkout = (tracked: Files, untracked: Files = {}, gone: Array<string> = [], setup?: (root: string) => void) => {
  const root = temp()
  git(root, "init", "-q")
  const write = (files: Files) => {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      fs.writeFileSync(path.join(root, name), body)
    }
  }
  write(tracked)
  if (Object.keys(tracked).length > 0) git(root, "add", "-f", "--", ...Object.keys(tracked))
  write(untracked)
  for (const name of gone) fs.rmSync(path.join(root, name))
  setup?.(root)
  return root
}

const text = (report: Report) => [...report.out, ...report.err].join("\n")

// The compare's forms, written out here: a change of the script's compare
// does not change what this checks. The first: NFKD, lower case, each final
// sigma as a sigma, then the letters and digits only. The second: the same,
// with each escape of the set taken out before the letters and digits.
const lowered = (one: string) => one.normalize("NFKD").toLowerCase().replaceAll("ς", "σ")
const letters = (one: string) => lowered(one).replace(/[^\p{L}\p{N}]+/gu, "")
const unescaped = (one: string) =>
  lowered(one).replace(/\\[nrt]|%(?:20|09|0a|0d)|&nbsp;/g, "").replace(/[^\p{L}\p{N}]+/gu, "")

// The made-up words of the rows of U and Y: a word with an accent, a word
// with a sigma at its end, a word with `n` at its start, and a word that the
// end of a path and the line's own text make together.
const ACCENT = "frümpelin"
const SIGMA = "θριμοσ"
const ENDS_N = "nebwick"
const JOINED = "snerk1aword"
const ALL_WORDS = [...WORDS, "zub", ACCENT, SIGMA, ENDS_N, JOINED]

// No word of `words` in the output, in any letter case, and with no mark
// inside it, in either form of the compare.
const clean = (report: Report, words: ReadonlyArray<string> = ALL_WORDS) => {
  const lower = text(report).toLowerCase()
  for (const word of words) {
    expect(lower).not.toContain(word.toLowerCase())
    expect(letters(text(report))).not.toContain(letters(word))
    expect(unescaped(text(report))).not.toContain(letters(word))
  }
}

const bytes = (...parts: Array<string | Array<number>>) =>
  new Uint8Array(parts.flatMap((part) => typeof part === "string" ? [...new TextEncoder().encode(part)] : part))

const mkfifo = (file: string) => {
  const done = Bun.spawnSync(["mkfifo", file])
  if (done.exitCode !== 0) throw new Error("mkfifo failed")
}

const ROOT_USER = process.getuid?.() === 0

interface Case {
  readonly name: string
  readonly tracked?: Files
  readonly untracked?: Files
  readonly gone?: Array<string>
  readonly setup?: (root: string) => void
  // The list: its text, or a function that makes it in a directory of its
  // own and gives its path. "" is a path with nothing there.
  readonly list?: string | ((dir: string) => string)
  readonly args?: (root: string) => Array<string>
  // The environment of the run; the test process's own is not changed.
  readonly env?: (root: string) => Record<string, string | undefined>
  readonly skip?: boolean
  readonly code: number
  // Lines that the output holds, each whole.
  readonly lines: Array<string>
  // The last line, a pattern.
  readonly last: RegExp
}

const inMessage = (root: string) => ["--message", path.join(root, "msg.txt")]

// The states of the list (L): each in the tree check, with a word in the
// tree, and in `--message`, with a word in the message. `lines`: the
// fault's lines, or none when the list's words are found.
interface ListState {
  readonly name: string
  readonly make: (dir: string) => string
  readonly lines?: Array<string>
  readonly skip?: boolean
}

const realList = (dir: string, text = LIST) => {
  fs.writeFileSync(path.join(dir, "real.txt"), text)
  return path.join(dir, "real.txt")
}

const LISTS: Array<ListState> = [
  {
    name: "a list behind a link with an absolute target",
    make: (dir) => {
      fs.symlinkSync(realList(dir), path.join(dir, "list"))
      return path.join(dir, "list")
    }
  },
  {
    name: "a list behind a link with a relative target",
    make: (dir) => {
      fs.mkdirSync(path.join(dir, "sub"))
      realList(dir)
      fs.symlinkSync("../real.txt", path.join(dir, "sub", "list"))
      return path.join(dir, "sub", "list")
    }
  },
  {
    name: "a list behind a link to a link",
    make: (dir) => {
      realList(dir)
      fs.symlinkSync("real.txt", path.join(dir, "middle"))
      fs.symlinkSync("middle", path.join(dir, "list"))
      return path.join(dir, "list")
    }
  },
  {
    name: "a list that is a link that leads to nothing",
    make: (dir) => {
      fs.symlinkSync("nothing.txt", path.join(dir, "list"))
      return path.join(dir, "list")
    },
    lines: ["words: the list is a link that leads to nothing"]
  },
  {
    name: "a list that is a link that leads to itself",
    make: (dir) => {
      fs.symlinkSync("list", path.join(dir, "list"))
      return path.join(dir, "list")
    },
    lines: ["words: the list is a link that leads to itself"]
  },
  {
    name: "a list that is a directory",
    make: (dir) => {
      fs.mkdirSync(path.join(dir, "list"))
      return path.join(dir, "list")
    },
    lines: ["words: the list is a directory"]
  },
  {
    name: "a list that is a link to a directory",
    make: (dir) => {
      fs.mkdirSync(path.join(dir, "d"))
      fs.symlinkSync("d", path.join(dir, "list"))
      return path.join(dir, "list")
    },
    lines: ["words: the list is a directory"]
  },
  {
    name: "a list that is a pipe, which no read waits on",
    make: (dir) => {
      mkfifo(path.join(dir, "list"))
      return path.join(dir, "list")
    },
    lines: ["words: the list is not a regular file"]
  },
  {
    name: "a list that cannot be read (mode 000)",
    make: (dir) => {
      const file = realList(dir)
      fs.chmodSync(file, 0)
      return file
    },
    lines: ["words: the list cannot be read (EACCES)"],
    skip: ROOT_USER
  },
  {
    name: "a list of no bytes",
    make: (dir) => realList(dir, ""),
    lines: ["words: the list has no word"]
  },
  {
    name: "a list of white space only",
    make: (dir) => realList(dir, "  \n\t\n\n   \n"),
    lines: ["words: the list has no word"]
  },
  {
    name: "a list of comments only",
    make: (dir) => realList(dir, "# zorblat\n\n#quexxu\n"),
    lines: ["words: the list has no word"]
  },
  {
    name: "a list's line of 4 characters with 3 letters",
    make: (dir) => realList(dir, "zorblat\nab-c\n"),
    lines: ["words: line 2 of the list has fewer than 4 letters and digits"]
  },
  {
    name: "a list's line of marks only",
    make: (dir) => realList(dir, "zorblat\n--- *** ---\n"),
    lines: ["words: line 2 of the list has fewer than 4 letters and digits"]
  },
  {
    // U3 on NFKD: four letters, two of which NFKC would make one (Hangul's
    // jamo). NFKD keeps the four, so the line is a word, and the list's
    // other word is found.
    name: "a list's line of 4 letters that NFKC would make 3: a word",
    make: (dir) => realList(dir, "zorblat\n\u1100\u1161ab\n")
  },
  {
    // U3: four characters, one of them a mark, which NFKD parts from its
    // letter and the compare takes out.
    name: "a list's line of 4 characters with 3 letters and a mark",
    make: (dir) => realList(dir, "zorblat\nabc\u0301\n"),
    lines: ["words: line 2 of the list has fewer than 4 letters and digits"]
  },
  {
    name: "a list's path with a link to nothing before .., as an absolute path",
    make: (dir) => {
      fs.symlinkSync("not-mounted", path.join(dir, "dead"))
      return `${dir}/dead/../never.txt`
    },
    lines: ["words: the list is behind a link that leads to nothing"]
  },
  {
    name: "a list's path with a link to nothing before .., as a relative path",
    make: (dir) => {
      fs.symlinkSync("not-mounted", path.join(dir, "dead"))
      return `${path.relative(process.cwd(), dir)}/dead/../never.txt`
    },
    lines: ["words: the list is behind a link that leads to nothing"]
  },
  {
    // The file system reads `lnk/..` as the parent of the link's target:
    // the list is there, and is read.
    name: "a list's path with a link to a directory before ..: the list where the file system finds it",
    make: (dir) => {
      fs.mkdirSync(path.join(dir, "real", "sub"), { recursive: true })
      fs.writeFileSync(path.join(dir, "real", "never.txt"), LIST)
      fs.symlinkSync(path.join("real", "sub"), path.join(dir, "lnk"))
      return `${dir}/lnk/../never.txt`
    }
  },
  {
    name: "a list whose path is under a directory that is a link to nothing",
    make: (dir) => {
      fs.symlinkSync("disk-not-mounted", path.join(dir, "ai"))
      return path.join(dir, "ai", "never.txt")
    },
    lines: ["words: the list is behind a link that leads to nothing"]
  },
  {
    name: "a list whose path is under a directory that is a link to nothing, two parts up",
    make: (dir) => {
      fs.symlinkSync(path.join(dir, "disk-not-mounted"), path.join(dir, "config"))
      return path.join(dir, "config", "ai", "never.txt")
    },
    lines: ["words: the list is behind a link that leads to nothing"]
  },
  {
    name: "a list whose path is under a directory that is a link to itself",
    make: (dir) => {
      fs.symlinkSync("ai", path.join(dir, "ai"))
      return path.join(dir, "ai", "never.txt")
    },
    lines: ["words: the list is behind a link that leads to itself"]
  }
]

const FAULT = /^words: the list has a fault; nothing checked$/

const listRows = LISTS.flatMap((one): Array<Case> => {
  const fault = one.lines !== undefined
  const shared = { list: one.make, skip: one.skip === true, code: 1 }
  return [
    {
      ...shared,
      name: `${one.name}, in the tree check`,
      tracked: { "a.md": "x zorblat\n" },
      lines: one.lines ?? ["a.md:1: a word of the list (line 1)"],
      last: fault ? FAULT : /^words: 1 match of the list in 1 files$/
    },
    {
      ...shared,
      name: `${one.name}, in --message`,
      untracked: { "msg.txt": "Subject\n\nthe zorblat\n" },
      args: inMessage,
      lines: one.lines ?? ["msg.txt:3: a word of the list (line 1)"],
      last: fault ? FAULT : /^words: 1 match of the list in the message$/
    }
  ]
})

// The forms of a phrase and of a name (N2): the text of a file, and the
// line where the match starts. The list is LIST: "glim vortan" is its line
// 2, "zorblat" its line 1.
const FORMS: Array<{ readonly name: string; readonly text: string; readonly line: number; readonly entry: number }> = [
  { name: "a line break between the words", text: "x\nglim\nvortan\n", line: 2, entry: 2 },
  { name: "a line break of CR and LF", text: "x\r\nglim\r\nvortan\r\n", line: 2, entry: 2 },
  { name: "two spaces", text: "x\nglim  vortan\n", line: 2, entry: 2 },
  { name: "a tab", text: "x\nglim\tvortan\n", line: 2, entry: 2 },
  { name: "a hyphen", text: "x\nglim-vortan\n", line: 2, entry: 2 },
  { name: "an underscore", text: "x\nGLIM_VORTAN\n", line: 2, entry: 2 },
  { name: "no space", text: "x\nGlimVortan\n", line: 2, entry: 2 },
  { name: "a wrapped comment", text: "x\n// it was glim\n// vortan here\n", line: 2, entry: 2 },
  { name: "lines of marks before the first letter", text: "x\n--\n  //  glim\n\n--\nvortan\n", line: 3, entry: 2 },
  { name: "the entry in one word, the text in two", text: "x\nthe zor blat\n", line: 2, entry: 1 },
  { name: "the entry in one word, the text with a hyphen", text: "x\nzor-blat\n", line: 2, entry: 1 }
]

const formRows = FORMS.map((one): Case => ({
  name: `the compare finds a word with ${one.name}, at the line where it starts`,
  tracked: { "a.md": one.text },
  code: 1,
  lines: [`a.md:${one.line}: a word of the list (line ${one.entry})`],
  last: /^words: 1 match of the list in 1 files$/
}))

// The rows of U, in both modes: a word in the list in one form, and in the
// text in another. `entry` is the list's line of the word.
const UNICODE: Array<{ readonly name: string; readonly list: string; readonly text: string; readonly entry: number }> = [
  { name: "the list composed and the text decomposed", list: `${ACCENT}\n`, text: "fru\u0308mpelin", entry: 1 },
  { name: "the list decomposed and the text composed", list: "fru\u0308mpelin\n", text: ACCENT, entry: 1 },
  { name: "the text in full-width letters", list: LIST, text: "\uff5a\uff4f\uff52\uff42\uff4c\uff41\uff54", entry: 1 },
  { name: "the list with a capital sigma at its end, the text with a small sigma", list: "zorblat\nΘΡΙΜΟΣ\n", text: SIGMA, entry: 2 },
  { name: "the list with a small sigma at its end, the text with a capital one", list: `${SIGMA}\n`, text: "ΘΡΙΜΟΣ", entry: 1 },
  { name: "the list with a small sigma at its end, the text with a final one", list: `${SIGMA}\n`, text: "θριμος", entry: 1 },
  { name: "the list plain, the text with a decomposed accent that has a composed letter", list: LIST, text: "zor\u0301blat", entry: 1 },
  { name: "the list plain, the text with a decomposed accent that has no composed letter", list: LIST, text: "zorb\u0301lat", entry: 1 },
  { name: "the list plain, the text with the composed accent", list: LIST, text: "zoŕblat", entry: 1 },
  { name: "the list with an accent, the text plain", list: `${ACCENT}\n`, text: "frumpelin", entry: 1 }
]

const unicodeRows = UNICODE.flatMap((one): Array<Case> => [
  {
    name: `U: ${one.name}, in the tree check`,
    tracked: { "a.md": `x\nthe ${one.text} here\n` },
    list: one.list,
    code: 1,
    lines: [`a.md:2: a word of the list (line ${one.entry})`],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: `U: ${one.name}, in --message`,
    untracked: { "msg.txt": `Subject\n\nthe ${one.text}\n` },
    list: one.list,
    args: inMessage,
    code: 1,
    lines: [`msg.txt:3: a word of the list (line ${one.entry})`],
    last: /^words: 1 match of the list in the message$/
  }
])

// The escapes of V2 between the two words of the phrase (LIST's line 2),
// each in its own row, in the letter cases that a text writes them in.
const ESCAPES = ["\\n", "\\r", "\\t", "\\N", "%20", "%09", "%0a", "%0d", "%0A", "%0D", "&nbsp;", "&NBSP;"]

const escapeRows = ESCAPES.map((one): Case => ({
  name: `V: the phrase with the escape ${JSON.stringify(one)} between its words, at the line where it starts`,
  tracked: { "a.json": `{\n  "a": 1,\n  "b": "the glim${one}vortan here"\n}\n` },
  code: 1,
  lines: ["a.json:3: a word of the list (line 2)"],
  last: /^words: 1 match of the list in 1 files$/
}))

// A state of the list in both modes, the tree check and `--message`, with
// a word in each: the list's fault (`line`), or no list.
const bothModes = (name: string, make: (dir: string) => string, line?: string): Array<Case> => {
  const last = line === undefined ? /^words: no list on this machine; nothing checked$/ : FAULT
  const shared = { list: make, code: line === undefined ? 0 : 1, lines: line === undefined ? [] : [line], last }
  return [
    { ...shared, name: `${name}, in the tree check`, tracked: { "a.md": "x zorblat\n" } },
    { ...shared, name: `${name}, in --message`, untracked: { "msg.txt": "Subject\n\nthe zorblat\n" }, args: inMessage }
  ]
}

// W under the POSIX flavor: a `\\` is a letter of a name, so a name that
// holds one is one part of the path.
const backslashRows: Array<Case> = [
  ...bothModes("W: under POSIX, a directory whose name holds a \\, with nothing under it: no list", (dir) => {
    fs.mkdirSync(path.join(dir, "a\\b"))
    return `${dir}/a\\b/never.txt`
  }),
  ...bothModes("W: under POSIX, a link whose name holds a \\ and that leads to nothing, above the list", (dir) => {
    fs.symlinkSync("not-mounted", path.join(dir, "a\\b"))
    return `${dir}/a\\b/never.txt`
  }, "words: the list is behind a link that leads to nothing")
]

const followOnRows: Array<Case> = [
  ...unicodeRows,
  ...backslashRows,
  {
    name: "U: a path with a composed accent that holds a word: reported as path, and written over whole",
    tracked: { "docs/frümpelin.md": "clean\n" },
    code: 1,
    list: `${ACCENT}\n`,
    lines: [`${"*".repeat([..."docs/frümpelin.md"].length)}:path: a word of the list (line 1)`],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    // The file system reads `lnk/..` as the parent of the link's target,
    // where there is no list; the list that the path's text names is not
    // read.
    name: "W: a list's path with a link to a directory before .., with nothing where the file system looks: no list",
    tracked: { "a.md": "zorblat\n" },
    list: (dir) => {
      fs.mkdirSync(path.join(dir, "real", "sub"), { recursive: true })
      fs.writeFileSync(path.join(dir, "never.txt"), LIST)
      fs.symlinkSync(path.join("real", "sub"), path.join(dir, "lnk"))
      return `${dir}/lnk/../never.txt`
    },
    code: 0,
    lines: [],
    last: /^words: no list on this machine; nothing checked$/
  },
  {
    name: "W: a list's path with .. and no link, with nothing at its end: no list",
    untracked: { "msg.txt": "zorblat\n" },
    list: (dir) => {
      fs.mkdirSync(path.join(dir, "a"))
      return `${dir}/a/../never.txt`
    },
    args: inMessage,
    code: 0,
    lines: [],
    last: /^words: no list on this machine; nothing checked$/
  },
  {
    // Point 2 changed this row: a decomposed path is its own NFKD form, so
    // its places map back, and the match is written over with its mark.
    name: "U: a path in a decomposed form that holds a word: reported as path, the word written over",
    tracked: { "docs/fru\u0308mpelin.md": "clean\n" },
    list: `${ACCENT}\n`,
    code: 1,
    lines: [`docs/${"*".repeat(10)}.md:path: a word of the list (line 1)`],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    // NFKC gives this path the same length, so only U5's test of the form
    // says that its places cannot be mapped back.
    name: "U: a path in full-width letters that holds a word: reported as path, and written over whole",
    tracked: { "docs/\uff5a\uff4f\uff52\uff42\uff4c\uff41\uff54.md": "clean\n" },
    code: 1,
    lines: [`${"*".repeat("docs/zorblat.md".length)}:path: a word of the list (line 1)`],
    last: /^words: 1 match of the list in 1 files$/
  },
  ...escapeRows,
  {
    name: "V: the phrase with an escape between its words, in --message",
    untracked: { "msg.txt": "Subject\n\nsee glim%20Vortan\n" },
    args: inMessage,
    code: 1,
    lines: ["msg.txt:3: a word of the list (line 2)"],
    last: /^words: 1 match of the list in the message$/
  },
  {
    name: "V: a real line break next to an escape: the line is where the match starts",
    tracked: { "a.json": "x\ny \\n\nthe glim\\n\nvortan\\n\n" },
    code: 1,
    lines: ["a.json:3: a word of the list (line 2)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "V: a word that only the first form finds, after a backslash as in a path of Windows",
    tracked: { "a.txt": "x\nC:\\nebwick\\tools\n" },
    list: `${ENDS_N}\n`,
    code: 1,
    lines: ["a.txt:2: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "V: a match that both forms find is one line",
    tracked: { "a.txt": "x\nglim vortan \\n here\n" },
    code: 1,
    lines: ["a.txt:2: a word of the list (line 2)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "V: a path that holds the phrase with %20: reported as path, and written over whole",
    tracked: { "docs/glim%20vortan.md": "clean\n" },
    code: 1,
    lines: [`${"*".repeat("docs/glim%20vortan.md".length)}:path: a word of the list (line 2)`],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "V: an escape that is not in the set is not taken out",
    tracked: { "a.html": "<p>glim&#32;vortan and glim&#160;vortan and glim\\u0020vortan</p>\n" },
    code: 0,
    lines: [],
    last: /^words: 1 files, no word of the list$/
  },
  {
    name: "W: a list under a link to a directory that exists and is empty: no list, and 0",
    tracked: { "a.md": "zorblat\n" },
    list: (dir) => {
      fs.mkdirSync(path.join(dir, "empty"))
      fs.symlinkSync("empty", path.join(dir, "ai"))
      return path.join(dir, "ai", "never.txt")
    },
    code: 0,
    lines: [],
    last: /^words: no list on this machine; nothing checked$/
  },
  {
    name: "W: a list under a directory that exists, with a part between that does not: no list, and 0",
    untracked: { "msg.txt": "zorblat\n" },
    list: (dir) => path.join(dir, "config", "ai", "never.txt"),
    args: inMessage,
    code: 0,
    lines: [],
    last: /^words: no list on this machine; nothing checked$/
  },
  {
    name: "W: a message under a directory that is a link to nothing",
    setup: (root) => fs.symlinkSync("disk-not-mounted", path.join(root, "drafts")),
    args: (root) => ["--message", path.join(root, "drafts", "msg.txt")],
    code: 1,
    lines: [],
    last: /^words: the message is behind a link that leads to nothing$/
  },
  {
    name: "X: a file of the tree that cannot be read (mode 000): its line names it",
    tracked: { "a.md": "clean\n", "docs/locked.md": "zorblat\n" },
    setup: (root) => fs.chmodSync(path.join(root, "docs", "locked.md"), 0),
    skip: ROOT_USER,
    code: 1,
    lines: [],
    last: /^words: a file of the tree cannot be read \(EACCES\): docs\/locked\.md$/
  },
  {
    name: "X: a file of the tree that cannot be read, whose path holds a word: no word in the line",
    tracked: { "docs/the-zorblat.md": "clean\n" },
    setup: (root) => fs.chmodSync(path.join(root, "docs", "the-zorblat.md"), 0),
    skip: ROOT_USER,
    code: 1,
    lines: [],
    last: /^words: a file of the tree cannot be read \(EACCES\): docs\/the-\*{7}\.md$/
  },
  {
    name: "X: a file whose name holds a line break: one line for each match",
    setup: (root) => {
      fs.writeFileSync(path.join(root, "a\nb.md"), "zorblat\nx\nquexxu\n")
      fs.writeFileSync(path.join(root, "c\u2028d.md"), "zorblat\n")
      git(root, "add", "-A")
    },
    code: 1,
    lines: [
      "a?b.md:1: a word of the list (line 1)",
      "a?b.md:3: a word of the list (line 3)",
      "c?d.md:1: a word of the list (line 1)"
    ],
    last: /^words: 3 matches of the list in 2 files$/
  },
  {
    name: "X: the path of --message with a line break: one line for each match",
    untracked: { "m\nx.txt": "Subject\n\nthe zorblat\n" },
    args: (root) => ["--message", path.join(root, "m\nx.txt")],
    code: 1,
    lines: ["m?x.txt:3: a word of the list (line 1)"],
    last: /^words: 1 match of the list in the message$/
  },
  {
    name: "Y: the end of a path and the line's own text make a word: the path is written over whole",
    tracked: { "docs/snerk": "x zorblat\n" },
    list: `zorblat\n${JOINED}\n`,
    code: 1,
    lines: ["**********:1: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "Y: one word twice on one line: one line",
    tracked: { "a.md": "x\nzorblat and Zorblat\n" },
    code: 1,
    lines: ["a.md:2: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "Y: two lines of the list that match on one line of a file: two lines",
    tracked: { "a.md": "x\nzorblat and quexxu\n" },
    code: 1,
    lines: ["a.md:2: a word of the list (line 1)", "a.md:2: a word of the list (line 3)"],
    last: /^words: 2 matches of the list in 1 files$/
  },
  {
    name: "Y: one word on two lines: two lines",
    tracked: { "a.md": "zorblat\nx\nzorblat\n" },
    code: 1,
    lines: ["a.md:1: a word of the list (line 1)", "a.md:3: a word of the list (line 1)"],
    last: /^words: 2 matches of the list in 1 files$/
  }
]

const CASES: Array<Case> = [
  {
    name: "a clean tree passes",
    tracked: { "a.md": "nothing here\n", "src/b.ts": "export const b = 1\n" },
    code: 0,
    lines: [],
    last: /^words: 2 files, no word of the list$/
  },
  {
    name: "a word in a file's text, in three letter cases and inside a longer word",
    tracked: { "notes.md": "first\nzorblat\nZORBLAT and more\nthe ZorBlat\nunzorblatted\n" },
    code: 1,
    lines: [
      "notes.md:2: a word of the list (line 1)",
      "notes.md:3: a word of the list (line 1)",
      "notes.md:4: a word of the list (line 1)",
      "notes.md:5: a word of the list (line 1)"
    ],
    last: /^words: 4 matches of the list in 1 files$/
  },
  {
    name: "a phrase, by the list's line",
    tracked: { "a.md": "one\ntwo\nsay Glim Vortan here\n" },
    code: 1,
    lines: ["a.md:3: a word of the list (line 2)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  // A list's lines in mixed and in upper case (N1: the list's side is put in
  // lower case too), against the text in lower case and in another case.
  {
    name: "a list's lines in mixed and upper case, in the tree check",
    tracked: { "a.md": "x\nzorblat\nZORblat\nglim vortan\nGlim VORTAN\n" },
    list: "ZorBlat\nGLIM Vortan\n",
    code: 1,
    lines: [
      "a.md:2: a word of the list (line 1)",
      "a.md:3: a word of the list (line 1)",
      "a.md:4: a word of the list (line 2)",
      "a.md:5: a word of the list (line 2)"
    ],
    last: /^words: 4 matches of the list in 1 files$/
  },
  {
    name: "a list's lines in mixed and upper case, in --message",
    untracked: { "msg.txt": "Subject\n\nthe zorblat\nzorBLAT\nglim vortan\nglim VORTAN\n" },
    list: "ZorBlat\nGLIM Vortan\n",
    args: inMessage,
    code: 1,
    lines: [
      "msg.txt:3: a word of the list (line 1)",
      "msg.txt:4: a word of the list (line 1)",
      "msg.txt:5: a word of the list (line 2)",
      "msg.txt:6: a word of the list (line 2)"
    ],
    last: /^words: 4 matches of the list in the message$/
  },
  ...formRows,
  {
    name: "a word in a path, which is printed with the word written over",
    tracked: { "docs/Zorblat-plan.md": "clean\n", "ok.md": "clean\n" },
    code: 1,
    lines: ["docs/*******-plan.md:path: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 2 files$/
  },
  {
    name: "a phrase with a hyphen in a path, written over from its first character to its last",
    tracked: { "docs/the-Glim-Vortan.md": "clean\n" },
    code: 1,
    lines: ["docs/the-***********.md:path: a word of the list (line 2)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "a word in a file that is not text",
    tracked: { "img.bin": bytes([0, 1, 255, 254, 10, 0], "xQUEXXUx", [0, 200, 10]) },
    code: 1,
    lines: ["img.bin:2: a word of the list (line 3)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "a word at the end of a file of 32 MiB that is not text",
    tracked: { "big.bin": (() => {
      const big = new Uint8Array(32 * 1024 * 1024).fill(0xff)
      big.set(new TextEncoder().encode("zorblat"), big.length - 7)
      return big
    })() },
    code: 1,
    lines: ["big.bin:1: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "a word in a file that git does not track",
    tracked: { "a.md": "clean\n" },
    untracked: { "new/draft.txt": "a zorblat\n" },
    code: 1,
    lines: ["new/draft.txt:1: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 2 files$/
  },
  {
    name: "no match in a file that git ignores",
    tracked: { ".gitignore": "scratch/\n*.log\n" },
    untracked: { "scratch/a.txt": "zorblat\n", "run.log": "quexxu\n", "zorblat.log": "x\n" },
    code: 0,
    lines: [],
    last: /^words: 1 files, no word of the list$/
  },
  {
    name: "a file of the list that is deleted and not committed is skipped",
    tracked: { "a.md": "clean\n", "b.md": "zorblat\n" },
    gone: ["b.md"],
    code: 0,
    lines: [],
    last: /^words: 2 files, no word of the list$/
  },
  {
    name: "a file of the tree that is a link: the path it holds is read",
    tracked: { "a.md": "clean\n" },
    setup: (root) => {
      fs.symlinkSync("docs/the-zorblat.md", path.join(root, "link"))
      git(root, "add", "link")
    },
    code: 1,
    lines: ["link:1: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 2 files$/
  },
  {
    name: "a file of the tree that is a link out of the checkout is not read through",
    tracked: { "a.md": "clean\n" },
    setup: (root) => {
      const outside = path.join(temp(), "outside.md")
      fs.writeFileSync(outside, "zorblat\n")
      fs.symlinkSync(outside, path.join(root, "link"))
      git(root, "add", "link")
    },
    code: 0,
    lines: [],
    last: /^words: 2 files, no word of the list$/
  },
  {
    name: "a file whose name holds the byte ff opens by its bytes (P1)",
    setup: (root) => {
      fs.writeFileSync(Buffer.concat([Buffer.from(root + "/bad-"), Buffer.from([0xff]), Buffer.from(".bin")]), "a zorblat\n")
      git(root, "add", "-A")
    },
    code: 1,
    lines: ["bad-�.bin:1: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "GIT_DIR and GIT_WORK_TREE that name another, clean checkout: the script's checkout is read",
    tracked: { "w.md": "a zorblat\n" },
    env: () => {
      const other = checkout({ "clean.md": "clean\n" })
      return { ...process.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other }
    },
    code: 1,
    lines: ["w.md:1: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "GIT_INDEX_FILE that names another index: the script's checkout's index is read",
    tracked: { ".gitignore": "*.md\n", "w.md": "a zorblat\n" },
    env: () => {
      const other = checkout({ "clean.md": "clean\n" })
      return { ...process.env, GIT_INDEX_FILE: path.join(other, ".git", "index") }
    },
    code: 1,
    lines: ["w.md:1: a word of the list (line 1)"],
    last: /^words: 1 match of the list in 2 files$/
  },
  {
    name: "a list with a comment and an empty line: a word keeps its line's number",
    tracked: { "a.md": "# glim vortan\nzorblat\n" },
    list: "# glim vortan\n\n   zorblat   \n",
    code: 1,
    lines: ["a.md:2: a word of the list (line 3)"],
    last: /^words: 1 match of the list in 1 files$/
  },
  {
    name: "a word of 3 characters is a fault of the list, by its line's number",
    tracked: { "a.md": "zorblat zub\n" },
    list: "zorblat\n# zub\nzub\n",
    code: 1,
    lines: ["words: line 3 of the list has fewer than 4 letters and digits"],
    last: FAULT
  },
  ...listRows,
  {
    name: "nothing at the list's path: one line, and 0",
    tracked: { "a.md": "zorblat\n" },
    list: "",
    code: 0,
    lines: [],
    last: /^words: no list on this machine; nothing checked$/
  },
  {
    name: "nothing at the list's path, in --message: one line, and 0",
    untracked: { "msg.txt": "zorblat\n" },
    list: "",
    args: inMessage,
    code: 0,
    lines: [],
    last: /^words: no list on this machine; nothing checked$/
  },
  {
    name: "--message with a word: its lines, and not the tree",
    tracked: { "zorblat.md": "zorblat\n" },
    untracked: { "msg.txt": "Subject\n\nfixes the ZORBLAT\n" },
    args: inMessage,
    code: 1,
    lines: ["msg.txt:3: a word of the list (line 1)"],
    last: /^words: 1 match of the list in the message$/
  },
  {
    name: "--message with no word, and a word in the tree that it does not read",
    tracked: { "zorblat.md": "zorblat\n" },
    untracked: { "msg.txt": "Subject\n\nclean\n" },
    args: inMessage,
    code: 0,
    lines: [],
    last: /^words: the message holds no word of the list$/
  },
  {
    name: "--message behind a link, with a word",
    untracked: { "real.txt": "Subject\n\nglim\nvortan\n" },
    setup: (root) => fs.symlinkSync("real.txt", path.join(root, "msg.txt")),
    args: inMessage,
    code: 1,
    lines: ["msg.txt:3: a word of the list (line 2)"],
    last: /^words: 1 match of the list in the message$/
  },
  {
    name: "--message behind a link, with no word",
    untracked: { "real.txt": "Subject\n\nclean\n" },
    setup: (root) => fs.symlinkSync("real.txt", path.join(root, "msg.txt")),
    args: inMessage,
    code: 0,
    lines: [],
    last: /^words: the message holds no word of the list$/
  },
  {
    name: "--message that is not there",
    args: inMessage,
    code: 1,
    lines: [],
    last: /^words: the message is not there$/
  },
  {
    name: "--message that is a link that leads to nothing",
    setup: (root) => fs.symlinkSync("nothing.txt", path.join(root, "msg.txt")),
    args: inMessage,
    code: 1,
    lines: [],
    last: /^words: the message is a link that leads to nothing$/
  },
  {
    name: "--message that is a directory",
    setup: (root) => fs.mkdirSync(path.join(root, "msg.txt")),
    args: inMessage,
    code: 1,
    lines: [],
    last: /^words: the message is a directory$/
  },
  {
    name: "--message that is a pipe, which no read waits on",
    setup: (root) => mkfifo(path.join(root, "msg.txt")),
    args: inMessage,
    code: 1,
    lines: [],
    last: /^words: the message is not a regular file$/
  },
  ...followOnRows
]

for (const one of CASES) {
  test.skipIf(one.skip === true)(one.name, async () => {
    const root = checkout(one.tracked ?? {}, one.untracked, one.gone, one.setup)
    const listFile = one.list === ""
      ? path.join(temp(), "absent.txt")
      : typeof one.list === "function"
      ? one.list(temp())
      : list(one.list ?? LIST)
    const env = one.env?.(root)
    const before = JSON.stringify(process.env)
    const report = await Effect.runPromise(run(one.args?.(root) ?? [], root, listFile, env))
    expect(JSON.stringify(process.env)).toBe(before)
    const all = [...report.out, ...report.err]
    expect(report.code).toBe(one.code)
    for (const line of one.lines) {
      const printed = all.find((got) => got === line || got.endsWith("/" + line))
      expect(printed, `${line} in:\n${all.join("\n")}`).toBeDefined()
    }
    expect(all.length, all.join("\n")).toBe(one.lines.length + 1)
    expect(all.at(-1)!).toMatch(one.last)
    clean(report)
  })
}

// W under the Windows flavor of `node:path`, on any machine: the walk of a
// list's path that is not there reads with `path.win32` and a file system of
// the test's own. A drive and a share, each with a directory `work` and in
// it a link `dead` that leads to nothing; the work directory is `C:\\work`.
// Each other path is not there. The rows run through `run`, in both modes,
// with the report as the command gives it.
const windows = (dirs: ReadonlyArray<string>, dead: ReadonlyArray<string>): Walk => {
  const missing = () => Object.assign(new Error("not there"), { code: "ENOENT" })
  const directory = new Set(dirs)
  const nowhere = new Set(dead)
  return {
    path: path.win32,
    lstatSync: (file) => {
      if (directory.has(file) || nowhere.has(file)) return {}
      throw missing()
    },
    statSync: (file) => {
      if (directory.has(file)) return { isDirectory: () => true }
      throw missing()
    },
    realpathSync: (file) => {
      if (file === ".") return "C:\\work"
      if (directory.has(file)) return file
      throw missing()
    }
  }
}
const DRIVE_AND_SHARE = windows(
  ["C:\\", "C:\\work", "\\\\server\\share\\", "\\\\server\\share\\work"],
  ["C:\\work\\dead", "\\\\server\\share\\work\\dead"]
)
const BEHIND: Report = {
  out: [],
  err: ["words: the list is behind a link that leads to nothing", "words: the list has a fault; nothing checked"],
  code: 1
}
const NONE: Report = { out: [NO_LIST], err: [], code: 0 }

const WINDOWS: ReadonlyArray<{ readonly name: string; readonly list: string; readonly walk: Walk; readonly report: Report }> = [
  { name: "a drive path", list: "C:\\work\\dead\\never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "a UNC path", list: "\\\\server\\share\\work\\dead\\never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "a drive path with / for each separator", list: "C:/work/dead/never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "a UNC path with / for each separator", list: "//server/share/work/dead/never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "a drive path with both separators", list: "C:\\work/dead\\never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "a UNC path with both separators", list: "\\\\server/share\\work/dead/never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "a relative path", list: "dead\\never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "a relative path with a drive (C:dead)", list: "C:dead\\never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: ".. after the link, with \\", list: "C:\\work\\dead\\..\\never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: ".. after the link, with /", list: "C:/work/dead/../never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: ".. after the link, with both separators", list: "C:\\work/dead\\../never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: ".. after the link, in a UNC path", list: "\\\\server\\share\\work\\dead\\..\\never.txt", walk: DRIVE_AND_SHARE, report: BEHIND },
  { name: "nothing at the list's path, under a directory that is there", list: "C:\\work\\never.txt", walk: DRIVE_AND_SHARE, report: NONE },
  { name: "nothing at the list's path, under a share's directory that is there", list: "\\\\server\\share\\work\\never.txt", walk: DRIVE_AND_SHARE, report: NONE },
  { name: "a drive root alone, with nothing under it", list: "C:\\never.txt", walk: windows(["C:\\"], []), report: NONE }
]

for (const one of WINDOWS) {
  for (const mode of ["the tree check", "--message"] as const) {
    test(`W: under the Windows flavor, ${one.name}, in ${mode}: ${one.report.code === 0 ? "no list" : "the fault"}`, async () => {
      const args = mode === "--message" ? ["--message", "C:\\work\\msg.txt"] : []
      const report = await Effect.runPromise(run(args, temp(), one.list, process.env, one.walk))
      expect(report).toEqual(one.report)
    })
  }
}

// The walk's roots under the Windows flavor: it reads a drive and a plain
// share, and refuses each other root, decided on the path's text. A refused
// root gives its fault with no call of the file system after the first look
// at the list's path, both with a link to nothing above the list (where the
// walk, had it run, would have read the link) and with nothing at all. The
// file system records each call.
const recorded = (walk: Walk) => {
  const calls: Array<string> = []
  const traced: Walk = {
    path: walk.path,
    lstatSync: (file) => {
      calls.push(`lstat ${file}`)
      return walk.lstatSync(file)
    },
    statSync: (file) => {
      calls.push(`stat ${file}`)
      return walk.statSync(file)
    },
    realpathSync: (file) => {
      calls.push(`realpath ${file}`)
      return walk.realpathSync(file)
    }
  }
  return { calls, walk: traced }
}
const REFUSED: Report = {
  out: [],
  err: ["words: the list is at a path whose root this check does not read", "words: the list has a fault; nothing checked"],
  code: 1
}
// Each refused root, with the root's own directory, a directory `work` in
// it and a link `dead` there that leads to nothing.
const SHARE = "\\\\server\\share\\work\\dead\\never.txt"
const REFUSED_ROOTS: ReadonlyArray<{ readonly name: string; readonly root: string; readonly list: string }> = [
  {
    name: "an extended share (made from the plain one)",
    root: "\\\\?\\UNC\\server\\share\\",
    list: path.win32.toNamespacedPath(SHARE)
  },
  { name: "an extended drive (\\\\?\\C:\\)", root: "\\\\?\\C:\\", list: "\\\\?\\C:\\work\\dead\\never.txt" },
  { name: "a device drive (\\\\.\\C:\\)", root: "\\\\.\\C:\\", list: "\\\\.\\C:\\work\\dead\\never.txt" },
  {
    name: "a volume",
    root: "\\\\?\\Volume{1b3b1146-4076-11e1-84aa-806e6f6e6963}\\",
    list: "\\\\?\\Volume{1b3b1146-4076-11e1-84aa-806e6f6e6963}\\work\\dead\\never.txt"
  },
  { name: "an extended drive with / (//?/C:/)", root: "//?/C:/", list: "//?/C:/work/dead/never.txt" },
  { name: "a path from the root of the drive in use (\\work)", root: "\\", list: "\\work\\dead\\never.txt" }
]

test("the extended share of the rows is the plain share in the namespace form", () => {
  expect(path.win32.toNamespacedPath(SHARE)).toBe("\\\\?\\UNC\\server\\share\\work\\dead\\never.txt")
})

for (const one of REFUSED_ROOTS) {
  const link = windows([one.root, path.win32.join(one.root, "work")], [path.win32.join(one.root, "work", "dead")])
  for (const [above, walk] of [["a link to nothing above the list", link], ["nothing at all at the path", windows([], [])]] as const) {
    for (const mode of ["the tree check", "--message"] as const) {
      test(`W: under the Windows flavor, ${one.name}, ${above}, in ${mode}: refused, with nothing read`, async () => {
        const args = mode === "--message" ? ["--message", "C:\\work\\msg.txt"] : []
        const traced = recorded(walk)
        const report = await Effect.runPromise(run(args, temp(), one.list, process.env, traced.walk))
        expect(report).toEqual(REFUSED)
        expect(traced.calls).toEqual([`lstat ${one.list}`])
      })
    }
  }
}

// The two plain roots, read as before: with `\`, with `/` and both; and a
// relative path with a drive, which starts at the work directory.
const PLAIN: ReadonlyArray<{ readonly name: string; readonly list: string; readonly walk: Walk; readonly report: Report }> = [
  { name: "a drive in small letters (c:/)", list: "c:/work/dead/never.txt", walk: windows(["c:/", "c:\\work"], ["c:\\work\\dead"]), report: BEHIND },
  { name: "nothing under a drive's directory, with /", list: "C:/work/never.txt", walk: DRIVE_AND_SHARE, report: NONE },
  { name: "nothing under a drive's directory, with both", list: "C:\\work/never.txt", walk: DRIVE_AND_SHARE, report: NONE },
  { name: "nothing under a share's directory, with /", list: "//server/share/work/never.txt", walk: DRIVE_AND_SHARE, report: NONE },
  { name: "nothing under a share's directory, with both", list: "\\\\server/share\\work/never.txt", walk: DRIVE_AND_SHARE, report: NONE },
  {
    name: "a relative path with a drive (C:work), from the work directory",
    list: "C:work\\never.txt",
    walk: windows(["C:\\", "C:\\work"], ["C:\\work\\work"]),
    report: BEHIND
  }
]

for (const one of PLAIN) {
  for (const mode of ["the tree check", "--message"] as const) {
    test(`W: under the Windows flavor, ${one.name}, in ${mode}: ${one.report.code === 0 ? "no list" : "the fault"}`, async () => {
      const args = mode === "--message" ? ["--message", "C:\\work\\msg.txt"] : []
      const traced = recorded(one.walk)
      const report = await Effect.runPromise(run(args, temp(), one.list, process.env, traced.walk))
      expect(report).toEqual(one.report)
      expect(traced.calls[0]).toBe(`lstat ${one.list}`)
      expect(traced.calls.length).toBeGreaterThan(1)
    })
  }
}

// A list that is there is read, whatever its path's form: the walk runs only
// when nothing is at the path. On POSIX, the extended share's text is the
// name of a file in the work directory, so the list is there and its words
// are found.
for (const mode of ["the tree check", "--message"] as const) {
  test(`W: under the Windows flavor, a list that is there under an extended share is read, in ${mode}`, async () => {
    const dir = temp()
    const name = path.win32.toNamespacedPath("\\\\server\\share\\never.txt")
    fs.writeFileSync(path.join(dir, name), LIST)
    const real: Walk = {
      path: path.win32,
      lstatSync: (file) => fs.lstatSync(file),
      statSync: (file) => fs.statSync(file),
      realpathSync: (file) => fs.realpathSync(file)
    }
    const traced = recorded(real)
    const root = checkout({ "a.md": "a zorblat\n" })
    const args = mode === "--message" ? ["--message", message("a quexxu\n")] : []
    const back = process.cwd()
    process.chdir(dir)
    try {
      const report = await Effect.runPromise(run(args, root, name, process.env, traced.walk))
      expect(report.code).toBe(1)
      expect(report.err.at(-1)).toBe(`words: 1 match of the list in ${mode === "--message" ? "the message" : "1 files"}`)
      expect(traced.calls.filter((call) => call.endsWith(name))).toEqual([`lstat ${name}`])
      clean(report)
    } finally {
      process.chdir(back)
    }
  })
}

test("the list's path: EVERCHAT_NEVER when set and not empty, else the one under HOME", () => {
  expect(listPath({ EVERCHAT_NEVER: "/a/b.txt", HOME: "/h" })).toBe("/a/b.txt")
  expect(listPath({ EVERCHAT_NEVER: "", HOME: "/h" })).toBe("/h/.config/ai/never.txt")
  expect(listPath({ HOME: "/h" })).toBe("/h/.config/ai/never.txt")
})

test("a printed path has each match written over, in any letter case, with the marks inside it", () => {
  const words = [{ text: "zorblat", line: 1 }, { text: "quexxu", line: 2 }]
  expect(mask("a/ZorBlat/quexxuzorblat.md", words)).toBe("a/*******/*************.md")
  expect(mask("a/zor_Blat-x.md", words)).toBe("a/********-x.md")
  expect(mask("a/clean.md", words)).toBe("a/clean.md")
  // What is left would still hold a word: the whole path is written over.
  expect(mask("zorquexxublat", words)).toBe("*************")
})

// The command, as `just check` and the hook run it, with the test's list.
const ROOT = path.join(import.meta.dir, "..")
const bun = process.execPath

const spawn = (command: Array<string>, env: Record<string, string>) => {
  const done = Bun.spawnSync(command, {
    cwd: ROOT,
    env: { PATH: `${path.dirname(bun)}:${process.env.PATH ?? ""}`, ...env },
    stdout: "pipe",
    stderr: "pipe"
  })
  const report: Report = {
    out: done.stdout.toString().split("\n").filter((line) => line !== ""),
    err: done.stderr.toString().split("\n").filter((line) => line !== ""),
    code: done.exitCode ?? -1
  }
  return report
}

const message = (body: string) => {
  const file = path.join(temp(), "COMMIT_EDITMSG")
  fs.writeFileSync(file, body)
  return file
}

test("the command: no list, by EVERCHAT_NEVER", () => {
  const report = spawn([bun, "tools/words.ts"], { EVERCHAT_NEVER: path.join(temp(), "absent.txt") })
  expect(report).toEqual({ out: [NO_LIST], err: [], code: 0 })
})

test("the command: --message with the list under HOME when EVERCHAT_NEVER is empty", () => {
  const home = temp()
  fs.mkdirSync(path.join(home, ".config", "ai"), { recursive: true })
  fs.writeFileSync(path.join(home, ".config", "ai", "never.txt"), LIST)
  const report = spawn([bun, "tools/words.ts", "--message", message("a\nQuexxu\n")], { EVERCHAT_NEVER: "", HOME: home })
  expect(report.code).toBe(1)
  expect(report.err[0]).toEndWith("COMMIT_EDITMSG:2: a word of the list (line 3)")
  clean(report)
})

test("the command: an argument it does not know is a fault", () => {
  const report = spawn([bun, "tools/words.ts", "--nope"], { EVERCHAT_NEVER: list(LIST) })
  expect(report.code).toBe(1)
})

const HOOK = path.join(ROOT, "tools", "hooks", "commit-msg")

test("the hook is executable, and runs the check on its message with the code", () => {
  expect(fs.statSync(HOOK).mode & 0o111).toBe(0o111)
  const listFile = list(LIST)
  const bad = spawn([HOOK, message("Subject\n\nabout glim VORTAN\n")], { EVERCHAT_NEVER: listFile })
  expect(bad.code).toBe(1)
  expect(bad.err[0]).toEndWith("COMMIT_EDITMSG:3: a word of the list (line 2)")
  clean(bad)
  const good = spawn([HOOK, message("Subject\n\nclean\n")], { EVERCHAT_NEVER: listFile })
  expect(good).toEqual({ out: ["words: the message holds no word of the list"], err: [], code: 0 })
})

test("the hook refuses a message when the list is a fault: a list with no word", () => {
  const report = spawn([HOOK, message("Subject\n\nthe zorblat\n")], { EVERCHAT_NEVER: list("# only a comment\n") })
  expect(report.code).toBe(1)
  expect(report.err).toEqual(["words: the list has no word", "words: the list has a fault; nothing checked"])
})

test("the hook takes a message's path relative to where git runs it", () => {
  const dir = temp()
  fs.writeFileSync(path.join(dir, "msg"), "a zorblat\n")
  const done = Bun.spawnSync([HOOK, "msg"], {
    cwd: dir,
    env: { PATH: `${path.dirname(bun)}:${process.env.PATH ?? ""}`, EVERCHAT_NEVER: list(LIST) },
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(done.exitCode).toBe(1)
  expect(done.stderr.toString()).toContain(`${dir}/msg:1: a word of the list (line 1)`)
})

test("the hook fails with a line when bun is not found", () => {
  const sh = Bun.which("sh")!
  const done = Bun.spawnSync([sh, HOOK, message("clean\n")], {
    cwd: ROOT,
    env: { PATH: path.join(temp(), "empty"), EVERCHAT_NEVER: list(LIST) },
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(done.exitCode).toBe(1)
  expect(done.stderr.toString()).toContain("bun is not found")
})
