// Store
// =====
// The store reads and writes the database. No other module uses SQL.
//
// The rules it keeps (docs/schema.html, section 1):
//
// - One launch owns the file. To build the store is to take the file: it
//   closes the launch that a crash left open, and it adds a row for this
//   launch. When the store's scope closes, it ends that launch. If another
//   process of this host still runs with the file, the store does not start
//   (`LaunchLive`).
// - One event, one transaction. Each operation that writes more than one row
//   is one transaction. `transaction` joins several operations into one: use
//   it for an event that needs more than one operation. Inside it, an error
//   (of the store, or the caller's own) takes back every write.
// - Text is well formed. SQLite writes a lone surrogate as U+FFFD, so the
//   store makes each text well formed before the write, and gives back what
//   it wrote. `size` is the length of that text in UTF-8 bytes.
// - Times come from Effect's clock, in milliseconds. Order comes from ids.
//
// The store has two parts. `Store` is all of it, for the launch that owns the
// file. `Reads` is only its reads, for a process that does not own the file
// (the inspector): it takes no launch and it writes nothing, over a
// connection that cannot write. Such a process can read while a launch runs,
// because the database is in WAL mode: a reader does not block the writer.
//
// Not here yet: the agents. They come with the code that needs them.

import { Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import * as Database from "./database.ts"
import { KINDS } from "./migrations.ts"

// Data
// ----

export const Kind = Schema.Literals(["user", "asst", "tool", "echo", "work", "note"])
export type Kind = typeof Kind.Type

// A model choice.
export const Pick = Schema.Struct({
  vendor: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  speed: Schema.String
})
export type Pick = typeof Pick.Type

// One message of the log (one page of a long text).
export interface Message {
  readonly i: number
  readonly kind: Kind
  readonly text: string
  readonly size: number
  readonly more: boolean // the text continues in the next message
  readonly line: string | null // its own summary line, when its writer gave one
  readonly turn: number | null
  readonly call: number | null
  readonly launch: number
  readonly created: number
}

export interface NewMessage {
  readonly kind: Kind
  readonly text: string
  readonly more?: boolean | undefined
  readonly line?: string | null | undefined
  readonly turn?: number | null | undefined
  readonly call?: number | null | undefined
  readonly images?: ReadonlyArray<number> | undefined // image ids, in order
}

// One node of the tree: a line that covers the 2^l messages from i·2^l on.
export const Node = Schema.Struct({
  l: Schema.Int,
  i: Schema.Int,
  text: Schema.String,
  size: Schema.Int,
  created: Schema.Int
})
export type Node = typeof Node.Type

export interface NewNode {
  readonly l: number
  readonly i: number
  readonly text: string
}

// One part of a view: the (l, i) of a node.
export const Part = Schema.Tuple([Schema.Int, Schema.Int])
export type Part = typeof Part.Type

export const ViewName = Schema.Literals(["chat", "seen"])
export type ViewName = typeof ViewName.Type

export interface View {
  readonly name: ViewName
  readonly parts: ReadonlyArray<Part> // oldest first
  readonly batch: boolean // a batch of merges is under way
}

export interface Chat {
  readonly uuid: string
  readonly pick: Pick
  readonly goal: string | null
  readonly draft: string | null
  readonly taken: number // the last message that a request has taken in
  readonly created: number
  readonly updated: number
}

// What a launch knows about itself when it starts.
export interface LaunchInput {
  readonly pid: number
  readonly host: string
  readonly cwd: string
  readonly version: string
  readonly runTag: string
  readonly pick?: Pick | undefined // given on the command line
}

export interface Launch extends LaunchInput {
  readonly id: number
  readonly created: number
}

// An image as it was sent to the model.
export interface Image {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly width: number
  readonly height: number
  readonly source: "person" | "tool"
  readonly created: number
  readonly bytes: Uint8Array
}

export interface NewImage {
  readonly name: string
  readonly type: string
  readonly width: number
  readonly height: number
  readonly source: "person" | "tool"
  readonly bytes: Uint8Array
  // The image as it was given, when that is not what was sent.
  readonly original?: {
    readonly type: string
    readonly width: number
    readonly height: number
    readonly bytes: Uint8Array
  } | undefined
}

// What one request to a model used.
export interface NewUsage {
  readonly served: "turn" | "compaction" | "goal"
  readonly turn?: number | null | undefined
  readonly node?: Part | null | undefined // a compaction's node
  readonly pick: Pick // as it ran
  readonly request?: string | null | undefined // the vendor's id of the request
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly searches?: number | undefined
  readonly micros?: number | null | undefined
  // Tokens that the request should have read from the cache (cache.ts).
  readonly expected?: number | null | undefined
}

// One turn, with its pick and its head as text.
export interface Turn {
  readonly id: number
  readonly agent: number | null
  readonly status: "running" | "done" | "stopped" | "failed"
  readonly pick: Pick
  readonly head: string // JSON: the system prompt and the tool list, as sent
  readonly firstMsg: number
  readonly launch: number
  readonly created: number
  readonly ended: number | null // null: it runs
  readonly why: string | null
}

export interface NewTurn {
  readonly agent?: number | null | undefined
  readonly pick: Pick
  readonly head: string
  readonly firstMsg: number
}

export interface TurnItem {
  readonly n: number
  readonly kind: "user" | "turn" | "back"
  readonly body: string
  readonly created: number
}

export interface NewCall {
  readonly turn: number
  readonly parent?: number | null | undefined
  readonly vendorId?: string | null | undefined // the vendor's id of the call: only for a program
  readonly fn: string
  readonly input: string
}

// How a call ended. `size`: the bytes of the whole result. `shown`: the
// bytes that its reader got.
export interface CallEnd {
  readonly status: "done" | "failed" | "denied" | "cut"
  readonly output: string
  readonly shown?: number | undefined
}

export interface Call {
  readonly id: number
  readonly turn: number
  readonly parent: number | null
  readonly vendorId: string | null
  readonly fn: string
  readonly input: string
  readonly output: string | null
  readonly status: "running" | "done" | "failed" | "denied" | "cut"
  readonly size: number | null // the bytes of the whole result
  readonly shown: number | null // the bytes that its reader got
  readonly created: number
  readonly ended: number | null
}

// What one request to a model used, as it is kept.
export interface UsageRecord {
  readonly id: number
  readonly served: "turn" | "compaction" | "goal"
  readonly turn: number | null
  readonly node: Part | null // a compaction's node
  readonly pick: Pick // as it ran
  readonly request: string | null // the vendor's id of the request
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly searches: number
  readonly micros: number | null
  readonly expected: number | null
  readonly created: number
}

// Which usage to read: of a turn, of a node's compactions, or all. `before`:
// only those with a lower id.
export interface UsageFilter {
  readonly turn?: number | undefined
  readonly node?: Part | undefined
  readonly before?: number | undefined
  readonly limit?: number | undefined
}

// The sums of the usage of one kind of request.
export interface UsageTotal {
  readonly served: "turn" | "compaction" | "goal"
  readonly requests: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

// A launch as it is kept. `ended` null: it runs, or it crashed and no launch
// came after it.
export interface LaunchRecord {
  readonly id: number
  readonly pid: number
  readonly host: string
  readonly cwd: string
  readonly version: string
  readonly created: number
  readonly ended: number | null
  readonly why: string | null
}

// One diagnostic: a line that the program writes about its own work.
export type Level = "debug" | "info" | "warn" | "error"

export interface NewDiagnostic {
  readonly level: Level
  readonly source: string // the module: memory, cache, turn, ...
  readonly text: string
  readonly created: number // when it happened, which is before it was written
}

export interface Diagnostic extends NewDiagnostic {
  readonly seq: number
  readonly launch: number
}

// Errors
// ------

// The database refused an operation, or gave back a row that the store does
// not understand.
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  op: Schema.String,
  cause: Schema.Defect()
}) {}

