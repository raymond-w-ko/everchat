# Vendor API audit

We keep our own vendor wires (AGENTS.md, "Our own vendor wires"). Before the
rewrite, this file checks what the reference code (`src/anthropic.ts`,
`src/openai.ts`, `src/askai.ts`, `src/agent.ts`, `src/memory.ts`) assumes
about each vendor's API against the vendor's official documentation.

Checked on 2026-11-10. Each finding has a verdict:

- **CONFIRMED**: the docs say what the code assumes.
- **WRONG**: the docs say something else, and it costs us (money, errors, or
  lost work).
- **OUTDATED**: the code works, but the docs now give a better or newer way.
- **NOT DOCUMENTED**: the code relies on something the docs do not promise.

Terms:

- A **cache mark** (`cache_control`) tells the vendor to save the request's
  prefix up to that point, so a later request with the same prefix reads it
  at a lower price.
- The **lookback** is how far back the vendor searches, from a cache mark,
  for a prefix an earlier request saved.
- **Single flight** (`AskAI.wait`): when many calls share a prefix that is
  not cached yet, one call (the leader) goes first, and the others wait until
  its reply starts, so that they can read what it saved.

## Anthropic

Sources (all on platform.claude.com):

- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Errors](https://platform.claude.com/docs/en/api/errors)
- [Versions](https://platform.claude.com/docs/en/api/versioning)
- [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)

### How the reference code places cache marks

A chat turn's request has four cache marks, the most the API allows:

1. The system prompt (`anthropic.ts` `body`). Tools come before the system
   prompt, so this mark caches the tools and the system prompt together.
2. The view's last whole block (`memory.ts` `view`). The view is split into
   blocks of 4 lines (`BLOCK`), counted from `<chat>`. Each block is a
   separate text block in the first user message.
3. The turn's last block, the new user text (`server.ts`, `mark: true`).
4. The top-level `cache_control` (automatic caching). The API puts it on the
   last block of the whole request, so it moves forward as the agent loop
   adds tool calls and results.

### Findings to act on

**A1. A big turn makes the next turn miss the view cache.** MEDIUM (cost).
WRONG assumption about the lookback.

- Docs: "The system checks at most 20 positions for each breakpoint,
  counting the breakpoint itself as the first. If the system finds no
  matching entry in that window, checking stops (or resumes from the next
  explicit breakpoint, if any)." And: "If a growing conversation pushes your
  breakpoint 20 or more blocks past the last write, the lookback window
  misses it."
- Code: the view has one mark, on its last whole block. When the view grows
  by 20 or more blocks between two calls (80 or more new lines, for example
  a turn with 40 tool calls and their results), the next call's lookback
  does not reach the previous mark. The API then reads only the system
  prompt's entry and writes the whole view again (up to 128 KB).
- `AskAI.wait` does not model the limit either. It treats any earlier cached
  block as a hit (`keys.findLastIndex(live)`), and it refreshes that entry's
  time to live, although the API did not read it.
- Fix (needs a design): place marks so that each new mark is fewer than 20
  blocks after a block that an earlier request saved. AskAI knows which
  blocks are saved (its `CACHE` map), so it is the right place to choose.
  A slot is free for this: mark 3 is not needed, because the top-level mark
  lands on the same block in the loop's first step.

**A2. Single flight starts the cache's lifetime too late.** LOW.

- Docs: "The lifetime is measured from the start of the request that writes
  or reads the cache entry, not from the end of its response."
- Code: `AskAI.lead` sets `until` when the reply begins (`begun`), so it is
  late by the time to first token. A call near the end of the 5 minutes can
  think a prefix is cached when the API has dropped it. It then does not
  lead, and the calls that wait on it all pay a full write.
- Fix: take the time when the request is sent.

**A3. The cache key misses parts of the prefix.** LOW.

- Docs: changing the tool definitions invalidates the whole cache; turning
  web search on or off, or changing `speed`, invalidates the system and
  message caches; "the presence/absence of images anywhere in the prompt"
  invalidates the message cache.
- Code: `AskAI.keys` hashes the vendor, model, effort, speed, system prompt,
  and whether web search is on. It does not hash the tool list (from the MCP
  server, `Agent.server`), the web search `max_uses`, or whether the request
  has images. A turn with an image cannot read the view that a turn without
  images saved, but AskAI thinks it can.
- Today this costs little, because calls with the same system prompt also
  use the same tools. Fix: hash the tools array as sent, and whether the
  request has images.

**A4. The API version is old.** OUTDATED (harmless).

- Docs: the current version is `2026-10-21`. `2023-06-01` is still listed,
  with no end date. Version `2026-10-21` removes `temperature`, `top_p`, and
  `top_k`, rejects a `document` block in an assistant message, and rejects
  a `citations` array on a user text block.
- Code: sends `anthropic-version: 2023-06-01`. We send none of the removed
  fields. Assistant turns go back with their citations, which is allowed.
- Fix: the new wire sends `2026-10-21`.

**A5. Fast mode on Opus 5.5 needs no beta header, and never runs slow.**
OUTDATED (harmless).

- Docs: the `fast-mode-2026-02-01` header is needed only on Claude Opus 5
  and Opus 4.8. On a supported model, a fast request either runs fast or
  fails: "exceeding fast mode's rate limits or capacity (a `429` or `529`)"
  returns an error. Only Opus 4.6 ran at standard speed instead. Fast and
  standard requests do not share cached prefixes.
- Code: sends the beta header for every fast request. It notes "ran at slow
  speed" when `usage.speed` is not fast, which cannot happen on Opus 5.5.
  It retries a fast 429 after its `retry-after`, at fast speed.
- Fix: send the header only where the docs require it. Decide whether a
  fast 429 retries fast (the cache stays) or falls back to standard speed
  (sooner, but a cache miss).

**A6. "Silent for 5 minutes means dead" is a guess.** NOT DOCUMENTED.

- Docs: "Event streams might also include any number of `ping` events." The
  docs give no interval.
- Code: `wire.idle` is 300 s, and the comment says the API pings while the
  model thinks.
- Fix: keep a limit, but log the longest silence seen, and set the limit
  from data.

### Rules the rewrite must keep (CONFIRMED)

- **Append only within a turn.** Within one agent loop, the code only adds
  items (`Agent.loop`); it never rebuilds the first message. A new turn
  starts a new request list and replays no thinking blocks. This is the
  shape the API's history check accepts.
  - Docs: on Claude Opus 5.5, Sonnet 5.5, and Haiku 5.5, a thinking block
    records the prefix before it. If an earlier turn changes, the API
    rejects the request with a 400 ("The block is bound to a different
    conversation"). This is enforced for accounts created on or after
    2026-08-31, and any account can opt in to test it.
  - So: never refresh the view in the middle of a turn (for example, when a
    compaction finishes). Keep the view of a turn fixed until the turn ends.
  - Test: send `thinking.block_binding.prefix_mismatch_behavior: "error"`
    with the `thinking-binding-controls-2026-08-01` header, so that any
    edit fails at once. This needs a real API call.
- **Thinking blocks go back unchanged.** Docs: "pass back every `thinking`
  and `redacted_thinking` block from the assistant turn exactly as
  received, including blocks whose `thinking` field is empty." The code
  keeps them and their signatures; it drops only empty text blocks.
- **Four marks at most.** Docs: "You can define up to 4 cache breakpoints",
  and "the automatic cache breakpoint uses one of the 4 available breakpoint
  slots". With 4 explicit marks plus the top-level one, the API returns a
  400. The code uses exactly 4, so any new mark must replace one. Test it.
- **The system prompt's mark caches the tools too.** Docs: the prefix is
  "`tools`, `system`, and `messages` (in that order)".
- **Single flight waits for the reply to start.** Docs: "a cache entry only
  becomes available after the first response starts." The code frees the
  waiters at `message_start`.
- **A read refreshes the entry.** Docs: "The cache is refreshed for no
  additional cost each time the cached content is used." Default lifetime 5
  minutes (`TTL["claude-api"]`).
- **Minimum cacheable prefix** is 512 tokens on Opus 5.5, Sonnet 5.5, and
  Haiku 5.5. The system prompt alone is longer.
- **Usage in `message_delta` is cumulative.** Docs: "The token counts shown
  in the `usage` field of the `message_delta` event are *cumulative*." The
  code assigns the values; it does not add them.
- **Errors.** A mid-stream `error` event (such as `overloaded_error`) and
  HTTP 408, 409, 429, and 5xx (including 529) are retried, after
  `retry-after` when given. Note: a 429 for a monthly spend cap has no
  `retry-after` and "keeps failing until access resumes"; a spend limit
  that you set returns a 400.
- **Stop reasons.** `end_turn` and `tool_use` end a step; `pause_turn` sends
  the assistant message back unchanged; `max_tokens` and `refusal` fail the
  step before any tool runs. `stop_details` is set only on a refusal.
- **Web search.** `web_search_20260318` is a documented version (it adds
  `response_inclusion`). From `web_search_20260209` on, searches run inside
  code execution by default (dynamic filtering), so results can come back
  nested and encrypted; the code shows them as "(output encrypted by the
  API)". Each result's `encrypted_content` must go back unchanged, or the
  request fails with a 400. A search error comes back as HTTP 200 with an
  error object in the result.
- **Thinking and effort.** `thinking: {type: "adaptive", display:
  "summarized"}` and `output_config.effort` are right for the 5.5 models.
  Opus 5.5 and Haiku 5.5 default to `medium` effort; the code always sends
  the effort, so the default does not matter.

### Worth a look in the rewrite (not wrong today)

- **The 1-hour cache.** A person often answers after more than 5 minutes.
  Then the next turn writes the whole view again. A 1-hour lifetime on the
  view's mark costs 2× per write instead of 1.25×, and pays off when the gap
  is 5 to 60 minutes.
- **Cache diagnostics** (beta `cache-diagnosis-2026-04-07`): the API names
  where two requests' prefixes differ. Good for a test that the view's
  prefix stays stable from turn to turn.
- **Refusal fallbacks** (`fallbacks: "default"`): on a refusal, the API runs
  the same request on a fallback model. Today a refusal fails the step.

## OpenAI

A subagent read the docs, the `openai/openai-openapi` spec (commit
`f1510da`), and the `openai/codex` source (commit `9f04d88`). I re-checked
O1, O2, and the ChatGPT-plan limits against the docs myself. The rest come
from its report. No real API calls were made.

Sources (all on developers.openai.com unless named):

- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Create a response](https://developers.openai.com/api/reference/resources/responses/methods/create)
  and [streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [Reasoning](https://developers.openai.com/api/docs/guides/reasoning),
  [function calling](https://developers.openai.com/api/docs/guides/function-calling),
  [error codes](https://developers.openai.com/api/docs/guides/error-codes),
  [rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
- [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode),
  [ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode),
  [pricing](https://developers.openai.com/api/docs/pricing)
- [Web search](https://developers.openai.com/api/docs/guides/tools-web-search),
  [speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Sign in with ChatGPT: plan usage](https://developers.openai.com/siwc/token-sharing-open-source)
  and its [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)

### How OpenAI's cache differs from Anthropic's

OpenAI also has explicit cache marks (`prompt_cache_breakpoint` on an
`input_text` block), at most four cache writes per request, and a 30-minute
default lifetime that a read refreshes. But it finds earlier entries in a
different way:

- It looks only at the breakpoints that are in the new request: "The first 2
  and latest 50 explicit breakpoints." It does not search back from a mark
  as Anthropic does.
- In implicit mode (the default), it also checks its own breakpoint at the
  end of the latest message, "up to 20 earlier eligible message endings",
  and the end of the opening developer messages.
- In explicit-only mode (`prompt_cache_options: {mode: "explicit"}`), "it
  checks only its own explicit markers".
- The minimum cacheable prefix is 1,024 tokens.

### Findings to act on

**O1. The view's cache is lost each time its mark moves.** HIGH (cost).
WRONG assumption. Re-checked.

- Code: the view has one mark, on its last whole block (`memory.ts` `view`).
  The whole view is one user message. When the view gains a whole block (4
  new lines), the mark moves to the new block. The old mark's position is
  not a breakpoint in the new request, and it is inside one message, so
  implicit mode does not check it either. The request misses the view's
  cache and writes it again at 1.25×.
- Compactions send no mark on their last block, so they use explicit-only
  mode (`openai.ts` `body`). Then the end of the developer message (the
  system prompt) is not checked, and compactions do not share the system
  prompt's entry with turns.
- Fix: on OpenAI, mark every block end of the view (lookups use the latest
  50), and put a mark on the system prompt's `input_text`. Which marks get
  written (four at most) needs a test.

**O2. A stream that fails on a rate limit counts as the model's failure.**
HIGH (lost work). Re-checked.

- Code: on `response.failed`, only `error.code === "server_error"` is busy
  (`openai.ts` `step`). Every other code is `fail`: not retried, and a
  patient compaction gives up as if its input were bad.
- Docs: `rate_limit_exceeded` is one of the `response.failed` codes. Codex
  retries `rate_limit_exceeded`, `slow_down`, `server_is_overloaded`, and
  unknown codes.
- Fix: retry these codes, and fail only codes that are the input's fault.

**O3. Quota and billing 429s are retried.** MEDIUM.

- Code: every 429 is busy (`agent.ts`), so a call with no credit waits
  through 8 tries (about 4 minutes) and then ends "down".
- Docs: a 429 can also mean the quota or credit is gone, and "Don't retry
  quota, billing, or other errors that require you to take action."
- Fix: read the error code in the 429's body, and stop at once for quota and
  billing.

**O4. Leaving out `strict` does not mean "best effort".** MEDIUM.

- Docs: "If you omit `strict` … Responses requests will attempt to normalize
  your schema into strict mode".
- Code: sends function tools with no `strict` field. MCP schemas with
  optional fields may change in ways the docs do not describe.
- Fix: send `strict` explicitly (`false` keeps today's intent).

**O5. Web search billing and limits.** LOW.

- Docs: only `search` actions cost money, not `open_page` or
  `find_in_page`. `max_tool_calls` limits all built-in tool calls, not only
  searches.
- Code: bills every `web_search_call` item, and uses `max_tool_calls` as the
  search limit.

**O6. Prices and speeds are out of date.** LOW. (Free billing today, but the
factory may want cost per turn.)

- Cache-write prices: gpt-6.1-sol is $2.50 (code: 2), gpt-6-luna is $0.125
  (code: 0.1). Writes are 1.25× input.
- Prompts over 272K tokens cost "2x input and cache rates and 1.5x output
  for the full request". The code has no such rule.
- gpt-6.1-sol now has an "ultrafast" speed (`pick.ts` offers it only on
  gpt-6-astra).

**O7. A token count exists.** OUTDATED. `POST /v1/responses/input_tokens`
counts a request's input tokens. The code says OpenAI has none.

**O8. Transcription.** LOW (robustness).

- `usage` is optional in the reply, but the code reads `usage.seconds`
  without a check.
- The file name's extension comes from the MIME type, so `audio/x-m4a`
  becomes `.x-m4a`. The allowed formats are mp3, mp4, mpeg, mpga, m4a, wav,
  and webm.

**O9. When a cache entry becomes readable.** NOT DOCUMENTED.

- Single flight lets the waiters go when the leader's reply begins. The
  docs do not say when an entry becomes readable. The prewarm advice says:
  "Once it completes, send your actual request."
- Fix: measure it with real calls before the new single flight depends on
  it.

### CONFIRMED

- Endpoint `POST /v1/responses`, `store: false`, stateless replay of every
  output item (no `previous_response_id`). In stateless mode, reasoning
  items carry `encrypted_content` by default, so no `include` is needed.
- `reasoning: {effort, summary: "auto"}`. Efforts low to max on all three
  models. `context: "all_turns"` is documented for gpt-6.1-sol only (not
  documented for gpt-6-astra or gpt-6-luna; codex sends it anyway).
- The system prompt as a developer message's `input_text` is right: the
  top-level `instructions` "cannot contain an explicit breakpoint".
- `max_output_tokens` up to 128,000. `function_call_output` may hold text
  and images. Images as data URLs. Parallel tool calls are on by default.
- Stream events: `response.output_text.delta`, `response.output_item.added`,
  `response.function_call_arguments.delta`, the reasoning summary events,
  and the end at `completed`, `incomplete`, or `failed` (each carries the
  whole response; `usage` can be null on `failed`).
- Usage: `input_tokens` includes cache reads and writes; there is a
  `cache_write_tokens` field.
- Effort is part of the cache key (the docs say effort can change hidden
  instructions). Speed in the key is harmless.
- `service_tier`: `"default"`, `"fast"` (the reply shows `"priority"`, or
  `"default"` if it was downgraded), `"ultrafast"`. Price factors 2× and 6×.
- `retry-after`, then exponential backoff (the docs add jitter).
- Web search as `{type: "web_search"}`, citations from `url_citation`, $10
  per 1,000 searches. Transcription with `gpt-transcribe`, $0.0045 a minute.

### Using a ChatGPT plan ("Sign in with ChatGPT")

This is the route for "OpenAI first": a person signs in with ChatGPT, and
EverChat's requests use their plan.

- It is documented for "open-source and locally hosted apps". Paid or
  remotely hosted apps must fill in an interest form first.
- Requests go to the public API, `https://api.openai.com/v1`, with the
  user's bearer token.
- Each install needs a host ID, made once and kept ("Choose and persist the
  host ID before its first sign-in"), and not a user-identifying value.
  This goes in our database.
- Required: `store: false` and `stream: true`; `input` carries the whole
  context of each request.
- Must be left out, among others: `max_output_tokens`, `max_tool_calls`,
  `previous_response_id`, `prompt_cache_retention`, `metadata`, `user`,
  `temperature`. Our body sends the first two today.
- Function tools must be grouped in namespaces (or sent as
  `additional_tools` input items).
- Not available on this route: transcription, file upload, Code
  Interpreter, hosted MCP, `tool_search`. Web search depends on the model
  and the account's policy.
- Not stated: whether `prompt_cache_breakpoint` and `service_tier` work on
  this route. Test them before the design depends on them.
- Terms: "Do not impersonate OpenAI, another application or entity, or
  another open-source project", and use SIWC tokens "only through OpenAI's
  supported sign-in flow". So we must not reuse the Codex CLI's client ID or
  its `originator` header, as some harnesses do. We use SIWC.

## Measured through the inference gateway (2026-11-10)

These are results of real requests, sent with the new wire (`src/openai.ts`)
through the author's inference gateway by `tools/probe.ts`. The model was `gpt-6-luna` unless
another is named. About 90 requests were sent, each of 5,000 to 18,000 input
tokens with a reply of one word.

What the inference gateway needs:

- **A session id.** A request with no stable session id is refused with a
  400 before it reaches the vendor. The header
  `X-Session-ID` is accepted. The wire sends the chat's id.

What decides a cache hit:

- **The cache key.** The same request sent 5 times, 5 s apart:

  | Form of the request | Cached tokens of the 5 replies |
  | --- | --- |
  | explicit marks, no `prompt_cache_key` | 0, 0, 0, 0, 0 |
  | no marks, no key | 0, 0, 0, 0, 13440 |
  | explicit marks, with a key | 0, 13440, 13440, 13440, 13440 |
  | no marks, with a key | 0, 13440, 13440, 13440, 13440 |

  OpenAI's documents say that newer models do not need the key for routing.
  Through the author's inference gateway they do. The wire now sends the chat's id as the key.
- **Time.** With a key, requests 4 to 5 s apart read the entry of the one
  before each time. At about 3 s apart, the second of three did not. So an
  entry is readable some seconds after its request, not when the reply
  begins. This answers O9 in part, and it matters for single flight: to wait
  for the leader's first byte is not enough here.

How the cache behaves on this route:

- **It matches any common prefix, in steps of 128 tokens.** A request that
  adds one block reads the whole earlier request. One block that grows is
  read too: the documents' rule that the old end must be a marked block end
  does not hold here.
- **The head is read on its own.** A request with the same head and another
  view read 2,560 tokens, which is the head. So the worry in O1 that the
  system prompt's entry is never written does not apply on this route.
- **Writes are not reported.** `cache_write_tokens` was 0 in every reply.
- **The vendor's diagnosis is not there.** `prompt_cache_diagnostics` was
  absent in every reply, also with a `comparison_response_id`. So we count
  what each request should read ourselves (`src/cache.ts`, and the column
  `usage.expected`).
- **The usage has an `attribution` object**, which gives the cached tokens of
  each item and each content part. The wire does not read it yet. It would
  show exactly where a cache read ended.

What the vendor accepts:

- **A program sent back as received.** The `custom_tool_call` item comes with
  `status: "completed"`, and a request that sends it back whole, with its
  `custom_tool_call_output`, is accepted (`gpt-6-luna` and `gpt-6.1-sol`).
- **`reasoning.context: "all_turns"`** is accepted on both models, and the
  reply repeats it.

Not measured: a reasoning item sent back (the probes ran at low effort and
got none), the fast speed, and a rate of requests above a few a minute.


## Measured through OpenRouter (2026-11-10)

The same probes, sent to `openai/gpt-6-luna` through OpenRouter
(`PROBE=openrouter bun tools/probe.ts ...`), with the key from the file
`.env`. About 30 requests. OpenRouter passes the request to OpenAI's plain
API, so this is how the documented API behaves. **It behaves as the
documents say. The author's inference gateway's route does not.**

| | OpenRouter (the plain API) | The author's inference gateway |
| --- | --- | --- |
| The same request again, with no `prompt_cache_key` | read from the second request on | read almost never |
| Cache writes in the usage | reported (`cache_write_tokens`) | always 0 |
| Cached tokens | exact (13,629 of 13,639) | in steps of 128 (13,440) |
| One block that grows | not reused: only the head is read | reused |
| Explicit marks | decide where entries are written and read | no visible effect |
| A session id | not needed | needed (`X-Session-ID`) |
| `prompt_cache_diagnostics` | absent | absent |

So the route behind the author's inference gateway is not the plain API. It behaves like the
older automatic cache: any common prefix, in steps of 128 tokens, found only
with a cache key.

What the plain API showed about marks (this settles O1):

- **With a mark on every block, the head is never written.** A request with
  13 marks wrote its entries at its latest four. A later request with the
  same head and another view read 0 tokens and wrote all 13,356 again.
- **With at most four marks, the head is written.** A request with the system
  prompt's mark and two blocks, then one with another view: it read 2,706
  tokens, the head.
- **The rule that the wire now follows:** a mark on the system prompt, and on
  the last three blocks up to the one that the memory marked. Tested: a
  request that adds one block read the whole earlier prefix (13,631), and a
  request with another view read the head (2,700).
- **A block that grows is not reused.** Its old end is inside the block. Only
  the head was read (2,698 of 14,603). This is the documents' rule, and it
  is why each block of the view is its own content part.

The wire sends the marks and the cache key on both routes. The marks do the
work on the plain API, and the key does it on the author's inference gateway.

## A turn with thinking, on both routes (2026-11-10)

A probe ran one turn of three steps at high effort
(`PROBE_EFFORT=high bun tools/probe.ts reason <model>`): the model thinks and
runs a program, gets a result of about 2,700 tokens, thinks and runs a second
program, gets a second result, and answers. Each step sends back every item
that the model gave before, as received.

| Step | OpenRouter: input, read, written | Inference gateway: input, read |
| --- | --- | --- |
| 1 | 6,476 / 0 / 6,389 | 6,472 / 0 |
| 2 | 9,233 / 6,389 / 2,841 | 9,256 / 6,272 |
| 3 | 12,049 / 9,230 / 2,816 | 12,047 / 9,088 |

What it shows, on both routes:

- **The items are accepted as received**: the reasoning item with its
  encrypted content, the program, and the result.
- **The reasoning is kept.** The input of each step grows by what the model
  wrote in the step before, its reasoning tokens too. If something dropped
  the reasoning item, the input would not grow by them.
- **The turn's own items are a stable prefix.** Step 3 reads the cache
  through the result of step 1, which lies after the reasoning item and the
  program of step 1.

What it changed in the wire:

- **Inside a turn, marks must be on the results.** A first run had marks on
  the view only. Through OpenRouter the cached count then stayed at 6,386 for
  all three steps: nothing of the turn was cached. The wire now marks the
  last three places where the stable part can end, and such a place is a
  block of the view or the last result of a step. The table above is with
  this rule.
- **A result is always sent in its list form.** Its bytes then stay the same
  when its mark moves to a newer result.

OpenRouter changes the ids of some items (a program's id had 19 characters,
and 54 through the inference gateway). The wire sends back what it got, so this does
no harm.

## Many compactions at once (2026-11-10)

The first run of the whole real stack: the store, the memory, the real
compactor, the ask service with single flight, the cache watch, and the
wire, through the author's inference gateway
(`bun tools/probe.ts compact gpt-6-luna 32`, at low effort). A new chat got
150 short messages in one push, and then 32 long messages in one push.

The run was larger than planned: 313 requests and about 1.7 million input
tokens, in 270 s. The plan was about 63 requests. Two things made it larger:

- The 150 short messages needed compactions too. Each is its own line, and
  two of them still fit in one node, but four do not. So the first push
  started 37 merges of level 2 at once, and more above them.
- Many lines came back too long and were asked again. The 32 long messages
  took 105 requests, about 3 tries each. The text was random words and the
  effort was low, so real chats may do better. It still shows that the tries
  for a long line multiply the requests.

What the cache did:

| | Requests | Read something | Input tokens | From the cache |
| --- | --- | --- | --- | --- |
| All | 313 | 111 | 1,717,000 | 660,000 (38%) |
| Leaves | 105 | 43 | 844,000 | 338,000 |
| Merges | 208 | 68 | 873,000 | 322,000 |

- **Single flight as built is not enough on this route.** In the first wave
  one request went first, and about 36 waited the 5 s and then went
  together. All of them read 0 tokens, though the head that they shared had
  been sent 5 s before. Requests that came later, spread over time, read it
  (1,408 tokens each).
- So a burst of requests does not find an entry that single requests find.
  The entry may need more than 5 s after a burst, or requests that arrive
  together may be served by different machines. This run cannot tell which.
- **The cache watch did its job.** Every request has a usage row with what it
  read and what it should have read, and each miss was logged as it
  happened. The numbers above come from one query on the table `usage`.

Two things about the memory that the run showed. Both are as in the old
code:

- After a push of many messages at once, the first merges get a compactions'
  view that is almost empty. The view moves on only after the nodes of the
  push are stored, and the merges start before that. In normal use messages
  come one at a time, and this does not happen.
- Four merges gave no line, and their nodes are their sources, cut. The
  input was random words.

What to try next, with small probes: let the requests that waited go a few
at a time and not all together; or wait for the end of the first reply and
not for a fixed 5 s; or run fewer compactions at once on this route.

## Followers that go together (2026-11-10)

Two small runs through the author's inference gateway, to see if the misses
of the section above come from requests that go together
(`bun tools/probe.ts burst gpt-6-luna all <b>`). One request goes first, and
`b` more with the same prefix follow together, 5 s after the first was
sent. The probe now stops itself at a number of requests (`PROBE_LIMIT`).

| The shared prefix | The first reply took | Followers that read it |
| --- | --- | --- |
| A head and a view, 5,332 tokens | 1.2 s | 16 of 16 (5,120 tokens each) |
| The program's own head only, 1,396 tokens | 5.1 s | 7 of 8 (1,280 tokens each) |

So requests that go together do read the entry, also when the shared part
is only the head. In the second run the followers went right after the
first reply ended, and they read it.

What then explains the misses of the large run is not proven. The most
likely reason: a compaction can take longer than 5 s, and there the
followers went 5 s after the first request was sent, with its reply still
running. The cache watch now waits for both: 5 s after the first request was
sent, and the end of its reply. This is not yet tested against the real
stack.

Not tested: a way to let the followers go a few at a time, and fewer
compactions at once. The runs above give no reason for either yet.

## The real stack again, small (2026-11-10)

One run of the memory with the real compactor on a small chat, after the
change above (`PROBE_LIMIT=50 bun tools/probe.ts compact gpt-6-luna 8 24`:
24 short messages, then 8 long ones). About 40 requests were expected. The
probe stopped itself at 50, as it is built to. 40 requests had written
their usage rows by then.

| | Requests | Read from the cache |
| --- | --- | --- |
| The first try for a node | 18 | 0 |
| A later try for the same node (its line was too long) | 22 | 21 |

- **A later try reads the try before it.** It sends the same request with
  one note more, and it read 1,408 to 2,560 tokens each time.
- **The first try for a node read nothing**, also long after other nodes'
  requests with the same head had ended. What these requests share is the
  head and a few tokens more, about 1,300 tokens. In the run of the section
  above, followers with the same head did read 1,280 tokens, but those
  requests were equal almost to their end. A head of 2,560 tokens was read
  under another view in an earlier run. So on this route a shared part near
  the vendor's minimum is not read reliably. The reason is not known.
- **The wait for the end of the first reply worked**: the followers went
  after it, and each had the head as its expected read.

What this means:

- The head alone is about 1,300 tokens, so little is lost when it is not
  read. The gain of the cache is in a long shared view, and a long shared
  view was read by all 16 followers in the run above.
- This probe has almost no shared view, for a reason of its own: all its
  messages come in two pushes, and after a push of many messages the first
  merges get a view that is almost empty.
- The watch logs a miss for these requests. That is true to its rule, and
  it is noise: near the minimum its count is not exact, and the vendor does
  not read such a part reliably.

A flaw of the probe's own text: it is made of random words, which no model
can make shorter without loss. So lines came back too long, and nodes took
up to 5 tries. 12 nodes took 40 requests. A run with real text is needed
before the number of tries says anything about real use.

## One whole turn in code mode

One run of the whole program but the terminal (`PROBE_LIMIT=6 bun
tools/probe.ts turn gpt-6-luna`), through the author's inference gateway.
Two requests were expected, and two were sent. The run took 5 seconds.

The message asked for a file and a command. The tool's description was the
real one: the rules of a program, then the functions as TypeScript
declarations.

- **The model wrote a program that ran as it was.** It called `write` and
  `shell` with `await`, in one program, and returned both results in one
  object. It needed no second try.
- **The functions did their work**: the file was there, and the command's
  result was `17 hello.txt`, then `(exit 0 in 0.0 s)`.
- **The second request read the first from the cache**: 1,920 tokens.
- **A returned object is JSON, so a text in it has its newlines as `\n`.**
  The model read it with no trouble. A program that returns one text, or
  prints with `console.log()`, gives plain lines. If the JSON form costs
  tokens or errors in real use, the result's form is the place to change.

This is one run of an easy task. It shows that the parts fit. It says
nothing yet about long tasks, about errors that a model must recover from,
or about a program that a model writes badly.
