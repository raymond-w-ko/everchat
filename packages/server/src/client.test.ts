// The reference client's page (client.html), in a browser with no window
// (happy-dom), against a fake host: a fake `fetch` that answers R1 to R4,
// R9 and R10 as docs/host.md says, a fake `WebSocket` for R6, and a fake
// clock. Each fake records every address, header, body and frame, so a case
// can say where a token went. The page's script runs as it is.
//
// The browser here has no layout and no content security policy. So these
// cases say nothing about how the page looks; the route that serves the page
// with its policy (R8) is a later step, with its own test.

import { afterEach, expect, test } from "bun:test"
import { Browser } from "happy-dom"

const PAGE = await Bun.file(new URL("client.html", import.meta.url)).text()
const START = "0123456789abcdef0123456789abcdef"
const ORIGIN = "http://127.0.0.1:4681"
const STORED = "everchat.chats"
const uuid = (k: number) => "00000000-0000-4000-8000-" + String(k).padStart(12, "0")
const A = uuid(1)
const B = uuid(2)
const C = uuid(3)

// A text that would be markup, a script and a handler if it were HTML.
const HOSTILE = "<script>document.title = \"x\"</script><img src=x onerror=\"document.title = 'y'\"> \"a quote\" 'and' & &amp;"

// The clock of the page: its `setTimeout`, `clearTimeout` and `Date`. Time
// moves only by `advance`, which runs each timer that falls due, in order.
class Clock {
  now = Date.UTC(2026, 10, 16, 12, 0, 0)
  private next = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  readonly setTimeout = (run: () => void, ms?: number) => {
    const id = this.next++
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), run })
    return id
  }
  readonly clearTimeout = (id?: number) => {
    if (id !== undefined) {
      this.timers.delete(id)
    }
  }
  // Lets the page's promises run.
  async flush() {
    for (let k = 0; k < 40; k++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  async advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      await this.flush()
      let first: [number, { at: number; run: () => void }] | undefined
      for (const entry of this.timers) {
        if (entry[1].at <= end && (first === undefined || entry[1].at < first[1].at)) {
          first = entry
        }
      }
      if (first === undefined) {
        break
      }
      this.timers.delete(first[0])
      this.now = first[1].at
      first[1].run()
    }
    this.now = end
    await this.flush()
  }
}

type Sent = { at: number; method: string; url: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: string | null }
type Message = { i: number; kind: string; text: string; size: number; more: boolean; line: null; turn: null; call: null; launch: number; created: number }
type Event = Record<string, unknown>

const message = (i: number, kind: string, text: string): Message => ({ i, kind, text, size: text.length, more: false, line: null, turn: null, call: null, launch: 1, created: 1763300000000 + i })

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } })
const fault = (status: number, error: string, message: string, headers: Record<string, string> = {}) => json(status, { error, message }, headers)

// An event as R4 frames it: a numbered event with its id, a piece without.
const frame = (event: Event) => (typeof event.n === "number" ? "id: " + event.n + "\n" : "") + "event: " + String(event.type) + "\ndata: " + JSON.stringify(event) + "\n\n"

// One R4 stream that the fake host answered: the case writes into it.
class Stream {
  aborted = false
  private control!: ReadableStreamDefaultController<Uint8Array>
  readonly body = new ReadableStream<Uint8Array>({ start: (control) => void (this.control = control) })
  constructor(readonly chat: string, readonly after: string, signal: AbortSignal | undefined) {
    signal?.addEventListener("abort", () => {
      this.aborted = true
      try {
        this.control.error(new Error("aborted"))
      } catch {}
    })
  }
  write(text: string) {
    this.control.enqueue(new TextEncoder().encode(text))
  }
  send(...events: Array<Event>) {
    this.write(events.map(frame).join(""))
  }
  end() {
    this.control.close()
  }
}

// One R6 socket that the page made: the case opens it, gives it frames and
// closes it.
class Socket {
  readonly sent: Array<string> = []
  closedByPage = false
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(text: string) {
    this.sent.push(text)
  }
  close() {
    this.closedByPage = true
  }
  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
  open() {
    this.emit("open", {})
  }
  give(...frames: Array<Event>) {
    for (const one of frames) {
      this.emit("message", { data: JSON.stringify(one) })
    }
  }
  end(code: number, reason = "") {
    this.emit("close", { code, reason })
  }
}

type Chat = { seq: number; messages: Array<Message>; turn: null | { id: number } }
// A route of a case: an answer, or undefined for the fake host's own.
// `own` is the fake host's own answer, for a route that answers it and then
// loses it.
type Route = (sent: Sent, own: (sent: Sent) => Response | Stream) => Response | Promise<Response> | "network" | undefined

const browsers: Array<Browser> = []
afterEach(async () => {
  for (const browser of browsers.splice(0)) {
    await browser.close()
  }
})