// The database was made by another version of the program: it has run
// `have` migrations, and this program knows `want`.
export class DatabaseVersion extends Schema.TaggedError<DatabaseVersion>()("DatabaseVersion", {
  have: Schema.Int,
  want: Schema.Int
}) {}

// Another process of this host owns the database.
export class LaunchLive extends Schema.TaggedError<LaunchLive>()("LaunchLive", {
  pid: Schema.Int,
  host: Schema.String,
  created: Schema.Int
}) {}

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
  uuid: Schema.String,
  ...Pick.fields,
  goal: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(Schema.String),
  taken: Schema.Int,
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
const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(TurnRow))
const decodeTurnItems = Schema.decodeUnknownEffect(Schema.Array(TurnItemRow))
const decodeCalls = Schema.decodeUnknownEffect(Schema.Array(CallRow))
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(MessageRow))
const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(Node))
const decodeViews = Schema.decodeUnknownEffect(Schema.Array(ViewRow))
const decodeChats = Schema.decodeUnknownEffect(Schema.Array(ChatRow))
const decodeImages = Schema.decodeUnknownEffect(Schema.Array(ImageRow))

const bytes = (text: string) => Buffer.byteLength(text, "utf8")

// SQLite takes at most 32,766 values in one statement.
const KEYS_PER_QUERY = 10_000

