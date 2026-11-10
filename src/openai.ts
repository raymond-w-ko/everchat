// OpenAI
// ======
// The wire for OpenAI's Responses API: it builds one request, sends it
// through the inference gateway with `stream: true`, and reads the server-sent events.
//
// It follows OpenAI's documents as read on 2026-11-10 (developers.openai.com:
// the Responses reference and its streaming events, and the guides on prompt
// caching, reasoning, preserved reasoning, function calling, conversation
// state, error codes, rate limits and fast mode). When a document and this
// file disagree, the document wins, and the fix comes with a test.
//
// The request
//
// - Nothing is kept on the vendor's side (`store: false`). Each request of a
//   turn sends the whole turn again.
// - The system prompt is a developer message, not `instructions`: only a
//   content block can carry a cache mark.
// - Cache marks are explicit (`prompt_cache_options.mode: "explicit"`), and
//   the mode never changes: a switch between modes misses the other mode's
//   entries. The vendor writes an entry only at the latest four marks of a
//   request, and reads only where the request has a mark. So the marks are:
//   the system prompt, and the last three places where the stable part of
//   the request can end. Such a place is a block of the view up to the one
//   that the memory marked, or the last result of a step of the turn. Then
//   every request writes the head (a request with another view, a
//   compaction for example, reads it), a request that adds a block reads
//   the entry of the one before, and each step of a turn reads the steps
//   before it. With a mark on every block, the head was never among the
//   four, and a new view read nothing. With marks on the view only, nothing
//   inside a turn was cached (docs/api-audit.md, "Measured through
//   OpenRouter").
// - The model's earlier output items go back exactly as received, in their
//   order, with every field. The wire keeps them as raw JSON.
// - A tool with no schema is a `custom` tool with free text input: code
//   mode's program. A tool with a schema is a `function` tool, `strict`.
// - `parallel_tool_calls` is false: one program a step. It is part of the
//   cached prefix, so it never changes.
//
// The reply
//
// - The output items come from `response.output_item.done`: an item in
//   `response.output_item.added` can be incomplete. The final event's list
//   fills any index that had no `done` event.
// - Unknown events and unknown fields are skipped: the vendor adds them at
//   any time.
// - A refusal is text in a message, not an error. `response.incomplete` ends
//   the reply with why it stopped.
//
// Not here yet: a limit on a silent stream (the documents give none), the
// count of the input's tokens, and web search.

import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { Gateway } from "./gateway.ts"
import { type Call, type Event, type Reply, type Request, type Stop, type Usage, type Wire, WireError, type WireErrorKind } from "./request.ts"

// How the wire reaches the network. A test replaces it.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export const Fetch = Context.Reference<Fetcher>("everchat/openai/Fetch", {
  defaultValue: () => (url, init) => globalThis.fetch(url, init)
})

// A pick's speed, and the vendor's service tier for it.
const TIER: Record<string, string> = { slow: "default", fast: "priority", ultrafast: "ultrafast" }

// The tier that ran, as a speed. A fast request can come back as `default`.
const SPEED: Record<string, string> = { default: "slow", priority: "fast", fast: "fast", ultrafast: "ultrafast" }

const MARK = { mode: "explicit" }

// The marks after the system prompt's. With it, they are the four that the
// vendor writes.
const MARKS = 3

const failure = (
  kind: WireErrorKind,
  message: string,
  retry: boolean,
  more: { began?: boolean; after?: number | null; status?: number | null; code?: string | null; request?: string | null } = {}
) =>
  new WireError({
    kind,
    message,
    retry,
    began: more.began ?? false,
    after: more.after ?? null,
    status: more.status ?? null,
    code: more.code ?? null,
    request: more.request ?? null
  })

// The request
// -----------

const picture = (one: { readonly type: string; readonly bytes: Uint8Array }) => ({
  type: "input_image",
  image_url: "data:" + one.type + ";base64," + Buffer.from(one.bytes).toString("base64"),
  detail: "auto"
})

const CallItem = Schema.Struct({
  type: Schema.Literals(["custom_tool_call", "function_call"]),
  call_id: Schema.String
})
const isCallItem = Schema.is(CallItem)

