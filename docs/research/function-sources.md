# Where a chat's functions and its system prompt come from

Today a chat's seven functions and its system prompt are fixed in the
executable. The local chief of staff needs connectors (mail, calendar, chat)
and the person's own code; in the hosted use, a service outside gives a tenant
chat's functions, adds the tenant's secrets to each call, and EverChat checks
them. Both need a name in place of "EverChat" and a text to append. Where can
the list and the prompt come from? What must EverChat check or refuse? Where do
secrets live? What do a call and a change cost? It decides nothing, and builds
on `functions.md` (secrets, approval option C) and `code-mode.md`.

## Today

| Fact | Where |
| --- | --- |
| The seven functions (`shell`, `read`, `write`, `edit`, `zoom`, `date`, `result`) are a constant: a name, a TypeScript signature written by hand, and a description. | `src/functions.ts:44` |
| Each function decodes its arguments with its own Effect schema, and a wrong argument gives the signature back. | `src/functions.ts:106`, `src/functions.ts:122` |
| A function knows its caller only as turn, program and call. It does not know the chat or a tenant. | `src/functions.ts:94` |
| An unknown name fails with "No function". | `src/functions.ts:223` |
| The head has one tool, `run`. Its description renders the declarations with `pi-codemode`'s `renderDeclarations`, once, when the module loads. | `src/head.ts:28`, `src/head.ts:40` |
| The system prompt is `prompt.txt`, plus the person's rules under "# The user's instructions". | `src/head.ts:44` |
| `prompt.txt` says "EverChat" 16 times, from its first line. No field replaces it. | `src/prompt.txt:1` |
| No caller gives the rules yet: `Turns.layer()` and `Compactor.layer({ pick })` get no `rules`. The config file is "Not here yet". | `src/main.ts:147`, `src/main.ts:142`, `src/main.ts:74` |
| A turn makes its head when it starts, and keeps it as JSON in its row. A cut turn goes on after a restart with the head that it started with. | `src/turn.ts:385`, `src/turn.ts:356` |
| The compactor makes its head once, when its layer is built. | `src/compactor.ts:42` |
| Table `head` keeps each head once, by its SHA-256. `turn.head` points to it. | `src/migrations.ts:81`, `src/store.ts:1072`, `src/migrations.ts:111` |
| The head comes from the constant, but the sandbox's globals come from the `Functions` service's `names`. A layer with other names would not change the head. | `src/head.ts:40`, `src/sandbox.ts:187` |
| Each function call has a row (`call`: `fn`, `input`, `output`, a status that can be `denied`), written when it starts and when it ends. | `src/migrations.ts:133`, `src/sandbox.ts:146`, `src/sandbox.ts:160` |
| A function gives its whole result to the program. Only the program's result is capped. | `src/functions.ts:21`, `src/sandbox.ts:114` |
| A function has no time limit of its own (`shell` has one). The compute limit stops while a function works. | `src/sandbox.ts:58`, `src/sandbox.ts:191` |
| The cache watch puts the session, the pick and the whole head in the first part of each fingerprint: a request with another head shares nothing with this one. | `src/cache.ts:108`, `src/cache.ts:111` |
| The design plans skills as a directory of `SKILL.md` files in the home, with no table. | `docs/schema.html:684`, `docs/schema.html:726` |

## Facts

### The Model Context Protocol (MCP), version 2026-07-28

