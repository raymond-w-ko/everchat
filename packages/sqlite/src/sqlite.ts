// SQLite
// ======
// The store over SQLite: the SQL of `Store` and `Reads` (store.ts) over
// Effect's `SqlClient`, and the layers that build them. No other module uses
// SQL. The rules that the store keeps are in `store.ts`; the tables are in
// `schema.ts`, and the file, its driver and its pragmas in `database.ts`.
//
// Each call of the store ends, done or with `StoreError` and its `op`,
// within the limit `store` (`Database.Limits`, 5,000 ms when it is not
// given), which each layer over a file takes as its last argument: the
// driver's wait on a locked file is the timer (database.ts says what it
// bounds and what it does not, statement by statement). A transaction is
// one call: it waits at its `BEGIN IMMEDIATE`, and one that fails there
// has written nothing. A layer of the store, when it is built, first opens
// the file (database.ts: its three waits, within 3 × `store` on a file not
// yet in WAL mode, within `store` on one in WAL mode); then the store's
// launch (`open`, below) is a transaction of its own, which waits at its
// `BEGIN IMMEDIATE` within `store` and fails with `StoreError` (`launch`).
// So `storeLayer` is built within 4 × `store` on a file not yet in WAL
// mode, within 2 × `store` on one in WAL mode; `chatsLayer` within the
// open's bound, and each launch of `Chats.store` within `store`. These
// bounds are sums of the waits on the file; the time of the scheduler, of a
// process's start and of the statements themselves is on top. An open that
// fails writes no launch; database.ts says what the file holds then (on a
// new file whose change to WAL fails: the schema and the mark).
//
// The tenant boundary (docs/schema.html, section 1). The store is bound to
// one chat: the reads and the writes are built for it, once (`reading(sql,
// bound)`, `make`), and each statement on a table of a chat has that chat in
// its `where`, or in the row that it inserts; a join carries it on both
// sides. Each statement on `everchat_chat` names the tenant too. The shared
// lists (`everchat_pick`, `everchat_kind`) have no chat. No member of the
// store takes a chat. A chat is found only by its tenant and its UUID
// (`find`); a chat that is not the tenant's is `NoChat`, whatever the
// reason. The tag `Chats` makes the chats of many tenants in one file. The
// local file has one tenant and one chat: the first launch makes them
// (`bind`), and the local layers then take the same path as the tag
// (`open`, `reading`).
//
// The program makes each row's number, in the transaction of its write: one
// more than the chat's highest `n` in that table, from 1 (`next`). A table's
// own coordinates go on from 0, as before: a message's `i`, a turn's item's
// `n` in its turn, a message's image's `n` in its message. An event's `n`
// is the chat's counter `seq` plus 1 (`addEvent`). The database makes no
// number but the ids of a chat, a pick and a kind. The store gives a row's `n` as its `id` (`seq` for a
// diagnostic), and a chat's UUID, 16 bytes in the file, as text.

import { Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import * as Database from "./database.ts"
import {
  type CallEnd,
  Chats,
  DatabaseVersion,
  type Event,
  Kind,
  KINDS,
  type Launch,
  type LaunchInput,
  LaunchLive,
  type Keyed,
  type Message,
  type NewCall,
  type NewDiagnostic,
  type NewEvent,
  type NewImage,
  type NewMessage,
  type NewNode,
  type NewTurn,
  type NewUsage,
  NoChat,
  Node,
  type Options,
  Part,
  Pick,
  Reads,
  type Reading,
  SENDER_KEY,
  Store,
  StoreError,
  type Turn,
  type UsageFilter,
  type UsageRecord,
  type View,
  ViewName
} from "@everchat/core/store"

// Does a process of this host run? A test can replace it.
export const ProcessAlive = Context.Reference<(pid: number) => boolean>("everchat/store/ProcessAlive", {
  defaultValue: () => (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: it runs, and it is not ours to signal.
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
})

// Rows, as SQLite gives them
// --------------------------

const MessageRow = Schema.Struct({
  i: Schema.Int,
  kind: Kind,
  text: Schema.String,
  size: Schema.Int,
  more: Schema.Literals([0, 1]),
  line: Schema.NullOr(Schema.String),
  turn: Schema.NullOr(Schema.Int),
  call: Schema.NullOr(Schema.Int),
  launch: Schema.Int,
  created: Schema.Int
})

const ViewRow = Schema.Struct({
  name: ViewName,
  parts: Schema.fromJsonString(Schema.Array(Part)),
  batch: Schema.Literals([0, 1])
})

const ChatRow = Schema.Struct({
  uuid: Schema.Uint8Array,
  ...Pick.fields,
  goal: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(Schema.String),
  taken: Schema.Int,
  seq: Schema.Int,
  created: Schema.Int,
  updated: Schema.Int
})

const ImageRow = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  type: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  source: Schema.Literals(["person", "tool"]),
  created: Schema.Int,
  bytes: Schema.Uint8Array
})

const TurnRow = Schema.Struct({
  id: Schema.Int,
  agent: Schema.NullOr(Schema.Int),
  status: Schema.Literals(["running", "done", "stopped", "failed"]),
  ...Pick.fields,
  head: Schema.String,
  firstMsg: Schema.Int,
  launch: Schema.Int,
  created: Schema.Int,
  ended: Schema.NullOr(Schema.Int),
  why: Schema.NullOr(Schema.String)
})

const TurnItemRow = Schema.Struct({
  n: Schema.Int,
  kind: Schema.Literals(["user", "turn", "back"]),
  body: Schema.String,
  created: Schema.Int
})

const CallRow = Schema.Struct({
  id: Schema.Int,
  turn: Schema.Int,
  parent: Schema.NullOr(Schema.Int),
  vendorId: Schema.NullOr(Schema.String),
  fn: Schema.String,
  input: Schema.String,
  output: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "done", "failed", "denied", "cut"]),
  size: Schema.NullOr(Schema.Int),
  shown: Schema.NullOr(Schema.Int),
  created: Schema.Int,
  ended: Schema.NullOr(Schema.Int)
})

const SERVED = Schema.Literals(["turn", "compaction", "goal"])

const UsageRow = Schema.Struct({
  id: Schema.Int,
  served: SERVED,
  turn: Schema.NullOr(Schema.Int),
  nodeL: Schema.NullOr(Schema.Int),
  nodeI: Schema.NullOr(Schema.Int),
  ...Pick.fields,
  request: Schema.NullOr(Schema.String),
  input: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
  output: Schema.Int,
  searches: Schema.Int,
  micros: Schema.NullOr(Schema.Int),
  expected: Schema.NullOr(Schema.Int),
  created: Schema.Int
})

