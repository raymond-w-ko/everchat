// The terminal, whole: the turn loop with a fake wire, the real sandbox and
// functions, and a terminal in memory (screen.ts). What the person sees,
// what a key does, and what the database holds after.

import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import * as path from "node:path"
import { Ask, AskDelay } from "../src/ask.ts"
import { Cache } from "../src/cache.ts"
import * as Diagnostics from "../src/diagnostics.ts"
import { Functions } from "../src/functions.ts"
import { Limit } from "../src/limit.ts"
import { Memory } from "../src/memory.ts"
import { OpenAI } from "../src/openai.ts"
import { type Pace, QUIET } from "../src/pace.ts"
import type { Event, Reply, Request, WireError } from "../src/request.ts"
import { Sandbox } from "../src/sandbox.ts"
import { Shell } from "../src/shell.ts"
import { Store, type StoreError } from "../src/store.ts"
import { HELP, SHOWN, Terminal } from "../src/terminal.ts"
import { type TurnEvent, Turns } from "../src/turn.ts"
import { compactor, newFile, options, PICK as PICKED, reply, rows, wireError } from "./help.ts"
import { KEYS, Screen } from "./screen.ts"

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

// One launch of the whole program, with the screen `screen`.
const launch = <A, E>(
  file: string,
  wire: { layer: Layer.Layer<OpenAI> },
  screen: Screen,
  effect: Effect.Effect<A, E, Terminal | Turns | Store | Memory>,
  pace?: Pace
) => {
  const cwd = path.dirname(file)
  // The logger is under every layer, and merged: see diagnostics.ts.
  const store = Diagnostics.layer.pipe(Layer.provideMerge(Store.layer(file, options({ runTag: "tag-" + crypto.randomUUID() }))))
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const limits = Limit.layer({ dir: path.join(cwd, "results") }).pipe(Layer.provide(store))
  const shell = Shell.layer({ cwd, shell: "/bin/sh" }).pipe(Layer.provide(store))
  const functions = Functions.layer({ cwd }).pipe(Layer.provide(Layer.mergeAll(memory, shell, limits)))
  const sandbox = Sandbox.layer().pipe(Layer.provide(functions), Layer.provide(store))
  const asking = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire.layer)))
  const turns = Turns.layer().pipe(Layer.provideMerge(memory), Layer.provide(Layer.mergeAll(asking, sandbox, limits)))
  const terminal = Terminal.layer({ tty: screen, cwd, pace }).pipe(Layer.provideMerge(turns))
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

const messages = (file: string) => rows<{ kind: string; text: string }>(file, "select kind, text from msg_read order by i")


const turns = (file: string) => rows<{ id: number; status: string }>(file, "select id, status from turn order by id")

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
        idle: Effect.void,
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

const withFake = <A, E>(file: string, screen: Screen, fake: ReturnType<typeof fakeTurns>, effect: Effect.Effect<A, E, Terminal | Turns | Store>) => {
  const store = Diagnostics.layer.pipe(Layer.provideMerge(Store.layer(file, options())))
  return Effect.runPromise(effect.pipe(Effect.provide(Terminal.layer({ tty: screen }).pipe(Layer.provideMerge(fake.layer), Layer.provideMerge(store)))))
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
        yield* publish({ type: "accepted", messages: [early!] })
      }),
    // One just after the subscription: it is in the log that the terminal
    // reads, and its event comes too.
    (store, publish) =>
      Effect.gen(function*() {
        const [late] = yield* store.append([{ kind: "asst", text: "The second." }])
        yield* publish({ type: "message", message: late! })
      })
  )
  await withFake(file, screen, fake, Effect.gen(function*() {
    yield* sees(screen, "The second.", "idle")
    // One with no event at all, then one with an event.
    const more = yield* (yield* Store).append([{ kind: "note", text: "a quiet note" }, { kind: "asst", text: "The fourth." }])
    yield* fake.made.publish({ type: "message", message: more[1]! })
    yield* sees(screen, "The fourth.")
    // The event of the quiet one comes late.
    yield* fake.made.publish({ type: "message", message: more[0]! })
    yield* fake.made.publish({ type: "end", turn: 1, status: "done", why: null })
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
    yield* fake.made.publish({ type: "end", turn: 1, status: "done", why: null })
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
    for (let k = 0; k < 400 && rows<{ draft: string | null }>(file, "select draft from chat")[0]!.draft !== "half a thought"; k++) {
      yield* Effect.sleep("5 millis")
    }
    // One more key just before the end: the end writes the draft as it is then.
    first.type("!")
  }))
  expect(rows(file, "select draft from chat")).toEqual([{ draft: "half a thought!" }])
  expect(rows(file, "select count(*) as n from msg")).toEqual([{ n: SHOWN + 2 }])

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
  expect(rows(file, "select draft from chat")).toEqual([{ draft: null }])
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
  expect(rows(file, "select count(*) as n from msg where kind = (select id from kind where name = 'user')")).toEqual([{ n: 3 }])
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
