# The design for many chats: local, server and Cloudflare

This document is the design of EverChat for many chats. It holds what the owner settled in
the grilling of bead ec-4dzk, agreed on 2026-11-15. It wins over the research in
`docs/research/`, which stays as the evidence: where a research document recommends
something else, this document holds. Only a decision of the owner changes it.

Each decision is one statement with its question numbers in brackets (`[Q22]`), then its
reason, then the research document and the section that hold the evidence. "Not settled"
marks a point that the grilling left open. The names are those of `GLOSSARY.md`.

Where the research recommends something else, this document holds:

| Research | What it says | This design |
| --- | --- | --- |
| `store.md`, "What fits, what does not" | PostgreSQL first, with row-level security | No feature of PostgreSQL only; MariaDB [Q7] |
| `agents.md`, "What fits, what does not" | A spike with Effect's cluster | One active process, a lease, no cluster [Q22] |
| `agents.md`, "Events out: one listener for all chats" | One listener for all chats | No listener for all chats [Q41] |
| `mariadb.md`, "D. The product's tools" | EverChat may send to the tenants' webhooks | No webhook [Q25, Q40] |
| `mariadb.md`, "B. Rights" | Two users, `everchat_migrate` and `everchat` | One user, `everchat`; no migrator [Q47, Q55] |
| `functions.md`, "Different declarations for each tenant" | One list, or profiles | Functions from a provider [Q21, Q28] |
| `runtime.md`, "What fits, what does not" | A process for each tenant, in a container | Many tenants in one process [Q13] |
| `mysql.md`, "What fits, what does not" | SQL for both servers, a lease for each chat | MariaDB only, one lease for the deployment [Q7, Q22, Q37] |
| `code-mode.md`, "What fits, what does not" | A function `propose` | The call itself is the proposal [Q43] |

## The goal and the order

- **Build the hosted use now. A full refactor or rewrite is authorized, with no backward
  compatibility. `AGENTS.md` has the rule.** [Q1] Reason: the hosted use is needed soon,
  and the modular design must be proved now, not later; the project is greenfield, so good
  code now costs less than seams added later. Evidence: `docs/research/portability.md`,
  "Today".
- **The proof of the design is three builds: local (Bun, one SQLite file, the terminal,
  the shell), server (Bun, MariaDB, HTTP and WebSocket, many tenants in one process), and
  a Cloudflare smoke test (`workerd`, a Durable Object for each chat with its own SQLite).
  The core's checks also run on Node. No Deno.** [Q4, Q6, Q14] Reason: a hosted deployment
  will probably be on AWS, and Cloudflare is a second target to build and test; each build
  is one host with its own implementations of the seams, so the three together show that
  the core holds no runtime API. Evidence: `docs/research/portability.md`, "P1", and
  `docs/research/packages.md`, "Which option first: M".
- **The priorities are: local, then the hosted use, then the factory with its hooks.
  Hosted chats have no hooks.** [Q52; order: Q56] Reason: the local use is the easiest to
  test; the hosted use needs no hooks, because the provider sees each call and the
  approval is the gate; the factory needs many hooks, and it waits. Evidence:
  `docs/research/code-mode.md`, "What fits, what does not".
- **The result is this document, changes to `AGENTS.md` and `GLOSSARY.md`, and then the
  work. A deployment to the owner's Cloudflare account, and each real run with a model,
  need the owner's yes first (in the factory, an approval card).** [Q53] Reason: the
  owner's choice. Evidence: none.

## Tenants and isolation

- **A tenant is a separate company, possibly a competitor. A tenant has many chats. Use of
  resources comes before isolation.** [Q2, Q16] Reason: a microVM or a container for each
  tenant costs too much; most chats are idle, so one machine, possibly one process, holds
  many tenants. Evidence: `docs/research/runtime.md`, "What fits, what does not".
- **The size: 100,000 chats, 100 that work at the same time. Hosted functions are network
  calls.** [Q3] Reason: an unloaded chat costs only rows, so the limit is the work at one
  time, not the count of chats; hosted functions call services, and they are bound by I/O.
  Evidence: `docs/research/functions.md`, "Measurements".
