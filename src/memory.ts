// Memory
// ======
// The chat, kept for ever, and the view of it that each request shows the
// model. Sizes are bytes of UTF-8.
//
// Over the messages grows a binary tree. Node (0, i) is message i (or the
// line it was logged with) in at most NODE bytes. Node (l, i) merges
// (l-1, 2i) and (l-1, 2i+1). A source that fits is its node, with no
// request. A longer one needs a compaction: a request to the compactor, with
// the compactions' own view (`seen`) up to the node, and then its task. A
// line that is too long is asked again, TRIES times at most, and the
// shortest is kept. An answer with no line makes the node its source, cut to
// NODE bytes. JOBS compactions run at once, in the order the messages came.
//
// A view lists nodes that cover the chat to its end, oldest first. Each new
// message adds its leaf. Past `high` bytes, a batch merges the neighbouring
// pairs whose parent is built and that are most due (oldest, in halves:
// detail fades with age) down to half. So between batches a view changes
// only at its end, and the vendor's prompt cache stays valid. There are two
// views: the chat's (for turns), to the last message, and the compactions',
// to the first message whose leaf is not built.
//
// This is a port of the old code (ref/src/memory.ts). The algorithm is the
// same, function by function, and tests/golden.test.ts compares its result
// with the old code's. What differs:
//
// - The state is in the database, through the store. Memory keeps in RAM
//   only what the old code kept: the texts of the views' nodes and of the
//   nodes built above them, and the two views.
// - The algorithm runs on that state with no pause (`Mem`, plain functions).
//   Each change collects its writes in a journal, and the change ends with
//   one transaction: one event, one transaction. If that write fails, the state
//   in RAM is ahead of the database. The memory then stops for good, and the
//   program must start again: a restart reads the true state.
// - Dropped with their features: imports (a second side), billing holds,
//   the move of a chat to another process, acts. Images are not here yet.

import { Context, Deferred, Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { page, pages } from "./pages.ts"
import type { Block } from "./request.ts"
import { type Kind, type Message, type NewMessage, type NewUsage, Store, type StoreError } from "./store.ts"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "memory")

// Constants
// ---------

export const NODE = 512 // the most bytes of a node
export const JOBS = 64 // compactions at once
export const TRIES = 5 // lines asked for one node, at most
// A view past its `high` merges to half: the chat's 64-128 KB, the
// compactions' 16-32 KB.
export const HIGH = 128000
export const SEEN = 32000
export const BLOCK = 4 // lines of a view in one block of a request

// A ruler, not a sample line: the compactor copied a sample's content.
const SCALE = "-".repeat(NODE)

const WAIT = "(not summarized yet: zoom it)"

// A compaction's task, before its <input>: one message to compress (level
// 0), or two lines to merge. These texts go to the model. Do not reflow them.
const LEAF = `Compaction: compress message {id} into one line of at most ${NODE} bytes
(about 70 words), the length of this ruler:
${SCALE}
<input>
`

const MERGE = `Compaction: merge lines {a} and {b}, adjacent, into one line of at most
${NODE} bytes (about 70 words), the length of this ruler:
${SCALE}
<chat> may hold their messages, {id} to {end}, in more detail: take details
of them from there too.
<input>
`

// Data
// ----

export type { Block } from "./request.ts"

// Node (l, i), as a line of a view.
export interface Part {
  readonly l: number
  readonly i: number
}

// A message to log. A long text becomes pages.
export interface Said {
  readonly kind: Kind
  readonly text: string
  readonly line?: string | null | undefined // its own summary line
  readonly turn?: number | null | undefined
  readonly call?: number | null | undefined
}

// What a compaction gave back: a line (empty: none), and what the request
// used.
export interface Compaction {
  readonly text: string
  readonly usage?: Omit<NewUsage, "served" | "node" | "turn"> | undefined
}

export class CompactorError extends Schema.TaggedError<CompactorError>()("CompactorError", {
  cause: Schema.Defect()
}) {}

// The model that runs compactions. The memory gives it the blocks of one
// request: the compactions' view, then the task.
export class Compactor extends Context.Service<Compactor, {
  compact(blocks: ReadonlyArray<Block>, node: Part): Effect.Effect<Compaction, CompactorError>
}>()("everchat/memory/Compactor") {}

