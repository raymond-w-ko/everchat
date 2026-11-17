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

test("(f) the waits, R4: a fetch with no answer is a connection that could not be made; it waits as after busy, 1 s, twice as long in a row, at most 30 s, and connects again with its last number; an end of a stream that ran connects again at once", async () => {
  // R4's fetch fails with no answer, eight times in a row.
  let down = 8
  const page = await load({
    stored: JSON.stringify([A]),
    chats: { [A]: SNAPSHOT },
    route: (call) => (call.path === chatPath(A, "/events") && down-- > 0 ? "network" : undefined)
  })
  await page.clock.advance(200_000)
  const times = (list: Array<Sent>) => list.slice(1).map((one, k) => one.at - list[k]!.at)
  const events = page.calls("GET", chatPath(A, "/events"))
  expect(times(events)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  expect(events.map((one) => one.query.after)).toEqual(Array(9).fill("2"))
  // No snapshot again: the view keeps its last number.
  expect(page.calls("GET", chatPath(A)).length).toBe(1)
  expect([page.streams.length, page.$("state").textContent]).toEqual([1, "connected by the stream"])

  // The stream ran: its end connects again at once, after its last number.
  const ends = page.clock.now
  page.streams[0]!.send(...EVENTS.slice(0, 2))
  page.streams[0]!.end()
  await page.clock.advance(0)
  expect(page.calls("GET", chatPath(A, "/events")).slice(9).map((one) => [one.at - ends, one.query.after])).toEqual([[0, "4"]])
  expect(page.$("error").textContent).toBe("")
})

test("(f) the waits, R6: a socket closed before its open, with a code that is not the host's, is a connection that could not be made; it waits as after busy, and connects again with its last number; a close of a socket that ran connects again at once", async () => {
  const page = await load({ stored: JSON.stringify([A]), chats: { [A]: SNAPSHOT } })
  page.streams[0]!.send(...EVENTS.slice(0, 2))
  await page.clock.flush()
  await page.way("socket")
  // 1 s, then 2 s, then 4 s.
  for (const [k, ms] of [[0, 1000], [1, 2000], [2, 4000]] as const) {
    page.sockets[k]!.end(1006)
    await page.clock.advance(ms - 1)
    expect([k, page.sockets.length]).toEqual([k, k + 1])
    await page.clock.advance(1)
    expect([k, page.sockets.length]).toEqual([k, k + 2])
  }
  // The fourth opens: its `auth` has the last number, and `ready` ends the row.
  const ran = page.sockets[3]!
  ran.open()
  expect(ran.sent.map((one) => JSON.parse(one).after)).toEqual([4])
  ran.give({ type: "ready" })
  expect(page.$("state").textContent).toBe("connected by the socket")
  // The socket ran: a close with the same code connects again at once.
  ran.end(1006)
  await page.clock.advance(0)
  expect(page.sockets.length).toBe(5)
  // And a close before the open after that row waits 1 s again.
  page.sockets[4]!.end(1006)
  await page.clock.advance(999)
  expect(page.sockets.length).toBe(5)
  await page.clock.advance(1)
  expect(page.sockets.length).toBe(6)
  expect(page.$("error").textContent).toBe("")
})

test("(g) a chat that R10 answers 404 no_chat for leaves the list", async () => {
  // One stored chat that the host does not have: dropped, and nothing more is asked.
  const one = await load({ stored: JSON.stringify([B]), chats: {} })
  expect(one.sent.map((call) => call.method + " " + call.path)).toEqual(["POST " + token("token")])
  expect(one.stored()).toBe("[]")
  expect(one.all("#chats li").length).toBe(0)
  expect(one.texts("#none")).toEqual(["No chat is open."])

  // Three, the middle one gone: R10 does not say which. The page asks for the
  // open chat (C) alone, whose token serves its R2; then, behind, for halves
  // of the rest ([A] is there, so B may be the gone one: it is asked for
  // alone, and leaves by its own 404; lead, ec-88qxe, 1), and at the end one
  // token for every chat that is left.
  const three = await load({ stored: JSON.stringify([A, B, C]), chats: { [A]: {}, [C]: {} } })
  expect(three.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats)).toEqual([[A, B, C], [C], [A], [B], [A, C]])
  expect(JSON.parse(three.stored()!)).toEqual([A, C])
  expect(three.texts("#chats button")).toEqual([C, A])
  expect(auth(three.calls("GET", chatPath(C))[0]!)).toBe("Bearer " + three.host.issued[0])
  expect(three.host.tokens.get(three.host.issued[0]!)!.chats).toEqual([C])
  expect(three.host.tokens.get(three.host.issued.at(-1)!)!.chats).toEqual([A, C])
  // A switch to A takes the last token, which names it: no more R10.
  await three.open(A)
  expect(three.calls("POST", token("token")).length).toBe(5)
  expect(auth(three.calls("GET", chatPath(A))[0]!)).toBe("Bearer " + three.host.issued.at(-1))
  expect(three.$("error").textContent).toBe("")
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

// The hunt for gone chats and the token's lists (lead, ec-ot20g).

// R10 as the host rates it: 60 asks in a window of a minute, then `429` with
// the seconds to the window's end. `refused` counts the 429s.
const rated = () => {
  const rate = { start: -Infinity, count: 0, refused: 0 }
  const route: Route = (call) => {
    if (call.path !== token("token")) {
      return undefined
    }
    if (call.at >= rate.start + 60_000) {
      rate.start = call.at
      rate.count = 0
    }
    if (++rate.count > 60) {
      rate.refused++
      return fault(429, "too_many", "Too many requests: try again later.", { "retry-after": String(Math.ceil((rate.start + 60_000 - call.at) / 1000)) })
    }
    return undefined
  }
  return { rate, route }
}
// The most calls of `list` in a span of 60 s: [t, t + 60 s) for each call's t.
const most = (list: Array<Sent>) => Math.max(0, ...list.map((one) => list.filter((other) => other.at >= one.at && other.at < one.at + 60_000).length))
const stale = (count: number) => Array.from({ length: count }, (_, k) => uuid(500 + k))

test("(m) rulings 1 to 3, every one of 64 stored chats gone: the open chat alone is asked next; New chat and its R2 come at once; the hunt asks R10 at most 30 times in each 60 s, ends with one token for the chats left, and puts no sentence on the page", async () => {
  const stored = stale(64)
  const { rate, route } = rated()
  const page = await load({ stored: JSON.stringify(stored), chats: {}, route })
  const t0 = page.clock.now
  const asks = () => page.calls("POST", token("token"))
  // The list, then the open chat (the newest) alone: gone too, so it leaves.
  expect(asks().slice(0, 2).map((call) => JSON.parse(call.body!).chats)).toEqual([stored, [stored[63]]])
  expect(JSON.parse(page.stored()!)).not.toContain(stored[63])
  expect(page.texts("#none")).toEqual(["No chat is open."])
  // The hunt runs behind, and New chat does not wait for it: R9, its token and its R2, at once.
  expect(JSON.parse(page.stored()!).length).toBeGreaterThan(1)
  await page.click("new")
  const made = uuid(101)
  const mine = page.sent.filter((call) => call.path === token("chats") || call.path === chatPath(made))
  expect(mine.map((call) => [call.method + " " + call.path, call.at - t0])).toEqual([["POST " + token("chats"), 0], ["GET " + chatPath(made), 0]])
  const hers = asks().filter((call) => JSON.parse(call.body!).chats.includes(made))
  expect([hers[0]!.at - t0, JSON.parse(hers[0]!.body!).chats]).toEqual([0, [made]])
  expect(page.host.tokens.get(auth(mine[1]!)!.replace(/^Bearer /, ""))!.chats).toEqual([made])
  expect(page.calls("GET", chatPath(made, "/events")).length).toBe(1)
  expect(page.$("error").textContent).toBe("")

  // Ten minutes: the hunt ends; every gone chat has left; the last token names the new chat.
  await page.clock.advance(600_000)
  expect(JSON.parse(page.stored()!)).toEqual([made])
  expect(page.texts("#chats button")).toEqual([made])
  const hunt = asks().filter((call) => call !== asks()[0] && call !== asks()[1] && call !== hers[0])
  expect(hunt.length).toBeGreaterThan(60)
  expect(most(hunt)).toBe(30)
  expect(JSON.parse(hunt.at(-1)!.body!).chats).toEqual([made])
  expect(page.host.tokens.get(page.host.issued.at(-1)!)!.chats).toEqual([made])
  expect(rate.refused).toBe(0)
  expect(page.$("error").textContent).toBe("")
  expect(page.document.body.textContent).not.toContain("Too many requests")
  expect(page.$("state").textContent).toBe("connected by the stream")
})

test("(m) rulings 1 and 2, the open chat there and 63 stored chats gone: its token comes at the second R10, its R2 and R4 at once; the hunt goes on behind and the open chat stays connected", async () => {
  const stored = stale(64)
  const open = stored[63]!
  const { rate, route } = rated()
  const page = await load({ stored: JSON.stringify(stored), chats: { [open]: { seq: 2, messages: [message(0, "user", "hello")] } }, route })
  const t0 = page.clock.now
  const asks = () => page.calls("POST", token("token"))
  expect(asks().slice(0, 2).map((call) => JSON.parse(call.body!).chats)).toEqual([stored, [open]])
  const read = page.calls("GET", chatPath(open))
  expect(read.map((call) => [call.at - t0, auth(call)])).toEqual([[0, "Bearer " + page.host.issued[0]]])
  expect(page.calls("GET", chatPath(open, "/events")).map((call) => call.at - t0)).toEqual([0])
  expect(page.entries()).toEqual(["user|hello"])
  expect(page.$("state").textContent).toBe("connected by the stream")
  // The hunt has not ended: some gone chats are still in the list.
  expect(JSON.parse(page.stored()!).length).toBeGreaterThan(1)

  await page.clock.advance(600_000)
  expect(JSON.parse(page.stored()!)).toEqual([open])
  const hunt = asks().slice(2)
  expect(most(hunt)).toBe(30)
  expect(JSON.parse(hunt.at(-1)!.body!).chats).toEqual([open])
  expect([rate.refused, page.$("error").textContent, page.streams.length, page.streams[0]!.aborted]).toEqual([0, "", 1, false])
})

test("(n) ruling 3: a 429 in the hunt waits its retry-after and asks again, with no sentence on the page", async () => {
  let refuse = 1
  const page = await load({
    stored: JSON.stringify([A, B, C]),
    chats: { [A]: {}, [C]: {} },
    route: (call) => {
      // The hunt's first call ([A], after the list and the open chat alone).
      if (call.path === token("token") && call.body === JSON.stringify({ chats: [A] }) && refuse-- > 0) {
        return fault(429, "too_many", "Too many requests: try again later.", { "retry-after": "7" })
      }
      return undefined
    }
  })
  const t0 = page.clock.now
  const asks = () => page.calls("POST", token("token")).map((call) => [JSON.parse(call.body!).chats, call.at - t0])
  expect(asks()).toEqual([[[A, B, C], 0], [[C], 0], [[A], 0]])
  expect(page.$("error").textContent).toBe("")
  expect(JSON.parse(page.stored()!)).toEqual([A, B, C])
  await page.clock.advance(6_999)
  expect(asks().length).toBe(3)
  await page.clock.advance(1)
  expect(asks()).toEqual([[[A, B, C], 0], [[C], 0], [[A], 0], [[A], 7000], [[B], 7000], [[A, C], 7000]])
  expect(JSON.parse(page.stored()!)).toEqual([A, C])
  expect([page.$("error").textContent, page.$("state").textContent]).toEqual(["", "connected by the stream"])
  expect(page.document.body.textContent).not.toContain("Too many requests")
})

test("(o) the token's list: the newest 64 of 70 stored chats; the open chat among them when it is older, with its R2 on that token", async () => {
  const stored = stale(70)
  const oldest = stored[0]!
  const page = await load({ stored: JSON.stringify(stored), chats: Object.fromEntries(stored.map((one) => [one, {}])) })
  const asks = () => page.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats as Array<string>)
  expect(asks()).toEqual([stored.slice(-64)])
  // The oldest chat, opened: a new token for 64 chats, the oldest among them.
  await page.open(oldest)
  expect(asks().length).toBe(2)
  const second = asks()[1]!
  expect(second.length).toBe(64)
  expect(new Set(second).size).toBe(64)
  expect(second).toContain(oldest)
  expect(second.filter((one) => one !== oldest)).toEqual(stored.slice(-63))
  expect(auth(page.calls("GET", chatPath(oldest))[0]!)).toBe("Bearer " + page.host.issued[1])
  expect(page.host.tokens.get(page.host.issued[1]!)!.chats).toContain(oldest)
  expect([page.$("error").textContent, page.$("state").textContent]).toEqual(["", "connected by the stream"])
})

test("(p) the token is in no address: R2, R3 (older messages), R4 and R1 carry it in the header Authorization only", async () => {
  const messages = Array.from({ length: 51 }, (_, k) => message(k, "user", "m" + k))
  const page = await load({ stored: JSON.stringify([A]), chats: { [A]: { seq: 51, messages } } })
  await page.click("older")
  await page.say("hello")
  const value = page.host.issued[0]!
  const reads = page.calls("GET", chatPath(A, "/messages"))
  expect(reads.map((one) => [one.query, auth(one)])).toEqual([[{ from: "0", to: "1" }, "Bearer " + value]])
  expect(page.entries()[0]).toBe("user|m0")
  const routes = page.sent.filter((one) => one.path.startsWith("/v1/")).map((one) => one.method + " " + one.path.replace(A, "A"))
  expect(routes).toEqual(["GET /v1/chats/A", "GET /v1/chats/A/events", "GET /v1/chats/A/messages", "POST /v1/chats/A/messages"])
  for (const one of page.sent) {
    expect(one.url).not.toContain(value)
    expect(one.url).not.toContain("token-")
    expect(Object.values(one.query).join(" ")).not.toContain("eyJ")
  }
})

// A chat made or opened while the gone open chat's R10 is under way (lead, ec-8gqty).

// The page over [A, B, C], with the open chat's ask alone ([C]) held until
// `release`; `answer` answers R10 for the new chat alone ([made]) when it
// gives a response.
const held = async (chats: Record<string, Partial<Chat>>, answer: (list: Array<string>) => Response | undefined = () => undefined) => {
  let release!: (answer: Response) => void
  let hold = true
  const page = await load({
    stored: JSON.stringify([A, B, C]),
    chats,
    route: (call) => {
      if (call.path !== token("token")) {
        return undefined
      }
      const list = (JSON.parse(call.body!) as { chats: Array<string> }).chats
      if (hold && list.length === 1 && list[0] === C) {
        hold = false
        return new Promise<Response>((resolve) => void (release = resolve))
      }
      return answer(list)
    }
  })
  const asks = () => page.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats as Array<string>)
  expect(asks()).toEqual([[A, B, C], [C]])
  return { page, asks, release: (response: Response) => release(response) }
}
const gone = () => fault(404, "no_chat", "This tenant has no chat with this UUID.")
const made = uuid(101)

