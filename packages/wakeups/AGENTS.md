`packages/wakeups/` (`@everchat/wakeups`): the wake-ups by time, reminders and
routines (`docs/design.md`, "Wake-ups by time"). The root `AGENTS.md` holds
the rules for every file.

## Files and entries

- `packages/wakeups/` (`@everchat/wakeups`): a chat's wake-ups by time, an
  optional package of the local build (`docs/design.md`, "Packages": its
  runtime is "none"). Today it has its first module only. Its entry:
  `./time` (`packages/wakeups/src/time.ts`): `zone`, `machineZone`,
  `parse`, their types (`When`, `Wall`) and errors (`ZoneError`,
  `WhenError`); and when a wake-up is due: `reminderAt`, `isPast`,
  `nextSlot`, `missedOf` (`Missed`), `slotText`, `lateText`, `missedText`,
  `HORIZON_YEARS`, `MISSED_MAX`, `WHEN_MAX`, `ZONE_MAX` (see "Time").
- The tests of one module sit next to it, in `packages/wakeups/src/`.

## What it is not

- No store: the rows of the wake-ups are the store's, and their members
  the core's; this package reads and writes none yet.
- No clock and no config: `time.ts` reads neither. A caller gives the zone,
  the text and now.
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
  `*/30 * * * *`, `0,30 9 * * *` or `* 9 * * *`). A seconds field (6
  fields) is refused, though `Cron` takes it.
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
  routine's next slot (`nextSlot`, `Cron.next` in its zone) must come in
  the `HORIZON_YEARS` (5) after the time asked, or the routine is refused
  with a `WhenError` (`0 0 30 2 *`, a date that never comes): the 5 years
  are the make's test only. Its slots
  follow `Cron`'s rule at a change: a skipped 02:30 fires at 03:30, a
  repeated one fires once.
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

## Its check

The scoped check of the package (the root `AGENTS.md`, "Checks"):
`just scoped packages/wakeups/src/time.test.ts`. `just check` checks the
types of its two programs.
