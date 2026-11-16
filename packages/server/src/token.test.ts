// The tokens of the host (docs/host.md, section 6): `verifyToken`'s checks 2
// to 7, each with its number and in their order; `makeToken`'s eight reasons
// and their order; that `makeToken` gives no token that `verifyToken`
// refuses at the same instant; and the two points of section 8 on
// `Jwt.verify`. The secrets are made-up bytes, and the tokens are made here.

import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Result, Schema } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { type Jwk, Jws, Jwt } from "effect/jose"
import { TestClock } from "effect/testing"
import { type Claims, makeToken, TokenFailed, TokenRefused, verifyToken } from "./token.ts"

// Made-up secrets of 32 bytes: the deployment's, and another.
const SECRET = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
const OTHER = Redacted.make(Uint8Array.from({ length: 32 }, (_, i) => 200 - i))
// No bytes: a key that cannot sign. A call that gets to the signature with
// it dies; one that refuses first signs nothing.
const EMPTY = Redacted.make(new Uint8Array(0))

// Now, in milliseconds: half a second into the second `S`.
const S = 1_800_000_000
const NOW = S * 1000 + 500
const HOUR = 3600

const TENANT = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
const chat = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const chatsOf = (count: number) => Array.from({ length: count }, (_, n) => chat(n + 1))
const GOOD: Claims = { tenant: TENANT, chats: [chat(1), chat(2)], exp: S + 600 }

// HMAC over Web Crypto, and an HMAC key of any bytes for HS256 or HS512.
const crypto = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
const keyOf = <A extends "HS256" | "HS512">(secret: Redacted.Redacted<Uint8Array>, algorithm: A) =>
  Effect.map(
    Mac.key(algorithm === "HS256" ? Mac.hmacSha256 : Mac.hmacSha512, Redacted.value(secret)),
    (key) => ({ _tag: "SecretKey", algorithm, kid: undefined, key }) as Jwk.SecretKey<A>
  )

const utf8 = (text: string) => new TextEncoder().encode(text)
const textOf = (part: string) => {
  const text = Base64Url.decodeString(part)
  if (!Result.isSuccess(text)) throw new Error("no base64url")
  return text.success
}
const part = (value: unknown) => Base64Url.encode(typeof value === "string" ? value : JSON.stringify(value))

// A token of any payload (a text as it is, anything else as JSON), signed
// with `secret` by `alg`, with the header `{"alg", "typ": "JWT"}`.
const sign = (
  payload: unknown,
  { secret = SECRET, alg = "HS256" }: { secret?: Redacted.Redacted<Uint8Array>; alg?: "HS256" | "HS512" } = {}
) =>
  Effect.runPromise(Effect.gen(function*() {
    const key = yield* keyOf(secret, alg)
    const bytes = utf8(typeof payload === "string" ? payload : JSON.stringify(payload))
    return Redacted.value(yield* Jws.sign(bytes, key, { typ: "JWT" }))
  }).pipe(Effect.provide(crypto)))

// A token of `alg` `none`: no signature.
const unsigned = (payload: unknown) => `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.`

// What `verifyToken` gives: "ok" and the claims, or the check's number.
const verify = (token: string, now = NOW, secret = SECRET) =>
  Effect.runPromise(Effect.match(verifyToken(secret, token, now), { onSuccess: (claims) => ({ ok: claims }), onFailure: (error) => error.check }))
const checkOf = async (token: string, now = NOW, secret = SECRET) => {
  const got = await verify(token, now, secret)
  return typeof got === "number" ? got : "ok"
}

// What `makeToken` gives at `now` (Effect's clock): the token, or the reason.
const make = (claims: Claims, now = NOW, secret = SECRET) =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(now), makeToken(secret, claims)).pipe(
      Effect.match({ onSuccess: (token) => ({ token }), onFailure: (error) => error.reason }),
      Effect.provide(TestClock.layer())
    )
  )
const reasonOf = async (claims: Claims, now = NOW, secret = SECRET) => {
  const got = await make(claims, now, secret)
  return typeof got === "string" ? got : "token"
}

// A token whose claims carry `pad` characters more: its length grows with
// the pad, so that a length can be hit to the byte.
const padded = (pad: number) => sign({ ...GOOD, pad: "x".repeat(pad) })
const ofLength = async (length: number) => {
  for (let pad = 0; pad < 4000; pad++) {
    const token = await padded(pad)
    if (token.length === length) return token
    if (token.length > length) break
  }
  throw new Error(`no pad gives a token of ${length} bytes`)
}

