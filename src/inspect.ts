// Inspect
// =======
// What the inspector shows, as data: the tree and the log, the two views,
// each turn's request, the usage, and the diagnostics. This module only
// reads. It uses the store's reads (`Reads`), so it works in a process that
// does not own the database, also while a launch writes to it.
//
// It knows no HTTP and no page (inspector.ts has those), so a test asks it
// directly, and another interface could show the same data.
//
// Each answer is read on one state of the database (`snapshot`), and it is
// plain data that goes into JSON as it is.
//
// Three things tie the memory's parts together for the reader:
//
// - A window: the nodes that cover a range of messages, from a lowest level
//   up, and the parts of the two views there. The page draws the tree from
//   it. The lowest level rises with the width of the range, so that one
//   answer never holds more than CELLS nodes of one level.
// - A node with what it was built from: its source, whether a compaction
//   wrote it, and the requests of that compaction.
// - A turn's request as it was sent: the head, then the items. The lines of
//   the view in the first item are given with their nodes, so the page can
//   lead from a line that the model read to the node and to its messages.
//
// A view is given as it is now, which is more than the database's row: the
// row is written only when a batch changes a view, and between batches a
// view grows by one leaf for each new message (`grown` in memory.ts). The
// chat view grows to the last message. The compaction view grows to the
// first message whose leaf is not built.
//
// The body of a request is the one that the wire builds now from the kept
// items. It is not a copy of the bytes that were sent: the wire's code may
// have changed since, and the id of the reply that the cache watch named
// (`baseline`) is not kept.
//
// Not here: what streams (it is never in the database), and the request of
// a compaction (only its node and its usage are kept).

import { Context, Effect, Layer, Option } from "effect"
import * as os from "node:os"
import { BLOCK, bytes, cut, flat, grown, halves, HIGH, inBlocks, line, NODE, type Part, partOf, ref, roots, SEEN, show, span } from "./memory.ts"
import { body as openaiBody } from "./openai.ts"
import type { Block, Call as Wanted, Head, Result } from "./request.ts"
import {
  type Call,
  type Chat,
  type Diagnostic,
  type LaunchRecord,
  type Message,
  type Node,
  type Pick,
  ProcessAlive,
  Reads,
  StoreError,
  type UsageRecord,
  type UsageTotal,
  type ViewName
} from "./store.ts"
import { decodeHead, decodeKept, item, type Kept } from "./turn.ts"

// The most nodes of one level in one window.
export const CELLS = 1024

// The most messages, turns, usage records, or diagnostics in one answer.
export const ROWS = 500

// The most characters of a turn's first message in the list of the turns.
const SAID = 200

// Data
// ----

export interface ViewSummary {
  readonly name: ViewName
  readonly kept: number // the parts in the database's row, from the last batch
  readonly parts: number // its parts now: those, and a leaf for each message since
  readonly size: number // the bytes of its built nodes, as the memory counts them
  readonly high: number // past this size, a batch makes it half
  readonly batch: boolean
  readonly end: number // the message after its last part
}

export interface Overview {
  readonly version: number // changes when the database changes
  readonly chat: Chat
  readonly count: number // the messages
  readonly node: number // the most bytes of a node
  readonly block: number // the lines of a view in one block
  // Each level that the count allows: the nodes built, of those that the
  // count allows.
  readonly levels: ReadonlyArray<{ readonly l: number; readonly built: number; readonly whole: number }>
  readonly roots: ReadonlyArray<{ readonly l: number; readonly i: number; readonly built: boolean }>
  readonly views: ReadonlyArray<ViewSummary>
  readonly launch: LaunchRecord | null // the newest
  readonly live: boolean // that launch runs now, on this host
  readonly turn: number | null // the chat's turn that runs
  readonly usage: ReadonlyArray<UsageTotal>
}

export interface Window {
  readonly count: number
  readonly from: number
  readonly to: number // the range as it was taken: inside the chat
  readonly floor: number // the lowest level given
  readonly top: number // the highest level that the count allows (-1: no message)
  readonly nodes: ReadonlyArray<Node> // the nodes built from `floor` up that cover a message of the range
  readonly chat: ReadonlyArray<readonly [number, number]> // the chat view's parts there
  readonly seen: ReadonlyArray<readonly [number, number]> // the compaction view's parts there
}