// How long to wait before a failed compaction is asked again. It never
// gives up: an outage only delays a node.
export const CompactionRetry = Context.Reference<Schedule.Schedule<unknown>>("everchat/memory/CompactionRetry", {
  defaultValue: () => Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")]).pipe(Schedule.jittered)
})

// The tree's math
// ---------------

export const bytes = (text: string): number => Buffer.byteLength(text, "utf8")

// A message as the model reads it.
export const show = (kind: Kind, text: string): string => kind + ": " + text

// One number per node: its key in `Mem.nodes`.
export const slot = (l: number, i: number): number => (2 * i + 1) * 2 ** l - 1

// The tree's roots: a node per power of two in the count, largest first.
export const roots = (count: number): Array<Part> => {
  const out: Array<Part> = []
  for (let l = 30, id = 0; l >= 0; l--) {
    if (id + 2 ** l <= count) {
      out.push({ l, i: id / 2 ** l })
      id += 2 ** l
    }
  }
  return out
}

export const halves = (part: Part): Array<Part> =>
  part.l === 0 ? [] : [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }]

// The first and the last message of a node.
export const span = (part: Part): [number, number] => {
  const a = part.i * 2 ** part.l
  return [a, a + 2 ** part.l - 1]
}

// Where a node's compaction view ends: a leaf's before its message, a
// merge's after its last.
export const ctx = (l: number, i: number): number => (l === 0 ? i : (i + 1) * 2 ** l)

// The regex tries every position; most lines have no newline at all.
export const flat = (text: string): string => (text.includes("\n") ? text.replace(/\s*\n\s*/g, " ") : text)

// A node's name for the model, and its zoom target: "id+n".
export const ref = (part: Part): string => part.i * 2 ** part.l + "+" + 2 ** part.l

export const line = (part: Part, text: string): string => ref(part) + "|" + flat(text)

// A text's first NODE bytes.
export const cut = (text: string): string =>
  Buffer.from(text, "utf8").subarray(0, NODE).toString("utf8").replace(/�+$/, "")

export const over = (text: string): string =>
  `Too long: your last line for this <input> was ${bytes(text)} bytes,
over the ${NODE}-byte limit. Write the whole line again, cutting just
enough of the least valuable items to fit before this cut:
${cut(text)}| ← LIMIT`

// Node (l, i)'s task, but its input.
export const task = (l: number, i: number): string => {
  const [a, z] = span({ l, i })
  const n = 2 ** l / 2
  const fill: Array<[string, string]> = [["{a}", a + "+" + n], ["{b}", a + n + "+" + n], ["{id}", String(a)], [
    "{end}",
    String(z)
  ]]
  return fill.reduce((text, [key, value]) => text.replace(key, value), l === 0 ? LEAF : MERGE)
}

// A view's lines as the blocks of a request: an opening block, then the
// lines in blocks of BLOCK (the last cut short, with the closing tag). One
// is marked: the last whole one, else the opening one.
export const inBlocks = (lines: ReadonlyArray<string>): Array<Block> => {
  const whole = Math.floor(lines.length / BLOCK)
  const out: Array<Block> = [{ text: "<chat>\n", mark: whole === 0 }]
  for (let k = 0; k < whole; k++) {
    out.push({ text: lines.slice(k * BLOCK, (k + 1) * BLOCK).map((one) => one + "\n").join(""), mark: k === whole - 1 })
  }
  out.push({ text: lines.slice(whole * BLOCK).map((one) => one + "\n").join("") + "</chat>\n", mark: false })
  return out
}

// A view as it is now, from the view as the database keeps it: the kept
// parts, then a leaf for each message from their end up to `upto`. The
// database's row is written only when a batch changes a view, because
// between batches a view grows only so, at its end.
export const grown = (kept: ReadonlyArray<Part>, upto: number): Array<Part> => {
  const out = [...kept]
  const last = kept[kept.length - 1]
  for (let i = last === undefined ? 0 : span(last)[1] + 1; i < upto; i++) {
    out.push({ l: 0, i })
  }
  return out
}