- **Only code keeps tenants apart. The rules: no shell and no file functions for a hosted
  chat; a new QuickJS engine for each program; no secret of a tenant in EverChat; a store
  that is bound to one chat; a test with two tenants. The owner accepted the risks. A
  tenant that needs full isolation gets a deployment of its own. Firecracker is far
  future.** [Q5, Q8, Q13] Reason: MariaDB has no row-level security, and competitors share
  one process; the shell is the hole, because a command runs as EverChat's OS user and can
  read the environment and the files of the other tenants. The risks that stay: a defect
  in our code shows data to the wrong tenant; one tenant's work makes all chats slow; a
  crash stops all loaded chats, and each loads again from the database. Evidence:
  `docs/research/runtime.md`, "What fits, what does not"; `docs/research/functions.md`,
  "What fits, what does not"; `docs/research/mysql.md`, "B. Keys and the tenant".
- **One active process for each deployment, with a lease row and an epoch that each write
  checks. No router and no cluster.** [Q22] Reason: 100 chats that work need less than 1
  GB (about 2 MB for a loaded chat, about 6 MB for a program that runs); a second process
  (a rolling deploy, a standby) cannot write until it takes the lease, and then the old
  one cannot write. Evidence: `docs/research/mysql.md`, "D. Ownership" (D2);
  `docs/research/mariadb.md`, "Does `mysql.md` hold on 10.11?".
- **An idle chat uses no memory. EverChat unloads it after 6 minutes with no work, and a
  load makes all again from the database: a chat carries a recipe, not values.** [Q12,
  Q20] Reason: the state is in the database, and a load took 30 ms in a warm process; the
  6 minutes are a little longer than the vendor's 5-minute cache, but the two timers are
  not linked. With a recipe, an unload saves nothing and loses nothing. Evidence:
  `docs/research/agents.md`, "Load and unload".

## Packages

- **One repository with workspaces, nine packages named `@everchat/<name>`: `core`,
  `openai`, `sqlite`, `mariadb`, `codemode`, `local`, `server`, `cloudflare`, `wakeups`.
  One version. The packages import the TypeScript sources of each other. No publishing to
  npm at first.** [Q31, Q45] Reason: clear packages with clear boundaries, as `~/src/pi`
  has, that a person outside can use one at a time; Bun, Node and `workerd` ran the `.ts`
  sources of a workspace with no build. Evidence: `docs/research/packages.md`, "Options"
  (M) and "What fits, what does not".

| Package | What it holds | Runtime |
| --- | --- | --- |
| `core` | the memory, the turn loop, requests, the cache, the head | none |
| `openai` | the wire for OpenAI; Anthropic's comes next to it later | `fetch` only |
| `sqlite` | the store on SQLite, one entry each for Bun, Node and a Durable Object | each entry its own |
| `mariadb` | the store on MariaDB | Bun |
| `codemode` | the engine for programs: in a worker thread, or in a separate Worker | each entry its own |
| `local` | the terminal, the shell, the files, the inspector, the executable | Bun |
| `server` | HTTP and WebSocket, the lease, the provider | Bun |
| `cloudflare` | the Durable Object of a chat | `workerd` |
| `wakeups` | reminders and routines, optional | none |

- **Two checks keep the boundaries: the imports of each package, and its manifest. The
  core has no runtime API, with one exception: `createHash` from `node:crypto`. The tests
  of the core use `node:test`.** [Q45] Reason: only an import walker saw a relative import
  across packages, and the manifest check sees what the linker lets through; `createHash`
  ran the same on Bun, Node and `workerd`; a `node:test` file runs on Bun and on Node.
  Evidence: `docs/research/packages.md`, "K3" and "K5"; `docs/research/portability.md`,
  "Facts".
- **From `~/src/pi` we use `pi-schema`, and EverChat adopts the code of `pi-codemode`
  (below). For MCP we use the official SDK.** [Q45]
  Reason: `pi-schema` checks JSON Schema from outside, which `pi-codemode`
  does not; `pi-mcp` speaks only an old version of the protocol. Evidence:
  `docs/research/function-sources.md`, "`pi` (the checkout `/home/rko/src/pi`)".