// verifyToken
// -----------

test("verifyToken: a good token gives its tenant, its chats and its exp; other claims are ignored", async () => {
  expect(await verify(await sign(GOOD))).toEqual({ ok: GOOD })
  expect(await verify(await sign({ ...GOOD, sub: "someone", iat: S, extra: [1, 2] }))).toEqual({ ok: GOOD })
  // 64 chats, and one of them.
  const many = { ...GOOD, chats: chatsOf(64) }
  expect(await verify(await sign(many))).toEqual({ ok: many })
  expect(await verify(await sign({ ...GOOD, chats: [chat(9)] }))).toEqual({ ok: { ...GOOD, chats: [chat(9)] } })
})

test("check 2: a token of 4,097 bytes fails with 2; one of 4,096 bytes passes", async () => {
  expect(await checkOf(await ofLength(4097))).toBe(2)
  expect(await checkOf(await ofLength(4096))).toBe("ok")
})

test("check 2: a token of two parts, of four, or with a character outside base64url fails with 2", async () => {
  const [header, payload, signature] = (await sign(GOOD)).split(".") as [string, string, string]
  expect(await checkOf(`${header}.${payload}`)).toBe(2)
  expect(await checkOf(`${header}.${payload}.${signature}.${signature}`)).toBe(2)
  expect(await checkOf(`${header}.${payload}.${signature}=`)).toBe(2)
  expect(await checkOf(`${header}.${payload}+.${signature}`)).toBe(2)
  expect(await checkOf(`Bearer ${header}.${payload}.${signature}`)).toBe(2)
  // A part of 4n + 1 characters is no base64url.
  expect(await checkOf(`${header}.${payload}.AAAAA`)).toBe(2)
  expect(await checkOf("")).toBe(2)
})

test("check 3: alg none fails with 3", async () => {
  expect(await checkOf(unsigned(GOOD))).toBe(3)
  // With the signature of a good token after it.
  const signature = (await sign(GOOD)).split(".")[2]!
  expect(await checkOf(unsigned(GOOD) + signature)).toBe(3)
})

test("check 3: alg HS512 with the same secret fails with 3", async () => {
  expect(await checkOf(await sign(GOOD, { alg: "HS512" }))).toBe(3)
})

test("check 3: a header that is no JSON, or has no alg, fails with 3", async () => {
  const [, payload, signature] = (await sign(GOOD)).split(".") as [string, string, string]
  expect(await checkOf(`${part("no json")}.${payload}.${signature}`)).toBe(3)
  expect(await checkOf(`${part({ typ: "JWT" })}.${payload}.${signature}`)).toBe(3)
  expect(await checkOf(`${part({ alg: "hs256", typ: "JWT" })}.${payload}.${signature}`)).toBe(3)
  expect(await checkOf(`.${payload}.${signature}`)).toBe(3)
})

test("check 4: a signature of another secret fails with 4", async () => {
  expect(await checkOf(await sign(GOOD, { secret: OTHER }))).toBe(4)
  // And the token of the secret, verified with another.
  expect(await checkOf(await sign(GOOD), NOW, OTHER)).toBe(4)
})

test("check 4: one flipped byte of the payload fails with 4", async () => {
  const [header, payload, signature] = (await sign(GOOD)).split(".") as [string, string, string]
  const bytes = utf8(JSON.stringify(GOOD))
  // The last byte of the exp: another digit, the claims still good.
  const at = bytes.length - 2
  bytes[at] = bytes[at]! ^ 1
  const flipped = Base64Url.encode(bytes)
  expect(flipped).not.toBe(payload)
  expect(await checkOf(`${header}.${flipped}.${signature}`)).toBe(4)
  // An empty signature, and the signature of another token.
  expect(await checkOf(`${header}.${payload}.`)).toBe(4)
  const another = (await sign({ ...GOOD, exp: S + 601 })).split(".")[2]!
  expect(await checkOf(`${header}.${payload}.${another}`)).toBe(4)
})

test("check 5: claims that are no JSON, or no object, fail with 5", async () => {
  expect(await checkOf(await sign("no json"))).toBe(5)
  expect(await checkOf(await sign("{\"tenant\":"))).toBe(5)
  expect(await checkOf(await sign([GOOD]))).toBe(5)
  expect(await checkOf(await sign(null))).toBe(5)
  expect(await checkOf(await sign(42))).toBe(5)
})

