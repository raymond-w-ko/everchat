// The whole program as `everchat serve`: the host on this machine, for the
// reference client's page (packages/local/src/serve.ts; docs/host.md,
// section 7). Each case starts the program as a process with a home of its
// own, the fake vendor's address and `--port 0`, and ends it in the case.
// `just test-build` runs this file on the executable too.
//
// No test here sends a request to a real model (tests/vendor.ts).

import { afterEach, expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Effect, Exit, Logger } from "effect"
import { Command } from "effect/cli"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { command, NoHome, VERSION } from "../src/main.ts"
import { FILE, TENANT } from "../src/serve.ts"
import { rows } from "./help.ts"
import { env, place, PROGRAM, program, text, vendor } from "./vendor.ts"

const open: Array<() => unknown> = []
afterEach(async () => {
  for (const close of open.splice(0).reverse()) {
    await close()
  }
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const within = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await sleep(5)
  return check()
}

const fake = (answer: Parameters<typeof vendor>[0]) => {
  const made = vendor(answer)
  open.push(made.stop)
  return made
}

// All the bytes of a stream, as they come.
const collect = (stream: ReadableStream<Uint8Array>) => {
  const got = { text: "", done: false }
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) got.text += decoder.decode(chunk, { stream: true })
    got.done = true
  })()
  return got
}

const ADDRESS = /^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{32})\/\n$/
const PERSON = (home: string) => `The host serves the chats of ${home}, on this machine only, for development. Ctrl+C ends it.\n`

