`packages/local/` (`@everchat/local`): the rest, the local build.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/local/` (`@everchat/local`): the rest, the local build. Its
  modules, flat, are in `packages/local/src/`: the terminal, pipe mode, the
  shell and the file functions, the inspector, the command
  `everchat serve` (`packages/local/src/serve.ts`) and the stack of a
  host's chat (`packages/local/src/hosted.ts`), the reading of the address
  and the key from the environment and a file, the worker thread's
  program (`packages/local/src/worker.ts`, see "Code mode is the only
  primary tool" in `packages/core/AGENTS.md`), and the entry of the
  program. Its entries: `./hosted`, `./limitfile`,
  `./localfunctions`, `./shell`, `./testing` (`packages/local/tests/help.ts`),
  and the one for that reading.
- `packages/local/tests/`: tests of the whole program, or of many modules
  at once, or that need a second process. `packages/local/tests/help.ts`
  holds what the tests share, and exports again the helpers of
  `packages/sqlite/tests/help.ts`. `packages/local/tests/screen.ts` is a
  terminal in memory, `packages/local/tests/pty.ts` runs a process in a real
  pseudo-terminal, and `packages/local/tests/vendor.ts` is a fake vendor for
  a whole process (see "The terminal and pipe mode").
- `packages/local/src/main.ts`: the program's entry. `just run` starts it
  from its source, and `just build` makes the executable `everchat`.
  `just test-build` builds it and runs the tests of the whole program on
  it.
- `packages/local/src/inspector.html`: the inspector's page (see "The
  inspector"). It is the one file of the packages that a browser runs.

## What the factory needs

So the local build must (see `docs/factory.md`):

- Work fully as an interactive terminal program in a PTY, as one process. No
  separate server to start, and no browser sign-in.
- Have hooks, like the hooks in `claude` and `codex`. We have not built them
  yet. A hosted chat has none.

## The terminal and pipe mode

- It draws on the terminal's main screen, not on the alternate one.
- A row that a component gives must not be wider than the screen: `pi-tui`
  fails on such a row. `Wrapped` and `Row` in `packages/local/src/paint.ts`
  keep to that.

What holds for both:

- No control character of a text reaches the terminal or the standard output
  (`clean` in `packages/local/src/paint.ts`). Use it for every text that you
  show.

How to test them:

- `packages/local/tests/pipe.test.ts` runs the whole program in pipe mode, as a
  process with pipes, against a fake vendor on this machine
  (`packages/local/tests/vendor.ts`). Use it first for anything that does not
  need the screen or the keys: a turn, a program, a restart, a signal, the
  arguments, the exit code.
- `packages/local/tests/screen.ts` is a terminal in memory (xterm.js with no
  window). A test gives it to the terminal's layer, types with `type`, and
  reads the rows that a person would see. Use it for what the screen shows and
  what a key does (`packages/local/tests/terminal.test.ts`).
- `packages/local/tests/pty.ts` runs the whole program as a process in a real
  pseudo-terminal (`packages/local/tests/main.test.ts`). Use it for what only a
  real terminal shows: the launch of the screen, the signals, a closed window.
- `just test-build` runs the whole-program files on the executable
  (`EVERCHAT_BIN=<file>` names the program to start).

## The config file

- The place: `config.json` in the home (`EVERCHAT_HOME`, default
  `~/.everchat`). The person writes it by hand, and the program only reads
  it. `packages/local/src/config.ts` reads and decodes it with `Schema`, and
  `packages/local/src/config.test.ts` tests it.
- Only the command `everchat` (the terminal and pipe mode) reads it, one
  time, at its start, before the database is opened. `everchat inspect` and
  `everchat serve` do not. No file, and the file `{}`, set nothing.
- The form: one JSON object, every field optional.
  - `model`, `effort`, `compactor`: texts, each as its flag. A flag of the
    launch wins over the file, and the file over the fixed defaults.
  - `limit`: the output limit in characters, a whole number from 2,000 to
    1,000,000.
  - `servers`: the connectors, at most 16 MCP servers by name. A name is an identifier
    (`^[A-Za-z_$][A-Za-z0-9_$]*$`), the namespace of the server's
    functions. A server is `{ command, args?, env?, cwd? }` (a program on
    stdio) or `{ url, headers? }` (HTTP, an `http:` or `https:` address):
    one of the two. Each may have `approval` (`"auto"`, `"ask"` or
    `"deny"`, for each of its tools) and `tools` (a tool's name to one of
    the three, which wins for that tool); with none, a tool is `"auto"`.
    A launch loads them ("The connectors").
  - A field that is not in this list is refused, at any depth.
- The faults: a file that cannot be read, that is not JSON or not one
  object, a field of a wrong type or out of its bounds, an unknown field, an
  unset variable. Each fault stops the start: the program writes it as one
  line on the standard error, with the file's path and the field's path,
  and ends with the code 1, before the screen is up and before the database
  is opened.
- Secrets: a secret goes into the file only as `${NAME}`, a variable of the
  environment. It is replaced at the start in each text of a server's
  `args`, `env`, `url` and `headers`, and nowhere else; a variable that is
  not set refuses the start. No other form: no default, no escape. Never
  put a secret in the file itself. No fault, message or test output holds a
  value of the file or a replaced one: a fault names the field and the
  variable only. Keep that rule when you add a field.

## The connectors

- What a launch starts: each launch of `everchat` (the terminal and pipe
  mode) loads the servers of `config.json` one time, in `layer` of
  `packages/local/src/main.ts`, after the store and the diagnostics and
  before the layers that take the chat's list of functions.
  `packages/local/src/connectors.ts` makes each server's transport: a
  program on stdio is started as a child, with its `command`, `args` and
  `cwd` (the work directory when none); an HTTP address is reached with its
  `url` and `headers`. `everchat inspect` and `everchat serve` start none.
- The list: the built-ins first (`DECLARATIONS`), then the servers'
  functions, `<server>.<tool>`, sorted by name. The head is made one time
  from that list, so it changes only at the next launch. With no server,
  the head keeps its bytes, and a start loads no module of the client
  (`@everchat/mcp`, the SDK): `main.ts` imports them only when the file
  names a server. The executable still holds them.
- A server that does not answer within the load's limit (10 s), or that
  fails, gives no function, and the chat loads without it. Nothing is
  written to the terminal for it: each refusal is a warning in the log
  (the table `everchat_log`, the source `mcp`),
  and names the server and the tool by their names only.
- When it ends: the connections and the children live in the launch's
  scope, and end with it, at a quit, at a signal, at a failure, and when
  the input of pipe mode ends. The client closes a program's input, then
  sends SIGTERM, then SIGKILL; that close signals only the one process
  that it started, and its last steps run on timers that an exit drops.
- The run tag: each program on stdio carries the launch's run tag in its
  environment (`EVERCHAT_RUN`, `TAG` of `shell.ts`), as a command of the
  shell does, and so does each process that it starts. The load has an end
  of its own (`swept` of `connectors.ts`), registered before the load, so
  it runs after the client has closed the connections: one synchronous
  `sweep` of the tag, which waits for no timer of the SDK and kills what
  is left: a server that did not end, and each process that a server
  started. The shell's layer is built before the load, so its own sweep
  of the tag, at its end, also comes after the client's close.
- A server refused at the load is closed at once by the SDK. One that hears
  neither the end of its input nor SIGTERM lives until the SDK's last step
  or the sweep at the launch's end, whichever comes first.
- A launch that was killed: the next launch's sweep of the ended run tags
  (the shell's layer) stops its servers and their helpers too.
- A sweep (`sweep` of `shell.ts`, for the shell's end, the connectors' end
  and the start's sweep of what a crash left) lists the processes with the
  tag, kills them, and lists again, with no wait, until a list holds none
  that it has not killed, and at most 8 times (`SCANS`): a process born
  while it runs, of a parent that it then kills, is in the next list.
- The limits, as the shell's: a process that takes the variable out of its
  environment is not found, and a program that starts new processes faster
  than 8 lists find them leaves the last ones. Both are left for the next
  launch's sweep of the ended run tags.
- The child's environment: the SDK's short list of variables (`HOME`,
  `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), the server's `env` over it,
  and the run tag over both: a config's `env` can neither replace the tag
  nor take it away. Never the whole environment of EverChat. Its standard
  error is dropped: a line there would break the screen.
