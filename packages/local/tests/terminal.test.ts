// The terminal, whole: the turn loop with a fake wire, the real sandbox and
// functions, and a terminal in memory (screen.ts). What the person sees,
// what a key does, and what the database holds after.

import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import * as path from "node:path"
import { Ask, AskDelay } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import * as Diagnostics from "@everchat/core/diagnostics"
import { limitLayer } from "../src/limitfile.ts"
import { DECLARATIONS, functionsLayer } from "../src/localfunctions.ts"
import { Memory } from "@everchat/core/memory"
import { OpenAI } from "@everchat/openai"
import { type Pace, QUIET } from "@everchat/core/pace"
import type { Event, Reply, Request, WireError } from "@everchat/core/request"
import { Shell } from "../src/shell.ts"
import { storeLayer } from "@everchat/sqlite/bun"
import { type Answered, type Approval, type ApprovalAnswer, Store, type StoreError } from "@everchat/core/store"
import { Approvals } from "@everchat/core/approval"
import { COMMANDS, expires, HELP, SHOWN, Terminal, usage, WHO } from "../src/terminal.ts"
import { visible, waits as waitsNote } from "@everchat/core/functions"
import { threadLayer } from "@everchat/codemode/thread"
import { type TurnEvent, Turns } from "@everchat/core/turn"
import { compactor, newFile, options, PICK as PICKED, reply, rows, wireError } from "./help.ts"
import { KEYS, Screen } from "./screen.ts"
import { head } from "@everchat/core/head"

// A fake wire: `answer` gives the events of the n-th request (1, 2, ...).
const wireOf = (answer: (asked: Request, n: number) => Stream.Stream<Event, WireError>) => {
  const sent: Array<Request> = []
  const layer = Layer.succeed(OpenAI, OpenAI.of({ send: (asked) => Stream.suspend(() => (sent.push(asked), answer(asked, sent.length))) }))
  return { sent, layer }
}

const says = (asked: Request, text: string): Reply => reply(asked, { text, output: [{ type: "message", content: [{ type: "output_text", text }] }] })

const runs = (asked: Request, id: string, program: string): Reply =>
  reply(asked, { text: "", output: [{ type: "custom_tool_call", call_id: id, name: "run", input: program }], calls: [{ id, name: "run", input: program }] })

// The events of a reply that comes at once.
const whole = (got: Reply): Stream.Stream<Event, WireError> =>
  Stream.make<Array<Event>>(...(got.text === "" ? [] : [{ type: "text" as const, delta: got.text }]), { type: "end", reply: got })

// A wire whose model says one text to every request.
const talker = (text = "Hello to you.") => wireOf((asked) => whole(says(asked, text)))

// A fake `Approvals`: `rows` are the approvals that wait; `asked` keeps
// each answer that it was given; `result` says what became of it (by
// default: no such approval).
const fakeApprovals = (rows: Array<Approval> = [], result: (n: number, answer: ApprovalAnswer) => Answered = () => ({ _tag: "none" })) => {
  const asked: Array<{ n: number; answer: ApprovalAnswer }> = []
  const layer = Layer.succeed(
    Approvals,
    Approvals.of({
      waiting: Effect.sync(() => [...rows]),
      answer: (n, answer) => Effect.sync(() => (asked.push({ n, answer }), result(n, answer)))
    })
  )
  return { rows, asked, layer }
}

// One launch of the whole program, with the screen `screen`, and the fake
// approvals `approvals`.
const launch = <A, E>(
  file: string,
  wire: { layer: Layer.Layer<OpenAI> },
  screen: Screen,
  effect: Effect.Effect<A, E, Terminal | Turns | Store | Memory>,
  pace?: Pace,
  approvals: ReturnType<typeof fakeApprovals> = fakeApprovals()
) => {
  const cwd = path.dirname(file)
  // The logger is under every layer, and merged: see diagnostics.ts.
  const store = Diagnostics.layer.pipe(Layer.provideMerge(storeLayer(file, options({ runTag: "tag-" + crypto.randomUUID() }))))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const limits = limitLayer({ dir: path.join(cwd, "results") }).pipe(Layer.provide(store))
  const shell = Shell.layer({ cwd, shell: "/bin/sh" }).pipe(Layer.provide(store))
  const functions = functionsLayer(DECLARATIONS, { cwd }).pipe(Layer.provide(Layer.mergeAll(memory, shell, limits)))
  const sandbox = threadLayer().pipe(Layer.provide(functions), Layer.provide(store))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const turns = Turns.layer({ head: head(DECLARATIONS) }).pipe(Layer.provideMerge(memory), Layer.provide(Layer.mergeAll(asking, sandbox, limits)))
  const terminal = Terminal.layer({ tty: screen, cwd, pace }).pipe(Layer.provideMerge(turns), Layer.provide(approvals.layer))
  return Effect.runPromise(effect.pipe(Effect.provide(terminal), Effect.provideService(AskDelay, () => Effect.succeed(0))))
}

// Waits, in real time, until the screen's text passes `check`.
const until = (screen: Screen, what: string, check: (text: string) => boolean) =>
  Effect.gen(function*() {
    let text = ""
    for (let k = 0; k < 1000; k++) {
      text = yield* Effect.promise(() => screen.text())
      if (check(text)) {
        return text
      }
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die(new Error("the screen never showed: " + what + "\n" + text))
  })

const sees = (screen: Screen, ...texts: ReadonlyArray<string>) => until(screen, texts.join(" and "), (text) => texts.every((one) => text.includes(one)))

const PICK = " · gpt-test medium"
const IDLE = "idle" + PICK
const idle = (screen: Screen) => sees(screen, IDLE)

const messages = (file: string) => rows<{ kind: string; text: string }>(file, "select kind, text from everchat_msg_read order by i")


const turns = (file: string) => rows<{ id: number; status: string }>(file, "select n as id, status from everchat_turn order by n")

const send = (screen: Screen, text: string) => {
  screen.type(text)
  screen.type(KEYS.enter)
}

// A part of a reply that waits for `gate`.
const waits = (gate: Deferred.Deferred<void>): Stream.Stream<Event, WireError> => Stream.drain(Stream.fromEffect(Deferred.await(gate)))
const gate = () => Effect.runSync(Deferred.make<void>())
const open = (one: Deferred.Deferred<void>) => Effect.asVoid(Deferred.succeed(one, undefined))

const RULE = "─".repeat(60)

// What the screen shows
// ---------------------

test("a message that the person sends is shown when it is in the log, and the reply under it", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  await launch(file, talker(), screen, Effect.gen(function*() {
    yield* idle(screen)
    expect(yield* Effect.promise(() => screen.all())).toEqual(["", RULE, "", RULE, IDLE])
    send(screen, "hello")
    yield* sees(screen, "Hello to you.", IDLE)
    expect(yield* Effect.promise(() => screen.all())).toEqual(["", "› hello", "", "Hello to you.", "", RULE, "", RULE, IDLE])
  }))
  expect(messages(file)).toEqual([{ kind: "user", text: "hello" }, { kind: "asst", text: "Hello to you." }])
  expect(screen.started).toBe(1)
  expect(screen.stopped).toBe(1)
})

