// Store
// =====
// The store's data, its errors and its two services. The SQL that serves
// them, and the layers that build them, are in `sqlite.ts`: this file reaches
// no runtime API, so that each host can give the store its own driver.
//
// The rules a store keeps (docs/schema.html, section 1):
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
// - A store is bound to one chat. Each of its reads and writes is of that
//   chat, and no member takes a chat: a row's number (`id`, a message's `i`)
//   is a number in the chat. The local file has one chat, of one tenant,
//   made by its first launch. A file can hold the chats of many tenants:
//   `Chats` makes them, and finds a chat only by its tenant and its UUID. A
//   chat's UUID, and a tenant's, is text here, 16 bytes in the file.
//
// The store has two parts, and a tag above them. `Store` is all of it, for
// the launch that owns the file (or the chat). `Reads` is only its reads, for a process that does not own the file
// (the inspector): it takes no launch and it writes nothing, over a
// connection that cannot write. Such a process can read while a launch runs,
// because the database is in WAL mode: a reader does not block the writer.
// `Chats`, the tag of a deployment, makes chats and gives a `Store` or the
// reads of one chat.
//
// Not here yet: the agents. They come with the code that needs them.

import { Context, type Effect, type Option, Schema, type Scope } from "effect"

// Data
// ----

export const Kind = Schema.Literals(["user", "asst", "tool", "echo", "work", "note", "late"])
export type Kind = typeof Kind.Type

// The kinds of message. The model reads each message as `<kind>: <text>`.
// The ids are the ones in the table `kind`. Never change or reuse an id.
export const KINDS = {
  user: 1, // the person
  asst: 2, // EverChat
  tool: 3, // a program that the model ran
  echo: 4, // that program's result
  work: 5, // an agent's report
  note: 6, // the program itself
  late: 7 // the result of a call that ran after a person's yes
} as const

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

// The key of a message's sender (the host's `Idempotency-Key`): 1 to 128
// bytes of visible ASCII (0x21 to 0x7E). Two keys that differ in letter
// case are two keys. A key is of its chat: the same key in another chat is
// another message. The store refuses a key of another form.
export const SENDER_KEY = /^[\x21-\x7e]{1,128}$/

// The message of a key: its pages (the first one has the key; the pages
// that follow it in the same message), and the number of its `accepted`
// event.
export interface Keyed {
  readonly messages: ReadonlyArray<Message>
  readonly accepted: number
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
  readonly seq: number // the chat's last event number; 0 with no event
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

// An image as it was sent to the model. Its original, when that was not
// what was sent, is not kept (docs/schema.html, "Keep the original image?").
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

// An event of the chat, as its row of `everchat_event` holds it: its type,
// and the rows of the chat that it reports (docs/schema.html, section 7),
// not its payload. A row references only what its event reports: a
// `message` row does not copy its message's turn and call. A piece is no
// event.
export type NewEvent =
  | { readonly type: "accepted" | "message"; readonly msg: number; readonly msgLast: number } // the first and the last message
  | { readonly type: "start" | "end"; readonly turn: number }
  | { readonly type: "call"; readonly turn: number; readonly call: number } // a program starts

// An event of the chat as a client reads it: its event number, and what it
// reports. The turn loop publishes the same events (turn.ts, `TurnEvent`,
// with the pieces), and `eventsAfter` reads them again from their rows.
export type Event =
  | { readonly type: "accepted"; readonly n: number; readonly messages: ReadonlyArray<Message> } // a message of the person is in the log
  | { readonly type: "start"; readonly n: number; readonly turn: number }
  | { readonly type: "call"; readonly n: number; readonly turn: number; readonly call: number; readonly program: string } // a program starts to run
  | { readonly type: "message"; readonly n: number; readonly message: Message } // a reply, a program, a result, or a note is in the log
  | { readonly type: "end"; readonly n: number; readonly turn: number; readonly status: "done" | "stopped" | "failed"; readonly why: string | null }

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
// bytes that its reader got. A call ends `pending` only by `pendCall`.
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
  // `pending`: it waits for a person's answer (an `Approval`); for the
  // program it has ended, and `output` is what the program got.
  readonly status: "running" | "done" | "failed" | "denied" | "cut" | "pending"
  readonly size: number | null // the bytes of the whole result
  readonly shown: number | null // the bytes that its reader got
  readonly created: number
  readonly ended: number | null
}

// The states of an approval. Its only changes: `pending` to `yes`, `no` or
// `expired`; `yes` to `running`; `running` to `done`, `failed` or `cut`.
export const ApprovalStatus = Schema.Literals(["pending", "yes", "no", "expired", "running", "done", "failed", "cut"])
export type ApprovalStatus = typeof ApprovalStatus.Type

// The most time that an approval waits for its answer, in ms: 7 days.
export const WAIT = 7 * 24 * 60 * 60 * 1000