- **The library's code becomes EverChat's. EverChat adopts the code of `pi-codemode` (MIT,
  version 1.5.2) inside the package `codemode`, first with no change of behavior, and keeps
  its notice of license; `pi-schema` stays a library. Then the thread engine counts polls,
  as the inline engine and the remote engine do, so that the compute budget has one unit on
  each runtime and bounds what a program computes. A contribution to upstream can come
  when the code is proved.** [owner, 2026-11-16] Reason: EverChat already has its own code
  around the library, and the library stopped the work three times (no count of polls for
  the thread engine; no point after the boot of the worker; limits that it does not
  check); it is about 3,050 lines with one dependency (`quickjs-wasi`, which stays pinned).
  The costs: each change of the sandbox gets one review from each vendor, and corrections
  of upstream are merged by hand. Evidence: the mails ec-wisp-m5t1u and ec-wisp-2ck75.

## The database

- **No feature of PostgreSQL only. The server database is MariaDB 10.11; the checks run on
  10.11 and 11.8; upgrade before 2028-02-16.** [Q7, Q15, Q47] Reason: the stages of a
  hosted deployment already run MariaDB 10.11 with their users, and a second database
  engine is too much to run now; all decisive trials passed on 10.11.18, and 11.8 differs
  where it counts (snapshot isolation). Community support of 10.11 ends on 2028-02-16.
  Evidence: `docs/research/mariadb.md`, "E. The server version" and "What fits, what does
  not".
- **One schema for all builds. The tables are in the product's schema, with the fixed
  table prefix `everchat_` in all builds, written out in each statement. The empty local
  SQLite file is deleted and made again.** [Q15, Q24, Q46] Reason: the product's backups
  and scripts assume one schema for each stage; a fixed table prefix gives one schema text
  in all builds, the same names in the documents and the inspector, and no statement that
  builds a name; one schema then holds one deployment. Every name that is unique in a
  schema gets the table prefix, and each table states its own character set. Evidence:
  `docs/research/mariadb.md`, "A. Where the table prefix lives in the code" (A1) and
  "Names in one schema".
- **Keys: `tenant.id` is the tenant's UUIDv4 as `BINARY(16)`; a chat has an integer id
  inside and a UUID outside; the other tables have keys `(chat, n)`. Deletes cascade from
  tenant to chat to rows. No erasure in the first version.** [Q9, Q16] Reason: the
  tenant's UUID comes from outside, and other systems refer to it; the integer costs 8
  bytes in each row and index against 16, and keeps the rows of one chat together in
  InnoDB. Erasure waits until a law or a contract asks for it. Evidence:
  `docs/research/mysql.md`, "B. Keys and the tenant" (B3).
- **One database user, `everchat`, with a name from the config. No migration user (the
  schema: Q55). The user and the password come through one interface; the first
  implementation reads AWS Secrets Manager. No RDS Proxy.** [Q36, Q47] Reason: a migration
  user does not fit a schema that `skeema` manages; the names differ between deployments;
  one interface lets other ways (a function, a file, an SDK) come later; one process holds
  a small pool, so it needs no proxy. Evidence: `docs/research/store.md`, "D. Database
  credentials on AWS"; `docs/research/mariadb.md`, "B. Rights".
- **The product's backups of the schema include the chats. A copy into a different stage
  is refused at the start until an administrator clears it.** [Q47] Reason: the backup of
  the schema is EverChat's backup; a restore across stages copies the chats, and EverChat
  can refuse to act on the copy but not prevent it. Evidence: `docs/research/mariadb.md`,
  "D. The product's tools".
- **The schema on MariaDB is `.sql` files in the form of `skeema`, one for each table,
  always the current schema; an administrator applies them with `skeema`. The server build
  has no migrator and never changes the schema. At each start it reads the definition of
  each of its tables from the database and compares it with its files (the columns, the
  keys, the foreign keys); if a table is missing or different, it stops with an error that
  names the difference. The names of the database user and of the schema come from the
  config; no name is fixed in the code. The local SQLite file is different: EverChat makes
  its own schema there, and for now a change of the schema means a new file. The rights of
  the user keep the log append-only (`SELECT` and `INSERT` on the log tables, no `UPDATE`,
  no `DELETE`); the first version uses no trigger on MariaDB. A release that changes the
  schema has two steps: apply the files, then start the new EverChat.** [Q55] Reason: the
  product's schema is already managed with `skeema`; the free edition of `skeema` possibly
  does not manage triggers, and the rights do the work of the triggers. Evidence:
  `docs/research/mariadb.md`, "C. The migrator's state" and "Rights".
