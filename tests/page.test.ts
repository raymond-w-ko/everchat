// The inspector's page, in a browser with no window (happy-dom), against
// the real server over a real database: what the person sees, and what a
// click does. The page's script runs as it is.
//
// The browser here has no layout and no content security policy. So these
// tests say nothing about how the page looks, and src/inspector.test.ts
// checks the policy.

import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { Browser } from "happy-dom"
import { Memory } from "../src/memory.ts"
import type { Reply, Request } from "../src/request.ts"
import { Turns } from "../src/turn.ts"
import { fakeWire, inspector, newFile, reply, withChat } from "./help.ts"

const open: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close()
  }
})

type Found = { textContent: string; click(): void; getAttribute(name: string): string | null; querySelectorAll(selector: string): ArrayLike<Found>; querySelector(selector: string): Found | null }

// Waits, in real time, until `check` gives a value.
const until = async <A>(what: string, check: () => A | null | undefined | false, tries = 200): Promise<A> => {
  for (let k = 0; k < tries; k++) {
    const got = check()
    if (got !== null && got !== undefined && got !== false) {
      return got
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("the test waited for " + what)
}

// The page over the chat in `file`, at `hash`.
const show = async (file: string, hash = "") => {
  const served = await inspector(file)
  const browser = new Browser({ settings: { enableJavaScriptEvaluation: true, suppressCodeGenerationFromStringsWarning: true } })
  const page = browser.newPage()
  open.push(async () => {
    await browser.close()
    await served.close()
  })
  await page.goto(served.url + hash)
  const document = page.mainFrame.document as unknown as Found
  const all = (selector: string) => Array.from(document.querySelectorAll(selector))
  const texts = (selector: string) => all(selector).map((one) => one.textContent.replace(/\s+/g, " ").trim())
  // The element with this text, among those that match.
  const named = (selector: string, text: string) => until(selector + " with " + text, () => all(selector).find((one) => one.textContent.includes(text)))
  // All the words that the person sees: the top and the tab.
  const shown = () => [...texts("#top"), ...texts("main")].join(" ")
  return { document, all, texts, named, shown, address: () => page.mainFrame.url, url: served.url }
}

const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, { text: "", output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }], calls: [{ id, name: "run", input: program }] })
const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

const HOSTILE = '<img src=x onerror="document.title = 1"><script>document.title = 2</script>'

// A chat of two turns. The first runs a program. The second says a text
// that would be a script if it were HTML.
const chat = async () => {
  const file = newFile()
  await withChat(
    file,
    fakeWire((asked, n) => (n === 1 ? runs(asked, "call_1", "return 1 + 1") : says(asked, n === 2 ? "It is 2." : HOSTILE))),
    () => Effect.succeed({ output: "2", failed: false }),
    Effect.gen(function*() {
      const turns = yield* Turns
      yield* turns.say("what is 1 + 1?")
      yield* turns.idle
      yield* turns.say("and now " + HOSTILE)
      yield* turns.idle
      yield* (yield* Memory).idle
    })
  )
  return file
}

test("the page shows the chat: its top, its tree, its view, and its log", async () => {
  const page = await show(await chat())
  await until("the tree", () => page.all(".tree .row").length > 0)
  expect(page.texts("#top .fact")).toEqual([expect.stringMatching(/^chat [0-9a-f]{8}$/), "pick gpt-test · medium", "messages 6", "nodes 10"])
  expect(page.texts("#top .tag")).toEqual(["not running"])
  expect(page.texts("#tabs button")).toEqual(["Memory", "Requests", "Usage", "Diagnostics"])
  expect(page.texts("#tabs button[aria-selected=true]")).toEqual(["Memory"])
  // Six messages: the levels 2, 1 and 0, the highest first, and a node for each one built.
  expect(page.texts(".tree .lab")).toEqual(["level 2", "level 1", "level 0", "kind"])
  expect(page.all(".tree .cell").map((cell) => cell.getAttribute("data-l") + "/" + cell.getAttribute("data-i"))).toEqual(["2/0", "1/0", "1/1", "1/2", "0/0", "0/1", "0/2", "0/3", "0/4", "0/5"])
  // Every leaf is a part of both views.
  expect(page.all(".tree .cell.chat.seen").length).toBe(6)
  expect(page.all(".tree .cell.chat").length).toBe(6)
  expect(page.texts(".tree .cnt")).toEqual(["1 built", "3 built", "6 built"])
  expect(page.all(".strip .m").map((one) => one.getAttribute("class")?.split(" ")[1])).toEqual(["kind-user", "kind-tool", "kind-echo", "kind-asst", "kind-user", "kind-asst"])
  // The view: its lines in blocks, as the model reads them.
  expect(page.texts(".block .head")).toEqual(["block 1cache mark", "block 2(not whole yet)"])
  expect(page.texts(".block .line .ref")).toEqual(["0+1", "1+1", "2+1", "3+1", "4+1", "5+1"])
  expect(page.texts(".block .line .txt").slice(0, 4)).toEqual(["user: what is 1 + 1?", "tool: return 1 + 1", "echo: 2", "asst: It is 2."])
  // The log.
  expect(page.texts(".msg .id")).toEqual(["0", "1", "2", "3", "4", "5"])
  expect(page.texts(".msg .tag")).toEqual(["user", "tool", "echo", "asst", "user", "asst"])
  expect(page.texts("#error")).toEqual([""])
  // Nothing that is not there shows as a word.
  expect(page.shown()).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b|\[object/)
})

