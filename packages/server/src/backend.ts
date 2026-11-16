// What a backend in TypeScript needs to hand out chats (docs/host.md,
// section 6, "The backend's functions"). This entry,
// `@everchat/server/backend`, gives `makeTenant()`, `makeChat(chats,
// tenant, pick)`, and `makeToken` again, the same function as the entry
// `@everchat/server/token`'s. A backend and the local command use it.

import type { Effect } from "effect"
import type { Chats, Pick, StoreError } from "@everchat/core/store"

export { makeToken, TokenRefused } from "./token.ts"

// A new tenant's UUID (a UUIDv4), in lower case. The tenant's row comes with
// its first chat.
export const makeTenant = (): string => crypto.randomUUID().toLowerCase()

// A new chat of `tenant` with its first pick; its UUID. It is `Chats.make`,
// which makes the tenant's row when it is not there.
export const makeChat = (chats: typeof Chats.Service, tenant: string, pick: Pick): Effect.Effect<string, StoreError> =>
  chats.make(tenant, pick)