// The page at /<start>/ over a fake host, with `stored` in localStorage.
const load = async (options: { stored?: string; chats?: Record<string, Partial<Chat>>; route?: Route } = {}) => {
  const clock = new Clock()
  const sent: Array<Sent> = []
  const streams: Array<Stream> = []
  const sockets: Array<Socket> = []
  const chats = new Map<string, Chat>(Object.entries(options.chats ?? {}).map(([id, chat]) => [id, { seq: 0, messages: [], turn: null, ...chat }]))
  const tokens = new Map<string, { exp: number; chats: Array<string> }>()
  const issued: Array<string> = []
  let made = 0
  const host = {
    chats,
    tokens,
    issued,
    route: options.route,
    // Each token held so far is refused from now on.
    revoke: () => tokens.clear(),
    // The messages that R1 logged, once for each key of a chat.
    writes: [] as Array<{ chat: string; text: string; key: string | undefined }>
  }

  const own = (call: Sent): Response | Stream => {
    if (call.method === "POST" && call.path === "/" + START + "/chats") {
      const chat = uuid(100 + ++made)
      chats.set(chat, { seq: 0, messages: [], turn: null })
      return json(200, { chat })
    }
    if (call.method === "POST" && call.path === "/" + START + "/token") {
      const list = (JSON.parse(call.body ?? "{}") as { chats: Array<string> }).chats
      if (!list.every((one) => chats.has(one))) {
        return fault(404, "no_chat", "This tenant has no chat with this UUID.")
      }
      const value = "eyJ.token-" + (issued.length + 1) + ".sig"
      const exp = Math.floor(clock.now / 1000) + 600
      issued.push(value)
      tokens.set(value, { exp, chats: list })
      return json(200, { token: value, exp })
    }
    const route = /^\/v1\/chats\/([^/]+)(\/messages|\/events|)$/.exec(call.path)
    if (route === null) {
      return fault(404, "no_chat", "No route.")
    }
    const id = route[1]!
    const held = tokens.get((call.headers.authorization ?? "").replace(/^Bearer /, ""))
    // As the gate: `401` for a token that fails or whose `exp` passed, and
    // `404 no_chat` for a good token that does not name the chat.
    if (held === undefined || held.exp * 1000 <= clock.now) {
      return fault(401, "unauthorized", "The token was refused.")
    }
    const chat = chats.get(id)
    if (!held.chats.includes(id) || chat === undefined) {
      return fault(404, "no_chat", "This tenant has no chat with this UUID.")
    }
    if (call.method === "GET" && route[2] === "") {
      const last = chat.messages.length === 0 ? 0 : chat.messages[chat.messages.length - 1]!.i + 1
      return json(200, { chat: { uuid: id, pick: { vendor: "openai", model: "gpt-test", effort: "medium", speed: "slow" }, goal: null }, seq: chat.seq, count: last, messages: chat.messages.slice(-50), turn: chat.turn })
    }
    if (call.method === "GET" && route[2] === "/messages") {
      const from = Number(call.query.from)
      const to = Number(call.query.to)
      return json(200, { messages: chat.messages.filter((one) => one.i >= from && one.i < to) })
    }
    if (call.method === "POST" && route[2] === "/messages") {
      const key = call.headers["idempotency-key"]
      const repeat = key !== undefined && host.writes.some((one) => one.chat === id && one.key === key)
      if (!repeat) {
        chat.seq++
        host.writes.push({ chat: id, text: (JSON.parse(call.body ?? "{}") as { text: string }).text, key })
      }
      return json(200, { n: chat.seq, first: chat.messages.length, last: chat.messages.length, repeat })
    }
    if (call.method === "GET" && route[2] === "/events") {
      return new Stream(id, call.query.after ?? "", undefined)
    }
    return fault(400, "bad_request", "No such request.")
  }

  const browser = new Browser({ settings: { enableJavaScriptEvaluation: true, suppressCodeGenerationFromStringsWarning: true } })
  browsers.push(browser)
  const tab = browser.newPage()
  tab.url = ORIGIN + "/" + START + "/"
  const window = tab.mainFrame.window as unknown as Record<string, unknown> & { localStorage: Storage; sessionStorage: Storage }
  window.fetch = async (input: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) => {
    const url = new URL(String(input), ORIGIN + "/" + START + "/")
    const call: Sent = {
      at: clock.now,
      method: init.method ?? "GET",
      url: url.href,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body ?? null
    }
    sent.push(call)
    const routed = await host.route?.(call, own)
    if (routed === "network") {
      throw new TypeError("Failed to fetch")
    }
    const answer = routed ?? own(call)
    if (answer instanceof Stream) {
      const stream = new Stream(answer.chat, answer.after, init.signal)
      streams.push(stream)
      return new Response(stream.body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return answer
  }
  window.WebSocket = class extends Socket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  window.setTimeout = clock.setTimeout
  window.clearTimeout = clock.clearTimeout
  const RealDate = Date
  window.Date = class extends RealDate {
    constructor(...args: Array<number>) {
      super(...((args.length === 0 ? [clock.now] : args) as [number]))
    }
    static override now() {
      return clock.now
    }
  }
  if (options.stored !== undefined) {
    window.localStorage.setItem(STORED, options.stored)
  }
  tab.content = PAGE
  await clock.flush()

  const document = tab.mainFrame.document
  const all = (selector: string) => Array.from(document.querySelectorAll(selector))
  const texts = (selector: string) => all(selector).map((one) => (one.textContent ?? "").replace(/\s+/g, " ").trim())
  const $ = (id: string) => document.getElementById(id)!
  return {
    window,
    document,
    clock,
    sent,
    streams,
    sockets,
    host,
    all,
    texts,
    $,
    // The calls of one route, by its method and path.
    calls: (method: string, path: string) => sent.filter((one) => one.method === method && one.path === path),
    // The log: each entry as "who|text".
    entries: () => all("#log .entry").map((one) => one.querySelector(".who")!.textContent + "|" + one.querySelector(".txt")!.textContent),
    click: async (id: string) => {
      ;($(id) as unknown as { click(): void }).click()
      await clock.flush()
    },
    stored: () => window.localStorage.getItem(STORED),
    // A click on a chat of the list.
    open: async (chat: string) => {
      ;(all("#chats button").find((one) => one.getAttribute("data-chat") === chat) as unknown as { click(): void }).click()
      await clock.flush()
    },
    // The composer: its text, and a Send of a text.
    composer: () => ($("text") as unknown as { value: string }).value,
    say: async (text: string) => {
      ;($("text") as unknown as { value: string }).value = text
      ;($("send") as unknown as { click(): void }).click()
      await clock.flush()
    },
    way: async (value: "stream" | "socket") => {
      const select = $("way") as unknown as { value: string; dispatchEvent(event: unknown): boolean }
      select.value = value
      select.dispatchEvent(new (window.Event as typeof Event)("change"))
      await clock.flush()
    }
  }
}

const token = (path: string) => "/" + START + "/" + path
const chatPath = (chat: string, rest = "") => "/v1/chats/" + chat + rest
const auth = (one: Sent) => one.headers.authorization

test("(a) the file's form: one script with no source, no handler, no HTML writer and no address of another server", async () => {
  const scripts = PAGE.match(/<script\b[^>]*>/gi) ?? []
  expect(scripts).toEqual(["<script>"])
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE)![1]!
  for (const name of [/\beval\b/, /\bFunction\b/, /\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write/, /\bsetTimeout\(\s*["'`]/, /\bsetInterval\b/, /\bimport\s*\(/]) {
    expect(script).not.toMatch(name)
  }
  // No handler attribute, in the file's text and in its parsed elements.
  const markup = PAGE.replace(script, "")
  expect(markup).not.toMatch(/\son[a-z]+\s*=/i)
  const browser = new Browser({ settings: { enableJavaScriptEvaluation: false } })
  browsers.push(browser)
  const tab = browser.newPage()
  tab.content = PAGE
  const elements = Array.from(tab.mainFrame.document.querySelectorAll("*"))
  expect(elements.length).toBeGreaterThan(20)
  expect(elements.flatMap((one) => one.getAttributeNames().filter((name) => name.toLowerCase().startsWith("on") || ["src", "href", "style", "action", "formaction"].includes(name.toLowerCase())))).toEqual([])
  expect(tab.mainFrame.document.querySelectorAll("script, form, img, link, iframe, object, embed").length).toBe(1)
  // Its only address with a scheme is the socket's, built from `location`.
  const built = '(location.protocol === "https:" ? "wss://" : "ws://") + location.host'
  expect(PAGE.split(built).length).toBe(2)
  const rest = PAGE.replace(built, "")
  expect(rest).not.toMatch(/\b(?:https?|wss?|file|data|blob|javascript):/i)
  expect(rest).not.toMatch(/["'`]\/\//)
  expect(rest).not.toMatch(/url\(|@import|@font-face/i)
  // Every request is to a path of the page's own origin.
  expect(script).toMatch(/const BASE = "\/" \+ START \+ "\/"/)
})

test("(b) a first open asks only for the stored chats; \"New chat\" calls R9 and stores it; a broken stored value is dropped", async () => {
  // No stored chat: no request at all.
  const none = await load()
  expect(none.sent).toEqual([])
  expect(none.texts("#none")).toEqual(["No chat is open."])
  await none.click("new")
  const made = uuid(101)
  expect(none.sent.map((one) => one.method + " " + one.path)).toEqual(["POST " + token("chats"), "POST " + token("token"), "GET " + chatPath(made), "GET " + chatPath(made, "/events")])
  expect(none.sent[0]!.body).toBeNull()
  expect(JSON.parse(none.stored()!)).toEqual([made])
  expect(JSON.parse(none.sent[1]!.body!)).toEqual({ chats: [made] })
  expect(none.texts("#chats button")).toEqual([made])
  expect(none.all("#chats button")[0]!.getAttribute("title")).toBe(made)

  // Two stored chats: a token for both, and the newest is open.
  const two = await load({ stored: JSON.stringify([A, B]), chats: { [A]: {}, [B]: { seq: 4, messages: [message(0, "user", "hello")] } } })
  expect(two.sent.map((one) => one.method + " " + one.path)).toEqual(["POST " + token("token"), "GET " + chatPath(B), "GET " + chatPath(B, "/events")])
  expect(JSON.parse(two.sent[0]!.body!)).toEqual({ chats: [A, B] })
  expect(two.sent[2]!.query).toEqual({ after: "4" })
  expect(two.texts("#chats button")).toEqual([B, A])
  expect(two.entries()).toEqual(["user|hello"])
  // A second new chat goes to the end of the list, with a new token for all three.
  await two.click("new")
  expect(JSON.parse(two.stored()!)).toEqual([A, B, uuid(101)])
  expect(JSON.parse(two.calls("POST", token("token"))[1]!.body!)).toEqual({ chats: [A, B, uuid(101)] })

  // A value that is no list of UUIDs is dropped whole, and asks nothing.
  for (const broken of ["not json", "null", "{\"a\":1}", JSON.stringify(["x"]), JSON.stringify([1]), JSON.stringify([A, "not a uuid"]), JSON.stringify(["0000000A-0000-4000-8000-00000000000B"]), JSON.stringify([HOSTILE])]) {
    const page = await load({ stored: broken, chats: { [A]: {} } })
    expect([broken, page.stored()]).toEqual([broken, null])
    expect(page.sent).toEqual([])
    expect(page.all("#chats li").length).toBe(0)
  }
  // A UUID twice is kept once.
  const twice = await load({ stored: JSON.stringify([A, A]), chats: { [A]: {} } })
  expect(JSON.parse(twice.sent[0]!.body!)).toEqual({ chats: [A] })
})

test("(c) the token: asked of R10 for the stored chats, renewed a minute before exp and after a 401, in no storage and in no address", async () => {
  const page = await load({ stored: JSON.stringify([A]), chats: { [A]: { seq: 1, messages: [message(0, "user", "hi")] } } })
  const tokens = () => page.calls("POST", token("token"))
  expect(tokens().length).toBe(1)
  expect(tokens()[0]!.headers).toEqual({ "content-type": "application/json" })
  const first = page.host.issued[0]!
  expect(page.sent.slice(1).map(auth)).toEqual(["Bearer " + first, "Bearer " + first])

  // The renewal: 600 s of life, so at 540 s and not before.
  await page.clock.advance(539_999)
  expect(tokens().length).toBe(1)
  await page.clock.advance(1)
  expect(tokens().length).toBe(2)
  const second = page.host.issued[1]!
  // The stream that runs keeps its token; at its end the page connects with the new one, and asks R10 nothing more.
  page.streams[0]!.send({ type: "close", reason: "token" })
  await page.clock.advance(0)
  expect(auth(page.calls("GET", chatPath(A, "/events"))[1]!)).toBe("Bearer " + second)
  expect(tokens().length).toBe(2)

  // After a 401: a new token, then the same connection again.
  page.host.revoke()
  page.streams[1]!.end()
  await page.clock.advance(0)
  const events = page.calls("GET", chatPath(A, "/events"))
  expect(events.map(auth)).toEqual(["Bearer " + first, "Bearer " + second, "Bearer " + second, "Bearer " + page.host.issued[2]])
  expect(events.map((one) => one.query.after)).toEqual(["1", "1", "1", "1"])
  expect(tokens().length).toBe(3)

  // The socket: its address has no token; its first frame is `auth`.
  await page.way("socket")
  const socket = page.sockets[0]!
  expect(socket.url).toBe("ws://127.0.0.1:4681/v1/chats/" + A + "/socket")
  socket.open()
  expect(socket.sent.map((one) => JSON.parse(one))).toEqual([{ type: "auth", token: page.host.issued[2], after: 1 }])
  // A 4401: a new token, and a new socket with it.
  socket.end(4401, "unauthorized")
  await page.clock.advance(0)
  expect(tokens().length).toBe(4)
  page.sockets[1]!.open()
  expect(JSON.parse(page.sockets[1]!.sent[0]!)).toEqual({ type: "auth", token: page.host.issued[3], after: 1 })
  // A message in after a 401 gets a new token too.
  page.host.revoke()
  ;(page.$("text") as unknown as { value: string }).value = "hello"
  await page.click("send")
  const posts = page.calls("POST", chatPath(A, "/messages"))
  expect(posts.map(auth)).toEqual(["Bearer " + page.host.issued[3], "Bearer " + page.host.issued[4]])

  // Each token is in a header `Authorization` and an `auth` frame only.
  expect(page.host.issued.length).toBe(5)
  for (const value of page.host.issued) {
    for (const one of page.sent) {
      expect(one.url).not.toContain(value)
      expect(one.body ?? "").not.toContain(value)
      expect(Object.entries(one.headers).filter(([name, text]) => name !== "authorization" && text.includes(value))).toEqual([])
    }
    for (const one of page.sockets) {
      expect(one.url).not.toContain(value)
    }
    for (const storage of [page.window.localStorage, page.window.sessionStorage]) {
      for (let k = 0; k < storage.length; k++) {
        expect(storage.key(k) + "=" + storage.getItem(storage.key(k)!)).not.toContain(value)
      }
    }
    expect(String(page.document.cookie)).not.toContain(value)
    expect(String((page.window.location as { href: string }).href)).not.toContain(value)
    expect(page.document.documentElement.outerHTML).not.toContain(value)
  }
  expect(page.window.localStorage.length).toBe(1)
  expect(page.window.sessionStorage.length).toBe(0)
})

test("(d) a text with markup is on the page as that text: a message, a program, a why, a piece, an error's sentence, a stored value", async () => {
  const page = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: { seq: 3, messages: [message(5, "asst", HOSTILE)] } },
    route: (call) => (call.path === chatPath(A, "/messages") && call.method === "GET" ? fault(400, "bad_request", HOSTILE) : undefined)
  })
  page.streams[0]!.send(
    { type: "start", n: 4, turn: 2 },
    { type: "call", n: 5, turn: 2, call: 1, program: HOSTILE },
    { type: "program", turn: 2, delta: HOSTILE },
    { type: "end", n: 6, turn: 2, status: "failed", why: HOSTILE }
  )
  await page.clock.flush()
  expect(page.entries()).toEqual(["asst|" + HOSTILE, "program|" + HOSTILE, "turn failed|" + HOSTILE])
  page.streams[0]!.send({ type: "text", turn: 3, delta: HOSTILE })
  await page.clock.flush()
  expect(page.$("live").textContent).toBe(HOSTILE)
  // The older messages: the host's sentence of its error, as text.
  await page.click("older")
  expect(page.$("error").textContent).toBe(HOSTILE)
  // A chat of R9 that is no UUID is not stored, and not shown.
  page.host.route = (call) => (call.path === token("chats") ? json(200, { chat: HOSTILE }) : undefined)
  await page.click("new")
  expect(page.$("error").textContent).toBe("The host gave no chat.")
  expect(JSON.parse(page.stored()!)).toEqual([A])

  // No element came from a text: each text's node holds text only.
  const document = page.document
  expect(document.querySelectorAll("img, iframe, object, embed").length).toBe(0)
  expect(document.querySelectorAll("script").length).toBe(1)
  expect(document.title).toBe("EverChat")
  expect(page.all("#log *").map((one) => one.tagName + "." + one.className)).toEqual(["DIV.entry", "SPAN.who", "PRE.txt", "DIV.entry", "SPAN.who", "PRE.txt", "DIV.entry", "SPAN.who", "PRE.txt"])
  for (const one of [...page.all("#log .who, #log .txt"), page.$("live"), page.$("error"), page.$("state")]) {
    expect(one.children.length).toBe(0)
  }
  expect(page.all("*").flatMap((one) => one.getAttributeNames().filter((name) => name.startsWith("on")))).toEqual([])
  // A stored UUID is on the page as text, and in `title` and `data-chat` only.
  const button = page.all("#chats button")[0]!
  expect([button.textContent, button.getAttribute("title"), button.getAttribute("data-chat"), button.children.length]).toEqual([A, A, A, 0])
})

test("(e) a message in sends a new key, and its retry the same key", async () => {
  let busy = 1
  let network = 1
  const page = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: {} },
    route: (call) => {
      if (call.method !== "POST" || call.path !== chatPath(A, "/messages")) {
        return undefined
      }
      if (busy-- > 0) {
        return fault(503, "busy", "The host is busy.", { "retry-after": "1" })
      }
      if (network-- > 0) {
        return "network"
      }
      return undefined
    }
  })
  const say = async (text: string) => {
    ;(page.$("text") as unknown as { value: string }).value = text
    await page.click("send")
  }
  await say("first")
  const posts = () => page.calls("POST", chatPath(A, "/messages"))
  expect(posts().length).toBe(1)
  // After `busy`, its retry-after (1 s): the same key.
  await page.clock.advance(999)
  expect(posts().length).toBe(1)
  await page.clock.advance(1)
  expect(posts().length).toBe(2)
  // After a fault of the network, 2 s: the same key, and it is taken.
  await page.clock.advance(2000)
  expect(posts().length).toBe(3)
  const keys = posts().map((one) => one.headers["idempotency-key"])
  expect(keys[0]).toMatch(/^[\x21-\x7e]{1,128}$/)
  expect(keys).toEqual([keys[0], keys[0], keys[0]])
  expect(posts().map((one) => JSON.parse(one.body!))).toEqual([{ text: "first" }, { text: "first" }, { text: "first" }])
  expect(posts()[0]!.headers["content-type"]).toBe("application/json")
  // A second message: a new key. After a 401 (a new token), the same key again.
  page.host.revoke()
  await say("second")
  const second = posts().slice(3).map((one) => one.headers["idempotency-key"])
  expect(second.length).toBe(2)
  expect(second[0]).not.toBe(keys[0])
  expect(second).toEqual([second[0], second[0]])
  expect(page.$("error").textContent).toBe("")
})

// The same events by R4 and by R6, with duplicates among them.
const SNAPSHOT = { seq: 2, messages: [message(0, "user", "hello"), message(1, "asst", "hi")] }
const EVENTS: Array<Event> = [
  { type: "accepted", n: 3, messages: [message(2, "user", "what is 1 + 1?")] },
  { type: "start", n: 4, turn: 2 },
  { type: "text", turn: 2, delta: "It is" },
  { type: "call", n: 5, turn: 2, call: 1, program: "return 1 + 1" },
  { type: "call", n: 5, turn: 2, call: 1, program: "return 1 + 1" },
  { type: "accepted", n: 3, messages: [message(2, "user", "what is 1 + 1?")] },
  { type: "message", n: 6, message: message(3, "asst", "It is 2.") },
  { type: "end", n: 7, turn: 2, status: "done", why: null }
]
const AFTER: Array<Event> = [
  { type: "end", n: 7, turn: 2, status: "done", why: null },
  { type: "accepted", n: 8, messages: [message(4, "user", "thanks")] }
]
const VIEW = ["user|hello", "asst|hi", "user|what is 1 + 1?", "program|return 1 + 1", "asst|It is 2.", "turn done|", "user|thanks"]

test("(f) the events by R4 and by R6 give the same view; a duplicate is dropped; an end connects again after the last number", async () => {
  const byStream = await load({ stored: JSON.stringify([A]), chats: { [A]: SNAPSHOT } })
  byStream.streams[0]!.send(...EVENTS.slice(0, 3))
  await byStream.clock.flush()
  expect(byStream.$("live").textContent).toBe("It is")
  byStream.streams[0]!.send(...EVENTS.slice(3))
  // A comment line (`: ping`) is no event.
  byStream.streams[0]!.write(": ping\n\n")
  byStream.streams[0]!.end()
  await byStream.clock.advance(0)
  const events = byStream.calls("GET", chatPath(A, "/events"))
  expect(events.map((one) => one.query.after)).toEqual(["2", "7"])
  expect(events.map((one) => one.headers.accept)).toEqual(["text/event-stream", "text/event-stream"])
  byStream.streams[1]!.send(...AFTER)
  await byStream.clock.flush()
  expect(byStream.entries()).toEqual(VIEW)
  expect(byStream.$("live").textContent).toBe("")

  const bySocket = await load({ stored: JSON.stringify([A]), chats: { [A]: SNAPSHOT } })
  await bySocket.way("socket")
  expect(bySocket.streams[0]!.aborted).toBe(true)
  const socket = bySocket.sockets[0]!
  socket.open()
  socket.give({ type: "ready" }, ...EVENTS.slice(0, 3))
  expect(bySocket.$("live").textContent).toBe("It is")
  socket.give(...EVENTS.slice(3), { type: "ping" })
  socket.end(1006)
  await bySocket.clock.advance(0)
  const again = bySocket.sockets[1]!
  again.open()
  expect(again.sent.map((one) => JSON.parse(one).after)).toEqual([7])
  again.give({ type: "ready" }, ...AFTER)
  expect(bySocket.entries()).toEqual(VIEW)
  expect(bySocket.entries()).toEqual(byStream.entries())

  // A number past the last plus one is a gap: dropped, and the page connects again after its last.
  again.give({ type: "message", n: 10, message: message(9, "asst", "far") })
  await bySocket.clock.advance(0)
  expect(bySocket.entries()).toEqual(VIEW)
  bySocket.sockets[2]!.open()
  expect(JSON.parse(bySocket.sockets[2]!.sent[0]!).after).toBe(8)
})

test("(f) the waits: after busy 1 s, twice as long in a row, at most 30 s, a longer retry-after wins; after internal one connection in 30 s", async () => {
  let busy = 8
  const page = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: {} },
    route: (call) => {
      if (call.path !== chatPath(A, "/events") || busy <= 0) {
        return undefined
      }
      busy--
      return fault(503, "busy", "The host is busy.", busy === 0 ? { "retry-after": "45" } : {})
    }
  })
  await page.clock.advance(200_000)
  const times = (list: Array<Sent>) => list.slice(1).map((one, k) => one.at - list[k]!.at)
  expect(times(page.calls("GET", chatPath(A, "/events")))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 45000])
  expect(page.streams.length).toBe(1)
  // A stream that started ends the row: each `close` of `busy` after a start waits 1 s.
  for (const k of [0, 1]) {
    const at = page.clock.now
    page.streams[k]!.send({ type: "close", reason: "busy" })
    await page.clock.advance(999)
    expect(page.streams.length).toBe(k + 1)
    await page.clock.advance(1)
    expect([page.streams.length, page.calls("GET", chatPath(A, "/events")).at(-1)!.at - at]).toEqual([k + 2, 1000])
  }
  // The socket's 4503 is `busy` too: 1 s, then 2 s while no `ready` came between.
  await page.way("socket")
  for (const [k, ms] of [[0, 1000], [1, 2000]] as const) {
    page.sockets[k]!.open()
    page.sockets[k]!.end(4503, "busy")
    await page.clock.advance(ms - 1)
    expect(page.sockets.length).toBe(k + 1)
    await page.clock.advance(1)
    expect(page.sockets.length).toBe(k + 2)
  }
  // After `ready` the row starts again.
  page.sockets[2]!.open()
  page.sockets[2]!.give({ type: "ready" })
  page.sockets[2]!.end(4503, "busy")
  await page.clock.advance(999)
  expect(page.sockets.length).toBe(3)
  await page.clock.advance(1)
  expect(page.sockets.length).toBe(4)

  // `internal`: the error is shown, and the page connects again by itself at most once in 30 s.
  let internal = 3
  const failing = await load({
    stored: JSON.stringify([B]),
    chats: { [B]: {} },
    route: (call) => (call.path === chatPath(B, "/events") && internal-- > 0 ? fault(500, "internal", "The host failed.") : undefined)
  })
  await failing.clock.advance(61_000)
  const tries = failing.calls("GET", chatPath(B, "/events"))
  expect(times(tries)).toEqual([0, 30000, 30000])
  expect(failing.$("error").textContent).toBe("The host failed.")
  // R4's `close` of `internal` at 61 s, and R6's 1011 at 90 s: each 30 s after the last connection again.
  failing.streams[0]!.send({ type: "close", reason: "internal" })
  await failing.clock.advance(28_999)
  expect(failing.calls("GET", chatPath(B, "/events")).length).toBe(4)
  await failing.clock.advance(1)
  expect(failing.calls("GET", chatPath(B, "/events")).length).toBe(5)
  await failing.way("socket")
  failing.sockets[0]!.open()
  failing.sockets[0]!.end(1011, "internal")
  await failing.clock.advance(29_999)
  expect(failing.sockets.length).toBe(1)
  await failing.clock.advance(1)
  expect(failing.sockets.length).toBe(2)
})

