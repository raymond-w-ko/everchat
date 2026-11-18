// The shared store
// ================
// The SQL of `Store` and `Reads` (store.ts) over Effect's `SqlClient`, one
// form for SQLite and MariaDB: the rows and their decoders, the reads
// (`reading`), the store of a chat (`open`, `storeOf`), its writes
// (`writer`), the tag `Chats` (`chatsOf`), and the `Dialect`, the one
// place where the two databases differ. It imports `effect` and the core,
// and nothing of a database's driver: `sqlite.ts` gives SQLite's dialect
// and the layers over a file.
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
//
// One form of each statement for SQLite and MariaDB (docs/design.md, "The
// database"; lead, ec-dwjz, R2). Every statement, now and later, keeps
// these rules:
// - No `update ... returning` (MariaDB refuses it). A write that needs the
//   rows that it changes first selects their keys (and what it gives back)
//   with the update's conditions, the dialect's `forUpdate` after the
//   select's text,
//   then updates by those keys, both in one transaction.
// - No scalar `min(a, b)` or `max(a, b)`: a `case`, null when either side
//   is null, as SQLite's functions give.
// - A list of pairs is `(a, b) in ((?, ?), ...)`, not `in (values ...)`.
// - A `sum` is cast to a whole number (`cast(... as signed)`): MariaDB's is
//   a decimal.
// - No `set` reads a column that an earlier assignment of the same `set`
//   wrote: SQLite reads the old row, MariaDB the new value. Bind the value
//   from the selected row, or assign that column last.

import { Clock, Context, Effect, Exit, Option, Schema } from "effect"
import { SqlClient, SqlError, type Statement } from "effect/sql"
import {
  ANSWER_MAX,
  type Answered,
  type Approval,
  type ApprovalAnswer,
  type ApprovalEnd,
  ApprovalStatus,
  type CallEnd,
  Chats,
  type Event,
  Kind,
  KINDS,
  type Launch,
  type LaunchInput,
  LaunchLive,
  type Keyed,
  type MadeWake,
  type Settled,
  type Message,
  type NewCall,
  type NewDiagnostic,
  type NewEvent,
  type NewImage,
  type NewMessage,
  type NewNode,
  type NewTurn,
  type NewUsage,
  type NewWake,
  NoChat,
  Node,
  Part,
  Pick,
  Reads,
  type Reading,
  SENDER_KEY,
  TOLD,
  WAIT,
  WHO_MAX,
  Store,
  StoreError,
  type Turn,
  type UsageFilter,
  type UsageRecord,
  type UnsettledWake,
  type View,
  ViewName,
  WAKE_FAILURES,
  WAKE_TEXT_MAX,
  type Wake,
  type WakeEnd,
  type WakeFilter,
  WAKE_MISSED_MAX,
  type WakeOf,
  type WakePend,
  type WakeRead,
  type WakeStop,
  WakeWhy
} from "@everchat/core/store"

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
  wakeups: Schema.Literals([0, 1]),
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
  why: Schema.NullOr(Schema.String),
  steps: Schema.NullOr(Schema.Int),
  tokens: Schema.NullOr(Schema.Int)
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
  status: Schema.Literals(["running", "done", "failed", "denied", "cut", "pending"]),
  size: Schema.NullOr(Schema.Int),
  shown: Schema.NullOr(Schema.Int),
  created: Schema.Int,
  ended: Schema.NullOr(Schema.Int)
})

const ApprovalRow = Schema.Struct({
  id: Schema.Int,
  turn: Schema.Int,
  call: Schema.Int,
  fn: Schema.String,
  input: Schema.String,
  status: ApprovalStatus,
  who: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(Schema.String),
  answered: Schema.NullOr(Schema.Int),
  output: Schema.NullOr(Schema.String),
  ended: Schema.NullOr(Schema.Int),
  msg: Schema.NullOr(Schema.Int),
  created: Schema.Int,
  updated: Schema.Int
})

// A wake-up's row, with `settled` as the flag of the file.
const WakeRow = Schema.Struct({
  id: Schema.Int,
  text: Schema.String,
  cron: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.Int),
  zone: Schema.String,
  first: Schema.Int,
  turn: Schema.NullOr(Schema.Int),
  call: Schema.NullOr(Schema.Int),
  due: Schema.NullOr(Schema.Int),
  slot: Schema.NullOr(Schema.Int),
  pending: Schema.NullOr(Schema.Int),
  missed: Schema.Int,
  fired: Schema.Int,
  lastTurn: Schema.NullOr(Schema.Int),
  settled: Schema.Literals([0, 1]),
  failed: Schema.Int,
  stopped: Schema.NullOr(Schema.Int),
  why: Schema.NullOr(WakeWhy),
  stopCall: Schema.NullOr(Schema.Int),
  created: Schema.Int,
  updated: Schema.Int
})

// A wake-up whose end is not counted, with its last turn's status and why.
const UnsettledRow = Schema.Struct({
  ...WakeRow.fields,
  turnStatus: Schema.Literals(["running", "done", "stopped", "failed"]),
  turnWhy: Schema.NullOr(Schema.String)
})

// A wake-up with the call of a program that made it or stopped it.
const WakeOfRow = Schema.Struct({
  ...WakeRow.fields,
  way: Schema.Literals(["made", "stopped"]),
  byCall: Schema.Int
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
const decodeApprovals = Schema.decodeUnknownEffect(Schema.Array(ApprovalRow))
const decodeWakes = Schema.decodeUnknownEffect(Schema.Array(WakeRow))
const decodeUnsettled = Schema.decodeUnknownEffect(Schema.Array(UnsettledRow))
const decodeWakesOf = Schema.decodeUnknownEffect(Schema.Array(WakeOfRow))
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(MessageRow))
const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(Node))
const decodeViews = Schema.decodeUnknownEffect(Schema.Array(ViewRow))
const decodeChats = Schema.decodeUnknownEffect(Schema.Array(ChatRow))
const decodeImages = Schema.decodeUnknownEffect(Schema.Array(ImageRow))

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).length

// SQLite takes at most 32,766 values in one statement.
const KEYS_PER_QUERY = 10_000

export const failed = (op: string) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.mapError(self, (cause) => new StoreError({ op, cause }))

// The smaller and the larger of two numbers, null when either is null, as
// SQLite's `min(a, b)` and `max(a, b)` give (the rule at the store's head).
const least = (sql: SqlClient.SqlClient, a: Statement.Fragment | number, b: Statement.Fragment | number) =>
  sql`case when ${a} <= ${b} then ${a} when ${a} > ${b} then ${b} end`
const greatest = (sql: SqlClient.SqlClient, a: Statement.Fragment | number, b: Statement.Fragment | number) =>
  sql`case when ${a} >= ${b} then ${a} when ${a} < ${b} then ${b} end`