test("(q) ruling 1: New chat while the gone open chat's R10 is under way: after its 404, the new chat's R2 and R4 come with no act of the person, on one more R10, for the new chat alone", async () => {
  const { page, asks, release } = await held({})
  const t0 = page.clock.now
  await page.click("new")
  expect(page.calls("POST", token("chats")).length).toBe(1)
  expect(page.calls("GET", chatPath(made)).length).toBe(0)
  release(gone())
  await page.clock.flush()
  // The shared ask for [C] ended with no token; the new chat's own ask, then the hunt behind ([A, B], [A], [B], and its token for the chat left).
  expect(asks()).toEqual([[A, B, C], [C], [A, B], [made], [A], [B], [made]])
  const read = page.calls("GET", chatPath(made))
  expect(read.map((call) => call.at - t0)).toEqual([0])
  expect(page.host.tokens.get(auth(read[0]!)!.replace(/^Bearer /, ""))!.chats).toEqual([made])
  expect(page.calls("GET", chatPath(made, "/events")).length).toBe(1)
  expect([page.$("error").textContent, page.$("state").textContent]).toEqual(["", "connected by the stream"])
  expect(JSON.parse(page.stored()!)).toEqual([made])
  await page.clock.advance(60_000)
  expect(asks().length).toBe(7)
  expect(page.calls("GET", chatPath(made)).length).toBe(1)
})