const UsageTotalRow = Schema.Struct({
  served: SERVED,
  requests: Schema.Int,
  input: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
  output: Schema.Int
})

const LaunchRow = Schema.Struct({
  id: Schema.Int,
  pid: Schema.Int,
  host: Schema.String,
  cwd: Schema.String,
  version: Schema.String,
  created: Schema.Int,
  ended: Schema.NullOr(Schema.Int),
  why: Schema.NullOr(Schema.String)
})

const LevelRow = Schema.Struct({ l: Schema.Int, built: Schema.Int })

// An event's row, with the program of a `call` and the end of an `end`.
const EventRow = Schema.Struct({
  n: Schema.Int,
  type: Schema.Literals(["accepted", "start", "call", "message", "end"]),
  turn: Schema.NullOr(Schema.Int),
  call: Schema.NullOr(Schema.Int),
  msg: Schema.NullOr(Schema.Int),
  msgLast: Schema.NullOr(Schema.Int),
  program: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Literals(["running", "done", "stopped", "failed"])),
  why: Schema.NullOr(Schema.String)
})

const DiagnosticRow = Schema.Struct({
  seq: Schema.Int,
  level: Schema.Literals(["debug", "info", "warn", "error"]),
  source: Schema.String,
  text: Schema.String,
  launch: Schema.Int,
  created: Schema.Int
})

const decodeDiagnostics = Schema.decodeUnknownEffect(Schema.Array(DiagnosticRow))
const decodeUsage = Schema.decodeUnknownEffect(Schema.Array(UsageRow))
const decodeUsageTotals = Schema.decodeUnknownEffect(Schema.Array(UsageTotalRow))
const decodeLaunches = Schema.decodeUnknownEffect(Schema.Array(LaunchRow))
const decodeLevels = Schema.decodeUnknownEffect(Schema.Array(LevelRow))
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(EventRow))
const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(TurnRow))
const decodeTurnItems = Schema.decodeUnknownEffect(Schema.Array(TurnItemRow))
const decodeCalls = Schema.decodeUnknownEffect(Schema.Array(CallRow))
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(MessageRow))
const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(Node))
const decodeViews = Schema.decodeUnknownEffect(Schema.Array(ViewRow))
const decodeChats = Schema.decodeUnknownEffect(Schema.Array(ChatRow))
const decodeImages = Schema.decodeUnknownEffect(Schema.Array(ImageRow))

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).length

// SQLite takes at most 32,766 values in one statement.
const KEYS_PER_QUERY = 10_000

const failed = (op: string) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.mapError(self, (cause) => new StoreError({ op, cause }))

// The one row of a query that must give one row. None, or more than one, is
// a defect: a read that lost its chat's `=` could still give the right row
// first, by the order of the file, and pass.
const only = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> => {
  const row = rows[0]
  return row === undefined
    ? Effect.die(new Error("the store expected one row and got none"))
    : rows.length > 1
    ? Effect.die(new Error(`the store expected one row and got ${rows.length}`))
    : Effect.succeed(row)
}

// The chat
// --------

// The chat that a store is bound to: its tenant, and its id in the file.
interface Bound {
  readonly tenant: Uint8Array
  readonly chat: number
}

// A UUID as 16 bytes, and back as text (8-4-4-4-12, lower case).
const uuidBytes = (uuid: string): Uint8Array => Uint8Array.from(uuid.replaceAll("-", "").match(/../g) ?? [], (hex) => parseInt(hex, 16))
const uuidText = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}

// A UUID that comes in as text, as 16 bytes; none for a text that is no
// UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const parsed = (text: string): Option.Option<Uint8Array> => (UUID.test(text) ? Option.some(uuidBytes(text)) : Option.none())

// The chat of `tenant` whose UUID is `uuid`. This is the one statement that
// finds a chat: by its tenant and its UUID, never by its UUID alone.
const find = (sql: SqlClient.SqlClient, tenant: Uint8Array, uuid: Uint8Array) =>
  Effect.map(
    sql<{ id: number }>`select id from everchat_chat where tenant = ${tenant} and uuid = ${uuid}`,
    (rows) => Option.map(Option.fromUndefinedOr(rows[0]), (row): Bound => ({ tenant, chat: row.id }))
  )

// The chat of the tenant `tenant` and the UUID `chat`, both as text. One
// answer, `NoChat`, for a text that is no UUID, a UUID that no chat has,
// and a chat of another tenant.
const chatOf = (sql: SqlClient.SqlClient, tenant: string, chat: string) =>
  Effect.gen(function*() {
    const ids = Option.all([parsed(tenant), parsed(chat)])
    const found = Option.isSome(ids) ? yield* find(sql, ids.value[0], ids.value[1]) : Option.none<Bound>()
    return Option.isSome(found) ? found.value : yield* new NoChat()
  })

// The file's tenant, when it has one. The local file has at most one.
const theTenant = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const rows = yield* sql<{ id: Uint8Array }>`select id from everchat_tenant`
    if (rows.length > 1) return yield* Effect.die(new Error(`the local file holds one tenant, and this one holds ${rows.length}`))
    return Option.fromUndefinedOr(rows[0]?.id)
  })

// The UUID of the chat of `tenant`, when it has one. In the local file a
// tenant has at most one.
const theChat = (sql: SqlClient.SqlClient, tenant: Uint8Array) =>
  Effect.gen(function*() {
    const rows = yield* sql<{ uuid: Uint8Array }>`select uuid from everchat_chat where tenant = ${tenant}`
    if (rows.length > 1) return yield* Effect.die(new Error(`the local file holds one chat, and this one holds ${rows.length}`))
    return Option.fromUndefinedOr(rows[0]?.uuid)
  })

// The file's one chat, when it has one: its tenant and its UUID, then the
// chat by both (`find`), as `Chats` finds a chat.
const bound = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const tenant = yield* theTenant(sql)
    if (Option.isNone(tenant)) return Option.none<Bound>()
    const uuid = yield* theChat(sql, tenant.value)
    return Option.isNone(uuid) ? Option.none<Bound>() : yield* find(sql, tenant.value, uuid.value)
  })

