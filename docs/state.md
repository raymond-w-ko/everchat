# State inventory

This document lists every piece of state that the current code keeps. We
use it to design the SQLite schema of the rewrite.

In the new design, almost all state lives in one SQLite database. After a
crash or a restart, the program continues where it was. An install is one
executable, one database, and maybe one config file. The person edits the
config file by hand. The program only reads it.

The code read is `main` at `0d40a36`: `src/*.ts` and `web/src/*.ts`. The
branch at `/home/rko/src/everchat-sqlite` (commit `2a76264`) already moved
a chat's log into SQLite. Its `src/store.ts` has six tables: `msg`,
`node`, `act`, `state`, `agents`, `agent`. Each item below says where that
branch covers it ("sqlite branch").

## Terms

- **Chat dir**: one user's folder, `$EVERCHAT_DIR/users/<id>/`. The
  default `$EVERCHAT_DIR` is `~/.everchat` (`config.ts:17`). Today the
  server has one chat per signed-in user. The new design has one chat.
- **Message**: one entry of the log. A long text is logged as several
  messages in a row, called pages. A page with `more: true` continues in
  the next one.
- **Kind**: the type of a message: `user`, `ever` (the agent's reply),
  `tool` (a tool call), `echo` (its result), `work` (an agent's report),
  `note`. A `mind` (a thought) is shown but never logged
  (`askai.ts:39`).
- **Node**: one line of the summary tree. Node `(l, i)` covers the `2^l`
  messages from `i·2^l` on, in at most 512 bytes.
- **View**: the list of nodes that a model call sees, oldest first. There
  are two. The **chat view** is for turns. The **compaction view** (`seen`
  in the code) is for compactions.
- **Compaction**: a model call that writes one node.
- **Side**: the code splits compactions in two queues. Side 0 is the
  chat's. Side 1 is an import's.
- **Turn**: the agent's work on one user message, from the first model
  call to the last reply.
- **Pick**: the model a chat runs on: vendor, model, effort, speed
  (`pick.ts`).
- **Act**: a change that a client asks for (send a message, stop, set a
  goal). Each act has an id, so a client can send it again safely.
- **Agent**: a subagent or a computer task. It has a random name such as
  `FireAnt` and its own log.
- **Device**: a computer that has the `everchat` terminal open. The tools
  `shell`, `read`, `write`, and `edit` run on a device.
- **Job**: one tool call that runs on a device.
- **Single flight**: the rule in `askai.ts` that makes calls with the same
  prompt prefix wait for the first one, so the vendor writes its cache
  entry once.
- **Flush**: a write made durable on the disk (`disk.ts`).
- **Derived**: state that the program can rebuild from other state at
  start. It needs no table.
- **Drop**: state of the server, web, accounts, billing, or cloud parts.
  The single-process terminal design removes them.

## Overview

One line per item. The sections below give the details.

| # | Item | Scope | On a crash today | New design |
|---|------|-------|------------------|------------|
| 1 | Message log | chat | kept | table `msg` |
| 2 | Log indexes (`main.index`, `tree.index`) | chat | rebuilt | derived |
| 3 | Tree nodes | chat | kept | table `node` |
| 4 | Node text cache (`mem.nodes`) | chat | rebuilt | derived |
| 5 | Chat view | chat | kept (last save) | table `view_part` or state key |
| 6 | Compaction view | chat | kept (last save) | same as 5 |
| 7 | Build queue (`mem.ready`) | chat | rebuilt | derived |
| 8 | Running compactions and retries | chat | lost, asked again | derived |
| 9 | Side holds (`mem.hold`) | chat | import pause kept | `import` row; drop the rest |
| 10 | Act records | chat | kept | drop (or keep for hooks) |
| 11 | Goal | chat | kept | state key `goal` |
| 12 | Goal check in flight | chat | lost, run again | derived |
| 13 | Work list (`mem.work`) | chat | kept | tables `turn`, `agent` |
| 14 | Import run (`import.json`) | chat | kept (not flushed) | table `import` |
| 15 | Images | chat | kept | table `image` |
| 16 | Upload temp files (`up/`) | chat | gone | drop |
| 17 | Agent logs | agent | kept | table `agent_msg` |
| 18 | Agent identity (name, role, effort) | agent | kept as text | table `agent` |
| 19 | Eye (what the last call saw) | chat | rebuilt | derived |
| 20 | Prompt-cache single flight | global | lost, harmless | memory only |
| 21 | Busy rooms (`ROOMS`) | global | lost, harmless | memory only |
| 22 | Running turn | chat | lost; resumed by a note | table `turn` |
| 23 | Turn step history (`items`) | turn | lost | optional `turn_item` |
| 24 | Streaming output (`live`) | turn, agent | lost | optional draft row |
| 25 | Tool calls waiting for results | turn, agent | **lost, never logged** | table `tool_call` |
| 26 | Vendor retry state | call | lost | memory only |
| 27 | Usage of each request | call | never kept | optional `usage` |
| 28 | Agents at work | agent | partly lost | `agent` columns |
| 29 | Devices | global | rebuilt on reconnect | drop (one device) |
| 30 | Jobs | device | lost; terminal halts them | table `tool_call` |
| 31 | Shell processes | device | orphaned | `tool_call` columns |
| 32 | Work dirs | device | kept (files) | files; path in config |
| 33 | MCP tool server | global | rebuilt | drop (code mode) |
| 34 | Computer-use state | device | binary kept; held keys stuck | derived |
| 35 | After-turn command (`AFTER`) | global | not run | config (hooks) |
| 36 | `config.json` and env | global | read at start | config file |
| 37 | API keys | global | read at start | env or config, never db |
| 38 | Chat pick | chat | kept | state key `pick` |
| 39 | Rules file | global | read at each call | config (a path) |
| 40 | Terminal view cache | view | rebuilt | derived |
| 41 | Open and shut blocks, fold, tab | view | lost | optional `ui` |
| 42 | Unanswered acts (offline outbox) | view | lost | drop |
| 43 | Input draft and history | view | draft lost; history rebuilt | optional `ui`; derived |
| 44 | Attached images | view | lost | optional `ui` |
| 45 | Print progress | view | rebuilt | derived |
| 46 | Transient notes | chat | lost | log them, or drop |
| 47-58 | Server, web, accounts, billing, cloud | user, global | mixed | drop |
| 59 | Diagnostic logs | global | stderr only | table `log` |
| 60 | Process lock | global | socket file | SQLite lock |
| 61 | Durability (flush) | global | group commit | SQLite WAL |
| 62 | Temp files and caches | global | gone | derived |
| 63 | Versions | global | constants | `pragma user_version` |

## 1. Chat log and memory

### 1. Message log

- **Holds:** every message, forever. A record has `i`, `kind`, `text`,
  `size`, `date`, and optional `images`, `imported`, `line`, `more`,
  `act` (`memory.ts:64-70`).
- **Lives:** on disk, `<chat dir>/main/YYYY-MM-DD.jsonl`, one JSON line per
  page (`memory.ts:349-351`). A day file is the local date at write time
  (`memory.ts:375`).
- **Writes:** `Memory.push` (`memory.ts:430-441`) through `Memory.log`
  (`memory.ts:374-388`) and `Memory.append` (`memory.ts:391-401`). The
  callers are `Chat.push` (`server.ts:631-642`): the user's text
  (`Chat.text`, `server.ts:412-418`), the model's entries (`Chat.on`,
  `server.ts:645-671`), notes (`Chat.note`, `server.ts:626-628`), agent
  reports (`Chat.report`, `server.ts:713-726`), imports
  (`server.ts:781-790`), and the hello of a new chat
  (`server.ts:310-313`).
- **Reads:** `Memory.message` (`memory.ts:424-426`) for views, zoom,
  `Memory.whole` (`memory.ts:460-471`), the goal check
  (`server.ts:585-594`), `/export` (`memory.ts:1073-1114`), `/tree`
  (`memory.ts:1117-1151`), and the import's "done" scan
  (`server.ts:870-882`).
- **On a crash today:** kept. A process crash loses nothing, because the
  OS holds the write. A machine crash loses about the last flush
  (`disk.ts`). A line cut short is skipped and ended with a newline
  (`memory.ts:267-284`). Pages with `more` after the last whole page are
  dropped from the count (`memory.ts:209-212`). So a long message cut
  mid-upload is lost whole. The next message reuses its ids.
- **Scope:** per chat.
- **New design:** table `msg`. **sqlite branch:** `msg` covers it
  (`store.ts:74-77`). Columns match the record field for field.

### 2. Log indexes

- **Holds:** `main.index` gives each message's place by `i`.
  `tree.index` gives each node's place by slot `(2i+1)·2^l - 1`
  (`memory.ts:286-288`). A slot is 16 bytes: offset, day, length
  (`memory.ts:290-304`). `view.json` also keeps `main` and `tree`: how far
  each log is indexed (`memory.ts:91-98`).
- **Lives:** on disk, `<chat dir>/main.index`, `<chat dir>/tree.index`.
- **Writes:** `Memory.place` at each log write and at load
  (`memory.ts:249-263`). **Reads:** `Memory.read` (`memory.ts:307-315`).
- **On a crash today:** rebuilt. A missing index is made again from the
  day files (`memory.ts:251-253`).
- **Scope:** per chat.
- **New design:** derived. SQLite primary keys replace it. **sqlite
  branch:** gone.

### 3. Tree nodes

- **Holds:** each node built: `{l, i, text, size}`.
- **Lives:** on disk, `<chat dir>/tree/YYYY-MM-DD.jsonl`.
- **Writes:** `Memory.store` (`memory.ts:769-784`), after a compaction
  (`Memory.build`, `memory.ts:733-756`) or at once for a node whose source
  fits in 512 bytes (`Memory.pump`, `memory.ts:617-626`).
- **Reads:** `Memory.node` (`memory.ts:540-543`): views, zoom, merges, the
  web's `know` messages (`server.ts:1374-1379`).
- **On a crash today:** kept.
- **Scope:** per chat.
- **New design:** table `node`. **sqlite branch:** `node` covers it
  (`store.ts:78-81`).

### 4. Node text cache

- **Holds:** the text of each node in a view, and of the nodes above them
  (`mem.nodes`, `memory.ts:121`). Also `mem.sides`: the side of a node's
  last message (`memory.ts:128`, `memory.ts:608-613`), and `mem.fds`: up
  to 8 open files (`memory.ts:116`, `memory.ts:319-331`).
- **Lives:** in memory.
- **On a crash today:** rebuilt at load (`Memory.down`,
  `memory.ts:559-569`).
- **New design:** derived. **sqlite branch:** `mem.fds` became
  prepared statements (`store.ts:63`).

### 5. Chat view

- **Holds:** the parts `[l, i]` of the chat view, and `batch`: a merge
  batch is under way (`memory.ts:77`). Its byte size is derived. Its limit
  is the constant `HIGH`, 128,000 (`memory.ts:147`).
- **Lives:** on disk, `<chat dir>/view.json`, written whole then renamed
  (`Memory.save`, `memory.ts:239-245`). In memory as `mem.view`.
- **Writes:** `Memory.fit` saves it when its parts or batch flag change
  (`memory.ts:837-860`). Also each save of pick, goal, or work.
- **Reads:** `Memory.load` and `Memory.open` (`memory.ts:197-236`);
  `Memory.view` builds each call's blocks (`memory.ts:1009-1018`).
- **On a crash today:** kept as of the last save. Without `view.json`,
  the view is rebuilt from the highest nodes built
  (`memory.ts:231-236`). That rebuild is mistake 3 of
  `docs/references/optchat.md` ("Rebuilding the view ... at a restart.
  Keep it and save it.").
- **Scope:** per chat.
- **New design:** a table `view_part (view, pos, l, i)`, or a JSON state
  key. It must come back byte for byte. Otherwise the first call after a
  restart misses the vendor's prompt cache. **sqlite branch:** state key
  `view` (`store.ts:83`, sqlite `memory.ts:188`, `memory.ts:219-223`).

### 6. Compaction view

- **Holds:** the same shape as the chat view, with limit `SEEN`, 32,000
  (`memory.ts:148`). It ends at the first message not built of the sides
  that build (`memory.ts:840-842`).
- **Lives:** `view.json` key `seen`; `mem.seen` in memory.
- **Everything else:** as item 5. **sqlite branch:** inside state key
  `view`.

### 7. Build queue

- **Holds:** the nodes ready to build (both halves built), by side and
  level, sorted (`mem.ready`, `memory.ts:125`, `memory.ts:595-605`).
- **Lives:** in memory.
- **On a crash today:** rebuilt at load by walking the tree
  (`Memory.todo`, `memory.ts:215`, `memory.ts:667-674`).
- **New design:** derived. A query "nodes not built whose halves are"
  can replace the walk.

### 8. Running compactions and their retries

- **Holds:** `mem.busy`: nodes building, by slot, with their side
  (`memory.ts:127`). `mem.calls`: each running call and its node
  (`memory.ts:129`, `memory.ts:793-796`). Up to `JOBS` = 64 per side run
  at once (`memory.ts:143`). Inside `Memory.build`, the lines tried so far
  (up to `TRIES` = 5, the shortest kept) (`memory.ts:144`,
  `memory.ts:733-756`). In `AskAI.ask`, a patient call waits `AGAIN` = 60 s
  after each failed try (`askai.ts:140`, `askai.ts:166-181`).
- **Lives:** in memory.
- **On a crash today:** lost. At start, the same nodes are queued and
  asked again. A paid server pays twice. Nothing breaks.
- **New design:** derived. Do not store.

### 9. Side holds

- **Holds:** `mem.hold`: why each side is held, or `null`
  (`memory.ts:130`). `hold[0]` is never set by the free billing; only
  `Memory.settle` reads it (`memory.ts:966`). `hold[1]` starts as
  `"paused"` (`memory.ts:201`). An import sets it (`server.ts:781`,
  `server.ts:839`, `server.ts:943`, `memory.ts:661`).
- **Lives:** in memory. `hold[1]` is saved as `why` in `import.json`
  (`server.ts:828`).
- **New design:** the import pause goes in the `import` row. Drop
  `hold[0]` (billing).

### 10. Act records

- **Holds:** the ids of acts done, and their answers. An act is recorded
  as the `act` field of the last page it logs, or as a line of its own
  `{act, ans}` in the main log (`Chat.mark`, `server.ts:1315-1317`). A
  copy goes to the accounts db, table `acts` (`Cloud.act_put`,
  `cloud.ts:306-316`). An answer with words (a voice note's text) is kept
  7 days there (`cloud.ts:57`). In memory, `chat.acts` holds the acts
  running (`server.ts:102`).
- **Writes:** `Chat.act` (`server.ts:1204-1269`), `Chat.say`, `Chat.ingest`.
  At load, each record found past the saved index goes to `acted`
  (`memory.ts:292-296`).
- **Reads:** `Chat.apply` answers a repeated act from the record
  (`server.ts:1181-1194`).
- **On a crash today:** kept. But see item 61: the `acts` table's WAL is
  not flushed by `disk.ts`.
- **Scope:** per chat.
- **New design:** drop. Acts make network retries safe. A terminal in the
  same process does not retry over a network. Keep the idea only if the
  factory's commands or hooks need idempotent ids. **sqlite branch:**
  table `act` (`store.ts:82`), replayed from `state.view.acts`
  (sqlite `memory.ts:192`).

### 11. Goal

- **Holds:** the goal text set by `/goal`, or `null` (`mem.goal`,
  `memory.ts:119`).
- **Lives:** `view.json` key `goal`.
- **Writes:** the act `goal` (`server.ts:1227-1238`); cleared when met
  (`server.ts:610-613`) or by `/halt`.
- **Reads:** at each turn's end (`server.ts:576-579`).
- **On a crash today:** kept.
- **New design:** state key `goal`. **sqlite branch:** inside state key
  `view`.

### 12. Goal check in flight

- **Holds:** the running check call and its goal (`chat.check`,
  `server.ts:107`, `server.ts:601-618`).
- **Lives:** in memory.
- **On a crash today:** lost. The turn is busy during the check, so the
  work list has the turn. The resumed turn ends, and a new check runs.
- **New design:** derived.

### 13. Work list

- **Holds:** what runs: `"EverChat's turn"` (the constant `TURN`,
  `view.ts:196`) and the names of agents at work (`mem.work`,
  `memory.ts:120`).
- **Lives:** `view.json` key `work`.
- **Writes:** `Chat.change`, whenever it changes (`server.ts:1082-1088`).
- **Reads:** at start, `Chat.wake` opens each chat with work
  (`server.ts:957-965`). `Chat.resume` logs the note "The server
  restarted, cutting ...; nothing was lost: go on." It sends it as the
  turn's message, and tells it to each agent (`server.ts:969-976`).
- **On a crash today:** kept. It is the only record of a cut turn.
- **New design:** replace it with a `turn` row (item 22) and an agent
  status column (item 28). The `TURN` label is saved text today
  (`view.ts:192-196`); a table removes that trap. **sqlite branch:**
  inside state key `view`.

### 14. Import run

- **Holds:** the running import: messages `[a, b)`, `said` (messages
  sent, not notes), `spent` (USD), `why` (paused)
  (`server.ts:81-85`). Its progress (`micros`, `open`, `left`, `all`) is
  derived from the tree (`Chat.batch`, `server.ts:798-805`).
- **Lives:** on disk, `<chat dir>/import.json` (`server.ts:179`), written
  whole then renamed (`Chat.keep`, `server.ts:825-830`). In memory as
  `chat.batch`.
- **Writes:** `Chat.ingest` (`server.ts:761-794`), `Chat.progress`
  (`server.ts:914-924`), `Chat.go` (`server.ts:938-952`). Removed by
  `Chat.digest` (`server.ts:926-934`).
- **Reads:** `Chat.resumed` at open (`server.ts:833-841`); `Chat.wake`.
- **Related:** each imported message has `imported: true`. Each imported
  session starts with a `note` whose text names it (`import.ts:226`). The
  sessions done are derived by scanning the whole log
  (`Chat.done`, `server.ts:870-882`).
- **On a crash today:** kept, but `Chat.keep` never calls `Disk.wrote`,
  so a machine crash may lose it.
- **Scope:** per chat.
- **New design:** table `import (id, a, b, said, paused, started, ended)`.
  Keep `msg.imported`. Add an index or a table for "sessions imported, last
  date" so an import need not scan the log. **sqlite branch:** not
  covered; still `import.json`.

### 15. Images

- **Holds:** each image a message carries. The name is the first 16 hex
  digits of its SHA-256 and its type (`memory.ts:502`). A scaled JPEG copy,
  at most 1568 px, sits beside it as `<name>.jpg` (`memory.ts:503-510`).
- **Lives:** on disk, `<chat dir>/docs/images/`.
- **Writes:** `Memory.image_add` (`memory.ts:487-514`), from `Chat.say`
  (`server.ts:388-401`).
- **Reads:** `Memory.images` reads and base64-encodes them at every call
  (`memory.ts:522-529`); `/image/<name>` (`server.ts:1527-1529`);
  `/export`; zoom (`tools.ts:354`).
- **On a crash today:** kept (flushed).
- **Scope:** per chat.
- **New design:** table `image (name primary key, kind, bytes blob, fit
  blob)`. That keeps "one db". **sqlite branch:** not covered; still files.

### 16. Upload temp files

- **Holds:** the body of a post (a message with images, an import, a voice
  note) while it is read.
- **Lives:** `<chat dir>/up/<uuid>`, unlinked at once after open
  (`server.ts:1288-1291`).
- **On a crash today:** gone. Only the empty `up/` dir stays.
- **New design:** drop.

### 17. Agent logs

- **Holds:** each agent's own log, records shaped as messages
  (`Memory.agent_push`, `memory.ts:1178-1184`). `mem.agents` counts their
  lengths (`memory.ts:122`).
- **Lives:** on disk, `<chat dir>/docs/agent/<Name>.jsonl`
  (`memory.ts:174`, `memory.ts:1157-1175`).
- **Writes:** `Chat.push` with an agent (`server.ts:632-636`), from the
  agent's model events, `Tools.start` (`tools.ts:530-539`), and
  `Tools.tell` (`tools.ts:510-528`).
- **Reads:** each agent call sends its whole log (`Tools.ask`,
  `tools.ts:581-599`); `zoom("Name")` (`tools.ts:351-353`); the web's agent
  page (`server.ts:1165-1172`); `/export`.
- **On a crash today:** kept. A line cut short is skipped
  (`memory.ts:353-359`).
- **Scope:** per agent.
- **New design:** table `agent_msg`. **sqlite branch:** table `agent`
  (`store.ts:85-89`).

### 18. Agent identity

- **Holds:** an agent's name, role (`sub` or `hands`), effort, and device.
  The name is random, "AdjNoun" (`names.ts:369-373`). It is reserved by
  creating its file with flag `wx` (`memory.ts:1162-1175`). The role,
  effort, and device are encoded only in the text of the log's first
  `note`: `"subagent"`, `"subagent at effort high"`, or `"computer task on
  <device>"` (`tools.ts:172-176`, `tools.ts:535`). `Tools.agent` parses
  that text back (`tools.ts:541-552`).
- **On a crash today:** kept, as text.
- **New design:** table `agent (name primary key, role, effort, device,
  status, created)`. **sqlite branch:** table `agents` holds the name only
  (`store.ts:84`).

### 19. Eye

- **Holds:** what the agent saw at its last call: the view's parts before
  message `from`, and `from` (`chat.eye`, `server.ts:73-75`,
  `server.ts:1319-1322`). Views draw the chat from it.
- **Lives:** in memory.
- **On a crash today:** rebuilt at open from the view and the last user
  message (`server.ts:314`, `memory.ts:1050-1054`).
- **New design:** derived.

## 2. Model calls and cache

### 20. Prompt-cache single flight

- **Holds:** `CACHE`: for each prompt-prefix key, until when the vendor
  holds it, and, while a leader writes it, a promise to wait on
  (`askai.ts:97-99`, `askai.ts:149`). A key hashes the vendor, model,
  effort, speed, system prompt, web-search flag, and each block up to the
  last marked one (`askai.ts:218-223`). `TTL` is 5 min for Anthropic and
  30 min for OpenAI (`askai.ts:143-146`).
- **Writes and reads:** `AskAI.wait` and `AskAI.lead`
  (`askai.ts:227-279`), right before each request is sent
  (`agent.ts:346`).
- **On a crash today:** lost. That is harmless: the first call leads, and
  the vendor's own cache may still be warm.
- **Scope:** global (one process, all chats).
- **New design:** memory only. Keep the rule (AGENTS.md says it is
  EverChat's own idea). What a restart must keep for cache hits is the
  bytes: the system prompt, the saved views (items 5, 6), and the block
  grouping (`BLOCK` = 4 lines, `memory.ts:149`).

### 21. Busy rooms

- **Holds:** `ROOMS`: by model (and by model plus import), how many
  requests are retrying and who waits (`agent.ts:64-69`, `agent.ts:130`,
  `agent.ts:275-321`). `READING`: requests whose answers are still read
  (`agent.ts:135`), used by the handover (`server.ts:2030`).
- **Lives:** in memory.
- **New design:** memory only. Drop `READING` with the handover.

### 22. Running turn

- **Holds:** `chat.busy`, `call` (the model call), `model` (picked at the
  call's start), `asked` (a request is out), `open` (tool calls without
  results), `sent` and `wait` (messages taken and waiting), `halt` (the
  stop signal) (`server.ts:87-122`). Moved as `Turn` in a handover
  (`server.ts:129-130`).
- **Writes:** `Chat.take`, `Chat.turn`, `Chat.call`, `Chat.ended`
  (`server.ts:484-581`).
- **On a crash today:** lost. The work list (item 13) says a turn ran. At
  start, a note is logged and sent as a new turn. That new turn's text is
  only the note: `Memory.whole` starts at the note's id. So the user
  message the cut turn answered reaches the new call only as its summary
  line in the view, not whole.
- **Scope:** per chat (one turn at a time).
- **New design:** table `turn (id, started, first_msg, last_msg, pick,
  status, ended, why)`. At start, a turn with status `running` was cut.
  The resume can then send the cut turn's messages whole again.

### 23. Turn step history

- **Holds:** inside one call, the vendor-native conversation: the user
  blocks, each model output (with reasoning items), and each batch of tool
  results (`items`, `agent.ts:71-74`, `agent.ts:176-223`). Also the
  messages sent mid-run and not yet taken (`Run.sent`, `agent.ts:54-60`;
  `End.left`, `askai.ts:112-118`).
- **Lives:** in memory.
- **On a crash today:** lost. By design, nothing carries over between
  turns (optchat.md section 6). The replies, tool calls, and results are
  in the log, so the resumed turn sees them through the view.
- **New design:** optional table `turn_item`, only if we want to resume
  a cut turn mid-step. Otherwise derived from the log.

### 24. Streaming output

- **Holds:** the pieces of the reply, thought, or tool call that stream
  now (`chat.live`, `agent.live`; `live_push`, `view.ts:772-779`). The
  `ever` entry is logged only when its step ends (`agent.ts:179-181`).
- **Lives:** in memory; sent to each view (`server.ts:651-655`).
- **On a crash today:** lost. A half-written reply disappears.
- **New design:** memory only, or an optional draft row if a cut reply
  should show after a restart. Thoughts stay unlogged by design.

### 25. Tool calls waiting for results

- **Holds:** the text of each tool call that has no result yet, by call id
  (`chat.calls`, `server.ts:114`; `agent.calls`, `tools.ts:63`).
- **Writes and reads:** `Chat.on` stores a `tool` entry here. It logs the
  call only when its `echo` arrives, together with it
  (`server.ts:656-669`). A stopped call logs its open calls without
  results (`Chat.unanswered`, `server.ts:682-688`).
- **On a crash today:** **lost, and never logged.** The tool may have
  run: a file written, a command run. The log shows no trace of it.
- **Scope:** per turn and per agent.
- **New design:** table `tool_call (id, owner, turn, text, device, started,
  status, result_msg)`. Write the row when the call starts. At start, log
  each `running` row as its call plus an `echo` such as "cut by a
  restart". This merges items 25, 30, and 31.

### 26. Vendor retry state

- **Holds:** in `Agent.step`, the try count (up to `TRIES` = 8), the wait
  (`retry-after` or a doubling), and whether the request holds a room
  (`agent.ts:231-273`). The idle timer of a stream (`agent.ts:357-358`).
- **Lives:** in memory.
- **New design:** memory only. `pi-ai` will likely replace it.

### 27. Usage of each request

- **Holds:** what a request ran on and used (`Used`, `askai.ts:62-63`),
  given to `grant.end` (`agent.ts:380-381`).
- **Lives:** nowhere on a free server. `FREE.end` drops it
  (`agent.ts:127`); the free wallet has no payer (`billing.ts:107`).
- **New design:** optional table `usage (at, served, what, model, input,
  output, cache_read, cache_write, usd)`. Hooks and the factory may want
  cost per turn.

## 3. Agents and tools

### 28. Agents at work

- **Holds:** for each agent of this process: `role`, `call`, `live`,
  `calls`, `stop` (its call was stopped: its report starts no turn),
  `view` (a snapshot of the chat view taken at spawn), and `replies` (its
  replies so far) (`tools.ts:57-67`, `tools.ts:93`).
- **Writes:** `Tools.start` (`tools.ts:530-539`), `Tools.run`
  (`tools.ts:557-572`), `Tools.tell` (`tools.ts:510-528`), `Tools.stop`
  (`tools.ts:656-661`).
- **Reads:** `Tools.working` (`tools.ts:651-653`), the report
  (`server.ts:713-726`), each agent call.
- **On a crash today:** partly lost. The work list keeps the names.
  `Chat.resume` tells each agent the restart note (`server.ts:975`).
  `Tools.agent` rebuilds the role from the log's note. A subagent gets a
  fresh view. The replies collected before the crash are lost, so its
  final report holds only the replies after it.
- **Scope:** per agent.
- **New design:** columns on table `agent`: `status` (idle, working,
  stopped), `turn` (what started it). Derive the report from the agent's
  log, not from memory.

### 29. Devices

- **Holds:** each device by name: its sign-in (`who`), its terminals by
  tab (each a `Link`: send, live, computer flag, work dir), and its jobs
  (`tools.ts:42-55`, `tools.ts:92`). Names collide as `host`, `host-2`
  (`Tools.attach`, `tools.ts:389-399`).
- **Lives:** in memory. A terminal tells its host, computer flag, and
  work dir in its socket query (`term.ts:227-235`, `server.ts:1583-1586`).
- **On a crash today:** lost; each terminal attaches again as it
  reconnects (`server.ts:1100-1114`).
- **New design:** drop. The single process is the one device. Its name,
  computer flag, and work dir come from config or env.

### 30. Jobs

- **Holds:** each tool call that runs on a device: its id (the MCP
  request's, `tools.ts:281`), its terminal, the call (`Job`: tool, input,
  agent dir, `machine.ts:25`), and a promise of its output
  (`tools.ts:51`, `tools.ts:441-486`).
- **Lives:** in memory on the server; `t.jobs` in the terminal
  (`term.ts:42`, `term.ts:933-943`). The output returns as act `out`
  (`server.ts:1263-1266`).
- **On a crash today:** a server crash loses them. The terminal then gets
  a `jobs` list without them and aborts them (`term.ts:915-928`). A
  terminal crash without `QUIT` leaves its jobs waiting on the server
  until a stop (`server.ts:1118-1124`).
- **New design:** table `tool_call` (item 25).

### 31. Shell processes

- **Holds:** `SHELLS`: each shell started, until its process group is
  empty (`machine.ts:50-52`). `RUN`: a random UUID set as `EVERCHAT_RUN`
  on every process the shells start (`machine.ts:43-48`,
  `machine.ts:169`).
- **Writes and reads:** `Machine.shell` (`machine.ts:161-194`).
  `Machine.end` kills every group and every process marked `RUN` at exit
  (`machine.ts:223-235`, `term.ts:219`).
- **On a crash today:** a hard crash (SIGKILL, power) runs no exit
  handler. The processes stay. The next start makes a new `RUN`, so it
  can not find them.
- **Scope:** per device.
- **New design:** columns on `tool_call`: `pgid`, and the `RUN` marker
  (or keep one marker in a state key). At start, kill or report the
  leftovers.

### 32. Work dirs

- **Holds:** the files the agent and each subagent work on:
  `<work>/main` and `<work>/<AgentName>` (`tools.ts:104`, `tools.ts:223`,
  `tools.ts:533`, `machine.ts:124-127`). The server's `config.WORK`
  (`config.ts:28`) and the terminal's `EVERCHAT_WORK` (`term.ts:102`) both
  default to `~/.everchat/work`.
- **Lives:** on disk, as the user's own files.
- **New design:** keep as files. Put the path in config.

### 33. MCP tool server

- **Holds:** a local HTTP server on a random port (`tools.ts:115`,
  `tools.ts:228-231`). Each chat has a secret key in its URL
  (`tools.ts:94`, `tools.ts:219-225`). `CHATS`, `GONE`, `COMING` route
  requests across a handover (`tools.ts:109-114`).
- **Lives:** in memory.
- **New design:** drop. Code mode calls tools as functions.

### 34. Computer-use state

- **Holds:** the helper binary `~/.everchat/computer`, compiled from
  `~/.everchat/computer.swift` when missing or changed
  (`computer.ts:86-95`). A screenshot in `$TMPDIR/everchat-<uuid>.jpg`,
  removed after use (`computer.ts:98-108`). The rule "one computer task per
  device" is derived from agents at work (`tools.ts:645-649`). The flag
  `EVERCHAT_COMPUTER=1` (`term.ts:105`).
- **On a crash today:** the binary stays (a cache). A crash during
  `hold_key` leaves the key pressed: the release is in a `finally`
  (`computer.ts:58-66`). The same holds for `left_mouse_down`.
- **New design:** derived (the binary is a cache). The flag goes in
  config.

### 35. After-turn command

- **Holds:** `config.AFTER`, a shell command run after each turn
  (`config.ts:30`, `server.ts:737-753`). `chat.after` chains the runs.
- **On a crash today:** a turn cut by a crash never runs it.
- **New design:** config. It is a first hook. The hooks design should say
  whether a hook missed by a crash runs at start.

## 4. Settings and secrets

### 36. `config.json` and env

- **Holds:** the server's settings: `site`, `vendors`, `models`, `work`,
  `rules`, `after`, `pick` (the default), `compactor`, `agents`, `workers`,
  `apple`, `apns` (`config.ts:22-43`). Each may also be set as
  `EVERCHAT_<KEY>`, which wins (`config.ts:57-59`).
- **Lives:** `$EVERCHAT_DIR/config.json` (`config.ts:19-20`); env.
- **Reads:** once, at start.
- **Terminal env:** `EVERCHAT_URL`, `EVERCHAT_HOME`, `EVERCHAT_WORK`,
  `EVERCHAT_COMPUTER` (`term.ts:77-105`). Import sources:
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` (`term.ts:119-124`). `SHELL`
  (`machine.ts:41`).
- **Server env:** `EVERCHAT_DIR`, `EVERCHAT_WORKER`,
  `BUN_CONFIG_MAX_HTTP_REQUESTS` (`server.ts:2118`, `server.ts:2174`).
- **New design:** config file, read only. Keep `vendors`, `models`,
  `work`, `rules`, `pick`, `compactor`, `agents`, the hooks, the computer
  flag, and the db path. Drop `site`, `workers`, `apple`, `apns`,
  `EVERCHAT_URL`, `EVERCHAT_HOME`, `EVERCHAT_WORKER`.

### 37. API keys

- **Holds:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RESEND_API_KEY`,
  `APNS_KEY` (`config.ts:46-52`).
- **Lives:** env only. Each is read, then deleted from `process.env`, so
  no tool's child process inherits it (`config.ts:83-87`). They are put
  back only for workers (`config_env`, `config.ts:91-94`).
- **New design:** env or the config file. Never the db. Keep the delete
  from env. Drop the Resend and APNs keys.

### 38. Chat pick

- **Holds:** the pick the chat runs on (`mem.pick`, `memory.ts:118`;
  `chat.pick`, `server.ts:99`).
- **Lives:** `view.json` key `pick`.
- **Writes:** the act `pick` (`server.ts:1253-1262`). A saved pick that
  config no longer offers falls back to the config's, with a note
  (`server.ts:303-308`, `pick.ts:135`).
- **Reads:** each turn (`server.ts:555`), each compaction's shared head
  (`server.ts:338-341`), each agent without `config.AGENTS`
  (`tools.ts:584`).
- **On a crash today:** kept.
- **New design:** state key `pick` in the db. The program changes it, and
  the config file is read only, so it can not live in config. **sqlite
  branch:** inside state key `view`.

### 39. Rules file

- **Holds:** the user's instructions, appended to every system prompt
  (`Tools.system`, `tools.ts:248-250`).
- **Lives:** a file at the path `config.RULES` (`config.ts:29`).
- **Reads:** at **every** call (`Tools.rules`, `tools.ts:267-269`). An edit
  takes effect at once and changes the system prompt, which misses the
  prompt cache.
- **New design:** config (a path). Decide whether to read it once per
  start or per turn.

Static text, built into the executable: `prompt.txt`, `hello.md`, the
agent prompts (`tools.ts:123-190`), the compaction tasks
(`memory.ts:176-190`). They need no table.

## 5. Terminal UI

### 40. Terminal view cache

- **Holds:** the terminal's copy of the chat: `parts`, `turn`, `nodes`,
  `whole` (messages known), `minds` (thoughts after each message),
  `pages` (agent logs asked for), `live`, and the server's state (`busy`,
  `wait`, `agents`, `pick`, `importing`, and more) (`view.ts:61-95`).
- **Lives:** in memory (`t.v`, `term.ts:40`).
- **On a crash today:** rebuilt from the server on connect. Thoughts
  (`minds`) are never logged, so they are gone.
- **New design:** derived from the db.

### 41. Open and shut blocks, fold, current tab

- **Holds:** `v.open`: blocks the person opened or shut by hand
  (`view.ts:84`, `view.ts:429-441`). `v.fold`: "fold all" on or off
  (`view.ts:81`). `v.page`: the agent tab shown (`view.ts:88`). `v.tab`: a
  random id per run (`view.ts:294`).
- **Lives:** in memory.
- **On a crash today:** lost; also on a normal quit.
- **New design:** optional table `ui (k, v)`, or drop.

### 42. Unanswered acts (offline outbox)

- **Holds:** each act sent and not yet answered, with its id and the
  message text to show while offline (`v.out`, `view.ts:142`,
  `view.ts:675-678`). Sent again on the next socket (`view.ts:631-640`).
- **Lives:** in memory.
- **On a crash today:** lost. A message typed while offline is gone.
- **New design:** drop. In one process, Enter writes the message to the
  db at once.

### 43. Input draft and history

- **Holds:** the input editor: `text` (the draft), `pos`, `hist`, `at`,
  `draft` (the new text while Up and Down walk the history), `moved`,
  `w`, `tall` (`screen.ts:21-30`).
- **Lives:** in memory.
- **Writes and reads:** `ed_type`, `ed_key`, `ed_take`
  (`screen.ts:323-416`). The history is filled from the user messages
  known at the first view (`term_history`, `term.ts:322-326`).
- **On a crash today:** the draft is lost. The history is rebuilt.
- **New design:** history derived from `msg`. Draft: optional `ui` key,
  so a restarted program shows what was typed.

### 44. Attached images

- **Holds:** images attached by `/image` for the next message
  (`t.imgs`, `term.ts:52`, `term.ts:417-430`).
- **Lives:** in memory, as bytes.
- **On a crash today:** lost.
- **New design:** optional `ui` rows, or store them in `image` at once and
  keep the pending names.

### 45. Print progress

- **Holds:** `t.last` (the last message printed), `wait` (parts not yet
  printed), `out`, `wipe`, `due`, `settle`, `flow` (how much of each
  streaming message is printed), `logs` (per agent page)
  (`term.ts:33-55`). Screen state: `kitty`, `rest`, `up`, `rows`
  (`screen.ts:43-51`).
- **Lives:** in memory. The scrollback itself lives in the terminal
  emulator (Ghostty in the factory).
- **On a crash today:** rebuilt. A start prints the page whole
  (`term_page`, `term.ts:755-759`).
- **New design:** derived.

### 46. Transient notes

- **Holds:** notes sent to the views but not logged: a call's `end.note`
  (`server.ts:573-575`), an after-command error (`server.ts:747`), "Imported
  N messages" (`server.ts:931-932`), a device renamed
  (`server.ts:1112`). Also notes made in the view itself (`v.notes`,
  `view.ts:89`).
- **On a crash today:** lost; a view that joins later never sees them.
- **New design:** log the ones that matter as `note` messages. Drop the
  rest.

## 6. Server, web, accounts, billing, cloud (dropped)

The single-process terminal design removes all of these. Each is listed so
that nothing is dropped by accident.

| # | Item | Where | Today |
|---|------|-------|-------|
| 47 | Accounts db: tables `sessions`, `tickets`, `asks`, `users`, `pushes`, `acts` | `$EVERCHAT_DIR/cloud.db` (`cloud.ts:80-92`, `cloud.ts:100-106`) | kept; WAL mode, `synchronous = normal` (`disk.ts:40-44`) |
| 48 | Sign-in waits, codes, links | `cloud.waits` (`cloud.ts:43`); tickets in the db (`cloud.ts:202-215`) | waits lost |
| 49 | Terminal session token | `$EVERCHAT_HOME/<host>/token`, mode 0600 (`term.ts:80`, `term.ts:982`, `term.ts:1027-1032`) | kept |
| 50 | Mail queue (Resend) | `QUEUE`, `RUN` (`mail.ts:28-29`) | lost |
| 51 | Phone pushes (APNs) | connection and JWT `PUSH` (`cloud.ts:72`); tokens in `pushes` | connection lost |
| 52 | Billing: credit by user, wallet, bookings | `billing.ts:157-194`; free billing (`billing.ts:90-109`) | memory |
| 53 | Sockets and what each was shown | `Sock` data with `seen` (`server.ts:65`); `chat.socks`; `Main.sockets` (`server.ts:1410`) | lost |
| 54 | Rate limits | `USERS`, `NETS` (`server.ts:202`, `server.ts:217`) | lost |
| 55 | Chat registry and post ordering | `Chat.chats` (`server.ts:264`); `posts`, `writes`, `held`, `ending` (`server.ts:104-120`) | lost |
| 56 | Workers and handover | `Main.*` (`server.ts:1388-1421`); `Moved`, `Turn`, `Peer`, `Away`, `Gate` (`server.ts:124-152`); sockets `$EVERCHAT_DIR/hand<k>`, `hand<k>.<pid>`, `hand<k>.link` (`server.ts:164`, `server.ts:1807-1816`) | lost |
| 57 | Web client storage | `sessionStorage` draft; `localStorage` `welcomed`, `risked`, `everchat.intro` (`web/src/main.ts:96-102`, `212`, `263`, `613-620`, `654-655`, `1050-1053`); `BroadcastChannel` `everchat.paid` (`main.ts:54`); page state `P` (`main.ts:75-93`) | browser |
| 58 | iOS app storage | `UserDefaults` group, key `session` (`ios/Shared/Site.swift:13`, `:20`) | device |

Also dropped: the hello seed of a new chat, which logs the hello, the
user's name, and "You're in!" (`server.ts:249-255`, `server.ts:310-313`);
voice transcription (`server.ts:466-480`); phone push of each turn's last
message (`server.ts:730-735`); `/export` and `/tree` as HTTP routes
(`server.ts:1504-1511`). Export and the tree page can stay as local
commands; they are derived from the db.

## 7. Other

### 59. Diagnostic logs

- **Holds:** about 30 `console.error` and `console.log` calls: vendor
  errors and "busy" lines (`agent.ts:250`, `agent.ts:285`,
  `agent.ts:298`), compactor failures (`memory.ts:691`,
  `memory.ts:752`), skipped lines (`memory.ts:279`, `memory.ts:367`),
  flush failures (`disk.ts`), and more.
- **Lives:** stderr only. Nothing is kept.
- **New design:** table `log (at, level, source, text)` or a log file. In
  one process inside a PTY, stderr writes would corrupt the screen.

### 60. Process lock

- **Holds:** one server process per `$EVERCHAT_DIR`. It listens on a unix
  socket `$EVERCHAT_DIR/lock`. A crash leaves a dead socket, which the
  next start removes (`server.ts:161`, `server.ts:1425-1445`).
- **New design:** keep "one writer per db" (optchat.md section 1). Use
  SQLite: an exclusive lock, or a `meta` row with the owner's pid checked
  at start.

### 61. Durability (flush)

- **Holds:** `DIRTY` (files written since the last flush), `WAITS`, `RUN`,
  and `SHELL`, a `sh` process that runs `sync -f` on Linux
  (`disk.ts:28-31`, `disk.ts:99-103`). An act is answered only after a
  flush (`server.ts:1188`).
- **Gaps today:** `import.json` is never passed to `Disk.wrote`
  (`server.ts:825-830`). `cloud.db` keeps its WAL path (`cloud.ts:104`),
  but no code passes it to `Disk.wrote`, so the `acts` table relies on
  `synchronous = normal`.
- **New design:** SQLite WAL. Choose `synchronous = full`, or keep the
  group commit as the sqlite branch does (`Disk.wrote(file + "-wal")`,
  `store.ts:141-145`).

### 62. Temp files and caches

- Temp files: the screenshot (`computer.ts:99`), the upload bodies (item
  16), `view.json.new` and `import.json.new` left by a crash between write
  and rename (`memory.ts:242-243`, `server.ts:828-829`).
- In-memory caches: rows by entry (`view.ts:743`), HTML by row
  (`web/src/html.ts:47`), node texts and sides (item 4), prepared
  statements (`store.ts:63`).
- External, read only: the import sources `~/.claude/projects`,
  `~/.codex/sessions`, `~/.codex/archived_sessions` (`term.ts:119-124`).
- **New design:** all derived.

### 63. Versions

- `WIRE` = 3, the message format between views and server (`view.ts:200`).
- `VERSION`, the terminal's release (`term.ts:66`).
- The sqlite branch's `pragma user_version` = 1 (`store.ts:71`,
  `store.ts:109-121`).
- **New design:** keep `pragma user_version` for schema migrations. Drop
  `WIRE`.

## Suggested tables

A first sketch, for the schema discussion. Names follow the sqlite branch
where it has one.

| Table | Rows | From items |
|-------|------|------------|
| `msg` | messages (pages) | 1 |
| `node` | tree nodes | 3 |
| `state` (k, v) | `view`, `seen`, `pick`, `goal`, `run_marker` | 5, 6, 11, 31, 38 |
| `image` | image bytes and their scaled copy | 15 |
| `agent` | name, role, effort, device, status, created | 18, 28 |
| `agent_msg` | agent logs | 17 |
| `import` | import runs | 9, 14 |
| `turn` | turns, with status | 13, 22 |
| `tool_call` | tool calls, written at start; pgid | 25, 30, 31 |
| `log` | diagnostics | 59 |
| `usage` (optional) | per request cost | 27 |
| `ui` (optional) | draft, tab, open blocks, attachments | 41, 43, 44 |
| `meta` | owner pid, schema version | 60, 63 |

The config file holds items 36, 37 (or env), 39, and the hooks (35).
Everything else is derived or dropped.

## Gaps for restart

These items are lost on a crash today, and their loss breaks "continue
where it was". Most important first.

1. **Tool calls in flight (item 25, with 30 and 31).** A tool call is
   logged only with its result. A crash after the tool ran leaves no trace
   in the log. The resumed agent does not know that it wrote a file or ran
   a command. Its shell processes survive as orphans that no one can find.
2. **The cut turn's own context (items 22, 23).** The resumed turn gets
   only the restart note as its message. The user message it was
   answering, and any message sent mid-run, reach it only as summary lines.
   The steps already done in the turn come back only through the view.
   The pick of the cut call (`chat.model`) is gone too.
3. **The partial reply (item 24).** A reply is logged only when its step
   ends. A crash mid-stream loses the text written so far.
4. **Agent work state (item 28).** The replies collected so far, the stop
   flag, and the view snapshot are lost. The final report after a restart
   holds only the replies made after it. A stopped agent that is told the
   restart note may start again.
5. **Unsent input (items 42, 43, 44).** The draft, the attached images, and
   messages typed while offline live in the terminal's memory. In one
   process, the outbox goes away, but the draft and attachments remain.
6. **Transient notes (item 46).** "Imported N messages", a call's end
   note, and after-command errors are never logged. A restart can not show
   them.
7. **Durability holes (items 14, 10, 61).** `import.json` is not flushed.
   The `acts` WAL is not flushed by `disk.ts`. A machine crash can lose
   them, though a process crash can not.
8. **Running compactions (item 8).** They are rebuilt and asked again.
   Nothing breaks, but the work is done twice.
9. **The after-turn command (item 35).** A turn cut by a crash never runs
   it. Hooks need a rule for this.
10. **UI state (items 41, 45).** The current tab, open blocks, and fold
    are lost. This is cosmetic.

Already kept today, and needing only a move to SQLite: the message log,
the tree, both views, the pick, the goal, the work list, the import run,
the images, and the agent logs. The sqlite branch covers all of these but
the images and the import run.