test("EverChat's words are drawn as markdown", async () => {
  const file = newFile()
  const screen = new Screen(60, 30)
  const wire = talker("# A title\n\nSome **bold** words and `code`.\n\n- one\n- two\n\n```ts\nconst x = 1\n```")
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "show me")
    const text = yield* sees(screen, "const x = 1", IDLE)
    expect(text).toContain("A title\n\nSome bold words and code.\n\n- one\n- two\n")
    expect(text).not.toContain("**")
    expect(text).not.toContain("# A title")
  }))
})

test("what the model gives is shown as it streams: the thought, then the text, and the text stays once", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  const [first, second] = [gate(), gate()]
  const wire = wireOf((asked) =>
    Stream.make<Array<Event>>({ type: "thought", delta: "I think about " }, { type: "thought", delta: "the greeting." }).pipe(
      Stream.concat(waits(first)),
      Stream.concat(Stream.make<Array<Event>>({ type: "text", delta: "Hello, " })),
      Stream.concat(waits(second)),
      Stream.concat(Stream.make<Array<Event>>({ type: "text", delta: "**world**." }, { type: "end", reply: says(asked, "Hello, **world**.") }))
    ))
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "greet me")
    const thinking = yield* sees(screen, "I think about the greeting.", "turn 1 · works · ")
    expect(thinking).toMatch(/\nturn 1 · works · \d s · Esc stops · gpt-test medium$/)
    yield* open(first)
    // The thought goes when the text starts: it is not in the log.
    const half = yield* until(screen, "the first half", (text) => text.includes("Hello,") && !text.includes("I think"))
    expect(half).not.toContain("world")
    yield* open(second)
    const done = yield* sees(screen, "Hello, world.", IDLE)
    expect(done.split("Hello,").length).toBe(2)
    expect(yield* Effect.promise(() => screen.all())).toEqual(["", "› greet me", "", "Hello, world.", "", RULE, "", RULE, IDLE])
  }))
})

test("a text is shown a paragraph at a time, and not each word", async () => {
  const file = newFile()
  const screen = new Screen(60, 24)
  const [first, second] = [gate(), gate()]
  const said = "The first block is whole.\n\nThe second block has `code` in it.\n\nThe third one ends the reply."
  const wire = wireOf((asked) =>
    Stream.make<Array<Event>>({ type: "text", delta: "The first block " }, { type: "text", delta: "is whole.\n\nThe second bl" }).pipe(
      Stream.concat(waits(first)),
      Stream.concat(Stream.make<Array<Event>>({ type: "text", delta: "ock has `code` in it.\n\nThe third one" })),
      Stream.concat(waits(second)),
      Stream.concat(Stream.make<Array<Event>>({ type: "text", delta: " ends the reply." }, { type: "end", reply: says(asked, said) }))
    ))
  // No time gives a text on in this test: only the end of a paragraph does.
  const never = { limit: 3_600_000, quiet: 3_600_000, long: 3_600_000 }
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "say three things")
    const one = yield* sees(screen, "The first block is whole.")
    expect(one).not.toContain("The second")
    // Longer than the time after which a held text is given on by default.
    yield* Effect.sleep(QUIET + 200)
    expect(yield* Effect.promise(() => screen.text())).not.toContain("The second")
    yield* open(first)
    yield* sees(screen, "The second block has code in it.")
    yield* Effect.sleep("150 millis")
    expect(yield* Effect.promise(() => screen.text())).not.toContain("The third")
    yield* open(second)
    // The last paragraph was never given on: the message of the log shows it.
    yield* sees(screen, "The third one ends the reply.", IDLE)
    expect(yield* Effect.promise(() => screen.all())).toEqual([
      "",
      "› say three things",
      "",
      "The first block is whole.",
      "",
      "The second block has code in it.",
      "",
      "The third one ends the reply.",
      "",
      RULE,
      "",
      RULE,
      IDLE
    ])
  }), never)
})

test("a text that has no end of a paragraph still moves: its whole lines are shown after a short time", async () => {
  const file = newFile()
  const screen = new Screen(60, 24)
  const held = gate()
  const wire = wireOf((asked) =>
    Stream.make<Array<Event>>({ type: "text", delta: "- one\n- two\n- thr" }).pipe(
      Stream.concat(waits(held)),
      Stream.concat(Stream.make<Array<Event>>({ type: "text", delta: "ee" }, { type: "end", reply: says(asked, "- one\n- two\n- three") }))
    ))
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "list them")
    // Nothing comes for a while: all that is held is shown.
    yield* sees(screen, "- one", "- two", "- thr")
    yield* open(held)
    yield* sees(screen, "- three", IDLE)
  }))
})