// The tables whose rows the program numbers with `n`, from 1 in each chat.
type Numbered = "everchat_launch" | "everchat_head" | "everchat_turn" | "everchat_call" | "everchat_image" | "everchat_usage" | "everchat_log"

// The next `n` of the chat in `table`. Only inside the transaction of the
// write that takes it.
const next = (sql: SqlClient.SqlClient, chat: number, table: Numbered) =>
  Effect.map(
    Effect.flatMap(sql.unsafe<{ next: number }>(`select coalesce(max(n), 0) + 1 as next from ${table} where chat = ?`, [chat]), only),
    (row) => row.next
  )

// The id of the chat's next message.
const nextMessage = (sql: SqlClient.SqlClient, chat: number) =>
  Effect.map(Effect.flatMap(sql<{ next: number }>`select coalesce(max(i), -1) + 1 as next from everchat_msg where chat = ${chat}`, only), (row) => row.next)

// A turn with its pick and its head. `rest` goes on with ` and ...` or
// ` order by ...`; the chat is the first parameter.
const TURN = `select t.n as id, t.agent, t.status, p.vendor, p.model, p.effort, p.speed, h.body as head,
                     t.first_msg as firstMsg, t.launch, t.created, t.ended, t.why
              from everchat_turn t join everchat_pick p on p.id = t.pick
                   join everchat_head h on h.chat = t.chat and h.n = t.head
              where t.chat = ?`

const turnRows = (sql: SqlClient.SqlClient, chat: number, rest: string, params: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    const rows = yield* sql.unsafe(TURN + rest, [chat, ...params])
    return (yield* decodeTurns(rows)).map(({ effort, model, speed, vendor, ...rest }): Turn => ({ ...rest, pick: { vendor, model, effort, speed } }))
  })

// A call. `rest` goes on as in TURN; the chat is the first parameter.
const CALL = "select n as id, turn, parent, vendor_id as vendorId, fn, input, output, status, size, shown, created, ended from everchat_call where chat = ?"

// The reads
// ---------

