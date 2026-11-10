// Cache
// =====
// The watch on the vendor's prompt cache: for each request, how many tokens
// it should read from the cache, and whether it did.
//
// Why we compute this ourselves: the vendor's own diagnosis
// (`Reply.diagnosis`) does not come through the author's inference gateway, and a reply only
// says how many tokens were read. A reply that reads nothing looks the same
// when it is the first of its kind and when the cache missed.
//
// How: a request is a list of parts in order (the head, each block of the
// view, each item of the turn). The watch keeps, for a while, a fingerprint
// of every prefix that was sent: a hash of the parts from the first to that
// one. A new request should read the longest of its prefixes that an
// earlier request sent, if that request is old enough for its entry to be
// readable and young enough for the entry to be alive. The watch counts in
// bytes, and turns bytes into tokens with the reply's own total, so it needs
// no tokenizer.
//
// The verdict of a reply:
//
// - first: nothing to read was expected.
// - hit: it read about what was expected.
// - partial: it read less than half of what was expected. The prefix
//   changed earlier than we think: most likely a bug of ours.
// - miss: it read nothing, and at least MIN tokens were expected. If our
//   bytes were the same, this is the vendor's or the inference gateway's doing.
//
// The state is in RAM only. After a restart the first requests have no
// expectation, which is the truth: the watch does not know.
//
// This is the first part of the cache rule that sits above the wires. Not
// here yet: single flight (requests with one prefix do not all go at once).

import { Clock, Context, Effect, Layer, Stream } from "effect"
import type { Event, Request, Usage, Wire } from "./request.ts"

// A cached prefix lives at least this long (OpenAI: 30 minutes by default).
export const ALIVE = 30 * 60_000

// An entry is readable this long after its request was sent. Measured
// through the author's inference gateway on 2026-11-10 (tools/probe.ts): requests 4 to 5 s
// apart read the entry each time; at 3 s they did so only sometimes.
export const READY = 5_000

// The vendor caches nothing shorter than this many tokens.
export const MIN = 1024

export type Verdict = "first" | "hit" | "partial" | "miss"

// What a request should read: the bytes of its longest prefix that an
// earlier request sent, the bytes of the whole request, and the age of that
// earlier request.
export interface Expectation {
  readonly bytes: number
  readonly total: number
  readonly age: number | null // milliseconds; null: no such request
}

export interface Judgment {
  readonly verdict: Verdict
  readonly expected: number // tokens that the cache should have given
  readonly read: number // tokens that it gave
}

// The parts of a request, in the order of its bytes. Everything that the
// vendor matches goes in the first part: a request with another model,
// speed, effort or head shares nothing with this one.
export const parts = (request: Request): Array<string> => {
  const { effort, model, speed, vendor } = request.pick
  const out = [JSON.stringify([request.session, vendor, model, speed, effort, request.head])]
  for (const item of request.items) {
    if (item.kind === "user") {
      for (const block of item.blocks) out.push(block.text)
      for (const picture of item.pictures ?? []) out.push(picture.type + ":" + new Bun.CryptoHasher("sha256").update(picture.bytes).digest("hex"))
    } else if (item.kind === "turn") {
      for (const one of item.output) out.push(JSON.stringify(one))
    } else {
      for (const result of item.results) out.push(JSON.stringify([result.id, result.output, (result.pictures ?? []).length]))
    }
  }
  return out
}

// What a reply read, against what was expected.
export const judge = (expectation: Expectation, usage: Usage): Judgment => {
  const all = usage.input + usage.cacheRead + usage.cacheWrite
  const expected = expectation.total === 0 ? 0 : Math.round(all * expectation.bytes / expectation.total)
  const read = usage.cacheRead
  const verdict: Verdict = expected < MIN ? "first" : read === 0 ? "miss" : read < expected / 2 ? "partial" : "hit"
  return { verdict, expected, read }
}

export class Cache extends Context.Service<Cache, {
  // Notes that `request` is sent now, and says what it should read.
  expect(request: Request): Effect.Effect<Expectation>
  // A wire that judges each reply, puts the judgment in `Reply.cache`, and
  // logs a miss or a partial read.
  watch(wire: Wire): Wire
}>()("everchat/cache/Cache") {
  static readonly layer = Layer.sync(Cache, () => {
    // When each prefix was last sent, by its fingerprint.
    const sent = new Map<string, number>()

    const expect = (request: Request): Effect.Effect<Expectation> =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        for (const [key, at] of sent) {
          if (now - at > ALIVE) sent.delete(key)
        }
        let [bytes, total, age]: [number, number, number | null] = [0, 0, null]
        const hasher = new Bun.CryptoHasher("sha256")
        const prints: Array<string> = []
        for (const part of parts(request)) {
          total += Buffer.byteLength(part, "utf8")
          hasher.update(part).update("\u0000")
          const print = hasher.copy().digest("hex")
          prints.push(print)
          const at = sent.get(print)
          if (at !== undefined && now - at >= READY) {
            bytes = total
            age = now - at
          }
        }
        // A prefix that is sent again before it is ready keeps its first
        // time: its entry becomes readable READY after the first request.
        for (const print of prints) {
          const at = sent.get(print)
          if (at === undefined || now - at >= READY) sent.set(print, now)
        }
        return { bytes, total, age }
      })

    const watch = (wire: Wire): Wire => ({
      send: (request) =>
        Stream.unwrap(Effect.map(expect(request), (expectation) =>
          wire.send(request).pipe(Stream.mapEffect((event): Effect.Effect<Event> => {
            if (event.type !== "end" || event.reply.usage === null) {
              return Effect.succeed(event)
            }
            const cache = judge(expectation, event.reply.usage)
            const said = cache.verdict === "miss" || cache.verdict === "partial"
              ? Effect.logWarning(
                `prompt cache ${cache.verdict}: read ${cache.read} of about ${cache.expected} tokens expected`,
                {
                  model: request.pick.model,
                  speed: event.reply.pick.speed,
                  asked: request.pick.speed,
                  age: expectation.age === null ? null : Math.round(expectation.age / 1000),
                  bytes: expectation.bytes,
                  total: expectation.total,
                  reply: event.reply.id,
                  request: event.reply.request
                }
              )
              : Effect.void
            return Effect.as(said, { type: "end", reply: { ...event.reply, cache } })
          }))))
    })

    return Cache.of({ expect, watch })
  })
}
