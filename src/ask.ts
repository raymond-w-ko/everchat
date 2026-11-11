// Ask
// ===
// To ask is to send a request and get its reply, with the tries that it
// needs. A wire sends a request once and says what happened. This service
// owns the request from its start to its end:
//
// - It finds the wire for the pick's vendor.
// - It puts the request through the cache watch (cache.ts): a request that
//   can wait does so for a prefix that is not readable yet, and each reply
//   gets a judgment of its cache read.
// - It tries again when the wire's error says that another try can help.
//
// Two kinds of request differ in how they are tried:
//
// - A patient request (a compaction) is tried until it is answered. An
//   outage only delays a node. Its reply is only text, so a try that broke in
//   the middle can be sent again.
// - Any other request (a step of a turn) is tried again only while the
//   model has not begun to answer, and a few times at most. Once it has
//   begun, it may have started a program: the code that owns the turn must
//   decide, not this service.
//
// An error that no try can help (a used-up quota, a refused key, a bad
// request, the vendor's rules) ends the request at once, for both kinds.
//
// It does not write the usage row. The reply has the usage and the cache
// judgment, and the code that owns the event writes them in the event's own
// transaction (the memory does, for a compaction).

import { Context, Effect, Layer, Option, Random, Stream } from "effect"
import { Cache } from "./cache.ts"
import { OpenAI } from "./openai.ts"
import { type Event, type Reply, type Request, type Wire, WireError } from "./request.ts"

// The most tries of a request that is not patient.
export const TRIES = 5

// How long to wait before try `n` (1: the second try), in milliseconds,
// when the vendor names no time: 1 s, 2 s, 4 s, ... up to a minute, each
// between half and all of that. A test replaces it.
export const AskDelay = Context.Reference<(n: number) => Effect.Effect<number>>("everchat/ask/AskDelay", {
  defaultValue: () => (n) => Effect.map(Random.nextBetween(0.5, 1), (part) => Math.round(Math.min(60_000, 1000 * 2 ** (n - 1)) * part))
})

export interface Asking {
  readonly patient?: boolean | undefined
}

export class Ask extends Context.Service<Ask, {
  // The events of a request, from the try that the model answered.
  stream(request: Request, how?: Asking): Stream.Stream<Event, WireError>
  // The reply only.
  ask(request: Request, how?: Asking): Effect.Effect<Reply, WireError>
}>()("everchat/ask/Ask") {
  static readonly layer = Layer.effect(
    Ask,
    Effect.gen(function*() {
      const cache = yield* Cache
      const delay = yield* AskDelay
      const wires: Record<string, Wire> = { openai: yield* OpenAI }

      const stream = (request: Request, how: Asking = {}): Stream.Stream<Event, WireError> => {
        const patient = how.patient === true
        const wire = wires[request.pick.vendor]
        if (wire === undefined) {
          return Stream.fail(
            new WireError({ kind: "input", message: `no wire for the vendor "${request.pick.vendor}"`, retry: false, began: false, after: null, status: null, code: null, request: null })
          )
        }
        const attempt = (n: number): Stream.Stream<Event, WireError> =>
          cache.send(wire, request, patient).pipe(
            Stream.catch((error) => {
              const again = error.retry && (patient || (!error.began && n < TRIES))
              if (!again) {
                return Stream.fail(error)
              }
              return Stream.unwrap(Effect.gen(function*() {
                const wait = error.after !== null ? error.after * 1000 : yield* delay(n)
                yield* Effect.logWarning(`a request failed (${error.kind}), and is sent again in ${wait} ms: ${error.message}`)
                yield* Effect.sleep(wait)
                return attempt(n + 1)
              }))
            })
          )
        return attempt(1)
      }

      const ask = (request: Request, how: Asking = {}): Effect.Effect<Reply, WireError> =>
        Effect.flatMap(Stream.runLast(stream(request, how)), (last) =>
          Option.isSome(last) && last.value.type === "end"
            ? Effect.succeed(last.value.reply)
            : Effect.fail(
              new WireError({ kind: "protocol", message: "the stream gave no reply", retry: false, began: true, after: null, status: null, code: null, request: null })
            ))

      return Ask.of({ stream, ask })
    })
  )
}
