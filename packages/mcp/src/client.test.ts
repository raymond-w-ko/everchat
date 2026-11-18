// The load of the functions from outside (client.ts), and their calls,
// against servers of the SDK in this process: each server is served over the SDK's in-memory pair
// of transports, so no process, socket or network is used. `serveStdio`
// takes the server's side of the pair: it is the SDK's entry that answers
// the version's discovery (a server connected by hand answers only the old
// handshake), and with a transport given it reads no stdio.

import { expect, test } from "bun:test"
import { compile } from "@earendil-works/pi-schema"
import { type Declaration, FunctionError, HOSTED, type JsonSchema, refusals, Shortened } from "@everchat/core/functions"
import { given } from "@everchat/core/limit"
import { renderDeclarations } from "@everchat/core/declarations"
import { globalOf } from "@everchat/core/head"
import { InMemoryTransport, SdkError, SdkErrorCode, type Transport } from "@modelcontextprotocol/client"
import { McpServer, ProtocolError, ProtocolErrorCode, Server as Low } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { Effect, Exit, Fiber, Logger, Scope } from "effect"
import { TestClock } from "effect/testing"
import { type Checked, checkOf, DEFAULTS, DEPTH, FORM, FORM_SIZE, type Form, formOf, HEAD_RENDER, load, type Loaded, MARK, type Options, type Outside, PAGES, PAIRS, RENDER, resultOf, type Server, sizeOf, TAG, VERSION, WORK } from "./client.ts"

// Fakes
// -----

type Definition = Record<string, unknown>

// A definition of a tool that every check passes, with `extra` over it.
const tool = (name: string, extra: Definition = {}): Definition => ({
  name,
  description: "Does " + name + ".",
  inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
  ...extra
})

// A server's transport, and how many times its client's side was closed
// (the SDK may close an in-memory side twice: once itself, once by its
// other side).
interface Fake {
  readonly transport: () => Transport
  readonly closes: () => number
}

// The client's side counts its closes.
const counted = (transport: Transport, count: () => void): Transport => {
  const close = transport.close.bind(transport)
  transport.close = async () => {
    count()
    await close()
  }
  return transport
}

// A server of the protocol's version whose list of tools comes in `pages`,
// in that order (the cursor is the next page's index).
const served = (pages: ReadonlyArray<ReadonlyArray<Definition>>): Fake => {
  let closes = 0
  return {
    transport: () => {
      const [client, server] = InMemoryTransport.createLinkedPair()
      serveStdio(() => {
        const low = new Low({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } })
        low.setRequestHandler("tools/list", async (request) => {
          const at = Number(request.params?.cursor ?? 0)
          return { tools: pages[at] ?? [], ...(at + 1 < pages.length ? { nextCursor: String(at + 1) } : {}) } as never
        })
        return low as never
      }, { transport: server })
      return counted(client, () => closes++)
    },
    closes: () => closes
  }
}

// A server that takes every message and never answers one.
const silent = (): Fake => {
  let closes = 0
  return {
    transport: () => ({
      start: async () => {},
      send: async () => {},
      close: async () => {
        closes++
      }
    }),
    closes: () => closes
  }
}

// A server of the old version only: connected by hand, it answers only the
// old handshake.
const old = (): Fake => {
  let closes = 0
  return {
    transport: () => {
      const [client, server] = InMemoryTransport.createLinkedPair()
      void new McpServer({ name: "old", version: "1.0.0" }).connect(server)
      return counted(client, () => closes++)
    },
    closes: () => closes
  }
}

const server = (name: string, fake: Fake, more: Partial<Server> = {}): Server => ({ name, transport: fake.transport, ...more })

// A load in its own scope, with its log's lines as JSON.
const loaded = async (servers: ReadonlyArray<Server>, options: Partial<Options> = {}) => {
  const lines: Array<string> = []
  const capture = Logger.layer([Logger.make((line) => {
    lines.push(Logger.formatJson.log(line))
  })])
  const got = await Effect.runPromise(
    load(servers, { beside: HOSTED, ...options }).pipe(Effect.scoped, Effect.provide(capture))
  )
  return { ...got, lines: lines.map((line) => JSON.parse(line) as { level: string; message: unknown; annotations: Record<string, unknown> }) }
}

// The sentences of a form's refusals (client.ts, `refusalOf`).
type Which = "input" | "output"
const REFERENCE = (which: Which) =>
  `Its ${which} schema has a reference that EverChat does not follow: only a $ref to # or to a JSON pointer #/... in the same schema, whose target is a schema.`
const ITSELF = (which: Which) => `Its ${which} schema holds itself: a $ref names a schema that holds that $ref, and EverChat does not check such a schema.`
const LARGE = (which: Which) =>
  `Its ${which} schema is too large for EverChat's check: its form has more than ${FORM} parts, a size of more than ${FORM_SIZE}, more than ${DEPTH} levels, or more than ${PAIRS} pairs of a property and a required name.`
const PATTERN_PROPERTIES = (which: Which) => `Its ${which} schema has patternProperties, which EverChat does not check.`
const BELOW = (which: Which, keyword: string, under: string) => `Its ${which} schema has ${keyword} below ${under}, where EverChat cannot leave it out.`
const COMPILE = (which: Which) => `Its ${which} schema does not compile.`

// The checked form of a schema, for a check outside a load.
const checked = (schema: unknown, which: "input" | "output"): Checked => {
  const got = checkOf(schema, which)
  if (typeof got === "string") throw new Error(got)
  return got
}

const names = (got: Loaded) => got.declarations.map((one) => one.name)
const reasons = (got: Loaded, tool: string) => got.refused.filter((one) => one.tool === tool).map((one) => one.reason)

// The list
// --------

test("two pages come as one list, sorted by name", async () => {
  const fake = served([[tool("delta"), tool("bravo")], [tool("charlie"), tool("alpha")]])
  const got = await loaded([server("s", fake)])
  expect(names(got)).toEqual(["s.alpha", "s.bravo", "s.charlie", "s.delta"])
  expect(got.entries.map((one) => one.declaration)).toEqual([...got.declarations])
  expect(got.entries.map((one) => [one.server, one.tool])).toEqual([["s", "alpha"], ["s", "bravo"], ["s", "charlie"], ["s", "delta"]])
  expect(got.refused).toEqual([])
})

test("the declaration takes the name, the description and the two schemas only", async () => {
  const output = { type: "object", properties: { sum: { type: "number" } } }
  const fake = served([[tool("add", { outputSchema: output, title: "Add", annotations: { readOnlyHint: true }, unknown: 1 })]])
  const got = await loaded([server("s", fake)])
  expect(got.declarations).toEqual([{
    name: "s.add",
    description: "Does add.",
    inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
    outputSchema: output
  }])
  expect(got.refused).toEqual([])
})

test("the same list from the pages in another order, and the servers in another order", async () => {
  const a = [tool("one"), tool("two", { description: "x" }), tool("three")]
  const b = [tool("four"), tool("five", { _meta: { k: 1 } })]
  const first = await loaded([server("a", served([a.slice(0, 1), a.slice(1)])), server("b", served([b]))])
  const second = await loaded([server("b", served([b.slice(1), b.slice(0, 1)])), server("a", served([[a[2]!], [a[1]!, a[0]!]]))])
  expect(JSON.stringify(second.declarations)).toBe(JSON.stringify(first.declarations))
  expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries))
  expect(names(first)).toEqual(["a.one", "a.three", "a.two", "b.five", "b.four"])
})

test("_meta is kept on the entry, whole", async () => {
  const meta = { "io.everchat/approval": "always", nested: { a: [1, 2] } }
  const got = await loaded([server("s", served([[tool("send", { _meta: meta }), tool("plain")]]))])
  expect(got.entries.map((one) => one.meta)).toEqual([undefined, meta])
  expect("_meta" in got.declarations[1]!).toBe(false)
})

// The check of a definition
// -------------------------

test("a description of 1,025 characters is refused, and the server's other tools stay", async () => {
  const fake = served([[tool("long", { description: "d".repeat(1025) }), tool("edge", { description: "d".repeat(1024) }), tool("short")]])
  const got = await loaded([server("s", fake)])
  expect(names(got)).toEqual(["s.edge", "s.short"])
  expect(got.refused).toEqual([{ server: "s", tool: "long", reason: "Its description is not a text of at most 1024 characters." }])
})

test("a name outside the pattern is refused, and the server's other tools stay", async () => {
  const long = "n".repeat(129)
  const fake = served([[tool("has space"), tool("ok_1.x-y"), tool(long), tool(""), tool("n".repeat(128))]])
  const got = await loaded([server("s", fake)])
  expect(names(got)).toEqual(["s.n" + "n".repeat(127), "s.ok_1_x_y"])
  expect(got.entries.map((one) => one.tool)).toEqual(["n".repeat(128), "ok_1.x-y"])
  const sentence = "Its name does not fit ^[A-Za-z0-9_.-]{1,128}$."
  expect(got.refused).toEqual([
    { server: "s", tool: "", reason: sentence },
    { server: "s", tool: "has space", reason: sentence },
    { server: "s", tool: "n".repeat(128) + "…", reason: sentence }
  ])
})

test("an inputSchema that is no object schema: that server is refused whole and closed, and a second server loads all its tools", async () => {
  const bad = served([[tool("fine")], [tool("array", { inputSchema: { type: "array" } }), tool("other")]])
  const good = served([[tool("x"), tool("y")]])
  const got = await loaded([server("bad", bad), server("good", good)])
  expect(names(got)).toEqual(["good.x", "good.y"])
  expect(got.refused).toEqual([{ server: "bad", reason: "Its list of tools does not fit the protocol." }])
  expect(bad.closes()).toBeGreaterThan(0)
})

test("a schema with an unresolved reference is refused, and the server's other tools stay", async () => {
  const dangling = { type: "object", properties: { a: { $ref: "#/$defs/nowhere" } } }
  const resolved = { type: "object", properties: { a: { $ref: "#/$defs/n" } }, $defs: { n: { type: "number" } } }
  const fake = served([[
    tool("input", { inputSchema: dangling }),
    tool("output", { outputSchema: dangling }),
    tool("good", { inputSchema: resolved, outputSchema: resolved })
  ]])
  const got = await loaded([server("s", fake)])
  expect(names(got)).toEqual(["s.good"])
  expect(reasons(got, "input")).toEqual([REFERENCE("input")])
  expect(reasons(got, "output")).toEqual([REFERENCE("output")])
})

test("tools a-b and a_b of one server: the first stays, the second is refused", async () => {
  const got = await loaded([server("s", served([[tool("a_b"), tool("a-b")]]))])
  expect(names(got)).toEqual(["s.a_b"])
  expect(got.entries.map((one) => one.tool)).toEqual(["a-b"])
  expect(got.refused).toEqual([{ server: "s", tool: "a_b", reason: "Another function before it has this name." }])
})

test("a server named as a built-in of beside: its functions are refused, and the built-in stays", async () => {
  const beside: ReadonlyArray<Declaration> = HOSTED
  const got = await loaded([server("zoom", served([[tool("in"), tool("out")]])), server("s", served([[tool("x")]]))], { beside })
  expect(names(got)).toEqual(["s.x"])
  expect(got.refused).toEqual([
    { server: "zoom", tool: "in", reason: "Its namespace \"zoom\" is the name of another function." },
    { server: "zoom", tool: "out", reason: "Its namespace \"zoom\" is the name of another function." }
  ])
  expect(refusals([...beside, ...got.declarations])).toEqual([])
})

test("a server named as a global of the sandbox: its functions are refused", async () => {
  const got = await loaded([server("console", served([[tool("x")]]))])
  expect(names(got)).toEqual([])
  expect(got.refused).toEqual([{ server: "console", tool: "x", reason: "\"console\" is a global of the sandbox." }])
})

test("more than `tools` definitions: the first by name are taken, the rest refused with one refusal", async () => {
  const got = await loaded([server("s", served([[tool("d"), tool("c")], [tool("b"), tool("a")]]))], { tools: 3 })
  expect(names(got)).toEqual(["s.a", "s.b", "s.c"])
  expect(got.refused).toEqual([{ server: "s", reason: "It gives 4 tools: the first 3 by name are taken, and the rest are refused." }])
})

// The servers
// -----------

test("a server that never answers is given up after the limit, closed, and the others load", async () => {
  const quiet = silent()
  const good = served([[tool("x")]])
  const started = Date.now()
  const got = await loaded([server("quiet", quiet), server("good", good)], { load: 300 })
  const took = Date.now() - started
  expect(took).toBeGreaterThanOrEqual(290)
  expect(took).toBeLessThan(3000)
  expect(names(got)).toEqual(["good.x"])
  expect(got.refused).toEqual([{ server: "quiet", reason: "It did not load in 300 ms." }])
  expect(quiet.closes()).toBeGreaterThan(0)
})

test("a server that does not offer the version is refused, closed, and the others load", async () => {
  const legacy = old()
  const got = await loaded([server("old", legacy), server("good", served([[tool("x")]]))])
  expect(names(got)).toEqual(["good.x"])
  expect(got.refused).toEqual([{ server: "old", reason: `It did not connect with the protocol's version ${VERSION}.` }])
  expect(legacy.closes()).toBeGreaterThan(0)
})

test("a transport that cannot be made refuses its server only", async () => {
  const broken: Server = {
    name: "broken",
    transport: () => {
      throw new Error("spawn /secret/path ENOENT")
    }
  }
  const got = await loaded([broken, server("good", served([[tool("x")]]))])
  expect(names(got)).toEqual(["good.x"])
  expect(got.refused).toEqual([{ server: "broken", reason: "Its transport could not be made." }])
})

test("the scope's end closes each connection, and a failed one closes at once", async () => {
  const one = served([[tool("x")]])
  const two = served([[tool("y")]])
  const bad = served([[tool("z", { inputSchema: { type: "string" } })]])
  const scope = await Effect.runPromise(Scope.make())
  const got = await Effect.runPromise(
    load([server("one", one), server("two", two), server("bad", bad)], { beside: HOSTED }).pipe(
      Scope.provide(scope),
      Effect.provide(Logger.layer([]))
    )
  )
  expect(names(got)).toEqual(["one.x", "two.y"])
  const closed = () => [one.closes() > 0, two.closes() > 0, bad.closes() > 0]
  expect(closed()).toEqual([false, false, true])
  await Effect.runPromise(Scope.close(scope, Exit.void))
  expect(closed()).toEqual([true, true, true])
})

// A server whose load fails (its list does not fit the protocol), or with
// `definitions` one that loads them, and whose client's side holds its
// first close open until the test ends it (`end`) or fails it (`fail`).
// `closes` counts the calls of that side's close: the client's step of the
// one close calls it first; after that step ends, the transport's own step
// calls it again.
const held = (name: string, definitions: ReadonlyArray<Definition> = [tool("z", { inputSchema: { type: "string" } })]) => {
  const fake = served([definitions])
  const gate = Promise.withResolvers<void>()
  let closes = 0
  let first = true
  let ended = false
  const transport = () => {
    const side = fake.transport()
    const close = side.close.bind(side)
    side.close = async () => {
      closes++
      if (first) {
        first = false
        try {
          await gate.promise
        } finally {
          ended = true
        }
      }
      await close()
    }
    return side
  }
  return {
    server: server(name, { transport, closes: () => closes }),
    closes: () => closes,
    ended: () => ended,
    end: () => gate.resolve(),
    fail: () => gate.reject(new Error("the close failed"))
  }
}