test("a program is shown whole when it starts to run, then its result, each once; while the model writes it, the status row says so", async () => {
  const file = newFile()
  const screen = new Screen(60, 24)
  const [written, after] = [gate(), gate()]
  const code = "const said = await shell('sleep 0.4; echo it ran')\nreturn said"
  const wire = wireOf((asked, n) =>
    n === 1
      ? Stream.make<Array<Event>>({ type: "program", delta: "const said = await shell(" }).pipe(
        Stream.concat(waits(written)),
        Stream.concat(Stream.make<Array<Event>>({ type: "end", reply: runs(asked, "call_1", code) }))
      )
      : Stream.concat(waits(after), whole(says(asked, "It ran."))))
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "run it")
    // Half a program is not shown: it says nothing to a person.
    const writing = yield* sees(screen, "turn 1 · writes a program · ")
    expect(writing).not.toContain("▸")
    expect(writing).not.toContain("const said")
    yield* open(written)
    const running = yield* sees(screen, "  return said", "turn 1 · runs a program · ")
    expect(running).not.toContain("◂")
    // The program has ended, and the model works on its next step.
    yield* sees(screen, "◂ it ran", "turn 1 · works · ")
    yield* open(after)
    const done = yield* sees(screen, "◂ it ran", "It ran.", IDLE)
    expect(done.split("const said = await shell").length).toBe(2)
    expect(yield* Effect.promise(() => screen.all())).toEqual([
      "",
      "› run it",
      "",
      "▸ const said = await shell('sleep 0.4; echo it ran')",
      "  return said",
      "◂ it ran",
      expect.stringMatching(/^ {2}\(exit 0 in \d\.\d s\)$/),
      "",
      "It ran.",
      "",
      RULE,
      "",
      RULE,
      IDLE
    ])
  }))
  expect(messages(file).map((one) => one.kind)).toEqual(["user", "tool", "echo", "asst"])
})

test("a long result shows its first rows and its last two, and the log holds it whole", async () => {
  const file = newFile()
  const screen = new Screen(60, 40)
  const wire = wireOf((asked, n) => whole(n === 1 ? runs(asked, "call_1", "return Array.from({ length: 40 }, (_, k) => 'item ' + k).join('\\n')") : says(asked, "Done.")))
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "list them")
    const text = yield* sees(screen, "Done.", IDLE)
    expect(text).toContain("◂ item 0\n  item 1\n")
    expect(text).toContain("  item 8\n  … 29 more rows\n  item 38\n  item 39\n")
    expect(text).not.toContain("item 9\n")
  }))
  expect(messages(file)[2]!.text.split("\n").length).toBe(40)
})

test("no control character of a result or of a reply reaches the terminal", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  const wire = wireOf((asked, n) =>
    whole(n === 1 ? runs(asked, "call_1", "return '\\u001b[2J\\u001b[31mred\\u001b[0m and\\ta \\u0007bell\\r\\nnext \\u009b5mrow'") : says(asked, "It is \u001b[35mpurple\u001b[0m\u0007.")))
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "color it")
    const text = yield* sees(screen, "It is purple.", IDLE)
    expect(text).toContain("◂ red and    a bell\n  next 5mrow\n")
    // The person's message is still there: nothing cleared the screen.
    expect(text).toContain("› color it")
  }))
  expect(screen.written).not.toContain("\u001b[31m")
  expect(screen.written).not.toContain("\u001b[35m")
  // The renderer ends each row with its own reset of a link, which holds a bell character.
  expect(screen.written.replaceAll("\u001b]8;;\u0007", "")).not.toContain("\u0007")
  // The log holds the result as the program gave it.
  expect(messages(file)[2]!.text).toContain("\u001b[31mred")
})

test("a narrow terminal, long words and wide characters: every row fits, and nothing fails", async () => {
  const file = newFile()
  const screen = new Screen(14, 30)
  const wire = wireOf((asked, n) => whole(n === 1 ? runs(asked, "call_1", "return 'W'.repeat(40) + ' 日本語日本語日本語日本語 😀😀😀😀😀😀😀😀'") : says(asked, "A" + "b".repeat(40) + " 日本語日本語日本語日本語.")))
  await launch(file, wire, screen, Effect.gen(function*() {
    send(screen, "x".repeat(30))
    const text = yield* sees(screen, "idle · gpt-te…", "日本語")
    expect(text).toContain("› xxxxxxxxxxxx\n  xxxxxxxxxxxx\n  xxxxxx")
    expect(text).toContain("◂ WWWWWWWWWWWW\n")
    screen.resize(7, 30)
    screen.resize(30, 30)
    send(screen, "again")
    yield* sees(screen, "› again", IDLE)
  }))
  expect(turns(file).map((one) => one.status)).toEqual(["done", "done"])
})

test("a turn that failed leaves its note on the screen, and the terminal is idle again", async () => {
  const file = newFile()
  const screen = new Screen(80, 20)
  const wire = wireOf(() => Stream.fail(wireError("auth", { message: "The key was refused." })))
  await launch(file, wire, screen, Effect.gen(function*() {
    send(screen, "hello")
    yield* sees(screen, "· No reply: The key was refused. Send a message to try again.", IDLE)
  }))
  expect(turns(file)).toEqual([{ id: 1, status: "failed" }])
})

// The keys
// --------

test("Esc stops the turn that runs: its note is shown, and what streamed and is not in the log goes", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  const wire = wireOf(() => Stream.concat(Stream.make<Array<Event>>({ type: "text", delta: "I start to answer" }), Stream.never))
  await launch(file, wire, screen, Effect.gen(function*() {
    send(screen, "tell me all")
    yield* sees(screen, "I start to answer", "turn 1 · works · ")
    screen.type(KEYS.escape)
    const text = yield* sees(screen, "· Stopped.", IDLE)
    expect(text).not.toContain("I start to answer")
    // With no turn, Esc stops nothing, and /stop says so.
    screen.type(KEYS.escape)
    send(screen, "/stop")
    yield* sees(screen, "No turn runs.")
  }))
  expect(turns(file)).toEqual([{ id: 1, status: "stopped" }])
  expect(messages(file)).toEqual([{ kind: "user", text: "tell me all" }, { kind: "note", text: "Stopped." }])
})

