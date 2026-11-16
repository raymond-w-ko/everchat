`packages/openai/` (`@everchat/openai`): the wire for OpenAI.
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/openai/` (`@everchat/openai`): the wire for OpenAI. Its
  entries: `.` (`packages/openai/src/openai.ts`, the wire), and one for
  the tag of the address and the key that each request goes to, its
  error, and the one form of the address (see the root `AGENTS.md`,
  "Model access through the author's inference gateway"). Where the
  address and the key come from is `local`'s.

## Our own vendor wires

We write and keep our own code for each model vendor's API (a "wire": it
builds the request and reads the streamed reply). We do not use a general
library for this, such as `pi-ai` or Effect's `effect/ai`.

The reason: the memory depends on exact control of each request. It decides
where the cache marks go, it counts the bytes, and it needs every field that
the vendor gives back. A general library hides or changes some of these. We
support only two vendors (OpenAI and Anthropic), so the cost of our own wires
is small.

Base each wire on the vendor's official documentation, not on memory or on
another library's code. When the documentation and our code disagree, the
documentation wins, and the fix comes with a test.

## OpenAI first, then Anthropic

We support both vendors. We do OpenAI first, because a person can use an
OpenAI subscription from a third-party harness such as EverChat.