// The node for "id+n", if the chat has it.
export const partOf = (count: number, id: number, n: number): Part | null => {
  const l = Math.log2(n)
  const ok = Number.isInteger(id) && Number.isInteger(l) && id >= 0 && id % n === 0 && id + n <= count
  return ok ? { l, i: id / n } : null
}

// The state in RAM
// ----------------

// A view: its parts, the bytes of those built, whether a batch is under
// way, and the bytes past which it merges to half.
interface View {
  readonly name: "chat" | "seen"
  readonly high: number
  parts: Array<Part>
  size: number
  batch: boolean
}

// A compaction to run: its node, its source, and its request.
interface Job extends Part {
  readonly text: string
  readonly blocks: ReadonlyArray<Block>
}

// What one change wrote, to go to the database in one transaction.
interface Journal {
  from: number // the id of the first new message
  messages: Array<NewMessage>
  nodes: Array<Part & { readonly text: string }>
  usage: Array<NewUsage>
  views: boolean
}

// count: the messages logged. nodes: the texts of the views' nodes and of
// those built above them, by slot. leaves: the sources of the leaves not
// built. ready: the nodes not built whose halves are, by level, in order.
// busy: the nodes whose compaction runs. started: jobs to start when the
// change's write is done.
interface Mem {
  count: number
  readonly nodes: Map<number, string>
  readonly leaves: Map<number, string>
  readonly view: View
  readonly seen: View
  readonly ready: Array<Array<number>>
  readonly busy: Set<number>
  readonly started: Array<Job>
  journal: Journal
}

const journal = (from: number): Journal => ({ from, messages: [], nodes: [], usage: [], views: false })

const fresh = (count: number, high = HIGH, seen = SEEN): Mem => ({
  count,
  nodes: new Map(),
  leaves: new Map(),
  view: { name: "chat", high, parts: [], size: 0, batch: false },
  seen: { name: "seen", high: seen, parts: [], size: 0, batch: false },
  ready: [],
  busy: new Set(),
  started: [],
  journal: journal(count)
})

// Of a node that a view or a node above it may need.
const built = (mem: Mem, l: number, i: number): boolean => mem.nodes.has(slot(l, i))

const text = (mem: Mem, part: Part): string => mem.nodes.get(slot(part.l, part.i)) ?? WAIT

// A line's bytes as requests get it: none until built.
const size = (mem: Mem, part: Part): number => (built(mem, part.l, part.i) ? bytes(text(mem, part)) : 0)

// The message after a view's last line.
const end = ({ parts }: { readonly parts: ReadonlyArray<Part> }): number => {
  const last = parts[parts.length - 1]
  return last === undefined ? 0 : span(last)[1] + 1
}

// The index of a view's line that holds message `id` (past its end: none).
const cover = ({ parts }: { readonly parts: ReadonlyArray<Part> }, id: number): number => {
  let [a, z] = [0, parts.length]
  while (a < z) {
    const m = (a + z) >> 1
    ;[a, z] = span(parts[m]!)[1] < id ? [m + 1, z] : [a, m]
  }
  return a
}

// The message of the (k+1)th leaf not built, else the count.
const first = (mem: Mem, k = 0): number => (mem.ready[0] ?? [])[k] ?? mem.count

// A node ready (on), or no more (built).
const ready = (mem: Mem, { i, l }: Part, on: boolean): void => {
  const queue = (mem.ready[l] ??= [])
  let [a, z] = [0, queue.length]
  while (a < z) {
    const m = (a + z) >> 1
    ;[a, z] = queue[m]! < i ? [m + 1, z] : [a, m]
  }
  if (on !== (queue[a] === i)) {
    queue.splice(a, on ? 0 : 1, ...(on ? [i] : []))
  }
}

const source = (mem: Mem, l: number, i: number): string | null => {
  if (l === 0) {
    return mem.leaves.get(i) ?? null
  }
  const [a, b] = halves({ l, i }).map((half) => mem.nodes.get(slot(half.l, half.i)) ?? null)
  return a === null || a === undefined || b === null || b === undefined ? null : flat(a) + "\n" + flat(b)
}

