// The terminal, whole: the turn loop with a fake wire, the real sandbox and
// functions, and a terminal in memory (screen.ts). What the person sees,
// what a key does, and what the database holds after.

import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, PubSub, Queue, Stream } from "effect"
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
import { ANSWER_MAX, type Answered, type Approval, type ApprovalAnswer, Store, StoreError } from "@everchat/core/store"
import { Approvals } from "@everchat/core/approval"
import { BRIEF, COMMANDS, expires, HELP, NO_WAKE, NO_WAKEUPS, SHOWN, Terminal, usage, WAKEUPS_OFF, WAKEUPS_USAGE, WHO } from "../src/terminal.ts"
import { type Listing, type Row as WakeRow, type Stopped, type Switched, Wakeups } from "@everchat/wakeups/commands"
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

// Polls the screen on the real clock until its text passes `check`: a
// screen has no signal (lead, ec-h66pfl, T3).
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
  approvals: ReturnType<typeof fakeApprovals> = fakeApprovals(),
  wakeups: Layer.Layer<never> | Layer.Layer<Wakeups> = Layer.empty
) => {
  const store = Diagnostics.layer.pipe(Layer.provideMerge(storeLayer(file, options())))
  return Effect.runPromise(
    effect.pipe(Effect.provide(Terminal.layer({ tty: screen }).pipe(Layer.provideMerge(fake.layer), Layer.provide(approvals.layer), Layer.provide(wakeups), Layer.provideMerge(store))))
  )
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
  expect(COMMANDS.map((one) => one.name)).toEqual(["help", "stop", "diagnostics", "approvals", "approve", "deny", "wakeups", "quit"])
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
      "    2  acme.post  " + long.slice(0, 100) + "… (" + long.length + " characters: /approvals 2)  expires " + expires(approval(2)))
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

test("a long approval's row in /approvals: cut first at BRIEF, never inside a pair, then each hidden code point before the cut is its escape; no hidden code point and no half of a pair reaches the screen", async () => {
  const file = newFile()
  const screen = new Screen(400, 40)
  // Two hidden code points near the start, each 8 characters as an escape;
  // a pair (😀) at 85-86 of the arguments, which their escapes move to
  // 99-100 (an escape before the cut would split it); and a pair at 99-100
  // of the arguments, across BRIEF, which the cut leaves out whole.
  const input = "[\"" + "\u202e\u200b" + "a".repeat(81) + "😀" + "b".repeat(12) + "😀" + "c".repeat(50) + "\"]"
  expect(input.indexOf("😀")).toBe(85)
  expect(input.lastIndexOf("😀")).toBe(BRIEF - 1)
  expect(visible(input).indexOf("😀")).toBe(BRIEF - 1)
  const row = visible(input.slice(0, BRIEF - 1))
  expect(row).toBe("[\"\\u{202e}\\u{200b}" + "a".repeat(81) + "😀" + "b".repeat(12))
  const approvals = fakeApprovals([approval(3, { input })])
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/approvals")
    const text = yield* sees(screen, "Calls that wait for approval")
    expect(text).toContain("    3  acme.send  " + row + "… (" + input.length + " characters: /approvals 3)  expires ")
    expect([...text].filter((one) => HIDDEN_ONE.test(one) && one !== "\n").map((one) => one.codePointAt(0)!.toString(16))).toEqual([])
    expect(text).not.toContain("\ufffd")
    expect(text.split("😀").length - 1).toBe(1)
  }), approvals)
})

test("an answer's text of ANSWER_MAX characters is answered; one more is refused by the terminal with a line that names the limit, and the service is not asked", async () => {
  const file = newFile()
  const screen = new Screen(120, 60)
  const approvals = fakeApprovals([approval(2)], results)
  const most = "y".repeat(ANSWER_MAX)
  const over = "n".repeat(ANSWER_MAX + 1)
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/deny 2 " + over)
    // The refusal, or the line of an answer that the service gave.
    const refused = "The text of an answer is at most 4096 characters; this one has 4097. Nothing was answered."
    const text = yield* until(screen, "a line of the /deny", (now) => now.includes(refused) || now.includes("Approval 2: no."))
    expect(text).toContain(refused)
    expect(approvals.asked).toEqual([])
    send(screen, "/approve 2 " + most)
    yield* sees(screen, "Approval 2: yes. The call runs now; its result starts a turn.")
  }), approvals)
  expect(ANSWER_MAX).toBe(4096)
  expect(approvals.asked).toEqual([{ n: 2, answer: { yes: true, who: WHO, text: most } }])
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