// The reads of the chat `bound`.
const reading = (sql: SqlClient.SqlClient, { chat: id, tenant }: Bound): Reading => {
  const chat = Effect.gen(function*() {
    const rows = yield* sql`
      select c.uuid, p.vendor, p.model, p.effort, p.speed, c.goal, c.draft, c.taken, c.seq, c.created, c.updated
      from everchat_chat c join everchat_pick p on p.id = c.pick
      where c.tenant = ${tenant} and c.id = ${id}`
    const row = yield* only(yield* decodeChats(rows))
    const { effort, model, speed, uuid, vendor, ...rest } = row
    return { uuid: uuidText(uuid), ...rest, pick: { vendor, model, effort, speed } }
  }).pipe(failed("chat"), Effect.withSpan("Store.chat"))

  const count = nextMessage(sql, id).pipe(failed("count"), Effect.withSpan("Store.count"))

  // The events after `after`, then the messages that they name, in one
  // transaction: one state of the database, so that no event names a
  // message that the answer lacks. A `call` takes its program from its
  // call's row, an `end` its status and why from its turn's row (an ended
  // turn's row does not change). Each join names the chat on both sides.
  // A number given twice, or a row that lacks what its event reports, is a
  // defect: a read that lost its chat's `=` could still give the right rows
  // first, by the order of the file, and pass.
  const eventsAfter = Effect.fn("Store.eventsAfter")(function*(after: number, limit: number) {
    if (!Number.isSafeInteger(after) || after < 0) {
      return yield* Effect.die(new Error(`eventsAfter: after must be an integer from 0, and it is ${after}`))
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return yield* Effect.die(new Error(`eventsAfter: limit must be an integer from 1 to 1000, and it is ${limit}`))
    }
    return yield* sql.withTransaction(Effect.gen(function*() {
      const rows = yield* decodeEvents(yield* sql`
        select e.n, e.type, e.turn, e.call, e.msg, e.msg_last as msgLast, c.input as program, t.status, t.why
        from everchat_event e
        left join everchat_call c on c.chat = e.chat and c.n = e.call and e.type = 'call'
        left join everchat_turn t on t.chat = e.chat and t.n = e.turn and e.type = 'end'
        where e.chat = ${id} and e.n > ${after}
        order by e.n
        limit ${limit}`)
      const named = rows.flatMap((row) => (row.msg === null || row.msgLast === null ? [] : [row.msg, row.msgLast]))
      const low = Math.min(...named)
      const high = Math.max(...named)
      const found = named.length === 0 ? [] : (yield* decodeMessages(yield* sql`
        select m.i, k.name as kind, m.text, m.size, m.more, m.line, m.turn, m.call, m.launch, m.created
        from everchat_msg m join everchat_kind k on k.id = m.kind
        where m.chat = ${id} and m.i >= ${low} and m.i <= ${high}
        order by m.i`)).map((row): Message => ({ ...row, more: row.more === 1 }))
      if (found.length !== (named.length === 0 ? 0 : high - low + 1) || found.some((message, k) => message.i !== low + k)) {
        return yield* Effect.die(new Error(`the store expected the messages ${low} to ${high} once each, and got ${found.length}`))
      }
      const events: Array<Event> = []
      for (const row of rows) {
        const { msg, msgLast, n, turn } = row
        const last = events.at(-1)?.n ?? after
        const event: Event | null = n <= last
          ? null
          : (row.type === "accepted" || row.type === "message") && msg !== null && msgLast !== null
          ? row.type === "accepted"
            ? { type: "accepted", n, messages: found.slice(msg - low, msgLast - low + 1) }
            : msg === msgLast
            ? { type: "message", n, message: found[msg - low]! }
            : null
          : row.type === "start" && turn !== null
          ? { type: "start", n, turn }
          : row.type === "call" && turn !== null && row.call !== null && row.program !== null
          ? { type: "call", n, turn, call: row.call, program: row.program }
          : row.type === "end" && turn !== null && row.status !== null && row.status !== "running"
          ? { type: "end", n, turn, status: row.status, why: row.why }
          : null
        if (event === null) {
          return yield* Effect.die(new Error(`the store could not read the event ${n} (${row.type}) after ${last}`))
        }
        events.push(event)
      }
      return events
    }))
  }, failed("eventsAfter"))

  const messages = Effect.fn("Store.messages")(function*(from: number, to: number) {
    const rows = yield* sql`
      select m.i, k.name as kind, m.text, m.size, m.more, m.line, m.turn, m.call, m.launch, m.created
      from everchat_msg m join everchat_kind k on k.id = m.kind
      where m.chat = ${id} and m.i >= ${from} and m.i < ${to}
      order by m.i`
    return (yield* decodeMessages(rows)).map((row): Message => ({ ...row, more: row.more === 1 }))
  }, failed("messages"))

  const messagesAfter = Effect.fn("Store.messagesAfter")(function*(after: number, kinds: ReadonlyArray<Kind>) {
    const rows = yield* sql`
      select m.i, k.name as kind, m.text, m.size, m.more, m.line, m.turn, m.call, m.launch, m.created
      from everchat_msg m join everchat_kind k on k.id = m.kind
      where m.chat = ${id} and m.i > ${after} and ${sql.in("m.kind", kinds.map((kind) => KINDS[kind]))}
      order by m.i`
    return (yield* decodeMessages(rows)).map((row): Message => ({ ...row, more: row.more === 1 }))
  }, failed("messagesAfter"))

  // The message of a key, on one state of the database: its first page by
  // its key (the index (chat, sender_key)), its pages from there up to the
  // first that does not continue (`more` 0), and its `accepted` event (the
  // index (chat, msg)). Each statement names the chat. A second row for the
  // key, a message with no last page, and no `accepted` event (or two) are
  // a defect: a statement that lost its chat's `=` could still give the
  // right row first, by the order of the file, and pass.
  const keyed = Effect.fn("Store.keyed")(function*(key: string) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const firsts = yield* sql<{ i: number }>`select i from everchat_msg where chat = ${id} and sender_key = ${key}`
      if (firsts.length === 0) return Option.none<Keyed>()
      const { i: first } = yield* only(firsts)
      const { last } = yield* only(
        yield* sql<{ last: number | null }>`select min(i) as last from everchat_msg where chat = ${id} and i >= ${first} and more = 0`
      )
      if (last === null) {
        return yield* Effect.die(new Error(`the store expected the last page of the message ${first}, and found none`))
      }
      const pages = (yield* decodeMessages(yield* sql`
        select m.i, k.name as kind, m.text, m.size, m.more, m.line, m.turn, m.call, m.launch, m.created
        from everchat_msg m join everchat_kind k on k.id = m.kind
        where m.chat = ${id} and m.i >= ${first} and m.i <= ${last}
        order by m.i`)).map((row): Message => ({ ...row, more: row.more === 1 }))
      const { n } = yield* only(
        yield* sql<{ n: number }>`select n from everchat_event where chat = ${id} and type = 'accepted' and msg = ${first}`
      )
      return Option.some<Keyed>({ messages: pages, accepted: n })
    }))
  }, failed("keyed"))

  const imagesOf = Effect.fn("Store.imagesOf")(function*(i: number) {
    const rows = yield* sql<{ image: number }>`select image from everchat_msg_image where chat = ${id} and msg = ${i} order by n`
    return rows.map((row) => row.image)
  }, failed("imagesOf"))

  const node = Effect.fn("Store.node")(function*(l: number, i: number) {
    const rows = yield* sql`select l, i, text, size, created from everchat_node where chat = ${id} and l = ${l} and i = ${i}`
    return Option.fromUndefinedOr((yield* decodeNodes(rows))[0])
  }, failed("node"))

  const nodes = Effect.fn("Store.nodes")(function*(parts: ReadonlyArray<Part>) {
    const found: Array<Node> = []
    for (let at = 0; at < parts.length; at += KEYS_PER_QUERY) {
      const some = parts.slice(at, at + KEYS_PER_QUERY)
      const rows = yield* sql.unsafe(
        `select l, i, text, size, created from everchat_node
         where chat = ? and (l, i) in (values ${some.map(() => "(?, ?)").join(", ")})`,
        [id, ...some.flat()]
      )
      found.push(...(yield* decodeNodes(rows)))
    }
    return found
  }, failed("nodes"))

  const view = Effect.fn("Store.view")(function*(name: ViewName) {
    const rows = yield* decodeViews(yield* sql`select name, parts, batch from everchat_view where chat = ${id} and name = ${name}`)
    return Option.map(Option.fromUndefinedOr(rows[0]), (row): View => ({ ...row, batch: row.batch === 1 }))
  }, failed("view"))

  const image = Effect.fn("Store.image")(function*(n: number) {
    const rows = yield* sql`
      select n as id, name, type, width, height, source, created, bytes from everchat_image where chat = ${id} and n = ${n}`
    return Option.fromUndefinedOr((yield* decodeImages(rows))[0])
  }, failed("image"))

  const head = Effect.fn("Store.head")(function*(n: number) {
    const rows = yield* sql<{ body: string }>`select body from everchat_head where chat = ${id} and n = ${n}`
    return Option.map(Option.fromUndefinedOr(rows[0]), (row) => row.body)
  }, failed("head"))

  const runningTurns = Effect.fn("Store.runningTurns")(function*(agent: number | null) {
    return yield* (agent === null
      ? turnRows(sql, id, " and t.status = 'running' and t.agent is null order by t.n", [])
      : turnRows(sql, id, " and t.status = 'running' and t.agent = ? order by t.n", [agent]))
  }, failed("runningTurns"))

  const turnItems = Effect.fn("Store.turnItems")(function*(turn: number) {
    return [...(yield* decodeTurnItems(yield* sql`select n, kind, body, created from everchat_turn_item where chat = ${id} and turn = ${turn} order by n`))]
  }, failed("turnItems"))

  const calls = Effect.fn("Store.calls")(function*(turn: number) {
    return [...(yield* decodeCalls(
      yield* sql.unsafe(CALL + " and turn = ? order by n", [id, turn])
    ))]
  }, failed("calls"))

  const call = Effect.fn("Store.call")(function*(n: number) {
    const rows = yield* decodeCalls(
      yield* sql.unsafe(CALL + " and n = ?", [id, n])
    )
    return Option.fromUndefinedOr(rows[0])
  }, failed("call"))

  const endedRunTags = Effect.gen(function*() {
    const rows = yield* sql<{ tag: string }>`select distinct run_tag as tag from everchat_launch where chat = ${id} and ended is not null`
    return rows.map((row) => row.tag)
  }).pipe(failed("endedRunTags"), Effect.withSpan("Store.endedRunTags"))

  const diagnostics = Effect.fn("Store.diagnostics")(function*(after = 0, limit = 1000) {
    return [...(yield* decodeDiagnostics(
      yield* sql`select n as seq, level, source, text, launch, created from everchat_log where chat = ${id} and n > ${after} order by n limit ${limit}`
    ))]
  }, failed("diagnostics"))

  const lastDiagnostics = Effect.fn("Store.lastDiagnostics")(function*(limit: number) {
    return [...(yield* decodeDiagnostics(
      yield* sql`select n as seq, level, source, text, launch, created from everchat_log where chat = ${id} order by n desc limit ${limit}`
    ))].reverse()
  }, failed("lastDiagnostics"))

  const nodesIn = Effect.fn("Store.nodesIn")(function*(l: number, from: number, to: number) {
    return [...(yield* decodeNodes(
      yield* sql`select l, i, text, size, created from everchat_node where chat = ${id} and l = ${l} and i >= ${from} and i < ${to} order by i`
    ))]
  }, failed("nodesIn"))

  const levels = Effect.gen(function*() {
    return [...(yield* decodeLevels(yield* sql`select l, count(*) as built from everchat_node where chat = ${id} group by l order by l`))]
  }).pipe(failed("levels"), Effect.withSpan("Store.levels"))

  const turn = Effect.fn("Store.turn")(function*(n: number) {
    return Option.fromUndefinedOr((yield* turnRows(sql, id, " and t.n = ?", [n]))[0])
  }, failed("turn"))

  const turns = Effect.fn("Store.turns")(function*(before: number | null, limit: number) {
    return yield* (before === null
      ? turnRows(sql, id, " order by t.n desc limit ?", [limit])
      : turnRows(sql, id, " and t.n < ? order by t.n desc limit ?", [before, limit]))
  }, failed("turns"))

  const usage = Effect.fn("Store.usage")(function*(filter: UsageFilter = {}) {
    const where: Array<string> = ["u.chat = ?"]
    const params: Array<number> = [id]
    if (filter.turn !== undefined) {
      where.push("u.turn = ?")
      params.push(filter.turn)
    }
    if (filter.node !== undefined) {
      where.push("u.node_l = ? and u.node_i = ?")
      params.push(...filter.node)
    }
    if (filter.before !== undefined) {
      where.push("u.n < ?")
      params.push(filter.before)
    }
    const rows = yield* sql.unsafe(
      `select u.n as id, u.served, u.turn, u.node_l as nodeL, u.node_i as nodeI, p.vendor, p.model, p.effort, p.speed,
              u.request, u.input, u.cache_read as cacheRead, u.cache_write as cacheWrite, u.output, u.searches,
              u.micros, u.expected, u.created
       from everchat_usage u join everchat_pick p on p.id = u.pick
       where ${where.join(" and ")}
       order by u.n desc limit ?`,
      [...params, filter.limit ?? 1000]
    )
    return (yield* decodeUsage(rows)).map(({ effort, model, nodeI, nodeL, speed, vendor, ...rest }): UsageRecord => ({
      ...rest,
      node: nodeL === null || nodeI === null ? null : [nodeL, nodeI],
      pick: { vendor, model, effort, speed }
    }))
  }, failed("usage"))

  const usageTotals = Effect.gen(function*() {
    return [...(yield* decodeUsageTotals(
      yield* sql`
        select served, count(*) as requests, sum(input) as input, sum(cache_read) as cacheRead,
               sum(cache_write) as cacheWrite, sum(output) as output
        from everchat_usage where chat = ${id} group by served order by served`
    ))]
  }).pipe(failed("usageTotals"), Effect.withSpan("Store.usageTotals"))

  const launches = Effect.fn("Store.launches")(function*(limit: number) {
    return [...(yield* decodeLaunches(
      yield* sql`select n as id, pid, host, cwd, version, created, ended, why from everchat_launch where chat = ${id} order by n desc limit ${limit}`
    ))]
  }, failed("launches"))

  const version = Effect.gen(function*() {
    const row = yield* only(yield* sql<{ data_version: number }>`pragma data_version`)
    return row.data_version
  }).pipe(failed("version"), Effect.withSpan("Store.version"))

  const snapshot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
    Effect.mapError(
      sql.withTransaction(effect),
      (error): E | StoreError => (SqlError.isSqlError(error) ? new StoreError({ op: "snapshot", cause: error }) : error)
    )

  return {
    snapshot,
    version,
    chat,
    eventsAfter,
    count,
    messages,
    messagesAfter,
    imagesOf,
    keyed,
    node,
    nodes,
    nodesIn,
    levels,
    view,
    image,
    head,
    turn,
    turns,
    runningTurns,
    turnItems,
    calls,
    call,
    usage,
    usageTotals,
    launches,
    endedRunTags,
    diagnostics,
    lastDiagnostics
  }
}

