# Wake-ups by time: reminders and routines

How can EverChat start a turn at a time, with no message from the person: a
reminder ("at 15:00, tell me to call the bank") or a routine ("each weekday
at 08:00, read my mail and give me the plan")? The local use first (one chat,
one process, one SQLite file), as an optional package; the hosted use only to
show that nothing blocks it. What others do, what goes wrong for them, which
design prevents each fault. It decides nothing. Next to it: `agents.md`
(question 8, the wake row), `mysql.md` (lease, sweep), `portability.md`
(Durable Object alarms).

## Today

| What | Where | What it does now |
| --- | --- | --- |
| What starts a turn | src/turn.ts:439-451 | Only `say`: the person's text is logged as a `user` message, and a turn starts in the same transaction if none runs |
| What a turn takes in | src/turn.ts:195 | The messages after `chat.taken` of the kinds `user` and `work` only. A `note` never starts or steers a turn |
| A message while a turn runs | src/turn.ts:13-16, src/turn.ts:233-242 | It steers the turn: the turn reads it after the results of its present step. One that comes too late starts the next turn (src/turn.ts:396-404) |
| The interfaces | src/terminal.ts:373, src/pipe.ts:112 | Both call `turns.say(text)`. There is no other way in |
| The kinds | src/migrations.ts:17-26 | Six kinds with fixed ids, each 4 letters: `user`, `asst`, `tool`, `echo`, `work`, `note` |
| The `goal` | src/migrations.ts:49, src/store.ts:970-972 | A column and its setter. No code reads it. The old code's goal is a check after a turn, not a time: a request asks "met?", and a no adds a nudge (ref/src/server.ts:174-176, ref/src/server.ts:576-578) |
| The functions | src/functions.ts:44-82 | A fixed list. The head shows it, so it "must not change from one request to the next" (src/functions.ts:10-12) |
| The model's time | src/functions.ts:190-196 | `date(id)` gives the time of a message, on the host's clock and zone. The head and the system prompt give no time now |
| The tables | src/migrations.ts:32 | One list of migrations, for all tables. A package cannot add its own |
| The slash commands | src/terminal.ts:102-107 | A fixed list: `help`, `stop`, `diagnostics`, `quit` |
| One launch at a time | src/migrations.ts:69, src/store.ts:916-925 | A unique index on the open launch. A second launch is refused (`LaunchLive`), and a crash's launch is closed at the next start |
| Time in code | src/store.ts:19 | Times come from Effect's `Clock`, so a test can give a test clock |
| Acts by time now | src/memory.ts:118-119, src/ask.ts:83, src/terminal.ts:410 | Retries, waits and the draft's save only. Nothing starts a turn by time, and the program ends when the pipe's input ends (src/main.ts:49-53) |

## Facts

### What others do

| Who | Where the schedule is kept | What fires it | What the model gets | How a person sees and stops it |
| --- | --- | --- | --- | --- |
| OpenClaw, automations (`openclaw cron` is an alias) | "OpenClaw's shared SQLite state database" | The Gateway: "The Gateway must be running for schedules to fire" | A text: as a system event in the main session (`--session main --system-event "..."`), or a fresh isolated session | `openclaw automations list`, `show`, `runs`; `disable`, `remove` |
| OpenClaw, heartbeat | Now "ordinary automation jobs"; `HEARTBEAT.md` is no longer read at run time | A default job "every 30 minutes unless the provider supplies a different initial cadence" | The job's text and its "scratch" in the agent's main chat; `NO_REPLY` sends nothing | As any job |
| Claude Code, `/loop` and `CronCreate` | With the session ("session-scoped"), restored on `--resume`; with feature-flag fetching off, in `.claude/scheduled_tasks.json` | "The scheduler checks every second for due tasks"; a prompt "fires between your turns, not while Claude is mid-response" | The prompt, as if typed | `CronList`, `CronDelete`, or ask in words; at most 50 tasks; a recurring task ends after 7 days |
| Codex (ChatGPT app), scheduled tasks | Not stated; the Scheduled view lists them | "Keep the computer on and the app running when a scheduled task needs local files" | A new chat for each run, or "the chat's existing context"; schedule as an RFC 5545 RRULE | The Scheduled view: "active, paused, and completed tasks and recent runs" |
| Gemini, scheduled actions | Not stated; the Scheduled page lists them | Gemini, "in the background": it prepares "within the hour leading up to your delivery time" | The prompt | Pause, Resume, Delete; "up to 10 active schedules"; may be "turned off due to inactivity" |
| The factory, routines | A record bead per routine; each fire is an audit | The bridge's firer, at most once each 60 s, only while the owner seat is idle | A typed line: `everturn: routine <name> fire <id> due <time> <zone>[, <late> late][, <n> missed]: <text>` | The roster's rows, `routine-overdue` warning after 1 h; at most hourly (minute is one number) |