// The nodes under `part` not built whose sources are: only nodes not built
// and their halves are visited.
const todo = (mem: Mem, part: Part): Array<Part> => {
  if (built(mem, part.l, part.i)) {
    return []
  }
  const under = halves(part)
  const here = under.every((half) => built(mem, half.l, half.i)) ? [part] : []
  return [...here, ...under.flatMap((half) => todo(mem, half))]
}

// The view's lines built before message `upto`, as the blocks of a request.
const blocks = (mem: Mem, upto: number, parts: ReadonlyArray<Part>): Array<Block> =>
  inBlocks(
    parts
      .filter((part) => span(part)[1] < upto)
      .filter((part) => built(mem, part.l, part.i))
      .map((part) => line(part, text(mem, part)))
  )

// Nodes built: written in the change's transaction, and kept.
const store = (mem: Mem, parts: ReadonlyArray<Part & { readonly text: string }>): void => {
  mem.journal.nodes.push(...parts)
  for (const { i, l, text } of parts) {
    ready(mem, { l, i }, false)
    mem.nodes.set(slot(l, i), text)
    if (l === 0) {
      mem.leaves.delete(i)
    }
    for (const view of [mem.view, mem.seen]) {
      view.size += l === 0 && i < end(view) ? bytes(text) : 0
    }
  }
  for (const { i, l } of parts) {
    const up = { l: l + 1, i: i >> 1 }
    if (built(mem, l, i ^ 1) && !built(mem, up.l, up.i)) {
      ready(mem, up, true)
    }
  }
}

// The nodes ready up to the JOBS-th leaf not built, in the order the
// messages came (`ctx`; at a tie, a merge first), while fewer than JOBS run.
// It starts the jobs, and returns the nodes whose source fits.
const starts = (mem: Mem): Array<Part & { readonly text: string }> => {
  const free: Array<Part & { readonly text: string }> = []
  const upto = first(mem, JOBS - 1)
  const next: Array<Part> = []
  mem.ready.forEach((queue, l) => {
    for (let k = 0; k < queue.length && ctx(l, queue[k]!) <= upto; k++) {
      next.push({ l, i: queue[k]! })
    }
  })
  next.sort((a, b) => ctx(a.l, a.i) - ctx(b.l, b.i) || b.l - a.l)
  for (const { i, l } of next) {
    if (mem.busy.size >= JOBS) {
      break
    }
    const from = mem.busy.has(slot(l, i)) ? null : source(mem, l, i)
    if (from !== null && bytes(from) <= NODE) {
      free.push({ l, i, text: from })
    } else if (from !== null) {
      // The request is fixed now: the compactions' view as it is, to the
      // node, then the task.
      const ask = { text: task(l, i) + from + "\n</input>", mark: false }
      mem.busy.add(slot(l, i))
      mem.started.push({ l, i, text: from, blocks: [...blocks(mem, Math.min(ctx(l, i), first(mem)), mem.seen.parts), ask] })
    }
  }
  return free
}

// Whether a view holds `part` or a node under it, or will (not there).
const held = (mem: Mem, part: Part): boolean =>
  [mem.view, mem.seen].some((view) => {
    const k = cover(view, span(part)[0])
    return k === view.parts.length || view.parts[k]!.l <= part.l
  })

// A view to message `upto`: its lines from it dropped, the messages to it
// appended.
const reach = (mem: Mem, view: View, upto: number): void => {
  for (const part of view.parts.splice(cover(view, upto))) {
    view.size -= size(mem, part)
  }
  for (let i = end(view); i < upto; i++) {
    view.parts.push({ l: 0, i })
    view.size += size(mem, { l: 0, i })
  }
}