// The body of the HTTP request, as a value. Its JSON is what is sent.
export const body = (request: Request): Effect.Effect<Record<string, unknown>, WireError> =>
  Effect.gen(function*() {
    const tier = TIER[request.pick.speed]
    if (tier === undefined) {
      return yield* failure("input", `OpenAI has no speed "${request.pick.speed}"`, false)
    }
    const input: Array<unknown> = [{
      role: "developer",
      content: [{ type: "input_text", text: request.head.system, prompt_cache_breakpoint: MARK }]
    }]
    // Where a cache entry may end: each block of a user item up to the one
    // that the memory marked, and the last result of each `back` item. The
    // last MARKS of these get a mark.
    const places: Array<string> = []
    request.items.forEach((item, n) => {
      if (item.kind === "user") {
        const last = item.blocks.findLastIndex((block) => block.mark)
        for (let k = 0; k <= last; k++) places.push(n + ":" + k)
      } else if (item.kind === "back" && item.results.length > 0) {
        places.push(n + ":" + (item.results.length - 1))
      }
    })
    const marked = new Set(places.slice(-MARKS))
    const mark = (n: number, k: number) => (marked.has(n + ":" + k) ? { prompt_cache_breakpoint: MARK } : {})
    // The form of each call of the turn, by its id: its result must have the same form.
    const forms = new Map<string, string>()
    for (const [n, item] of request.items.entries()) {
      if (item.kind === "user") {
        input.push({
          role: "user",
          content: [
            ...item.blocks.map((block, k) => ({ type: "input_text", text: block.text, ...mark(n, k) })),
            ...(item.pictures ?? []).map(picture)
          ]
        })
      } else if (item.kind === "turn") {
        for (const one of item.output) {
          input.push(one)
          if (isCallItem(one)) {
            forms.set(one.call_id, one.type)
          }
        }
      } else {
        for (const [k, result] of item.results.entries()) {
          const form = forms.get(result.id)
          if (form === undefined) {
            return yield* failure("input", `a result names the call ${result.id}, which is not in the turn`, false)
          }
          // Always the list form, with or without a mark: the bytes of a
          // result must not change when its mark moves on.
          input.push({
            type: form + "_output",
            call_id: result.id,
            output: [{ type: "input_text", text: result.output, ...mark(n, k) }, ...(result.pictures ?? []).map(picture)]
          })
        }
      }
    }
    return {
      model: request.pick.model,
      stream: true,
      store: false,
      stream_options: { include_obfuscation: false },
      input,
      tools: request.head.tools.map((tool) =>
        tool.schema === undefined
          ? { type: "custom", name: tool.name, description: tool.description }
          : { type: "function", name: tool.name, description: tool.description, parameters: tool.schema, strict: true }
      ),
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: request.pick.effort, summary: "auto", context: "all_turns" },
      include: ["reasoning.encrypted_content"],
      service_tier: tier,
      // The same key for every request of a chat. OpenAI's documents say
      // that newer models do not need it. Real requests through the author's inference gateway
      // say otherwise: the same request sent 5 times, 5 s apart, read
      // nothing from the cache with no key, and read it from the second
      // request on with a key (tools/probe.ts, 2026-11-10, gpt-6-luna).
      prompt_cache_key: request.session,
      prompt_cache_options: {
        mode: "explicit",
        ...(request.baseline === undefined || request.baseline === null ? {} : { comparison_response_id: request.baseline })
      },
      ...(request.max === undefined ? {} : { max_output_tokens: request.max })
    }
  })

// The reply
// ---------

// What the wire reads of an event. Every field but `type` is optional, and
// unknown fields are skipped.
const StreamEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optional(Schema.String),
  output_index: Schema.optional(Schema.Number),
  summary_index: Schema.optional(Schema.Number),
  item: Schema.optional(Schema.Unknown),
  response: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String))
})

const VendorError = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String))
})

const VendorUsage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  input_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({
    cached_tokens: Schema.optional(Schema.Number),
    cache_write_tokens: Schema.optional(Schema.Number)
  })))
})

const Response_ = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  usage: Schema.optional(Schema.NullOr(VendorUsage)),
  service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(VendorError)),
  incomplete_details: Schema.optional(Schema.NullOr(Schema.Struct({ reason: Schema.optional(Schema.NullOr(Schema.String)) }))),
  prompt_cache_diagnostics: Schema.optional(Schema.NullOr(Schema.Struct({
    type: Schema.String,
    reason: Schema.optional(Schema.NullOr(Schema.String)),
    cache_missed_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    comparison_reusable_tokens: Schema.optional(Schema.NullOr(Schema.Number))
  }))),
  tool_usage: Schema.optional(Schema.NullOr(Schema.Struct({
    web_search: Schema.optional(Schema.NullOr(Schema.Struct({ num_requests: Schema.optional(Schema.Number) })))
  })))
})

