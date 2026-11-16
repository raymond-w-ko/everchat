# EverChat glossary

This file is the dictionary of technical names for EverChat. Use each name
exactly as it is here, in code, in documents, and in replies. One thing has
one name. If you need a name that is not here, add it here first.

The names are those of the new design (`docs/schema.html`) and of the design
for many chats (`docs/design.md`). A name in `code font` is also a name in the
database or in the code. Each table has the table prefix `everchat_` in all
builds (`docs/design.md`, Q46): table `msg` is `everchat_msg`. Where the old
code or upstream uses another word, the entry says so.

The last section lists words that we do not use, and the word to use
instead.

## The chat and its log

| Term | Part of speech | Meaning |
| --- | --- | --- |
| chat | noun | The one exchange between a person and EverChat. It never ends. A database can hold many chats, and a tenant has many chats. The local file holds one tenant and one chat: the chat of its home. Inside, a chat has an integer id; outside, a UUID. |
| person | noun | The human who uses EverChat. The factory calls its one person the operator. In the hosted use, EverChat knows no persons: the backend decides who talks to which chat, and one person can have many chats at one time. |
| EverChat | noun | The program, and the agent that the person talks to. In the log, its messages have the kind `asst`. |
| log | noun | All the messages of the chat, in the order they came, kept for ever. Table `msg`. A message in the log never changes and is never deleted. The table named `log` is not the log: it holds the diagnostics. |
| message | noun | One entry of the log. It has an id in its chat (0, 1, 2, ...) that never changes and is never used again in that chat. Every chat has a message 0. |
| page | noun | One message of a text that is too long for one message. The text is logged as pages in a row, of at most 30,000 characters each. Each page has its own id. |
| kind | noun | The type of a message. It says who or what wrote it. The model reads each message as `<kind>: <text>`. See the table below. |
| thought | noun | The model's reasoning text. It is shown to the person and never logged. The old code calls it `mind`. |
| stream | verb | Said of what the model gives while a step runs: its thought, its text, and the program that it writes. What streams is shown, and it is never in the database: a step is written when it ends, whole. |
| piece | noun | A small part of what streams, as the vendor sends it: often a few characters. The code calls it `delta`. |
| paragraph | noun | A part of a thought or of a text that ends with an empty line. Code between two fence lines is one paragraph, whatever empty lines it has. |
| pace | verb | To hold back what streams, and give it on at a boundary: the end of a paragraph, a whole line after a short time, or all of it when the model stops for a while. An interface shows what streams paced, and not each word. |
| image | noun | A picture that a message carries, as it was sent to the model. Table `image`, behind a service with more than one implementation. At most 5 MB for each image and 10 for each message (settings). |
| original | noun | An image as the person or a tool gave it, before EverChat made it smaller for the model. EverChat keeps only what it sends to the model: the original belongs to the client (`docs/design.md`, Q44). The old design's table `image_original` is gone. |
| draft | noun | The text that the person typed and did not send yet. |
| goal | noun | A text from the person (`/goal`) that EverChat works toward until it is met or stopped. |

### The kinds

| Kind | Who or what wrote the message |
| --- | --- |
| `user` | The person. |
| `asst` | EverChat. Short for "assistant". It has 4 letters on purpose: the kind counts toward a node's 512 bytes. Upstream says `unii`, and the old code says `ever`. |
| `tool` | A program that the model ran. |
| `echo` | The result of that program, as the model was shown it. |
| `work` | The report of an agent. It starts with the agent's name, as `[Name]`. |
| `note` | The program itself, and not a person or a model. For example: what an agent is, or text from a hook. |
| `wake` | A wake-up: the text of a reminder or a routine when it fires. It starts a turn of its own. |

## The memory

