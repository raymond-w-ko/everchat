# The host: many chats behind HTTP and WebSocket

This page is the design of the host. The host is the code that runs many chats in one
process behind HTTP and WebSocket. It runs first on a local SQLite file, with a small web
page as the reference client (`docs/design.md`, "The order of the work", 1 [Q56]). The
code batch is planned from this page, bead by bead, so each interface is given exactly.

Where this page and `docs/design.md` differ, `docs/design.md` wins. The facts of the tree
come from the investigation ec-f7m3i; this page cites its answers as "ec-f7m3i Q1" to
"ec-f7m3i Q10", and other facts by `path:line` at 108e6fa (lead, ec-0r89g; lead,
ec-olqwa; lead, ec-dkhr1), or by a file and a name in it. A decision cites its question
of the settled list (`[Q19]`), or "lead, <a bead's id>": a ruling of the lead in that
bead. Some of those beads name their rulings: "lead, ec-mxcl": the lead's eleven
decisions, in the bead ec-1h538; "lead, ec-vgn58": the lead's form of the fixes of the
page's two reviews, by its rule's name (A1 to E); "lead, ec-7bi64": the lead's form of
the fixes of its two re-reviews, by its rule's name (F1 to K); "lead, ec-12a32": the
lead's form of the fixes of its two second re-reviews, by its rule's name (L1 to P5);
"lead, ec-349x0": the lead's rules after its third re-review, by their names (Q1 to S3);
"lead, ec-9p347": the lead's rulings on the points that the page's reviews left open, by
their names (T1 to T11); "lead, ec-uoo8x": the lead's fixes of the reviews of those
rulings, by their names (T5a, T6a); "lead, ec-x0hhp": the lead's rulings on the bound of
the answers that hold messages, by their names (U1 to U4, U1a); "lead, ec-hp7pq": the
lead's ruling on the life of an R5 with a `wait` above 0, by its name (V1); "lead,
ec-jbry3": the lead's rulings of the page's second catch-up, by their names (X1 to X6).
The words are those of `GLOSSARY.md`; the new words are listed at the end.

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

- the tag `Chats` (`packages/core/src/store.ts:545-549`): the chats of the database, each
  found by its tenant and its UUID;
- the stack of one chat, as a function of that chat's store: everything above the store
  that a loaded chat needs (the diagnostics, the memory, the wire, the sandbox, the
  functions, the turn loop);
- the layer of the HTTP server (`HttpServer.HttpServer` of `effect/http`).

The package's entries:

| Entry | What it gives | Who uses it |
| --- | --- | --- |
| `@everchat/server` (`.`) | `Host` (the service of the loaded chats) and `Host.layer(options)`; `serve(options)`: the layer that serves the routes of section 3 over the `HttpServer` in its context, and gives `Host`; `serverOptions(limits)`: for the limits in use, the numbers of that server (`idleTimeout`, and `websocket`'s `idleTimeout`, `maxPayloadLength`, `closeOnBackpressureLimit` and `backpressureLimit`; section 8, "Limits"). A caller builds its `BunHttpServer` with those numbers and no others (`packages/server/src/index.ts:1-7`; lead, ec-fhomd, rulings 4 and 8) | every build with HTTP: `everchat serve` now, the server build later |
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
  // The secret of the deployment: 32 bytes or more. The layer fails at its start on a
  // shorter one, with SecretTooShort.
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
| `Chats` | `chatsLayer(file)` over its own file, `serve.db` in the home | `packages/sqlite/src/sqlite.ts:1220-1221` |
| the stack | the stack of a host's chat (`hostedStack`): the local stack with the hosted set of functions (below), as a function of a store (its shape below the table) | `packages/local/src/hosted.ts`, `hostedStack`; the terminal keeps its own (`packages/local/src/main.ts`, `layer`) (ec-lw754) |
| the author's inference gateway | `gatewayLayer`, built one time for the process and given to each stack | `packages/local/src/gateway.ts:60-66` |
| the HTTP server | `BunHttpServer.layer({ hostname: "127.0.0.1", port, ...serverOptions(limits) })`, as the inspector has it but with the numbers of `serverOptions` (at the defaults `idleTimeout: 190`, `websocket: { idleTimeout: 120, maxPayloadLength: 524288, closeOnBackpressureLimit: true, backpressureLimit: 8388608 }`; section 3, "Admission", 9) | `packages/local/src/inspector.ts:131-136`; `packages/server/src/serve.ts:168-182`, `serverOptions` |
| the secret | 32 random bytes, new at each start, kept in memory only | lead, ec-mxcl, decision 5 |
| the page and its two routes | under a path that starts with a random value of the start (section 7) | lead, ec-mxcl, decision 5 |

**The stack of a host's chat (`hostedStack`)** (`packages/local/src/hosted.ts:145-176`;
ec-lw754). An effect
with a `Scope`: it builds, one time for the process and in that scope, what holds no
chat's state (the wire, over the author's inference gateway), and it gives the function of
a store. For each store, that function's layer builds every part that holds a chat's
state, for that chat alone. Its shape, as the file has it:

```ts
interface HostedOptions<E> {
  readonly compactor: Pick // the compactor's model
  readonly hub: number // the turn loop's hub's capacity, from 1 to 65,536
  readonly max?: number | undefined // the cap of one answer in tokens (MAX: 16,384)
  readonly deadline?: number | undefined // the deadline of one program in ms (DEADLINE: 600,000)
  readonly calls?: number | undefined // the count of the calls of one program (CALLS: 256)
  // For the tests: the wires in place of the gateway's. Built one time, as that one is.
  readonly wire?: Layer.Layer<VendorWire, E> | undefined
}
// The stack of one chat over its store, as `HostOptions.stack` has it.
type HostedStack = (store: typeof Store.Service) => Layer.Layer<Turns | Memory, unknown>
const hostedStack: <E = GatewayError>(options: HostedOptions<E>) => Effect.Effect<HostedStack, E, Scope.Scope>
```

Its `Turns` runs `say` and `stop` under the chat's own loggers (`ownLogs`; section 2,
Load, step 2). It names the list of a chat's functions, `HOSTED`, one time for the
process, and makes the head from it one time (`head`); it gives that head to the turn
loop's layer and to the compactor's by their one option, `head`, and the list to
`hostedLayer(declarations)` (`packages/local/src/hosted.ts:156-157, 169-173`; ec-0di3a;
ec-u3nf8).

**The functions of a host's chat: the hosted set.** A chat of the host has no `shell` and
no file functions (`read`, `write`, `edit`): only the functions that need no machine
(lead, ec-mxcl, decision 2; for a hosted chat, `docs/design.md`, "Tenants and isolation"
[Q5, Q8, Q13]). The reason: the host is the trial of the hosted use, and a page that
reaches a shell through HTTP is a risk with no use here. So no chat of the host needs a
work directory or an environment. The set is the core's `HOSTED`: `zoom`, `date` and
`result` (`packages/core/src/functions.ts`: `ZOOM`, `DATE`, `RESULT`), whose functions
`hostedLayer(declarations)` gives over the store and the memory: a function of the
stack's list, which dies at its build when its entries' declarations are not that list
(`packages/core/src/functions.ts`, "One list for each stack", `make` and `mismatches`;
ec-0di3a). The core's `result` reads the call's
whole output from the store (`store.call`) and writes no file (ec-o9i2n). The output limit
of a host's chat writes no file either: the core's `noFileLayer`
(`packages/core/src/limit.ts`) names `result(id)` only. The set is a parameter (the
stack), so that the
operator's other answer, the local functions, changes one caller: the stack that
`everchat serve` gives. The sandbox stays as the design wants it for a hosted chat: a new QuickJS
engine for each program (`packages/codemode/src/thread.ts:184-190`; [Q5, Q8, Q13]).

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
  ec-vgn58, A1). The channel's `addClient` dies for a `given` that is not a safe whole
  number from 0, before every other check, and adds no client: a defect of the caller,
  since the routes check the number first (`packages/server/src/channel.ts:323-343`, `addClient`;
  lead, ec-ajj5m, 4);
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
`packages/core/src/turn.ts:292-303`; lead, ec-vgn58, A2). A give never waits: a full
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
  after the last page was given to it, or after its first read started (section 8, "A
  slow client"; lead, ec-7bi64, G2; lead, ec-0r89g, W2). On R6 the first read starts when
  the snapshot frame was put, so a snapshot that waited for its place takes nothing from
  these 30 s. A page that was dropped does not start the 30 s again: they run from the
  last page that was given. When the read is at the store's end (a call
  of the store gives fewer events than it asked for: section 8, "Pages"), the client
  **joins**, under the give lock, in the same step as a check of two parts (lead,
  ec-9p347, T9): its `given` is `last` or more, or the channel has no `last`; and its
  buffer has room for one entry of `entry` bytes. When both hold, it joins. Else it does
  not join: it reads the events after its `given` again, as above (step 1's wait for room
  for a page, a read), and checks again. `last` is what the clients that joined were
  given (above), so a client whose `given` is below it reads on first (lead, ec-12a32,
  N3). So no event comes between the client's read and the gives that reach the clients
  that joined: every numbered event up to `last` is in the store, because the turn loop
  publishes an event only after its commit (`record` and `recordPush`,
  `packages/core/src/turn.ts:292-331`). And a
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
  it became a client. These 30 s are the snapshot's own: the first read's run from its
  own start, after the frame was put (lead, ec-0r89g, W2). So a snapshot never ends a
  client by its size. A ping is put only
  into an empty buffer. A `said` or an `error` is put when its `say` is answered; one that
  finds no room ends the client as `slow`, as a give does. The frame of an end (R4's
  `close`, R6's close code) is not in the buffer.

Three more steps of the channel run under the give lock, each as one step that an
interruption cannot split and that does not wait (ec-72ky4; lead, ec-mhmpr, C; ec-fhxnm;
`packages/server/src/channel.ts:417-453`: `listen`, `lowestGiven`, `cannotGive`): the listener's
start, which chooses and sets `last` (Load, step 3); the read of the lowest `given` of the
clients that joined, where an unload's read starts (Unload, step 2); and an event that
cannot be given (section 8, S2), which ends with `internal` each client that joined whose
`given` is below its number, and sets `last` to that number when it is higher. The read
goes on after that event: each other client that joined needs nothing up to it.

A **loaded chat** is the chat's store (`Chats.store`, which writes a launch row), its stack
built over that store in a scope of its own, and the channel's listener (below). The host
never opens a second store of a chat that it holds: a second request for the chat finds
its channel, and so its one loaded instance (lead, ec-mxcl, decision 6). Today a second
`Chats.store` of a held chat closes the first launch as a crash, and both stores could
write (ec-f7m3i Q2); and "one turn at a time" is held only by the one `Turns` of a chat
(`packages/core/src/turn.ts:261, 272`; ec-f7m3i Q3). So one instance is the rule that keeps
both. Two processes on one file: the store's refusal of a live launch of this host
(`LaunchLive`, `packages/sqlite/src/sqlite.ts:753-754`) stays the wall for the local use.
The host answers it with `409 chat_elsewhere`. The lease is the server plan's [Q22].

### Load

The host loads a chat for a message in (a `POST`, or a `say` frame of a socket), under
the channel's lock:

1. `Chats.store(tenant, chat, launch)`: the chat by its tenant and its UUID; `NoChat` for
   any chat that is not the tenant's (`packages/core/src/store.ts:369-376`). The launch
   row is written.
2. The stack, built over that store, in the loaded chat's scope. A load makes all again
   from the database (`docs/design.md`, "Tenants and isolation" [Q12, Q20]): the turn
   loop restarts a cut turn and closes cut calls (`packages/core/src/turn.ts:685-706`),
   and the memory loads from the database (ec-f7m3i Q8). Of the stack's context the host
   takes only `Turns` and `Memory` (`packages/server/src/loaded.ts:97-103`, `LoadedChat`), and it
   calls `Turns.say` from its own fibers (`packages/server/src/host.ts:259-268`, `work`). The turn
   loop forks a turn, and the memory a compaction, from the fiber that calls, so they log
   with that fiber's loggers. So the stack's `Turns` runs `say` and `stop` under the
   chat's own loggers (`packages/local/src/hosted.ts`, `hostedStack` and `ownLogs`), and
   what a turn or a compaction logs (a retry of a request, a compaction that failed) goes
   to the chat's own `everchat_log`, not to the host's own diagnostics (the standard error)
   (lead, ec-olqwa; ec-lw754;
   the case "two chats of two stores at one time" of `packages/local/src/hosted.test.ts`).
3. The listener: the host subscribes to the turn loop (`Turns.subscribe`,
   `packages/core/src/turn.ts:246-249`), and reads the chat's `seq` from the store. Then,
   under the give lock, in one step, it chooses and sets `last`: the lower of that `seq`
   and the lowest `given` of the clients that have joined, or, with no client that joined,
   that `seq` (lead, ec-12a32, N1, N4; lead, ec-mhmpr, C; ec-fhxnm). A client's `after`
   never raises `last` above the store's `seq`. A client that has not joined does not count: it reads on by itself, and the
   join's check covers it. So a join cannot fall between the choice and the set. Then the
   listener reads the events after `last` from the store (`eventsAfter`,
   `packages/core/src/store.ts:395-401`, in pages: section 8, "Pages"); gives each
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

The load's last step is its publication, and its point of no return (lead, ec-mhmpr, B;
ec-fhxnm; `packages/server/src/loaded.ts:390-404`): the listener's fiber starts in the
loaded chat's scope and the timer's in the loader's, then one step sets the channel's
loaded chat and puts it in the loader's list. No interruption splits it. An interruption
in it or after it goes to the caller and does not undo the load: the chat is loaded,
whole, the next message finds it with no second launch row, and the timer unloads it
(below, "Work, and the 6 minutes"). A load that fails or is stopped before its
publication closes what it made (below, "The deadline of the work under the lock").