// What the wire reads of an output item, to give the text and the calls.
const OutputItem = Schema.Struct({
  type: Schema.String,
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    refusal: Schema.optional(Schema.String)
  })))
})

const HttpError = Schema.fromJsonString(Schema.Struct({ error: VendorError }))

const decodeEvent = Schema.decodeUnknownSync(StreamEvent)
const decodeResponse = Schema.decodeUnknownSync(Response_)
const decodeItem = Schema.decodeUnknownOption(OutputItem)
const decodeHttpError = Schema.decodeUnknownOption(HttpError)

// An error code of the vendor, as a kind and whether another try can help.
// A code that the wire does not know is `busy`: only the input's own fault
// ends the tries (docs/api-audit.md, O2).
const QUOTA = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded"
])

const classify = (code: string | null): readonly [WireErrorKind, boolean] => {
  if (code === null) return ["busy", true]
  if (QUOTA.has(code)) return ["limit", false]
  if (code.includes("policy")) return ["policy", false]
  if (code === "invalid_prompt" || code === "data_residency_mismatch" || code.includes("image") || code.includes("invalid_request") || code.includes("context_length")) {
    return ["input", false]
  }
  return ["busy", true]
}

// An HTTP status that is not 2xx: the stream did not start.
const refused = async (response: Response, request: string | null): Promise<WireError> => {
  const text = await response.text().catch(() => "")
  const error = decodeHttpError(text)
  const code = error._tag === "Some" ? error.value.error.code ?? error.value.error.type ?? null : null
  const said = error._tag === "Some" ? error.value.error.message ?? "" : text.slice(0, 500)
  const seconds = Number(response.headers.get("retry-after"))
  const more = { status: response.status, code, request, after: Number.isFinite(seconds) && seconds > 0 ? seconds : null }
  const message = `OpenAI answered ${response.status}${said === "" ? "" : ": " + said}`
  const status = response.status
  if (status === 429) {
    // A 429 is not always "busy": a used-up quota needs a person (O3).
    return QUOTA.has(code ?? "") ? failure("limit", message, false, more) : failure("busy", message, true, more)
  }
  if (status === 401) return failure("auth", message, false, more)
  if (status === 403) return failure("policy", message, false, more)
  if (status === 408 || status === 409 || status >= 500) return failure("busy", message, true, more)
  return failure("input", message, false, more)
}