// The store
// ---------

// The id of a pick in the shared list, made when it is not there.
const pickOf = (sql: SqlClient.SqlClient, pick: Pick) =>
  Effect.gen(function*() {
    const { effort, model, speed, vendor } = pick
    const created = yield* Clock.currentTimeMillis
    yield* sql`insert into everchat_pick ${sql.insert({ vendor, model, effort, speed, created })} on conflict do nothing`
    const row = yield* only(
      yield* sql<{ id: number }>`
        select id from everchat_pick
        where vendor = ${vendor} and model = ${model} and effort = ${effort} and speed = ${speed}`
    )
    return row.id
  })

// A new chat of `tenant` (16 bytes), with its first pick: the tenant's row
// when it is not there (a select, then an insert; never a REPLACE), and the
// chat's row (its tenant, a new UUIDv4 as 16 bytes, its pick). The database
// makes the chat's id. Only inside a transaction.
const newChat = (sql: SqlClient.SqlClient, tenant: Uint8Array, pick: Pick) =>
  Effect.gen(function*() {
    const created = yield* Clock.currentTimeMillis
    const have = yield* sql<{ id: Uint8Array }>`select id from everchat_tenant where id = ${tenant}`
    if (have.length === 0) yield* sql`insert into everchat_tenant ${sql.insert({ id: tenant, created })}`
    const uuid = uuidBytes(crypto.randomUUID())
    yield* sql`insert into everchat_chat ${sql.insert({ tenant, uuid, pick: yield* pickOf(sql, pick), created, updated: created })}`
    const made = yield* find(sql, tenant, uuid)
    return Option.isSome(made) ? { bound: made.value, uuid: uuidText(uuid) } : yield* Effect.die(new Error("the store made a chat and did not find it"))
  })