A read needs no load. The snapshot, the older messages and the events after a number
come from the chat's reads (`Chats.reads`, `packages/core/src/store.ts:548`), which take no
launch. A client that only reads never loads a chat.

### Work, and the 6 minutes

An idle chat uses no memory: the host unloads it after 6 minutes with no work
(`docs/design.md`, "Tenants and isolation" [Q12, Q20]). Work is a turn that runs, a
compaction that runs, or a call that runs (lead, ec-mxcl, decision 10). A connected
client is no work: the chat unloads and the client stays connected to its channel.

The host's timer of a loaded chat: a fiber that sleeps until 6 minutes after the last
work, then takes the channel's lock, and unloads the chat when it has no work and its last
work is 6 minutes old or more; else it sleeps again until the new time. It reads two
values that the core gives with no wait (ec-f7m3i Q8, gap 1; section 9; ec-9txv3): "busy
now", `Turns.busy` and `Memory.busy`, and the time of the last work, `Turns.worked` and
`Memory.worked`, in milliseconds of Effect's `Clock` (`packages/core/src/turn.ts`,
`packages/core/src/memory.ts`). `Turns.idle` and `Memory.idle` wait; the timer does not
use them.

### Unload

Under the channel's lock:

1. The host closes the loaded chat's scope. This ends the launch row (`exit`), and frees
   what the scope holds (ec-f7m3i Q1, "Closing a chat's scope frees"): the turn loop and
   its hub, the memory and its caches, the cache watch, the diagnostics batch (flushed),
   the sandbox's layer. With no work there is no turn fiber, no compaction and no program.
2. The host reads the events after the lowest `given` of the clients that have joined
   (read under the give lock, in one step: above, "The give") from the store, in pages (section 8, "Pages"), and gives them (above, "The give"; lead,
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

**The host's stop** (lead, ec-yculc, 2; lead, ec-mhmpr, A; ec-fhxnm). It begins with the
registry's stop: from it on, the registry refuses each new client (what a client gets at
the stop: section 3). The loader's end comes last (`packages/server/src/host.ts:314-324`, the
layer's end; `packages/server/src/loaded.ts:417-431`). It refuses new loads, asks each
load under way to stop, as a deadline does (the load's steps that wait are interrupted,
and the load closes what it made, under the lock that its caller holds), and waits until
none is under way; then it unloads each loaded chat under its channel's lock (steps 1 to
3 above). It closes nothing of a load under way itself: no scope and no launch row.

### The deadline of the work under the lock

The work under a channel's lock for a message in (a load; the log of one message and the
start of its turn) has a deadline of its own: 20 s from the moment it takes the lock (the
limit `lock`; lead, ec-7bi64, I3). **A deadline asks; the work's end frees** (lead,
ec-12a32, O). At the deadline the host asks the work to stop (it interrupts it). The lock,
the request's place and its holder go back when the work has ended, never before: no work
runs on after its owner let go, and nothing is detached (O2). This is one rule for every
end of a request: its deadline, its client's end, a fault of its connection (lead,
ec-349x0, Q1; section 3, "Admission", 5).

- **The log of a message stays as the core has it** (O1): from the take of the memory's
  lock to its publish no interruption cuts it (ec-fjqiq; ec-p9osd). `Memory.apply` is
  `lock.withPermits(1)(Effect.uninterruptible(body))`: once the lock is taken, the
  memory's change, its write and `then` are one step
  (`packages/core/src/memory.ts:755-785`), and the log of a message publishes its events
  in `pushWith`'s `then` (`recordPush`, `packages/core/src/turn.ts:310-331`; `record`,
  `:292-303`, does the same for a write that is not the memory's). So an interruption that
  comes in that step waits for its end: the order of the commit and the publish holds, and
  a message that was committed is published. Section 9 asks for no change of this. An
  interruption ends a wait for the memory's lock: nothing is written and no event number
  is taken, and the same key then logs the message one time. What a cut wait loses is a
  paid answer of the model with no `usage` row: a compaction's, whose write waits for that
  lock too, or a turn's step; the next load or the restart asks again (the comment of
  `pushWith`, `packages/core/src/memory.ts:584-587`; ec-v44v7). The step after the publish
  is in it too (section 9, item 9; ec-ts3qg): `Turns.say` forks the turn that its log
  began (`launch`) in the log's uninterruptible step, after the publish (`recordPush`'s
  `next`, `packages/core/src/turn.ts:664`). So no interruption leaves a turn's row running
  and its `start` published with no fiber to run it, which would make the next message
  begin a second turn; and a fork does not wait. The host's work calls `Turns.say(text,
  key, told)` with no uninterruptible wrap (`packages/server/src/host.ts:259-268`, `work`): the
  deadline cuts `say`'s waits for the turn loop's lock, for `order` and for the memory's
  lock; `told` runs in the uncut step after the launch.
- **The store bounds the part that cannot be interrupted** (O3). Each call of the store
  ends, done or with a typed fault, within the limit `store` (5 s), by the store's own
  timer on the call (section 9, item 9); a transaction counts as one call. On SQLite the
  timer is the driver's own wait on the file's locks, and a call waits longer only behind
  calls of its own process on the one connection (lead, ec-0r89g; section 8, "What is not
  proved here"). The log of a
  message is one transaction (the memory's writes and the caller's, with the event rows,
  `packages/core/src/memory.ts:719-736`), so it ends within `store`. A write that fails
  so is rolled back, and nothing is published for it. After a write fails, the memory of
  that loaded chat refuses each later write (`packages/core/src/memory.ts:762-769`): so
  the host unloads the chat at once, under the same lock (Unload, steps 1 to 3), and the
  next message loads it again. Where the timer cannot tell whether a commit happened (a
  store on a network whose answer to the commit is lost), the message may be in the log
  with no answer: the key gives its numbers again on the retry (section 5).
- **A load that is stopped** closes its scope as an unload does (Unload, steps 1 to 3).
  The close is work too, under the lock. Its calls of the store, one after the other:
  the one write that was in flight when the stop came (the memory's writes are one at a
  time, under its lock, `packages/core/src/memory.ts:755-785`; the close cuts the
  compaction writes that wait for that lock, and only the write in flight ends,
  ec-fjqiq); the flush of the
  diagnostics batch (`packages/core/src/diagnostics.ts:125-132`); the end of the launch
  row (`packages/sqlite/src/sqlite.ts:779-784`, registered at `:804`); and the read of
  Unload step 2, one call for each 100 events that the load wrote (the restart's: a
  `start`, and the pages of a cut program's `tool` and `echo`,
  `packages/core/src/turn.ts:685-706`), so one call when it wrote at most 100 events
  that fit one page; large events need more ("Accepted risks", 1).
- **A turn that started is never stopped because a request ended**: it runs in the
  loaded chat's scope, not in the request's (`Turns.say`,
  `packages/core/src/turn.ts:618-667`).

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
Work under the lock that ended with success is answered with its success, also past the
`lock` deadline; `503 busy` is for work that the deadline cut (lead, ec-y11ev, 2;
ec-p9osd; `packages/server/src/host.ts:277-312`, `say`). The request's own deadline (`request`)
is another clock: a log whose step had begun its commit when it passed ends that commit,
and the answer is still `503 busy`. So a `503 busy` of R1 does not say that the message
was not logged (lead, ec-jbry3, X7; section 3, R1, its errors).

### Accepted risks

The cases that pass a sum of the page, which the lead keeps as risks (lead, ec-349x0, R3
and S3; review ec-du4ps). Each has four points: the conditions, why it is rare, how it
fails safe or is recovered, and what would fix it. Section 8, "What is not proved here",
names the first for the beads of the store and the server. A log that waits for the
memory's own lock is no risk now: the deadline cuts that wait, and the lock is free at
`lock` (20.000 s measured; the work ends `ChatBusy`, and nothing is logged; it was
29.983 s), `packages/server/src/deadline.test.ts:490-518` (lead, ec-jbry3, X5).

1. **The replay of a stopped load reads by fitted pages** (ec-du4ps, finding 1).
   - Conditions: a load is stopped at its deadline while it replays a restart with large
     events, and each call of the store takes nearly its whole timer. A page closes
     before the entry that would pass `page` (section 8, "Pages"), so a replay of fewer
     than 100 events can need more than one call: the reviewer's trace, a restart of 14
     events, needs 2 calls, not 1. The lock is then free at `lock` + 6 × `store` after it
     was taken, 50 s at the defaults, not 40 s: the listener's read in flight at the
     deadline, the restarted turn's call (`messagesAfter`) in flight at the close, the
     flush, the launch's end, and the unload's read in 2 calls (49.984 s measured,
     `packages/server/src/deadline.test.ts:466-475`). The risk stays (lead, ec-jbry3, X4).
   - Rare: it needs a store that is slow on every call at the moment a large restarted
     program is replayed.
   - Fails safe: the lock and the place stay held, and nothing is detached. A message in
     that time gets `503 busy` with `retry-after`, and nothing is lost. It ends when the
     cleanup ends.
   - What would fix it: count the fitted pages in the sum, or bound the replay of a
     stopped load.
2. **A store's limits are set lower than it was written under** (ec-du4ps, finding 2;
   section 8, "The checks at start", S).
   - Conditions: a deployment lowers the limits on a store that holds a larger event. The
     reviewer's trace: `text` at 192 KiB, then the defaults; an `accepted` event of
     1,180,583 bytes against an `entry` of 1 MiB.
   - Rare: it needs a change of the configuration downward, which no work of the host
     makes.
   - Recovered: the host does not give that event: it ends with `internal` each client
     that joined whose `given` is below its number, and the read goes on (section 8, S2;
     "The give"; `packages/server/src/channel.ts:442-453`, `cannotGive`); its log line names the
     event's number and size. Start again with
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
  (`packages/codemode/src/thread.ts:188-189`);
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

**A route's path** (lead, ec-5tdje, 1 and 2). A route's path is exact on the target as the
server gives it. Bun parses a request's target as a URL before any code of Effect or the
host runs, so the wire's spelling is not there to read. A target that this parsing makes
equal to a route's path is that route's request, with the same checks on the same text: a
dot segment (`./` or `../`, in any place; `%2e` or `%2E` for a dot of one, in any mix:
`%2e./` and `%2e%2E/` too, measured, ec-ajj5m), a backslash for a slash, and the
absolute form (`GET http://any.host/v1/...`: the host is dropped). A
target that it does not make equal is no route: `{chat}/.` and `{chat}/messages/..` (both
end with a slash after the parsing), two slashes, an encoded slash, an encoded letter, an
encoded percent sign (`%252e` stays as it came, measured, ec-ajj5m),
`;`, another letter case (in `{chat}`, such a text is one that check 3 refuses). No check
is passed by a spelling. A front of a hosted deployment must not decide access by a
path's spelling (`packages/server/src/serve.ts:29-43`, the head comment; the probe of ec-5tdje).

**R4 or R5 by `Accept`** (lead, ec-ajj5m, 2; ec-71ism). A `GET` of the events is R4 when
the header `Accept` names the media type `text/event-stream` in its list, letter case and
parameters aside (`text/event-stream;q=0.9` too), but for a part whose `q` is zero: such a
part does not name the stream. A `q` of zero is RFC 9110's qvalue of zero: `0`, `0.`, and
`0.0` to `0.000`, with the parameter's name in any letter case (`Q` too), and spaces
around the name and the value aside. A `q` that is no weight (`q=x`, `q="0"`, `q=0.0000`) is
aside, as every other parameter is; another part of the list that names the stream still
does. Else the request is R5's, with no `Accept` too. The list is read in one pass: a `,`
ends a part and a `;` a parameter, but not inside a quoted string (RFC 9110): a `"` opens
one, the next `"` that no backslash takes ends it, and in it a backslash takes the next
character with it; a quoted string with no end runs to the text's end. So a quoted value
is one piece, and a `,` or a `;q=0` in it ends nothing:
`text/event-stream; profile="https://example.test/p;q=0;v=1"` is R4
(`packages/server/src/serve.ts:200-247`, `partsOf` and `wantsStream`).