export interface NodeDetail {
  readonly l: number
  readonly i: number
  readonly ref: string // its name for the model: "id+n"
  readonly first: number
  readonly last: number // its messages
  readonly node: Node | null // null: not built
  // What it is built from: a leaf's message as the model reads it (or the
  // line it was logged with), else the lines of its halves. Null: not there
  // yet.
  readonly source: string | null
  // How it was built. `source`: it is its source, with no request.
  // `summary`: a compaction wrote it. `cut`: a compaction gave no line, and
  // it is its source's first bytes.
  readonly how: "source" | "summary" | "cut" | null
  readonly requests: ReadonlyArray<UsageRecord> // its compaction's requests, oldest first
  readonly halves: ReadonlyArray<{ readonly l: number; readonly i: number; readonly built: boolean }>
  readonly above: { readonly l: number; readonly i: number; readonly built: boolean } | null // null: it is a root
  readonly chat: boolean // a part of the chat view
  readonly seen: boolean // a part of the compaction view
  readonly message: Message | null // a leaf's message
}

export interface ViewDetail extends ViewSummary {
  readonly lines: ReadonlyArray<{ readonly l: number; readonly i: number; readonly text: string | null; readonly size: number }>
  // Its built lines as the blocks of a request, to the view's end.
  readonly blocks: ReadonlyArray<Block>
}

export interface TurnLine {
  readonly id: number
  readonly agent: number | null
  readonly status: "running" | "done" | "stopped" | "failed"
  readonly pick: Pick
  readonly firstMsg: number
  readonly launch: number
  readonly created: number
  readonly ended: number | null
  readonly why: string | null
  readonly said: string // the start of its first message
}

// A line of the view in a request, with its node.
export interface Line {
  readonly l: number
  readonly i: number
  readonly ref: string
  readonly text: string
}

export type ItemShown =
  // What EverChat said. `lines`: the lines of the view in this block (null:
  // not a block of the view).
  | {
    readonly n: number
    readonly created: number
    readonly kind: "user"
    readonly blocks: ReadonlyArray<{ readonly text: string; readonly mark: boolean; readonly lines: ReadonlyArray<Line> | null }>
  }
  // What the model gave back in step `step` (1, 2, ...): the vendor's
  // items as received. `usage`: of that step's request (null: not known).
  | {
    readonly n: number
    readonly created: number
    readonly kind: "turn"
    readonly step: number
    readonly output: ReadonlyArray<unknown>
    readonly calls: ReadonlyArray<Wanted>
    readonly usage: UsageRecord | null
  }
  // The results of that step's programs.
  | { readonly n: number; readonly created: number; readonly kind: "back"; readonly results: ReadonlyArray<Result> }

export interface TurnDetail {
  readonly turn: TurnLine
  readonly head: Head
  readonly items: ReadonlyArray<ItemShown>
  readonly calls: ReadonlyArray<Call> // its programs and their functions
  readonly usage: ReadonlyArray<UsageRecord> // oldest first
  // The count of the items in the request that is asked now (null: none is).
  readonly asked: number | null
}

// The body of the request that holds a turn's first `upto` items.
export interface Body {
  readonly upto: number
  readonly vendor: string
  readonly body: Record<string, unknown> | null
  readonly error: string | null // why there is no body
}

// The service
// -----------

