// Inference gateway
// =================
// The tag of the author's inference gateway, its address and its key, as the
// wire (openai.ts) takes them, and the one form of the address. Every
// request to a model goes through it, for both vendors.
//
// Where the address and the key come from is not this package's: the local
// program reads them from its environment and a file
// (packages/local/src/gateway.ts).
//
// The key is a secret. It is held as a `Redacted` value, so a log or an
// error that prints this service shows no key.
//
// The address follows the rules of the factory's bridge (everturn,
// packages/bridge/src/proxy-settings.ts), so both read one file the same
// way: http or https only; no user name, password, query or fragment; a
// final `/v1` and final slashes are removed. The OpenAI route is then
// `<address>/v1/responses`.

import { Context, Effect, type Redacted, Schema } from "effect"

// The message never holds a value from the file or from the environment.
export class GatewayError extends Schema.TaggedError<GatewayError>()("GatewayError", {
  message: Schema.String
}) {}

// The inference gateway's address in its one form, or why it is refused.
export const address = (text: string): Effect.Effect<string, GatewayError> => {
  const refuse = (why: string) => Effect.fail(new GatewayError({ message: "the inference gateway's address " + why }))
  if (text.includes("?") || text.includes("#")) {
    return refuse("has a query or a fragment")
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return refuse("is not a URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse("is not http or https")
  }
  if (url.username !== "" || url.password !== "" || text.includes("@")) {
    return refuse("has a user name or a password")
  }
  return Effect.succeed(text.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, ""))
}

export class Gateway extends Context.Service<Gateway, {
  readonly address: string // with no final slash and no final /v1
  readonly key: Redacted.Redacted<string>
}>()("everchat/gateway/Gateway") {}