test("(r) ruling 2: a switch to a chat of the list that is there, while the gone open chat's R10 is under way: after its 404, that chat's R2 and R4 come, on one more R10, for it alone", async () => {
  const { page, asks, release } = await held({ [A]: {}, [B]: { seq: 1, messages: [message(0, "user", "in B")] } })
  await page.open(B)
  expect(page.calls("GET", chatPath(B)).length).toBe(0)
  release(gone())
  await page.clock.flush()
  // C leaves the list; B's own ask; the hunt finds [A, B] there and holds one token for both.
  expect(asks()).toEqual([[A, B, C], [C], [A, B], [B], [A, B]])
  expect(JSON.parse(page.stored()!)).toEqual([A, B])
  const read = page.calls("GET", chatPath(B))
  expect(read.length).toBe(1)
  expect(page.host.tokens.get(auth(read[0]!)!.replace(/^Bearer /, ""))!.chats).toEqual([B])
  expect(page.calls("GET", chatPath(B, "/events")).length).toBe(1)
  expect(page.entries()).toEqual(["user|in B"])
  expect([page.$("error").textContent, page.$("state").textContent]).toEqual(["", "connected by the stream"])
})

test("(s) ruling 1: the one more R10's 404 no_chat for the chat itself takes it off the list, with no third ask and no error", async () => {
  const { page, asks, release } = await held({}, (list) => (list.length === 1 && list[0] === made ? gone() : undefined))
  await page.click("new")
  release(gone())
  await page.clock.flush()
  // The new chat's own ask takes it off at once: the hunt ([A, B], [A], [B]) has no chat left to ask a token for.
  expect(asks()).toEqual([[A, B, C], [C], [A, B], [made], [A], [B]])
  await page.clock.advance(60_000)
  expect(asks().length).toBe(6)
  expect(JSON.parse(page.stored()!)).toEqual([])
  expect(page.calls("GET", chatPath(made)).length).toBe(0)
  expect(page.texts("#none")).toEqual(["No chat is open."])
  expect(page.all("#chats li").length).toBe(0)
  expect(page.$("error").textContent).toBe("")
})