// The file's one chat, made when the file has none: a new tenant (the 16
// bytes of a new UUIDv4) and its chat. Only inside the transaction of the
// first launch.
const bind = (sql: SqlClient.SqlClient, pick: Pick) =>
  Effect.gen(function*() {
    const found = yield* bound(sql)
    if (Option.isSome(found)) return found.value
    const have = yield* theTenant(sql)
    const tenant = Option.isSome(have) ? have.value : uuidBytes(crypto.randomUUID())
    return (yield* newChat(sql, tenant, pick)).bound
  })

// Takes the chat `bound` for a launch: it closes the launch that a crash
// left open, refuses when another process of this host still runs with
// the chat (`LaunchLive`), and writes this launch's row. Only inside the
// transaction of the launch.
const takeChat = (sql: SqlClient.SqlClient, alive: (pid: number) => boolean, { chat }: Bound, input: LaunchInput) =>
  Effect.gen(function*() {
    const created = yield* Clock.currentTimeMillis
    const open = yield* sql<{ n: number; pid: number; host: string; created: number }>`
      select n, pid, host, created from everchat_launch where chat = ${chat} and ended is null`
    const last = open[0]
    if (last !== undefined) {
      // A launch with our own pid is not another process: the pid was used
      // again (in a container, the program is always process 1). A launch
      // of another host cannot be checked, so the chat moved here.
      if (last.host === input.host && last.pid !== input.pid && alive(last.pid)) {
        return yield* new LaunchLive({ pid: last.pid, host: last.host, created: last.created })
      }
      yield* sql`update everchat_launch set ended = ${created}, why = 'crash' where chat = ${chat} and n = ${last.n}`
    }
    const pick = input.pick === undefined ? null : yield* pickOf(sql, input.pick)
    const n = yield* next(sql, chat, "everchat_launch")
    yield* sql`insert into everchat_launch ${
      sql.insert({
        chat,
        n,
        pid: input.pid,
        host: input.host,
        cwd: input.cwd,
        version: input.version,
        run_tag: input.runTag,
        pick,
        created
      })
    }`
    const launch: Launch = { ...input, id: n, created }
    return launch
  })

// The end of the launch `n` of `chat`, when the caller's scope closes: how
// the scope ended is the launch's `why`.
const endLaunch = (sql: SqlClient.SqlClient, chat: number, n: number) => (exit: Exit.Exit<unknown, unknown>) =>
  Effect.gen(function*() {
    const ended = yield* Clock.currentTimeMillis
    const why = Exit.isSuccess(exit) ? "exit" : Exit.hasInterrupts(exit) ? "signal" : "error"
    yield* sql`update everchat_launch set ended = ${ended}, why = ${why} where chat = ${chat} and n = ${n} and ended is null`
  }).pipe(Effect.ignore)

// The store of a chat for one launch, in the caller's scope. `found` finds
// the chat (or makes it), in the launch's transaction; then the launch
// takes it. One path for the local file's chat and for `Chats`.
//
// The launch's commit and the registration of its end in the caller's
// scope are one region that no interruption splits: the end is registered
// with `sql.afterCommit`, which runs inside the transaction's own
// uninterruptible region, right after a COMMIT that succeeded. An
// interruption before the commit rolls the launch back, and registers
// nothing; once the commit is done, the end is already in the scope. The
// wait for the connection, before the first write, stays interruptible.
const open = <E>(sql: SqlClient.SqlClient, found: Effect.Effect<Bound, E | SqlError.SqlError>, input: LaunchInput) =>
  Effect.gen(function*() {
    const alive = yield* ProcessAlive
    const { bound, launch } = yield* sql.withTransaction(
      Effect.gen(function*() {
        const bound = yield* found
        const launch = yield* takeChat(sql, alive, bound, input)
        yield* sql.afterCommit(Effect.addFinalizer(endLaunch(sql, bound.chat, launch.id)))
        return { bound, launch }
      })
    ).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new StoreError({ op: "launch", cause }))))
    return yield* storeOf(sql, bound, launch)
  })