test("a text of the chat is on the page as text, and never as HTML", async () => {
  const page = await show(await chat())
  await until("the log", () => page.all(".msg").length === 6)
  expect(page.texts(".msg .txt")[5]).toBe(HOSTILE)
  expect(page.texts(".block .line .txt")[5]).toBe("asst: " + HOSTILE)
  // The node's panel and the turn's request show it too.
  ;(await page.named(".msg", "and now")).click()
  await page.named("aside .text", HOSTILE)
  ;(await page.named("#tabs button", "Requests")).click()
  await page.named(".part", HOSTILE)
  // No element came from the text: the page has its one script, and no image.
  expect(page.all("img, iframe, object, embed").length).toBe(0)
  expect(page.all("script").length).toBe(1)
  expect(page.texts("title")).toEqual(["EverChat inspector"])
})

test("a click on a line shows its node, and the address keeps what the page shows", async () => {
  const file = await chat()
  const page = await show(file)
  ;(await page.named(".line", "echo: 2")).click()
  const panel = await page.named("aside .card", "2+1")
  const facts = () => page.texts("aside dl dd")
  expect(facts()[0]).toBe("message 2")
  expect(facts()[1]).toContain("It is its source: the source fits, so no request was needed.")
  expect(facts().slice(2, 5)).toEqual(["7 of 512 bytes", "the chat view, the compaction view", "2+2"])
  expect(page.all(".line.sel .ref").map((one) => one.textContent)).toEqual(["2+1"])
  expect(page.all(".tree .cell.sel").map((cell) => cell.getAttribute("data-l") + "/" + cell.getAttribute("data-i"))).toEqual(["0/2"])
  expect(page.address()).toBe(page.url + "#tab=memory&view=chat&node=0.2")
  // The node above it, by its button.
  ;(await page.named("aside button", "2+2")).click()
  await page.named("aside .card h2", "2+2")
  expect(facts().slice(0, 1)).toEqual(["2 messages, 2 to 3"])
  expect(facts()[3]).toBe("no: a node above it or nodes below it are")
  expect(page.texts("aside dl dd button")).toEqual(["2 messages, 2 to 3", "0+4", "2+1", "3+1"])
  expect(page.address()).toBe(page.url + "#tab=memory&view=chat&node=1.1")
  // A cell of the tree does the same.
  ;(await until("the root's cell", () => page.all(".tree .cell").find((cell) => cell.getAttribute("data-l") === "2"))).click()
  await page.named("aside .card h2", "0+4")
  // The same address shows the same again.
  const again = await show(file, "#tab=memory&view=seen&node=1.1")
  await again.named("aside .card h2", "2+2")
  expect(again.texts(".bar button.on")).toEqual(["compaction view"])
  // A range of messages is in the address too: a fixed one, or the last ones of the chat.
  const some = await show(file, "#tab=memory&from=2&to=4")
  await until("the log", () => some.all(".msg").length === 2)
  expect(some.texts(".msg .id")).toEqual(["2", "3"])
  expect(some.all(".tree .cell").map((cell) => cell.getAttribute("data-l") + "/" + cell.getAttribute("data-i"))).toEqual(["2/0", "1/1", "0/2", "0/3"])
  ;(await some.named(".bar button", "last 64")).click()
  await until("the whole log", () => some.all(".msg").length === 6)
  const last = await show(file, "#tab=memory&last=3")
  await until("the log", () => last.all(".msg").length === 3)
  expect(last.texts(".msg .id")).toEqual(["3", "4", "5"])
  ;(await last.named(".msg", "and now")).click()
  await last.named("aside .card h2", "4+1")
  expect(last.address()).toBe(last.url + "#tab=memory&last=3&view=chat&node=0.4")
})

