// The test of two tenants (docs/schema.html, section 1, "The tenant
// boundary"): on the code's own file, no member of the store reaches a row
// of another chat. One database holds tenant A and tenant B, a chat of
// B, three chats of A (a second one made before the chat under test, the
// chat under test, and a third one made after it), a second chat of B made
// after the chat under test, and rows of each chat in every table of a
// chat, its events too, written through the store; B has more rows than A
// in each, so B has row numbers that A does not have, and so has A's third
// chat. A launch of B, one of A's second chat and one of A's third chat are
// live while every case runs, on the host of A's launch, with the number
// that A's launch takes.
//
// "Another chat" is B's chat and A's other chats alike: the test catches a
// statement that has no condition on its chat (B shows it), one that
// reaches every chat of its tenant (A's second chat shows it), one that
// takes the chats from A's on (`chat >=`: B's second chat and A's third
// show it), and one that takes the chats up to A's (`chat <=`: B's and A's
// second show it). A's third chat shows a statement on the chat's table
// that keeps its tenant and takes its tenant's chats from A's on (`id >=`
// in place of `id =`): it would give A's third chat A's `seq` and
// `updated`, or give A's read two rows, which `only` refuses.
//
// - Reads: each member of `Reading`, on A's store and on A's reads, gives
//   the same answer with B's rows there as on a file that has only A's.
// - A row number of another chat: each member that takes a row's number,
//   given on A's store a number that only B has, or that only A's second
//   chat has, finds nothing or fails, and the other chats' rows stay as
//   they were.
// - Writes: after each write member has run on A's store, every row that is
//   not of A's chat is as it was, and each call's answer and A's rows are
//   those of the same calls on a file of A alone.
// - Launches: A's store opens while the launches of B and of A's second
//   chat are live, and leaves them so; a launch of A that a crash left is
//   closed as a crash, and only it.
// - No member is left out: the members of the store, taken at run time,
//   each have a case here.
// - The database refuses: a row of A that names a row only B has, for each
//   reference inside a chat of the schema.
// - The tag: tenant A with the UUID of B's chat gets `NoChat`, as for a
//   UUID that no chat has; with the UUID of its second chat, it gets that
//   chat.
//
// The times come from a test clock, so that the two files give the same
// answers to the millisecond. Each case runs on its own copy of a file that
// is built once. The building never fails the file's `beforeAll`: each
// write's failure is kept, and a case of the file names it.

import { Database as Sqlite } from "bun:sqlite"
import { beforeAll, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, type Scope } from "effect"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import { newFile, options, rows, withChats } from "../tests/help.ts"
import { schema } from "./schema.ts"
import { Chats, type Kind, type LaunchInput, NoChat, type Pick, type Reading, Store } from "@everchat/core/store"

type StoreService = typeof Store.Service

const TENANT_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const TENANT_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"

// What a side writes: its tag in every text, its pick, its launches, and
// `k`, the number of turns (each turn brings rows to every table).
interface Side {
  readonly tenant: string
  readonly tag: string
  readonly pick: Pick
  readonly launch: LaunchInput
  readonly k: number
  readonly launches: number
}

const A: Side = {
  tenant: TENANT_A,
  tag: "a",
  pick: { vendor: "openai", model: "gpt-a", effort: "medium", speed: "slow" },
  launch: { ...options().launch, cwd: "/a", runTag: "tag-a" },
  k: 2,
  launches: 2
}

const B: Side = {
  tenant: TENANT_B,
  tag: "b",
  pick: { vendor: "anthropic", model: "model-b", effort: "high", speed: "fast" },
  launch: { ...options().launch, host: "host-b", cwd: "/b", runTag: "tag-b" },
  k: 3,
  launches: 3
}

// The second chat of tenant A: made after B's and before the chat under
// test, with its own tag, pick, launch and count of turns.
const A2: Side = {
  tenant: TENANT_A,
  tag: "c",
  pick: { vendor: "openai", model: "model-c", effort: "low", speed: "fast" },
  launch: { ...options().launch, host: "host-c", cwd: "/c", runTag: "tag-c" },
  k: 4,
  launches: 3
}

// The third chat of tenant A: made after the chat under test, with its own
// tag, pick, launch and count of turns, the most of any side, so that its
// rows go past A's in every table, and its `seq` is no other chat's.
const A3: Side = {
  tenant: TENANT_A,
  tag: "e",
  pick: { vendor: "openai", model: "model-e", effort: "high", speed: "slow" },
  launch: { ...options().launch, host: "host-e", cwd: "/e", runTag: "tag-e" },
  k: 5,
  launches: 3
}

// The second chat of tenant B: made after the chat under test, so that A's
// chat is not the last of the file.
const B2: Side = {
  tenant: TENANT_B,
  tag: "d",
  pick: { vendor: "anthropic", model: "model-d", effort: "low", speed: "slow" },
  launch: { ...options().launch, host: "host-d", cwd: "/d", runTag: "tag-d" },
  k: 2,
  launches: 1
}

// The processes of the live launches of B, of A's second chat and of A's
// third, which run (`ALIVE`), and the process of a launch of A that a crash
// left, which does not run.
const LIVE_PID = process.pid + 100_000
const DEAD_PID = process.pid + 100_001
const LIVE_PID_A2 = process.pid + 100_002
const LIVE_PID_A3 = process.pid + 100_003
const ALIVE = (pid: number) => pid === LIVE_PID || pid === LIVE_PID_A2 || pid === LIVE_PID_A3

const KINDS: ReadonlyArray<Kind> = ["user", "asst", "tool", "echo", "work", "note"]

// Runs `effect` with `Chats` over `file`, its scope closed inside the test
// clock: the launch's end has the clock's time too. The processes of the
// live launches run; no other process but this one does.
const run = <A, E>(file: string, effect: Effect.Effect<A, E, Chats | Scope.Scope>) =>
  withChats(file, Effect.scoped(effect).pipe(Effect.provide(TestClock.layer())), (pid) => pid === process.pid || ALIVE(pid))

// The 16 bytes of a UUID.
const uuidBytes = (uuid: string) => Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex"))

// A copy of a file that no connection has open, in a new home.
const copy = (file: string) => {
  const to = newFile()
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, to + suffix)
  }
  return to
}