**No route** (lead, ec-1bxkn, 1). A request that is no route, or whose method is not its
route's (a `HEAD` too, and `OPTIONS` on R6's path), gets `404` with no body. It takes a
place ("Admission", 3), so with every place taken it gets `503 busy`, and it runs no check
and no work (`packages/server/src/http.ts:701-710`, `none`).

### The checks of each request, in their order

**The place, the `Host` and the method come first** (lead, ec-g3gkl, 1; lead, ec-olqwa).
A request takes its place first ("Admission", 3). Then, when `serve(options, local)` gave
the gate its `authority` (the local command, section 7, "127.0.0.1 only"), the check of
`Host` comes right after the place, while the host serves: on every route, the preflight
(R7) too, and on a path that is no route. After `serve`'s end mark, every request gets
`503 busy` before the gate, with no `Host` check ("Admission", 12; lead, ec-dkhr1). A
`Host` that is not `authority`, byte for byte (another letter case or port, two values),
gets `403 forbidden_origin` with no CORS header, and its place goes back at once. Without
`authority` there is no such check, and no `Host` is read: there an HTTP/1.0 request with
no `Host` goes on to the route's checks (`packages/server/src/http.ts:410-411`). Then the
method: another gets
the answer of no route (above, "No route"). The order, as `packages/server/src/http.ts:509-871`
has it: R1 to R5 (`route`) and R8 to R10 (`local`): the place, the `Host`, the method,
then their checks (R8 to R10: the origin, then the work; section 7); R6 (`socket`): the
place, the `Host`, the method and `Upgrade: websocket`, check 1, then its work; R7
(`preflight`) and no route (`none`): the place, which goes back at once, then the `Host`,
then check 1 (R7) or the `404` (no route).

Each route R1 to R6 runs these checks, in this order, before it reads a body:

1. **The origin.** A request with an `Origin` header whose value is not on the host's list
   gets `403 forbidden_origin`. A request with no `Origin` passes this check, whoever sent
   it: a browser too sends no `Origin` on a `GET` to its own origin, and none on a `GET`
   with no CORS (an image, a script). The token is the wall, because a page cannot put
   `Authorization` on such a request. A later route that takes no token must not lean on
   this check (lead, ec-9p347, T1). The local command's list is its own origin only
   (section 7). R7 runs this check only ("Origins").
2. **The token** (section 6): the header `Authorization: Bearer <token>`, its signature,
   its claims, its end time. Any failure gets one answer, `401 unauthorized`, that does
   not say why; the reason goes to the host's diagnostics (lead, ec-mxcl, decisions 4 and
   11). R6 takes its token from its first frame instead, and reads no header
   `Authorization` (above, "A token's place"; below).
3. **The chat.** A chat that the token does not name gets `404 no_chat`, the same answer
   as a chat of another tenant or a UUID that no chat has (`NoChat`,
   `packages/core/src/store.ts:369-376`). A path's chat that has no UUID form gets this
   answer too, never `400` (`packages/server/src/http.ts:24-27`, the head comment, check 3). A
   tenant cannot learn that another tenant's chat exists, nor that a chat outside its
   token exists.
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
   `1009`. The 512 KiB of a frame hold only after `ready`; before it Bun may still hold
   up to `body` of one frame, which the host then closes with `1009` (item 6; lead,
   ec-jbry3, X1). (D2)
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

   **The server's own answers are not requests of the host** (lead, ec-5tdje, 2). Effect's
   Bun server answers `CONNECT` with `501` before the host's handler; Bun answers a tab or
   a space in the target with `505`, `*` or a target that starts with a backslash with
   `400`, and ends the connection with no answer for a method's name that it cannot parse
   (`FOO`, `get`). Bun answers an HTTP/1.1 request with no `Host` with `400` too, on
   every route and on no route, before the host's handler: so with the local command's
   `authority` such a request gets the server's `400`, not the gate's `403` (section 7;
   the probe of
   ec-yi50l; lead, ec-olqwa). These take no place, run no check and write no line of the
   gate's log, at any load (`packages/server/src/serve.ts:58-67`, the head comment; the probe of
   ec-5tdje).
   Every method that Bun parses reaches the gate. So does an HTTP/1.0 request with no
   `Host`, which that version allows: it takes its place as any request (`503 busy` with
   `retry-after: 1` when none is free), and then, with the local command's `authority`,
   the gate answers `403 forbidden_origin` and writes its line, since a `Host` that is
   not there, or is empty, is not `authority` (`packages/server/src/http.ts:410-411`,
   `wrongHost`; section 7; ec-nd04w; ec-m17io; lead, ec-olqwa).