- The settings of a tool (`approval`, `tools`): `deny` leaves the tool out
  of the list; `ask` leaves it out too, until approval is built; with none,
  `auto`: the tool is in the list, and a program calls it with no
  question.
- A large result: more than 64 MiB (`HARD`) is refused with its size. More
  than 1,048,576 characters (`MAX`) is shortened: the program gets the
  head, a line that names `result(<call>, from, to)`, and the tail; the
  call's row keeps the whole, and `result(id, from, to)` gives a part of it.
- The example: `tools/mcpexample.ts`, a server with `add` and `send`, run
  by `just mcp-example` (stdio) or `just mcp-example --port 4682` (HTTP on
  127.0.0.1). Its head comment has the lines of `config.json` that name it;
  a program of the chat then calls `example.add({ a: 2, b: 3 })` and gets
  `{ sum: 5 }`.
- The tests: `packages/local/src/connectors.test.ts` (the transports) and
  `packages/local/tests/connectors.test.ts` (a launch: the list, a call, a
  server that never answers, no client with no server, no child left: of
  a server that starts a helper, and of one that hears neither the end of
  its input nor SIGTERM, at the end, at a signal, and during the load).

## The inspector

- The page (`packages/local/src/inspector.html`): one file with its style and
  its script, no framework and no build step.