// The services
// ------------

// What a process may read. All of it holds for a process that does not own
// the file.
export interface Reading {
  // Runs `effect` on one state of the database: no write of another
  // connection shows between its reads.
  snapshot<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R>

  // A number that changes when another connection writes to the database.
  // It says nothing about this connection's own writes.
  readonly version: Effect.Effect<number, StoreError>

  // The chat's row.
  readonly chat: Effect.Effect<Chat, StoreError>

  // The log. `messages` returns the ids from `from` up to, and not with,
  // `to`. `messagesAfter`: the messages of the given kinds after message
  // `after`, in order.
  readonly count: Effect.Effect<number, StoreError>
  messages(from: number, to: number): Effect.Effect<Array<Message>, StoreError>
  messagesAfter(after: number, kinds: ReadonlyArray<Kind>): Effect.Effect<Array<Message>, StoreError>
  imagesOf(i: number): Effect.Effect<Array<number>, StoreError>

  // The tree. `nodesIn`: the nodes of level `l` from node `from` up to, and
  // not with, node `to`, in order. `levels`: the count of the nodes built at
  // each level that has one, lowest first.
  node(l: number, i: number): Effect.Effect<Option.Option<Node>, StoreError>
  nodes(parts: ReadonlyArray<Part>): Effect.Effect<Array<Node>, StoreError>
  nodesIn(l: number, from: number, to: number): Effect.Effect<Array<Node>, StoreError>
  readonly levels: Effect.Effect<Array<{ readonly l: number; readonly built: number }>, StoreError>

  // The views.
  view(name: ViewName): Effect.Effect<Option.Option<View>, StoreError>

  image(id: number): Effect.Effect<Option.Option<Image>, StoreError>

  // A head: one system prompt and tool list, as sent.
  head(id: number): Effect.Effect<Option.Option<string>, StoreError>

  // Turns. `turns`: the newest `limit` turns with an id below `before`
  // (none: all), newest first.
  turn(id: number): Effect.Effect<Option.Option<Turn>, StoreError>
  turns(before: number | null, limit: number): Effect.Effect<Array<Turn>, StoreError>
  runningTurns(agent: number | null): Effect.Effect<Array<Turn>, StoreError>

  // A turn's request, item by item, as JSON.
  turnItems(turn: number): Effect.Effect<Array<TurnItem>, StoreError>

  // Calls: a program that the model ran (no parent), or a function that a
  // program called.
  calls(turn: number): Effect.Effect<Array<Call>, StoreError>
  call(id: number): Effect.Effect<Option.Option<Call>, StoreError>

  // The usage, newest first, and its sums for each kind of request.
  usage(filter?: UsageFilter): Effect.Effect<Array<UsageRecord>, StoreError>
  readonly usageTotals: Effect.Effect<Array<UsageTotal>, StoreError>

  // The newest `limit` launches, newest first.
  launches(limit: number): Effect.Effect<Array<LaunchRecord>, StoreError>

  // The run tags of the launches that ended. No process may still carry one.
  readonly endedRunTags: Effect.Effect<Array<string>, StoreError>

  // Diagnostics (table `log`). `diagnostics` gives those after `after` (a
  // `seq`), oldest first. `lastDiagnostics` gives the newest `limit`, oldest
  // first.
  diagnostics(after?: number, limit?: number): Effect.Effect<Array<Diagnostic>, StoreError>
  lastDiagnostics(limit: number): Effect.Effect<Array<Diagnostic>, StoreError>
}

// The store's reads, for a process that does not own the file. It takes no
// launch, and its connection cannot write.
export class Reads extends Context.Service<Reads, Reading>()("everchat/store/Reads") {
  // The reads over the `SqlClient` in the context.
  static readonly layerNoDatabase = Layer.effect(Reads, Effect.map(SqlClient.SqlClient, (sql) => Reads.of(reads(sql))))

