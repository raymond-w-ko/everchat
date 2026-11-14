// Inspector
// =========
// The inspector as a server: the page (inspector.html), and the answers of
// the read module (inspect.ts) as JSON, over HTTP. It reads only: every
// route is a GET, and none changes the chat.
//
// Who may read
//
// The chat is private: its home is closed to other accounts. A port is not.
// Two rules keep it closed:
//
// - The server listens on this machine's own address (127.0.0.1) only.
// - Every path starts with a token: 32 random hex digits, new at each
//   start. A request with another path gets `404`. Another account of this
//   machine, or a page of a web site in the person's browser, can reach the
//   port, and it does not know the token.
//
// The token is in the address that the program prints, so the person opens
// the page with one click. No answer may be kept or sent on by a browser
// (`no-store`, `no-referrer`).
//
// What the page may do
//
// The page shows texts of the chat, which a model or a web site wrote. It
// puts them on the page as text, never as HTML. As a second wall, the
// content security policy lets only the page's own script run (by its
// hash), and lets the page talk only to this server.
//
// This module is loaded only by `everchat inspect` (main.ts): it pulls in
// Effect's HTTP server, and a launch of the chat does not pay for that.

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Cause, Context, Effect, Layer, Schema, SchemaTransformation } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Inspect } from "./inspect.ts"
// The page, as text: the build puts it into the executable.
import html from "./inspector.html" with { type: "text" }
import { type StoreError, ViewName } from "./store.ts"

// Bun's types say that an import of an HTML file is a bundle. With the
// type `text` it is the file's text.
const page = html as unknown as string

// The port when no argument gives one.
export const PORT = 4680

export interface Options {
  readonly port: number // 0: any free port
}

// A whole number in a query: digits only. An empty value is not a number.
const Whole = Schema.String.check(Schema.isPattern(/^-?\d{1,15}$/)).pipe(Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString))

// The server could not listen on its port.
export class NoPort extends Schema.TaggedError<NoPort>()("NoPort", {
  port: Schema.Int,
  message: Schema.String
}) {}

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" }

// The page's one script, to name it in the policy by its hash.
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ""
const POLICY = [
  "default-src 'none'",
  "script-src 'sha256-" + new Bun.CryptoHasher("sha256").update(SCRIPT).digest("base64") + "'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ")

const json = (data: unknown, status = 200) => HttpServerResponse.json(data, { status, headers: NO_STORE })

// An answer of the read module as JSON. Null: there is no such thing
// (`404`). A query that does not fit is the asker's fault (`400`), and a
// read that failed is ours (`500`).
const answer = <A, R>(read: Effect.Effect<A, StoreError | Schema.SchemaError, R>) =>
  read.pipe(
    Effect.flatMap((data) => (data === null ? json({ error: "not there" }, 404) : json(data))),
    Effect.catchTag("SchemaError", (error) => json({ error: error.message }, 400)),
    Effect.catchTag("StoreError", (error) => json({ error: "the database failed (" + error.op + ")" }, 500)),
    Effect.orDie
  )

const query = <A, I extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>>(schema: Schema.Codec<A, I>) =>
  HttpServerRequest.schemaSearchParams(schema)

// The routes, under the token.
const routes = (token: string) =>
  Effect.gen(function*() {
    const inspect = yield* Inspect
    const get = (path: HttpRouter.PathInput, read: Effect.Effect<unknown, StoreError | Schema.SchemaError, HttpServerRequest.ParsedSearchParams>) =>
      HttpRouter.route("GET", path, answer(read))
    return [
      HttpRouter.route("GET", "/", HttpServerResponse.text(page, { contentType: "text/html; charset=utf-8", headers: { ...NO_STORE, "content-security-policy": POLICY } })),
      get("/api/version", Effect.map(inspect.version, (version) => ({ version }))),
      get("/api/overview", inspect.overview),
      get(
        "/api/window",
        Effect.flatMap(query(Schema.Struct({ from: Whole, to: Whole, floor: Schema.optional(Whole) })), (at) => inspect.window(at.from, at.to, at.floor))
      ),
      get("/api/node", Effect.flatMap(query(Schema.Struct({ l: Whole, i: Whole })), (at) => inspect.node(at.l, at.i))),
      get("/api/messages", Effect.flatMap(query(Schema.Struct({ from: Whole, to: Whole })), (at) => inspect.messages(at.from, at.to))),
      get("/api/view", Effect.flatMap(query(Schema.Struct({ name: ViewName })), (at) => inspect.view(at.name))),
      get(
        "/api/turns",
        Effect.flatMap(query(Schema.Struct({ before: Schema.optional(Whole), limit: Schema.optional(Whole) })), (at) => inspect.turns(at.before ?? null, at.limit))
      ),
      get("/api/turn", Effect.flatMap(query(Schema.Struct({ id: Whole })), (at) => inspect.turn(at.id))),
      get("/api/body", Effect.flatMap(query(Schema.Struct({ id: Whole, upto: Schema.optional(Whole) })), (at) => inspect.body(at.id, at.upto ?? null))),
      get(
        "/api/usage",
        Effect.flatMap(query(Schema.Struct({ before: Schema.optional(Whole), limit: Schema.optional(Whole) })), (at) => inspect.usage(at.before ?? null, at.limit))
      ),
      get("/api/diagnostics", Effect.flatMap(query(Schema.Struct({ limit: Schema.optional(Whole) })), (at) => inspect.diagnostics(at.limit))),
      get("/api/launches", inspect.launches())
    ]
  }).pipe((made) => HttpRouter.addAll(made, { prefix: "/" + token }))

// The inspector, while it serves.
export class Inspector extends Context.Service<Inspector, {
  // The address of the page, with the token.
  readonly url: string
}>()("everchat/inspector/Inspector") {
  static readonly layer = (options: Options) =>
    Layer.effect(
      Inspector,
      Effect.gen(function*() {
        // The server fails a port that is in use with a defect: make it an error that the caller can show.
        const serving = yield* Layer.build(BunHttpServer.layer({ hostname: "127.0.0.1", port: options.port })).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            return Effect.fail(new NoPort({ port: options.port, message: `the inspector could not listen on port ${options.port} (${error instanceof Error ? error.message : String(error)})` }))
          })
        )
        const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")
        // To build this layer is to start to serve, until the scope closes.
        yield* Layer.build(HttpRouter.serve(routes(token), { disableLogger: true, disableListenLog: true })).pipe(Effect.provide(serving))
        const server = Context.get(serving, HttpServer.HttpServer)
        return Inspector.of({ url: HttpServer.formatAddress(server.address) + "/" + token + "/" })
      })
    )
}
