`packages/sqlite/` (`@everchat/sqlite`): the store on SQLite, with Bun's driver.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/sqlite/` (`@everchat/sqlite`): the store on SQLite, with Bun's
  driver. Its entries: `./bun` (`packages/sqlite/src/sqlite.ts`, the
  store), `./database` (`packages/sqlite/src/database.ts`, it opens the
  file, makes the schema on an empty one, and refuses a file of another
  version), `./schema` (`packages/sqlite/src/schema.ts`, the schema whole:
  the tables in one list of statements, and its mark; no changes of the
  tables), and `./testing` (`packages/sqlite/tests/help.ts`, what the
  tests that need a real store share). It has no entry `.`.
- `packages/sqlite/tests/`: the tests of the store that need a second
  process. `packages/sqlite/tests/child.ts` is the program that such a
  test starts (`packages/sqlite/tests/crash.test.ts`).

## The chat's database

All state of a chat lives in its database (see "All state in the chat's
database" in the root `AGENTS.md`). This gives two things:

- Restart: when the process is interrupted, crashes, or restarts, it reads the
  database and continues from where it was. It loses at most the work that was
  in flight (for example, a request that had not finished), and it can see
  what that work was so that it can start it again.
- Backup and moving hosts: a local install is one to three files. These are
  one executable (`bun build --compile`), one SQLite database, and maybe one
  config file. On MariaDB, the product's backups of its schema include the
  chats [Q47].

The schema: `docs/schema.html`, and "All state in the chat's database" in
the root `AGENTS.md`.