// A view's most due pairs merged down to half, as their parents allow: a
// pair whose parent is built, most due first ((T + 1) / 2^l - i, T the
// view's end: its age from its last message, in halves), the oldest of
// equals. A heap of pairs over the view as a linked list, so a view of
// thousands merges in milliseconds.
const merge = (mem: Mem, from: View): { parts: Array<Part>; size: number; gone: Array<Part> } => {
  type Pair = { d: number; k: number; a: Part; b: Part }
  const [t, low] = [end(from), from.high / 2]
  const view: Array<Part | null> = [...from.parts]
  const gone: Array<Part> = []
  const next = view.map((_, k) => k + 1)
  const prev = view.map((_, k) => k - 1)
  const heap: Array<Pair> = []
  const before = (x: Pair, y: Pair) => x.d > y.d || (x.d === y.d && x.k < y.k)
  const swap = (x: number, y: number) => {
    ;[heap[x], heap[y]] = [heap[y]!, heap[x]!]
  }
  const offer = (k: number) => {
    const a = view[k]
    const b = view[next[k]!]
    if (k < 0 || !a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1 || !built(mem, a.l + 1, a.i / 2)) {
      return
    }
    heap.push({ d: (t + 1) / 2 ** a.l - a.i, k, a, b })
    for (let x = heap.length - 1; x > 0 && before(heap[x]!, heap[(x - 1) >> 1]!); x = (x - 1) >> 1) {
      swap(x, (x - 1) >> 1)
    }
  }
  const take = (): Pair => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      for (let x = 0;;) {
        const m = [x, 2 * x + 1, 2 * x + 2].reduce((m, c) => (c < heap.length && before(heap[c]!, heap[m]!) ? c : m))
        if (m === x) {
          break
        }
        swap(x, m)
        x = m
      }
    }
    return top
  }
  let total = from.size
  view.forEach((_, k) => offer(k))
  while (heap.length > 0 && total > low) {
    const { a, b, k } = take()
    const j = next[k]!
    if (view[k] !== a || view[j] !== b) {
      continue
    }
    const up = { l: a.l + 1, i: a.i / 2 }
    total += size(mem, up) - size(mem, a) - size(mem, b)
    ;[view[k], view[j]] = [up, null]
    next[k] = next[j]!
    prev[next[j]!] = k
    gone.push(a, b)
    offer(prev[k]!)
    offer(k)
  }
  return { parts: view.filter((part) => part !== null), size: total, gone }
}

// Each view to its end. A batch starts as a view passes `high`, or goes on
// at a message (`next`) if a missing parent stopped it. Between messages,
// only a whole batch is taken, to half: each change makes every request
// after it write the view anew. A node merged away that no view holds, nor
// one under it, is let go.
const fit = (mem: Mem, next = false): void => {
  const gone: Array<Part> = []
  let changed = false
  reach(mem, mem.view, mem.count)
  reach(mem, mem.seen, Math.min(mem.count, first(mem)))
  for (const view of [mem.view, mem.seen]) {
    const [parts, batch] = [view.parts.length, view.batch]
    if (view.size > view.high || (next && view.batch)) {
      const merged = merge(mem, view)
      if (next || merged.size <= Math.max(view.high / 2, view.size - view.high)) {
        ;[view.parts, view.size] = [merged.parts, merged.size]
        gone.push(...merged.gone)
      }
      view.batch = view.size > view.high / 2
    }
    changed ||= view.parts.length !== parts || view.batch !== batch
  }
  gone.filter((part) => !held(mem, part)).forEach((part) => mem.nodes.delete(slot(part.l, part.i)))
  if (changed) {
    mem.journal.views = true
  }
}

// The nodes to build. Those whose source fits take no request: they are
// built at once, together.
const pump = (mem: Mem): void => {
  let any = false
  for (let free = starts(mem); free.length > 0; free = starts(mem)) {
    store(mem, free)
    any = true
  }
  if (any) {
    fit(mem)
  }
}

// The messages logged, as pages. Their leaves are ready.
const push = (mem: Mem, said: ReadonlyArray<Said>): void => {
  for (const one of said) {
    const texts = pages(one.text.toWellFormed())
    texts.forEach((text, k) => {
      const i = mem.count
      const line = k === 0 && one.line !== undefined && one.line !== null ? one.line.toWellFormed() : null
      mem.journal.messages.push({ kind: one.kind, text, more: k < texts.length - 1, line, turn: one.turn, call: one.call })
      mem.leaves.set(i, line ?? show(one.kind, text))
      mem.count += 1
      ready(mem, { l: 0, i }, true)
    })
  }
  fit(mem, true)
  pump(mem)
}