test("check 5: each claim missing or of a wrong form fails with 5", async () => {
  const { tenant: _tenant, ...noTenant } = GOOD
  const { chats: _chats, ...noChats } = GOOD
  const { exp: _exp, ...noExp } = GOOD
  const cases: Record<string, unknown> = {
    "no tenant": noTenant,
    "no chats": noChats,
    "no exp": noExp,
    "a tenant in upper case": { ...GOOD, tenant: TENANT.toUpperCase() },
    "a tenant of 35 characters": { ...GOOD, tenant: TENANT.slice(1) },
    "a tenant of 37 characters": { ...GOOD, tenant: TENANT + "0" },
    "a tenant with no dashes": { ...GOOD, tenant: TENANT.replaceAll("-", "0") },
    "a tenant of no hex": { ...GOOD, tenant: TENANT.replaceAll("a", "g") },
    "a tenant as a number": { ...GOOD, tenant: 7 },
    "chats empty": { ...GOOD, chats: [] },
    "65 chats": { ...GOOD, chats: chatsOf(65) },
    "a chat twice": { ...GOOD, chats: [chat(1), chat(2), chat(1)] },
    "a chat in upper case": { ...GOOD, chats: [chat(1), chat(10).toUpperCase()] },
    "a chat of 35 characters": { ...GOOD, chats: [chat(1).slice(1)] },
    "a chat as a number": { ...GOOD, chats: [1] },
    "chats as a text": { ...GOOD, chats: chat(1) },
    "exp as a fraction": { ...GOOD, exp: S + 600.5 },
    "exp as a text": { ...GOOD, exp: String(S + 600) },
    "exp as null": { ...GOOD, exp: null },
    "exp past the safe integers": { ...GOOD, exp: 2 ** 53 }
  }
  const got: Record<string, number | "ok"> = {}
  for (const [name, claims] of Object.entries(cases)) got[name] = await checkOf(await sign(claims))
  expect(got).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, 5])))
})

test("check 6: exp equal to now, or before it, fails with 6; one second after now passes", async () => {
  expect(await checkOf(await sign({ ...GOOD, exp: S }), S * 1000)).toBe(6)
  expect(await checkOf(await sign({ ...GOOD, exp: S }), S * 1000 + 1)).toBe(6)
  expect(await checkOf(await sign({ ...GOOD, exp: S - 1 }), S * 1000)).toBe(6)
  expect(await checkOf(await sign({ ...GOOD, exp: S + 1 }), S * 1000)).toBe("ok")
  // Half a second before the end.
  expect(await checkOf(await sign({ ...GOOD, exp: S + 1 }), NOW)).toBe("ok")
})

test("check 6: exp one second past the hour fails with 6; exp at the hour passes", async () => {
  expect(await checkOf(await sign({ ...GOOD, exp: S + HOUR + 1 }), S * 1000)).toBe(6)
  expect(await checkOf(await sign({ ...GOOD, exp: S + HOUR }), S * 1000)).toBe("ok")
  // At half a second past S, S + HOUR is under the hour, S + HOUR + 1 past it.
  expect(await checkOf(await sign({ ...GOOD, exp: S + HOUR }), NOW)).toBe("ok")
  expect(await checkOf(await sign({ ...GOOD, exp: S + HOUR + 1 }), NOW)).toBe(6)
  // Seconds read as milliseconds: an exp of now in milliseconds is far.
  expect(await checkOf(await sign({ ...GOOD, exp: S * 1000 }), S * 1000)).toBe(6)
})

test("check 7: nbf one second after now fails with 7; nbf at now passes", async () => {
  expect(await checkOf(await sign({ ...GOOD, nbf: S + 1 }), S * 1000)).toBe(7)
  expect(await checkOf(await sign({ ...GOOD, nbf: S }), S * 1000)).toBe("ok")
  expect(await checkOf(await sign({ ...GOOD, nbf: S - 600 }), S * 1000)).toBe("ok")
  // Half a second after now, and not a number.
  expect(await checkOf(await sign({ ...GOOD, nbf: S + 0.5 }), S * 1000)).toBe(7)
  expect(await checkOf(await sign({ ...GOOD, nbf: String(S) }), S * 1000)).toBe(7)
  expect(await checkOf(await sign({ ...GOOD, nbf: null }), S * 1000)).toBe(7)
})

