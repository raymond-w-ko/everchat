// Tests of the OpenAI wire, against a fake vendor. No test sends a request
// to a real model. The event shapes are those of OpenAI's documents.

import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Stream } from "effect"
import { Gateway } from "./gateway.ts"
import { body, Fetch, type Fetcher, OpenAI } from "./openai.ts"
import { type Event, type Head, type Reply, type Request, WireError } from "./request.ts"

const KEY = "sk-secret-key-0123456789"
const gateway = Layer.succeed(Gateway, Gateway.of({ address: "http://gateway.test:4000", key: Redacted.make(KEY) }))

const head: Head = {
  system: "You are EverChat.",
  tools: [{ name: "run", description: "Runs a JavaScript program." }]
}

const request = (over: Partial<Request> = {}): Request => ({
  session: "chat-uuid-1",
  pick: { vendor: "openai", model: "gpt-6.1-sol", effort: "medium", speed: "slow" },
  head,
  items: [{
    kind: "user",
    blocks: [
      { text: "<chat>\n", mark: false },
      { text: "0+1|a\n1+1|b\n2+1|c\n3+1|d\n", mark: true },
      { text: "4+1|e\n</chat>\n", mark: false },
      { text: "user: hello", mark: false }
    ]
  }],
  ...over
})

// A streamed reply: each event as the documents frame it.
const sse = (events: ReadonlyArray<Record<string, unknown>>, options: { chunk?: number; headers?: Record<string, string>; cut?: boolean } = {}) => {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  const bytes = new TextEncoder().encode(text)
  const size = options.chunk ?? bytes.length
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size))
      if (options.cut) controller.error(new Error("socket closed"))
      else controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_abc", ...options.headers } })
}

// A fake vendor: it records what it was sent and answers with `answer`.
const vendor = (answer: () => Response | Promise<Response>) => {
  const sent: Array<{ url: string; headers: Record<string, string>; body: any }> = []
  const fetcher: Fetcher = async (url, init) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
    return answer()
  }
  return { sent, fetcher }
}

const send = (asked: Request, fetcher: Fetcher) =>
  Effect.runPromise(
    OpenAI.use((wire) => Stream.runCollect(wire.send(asked))).pipe(
      Effect.provide(OpenAI.layer.pipe(Layer.provide(gateway))),
      Effect.provideService(Fetch, fetcher)
    )
  )

const fails = (asked: Request, fetcher: Fetcher) =>
  Effect.runPromise(
    Effect.flip(OpenAI.use((wire) => Stream.runCollect(wire.send(asked)))).pipe(
      Effect.provide(OpenAI.layer.pipe(Layer.provide(gateway))),
      Effect.provideService(Fetch, fetcher)
    )
  )

const end = (events: ReadonlyArray<Event>): Reply => {
  const last = events[events.length - 1]
  if (last?.type !== "end") throw new Error("the stream gave no end")
  return last.reply
}