// `everchat serve` on a place, until its address is printed.
const serving = async (at: ReturnType<typeof place>, address: string) => {
  const proc = Bun.spawn([...PROGRAM, "serve", "--port", "0"], { cwd: at.work, env: env(at, address), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  open.push(async () => {
    proc.kill("SIGKILL")
    await proc.exited
  })
  const out = collect(proc.stdout)
  const err = collect(proc.stderr)
  expect(await within(() => out.text.includes("\n") || out.done, 15_000)).toBe(true)
  const found = ADDRESS.exec(out.text)
  if (found === null) throw new Error("no address: " + out.text + err.text)
  const port = Number(found[1])
  const origin = `http://127.0.0.1:${port}`
  return { proc, out, err, url: found[0].trim(), port, start: found[2]!, origin, api: origin + "/v1/chats/" }
}
type Serving = Awaited<ReturnType<typeof serving>>

// The page's calls, as client.html makes them: R9, R10, R1 with its origin.
const newChat = async (s: Serving) => {
  const got = await fetch(s.url + "chats", { method: "POST", headers: { origin: s.origin } })
  expect(got.status).toBe(200)
  return ((await got.json()) as { chat: string }).chat
}
const tokenFor = async (s: Serving, chats: ReadonlyArray<string>) => {
  const got = await fetch(s.url + "token", { method: "POST", headers: { origin: s.origin, "content-type": "application/json" }, body: JSON.stringify({ chats }) })
  return { status: got.status, body: (await got.json()) as { token: string; exp: number } }
}
const say = (s: Serving, chat: string, token: string, said: string) =>
  fetch(s.api + chat + "/messages", {
    method: "POST",
    headers: { origin: s.origin, authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ text: said })
  })

// An event stream (R4), read in the background: its frames.
const streamOf = async (s: Serving, chat: string, token: string) => {
  const controller = new AbortController()
  const response = await fetch(s.api + chat + "/events?after=0", {
    headers: { origin: s.origin, authorization: "Bearer " + token, accept: "text/event-stream" },
    signal: controller.signal
  })
  expect(response.status).toBe(200)
  const frames: Array<{ readonly id: number | null; readonly event: string; readonly data: Record<string, unknown> }> = []
  const state = { ended: false }
  void (async () => {
    let rest = ""
    try {
      const decoder = new TextDecoder()
      for await (const chunk of response.body!) {
        rest += decoder.decode(chunk, { stream: true })
        const parts = rest.split("\n\n")
        rest = parts.pop() ?? ""
        for (const part of parts) {
          const fields: Record<string, string> = {}
          for (const line of part.split("\n")) {
            const colon = line.indexOf(":")
            if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart()
          }
          if (fields["data"] !== undefined) frames.push({ id: fields["id"] === undefined ? null : Number(fields["id"]), event: fields["event"] ?? "", data: JSON.parse(fields["data"]) })
        }
      }
    } catch {
      // Stopped by the case.
    }
    state.ended = true
  })()
  open.push(() => controller.abort())
  return { frames, state, numbers: () => frames.filter((frame) => frame.id !== null).map((frame) => frame.id) }
}

// A socket (R6) with its `auth` from 0: its frames and its close.
const socketOf = async (s: Serving, chat: string, token: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/v1/chats/${chat}/socket`)
  const frames: Array<Record<string, unknown>> = []
  const closed: { code: number | null } = { code: null }
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)))
  ws.onclose = (event) => {
    closed.code = event.code
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("the socket did not open"))
  })
  ws.send(JSON.stringify({ type: "auth", token, after: 0 }))
  expect(await within(() => frames.some((frame) => frame["type"] === "ready"), 5_000)).toBe(true)
  open.push(() => ws.close())
  return { frames, closed, numbers: () => frames.filter((frame) => typeof frame["n"] === "number").map((frame) => frame["n"]) }
}

// The child processes of `pid`, of each of its threads.
const children = (pid: number) =>
  fs.readdirSync(`/proc/${pid}/task`).flatMap((task) => fs.readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(" ")).filter((one) => one !== "")

const upTo = (n: number) => Array.from({ length: n }, (_, k) => k + 1)
const launches = (file: string) => rows<{ ended: number | null; why: string | null }>(file, "select ended, why from everchat_launch order by n")

// A raw request with the head that the case gives: the status of its answer.
const raw = (port: number, head: string) =>
  new Promise<number>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(head + "\r\nConnection: close\r\n\r\n"))
    let got = ""
    socket.on("data", (chunk) => {
      got += chunk.toString("latin1")
    })
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? 0)))
    socket.on("error", reject)
  })

// What a whole run printed: the one address on the standard output; on the
// standard error the person's line, then the host's lines in logfmt. No
// line holds a token, the secret (no run of 20 or more letters, digits,
// `+`, `/`, `_` or `,`: a token, a secret in hex or base64, a start
// value), or a text of a message; the start value is in the one address.
const outputs = (s: Serving, home: string, secrets: ReadonlyArray<string>) => {
  expect(s.out.text).toBe(s.url + "\n")
  expect(s.err.text.startsWith(PERSON(home))).toBe(true)
  const logged = s.err.text.slice(PERSON(home).length).split("\n").filter((line) => line !== "")
  for (const line of logged) expect([line, /^timestamp=\S+ level=[A-Z]+ fiber=#\d+ message=/.test(line)]).toEqual([line, true])
  const all = s.out.text + s.err.text
  expect(all.split(s.start).length).toBe(2)
  for (const secret of secrets) expect([secret, all.includes(secret)]).toEqual([secret, false])
  const runs = s.err.text.replaceAll(home, "<home>").match(/[A-Za-z0-9+/_,]{20,}/g) ?? []
  expect(runs).toEqual([])
  return logged
}

const DATE = "return await date(0)"

// (a)
test("(a) the start: one line on the standard output, http://127.0.0.1:<port>/<start>/, and the page at that address with its policy; serve.db 0600 in the home 0700, which it made", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const s = await serving(at, server.address)
  expect(s.out.text).toMatch(ADDRESS)
  expect(s.port).toBeGreaterThan(0)
  const page = await fetch(s.url)
  expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"])
  const policy = page.headers.get("content-security-policy") ?? ""
  expect(policy.split("; ").map((part) => part.split(" ")[0])).toEqual(["default-src", "script-src", "style-src", "connect-src", "base-uri", "form-action", "frame-ancestors"])
  expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/]{43}='/)
  expect(policy).toContain("connect-src 'self'")
  expect(await page.text()).toContain("<title>EverChat</title>")
  expect(fs.statSync(at.home).mode & 0o777).toBe(0o700)
  expect(fs.statSync(path.join(at.home, FILE)).mode & 0o777).toBe(0o600)
  // No chat yet: the terminal's file is not made.
  expect(fs.existsSync(at.file)).toBe(false)
  s.proc.kill("SIGTERM")
  expect(await s.proc.exited).toBe(130)
  outputs(s, at.home, [])
}, 20_000)

// (b)
test("(b) the round trip as the page does it: R9 a chat, R10 a token, R1 a message whose turn runs a program that calls date in the sandbox, then a text; R4 and R6 give its events with each number once; a program that calls shell fails and starts no process", async () => {
  const at = place()
  const SHELL = `return await shell("touch ${at.work}/shell.txt")`
  const server = fake((n) => (n === 1 ? program("c1", DATE) : n === 3 ? program("c3", SHELL) : text(n === 2 ? "It is that date." : "It failed.")))
  const s = await serving(at, server.address)
  const chat = await newChat(s)
  expect(chat).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const { status, body } = await tokenFor(s, [chat])
  expect(status).toBe(200)
  const stream = await streamOf(s, chat, body.token)
  const socket = await socketOf(s, chat, body.token)
  const sent = await say(s, chat, body.token, "what is the date?")
  expect(sent.status).toBe(200)
  expect(await within(() => stream.numbers().length >= 7 && socket.numbers().length >= 7, 10_000)).toBe(true)
  expect(stream.numbers()).toEqual(upTo(7))
  expect(socket.numbers()).toEqual(upTo(7))
  expect(stream.frames.filter((frame) => frame.id !== null).map((frame) => frame.event)).toEqual(["accepted", "start", "call", "message", "message", "message", "end"])
  // The sandbox's worker ran the program: its echo is the date.
  const echo = stream.frames.find((frame) => (frame.data["message"] as { kind?: string } | undefined)?.kind === "echo")
  expect((echo?.data["message"] as { text: string }).text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  expect(server.bodies[0].model).toBe("gpt-6.1-sol")
  // A program that calls shell: the sandbox's error, and nothing ran.
  expect((await say(s, chat, body.token, "touch a file")).status).toBe(200)
  expect(await within(() => stream.numbers().length >= 14 && socket.numbers().length >= 14, 10_000)).toBe(true)
  expect(stream.numbers()).toEqual(upTo(14))
  expect(socket.numbers()).toEqual(upTo(14))
  expect(JSON.stringify(server.bodies[3].input)).toMatch(/shell.*not defined|not defined.*shell/)
  expect(fs.existsSync(path.join(at.work, "shell.txt"))).toBe(false)
  expect(children(s.proc.pid)).toEqual([])
  // The chat is the local tenant's, in serve.db, with its four kinds.
  const file = path.join(at.home, FILE)
  expect(rows<{ tenant: string }>(file, "select lower(hex(tenant)) as tenant from everchat_chat").map((row) => row.tenant)).toEqual([TENANT.replaceAll("-", "")])
  s.proc.kill("SIGTERM")
  expect(await s.proc.exited).toBe(130)
}, 30_000)

// (c)
test("(c) a wrong Host (localhost:<port>, a name) gets 403 on the page, R9 and R1; the right one 200; the server does not answer on another address of the machine", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const s = await serving(at, server.address)
  const page = `GET /${s.start}/ HTTP/1.1`
  expect(await raw(s.port, `${page}\r\nHost: 127.0.0.1:${s.port}`)).toBe(200)
  for (const host of [`localhost:${s.port}`, "example.com", `127.0.0.1:${s.port + 1}`, "127.0.0.1"]) {
    expect([host, await raw(s.port, `${page}\r\nHost: ${host}`)]).toEqual([host, 403])
    expect([host, await raw(s.port, `POST /${s.start}/chats HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${s.origin}\r\nContent-Length: 0`)]).toEqual([host, 403])
    expect([host, await raw(s.port, `GET /v1/chats/${TENANT} HTTP/1.1\r\nHost: ${host}`)]).toEqual([host, 403])
  }
  const others = Object.values(os.networkInterfaces()).flat().filter((one) => one !== undefined && one.family === "IPv4" && !one.internal).map((one) => one!.address)
  if (others.length === 0) console.log("(c): this machine has no other IPv4 address: the case of another address is not run")
  for (const address of others) {
    const got = await fetch(`http://${address}:${s.port}/${s.start}/`).then((answer) => answer.status, () => "refused")
    expect([address, got]).toEqual([address, "refused"])
  }
  s.proc.kill("SIGTERM")
  expect(await s.proc.exited).toBe(130)
}, 20_000)