- **Checks: SQLite for the scoped check; a recipe with a private MariaDB from Nix in `just
  full`; a recipe with a local `workerd` outside `just full`. No MySQL.** [Q37] Reason: a
  private MariaDB from Nix starts in about 2 s with its data in a temporary directory; the
  server is MariaDB only. Evidence: `docs/research/mysql.md`, "F. A server for the
  checks".

## Messages in, events out

- **Browsers connect to EverChat directly. Each connection has an access token. The
  backend has the secret of the deployment and makes access tokens with a short life for
  browsers; an access token names one tenant, its chats, and an end time. EverChat keeps
  no accounts and knows no persons.** [Q19, Q33, Q39] Reason: a firewall can block a
  WebSocket only between a browser and a server, and a backend that relays a WebSocket or
  an event stream is difficult on serverless; `AGENTS.md` ("Be modular") says that the
  core does not depend on accounts. One shared secret is sufficient at first. Evidence:
  none.
- **Two ways with the same events and event numbers: a WebSocket first; plain HTTP as the
  fallback (a `POST` in, a `GET` as an event stream out, and the same `GET` without the
  event stream if a proxy holds it back). No webhook.** [Q18, Q25, Q40] Reason: a
  WebSocket has the lowest latency, but a firewall that inspects can block it; an event
  stream (Server-Sent Events) is an ordinary HTTP response that is slow to end, and the
  webhook of round 3 was a misreading. With the same numbers, a client can change the way
  and continue after its last number. Evidence: `docs/research/mysql.md`, "E. Event
  numbers".
- **A client gets a snapshot of a chat and then its events. No listener for all chats in
  the first version.** [Q41] Reason: a feed of the events of all chats to one program
  crosses tenants, and a client needs only its own chats. Evidence:
  `docs/research/agents.md`, "Events out: one listener for all chats".
- **Events have an exact order inside one chat, by an event number for each chat. Whole
  messages are durable; pieces are best effort; less than 1 s.** [Q10, Q17] Reason: events
  out of order are hard for a client to handle; one process writes a chat, so a number for
  each chat has no contention, while one `AUTO_INCREMENT` number for all can commit out of
  order and lose an event. A piece cannot be read again. Evidence:
  `docs/research/mysql.md`, "E. Event numbers" (E1); `docs/research/agents.md`, "Limits".
- **The backend makes the chats. A person can have many chats at one time. A message can
  carry the header `Idempotency-Key`, made by the first sender; with no key, each `POST`
  is a new message.** [Q19, Q26, Q27] Reason: only the first sender knows that two sends
  are one message (a web page makes a UUID with `crypto.randomUUID()`); a duplicate with
  no key is outside EverChat's responsibility. Evidence: `docs/research/agents.md`,
  "Routing: one message, to the one owner, once and in order".
- **A small web page in the repository is the reference client, for development only.**
  [Q27] Reason: it uses only the public interface, so it shows a client how to talk to
  EverChat, and it is the manual test of many chats side by side on one database.
  Evidence: none.
- **Images: a message can carry images. EverChat keeps only what it sends to the model, in
  the database, behind an interface. The limits are 5 MB for each image and 10 images for
  each message. The originals belong to the client.** [Q35, Q44] Reason: images are needed
  in the first version; the client has the original already; an implementation for an
  object store can come later with no change to the core. The cost: the tables and the
  backups grow. Evidence: `docs/research/store.md`, "Limits".

## Functions, approval, programs

- **A hosted chat gets a common set of functions and the functions of a provider, which is
  a service outside EverChat that the deployment runs. EverChat asks the provider at each
  load, with the tenant's and the chat's UUID, and validates the definitions, the
  arguments and the results. The provider adds the secrets.** [Q21, Q28] Reason: a fixed
  list cannot carry the secrets of each tenant and person; with the provider, EverChat
  holds no secret of a tenant and no credential of a person, only its own credentials. The
  costs: one more request for each call, and a function fails while the provider is down.
  Evidence: `docs/research/function-sources.md`, "Where secrets live" (P1) and "What
  EverChat must refuse or limit".