test("(g) a chat that R10 answers 404 no_chat for leaves the list", async () => {
  // One stored chat that the host does not have: dropped, and nothing more is asked.
  const one = await load({ stored: JSON.stringify([B]), chats: {} })
  expect(one.sent.map((call) => call.method + " " + call.path)).toEqual(["POST " + token("token")])
  expect(one.stored()).toBe("[]")
  expect(one.all("#chats li").length).toBe(0)
  expect(one.texts("#none")).toEqual(["No chat is open."])

  // Three, the middle one gone: R10 does not say which, so the page asks for halves.
  const three = await load({ stored: JSON.stringify([A, B, C]), chats: { [A]: {}, [C]: {} } })
  expect(three.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats)).toEqual([[A, B, C], [A, B], [A], [B], [C], [A, C]])
  expect(JSON.parse(three.stored()!)).toEqual([A, C])
  expect(three.texts("#chats button")).toEqual([C, A])
  expect(auth(three.calls("GET", chatPath(C))[0]!)).toBe("Bearer " + three.host.issued.at(-1))
})

// The five findings of the review ec-j56pa, one case for each ruling of ec-uq21h.

test("(h) ruling 1: a message whose answers were lost keeps its key: the same text is sent with it again, another text gets a new key, and no text crosses to another chat", async () => {
  // R1 logs each message and its answer is lost, while `lose` holds for that chat.
  const lose = new Set<string>([B])
  const page = await load({
    stored: JSON.stringify([A, B]),
    chats: { [A]: {}, [B]: {} },
    route: (call, own) => {
      const chat = /^\/v1\/chats\/([^/]+)\/messages$/.exec(call.path)?.[1]
      if (call.method !== "POST" || chat === undefined || !lose.has(chat)) {
        return undefined
      }
      own(call)
      return "network"
    }
  })
  const posts = (chat: string) => page.calls("POST", chatPath(chat, "/messages"))
  const keys = (chat: string) => posts(chat).map((one) => one.headers["idempotency-key"])
  // B is open. Five tries, each logged, each answer lost; then the text comes back.
  await page.say("once only")
  await page.clock.advance(15_000)
  expect(posts(B).length).toBe(5)
  expect(page.composer()).toBe("once only")
  expect(page.$("error").textContent).toBe("The host did not answer.")
  // A Send of it, the host answering again: the first key, and one message in the log.
  lose.delete(B)
  await page.say("once only")
  expect(new Set(keys(B)).size).toBe(1)
  expect(page.host.writes).toEqual([{ chat: B, text: "once only", key: keys(B)[0] }])
  // Another text: a new key.
  await page.say("another")
  expect(new Set(keys(B)).size).toBe(2)
  expect(page.host.writes.map((one) => one.text)).toEqual(["once only", "another"])

  // A chat switch while a message is under way: its text does not go into the other chat.
  lose.add(B)
  await page.say("for B")
  const kept = keys(B).at(-1)
  await page.open(A)
  await page.clock.advance(15_000)
  expect(page.composer()).toBe("")
  await page.say("for A")
  expect(posts(A).map((one) => [JSON.parse(one.body!).text, one.headers["idempotency-key"] === kept])).toEqual([["for A", false]])
  // Back in B, the text is there, and a Send of it has B's kept key.
  lose.delete(B)
  await page.open(B)
  expect(page.composer()).toBe("for B")
  await page.say("for B")
  expect(keys(B).at(-1)).toBe(kept)
  expect(page.host.writes.map((one) => one.chat + " " + one.text)).toEqual([B + " once only", B + " another", B + " for B", A + " for A"])
}, 15000)

