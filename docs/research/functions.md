# Functions for each tenant chat: secrets, approval by a person, and the limits of code mode

The operator plans a company deployment: one chat for each person or tenant,
with many chats that are idle most of the time. This document answers three
questions. How can each tenant chat have its own set of functions, with a
secret (a bearer token, a credential) that the model and the database never
see? How can a turn stop and wait for a person's yes before a function acts,
and then go on? And what limits does code mode (`pi-codemode`, QuickJS in a
worker thread) put on many chats in few processes? It decides nothing. The
local chief of staff stays as it is.

Related: `docs/research/store.md` (the database's secret, tenancy of the
tables), `docs/research/runtime.md` (which process holds which tenant),
`docs/research/agents.md` (load, unload, routing of a person's answer).

## Today

How a function runs, from the declaration to the row:

| Fact | Where |
| --- | --- |
| The declarations are a fixed list in the program: name, TypeScript signature, description. | `src/functions.ts:44` |
| The head renders them into the description of the one tool, `run`. | `src/head.ts:28`, `src/head.ts:40`, `src/head.ts:43` |
| Each turn keeps its head as text, found again by its hash: a turn after a change of the head gets a new row. | `src/turn.ts:385`, `src/migrations.ts:81` |
| The arguments cross the boundary as JSON, and a schema decodes them. | `src/functions.ts:106`, `src/functions.ts:122` |
| `Functions` is one layer for each launch. Its only option is the work directory. | `src/functions.ts:131`, `src/functions.ts:141`, `src/main.ts:145` |
| Each function is a closure over the services of the layer (`run`). A call finds it by its name; an unknown name is an error. | `src/functions.ts:157`, `src/functions.ts:221` |
| A program's call row is written before the sandbox starts. | `src/turn.ts:261`, `src/turn.ts:280` |
| The sandbox makes a new `CodemodeSandbox` for each program. The library starts one worker thread and one QuickJS engine for each `execute()`. | `src/sandbox.ts:181`, `src/worker.ts:14` |
| Limits: 512 MiB for the engine, no deadline, and the compute limit (60 s with no function at work). | `src/sandbox.ts:56`, `src/sandbox.ts:60`, `src/sandbox.ts:171`, `src/sandbox.ts:182` |
| Each function call gets a `call` row at its start (with its whole arguments as JSON) and its whole result at its end. | `src/sandbox.ts:146`, `src/sandbox.ts:160`, `src/store.ts:1138`, `src/store.ts:1156` |
| A defect in a function becomes its error text, and the program (so the model) reads it. | `src/sandbox.ts:151` |
| A failed sandbox is a diagnostic with its message. | `src/sandbox.ts:212` |
| A function that its program did not wait for, or whose program was stopped, is closed as `cut`. | `src/sandbox.ts:152` |
| The table `call`: statuses `running`, `done`, `failed`, `denied`, `cut`. `denied` is for a hook's refusal and is not built yet. Nothing marks a call that waits for a person. | `src/migrations.ts:133`, `src/migrations.ts:143` |
| The table `turn`: `running`, `done`, `stopped`, `failed`. A turn that waits has no status of its own. | `src/migrations.ts:106`, `src/migrations.ts:109` |
| Turn items are append only. A step's results go in as one `back` item, after all its programs end. | `src/migrations.ts:122`, `src/migrations.ts:130`, `src/turn.ts:305` |
| A restart closes each running function as `cut`, then each running program as `cut`, with the list of its functions. The program does not run again: the model reads the list and decides. Then the turn goes on from its items. | `src/turn.ts:468`, `src/turn.ts:471`, `src/turn.ts:474`, `src/turn.ts:482` |
| The shell removes `EVERCHAT_GATEWAY_*` from a command's environment. | `src/shell.ts:66` |
| The OpenAI wire keeps nothing on the vendor's side (`store: false`) and sends the encrypted reasoning back in each request. | `src/openai.ts:169`, `src/openai.ts:180` |

The `tool`, `echo` and `back` items (the memory, the model) hold a program's
source and rendered result (`src/turn.ts:260`, `src/turn.ts:294`). A
function's result goes to the engine and to `call` (`src/sandbox.ts:160`,
`src/sandbox.ts:161`); the model sees it only if the program prints or
returns it, by `result(id)` (`src/functions.ts:199`), or as a brief in a cut
program's list (`src/turn.ts:94`). `return (await read(p)).length` sends the
length, not the text. But all arguments and results stay in `call` for ever.