- **The provider speaks MCP, the version of 2026-07-28 over HTTP. The repository gets a
  small example provider, so that a person can see it work. If the provider does not
  answer at a load, the chat loads without its functions.** [Q48, Q49] Reason: in that
  version one call is one `POST`, with no session to keep across an unload; a provider can
  use any library for MCP servers, and the local connectors use the same client. Evidence:
  `docs/research/function-sources.md`, "The Model Context Protocol (MCP), version
  2026-07-28" and "The wire to an outside provider (hosted)" (W1).
- **The local use gets connectors as MCP servers from a config file, and the person's own
  code as a local MCP server.** [Q49] Reason: an error in the person's own code then
  cannot stop EverChat, and one client serves both uses. Evidence:
  `docs/research/function-sources.md`, "Functions for the local use" (L1, L2b).
- **Approval: a function says in its definition that it needs approval. A call to it does
  not run: it is pending, and it returns "pending" at once; the other calls of the program
  run. The answer comes in with a text that names who answered, and it is kept for ever.
  After a yes, EverChat runs the recorded call, and the result starts a turn. An approval
  waits 7 days at most. In the local use, the person answers in the terminal. A built-in
  function says in its code that it needs approval; a function of the provider says it
  with a field in its definition.** [Q11, Q32, Q43] Reason: nothing waits in memory, so an
  approval works across an unload, a crash and an upgrade, and the person approves the
  exact call that runs; with no function `propose`, the model cannot forget it, and a
  provider's function needs no second name. EverChat trusts the backend for who answered.
  Evidence: `docs/research/functions.md`, "Approval by a person" (C);
  `docs/research/code-mode.md`, "A trial of option C".
- **Limits for hosted programs, all settings: one turn at a time for each chat; 64
  programs for each process and 8 for each tenant; 64 MiB for each engine; one total
  budget of compute time; 30 s for a call to the provider; 10 minutes for a program; no
  program after its turn ends.** [Q34, Q42] Reason: a program that runs costs about 6 MB
  and 2 threads, so the count of programs, not of chats, is the limit; today's compute
  limit starts again after each function call and bounds nothing for sure; long work is a
  function that a service runs. The numbers are measured before they are fixed. Evidence:
  `docs/research/functions.md`, "What fits, what does not";
  `docs/research/portability.md`, "Limits".