// The schema's tables of a chat (those with a column `chat`), and each
// reference inside a chat: a foreign key (chat, x) to the parent's key
// (chat, n). Read from the schema itself, on a database in memory.
const shape = (() => {
  const db = new Sqlite(":memory:")
  try {
    for (const statement of schema) db.run(statement)
    const tables = db.query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name").all().map((row) => row.name)
    const ofChat = tables.filter((table) => db.query<{ name: string }, []>(`pragma table_info(${table})`).all().some((column) => column.name === "chat"))
    const references = ofChat.flatMap((table) => {
      const keys = db.query<{ id: number; table: string; from: string; to: string }, []>(`pragma foreign_key_list(${table})`).all()
      const ids = [...new Set(keys.map((key) => key.id))]
      return ids.flatMap((id) => {
        const parts = keys.filter((key) => key.id === id)
        const other = parts.find((key) => key.from !== "chat")
        return parts.length === 2 && parts.some((key) => key.from === "chat" && key.to === "chat") && other !== undefined
          ? [{ table, column: other.from, parent: other.table, key: other.to }]
          : []
      })
    })
    const keys = Object.fromEntries(
      ofChat.map((table) => [table, db.query<{ name: string; pk: number }, []>(`pragma table_info(${table})`).all().filter((column) => column.pk > 0).map((column) => column.name)])
    )
    // The columns of a table of a chat that name a pick: their ids depend
    // on the file (on the picks that came first), and not on the chat.
    const picks = Object.fromEntries(
      [...ofChat, "everchat_chat"].map((table) => [
        table,
        db.query<{ table: string; from: string }, []>(`pragma foreign_key_list(${table})`).all().filter((key) => key.table === "everchat_pick").map((key) => key.from)
      ])
    )
    return { ofChat, references, keys, picks }
  } finally {
    db.close()
  }
})()

// The id in a file of the chat with the UUID `uuid`.
const chatId = (file: string, uuid: string) => {
  const db = new Sqlite(file, { readonly: true })
  try {
    const row = db.query<{ id: number }, [Uint8Array]>("select id from everchat_chat where uuid = ?").get(uuidBytes(uuid))
    if (row === null) throw new Error(`no chat ${uuid}`)
    return row.id
  } finally {
    db.close()
  }
}

// Every row of the file that is not of A's chat (the UUID `a`): the rows of
// B's chats and of A's second and third chats in each table of a chat,
// their rows of `everchat_chat` (their `seq` and `updated` too), and B's
// tenant.
const notA = (file: string, a: string) => {
  const id = chatId(file, a)
  const db = new Sqlite(file, { readonly: true })
  try {
    const all = (query: string, ...params: Array<number | Uint8Array>) =>
      db.query<Record<string, unknown>, Array<number | Uint8Array>>(query).all(...params).map((row) => JSON.stringify(row, json)).sort()
    return {
      ...Object.fromEntries(shape.ofChat.map((table) => [table, all(`select * from ${table} where chat <> ?`, id)])),
      everchat_chat: all("select * from everchat_chat where id <> ?", id),
      everchat_tenant: all("select * from everchat_tenant where id <> ?", uuidBytes(TENANT_A))
    }
  } finally {
    db.close()
  }
}

// The rows of A's chat (the UUID `a`), in a form that two files share: no
// column `chat` (the chat's id depends on the chats that came first), no
// id, tenant or UUID of its row of `everchat_chat`, and a pick as its four
// texts in place of its id (which depends on the picks that came first).
const ofA = (file: string, a: string) => {
  const id = chatId(file, a)
  const db = new Sqlite(file, { readonly: true })
  try {
    const picks = new Map(
      db.query<{ id: number; vendor: string; model: string; effort: string; speed: string }, []>("select * from everchat_pick").all()
        .map((pick) => [pick.id, `${pick.vendor}/${pick.model}/${pick.effort}/${pick.speed}`])
    )
    const all = (table: string, query: string) =>
      db.query<Record<string, unknown>, [number]>(query).all(id).map((row) => {
        const { chat: _chat, ...rest } = row
        for (const column of shape.picks[table] ?? []) {
          if (typeof rest[column] === "number") rest[column] = picks.get(rest[column] as number)
        }
        return JSON.stringify(rest, json)
      }).sort()
    return {
      ...Object.fromEntries(shape.ofChat.map((table) => [table, all(table, `select * from ${table} where chat = ?`)])),
      everchat_chat: all("everchat_chat", "select pick, goal, draft, taken, seq, created, updated from everchat_chat where id = ?")
    }
  } finally {
    db.close()
  }
}

// An answer as JSON, success or failure (the failure's error, as JSON and
// as text), with A's UUID (another in each file) as a name.
const answer = (exit: Exit.Exit<unknown, unknown>, a: string) =>
  JSON.stringify(
    Exit.isSuccess(exit)
      ? { ok: exit.value }
      : { failed: JSON.stringify(Cause.squash(exit.cause), json), text: String(Cause.squash(exit.cause)) },
    json
  ).replaceAll(a, "<A's chat>")

// JSON of an answer: bytes as a list of numbers.
const json = (_key: string, value: unknown) => (value instanceof Uint8Array ? Array.from(value) : value)

// What failed in the building of the files: each write of `fill` that
// failed, and each step of `build`. A case of the file checks that nothing
// did, so that a statement that breaks the building fails a named case.
const failures: Array<string> = []

// `effect`'s value; on a failure, `otherwise`, and the failure is kept.
const tried = <A>(what: string, effect: Effect.Effect<A, unknown>, otherwise: A) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    failures.push(`${what}: ${String(Cause.squash(exit.cause))}`)
    return otherwise
  })