// The one row of a query that must give one row. None, or more than one, is
// a defect: a read that lost its chat's `=` could still give the right row
// first, by the order of the file, and pass.
export const only = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> => {
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
export interface Bound {
  readonly tenant: Uint8Array
  readonly chat: number
}

// A UUID as 16 bytes, and back as text (8-4-4-4-12, lower case).
export const uuidBytes = (uuid: string): Uint8Array => Uint8Array.from(uuid.replaceAll("-", "").match(/../g) ?? [], (hex) => parseInt(hex, 16))
export const uuidText = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}

// A UUID that comes in as text, as 16 bytes; none for a text that is no
// UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const parsed = (text: string): Option.Option<Uint8Array> => (UUID.test(text) ? Option.some(uuidBytes(text)) : Option.none())

// The chat of `tenant` whose UUID is `uuid`. This is the one statement that
// finds a chat: by its tenant and its UUID, never by its UUID alone.
export const find = (sql: SqlClient.SqlClient, tenant: Uint8Array, uuid: Uint8Array) =>
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

// The dialect
// -----------

// What a database of the store says in its own way (lead, ec-dwjz, R3): the
// only place where SQLite and MariaDB differ. A store reads one, at its
// build (`Dialect`, below), and uses it for all of its life.
//
// - `forUpdate`: the text after the `select` of the keys that an `update`
//   then changes (the rule at the store's head).
// - `pickOf`: the id of a pick in the shared list, made when it is not
//   there.
// - `putView`: a view's row, made or changed by its key `(chat, name)`.
// - `version`: the number that changes when another connection writes
//   (`Reads.version`).
// - `ownerLive`: whether the owner of a launch that is not ended (`open`,
//   of the chat that a launch takes) still has the chat; then the launch
//   is refused (`LaunchLive`), else that launch is closed as a crash.
// - `beforeWrite`: run as the first statement of the transaction of each
//   write, given the store's tenant and chat (`writer`); none: a write runs
//   as it is, in its own transaction or in none. With no chat yet (lead,
//   ec-9qt2rc, W6), given null: the first statement of the launch's
//   transaction of `open`, before its chat is found, and of the
//   transaction of `Chats.make`; it then checks what needs no chat (on
//   MariaDB the lease's epoch), and a failure of it writes nothing and
//   fails the launch or the make.
export interface Dialect {
  readonly forUpdate: string
  readonly pickOf: (sql: SqlClient.SqlClient, pick: Pick) => Effect.Effect<number, SqlError.SqlError>
  readonly putView: (sql: SqlClient.SqlClient, row: ViewWrite) => Effect.Effect<void, SqlError.SqlError>
  readonly version: (sql: SqlClient.SqlClient) => Effect.Effect<number, SqlError.SqlError | StoreError>
  readonly ownerLive: (open: { readonly pid: number; readonly host: string }, input: LaunchInput) => Effect.Effect<boolean>
  readonly beforeWrite?: ((sql: SqlClient.SqlClient, bound: Bound | null) => Effect.Effect<void, SqlError.SqlError | StoreError>) | undefined
}

// A view's row as the store writes it.
export interface ViewWrite {
  readonly chat: number
  readonly name: ViewName
  readonly parts: string // JSON
  readonly batch: 0 | 1
  readonly created: number
  readonly updated: number
}