| Term | Part of speech | Meaning |
| --- | --- | --- |
| memory | noun | The log, the tree, and the views together. It is the core idea of EverChat: the chat itself is the memory. |
| tree | noun | A binary tree of nodes over the log. Its lowest level has one node per message. |
| node | noun | One line of the tree, of at most 512 bytes. Node `(l, i)` covers the `2^l` messages from message `i·2^l` on. Table `node`. A node is written once and never changes. |
| level | noun | The `l` of a node. A node of level `l` covers `2^l` messages. |
| leaf | noun | A node of level 0. It covers one message. |
| halves | noun | The two nodes one level below a node: `(l-1, 2i)` and `(l-1, 2i+1)`. |
| root | noun | A node with no node above it yet. The tree has one root for each power of two in the count of the messages, the largest first: 13 messages have the roots `0+8`, `8+4`, and `12+1`. |
| source | noun | The text that a node is built from. For a leaf, it is the message as the model reads it. For a higher node, it is the lines of its halves. |
| build | verb | To write a node. A source of at most 512 bytes is the node as it is, with no request. A longer source needs a compaction. |
| compaction | noun | A request that builds one node: it compresses one message into a line, or two lines into one. It never replaces or deletes a message. |
| compactor | noun | The model that runs compactions. It is set in the config file, and it is usually a cheap one. |
| summary | noun | The text of a node that a compaction wrote. |
| line | noun | A node as the model reads it in a view: `id+n\|text`, the `n` messages from message `id` on. |
| view | noun | The list of nodes that a request shows the model. It covers the chat to its end, oldest first. Old messages are covered by few nodes of a high level, and new messages by many nodes of a low level. Table `view`. |
| chat view | noun | The view that turns get. It grows to 128,000 bytes, and a batch then makes it half of that. |
| compaction view | noun | The view that compactions get. It is smaller (32,000 bytes). The code calls it `seen`. |
| part | noun | One entry of a view: the `(l, i)` of a node. |
| merge | verb | To replace two neighbouring parts of a view with the node above them. Detail fades with age: the oldest parts merge first. |
| batch | noun | One round of merges that makes a view half as large. A view changes only at its end between batches, so the prompt cache stays valid. |
| zoom | verb | To open a line into the two lines below it, or into the whole message. It is how the model gets detail back, and it is the only way the model may search the memory. |

## Requests and the cache

| Term | Part of speech | Meaning |
| --- | --- | --- |
| vendor | noun | A company whose models EverChat uses: OpenAI or Anthropic. |
| wire | noun | Our code for one vendor's API. It builds each request and reads the streamed reply. We write our own wires. |
| inference gateway | noun | The author's service that forwards model requests. `Gateway` in code. Every request goes through it, with one address and one key for both vendors. |
| pick | noun | A model choice: vendor, model, effort, and speed. Table `pick`. A turn has one pick from its start to its end. |
| effort | noun | The reasoning level of a pick, for example `high`. |
| speed | noun | The service level of a pick, for example the vendor's fast mode. |
| request | noun | One message to a vendor's model, and its streamed reply. The old code calls it a call. |
| ask | verb | To send a request and get its reply, with the tries that it needs. A wire sends a request once; to ask is to wait for the cache, send, and try again when that can help. |
| reply | noun | What the model gave back for one request: its text, the programs it wants to run, the vendor's own items as received, and the usage. |
| head | noun | The part of a request before the messages: the system prompt and the tool list. Table `head`. The chat's turns, its compactions, and its subagents all have the same head. A load makes it, and it stays the same until the unload. |
| block | noun | One piece of a view in a request: 4 lines. |
| prefix | noun | The first bytes of a request, up to a cache mark. Two requests can share a cache entry only if they have the same prefix. |
| prompt cache | noun | The vendor's store of prefixes it has read before. A request that starts with a stored prefix is cheaper and faster. The memory is built to keep the prefix the same. |
| cache mark | noun | A point in a request where the vendor may store, or look up, the prefix that ends there. |
| single flight | noun | The rule that requests with the same prefix do not all write the cache at once. One request leads and writes it, and the others wait and then read it. |
| usage | noun | The token counts of one request: input, cache read, cache write, and output. Table `usage`. |