test("a stop while the model writes a program: nothing of the program is shown, and the next turn works", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  const held = gate()
  const wire = wireOf((asked, n) =>
    n === 1
      ? Stream.concat(Stream.make<Array<Event>>({ type: "program", delta: "const half = " }), Stream.never)
      : Stream.concat(waits(held), whole(says(asked, "Here I am."))))
  await launch(file, wire, screen, Effect.gen(function*() {
    send(screen, "write it")
    yield* sees(screen, "turn 1 · writes a program · ")
    screen.type(KEYS.escape)
    const stopped = yield* sees(screen, "· Stopped.", IDLE)
    expect(stopped).not.toContain("const half")
    send(screen, "are you there?")
    yield* sees(screen, "turn 2 · works · ")
    yield* open(held)
    yield* sees(screen, "Here I am.", IDLE)
  }))
  expect(turns(file)).toEqual([{ id: 1, status: "stopped" }, { id: 2, status: "done" }])
})

test("a message that is sent while a turn runs is shown at once, and it steers that turn", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  const held = gate()
  const wire = wireOf((asked, n) => (n === 1 ? Stream.concat(waits(held), whole(runs(asked, "call_1", "return 1"))) : whole(says(asked, "Both are done."))))
  await launch(file, wire, screen, Effect.gen(function*() {
    send(screen, "the first")
    yield* sees(screen, "› the first", "turn 1 · works · ")
    send(screen, "the second")
    yield* sees(screen, "› the second", "turn 1 · works · ")
    yield* open(held)
    yield* sees(screen, "Both are done.", IDLE)
  }))
  expect(turns(file)).toEqual([{ id: 1, status: "done" }])
  expect(messages(file).map((one) => one.text)).toEqual(["the first", "the second", "return 1", "1", "Both are done."])
  expect(wire.sent.length).toBe(2)
})

test("Ctrl+C empties the input, and twice with an empty input it quits; Ctrl+D quits only when the input is empty", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  await launch(file, talker(), screen, Effect.gen(function*() {
    const terminal = yield* Terminal
    const quit = yield* Effect.forkChild(terminal.quit)
    yield* idle(screen)
    screen.type("some words")
    yield* sees(screen, "some words")
    screen.type(KEYS.ctrlD)
    screen.type(KEYS.ctrlC)
    yield* until(screen, "an empty input", (text) => !text.includes("some words"))
    expect(quit.pollUnsafe()).toBe(undefined)
    screen.type(KEYS.ctrlC)
    yield* sees(screen, "Press Ctrl+C again to quit")
    yield* Effect.sleep("20 millis")
    expect(quit.pollUnsafe()).toBe(undefined)
    screen.type(KEYS.ctrlC)
    yield* Fiber.join(quit)
  }))
  const second = new Screen(60, 20)
  await launch(file, talker(), second, Effect.gen(function*() {
    const terminal = yield* Terminal
    yield* idle(second)
    second.type(KEYS.ctrlD)
    yield* terminal.quit
  }))
  // Nothing of this is a message.
  expect(messages(file)).toEqual([])
})

test("a terminal that names each key by its own sequence: a press works, and a release does nothing", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  // The keys as the Kitty keyboard protocol sends them, which Ghostty speaks.
  const [escape, ctrlC] = ["\u001b[27u", "\u001b[99;5u"]
  const released = (key: string) => key.replace("u", ":3u")
  const wire = wireOf(() => Stream.concat(Stream.make<Array<Event>>({ type: "text", delta: "I start to answer" }), Stream.never))
  await launch(file, wire, screen, Effect.gen(function*() {
    const terminal = yield* Terminal
    const quit = yield* Effect.forkChild(terminal.quit)
    send(screen, "tell me all")
    yield* sees(screen, "I start to answer", "turn 1 · works · ")
    screen.type(released(escape))
    yield* Effect.sleep("30 millis")
    expect(turns(file)).toEqual([{ id: 1, status: "running" }])
    screen.type(escape)
    yield* sees(screen, "· Stopped.", IDLE)
    screen.type(released(ctrlC))
    screen.type(released(ctrlC))
    yield* Effect.sleep("30 millis")
    expect(quit.pollUnsafe()).toBe(undefined)
    expect(yield* Effect.promise(() => screen.text())).not.toContain("Press Ctrl+C again")
    screen.type(ctrlC)
    yield* sees(screen, "Press Ctrl+C again to quit")
    screen.type(ctrlC)
    yield* Fiber.join(quit)
  }))
  expect(turns(file)).toEqual([{ id: 1, status: "stopped" }])
})

// The slash commands
// ------------------

test("a slash command is not a message: /help, /diagnostics, and one that is not known", async () => {
  const file = newFile()
  const screen = new Screen(80, 40)
  const wire = talker()
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "/help")
    const help = yield* sees(screen, "Ctrl+D         quits, when the input is empty")
    expect(help).toContain(HELP.split("\n").map((row) => "  " + row).join("\n"))
    send(screen, "/diagnostics")
    yield* sees(screen, "No diagnostics.")
    yield* Effect.logWarning("a request was sent again").pipe(Effect.annotateLogs("source", "ask"))
    yield* Effect.sleep(Diagnostics.WINDOW * 3)
    send(screen, "/diagnostics 5")
    const shown = yield* sees(screen, " warn ask: a request was sent again")
    expect(shown).toMatch(/\n {2}\d{4}-\d\d-\d\d \d\d:\d\d:\d\d warn ask: a request was sent again/)
    send(screen, "/diagnostics many")
    yield* sees(screen, "Give a number of diagnostics: /diagnostics 50")
    send(screen, "/nope")
    yield* sees(screen, "No slash command /nope. /help lists them.")
  }))
  expect(messages(file)).toEqual([])
  expect(wire.sent.length).toBe(0)
})

test("a line that starts with a path is a message, and /quit ends the terminal", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  await launch(file, talker("I will look."), screen, Effect.gen(function*() {
    const terminal = yield* Terminal
    send(screen, "/tmp/x is full")
    yield* sees(screen, "› /tmp/x is full", "I will look.", IDLE)
    send(screen, "/quit")
    yield* terminal.quit
  }))
  expect(messages(file)).toEqual([{ kind: "user", text: "/tmp/x is full" }, { kind: "asst", text: "I will look." }])
})

// The log, and the next launch
// ----------------------------

