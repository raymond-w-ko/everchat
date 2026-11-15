// What the tests of the whole program share: the program to start, a fake
// vendor on this machine, and a place for one chat.
//
// No test sends a request to a real model: every launch gets the fake
// vendor's address, and a home directory of its own with no gateway file.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FILE } from "../src/database.ts"

// The program: from its source, or the executable that EVERCHAT_BIN names
// (`just build` makes one), to run these same tests on it.
export const PROGRAM = process.env.EVERCHAT_BIN === undefined || process.env.EVERCHAT_BIN === ""
  ? [process.execPath, path.join(import.meta.dir, "..", "src", "main.ts")]
  : [path.resolve(process.env.EVERCHAT_BIN)]

// One event of a streamed reply, as OpenAI's documents frame it.
export type Sent = Record<string, unknown>
const frame = (event: Sent) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`

const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 105 }
export const completed = (output: ReadonlyArray<Sent>): Sent => ({ type: "response.completed", response: { id: "resp_1", status: "completed", output, usage, service_tier: "default" } })

// A reply of text, in two parts.
export const text = (said: string): Array<Sent> => {
  const half = Math.ceil(said.length / 2)
  return [
    { type: "response.output_text.delta", delta: said.slice(0, half) },
    { type: "response.output_text.delta", delta: said.slice(half) },
    completed([{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: said, annotations: [] }] }])
  ]
}

// A reply that runs one program.
export const program = (id: string, code: string): Array<Sent> => [
  { type: "response.custom_tool_call_input.delta", delta: code },
  completed([{ id: "ctc_" + id, type: "custom_tool_call", call_id: id, name: "run", input: code }])
]

// A fake vendor: `answer` gives the events of the n-th request (1, 2, ...),
// or "hold": the reply then starts and never ends, or a response of its
// own, for example a refusal. It can give them later, as a promise.
type Answer = Array<Sent> | "hold" | Response
export const vendor = (answer: (n: number, body: any) => Answer | Promise<Answer>) => {
  const bodies: Array<any> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (request) => {
      const body = await request.json()
      bodies.push(body)
      const got = await answer(bodies.length, body)
      if (got instanceof Response) {
        return got
      }
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (got === "hold") {
            controller.enqueue(encoder.encode(frame({ type: "response.output_text.delta", delta: "I am still " })))
            return
          }
          for (const event of got) {
            controller.enqueue(encoder.encode(frame(event)))
          }
          controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_" + bodies.length } })
    }
  })
  return { bodies, address: "http://127.0.0.1:" + server.port, stop: () => server.stop(true) }
}

// A new place for one chat: its home, a work directory, and a home
// directory of the user with no gateway file in it.
export const place = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-whole-"))
  const home = path.join(root, "home")
  const work = path.join(root, "work")
  fs.mkdirSync(work)
  return { root, home, work, file: path.join(home, FILE) }
}

export const env = (at: ReturnType<typeof place>, address: string | undefined): Record<string, string | undefined> => ({
  PATH: process.env.PATH,
  HOME: at.root,
  EVERCHAT_HOME: at.home,
  EVERCHAT_GATEWAY_URL: address,
  EVERCHAT_GATEWAY_KEY: address === undefined ? undefined : "test-key"
})