Sources, in the order of the rows:
https://docs.openclaw.ai/automation/cron-jobs ,
https://docs.openclaw.ai/automation/cron-jobs/how-it-works ,
https://docs.openclaw.ai/gateway/heartbeat ,
https://code.claude.com/docs/en/scheduled-tasks ,
https://learn.chatgpt.com/docs/automations?surface=app (the old address
https://developers.openai.com/codex/app/automations redirects there),
https://support.google.com/gemini/answer/16316416 , the factory's
`~/src/everturn/docs/specs/routines.md` rules 3, 30-32 and 52. ChatGPT's Tasks
page refused the fetch (403): `not proved`. Read on 2026-11-14; the OpenClaw
issues below show that its behavior changed during 2026.

### What goes wrong, and what the others did

| Fault | Evidence |
| --- | --- |
| Missed while down: all at once | OpenClaw 2026.4.25: a restart at 22:10 ran 5 jobs due at 11:00-11:24, "after-hours notifications" (report, closed not planned). https://github.com/openclaw/openclaw/issues/73644 |
| Missed while down: lost | A job fired at 19:15:00, the process was killed at 19:15:35, the new one "scheduled next run for 7 days later", "silently lost". https://github.com/openclaw/openclaw/issues/59302 |
| Missed: the last only | Kubernetes starts "a Job for the most recent missed schedule"; over 100 missed: a warning, and "Jobs for the earlier missed schedules are never started". https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/ |
| Missed: once at start | systemd `Persistent=true`: the last trigger "is stored on disk", and a missed run fires once at the timer's start. https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html |
| Missed: none | Claude Code: "No catch-up for missed fires"; a passed one-shot is not restored; a restored task's "next run is the first one due after you resume". https://code.claude.com/docs/en/scheduled-tasks |
| Missed: a window | Temporal: a "Catchup Window" ("default is one year"; minimum ten seconds). https://docs.temporal.io/schedule |
| A catch-up fires twice | After a late catch-up, a second restart fired the job again: the check compared times, not the slot that the run fulfilled (`lastFulfilledSlotMs` proposed). https://github.com/openclaw/openclaw/issues/60083 |
| The same fire 2 to 6 times | A report on OpenClaw 2026.4.1, one local Gateway process: "Each scheduled event ... results in 2-6 duplicate deliveries". The reporter's figure, not a measure of ours: with heartbeats each 5 minutes, 3-6 copies, each loading "the full agent context on an Opus-class model", "burned ~60% of API usage allowance in 5 hours with zero user activity". https://github.com/openclaw/openclaw/issues/59703 |
| A storm of wakes | One message gave "14+ separate agent sessions within 90 seconds": wakes with "no dedup key". https://github.com/openclaw/openclaw/issues/122028 |
| Twice or never, by design | Kubernetes: "two Jobs might be created, or no Job might be created ... the Jobs that you define should be _idempotent_". (Same URL as above.) |
| A fire while a turn runs | Claude Code: "If Claude is busy when a task comes due, the prompt waits until the current turn ends". OpenClaw: a session job "waits for that conversation to be idle". Temporal's default overlap policy is Skip. (URLs above.) |
| Daylight saving | Vixie cron, a change under 3 hours: skipped jobs "will be run soon after the change"; repeated: "will not be re-run"; jobs with wildcards "run based on the new time immediately"; 3 hours or more is a correction. https://manpages.debian.org/bookworm/cron/cron.8.en.html . The factory follows that rule (routines.md rules 7-8). Temporal: "use UTC to avoid various surprising properties of time zones" (URL above) |
| A zone that is not applied | `nextRunAtMs` was right for `Asia/Shanghai`, but every job ran at about 03:45 UTC. https://github.com/openclaw/openclaw/issues/45775 |
| Drift, a clock that jumps | `CLOCK_MONOTONIC` "does not count time that the system is suspended"; `CLOCK_REALTIME` "is affected by discontinuous jumps". https://man7.org/linux/man-pages/man2/clock_gettime.2.html . systemd's `WakeSystem=` timers use `CLOCK_BOOTTIME` (URL above). Which clock Bun's `setTimeout` uses: `not proved` |
| Accepted, never fired | `CronCreate` gave an id; "Scheduled tasks never fire". https://github.com/anthropics/claude-code/issues/31922 . A task "enabled: true but nextRunAt ... frozen", "No error". https://github.com/anthropics/claude-code/issues/87811 . A usage limit ended the process; the task "never fired — with no error". https://github.com/anthropics/claude-code/issues/80037 |
| The model says it set one and did not | No report found: `not proved`. |
| Spend with no end | Limits that others set: 50 tasks and 7 days (Claude Code), 10 active (Gemini), hourly at most (the factory), pause on a failed run (Temporal), "auto-disabled after repeated errors" (OpenClaw). (URLs above.) |