// The writer of a store whose tenant and chat are `bound` (lead, ec-dwjz,
// R4): every member that writes goes through it, a read never.
// `"transaction"`: the member's statements in one transaction (a
// savepoint inside another); `"statement"`: one statement, in no
// transaction of its own. With none of the dialect's `beforeWrite`, each
// member runs exactly as it is, with no mark.
//
// With a `beforeWrite` (lead, ec-9e7436, W1 and W2): a write of the store
// is a write inside a guarded write only while that write's body runs,
// from after its `beforeWrite` to the end of its member, before the COMMIT
// or the ROLLBACK. There it runs as with none (the store's `transaction`,
// a member that calls another), so `beforeWrite` runs once, first. Each
// other write is an outermost write: it opens its own transaction, runs
// `beforeWrite` as its first statement, and writes nothing when that
// fails. So is a write in a callback of `sql.afterCommit` (which runs
// after the COMMIT, with the rest of the write's context), a write that
// such a callback's own transaction holds (then in its savepoint, as a
// write inside a transaction that is not this store's write: a snapshot,
// another store's), and a write of a callback that registers
// `afterCommit` again. The way: the outermost write puts into its body's
// context a mark of that one write (`Mark`: the store, and whether the
// body still runs), and closes it when the body ends, by any exit, inside
// the transaction, so before the COMMIT, the ROLLBACK and each
// `afterCommit` callback. A write that finds its store's mark closed,
// another store's mark, or none, is an outermost write. The client's own
// transaction service is not read.
export const writer = (sql: SqlClient.SqlClient, dialect: Dialect, bound: Bound) => {
  const before = dialect.beforeWrite
  // This store, as its marks name it.
  const own = {}
  return <A, E, R>(how: "transaction" | "statement", effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError.SqlError | StoreError, R> => {
    const alone = how === "transaction" ? sql.withTransaction(effect) : effect
    if (before === undefined) return alone
    return Effect.gen(function*() {
      const mark = yield* Writing
      if (mark !== null && mark.store === own && mark.open) return yield* alone
      const write: Mark = { store: own, open: true }
      return yield* sql.withTransaction(
        Effect.andThen(
          before(sql, bound),
          Effect.provideService(effect, Writing, write).pipe(Effect.ensuring(Effect.sync(() => {
            write.open = false
          })))
        )
      )
    })
  }
}

// The mark of one guarded write (`writer`): its store, and `open` while
// its body runs.
interface Mark {
  readonly store: object
  open: boolean
}

// The guarded write that the fiber runs inside, if any (`writer`).
const Writing = Context.Reference<Mark | null>("everchat/store/Writing", { defaultValue: () => null })

// The tables whose rows the program numbers with `n`, from 1 in each chat.
type Numbered =
  | "everchat_launch"
  | "everchat_head"
  | "everchat_turn"
  | "everchat_call"
  | "everchat_image"
  | "everchat_usage"
  | "everchat_log"
  | "everchat_approval"
  | "everchat_wake"

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
                     t.first_msg as firstMsg, t.launch, t.created, t.ended, t.why, t.steps, t.tokens
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

// An approval. `rest` goes on as in TURN; the chat is the first parameter.
const APPROVAL = `select a.n as id, a.turn, a.call, a.fn, a.input, a.status, a.who, a.answer, a.answered, a.output, a.ended, a.msg,
                         a.created, a.updated
                  from everchat_approval a
                  where a.chat = ?`

// The approvals of the chat `chat`; `rest` goes on as in TURN.
const approvalRows = (sql: SqlClient.SqlClient, chat: number, rest: string, params: ReadonlyArray<string | number>) =>
  Effect.map(Effect.flatMap(sql.unsafe(APPROVAL + rest, [chat, ...params]), decodeApprovals), (rows): Array<Approval> => [...rows])

// The columns of a wake-up's row (`w`), as `Wake` names them.
const WAKE_COLUMNS = `w.n as id, w.text, w.cron, w.at, w.zone, w.first, w.turn, w.call, w.due, w.slot, w.pending, w.missed, w.fired,
                      w.last_turn as lastTurn, w.settled, w.failed, w.stopped, w.why, w.stop_call as stopCall, w.created, w.updated`

// A wake-up. `rest` goes on as in TURN; the chat is the first parameter.
const WAKE = `select ${WAKE_COLUMNS}
              from everchat_wake w
              where w.chat = ?`

// A row of the file as a `Wake`.
const wakeOfRow = <A extends typeof WakeRow.Type>(row: A): Wake => ({
  id: row.id,
  text: row.text,
  cron: row.cron,
  at: row.at,
  zone: row.zone,
  first: row.first,
  turn: row.turn,
  call: row.call,
  due: row.due,
  slot: row.slot,
  pending: row.pending,
  missed: row.missed,
  fired: row.fired,
  lastTurn: row.lastTurn,
  settled: row.settled === 1,
  failed: row.failed,
  stopped: row.stopped,
  why: row.why,
  stopCall: row.stopCall,
  created: row.created,
  updated: row.updated
})

// The wake-ups of the chat `chat`; `rest` goes on as in TURN.
const wakeRows = (sql: SqlClient.SqlClient, chat: number, rest: string, params: ReadonlyArray<string | number>) =>
  Effect.map(Effect.flatMap(sql.unsafe(WAKE + rest, [chat, ...params]), decodeWakes), (rows): Array<Wake> => rows.map(wakeOfRow))

// The condition that the chat's wake-ups are on (`/wakeups`), for a
// statement on `everchat_wake`: its one parameter is the chat.
const ON = "exists (select 1 from everchat_chat where id = ? and wakeups = 1)"
// The reads
// ---------

// The reads of the chat `bound`.
export const reading = (sql: SqlClient.SqlClient, dialect: Dialect, { chat: id, tenant }: Bound): Reading => {
  const chat = Effect.gen(function*() {
    const rows = yield* sql`
      select c.uuid, p.vendor, p.model, p.effort, p.speed, c.goal, c.draft, c.taken, c.seq, c.wakeups, c.created, c.updated
      from everchat_chat c join everchat_pick p on p.id = c.pick
      where c.tenant = ${tenant} and c.id = ${id}`
    const row = yield* only(yield* decodeChats(rows))
    const { effort, model, speed, uuid, vendor, wakeups, ...rest } = row
    return { uuid: uuidText(uuid), ...rest, wakeups: wakeups === 1, pick: { vendor, model, effort, speed } }
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
         where chat = ? and (l, i) in (${some.map(() => "(?, ?)").join(", ")})`,
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

  const approval = Effect.fn("Store.approval")(function*(n: number) {
    return Option.fromUndefinedOr((yield* approvalRows(sql, id, " and a.n = ?", [n]))[0])
  }, failed("approval"))

  const approvalOf = Effect.fn("Store.approvalOf")(function*(call: number) {
    return Option.fromUndefinedOr((yield* approvalRows(sql, id, " and a.call = ?", [call]))[0])
  }, failed("approvalOf"))

  // No state given: all of them; an empty list: none.
  const approvals = Effect.fn("Store.approvals")(function*(statuses?: ReadonlyArray<ApprovalStatus>) {
    if (statuses === undefined) return yield* approvalRows(sql, id, " order by a.n", [])
    if (statuses.length === 0) return []
    return yield* approvalRows(sql, id, ` and a.status in (${statuses.map(() => "?").join(", ")}) order by a.n`, statuses)
  }, failed("approvals"))

  // The join names the chat on both sides.
  const approvalsOf = Effect.fn("Store.approvalsOf")(function*(program: number) {
    return yield* approvalRows(
      sql,
      id,
      " and exists (select 1 from everchat_call c where c.chat = a.chat and c.chat = ? and c.n = a.call and c.parent = ?) order by a.n",
      [id, program]
    )
  }, failed("approvalsOf"))

  const untoldApprovals = Effect.fn("Store.untoldApprovals")(function*() {
    return yield* approvalRows(sql, id, ` and a.msg is null and a.status in (${TOLD.map(() => "?").join(", ")}) order by a.n`, TOLD)
  }, failed("untoldApprovals"))

  // All the rows, or the active ones (`stopped` null), or the stopped ones.
  const wakes = Effect.fn("Store.wakes")(function*(filter?: WakeFilter) {
    const active = filter?.active
    const where = active === undefined ? "" : active ? " and stopped is null" : " and stopped is not null"
    return yield* wakeRows(sql, id, where + " order by n", [])
  }, failed("wakes"))

  // The chat's switch is read in the statement of the rows (`ON`), so that
  // the rows and the switch are one state of the file.
  const dueWakes = Effect.fn("Store.dueWakes")(function*(now: number) {
    return yield* wakeRows(sql, id, ` and stopped is null and due <= ? and ${ON} order by due, n`, [now, id])
  }, failed("dueWakes"))

  const pendingWake = Effect.fn("Store.pendingWake")(function*() {
    const rows = yield* wakeRows(sql, id, ` and stopped is null and settled = 1 and pending is not null and ${ON} order by pending, n limit 1`, [id])
    return Option.fromUndefinedOr(rows[0])
  }, failed("pendingWake"))

  // A message is counted at its last page (`more` 0), so a message of many
  // pages counts once.
  const fires = Effect.fn("Store.fires")(function*(since: number) {
    const [row] = yield* sql<{ n: number }>`
      select count(*) as n from everchat_msg where chat = ${id} and kind = ${KINDS.wake} and more = 0 and created >= ${since}`
    return row!.n
  }, failed("fires"))

  // Each join names the chat on both sides. The switch is not read: an
  // end is counted while the chat's wake-ups are off (lead, ec-hvsq7, M13).
  const unsettledWakes = Effect.fn("Store.unsettledWakes")(function*() {
    const rows = yield* sql.unsafe(
      `select ${WAKE_COLUMNS}, t.status as turnStatus, t.why as turnWhy
       from everchat_wake w join everchat_turn t on t.chat = w.chat and t.n = w.last_turn
       where w.chat = ? and t.chat = ? and w.settled = 0
       order by w.n`,
      [id, id]
    )
    return (yield* decodeUnsettled(rows)).map((row): UnsettledWake => ({ wake: wakeOfRow(row), status: row.turnStatus, why: row.turnWhy }))
  }, failed("unsettledWakes"))

  // The rows that a function of the program made (`call`) and those that one
  // stopped (`stop_call`), as `approvalsOf` finds an approval's call, in one
  // statement: one state of the file. Each join names the chat on both
  // sides.
  const wakesOf = Effect.fn("Store.wakesOf")(function*(program: number) {
    const by = (column: "call" | "stop_call", what: "made" | "stopped") =>
      `select ${WAKE_COLUMNS}, '${what}' as way, c.n as byCall
       from everchat_wake w join everchat_call c on c.chat = w.chat and c.n = w.${column}
       where w.chat = ? and c.chat = ? and c.parent = ?`
    const rows = yield* sql.unsafe(`${by("call", "made")} union all ${by("stop_call", "stopped")} order by byCall, id`, [id, id, program, id, id, program])
    return (yield* decodeWakesOf(rows)).map((row): WakeOf => ({ wake: wakeOfRow(row), by: row.way, call: row.byCall }))
  }, failed("wakesOf"))

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
        select served, count(*) as requests, cast(sum(input) as signed) as input,
               cast(sum(cache_read) as signed) as cacheRead, cast(sum(cache_write) as signed) as cacheWrite,
               cast(sum(output) as signed) as output
        from everchat_usage where chat = ${id} group by served order by served`
    ))]
  }).pipe(failed("usageTotals"), Effect.withSpan("Store.usageTotals"))

  const launches = Effect.fn("Store.launches")(function*(limit: number) {
    return [...(yield* decodeLaunches(
      yield* sql`select n as id, pid, host, cwd, version, created, ended, why from everchat_launch where chat = ${id} order by n desc limit ${limit}`
    ))]
  }, failed("launches"))

  const version = dialect.version(sql).pipe(failed("version"), Effect.withSpan("Store.version"))

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
    approval,
    approvalOf,
    approvals,
    approvalsOf,
    untoldApprovals,
    wakes,
    dueWakes,
    pendingWake,
    fires,
    unsettledWakes,
    wakesOf,
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


