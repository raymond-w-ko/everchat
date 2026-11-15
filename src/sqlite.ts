// SQLite
// ======
// The store over SQLite: the SQL of `Store` and `Reads` (store.ts) over
// Effect's `SqlClient`, and the layers that build them. No other module uses
// SQL. The rules that the store keeps are in `store.ts`; the tables are in
// `migrations.ts`, and the file, its driver and its pragmas in `database.ts`.

import { Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import * as Database from "./database.ts"
import {
  type CallEnd,
  DatabaseVersion,
  Kind,
  KINDS,
  type Launch,
  LaunchLive,
  type Message,
  type NewCall,
  type NewDiagnostic,
  type NewImage,
  type NewMessage,
  type NewNode,
  type NewTurn,
  type NewUsage,
  Node,
  type Options,
  Part,
  Pick,
  Reads,
  type Reading,
  Store,
  StoreError,
  type Turn,
  type UsageFilter,
  type UsageRecord,
  type View,
  ViewName
} from "./store.ts"

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

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).length

// SQLite takes at most 32,766 values in one statement.
const KEYS_PER_QUERY = 10_000

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

const reading = (sql: SqlClient.SqlClient): Reading => {
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
  const read = reading(sql)

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

// The layers
// ----------

// The reads over the `SqlClient` in the context.
export const readsLayerNoDatabase = Layer.effect(Reads, Effect.map(SqlClient.SqlClient, (sql) => Reads.of(reading(sql))))

// The reads over the database in the file `filename`, which must be there.
// It fails when another version of the program made the file: a read of
// tables that this program does not know gives wrong answers.
export const readsLayer = (filename: string) =>
  Layer.effect(
    Reads,
    Effect.gen(function*() {
      const database = yield* Layer.build(Database.readonly(filename)).pipe(failed("open"))
      const have = yield* Database.version.pipe(Effect.provide(database), failed("open"))
      if (have !== Database.VERSION) {
        return yield* new DatabaseVersion({ have, want: Database.VERSION })
      }
      return Reads.of(reading(Context.get(database, SqlClient.SqlClient)))
    })
  )

// The store over the `SqlClient` in the context.
export const storeLayerNoDatabase = (options: Options) => Layer.effect(Store, make(options))

// The store over the database in the file `filename`.
export const storeLayer = (filename: string, options: Options) =>
  storeLayerNoDatabase(options).pipe(Layer.provide(Database.layer(filename)))