### Effect 4.1.2 (the installed one), read and run

- `Cron` reads 5 or 6 fields with an optional IANA zone; with none, "the host
  system's timezone is used". `onDstOverlap`: `earlier` (default), `later`,
  `both`; "The policy does not apply to local times skipped when clocks move
  forward." (node_modules/effect/src/Cron.ts, lines 31-83 and 763-764.)
  `Schedule.cron(expression, tz, options)` uses `Cron.next` from the clock's
  time (node_modules/effect/src/Schedule.ts, lines 830-897).
- `TestClock` (`effect/testing`): `adjust` and `setTime` run "all effects
  scheduled to take place on or before that time ... in order".

Run with Bun, `/tmp/ec-sml4/dst.ts`, `clock.ts`, `restart.ts`, against the checkout's `node_modules` (a link):

| Case (America/New_York unless named) | Result |
| --- | --- |
| `30 2 * * *` on 2026-03-08 (02:00 to 03:00 skipped) | Fires at 07:30Z, which is 03:30 EDT: the skipped hour is added. Vixie cron and the factory fire at 03:00 |
| `30 1 * * *` on 2026-11-01 (01:00-01:59 twice) | `earlier`: 05:30Z; `later`: 06:30Z; `both`: both. Then 06:30Z the next day |
| `*/30 * * * *` over that night, default policy | 05:30Z, then 07:00Z: the second 01:00 and 01:30 (06:00Z, 06:30Z) do not fire. Vixie cron runs wildcard jobs in the repeated hour |
| `*/30 * * * *` over the skipped hour | 06:30Z, 07:00Z, 07:30Z, 08:00Z: no gap |
| `Effect.repeat(x, Schedule.cron("0 9 * * *", "Europe/Berlin"))` from 07:00Z | `x` runs at once (07:00Z, not a slot), then at each slot. `Effect.schedule` runs only at the slots |
| The test clock moved 3 days and 2 hours by `setTime`, not `adjust` | The same 5 runs, each at its own time: `setTime` does not model a process that was down |
| A firer that sleeps 60 s and compares slots with its last slot; last fire Monday, started on Thursday 10:00 Berlin | One fire, for Thursday's slot, `missed=2` |
| The same firer after the clock is set back one day | No fire: the last slot is later than every new slot |

## Options

### Where the schedule lives

| | S1. Rows in the database | S2. A file that the person edits |
| --- | --- | --- |
| Made by | Functions that the model calls, and a slash command of the person | The person, by hand (the config file, or a file next to it) |
| Gives | One place for the rule and its state (last slot, fires); a restart reads it (AGENTS.md, "All state in one SQLite file"); the inspector can show it | Routines in a text that a person reviews and keeps in git. Not safe from the model: it has `write`, `edit` and `shell` as the same OS user (src/functions.ts:44-63, src/files.ts:64-70) |
| Costs | A table and its migration, through a package's own migrations (none today, src/migrations.ts:32) | The fire state must still be in the database (the program only reads the config file); a row for each routine from the file, matched by name; a change while the program runs |
| Rules out | Nothing | Reminders that the model sets ("remind me in an hour") |