4. **Waits.** A body is read in at most 10 s, else `408 timeout`, and the connection
   closes. A message in waits for its channel's lock at most 10 s, else `503 busy` with
   `retry-after: 1`, and nothing is logged; with a key, the client sends it again safely
   (section 5). The channel's lock is held for a load, an unload, or the log of one
   message and the start of its turn: not for the turn, which runs after the answer
   (`Turns.say`, `packages/core/src/turn.ts:618-667`). The work under the lock has a
   deadline of 20 s, and the lock is free when that work has ended (section 2, "The
   deadline of the work under the lock"). (D4)
5. **An end** (lead, ec-349x0, Q). However a request ends (its deadline, its client's
   end, a fault of its connection), the host asks its work to stop, and gives its place
   back and lets go of its channel (and, for a message, of the channel's lock) when that
   work has ended, never before (section 2, "The deadline of the work under the lock";
   O2). The end by the client changes one thing only: no answer is written. A message
   whose transaction was done before the end stays logged; its key gives its numbers
   again (section 5). (D5, Q1 to Q3)

   **The place of a client** (lead, ec-1bxkn, 2, as the lead changed it; ec-w86sz). After
   the client's step, the gate's `abandon` runs exactly one time, whatever ends the
   client: its stream's end (done, failed or interrupted), no start of its stream by the
   deadline, a work that fails after the step, or a request interrupted before the
   stream's start. A route puts its client's end in `abandon` (`packages/server/src/http.ts:214-237`,
   `Steps.client`).

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
   - 256 sockets that wait for their `auth`, each with at most one frame of `body`
     (512 KiB) that Bun holds: 128 MiB in all, each for at most 5 s. Bun's bound of a
     frame, `maxPayloadLength` of its `websocket` options, is one bound for the whole
     server, and it is `body` (`serverOptions`). A frame over it is refused at its header
     (`1009`, nothing held). A frame under it is held whole before the host gets it; the
     host then applies `early` (8 KiB, item 2) and closes with `1009` (lead, ec-jbry3, X1;
     the measure of ec-1d6p0);
   - and nothing in a channel: no channel, no holder, no buffer.

   That is 256 requests in flight and 256 sockets that wait: 512 places, and 128 MiB of
   frames, and the longest wait is the 5 s of an `auth`. These are requests and sockets,
   not connections: the host counts what Bun gives it, and Bun holds connections that it
   gives to no one (item 9). With a good token the bound is 256 requests, each with a body
   of at most 512 KiB (128 MiB in all), each until its work has ended, its client there or
   gone (item 5): 35 s by the sum for the common case, or 50 s when its work is a load
   that is stopped or a log whose write failed (item 10; section 2, "Accepted risks"); the
   reads of `reads` and the answers of R2, R3 and R5 that are held while they are written
   (section 8, "Pages", "The sums of memory for reads", (b) and (c): 634 MiB and 512 MiB
   at the defaults); and the clients (section 8).
7. **The local routes R9 and R10** have their own limit, not a chat's: R9 at most 10 in a
   minute, R10 at most 60 in a minute, for the host. Each request that passes the start
   value and the checks of `Origin` and `Host` counts, whether it then succeeds or not.
   (D7)
8. **One rule for both rates** (messages in for one chat; R9 and R10): a fixed window of
   60 s that starts at the first request counted. Past the limit, `429 too_many` with
   `retry-after`: the whole seconds to the window's end, rounded up. For messages in, each request
   that passes checks 1 to 3 counts, a repeat of a key too. (D8)

   For messages in, as built (lead, ec-0lqto, 1; ec-6jsmq): the seconds of `retry-after`
   are at least 1. A window is new, its count 1 from now, when it has ended and when the
   clock is before its start (a clock that steps back). The windows are the host's, in a
   map by the tenant and the chat's UUID, not the channel's. The caller counts
   (`Host.count`); the message in (`Host.say`) does not (`packages/server/src/host.ts:240-257`,
   `count`).
9. **Connections that the host cannot count** (lead, ec-7bi64, H2). Bun gives the host
   requests, not connections, and not the heads that it answers itself (item 3). A
   connection whose head has not come, or that is idle
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
     with `idleTimeout: 190`, twice the longest silence at the defaults, less at most one
     tick of 4 s (below; section 1; lead, ec-12a32, L; lead, ec-jbry3, X2). It closes a
     connection that is idle between requests after about 190 s (one idle after a `401`
     closed at 192.1 s). Bun takes at most 255: it refuses 256 at its start
     ("Bun.serve expects idleTimeout to be 255 or less", Bun 1.4.4). A connection whose
     head does not come, and a head that comes one byte each 10 s, Bun closes at about
     12 s, not at 190 s (the measure of ec-fhomd).

     **Bun's ticks** (Bun 1.4.4; the probes of ec-fhomd). Bun counts the idle limit of
     HTTP in ticks of 4 s: an `idleTimeout` of 1, 2 or 4 resets a quiet answer at 4.0 s,
     one of 5 or 8 at 8.0 s. A stream's own writes reset the limit only from 2 ticks on:
     at an `idleTimeout` of 4 or less, every answer is reset at 4 s, pings or not. At the
     defaults 190 is 48 ticks, so a quiet answer may be reset from 188 s: far over the
     longest silence (95 s), so the sums hold (X2). `serverOptions` gives `idle` in whole
     seconds, rounded up, and does not round it to ticks. So an `idle` of 4,000 ms or less
     ends every stream at 4 s, whatever the host writes, and the check at start (`idle` at
     least twice the longest silence) does not refuse such an `idle` under small limits
     (lead, ec-jbry3, X3);
   - **in count**, the limit of open files of the process, and in a hosted deployment the
     front that stands before the host. Both are the deployment's bounds, not the host's
     (section 8, the limits table). At a limit of 4,096 open files the server held 4,086
     connections with no head, its resident memory hardly moved (76,016 kB before, 76,344
     kB at most), and a request then got no answer in 5 s (the measure of ec-fhomd). So
     the bound of connections with no request is the limit of open files, and Bun's 12 s.
     `everchat serve` listens on 127.0.0.1 only, so only a process of this machine can
     open them.

   **The longest silence** (lead, ec-12a32, L1). For each way, the longest time in which
   the host sends no byte to a client that waits, with the limits' names (section 8):

   | Way | Its longest silence | At the defaults |
   | --- | --- | --- |
   | R4, once its stream started | `ping`, between two pings | 15 s |
   | R4 before its stream starts | `request` + `store`, from its head to the stream's head and its first `: ping`: its checks and its step "a client now"; nothing of the store is read before the stream but the checks' (item 10; lead, ec-5njke, 3) | 35 s |
   | R2, R3, R7, R9, R10 | `request` + `store`, from its head to its answer (item 10) | 35 s |
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
12. **The host's stop, as a client sees it** (lead, ec-yculc; ec-fhomd). From the host's
    stop on, the registry refuses each new client (section 2, "Unload", "The host's
    stop"): R4 and R5 get `503 busy`, R6 `4503`. `serve` answers a request that comes
    after its end began with `503 busy` and `retry-after: 1`, with no route: no gate, no
    place and no line of the gate's log (`packages/server/src/serve.ts:74-96`, the head comment,
    and `:298-359`, `tracker`). A client connects again by the rule for `busy` ("The order and the
    numbers", 3).

The host's own lines of the log, the gate's among them, are Effect's log. None holds a
text of an event, a token, a query or a header's value: the gate's line has the route, the
status, the error's code, the token check's number and the name of a fault
(`packages/server/src/http.ts:349-357`, `note`); the others have a route, a reason, the name of a
fault, an event's number and type, a size in bytes, or the name of a call of the store.

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
preflight from an origin that is not on the list gets `403 forbidden_origin`. A preflight
with no `Origin` gets `204` with no `access-control-` header. R7 takes a place, runs
check 1 only and reads no store (`packages/server/src/http.ts:789-803`, `preflight`). R6 refuses
an upgrade from an origin that is not on the list with `403 forbidden_origin`, before the
upgrade. `serve`'s `503 busy` after its end began ("Admission", 12) has the origin's
headers as the gate's answers have them: for an `Origin` that is on the list, byte for
byte, `access-control-allow-origin` with it and `vary: origin`; for another `Origin` or
none, neither; never `access-control-allow-credentials`. An `OPTIONS` gets that answer
too: it is no preflight (`packages/server/src/serve.ts:249-262`, `busyAnswer`; lead, ec-ajj5m,
1). In a hosted deployment the list is the backend's web origins; locally it is the
host's own origin (section 7).

### R1: a message in

- Headers: `Authorization`; `Content-Type: application/json` (else
  `415 unsupported_type`); `Idempotency-Key` (optional, section 5).
- The order after check 3 (ec-d8u0s; `packages/server/src/post.ts`, the head comment):
  the rate's count ("Admission", 8), the content type, the key's form, the body (its
  read: `408`, `413`), the body's form; then the message in.
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
  limit, or the message waited 10 s for its channel's lock, or the deadline of 20 s of
  the work under the lock cut that work, or the request passed its 30 s with no byte
  sent: each with `retry-after: 1`), `500 internal`. Past its 30 s with bytes sent, the
  connection closes ("Admission", 10). Work under the lock that ended with success is
  answered with its success, also past the `lock` deadline; `503 busy` is for work that
  the deadline cut (lead, ec-y11ev, 2; ec-p9osd). The request's own deadline, its 30 s
  (`request`, "Admission", 10; `packages/server/src/http.ts:451-457`, `within`), is another
  clock: at it the gate asks the work to stop, and answers `503 busy` with
  `retry-after: 1` when the work has ended. A log whose step had begun its commit ends
  it, so the message is in the log and its turn starts, and the answer is still `503`.
  So a `503 busy` of R1 does not say that the message was not logged (lead, ec-jbry3,
  X7). A client sends the message again with the same `Idempotency-Key`, and gets the
  first message's numbers with `repeat: true` (section 5). One that sends it with no key,
  or with a new key, after a `503` may log the message two times.

### R2: the snapshot

- Query: `last` (optional): how many of the chat's last messages, from 1 to 200, in
  decimal digits only, at most 16 of them (ec-nz93a); 50 when it is not given.
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

- Query: `from` and `to`, whole numbers in decimal digits only, at most 16 digits each
  (a number above 2**53 - 1 is refused too), `0 <= from < to`, `to - from <= 200`
  (ec-nz93a).
- `200`: `{"messages": [<message>, ...]}`: the messages from `from` upward, up to and not
  with `to`, in the order of their ids (`Reading.messages`,
  `packages/core/src/store.ts:407`). An id that the chat does not have yet gives no
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

- Query: `after`, required (else `400`): the last event number that the client has, a
  whole number from 0 in decimal digits, at most 16 of them, at most 2**53 - 1 (ec-5njke;
  ec-7uw49; `packages/server/src/http.ts:315-322`, `wholeNumber`).
- `200` with `content-type: text/event-stream`. The stream starts when the request is a
  client: its head is sent at once, and nothing of the store is read before it; the first
  read starts with the stream (lead, ec-5njke, 3). First the events after `after`, read
  from the store, then each event as it occurs, with the pieces among them. A numbered event is
  one frame with its number as its id; a piece has no id:

  ```text
  id: 42
  event: start
  data: {"type":"start","n":42,"turn":9}

  event: text
  data: {"type":"text","turn":9,"delta":"Hel"}

  ```

- The stream's first frame is a comment line, `: ping`, told into the client's buffer at
  the client's step, before the first read: Bun writes a streamed answer's head only with
  its first chunk that is not empty, so the ping sends the head at once (lead, ec-5njke,
  9). Then, every 15 s with nothing to send, the host sends `: ping` again, so that a
  proxy does not close the stream. So a stream that started is never quiet for longer than
  15 s, and Bun's idle limit of 190 s, twice the longest silence, less at most one tick
  of 4 s, does not close it (section 3, "Admission", 9, "The longest silence"; lead,
  ec-12a32, L; lead, ec-jbry3, X2). Before its
  stream starts, R4 is quiet for 35 s, by the sum for the common case.
- The host ends the stream with a last frame `event: close`,
  `data: {"type":"close","reason":"<reason>"}`, and then closes it. The reasons: `token`
  (its token's `exp` passed), `slow` (its buffer was full, or its first read found no room
  for a page 30 s after its last page), `busy` (its first read waited 30 s for a place of
  `reads`), `stop` (the host stops), `internal` (a read met an event written under larger
  limits, which it cannot give: section 8, "The checks at start", S2; lead, ec-349x0, S2a).
- Errors before the stream starts are those of the checks, of the clients' limits, of the
  places and of the deadline (lead, ec-5njke, 3): `400`, `401`, `403`, `404`, `500`,
  `503 busy` (the chat or the host holds as many clients as its limit; or, with
  `retry-after: 1`, as many requests in flight, or the request passed its 30 s before it
  was a client: "Admission", 10). After the stream starts, a first read that waited 30 s
  for its place ends the stream with `close`, reason `busy`; one that found no room for a
  page 30 s after its last page, with reason `slow`; one that met an event that it cannot
  give (section 8, S2), with reason `internal`.
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
  ec-uoo8x, T5a). R5's client takes no piece: the channel gives it none
  (`addClient(given, { pieces: false })`, ec-cxuj5), so a burst of pieces cannot end its
  wait. So an event that is committed
  after the R5 became a client is never waited
  out. An R5 with `wait` 0, or with none, is never a client. R5 sends no byte before its
  answer: from its head to its answer it is quiet for `wait` + 2 × (`request` +
  `store`), 95 s, by the sum for the common case: the longest silence of the host, and
  Bun's idle limit of 190 s is twice the longest silence, less at most one tick of 4 s
  (section 3, "Admission", 9, "The longest silence"; lead, ec-12a32, L; lead, ec-jbry3,
  X2).
- Errors: `400`, `401`, `403`, `404`, `500`, `503 busy` (the chat or the host holds as
  many clients as its limit, for an R5 with a `wait` above 0: the limits of clients count
  it from its start, also when its first read finds events or it reads again (T5; lead,
  ec-hp7pq, V1); or, with
  `retry-after: 1`, as many
  requests in flight, or its read waited 30 s for a place of `reads`, or the request
  passed its 30 s with no byte sent, or no place was free when it took one again after
  its wait, or the host stopped while it waited: ec-1bxkn; ec-7uw49). Past its 30 s with
  bytes sent, the connection closes.

### R6: the WebSocket

- The upgrade: `GET` with `Upgrade: websocket`. The origin is checked first (above). No
  token in the address: the token is the first frame. A header `Authorization` on the
  upgrade is not read, and the socket still needs its `auth` (lead, ec-9p347, T3). The
  host answers no frame before it. With 256 sockets that wait for their `auth`, the host
  refuses the upgrade with `503 busy`, before the upgrade ("Admission", 2).
- Each frame is one JSON object as text: at most 8 KiB before `ready`, at most 512 KiB
  after it. A binary frame, a frame that is no JSON object, a frame of an unknown type, or
  a field that its frame does not name closes the socket with code `4400` (lead, ec-1d6p0,
  6). A frame over its size closes it with `1009`.
- **A frame at the wrong time** (lead, ec-9p347, T2). Before the host sent `ready`, `auth`
  is the only frame of the client: any other frame, a `say` too, closes the socket with
  `4400`. After the host took one `auth` frame, a second `auth` closes the socket with
  `4400`, at any time: a socket never changes its token (a new token is a new socket,
  section 6). So `4400` is every fault of a frame's form or time, and `4401` speaks of the
  token only. A client waits for `ready` before its first `say`.
- **One `say` of a socket at one time** (lead, ec-1d6p0, 6). Each `say` of a good form
  counts in the chat's rate ("Admission", 8). A `say` that comes before the answer of the
  `say` before it gets `error` with `busy`, and the socket stays open.
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
| `1009` | `too_large` | a frame over 8 KiB before `ready`, or over 512 KiB after it. A frame over Bun's `maxPayloadLength` (it is `body`, 512 KiB) Bun closes at its header, with `1009` and its own reason text ("Received too big message"), not `too_large`: the code is the page's, the reason is Bun's (ec-81998) |
| `4408` | `slow` | its buffer was full (a give, or a `said` or an `error` that found no room), or its first read found no room for a page 30 s after its last page, or its snapshot found no room for `page` bytes 30 s after it became a client (U2). For a socket the host's buffer is not the slow bound: Effect's Bun writer moves each text into Bun's send buffer at once. The server's `websocket` options `closeOnBackpressureLimit: true` and `backpressureLimit` = `bufferBytes` end a socket that falls behind, with `1006` and no close frame, so such a client gets no `4408`; `4408` stays for the host's own bounds: a frame of the host that finds no room, the 30 s of `room` (lead, ec-fhomd, 8; `packages/server/src/serve.ts:168-182`, `serverOptions`) |
| `4503` | `busy` | after a good `auth`: the chat or the host holds as many clients as its limit, or its first read or its snapshot's read waited 30 s for a place of `reads` (U3) |
| `1011` | `internal` | a read met an event written under larger limits, which it cannot give (section 8, "The checks at start", S2; lead, ec-349x0, S2a), or the snapshot's other fields alone pass `page` (section 4, "The snapshot"; U1a) |
| `1001` | `stop` | the host stops: a client's socket by its `stop`; a socket that is not a client yet (before its `auth`, or in its token's check) by the end of the HTTP server, not by the host: `serve` interrupts its request, and the socket's reader's finalizer, Effect's Bun server's, closes it with `1001` and no reason text (`ws.close`, `BunHttpServer.ts`, `closeCode`, platform-bun 4.1.2). The reason `stop` is the host's, for a socket that is a client; for the other, the code is the page's and there is no reason (ec-81998; ec-fhomd; review ec-8iqms) |

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
   `last` or more, or the channel has no `last`, and its buffer has room for one entry of
   `entry` bytes; else it reads on and checks again (section 2, "The give"; lead,
   ec-9p347, T9). Each event comes once,
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
   - After a connection that could not be made (a fetch that fails, a socket closed
     before its open): wait as after `busy`, so that a server that is gone is not asked
     in a loop (lead, ec-olqwa). The page's client does so
     (`packages/server/src/client.html`, `ended`, `socket` and `connect`).
   - After the other ends (the token's end, `slow`, `stop`, a fault of the network on a
     stream or a socket that ran): connect again at once. A socket's `1006` is a fault
     of the network (lead, ec-jbry3, X6).

   The host does not lean on these waits: a client that connects again at once is
   bounded by the host's own limits (the places, `reads`, the clients).
4. Drop an event whose number it has. A piece has no number: a piece that arrives after
   its message's `message` event, or across a new connection, is dropped by the client
   or shown again. Pieces are best effort [Q10, Q17].
5. **A chat's event numbers run with no gap**, one more each time, from 1: the store makes
   each event's number as the chat's `seq` plus 1, and writes the event's row and the new
   `seq` in one transaction (`addEvent`, `packages/sqlite/src/sqlite.ts:1076-1088`). So a
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

The numbered events are the store's `Event` (`packages/core/src/store.ts:212-217`), as
JSON, field for field. The turn loop publishes the same type, with the pieces: its
`TurnEvent` is `Event` and the three pieces (`packages/core/src/turn.ts:150-152`). The
store reads them again with the same fields (`eventsAfter`,
`packages/core/src/store.ts:395-401`):

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

- `chat`: from `Reading.chat` (`packages/core/src/store.ts:134-143`): the UUID, the pick and
  the goal. No draft and no views (lead, ec-mxcl, decision 7).
- `seq`: the chat's last event number; 0 with no event (`Chat.seq`,
  `packages/core/src/store.ts:140`).
- `count`: the id of the chat's next message (`Reading.count`, `packages/core/src/store.ts:406`).
- `messages`: of the last `last` messages (R2's query; 50 when not given; at most 200; R6's
  snapshot: the last 50), the longest run that ends at the chat's last message and fits
  (below), in the order of their ids. It may be empty. Its first message may have a higher
  id than the last `last` would give, and it may be a page in the middle of a text: R3
  reads the messages before it, as the client does for those before `last`.
- `turn`: the turn that runs (`Reading.runningTurns(null)`,
  `packages/core/src/store.ts:440`), or `null`: its id, its pick, its first message and its
  start time. Not its head, which is the whole system prompt.

All five are read in one snapshot of the store (`Reading.snapshot`,
`packages/core/src/store.ts:386`).

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
- **The key's place** (`docs/schema.html`, mark 6; ec-bu4bg). A column `sender_key` on
  `everchat_msg` (not `key`, a reserved word on MariaDB), `text` on SQLite, null for a
  message with no key, set on the row of the message's first page only, and written in the
  insert of the transaction that logs the message (the table refuses an update); and a
  unique index `everchat_msg_sender_key (chat, sender_key)`. Both SQLite and MariaDB let
  many rows have a null key under a unique index. It is kept as long as the message: for
  ever. To find the `accepted` number of a repeat, the store reads the chat's `accepted`
  row whose `msg` is the first page's id (`Reading.keyed`), by the index
  `everchat_event_msg (chat, msg)`. Left for MariaDB, in the `mariadb` package: the column
  as a `varchar(128)` in ASCII with a compare by bytes, its DDL, and the proof of its
  index.
