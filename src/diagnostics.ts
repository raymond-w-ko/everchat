// Diagnostics
// ===========
// A diagnostic is a line that EverChat writes about its own work: a
// request that is sent again, a compaction that failed, a prompt cache
// that was not read. It is for the person who looks for a fault. It is not
// a message, and the model never reads it.
//
// EverChat runs as one process in a terminal. A line on stderr would break
// the screen. So the diagnostics go to the database, in the table `log`
// (docs/schema.html, `log`), and nothing goes to stderr or stdout.
//
// This module is Effect's logger for that table. The rest of the program
// logs as any Effect program does (`Effect.logWarning`, `Effect.logError`),
// and does not know where the lines go.
//
// How a line is written
//
// - Its level is Effect's: Fatal and Error are `error`, Warn is `warn`,
//   Info is `info`, Debug and Trace are `debug`. Effect drops the lines
//   below its minimum level, which is Info unless the program sets another
//   (`References.MinimumLogLevel`).
// - Its source is the module that wrote it. A module says so with a log
//   annotation: `Effect.annotateLogs("source", "memory")`. A line with no
//   such annotation has the source in NONE.
// - Its text is the message, then the other annotations as `key=value`,
//   then the cause, if there is one.
// - Its time is when it happened, not when it was written.
//
// The lines are written in batches: every WINDOW, the lines that came since
// then go to the database in one transaction. The batch is also written
// when the layer closes. So a clean end loses nothing, and a kill of the
// process loses at most the lines of one window.
//
// A batch that the database refuses is dropped, and counted. The next
// batch that is written starts with one line that says how many were lost.
// A failed write is never logged through this logger: that would not end.
//
// When the layer is built, it deletes the diagnostics that are older than
// KEEP.
//
// Where to provide the layer
//
// A fiber logs with the loggers that are in its context. Two kinds of
// fiber must have this one:
//
// - The fibers that use the services. A fiber that a service forks in one
//   of its methods (the memory's compactions) gets the context of the
//   caller, not of the service's layer.
// - The fibers that a layer forks when it is built (the turn loop
//   continues a cut turn then). They get the context of the layer's build.
//
// So put this layer under every layer that logs, and merge it, so that
// the effect that uses them has it too:
//
//   const base = Diagnostics.layer.pipe(Layer.provideMerge(store))
//   const memory = Memory.layer.pipe(Layer.provideMerge(base), ...)
//
// Without it, a line goes to Effect's default logger, which writes to the
// console.

import { Cause, Clock, Effect, Layer, Logger, Predicate } from "effect"
import { CurrentLogAnnotations } from "effect/References"
import { type Level, type NewDiagnostic, Store, type StoreError } from "./store.ts"

// How often the lines are written, in milliseconds.
export const WINDOW = 100

// How long a diagnostic is kept: 30 days, in milliseconds.
export const KEEP = 30 * 24 * 60 * 60 * 1000

// The log annotation that names a line's source.
export const SOURCE = "source"

// The source of a line that names none.
export const NONE = "everchat"

// The source of this module's own lines.
const OWN = "diagnostics"

const LEVELS: Record<string, Level> = { Fatal: "error", Error: "error", Warn: "warn", Info: "info", Debug: "debug", Trace: "debug" }

// One part of a message, or the value of an annotation, as text.
const say = (value: unknown): string => {
  if (Predicate.isString(value)) {
    return value
  }
  if (Predicate.isError(value)) {
    return value.name === "Error" || value.message.startsWith(value.name) ? value.message : value.name + ": " + value.message
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// One log entry of Effect as a row.
export const row: Logger.Logger<unknown, NewDiagnostic> = Logger.make(({ cause, date, fiber, logLevel, message }) => {
  const annotations = fiber.getRef(CurrentLogAnnotations)
  const source = annotations[SOURCE]
  const parts = (Array.isArray(message) ? message : [message]).map(say)
  for (const [key, value] of Object.entries(annotations)) {
    if (key !== SOURCE) {
      parts.push(key + "=" + say(value))
    }
  }
  const text = parts.join(" ") + (cause.reasons.length === 0 ? "" : "\n" + Cause.pretty(cause))
  return {
    level: LEVELS[logLevel] ?? "info",
    source: Predicate.isString(source) && source !== "" ? source : NONE,
    text,
    created: date.getTime()
  }
})

// Effect's logger for the table `log`. It takes the place of the loggers
// that write to the console.
export const layer: Layer.Layer<never, StoreError, Store> = Logger.layer([
  Effect.gen(function*() {
    const store = yield* Store
    yield* store.dropDiagnostics((yield* Clock.currentTimeMillis) - KEEP)
    let lost = 0
    return yield* Logger.batched(row, {
      window: WINDOW,
      flush: (rows) =>
        Effect.gen(function*() {
          const first = rows[0]
          const all: ReadonlyArray<NewDiagnostic> = lost === 0 || first === undefined
            ? rows
            : [{ level: "warn", source: OWN, text: lost + " diagnostics were lost: the database refused them", created: first.created }, ...rows]
          const wrote = yield* Effect.result(store.addDiagnostics(all))
          lost = wrote._tag === "Failure" ? lost + rows.length : 0
        })
    })
  })
])