// A call that waits for a person's answer, and what became of it; kept for
// ever. `id` is the number that the person answers. `turn`, `fn` and
// `input` are those of the call's row (`call`): the exact call that a yes
// runs. `answered` is null exactly while it is `pending` (for `expired`, it
// is the time of the expiry, and `who` is null); `who` names who answered.
// `output` and `ended` are the run's, after a yes; `ended` is set exactly
// for `done`, `failed` and `cut`. `msg` is the first page of the message
// that told the chat of the end: null until then.
export interface Approval {
  readonly id: number
  readonly turn: number
  readonly call: number
  readonly fn: string
  readonly input: string
  readonly status: ApprovalStatus
  readonly who: string | null
  readonly answer: string | null
  readonly answered: number | null
  readonly output: string | null
  readonly ended: number | null
  readonly msg: number | null
  readonly created: number
  readonly updated: number
}

// A person's answer to an approval: yes or no, who answered (a text of 1
// to `WHO_MAX` characters) and what they said with it (at most
// `ANSWER_MAX` characters; none: null). It is kept as given.
export interface ApprovalAnswer {
  readonly yes: boolean
  readonly who: string
  readonly text?: string | null | undefined
}

export const WHO_MAX = 256
export const ANSWER_MAX = 4096

// What became of an answer. `answered`: the row is now `yes` or `no`, with
// the answer. `none`: the chat has no such approval. `closed`: the row was
// not `pending`, and nothing changed. `expired`: the row had waited more
// than `WAIT`; it is `expired` now, and the answer is not kept.
export type Answered =
  | { readonly _tag: "answered"; readonly approval: Approval }
  | { readonly _tag: "none" }
  | { readonly _tag: "closed"; readonly approval: Approval }
  | { readonly _tag: "expired"; readonly approval: Approval }

// How the run of an approved call ended.
export interface ApprovalEnd {
  readonly status: "done" | "failed" | "cut"
  readonly output: string
}

// The states of an approval whose end the chat is told of (`msg`).
export const TOLD: ReadonlyArray<ApprovalStatus> = ["no", "expired", "done", "failed", "cut"]

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

// The database in `file` was made by another version of the program: its
// schema's mark is `have` (0: none), and this program's is `want`. There is
// no migration: the person moves the file aside to start a new chat.
export class DatabaseVersion extends Schema.TaggedError<DatabaseVersion>()("DatabaseVersion", {
  have: Schema.Int,
  want: Schema.Int,
  file: Schema.String
}) {}

// Another process of this host owns the database.
export class LaunchLive extends Schema.TaggedError<LaunchLive>()("LaunchLive", {
  pid: Schema.Int,
  host: Schema.String,
  created: Schema.Int
}) {}

