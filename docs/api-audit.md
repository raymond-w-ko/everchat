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
