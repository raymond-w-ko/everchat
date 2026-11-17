#!/usr/bin/env bun
// An example MCP server
// =====================
// A small connector: an MCP server with two tools, so that you can see a
// connector work in a chat, and copy this file for your own code. The tests
// of the connectors start it too, on stdio and over HTTP.
//
// Its tools
//
//   add    { a: number, b: number }: gives { sum }, the sum of the two. It
//          only reads (the hint `readOnlyHint`).
//   send   { to: string, text: string }: sends nothing. It gives a text that
//          says to whom, and how many characters, it would have sent.
//
// How to run it
//
//   just mcp-example                  on stdio: a program that EverChat starts
//   just mcp-example --port 4682      over HTTP, on 127.0.0.1 only
//   bun tools/mcpexample.ts [--port <n>]
//
// On stdio, nothing but the protocol goes to the standard output, and the
// server ends when its standard input ends. With `--port <n>` (0: any free
// port), it listens on 127.0.0.1 only, takes only `127.0.0.1` as the
// request's host, writes its address as one line on the standard output
// (`http://127.0.0.1:<port>/mcp`), and serves until a SIGTERM or a SIGINT
// (Ctrl+C). It offers the protocol's version 2026-07-28 only. It reads no
// file and no variable, and starts no process.
//
// How a chat uses it
//
// Name it as a server in `config.json` in the home (`packages/local/AGENTS.md`,
// "The config file"), with the path of this file:
//
//   {
//     "servers": {
//       "example": { "command": "bun", "args": ["<path>/tools/mcpexample.ts"] }
//     }
//   }
//
// Or, when it runs with `--port 4682`:
//
//   { "servers": { "example": { "url": "http://127.0.0.1:4682/mcp" } } }
//
// The server's name is the namespace of its functions: a program of the chat
// then has `example.add` and `example.send`. Each tool is "auto" (it runs with
// no question) unless the file says another word. To be asked before each
// `send`, or to refuse it:
//
//   "example": { "command": "bun", "args": ["<path>/tools/mcpexample.ts"], "tools": { "send": "ask" } }
//   "example": { "command": "bun", "args": ["<path>/tools/mcpexample.ts"], "tools": { "send": "deny" } }
//
// The hint of `add` changes no default: in the local use, a tool's approval is
// a setting of the config file only.

import { createMcpHandler, fromJsonSchema, hostHeaderValidationResponse, McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

const USAGE = "usage: bun tools/mcpexample.ts [--port <n>]  (no port: stdio; 0: any free port)"

// The protocol's version that it offers: the 2025 forms are refused.
const LEGACY = "reject"

// The address that it listens on, and the one host that a request may name.
const HOST = "127.0.0.1"

// One server, with its two tools. The serving entries make one for each
// connection (stdio) or each request (HTTP).
const make = () => {
  const server = new McpServer({ name: "everchat-example", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.registerTool(
    "add",
    {
      description: "Adds two numbers, and gives their sum.",
      inputSchema: fromJsonSchema<{ a: number; b: number }>({
        type: "object",
        properties: { a: { type: "number", description: "The first number" }, b: { type: "number", description: "The second number" } },
        required: ["a", "b"],
        additionalProperties: false
      }),
      outputSchema: fromJsonSchema<{ sum: number }>({
        type: "object",
        properties: { sum: { type: "number", description: "a + b" } },
        required: ["sum"],
        additionalProperties: false
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ a, b }) => {
      const result = { sum: a + b }
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
    }
  )
  server.registerTool(
    "send",
    {
      description: "Sends a text to someone. This example sends nothing: it says to whom, and how many characters, it would have sent.",
      inputSchema: fromJsonSchema<{ to: string; text: string }>({
        type: "object",
        properties: { to: { type: "string", description: "Who gets the text" }, text: { type: "string", description: "The text" } },
        required: ["to", "text"],
        additionalProperties: false
      })
    },
    async ({ to, text }) => ({ content: [{ type: "text", text: `Not sent (an example): ${text.length} characters to ${JSON.stringify(to)}.` }] })
  )
  return server
}

// The port of `--port <n>`, undefined for none, or the usage's fault.
const portOf = (args: ReadonlyArray<string>): number | undefined | string => {
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== "--port" || !/^\d{1,5}$/.test(args[1] ?? "") || Number(args[1]) > 65_535) return USAGE
  return Number(args[1])
}

const http = (port: number) => {
  const handler = createMcpHandler(make, { legacy: LEGACY })
  const server = Bun.serve({
    hostname: HOST,
    port,
    fetch: (request) => {
      // A page of another site may reach 127.0.0.1 by a name of its own:
      // only this host is taken.
      const refused = hostHeaderValidationResponse(request, [HOST])
      if (refused !== undefined) return refused
      if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 })
      return handler.fetch(request)
    }
  })
  console.log(`http://${HOST}:${server.port}/mcp`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void Promise.allSettled([handler.close(), server.stop(true)]).then(() => process.exit(0))
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}

const main = () => {
  const port = portOf(process.argv.slice(2))
  if (typeof port === "string") {
    console.error(port)
    process.exit(2)
  }
  if (port === undefined) {
    // It ends when the standard input ends: then nothing holds the process.
    serveStdio(make, { legacy: LEGACY })
    return
  }
  http(port)
}

if (import.meta.main) {
  main()
}
