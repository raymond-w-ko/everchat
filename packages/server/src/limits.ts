// Limits
// ======
// The limits of the host and their check at its start (docs/host.md,
// section 8, "Limits" and "The checks at start"). `limits(given)` gives the
// limits in use, the defaults with the caller's over them, or fails with
// `LimitsRefused`. The host, the routes and the socket read each number from
// what it gives; the fit and the host use the sums.
//
// One field for each row of the page's limits table. A row with a name in
// `code` keeps it; a row with two numbers is two fields (`buffer` and
// `bufferBytes`, `page` and `pageBytes`), so that the relations' errors say
// `buffer` and `page`, as the page does. The row `reads` is two fields too:
// `reads`, the places, and `readsWait`, the longest wait for one (lead,
// ec-jyjxm); no relation uses it. Each time is in milliseconds.
//
// | Field | Default | Unit | The page's row |
// | --- | --- | --- | --- |
// | `text` | 65,536 | bytes | `text`: a message's text |
// | `body` | 524,288 | bytes | `body`: a body of R1 or a socket's frame after `ready` |
// | `early` | 8,192 | bytes | a socket's frame before `ready` |
// | `key` | 128 | bytes | an `Idempotency-Key` |
// | `token` | 4,096 | bytes | a token: its size |
// | `life` | 3,600,000 | ms | a token: its life |
// | `chats` | 64 | chats | a token: its chats, 1 to this |
// | `said` | 30 | messages | messages in, for one chat: the count |
// | `saidWindow` | 60,000 | ms | messages in, for one chat: the window |
// | `newChats` | 10 | requests | R9, for the host: the count |
// | `newChatsWindow` | 60,000 | ms | R9, for the host: the window |
// | `newTokens` | 60 | requests | R10, for the host: the count |
// | `newTokensWindow` | 60,000 | ms | R10, for the host: the window |
// | `requests` | 256 | requests | HTTP requests in flight, for the host |
// | `waiting` | 256 | sockets | sockets that wait for their `auth`, for the host |
// | `bodyRead` | 10,000 | ms | the read of a body |
// | `lockWait` | 10,000 | ms | a message's wait for its channel's lock |
// | `hub` | 1,024 | entries | `hub`: the turn loop's hub of a loaded chat |
// | `buffer` | 4,096 | entries | `buffer`: a client's buffer, in entries |
// | `bufferBytes` | 8,388,608 | bytes | `buffer`: a client's buffer, in bytes of JSON |
// | `entry` | 1,048,576 | bytes | `entry`: the JSON of one event or one piece |
// | `page` | 1,000 | events | `page`: a page of a read from the store, in events |
// | `pageBytes` | 2,097,152 | bytes | `page`: a page of a read, in bytes of JSON |
// | `room` | 30,000 | ms | room for a page in a first read's client's buffer |
// | `reads` | 16 | reads | `reads`: first reads and reads of R5 at one time |
// | `readsWait` | 30,000 | ms | `reads`: the longest wait for a place |
// | `request` | 30,000 | ms | `request`: the whole life of a request that holds a place |
// | `lock` | 20,000 | ms | `lock`: the work under a channel's lock |
// | `store` | 5,000 | ms | `store`: one call of the store |
// | `idle` | 190,000 | ms | `idle`: Bun's idle limit of HTTP |
// | `socketIdle` | 120,000 | ms | the WebSocket's idle limit |
// | `chatClients` | 32 | clients | clients of one chat |
// | `hostClients` | 4,096 | clients | clients of the host |
// | `loaded` | 200 | chats | loaded chats |
// | `wait` | 25,000 | ms | `wait`: R5's largest `wait` |
// | `events` | 1,000 | events | R5's `limit` |
// | `history` | 200 | messages | R2's `last` and R3's `to - from` |
// | `auth` | 5,000 | ms | the socket's `auth` |
// | `ping` | 15,000 | ms | `ping`: an idle stream or socket |
// | `unload` | 360,000 | ms | an idle loaded chat |
//
// Two rows of the table hold no number of the host, so they have no field:
// the connections that Bun holds with no request (the deployment's bound),
// and an event's whole text past `entry` (no route gives it).
//
// Each field that the caller gives is read one time and never clamped: a
// whole number from 1 to 2**31 - 1 (`hub`: to 65,536, since the turn loop's
// hub allocates its whole capacity when it is made; `key`: to 128, the
// core's bound of a sender's key, `SENDER_KEY` in packages/core/src/store.ts,
// since a longer key would pass the host's check and the core would refuse
// it in the store, which unloads the chat and stops a turn that runs), else
// `LimitsRefused`.
// So is a name that is no limit, also in an object that the type check did
// not see. Then the relations of P3, in the page's order; the first that
// fails is the error.

