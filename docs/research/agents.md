# Many chats on few processes: routing, load and unload, and events

A company deployment runs one chat for each person or tenant: many chats
(M) on few processes (N), most of them idle. What must change before one
process holds many chats; what a load and an unload cost; how a message from
outside reaches its chat's one process, once and in order; how one listener
gets all chats' events; who wakes a chat that is not loaded. It decides
nothing. Such a chat is a *hosted chat* ("Words"): `GLOSSARY.md` gives
"agent" to a helper. Next to it: `store.md`, `runtime.md`, `functions.md`.

## Today

One process is one launch of one chat. What it holds, and whose it is:

| What | Where | Of the chat or of the process |
| --- | --- | --- |
| The launch row: `pid`, `host`, `cwd`, a new run tag | src/main.ts:137 | Process: `process.pid`, `os.hostname()` |
| The home, from `EVERCHAT_HOME` | src/main.ts:182-187 | Process environment |
| The work directory of the shell and the file functions | src/main.ts:202, src/functions.ts:149 | Process: `process.cwd()` |
| All the parts as one layer, built once per launch | src/main.ts:136-148 | Chat (a value: it takes `home`, `file`, `cwd`, picks) |
| The interface: terminal or pipe mode, from the standard input and output | src/main.ts:205-211 | Process: `Stdio` |
| Signals: SIGTERM, SIGHUP, SIGINT interrupt the one main fiber | src/main.ts:266-279 | Process |
| No logger outside the diagnostics' layer (`QUIET`) | src/main.ts:262 | Process |
| The gateway key: read from `process.env`, then deleted from it | src/gateway.ts:87-93 | Process environment, read once |
| The environment of each shell: a copy of `process.env` with the run tag | src/shell.ts:169-174 | Process environment |
| The sweep of processes that a crash left: it reads every `/proc/<pid>/environ` of the user | src/shell.ts:117, src/shell.ts:145, src/shell.ts:182 | Machine and user |
| Shortened results go to `<tmp>/everchat-<uid>/<chat uuid>/` | src/limit.ts:103-104 | Chat (by its uuid) |
| The diagnostics: a logger per layer, written every 100 ms, and at the close | src/diagnostics.ts:29-32, src/diagnostics.ts:66 | Chat (its own table `log`) |

What is in memory only, and is gone at the end of a launch:

| What | Where | What the next launch does |
| --- | --- | --- |
| The memory's state: nodes read, the views, the jobs | src/memory.ts:608, src/memory.ts:641-649 | Reads the views and the nodes again; starts the compactions that are not done (src/memory.ts:644) |
| A view between batches: the kept parts plus one leaf per new message | src/memory.ts:204-211 | Grows it again from the log |
| A compaction that runs, and its retry schedule (1 s, up to 1 min) | src/memory.ts:118-119, src/memory.ts:721, src/memory.ts:741 | Starts it again |
| A request's retry wait | src/ask.ts:83 | The cut turn sends its step again |
| The turn that runs, its fiber, the lock, the event hub | src/turn.ts:174-180 | Continues the cut turn from its items (src/turn.ts:482-486) |
| The cache watch and single flight state | src/cache.ts:161 | Starts with no expectation (src/cache.ts:36-37) |
| What streams: thought, text, program | AGENTS.md:240-246 | Nothing: it is never in the database |
| The draft, saved after a pause | src/terminal.ts:410 | Reads `chat.draft` |

How a launch takes the chat (src/store.ts:911-950): in one `BEGIN IMMEDIATE`
transaction (src/database.ts:8-10) it reads the launch with no end. Of this
host, another pid, alive: `LaunchLive` (src/store.ts:922-924). Else it closes
that launch as a `crash` and goes on (src/store.ts:925). The scope's close
ends the launch: `exit`, `signal` or `error` (src/store.ts:952-958).

How a message enters and leaves:

- In: `say` logs the message, and in the same transaction starts a turn if
  none runs; else the message steers the turn (src/turn.ts:439-451). The
  message's id is `max(i) + 1` in the transaction (src/store.ts:652). The
  only callers are the terminal and pipe mode (src/pipe.ts:112).