| Fact | Source |
| --- | --- |
| "The current protocol version is 2026-07-28." | https://modelcontextprotocol.io/specification/versioning |
| 2026-07-28 is stateless: it removes the `initialize` handshake and the `Mcp-Session-Id` header. "Every request now carries its protocol version and client capabilities in `_meta`." | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| A tool has `name`, `title`, `description`, `inputSchema` ("MUST be a valid JSON Schema object"), `outputSchema`, `annotations` and `_meta`. Names "SHOULD be between 1 and 128 characters", from A-Z, a-z, 0-9, `_`, `-` and `.`, unique in one server. | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| The list "MUST NOT vary per-connection" but "MAY vary by the authorization presented on the request". Lists come in pages with an opaque cursor. | same page; https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination |
| With an `outputSchema`, servers "MUST provide structured results that conform", and "Clients SHOULD validate structured results against this schema." An error of the tool is a result with `isError: true`. | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| Annotations (`readOnlyHint`, `destructiveHint` (default true), `idempotentHint`, `openWorldHint`) are hints: "clients MUST consider tool annotations to be untrusted unless they come from trusted servers." | same page; https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations |
| Clients SHOULD "Prompt for user confirmation on sensitive operations", "Validate tool results before passing to LLM" and "Implement timeouts for tool calls". | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| Streamable HTTP: one endpoint that takes `POST`; each reply is JSON or an SSE stream for that request; the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. On HTTP, "Closing the SSE response stream is the cancellation signal." | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http; https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation |
| Authorization is optional, on OAuth 2.1, with protected resource metadata (RFC 9728) and the `resource` parameter (RFC 8707). Stdio servers "SHOULD NOT follow this specification", and take credentials from the environment. "The MCP server MUST NOT pass through the token it received from the MCP client." | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization; https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations |
| `_meta` keys take a vendor prefix (reverse DNS); a second label `mcp` or `modelcontextprotocol` is reserved. `clientInfo` is self-reported: servers "SHOULD NOT rely on them for security decisions". | https://modelcontextprotocol.io/specification/2026-07-28/basic#_meta |
| A field for "on behalf of this chat or tenant": none found. Only the authorization says who calls. `not proved` that none exists. | same |
| TypeScript SDK: `@modelcontextprotocol/sdk` 1.32.2 speaks up to 2025-11-25; v2 (`@modelcontextprotocol/client` and `/server` 2.4.0) speaks 2026-07-28 and has `workerd`, browser and Node builds. Its stdio transport is a separate subpath that needs `cross-spawn`. | `npm view`, 2026-11-14; https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions |
| Cloudflare: "Agents SDK v0.20.0 uses @modelcontextprotocol/client"; a Worker's MCP client takes Streamable HTTP or SSE, with headers. No stdio. | https://developers.cloudflare.com/agents/api-reference/mcp-client-api/ |