// (d)
test("(d) a port in use: the message, the code 1, an empty standard output", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const port = new URL(server.address).port
  const proc = Bun.spawn([...PROGRAM, "serve", "--port", port], { cwd: at.work, env: env(at, server.address), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect([code, out]).toEqual([1, ""])
  expect(err).toMatch(new RegExp(`^everchat: the host could not listen on port ${port} \\(.*\\)\\. Give another port with --port\\.\\n$`))
}, 20_000)

// (e)
test("(e) the stop by SIGINT, SIGTERM and SIGHUP, each with a stream and a socket connected: close with stop, 1001, the code 130, no process left, each launch ended; the next start on the same home finds its chats, and the earlier start's token and start value open nothing", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const file = path.join(at.home, FILE)
  let before: { readonly s: Serving; readonly chat: string; readonly token: string } | undefined
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const s = await serving(at, server.address)
    if (before !== undefined) {
      // The earlier start's chat is there; its token and its start value open nothing.
      const again = await tokenFor(s, [before.chat])
      expect(again.status).toBe(200)
      const snapshot = await fetch(s.api + before.chat, { headers: { authorization: "Bearer " + again.body.token } })
      expect(snapshot.status).toBe(200)
      expect(JSON.stringify(await snapshot.json())).toContain("Hello.")
      expect((await fetch(s.api + before.chat, { headers: { authorization: "Bearer " + before.token } })).status).toBe(401)
      expect((await fetch(`${s.origin}/${before.s.start}/`)).status).toBe(404)
      expect(s.start).not.toBe(before.s.start)
    }
    const chat = await newChat(s)
    const { body } = await tokenFor(s, [chat])
    const stream = await streamOf(s, chat, body.token)
    const socket = await socketOf(s, chat, body.token)
    expect((await say(s, chat, body.token, "hello " + signal)).status).toBe(200)
    // accepted, start, the text's message, end.
    expect(await within(() => stream.numbers().length >= 4 && socket.numbers().length >= 4, 10_000)).toBe(true)
    expect(children(s.proc.pid)).toEqual([])
    s.proc.kill(signal)
    expect([signal, await s.proc.exited]).toEqual([signal, 130])
    expect(await within(() => stream.state.ended && socket.closed.code !== null, 5_000)).toBe(true)
    expect([signal, stream.frames.at(-1)]).toEqual([signal, { id: null, event: "close", data: { type: "close", reason: "stop" } }])
    expect([signal, socket.closed.code]).toEqual([signal, 1001])
    expect(() => process.kill(s.proc.pid, 0)).toThrow()
    const ended = launches(file)
    expect([signal, ended.length > 0, ended.filter((one) => one.ended === null)]).toEqual([signal, true, []])
    outputs(s, at.home, [body.token, "hello " + signal])
    before = { s, chat, token: body.token }
  }
}, 40_000)

