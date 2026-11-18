// The store's cases, part 1 (packages/sqlite/AGENTS.md, "The contract's
// suites"): the launch, the file's tenant and its chat, the chat's row, the
// log, the tree and the views, one event in one transaction, the images,
// the heads and the usage, a restart, the approvals, the answer and its
// run, the wake-ups, the fire's members, the settle, the stops and the
// switch, and a turn's ceiling. `storeCases1(h)` registers its cases for
// the store of the harness `h`; SQLite's store.test.ts runs it, and keeps
// the cases that need SQLite itself (the reads over a file, the probe of a
// live owner, a trigger's refusal). The helpers that the test file's own
// cases use too are exported here: one text of each.

import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  ANSWER_MAX,
  type Answered,
  type Message,
  type Part,
  Store,
  StoreError,
  type UnsettledWake,
  WAIT,
  WAKE_FAILURES,
  WAKE_TEXT_MAX,
  type Wake,
  WHO_MAX
} from "@everchat/core/store"
import { type Harness, options, PICK } from "./harness.ts"

// The harness of the store under test: `storeCases1` sets it, before it
// registers a case.
let h: Harness

export const launches = (file: string) =>
  h.rows<{ id: number; pid: number; ended: number | null; why: string | null }>(
    file,
    "select n as id, pid, ended is not null as ended, why from everchat_launch order by n"
  )

// Leaves a launch open in the file, as a crash does: the file's chat with
// one launch, of the process `pid` of `host`, that did not end.
export const crash = async (file: string, pid: number, host = "test-host") => {
  await h.withStore(file, Effect.void)
  await h.write(file, "update everchat_launch set pid = ?, host = ?, run_tag = 'old', created = 1, ended = null, why = null", [pid, host])
}

// The counts of the tenants and the chats in `file`, and their ids.
export const owners = async (file: string) => ({
  tenants: await h.rows<{ id: string }>(file, "select hex(id) as id from everchat_tenant"),
  chats: await h.rows<{ id: number; tenant: string; uuid: string }>(file, "select id, hex(tenant) as tenant, hex(uuid) as uuid from everchat_chat")
})

class Stop extends Schema.TaggedError<Stop>()("Stop", {}) {}

// A turn with a program and three of its functions (`send` twice and
// `read`), all running; a second program with one function. Gives their ids.
export const calls = (store: typeof Store.Service) =>
  Effect.gen(function*() {
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const program = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "await send(1)" })
    const send = yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: "{\"to\":\"x\",\"text\":\"hi\"}" })
    const again = yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: "{\"to\":\"y\"}" })
    const read = yield* store.startCall({ turn: turn.id, parent: program, fn: "read", input: "{\"path\":\"a\"}" })
    const other = yield* store.startCall({ turn: turn.id, vendorId: "call_2", fn: "run", input: "await send(2)" })
    const late = yield* store.startCall({ turn: turn.id, parent: other, fn: "send", input: "{\"to\":\"z\"}" })
    return { turn: turn.id, program, send, again, read, other, late }
  })

const callRow = (file: string, n: number) =>
  h.rows(file, `select status, output, size, shown, ended is not null as ended from everchat_call where chat = 1 and n = ${n}`)

const approvalCount = async (file: string) => (await h.rows<{ n: number }>(file, "select count(*) as n from everchat_approval"))[0]!.n

// Runs `effect` with the store over `file`, on a test clock that the effect
// sets (`TestClock.setTime`): the store's members read their time from it.
export const withClock = <A, E>(file: string, effect: Effect.Effect<A, E, Store | TestClock.TestClock>) =>
  h.withStore(file, effect.pipe(Effect.provide(TestClock.layer())))

// One program of a turn with `count` functions, all running. Gives their
// ids, in order.
export const functions = (store: typeof Store.Service, count: number) =>
  Effect.gen(function*() {
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const program = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "await all()" })
    const ids: Array<number> = []
    for (let k = 1; k <= count; k++) ids.push(yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: `{"k":${k}}` }))
    return ids
  })

// The row of an answer, or null for `none`.
const rowOf = (answered: Answered) => (answered._tag === "none" ? null : answered.approval)

// The approval's row as the file has it.
const approvalRow = async (file: string, n: number) =>
  (await h.rows(file, `select status, who, answer, answered, output, ended, msg, updated from everchat_approval where chat = 1 and n = ${n}`))[0]

// A wake-up's row as the file has it.
const wakeRow = async (file: string, n: number) =>
  (await h.rows(file, `select chat, n, text, cron, at, zone, first, turn, call, due, slot, pending, missed, fired, last_turn, settled, failed, stopped, why, stop_call, created, updated from everchat_wake where chat = 1 and n = ${n}`))[0]

const wakeCount = async (file: string) => (await h.rows<{ n: number }>(file, "select count(*) as n from everchat_wake"))[0]!.n

// A routine and a reminder in Berlin, as the wake-ups' package gives them.
export const ROUTINE = { text: "stand up", cron: "0 9 * * 1-5", zone: "Europe/Berlin", first: 1_800_000_000_000 }
export const REMINDER = { text: "call back", at: 1_800_000_600_000, zone: "Europe/Berlin", first: 1_800_000_600_000 }

// Slots: a time in 2027, and an hour.
export const T0 = 1_800_000_000_000
export const H = 3_600_000

// The chat's switch of its wake-ups, by plain SQL, so that the cases of the
// fire's members do not rest on `setWakeups` (its own cases are below).
export const switchBySql = (file: string, on: boolean, chat = 1) => h.write(file, "update everchat_chat set wakeups = ? where id = ?", [on ? 1 : 0, chat])

// The count of a fire's end, by plain SQL, as `settleWake` counts the end
// `kept`: `settled` 1, `updated` the time given; so that the cases of the
// fire's members do not rest on `settleWake` (its own cases are below).
export const settleBySql = (file: string, n: number, at: number, chat = 1) =>
  h.write(file, "update everchat_wake set settled = 1, updated = ? where chat = ? and n = ? and settled = 0", [at, chat, n])

// A fire as an offer writes it: the turn's row, then the fire, in one
// transaction. Gives the turn's id.
export const fire = (store: typeof Store.Service, n: number, read: { readonly pending: number; readonly missed: number }) =>
  store.transaction(Effect.gen(function*() {
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    yield* store.fireWake(n, turn.id, read)
    return turn.id
  }))

// One wake-up's row, by the store.
export const wakeOf = (store: typeof Store.Service, n: number) => Effect.map(store.wakes(), (all) => all.find((wake) => wake.id === n))

// A row as `makeWake` gives it, with what is given over it.
export const made = (one: { readonly _tag: string; readonly wake?: Wake }) => {
  if (one._tag !== "made" || one.wake === undefined) throw new Error(`not made: ${one._tag}`)
  return one.wake
}

// A slot `slot` of the wake-up `n` comes (`pendWake`, the next slot an hour
// on) and fires, as an offer writes it: gives the turn that the fire
// started. The row's end is not counted yet.
export const fireSlot = (store: typeof Store.Service, n: number, slot: number) =>
  Effect.andThen(store.pendWake(n, { pending: slot, missed: 0, due: slot + H }), fire(store, n, { pending: slot, missed: 0 }))

// The why of a turn that its ceiling stopped, as the turn loop will write it
// (docs/wakeups.md, section 6).
export const CEILING_WHY = "Stopped: this wake-up's turn reached its ceiling of steps or tokens."

// What a row of `unsettledWakes` says.
export const unsettledOf = (rows: ReadonlyArray<UnsettledWake>) => rows.map((row) => [row.wake.id, row.wake.lastTurn, row.status, row.why, row.wake.failed])

