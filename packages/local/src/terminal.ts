// Terminal
// ========
// The person's interface: the chat on the screen, and the keys. It is the
// one interface of EverChat for now, and the one that the factory uses.
//
// The screen and the keys are the library `pi-tui`'s work: the input with
// its editing keys, the markdown, and a renderer that writes only the rows
// that changed. This module says what is on the screen and what a key does.
//
// The screen, from top to bottom
//
// - The messages: the last ones of the log at the launch, then each one as
//   it enters the log. They go into the terminal's own scrollback, so the
//   terminal's scroll, select and copy work on them.
// - What the model gives right now, and is not in the log yet: its
//   thought and its text. They are paced (pace.ts): a whole paragraph at a
//   time, and not each word. A program is shown whole when it starts to
//   run. While the model writes it, only the status row says so.
// - The input: the box that the person types in.
// - The status row: what EverChat does, then the pick. What it does is
//   first, because a narrow terminal shows only the row's start.
//
// Where the screen's content comes from
//
// The log is the truth. The turn loop's events (turn.ts) say when a
// message entered the log, and carry what streams. The terminal subscribes
// before it reads the log, and then shows the messages in the order of
// their ids, each once (follow.ts). So no message is shown twice or left
// out, whenever the turn loop started.
//
// The keys
//
//   Enter            sends the input: a message, or a slash command
//   Shift+Enter      a new row in the input (also Ctrl+J)
//   Esc              stops the turn that runs
//   Ctrl+C           empties the input; twice with an empty input: quits
//   Ctrl+D           quits, when the input is empty
//
// A message that is sent while a turn runs steers that turn (turn.ts).
//
// A quit while a turn runs does not stop that turn: it is cut, and it goes
// on at the next launch. `/stop` or Esc ends it first.
//
// The draft is in the database (`chat.draft`): the input's text is written
// there shortly after it changes, and the next launch puts it back.
//
// What the terminal itself tells the person (the answer to a slash
// command, a message that was not accepted) is on the screen only. It is
// not a message, and the model never reads it.
//
// Approvals: a call of a function that needs a person's yes waits as an
// approval (packages/core/src/approval.ts). `/approvals` lists those that
// wait, `/approvals <n>` shows one whole, and `/approve <n> [text]` and
// `/deny <n> [text]` answer it, as `the person in the terminal` (`WHO`),
// through the service `Approvals` only. They work while a turn runs too: a
// command runs in its own fiber. At each turn's end, when calls wait, one
// line says how many. Every text of an approval that the terminal shows
// was written by a model or a server: each code point in it that could
// move the cursor, change the screen or hide a part is shown as an escape
// by the core's `visible` (packages/core/src/functions.ts), whose rule and
// set the terminal takes as they are: Cc, Cf, Cs, Co, Cn, Zl, Zp and
// Default_Ignorable_Code_Point. So the person sees exactly what they answer.
//
// The layer must have the diagnostics' layer under it, merged
// (diagnostics.ts): its fibers start when the layer is built.
//
// A limit: what a launch has shown stays in the program's memory until
// the launch ends, so that a change of the terminal's size can draw it
// again.
//
// With no terminal, the program works in pipe mode (pipe.ts).
//
// Not here yet: images, the agents, and a list of the functions that a
// program runs.

import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  type EditorTheme,
  isKeyRelease,
  type Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  type Terminal as Tty,
  TuiMainScreen
} from "@earendil-works/pi-tui"
import { Clock, Context, DateTime, Deferred, Effect, FiberSet, Layer, Stream } from "effect"
import { follow, type Shown } from "@everchat/core/follow"
import { type Pace, paced } from "@everchat/core/pace"
import { bold, clean, dim, LOOKS, markdown, message as paint, plain, Row, THOUGHT, TOLD, Wrapped } from "./paint.ts"
import { Approvals } from "@everchat/core/approval"
import { visible } from "@everchat/core/functions"
import { ANSWER_MAX, type Answered, type Approval, type Diagnostic, type Message, Store, type StoreError, WAIT } from "@everchat/core/store"
import { type TurnEvent, Turns } from "@everchat/core/turn"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "terminal")

