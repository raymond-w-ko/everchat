// Compactor
// =========
// The model that runs compactions, for the memory (memory.ts, `Compactor`).
// It turns the blocks that the memory gives it into one request, with the
// chat's own head and id, and the reply into a line.
//
// - The head is the chat's (head.ts), so a compaction shares the head's
//   cache entry with the turns.
// - The request is patient (ask.ts): it waits for a prefix that is not
//   readable yet, and it is tried until the model answers.
// - A reply that the vendor's filter stopped, and a request that the vendor
//   refused for its input or for its rules, give no line. The memory then
//   takes the node's source, cut: that failure is the input's doing, and
//   another try would not change it.
// - A used-up quota or a refused key is an error. The memory asks again
//   later, and a person must act.
//
// The usage of the request goes back to the memory, with what the request
// should have read from the cache. The memory writes it with the node.

import { Effect, Layer } from "effect"
import { Ask } from "./ask.ts"
import { head } from "./head.ts"
import { Compactor, CompactorError } from "./memory.ts"
import { type Pick, Store } from "./store.ts"

export interface Options {
  readonly pick: Pick // the compactor's model: usually a cheap one
  readonly rules?: string | null | undefined // the person's own instructions, as in every head of the chat
}

export const layer = (options: Options) =>
  Layer.effect(
    Compactor,
    Effect.gen(function*() {
      const asker = yield* Ask
      const store = yield* Store
      const chat = yield* store.chat
      const sent = head(options.rules ?? null)
      return Compactor.of({
        compact: (blocks) =>
          asker.ask({ session: chat.uuid, pick: options.pick, head: sent, items: [{ kind: "user", blocks }] }, { patient: true }).pipe(
            Effect.map((reply) => ({
              text: reply.stop === "filter" ? "" : reply.text,
              usage: reply.usage === null ? undefined : {
                pick: reply.pick,
                request: reply.request,
                input: reply.usage.input,
                cacheRead: reply.usage.cacheRead,
                cacheWrite: reply.usage.cacheWrite,
                output: reply.usage.output,
                searches: reply.usage.searches,
                expected: reply.cache?.expected ?? null
              }
            })),
            Effect.catch((error) =>
              error.kind === "input" || error.kind === "policy"
                ? Effect.as(Effect.logWarning(`a compaction was refused (${error.kind}): ${error.message}`), { text: "" })
                : Effect.fail(new CompactorError({ cause: error }))
            )
          )
      })
    })
  )
