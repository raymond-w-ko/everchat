// The tokens of the host (docs/host.md, section 6). This entry,
// `@everchat/server/token`, gives `makeToken(secret, claims)`, with its error
// `TokenRefused`, and `verifyToken(secret, token, now)`, with its error
// `TokenFailed`. The host, a backend and the local command use it.
//
// A token is a JWT signed with HS256 by the deployment's secret: the header
// `{"alg":"HS256","typ":"JWT"}`, and the claims `tenant` (a UUID), `chats`
// (1 to 64 UUIDs, each once) and `exp` (whole seconds since 1970). It is
// the one wall between a client and a tenant's chats. No error, log line or
// thrown text of this file holds the token, a claim or the secret: the host
// answers one `401` for each failure and writes the check's number to its
// diagnostics.
//
// The secret's length (32 bytes or more) is the check of `Host.layer` at its
// start; these functions sign and verify with the secret that they get
// (lead, ec-3xoc2, 3).

import { Clock, Effect, Layer, Redacted, Result, Schema } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { type Jwk, Jws, Jwt } from "effect/jose"

// The bound of a token, in bytes, and of its chats.
const MAX_BYTES = 4096
const MAX_CHATS = 64
// The longest life of a token: one hour, in milliseconds.
const MAX_LIFE = 3_600_000

// A UUID as text: 36 characters, lower-case hex digits in groups of
// 8-4-4-4-12, as the store gives it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Three parts of base64url (no padding) joined by dots. A part may be empty
// (no bytes), as the signature of `alg` `none` is: check 3 refuses that.
const COMPACT = /^[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*$/

// The claims of a token, as `makeToken` takes them and `verifyToken` gives
// them.
export interface Claims {
  readonly tenant: string
  readonly chats: ReadonlyArray<string>
  readonly exp: number // whole seconds since 1970
}

// Why `makeToken` made no token: the first of these, in this order, that
// holds.
export class TokenRefused extends Schema.TaggedError<TokenRefused>()("TokenRefused", {
  reason: Schema.Literals(["chats_empty", "chats_too_many", "chat_twice", "bad_uuid", "exp_not_whole", "exp_past", "exp_far", "too_large"])
}) {}

// Why `verifyToken` refused a token: the number, 2 to 7, of the first check
// that failed (docs/host.md, section 6, "The checks"). Check 1, the header
// `Authorization`, is the caller's.
export class TokenFailed extends Schema.TaggedError<TokenFailed>()("TokenFailed", {
  check: Schema.Literals([2, 3, 4, 5, 6, 7])
}) {}

// HMAC over Web Crypto (`globalThis.crypto`), for each call.
const crypto = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))

// The HS256 key of the secret's bytes. Any length but none: the length is
// `Host.layer`'s check.
const keyOf = (secret: Redacted.Redacted<Uint8Array>): Effect.Effect<Jwk.SecretKey<"HS256">, unknown> =>
  Effect.map(Mac.key(Mac.hmacSha256, Redacted.value(secret)), (key) => ({ _tag: "SecretKey", algorithm: "HS256", kid: undefined, key }))

// The claims as they are signed: the three names, in this order.
const Signed = Schema.Struct({ tenant: Schema.String, chats: Schema.Array(Schema.String), exp: Schema.Number })

// A token of `claims`, signed with `secret`, or the first reason that the
// host would refuse it at this instant (Effect's `Clock`): so `verifyToken`
// takes each token that this gives, at the same instant.
export const makeToken = (
  secret: Redacted.Redacted<Uint8Array>,
  claims: Claims
): Effect.Effect<string, TokenRefused> =>
  Effect.gen(function*() {
    const { tenant, chats, exp } = claims
    const refuse = (reason: TokenRefused["reason"]) => Effect.fail(new TokenRefused({ reason }))
    if (chats.length === 0) return yield* refuse("chats_empty")
    if (chats.length > MAX_CHATS) return yield* refuse("chats_too_many")
    if (new Set(chats).size !== chats.length) return yield* refuse("chat_twice")
    if (!UUID.test(tenant) || !chats.every((chat) => UUID.test(chat))) return yield* refuse("bad_uuid")
    if (!Number.isSafeInteger(exp)) return yield* refuse("exp_not_whole")
    const now = yield* Clock.currentTimeMillis
    if (exp * 1000 <= now) return yield* refuse("exp_past")
    if (exp * 1000 > now + MAX_LIFE) return yield* refuse("exp_far")
    const key = yield* Effect.orDie(Effect.mapError(keyOf(secret), () => new Error("the secret is no HS256 key")))
    const token = Redacted.value(
      yield* Effect.orDie(Effect.mapError(
        Jwt.sign(Signed, { tenant, chats: [...chats], exp }, key, { typ: "JWT" }).pipe(Effect.provide(crypto)),
        () => new Error("the token could not be signed")
      ))
    )
    // The token is base64url: one byte for each character. Claims that pass
    // the checks above give at most 3,519 bytes (64 chats and an `exp` of 16
    // digits): the bound holds for a later form of the claims.
    if (token.length > MAX_BYTES) return yield* refuse("too_large")
    return token
  })