// The rows of one side. Each turn: an image, a turn with two items (three
// for a side with more turns than A, so that a turn of A's number has more
// items in such a chat), a program and a function it calls, three messages (the first with images),
// two rows of usage and a diagnostic, and three events, each in the
// transaction of what it reports: the turn's start, its program's call,
// and its messages accepted. Then one more turn: its start, a reply and
// its `message` event, and, in a chat with no more turns than A (A's and
// B's second), its end and its `end` event, so that A's chat has each type
// of event. Then the tree, the views and the chat's row. The other turns,
// and every call, stay running: so does each turn of B's chat and of A's
// other chats with the number of A's ended turn, and the highest turn of
// each, which A has not. Each write is tried: a failure gives the number
// that the write would have given.
const EVENTS_PER_TURN = 3
const ends = (side: Side) => side.k <= A.k
const eventsOf = (side: Side) => EVENTS_PER_TURN * side.k + 2 + (ends(side) ? 1 : 0)
const fill = (store: StoreService, side: Side) =>
  Effect.gen(function*() {
    const { k, pick, tag } = side
    const at = (what: string, t: number) => `${tag} ${what} ${t}`
    for (let t = 1; t <= k; t++) {
      const image = yield* tried(at("putImage", t), store.putImage({
        name: `${tag} image ${t}`,
        type: "image/png",
        width: t,
        height: t,
        source: t % 2 === 1 ? "person" : "tool",
        bytes: new Uint8Array([tag.charCodeAt(0), t])
      }), t)
      const firstMsg = yield* tried(at("count", t), store.count, 3 * (t - 1))
      const turn = yield* tried(
        at("startTurn", t),
        store.transaction(Effect.gen(function*() {
          const turn = yield* store.startTurn({ pick, head: `{"${tag}":${t}}`, firstMsg })
          yield* store.addEvent({ type: "start", turn: turn.id })
          return turn.id
        })),
        t
      )
      yield* tried(at("addTurnItem", t), store.addTurnItem(turn, "user", `${tag} item ${t}.0`), 0)
      yield* tried(at("addTurnItem", t), store.addTurnItem(turn, "turn", `${tag} item ${t}.1`), 1)
      if (k > A.k) yield* tried(at("addTurnItem", t), store.addTurnItem(turn, "back", `${tag} item ${t}.2`), 2)
      const program = yield* tried(
        at("startCall", t),
        store.transaction(Effect.gen(function*() {
          const call = yield* store.startCall({ turn, vendorId: `${tag} v${t}`, fn: "run", input: `${tag} program ${t}` })
          yield* store.addEvent({ type: "call", turn, call })
          return call
        })),
        2 * t - 1
      )
      const child = yield* tried(at("startCall", t), store.startCall({ turn, parent: program, fn: "read", input: `${tag} read ${t}` }), 2 * t)
      yield* tried(
        at("append", t),
        store.transaction(Effect.gen(function*() {
          const said = yield* store.append([
            { kind: "user", text: `${tag} says ${t}`, turn, images: t === 1 ? [image] : [image - 1, image] },
            { kind: "tool", text: `${tag} runs ${t}`, turn, call: program, line: `${tag} line ${t}` },
            { kind: "echo", text: `${tag} reads ${t}`, turn, call: child }
          ])
          yield* store.addEvent({ type: "accepted", msg: said[0]!.i, msgLast: said[said.length - 1]!.i })
        })),
        undefined
      )
      yield* tried(
        at("addUsage", t),
        store.addUsage({ served: "turn", turn, pick, request: `${tag} request ${t}`, input: 10 * t, cacheRead: t, cacheWrite: t, output: t }),
        undefined
      )
      yield* tried(
        at("addUsage", t),
        store.addUsage({ served: "compaction", node: [0, t - 1], pick, input: t, cacheRead: 0, cacheWrite: 0, output: t, expected: t }),
        undefined
      )
      yield* tried(at("addDiagnostics", t), store.addDiagnostics([{ level: "info", source: tag, text: `${tag} diagnostic ${t}`, created: t }]), undefined)
    }
    const last = k + 1
    const firstMsg = yield* tried(at("count", last), store.count, 3 * k)
    const turn = yield* tried(
      at("startTurn", last),
      store.transaction(Effect.gen(function*() {
        const turn = yield* store.startTurn({ pick, head: `{"${tag}":${last}}`, firstMsg })
        yield* store.addEvent({ type: "start", turn: turn.id })
        return turn.id
      })),
      last
    )
    yield* tried(
      at("append", last),
      store.transaction(Effect.gen(function*() {
        const [said] = yield* store.append([{ kind: "asst", text: `${tag} answers ${last}`, turn }])
        yield* store.addEvent({ type: "message", msg: said!.i, msgLast: said!.i })
      })),
      undefined
    )
    if (ends(side)) {
      yield* tried(
        at("endTurn", last),
        store.transaction(Effect.andThen(store.endTurn(turn, "done", `${tag} why ${last}`), store.addEvent({ type: "end", turn }))),
        0
      )
    }
    yield* tried(`${tag} putNodes`, store.putNodes([
      ...Array.from({ length: 2 * k }, (_, i) => ({ l: 0, i, text: `${tag} node 0.${i}` })),
      ...Array.from({ length: k }, (_, i) => ({ l: 1, i, text: `${tag} node 1.${i}` }))
    ]), [])
    yield* tried(`${tag} putView`, store.putView({ name: "chat", parts: [[1, 0], [0, 2]], batch: false }), undefined)
    if (k > A.k) yield* tried(`${tag} putView`, store.putView({ name: "seen", parts: [[0, 0]], batch: true }), undefined)
    yield* tried(`${tag} setGoal`, store.setGoal(`${tag} goal`), undefined)
    yield* tried(`${tag} setDraft`, store.setDraft(`${tag} draft`), undefined)
    yield* tried(`${tag} setTaken`, store.setTaken(2), undefined)
  })

// Makes the side's chat in `file`, fills it in its first launch, and takes
// its other launches. Gives the chat's UUID. A launch that fails is kept in
// `failures`.
const build = async (file: string, side: Side) => {
  const chat = await run(file, Chats.use((chats) => chats.make(side.tenant, side.pick)))
  for (let n = 1; n <= side.launches; n++) {
    const exit = await run(file, Effect.exit(Effect.gen(function*() {
      const store = yield* (yield* Chats).store(side.tenant, chat, side.launch)
      if (n === 1) yield* fill(store, side)
    })))
    if (Exit.isFailure(exit)) failures.push(`${side.tag} launch ${n}: ${String(Cause.squash(exit.cause))}`)
  }
  return chat
}

// The two files: `alone` has only A's rows; `both` has B's, made first (so
// B's chat, B's picks and B's rows come first in each key), then those of
// A's second chat, then A's, then those of A's third chat, and then those
// of B's second chat.
let alone: { readonly file: string; readonly a: string }
let both: { readonly file: string; readonly a: string; readonly a2: string; readonly a3: string; readonly b: string; readonly b2: string }

// The launches of B, of A's second chat and of A's third that stay live:
// the last of each, open again, straight in the file, on the host of A's
// launch and in a process that runs (`ALIVE`). Their number is the one that
// A's launch takes in a case (A's launches and one).
const B_LIVE = B.launches
const A2_LIVE = A2.launches
const A3_LIVE = A3.launches
const liven = (file: string, chat: string, pid: number, n: number) => {
  const db = new Sqlite(file)
  try {
    db.run("update everchat_launch set ended = null, why = null, pid = ?, host = ? where chat = ? and n = ?", [pid, A.launch.host, chatId(file, chat), n])
  } finally {
    db.close()
  }
}

// The three live launches of `file`, as they must stay.
const LIVE = () => [
  { chat: both.b, n: B_LIVE, pid: LIVE_PID, host: A.launch.host, ended: null, why: null },
  { chat: both.a2, n: A2_LIVE, pid: LIVE_PID_A2, host: A.launch.host, ended: null, why: null },
  { chat: both.a3, n: A3_LIVE, pid: LIVE_PID_A3, host: A.launch.host, ended: null, why: null }
]
const live = (file: string) =>
  ([[both.b, B_LIVE], [both.a2, A2_LIVE], [both.a3, A3_LIVE]] as const).flatMap(([chat, n]) =>
    rows<{ n: number; pid: number; host: string; ended: number | null; why: string | null }>(
      file,
      `select n, pid, host, ended, why from everchat_launch where chat = ${chatId(file, chat)} and n = ${n}`
    ).map((row) => ({ chat, ...row }))
  )

