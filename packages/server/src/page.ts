// The page's routes
// =================
// R8 to R10, the routes of the local command's page (docs/host.md, section
// 7, "The start value and the page's routes", "The page's rules"; lead,
// ec-3jrdd). `serve(options, local)` (serve.ts) serves them under the start
// value, each through the gate's `local` (http.ts): the place, the `Host`,
// the method, the origin, then the work under the deadline. They read no
// token: the start value is their wall, as the inspector's path token
// (packages/local/src/inspector.ts).
//
// | # | Method and path | What it does |
// | --- | --- | --- |
// | R8 | `GET /<start>/` | the page, `client.html`, with its policy |
// | R9 | `POST /<start>/chats` | a new chat of the local tenant: `200 {"chat": "<UUID>"}` |
// | R10 | `POST /<start>/token` | a token of the local tenant for the body's chats: `200 {"token": "<JWT>", "exp": <seconds>}` |
//
// At the layer's start (`pageRoutes`), before anything is served: the start
// value is 32 hex digits in lower case, else `LocalRefused` `start`; the
// page has exactly one `<script>`, with no `src`, else `LocalRefused`
// `page`. The script's SHA-256, in base64, made one time with Web Crypto,
// names it in the policy, which is the inspector's: only that script runs,
// and the page talks only to this server.
//
// The start value is compared over its whole length, with no early end, so
// the time of a refusal tells nothing of how many digits were right. Every
// other path under it, a wrong start value and `/<start>` with no slash at
// its end are no route here: `serve` gives them the gate's answer of no
// route.
//
// R9, in this order: the count (at most `newChats` in `newChatsWindow`, for
// the host); its body, read (at most 16,384 bytes, in at most `bodyRead`)
// and not used, or none (the page sends none): a request with no stream or
// a `content-length` of 0 has none, and a read of a body that fails (one
// that stops in its middle) is `400 bad_request`, with no chat made;
// `makeChat` of the local tenant with the pick. A store's failure is `500
// internal`, and it has counted.
//
// R10, in this order: the count (`newTokens` in `newTokensWindow`); the
// body's type, as R1's (`415`); the body, at most 16,384 bytes (`413`,
// `408`); its form: UTF-8 JSON, an object with the one field `chats`, a list
// of 1 to `chats` UUIDs (lower case, the form of the gate's check of a
// chat), none twice, else `400 bad_request`; each chat in the store for the
// local tenant (`Chats.reads`), else `404 no_chat`, and no token is made;
// then `makeToken` with the host's secret, the tenant, the chats and `exp`
// 600 s from Effect's `Clock`, in whole seconds. The token passes the gate's
// checks for each of its chats at that instant.
//
// The rate of R9 and of R10: one fixed window each, for the host, as the
// rule of `Host.count` (host.ts): a window starts at its first count and
// lasts its span; past the count, `429 too_many` with `retry-after`, the
// whole seconds to the window's end, rounded up, and at least 1. A window is
// new when it has ended or when the clock is before its start (the clock
// stepped back). Each request that passed the gate counts, one that then
// fails too.
//
// No answer and no log line of this file holds the start value, a token, the
// secret, a body or a header's value: the gate's log has the route's name,
// the status and the error's code only.

import { Clock, Effect, type Redacted, Schema } from "effect"
import { Base64 } from "effect/encoding"
import type { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpServerResponse as Response } from "effect/http"
import type { Chats, Pick } from "@everchat/core/store"
import { makeChat, makeToken } from "./backend.ts"
// The page, as text (with no build step, as the inspector's).
import html from "./client.html" with { type: "text" }
import { type Gate, jsonAnswer, type Local, type PageRoute, Refused } from "./http.ts"
import type { Limits } from "./limits.ts"

// Bun's types say that an import of an HTML file is a bundle. With the type
// `text` it is the file's text.
export const PAGE: string = html as unknown as string

