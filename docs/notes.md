# Notes on the tools

This file holds facts about the tools that cost time to find. Each entry
gives the fact, what to do, and the file or command that shows it.

1. A connection that cannot write still makes the files `everchat.db-shm`
   and `everchat.db-wal` next to the database. Do not expect a home to
   stay as it was when only `Reads` or `everchat inspect` opened it. To see
   it: `just sample <home>` (no `-shm` or `-wal` after it), then
   `everchat inspect --port 0` on that home (both files are there).
2. Effect version 4 has no `Layer.mapError` and no `Layer.fail`. Build the
   inner layer inside `Layer.effect` with `Layer.build`, and map its error
   there. See `src/store.ts:566` and `node_modules/effect/src/Layer.ts`.
3. Bun's types say that an import of an `.html` file is a bundle
   (`node_modules/bun-types/extensions.d.ts:41`). With `type: "text"` the
   value is the file's text, so cast it to `string`. See
   `src/inspector.ts:37`.
4. `happy-dom` has no layout and no content security policy: a size is 0,
   and an inline script runs under a policy of `script-src 'none'`, in a
   `<meta>` or in a header. The tests of the page (`tests/page.test.ts`)
   say nothing about how it looks; `src/inspector.test.ts` checks the
   policy.
5. `everchat inspect` runs until a signal ends it. A pipeline that reads
   its first line inside `$(...)`, as
   `url=$(everchat inspect --port 0 | head -n 1)`, waits for the inspector
   and does not return. Send the output to a file, and read the file.
6. `pkill -f` and `pgrep -f` match each process whose command line holds
   the pattern, and your own shell is one of them: a `pkill -f` can stop
   the shell that runs it. Put the pattern in a script file, or write it
   as `[i]nspect`, and keep the plain text out of the same command line.