test("(h) ruling 1, a changed text while its first message is kept: R1 logs the first text and its five answers are lost; the person changes the text that came back and sends it: a new key, and the log holds both messages", async () => {
  // R1 logs each message and its answer is lost, while `lose` holds.
  let lose = true
  const page = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: {} },
    route: (call, own) => {
      if (call.method !== "POST" || call.path !== chatPath(A, "/messages") || !lose) return undefined
      own(call)
      return "network"
    }
  })
  const keys = () => page.calls("POST", chatPath(A, "/messages")).map((one) => one.headers["idempotency-key"])
  await page.say("the first text")
  await page.clock.advance(15_000)
  expect(keys().length).toBe(5)
  expect(new Set(keys()).size).toBe(1)
  expect(page.composer()).toBe("the first text")
  expect(page.host.writes.map((one) => one.text)).toEqual(["the first text"])
  // The host answers again; the person changes the text, with the first
  // message still kept (no answer came for it), and sends.
  lose = false
  await page.say("a changed text")
  const [first, changed] = [keys()[0], keys().at(-1)]
  expect(new Set(keys()).size).toBe(2)
  expect(changed).not.toBe(first)
  expect(page.host.writes).toEqual([
    { chat: A, text: "the first text", key: first },
    { chat: A, text: "a changed text", key: changed }
  ])
  expect(page.composer()).toBe("")
}, 15000)

