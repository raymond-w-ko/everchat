// The schema of a test
// ====================
// The one way in which a test of the package gets a schema of the store on
// MariaDB: from the repository's files (`schema/mariadb/`, the package's
// `AGENTS.md`, "The schema's files"), read by their path from the root, as
// the tests of `local` reach `tools/mcpexample.ts`. No module of the package
// reads them: `../src/tables.ts` holds only their names.
//
// - `texts()`: the text of each table's file, by the table's name, in the
//   order of `TABLES`.
// - `seed()`: the text of the administrator's statements that give
//   `everchat_kind` its rows.
// - `make(server, name)`: makes the schema `name` on a server of `./server.ts`
//   (as its root, by its `query`), runs each table's file in the order of
//   `TABLES` with the server's check of references on
//   (`foreign_key_checks = 1`), then the seed. A schema's name in a test is
//   a stand-in (`acme_dev`, `acme_qa`) or a random name of the test.

import fs from "node:fs"
import path from "node:path"
import { type Table, TABLES } from "../src/tables.ts"
import type { Server } from "./server.ts"

// The directory of the schema's files, and the seed, from the root of the
// repository.
export const SCHEMA_DIR = path.join(import.meta.dir, "../../../schema/mariadb/everchat")
export const SEED = path.join(import.meta.dir, "../../../schema/mariadb-admin/seed.sql")

// The text of each table's file, by its name, in the order of `TABLES`.
export const texts = (): Readonly<Record<Table, string>> =>
  Object.fromEntries(TABLES.map((table) => [table, fs.readFileSync(path.join(SCHEMA_DIR, table + ".sql"), "utf8")])) as Record<Table, string>

// The seed's text.
export const seed = (): string => fs.readFileSync(SEED, "utf8")

// A schema's name that a statement may hold with no quoting of its own.
const NAME = /^[a-z][a-z0-9_]{0,63}$/

// Makes the schema `name` on `server`, with each table of `TABLES` from its
// file, then the seed's rows. It fails with the server's error and the
// table's name; what it made before stays (a test's server is its own).
export const make = async (server: Server, name: string): Promise<void> => {
  if (!NAME.test(name)) throw new Error(`${JSON.stringify(name)} is no schema's name for a test: a lowercase letter, then lowercase letters, digits or _, 64 at most.`)
  await server.query(`create database \`${name}\` default character set utf8mb4 collate utf8mb4_nopad_bin`)
  const files = texts()
  for (const table of TABLES) {
    try {
      await server.query(`use \`${name}\`; set foreign_key_checks = 1; ${files[table]}`)
    } catch (cause) {
      throw new Error(`The file of ${table} failed in the schema ${name}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  await server.query(`use \`${name}\`; ${seed()}`)
}
