// Tests of the inspector as a server: who may read, what each route
// answers, and what it says when a request is wrong.

import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { compactor, inspector, newFile, withMemory } from "../tests/help.ts"
import { Inspect } from "./inspect.ts"
import { Inspector } from "./inspector.ts"
import { Memory } from "./memory.ts"
import { StoreError } from "./store.ts"

const open: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close()
  }
})

// A chat of nine short messages, and the inspector over it.
const serving = async () => {
  const file = newFile()
  await withMemory(file, compactor(() => "a summary"), Effect.gen(function*() {
    yield* (yield* Memory).push(Array.from({ length: 9 }, (_, k) => ({ kind: "user" as const, text: "message " + k })))
  }))
  const made = await inspector(file)
  open.push(made.close)
  return made.url
}

const get = async (address: string, init?: RequestInit) => {
  const response = await fetch(address, init)
  const text = await response.text()
  return { status: response.status, type: response.headers.get("content-type"), headers: response.headers, text, json: () => JSON.parse(text) }
}

test("the address has a token of 32 hex digits, and only a path with the token answers", async () => {
  const url = await serving()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
  const origin = new URL(url).origin
  expect((await get(url)).status).toBe(200)
  expect((await get(url + "api/overview")).status).toBe(200)
  for (const address of [origin + "/", origin + "/api/overview", origin + "/" + "0".repeat(32) + "/", origin + "/" + "0".repeat(32) + "/api/overview", url + "api/nothing", url + "../api/overview"]) {
    const got = await get(address)
    expect([address, got.status, got.text]).toEqual([address, 404, ""])
  }
  // A second inspector has another token.
  const other = await serving()
  expect(new URL(other).pathname).not.toBe(new URL(url).pathname)
  expect((await get(new URL(other).origin + new URL(url).pathname)).status).toBe(404)
})

test("it only reads: no route takes a request that is not a GET", async () => {
  const url = await serving()
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    expect([method, (await get(url + "api/overview", { method })).status]).toEqual([method, 404])
    expect([method, (await get(url, { method })).status]).toEqual([method, 404])
  }
  expect((await get(url + "api/overview")).json().count).toBe(9)
})

test("the page lets only its own script run, and no answer may be kept or sent on", async () => {
  const url = await serving()
  const page = await get(url)
  expect(page.type).toBe("text/html; charset=utf-8")
  expect(page.text).toBe(fs.readFileSync(path.join(import.meta.dir, "inspector.html"), "utf8"))
  // The page has one script, and the policy names it by its hash.
  const scripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  expect(scripts.length).toBe(1)
  expect(page.text.match(/<script/g)?.length).toBe(1)
  const hash = new Bun.CryptoHasher("sha256").update(scripts[0]![1]!).digest("base64")
  const policy = page.headers.get("content-security-policy") ?? ""
  expect(policy.split("; ")).toEqual([
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ])
  // The page loads nothing from another place, and it never makes HTML from a text.
  expect(page.text).not.toMatch(/https?:\/\/|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/)
  for (const answer of [page, await get(url + "api/overview"), await get(url + "api/node?l=9&i=9"), await get(url + "api/node?l=x&i=0")]) {
    expect(answer.headers.get("cache-control")).toBe("no-store")
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer")
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff")
    // No other site may read an answer.
    expect(answer.headers.get("access-control-allow-origin")).toBe(null)
  }
})

test("each route gives the read module's answer as JSON", async () => {
  const url = await serving()
  const json = async (route: string) => {
    const got = await get(url + "api/" + route)
    expect([route, got.status, got.type]).toEqual([route, 200, "application/json"])
    return got.json()
  }
  expect(typeof (await json("version")).version).toBe("number")
  expect((await json("overview")).levels.map((level: { built: number }) => level.built)).toEqual([9, 4, 2, 1])
  const window = await json("window?from=2&to=6&floor=1")
  expect([window.from, window.to, window.floor, window.nodes.length]).toEqual([2, 6, 1, 5])
  expect((await json("window?from=0&to=9")).nodes.length).toBe(16)
  expect((await json("node?l=1&i=2")).ref).toBe("4+2")
  expect((await json("messages?from=3&to=5")).map((one: { text: string }) => one.text)).toEqual(["message 3", "message 4"])
  expect((await json("view?name=chat")).lines.length).toBe(9)
  expect((await json("view?name=seen")).name).toBe("seen")
  expect(await json("turns")).toEqual([])
  expect(await json("turns?before=5&limit=2")).toEqual([])
  expect(await json("usage")).toEqual([])
  expect(await json("usage?before=5&limit=2")).toEqual([])
  expect(await json("diagnostics?limit=3")).toEqual([])
  expect((await json("launches")).length).toBe(1)
})

test("a thing that is not there is 404, and a query that does not fit is 400", async () => {
  const url = await serving()
  for (const route of ["node?l=0&i=9", "node?l=5&i=0", "turn?id=1", "body?id=1"]) {
    const got = await get(url + "api/" + route)
    expect([route, got.status, got.json()]).toEqual([route, 404, { error: "not there" }])
  }
  for (const route of ["node?l=0", "node?l=x&i=0", "node?l=0.5&i=0", "node?l=1e1&i=0", "node?l=%201&i=0", "window?from=0", "view", "view?name=other", "turn", "turn?id=", "messages?from=a&to=b"]) {
    const got = await get(url + "api/" + route)
    expect([route, got.status, typeof got.json().error]).toEqual([route, 400, "string"])
  }
})

test("a read that fails is 500, and it says which read, and not the database's own words", async () => {
  const failed = Effect.fail(new StoreError({ op: "count", cause: new Error("a secret detail of the file") }))
  const failing = { version: failed, overview: failed, launches: () => failed } as unknown as Inspect["Service"]
  const text = await Effect.runPromise(
    Effect.gen(function*() {
      const { url } = yield* Inspector
      return yield* Effect.promise(async () => {
        const got = await get(url + "api/overview")
        return [got.status, got.text]
      })
    }).pipe(Effect.provide(Inspector.layer({ port: 0 }).pipe(Layer.provide(Layer.succeed(Inspect, failing)))))
  )
  expect(text).toEqual([500, JSON.stringify({ error: "the database failed (count)" })])
})

test("a port that is in use fails the start", async () => {
  const url = await serving()
  const port = Number(new URL(url).port)
  const failed = await Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(Inspector.layer({ port }).pipe(Layer.provide(Layer.succeed(Inspect, {} as Inspect["Service"])))))))
  expect([failed._tag, failed.port]).toEqual(["NoPort", port])
  expect(failed.message).toContain("could not listen on port " + port)
  // The first one still serves.
  expect((await get(url + "api/version")).status).toBe(200)
})
