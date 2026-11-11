# EverChat glossary

This file is the dictionary of technical names for EverChat. Use each name
exactly as it is here, in code, in documents, and in replies. One thing has
one name. If you need a name that is not here, add it here first.

The names are those of the new design (`docs/schema.html`). A name in
`code font` is also a name in the database or in the code. Where the old
code or upstream uses another word, the entry says so.

The last section lists words that we do not use, and the word to use
instead.

## The chat and its log

| Term | Part of speech | Meaning |
| --- | --- | --- |
| chat | noun | The one exchange between a person and EverChat. It never ends. One chat is one database in one home. |
| person | noun | The human who uses EverChat. The factory calls its one person the operator. |
| EverChat | noun | The program, and the agent that the person talks to. In the log, its messages have the kind `asst`. |
| log | noun | All the messages of the chat, in the order they came, kept for ever. Table `msg`. A message in the log never changes and is never deleted. The table named `log` is not the log: it holds the diagnostics. |
| message | noun | One entry of the log. It has an id (0, 1, 2, ...) that never changes and is never used again. |
| page | noun | One message of a text that is too long for one message. The text is logged as pages in a row, of at most 30,000 characters each. Each page has its own id. |
| kind | noun | The type of a message. It says who or what wrote it. The model reads each message as `<kind>: <text>`. See the table below. |
| thought | noun | The model's reasoning text. It is shown to the person and never logged. The old code calls it `mind`. |
| image | noun | A picture that a message carries, as it was sent to the model. Table `image`. |
| original | noun | An image as the person or a tool gave it, before EverChat made it smaller for the model. Table `image_original`. It exists only when it is not what was sent. |
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

## The memory

| Term | Part of speech | Meaning |
| --- | --- | --- |
| memory | noun | The log, the tree, and the views together. It is the core idea of EverChat: the chat itself is the memory. |
| tree | noun | A binary tree of nodes over the log. Its lowest level has one node per message. |
| node | noun | One line of the tree, of at most 512 bytes. Node `(l, i)` covers the `2^l` messages from message `i·2^l` on. Table `node`. A node is written once and never changes. |
| level | noun | The `l` of a node. A node of level `l` covers `2^l` messages. |
| leaf | noun | A node of level 0. It covers one message. |
| halves | noun | The two nodes one level below a node: `(l-1, 2i)` and `(l-1, 2i+1)`. |
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
| head | noun | The part of a request before the messages: the system prompt and the tool list. Table `head`. The chat's turns, its compactions, and its subagents all have the same head. |
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
| steer | verb | To send a message while a turn runs. The message joins that turn: the model reads it between two programs. A message that comes too late for the turn starts the next turn. |
| code mode | noun | The way the model works: it writes a program that calls functions. Code mode is the only tool that EverChat gives the model. |
| tool | noun | What a vendor's API lets the model call. EverChat has one: code mode. |
| program | noun | The code that the model writes in code mode. A sandbox runs it. |
| function | noun | One thing that a program can call: `shell`, `read`, `write`, `edit`, `zoom`, `date`, `result`, and later others. A function runs on EverChat's side, outside the sandbox. |
| call | noun | One run of a program, or one run of a function inside a program. Table `call`. A call is recorded when it starts, not when it ends. |
| sandbox | noun | The closed place where a program runs. In there, a program has no files, no network, and no timers. It can reach the world only through functions, and it can start a process only through the `shell` function. |
| worker thread | noun | The thread in which the sandbox runs one program. Each program has its own. It is not an agent. |
| result | noun | What a call gave back. The database keeps it whole. |
| output limit | noun | The most text of a program's result that the model is shown: 30,000 characters by default. A longer result is shortened: the model gets its head and its tail, and the whole text is put in a file. A function gives its whole result to its program: the limit is not on that. |
| hard limit | noun | The most text that a call may produce: 64 MiB. Past it, the command is stopped. |
| time limit | noun | The most time that one command of the `shell` function may run: 600 seconds, or the seconds that the program gives. Past it, the command is stopped. |
| compute limit | noun | The most time that a program may run with no function at work: 60 seconds. Past it, the program is stopped. A program may wait for a function as long as that function takes. |
| shorten | verb | To show the model less than the whole result, because of the output limit. Use this word, and keep "cut" for a turn or a call. |
| cut | adjective | Said of a turn or a call that ran when EverChat stopped. A cut turn continues at the next launch. A cut call may or may not have finished, and the model is told so. Also said of a function that was stopped before it ended, because its program ended or was stopped. |
| denied | adjective | Said of a call that a hook refused. It did not run. |
| stopped | adjective | Said of a turn or a task that the person or EverChat ended before it was done. |
| failed | adjective | Said of a turn or a call that ended with an error. |

## Agents