// What `serve` needs for the page's routes (`serve(options, local)`).
export interface LocalOptions {
  // The start value: 32 hex digits in lower case.
  readonly start: string
  // The local tenant's UUID: R9's chats are its own, and R10's tokens.
  readonly tenant: string
  // The pick of a new chat (R9).
  readonly pick: Pick
  // The one value of the header `Host` that the host takes:
  // `127.0.0.1:<port>`.
  readonly authority: string
}

// The page's routes cannot start: the start value is not 32 hex digits in
// lower case (`start`), or the page has not exactly one `<script>`, or one
// with a `src` (`page`). Neither the error nor its text holds the value.
export class LocalRefused extends Schema.TaggedError<LocalRefused>()("LocalRefused", {
  reason: Schema.Literals(["start", "page"])
}) {
  override get message() {
    return this.reason === "start"
      ? "The start value of the page's routes must be 32 hex digits in lower case."
      : "The page must have exactly one script, with no src."
  }
}

// The form of a start value.
const START = /^[0-9a-f]{32}$/

// The bound of the bodies of R9 and R10, in bytes.
export const PAGE_BODY = 16_384

// The life of R10's token, in seconds.
export const TOKEN_LIFE = 600

// A UUID as text, as the gate's check of a chat takes it (token.ts, `UUID`):
// lower-case hex digits in groups of 8, 4, 4, 4 and 12.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// `application/json`, and at most a parameter `charset=utf-8`, as R1's
// (post.ts).
const JSON_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i

// The policy
// ----------

// The page's one script: the text between its `<script>` and its
// `</script>`, or undefined when the page has not exactly one of each, in
// that order, or its tag has a `src`.
const scriptOf = (page: string): string | undefined => {
  const opens = [...page.matchAll(/<script\b([^>]*)>/gi)]
  const closes = [...page.matchAll(/<\/script\s*>/gi)]
  const open = opens[0]
  const close = closes[0]
  if (opens.length !== 1 || closes.length !== 1 || open === undefined || close === undefined) return undefined
  if (/\bsrc\b/i.test(open[1] ?? "")) return undefined
  const from = open.index + open[0].length
  if (close.index < from) return undefined
  return page.slice(from, close.index)
}

// The content security policy of `page`, as the inspector's: its one script
// by its SHA-256 in base64, inline style, and this server alone.
export const policyOf = (page: string): Effect.Effect<string, LocalRefused> =>
  Effect.gen(function*() {
    const script = scriptOf(page)
    if (script === undefined) return yield* new LocalRefused({ reason: "page" })
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)))
    return [
      "default-src 'none'",
      "script-src 'sha256-" + Base64.encode(new Uint8Array(digest)) + "'",
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; ")
  })

// The routes
// ----------

// Whether `given` is `start`: each of `start`'s characters is compared, with
// no early end, whatever `given` is.
const isStart = (given: string, start: string): boolean => {
  let differ = given.length === start.length ? 0 : 1
  for (let at = 0; at < start.length; at++) differ |= (given.charCodeAt(at) | 0) ^ start.charCodeAt(at)
  return differ === 0
}

// The paths of the page's routes: a first part, then a slash and nothing,
// `chats` or `token`.
const PATH = /^\/([^/]+)\/(chats|token)?$/

// One fixed window of a rate, for the host: at most `most` in `span` ms.
const windowOf = (most: number, span: number) => {
  let window: { start: number; count: number } | undefined
  return Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.suspend(() => {
      if (window === undefined || now < window.start || now >= window.start + span) {
        window = { start: now, count: 1 }
        return Effect.void
      }
      if (window.count >= most) {
        return Effect.fail(new Refused({ code: "too_many", retryAfter: Math.max(1, Math.ceil((window.start + span - now) / 1000)) }))
      }
      window.count += 1
      return Effect.void
    }))
}

// The chats of R10's body, or undefined when its form is not valid.
const chatsOf = (body: Uint8Array, most: number): ReadonlyArray<string> | undefined => {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } catch {
    return undefined
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const keys = Object.keys(json)
  if (keys.length !== 1 || keys[0] !== "chats") return undefined
  const chats = (json as { readonly chats: unknown }).chats
  if (!Array.isArray(chats) || chats.length === 0 || chats.length > most) return undefined
  if (!chats.every((chat): chat is string => typeof chat === "string" && UUID.test(chat))) return undefined
  if (new Set(chats).size !== chats.length) return undefined
  return chats
}