- **The deadline of a program is a setting: 10 minutes in the hosted use, none in the local
  use unless a person sets one. A program that reaches it is stopped, and its result tells
  the model the limit, and how long functions were at work in that time: one text for all
  uses, with no word about the use. The deadline is the bound on what a program computes
  while a function is at work, until the thread engine counts polls (below).** [owner,
  2026-11-16] Reason: the deadline counts all the time of a program, so a slow network can
  cause the stop (one call to the provider fails after 30 s; many in sequence do not), and
  the two numbers let the model tell that cause from its own compute; the compute budget as
  built does not count compute while a function is at work (`GLOSSARY.md`, "compute
  budget"; `packages/codemode/src/thread.ts:42-48`); a local build can be long. Evidence:
  the mails ec-wisp-m5t1u and ec-wisp-2ck75; the comments of ec-sceh of 2026-11-15.
- **The engine is QuickJS on all builds. On Cloudflare, programs run in a separate Worker.
  `effect` stays at 4.1.2.** [Q38] Reason: in the trial, a program that computes inside
  the chat's Durable Object stopped all objects for 7.8 s; one engine makes the model's
  programs behave the same on all builds; the Cloudflare build needs no upgrade of
  `effect`. Not proved: whether the programs of two tenants delay each other in that
  Worker; the smoke test measures it. Evidence: `docs/research/portability.md`, "E3";
  `docs/research/engines.md`, "Q".

## The system prompt

- **The head is EverChat's fixed text with named fields, and an appended text. The name
  falls back to "EverChat". The fixed text cannot be replaced. A change applies at the
  next load.** [Q29] Reason: a deployment may give the assistant another name and add text
  of its own; the fixed text holds the rules of the memory and of code mode. A change at a
  load costs a new head and one cache write. Evidence:
  `docs/research/function-sources.md`, "The system prompt".
- **In the local use, the appended text comes from a file that the config file names; in
  the factory, from `AGENTS.md` in the working directory. More places (the home,
  `AGENTS.local.md`) can come later.** [Q50] Reason: the factory's harness interface
  requires `AGENTS.md` in the working directory. Evidence:
  `docs/research/function-sources.md`, "Other harnesses".

## Wake-ups by time

- **Wake-ups are for the local use, as an optional package; the hosted use gets them
  later. In the factory they are off unless the config file turns them on.** [Q23, Q51]
  Reason: reminders and routines are essential for the chief of staff, and the local use
  shows whether the approach is good before the harder hosted timer; the factory has
  routines of its own. Evidence: `docs/research/wakeups.md`, "As an optional package" and
  "The hosted use, later".
- **The schedule is rows in the chat's database. A timer in the process fires them. A
  wake-up's message has the kind `wake`. It waits in its row until the chat is idle, and
  then it starts its own turn.** [Q30, Q51] Reason: with rows, a restart loses nothing,
  and each wake-up can be listed and stopped; no message of the kind `note` starts a turn,
  and a kind of its own shows what a routine wrote; a routine's text in the middle of a
  task mixes two tasks, and a durable row keeps a later message from moving past it.
  Evidence: `docs/research/wakeups.md`, "Where the schedule lives" (S1), "What fires it"
  (T1) and "What a fire is in the log" (K3, J2).
- **A missed wake-up fires one time at the next start. The limits: 20 active rows; a
  routine one time each hour at most; 6 fires in an hour and 24 in a day; a ceiling of
  steps and tokens for each wake turn; a row stops after two failed turns; `/wakeups off`
  stops all. The time zone is an IANA name. No schedule file.** [Q30, Q51] Reason: the
  limits answer the faults of other assistants: one transaction writes the `wake` message
  and marks the row, so a fire is not lost and does not occur twice, and the budget stops
  a routine that makes routines. The person uses `/wakeups`, and the model uses functions.
  Evidence: `docs/research/wakeups.md`, "What goes wrong, and what the others did" and
  "Limits" (in "Options").

## The order of the work

The order, settled as Q56. Reason: the local HTTP and WebSocket host on SQLite costs
little, because the host and the store are separate services, and it lets the web page be
tested early. Evidence: `docs/research/packages.md`, "What fits, what does not".

1. **Local.** The packages and the core's services, with the terminal build green. Then
   the same HTTP and WebSocket host on a local SQLite file, with the web page. Then the
   wake-ups and the connectors (with the small example MCP server). [Q56]
2. **The hosted use.** The server build on MariaDB: the tenants, the lease, the provider,
   the approval, the images, the schema check. [Q56]
3. **The factory.** EverChat as a drop-in for `claude` and `codex`, with the hooks. It
   starts after 1 and 2. [Q56]

The Cloudflare smoke test and the core's checks on Node come after 2. [Q56]

The adoption of the code of `pi-codemode` into `codemode`, with no change of behavior, is
work of step 1. [owner, 2026-11-16]

The count of polls of the thread engine comes after the adoption. [owner, 2026-11-16]

## Later

These wait until the first version works, each as a bead of its own:

- Skills for the local use. The names and the short descriptions of the skills are a part
  of the system prompt, and the model reads the file of a skill with the `read` function
  when it needs it. The list is fixed at a load. [Q49]
- Background shells and monitors, for the local use only, after the wake-ups, on the same
  seam: a source outside a turn gives a message, and the message starts a turn when the
  chat is idle. A hosted chat never has them. [Q42; plan: Q54]
- Research: queue or steer, for messages of the person and for wake-ups that are urgent.
  [Q51]
- Hosted wake-ups; an object store for images; publishing to npm; mutual TLS; IAM database
  authentication. [Q23, Q31, Q33, Q36, Q44]

Out of scope:

- Firecracker: far future. [Q5, Q13]
- The Microsoft connector for Outlook and Teams. The connectors of the first version are
  the small example MCP server and the ones that the owner chooses later. [Q49]
- Deno. [Q6]
- Features of PostgreSQL only; MySQL in the checks. [Q7, Q37]
- A router or a cluster; a listener for all chats; a webhook. [Q22, Q25, Q41]
- Erasure of a tenant. [Q9]
