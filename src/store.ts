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
// This first part of the store covers the chat's row, the launches, the log,
// the tree, the views, the images, the picks, the heads, and the usage. The
// turns, the calls, and the agents come with the code that needs them.

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
}

// Errors
// ------

// The database refused an operation, or gave back a row that the store does
// not understand.
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  op: Schema.String,
  cause: Schema.Defect()
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

const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(MessageRow))
const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(Node))
const decodeViews = Schema.decodeUnknownEffect(Schema.Array(ViewRow))
const decodeChats = Schema.decodeUnknownEffect(Schema.Array(ChatRow))
const decodeImages = Schema.decodeUnknownEffect(Schema.Array(ImageRow))

const bytes = (text: string) => Buffer.byteLength(text, "utf8")

// SQLite takes at most 32,766 values in one statement.
const KEYS_PER_QUERY = 10_000

// The service
// -----------

export class Store extends Context.Service<Store, {
  // This launch.
  readonly launch: Launch

  // Runs `effect` as one transaction. If it fails, nothing that it wrote
  // stays.
  transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R>

  // The chat's row.
  readonly chat: Effect.Effect<Chat, StoreError>
  setPick(pick: Pick): Effect.Effect<void, StoreError>
  setGoal(goal: string | null): Effect.Effect<void, StoreError>
  setDraft(draft: string | null): Effect.Effect<void, StoreError>
  setTaken(i: number): Effect.Effect<void, StoreError>

  // The log. `append` gives the messages the next ids, with no gap, and
  // returns them as written. `messages` returns the ids from `from` up to,
  // and not with, `to`.
  readonly count: Effect.Effect<number, StoreError>
  append(messages: ReadonlyArray<NewMessage>): Effect.Effect<Array<Message>, StoreError>
  messages(from: number, to: number): Effect.Effect<Array<Message>, StoreError>
  imagesOf(i: number): Effect.Effect<Array<number>, StoreError>

  // The tree. A node is written once: a second write of a node fails.
  putNodes(nodes: ReadonlyArray<NewNode>): Effect.Effect<Array<Node>, StoreError>
  node(l: number, i: number): Effect.Effect<Option.Option<Node>, StoreError>
  nodes(parts: ReadonlyArray<Part>): Effect.Effect<Array<Node>, StoreError>

  // The views.
  view(name: ViewName): Effect.Effect<Option.Option<View>, StoreError>
  putView(view: View): Effect.Effect<void, StoreError>

  // The images. `putImage` returns the id of the image with that name, and
  // writes it only when it is not there.
  putImage(image: NewImage): Effect.Effect<number, StoreError>
  image(id: number): Effect.Effect<Option.Option<Image>, StoreError>

  // The heads: each system prompt and tool list, stored once.
  putHead(body: string): Effect.Effect<number, StoreError>
  head(id: number): Effect.Effect<Option.Option<string>, StoreError>

  // The usage of one request.
  addUsage(usage: NewUsage): Effect.Effect<void, StoreError>
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

const make = Effect.fnUntraced(function*(options: Options) {
  const sql = yield* SqlClient.SqlClient
  const alive = yield* ProcessAlive
  const now = Clock.currentTimeMillis

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

  const chat = Effect.gen(function*() {
    const rows = yield* sql`
      select c.uuid, p.vendor, p.model, p.effort, p.speed, c.goal, c.draft, c.taken, c.created, c.updated
      from chat c join pick p on p.id = c.pick`
    const row = yield* only(yield* decodeChats(rows))
    const { effort, model, speed, vendor, ...rest } = row
    return { ...rest, pick: { vendor, model, effort, speed } }
  }).pipe(failed("chat"), Effect.withSpan("Store.chat"))

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

  const nextMessage = Effect.gen(function*() {
    const row = yield* only(yield* sql<{ next: number }>`select coalesce(max(i), -1) + 1 as next from msg`)
    return row.next
  })

  const count = nextMessage.pipe(failed("count"), Effect.withSpan("Store.count"))

  const append = Effect.fn("Store.append")(function*(messages: ReadonlyArray<NewMessage>) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      const created = yield* now
      const next = yield* nextMessage
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

  const messages = Effect.fn("Store.messages")(function*(from: number, to: number) {
    const rows = yield* sql`
      select m.i, k.name as kind, m.text, m.size, m.more, m.line, m.turn, m.call, m.launch, m.created
      from msg m join kind k on k.id = m.kind
      where m.i >= ${from} and m.i < ${to}
      order by m.i`
    return (yield* decodeMessages(rows)).map((row): Message => ({ ...row, more: row.more === 1 }))
  }, failed("messages"))

  const imagesOf = Effect.fn("Store.imagesOf")(function*(i: number) {
    const rows = yield* sql<{ image: number }>`select image from msg_image where msg = ${i} order by n`
    return rows.map((row) => row.image)
  }, failed("imagesOf"))

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

  // The views
  // ---------

  const view = Effect.fn("Store.view")(function*(name: ViewName) {
    const rows = yield* decodeViews(yield* sql`select name, parts, batch from view where name = ${name}`)
    return Option.map(Option.fromUndefinedOr(rows[0]), (row): View => ({ ...row, batch: row.batch === 1 }))
  }, failed("view"))

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

  const image = Effect.fn("Store.image")(function*(id: number) {
    const rows = yield* sql`
      select id, name, type, width, height, source, created, bytes from image where id = ${id}`
    return Option.fromUndefinedOr((yield* decodeImages(rows))[0])
  }, failed("image"))

  // The heads
  // ---------

  const putHead = Effect.fn("Store.putHead")(function*(body: string) {
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    yield* sql`insert into head ${sql.insert({ hash, body, created: yield* now })} on conflict do nothing`
    const row = yield* only(yield* sql<{ id: number }>`select id from head where hash = ${hash}`)
    return row.id
  }, failed("putHead"))

  const head = Effect.fn("Store.head")(function*(id: number) {
    const rows = yield* sql<{ body: string }>`select body from head where id = ${id}`
    return Option.map(Option.fromUndefinedOr(rows[0]), (row) => row.body)
  }, failed("head"))

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
          created: yield* now
        })
      }`
    }))
  }, failed("addUsage"))

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
    Effect.mapError(
      sql.withTransaction(effect),
      (error): E | StoreError =>
        SqlError.isSqlError(error) ? new StoreError({ op: "transaction", cause: error }) : error
    )

  return Store.of({
    launch,
    transaction,
    chat,
    setPick,
    setGoal,
    setDraft,
    setTaken,
    count,
    append,
    messages,
    imagesOf,
    putNodes,
    node,
    nodes,
    putView,
    view,
    putImage,
    image,
    putHead,
    head,
    addUsage
  })
})