- Out: the turn loop publishes `TurnEvent`s to an in-memory `PubSub`
  (src/turn.ts:108-114, src/turn.ts:175-176). An interface subscribes, then
  reads the log's count, and fills a gap from the log (src/pipe.ts:69-71,
  src/follow.ts:42-65). Pieces (`text`, `thought`, `program`) are events
  only.
- Wake-ups with no message: only at a launch (a cut turn, compactions). No
  timer exists, and no agent yet (src/store.ts:27, src/turn.ts:60).

## Facts

Measured here (Linux, Bun 1.4.4, the executable of `bun build --compile`,
chats of `just sample`, scripts in `/tmp/ec-h0wk/`, no request):

| Measurement | Result |
| --- | --- |
| A whole launch in pipe mode with an empty input (load, no turn, exit), new home | 160-174 ms, max RSS 62 MB |
| The same, 200 turns (844 messages, 18 MB database) | 211-222 ms, max RSS 77 MB |
| The same, 2000 turns (8572 messages, 223 MB database) | 216-222 ms, max RSS 77 MB: the load reads the views and the roots, not the log |
| In one process: `layer` of src/main.ts:136 built 40 times, on 40 copies of the 200-turn chat | first load 101 ms, then 23-31 ms (median 29 ms) |
| Memory of one more loaded idle chat in that process | about 2.0 MB RSS and 0.5 MB heap (RSS 116 MB with 1 loaded, 196 MB with 40) |
| Unload (close the scope) of the 40 | 697 ms in all: about 17 ms each, with a `/proc` sweep each |

A lower bound, from chats with no model: the 40 copies share a uuid and a
pid, and no request, turn, shell or worker thread ran. `not proved`: that SQLite's page cache (2 MB per
connection by default) is most of the 2 MB.

SQLite, PostgreSQL, MySQL:

- WAL needs all processes on one host: "WAL does not work over a network
  filesystem". https://sqlite.org/wal.html
- PostgreSQL `NOTIFY`: at commit only, in commit order, to sessions that ran
  `LISTEN`; payload under 8000 bytes; a queue of 8 GB, then "transactions calling `NOTIFY` will fail at commit".
  `not proved`: that a client away misses them. https://www.postgresql.org/docs/current/sql-notify.html
- PgBouncer in transaction pooling: `LISTEN` and session advisory locks
  "Never". https://www.pgbouncer.org/features.html
- RDS Proxy pins a session for "Listening on a notification channel", `pg_advisory_lock` and MySQL
  `GET_LOCK`, not for transaction advisory locks. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html
- PostgreSQL session advisory locks: held "until explicitly released or the
  session ends". https://www.postgresql.org/docs/current/explicit-locking.html
- MySQL `GET_LOCK`: released by `RELEASE_LOCK()` "or implicitly when your
  session terminates". https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html