// The output items of a small reply: a thought, a text, and a program.
const reasoning = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Think." }], encrypted_content: "ENCRYPTED-WHOLE", status: "completed" }
const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Hello there", annotations: [], logprobs: [] }] }
const program = { id: "ctc_1", type: "custom_tool_call", call_id: "call_1", name: "run", input: "return 1 + 1" }
const usage = {
  input_tokens: 12000,
  input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 },
  output_tokens: 1186,
  output_tokens_details: { reasoning_tokens: 1024 },
  total_tokens: 13186
}
const completed = (over: Record<string, unknown> = {}) => ({
  type: "response.completed",
  sequence_number: 99,
  response: { id: "resp_1", status: "completed", output: [reasoning, message, program], usage, service_tier: "default", ...over }
})
const small = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [], usage: null }, sequence_number: 0 },
  { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: "ENCRYP", status: "in_progress" } },
  { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Thi" },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "nk." },
  { type: "response.output_item.done", output_index: 0, item: reasoning },
  { type: "response.output_item.added", output_index: 1, item: { ...message, content: [], status: "in_progress" } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hello ", logprobs: [], obfuscation: "xK2" },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "there", logprobs: [] },
  { type: "response.output_item.done", output_index: 1, item: message },
  { type: "response.output_item.added", output_index: 2, item: { ...program, input: "" } },
  { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 2, delta: "return " },
  { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 2, delta: "1 + 1" },
  { type: "response.a_new_event_of_tomorrow", anything: { at: "all" } },
  { type: "response.output_item.done", output_index: 2, item: program },
  completed()
]

// The request
// -----------

test("the request is the documented body: no state on the vendor's side, explicit marks, one free-text tool", async () => {
  const { fetcher, sent } = vendor(() => sse(small))
  await send(request({ max: 8000 }), fetcher)
  expect(sent.length).toBe(1)
  expect(sent[0]!.url).toBe("http://gateway.test:4000/v1/responses")
  expect(sent[0]!.headers).toEqual({ authorization: "Bearer " + KEY, "content-type": "application/json", "x-session-id": "chat-uuid-1" })
  const mark = { mode: "explicit" }
  expect(sent[0]!.body).toEqual({
    model: "gpt-6.1-sol",
    stream: true,
    store: false,
    stream_options: { include_obfuscation: false },
    input: [
      { role: "developer", content: [{ type: "input_text", text: "You are EverChat.", prompt_cache_breakpoint: mark }] },
      {
        role: "user",
        content: [
          // The blocks up to the one that the memory marked have a mark (three at most); the rest have none.
          { type: "input_text", text: "<chat>\n", prompt_cache_breakpoint: mark },
          { type: "input_text", text: "0+1|a\n1+1|b\n2+1|c\n3+1|d\n", prompt_cache_breakpoint: mark },
          { type: "input_text", text: "4+1|e\n</chat>\n" },
          { type: "input_text", text: "user: hello" }
        ]
      }
    ],
    tools: [{ type: "custom", name: "run", description: "Runs a JavaScript program." }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", summary: "auto", context: "all_turns" },
    include: ["reasoning.encrypted_content"],
    service_tier: "default",
    prompt_cache_key: "chat-uuid-1",
    prompt_cache_options: { mode: "explicit" },
    max_output_tokens: 8000
  })
})

test("a view of many blocks has marks on the last three up to the memory's mark, so the system prompt is among the four written", async () => {
  const blocks = [...Array.from({ length: 9 }, (_, k) => ({ text: `block ${k}\n`, mark: k === 6 })), { text: "user: hi", mark: false }]
  const sent = (await Effect.runPromise(body(request({ items: [{ kind: "user", blocks }] })))) as { input: Array<any> }
  expect(sent.input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" })
  expect(sent.input[1].content.map((part: any) => part.prompt_cache_breakpoint !== undefined)).toEqual([false, false, false, false, true, true, true, false, false, false])
})

test("inside a turn the marks move to the newest results, and a result's bytes do not change when its mark moves on", async () => {
  const blocks = [...Array.from({ length: 9 }, (_, k) => ({ text: `block ${k}\n`, mark: k === 6 })), { text: "user: hi", mark: false }]
  const step = (k: number) => [
    { kind: "turn" as const, output: [{ ...program, call_id: "call_" + k }] },
    { kind: "back" as const, results: [{ id: "call_" + k, output: "result " + k }] }
  ]
  const marks = async (steps: number) => {
    const items = [{ kind: "user" as const, blocks }, ...Array.from({ length: steps }, (_, k) => step(k)).flat()]
    const sent = (await Effect.runPromise(body(request({ items })))) as { input: Array<any> }
    const view = sent.input[1].content.map((part: any, k: number) => (part.prompt_cache_breakpoint === undefined ? "" : "block " + k)).filter((name: string) => name !== "")
    const results = sent.input.filter((item) => item.type === "custom_tool_call_output")
    return { marked: [...view, ...results.filter((item) => item.output[0].prompt_cache_breakpoint !== undefined).map((item) => item.call_id)], results }
  }
  expect((await marks(0)).marked).toEqual(["block 4", "block 5", "block 6"])
  expect((await marks(1)).marked).toEqual(["block 5", "block 6", "call_0"])
  expect((await marks(2)).marked).toEqual(["block 6", "call_0", "call_1"])
  const four = await marks(4)
  expect(four.marked).toEqual(["call_1", "call_2", "call_3"])
  // The result of step 0 had a mark in the request of step 1, and has none now: only the mark differs.
  const first = (await marks(1)).results[0]
  expect(four.results[0]).toEqual({ ...first, output: [{ type: "input_text", text: "result 0" }] })
})

test("a speed is a service tier, and a tool with a schema is a strict function", async () => {
  const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false }
  const asked = request({
    pick: { vendor: "openai", model: "gpt-6-astra", effort: "high", speed: "fast" },
    head: { system: "s", tools: [{ name: "run", description: "d", schema }] }
  })
  const sent = await Effect.runPromise(body(asked))
  expect(sent.service_tier).toBe("priority")
  expect(sent.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" })
  expect(sent.tools).toEqual([{ type: "function", name: "run", description: "d", parameters: schema, strict: true }])
  expect(sent).not.toHaveProperty("max_output_tokens")
  const error = await Effect.runPromise(Effect.flip(body(request({ pick: { ...asked.pick, speed: "warp" } }))))
  expect(error).toMatchObject({ kind: "input", retry: false })
})

test("an earlier step goes back exactly as received, and each result takes the form of its call", async () => {
  const strange = { type: "an_item_of_tomorrow", id: "x_1", nested: { keep: [1, 2, { me: true }] } }
  const call = { id: "fc_1", type: "function_call", call_id: "call_2", name: "lookup", arguments: "{\"q\":\"x\"}", status: "completed" }
  const asked = request({
    items: [
      { kind: "user", blocks: [{ text: "user: go", mark: false }], pictures: [{ type: "image/png", bytes: new Uint8Array([1, 2, 3]) }] },
      { kind: "turn", output: [reasoning, message, program, strange, call] },
      { kind: "back", results: [{ id: "call_1", output: "2" }, { id: "call_2", output: "found", pictures: [{ type: "image/jpeg", bytes: new Uint8Array([255]) }] }] }
    ]
  })
  const { input } = (await Effect.runPromise(body(asked))) as { input: Array<any> }
  expect(input[1].content).toEqual([
    { type: "input_text", text: "user: go" },
    { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "auto" }
  ])
  // Byte for byte: the same JSON text, with every field in its place.
  expect(JSON.stringify(input.slice(2, 7))).toBe(JSON.stringify([reasoning, message, program, strange, call]))
  // A result is always a list. The last result of the step has a mark.
  expect(input.slice(7)).toEqual([
    { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "2" }] },
    {
      type: "function_call_output",
      call_id: "call_2",
      output: [
        { type: "input_text", text: "found", prompt_cache_breakpoint: { mode: "explicit" } },
        { type: "input_image", image_url: "data:image/jpeg;base64,/w==", detail: "auto" }
      ]
    }
  ])
  const lost = request({ items: [{ kind: "back", results: [{ id: "call_9", output: "?" }] }] })
  expect(await Effect.runPromise(Effect.flip(body(lost)))).toMatchObject({ kind: "input", retry: false })
})

// The reply
// ---------

test("a reply streams its thought, its text and its program, and ends with the items as the vendor sent them", async () => {
  const { fetcher } = vendor(() => sse(small))
  const events = await send(request(), fetcher)
  expect(events.slice(0, -1)).toEqual([
    { type: "thought", delta: "Thi" },
    { type: "thought", delta: "nk." },
    { type: "text", delta: "Hello " },
    { type: "text", delta: "there" },
    { type: "program", delta: "return " },
    { type: "program", delta: "1 + 1" }
  ])
  const reply = end(events)
  expect(JSON.stringify(reply.output)).toBe(JSON.stringify([reasoning, message, program]))
  expect(reply.text).toBe("Hello there")
  expect(reply.calls).toEqual([{ id: "call_1", name: "run", input: "return 1 + 1" }])
  expect(reply.stop).toBe("done")
  // The input with no cached part: 12000 - 4000 read - 7000 written.
  expect(reply.usage).toEqual({ input: 1000, cacheRead: 4000, cacheWrite: 7000, output: 1186, searches: 0 })
  expect(reply.pick).toEqual({ vendor: "openai", model: "gpt-6.1-sol", effort: "medium", speed: "slow" })
  expect([reply.id, reply.request]).toEqual(["resp_1", "req_abc"])
})

test("an item comes from its `done` event: the copy in `added` or in the last event may be incomplete", async () => {
  const stale = completed({ output: [{ ...reasoning, encrypted_content: "STALE" }, message] })
  const { fetcher } = vendor(() => sse([...small.slice(0, -1), stale]))
  const reply = end(await send(request(), fetcher))
  expect((reply.output[0] as any).encrypted_content).toBe("ENCRYPTED-WHOLE")
  // The last event listed two items, and three had a `done` event.
  expect(reply.output.length).toBe(3)
  // An item with no `done` event comes from the last event's list.
  const listed = vendor(() => sse([completed()]))
  expect(JSON.stringify(end(await send(request(), listed.fetcher)).output)).toBe(JSON.stringify([reasoning, message, program]))
})

test("the stream is read whatever way the bytes are cut, with CRLF too", async () => {
  const text = "Olá 😀 – ünï"
  const events = [
    { type: "response.output_text.delta", delta: text },
    completed({ output: [{ ...message, content: [{ type: "output_text", text }] }] })
  ]
  for (const chunk of [1, 2, 3, 7, 4096]) {
    const got = await send(request(), vendor(() => sse(events, { chunk })).fetcher)
    expect(got[0]).toEqual({ type: "text", delta: text })
    expect(end(got).text).toBe(text)
  }
  const crlf = new Response(`event: response.completed\r\ndata: ${JSON.stringify(completed())}\r\n\r\n`, { status: 200 })
  expect(end(await send(request(), vendor(() => crlf).fetcher)).text).toBe("Hello there")
})

test("a function call gives its arguments, a refusal is text, and searches are counted from the usage", async () => {
  const call = { id: "fc_1", type: "function_call", call_id: "call_2", name: "lookup", arguments: "{\"q\":\"x\"}", status: "completed" }
  const refusal = { id: "msg_2", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I can not do that." }] }
  const events = [
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"q\":\"x\"}" },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.refusal.delta", item_id: "msg_2", output_index: 1, content_index: 0, delta: "I can not do that." },
    { type: "response.output_item.done", output_index: 1, item: refusal },
    completed({ output: [call, refusal], tool_usage: { web_search: { num_requests: 3 } }, service_tier: "priority" })
  ]
  const got = await send(request({ pick: { vendor: "openai", model: "m", effort: "low", speed: "fast" } }), vendor(() => sse(events)).fetcher)
  expect(got.slice(0, 2)).toEqual([{ type: "program", delta: "{\"q\":\"x\"}" }, { type: "text", delta: "I can not do that." }])
  const reply = end(got)
  expect(reply.calls).toEqual([{ id: "call_2", name: "lookup", input: "{\"q\":\"x\"}" }])
  expect(reply.text).toBe("I can not do that.")
  expect(reply.usage?.searches).toBe(3)
  expect(reply.pick.speed).toBe("fast")
})

test("a request can name the reply it expects to reuse, and the reply says if the cache missed, and why", async () => {
  const miss = { type: "cache_miss", reason: "input_changed", comparison_reusable_tokens: 5629, cache_missed_tokens: 5629 }
  const { fetcher, sent } = vendor(() => sse([completed({ prompt_cache_diagnostics: miss })]))
  const reply = end(await send(request({ baseline: "resp_before" }), fetcher))
  expect(sent[0]!.body.prompt_cache_options).toEqual({ mode: "explicit", comparison_response_id: "resp_before" })
  expect(reply.diagnosis).toEqual({ type: "cache_miss", reason: "input_changed", missed: 5629, reusable: 5629 })
  const hit = end(await send(request({ baseline: "resp_before" }), vendor(() => sse([completed({ prompt_cache_diagnostics: { type: "cache_hit" } })])).fetcher))
  expect(hit.diagnosis).toEqual({ type: "cache_hit", reason: null, missed: null, reusable: null })
  // With no baseline, nothing is asked and nothing is told.
  expect(end(await send(request(), vendor(() => sse(small)).fetcher)).diagnosis).toBeNull()
})

test("a fast request that ran at the standard tier says so, and a reply with no usage has none", async () => {
  const fast = request({ pick: { vendor: "openai", model: "m", effort: "low", speed: "fast" } })
  const reply = end(await send(fast, vendor(() => sse([completed({ service_tier: "default", usage: null })])).fetcher))
  expect(reply.pick.speed).toBe("slow")
  expect(reply.usage).toBeNull()
})

test("a reply that stops at the token limit or at the content filter ends with what it has, and says why", async () => {
  const stopped = (reason: string) => ({
    type: "response.incomplete",
    response: { id: "resp_2", status: "incomplete", output: [], usage: null, incomplete_details: { reason } }
  })
  const partial = [{ type: "response.output_text.delta", delta: "Hel" }, { type: "response.output_item.done", output_index: 0, item: message }]
  const max = end(await send(request(), vendor(() => sse([...partial, stopped("max_output_tokens")])).fetcher))
  expect([max.stop, max.text, max.usage]).toEqual(["max", "Hello there", null])
  expect(end(await send(request(), vendor(() => sse([stopped("content_filter")])).fetcher)).stop).toBe("filter")
  const other = await fails(request(), vendor(() => sse([...partial, stopped("something_new")])).fetcher)
  expect(other).toMatchObject({ kind: "cut", retry: true, began: true, code: "something_new" })
})

// Failures
// --------

test("a failure in the stream says whether another try can help, and whether the model had begun", async () => {
  const failed = (code: string) => ({ type: "response.failed", response: { id: "resp_3", status: "failed", output: [], usage: null, error: { code, message: "It failed." } } })
  const cases: Array<[Array<Record<string, unknown>>, Record<string, unknown>]> = [
    [[failed("server_error")], { kind: "busy", retry: true, began: false, code: "server_error" }],
    [[failed("rate_limit_exceeded")], { kind: "busy", retry: true }],
    [[failed("a_code_of_tomorrow")], { kind: "busy", retry: true }],
    [[failed("invalid_prompt")], { kind: "input", retry: false }],
    [[failed("image_too_large")], { kind: "input", retry: false }],
    [[failed("cyber_policy")], { kind: "policy", retry: false }],
    [[{ type: "response.output_text.delta", delta: "Hi" }, failed("server_error")], { kind: "busy", retry: true, began: true }],
    [[{ type: "error", code: "server_is_overloaded", message: "Busy.", param: null }], { kind: "busy", retry: true, code: "server_is_overloaded" }],
    [[{ type: "error", code: null, message: "?" }], { kind: "busy", retry: true }],
    [[{ type: "error", code: "misalignment_policy_violation", message: "No." }], { kind: "policy", retry: false }]
  ]
  for (const [events, expected] of cases) {
    const error = await fails(request(), vendor(() => sse(events)).fetcher)
    expect(error).toBeInstanceOf(WireError)
    expect(error).toMatchObject({ ...expected, request: "req_abc" })
  }
})

test("a stream that ends or breaks before the reply ends is cut", async () => {
  const text = [{ type: "response.output_item.added", output_index: 0, item: message }, { type: "response.output_text.delta", delta: "Hel" }]
  expect(await fails(request(), vendor(() => sse(text)).fetcher)).toMatchObject({ kind: "cut", retry: true, began: true })
  expect(await fails(request(), vendor(() => sse([])).fetcher)).toMatchObject({ kind: "cut", retry: true, began: false })
  const broken = await fails(request(), vendor(() => sse(text, { cut: true })).fetcher)
  expect(broken).toMatchObject({ kind: "cut", retry: true })
  expect(broken.message).toContain("socket closed")
  const junk = new Response("data: {not json\n\n", { status: 200 })
  expect(await fails(request(), vendor(() => junk).fetcher)).toMatchObject({ kind: "protocol" })
})

test("an HTTP error says what kind it is: busy, a used-up quota, a bad request, a refused key", async () => {
  const http = (status: number, error: Record<string, unknown> | string, headers: Record<string, string> = {}) =>
    vendor(() => new Response(typeof error === "string" ? error : JSON.stringify({ error }), { status, headers: { "x-request-id": "req_err", ...headers } })).fetcher
  const cases: Array<[Fetcher, Record<string, unknown>]> = [
    [http(429, { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Slow down." }, { "retry-after": "7" }), { kind: "busy", retry: true, after: 7, status: 429, code: "rate_limit_exceeded" }],
    [http(429, { type: "insufficient_quota", code: "credit_balance_exhausted", message: "No credit." }), { kind: "limit", retry: false, status: 429 }],
    [http(429, { type: "insufficient_quota", message: "No credit." }), { kind: "limit", retry: false, code: "insufficient_quota" }],
    [http(400, { type: "invalid_request_error", code: null, message: "Too much input.", param: "input" }), { kind: "input", retry: false, status: 400 }],
    [http(401, { type: "invalid_request_error", code: "invalid_api_key", message: "Bad key." }), { kind: "auth", retry: false }],
    [http(403, { code: "misalignment_policy_violation", message: "No." }), { kind: "policy", retry: false }],
    [http(500, "<html>oops</html>"), { kind: "busy", retry: true, status: 500, code: null }],
    [http(503, { type: "service_unavailable_error", code: "server_is_overloaded", message: "Busy." }, { "retry-after": "2" }), { kind: "busy", retry: true, after: 2 }],
    [http(408, ""), { kind: "busy", retry: true }]
  ]
  for (const [fetcher, expected] of cases) {
    const error = await fails(request(), fetcher)
    expect(error).toMatchObject({ ...expected, began: false, request: "req_err" })
  }
  const bad = await fails(request(), http(400, { message: "Too much input." }))
  expect(bad.message).toBe("OpenAI answered 400: Too much input.")
})

test("a request that does not reach the inference gateway is busy, and no error holds the key", async () => {
  const down: Fetcher = () => Promise.reject(new Error("connect ECONNREFUSED"))
  const error = await fails(request(), down)
  expect(error).toMatchObject({ kind: "busy", retry: true, began: false, status: null })
  const echo = vendor(() => new Response(JSON.stringify({ error: { message: "Bad key." } }), { status: 401 }))
  const refused = await fails(request(), echo.fetcher)
  for (const one of [error, refused]) {
    expect(JSON.stringify(one) + String(one) + one.message).not.toContain(KEY)
  }
})

test("an interrupt of the reader ends the HTTP request", async () => {
  let signal: AbortSignal | undefined
  const never: Fetcher = (_, init) => {
    signal = init.signal ?? undefined
    return Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200 }))
  }
  await Effect.runPromise(
    OpenAI.use((wire) => Stream.runCollect(wire.send(request())).pipe(Effect.timeoutOption("50 millis"))).pipe(
      Effect.provide(OpenAI.layer.pipe(Layer.provide(gateway))),
      Effect.provideService(Fetch, never)
    )
  )
  expect(signal?.aborted).toBe(true)
})