## Work

| Term | Part of speech | Meaning |
| --- | --- | --- |
| turn | noun | One loop of the model: from a first message, through steps and programs, until a step that runs no program. The chat has turns, and each agent has turns. Table `turn`. |
| step | noun | One request inside a turn, and what the model gave back: text, programs to run, or both. |
| turn item | noun | One piece of a turn's request, kept exactly as sent or received: the first message, each reply of the model, each set of results. Table `turn_item`. A cut turn continues from its turn items. |
| steer | verb | To send a message while a turn runs. The message joins that turn: the model reads it between two programs. A message that comes too late for the turn starts the next turn. A wake-up does not steer: it waits until the chat is idle. |
| code mode | noun | The way the model works: it writes a program that calls functions. Code mode is the only tool that EverChat gives the model. |
| tool | noun | What a vendor's API lets the model call. EverChat has one: code mode. |
| program | noun | The code that the model writes in code mode. A sandbox runs it. |
| function | noun | One thing that a program can call: `shell`, `read`, `write`, `edit`, `zoom`, `date`, `result`, and later others. A function runs on EverChat's side, outside the sandbox. A hosted chat has no `shell` and no file functions: it has a common set, and the functions of its provider. |
| call | noun | One run of a program, or one run of a function inside a program. Table `call`. A call is recorded when it starts, not when it ends. |
| sandbox | noun | The closed place where a program runs. In there, a program has no files, no network, and no timers. It can reach the world only through functions, and it can start a process only through the `shell` function. |
| worker thread | noun | The thread in which the sandbox runs one program on Bun or Node. Each program has its own. It is not an agent. On Cloudflare, programs run in a separate Worker. |
| result | noun | What a call gave back. The database keeps it whole. |
| output limit | noun | The most text of a program's result that the model is shown: 30,000 characters by default. A longer result is shortened: the model gets its head and its tail, and the whole text is put in a file. A function gives its whole result to its program: the limit is not on that. |
| hard limit | noun | The most text that a call may produce: 64 MiB. Past it, the command is stopped. |
| time limit | noun | The most time that one command of the `shell` function may run: 600 seconds, or the seconds that the program gives. Past it, the command is stopped. |
| compute limit | noun | The most time that a program may run with no function at work: 60 seconds. Past it, the program is stopped. A program may wait for a function as long as that function takes. The limit starts again after each function, so it bounds one stretch, not a whole program. The compute budget bounds what a program computes in all: it is a count, not a sum of times (`docs/design.md`, Q42). |
| compute budget | noun | The most polls of the engine that a program may use over the whole program, with a function at work or not. Past it, the engine stops the program, with a message that gives the count. It bounds the work of the program's own code, not time. The engine does not count work inside one built-in call between two polls, and the compute limit stops that work. It is an option of each engine (`polls`). The thread engine of the local use has none. A hosted deployment sets it to a number that it measures first (`docs/design.md`, Q34, Q42). The deadline of a program, which a hosted deployment will have, will bound its time (`docs/design.md`, "Limits for hosted programs": 10 minutes; not built yet). |
| poll | noun | One check that the engine makes while a program runs, at which the engine can stop the program. |
| shorten | verb | To show the model less than the whole result, because of the output limit. Use this word, and keep "cut" for a turn or a call. |
| cut | adjective | Said of a turn or a call that ran when EverChat stopped. A cut turn continues at the next launch. A cut call may or may not have finished, and the model is told so. Also said of a function that was stopped before it ended, because its program ended or was stopped. |
| denied | adjective | Said of a call that a hook refused. It did not run. |
| stopped | adjective | Said of a turn or a task that the person or EverChat ended before it was done. |
| failed | adjective | Said of a turn or a call that ended with an error. |

## Agents