- **The key's refusals** (ec-bu4bg, ec-p8n7o, ec-6vxao). The host's `400` for a key of
  another form stays the first wall. Behind it, the store's `append` refuses, and writes
  nothing: a key that is not 1 to 128 bytes of visible ASCII (`SENDER_KEY`,
  `packages/core/src/store.ts`); a key with no message; a key that the chat has (the
  unique index; `Turns.say` finds a repeat by `Reading.keyed` first); and a key that does
  not start a message (a keyed append after an append that ended with `more`). `Turns.say`
  refuses a key of another form before it reads or writes, with the store's error
  (`StoreError`, `append`), and that `say` alone fails: the chat's next `say` runs.
- **What the answer says**: the `accepted` event's number and the first and last page ids
  (R1, the `said` frame). The answer comes when the message is in the log; the turn runs
  after it (`Turns.say`, `packages/core/src/turn.ts:618-667`).
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
  store gives it (`packages/sqlite/src/sqlite.ts:289`).
- The largest token that `makeToken` gives, 64 chats with an `exp` of ten digits, is
  3,511 bytes, under the bound of 4,096 (measured with `Jwt.sign` of `effect/jose` and
  dummy key bytes; 100 chats would be 5,383 bytes).

The checks, in their order. The first that fails ends them, with the one answer of
section 3 (`401`, or the socket's `4401`), and a line of the host's diagnostics that gives
the check's number and no part of the token:

1. The header `Authorization` is there, and is `Bearer ` and the token (on R6: the `auth`
   frame's `token`).
2. The token is at most 4,096 bytes, and is three parts of base64url joined by dots.
3. The header's `alg` is `HS256`. Any other, and `none`, is refused, before any call of
   the library.
4. The signature is HS256 of the first two parts with the secret, compared in constant time
   (`Jws.verify` of `effect/jose`, over Web Crypto). `Jws.verify` on purpose: `Jwt.verify`
   would check `exp` and `nbf` before the claims' forms, out of this order (the comment in
   `packages/server/src/token.ts`; review ec-n7ws6).
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
decision 5). No line, answer or row ever holds it. A secret under 32 bytes fails
`Host.layer` at its start with `SecretTooShort`, whose error holds no byte of the secret
and not its length (ec-6jsmq; `packages/server/src/host.ts:100-106`, `SecretTooShort`, and
its check, `:197`).

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
(`packages/core/src/store.ts:536-549`). How a hosted deployment's backend reaches these
functions (a library call, a command, a service of its own) is the server plan's, not this
page's.

## 7. The local command

`everchat serve` starts the host on this machine. Only this command loads the host's
modules, by a dynamic import, as `everchat inspect` loads the inspector's
(`packages/local/src/main.ts`, `serveHost`).

- **Its options.** `--port <n>`: the port; 4681 when it is not given (the inspector's is
  4680, `packages/local/src/inspector.ts:45`); 0 for any free port. A port in use fails
  the start with a message, as the inspector's does (`NoPort`,
  `packages/local/src/inspector.ts:131-136`). The port 80 fails the start with `NoPort`
  too, before the file and the server are made: a browser gives no port in `Host` for
  the port 80, and the gate takes only `127.0.0.1:<port>`, so the page could not be
  served there (lead, ec-r4yb6, 4; `packages/local/src/serve.ts:104-111`, `host`). No
  other option.
- **Its file.** `serve.db` in the home (`EVERCHAT_HOME`, `packages/local/src/main.ts`,
  `HOME_VARIABLE` and `homeOf`), next to the terminal's `everchat.db`. The file is its
  own, because the local layers refuse a file with more than one tenant or chat
  (`packages/sqlite/src/sqlite.ts:323, 332`), and the host's file has many chats. It is
  made when it is not there.
- **One process for a home** (lead, ec-wp0xs, 9). The command does not lock its file.
  One `everchat serve` for a home is the help's rule (`packages/local/src/main.ts`,
  `ABOUT_SERVE`). A second one on the same home needs another port; then a chat that one
  process has loaded answers `409 chat_elsewhere` to a message in the other, and the
  other's connected clients get no live event of that chat until they connect again. No
  data is lost. A lease is the server plan's [Q22].
- **Its tenant.** One local tenant, a fixed UUID in the code
  (`00000000-0000-4000-8000-000000000001`). A fixed value needs no read of a tenant list,
  which `Chats` does not have, and keeps the page's chats across starts.
- **127.0.0.1 only**, as the inspector [lead, ec-mxcl]. The host's own origin is then
  `http://127.0.0.1:<port>`, and its list of origins is that one origin. `serve(options,
  local)` gives the gate its `authority`, `127.0.0.1:<port>` with the port that the server
  got (`packages/server/src/serve.ts`, the head comment;
  `packages/local/src/serve.ts:128-137`, `host`). While the host serves, a request whose `Host` header is not that text, byte
  for byte, gets `403 forbidden_origin`, on every route and on a path that is no route,
  right after its place (section 3, "The checks of each request, in their order"; lead,
  ec-g3gkl, 1; `packages/server/src/http.ts:410-411`, `wrongHost`): this refuses a page
  of a web site that points its own name at 127.0.0.1. After `serve`'s end mark, every
  request gets `503 busy` before the gate, with no `Host` check (section 3, "Admission",
  12; lead, ec-dkhr1).
  The check is of the header's text, and of nothing else (ec-yi50l; lead, ec-olqwa). A
  request in the absolute form with another host in its target and the right `Host`
  header is served, since the server drops the target's host (section 3, "A route's
  path"). That is no path for a page of another origin: a browser sends the origin form,
  and in `Host` the name and port of the address that it asks, so a page whose name
  points at 127.0.0.1 sends its own name. An HTTP/1.1 request with no `Host` gets the
  server's own `400`, before the host's handler, not the gate's `403`. An HTTP/1.0
  request with no `Host`, which that version allows, reaches the handler: it takes its
  place (`503 busy` when none is free), and then gets the gate's `403`, since a header
  that is not there, or is empty, is not that text (section 3, "Admission", 3, the
  server's own answers; ec-nd04w; ec-m17io; lead, ec-olqwa). Neither is a path for a
  page of another origin: a browser sends HTTP/1.1 or later, with its own `Host`.
- **What it prints at its start**: one line on the standard output, the page's address
  with its start value: `http://127.0.0.1:4681/<start>/`. The person opens the page with
  one click, as the inspector's. Nothing else goes to the standard output.
- **Its diagnostics.** The host's own (those of no chat) go to the standard error, with
  Effect's logger, since `everchat serve` has no screen to keep (lead, ec-mxcl, decision
  11). A chat's diagnostics go to its log as today, through the stack's diagnostics layer.
  No line holds a token, the secret or the text of a message.