// The members of the store of the chat `bound`, for `launch` (whose end
// `open` has registered).
const storeOf = Effect.fnUntraced(function*(sql: SqlClient.SqlClient, { chat, tenant }: Bound, launch: Launch) {
  const now = Clock.currentTimeMillis
  const pickId = (pick: Pick) => pickOf(sql, pick)

  const read = reading(sql, { tenant, chat })

  // The chat's row
  // --------------

  const setPick = Effect.fn("Store.setPick")(function*(pick: Pick) {
    yield* sql.withTransaction(Effect.gen(function*() {
      const id = yield* pickId(pick)
      yield* sql`update everchat_chat set pick = ${id}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`
    }))
  }, failed("setPick"))

  const setGoal = Effect.fn("Store.setGoal")(function*(goal: string | null) {
    yield* sql`update everchat_chat set goal = ${goal === null ? null : goal.toWellFormed()}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`
  }, failed("setGoal"))

  const setDraft = Effect.fn("Store.setDraft")(function*(draft: string | null) {
    yield* sql`update everchat_chat set draft = ${draft === null ? null : draft.toWellFormed()}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`
  }, failed("setDraft"))

  const setTaken = Effect.fn("Store.setTaken")(function*(i: number) {
    yield* sql`update everchat_chat set taken = ${i}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`
  }, failed("setTaken"))

  // The log
  // -------

  // The sender's key goes on the row of the first message, in its insert
  // (the table refuses an update). Its form is checked here, before any
  // write: a check in the table would need a pattern, which SQLite and
  // MariaDB write in two ways (docs/schema.html, everchat_msg). A key that
  // the chat has already is refused by the index (chat, sender_key), and
  // the transaction takes back what it wrote.
  const append = Effect.fn("Store.append")(function*(messages: ReadonlyArray<NewMessage>, given?: string | null) {
    const key = given ?? null
    if (key !== null && !SENDER_KEY.test(key)) {
      return yield* Effect.fail(new Error("the sender's key is not 1 to 128 bytes of visible ASCII"))
    }
    if (key !== null && messages.length === 0) {
      return yield* Effect.fail(new Error("the sender's key has no message"))
    }
    return yield* sql.withTransaction(Effect.gen(function*() {
      const created = yield* now
      const first = yield* nextMessage(sql, chat)
      const written: Array<Message> = []
      for (const [k, message] of messages.entries()) {
        const text = message.text.toWellFormed()
        const row = {
          i: first + k,
          kind: KINDS[message.kind],
          text,
          size: bytes(text),
          more: message.more === true ? 1 : 0,
          line: message.line === undefined || message.line === null ? null : message.line.toWellFormed(),
          turn: message.turn ?? null,
          call: message.call ?? null,
          launch: launch.id,
          created
        }
        yield* sql`insert into everchat_msg ${sql.insert({ chat, ...row, sender_key: k === 0 ? key : null })}`
        // A message's images: its own coordinate `n`, from 0, in their order.
        for (const [n, image] of (message.images ?? []).entries()) {
          yield* sql`insert into everchat_msg_image ${sql.insert({ chat, msg: row.i, n, image })}`
        }
        written.push({ ...row, kind: message.kind, more: row.more === 1 })
      }
      return written
    }))
  }, failed("append"))

  // The tree
  // --------

  const putNodes = Effect.fn("Store.putNodes")(function*(nodes: ReadonlyArray<NewNode>) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const created = yield* now
      const written: Array<Node> = []
      for (const node of nodes) {
        const text = node.text.toWellFormed()
        const row = { l: node.l, i: node.i, text, size: bytes(text), created }
        yield* sql`insert into everchat_node ${sql.insert({ chat, ...row })}`
        written.push(row)
      }
      return written
    }))
  }, failed("putNodes"))

  // The views
  // ---------

  const putView = Effect.fn("Store.putView")(function*(view: View) {
    const at = yield* now
    yield* sql`
      insert into everchat_view ${
      sql.insert({
        chat,
        name: view.name,
        parts: JSON.stringify(view.parts),
        batch: view.batch ? 1 : 0,
        created: at,
        updated: at
      })
    }
      on conflict (chat, name) do update
      set parts = excluded.parts, batch = excluded.batch, updated = excluded.updated`
  }, failed("putView"))

  // The images
  // ----------

  const putImage = Effect.fn("Store.putImage")(function*(image: NewImage) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const have = yield* sql<{ n: number }>`select n from everchat_image where chat = ${chat} and name = ${image.name}`
      if (have[0] !== undefined) return have[0].n
      const n = yield* next(sql, chat, "everchat_image")
      const { bytes, height, name, source, type, width } = image
      yield* sql`insert into everchat_image ${sql.insert({ chat, n, name, type, width, height, source, created: yield* now, bytes })}`
      return n
    }))
  }, failed("putImage"))

  // The heads
  // ---------

  const putHead = Effect.fn("Store.putHead")(function*(body: string) {
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    return yield* sql.withTransaction(Effect.gen(function*() {
      const have = yield* sql<{ n: number }>`select n from everchat_head where chat = ${chat} and hash = ${hash}`
      if (have[0] !== undefined) return have[0].n
      const n = yield* next(sql, chat, "everchat_head")
      yield* sql`insert into everchat_head ${sql.insert({ chat, n, hash, body, created: yield* now })}`
      return n
    }))
  }, failed("putHead"))

  // The usage
  // ---------

  const addUsage = Effect.fn("Store.addUsage")(function*(usage: NewUsage) {
    yield* sql.withTransaction(Effect.gen(function*() {
      const pick = yield* pickId(usage.pick)
      const n = yield* next(sql, chat, "everchat_usage")
      yield* sql`insert into everchat_usage ${
        sql.insert({
          chat,
          n,
          served: usage.served,
          turn: usage.turn ?? null,
          node_l: usage.node?.[0] ?? null,
          node_i: usage.node?.[1] ?? null,
          pick,
          request: usage.request ?? null,
          input: usage.input,
          cache_read: usage.cacheRead,
          cache_write: usage.cacheWrite,
          output: usage.output,
          searches: usage.searches ?? 0,
          micros: usage.micros ?? null,
          expected: usage.expected ?? null,
          created: yield* now
        })
      }`
    }))
  }, failed("addUsage"))

  // Turns
  // -----

  const startTurn = Effect.fn("Store.startTurn")(function*(turn: NewTurn) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const pick = yield* pickId(turn.pick)
      const head = yield* putHead(turn.head)
      const n = yield* next(sql, chat, "everchat_turn")
      yield* sql`insert into everchat_turn ${
        sql.insert({ chat, n, agent: turn.agent ?? null, status: "running", pick, head, first_msg: turn.firstMsg, launch: launch.id, created: yield* now })
      }`
      return yield* only(yield* turnRows(sql, chat, " and t.n = ?", [n]))
    }))
  }, failed("startTurn"))

  const endTurn = Effect.fn("Store.endTurn")(function*(id: number, status: "done" | "stopped" | "failed", why: string | null = null) {
    yield* sql`
      update everchat_turn set status = ${status}, ended = ${yield* now}, why = ${why === null ? null : why.toWellFormed()}
      where chat = ${chat} and n = ${id} and status = 'running'`
  }, failed("endTurn"))

  // A turn's items: its own coordinate `n`, from 0 in each turn, as a
  // message's `i` (docs/schema.html, section 1: a key of a chat's own
  // coordinates).
  const addTurnItem = Effect.fn("Store.addTurnItem")(function*(turn: number, kind: "user" | "turn" | "back", body: string) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const row = yield* only(
        yield* sql<{ n: number }>`select coalesce(max(n), -1) + 1 as n from everchat_turn_item where chat = ${chat} and turn = ${turn}`
      )
      yield* sql`insert into everchat_turn_item ${sql.insert({ chat, turn, n: row.n, kind, body: body.toWellFormed(), created: yield* now })}`
      return row.n
    }))
  }, failed("addTurnItem"))

  // Calls
  // -----

  const startCall = Effect.fn("Store.startCall")(function*(call: NewCall) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const n = yield* next(sql, chat, "everchat_call")
      yield* sql`insert into everchat_call ${
        sql.insert({
          chat,
          n,
          turn: call.turn,
          parent: call.parent ?? null,
          vendor_id: call.vendorId ?? null,
          fn: call.fn,
          input: call.input.toWellFormed(),
          status: "running",
          launch: launch.id,
          created: yield* now
        })
      }`
      return n
    }))
  }, failed("startCall"))

  const endCall = Effect.fn("Store.endCall")(function*(id: number, end: CallEnd) {
    const output = end.output.toWellFormed()
    const size = bytes(output)
    yield* sql`
      update everchat_call set status = ${end.status}, output = ${output}, size = ${size}, shown = ${end.shown ?? size}, pgid = null, ended = ${yield* now}
      where chat = ${chat} and n = ${id} and status = 'running'`
  }, failed("endCall"))

  const setCallPgid = Effect.fn("Store.setCallPgid")(function*(id: number, pgid: number) {
    yield* sql`update everchat_call set pgid = ${pgid} where chat = ${chat} and n = ${id} and status = 'running'`
  }, failed("setCallPgid"))

  // Events
  // ------

  // The rows of the chat that each type of event reports; null for the rest.
  const reported = (event: NewEvent) => {
    switch (event.type) {
      case "accepted":
      case "message":
        return { turn: null, call: null, msg: event.msg, msg_last: event.msgLast }
      case "start":
      case "end":
        return { turn: event.turn, call: null, msg: null, msg_last: null }
      case "call":
        return { turn: event.turn, call: event.call, msg: null, msg_last: null }
    }
  }

  // The chat's next event number is its `seq` plus 1; the row and the new
  // `seq` are written together, in the caller's transaction when there is
  // one (docs/schema.html, sections 4 and 7).
  const addEvent = Effect.fn("Store.addEvent")(function*(event: NewEvent) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const row = yield* only(yield* sql<{ seq: number }>`select seq from everchat_chat where tenant = ${tenant} and id = ${chat}`)
      const n = row.seq + 1
      const created = yield* now
      yield* sql`insert into everchat_event ${sql.insert({ chat, n, type: event.type, ...reported(event), created })}`
      yield* sql`update everchat_chat set seq = ${n}, updated = ${created} where tenant = ${tenant} and id = ${chat}`
      return n
    }))
  }, failed("addEvent"))

  // Diagnostics
  // -----------

  const addDiagnostics = Effect.fn("Store.addDiagnostics")(function*(rows: ReadonlyArray<NewDiagnostic>) {
    if (rows.length === 0) {
      return
    }
    yield* sql.withTransaction(Effect.gen(function*() {
      const first = yield* next(sql, chat, "everchat_log")
      for (const [k, row] of rows.entries()) {
        yield* sql`insert into everchat_log ${
          sql.insert({
            chat,
            n: first + k,
            level: row.level,
            source: row.source,
            text: row.text.toWellFormed(),
            launch: launch.id,
            created: Math.trunc(row.created)
          })
        }`
      }
    }))
  }, failed("addDiagnostics"))

  const dropDiagnostics = Effect.fn("Store.dropDiagnostics")(function*(before: number) {
    const rows = yield* sql<{ n: number }>`delete from everchat_log where chat = ${chat} and created < ${before} returning n`
    return rows.length
  }, failed("dropDiagnostics"))

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
    Effect.mapError(
      sql.withTransaction(effect),
      (error): E | StoreError =>
        SqlError.isSqlError(error) ? new StoreError({ op: "transaction", cause: error }) : error
    )

  return Store.of({
    ...read,
    launch,
    transaction,
    setPick,
    setGoal,
    setDraft,
    setTaken,
    append,
    putNodes,
    putView,
    putImage,
    putHead,
    addUsage,
    startTurn,
    endTurn,
    addTurnItem,
    startCall,
    endCall,
    setCallPgid,
    addEvent,
    addDiagnostics,
    dropDiagnostics
  })
})