// A new chat of `tenant` (16 bytes), with its first pick: the tenant's row
// when it is not there (a select, then an insert; never a REPLACE), and the
// chat's row (its tenant, a new UUIDv4 as 16 bytes, its pick). The database
// makes the chat's id. Only inside a transaction.
export const newChat = (sql: SqlClient.SqlClient, dialect: Dialect, tenant: Uint8Array, pick: Pick) =>
  Effect.gen(function*() {
    const created = yield* Clock.currentTimeMillis
    const have = yield* sql<{ id: Uint8Array }>`select id from everchat_tenant where id = ${tenant}`
    if (have.length === 0) yield* sql`insert into everchat_tenant ${sql.insert({ id: tenant, created })}`
    const uuid = uuidBytes(crypto.randomUUID())
    yield* sql`insert into everchat_chat ${sql.insert({ tenant, uuid, pick: yield* dialect.pickOf(sql, pick), created, updated: created })}`
    const made = yield* find(sql, tenant, uuid)
    return Option.isSome(made) ? { bound: made.value, uuid: uuidText(uuid) } : yield* Effect.die(new Error("the store made a chat and did not find it"))
  })

// Takes the chat `bound` for a launch: it closes the launch that a crash
// left open, refuses when its owner still has the chat (`LaunchLive`, by
// the dialect's `ownerLive`), and writes this launch's row. Only inside the
// transaction of the launch.
const takeChat = (sql: SqlClient.SqlClient, dialect: Dialect, { chat }: Bound, input: LaunchInput) =>
  Effect.gen(function*() {
    const created = yield* Clock.currentTimeMillis
    const open = yield* sql<{ n: number; pid: number; host: string; created: number }>`
      select n, pid, host, created from everchat_launch where chat = ${chat} and ended is null`
    const last = open[0]
    if (last !== undefined) {
      if (yield* dialect.ownerLive(last, input)) {
        return yield* new LaunchLive({ pid: last.pid, host: last.host, created: last.created })
      }
      yield* sql`update everchat_launch set ended = ${created}, why = 'crash' where chat = ${chat} and n = ${last.n}`
    }
    const pick = input.pick === undefined ? null : yield* dialect.pickOf(sql, input.pick)
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

// The end of the launch `n` of the chat `bound`, when the caller's scope
// closes: how the scope ended is the launch's `why`. A write (`writer`).
const endLaunch = (sql: SqlClient.SqlClient, dialect: Dialect, bound: Bound, n: number) => (exit: Exit.Exit<unknown, unknown>) =>
  Effect.gen(function*() {
    const ended = yield* Clock.currentTimeMillis
    const why = Exit.isSuccess(exit) ? "exit" : Exit.hasInterrupts(exit) ? "signal" : "error"
    yield* writer(sql, dialect, bound)(
      "statement",
      sql`update everchat_launch set ended = ${ended}, why = ${why} where chat = ${bound.chat} and n = ${n} and ended is null`
    )
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
//
// With the dialect's `beforeWrite` (lead, ec-9qt2rc, W6), the launch's
// transaction runs `beforeWrite(sql, null)` as its first statement, before
// `found` and before any write: a failure of it writes nothing and fails
// the launch (`StoreError`, op `launch`). The transaction stays the
// launch's own: no write of `writer`, no mark. With none (SQLite) it runs
// as it is.
export const open = <E>(sql: SqlClient.SqlClient, dialect: Dialect, found: Effect.Effect<Bound, E | SqlError.SqlError>, input: LaunchInput) =>
  Effect.gen(function*() {
    const before = dialect.beforeWrite
    const { bound, launch } = yield* sql.withTransaction(
      Effect.gen(function*() {
        if (before !== undefined) yield* before(sql, null).pipe(failed("launch"))
        const bound = yield* found
        const launch = yield* takeChat(sql, dialect, bound, input)
        yield* sql.afterCommit(Effect.addFinalizer(endLaunch(sql, dialect, bound, launch.id)))
        return { bound, launch }
      })
    ).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new StoreError({ op: "launch", cause }))))
    return yield* storeOf(sql, dialect, bound, launch)
  })

// The members of the store of the chat `bound`, for `launch` (whose end
// `open` has registered). Each member that writes goes through `write`
// (`writer`); a read never does.
export const storeOf = Effect.fnUntraced(function*(sql: SqlClient.SqlClient, dialect: Dialect, { chat, tenant }: Bound, launch: Launch) {
  const now = Clock.currentTimeMillis
  const pickId = (pick: Pick) => dialect.pickOf(sql, pick)
  const write = writer(sql, dialect, { tenant, chat })

  const read = reading(sql, dialect, { tenant, chat })

  // The chat's row
  // --------------

  const setPick = Effect.fn("Store.setPick")(function*(pick: Pick) {
    yield* write("transaction", Effect.gen(function*() {
      const id = yield* pickId(pick)
      yield* sql`update everchat_chat set pick = ${id}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`
    }))
  }, failed("setPick"))

  const setGoal = Effect.fn("Store.setGoal")(function*(goal: string | null) {
    yield* write("statement", sql`update everchat_chat set goal = ${goal === null ? null : goal.toWellFormed()}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`)
  }, failed("setGoal"))

  const setDraft = Effect.fn("Store.setDraft")(function*(draft: string | null) {
    yield* write("statement", sql`update everchat_chat set draft = ${draft === null ? null : draft.toWellFormed()}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`)
  }, failed("setDraft"))

  const setTaken = Effect.fn("Store.setTaken")(function*(i: number) {
    yield* write("statement", sql`update everchat_chat set taken = ${i}, updated = ${yield* now} where tenant = ${tenant} and id = ${chat}`)
  }, failed("setTaken"))

  // A write of the value that the chat has changes nothing, `updated` too.
  // A transaction of its own, or a savepoint in a note's.
  const setWakeups = Effect.fn("Store.setWakeups")(function*(on: boolean) {
    return yield* write("transaction", Effect.gen(function*() {
      const value = on ? 1 : 0
      const keys = yield* sql<{ id: number }>`
        select id from everchat_chat where tenant = ${tenant} and id = ${chat} and wakeups <> ${value}${sql.literal(dialect.forUpdate)}`
      if (keys.length === 0) return false
      yield* sql`
        update everchat_chat set wakeups = ${value}, updated = ${yield* now}
        where tenant = ${tenant} and ${sql.in("id", keys.map((key) => key.id))}`
      return true
    }))
  }, failed("setWakeups"))

  // The log
  // -------

  // The sender's key goes on the row of the first message, in its insert
  // (the table refuses an update). Its form is checked here, before any
  // write: a check in the table would need a pattern, which SQLite and
  // MariaDB write in two ways (docs/schema.html, everchat_msg). A key that
  // the chat has already is refused by the index (chat, sender_key), and
  // the transaction takes back what it wrote. A key goes only on a row that
  // starts a message: when the chat's last row continues (`more` 1), a
  // keyed append fails before its first insert (one read by the table's
  // key); one with no key may continue that message.
  const append = Effect.fn("Store.append")(function*(messages: ReadonlyArray<NewMessage>, given?: string | null) {
    const key = given ?? null
    if (key !== null && !SENDER_KEY.test(key)) {
      return yield* Effect.fail(new Error("the sender's key is not 1 to 128 bytes of visible ASCII"))
    }
    if (key !== null && messages.length === 0) {
      return yield* Effect.fail(new Error("the sender's key has no message"))
    }
    return yield* write("transaction", Effect.gen(function*() {
      const created = yield* now
      const first = yield* nextMessage(sql, chat)
      if (key !== null && first > 0) {
        const { more } = yield* only(yield* sql<{ more: number }>`select more from everchat_msg where chat = ${chat} and i = ${first - 1}`)
        if (more === 1) return yield* Effect.fail(new Error("the sender's key is not at a message's start"))
      }
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
    return yield* write("transaction", Effect.gen(function*() {
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
    yield* write("statement", dialect.putView(sql, { chat, name: view.name, parts: JSON.stringify(view.parts), batch: view.batch ? 1 : 0, created: at, updated: at }))
  }, failed("putView"))

  // The images
  // ----------

  const putImage = Effect.fn("Store.putImage")(function*(image: NewImage) {
    return yield* write("transaction", Effect.gen(function*() {
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
    return yield* write("transaction", Effect.gen(function*() {
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
    yield* write("transaction", Effect.gen(function*() {
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

  // The ceiling is checked before the transaction, as `answerApproval`
  // checks its bounds; the schema's checks are the second guard.
  const startTurn = Effect.fn("Store.startTurn")(function*(turn: NewTurn) {
    const steps = turn.steps ?? null
    const tokens = turn.tokens ?? null
    const whole = (value: number | null) => value !== null && Number.isSafeInteger(value) && value > 0
    if ((steps === null) !== (tokens === null) || (steps !== null && !(whole(steps) && whole(tokens)))) {
      return yield* Effect.fail(new Error(`a turn's ceiling is both steps and tokens, each a whole number over 0, or neither, not ${steps} steps and ${tokens} tokens`))
    }
    return yield* write("transaction", Effect.gen(function*() {
      const pick = yield* pickId(turn.pick)
      const head = yield* putHead(turn.head)
      const n = yield* next(sql, chat, "everchat_turn")
      yield* sql`insert into everchat_turn ${
        sql.insert({ chat, n, agent: turn.agent ?? null, status: "running", pick, head, first_msg: turn.firstMsg, launch: launch.id, created: yield* now, steps, tokens })
      }`
      return yield* only(yield* turnRows(sql, chat, " and t.n = ?", [n]))
    }))
  }, failed("startTurn"))

  const endTurn = Effect.fn("Store.endTurn")(function*(id: number, status: "done" | "stopped" | "failed", why: string | null = null) {
    yield* write("statement", sql`
      update everchat_turn set status = ${status}, ended = ${yield* now}, why = ${why === null ? null : why.toWellFormed()}
      where chat = ${chat} and n = ${id} and status = 'running'`)
  }, failed("endTurn"))

  // A turn's items: its own coordinate `n`, from 0 in each turn, as a
  // message's `i` (docs/schema.html, section 1: a key of a chat's own
  // coordinates).
  const addTurnItem = Effect.fn("Store.addTurnItem")(function*(turn: number, kind: "user" | "turn" | "back", body: string) {
    return yield* write("transaction", Effect.gen(function*() {
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
    return yield* write("transaction", Effect.gen(function*() {
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
    yield* write("statement", sql`
      update everchat_call set status = ${end.status}, output = ${output}, size = ${size}, shown = ${end.shown ?? size}, pgid = null, ended = ${yield* now}
      where chat = ${chat} and n = ${id} and status = 'running'`)
  }, failed("endCall"))

  const setCallPgid = Effect.fn("Store.setCallPgid")(function*(id: number, pgid: number) {
    yield* write("statement", sql`update everchat_call set pgid = ${pgid} where chat = ${chat} and n = ${id} and status = 'running'`)
  }, failed("setCallPgid"))

  // The approval's `turn`, `fn` and `input` are read from the call's row,
  // in the transaction that closes it: the call that a yes runs is the
  // call that was recorded. The select of the close's key names `running`
  // too, and must find one row, which the close changes by that key.
  const pendCall = Effect.fn("Store.pendCall")(function*(id: number, output: (approval: number) => string) {
    return yield* write("transaction", Effect.gen(function*() {
      const rows = yield* sql<{ turn: number; parent: number | null; fn: string; input: string; status: string }>`
        select turn, parent, fn, input, status from everchat_call where chat = ${chat} and n = ${id}`
      const row = rows[0]
      if (row === undefined) return yield* Effect.fail(new Error(`the chat has no call ${id}`))
      if (row.parent === null) return yield* Effect.fail(new Error(`the call ${id} is a program, and only a function's call waits for an answer`))
      if (row.status !== "running") return yield* Effect.fail(new Error(`the call ${id} is ${row.status}, not running`))
      const n = yield* next(sql, chat, "everchat_approval")
      const at = yield* now
      yield* sql`insert into everchat_approval ${
        sql.insert({ chat, n, turn: row.turn, call: id, fn: row.fn, input: row.input, status: "pending", created: at, updated: at })
      }`
      const text = output(n).toWellFormed()
      const size = bytes(text)
      const key = yield* Effect.flatMap(
        sql<{ n: number }>`select n from everchat_call where chat = ${chat} and n = ${id} and status = 'running'${sql.literal(dialect.forUpdate)}`,
        only
      )
      yield* sql`
        update everchat_call set status = 'pending', output = ${text}, size = ${size}, shown = ${size}, pgid = null, ended = ${at}
        where chat = ${chat} and n = ${key.n}`
      return n
    }))
  }, failed("pendCall"))

  // The approvals' changes. Each reads the time once, and each update, or
  // the select of the keys that it changes, names the state that it
  // changes from, so that a row changes only by rule 2 (docs/schema.html,
  // everchat_approval) even when two writers race. The rows that an update
  // changed are read again, in the same transaction.
  const approvalsIn = (ns: ReadonlyArray<number>) =>
    ns.length === 0 ? Effect.succeed([]) : approvalRows(sql, chat, ` and a.n in (${ns.map(() => "?").join(", ")}) order by a.n`, ns)
  const oneApproval = (n: number) => Effect.map(approvalRows(sql, chat, " and a.n = ?", [n]), (rows) => Option.fromUndefinedOr(rows[0]))

  // The bounds are checked before the transaction: a value out of them
  // writes nothing. An approval that has waited more than `WAIT` is expired
  // here, at its answer, with no timer.
  const answerApproval = Effect.fn("Store.answerApproval")(function*(n: number, answer: ApprovalAnswer) {
    const who = answer.who.toWellFormed()
    const text = answer.text === undefined || answer.text === null ? null : answer.text.toWellFormed()
    if (who.length < 1 || who.length > WHO_MAX) {
      return yield* Effect.fail(new Error(`who answers is a text of 1 to ${WHO_MAX} characters, not ${who.length}`))
    }
    if (text !== null && text.length > ANSWER_MAX) {
      return yield* Effect.fail(new Error(`an answer's text has at most ${ANSWER_MAX} characters, not ${text.length}`))
    }
    return yield* write("transaction", Effect.gen(function*() {
      const found = yield* oneApproval(n)
      if (Option.isNone(found)) return { _tag: "none" } as Answered
      const row = found.value
      if (row.status !== "pending") return { _tag: "closed", approval: row } as Answered
      const at = yield* now
      if (at - row.created > WAIT) {
        yield* sql`
          update everchat_approval set status = 'expired', answered = ${at}, updated = ${at}
          where chat = ${chat} and n = ${n} and status = 'pending'`
        return { _tag: "expired", approval: Option.getOrThrow(yield* oneApproval(n)) } as Answered
      }
      yield* sql`
        update everchat_approval set status = ${answer.yes ? "yes" : "no"}, who = ${who}, answer = ${text}, answered = ${at}, updated = ${at}
        where chat = ${chat} and n = ${n} and status = 'pending'`
      return { _tag: "answered", approval: Option.getOrThrow(yield* oneApproval(n)) } as Answered
    }))
  }, failed("answerApproval"))

  const expireApprovals = Effect.fn("Store.expireApprovals")(function*() {
    return yield* write("transaction", Effect.gen(function*() {
      const at = yield* now
      const changed = (yield* sql<{ n: number }>`
        select n from everchat_approval
        where chat = ${chat} and status = 'pending' and ${at} - created > ${WAIT}${sql.literal(dialect.forUpdate)}`).map((row) => row.n)
      if (changed.length > 0) {
        yield* sql`
          update everchat_approval set status = 'expired', answered = ${at}, updated = ${at}
          where chat = ${chat} and ${sql.in("n", changed)}`
      }
      return yield* approvalsIn(changed)
    }))
  }, failed("expireApprovals"))

  const startApproval = Effect.fn("Store.startApproval")(function*(n: number) {
    return yield* write("transaction", Effect.gen(function*() {
      const at = yield* now
      const changed = yield* sql<{ n: number }>`
        select n from everchat_approval where chat = ${chat} and n = ${n} and status = 'yes'${sql.literal(dialect.forUpdate)}`
      if (changed.length === 0) return Option.none<Approval>()
      yield* sql`
        update everchat_approval set status = 'running', updated = ${at}
        where chat = ${chat} and ${sql.in("n", changed.map((row) => row.n))}`
      return yield* oneApproval(n)
    }))
  }, failed("startApproval"))

  const endApproval = Effect.fn("Store.endApproval")(function*(n: number, end: ApprovalEnd) {
    return yield* write("transaction", Effect.gen(function*() {
      const at = yield* now
      const changed = yield* sql<{ n: number }>`
        select n from everchat_approval where chat = ${chat} and n = ${n} and status = 'running'${sql.literal(dialect.forUpdate)}`
      if (changed.length === 0) return Option.none<Approval>()
      yield* sql`
        update everchat_approval set status = ${end.status}, output = ${end.output.toWellFormed()}, ended = ${at}, updated = ${at}
        where chat = ${chat} and ${sql.in("n", changed.map((row) => row.n))}`
      return yield* oneApproval(n)
    }))
  }, failed("endApproval"))

  const cutApprovals = Effect.fn("Store.cutApprovals")(function*(output: string) {
    return yield* write("transaction", Effect.gen(function*() {
      const at = yield* now
      const changed = (yield* sql<{ n: number }>`
        select n from everchat_approval where chat = ${chat} and status = 'running'${sql.literal(dialect.forUpdate)}`).map((row) => row.n)
      if (changed.length > 0) {
        yield* sql`
          update everchat_approval set status = 'cut', output = ${output.toWellFormed()}, ended = ${at}, updated = ${at}
          where chat = ${chat} and ${sql.in("n", changed)}`
      }
      return yield* approvalsIn(changed)
    }))
  }, failed("cutApprovals"))

  // The message is the chat's own: the reference (chat, msg) refuses
  // another chat's.
  const tellApproval = Effect.fn("Store.tellApproval")(function*(n: number, msg: number) {
    yield* write("transaction", Effect.gen(function*() {
      const found = yield* oneApproval(n)
      if (Option.isNone(found)) return yield* Effect.fail(new Error(`the chat has no approval ${n}`))
      const row = found.value
      if (!TOLD.includes(row.status)) return yield* Effect.fail(new Error(`the approval ${n} is ${row.status}, and has no end to tell`))
      if (row.msg !== null) return yield* Effect.fail(new Error(`the approval ${n} was told already, at message ${row.msg}`))
      const key = yield* Effect.flatMap(
        sql<{ n: number }>`
          select n from everchat_approval
          where chat = ${chat} and n = ${n} and msg is null and ${sql.in("status", TOLD)}${sql.literal(dialect.forUpdate)}`,
        only
      )
      yield* sql`update everchat_approval set msg = ${msg}, updated = ${yield* now} where chat = ${chat} and n = ${key.n}`
    }))
  }, failed("tellApproval"))

  // Wake-ups
  // --------

  // The text's bounds are checked before the transaction, as
  // `answerApproval` checks its own: a text out of them writes nothing.
  // The active rows are counted in the transaction of the insert. The store
  // computes no slot: `due` is the `first` that the caller gives.
  const makeWake = Effect.fn("Store.makeWake")(function*(wake: NewWake, limit: number) {
    const text = wake.text.toWellFormed()
    if (text.length < 1 || text.length > WAKE_TEXT_MAX) {
      return yield* Effect.fail(new Error(`a wake-up's text is a text of 1 to ${WAKE_TEXT_MAX} characters, not ${text.length}`))
    }
    return yield* write("transaction", Effect.gen(function*() {
      const [active] = yield* sql<{ n: number }>`select count(*) as n from everchat_wake where chat = ${chat} and stopped is null`
      if (active!.n >= limit) return { _tag: "full" } as MadeWake
      const n = yield* next(sql, chat, "everchat_wake")
      const at = yield* now
      yield* sql`insert into everchat_wake ${
        sql.insert({
          chat,
          n,
          text,
          cron: wake.cron === undefined || wake.cron === null ? null : wake.cron.toWellFormed(),
          at: wake.at ?? null,
          zone: wake.zone.toWellFormed(),
          first: wake.first,
          turn: wake.turn ?? null,
          call: wake.call ?? null,
          due: wake.first,
          created: at,
          updated: at
        })
      }`
      const [made] = yield* wakeRows(sql, chat, " and n = ?", [n])
      return { _tag: "made", wake: made! } as MadeWake
    }))
  }, failed("makeWake"))

  // The firer's write. Each condition is in the select of the row's key
  // (the row active, the chat's wake-ups on, the slot after `slot` and
  // after the waiting `pending`), and the update by that key follows in the
  // same transaction, so no write comes between the test and the write; a
  // row that fails one is left as it was, and the answer is false. The
  // row's check (`pending > slot`) stays the second guard. `missed` is
  // assigned before `pending`, so it reads the old `pending` on both
  // databases. Its two minimums are `case`s: null when either side is
  // null, as SQLite's `min` gives.
  const pendWake = Effect.fn("Store.pendWake")(function*(n: number, pend: WakePend) {
    return yield* write("transaction", Effect.gen(function*() {
      const changed = yield* sql<{ n: number }>`
        select n from everchat_wake
        where chat = ${chat} and n = ${n} and stopped is null
          and exists (select 1 from everchat_chat where id = ${chat} and wakeups = 1)
          and (slot is null or ${pend.pending} > slot) and (pending is null or ${pend.pending} > pending)${sql.literal(dialect.forUpdate)}`
      if (changed.length === 0) return false
      yield* sql`
        update everchat_wake
        set missed = case when pending is null then ${least(sql, pend.missed, WAKE_MISSED_MAX)}
                          else ${least(sql, sql`missed + 1 + ${pend.missed}`, WAKE_MISSED_MAX)} end,
            pending = ${pend.pending}, due = ${pend.due}, updated = ${yield* now}
        where chat = ${chat} and ${sql.in("n", changed.map((row) => row.n))}`
      return true
    }))
  }, failed("pendWake"))

  // An offer's write, in its transaction (a savepoint inside it), as
  // `tellApproval` is: the row is read and tested first, and the select of
  // its key names the same conditions and must find one row, which the
  // update then changes by that key. It writes only the
  // row's own columns, and no check of the table refuses them for a row
  // that `pendingWake` gave (docs/wakeups.md, section 2; lead, ec-e75r,
  // D1), the row read with the same lock held:
  // - `(stopped is null) = (why is null)`: a reminder sets both.
  // - `stop_call is null or (why is not null and why = 'unwake')`: an
  //   active row has no `stop_call` (only `unwake` sets it, and stops the
  //   row).
  // - `stopped is null or (due is null and pending is null)`: a reminder
  //   that stops clears both, and `missed`, as a stop does, also when the
  //   firer gave it a `due` or a newer slot waits: a reminder has one slot
  //   (lead, ec-muncvc, ruling 4a); a routine does not stop.
  // - `pending is null or slot is null or pending > slot`: `slot` becomes
  //   `read.pending`; the fire goes (`pending` null), or a newer slot
  //   waits, which is after `read.pending`, since a `pendWake` takes only a
  //   slot after the waiting one.
  // - `last_turn is not null or settled = 1`: `last_turn` is `turn`, which
  //   the offer wrote before (its reference to the chat's turn holds).
  // - `missed`, `fired`, `failed` 0 or more: `fired` grows, `missed` goes no
  //   lower than 0, `failed` is not written.
  // - The guards: no column of the make, nor the chat or `n`, is written.
  const fireWake = Effect.fn("Store.fireWake")(function*(n: number, turn: number, read: WakeRead) {
    yield* write("transaction", Effect.gen(function*() {
      const [row] = yield* wakeRows(sql, chat, " and n = ?", [n])
      if (row === undefined) return yield* Effect.fail(new Error(`the chat has no wake-up ${n}`))
      if (row.stopped !== null) return yield* Effect.fail(new Error(`the wake-up ${n} stopped, and has no fire`))
      if (!row.settled) return yield* Effect.fail(new Error(`the wake-up ${n}'s last fire is not settled`))
      if (row.pending === null || row.pending < read.pending || (row.slot !== null && read.pending <= row.slot)) {
        return yield* Effect.fail(new Error(`the wake-up ${n} has no fire of the slot ${read.pending} waiting`))
      }
      const at = yield* now
      const key = yield* Effect.flatMap(
        sql<{ n: number }>`
          select n from everchat_wake
          where chat = ${chat} and n = ${n} and stopped is null and settled = 1
            and pending >= ${read.pending} and (slot is null or ${read.pending} > slot)${sql.literal(dialect.forUpdate)}`,
        only
      )
      yield* sql`
        update everchat_wake
        set slot = ${read.pending}, fired = fired + 1, last_turn = ${turn}, settled = 0,
            missed = case when cron is null or pending = ${read.pending} then 0
                          when missed >= ${WAKE_MISSED_MAX} then missed
                          else ${greatest(sql, sql`missed - ${read.missed} - 1`, 0)} end,
            pending = case when cron is null or pending = ${read.pending} then null else pending end,
            due = case when cron is null then null else due end,
            stopped = case when cron is null then ${at} end,
            why = case when cron is null then 'fired' end,
            updated = ${at}
        where chat = ${chat} and n = ${key.n}`
    }))
  }, failed("fireWake"))

  // The firer's count of a wake turn's end (docs/wakeups.md, section 7): a
  // transaction of its own, or a savepoint in a note's (the stop at
  // `WAKE_FAILURES`), as `tellApproval` is. The select of the row's key
  // holds its tests (the row's `last_turn` is `turn`, its end not counted),
  // so a late or a second settle changes nothing. The stop is in the same
  // update: when `end` is `failed` and the count reaches
  // `WAKE_FAILURES`, an active row stops, why `failed`, with nothing left
  // to fire, which the check `stopped is null or (due is null and pending
  // is null)` asks for; a stopped row keeps its first `stopped` and `why`.
  // The row's tests are in the select of its key, with its `failed` and
  // `stopped`; the update by that key follows in the same transaction, and
  // binds the new `failed` and whether the row stops, both from the
  // selected row: the update reads no column that it writes (the rule at
  // the store's head), and the answer tells whether this call stopped it.
  // The chat's switch is not read (lead, ec-hvsq7, M13).
  const settleWake = Effect.fn("Store.settleWake")(function*(n: number, turn: number, end: WakeEnd) {
    if (end !== "done" && end !== "failed" && end !== "kept") return yield* Effect.die(new Error(`a wake turn's end is done, failed or kept, not ${String(end)}`))
    return yield* write("transaction", Effect.gen(function*() {
      const [row] = yield* sql<{ n: number; failed: number; stopped: number | null }>`
        select n, failed, stopped from everchat_wake
        where chat = ${chat} and n = ${n} and last_turn = ${turn} and settled = 0${sql.literal(dialect.forUpdate)}`
      if (row === undefined) return { settled: false, stopped: false } satisfies Settled
      const at = yield* now
      const failed = end === "done" ? 0 : end === "failed" ? row.failed + 1 : row.failed
      const stops = row.stopped === null && end === "failed" && failed >= WAKE_FAILURES
      const stop = stops ? sql`, due = null, pending = null, missed = 0, why = 'failed', stopped = ${at}` : sql.literal("")
      yield* sql`
        update everchat_wake set failed = ${failed}, settled = 1${stop}, updated = ${at}
        where chat = ${chat} and n = ${row.n}`
      return { settled: true, stopped: stops } satisfies Settled
    }))
  }, failed("settleWake"))

  // A stop by the model (`unwake`, with its call) or by the person: a
  // transaction of its own, or a savepoint in a note's. The select of the
  // row's key holds its test (the row active), and the update by that key
  // follows; a row that is not active is left as it was, and the answer is
  // false. A call goes only with
  // `unwake` (the check `stop_call is null or (why is not null and why =
  // 'unwake')` is the second guard).
  const stopWake = Effect.fn("Store.stopWake")(function*(n: number, why: WakeStop, call: number | null = null) {
    if (why !== "unwake" && why !== "person") return yield* Effect.die(new Error(`a wake-up is stopped by unwake or the person, not ${String(why)}`))
    if (why === "person" && call !== null) return yield* Effect.fail(new Error("the person's stop of a wake-up has no call"))
    return yield* write("transaction", Effect.gen(function*() {
      const at = yield* now
      const changed = yield* sql<{ n: number }>`
        select n from everchat_wake where chat = ${chat} and n = ${n} and stopped is null${sql.literal(dialect.forUpdate)}`
      if (changed.length === 0) return false
      yield* sql`
        update everchat_wake
        set stopped = ${at}, why = ${why}, stop_call = ${call}, due = null, pending = null, missed = 0, updated = ${at}
        where chat = ${chat} and ${sql.in("n", changed.map((row) => row.n))}`
      return true
    }))
  }, failed("stopWake"))

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
    return yield* write("transaction", Effect.gen(function*() {
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
    yield* write("transaction", Effect.gen(function*() {
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
    const rows = yield* write("statement", sql<{ n: number }>`delete from everchat_log where chat = ${chat} and created < ${before} returning n`)
    return rows.length
  }, failed("dropDiagnostics"))

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
    Effect.mapError(
      write("transaction", effect),
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
    setWakeups,
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
    pendCall,
    answerApproval,
    expireApprovals,
    startApproval,
    endApproval,
    cutApprovals,
    tellApproval,
    makeWake,
    pendWake,
    fireWake,
    settleWake,
    stopWake,
    addEvent,
    addDiagnostics,
    dropDiagnostics
  })
})

// The chats of a deployment
// -------------------------

// The tag `Chats` over the `SqlClient` in the context: a chat is made and
// found by its tenant and its UUID, and its store and its reads are the
// ones that the local layers give for the file's chat. With the dialect's
// `beforeWrite`, the make's transaction runs `beforeWrite(sql, null)` as
// its first statement (lead, ec-9qt2rc, W6): a failure of it writes
// nothing and fails the make.
export const chatsOf = (sql: SqlClient.SqlClient, dialect: Dialect) =>
  Chats.of({
    make: Effect.fn("Chats.make")(function*(tenant: string, pick: Pick) {
      const id = parsed(tenant)
      if (Option.isNone(id)) return yield* new StoreError({ op: "make", cause: new Error("the tenant is no UUID") })
      const before = dialect.beforeWrite
      const make = newChat(sql, dialect, id.value, pick)
      const made = yield* sql.withTransaction(before === undefined ? make : Effect.andThen(before(sql, null), make)).pipe(failed("make"))
      return made.uuid
    }),
    store: (tenant: string, chat: string, launch: LaunchInput) => open(sql, dialect, chatOf(sql, tenant, chat), launch),
    reads: Effect.fn("Chats.reads")(function*(tenant: string, chat: string) {
      const found = yield* chatOf(sql, tenant, chat).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new StoreError({ op: "open", cause }))))
      return Reads.of(reading(sql, dialect, found))
    })
  })