| Term | Part of speech | Meaning |
| --- | --- | --- |
| agent | noun | A helper that EverChat starts: a subagent or a computer task. It has a random name such as `CalmOtter`, and its own log (table `agent_msg`) with no tree. Table `agent`. |
| subagent | noun | An agent that works on a task with the same functions as EverChat. It gets the chat view, so it knows what EverChat knows. |
| computer task | noun | An agent that uses a person's computer through screenshots, the mouse, and the keyboard. It gets no view. The code calls its role `hands`. |
| task | noun | An agent's work from one message to its report. A task can take more than one turn. |
| report | noun | The reply of an agent when its task ends. It enters the log as one `work` message, and it starts a turn of the chat. |
| device | noun | A computer on which functions run. |
| chief of staff | noun | The role of EverChat: one agent with a long memory that hands work to others. In the factory, it hands work to other harnesses. Alone, it hands work to its own subagents. |

## The program and its files

| Term | Part of speech | Meaning |
| --- | --- | --- |
| home | noun | The directory of one chat. The variable `EVERCHAT_HOME` names it. It holds the database, the config file, the hooks file, the skills, and the transcripts. |
| database | noun | The one SQLite file that holds almost all state of a chat. |
| state | noun | Data that the program writes and needs again later. State lives in the database, and nowhere else. |
| store | noun | The part of the program that reads and writes the database. No other part uses SQL. |
| migration | noun | One change of the database's tables, with a number. At each launch, the program runs the migrations that the database has not run yet. |
| config file | noun | The file of settings that a person writes by hand. The program only reads it. |
| launch | noun | One start of the program, until it ends or crashes. Table `launch`. At most one launch of a chat is live. |
| run tag | noun | A marker that a launch puts in the environment of each shell it starts. The next launch uses it to find and stop shells that a crash left behind. |
| crash | noun | The end of a launch without a clean exit. The next launch finds it and records it. |
| restart | noun | A launch after another launch of the same chat. It reads the database and continues: cut turns continue, and cut calls are closed. |
| diagnostic | noun | One line that EverChat writes about its own work, for the person who looks for a fault: a request that is sent again, a compaction that failed. Table `log`. It has a level (`debug`, `info`, `warn`, `error`) and a source, the module that wrote it. It is not a message, and the model never reads it. Diagnostics are deleted after 30 days. |
| export | noun | A copy of data from the database into a file, for other programs and for people. An export is not state: EverChat never reads it back. |
| transcript | noun | The export of what happened in a chat: launches, turns, messages, calls, and usage. It is JSONL (one JSON value per line), one file per launch, and append only. It does not hold the tree or the views. |

## The terminal and pipe mode

| Term | Part of speech | Meaning |
| --- | --- | --- |
| interface | noun | The part of the program through which the person and the chat meet. There are two: the terminal, and pipe mode. One launch has one of them. |
| terminal | noun | The person's interface to the chat: the screen that shows it, and the keys. It is one process in a PTY. Also the part of the program that draws it (`src/terminal.ts`). |
| pipe mode | noun | The interface with no terminal. The program works this way when its standard input or its standard output is not a terminal. Each line of the standard input is a message, and the messages go one after the other. Each message that enters the log goes to the standard output as text. It has no screen, no keys, and no slash commands. |
| row | noun | One row of the screen. Use this word for the screen, and keep "line" for a node as the model reads it. |
| input | noun | The box at the bottom of the terminal where the person types. Its text is the draft until it is sent. |
| status row | noun | The last row of the terminal. It says what EverChat does (`idle`, or the turn that runs), and then the pick. |
| slash command | noun | What the person sends in the terminal when its first word is a slash and letters only, for example `/help`. It tells the program what to do. It is not a message: it does not enter the log, and the model never reads it. |

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
| hook | noun | A command that EverChat runs at a fixed point, and waits for. It gets the event as JSON, and it can answer: with text for the model, or with a refusal. |
| hook point | noun | A place in EverChat's work where hooks run: a session start, a turn start, before a shell command, after a program, a turn end. |
| accepted | adjective | Said of a message that is in the log. EverChat tells the factory at once, also when the message steers a running turn and starts none. |

## The project

| Term | Part of speech | Meaning |
| --- | --- | --- |
| upstream | noun | UniiChat, the project that EverChat is a hard fork of. |
| old code | noun | The code before the rewrite. It is in `ref/`, for reading only. The git tag `before-rewrite` marks the last commit before it moved there. |
| port | verb | To write a part of the old code again in the new design, with the same behavior. The memory is ported, not invented again. |
| greenfield | adjective | With no old data to keep. EverChat reads no old file format. |

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
| worker, sub-agent | agent, subagent | A worker thread is still a worker thread: the sandbox's, and no agent. |
| background shell | (none in version 1) | Background work is an agent. |
| user (for the human) | person | `user` is the kind of the person's messages. |
| transcript (for the messages on the screen) | the messages | A transcript is an export, in a file. |
| line (for a row of the screen) | row | A line is a node as the model reads it. A line of a text file is still a line. |
| device (for the terminal that the program draws on) | terminal | A device is a computer on which functions run. |
| headless mode, print mode, batch mode | pipe mode | One name for the interface with no terminal. A batch is a round of merges. |
