`packages/wakeups/` (`@everchat/wakeups`): the wake-ups by time, reminders and
routines (`docs/design.md`, "Wake-ups by time"). The root `AGENTS.md` holds
the rules for every file.

## Files and entries

- `packages/wakeups/` (`@everchat/wakeups`): a chat's wake-ups by time, an
  optional package of the local build (`docs/design.md`, "Packages": its
  runtime is "none"). Its entries:
- `./time` (`packages/wakeups/src/time.ts`): `zone`, `machineZone`,
  `parse`, their types (`When`, `Wall`) and errors (`ZoneError`,
  `WhenError`); and when a wake-up is due: `reminderAt`, `isPast`,
  `nextSlot`, `missedOf` (`Missed`), `slotText`, `lateText`, `missedText`,
  `HORIZON_YEARS`, `MISSED_MAX`, `WHEN_MAX`, `ZONE_MAX` (see "Time").
- `./source` (`packages/wakeups/src/source.ts`): `source`, the layer of the
  core's `Source` over `Store`; `next`, its ask over a store; `fireText`;
  the ceiling of a wake turn `WAKE_CEILING`; and the budget, `HOUR_FIRES`
  in `HOUR` and `DAY_FIRES` in `DAY` (see "The source").
- `./firer` (`packages/wakeups/src/firer.ts`): `firer`, the layer that
  forks the firer's one fiber and its listener over `Store` and `Turns`;
  `pendOf`, what a round writes for a due row; `endOf`, how the settle
  counts a wake turn's end; `stoppedText`, the note of a row stopped at two
  failures; and `SLEEP`, the longest sleep between two rounds (see "The
  firer").
- `./functions` (`packages/wakeups/src/functions.ts`): `declarations`, the
  three declarations `wake`, `wakes` and `unwake`, in that order, and
  `entries(store, options)`, their entries in the same order over the
  store's service (`Store["Service"]`) and `options.zone`, the config
  file's zone (`DateTime.TimeZone.Named`, or none); `ACTIVE_MAX`, the most
  active wake-ups of a chat (20); `SHOWN_MAX`, the most characters of the
  model's input that a refusal repeats; the types `Options` and `Listed`, a
  row as `wakes` gives it (see "The functions").
- `./commands` (`packages/wakeups/src/commands.ts`): `Wakeups`, the
  service of the person's command `/wakeups`, and its layer
  `Wakeups.layer` over `Store` and `Turns`; its types `Listing`, `Row`,
  `Stopped` and `Switched`; `rowOf`, a row of the store as `list` gives
  it; and its notes `stopText(id)`, `OFF_TEXT` and `ON_TEXT` (see "The
  command's service").
- The tests of one module sit next to it, in `packages/wakeups/src/`.

## What it is not

- No store of its own: the rows of the wake-ups are the store's, and their
  members the core's (`Store`); `source.ts` reads them through those
  members, and writes only `fireWake`, in the offer's transaction;
  `firer.ts` writes only `pendWake` and `settleWake` (alone, or as the
  `write` of the note of a stop at two failures), and starts no turn
  itself; `functions.ts` writes only `makeWake` and `stopWake`;
  `commands.ts` writes only `stopWake` and `setWakeups`, each as the
  `write` of a note.
- No config: `time.ts` reads no clock either; a caller gives the zone, the
  text and now. `source.ts` and `firer.ts` read now from `effect`'s
  `Clock`, and the firer sleeps on it.
- No part of the core: the core does not know this package, and a chat
  with no wake-up runs with no line of it. Only `packages/local` imports it.

## Its imports

The package's code imports `effect` and `@everchat/core`, and nothing
else: no store, no wire, no engine, nothing of the local build, of the
server or of `mcp`, and no module of Bun or of Node. Two checks hold it.
`tools/graph.ts`: the package's files (not its tests) may import no
built-in module, and must not reach `packages/local/`, `packages/openai/`,
`packages/sqlite/`, `packages/codemode/`, `packages/server/` or
`packages/mcp/`; and the rows of the core, sqlite, codemode, server and
mcp there forbid `packages/wakeups/`, so none of them reaches it. The type
program `packages/wakeups/tsconfig.json`: its files are checked with no
Bun and no Node types and a `lib` of `ESNext` only, with the core's file
of declarations, `packages/core/tsconfig.core.d.ts`. The list of built-ins
of `tools/graph.ts`, which gives the package's files none, is what refuses
each module of Bun or of Node there. Its tests may import any of them,
with the Bun types (`packages/wakeups/tsconfig.test.json`). The zones come
from ECMAScript's `Intl`, a global, through `effect`'s `DateTime`.

## Time

`time.ts` says each rule at its place; this is their summary. Its
functions are pure: no clock, no store, no config (`machineZone` reads the
machine's zone, and nothing more).

- **A zone** (`zone(name)`) is an IANA name in its form (letters, digits,
  `_`, `-`, `+`, parts joined by `/`, the first from a letter) that the
  engine knows (`DateTime.zoneMakeNamed`), named as the engine names it
  (`america/new_york` is `America/New_York`). An offset such as `+01:00`
  is refused, though `Intl` takes it: a routine follows its zone's changes
  of time. Any other text is a `ZoneError` that names it.
- **A routine** (`parse(when, zone)`) is the 5 fields of cron, read by
  `effect`'s `Cron` in the zone. It fires at most one time in an hour: its
  minute field is exactly one value (`0 * * * *`, `15 9 * * 1-5`; not
  `*/30 * * * *`, `0,30 9 * * *` or `* 9 * * *`). That floor is by the
  minute field of the zone's wall clock, not 60 minutes of real time: in
  `Australia/Lord_Howe`, whose clock moves 30 minutes, `0 * * * *` has two
  slots 30 minutes apart on 2026-10-04 (02:00, moved by the gap to 02:30,
  then 03:00: 15:30 and 16:00 UTC), one time in a year, which the budget
  of fires bounds. A seconds field (6 fields) is refused, though `Cron`
  takes it.
- **A reminder** is a local date and time with no offset and no zone, to
  the minute or the second (`2026-11-18T09:00`, `2026-11-18 09:00:30`),
  read on the zone's wall clock: a real date (no 29 February of a year
  that has none) and a time of a day. `parse` keeps its wall time's parts.
- A text that begins as a date is read as a reminder; any other as a
  routine. Each refusal is a `WhenError` whose message says what was wrong
  and gives one right example: the model reads it.
- **The bounds**: a `when` is at most `WHEN_MAX` (200) UTF-16 units and a
  zone's name at most `ZONE_MAX` (100), as they came (`.length`, spaces at
  the ends too). A longer one is refused first, before the trim, any
  regular expression, `Cron` or `Intl`, with a message that gives its
  length, the bound and the example (both, for a `when`) and no part of
  the text; the error's field holds its first units, with no pair of
  surrogates parted.
- **The escapes**: each part of a message that came from outside (the
  zone's name, the `when`, the minute field, `Cron`'s reason, a routine's
  text in `nextSlot`'s refusal) goes through the core's `visible`
  (`@everchat/core/functions`) between double quotes, never
  `JSON.stringify`: a control, a bidi or zero-width code point or a lone
  surrogate is shown as its escape (`\x1b`, `\u{202e}`); a `"` or a `\`
  stays. The fields of `ZoneError` and `WhenError` are not escaped.
- **When it is due**, each time in milliseconds, with now from the caller.
  A reminder's time (`reminderAt`) is its wall time in its zone: a time
  that the zone skips moves forward by the gap (02:30 on 2026-03-29 in
  `Europe/Berlin` is 03:30, `effect`'s `compatible`), and a repeated one is
  the earlier; the caller refuses one that `isPast` (before now). A
  routine's next slot (`nextSlot`) is the first after the time asked of
  the slots that a walk of `Cron.next` in its zone gives from a slot: the
  newest slot at or before that time (`Cron.prev`), then steps of
  `Cron.next`, 3 at most (with none before, `Cron.next` from the time
  itself). It must come in the `HORIZON_YEARS` (5) after the time asked,
  or the routine is refused with a `WhenError` (`0 0 30 2 *`, a date that
  never comes): the 5 years are the make's test only. Its slots follow
  `Cron`'s rule at a change: a skipped 02:30 fires at 03:30, from every
  time asked, a time inside the gap too (`Cron.next` from 03:10 on that
  day's clock alone gives the next day's 02:30), and a repeated one fires
  once.
- **Missed slots** (`missedOf(routine, due, now)`): for a `due` slot at or
  before now, the newest slot at or before now (the one fire), the count
  of the slots from `due` before it, and the next slot after now; nothing
  for a `due` after now. The slots are walked from `due`, one by one, never
  found from now's time: after a fire `due` is the next slot, so a clock
  set back gives nothing due, and no slot fires twice. The walk stops at
  `MISSED_MAX` (1,000), and the count then says "or more" (`more`;
  `missedText`: `1000 or more missed`), so a row that slept for years costs
  at most 1,000 steps of `Cron.next`, then one `Cron.prev` and one
  `Cron.next`. The walk has no horizon: a row was taken with its first
  slot, and its slots may be years apart (`0 0 29 2 *` has none in 2100),
  so the next slot is the first after now, however far, and none only when
  `Cron.next` finds no date. A test compares `missedOf` with a plain walk
  of `Cron.next` from `due` on seeded inputs.
- **The words of a fire**: `slotText` gives a slot on its zone's wall
  clock, `2026-11-16 09:00 Europe/Berlin` (a repeated time's two instants
  have one text); `lateText` how late, `3 min late`, `2 h late` (whole
  hours under two days), `4 d late`, and nothing under one minute.

## The source

`source.ts` (docs/wakeups.md, sections 5 and 6). The turn loop asks
`next` under its lock, with no turn running, and it decides in this
order:

- **Off**: the chat's `wakeups` is false: null. The rows are not read.
- **Nothing waits**: `pendingWake()` gives none: null. The store gives
  only a row whose last end is counted (`settled`), so the end of a wake
  turn is counted before its row fires again; the source does not test it.
- **The budget**: `fires(now - HOUR)` at `HOUR_FIRES` (6), or
  `fires(now - DAY)` at `DAY_FIRES` (24): null, and the fire waits. Both
  windows are counted back from now (a fire at `now - HOUR` still counts),
  never from the last fire; the firer asks again at each round.
- **The offer**: the kind `wake`, `fireText`, the ceiling `WAKE_CEILING`
  (20 steps, 2,000,000 tokens), and the `write`
  `fireWake(id, turn.id, read)`, with the `pending` and `missed` that this
  `next` read, never read again in the write: a newer slot that the firer
  wrote in between waits on with its own count. A row that changed since
  the read fails `fireWake` with a `StoreError`: the offer writes nothing,
  and the memory stops for the launch. The source does not catch it.

**The fire's text** (`fireText`): `[<id>] due <slot>[, <late>][, <missed>]:
<text>`, the slot on the row's wall clock (the core's `wallClock`: a zone
that the engine does not know reads as UTC, with no throw), `lateText` and
`missedText` each only when not zero; a count at `WAKE_MISSED_MAX` reads
`1000 or more missed`. One fire is one line: the row's text goes in through
the core's `visible`, so each line end and each hidden code point of it is
its escape (`\x0a`, `\u{2028}`), as in a note of an approval, and a text
with line ends never reads as a second fire. The row keeps its text exact;
a text with none of those code points is in the fire byte for byte, and
each of its characters is at most 8 there. The zone is `wallClock`'s, with
no line end.

**Two sources**: a host with the approvals joins them first,
`Source.inOrder(Approvals.source, source)`.

The tests (`source.test.ts`) run on a file's store
(`@everchat/sqlite`), the fakes of `@everchat/local/testing` and the turn
loop, on a `TestClock`; the two packages are devDependencies only.

## The firer

`firer.ts` (docs/wakeups.md, section 5): one fiber above `Turns`, forked in
the scope of its layer, `firer`; it ends with that scope. Its first round
runs at once, at the build; then a round after each sleep. A round:

- **The settle** (section 7), first, with no read of the switch: off stops
  fires, not the count. For each row of `unsettledWakes()` whose last turn
  has ended, `settleWake(id, turn, endOf(status, why))`: `done` is
  `"done"`; `failed`, and `stopped` with the core's why `CEILING`, are
  `"failed"`; `stopped` with another why (the person) is `"kept"`. A turn
  that has not ended (its end not yet written) holds its row for a later
  round. When the end counts as failed and the row read is active with
  `WAKE_FAILURES - 1` failures, the settle is the `write` of a
  `Turns.note`, `stoppedText`: the row's stop and its note are one
  transaction, so a fault leaves neither, and the next launch writes both.
  A row read as stopped already is settled with no note. The rows of a
  round settled first can fire in it.
- **Off**: the chat's `wakeups` is false: the round reads no due row
  (`dueWakes`) and writes no `pendWake`; it still reads the active rows
  (`wakes({ active: true })`) for its sleep, and calls `Turns.ready`.
- **On**: for each row of `dueWakes(now)`, `pendOf` gives what to write
  with `pendWake`: a reminder's time, with no count and no next slot; a
  routine's newest slot at or before now, the count of its slots before
  it, and its next slot (`missedOf`, walked from the row's `due`, never
  found from now: a clock set back finds nothing due, and fires no slot
  twice). The store keeps one waiting fire, and grows its `missed`.
- **`Turns.ready`**, at each round, on or off, with new rows or none: a
  fire held by the budget, by a fault or from before a start is asked for
  again within `SLEEP`.
- **The sleep**: until the next `due` of an active row that is after now,
  and `SLEEP` (60 s) when that is later or there is none. An `end` event of
  the turn loop ends it sooner: a listener, subscribed (`Turns.subscribe`)
  at the build before the first round, tells the firer's fiber, and settles
  nothing itself. The settles run in the firer's one fiber, one at a time;
  an event that the hub dropped, ends that came during a round and an end
  from before the listener are the next round's.

A round that fails (a member, a settle's note, `Turns.ready`) is one
diagnostic of the
source `wakeups`, and the next round runs after `SLEEP`: the fiber never
ends on a `StoreError`. A row whose `cron` or zone no longer parses (a row
is data) is a diagnostic for that row, one time in a launch, and the
round's other rows are still written.

The tests (`firer.test.ts`) build the firer by its layer over the turn
loop of `source.test.ts`, on a `TestClock`: the firer's clock tells each
sleep, which ends a round, and a case moves the clock only then. A case
may hold the listener back (its events wait behind a gate), so that only
the clock's round settles.

## The functions

`functions.ts` (docs/wakeups.md, section 8): the model makes, lists and
stops the wake-ups of its chat; they are the only way to make a row. Each
has a hand-written signature and no approval: `wake` and `unwake` take one
object, `wakes` none. A launch gives the declarations to its head and the
entries (`entries(store, { zone })`) to its functions, with the wake-ups on.

- **`wake({ when, text, zone? })`**: the zone is the argument's, else
  `options.zone` (the config file's), else the machine's (`machineZone`),
  and it is kept on the row as the engine names it. `when` and the zone go
  through `time.ts` (`zone`, `parse`, their bounds first). A reminder's
  first fire (`first`) is its time (`reminderAt`); a routine's is its next
  slot after now (`nextSlot`). The text is 1 to `WAKE_TEXT_MAX` (2,000)
  characters, checked before the store is asked. The row gets the caller's
  turn and call, and `makeWake` counts the `ACTIVE_MAX` (20) active rows in
  its transaction. It gives `{ id, next }`, `next` the row's `first` on its
  wall clock (`2026-11-16 09:00 Europe/Berlin`), the time of the make's
  note. **`off: true`** comes only when the chat's `wakeups` was false at
  the make: the row is made all the same (the limit holds), and fires only
  after `/wakeups on`.
- **`wakes()`**: every row, the active rows first, then the stopped rows,
  each group by id: `{ id, text, when, zone, next, last, fired, missed,
  stopped, why }`. `when` is the routine, or the reminder's time as `wake`
  takes it (`2026-11-18T09:00`, with its seconds when not 0); `next` the
  fire that waits, else `due`; `last` the last slot fired; `stopped` when it
  stopped; each time on the row's wall clock, or null. The result is data
  for the program: the text is exact, with no escape. Stopped rows have no
  limit: a built-in function's result reaches the program whole, its call's
  row keeps it, and the model reads the program's echo cut to the output
  limit (`LIMIT`, `packages/core/src/limit.ts`).
- **`unwake({ id })`**: `stopWake(id, "unwake", call)`, always with the
  caller's call, so that `wakesOf` finds the stop. It gives
  `{ id, stopped: true }`; a fire that waited goes with the row.
- **The refusals**: each is a `FunctionError` whose message the model
  reads: it names the field, says what is wrong and gives a right example.
  The decoders refuse a call that is not one object (none, two, a text, a
  list), a field of the wrong type or missing, a field that is not known,
  and an id that is not a whole number over 0; a trailing null is an
  argument left out, and so is `zone: null`. `wake` also refuses what
  `time.ts` refuses (with its message), a reminder in the past, a text out
  of its bounds, and the 21st active row (`makeWake` gives `full`); `unwake`
  an id that is not there and a row that has stopped. A text of the
  model's input that a message repeats goes through the core's `visible`,
  cut to `SHOWN_MAX` (200) characters. A `StoreError` is no refusal: the
  call fails as the core's functions' store faults do (`stored`).
- **The notes are the loop's**: no function writes to the log. At the
  program's close the turn loop reads `wakesOf` and logs
  `Wake-up 3 set: next ...` and `Wake-up 3 stopped.`, after the approvals'
  notes, in the order of the calls. No function reads the config file.

The tests (`functions.test.ts`) run each program in a fake sandbox that
writes each call's row and runs the entry with that caller, as the
sandbox's `invoke` does, under the turn loop of `source.test.ts`, on a
`TestClock`; the chain of reminders adds the firer.

## The command's service

`commands.ts` (docs/wakeups.md, sections 7 and 9): what `/wakeups` in the
terminal does, with no terminal in it. It is the person's only control
over the turns that start with no message of theirs. The service gives
values; the terminal (`packages/local/src/terminal.ts`) makes the lines,
and reads the service with `Effect.serviceOption`: a launch with the
wake-ups off gives none.

- **`list`**: `{ on, rows }`, the chat's switch and every row, the active
  rows first, then the stopped ones, each group by id, from one read
  (`rowOf`): `{ id, text, when, zone, next, last, missed, active, why }`.
  `text`, `when` and `zone` are the row's own, exact; `when` is the
  routine, or the reminder's time as `wake` takes it; `next` the fire that
  waits, else `due`, else null; `last` the last slot fired; both on the
  row's wall clock (`wallClock`). It reads only.
- **`stop(id)`**, **`off`**, **`on`**: each the `write` of a
  `Turns.note`, in the note's one transaction, under the loop's lock,
  which an offer holds too (lead, ec-ur3a5, M1): `stopText(id)`
  (`Wake-up 3 stopped by the person.`) with `stopWake(id, "person")`;
  `OFF_TEXT` (`The person turned the wake-ups off.`) with
  `setWakeups(false)`; `ON_TEXT` (`The person turned the wake-ups on.`)
  with `setWakeups(true)`. A fault in the note's transaction leaves no
  note and no write.
- **Already so**: each member reads the state first. Where it is already
  what was asked, it writes nothing, logs no note, and says so: `stop`
  gives `none` (no row with that id, or an id that is not a whole number
  over 0) or `inactive` (a row that has stopped, a reminder that fired),
  else `stopped`; `off` and `on` give `already`, else `switched`. A write
  that finds its row changed since that read (the firer's stop at two
  failures, an `unwake`) changes nothing, and the note stays: accepted
  (docs/wakeups.md, section 7, M1 and M16); the row keeps its first `why`.
- **`ready` after `on`**: when its note committed, `on` calls
  `Turns.ready`, so a fire that waited through the off time is offered at
  once, with its missed count, with no round of the firer. Not after
  `off`, a stop, or an `on` that was on already.
- A `StoreError` of a read, of the note or of `ready` fails the member;
  the terminal writes it as its other commands' faults.

The tests (`commands.test.ts`) run the service over the turn loop of
`source.test.ts`, with no firer, on a `TestClock`; the lock's orders and
the row changed since the read are held by gates.

## Its check

The scoped check of the package (the root `AGENTS.md`, "Checks"):
`just scoped packages/wakeups/src/commands.test.ts packages/wakeups/src/firer.test.ts packages/wakeups/src/functions.test.ts packages/wakeups/src/source.test.ts packages/wakeups/src/time.test.ts`.
`just check` checks the types of its two programs.
