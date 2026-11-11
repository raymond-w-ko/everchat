// Pipe
// ====
// Pipe mode: EverChat with no terminal. The program works this way when
// its standard input or its standard output is not a terminal, for
// example in a script:
//
//   echo "which files are here?" | everchat
//   everchat < questions.txt > answers.txt
//
// It is the same chat, with the same memory, turn loop and sandbox. Only
// the interface is another one. So it is also the cheap way to test the
// whole program: a test needs no pseudo-terminal and no terminal emulator.
//
// The standard input
//
// - Each line is one message. An empty line is nothing.
// - The messages go one after the other: a line is sent when no turn
//   runs. So a line never steers the turn of the line before it, and a
//   run with the same input does the same thing each time.
// - A turn that runs at the launch (a cut turn that continues) ends first.
// - There are no slash commands and no keys: every line is a message.
// - When the input has ended and no turn runs, the program ends.
//
// The standard output
//
// Each message that enters the log from the launch on, when it is whole,
// as plain text (`written` in paint.ts): EverChat's words as the model
// wrote them, and the other kinds each with its mark, as on the terminal.
// One empty line is between two messages. No text is shortened, and
// nothing streams: a message is written when it is in the log.
//
// No control character of a text goes out (`clean` in paint.ts), because
// the standard output can be a terminal.
//
// How it ends
//
// - `end` gives false when a turn of this launch failed. The program then
//   exits with 1, so a script knows. The turn's note is in the output.
// - When the standard output cannot be written to (its reader went away,
//   as in `everchat | head -1`), the program ends with that reason. A
//   turn that runs then is cut, and it continues at the next launch.
//
// What it does not do: it writes no diagnostic to the standard error. As
// in the terminal, the diagnostics go to the table `log`.

import { Context, Effect, Fiber, Layer, PubSub, Schema, Stdio, Stream } from "effect"
import { follow, type Shown } from "./follow.ts"
import { written } from "./paint.ts"
import { type Message, Store, type StoreError } from "./store.ts"
import { type TurnEvent, Turns } from "./turn.ts"

// The standard input or the standard output failed.
export class PipeError extends Schema.TaggedError<PipeError>()("PipeError", {
  message: Schema.String
}) {}

export class Pipe extends Context.Service<Pipe, {
  // Waits until the standard input has ended and no turn runs. It gives
  // false when a turn of this launch failed.
  readonly end: Effect.Effect<boolean, StoreError | PipeError>
}>()("everchat/pipe/Pipe") {
  static readonly layer = Layer.effect(
    Pipe,
    Effect.gen(function*() {
      const store = yield* Store
      const turns = yield* Turns
      const stdio = yield* Stdio.Stdio
      // Before the log is read: from here on, no event is missed.
      const events = yield* turns.subscribe
      // The messages from the launch on: each once, in the order of the ids.
      const log = follow(store.messages, yield* store.count)

      let first = true
      let well = true

      const write = (shown: Shown) =>
        Effect.suspend(() => {
          const gap = first ? "" : "\n"
          first = false
          return Stream.run(Stream.succeed(gap + written(shown.kind, shown.text) + "\n"), stdio.stdout())
        }).pipe(Effect.mapError(() => new PipeError({ message: "the standard output cannot be written to: its reader went away" })))

      const take = Effect.fnUntraced(function*(message: Message) {
        for (const shown of yield* log.take(message)) {
          yield* write(shown)
        }
      })

      // One event, to its end: a stop of the writer must not lose the
      // message that it has in its hands.
      const handle = (event: TurnEvent) =>
        Effect.uninterruptible(Effect.gen(function*() {
          if (event.type === "accepted") {
            for (const message of event.messages) {
              yield* take(message)
            }
          } else if (event.type === "message") {
            yield* take(event.message)
          } else if (event.type === "end" && event.status === "failed") {
            well = false
          }
        }))

      // It ends only with a failure: the database, or the standard output.
      const writer = yield* Effect.forkScoped(Effect.forever(Effect.flatMap(PubSub.take(events), handle)))

      const lines = stdio.stdin.pipe(
        Stream.mapError(() => new PipeError({ message: "the standard input cannot be read" })),
        Stream.decodeText(),
        Stream.splitLines
      )
      const read = Stream.runForEach(lines, (line) => (line.trim() === "" ? Effect.void : Effect.andThen(turns.idle, turns.say(line))))

      const work = Effect.gen(function*() {
        yield* Effect.raceFirst(Effect.andThen(read, turns.idle), Fiber.join(writer))
        // No turn runs, so every event is in the subscription by now. The
        // writer stops after the event that it has, and the rest is written
        // here.
        yield* Fiber.interrupt(writer)
        while ((yield* PubSub.remaining(events)) > 0) {
          yield* handle(yield* PubSub.take(events))
        }
        return well
      })
      const reader = yield* Effect.forkScoped(work)

      return Pipe.of({ end: Fiber.join(reader) })
    })
  )
}