// It does not throw: what fails is kept in `failures`, for a named case.
beforeAll(async () => {
  try {
    const one = newFile()
    alone = { file: one, a: await build(one, A) }
    const two = newFile()
    const b = await build(two, B)
    const a2 = await build(two, A2)
    const a = await build(two, A)
    const a3 = await build(two, A3)
    both = { file: two, b, a2, a, a3, b2: await build(two, B2) }
    liven(two, b, LIVE_PID, B_LIVE)
    liven(two, a2, LIVE_PID_A2, A2_LIVE)
    liven(two, a3, LIVE_PID_A3, A3_LIVE)
  } catch (error) {
    failures.push(`the building: ${String(error)}`)
  }
})

// The calls of each member, run on the store (or the reads) of a chat.
type Calls = ReadonlyArray<Effect.Effect<unknown, unknown>>

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k)

// Reads
// -----

// The calls of each member of `Reading`, with numbers that A has and
// numbers that only B has.
const READS: { readonly [K in keyof Reading]: (reads: Reading) => Calls } = {
  snapshot: (r) => [r.snapshot(Effect.all([r.count, r.messages(0, 100), r.turns(null, 100), r.launches(100)]))],
  version: (r) => [r.version],
  chat: (r) => [r.chat],
  eventsAfter: (r) => [
    r.eventsAfter(0, 1000),
    r.eventsAfter(0, 1),
    r.eventsAfter(2, 3),
    r.eventsAfter(5, 1000),
    r.eventsAfter(eventsOf(A), 10),
    r.eventsAfter(1000, 1000),
    r.snapshot(Effect.all([r.chat, r.eventsAfter(0, 1000)]))
  ],
  count: (r) => [r.count],
  messages: (r) => [r.messages(0, 100), r.messages(2, 5), r.messages(5, 9)],
  messagesAfter: (r) => [r.messagesAfter(-1, KINDS), r.messagesAfter(2, ["user", "echo"]), r.messagesAfter(5, KINDS)],
  imagesOf: (r) => range(0, 9).map((i) => r.imagesOf(i)),
  node: (r) => [...range(0, 6).map((i) => r.node(0, i)), ...range(0, 3).map((i) => r.node(1, i))],
  nodes: (r) => [r.nodes([...range(0, 6).map((i): [number, number] => [0, i]), ...range(0, 3).map((i): [number, number] => [1, i])]), r.nodes([])],
  nodesIn: (r) => [r.nodesIn(0, 0, 100), r.nodesIn(1, 0, 100), r.nodesIn(0, 3, 6)],
  levels: (r) => [r.levels],
  view: (r) => [r.view("chat"), r.view("seen")],
  image: (r) => range(1, 4).map((n) => r.image(n)),
  head: (r) => range(1, 4).map((n) => r.head(n)),
  turn: (r) => range(1, 4).map((n) => r.turn(n)),
  turns: (r) => [r.turns(null, 100), r.turns(3, 100), r.turns(null, 1), r.turns(4, 1)],
  runningTurns: (r) => [r.runningTurns(null), r.runningTurns(7)],
  turnItems: (r) => range(1, 4).map((n) => r.turnItems(n)),
  calls: (r) => range(1, 4).map((n) => r.calls(n)),
  call: (r) => range(1, 7).map((n) => r.call(n)),
  usage: (r) => [
    r.usage(),
    r.usage({ turn: 1 }),
    r.usage({ turn: 3 }),
    r.usage({ node: [0, 1] }),
    r.usage({ node: [0, 2] }),
    r.usage({ before: 4 }),
    r.usage({ limit: 1 })
  ],
  usageTotals: (r) => [r.usageTotals],
  launches: (r) => [r.launches(100), r.launches(1)],
  endedRunTags: (r) => [r.endedRunTags],
  diagnostics: (r) => [r.diagnostics(), r.diagnostics(1), r.diagnostics(0, 1), r.diagnostics(2)],
  lastDiagnostics: (r) => [r.lastDiagnostics(100), r.lastDiagnostics(1)]
}

// The answers of one member on A's store and on A's reads, as JSON, with
// A's UUID (another in each file) as a name.
const answers = (file: string, a: string, member: keyof Reading) =>
  run(file, Effect.gen(function*() {
    const chats = yield* Chats
    const store = yield* chats.store(TENANT_A, a, A.launch)
    const reads = yield* chats.reads(TENANT_A, a)
    const got = { store: yield* Effect.all(READS[member](store)), reads: yield* Effect.all(READS[member](reads)) }
    return JSON.stringify(got, json).replaceAll(a, "<A's chat>")
  }))