test("(i) ruling 2: a snapshot of an older opening changes nothing: each entry once, and no connection again", async () => {
  let release!: (answer: Response) => void
  let first = true
  const page = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: {} },
    route: (call) => {
      if (call.path !== chatPath(A) || !first) {
        return undefined
      }
      first = false
      return new Promise<Response>((resolve) => void (release = resolve))
    }
  })
  // The first R2 is held; the way changes, and the new opening reads its own.
  expect(page.calls("GET", chatPath(A)).length).toBe(1)
  await page.way("socket")
  expect(page.calls("GET", chatPath(A)).length).toBe(2)
  const socket = page.sockets[0]!
  socket.open()
  socket.give({ type: "ready" }, { type: "call", n: 1, turn: 1, call: 1, program: "return 1" })
  expect(page.entries()).toEqual(["program|return 1"])
  // The old R2 comes back with seq 0, after event 1.
  release(json(200, { chat: { uuid: A }, seq: 0, count: 0, messages: [], turn: null }))
  await page.clock.flush()
  socket.give({ type: "end", n: 2, turn: 1, status: "done", why: null })
  await page.clock.advance(0)
  expect(page.entries()).toEqual(["program|return 1", "turn done|"])
  expect([page.sockets.length, page.streams.length, socket.closedByPage]).toEqual([1, 0, false])
  expect([page.$("state").textContent, page.$("error").textContent]).toEqual(["connected by the socket", ""])
})