// Turns of the event loop, with no clock: what is ready runs.
const turns = async (count = 50) => {
  for (let i = 0; i < count; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

// A load in a scope of the test's own, with a limit far past the test's
// time: a wait for a close would end only by the test's own limit. `lines`
// are the log's messages, of the load and of the scope's end.
const opened = async (servers: ReadonlyArray<Server>) => {
  const lines: Array<unknown> = []
  const capture = Logger.layer([Logger.make((line) => {
    lines.push(line.message)
  })])
  const scope = await Effect.runPromise(Scope.make())
  const got = await Effect.runPromise(
    load(servers, { beside: HOSTED, load: 600_000 }).pipe(Scope.provide(scope), Effect.provide(capture))
  )
  let returned = false
  const end = () =>
    Effect.runPromiseExit(Scope.close(scope, Exit.void).pipe(Effect.provide(capture))).then((exit) => {
      returned = true
      return exit
    })
  return { got, end, returned: () => returned, lines }
}

test("a server whose load fails and whose close stays open: the load gives its refusal and the other server's functions while that close is open; when the close ends, the scope's end returns", async () => {
  const stuck = held("stuck")
  try {
    const { got, end, returned } = await opened([stuck.server, server("good", served([[tool("x")]]))])
    expect(names(got)).toEqual(["good.x"])
    expect(got.refused).toEqual([{ server: "stuck", reason: "Its list of tools does not fit the protocol." }])
    expect([stuck.closes(), stuck.ended()]).toEqual([1, false])
    const ending = end()
    await turns()
    stuck.end()
    expect(Exit.isSuccess(await ending)).toBe(true)
    expect([returned(), stuck.ended()]).toEqual([true, true])
  } finally {
    stuck.end()
  }
})

test("the scope's end does not return before a failed server's close ends, and the transport saw one close", async () => {
  const stuck = held("stuck")
  try {
    const { end, returned } = await opened([stuck.server])
    const ending = end()
    await turns()
    expect([returned(), stuck.ended(), stuck.closes()]).toEqual([false, false, 1])
    await turns()
    expect([returned(), stuck.closes()]).toEqual([false, 1])
    stuck.end()
    expect(Exit.isSuccess(await ending)).toBe(true)
    expect(stuck.ended()).toBe(true)
  } finally {
    stuck.end()
  }
})

test("a close that rejects after the load returned: the load's result is the same, and nothing fails", async () => {
  const stuck = held("stuck")
  const unhandled: Array<unknown> = []
  const note = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", note)
  try {
    const { got, end, lines } = await opened([stuck.server, server("good", served([[tool("x")]]))])
    const logged = JSON.stringify(lines)
    const before = JSON.stringify({ names: names(got), refused: got.refused })
    stuck.fail()
    await turns()
    expect(stuck.ended()).toBe(true)
    expect(JSON.stringify({ names: names(got), refused: got.refused })).toBe(before)
    expect(names(got)).toEqual(["good.x"])
    expect(got.refused).toEqual([{ server: "stuck", reason: "Its list of tools does not fit the protocol." }])
    const exit = await end()
    expect(Exit.isSuccess(exit)).toBe(true)
    await turns()
    expect(unhandled).toEqual([])
    expect(JSON.stringify(lines)).toBe(logged)
    expect(lines).toHaveLength(1)
  } finally {
    process.off("unhandledRejection", note)
  }
})

test("ec-egsmp 3: the scope's end runs the closes of two loaded servers at one time: the second starts before the first has ended, and the end returns when both have", async () => {
  const one = held("one", [tool("x")])
  const two = held("two", [tool("y")])
  try {
    const { got, end, returned } = await opened([one.server, two.server])
    expect(names(got)).toEqual(["one.x", "two.y"])
    // No close before the scope's end.
    expect([one.closes(), two.closes()]).toEqual([0, 0])
    const ending = end()
    await turns()
    // Both closes have started, and neither has ended.
    expect([one.closes(), two.closes(), one.ended(), two.ended(), returned()]).toEqual([1, 1, false, false, false])
    one.end()
    await turns()
    expect([one.ended(), two.ended(), returned()]).toEqual([true, false, false])
    two.end()
    expect(Exit.isSuccess(await ending)).toBe(true)
    expect([returned(), one.ended(), two.ended()]).toEqual([true, true, true])
  } finally {
    one.end()
    two.end()
  }
})

// The settings
// ------------

test("deny is left out with no refusal; the tool's own setting wins over its server's", async () => {
  const fake = served([[tool("keep"), tool("drop"), tool("constructor")]])
  const got = await loaded([server("s", fake, { tools: { drop: "deny" } })])
  expect(names(got)).toEqual(["s.constructor", "s.keep"])
  expect(got.refused).toEqual([])
  const all = await loaded([server("s", served([[tool("keep"), tool("drop")]]), { approval: "deny", tools: { keep: "auto" } })])
  expect(names(all)).toEqual(["s.keep"])
  expect(all.refused).toEqual([])
})

// Each entry's name and its flag of approval (`Entry.approval`; absent
// is "none").
const flags = (got: Loaded) => got.entries.map((one) => [one.declaration.name, "approval" in one ? one.approval : "none"])

test("ask is in the list with approval: true and no refusal; deny is left out; auto has no flag; the declaration is the same with any setting", async () => {
  const got = await loaded([server("s", served([[tool("send"), tool("read"), tool("drop")]]), { tools: { send: "ask", drop: "deny" } })])
  expect(flags(got)).toEqual([["s.read", "none"], ["s.send", true]])
  expect(got.refused).toEqual([])
  const all = await loaded([server("s", served([[tool("send"), tool("read")]]), { approval: "ask" })])
  expect(flags(all)).toEqual([["s.read", true], ["s.send", true]])
  expect(all.refused).toEqual([])
  const auto = await loaded([server("s", served([[tool("send"), tool("read")]]))])
  expect(flags(auto)).toEqual([["s.read", "none"], ["s.send", "none"]])
  expect(JSON.stringify(all.declarations)).toBe(JSON.stringify(auto.declarations))
})

test("a marked server: the _meta key io.everchat/approval with true, \"yes\" or 1 (or null) gates the tool, with false or with no key it does not, and deny leaves it out; without marked the key changes nothing", async () => {
  expect(MARK).toBe("io.everchat/approval")
  const definitions = () =>
    served([[
      tool("t", { _meta: { [MARK]: true } }),
      tool("y", { _meta: { [MARK]: "yes" } }),
      tool("one", { _meta: { [MARK]: 1 } }),
      tool("nil", { _meta: { [MARK]: null } }),
      tool("f", { _meta: { [MARK]: false } }),
      tool("other", { _meta: { other: true } }),
      tool("plain"),
      tool("gone", { _meta: { [MARK]: true } })
    ]])
  const marked = await loaded([server("s", definitions(), { marked: true, tools: { gone: "deny" } })])
  expect(flags(marked)).toEqual([["s.f", "none"], ["s.nil", true], ["s.one", true], ["s.other", "none"], ["s.plain", "none"], ["s.t", true], ["s.y", true]])
  expect(marked.refused).toEqual([])
  // Without marked, the same definitions: no tool is gated.
  const unmarked = await loaded([server("s", definitions(), { tools: { gone: "deny" } })])
  expect(flags(unmarked)).toEqual([["s.f", "none"], ["s.nil", "none"], ["s.one", "none"], ["s.other", "none"], ["s.plain", "none"], ["s.t", "none"], ["s.y", "none"]])
  expect(unmarked.refused).toEqual([])
  const off = await loaded([server("s", definitions(), { marked: false })])
  expect(flags(off).filter(([, flag]) => flag !== "none")).toEqual([])
  // ask with a mark of false: the setting still gates it.
  const asked = await loaded([server("s", served([[tool("f", { _meta: { [MARK]: false } })]]), { marked: true, approval: "ask" })])
  expect(flags(asked)).toEqual([["s.f", true]])
})

// The bounds
// ----------

// The characters of one function's rendered declaration.
const size = (declaration: Declaration) =>
  renderDeclarations({ globals: [{ ...globalOf(declaration), execute: () => undefined }] }).length

test("the count: at most `count` functions, in the list's order; the rest are refused", async () => {
  const got = await loaded([server("s", served([[tool("c"), tool("a"), tool("b"), tool("d")]]))], { count: 2 })
  expect(names(got)).toEqual(["s.a", "s.b"])
  expect(got.refused).toEqual([
    { server: "s", tool: "c", reason: "It is past the first 2 functions from outside." },
    { server: "s", tool: "d", reason: "It is past the first 2 functions from outside." }
  ])
})

test("the budget: at most `budget` characters of the rendered declarations together; from the first past it, all are refused", async () => {
  const all = await loaded([server("s", served([[tool("a"), tool("b"), tool("c")]]))])
  const sizes = all.declarations.map(size)
  expect(new Set(sizes).size).toBe(1)
  const budget = sizes[0]! * 2 + sizes[0]! - 1
  const got = await loaded([server("s", served([[tool("a"), tool("b"), tool("c")]]))], { budget })
  expect(names(got)).toEqual(["s.a", "s.b"])
  expect(got.refused).toEqual([{
    server: "s",
    tool: "c",
    reason: `Its declaration would pass the ${budget} characters of the declarations of the functions from outside.`
  }])
  expect(DEFAULTS).toEqual({ load: 10_000, call: 60_000, tools: 256, count: 100, budget: 32_768, max: 1_048_576, hard: 64 * 1024 * 1024, work: 100_000_000 })
})

// The log
// -------

test("each refusal is a warning of the log with the source mcp, and no text of the transport", async () => {
  const broken: Server = {
    name: "broken",
    transport: () => {
      throw new Error("spawn /secret/path ENOENT")
    }
  }
  const got = await loaded([broken, server("s", served([[tool("long", { description: "d".repeat(2000) })]]))])
  expect(got.refused.length).toBe(2)
  const warnings = got.lines.filter((line) => line.level === "WARN")
  expect(warnings.map((line) => line.annotations.source)).toEqual(["mcp", "mcp"])
  expect(warnings.map((line) => String(line.message))).toEqual([
    "A function from outside is refused: server \"broken\": Its transport could not be made.",
    "A function from outside is refused: server \"s\", tool \"long\": Its description is not a text of at most 1024 characters."
  ])
  expect(JSON.stringify(got.lines)).not.toContain("/secret/path")
})

test("ec-egsmp 2: a refused tool's name shows its control characters (C0, DEL, C1, U+2028, U+2029) as \\u and four hex digits, in the refusal and the log; a long name is cut first", async () => {
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
  const odd = "a\u001b[31m\r\n\u0000\t\u007f\u0080\u0085\u009f\u2028\u2029\\b"
  const long = "x".repeat(127) + "\n" + "y".repeat(10)
  const got = await loaded([server("s", served([[tool(odd), tool(long), GOOD]]))])
  expect(names(got)).toEqual(["s.good"])
  const WHY = "Its name does not fit ^[A-Za-z0-9_.-]{1,128}$."
  const shownOdd = "a\\u001b[31m\\u000d\\u000a\\u0000\\u0009\\u007f\\u0080\\u0085\\u009f\\u2028\\u2029\\b"
  const shownLong = "x".repeat(127) + "\\u000a…"
  expect(got.refused).toEqual([{ server: "s", tool: shownOdd, reason: WHY }, { server: "s", tool: shownLong, reason: WHY }])
  const warnings = got.lines.filter((line) => line.level === "WARN").map((line) => String(line.message))
  expect(warnings).toEqual([
    `A function from outside is refused: server "s", tool "${shownOdd}": ${WHY}`,
    `A function from outside is refused: server "s", tool "${shownLong}": ${WHY}`
  ])
  for (const one of [...got.refused.map((refusal) => refusal.tool!), ...warnings]) expect(CONTROL.test(one)).toBe(false)
})

// The call
// --------

// A server's answer to one call: the tool's own name, the arguments, and
// the request's signal (aborted when the client cancels it).
type Answer = (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

// A server of the protocol's version with one page of `tools`, whose calls
// `answer` answers; `calls` holds each call's tool and arguments, in order.
const answering = (tools: ReadonlyArray<Definition>, answer: Answer) => {
  const calls: Array<[string, unknown]> = []
  const sides: Array<Transport> = []
  const fake: Fake = {
    transport: () => {
      const [client, server] = InMemoryTransport.createLinkedPair()
      sides.push(server)
      serveStdio(() => {
        const low = new Low({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } })
        low.setRequestHandler("tools/list", async () => ({ tools }) as never)
        low.setRequestHandler("tools/call", async (request, ctx) => {
          const params = request.params as { name: string; arguments?: Record<string, unknown> }
          calls.push([params.name, params.arguments])
          return (await answer(params.name, params.arguments ?? {}, ctx.mcpReq.signal)) as never
        })
        return low as never
      }, { transport: server })
      return client
    },
    closes: () => 0
  }
  // The server's side ends: the connection is gone.
  const drop = () => Promise.all(sides.map((side) => side.close()))
  return { fake, calls, drop }
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] })

// The load of one server "s" and `body` with its entries by tool, in one
// scope: the connections live until `body` has ended.
const withEntries = <A>(
  fake: Fake,
  options: Partial<Options>,
  body: (entries: Record<string, Outside>, got: Loaded) => Promise<A>
) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const got = yield* load([server("s", fake)], { beside: HOSTED, ...options })
    const entries = Object.fromEntries(got.entries.map((one) => [one.tool, one]))
    return yield* Effect.promise(() => body(entries, got))
  })).pipe(Effect.provide(Logger.layer([]))))

// A run of an entry as the call `call` of a program: its value, or its
// error's message.
const run = async (entry: Outside, args: ReadonlyArray<unknown>, call = 7) => {
  const got = await Effect.runPromise(Effect.result(entry.run(args, { turn: 1, program: 1, call })))
  return got._tag === "Success" ? { value: got.success } : { error: (got.failure as FunctionError).message }
}

const SUM = { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] }
const PAIR = { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false }

test("a call with good arguments gives the structured object", async () => {
  const { fake, calls } = answering([tool("add", { inputSchema: PAIR, outputSchema: SUM })], async (_, args) => {
    const sum = (args.a as number) + (args.b as number)
    return { content: [{ type: "text", text: String(sum) }], structuredContent: { sum } }
  })
  await withEntries(fake, {}, async (entries) => {
    expect(await run(entries.add!, [{ a: 2, b: 3 }])).toEqual({ value: { sum: 5 } })
  })
  expect(calls).toEqual([["add", { a: 2, b: 3 }]])
})

test("a tool with no outputSchema gives its text parts, one line each", async () => {
  const { fake } = answering([tool("say")], async () => ({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }))
  await withEntries(fake, {}, async (entries) => {
    expect(await run(entries.say!, [{ a: 1 }])).toEqual({ value: "one\ntwo" })
  })
})

test("wrong arguments are refused with each fault's path, and the server saw no call", async () => {
  const { fake, calls } = answering([tool("add", { inputSchema: PAIR })], async () => text("never"))
  await withEntries(fake, {}, async (entries) => {
    const add = entries.add!
    expect(await run(add, [{ a: "2", b: 3 }])).toEqual({ error: "Wrong arguments of s.add: /a: expected number, got string." })
    expect(await run(add, [{ a: 2 }])).toEqual({ error: "Wrong arguments of s.add: /b: missing." })
    expect(await run(add, [{ a: 2, b: 3, c: 4 }])).toEqual({ error: "Wrong arguments of s.add: /c: unknown field." })
    // No coercion: a numeric text is no number.
    expect((await run(add, [{ a: 1, b: "3" }])).error).toContain("/b: expected number")
    expect((await run(add, ["text"])).error).toContain("Wrong arguments of s.add: /: ")
    expect(await run(add, [{ a: 1, b: 2 }, { a: 1 }])).toEqual({ error: "Wrong arguments of s.add: it takes one object, and was given 2 arguments." })
  })
  expect(calls).toEqual([])
})