test("(t) ruling 1: the one more R10's other failure shows the host's sentence, with no third ask in that call", async () => {
  let failing = true
  const { page, asks, release } = await held({}, (list) => (failing && list.length === 1 && list[0] === made ? fault(500, "internal", "The host failed.") : undefined))
  const t0 = page.clock.now
  await page.click("new")
  release(gone())
  await page.clock.flush()
  // The new chat's own ask fails; the hunt goes on behind, and its last ask (the same list) fails too, with no sentence of its own.
  expect(asks()).toEqual([[A, B, C], [C], [A, B], [made], [A], [B], [made]])
  expect(page.$("error").textContent).toBe("The host failed.")
  expect(page.calls("GET", chatPath(made)).length).toBe(0)
  expect(JSON.parse(page.stored()!)).toContain(made)
  // The connection's own wait (as after a fault of the network), then a new call of tokenFor, and its ask.
  failing = false
  await page.clock.advance(999)
  expect(asks().length).toBe(7)
  await page.clock.advance(1)
  expect(asks().length).toBe(8)
  expect(page.calls("GET", chatPath(made)).map((call) => call.at - t0)).toEqual([1000])
  expect(page.$("state").textContent).toBe("connected by the stream")
})

// The findings of the review ec-6wsu1 (lead, ec-88qxe).