| Term | Part of speech | Meaning |
| --- | --- | --- |
| agent | noun | A helper that EverChat starts: a subagent or a computer task. It has a random name such as `CalmOtter`, and its own log (table `agent_msg`) with no tree. Table `agent`. The chat of a tenant is not an agent: it is a hosted chat. |
| subagent | noun | An agent that works on a task with the same functions as EverChat. It gets the chat view, so it knows what EverChat knows. |
| computer task | noun | An agent that uses a person's computer through screenshots, the mouse, and the keyboard. It gets no view. The code calls its role `hands`. |
| task | noun | An agent's work from one message to its report. A task can take more than one turn. |
| report | noun | The reply of an agent when its task ends. It enters the log as one `work` message, and it starts a turn of the chat. |
| device | noun | A computer on which functions run. |
| chief of staff | noun | The role of EverChat: one agent with a long memory that hands work to others. In the factory, it hands work to other harnesses. Alone, it hands work to its own subagents. |

## The program and its files

| Term | Part of speech | Meaning |
| --- | --- | --- |
| home | noun | The directory of one chat in the local build. The variable `EVERCHAT_HOME` names it. It holds the database, the config file, the hooks file, the skills, and the transcripts. |
| database | noun | Where the state of many chats and of their tenants lives. In the local build, one SQLite file, which holds one tenant and one chat. In the server build, EverChat's tables in the product's schema on MariaDB, with many tenants and chats. On Cloudflare, the SQLite of the chat's Durable Object. |
| state | noun | Data that the program writes and needs again later. State lives in the database, and nowhere else. |
| store | noun | The part of the program that reads and writes the database. No other part uses SQL. The launch that owns the database gets all of it (`Store`). A process that does not own the database gets only its reads (`Reads`), over a connection that cannot write. The store of a loaded chat is bound to that chat when it is made: no query takes a chat id from a caller. |
| migration | noun | One change of the database's tables, with a number, run by the program. The design has none: on MariaDB an administrator applies the schema with `skeema`, and the program only checks it (schema check); in the local build, a change of the schema means a new SQLite file. |
| mark | noun | The number of the schema that a local file holds, in its `pragma user_version`. An empty file gets the schema and the mark. A file of another mark, or with tables and no mark, is refused: the program never opens a file of another schema. A change of the schema means a new file and a new mark. |
| config file | noun | The file of settings that a person writes by hand. The program only reads it. |
| launch | noun | One load of a chat by a process, until it ends or the process crashes. Table `launch`: one row for each load. In the local build, a launch is one start of the program. In the server build, one process makes many launches, one for each chat that it loads, and the lease decides which process may write. At most one launch of a chat is live. |
| run tag | noun | A marker that a launch puts in the environment of each shell it starts. The next launch uses it to find and stop shells that a crash left behind. |
| crash | noun | The end of a launch without a clean exit. The next launch finds it and records it. |
| restart | noun | A launch after another launch of the same chat. It reads the database and continues: cut turns continue, and cut calls are closed. |
| diagnostic | noun | One line that EverChat writes about its own work, for the person who looks for a fault: a request that is sent again, a compaction that failed. Table `log`. It has a level (`debug`, `info`, `warn`, `error`) and a source, the module that wrote it. It is not a message, and the model never reads it. Diagnostics are deleted after 30 days. |
| export | noun | A copy of data from the database into a file, for other programs and for people. An export is not state: EverChat never reads it back. |
| transcript | noun | The export of what happened in a chat: launches, turns, messages, calls, and usage. It is JSONL (one JSON value per line), one file per launch, and append only. It does not hold the tree or the views. |

## The terminal and pipe mode