// (f)
test("(f) the outputs of a whole run: the address alone on the standard output; on the standard error the person's line, then the host's lines; no token, no secret, no text of a message, and the start value one time", async () => {
  const at = place()
  const server = fake((n) => (n === 1 ? program("c1", DATE) : text("The answer of the model.")))
  const s = await serving(at, server.address)
  const chat = await newChat(s)
  const { body } = await tokenFor(s, [chat])
  expect((await say(s, chat, body.token, "the text of the person")).status).toBe(200)
  expect(await within(() => server.bodies.length === 2, 10_000)).toBe(true)
  // Two refusals, each with its line of the gate: no Origin on R9, and a
  // token with a wrong signature on R2.
  expect((await fetch(s.url + "chats", { method: "POST" })).status).toBe(403)
  const forged = body.token.slice(0, -4) + (body.token.endsWith("AAAA") ? "BBBB" : "AAAA")
  expect((await fetch(s.api + chat, { headers: { authorization: "Bearer " + forged } })).status).toBe(401)
  s.proc.kill("SIGINT")
  expect(await s.proc.exited).toBe(130)
  const logged = outputs(s, at.home, [body.token, forged, body.token.split(".")[2]!, "the text of the person", "The answer of the model."])
  // The host's own lines are there: the gate's, by route and status.
  expect(logged.some((line) => line.includes(`message="the gate's answer" route=R9 status=403`))).toBe(true)
  expect(logged.some((line) => line.includes("route=R2 status=401"))).toBe(true)
}, 20_000)