// The events of one reply, from the bytes of the stream.
async function* read(stream: ReadableStream<Uint8Array>, asked: Request, request: string | null): AsyncGenerator<Event> {
  const done = new Map<number, unknown>() // the output items that are complete, by index
  let began = false
  const fail = (kind: WireErrorKind, message: string, retry: boolean, code: string | null = null) =>
    failure(kind, message, retry, { began, code, request })

  const reply = (raw: unknown, stopped: boolean): Reply => {
    const response = decodeResponse(raw)
    const listed = response.output ?? []
    const count = Math.max(listed.length, ...[...done.keys()].map((k) => k + 1))
    const output = Array.from({ length: count }, (_, k) => done.get(k) ?? listed[k]).filter((item) => item !== undefined)
    const calls: Array<Call> = []
    let text = ""
    for (const raw of output) {
      const item = decodeItem(raw)
      if (item._tag === "None") continue
      const { arguments: json, call_id, content, input, name, type } = item.value
      if (type === "message") {
        text += (content ?? []).map((part) => part.text ?? part.refusal ?? "").join("")
      } else if ((type === "custom_tool_call" || type === "function_call") && call_id !== undefined && name !== undefined) {
        calls.push({ id: call_id, name, input: (type === "custom_tool_call" ? input : json) ?? "" })
      }
    }
    let stop: Stop = "done"
    if (stopped) {
      const reason = response.incomplete_details?.reason ?? null
      if (reason !== "max_output_tokens" && reason !== "content_filter") {
        throw fail("cut", `OpenAI stopped the reply: ${reason ?? "it gave no reason"}`, true, reason)
      }
      stop = reason === "max_output_tokens" ? "max" : "filter"
    }
    const used = response.usage ?? null
    const read = used?.input_tokens_details?.cached_tokens ?? 0
    const write = used?.input_tokens_details?.cache_write_tokens ?? 0
    const usage: Usage | null = used === null ? null : {
      input: used.input_tokens - read - write,
      cacheRead: read,
      cacheWrite: write,
      output: used.output_tokens,
      searches: response.tool_usage?.web_search?.num_requests ?? 0
    }
    const speed = SPEED[response.service_tier ?? ""] ?? asked.pick.speed
    const told = response.prompt_cache_diagnostics ?? null
    const diagnosis = told === null ? null : {
      type: told.type,
      reason: told.reason ?? null,
      missed: told.cache_missed_tokens ?? null,
      reusable: told.comparison_reusable_tokens ?? null
    }
    return { output, text, calls, stop, usage, diagnosis, pick: { ...asked.pick, speed }, id: response.id ?? null, request }
  }

  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let at = buffer.search(/\r?\n\r?\n/); at >= 0; at = buffer.search(/\r?\n\r?\n/)) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "")
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")
        if (data === "") continue
        let event: typeof StreamEvent.Type
        try {
          event = decodeEvent(JSON.parse(data))
        } catch {
          throw fail("protocol", "an event of the stream is not what the wire can read", true)
        }
        switch (event.type) {
          case "response.output_text.delta":
          case "response.refusal.delta":
            began = true
            if (event.delta !== undefined) yield { type: "text", delta: event.delta }
            break
          case "response.reasoning_summary_text.delta":
            began = true
            if (event.delta !== undefined) yield { type: "thought", delta: event.delta }
            break
          case "response.reasoning_summary_part.added":
            // A new part of the summary is a new paragraph of the thought.
            if ((event.summary_index ?? 0) > 0) yield { type: "thought", delta: "\n\n" }
            break
          case "response.custom_tool_call_input.delta":
          case "response.function_call_arguments.delta":
            began = true
            if (event.delta !== undefined) yield { type: "program", delta: event.delta }
            break
          case "response.output_item.added":
            began = true
            break
          case "response.output_item.done":
            began = true
            if (event.output_index !== undefined && event.item !== undefined) done.set(event.output_index, event.item)
            break
          case "response.completed":
          case "response.incomplete":
            yield { type: "end", reply: reply(event.response, event.type === "response.incomplete") }
            return
          case "response.failed": {
            const error = decodeResponse(event.response).error ?? null
            const [kind, retry] = classify(error?.code ?? null)
            throw fail(kind, `OpenAI failed the request: ${error?.message ?? "it gave no reason"}`, retry, error?.code ?? null)
          }
          case "error": {
            const [kind, retry] = classify(event.code ?? null)
            throw fail(kind, `OpenAI sent an error: ${event.message ?? "it gave no reason"}`, retry, event.code ?? null)
          }
        }
      }
    }
  } catch (cause) {
    if (cause instanceof WireError) throw cause
    throw fail("cut", `the stream broke: ${cause instanceof Error ? cause.message : String(cause)}`, true)
  }
  throw fail("cut", "the stream ended before the reply did", true)
}

// The service
// -----------

export class OpenAI extends Context.Service<OpenAI, Wire>()("everchat/openai/OpenAI") {
  static readonly layer = Layer.effect(
    OpenAI,
    Effect.gen(function*() {
      const gateway = yield* Gateway
      const fetch = yield* Fetch

      const send = (request: Request): Stream.Stream<Event, WireError> =>
        Stream.unwrap(Effect.gen(function*() {
          const json = yield* body(request)
          // An interrupt of the reader ends the HTTP request.
          const abort = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort())
          )
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(gateway.address + "/v1/responses", {
                method: "POST",
                headers: {
                  authorization: "Bearer " + Redacted.value(gateway.key),
                  "content-type": "application/json",
                  // The author's inference gateway's rule, not OpenAI's: see `Request.session`.
                  "x-session-id": request.session
                },
                body: JSON.stringify(json),
                signal: abort.signal
              }),
            catch: (cause) => failure("busy", `the request did not reach the inference gateway: ${cause instanceof Error ? cause.message : String(cause)}`, true)
          })
          const id = response.headers.get("x-request-id")
          if (!response.ok) {
            return yield* Effect.flatMap(Effect.promise(() => refused(response, id)), Effect.fail)
          }
          if (response.body === null) {
            return yield* failure("protocol", "OpenAI answered with no stream", true, { request: id, status: response.status })
          }
          return Stream.fromAsyncIterable(read(response.body, request, id), (cause) =>
            cause instanceof WireError ? cause : failure("cut", `the stream broke: ${String(cause)}`, true, { request: id }))
        }))

      return OpenAI.of({ send })
    })
  )
}