test("(u) ruling 2: a 500 and a fault of the network in the hunt leave every chat in the list, put no sentence on the page and end the hunt", async () => {
  for (const failure of ["500", "network"] as const) {
    const page = await load({
      stored: JSON.stringify([A, B, C]),
      chats: { [A]: {}, [C]: {} },
      route: (call) =>
        // The hunt's first call: [A], after the list and the open chat alone.
        call.path === token("token") && call.body === JSON.stringify({ chats: [A] })
          ? failure === "500" ? fault(500, "internal", "The host failed.") : "network"
          : undefined
    })
    const asks = () => page.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats)
    expect([failure, asks()]).toEqual([failure, [[A, B, C], [C], [A]]])
    // A minute on: no more asks, every chat is there, and nothing is said.
    await page.clock.advance(60_000)
    expect([failure, asks().length, JSON.parse(page.stored()!), page.texts("#chats button")]).toEqual([failure, 3, [A, B, C], [C, B, A]])
    expect([failure, page.$("error").textContent, page.$("state").textContent]).toEqual([failure, "", "connected by the stream"])
    expect(page.document.body.textContent).not.toContain("The host failed.")
  }
})

test("(v) ruling 2: a host that answers 404 no_chat to the whole list though each half is fine is asked one round, the bound of the code: its halves down to each chat alone, and one ask for the whole list; then the hunt ends, with every chat kept", async () => {
  const page = await load({
    stored: JSON.stringify([A, B, C]),
    chats: { [A]: {}, [B]: {}, [C]: {} },
    route: (call) => (call.path === token("token") && call.body === JSON.stringify({ chats: [A, B, C] }) ? fault(404, "no_chat", "This tenant has no chat with this UUID.") : undefined)
  })
  const asks = () => page.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats)
  // The list, the open chat alone; the hunt: [A] and [B] are there, then the
  // whole list once more, 404 again with no chat found: the round ends it.
  expect(asks()).toEqual([[A, B, C], [C], [A], [B], [A, B, C]])
  // Five minutes (before the token's renewal): no more asks.
  await page.clock.advance(300_000)
  expect(asks().length).toBe(5)
  expect(JSON.parse(page.stored()!)).toEqual([A, B, C])
  expect(page.$("error").textContent).toBe("")
})