The rules that it keeps:

- It only reads. Do not add a route that changes the chat: to send a
  message from a browser is a third interface, and that needs its own
  design.
- The chat is private, and a port is not. The server listens on
  127.0.0.1 only, and every path starts with a token that is new at each
  start. Keep both.
- The page puts every text of the chat on the page as text, never as HTML
  (`h` in the page's script makes each element).

How to test it:

- `packages/local/src/inspect.test.ts` asks the read module about a chat that a
  fake wire made (`withChat` in `packages/local/tests/help.ts`).
- `packages/local/src/inspector.test.ts` asks the server: who may read, and
  what each route answers.
- `packages/local/tests/page.test.ts` runs the page's script in a browser with
  no window (the library `happy-dom`) against the real server, and reads what a
  person would see. That browser has no layout. After a change to how the page
  looks, look at it in a real browser: `just sample <home>` makes a chat to
  look at, with no model.
- `packages/local/tests/inspect.test.ts` runs `everchat inspect` as a process,
  next to a launch of the chat. `just test-build` runs it on the executable
  too.

## The command `everchat serve`

- It is the host on this machine (`@everchat/server`), for the reference
  client's page (`packages/server/src/client.html`), for development only:
  the backend of the page, not a hosted deployment. `docs/host.md`, section
  7, is its design.
- Its port is 4681 (`--port <n>`; 0 for any free port). It listens on
  127.0.0.1 only and takes only `127.0.0.1:<port>` as the `Host`. It
  refuses the port 80, where a browser gives no port in `Host`. It
  prints one line on the standard output, the page's address with a start
  value that is new at each start, and its own diagnostics go to the
  standard error.
- Its file is `serve.db` in the home, next to `everchat.db`, with one
  local tenant. Its secret is new at each start and held in memory only, so
  a token of an earlier start opens nothing.
- Run one `everchat serve` for a home: the command does not lock its file.
  A second one on another port gets `409 chat_elsewhere` for a chat that the
  first has loaded, and its clients get no live event of that chat.
- `packages/local/src/main.ts` loads it by a dynamic import, as the
  inspector: a launch of the chat or of the inspector loads no module of the
  host. `packages/local/tests/serve.test.ts` runs it as a process, and
  `just test-build` runs it on the executable too.

## Effect in the local build

- The arguments are read with `effect/cli`, and the standard input, the
  standard output, the file system and the paths in
  `packages/local/src/main.ts` and `packages/local/src/pipe.ts` are Effect's
  services (`Stdio`, `FileSystem`, `Path`), from `@effect/platform-bun`. Import
  one module of that package (`@effect/platform-bun/BunServices`), not its
  index: the index loads all of it, and each start pays for that.