export class Inspect extends Context.Service<Inspect, {
  // A number that changes when the database changes.
  readonly version: Effect.Effect<number, StoreError>
  readonly overview: Effect.Effect<Overview, StoreError>
  // The tree over the messages from `from` up to, and not with, `to`, from
  // level `floor` up.
  window(from: number, to: number, floor?: number): Effect.Effect<Window, StoreError>
  // Null: the chat has no such node.
  node(l: number, i: number): Effect.Effect<NodeDetail | null, StoreError>
  // The messages from `from` up to, and not with, `to`: ROWS at most.
  messages(from: number, to: number): Effect.Effect<Array<Message>, StoreError>
  view(name: ViewName): Effect.Effect<ViewDetail, StoreError>
  // The turns with an id below `before` (null: all), newest first.
  turns(before: number | null, limit?: number): Effect.Effect<Array<TurnLine>, StoreError>
  // Null: no such turn.
  turn(id: number): Effect.Effect<TurnDetail | null, StoreError>
  // `upto` null: all the items.
  body(id: number, upto: number | null): Effect.Effect<Body | null, StoreError>
  // The usage with an id below `before` (null: all), newest first.
  usage(before: number | null, limit?: number): Effect.Effect<Array<UsageRecord>, StoreError>
  // The newest diagnostics, oldest first.
  diagnostics(limit?: number): Effect.Effect<Array<Diagnostic>, StoreError>
  launches(limit?: number): Effect.Effect<Array<LaunchRecord>, StoreError>
}>()("everchat/inspect/Inspect") {
  static readonly layer = Layer.effect(
    Inspect,
    Effect.gen(function*() {
      const reads = yield* Reads
      const alive = yield* ProcessAlive

      const HIGHS: Record<ViewName, number> = { chat: HIGH, seen: SEEN }
      const key = (l: number, i: number) => l + "/" + i
      const within = (limit: number | undefined) => Math.max(1, Math.min(ROWS, Math.trunc(limit ?? ROWS)))
      const broken = (op: string) => (cause: unknown) => new StoreError({ op, cause })

      // A view as it is now, with its built nodes by their key.
      const now = Effect.fnUntraced(function*(name: ViewName, count: number) {
        const row = Option.getOrNull(yield* reads.view(name))
        const kept = (row?.parts ?? []).map(([l, i]): Part => ({ l, i }))
        const last = kept[kept.length - 1]
        const from = last === undefined ? 0 : span(last)[1] + 1
        // The compaction view ends before the first leaf that is not built.
        let upto = count
        if (name === "seen") {
          const leaves = yield* reads.nodesIn(0, from, count)
          upto = from + leaves.findIndex((leaf, k) => leaf.i !== from + k)
          upto = upto < from ? from + leaves.length : upto
        }
        const parts = grown(kept, upto)
        const built = new Map((yield* reads.nodes(parts.map((part): [number, number] => [part.l, part.i]))).map((node) => [key(node.l, node.i), node]))
        const summary: ViewSummary = {
          name,
          kept: kept.length,
          parts: parts.length,
          size: parts.reduce((sum, part) => sum + (built.get(key(part.l, part.i))?.size ?? 0), 0),
          high: HIGHS[name],
          batch: row?.batch ?? false,
          end: Math.max(from, upto)
        }
        return { parts, built, summary }
      })

      const overview = reads.snapshot(Effect.gen(function*() {
        const count = yield* reads.count
        const built = new Map((yield* reads.levels).map((row) => [row.l, row.built]))
        const top = count === 0 ? -1 : Math.floor(Math.log2(count))
        const levels: Array<{ l: number; built: number; whole: number }> = []
        for (let l = 0; l <= top; l++) {
          levels.push({ l, built: built.get(l) ?? 0, whole: Math.floor(count / 2 ** l) })
        }
        const tops = roots(count)
        const have = new Set((yield* reads.nodes(tops.map((part): [number, number] => [part.l, part.i]))).map((node) => key(node.l, node.i)))
        const launch = (yield* reads.launches(1))[0] ?? null
        const running = (yield* reads.runningTurns(null))[0]
        return {
          version: yield* reads.version,
          chat: yield* reads.chat,
          count,
          node: NODE,
          block: BLOCK,
          levels,
          roots: tops.map((part) => ({ l: part.l, i: part.i, built: have.has(key(part.l, part.i)) })),
          views: [(yield* now("chat", count)).summary, (yield* now("seen", count)).summary],
          launch,
          live: launch !== null && launch.ended === null && launch.host === os.hostname() && alive(launch.pid),
          turn: running?.id ?? null,
          usage: yield* reads.usageTotals
        }
      }))

      const window = (from: number, to: number, floor = 0) =>
        reads.snapshot(Effect.gen(function*() {
          const count = yield* reads.count
          const a = Math.max(0, Math.min(count, Math.trunc(from)))
          const z = Math.max(a, Math.min(count, Math.trunc(to)))
          const top = count === 0 ? -1 : Math.floor(Math.log2(count))
          const low = Math.max(0, Math.trunc(floor), Math.ceil(Math.log2(Math.max(1, z - a) / CELLS)))
          const nodes: Array<Node> = []
          for (let l = low; l <= top && z > a; l++) {
            nodes.push(...(yield* reads.nodesIn(l, Math.floor(a / 2 ** l), Math.ceil(z / 2 ** l))))
          }
          const there = (parts: ReadonlyArray<Part>) =>
            parts.filter((part) => span(part)[0] < z && span(part)[1] >= a).map((part): [number, number] => [part.l, part.i])
          return {
            count,
            from: a,
            to: z,
            floor: low,
            top,
            nodes,
            chat: there((yield* now("chat", count)).parts),
            seen: there((yield* now("seen", count)).parts)
          }
        }))

      const node = (l: number, i: number) =>
        reads.snapshot(Effect.gen(function*() {
          const count = yield* reads.count
          const part = Number.isInteger(l) && Number.isInteger(i) && l >= 0 && l <= 30 ? partOf(count, i * 2 ** l, 2 ** l) : null
          if (part === null) {
            return null
          }
          const [first, last] = span(part)
          const built = Option.getOrNull(yield* reads.node(l, i))
          const under = halves(part)
          const lower = yield* reads.nodes(under.map((half): [number, number] => [half.l, half.i]))
          const half = (one: Part) => lower.find((row) => row.l === one.l && row.i === one.i)
          const message = l === 0 ? (yield* reads.messages(i, i + 1))[0] ?? null : null
          const [a, b] = under.map(half)
          const source = l === 0
            ? message === null ? null : message.line ?? show(message.kind, message.text)
            : a === undefined || b === undefined
            ? null
            : flat(a.text) + "\n" + flat(b.text)
          const how = built === null || source === null
            ? null
            : built.text === source
            ? "source" as const
            : bytes(source) > NODE && built.text === cut(flat(source))
            ? "cut" as const
            : "summary" as const
          const up = partOf(count, Math.floor(i / 2) * 2 ** (l + 1), 2 ** (l + 1))
          const holds = (parts: ReadonlyArray<Part>) => parts.some((one) => one.l === l && one.i === i)
          return {
            l,
            i,
            ref: ref(part),
            first,
            last,
            node: built,
            source,
            how,
            requests: (yield* reads.usage({ node: [l, i] })).reverse(),
            halves: under.map((one) => ({ l: one.l, i: one.i, built: half(one) !== undefined })),
            above: up === null ? null : { l: up.l, i: up.i, built: Option.isSome(yield* reads.node(up.l, up.i)) },
            chat: holds((yield* now("chat", count)).parts),
            seen: holds((yield* now("seen", count)).parts),
            message
          }
        }))

      const messages = (from: number, to: number) => {
        const a = Math.max(0, Math.trunc(from))
        return reads.messages(a, Math.min(Math.trunc(to), a + ROWS))
      }

      const view = (name: ViewName) =>
        reads.snapshot(Effect.gen(function*() {
          const { built, parts, summary } = yield* now(name, yield* reads.count)
          const lines = parts.map(({ i, l }) => {
            const one = built.get(key(l, i))
            return { l, i, text: one?.text ?? null, size: one?.size ?? 0 }
          })
          return {
            ...summary,
            lines,
            blocks: inBlocks(lines.flatMap((one) => (one.text === null ? [] : [line(one, one.text)])))
          }
        }))

      const turnLine = Effect.fnUntraced(function*(turn: { readonly head: string } & Omit<TurnLine, "said">) {
        const { head: _, ...rest } = turn
        const text = (yield* reads.messages(turn.firstMsg, turn.firstMsg + 1))[0]?.text ?? ""
        return { ...rest, said: text.length <= SAID ? text : text.slice(0, SAID) + "…" }
      })

      const turns = (before: number | null, limit?: number) =>
        reads.snapshot(Effect.gen(function*() {
          const out: Array<TurnLine> = []
          for (const turn of yield* reads.turns(before, within(limit))) {
            out.push(yield* turnLine(turn))
          }
          return out
        }))

      // The lines of the view in one block of a request's first item. The
      // view's last block ends with the closing tag. Null: the block is not
      // made of lines.
      const linesOf = (text: string, last: boolean): Array<Line> | null => {
        if (last && !text.endsWith("</chat>\n")) {
          return null
        }
        const inner = last ? text.slice(0, -"</chat>\n".length) : text
        const rows = inner === "<chat>\n" || inner === "" ? [] : inner.slice(0, -1).split("\n")
        const out: Array<Line> = []
        for (const row of rows) {
          const got = /^(\d+)\+(\d+)\|/.exec(row)
          const [id, n] = got === null ? [NaN, NaN] : [Number(got[1]), Number(got[2])]
          const l = Math.log2(n)
          if (got === null || !Number.isInteger(l) || id % n !== 0) {
            return null
          }
          out.push({ l, i: id / n, ref: got[1] + "+" + got[2], text: row.slice(got[0].length) })
        }
        return out
      }

      // A turn's items as kept, in order.
      const itemsOf = Effect.fnUntraced(function*(id: number) {
        const out: Array<{ readonly n: number; readonly created: number; readonly kept: Kept }> = []
        for (const row of yield* reads.turnItems(id)) {
          out.push({ n: row.n, created: row.created, kept: yield* Effect.mapError(decodeKept(row.body), broken("turnItem")) })
        }
        return out
      })

      const turn = (id: number) =>
        reads.snapshot(Effect.gen(function*() {
          const row = Option.getOrNull(yield* reads.turn(id))
          if (row === null) {
            return null
          }
          const items = yield* itemsOf(id)
          const usage = (yield* reads.usage({ turn: id })).reverse()
          const steps = items.filter((one) => one.kept.kind === "turn").length
          let step = 0
          const shown = items.map(({ created, kept, n }): ItemShown => {
            if (kept.kind === "turn") {
              step += 1
              // The k-th usage is the k-th step's, when each step has one.
              return { n, created, kind: "turn", step, output: kept.output, calls: kept.calls, usage: usage.length === steps ? usage[step - 1] ?? null : null }
            }
            if (kept.kind === "back") {
              return { n, created, kind: "back", results: kept.results }
            }
            // The first item is the view, and then the new messages in its last block.
            const view = n === 0 && kept.blocks[0]?.text === "<chat>\n" ? kept.blocks.length - 1 : 0
            return { n, created, kind: "user", blocks: kept.blocks.map((block, k) => ({ ...block, lines: k < view ? linesOf(block.text, k === view - 1) : null })) }
          })
          const last = items[items.length - 1]
          return {
            turn: yield* turnLine(row),
            head: yield* Effect.mapError(decodeHead(row.head), broken("head")),
            items: shown,
            calls: yield* reads.calls(id),
            usage,
            asked: row.status === "running" && last !== undefined && last.kept.kind !== "turn" ? items.length : null
          }
        }))

      const body = (id: number, upto: number | null) =>
        reads.snapshot(Effect.gen(function*() {
          const row = Option.getOrNull(yield* reads.turn(id))
          if (row === null) {
            return null
          }
          const items = yield* itemsOf(id)
          const n = upto === null ? items.length : Math.max(0, Math.min(items.length, Math.trunc(upto)))
          if (row.pick.vendor !== "openai") {
            return { upto: n, vendor: row.pick.vendor, body: null, error: `no wire for the vendor "${row.pick.vendor}"` }
          }
          const request = {
            session: (yield* reads.chat).uuid,
            pick: row.pick,
            head: yield* Effect.mapError(decodeHead(row.head), broken("head")),
            items: items.slice(0, n).map((one) => item(one.kept))
          }
          return yield* Effect.match(openaiBody(request), {
            onFailure: (error): Body => ({ upto: n, vendor: row.pick.vendor, body: null, error: error.message }),
            onSuccess: (made): Body => ({ upto: n, vendor: row.pick.vendor, body: made, error: null })
          })
        }))

      return Inspect.of({
        version: reads.version,
        overview,
        window,
        node,
        messages,
        view,
        turns,
        turn,
        body,
        usage: (before, limit) => reads.usage({ before: before ?? undefined, limit: within(limit) }),
        diagnostics: (limit) => reads.lastDiagnostics(within(limit)),
        launches: (limit) => reads.launches(within(limit))
      })
    })
  )
}