| Term | Part of speech | Meaning |
| --- | --- | --- |
| interface | noun | The part of the program through which the person and the chat meet. The terminal build has two, the terminal and pipe mode, and one launch has one of them. A host for many chats gives clients the WebSocket and HTTP instead. |
| terminal | noun | The person's interface to the chat: the screen that shows it, and the keys. It is one process in a PTY. Also the part of the program that draws it (`src/terminal.ts`). |
| pipe mode | noun | The interface with no terminal. The program works this way when its standard input or its standard output is not a terminal. Each line of the standard input is a message, and the messages go one after the other. Each message that enters the log goes to the standard output as text. It has no screen, no keys, and no slash commands. |
| row | noun | One row of the screen. Use this word for the screen, and keep "line" for a node as the model reads it. |
| input | noun | The box at the bottom of the terminal where the person types. Its text is the draft until it is sent. |
| status row | noun | The last row of the terminal. It says what EverChat does (`idle`, or the turn that runs), and then the pick. |
| slash command | noun | What the person sends in the terminal when its first word is a slash and letters only, for example `/help`. It tells the program what to do. It is not a message: it does not enter the log, and the model never reads it. |
| inspector | noun | A page in a browser that shows the state of a chat: the log, the tree, the views, each turn's request, and the usage. It is for the person who studies the memory or looks for a fault. It only reads the database: it sends no message, and it changes nothing. `everchat inspect` serves it, as a process of its own. It is not an interface. |

## The factory

| Term | Part of speech | Meaning |
| --- | --- | --- |
| factory | noun | Our software factory, the `everturn` project. It runs many agents, each in a terminal. |
| harness | noun | A program that runs a model as an agent: Claude Code, Codex, EverChat. The factory's code also calls it a runtime. |
| seat | noun | The factory's word for one agent with a fixed identity that runs under a bridge. |
| bridge | noun | The factory's program on a machine that starts, stops, and watches the seats of that machine. |
| adapter | noun | The code in the factory that presents one harness to the bridge. It implements the `SeatRuntime` interface. |
| adapter's ADR | noun | The decision record that the factory needs for each new harness. EverChat's is not written yet. |
| session | noun | The factory's word for what a harness keeps between a start and an end. For EverChat, the session is the chat: its id is the same at every launch. |
| hook | noun | A command that EverChat runs at a fixed point, and waits for. It gets the hook point's data as JSON, and it can answer: with text for the model, or with a refusal. A hosted chat has no hooks. |
| hook point | noun | A place in EverChat's work where hooks run: a session start, a turn start, before a shell command, after a program, a turn end. |
| accepted | adjective | Said of a message that is in the log. EverChat tells the factory at once, also when the message steers a running turn and starts none. |

## The project

| Term | Part of speech | Meaning |
| --- | --- | --- |
| upstream | noun | UniiChat, the project that EverChat is a hard fork of. |
| old code | noun | The code before the rewrite. It is in `ref/`, for reading only. The git tag `before-rewrite` marks the last commit before it moved there. |
| port | verb | To write a part of the old code again in the new design, with the same behavior. The memory is ported, not invented again. |
| greenfield | adjective | With no old data to keep, and no backward compatibility. EverChat reads no old file format. |
| owner | noun | The author of EverChat, who settles its design (`docs/design.md`). |

## Builds and packages

| Term | Part of speech | Meaning |
| --- | --- | --- |
| build | noun | One of the three ways to run EverChat: local (Bun, one SQLite file, the terminal, the shell), server (Bun, MariaDB, HTTP and WebSocket, many tenants in one process), and the Cloudflare smoke test (`workerd`, a Durable Object for each chat). Each is a host and a set of implementations of the seams. The verb "build" is for a node. |
| local use | noun | EverChat for one person on the person's own computer, with the local build: the chief of staff. The factory's use of the local build is named apart: the factory. |
| hosted use | noun | EverChat for the tenants of a hosted deployment, with the server build (or on Cloudflare). |
| package | noun | A directory `packages/<name>/` with its own `package.json`, `exports`, README and tests, named `@everchat/<name>`. There are nine: `core`, `openai`, `sqlite`, `mariadb`, `codemode`, `local`, `server`, `cloudflare`, `wakeups`. |
| entry | noun | One path of a package's `exports` (`.`, `/bun`): the only way in from outside. A package has an entry for each runtime that needs its own code. |
| core | noun | The package `@everchat/core`: the memory, the turn loop, requests, the cache, and the head, with no runtime API but `createHash` of `node:crypto`. |
| host | noun | The code of one build that loads chats, takes messages in, and sends events out: the terminal, the HTTP and WebSocket server, a Durable Object. |
| seam | noun | A service of the core with more than one implementation: the store, the engine, the host, and the source of a message outside a turn (a wake-up, later a background shell). |
| engine | noun | What runs a program: QuickJS, on all builds. Each program gets a new engine, with its own memory, and it goes away when the program ends. A chat that runs no program has none. |
| Durable Object | noun | Cloudflare's single-threaded object with a unique name and its own SQLite. The Cloudflare build has one for each chat. |

