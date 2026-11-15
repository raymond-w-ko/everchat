// Schema
// ======
// The tables of the local file, whole: one list of SQL statements, in order.
// `database.ts` runs them on an empty file, in one transaction, and then
// writes the mark VERSION (`pragma user_version`). There is no migration: a
// change of the schema is a new file, with a new mark, and a file of
// another mark is refused (docs/design.md, "The database"). They are code,
// so they are part of the executable.
//
// Every name that is unique in the database (a table, the view, an index, a
// trigger) has the prefix `everchat_`, written out in each statement: no
// function builds a name from a prefix.
//
// The design of the tables, with the reason for each, is docs/schema.html.
// Each statement is one entry, because the driver runs one statement at a
// time.

import { KINDS } from "@everchat/core/store"

// The mark of this schema, the file's `pragma user_version`. A file that
// Effect's migrator made has none (0).
export const VERSION = 3

// A trigger that refuses a write of the table `table` (its whole name).
const refuse = (table: string, on: "update" | "delete", message: string) =>
  `create trigger ${table}_no_${on} before ${on} on ${table}
   begin select raise(abort, '${message}'); end`

export const schema: ReadonlyArray<string> = [
  // A model choice. Other tables hold its number.
  `create table everchat_pick (
     id      integer primary key,
     vendor  text    not null,
     model   text    not null,
     effort  text    not null,
     speed   text    not null,
     created integer not null,
     unique (vendor, model, effort, speed)
   ) strict`,

  // The chat itself. Exactly one row.
  `create table everchat_chat (
     id      integer primary key check (id = 1),
     uuid    text    not null,
     pick    integer not null references everchat_pick (id),
     goal    text,
     draft   text,
     taken   integer not null default -1,
     created integer not null,
     updated integer not null
   ) strict`,

  // Each start of the program. At most one row has no `ended`.
  `create table everchat_launch (
     id      integer primary key,
     pid     integer not null,
     host    text    not null,
     cwd     text    not null,
     version text    not null,
     run_tag text    not null,
     pick    integer references everchat_pick (id),
     created integer not null,
     ended   integer,
     why     text
   ) strict`,
  `create unique index everchat_launch_live on everchat_launch ((1)) where ended is null`,

  // The list of message kinds.
  `create table everchat_kind (
     id   integer primary key,
     name text    not null unique
   ) strict`,
  `insert into everchat_kind (id, name) values ${
    Object.entries(KINDS).map(([name, id]) => `(${id}, '${name}')`).join(", ")
  }`,

  // Each system prompt and tool list sent, stored once.
  `create table everchat_head (
     id      integer primary key,
     hash    text    not null unique,
     body    text    not null,
     created integer not null
   ) strict`,

  // Each subagent or computer task.
  `create table everchat_agent (
     id      integer primary key,
     name    text    not null unique,
     role    text    not null check (role in ('sub', 'hands')),
     effort  text,
     device  text,
     turn    integer references everchat_turn (id),
     task    integer,
     taken   integer not null default -1,
     stop    integer not null default 0 check (stop in (0, 1)),
     view    text,
     created integer not null,
     updated integer not null,
     check ((role = 'hands') = (device is not null))
   ) strict`,

  // Each turn of the chat or of an agent.
  `create table everchat_turn (
     id        integer primary key,
     agent     integer references everchat_agent (id),
     status    text    not null check (status in ('running', 'done', 'stopped', 'failed')),
     pick      integer not null references everchat_pick (id),
     head      integer not null references everchat_head (id),
     first_msg integer not null,
     launch    integer not null references everchat_launch (id),
     created   integer not null,
     ended     integer,
     why       text,
     check ((status = 'running') = (ended is null))
   ) strict`,
  `create index everchat_turn_running on everchat_turn (status) where status = 'running'`,

  // A turn's request, step by step, as sent to the vendor.
  `create table everchat_turn_item (
     turn    integer not null references everchat_turn (id),
     n       integer not null,
     kind    text    not null check (kind in ('user', 'turn', 'back')),
     body    text    not null,
     created integer not null,
     primary key (turn, n)
   ) strict`,
  refuse("everchat_turn_item", "update", "turn_item is append only"),

  // Each program the model runs, and each function that program calls.
  `create table everchat_call (
     id        integer primary key,
     turn      integer not null references everchat_turn (id),
     parent    integer references everchat_call (id),
     vendor_id text,
     fn        text    not null,
     input     text    not null,
     output    text,
     size      integer,
     shown     integer,
     status    text    not null check (status in ('running', 'done', 'failed', 'denied', 'cut')),
     pgid      integer,
     launch    integer not null references everchat_launch (id),
     created   integer not null,
     ended     integer,
     check ((parent is null) = (vendor_id is not null)),
     check ((status = 'running') = (ended is null))
   ) strict`,
  `create unique index everchat_call_vendor on everchat_call (turn, vendor_id) where vendor_id is not null`,
  `create index everchat_call_parent on everchat_call (parent) where parent is not null`,
  `create index everchat_call_running on everchat_call (status) where status = 'running'`,

  // The log: every message of the chat, for ever.
  `create table everchat_msg (
     i       integer primary key,
     kind    integer not null references everchat_kind (id),
     text    text    not null,
     size    integer not null,
     more    integer not null default 0 check (more in (0, 1)),
     line    text,
     turn    integer references everchat_turn (id),
     call    integer references everchat_call (id),
     launch  integer not null references everchat_launch (id),
     created integer not null
   ) strict`,
  refuse("everchat_msg", "update", "msg is append only"),
  refuse("everchat_msg", "delete", "msg is append only"),

  // Each image, as sent to the model.
  `create table everchat_image (
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
  `create table everchat_image_original (
     image   integer primary key references everchat_image (id),
     type    text    not null,
     width   integer not null,
     height  integer not null,
     bytes   blob    not null
   ) strict`,

  // Which images a message carries, in order.
  `create table everchat_msg_image (
     msg   integer not null references everchat_msg (i),
     n     integer not null,
     image integer not null references everchat_image (id),
     primary key (msg, n)
   ) strict, without rowid`,

  // The tree of summaries. Node (l, i) covers the 2^l messages from i·2^l on.
  `create table everchat_node (
     l       integer not null check (l >= 0),
     i       integer not null check (i >= 0),
     text    text    not null,
     size    integer not null,
     created integer not null,
     primary key (l, i)
   ) strict, without rowid`,
  refuse("everchat_node", "update", "node is written once"),
  refuse("everchat_node", "delete", "node is written once"),

  // The two views, byte for byte.
  `create table everchat_view (
     name    text    primary key check (name in ('chat', 'seen')),
     parts   text    not null,
     batch   integer not null default 0 check (batch in (0, 1)),
     created integer not null,
     updated integer not null
   ) strict, without rowid`,

  // Each agent's own log. It has no tree.
  `create table everchat_agent_msg (
     agent   integer not null references everchat_agent (id),
     i       integer not null,
     kind    integer not null references everchat_kind (id),
     text    text    not null,
     size    integer not null,
     turn    integer references everchat_turn (id),
     call    integer references everchat_call (id),
     created integer not null,
     primary key (agent, i)
   ) strict`,
  refuse("everchat_agent_msg", "update", "agent_msg is append only"),
  refuse("everchat_agent_msg", "delete", "agent_msg is append only"),

  // What each request to a model used.
  `create table everchat_usage (
     id          integer primary key,
     served      text    not null check (served in ('turn', 'compaction', 'goal')),
     turn        integer references everchat_turn (id),
     node_l      integer,
     node_i      integer,
     pick        integer not null references everchat_pick (id),
     request     text,
     input       integer not null,
     cache_read  integer not null,
     cache_write integer not null,
     output      integer not null,
     searches    integer not null default 0,
     micros      integer,
     created     integer not null,
     -- What the request should have read from the prompt cache, in tokens,
     -- by our own count (cache.ts). Null: no watch judged it. A request
     -- with expected >= 2048 and cache_read = 0 missed the cache (a smaller
     -- part is not counted on: cache.ts, WORTH).
     expected    integer
   ) strict`,
  refuse("everchat_usage", "update", "usage is append only"),

  // Diagnostics, instead of stderr.
  `create table everchat_log (
     seq     integer primary key,
     level   text    not null check (level in ('debug', 'info', 'warn', 'error')),
     source  text    not null,
     text    text    not null,
     launch  integer not null references everchat_launch (id),
     created integer not null
   ) strict`,

  // For people: the log with kinds as words and times as text.
  `create view everchat_msg_read as
   select m.i, k.name as kind, datetime(m.created / 1000, 'unixepoch') as at,
          m.turn, m.call, m.size, m.text
   from everchat_msg m join everchat_kind k on k.id = m.kind`
]