for (const member of Object.keys(READS) as Array<keyof Reading>) {
  test(`reads: ${member} on A's store gives the same answer with B's rows there as on a file of A alone`, async () => {
    const one = await answers(copy(alone.file), alone.a, member)
    const two = await answers(copy(both.file), both.a, member)
    expect(two).toEqual(one)
    // None of the text of the other chats, nor their UUIDs, is in it.
    expect(two).not.toContain(both.b)
    expect(two).not.toContain(both.a2)
    expect(two).not.toContain(both.a3)
    expect(two).not.toContain(both.b2)
    expect(two).not.toMatch(/"[bcde] [a-z]|\{\\"[bcde]\\"|model-[bcde]|host-[bcde]|tag-[bcde]|"\/[bcde]"|[bcde] goal|[bcde] draft/)
  })
}

// A row number of B
// -----------------

// The numbers that only the other chat `other` has: the highest n of its
// in each table that A has no row with, a message's i, a node's (l, i).
const onlyOf = (file: string, other: string) => {
  const a = chatId(file, both.a)
  const b = chatId(file, other)
  const top = (table: string, column: string, more = "") => {
    const got = rows<{ n: number | null }>(
      file,
      `select max(${column}) as n from ${table} where chat = ${b} ${more} and ${column} not in (select ${column} from ${table} where chat = ${a} ${more})`
    )[0]?.n
    if (got === null || got === undefined) throw new Error(`the other chat has no ${table}.${column} that A has not`)
    return got
  }
  return {
    turn: top("everchat_turn", "n"),
    call: top("everchat_call", "n"),
    msg: top("everchat_msg", "i"),
    image: top("everchat_image", "n"),
    head: top("everchat_head", "n"),
    usage: top("everchat_usage", "n"),
    log: top("everchat_log", "n"),
    event: top("everchat_event", "n"),
    node: top("everchat_node", "i", "and l = 0"),
    node1: top("everchat_node", "i", "and l = 1")
  }
}
type OnlyB = ReturnType<typeof onlyOf>

// Each member that takes a row's number from its caller (the list O3.1 of
// the investigation, checked against the tree: the reads of a range, the
// filters of `usage` and the references of `append`, `addUsage` and
// `startCall` are numbers too). `nothing`: it gives no row (none, an empty
// list, or no value for a write). `fails`: it fails.
const ROWS: Record<string, { readonly member: keyof StoreService; readonly want: "nothing" | "fails"; readonly run: (s: StoreService, b: OnlyB) => Effect.Effect<unknown, unknown> }> = {
  "node": { member: "node", want: "nothing", run: (s, b) => s.node(0, b.node) },
  "nodes": { member: "nodes", want: "nothing", run: (s, b) => s.nodes([[0, b.node], [1, b.node1]]) },
  "nodesIn": { member: "nodesIn", want: "nothing", run: (s, b) => s.nodesIn(0, b.node, b.node + 1) },
  "image": { member: "image", want: "nothing", run: (s, b) => s.image(b.image) },
  "head": { member: "head", want: "nothing", run: (s, b) => s.head(b.head) },
  "turn": { member: "turn", want: "nothing", run: (s, b) => s.turn(b.turn) },
  "call": { member: "call", want: "nothing", run: (s, b) => s.call(b.call) },
  "calls": { member: "calls", want: "nothing", run: (s, b) => s.calls(b.turn) },
  "turnItems": { member: "turnItems", want: "nothing", run: (s, b) => s.turnItems(b.turn) },
  "imagesOf": { member: "imagesOf", want: "nothing", run: (s, b) => s.imagesOf(b.msg) },
  "messages": { member: "messages", want: "nothing", run: (s, b) => s.messages(b.msg, b.msg + 1) },
  "messagesAfter": { member: "messagesAfter", want: "nothing", run: (s, b) => s.messagesAfter(b.msg - 1, KINDS) },
  "usage of a turn": { member: "usage", want: "nothing", run: (s, b) => s.usage({ turn: b.turn }) },
  "usage of a node": { member: "usage", want: "nothing", run: (s, b) => s.usage({ node: [0, b.node] }) },
  "diagnostics after": { member: "diagnostics", want: "nothing", run: (s, b) => s.diagnostics(b.log - 1) },
  "eventsAfter": { member: "eventsAfter", want: "nothing", run: (s, b) => s.eventsAfter(b.event - 1, 1000) },
  "endTurn": { member: "endTurn", want: "nothing", run: (s, b) => s.endTurn(b.turn, "done", "by A") },
  "endCall": { member: "endCall", want: "nothing", run: (s, b) => s.endCall(b.call, { status: "done", output: "by A" }) },
  "setCallPgid": { member: "setCallPgid", want: "nothing", run: (s, b) => s.setCallPgid(b.call, 4242) },
  "addTurnItem": { member: "addTurnItem", want: "fails", run: (s, b) => s.addTurnItem(b.turn, "back", "by A") },
  "startCall with a turn": { member: "startCall", want: "fails", run: (s, b) => s.startCall({ turn: b.turn, vendorId: "by A", fn: "run", input: "by A" }) },
  "startCall with a parent": { member: "startCall", want: "fails", run: (s, b) => s.startCall({ turn: 1, parent: b.call, fn: "read", input: "by A" }) },
  "append with a turn": { member: "append", want: "fails", run: (s, b) => s.append([{ kind: "user", text: "by A", turn: b.turn }]) },
  "append with a call": { member: "append", want: "fails", run: (s, b) => s.append([{ kind: "echo", text: "by A", call: b.call }]) },
  "append with an image": { member: "append", want: "fails", run: (s, b) => s.append([{ kind: "user", text: "by A", images: [b.image] }]) },
  "addEvent with a turn": { member: "addEvent", want: "fails", run: (s, b) => s.addEvent({ type: "start", turn: b.turn }) },
  "addEvent with a call": { member: "addEvent", want: "fails", run: (s, b) => s.addEvent({ type: "call", turn: 1, call: b.call }) },
  "addEvent with a message": { member: "addEvent", want: "fails", run: (s, b) => s.addEvent({ type: "message", msg: b.msg, msgLast: b.msg }) },
  "addEvent of accepted with A's first message and a last message": {
    member: "addEvent",
    want: "fails",
    run: (s, b) => s.addEvent({ type: "accepted", msg: 0, msgLast: b.msg })
  },
  "addEvent of a message with A's first message and a last message": {
    member: "addEvent",
    want: "fails",
    run: (s, b) => s.addEvent({ type: "message", msg: 0, msgLast: b.msg })
  },
  "addUsage with a turn": {
    member: "addUsage",
    want: "fails",
    run: (s, b) => s.addUsage({ served: "turn", turn: b.turn, pick: A.pick, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
  }
}

const nothing = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.length === 0) || (Option.isOption(value) && Option.isNone(value))

// The other chats: B's (of another tenant), and A's second and third (of
// A's tenant, made before A's chat and after it).
const OTHERS = { "B": () => both.b, "A's second chat": () => both.a2, "A's third chat": () => both.a3 } as const

for (const [other, uuid] of Object.entries(OTHERS)) {
  for (const [name, { run: call, want }] of Object.entries(ROWS)) {
    test(`a row number of ${other}: ${name} on A's store ${want === "fails" ? "fails and writes nothing" : "finds nothing"}, and the other chats' rows stay as they were`, async () => {
      const file = copy(both.file)
      const b = onlyOf(file, uuid())
      const before = notA(file, both.a)
      // A's rows but its launches, which the opening of its store changes.
      const mine = () => ({ ...ofA(file, both.a), everchat_launch: null })
      const own = mine()
      const exit = await run(file, Effect.gen(function*() {
        const store = yield* (yield* Chats).store(TENANT_A, both.a, A.launch)
        return yield* Effect.exit(call(store, b))
      }))
      if (want === "fails") {
        expect(Exit.isFailure(exit)).toBe(true)
        expect(mine()).toEqual(own)
      } else expect(Exit.isSuccess(exit) && nothing(exit.value)).toBe(true)
      expect(notA(file, both.a)).toEqual(before)
    })
  }
}

// Writes
// ------

type Write = Exclude<keyof StoreService, keyof Reading>

// The calls of each write member, with A's numbers, which the other chats
// have too, and with the names and the texts of the rows of the other
// chats: of those made before A's (B's, A's second) and after it (A's
// third, B's second).
const WRITES: { readonly [K in Write]: (s: StoreService) => Calls } = {
  launch: (s) => [Effect.sync(() => s.launch)],
  transaction: (s) => [
    s.transaction(Effect.all([s.setGoal("in a transaction"), s.append([{ kind: "note", text: "in a transaction", turn: 1 }])])),
    Effect.flip(s.transaction(Effect.andThen(s.setDraft("taken back"), Effect.fail("no"))))
  ],
  setPick: (s) => [s.setPick(B.pick)],
  setGoal: (s) => [s.setGoal("a new goal"), s.setGoal(null)],
  setDraft: (s) => [s.setDraft("a new draft"), s.setDraft(null)],
  setTaken: (s) => [s.setTaken(5)],
  append: (s) => [
    s.append([
      { kind: "user", text: "a new message", turn: 1, images: [1, 2] },
      { kind: "echo", text: "a new echo", turn: 2, call: 2 }
    ])
  ],
  putNodes: (s) => [s.putNodes([{ l: 0, i: 4, text: "a new 0.4" }, { l: 0, i: 5, text: "a new 0.5" }, { l: 1, i: 2, text: "a new 1.2" }, { l: 2, i: 0, text: "a new 2.0" }])],
  putView: (s) => [s.putView({ name: "chat", parts: [[2, 0]], batch: true }), s.putView({ name: "seen", parts: [[1, 1]], batch: false })],
  putImage: (s) => [
    s.putImage({ name: "b image 3", type: "image/png", width: 9, height: 9, source: "tool", bytes: new Uint8Array([9]) }),
    s.putImage({ name: "b image 1", type: "image/png", width: 9, height: 9, source: "tool", bytes: new Uint8Array([9]) }),
    s.putImage({ name: "c image 4", type: "image/png", width: 8, height: 8, source: "person", bytes: new Uint8Array([8]) }),
    s.putImage({ name: "c image 1", type: "image/png", width: 8, height: 8, source: "person", bytes: new Uint8Array([8]) }),
    s.putImage({ name: "e image 5", type: "image/png", width: 7, height: 7, source: "tool", bytes: new Uint8Array([7]) }),
    s.putImage({ name: "d image 2", type: "image/png", width: 6, height: 6, source: "person", bytes: new Uint8Array([6]) })
  ],
  putHead: (s) => [
    s.putHead("{\"b\":3}"),
    s.putHead("{\"b\":1}"),
    s.putHead("{\"c\":4}"),
    s.putHead("{\"c\":1}"),
    s.putHead("{\"e\":5}"),
    s.putHead("{\"d\":2}")
  ],
  addUsage: (s) => [
    s.addUsage({ served: "turn", turn: 1, pick: A.pick, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }),
    s.addUsage({ served: "compaction", node: [0, 2], pick: B.pick, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
  ],
  startTurn: (s) => [
    s.startTurn({ pick: A.pick, head: "{\"b\":3}", firstMsg: 6 }),
    s.startTurn({ pick: B.pick, head: "{\"b\":1}", firstMsg: 6 }),
    s.startTurn({ pick: A2.pick, head: "{\"c\":4}", firstMsg: 6 }),
    s.startTurn({ pick: A.pick, head: "{\"c\":1}", firstMsg: 6 })
  ],
  endTurn: (s) => [s.endTurn(1, "done"), s.endTurn(2, "failed", "by A")],
  addTurnItem: (s) => [s.addTurnItem(1, "back", "a new item"), s.addTurnItem(2, "user", "a new item")],
  startCall: (s) => [
    s.startCall({ turn: 1, vendorId: "b v1", fn: "run", input: "a new program" }),
    s.startCall({ turn: 2, parent: 1, fn: "read", input: "a new function" })
  ],
  endCall: (s) => [s.endCall(1, { status: "done", output: "by A" }), s.endCall(2, { status: "cut", output: "by A", shown: 1 })],
  setCallPgid: (s) => [s.setCallPgid(3, 4242), s.setCallPgid(4, 4343)],
  addEvent: (s) => [
    s.addEvent({ type: "start", turn: 1 }),
    s.addEvent({ type: "call", turn: 2, call: 3 }),
    s.addEvent({ type: "message", msg: 4, msgLast: 4 }),
    s.addEvent({ type: "accepted", msg: 0, msgLast: 5 }),
    s.transaction(Effect.andThen(s.endTurn(2, "done"), s.addEvent({ type: "end", turn: 2 }))),
    Effect.flip(s.transaction(Effect.andThen(s.addEvent({ type: "end", turn: 1 }), Effect.fail("no"))))
  ],
  addDiagnostics: (s) => [s.addDiagnostics([{ level: "warn", source: "a", text: "a new line", created: 1 }, { level: "error", source: "a", text: "another", created: 2 }])],
  dropDiagnostics: (s) => [s.dropDiagnostics(Number.MAX_SAFE_INTEGER)]
}

// Runs the calls of `member` on A's store in `file`, each to its end: its
// answers, and A's rows after the scope has closed.
const written = async (file: string, a: string, member: Write) => {
  const answers = await run(file, Effect.gen(function*() {
    const store = yield* (yield* Chats).store(TENANT_A, a, A.launch)
    return (yield* Effect.forEach(WRITES[member](store), Effect.exit)).map((exit) => answer(exit, a))
  }))
  return { answers, rows: ofA(file, a) }
}

for (const member of Object.keys(WRITES) as Array<Write>) {
  test(`writes: ${member} on A's store gives the answers and A's rows of a file of A alone, and leaves every row that is not A's as it was`, async () => {
    const file = copy(both.file)
    const before = notA(file, both.a)
    const two = await written(file, both.a, member)
    expect(notA(file, both.a)).toEqual(before)
    // The live launches of B and of A's other chats are still live.
    expect(live(file)).toEqual(LIVE())
    const one = await written(copy(alone.file), alone.a, member)
    expect(two).toEqual(one)
  })
}

// Launches
// --------

test("launches: A's store opens while a launch of B, one of A's second chat and one of its third, with the same number, are live on A's host, and leaves them live", async () => {
  const file = copy(both.file)
  const before = notA(file, both.a)
  expect(live(file)).toEqual(LIVE())
  const launch = await run(file, Effect.gen(function*() {
    const store = yield* (yield* Chats).store(TENANT_A, both.a, A.launch)
    return store.launch.id
  }))
  // The same number as the live launches.
  expect([launch, launch, launch]).toEqual([B_LIVE, A2_LIVE, A3_LIVE])
  expect(live(file)).toEqual(LIVE())
  expect(notA(file, both.a)).toEqual(before)
  // A's launch ended with its scope.
  expect(rows(file, `select why from everchat_launch where chat = ${chatId(file, both.a)} and n = ${launch}`)).toEqual([{ why: "exit" }])
})

// Leaves A's last launch open in `file`, as a crash does: its process
// (`DEAD_PID`, on A's host) no longer runs.
const abandon = (file: string, a: string) => {
  const db = new Sqlite(file)
  try {
    db.run("update everchat_launch set ended = null, why = null, pid = ? where chat = ? and n = ?", [DEAD_PID, chatId(file, a), A.launches])
  } finally {
    db.close()
  }
}

// A's store opened on `file` after `abandon`: its launch and launches, and
// A's rows after.
const recovered = async (file: string, a: string) => {
  abandon(file, a)
  const answers = await run(file, Effect.gen(function*() {
    const store = yield* (yield* Chats).store(TENANT_A, a, A.launch)
    return answer(Exit.succeed({ launch: store.launch, launches: yield* store.launches(10) }), a)
  }))
  return { answers, rows: ofA(file, a) }
}

test("launches: a launch of A that a crash left is closed as a crash, and only it; the launches of B and of A's other chats with its number stay as they were", async () => {
  const file = copy(both.file)
  // B and A's second and third chats each have a launch with the number of
  // A's abandoned one.
  for (const other of [both.b, both.a2, both.a3]) {
    expect(rows(file, `select n from everchat_launch where chat = ${chatId(file, other)} and n = ${A.launches}`)).toHaveLength(1)
  }
  abandon(file, both.a)
  const before = notA(file, both.a)
  const two = await recovered(file, both.a)
  expect(notA(file, both.a)).toEqual(before)
  expect(rows(file, `select n, why from everchat_launch where chat = ${chatId(file, both.a)} order by n`)).toEqual([
    { n: 1, why: "exit" },
    { n: 2, why: "crash" },
    { n: 3, why: "exit" }
  ])
  expect(live(file)).toEqual(LIVE())
  const one = await recovered(copy(alone.file), alone.a)
  expect(two).toEqual(one)
})

// No member is left out
// ---------------------

test("no member is left out: each member of the store and of the reads, taken at run time, has a case here", async () => {
  const file = copy(both.file)
  const members = await run(file, Effect.gen(function*() {
    const chats = yield* Chats
    const store = yield* chats.store(TENANT_A, both.a, A.launch)
    const reads = yield* chats.reads(TENANT_A, both.a)
    return { store: Object.keys(store).sort(), reads: Object.keys(reads).sort(), chats: Object.keys(chats).sort() }
  }))
  const cased = new Set([...Object.keys(READS), ...Object.keys(WRITES)])
  expect(members.store.filter((member) => !cased.has(member))).toEqual([])
  expect(members.reads.filter((member) => !(member in READS))).toEqual([])
  // Each member of the reads is a member of the store.
  expect(members.reads.filter((member) => !members.store.includes(member))).toEqual([])
  // The members that take a row's number: each case names a member.
  expect(Object.values(ROWS).map((row) => row.member).filter((member) => !members.store.includes(member))).toEqual([])
  // The tag's members: `make` builds the file, `store` and `reads` have
  // the test of the tag (below), and each case above.
  expect(members.chats).toEqual(["make", "reads", "store"])
})

// The file
// --------

test("the file: the building of both files wrote every row it was asked to", () => {
  expect(failures).toEqual([])
})

test("the file: each chat's events, written through the store, run from 1 to their count with no gap, and its seq is that count", () => {
  const sides: ReadonlyArray<readonly [string, string, Side]> = [
    [alone.file, alone.a, A],
    [both.file, both.b, B],
    [both.file, both.a2, A2],
    [both.file, both.a, A],
    [both.file, both.a3, A3],
    [both.file, both.b2, B2]
  ]
  for (const [file, chat, side] of sides) {
    const id = chatId(file, chat)
    const count = eventsOf(side)
    const events = rows<{ n: number }>(file, `select n from everchat_event where chat = ${id} order by n`).map((row) => row.n)
    const [seq] = rows<{ seq: number }>(file, `select seq from everchat_chat where id = ${id}`)
    expect({ chat: side.tag, events, seq: seq?.seq }).toEqual({ chat: side.tag, events: range(1, count), seq: count })
  }
})

test("the file: B and A's third chat have more rows than A in every table of a chat; A's second chat and B's second have rows in each; each chat's seq is its own; the launches of B and of A's other chats are live", () => {
  const a = chatId(both.file, both.a)
  const b = chatId(both.file, both.b)
  const a2 = chatId(both.file, both.a2)
  const a3 = chatId(both.file, both.a3)
  const b2 = chatId(both.file, both.b2)
  // Five chats: A's second made after B's and before A's, A's third after
  // A's, B's second after A's third.
  expect(rows(both.file, "select id, lower(hex(tenant)) as tenant from everchat_chat order by id")).toEqual([
    { id: b, tenant: TENANT_B.replaceAll("-", "") },
    { id: a2, tenant: TENANT_A.replaceAll("-", "") },
    { id: a, tenant: TENANT_A.replaceAll("-", "") },
    { id: a3, tenant: TENANT_A.replaceAll("-", "") },
    { id: b2, tenant: TENANT_B.replaceAll("-", "") }
  ])
  expect(b < a2 && a2 < a && a < a3 && a3 < b2).toBe(true)
  // A's third chat's seq is no other chat's: a write of A's seq to it shows.
  const seqs = rows<{ id: number; seq: number }>(both.file, "select id, seq from everchat_chat")
  expect(seqs.filter((row) => row.id !== a3 && row.seq === seqs.find((other) => other.id === a3)!.seq)).toEqual([])
  for (const table of shape.ofChat) {
    for (const [tag, id] of [["c", a2], ["e", a3], ["d", b2]] as const) {
      expect({ table, tag, some: rows<{ n: number }>(both.file, `select count(*) as n from ${table} where chat = ${id}`)[0]!.n > 0 }).toEqual({ table, tag, some: true })
    }
  }
  expect(rows(both.file, `select n, pid, host, ended from everchat_launch where chat = ${b} and ended is null`)).toEqual([
    { n: B_LIVE, pid: LIVE_PID, host: A.launch.host, ended: null }
  ])
  expect(rows(both.file, `select n, pid, host, ended from everchat_launch where chat = ${a2} and ended is null`)).toEqual([
    { n: A2_LIVE, pid: LIVE_PID_A2, host: A.launch.host, ended: null }
  ])
  expect(rows(both.file, `select n, pid, host, ended from everchat_launch where chat = ${a3} and ended is null`)).toEqual([
    { n: A3_LIVE, pid: LIVE_PID_A3, host: A.launch.host, ended: null }
  ])
  expect(live(both.file)).toEqual(LIVE())
  expect(shape.ofChat.length).toBeGreaterThan(10)
  for (const table of shape.ofChat) {
    const [counts] = rows<{ a: number; b: number; a3: number }>(
      both.file,
      `select sum(chat = ${a}) as a, sum(chat = ${b}) as b, sum(chat = ${a3}) as a3 from ${table}`
    )
    expect({ table, more: counts!.b > counts!.a, past: counts!.a3 > counts!.a, some: counts!.a > 0 }).toEqual({ table, more: true, past: true, some: true })
  }
  // The file of A alone has A's rows and no other chat.
  expect(rows(alone.file, "select count(*) as n from everchat_chat")).toEqual([{ n: 1 }])
})

// The database refuses
// --------------------

for (const { column, key, parent, table } of shape.references) {
  test(`the database refuses: a row of A in ${table} whose (chat, ${column}) names a row of ${parent} that only B has; A's own row passes`, () => {
    const file = copy(both.file)
    const a = chatId(file, both.a)
    const b = chatId(file, both.b)
    const db = new Sqlite(file)
    try {
      // As the store's connection does (database.ts).
      db.run("pragma foreign_keys = on")
      const values = (query: string) => db.query<{ v: number | null }, []>(query).all().map((row) => row.v)
      const own = values(`select min(${key}) as v from ${parent} where chat = ${a}`)[0]
      const theirs = values(`select max(${key}) as v from ${parent} where chat = ${b} and ${key} not in (select ${key} from ${parent} where chat = ${a})`)[0]
      expect(own ?? null).not.toBeNull()
      expect(theirs ?? null).not.toBeNull()
      // A row of A to copy: for a call, a function's row (it has a parent
      // and no vendor's id, so no unique key holds it).
      const template = db.query<Record<string, unknown>, []>(
        `select * from ${table} where chat = ${a} ${table === "everchat_call" ? "and parent is not null" : ""} limit 1`
      ).get()
      expect(template).not.toBeNull()
      const insert = (value: number) => {
        const row: Record<string, unknown> = { ...template, [column]: value }
        // A new key: each column of the key that is not a reference keeps
        // no value of a row that is there.
        const refs = shape.references.filter((ref) => ref.table === table).map((ref) => ref.column)
        for (const part of shape.keys[table] ?? []) {
          if (part !== "chat" && !refs.includes(part)) row[part] = (values(`select max(${part}) as v from ${table}`)[0] ?? 0) + 1000
        }
        // An event's messages: the other one is A's own, so that only the
        // reference under test can refuse the row (and msg_last >= msg).
        if (table === "everchat_event" && column === "msg") row["msg_last"] = value
        if (table === "everchat_event" && column === "msg_last") row["msg"] = own
        delete row["live"]
        const names = Object.keys(row)
        db.run(`insert into ${table} (${names.join(", ")}) values (${names.map(() => "?").join(", ")})`, names.map((name) => row[name]) as Array<never>)
      }
      expect(() => insert(theirs!)).toThrow(/FOREIGN KEY constraint failed/)
      insert(own!)
    } finally {
      db.close()
    }
  })
}

test("the database refuses: the schema has each reference inside a chat that the store writes", () => {
  expect(shape.references.map((ref) => `${ref.table}.${ref.column}`).sort()).toEqual([
    "everchat_call.launch",
    "everchat_call.parent",
    "everchat_call.turn",
    "everchat_event.call",
    "everchat_event.msg",
    "everchat_event.msg_last",
    "everchat_event.turn",
    "everchat_log.launch",
    "everchat_msg.call",
    "everchat_msg.launch",
    "everchat_msg.turn",
    "everchat_msg_image.image",
    "everchat_msg_image.msg",
    "everchat_turn.head",
    "everchat_turn.launch",
    "everchat_turn_item.turn",
    "everchat_usage.turn"
  ])
})

// The tag
// -------

test("the tag: tenant A with the UUID of B's chat gets NoChat, as for a UUID that no chat has, and B's rows stay as they were", async () => {
  const file = copy(both.file)
  const before = notA(file, both.a)
  const launches = rows(file, "select chat, n, ended, why from everchat_launch order by chat, n")
  const failures = await run(file, Effect.gen(function*() {
    const chats = yield* Chats
    const none = crypto.randomUUID()
    return {
      theirs: [yield* Effect.flip(chats.store(TENANT_A, both.b, A.launch)), yield* Effect.flip(chats.reads(TENANT_A, both.b))],
      none: [yield* Effect.flip(chats.store(TENANT_A, none, A.launch)), yield* Effect.flip(chats.reads(TENANT_A, none))]
    }
  }))
  const seen = (error: unknown) => ({
    isNoChat: error instanceof NoChat,
    keys: Object.keys(error as object),
    json: JSON.stringify(error),
    text: String(error)
  })
  for (const error of [...failures.theirs, ...failures.none]) {
    expect(seen(error)).toEqual({
      isNoChat: true,
      keys: ["_tag"],
      json: "{\"_tag\":\"NoChat\"}",
      text: "NoChat: This tenant has no chat with this UUID."
    })
  }
  expect(failures.theirs.map(seen)).toEqual(failures.none.map(seen))
  expect(notA(file, both.a)).toEqual(before)
  // No launch was taken, of either chat.
  expect(rows(file, "select chat, n, ended, why from everchat_launch order by chat, n")).toEqual(launches)
})


test("the tag: tenant A with the UUID of its second chat gets that chat and not the first, by the store and by the reads", async () => {
  const file = copy(both.file)
  const got = await run(file, Effect.gen(function*() {
    const chats = yield* Chats
    const store = yield* chats.store(TENANT_A, both.a2, A2.launch)
    const reads = yield* chats.reads(TENANT_A, both.a2)
    const one = yield* chats.reads(TENANT_A, both.a)
    return {
      store: { chat: yield* store.chat, messages: (yield* store.messages(0, 100)).map((message) => message.text), launch: store.launch.id },
      reads: { chat: yield* reads.chat, messages: (yield* reads.messages(0, 100)).map((message) => message.text) },
      first: (yield* one.chat).uuid
    }
  }))
  for (const side of [got.store, got.reads]) {
    expect(side.chat).toMatchObject({ uuid: both.a2, goal: "c goal", draft: "c draft", pick: A2.pick })
    expect(side.messages).toHaveLength(3 * A2.k + 1)
    expect(side.messages.every((text) => text.startsWith("c "))).toBe(true)
  }
  expect(got.store.launch).toBe(A2.launches + 1)
  expect(got.first).toBe(both.a)
  expect(got.first).not.toBe(both.a2)
})