- **Its stop.** A signal ends it. The host closes each stream and socket of a client
  (`stop`, `1001`), then unloads each loaded chat as in section 2, so each launch ends. A
  socket that is not a client yet (before its `auth`, or in its token's check) is closed
  by the end of the HTTP server, not by the host: after the host's end and the wait for
  the streams, `serve` interrupts each request that still runs, and the socket's reader's
  finalizer closes it with `1001` (`packages/server/src/serve.ts`, the head comment, "The
  end"; ec-fhomd; ec-81998).

### The start value and the page's routes

The start value is 32 random hex digits, new at each start, as the inspector's path token
(`packages/local/src/inspector.ts:12-16, 138`). Under it the command serves the page and
two routes for the page alone (lead, ec-mxcl, decision 5):

| # | Method and path | What it does |
| --- | --- | --- |
| R8 | `GET /<start>/` | the page |
| R9 | `POST /<start>/chats` | makes a chat of the local tenant with the default pick; `200 {"chat": "<UUID>"}` |
| R10 | `POST /<start>/token` | body `{"chats": ["<UUID>", ...]}` (1 to 64); `200 {"token": "<JWT>", "exp": <seconds>}`, a token of the local tenant for those chats, for `TOKEN_LIFE`, 600 s |

- **Behind the gate** (lead, ec-3jrdd; lead, ec-g3gkl, 2 and 3). Each of R8 to R10 goes
  through the gate's member `local` (`packages/server/src/http.ts`, `local`): the place,
  the `Host`, the method (R8 `GET`, R9 and R10 `POST`; another gets the answer of no
  route), the origin, then the work under the deadline, as a route's. R9 and R10 refuse
  an `Origin` that is not the host's own, and a request with no `Origin` (`403
  forbidden_origin`): only the page calls them. R8 takes a request with no `Origin` (a
  person's click sends none). They take no token: the start value is their wall, as the
  inspector's. They count among the requests in flight ("Admission", 3: `503 busy` with
  `retry-after: 1`), and their place goes back when their work has ended.
- **At the layer's start** (`packages/server/src/page.ts:230-233`, `pageRoutes`), before
  anything is served, the layer fails with `LocalRefused`: with the reason `start` when
  the start value is not 32 hex digits in lower case, with the reason `page` when the page
  has not exactly one `<script>`, or its one has a `src`. Neither the error nor its text
  holds the value.
- **The path.** R8 is `/<start>/`, R9 `/<start>/chats`, R10 `/<start>/token`. The path's
  first part is compared with the start value over the start value's whole length, with
  no early end, so the time of a refusal tells nothing of how many digits were right
  (`page.ts:159-163`, `isStart`). Every other path under it, a wrong start value
  (another letter case or length too) and `/<start>` with no slash at its end are no
  route: the gate's answer of no route, `404` with no body.
- **R9**, in this order: the count; its body, when the request has one, read (at most
  16,384 bytes, `PAGE_BODY`, in at most `bodyRead`, 10 s) and dropped; `makeChat` of the
  local tenant with the default pick (`packages/server/src/page.ts:245-256`, `chatWork`).
  A request has no body when it has no stream or a `content-length` of 0, and then
  nothing is read: the page's own R9 posts none (lead, ec-r4yb6, 2; `page.ts:209-210`,
  `hasBody`). A body over the bound gets `413 too_large`, and one that comes too slowly
  `408 timeout`. A body whose read fails, in its middle or at once, gets `400
  bad_request` with the connection closed, and no chat is made; it counts in the rate,
  as below. A store's failure is `500 internal`.
- **R10**, in this order: the count; the body's type, as R1's (`application/json`, and at
  most the parameter `charset=utf-8`; else `415 unsupported_type`); the body, at most
  16,384 bytes (`PAGE_BODY`) in at most `bodyRead` (`413`, `408`); its form: UTF-8 JSON,
  an object with the one field `chats`, a list of 1 to 64 (the limit `chats`) UUIDs in
  lower case, none twice, else `400 bad_request`, with no body too; each chat with
  `Chats.reads` for the local tenant, in the list's order: a chat that is not the local
  tenant's gets `404 no_chat`, and no token is made; then the token, with the host's
  secret, the local tenant, the chats and `exp` `TOKEN_LIFE` (600 s) from Effect's
  `Clock`, in whole seconds. A store's failure is `500 internal`.
- **The rates.** R9 at most 10 in a minute and R10 at most 60 in a minute, for the host, by
  the rule of section 3, "Admission", 7 and 8 (`429 too_many` with `retry-after`). Each
  request that passed the gate counts, one that then fails too (a refused body, a store's
  failure).

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
- it keeps its chats' UUIDs in the browser's `localStorage`, under the key
  `everchat.chats`: a JSON list of UUIDs in lower case, the oldest first. A value that is
  no such list is dropped whole, and a UUID twice is kept once
  (`packages/server/src/client.html:81, 157-169`, `STORED` and `loadChats`);
- it asks R10 for a new token one minute before its `exp` (`EARLY`), and after a `401`. A
  token names the newest 64 chats of the list (`MOST`), the open chat always among them:
  an open chat older than those takes the place of the oldest of them
  (`client.html:186-190`, `tokenChats`; ec-lycw1);
- after R10's `404 no_chat` for a list of more than one chat, it hunts for the gone chats
  (lead, ec-ot20g, 1 to 3; lead, ec-88qxe, 1; `client.html:214-306`, `huntCall`, `search`
  and `hunt`; `:313-340`, `ask`):
  - its next call of R10 asks a token for the open chat alone, and that token serves the
    open chat's work at once; a `404 no_chat` on that call takes the open chat from the
    list. While the hunt runs, the page's other asks of R10 name the open chat alone when
    one is open; with no chat open, they name `tokenChats`, as with no hunt. The chat of a
    Send that is not open still gets a token that names it after at most one more call of
    R10, for it alone (`client.html:361-391`, `tokenFor` and `askFor`; lead, ec-8gqty, 1;
    ec-cdeu2, case 2);
  - the hunt runs behind: no ask, no R9 and no work of the open chat waits for it. It asks
    R10 for the halves of a list that holds a gone chat, down to one chat;
  - it makes at most 30 calls of R10 in any 60 s (`HUNT`, `SPAN`; half of R10's rate). A
    `429` waits its `retry-after`, 1 s at least, and asks again, counted in the 30, with
    no error sentence on the page;
  - a chat leaves the list only after a `404 no_chat` of an R10 call that named that chat
    alone. Another failure (a `500`, a fault of the network) ends the hunt with every chat
    kept and no sentence; the next `404 no_chat` starts it again. A round that finds no
    gone chat ends the hunt. At a round's end it asks one token for the chats that are
    left (`tokenChats`), and hunts again when that is `404 no_chat` too;
- the page's list of chats is the browser's, for the address's origin (lead, ec-hwa43; the
  browser's proofs ec-5irtt and ec-hwa43). A start on the same port is the same origin,
  and its page finds the chats again. A start on another port (`--port 0` gives a new one
  at each start) is another origin, whose page starts with an empty list, while the
  chats stay in the home's database. No route lists a tenant's chats: the routes stay R8
  to R10;
- it renews its token by the browser's clock. A page whose browser's clock is far ahead of
  the host's asks R10 in a loop, which R10's rate bounds (`429`). `everchat serve` shares
  the machine's clock, so this is a note for a page that another machine serves
  (ec-3nrh6; lead, ec-olqwa);
- it reads the events with `fetch` (R4) or the socket (R6), and keeps the last number of
  each chat, as section 3 says.

The page lives in the package `server`, beside the routes that serve it, so the server
build can serve it too when the server plan wants it.

## 8. Limits, and what is not proved here

### Limits

Each is a field of `HostOptions.limits`, with this default. Each row starts with its
field's name in `code`, as `Limits` names it (`packages/server/src/limits.ts`, its head
comment); a row with two or three numbers names a field for each (lead, ec-0r89g). The code
holds each time in milliseconds where this table says seconds or minutes (`request` is
30,000). The two rows that hold no number of the host, the connections that Bun holds with
no request and an event's whole text past `entry`, have no field. The numbers are measured before
they are fixed for a hosted deployment, as the design's limits are
(`docs/design.md`, "Functions, approval, programs" [Q34, Q42]). On a store that holds
events, `text`, `body` and `entry` may rise, not fall ("The checks at start", S1).

| Limit | Default | Past it |
| --- | --- | --- |
| `text`: a message's text | 65,536 bytes | `400` |
| `body`: a body of R1 or a socket's frame after `ready` | 512 KiB | `413`; `1009` |
| `early`: a socket's frame before `ready` | 8 KiB | `1009` |
| `key`: an `Idempotency-Key` | 128 bytes, and at most 128: the core's bound of a sender's key (`SENDER_KEY`, `packages/core/src/store.ts:95`); the host refuses to start with a larger `key` (ec-f0gyn, ruling 1) | `400` |
| `token`, `life` and `chats`: a token, its size, its life and its chats | 4,096 bytes; a life of one hour; 1 to 64 chats | `401`; `4401`; `makeToken` fails with `TokenRefused`, R10 answers `400` |
| `said` and `saidWindow`: messages in, for one chat | 30 in a window of 60 s (section 3, "Admission", 8) | `429 too_many` with `retry-after`; on a socket, an `error` frame |
| `newChats` and `newChatsWindow`: R9, for the host | 10 in a window of 60 s ("Admission", 7 and 8) | `429 too_many` with `retry-after` |
| `newTokens` and `newTokensWindow`: R10, for the host | 60 in a window of 60 s ("Admission", 7 and 8) | `429 too_many` with `retry-after` |
| `requests`: HTTP requests in flight, for the host | 256 ("Admission", 3); a place counts work, not a connection: it stays taken after its client has gone, until its work has ended ("Admission", 5) | `503 busy` with `retry-after: 1`, before the body is read |
| `waiting`: sockets that wait for their `auth`, for the host | 256 ("Admission", 2) | `503 busy`, before the upgrade |
| `bodyRead`: the read of a body | 10 s | `408 timeout`, and the connection closes |
| `lockWait`: a message's wait for its channel's lock | 10 s | `503 busy` with `retry-after: 1`; on a socket, an `error` frame; nothing is logged |
| `hub`: the turn loop's hub of a loaded chat | 1,024 entries; a whole number from 1 to 65,536, since the hub allocates its arrays for its whole capacity when it is made (`PubSub.ts`, effect 4.1.2; a capacity of 2**31 − 1 took 26 GB in a test; lead, ec-9p347; ec-9txv3, ec-tvs01) | the oldest entries are dropped; the listener reads the lost numbered events from the store (section 2, Load, step 3) |
| `buffer` (entries) and `bufferBytes` (bytes): a client's buffer | 4,096 entries or 8 MiB of JSON, the first reached; the host's own frames to the client count in both (section 2, "The host's own frames"; lead, ec-9p347, T7) | the host ends that client's stream (`slow`) or socket (`4408`); for a socket, Bun's backpressure ends it first, with `1006` ("A slow socket") |
| `entry`: the JSON of one event or one piece that the host gives | 1 MiB; the host refuses to start with less than the largest whole event that the limits in use allow, or more than `buffer` in bytes ("The checks at start") | a numbered event is cut (`"cut": true`); a piece is dropped ("The bytes of one entry") |
| `page` (events) and `pageBytes` (bytes): a page of a read from the store; the JSON of a snapshot or of R3's answer | 1,000 events or 2 MiB of JSON after the fit, the first reached: a page is at most `page` bytes, since it closes before the entry that would pass it; a snapshot and R3's answer are at most `page` bytes too (lead, ec-x0hhp, U1); the host refuses to start with less than `entry`, or more than `buffer` in bytes ("The checks at start") | the page ends; the next page is read after it ("Pages"); a snapshot keeps its newest messages, and R3 ends before the message that would pass it |
| `room`: room for a page in a first read's client's buffer, or for R6's snapshot (lead, ec-x0hhp, U2) | for a first read, 30 s after the last page was given to it, or after the first read started (on R6, when the snapshot frame was put; lead, ec-0r89g, W2); a page given with no entries (the read was at the store's end) gave it nothing, and does not start the 30 s again (ec-2qdid); for R6's snapshot, 30 s after the socket became a client (U2): a rate of one page (2 MiB) in 30 s, about 70 KB/s (0.56 Mbit/s), asked of a client that catches up | the host ends that client (`slow`; `4408`); it keeps what it took and connects again from its number |
| `reads` and `readsWait`: first reads, reads of R5, and reads of messages (R2, R3, R6's snapshot) at one time, for the host; the longest wait for a place | 16 ("Admission", 11; lead, ec-x0hhp, U3); 30 s | the next waits at most `readsWait`, then `503 busy` with `retry-after: 1`; `4503` |
| `request`: the whole life of a request that holds a place | 30 s ("Admission", 10) | the host asks its work to stop; the place and the holder are free when it has ended, by the sum for the common case `request` + `store` (35 s) after the head, or `request` + 4 × `store` (50 s) for a load that is stopped or a log whose write failed (section 2, "Accepted risks"); then `503 busy` with `retry-after: 1`, or the connection closes when bytes were sent |
| `lock`: the work under a channel's lock for a message in | 20 s (section 2, "The deadline of the work under the lock") | the host asks it to stop; the lock is free when it has ended, by the sum for the common case `lock` + `store` (25 s) after it was taken, or `lock` + 4 × `store` (40 s) for a load that is stopped or a log whose write failed (section 2, "Accepted risks"); `503 busy` with `retry-after: 1`; on a socket, an `error` frame (`busy`) |
| `store`: one call of the store, a transaction as one call | 5 s, by the store's own timer (section 9, item 9) | the call fails with a typed fault; a write is rolled back, and nothing is published for it |
| `idle`: Bun's idle limit of HTTP (`idleTimeout`) | 190 s: twice the longest silence, less at most one tick of 4 s ("Admission", 9; lead, ec-jbry3, X2); the host refuses to start with less than twice it, or more than 255 | Bun closes the connection, or a response that sends no byte for that long |
| `socketIdle`: the WebSocket's idle limit (`websocket.idleTimeout`) | 120 s ("Admission", 9); the host refuses to start with less than twice `ping`, or more than 960 | Bun closes the socket; Bun pings shortly before, and a client that answers stays |
| connections that Bun holds with no request | none of the host's: in time, Bun closes a connection whose head does not come, or comes one byte each 10 s, at about 12 s (the measure of ec-fhomd); in count, the limit of open files of the process, and in a hosted deployment the front before the host ("Admission", 9) | the deployment's bound |
| an event's whole text, past `entry` | not given by any route of this step | the event is given cut |
| `chatClients`: clients of one chat | 32 | `503 busy`; `4503`, after the `auth` |
| `hostClients`: clients of the host | 4,096 | `503 busy`; `4503`, after the `auth` |
| `loaded`: loaded chats | 200 (the design counts 100 chats at work at one time, `docs/design.md`, "Tenants and isolation" [Q3]) | `503 busy`, with `retry-after: 5` |
| `wait`: R5's largest `wait` | 25 s | `400` |
| `events`: R5's `limit` | 1,000 events | `400` |
| `history`: R2's `last` and R3's `to - from` | 200 messages | `400` |
| `auth`: the socket's `auth` | 5 s after the upgrade | `4401` |
| `ping`: an idle stream or socket | a `ping` every 15 s | |
| `unload`: an idle loaded chat | 6 minutes with no work | it unloads (section 2) |

**The local command's numbers** (ec-wp0xs). `everchat serve` gives the host the defaults,
but two limits that it needs before the host is made: `hub`, for the stack's hub
(`hostedStack`), and `store`, for its file's store (`chatsLayer`). It gives those two to
the host, and to `serverOptions`, as its own constant at the defaults' values, `hub`
1,024 and `store` 5,000 (`packages/local/src/serve.ts`, `LIMITS`), since
`@everchat/server` exports no defaults; so the host's limits are those that the stack and
the file use.

**The numbers of the server** (lead, ec-fhomd, rulings 4 and 8). `serve` cannot read the
options of the server that its caller built, so `serverOptions(limits)` of the `.` entry
gives them for the limits in use: `idleTimeout` is `idle`, and `websocket.idleTimeout` is
`socketIdle`, each in whole seconds, rounded up, never 0; `websocket.maxPayloadLength` is
`body`; `websocket.closeOnBackpressureLimit` is `true` and `websocket.backpressureLimit`
is `bufferBytes`. At the defaults: 190, 120, 524,288, `true` and 8,388,608. A caller
builds its `BunHttpServer` with those numbers and no others: a shorter idle limit resets
an answer within the page's silences, a larger frame bound lets Bun hold more than `body`
of a frame, and Bun's own backpressure options let a socket lose frames
(`packages/server/src/serve.ts:168-182`, `serverOptions`, and the head comment, `:98-128`).

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
to it, or after its first read started (on R6, when the snapshot frame was put; lead,
ec-0r89g, W2), the host ends the client as `slow` (lead, ec-7bi64, G2; ec-12a32, M4): it
keeps what it took, and connects again from its number. A page given with no entries (the
read was at the store's end) gave the client nothing, and does not start the 30 s again
(ec-2qdid). A client's memory is its buffer, and the count of clients is bounded.

**A slow socket** (lead, ec-fhomd, ruling 8; ec-9w6rf). For a socket the slow bound is
Bun's backpressure, not the host's buffer: Effect's Bun writer moves each text of the
buffer into Bun's send buffer at once, and does not read the result of Bun's `sendText`.
Bun ends a socket whose send buffer passes `backpressureLimit` (`bufferBytes`), with
`1006` and no close frame (section 3, R6, the close codes). So the bytes for one socket
are the host's buffer plus Bun's send buffer, `bufferBytes` each. A socket that Bun ends
at that bound stays in `FIN-WAIT-1` on the server's side, with its kernel send queue
(4,155,073 bytes in the probe of review ec-9w6rf), until the peer reads or the kernel
gives up: memory outside `bufferBytes`, and outside the host's power.

### The bounds between the turn loop and a client

Each queue between the turn loop and a client has a bound (lead, ec-vgn58, C):

| Queue | Bound | When it is full |
| --- | --- | --- |
| the turn loop's hub of a loaded chat | 1,024 entries | the oldest entries are dropped, and the turn loop never waits |
| a page of a read (`eventsAfter`: the client's first read, the read at a load, at an unload, after a loss, the read of R5) | 1,000 events or 2 MiB of JSON (`page`), one page in memory for each read at a time ("Pages") | none: the next page is read after this one is given, or, for a first read, after this one is dropped: a first read waits for room in its client's buffer, and a page that no longer fits there (a frame of the host took the room) is dropped and read again after that wait (section 2, "The give"; lead, ec-9p347, T7) |
| a client's buffer | 4,096 entries or 8 MiB of JSON | the host ends that client (`slow`; `4408`) |
| a socket's send buffer in Bun, after its client's buffer | `bufferBytes` (8 MiB; `backpressureLimit`, "A slow socket") | Bun ends the socket, with `1006` and no close frame |

- **The hub.** `Turns.layer` has an option, the hub's capacity (`Options.hub`,
  `packages/core/src/turn.ts`; ec-9txv3), a whole number from 1 to 65,536: with none, the
  hub has no bound (`PubSub.unbounded`), for the terminal; the stack of a host's chat sets
  it, 1,024 entries by default (section 9). The hub with a capacity
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
  (`packages/core/src/turn.ts:425`, `:497`), and `why` a text of the turn loop or of the
  vendor (`packages/core/src/turn.ts:501`, `:515`; the vendor's error text,
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
     loop ends the turn with it (`packages/core/src/turn.ts:501`). The turn loop keeps at
     most 2,000 characters of a `why`, for every use, before it stores and publishes it
     (section 9). It makes a `why` well formed one time already, so the row and the event
     hold the same text (`packages/core/src/turn.ts:399-416`); the cut goes in the same
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
6. **Section 10** then holds no point of the size of one entry; its one open point is the
   socket writer's `4408` (section 10). (F6)

### Pages

A read from the store is given a page at a time (lead, ec-7bi64, G1). A page ends at
1,000 events or at the limit `page`, 2 MiB of JSON after the fit, the first reached. The
store's read takes a count only (`eventsAfter(after, limit)`,
`packages/core/src/store.ts:395-401`), so the host reads at most 100 events in one call of
the store, fits each, and closes the page before the event that would take it past
`page`; the next page starts after the page's last number, and the events of that call
that did not fit are read again then. A read is at the store's end when one call gives
fewer events than it asked for. One call of the store holds at most 100 events before
their fit: at most 100 × the largest of the sums of "The checks at start" and C, while it
is fitted; at the defaults, with C at most 394,452 bytes, 39,445,200 bytes (lead,
ec-12a32, P4).

**The largest page** is `page` bytes, exactly (lead, ec-12a32, M1): the page closes before
the entry that would take it past `page`, so no entry passes it, and its first entry
always fits, since `entry` ≤ `page`. It also has at most 1,000 entries. A first read
waits for that room in its client's buffer before each page, `page` bytes and 1,000
entries (section 2, "The give"); R6's snapshot waits for `page` bytes before its frame
(section 2, "The host's own frames"; lead, ec-x0hhp, U2); and the check `page` ≤ `buffer`
uses both numbers.

**The messages of an answer** (lead, ec-x0hhp, U1). A snapshot (R2's answer, R6's
`snapshot` frame) and R3's answer hold messages, not events, and their JSON is at most
`page` bytes, as a page's is. A snapshot keeps the newest messages that fit, and may hold
none (section 4, "The snapshot"; U1a). R3 gives the messages from `from` upward and closes
before the message that would pass `page`. **One message always fits R3's answer**, from
the page's own sums: one message at its largest is `F` + 6 × 30,000 = 180,196 bytes, and
R3's answer with it is 15 + 180,196 = 180,211 bytes (`{"messages":[]}` is 15), which is
less than `message` (180,246) ≤ `entry` ≤ `page` ("The checks at start"). A snapshot
counts its other fields too, so near the limits' edge its list may be empty (U1a).

**The sums of memory for reads** (lead, ec-9p347, T10). One read of events holds one page
after its fit, at most `page` bytes, and one call of the store before its fit, at most
100 × the largest of the sums and C (above). At the defaults, with C at most 394,452 bytes,
that is 2,097,152 + 39,445,200 = 41,542,352 bytes (39.6 MiB) for one read. The host holds,
for reads:

- (a) **the listener's own reads** (at a load, at an unload, after a loss), which the
  listener of a loaded chat reads one at a time: over the 200 loaded chats,
  200 × 41,542,352 = 8,308,470,400 bytes (7.74 GiB);
- (b) **the reads of `reads`**, first reads, R5's and the reads of messages (section 3,
  "Admission", 11; lead, ec-x0hhp, U3). One place of `reads` holds the larger of a read
  of events (above: `page` + 100 × the largest of the sums and C) and a read of messages
  (lead, ec-0r89g, W1). A read of messages holds, in its place, one call of the store
  before its cut, at most 200 messages (R2's `last` and R3's `to - from`; R6's snapshot
  reads 50), each at most `message` − 50 bytes (180,196: "The messages of an answer"),
  and its cut, at most `page` bytes: `page` + 200 × (`message` − 50) bytes, beside a
  snapshot's other fields. (b) is `reads` times the larger one. At the defaults a read of
  events is the larger, 41,542,352 bytes against 2,097,152 + 200 × 180,196 = 38,136,352
  bytes, so (b) is 16 × 41,542,352 = 664,677,632 bytes (634 MiB) (lead, ec-x0hhp, U4). `message` does not
  depend on `text` (a page of the log is 30,000 characters at most), and `accepted` does:
  with C at most `accepted`, a read of messages is the larger under a `text` below 59,925
  bytes (an `accepted` below 360,392). At `text` = 32,768, for one, a read of events is
  2,097,152 + 100 × 197,450 = 21,842,152 bytes, and (b) is 16 × 38,136,352 = 610,181,632
  bytes (582 MiB);
- (c) **the answers of R2, R3 and R5 that are held while they are written**: one page for
  each request in flight, 256 × 2,097,152 = 536,870,912 bytes (512 MiB) (lead, ec-x0hhp, U4).

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
  `packages/sqlite/src/sqlite.ts:877`).
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
| `page` ≤ `buffer` in bytes, and `page` in events ≤ `buffer` in entries (1,000 at the default) | `page`, `buffer` | a first read's room for one page can come |
| `idle` ≥ 2 × (`wait` + 2 × (`request` + `store`)), and `idle` ≥ 2 × `ping`, and `idle` ≤ 255,000 | `idle`, `wait`, `request`, `store`, `ping` | Bun's idle limit does not close a client that waits (section 3, "Admission", 9) |
| the WebSocket's idle limit (`socketIdle`) ≥ 2 × `ping`, and ≤ 960,000 | `socketIdle`, `ping` | Bun does not close a socket that the host pings |
| `hub` ≥ 1 | `hub` | the hub's maximum is `hub` × the largest sum and C ("The bytes of one entry", 5); its field's own range, 1 to 65,536, refuses a `hub` under 1 first (lead, ec-9p347; ec-tvs01) |

A set of limits that passes these has no numbered event that cannot be given whole, but a
`call`'s `program` or an `end`'s `why` that F4 cuts (the `why` only past `entry`), among
the events written under it.

**A store's limits may rise, not fall** (lead, ec-349x0, S; an accepted risk, section 2,
"Accepted risks", 2).

- The checks use the limits in use. An event written under larger limits stays in the
  store, as it was written. To set `text`, `body` or `entry` lower than a store was
  written under is not supported. (S1)
- If a read meets such an event (an `accepted` or a `message` whose JSON is over
  `entry`, which F4 never cuts and never drops), the host does not give it. It ends that
  client's read with the page's error for a fault of the host, the word `internal` of
  section 4: R5 answers `500 internal` with the error JSON; R4 ends with `close`, reason
  `internal`, since its stream starts before its first read (lead, ec-5njke, 3); R6
  closes with the code `1011`, reason `internal` (S2a). A read of the listener (at a load, at an
  unload, after a loss) ends so each client that would get the event. Its log line names
  the event's number and its size in bytes, and no text of it. The chat's rows stay as
  they are. (S2)
- A client that gets `internal` shows the error to the person, and connects again by
  itself at most one time in 30 s (section 3, "The order and the numbers", rule 3; lead,
  ec-9p347, T11). A new connection reads from the client's number and meets the
  same event until the limits are set back, so the code is how the client and the
  operator of the deployment learn that the fault is the host's. R4's `internal` is for
  this case only. The second case is a snapshot whose other fields alone pass `page`,
  which R2 answers with `500 internal` and R6 closes with `1011` (section 4, "The
  snapshot"; lead, ec-x0hhp, U1a): so R6's `1011` is for these two cases only. The
  client's rule 3 after `internal` covers both. (S2a)

### What is not proved here

Each of these is a point that no trial of ec-f7m3i ran; the bead that builds it proves it,
or a later bead does, as named.

- **A browser** with the page's policy and a WebSocket to the same origin: proved in one
  browser, Chromium, by a pilot (ec-5irtt, steps 1 to 6). The page of `everchat serve`
  showed with no error and no report of its policy, whose `script-src` has one hash; a
  chat made by "New chat" got its answer by the stream and by the socket, which opened
  to `ws://127.0.0.1:<port>/v1/chats/<chat>/socket` with `101` and sent `auth` first, as
  CSP Level 3 says that `connect-src 'self'` allows (ec-f7m3i Q9); a text with markup,
  the person's and the model's, was on the page as that text; the policy refused a
  `fetch` and a socket to another origin, an inline script added by the console and
  `eval`; and a reload showed the chat again from its snapshot, with only
  `everchat.chats` in `localStorage` and no token in it, in the address bar or in a
  request's address. A start again on the same home and the same port finds the chats
  again: the earlier address gets `404`, the new one shows the chat and its messages
  (ec-hwa43). A start on another port is another origin, whose page starts with an empty
  list (section 7, "The page's rules"). Not shown in a browser yet: another browser than
  Chromium, and what the pilots' steps did not take (the renewal of a token before its
  end, the read of older messages by R3): for those the page has the cases of
  `packages/server/src/client.test.ts`, under happy-dom.
- **A slow reader of an event stream** on Bun with `effect/http`: measured on a real
  server (ec-5njke). A reader that read the head and then nothing, with `bufferBytes` at
  400,000: its buffer peaked at 361,800 bytes, Bun took 4,462,343 bytes of what was given
  to it (Bun's buffers and the kernel's), and it ended `slow`; the longest give was
  1.56 ms, and a client that read got all 88 events. So the host's write to a stream does
  not wait on a reader that does not read. A stream that nothing pulls still sees its
  client's end (`slow`, `stop`, `internal`): a watcher on `Client.whenEnded` runs it
  (lead, ec-5njke, 10; `packages/server/src/channel.ts:218-223`, `Client.whenEnded`).
- **The size of a socket's frame**: measured (ec-1d6p0). With `maxPayloadLength` at
  `body`, a frame of `body` + 1 is refused at its header: `1009` within 1 ms, the
  connection closed before its payload was sent, nothing held whole. A frame under it,
  before `ready` too, Bun holds whole before the host gets it; the host then applies
  `early` ("Admission", 6; lead, ec-jbry3, X1).
- **The connections that Bun holds with no request** (section 3, "Admission", 9):
  measured (ec-fhomd). Bun closes a connection whose head does not come, and a head that
  comes one byte each 10 s, at about 12 s, not at 190 s; one that was idle after a `401`
  it closed at 192.1 s: Bun counts its idle limit of HTTP in ticks of 4 s, and 190 is 48
  ticks. At a limit of 4,096 open files the server held 4,086 connections with no head,
  its resident memory hardly moved (76,016 kB before, 76,344 kB at most), and a request
  then got no answer in 5 s; at the default limit it held 6,000, about 301 bytes each, and
  a request then got its `404` in 29 ms. Both bounds are the deployment's, not the host's.
- **The silences under the idle limit** (lead, ec-12a32, L5): with the page's numbers, an
  R4 stream with no event for 60 s (its pings only) and an R5 with the largest `wait`
  and its two reads each end whole. Measured on the host's own routes at the page's scale
  (ec-fhomd: `serve` at the default limits, on a server built with `serverOptions()`): the
  R4 stream was whole at 60.04 s, by 4 pings (the first at 41 ms, the longest gap
  15.0 s); the R5 with `wait` 25 and two reads of 29.5 s each answered `200` whole at
  84.05 s, with no byte before (a read past `request` gets the gate's `503` at the
  deadline). A probe of `Bun.serve` on Bun 1.4.4 shows the same now: with
  `idleTimeout: 190`, a stream that pings every 15 s for 60 s and an answer after 95 s
  both end whole; with `idleTimeout: 60`, the answer after 95 s is reset at 60 s
  (ec-dotas; the probe of ec-f082c, `idle.ts 190 95`, gives the same).
- **The WebSocket's idle limit** (L6): measured (ec-1d6p0). Bun's idle limit of a socket
  has a floor of about 8 s (`idleTimeout` 1, 4 and 8 each closed an idle socket with
  `1006` at 8.0 s). At `idleTimeout: 8`, the host's frames alone (one each second, with
  `sendPings` off) and Bun's `sendPings` alone (its client answering) each kept a socket
  open at 26 s; one with neither closed at 8,014 ms.
