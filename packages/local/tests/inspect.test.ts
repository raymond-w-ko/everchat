// The whole program as `everchat inspect`: a process of its own that
// serves the inspector, next to a launch of the chat or with none.
//
// No test here sends a request to a real model (tests/vendor.ts).

import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import * as Database from "@everchat/sqlite/database"
import { VERSION } from "@everchat/sqlite/schema"
import { rows, write } from "./help.ts"
import { env, place, PROGRAM, text, vendor } from "./vendor.ts"

const open: Array<() => unknown> = []
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close()
  }
})

const lines = async (stream: ReadableStream<Uint8Array>, until: (text: string) => boolean) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let all = ""
  while (!until(all)) {
    const { done, value } = await reader.read()
    if (done) break
    all += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  return all
}

// `everchat inspect` on a place, on a free port. It gives the page's
// address, as the program printed it.
const inspect = async (at: ReturnType<typeof place>, args: ReadonlyArray<string> = ["--port", "0"]) => {
  const proc = Bun.spawn([...PROGRAM, "inspect", ...args], { cwd: at.work, env: env(at, undefined), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  open.push(async () => {
    proc.kill("SIGKILL")
    await proc.exited
  })
  const out = await lines(proc.stdout, (all) => all.includes("\n"))
  return { proc, out, url: out.trim() }
}

// The same, to its end: for a start that fails.
const fails = async (at: ReturnType<typeof place>, args: ReadonlyArray<string> = ["--port", "0"]) => {
  const proc = Bun.spawn([...PROGRAM, "inspect", ...args], { cwd: at.work, env: env(at, undefined), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

// An answer of the inspector, as JSON.
const get = async (address: string): Promise<any> => (await fetch(address)).json()

// One launch in pipe mode, to its end.
const chat = async (at: ReturnType<typeof place>, address: string, input: string) => {
  const proc = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, address), stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

test("it serves the page of a chat that no process has open, and a signal ends it", async () => {
  const at = place()
  const server = vendor(() => text("Hello."))
  open.push(server.stop)
  await chat(at, server.address, "hello there\n")
  const before = rows(at.file, "select n as id, ended, why from everchat_launch")
  const { out, proc, url } = await inspect(at)
  // The address alone on the standard output.
  expect(out).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/\n$/)
  const page = await fetch(url)
  expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"])
  expect(await page.text()).toContain("<title>EverChat inspector</title>")
  const overview = await get(url + "api/overview")
  expect([overview.count, overview.live, overview.turn, overview.chat.pick.model]).toEqual([2, false, null, "gpt-test"])
  expect((await get(url + "api/messages?from=0&to=9")).map((one: { kind: string; text: string }) => [one.kind, one.text])).toEqual([["user", "hello there"], ["asst", "Hello."]])
  expect((await get(url + "api/turn?id=1")).items.map((one: { kind: string }) => one.kind)).toEqual(["user", "turn"])
  proc.kill("SIGTERM")
  expect(await proc.exited).toBe(130)
  // It took no launch, and it wrote nothing.
  expect(rows(at.file, "select n as id, ended, why from everchat_launch")).toEqual(before)
  expect((await fetch(url).catch(() => null)) === null).toBe(true)
})

test("it reads a chat while a launch runs it, and that launch goes on", async () => {
  const at = place()
  // The first reply comes at once. The second one starts and does not end.
  const server = vendor((n) => (n === 1 ? text("First answer.") : "hold"))
  open.push(server.stop)
  const running = Bun.spawn([...PROGRAM, "--model", "gpt-test"], { cwd: at.work, env: env(at, server.address), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  open.push(async () => {
    running.kill("SIGKILL")
    await running.exited
  })
  running.stdin.write("first question\n")
  running.stdin.flush()
  await lines(running.stdout, (all) => all.includes("First answer."))
  const { url } = await inspect(at)
  const overview = await get(url + "api/overview")
  expect([overview.count, overview.live, overview.turn, overview.launch.pid]).toEqual([2, true, null, running.pid])
  const version = (await get(url + "api/version")).version
  // The chat goes on while the inspector has the database open.
  running.stdin.write("second question\n")
  running.stdin.flush()
  for (let k = 0; k < 400 && server.bodies.length < 2; k++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(server.bodies.length).toBe(2)
  // The inspector sees the turn that runs, and the request that is asked now.
  let turn = await get(url + "api/turn?id=2")
  for (let k = 0; k < 200 && turn.asked === null; k++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    turn = await get(url + "api/turn?id=2")
  }
  expect([turn.turn.status, turn.asked, turn.items.map((one: { kind: string }) => one.kind)]).toEqual(["running", 1, ["user"]])
  expect((await get(url + "api/version")).version).not.toBe(version)
  const now = await get(url + "api/overview")
  expect([now.count, now.turn, now.live]).toEqual([3, 2, true])
  // The body that it builds is the body that the vendor got.
  const body = (await get(url + "api/body?id=2")).body
  expect(body.input).toEqual(server.bodies[1].input)
  expect(body.prompt_cache_key).toBe(server.bodies[1].prompt_cache_key)
  // The launch ends well with the inspector still there, and the inspector then says so.
  running.kill("SIGTERM")
  expect(await running.exited).toBe(130)
  const after = await get(url + "api/overview")
  expect([after.live, after.launch.why]).toEqual([false, "signal"])
}, 30000)

test("a home with no chat: it says so, and it makes nothing", async () => {
  const at = place()
  const ran = await fails(at)
  expect(ran.code).toBe(1)
  expect(ran.out).toBe("")
  expect(ran.err).toBe(`everchat: no chat in ${at.home}: the inspector shows a chat that EverChat has started. EVERCHAT_HOME names another home.\n`)
  expect(fs.existsSync(at.home)).toBe(false)
})

test("a port that is in use: it says so", async () => {
  const at = place()
  const server = vendor(() => text("Hello."))
  open.push(server.stop)
  await chat(at, server.address, "hello\n")
  const port = new URL(server.address).port
  const ran = await fails(at, ["--port", port])
  expect([ran.code, ran.out]).toEqual([1, ""])
  expect(ran.err).toMatch(new RegExp(`^everchat: the inspector could not listen on port ${port} \\(.*\\)\\. Give another port with --port\\.\\n$`))
})

// A database with the mark of an older schema, in the home of `at`.
const older = async (at: ReturnType<typeof place>) => {
  fs.mkdirSync(at.home, { recursive: true })
  await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer(at.file))))
  write(at.file, `pragma user_version = ${VERSION - 1}`)
}

// The words of the refusal, with the free path that they name.
const refusal = (file: string, free: string) =>
  `everchat: the database ${file} is from another version of EverChat. To start a new chat, move it aside, to a name that is not in use: ${free}\n`

test("a database of an older version: it says what to do, and it changes nothing", async () => {
  const at = place()
  await older(at)
  const before = fs.readFileSync(at.file)
  const ran = await fails(at)
  expect([ran.code, ran.out]).toEqual([1, ""])
  expect(ran.err).toBe(refusal(at.file, at.file + ".old"))
  expect(ran.err).not.toContain("mv ")
  expect(rows(at.file, "pragma user_version")).toEqual([{ user_version: VERSION - 1 }])
  expect(fs.readFileSync(at.file).equals(before)).toBe(true)
})

test("the refusal names a path that is not in use, and gives no command", async () => {
  const at = place()
  await older(at)
  // With <file>.old there: <file>.old.2. Moved there, both files are whole.
  const backup = Buffer.from("an earlier backup")
  fs.writeFileSync(at.file + ".old", backup)
  const second = await fails(at)
  expect(second.err).toBe(refusal(at.file, at.file + ".old.2"))
  const bytes = fs.readFileSync(at.file)
  fs.renameSync(at.file, at.file + ".old.2")
  expect(fs.readFileSync(at.file + ".old").equals(backup)).toBe(true)
  expect(fs.readFileSync(at.file + ".old.2").equals(bytes)).toBe(true)
  // With both there: <file>.old.3. A link that points nowhere is in use.
  await older(at)
  expect((await fails(at)).err).toBe(refusal(at.file, at.file + ".old.3"))
  fs.symlinkSync(path.join(at.home, "nowhere"), at.file + ".old.3")
  expect((await fails(at)).err).toBe(refusal(at.file, at.file + ".old.4"))
  // A home whose path holds a space: both paths as they are, with no quotes.
  const root = place()
  const spaced = { ...root, home: path.join(root.root, "a home"), file: path.join(root.root, "a home", Database.FILE) }
  await older(spaced)
  const ran = await fails(spaced)
  expect(ran.err).toBe(refusal(spaced.file, spaced.file + ".old"))
  expect(ran.err).not.toContain("mv ")
  expect(ran.err).not.toContain("'")
})

test("the refusal names no path that it did not look at: with the first 1000 names in use it names none", async () => {
  // The first n names: <file>.old, <file>.old.2, ..., each a small file
  // with its own bytes.
  const fill = (file: string, n: number) => {
    for (let i = 1; i <= n; i++) fs.writeFileSync(file + ".old" + (i === 1 ? "" : "." + i), "backup " + i)
  }
  // The first 999 in use: the 1000th is free, and named.
  const near = place()
  await older(near)
  fill(near.file, 999)
  expect((await fails(near)).err).toBe(refusal(near.file, near.file + ".old.1000"))
  // The first 1000 in use, and <file>.old.1001 too: no free name is named,
  // and nothing in the home changes.
  const at = place()
  await older(at)
  fill(at.file, 1001)
  // The names of the home, but the two files that SQLite makes next to the
  // database at each open (docs/notes.md, 1).
  const listed = () => fs.readdirSync(at.home).filter((one) => !one.endsWith("-shm") && !one.endsWith("-wal")).sort()
  const names = listed()
  const database = fs.readFileSync(at.file)
  const last = fs.readFileSync(at.file + ".old.1001")
  const ran = await fails(at)
  expect([ran.code, ran.out]).toEqual([1, ""])
  expect(ran.err).toBe(`everchat: the database ${at.file} is from another version of EverChat. To start a new chat, move it aside, to a name that is not in use.\n`)
  expect(ran.err).not.toContain(".old")
  expect(listed()).toEqual(names)
  expect(fs.readFileSync(at.file).equals(database)).toBe(true)
  expect(fs.readFileSync(at.file + ".old.1001").equals(last)).toBe(true)
  expect(rows(at.file, "pragma user_version")).toEqual([{ user_version: VERSION - 1 }])
})

test("the usage names the inspector, and a wrong argument is refused", async () => {
  const at = place()
  const help = await fails(at, ["--help"])
  expect(help.code).toBe(0)
  expect(help.out).toContain("--port")
  expect(help.out).toContain("It only reads the database")
  const root = Bun.spawn([...PROGRAM, "--help"], { cwd: at.work, env: env(at, undefined), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  expect(await new Response(root.stdout).text()).toContain("inspect")
  expect((await fails(at, ["--port", "many"])).code).toBe(2)
  expect(fs.existsSync(at.home)).toBe(false)
})