test("(j) ruling 3: New chat while a renewal for the older list is under way: the new chat's R2 has a token that names it, with one more R10", async () => {
  let held: Sent | undefined
  let release!: (answer: Response) => void
  let answer!: (sent: Sent) => Response | Stream
  let hold = false
  const page = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: {} },
    route: (call, own) => {
      if (!hold || call.path !== token("token")) {
        return undefined
      }
      hold = false
      held = call
      answer = own
      return new Promise<Response>((resolve) => void (release = resolve))
    }
  })
  hold = true
  await page.clock.advance(540_000)
  expect(held).toBeDefined()
  await page.click("new")
  const made = uuid(101)
  // The renewal under way ends with the fake host's own answer to it: a token of A alone.
  expect(JSON.parse(held!.body!)).toEqual({ chats: [A] })
  release(answer(held!) as Response)
  await page.clock.advance(0)
  expect(page.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats)).toEqual([[A], [A], [A, made]])
  const snapshot = page.calls("GET", chatPath(made))
  expect(snapshot.length).toBe(1)
  expect(page.host.tokens.get(auth(snapshot[0]!)!.replace(/^Bearer /, ""))!.chats).toContain(made)
  expect(page.calls("GET", chatPath(made, "/events")).length).toBe(1)
  expect(page.$("error").textContent).toBe("")
})

