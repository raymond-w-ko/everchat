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