// The text of a part of base64url, or undefined.
const textOf = (part: string): string | undefined => {
  const text = Base64Url.decodeString(part)
  return Result.isSuccess(text) ? text.success : undefined
}

// The JSON of a text, or undefined.
const jsonOf = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The claims of check 5: `tenant`, `chats` and `exp` of their forms, or
// undefined.
const claimsOf = (json: unknown): Claims | undefined => {
  if (!isObject(json)) return undefined
  const { tenant, chats, exp } = json
  if (typeof tenant !== "string" || !UUID.test(tenant)) return undefined
  if (!Array.isArray(chats) || chats.length === 0 || chats.length > MAX_CHATS) return undefined
  if (!chats.every((chat): chat is string => typeof chat === "string" && UUID.test(chat))) return undefined
  if (new Set(chats).size !== chats.length) return undefined
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return undefined
  return { tenant, chats, exp }
}

// The claims of `token` (the text after `Bearer `), signed with `secret`,
// at `now` (milliseconds since 1970), or the number of the first check that
// failed:
//
// 2. at most 4,096 bytes, and three parts of base64url joined by dots;
// 3. the header's `alg` is `HS256` (not `none`, nor any other);
// 4. the signature is HS256 of the first two parts with the secret,
//    compared in constant time (`Jws.verify` of `effect/jose`);
// 5. the claims are JSON, with `tenant`, `chats` and `exp` of their forms;
// 6. `exp` is after now, and at most one hour after now;
// 7. `nbf`, when it is there, is a whole number of seconds and not after
//    now.
//
// `Jwt.verify` is not used: it checks `exp` and `nbf` before the claims'
// forms, and on its own clock, so its failures do not keep this order.
export const verifyToken = (
  secret: Redacted.Redacted<Uint8Array>,
  token: string,
  now: number
): Effect.Effect<Claims, TokenFailed> =>
  Effect.gen(function*() {
    const fail = (check: TokenFailed["check"]) => Effect.fail(new TokenFailed({ check }))
    // A text of more than 4,096 characters has more than 4,096 bytes; one
    // of the form has one byte for each character.
    if (token.length > MAX_BYTES || !COMPACT.test(token)) return yield* fail(2)
    const parts = token.split(".") as [string, string, string]
    // A part of 4n + 1 characters is no base64url.
    if (parts.some((part) => part.length % 4 === 1)) return yield* fail(2)
    const [header, payload] = parts
    const head = jsonOf(textOf(header))
    if (!isObject(head) || head["alg"] !== "HS256") return yield* fail(3)
    const key = yield* Effect.mapError(keyOf(secret), () => new TokenFailed({ check: 4 }))
    yield* Jws.verify(token, key).pipe(Effect.provide(crypto), Effect.mapError(() => new TokenFailed({ check: 4 })))
    const json = jsonOf(textOf(payload))
    const claims = claimsOf(json)
    if (claims === undefined || !isObject(json)) return yield* fail(5)
    if (!(claims.exp * 1000 > now && claims.exp * 1000 <= now + MAX_LIFE)) return yield* fail(6)
    if (Object.hasOwn(json, "nbf")) {
      const nbf = json["nbf"]
      // A whole number of seconds (lead, ec-cvi82): a fraction fails at any
      // time, before now, at now or after it.
      if (typeof nbf !== "number" || !Number.isInteger(nbf) || nbf * 1000 > now) return yield* fail(7)
    }
    return claims
  })