// An nbf is whole seconds (lead, ec-cvi82): a fraction fails at any time.
// NOW is half a second into the second S.

test("check 7: an nbf with a fraction before now fails with 7", async () => {
  expect(await checkOf(await sign({ ...GOOD, nbf: S - 0.5 }))).toBe(7)
  expect(await checkOf(await sign({ ...GOOD, nbf: S - 600.25 }))).toBe(7)
})

test("check 7: an nbf with a fraction at now, .25 of the second that now is in, fails with 7", async () => {
  expect(NOW).toBe(S * 1000 + 500)
  expect(await checkOf(await sign({ ...GOOD, nbf: S + 0.25 }))).toBe(7)
})

test("check 7: an nbf with a fraction at now, .5 of the second that now is in (now itself), fails with 7", async () => {
  expect((S + 0.5) * 1000).toBe(NOW)
  expect(await checkOf(await sign({ ...GOOD, nbf: S + 0.5 }))).toBe(7)
})

test("check 7: an integer nbf before now and at now passes, and one second after now fails with 7", async () => {
  expect(await verify(await sign({ ...GOOD, nbf: S - 1 }))).toEqual({ ok: GOOD })
  expect(await verify(await sign({ ...GOOD, nbf: S }))).toEqual({ ok: GOOD })
  expect(await checkOf(await sign({ ...GOOD, nbf: S }), S * 1000)).toBe("ok")
  expect(await checkOf(await sign({ ...GOOD, nbf: S + 1 }))).toBe(7)
  expect(await checkOf(await sign({ ...GOOD, nbf: S + 1 }), S * 1000)).toBe(7)
})

test("check 6 before 7: a token with exp equal to now and an nbf with a fraction fails with 6", async () => {
  expect(await checkOf(await sign({ ...GOOD, exp: S, nbf: S - 0.5 }), S * 1000)).toBe(6)
  expect(await checkOf(await sign({ ...GOOD, exp: S, nbf: S + 0.25 }), S * 1000)).toBe(6)
})

test("verifyToken: the checks in their order: a token that fails several fails with the first", async () => {
  // Each token fails its check and every one after it.
  const bad = { ...GOOD, tenant: TENANT.toUpperCase(), exp: S - 1, nbf: S + 60 }
  const late = { ...GOOD, exp: S - 1, nbf: S + 60 }
  const big = { ...bad, pad: "x".repeat(4096) }
  const got = {
    2: await checkOf(unsigned(big)),
    3: await checkOf(await sign(bad, { secret: OTHER, alg: "HS512" })),
    4: await checkOf(await sign(bad, { secret: OTHER })),
    5: await checkOf(await sign(bad)),
    6: await checkOf(await sign(late)),
    7: await checkOf(await sign({ ...GOOD, nbf: S + 60 }))
  }
  expect(got).toEqual({ 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 })
})

test("verifyToken: the error holds only the check's number, nothing of the token, its claims or the secret", async () => {
  const token = await sign({ ...GOOD, exp: S - 1 }, { secret: OTHER })
  const exit = await Effect.runPromiseExit(verifyToken(SECRET, token, NOW))
  expect(exit._tag).toBe("Failure")
  const error = await Effect.runPromise(Effect.flip(verifyToken(SECRET, token, NOW)))
  expect(error).toBeInstanceOf(TokenFailed)
  expect({ ...error } as unknown).toEqual({ _tag: "TokenFailed", check: 4 })
  const texts = [String(error), JSON.stringify(error), error.message, String(error.stack), JSON.stringify(exit)]
  const secrets = [Redacted.value(SECRET), Redacted.value(OTHER)].map((bytes) => Base64Url.encode(bytes))
  for (const text of texts) {
    for (const piece of [...token.split("."), TENANT, chat(1), String(S - 1), ...secrets]) expect(text).not.toContain(piece)
  }
})

// makeToken
// ---------

test("makeToken: a token of the header HS256 and JWT and the three claims, which verifyToken takes", async () => {
  const got = await make(GOOD)
  if (typeof got === "string") throw new Error(got)
  const [header, payload] = got.token.split(".") as [string, string, string]
  expect(textOf(header)).toBe("{\"alg\":\"HS256\",\"typ\":\"JWT\"}")
  expect(JSON.parse(textOf(payload))).toEqual(GOOD)
  expect(await verify(got.token)).toEqual({ ok: GOOD })
})

