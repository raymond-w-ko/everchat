// Inference gateway
// =================
// The address and the key of the author's inference gateway. Every request to a
// model goes through it, for both vendors.
//
// The program reads them from its environment (`EVERCHAT_GATEWAY_URL`,
// `EVERCHAT_GATEWAY_KEY`). When one of them is not there, it reads the file
// `$HOME/.config/ai/proxy.json` (this path on Windows too), which has two
// keys, `base_url` and `api_key`.
//
// The key is a secret. It is held as a `Redacted` value, so a log or an
// error that prints this service shows no key. It never goes in the
// database. The program deletes it from its environment once read, so that
// no shell that the program starts inherits it.
//
// The address follows the rules of the factory's bridge (everturn,
// packages/bridge/src/proxy-settings.ts), so both read one file the same
// way: http or https only; no user name, password, query or fragment; a
// final `/v1` and final slashes are removed. The OpenAI route is then
// `<address>/v1/responses`.

import { Context, Effect, Layer, Redacted, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const URL_VARIABLE = "EVERCHAT_GATEWAY_URL"
export const KEY_VARIABLE = "EVERCHAT_GATEWAY_KEY"

// The inference gateway file's path, from a home directory.
export const file = (home: string): string => path.join(home, ".config", "ai", "proxy.json")

// The message never holds a value from the file or from the environment.
export class GatewayError extends Schema.TaggedError<GatewayError>()("GatewayError", {
  message: Schema.String
}) {}

const File = Schema.fromJsonString(Schema.Struct({ base_url: Schema.String, api_key: Schema.String }))

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
}>()("everchat/gateway/Gateway") {
  // From the given variables, and then from the file at `filename`.
  static readonly read = Effect.fnUntraced(function*(env: Record<string, string | undefined>, filename: string) {
    let [url, key] = [env[URL_VARIABLE], env[KEY_VARIABLE]]
    if (url === undefined || url === "" || key === undefined || key === "") {
      const text = yield* Effect.try({
        try: () => fs.readFileSync(filename, "utf8"),
        catch: () => new GatewayError({ message: `set ${URL_VARIABLE} and ${KEY_VARIABLE}, or write the inference gateway file ${filename}` })
      })
      const read = yield* Schema.decodeUnknownEffect(File)(text).pipe(
        Effect.mapError(() => new GatewayError({ message: `the inference gateway file ${filename} must be a JSON object with the texts base_url and api_key` }))
      )
      url = url === undefined || url === "" ? read.base_url : url
      key = key === undefined || key === "" ? read.api_key : key
    }
    if (key === "") {
      return yield* new GatewayError({ message: "the inference gateway's key is empty" })
    }
    return Gateway.of({ address: yield* address(url), key: Redacted.make(key) })
  })

  // From this process's environment and the person's home. The key leaves
  // the environment.
  static readonly layer = Layer.effect(
    Gateway,
    Effect.suspend(() => Gateway.read(process.env, file(os.homedir()))).pipe(
      Effect.ensuring(Effect.sync(() => {
        delete process.env[KEY_VARIABLE]
      }))
    )
  )
}