- **A store that stalls** (lead, ec-12a32, O6): that each call of the store is ended by
  its own timer within `store` (section 9, item 9), and that the lock and the place are
  then free by the numbers of section 2, "The deadline of the work under the lock". On
  SQLite it is proved (ec-go3ne, ec-werq6, ec-fbcoc; lead, ec-0r89g, the store's waits):
  each wait on the file ends within `store` (5 s by default), by the driver's own wait on
  a locked file, which is given the limit `store` (`packages/sqlite/src/database.ts`), and
  fails with a `StoreError` that names its operation. The local store's calls do not
  yield: the driver runs each statement on the process's one thread, so such a wait stops
  the process's other work for that time, and no timer of the host can cut it. A call
  waits longer than `store` only behind calls of its own process on the one connection,
  whose transactions hold only calls of the store: accepted, with no mechanism. The open
  of the file is not one wait: on a file not yet in WAL mode it can wait at three
  statements in a row (the readiness `BEGIN`, its `COMMIT`, the change to WAL), so it ends
  within 3 × `store`, and within `store` on a WAL file; the build of `storeLayer` adds the
  launch's transaction (4 × and 2 × `store` by sum). These are sums of the driver's waits
  on the file's locks: the scheduler's time, a process's start and the statements
  themselves are on top. For the host the open is at the process's start, not in a
  request, and the launch of a load (`Chats.store`) is one call of the store, inside the
  page's sums. An open that fails at the change to WAL of a new file leaves the schema and
  this version's mark in the rollback-journal mode, with no launch row and no row of a
  chat; the next open finds the mark, writes no schema and changes the mode: accepted as
  the recovery. A store on a network covers the wait for a connection with its timer
  (section 9, item 9); its own bead proves it.
- **The two cases that pass the deadline's sums** (lead, ec-349x0, R5): measured and
  decided (section 2, "Accepted risks"). The replay of a stopped load by fitted pages:
  the lock is free at `lock` + 6 × `store` after it was taken (49.984 s measured), kept as
  accepted risk 1 (lead, ec-jbry3, X4). The log that waited for the memory's own lock:
  fixed, the deadline cuts that wait and the lock is free at `lock` (20.000 s measured),
  no risk (lead, ec-jbry3, X5).
- **The cap of one answer in bytes** (C of "The bytes of one entry"; ec-lw754, ruling 5):
  the stack of a host's chat sends every request of the chat with `max` at most its cap:
  the option `max` of `hostedStack`, or `MAX`, 16,384 tokens, when the options give none,
  as `everchat serve` gives none (`packages/local/src/hosted.ts:92-93, 147`; lead,
  ec-dkhr1). `MAX` is that default, not a fixed bound. At 24 bytes of JSON for a token,
  the lead's assumption and not a measure, the default cap is 393,216 bytes. A case of
  `packages/local/src/hosted.test.ts` gives a fake wire's answer of 393,216 bytes in one
  program: its `call` event is 393,269 bytes of JSON, under 394,452, the largest
  `accepted` at the defaults. The vendor's true bytes for a token are for a real run,
  which no test makes: open.
- **The token's `alg`** (ec-f6ftq; review ec-n7ws6): proved. Check 3 refuses `alg: none`
  and an `alg` other than HS256 before any call of the library, and check 4 is
  `Jws.verify` of `effect/jose`, on purpose: `Jwt.verify` would check `exp` and `nbf`
  before the claims' forms (the comment in `packages/server/src/token.ts`). A case of
  `packages/server/src/token.test.ts` holds each: `none`, and HS512 with the same secret.
- **The bytes of a chat's pick and goal** (lead, ec-x0hhp, U1a): the pick's four texts
  and the goal have no bound in bytes of their own in the store, and a snapshot counts
  them. No route of the host writes either: a host's chat gets its pick from the
  backend's `makeChat` or R9's default pick, and no function of a host's chat sets a goal.
- **Two processes of `everchat serve` on one file** (lead, ec-wp0xs, 9): the command does
  not lock its file, and one `everchat serve` for a home is the help's rule (section 7,
  "One process for a home"). The refusal of a live launch holds per chat
  (`packages/sqlite/src/sqlite.ts:753-754`), but each process would take other chats. A
  second one on the same home needs another port; then a chat that one process has loaded
  answers `409 chat_elsewhere` to a message in the other, and the other's connected
  clients get no live event of that chat until they connect again. No data is lost. A
  lease is the server plan's [Q22].
