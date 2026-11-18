`packages/core/` (`@everchat/core`): the core.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/core/` (`@everchat/core`): the core. Its modules, flat, are in
  `packages/core/src/`: the memory, the turn loop, requests, the cache, the
  head and the prompt, the cap of a result, and the tags of the seams (the
  store, the sandbox, the functions). It has no runtime API (see
  "The boundaries of the core" below). `packages/core/tsconfig.core.d.ts`
  declares, for the core's own type check only, what it may use beyond
  `ESNext`. Its entries: `.` (the turn loop) and one for each module that
  another package imports.
- A test goes with the code that it tests, so
  four tests named after a module of the core are in other packages:
  `sandbox.test.ts` in `codemode` (the engine of `thread.ts`),
  `store.test.ts` in `sqlite` (the store in `sqlite.ts`), and in `local`
  `functions.test.ts` (the local functions; the core's functions and the
  hosted set are tested in the core's own `functions.test.ts`) and
  `limit.test.ts` (most of it the files of `limitfile.ts`). The tests of the
  core reach the SQLite store and the shared test code by the names of their
  packages, as development dependencies of the core (`@everchat/sqlite/bun`,
  `@everchat/local/testing`).

## Code mode is the only primary tool

How it is built (`packages/core/src/sandbox.ts`,
`packages/codemode/src/thread.ts`, `packages/core/src/functions.ts`,
`packages/local/src/localfunctions.ts`):

- The tool's description lists the functions as TypeScript declarations
  (`packages/core/src/head.ts`), in the order of `DECLARATIONS` in
  `packages/local/src/localfunctions.ts`. That order is part of the prompt
  cache's key. To add a function that needs only the memory and the store, add
  its declaration, its arguments' schema, and its code to `core` in
  `packages/core/src/functions.ts`. To add a local one (the shell, the files,
  the work directory), add them in `packages/local/src/localfunctions.ts`.
  Either way, give it its place in `DECLARATIONS`, and add a test. A function
  that a host's chat has (one that needs only the memory and the store) also
  gets its place in `HOSTED` in `packages/core/src/functions.ts`:
  `hostedLayer` builds the functions of a host's chat from it, in its order,
  and that order is part of the prompt cache's key of a host's chat.

## One system prompt for every kind of request

The chat's turns, its compactions, and its subagents all send the same system
prompt and the same tool list. The system prompt names each kind of request
and holds its rules. A block after the view says which kind this request is
(for example, one that starts `Subagent task:`). Each stack makes the head
one time, at the load, from its list of functions (`head` in
`packages/core/src/head.ts`), and gives that one value to the turn loop and to
the compactor: the option `head` of `Turns.layer` and of `Compactor.layer`.

The reason is the prompt cache: a request can read another request's cache
only when both start with the same bytes. With one prompt, a subagent reads
the view that the chat already sent, and does not pay for it again.

Two rules follow:

- Do not give a role its own system prompt. Add a section to the shared one.
- The prompt does not enforce what a role may do. The code does: a function
  that a subagent may not use returns an error.

The person sets two fields of the prompt, and nothing more. The fixed text
(`PROMPT` in `packages/core/src/prompt.ts`) cannot be replaced: no file and
no option does it.

- The name: `head(declarations, rules, name)` puts it in place of each
  "EverChat" of the fixed text (16 places, `named` of `prompt.ts`), and
  nowhere else. A name is 1 to 64 characters: letters and digits (`\p{L}`,
  `\p{N}`), and between two of them one space, `.`, `_` or `-`; so it starts
  and ends with a letter or a digit, and has no line end and no control
  character. `nameFault` says why a name is refused; `named` and `head`
  throw for one (a defect of the host). `named(NAME)` is `PROMPT`.
- The rules: the person's own instructions, appended at the end under
  "# The user's instructions". A blank text is none.

With neither field the head keeps the bytes of a head with none (the hash
case of `compactor.test.ts`). A host gives both at the load, so a change
applies at the next load.

A computer task is the exception. It has no view and another tool, so it
keeps its own prompt.

## The memory

Keep what is EverChat's own idea: the memory (the log, the tree of summaries,
and the view that each request shows the model), and the prompt-cache rule in
`ref/src/askai.ts`.
When a library replaces code that these depend on, make sure the behavior
stays the same, and test it.

The close of the turn loop's layer (`Turns.layer`) first cuts the turn that
runs and the memory's compactions at one time (`Memory.cut`): no compaction
starts from then on, and a compaction's write that waits for the memory's
lock is cut as the close begins, not after the turn's call in flight. A
write that holds the lock ends first. A node whose compaction was cut stays
not built, and the next launch's load asks for it again.

## A message from outside a turn: the source

The turn loop (`packages/core/src/turn.ts`) has one way in besides the
person's message: a source (`Source`, a seam), whose message starts a turn
of its own and never steers a turn that runs. Its first user is the result
of a call that ran after a person's yes (the kind `late`); the wake-ups
will be the second. The core knows only a kind, a text and a write: no
timer, no table and no approval.

- The shape: `Source { next }` gives an `Offer { kind, text, write }` or
  null. The kind is a key of `HEADS` but `user` and `work` (today `late`
  alone); another is a defect. A host with more than one source gives one
  `Source` that asks them in its own order. The source decides before
  `next` returns; its `write` only marks its own row.
- Who asks, and when: the loop, under its lock, at two places. At a
  turn's end, done or failed, when no message of the person waits (a
  message that waits starts its turn first, or waits for the person after
  a failure); and in `Turns.ready`, which the source's owner calls when it
  has something: with no turn running the offer starts its turn at once;
  while one runs it does nothing, and that turn's end asks. Not after a
  stop: the offer waits for the next end or the next `ready`.
- One transaction holds the offer's message (its pages and their `message`
  events), the new turn and its `start`, and the source's `write` with the
  message's first page and that turn. A failed write fails it all, and
  stops the memory for the launch, as every failed write does.
- The turn's first item takes the messages after `taken` of the kinds of
  `HEADS` (`user`, `work`, `late`), in one block under the header of the
  kind of the turn's first message (`HEAD`, `LATE`); a message of another
  kind is given as `<kind>: <text>`. A turn that the person's message
  starts is as before, byte for byte. Only `user` and `work` steer a turn.
- What a chat with no source pays: one `Effect.serviceOption` at the
  layer's build (`Turns.layer` needs nothing more), and one test at each
  turn's end; `ready` does nothing.

Two notes that approval needs, both written by the turn loop, which alone
writes a message with its event:

- After each program, in the transaction that logs its `tool` and `echo`
  and after them: one `note` for each call of it that waits for a person's
  yes or no (`store.approvalsOf(<the program's call>)`, in the order of the
  approvals' numbers). The text is `waits(approval)` (`functions.ts`, beside
  `pending`): `Approval <n> waits for a person's yes or no: <fn>(<input>).
  The call did not run.`, the input with no outer brackets, cut at 500
  characters with `…` and never inside a pair. A program with no such call
  logs what it logged before, with one more read. The notes do not steer
  the turn: its next request is as for any program, and a later turn reads
  them in its view.