  // The reads over the database in the file `filename`, which must be
  // there. It fails when another version of the program made the file: a
  // read of tables that this program does not know gives wrong answers.
  static readonly layer = (filename: string) =>
    Layer.effect(
      Reads,
      Effect.gen(function*() {
        const database = yield* Layer.build(Database.readonly(filename)).pipe(failed("open"))
        const have = yield* Database.version.pipe(Effect.provide(database), failed("open"))
        if (have !== Database.VERSION) {
          return yield* new DatabaseVersion({ have, want: Database.VERSION })
        }
        return Reads.of(reads(Context.get(database, SqlClient.SqlClient)))
      })
    )
}

export class Store extends Context.Service<Store, Reading & {
  // This launch.
  readonly launch: Launch

  // Runs `effect` as one transaction. If it fails, nothing that it wrote
  // stays.
  transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R>

  setPick(pick: Pick): Effect.Effect<void, StoreError>
  setGoal(goal: string | null): Effect.Effect<void, StoreError>
  setDraft(draft: string | null): Effect.Effect<void, StoreError>
  setTaken(i: number): Effect.Effect<void, StoreError>

  // The log. `append` gives the messages the next ids, with no gap, and
  // returns them as written.
  append(messages: ReadonlyArray<NewMessage>): Effect.Effect<Array<Message>, StoreError>

  // The tree. A node is written once: a second write of a node fails.
  putNodes(nodes: ReadonlyArray<NewNode>): Effect.Effect<Array<Node>, StoreError>

  putView(view: View): Effect.Effect<void, StoreError>

  // The images. `putImage` returns the id of the image with that name, and
  // writes it only when it is not there.
  putImage(image: NewImage): Effect.Effect<number, StoreError>

  // The heads: each system prompt and tool list, stored once.
  putHead(body: string): Effect.Effect<number, StoreError>

  // The usage of one request.
  addUsage(usage: NewUsage): Effect.Effect<void, StoreError>

  // Turns. A turn has one pick and one head from its start to its end.
  // `endTurn` closes a turn that runs; a turn that has ended stays as it is.
  startTurn(turn: NewTurn): Effect.Effect<Turn, StoreError>
  endTurn(id: number, status: "done" | "stopped" | "failed", why?: string | null): Effect.Effect<void, StoreError>

  // `addTurnItem` gives the next number of the turn.
  addTurnItem(turn: number, kind: "user" | "turn" | "back", body: string): Effect.Effect<number, StoreError>

  // A call is written when it starts.
  startCall(call: NewCall): Effect.Effect<number, StoreError>
  endCall(id: number, end: CallEnd): Effect.Effect<void, StoreError>
  // The process group of a shell command, while it runs.
  setCallPgid(id: number, pgid: number): Effect.Effect<void, StoreError>

  // `addDiagnostics` writes them in one transaction, in the order given.
  // `dropDiagnostics` deletes those from before `before` (a time), and
  // gives their number.
  addDiagnostics(rows: ReadonlyArray<NewDiagnostic>): Effect.Effect<void, StoreError>
  dropDiagnostics(before: number): Effect.Effect<number, StoreError>
}>()("everchat/store/Store") {
  // The store over the `SqlClient` in the context.
  static readonly layerNoDatabase = (options: Options) => Layer.effect(Store, make(options))

  // The store over the database in the file `filename`.
  static readonly layer = (filename: string, options: Options) =>
    Store.layerNoDatabase(options).pipe(Layer.provide(Database.layer(filename)))
}

export interface Options {
  readonly launch: LaunchInput
  // The pick of a new chat. It is used once, when the chat's row is made.
  readonly pick: Pick
}

const failed = (op: string) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.mapError(self, (cause) => new StoreError({ op, cause }))

// The one row of a query that must give one row.
const only = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> => {
  const row = rows[0]
  return row === undefined ? Effect.die(new Error("the store expected one row and got none")) : Effect.succeed(row)
}

// The id of the next message.
const nextMessage = (sql: SqlClient.SqlClient) =>
  Effect.map(Effect.flatMap(sql<{ next: number }>`select coalesce(max(i), -1) + 1 as next from msg`, only), (row) => row.next)

const TURN = `select t.id, t.agent, t.status, p.vendor, p.model, p.effort, p.speed, h.body as head,
                     t.first_msg as firstMsg, t.launch, t.created, t.ended, t.why
              from turn t join pick p on p.id = t.pick join head h on h.id = t.head`