## The hosted use

| Term | Part of speech | Meaning |
| --- | --- | --- |
| tenant | noun | A separate company that uses a hosted deployment, possibly a competitor of another tenant. It has many chats. Table `tenant`; its key is the tenant's UUIDv4, 16 bytes from outside (`BINARY(16)` on MariaDB, a `blob` on SQLite). In a process, only code keeps tenants apart. In the database, a reference from a row of one chat to a row of another is refused, and so is a move of a row to another chat or of a chat to another tenant. |
| hosted chat | noun | A chat of a tenant. It shares a process with the chats of other tenants. It has no `shell`, no file functions, and no hooks. |
| deployment | noun | One run of EverChat for many tenants: its config, its database user, its schema, and one active process. A tenant that needs full isolation gets a deployment of its own. |
| backend | noun | The service of a hosted deployment, outside EverChat, that knows the persons. It makes the chats, has the secret of the deployment, and makes access tokens for browsers. |
| client | noun | A program that connects to EverChat to use chats: a browser page, or the backend. It gets a snapshot of a chat and then its events. |
| reference client | noun | The small web page in the repository that uses only the public interface, for development only. It is not a product. |
| access token | noun | What a connection shows to EverChat. The backend signs it with the secret of the deployment; it names one tenant, its chats, and an end time. Not a token that a vendor counts. |
| event | noun | What a chat reports to its clients, with the next event number of the chat: `accepted` (a message of the person is in the log), `start` (a turn starts), `call` (a program starts), `message` (a whole message is in the log), or `end` (a turn ends). Each event has a row of the table `event`. Events have an exact order inside one chat and none between chats. A piece rides the same stream of the turn loop, and it is not an event: it has no number and no row, and it is best effort. |
| event number | noun | The number of an event in its chat: 1, 2, 3, with no gaps, in the order of the events. The chat's counter (`seq`) holds the last one: an event gets the counter plus 1, and sets the counter to it, in the transaction of what it reports. A client continues after the last number that it has, on any way. |
| event stream | noun | A `GET` of the events of a chat after a number, which stays open and gives each event when it occurs (Server-Sent Events). It is the HTTP fallback for a WebSocket. |
| snapshot | noun | What a client gets of a chat when it connects: the chat as it is. Its events follow. |
| load | verb | To make a chat ready to work in a process: from its database, its recipe and, for a hosted chat, its provider. |
| unload | verb | To take a loaded chat out of memory, after 6 minutes with no work. It saves nothing: the database holds all. |
| idle | adjective | Said of a chat with no turn, call or compaction to do. An idle chat can be unloaded, and a waiting wake-up starts its turn. |
| recipe | noun | What a chat keeps so that a load can make it again: rows and settings, never a value that a load cannot make again, such as a secret. A chat carries a recipe, not values. |
| lease | noun | The row that names the one active process of a deployment. Each write transaction checks its epoch. A second process cannot write until it takes the lease, and then the first cannot write. |
| epoch | noun | The number of a lease. It grows at each new holder; a write with an old epoch is refused. |
| product | noun | The other program whose schema on MariaDB holds EverChat's tables. |
| stage | noun | One copy of a product, each with its own schema: `acme_dev`, `acme_qa`. A copy of EverChat's tables into a different stage is refused at the start until an administrator clears it. |
| schema | noun | The definitions of EverChat's tables: one for all builds. On MariaDB, also the named set of tables of a product, which holds EverChat's tables. |
| table prefix | noun | The text `everchat_` at the start of each name that is unique in a schema: each table, the view, each index and each trigger. Foreign keys have no names. Fixed in all builds and written out in each statement. Not the prefix of a request. |
| schema check | noun | At each start of the server build, the comparison of each of its tables in the database with its `.sql` files: the columns, the keys, the foreign keys. A table that is missing or different stops the start, with an error that names the difference. |