## Facts

### The library and the engine

| Fact | Source |
| --- | --- |
| `pi-codemode` 1.5.2 runs "a worker thread per execution", and says that a fresh worker for each run "keeps termination simple" and cannot "poison a later run". It has no pool. | https://github.com/earendil-works/pi/tree/main/packages/codemode (`dist/runtime/host.js`) |
| `CodemodeSandboxBase` is exported, with a launcher as a parameter: a host can give its own launcher (for example a pool). | same, `dist/index.js` |
| `acquireWorker()` is an admission hook: it runs before each worker starts, can refuse, and its release runs when the worker exits. `onWorkerStarted(exited)` tracks the worker's real life. | same, README "Usage on Node and Bun" |
| A stop requests `terminate()` and does not wait. On Bun, a built-in that does not poll the interrupt flag can keep the thread busy until it returns. | same |
| `start()` is a deterministic run: virtual time from `startedAt`, randomness from `seed`, UTC, no `WeakRef`, results applied strictly in the order of their result numbers. "The same script ... answered with the same results in the same order, makes the same calls" on a VM with the same fingerprint (engine versions, prelude hash, limits). It is made "to resume it from a durable log of its calls' results". | same, README "Deterministic runs"; `dist/runtime/vm.js` |
| `store()`/`load()` keep JSON between runs; the host keeps the values. | same, README "Store" |
| The library does not expose the VM, so it cannot take a snapshot. | `dist/runtime/*.js` has no call of `snapshot` (run: `grep -c snapshot`) |
| `quickjs-wasi` 3.6.2 can "snapshot the entire VM state (including pending promises) and restore it in a fresh WASM instance". Host functions must be registered again by name after a restore. | https://github.com/vercel-labs/quickjs-wasi |
| Bun's `Worker` has `smol: true` ("reduces memory usage at a cost of performance"); `terminate()` is "still experimental". | https://bun.com/docs/runtime/workers |
| `/proc/<pid>/environ` holds the environment at `execve`, and the check is `PTRACE_MODE_READ_FSCREDS`: a process of the same user can read it. | https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html |

### Measurements

No model. Bun 1.4.4, Linux 6.18, 30 cores, the checkout's `pi-codemode`
1.5.2 and `quickjs-wasi` 3.6.2, the sandbox's own options (512 MiB, no
deadline). Scripts: `/tmp/ec-a7k4/measure.ts`, `measure2.ts`, `measure3.ts`,
`snap.ts`, `env.ts`.