test("makeToken: each of the eight reasons", async () => {
  const cases: Record<string, [Claims, number?]> = {
    chats_empty: [{ ...GOOD, chats: [] }],
    chats_too_many: [{ ...GOOD, chats: chatsOf(65) }],
    chat_twice: [{ ...GOOD, chats: [chat(1), chat(2), chat(1)] }],
    "bad_uuid (a tenant in upper case)": [{ ...GOOD, tenant: TENANT.toUpperCase() }],
    "bad_uuid (a tenant of 35 characters)": [{ ...GOOD, tenant: TENANT.slice(1) }],
    "bad_uuid (a chat in upper case)": [{ ...GOOD, chats: [chat(1), chat(10).toUpperCase()] }],
    "bad_uuid (a chat of no hex)": [{ ...GOOD, chats: [chat(1).replace("0", "g")] }],
    "exp_not_whole (a fraction)": [{ ...GOOD, exp: S + 600.5 }],
    exp_past: [{ ...GOOD, exp: S }, S * 1000],
    "exp_past (before now)": [{ ...GOOD, exp: S }],
    exp_far: [{ ...GOOD, exp: S + HOUR + 1 }, S * 1000]
  }
  const got: Record<string, string> = {}
  for (const [name, [claims, now]] of Object.entries(cases)) got[name] = await reasonOf(claims, now)
  expect(got).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, name.split(" ")[0]!])))
  // The bounds that pass: 64 chats, an exp of one second after now, and of
  // the hour.
  expect(await reasonOf({ ...GOOD, chats: chatsOf(64) })).toBe("token")
  expect(await reasonOf({ ...GOOD, exp: S + 1 }, S * 1000)).toBe("token")
  expect(await reasonOf({ ...GOOD, exp: S + HOUR }, S * 1000)).toBe("token")
})

test("makeToken: too_large: no claims that pass the first seven reasons reach it; the largest token they allow is under 4,096 bytes", async () => {
  // The largest: 64 chats and the largest whole exp, 16 digits, at a now
  // that makes it good. Every claim has a fixed length but `exp`, so no
  // good claims give a longer token: `too_large` guards the bound, and the
  // reason stays for a later form of the claims.
  const exp = Number.MAX_SAFE_INTEGER
  const got = await make({ ...GOOD, chats: chatsOf(64), exp }, exp * 1000 - 100_000)
  if (typeof got === "string") throw new Error(got)
  expect(got.token.length).toBeLessThanOrEqual(4096)
  expect(got.token.length).toBe(3519)
  expect(TokenRefused.fields.reason.literals).toEqual(["chats_empty", "chats_too_many", "chat_twice", "bad_uuid", "exp_not_whole", "exp_past", "exp_far", "too_large"])
})