A trial (Bun 1.4.4, `/tmp/ec-45zd/mcp/`, a server and a client on
127.0.0.1, one tool, requests counted in the client's `fetch`):

| Client | HTTP requests to the first `tools/call` result |
| --- | --- |
| SDK v1 1.32.2, stateless server | 4: `initialize`, `notifications/initialized`, `tools/list`, `tools/call` |
| SDK v2 2.4.0, `mode: 'auto'` | 3: `server/discover`, `tools/list`, `tools/call` |
| One hand-written `POST tools/call` with `_meta`, to the v2 server | 1: status 200. Without `_meta`: status 400, "missing the required per-request envelope key(s): _meta" |

### `pi` (the checkout `/home/rko/src/pi`)

| Fact | Where |
| --- | --- |
| `pi-mcp` is its own MCP client, with no SDK: stdio, Streamable HTTP, OAuth (`pi-mcp/oauth`). It refuses the old SSE transport. | pi:packages/mcp/README.md:3, pi:packages/mcp/src/config.ts:124 |
| It speaks 2025-11-25 and older, with `initialize`. | pi:packages/mcp/src/protocol/types.ts:4, pi:packages/mcp/src/client.ts:221 |
| Its main entry exports the stdio transport (`node:child_process`). Whether it loads on `workerd`: `not proved`. | pi:packages/mcp/src/index.ts:82, pi:packages/mcp/src/transports/stdio.ts:1 |
| It sends arguments as given, and checks a result only for a `content` array. | pi:packages/mcp/src/client.ts:378, pi:packages/mcp/src/client.ts:148 |
| Defaults: a 30 s timeout that progress resets; 20 KiB of output, the middle cut; names `mcp__<server>__<tool>`, at most 64 characters, with a hash on a clash. | pi:packages/mcp/src/client.ts:38, pi:packages/mcp/src/output-limit.ts:9, pi:packages/mcp/src/naming.ts:23 |
| The coding agent checks every tool's arguments with `pi-schema` (`coerce: true`). It does not check results against `outputSchema`. | pi:packages/agent/src/agent-loop.ts:736, pi:packages/ai/src/utils/validation.ts:15 |
| `pi-schema` checks JSON Schema "without `eval`": closures, "also under a strict Content Security Policy". | pi:packages/schema/README.md:3 |
| An extension "runs inside the Pi process with the same operating-system permissions". Extensions come from `.pi/extensions/`, the agent directory, or `-e`. | pi:packages/coding-agent/docs/extensions.md:7, pi:packages/coding-agent/src/core/extensions/loader.ts:861 |
| MCP servers come from `mcp.json` in the agent directory, and from `.pi/mcp.json` only in a trusted project. A project file may not set `auth`. On `tools/list_changed` the tools are read again. | pi:packages/coding-agent/src/extensions/mcp/config.ts:139, pi:packages/coding-agent/src/extensions/mcp/config.ts:125, pi:packages/coding-agent/src/extensions/mcp/runtime.ts:382 |
| Context files: in each directory the first of `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`; the global one first, then from `/` down to the cwd. | pi:packages/coding-agent/src/core/resource-loader.ts:213, pi:packages/coding-agent/src/core/resource-loader.ts:279 |
| `SYSTEM.md` replaces the prompt, `APPEND_SYSTEM.md` adds to it; also `--system-prompt` and `--append-system-prompt`. | pi:packages/coding-agent/src/core/resource-loader.ts:1245, pi:packages/coding-agent/src/cli/args.ts:121 |
| Skills: the prompt lists name, description and path, and says to read the file when the task matches. `disable-model-invocation: true` keeps a skill out of the list. | pi:packages/coding-agent/src/core/skills.ts:358, pi:packages/coding-agent/src/core/skills.ts:352 |
| `pi-codemode` renders JSON Schema as TypeScript; "values are not validated against it". Only a `tools` entry's input type has a cap: past 16,000 characters of rendered type it becomes `unknown`. A global's input type and every output type are rendered with no cap. | pi:packages/codemode/src/types.ts:11, pi:packages/codemode/src/declarations.ts:10, pi:packages/codemode/src/declarations.ts:83, pi:packages/codemode/src/declarations.ts:108 |

Trials of `pi-codemode` 1.5.2's `renderDeclarations` (`/tmp/ec-45zd/decl/`,
`/tmp/ec-ri7g/`): a description goes in verbatim as a doc comment, `*/`
escaped; `mail.search_messages` as a global is `search_messages` in `declare
const mail`; `a-b` and `a_b` both render as `a_b`, with no error. Definitions
that differ in `inputSchema` (`additionalProperties: false`) and `_meta`
(`approval: "always"`, `"never"`) render the same declaration. 900 string
fields are 26,922 characters of JSON and 17,893 of type: the input is `unknown`
as a `tools` entry, whole as a global (17,957 characters); the output, with no
`outputSchema`, is `unknown` in both.

### Other harnesses