## The host

| Term | Part of speech | Meaning |
| --- | --- | --- |
| channel | noun | The host's place for one chat that it serves. It holds the chat's holders and its clients, each client with its `given`. It also holds the listener's `last`, the loaded chat if there is one, the lock of its loads and messages, and the give lock. A channel exists while it has a holder. So it stays after an unload while a client is connected or a message waits. |
| registry | noun | The host's map from a chat to its channel. It has one lock of its own. Only two steps change it: a hold and a let go. A hold finds or makes the channel and adds a holder. A let go removes a holder, and takes the channel out when no holder is left. |
| holder | noun | What keeps a channel in the registry: a connected client, a message that comes in, or the loaded chat. |
| give | noun | One step of the host, under the channel's give lock, that an interruption cannot split. It puts one event or one piece into the buffers of the channel's clients that joined. A client gets an event only when its `given` is below the event's number, and its `given` then becomes that number. A client that has not joined gets only the gives of its own first read. |
| give lock | noun | The lock of a channel, with one permit, under which each give and each join runs. One give or one join runs at a time. |
| join | noun | The step at the end of a client's first read, under the give lock. From then on, the client gets the gives of the listener, and of the reads at a load, after a loss, and at an unload. A client joins only when the two parts of its check are true. First, its `given` is `last` or more, or the channel has no `last`. Second, its buffer has room for one entry of `entry` bytes. A channel has no `last` before the chat's first load. |
| longest silence | noun | The longest time in which the host sends no byte to a client that waits, on any way. Bun's idle limit is at least twice it. |
| fit | noun | The one function of the host that makes the JSON of an event or a piece, and measures it. It drops a piece that is longer than `entry` bytes. For a longer `call` or `end`, it gives only the start of its `program` or its `why`, and adds the field `"cut": true`. It never changes an `accepted` or a `message`. When one of them is longer than `entry` bytes, the host does not give it, and the read ends with `internal`. Every path that gives an event or a piece uses it. |
| page of a read | noun | A part of a read from the store: at most 1,000 events, or at most `page` bytes. The host gives a read one page at a time. It is not a page of the log. |
| loss | noun | Events and pieces that the hub of the turn loop dropped. The listener sees a loss as an event whose number is not `last` plus one. Then it reads the lost events from the store. A lost piece stays lost. |
| stack | noun | Everything above a chat's store that a loaded chat needs: the diagnostics, the memory, the wire, the sandbox, the functions, and the turn loop. The host gets it as a function of the store. |
| start value | noun | A random value, new at each start of a local server, at the start of the path of each of its routes for the person. The inspector has one, and so does the page of `everchat serve`. The inspector's code calls it its token. It is not an access token. |
| hosted set | noun | The functions of a chat that needs no machine: `zoom`, `date`, and `result`. A chat of the host has these functions only: no `shell` and no file functions. |
| sum for the common case | noun | A total of time that `docs/host.md` adds up from its limits: for a lock, a place, a stopped load, or a longest silence. It is a number of the design, not a promise. |
| accepted risk | noun | A case that passes a sum or a rule of `docs/host.md`, which the lead keeps. Its text gives its conditions, why it is rare, how it fails safe or recovers, and what would fix it. |

## Functions from outside, and approval