test("a message that entered the log with no event is shown before the next one, in the log's order", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  await launch(file, talker(), screen, Effect.gen(function*() {
    yield* idle(screen)
    const memory = yield* Memory
    yield* memory.push([{ kind: "note", text: "a quiet note" }, { kind: "work", text: "[CalmOtter] It is **built**." }])
    send(screen, "what now?")
    yield* sees(screen, "Hello to you.", IDLE)
    expect((yield* Effect.promise(() => screen.all())).slice(0, 8)).toEqual(["", "· a quiet note", "", "[CalmOtter] It is built.", "", "› what now?", "", "Hello to you."])
  }))
})

// A turn loop that only sends the events that a test gives it. `before`
// runs with the store when the terminal subscribes, just before the
// subscription is there; `after` runs just after.
const fakeTurns = (
  before: (store: Store["Service"], publish: (event: TurnEvent) => Effect.Effect<void>) => Effect.Effect<void, StoreError>,
  after: (store: Store["Service"], publish: (event: TurnEvent) => Effect.Effect<void>) => Effect.Effect<void, StoreError> = () => Effect.void
) => {
  const made: { publish: (event: TurnEvent) => Effect.Effect<void> } = { publish: () => Effect.void }
  const layer = Layer.effect(
    Turns,
    Effect.gen(function*() {
      const store = yield* Store
      const hub = yield* PubSub.unbounded<TurnEvent>()
      made.publish = (event) => Effect.asVoid(PubSub.publish(hub, event))
      return Turns.of({
        say: () => Effect.die("not used"),
        stop: () => Effect.void,
        note: () => Effect.die("not used"),
        ready: Effect.void,
        idle: Effect.void,
        busy: Effect.succeed(false),
        worked: Effect.succeed(0),
        events: Stream.fromPubSub(hub),
        subscribe: Effect.gen(function*() {
          yield* Effect.orDie(before(store, made.publish))
          const subscription = yield* PubSub.subscribe(hub)
          yield* Effect.orDie(after(store, made.publish))
          return subscription
        })
      })
    })
  )
  return { made, layer }
}

const withFake = <A, E>(
  file: string,
  screen: Screen,
  fake: ReturnType<typeof fakeTurns>,
  effect: Effect.Effect<A, E, Terminal | Turns | Store>,
  approvals: ReturnType<typeof fakeApprovals> = fakeApprovals()
) => {
  const store = Diagnostics.layer.pipe(Layer.provideMerge(storeLayer(file, options())))
  return Effect.runPromise(effect.pipe(Effect.provide(Terminal.layer({ tty: screen }).pipe(Layer.provideMerge(fake.layer), Layer.provide(approvals.layer), Layer.provideMerge(store)))))
}

test("no message is shown twice or left out, whenever its event comes: before the subscription, just after it, or never", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  const fake = fakeTurns(
    // A message that enters the log, with its event, just before the
    // subscription: the event is lost, so the log must be read after.
    (store, publish) =>
      Effect.gen(function*() {
        const [early] = yield* store.append([{ kind: "user", text: "the first" }])
        yield* publish({ type: "accepted", n: 1, messages: [early!] })
      }),
    // One just after the subscription: it is in the log that the terminal
    // reads, and its event comes too.
    (store, publish) =>
      Effect.gen(function*() {
        const [late] = yield* store.append([{ kind: "asst", text: "The second." }])
        yield* publish({ type: "message", n: 2, message: late! })
      })
  )
  await withFake(file, screen, fake, Effect.gen(function*() {
    yield* sees(screen, "The second.", "idle")
    // One with no event at all, then one with an event.
    const more = yield* (yield* Store).append([{ kind: "note", text: "a quiet note" }, { kind: "asst", text: "The fourth." }])
    yield* fake.made.publish({ type: "message", n: 4, message: more[1]! })
    yield* sees(screen, "The fourth.")
    // The event of the quiet one comes late.
    yield* fake.made.publish({ type: "message", n: 3, message: more[0]! })
    yield* fake.made.publish({ type: "end", n: 5, turn: 1, status: "done", why: null })
    yield* Effect.sleep("50 millis")
    expect(yield* Effect.promise(() => screen.all())).toEqual(["", "› the first", "", "The second.", "", "· a quiet note", "", "The fourth.", "", RULE, "", RULE, IDLE])
  }))
})

test("a turn that runs at the launch is shown at work, also when the terminal gets no event of its start", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  const fake = fakeTurns((store) =>
    Effect.gen(function*() {
      yield* store.append([{ kind: "user", text: "work on it" }])
      yield* store.startTurn({ pick: PICKED, head: "{}", firstMsg: 0 })
    })
  )
  await withFake(file, screen, fake, Effect.gen(function*() {
    yield* sees(screen, "› work on it", "turn 1 · works · ")
    yield* fake.made.publish({ type: "end", n: 5, turn: 1, status: "done", why: null })
    yield* idle(screen)
  }))
})

test("the next launch shows the last messages of the log, each text whole, and puts the draft back", async () => {
  const file = newFile()
  const first = new Screen(60, 20)
  const long = "long ".repeat(13000) // 65,000 characters: 3 pages
  await launch(file, talker(), first, Effect.gen(function*() {
    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: long }])
    yield* memory.push(Array.from({ length: SHOWN - 3 }, (_, k) => ({ kind: "note" as const, text: "note " + k })))
    send(first, "the last question")
    yield* sees(first, "Hello to you.", IDLE)
    first.type("half a thought")
    yield* sees(first, "half a thought")
    for (let k = 0; k < 400 && rows<{ draft: string | null }>(file, "select draft from everchat_chat")[0]!.draft !== "half a thought"; k++) {
      yield* Effect.sleep("5 millis")
    }
    // One more key just before the end: the end writes the draft as it is then.
    first.type("!")
  }))
  expect(rows(file, "select draft from everchat_chat")).toEqual([{ draft: "half a thought!" }])
  expect(rows(file, "select count(*) as n from everchat_msg")).toEqual([{ n: SHOWN + 2 }])

  const second = new Screen(60, 20)
  await launch(file, talker(), second, Effect.gen(function*() {
    const text = yield* sees(second, "half a thought!", IDLE)
    // The long text starts before the last 40 messages: it is not shown in part.
    expect(text).toStartWith("\n  3 earlier messages are in the memory.\n\n· note 0\n")
    expect(text).not.toContain("long")
    expect(text).toContain("· note " + (SHOWN - 4) + "\n\n› the last question\n\nHello to you.\n")
    // Up in an empty input walks the person's messages.
    second.type(KEYS.ctrlC)
    yield* until(second, "an empty input", (now) => !now.includes("half a thought"))
    second.type(KEYS.up)
    yield* until(second, "the last message in the input", (now) => now.split("the last question").length === 3)
    // Sent, a draft is no longer one.
    second.type(KEYS.ctrlC)
    send(second, "a new one")
    yield* until(second, "the new message, and the reply to it", (now) => now.includes("› a new one") && now.split("Hello to you.").length === 3 && now.includes(IDLE))
  }))
  expect(rows(file, "select draft from everchat_chat")).toEqual([{ draft: null }])
})