| Fact | Source |
| --- | --- |
| Cloudflare's Code Mode turns an MCP server's schema "into a TypeScript API, complete with doc comments". The binding "holds the access tokens", so the code cannot leak keys. Its main entry "does not validate inputs against schemas"; "Unsupported schemas degrade to unknown". | https://blog.cloudflare.com/code-mode/; https://developers.cloudflare.com/agents/tools/codemode/api-reference/ |
| Anthropic's code execution with MCP: a file for each tool, read when needed; in its example "from 150,000 tokens to 2,000 tokens". | https://www.anthropic.com/engineering/code-execution-with-mcp |
| Claude Code: MCP servers in `.mcp.json` (project, needs approval) or `~/.claude.json`; `${VAR}` in `command`, `env`, `url`, `headers`; OAuth through `/mcp`; a warning past 10,000 tokens of output, and a limit of 25,000 by default. Tool search is on by default: "Only tool names and server instructions load at session start." | https://code.claude.com/docs/en/mcp |
| Claude Code: `MCP_TIMEOUT` (server start) is 30,000 ms by default; HTTP requests "time out after 60 seconds by default". | https://code.claude.com/docs/en/env-vars |
| Agent Skills: `SKILL.md` with `name` (at most 64 characters) and `description` (at most 1,024); only these load at the start, the body when the skill is used. | https://agentskills.io/specification |
| Claude Code: "the combined description and when_to_use text is truncated at 1,536 characters in the skill listing". Codex's first list of skills "uses at most 2% of the model's context window, or 8,000 characters when the context window is unknown"; `skills.max_context_tokens` sets another budget, up to 10,000 tokens. | https://code.claude.com/docs/en/skills; https://learn.chatgpt.com/docs/build-skills |
| Claude Code loads `CLAUDE.md` from the cwd and each directory above it, the root first; `@path` imports. `--system-prompt` replaces the prompt, `--append-system-prompt` adds to it. | https://code.claude.com/docs/en/memory; https://code.claude.com/docs/en/cli-reference |
| Codex: the global `AGENTS.md` in its home, then one file for each directory from the git root to the cwd, until 32 KiB (`project_doc_max_bytes`). | https://learn.chatgpt.com/docs/agent-configuration/agents-md |
| The factory needs: the seat page from an instructions file in the cwd, with no ancestor's file (R28); user-invoked `SKILL.md` skills with model invocation off (R29); stdio MCP servers in the config root (R31, "should"). | `~/src/everturn/docs/references/seat-runtime.md` (R28, R29, R31) |

MCP servers from their owners (all remote, on Streamable HTTP, with OAuth):

| Service | Server | Source |
| --- | --- | --- |
| GitHub | `https://api.githubcopilot.com/mcp/`; also a local stdio server | https://github.com/github/github-mcp-server |
| Slack | `https://mcp.slack.com/mcp`; no dynamic client registration; only Marketplace or internal apps | https://docs.slack.dev/ai/slack-mcp-server/ |
| Atlassian (Jira, Confluence) | `https://mcp.atlassian.com/v2/mcp`; OAuth 2.1 or an API token | https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/ |
| Linear | `https://mcp.linear.app/mcp`; OAuth 2.1 or a key | https://linear.app/docs/mcp |
| Gmail, Google Calendar, Google Chat | A server for each product; "Developer Preview"; an OAuth client of your own | https://developers.google.com/workspace/guides/configure-mcp-servers |
| Outlook mail and calendar, Teams | Work IQ MCP (Microsoft Entra ID, `/.well-known/oauth-protected-resource`); its address: `not proved`. Not OAuth alone: "An organization administrator must enable Work IQ"; the prerequisites are "A usage-based billing plan set up in Copilot Studio with an Azure subscription and resource group assigned", "The user assigned to the billing plan", and "A user with Global Administrator role for the one-time Work IQ setup". What a tenant has "can vary by tenant, region, rollout status, licensing, administrator approval, and organizational policy". The servers for each app are "a legacy experience retained for testing and backward compatibility". | https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview; https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq; https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions; https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview |

## Options

### The wire to an outside provider (hosted)

| Option | Gives | Costs the provider | Rules out |
| --- | --- | --- | --- |
| W1. MCP 2026-07-28 over Streamable HTTP. The tenant and the chat go in `_meta` under EverChat's prefix, or the provider issues a token for each tenant. | A standard: the provider can be any MCP server, or a gateway in front of many. Stateless: one `POST` for each call (trial). `tools/list` pages, `isError`, cancellation and annotations are defined. | An MCP server (the SDK's handler is "the entire mount" on Bun or Workers), and the `_meta` and header rules. | Nothing; older servers need the 2025-11-25 fallback (3 to 5 requests to a first call, trial). |
| W2. A small HTTP contract of EverChat's own: `GET list?tenant&chat` and `POST call`. | The fewest rules; fields of our own (approval, limits). | A small service, but one that only EverChat speaks. | Every MCP server as it is: each needs an adapter. |
| W3. Both: EverChat speaks MCP, and a provider may also be a list of plain MCP servers that the outside component names for each tenant. | W1, and connectors as they are. | Each connector's OAuth is then EverChat's work: it holds tokens. | EverChat keeping no tenant secret. |