// No chat of this tenant has this UUID. One answer, with no field, for a
// UUID that no chat has, for a chat of another tenant, and for a text that
// is no UUID: so a tenant cannot learn that another tenant's chat exists.
export class NoChat extends Schema.TaggedError<NoChat>()("NoChat", {}) {
  override get message() {
    return "This tenant has no chat with this UUID."
  }
}

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

  // The events, read again: those with an event number above `after`, in
  // the order of their numbers, at most `limit`, each with what it reports
  // as the turn loop published it. They and their messages are read on one
  // state of the database. `after` is an integer from 0, and `limit` one
  // from 1 to 1000; another value is a defect (the caller checks what comes
  // from outside).
  eventsAfter(after: number, limit: number): Effect.Effect<Array<Event>, StoreError>

  // The log. `messages` returns the ids from `from` up to, and not with,
  // `to`. `messagesAfter`: the messages of the given kinds after message
  // `after`, in order.
  readonly count: Effect.Effect<number, StoreError>
  messages(from: number, to: number): Effect.Effect<Array<Message>, StoreError>
  messagesAfter(after: number, kinds: ReadonlyArray<Kind>): Effect.Effect<Array<Message>, StoreError>
  imagesOf(i: number): Effect.Effect<Array<number>, StoreError>

  // The message of the key `key` in this chat (`append`), on one state of
  // the database; none when the chat has no message with this key. A key of
  // another form is none too: no message has it. A keyed message is written
  // with its own `accepted` event, whose `msg` is its first page, in one
  // transaction (as `Turns.say` does); on a chat that breaks this (no such
  // event, or a keyed message with no last page), `keyed` dies: a defect of
  // its writer, not a `StoreError`, since no input from outside reaches it.
  keyed(key: string): Effect.Effect<Option.Option<Keyed>, StoreError>

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

  // Approvals. `approvalOf`: the approval of the call `call`.
  // `approvals`: all, or those in one of `statuses`, in the order of their
  // ids. `approvalsOf`: those whose call is a function of the program
  // `program`, in the order of their ids.
  approval(id: number): Effect.Effect<Option.Option<Approval>, StoreError>
  approvalOf(call: number): Effect.Effect<Option.Option<Approval>, StoreError>
  approvals(statuses?: ReadonlyArray<ApprovalStatus>): Effect.Effect<Array<Approval>, StoreError>
  approvalsOf(program: number): Effect.Effect<Array<Approval>, StoreError>
  // The approvals whose end the chat has not been told of: `msg` null, in
  // one of the states `TOLD`; in the order of their ids.
  untoldApprovals(): Effect.Effect<Array<Approval>, StoreError>

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
export class Reads extends Context.Service<Reads, Reading>()("everchat/store/Reads") {}

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
  // returns them as written. `key`: the key of the sender of the message
  // that the first of them starts (SENDER_KEY), written on its row only. A
  // key of another form, a key with no message, a key that the chat has
  // already, and a key where the chat's last message continues (`more`: the
  // first of them would not start a message) fail, and nothing is written.
  // A keyed append goes with its own `accepted` event, whose `msg` is the
  // first of them, in one transaction (`keyed`).
  append(messages: ReadonlyArray<NewMessage>, key?: string | null): Effect.Effect<Array<Message>, StoreError>

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
  // A function's call that waits for a person's answer: in one
  // transaction, the approval's row, made from the call's own row (its
  // turn, its function and its input), and the call's end as `pending`,
  // with `output(n)` as what the program got; it gives the approval's id
  // `n`. It fails, and writes nothing, for a call that is not `running`
  // and for a program (a call with no parent).
  pendCall(id: number, output: (approval: number) => string): Effect.Effect<number, StoreError>

  // The approvals' changes. Each is one transaction, takes its time from
  // the clock, and changes a row only from the state that it names.
  // `answerApproval`: a person's answer to the approval `id` (`Answered`);
  // a `who` or a `text` out of its bounds fails, and writes nothing.
  // `expireApprovals`: each `pending` row that has waited more than `WAIT`
  // becomes `expired` (`answered` is now, `who` null); it gives them.
  // `startApproval`: a `yes` row becomes `running`, and is given; none
  // when the row is not `yes`, so a run starts one time.
  // `endApproval`: a `running` row ends, and is given; none when the row is
  // not `running`.
  // `cutApprovals`: each `running` row becomes `cut` with `output`; it gives
  // them. For a load: a run that an earlier launch left. An approval has no
  // launch column, so it cuts every `running` row of the chat, a live run
  // of another launch too: a caller calls it only where no other live
  // launch holds the chat. The take of a chat refuses a second launch only
  // when the open one is of this host and its process runs (`LaunchLive`;
  // the host's `409 chat_elsewhere`); an open launch of another host is
  // closed as a crash, so on a database that two hosts share, two launches
  // of one chat can be live, until a deployment's lease.
  // `tellApproval`: `msg` is the first page of the message that told the
  // chat of the row's end. It fails, and writes nothing, for a row that is
  // not there, not in a state of `TOLD`, or told already.
  answerApproval(id: number, answer: ApprovalAnswer): Effect.Effect<Answered, StoreError>
  expireApprovals(): Effect.Effect<Array<Approval>, StoreError>
  startApproval(id: number): Effect.Effect<Option.Option<Approval>, StoreError>
  endApproval(id: number, end: ApprovalEnd): Effect.Effect<Option.Option<Approval>, StoreError>
  cutApprovals(output: string): Effect.Effect<Array<Approval>, StoreError>
  tellApproval(id: number, msg: number): Effect.Effect<void, StoreError>

  // An event's row, with the chat's next event number (its `seq` plus 1),
  // which it gives back; `seq` becomes that number. An event's row belongs
  // in the transaction of what it reports: call it inside `transaction`,
  // with that write. Alone, it is a transaction of its own.
  addEvent(event: NewEvent): Effect.Effect<number, StoreError>

  // `addDiagnostics` writes them in one transaction, in the order given.
  // `dropDiagnostics` deletes those from before `before` (a time), and
  // gives their number.
  addDiagnostics(rows: ReadonlyArray<NewDiagnostic>): Effect.Effect<void, StoreError>
  dropDiagnostics(before: number): Effect.Effect<number, StoreError>
}>()("everchat/store/Store") {}

// The chats of a deployment, in one database. A tenant and a chat are their
// UUIDs, as text (8-4-4-4-12); a chat is found only by its tenant and its
// UUID. `make` makes a chat of `tenant`, with its first pick, and gives the
// chat's UUID; it makes the tenant's row when it is not there. `store` gives
// the store of the chat for one launch, in a scope: it takes the chat (a
// row of `launch`, as `storeLayer` does for the local file's chat), and
// ends that launch when the scope closes. `reads` gives the chat's reads.
// `store` and `reads` fail with `NoChat` for any chat that is not the
// tenant's.
export class Chats extends Context.Service<Chats, {
  make(tenant: string, pick: Pick): Effect.Effect<string, StoreError>
  store(tenant: string, chat: string, launch: LaunchInput): Effect.Effect<typeof Store.Service, NoChat | LaunchLive | StoreError, Scope.Scope>
  reads(tenant: string, chat: string): Effect.Effect<Reading, NoChat | StoreError>
}>()("everchat/store/Chats") {}

export interface Options {
  readonly launch: LaunchInput
  // The pick of a new chat. It is used once, when the chat's row is made.
  readonly pick: Pick
}