test("a text of many pages is one message on the screen", async () => {
  const file = newFile()
  const screen = new Screen(60, 20)
  await launch(file, talker(), screen, Effect.gen(function*() {
    const turnsService = yield* Turns
    yield* turnsService.say("word ".repeat(13000))
    const text = yield* sees(screen, "Hello to you.", IDLE)
    expect(text.split("›").length).toBe(2)
    expect(text.split("word").length).toBe(13001)
  }))
  expect(rows(file, "select count(*) as n from everchat_msg where kind = (select id from everchat_kind where name = 'user')")).toEqual([{ n: 3 }])
})

test("a launch that finds a cut turn shows it at work, and then its reply", async () => {
  const file = newFile()
  const first = new Screen(60, 20)
  await launch(file, wireOf(() => Stream.never), first, Effect.gen(function*() {
    send(first, "do not forget me")
    yield* sees(first, "› do not forget me", "turn 1 · works · ")
  }))
  expect(turns(file)).toEqual([{ id: 1, status: "running" }])
  const second = new Screen(60, 20)
  const held = gate()
  await launch(file, wireOf((asked) => Stream.concat(waits(held), whole(says(asked, "I did not.")))), second, Effect.gen(function*() {
    yield* sees(second, "› do not forget me", "turn 1 · works · ")
    yield* open(held)
    yield* sees(second, "I did not.", IDLE)
  }))
  expect(turns(file)).toEqual([{ id: 1, status: "done" }])
})

// Approvals
// ---------

// When the approvals of these tests were made.
const MADE = Date.UTC(2026, 10, 17, 12, 0, 0)

// An approval that waits, with `over` over it.
const approval = (id: number, over: Partial<Approval> = {}): Approval => ({
  id,
  turn: 1,
  call: id + 1,
  fn: "acme.send",
  input: "[{\"to\":\"ann\"}]",
  status: "pending",
  who: null,
  answer: null,
  answered: null,
  output: null,
  ended: null,
  msg: null,
  created: MADE,
  updated: MADE,
  ...over
})

// The screen's rows of what the terminal told, joined with their indent
// taken off: a text that wraps over rows is whole again.
const unwrapped = (rows: ReadonlyArray<string>) => rows.map((row) => row.replace(/^ {2}/, "")).join("")

// A turn loop that does nothing.
const quiet = () => fakeTurns(() => Effect.void)

test("/help lists /approvals, /approve and /deny", () => {
  expect(COMMANDS.map((one) => one.name)).toEqual(["help", "stop", "diagnostics", "approvals", "approve", "deny", "quit"])
  for (const name of ["approvals", "approve", "deny"]) {
    expect(HELP).toContain("  /" + name.padEnd(13))
  }
  // Each row of /help fits the 80 columns of the slash command's test, with the indent.
  expect(Math.max(...HELP.split("\n").map((row) => row.length))).toBeLessThanOrEqual(78)
})

test("/approvals with none, then with two: each with its number, its function, its arguments on one line (a long one cut) and when it expires", async () => {
  const file = newFile()
  const screen = new Screen(200, 30)
  const approvals = fakeApprovals()
  const long = "[\"" + "0123456789".repeat(30) + "\"]"
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/approvals")
    yield* sees(screen, "No call waits for approval.")
    approvals.rows.push(approval(1), approval(2, { fn: "acme.post", input: long }))
    send(screen, "/approvals")
    const text = yield* sees(screen, "Calls that wait for approval")
    expect(text).toContain("  Calls that wait for approval (/approve n, /deny n):\n" +
      "    1  acme.send  [{\"to\":\"ann\"}]  expires " + expires(approval(1)) + "\n" +
      "    2  acme.post  " + long.slice(0, 100) + "… (" + long.length + " characters: /approvals <n>)  expires " + expires(approval(2)))
    // Seven days after it was made.
    expect(expires(approval(1))).toBe(new Date(MADE + 7 * 24 * 3600 * 1000).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }))
  }), approvals)
  expect(approvals.asked).toEqual([])
})

test("/approvals 2 shows one approval whole: every character of arguments of 5,000 characters, on as many rows as they need", async () => {
  const file = newFile()
  const screen = new Screen(100, 30)
  const input = "[\"" + Array.from({ length: 4996 }, (_, k) => String.fromCharCode(97 + (k % 26))).join("") + "\"]"
  expect(input.length).toBe(5000)
  const approvals = fakeApprovals([approval(1), approval(2, { input, turn: 3 })])
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/approvals 2")
    yield* sees(screen, "Approval 2: acme.send, in turn 3")
    const rows = yield* Effect.promise(() => screen.all())
    const start = rows.findIndex((row) => row.includes("Its arguments, whole (5000 characters):"))
    expect(start).toBeGreaterThan(0)
    const told = rows.slice(start + 1, rows.findIndex((row, k) => k > start && row === ""))
    expect(told.length).toBeGreaterThan(50)
    expect(unwrapped(told)).toBe(input)
    send(screen, "/approvals 7")
    yield* sees(screen, "No approval 7 waits.")
    send(screen, "/approvals two")
    yield* sees(screen, "Give the number of an approval: /approvals 2")
  }), approvals)
  expect(approvals.asked).toEqual([])
})

