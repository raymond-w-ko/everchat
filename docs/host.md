# The host: many chats behind HTTP and WebSocket

This page is the design of the host. The host is the code that runs many chats in one
process behind HTTP and WebSocket. It runs first on a local SQLite file, with a small web
page as the reference client (`docs/design.md`, "The order of the work", 1 [Q56]). The
code batch is planned from this page, bead by bead, so each interface is given exactly.

Where this page and `docs/design.md` differ, `docs/design.md` wins. The facts of the tree
come from the investigation ec-f7m3i; this page cites its answers as "ec-f7m3i Q1" to
"ec-f7m3i Q10", and other facts by `path:line` at d90ec5c. A decision cites its question
of the settled list (`[Q19]`), "lead, ec-mxcl": the lead's eleven decisions, in the
bead ec-1h538, "lead, ec-vgn58": the lead's form of the fixes of the page's two
reviews, by its rule's name (A1 to E), "lead, ec-7bi64": the lead's form of the fixes
of its two re-reviews, by its rule's name (F1 to K), "lead, ec-12a32": the lead's form
of the fixes of its two second re-reviews, by its rule's name (L1 to P5), "lead,
ec-349x0": the lead's rules after its third re-review, by their names (Q1 to S3), or
"lead, ec-9p347": the lead's rulings on the points that the page's reviews left open, by
their names (T1 to T11), "lead, ec-uoo8x": the lead's fixes of the reviews of those
rulings, by their names (T5a, T6a), "lead, ec-x0hhp": the lead's rulings on the bound
of the answers that hold messages, by their names (U1 to U4, U1a), or "lead, ec-hp7pq":
the lead's ruling on the life of an R5 with a `wait` above 0, by its name (V1). The
words are those of `GLOSSARY.md`; the new words are listed at the end.

## Contents