S1 for reminders and routines; S2 maybe later, for routines kept in git;
both feed the same rows. That the program only reads its config file is a
rule of the code, not a boundary. A schedule that the model cannot change
needs an authority outside its OS user: a file that another user owns and
EverChat's user only reads (an administrator's setup), or a service. Even then
`shell` can change the database (the same user's): the rule is safe, not its
fires. S2 alone does not give this.

### What fires it

| | T1. A firer in the process | T2. The OS (cron, a systemd timer) |
| --- | --- | --- |
| How | A fiber: each 60 s at most, read the next due row, compare with the wall clock (`Clock`), fire | The OS starts `everchat` with a line, or signals the running one |
| While EverChat does not run | Nothing fires; at the next launch, the missed slots are found from the rows | Fires, but a second launch is refused while one runs (src/store.ts:916-925), and a signal carries no text: it needs an inbox, which is a new interface |
| Sleep, suspend, jumps | Short sleeps and a slot compare: a late or early wall clock gives a late or no fire, never two | The OS's rules (cron(8), `Persistent=`) |
| Costs | One fiber; works on Windows too | A unit for each OS, a change to the machine, a second way in |
| Rules out | Fires while the program is down | Being one process with no setup (AGENTS.md, "How EverChat will be used") |

### What a fire is in the log

| | K1. A `user` message | K2. A `note` | K3. A new kind `wake` |
| --- | --- | --- | --- |
| The model reads | `user: Reminder: ...`: as if the person wrote it | `note: ...` | `wake: ...`: the program, by time |
| Starts a turn | Yes, as `say` | No: `note` is not in `waiting` (src/turn.ts:195) | Yes, through the rule below (not only a kind in `waiting`) |
| Costs | Nothing | A change of what `note` means | A kind (id 7, 4 letters like the others) and a glossary entry |
| Rules out | Telling the person's words from the program's, in the memory | A turn from a note | Nothing |

When a fire comes while a turn runs:

| | J1. Steer it | J2. Wait for the turn's end | J3. Each row says |
| --- | --- | --- | --- |
| Gives | Fastest; the same path as a `user` message (src/turn.ts:233-242) | A routine gets a turn of its own, as Claude Code and OpenClaw do | Both |
| Costs | A routine's task mixes into an unrelated turn | Late while the person keeps the chat busy; the rule below | One more field |

J2 needs more than a kind in `waiting`, which feeds the first item, `steer`
and the next turn (src/turn.ts:195, src/turn.ts:216, src/turn.ts:234,
src/turn.ts:398); `chat.taken` is one mark (src/store.ts:978). A `wake` in
`waiting` steers the running turn (the review's trace: `steer` got
`[(1, wake), (2, user)]`); left out of `steer` only, it is lost when a later
`user` message moves `taken` past it. A rule that keeps it:

- A fire due while a turn runs is not logged: its row keeps it as pending
  (slot, text) in the database, across a restart too.
- When no turn runs and no message waits (a turn's end, src/turn.ts:398, or a
  tick of an idle chat), the turn loop asks the package for its oldest pending
  fire. Under the turn lock, one transaction logs the `wake`, starts its turn
  and clears the pending state. A `wake` is logged only to start its own turn.
- The case: a wake is due while turn A runs; the person's message 2 steers A
  (`taken` = 2); A ends, nothing waits; the wake is logged after A's messages
  and starts turn B. A crash before B: the launch finds the row pending.
- Costs: a pending state on each row, a hook in the turn loop, the package's
  write in the core's transaction (as `pushWith`'s `also`, src/turn.ts:187),
  and a wake that waits while turns follow each other.

The text of a fire: the row's text, the slot on the row's wall clock with its
zone, how late, and the missed count, as the factory's line does:
`wake: [3] due 2026-11-16 09:00 Europe/Berlin, 2 h late, 1 missed: Read my mail and give me the plan.`

### The functions and what the person sees

| Function (in a program) | What it does |
| --- | --- |
| `wake(text, when, zone?)` | Makes a reminder (`when` is a time) or a routine (`when` is 5 cron fields). Gives its id and its next fire on its wall clock. Refuses past limits |
| `wakes()` | The rows: id, text, schedule, zone, next fire, last fire, missed |
| `unwake(id)` | Stops one. A change is a stop and a new one |

The program, not the model, writes a `note` at each make and stop
(`Wake-up 3 set: next 2026-11-16 09:00 Europe/Berlin`): the person sees what
was set, and a claim of the model with no note is visibly false. Slash
commands: `/wakeups`, `/wakeups stop <id>`, `/wakeups off` (no fire until
`/wakeups on`). The inspector shows the rows.

### Limits

