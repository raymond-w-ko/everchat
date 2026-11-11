// Migrations
// ==========
// Each change of the database's tables is a migration: a number, a name, and
// a list of SQL statements. `database.ts` runs the ones that a database has
// not run yet, in order, in one transaction. They are code, so they are part
// of the executable.
//
// Never change a migration that a database may have run. Add a new one.
//
// The design of the tables, with the reason for each, is docs/schema.html.
// Each statement is one entry, because the driver runs one statement at a
// time.

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The kinds of message. The model reads each message as `<kind>: <text>`.
// The ids are the ones in the table `kind`. Never change or reuse an id.
export const KINDS = {
  user: 1, // the person
  asst: 2, // EverChat
  tool: 3, // a program that the model ran
  echo: 4, // that program's result
  work: 5, // an agent's report
  note: 6 // the program itself
} as const

const refuse = (table: string, on: "update" | "delete", message: string) =>
  `create trigger ${table}_no_${on} before ${on} on ${table}
   begin select raise(abort, '${message}'); end`

const schema: ReadonlyArray<string> = [
  // A model choice. Other tables hold its number.
  `create table pick (
     id      integer primary key,
     vendor  text    not null,
     model   text    not null,
     effort  text    not null,
     speed   text    not null,
     created integer not null,
     unique (vendor, model, effort, speed)
   ) strict`,

  // The chat itself. Exactly one row.
  `create table chat (
     id      integer primary key check (id = 1),
     uuid    text    not null,
     pick    integer not null references pick (id),
     goal    text,
     draft   text,
     taken   integer not null default -1,
     created integer not null,
     updated integer not null
   ) strict`,

  // Each start of the program. At most one row has no `ended`.
  `create table launch (
     id      integer primary key,
     pid     integer not null,
     host    text    not null,
     cwd     text    not null,
     version text    not null,
     run_tag text    not null,
     pick    integer references pick (id),
     created integer not null,
     ended   integer,
     why     text
   ) strict`,
  `create unique index launch_live on launch ((1)) where ended is null`,

  // The list of message kinds.
  `create table kind (
     id   integer primary key,
     name text    not null unique
   ) strict`,
  `insert into kind (id, name) values ${
    Object.entries(KINDS).map(([name, id]) => `(${id}, '${name}')`).join(", ")
  }`,

  // Each system prompt and tool list sent, stored once.
  `create table head (
     id      integer primary key,
     hash    text    not null unique,
     body    text    not null,
     created integer not null
   ) strict`,

  // Each subagent or computer task.
  `create table agent (
     id      integer primary key,
     name    text    not null unique,
     role    text    not null check (role in ('sub', 'hands')),
     effort  text,
     device  text,
     turn    integer references turn (id),
     task    integer,
     taken   integer not null default -1,
     stop    integer not null default 0 check (stop in (0, 1)),
     view    text,
     created integer not null,
     updated integer not null,
     check ((role = 'hands') = (device is not null))
   ) strict`,

  // Each turn of the chat or of an agent.
  `create table turn (
     id        integer primary key,
     agent     integer references agent (id),
     status    text    not null check (status in ('running', 'done', 'stopped', 'failed')),
     pick      integer not null references pick (id),
     head      integer not null references head (id),
     first_msg integer not null,
     launch    integer not null references launch (id),
     created   integer not null,
     ended     integer,
     why       text,
     check ((status = 'running') = (ended is null))
   ) strict`,
  `create index turn_running on turn (status) where status = 'running'`,

  // A turn's request, step by step, as sent to the vendor.
  `create table turn_item (
     turn    integer not null references turn (id),
     n       integer not null,
     kind    text    not null check (kind in ('user', 'turn', 'back')),
     body    text    not null,
     created integer not null,
     primary key (turn, n)
   ) strict`,
  refuse("turn_item", "update", "turn_item is append only"),

  // Each program the model runs, and each function that program calls.
  `create table call (
     id        integer primary key,
     turn      integer not null references turn (id),
     parent    integer references call (id),
     vendor_id text,
     fn        text    not null,
     input     text    not null,
     output    text,
     size      integer,
     shown     integer,
     status    text    not null check (status in ('running', 'done', 'failed', 'denied', 'cut')),
     pgid      integer,
     launch    integer not null references launch (id),
     created   integer not null,
     ended     integer,
     check ((parent is null) = (vendor_id is not null)),
     check ((status = 'running') = (ended is null))
   ) strict`,
  `create unique index call_vendor on call (turn, vendor_id) where vendor_id is not null`,
  `create index call_parent on call (parent) where parent is not null`,
  `create index call_running on call (status) where status = 'running'`,

  // The log: every message of the chat, for ever.
  `create table msg (
     i       integer primary key,
     kind    integer not null references kind (id),
     text    text    not null,
     size    integer not null,
     more    integer not null default 0 check (more in (0, 1)),
     line    text,
     turn    integer references turn (id),
     call    integer references call (id),
     launch  integer not null references launch (id),
     created integer not null
   ) strict`,
  refuse("msg", "update", "msg is append only"),
  refuse("msg", "delete", "msg is append only"),

  // Each image, as sent to the model.
  `create table image (
     id      integer primary key,
     name    text    not null unique,
     type    text    not null,
     width   integer not null,
     height  integer not null,
     source  text    not null check (source in ('person', 'tool')),
     created integer not null,
     bytes   blob    not null
   ) strict`,

  // The original of an image, when it is not what was sent.
  `create table image_original (
     image   integer primary key references image (id),
     type    text    not null,
     width   integer not null,
     height  integer not null,
     bytes   blob    not null
   ) strict`,

  // Which images a message carries, in order.
  `create table msg_image (
     msg   integer not null references msg (i),
     n     integer not null,
     image integer not null references image (id),
     primary key (msg, n)
   ) strict, without rowid`,

  // The tree of summaries. Node (l, i) covers the 2^l messages from i·2^l on.
  `create table node (
     l       integer not null check (l >= 0),
     i       integer not null check (i >= 0),
     text    text    not null,
     size    integer not null,
     created integer not null,
     primary key (l, i)
   ) strict, without rowid`,
  refuse("node", "update", "node is written once"),
  refuse("node", "delete", "node is written once"),

  // The two views, byte for byte.
  `create table view (
     name    text    primary key check (name in ('chat', 'seen')),
     parts   text    not null,
     batch   integer not null default 0 check (batch in (0, 1)),
     created integer not null,
     updated integer not null
   ) strict, without rowid`,

  // Each agent's own log. It has no tree.
  `create table agent_msg (
     agent   integer not null references agent (id),
     i       integer not null,
     kind    integer not null references kind (id),
     text    text    not null,
     size    integer not null,
     turn    integer references turn (id),
     call    integer references call (id),
     created integer not null,
     primary key (agent, i)
   ) strict`,
  refuse("agent_msg", "update", "agent_msg is append only"),
  refuse("agent_msg", "delete", "agent_msg is append only"),

  // What each request to a model used.
  `create table usage (
     id          integer primary key,
     served      text    not null check (served in ('turn', 'compaction', 'goal')),
     turn        integer references turn (id),
     node_l      integer,
     node_i      integer,
     pick        integer not null references pick (id),
     request     text,
     input       integer not null,
     cache_read  integer not null,
     cache_write integer not null,
     output      integer not null,
     searches    integer not null default 0,
     micros      integer,
     created     integer not null
   ) strict`,
  refuse("usage", "update", "usage is append only"),

  // Diagnostics, instead of stderr.
  `create table log (
     seq     integer primary key,
     level   text    not null check (level in ('debug', 'info', 'warn', 'error')),
     source  text    not null,
     text    text    not null,
     launch  integer not null references launch (id),
     created integer not null
   ) strict`,

  // For people: the log with kinds as words and times as text.
  `create view msg_read as
   select m.i, k.name as kind, datetime(m.created / 1000, 'unixepoch') as at,
          m.turn, m.call, m.size, m.text
   from msg m join kind k on k.id = m.kind`
]

const run = (statements: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) {
      yield* sql.unsafe(statement)
    }
  })

// What a request should have read from the prompt cache, in tokens, by our
// own count (cache.ts). Null: no watch judged it. A request with
// `expected >= 2048 and cache_read = 0` missed the cache (a smaller part is
// not counted on: cache.ts, WORTH).
const usageExpected: ReadonlyArray<string> = [
  `alter table usage add column expected integer`
]

export const migrations = {
  "0001_schema": run(schema),
  "0002_usage_expected": run(usageExpected)
}