// What the fake service gives for each number: 2 is answered as asked; 3
// is none; 4 was answered no before; 5 expired.
const results = (n: number, answer: ApprovalAnswer): Answered =>
  n === 2
    ? { _tag: "answered", approval: approval(2, { status: answer.yes ? "yes" : "no", who: answer.who, answer: answer.text ?? null, answered: MADE }) }
    : n === 3
    ? { _tag: "none" }
    : n === 4
    ? { _tag: "closed", approval: approval(4, { status: "no", who: WHO, answer: "not \u001b[2Jthis one", answered: MADE }) }
    : { _tag: "expired", approval: approval(5, { status: "expired", answered: MADE }) }

test("/approve 2 looks fine and /deny 2 no: the service gets the number, yes or no, who and the text; each of the five results has its line", async () => {
  const file = newFile()
  const screen = new Screen(120, 40)
  const approvals = fakeApprovals([approval(2)], results)
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/approve 2 looks fine")
    yield* sees(screen, "Approval 2: yes. The call runs now; its result starts a turn.")
    send(screen, "/deny 2 no")
    yield* sees(screen, "Approval 2: no. The call does not run; the chat is told.")
    send(screen, "/approve 3")
    yield* sees(screen, "No approval 3.")
    send(screen, "/approve 4")
    yield* sees(screen, "Approval 4 was answered already: no, by the person in the terminal (\"not \\x1b[2Jthis one\").")
    send(screen, "/deny 5   ")
    yield* sees(screen, "Approval 5 expired: it waited more than 7 days, and the call does not run.")
  }), approvals)
  expect(WHO).toBe("the person in the terminal")
  expect(approvals.asked).toEqual([
    { n: 2, answer: { yes: true, who: WHO, text: "looks fine" } },
    { n: 2, answer: { yes: false, who: WHO, text: "no" } },
    { n: 3, answer: { yes: true, who: WHO, text: null } },
    { n: 4, answer: { yes: true, who: WHO, text: null } },
    { n: 5, answer: { yes: false, who: WHO, text: null } }
  ])
})

test("/approve, /approve x, /approve 0, /approve 2.5 and /deny -1 give the usage, and the service is not asked", async () => {
  const file = newFile()
  const screen = new Screen(120, 40)
  const approvals = fakeApprovals([approval(2)], results)
  const count = (text: string, part: string) => text.split(part).length - 1
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    for (const sent of ["/approve", "/approve x", "/approve 0", "/approve 2.5"]) {
      send(screen, sent)
    }
    yield* until(screen, "four usages", (text) => count(text, usage("approve")) === 4)
    send(screen, "/deny -1 no")
    yield* sees(screen, usage("deny"))
  }), approvals)
  expect(usage("approve")).toBe("Give the number of an approval: /approve 2 [text]. /approvals lists them.")
  expect(approvals.asked).toEqual([])
})

test("an answer while a turn runs: the service is asked, and its line shown, before the turn ends", async () => {
  const file = newFile()
  const screen = new Screen(100, 30)
  const held = gate()
  const wire = wireOf((asked) => Stream.concat(waits(held), whole(says(asked, "Done."))))
  const approvals = fakeApprovals([approval(2)], results)
  await launch(file, wire, screen, Effect.gen(function*() {
    yield* idle(screen)
    send(screen, "hello")
    yield* sees(screen, "turn 1 · works")
    send(screen, "/approve 2 yes please")
    yield* sees(screen, "Approval 2: yes. The call runs now; its result starts a turn.")
    expect(approvals.asked).toEqual([{ n: 2, answer: { yes: true, who: WHO, text: "yes please" } }])
    expect(turns(file)).toEqual([{ id: 1, status: "running" }])
    yield* open(held)
    yield* sees(screen, "Done.", IDLE)
  }), undefined, approvals)
  expect(turns(file)).toEqual([{ id: 1, status: "done" }])
})

test("a model's text in an approval is shown with each control character as an escape: ESC [2J, U+009B and a line end; no such character reaches the screen", async () => {
  const file = newFile()
  const screen = new Screen(160, 40)
  const input = "[\"\u001b[2Jgone\",\"\u009b31mred\",\"a\nb\",\"\u007f\"]"
  const approvals = fakeApprovals([approval(1, { fn: "acme.se\u001b[8mnd", input })], results)
  const shown = "[\"\\x1b[2Jgone\",\"\\x9b31mred\",\"a\\x0ab\",\"\\x7f\"]"
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/approvals")
    yield* sees(screen, "1  acme.se\\x1b[8mnd  " + shown + "  expires")
    send(screen, "/approvals 1")
    yield* sees(screen, "Approval 1: acme.se\\x1b[8mnd, in turn 1", "(" + input.length + " characters):\n  " + shown)
    send(screen, "/approve 4")
    const text = yield* sees(screen, "(\"not \\x1b[2Jthis one\")")
    for (const one of ["\u001b", "\u009b", "\u007f"]) {
      expect(text).not.toContain(one)
    }
    // The list, the whole, and the answer: nothing was cleared above them.
    expect(text).toContain("idle")
  }), approvals)
})

// The code points that draw as nothing or change the order on the screen
// (terminal.ts, `visible`), and the escape of each.
const HIDDEN_ONE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u
const escapeOf = (code: number) => (code < 0x100 ? "\\x" + code.toString(16).padStart(2, "0") : "\\u{" + code.toString(16) + "}")

// Each of them in an approval's text: the bidi controls U+202E and U+2066,
// the zero-width U+200B and U+200D, U+2028, U+FEFF, the soft hyphen, the
// variation selectors U+FE0F and U+E0100, the tag U+E0041, the filler
// U+3164, the private U+E000, the unassigned U+0378 and a surrogate with
// no pair.
const UNSEEN = [0x202e, 0x2066, 0x200b, 0x200d, 0x2028, 0xfeff, 0xad, 0xfe0f, 0xe0041, 0xe0100, 0x3164, 0xe000, 0x378, 0xd800]

