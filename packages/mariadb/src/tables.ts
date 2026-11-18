// The tables
// ==========
// The names of the 19 tables of the store on MariaDB, the schema at the
// mark 8 (docs/schema.html), as one constant list, `TABLES`: in the order
// of the `create table` statements of SQLite's schema
// (`@everchat/sqlite/schema`), which is an order in which each table's
// references are there before it. A schema is made in it, one table's file
// after another, with the server's check of references on.
//
// Each table's text is a file of the repository,
// `schema/mariadb/everchat/<name>.sql`, in `skeema`'s layout: the server's
// `show create table` text, which an administrator applies (the package's
// `AGENTS.md`, "The schema's files").
//
// What it is not: this module holds no text of a file and imports no file
// of `schema/`. A caller gives the texts, as a value: a test reads them by
// their path (`../tests/schema.ts`); how a compiled program holds them is a
// later plan's. It names no view, no trigger, and no table of the lease or
// of the deployment.

export const TABLES = [
  "everchat_tenant",
  "everchat_pick",
  "everchat_kind",
  "everchat_chat",
  "everchat_launch",
  "everchat_head",
  "everchat_turn",
  "everchat_turn_item",
  "everchat_call",
  "everchat_msg",
  "everchat_image",
  "everchat_msg_image",
  "everchat_node",
  "everchat_view",
  "everchat_usage",
  "everchat_log",
  "everchat_event",
  "everchat_approval",
  "everchat_wake"
] as const

// The name of one table of the store on MariaDB.
export type Table = (typeof TABLES)[number]