// The most messages of the log that a launch shows.
export const SHOWN = 40

// How long after a change the draft is written, in milliseconds.
export const DRAFT = 300

// How long the second Ctrl+C may take, in milliseconds.
export const AGAIN = 2000

// What the status row says when no turn runs. The factory can read it as
// "ready for a message".
export const IDLE = "idle"

// The slash commands: what the person sends to tell the program what to
// do. They are not messages.
export const COMMANDS: ReadonlyArray<{ readonly name: string; readonly description: string }> = [
  { name: "help", description: "the slash commands and the keys" },
  { name: "stop", description: "stops the turn that runs" },
  { name: "diagnostics", description: "the last diagnostics (/diagnostics 50 for more)" },
  { name: "approvals", description: "the calls that wait for a yes or no (/approvals 2: one whole)" },
  { name: "approve", description: "yes to an approval: /approve 2 [text]; the call runs" },
  { name: "deny", description: "no to an approval: /deny 2 [text]; the call does not run" },
  { name: "quit", description: "ends EverChat; a turn that runs goes on at the next launch" }
]

export const HELP = [
  "Slash commands:",
  ...COMMANDS.map((one) => "  /" + one.name.padEnd(13) + one.description),
  "Keys:",
  "  Enter          sends the input",
  "  Shift+Enter    a new row in the input (also Ctrl+J)",
  "  Esc            stops the turn that runs",
  "  Ctrl+C         empties the input; twice: quits",
  "  Ctrl+D         quits, when the input is empty"
].join("\n")

// What the person sends is a slash command when its first word is a slash
// and letters only. So `/tmp/x is full` is a message.
const COMMAND = /^\/([a-z]+)(?:\s+(.*))?$/s

const EDITOR: EditorTheme = {
  borderColor: dim,
  selectList: { selectedPrefix: plain, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim }
}

// Who answers an approval in the terminal.
export const WHO = "the person in the terminal"

// The most characters of an approval's arguments in the list of
// `/approvals`; `/approvals <n>` shows them all.
export const BRIEF = 100

// The arguments of approval `n` on one line, cut to BRIEF characters
// (never inside a pair of surrogates), then made visible; a cut one names
// the command that shows them whole.
const brief = (n: number, input: string): string => {
  if (input.length <= BRIEF) return visible(input)
  const code = input.charCodeAt(BRIEF - 1)
  return visible(input.slice(0, code >= 0xd800 && code <= 0xdbff ? BRIEF - 1 : BRIEF)) + "… (" + input.length + " characters: /approvals " + n + ")"
}

const when = (millis: number): string => DateTime.formatLocal(DateTime.makeUnsafe(millis), { locale: "sv-SE", dateStyle: "short", timeStyle: "short" })

// When an approval expires.
export const expires = (approval: Approval): string => when(approval.created + WAIT)

// The usage of `/approve` and `/deny`.
export const usage = (name: "approve" | "deny") => "Give the number of an approval: /" + name + " 2 [text]. /approvals lists them."

// The line of an answer, by what became of it.
export const answered = (n: number, got: Answered): string => {
  switch (got._tag) {
    case "answered":
      return got.approval.status === "yes"
        ? "Approval " + n + ": yes. The call runs now; its result starts a turn."
        : "Approval " + n + ": no. The call does not run; the chat is told."
    case "none":
      return "No approval " + n + "."
    case "expired":
      return "Approval " + n + " expired: it waited more than 7 days, and the call does not run."
    case "closed": {
      const row = got.approval
      if (row.status === "expired") return "Approval " + n + " expired already, with no answer."
      const said = row.answer === null || row.answer === "" ? "" : " (\"" + visible(row.answer) + "\")"
      return "Approval " + n + " was answered already: " + (row.status === "no" ? "no" : "yes") + ", by " + visible(row.who ?? "someone") + said + "."
    }
  }
}

// How many calls wait, for the line at a turn's end.
export const waitLine = (k: number): string => (k === 1 ? "1 approval waits: /approvals" : k + " approvals wait: /approvals")