export const storeCases1 = (harness: Harness) => {
  h = harness

  // The launch
  // ----------

  test("the first launch makes the chat's row, and the next launch keeps it", async () => {
    const file = h.newFile()
    const first = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      return { launch: store.launch, chat: yield* store.chat }
    }))
    expect(first.launch.id).toBe(1)
    expect(first.chat.pick).toEqual(PICK)
    expect(first.chat.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.chat).toMatchObject({ goal: null, draft: null, taken: -1 })

    const other = { vendor: "anthropic", model: "other", effort: "low", speed: "slow" }
    const second = await h.withStore(
      file,
      Effect.gen(function*() {
        const store = yield* Store
        return { launch: store.launch, chat: yield* store.chat }
      }),
      { ...options(), pick: other }
    )
    expect(second.launch.id).toBe(2)
    // The pick of a new chat is used once. The chat's id never changes.
    expect(second.chat.pick).toEqual(PICK)
    expect(second.chat.uuid).toBe(first.chat.uuid)
    expect(await launches(file)).toEqual([
      { id: 1, pid: process.pid, ended: 1, why: "exit" },
      { id: 2, pid: process.pid, ended: 1, why: "exit" }
    ])
  })

  test("a launch records its pick from the command line", async () => {
    const file = h.newFile()
    const pick = { vendor: "openai", model: "big", effort: "high", speed: "fast" }
    const launch = await h.withStore(file, Store.useSync((store) => store.launch), options({ pick }))
    expect(launch.pick).toEqual(pick)
    expect(await h.rows(file, "select p.model from everchat_launch l join everchat_pick p on p.id = l.pick where l.chat = 1")).toEqual([{ model: "big" }])
  })

  test("a launch that fails ends with why = error, and one that is interrupted with why = signal", async () => {
    const file = h.newFile()
    // The run's promise: rejected, as `Effect.runPromise` gives a failure
    // and an interruption.
    const outcome = (run: Promise<unknown>) => run.then(() => "resolved", () => "rejected")
    const failed = await outcome(h.withStore(file, Effect.fail("boom"), options()))
    expect(failed).toBe("rejected")
    const interrupted = await outcome(h.withStore(file, Effect.interrupt, options()))
    expect(interrupted).toBe("rejected")
    expect((await launches(file)).map((launch) => launch.why)).toEqual(["error", "signal"])
  })

  test("a start closes the launch that a crash left open", async () => {
    const file = h.newFile()
    await crash(file, 4242)
    expect(await launches(file)).toEqual([{ id: 1, pid: 4242, ended: 0, why: null }])
    const launch = await h.withStore(file, Store.useSync((store) => store.launch), options(), () => false)
    expect(launch.id).toBe(2)
    expect(await launches(file)).toEqual([
      { id: 1, pid: 4242, ended: 1, why: "crash" },
      { id: 2, pid: process.pid, ended: 1, why: "exit" }
    ])
  })

  test("an open launch with our own pid, or of another host, is a crash", async () => {
    const start = (file: string) => h.withStore(file, Store.useSync((store) => store.launch.id), options(), () => true)

    const reused = h.newFile()
    await crash(reused, process.pid)
    expect(await start(reused)).toBe(2)
    expect((await launches(reused))[0]).toMatchObject({ why: "crash" })

    const moved = h.newFile()
    await crash(moved, 4242, "another-host")
    expect(await start(moved)).toBe(2)
    expect((await launches(moved))[0]).toMatchObject({ why: "crash" })
  })

  // The file's tenant and its chat
  // -------------------------------

  test("the first launch makes one tenant and one chat, and the second launch makes none", async () => {
    const file = h.newFile()
    await h.withStore(file, Effect.void)
    const first = await owners(file)
    expect([first.tenants.length, first.chats.length]).toEqual([1, 1])
    expect(first.chats[0]!.tenant).toBe(first.tenants[0]!.id)
    await h.withStore(file, Effect.void)
    expect(await owners(file)).toEqual(first)
    expect((await launches(file)).map((launch) => launch.id)).toEqual([1, 2])
  })

  test("each table's first row of the chat has n 1 and the next 2; a message's i, a turn's item and a message's image start at 0", async () => {
    const file = h.newFile()
    await h.withStore(file, Effect.void)
    await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const a = yield* store.putImage({ name: "a.png", type: "image/png", width: 1, height: 1, source: "person", bytes: new Uint8Array([1]) })
      const b = yield* store.putImage({ name: "b.png", type: "image/png", width: 1, height: 1, source: "person", bytes: new Uint8Array([2]) })
      expect([a, b]).toEqual([1, 2])
      const messages = yield* store.append([{ kind: "user", text: "one", images: [a, b] }, { kind: "user", text: "two" }])
      expect(messages.map((message) => message.i)).toEqual([0, 1])
      expect([yield* store.putHead("{}"), yield* store.putHead("[]")]).toEqual([1, 2])
      const first = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const second = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 1 })
      expect([first.id, second.id]).toEqual([1, 2])
      expect([yield* store.addTurnItem(first.id, "user", "{}"), yield* store.addTurnItem(first.id, "turn", "{}")]).toEqual([0, 1])
      expect(yield* store.addTurnItem(second.id, "user", "{}")).toBe(0)
      const program = yield* store.startCall({ turn: first.id, vendorId: "call_1", fn: "run", input: "x" })
      expect([program, yield* store.startCall({ turn: first.id, parent: program, fn: "shell", input: "[]" })]).toEqual([1, 2])
      yield* store.addUsage({ served: "turn", turn: first.id, pick: PICK, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
      yield* store.addUsage({ served: "turn", turn: second.id, pick: PICK, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
      yield* store.addDiagnostics([{ level: "info", source: "test", text: "one", created: 1 }, { level: "info", source: "test", text: "two", created: 2 }])
    }))
    for (const table of ["everchat_launch", "everchat_head", "everchat_turn", "everchat_call", "everchat_image", "everchat_usage", "everchat_log"]) {
      expect([table, (await h.rows<{ n: number }>(file, `select n from ${table} where chat = 1 order by n`)).map((row) => row.n)]).toEqual([table, [1, 2]])
    }
    expect(await h.rows(file, "select turn, n from everchat_turn_item where chat = 1 order by turn, n")).toEqual([{ turn: 1, n: 0 }, { turn: 1, n: 1 }, { turn: 2, n: 0 }])
    expect(await h.rows(file, "select msg, n from everchat_msg_image where chat = 1 order by n")).toEqual([{ msg: 0, n: 0 }, { msg: 0, n: 1 }])
    expect(await h.rows(file, "select i from everchat_msg where chat = 1 order by i")).toEqual([{ i: 0 }, { i: 1 }])
  })

  // The chat's row
  // --------------

  test("the chat's row keeps the pick, the goal, the draft, and the last message taken", async () => {
    const file = h.newFile()
    const pick = { vendor: "anthropic", model: "claude-test", effort: "high", speed: "slow" }
    await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.setPick(pick)
      yield* store.setGoal("ship it \ud800")
      yield* store.setDraft("half a sent")
      yield* store.setTaken(7)
    }))
    const chat = await h.withStore(file, Store.use((store) => store.chat))
    expect(chat).toMatchObject({ pick, goal: "ship it �", draft: "half a sent", taken: 7 })
    await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.setGoal(null)
      yield* store.setDraft(null)
    }))
    expect(await h.rows(file, "select goal, draft from everchat_chat")).toEqual([{ goal: null, draft: null }])
    expect(await h.rows(file, "select count(*) as n from everchat_pick")).toEqual([{ n: 2 }])
  })

  // The log
  // -------

  test("append gives ids 0, 1, 2 with no gap, and returns what it wrote", async () => {
    const file = h.newFile()
    const result = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const a = yield* store.append([{ kind: "user", text: "héllo" }])
      const b = yield* store.append([
        { kind: "asst", text: "page one", more: true, line: "a summary" },
        { kind: "asst", text: "page two" },
        { kind: "note", text: "" }
      ])
      return { a, b, count: yield* store.count, read: yield* store.messages(0, 10), some: yield* store.messages(1, 3) }
    }))
    expect(result.count).toBe(4)
    expect(result.read).toEqual([...result.a, ...result.b])
    expect(result.read.map((m) => [m.i, m.kind, m.text, m.size, m.more, m.line])).toEqual([
      [0, "user", "héllo", 6, false, null],
      [1, "asst", "page one", 8, true, "a summary"],
      [2, "asst", "page two", 8, false, null],
      [3, "note", "", 0, false, null]
    ])
    expect(result.some.map((m) => m.i)).toEqual([1, 2])
    expect(result.read.every((m) => m.launch === 1 && m.turn === null && m.call === null)).toBe(true)
  })

  test("the text on disk is the text that append returns: well formed, with its size in bytes", async () => {
    const file = h.newFile()
    const lone = "a\ud83db" // a lone surrogate between two letters
    const written = await h.withStore(file, Store.use((store) => store.append([{ kind: "user", text: lone, line: lone }])))
    expect(written[0]).toMatchObject({ text: "a�b", size: 5, line: "a�b" })
    expect(await h.rows(file, "select text, size, octet_length(text) as bytes, line from everchat_msg")).toEqual([
      { text: "a�b", size: 5, bytes: 5, line: "a�b" }
    ])
  })

  test("an append that fails writes none of its messages", async () => {
    const file = h.newFile()
    const result = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.append([{ kind: "user", text: "kept" }])
      const error = yield* Effect.flip(store.append([
        { kind: "user", text: "page one", more: true },
        { kind: "user", text: "page two", images: [99] } // no such image
      ]))
      return { error, count: yield* store.count, next: yield* store.append([{ kind: "asst", text: "after" }]) }
    }))
    expect(result.error).toBeInstanceOf(StoreError)
    expect(result.error.op).toBe("append")
    expect(result.count).toBe(1)
    expect(result.next[0]?.i).toBe(1)
    expect(await h.rows(file, "select i, text from everchat_msg order by i")).toEqual([{ i: 0, text: "kept" }, { i: 1, text: "after" }])
  })

  // The tree and the views
  // ----------------------

  test("a node is written once, and read back as written", async () => {
    const file = h.newFile()
    const result = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const written = yield* store.putNodes([
        { l: 0, i: 0, text: "user: hi" },
        { l: 0, i: 1, text: "asst: hello \ud800" },
        { l: 1, i: 0, text: "greetings" }
      ])
      const again = yield* Effect.flip(store.putNodes([{ l: 2, i: 0, text: "new" }, { l: 0, i: 1, text: "other" }]))
      return {
        written,
        again,
        one: yield* store.node(0, 1),
        none: yield* store.node(2, 0),
        some: yield* store.nodes([[1, 0], [0, 0], [5, 5]])
      }
    }))
    expect(result.written.map((n) => [n.l, n.i, n.text, n.size])).toEqual([
      [0, 0, "user: hi", 8],
      [0, 1, "asst: hello �", 15],
      [1, 0, "greetings", 9]
    ])
    expect(result.again).toBeInstanceOf(StoreError)
    expect(Option.getOrUndefined(result.one)).toEqual(result.written[1])
    // The failed write took its first node back too.
    expect(Option.isNone(result.none)).toBe(true)
    expect(result.some.map((n) => [n.l, n.i]).sort()).toEqual([[0, 0], [1, 0]])
    expect(await h.rows(file, "select count(*) as n from everchat_node")).toEqual([{ n: 3 }])
  })

  test("nodes reads more parts than one statement can take", async () => {
    const many = 12_000
    const found = await h.withStore(h.newFile(), Effect.gen(function*() {
      const store = yield* Store
      yield* store.putNodes(Array.from({ length: many }, (_, i) => ({ l: 0, i, text: `n${i}` })))
      return yield* store.nodes(Array.from({ length: many + 5 }, (_, i): Part => [0, i]))
    }))
    expect(found.length).toBe(many)
    expect(new Set(found.map((n) => n.i)).size).toBe(many)
  })

  test("a view comes back part for part, and a second write replaces it", async () => {
    const file = h.newFile()
    const parts: Array<Part> = [[3, 0], [2, 2], [0, 12], [0, 13]]
    await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      expect(Option.isNone(yield* store.view("chat"))).toBe(true)
      yield* store.putView({ name: "chat", parts: [[0, 0]], batch: false })
      yield* store.putView({ name: "chat", parts, batch: true })
      yield* store.putView({ name: "seen", parts: [], batch: false })
    }))
    const views = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      return [yield* store.view("chat"), yield* store.view("seen")].map(Option.getOrUndefined)
    }))
    expect(views).toEqual([{ name: "chat", parts, batch: true }, { name: "seen", parts: [], batch: false }])
    expect(await h.rows(file, "select name, parts from everchat_view order by name")).toEqual([
      { name: "chat", parts: "[[3,0],[2,2],[0,12],[0,13]]" },
      { name: "seen", parts: "[]" }
    ])
  })

  // One event, one transaction
  // --------------------------

  test("a transaction that fails takes back every write, and gives the caller its own error", async () => {
    const file = h.newFile()
    const result = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.append([{ kind: "user", text: "before" }])
      const error = yield* Effect.flip(store.transaction(Effect.gen(function*() {
        yield* store.append([{ kind: "user", text: "lost" }])
        yield* store.putNodes([{ l: 0, i: 1, text: "user: lost" }])
        yield* store.putView({ name: "chat", parts: [[0, 1]], batch: false })
        yield* store.setTaken(1)
        return yield* new Stop()
      })))
      const done = yield* store.transaction(Effect.gen(function*() {
        const [message] = yield* store.append([{ kind: "user", text: "kept" }])
        yield* store.putNodes([{ l: 0, i: message!.i, text: "user: kept" }])
        return message!.i
      }))
      return { error, done, chat: yield* store.chat, view: yield* store.view("chat") }
    }))
    expect(result.error).toBeInstanceOf(Stop)
    expect(result.done).toBe(1)
    expect(result.chat.taken).toBe(-1)
    expect(Option.isNone(result.view)).toBe(true)
    expect(await h.rows(file, "select i, text from everchat_msg order by i")).toEqual([{ i: 0, text: "before" }, { i: 1, text: "kept" }])
    expect(await h.rows(file, "select l, i, text from everchat_node")).toEqual([{ l: 0, i: 1, text: "user: kept" }])
  })

  test("a store error inside a transaction takes back the writes before it", async () => {
    const file = h.newFile()
    await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.putNodes([{ l: 0, i: 0, text: "first" }])
      const error = yield* Effect.flip(store.transaction(Effect.gen(function*() {
        yield* store.append([{ kind: "user", text: "lost" }])
        yield* store.putNodes([{ l: 0, i: 0, text: "second write" }])
      })))
      expect(error).toBeInstanceOf(StoreError)
      expect(yield* store.count).toBe(0)
    }))
  })

  // Images, heads, usage
  // --------------------

  test("an image is stored once by name", async () => {
    const file = h.newFile()
    const png = new Uint8Array([1, 2, 3])
    const result = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const sent = { name: "aa.png", type: "image/png", width: 2, height: 1, source: "person" as const, bytes: png }
      const a = yield* store.putImage(sent)
      const again = yield* store.putImage({ ...sent, bytes: new Uint8Array([9]) })
      const b = yield* store.putImage({
        name: "bb.jpg",
        type: "image/jpeg",
        width: 1568,
        height: 1000,
        source: "tool",
        bytes: png
      })
      const [message] = yield* store.append([{ kind: "user", text: "look", images: [b, a] }])
      return { a, again, b, image: yield* store.image(a), none: yield* store.image(99), of: yield* store.imagesOf(message!.i) }
    }))
    expect(result.again).toBe(result.a)
    expect(result.of).toEqual([result.b, result.a])
    expect(Option.isNone(result.none)).toBe(true)
    const image = Option.getOrThrow(result.image)
    expect([image.name, image.type, image.width, image.height, image.source]).toEqual(["aa.png", "image/png", 2, 1, "person"])
    expect([...image.bytes]).toEqual([1, 2, 3])
    // A message's images, in their order.
    expect(await h.rows(file, "select msg, n, image from everchat_msg_image order by n")).toEqual([{ msg: 0, n: 0, image: result.b }, { msg: 0, n: 1, image: result.a }])
  })

  test("a head is stored once, and found by its text", async () => {
    const result = await h.withStore(h.newFile(), Effect.gen(function*() {
      const store = yield* Store
      const a = yield* store.putHead(`{"system":"one"}`)
      const b = yield* store.putHead(`{"system":"two"}`)
      return { a, b, again: yield* store.putHead(`{"system":"one"}`), body: yield* store.head(b), none: yield* store.head(99) }
    }))
    expect(result.again).toBe(result.a)
    expect(result.b).not.toBe(result.a)
    expect(Option.getOrUndefined(result.body)).toBe(`{"system":"two"}`)
    expect(Option.isNone(result.none)).toBe(true)
  })

  test("a usage row points to its pick, and equal picks are one row", async () => {
    const file = h.newFile()
    const cheap = { vendor: "openai", model: "small", effort: "low", speed: "slow" }
    await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.putNodes([{ l: 0, i: 0, text: "a line" }])
      const usage = { served: "compaction" as const, pick: cheap, input: 100, cacheRead: 9000, cacheWrite: 50, output: 40 }
      yield* store.addUsage({ ...usage, node: [0, 0], request: "req_1" })
      yield* store.addUsage({ ...usage, node: [0, 1], micros: 1234, expected: 9100 })
    }))
    expect(await h.rows(file, "select count(*) as n from everchat_pick")).toEqual([{ n: 2 }])
    expect(await h.rows(file, `
      select u.served, u.node_l, u.node_i, p.model, u.request, u.input, u.cache_read, u.cache_write, u.output, u.searches, u.micros, u.expected
      from everchat_usage u join everchat_pick p on p.id = u.pick order by u.n`)).toEqual([
      { served: "compaction", node_l: 0, node_i: 0, model: "small", request: "req_1", input: 100, cache_read: 9000, cache_write: 50, output: 40, searches: 0, micros: null, expected: null },
      { served: "compaction", node_l: 0, node_i: 1, model: "small", request: null, input: 100, cache_read: 9000, cache_write: 50, output: 40, searches: 0, micros: 1234, expected: 9100 }
    ])
  })

  // A restart
  // ---------

  test("a restart finds the log, the tree and the views as they were, and the ids go on", async () => {
    const file = h.newFile()
    const parts: Array<Part> = [[1, 0], [0, 2]]
    const before = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const messages = yield* store.append([
        { kind: "user", text: "one" },
        { kind: "asst", text: "two" },
        { kind: "user", text: "three" }
      ])
      const nodes = yield* store.putNodes([
        { l: 0, i: 0, text: "user: one" },
        { l: 0, i: 1, text: "asst: two" },
        { l: 0, i: 2, text: "user: three" },
        { l: 1, i: 0, text: "a talk" }
      ])
      yield* store.putView({ name: "chat", parts, batch: false })
      return { messages, nodes }
    }))
    const after = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      return {
        messages: yield* store.messages(0, yield* store.count),
        nodes: yield* store.nodes([[0, 0], [0, 1], [0, 2], [1, 0]]),
        view: yield* store.view("chat"),
        next: yield* store.append([{ kind: "asst", text: "four" }])
      }
    }))
    expect(after.messages).toEqual(before.messages)
    expect(after.nodes).toEqual(before.nodes)
    expect(Option.getOrUndefined(after.view)?.parts).toEqual(parts)
    expect(after.next[0]).toMatchObject({ i: 3, launch: 2 })
  })

  // Approvals
  // ---------

  test("pendCall: the approval's row takes the call's turn, function and input from the call's row; the call is pending, with its end and the text of output(n); the ids go 1, 2", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* calls(store)
      const given: Array<number> = []
      const first = yield* store.pendCall(ids.send, (n) => {
        given.push(n)
        return `send waits: approval ${n}`
      })
      const second = yield* store.pendCall(ids.late, (n) => `send waits: approval ${n}`)
      return { ids, first, second, given, approval: yield* store.approval(first), call: yield* store.call(ids.send) }
    }))
    expect([got.first, got.second, got.given]).toEqual([1, 2, [1]])
    const approval = Option.getOrThrow(got.approval)
    expect(approval).toEqual({
      id: 1,
      turn: got.ids.turn,
      call: got.ids.send,
      fn: "send",
      input: "{\"to\":\"x\",\"text\":\"hi\"}",
      status: "pending",
      who: null,
      answer: null,
      answered: null,
      output: null,
      ended: null,
      msg: null,
      created: approval.created,
      updated: approval.created
    })
    expect(approval.created).toBeGreaterThan(0)
    const call = Option.getOrThrow(got.call)
    expect([call.status, call.output, call.size, call.shown, call.ended]).toEqual(["pending", "send waits: approval 1", 22, 22, approval.created])
    // The other calls run on.
    expect(await h.rows(file, "select n, status from everchat_call where chat = 1 order by n")).toEqual([
      { n: 1, status: "running" },
      { n: 2, status: "pending" },
      { n: 3, status: "running" },
      { n: 4, status: "running" },
      { n: 5, status: "running" },
      { n: 6, status: "pending" }
    ])
    expect(await h.rows(file, "select n, call, fn, input from everchat_approval where chat = 1 order by n")).toEqual([
      { n: 1, call: 2, fn: "send", input: "{\"to\":\"x\",\"text\":\"hi\"}" },
      { n: 2, call: 6, fn: "send", input: "{\"to\":\"z\"}" }
    ])
  })

  test("pendCall: a call of a later turn gives its approval that turn, read from the call's row", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const first = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      yield* store.endTurn(first.id, "done")
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const program = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "await send(1)" })
      const send = yield* store.startCall({ turn: turn.id, parent: program, fn: "send", input: "{\"to\":\"x\"}" })
      const approval = yield* store.pendCall(send, (n) => `send waits: approval ${n}`)
      return { turns: [first.id, turn.id], send, approval: Option.getOrThrow(yield* store.approval(approval)) }
    }))
    expect(got.turns).toEqual([1, 2])
    expect([got.approval.turn, got.approval.call]).toEqual([2, got.send])
    expect(await h.rows(file, "select turn, call from everchat_approval where chat = 1")).toEqual([{ turn: 2, call: got.send }])
  })

  test("pendCall: a call that is not running, a program, a call that waits already and a call that is not there are refused with StoreError, and nothing is written", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* calls(store)
      yield* store.endCall(ids.read, { status: "done", output: "a" })
      yield* store.pendCall(ids.send, (n) => `waits ${n}`)
      const tries = [ids.read, ids.program, ids.send, 99]
      const errors = []
      for (const id of tries) errors.push(yield* Effect.flip(store.pendCall(id, (n) => `again ${n}`)))
      return { ids, errors }
    }))
    for (const error of got.errors) {
      expect(error).toBeInstanceOf(StoreError)
      expect(error.op).toBe("pendCall")
    }
    expect(got.errors.map((error) => String(error.cause))).toEqual([
      `Error: the call ${got.ids.read} is done, not running`,
      `Error: the call ${got.ids.program} is a program, and only a function's call waits for an answer`,
      `Error: the call ${got.ids.send} is pending, not running`,
      "Error: the chat has no call 99"
    ])
    expect(await approvalCount(file)).toBe(1)
    expect(await callRow(file, got.ids.read)).toEqual([{ status: "done", output: "a", size: 1, shown: 1, ended: 1 }])
    expect(await callRow(file, got.ids.program)).toEqual([{ status: "running", output: null, size: null, shown: null, ended: 0 }])
    expect(await callRow(file, got.ids.send)).toEqual([{ status: "pending", output: "waits 1", size: 7, shown: 7, ended: 1 }])
  })

  test("pendCall: both or neither: in a transaction that fails, and with an output that throws, the call stays running and no approval is made; the next pendCall takes id 1", async () => {
    const file = h.newFile()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* calls(store)
      const failed = yield* Effect.flip(store.transaction(Effect.andThen(store.pendCall(ids.send, (n) => `waits ${n}`), Effect.fail("no"))))
      const thrown = yield* Effect.exit(store.pendCall(ids.send, () => {
        throw new Error("no text")
      }))
      const after = { approvals: yield* store.approvals(), call: yield* store.call(ids.send) }
      const next = yield* store.pendCall(ids.send, (n) => `waits ${n}`)
      return { failed, thrown, after, next }
    }))
    expect(got.failed).toBe("no")
    expect(Exit.isFailure(got.thrown) && String(Cause.squash(got.thrown.cause))).toBe("Error: no text")
    expect(got.after.approvals).toEqual([])
    expect(Option.getOrThrow(got.after.call).status).toBe("running")
    expect(Option.getOrThrow(got.after.call).output).toBe(null)
    expect(got.next).toBe(1)
    expect(await approvalCount(file)).toBe(1)
  })

  // The answer, the 7 days and the run
  // ----------------------------------

  test("answerApproval: a yes and a no are kept as given (who, answer, answered); a second answer gives closed and the row is as the first left it; a number that the chat has not gives none", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* functions(store, 2)
      yield* TestClock.setTime(1000)
      for (const id of ids) yield* store.pendCall(id, (n) => `waits ${n}`)
      yield* TestClock.setTime(5000)
      const yes = yield* store.answerApproval(1, { yes: true, who: "Zoë at the desk", text: "Go on ✓" })
      const no = yield* store.answerApproval(2, { yes: false, who: "Ada" })
      yield* TestClock.setTime(6000)
      const again = [
        yield* store.answerApproval(1, { yes: false, who: "Eve", text: "stop" }),
        yield* store.answerApproval(2, { yes: true, who: "Eve", text: null })
      ]
      const none = yield* store.answerApproval(3, { yes: true, who: "Eve" })
      return { yes, no, again, none, rows: yield* store.approvals() }
    }))
    expect(got.yes._tag).toBe("answered")
    expect(got.yes).toMatchObject({ approval: { id: 1, status: "yes", who: "Zoë at the desk", answer: "Go on ✓", answered: 5000, updated: 5000, created: 1000 } })
    expect(got.no).toMatchObject({ _tag: "answered", approval: { id: 2, status: "no", who: "Ada", answer: null, answered: 5000, updated: 5000 } })
    expect(got.again).toEqual([
      { _tag: "closed", approval: got.rows[0]! },
      { _tag: "closed", approval: got.rows[1]! }
    ])
    expect(got.rows).toEqual([rowOf(got.yes)!, rowOf(got.no)!])
    expect(got.none).toEqual({ _tag: "none" })
    expect(await approvalRow(file, 1)).toEqual({ status: "yes", who: "Zoë at the desk", answer: "Go on ✓", answered: 5000, output: null, ended: null, msg: null, updated: 5000 })
    expect(await approvalRow(file, 2)).toEqual({ status: "no", who: "Ada", answer: null, answered: 5000, output: null, ended: null, msg: null, updated: 5000 })
  })

  test("answerApproval: an answer at WAIT exactly is kept, and one 1 ms later gives expired: the row is expired at that time, with no who and no answer", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* functions(store, 2)
      yield* TestClock.setTime(1000)
      for (const id of ids) yield* store.pendCall(id, (n) => `waits ${n}`)
      yield* TestClock.setTime(1000 + WAIT)
      const kept = yield* store.answerApproval(1, { yes: true, who: "Ada", text: "in time" })
      yield* TestClock.setTime(1000 + WAIT + 1)
      const late = yield* store.answerApproval(2, { yes: true, who: "Ada", text: "too late" })
      const after = yield* store.answerApproval(2, { yes: true, who: "Ada", text: "again" })
      return { kept, late, after }
    }))
    expect(got.kept).toMatchObject({ _tag: "answered", approval: { id: 1, status: "yes", who: "Ada", answer: "in time", answered: 1000 + WAIT } })
    expect(got.late).toEqual({ _tag: "expired", approval: expect.objectContaining({ id: 2, status: "expired", who: null, answer: null, answered: 1000 + WAIT + 1 }) })
    expect(got.after).toEqual({ _tag: "closed", approval: rowOf(got.late)! })
    expect(await approvalRow(file, 2)).toEqual({ status: "expired", who: null, answer: null, answered: 1000 + WAIT + 1, output: null, ended: null, msg: null, updated: 1000 + WAIT + 1 })
  })

  test("answerApproval: a who of 0 or 257 characters and a text of 4,097 are refused with StoreError and write nothing; a who of 256 and a text of 4,096 are kept", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* functions(store, 1)
      yield* store.pendCall(ids[0]!, (n) => `waits ${n}`)
      const refused = [
        yield* Effect.flip(store.answerApproval(1, { yes: true, who: "" })),
        yield* Effect.flip(store.answerApproval(1, { yes: true, who: "w".repeat(WHO_MAX + 1) })),
        yield* Effect.flip(store.answerApproval(1, { yes: false, who: "Ada", text: "t".repeat(ANSWER_MAX + 1) }))
      ]
      const before = yield* store.approval(1)
      const kept = yield* store.answerApproval(1, { yes: false, who: "w".repeat(WHO_MAX), text: "t".repeat(ANSWER_MAX) })
      return { refused, before, kept }
    }))
    expect(got.refused.map((error) => [error instanceof StoreError, error.op, String(error.cause)])).toEqual([
      [true, "answerApproval", "Error: who answers is a text of 1 to 256 characters, not 0"],
      [true, "answerApproval", "Error: who answers is a text of 1 to 256 characters, not 257"],
      [true, "answerApproval", "Error: an answer's text has at most 4096 characters, not 4097"]
    ])
    expect(Option.getOrThrow(got.before).status).toBe("pending")
    expect(got.kept).toMatchObject({ _tag: "answered", approval: { status: "no", who: "w".repeat(WHO_MAX), answer: "t".repeat(ANSWER_MAX) } })
  })

  test("expireApprovals: it takes only the pending rows that have waited more than WAIT, and gives them; a second call gives none", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* functions(store, 3)
      yield* TestClock.setTime(1000)
      yield* store.pendCall(ids[0]!, (n) => `waits ${n}`)
      yield* TestClock.setTime(2000)
      yield* store.pendCall(ids[1]!, (n) => `waits ${n}`)
      yield* store.pendCall(ids[2]!, (n) => `waits ${n}`)
      yield* store.answerApproval(3, { yes: true, who: "Ada" })
      const id = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map((row) => row.id)
      yield* TestClock.setTime(1000 + WAIT)
      const atWait = id(yield* store.expireApprovals())
      yield* TestClock.setTime(1000 + WAIT + 1)
      const first = yield* store.expireApprovals()
      const again = id(yield* store.expireApprovals())
      yield* TestClock.setTime(2000 + WAIT + 1)
      const second = yield* store.expireApprovals()
      const last = id(yield* store.expireApprovals())
      return { atWait, first, again, second, last, rows: yield* store.approvals() }
    }))
    expect(got.atWait).toEqual([])
    expect(got.first).toEqual([expect.objectContaining({ id: 1, status: "expired", who: null, answered: 1000 + WAIT + 1, updated: 1000 + WAIT + 1 })])
    expect(got.again).toEqual([])
    expect(got.second).toEqual([expect.objectContaining({ id: 2, status: "expired", who: null, answered: 2000 + WAIT + 1 })])
    expect(got.last).toEqual([])
    expect(got.rows.map((row) => [row.id, row.status])).toEqual([[1, "expired"], [2, "expired"], [3, "yes"]])
    expect(got.rows.slice(0, 2)).toEqual([...got.first, ...got.second])
  })

  test("the run: startApproval gives a yes row one time, and none for each other state; endApproval ends only a running row; cutApprovals takes only running rows", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* functions(store, 7)
      yield* TestClock.setTime(1000)
      yield* store.pendCall(ids[0]!, (n) => `waits ${n}`)
      yield* TestClock.setTime(1000 + WAIT)
      for (const id of ids.slice(1)) yield* store.pendCall(id, (n) => `waits ${n}`)
      yield* TestClock.setTime(1000 + WAIT + 1)
      // 1 expired, 2 no, 3 to 7 yes; 8 is no approval.
      yield* store.answerApproval(1, { yes: true, who: "Ada" })
      yield* store.answerApproval(2, { yes: false, who: "Ada" })
      for (const n of [3, 4, 5, 6, 7]) yield* store.answerApproval(n, { yes: true, who: "Ada" })
      const status = (row: Option.Option<{ readonly id: number; readonly status: string }>) => Option.getOrNull(Option.map(row, (row) => [row.id, row.status]))
      yield* TestClock.setTime(1000 + WAIT + 2)
      const started = yield* Effect.forEach([3, 3, 4, 5, 6], (n) => Effect.map(store.startApproval(n), status))
      const others = yield* Effect.forEach([1, 2, 8], (n) => Effect.map(store.startApproval(n), status))
      yield* TestClock.setTime(1000 + WAIT + 3)
      // 7 is yes and not running.
      const notRunning = yield* Effect.forEach([1, 2, 7, 8], (n) => Effect.map(store.endApproval(n, { status: "done", output: "no" }), status))
      const ended = [
        yield* store.endApproval(3, { status: "done", output: "sent ✓" }),
        yield* store.endApproval(4, { status: "failed", output: "the server said no" })
      ]
      const twice = yield* Effect.map(store.endApproval(3, { status: "failed", output: "again" }), status)
      const ranAgain = yield* Effect.map(store.startApproval(3), status)
      yield* TestClock.setTime(1000 + WAIT + 4)
      const cut = yield* store.cutApprovals("an earlier launch left the run")
      const cutAgain = yield* store.cutApprovals("again")
      return { started, others, notRunning, ended, twice, ranAgain, cut, cutAgain, rows: yield* store.approvals() }
    }))
    expect(got.started).toEqual([[3, "running"], null, [4, "running"], [5, "running"], [6, "running"]])
    expect(got.others).toEqual([null, null, null])
    expect(got.notRunning).toEqual([null, null, null, null])
    expect(got.ended.map((row) => Option.getOrThrow(row))).toEqual([
      expect.objectContaining({ id: 3, status: "done", output: "sent ✓", ended: 1000 + WAIT + 3, updated: 1000 + WAIT + 3, who: "Ada" }),
      expect.objectContaining({ id: 4, status: "failed", output: "the server said no", ended: 1000 + WAIT + 3 })
    ])
    expect([got.twice, got.ranAgain]).toEqual([null, null])
    expect(got.cut.map((row) => [row.id, row.status, row.output, row.ended])).toEqual([
      [5, "cut", "an earlier launch left the run", 1000 + WAIT + 4],
      [6, "cut", "an earlier launch left the run", 1000 + WAIT + 4]
    ])
    expect(got.cutAgain).toEqual([])
    expect(got.rows.map((row) => [row.id, row.status, row.output, row.ended])).toEqual([
      [1, "expired", null, null],
      [2, "no", null, null],
      [3, "done", "sent ✓", 1000 + WAIT + 3],
      [4, "failed", "the server said no", 1000 + WAIT + 3],
      [5, "cut", "an earlier launch left the run", 1000 + WAIT + 4],
      [6, "cut", "an earlier launch left the run", 1000 + WAIT + 4],
      [7, "yes", null, null]
    ])
  })

  test("each approval change writes only the rows that its own tests take: expireApprovals, startApproval, endApproval, tellApproval and cutApprovals beside rows of other states, each with its answer, and every other row as it was after each", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* functions(store, 6)
      yield* store.append([{ kind: "note", text: "one" }])
      yield* TestClock.setTime(1000)
      yield* store.pendCall(ids[0]!, (n) => `waits ${n}`)
      yield* TestClock.setTime(1000 + WAIT)
      for (const id of ids.slice(1)) yield* store.pendCall(id, (n) => `waits ${n}`)
      yield* TestClock.setTime(1000 + WAIT + 1)
      // 1 pending past WAIT, 2 to 4 yes, 5 no, 6 pending.
      for (const n of [2, 3, 4]) yield* store.answerApproval(n, { yes: true, who: "Ada" })
      yield* store.answerApproval(5, { yes: false, who: "Ada" })
      const id = (row: Option.Option<{ readonly id: number }>) => Option.getOrNull(Option.map(row, (one) => one.id))
      const idsOf = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map((row) => row.id)
      const steps: Array<[string, Effect.Effect<unknown, StoreError>]> = [
        ["expireApprovals", Effect.map(store.expireApprovals(), idsOf)],
        ["startApproval 2", Effect.map(store.startApproval(2), id)],
        ["startApproval 3", Effect.map(store.startApproval(3), id)],
        ["endApproval 2", Effect.map(store.endApproval(2, { status: "done", output: "ok" }), id)],
        ["tellApproval 2", store.tellApproval(2, 0)],
        ["cutApprovals", Effect.map(store.cutApprovals("cut"), idsOf)]
      ]
      const seen = []
      for (const [name, step] of steps) {
        const result = yield* Effect.result(step)
        const rows = (yield* store.approvals()).map((row) => [row.id, row.status, row.msg])
        seen.push([name, result._tag === "Success" ? result.success : "failed: " + String(result.failure.cause), rows])
      }
      return seen
    }))
    expect(got).toEqual([
      ["expireApprovals", [1], [[1, "expired", null], [2, "yes", null], [3, "yes", null], [4, "yes", null], [5, "no", null], [6, "pending", null]]],
      ["startApproval 2", 2, [[1, "expired", null], [2, "running", null], [3, "yes", null], [4, "yes", null], [5, "no", null], [6, "pending", null]]],
      ["startApproval 3", 3, [[1, "expired", null], [2, "running", null], [3, "running", null], [4, "yes", null], [5, "no", null], [6, "pending", null]]],
      ["endApproval 2", 2, [[1, "expired", null], [2, "done", null], [3, "running", null], [4, "yes", null], [5, "no", null], [6, "pending", null]]],
      ["tellApproval 2", undefined, [[1, "expired", null], [2, "done", 0], [3, "running", null], [4, "yes", null], [5, "no", null], [6, "pending", null]]],
      ["cutApprovals", [3], [[1, "expired", null], [2, "done", 0], [3, "cut", null], [4, "yes", null], [5, "no", null], [6, "pending", null]]]
    ])
  })

  test("tellApproval sets msg one time and refuses a pending, yes or running row; untoldApprovals lists by id and loses a row when it is told", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const ids = yield* functions(store, 8)
      yield* store.append([{ kind: "note", text: "one" }, { kind: "note", text: "two" }])
      yield* TestClock.setTime(1000)
      yield* store.pendCall(ids[4]!, (n) => `waits ${n}`) // 1: expired
      yield* TestClock.setTime(1000 + WAIT)
      for (const id of [...ids.slice(0, 4), ...ids.slice(5)]) yield* store.pendCall(id, (n) => `waits ${n}`)
      yield* TestClock.setTime(1000 + WAIT + 1)
      // 1 expired, 2 pending, 3 yes, 4 running, 5 no, 6 done, 7 failed, 8 cut.
      yield* store.answerApproval(1, { yes: true, who: "Ada" })
      for (const n of [3, 4, 6, 7, 8]) yield* store.answerApproval(n, { yes: true, who: "Ada" })
      yield* store.answerApproval(5, { yes: false, who: "Ada" })
      for (const n of [6, 7, 8]) yield* store.startApproval(n)
      yield* store.endApproval(6, { status: "done", output: "ok" })
      yield* store.endApproval(7, { status: "failed", output: "no" })
      yield* store.cutApprovals("cut")
      yield* store.startApproval(4)
      const id = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map((row) => row.id)
      const first = id(yield* store.untoldApprovals())
      const refused = yield* Effect.forEach([2, 3, 4, 9], (n) => Effect.flip(store.tellApproval(n, 0)))
      yield* TestClock.setTime(1000 + WAIT + 2)
      yield* store.tellApproval(6, 1)
      const afterOne = id(yield* store.untoldApprovals())
      const twice = yield* Effect.flip(store.tellApproval(6, 0))
      const noMessage = yield* Effect.flip(store.tellApproval(5, 99))
      for (const n of [1, 5, 7, 8]) yield* store.tellApproval(n, 0)
      const last = id(yield* store.untoldApprovals())
      return { first, refused, afterOne, twice, noMessage, last, rows: yield* store.approvals() }
    }))
    expect(got.first).toEqual([1, 5, 6, 7, 8])
    expect(got.refused.map((error) => [error instanceof StoreError, error.op, String(error.cause)])).toEqual([
      [true, "tellApproval", "Error: the approval 2 is pending, and has no end to tell"],
      [true, "tellApproval", "Error: the approval 3 is yes, and has no end to tell"],
      [true, "tellApproval", "Error: the approval 4 is running, and has no end to tell"],
      [true, "tellApproval", "Error: the chat has no approval 9"]
    ])
    expect(got.afterOne).toEqual([1, 5, 7, 8])
    expect([got.twice.op, String(got.twice.cause)]).toEqual(["tellApproval", "Error: the approval 6 was told already, at message 1"])
    expect(got.noMessage).toBeInstanceOf(StoreError)
    // The reference (chat, msg) refuses a message that the chat has not.
    expect(String((got.noMessage.cause as { readonly cause?: unknown }).cause)).toContain("ConstraintError")
    expect(got.last).toEqual([])
    expect(got.rows.map((row) => [row.id, row.status, row.msg])).toEqual([
      [1, "expired", 0],
      [2, "pending", null],
      [3, "yes", null],
      [4, "running", null],
      [5, "no", 0],
      [6, "done", 1],
      [7, "failed", 0],
      [8, "cut", 0]
    ])
    expect(await approvalRow(file, 6)).toMatchObject({ msg: 1, updated: 1000 + WAIT + 2 })
  })

  // Wake-ups
  // --------

  test("makeWake: a reminder and a routine that a function's call made are made with their whole rows: the ids 1 and 2, due = first, the clock's time, nothing fired; a new chat has its wake-ups on, a new turn no ceiling", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(5000)
      const reminder = yield* store.makeWake(REMINDER, 20)
      const [call] = yield* functions(store, 1)
      yield* TestClock.setTime(6000)
      const routine = yield* store.makeWake({ ...ROUTINE, turn: 1, call: call! }, 20)
      return { reminder, routine, call: call!, all: yield* store.wakes() }
    }))
    const base = { slot: null, pending: null, missed: 0, fired: 0, lastTurn: null, settled: true, failed: 0, stopped: null, why: null, stopCall: null }
    expect(got.reminder).toEqual({
      _tag: "made",
      wake: { id: 1, text: "call back", cron: null, at: REMINDER.at, zone: "Europe/Berlin", first: REMINDER.first, turn: null, call: null, due: REMINDER.first, ...base, created: 5000, updated: 5000 }
    })
    expect(got.routine).toEqual({
      _tag: "made",
      wake: { id: 2, text: "stand up", cron: "0 9 * * 1-5", at: null, zone: "Europe/Berlin", first: ROUTINE.first, turn: 1, call: got.call, due: ROUTINE.first, ...base, created: 6000, updated: 6000 }
    })
    expect(got.all).toEqual([got.reminder, got.routine].flatMap((made) => made._tag === "made" ? [made.wake] : []))
    expect(await wakeRow(file, 2)).toEqual({
      chat: 1, n: 2, text: "stand up", cron: "0 9 * * 1-5", at: null, zone: "Europe/Berlin", first: ROUTINE.first, turn: 1, call: got.call, due: ROUTINE.first,
      slot: null, pending: null, missed: 0, fired: 0, last_turn: null, settled: 1, failed: 0, stopped: null, why: null, stop_call: null, created: 6000, updated: 6000
    })
    // A new chat's wake-ups are on, and a turn started with no ceiling has
    // none.
    expect(await h.rows(file, "select wakeups from everchat_chat")).toEqual([{ wakeups: 1 }])
    expect(await h.rows(file, "select steps, tokens from everchat_turn")).toEqual([{ steps: null, tokens: null }])
  })

  test("makeWake: a text of 0 or 2,001 characters is refused with StoreError before the transaction and writes nothing; 1 and 2,000 are kept; a lone surrogate is made well formed, and counted so", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const refused = [
        yield* Effect.exit(store.makeWake({ ...REMINDER, text: "" }, 20)),
        yield* Effect.exit(store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX + 1) }, 20)),
        yield* Effect.exit(store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX) + "\ud800" }, 20))
      ]
      const count = yield* Effect.promise(() => wakeCount(file))
      const made = [
        yield* store.makeWake({ ...REMINDER, text: "t" }, 20),
        yield* store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX) }, 20),
        yield* store.makeWake({ ...REMINDER, text: "a\ud800b" }, 20),
        yield* store.makeWake({ ...REMINDER, text: "t".repeat(WAKE_TEXT_MAX - 1) + "\ud800" }, 20)
      ]
      return { refused, count, made }
    }))
    expect(WAKE_TEXT_MAX).toBe(2000)
    const failure = (exit: Exit.Exit<unknown, StoreError>) => {
      if (Exit.isSuccess(exit)) return "it was made"
      const error = Cause.squash(exit.cause)
      return [error instanceof StoreError, error instanceof StoreError ? error.op : null, error instanceof StoreError ? String(error.cause) : String(error)]
    }
    expect(got.refused.map(failure)).toEqual([
      [true, "makeWake", "Error: a wake-up's text is a text of 1 to 2000 characters, not 0"],
      [true, "makeWake", "Error: a wake-up's text is a text of 1 to 2000 characters, not 2001"],
      [true, "makeWake", "Error: a wake-up's text is a text of 1 to 2000 characters, not 2001"]
    ])
    expect(got.count).toBe(0)
    expect(got.made.map((made) => made._tag === "made" ? [made.wake.id, made.wake.text.length, made.wake.text.isWellFormed()] : made._tag)).toEqual([
      [1, 1, true],
      [2, 2000, true],
      [3, 3, true],
      [4, 2000, true]
    ])
    expect(await h.rows(file, "select n, text from everchat_wake where n in (3, 4) order by n")).toEqual([
      { n: 3, text: "a\ufffdb" },
      { n: 4, text: "t".repeat(WAKE_TEXT_MAX - 1) + "\ufffd" }
    ])
  })

  test("makeWake: the schema refuses a turn with no call, a call with no turn, a routine with a time, a wake-up with neither, a reminder whose first slot is not its time, and a turn that the chat has not: StoreError, nothing written; the next make takes id 1", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const [call] = yield* functions(store, 1)
      const tries = [
        { ...REMINDER, turn: 1 },
        { ...REMINDER, call: call! },
        { ...ROUTINE, at: ROUTINE.first },
        { text: "neither", zone: "UTC", first: 1 },
        { ...REMINDER, first: REMINDER.first + 1 },
        { ...REMINDER, turn: 99, call: call! }
      ]
      const errors = []
      for (const wake of tries) errors.push(yield* Effect.flip(store.makeWake(wake, 20)))
      const count = yield* Effect.promise(() => wakeCount(file))
      return { errors, count, next: yield* store.makeWake(REMINDER, 20) }
    }))
    // Each store's database refuses each: its own text is its own (SQLite's
    // is a case of its test file).
    expect(got.errors.map((error) => [error instanceof StoreError, error.op])).toEqual(Array.from({ length: 6 }, () => [true, "makeWake"]))
    expect(got.count).toBe(0)
    expect(got.next._tag === "made" ? got.next.wake.id : got.next._tag).toBe(1)
  })

  test("makeWake: full at limit active rows, and nothing is written; a row that stopped (by plain SQL) is not counted; a limit of 0 is full", async () => {
    const file = h.newFile()
    const made = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      return [
        yield* store.makeWake(REMINDER, 2),
        yield* store.makeWake(ROUTINE, 2),
        yield* store.makeWake({ ...REMINDER, text: "a third" }, 2),
        yield* store.makeWake({ ...REMINDER, text: "a third" }, 3)
      ]
    }))
    expect(made.map((one) => one._tag === "made" ? one.wake.id : one._tag)).toEqual([1, 2, "full", 3])
    // The person stops wake-up 2, as the cut's later member will.
    await h.write(file, "update everchat_wake set stopped = 9, why = 'person', due = null, updated = 9 where chat = 1 and n = 2")
    const after = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      return [
        yield* store.makeWake({ ...REMINDER, text: "a fourth" }, 3),
        yield* store.makeWake({ ...REMINDER, text: "a fifth" }, 3),
        yield* store.makeWake({ ...REMINDER, text: "none" }, 0)
      ]
    }))
    expect(after.map((one) => one._tag === "made" ? one.wake.id : one._tag)).toEqual([4, "full", "full"])
    expect(await h.rows(file, "select n, text, stopped from everchat_wake order by n")).toEqual([
      { n: 1, text: "call back", stopped: null },
      { n: 2, text: "stand up", stopped: 9 },
      { n: 3, text: "a third", stopped: null },
      { n: 4, text: "a fourth", stopped: null }
    ])
  })

  // The fire's members (docs/wakeups.md, section 3)
  // ------------------------------------------------

  test("pendWake with no fire waiting: pending, missed and due as given, updated the clock's time, and true; missed 0, 1, 999 and 1,000 as given, 1,001 kept at 1,000; a reminder's due may be null", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const rows = []
      for (const missed of [0, 1, 999, 1000, 1001]) rows.push(made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20)))
      const reminder = made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
      yield* TestClock.setTime(T0 + 5)
      const answers = []
      for (const [k, missed] of [0, 1, 999, 1000, 1001].entries()) answers.push(yield* store.pendWake(rows[k]!.id, { pending: T0, missed, due: T0 + H }))
      answers.push(yield* store.pendWake(reminder.id, { pending: T0, missed: 0, due: null }))
      return { rows, reminder, answers, after: yield* store.wakes() }
    }))
    expect(got.answers).toEqual([true, true, true, true, true, true])
    expect(got.after).toEqual([
      ...[0, 1, 999, 1000, 1000].map((missed, k) => ({ ...got.rows[k]!, pending: T0, missed, due: T0 + H, updated: T0 + 5 })),
      { ...got.reminder, pending: T0, missed: 0, due: null, updated: T0 + 5 }
    ])
  })

  test("pendWake with a fire waiting: one fire still waits, pending the given slot, missed the old missed + 1 + the given count, at most 1,000, due as given", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const row = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const capped = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const full = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      yield* store.pendWake(row.id, { pending: T0, missed: 3, due: T0 + H })
      yield* store.pendWake(capped.id, { pending: T0, missed: 3, due: T0 + H })
      yield* store.pendWake(full.id, { pending: T0, missed: 1000, due: T0 + H })
      yield* TestClock.setTime(T0 + 7)
      const answers = [
        yield* store.pendWake(row.id, { pending: T0 + 2 * H, missed: 5, due: T0 + 3 * H }),
        yield* store.pendWake(capped.id, { pending: T0 + 2 * H, missed: 996, due: T0 + 3 * H }),
        yield* store.pendWake(full.id, { pending: T0 + 2 * H, missed: 0, due: T0 + 3 * H })
      ]
      const once = yield* store.wakes()
      yield* TestClock.setTime(T0 + 8)
      answers.push(yield* store.pendWake(capped.id, { pending: T0 + 3 * H, missed: 0, due: T0 + 4 * H }))
      return { rows: [row, capped, full], answers, once, twice: yield* wakeOf(store, capped.id) }
    }))
    expect(got.answers).toEqual([true, true, true, true])
    const [row, capped, full] = got.rows
    expect(got.once).toEqual([
      { ...row!, pending: T0 + 2 * H, missed: 3 + 1 + 5, due: T0 + 3 * H, updated: T0 + 7 },
      { ...capped!, pending: T0 + 2 * H, missed: 1000, due: T0 + 3 * H, updated: T0 + 7 },
      { ...full!, pending: T0 + 2 * H, missed: 1000, due: T0 + 3 * H, updated: T0 + 7 }
    ])
    // 3 + 1 + 996 is the bound itself; one more slot stays at it.
    expect(got.twice).toEqual({ ...capped!, pending: T0 + 3 * H, missed: 1000, due: T0 + 4 * H, updated: T0 + 8 })
  })

  test("pendWake changes nothing and gives false, with no StoreError: a slot at or before the waiting pending, at or before the row's slot, a stopped row, a row that is not there, and a chat whose wake-ups are off; then on, the same slot is taken", async () => {
    const file = h.newFile()
    const first = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const waiting = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const fired = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const stopped = made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
      yield* store.pendWake(waiting.id, { pending: T0, missed: 2, due: T0 + H })
      yield* store.pendWake(fired.id, { pending: T0, missed: 2, due: T0 + H })
      yield* fire(store, fired.id, { pending: T0, missed: 2 })
      yield* store.pendWake(stopped.id, { pending: T0, missed: 0, due: null })
      yield* fire(store, stopped.id, { pending: T0, missed: 0 })
      const before = yield* store.wakes()
      yield* TestClock.setTime(T0 + 9)
      const answers = [
        yield* store.pendWake(waiting.id, { pending: T0, missed: 0, due: T0 + 2 * H }),
        yield* store.pendWake(waiting.id, { pending: T0 - 1, missed: 0, due: T0 + 2 * H }),
        yield* store.pendWake(fired.id, { pending: T0, missed: 0, due: T0 + 2 * H }),
        yield* store.pendWake(fired.id, { pending: T0 - H, missed: 0, due: T0 + 2 * H }),
        yield* store.pendWake(stopped.id, { pending: T0 + H, missed: 0, due: null }),
        yield* store.pendWake(9, { pending: T0 + H, missed: 0, due: null })
      ]
      return { before, answers, after: yield* store.wakes() }
    }))
    expect(first.before.map((wake) => [wake.id, wake.slot, wake.pending, wake.stopped !== null])).toEqual([[1, null, T0, false], [2, T0, null, false], [3, T0, null, true]])
    expect(first.answers).toEqual([false, false, false, false, false, false])
    expect(first.after).toEqual(first.before)
    await switchBySql(file, false)
    const off = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(T0 + 10)
      return {
        answers: [
          yield* store.pendWake(1, { pending: T0 + H, missed: 0, due: T0 + 2 * H }),
          yield* store.pendWake(2, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
        ],
        after: yield* store.wakes()
      }
    }))
    expect(off.answers).toEqual([false, false])
    expect(off.after).toEqual(first.before)
    await switchBySql(file, true)
    const on = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(T0 + 11)
      return {
        answers: [
          yield* store.pendWake(1, { pending: T0 + H, missed: 0, due: T0 + 2 * H }),
          yield* store.pendWake(2, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
        ],
        after: yield* store.wakes()
      }
    }))
    expect(on.answers).toEqual([true, true])
    expect(on.after).toEqual([
      { ...first.before[0]!, pending: T0 + H, missed: 2 + 1 + 0, due: T0 + 2 * H, updated: T0 + 11 },
      { ...first.before[1]!, pending: T0 + H, missed: 0, due: T0 + 2 * H, updated: T0 + 11 },
      first.before[2]!
    ])
  })

  test("fireWake: the fire goes in the offer's transaction, after the turn's row: slot the slot read, pending null, missed 0, fired + 1, lastTurn the turn, settled false, due kept, updated the clock's time; a failed transaction writes neither the turn nor the fire", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const row = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      yield* store.pendWake(row.id, { pending: T0, missed: 4, due: T0 + H })
      const read = Option.getOrThrow(yield* store.pendingWake())
      const before = yield* wakeOf(store, row.id)
      const failed = yield* Effect.exit(store.transaction(Effect.gen(function*() {
        const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
        yield* store.fireWake(row.id, turn.id, { pending: read.pending!, missed: read.missed })
        return yield* Effect.fail("a later write of the offer failed")
      })))
      const kept = { wake: yield* wakeOf(store, row.id), turns: (yield* store.turns(null, 10)).length }
      yield* TestClock.setTime(T0 + 3)
      const turn = yield* fire(store, row.id, { pending: read.pending!, missed: read.missed })
      return { row, before, failed, kept, turn, after: yield* wakeOf(store, row.id) }
    }))
    expect(Exit.isFailure(got.failed)).toBe(true)
    expect(got.kept).toEqual({ wake: got.before, turns: 0 })
    expect(got.after).toEqual({ ...got.before!, slot: T0, pending: null, missed: 0, fired: 1, lastTurn: got.turn, settled: false, due: T0 + H, updated: T0 + 3 })
    // Its end counted, the next slot fires again.
    await settleBySql(file, 1, T0 + 4)
    const again = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* store.pendWake(1, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
      yield* TestClock.setTime(T0 + H)
      const turn = yield* fire(store, 1, { pending: T0 + H, missed: 0 })
      return { turn, after: yield* wakeOf(store, 1) }
    }))
    expect(again.after).toEqual({ ...got.after!, slot: T0 + H, fired: 2, lastTurn: again.turn, due: T0 + 2 * H, updated: T0 + H })
  })

  test("fireWake with a newer slot written between the read and the fire: slot the slot read, the newer slot waits on, and missed loses the read's missed + 1; not below 0; a count at 1,000 stays", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const newer = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const stale = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const capped = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      for (const [row, missed] of [[newer, 4], [stale, 4], [capped, 998]] as const) {
        yield* store.pendWake(row.id, { pending: T0, missed, due: T0 + H })
      }
      const reads = [yield* wakeOf(store, newer.id), yield* wakeOf(store, stale.id), yield* wakeOf(store, capped.id)]
      // The firer writes a newer slot of each before the fire.
      for (const row of [newer, stale, capped]) yield* store.pendWake(row.id, { pending: T0 + 2 * H, missed: 5, due: T0 + 3 * H })
      yield* TestClock.setTime(T0 + 2 * H + 1)
      const turns = [
        yield* fire(store, newer.id, { pending: T0, missed: 4 }),
        // A read whose missed is past the row's: missed stops at 0.
        yield* fire(store, stale.id, { pending: T0, missed: 50 }),
        yield* fire(store, capped.id, { pending: T0, missed: 998 })
      ]
      return { reads, turns, after: yield* store.wakes() }
    }))
    const [newer, stale, capped] = got.reads
    expect([newer!.missed, stale!.missed, capped!.missed]).toEqual([4, 4, 998])
    const fired = { slot: T0, pending: T0 + 2 * H, fired: 1, settled: false, due: T0 + 3 * H, updated: T0 + 2 * H + 1 }
    expect(got.after).toEqual([
      // 4 + 1 + 5 = 10 before the fire; the fire takes 4 + 1.
      { ...newer!, ...fired, missed: 5, lastTurn: got.turns[0]! },
      { ...stale!, ...fired, missed: 0, lastTurn: got.turns[1]! },
      // 998 + 1 + 5 is past the bound: it stays at 1,000.
      { ...capped!, ...fired, missed: 1000, lastTurn: got.turns[2]! }
    ])
  })

  test("the least and the greatest of the wake-ups' writes are null when a side is null, as SQLite's min and max give: a missed of null in pendWake (no fire waiting, and a fire waiting) and in fireWake's read (a newer slot waits) makes missed null, which the table refuses: StoreError, and nothing is written", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const idle = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const waits = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const newer = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      yield* store.pendWake(waits.id, { pending: T0, missed: 2, due: T0 + H })
      yield* store.pendWake(newer.id, { pending: T0, missed: 4, due: T0 + H })
      yield* store.pendWake(newer.id, { pending: T0 + 2 * H, missed: 5, due: T0 + 3 * H })
      const before = { wakes: yield* store.wakes(), turns: (yield* store.turns(null, 10)).length }
      yield* TestClock.setTime(T0 + 2 * H + 1)
      const none = null as unknown as number
      const tries: Array<Effect.Effect<unknown, StoreError>> = [
        store.pendWake(idle.id, { pending: T0, missed: none, due: T0 + H }),
        store.pendWake(waits.id, { pending: T0 + H, missed: none, due: T0 + 2 * H }),
        fire(store, newer.id, { pending: T0, missed: none })
      ]
      const results = []
      for (const one of tries) results.push(yield* Effect.result(one))
      return { before, results, after: { wakes: yield* store.wakes(), turns: (yield* store.turns(null, 10)).length } }
    }))
    // Each store's table refuses the null: its own text is its own (SQLite's
    // is a case of its test file).
    expect(got.results.map((result) => (result._tag === "Failure" ? [result.failure instanceof StoreError, result.failure.op] : ["no error", result.success]))).toEqual([
      [true, "pendWake"],
      [true, "pendWake"],
      [true, "fireWake"]
    ])
    expect(got.after).toEqual(got.before)
  })

  test("fireWake of a reminder stops it, why fired, with nothing left to fire; also a reminder whose pendWake gave a due, and one with a newer pending written between the read and the fire (ruling 4a): no StoreError", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const plain = made(yield* store.makeWake({ ...REMINDER, text: "plain", at: T0, first: T0 }, 20))
      const withDue = made(yield* store.makeWake({ ...REMINDER, text: "with a due", at: T0, first: T0 }, 20))
      const newer = made(yield* store.makeWake({ ...REMINDER, text: "a newer slot", at: T0, first: T0 }, 20))
      yield* store.pendWake(plain.id, { pending: T0, missed: 0, due: null })
      yield* store.pendWake(withDue.id, { pending: T0, missed: 0, due: T0 + H })
      yield* store.pendWake(newer.id, { pending: T0, missed: 1, due: null })
      yield* store.pendWake(newer.id, { pending: T0 + H, missed: 2, due: null })
      yield* TestClock.setTime(T0 + H + 1)
      const exits = [
        yield* Effect.exit(fire(store, plain.id, { pending: T0, missed: 0 })),
        yield* Effect.exit(fire(store, withDue.id, { pending: T0, missed: 0 })),
        yield* Effect.exit(fire(store, newer.id, { pending: T0, missed: 1 }))
      ]
      return { rows: [plain, withDue, newer], exits, after: yield* store.wakes(), active: yield* store.wakes({ active: true }) }
    }))
    expect(got.exits.map((exit) => Exit.isSuccess(exit) ? "fired" : String(Cause.squash(exit.cause)))).toEqual(["fired", "fired", "fired"])
    const turns = got.exits.map((exit) => (Exit.isSuccess(exit) ? exit.value : null))
    const stopped = { slot: T0, pending: null, missed: 0, due: null, fired: 1, settled: false, stopped: T0 + H + 1, why: "fired" as const, updated: T0 + H + 1 }
    expect(got.after).toEqual(got.rows.map((row, k) => ({ ...row, ...stopped, lastTurn: turns[k] ?? null })))
    expect(got.active).toEqual([])
  })

  test("fireWake fails with StoreError and writes nothing for a row that is not there, a stopped row, a row whose end is not counted, a row with no fire waiting, a read of a slot that is not the row's waiting one or older, and a turn that the chat has not", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const waits = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const unsettled = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const idle = made(yield* store.makeWake({ ...ROUTINE, first: T0 }, 20))
      const reminder = made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
      yield* store.pendWake(waits.id, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
      yield* store.pendWake(unsettled.id, { pending: T0, missed: 0, due: T0 + H })
      yield* fire(store, unsettled.id, { pending: T0, missed: 0 })
      yield* store.pendWake(unsettled.id, { pending: T0 + H, missed: 0, due: T0 + 2 * H })
      yield* store.pendWake(reminder.id, { pending: T0, missed: 0, due: null })
      yield* fire(store, reminder.id, { pending: T0, missed: 0 })
      const before = { wakes: yield* store.wakes(), turns: (yield* store.turns(null, 10)).length }
      const [turn] = yield* store.turns(null, 1)
      const tries = [
        store.fireWake(9, turn!.id, { pending: T0 + H, missed: 0 }),
        store.fireWake(reminder.id, turn!.id, { pending: T0, missed: 0 }),
        store.fireWake(unsettled.id, turn!.id, { pending: T0 + H, missed: 0 }),
        store.fireWake(idle.id, turn!.id, { pending: T0, missed: 0 }),
        store.fireWake(waits.id, turn!.id, { pending: T0 + 2 * H, missed: 0 }),
        store.fireWake(waits.id, 99, { pending: T0 + H, missed: 0 })
      ]
      const errors = []
      for (const one of tries) errors.push(yield* Effect.flip(one))
      return { before, errors, after: { wakes: yield* store.wakes(), turns: (yield* store.turns(null, 10)).length } }
    }))
    // The sixth, a turn that the chat has not: each store's database refuses
    // it, with its own text (SQLite's is a case of its test file).
    expect(got.errors.map((error, k) => [error instanceof StoreError, error.op, k < 5 ? String(error.cause) : null])).toEqual([
      [true, "fireWake", "Error: the chat has no wake-up 9"],
      [true, "fireWake", "Error: the wake-up 4 stopped, and has no fire"],
      [true, "fireWake", "Error: the wake-up 2's last fire is not settled"],
      [true, "fireWake", `Error: the wake-up 3 has no fire of the slot ${T0} waiting`],
      [true, "fireWake", `Error: the wake-up 1 has no fire of the slot ${T0 + 2 * H} waiting`],
      [true, "fireWake", null]
    ])
    expect(got.after).toEqual(got.before)
  })

  // The settle, the stops, the switch, the rows of a program (docs/wakeups.md,
  // sections 3 and 7)
  // --------------------------------------------------------------------------

  test("settleWake: each end of section 7's table: a done turn sets failed to 0, a failed turn and one that its ceiling stopped (end failed) add 1, a turn that the person stopped (end kept) keeps the count; each sets settled, updated the clock's time, and gives settled and not stopped", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      const ends = [
        { status: "failed", why: "the model failed", end: "failed" },
        { status: "done", why: null, end: "done" },
        { status: "stopped", why: CEILING_WHY, end: "failed" },
        { status: "stopped", why: "Stopped.", end: "kept" },
        { status: "done", why: null, end: "done" }
      ] as const
      const seen = []
      for (const [k, { end, status, why }] of ends.entries()) {
        const slot = T0 + k * H
        yield* TestClock.setTime(slot)
        const turn = yield* fireSlot(store, 1, slot)
        yield* store.endTurn(turn, status, why)
        const unsettled = unsettledOf(yield* store.unsettledWakes())
        yield* TestClock.setTime(slot + 1)
        const answer = yield* store.settleWake(1, turn, end)
        const row = (yield* wakeOf(store, 1))!
        seen.push({ unsettled, answer, row: [row.failed, row.settled, row.updated, row.stopped, row.why, row.lastTurn, row.fired] })
      }
      return seen
    }))
    expect(got).toEqual([
      { unsettled: [[1, 1, "failed", "the model failed", 0]], answer: { settled: true, stopped: false }, row: [1, true, T0 + 1, null, null, 1, 1] },
      { unsettled: [[1, 2, "done", null, 1]], answer: { settled: true, stopped: false }, row: [0, true, T0 + H + 1, null, null, 2, 2] },
      { unsettled: [[1, 3, "stopped", CEILING_WHY, 0]], answer: { settled: true, stopped: false }, row: [1, true, T0 + 2 * H + 1, null, null, 3, 3] },
      { unsettled: [[1, 4, "stopped", "Stopped.", 1]], answer: { settled: true, stopped: false }, row: [1, true, T0 + 3 * H + 1, null, null, 4, 4] },
      { unsettled: [[1, 5, "done", null, 1]], answer: { settled: true, stopped: false }, row: [0, true, T0 + 4 * H + 1, null, null, 5, 5] }
    ])
  })

  test(`settleWake: the second failure in a row (WAKE_FAILURES) stops the active row in the same statement, why failed, at the clock's time, with its waiting fire cleared (due, pending null, missed 0); it gives settled and stopped, and the row is in no answer of dueWakes, pendingWake or wakes({ active: true })`, async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      const first = yield* fireSlot(store, 1, T0)
      const once = yield* store.settleWake(1, first, "failed")
      yield* TestClock.setTime(T0 + H)
      const second = yield* fireSlot(store, 1, T0 + H)
      // While the turn runs, a newer slot comes and waits, with 4 missed.
      yield* TestClock.setTime(T0 + 3 * H)
      const pended = yield* store.pendWake(1, { pending: T0 + 3 * H, missed: 4, due: T0 + 4 * H })
      const waiting = (yield* wakeOf(store, 1))!
      yield* TestClock.setTime(T0 + 3 * H + 5)
      const twice = yield* store.settleWake(1, second, "failed")
      return {
        once,
        pended,
        waiting: [waiting.pending, waiting.missed, waiting.due],
        twice,
        row: (yield* wakeOf(store, 1))!,
        due: yield* store.dueWakes(Number.MAX_SAFE_INTEGER),
        pending: yield* store.pendingWake(),
        active: yield* store.wakes({ active: true })
      }
    }))
    expect(WAKE_FAILURES).toBe(2)
    expect(got.once).toEqual({ settled: true, stopped: false })
    expect(got.pended).toBe(true)
    expect(got.waiting).toEqual([T0 + 3 * H, 4, T0 + 4 * H])
    expect(got.twice).toEqual({ settled: true, stopped: true })
    expect(got.row).toMatchObject({
      failed: 2,
      settled: true,
      stopped: T0 + 3 * H + 5,
      why: "failed",
      stopCall: null,
      due: null,
      pending: null,
      missed: 0,
      slot: T0 + H,
      fired: 2,
      lastTurn: 2,
      updated: T0 + 3 * H + 5
    })
    expect(got.due).toEqual([])
    expect(Option.isNone(got.pending)).toBe(true)
    expect(got.active).toEqual([])
  })

  test("settleWake of a row stopped in between (by the person, by unwake, a reminder that fired) counts the end and settles it, and the row keeps its first stopped and why: a count that reaches 2 then stops nothing, and the answer is settled and not stopped", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const [call] = yield* functions(store, 1)
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "the third" }, 20))
      made(yield* store.makeWake({ ...REMINDER, at: T0 + 2 * H, first: T0 + 2 * H }, 20))
      // Routines 2 and 3 have failed once; each fires again.
      const turns: Array<number> = []
      for (const n of [2, 3]) {
        yield* store.settleWake(n, yield* fireSlot(store, n, T0), "failed")
        turns.push(yield* fireSlot(store, n, T0 + H))
      }
      // The reminder fires: it stops, why fired.
      const reminder = yield* fireSlot(store, 4, T0 + 2 * H)
      yield* TestClock.setTime(T0 + 3 * H)
      const stops = [yield* store.stopWake(2, "person"), yield* store.stopWake(3, "unwake", call!)]
      yield* TestClock.setTime(T0 + 4 * H)
      const answers = [
        yield* store.settleWake(2, turns[0]!, "failed"),
        yield* store.settleWake(3, turns[1]!, "failed"),
        yield* store.settleWake(4, reminder, "failed")
      ]
      const rows = (yield* store.wakes()).filter((wake) => wake.id > 1)
      return { stops, answers, rows: rows.map((row) => [row.id, row.failed, row.settled, row.stopped, row.why, row.stopCall, row.updated]) }
    }))
    expect(got.stops).toEqual([true, true])
    expect(got.answers).toEqual([{ settled: true, stopped: false }, { settled: true, stopped: false }, { settled: true, stopped: false }])
    expect(got.rows).toEqual([
      [2, 2, true, T0 + 3 * H, "person", null, T0 + 4 * H],
      [3, 2, true, T0 + 3 * H, "unwake", 2, T0 + 4 * H],
      [4, 1, true, T0, "fired", null, T0 + 4 * H]
    ])
  })

  test("settleWake while the chat's wake-ups are off: the end is counted, and the second failure stops the row, as when on (the switch is not read)", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
      const one = yield* fireSlot(store, 1, T0)
      const two = yield* fireSlot(store, 2, T0)
      const off = yield* store.setWakeups(false)
      const done = yield* store.settleWake(1, one, "done")
      const failed = yield* store.settleWake(2, two, "failed")
      // Off: no fire is pended; on, routine 2 fires again; off, its second
      // failure is counted.
      yield* store.setWakeups(true)
      const again = yield* fireSlot(store, 2, T0 + H)
      yield* store.setWakeups(false)
      const stopped = yield* store.settleWake(2, again, "failed")
      return { off, done, failed, stopped, chat: (yield* store.chat).wakeups, rows: (yield* store.wakes()).map((row) => [row.id, row.failed, row.settled, row.why]) }
    }))
    expect(got).toEqual({
      off: true,
      done: { settled: true, stopped: false },
      failed: { settled: true, stopped: false },
      stopped: { settled: true, stopped: true },
      chat: false,
      rows: [[1, 0, true, null], [2, 2, true, "failed"]]
    })
  })

  test("settleWake changes nothing, and gives not settled, for another turn than the row's last, an older one, a second settle, a row that never fired, and a row that is not there: the row and its updated as they were", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "never fired" }, 20))
      const first = yield* fireSlot(store, 1, T0)
      yield* store.settleWake(1, first, "failed")
      yield* TestClock.setTime(T0 + H)
      const last = yield* fireSlot(store, 1, T0 + H)
      // A turn of no fire of this row.
      const other = (yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })).id
      const before = yield* Effect.promise(() => wakeRow(file, 1))
      yield* TestClock.setTime(T0 + 2 * H)
      const refused = [
        yield* store.settleWake(1, other, "failed"),
        yield* store.settleWake(1, first, "failed"),
        yield* store.settleWake(1, 99, "done"),
        yield* store.settleWake(2, last, "failed"),
        yield* store.settleWake(9, last, "failed")
      ]
      const unchanged = yield* Effect.promise(() => wakeRow(file, 1))
      const settled = yield* store.settleWake(1, last, "done")
      const after = yield* Effect.promise(() => wakeRow(file, 1))
      yield* TestClock.setTime(T0 + 3 * H)
      const twice = [yield* store.settleWake(1, last, "failed"), yield* store.settleWake(1, last, "done")]
      return { before, refused, unchanged, settled, after, twice, again: yield* Effect.promise(() => wakeRow(file, 1)), never: yield* Effect.promise(() => wakeRow(file, 2)) }
    }))
    const none = { settled: false, stopped: false }
    expect(got.refused).toEqual([none, none, none, none, none])
    expect(got.unchanged).toEqual(got.before)
    expect(got.before).toMatchObject({ failed: 1, settled: 0, last_turn: 2 })
    expect(got.settled).toEqual({ settled: true, stopped: false })
    expect(got.after).toMatchObject({ failed: 0, settled: 1, last_turn: 2, updated: T0 + 2 * H })
    expect(got.twice).toEqual([none, none])
    expect(got.again).toEqual(got.after)
    expect(got.never).toMatchObject({ failed: 0, settled: 1, last_turn: null, updated: T0 })
  })

  test("settleWake, stopWake and setWakeups are each the write of a note: in the note's transaction they commit with its page, and a transaction that fails after them leaves neither the page nor their change", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
      yield* store.settleWake(1, yield* fireSlot(store, 1, T0), "failed")
      const turn = yield* fireSlot(store, 1, T0 + H)
      // The form of `Turns.note`'s `write` (turn.ts).
      const writes: ReadonlyArray<readonly [string, (first: Message) => Effect.Effect<void, StoreError>]> = [
        ["Wake-up 1 stopped: two of its turns in a row failed or reached the ceiling.", () => store.settleWake(1, turn, "failed")],
        ["Wake-up 2 stopped by the person.", () => store.stopWake(2, "person")],
        ["The person turned the wake-ups off.", () => store.setWakeups(false)]
      ]
      // As `Turns.note` logs a note: its page, then the write, in one
      // transaction.
      const note = (text: string, write: (first: Message) => Effect.Effect<void, StoreError>) =>
        store.transaction(Effect.flatMap(store.append([{ kind: "note", text }]), (written) => write(written[0]!)))
      const failed = []
      for (const [text, write] of writes) failed.push(yield* Effect.flip(store.transaction(Effect.andThen(note(text, write), Effect.fail("after the write")))))
      const kept = { rows: [yield* Effect.promise(() => wakeRow(file, 1)), yield* Effect.promise(() => wakeRow(file, 2))], chat: (yield* store.chat).wakeups, count: yield* store.count }
      for (const [text, write] of writes) yield* note(text, write)
      const notes = (yield* store.messages(0, 100)).filter((message) => message.kind === "note").map((message) => message.text)
      return { failed, kept, notes, rows: (yield* store.wakes()).map((row) => [row.id, row.settled, row.failed, row.why]), chat: (yield* store.chat).wakeups }
    }))
    expect(got.failed).toEqual(["after the write", "after the write", "after the write"])
    expect(got.kept.rows[0]).toMatchObject({ settled: 0, failed: 1, stopped: null })
    expect(got.kept.rows[1]).toMatchObject({ stopped: null, why: null })
    expect(got.kept.chat).toBe(true)
    expect(got.kept.count).toBe(0)
    expect(got.notes).toEqual([
      "Wake-up 1 stopped: two of its turns in a row failed or reached the ceiling.",
      "Wake-up 2 stopped by the person.",
      "The person turned the wake-ups off."
    ])
    expect(got.rows).toEqual([[1, true, 2, "failed"], [2, true, 0, "person"]])
    expect(got.chat).toBe(false)
  })

  test("stopWake: an active row stops at the clock's time, why unwake with the function's call or person with none, with its waiting fire cleared (due, pending null, missed 0), and gives true; it is in no answer of dueWakes or pendingWake; its end, if not counted, stays to count", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const [call] = yield* functions(store, 1)
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "the other" }, 20))
      // 1: fired, and a newer slot waits, with 3 missed; its end not counted.
      const turn = yield* fireSlot(store, 1, T0)
      yield* store.pendWake(1, { pending: T0 + H, missed: 3, due: T0 + 2 * H })
      // 2: a fire waits.
      yield* store.pendWake(2, { pending: T0, missed: 1, due: T0 + H })
      yield* TestClock.setTime(T0 + 2 * H)
      const before = { due: (yield* store.dueWakes(T0 + 2 * H)).map((wake) => wake.id), pending: Option.map(yield* store.pendingWake(), (wake) => wake.id) }
      const stops = [yield* store.stopWake(1, "unwake", call!), yield* store.stopWake(2, "person")]
      return {
        before,
        stops,
        rows: yield* store.wakes(),
        due: yield* store.dueWakes(Number.MAX_SAFE_INTEGER),
        pending: yield* store.pendingWake(),
        unsettled: unsettledOf(yield* store.unsettledWakes()),
        turn,
        call: call!
      }
    }))
    expect(got.before).toEqual({ due: [2, 1], pending: Option.some(2) })
    expect(got.stops).toEqual([true, true])
    const stopped = { stopped: T0 + 2 * H, due: null, pending: null, missed: 0, updated: T0 + 2 * H }
    expect(got.rows[0]).toMatchObject({ ...stopped, why: "unwake", stopCall: got.call, settled: false, lastTurn: got.turn, slot: T0, fired: 1 })
    expect(got.rows[1]).toMatchObject({ ...stopped, why: "person", stopCall: null, settled: true, lastTurn: null, slot: null, fired: 0 })
    expect(got.due).toEqual([])
    expect(Option.isNone(got.pending)).toBe(true)
    expect(got.unsettled).toEqual([[1, got.turn, "running", null, 0]])
  })

  test("stopWake changes nothing and gives false for a row that stopped already (each why, each kind of stop) and a row that is not there; the person's stop with a call fails with StoreError and writes nothing; a call that the chat has not is refused by the reference", async () => {
    const file = h.newFile()
    const got = await withClock(file, Effect.gen(function*() {
      const store = yield* Store
      const [call] = yield* functions(store, 1)
      yield* TestClock.setTime(T0)
      made(yield* store.makeWake(ROUTINE, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "two" }, 20))
      made(yield* store.makeWake({ ...REMINDER, at: T0, first: T0 }, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "four" }, 20))
      made(yield* store.makeWake({ ...ROUTINE, text: "five" }, 20))
      yield* store.stopWake(1, "unwake", call!)
      yield* store.stopWake(2, "person")
      yield* fireSlot(store, 3, T0)
      // 4 stops at its second failure.
      yield* store.settleWake(4, yield* fireSlot(store, 4, T0), "failed")
      yield* store.settleWake(4, yield* fireSlot(store, 4, T0 + H), "failed")
      const before = yield* Effect.promise(() => Promise.all([1, 2, 3, 4].map((n) => wakeRow(file, n))))
      yield* TestClock.setTime(T0 + 5 * H)
      const again = []
      for (const n of [1, 2, 3, 4]) again.push(yield* store.stopWake(n, "person"), yield* store.stopWake(n, "unwake", call!), yield* store.stopWake(n, "unwake"))
      const missing = [yield* store.stopWake(9, "person"), yield* store.stopWake(9, "unwake", call!)]
      const after = yield* Effect.promise(() => Promise.all([1, 2, 3, 4].map((n) => wakeRow(file, n))))
      const five = yield* Effect.promise(() => wakeRow(file, 5))
      const refused = [yield* Effect.flip(store.stopWake(5, "person", call!)), yield* Effect.flip(store.stopWake(5, "unwake", 99))]
      return { before, again, missing, after, five, refused, still: yield* Effect.promise(() => wakeRow(file, 5)) }
    }))
    expect(got.before.map((row) => row!["why"])).toEqual(["unwake", "person", "fired", "failed"])
    expect(got.again).toEqual(Array.from({ length: 12 }, () => false))
    expect(got.missing).toEqual([false, false])
    expect(got.after).toEqual(got.before)
    expect(got.refused.map((error) => [error instanceof StoreError, error.op])).toEqual([[true, "stopWake"], [true, "stopWake"]])
    expect(String(got.refused[0]!.cause)).toBe("Error: the person's stop of a wake-up has no call")
    expect(String((got.refused[1]!.cause as { readonly cause?: unknown }).cause)).toContain("ConstraintError")
    expect(got.still).toEqual(got.five)
    expect(got.five).toMatchObject({ stopped: null, why: null, stop_call: null })
  })

  // A turn's ceiling (docs/wakeups.md, sections 3 and 6)
  // ----------------------------------------------------

  test("startTurn refuses a ceiling of steps with no tokens, tokens with no steps, 0, a negative number, a fraction, NaN and Infinity with StoreError before its transaction: no turn, head or pick is written; the next turn takes id 1", async () => {
    const file = h.newFile()
    const tries: ReadonlyArray<{ readonly steps?: number | null; readonly tokens?: number | null }> = [
      { steps: 20 },
      { steps: 20, tokens: null },
      { tokens: 100 },
      { steps: null, tokens: 100 },
      { steps: 0, tokens: 100 },
      { steps: 20, tokens: 0 },
      { steps: -1, tokens: 100 },
      { steps: 20, tokens: -100 },
      { steps: 1.5, tokens: 100 },
      { steps: 20, tokens: 100.25 },
      { steps: Number.NaN, tokens: 100 },
      { steps: 20, tokens: Number.POSITIVE_INFINITY }
    ]
    const counts = async () => (await h.rows(file, "select (select count(*) from everchat_turn) as turns, (select count(*) from everchat_head) as heads, (select count(*) from everchat_pick) as picks"))[0]
    await h.withStore(file, Effect.void)
    const before = await counts()
    const got = await h.withStore(file, Effect.gen(function*() {
      const store = yield* Store
      const errors = []
      for (const [k, ceiling] of tries.entries()) {
        errors.push(yield* Effect.flip(store.startTurn({ pick: { ...PICK, model: `refused ${k}` }, head: `{"refused":${k}}`, firstMsg: 0, ...ceiling })))
      }
      const after = yield* Effect.promise(() => counts())
      return { errors, after, next: yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0, steps: 20, tokens: 100 }) }
    }))
    expect(got.errors.map((error) => [error instanceof StoreError, error.op])).toEqual(tries.map(() => [true, "startTurn"]))
    expect(got.errors.map((error) => String(error.cause))).toEqual(tries.map((ceiling) =>
      `Error: a turn's ceiling is both steps and tokens, each a whole number over 0, or neither, not ${ceiling.steps ?? null} steps and ${ceiling.tokens ?? null} tokens`
    ))
    expect(got.after).toEqual(before)
    expect([got.next.id, got.next.steps, got.next.tokens]).toEqual([1, 20, 100])
  })
}