// A comparison (`everturn help comparison`; the sweep's case, ec-jdqf6, 6):
// the terminal's test of an answer's length (terminal.ts, after its trim)
// against the store's (`answerApproval`): both refuse a text whose
// well-formed form has more than ANSWER_MAX UTF-16 units. The texts are
// built of tokens that stress that count: characters of 1, 2 and 3 bytes,
// pairs of surrogates (an emoji, a variation selector of plane 14), a lone
// high and a lone low surrogate (two of them side by side make a pair), and
// characters that draw as nothing; each is cut at a length from ANSWER_MAX
// - 2 to ANSWER_MAX + 2 units, or at ANSWER_MAX + 2 code points, so that a
// count of code points on one side fails. Seeds 0x1776 and 0xc0ffee, 20
// texts each; about 3 s. A failure names the seed, the text's number and
// its counts.
const ANSWER_TOKENS = ["a", "é", "日本語", "😀", "\u{e0100}", "\ud800", "\udc00", "\ud83d", "​", "‮", "x́"]

test("comparison: the terminal refuses an answer's text exactly when the store does, on seeded texts at and beside ANSWER_MAX, with pairs and lone surrogates", async () => {
  const file = newFile()
  const screen = new Screen(120, 40)
  const approvals = fakeApprovals()
  const count = (text: string, part: string) => text.split(part).length - 1
  const REFUSED = "Nothing was answered."
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    const store = yield* Store
    for (const seed of [0x1776, 0xc0ffee]) {
      let state = seed
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state
      }
      for (let k = 0; k < 20; k++) {
        let text = ""
        const byPoints = k % 5 === 4
        const target = byPoints ? ANSWER_MAX + 2 : ANSWER_MAX - 2 + k % 5
        while ((byPoints ? [...text].length : text.length) < target) text += ANSWER_TOKENS[random() % ANSWER_TOKENS.length]
        text = byPoints ? [...text].slice(0, target).join("") : text.slice(0, target)
        const named = `seed 0x${seed.toString(16)} text ${k}: ${text.length} units, ${text.toWellFormed().length} well-formed, ${[...text].length} code points`
        const asked = approvals.asked.length
        const refused = count(yield* Effect.promise(() => screen.text()), REFUSED)
        send(screen, "/approve 2 " + text)
        yield* until(screen, "the answer of " + named, (shown) => approvals.asked.length > asked || count(shown, REFUSED) > refused)
        const terminal = approvals.asked.length > asked ? "asked" : "refused"
        if (terminal === "asked") expect(approvals.asked[asked]!.answer.text === text ? "the same text" : "another text").toBe("the same text")
        const stored = yield* Effect.result(store.answerApproval(2, { yes: true, who: WHO, text }))
        // The store's refusal is a StoreError whose cause says why.
        const why = stored._tag === "Success" ? "" : String(stored.failure.cause)
        const kept = stored._tag === "Success" ? "asked" : why.includes("an answer's text has at most") ? "refused" : why
        expect({ named, terminal }).toEqual({ named, terminal: kept })
      }
    }
  }), approvals)
})

// Wake-ups
// --------

// A fake wake-ups' service: `listing` is what `list` gives; `asked` keeps
// each call; `stop` gives the answer for each id (by default: stopped, and
// a fault for 13); `offs` and `ons` give the answers of `off` and `on`, in
// order (then: switched). Each member, as it is called, records the call
// in `asked`, then offers it to `calls` (lead, ec-h66pfl, T1): a case
// waits for a call by taking from `calls`, and a call that never comes is
// the test's timeout (T2).
const fakeWakeups = (listing: Listing, answers: { stop?: (id: number) => Stopped; offs?: Array<Switched>; ons?: Array<Switched> } = {}) => {
  const asked: Array<string> = []
  const calls = Effect.runSync(Queue.unbounded<string>())
  const record = (call: string) => Effect.andThen(Effect.sync(() => asked.push(call)), Queue.offer(calls, call))
  const layer = Layer.succeed(
    Wakeups,
    Wakeups.of({
      list: Effect.as(record("list"), listing),
      stop: (id) =>
        id === 13
          ? Effect.andThen(record(`stop ${id}`), Effect.fail(new StoreError({ op: "stopWake", cause: new Error("a fault") })))
          : Effect.andThen(record(`stop ${id}`), Effect.sync(() => answers.stop?.(id) ?? "stopped")),
      off: Effect.andThen(record("off"), Effect.sync(() => answers.offs?.shift() ?? "switched")),
      on: Effect.andThen(record("on"), Effect.sync(() => answers.ons?.shift() ?? "switched"))
    })
  )
  return { asked, calls, layer }
}

