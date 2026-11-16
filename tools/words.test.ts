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
import { type Report, listPath, mask, NO_LIST, run } from "./words.ts"

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

// The compare's form, written out here: a change of the script's compare
// does not change what this checks.
const letters = (one: string) => one.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

// No word of `words` in the output, in any letter case, and with no mark
// inside it.
const clean = (report: Report, words: ReadonlyArray<string> = WORDS) => {
  const lower = text(report).toLowerCase()
  const flat = letters(text(report))
  for (const word of words) {
    expect(lower).not.toContain(word.toLowerCase())
    expect(flat).not.toContain(letters(word))
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
  }
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
    clean(report, [...WORDS, "zub"])
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