test("an approval's text with characters that draw as nothing or change the order (bidi, zero-width, U+2028, U+FEFF, the soft hyphen, variation selectors, a tag, a filler, private, unassigned, a lone surrogate): none reaches the screen, each is there as its escape", async () => {
  const file = newFile()
  // Wide enough for the list's row of escapes on one row.
  const screen = new Screen(400, 40)
  const hidden = UNSEEN.map((code) => String.fromCodePoint(code)).join("")
  const shown = UNSEEN.map(escapeOf).join("")
  expect(shown).toBe("\\u{202e}\\u{2066}\\u{200b}\\u{200d}\\u{2028}\\u{feff}\\xad\\u{fe0f}\\u{e0041}\\u{e0100}\\u{3164}\\u{e000}\\u{378}\\u{d800}")
  const input = "[\"Lunch at noon?" + hidden + "\"]"
  const approvals = fakeApprovals([approval(1, { fn: "acme.se" + hidden + "nd", input })], (n) => ({
    _tag: "closed",
    approval: approval(n, { status: "yes", who: WHO + hidden, answer: "fine" + hidden, answered: MADE })
  }))
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    // Each wait is for a part that no escape changes; then the assertions.
    send(screen, "/approvals")
    yield* sees(screen, "Calls that wait for approval")
    send(screen, "/approvals 1")
    yield* sees(screen, "Approval 1: acme.se")
    send(screen, "/approve 1")
    const text = yield* sees(screen, "Approval 1 was answered already: yes, by ")
    // No such character reached the screen.
    expect([...text].filter((one) => UNSEEN.includes(one.codePointAt(0)!)).map((one) => one.codePointAt(0)!.toString(16))).toEqual([])
    expect([...text].filter((one) => HIDDEN_ONE.test(one) && one !== "\n").map((one) => one.codePointAt(0)!.toString(16))).toEqual([])
    // Each is there as its escape: in the list, whole, and in the answer.
    expect(text).toContain("1  acme.se" + shown + "nd  [\"Lunch at noon?" + shown + "\"]  expires")
    expect(text).toContain("Approval 1: acme.se" + shown + "nd, in turn 1")
    expect(text).toContain("(" + input.length + " characters):\n  [\"Lunch at noon?" + shown + "\"]")
    expect(text).toContain("Approval 1 was answered already: yes, by " + WHO + shown + " (\"fine" + shown + "\").")
  }), approvals)
})

test("an approval's text with é, 日本語, a Hebrew word, an emoji of one code point and U+00A0 is shown as it is", async () => {
  const file = newFile()
  const screen = new Screen(200, 30)
  const said = "café 日本語 שלום 😀 ok"
  expect(visible(said)).toBe(said)
  const approvals = fakeApprovals([approval(1, { input: "[\"" + said + "\"]" })])
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/approvals 1")
    yield* sees(screen, "\n  [\"" + said + "\"]")
  }), approvals)
})

test("visible over every code point from U+0000 to U+10FFFF: each of the set is its escape, every other is as it is, and what it gives has none of the set", () => {
  let escaped = 0
  for (let code = 0; code <= 0x10ffff; code++) {
    const one = String.fromCodePoint(code)
    const got = visible(one)
    const want = HIDDEN_ONE.test(one) ? escapeOf(code) : one
    if (got !== want) {
      expect({ code: code.toString(16), got }).toEqual({ code: code.toString(16), got: want })
    }
    for (const part of got) {
      if (HIDDEN_ONE.test(part)) {
        expect({ code: code.toString(16), part: part.codePointAt(0)!.toString(16) }).toEqual({ code: code.toString(16), part: "none of the set" })
      }
    }
    if (got !== one) escaped++
  }
  // The set holds the C0, DEL and C1 (65), the surrogates (2,048), the
  // private planes, the tags and much more: not a few.
  expect(escaped).toBeGreaterThan(65 + 2048 + 6400)
})

test("the note of a waiting call whose arguments have U+E0041 and U+009B, as the terminal draws it after the program: both are there as their escapes, and neither reaches the screen", async () => {
  const file = newFile()
  const screen = new Screen(200, 30)
  const fake = quiet()
  // The note that the turn loop logs after the program (core, `waits`).
  const note = waitsNote(approval(1, { input: "[\"ok\u{e0041}\u{e0042}\",\"\u009b31mred\"]" }))
  await withFake(file, screen, fake, Effect.gen(function*() {
    yield* sees(screen, "idle")
    const pages = yield* (yield* Store).append([
      { kind: "tool", text: "await acme.send('ok')" },
      { kind: "echo", text: "{\"pending\":1}" },
      { kind: "note", text: note }
    ])
    for (const [k, page] of pages.entries()) {
      yield* fake.made.publish({ type: "message", n: k + 1, message: page })
    }
    const text = yield* sees(screen, "· Approval 1 waits for a person's yes or no: acme.send(")
    expect([...text].filter((one) => one === "\u{e0041}" || one === "\u{e0042}" || one === "\u009b").map((one) => one.codePointAt(0)!.toString(16))).toEqual([])
    expect(text).toContain("· Approval 1 waits for a person's yes or no: acme.send(\"ok\\u{e0041}\\u{e0042}\",\"\\x9b31mred\"). The call did not run.")
  }))
})

test("at a turn's end, one line when calls wait: 1 approval waits, 2 approvals wait, and none with 0", async () => {
  const file = newFile()
  const screen = new Screen(80, 30)
  const fake = quiet()
  const approvals = fakeApprovals()
  await withFake(file, screen, fake, Effect.gen(function*() {
    yield* sees(screen, "idle")
    // Each turn: its start is on the status row, then its end is drawn
    // (after the count of the approvals that wait).
    const turn = (id: number, status: "done" | "failed") =>
      Effect.gen(function*() {
        yield* fake.made.publish({ type: "start", n: id * 2 - 1, turn: id })
        yield* sees(screen, "turn " + id + " · works")
        yield* fake.made.publish({ type: "end", n: id * 2, turn: id, status, why: status === "failed" ? "it broke" : null })
        return yield* until(screen, "idle", (text) => text.endsWith(IDLE))
      })
    yield* turn(1, "done")
    approvals.rows.push(approval(1))
    yield* turn(2, "done")
    approvals.rows.push(approval(2))
    const text = yield* turn(3, "failed")
    // The first end, with none waiting, gave no line: one line for each of the two others.
    expect(text.split("approval waits:").length - 1).toBe(1)
    expect(text.split("approvals wait:").length - 1).toBe(1)
    expect(text).toContain("  1 approval waits: /approvals\n\n  2 approvals wait: /approvals")
  }), approvals)
})