// The rows that the terminal told, without their indent.
const toldRows = (rows: ReadonlyArray<string>) => rows.filter((row) => row.startsWith("  ")).map((row) => row.slice(2))

const ROWS: Array<WakeRow> = [
  { id: 3, text: "Read my mail.", when: "0 9 * * *", zone: "Europe/Berlin", next: "2026-11-17 09:00 Europe/Berlin", last: "2026-11-16 09:00 Europe/Berlin", missed: 2, active: true, why: null },
  { id: 5, text: "Call the bank.", when: "2026-11-18T09:00", zone: "Europe/Berlin", next: "2026-11-18 09:00 Europe/Berlin", last: null, missed: 0, active: true, why: null },
  { id: 7, text: "Every hour.", when: "0 * * * *", zone: "UTC", next: "2026-11-17 10:00 UTC", last: "2026-11-16 10:00 UTC", missed: 1000, active: true, why: null },
  { id: 1, text: "Old.", when: "0 8 * * *", zone: "UTC", next: null, last: "2026-11-15 08:00 UTC", missed: 0, active: false, why: "person" },
  { id: 2, text: "Older.", when: "0 7 * * *", zone: "UTC", next: null, last: null, missed: 0, active: false, why: "failed" }
]

test("/help and the autocomplete have /wakeups with its four forms", async () => {
  const one = COMMANDS.find((command) => command.name === "wakeups")
  expect(one?.description).toBe("lists the wake-ups; /wakeups stop 3, /wakeups off, /wakeups on")
  expect(HELP).toContain("  /wakeups      lists the wake-ups; /wakeups stop 3, /wakeups off, /wakeups on")
  const file = newFile()
  const screen = new Screen(100, 30)
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    screen.type("/wak")
    yield* sees(screen, "wakeups", "lists the wake-ups")
  }))
})

test("/wakeups with no service: each of the four forms says the config file's line, and nothing else", async () => {
  const file = newFile()
  const screen = new Screen(120, 30)
  const count = (text: string, part: string) => text.split(part).length - 1
  // The terminal's build does not need the service: with none, it runs.
  const ran = await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    for (const sent of ["/wakeups", "/wakeups stop 3", "/wakeups off", "/wakeups on"]) {
      send(screen, sent)
    }
    yield* until(screen, "four lines", (text) => count(text, NO_WAKEUPS) === 4)
    return toldRows(yield* Effect.promise(() => screen.all()))
  })).then((told) => ({ told }), (error: unknown) => ({ failed: String(error) }))
  expect(ran).toEqual({ told: [NO_WAKEUPS, NO_WAKEUPS, NO_WAKEUPS, NO_WAKEUPS] })
  expect(NO_WAKEUPS).toBe("The config file turns the wake-ups off: this launch has none to list or stop.")
  expect(messages(file)).toEqual([])
})

test("/wakeups lists the rows: none; then each field of each row (a waiting fire, a missed count, at the bound, a stopped row with its why); with the first line when off", async () => {
  const file = newFile()
  const screen = new Screen(200, 30)
  const listing: { on: boolean; rows: Array<WakeRow> } = { on: true, rows: [] }
  const fake = fakeWakeups(listing)
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/wakeups")
    yield* sees(screen, NO_WAKE)
    expect(toldRows(yield* Effect.promise(() => screen.all()))).toEqual(["This chat has no wake-up."])
    listing.rows = ROWS
    send(screen, "/wakeups")
    yield* sees(screen, "Older.")
    listing.on = false
    send(screen, "/wakeups")
    yield* sees(screen, WAKEUPS_OFF)
    const lines = [
      "3  Read my mail.  0 9 * * *  Europe/Berlin  next 2026-11-17 09:00 Europe/Berlin  last 2026-11-16 09:00 Europe/Berlin  2 missed  active",
      "5  Call the bank.  2026-11-18T09:00  Europe/Berlin  next 2026-11-18 09:00 Europe/Berlin  last none  active",
      "7  Every hour.  0 * * * *  UTC  next 2026-11-17 10:00 UTC  last 2026-11-16 10:00 UTC  1000 or more missed  active",
      "1  Old.  0 8 * * *  UTC  next none  last 2026-11-15 08:00 UTC  stopped (person)",
      "2  Older.  0 7 * * *  UTC  next none  last none  stopped (failed)"
    ]
    expect(toldRows(yield* Effect.promise(() => screen.all()))).toEqual(["This chat has no wake-up.", ...lines, "The wake-ups of this chat are off: none fires until /wakeups on.", ...lines])
  }), fakeApprovals(), fake.layer)
  expect(fake.asked).toEqual(["list", "list", "list"])
})