| Term | Part of speech | Meaning |
| --- | --- | --- |
| provider | noun | A service outside EverChat that gives a hosted chat its functions at each load, and runs each call with the tenant's secrets. It speaks MCP. EverChat validates its definitions, the arguments, and the results. |
| MCP | noun | The Model Context Protocol, the version of 2026-07-28 over HTTP: what a provider and a connector speak. |
| connector | noun | An MCP server for one service of the person (mail, a calendar), named in the config file, in the local use. The person's own code is a local MCP server too. |
| approval | noun | A person's yes or no to one recorded call of a function that needs it, with its exact arguments. The answer names who answered, and it is kept for ever. After a yes, EverChat runs the recorded call. It waits 7 days at most. |
| pending | adjective | Said of a call of a function that needs approval: it did not run, and it returned "pending" at once. |

## Wake-ups

| Term | Part of speech | Meaning |
| --- | --- | --- |
| wake-up | noun | A row in the chat's database that starts a turn at a time: a reminder or a routine. Its message has the kind `wake`. It waits until the chat is idle. Package `@everchat/wakeups`, for the local use. |
| reminder | noun | A wake-up with one time. It ends when it fires. |
| routine | noun | A wake-up with a schedule. It fires again and again, one time each hour at most. |
| fire | verb | Said of a wake-up: to log its `wake` message and start its turn. A wake-up that was missed while EverChat did not run fires one time at the next start. Also the noun. |

## Words we do not use

| Do not write | Write | Why |
| --- | --- | --- |
| conversation, thread | chat | One name for one thing. |
| session (for the chat) | chat | "Session" is the factory's word. Use it only when you write about the factory. |
| history | log | The log is a table with exact rules. |
| log, log line (for what the program says about its own work) | diagnostic | The log is the chat's messages. As a verb, "to log" is still correct for both: a message is logged, and a module logs a diagnostic. |
| context (for what the model is shown) | view | "Context window" is still correct for a model's size limit. |
| assistant, AI, bot (for who speaks) | EverChat | `asst` is only the name of the kind. |
| `ever`, `unii` | `asst` | The names of the old code and of upstream for that kind. |
| tool call | program, function, or call | The model's only tool is code mode. Say which one you mean. |
| model call, API call, call (for a request) | request | A call is a run of a program or a function. |
| compact (a chat) | build a node | Nothing in EverChat compacts or replaces the chat. A compaction builds one node. |
| truncate, cut (for a result) | shorten | "Cut" is for a turn or a call that a stop interrupted. |
| resume | continue | One word for "go on after a stop". |
| worker, sub-agent | agent, subagent | A worker thread is still a worker thread: the sandbox's, and no agent. A Cloudflare Worker is still a Worker. |
| background shell | (none in the first version) | Background work is an agent. Background shells and monitors come later, for the local use only (`docs/design.md`, Q54). |
| user (for the human) | person | `user` is the kind of the person's messages. |
| transcript (for the messages on the screen) | the messages | A transcript is an export, in a file. |
| line (for a row of the screen) | row | A line is a node as the model reads it. A line of a text file is still a line. |
| device (for the terminal that the program draws on) | terminal | A device is a computer on which functions run. |
| headless mode, print mode, batch mode | pipe mode | One name for the interface with no terminal. A batch is a round of merges. |
| block (for a part of a text) | paragraph | A block is one piece of a view in a request. |
| chunk, token (for a piece of what streams) | piece | A token is what a vendor counts. |
| token (for what a connection shows) | access token | A token is what a vendor counts. |
| token (for the start value of a local server) | start value | The inspector's code calls it its token. It is not an access token. |
| agent, tenant chat (for the chat of a tenant) | hosted chat | An agent is a helper that EverChat starts. |
| outside component, frontend (for the tenants' service) | backend | One name for one thing. A browser page is a client. |
| prefix (for `everchat_`) | table prefix | The prefix is the first bytes of a request. |
| stream (for the `GET` of events) | event stream | "Stream" is a verb, for what the model gives while a step runs. |
| profile (for a list of functions) | provider | The functions of a hosted chat come from its provider. |