import { Effect, Schema } from "effect"

export interface Limits {
  readonly text: number
  readonly body: number
  readonly early: number
  readonly key: number
  readonly token: number
  readonly life: number
  readonly chats: number
  readonly said: number
  readonly saidWindow: number
  readonly newChats: number
  readonly newChatsWindow: number
  readonly newTokens: number
  readonly newTokensWindow: number
  readonly requests: number
  readonly waiting: number
  readonly bodyRead: number
  readonly lockWait: number
  readonly hub: number
  readonly buffer: number
  readonly bufferBytes: number
  readonly entry: number
  readonly page: number
  readonly pageBytes: number
  readonly room: number
  readonly reads: number
  readonly readsWait: number
  readonly request: number
  readonly lock: number
  readonly store: number
  readonly idle: number
  readonly socketIdle: number
  readonly chatClients: number
  readonly hostClients: number
  readonly loaded: number
  readonly wait: number
  readonly events: number
  readonly history: number
  readonly auth: number
  readonly ping: number
  readonly unload: number
}

export const DEFAULTS: Limits = {
  text: 65_536,
  body: 512 * 1024,
  early: 8 * 1024,
  key: 128,
  token: 4_096,
  life: 3_600_000,
  chats: 64,
  said: 30,
  saidWindow: 60_000,
  newChats: 10,
  newChatsWindow: 60_000,
  newTokens: 60,
  newTokensWindow: 60_000,
  requests: 256,
  waiting: 256,
  bodyRead: 10_000,
  lockWait: 10_000,
  hub: 1_024,
  buffer: 4_096,
  bufferBytes: 8 * 1024 * 1024,
  entry: 1024 * 1024,
  page: 1_000,
  pageBytes: 2 * 1024 * 1024,
  room: 30_000,
  reads: 16,
  readsWait: 30_000,
  request: 30_000,
  lock: 20_000,
  store: 5_000,
  idle: 190_000,
  socketIdle: 120_000,
  chatClients: 32,
  hostClients: 4_096,
  loaded: 200,
  wait: 25_000,
  events: 1_000,
  history: 200,
  auth: 5_000,
  ping: 15_000,
  unload: 360_000
}

export class LimitsRefused extends Schema.TaggedError<LimitsRefused>()("LimitsRefused", {
  limits: Schema.Array(Schema.String), // the names of the limits, as in the limits table
  rule: Schema.String // the relation, as the page writes it
}) {}

// The range of each field, and the hub's and the key's own.
const LARGEST = 2 ** 31 - 1
const HUB = 65_536
const KEY = 128

// The sums (P1)
// -------------

// The longest JSON of a whole number of the tree (`9007199254740991`).
export const N = 16
// One message of an event with an empty text, each number at `N`, its kind
// 4 bytes, `more` as `false`, and `line` as `null`.
export const F = 196
// The most characters of one page of a text (packages/core/src/pages.ts).
export const PAGE = 30_000
// The most characters of a turn's `why` (packages/core/src/turn.ts, `WHY`).
export const WHY = 2_000
// The most bytes of JSON of one byte of text: a control character, `\u0001`.
export const ESCAPE = 6

