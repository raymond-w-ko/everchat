// Diff
// ====
// A file's change as a unified diff, the form that `git diff` gives. The
// functions `write` and `edit` answer with it, so the model and the person
// see what changed and not the whole file.
//
// Ported from the old code (ref/src/machine.ts: text_diff, lines_diff,
// lines_match, box_snake). One difference: the old code shortened a long
// diff here. Now a function gives its whole result, and the output limit
// shortens what the model is shown (limit.ts).

// A line of a diff: kept in both texts (" "), only in the old ("-"), only
// in the new ("+").
interface Op {
  readonly s: " " | "-" | "+"
  readonly x: string
}

// Lines a0 to a1 of an old text, b0 to b1 of a new one (ends excluded).
type Box = readonly [number, number, number, number]

// The lines kept around each change.
const CONTEXT = 3

// A text's lines, each with its "\n". The last may lack it: it then gets
// the line that git puts after such a line in a diff.
const linesOf = (text: string): Array<string> =>
  (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => (line.endsWith("\n") ? line : line + "\n\\ No newline at end of file"))

// A box's middle snake, as the box it spans: where a shortest path from its
// top corner meets one from its bottom. Both grow one step `d` at a time,
// and each keeps the furthest x that it reached on each diagonal k = x - y
// (`forward` from the top, `backward` from the bottom, counted back).
const snake = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, [a0, a1, b0, b1]: Box): Box => {
  const [n, m] = [a1 - a0, b1 - b0]
  const delta = n - m
  const off = n + m + 1
  const forward = new Int32Array(2 * off + 1)
  const backward = new Int32Array(2 * off + 1)
  const at = (v: Int32Array, k: number) => v[off + k] ?? 0
  for (let d = 0;; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(forward, k - 1) < at(forward, k + 1)) ? at(forward, k + 1) : at(forward, k - 1) + 1
      const x0 = x
      while (x < n && x - k < m && a[a0 + x] === b[b0 + x - k]) {
        x++
      }
      forward[off + k] = x
      const c = delta - k
      if (delta % 2 !== 0 && Math.abs(c) < d && x + at(backward, c) >= n) {
        return [a0 + x0, a0 + x, b0 + x0 - k, b0 + x - k]
      }
    }
    for (let c = -d; c <= d; c += 2) {
      let x = c === -d || (c !== d && at(backward, c - 1) < at(backward, c + 1)) ? at(backward, c + 1) : at(backward, c - 1) + 1
      const x0 = x
      while (x < n && x - c < m && a[a1 - 1 - x] === b[b1 - 1 - x + c]) {
        x++
      }
      backward[off + c] = x
      const k = delta - c
      if (delta % 2 === 0 && Math.abs(k) <= d && x + at(forward, k) >= n) {
        return [a1 - x, a1 - x0, b1 - x + c, b1 - x0 + c]
      }
    }
  }
}

// The lines of `a` and `b` that are kept in a box of them, as pairs [i, j]
// in order: a longest common subsequence (Myers, in linear space). First
// the common head and tail. Between them, unless a side is empty, the
// middle snake, and each part around it in the same way. The time is
// (n + m)·d, with d the lines that changed.
const match = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, box: Box, pairs: Array<[number, number]>): Array<[number, number]> => {
  let [a0, a1, b0, b1] = box
  let tail = 0
  for (; a0 < a1 && b0 < b1 && a[a0] === b[b0]; a0++, b0++) {
    pairs.push([a0, b0])
  }
  for (; a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]; a1--, b1--) {
    tail++
  }
  if (a0 < a1 && b0 < b1) {
    const [x, u, y, v] = snake(a, b, [a0, a1, b0, b1])
    match(a, b, [a0, x, b0, y], pairs)
    for (let k = 0; k < u - x; k++) {
      pairs.push([x + k, y + k])
    }
    match(a, b, [u, a1, v, b1], pairs)
  }
  for (let k = 0; k < tail; k++) {
    pairs.push([a1 + k, b1 + k])
  }
  return pairs
}

// The shortest script from lines `a` to lines `b`: the lines kept (the
// most), and in each gap between two of them the old lines dropped, then
// the new ones added, as git shows them. A line that only one text has is
// never kept, so the match runs without those lines (a file that was
// written whole anew needs no search).
const script = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<Op> => {
  const [inA, inB] = [new Set(a), new Set(b)]
  const ia = a.flatMap((x, i) => (inB.has(x) ? [i] : []))
  const ib = b.flatMap((x, j) => (inA.has(x) ? [j] : []))
  const pairs = match(ia.map((i) => a[i] ?? ""), ib.map((j) => b[j] ?? ""), [0, ia.length, 0, ib.length], [])
  const ops: Array<Op> = []
  const push = (s: Op["s"], lines: ReadonlyArray<string>, from: number, to: number) => {
    for (const x of lines.slice(from, to)) {
      ops.push({ s, x })
    }
  }
  let [i, j] = [0, 0]
  for (const [p, q] of pairs) {
    const [keptA, keptB] = [ia[p] ?? 0, ib[q] ?? 0]
    push("-", a, i, keptA)
    push("+", b, j, keptB)
    push(" ", a, keptA, keptA + 1)
    ;[i, j] = [keptA + 1, keptB + 1]
  }
  push("-", a, i, a.length)
  push("+", b, j, b.length)
  return ops
}

// The change of the file `name` from the text `was` to the text `now`: its
// name as the old and the new file, then each run of changes in a hunk
// with CONTEXT lines around it. Runs that are close share one hunk. Lines
// keep their "\n", so a last line without it differs, and says so as git
// does.
export const diff = (name: string, was: string, now: string): string => {
  const ops = script(linesOf(was), linesOf(now))
  const at: Array<readonly [number, number]> = []
  let [i, j] = [0, 0]
  for (const op of ops) {
    at.push([i, j])
    i += op.s === "+" ? 0 : 1
    j += op.s === "-" ? 0 : 1
  }
  const hunks: Array<[number, number]> = []
  ops.forEach((op, k) => {
    if (op.s === " ") {
      return
    }
    const top = hunks[hunks.length - 1]
    if (top !== undefined && k - top[1] <= 2 * CONTEXT) {
      top[1] = k + 1
    } else {
      hunks.push([k, k + 1])
    }
  })
  if (hunks.length === 0) {
    return name + " is unchanged."
  }
  let out = "--- " + name + "\n+++ " + name
  for (const [low, high] of hunks) {
    const from = Math.max(0, low - CONTEXT)
    const run = ops.slice(from, Math.min(ops.length, high + CONTEXT))
    const olds = run.filter((op) => op.s !== "+").length
    const news = run.filter((op) => op.s !== "-").length
    const [oldAt, newAt] = at[from] ?? [0, 0]
    out += "\n@@ -" + (oldAt + (olds === 0 ? 0 : 1)) + "," + olds + " +" + (newAt + (news === 0 ? 0 : 1)) + "," + news + " @@"
    out += run.map((op) => "\n" + op.s + op.x.replace(/\n$/, "")).join("")
  }
  return out
}
