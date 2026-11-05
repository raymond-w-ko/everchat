# Upstream issues and PRs

A catalogue of every issue and pull request on upstream
([VictorTaelin/uniichat](https://github.com/VictorTaelin/uniichat)), with a
recommendation for each: should EverChat take it?

Snapshot: 2026-11-05. 26 issues (7 open, 19 closed) and 21 PRs (1 open,
20 closed, none merged).

## How to read this

Facts that apply to every item:

- Upstream's only commit is `0500bf6` (2026-10-19 16:45 UTC). It is our base.
  Every issue and PR is newer than it, and no PR was merged. So nothing below
  is in upstream's code. Each item is judged against our current tree.
- One contributor, arteeh, wrote 25 of the 26 issues and 20 of the 21 PRs.
  arteeh closed their own PRs on 2026-10-22 with the note "upstream uniichat
  isn't maintained anymore ... Development continues on the fork". That fork is
  [arteeh/uniichat](https://github.com/arteeh/uniichat). Its branch
  `release/arteeh` merges these PRs. arteeh closed their own issues on
  2026-10-26 with no comment. So "closed" here almost never means "fixed" or
  "rejected by upstream".
- PR file names below use our paths (`src/server.ts`, not `Server.ts`). A port
  also needs our renames ("Unii" to "EverChat", kind `"unii"` to `"everchat"`,
  `UNII_*` to `EVERCHAT_*`) and a fresh `just web`, never the PR's `web/app.js`.
- Line references (`file:line`) point at our tree at the time of the snapshot.

Recommendation labels:

| Label | Meaning |
|---|---|
| **Apply** | A real bug in our tree, and a sound fix. Take it. |
| **Apply with changes** | Take it, with the changes listed. |
| **Fix differently** | The bug is real, but this PR is not the right fix. |
| **Recommend** | A feature that fills a big gap. Worth porting. |
| **Neutral** | A feature with no strong reason either way. This is the default for features. |
| **Skip** | Not a bug, not applicable to our fork, or the risk is out of proportion. |

Per AGENTS.md, every fix we take comes with a test that fails without the fix.

## Top actions

In priority order:

1. **PR #37** (Apply with changes). Give compactions their own system prompt.
   This is the one correctness fix to the core algorithm. A turn can be mistaken
   for a compaction, and the bad reply is then logged forever.
2. **Two listener leaks, from PR #29** (Apply, as small separate fixes).
   `Machine.nap` (`src/machine.ts:300-307`) and `Agent.yielded`
   (`src/agent.ts:316-318`) leave abort listeners attached.
3. **PR #22** (Apply with changes). Numbered lists and sub-lists render wrong
   (#16).
4. **PR #24** (Apply). The typed line is hidden on Firefox for Android (#14).
5. **PR #32** (Recommend, with changes). Backups and restore (#8). Today an
   endless chat, which is the only memory, has no backup and no restore.
6. **PR #39** (Recommend, with changes). Outside MCP servers (#19). An agent
   harness cannot add tools today.
7. **Issue #15** (Fix differently). Subagent tabs vanish during a long usage
   limit. The cause is the retry limit, not the tabs.
8. **To check:** the OpenAI `error` stream event unwrap (from PR #33,
   `src/openai.ts:116`), and failing fast on `insufficient_quota` (from PRs #29
   and #33).

## Summary table

| # | Kind | Title | State | Recommendation |
|---|---|---|---|---|
| 1 | issue | Repo description and URL | open | Skip |
| 2 | issue | More models / Local llm? | open | Neutral |
| 3 | issue | Per-subagent model | closed | Neutral (see #25) |
| 4 | issue | openai-sub vendor (ChatGPT subscription) | closed | Neutral, leaning Skip (see #38) |
| 5 | issue | Resume automatically after a usage limit resets | closed | Neutral (see #29) |
| 6 | issue | Vendor fallback | closed | Neutral (see #33) |
| 7 | issue | Scheduled prompts | closed | Neutral (see #34) |
| 8 | issue | Memory backups | closed | **Recommend** (see #32) |
| 9 | issue | Encrypt API keys at rest | closed | Neutral (see #28) |
| 10 | issue | Settings in the web UI | closed | Neutral (see #36) |
| 11 | issue | Dropdowns for model, effort and speed | closed | Neutral (see #26) |
| 12 | issue | Native Windows version | closed | Neutral (see #42) |
| 13 | issue | `unii serve` 1.0.138 serves an install.sh for 1.0.137 | open | Skip |
| 14 | issue | Firefox for Android: typed text hidden | open | **Apply** #24 |
| 15 | issue | Subagent tabs disappear while a usage limit is hit | open | **Fix differently** |
| 16 | issue | Numbered lists render wrong | open | **Apply with changes** #22 |
| 17 | issue | Configurable system prompt / SOUL.md | closed | Neutral (see #27) |
| 18 | issue | claude-sub vendor via the Claude Agent SDK | closed | Neutral (see #46) |
| 19 | issue | MCP servers | closed | **Recommend** (see #39) |
| 20 | issue | Skills | closed | Neutral (see #41) |
| 21 | issue | Web UI: button to jump back to my last message | closed | Neutral (see #23) |
| 22 | PR | Fix numbered lists and sub-lists (#16) | closed | **Apply with changes** |
| 23 | PR | Web: button to jump back to my message (#21) | closed | Neutral |
| 24 | PR | Web: keep the typed line above the keyboard on Firefox for Android (#14) | closed | **Apply** |
| 25 | PR | spawn: optional per-subagent model (#3) | closed | Neutral |
| 26 | PR | Web: pick bar knobs open a menu of all options (#11) | closed | Neutral |
| 27 | PR | Per-user SOUL.md and an owner-set base prompt (#17) | closed | Neutral |
| 28 | PR | Encrypt API keys at rest (#9) | closed | Skip |
| 29 | PR | Resume automatically after a usage limit resets | closed | Neutral; **Apply** its two leak fixes |
| 30 | issue | Make the web UI a PWA: install and web push | closed | Neutral (see #35) |
| 31 | issue | Subagent tabs can't be scrolled when there are many | closed | Skip |
| 32 | PR | Memory backups: scheduled snapshots and restore (#8) | closed | **Recommend**, with changes |
| 33 | PR | Vendor fallback (#6) | closed | Neutral; check its error-unwrap fix |
| 34 | PR | Scheduled prompts: a schedule tool, once or by cron (#7) | closed | Neutral |
| 35 | PR | Installable web app and Web Push notifications (#30) | closed | Neutral |
| 36 | PR | Settings page: the owner edits config and keys (#10) | closed | Skip |
| 37 | PR | Compactions get their own system prompt | **open** | **Apply with changes** |
| 38 | PR | openai-sub vendor: run on a ChatGPT plan (#4) | closed | Skip |
| 39 | PR | MCP servers (#19) | closed | **Recommend**, with changes |
| 40 | issue | Pretty /tree view | closed | Neutral (see #43) |
| 41 | PR | Agent Skills from open devices (#20) | closed | Neutral |
| 42 | PR | Native Windows device: shell tool runs PowerShell (#12) | closed | Neutral |
| 43 | PR | /tree as a bracket, matching the main chat's look (#40) | closed | Skip as written |
| 44 | issue | Agents can't view image files on disk | open | Neutral (see #47) |
| 45 | issue | Agents can't view video files | closed | Skip for now |
| 46 | PR | claude-sub: a Claude plan through the Claude Agent SDK | closed | Skip for now |
| 47 | PR | Agents can view image and video files (#44, #45) | closed | Neutral; image part is the piece to take |

## Core algorithm

### PR #37: Compactions get their own system prompt

- State: **open**. Author tinqr, 2026-10-20. No comments, no linked issue.
- Type: bug fix to the core prompt.
- Problem: turns and compactions share one system prompt (`src/prompt.txt`).
  A compaction is a call that writes a summary line for the tree. Only the
  call's last line (`Turn:` or `Compaction:`) says which job it is. On Sonnet
  5.5 a turn sometimes replied with a summary line or with `<input>` tags.
  Because the chat is the memory, that bad reply is logged forever and
  summarized into the tree. The PR reports replays: 3/10 and 9/10 wrong
  before, 0/10 after.
- In our tree: the setup is the same. `src/prompt.txt:1-3` says "Each call to
  you is a turn or a compaction", and `src/prompt.txt:57-96` holds the
  compaction rules. Our own code already records this failure for one case:
  `src/server.ts:171-173` gives the goal check its own prompt because the
  shared one "made the model summarize the chat instead of answering". We have
  not reproduced the turn failure ourselves. It depends on the model.
- Prompt cache: no loss. A compaction never reads the turns' cache entry today.
  Compactions run on `config.COMPACTOR` (default `haiku-5.5`,
  `src/config.ts:35`, `src/memory.ts:789`), and the cache is per model. They
  also get no tools (`server: ""`, `src/server.ts:338-341`), and tools come
  before the system prompt in the request. So the two prefixes already differ.
- Divergence from the design doc: `docs/references/optchat.md` (sections 4 and
  5, and mistake #6) says compactions must share the turns' system prompt to
  share the cache. The code already made that claim false. Per AGENTS.md the
  code is canonical, so we record the divergence and the reason.
- Change: new `src/compact.txt`; `src/prompt.txt` (-43); `src/server.ts`
  (`share(chat, prompt = MASTER)`, and `Memory.load` gets the compaction
  prompt); `src/tools.ts` (a `COMPACT` export); `src/memory.ts` (comments);
  `tests/cache.test.ts`. +96/-60. No test fails without the fix.
- Recommendation: **Apply with changes.**
  - Add a wiring test that fails today: a compaction request carries the
    compaction prompt, and the turn prompt has no compaction rules.
  - Keep one copy of the "# The view" text, shared by both prompts, so they
    cannot drift.
  - Fix the stale comments (`src/memory.ts:10-11, 85, 110-111`,
    `src/server.ts:169-173`, `src/tools.ts:120`).
  - Write down the divergence from optchat.md and its reason.
  - Optional: take the PR's clearer turn head, `Turn (not a compaction): ...`.

## Bugs and bug fixes

### Issue #13: `unii serve` 1.0.138 serves an install.sh for 1.0.137

- State: open. Author arteeh. No reply.
- Type: bug report about upstream's release process.
- Summary: released binaries carried the previous version's `install.sh`. The
  likely cause is a release step that builds before it stamps the version. That
  step is not in the public repo.
- In our tree: not applicable. `web/install.sh` is a stub, and we have no
  release step. `src/term.ts` still holds upstream's `VERSION = "1.0.138"`.
- Recommendation: **Skip.** Remember it when we ship releases: stamp the version
  before compiling, or let the server write the installer from `VERSION`.

### Issue #14 and PR #24: Firefox for Android hides the typed text

- State: issue open; PR closed by arteeh on 2026-10-22, not merged.
- Type: bug report and bug fix (web UI).
- Problem: on Firefox for Android, the keyboard and the address bar cover the
  lines of a multi-line draft. Chrome works.
- In our tree: still present (not tested on a device). The code matches
  upstream at every point the fix touches: `web/index.html:5` has no
  `interactive-widget`, `web/src/main.ts:249` only redraws on a
  `visualViewport` resize, and `web/src/main.ts:214-215` sizes the box even
  while it is hidden.
- Change (PR #24): adds `interactive-widget=resizes-content` to the viewport
  tag; on a `visualViewport` resize, scrolls the box to its last line when the
  caret is at the end; skips sizing a hidden box. `web/index.html` +1/-1,
  `web/src/main.ts` +12/-4. No automated test; tested by hand on a phone and
  with Playwright emulation. Safari and iOS ignore the tag. Chrome on Android
  will also reflow when the keyboard opens.
- Recommendation: **Apply.** Small, low risk, and checked on a real phone. A
  browser viewport fix has no practical unit test, so record it as checked by
  hand.

### Issue #15: subagent tabs disappear while a usage limit is hit

- State: open. Author arteeh. Related: #5 and PR #29.
- Type: bug report.
- Problem: when the vendor's usage limit runs out, subagent calls fail and their
  tabs vanish. A tab comes back only when that agent gets a message.
- In our tree: still present, confirmed in code.
  - A 429 is `busy`. A call retries `TRIES = 8` times (`src/agent.ts:116`) with
    a doubling wait (`src/agent.ts:252-264`), about 4 minutes in all. Then it
    ends as `down`.
  - `src/tools.ts:563-564` then sets `agent.call = null`.
  - Tabs come from `Tools.working`, which keeps only agents whose
    `call !== null` (`src/tools.ts:651-652`). So the tab disappears.
- Recommendation: **Fix differently.** The cause is that the agent gives up
  during a long usage limit, not the tab display. Decide this together with #5
  and PR #29. The fix needs a test: an agent survives a 429 that outlasts the
  retries, and its tab stays.

### Issue #16 and PR #22: numbered lists render wrong

- State: issue open; PR closed by arteeh on 2026-10-22, not merged.
- Type: bug report and bug fix.
- Problem, confirmed by running `md_parse` and `block_html` on our tree:
  - `1. a`, blank, `2. b`, blank, `3. c` becomes three lists of one item each.
  - `4. d` / `5. e` renders with no `start`, so it counts from 1.
  - A sub-list under an item is flattened into the item's text.
  - An indented paragraph ends the list.
  - `In 2026 we` / `2026. was` turns "was" into a list item.
  - Cause: `LIST`/`MORE` and the list branch in `src/md.ts:58-59, 254-265`;
    `src/paint.ts:285` and `web/src/html.ts:192-195` always count from 1.
- Change (PR #22): rewrites list parsing to follow GFM. Items hold their own
  blocks, so sub-lists and paragraphs nest (capped at 16 levels). Lists keep a
  start number and a tight or loose flag. `src/md.ts` +99/-29, `src/paint.ts`
  +7/-5, `web/src/html.ts` +9/-2, `web/style.css` +1, `src/md.test.ts` +26.
  Tests cover the issue's cases in both views and hostile input (2000 nested
  levels, 10k markers, 1M blank lines). It changes the `Md.Block` `List` type,
  and updates both of its users. Rendering only: no memory, view, or cache
  logic.
- Recommendation: **Apply with changes.** Port it with our names (the test's
  `"unii"` kind becomes `"everchat"`, and the import paths change), rebuild with
  `just web`, and check that each new test fails on our tree first.

### Issue #31: subagent tabs can't be scrolled when there are many

- State: closed by its author 3 minutes after opening it. Shift+wheel and touch
  drag both scroll the tabs.
- In our tree: not a bug. `#tabs` has `overflow-x: auto` (`web/style.css:141`).
- Recommendation: **Skip.** Optional polish: map a plain vertical wheel to a
  sideways scroll.

### Issues #44 and #45, and PR #47: agents can view image and video files

- State: #44 open; #45 closed by its author; PR #47 closed by arteeh on
  2026-10-22, not merged.
- Type: feature requests and a feature.
- In our tree: `read` returns text only and refuses a binary file as "A binary
  file" (`src/machine.ts:238-239`). The image plumbing already exists: tool
  results carry images (`src/agent.ts:45`, `src/tools.ts:326`), and
  `src/memory.ts:492-507` already scales images. There is no video tool.
- Change (PR #47): two features in one PR, +318/-18.
  - Image `read`: checks the first 12 bytes, decodes with `Bun.Image`, scales to
    1568 px, steps JPEG quality down to at most 1 MB. Tested.
  - A `view_video` tool: about 190 lines of ffprobe and ffmpeg logic that build
    one grid image of frames. Its tests skip when ffmpeg is missing.
  - It changes the system prompt and the tool list, so the cache is lost once
    on deploy. It does not touch memory or summary logic.
  - Risk: image `read` reads the whole file before it checks the size.
- Recommendation: **Neutral** for both features. If we take one, take image
  `read` alone (small, tested, useful for screenshots an agent makes), and
  check the file size before reading. Leave `view_video` (#45) until we want
  it, and review it on its own.

## Models, vendors, and the model-call runtime

### Issue #2: More models / Local llm?

- State: open. Author seomwan. No replies.
- In our tree: not possible today. Vendors are fixed (`src/askai.ts:41`,
  `src/pick.ts:40`), models are a fixed list (`src/pick.ts:42-55`), and the
  endpoints are hardcoded (`src/openai.ts:219`, `src/anthropic.ts:304`). The
  OpenAI wire also sends fields only OpenAI accepts, such as
  `prompt_cache_breakpoint` (`src/openai.ts:55-64`).
- Recommendation: **Neutral.** A base-URL setting is cheap, but a real local
  vendor needs its own wire, cache rules, and zero prices.

### Issue #3 and PR #25: per-subagent model

- State: both closed by arteeh, not merged.
- In our tree: `spawn` takes `tasks` and `effort` only (`src/tools.ts:200,
  360-365`). All subagents run on `config.AGENTS`, else the chat's pick
  (`src/tools.ts:584`).
- Change (PR #25): an optional `model` on `spawn`, saved in the agent's first
  note so it survives a restart. About +66/-19, one test. It picks the first
  vendor that offers the label, not the chat's own vendor as the issue asked
  (the fork fixed this later, in commit 7daf264). A different model cannot read
  the chat's cached prefix.
- Recommendation: **Neutral.** The `agents` setting already covers cheap
  subagents. If we take it, prefer the chat's own vendor.

### Issue #4 and PR #38: openai-sub vendor (ChatGPT plan)

- State: both closed by arteeh, not merged.
- Change (PR #38): a new `src/chatgpt.ts` that signs in with Codex CLI's own
  OAuth client ID and calls the internal endpoint
  `chatgpt.com/backend-api/codex/responses`. +977/-105, with tests. It sends no
  cache breakpoints, so our cache design does not apply.
- Recommendation: **Skip.** It borrows another app's OAuth client and an
  undocumented endpoint. The account risk and fragility are out of proportion
  to the gain.

### Issue #5 and PR #29: resume after a usage limit resets

- State: both closed by arteeh, not merged. PR #29 also claims to fix #15.
- In our tree: a 429 retries 8 times, about 4 minutes, then the turn ends
  (`src/agent.ts:116, 262-265, 409-412`). Only summary calls retry forever,
  every 60 s (`src/askai.ts:140, 170-172`). No code reads the vendors'
  rate-limit reset headers. OpenAI's `insufficient_quota` (credit gone) also
  goes through the 8 useless retries.
- Change (PR #29): a new `limit` stop. A usage-limit 429 waits for the reset the
  vendor gives, or a doubling wait up to 30 minutes, with no end. A long wait
  "parks" the call and the UI shows it. A message, a stop, or `/halt` wakes it.
  +549/-62, with broad tests. It touches the deploy handoff in `src/server.ts`
  and `Memory.build`. A call parked for hours resumes with a cold cache.
- It also contains two real bug fixes, both present in our tree and confirmed:
  - `Machine.nap` (`src/machine.ts:300-307`) adds an `abort` listener and never
    removes it when the timer fires first. The summary retry loop calls it every
    60 s on the same long-lived signal (`src/askai.ts:172`), so listeners pile
    up during an outage.
  - `Agent.yielded` (`src/agent.ts:316-318`) adds an `abort` listener for each
    wait. `{ once: true }` removes it only if the signal aborts, so each wait
    that ends normally leaves one behind.
- Recommendation: **Neutral** for the feature (on API keys, a 429 is mostly a
  short per-minute limit). **Apply** the two listener fixes on their own, each
  with a test that counts listeners. Consider treating `insufficient_quota` as
  `down` at once.

### Issue #6 and PR #33: vendor fallback

- State: both closed by arteeh, not merged.
- Change (PR #33): named `profiles` (ranked model lists) that `pick`,
  `compactor`, and `agents` can name. A call moves to the next pick when its
  vendor is out (busy past its retries, out of credit, or a 401/402/403/404),
  and probes the first again after 60 s. A turn that already ran a tool is not
  redone on another vendor. +638/-114, 8 tests.
- Core effect: a switch moves the whole view to a vendor with a cold cache. A
  summary written on the fallback model lasts forever in the tree.
- Side fix: OpenAI's `error` stream event is unwrapped (`ev.error ?? ev`). Ours
  stores the whole event (`src/openai.ts:116`). Not yet checked whether we lose
  the error message.
- Recommendation: **Neutral.** Sound but big. Check the error unwrap on its own.

### Issue #18 and PR #46: claude-sub vendor via the Claude Agent SDK

- State: both closed by arteeh, not merged.
- Change (PR #46): a new `src/claudesub.ts` that starts a Claude Code process per
  call through `@anthropic-ai/claude-agent-sdk`. +1381/-61, with tests.
  - Claude Code runs the tool loop, not `src/agent.ts`, so our retry, room, and
    single-flight logic does not apply.
  - Our cache marks are dropped, so caching of the view prefix is not
    guaranteed.
  - The binary grows from 93 MB to 384 MB.
  - Anthropic's policy on this use is not settled. The PR itself says it is
    unclear whether this counts as "offering claude.ai login".
- Recommendation: **Skip for now.** It changes how calls run and how caching
  works, which are core to our design. Start from its design notes if we ever
  want plan-based use.

## Operations, settings, security, and platform

### Issue #1: repo description and URL

- State: open. Author PWS-DevRel. About upstream's GitHub "About" box.
- Recommendation: **Skip.** We can fill in our own About box at any time.

### Issue #7 and PR #34: scheduled prompts

- State: both closed by arteeh, not merged.
- In our tree: no timer of any kind.
- Change (PR #34): `schedule`, `schedules`, and `unschedule` tools; once or by
  5-field cron in an IANA time zone; each firing logged once as a `work`
  message. Its own cron and daylight-saving engine (`src/timer.ts`, +287).
  +883/-31, with tests. It adds a field to `view.json` and changes the prompt
  and tool list (one cache rewrite). Admitted bugs: a crash between logging the
  timer message and starting its turn leaves it unanswered, and on the
  fall-back night a schedule can fire twice.
- Recommendation: **Neutral.** It fits the design, but it is a large surface for
  a need we have not stated.

### Issue #8 and PR #32: memory backups

- State: both closed by arteeh, not merged.
- In our tree: the README says to back up the chat folder, but the server never
  does it. `/export` writes a one-way JSON dump (`src/server.ts:1507-1510`), and
  nothing can load it back.
- Change (PR #32): `backup`, `backup_every`, `backup_keep`, and `backup_run`
  settings; a `tar.gz` snapshot of each changed chat; failures noted in the chat
  and retried hourly; restore from an upload, checked against an allow-list of
  file names, then swapped in by rename with crash recovery. +765/-75, 10 tests.
  It does not change view or cache logic. It hardens `image_file` to real image
  types of the chat's own, which matters once archives can be restored.
- Gaps the author admits: the upload is held whole in memory, a gzip bomb is not
  bounded, and a snapshot can race a restore of the same user. The restore
  format (`tar.gz`) differs from `/export` (JSON).
- Recommendation: **Recommend**, with changes. This fills a big gap: the chat is
  the only memory, and today it has no backup and no restore. Bound the
  unpacked size and file count, stream the upload to disk, and pick one format.

### Issue #9 and PR #28: encrypt API keys at rest

- State: both closed by arteeh. PR #28 was closed as "sloppy, and I don't know
  what the right approach is".
- In our tree: keys come from the environment and are deleted from
  `process.env` (`src/config.ts:83-87`), but they are put back into each
  worker's environment (`src/config.ts:91-94`, `src/server.ts:2118`). A process
  of the same OS user can read them from `/proc/<pid>/environ`. This matters
  only when a device runs on the server machine as the same user.
- Change (PR #28): AES-256-GCM sealing with an scrypt passphrase. +1024/-26. The
  crypto is sound, but the passphrase must still live on the same machine.
- Recommendation: **Skip** the PR; **Neutral** on the issue. Cheaper fixes:
  `*_FILE` key variables (also covers systemd credentials), running the server
  as its own OS user, and handing keys to workers over stdin instead of the
  environment.

### Issue #10 and PR #36: settings in the web UI

- State: both closed by arteeh, not merged.
- Change (PR #36): an `owner` role and a `/settings` page that writes
  `config.json` and a plain-text `keys.json`. +1479/-124. It rewrites
  `src/config.ts` into mutable exports.
- Risks: keys in plain text (against #9); `site` is editable from the web, so a
  hijacked owner session could redirect sign-in emails; mutable config can change
  a running chat's model and break its cache.
- Recommendation: **Skip.** Too much risk and size for a fork with one operator.

### Issue #11 and PR #26: dropdowns for model, effort, and speed

- State: both closed by arteeh, not merged.
- In our tree: each knob steps one option per click (`web/src/html.ts:109-110`,
  `src/view.ts:542-554`).
- Change (PR #26): each knob opens a menu of all options, with keyboard support.
  +230/-118, one test. UI only. It deletes the price and effort hints, although
  its description says the menu shows prices.
- Recommendation: **Neutral.** If we take it, keep the price and effort hints.

### Issue #12 and PR #42: native Windows device

- State: both closed by arteeh, not merged.
- Change (PR #42): on Windows the shell tool runs PowerShell, and stop kills the
  process tree with `taskkill`. +65/-31, no tests. Low risk: almost everything
  sits behind a Windows check. Its `update_run` hunk no longer applies (we
  removed `update`).
- Recommendation: **Neutral.** If we take it, add tests for the Windows branches.

### Issue #17 and PR #27: configurable system prompt / SOUL.md

- State: both closed by arteeh, not merged.
- In our tree: the base prompt is built in (`src/tools.ts:33, 121`). The
  server-wide `rules` file is added to every call (`src/tools.ts:248-250,
  267-269`). On a one-user server, `rules` already does what SOUL.md would.
- Change (PR #27): a per-user `SOUL.md` (16 KB max), and an owner-set `base.md`
  that replaces `prompt.txt` for every user. +226/-24.
- Risk: `prompt.txt` holds the view and compaction protocol. An owner who
  replaces it can silently break compaction for every user.
- Recommendation: **Neutral.** If we ever host many users, take only SOUL.md and
  leave out the base-prompt override.

## Extensibility and web UI

### Issue #19 and PR #39: MCP servers

- State: both closed by arteeh, not merged.
- In our tree: our own tools are served over MCP (`src/tools.ts:3, 271`), but
  there is no way to add an outside MCP server. The only way to add a capability
  is a shell command on a device.
- Change (PR #39): an `mcp` setting in the shape of Claude's `mcpServers` (stdio
  or HTTP), servers on the server or on a device, tools named
  `<server>__<tool>`, a per-chat on/off list. Its own client in `src/mcp.ts`
  (+700), 15 tests. +1367/-22.
- Cache risks:
  - A device-bound server's tools are dropped while its device is closed or
    after a failed start. That changes the tool list, which starts every cached
    prefix, and forces a full rewrite. It breaks our rule
    (`src/tools.ts:177-179`) that devices joining or leaving change only the
    call's tail.
  - The per-chat toggle also breaks the cache, which is acceptable because the
    user chooses it.
- Recommendation: **Recommend**, with changes. A harness with a fixed tool set is
  a big gap. When porting, always list a server's tools and fail the call when
  it is not reachable, so the tool list stays stable. Add a cache test for a
  device opening and closing.

### Issue #20 and PR #41: Agent Skills

- State: both closed by arteeh, not merged.
- In our tree: none. A rule line such as "read ~/x/SKILL.md when doing Y" works
  as a stand-in today.
- Change (PR #41): scans `~/.agents/skills` on devices and adds a `skill` tool.
  +130/-13, no tests. Cache-safe (the list goes in the tail). But it runs a job
  on every open device before every turn, waiting up to 3 s.
- Recommendation: **Neutral.** If we take it, add tests, and read skills when a
  device joins instead of before each turn.

### Issue #21 and PR #23: jump back to my last message

- State: both closed by arteeh, not merged.
- Change (PR #23): a button that scrolls to the user's latest message, then the
  one before. It also adds an unmentioned "jump to bottom" button. About 60
  lines of source, no tests. UI only.
- Recommendation: **Neutral.** Low risk. Decide on the extra button on purpose.

### Issue #30 and PR #35: installable web app and Web Push

- State: both closed by arteeh, not merged.
- In our tree: no manifest or service worker. Notifications go only through
  Apple push, which is off unless `apns` is set (`src/config.ts:43`). So our
  server sends no notifications today.
- Change (PR #35): manifest, service worker, and Web Push (RFC 8291 and 8292,
  `node:crypto` only), a `web_pushes` table, an SSRF check with an admitted
  DNS-rebinding gap. +908/-70, with tests against the RFC vector. It bundles an
  unrelated sign-in change.
- Recommendation: **Neutral.** Worth it if we want notifications without an
  Apple key. Review the bundled sign-in change separately.

### Issue #40 and PR #43: pretty /tree view

- State: both closed by arteeh, not merged.
- In our tree: `/tree` is a plain monospace debug page (`src/memory.ts:1116-1150`).
- Change (PR #43): about 350 lines of browser JS inside a template string in
  `src/memory.ts`, plus a JSON route. +465/-35, no tests. Its legend says recent
  messages appear whole in the view, which is wrong (the view holds only summary
  lines).
- Recommendation: **Skip as written.** If we want it, build it in `web/src/` on a
  small JSON endpoint, not inside the core memory module.