| What | Result |
| --- | --- |
| Start and end of one program that calls one function | 57 ms the first time, 32 ms after (median of 11) |
| RSS of one program that waits in a function (an open promise) | 5.95 MB with no data; 6.6 MB with a 1 MiB string |
| Of that: a bare Bun worker thread / one QuickJS engine | 3.3 MB (3.0 MB with `smol`) / 1.5 MB |
| OS threads for each worker | 1.9 (1.6 with `smol`) |
| Time until all are started and wait: 10 / 100 / 200 / 400 programs | 92 ms / 568 ms / 1.8 s / 5.7 s |
| CPU of the process while 100 programs wait 3 s | 400 ms in 3 s (cause not proved: the waits themselves or the garbage collector) |
| Memory after all ended | back to 0 live workers; RSS 210 MB from 65 MB (Bun does not give all back at once) |
| Stop of `while(true){}` | the result at once; the worker gone after 4 ms |
| Stop inside a long built-in (`indexOf` on 128 MiB) | the result at once; the worker gone after 164 ms |
| Snapshot of a QuickJS engine with an open promise | 1.31 MiB raw (+ the program's data: 9.3 MiB with 8 MiB), 2 to 13 ms; restore 2 to 13 ms; the restored promise resolved and the program went on |
| A shell command reads its parent's variable that the command's own environment does not have | yes: `/proc/$PPID/environ` had it (`yama/ptrace_scope` is 1 here) |

So `src/shell.ts:66` hides the key of the author's inference gateway from a
careless command, not from one that looks for it. Locally that changes
nothing (the same user can read `proxy.json`). With tenants, it matters.

### How other harnesses stop for a person

| Harness | How it waits | What it keeps over the wait | Source |
| --- | --- | --- | --- |
| OpenAI Agents SDK | `needsApproval` on a tool. The tool does not run; the run ends with `interruptions`. `state.approve()` / `reject()`, then `run(agent, state)` goes on. | The whole `RunState`, serialized (`toString()`, `RunState.fromString`), "without keeping your server running". | https://openai.github.io/openai-agents-js/guides/human-in-the-loop/ |
| LangGraph | `interrupt()` in a node, a checkpointer, `Command(resume=...)`. On resume the node "restarts ... from the beginning", so side effects before it must be idempotent. | The graph's checkpoint, by thread id. | https://docs.langchain.com/oss/python/langgraph/interrupts |
| Vercel AI SDK | `toolApproval` (`needsApproval` is deprecated): the call returns a `tool-approval-request` part, the app adds a `tool-approval-response`, and a second model call runs the tool or shows the denial. | The messages, in the app. | https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling |
| Cloudflare Agents SDK | Code Mode `requiresApproval`: the program stops before the call; after `approve()` "the code reruns under the same execution ID", earlier calls "replay from the durable log". Workflows: `waitForApproval()`, "months or longer without keeping an Agent running". | The durable log of calls; the workflow's state. | https://developers.cloudflare.com/agents/guides/human-in-the-loop/ |

### Durable execution

| System | The model | Source |
| --- | --- | --- |
| Temporal | The workflow code runs again against its event history; a command that does not match the history is a "non-deterministic error", also after a code change. | https://docs.temporal.io/workflow-definition |
| Restate | An awakeable: an id that an outside system resolves; the handler "suspends" and the wait survives restarts. | https://docs.restate.dev/develop/ts/awakeables |
| DBOS | `recv()` waits for a message; normally the workflow "stays in memory while it waits". `suspend: true` frees it for long waits, but "Suspending workflows is a DBOS Transact Enterprise feature": without it, each wait holds memory. After a crash the workflow resumes "from the last completed step", and it must be deterministic. Replay from the start with recorded outputs: not proved from the page. | https://docs.dbos.dev/typescript/tutorials/workflow-communication, https://docs.dbos.dev/typescript/tutorials/workflow-tutorial |
| Effect 4 (`effect/workflow`) | `Activity` (a result that the engine records and replays), `DurableDeferred` (a named wait point that outside code completes with a token), `layerMemory` (not durable) and `ClusterWorkflowEngine` (persisted messages). All `@stability unstable`. That it runs on our SQLite: not proved. | `node_modules/effect/src/workflow/DurableDeferred.ts`, `node_modules/effect/src/cluster/ClusterWorkflowEngine.ts` |

### The vendors after a long wait

| Fact | Source |
| --- | --- |
| Anthropic: the cache lives 5 minutes by default, refreshed by each hit; 1 hour as an option, its write at 2x the base input price (5 minutes: 1.25x). The prefix is `tools`, then `system`, then `messages`; a change of a tool definition "invalidates the entire cache". | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| OpenAI: new models keep a prefix at least 30 minutes by default (12 hours as an option, its write at 2.5x); a read keeps coverage to at least 30 minutes after it; older ones 5 to 10 minutes of no use, up to 1 hour (24 hours extended); never more than 24 hours. | https://developers.openai.com/api/docs/guides/prompt-caching |
| Both APIs are stateless for us: the request is built again from the kept turn items, and a function's result can come any time after its call. That OpenAI's encrypted reasoning items are still accepted after days: not proved. | `src/turn.ts:322` (the request from the items) |

## Options

### Secrets for one tenant chat

The operator's idea, a common set and a closure at load, fits the shape of
`Functions.layer` (`src/functions.ts:141`): the layer already closes over its
services. A tenant's layer would close over the tenant's credentials too.

| Option | What it gives | What it costs | What it rules out |
| --- | --- | --- | --- |
| S1. Closure at load: `Functions.layer({ cwd, credentials })`, the value as Effect's `Redacted`. The function puts it in its own request (a header). | The program never holds it. One code path. | It is in the process's memory for the chat's life; unload drops it (`docs/research/agents.md`). | A function that gives the secret, or a text that holds it, as a result. |
| S2. A handle: the closure holds a name, and the function asks a secret service each time (with a short cache). | Rotation without a reload; less time in memory. | A request to the secret service for each call or each expiry. | Nothing more than S1. |
| S3. The secret as an argument that the program passes. | No change to the layer. | It goes into the function's `call.input` and the inspector; a secret written in the program's text also goes into the `tool` message, so the memory and the model. | Not possible under the rule "never stored". |
| S4. The secret in the environment of the process or of a shell. | Easy for command-line tools. | Any shell command of the process reads it (measured). | Two tenants in one process or one OS user, when either has `shell`. |

Where a secret can leak with S1 or S2, and what stops it:

| Path | Today | What is needed |
| --- | --- | --- |
| A function's result (`call.output`; `back` and `echo` when the program prints or returns it) | The whole result is kept (`src/sandbox.ts:160`). | The function never returns a response body, header or error text that echoes the secret. A test with a fake secret that greps every table. |
| A defect's text | `String(defect)` goes to the model (`src/sandbox.ts:151`). | A defect of a tenant function is shown as a fixed text; the cause goes to a diagnostic with `Redacted`. |
| Diagnostics and spans | Messages go to the table `log`. | `Redacted` values only; no request URLs with a token in them. |
| The program | It sees only arguments and results. QuickJS has no host memory. | Nothing more. |
| A shell command | It can read the parent's environment, and files of the same user. | No secret in the environment; a tenant with `shell` gets its own OS user or process (`docs/research/runtime.md`). |

### Different declarations for each tenant

The rule "one system prompt for every kind of request" is about the requests
of one chat: its turns, compactions and subagents share one head
(`src/head.ts:43`). A tenant chat is its own chat with its own cache key
(`chat.uuid`). So a fixed list for each tenant keeps the rule inside each
chat. What it costs: at Anthropic, tools come first in the prefix, so two
tenants with other lists share no cached prefix at all, not even the system
prompt; a change of a tenant's list while its chat lives makes one full cache
write, and every turn after it has a new head row.

| Option | Gives | Costs |
| --- | --- | --- |
| D1. One list for all tenants; the code refuses what a tenant may not use (as AGENTS.md says for roles). | One head for the deployment. | The model sees functions that it cannot use, and tries them. |
| D2. A list for each tenant, fixed for the chat's life. | Each model sees only its own functions. | No cache shared between tenants; a change is a cache write. |
| D3. A list for each kind of tenant (a few profiles). | The middle. | The same as D2, for each profile. |

### Approval by a person

| Option | Where it waits | Rows needed | After the wait | What the person sees |
| --- | --- | --- | --- | --- |
| A. Inside the program | The function's promise stays open; the worker thread and the QuickJS engine stay (6 MB, about 2 threads, little CPU, measured). The compute limit does not run while a function works. | A call status for "waits for a person", and a table or column for the question and the answer. | The function goes on in the same program. | A question, in the terminal or the company's interface. |
| B. "Pending" at once | Nowhere: the function returns that the request waits for approval, with an id; the program and the turn end. | A table of approvals: call, tenant, arguments, state, who answered. | The answer comes as a new message (`note`), which starts a turn. The model must ask again, and may ask for something else. | A question; later, the chat goes on. |
| C. Two steps | The program asks with `propose(...)`; the turn ends. On a yes, EverChat itself runs the recorded call with the recorded arguments, and the result comes in as a message. | B's table, with the exact arguments that were approved. | No model step is needed for the act. The model reads the result in the next turn. | The exact action, then its result. |
| D. Replay | The program ends at the call; the turn waits (a new turn status). On a yes, the program runs again from its start with `start()`; each earlier call is answered from its row, in its order; the approved call runs for real; the program goes on. | Per program: `startedAt`, `seed` and the fingerprint. Per function: its result number, the clock `now` of its delivery, and its typed outcome (`{ ok: true, value }` or `{ ok: false, message }`, `deliver(seq, now, id, outcome)`). `call.output` is not enough: it is display text (`src/sandbox.ts:83`), so `{ok:true}` and the string `'{"ok":true}'`, or `undefined` and `""`, give the same row. A turn status "waiting". | The `back` item is written only when the program ends, so the turn items stay valid. | As A. |

What each option does with a crash, an unload, and the cache:

| Option | A crash or an unload during the wait | The request after a long wait |
| --- | --- | --- |
| A | Today's restart closes the program as `cut`: its state is lost, and the person's answer has no program to go to. A snapshot could save the engine (1.3 MiB and up, measured), but the library does not expose it, the host's half (open calls, output, the call map) must be saved too, a restore needs the same engine build, and the snapshot holds every function result of the program (tenant data, maybe a secret) in a file or row. | The same turn goes on, built from its items. A full write of the prefix if its cache entry expired since its last hit (see Limits: not always). |
| B | Nothing is lost: the state is the row. | A new turn. Blocks of the view and the log that still match a valid entry are cache reads (a read refreshes it); only the new or changed suffix (the answer, a changed part of the view) is written. A full write of the prefix only if no valid entry matches: it expired since its last hit (see Limits), or the prefix changed. |
| C | Nothing is lost. A crash while EverChat runs the approved call leaves it `cut`, as today. | As B: matching prefix blocks are reads, the result's message and later blocks are written; a full write only on a miss or an expiry. |
| D | Nothing is lost if the rows are in. An upgrade of EverChat during the wait changes the fingerprint: the replay cannot be trusted, so the program falls back to `cut` with its list (today's path). A function that runs again (not answered from its row) breaks the replay: each must be recorded. | As A. |

## What fits, what does not

- **Secrets: S1 first, with S2's handle when rotation is needed.** It is
  the shape that `Functions.layer` has now, and the program never holds the
  value. The work is to close the leak paths in the table above; the defect
  text (`src/sandbox.ts:151`) is the first. S3 and S4 do not fit.
- **The shell is the hard part, not code mode.** The sandbox has no way to
  read the host's memory. The `shell` function has: a command runs as the
  same OS user as EverChat, and reads `/proc/$PPID/environ` and the user's
  files. So in one process, tenants with `shell` are not isolated from each
  other's secrets. Either a tenant chat gets no `shell` (only functions that
  call services), or each tenant with `shell` gets its own OS user or
  machine. Which, is `docs/research/runtime.md`'s question.
- **Declarations: D1 first.** It keeps one head, and it follows AGENTS.md
  ("the code does"). Take D2 only if the model's trials of refused functions
  cost more than the lost cache share. Measure that on a probe, not here.
- **Approval: C first, then D.**
  - C keeps no program and no engine over the wait. So it works with
    unload, with a crash and with an upgrade.
  - The person approves the exact arguments, and the call that runs is the
    approved one, not a new program of the model. B lets the model ask
    again and differently.
  - It needs one table and one function, and the answer takes the path that
    a hook's text will take (`docs/schema.html`, section 9).
  - It costs the rest of the program: what came after the call does not
    run, and the model goes on in the next turn. For most approvals (send,
    pay, delete) the act is the last thing that the program does.
  - D is the better shape when approvals come in the middle of long
    programs. The library is built for it (`start()`), and Cloudflare's
    Code Mode does it. But it needs a journal of each delivery (order, original
    `now`, typed outcome: not `call.output`), the fingerprint, a fallback,
    and replayable functions. Take D when C cuts programs too often.
  - A fits only for waits of seconds (a person at the screen). With many
    idle chats it holds one worker for each wait, and a restart loses it.
    Snapshots do not change that enough: the library would need a fork.
- **Code mode with many chats.** A live program costs about 6 MB and 2
  threads; an idle chat with no program costs no worker at all (a worker
  exists only while a program runs). 1,000 programs at the same moment is
  about 6.6 GB, and they start slowly (400 took 5.7 s). So the limit is how
  many programs run at once, not how many chats exist. Use `acquireWorker()`
  as an admission limit for each process and each tenant, and lower the
  512 MiB limit for tenants: today a process with N programs may need
  N x 512 MiB.
- **A program that never ends is not bounded.** The compute limit stops
  while any function runs and restarts whole after each (`src/sandbox.ts:171`,
  `src/sandbox.ts:190`); no deadline (`src/sandbox.ts:182`). With
  `shell("sleep 600")` not awaited, a program spins 600 s, then 60 s; a wait
  for a person makes it endless. Admission caps how many, not how long. A
  bound needs a total time (it stops long right waits) or a CPU budget (not proved).
- **A pool of workers: not worth it.** A kept worker saves about 30 ms at a
  program's start, and nothing while the program lives. Each program gets a
  new QuickJS engine (its own WebAssembly memory), so a pool would not leak
  one tenant's program state to the next. But host code in a kept thread
  could keep a reference to the last tenant's data, and the library's own
  reason for a fresh worker (a runaway program cannot poison the next)
  would be lost.
- **QuickJS on the main thread (`InlineCodemodeSandbox`)**: 1.5 MB and 6 ms
  for each engine, but a program that computes stops every chat of the
  process. It does not fit a process with more than one chat.

## Limits

- A stop is a request. A long built-in can keep a worker thread busy after
  the program's result (164 ms measured; the worst case is not proved).
  The memory of that thread is not free until it exits.
- No program can wait for a person across a restart, an unload or an
  upgrade without option D's replay or a snapshot. A snapshot needs a fork
  of `pi-codemode` and stores the program's data.
- A replay (D) is valid only on the same engine build and prelude. A long
  wait across a release must fall back to a cut program.
- A secret in the memory or the environment of a process is not safe from
  a `shell` command of the same OS user. Code mode cannot fix this; only an
  OS boundary can.
- A long wait may cost a write of the prefix, counted from its last hit:
  Anthropic's 5 minutes is a default and OpenAI's 30 a minimum; a 1-hour or
  12-hour entry still takes an answer after 10 minutes or 1 hour (Facts).
- With a list of functions for each tenant (D2), tenants share no cached
  prefix at Anthropic, because tools come first.
- Whether OpenAI accepts kept encrypted reasoning items days later is not
  proved. A probe can show it.

## Questions for the operator

1. Do tenant chats get `shell`? Recommended: no, at first. Tenant functions
   call services through closures (S1). `shell` for a tenant comes with its
   own OS user or machine (`docs/research/runtime.md`).
2. Where do a tenant's credentials come from, and may they live in the
   process's memory while the chat is loaded? Recommended: yes, as
   `Redacted`, fetched at load and dropped at unload; from the same secret
   service as the database's credential (`docs/research/store.md`).
3. One list of functions for all tenants, or a list for each? Recommended:
   one list (D1); the code refuses what a tenant may not use.
4. Which way of approval? Recommended: C (propose, a person approves the
   exact call, EverChat runs it). D later, if programs are cut too often.
5. How long may an approval wait, and what happens at its end?
   Recommended: a limit for each function (for example 7 days); at its end
   the approval is refused, and the model is told so in a `note`.
6. Who may approve: the tenant's person only, or also an administrator? Is
   each answer kept, with who and when, for ever? Recommended: the person
   that the function names; every answer kept in the approval's row.
7. How many programs may run at the same moment, in one process and for one
   tenant? Recommended: an admission limit with `acquireWorker()`, for
   example 64 for each process and 4 for each tenant, and 64 MiB for each
   tenant's engine. Measure before the numbers are fixed.
8. A shorter compute limit for tenants? Recommended: 10 s (it alone bounds
   nothing), plus a CPU budget for each program once its measure is proved.

## Words

GLOSSARY.md has `agent` for a subagent or a computer task. So this document
says "tenant chat" for the operator's "agent for each person or tenant".

| Term | Meaning |
| --- | --- |
| tenant | One person, team or customer of a company deployment, with its own chat, functions and credentials. |
| tenant chat | The chat of one tenant. It is a chat as GLOSSARY.md says, one of many in a deployment. |
| credential | A secret that a function uses to reach a service for a tenant: a bearer token, a key, a password. |
| approval | A person's yes or no to one function call, with its exact arguments, before it acts. |
| propose | To ask for an approval: the program gives the call that it wants, and the turn ends (option C). |
| replay | To run a program again from its start, and answer each earlier function call from its kept result (option D). |
| fingerprint | What makes a replay valid: the engine's versions, the prelude's hash and the limits (`pi-codemode`). |
| snapshot | A copy of a QuickJS engine's whole WebAssembly memory, from which it can be restored and go on. |
| admission limit | The most programs that may run at the same moment, in a process or for a tenant. |