- **The time of a load and the memory of a loaded chat** in this host: the design's 30 ms
  and 2 MB [Q12, Q22] were measured elsewhere. The smoke test measures them here
  (ec-a780r; `packages/server/src/smoke.test.ts`), on one machine at a load average of
  about 10 (9.91, 10.34, 11.68): a message in, R1 to its `200`, the median of 20, took
  21.6 ms for a chat that was not loaded and 10.7 ms for a loaded one; 50 loaded chats
  with no work raised the process's resident memory from 120.2 to 152.3 MiB, 0.64 MiB a
  chat. These are measures of one machine under load, not bounds: at a load average of
  37 to 38 the same run gave 59.9 ms and 42.9 ms, and 0.60 MiB a chat.
- **Less than 1 s for a piece** (`docs/design.md`, "Messages in, events out" [Q10, Q17]):
  the channel's listener gives each piece to the buffers at once and waits for no client,
  so nothing of the host's adds a wait. The smoke test measures the time from the fake
  wire to a client (ec-a780r): the largest of 100 pieces took 5.4 ms on R4 and 5.3 ms on
  R6 at a load average of about 10, and 28.2 ms and 27.0 ms at 37 to 38; its case asserts
  under 1 s. A measure of one machine, with a fake wire: a vendor's own time is not in it.
- **The memory of the reads under load** (lead, ec-9p347, T10; "Pages", the sums of memory
  for reads): measured by the smoke test (ec-a780r). 16 first reads of a chat with 5,000
  events at one time took 1.88 s, and the process's resident memory rose from 157.0 MiB
  to 284.6 MiB at the most (+127.6 MiB), at a load average of about 10; at 37 to 38,
  3.40 s and +135.0 MiB. A measure of one machine under load, not a bound.
- **The one connection of a file** serializes the statements of all chats (ec-f7m3i Q1,
  item 2). Its cost with many chats at work is not measured.

## 9. What the store and the turn loop must get

The list that the code beads take, from ec-f7m3i Q3, Q4 and Q8:

1. **The read of events, and `seq`** (ec-f7m3i Q4). The tree has both (7ee9e87):
   `Reading.eventsAfter(after, limit)`, the chat's numbered events after `after`, in the
   order of their numbers, at most `limit`, with the store's `Event`, which the turn loop
   publishes too (`packages/core/src/store.ts:395-401`, `:212-217`); and the chat's `seq` in
   `Chat`, 0 with no event (`packages/core/src/store.ts:140`). The host adds `cut` (section
   4) and reads in pages (section 8, "Pages").
2. **The key** (section 5). Done (ec-bu4bg, ec-ts3qg): the schema's column and index,
   with the mark 6; the store's append takes a key for a message's first page
   (`Store.append(messages, key?)`); a read of the message of a key with its pages and its
   `accepted` number (`Reading.keyed`); and `Turns.say(text, key?)`, which, for a key that
   the chat has, writes nothing and gives the first message. `say` gives
   `Sent { messages, accepted, repeat }`: the pages, the `accepted` number, and whether
   the key was a repeat (`packages/core/src/turn.ts`).
3. **"Busy now" and the time of the last work** (ec-f7m3i Q8, gap 1). Done (ec-9txv3):
   the turn loop gives both, with no wait: busy while a turn or a call runs
   (`Turns.busy`); the memory gives busy while a compaction runs (`Memory.busy`); and the
   time when each last had work (`Turns.worked`, `Memory.worked`). The host's timer reads
   them under the channel's lock (section 2).
4. **`result` in the core, over the store.** Done (ec-o9i2n): the core gives `RESULT`,
   whose function reads the call's output from the store (`store.call`) with no file,
   `HOSTED` (`zoom`, `date`, `result`) and `hostedLayer(declarations)`, a function of the
   stack's list (`packages/core/src/functions.ts`; ec-0di3a); and an output limit that writes no file and names
   `result(id)` only, `noFileLayer` (`packages/core/src/limit.ts`).
5. **The local stack as a function of a store.** Done (ec-lw754): `hostedStack`
   (`packages/local/src/hosted.ts:145-176`) builds the wire one time for the process (over
   `gatewayLayer`, when no `wire` is given), makes the list and the head one time for the
   process and gives the head to `Turns.layer` and `Compactor.layer` by the option `head`
   (ec-0di3a; ec-u3nf8), and gives the stack of a chat over the store
   that `Chats.store` gives (section 1, "The stack of a host's chat"; section 2). The stack of a
   host's chat gives the wire a cap on one answer (`request.max`,
   `packages/openai/src/openai.ts:192`), `MAX`, 16,384 tokens, when its option `max` gives
   none, and its case measures the cap in bytes (section 8, "What is not proved here").
   The terminal keeps its stack (`packages/local/src/main.ts`, `layer`).
6. **The inspector's error `NoChat` renamed `NoHome`.** Done (ec-wp0xs): `NoHome`
   (`packages/local/src/main.ts`, `NoHome`), in the batch that makes the local package
   serve `Chats` (lead, ec-mxcl, comment of 2026-11-16 15:38Z). The core's `NoChat` keeps
   its name.
7. **A bound on the turn loop's hub** (section 8, "The bounds between the turn loop and a
   client"; lead, ec-vgn58, C). Done (ec-9txv3): `Turns.layer`'s options have the hub's
   capacity (`Options.hub`, `packages/core/src/turn.ts`), a whole number of entries from 1
   to 65,536, optional: with it the hub is `PubSub.sliding` of that capacity; with none it
   is `PubSub.unbounded`, and the terminal gives none. The stack of a host's chat gives
   the limit of section 8, 1,024 by default. The
   test, in the host's batch: with the listener held, a burst of more numbered events than
   the capacity; then each client gets each number once, in order, and the listener read
   the lost ones from the store.
8. **A bound on an `end`'s `why`** (section 8, "The bytes of one entry", 5; lead, ec-7bi64,
   F5). The turn loop keeps at most 2,000 characters of a `why`, for every use, before it
   stores and publishes it, at the place where it makes the `why` well formed one time.
   Done (ec-9txv3): `WHY` = 2,000 and `whyOf` (`packages/core/src/turn.ts`), which `end`
   applies to every `why`, so a failed turn's `why`, the wire's message with the vendor's
   error text (`packages/openai/src/openai.ts:288-295`), is cut there. The test: a failed
   turn whose vendor error text is 100,000 characters gives an `end` whose
   `why` is 2,000 characters, the same in the row and in the event.
9. **A timer on each call of the store** (section 2, "The deadline of the work under the
   lock"; lead, ec-12a32, O3). Each call of the store ends, done or with a typed fault
   (`StoreError`), within the limit `store` (5 s), by the store's own timer on the call;
   a transaction counts as one call, from its start to its commit. For a store on a
   network, the timer covers the wait for a connection and the statement. On SQLite the
   timer is the driver's own wait on the file's locks, given `store`, and it is proved
   (ec-go3ne, ec-werq6, ec-fbcoc): a call waits longer only behind calls of its own
   process on the one connection, accepted with no mechanism, and the open of the file is
   not one call (lead, ec-0r89g; section 8, "What is not proved here"). A write that
   fails so is rolled back, and nothing is published for it. The test, in each store's
   bead: a call that stalls fails at `store`, and the next call of the chat runs. No
   change of the log's order (O1): the log of a message stays as the core has it, whole
   from the take of the memory's lock, and a wait for that lock can be cut (section 2,
   "The deadline of the work under the lock"; `record`,
   `packages/core/src/turn.ts:292-303`, and `recordPush`, `:310-331`; `Memory.apply`,
   `packages/core/src/memory.ts:755-785`), so the commit comes before the publish, a
   key's numbers on a retry are those of the message that was committed, and a turn runs
   in the loaded chat's scope, as today. One change next to it, done (ec-ts3qg):
   `Turns.say` forks the turn that its log began (`launch`, `packages/core/src/turn.ts`)
   in the same uninterruptible step as its `record`, so a turn that was logged always
   runs. The test: a `say` that is interrupted while its log
   writes ends with the message logged, its `start` published and its turn running.

## 10. Open

Each point of the investigation's list (ec-f7m3i Q10) is settled by the settled list,
by the lead's eleven decisions, by the lead's form of the fixes, or above; the numbers of
section 8 are defaults that a measure may change. The size of one entry, the point that
was open here, is settled by the limit `entry` and the fit (section 8, "The bytes of one
entry"; lead, ec-7bi64, F). One point is open:

- **`4408` for a slow socket** (lead, ec-fhomd, ruling 8): for the host's socket writer to
  read the result of Bun's `sendText` and send `4408 slow` itself, it needs an access that
  Effect's `Socket` does not give. Until then Bun ends such a socket with `1006` (section
  8, "A slow socket"). No bead yet.

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
  loss and at an unload; it needs the client's `given` at `last` or more, or a channel
  with no `last`, and room in its buffer for one entry of `entry` bytes.
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