- `Turns.note(text, write?)`: a note from outside a turn (a no, an
  expiry), logged with its `message` event under the loop's lock, whether a
  turn runs or not; it gives the note's first page. `write`, if given, runs
  with that first page in the note's one transaction, after its pages and
  their events, as a source's `write` runs in an offer's: a `write` that
  fails fails it all, with no page and no event of the note written (and
  the memory stops for the launch, as after every failed write). It starts
  no turn and steers none. Not from inside the loop's lock (a source's
  `write`): it would wait for itself.

## Approval

A function may need a person's yes before each run. The whole path:

- The flag: `Entry.approval` (`functions.ts`); `Functions.approval` holds
  the names. It is not in the declaration, so the head's bytes do not
  change with a setting.
- The gate, in the sandbox's calls (`packages/codemode/src/calls.ts`,
  `invoke`): a program's call of a gated function does not run. Its row is
  written, and `store.pendCall` makes, in one transaction, the approval's
  row from the call's own row (its turn, `fn` and `input`) and ends the
  call `pending`, with `pending(n)` as what the program got. The turn loop
  logs the note `waits(approval)` after the program (above).
- The row (`Approval`, `store.ts`; the table `everchat_approval`), kept for
  ever: `pending`, then `yes`, `no` or `expired`; `yes` to `running`;
  `running` to `done`, `failed` or `cut`. The run is recorded on the
  approval's row only: the call's row stays `pending`, and `result(<call>)`
  reads the run's output from the approval (`functions.ts`, `read`); before
  the run's end, or after a no or an expiry, it is an error that says
  which. `msg` is the first page of the message that told the chat of the
  end, set one time.