test("makeToken: an exp of now + 600.5, NaN, Infinity and -Infinity each give exp_not_whole and sign nothing", async () => {
  // With a secret that cannot sign: a call that got to the signature would
  // die, so a reason shows that nothing was signed.
  for (const exp of [S + 600.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect({ exp, reason: await reasonOf({ ...GOOD, exp }, NOW, EMPTY) }).toEqual({ exp, reason: "exp_not_whole" })
  }
  // The secret that cannot sign dies at the signature: the case above
  // proves something.
  await expect(make(GOOD, NOW, EMPTY)).rejects.toThrow("the secret is no HS256 key")
})

test("makeToken: the reasons in their order: claims that fail several give the first", async () => {
  const upper = TENANT.toUpperCase()
  const cases: Record<string, Claims> = {
    chats_empty: { tenant: upper, chats: [], exp: Number.NaN },
    chats_too_many: { tenant: upper, chats: [...chatsOf(64), chat(1).toUpperCase(), chat(1).toUpperCase()], exp: Number.NaN },
    chat_twice: { tenant: upper, chats: ["x", "x"], exp: Number.NaN },
    bad_uuid: { tenant: upper, chats: [chat(1)], exp: Number.NaN },
    exp_not_whole: { ...GOOD, exp: S - 0.5 },
    exp_past: { ...GOOD, exp: S - HOUR * 2 }
  }
  const got: Record<string, string> = {}
  for (const [name, claims] of Object.entries(cases)) got[name] = await reasonOf(claims, NOW, EMPTY)
  expect(got).toEqual(Object.fromEntries(Object.keys(cases).map((name) => [name, name])))
})

test("makeToken: 64 chats with an exp of ten digits give a token of at most 4,096 bytes", async () => {
  const got = await make({ ...GOOD, chats: chatsOf(64), exp: S + HOUR })
  if (typeof got === "string") throw new Error(got)
  expect(String(S + HOUR)).toHaveLength(10)
  expect(got.token.length).toBeLessThanOrEqual(4096)
  // The page's measure (docs/host.md, section 6).
  expect(got.token.length).toBe(3511)
  expect(await verify(got.token)).toEqual({ ok: { ...GOOD, chats: chatsOf(64), exp: S + HOUR } })
})

// A generator of numbers from a seed (mulberry32), so that the random
// claims are the same at each run.
const randoms = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

test("makeToken gives no token that verifyToken refuses at the same instant: the reasons' cases, the bounds, and 200 random good claims", async () => {
  const random = randoms(20261116)
  const int = (below: number) => Math.floor(random() * below)
  const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[int(16)]).join("")
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[int(4)]}${hex(3)}-${hex(12)}`
  const inputs: Array<[Claims, number]> = [
    [{ ...GOOD, chats: [] }, NOW],
    [{ ...GOOD, chats: chatsOf(65) }, NOW],
    [{ ...GOOD, chats: [chat(1), chat(1)] }, NOW],
    [{ ...GOOD, tenant: TENANT.toUpperCase() }, NOW],
    [{ ...GOOD, tenant: TENANT.slice(1) }, NOW],
    [{ ...GOOD, exp: S + 600.5 }, NOW],
    [{ ...GOOD, exp: Number.NaN }, NOW],
    [{ ...GOOD, exp: S }, S * 1000],
    [{ ...GOOD, exp: S }, NOW],
    [{ ...GOOD, exp: S + 1 }, S * 1000],
    [{ ...GOOD, exp: S + HOUR }, S * 1000],
    [{ ...GOOD, exp: S + HOUR + 1 }, S * 1000],
    [{ ...GOOD, exp: S + HOUR }, NOW],
    [{ ...GOOD, chats: chatsOf(64), exp: S + HOUR }, NOW]
  ]
  for (let n = 0; n < 200; n++) {
    const now = 1_000_000_000_000 + int(3_000_000_000_000)
    const chats = new Set<string>()
    const count = 1 + int(64)
    while (chats.size < count) chats.add(uuid())
    inputs.push([{ tenant: uuid(), chats: [...chats], exp: Math.floor(now / 1000) + 1 + int(HOUR) }, now])
  }
  let made = 0
  const refused: Array<unknown> = []
  for (const [claims, now] of inputs) {
    const got = await make(claims, now)
    if (typeof got === "string") continue
    made++
    const verified = await verify(got.token, now)
    if (typeof verified === "number" || JSON.stringify(verified.ok) !== JSON.stringify(claims)) refused.push({ claims, now, verified })
  }
  expect(refused).toEqual([])
  expect(made).toBe(200 + 4)
})

// What is not proved here (docs/host.md, section 8)
// -------------------------------------------------

const Any = Schema.Struct({})

// `Jwt.verify` at `NOW`, on Effect's clock, with an HMAC key of `alg`.
const jwtVerify = (token: string, alg: "HS256" | "HS512") =>
  Effect.andThen(TestClock.setTime(NOW), Effect.flatMap(keyOf(SECRET, alg), (key) => Jwt.verify(Any, token, key))).pipe(
    Effect.provide(crypto),
    Effect.provide(TestClock.layer())
  )

test("Jwt.verify refuses alg none", async () => {
  const error = await Effect.runPromise(Effect.flip(jwtVerify(unsigned(GOOD), "HS256")))
  expect(error._tag).toBe("JoseError")
  expect((error as { reason: { _tag: string } }).reason._tag).toBe("InvalidToken")
})

test("Jwt.verify refuses an alg other than the key's", async () => {
  const token = await sign(GOOD, { alg: "HS512" })
  const error = await Effect.runPromise(Effect.flip(jwtVerify(token, "HS256")))
  expect(error._tag).toBe("JoseError")
  expect((error as { reason: { _tag: string } }).reason._tag).toBe("AlgorithmNotAllowed")
  // The same token, verified with its own algorithm's key, passes.
  const claims = await Effect.runPromise(jwtVerify(token, "HS512"))
  expect(claims.registeredClaims).toEqual({ exp: GOOD.exp })
})