// (g)
test("(g) a launch of the terminal, of pipe mode and of the inspector loads no module of the host: the static imports from main.ts reach no file of packages/server and not serve.ts, which main.ts imports by a dynamic import only", () => {
  const scanner = new Bun.Transpiler({ loader: "ts" })
  const main = path.join(import.meta.dir, "..", "src", "main.ts")
  const serve = path.join(import.meta.dir, "..", "src", "serve.ts")
  const server = fs.realpathSync(path.join(import.meta.dir, "..", "..", "server")) + path.sep
  const seen = new Set<string>()
  const dynamic: Array<string> = []
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const one of scanner.scanImports(fs.readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (one.path.startsWith("node:") || one.path.startsWith("bun:")) continue
      const to = fs.realpathSync(Bun.resolveSync(one.path, path.dirname(file)))
      if (one.kind === "dynamic-import") {
        if (file === main) dynamic.push(to)
        continue
      }
      if (to.includes(path.sep + "node_modules" + path.sep) || !to.endsWith(".ts")) continue
      walk(to)
    }
  }
  walk(main)
  expect(seen.size).toBeGreaterThan(10)
  expect([...seen].filter((file) => file.startsWith(server) || file === serve)).toEqual([])
  expect(dynamic).toContain(serve)
})

// (h)
test("(h) the inspector on a home with no chat fails with NoHome, and says so", async () => {
  const at = place()
  const saved = process.env.EVERCHAT_HOME
  process.env.EVERCHAT_HOME = at.home
  try {
    const exit = await Effect.runPromiseExit(
      Command.runWith(command, { version: VERSION })(["inspect", "--port", "0"]).pipe(Effect.provide(BunServices.layer), Effect.provide(Logger.layer([])))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(NoHome)
    expect((error as NoHome)._tag).toBe("NoHome")
  } finally {
    if (saved === undefined) delete process.env.EVERCHAT_HOME
    else process.env.EVERCHAT_HOME = saved
  }
  const proc = Bun.spawn([...PROGRAM, "inspect", "--port", "0"], { cwd: at.work, env: env(at, undefined), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect([code, out]).toEqual([1, ""])
  expect(err).toBe(`everchat: no chat in ${at.home}: the inspector shows a chat that EverChat has started. EVERCHAT_HOME names another home.\n`)
  expect(fs.existsSync(at.home)).toBe(false)
})

// (i)
test("(i) the server has the numbers of serverOptions: a socket's frame whose header says more than 524,288 bytes is refused at its header, with 1009, before its payload comes", async () => {
  const at = place()
  const server = fake(() => text("Hello."))
  const s = await serving(at, server.address)
  const chat = await newChat(s)
  const socket = net.connect(s.port, "127.0.0.1")
  open.push(() => socket.destroy())
  const got: Array<Buffer> = []
  const state = { ended: false }
  socket.on("data", (chunk: Buffer) => got.push(chunk))
  socket.on("close", () => {
    state.ended = true
  })
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
  socket.write(
    `GET /v1/chats/${chat}/socket HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
  )
  expect(await within(() => Buffer.concat(got).includes("\r\n\r\n"), 5_000)).toBe(true)
  expect(Buffer.concat(got).toString("latin1")).toStartWith("HTTP/1.1 101")
  got.length = 0
  // A text frame, masked, of 524,289 bytes by its header, and 16 of them sent.
  const head = Buffer.alloc(14)
  head[0] = 0x81
  head[1] = 0x80 | 127
  head.writeBigUInt64BE(524_289n, 2)
  socket.write(Buffer.concat([head, Buffer.alloc(16, 0x20)]))
  // Bun's own refusal comes at once; with Bun's bound it would wait for the rest.
  expect(await within(() => Buffer.concat(got).length >= 4 || state.ended, 2_000)).toBe(true)
  const frame = Buffer.concat(got)
  expect([frame[0], frame.length >= 4 ? frame.readUInt16BE(2) : null]).toEqual([0x88, 1009])
  s.proc.kill("SIGTERM")
  expect(await s.proc.exited).toBe(130)
}, 20_000)

// The help.
test("the usage names serve, its port and the rule of one process for a home", async () => {
  const at = place()
  const help = Bun.spawn([...PROGRAM, "serve", "--help"], { cwd: at.work, env: env(at, undefined), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(help.stdout).text(), help.exited])
  expect(code).toBe(0)
  expect(out).toContain("--port")
  expect(out).toContain("4681")
  expect(out).toContain("Run one everchat serve for a home")
  const root = Bun.spawn([...PROGRAM, "--help"], { cwd: at.work, env: env(at, undefined), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  expect(await new Response(root.stdout).text()).toContain("serve")
  expect(fs.existsSync(at.home)).toBe(false)
})