- The service: `Approvals` (`packages/core/src/approval.ts`, the entry
  `./approval`). `waiting`: the `pending` rows. `answer(n, { yes, who,
  text? })`: the store's `answerApproval`; it returns when the answer is
  recorded (and a no's note is logged). `Approvals.layer` needs `Store`,
  `Functions` and `Turns`; `Approvals.source` is the turn loop's `Source`,
  over `Store` and `Limit`, given below `Turns.layer`.
- The run, after a yes: in one worker, a fiber of the layer's scope, one
  at a time for a chat, in the order of the answers as the store keeps
  them. A yes (and a load) only wakes the worker; at each wake, and after
  each run, it reads `approvals(["yes"])` and runs the row with the least
  `answered`, and of rows with one time the least number, until no `yes`
  row is left; a row that `startApproval` refuses is passed. A read that
  fails, or a start that fails, is a diagnostic, and the worker waits for
  its next wake (an answer, or the next load). `startApproval` makes the row
  `running` only from `yes`, so the recorded call runs at most one time,
  whatever comes between (two answers, a stop, a crash, a second launch).
  It calls `Functions.call(fn, JSON.parse(input), caller)` with the row's
  own `fn` and `input`, nothing that a program or a model gave later, and
  the caller of the recorded call (its turn, its program, its row). Then
  `endApproval`: `done` with the result's text (a `Shortened`: its
  `whole`), `failed` with the error's message (a defect as `calls.ts`
  words it), `cut` when the run is interrupted (the layer's scope ends:
  `CUT_RUN`). Then `Turns.ready`: a request, not a promise; an offer that
  it does not take stays untold in the store, and a later turn's end, a
  later `ready` or the next load takes it.
- The two messages. A run's end is a message of the kind `late`, from the
  source: `Approval <n>: <fn>(<input>) ran after a yes by <who>.`, then
  `Result:` and the output, or `It failed:` and the message, or the cut's
  sentence; an output over the limit is shown as every result is
  (`Limit.show`: its head, its tail and the line of `result(<call>)`). It
  waits until the chat is idle and starts a turn of its own; its `write`
  sets `msg` (`tellApproval`) in the transaction that logs it. A no and an
  expiry are a note (`Turns.note`), which starts no turn: `Approval <n>:
  <who> said no to <fn>(<input>).` with the person's words after it, if
  any, in quotes; `Approval <n> expired after 7 days with no answer:
  <fn>(<input>). The call did not run.` Its `write` is `tellApproval` with
  the note's first page, in the note's one transaction: a row is told
  exactly when its note is in the log, and a note that fails (a
  diagnostic) is given by the next load. The input is shown as `waits`
  shows it.
- The 7 days (`WAIT`) are checked at a load and at each answer: nothing
  waits in memory, so an unload, a crash or an upgrade loses no approval.
  An answer after them is `expired`, and is told as an expiry.
- A load (the build of `Approvals.layer`), in this order: `cutApprovals`
  (a run that an earlier launch left is `cut`, never run again); the
  expiries, each with its note; the worker is woken for the rows still
  `yes`; each `no` and `expired` row not told yet gets its note; then
  `Turns.ready`, for a run that ended and was not told.

## The boundaries of the core

- The core has no runtime API, with one exception: `createHash` from
  `node:crypto`, which runs the same on Bun, Node and `workerd` [Q45].
- The tests of the core use `node:test` and `node:assert`, so that they run
  on Bun and on Node: `test`, `beforeEach` and `afterEach` from `node:test`,
  each assertion from `node:assert/strict` (`import * as assert`), and a
  timeout as `test(name, { timeout: 60_000 }, fn)`. A helper module for the
  tests in `packages/core/src/` is not a test: it is in the core's own type
  check, which has no Node types, and under the list of built-ins of the
  core's files, so a helper that imports `node:test` or `node:assert` fails
  both checks; a helper that needs neither passes. A test of the core
  that imports `@everchat/sqlite` or `@everchat/local` (the SQLite store,
  the shared test code) reaches `bun:sqlite`, so it runs on Bun only for
  now.

## The port

- The kind of EverChat's own messages is `asst` (short for "assistant") in the
  new code. Upstream says `unii` and the old code says `ever`. Keep it at 4
  letters: the model reads each message as `<kind>: <text>`, and that whole
  line counts toward a node's 512 bytes. A longer word changes which messages
  need a compaction. When you port a test, change only this word.
- Port the memory algorithm (the tree, the views, the merge order, the
  retries, the cache marks), do not reinvent it. Its invariant tests and its
  golden test move with it. They show that the port did not change what the
  algorithm does.