test("(k) ruling 4: R4's close with internal shows the page's sentence", async () => {
  const page = await load({ stored: JSON.stringify([A]), chats: { [A]: {} } })
  page.streams[0]!.send({ type: "close", reason: "internal" })
  await page.clock.advance(0)
  expect(page.$("error").textContent).toBe("The host had a fault. The page connects again.")
  expect(page.streams.length).toBe(2)
})

test("(l) ruling 5: R3's 401 gets a new token and the read again, one time; a second 401 shows the error and stops", async () => {
  const messages = Array.from({ length: 51 }, (_, k) => message(k, "user", "m" + k))
  const page = await load({ stored: JSON.stringify([A]), chats: { [A]: { seq: 51, messages } } })
  expect(page.entries().length).toBe(50)
  page.host.revoke()
  await page.click("older")
  const reads = () => page.calls("GET", chatPath(A, "/messages"))
  expect(reads().map((one) => [one.query.from, one.query.to])).toEqual([["0", "1"], ["0", "1"]])
  expect(page.calls("POST", token("token")).length).toBe(2)
  expect(page.entries()[0]).toBe("user|m0")
  expect(page.$("error").textContent).toBe("")

  // Every R3 refused: one read again, then the error, and no third read.
  const refusing = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: { seq: 51, messages } },
    route: (call) => (call.method === "GET" && call.path === chatPath(A, "/messages") ? fault(401, "unauthorized", "The token was refused.") : undefined)
  })
  await refusing.click("older")
  await refusing.clock.advance(1000)
  expect(refusing.calls("GET", chatPath(A, "/messages")).length).toBe(2)
  expect(refusing.calls("POST", token("token")).length).toBe(2)
  expect(refusing.$("error").textContent).toBe("The token was refused.")
  expect(refusing.entries().length).toBe(50)
})