test("a result with isError is an error with the server's text", async () => {
  const { fake } = answering([tool("fail")], async () => ({ isError: true, content: [{ type: "text", text: "the disk is full" }] }))
  await withEntries(fake, {}, async (entries) => {
    expect(await run(entries.fail!, [{ a: 1 }])).toEqual({ error: "s.fail: the server gave an error: the disk is full" })
  })
})

test("an unknown tool: the server's refusal of the protocol is an error with its text", async () => {
  const { fake } = answering([tool("gone")], async (name) => {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Tool " + name + " not found")
  })
  await withEntries(fake, {}, async (entries) => {
    const got = await run(entries.gone!, [{ a: 1 }])
    expect(got.error).toStartWith("s.gone: the call was refused (")
    expect(got.error).toContain("Tool gone not found")
  })
})

test("a structured result that does not fit its schema is an error: through the client", async () => {
  const { fake } = answering([tool("add", { outputSchema: SUM }), tool("none", { outputSchema: SUM })], async (name) =>
    name === "add" ? { content: [], structuredContent: { sum: "five" } } : text("no object"))
  await withEntries(fake, {}, async (entries) => {
    // The SDK's own check takes every value (S6): the sentence is EverChat's.
    const wrong = await run(entries.add!, [{ a: 1 }])
    expect(wrong.error).toBe("s.add: its result does not fit its output schema: /sum: expected number, got string.")
    const none = await run(entries.none!, [{ a: 1 }])
    expect(none.error).toStartWith("s.none: ")
  })
})

test("a structured result that does not fit its schema is an error: on EverChat's check alone", async () => {
  const output = checked(SUM, "output")
  const check = (structuredContent: unknown) =>
    Effect.runPromise(Effect.result(resultOf("s.add", "s", output, { content: [], structuredContent } as never, 7, { max: 1000, hard: 4000, work: WORK })))
  const wrong = await check({ sum: "five" })
  expect(wrong._tag === "Failure" && wrong.failure.message).toBe("s.add: its result does not fit its output schema: /sum: expected number, got string.")
  const missing = await check(undefined)
  expect(missing._tag === "Failure" && missing.failure.message).toBe(
    "s.add: its result has no structured content, and its definition has an output schema."
  )
  const good = await check({ sum: 5 })
  expect(good._tag === "Success" && good.success).toEqual({ sum: 5 })
})

test("a call past its time fails, and the next call on the connection answers", async () => {
  const { fake } = answering([tool("slow"), tool("quick")], (name, _, signal) =>
    name === "slow"
      ? new Promise((resolve) => {
        const timer = setTimeout(() => resolve(text("late")), 5_000)
        signal.addEventListener("abort", () => clearTimeout(timer))
      })
      : Promise.resolve(text("here")))
  await withEntries(fake, { call: 200 }, async (entries) => {
    const started = Date.now()
    const slow = await run(entries.slow!, [{ a: 1 }])
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(slow.error).toStartWith("s.slow: no answer in 200 ms (")
    expect(await run(entries.quick!, [{ a: 1 }])).toEqual({ value: "here" })
  })
})

test("a call whose effect is interrupted ends at once, and the server sees the request cancelled", async () => {
  let started!: () => void
  const begun = new Promise<void>((resolve) => (started = resolve))
  let cancelled!: () => void
  const aborted = new Promise<void>((resolve) => (cancelled = resolve))
  const { fake } = answering([tool("hang")], (_, __, signal) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        cancelled()
        resolve(text("cancelled"))
      })
      started()
    }))
  await withEntries(fake, {}, async (entries) => {
    const fiber = Effect.runFork(entries.hang!.run([{ a: 1 }], { turn: 1, program: 1, call: 7 }))
    await begun
    const at = Date.now()
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(Date.now() - at).toBeLessThan(1_000)
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("the server saw no cancel")), 2_000))])
  })
})

test("a connection that is gone: the error names the server", async () => {
  const { fake, drop } = answering([tool("echo")], async () => text("here"))
  await withEntries(fake, {}, async (entries) => {
    expect(await run(entries.echo!, [{ a: 1 }])).toEqual({ value: "here" })
    await drop()
    const got = await run(entries.echo!, [{ a: 1 }])
    expect(got.error).toStartWith('s.echo: the server "s" is not connected (')
  })
})

// A value nested `n` deep, `{ a: { a: ... {} } }`, made with no recursion.
const nested = (n: number): Record<string, unknown> => {
  let value: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) value = { a: value }
  return value
}

test("ec-egsmp 1: a structured result nested too deep is a FunctionError that names the server, through the client and on resultOf alone; a throw that is no RangeError stays a defect", async () => {
  const DEEP = 's.deep: the server "s" gave a result nested too deep for EverChat\'s check.'
  const deep = nested(1_000_000)
  const { fake } = answering([tool("deep", { outputSchema: { type: "object" } }), tool("fine", { outputSchema: { type: "object" } })], async (name) =>
    ({ content: [], structuredContent: name === "deep" ? deep : nested(3) }))
  await withEntries(fake, {}, async (entries) => {
    expect(await run(entries.deep!, [{ a: 1 }])).toEqual({ error: DEEP })
    expect(await run(entries.fine!, [{ a: 1 }])).toEqual({ value: nested(3) })
  })
  const limits = { max: 1000, hard: 4000, work: WORK }
  const output = checked({ type: "object" }, "output")
  const result = (structuredContent: unknown, form: Checked = output) =>
    Effect.runPromiseExit(resultOf("s.deep", "s", form, { content: [], structuredContent } as never, 7, limits))
  // The JSON text overflows.
  const text = await result(deep)
  expect(Exit.isFailure(text) && text.cause.reasons.map((reason) => (reason._tag === "Fail" ? (reason.error as FunctionError).message : reason._tag))).toEqual([DEEP])
  // The check overflows.
  // The form's check, with its `check` throwing `error`.
  const thrown = (error: Error): Checked => {
    const check = (_value: unknown): _value is unknown => {
      throw error
    }
    return { ...output, validator: Object.assign(Object.create(output.validator) as Checked["validator"], { check }) }
  }
  const check = await result({ a: 1 }, thrown(new RangeError("Maximum call stack size exceeded.")))
  expect(Exit.isFailure(check) && check.cause.reasons.map((reason) => (reason._tag === "Fail" ? (reason.error as FunctionError).message : reason._tag))).toEqual([DEEP])
  // Another throw of the check is not caught: a defect, as before.
  const other = await result({ a: 1 }, thrown(new TypeError("not a stack's end")))
  expect(Exit.isFailure(other) && other.cause.reasons.map((reason) => reason._tag)).toEqual(["Die"])
})

test("ec-egsmp 4: a call whose cause has a null prototype gives the ordinary sentence of a failed call, not a defect, and the next call answers", async () => {
  const { fake } = answering([tool("echo")], async () => text("here"))
  let poison = false
  const wrapped: Fake = {
    transport: () => {
      const side = fake.transport()
      const send = side.send.bind(side)
      side.send = async (message, options) => {
        if (poison && (message as { method?: unknown }).method === "tools/call") {
          poison = false
          throw Object.create(null)
        }
        return send(message, options)
      }
      return side
    },
    closes: () => 0
  }
  await withEntries(wrapped, {}, async (entries) => {
    expect(await run(entries.echo!, [{ a: 1 }])).toEqual({ value: "here" })
    poison = true
    expect(await run(entries.echo!, [{ a: 1 }])).toEqual({ error: "s.echo: the call failed (an error with no text)." })
    expect(await run(entries.echo!, [{ a: 1 }])).toEqual({ value: "here" })
  })
})

test("two calls at one time on one connection: each waits for the other to start", async () => {
  let arrived = 0
  let both!: () => void
  const met = new Promise<void>((resolve) => (both = resolve))
  const { fake } = answering([tool("meet")], async (_, args) => {
    arrived++
    if (arrived === 2) both()
    await met
    return text("met " + String(args.a))
  })
  await withEntries(fake, { call: 3_000 }, async (entries) => {
    const got = await Promise.all([run(entries.meet!, [{ a: 1 }]), run(entries.meet!, [{ a: 2 }])])
    expect(got).toEqual([{ value: "met 1" }, { value: "met 2" }])
  })
})

test("the cap: a text of exactly max characters comes whole; a longer one is a Shortened, the entry's whole value, whose whole is the text and whose given has the head, the line of result(<call>, from, to) and the tail", async () => {
  const exact = "a".repeat(2_000)
  const long = "H".repeat(1_500) + "m".repeat(5_000) + "T".repeat(1_500)
  const { fake } = answering([tool("exact"), tool("long")], async (name) => text(name === "exact" ? exact : long))
  await withEntries(fake, { max: 2_000 }, async (entries) => {
    expect(await run(entries.exact!, [{ a: 1 }])).toEqual({ value: exact })
    const got = (await run(entries.long!, [{ a: 1 }], 9)).value
    // The whole value is the Shortened, never a part of one: the call's row
    // keeps `whole` (calls.ts), and the program gets `given`.
    expect(got).toBeInstanceOf(Shortened)
    const short = got as Shortened
    expect(short.whole).toBe(long)
    expect(short.given).toBe(given(9, long, 2_000))
    expect(short.given).toStartWith("H".repeat(1_000) + "\n[... ")
    expect(short.given).toEndWith(" ...]\n" + "T".repeat(488))
    expect(short.given).toContain("characters left out. result(9, from, to) gives a part of the whole result to a program.")
    expect(short.given.length).toBeLessThan(long.length)
  })
})

test("the cap: a structured result over max is a Shortened on its JSON text", async () => {
  const LIST = { type: "object", properties: { rows: { type: "array", items: { type: "string" } } }, required: ["rows"] }
  const rows = Array.from({ length: 200 }, (_, k) => "row " + k)
  const { fake } = answering([tool("rows", { outputSchema: LIST })], async () => ({ content: [], structuredContent: { rows } }))
  await withEntries(fake, { max: 1_000 }, async (entries) => {
    const got = (await run(entries.rows!, [{ a: 1 }], 4)).value
    expect(got).toBeInstanceOf(Shortened)
    const json = JSON.stringify({ rows })
    expect((got as Shortened).whole).toBe(json)
    expect(json.length).toBeGreaterThan(1_000)
    expect((got as Shortened).given).toBe(given(4, json, 1_000))
  })
})

test("a text over the bound in bytes is refused with its size, though it is under max in characters", async () => {
  const { fake } = answering([tool("big"), tool("fits")], async (name) => text(name === "big" ? "é".repeat(26) : "é".repeat(25)))
  await withEntries(fake, { hard: 50, max: 1000 }, async (entries) => {
    expect(await run(entries.big!, [{ a: 1 }])).toEqual({ error: "s.big: its result is 52 bytes, over the bound of 50 bytes: it is refused." })
    expect(await run(entries.fits!, [{ a: 1 }])).toEqual({ value: "é".repeat(25) })
  })
})

