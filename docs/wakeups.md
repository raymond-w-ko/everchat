# The wake-ups by time: reminders and routines

This page is the design of the wake-ups by time for the local use: reminders and routines,
as the optional package `@everchat/wakeups` (`docs/design.md`, "Packages" and "Wake-ups by
time" [Q23, Q30, Q51]). It puts the mechanism in one place before the code: the rows and
their states, the store's members, a fire from its slot to its turn, the limits, the
functions, the command, the config file and the launch. The code beads are posted from
this page, and each cites its sections.

Where this page and `docs/design.md` differ, `docs/design.md` wins; where the settled list
is silent, the operator's answers and the lead's rulings decide, and they win over
`docs/research/wakeups.md`. A ruling is cited as "lead, ec-e75r, K1" to "K11" (the rulings
of this page's bead), "lead, ec-ur3a5, M1" to "M12" (the rulings of its fix, after the
reviews ec-p63kw and ec-8tbva: where they differ from K3, K5, K7 or K8 they win), "lead,
ec-hvsq7, M13" to "M16" (its second fix's: they add to M1 to M12; M13 wins over M7), "lead,
ec-e75r, D1" or "N2" (the lead's earlier rulings on the plan, and on the open points of the
investigation ec-lgj9k), and "operator, ec-wisp-z0mn8, D2" (the operator's five answers).
Facts of the tree are `path:line` at `5e1074a`, read with `git show HEAD:<path>`; the
investigations are ec-tybjt (W1 to W11, at `4ab9f0c`) and ec-lgj9k (R1 to R11, at
`6af6b1d`). `effect` is 4.1.2 as installed (`node_modules/effect/src/`). The words are those
of `GLOSSARY.md`; the new words are listed at the end.

## Contents

1. [The parts and who knows what](#1-the-parts-and-who-knows-what)
2. [The rows and their states](#2-the-rows-and-their-states)
3. [The store's members](#3-the-stores-members)
4. [Time](#4-time)
5. [A fire](#5-a-fire)
6. [The limits](#6-the-limits)
7. [The stops](#7-the-stops)
8. [The functions and the notes](#8-the-functions-and-the-notes)
9. [The command, the config file and the launch](#9-the-command-the-config-file-and-the-launch)
10. [What each stack has](#10-what-each-stack-has)
11. [The tests](#11-the-tests)
12. [The cut](#12-the-cut)
13. [Later](#13-later)
14. [New words](#14-new-words)

## 1. The parts and who knows what

Four packages hold the wake-ups (lead, ec-e75r, K1):

| Package | What it holds |
| --- | --- |
| `core` | the kind `wake`; the seam (`Source`, `Offer`, `Turns.ready`); the sources in order; a turn's ceiling; the notes at a program's close; the rows as members of `Store` |
| `sqlite` | the schema at mark 8 and the statements of the members |
| `wakeups` (runtime "none"; it imports `core` and `effect`) | time, the source over the rows, the budget, the firer, the functions and the command's service |
| `local` | the config file's section, the slash command and the launch |

The rows are members of the core's `Store`, as the approvals' rows are (option (c) of
ec-lgj9k, R4). So the tenant sweep (`packages/sqlite/src/tenant.test.ts:957-977`) and the
read-only connection (`reading(sql, bound)`, `packages/sqlite/src/sqlite.ts`) hold them by
construction, and no second store service is needed. The core knows the table, as it knows
the approvals; it does not know cron, zones, "reminder" or "routine".

The seam is built (ec-i05x2): `Offer` (`packages/core/src/turn.ts:303-307`), `Source`
(`:314-316`, read with `Effect.serviceOption` at `:374`), `HEADS` and `TAKEN` (`:185`,
`:188`), `offer` (`:727`), `following` in `drive` (`:770`) and `Turns.ready` (`:956`). A
note from outside a turn is built too (`Turns.note`, ec-d62xt, `:922-934`), and so are the
notes at a program's close (`ended`, `:572`).

No hosted part. `packages/server`, `packages/local/src/hosted.ts` and `serve.ts` do not
change. The rows are for one launch of a chat at a time, in the local use. The hosted
wake-ups are the held draft ec-2fxt (lead, ec-e75r, K1).

## 2. The rows and their states

The schema changes at mark 8, one mark for all of it; a file of mark 7 is refused, as
today (the mark, `packages/sqlite/src/schema.ts:26`; the refusal,
`packages/sqlite/src/database.ts:172-174`, and for the reads `sqlite.ts:1393-1394`; lead,
ec-e75r, K2). It adds:

- The kind `wake`, id 8 (`schema.ts:57`; `Kind` and `KINDS`,
  `packages/core/src/store.ts:44`, `:49`).
- The table `everchat_wake`, key `(chat, n)`, `n` from the program (`Numbered`), `strict`.
- `everchat_chat.wakeups integer not null default 1 check (wakeups in (0, 1))`: `/wakeups
  off` (lead, ec-e75r, D6). The chat's guards refuse only its id, tenant, UUID and rowid
  (`schema.ts:79-83`), so it may change.
- `everchat_turn.steps` and `everchat_turn.tokens`: the ceiling of a turn (lead, ec-e75r,
  D4), each null or over 0, both or neither, with the trigger
  `everchat_turn_no_new_ceiling before update of steps, tokens`, which refuses a change
  after the insert (the pattern of `everchat_approval_no_new_call`, `schema.ts:364`).

The columns of `everchat_wake`:

| Column | SQLite | Meaning |
| --- | --- | --- |
| `chat` | `integer not null references everchat_chat (id) on delete cascade` | |
| `n` | `integer not null` | the wake-up's id in the chat |
| `text` | `text not null` | what the fire says |
| `cron` | `text` | the 5 fields of a routine; null for a reminder |
| `at` | `integer` | a reminder's time, ms; null for a routine |
| `zone` | `text not null` | the IANA name, kept at the make |
| `first` | `integer not null` | the first slot that the make computed: a reminder's `at`, a routine's first slot after the make (lead, ec-ur3a5, M6) |
| `turn`, `call` | `integer` | the turn and the function's call that made it; null when made otherwise |
| `due` | `integer` | the next slot, ms; null when no slot is to come |
| `slot` | `integer` | the last slot fired; null before the first fire |
| `pending` | `integer` | the slot of a fire that is due and not logged; null: none |
| `missed` | `integer not null default 0` | the slots that the waiting fire stands for beside its own |
| `fired` | `integer not null default 0` | the count of fires |
| `last_turn` | `integer` | the turn that the last fire started |
| `settled` | `integer not null default 1` | 0 while the end of `last_turn` is not counted yet, else 1 |
| `failed` | `integer not null default 0` | the failed or ceiling-stopped wake turns in a row |
| `stopped` | `integer` | when it stopped; null: active |
| `why` | `text` | `fired`, `unwake`, `person` or `failed` |
| `stop_call` | `integer` | the function's call that stopped it (`unwake`) |
| `created`, `updated` | `integer not null` | |

References: `(chat, turn)` and `(chat, last_turn)` to `everchat_turn (chat, n)`, and
`(chat, call)` and `(chat, stop_call)` to `everchat_call (chat, n)`, each `on delete
cascade` (`docs/schema.html:128`). The index `everchat_wake_due (chat, due)`. The trigger
`everchat_wake_no_move before update of chat, n`, and the guard `everchat_wake_no_new_make
before update of text, cron, at, zone, first, turn, call`, which keeps what the make wrote
(M6). The store has no member that deletes a row: a stopped row stays, as a call does.

The checks that hold the states together:

- `(cron is null) <> (at is null)`: a routine or a reminder.
- `at is null or first = at`: a reminder's first slot is its time (M6).
- `(turn is null) = (call is null)`.
- `(stopped is null) = (why is null)`, and `why in ('fired', 'unwake', 'person', 'failed')`.
- `stop_call is null or why = 'unwake'`.
- `stopped is null or (due is null and pending is null)`: a stopped row has nothing to fire.
- `pending is null or slot is null or pending > slot`: a slot never fires twice, also when
  the clock moves back.
- `last_turn is not null or settled = 1`; `settled in (0, 1)`; `missed`, `fired` and
  `failed` 0 or more.

The states, and each change with the member that makes it (section 3):

| From | Event | To | Member |
| --- | --- | --- | --- |
| (none) | `wake` makes it | active, `due` and `first` the first slot | `makeWake` |
| active, no fire waits | its slot comes (the firer), the chat on | a fire waits: `pending`, `missed`, the next `due` (null for a reminder) | `pendWake` |
| a fire waits | another slot comes before it fires | one fire still waits: `pending` the newest slot, `missed` grown | `pendWake` |
| a fire waits, `settled = 1` | the source offers it, in the offer's transaction | fired: `slot` the slot that the source read, `fired + 1`, `last_turn`, `settled = 0`; the fire goes, or a newer slot waits on; a reminder stops, `why = 'fired'` | `fireWake` |
| fired, `settled = 0` | the end of `last_turn`: done | `failed = 0`, `settled = 1` | `settleWake` |
| fired, `settled = 0` | failed, or stopped by the ceiling | `failed + 1`, `settled = 1`; at 2 it stops, `why = 'failed'`, with its note | `settleWake`, in a `Turns.note` |
| fired, `settled = 0` | stopped by the person | `settled = 1`, the count kept | `settleWake` |
| active | `unwake`, or `/wakeups stop <id>` | stopped, `why` `unwake` (with `stop_call`) or `person` (with its note) | `stopWake` |

The counts that `packages/sqlite/src/database.test.ts` pins go from 18 tables, 31 triggers
and 9 indexes (`:120-127`) to 19, 34 (`everchat_wake_no_move`, `everchat_wake_no_new_make`,
`everchat_turn_no_new_ceiling`) and 10 (`everchat_wake_due`); `VERSION` 7 to 8 (`:128`),
and the mark's case (`:223-230`: a file of mark 7 refused, a new file of mark 8); the
tables that may change from six to seven (`:150-157`, with `everchat_wake`); the "one
rule" count from 35 to 37 (`:752`: the chat and `n` of the new table); the kinds after a
tenant's erase from 7 to 8 (`:768`); and the second kind of `:408` moves from id 8 to 9.
`docs/schema.html` changes at: section 1's tenant item, with its REPLACE sentences
(`:127`), the cascade rule (`:128`), the REPLACE list of the tables that may change
(`:133`), the MariaDB rights by column (`:134`: the chat gains `wakeups`; the wake's
`UPDATE` right names `due`, `slot`, `pending`, `missed`, `fired`, `last_turn`, `settled`,
`failed`, `stopped`, `why`, `stop_call` and `updated`), the mark (`:148`, `:158`), the
map, the kinds row (`:275`), a card for the table, the chat's and the turn's cards, the
insert (`:709`) and the DDL. `tenant.test.ts` changes at: its kinds (`:134`), `fill` (rows
in every chat, more for B and A's third chat), `READS` (`:502`), `ROWS` (`:627`), `WRITES`
(`:720`) and the pinned list of references (ec-lgj9k, R1 and R4).

## 3. The store's members

Each member is on `Reading` (a read) or `Store` (a write) in `packages/core/src/store.ts`,
with its statement in `packages/sqlite/src/sqlite.ts`, and each has its tenant case. Each
write is one transaction, reads the time from the clock and sets `updated` (lead, ec-e75r,
K3, with ec-ur3a5, M2 to M6; the names and the shapes below are this page's):

| Member | On | What it does |
| --- | --- | --- |
| `makeWake(wake: NewWake, limit)` | `Store` | in one transaction: `{ _tag: "full" }` when the chat has `limit` active rows, else the row made, with its `first`, `{ _tag: "made", wake }`. The bound of the text is checked before the transaction, as `answerApproval` checks its bounds. The 20 rows are counted here, not in the function |
| `wakes(filter?: { active?: boolean })` | `Reading` | the rows, in the order of `n` |
| `dueWakes(now)` | `Reading` | the active rows of a chat with `wakeups = 1` whose `due <= now` |
| `pendWake(n, { pending, missed, due })` | `Store` | the firer's write when a slot comes: the newest slot, the count of the slots before it that never fired, the next `due`. A row whose fire waits already keeps one fire: `pending` moves to the newest slot, and `missed` becomes the old `missed` + 1 + the new count, at most 1,000 (section 4). Only an active row of a chat with `wakeups = 1` changes, tested in its own statement (lead, ec-ur3a5, M2) |
| `pendingWake()` | `Reading` | the oldest waiting fire of an active row whose last end is counted: the least `pending`, then the least `n`. A row with `settled = 0` is left out (lead, ec-ur3a5, M3); none when the chat has `wakeups = 0` |
| `fireWake(n, turn, read: { pending, missed })` | `Store` | the offer's write, of the slot that the source read (M2): `slot = read.pending`, `fired + 1`, `last_turn = turn`, `settled = 0`. When the row's `pending` is still `read.pending`: `pending = null`, `missed = 0`. When the firer wrote a newer slot since: `pending` stays, and `missed` loses `read.missed + 1`, not below 0; a count at the bound of 1,000 stays there. A reminder also stops, `why = 'fired'`. Only updates of the row itself, which no check can refuse (lead, ec-e75r, D1) |
| `fires(since)` | `Reading` | the count of `wake` messages since a time: the pages of the kind with `more = 0` and `created >= since` |
| `settleWake(n, turn, end: "done" \| "failed" \| "kept")` | `Store` | changes only a row with `last_turn = turn` and `settled = 0`, else nothing (lead, ec-ur3a5, M4): `failed = 0`, `failed + 1`, or the count kept; `settled = 1`. In the same statement, a count that reaches 2 stops an active row, `why = 'failed'`, with `due`, `pending` and `missed` cleared as `stopWake` clears them (the check of section 2 asks for it); a row that stopped already keeps its first `stopped` and `why` (lead, ec-ur3a5, M5). It does not read the chat's `wakeups` (lead, ec-hvsq7, M13). It gives what it did: settled or not, stopped or not |
| `unsettledWakes()` | `Reading` | each row with `settled = 0`, with its `last_turn`, that turn's status and why, and the row's `failed` (M4): the firer's read at each round and at each `end` |
| `stopWake(n, why: "unwake" \| "person", call?)` | `Store` | stops an active row: `stopped`, `why`, `stop_call`, `due = null`, `pending = null`, `missed = 0`; a row that is not active changes nothing, and it gives whether it stopped. The person's stop is the `write` of a `Turns.note` (section 7) |
| `setWakeups(on)`; `Chat.wakeups` | `Store`; `Reading` (`chat`) | the chat's column, and its read. The person's change is the `write` of a `Turns.note` (section 7) |
| `wakesOf(program)` | `Reading` | the rows that a function call of that program made (`call`) or stopped (`stop_call`): the notes (section 8) |

A turn's ceiling: `NewTurn` and `Turn` (`store.ts:234`, `:221`) gain
`steps: number | null` and `tokens: number | null`, and `startTurn` (`store.ts:590`)
writes them in the offer's transaction.

`fires(since)` scans the chat's messages: `everchat_msg` has one index,
`everchat_msg_sender_key` (`schema.ts:204`). For the local use (one chat) that is accepted;
an index on `(chat, kind, created)` is for the hosted wake-ups.

## 4. Time

Time is in `@everchat/wakeups` (`packages/wakeups/src/time.ts`), over `effect`'s `Cron` and
`DateTime`, with no clock, store or config read: the caller gives now (lead, ec-e75r, K4;
ec-2ppnj; ec-jehao; after its own reviews, lead, ec-ur3a5, M11). The calls (ec-tybjt,
W10): `Cron.parse(text, zone, options)` (`Cron.ts:614`), `Cron.next` (`:869`),
`Cron.sequence` (`:1213`), `DateTime.zoneMakeNamed` (`DateTime.ts:1226`), `zoneMakeLocal`
(`:1277`), `makeZoned` (`:816`). Each runs with no runtime API: the zones come from
`Intl`, a global.

- **Bounds first.** `parse` and `zone` refuse a text over `WHEN_MAX` (200) or `ZONE_MAX`
  (100) UTF-16 units before they read it, and each part of a refusal's message goes
  through the core's `visible` (the fix ec-pnced).
- **`when`** is a reminder's time or the 5 fields of a routine. A routine fires one time
  each hour at most: its minutes are exactly one value (`0 * * * *` and `15 9 * * 1-5` are
  taken; `*/30`, `* 9 * * *` and `0,30 9 * * *` are refused), and a text with a seconds
  field is refused: `Cron.parse` takes 6 fields (`Cron.ts:618`), so that refusal is
  EverChat's own test. A reminder is a local date and time with no offset and no zone, to
  the minute or the second (`2026-11-18T09:00`, `2026-11-18 09:00:30`), read on the zone's
  wall clock; it may be at any minute. Each refusal says what was wrong and gives one right
  example: the model reads it (ec-2ppnj).
- **The zone** is an IANA name: the function's, else the config file's, else the
  machine's (`zoneMakeLocal`). It is kept on the row at the make, so a later change of the
  machine's zone moves no wake-up (lead, ec-e75r, K4; operator, ec-wisp-z0mn8, D7).
- **A reminder's time** is its wall time in its zone, as ms. A wall time in a gap of the
  zone's clock moves forward, as `effect`'s `compatible` rule does: 02:30 on 2026-03-29 in
  `Europe/Berlin` gives 03:30. `makeZoned` applies that rule only with `adjustForTimeZone:
  true` (`internal/dateTime.ts:311-314`); without it the wall time is read as UTC. A wall
  time in an overlap gives the earlier of the two (ec-jehao). A time in the past is
  refused.
- **A routine's next slot** after a time is `Cron.next` in its zone. A routine with no slot
  in the next 5 years (`0 0 30 2 *`) is refused at the make (ec-jehao): `Cron.next` throws
  `Unable to find cron date` for a date that never comes (`Cron.ts:1106`, `:1167`), and the
  refusal catches it. Near daylight saving, `effect`'s rules hold, as the research ran them
  (`docs/research/wakeups.md`, "Effect 4.1.2"): a slot in the skipped hour fires an hour
  late (02:30 gives 03:30), and a slot in the repeated hour fires one time, at the earlier
  (`onDstOverlap` `earlier`, the default). So `0 * * * *` fires 24 times on the night that
  has 25 hours. EverChat follows `effect`, not Vixie cron (03:30, not 03:00).
- **Missed slots.** For a routine whose `due` is at or before now: the newest slot at or
  before now, the count of the slots from `due` up to it that it stands for beside itself,
  and the next slot after now. The count stops at 1,000 and then reads "1000 or more": a row
  that slept for years does not make the program walk each hour (ec-jehao).
- **By slot, not by time.** The newest slot is never at or before the last slot fired
  (`slot`), and the row's check says so too (section 2). A clock that moves back fires no
  slot twice; it fires nothing until the clock passes the next slot (the research's run;
  OpenClaw #60083 compared times).
- **The text of a slot** on the row's wall clock: `2026-11-16 09:00 Europe/Berlin`; how
  late, in words: `2 h late`, `3 min late`, nothing under one minute (ec-jehao).

## 5. A fire

The firer is a fiber above `Turns`, in the terminal only (lead, ec-e75r, K5, with ec-ur3a5,
M4, M7 and M8, and ec-hvsq7, M13 and M15; the lead's comment 2 on ec-e75r). It sleeps until
the next `due`, and 60 s when that is later; an `end` event wakes it sooner (section 7).
Each round, in its one fiber:

1. It settles: it reads `unsettledWakes()` and settles each row whose `last_turn` has ended
   (section 7), with no read of the switch (lead, ec-hvsq7, M13).
2. It reads the chat's `wakeups`: while off it skips step 3, so it pends nothing (M13).
3. It reads `dueWakes(now)`. For each row it asks time (section 4) for the newest slot, the
   missed count and the next slot (null for a reminder), and writes `pendWake`.
4. It calls `Turns.ready` (`turn.ts:956`), at each round, with new due rows or with none,
   and while off (lead, ec-ur3a5, M8; M13): a fire that waits past the budget, after a
   fault, or from before a start is asked for within 60 s. `ready` does nothing while a turn
   runs or a stopped turn's end is not yet written (`:957`).

A round that fails does not end the firer (lead, ec-hvsq7, M15): a failure of a member,
`Turns.note` or `Turns.ready` is a diagnostic (source `wakeups`, as at `approval.ts:61`,
`:177`), and the next round tries again; the fiber never ends on a `StoreError`. After a
failed write the memory refuses each push for the launch (`memory.ts:784-790`): a fire, or a
settle with a note, waits for the next launch, seen only in the diagnostics.

At a start, the first round runs at once: it settles, then, when on, writes one waiting fire
with its missed count for each row whose slots passed: a missed wake-up fires one time at
the next start (`docs/design.md`, "Wake-ups by time"). After `/wakeups on` the same holds
(lead, ec-ur3a5, M7): the command calls `Turns.ready`, and the firer's next round, within
60 s, gives each row whose slots passed while the chat was off one waiting fire with its
missed count, as after a time that EverChat was down. So a routine does not skip in silence,
and a reminder whose time passed while off fires one time, late.

The source (`Source.next`, below `Turns`) is asked by `offer` (`turn.ts:727`), which runs
under the loop's lock from the source's `next` to its commit: at `ready` and at a turn's
end (`following`, `:770-786`). It gives the oldest waiting fire of a settled row
(`pendingWake`) as an `Offer` of the kind `wake`, with its ceiling (section 6), and its
`write` is `fireWake(n, turn.id, read)`, with the `pending` and `missed` that it read. So
the message's pages with their `message` events, the turn and its `start`, and the row's
change are one transaction (the offer's `recordPush`, `:435-456`): a fire is not lost, and
it does not occur twice.

The writes from outside a turn and an offer (lead, ec-ur3a5, M1 and M2):

- The person's stop, off and on are each the `write` of a `Turns.note`, which holds the
  same lock (section 7). So none comes between a source's read and its commit: a stop that
  commits first leaves nothing to offer, and a stop that waits for the lock comes after a
  fire that is then already in the log.
- The firer's `pendWake` takes no lock. When it writes a newer slot between the read and
  the commit, `fireWake` consumes the slot that the source read: the text in the log and
  the row's `slot` are that slot, and the newer slot still waits with its own count.
- `wake` and `unwake` write inside a running turn, when no offer is made (`ready` gives up
  while a turn runs).

A crash before the commit leaves the row's fire waiting; a store's fault in that
transaction stops the memory for the launch (`turn.ts:296-302`;
`packages/core/src/memory.ts:784-790`), so the next launch fires it, one time. A crash
after it leaves a turn that goes on at the next launch from its row, with its ceiling
(`turn.ts:981`, the restart). The source gives nothing with `/wakeups off`, nothing for a
row whose last end is not counted yet, and nothing past the budget (section 6): the fire
then stays waiting, and its text says how late it is when it fires.

The fire's text, made at the offer (the research's form):

```
[3] due 2026-11-16 09:00 Europe/Berlin, 2 h late, 1 missed: Read my mail and give me the plan.
```

"late" and "missed" come only when they are not zero; past the bound it reads "1000 or more
missed". The turn's first item has the header `Turn: a wake-up fired:` (operator,
ec-wisp-z0mn8, D2): `WAKE = "Turn: a wake-up fired:\n\n"` beside `LATE` (`turn.ts:180`),
and `HEADS` gains `wake: WAKE` (`:185`); `TAKEN`, `first`'s header and `offer`'s check of
the kind follow with no other line. A `wake` never steers a turn: `waiting` stays
`["user", "work"]` (`turn.ts:475`).

**A source's turn takes the messages that wait** (operator, ec-wisp-z0mn8, D9; lead,
ec-e75r, N4: one rule for every source, `late` too). At HEAD `offer` gives up while a
person's message waits (`turn.ts:729`); the test goes, and the case "after a failed turn
with a waiting message of the person the offer does not start a turn" is inverted. It
matters only after a failed turn: after a done one, a waiting message starts its own turn
first (`following`). The model then reads one block, in the order of the messages
(`first`, `turn.ts:514`; `parts`, `:496`); a message of another kind than the turn's first
reads `<kind>: <text>`:

```
Turn: a wake-up fired:

user: Are you there?

[3] due 2026-11-16 09:00 Europe/Berlin, 4 min late: Read my mail and give me the plan.
```

**Two sources** (lead, ec-e75r, N3). `Turns.layer` reads one `Source` (`turn.ts:374`), and
the tree says that a host with more than one gives one that asks them in its own order
(`turn.ts:310-313`). A static of `Source` in `turn.ts` builds it: `Source.inOrder(...)`
builds each source's layer in the layer's scope, asks each `next` in turn, and gives the
first offer that is not null. The approvals come first (each is the answer to the model's
own call), then the wake-ups. `Approvals.source` is a layer
(`packages/core/src/approval.ts:233`), so it joins as a layer.

## 6. The limits

| Limit | Where | What happens past it | Source |
| --- | --- | --- | --- |
| 20 active rows in a chat | `makeWake(wake, 20)` | `wake` is refused: "20 wake-ups are active; stop one with unwake({ id })" | design; lead, ec-e75r, K3, K8 |
| a routine one time each hour at most | `parse` | `wake` is refused, with an example | design; lead, ec-e75r, K4 |
| `when`: at most 200 UTF-16 units (`WHEN_MAX`) | `parse`, before it reads | refused | lead, ec-ur3a5, M11 (ec-pnced) |
| a zone's name: at most 100 UTF-16 units (`ZONE_MAX`) | `zone`, before it reads | refused | lead, ec-ur3a5, M11 (ec-pnced) |
| the text of a wake-up: 1 to 2,000 characters (UTF-16 units, once well-formed) | `wake`, and `makeWake` before its transaction | refused | this page (lead, ec-e75r, K8 leaves the number to it) |
| 6 fires in any 60 minutes, 24 in any 24 hours, counted back from now | the source, by `fires(now - 60 min)` and `fires(now - 24 h)` | the source gives nothing; the fire waits | design; operator, ec-wisp-z0mn8, D8 |
| a wake turn's ceiling: 20 steps, 2,000,000 tokens | `run` | the turn ends `stopped`, with the ceiling's why | design; lead, ec-e75r, K6, N6 |
| two failed or ceiling-stopped wake turns in a row | `settleWake`, in a `Turns.note` | the row stops, `why = 'failed'`, with its note in the same transaction | design; operator, ec-wisp-z0mn8, D3; lead, ec-e75r, K7; ec-ur3a5, M5 |
| the firer's sleep: 60 s, or less when a slot comes sooner | the firer | a fire is up to 60 s late, plus the turns that run before it | lead, ec-e75r, K5 |
| missed slots counted up to 1,000 | time | "1000 or more missed" | ec-jehao |
| a routine's next slot within 5 years | time | `wake` is refused | ec-jehao |
| `/wakeups off` | the chat's `wakeups` | the firer pends nothing; the source gives nothing; an end is still settled, and stops its row at two failures; `wake` still makes a row | design; lead, ec-e75r, D6; ec-ur3a5, M7; ec-hvsq7, M13 |

The text's bound of 2,000 is the bound of a turn's why (`WHY`, `turn.ts:269`): a fire's
message is then one page (`PAGE` is 30,000, `packages/core/src/pages.ts:13`), and a list of
20 rows stays short.

The budget counts fires, so a row that makes the next row does not reset it: a chain of
reminders one minute apart fires 6 times in an hour, not 60 (the research's trace). A
wake-up made in a wake turn is allowed; the budget counts its fires (lead, ec-e75r, K8).
`shell` can change the database (the same OS user's): the budget stops a loop of the
model, not an attacker (`docs/research/wakeups.md`, "Limits").

**The ceiling of a wake turn** (lead, ec-e75r, K6). `Offer` (`turn.ts:303`) gains
`ceiling?: { steps, tokens }`; `offer` gives it to `begin` (`turn.ts:712`), so `startTurn`
writes it on the turn's row in the offer's transaction, and the row keeps it through a
restart (lead, ec-e75r, D4). `run` (`turn.ts:685`) reads it from the turn's row. After each
step's results (`after`, when the turn is not done), it counts the turn's steps (its items
of the kind `turn`) and the tokens of its usage rows: `input + cacheRead + cacheWrite +
output` of each row with the turn's id (`store.addUsage`, `turn.ts:672`; read again with
`usage({ turn })`, `store.ts:530`, after a restart). When the steps reach `steps` or the
tokens reach `tokens`, the turn ends `stopped` with a fixed why, `CEILING`, a constant of
the core (lead, ec-e75r, N5): no interrupt and no new status. The why is also the turn's
note, and names no number, since the numbers are not the core's: "Stopped: this wake-up's
turn reached its ceiling of steps or tokens." The numbers are constants of the wake-ups
package: 20 steps and 2,000,000 tokens (lead, ec-e75r, N6; the owner may change them). A
turn of a person has no ceiling: its row's `steps` and `tokens` are null.

`run` then gives `"done"` to `drive`, so `following` goes on as after a done turn (lead,
ec-ur3a5, M9): a waiting message of the person starts its turn, else the source's offer.
The end still counts against the row (section 7). A wake turn stays a wake turn whoever
steers it: a person's message that it takes or that steers it runs under its ceiling, and
a ceiling stop then counts against the row.

## 7. The stops

**The settle** (lead, ec-e75r, K7, with ec-ur3a5, M3 to M5; operator, ec-wisp-z0mn8, D3).
The firer is the only settler. At each round, before it reads the due rows, and at each
`end` event of the turn loop (`Turns.subscribe`), it reads `unsettledWakes()` and settles
each row whose `last_turn` has ended, with `settleWake(n, last_turn, end)`; then it calls
`Turns.ready`. The settle does not read the switch: off stops fires, not the count (M13).
The listener only wakes the firer's fiber: an event that the hub dropped, an end from before
the listener and a start are the round's; the settles run in that one fiber, one at a time.

| The end of `last_turn` | `end` | The count |
| --- | --- | --- |
| `done` | `"done"` | 0 |
| `failed` | `"failed"` | + 1 |
| `stopped` with the why `CEILING` | `"failed"` | + 1 |
| `stopped` by the person (Esc, `/stop`) | `"kept"` | kept |

A row with `settled = 0` is not offered (`pendingWake`): its slots still come due and
wait, and it fires again only after its last end is counted. So the end of a wake turn is
counted before the row's next fire, also when that fire came due while the turn ran, and
also at a start where a restarted wake turn ends, or the approvals' load calls `ready`
(`packages/core/src/approval.ts:196`), before the firer's first round. `settleWake` names
the turn, so a settle that comes late, or again, changes nothing. A stopped turn whose end
could not be written (the lost end, `writeLost`, `turn.ts:836`) has not ended for this
count: it holds its row until its end is written. A reminder ends when it fires
(`fireWake`), and the end of its turn is still settled.

**The stop at two failures** (M5). When the end counts as failed and the row's `failed` is
1, the firer settles through `Turns.note(text, write)`, with `settleWake` as the write:
"Wake-up 3 stopped: two of its turns in a row failed or reached the ceiling." The stop and
its note are one transaction. A crash before the commit leaves the row unsettled, and the
next round (or launch) does it again: one note, never none, never two. A fault in it is the
round's (M15): the next launch settles the row. A row that the firer reads as stopped
already (the person, in between; a reminder that fired) is counted and settled with no note,
and keeps its first `stopped` and `why`. A person's stop that commits between the firer's
read and its note (both take the loop's lock) leaves the note, and the row keeps the
person's `why`: accepted, as M1 accepts a note whose row changed. So are two more (lead,
ec-hvsq7, M16): an `unwake` in that window (it takes no lock: both notes are in the log, and
the row says `why = 'unwake'`), and a `/wakeups stop` behind the offer of a reminder (the
fire in the log, then "Wake-up 3 stopped by the person."); a code bead does not treat them
as faults.

**The person's stops** (lead, ec-ur3a5, M1). `/wakeups stop <id>`, `/wakeups off` and
`/wakeups on` are each the `write` of a `Turns.note`, in the note's one transaction, under
the loop's lock (`turn.ts:922-934`; `offer` holds the same lock, section 5). The notes:
`Wake-up 3 stopped by the person.`, `The person turned the wake-ups off.`, `The person
turned the wake-ups on.` Where the state is already what was asked (a row that is not
active, off when off, on when on), the terminal writes a line on the screen and no note. A
note's write that finds its row changed since the terminal read it changes nothing, and
the note stays: accepted.

**The model's stop.** `unwake` (`stopWake(n, "unwake", call)`) writes inside a running
turn, when no offer is made; like `wake`, it is never gated by an approval. A stopped
row's waiting fire goes with it and is never offered. A turn that a fire started is not
stopped by a stop of its row: the person stops it with Esc or `/stop`.

## 8. The functions and the notes

Three functions, with hand-written signatures, one object argument, no schema and no
approval (lead, ec-e75r, K8; ec-lgj9k, R6): the tree's rule is that EverChat's own
functions have signatures, and take a list of arguments (`packages/core/src/head.ts:20-23`);
a list of one object is K8's form. Their names pass the name rule (`refusals`,
`packages/core/src/functions.ts:202`).

```ts
wake(args: { when: string; text: string; zone?: string }): Promise<{ id: number; next: string; off?: true }>
wakes(): Promise<Array<{ id; text; when; zone; next; last; fired; missed; stopped; why }>>
unwake(args: { id: number }): Promise<{ id: number; stopped: true }>
```

- `wake` makes a reminder or a routine, and gives its id and its first fire (the row's
  `first`) on the row's wall clock (`2026-11-16 09:00 Europe/Berlin`). It refuses a bad
  `when` or zone, a routine more than hourly, a reminder in the past, a routine with no
  slot in 5 years, a text that is empty or over 2,000 characters, and the 21st active row
  (`makeWake` gives `full`). Each refusal is a `FunctionError` whose text the model reads.
  While the chat has `/wakeups off`, it makes the row (the limit of 20 holds), and its
  result has `off: true` (lead, ec-ur3a5, M7).
- `wakes` gives every row: active ones first, then stopped ones with their why.
- `unwake` stops an active row of the chat; an id that is not there, or a row that has
  stopped, is refused.

The handlers write their rows with the function's own call: `Caller.turn` and
`Caller.call` (`functions.ts:264-268`) become the row's `turn` and `call` at a make, and
`stop_call` at a stop. No function writes to the log.

**The notes** (lead, ec-e75r, K8 and N2: the approvals' way). At a program's close the turn
loop reads `wakesOf(program)` after `approvalsOf(id)`, and logs a note for each row that a
call of the program made or stopped, after the approvals' notes, in the same `log` (`ended`,
`turn.ts:572`): one transaction with the program's `tool` and `echo`. So a cut program's
restart (`turn.ts:981`) gives them too. The words are the core's, beside `ended`:

- a make: `Wake-up 3 set: next 2026-11-16 09:00 Europe/Berlin`, from the row's `first` on
  its wall clock, not from `due`, which a slot or a stop moves (lead, ec-ur3a5, M6);
- a stop by the model: `Wake-up 3 stopped.`

The notes follow the order of the function calls. A row that one program made and stopped
gets both, also after a restart and after a stop from outside before the program's close
(M6). The note shows the truth when the model says "I set it" with no call
(`docs/research/wakeups.md`, "Limits").

## 9. The command, the config file and the launch

**The command** (lead, ec-e75r, K9, with ec-ur3a5, M1 and M7). One entry `wakeups` of
`COMMANDS` (`packages/local/src/terminal.ts:117`); the parse (`:140`) already gives
`("wakeups", "stop 3")`:

| Command | What it does |
| --- | --- |
| `/wakeups` | lists the rows: id, text, `when`, zone, next, last fire, missed, state |
| `/wakeups stop <id>` | `Turns.note` with `stopWake(n, "person")` as its write (section 7) |
| `/wakeups off`, `/wakeups on` | `Turns.note` with `setWakeups(false)` or `setWakeups(true)` as its write; after `on`, `Turns.ready` |

While off, the slots pass; after `on`, each row whose slots passed fires one time with its
missed count (section 5). The terminal reads the wake-ups' service with
`Effect.serviceOption`, not as it reads `Approvals` (`terminal.ts:216`). With none, the
command says that the config file turns the wake-ups off. Each text of a row that the
terminal shows goes through `visible`, as an approval's does.

**The config file** (lead, ec-e75r, K9; operator, ec-wisp-z0mn8, D7). `config.json` gains
`wakeups: { on?: boolean, zone?: string }` (`packages/local/src/config.ts:176`): on unless
it says `on: false`; `zone` is checked as an IANA name, and a bad one ends the start with a
fault, as each fault of the file does. An unknown field is refused today (`:297`, `:211`),
so an older build refuses a file that has the section. The factory's own config file turns
them off (`docs/factory.md`), and no code finds out where it runs.

**The launch** (lead, ec-e75r, K9 and N7). In `packages/local/src/main.ts`:

- The functions: with the wake-ups on, the three declarations join `declarations` and their
  entries join `more` in `stack` (`main.ts:268-281`), in both paths: with no server,
  `stack(NOTHING)` (`:290`); with one, the `Layer.unwrap` step (`:291`) of `connect`
  (`:225`), whose `beside` (`:230`) holds the three declarations too. One list and one
  head for the chat, in the terminal and in pipe mode alike (N7). With them off, none of
  the three.
- The terminal (`:424`): the sources in order below `Turns`, in place of
  `Layer.provide(Approvals.source)` at `:279`, and the firer above it, beside
  `Approvals.layer` (`:280`), so its fiber ends with the launch's scope. `parts` is built at
  `:398`, before the test of the terminal at `:400`: the option is given in that branch.
- Pipe mode (`:435`): no wake-ups' source and no firer. Its end waits for `turns.idle`
  (`packages/local/src/pipe.ts:115`), so a source there would chain a wake turn into it. A
  wake-up made in pipe mode fires at the next start of the terminal.
- `everchat serve` and `everchat inspect` get nothing (lead, ec-e75r, N9: the inspector's
  rows are a held draft).

**The words** (lead, ec-e75r, K10 and N8; the owner may change them). The prompt's line for
the kind, after `- late:` (`packages/core/src/prompt.ts:69`), in its form and without the
name "EverChat", so the 16 places of the name stay
(`packages/core/src/compactor.test.ts:69`):

```
- wake: a wake-up that you set came due: "[id] due <time> <zone>", how late, then its text
```

The head's hash changes on purpose (`compactor.test.ts:61`;
`packages/local/tests/connectors.test.ts:363`, which also sees the three declarations in
pipe mode's head). The terminal's mark is `◷ `, with the look of `late`
(`packages/local/src/paint.ts:142-151`). The inspector's word is "a wake-up that came due",
with a color of its own (`packages/local/src/inspector.html`, `--late` and `.kind-late`).

There is no schedule file (lead, ec-e75r, K11): the person makes rows only through the
model, and stops them with `/wakeups`.

## 10. What each stack has

| | The terminal | Pipe mode | `everchat serve` | `everchat inspect` |
| --- | --- | --- | --- | --- |
| the kind `wake`, its header, the prompt's line | yes | yes | yes (the one schema and prompt) | the kind's word |
| `wake`, `wakes`, `unwake` | when on | when on | no (`HOSTED`) | no |
| the wake-ups' source | when on, after the approvals' | no | no | no |
| the firer | when on | no | no | no |
| `/wakeups` | yes | no | no | no |
| a wake turn's ceiling | on the turn's row | a wake turn that a restart continues keeps it | no wake turns | no |

## 11. The tests

The research's list (`docs/research/wakeups.md`, "How to test it"), each on a `TestClock`:

- **A fire at its slot**: the firer forked, the clock moved past the slot, the `wake`
  message in the log and its turn.
- **A start after missed fires**: a row whose last slot is old; the layer built with the
  clock already late (not `setTime` on a running firer); one fire, its missed count.
- **Daylight saving**: rows in `America/New_York` and `Europe/Berlin` over 2026-03-08,
  2026-03-29, 2026-10-25 and 2026-11-01: a routine at 02:30 and at 09:00, a reminder in the
  gap (03:30 pinned) and in the overlap.
- **A clock that moves back**: no second fire.
- **A crash in a fire**: a store fault after the message, before the commit: no message
  and no slot; the memory stops for the launch, and the next launch fires it, one time
  (lead, ec-ur3a5, M10).
- **A fire while a turn runs**: a fake wire holds turn A; the wake comes due; a person's
  message steers A; A ends: the wake starts turn B alone. Again with a restart before B.
- **A chain of reminders**: each wake turn makes the next for one minute later: 6 fires in
  60 minutes, and the 7th waits.

What the rulings add. Each case is gated (a store or a lock held until the case lets it
go), and none counts on real time (M10):

- **The lock** (M1), a person's stop or `/wakeups off`, a gate for each order (lead,
  ec-hvsq7, M14): the offer first (the stop asked while the offer, holding the loop's lock,
  waits for the memory's lock) gives the fire in the log, then the note; the stop first (the
  note's `write` held inside the loop's lock, then `ready`) gives no wake message, no turn.
- **A newer slot during an offer** (M2): `pendWake` between the source's read and its
  commit: the text's slot is the row's `slot`, and the newer slot waits with its count.
- **The settle** (M3, M4): a row whose fire waits when its turn ends failed is settled,
  and stops at 2, before it fires again, with the listener held back; again at a start
  where the approvals' `ready` comes before the firer.
- **The note at two failures** (M5): a fault in the note's transaction, then one note at
  the next launch; a row with a waiting fire that stops at its second failure, with `due`,
  `pending` and `missed` cleared.
- **The make's note** (M6): a make and an `unwake` in one program; a stop from outside
  before the program's close; a restart after the stop's commit; each with the exact notes.
- **Off and on** (M7): while off the firer pends nothing, the source gives nothing, and
  `wake` gives `off: true`; after `on`, each row whose slots passed fires one time with its
  missed count, and a reminder whose time passed fires, late. The notes of off and on, and a
  line with no note when the state is already so. **The settle while off** (lead, ec-hvsq7,
  M13): off commits while a wake turn runs; the turn fails; the row is settled (`failed`,
  `settled`) while off, by the listener's wake, and again by the round with the listener
  held back; a restart before the settle, still off: the first round settles; at a second
  failure the row stops with its one note; no `pendWake` and no offer while off; then on:
  the stopped row does not fire, and a row that did not stop fires one time with its missed
  count, only after its end was counted (M3).
- **A failed round** (M15): a member fails in a round; a diagnostic; the next round runs.
- **Asked again** (M8): a fire past the budget is offered at the first round with room.
- **After a ceiling stop** (M9): a waiting message of the person starts its turn, and the
  stop counts against the row.
- **The person's stop and `unwake` with a waiting fire**: the fire is never offered.
- **The bounds, each in the file that owns it**: the text's bound in
  `packages/wakeups/src/functions.test.ts` (`wake`) and
  `packages/sqlite/src/store.test.ts` (`makeWake`); a reminder in the past, the 5-year
  refusal, `WHEN_MAX` and `ZONE_MAX` in `packages/wakeups/src/time.test.ts` (ec-jehao,
  ec-pnced).
- **The budget's windows**: 6 fires in 60 minutes, the 7th at the first minute that has
  room; 24 in 24 hours; the waiting fire's text says how late it is.
- **The ceiling**: a wake turn stops at 20 steps, and at 2,000,000 tokens, `stopped` with
  `CEILING`; again after a restart; a person's turn has no ceiling.
- **The stops**: `failed`, the ceiling, Esc (the count kept) and `done` (the count to 0);
  an end that came while EverChat was down is counted at the start.
- **A wake after a failed turn takes the person's waiting message** (D9), and `late` too
  (N4): the block of section 5.
- **Two sources**: an approval's result and a wake-up both wait; the approval's turn comes
  first.
- **The notes**: a make and a stop by the model are notes after the approvals' notes, in
  the program's transaction; a cut program's restart gives them.
- **The rows**: the 21st active row is refused; a routine of two minutes, a seconds field
  and a zone that is not IANA are refused; a waiting fire grows `missed` and keeps one fire;
  each check and guard of section 2 refuses its case (`database.test.ts`), and each member
  has its tenant case.
- **The stacks**: pipe mode ends with no wake turn; the config's `on: false` leaves the
  three functions out of the head, the sandbox's names and the compactor's head together;
  `/wakeups` with no service says that the config file turns them off.

## 12. The cut

The code beads, in their order, from ec-lgj9k's cut (R11) under K1 (the rows on `Store`) and
K8 (the notes at the close), and under the fix's rulings (lead, ec-ur3a5, M12): its beads 2
to 8 and 10 to 17, without the seam `Notes`, without `rows.ts` and without `wake.test.ts`.
Its beads 1 and 9 are posted with this page: the package, a zone's check and the parse of
`when` (ec-2ppnj), and a reminder's time, the next slot and the missed slots (ec-jehao),
with their verify bead ec-juc3a; their bounds are the fix ec-pnced (M11).

| # | Bead | Files | Needs |
| --- | --- | --- | --- |
| 2 | The schema at mark 8 (section 2, with `first`), with `makeWake` and `wakes`, so that `fill` writes rows in every chat | `packages/sqlite/src/schema.ts`, `docs/schema.html`, `packages/core/src/store.ts`, `packages/sqlite/src/sqlite.ts`, `database.test.ts`, `tenant.test.ts`, `store.test.ts`, `packages/local/src/paint.ts`, `paint.test.ts`, `inspector.html` | none |
| 3 | The fire's members: `dueWakes`, `pendWake` (the chat on, in its statement), `pendingWake` (settled rows only), `fireWake` (the slot read), `fires` | `store.ts`, `sqlite.ts`, `tenant.test.ts`, `store.test.ts`, `docs/schema.html` | 2 |
| 4 | The other members: `settleWake(n, turn, end)` and its stop, `unsettledWakes`, `stopWake`, `setWakeups` and `Chat.wakeups`, `wakesOf` | as 3 | 3 |
| 5 | The kind in the loop: `WAKE`, `HEADS.wake`, the prompt's line, N4 in `offer` | `packages/core/src/turn.ts`, `prompt.ts`, `compactor.test.ts`, `source.test.ts`, `packages/local/tests/connectors.test.ts`, `packages/core/AGENTS.md` | 2 |
| 6 | The sources in order (`Source.inOrder`) | `turn.ts`, `source.test.ts`, `packages/core/AGENTS.md` | 5 |
| 7 | The ceiling in the store: `steps`, `tokens` on `NewTurn`, `Turn`, `startTurn` | `store.ts`, `sqlite.ts`, `store.test.ts`, `tenant.test.ts` | 2; after 4 |
| 8 | The ceiling in the loop: `Offer.ceiling`, the check in `run`, `CEILING`, `drive` after a ceiling stop (M9) | `turn.ts`, `source.test.ts`, `packages/core/AGENTS.md` | 6, 7 |
| 10 | The source over the rows, the budget, the fire's text | `packages/wakeups/src/source.ts` (new), `source.test.ts` (new), `packages/wakeups/package.json`, `bun.lock`, `packages/wakeups/AGENTS.md` | 3, 5, 8, ec-jehao |
| 11 | The firer: its round, the missed slots at a start and after `on`, `Turns.ready` at each round, a failed round a diagnostic (M15) | `packages/wakeups/src/firer.ts` (new), `firer.test.ts` (new), `packages/wakeups/AGENTS.md` | 10 |
| 12 | The firer's settle and stops (section 7), the stop at two failures in a `Turns.note`, the settle while off (M13) | `firer.ts`, `firer.test.ts`, `packages/wakeups/AGENTS.md` | 11, 8, 4 |
| 13 | The notes of a make (from `first`) and a stop at the program's close | `turn.ts`, `source.test.ts`, `packages/core/AGENTS.md` | 8, 4 |
| 14 | The functions `wake` (its `first`, `off`), `wakes`, `unwake` | `packages/wakeups/src/functions.ts` (new), `functions.test.ts` (new), `packages/wakeups/AGENTS.md` | 4, 13, ec-jehao |
| 15 | The config file's section `wakeups` | `packages/local/src/config.ts`, `config.test.ts`, `packages/local/AGENTS.md` | none |
| 16 | `/wakeups` and its service: the person's stop, off and on as `Turns.note`s, `Turns.ready` after `on` | `packages/local/src/terminal.ts`, `packages/local/tests/terminal.test.ts`, `packages/wakeups/src/commands.ts` (new), `commands.test.ts` (new), `packages/local/package.json`, `bun.lock` | 4 |
| 17 | The launch (section 9) | `packages/local/src/main.ts`, `packages/local/tests/main.test.ts`, `packages/local/AGENTS.md` | 6, 12, 14, 15, 16 |

Then one verify bead. The security beads (a manifest or the lockfile, the schema, the
tenant boundary, input from the model, a limit that guards spend): 2, 3, 4, 7, 8, 10, 11,
12, 14, 16 and 17. Each bead's tests are in ec-lgj9k's table, with `store.test.ts` in place
of `wake.test.ts`, and the cases of section 11 that name its part. Which beads wait for a
batch that holds their files is the command bead's to read when it posts (ec-foqx0).

## 13. Later

No point of the first version is open: the lead's rulings decided each, and each is in its
section (lead, ec-ur3a5, M1, M7, M8 and M9). Later, each as a bead of its own:

- The hosted wake-ups: the held draft ec-2fxt (an index on the messages by kind and time,
  the lease holder's sweep; `docs/research/wakeups.md`, "The hosted use, later").
- Background shells and monitors, on the same seam: the held draft ec-jz9x (lead,
  ec-e75r, K11).
- The rows in the inspector: a held draft (lead, ec-e75r, N9).
- Research: queue or steer, for wake-ups that are urgent (`docs/design.md`, "Later").
- A schedule that cron fields cannot say ("every 2 weeks", "the last Friday"): an RRULE is
  one library more (`docs/research/wakeups.md`, "Limits").

## 14. New words

Words that `GLOSSARY.md` does not have, as a list for the lead (the glossary changes by its
own procedure):

| Word | Meaning |
| --- | --- |
| slot | One time that a wake-up's schedule gives. |
| missed | Said of a slot that passed with no fire, because EverChat did not run, the wake-ups were off, or a fire already waited. |
| firer | The fiber of the terminal that settles the ends of the wake turns, reads the due wake-ups and makes their fires wait. |
| wake turn | A turn that a fire started. |
| budget (of fires) | The most fires in any 60 minutes (6) and in any 24 hours (24). Not the compute budget. |
| ceiling | The most steps and tokens of a wake turn, kept on its row. |
| settled | Said of a wake-up whose last wake turn's end is counted. |
| the sources in order | The one `Source` that asks each source in turn (`Source.inOrder`). |

Two words clash with the glossary, for the lead: "pending" means a call that waits for
approval, and this page writes "a fire that waits" for the column `pending`; "join" means
a client's join in the host, and this page writes "the sources in order" for what the
rulings call the join of sources.