test("/wakeups shows a row on one line: a text with a line end and a hidden code point, cut as an approval's arguments are; a zone with a line end", async () => {
  const file = newFile()
  const screen = new Screen(250, 30)
  const text = "a\nb\u202e" + "x".repeat(200)
  const fake = fakeWakeups({ on: true, rows: [{ id: 9, text, when: "0 9 * * *", zone: "Europe/Berlin\nX", next: null, last: null, missed: 0, active: true, why: null }] })
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    send(screen, "/wakeups")
    yield* sees(screen, "  active")
    expect(toldRows(yield* Effect.promise(() => screen.all()))).toEqual([
      "9  a\\x0ab\\u{202e}" + "x".repeat(96) + "…  0 9 * * *  Europe/Berlin\\x0aX  next none  last none  active"
    ])
  }), fakeApprovals(), fake.layer)
})

test("/wakeups stop 3, off and on: the member called one time with its argument; a stop or a switch shows no line (its note is the answer); each answer of already so has its line; a fault is the command's line", async () => {
  const file = newFile()
  const screen = new Screen(120, 30)
  const fake = fakeWakeups({ on: true, rows: [] }, { stop: (id) => (id === 9 ? "none" : id === 4 ? "inactive" : "stopped"), offs: ["switched", "already"], ons: ["switched", "already"] })
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    const sent = ["/wakeups stop 3", "/wakeups stop 9", "/wakeups   stop   4", "/wakeups off", "/wakeups off", "/wakeups on", "/wakeups on", "/wakeups stop 13"]
    const taken: Array<string> = []
    for (const one of sent) {
      send(screen, one)
      // One at a time: each command runs in its own fiber; the next is
      // sent when the fake was called for this one.
      taken.push(yield* Queue.take(fake.calls))
    }
    expect(taken).toEqual(["stop 3", "stop 9", "stop 4", "off", "off", "on", "on", "stop 13"])
    yield* sees(screen, "The slash command failed")
    expect(toldRows(yield* Effect.promise(() => screen.all()))).toEqual([
      "No wake-up 9.",
      "Wake-up 4 is not active.",
      "The wake-ups are off already.",
      "The wake-ups are on already.",
      "The slash command failed: the database refused it (stopWake). /diagnostics shows more."
    ])
  }), fakeApprovals(), fake.layer)
  expect(fake.asked).toEqual(["stop 3", "stop 9", "stop 4", "off", "off", "on", "on", "stop 13"])
})

test("/wakeups stop, stop x, stop 0, stop 1.5, stop 3 4 and /wakeups later give the line of the four forms, and the service is not called", async () => {
  const file = newFile()
  const screen = new Screen(120, 30)
  const fake = fakeWakeups({ on: true, rows: [] })
  const count = (text: string, part: string) => text.split(part).length - 1
  await withFake(file, screen, quiet(), Effect.gen(function*() {
    yield* sees(screen, "idle")
    for (const sent of ["/wakeups stop", "/wakeups stop x", "/wakeups stop 0", "/wakeups stop 1.5", "/wakeups stop 3 4", "/wakeups later"]) {
      send(screen, sent)
    }
    yield* until(screen, "six lines", (text) => count(text, WAKEUPS_USAGE) === 6)
    expect(toldRows(yield* Effect.promise(() => screen.all()))).toEqual(Array.from({ length: 6 }, () => WAKEUPS_USAGE))
  }), fakeApprovals(), fake.layer)
  expect(WAKEUPS_USAGE).toBe("Give one of: /wakeups, /wakeups stop 3, /wakeups off, /wakeups on.")
  expect(fake.asked).toEqual([])
})