test("the requests tab shows a turn's request part by part, and leads from a line to its node", async () => {
  const page = await show(await chat(), "#tab=requests")
  // The newest turn first, and it is the one shown.
  await until("the turns", () => page.all(".turns .t").length === 2)
  expect(page.texts(".turns .t b")).toEqual(["Turn 2", "Turn 1"])
  await page.named("h2", "Turn 2")
  const names = () => page.texts(".part > .name b")
  expect(names()).toEqual(["System prompt", "Tool", "The view", "The new messages, whole", "Step 1: the model's reply"])
  // The other turn has a program and its result between two steps.
  ;(await page.named(".turns .t", "Turn 1")).click()
  await page.named("h2", "Turn 1")
  await until("the first turn's parts", () => names().length === 8)
  expect(names()).toEqual(["System prompt", "Tool", "The view", "The new messages, whole", "Step 1: the model's reply", "Program", "Result", "Step 2: the model's reply"])
  expect(page.texts(".part-tool .text")).toEqual(["return 1 + 1"])
  expect(page.texts(".part-echo .text")).toEqual(["2"])
  expect(page.texts(".part-asst .text")).toEqual(["It is 2."])
  expect(page.shown()).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b|\[object/)
  expect(page.address()).toBe(page.url + "#tab=requests&turn=1")
  // The body of the second step's request, as the wire builds it.
  const buttons = await until("the body buttons", () => (page.all(".part-asst button").length === 2 ? page.all(".part-asst button") : null))
  buttons[1]!.click()
  // A long text shows its start, until the person asks for all of it.
  ;(await page.named(".part-asst button", "show all")).click()
  const body = await page.named(".part-asst .text", "prompt_cache_key")
  expect(JSON.parse(body.textContent).input.map((one: { role?: string; type?: string }) => one.role ?? one.type)).toEqual(["developer", "user", "custom_tool_call", "custom_tool_call_output"])
  // The second turn's view holds the first turn. A line of it leads to its node.
  ;(await page.named(".turns .t", "Turn 2")).click()
  await page.named("h2", "Turn 2")
  ;(await page.named(".part-view summary", "show its lines")).click()
  ;(await page.named(".part-view .line", "asst: It is 2.")).click()
  await page.named("aside .card h2", "3+1")
  expect(page.texts("#tabs button[aria-selected=true]")).toEqual(["Memory"])
})

test("the usage and the diagnostics tabs list what the database holds", async () => {
  const page = await show(await chat(), "#tab=usage")
  await page.named(".tile", "Turns")
  expect(page.texts(".tile .big")).toEqual(["3 requests"])
  expect(page.shown()).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b|\[object/)
  expect(page.all("table tr").length).toBe(4)
  ;(await page.named("#tabs button", "Diagnostics")).click()
  await page.named("h2", "Launches")
  expect(page.texts(".empty")).toEqual(["None."])
  expect(page.all("table tr").length).toBe(2)
})

test("the page follows the chat: a new message shows with no reload", async () => {
  const file = newFile()
  await withChat(
    file,
    fakeWire((asked, n) => says(asked, "Answer " + n + ".")),
    () => Effect.die("no program was expected"),
    Effect.gen(function*() {
      const turns = yield* Turns
      yield* turns.say("first")
      yield* turns.idle
      const page = yield* Effect.promise(() => show(file))
      yield* Effect.promise(() => until("the log", () => page.all(".msg").length === 2))
      yield* turns.say("second")
      yield* turns.idle
      // The page asks every 1.5 s whether the database changed.
      yield* Effect.promise(() => until("the new messages", () => page.all(".msg").length === 4, 500))
      expect(page.texts(".msg .txt")).toEqual(["first", "Answer 1.", "second", "Answer 2."])
      expect(page.texts("#top .fact")[2]).toBe("messages 4")
      // The tree grew with the chat: it still starts at the first message.
      expect(page.all(".tree .cell").filter((cell) => cell.getAttribute("data-l") === "0").length).toBe(4)
    })
  )
}, 15000)

test("a server that is gone is said on the page", async () => {
  const file = await chat()
  const served = await inspector(file)
  const browser = new Browser({ settings: { enableJavaScriptEvaluation: true, suppressCodeGenerationFromStringsWarning: true } })
  open.push(() => browser.close())
  const page = browser.newPage()
  await page.goto(served.url)
  const document = page.mainFrame.document as unknown as Found
  await until("the log", () => document.querySelectorAll(".msg").length === 6)
  await served.close()
  const said = await until("the error", () => {
    const text = document.querySelector("#error")?.textContent ?? ""
    return text === "" ? null : text
  }, 500)
  expect(said).toContain("The inspector did not answer")
  // What it showed stays.
  expect(document.querySelectorAll(".msg").length).toBe(6)
}, 15000)