const stamp = (row: Diagnostic): string =>
  DateTime.formatLocal(DateTime.makeUnsafe(row.created), { locale: "sv-SE", dateStyle: "short", timeStyle: "medium" }) + " " + row.level + " " + row.source + ": " + row.text

export interface Options {
  // The terminal to draw on. With none, the process's own.
  readonly tty?: Tty | undefined
  // Where the input completes file names from.
  readonly cwd?: string | undefined
  // The times of the pace. With none, those of pace.ts.
  readonly pace?: Pace | undefined
}

export class Terminal extends Context.Service<Terminal, {
  // Waits until the person quits.
  readonly quit: Effect.Effect<void>
}>()("everchat/terminal/Terminal") {
  static readonly layer = (options: Options = {}) =>
    Layer.effect(
      Terminal,
      Effect.gen(function*() {
        const store = yield* Store
        const turns = yield* Turns
        const approvals = yield* Approvals
        // What a key starts runs in this layer's scope, with its context.
        const fork = yield* FiberSet.makeRuntime<never, void, never>()
        const done = yield* Deferred.make<void>()
        // Before the log is read: from here on, no event is missed.
        const events = yield* turns.subscribe

        const tui = new TuiMainScreen(options.tty ?? new ProcessTerminal())
        const shown = new Container()
        const live = new Container()
        const editor = new Editor(tui, EDITOR)
        const status = new Row()
        editor.setAutocompleteProvider(
          new CombinedAutocompleteProvider(COMMANDS.map((one) => ({ name: one.name, description: one.description })), options.cwd ?? process.cwd())
        )
        tui.addChild(shown)
        tui.addChild(live)
        tui.addChild(new Spacer(1))
        tui.addChild(editor)
        tui.addChild(status)
        tui.setFocus(editor)

        const chat = yield* store.chat
        const pick = store.launch.pick ?? chat.pick

        // The state of the screen.
        let now = yield* Clock.currentTimeMillis
        let working: { turn: number; since: number } | null = null
        const programs = new Set<number>() // the calls of the programs that run, and that are on the screen
        let thought: { text: string; drawn: Wrapped } | null = null
        let text: { text: string; drawn: Markdown } | null = null
        let writing = false // the model writes a program
        let hint: string | null = null
        let armed = false // Ctrl+C was pressed once with an empty input

        const add = (component: Component, gap = true) => {
          if (gap) {
            shown.addChild(new Spacer(1))
          }
          shown.addChild(component)
        }

        // What the terminal itself tells the person.
        const tell = (said: string) => {
          add(new Wrapped(said, TOLD))
          tui.requestRender()
        }

        const relive = () => {
          live.clear()
          for (const one of [thought, text]) {
            if (one !== null) {
              live.addChild(new Spacer(1))
              live.addChild(one.drawn)
            }
          }
        }

        const state = (): string => {
          if (hint !== null) {
            return hint
          }
          if (working === null) {
            return IDLE
          }
          const seconds = Math.max(0, Math.round((now - working.since) / 1000))
          const does = programs.size > 0 ? "runs a program" : writing ? "writes a program" : "works"
          return "turn " + working.turn + " · " + does + " · " + seconds + " s · Esc stops"
        }

        const draw = () => {
          status.setText(dim(state() + " · " + pick.model + " " + pick.effort))
          tui.requestRender()
        }

        // One message of the log goes on the screen.
        const show = (message: Shown) => {
          const whole = message.text
          if (message.kind === "user") {
            editor.addToHistory(whole)
          }
          if (message.kind === "asst") {
            // The text that streamed is this message: it stays where it is.
            thought = null
            if (text !== null) {
              text.drawn.setText(clean(whole))
              add(text.drawn)
              text = null
              relive()
              return
            }
            relive()
          }
          if (message.kind === "tool" && message.call !== null && programs.delete(message.call)) {
            // The program is on the screen since it started.
            return
          }
          add(paint(message.kind, whole), message.kind !== "echo")
        }

        // The last messages of the log. The first one shown is the first
        // page of its text.
        const count = yield* store.count
        const tail = yield* store.messages(Math.max(0, count - SHOWN - 1), count)
        let first = tail[0]?.i === 0 ? 0 : 1
        while (first < tail.length && tail[first - 1]?.more === true) {
          first++
        }
        const before = tail[first]?.i ?? count
        if (before > 0) {
          add(new Wrapped(before + " earlier messages are in the memory.", TOLD))
        }
        // From here on: each message once, in the order of the ids.
        const log = follow(store.messages, before)
        for (const message of log.join(tail.slice(first))) {
          show(message)
        }

        // Shows a message that an event brought, and first the messages
        // before it that are not shown.
        const take = Effect.fnUntraced(function*(message: Message) {
          for (const one of yield* log.take(message)) {
            show(one)
          }
        })

        const handle = Effect.fnUntraced(function*(event: TurnEvent) {
          now = yield* Clock.currentTimeMillis
          switch (event.type) {
            case "accepted": {
              for (const message of event.messages) {
                yield* take(message)
              }
              break
            }
            case "message": {
              yield* take(event.message)
              break
            }
            case "start": {
              working = { turn: event.turn, since: now }
              break
            }
            case "thought": {
              thought = { text: (thought?.text ?? "") + event.delta, drawn: thought?.drawn ?? new Wrapped("", THOUGHT) }
              thought.drawn.setText(thought.text)
              relive()
              break
            }
            case "text": {
              thought = null
              text = { text: (text?.text ?? "") + event.delta, drawn: text?.drawn ?? markdown("") }
              text.drawn.setText(clean(text.text))
              relive()
              break
            }
            case "program": {
              thought = null
              writing = true
              relive()
              break
            }
            case "call": {
              // The program is whole now, and it runs. A text that is still
              // here is not in the log: it was blank.
              thought = null
              text = null
              writing = false
              relive()
              programs.add(event.call)
              add(new Wrapped(event.program, LOOKS.tool))
              break
            }
            case "end": {
              thought = null
              text = null
              writing = false
              relive()
              programs.clear()
              working = null
              const k = (yield* approvals.waiting).length
              if (k > 0) {
                tell(waitLine(k))
              }
              break
            }
          }
          draw()
        })

        // The slash commands.
        const finish = Effect.asVoid(Deferred.succeed(done, undefined))
        const command = Effect.fnUntraced(function*(name: string, argument: string) {
          switch (name) {
            case "help": {
              return tell(HELP)
            }
            case "quit": {
              return yield* finish
            }
            case "stop": {
              if (working === null) {
                return tell("No turn runs.")
              }
              return yield* turns.stop()
            }
            case "diagnostics": {
              const count = argument === "" ? 20 : Number(argument)
              if (!Number.isInteger(count) || count < 1) {
                return tell("Give a number of diagnostics: /diagnostics 50")
              }
              const rows = yield* store.lastDiagnostics(count)
              return tell(rows.length === 0 ? "No diagnostics." : rows.map(stamp).join("\n"))
            }
            case "approvals": {
              const rows = yield* approvals.waiting
              if (argument === "") {
                return tell(
                  rows.length === 0
                    ? "No call waits for approval."
                    : ["Calls that wait for approval (/approve n, /deny n):", ...rows.map((one) =>
                      "  " + one.id + "  " + visible(one.fn) + "  " + brief(one.id, one.input) + "  expires " + expires(one)
                    )].join("\n")
                )
              }
              const n = numberOf(argument)
              const one = rows.find((row) => row.id === n)
              if (one === undefined) {
                return tell(n === null ? "Give the number of an approval: /approvals 2" : "No approval " + n + " waits.")
              }
              return tell(
                "Approval " + one.id + ": " + visible(one.fn) + ", in turn " + one.turn + ", expires " + expires(one) + ".\n" +
                  "Its arguments, whole (" + one.input.length + " characters):\n" + visible(one.input)
              )
            }
            case "approve":
            case "deny": {
              const found = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument)
              const n = found === null ? null : numberOf(found[1]!)
              if (n === null) {
                return tell(usage(name))
              }
              const said = (found?.[2] ?? "").trim()
              // The store's rule (`answerApproval`): at most ANSWER_MAX
              // UTF-16 units once well-formed. Tested here, so a text over
              // it asks nothing.
              if (said.toWellFormed().length > ANSWER_MAX) {
                return tell("The text of an answer is at most " + ANSWER_MAX + " characters; this one has " + said.length + ". Nothing was answered.")
              }
              const got = yield* approvals.answer(n, { yes: name === "approve", who: WHO, text: said === "" ? null : said })
              return tell(answered(n, got))
            }
            default: {
              return tell("No slash command /" + name + ". /help lists them.")
            }
          }
        })

        // The number of an approval: a whole number of 1 or more, in digits.
        const numberOf = (given: string): number | null => {
          if (!/^[0-9]+$/.test(given)) return null
          const n = Number(given)
          return Number.isSafeInteger(n) && n >= 1 ? n : null
        }

        const refused = (what: string) => (error: StoreError) =>
          Effect.andThen(
            diagnostic(Effect.logError(what, error)),
            Effect.sync(() => tell(what + ": the database refused it (" + error.op + "). /diagnostics shows more."))
          )

        const send = (said: string) =>
          turns.say(said).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.andThen(
                refused("The message was not accepted")(error),
                Effect.sync(() => {
                  if (editor.getText() === "") {
                    editor.setText(said)
                  }
                })
              )
            )
          )

        editor.onSubmit = (said) => {
          const found = COMMAND.exec(said.trim())
          if (said.trim() === "") {
            return
          }
          if (found === null) {
            fork(send(said))
            return
          }
          editor.addToHistory(said)
          fork(command(found[1] ?? "", (found[2] ?? "").trim()).pipe(Effect.catch(refused("The slash command failed"))))
        }

        // The draft: written once, shortly after the last change.
        let unsaved = false
        const save = Effect.suspend(() => {
          unsaved = false
          const draft = editor.getText()
          return store.setDraft(draft === "" ? null : draft)
        }).pipe(Effect.catch((error) => diagnostic(Effect.logWarning("the draft was not written", error))))
        editor.onChange = () => {
          if (!unsaved) {
            unsaved = true
            fork(Effect.andThen(Effect.sleep(DRAFT), save))
          }
        }

        tui.addInputListener((data) => {
          if (isKeyRelease(data)) {
            return undefined
          }
          if (matchesKey(data, "ctrl+c")) {
            if (editor.getText() !== "") {
              editor.setText("")
            } else if (armed) {
              fork(finish)
            } else {
              armed = true
              hint = "Press Ctrl+C again to quit"
              fork(Effect.andThen(
                Effect.sleep(AGAIN),
                Effect.sync(() => {
                  armed = false
                  hint = null
                  draw()
                })
              ))
            }
            draw()
            return { consume: true }
          }
          if (matchesKey(data, "ctrl+d") && editor.getText() === "") {
            fork(finish)
            return { consume: true }
          }
          if (matchesKey(data, "escape") && working !== null && !editor.isShowingAutocomplete()) {
            fork(turns.stop())
            return { consume: true }
          }
          return undefined
        })

        const [cut] = yield* store.runningTurns(null)
        if (cut !== undefined) {
          working = { turn: cut.id, since: now }
        }
        if (chat.draft !== null) {
          editor.setText(chat.draft)
        }
        draw()

        yield* Effect.acquireRelease(Effect.sync(() => tui.start()), () => Effect.sync(() => tui.stop()))
        // At the end, before the screen stops: the draft as it is then.
        yield* Effect.addFinalizer(() => save)
        yield* Effect.forkScoped(Stream.runForEach(paced(events, options.pace), (event) =>
          handle(event).pipe(
            Effect.catch((error) => diagnostic(Effect.logError("the terminal did not show an event (" + event.type + ")", error)))
          )))
        // The seconds of the status row.
        yield* Effect.forkScoped(Effect.forever(Effect.andThen(
          Effect.sleep(1000),
          Effect.gen(function*() {
            now = yield* Clock.currentTimeMillis
            if (working !== null) {
              draw()
            }
          })
        )))

        return Terminal.of({ quit: Deferred.await(done) })
      })
    )
}