const refuse = (code: Refused["code"]) => Effect.fail(new Refused({ code }))

// Whether a request has a body: its source (the web's `Request`, from Bun
// or from `fromWeb`) has a stream, and its `content-length` is not 0.
// Effect's `stream` fails for a source with none.
const hasBody = (request: HttpServerRequest.HttpServerRequest): boolean =>
  (request.source as { readonly body?: unknown }).body != null && request.headers["content-length"] !== "0"

// What the page's routes need of the host.
export interface PageNeeds {
  readonly gate: Gate
  readonly chats: typeof Chats.Service
  readonly secret: Redacted.Redacted<Uint8Array>
  readonly limits: Limits
  // The token's maker: `makeToken` (token.ts) when none is given. `serve`
  // gives none; the tests count its calls.
  readonly makeToken?: typeof makeToken
}

// The handler of a page's route for a request's path, or undefined when the
// path is none of theirs.
export type PageFind = (
  path: string
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> | undefined

// The page's routes, after the checks of the start value and the page.
export const pageRoutes = (local: LocalOptions, needs: PageNeeds, page: string = PAGE): Effect.Effect<PageFind, LocalRefused> =>
  Effect.gen(function*() {
    if (!START.test(local.start)) return yield* new LocalRefused({ reason: "start" })
    const policy = yield* policyOf(page)
    const { gate, chats, secret, limits } = needs
    const maker = needs.makeToken ?? makeToken
    const { start, tenant, pick } = local
    const newChat = windowOf(limits.newChats, limits.newChatsWindow)
    const newToken = windowOf(limits.newTokens, limits.newTokensWindow)

    // R8: the page.
    const pageWork = () =>
      Effect.succeed(Response.text(page, { contentType: "text/html; charset=utf-8", headers: { "content-security-policy": policy } }))

    // R9: a new chat.
    const chatWork = (given: Local) =>
      Effect.gen(function*() {
        yield* newChat
        // The page's own R9 sends no body. Effect's request has no stream for
        // none, and its read would fail as `bad_request`: so a request with
        // none is not read. Any other read keeps its answer: over the bound,
        // slow, or failed in its middle.
        if (hasBody(given.request)) yield* given.body(PAGE_BODY)
        const chat = yield* makeChat(chats, tenant, pick).pipe(Effect.catchTag("StoreError", () => refuse("internal")))
        return jsonAnswer({ chat })
      })

    // R10: a token.
    const tokenWork = (given: Local) =>
      Effect.gen(function*() {
        yield* newToken
        if (!JSON_TYPE.test(given.request.headers["content-type"] ?? "")) return yield* refuse("unsupported_type")
        const listed = chatsOf(yield* given.body(PAGE_BODY), limits.chats)
        if (listed === undefined) return yield* refuse("bad_request")
        for (const chat of listed) {
          yield* chats.reads(tenant, chat).pipe(
            Effect.catchTags({ NoChat: () => refuse("no_chat"), StoreError: () => refuse("internal") })
          )
        }
        const exp = Math.floor((yield* Clock.currentTimeMillis) / 1000) + TOKEN_LIFE
        const token = yield* maker(secret, { tenant, chats: listed, exp }).pipe(Effect.catchTag("TokenRefused", () => refuse("internal")))
        return jsonAnswer({ token, exp })
      })

    const routes: Record<PageRoute, Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>> = {
      R8: gate.local("R8", pageWork),
      R9: gate.local("R9", chatWork),
      R10: gate.local("R10", tokenWork)
    }
    return (path) => {
      const found = PATH.exec(path)
      if (found === null || !isStart(found[1] as string, start)) return undefined
      return found[2] === undefined ? routes.R8 : found[2] === "chats" ? routes.R9 : routes.R10
    }
  })
