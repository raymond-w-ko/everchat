// Schema
// ======
// The tables of the local file, whole: one list of SQL statements, in order.
// `database.ts` runs them on an empty file, in one transaction, and then
// writes the mark VERSION (`pragma user_version`). There is no migration: a
// change of the schema is a new file, with a new mark, and a file of
// another mark is refused (docs/design.md, "The database"). They are code,
// so they are part of the executable.
//
// The statements are those of the block of docs/schema.html, section 8,
// each one as the page writes it and in its order: the schema for many
// chats, with keys (chat, n). The two pragmas at the head of that block are
// not statements of the schema: they hold for one connection, and
// `database.ts` sets them on the connection that writes.
//
// Every name that is unique in the database (a table, the view, an index, a
// trigger) has the prefix `everchat_`, written out in each statement: no
// function builds a name from a prefix.
//
// The design of the tables, with the reason for each, is docs/schema.html.
// Each statement is one entry, because the driver runs one statement at a
// time.

// The mark of this schema, the file's `pragma user_version`. A file that
// Effect's migrator made has none (0).
export const VERSION = 5

export const schema: ReadonlyArray<string> = [
  // Each tenant: its UUIDv4, from outside. The local file has one.
  `create table everchat_tenant (
       id      blob    not null primary key check (length(id) = 16),
       created integer not null
     ) strict`,
  `create trigger everchat_tenant_no_update before update on everchat_tenant
       begin select raise(abort, 'everchat_tenant is append only'); end`,

  // A model choice: a shared list. Other tables hold its number.
  `create table everchat_pick (
       id      integer primary key,
       vendor  text    not null,
       model   text    not null,
       effort  text    not null,
       speed   text    not null,
       created integer not null,
       unique (vendor, model, effort, speed)
     ) strict`,
  `create trigger everchat_pick_no_update before update on everchat_pick
       begin select raise(abort, 'everchat_pick is append only'); end`,
  `create trigger everchat_pick_no_delete before delete on everchat_pick
       begin select raise(abort, 'everchat_pick is append only'); end`,

  // The kinds of message: a shared list, the same as KINDS in the code.
  `create table everchat_kind (
       id   integer primary key,
       name text    not null unique
     ) strict`,
  `insert into everchat_kind (id, name) values (1, 'user'), (2, 'asst'), (3, 'tool'), (4, 'echo'), (5, 'work'), (6, 'note')`,
  `create trigger everchat_kind_no_update before update on everchat_kind
       begin select raise(abort, 'everchat_kind is append only'); end`,
  `create trigger everchat_kind_no_delete before delete on everchat_kind
       begin select raise(abort, 'everchat_kind is append only'); end`,

  // Each chat of a tenant. The database makes its id; the UUID is its id outside.
  `create table everchat_chat (
       id      integer primary key,
       tenant  blob    not null references everchat_tenant (id) on delete cascade,
       uuid    blob    not null unique check (length(uuid) = 16),
       pick    integer not null references everchat_pick (id),
       goal    text,
       draft   text,
       taken   integer not null default -1,
       seq     integer not null default 0,
       created integer not null,
       updated integer not null
     ) strict`,
  `create index everchat_chat_tenant on everchat_chat (tenant)`,
  `create trigger everchat_chat_no_delete before delete on everchat_chat when exists (select 1 from everchat_tenant where id = old.tenant)
       begin select raise(abort, 'everchat_chat is deleted only with its tenant'); end`,
  `create trigger everchat_chat_no_move before update of id, tenant, uuid on everchat_chat
       begin select raise(abort, 'everchat_chat keeps its id, its tenant and its uuid'); end`,
  // SQLite fires no trigger of `update of id` for an update of rowid, oid or _rowid_.
  `create trigger everchat_chat_no_rowid before update on everchat_chat when new.id is not old.id
       begin select raise(abort, 'everchat_chat keeps its id, its tenant and its uuid'); end`,

  // Each load of a chat. At most one live launch for each chat.
  `create table everchat_launch (
       chat    integer not null references everchat_chat (id) on delete cascade,
       n       integer not null,
       pid     integer not null,
       host    text    not null,
       cwd     text    not null,
       version text    not null,
       run_tag text    not null,
       pick    integer references everchat_pick (id),
       created integer not null,
       ended   integer,
       why     text,
       live    integer generated always as (case when ended is null then 1 end) virtual,
       primary key (chat, n)
     ) strict`,
  `create unique index everchat_launch_live on everchat_launch (chat, live)`,
  `create trigger everchat_launch_no_move before update of chat, n on everchat_launch
       begin select raise(abort, 'everchat_launch keeps its chat and its n'); end`,

  // Each system prompt and tool list sent, stored once for each chat.
  `create table everchat_head (
       chat    integer not null references everchat_chat (id) on delete cascade,
       n       integer not null,
       hash    text    not null,
       body    text    not null,
       created integer not null,
       primary key (chat, n),
       unique (chat, hash)
     ) strict`,
  `create trigger everchat_head_no_update before update on everchat_head
       begin select raise(abort, 'everchat_head is append only'); end`,

  // Each turn of the chat.
  `create table everchat_turn (
       chat      integer not null references everchat_chat (id) on delete cascade,
       n         integer not null,
       agent     integer,
       status    text    not null check (status in ('running', 'done', 'stopped', 'failed')),
       pick      integer not null references everchat_pick (id),
       head      integer not null,
       first_msg integer not null,
       launch    integer not null,
       created   integer not null,
       ended     integer,
       why       text,
       check ((status = 'running') = (ended is null)),
       primary key (chat, n),
       foreign key (chat, head) references everchat_head (chat, n) on delete cascade,
       foreign key (chat, launch) references everchat_launch (chat, n) on delete cascade
     ) strict`,
  `create index everchat_turn_running on everchat_turn (chat, status)`,
  `create trigger everchat_turn_no_move before update of chat, n on everchat_turn
       begin select raise(abort, 'everchat_turn keeps its chat and its n'); end`,

  // A turn's request, step by step, as sent to the vendor.
  `create table everchat_turn_item (
       chat    integer not null references everchat_chat (id) on delete cascade,
       turn    integer not null,
       n       integer not null,
       kind    text    not null check (kind in ('user', 'turn', 'back')),
       body    text    not null,
       created integer not null,
       primary key (chat, turn, n),
       foreign key (chat, turn) references everchat_turn (chat, n) on delete cascade
     ) strict`,
  `create trigger everchat_turn_item_no_update before update on everchat_turn_item
       begin select raise(abort, 'everchat_turn_item is append only'); end`,

  // Each program the model runs, and each function that program calls.
  `create table everchat_call (
       chat      integer not null references everchat_chat (id) on delete cascade,
       n         integer not null,
       turn      integer not null,
       parent    integer,
       vendor_id text,
       fn        text    not null,
       input     text    not null,
       output    text,
       size      integer,
       shown     integer,
       status    text    not null check (status in ('running', 'done', 'failed', 'denied', 'cut')),
       pgid      integer,
       launch    integer not null,
       created   integer not null,
       ended     integer,
       check ((parent is null) = (vendor_id is not null)),
       check ((status = 'running') = (ended is null)),
       primary key (chat, n),
       foreign key (chat, turn) references everchat_turn (chat, n) on delete cascade,
       foreign key (chat, parent) references everchat_call (chat, n) on delete cascade,
       foreign key (chat, launch) references everchat_launch (chat, n) on delete cascade
     ) strict`,
  `create unique index everchat_call_vendor on everchat_call (chat, turn, vendor_id)`,
  `create index everchat_call_parent on everchat_call (chat, parent)`,
  `create index everchat_call_running on everchat_call (chat, status)`,
  `create trigger everchat_call_no_move before update of chat, n on everchat_call
       begin select raise(abort, 'everchat_call keeps its chat and its n'); end`,

  // The log: every message of the chat, for ever.
  `create table everchat_msg (
       chat    integer not null references everchat_chat (id) on delete cascade,
       i       integer not null,
       kind    integer not null references everchat_kind (id),
       text    text    not null,
       size    integer not null,
       more    integer not null default 0 check (more in (0, 1)),
       line    text,
       turn    integer,
       call    integer,
       launch  integer not null,
       created integer not null,
       primary key (chat, i),
       foreign key (chat, turn) references everchat_turn (chat, n) on delete cascade,
       foreign key (chat, call) references everchat_call (chat, n) on delete cascade,
       foreign key (chat, launch) references everchat_launch (chat, n) on delete cascade
     ) strict`,
  `create trigger everchat_msg_no_update before update on everchat_msg
       begin select raise(abort, 'everchat_msg is append only'); end`,
  `create trigger everchat_msg_no_delete before delete on everchat_msg when exists (select 1 from everchat_chat where id = old.chat)
       begin select raise(abort, 'everchat_msg is append only'); end`,

  // Each image, as sent to the model.
  `create table everchat_image (
       chat    integer not null references everchat_chat (id) on delete cascade,
       n       integer not null,
       name    text    not null,
       type    text    not null,
       width   integer not null,
       height  integer not null,
       source  text    not null check (source in ('person', 'tool')),
       created integer not null,
       bytes   blob    not null,
       primary key (chat, n),
       unique (chat, name)
     ) strict`,
  `create trigger everchat_image_no_update before update on everchat_image
       begin select raise(abort, 'everchat_image is append only'); end`,

  // Which images a message carries, in order.
  `create table everchat_msg_image (
       chat  integer not null references everchat_chat (id) on delete cascade,
       msg   integer not null,
       n     integer not null,
       image integer not null,
       primary key (chat, msg, n),
       foreign key (chat, msg) references everchat_msg (chat, i) on delete cascade,
       foreign key (chat, image) references everchat_image (chat, n) on delete cascade
     ) strict, without rowid`,
  `create trigger everchat_msg_image_no_update before update on everchat_msg_image
       begin select raise(abort, 'everchat_msg_image is append only'); end`,
  `create trigger everchat_msg_image_no_delete before delete on everchat_msg_image when exists (select 1 from everchat_chat where id = old.chat)
       begin select raise(abort, 'everchat_msg_image is append only'); end`,

  // The tree of summaries. Node (l, i) covers the 2^l messages from i·2^l on.
  `create table everchat_node (
       chat    integer not null references everchat_chat (id) on delete cascade,
       l       integer not null check (l >= 0),
       i       integer not null check (i >= 0),
       text    text    not null,
       size    integer not null,
       created integer not null,
       primary key (chat, l, i)
     ) strict, without rowid`,
  `create trigger everchat_node_no_update before update on everchat_node
       begin select raise(abort, 'everchat_node is written once'); end`,
  `create trigger everchat_node_no_delete before delete on everchat_node when exists (select 1 from everchat_chat where id = old.chat)
       begin select raise(abort, 'everchat_node is written once'); end`,

  // The two views of a chat, byte for byte.
  `create table everchat_view (
       chat    integer not null references everchat_chat (id) on delete cascade,
       name    text    not null check (name in ('chat', 'seen')),
       parts   text    not null,
       batch   integer not null default 0 check (batch in (0, 1)),
       created integer not null,
       updated integer not null,
       primary key (chat, name)
     ) strict, without rowid`,
  `create trigger everchat_view_no_move before update of chat, name on everchat_view
       begin select raise(abort, 'everchat_view keeps its chat and its name'); end`,

  // What each request to a model used.
  `create table everchat_usage (
       chat        integer not null references everchat_chat (id) on delete cascade,
       n           integer not null,
       served      text    not null check (served in ('turn', 'compaction', 'goal')),
       turn        integer,
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
       expected    integer,
       primary key (chat, n),
       foreign key (chat, turn) references everchat_turn (chat, n) on delete cascade
     ) strict`,
  `create trigger everchat_usage_no_update before update on everchat_usage
       begin select raise(abort, 'everchat_usage is append only'); end`,

  // Diagnostics, instead of stderr.
  `create table everchat_log (
       chat    integer not null references everchat_chat (id) on delete cascade,
       n       integer not null,
       level   text    not null check (level in ('debug', 'info', 'warn', 'error')),
       source  text    not null,
       text    text    not null,
       launch  integer not null,
       created integer not null,
       primary key (chat, n),
       foreign key (chat, launch) references everchat_launch (chat, n) on delete cascade
     ) strict`,
  `create trigger everchat_log_no_update before update on everchat_log
       begin select raise(abort, 'everchat_log is append only'); end`,

  // Each event but a piece, numbered in its chat: n is the chat's seq plus 1.
  `create table everchat_event (
       chat     integer not null references everchat_chat (id) on delete cascade,
       n        integer not null,
       type     text    not null check (type in ('accepted', 'start', 'call', 'message', 'end')),
       turn     integer,
       call     integer,
       msg      integer,
       msg_last integer,
       created  integer not null,
       check ((msg is null) = (msg_last is null)),
       check (msg_last >= msg),
       primary key (chat, n),
       foreign key (chat, turn) references everchat_turn (chat, n) on delete cascade,
       foreign key (chat, call) references everchat_call (chat, n) on delete cascade,
       foreign key (chat, msg) references everchat_msg (chat, i) on delete cascade,
       foreign key (chat, msg_last) references everchat_msg (chat, i) on delete cascade
     ) strict`,
  `create trigger everchat_event_no_update before update on everchat_event
       begin select raise(abort, 'everchat_event is append only'); end`,
  `create trigger everchat_event_no_delete before delete on everchat_event when exists (select 1 from everchat_chat where id = old.chat)
       begin select raise(abort, 'everchat_event is append only'); end`,

  // For people: the log with kinds as words and times as text. A reader names the chat.
  `create view everchat_msg_read as
     select m.chat, m.i, k.name as kind, datetime(m.created / 1000, 'unixepoch') as at,
            m.turn, m.call, m.size, m.text
     from everchat_msg m join everchat_kind k on k.id = m.kind`
]