// The algorithm on the state in RAM, for the tests of its rules.
export const core = { fresh, ready, store, starts, merge, fit, pump, push }

// The service
// -----------

// What the memory holds now, for tests and for diagnostics.
export interface State {
  readonly count: number
  readonly view: { readonly parts: ReadonlyArray<readonly [number, number]>; readonly size: number; readonly batch: boolean }
  readonly seen: { readonly parts: ReadonlyArray<readonly [number, number]>; readonly size: number; readonly batch: boolean }
  readonly busy: number // compactions that run
  readonly held: number // node texts in RAM
}

export class Memory extends Context.Service<Memory, {
  // Logs messages: each as its pages, with the nodes that need no request,
  // and the views if a batch changed them, in one transaction. Returns the pages as written. It
  // starts the compactions that are now due.
  push(said: ReadonlyArray<Said>): Effect.Effect<Array<Message>, StoreError>

  // The same, with more writes of the caller in the same transaction: an
  // event that logs a message and writes other rows is still one
  // transaction. `also` gets the pages as written. If it fails, the memory
  // stops for good, as after any failed write.
  pushWith<B>(
    said: ReadonlyArray<Said>,
    also: (written: Array<Message>) => Effect.Effect<B, StoreError>
  ): Effect.Effect<readonly [Array<Message>, B], StoreError>

  // The first message, from `from` on, from which the messages to the end
  // go whole in one request: HIGH bytes at most, and the last one always.
  whole(from: number): Effect.Effect<number, StoreError>

  // The pages from `a` up to, and not with, `b`, as one text.
  say(a: number, b: number): Effect.Effect<string, StoreError>

  // Waits until every message before `upto` has its leaf.
  settle(upto: number): Effect.Effect<void, StoreError>

  // Waits until no compaction runs.
  readonly idle: Effect.Effect<void, StoreError>

  // The chat's view as the blocks of a request: its lines built before
  // message `upto` (none: all).
  view(upto?: number): Effect.Effect<Array<Block>>

  // A message (n = 1) whole, a long one a page from `at`; else the two
  // lines under id+n.
  zoom(id: number, n: number, at: number): Effect.Effect<string, StoreError>