| Limit | Others | A start for EverChat |
| --- | --- | --- |
| Active rows | 50 (Claude Code), 10 (Gemini) | 20 |
| How often a routine | 1 min (Claude Code), hourly (the factory) | Hourly at most; a reminder at any minute |
| All fires together | None found | A budget on fires, counted from the `wake` messages in the log: at most 6 in any 60 minutes and 24 in a day (proposed). A fire past it stays pending until the window has room, and its text says so |
| A fire's turn | None found. A turn has no ceiling today: its loop has no limit of steps, time or spend (src/turn.ts:369) | A ceiling for each wake turn: steps (for example 20) and tokens, from its usage rows (src/turn.ts:342); past it the turn stops as `stop` does. Two failed or stopped wake turns in a row stop the row (as Temporal and OpenClaw) |
| A fire that makes a wake-up | None found | Allowed; the budget counts its fires |
| A stop for all | `CLAUDE_CODE_DISABLE_CRON=1` | `/wakeups off`, and a setting in the config file |

Rows and the hourly floor do not bound fires: a reminder that makes the next
keeps one row and fires each minute, 60 an hour (the review's trace,
`/tmp/ec-x4mt/limit-trace.py`). The budget counts fires, so a new row does not
reset it; `shell` can change the database, so it stops a loop, not an attacker.

### As an optional package

What it needs from the core, and what the core must not know:

| Need | Today | The seam |
| --- | --- | --- |
| Log a message of its kind, and start a turn | `say` writes only `user` (src/turn.ts:442-444) | A source of pending fires on `Turns`: when the chat is idle, the core asks it, and logs the fire, its turn and the package's write in one transaction (J2's rule) |
| Its functions | A fixed list (src/functions.ts:44) | Functions given at a load; the decision accepts the cache write when the set changes |
| Its table | One list of migrations (src/migrations.ts:32) | Migrations per package, with a number space each |
| Its slash commands | A fixed list (src/terminal.ts:102-107) | Commands given by a layer |
| A clock | Effect's `Clock` (src/store.ts:19) | As now |
| A start and a stop | The layers of a launch (src/main.ts:136-148) | A layer whose scope holds the firer fiber |

The core does not know cron, zones, the table, "reminder" or "routine": only
a kind that starts a turn, and a source of pending fires.

### The hosted use, later

| Where | How |
| --- | --- |
| Server (Bun, MariaDB, one active process with a lease, `mysql.md` D2) | The same rows as `everchat_wake`, key `(chat, n)`, an index on the due time. The lease holder reads the due rows each 60 s (`due <= now(3) order by due limit 100`) and fires each as a message of its chat, loading an unloaded chat as a `POST` does (about 30 ms and 2 MB in a warm process, `agents.md`). The fire's write checks the epoch: a process that lost its lease fires nothing. With one active process, `agents.md`'s `SKIP LOCKED` scan is not needed (the decision replaces it) |
| Cloudflare | "Each Durable Object is able to schedule a single alarm at a time"; `setAlarm` overrides the one there; "guaranteed at-least-once execution", "up to 6 retries". https://developers.cloudflare.com/durable-objects/api/alarms/ . `portability.md` uses the alarm to push events, so one handler serves both: the alarm is set to the earlier of the next push and the next wake. At least once is safe if the fire and the row's last slot are in one transaction |
| 100,000 chats | One indexed read per sweep, whatever the count of rows. Its time: `not proved` (`mysql.md` measured a whole read of 100,000 `chat` rows at 17.5-18.5 ms). A burst of fires at 09:00 loads many chats at once: the limit is the busy chats' work, as `agents.md` found, so a fire may wait |

Nothing in S1, T1 or K3 blocks this: only the firer differs.

## What fits, what does not

Take first: S1 (rows), T1 (a firer in the process), K3 (a kind `wake`), J2
(wait, with its pending rule), the factory's rule for missed fires, the budget:

| Choice | Reason |
| --- | --- |
| One record | The faults of the others come from state that is not one record: a run claimed and not done (#59302), a check by times and not by slots (#60083), deliveries without a key (#59703, #122028). In EverChat, the row's last slot (with its pending state) and, later, the `wake` message with its turn are each one transaction, and only one launch runs (src/store.ts:916-925). So a fire is in the log once or not at all, and a crash after it leaves a turn that continues at the next launch |
| Missed fires | Each row fires once at a launch, for its newest slot, and says how late and how many were missed. The model decides what to do; the person gets no burst (#73644) and no silent loss (#59302). A reminder fires late, with its lateness: the person wanted to be told |
| Short sleeps | Sleep at most 60 s, then compare slots, never one long timer: a suspend, a jump forward or back, gives one fire or none, never two (the run above) |
| Time zones | A zone for each row, an IANA name kept at the make (from the config file, else the host's). With routines hourly at most, the default `earlier` fits: a repeated time fires once. A skipped time fires an hour late (03:30, the run above); a test must pin that |
| K3, not K1 | The operator's "a user turn" is right in effect (it starts a turn), but the memory must say who wrote it. K3 costs a kind, a pending state on each row, and the hook in the turn loop (Options, J2) |
| A budget on fires | Rows and the hourly floor do not bound a chain of reminders; a count of fires does (Options, Limits) |
| Not T2 | EverChat is one process with no setup, and the OS cannot type into the running terminal |
| The factory | Its routines already type lines into the seat. The package stays off there unless the config file turns it on |

### How to test it

| Test | How |
| --- | --- |
| A fire at its slot | `TestClock.layer()`, the firer forked, `adjust` past the slot, the `wake` message in the log |
| A start after missed fires | A database with a row whose last slot is old; build the layer with the clock set late; one fire, its missed count. Not `setTime` on a running firer (the run above) |
| Daylight saving | Rows in `America/New_York` and `Europe/Berlin` over 2026-03-08, 2026-03-29, 2026-10-25 and 2026-11-01: the skipped and repeated times |
| A clock that moves back | The run above: no second fire |
| A crash in a fire | A store fault after the message, before the commit: no message and no slot; the next tick fires |
| A fire while a turn runs | A fake wire holds turn A; the wake comes due; a `user` message steers A; A ends: the wake starts turn B alone. Again with a restart before B |
| A chain of reminders | Each wake turn makes the next for one minute later: at most 6 fires in 60 minutes |
| The whole program | `tests/pipe.test.ts` cannot wait for a slot; give the process a clock through a test variable, or test the layer only |

## Limits

- A local fire needs a running EverChat: a sleeping laptop or a closed
  terminal fires nothing until the next launch (as Claude Code and Codex). To
  wake a sleeping machine needs the OS (`WakeSystem=`, privileges): not here.
- Exact time: up to the firer's tick (60 s) late, plus the turns that run
  (J2), plus the model's time to answer.
- No catch-up of each missed slot of a routine: only the newest, with a count.
- Effect's `Cron` and Vixie cron differ near daylight saving (03:30 against
  03:00; a repeated hour skipped for wildcards). EverChat follows Effect's.
- The model can still say "I set it" with no call: the `note` shows the truth.
- In the local use, nothing that the model can reach is safe from it: the
  schedule file and the database are its OS user's (Options, S2).
- Pipe mode ends with its input (src/main.ts:49-53): no later wake-up fires.
- Cron fields cannot say "every 2 weeks" or "the last Friday": `not proved`
  for Effect's `Cron`; an RRULE (as Codex) would be a library more.

## Questions for the operator

1. What kind is a fire in the log? Recommended: a new kind `wake`, logged
   only when it starts its own turn; the memory says the program wrote it.
2. A fire while a turn runs: steer it, or wait? Recommended: wait (J2), the
   fire pending in its row until the chat is idle.
3. Fires missed while EverChat was down? Recommended: one fire for each row,
   for its newest slot, with lateness and missed count; a reminder fires late.
4. The limits? Recommended: 20 active rows, routines hourly at most, 6 fires
   an hour and 24 a day for all wake-ups, a ceiling of steps and tokens for
   each wake turn, a row stopped after two failed or stopped turns in a row,
   `/wakeups off` for all; no expiry.
5. Which zone? Recommended: an IANA name on each row, from the config file, else the host's.
6. In the factory, on or off? Recommended: off unless the config file turns it on.
7. Routines that the person writes in a file? Recommended: not first (and not
   safe from the model); rows made through `/wakeups` or the model.

## Words

| Word | Meaning |
| --- | --- |
| wake-up | A row that starts a turn at a time: a reminder or a routine. |
| reminder | A wake-up with one time. It ends when it fires. |
| routine | A wake-up with a schedule of cron fields and a zone. It fires again and again. |
| slot | One time that a wake-up's schedule gives. |
| fire | To log a wake-up's message for one slot. Also the noun. |
| missed | Said of a slot that passed with no fire, because EverChat did not run. |
| firer | The fiber that reads the wake-ups and fires the due ones. |
| `wake` | The kind of a fire's message (proposed). |