1. [The parts and who gives what](#1-the-parts-and-who-gives-what)
2. [The life of a chat in the host](#2-the-life-of-a-chat-in-the-host)
3. [The client's interface](#3-the-clients-interface)
4. [The JSON shapes](#4-the-json-shapes)
5. [A message in](#5-a-message-in)
6. [Tokens and the backend's functions](#6-tokens-and-the-backends-functions)
7. [The local command](#7-the-local-command)
8. [Limits, and what is not proved here](#8-limits-and-what-is-not-proved-here)
9. [What the store and the turn loop must get](#9-what-the-store-and-the-turn-loop-must-get)
10. [Open](#10-open)
11. [New words](#11-new-words)

## 1. The parts and who gives what

The host lives in a new package, `@everchat/server` (lead, ec-mxcl, decision 1; the
investigation's option A, ec-f7m3i Q7). Its code imports `effect` (its HTTP modules
`effect/http`, its JOSE module `effect/jose`) and `@everchat/core`. It imports no store,
no engine and no module of Bun. So the same host serves the local SQLite file now and
MariaDB later; only the store and the stack change. `effect/http` and `effect/jose` are
installed with `effect` 4.1.2, and they ran on Bun 1.4.4: a `POST`, an event stream and a
WebSocket, and a signed token (ec-f7m3i Q5, Q6). No dependency is new.

The caller gives the host three things:

- the tag `Chats` (`packages/core/src/store.ts:516-520`): the chats of the database, each
  found by its tenant and its UUID;
- the stack of one chat, as a function of that chat's store: everything above the store
  that a loaded chat needs (the diagnostics, the memory, the wire, the sandbox, the
  functions, the turn loop);
- the layer of the HTTP server (`HttpServer.HttpServer` of `effect/http`).

The package's entries:

| Entry | What it gives | Who uses it |
| --- | --- | --- |
| `@everchat/server` (`.`) | `Host` (the service of the loaded chats) and `Host.layer(options)`; `serve(options)`: the layer that serves the routes of section 3 over the `HttpServer` in its context | every build with HTTP: `everchat serve` now, the server build later |
| `@everchat/server/token` | `makeToken(secret, claims)`, with its error `TokenRefused`, and `verifyToken(secret, token, now)` (section 6) | the host, a backend, the local command |
| `@everchat/server/backend` | `makeTenant()`, `makeChat(chats, tenant, pick)`, and `makeToken` again (section 6) | a backend in TypeScript; the local command |

The options of `Host.layer`, as a type:

```ts
interface HostOptions {
  // The stack of one loaded chat over its store. It gives the turn loop and the
  // memory. The caller builds process-wide values (`gatewayLayer`) one time, outside it.
  readonly stack: (store: typeof Store.Service) => Layer.Layer<Turns | Memory, unknown>
  // What each load records in its launch row; the host adds a new run tag each time.
  readonly launch: { readonly pid: number; readonly host: string; readonly cwd: string; readonly version: string }
  // The secret of the deployment: 32 bytes or more. The layer fails at its start on a shorter one.
  readonly secret: Redacted.Redacted<Uint8Array>
  // The origins that may send a request with `Origin` (section 3, "Origins").
  readonly origins: ReadonlyArray<string>
  // The limits of section 8, each with its default.
  readonly limits?: Partial<Limits>
}
```

What the local command (`everchat serve`, section 7) adds:

| Part | What `everchat serve` gives | Where it comes from |
| --- | --- | --- |
| `Chats` | `chatsLayer(file)` over its own file, `serve.db` in the home | `packages/sqlite/src/sqlite.ts:1148` |
| the stack | the local stack with the hosted set of functions (below), as a function of a store | today's `layer`, `packages/local/src/main.ts:145-157`, made a function of a store |
| the author's inference gateway | `gatewayLayer`, built one time for the process and given to each stack | `packages/local/src/gateway.ts:60-66` |
| the HTTP server | `BunHttpServer.layer({ hostname: "127.0.0.1", port, idleTimeout: 190, websocket: { idleTimeout: 120 } })`, as the inspector has it but with Bun's idle limits (section 3, "Admission", 9) | `packages/local/src/inspector.ts:131-136` |
| the secret | 32 random bytes, new at each start, kept in memory only | lead, ec-mxcl, decision 5 |
| the page and its two routes | under a path that starts with a random value of the start (section 7) | lead, ec-mxcl, decision 5 |

**The functions of a host's chat: the hosted set.** A chat of the host has no `shell` and
no file functions (`read`, `write`, `edit`): only the functions that need no machine
(lead, ec-mxcl, decision 2; for a hosted chat, `docs/design.md`, "Tenants and isolation"
[Q5, Q8, Q13]). The reason: the host is the trial of the hosted use, and a page that
reaches a shell through HTTP is a risk with no use here. So no chat of the host needs a
work directory or an environment. The set is the core's `zoom` and `date`
(`packages/core/src/functions.ts:138`) and `result`. Today `result` is a function of the
local package (`packages/local/src/localfunctions.ts:128-145`), but it reads the call's
whole output from the store (`store.call`, `:132`); its file is a copy only. So a code
bead moves it to the core, with no file (section 9). The output limit of a host's chat
writes no file either (section 9). The set is a parameter (the stack), so that the
operator's other answer, the local functions, changes one caller: the stack that
`everchat serve` gives. The sandbox stays as the design wants it for a hosted chat: a new QuickJS
engine for each program (`packages/codemode/src/thread.ts:115-119`; [Q5, Q8, Q13]).

## 2. The life of a chat in the host

### The channel and the loaded chat

The host keeps one **channel** for each chat that it serves: the chat's place in the host.
It holds:

- the chat's tenant and UUID;
- its **holders**, as a count: each connected client, each message in that found the
  channel (while it waits for the channel's lock and while it runs), and the loaded chat;
- the clients that are connected, each with its bounded buffer (section 8, "A slow
  client") and its own number, `given`: the highest event number that was put into its
  buffer. At a client's start, `given` is its `after`, or its snapshot's `seq` (lead,
  ec-vgn58, A1);
- `last`: the highest event number that was given to the clients that joined (below,
  "The give"): the listener sets it, and so does the read at an unload. The listener
  finds a loss by it. No path trusts `last` for a client: a client has its `given`;
- the loaded chat, or none;
- one lock (a semaphore of one permit) for the load, the unload and each message in;
- one **give lock** (a semaphore of one permit) for each give (below).

**The registry.** The host's **registry** finds the channel of a chat. It has one lock of
its own, and two steps change it, each one step under that lock (lead, ec-vgn58, B):

- **hold**: find the channel of a chat, or make it and put it in the registry, and add a
  holder;
- **let go**: remove a holder, and when none is left, take the channel out of the
  registry.

The host holds a chat's channel for each client while it is connected, for each message
in from the moment it finds the channel to its answer, and for the loaded chat from its
load to its unload; each lets go at its end. A channel exists while it has a holder. An
unload never frees a channel: it lets go of the loaded chat's hold. So a message that
waits through an unload holds its channel, a second message finds the same channel, and
two requests that make a chat's first channel at one time get one channel. Under the
registry's lock the host reads nothing of the store: a new channel has no loaded chat,
and its `last` is set at its first load (Load, step 3).

### The give

A **give** puts one numbered event into the buffer of each client of the channel that
joined and whose `given` is below the event's number, and sets that client's `given` to
it; when the listener gives (a live event, the read at a load, the read after a loss) or
the read at an unload gives, the same step sets `last` to the event's number. A piece
goes into the buffer of each client that joined, and moves no number. **A client that has
not joined gets no give but its own first read's**: no give of the listener, of a read
at a load or after a loss, or of an unload, and no piece (lead, ec-12a32, N2). The
host's own frames to a client are not gives, and a client that has not joined gets them
too (below, "The host's own frames"; lead, ec-9p347, T7). Each give
runs under the channel's give lock, as one step that an interruption cannot split
(`Effect.uninterruptible`, as the turn loop's `record` does,
`packages/core/src/turn.ts:208-216`; lead, ec-vgn58, A2). A give never waits: a full
buffer ends its client (section 8, "A slow client"). The one exception is a client's own
first read, which waits for room before each page, with no place and no lock held
(below). Every give puts the JSON of the entry that the fit made (section 8, "The bytes of
one entry"), never the entry itself. Every path that gives a numbered event to a client
gives it this way and only this way (lead, ec-vgn58, A1):

- the listener (Load, step 3);
- the read at a load (Load, step 3) and the read at an unload (Unload, step 2);
- the client's own first read (section 3, "The order and the numbers", step 2): it gives
  to that client alone, a page at a time (section 8, "Pages"; lead, ec-12a32, M). For
  each page:
  1. it waits, with no place of `reads` and no lock held, until that client's buffer has
     room for the largest page: `page` bytes and 1,000 entries (section 8, "Pages");
  2. then it takes a place of `reads` (section 3, "Admission", 11), reads the page from
     the store, fits each entry, gives the page into that room under the give lock in one
     step that does not wait, and gives the place back. No place is held across a wait
     on a client.

  No give but its own first read's reaches a client that has not joined, but the host's
  own frames do: a `said` or an `error` can take room between the two steps (below, "The
  host's own frames"). So the give of step 2 checks the room again, under the give lock,
  in the same step. A page that no longer fits is not given, and does not end the client:
  the first read gives its place back, drops the page, and starts again at step 1 (lead,
  ec-9p347, T7). The client is ended as `slow` when its buffer has no room for a page 30 s
  after the last page was given to it, or after it became a client (section 8, "A slow
  client"; lead, ec-7bi64, G2). A page that was dropped does not start the 30 s again:
  they run from the last page that was given. When the read is at the store's end (a call
  of the store gives fewer events than it asked for: section 8, "Pages"), the client
  **joins**, under the give lock, in the same step as a check of two parts (lead,
  ec-9p347, T9): its `given` is `last` or more, or the channel has no `last`; and its
  buffer has room for one entry of `entry` bytes. When both hold, it joins. Else it does
  not join: it reads the events after its `given` again, as above (step 1's wait for room
  for a page, a read), and checks again. `last` is what the clients that joined were
  given (above), so a client whose `given` is below it reads on first (lead, ec-12a32,
  N3). So no event comes between the client's read and the gives that reach the clients
  that joined: every numbered event up to `last` is in the store, because the turn loop
  publishes an event only after its commit (`packages/core/src/turn.ts:208-216`). And a
  client that joins has room for one largest entry at least, so a live entry does not end
  as `slow` a client that is still draining its last page. A burst after the join can
  still end it: that is the buffer's bound, as designed. Before the chat's first load the
  channel has no `last`, and a client with room joins at once at the store's end.

  **The host's own frames** (lead, ec-9p347, T7). The host's own frames to one client
  (R6's `ready`, `snapshot`, `said`, `error` and `ping`; R4's `: ping`) go through that
  client's buffer, and count in both of its bounds: each client has one queue and one
  writer. They are not gives, and a client that has not joined gets them too. `ready` and
  the snapshot are put before the client's first read starts. The `snapshot` frame is at
  most `page` bytes (section 4, "The snapshot"), and it is put as a first read puts a page
  (lead, ec-x0hhp, U2): it waits, with no place and no lock held, until the client's
  buffer has room for `page` bytes; then it takes a place of `reads`, reads the snapshot
  and cuts its list (section 3, "Admission", 11; lead, ec-x0hhp, U3), puts the frame into
  that room under the give lock in one step that does not wait, and gives the place back.
  A frame that no longer fits, because a `said` or an `error` took room, is dropped, and
  the snapshot starts again with its wait. The 30 s of `slow` hold for it as for a page:
  the client is ended as `slow` when its buffer has no room for `page` bytes 30 s after
  it became a client. So a snapshot never ends a client by its size. A ping is put only
  into an empty buffer. A `said` or an `error` is put when its `say` is answered; one that
  finds no room ends the client as `slow`, as a give does. The frame of an end (R4's
  `close`, R6's close code) is not in the buffer.

A **loaded chat** is the chat's store (`Chats.store`, which writes a launch row), its stack
built over that store in a scope of its own, and the channel's listener (below). The host
never opens a second store of a chat that it holds: a second request for the chat finds
its channel, and so its one loaded instance (lead, ec-mxcl, decision 6). Today a second
`Chats.store` of a held chat closes the first launch as a crash, and both stores could
write (ec-f7m3i Q2); and "one turn at a time" is held only by the one `Turns` of a chat
(`packages/core/src/turn.ts:193, 200`; ec-f7m3i Q3). So one instance is the rule that keeps
both. Two processes on one file: the store's refusal of a live launch of this host
(`LaunchLive`, `packages/sqlite/src/sqlite.ts:701-702`) stays the wall for the local use.
The host answers it with `409 chat_elsewhere`. The lease is the server plan's [Q22].

### Load

The host loads a chat for a message in (a `POST`, or a `say` frame of a socket), under
the channel's lock:

1. `Chats.store(tenant, chat, launch)`: the chat by its tenant and its UUID; `NoChat` for
   any chat that is not the tenant's (`packages/core/src/store.ts:355-362`). The launch
   row is written.
2. The stack, built over that store, in the loaded chat's scope. A load makes all again
   from the database (`docs/design.md`, "Tenants and isolation" [Q12, Q20]): the turn
   loop restarts a cut turn and closes cut calls (`packages/core/src/turn.ts:538-559`),
   and the memory loads from the database (ec-f7m3i Q8).
3. The listener: the host subscribes to the turn loop (`Turns.subscribe`,
   `packages/core/src/turn.ts:178-181`), and reads the chat's `seq` from the store. Then,
   under the give lock, in one step, it chooses and sets `last`: the lowest `given` of the
   clients that have joined, or, with no client that joined, that `seq` (lead, ec-12a32,
   N1, N4). A client that has not joined does not count: it reads on by itself, and the
   join's check covers it. So a join cannot fall between the choice and the set. Then the
   listener reads the events after `last` from the store (`eventsAfter`,
   `packages/core/src/store.ts:381-387`, in pages: section 8, "Pages"); gives each
   (above, "The give"); and drops each live event whose number is not above `last`. This
   is the rule of `packages/core/src/follow.ts:17-19`, for events. It is needed: the
   restart of step 2 writes events before anyone can subscribe.

   A live numbered event whose number is `last` plus one, the listener gives. One whose
   number is more shows a **loss**: the hub dropped entries (section 8, "The bounds
   between the turn loop and a client"). The listener then reads the numbered events after
   `last` up to that number from the store (`eventsAfter`, in pages), gives them in their
   order, and then gives the event that showed the loss (lead, ec-vgn58, C). A piece that
   the hub dropped is lost: pieces are best effort (`docs/design.md`, "Messages in, events
   out" [Q10, Q17]).

A read needs no load. The snapshot, the older messages and the events after a number
come from the chat's reads (`Chats.reads`, `packages/core/src/store.ts:519`), which take no
launch. A client that only reads never loads a chat.

### Work, and the 6 minutes

An idle chat uses no memory: the host unloads it after 6 minutes with no work
(`docs/design.md`, "Tenants and isolation" [Q12, Q20]). Work is a turn that runs, a
compaction that runs, or a call that runs (lead, ec-mxcl, decision 10). A connected
client is no work: the chat unloads and the client stays connected to its channel.

The host's timer of a loaded chat: a fiber that sleeps until 6 minutes after the last
work, then takes the channel's lock, and unloads the chat when it has no work and its last
work is 6 minutes old or more; else it sleeps again until the new time. It needs two
values that the tree does not have: "busy now", with no wait, and the time of the last
work (ec-f7m3i Q8, gap 1; section 9). Today `Turns.idle` and `Memory.idle` only wait
(`packages/core/src/turn.ts:534-536`, `packages/core/src/memory.ts:849`).

### Unload

Under the channel's lock:

1. The host closes the loaded chat's scope. This ends the launch row (`exit`), and frees
   what the scope holds (ec-f7m3i Q1, "Closing a chat's scope frees"): the turn loop and
   its hub, the memory and its caches, the cache watch, the diagnostics batch (flushed),
   the sandbox's layer. With no work there is no turn fiber, no compaction and no program.
2. The host reads the events after the lowest `given` of the clients that have joined
   from the store, in pages (section 8, "Pages"), and gives them (above, "The give"; lead,
   ec-vgn58, A2; ec-12a32, N1): each client that joined gets only the events above its
   own `given`. A client that has not joined gets none of them: its own first read and
   its join's check give them to it. With no client that joined, the host reads nothing
   and gives to no one. This is how **an unload never loses an event for a
   client**: the listener of the loaded chat may not have taken the last events when the
   scope closed (the trial of ec-f7m3i Q2 lost `end` this way), or a loss of the hub may
   be at the end; the read takes each of them from the database. And the close of the
   scope cannot split a give: it lands between two gives. A piece that the listener had
   not taken is lost; a piece is best effort (`docs/design.md`, "Messages in, events out"
   [Q10, Q17]), and with no work no piece streams.
3. The loaded chat lets go of its hold on the channel (above, "The registry"). The
   channel stays in the registry while it has another holder: a connected client, or a
   message that waits for its lock.

A message that comes while the chat unloads holds the channel, waits for the channel's
lock, finds no loaded chat, and loads it again. It is not lost. A message never meets a
scope that is closing, because the load, the unload and each message in take the same
lock.

### The deadline of the work under the lock

The work under a channel's lock for a message in (a load; the log of one message and the
start of its turn) has a deadline of its own: 20 s from the moment it takes the lock (the
limit `lock`; lead, ec-7bi64, I3). **A deadline asks; the work's end frees** (lead,
ec-12a32, O). At the deadline the host asks the work to stop (it interrupts it). The lock,
the request's place and its holder go back when the work has ended, never before: no work
runs on after its owner let go, and nothing is detached (O2). This is one rule for every
end of a request: its deadline, its client's end, a fault of its connection (lead,
ec-349x0, Q1; section 3, "Admission", 5).

- **The log of a message stays as the core has it** (O1): from its start to its publish
  no interruption cuts it. `record` runs the write and the publish of its events as one
  uninterruptible step (`packages/core/src/turn.ts:208-216`), and `Memory.apply` runs the
  memory's change and its write the same way (`packages/core/src/memory.ts:707-730`). So
  an interruption that comes in the log waits for its end: the order of the commit and the
  publish holds, and a message that was committed is published. Section 9 asks for no
  change of this. One step after it is not yet in it: `Turns.say` forks the turn that its
  log began only after `record` returns (`launch`, `packages/core/src/turn.ts:483-490`,
  called at `:519-521`). An interruption between the two would leave a turn's row running
  and its `start` published, with no fiber to run it, and the next message would begin a
  second turn. So section 9, item 9 asks that the fork be in the same uninterruptible step
  as the log: a fork does not wait.
- **The store bounds the part that cannot be interrupted** (O3). Each call of the store
  ends, done or with a typed fault, within the limit `store` (5 s), by the store's own
  timer on the call (section 9, item 9); a transaction counts as one call. The log of a
  message is one transaction (the memory's writes and the caller's, with the event rows,
  `packages/core/src/memory.ts:675-691`), so it ends within `store`. A write that fails
  so is rolled back, and nothing is published for it. After a write fails, the memory of
  that loaded chat refuses each later write (`packages/core/src/memory.ts:711-719`): so
  the host unloads the chat at once, under the same lock (Unload, steps 1 to 3), and the
  next message loads it again. Where the timer cannot tell whether a commit happened (a
  store on a network whose answer to the commit is lost), the message may be in the log
  with no answer: the key gives its numbers again on the retry (section 5).
- **A load that is stopped** closes its scope as an unload does (Unload, steps 1 to 3).
  The close is work too, under the lock. Its calls of the store, one after the other:
  the one write that was in flight when the stop came (the memory's writes are one at a
  time, under its lock, `packages/core/src/memory.ts:707-730`); the flush of the
  diagnostics batch (`packages/core/src/diagnostics.ts:125-132`); the end of the launch
  row (`packages/sqlite/src/sqlite.ts:727-732`, registered at `:752`); and the read of
  Unload step 2, one call for each 100 events that the load wrote (the restart's: a
  `start`, and the pages of a cut program's `tool` and `echo`,
  `packages/core/src/turn.ts:538-559`), so one call when it wrote at most 100 events
  that fit one page; large events need more ("Accepted risks", 1).
- **A turn that started is never stopped because a request ended**: it runs in the
  loaded chat's scope, not in the request's (`Turns.say`,
  `packages/core/src/turn.ts:492-523`).

**What the page promises, and what it sums** (lead, ec-349x0, R1, R2). The page promises
three things about the end of work. Ownership goes back when the work has ended, never
before (O2, Q1). Each call of the store ends by the store's own timer, within `store`. So
the work ends after a count of calls that has an end. The totals of time that the page
gives from these are the sums for the common case, not promises: the lock's and a place's
below, a stopped load's, R1's and R5's longest silences (section 3, "Admission", 9), and
how long a token serves past its `exp` (section 6; lead, ec-uoo8x, T6a). The cases that
pass a sum are in "Accepted risks", below.

The numbers (O4), each in the limits table:

| What | Free at, the sum for the common case | At the defaults |
| --- | --- | --- |
| a channel's lock, for a log | `lock` + `store` after it was taken | 25 s |
| a channel's lock, for a load that is stopped, or a log whose write failed | `lock` + 4 × `store` after it was taken (the write in flight, then the unload: the flush, the launch's end, one call of the read) | 40 s |
| a request's place and its holder, for a log | `request` + `store` after its head | 35 s |
| a request's place and its holder, for a load that is stopped, or a log whose write failed | `request` + 4 × `store` after its head | 50 s |

A load that wrote more than 100 events adds `store` for each further call of its read.
The message's request answers when its work has ended, as section 3, "Admission", 10
says: `503 busy` with `retry-after: 1`, or the close; in the common case `store` (a log)
or 4 × `store` (a load that is stopped, or a log whose write failed) after its deadline.

### Accepted risks

The cases that pass a sum of the page, which the lead keeps as risks (lead, ec-349x0, R3
and S3; review ec-du4ps). Each has four points: the conditions, why it is rare, how it
fails safe or is recovered, and what would fix it. Section 8, "What is not proved here",
names the first two for the beads of the store and the server.

1. **The replay of a stopped load reads by fitted pages** (ec-du4ps, finding 1).
   - Conditions: a load is stopped at its deadline while it replays a restart with large
     events, and each call of the store takes nearly its whole timer. A page closes
     before the entry that would pass `page` (section 8, "Pages"), so a replay of fewer
     than 100 events can need more than one call: the reviewer's trace, a restart of 14
     events, needs 2 calls, not 1. The lock is then free after 44.5 s, not 40 s.
   - Rare: it needs a store that is slow on every call at the moment a large restarted
     program is replayed.
   - Fails safe: the lock and the place stay held, and nothing is detached. A message in
     that time gets `503 busy` with `retry-after`, and nothing is lost. It ends when the
     cleanup ends.
   - What would fix it: count the fitted pages in the sum, or bound the replay of a
     stopped load.
2. **A log waits for the memory's own lock** (ec-du4ps, the comment on O4).
   - Conditions: a write of the memory is in flight (a compaction's summary) when a
     message's log starts near the deadline, and both transactions take nearly the
     store's timer. `Memory.apply` waits for the memory's lock inside its
     uninterruptible step (`packages/core/src/memory.ts:711-730`), so the deadline cannot
     cut that wait: the reviewer measured the lock free after 27.2 s, not 25 s.
   - Rare: it needs two slow transactions back to back at the deadline.
   - Fails safe: as in 1.
   - What would fix it: one budget from end to end for the memory's lock, or a queue that
     a deadline can leave.
3. **A store's limits are set lower than it was written under** (ec-du4ps, finding 2;
   section 8, "The checks at start", S).
   - Conditions: a deployment lowers the limits on a store that holds a larger event. The
     reviewer's trace: `text` at 192 KiB, then the defaults; an `accepted` event of
     1,180,583 bytes against an `entry` of 1 MiB.
   - Rare: it needs a change of the configuration downward, which no work of the host
     makes.
   - Recovered: the host does not give that event and ends the read with `internal`
     (section 8, S2); its log line names the event's number and size. Start again with
     `entry` (and `page`, and `buffer`) at least that size; no row is lost.
   - What would fix it: the store records the largest limits that it was written under,
     and the start refuses smaller ones.

### Load again

A load after an unload is the same load. The clients of the channel need no new
connection: the new listener feeds the clients that joined, after the read of step 3, and
the others read on by themselves (lead, ec-9p347, T8). So a client sees each
event once, in the order of the numbers, across any count of unloads.

### What a loaded chat holds, and what the process holds

A loaded chat holds, outside the database (ec-f7m3i Q1, the table): its launch, the
diagnostics batch and its timer, the cache watch's fingerprints, the memory's node texts
and its compaction fibers, the turn loop's lock, hub and running turn, and, while a
program runs, its worker and engine. The design counts about 2 MB for a loaded chat and
about 6 MB for a program that runs (`docs/design.md`, "Tenants and isolation" [Q22]).

The process holds, one time for all chats:

- the database's one connection (`SqlClient`); every statement of every chat of a file
  waits on its one semaphore (ec-f7m3i Q1, item 2);
- `Chats`;
- the values of the author's inference gateway: `gatewayLayer` deletes its key from the environment once read
  (`packages/local/src/gateway.ts:60-66`), so a second build in the process cannot find
  it (ec-f7m3i Q1, item 1; Q2). The caller builds it one time and gives it to each stack;
- the engine's WebAssembly file, which the library keeps by its path
  (`packages/codemode/src/thread.ts:119`);
- the host: its channels, its secret, its limits.

## 3. The client's interface

### Ways and routes

A client uses a WebSocket first, or plain HTTP as the fallback: a `POST` in, a `GET` as
an event stream out, and the same `GET` without the stream when a proxy holds the stream
back (`docs/design.md`, "Messages in, events out" [Q18, Q25, Q40]). All ways carry the
same JSON shapes (section 4) and the same event numbers. The routes:

| # | Method and path | What it does |
| --- | --- | --- |
| R1 | `POST /v1/chats/{chat}/messages` | a message in (section 5) |
| R2 | `GET /v1/chats/{chat}` | the snapshot |
| R3 | `GET /v1/chats/{chat}/messages?from={a}&to={b}` | older messages, by their ids, in pages |
| R4 | `GET /v1/chats/{chat}/events?after={n}` with `Accept: text/event-stream` | the event stream |
| R5 | `GET /v1/chats/{chat}/events?after={n}&limit={k}&wait={s}` with any other `Accept` | the events after `n`, with no stream |
| R6 | `GET /v1/chats/{chat}/socket` with `Upgrade: websocket` | the WebSocket |
| R7 | `OPTIONS` on R1 to R5 | the preflight of a browser on another origin |

`{chat}` is the chat's UUID, as text. The local command adds R8 to R10 under its start
value (section 7). No route takes a token in its address, ever (lead, ec-mxcl, decision
4); no route lists chats; there is no listener for all chats [Q41]; and the host sends to
no webhook [Q25, Q40]. **A token's place** (lead, ec-9p347, T3): the host reads a token
from the header `Authorization` of R1 to R5 and from R6's `auth` frame, and from no other
place. A header `Authorization` on R6's upgrade is not read: the socket still needs its
`auth`. A route reads the query parameters that it names and no other: a token in a query
is not read, grants nothing and is not refused. The host's diagnostics never hold a query
or the value of a header. R4 and R6 are clients of the chat's channel (section 2) for as
long as they are connected. An R5 with a `wait` above 0 is a client from its start until
its answer, or, when it joins to wait, until its wait ends; never across a connection that
stays open after its answer. Its first read finds events: it answers. Its first read finds
none and the join's check finds `last` above `after`: it does not join, it reads again,
and it answers. Else it joins and waits; when its wait ends it is a client no more, and it
takes its place again to read and answer (below, R5, "The order"; lead, ec-uoo8x, T5a;
ec-hp7pq, V1). A client loads nothing.
R4 becomes a client when its checks pass, and so does an R5 with a `wait` above 0, before
its first read (below, R5; lead, ec-9p347, T5); R6 only after a good `auth` (below,
"Admission"). An R5 with `wait` 0, or with none, is never a client.

### The checks of each request, in their order

Each route R1 to R6 runs these checks, in this order, before it reads a body:

1. **The origin.** A request with an `Origin` header whose value is not on the host's list
   gets `403 forbidden_origin`. A request with no `Origin` passes this check, whoever sent
   it: a browser too sends no `Origin` on a `GET` to its own origin, and none on a `GET`
   with no CORS (an image, a script). The token is the wall, because a page cannot put
   `Authorization` on such a request. A later route that takes no token must not lean on
   this check (lead, ec-9p347, T1). The local command's list is its own origin only
   (section 7).
2. **The token** (section 6): the header `Authorization: Bearer <token>`, its signature,
   its claims, its end time. Any failure gets one answer, `401 unauthorized`, that does
   not say why; the reason goes to the host's diagnostics (lead, ec-mxcl, decisions 4 and
   11). R6 takes its token from its first frame instead, and reads no header
   `Authorization` (above, "A token's place"; below).
3. **The chat.** A chat that the token does not name gets `404 no_chat`, the same answer
   as a chat of another tenant or a UUID that no chat has (`NoChat`,
   `packages/core/src/store.ts:355-362`). A tenant cannot learn that another tenant's chat
   exists, nor that a chat outside its token exists.
   The host's tests have the two tenants of the design (`docs/design.md`, "Tenants and
   isolation" [Q5, Q8, Q13]): for each route and for the socket, a token of tenant A that
   asks for a chat of tenant B, or names B's chat in its `chats`, gets this answer, and
   reads and writes nothing of B's chat.
4. **The route's own checks**: the query, the content type, the body's size and form, the
   key (section 5).

### Admission

What a request or a socket holds before it is a client, and for how long (lead, ec-vgn58,
D). Each number is a limit of section 8.

1. **A socket** (R6) is a client of its channel only after a good `auth`. Before it, the
   host makes no channel, adds no holder and reads nothing of the store. After it, the
   socket counts toward the clients of its chat (32) and of the host (4,096); a place
   that is full gives `4503` after the `auth`. (D1)
2. **Sockets that wait for their `auth`**: at most 256 for the host. Past it the host
   refuses the upgrade with `503 busy`, before the upgrade. A frame before `ready` is at
   most 8 KiB (a token is at most 4,096 bytes); a larger one closes the socket with
   `1009`. The 512 KiB of a frame hold only after `ready`. (D2)
3. **HTTP requests in flight**: every request that Bun gives to the host, R1 to R10 and a
   request of a path that is no route (R4 until it is a client; R6 until its upgrade, when
   it counts among the sockets of item 2; lead, ec-7bi64, H1): at most 256 for the host. A
   request holds its place from its first line to the end of its answer; R4 to the moment
   when it is a client. An R5 with a `wait` above 0, which is a client from its start,
   holds its place from its first line to the end of its answer, but not from its join to
   the end of its wait: through its first read to the end of its answer when its first
   read finds events, or when the join's check finds `last` above `after` and it
   reads again and answers; to its join, when it joins to wait. When its wait ends, it takes
   its place again to read and answer (R5; lead, ec-9p347, T5; ec-uoo8x, T5a;
   ec-hp7pq, V1). A place counts work, not a connection: it can stay taken after its
   client has gone, until the request's work has ended (item 5; lead, ec-349x0, Q2). A
   client holds no place, except an R5 with a `wait` above 0, from its start to its
   answer, or, when it joins to wait, to its join (above; lead, ec-9p347, T5; ec-uoo8x,
   T5a; ec-hp7pq, V1). There is no
   queue: a request past the bound gets `503 busy` with `retry-after: 1` at once, before
   its body is read. (D3)
4. **Waits.** A body is read in at most 10 s, else `408 timeout`, and the connection
   closes. A message in waits for its channel's lock at most 10 s, else `503 busy` with
   `retry-after: 1`, and nothing is logged; with a key, the client sends it again safely
   (section 5). The channel's lock is held for a load, an unload, or the log of one
   message and the start of its turn: not for the turn, which runs after the answer
   (`Turns.say`, `packages/core/src/turn.ts:492-523`). The work under the lock has a
   deadline of 20 s, and the lock is free when that work has ended (section 2, "The
   deadline of the work under the lock"). (D4)
5. **An end** (lead, ec-349x0, Q). However a request ends (its deadline, its client's
   end, a fault of its connection), the host asks its work to stop, and gives its place
   back and lets go of its channel (and, for a message, of the channel's lock) when that
   work has ended, never before (section 2, "The deadline of the work under the lock";
   O2). The end by the client changes one thing only: no answer is written. A message
   whose transaction was done before the end stays logged; its key gives its numbers
   again (section 5). (D5, Q1 to Q3)

   The reviewer's trace (ec-du4ps, Q4): a message takes its place and its channel's lock
   at 0 s, and its log's append stalls in the store. At 1 s its client ends the request,
   and the host asks the work to stop. The append cannot be cut (section 2, O1), so the
   place, the holder and the lock stay held. At about 5 s (5,136 ms in the trace) the
   store's timer ends the append with a typed fault. The write is rolled back and
   nothing is logged; the host unloads the chat under the same lock, as after any failed
   write. Only then do the lock and the place go back, not at 1 s. A request that comes
   between gets the answers of a full host or of a held lock: past 256 places,
   `503 busy` with `retry-after: 1` (item 3); a message to the same chat waits for the
   lock (item 4), takes it at about 5 s and loads the chat again. The client that left
   gets no answer; its send again with its key logs the message once.
6. **The most that the host holds for requests and sockets with no token** (D6). A
   request with no good token is answered at check 2 (`401`), before its body is read
   and before any read of the store. So with no token the host holds at most:
   - 256 HTTP requests, each with its head only and no body, each until its token check;
   - 256 sockets that wait for their `auth`, each with at most one frame of 8 KiB:
     2 MiB in all, each for at most 5 s;
   - and nothing in a channel: no channel, no holder, no buffer.

   That is 256 requests in flight and 256 sockets that wait: 512 places, and 2 MiB of
   frames, and the longest wait is the 5 s of an `auth`. These are requests and sockets,
   not connections: the host counts what Bun gives it, and Bun holds connections that it
   gives to no one (item 9). With a good token the bound is 256 requests, each with a body
   of at most 512 KiB (128 MiB in all), each until its work has ended, its client there or
   gone (item 5): 35 s by the sum for the common case, or 50 s when its work is a load
   that is stopped or a log whose write failed (item 10; section 2, "Accepted risks"); and
   the clients (section 8).
7. **The local routes R9 and R10** have their own limit, not a chat's: R9 at most 10 in a
   minute, R10 at most 60 in a minute, for the host. Each request that passes the start
   value and the checks of `Origin` and `Host` counts, whether it then succeeds or not.
   (D7)
8. **One rule for both rates** (messages in for one chat; R9 and R10): a fixed window of
   60 s that starts at the first request counted. Past the limit, `429 too_many` with
   `retry-after`: the whole seconds to the window's end, rounded up. For messages in, each request
   that passes checks 1 to 3 counts, a repeat of a key too. (D8)
9. **Connections that the host cannot count** (lead, ec-7bi64, H2). Bun gives the host
   requests, not connections. A connection whose head has not come, or that is idle
   between two requests (after a `401`, say), is Bun's alone, and the host cannot count
   it. Bun's options of a server have no bound on the count of connections: their bounds
   are a body's size (`maxRequestBodySize`) and the idle limit (`BaseServeOptions` and
   `HostnamePortServeOptions`, `bun-types/serve.d.ts:823-959`, Bun 1.4.4). What bounds them:
   - **in time**, Bun's idle limit of a connection, `idleTimeout`, 10 s by default in Bun
     (`serve.d.ts:953-958`). Effect's `BunHttpServer` sets it to 0, which turns it off,
     unless its caller gives one (`BunHttpServer.ts:115-127`, `:167-170`, platform-bun
     4.1.2). Bun's idle limit closes a response that sends no byte for that long too, not
     only an idle connection (`BunHttpServer.ts:115-127`, "quiet response streams";
     ec-f082c's probe). So it must be longer than each time in which the host sends a
     waiting client nothing (below, "The longest silence"). The host's server is built
     with `idleTimeout: 190`, twice the longest silence at the defaults (section 1; lead,
     ec-12a32, L). It closes a connection whose head does not come and one that is idle
     between requests, after 190 s. Bun takes at most 255: it refuses 256 at its start
     ("Bun.serve expects idleTimeout to be 255 or less", Bun 1.4.4). A head that comes one
     byte at a time is not proved to be bounded by it (section 8, "What is not proved
     here");
   - **in count**, the limit of open files of the process, and in a hosted deployment the
     front that stands before the host. Both are the deployment's bounds, not the host's
     (section 8, the limits table). `everchat serve` listens on 127.0.0.1 only, so only a
     process of this machine can open them.

   **The longest silence** (lead, ec-12a32, L1). For each way, the longest time in which
   the host sends no byte to a client that waits, with the limits' names (section 8):

   | Way | Its longest silence | At the defaults |
   | --- | --- | --- |
   | R4, once its stream started | `ping`, between two pings | 15 s |
   | R4 before its stream starts; R2, R3, R7, R9, R10 | `request` + `store`, from its head to its answer (item 10) | 35 s |
   | R1 | `request` + 4 × `store` when its work is a load that is stopped or a log whose write failed (item 10), else `request` + `store` | 50 s |
   | R5 | its read (`request` + `store`), then its `wait`, then its read and answer (`request` + `store`) | 95 s |
   | R6 before its upgrade | `request`: nothing before the upgrade reads the store (item 1) | 30 s |
   | R6 after `ready` | `ping`, between two `ping` frames | 15 s |

   These are the sums for the common case (section 2, "What the page promises, and what
   it sums"; lead, ec-349x0, R2). The largest is R5's: `wait` + 2 × (`request` + `store`),
   95 s. The idle limit of HTTP,
   `idle`, is at least twice it (L2): the host refuses to start with less, or with more
   than 255 (section 8, "The checks at start"). Its default follows the rule of L3: 60 s
   when the longest silence is 30 s or less, else twice it, so 190 s. The ping stays
   15 s and R5's largest `wait` stays 25 s (lead, ec-mxcl, decision 8). The silence of a
   load that is stopped counts one call of the store for its read (section 2, "The
   deadline of the work under the lock"); a load that wrote more than 900 events would
   pass R5's 95 s, and the host does not count it in the check.

   The idle limit is computed from these sums (lead, ec-349x0, R4). When a silence passes
   it (a case of section 2, "Accepted risks"), Bun resets the connection, and the client
   sends its request again: a message with its key (section 5), a read from its number.

   **The WebSocket's own idle limit** (L6). Bun has one for a WebSocket, apart from the
   idle limit of HTTP: `websocket.idleTimeout`, 120 s by default, from 0 to 960, with
   Bun's own pings shortly before it ends while the client answers them (`sendPings`,
   on by default; `serve.d.ts:550-575`). Effect passes the `websocket` options to Bun as
   they are (`BunHttpServer.ts:79-87`, `:173-174`). The host's server gives
   `websocket: { idleTimeout: 120 }`. After `ready`, the host sends a `ping` frame every
   15 s with nothing to send, so R6's longest silence is 15 s, and 120 is at least twice
   it, by the same relation; the host refuses to start when the WebSocket's idle limit is
   less than twice `ping`.
10. **The deadline of a request** (lead, ec-7bi64, I1, I2). Each request that holds a place
    of item 3 has one deadline for its whole life, from its head to the end of its answer:
    30 s (the limit `request`). An R5 with a `wait` above 0 that does not join has one
    deadline from its head to the end of its answer: when its first read finds events, or
    when the join's check finds `last` above `after` and it reads again and answers, the
    read again and the answer are inside the same 30 s, with no new deadline (lead,
    ec-hp7pq, V1). An R5 that waits holds no place while it waits (it is a client then, as
    from its start); its first 30 s end when it joins to wait, and a new 30 s start when
    it takes its place again to answer (lead, ec-9p347, T5). The 10 s of a
    body's read, the 10 s of a wait for the channel's lock and the 20 s of the work under
    it are inside these 30 s, and the first that ends ends the request. At the deadline the
    host asks the request's work to stop (a read of the store, a function of the backend,
    the wait for a lock, the work under the lock, the write of the answer: it interrupts
    it).
    When that work has ended, and never before, the host gives the place back and lets go
    of the channel (lead, ec-12a32, O2). If no byte of the answer was sent, the answer is
    `503 busy` with `retry-after: 1`; else the connection closes. A part that cannot be
    interrupted ends within `store` (section 2, "The deadline of the work under the
    lock"). So, by the sums for the common case (section 2, "What the page promises, and
    what it sums"; lead, ec-349x0, R2), each of the 256 places is free again `request` +
    `store` after its head, 35 s, or `request` + 4 × `store`, 50 s, when its work is a load
    that is stopped or a log whose write failed; and a channel's lock `lock` + `store`,
    25 s, after it was taken, or 40 s in those two cases (O4).
11. **Reads at one time** (lead, ec-7bi64, G4; ec-12a32, M). A client's own first read (R4,
    R6), the read of an R5, and the read of messages (R2, R3, and R6's snapshot; lead,
    ec-x0hhp, U3) take a place of `reads`: at most 16 for the host. No place is held
    across a wait on a client (M2, M5):
    - a first read waits for room in its client's buffer first, with no place held; then
      it takes a place, reads one page, fits it, gives it into that room with no wait, and
      gives the place back (section 2, "The give"). A page that no longer fits, because
      the host's own frames took room, is dropped, and the read waits again (lead,
      ec-9p347, T7). It takes a place again for its next page;
    - an R5 takes a place for each read and its fit only: its first read, a read again
      when the join's check finds `last` above `after` (lead, ec-hp7pq, V1), and its read
      after its wait. Its `wait` holds no place of
      `reads` (it is a client then, and holds no place of item 3 either), and the write of
      its answer holds none: the answer's bytes are then the request's, bounded by its
      place of item 3 and its deadline (item 10);
    - a read of messages takes a place for its read of the store and its cut only (U3):
      R2 and R3 hold none while they write their answer, which is the request's, as an
      R5's is; R6's snapshot holds none while it waits for room (section 2, "The host's
      own frames"; U2).

    The wait for a place is first come, first served: a first read takes its turn again
    for each page, behind the reads that wait (M3). The next one waits for its turn at most
    30 s, then gets `503 busy` with `retry-after: 1` (R2 to R5) or is closed with `4503`
    (R6). So the host holds at most 16 reads at one time (first reads, R5's and the reads
    of messages), each with one page after its fit or cut and one call of the store before
    it; for each loaded chat, the same two for the listener's own reads; and one page for
    each R2, R3 or R5 whose answer is written. Section 8, "Pages", gives the sums of these
    (lead, ec-9p347, T10).

Every answer has the inspector's headers: `cache-control: no-store`,
`referrer-policy: no-referrer`, `x-content-type-options: nosniff`
(`packages/local/src/inspector.ts:60`). A JSON answer has
`content-type: application/json; charset=utf-8`.

### Origins

The host takes a list of origins (`HostOptions.origins`). For an origin on the list, R1 to
R5 answer with `access-control-allow-origin: <that origin>` and `vary: origin`, and R7
answers `204` with `access-control-allow-methods: GET, POST`,
`access-control-allow-headers: authorization, content-type, idempotency-key` and
`access-control-max-age: 600`. No answer allows credentials: the host uses no cookie. A
preflight from an origin that is not on the list gets `403 forbidden_origin`. R6 refuses
an upgrade from an origin that is not on the list with `403 forbidden_origin`, before the
upgrade. In a hosted deployment the list is the backend's web origins; locally it is the
host's own origin (section 7).

### R1: a message in

- Headers: `Authorization`; `Content-Type: application/json` (else
  `415 unsupported_type`); `Idempotency-Key` (optional, section 5).
- Body: `{"text": "<the message>"}`, at most 512 KiB (else `413 too_large`); no other
  field (else `400 bad_request`).
- `200`: `{"n": 41, "first": 118, "last": 118, "repeat": false}`. `n` is the event number
  of the message's `accepted`; `first` and `last` are the ids of its first and its last
  page. `repeat` is `true` when the key was there already, and the numbers are then those
  of the first message (section 5).
- Errors: `400 bad_request` (the text is empty or too long, or the key is not valid),
  `401`, `403`, `404`, `408 timeout` (the body took more than 10 s; the connection
  closes), `409 chat_elsewhere` (another process holds the chat), `413`, `415`,
  `429 too_many` (with `retry-after`; "Admission", 8), `503 busy` (the host holds as many
  loaded chats as its limit, with `retry-after: 5`; or as many requests in flight as its
  limit, or the message waited 10 s for its channel's lock, or the work under the lock
  passed its 20 s, or the request passed its 30 s with no byte sent: each with
  `retry-after: 1`), `500 internal`. Past its 30 s with bytes sent, the connection closes
  ("Admission", 10).

### R2: the snapshot

- Query: `last` (optional): how many of the chat's last messages, from 1 to 200; 50 when
  it is not given.
- `200`: the snapshot (section 4). It is read in one snapshot of the store, so its
  messages, its `seq` and its turn are one state of the chat. Its JSON is at most `page`
  bytes, whole: its list keeps the newest of the last `last` messages that fit beside its
  other fields, and may hold none (section 4, "The snapshot"; lead, ec-x0hhp, U1, U1a). Its
  read and its cut take a place of `reads` ("Admission", 11; U3).
- Errors: `400` (a `last` that is not a whole number in its range), `401`, `403`, `404`,
  `500 internal` (the snapshot's other fields alone pass `page`: section 4, "The
  snapshot"; U1a), `503 busy` (requests in flight, or its read waited 30 s for a place of
  `reads`, or the request passed its 30 s with no byte sent: with `retry-after: 1`). Past
  its 30 s with bytes sent, the connection closes.

### R3: older messages

- Query: `from` and `to`, whole numbers, `0 <= from < to`, `to - from <= 200`.
- `200`: `{"messages": [<message>, ...]}`: the messages from `from` upward, up to and not
  with `to`, in the order of their ids (`Reading.messages`,
  `packages/core/src/store.ts:393`). An id that the chat does not have yet gives no
  message. The answer's JSON is at most
  `page` bytes: it closes before the message that would pass `page`, as a page of events
  closes before the entry that would pass it (lead, ec-x0hhp, U1). One message always
  fits (section 8, "Pages"). Fewer messages than `to - from` is no end of the range: a
  chat's message ids run with no gap, so the client sees what it lacks and asks again
  from its last id plus one. Only `{"messages": []}` says that the chat has no message
  from `from` now. The read and the cut take a place of `reads` ("Admission", 11; U3).
- Errors: `400`, `401`, `403`, `404`, `500`, `503 busy` (requests in flight, or its read
  waited 30 s for a place of `reads`, or the request passed its 30 s with no byte sent:
  with `retry-after: 1`). Past its 30 s with bytes sent, the connection closes.

### R4: the event stream

- Query: `after`, a whole number from 0: the last event number that the client has.
- `200` with `content-type: text/event-stream`. First the events after `after`, read from
  the store, then each event as it occurs, with the pieces among them. A numbered event is
  one frame with its number as its id; a piece has no id:

  ```text
  id: 42
  event: start
  data: {"type":"start","n":42,"turn":9}

  event: text
  data: {"type":"text","turn":9,"delta":"Hel"}

  ```

- Every 15 s with nothing to send, the host sends a comment line (`: ping`), so that a
  proxy does not close the stream. So a stream that started is never quiet for longer than
  15 s, and Bun's idle limit of 190 s, at least twice the longest silence, does not close
  it (section 3, "Admission", 9, "The longest silence"; lead, ec-12a32, L). Before its
  stream starts, R4 is quiet for 35 s, by the sum for the common case.
- The host ends the stream with a last frame `event: close`,
  `data: {"type":"close","reason":"<reason>"}`, and then closes it. The reasons: `token`
  (its token's `exp` passed), `slow` (its buffer was full, or its first read found no room
  for a page 30 s after its last page), `busy` (its first read waited 30 s for a place of
  `reads`), `stop` (the host stops), `internal` (a read met an event written under larger
  limits, which it cannot give: section 8, "The checks at start", S2; lead, ec-349x0, S2a).
- Errors before the stream starts: `400`, `401`, `403`, `404`, `500`, `503 busy` (the
  chat or the host holds as many clients as its limit; or, with `retry-after: 1`, as many
  requests in flight, or the request passed its 30 s before it was a client, or its first
  read waited 30 s for a place of `reads`: "Admission", 10 and 11). After the stream
  starts, a first read that waited 30 s for its place ends the stream with `close`, reason
  `busy`; one that found no room for a page 30 s after its last page, with reason `slow`;
  one that met an event that it cannot give (section 8, S2), with reason `internal`.
- `Last-Event-ID` is not read: a client gives `after`. A browser's `EventSource` cannot
  send the header `Authorization`, so the page reads the stream with `fetch`.

### R5: the events, with no stream

- Query: `after` as in R4; `limit`, from 1 to 1000, 100 when it is not given; `wait`, a
  whole number of seconds from 0 to 25, in the form that `after` and `limit` take, 0 when
  it is not given. Another value of `wait` (a fraction, a sign, a text) gets `400` (lead,
  ec-9p347, T6).
- `200`: `{"events": [<numbered event>, ...]}`: the chat's numbered events after `after`,
  in the order of their numbers, at most `limit` and at most one page in bytes (section 8,
  "Pages"), each as the fit made it (section 8, "The bytes of one entry"). No piece. Fewer
  events than `limit` is no end of the events: the client asks again after its last
  number (lead, ec-7bi64, G3). Only `{"events": []}` says that there is no event after
  `after` now.
- With no event after `after` and a `wait` above 0, the host waits until an event after
  `after` occurs or `wait` seconds pass, then answers with what is there, possibly
  `{"events": []}` (lead, ec-mxcl, decision 8). **The order** (lead, ec-9p347, T5): an R5
  with a `wait` above 0 becomes a client of the channel before its first read, with its
  `given` at `after`, as R4 and R6 do (section 3, "The order and the numbers", 2). Then it
  reads. With events, it answers and is a client no more. With none, its read is at the
  store's end, and the join's check runs (section 2, "The give"). When the channel's
  `last` is above `after`, an event came between: the R5 does not join; it reads again
  (with a place of `reads`, as every read takes one) and answers, in the place and the
  30 s that it has held from its first line, and it is a client until its answer (lead,
  ec-hp7pq, V1). Else it
  joins, and waits for the first numbered event that is given to it, or for `wait`; then
  it is a client no more, takes its place again, reads the store and answers (lead,
  ec-uoo8x, T5a). A piece that is given to it is dropped. So an event that is committed
  after the R5 became a client is never waited
  out. An R5 with `wait` 0, or with none, is never a client. R5 sends no byte before its
  answer: from its head to its answer it is quiet for `wait` + 2 × (`request` +
  `store`), 95 s, by the sum for the common case: the longest silence of the host, and
  Bun's idle limit of 190 s is twice it (section 3, "Admission", 9, "The longest
  silence"; lead, ec-12a32, L).
- Errors: `400`, `401`, `403`, `404`, `500`, `503 busy` (the chat or the host holds as
  many clients as its limit, for an R5 with a `wait` above 0: the limits of clients count
  it from its start, also when its first read finds events or it reads again (T5; lead,
  ec-hp7pq, V1); or, with
  `retry-after: 1`, as many
  requests in flight, or its read waited 30 s for a place of `reads`, or the request
  passed its 30 s with no byte sent). Past its 30 s with bytes sent, the connection
  closes.

### R6: the WebSocket

- The upgrade: `GET` with `Upgrade: websocket`. The origin is checked first (above). No
  token in the address: the token is the first frame. A header `Authorization` on the
  upgrade is not read, and the socket still needs its `auth` (lead, ec-9p347, T3). The
  host answers no frame before it. With 256 sockets that wait for their `auth`, the host
  refuses the upgrade with `503 busy`, before the upgrade ("Admission", 2).
- Each frame is one JSON object as text: at most 8 KiB before `ready`, at most 512 KiB
  after it. A binary frame, a frame that is no JSON object, or a frame of an unknown type
  closes the socket with code `4400`. A frame over its size closes it with `1009`.
- **A frame at the wrong time** (lead, ec-9p347, T2). Before the host sent `ready`, `auth`
  is the only frame of the client: any other frame, a `say` too, closes the socket with
  `4400`. After the host took one `auth` frame, a second `auth` closes the socket with
  `4400`, at any time: a socket never changes its token (a new token is a new socket,
  section 6). So `4400` is every fault of a frame's form or time, and `4401` speaks of the
  token only. A client waits for `ready` before its first `say`.
- The socket is a client of its channel only after a good `auth` ("Admission", 1).

Frames from the client:

| Frame | Fields | When |
| --- | --- | --- |
| `auth` | `token` (the access token), `after` (required: a whole number from 0, or `null`; an `auth` without it closes the socket with `4400`, so a client always says whether it wants the snapshot; lead, ec-9p347, T4) | first, within 5 s of the upgrade; one time only |
| `say` | `id` (the client's name for the frame: 1 to 64 bytes of visible ASCII), `text`, `key` (optional, section 5) | after `ready` only |

Frames from the host:

| Frame | Fields | When |
| --- | --- | --- |
| `ready` | none | after a good `auth` |
| `snapshot` | the snapshot's fields (section 4), at most `page` bytes in all (U1a) | after `ready`, when `auth` had `after: null`, when its buffer has room for `page` bytes (U2) |
| an event | the event itself (section 4): its `type` is `accepted`, `start`, `call`, `message`, `end`, `text`, `thought` or `program` | after `ready` (and the snapshot) |
| `said` | `id` (the `say` frame's), `n`, `first`, `last`, `repeat`: as R1's answer | for each `say` that was taken in |
| `error` | `id` (the `say` frame's), `error`, `message`: as the error JSON | for a `say` that was refused; the socket stays open |
| `ping` | none | every 15 s with nothing to send |

Each of these frames goes through the socket's buffer and counts in both of its bounds
(section 2, "The host's own frames"; lead, ec-9p347, T7): `ready` and the snapshot before
the first read starts, the snapshot when the buffer has room for `page` bytes, with a
place of `reads` for its read and none for its wait (lead, ec-x0hhp, U2, U3), a `ping`
only into an empty buffer, and a `said` or an `error` when its `say` is answered; one that
finds no room ends the socket with `4408`. The close code
is not in the buffer.

The events come in the order of their numbers, with the pieces among them, as on R4: first
those after `after` (or after the snapshot's `seq`), then each as it occurs. The types of
the host's frames are not the types of the events, so a client tells them apart by `type`
alone.

The host closes the socket with:

| Code | Reason text | When |
| --- | --- | --- |
| `4401` | `unauthorized` | the token only: no `auth` within 5 s; a token that fails; its `exp` passed |
| `4404` | `no_chat` | the token does not name the chat, or the tenant has no such chat |
| `4400` | `bad_frame` | every fault of a frame's form or time: a frame that is not one of the client's frames above; an `auth` without `after`; before `ready`, any frame but the first `auth`, a `say` too; a second `auth`, at any time (T2, T4) |
| `1009` | `too_large` | a frame over 8 KiB before `ready`, or over 512 KiB after it |
| `4408` | `slow` | its buffer was full (a give, or a `said` or an `error` that found no room), or its first read found no room for a page 30 s after its last page, or its snapshot found no room for `page` bytes 30 s after it became a client (U2) |
| `4503` | `busy` | after a good `auth`: the chat or the host holds as many clients as its limit, or its first read or its snapshot's read waited 30 s for a place of `reads` (U3) |
| `1011` | `internal` | a read met an event written under larger limits, which it cannot give (section 8, "The checks at start", S2; lead, ec-349x0, S2a), or the snapshot's other fields alone pass `page` (section 4, "The snapshot"; U1a) |
| `1001` | `stop` | the host stops |

The reason text does not say why a token failed.

### The order and the numbers: what a client does to miss nothing

1. Connect, and get the snapshot: R2, or R6 with `after: null`. It has the chat's `seq`.
   Its messages are the newest that fit in `page` bytes, and may be none: the client reads
   the ones before them by R3, from `count` and their ids (lead, ec-x0hhp, U1, U1a).
2. Read the events after `seq`: R4, R5 or the socket. On R4 and R6 the host makes the
   client a client of the channel first, with its `given` at the client's number, and so
   it does for an R5 with a `wait` above 0, which then reads and answers as R5 says (R5,
   "The order"; lead, ec-9p347, T5). Then on R4 and R6 the client's own first read gives
   it the events after its `given` from the store, a page at a time (section 8,
   "Pages"). Before each page it waits for room for a whole page in that client's
   buffer, with no place held, so a client that reads gets all the events on one
   connection, however many bytes they are; a client whose buffer has no
   room for a page 30 s after its last page is ended as `slow`. The read holds one page in
   memory. At the store's end the client joins the listener's gives, when its `given` is
   `last` or more and its buffer has room for one entry of `entry` bytes; else it reads on
   and checks again (section 2, "The give"; lead, ec-9p347, T9). Each event comes once,
   in the order of the numbers. On R5, an answer with fewer events than `limit` is no
   end: the client asks again after its last number, until an answer is
   `{"events": []}`.
3. Keep the highest event number that it got. On any end of a stream or a socket, and
   after an answer of `503 busy` or `500 internal`, connect again with that number as
   `after`, on any way [Q18], with these waits (lead, ec-9p347, T11). The wire carries no
   wait but the `retry-after` of an HTTP answer.
   - After `busy` (a `503 busy`, R4's `close` with reason `busy`, R6's `4503`): wait 1 s
     before the next connection, twice as long after each `busy` in a row, at most 30 s;
     a `retry-after` that is longer wins.
   - After `internal` (a `500 internal`, R4's `close` with reason `internal`, R6's
     `1011`): show the error to the person, and connect again by itself at most one time
     in 30 s.
   - After the other ends (the token's end, `slow`, `stop`, a fault of the network):
     connect again at once.

   The host does not lean on these waits: a client that connects again at once is
   bounded by the host's own limits (the places, `reads`, the clients).
4. Drop an event whose number it has. A piece has no number: a piece that arrives after
   its message's `message` event, or across a new connection, is dropped by the client
   or shown again. Pieces are best effort [Q10, Q17].
5. **A chat's event numbers run with no gap**, one more each time, from 1: the store makes
   each event's number as the chat's `seq` plus 1, and writes the event's row and the new
   `seq` in one transaction (`addEvent`, `packages/sqlite/src/sqlite.ts:1004-1016`). So a
   client that gets a numbered event whose number is not its last plus one drops it, and
   connects again with its last number as `after` (lead, ec-vgn58, A3). With the host's
   rules this does not happen; the rule keeps a client whole if it does.

## 4. The JSON shapes

One set of shapes serves R1 to R6. Each is the JSON of a type of the core.

### A message

The store's `Message` (`packages/core/src/store.ts:67-79`), one page of the log:

```json
{"i": 118, "kind": "user", "text": "Hello", "size": 5, "more": false, "line": null,
 "turn": null, "call": null, "launch": 7, "created": 1763300000000}
```

`more` is `true` when the text goes on in the next message (a long text is pages of 30,000
characters, `packages/core/src/pages.ts:13`). Times are milliseconds since 1970.

### The events

The numbered events are the store's `Event` (`packages/core/src/store.ts:198-203`), as
JSON, field for field. The turn loop publishes the same type, with the pieces: its
`TurnEvent` is `Event` and the three pieces (`packages/core/src/turn.ts:130-132`). The
store reads them again with the same fields (`eventsAfter`,
`packages/core/src/store.ts:381-387`):

```json
{"type": "accepted", "n": 41, "messages": [<message>, ...]}
{"type": "start",    "n": 42, "turn": 9}
{"type": "call",     "n": 43, "turn": 9, "call": 17, "program": "<the program's code>"}
{"type": "message",  "n": 44, "message": <message>}
{"type": "end",      "n": 45, "turn": 9, "status": "done", "why": null}
```

`accepted` has each page of the person's message; `status` of `end` is `done`, `stopped`
or `failed`.

**`cut`.** A numbered event whose JSON would be larger than the limit `entry` keeps its
number and is given cut (section 8, "The bytes of one entry"; lead, ec-7bi64, F4): its
long text, the `program` of a `call` or the `why` of an `end`, ends early, and the event
has one more field, `"cut": true`. An event that is not cut has no field `cut`. The store's
`Event` has no `cut`: the host adds it, so a live event and the same event read later are
equal field for field, `cut` too. The whole text stays in the database; no route of this
step gives it.

```json
{"type": "call", "n": 43, "turn": 9, "call": 17, "program": "<the first part of the code>", "cut": true}
```

The three pieces have no number:

```json
{"type": "text",    "turn": 9, "delta": "Hel"}
{"type": "thought", "turn": 9, "delta": "..."}
{"type": "program", "turn": 9, "delta": "await zoo"}
```

### The snapshot

```json
{
  "chat": {"uuid": "<the chat's UUID>", "pick": {"vendor": "openai", "model": "...", "effort": "medium", "speed": "slow"}, "goal": null},
  "seq": 45,
  "count": 120,
  "messages": [<message>, ...],
  "turn": {"id": 9, "pick": {...}, "firstMsg": 118, "created": 1763300000000}
}
```

- `chat`: from `Reading.chat` (`packages/core/src/store.ts:120-129`): the UUID, the pick and
  the goal. No draft and no views (lead, ec-mxcl, decision 7).
- `seq`: the chat's last event number; 0 with no event (`Chat.seq`,
  `packages/core/src/store.ts:126`).
- `count`: the id of the chat's next message (`Reading.count`, `packages/core/src/store.ts:392`).
- `messages`: of the last `last` messages (R2's query; 50 when not given; at most 200; R6's
  snapshot: the last 50), the longest run that ends at the chat's last message and fits
  (below), in the order of their ids. It may be empty. Its first message may have a higher
  id than the last `last` would give, and it may be a page in the middle of a text: R3
  reads the messages before it, as the client does for those before `last`.
- `turn`: the turn that runs (`Reading.runningTurns(null)`,
  `packages/core/src/store.ts:417`), or `null`: its id, its pick, its first message and its
  start time. Not its head, which is the whole system prompt.

All five are read in one snapshot of the store (`Reading.snapshot`,
`packages/core/src/store.ts:372`).

**Its bound** (lead, ec-x0hhp, U1, U1a). The JSON of a snapshot, R2's answer or R6's
`snapshot` frame whole, is at most `page` bytes. Its list keeps the newest messages that
fit beside its other fields, and it may hold no message. Its other fields, with each
number at its longest (16 bytes), the picks' texts empty and `goal` `null`, are 326 bytes
(344 in R6's frame, with `"type":"snapshot"`); the picks' texts and a goal add to them,
and have no bound in bytes of their own ("What is not proved here"). One message at its
largest is 180,196 bytes, so a snapshot with one such message is 180,522 bytes, or 180,540
as R6's frame. At the defaults that leaves 2,097,152 − 180,540 = 1,916,612 bytes for the
picks' texts and the goal. The list is empty when the other fields and the newest
message together pass `page`: with empty picks and no goal, that needs a `page` under
180,540, near the relations' edge (they give `page` ≥ 180,246), or else a large pick or
goal. The client then reads every message by R3, where one message always fits (section
8, "Pages"). When the other fields alone pass
`page` (a pick or a goal of megabytes), the host cannot give the snapshot: R2 answers
`500 internal`, and R6 closes with `1011`, as for an event that the host cannot give
(section 8, "The checks at start", S2). The log line gives the snapshot's size in bytes,
and no text.

### An error

```json
{"error": "no_chat", "message": "This tenant has no chat with this UUID."}
```

`error` is one of: `bad_request`, `unauthorized`, `forbidden_origin`, `no_chat`,
`chat_elsewhere`, `timeout`, `too_large`, `unsupported_type`, `too_many`, `busy`,
`internal`.
`message` is a sentence for a person. It never holds a token, a secret, the text of a
message, or why a token failed. `internal` says only that the host failed; its cause goes
to the diagnostics.

## 5. A message in

- **Text only in this step.** A message is one text. Images are the server plan's
  (`docs/design.md`, "Messages in, events out" [Q35, Q44]); a body with an `images` field
  is refused (`400`), so that no image is dropped in silence.
- **Its size.** The text is 1 to 65,536 bytes of UTF-8, after the host makes it well
  formed (`toWellFormed`, as the store does). The reason: a message of a person is not a
  file. 64 KiB is two to three pages of the log (30,000 characters a page,
  `packages/core/src/pages.ts:13`), it bounds what one request can put into a chat's log,
  and a larger text is an attachment, which comes with images. The body is at most 512 KiB,
  because JSON's escapes make a text longer.
- **The key** (`Idempotency-Key`, made by the first sender [Q26, Q27]; lead, ec-mxcl,
  decision 3). It is 1 to 128 bytes of visible ASCII (0x21 to 0x7E); another value gets
  `400 bad_request`. With no key, each `POST` is a new message. With a key that the chat
  has already, the host writes nothing and answers `200` with the first message's numbers
  and its `accepted` number, and `repeat: true`. The text is not compared: the same key
  with another text gets the first message's numbers. This is a limit, and it is the
  sender's rule (only the sender knows that two sends are one message). A key is of its
  chat: the same key in another chat is another message.
- **The key's place** (a proposal for the code batch's schema bead; the schema's page and
  its mark change there, not here). A column `key` on `everchat_msg`, `text`, null for a
  message with no key, set on the row of the message's first page only, and written in the
  insert of the transaction that logs the message (the table refuses an update); and a
  unique index `everchat_msg_key (chat, key)`. Both SQLite and MariaDB let many rows have a
  null key under a unique index. It is kept as long as the message: for ever. To find the
  `accepted` number of a repeat, the store reads the chat's `accepted` row whose `msg` is
  the first page's id; the bead adds an index `(chat, msg)` on `everchat_event` if a
  measure shows the need. Today the schema has no place for a key
  (`docs/schema.html:96`; ec-f7m3i Q3).
- **What the answer says**: the `accepted` event's number and the first and last page ids
  (R1, the `said` frame). The answer comes when the message is in the log; the turn runs
  after it (`Turns.say`, `packages/core/src/turn.ts:492-523`).
- **While a turn runs** the message steers, as the turn loop does today: it is logged at
  once with its `accepted`, and the turn takes it in after its step's results; one that
  comes too late starts the next turn (ec-f7m3i Q3). The host adds no queue.

## 6. Tokens and the backend's functions

### The token

An access token is a JWT signed with HS256 (lead, ec-mxcl, decision 4; `effect/jose` has
it, and a backend in any language can make one; ec-f7m3i Q6). It names one tenant, its
chats and an end time (`docs/design.md`, "Messages in, events out" [Q19, Q33, Q39]).

- Header: `{"alg": "HS256", "typ": "JWT"}`.
- Claims, by these exact names:
  - `tenant`: the tenant's UUID, as text;
  - `chats`: a list of 1 to 64 chat UUIDs, as text, each once (lead, ec-vgn58, E). No
    "all chats" in the first version. A person can have many chats at one time: a client
    with more than 64 chats uses more than one token;
  - `exp`: the end time, in whole seconds since 1970, as JWT has it. Required.
  - Any other claim is ignored, but `nbf`: a token whose `nbf` is after now is refused.
- A UUID as text is 36 characters: lower-case hex digits in groups of 8-4-4-4-12, as the
  store gives it (`packages/sqlite/src/sqlite.ts:268`).
- The largest token that `makeToken` gives, 64 chats with an `exp` of ten digits, is
  3,511 bytes, under the bound of 4,096 (measured with `Jwt.sign` of `effect/jose` and
  dummy key bytes; 100 chats would be 5,383 bytes).

The checks, in their order. The first that fails ends them, with the one answer of
section 3 (`401`, or the socket's `4401`), and a line of the host's diagnostics that gives
the check's number and no part of the token:

1. The header `Authorization` is there, and is `Bearer ` and the token (on R6: the `auth`
   frame's `token`).
2. The token is at most 4,096 bytes, and is three parts of base64url joined by dots.
3. The header's `alg` is `HS256`. Any other, and `none`, is refused.
4. The signature is HS256 of the first two parts with the secret, compared in constant time
   (`Jwt.verify` of `effect/jose`, over Web Crypto).
5. The claims are JSON, and have `tenant`, `chats` and `exp` of the forms above.
6. `exp` is after now, and at most one hour after now: the host refuses a token with a
   longer life (a limit of the host; the backend's tokens are shorter).
7. `nbf`, when it is there, is not after now.

Then the route's chat must be in `chats` (lower case; else `404 no_chat`), and `Chats`
must find it for `tenant` (else `404 no_chat`).

The host checks the token at each request's start and at a socket's start (lead,
ec-9p347, T6). A request with no stream (R1, R2, R3, R5) that started before its token's
`exp` is answered after it, and a request that starts after it is refused: so a token
serves past its `exp` by one request's own life only (lead, ec-uoo8x, T6a). That life is
the request's deadline and the end of its work: by the sums for the common case, 95 s for
an R5 at the defaults (section 3, "Admission", 9 and 10), and longer in the cases that
section 2's accepted risks name, as for a place and a lock (section 2, "What the page
promises, and what it sums"). The page gives no hard number for it. The timer at `exp` is
for the connections with no end of their own, R4 and R6: the host ends a stream (R4,
`close` with reason `token`) or a socket (`4401`) when the token's `exp` passes, by a
timer of the connection, at `exp`. A client then connects
again with a new token, after its last number. A socket never changes its token: a
second `auth` closes it with `4400` (section 3, R6; T2).

The host keeps no accounts and knows no persons (`docs/design.md`, "Messages in, events
out" [Q19, Q33, Q39]): what it knows of who asks is the token's tenant and chats.

### The secret

One secret for the deployment, 32 bytes or more: one shared secret is sufficient at first
(`docs/design.md`, "Messages in, events out" [Q19, Q33, Q39]). In a hosted deployment the
caller gives it to `Host.layer` as `Redacted`; the backend has the same. Locally,
`everchat serve` makes it new at each start and keeps it in memory only (lead, ec-mxcl,
decision 5). No line, answer or row ever holds it.

### The backend's functions

In a hosted deployment the backend makes the chats and the tokens (`docs/design.md`,
"Messages in, events out" [Q19]). The package gives this as functions, not as routes
(lead, ec-mxcl, decision 5), in the entry `@everchat/server/backend`:

```ts
// A new tenant's UUID (a UUIDv4). The tenant's row comes with its first chat.
makeTenant(): string
// A new chat of `tenant` with its first pick; its UUID. It is `Chats.make`.
makeChat(chats: typeof Chats.Service, tenant: string, pick: Pick): Effect.Effect<string, StoreError>
// A token for `tenant` and `chats`, signed with `secret`, that ends at `exp` (seconds).
makeToken(secret: Redacted.Redacted<Uint8Array>, claims: { tenant: string; chats: ReadonlyArray<string>; exp: number }): Effect.Effect<string, TokenRefused>
// Why `makeToken` made no token.
class TokenRefused extends Schema.TaggedError<TokenRefused>()("TokenRefused", {
  reason: Schema.Literals(["chats_empty", "chats_too_many", "chat_twice", "bad_uuid", "exp_not_whole", "exp_past", "exp_far", "too_large"])
}) {}
```

`makeToken` gives no token that the host refuses (lead, ec-vgn58, E). It fails with
`TokenRefused` for: no chat (`chats_empty`) or more than 64 (`chats_too_many`); a chat twice
(`chat_twice`); a tenant or a chat that is no UUID of the form above (`bad_uuid`); an `exp`
that is no whole number of seconds (`exp_not_whole`: `Number.isSafeInteger` is false, as
for a fraction, `NaN` or an infinity; lead, ec-7bi64, J); an `exp` that is not after now
(`exp_past`) or is more than one hour after now (`exp_far`); and a signed token of more
than 4,096 bytes (`too_large`). It checks them in this order, and the first that fails is
the reason: so `exp_not_whole` comes before the checks for a past and a far `exp`.

The common fault is an `exp` made as `Date.now() / 1000 + 600`, which is a fraction:
`Jwt.sign` signs it, and the host refuses the token at its check 5. A backend writes
`Math.floor(Date.now() / 1000) + 600`. The token's bead has the case: `now + 600.5`,
`NaN`, `Infinity` and `-Infinity` each fail with `exp_not_whole`, and sign nothing.

`Chats.make` makes the tenant's row when it is not there
(`packages/core/src/store.ts:507-520`). How a hosted deployment's backend reaches these
functions (a library call, a command, a service of its own) is the server plan's, not this
page's.

## 7. The local command

`everchat serve` starts the host on this machine. Only this command loads the host's
modules, by a dynamic import, as `everchat inspect` loads the inspector's
(`packages/local/src/main.ts:261`).

- **Its options.** `--port <n>`: the port; 4681 when it is not given (the inspector's is
  4680, `packages/local/src/inspector.ts:45`); 0 for any free port. A port in use fails
  the start with a message, as the inspector's does (`NoPort`,
  `packages/local/src/inspector.ts:131-136`). No other option.
- **Its file.** `serve.db` in the home (`EVERCHAT_HOME`, `packages/local/src/main.ts:107`),
  next to the terminal's `everchat.db`. The file is its own, because the local layers
  refuse a file with more than one tenant or chat
  (`packages/sqlite/src/sqlite.ts:302, 311`), and the host's file has many chats. It is
  made when it is not there.
- **Its tenant.** One local tenant, a fixed UUID in the code
  (`00000000-0000-4000-8000-000000000001`). A fixed value needs no read of a tenant list,
  which `Chats` does not have, and keeps the page's chats across starts.
- **127.0.0.1 only**, as the inspector [lead, ec-mxcl]. The host's own origin is then
  `http://127.0.0.1:<port>`, and its list of origins is that one origin. A request whose
  `Host` header is not `127.0.0.1:<port>` gets `403 forbidden_origin`: this refuses a page
  of a web site that points its own name at 127.0.0.1.
- **What it prints at its start**: one line on the standard output, the page's address
  with its start value: `http://127.0.0.1:4681/<start>/`. The person opens the page with
  one click, as the inspector's. Nothing else goes to the standard output.
- **Its diagnostics.** The host's own (those of no chat) go to the standard error, with
  Effect's logger, since `everchat serve` has no screen to keep (lead, ec-mxcl, decision
  11). A chat's diagnostics go to its log as today, through the stack's diagnostics layer.
  No line holds a token, the secret or the text of a message.
- **Its stop.** A signal ends it. The host closes each stream and socket (`stop`, `1001`),
  then unloads each loaded chat as in section 2, so each launch ends.

### The start value and the page's routes

The start value is 32 random hex digits, new at each start, as the inspector's path token
(`packages/local/src/inspector.ts:12-16, 138`). Under it the command serves the page and
two routes for the page alone (lead, ec-mxcl, decision 5):

| # | Method and path | What it does |
| --- | --- | --- |
| R8 | `GET /<start>/` | the page |
| R9 | `POST /<start>/chats` | makes a chat of the local tenant with the default pick; `200 {"chat": "<UUID>"}` |
| R10 | `POST /<start>/token` | body `{"chats": ["<UUID>", ...]}` (1 to 64); `200 {"token": "<JWT>", "exp": <seconds>}`, a token of the local tenant for those chats, for 10 minutes |

- Another path under no start value, or under a wrong one, gets `404`.
- R9 and R10 refuse an `Origin` that is not the host's own, and a request with no `Origin`
  (`403 forbidden_origin`): only the page calls them. They take no token: the start value
  is their wall, as the inspector's.
- R10 answers `400 bad_request` for a list of no chat or of more than 64, for a chat twice
  and for a chat that is no UUID, and makes no token. It checks each chat with
  `Chats.reads` for the local tenant: a chat that is not the local tenant's gets
  `404 no_chat`, and no token is made. Its body is at most 16 KiB and is JSON (`415`,
  `413`, `400` as R1).
- R9 at most 10 in a minute and R10 at most 60 in a minute, for the host, by the rule of
  section 3, "Admission", 7 and 8 (`429 too_many` with `retry-after`). R9 and R10 are
  requests in flight too ("Admission", 3: `503 busy` with `retry-after: 1`), and their
  bodies are read in at most 10 s (`408 timeout`).

### The page's rules

The page is the reference client, for development only [Q27]. It uses only R1 to R6, and
R9 and R10 for its chats and its tokens. Its rules are the inspector's
(`packages/local/src/inspector.ts:22-27`; ec-f7m3i Q9):

- one file, `packages/server/src/client.html`, with its style and its one `<script>`, no
  framework and no build step, taken in as text (`with { type: "text" }`), as
  `packages/local/src/inspector.ts:37` does;
- its content security policy names its one script by its hash, and lets it talk only to
  this server (`connect-src 'self'`), as `packages/local/src/inspector.ts:63-71`;
- each text of a chat is put on the page as text, never as HTML;
- it keeps its chats' UUIDs in the browser's `localStorage`, and gets a new token from R10
  before its token ends;
- it reads the events with `fetch` (R4) or the socket (R6), and keeps the last number of
  each chat, as section 3 says.

The page lives in the package `server`, beside the routes that serve it, so the server
build can serve it too when the server plan wants it.

## 8. Limits, and what is not proved here

### Limits

Each is a field of `HostOptions.limits`, with this default; the name in `code` is the
field's, where the checks at start or a sum use it ("The checks at start"). The numbers are measured before
they are fixed for a hosted deployment, as the design's limits are
(`docs/design.md`, "Functions, approval, programs" [Q34, Q42]). On a store that holds
events, `text`, `body` and `entry` may rise, not fall ("The checks at start", S1).

| Limit | Default | Past it |
| --- | --- | --- |
| `text`: a message's text | 65,536 bytes | `400` |
| `body`: a body of R1 or a socket's frame after `ready` | 512 KiB | `413`; `1009` |
| a socket's frame before `ready` | 8 KiB | `1009` |
| an `Idempotency-Key` | 128 bytes | `400` |
| a token | 4,096 bytes; a life of one hour; 1 to 64 chats | `401`; `4401`; `makeToken` fails with `TokenRefused`, R10 answers `400` |
| messages in, for one chat | 30 in a window of 60 s (section 3, "Admission", 8) | `429 too_many` with `retry-after`; on a socket, an `error` frame |
| R9, for the host | 10 in a window of 60 s ("Admission", 7 and 8) | `429 too_many` with `retry-after` |
| R10, for the host | 60 in a window of 60 s ("Admission", 7 and 8) | `429 too_many` with `retry-after` |
| HTTP requests in flight, for the host | 256 ("Admission", 3); a place counts work, not a connection: it stays taken after its client has gone, until its work has ended ("Admission", 5) | `503 busy` with `retry-after: 1`, before the body is read |
| sockets that wait for their `auth`, for the host | 256 ("Admission", 2) | `503 busy`, before the upgrade |
| the read of a body | 10 s | `408 timeout`, and the connection closes |
| a message's wait for its channel's lock | 10 s | `503 busy` with `retry-after: 1`; on a socket, an `error` frame; nothing is logged |
| `hub`: the turn loop's hub of a loaded chat | 1,024 entries | the oldest entries are dropped; the listener reads the lost numbered events from the store (section 2, Load, step 3) |
| `buffer`: a client's buffer | 4,096 entries or 8 MiB of JSON, the first reached; the host's own frames to the client count in both (section 2, "The host's own frames"; lead, ec-9p347, T7) | the host ends that client's stream (`slow`) or socket (`4408`) |
| `entry`: the JSON of one event or one piece that the host gives | 1 MiB; the host refuses to start with less than the largest whole event that the limits in use allow, or more than `buffer` in bytes ("The checks at start") | a numbered event is cut (`"cut": true`); a piece is dropped ("The bytes of one entry") |
| `page`: a page of a read from the store; the JSON of a snapshot or of R3's answer | 1,000 events or 2 MiB of JSON after the fit, the first reached: a page is at most `page` bytes, since it closes before the entry that would pass it; a snapshot and R3's answer are at most `page` bytes too (lead, ec-x0hhp, U1); the host refuses to start with less than `entry`, or more than `buffer` in bytes ("The checks at start") | the page ends; the next page is read after it ("Pages"); a snapshot keeps its newest messages, and R3 ends before the message that would pass it |
| room for a page in a first read's client's buffer, or for R6's snapshot (lead, ec-x0hhp, U2) | 30 s after the last page was given to it, or after it became a client: a rate of one page (2 MiB) in 30 s, about 70 KB/s (0.56 Mbit/s), asked of a client that catches up | the host ends that client (`slow`; `4408`); it keeps what it took and connects again from its number |
| `reads`: first reads, reads of R5, and reads of messages (R2, R3, R6's snapshot) at one time, for the host | 16 ("Admission", 11; lead, ec-x0hhp, U3) | the next waits at most 30 s, then `503 busy` with `retry-after: 1`; `4503` |
| `request`: the whole life of a request that holds a place | 30 s ("Admission", 10) | the host asks its work to stop; the place and the holder are free when it has ended, by the sum for the common case `request` + `store` (35 s) after the head, or `request` + 4 × `store` (50 s) for a load that is stopped or a log whose write failed (section 2, "Accepted risks"); then `503 busy` with `retry-after: 1`, or the connection closes when bytes were sent |
| `lock`: the work under a channel's lock for a message in | 20 s (section 2, "The deadline of the work under the lock") | the host asks it to stop; the lock is free when it has ended, by the sum for the common case `lock` + `store` (25 s) after it was taken, or `lock` + 4 × `store` (40 s) for a load that is stopped or a log whose write failed (section 2, "Accepted risks"); `503 busy` with `retry-after: 1`; on a socket, an `error` frame (`busy`) |
| `store`: one call of the store, a transaction as one call | 5 s, by the store's own timer (section 9, item 9) | the call fails with a typed fault; a write is rolled back, and nothing is published for it |
| `idle`: Bun's idle limit of HTTP (`idleTimeout`) | 190 s: twice the longest silence ("Admission", 9); the host refuses to start with less than twice it, or more than 255 | Bun closes the connection, or a response that sends no byte for that long |
| the WebSocket's idle limit (`websocket.idleTimeout`) | 120 s ("Admission", 9); the host refuses to start with less than twice `ping`, or more than 960 | Bun closes the socket; Bun pings shortly before, and a client that answers stays |
| connections that Bun holds with no request | none of the host's: the limit of open files of the process, and in a hosted deployment the front before the host ("Admission", 9) | the deployment's bound |
| an event's whole text, past `entry` | not given by any route of this step | the event is given cut |
| clients of one chat | 32 | `503 busy`; `4503`, after the `auth` |
| clients of the host | 4,096 | `503 busy`; `4503`, after the `auth` |
| loaded chats | 200 (the design counts 100 chats at work at one time, `docs/design.md`, "Tenants and isolation" [Q3]) | `503 busy`, with `retry-after: 5` |
| `wait`: R5's largest `wait` | 25 s | `400` |
| R5's `limit` | 1,000 events | `400` |
| R2's `last` and R3's `to - from` | 200 messages | `400` |
| the socket's `auth` | 5 s after the upgrade | `4401` |
| `ping`: an idle stream or socket | a `ping` every 15 s | |
| an idle loaded chat | 6 minutes with no work | it unloads (section 2) |

**A slow client** (lead, ec-mxcl, decision 9). Each client has a buffer with the bound
above. A give of the listener puts each event and piece into the buffer of each client
that joined, and never waits for one (section 2, "The give"); the others read on by
themselves (lead, ec-9p347, T8). When a buffer is full, the host ends that client's
stream or socket, and frees its buffer. The host's own frames to a client go through the
same buffer, with one queue and one writer for each client: a `said` or an `error` that
finds no room ends the client as a give does (lead, ec-9p347, T7). The client connects
again and reads from its last number. A client's own first read is the one give that
waits: before each page it waits for room for a whole page in that client's buffer, with
no place and no lock held, so a client that reads gets every event after its number on
one connection. When its buffer has no room for a page 30 s after the last page was given
to it, the host ends the client as `slow` (lead, ec-7bi64, G2; ec-12a32, M4): it keeps
what it took, and connects again from its number. A client's memory is its buffer, and
the count of clients is bounded.

### The bounds between the turn loop and a client

Each queue between the turn loop and a client has a bound (lead, ec-vgn58, C):

| Queue | Bound | When it is full |
| --- | --- | --- |
| the turn loop's hub of a loaded chat | 1,024 entries | the oldest entries are dropped, and the turn loop never waits |
| a page of a read (`eventsAfter`: the client's first read, the read at a load, at an unload, after a loss, the read of R5) | 1,000 events or 2 MiB of JSON (`page`), one page in memory for each read at a time ("Pages") | none: the next page is read after this one is given; a first read waits for room in its client's buffer |
| a client's buffer | 4,096 entries or 8 MiB of JSON | the host ends that client (`slow`; `4408`) |

- **The hub.** Today the hub has no bound (`PubSub.unbounded`,
  `packages/core/src/turn.ts:194`; ec-f7m3i Q4). `Turns.layer` gets an option, the hub's
  capacity: with none, the hub stays as today, with no bound, for the terminal; the stack
  of a host's chat sets it, 1,024 entries by default (section 9). The hub with a capacity
  is `PubSub.sliding` (`node_modules/effect/src/PubSub.ts:442-488`, effect 4.1.2). Its
  `publish` into a full hub calls the strategy's `handleSurplus`
  (`PubSub.ts:1312-1330`), which for the sliding strategy drops the oldest entry and
  then publishes, at once (`Effect.sync`), and answers `true` (`PubSub.ts:3316-3328`):
  the turn loop's `emit` never waits, and the newest entries stay. The listener is the
  hub's one subscriber. It finds a loss by the numbers (section 2, Load, step 3): because
  the newest entries stay, the next numbered event after a loss always shows it, and the
  read at an unload covers a loss at the end. A piece that was dropped is lost.
- **The largest entry**, as JSON, from the tree. An `accepted` of the host holds the pages
  of one text of at most `text` bytes (section 5), in pages of at most 30,000 characters
  (`packages/core/src/pages.ts:13`); a control character is 1 byte of text and 6 bytes of
  JSON (`\u0001`). A `message` holds one page of at most 30,000 characters
  (`packages/core/src/pages.ts:13`). "The checks at start" gives each as a sum of the
  limits in use: at the defaults an `accepted` is at most 394,452 bytes, a `message`
  180,246, an `end` 12,087, and a `start` 61. A `call`'s `program`, an `end`'s `why` and a piece's `delta`
  have no bound in the tree: the program and the delta are what the model wrote
  (`packages/core/src/turn.ts:310`, `:378`), and `why` a text of the turn loop or of the
  vendor (`packages/core/src/turn.ts:284-295`, `:382`; the vendor's error text,
  `packages/openai/src/openai.ts:288-295`). The next two parts bound them.

### The bytes of one entry

The host bounds what it gives in bytes (lead, ec-7bi64, F).

1. **The limit `entry`**: the largest JSON of one event or one piece that the host gives to
   a client, 1 MiB by default. The host refuses to start with an `entry` larger than
   `buffer` in bytes (8 MiB), or smaller than the largest whole `accepted`, `message`,
   `end` and `start` that the limits in use allow: the sums of "The checks at start"
   (lead, ec-12a32, P2). At the defaults that is 394,452 bytes, the largest `accepted`.
   So those four are never cut. (F1)
2. **The fit.** One function of the host makes the JSON of an entry one time, measures its
   bytes, and fits it to `entry` (below). Every path that gives an entry uses it, after the
   store's read or the hub's take and never before: the listener, each read from the store
   (at a load, at an unload, after a loss, a client's first read) and R5. The buffers hold
   that JSON, and a give to many clients puts the same JSON into each. So a live event and
   the same event read later are equal field for field, `cut` too: the store's
   `eventsAfter` does not give `cut`, and the host adds it. (F2)
3. **A piece** whose JSON is over `entry` is dropped: a piece is best effort. (F3)
4. **A numbered event** whose JSON is over `entry` is never dropped and keeps its number.
   Its long text (`program` of a `call`, `why` of an `end`) is cut at a character's
   boundary (never between the two halves of a pair of surrogates) to the longest start
   whose event, with `"cut": true`, has a JSON of at most `entry` bytes; the cut depends
   only on the event and `entry`, so every path cuts it the same. Section 4 has the field.
   The whole text stays in the database, and no route of this step gives it (the limits
   table). (F4)
5. **The hub before the listener, in bytes** (F5). The hub holds at most its capacity of
   entries (1,024). Its bytes are that times the largest entry, and two bounds make the
   largest entry finite:
   - an `end`'s `why` can be a vendor's error text with no bound: the wire copies the
     vendor's `error.message` whole (`packages/openai/src/openai.ts:288-295`), and the turn
     loop ends the turn with it (`packages/core/src/turn.ts:382`). The turn loop keeps at
     most 2,000 characters of a `why`, for every use, before it stores and publishes it
     (section 9). It makes a `why` well formed one time already, so the row and the event
     hold the same text (`packages/core/src/turn.ts:284-295`); the cut goes in the same
     place, so they stay equal;
   - a `call`'s `program` and a piece's `delta` are parts of one answer of the model. The
     stack of a host's chat gives the wire a cap on one answer (`request.max`, sent as
     `max_output_tokens`, `packages/openai/src/openai.ts:192`). Its measure in bytes is not
     proved here: the host's stack bead sets the cap and measures it (C below).

   So the hub's maximum, as the JSON that the host would give of its entries, is `hub` ×
   the largest of the sums of "The checks at start" (`accepted`, `message`, `end`,
   `start`) and C, the bytes of one answer under the stack's cap (lead, ec-12a32, P4). At
   the defaults, with C at most 394,452 bytes, that is 1,024 × 394,452 bytes: at most
   403,918,848 bytes (385 MiB) for a loaded chat whose listener has stopped taking, and in
   practice far less: the hub holds references to texts that the turn loop holds for its
   own work (the log's pages, the program, the reply), not copies.
6. **Section 10** is then empty. (F6)

### Pages

A read from the store is given a page at a time (lead, ec-7bi64, G1). A page ends at
1,000 events or at the limit `page`, 2 MiB of JSON after the fit, the first reached. The
store's read takes a count only (`eventsAfter(after, limit)`,
`packages/core/src/store.ts:381-387`), so the host reads at most 100 events in one call of
the store, fits each, and closes the page before the event that would take it past
`page`; the next page starts after the page's last number, and the events of that call
that did not fit are read again then. A read is at the store's end when one call gives
fewer events than it asked for. One call of the store holds at most 100 events before
their fit: at most 100 × the largest of the sums of "The checks at start" and C, while it
is fitted; at the defaults, with C at most 394,452 bytes, 39,445,200 bytes (lead,
ec-12a32, P4).

**The largest page** is `page` bytes, exactly (lead, ec-12a32, M1): the page closes before
the entry that would take it past `page`, so no entry passes it, and its first entry
always fits, since `entry` ≤ `page`. It also has at most 1,000 entries. This is the room
that a first read waits for in its client's buffer before each page (section 2, "The
give"), and R6's snapshot before its frame (section 2, "The host's own frames"; lead,
ec-x0hhp, U2), and the number that the check `page` ≤ `buffer` uses.

**The messages of an answer** (lead, ec-x0hhp, U1). A snapshot (R2's answer, R6's
`snapshot` frame) and R3's answer hold messages, not events, and their JSON is at most
`page` bytes, as a page's is. A snapshot keeps the newest messages that fit, and may hold
none (section 4, "The snapshot"; U1a). R3 gives the messages from `from` upward and closes
before the message that would pass `page`. **One message always fits R3's answer**, from
the page's own sums: one message at its largest is `F` + 6 × 30,000 = 180,196 bytes, and
R3's answer with it is 15 + 180,196 = 180,211 bytes (`{"messages":[]}` is 15), which is
less than `message` (180,246) ≤ `entry` ≤ `page` ("The checks at start"). A snapshot
counts its other fields too, so near the limits' edge its list may be empty (U1a).

**The sums of memory for reads** (lead, ec-9p347, T10). One read holds one page after its
fit, at most `page` bytes, and one call of the store before its fit, at most 100 × the
largest of the sums and C (above). At the defaults, with C at most 394,452 bytes, that is
2,097,152 + 39,445,200 = 41,542,352 bytes (39.6 MiB) for one read. The host holds, for
reads:

- (a) **the listener's own reads** (at a load, at an unload, after a loss), which the
  listener of a loaded chat reads one at a time: over the 200 loaded chats,
  200 × 41,542,352 = 8,308,470,400 bytes (7.74 GiB);
- (b) **the reads of `reads`**, first reads, R5's and the reads of messages (section 3,
  "Admission", 11; lead, ec-x0hhp, U3): 16 × 41,542,352 = 664,677,632 bytes (634 MiB). A
  read of messages holds, in its place, one call of the store before its cut, at most 200
  messages (R2's `last` and R3's `to - from`; R6's snapshot reads 50), and its cut, at
  most `page` bytes: 200 × 180,196 = 36,039,200 bytes, and 36,039,200 + 2,097,152 =
  38,136,352 bytes at the defaults, beside a snapshot's other fields. That is less than
  the 41,542,352 bytes of a read of events, so (b)'s number does not rise (U4);
- (c) **the answers of R2, R3 and R5 that are held while they are written**: one page for
  each request in flight, 256 × 2,097,152 = 536,870,912 bytes (512 MiB) (U4).

(a) and (c) have no limit of their own: they are products of limits (the loaded chats,
the requests in flight, `page`, and the largest entry), and the worst case needs every
loaded chat to read events of the largest size at one time. No limit is added for them
here ("What is not proved here").

### The checks at start

`Host.layer` checks its limits at its start, the limits in use (the defaults with the
caller's `limits` over them), not the defaults (lead, ec-12a32, P). A set that breaks one
of these relations makes the layer fail with `LimitsRefused`, which names the limits of
the relation that failed and the relation:

```ts
class LimitsRefused extends Schema.TaggedError<LimitsRefused>()("LimitsRefused", {
  limits: Schema.Array(Schema.String), // the names of the limits, as in the limits table
  rule: Schema.String                  // the relation, as below
}) {}
```

**The sums** (P1). `N` is the longest JSON of a whole number of the tree, 16 bytes
(`9007199254740991`); a kind is 4 bytes (`packages/core/src/store.ts:44`). Each sum is the
most bytes of JSON of that event when it is given whole:

- `F` = 196: one message (section 4) with an empty text, each number at `N`, its `kind`
  4 bytes, `more` as `false`, and `line` as `null` (no code of the tree sets it,
  `packages/sqlite/src/sqlite.ts:805`).
- `P(T)` = 2 × ⌊(T − 1) / 30,000⌋ + 2: the most pages of a text of `T` bytes. A page is
  at most 30,000 characters and ends after its last newline (`packages/core/src/pages.ts:13-27`);
  so two pages in a row, but the last, hold at least 30,000 characters, and a text of `T`
  bytes has at most `T` characters.
- `accepted` = 54 + `P(text)` × (`F` + 1) + 6 × `text`: the event's own fields
  (`{"type":"accepted","n":N,"messages":[]}`, 54 bytes), each page's fields and its comma,
  and each byte of the text at its worst escape, 6 bytes.
- `message` = 50 + `F` + 6 × 30,000 = 180,246: the event's fields, and one page of 30,000
  characters at 6 bytes each.
- `end` = 87 + 6 × 2,000 = 12,087: the event's fields with `status` `stopped`, and a
  `why` of at most 2,000 characters (section 9, item 8).
- `start` = 61.

At the defaults, `P(65,536)` = 6, and `accepted` = 54 + 6 × 197 + 393,216 = 394,452 bytes,
the largest. (Three pages of U+0001, the form of ec-srz0s's count, give 393,638 bytes: the
sum is a bound over every text, with up to six pages.)

**The relations** (P3), each with the limits that its error names:

| Relation | Its limits | Why |
| --- | --- | --- |
| `body` ≥ `text` + 11 | `body`, `text` | a text at its limit, with no escape, fits a body (`{"text":""}` is 11 bytes) |
| `entry` ≥ the largest of `accepted`, `message`, `end` and `start` | `entry`, `text` | each of the four is given whole |
| `entry` ≤ `buffer` in bytes | `entry`, `buffer` | one entry fits an empty buffer |
| `page` ≥ `entry` | `page`, `entry` | the first entry of a page always fits it |
| `page` ≤ `buffer` in bytes, and 1,000 ≤ `buffer` in entries | `page`, `buffer` | a first read's room for one page can come |
| `idle` ≥ 2 × (`wait` + 2 × (`request` + `store`)), and `idle` ≥ 2 × `ping`, and `idle` ≤ 255 | `idle`, `wait`, `request`, `store`, `ping` | Bun's idle limit does not close a client that waits (section 3, "Admission", 9) |
| the WebSocket's idle limit ≥ 2 × `ping`, and ≤ 960 | the WebSocket's idle limit, `ping` | Bun does not close a socket that the host pings |
| `hub` ≥ 1 | `hub` | the hub's maximum is `hub` × the largest sum and C ("The bytes of one entry", 5) |

A set of limits that passes these has no numbered event that cannot be given whole, but a
`call`'s `program` or an `end`'s `why` that F4 cuts (the `why` only past `entry`), among
the events written under it.

**A store's limits may rise, not fall** (lead, ec-349x0, S; an accepted risk, section 2,
"Accepted risks", 3).

- The checks use the limits in use. An event written under larger limits stays in the
  store, as it was written. To set `text`, `body` or `entry` lower than a store was
  written under is not supported. (S1)
- If a read meets such an event (an `accepted` or a `message` whose JSON is over
  `entry`, which F4 never cuts and never drops), the host does not give it. It ends that
  client's read with the page's error for a fault of the host, the word `internal` of
  section 4: R5, and R4 before its stream starts, answer `500 internal` with the error
  JSON; R4 after its stream starts ends with `close`, reason `internal`; R6 closes with
  the code `1011`, reason `internal` (S2a). A read of the listener (at a load, at an
  unload, after a loss) ends so each client that would get the event. Its log line names
  the event's number and its size in bytes, and no text of it. The chat's rows stay as
  they are. (S2)
- A client that gets `internal` shows the error to the person, and connects again by
  itself at most one time in 30 s (section 3, "The order and the numbers", rule 3; lead,
  ec-9p347, T11). A new connection reads from the client's number and meets the
  same event until the limits are set back, so the code is how the client and the
  operator of the deployment learn that the fault is the host's. The two entries
  `internal` of R4 and `1011` of R6 are for two cases only: this one, and a snapshot whose
  other fields alone pass `page`, which R2 answers with `500 internal` and R6 closes with
  `1011` (section 4, "The snapshot"; lead, ec-x0hhp, U1a). The client's rule 3 after
  `internal` covers both. (S2a)

### What is not proved here

Each of these is a point that no trial of ec-f7m3i ran; the bead that builds it proves it,
or a later bead does, as named.

- **A browser** with the page's policy and a WebSocket to the same origin: CSP Level 3 says
  that `connect-src 'self'` covers it (ec-f7m3i Q9). A pilot's bead proves the page in a
  browser, after the page's bead.
- **A slow reader of an event stream** on Bun with `effect/http`: that the host's write
  to a stream never waits on a reader that does not read, so that the buffer is the only
  bound. The stream's bead proves it with a reader that stops.
- **The size of a socket's frame**: that a frame over 512 KiB, or over 8 KiB before
  `ready`, is refused before it is held whole, and not only after Bun's own bound. The
  socket's bead proves it, or says the bound that holds.
- **The connections that Bun holds with no request** (section 3, "Admission", 9): that
  `idleTimeout: 190` closes a connection whose head does not come and one that is idle
  between requests, after 190 s; whether it bounds a head that comes one byte at a time;
  and how many such connections the limit of open files lets the process hold. Both
  bounds are the deployment's, not the host's. The host's server bead measures them, with
  a client that sends its head slowly and many that send none.
- **The silences under the idle limit** (lead, ec-12a32, L5): with the page's numbers, an
  R4 stream with no event for 60 s (its pings only) and an R5 with the largest `wait`
  and its two reads (95 s with no byte) each end whole. The host's server bead proves it
  on its own routes. A probe of `Bun.serve` on Bun 1.4.4 shows the same now: with
  `idleTimeout: 190`, a stream that pings every 15 s for 60 s and an answer after 95 s
  both end whole; with `idleTimeout: 60`, the answer after 95 s is reset at 60 s
  (ec-dotas; the probe of ec-f082c, `idle.ts 190 95`, gives the same).
- **The WebSocket's idle limit** (L6): that the host's `ping` frames, or Bun's own pings
  answered, keep a socket open past 120 s with no other frame. The socket's bead proves it.
- **A store that stalls** (lead, ec-12a32, O6): that each call of the store is ended by
  its own timer within `store` (section 9, item 9), and that the lock and the place are
  then free by the numbers of section 2, "The deadline of the work under the lock". The
  local store's calls do not yield: the SQLite driver runs each statement on the
  process's one thread, and waits up to 5 s on a locked file
  (`packages/sqlite/src/database.ts:8`). So a stall there stops the process's other work
  for that time, and no timer of the host can cut it. The store's beads prove the timer.
  Until they land, the bounds of the deadline are the design's, not measured ones.
- **The two cases that pass the deadline's sums** (lead, ec-349x0, R5; section 2,
  "Accepted risks", 1 and 2): the replay of a stopped load by fitted pages, and a log
  that waits for the memory's own lock. The store's beads and the host's server bead
  measure them, and then the lead fixes each or keeps it as a risk.
- **The cap of one answer in bytes** (C of "The bytes of one entry"): the host's stack
  bead sets `request.max` for a host's chat and measures the bytes of the largest
  `program` and the sum of a turn's pieces under it.
- **`Jwt.verify` refuses `alg: none` and an `alg` other than the key's**: the token's bead
  proves each with a case.
- **The bytes of a chat's pick and goal** (lead, ec-x0hhp, U1a): the pick's four texts
  and the goal have no bound in bytes of their own in the store, and a snapshot counts
  them. No route of the host writes either: a host's chat gets its pick from the
  backend's `makeChat` or R9's default pick, and no function of a host's chat sets a goal.
- **Two processes of `everchat serve` on one file**: the refusal of a live launch holds per
  chat (`packages/sqlite/src/sqlite.ts:701-702`), but each process would take other chats.
  The local use runs one; the lease is the server plan's [Q22].
- **The time of a load and the memory of a loaded chat** in this host: the design's 30 ms
  and 2 MB [Q12, Q22] were measured elsewhere; the smoke test measures them here.
- **Less than 1 s for a piece** (`docs/design.md`, "Messages in, events out" [Q10, Q17]):
  the channel's listener gives each piece to the buffers at once and waits for no client,
  so nothing of the host's adds a wait; the smoke test measures the time from the wire to
  a client.
- **The memory of the reads under load** (lead, ec-9p347, T10): the server's measure of
  memory under load says whether the listener's reads need a bound of their own ("Pages",
  the sums of memory for reads).
- **The one connection of a file** serializes the statements of all chats (ec-f7m3i Q1,
  item 2). Its cost with many chats at work is not measured.

## 9. What the store and the turn loop must get

The list that the code beads take, from ec-f7m3i Q3, Q4 and Q8:

1. **The read of events, and `seq`** (ec-f7m3i Q4). The tree has both (7ee9e87):
   `Reading.eventsAfter(after, limit)`, the chat's numbered events after `after`, in the
   order of their numbers, at most `limit`, with the store's `Event`, which the turn loop
   publishes too (`packages/core/src/store.ts:381-387`, `:198-203`); and the chat's `seq` in
   `Chat`, 0 with no event (`packages/core/src/store.ts:126`). The host adds `cut` (section
   4) and reads in pages (section 8, "Pages").
2. **The key** (section 5). The schema's column and index, with a new mark; the store's
   append takes a key for a message's first page; a read of the message of a key with its
   pages and its `accepted` number; and `Turns.say(text, key?)`, which, for a key that the
   chat has, writes nothing and gives the first message. `say` gives its `accepted` number
   too: today it gives only the pages (`packages/core/src/turn.ts:492-523`).
3. **"Busy now" and the time of the last work** (ec-f7m3i Q8, gap 1). The turn loop gives
   both, with no wait: busy while a turn or a call runs; the memory gives busy while a
   compaction runs; and the time when the chat last had work. The host's timer reads them
   under the channel's lock (section 2).
4. **`result` in the core, over the store.** Today it is in the local package and writes
   a file again (`packages/local/src/localfunctions.ts:128-145`). The host's chat needs it
   with no file; and an output limit that writes no file and names `result(id)` only (the
   interface allows it: `packages/core/src/limit.ts:108-112`).
5. **The local stack as a function of a store.** `packages/local/src/main.ts:145-157`
   builds the store itself; the host needs it over the store that `Chats.store` gives, with
   `gatewayLayer` built one time for the process (section 2). The stack of a host's chat
   gives the wire a cap on one answer (`request.max`, `packages/openai/src/openai.ts:192`),
   and its bead measures the cap in bytes (section 8, "The bytes of one entry", 5). The
   terminal keeps its stack.
6. **The inspector's error `NoChat` renamed `NoHome`** in `packages/local/src/main.ts:248`,
   in the batch that makes the local package serve `Chats` (lead, ec-mxcl, comment of
   2026-11-16 15:38Z). The core's `NoChat` keeps its name.
7. **A bound on the turn loop's hub** (section 8, "The bounds between the turn loop and a
   client"; lead, ec-vgn58, C). `Turns.layer`'s options (`Options`,
   `packages/core/src/turn.ts:165-168`) get the hub's capacity, a whole number of entries,
   optional: with it the hub is `PubSub.sliding` of that capacity; with none it is
   `PubSub.unbounded`, as today (`packages/core/src/turn.ts:194`), and the terminal gives
   none. The stack of a host's chat gives the limit of section 8, 1,024 by default. The
   test, in the host's batch: with the listener held, a burst of more numbered events than
   the capacity; then each client gets each number once, in order, and the listener read
   the lost ones from the store.
8. **A bound on an `end`'s `why`** (section 8, "The bytes of one entry", 5; lead, ec-7bi64,
   F5). The turn loop keeps at most 2,000 characters of a `why`, for every use, before it
   stores and publishes it, at the place where it makes the `why` well formed one time
   (`end`, `packages/core/src/turn.ts:284-295`). Today
   a failed turn's `why` is the wire's message (`packages/core/src/turn.ts:382`), which
   holds the vendor's error text whole (`packages/openai/src/openai.ts:288-295`). The
   test: a failed turn whose vendor error text is 100,000 characters gives an `end` whose
   `why` is 2,000 characters, the same in the row and in the event.
9. **A timer on each call of the store** (section 2, "The deadline of the work under the
   lock"; lead, ec-12a32, O3). Each call of the store ends, done or with a typed fault
   (`StoreError`), within the limit `store` (5 s), by the store's own timer on the call;
   a transaction counts as one call, from its start to its commit. For a store on a
   network, the timer covers the wait for a connection and the statement. A write that
   fails so is rolled back, and nothing is published for it. The test, in each store's
   bead: a call that stalls fails at `store`, and the next call of the chat runs. No
   change of the log's order (O1): the turn loop's `record` and `Memory.apply` stay one
   step that no interruption cuts (`packages/core/src/turn.ts:208-216`,
   `packages/core/src/memory.ts:707-730`), so the commit comes before the publish, a
   key's numbers on a retry are those of the message that was committed, and a turn runs
   in the loaded chat's scope, as today. One change next to it: `Turns.say` forks the turn
   that its log began (`launch`, `packages/core/src/turn.ts:483-490`) in the same
   uninterruptible step as its `record` (today the fork comes after it, `:519-521`), so a
   turn that was logged always runs. The test: a `say` that is interrupted while its log
   writes ends with the message logged, its `start` published and its turn running.

## 10. Open

None. Each point of the investigation's list (ec-f7m3i Q10) is settled by the settled list,
by the lead's eleven decisions, by the lead's form of the fixes, or above; the numbers of
section 8 are defaults that a measure may change. The size of one entry, the point that
was open here, is settled by the limit `entry` and the fit (section 8, "The bytes of one
entry"; lead, ec-7bi64, F).

## 11. New words

For a later glossary bead. Elsewhere this page uses the glossary's words.

- **channel**: the host's place for one chat that it serves: its holders, its clients
  (each with its `given`), the listener's `last`, its loaded chat if any, its lock and its
  give lock. It exists while it has a holder, so it outlives an unload while a client is
  connected or a message waits.
- **registry**: the host's map from a chat to its channel, with one lock; it changes only
  by a hold and a let go (section 2).
- **holder**: what keeps a channel in the registry: a connected client, a message in, or
  the loaded chat.
- **give**: one step, under the channel's **give lock**, that an interruption cannot
  split: it puts one event into the buffers of the channel's clients that joined, each
  numbered event only to a client whose `given` is below its number; a client that has
  not joined gets only its own first read's gives.
- **join**: the step at the end of a client's first read, under the give lock, at which
  the client starts to get the gives of the listener and of the reads at a load, after a
  loss and at an unload; it needs the client's `given` at `last` or more and room in its
  buffer for one entry of `entry` bytes.
- **longest silence**: the longest time in which the host sends no byte to a client that
  waits, on any way (section 3, "Admission", 9); Bun's idle limit is at least twice it.
- **fit**: the one function of the host that makes the JSON of an entry, measures it, and
  fits it to the limit `entry`: a piece over it is dropped, and a numbered event over it is
  cut and gets `"cut": true` (section 8).
- **page**: a part of a read from the store, at most 1,000 events or the limit `page` in
  bytes (section 8).
- **loss**: entries that the hub dropped; the listener sees it as a numbered event whose
  number is not `last` plus one.
- **stack**: everything above a chat's store that a loaded chat needs (the diagnostics, the
  memory, the wire, the sandbox, the functions, the turn loop), given to the host as a
  function of the store.
- **start value**: the random value, new at each start of a local server, that starts the
  path of each of its routes for the person (the inspector's, and `everchat serve`'s page).
  The inspector's code calls it its token; it is no access token.
- **hosted set**: the functions of a chat that needs no machine: `zoom`, `date` and
  `result`.
- **sum for the common case**: a total of time that the page adds up from its limits (a
  lock, a place, a stopped load, a longest silence, a token's time past its `exp`); a
  design's number, not a promise (section 2, "What the page promises, and what it sums").
- **accepted risk**: a case that passes a sum or a rule of the page, which the lead keeps,
  given with its conditions, why it is rare, how it fails safe or is recovered, and what
  would fix it (section 2, "Accepted risks").