test("(w) ruling 2: the asks again after a 429 count in the hunt's 30 of each 60 s", async () => {
  const page = await load({
    stored: JSON.stringify([A, B, C]),
    chats: { [A]: {}, [C]: {} },
    route: (call) =>
      // The hunt's [A], for two minutes: 429 with a retry-after of 1 s.
      call.path === token("token") && call.body === JSON.stringify({ chats: [A] }) && call.at < page0 + 120_000
        ? fault(429, "too_many", "Too many requests: try again later.", { "retry-after": "1" })
        : undefined
  })
  const asks = () => page.calls("POST", token("token")).slice(2)
  await page.clock.advance(180_000)
  const hunt = asks()
  // At most 30 in any 60 s, the asks again too: 30 from 0, 30 from 60 s, then the rest.
  expect(most(hunt)).toBe(30)
  expect(hunt.filter((call) => call.at < page0 + 120_000).length).toBe(60)
  expect(hunt.slice(-3).map((call) => JSON.parse(call.body!).chats)).toEqual([[A], [B], [A, C]])
  expect(JSON.parse(page.stored()!)).toEqual([A, C])
  expect([page.$("error").textContent, page.document.body.textContent?.includes("Too many requests")]).toEqual(["", false])
})
// The clock's start, as every page's clock has it.
const page0 = new Clock().now

test("(x) ruling 1: 64 stored chats, the host has none, and from the N-th R10 on it has them all, for each N from 3 to 123 in steps of 6: no chat that the host has leaves the list; each chat that leaves had a 404 no_chat of its own", async () => {
  for (let n = 3; n <= 123; n += 6) {
    const stored = stale(64)
    const log: Array<{ chats: Array<string>; status: number; at: number }> = []
    let seen = 0
    let flip = Infinity
    const page = await load({
      stored: JSON.stringify(stored),
      chats: {},
      route: (call, own) => {
        if (call.path !== token("token")) return undefined
        if (++seen === n) flip = call.at
        const answer = seen >= n ? json(200, { token: "eyJ.all-" + seen + ".sig", exp: Math.floor(call.at / 1000) + 600 }) : (own(call) as Response)
        log.push({ chats: JSON.parse(call.body!).chats, status: answer.status, at: call.at })
        return answer
      }
    })
    await page.clock.advance(900_000)
    const left = JSON.parse(page.stored()!) as Array<string>
    const lost = stored.filter((one) => !left.includes(one))
    // Each lost chat: a call for it alone that the host, before it had the chats, answered 404 no_chat.
    const unnamed = lost.filter((one) => !log.some((call) => call.status === 404 && call.chats.length === 1 && call.chats[0] === one))
    expect([n, unnamed]).toEqual([n, []])
    expect([n, log.filter((call) => call.status === 404 && call.at > flip)]).toEqual([n, []])
    expect([n, page.$("error").textContent]).toEqual([n, ""])
    for (const browser of browsers.splice(0)) await browser.close()
  }
})