### From a definition to a function of code mode

| Step | What EverChat does |
| --- | --- |
| 1. At a load | Read `tools/list` (all pages); sort it by name, so the same list gives the same bytes and the same head row. |
| 2. Refuse or limit | As the table below. A refusal is a diagnostic; the tool is left out; the chat still loads. |
| 3. Namespace | Each outside function as `provider.name`, so it cannot hide a built-in. `pi-codemode` makes `ns.member` a frozen namespace object (pi:packages/codemode/src/types.ts:18). |
| 4. Render | `renderDeclarations` from `inputSchema` and `outputSchema`; the description as a doc comment. |
| 5. At a call | Check the arguments with `pi-schema` against `inputSchema` (no coercion: the model sees the types); send `tools/call`; check `structuredContent` against `outputSchema`; cap the size; give `isError` to the program as a `FunctionError`. |

One list must make both the head and the sandbox's globals, so that the two
cannot differ as they can today (`src/head.ts:40`, `src/sandbox.ts:187`).

### What EverChat must refuse or limit

The figures are proposals from the sources above, not measured.

| Risk | Rule |
| --- | --- |
| A name hides a built-in, or two names give one identifier (`a-b`, `a_b`) | Namespace every outside function; refuse a name outside MCP's characters or over 128; refuse a clash after the identifier is made. |
| A long list | At most about 100 functions in a chat, and a budget for all declarations together (for example 32 KiB, as Codex's cap for context files). Past it: a search function, as Claude Code's tool search. |
| A long description or schema | Three sizes, each its own cap: the JSON schema as given, its rendered input and output types, and the whole declaration. Cap a description (for example 1,024 characters, as Agent Skills). EverChat must measure the rendered types of each outside function itself and refuse it past the cap (for example 16,000 characters, `pi-codemode`'s figure for `tools`): the globals that the namespaces use have no cap in `pi-codemode` (Facts). |
| A description that gives the model orders | No check can find this reliably. The prompt says that a declaration is data from the provider. The provider is the outside component of the deployment: it is trusted. A tenant's own text in it is not. |
| A large result | A cap for each function result (for example 20 KiB, as `pi-mcp`; 25,000 tokens, as Claude Code), with the whole text kept in the call row. Today a result has no cap. |
| A call that does not end | A timeout for each call (30 s in `pi-mcp`, 60 s in Claude Code's HTTP), and an abort that closes the stream when the program ends or stops. |
| A result that says it failed | `isError: true` becomes a `FunctionError`; a JSON-RPC error too. |

### Where secrets live

| Option | EverChat holds | Leak paths |
| --- | --- | --- |
| P1. The provider adds the tenant's secret (W1 or W2). | No tenant secret. One credential of the deployment, to reach the provider. | A provider that returns a secret in a result. `functions.md`'s rules for results still apply. |
| S1 or S2 of `functions.md` (a closure at load, or a handle) | Each tenant's credential while its chat is loaded. | As `functions.md` says. With P1 they apply only to the deployment's credential. |

### Approval by a person (option C)

| Option | Gives | Costs |
| --- | --- | --- |
| A1. MCP's annotations: `readOnlyHint: true` runs, the rest needs a yes. | No field of our own. | `destructiveHint` is true by default, so each tool with no annotations needs a yes. Hints are "untrusted unless they come from trusted servers": this one is trusted. |
| A2. A field of our own in the tool's `_meta` (for example `approval: "always" \| "never"`). | The provider decides exactly. | A field that only EverChat reads. |

Either way, a function that needs a yes is not called: the call is kept with
its exact arguments, the turn ends, and on a yes EverChat sends the
`tools/call` itself (option C).

### What a call and a change cost

| Event | Cost |
| --- | --- |
| A call | One more HTTP request to the provider (one `POST` with W1). The latency of a remote provider: `not proved` (only localhost was measured). |
| A provider slow or down at a call | The call fails at its timeout; the program can catch it. |
| A provider down at a load | The last head row cannot stand in for the list: a head holds only the system text and the `run` tool's description (`src/request.ts:49`, `src/head.ts:43`, table `head` at `src/migrations.ts:81`), and the rendering drops schemas, annotations and `_meta` (trial above), which the checks and approval need. A fallback needs a full manifest of the definitions, kept for each chat, written at each load that read the provider: a row the size of the list for each change, state outside the recipe, and rules of the provider that may have changed since. Without it: the load fails, or the chat loads with no outside functions and a diagnostic. |
| A change of the list at a load | A new head row, and a full cache write at the next request (accepted by the operator). An unchanged list gives the same row (`src/store.ts:1072`) and reads the cache. |

### Functions for the local use

| Option | Needs from EverChat | How the person adds or changes one |
| --- | --- | --- |
| L1. MCP servers: stdio (local programs) and HTTP with OAuth (the services above) | An MCP client; a `mcpServers` section in the config file; for OAuth a sign-in in a browser, with a loopback callback, and token storage in the home. For Microsoft: also the organization's Work IQ setup (Facts), outside EverChat. | Edit the config file; a new list at the next load. |
| L2. The person's own code: modules in a directory of the home that export functions with a schema | Load the modules at the start, in EverChat's process. "Within reason" then means: the code has every right of EverChat (its database, its secrets), as `pi` warns. | Add a file; a new list at the next load. |
| L2b. The same code, as a local stdio MCP server | Only L1. A process boundary, but the same OS user. | As L1. |
| L3. Command-line tools through `shell` | Nothing more. | Install the tool; the model learns it from a skill or the rules. |
| L4. Skills: `SKILL.md` files in the home | Name and description in the head; the body read through `read`, or put in a message by a typed `/skill` line (R29). | Add a directory; a new list at the next load. |

A skill is prompt text in files, not a function. A hosted chat has no file
functions, so its skills (if any) would need a function `skill(name)`.

### The system prompt

| Part | Local use | Hosted use |
| --- | --- | --- |
| The name in place of "EverChat" | The config file | A field of the chat, given by the outside component when it makes the chat |
| The text to append | A file in the cwd that the config names (R28: the cwd's file only, no ancestor's), or `AGENTS.md` | A field of the chat or of the tenant, or the provider's answer at a load |
| The base text | `prompt.txt`, in the executable | The same |

What "One system prompt for every kind of request" needs inside one chat:
turns, compactions and subagents get the head of the same load. Today the
compactor makes its own head (`src/compactor.ts:42`): a load must make one
head for all three. A turn keeps its head to its end, also across a restart
(`src/turn.ts:356`). What may change at a load: the name, the appended text,
the list. What never changes in one build: the base text and its order.

### An MCP client on each runtime

| Runtime | HTTP | stdio |
| --- | --- | --- |
| Bun | Yes (trial: SDK v1 and v2) | Yes, with a child process (`pi-mcp`, SDK) |
| Node | Yes (SDK v2 has a Node build) | Yes |
| `workerd` | Yes (SDK v2's `workerd` build; Cloudflare's Agents SDK) | No: no child process. `pi-mcp`'s main entry imports stdio: `not proved` on `workerd`. |

## What fits, what does not

- **Hosted: W1, MCP 2026-07-28 over Streamable HTTP, with P1.** The
  operator's idea fits MCP: since 2026-07-28 a call is one `POST`, with no
  session to keep across an unload; the provider can be any MCP server; and
  EverChat holds no tenant secret. The tenant and chat UUIDs go in `_meta`.
  The outside component pays for an MCP endpoint, which the SDK makes small.
  W2 saves little, and shuts out connectors as they are.
- **The client: the SDK v2 (`@modelcontextprotocol/client`), not `pi-mcp`,
  for now.** `pi-mcp` speaks 2025-11-25 and needs `initialize`; the SDK v2
  speaks 2026-07-28 and has a `workerd` build. Check `pi-mcp` again when it
  has 2026-07-28 (`AGENTS.md`, "Use other libraries where they fit").
- **Checks: `pi-schema` for arguments and results**, because `pi-codemode`
  checks nothing; `pi-schema` needs no `eval`, so `workerd` may run it (`not
  proved`). Namespaces for every outside function.
- **Approval: A2, with A1 when the field is missing.**
- **Local: L1 first (MCP servers), then L4 (skills), then L2b.** GitHub,
  Slack, Atlassian, Linear and Google (a preview) have remote MCP servers with
  OAuth; one client serves both uses. Outlook and Teams need Work IQ, which an
  organization must enable and pay for: a working Outlook sign-in is not
  enough, so L1 holds for Microsoft only where that setup is done. L2 runs with
  all of EverChat's rights; L2b is the safer form of the same code.
- **System prompt: two fields (name, appended text), one head for each load.**

Decisions of 2026-11-14 and 2026-11-15 that replace earlier recommendations:
`functions.md` recommends one list for all tenants (D1); a list that can change
at a load, from the provider, makes it a list for each chat. `functions.md`
recommends S1 for tenant credentials; with P1 EverChat holds none. It writes of
one chat for each tenant; a tenant has many chats.

First, in order: one list for the head and the globals; the name and the
appended text; a load that reads a provider (a local MCP server in a test);
the checks; approval.

## Limits

- No check can make a description from outside safe for the model. Only the
  provider's trust can.
- Code that the person loads into EverChat's process (L2) has all of
  EverChat's rights. Only a process or an OS boundary limits it, and the same
  OS user can still read the home.
- Stdio MCP servers cannot run on `workerd`.
- A change of the list or of the prompt costs a full cache write.
- OAuth for local connectors needs a browser sign-in and the owners' rules
  (Slack: Marketplace or internal apps only; Google: a preview). Microsoft's
  Work IQ also needs the organization's enablement, a billing plan and a
  Global Administrator: EverChat cannot do that setup for the person.
- MCP has no field for "this call is for tenant T, chat C". EverChat's
  `_meta` keys work only with a provider that reads them.

## Questions for the operator

1. The wire to the provider: MCP (W1) or EverChat's own contract (W2)?
   Recommended: W1, MCP 2026-07-28 over Streamable HTTP.
2. How does the provider know the tenant and the chat: `_meta` keys with one
   credential of the deployment, or a token for each tenant? Recommended:
   `_meta` keys and one credential.
3. When the provider is down at a load: fail, load with no outside functions,
   or keep a manifest for each chat? Recommended: no outside functions, with a
   diagnostic, and the next load reads the provider again; the head cannot
   serve as a fallback.
4. Who marks a function as needing a person's yes? Recommended: the
   provider, with a field (A2); with no field, MCP's annotations (A1).
5. The limits for outside functions (count, sizes, timeout)? Recommended:
   about 100 functions, 1,024 characters of description, 16,000 characters
   of rendered type for each function (measured by EverChat), 20 KiB of
   result, 30 s for each call, then measured.
6. The person's own code in the local use: in EverChat's process (L2), or as
   a local MCP server (L2b)? Recommended: L2b first.
7. Where does the local appended text come from: a file that the config
   names, or `AGENTS.md` in the cwd? Recommended: a file that the config
   names; `AGENTS.md` in the cwd for the factory (R28).
8. Do hosted chats get skills? Recommended: not at first.

## Words

| Term | Meaning |
| --- | --- |
| provider | A service outside EverChat that gives a chat's list of outside functions, and runs each call, with the tenant's secrets. |
| outside function | A function that a provider or an MCP server defines, and that EverChat calls over the network or a pipe. |
| connector | An MCP server for one service of the person (mail, calendar, chat), in the local use. |
| definition | An outside function as its provider gives it: name, description, `inputSchema`, `outputSchema`, annotations. |
| namespace | The object that holds a provider's outside functions in the sandbox (`provider.name`), apart from the built-in functions. |
| skill | A `SKILL.md` file with a name and a description: instructions that the model reads when it needs them. Not a function. |
| appended text | The text that a person or a tenant adds at the end of the system prompt. |