// The most pages of a text of `t` bytes: two pages in a row, but the last,
// hold at least PAGE characters, and a text of `t` bytes has at most `t`.
export const pages = (t: number): number => 2 * Math.floor((t - 1) / PAGE) + 2

// The most bytes of JSON of each event given whole.
export const accepted = (limits: Limits): number => 54 + pages(limits.text) * (F + 1) + ESCAPE * limits.text
export const message = (_limits: Limits): number => 50 + F + ESCAPE * PAGE
export const end = (_limits: Limits): number => 87 + ESCAPE * WHY
export const start = (_limits: Limits): number => 61

// The largest of the four: the least `entry` that gives each whole.
export const largest = (limits: Limits): number => Math.max(accepted(limits), message(limits), end(limits), start(limits))

// The relations (P3)
// ------------------

// Each row: the names that its error gives, the relation as the page writes
// it, and its test. Exported for the tests: the hub's row is never reached
// through `limits`, since the field's own range refuses a hub under 1 first.
export const RELATIONS: ReadonlyArray<{ readonly limits: ReadonlyArray<string>; readonly rule: string; readonly holds: (l: Limits) => boolean }> = [
  { limits: ["body", "text"], rule: "`body` ≥ `text` + 11", holds: (l) => l.body >= l.text + 11 },
  {
    limits: ["entry", "text"],
    rule: "`entry` ≥ the largest of `accepted`, `message`, `end` and `start`",
    holds: (l) => l.entry >= largest(l)
  },
  { limits: ["entry", "buffer"], rule: "`entry` ≤ `buffer` in bytes", holds: (l) => l.entry <= l.bufferBytes },
  { limits: ["page", "entry"], rule: "`page` ≥ `entry`", holds: (l) => l.pageBytes >= l.entry },
  {
    limits: ["page", "buffer"],
    rule: "`page` ≤ `buffer` in bytes, and `page` in events ≤ `buffer` in entries",
    holds: (l) => l.pageBytes <= l.bufferBytes && l.page <= l.buffer
  },
  {
    limits: ["idle", "wait", "request", "store", "ping"],
    rule: "`idle` ≥ 2 × (`wait` + 2 × (`request` + `store`)), and `idle` ≥ 2 × `ping`, and `idle` ≤ 255,000",
    holds: (l) => l.idle >= 2 * (l.wait + 2 * (l.request + l.store)) && l.idle >= 2 * l.ping && l.idle <= 255_000
  },
  {
    limits: ["socketIdle", "ping"],
    rule: "the WebSocket's idle limit (`socketIdle`) ≥ 2 × `ping`, and ≤ 960,000",
    holds: (l) => l.socketIdle >= 2 * l.ping && l.socketIdle <= 960_000
  },
  { limits: ["hub"], rule: "`hub` ≥ 1", holds: (l) => l.hub >= 1 }
]

// The limits in use: the defaults with the caller's over them, each field
// that it gives checked, then the relations.
export const limits = (given?: Partial<Limits>): Effect.Effect<Limits, LimitsRefused> =>
  Effect.suspend(() => {
    const used: Record<string, number> = { ...DEFAULTS }
    // Read each given field one time.
    for (const [name, value] of Object.entries((given ?? {}) as Record<string, unknown>)) {
      if (!Object.hasOwn(DEFAULTS, name)) {
        return Effect.fail(new LimitsRefused({ limits: [name], rule: "no such limit" }))
      }
      const most = name === "hub" ? HUB : name === "key" ? KEY : LARGEST
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > most) {
        return Effect.fail(new LimitsRefused({ limits: [name], rule: "a whole number from 1 to " + most }))
      }
      used[name] = value
    }
    const inUse = used as unknown as Limits
    for (const relation of RELATIONS) {
      if (!relation.holds(inUse)) {
        return Effect.fail(new LimitsRefused({ limits: [...relation.limits], rule: relation.rule }))
      }
    }
    return Effect.succeed(inUse)
  })