  readonly state: Effect.Effect<State>
}>()("everchat/memory/Memory") {
  static readonly layer = Layer.effect(
    Memory,
    Effect.gen(function*() {
      const db = yield* Store
      const compactor = yield* Compactor
      const retry = yield* CompactionRetry
      const scope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const waiters = new Set<{ readonly ok: () => boolean; readonly done: Deferred.Deferred<void, StoreError> }>()
      let broken: StoreError | null = null

      // Load
      // ----

      const count = yield* db.count
      const mem = fresh(count)

      // The view under `part`, down from it, keeping the built nodes met:
      // the nodes of `keys` built (none: any built), or messages.
      const down = (part: Part, keys: Set<number> | null): Effect.Effect<Array<Part>, StoreError> =>
        Effect.gen(function*() {
          const key = slot(part.l, part.i)
          const node = Option.getOrNull(yield* db.node(part.l, part.i))
          if (node !== null) {
            mem.nodes.set(key, node.text)
          }
          if (part.l === 0 || (node !== null && (keys === null || keys.has(key)))) {
            return [part]
          }
          const out: Array<Part> = []
          for (const half of halves(part)) {
            out.push(...(yield* down(half, keys)))
          }
          return out
        })

      // A view as kept (none: the highest nodes built).
      const open = Effect.fnUntraced(function*(view: View, kept: { readonly parts: ReadonlyArray<readonly [number, number]>; readonly batch: boolean } | null) {
        const keys = kept === null ? null : new Set(kept.parts.map(([l, i]) => slot(l, i)))
        const parts: Array<Part> = []
        for (const root of roots(mem.count)) {
          parts.push(...(yield* down(root, keys)))
        }
        view.parts = parts
        view.size = parts.reduce((n, part) => n + size(mem, part), 0)
        view.batch = kept?.batch ?? false
      })

      const chat = Option.getOrNull(yield* db.view("chat"))
      yield* open(mem.view, chat)
      yield* open(mem.seen, Option.getOrNull(yield* db.view("seen")) ?? chat)
      roots(mem.count).flatMap((part) => todo(mem, part)).forEach((part) => ready(mem, part, true))
      for (const i of mem.ready[0] ?? []) {
        const [message] = yield* db.messages(i, i + 1)
        if (message !== undefined) {
          mem.leaves.set(i, message.line ?? show(message.kind, message.text))
        }
      }

      // Changes
      // -------

      const pairs = (view: View) => ({
        name: view.name,
        parts: view.parts.map((part): [number, number] => [part.l, part.i]),
        batch: view.batch
      })

      // The change's writes, in one transaction.
      // `also`: more writes of the same event, by the caller, in the same
      // transaction. It gets the messages as written.
      const flush = <B>(also: ((written: Array<Message>) => Effect.Effect<B, StoreError>) | null) => Effect.gen(function*() {
        const wrote = mem.journal
        mem.journal = journal(mem.count)
        if (also === null && wrote.messages.length === 0 && wrote.nodes.length === 0 && wrote.usage.length === 0 && !wrote.views) {
          return [[] as Array<Message>, undefined as B] as const
        }
        return yield* db.transaction(Effect.gen(function*() {
          const written = wrote.messages.length === 0 ? [] : yield* db.append(wrote.messages)
          if (written[0] !== undefined && written[0].i !== wrote.from) {
            return yield* Effect.die(new Error(`the log gave message ${written[0].i}, and the memory expected ${wrote.from}`))
          }
          if (wrote.nodes.length > 0) {
            yield* db.putNodes(wrote.nodes)
          }
          if (wrote.views) {
            yield* db.putView(pairs(mem.view))
            yield* db.putView(pairs(mem.seen))
          }
          for (const usage of wrote.usage) {
            yield* db.addUsage(usage)
          }
          return [written, also === null ? (undefined as B) : yield* also(written)] as const
        }))
      })

      // Those who wait for a state that is now there go on.
      const wake = Effect.gen(function*() {
        for (const waiter of [...waiters]) {
          if (waiter.ok()) {
            waiters.delete(waiter)
            yield* Deferred.succeed(waiter.done, undefined)
          }
        }
      })

      // One change of the state: the algorithm with no pause, then its
      // writes, then the jobs it started. One at a time, and never cut in
      // the middle.
      const apply = <A, B = void>(
        change: () => A,
        also: ((written: Array<Message>) => Effect.Effect<B, StoreError>) | null = null
      ): Effect.Effect<readonly [A, Array<Message>, B], StoreError> =>
        lock.withPermits(1)(Effect.gen(function*() {
          if (broken !== null) {
            return yield* Effect.fail(broken)
          }
          const result = change()
          const [written, more] = yield* Effect.tapError(flush(also), (error) =>
            Effect.gen(function*() {
              broken = error
              mem.started.length = 0
              for (const waiter of waiters) {
                yield* Deferred.fail(waiter.done, error)
              }
              waiters.clear()
            }))
          for (const job of mem.started.splice(0)) {
            yield* Effect.forkIn(run(job), scope)
          }
          yield* wake
          return [result, written, more] as const
        })).pipe(Effect.uninterruptible)

      // Node (l, i)'s compaction: asked until a line fits, TRIES lines at
      // most, the shortest kept. Each try sends the same blocks. A try after
      // a line too long adds only a note with its size and where the limit
      // cuts it: never more than the first request and that note. No line:
      // the node is its source, cut.
      const run = (job: Job): Effect.Effect<void> =>
        Effect.gen(function*() {
          const lines: Array<string> = []
          const used: Array<NewUsage> = []
          let ask = job.blocks
          for (;;) {
            const request = ask
            const got = yield* Effect.suspend(() => compactor.compact(request, { l: job.l, i: job.i })).pipe(
              Effect.tapError((error) => diagnostic(Effect.logWarning(`the compaction of node ${job.l}/${job.i} failed, and is asked again`, error))),
              Effect.retry(retry)
            )
            if (got.usage !== undefined) {
              used.push({ ...got.usage, served: "compaction", node: [job.l, job.i] })
            }
            const text = got.text.toWellFormed().trim()
            if (text === "") {
              break
            }
            lines.push(text)
            if (bytes(text) <= NODE || lines.length === TRIES) {
              break
            }
            ask = [...job.blocks, { text: over(text), mark: false }]
          }
          if (lines.length === 0) {
            yield* diagnostic(Effect.logWarning(`the compaction of node ${job.l}/${job.i} gave no line: its source is cut`))
          }
          const kept = lines.length === 0 ? cut(flat(job.text)) : lines.reduce((a, b) => (bytes(b) < bytes(a) ? b : a))
          yield* apply(() => {
            mem.journal.usage.push(...used)
            store(mem, [{ l: job.l, i: job.i, text: kept }])
            mem.busy.delete(slot(job.l, job.i))
            pump(mem)
            fit(mem)
          })
        }).pipe(
          // The compactor gave up (a schedule that ends), the write failed,
          // or the job itself has a defect. The node stays not built, and it
          // is no more busy: a later change asks again.
          Effect.catchCause((cause) =>
            Effect.gen(function*() {
              mem.busy.delete(slot(job.l, job.i))
              yield* diagnostic(Effect.logError(`node ${job.l}/${job.i} is not built`, cause))
              yield* wake
            })
          )
        )

      // The first change: the views to the chat's end, kept, and the
      // compactions that a stop cut start again.
      yield* apply(() => {
        fit(mem)
        mem.journal.views = true
        pump(mem)
      })

      const until = (ok: () => boolean): Effect.Effect<void, StoreError> =>
        Effect.suspend(() => {
          if (broken !== null) {
            return Effect.fail(broken)
          }
          if (ok()) {
            return Effect.void
          }
          const waiter = { ok, done: Deferred.makeUnsafe<void, StoreError>() }
          waiters.add(waiter)
          return Effect.ensuring(Deferred.await(waiter.done), Effect.sync(() => waiters.delete(waiter)))
        })

      const whole = Effect.fn("Memory.whole")(function*(from: number) {
        const messages = yield* db.messages(from, mem.count)
        let [k, total] = [mem.count, 0]
        for (; k > from; k--) {
          const message = messages[k - 1 - from]
          total += message === undefined ? 0 : bytes(show(message.kind, message.text))
          if (k < mem.count && total > HIGH) {
            return k
          }
        }
        return k
      })

      const say = Effect.fn("Memory.say")(function*(a: number, b: number) {
        return (yield* db.messages(a, b)).map((message) => message.text).join("")
      })

      const zoom = Effect.fn("Memory.zoom")(function*(id: number, n: number, at: number) {
        const part = partOf(mem.count, id, n)
        if (part === null) {
          const names = roots(mem.count).map(ref).join(", ")
          return "No line " + id + "+" + n + ": n is a power of 2, id a multiple of n. The tree's roots: " + names + "."
        }
        if (n === 1) {
          const [message] = yield* db.messages(id, id + 1)
          if (message !== undefined) {
            return id + "+0|" + show(message.kind, page(message.text, at))
          }
        }
        const lines: Array<string> = []
        for (const half of halves(part)) {
          const node = Option.getOrNull(yield* db.node(half.l, half.i))
          lines.push(line(half, node?.text ?? WAIT))
        }
        return lines.join("\n")
      })

      return Memory.of({
        push: (said) => Effect.map(apply(() => push(mem, said)), ([, written]) => written),
        pushWith: (said, also) => Effect.map(apply(() => push(mem, said), also), ([, written, more]) => [written, more] as const),
        whole,
        say,
        settle: (upto) => until(() => first(mem) >= upto),
        idle: until(() => mem.busy.size === 0),
        view: (upto) => Effect.sync(() => blocks(mem, upto ?? mem.count, mem.view.parts)),
        zoom,
        state: Effect.sync((): State => ({
          count: mem.count,
          view: { parts: pairs(mem.view).parts, size: mem.view.size, batch: mem.view.batch },
          seen: { parts: pairs(mem.seen).parts, size: mem.seen.size, batch: mem.seen.batch },
          busy: mem.busy.size,
          held: mem.nodes.size
        }))
      })
    })
  )
}