- `SELECT ... FOR UPDATE SKIP LOCKED` exists in PostgreSQL
  (https://www.postgresql.org/docs/current/sql-select.html), MySQL
  (https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html: "not
  suitable for general transactional work", but for "queue-like" tables),
  and MariaDB (https://mariadb.com/kb/en/select/).
- MySQL and MariaDB: no `LISTEN`/`NOTIFY` (`not proved`). The binary log is in commit order; Debezium reads it. https://debezium.io/documentation/reference/stable/connectors/mysql.html

Brokers:

- Redis streams: ids only grow; a consumer group gives each entry to one
  consumer, pending until `XACK`; `XAUTOCLAIM` takes a dead consumer's. https://redis.io/docs/latest/develop/data-types/streams/
- NATS: core NATS is "at most once, never replayed"; JetStream adds
  persistence and "at-least-once delivery". https://docs.nats.io/nats-concepts/jetstream
- SQS FIFO: "no quota to the number of message groups"; 120,000 messages in
  flight at most; a retry of a send in the "5-minute deduplication
  interval" adds no duplicate.
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-fifo.html
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html
  (`not proved`: the order inside one message group; that page did not load.)
- EventBridge retries "for 24 hours and up to 185 times", then the event "is
  dropped". https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html
  (`not proved`: its order.)
- A write to a database and a publish to a broker are not one transaction;
  the transactional outbox writes the event in the same transaction, and a
  relay publishes it. https://microservices.io/patterns/data/transactional-outbox.html

Effect's cluster (`node_modules/effect/src/cluster`, `effect` 4.1.2; each
module says `@stability unstable`):

| Part | What it does | Where |
| --- | --- | --- |
| Entity | An address (type and id) with handlers; a mailbox of 4096, one request at a time by default | `Entity.ts:147-149`, `Entity.ts:708`, `ShardingConfig.ts:238` |
| Shard | `hash(entityId) % shardsPerGroup + 1`, 300 shards by default | `Sharding.ts:343-346`, `ShardingConfig.ts:231` |
| Runner | A process that owns shards; runners send to each other over HTTP or a socket | `HttpRunner.ts`, `SocketRunner.ts` |
| Shard lock | In SQL: advisory locks on PostgreSQL and MySQL, lock rows elsewhere; refresh 10 s, expiry 35 s | `SqlRunnerStorage.ts:1-19`, `ShardingConfig.ts:235-236` |
| Persisted message | Saved in SQL (tables `cluster_*`), then sent to the owner; storage polled every 10 s; deduplicated by primary key | `SqlMessageStorage.ts:1-22`, `Sharding.ts:1373-1377`, `ShardingConfig.ts:245` |
| Passivation | An entity with no message for `maxIdleTime` (1 min) is interrupted; at most 10,000 resident on a runner; `Entity.keepAlive` holds it | `ShardingConfig.ts:131`, `ShardingConfig.ts:240-242`, `Entity.ts:787` |
| Timers | `DeliverAt` on a payload; `ClusterCron`; durable sleeps in workflows | `DeliverAt.ts`, `ClusterCron.ts`, `workflow/DurableClock.ts` |
| One process | `SingleRunner`: the same, with no network, but still a SQL store | `SingleRunner.ts:1-12` |

SQL storage for `pg`, `mysql`, `mssql`, `sqlite` (`SqlMessageStorage.ts:148-420`); "Handlers must tolerate retries" (`ClusterSchema.ts`).

## Options

### Before any option: a chat must become a value

Each chat in a shared process needs its own: launch identity (an owner and
an epoch, not a pid: today a second load in the same process closes the
first as a crash, src/store.ts:922-925); gateway key and shell environment as
values, not `process.env`; work directory; scope; an inbox and a listener in
place of `Stdio`. Signals stay the process's and unload every chat; the
`/proc` sweep runs once per process. `runtime.md` covers what a shell reaches.

### Load and unload

| | Load | Unload |
| --- | --- | --- |
| What it is | A restart: build the chat's layer; it closes a cut call, continues a cut turn, starts the compactions that are not done | A clean stop: close the chat's scope; a turn that runs stays `running` (src/turn.ts:412-414), calls are cut |
| Cost, idle chat | about 30 ms and 2 MB in a warm process (Facts) | about 17 ms |
| What is lost | Nothing | What streams; a request in flight (sent again, paid again, maybe from the prompt cache); a compaction in flight; a shell command (the model is told "may or may not have finished") |
| What to save first | Nothing: each event is one transaction already | Nothing, if the chat is idle |

So unload waits for an idle chat: no turn, call or compaction to do.
`Turns.idle` (src/turn.ts:462) covers the turn; the memory has no such signal.

### Routing: one message, to the one owner, once and in order

| Option | Once and in order | A process dies | A chat moves | Costs |
| --- | --- | --- | --- | --- |
| A. Inbox table that each process polls | The front inserts a row (chat, key); the owner moves it to the log in one transaction, the key unique per chat | Its rows stay; the next owner takes them | Free: whoever owns the chat reads its rows | A poll per process; it needs ownership (B) to know whose rows |
| B. Lease row per loaded chat, with a heartbeat and an epoch | Only the holder of the lease writes; each write checks the epoch, so a frozen old owner cannot write | The lease expires; another process takes it with a new epoch | Release, then take | One row per loaded chat, and one write per heartbeat |
| C. Consistent hashing of the chat's uuid over the processes | Gives a first owner, not a guarantee: two processes can disagree while the set changes | The ring changes; about 1/N of the chats move | Implicit | Needs membership, and B under it |
| D. A router process in front | It keeps the map and forwards | It is a single point: it needs its own failover | It decides | One more service to run and test |
| E. Effect cluster: one entity per chat | Persisted requests, deduplicated by key; a mailbox in order | The shard lock expires (35 s); another runner takes the shard and reads the stored messages | By shard, at a rebalance | A second store of messages; runner addresses on the network; 10 s storage poll; `unstable`; and B's epoch check on each Store write, which it does not give (below) |

Each option can deliver twice, so "once" needs a key on each outside message,
unique in the chat. The order is the owner's; the log's ids then fix it. A
message during a turn steers it (src/turn.ts:439-451): the handler returns at
`accepted`, the turn runs in the chat's fiber, and with E `Entity.keepAlive`
holds the entity, or the 1 min idle limit interrupts the turn.

What E fences (`effect` 4.1.2). Shard scheduling: `acquire` and `refresh`
give shard ids, no epoch (`RunnerStorage.ts:58`); `keepAlive` only stops
passivation. A persisted request's final reply is stored only after a lock
refresh confirms the shard, as "this runner's view of its shards lags lock
storage" (`Sharding.ts:1988`, `internal/entityManager.ts:416`); handler
writes in the request's transaction roll back with it
(`internal/entityManager.ts:870`). The turn's Store writes after `say` has
returned are in none of these. The case **an old owner that wakes after
another process took its chat**: on PostgreSQL the paused runner's session
ends after the lock's expiry (`SqlRunnerStorage.ts:126`), another runner
takes the shard and loads the chat, the old one resumes, and until its
refresh sees the loss its turn writes the log over another connection,
unrefused. So E needs B's epoch check on each Store write, or a proved stop.

### Events out: one listener for all chats

- A whole message (`accepted`, `message`) is in the log with an id that never
  changes. A listener that loses one reads the log from its cursor for the
  chat, as `src/follow.ts:42-65` does. For these the event can be a hint
  (chat, id), and the log is the outbox.
- A turn's `start` and `end` are not in the log. `start` is only emitted
  (src/turn.ts:356); a `done` end updates the `turn` row (src/store.ts:1121)
  and logs no note (src/turn.ts:244-251); a reply with no text logs no
  message (src/turn.ts:339). The case **a turn that ends with no new message
  while the listener is away**: the log's cursor does not move, so the log
  never shows the end. The `turn` row keeps the state (`status`, `created`,
  `ended`, `why`): reading a chat's turns after the last seen, and those seen
  running, gives each start and end again as state, in order with messages
  only by time. Events in exact order need an event row, or one sequence.
- A piece of what streams is never in the database: it goes from the owner
  to the listener while the step runs, or not at all.

| Option | Whole messages | Pieces | Costs and limits |
| --- | --- | --- | --- |
| Poll the log and the `turn` rows (or an outbox table) by a global sequence | Simple; a cursor per listener | No | Latency is the poll's; `not proved`: a sequence value can commit after a higher one, so a cursor must be per chat, or wait out late commits |
| PostgreSQL `LISTEN`/`NOTIFY` as a hint, the log as truth | At commit, in commit order, a payload of (chat, id) | Poor: each piece is a transaction on the server | One direct connection: not through PgBouncer's transaction mode, and it pins RDS Proxy; nothing kept for a listener that was away: read the log after a reconnect |
| MySQL, MariaDB | Poll, or read the binary log (Debezium) | No | The binary log reader is a service of its own |
| Broker: Redis streams, NATS JetStream, SQS FIFO, SNS, EventBridge | Durable; in order in a Redis stream; SQS by group = chat uuid (order `not proved`) | Core NATS or Redis pub/sub: volatile, fits | One more service; the publish is not in the store's transaction, so an outbox relay is still needed for "once" |

### Wake-ups with no message

| Work | Simplest rule |
| --- | --- |
| A cut turn, a compaction that is not done, a retry | Not idle, so not unloaded; after a crash the next owner loads the chat at once (a lease that expired with work pending) |
| A timer far away (a goal that waits, a reminder: none exist yet) | A row (chat, time, why) that any process scans with `SKIP LOCKED`, or the cluster's `DeliverAt` or `ClusterCron` |

## What fits, what does not

- Load and unload are cheap and safe if unload waits for an idle chat (about
  2 MB, and 30 ms to load in a warm process). So the busy chats' work is the
  limit, not the count of loaded chats: unload after an idle time.
- Ownership is the hard part, not the routing. Today's guard (`LaunchLive`)
  works only for processes of one host, and lets a second load in the same
  process through. A shared database needs a lease with an epoch that each
  write checks; else two owners write one log, guarded only by the memory's
  die on an id it did not expect (src/memory.ts:673).
- The log is the outbox for whole messages, `src/follow.ts` the reader that
  fills gaps, and the `turn` row the state of each turn. So any channel for
  events can be a hint, at least once, and the listener reads the log and the
  turn rows: no exact broker. Add an event row only if the listener needs
  start and end as events in order (Question 7).
- Pieces need a volatile channel straight from the owner, not a database.
- First, I would try E (Effect cluster with SQL storage, on PostgreSQL), in a
  spike: one entity per chat, a request for "say" with the outside key, and
  `keepAlive` while a turn runs. It gives shard locks that expire, failover,
  passivation and timers, hard by hand, and AGENTS.md asks for Effect's own
  modules first. It does not fence the turn's Store writes: the spike must
  add the epoch check, and pass this test: pause an owner past the lock's
  expiry, let another runner take the chat, resume the old one, and prove its
  writes are refused. Events: `NOTIFY` (chat, id) as a hint, the log and the
  turn rows as truth; pieces over a volatile channel. If the second message
  store, the fencing or the `unstable` API costs too much, fall back to A
  with B (an inbox table, a lease row per chat): the same model by hand.
- The local use keeps one chat, one process, one SQLite file, the PTY, no
  cluster, no lease (ADR 0186 holds); the chat becomes a value (src/main.ts:136).

## Limits

- No option gives "exactly once" to a listener: at least once, deduplicated by (chat, id).
- A piece of what streams cannot be read again: a late listener sees whole messages only.
- A turn that runs cannot move for free: the move is a cut, and the step is sent again.
- SQLite cannot be shared by many hosts (https://sqlite.org/wal.html): a server database (`store.md`).
- MySQL and MariaDB push no events: a poll, a binary log reader, or a broker with an outbox.
- `LISTEN` and session advisory locks (the cluster's shard locks too) need a
  direct session: not PgBouncer's transaction mode; they pin RDS Proxy.
- A shard lock fences the cluster's stored replies, not the app's own writes.

## Questions for the operator

1. What id does a message from outside name? Recommended: `chat.uuid` (one
   chat for each person or tenant), with a key per message, unique in it.
2. How fast must a message start a turn, and an event reach the listener?
   Recommended: under 1 s for both: a hint, with a slow poll as a safety net.
3. Which database server? Recommended: PostgreSQL, for `NOTIFY` and advisory
   locks (`docs/research/store.md` compares).
4. May the deployment add a broker (Redis, NATS, SQS)? Recommended: not at
   first; the log with a `NOTIFY` hint is enough for one listener inside.
5. May the program depend on Effect's cluster, which is `unstable`?
   Recommended: yes for a spike, with the version pinned; decide after it.
6. When is an idle chat unloaded? Recommended: after 10 minutes with no
   work, never with a turn, a call or a compaction to do.
7. What does the listener need: pieces, whole messages, turn start and end as
   state or as events in order? Recommended: whole messages durable, pieces
   best effort, start and end as state from `turn`; an event row only if needed.
8. Do hosted chats need wake-ups by time (reminders, goals that wait)?
   Recommended: not in the first version; design the wake row with the first.

## Words

| Word | Meaning |
| --- | --- |
| hosted chat | One chat that a company deployment runs for one person or tenant, in a process with other chats. Not an agent in `GLOSSARY.md`'s sense. |
| runner | A process that holds many hosted chats. Effect's cluster uses the same word. |
| load | To build a chat's layer in a runner: a restart of that chat. |
| unload | To close a chat's scope in a runner: a clean stop of that chat. |
| owner | The runner that may write a chat now. At most one. |
| lease | A row or a lock that names a chat's owner until a time, renewed by a heartbeat. |
| epoch | A number of a lease that grows at each new owner; a write with an old epoch is refused. Effect's shard locks have none. |
| inbox | The table of messages from outside that wait for their owner to log them. |
| outbox | The record of events that a listener reads. For whole messages, the log is the outbox; a turn's start and end are not in it. |
| hint | An event that says only where to read (chat, id); the log holds the truth. |
| listener | The one program outside that gets the events of all hosted chats. |
| shard | Effect cluster's group of entities that one runner owns at a time. |
| wake row | A row that asks some runner to load a chat at a given time. |
