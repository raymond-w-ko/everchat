// Tests of the inference gateway's address and key: where they come from, what is
// refused, and that the key stays out of sight.

import { expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { address, file, Gateway, GatewayError, KEY_VARIABLE, URL_VARIABLE } from "./gateway.ts"

const KEY = "sk-secret-key-0123456789"

const proxy = (content: string) => {
  const name = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-gateway-")), "proxy.json")
  fs.writeFileSync(name, content)
  return name
}

const read = (env: Record<string, string | undefined>, filename: string) => Effect.runPromise(Gateway.read(env, filename))
const refused = (env: Record<string, string | undefined>, filename: string) => Effect.runPromise(Effect.flip(Gateway.read(env, filename)))

test("the inference gateway file is ~/.config/ai/proxy.json", () => {
  expect(file("/home/someone")).toBe("/home/someone/.config/ai/proxy.json")
})

test("the address loses a final /v1 and final slashes, as in the factory's bridge", async () => {
  const cases: Array<[string, string]> = [
    ["http://gw.test:4000", "http://gw.test:4000"],
    ["http://gw.test:4000/", "http://gw.test:4000"],
    ["https://gw.test/v1", "https://gw.test"],
    ["https://gw.test/V1///", "https://gw.test"],
    ["https://gw.test/proxy/v1/", "https://gw.test/proxy"],
    ["https://gw.test/v1/v1", "https://gw.test/v1"]
  ]
  for (const [given, expected] of cases) {
    expect(await Effect.runPromise(address(given))).toBe(expected)
  }
})

test("an address that is not plain http or https is refused", async () => {
  for (const bad of ["gw.test:4000", "ftp://gw.test", "https://user:pass@gw.test", "https://user@gw.test", "https://gw.test/v1?x=1", "https://gw.test/#top", ""]) {
    expect(await Effect.runPromise(Effect.flip(address(bad)))).toBeInstanceOf(GatewayError)
  }
})

test("the environment comes first, and the file fills what the environment lacks", async () => {
  const name = proxy(JSON.stringify({ base_url: "https://file.test/v1", api_key: KEY, more: "is skipped" }))
  const both = await read({ [URL_VARIABLE]: "http://env.test/v1/", [KEY_VARIABLE]: "env-key" }, "/no/such/file")
  expect([both.address, Redacted.value(both.key)]).toEqual(["http://env.test", "env-key"])
  const none = await read({}, name)
  expect([none.address, Redacted.value(none.key)]).toEqual(["https://file.test", KEY])
  const half = await read({ [URL_VARIABLE]: "http://env.test" }, name)
  expect([half.address, Redacted.value(half.key)]).toEqual(["http://env.test", KEY])
})

test("a missing or bad file is an error that names the file and holds no value from it", async () => {
  const missing = await refused({}, "/no/such/proxy.json")
  expect(missing.message).toContain("/no/such/proxy.json")
  expect(missing.message).toContain(URL_VARIABLE)
  for (const content of ["not json", "[]", "null", JSON.stringify({ base_url: 5, api_key: KEY }), JSON.stringify({ base_url: "https://gw.test" })]) {
    const error = await refused({}, proxy(content))
    expect(error).toBeInstanceOf(GatewayError)
    expect(error.message).not.toContain(KEY)
  }
  const bad = await refused({}, proxy(JSON.stringify({ base_url: "https://user:" + KEY + "@gw.test", api_key: KEY })))
  expect(bad.message).not.toContain(KEY)
  expect((await refused({}, proxy(JSON.stringify({ base_url: "https://gw.test", api_key: "" })))).message).toBe("the inference gateway's key is empty")
})

test("the key does not show when the inference gateway is printed", async () => {
  const gateway = await read({ [URL_VARIABLE]: "http://env.test", [KEY_VARIABLE]: KEY }, "/no/such/file")
  expect(JSON.stringify(gateway) + String(gateway.key) + Bun.inspect(gateway)).not.toContain(KEY)
})

test("the layer takes the key out of the process's environment", async () => {
  const before = { url: process.env[URL_VARIABLE], key: process.env[KEY_VARIABLE] }
  process.env[URL_VARIABLE] = "http://env.test/v1"
  process.env[KEY_VARIABLE] = KEY
  try {
    const gateway = await Effect.runPromise(Gateway.use((gateway) => Effect.succeed(gateway)).pipe(Effect.provide(Gateway.layer)))
    expect([gateway.address, Redacted.value(gateway.key)]).toEqual(["http://env.test", KEY])
    expect(process.env[KEY_VARIABLE]).toBeUndefined()
  } finally {
    if (before.url === undefined) delete process.env[URL_VARIABLE]
    else process.env[URL_VARIABLE] = before.url
    if (before.key !== undefined) process.env[KEY_VARIABLE] = before.key
  }
})