test("a part that is no text is one line that names its kind and its type, without its data", async () => {
  const { fake } = answering([tool("mixed")], async () => ({
    content: [
      { type: "text", text: "before" },
      { type: "image", data: "SU1BR0VEQVRB", mimeType: "image/png" },
      { type: "audio", data: "QVVESU9EQVRB", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///x", mimeType: "text/plain", text: "SECRET TEXT" } },
      { type: "text", text: "after" }
    ]
  }))
  await withEntries(fake, {}, async (entries) => {
    const got = (await run(entries.mixed!, [{ a: 1 }])).value as string
    expect(got).toBe([
      "before",
      "[a part of the kind image, of the type image/png, not shown]",
      "[a part of the kind audio, of the type audio/wav, not shown]",
      "[a part of the kind resource, of the type text/plain, not shown]",
      "after"
    ].join("\n"))
    expect(got).not.toContain("SU1B")
    expect(got).not.toContain("SECRET")
  })
})

// The bounds of an error's text from outside
// -------------------------------------------

test("an isError text over hard: the message has its size and the bound, and no character of the text", async () => {
  const { fake } = answering([tool("fail")], async () => ({ isError: true, content: [{ type: "text", text: "q".repeat(60) }] }))
  await withEntries(fake, { hard: 50, max: 1000 }, async (entries) => {
    const got = await run(entries.fail!, [{ a: 1 }])
    expect(got).toEqual({ error: "s.fail: the server gave an error: [a text of 60 bytes, over the bound of 50 bytes, not shown]" })
    expect(got.error).not.toContain("q")
  })
})

test("an isError text over max and under hard: its first max characters, the whole count, and not the character at max + 1", async () => {
  const { fake } = answering([tool("fail"), tool("fits")], async (name) => ({
    isError: true,
    content: [{ type: "text", text: name === "fail" ? "a".repeat(20) + "Z" + "b".repeat(9) : "a".repeat(19) + "Z" }]
  }))
  await withEntries(fake, { hard: 1000, max: 20 }, async (entries) => {
    const got = await run(entries.fail!, [{ a: 1 }])
    expect(got).toEqual({
      error: "s.fail: the server gave an error: " + "a".repeat(20) + "… [the text was cut: its first 20 characters are shown, of 30 characters]"
    })
    expect(got.error).not.toContain("Z")
    // Exactly max characters: whole.
    expect(await run(entries.fits!, [{ a: 1 }])).toEqual({ error: "s.fits: the server gave an error: " + "a".repeat(19) + "Z" })
  })
})

test("a protocol error's message over each bound: over hard, its size only; over max, its first max characters and the whole count", async () => {
  const { fake } = answering([tool("gone")], async () => {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Tool gone not found " + "q".repeat(200) + "Z")
  })
  await withEntries(fake, { hard: 100, max: 1000 }, async (entries) => {
    const got = (await run(entries.gone!, [{ a: 1 }])).error!
    expect(got).toMatch(/^s\.gone: the call was refused \(\[a text of \d+ bytes, over the bound of 100 bytes, not shown\]\)\.$/)
    expect(got).not.toContain("q")
    expect(got).not.toContain("Tool gone")
  })
  await withEntries(fake, { hard: 1000, max: 40 }, async (entries) => {
    const got = (await run(entries.gone!, [{ a: 1 }])).error!
    const shown = /^s\.gone: the call was refused \((.*)… \[the text was cut: its first 40 characters are shown, of (\d+) characters\]\)\.$/.exec(got)
    expect(shown).not.toBeNull()
    expect(shown![1]!.length).toBe(40)
    expect(shown![1]).toContain("Tool gone not found")
    expect(Number(shown![2])).toBeGreaterThan(220)
    expect(got).not.toContain("Z")
  })
})

// The faults of `n` items of an array of numbers given texts, joined.
const itemFaults = (path: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${path}/${i}: expected number, got string`).join("; ")

test("a result with more wrong items than fit: the message is bounded, and gives the count of the faults", async () => {
  const output = checked({ type: "object", properties: { items: { type: "array", items: { type: "number" } } } }, "output")
  const check = (structuredContent: unknown, limits: { max: number; hard: number }) =>
    Effect.runPromise(Effect.result(resultOf("s.add", "s", output, { content: [], structuredContent } as never, 7, { ...limits, work: WORK })))
  const many = { items: Array.from({ length: 100_000 }, () => "x") }
  const cut = await check(many, { max: 200, hard: 4000 })
  expect(cut._tag === "Failure" && cut.failure.message).toBe(
    "s.add: its result does not fit its output schema: " + itemFaults("/items", 100_000).slice(0, 200) +
      "… [the text was cut: its first 200 characters are shown, of the list of 100000 faults in all]."
  )
  const over = await check(many, { max: 1000, hard: 100 })
  expect(over._tag === "Failure" && over.failure.message).toMatch(
    /^s\.add: its result does not fit its output schema: \[a text of \d+ bytes, over the bound of 100 bytes, not shown; 100000 faults in all\]\.$/
  )
  // Under the bounds: whole, as before.
  const few = await check({ items: ["x", "y"] }, { max: 200, hard: 4000 })
  expect(few._tag === "Failure" && few.failure.message).toBe(
    "s.add: its result does not fit its output schema: " + itemFaults("/items", 2) + "."
  )
})

test("wrong arguments with more faults than fit: bounded, with the count of the faults, and the server saw no call", async () => {
  const LIST = { type: "object", properties: { xs: { type: "array", items: { type: "number" } } }, required: ["xs"] }
  const { fake, calls } = answering([tool("sum", { inputSchema: LIST })], async () => text("never"))
  await withEntries(fake, { max: 100, hard: 4000 }, async (entries) => {
    const got = await run(entries.sum!, [{ xs: Array.from({ length: 10_000 }, () => "x") }])
    expect(got).toEqual({
      error: "Wrong arguments of s.sum: " + itemFaults("/xs", 10_000).slice(0, 100) +
        "… [the text was cut: its first 100 characters are shown, of the list of 10000 faults in all]."
    })
  })
  expect(calls).toEqual([])
})

// The form of a schema
// --------------------
// EverChat checks a value only against a form of the schema that it made
// itself (client.ts, "The form of a schema"). Each refusal is proved by its
// sentence, and an unchecked keyword by what happens: the call was sent, or
// the value came. No case here spins: a form that would is refused at the
// load.

// The good tool beside each refused one: it loads and answers a call.
const GOOD = tool("good")

// A server of `tools` whose calls answer `ok`, or the structured content
// that `structured` gives.
const echoing = (tools: ReadonlyArray<Definition>, structured?: (tool: string, args: Record<string, unknown>) => unknown) =>
  answering(tools, async (name, args) =>
    structured === undefined ? text("ok") : { content: [{ type: "text", text: "ok" }], structuredContent: structured(name, args) })

// The seven cycles of ec-b2xg6: none has a step into the value.
const CYCLES: ReadonlyArray<readonly [string, Definition, (which: Which) => string]> = [
  ["root", { type: "object", $ref: "#" }, ITSELF],
  ["allof", { type: "object", allOf: [{ $ref: "#" }] }, ITSELF],
  ["defs", { type: "object", $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } }, ITSELF],
  ["prop", { type: "object", properties: { x: { $ref: "#/$defs/a" } }, $defs: { a: { $ref: "#/$defs/a" } } }, ITSELF],
  ["dynamic", { type: "object", $dynamicRef: "#" }, REFERENCE],
  ["anchor", { type: "object", $anchor: "top", $ref: "#top" }, REFERENCE],
  ["id", { $id: "https://x.test/s", type: "object", $ref: "https://x.test/s" }, REFERENCE]
]

test("each of the seven cycles as an input schema, and one as an output schema: that tool is refused, and a second tool of the server loads and answers a call", async () => {
  const tools = [
    ...CYCLES.map(([name, schema]) => tool(name, { inputSchema: schema })),
    tool("output", { outputSchema: CYCLES[2]![1] }),
    GOOD
  ]
  const { fake, calls } = echoing(tools)
  await withEntries(fake, {}, async (entries, got) => {
    expect(names(got)).toEqual(["s.good"])
    for (const [name, , sentence] of CYCLES) expect(reasons(got, name)).toEqual([sentence("input")])
    expect(reasons(got, "output")).toEqual([ITSELF("output")])
    expect(await run(entries.good!, [{ a: 1 }])).toEqual({ value: "ok" })
  })
  expect(calls).toEqual([["good", { a: 1 }]])
})

test("30 $defs, each an allOf of two references to the next (no cycle, 2^30 copies): refused by the size of the form", async () => {
  const defs: Record<string, unknown> = { n30: { type: "object" } }
  for (let i = 0; i < 30; i++) defs["n" + i] = { allOf: [{ $ref: "#/$defs/n" + (i + 1) }, { $ref: "#/$defs/n" + (i + 1) }] }
  const got = await loaded([server("s", served([[tool("fan", { inputSchema: { type: "object", $ref: "#/$defs/n0", $defs: defs } }), GOOD]]))])
  expect(names(got)).toEqual(["s.good"])
  expect(reasons(got, "fan")).toEqual([LARGE("input")])
})

test("a tree (items that names the root) is refused as a schema that holds itself", async () => {
  const tree = { type: "object", properties: { kids: { type: "array", items: { $ref: "#" } } } }
  const got = await loaded([server("s", served([[tool("tree", { inputSchema: tree }), GOOD]]))])
  expect(names(got)).toEqual(["s.good"])
  expect(reasons(got, "tree")).toEqual([ITSELF("input")])
})

test("a schema deeper than the walk's stack is refused, not a defect", () => {
  let deep: unknown = { type: "number" }
  for (let i = 0; i < 60_000; i++) deep = { not: deep }
  const got = checkOf({ type: "object", properties: { a: deep } }, "input")
  expect(got).toBe(LARGE("input"))
})

test("a $ref with keywords beside it: the target and the keywords beside both hold; one $defs member at two places; a $ref to #/properties/a; a pointer with ~1, ~0 and a percent escape", async () => {
  const schema = {
    type: "object",
    properties: {
      n: { $ref: "#/$defs/small", minimum: 2 },
      a: { $ref: "#/$defs/number" },
      b: { $ref: "#/$defs/number" },
      c: { $ref: "#/properties/a" },
      d: { $ref: "#/$defs/x~1y" },
      e: { $ref: "#/$defs/x~0y" },
      f: { $ref: "#/$defs/x%20y" }
    },
    $defs: { small: { type: "number", maximum: 10 }, number: { type: "number" }, "x/y": { type: "string" }, "x~y": { type: "boolean" }, "x y": { type: "integer" } }
  }
  const { fake, calls } = echoing([tool("ref", { inputSchema: schema })])
  await withEntries(fake, {}, async (entries) => {
    const ref = entries.ref!
    expect(await run(ref, [{ n: 11 }])).toEqual({ error: "Wrong arguments of s.ref: /n: expected <= 10." })
    expect(await run(ref, [{ n: 1 }])).toEqual({ error: "Wrong arguments of s.ref: /n: expected >= 2." })
    expect((await run(ref, [{ a: "x" }])).error).toContain("/a: expected number")
    expect((await run(ref, [{ b: "x" }])).error).toContain("/b: expected number")
    expect((await run(ref, [{ c: "x" }])).error).toContain("/c: expected number")
    expect((await run(ref, [{ d: 1 }])).error).toContain("/d: expected string")
    expect((await run(ref, [{ e: 1 }])).error).toContain("/e: expected boolean")
    expect((await run(ref, [{ f: 1.5 }])).error).toContain("/f: expected integer")
    expect(await run(ref, [{ n: 5, a: 1, b: 2, c: 3, d: "x", e: true, f: 4 }])).toEqual({ value: "ok" })
    // The form holds no reference: the target's copy joins the keywords beside it.
    expect(ref.form.input).toEqual({
      type: "object",
      properties: {
        n: { minimum: 2, allOf: [{ type: "number", maximum: 10 }] },
        a: { type: "number" },
        b: { type: "number" },
        c: { type: "number" },
        d: { type: "string" },
        e: { type: "boolean" },
        f: { type: "integer" }
      }
    })
  })
  expect(calls).toEqual([["ref", { n: 5, a: 1, b: 2, c: 3, d: "x", e: true, f: 4 }]])
})

test("a pointer that names nothing, or no schema, is a reference that EverChat does not follow", async () => {
  const got = await loaded([server("s", served([[
    tool("nothing", { inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/none" } } } }),
    tool("data", { inputSchema: { type: "object", properties: { a: { $ref: "#/required" } }, required: ["a"] } }),
    tool("index", { inputSchema: { type: "object", properties: { a: { $ref: "#/allOf/01" } }, allOf: [true, true] } }),
    GOOD
  ]]))])
  expect(names(got)).toEqual(["s.good"])
  for (const name of ["nothing", "data", "index"]) expect(reasons(got, name)).toEqual([REFERENCE("input")])
})

test("data is not followed: an enum member {$ref: '#'} loads and is a good value; a property named $ref, pattern or patternProperties is a name", async () => {
  const schema = {
    type: "object",
    properties: {
      v: { enum: [{ $ref: "#" }, 1] },
      $ref: { type: "string" },
      pattern: { type: "number" },
      patternProperties: { type: "boolean" }
    }
  }
  const { fake, calls } = echoing([tool("data", { inputSchema: schema })])
  await withEntries(fake, {}, async (entries) => {
    const data = entries.data!
    expect(await run(data, [{ v: { $ref: "#" } }])).toEqual({ value: "ok" })
    expect((await run(data, [{ v: 2 }])).error).toContain("/v: ")
    expect(await run(data, [{ $ref: "x", pattern: 1, patternProperties: true }])).toEqual({ value: "ok" })
    expect((await run(data, [{ $ref: 1 }])).error).toContain("/$ref: expected string")
    expect((await run(data, [{ pattern: "x" }])).error).toContain("/pattern: expected number")
  })
  expect(calls).toEqual([["data", { v: { $ref: "#" } }], ["data", { $ref: "x", pattern: 1, patternProperties: true }]])
})

test("pattern and uniqueItems are not checked: a text that does not match and a list with two equal items are sent; a result whose text does not match its output schema's pattern comes (the SDK checks nothing either)", async () => {
  const input = { type: "object", properties: { s: { type: "string", pattern: "^a+$" }, list: { type: "array", uniqueItems: true } } }
  const output = { type: "object", properties: { s: { type: "string", pattern: "^a+$" } } }
  const { fake, calls } = echoing([tool("loose", { inputSchema: input, outputSchema: output })], () => ({ s: "zzz" }))
  await withEntries(fake, {}, async (entries) => {
    expect(await run(entries.loose!, [{ s: "zzz", list: [1, 1] }])).toEqual({ value: { s: "zzz" } })
    // The type beside it is still checked.
    expect((await run(entries.loose!, [{ s: 1 }])).error).toContain("/s: expected string")
    expect(entries.loose!.form).toEqual({ input: { type: "object", properties: { s: { type: "string" }, list: { type: "array" } } }, output: { type: "object", properties: { s: { type: "string" } } } })
  })
  expect(calls).toEqual([["loose", { s: "zzz", list: [1, 1] }]])
})

test("pattern or uniqueItems below not, if, oneOf or a contains with maxContains is refused; patternProperties is refused; below then, else, allOf, anyOf it loads", async () => {
  const string = { type: "string", pattern: "^a$" }
  const got = await loaded([server("s", served([[
    tool("not", { inputSchema: { type: "object", properties: { a: { not: string } } } }),
    tool("if", { inputSchema: { type: "object", if: { properties: { a: string } }, then: { required: ["b"] } } }),
    tool("oneof", { inputSchema: { type: "object", properties: { a: { oneOf: [{ type: "number" }, { type: "array", uniqueItems: true }] } } } }),
    tool("contains", { inputSchema: { type: "object", properties: { a: { type: "array", contains: string, maxContains: 1 } } } }),
    tool("deep", { inputSchema: { type: "object", properties: { a: { not: { properties: { b: { allOf: [{ $ref: "#/$defs/p" }] } } } } }, $defs: { p: string } } }),
    tool("patterned", { inputSchema: { type: "object", patternProperties: { "^x": { type: "number" } } } }),
    tool("fine", {
      inputSchema: {
        type: "object",
        properties: { a: { allOf: [string], anyOf: [string, { type: "number" }] }, b: { type: "array", contains: string, minContains: 1 } },
        if: { required: ["a"] },
        then: { properties: { a: string } },
        else: { properties: { b: { uniqueItems: true } } }
      }
    }),
    GOOD
  ]]))])
  expect(names(got)).toEqual(["s.fine", "s.good"])
  expect(reasons(got, "not")).toEqual([BELOW("input", "pattern", "not")])
  expect(reasons(got, "if")).toEqual([BELOW("input", "pattern", "if")])
  expect(reasons(got, "oneof")).toEqual([BELOW("input", "uniqueItems", "oneOf")])
  expect(reasons(got, "contains")).toEqual([BELOW("input", "pattern", "contains")])
  expect(reasons(got, "deep")).toEqual([BELOW("input", "pattern", "not")])
  expect(reasons(got, "patterned")).toEqual([PATTERN_PROPERTIES("input")])
})

test("ec-egsmp 5: below not, if or oneOf, a list of items, additionalItems, dependencies and a required with an entry that is no text refuse the tool; elsewhere, or when they assert nothing, they are left out and the tool loads", async () => {
  const got = await loaded([server("s", served([[
    tool("items", { inputSchema: { type: "object", properties: { a: { not: { type: "array", items: [{ type: "number" }] } } } } }),
    tool("additional", { inputSchema: { type: "object", if: { properties: { a: { additionalItems: false } } }, then: { required: ["b"] } } }),
    tool("dependencies", { inputSchema: { type: "object", properties: { a: { oneOf: [{ type: "number" }, { type: "object", dependencies: { x: ["y"] } }] } } } }),
    tool("required", { inputSchema: { type: "object", properties: { a: { not: { required: ["x", 5] } } } } }),
    tool("deep", { inputSchema: { type: "object", properties: { a: { not: { properties: { b: { allOf: [{ $ref: "#/$defs/d" }] } } } } }, $defs: { d: { dependencies: {} } } } }),
    tool("fine", {
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "array", items: [{ type: "number" }], additionalItems: false },
          b: { dependencies: { x: ["y"] }, required: ["x", 5] },
          c: { not: { type: "string", additionalItems: true, dependencies: 5, required: "x" } }
        }
      }
    }),
    GOOD
  ]]))])
  expect(names(got)).toEqual(["s.fine", "s.good"])
  expect(reasons(got, "items")).toEqual([BELOW("input", "items", "not")])
  expect(reasons(got, "additional")).toEqual([BELOW("input", "additionalItems", "if")])
  expect(reasons(got, "dependencies")).toEqual([BELOW("input", "dependencies", "oneOf")])
  expect(reasons(got, "required")).toEqual([BELOW("input", "required", "not")])
  expect(reasons(got, "deep")).toEqual([BELOW("input", "dependencies", "not")])
  // Out of a guard each is left out, as before.
  expect(got.entries.find((one) => one.tool === "fine")!.form.input).toEqual({
    type: "object",
    properties: { a: { type: "array" }, b: {}, c: { not: { type: "string" } } }
  })
})

test("a place of a schema that holds no schema does not compile; a kept keyword whose value has not its kind is left out", async () => {
  const got = await loaded([server("s", served([[
    tool("not5", { inputSchema: { type: "object", properties: { a: { not: 5 } } } }),
    tool("odd", { inputSchema: { type: "object", required: "a", properties: { a: { minLength: "3", items: [{ type: "number" }] } } } }),
    GOOD
  ]]))])
  expect(names(got)).toEqual(["s.good", "s.odd"])
  expect(reasons(got, "not5")).toEqual([COMPILE("input")])
  expect(got.entries.find((one) => one.tool === "odd")!.form.input).toEqual({ type: "object", properties: { a: {} } })
})

test("the form of a definition is the same text from one load to the next, and holds no $ref, $id, $anchor or $defs", async () => {
  const schema = {
    $id: "https://x.test/s",
    type: "object",
    properties: { z: { $ref: "#/$defs/n", description: "a" }, a: { $anchor: "x", enum: [{ $ref: "#" }] } },
    $defs: { n: { type: "number", minimum: 0, format: "int32" } }
  }
  const once = async () => {
    const got = await loaded([server("s", served([[tool("t", { inputSchema: schema, outputSchema: schema })]]))])
    return JSON.stringify(got.entries[0]!.form)
  }
  const [first, second] = [await once(), await once()]
  expect(second).toBe(first)
  expect(first).toBe(JSON.stringify({
    input: { type: "object", properties: { z: { type: "number", minimum: 0 }, a: { enum: [{ $ref: "#" }] } } },
    output: { type: "object", properties: { z: { type: "number", minimum: 0 }, a: { enum: [{ $ref: "#" }] } } }
  }))
  // The one $ref of the text is data of an enum.
  expect(first.split("$ref").length - 1).toBe(2)
})

// The parts of a JSON value (a key is not one), as the form counts them.
const partsOf = (value: unknown): number =>
  1 + (Array.isArray(value) ? value.reduce((n: number, one) => n + partsOf(one), 0) : typeof value === "object" && value !== null ? Object.values(value).reduce((n: number, one) => n + partsOf(one), 0) : 0)

test("work: arguments over the bound are not checked and not sent; a result over it fails the call; at the bound both pass", async () => {
  // The form of each schema is 2 parts: { type: "object" }. The arguments
  // { a: [1, 2, 3] } are 5 parts; the result adds `extra`: 6 parts.
  const loose = { type: "object" }
  const { fake, calls } = echoing([tool("echo", { inputSchema: loose, outputSchema: loose })], (_, args) => ({ ...args, extra: 1 }))
  const args = { a: [1, 2, 3] }
  expect([partsOf(loose), partsOf(args), partsOf({ ...args, extra: 1 })]).toEqual([2, 5, 6])
  const at = (work: number) => withEntries(fake, { work }, (entries) => run(entries.echo!, [args]))
  expect(await at(12)).toEqual({ value: { a: [1, 2, 3], extra: 1 } })
  expect(await at(11)).toEqual({
    error: "s.echo: its result is not checked: its work (2 parts of the form × 6 of the value + 0 text checks × 6 units of text) is 12 at least, past the bound of 11."
  })
  expect((await at(10)).error).toStartWith("s.echo: its result is not checked: ")
  expect(calls.length).toBe(3)
  expect(await at(9)).toEqual({
    error: "Wrong arguments of s.echo: they are not checked, and nothing is sent: its work (2 parts of the form × 5 of the value + 0 text checks × 1 units of text) is 10 at least, past the bound of 9."
  })
  // The count stops at the bound: a value of a million items is not walked whole.
  expect((await at(9)).error).toStartWith("Wrong arguments of s.echo: they are not checked")
  const huge = await withEntries(fake, { work: 9 }, (entries) => run(entries.echo!, [{ a: Array.from({ length: 1_000_000 }, () => 0) }]))
  expect(huge.error).toContain("× 1000002 of the value")
  expect(calls.length).toBe(3)
})

test("work counts the text checks: many copies of maxLength (through $ref) and a long text are not checked and not sent; the same text through a tool with no text check is sent; a long key under propertyNames with maxLength; a text in an object member of an enum", async () => {
  const long = "x".repeat(1000)
  const copies = { type: "object", properties: { s: { allOf: Array.from({ length: 10 }, () => ({ $ref: "#/$defs/m" })) } }, $defs: { m: { maxLength: 100_000 } } }
  const plain = { type: "object", properties: { s: { type: "string" } } }
  const keys = { type: "object", propertyNames: { maxLength: 100_000 } }
  const pick = { type: "object", properties: { v: { enum: [{ name: "a" }] } } }
  const { fake, calls } = echoing([tool("copies", { inputSchema: copies }), tool("plain", { inputSchema: plain }), tool("keys", { inputSchema: keys }), tool("pick", { inputSchema: pick })])
  await withEntries(fake, { work: 5_000 }, async (entries) => {
    expect(await run(entries.copies!, [{ s: long }])).toEqual({
      error: `Wrong arguments of s.copies: they are not checked, and nothing is sent: its work (${partsOf(entries.copies!.form.input)} parts of the form × 2 of the value + 10 text checks × 1001 units of text) is ${partsOf(entries.copies!.form.input) * 2 + 10_010} at least, past the bound of 5000.`
    })
    expect(await run(entries.copies!, [{ s: "x" }])).toEqual({ value: "ok" })
    expect(await run(entries.plain!, [{ s: long }])).toEqual({ value: "ok" })
    expect((await run(entries.keys!, [{ ["k".repeat(10_000)]: 1 }])).error).toContain("1 text checks × 10000 units of text")
    expect(await run(entries.keys!, [{ k: 1 }])).toEqual({ value: "ok" })
    expect((await run(entries.pick!, [{ v: "y".repeat(3000) }])).error).toContain("2 text checks × 3001 units of text")
    expect(await run(entries.pick!, [{ v: { name: "a" } }])).toEqual({ value: "ok" })
  })
  expect(calls.map(([name]) => name)).toEqual(["copies", "plain", "keys", "pick"])
})

test("the list of faults: a deep form and a deep value that fails at the bottom are refused without it; the same failure in a shallow form has its paths; nested allOf over a flat value too; a result the same ways", async () => {
  let chain: unknown = { type: "number" }
  let value: unknown = "x"
  for (let i = 0; i < 20; i++) {
    chain = { type: "array", items: chain }
    value = [value]
  }
  let nested: unknown = { type: "number" }
  for (let i = 0; i < 20; i++) nested = { allOf: [nested] }
  const deep = { type: "object", properties: { a: chain } }
  const flat = { type: "object", properties: { a: nested } }
  const shallow = { type: "object", properties: { a: { type: "number" } } }
  const results: Record<string, unknown> = { deepout: { a: value }, shallowout: { a: "x" } }
  const { fake, calls } = echoing([
    tool("deep", { inputSchema: deep }),
    tool("flat", { inputSchema: flat }),
    tool("shallow", { inputSchema: shallow }),
    tool("deepout", { outputSchema: deep }),
    tool("shallowout", { outputSchema: shallow })
  ], (name) => results[name])
  await withEntries(fake, { work: 1_000 }, async (entries) => {
    expect((await run(entries.deep!, [{ a: value }])).error).toMatch(
      /^Wrong arguments of s\.deep: they do not fit its input schema; the list of their faults was not made, since its work \(\d+ of the form's size × \d+ of the value's size × 23 levels of the form\) would pass the bound of 1000\.$/
    )
    expect((await run(entries.flat!, [{ a: "x" }])).error).toMatch(/^Wrong arguments of s\.flat: they do not fit its input schema; the list of their faults was not made, since its work \(\d+ of the form's size × \d+ of the value's size × 23 levels of the form\)/)
    expect(await run(entries.shallow!, [{ a: "x" }])).toEqual({ error: "Wrong arguments of s.shallow: /a: expected number, got string." })
    expect((await run(entries.deepout!, [{ a: 1 }])).error).toMatch(
      /^s\.deepout: its result does not fit its output schema; the list of its faults was not made, since its work \(\d+ of the form's size × \d+ of the value's size × 23 levels of the form\) would pass the bound of 1000\.$/
    )
    expect(await run(entries.shallowout!, [{ a: 1 }])).toEqual({ error: "s.shallowout: its result does not fit its output schema: /a: expected number, got string." })
    // With room for the levels, the deep form's faults have their paths.
  })
  expect(calls.map(([name]) => name)).toEqual(["deepout", "shallowout"])
  await withEntries(fake, {}, async (entries) => {
    expect((await run(entries.deep!, [{ a: value }])).error).toBe("Wrong arguments of s.deep: /a" + "/0".repeat(20) + ": expected number, got string.")
  })
})

test("formOf: data and names are copied as data, a key __proto__ too", () => {
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"number"}},"const":{"__proto__":1}}')
  const got = formOf(schema)
  expect("form" in got && JSON.stringify(got.form)).toBe('{"type":"object","const":{"__proto__":1},"properties":{"__proto__":{"type":"number"}}}')
  expect("form" in got && got.texts).toBe(1)
})

// The bounds of the review ec-h5eol (ec-5y29u)
// --------------------------------------------
// G1 to G11 of ec-5y29u: the size of a form, its levels and its pairs, the
// list of faults, the checks under the load's limit, no text of a raw
// definition, a defect as a refusal, the list and the call without the
// SDK's own handling of a server's schema.

// A properties chain `n` levels deep, built with a loop.
const chainOf = (n: number): Definition => {
  let schema: Definition = { type: "number" }
  for (let i = 0; i < n; i++) schema = { type: "object", properties: { a: schema } }
  return schema
}

test("G1: the size of a JSON value is its parts and the units of its texts and keys; it stops past its bound", () => {
  // An object, its key "ab" (2), a text "xyz" (1 + 3), an array, a null.
  expect(sizeOf({ ab: "xyz", c: [null] }, 1_000)).toBe(1 + 2 + 4 + 1 + 1 + 1)
  // A million items: the walk stops just past the bound.
  expect(sizeOf(Array.from({ length: 1_000_000 }, () => 0), 10)).toBe(11)
})

test("finding 1: a form with a long const behind many references is refused at the load by its size, and the server's other tool loads", async () => {
  const long = { type: "object", $defs: { c: { const: "x".repeat(10_000) } }, properties: { a: { allOf: Array.from({ length: 200 }, () => ({ $ref: "#/$defs/c" })) } } }
  const got = await loaded([server("s", served([[tool("long", { inputSchema: long }), GOOD]]))])
  expect(reasons(got, "long")).toEqual([LARGE("input")])
  expect(names(got)).toEqual(["s.good"])
})

test("finding 1: a small form and a long text that fails are refused with no list, under a small work; a short failing value in that form has its paths", async () => {
  const small = { type: "object", properties: { a: { type: "number" } } }
  const { fake, calls } = echoing([tool("small", { inputSchema: small })])
  await withEntries(fake, { work: 20_000 }, async (entries) => {
    expect((await run(entries.small!, [{ a: "z".repeat(5_000) }])).error).toMatch(
      /^Wrong arguments of s\.small: they do not fit its input schema; the list of their faults was not made, since its work \(\d+ of the form's size × 5003 of the value's size × 3 levels of the form\) would pass the bound of 20000\.$/
    )
    expect(await run(entries.small!, [{ a: "x" }])).toEqual({ error: "Wrong arguments of s.small: /a: expected number, got string." })
  })
  expect(calls).toEqual([])
})

test("finding 2, through load: a properties chain 20,000 deep and one 1,000,000 deep each refuse that tool, the server's other tool loads, and the load returns", async () => {
  for (const depth of [20_000, 1_000_000]) {
    const got = await loaded([server("s", served([[tool("deep", { inputSchema: chainOf(depth) }), GOOD]]))])
    expect({ depth, deep: reasons(got, "deep"), names: names(got) }).toEqual({ depth, deep: [LARGE("input")], names: ["s.good"] })
  }
})

test("finding 2: a form of 64 levels loads, of 65 is refused", async () => {
  // The root is level 1, and each `properties` adds one.
  const got = await loaded([server("s", served([[tool("at", { inputSchema: chainOf(63) }), tool("past", { inputSchema: chainOf(64) })]]))])
  expect(names(got)).toEqual(["s.at"])
  expect(reasons(got, "past")).toEqual([LARGE("input")])
})

test("G7 and H11: a default 1,000,000 deep, which once threw while the declaration was made, is left out of the shown schema as a list: that tool loads with no default, the server's other tool loads, and the load returns", async () => {
  let deep: unknown = 1
  for (let i = 0; i < 1_000_000; i++) deep = [deep]
  const schema = { type: "object", properties: { a: { type: "number", default: deep } } }
  const got = await loaded([server("s", served([[tool("deflt", { inputSchema: schema }), GOOD]]))])
  expect(got.refused).toEqual([])
  expect(names(got)).toEqual(["s.deflt", "s.good"])
  expect(got.declarations[0]!.inputSchema).toEqual({ type: "object", properties: { a: { type: "number" } } })
})

test("G6: two definitions with one name are both refused, and the list is the same with the pages in another order", async () => {
  const first = tool("twice", { description: "The first." })
  const second = tool("twice", { description: "The second.", inputSchema: { type: "object" } })
  const one = await loaded([server("s", served([[first, GOOD], [second]]))])
  const other = await loaded([server("s", served([[second], [GOOD, first]]))])
  expect(reasons(one, "twice")).toEqual(["Its name is given more than once by its server.", "Its name is given more than once by its server."])
  expect(names(one)).toEqual(["s.good"])
  expect({ names: names(other), refused: other.refused }).toEqual({ names: names(one), refused: one.refused })
})

test("finding 3: many properties with the same names in required, past PAIRS, are refused; at PAIRS the tool loads", async () => {
  // n properties and the same n names in required: n × n pairs.
  const paired = (n: number) => {
    const keys = Array.from({ length: n }, (_, i) => "p" + i)
    return { type: "object", properties: Object.fromEntries(keys.map((key) => [key, { type: "number" }])), required: keys }
  }
  expect(1_000 * 1_000).toBe(PAIRS)
  const got = await loaded([server("s", served([[tool("at", { inputSchema: paired(1_000) }), tool("past", { inputSchema: paired(1_001) })]]))])
  expect(names(got)).toEqual(["s.at"])
  expect(reasons(got, "past")).toEqual([LARGE("input")])
})

test("G4: a oneOf of consts and a tagged union count their scans against PAIRS: at the bound they load, past it they are refused", async () => {
  // A oneOf of n consts: n × n.
  const consts = (n: number) => ({ type: "object", properties: { a: { oneOf: Array.from({ length: n }, (_, i) => ({ const: i })) } } })
  // An anyOf whose first branch has 500 properties, and whose second
  // requires r names: 500 × (2 branches + r).
  const tagged = (r: number) => ({
    type: "object",
    properties: {
      a: {
        anyOf: [
          { type: "object", properties: Object.fromEntries(Array.from({ length: 500 }, (_, i) => ["p" + i, { type: "number" }])) },
          { type: "object", required: Array.from({ length: r }, (_, i) => "q" + i) }
        ]
      }
    }
  })
  const got = await loaded([server("s", served([[
    tool("c1000", { inputSchema: consts(1_000) }),
    tool("c1001", { inputSchema: consts(1_001) }),
    tool("t1998", { inputSchema: tagged(1_998) }),
    tool("t1999", { inputSchema: tagged(1_999) })
  ]]))])
  expect(names(got)).toEqual(["s.c1000", "s.t1998"])
  expect(got.refused.map((one) => [one.tool, one.reason])).toEqual([["c1001", LARGE("input")], ["t1999", LARGE("input")]])
})

test("G5: a server with many tools whose checks pass the load's limit is refused whole, and the other server loads", async () => {
  // A small raw schema whose form is large, each level an allOf of two
  // references to the level below (13 levels: about 33,000 parts), is now
  // refused by H4 (its size times its levels). So a flat one, within G2,
  // G4 and H4: 16,000 properties (about 32,000 parts, 2 levels).
  const defs: Record<string, unknown> = { d0: { type: "number" } }
  for (let k = 1; k <= 13; k++) defs["d" + k] = { allOf: [{ $ref: "#/$defs/d" + (k - 1) }, { $ref: "#/$defs/d" + (k - 1) }] }
  expect(formOf({ type: "object", $defs: defs, properties: { a: { $ref: "#/$defs/d13" } } })).toHaveProperty("fault", "render")
  const heavy = { type: "object", properties: Object.fromEntries(Array.from({ length: 16_000 }, (_, i) => ["p" + i, { type: "number" }])) }
  const one = formOf(heavy)
  expect("parts" in one && one.parts > 30_000 && one.parts <= FORM && one.shownSize * one.depth <= RENDER).toBe(true)
  const many = Array.from({ length: 256 }, (_, i) => tool("t" + String(i).padStart(3, "0"), { inputSchema: heavy }))
  const got = await loaded([server("heavy", served([many])), server("light", served([[GOOD]]))], { load: 1_000 })
  expect(got.refused).toEqual([{ server: "heavy", reason: "It did not load in 1000 ms." }])
  expect(names(got)).toEqual(["light.good"])
})

// Each call of console's writers during `body`, by writer.
const consoleDuring = async <A>(body: () => Promise<A>) => {
  const said: Array<string> = []
  const writers = ["warn", "error", "log", "debug", "info"] as const
  const saved = writers.map((one) => console[one])
  for (const one of writers) console[one] = (() => void said.push(one)) as never
  try {
    return { value: await body(), said }
  } finally {
    writers.forEach((one, i) => (console[one] = saved[i] as never))
  }
}

test("finding 4: on a transport that is not stdio, a tool named with an escape and x-mcp-header texts that the SDK would refuse: nothing is written through console, and each tool is in the list or in the refusals", async () => {
  const evil = "evil\u001b[31mRED\u001b[0m"
  const tools = [
    GOOD,
    { name: evil, inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "X\u001b]0;TITLE\u0007\u001b[2J" } } } },
    { name: "evil2", inputSchema: { type: "object", properties: { ["k\u001b[32mGREEN"]: { type: "array", "x-mcp-header": "ok" } } } }
  ]
  const { fake } = echoing(tools)
  const { said } = await consoleDuring(() =>
    withEntries(fake, {}, async (entries, got) => {
      expect(names(got)).toEqual(["s.evil2", "s.good"])
      // The refusal shows the name's escapes as text (ec-egsmp, point 2).
      expect(got.refused.map((one) => one.tool)).toEqual(["evil\\u001b[31mRED\\u001b[0m"])
      expect(await run(entries.evil2!, [{}])).toEqual({ value: "ok" })
    })
  )
  expect(said).toEqual([])
})

test("finding 4: 40 tools with schemas 10,000 deep are each refused by DEPTH, and the load returns", async () => {
  const deep = Array.from({ length: 40 }, (_, i) => tool("d" + String(i).padStart(2, "0"), { inputSchema: chainOf(10_000) }))
  const got = await loaded([server("s", served([[...deep, GOOD]]))])
  expect(names(got)).toEqual(["s.good"])
  expect(got.refused.map((one) => one.reason)).toEqual(deep.map(() => LARGE("input")))
})

test("G8: a cursor that comes again, and a page past the 64th, refuse the server; 64 pages load", async () => {
  // Each page gives one tool and the same cursor.
  const again: Fake = {
    transport: () => {
      const [client, side] = InMemoryTransport.createLinkedPair()
      let n = 0
      serveStdio(() => {
        const low = new Low({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } })
        low.setRequestHandler("tools/list", async () => ({ tools: [tool("t" + n++)], nextCursor: "again" }) as never)
        return low as never
      }, { transport: side })
      return client
    },
    closes: () => 0
  }
  const pages = (count: number) => Array.from({ length: count }, (_, i) => [tool("t" + String(i).padStart(2, "0"))])
  expect(PAGES).toBe(64)
  const got = await loaded([server("again", again), server("long", served(pages(65))), server("full", served(pages(64)))])
  expect(got.refused).toEqual([
    { server: "again", reason: "Its list of tools failed." },
    { server: "long", reason: "Its list of tools failed." }
  ])
  expect(names(got).length).toBe(64)
})

// The protocol's code of a refusal of the Mcp-Param-* headers (SEP-2243;
// the SDK does not export it from its public entry).
const HEADER_MISMATCH = -32020

test("G9: a call's options carry EverChat's own definition: a tool with x-mcp-header at a property is called with no Mcp-Param-* header and answers; a refusal of the headers is the program's error, with no second list and no second call", async () => {
  const schema = { type: "object", properties: { a: { type: "string", "x-mcp-header": "Region" } } }
  const sent: Array<{ readonly method: unknown; readonly headers: unknown }> = []
  const asked: Array<string> = []
  const fake: Fake = {
    transport: () => {
      const [client, side] = InMemoryTransport.createLinkedPair()
      serveStdio(() => {
        const low = new Low({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } })
        low.setRequestHandler("tools/list", async () => {
          asked.push("list")
          return { tools: [tool("head", { inputSchema: schema }), tool("refused", { inputSchema: schema })] } as never
        })
        low.setRequestHandler("tools/call", async (request) => {
          const name = (request.params as { name: string }).name
          asked.push("call " + name)
          if (name === "refused") throw new ProtocolError(HEADER_MISMATCH as never, "the headers do not match")
          return text("answered") as never
        })
        return low as never
      }, { transport: side })
      const send = client.send.bind(client)
      client.send = async (message, options) => {
        sent.push({ method: (message as { method?: unknown }).method, headers: (options as { headers?: unknown } | undefined)?.headers })
        await send(message, options)
      }
      return client
    },
    closes: () => 0
  }
  const { said } = await consoleDuring(() =>
    withEntries(fake, {}, async (entries) => {
      expect(await run(entries.head!, [{ a: "eu" }])).toEqual({ value: "answered" })
      const refused = await run(entries.refused!, [{ a: "eu" }])
      expect(refused.error).toStartWith("s.refused: the call was refused (")
    })
  )
  expect(asked).toEqual(["list", "call head", "call refused"])
  const calls = sent.filter((one) => one.method === "tools/call")
  expect(calls.length).toBe(2)
  expect(calls.flatMap((one) => Object.keys((one.headers ?? {}) as object)).filter((key) => key.toLowerCase().startsWith("mcp-param"))).toEqual([])
  expect(said).toEqual([])
})

// The shown schema (H1 to H7)
// ---------------------------

// The text of one function's declaration, as the head renders it.
const declared = (declaration: Declaration) =>
  renderDeclarations({ globals: [{ ...globalOf(declaration), execute: () => undefined }] })

// The same function with these schemas as they came: the oracle of H7.
const asCame = (declaration: Declaration, inputSchema: unknown, outputSchema?: unknown): Declaration => ({
  name: declaration.name,
  description: declaration.description,
  inputSchema: inputSchema as JsonSchema,
  ...(outputSchema === undefined ? {} : { outputSchema: outputSchema as JsonSchema })
})

// Each key of a JSON value, at any depth.
const keysOf = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === "object" && value !== null
    ? Object.keys(value).flatMap((key) => [key, ...keysOf((value as Record<string, unknown>)[key])])
    : []

// Each object and array of a JSON value, at any depth.
const objectsOf = (value: unknown, into = new Set<object>()): Set<object> => {
  if (typeof value === "object" && value !== null) {
    into.add(value)
    for (const one of Object.values(value)) objectsOf(one, into)
  }
  return into
}

// A schema whose `properties.a` is `n` levels of `types` with a property
// `a` each, down to a number.
const typed = (n: number, types: ReadonlyArray<string>): Definition => {
  let schema: Definition = { type: "number" }
  for (let i = 0; i < n; i++) schema = { type: [...types], properties: { a: schema } }
  return { type: "object", properties: { a: schema } }
}

test("finding 1: a type list of \"object\" two times nested 18 deep, and four times nested 12 deep: each tool loads, and its declaration is the text of the same schema with each type once; the server's other tool loads", async () => {
  const got = await loaded([server("s", served([[
    tool("two", { inputSchema: typed(18, ["object", "object"]) }),
    tool("four", { inputSchema: typed(12, ["object", "object", "object", "object"]) }),
    GOOD
  ]]))])
  expect(names(got)).toEqual(["s.four", "s.good", "s.two"])
  expect(got.refused).toEqual([])
  const [four, , two] = got.declarations as [Declaration, Declaration, Declaration]
  expect(two.inputSchema).toEqual(typed(18, ["object"]))
  expect(four.inputSchema).toEqual(typed(12, ["object"]))
  expect(declared(two)).toBe(declared(asCame(two, typed(18, ["object"]))))
  expect(declared(four)).toBe(declared(asCame(four, typed(12, ["object"]))))
})

test("finding 2: a list of items nested 2,000 deep: the tool loads, and its type shows unknown[] at that place", async () => {
  let deep: Definition = { type: "number" }
  for (let i = 0; i < 2_000; i++) deep = { type: "array", items: [{ type: "object", properties: { a: deep } }] }
  const got = await loaded([server("s", served([[tool("tuple", { inputSchema: { type: "object", properties: { a: deep }, required: ["a"] } }), GOOD]]))])
  expect(names(got)).toEqual(["s.good", "s.tuple"])
  const tuple = got.declarations[1]!
  expect(tuple.inputSchema).toEqual({ type: "object", properties: { a: { type: "array" } }, required: ["a"] })
  expect(declared(tuple)).toBe("declare const s: {\n  /** Does tuple. */\n  tuple(args: { a: unknown[]; }): Promise<unknown>;\n};")
})

test("finding 3: a default of 10,000,000 units under $defs, behind 32 properties that refer to it: the tool loads with no @default tag; a default of the size TAG is shown as today, one of TAG + 1 is not", async () => {
  const O = { type: "object", properties: { a: { type: "string", default: "\u0001".repeat(10_000_000) } } }
  const long = { type: "object", $defs: { O }, properties: Object.fromEntries(Array.from({ length: 32 }, (_, i) => ["p" + i, { $ref: "#/$defs/O" }])) }
  const at = "x".repeat(TAG - 1)
  const past = "x".repeat(TAG)
  expect([sizeOf(at, 1_000), sizeOf(past, 1_000)]).toEqual([TAG, TAG + 1])
  const sized = { type: "object", properties: { at: { type: "string", default: at }, past: { type: "string", default: past }, small: { type: "integer", default: 20 } } }
  const got = await loaded([server("s", served([[tool("long", { inputSchema: long }), tool("sized", { inputSchema: sized }), GOOD]]))])
  expect(names(got)).toEqual(["s.good", "s.long", "s.sized"])
  const [, one, two] = got.declarations as [Declaration, Declaration, Declaration]
  expect(keysOf(one.inputSchema)).not.toContain("default")
  expect(declared(one)).not.toContain("@default")
  expect(declared(one).length).toBeLessThan(2_000)
  const properties = (two.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties
  expect(properties.at).toEqual({ type: "string", default: at })
  expect(properties.past).toEqual({ type: "string" })
  expect(properties.small).toEqual({ type: "integer", default: 20 })
  // As today: the tag of `at` passes the renderer's 80 characters, so
  // neither text has it; the small one is shown.
  expect(declared(two)).toBe(declared(asCame(two, sized)))
  expect(declared(two)).toContain("// @integer @default 20")
})

test("H2: a description beside a $ref is the one in the comment, not the target's; a pattern of 81 units gives no tag; uniqueItems and deprecated give their tags", async () => {
  const schema = {
    type: "object",
    $defs: { n: { type: "number", description: "The target's.", minimum: 1 } },
    properties: {
      r: { $ref: "#/$defs/n", description: "Beside the reference." },
      p: { type: "string", pattern: "a".repeat(TAG + 1) },
      q: { type: "string", pattern: "^[a-z]+$" },
      u: { type: "array", items: { type: "number" }, uniqueItems: true },
      d: { type: "number", deprecated: true }
    },
    required: ["r"]
  }
  const got = await loaded([server("s", served([[tool("shown", { inputSchema: schema })]]))])
  expect(names(got)).toEqual(["s.shown"])
  const properties = (got.declarations[0]!.inputSchema as { properties: Record<string, unknown> }).properties
  expect(properties.r).toEqual({ type: "number", minimum: 1, description: "Beside the reference." })
  expect(properties.p).toEqual({ type: "string" })
  expect(declared(got.declarations[0]!)).toBe([
    "declare const s: {",
    "  /** Does shown. */",
    "  shown(args: {",
    "  // @deprecated",
    "  d?: number;",
    "  p?: string;",
    "  // @pattern ^[a-z]+$",
    "  q?: string;",
    "  // Beside the reference.",
    "  // @minimum 1",
    "  r: number;",
    "  // @uniqueItems",
    "  u?: Array<number>;",
    "}): Promise<unknown>;",
    "};"
  ].join("\n"))
})

test("H4: descriptions that take the shown schema's size past FORM_SIZE are refused (large); a size times levels just past RENDER is refused with H4's sentence; at RENDER it is not refused by H4", async () => {
  const half = "d".repeat(FORM_SIZE / 2)
  const described = { type: "object", properties: { a: { type: "string", description: half }, b: { type: "string", description: half } } }
  // Its form, which has no description, is small: only the shown schema's
  // descriptions take it past.
  const bare = formOf({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } })
  expect("size" in bare && bare.size < 100).toBe(true)
  expect(formOf(described)).toHaveProperty("fault", "large")
  // Four levels: the root, a, b, c.
  const chain = (description: string) => ({
    type: "object",
    properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string", description } } } } } }
  })
  const base = sizeOf(chain(""), 1_000)
  const at = chain("x".repeat(RENDER / 4 - base))
  const past = chain("x".repeat(RENDER / 4 - base + 1))
  const made = formOf(at)
  expect("shownSize" in made ? [made.depth, made.shownSize, made.shownSize * made.depth] : made).toEqual([4, RENDER / 4, RENDER])
  const got = await loaded([server("s", served([[
    tool("described", { inputSchema: described }),
    tool("at", { inputSchema: at }),
    tool("past", { inputSchema: past }),
    GOOD
  ]]))])
  expect(reasons(got, "described")).toEqual([LARGE("input")])
  expect(reasons(got, "past")).toEqual([`Its input schema is too large for EverChat to show: its size times its levels is more than ${RENDER}.`])
  // At the bound, the core refuses its type by its length.
  expect(reasons(got, "at")).toHaveLength(1)
  expect(reasons(got, "at")[0]).toMatch(/^Its input type is \d+ characters, more than 16000\.$/)
  expect(names(got)).toEqual(["s.good"])
})

test("H9: functions whose weights sum to HEAD_RENDER are all kept; one more after them is refused with H9's sentence, and so is a small function after it; the same with the pages in another order", async () => {
  // Two levels; the description of the root is shown in no comment, so the
  // rendered declaration stays small. Its weight: 500,000 × 2 = 1,000,000.
  const weighed = (length: number) => ({ type: "object", properties: { a: { type: "string" } }, description: "d".repeat(length) })
  const half = weighed(500_000 - sizeOf(weighed(0), 1_000))
  const made = formOf(half)
  expect("shownSize" in made ? [made.shownSize, made.depth] : made).toEqual([500_000, 2])
  // Each of two: an input and an output schema, 2,000,000 together.
  const two = ["a1", "a2"].map((name) => tool(name, { inputSchema: half, outputSchema: half }))
  const more = tool("a3", { inputSchema: { type: "object" } })
  const H9 = `Its schemas would pass the ${HEAD_RENDER} of size times levels of the schemas of the functions from outside.`
  expect(2 * 2 * 1_000_000).toBe(HEAD_RENDER)
  const first = await loaded([server("s", served([[...two, more, GOOD]]))])
  const second = await loaded([server("s", served([[GOOD], [more, two[1]!], [two[0]!]]))])
  for (const got of [first, second]) {
    expect(names(got)).toEqual(["s.a1", "s.a2"])
    expect(got.refused).toEqual([{ server: "s", tool: "a3", reason: H9 }, { server: "s", tool: "good", reason: H9 }])
  }
})

// A list that counts the reads of its entries (each index read), and
// throws at a read past `most`: a walk that would read the whole list ends
// at once (the throw refuses its tool), so a case fails by its assertions,
// not by a long step. The in-memory transport gives a server's values to the
// client by reference below a definition's own fields, so a case can see
// what the walk reads, with no clock (ec-kyl76, the lead's ruling on
// ec-6n1co).
const counting = <T>(entries: Array<T>, most: number) => {
  let reads = 0
  const list = new Proxy(entries, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
        reads++
        if (reads > most) throw new Error("a read past the bound of the case")
      }
      return Reflect.get(target, key, receiver)
    }
  })
  return { list, reads: () => reads }
}

test("H11: a default that is a list of 1,000,000 zeros under $defs, behind 1,000 properties that refer to it: the tool loads with no @default tag, and the server's other tool loads, under a load of 2,000 ms; the walk reads none of its entries", async () => {
  const zeros = counting(Array.from({ length: 1_000_000 }, () => 0), 0)
  const T = { anyOf: [{ type: "number", default: zeros.list }] }
  const wide = { type: "object", $defs: { T }, properties: Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => ["p" + i, { $ref: "#/$defs/T" }])) }
  const got = await loaded([server("s", served([[tool("wide", { inputSchema: wide }), GOOD]]))], { load: 2_000 })
  expect(got.refused).toEqual([])
  expect(names(got)).toEqual(["s.good", "s.wide"])
  expect(keysOf(got.declarations[1]!.inputSchema)).not.toContain("default")
  expect(declared(got.declarations[1]!)).not.toContain("@default")
  // The guard of the cost, by a count and not by the clock: `wide` sorts
  // last, so no time limit could see a long step of it (ec-6n1co). H11:
  // a list is left out with no read of what is in it, at each of the 1,000
  // expansions.
  expect(zeros.reads()).toBe(0)
})

test("H5b: a default that is a list or an object gives no tag; a text, a number, true and false give their tags as before", async () => {
  const schema = {
    type: "object",
    properties: {
      list: { type: "array", default: [1] },
      object: { type: "object", default: { a: 1 } },
      text: { type: "string", default: "x" },
      number: { type: "number", default: 20 },
      yes: { type: "boolean", default: true },
      no: { type: "boolean", default: false }
    }
  }
  const got = await loaded([server("s", served([[tool("given", { inputSchema: schema })]]))])
  expect(names(got)).toEqual(["s.given"])
  const given = got.declarations[0]!
  const properties = (given.inputSchema as { properties: Record<string, unknown> }).properties
  expect(properties.list).toEqual({ type: "array" })
  expect(properties.object).toEqual({ type: "object" })
  expect(declared(given)).toBe([
    "declare const s: {",
    "  /** Does given. */",
    "  given(args: {",
    "  list?: unknown[];",
    "  // @default false",
    "  no?: boolean;",
    "  // @default 20",
    "  number?: number;",
    "  object?: { [key: string]: unknown; };",
    "  // @default \"x\"",
    "  text?: string;",
    "  // @default true",
    "  yes?: boolean;",
    "}): Promise<unknown>;",
    "};"
  ].join("\n"))
  // As it came, the renderer shows both: the line H5b of the lead.
  expect(declared(asCame(given, schema))).toContain("// @default [1]")
  expect(declared(asCame(given, schema))).toContain("// @default {\"a\":1}")
})

test("H12: a type list of FORM + 1 times \"object\" is refused (large), and the server's other tool loads; a list of 1,000,000 behind 1,000 references is refused the same way, under a load of 2,000 ms", async () => {
  const objects = (n: number) => Array.from({ length: n }, () => "object")
  const T = { type: objects(1_000_000) }
  const behind = { type: "object", $defs: { T }, properties: Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => ["p" + i, { $ref: "#/$defs/T" }])) }
  const got = await loaded([server("s", served([[
    tool("past", { inputSchema: { type: "object", properties: { a: { type: objects(FORM + 1) } } } }),
    tool("behind", { inputSchema: behind }),
    GOOD
  ]]))], { load: 2_000 })
  expect(reasons(got, "past")).toEqual([LARGE("input")])
  expect(reasons(got, "behind")).toEqual([LARGE("input")])
  expect(names(got)).toEqual(["s.good"])
})

test("H10 and H13: a required, a type or a dependentRequired list of 1,000,000 texts and then a number, behind 1,000 references, is refused (large) under a load of 2,000 ms, and the server's other tool loads; a short list not of its kind is left out as before, and the tool loads", async () => {
  const names1m = [...Array.from({ length: 1_000_000 }, (_, i) => "n" + i), 5]
  // Each list counts the reads of its entries (`counting`).
  const required = counting([...names1m], FORM)
  const dependent = counting([...names1m], FORM)
  const typed = counting(names1m.map((one) => (typeof one === "string" ? "object" : one)), FORM)
  const behind = (T: Definition) => ({ type: "object", $defs: { T }, properties: Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => ["p" + i, { $ref: "#/$defs/T" }])) })
  const got = await loaded([server("s", served([[
    tool("required", { inputSchema: behind({ type: "object", required: required.list }) }),
    tool("dependent", { inputSchema: behind({ type: "object", dependentRequired: { a: ["b"], c: dependent.list } }) }),
    tool("typed", { inputSchema: behind({ type: typed.list }) }),
    tool("short", { inputSchema: { type: "object", required: ["a", 5], dependentRequired: { a: ["b", 5] }, properties: { a: { type: ["string", 5] } } } }),
    GOOD
  ]]))], { load: 2_000 })
  expect(reasons(got, "required")).toEqual([LARGE("input")])
  expect(reasons(got, "dependent")).toEqual([LARGE("input")])
  expect(reasons(got, "typed")).toEqual([LARGE("input")])
  expect(names(got)).toEqual(["s.good", "s.short"])
  expect(got.entries.find((one) => one.tool === "short")!.form.input).toEqual({ type: "object", properties: { a: {} } })
  // The guard of the cost, by a count and not by the clock: `typed` sorts
  // last (ec-6n1co). Each entry is counted toward FORM as it is read (H10,
  // H13), so the walk reads at most FORM entries of a list in all, of the
  // 1,000,001 behind each of 1,000 references.
  for (const list of [required, dependent, typed]) expect(list.reads()).toBeLessThanOrEqual(FORM)
})

test("H14: a dependentRequired whose first value is 5 counts all its keys at once: of FORM + 1 keys it is refused (large), and of 100,000 keys under $defs behind 1,000 references too, and the server's other tool loads; a short one not of its kind is left out, and one of its kind is in the form and the shown schema", async () => {
  const keyed = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["k" + i, 5]))
  const T = { type: "object", dependentRequired: keyed(100_000) }
  const behind = { type: "object", $defs: { T }, properties: Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => ["p" + i, { $ref: "#/$defs/T" }])) }
  const got = await loaded([server("s", served([[
    tool("wide", { inputSchema: { type: "object", dependentRequired: keyed(FORM + 1) } }),
    tool("behind", { inputSchema: behind }),
    tool("short", { inputSchema: { type: "object", dependentRequired: { a: 5, b: ["c"] } } }),
    tool("kind", { inputSchema: { type: "object", dependentRequired: { a: ["b", "c"], d: [] } } }),
    GOOD
  ]]))])
  expect(reasons(got, "wide")).toEqual([LARGE("input")])
  expect(reasons(got, "behind")).toEqual([LARGE("input")])
  expect(names(got)).toEqual(["s.good", "s.kind", "s.short"])
  const entry = (name: string) => got.entries.find((one) => one.tool === name)!
  expect(entry("short").form.input).toEqual({ type: "object" })
  expect(entry("short").declaration.inputSchema).toEqual({ type: "object" })
  expect(entry("kind").form.input).toEqual({ type: "object", dependentRequired: { a: ["b", "c"], d: [] } })
  expect(entry("kind").declaration.inputSchema).toEqual({ type: "object", dependentRequired: { a: ["b", "c"], d: [] } })
})

test("H1: after a load, the declaration's schemas share no object with the server's, and hold no $ref, $defs or definitions at any place", async () => {
  const input = {
    type: "object",
    $defs: { n: { type: "number", description: "n" } },
    definitions: { s: { type: "string" } },
    properties: { a: { $ref: "#/$defs/n" }, b: { $ref: "#/definitions/s", description: "b" }, c: { type: "array", items: { $ref: "#/$defs/n" } } }
  }
  const output = { type: "object", properties: { sum: { $ref: "#/properties/x" }, x: { type: "number", default: 1 } } }
  const definition = tool("t", { inputSchema: input, outputSchema: output })
  const got = await loaded([server("s", served([[definition]]))])
  expect(names(got)).toEqual(["s.t"])
  const declaration = got.declarations[0]!
  const theirs = objectsOf(definition)
  expect([...objectsOf(declaration.inputSchema)].filter((one) => theirs.has(one))).toEqual([])
  expect([...objectsOf(declaration.outputSchema)].filter((one) => theirs.has(one))).toEqual([])
  for (const schema of [declaration.inputSchema, declaration.outputSchema]) {
    expect(keysOf(schema).filter((key) => key === "$ref" || key === "$defs" || key === "definitions")).toEqual([])
  }
  expect(declaration.inputSchema).toEqual({
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string", description: "b" }, c: { type: "array", items: { type: "number" } } }
  })
  expect(declaration.outputSchema).toEqual({ type: "object", properties: { sum: { type: "number" }, x: { type: "number", default: 1 } } })
})

test("H5a: a format or a pattern that is no text gives no tag: the tool loads, with no @format and no @pattern", async () => {
  const schema = { type: "object", properties: { a: { type: "string", format: 5, pattern: 7 } } }
  const got = await loaded([server("s", served([[tool("numbers", { inputSchema: schema })]]))])
  expect(names(got)).toEqual(["s.numbers"])
  const numbers = got.declarations[0]!
  expect(numbers.inputSchema).toEqual({ type: "object", properties: { a: { type: "string" } } })
  expect(declared(numbers)).toBe("declare const s: {\n  /** Does numbers. */\n  numbers(args: { a?: string; }): Promise<unknown>;\n};")
  // As it came, the renderer shows both: the line H5a of the lead.
  expect(declared(asCame(numbers, schema))).toContain("// @pattern 7 @format 5")
})

// H7: the comparison. A generator of schemas inside H5's first sentence
// (no `$ref`, no list of `items`, no `type` list with a repeated entry, no
// `default` past TAG or that is a list or an object (H5b, its fixed case
// above), no `format` or `pattern` past TAG units or that is no
// text (H5a, its fixed case above), no boolean `exclusiveMinimum` or
// `exclusiveMaximum`, every kept keyword of its kind), from fixed seeds;
// each schema goes through JSON, as a server's does. The render of its
// shown schema must be the render of the schema as it came, byte for byte.

// A seeded source of numbers in [0, 1) (mulberry32).
const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Texts that need escapes, in a comment, a key, a JSON text or a tag.
const TEXTS = ["", "a", "two words", "quote \" and \\ back", "line\nend", "crlf\r\nend", "sep par ", "close */ comment", "nul \u0000 \u0001", "lone \ud800", "emoji 😀", "  padded  ", "\n"]
// Names that are no identifiers, `__proto__` too.
const NAMES = ["a", "b", "zeta", "a-b", "1x", "0", "", "$ok", "_x", "with space", "\"q\"", "__proto__", "constructor", "x*/y", "line\nname"]
const TYPES = ["string", "number", "integer", "boolean", "null", "array", "object"]

const comparisonOf = (random: () => number) => {
  const pick = <A>(list: ReadonlyArray<A>): A => list[Math.floor(random() * list.length)] as A
  const chance = (p: number) => random() < p
  // A JSON object: each key a data property, a key `__proto__` too.
  const object = (entries: ReadonlyArray<readonly [string, unknown]>) => {
    const made: Record<string, unknown> = {}
    for (const [key, value] of entries) Object.defineProperty(made, key, { value, enumerable: true, writable: true, configurable: true })
    return made
  }
  const number = () => pick([0, 1, -1, 2.5, 100, -0.125, 1e21, 7])
  const data = (depth: number): unknown => {
    const kind = Math.floor(random() * (depth > 0 ? 7 : 5))
    if (kind === 0) return null
    if (kind === 1) return chance(0.5)
    if (kind === 2) return number()
    if (kind <= 4) return pick(TEXTS)
    if (kind === 5) return Array.from({ length: Math.floor(random() * 3) }, () => data(depth - 1))
    return object(Array.from({ length: Math.floor(random() * 3) }, () => [pick(NAMES), data(depth - 1)] as const))
  }
  // A schema `depth` levels at most; `guarded`: below `not`, `if`, `oneOf`
  // or a `contains` with `maxContains`, where `pattern` and `uniqueItems`
  // refuse the tool.
  const schema = (depth: number, guarded: boolean): unknown => {
    if (depth === 0 || chance(0.08)) return pick<unknown>([true, false, {}, { type: pick(TYPES) }])
    const entries: Array<readonly [string, unknown]> = []
    const add = (key: string, value: unknown) => entries.push([key, value])
    const below = () => schema(depth - 1, guarded)
    const shape = random()
    if (shape < 0.35) {
      if (chance(0.8)) add("type", "object")
      const names = Array.from({ length: Math.floor(random() * 4) }, () => pick(NAMES))
      if (names.length > 0 || chance(0.5)) add("properties", object(names.map((name) => [name, below()] as const)))
      if (chance(0.6)) add("required", [...names.filter(() => chance(0.6)), ...(chance(0.2) ? [pick(NAMES)] : [])])
      const additional = random()
      if (additional < 0.25) add("additionalProperties", true)
      else if (additional < 0.5) add("additionalProperties", false)
      else if (additional < 0.7) add("additionalProperties", below())
    } else if (shape < 0.5) {
      if (chance(0.8)) add("type", "array")
      if (chance(0.7)) add("items", below())
      if (chance(0.3)) add("prefixItems", Array.from({ length: Math.floor(random() * 3) }, below))
      if (chance(0.2)) {
        add("contains", schema(depth - 1, guarded || chance(0.5)))
      }
    } else if (shape < 0.65) {
      const keyword = pick(["anyOf", "oneOf", "allOf"])
      add(keyword, Array.from({ length: 1 + Math.floor(random() * 3) }, () => schema(depth - 1, guarded || keyword === "oneOf")))
    } else if (shape < 0.75) {
      if (chance(0.5)) add("enum", Array.from({ length: Math.floor(random() * 4) }, () => data(2)))
      else add("const", data(2))
    } else if (shape < 0.85) {
      // A type list of different types.
      const types = TYPES.filter(() => chance(0.4)).sort(() => random() - 0.5)
      add("type", types)
      if (types.includes("object") && chance(0.7)) add("properties", object([[pick(NAMES), below()]]))
      if (types.includes("array") && chance(0.7)) add("items", below())
    } else {
      add("type", pick(TYPES))
    }
    // The tag keywords, each with its kind.
    for (const keyword of ["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum", "multipleOf"]) {
      if (chance(0.08)) add(keyword, keyword === "multipleOf" ? pick([1, 2, 0.5]) : number())
    }
    for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"]) {
      if (chance(0.08)) add(keyword, Math.floor(random() * 10))
    }
    if (!guarded && chance(0.1)) add("pattern", pick(["^[a-z]+$", "\\d", "a".repeat(TAG - 10), ...TEXTS]))
    if (chance(0.1)) add("format", pick(["date-time", "uri", "f".repeat(TAG), ...TEXTS]))
    if (chance(0.08)) add("uniqueItems", guarded ? false : chance(0.7))
    if (chance(0.08)) add("deprecated", chance(0.7))
    if (chance(0.15)) {
      // A scalar only (H11, H5b): null, a boolean, a number or a text.
      const given = chance(0.1) ? null : pick<unknown>([true, false, number(), pick(TEXTS)])
      if (given === null || sizeOf(given, TAG) <= TAG) add("default", given)
    }
    if (chance(0.3)) add("description", chance(0.9) ? pick(TEXTS) : 5)
    if (chance(0.05)) add("title", pick(TEXTS))
    if (chance(0.05)) add("not", schema(depth - 1, true))
    if (chance(0.05)) {
      add("if", schema(depth - 1, true))
      add("then", below())
    }
    if (chance(0.03)) add("minContains", 1)
    // A schema in another order of its keys.
    return object(entries.sort(() => random() - 0.5))
  }
  return schema
}

// The seeds, and the schemas of each: the input schema an object schema,
// the output schema any schema.
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]
const EACH = 500

test("H7: the render of the shown schema is the render of the schema as it came, for 8 seeds of 500 pairs of schemas each (4,000 pairs; about 2 s here)", () => {
  const disagree: Array<string> = []
  let compared = 0
  for (const seed of SEEDS) {
    const schema = comparisonOf(seeded(seed))
    for (let i = 0; i < EACH; i++) {
      const input = JSON.parse(JSON.stringify({ ...(schema(4, false) as object), type: "object" })) as unknown
      const output = JSON.parse(JSON.stringify(schema(4, false))) as unknown
      const forms = [checkOf(input, "input"), checkOf(output, "output")] as const
      const [inForm, outForm] = forms
      if (typeof inForm === "string" || typeof outForm === "string") {
        disagree.push(`seed ${seed}, schema ${i}: refused: ${String(typeof inForm === "string" ? inForm : outForm)}`)
        continue
      }
      const one = { name: "s.t", description: "Does t." }
      const theirs = declared(asCame(one as Declaration, input, output))
      const ours = declared(asCame(one as Declaration, inForm.shown, outForm.shown))
      compared += 1
      if (ours !== theirs) disagree.push(`seed ${seed}, schema ${i}: ${JSON.stringify({ input, output }).slice(0, 2_000)}\n--- as it came:\n${theirs}\n--- shown:\n${ours}`)
    }
  }
  expect(disagree.slice(0, 3)).toEqual([])
  expect(compared).toBe(SEEDS.length * EACH)
}, 60_000)

// The follow-on's cases (ec-kyl76)
// --------------------------------
//
// The mutants that the reviews of this file found surviving: each case
// names the review's mutant that it guards.

test("O9: an error's text is bounded in bytes, not in characters: an isError text of 30 characters and 60 bytes is not shown under hard 50; one of 50 bytes is shown whole", async () => {
  const { fake } = answering([tool("over"), tool("at")], async (name) =>
    ({ isError: true, content: [{ type: "text", text: name === "over" ? "\u00e9".repeat(30) : "\u00e9".repeat(25) }] }))
  await withEntries(fake, { hard: 50, max: 1000 }, async (entries) => {
    expect(await run(entries.over!, [{ a: 1 }])).toEqual({ error: "s.over: the server gave an error: [a text of 60 bytes, over the bound of 50 bytes, not shown]" })
    expect(await run(entries.at!, [{ a: 1 }])).toEqual({ error: "s.at: the server gave an error: " + "\u00e9".repeat(25) })
  })
})

test("O10, O11: the SDK's text of a time limit and of a connection that is gone is bounded by max too, also of a send that fails while the client is connected", async () => {
  const { fake, drop } = answering([tool("slow"), tool("echo")], (name, _, signal) =>
    name === "slow"
      ? new Promise((resolve) => {
        const timer = setTimeout(() => resolve(text("late")), 5_000)
        signal.addEventListener("abort", () => clearTimeout(timer))
      })
      : Promise.resolve(text("here")))
  const CUT = /^[\s\S]{10}\u2026 \[the text was cut: its first 10 characters are shown, of \d+ characters\]$/
  await withEntries(fake, { call: 200, max: 10 }, async (entries) => {
    const slow = (await run(entries.slow!, [{ a: 1 }])).error ?? ""
    const late = /^s\.slow: no answer in 200 ms \(([\s\S]*)\)\.$/.exec(slow)
    expect(late?.[1]).toMatch(CUT)
    await drop()
    const gone = (await run(entries.echo!, [{ a: 1 }])).error ?? ""
    const closed = /^s\.echo: the server "s" is not connected \(([\s\S]*)\)\.$/.exec(gone)
    expect(closed?.[1]).toMatch(CUT)
  })
  // A transport whose send fails with the SDK's own error while the client
  // is connected (as the in-memory side does when its other side is gone).
  const echo = answering([tool("echo")], async () => text("here"))
  let failing = false
  const sending: Fake = {
    transport: () => {
      const side = echo.fake.transport()
      const send = side.send.bind(side)
      side.send = async (message, options) => {
        if (failing && (message as { method?: unknown }).method === "tools/call") throw new SdkError(SdkErrorCode.SendFailed, "the pipe is broken: " + "w".repeat(40))
        return send(message, options)
      }
      return side
    },
    closes: () => 0
  }
  await withEntries(sending, { max: 10 }, async (entries) => {
    expect(await run(entries.echo!, [{ a: 1 }])).toEqual({ value: "here" })
    failing = true
    const failed = (await run(entries.echo!, [{ a: 1 }])).error ?? ""
    const unsent = /^s\.echo: the server "s" is not connected \(([\s\S]*)\)\.$/.exec(failed)
    expect(unsent?.[1]).toMatch(CUT)
  })
})

test("LE: the scope's end waits for a close that never ends up to the load's limit and no longer, on the test's clock", async () => {
  const stuck = held("stuck", [tool("x")])
  try {
    const exit = await Effect.runPromise(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const got = yield* load([stuck.server], { beside: HOSTED, load: 1_000 }).pipe(Scope.provide(scope))
      const marks: Array<unknown> = [names(got)]
      let returned = false
      // Detached: the program returns its marks whether or not the end
      // has returned (a child would hold it to the end's close).
      const ending = yield* Effect.forkDetach(Scope.close(scope, Exit.void).pipe(Effect.ensuring(Effect.sync(() => {
        returned = true
      }))))
      yield* Effect.promise(() => turns())
      // The close has begun, and holds the end.
      marks.push([stuck.closes(), returned])
      yield* TestClock.adjust(999)
      yield* Effect.promise(() => turns())
      marks.push(returned)
      yield* TestClock.adjust(1)
      yield* Effect.promise(() => turns())
      // At the limit the end returns, though the close has not ended.
      marks.push([returned, stuck.ended()])
      return { marks, exit: returned ? yield* Effect.exit(Fiber.join(ending)) : undefined }
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))))
    expect(exit.marks).toEqual([["stuck.x"], [1, false], false, [true, false]])
    expect(exit.exit !== undefined && Exit.isSuccess(exit.exit)).toBe(true)
  } finally {
    stuck.end()
  }
})

test("LG: a transport's own close that rejects at the scope's end changes nothing: the end succeeds, and no rejection is left unhandled", async () => {
  const fake = served([[tool("x")]])
  let calls = 0
  // The client holds a view of its side whose close counts only the
  // client's calls (the other side closes the side itself, not the view):
  // the client's step calls it first, the transport's own step second, and
  // that second call rejects.
  const transport = () => {
    const side = fake.transport()
    const close = async () => {
      calls++
      await side.close()
      if (calls === 2) throw new Error("the transport's close failed")
    }
    return new Proxy(side, { get: (target, key, receiver) => (key === "close" ? close : Reflect.get(target, key, receiver)) })
  }
  const unhandled: Array<unknown> = []
  const note = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", note)
  try {
    const { got, end } = await opened([server("s", { transport, closes: () => calls })])
    expect(names(got)).toEqual(["s.x"])
    const exit = await end()
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).toBe(2)
    await turns()
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", note)
  }
})

// The form of a schema, or the refusal.
const made = (schema: unknown): Form => {
  const got = formOf(schema)
  if (!("form" in got)) throw new Error("refused: " + got.fault)
  return got
}

test("P3-2: a pointer under a schema with an $id starts there, also when the pointer's way passes it; $recursiveRef is refused; a lone $ref is a level of the depth; minLength is a text check; ~01 is the name ~1", () => {
  const based = made({
    type: "object",
    $defs: {
      x: { type: "string" },
      sub: { $id: "sub", $defs: { x: { type: "number" } }, properties: { p: { $ref: "#/$defs/x" } } }
    },
    properties: {
      a: { $ref: "#/$defs/sub" },
      b: { $ref: "#/$defs/sub/properties/p" },
      // Reached with no pointer: the walk itself enters the schema of its own.
      c: { $id: "own", $defs: { x: { type: "boolean" } }, properties: { q: { $ref: "#/$defs/x" } } }
    }
  })
  expect(based.form).toEqual({
    type: "object",
    properties: { a: { properties: { p: { type: "number" } } }, b: { type: "number" }, c: { properties: { q: { type: "boolean" } } } }
  })
  expect(checkOf({ type: "object", $recursiveRef: "#" }, "input")).toBe(REFERENCE("input"))
  expect(made({ type: "string" }).depth).toBe(1)
  expect(made({ $defs: { a: { type: "string" } }, $ref: "#/$defs/a" }).depth).toBe(2)
  expect([made({ type: "string", minLength: 1 }).texts, made({ type: "string", maxLength: 5 }).texts, made({ type: "string", minLength: 1, maxLength: 5 }).texts]).toEqual([1, 1, 2])
  const escaped = made({ type: "object", properties: { "~1": { type: "number" }, "/": { type: "string" }, x: { $ref: "#/properties/~01" } } })
  expect((escaped.form as { properties: Record<string, unknown> }).properties.x).toEqual({ type: "number" })
})

test("R2: a cursor that comes again refuses the server at its second page: the server is asked two times, not 64", async () => {
  let asked = 0
  const again: Fake = {
    transport: () => {
      const [client, side] = InMemoryTransport.createLinkedPair()
      serveStdio(() => {
        const low = new Low({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } })
        low.setRequestHandler("tools/list", async () => {
          asked++
          return { tools: [tool("t" + asked)], nextCursor: "again" } as never
        })
        return low as never
      }, { transport: side })
      return client
    },
    closes: () => 0
  }
  const got = await loaded([server("again", again)])
  expect(got.refused).toEqual([{ server: "again", reason: "Its list of tools failed." }])
  expect(asked).toBe(2)
})

test("R13: two definitions of one name are both refused with the duplicate's sentence, with ask and with a form that has a fault too; with deny they are left out with no refusal", async () => {
  const DUP = "Its name is given more than once by its server."
  const faulty = { inputSchema: { type: "object", patternProperties: { "^x": { type: "number" } } } }
  const got = await loaded([server("s", served([[tool("asked"), tool("asked"), tool("denied"), tool("denied"), tool("faulty", faulty), tool("faulty", faulty), GOOD]]), {
    tools: { asked: "ask", denied: "deny" }
  })])
  expect(names(got)).toEqual(["s.good"])
  expect(got.refused).toEqual([
    { server: "s", tool: "asked", reason: DUP },
    { server: "s", tool: "asked", reason: DUP },
    { server: "s", tool: "faulty", reason: DUP },
    { server: "s", tool: "faulty", reason: DUP }
  ])
})

test("R14: a server that offers no tools gives no function and no refusal, and the other server loads", async () => {
  const none: Fake = {
    transport: () => {
      const [client, side] = InMemoryTransport.createLinkedPair()
      serveStdio(() => new Low({ name: "test", version: "1.0.0" }, { capabilities: {} }) as never, { transport: side })
      return client
    },
    closes: () => 0
  }
  const got = await loaded([server("none", none), server("s", served([[GOOD]]))])
  expect(names(got)).toEqual(["s.good"])
  expect(got.refused).toEqual([])
})

test("X9: a $ref with keywords beside it: the copy in the allOf is the target's shown schema, with its children's descriptions", () => {
  const got = made({
    type: "object",
    properties: { a: { description: "outer", type: "object", $ref: "#/$defs/t" } },
    $defs: { t: { description: "target", properties: { b: { type: "string", description: "inner" } } } }
  })
  const a = (got.shown as { properties: { a: { allOf: Array<{ properties: { b: unknown } }> } } }).properties.a
  expect(a.allOf[0]!.properties.b).toEqual({ type: "string", description: "inner" })
  expect((got.form as { properties: { a: unknown } }).properties.a).toEqual({ type: "object", allOf: [{ properties: { b: { type: "string" } } }] })
})

test("X14: a form and its annotations that pass FORM_SIZE only together are refused as too large, not by RENDER", () => {
  const schema = { type: "object", description: "d".repeat(600_000), properties: { a: { const: "c".repeat(600_000) } } }
  expect(sizeOf({ type: "object", properties: { a: { const: "c".repeat(600_000) } } }, FORM_SIZE)).toBeLessThanOrEqual(FORM_SIZE)
  expect(checkOf(schema, "input")).toBe(LARGE("input"))
})

test("X15: the bounds come in order, budget before HEAD_RENDER: a function past both is refused with the budget's sentence", async () => {
  // As in the H9 case: two functions whose weights sum to HEAD_RENDER.
  const weighed = (length: number) => ({ type: "object", properties: { a: { type: "string" } }, description: "d".repeat(length) })
  const half = weighed(500_000 - sizeOf(weighed(0), 1_000))
  const two = ["a1", "a2"].map((name) => tool(name, { inputSchema: half, outputSchema: half }))
  const more = tool("a3", { inputSchema: { type: "object" } })
  const first = await loaded([server("s", served([[...two]]))])
  expect(names(first)).toEqual(["s.a1", "s.a2"])
  // The budget that the two fill exactly.
  const budget = first.declarations.map((one) => renderDeclarations({ globals: [{ ...globalOf(one), execute: () => undefined }] }).length).reduce((a, b) => a + b, 0)
  const got = await loaded([server("s", served([[...two, more]]))], { budget })
  expect(names(got)).toEqual(["s.a1", "s.a2"])
  expect(got.refused).toEqual([{ server: "s", tool: "a3", reason: `Its declaration would pass the ${budget} characters of the declarations of the functions from outside.` }])
})

test("X1, X4, X19: a description that is no text, a flag that is not true, and a null default are not copied to the shown schema", () => {
  const got = made({ type: "object", description: 5, uniqueItems: "yes", deprecated: 1, default: null, properties: { a: { type: "array", uniqueItems: false, deprecated: "true" } } })
  expect(got.shown).toEqual({ type: "object", properties: { a: { type: "array" } } })
  expect(got.shown).toEqual(got.form)
})

test("note 3 of ec-9jqhe: the head of a type list, of a required and of a dependentRequired is one part each, and each entry read is one, also the entry that is no text; the form's lists are copies, not the server's arrays", () => {
  expect(made({}).parts).toBe(1)
  expect(made({ type: "string" }).parts).toBe(2)
  // The schema, two entries and the list's head.
  expect(made({ type: ["string", "number"] }).parts).toBe(4)
  expect(made({ required: ["a", "b"] }).parts).toBe(4)
  // The schema, one key, two entries and the head.
  expect(made({ dependentRequired: { a: ["b", "c"] } }).parts).toBe(5)
  // A list not of its kind: the schema, then "a" and 5 read and counted;
  // the read stops at 5, and the list is left out.
  expect(made({ required: ["a", 5, "b"] }).parts).toBe(3)
  expect(made({ type: ["string", 5, "number"] }).parts).toBe(3)
  const required = ["a"]
  const list = ["b"]
  const got = made({ type: "object", required, dependentRequired: { a: list } })
  for (const one of [got.form, got.shown] as Array<{ required: unknown; dependentRequired: { a: unknown } }>) {
    expect(one.required).toEqual(required)
    expect(one.required).not.toBe(required)
    expect(one.dependentRequired.a).toEqual(list)
    expect(one.dependentRequired.a).not.toBe(list)
  }
})