// The layers
// ----------

// The reads of the file's one chat, over the `SqlClient` in the context,
// found as `Chats` finds a chat. It fails when the file has no chat yet: a
// launch makes it.
const readsOf = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const found = yield* bound(sql).pipe(failed("open"))
    if (Option.isNone(found)) {
      return yield* new StoreError({ op: "open", cause: new Error("the file has no chat yet: a launch makes it") })
    }
    return Reads.of(reading(sql, found.value))
  })

// The reads over the `SqlClient` in the context.
export const readsLayerNoDatabase = Layer.effect(Reads, Effect.flatMap(SqlClient.SqlClient, readsOf))

// The reads over the database in the file `filename`, which must be there.
// It fails when the file's mark is not this program's (schema.ts): a read of
// tables that this program does not know gives wrong answers.
export const readsLayer = (filename: string, limits: Database.Limits = {}) =>
  Layer.effect(
    Reads,
    Effect.gen(function*() {
      const database = yield* Layer.build(Database.readonly(filename, limits))
      const have = yield* Database.version.pipe(Effect.provide(database), failed("open"))
      if (have !== Database.VERSION) {
        return yield* new DatabaseVersion({ have, want: Database.VERSION, file: filename })
      }
      return yield* readsOf(Context.get(database, SqlClient.SqlClient))
    })
  )

// The store over the `SqlClient` in the context: the file's one chat, made
// at the first launch.
export const storeLayerNoDatabase = (options: Options) =>
  Layer.effect(Store, Effect.flatMap(SqlClient.SqlClient, (sql) => open(sql, bind(sql, options.pick), options.launch)))

// The store over the database in the file `filename`.
export const storeLayer = (filename: string, options: Options, limits: Database.Limits = {}) =>
  storeLayerNoDatabase(options).pipe(Layer.provide(Database.layer(filename, limits)))

// The chats of a deployment
// -------------------------

// The tag `Chats` over the `SqlClient` in the context: a chat is made and
// found by its tenant and its UUID, and its store and its reads are the
// ones that the local layers give for the file's chat.
const chatsOf = (sql: SqlClient.SqlClient) =>
  Chats.of({
    make: Effect.fn("Chats.make")(function*(tenant: string, pick: Pick) {
      const id = parsed(tenant)
      if (Option.isNone(id)) return yield* new StoreError({ op: "make", cause: new Error("the tenant is no UUID") })
      const made = yield* sql.withTransaction(newChat(sql, id.value, pick)).pipe(failed("make"))
      return made.uuid
    }),
    store: (tenant: string, chat: string, launch: LaunchInput) => open(sql, chatOf(sql, tenant, chat), launch),
    reads: Effect.fn("Chats.reads")(function*(tenant: string, chat: string) {
      const found = yield* chatOf(sql, tenant, chat).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new StoreError({ op: "open", cause }))))
      return Reads.of(reading(sql, found))
    })
  })

export const chatsLayerNoDatabase = Layer.effect(Chats, Effect.map(SqlClient.SqlClient, chatsOf))

// The tag over the database in the file `filename`, made when it is empty.
export const chatsLayer = (filename: string, limits: Database.Limits = {}) =>
  chatsLayerNoDatabase.pipe(Layer.provide(Database.layer(filename, limits)))