test("(y) a Send while a hunt runs, for a chat of the list that is there and is no longer open: each try goes out with a token that names that chat, on the renewal and one more R10; so does its send again after a 503; the open chat's connection goes on (lead, ec-cdeu2, 2)", async () => {
  // D is gone; A, B and C are there. The hunt for D waits: each R10 with D
  // in it is a 429 of 60 s while `stall` holds.
  const D = uuid(4)
  let stall = true
  let first = 1
  let lost = 1
  let busy = 1
  const page = await load({
    stored: JSON.stringify([D, A, B, C]),
    chats: { [A]: {}, [B]: {}, [C]: {} },
    route: (call) => {
      if (call.path === token("token") && (JSON.parse(call.body!) as { chats: Array<string> }).chats.includes(D) && first-- <= 0 && stall) {
        return fault(429, "too_many", "Too many requests: try again later.", { "retry-after": "60" })
      }
      if (call.method === "POST" && call.path === chatPath(B, "/messages")) {
        if (lost-- > 0) return "network"
        if (busy-- > 0) return fault(503, "busy", "The host is busy.", { "retry-after": "1" })
      }
      return undefined
    }
  })
  const t0 = page.clock.now
  const asks = () => page.calls("POST", token("token")).map((call) => (JSON.parse(call.body!) as { chats: Array<string> }).chats)
  const named = (call: Sent) => page.host.tokens.get(auth(call)!.replace(/^Bearer /, ""))!.chats
  const posts = () => page.calls("POST", chatPath(B, "/messages"))
  // The list's 404, the open chat C alone, then the hunt's first ask, which waits.
  expect(asks()).toEqual([[D, A, B, C], [C], [D, A]])
  // B is opened, and its Send's first try (B open) is lost to the network.
  await page.open(B)
  await page.say("for B")
  // C is opened: B is no longer open, and the token held names C alone.
  await page.open(C)
  expect(asks()).toEqual([[D, A, B, C], [C], [D, A], [B], [C]])
  // The try again, at 1 s: the renewal (for the open chat), and one more R10, for B.
  await page.clock.advance(1000)
  expect(asks().slice(5)).toEqual([[C], [B]])
  // C's stream ends: C connects again, and the token held names C alone again.
  page.streams.at(-1)!.end()
  await page.clock.advance(0)
  expect(asks().slice(7)).toEqual([[C]])
  // After the 503, at 2 s: the renewal, and one more R10, for B; then B's message is in.
  await page.clock.advance(2000)
  expect(asks().slice(8)).toEqual([[C], [B]])
  expect(posts().map((call) => [call.at - t0, named(call)])).toEqual([[0, [B]], [1000, [B]], [3000, [B]]])
  const key = posts()[0]!.headers["idempotency-key"]
  expect(posts().map((call) => call.headers["idempotency-key"])).toEqual([key, key, key])
  expect(page.host.writes).toEqual([{ chat: B, text: "for B", key }])
  // The open chat's connection went on: C's stream runs, and no error.
  expect([page.streams.at(-1)!.chat, page.streams.at(-1)!.aborted, page.$("state").textContent, page.$("error").textContent]).toEqual([C, false, "connected by the stream", ""])
  // The hunt was under way all this time; when the host lets it ask, D leaves.
  expect(JSON.parse(page.stored()!)).toContain(D)
  stall = false
  await page.clock.advance(60_000)
  expect(JSON.parse(page.stored()!)).toEqual([A, B, C])
  await page.open(B)
  expect(page.composer()).toBe("")
})

test("(z) ruling 1: two stored chats B and C, C open; the host has no B at the first R10 ([B, C] gets 404 no_chat) and has it from the N-th R10 on, for N = 2 and 3; the open chat alone gets 200, so the rest [B] is inferred to hold the gone chat: the page asks [B] alone, gets 200 and keeps B", async () => {
  // N = 2 and N = 3 take one path: the second R10 is [C] alone, which does
  // not name B, so its answer is the same whether the host has B by then or
  // not; the first R10 that names B after the 404 is the hunt's [B] (the
  // third), and the host has B there in both.
  for (const n of [2, 3]) {
    let seen = 0
    const page = await load({
      stored: JSON.stringify([B, C]),
      chats: { [B]: {}, [C]: {} },
      route: (call) => {
        if (call.path !== token("token")) return undefined
        seen += 1
        return seen < n && (JSON.parse(call.body!) as { chats: Array<string> }).chats.includes(B) ? gone() : undefined
      }
    })
    const asks = () => page.calls("POST", token("token")).map((call) => JSON.parse(call.body!).chats as Array<string>)
    await page.clock.advance(60_000)
    // The list, the open chat alone, the hunt's [B] alone, and one token for the chats left.
    expect([n, asks()]).toEqual([n, [[B, C], [C], [B], [B, C]]])
    expect([n, JSON.parse(page.stored()!), page.texts("#chats button")]).toEqual([n, [B, C], [C, B]])
    expect([n, page.$("error").textContent]).toEqual([n, ""])
    for (const browser of browsers.splice(0)) await browser.close()
  }
})
