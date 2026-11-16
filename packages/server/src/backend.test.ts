// The backend's functions (docs/host.md, section 6): a new tenant's UUID, a
// chat made over the SQLite store and read back by its tenant (and not by
// another), and `makeToken`, the token entry's own function.

import { afterAll, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { chatsLayer } from "@everchat/sqlite/bun"
import { Chats, NoChat, type Pick } from "@everchat/core/store"
import * as backend from "./backend.ts"
import * as token from "./token.ts"

const PICK: Pick = { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const home = fs.mkdtempSync(path.join(os.tmpdir(), "everchat-backend-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

test("makeTenant gives a new UUIDv4 in lower case at each call", () => {
  const tenants = Array.from({ length: 100 }, () => backend.makeTenant())
  for (const tenant of tenants) expect(tenant).toMatch(UUID_V4)
  expect(new Set(tenants).size).toBe(100)
})

test("makeChat makes a chat of the tenant over the SQLite store: its tenant reads it back; a second tenant does not find it (NoChat)", async () => {
  const tenant = backend.makeTenant()
  const other = backend.makeTenant()
  const got = await Effect.runPromise(Effect.gen(function*() {
    const chats = yield* Chats
    const chat = yield* backend.makeChat(chats, tenant, PICK)
    const read = yield* (yield* chats.reads(tenant, chat)).chat
    const second = yield* backend.makeChat(chats, tenant, PICK)
    const missing = yield* Effect.flip(chats.reads(other, chat))
    return { chat, read, second, missing }
  }).pipe(Effect.provide(chatsLayer(path.join(home, "chats.db")))))
  expect(got.chat).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(got.read).toMatchObject({ uuid: got.chat, pick: PICK })
  expect(got.second).not.toBe(got.chat)
  expect(got.missing).toBeInstanceOf(NoChat)
})

test("makeToken of the backend is the token entry's makeToken, and its token is verified for the chat", async () => {
  expect(backend.makeToken).toBe(token.makeToken)
  expect(backend.TokenRefused).toBe(token.TokenRefused)
  // A made-up secret, and a now in milliseconds.
  const secret = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 3 * i + 1))
  const now = 1_800_000_000_000
  const claims = { tenant: backend.makeTenant(), chats: [backend.makeTenant()], exp: now / 1000 + 600 }
  const verified = await Effect.runPromise(
    Effect.andThen(TestClock.setTime(now), backend.makeToken(secret, claims)).pipe(
      Effect.flatMap((made) => token.verifyToken(secret, made, now)),
      Effect.provide(TestClock.layer())
    )
  )
  expect(verified).toEqual(claims)
})
