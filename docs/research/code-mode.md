# Code mode in Claude Code and in other harnesses, against EverChat's

Claude Code now has a Code Mode: the model writes JavaScript that makes
several tool calls in one step (https://code.claude.com/docs/en/code-mode).
EverChat gives the model only code mode (AGENTS.md, "Code mode is the only
primary tool"). This document answers four questions. What does Claude
Code's Code Mode do, from its own page? How does it handle a call that needs
a person's yes, and what does that mean for option C (the operator's
choice): can a program call `propose(...)`, end, and can EverChat run the
approved call later, with no change to `pi-codemode`? How do Claude Code,
Cloudflare's Code Mode, Anthropic's programmatic tool calling and EverChat
compare? And what can EverChat take from Claude Code, and what not? It
decides nothing. The page exists, and it is a user guide: it says what the
model writes, the limits in time, the permission checks and how to turn the
mode on. It does not name the engine, a memory limit, an output limit or how
the functions are declared to the model. Those points say `not proved`.

`docs/research/functions.md` already covers Cloudflare's Code Mode, the
library `pi-codemode`, and options A to D for approval. This document does
not repeat them. Since then, the operator decided (2026-11-14): option C;
hosted chats have no `shell` and no file functions (this answers question 1
of `functions.md`); `workerd` is a second target; an idle chat is unloaded
and costs no memory.

## Today

| Fact | Where |
| --- | --- |
| The model has one tool, `run`. Its description says that a program is the body of an async function, and lists the functions as TypeScript declarations. | `src/head.ts:28`, `src/head.ts:31`, `src/head.ts:40` |
| A program starts with nothing from the programs before it. | `src/head.ts:37` |
| The declarations are a fixed list: name, signature, description. | `src/functions.ts:44` |
| `Functions.call` runs one function by its name, with JSON arguments and a caller. It does not need a sandbox. | `src/functions.ts:139`, `src/functions.ts:221` |
| The sandbox gives each function name to the library as a global, with `spread: true`. | `src/sandbox.ts:187` |
| The library calls a global's `execute` and sends any JSON value back to the program. | `node_modules/@earendil-works/pi-codemode/dist/runtime/execution.js:319`, `:320` |
| Each function call gets a `call` row at its start and its whole result at its end. | `src/sandbox.ts:146`, `src/sandbox.ts:160` |
| No deadline; the compute limit (60 s with no function at work); 512 MiB for the engine. | `src/sandbox.ts:182`, `src/sandbox.ts:60`, `src/sandbox.ts:56` |
| A program's call row is written before it runs, and its `tool` and `echo` items when it ends. | `src/turn.ts:260`, `src/turn.ts:280` |
| A turn ends at the first step that runs no program and gets no steer. | `src/turn.ts:314` |
| A restart closes each `running` function as `cut`, then each `running` program as `cut` with its list. The program does not run again; the turn goes on. | `src/turn.ts:468`, `src/turn.ts:472`, `src/turn.ts:485` |
| Call statuses: `running`, `done`, `failed`, `denied`, `cut`. None means "waits for a person". | `src/migrations.ts:143` |
| The hooks are not built. AGENTS.md says that they will run at each function's row. | AGENTS.md, "Code mode is the only primary tool" |

## Facts

### Claude Code's Code Mode

All from https://code.claude.com/docs/en/code-mode (read 2026-11-14), unless
the line names another page.

| Point | What the page says |
| --- | --- |
| What it is | "Claude writes a piece of JavaScript that makes the tool calls, and Claude Code runs that code in your session." It is "experimental and off by default. It may change or be removed in any release." |
| What the model writes | JavaScript. The example calls a shell with a tagged template (`` $`rg -l ...`.text() ``, `.nothrow()`) and a function `edit(target, old, new)`. "The last line returns the file's path and the test output to Claude": the example's last line is an expression, not a `return`. |
| The tool's name | `REPL`: "write a `PreToolUse` hook that matches `REPL`, the tool that runs Claude's code, and read the JavaScript from `tool_input.code`." |
| Engine and isolation | The page names no engine and no isolation of the code. For limits on commands it points to sandboxing (https://code.claude.com/docs/en/sandboxing). Engine: not proved. |
| Which functions | The session's own tools: "Each tool call that Claude's code makes goes through your `deny` and `ask` permission rules and your `PreToolUse` hooks. You don't need to change a rule or matcher for a tool such as `Bash`." How they are declared to the model: not proved (the tools reference, https://code.claude.com/docs/en/tools-reference, does not list `REPL`). |
| What the person sees | "you see the tool calls, such as the edit's diff, and not the code." The code is a collapsed **Code** row in the transcript viewer (`Ctrl+O`). |
| Time limit | "Waiting: Claude answers after the code finishes, and the code stops after ten minutes, including time you spend at permission prompts". "Background: you can keep talking to Claude, and the code can run for up to two hours", only in auto or `bypassPermissions` mode. |
| Memory and output limits | Not on the page. Not proved. |
| Output of background code | It passes the `UserPromptSubmit` hooks, with `source` `poll_event`, and a hook can block it (same page, and https://code.claude.com/docs/en/hooks). |
| How to turn it on | `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, in the shell or the user settings, not in a project's settings; a `0` in managed settings blocks it. Claude Code v2.1.323 or later, the native build, an interactive terminal session; not with `-p`, the Agent SDK, a gateway or a cloud provider. Also https://code.claude.com/docs/en/env-vars. |
| Resume | "you can resume a Code Mode session only in the terminal, with Code Mode on". What a restart does to code that runs: not proved. |

How it handles a call that needs a person's yes:

| Mode | What happens | Source |
| --- | --- | --- |
| Modes that ask | "the code starts without a review, and you're prompted for each tool call that would prompt you in that mode". The program waits at the prompt, and the wait counts in its ten minutes. | https://code.claude.com/docs/en/code-mode |
| Auto mode | "the classifier reviews each piece of code before it runs, not each tool call. It doesn't see values computed at run time". `permissions.deny` rules still apply to each call. | same; https://code.claude.com/docs/en/auto-mode-config |
| Auto mode, new code while old code runs | The old code "loses its classifier review", and the person is asked about its remaining calls, with a countdown ("1:59" in the example). With no answer, "that call is refused". | https://code.claude.com/docs/en/code-mode |
| A `PreToolUse` hook, on a call from code, that "couldn't start, was killed, exited with 126, 127, or a code above 128, or returned an HTTP error or invalid output", or that timed out | The call is refused, "even when `onFailure` is unset". | same |
| The same hook with an ordinary exit code | "If a `command` hook exits with an ordinary code such as 1, the call goes ahead unless you set `"onFailure": "block"`." | same |
| `"onFailure": "continue"` | It lets calls "go ahead when a `command` or `http` hook fails or times out", also in Code Mode. | same |
| Outside Code Mode | "On most events, when a hook fails or times out, Claude Code still carries out the action", unless `"onFailure": "block"`. | https://code.claude.com/docs/en/hooks |

So Claude Code is option A of `functions.md`: the program waits inside the
call, for at most ten minutes (two hours in the background), with a person
at the screen.

### Anthropic's programmatic tool calling (the API)

It is a separate thing from Claude Code's Code Mode: a feature of the
Messages API (https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling).

| Fact | Source |
| --- | --- |
| "Claude writes Python code that calls the tool as a function" and runs it "in a sandboxed container through code execution". "When a tool function is called, code execution pauses and the API returns a `tool_use` block." | programmatic tool calling page |
| A tool is callable from code when its definition has `allowed_callers: ["code_execution_20260120"]`. Such tools are "async Python functions"; each "takes a single dict of arguments and returns a string". `allowed_callers` is "not a hard API-level block on direct calls". | same |
| "the pending call times out after about 4 minutes and raises a `TimeoutError` inside the code" (the example: "no response after 270s"). | same |
| "After about 5 minutes of inactivity a container is checkpointed"; containers "expire 30 days after creation". The answer to a paused call must carry the container id and only `tool_result` blocks. | same |
| Not with `strict: true` tools, MCP connector tools, or `disable_parallel_tool_use`. Not eligible for zero data retention: "Container data ... is retained for up to 30 days." | same |
| The container: 5 GiB of RAM, 5 GiB of disk, 1 CPU, no internet. A 90-second wall-clock limit on each Python cell. The interpreter state "persists across requests that reuse the container". | https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool |

### Cloudflare's Code Mode (only what `functions.md` does not have)

| Fact | Source |
| --- | --- |
| The executor takes a Worker Loader binding "used to create isolated Workers", a `timeout` (default 60000 ms), and `globalOutbound` (default `null`: "null blocks access"). | https://developers.cloudflare.com/agents/api-reference/codemode/ |
| `types`: "TypeScript declarations shown to the model. Code Mode generates them when omitted." | same |
| `expirePaused()` "Terminates stale paused or running executions", older than 24 hours by default (`DEFAULT_PAUSED_TTL_MS`); one durable value is at most 1,000,000 characters; 50 ended executions are kept by default. | same |
| "Issue connector calls sequentially when an execution can pause. Concurrent calls can reach the replay cursor in a different order." `step()` records a closure's result for replay. | same |
| "Approval starts another pass with the same source code and execution ID. Previously completed calls replay from the durable log, the approved call executes, and the generated code continues." The wait survives "Durable Object hibernation". | https://developers.cloudflare.com/agents/guides/human-in-the-loop/ |

### A trial of option C

Bun 1.4.4, the checkout's `pi-codemode` 1.5.2, no model, no change to the
library. Script: `/tmp/ec-4jj7/trial/propose.ts`. A global `propose`
records `{ fn, args }` and gives back `{ pending: 1 }` at once. The program
`await propose("send", [...])` printed the answer and returned: `ok: true`,
60 ms. After the program and its worker had ended, the host ran the
recorded call from the record alone. So a program can propose and end, and
the act needs no program, no engine and no worker.

## Options

What EverChat could take from the three designs:

| Option | What it gives | What it costs | What it rules out |
| --- | --- | --- | --- |
| C. `propose(fn, args)` as a function (the operator's choice) | The wait is a row, not a program: it survives unload, restart and upgrade. The person approves the exact call. No change to `pi-codemode` (trial). | An approvals table, a path that runs an approved call outside `Sandbox.run`, and a message with its result. The program's code after the proposal does not get the result. | Nothing of the others. |
| A, bounded (Claude Code's way) | A short yes from a person at the screen, inside the same program. | A live worker (about 6 MB, `functions.md`) for each wait; lost at restart and unload. | Long waits; unload during the wait. |
| D. Replay (Cloudflare's way) | The program goes on after the yes, from its start, answered from the log. | `functions.md`'s journal and fingerprint; calls in a fixed order (Cloudflare's own rule). | An upgrade during the wait (the fingerprint changes). |
| B2. Background programs (Claude Code's two hours) | The chat goes on while a long program runs; its result comes later as a message. | A live worker for hours, while the chat is idle. | Unload of a chat with a program at work. |
| K1. Engine state kept resident between programs | A program can use variables of the one before it. | The engine and its worker live between turns; their memory holds tenant data. | Unload with no cost; `src/head.ts:37`'s rule. |
| K2. Engine state checkpointed, then unloaded (the API's way: a container is checkpointed after about 5 minutes and restored on the next request) | The same continuity, with no memory while idle. | `pi-codemode` exposes no snapshot, so a fork or a new integration of `quickjs-wasi`'s; the host's half saved too; a restore only on the same engine build; the program's data (tenant data) kept in a file or row. All in `functions.md` (option A with a crash or an unload). | `src/head.ts:37`'s rule; an upgrade between programs drops the state. |
| H. A hook on the whole program (Claude Code's `REPL` hook, `tool_input.code`) | A policy can refuse a program before it runs. | One more hook point. A review of the text does not see values computed at run time (Claude Code's own warning). | Nothing, if the hooks at each function stay. |
| V. Vendor-hosted code (programmatic tool calling) | No sandbox of our own. | One request to the vendor for each function call; Python, not JavaScript; one vendor only; a call that waits more than about 4 minutes fails; tenant data kept up to 30 days by the vendor. | OpenAI; zero data retention; `workerd` as the place where programs run. |

The four designs side by side:

| | Claude Code's Code Mode | Cloudflare's Code Mode | Programmatic tool calling (API) | EverChat with `pi-codemode` |
| --- | --- | --- | --- | --- |
| Engine and isolation | JavaScript; engine not on the page (not proved). | An isolated Worker from the Worker Loader; no network by default. | Python in a container: 5 GiB, 1 CPU, no internet. | QuickJS in WebAssembly, a worker thread for each program; 512 MiB; no files, network or timers (`src/sandbox.ts:181`). |
| Where the program runs | "in your session", on the person's machine. | In Cloudflare, under a Durable Object. | On Anthropic's servers. | In the EverChat process (`src/sandbox.ts:201`). |
| How functions are declared | The session's tools (`Bash`, `edit`); the form: not proved. | TypeScript declarations, generated from schemas or given as `types`. | Tool definitions with `allowed_callers`; Python async functions that take a dict. | TypeScript declarations in the `run` tool's description (`src/head.ts:40`). |
| What waits for a person | The program, at the prompt, inside its ten minutes; a countdown in auto mode. | Nothing live: the run pauses before an approval-gated call; a yes replays it. | The program, for each call, for about 4 minutes; a person's yes must fit in that. | Nothing yet; with C, a row (`src/migrations.ts:143` has no status for it). |
| What a restart does | Not proved. A session resumes only with Code Mode on. | A paused execution survives hibernation; it is replayed on approval. | The container is checkpointed and restored within 30 days. | A running program is `cut` with its list, and the model decides (`src/turn.ts:468`). |
| What is kept of the program | The code, as a Code row of the transcript. | The source, the call log, 50 ended executions. | The container (files, interpreter state) up to 30 days. | Its source (`tool`), its result (`echo`), and each function's arguments and result (`src/sandbox.ts:146`, `src/sandbox.ts:160`). |

## What fits, what does not

- **Option C needs no change to `pi-codemode`.** A global may give back any
  JSON value (`execution.js:319`), and the trial proved it. The work is
  EverChat's:
  - a `propose` declaration in `src/functions.ts:44`, and its code;
  - an approvals table that keeps the exact `fn` and arguments, the tenant
    and the answer;
  - `propose`'s own `call` row closes `done` at once. If it stayed
    `running`, a restart would cut it (`src/turn.ts:468`);
  - a path that runs the approved call with `Functions.call`
    (`src/functions.ts:221`), outside `Sandbox.run`: today the row is
    written inside the sandbox's `invoke` (`src/sandbox.ts:141`). The
    `Caller` needs a `program` (`src/functions.ts:96`): the proposal's call
    can be its parent;
  - the result goes to the chat as a message, and a turn starts. The
    proposing turn ends as today: the model sees "pending" and replies with
    text (`src/turn.ts:314`).
- **Claude Code chose A, and A does not fit the hosted use.** Its wait has a
  person at the screen, one chat, and a wall of ten minutes that counts the
  prompt. A hosted chat waits hours or days, and is unloaded while it
  waits. A live program for each wait is the cost that C avoids.
- **Take the hook on the whole program (H), next to the hook at each
  function.** Claude Code has both: rules and `PreToolUse` at each call, and
  a hook (or a classifier) on the code. Its own page says why the second is
  not enough alone: a review of the text "doesn't see values computed at
  run time". EverChat's rule stays: the control is at the function's row.
- **Make a hook that fails refuse the call, for every kind of failure.**
  Claude Code does this only in part: for a call from code it refuses on a
  hook that cannot start, is killed, exits 126, 127 or above 128, gives
  invalid output, or times out; but an ordinary exit code such as 1 lets
  the call go ahead unless `onFailure` is `block`, and `continue` lets all
  failures through (Facts). So EverChat cannot copy its default: a policy
  hook that exits 1 would let a network action through. For a tenant,
  fail closed on every failure is EverChat's own recommendation.
- **Do not take vendor-hosted code (V).** Programmatic tool calling makes
  the vendor run the program. It is Python, for one vendor, a round trip
  for each call, a 4-minute wall for each call, and tenant data in the
  vendor's container for up to 30 days. EverChat runs its own programs and
  talks to more than one vendor.
- **Do not take background programs (B2) or a resident engine (K1) for
  hosted chats.** Both keep a worker and its memory alive while the chat is
  idle. That breaks "an idle chat costs no memory". A long piece of work
  in a hosted chat is a function that a service runs, not a long program.
- **Kept state by checkpoint (K2) does not break unload**, as the API
  shows. It is possible later, not first: it needs the snapshot work of
  `functions.md`, and it stores each program's data. Take it only if
  programs often need the variables of the ones before them.
- **Take later, maybe: the last expression as the result.** Claude Code's
  example ends in an expression, not `return`. EverChat's `run` asks for
  `return` (`src/head.ts:31`). Whether models forget `return` often: not
  proved. Measure on kept programs before a change.
- **D stays the path after C**, as `functions.md` says. Cloudflare's rule
  for it is a fact to keep: calls must come in a fixed order, so a program
  that can pause must not run its calls with `Promise.all`. EverChat's
  description asks for `Promise.all` (`src/head.ts:35`).
- **First:** C, with the hook on the whole program and fail-closed hooks
  designed at the same time, because all three touch the `call` row.

## Limits

- The Claude Code page does not say which engine runs the code, how it is
  isolated, how its functions are declared, or its memory and output
  limits. Nothing in this document depends on them; a comparison of
  engines needs a source that we do not have.
- The page is for an experimental feature that "may change or be removed in
  any release". Its facts are as of 2026-11-14.
- With C, the code after `propose` does not get the result. A program that
  must act on the result of an approved call needs a second turn (C) or a
  replay (D).
- A review of a program's text cannot prove what the program will call.
  Only the check at each function can.
- Programmatic tool calling cannot carry a person's wait longer than about
  4 minutes inside one program; and it is not eligible for zero data
  retention.

## Questions for the operator

1. Is a hook on the whole program (before it runs) wanted, next to the hooks
   at each function? Recommended: yes, with the same refusal path; it is
   one more hook point.
2. Does a hook that fails or times out refuse the call? Recommended: yes for
   tenant chats, for every failure (fail closed). Claude Code refuses only
   some failures by default; an exit code of 1 lets the call go ahead.
3. After an approved call has run, does a turn start at once, or does the
   result wait for the next message of the person? Recommended: a turn
   starts at once, with the result as a message, so the model can report it.
4. May a tenant chat run a program in the background, after its turn ends?
   Recommended: no; long work is a function that a service runs.
5. Should EverChat take the last expression as the result, as Claude Code
   does? Recommended: not now; measure first how often a program forgets
   `return`.

## Words

| Term | Meaning |
| --- | --- |
| Code Mode (Claude Code) | Claude Code's experimental mode in which the model writes JavaScript that calls the session's tools. |
| `REPL` | The tool of Claude Code that runs the model's code; hooks match it by this name. |
| programmatic tool calling | The Messages API feature in which Python code in the vendor's container calls the caller's tools. |
| `allowed_callers` | The field of a tool definition that lets code in the container call the tool. |
| background code | Claude Code's code that runs while the person talks on, up to two hours. |
| tenant | A separate company in a hosted deployment; tenants may be competitors. It has many chats (its people's), its own functions and credentials. The operator's decision of 2026-11-14 replaces `functions.md`'s "one person, team or customer". |
| approval | A person's yes or no to one function call, with its exact arguments, before it acts. |
| propose | To ask for an approval: the program gives the call that it wants, and gets "pending" at once (option C). |
| replay | To run a program again from its start, and answer each earlier call from its log (option D). |
| pass | Cloudflare's word for one run of an execution's code; a replay is a new pass. |