const turnRows = (sql: SqlClient.SqlClient, rest: string, params: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    const rows = yield* sql.unsafe(TURN + " " + rest, params)
    return (yield* decodeTurns(rows)).map(({ effort, model, speed, vendor, ...rest }): Turn => ({ ...rest, pick: { vendor, model, effort, speed } }))
  })

const CALL = "select id, turn, parent, vendor_id as vendorId, fn, input, output, status, size, shown, created, ended from call"

// The reads
// ---------

const reads = (sql: SqlClient.SqlClient): Reading => {
  const chat = Effect.gen(function*() {
    const rows = yield* sql`
      select c.uuid, p.vendor, p.model, p.effort, p.speed, c.goal, c.draft, c.taken, c.created, c.updated
      from chat c join pick p on p.id = c.pick`
    const row = yield* only(yield* decodeChats(rows))
    const { effort, model, speed, vendor, ...rest } = row
    return { ...rest, pick: { vendor, model, effort, speed } }
  }).pipe(failed("chat"), Effect.withSpan("Store.chat"))

  const count = nextMessage(sql).pipe(failed("count"), Effect.withSpan("Store.count"))

  const messages = Effect.fn("Store.messages")(function*(from: number, to: number) {
    const rows = yield* sql`
      select m.i, k.name as kind, m.text, m.size, m.more, m.line, m.turn, m.call, m.launch, m.created
      from msg m join kind k on k.id = m.kind
      where m.i >= ${from} and m.i < ${to}
      order by m.i`
    return (yield* decodeMessages(rows)).map((row): Message => ({ ...row, more: row.more === 1 }))
  }, failed("messages"))

  const messagesAfter = Effect.fn("Store.messagesAfter")(function*(after: number, kinds: ReadonlyArray<Kind>) {
    const rows = yield* sql`
      select m.i, k.name as kind, m.text, m.size, m.more, m.line, m.turn, m.call, m.launch, m.created
      from msg m join kind k on k.id = m.kind
      where m.i > ${after} and ${sql.in("m.kind", kinds.map((kind) => KINDS[kind]))}
      order by m.i`
    return (yield* decodeMessages(rows)).map((row): Message => ({ ...row, more: row.more === 1 }))
  }, failed("messagesAfter"))

  const imagesOf = Effect.fn("Store.imagesOf")(function*(i: number) {
    const rows = yield* sql<{ image: number }>`select image from msg_image where msg = ${i} order by n`
    return rows.map((row) => row.image)
  }, failed("imagesOf"))

  const node = Effect.fn("Store.node")(function*(l: number, i: number) {
    const rows = yield* sql`select l, i, text, size, created from node where l = ${l} and i = ${i}`
    return Option.fromUndefinedOr((yield* decodeNodes(rows))[0])
  }, failed("node"))

  const nodes = Effect.fn("Store.nodes")(function*(parts: ReadonlyArray<Part>) {
    const found: Array<Node> = []
    for (let at = 0; at < parts.length; at += KEYS_PER_QUERY) {
      const some = parts.slice(at, at + KEYS_PER_QUERY)
      const rows = yield* sql.unsafe(
        `select l, i, text, size, created from node
         where (l, i) in (values ${some.map(() => "(?, ?)").join(", ")})`,
        some.flat()
      )
      found.push(...(yield* decodeNodes(rows)))
    }
    return found
  }, failed("nodes"))

  const view = Effect.fn("Store.view")(function*(name: ViewName) {
    const rows = yield* decodeViews(yield* sql`select name, parts, batch from view where name = ${name}`)
    return Option.map(Option.fromUndefinedOr(rows[0]), (row): View => ({ ...row, batch: row.batch === 1 }))
  }, failed("view"))

  const image = Effect.fn("Store.image")(function*(id: number) {
    const rows = yield* sql`
      select id, name, type, width, height, source, created, bytes from image where id = ${id}`
    return Option.fromUndefinedOr((yield* decodeImages(rows))[0])
  }, failed("image"))

  const head = Effect.fn("Store.head")(function*(id: number) {
    const rows = yield* sql<{ body: string }>`select body from head where id = ${id}`
    return Option.map(Option.fromUndefinedOr(rows[0]), (row) => row.body)
  }, failed("head"))

  const runningTurns = Effect.fn("Store.runningTurns")(function*(agent: number | null) {
    return yield* (agent === null
      ? turnRows(sql, "where t.status = 'running' and t.agent is null order by t.id", [])
      : turnRows(sql, "where t.status = 'running' and t.agent = ? order by t.id", [agent]))
  }, failed("runningTurns"))

  const turnItems = Effect.fn("Store.turnItems")(function*(turn: number) {
    return [...(yield* decodeTurnItems(yield* sql`select n, kind, body, created from turn_item where turn = ${turn} order by n`))]
  }, failed("turnItems"))

  const calls = Effect.fn("Store.calls")(function*(turn: number) {
    return [...(yield* decodeCalls(
      yield* sql.unsafe(CALL + " where turn = ? order by id", [turn])
    ))]
  }, failed("calls"))

  const call = Effect.fn("Store.call")(function*(id: number) {
    const rows = yield* decodeCalls(
      yield* sql.unsafe(CALL + " where id = ?", [id])
    )
    return Option.fromUndefinedOr(rows[0])
  }, failed("call"))

  const endedRunTags = Effect.gen(function*() {
    const rows = yield* sql<{ tag: string }>`select distinct run_tag as tag from launch where ended is not null`
    return rows.map((row) => row.tag)
  }).pipe(failed("endedRunTags"), Effect.withSpan("Store.endedRunTags"))

  const diagnostics = Effect.fn("Store.diagnostics")(function*(after = 0, limit = 1000) {
    return [...(yield* decodeDiagnostics(
      yield* sql`select seq, level, source, text, launch, created from log where seq > ${after} order by seq limit ${limit}`
    ))]
  }, failed("diagnostics"))

  const lastDiagnostics = Effect.fn("Store.lastDiagnostics")(function*(limit: number) {
    return [...(yield* decodeDiagnostics(
      yield* sql`select seq, level, source, text, launch, created from log order by seq desc limit ${limit}`
    ))].reverse()
  }, failed("lastDiagnostics"))

  const nodesIn = Effect.fn("Store.nodesIn")(function*(l: number, from: number, to: number) {
    return [...(yield* decodeNodes(
      yield* sql`select l, i, text, size, created from node where l = ${l} and i >= ${from} and i < ${to} order by i`
    ))]
  }, failed("nodesIn"))

  const levels = Effect.gen(function*() {
    return [...(yield* decodeLevels(yield* sql`select l, count(*) as built from node group by l order by l`))]
  }).pipe(failed("levels"), Effect.withSpan("Store.levels"))

  const turn = Effect.fn("Store.turn")(function*(id: number) {
    return Option.fromUndefinedOr((yield* turnRows(sql, "where t.id = ?", [id]))[0])
  }, failed("turn"))

  const turns = Effect.fn("Store.turns")(function*(before: number | null, limit: number) {
    return yield* (before === null
      ? turnRows(sql, "order by t.id desc limit ?", [limit])
      : turnRows(sql, "where t.id < ? order by t.id desc limit ?", [before, limit]))
  }, failed("turns"))

  const usage = Effect.fn("Store.usage")(function*(filter: UsageFilter = {}) {
    const where: Array<string> = []
    const params: Array<number> = []
    if (filter.turn !== undefined) {
      where.push("u.turn = ?")
      params.push(filter.turn)
    }
    if (filter.node !== undefined) {
      where.push("u.node_l = ? and u.node_i = ?")
      params.push(...filter.node)
    }
    if (filter.before !== undefined) {
      where.push("u.id < ?")
      params.push(filter.before)
    }
    const rows = yield* sql.unsafe(
      `select u.id, u.served, u.turn, u.node_l as nodeL, u.node_i as nodeI, p.vendor, p.model, p.effort, p.speed,
              u.request, u.input, u.cache_read as cacheRead, u.cache_write as cacheWrite, u.output, u.searches,
              u.micros, u.expected, u.created
       from usage u join pick p on p.id = u.pick
       ${where.length === 0 ? "" : "where " + where.join(" and ")}
       order by u.id desc limit ?`,
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
        from usage group by served order by served`
    ))]
  }).pipe(failed("usageTotals"), Effect.withSpan("Store.usageTotals"))

  const launches = Effect.fn("Store.launches")(function*(limit: number) {
    return [...(yield* decodeLaunches(
      yield* sql`select id, pid, host, cwd, version, created, ended, why from launch order by id desc limit ${limit}`
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
    count,
    messages,
    messagesAfter,
    imagesOf,
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

const make = Effect.fnUntraced(function*(options: Options) {
  const sql = yield* SqlClient.SqlClient
  const alive = yield* ProcessAlive
  const now = Clock.currentTimeMillis
  const read = reads(sql)

  const pickId = Effect.fnUntraced(function*(pick: Pick) {
    const { effort, model, speed, vendor } = pick
    const created = yield* now
    yield* sql`insert into pick ${sql.insert({ vendor, model, effort, speed, created })} on conflict do nothing`
    const row = yield* only(
      yield* sql<{ id: number }>`
        select id from pick
        where vendor = ${vendor} and model = ${model} and effort = ${effort} and speed = ${speed}`
    )
    return row.id
  })

  // Take the file
  // -------------

  const launch: Launch = yield* sql.withTransaction(
    Effect.gen(function*() {
      const input = options.launch
      const created = yield* now
      const open = yield* sql<{ id: number; pid: number; host: string; created: number }>`
        select id, pid, host, created from launch where ended is null`
      const last = open[0]
      if (last !== undefined) {
        // A launch with our own pid is not another process: the pid was used
        // again (in a container, the program is always process 1). A launch
        // of another host cannot be checked, so the chat moved here.
        if (last.host === input.host && last.pid !== input.pid && alive(last.pid)) {
          return yield* new LaunchLive({ pid: last.pid, host: last.host, created: last.created })
        }
        yield* sql`update launch set ended = ${created}, why = 'crash' where id = ${last.id}`
      }
      const chats = yield* sql`select id from chat`
      if (chats.length === 0) {
        const pick = yield* pickId(options.pick)
        yield* sql`insert into chat ${
          sql.insert({ id: 1, uuid: crypto.randomUUID(), pick, created, updated: created })
        }`
      }
      const pick = input.pick === undefined ? null : yield* pickId(input.pick)
      const row = yield* only(
        yield* sql<{ id: number }>`insert into launch ${
          sql.insert({
            pid: input.pid,
            host: input.host,
            cwd: input.cwd,
            version: input.version,
            run_tag: input.runTag,
            pick,
            created
          })
        } returning id`
      )
      return { ...input, id: row.id, created }
    })
  ).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(new StoreError({ op: "launch", cause }))))

  yield* Effect.addFinalizer((exit) =>
    Effect.gen(function*() {
      const ended = yield* now
      const why = Exit.isSuccess(exit) ? "exit" : Exit.hasInterrupts(exit) ? "signal" : "error"
      yield* sql`update launch set ended = ${ended}, why = ${why} where id = ${launch.id} and ended is null`
    }).pipe(Effect.ignore)
  )

  // The chat's row
  // --------------

  const setPick = Effect.fn("Store.setPick")(function*(pick: Pick) {
    yield* sql.withTransaction(Effect.gen(function*() {
      const id = yield* pickId(pick)
      yield* sql`update chat set pick = ${id}, updated = ${yield* now}`
    }))
  }, failed("setPick"))

  const setGoal = Effect.fn("Store.setGoal")(function*(goal: string | null) {
    yield* sql`update chat set goal = ${goal === null ? null : goal.toWellFormed()}, updated = ${yield* now}`
  }, failed("setGoal"))

  const setDraft = Effect.fn("Store.setDraft")(function*(draft: string | null) {
    yield* sql`update chat set draft = ${draft === null ? null : draft.toWellFormed()}, updated = ${yield* now}`
  }, failed("setDraft"))

  const setTaken = Effect.fn("Store.setTaken")(function*(i: number) {
    yield* sql`update chat set taken = ${i}, updated = ${yield* now}`
  }, failed("setTaken"))

  // The log
  // -------

  const append = Effect.fn("Store.append")(function*(messages: ReadonlyArray<NewMessage>) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const created = yield* now
      const next = yield* nextMessage(sql)
      const written: Array<Message> = []
      for (const [n, message] of messages.entries()) {
        const text = message.text.toWellFormed()
        const row = {
          i: next + n,
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
        yield* sql`insert into msg ${sql.insert(row)}`
        for (const [k, image] of (message.images ?? []).entries()) {
          yield* sql`insert into msg_image ${sql.insert({ msg: row.i, n: k, image })}`
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
        yield* sql`insert into node ${sql.insert(row)}`
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
      insert into view ${
      sql.insert({
        name: view.name,
        parts: JSON.stringify(view.parts),
        batch: view.batch ? 1 : 0,
        created: at,
        updated: at
      })
    }
      on conflict (name) do update
      set parts = excluded.parts, batch = excluded.batch, updated = excluded.updated`
  }, failed("putView"))

  // The images
  // ----------

  const putImage = Effect.fn("Store.putImage")(function*(image: NewImage) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const have = yield* sql<{ id: number }>`select id from image where name = ${image.name}`
      if (have[0] !== undefined) return have[0].id
      const { original, ...sent } = image
      const row = yield* only(
        yield* sql<{ id: number }>`insert into image ${sql.insert({ ...sent, created: yield* now })} returning id`
      )
      if (original !== undefined) {
        yield* sql`insert into image_original ${sql.insert({ image: row.id, ...original })}`
      }
      return row.id
    }))
  }, failed("putImage"))

  // The heads
  // ---------

  const putHead = Effect.fn("Store.putHead")(function*(body: string) {
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    yield* sql`insert into head ${sql.insert({ hash, body, created: yield* now })} on conflict do nothing`
    const row = yield* only(yield* sql<{ id: number }>`select id from head where hash = ${hash}`)
    return row.id
  }, failed("putHead"))

  // The usage
  // ---------

  const addUsage = Effect.fn("Store.addUsage")(function*(usage: NewUsage) {
    yield* sql.withTransaction(Effect.gen(function*() {
      const pick = yield* pickId(usage.pick)
      yield* sql`insert into usage ${
        sql.insert({
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
      const row = yield* only(
        yield* sql<{ id: number }>`insert into turn ${
          sql.insert({ agent: turn.agent ?? null, status: "running", pick, head, first_msg: turn.firstMsg, launch: launch.id, created: yield* now })
        } returning id`
      )
      return yield* only(yield* turnRows(sql, "where t.id = ?", [row.id]))
    }))
  }, failed("startTurn"))

  const endTurn = Effect.fn("Store.endTurn")(function*(id: number, status: "done" | "stopped" | "failed", why: string | null = null) {
    yield* sql`
      update turn set status = ${status}, ended = ${yield* now}, why = ${why === null ? null : why.toWellFormed()}
      where id = ${id} and status = 'running'`
  }, failed("endTurn"))

  const addTurnItem = Effect.fn("Store.addTurnItem")(function*(turn: number, kind: "user" | "turn" | "back", body: string) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const row = yield* only(yield* sql<{ n: number }>`select coalesce(max(n), -1) + 1 as n from turn_item where turn = ${turn}`)
      yield* sql`insert into turn_item ${sql.insert({ turn, n: row.n, kind, body: body.toWellFormed(), created: yield* now })}`
      return row.n
    }))
  }, failed("addTurnItem"))

  // Calls
  // -----

  const startCall = Effect.fn("Store.startCall")(function*(call: NewCall) {
    const row = yield* only(
      yield* sql<{ id: number }>`insert into call ${
        sql.insert({
          turn: call.turn,
          parent: call.parent ?? null,
          vendor_id: call.vendorId ?? null,
          fn: call.fn,
          input: call.input.toWellFormed(),
          status: "running",
          launch: launch.id,
          created: yield* now
        })
      } returning id`
    )
    return row.id
  }, failed("startCall"))

  const endCall = Effect.fn("Store.endCall")(function*(id: number, end: CallEnd) {
    const output = end.output.toWellFormed()
    const size = bytes(output)
    yield* sql`
      update call set status = ${end.status}, output = ${output}, size = ${size}, shown = ${end.shown ?? size}, pgid = null, ended = ${yield* now}
      where id = ${id} and status = 'running'`
  }, failed("endCall"))

  const setCallPgid = Effect.fn("Store.setCallPgid")(function*(id: number, pgid: number) {
    yield* sql`update call set pgid = ${pgid} where id = ${id} and status = 'running'`
  }, failed("setCallPgid"))

  // Diagnostics
  // -----------

  const addDiagnostics = Effect.fn("Store.addDiagnostics")(function*(rows: ReadonlyArray<NewDiagnostic>) {
    if (rows.length === 0) {
      return
    }
    yield* sql.withTransaction(Effect.gen(function*() {
      for (const row of rows) {
        yield* sql`insert into log ${
          sql.insert({ level: row.level, source: row.source, text: row.text.toWellFormed(), launch: launch.id, created: Math.trunc(row.created) })
        }`
      }
    }))
  }, failed("addDiagnostics"))

  const dropDiagnostics = Effect.fn("Store.dropDiagnostics")(function*(before: number) {
    const rows = yield* sql<{ seq: number }>`delete from log where created < ${before} returning seq`
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
    addDiagnostics,
    dropDiagnostics
  })
})
