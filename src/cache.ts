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
// - small: a part was expected, but a small one (under WORTH tokens), and
//   nothing was read. This is not counted as a miss. Real requests showed
//   that the vendor does not read a shared part near its minimum reliably:
//   a small part may not be worth an entry on its side.
// - hit: it read about what was expected.
// - partial: it read less than half of what was expected. The prefix
//   changed earlier than we think: most likely a bug of ours.
// - miss: it read nothing, and at least WORTH tokens were expected. If our
//   bytes were the same, this is the vendor's or the gateway's doing.
//
// Only a miss and a partial read are logged.
//
// The state is in RAM only. After a restart the first requests have no
// expectation, which is the truth: the watch does not know.
//
// Single flight
//
// Requests with one prefix must not all go at once: none of them would
// find the entry that the first one writes. So a request that can wait (a
// compaction, for example) waits when an earlier request sent a long part
// of its bytes too short a time ago, until that part is readable. It waits
// only for a gain of at least GAIN bytes: a few lines are not worth some
// seconds. A turn does not wait: a person waits for it.
//
// A part is readable READY after its first request was sent, and not before
// that request's reply has ended. A compaction can take longer than READY,
// and what a request writes to the cache is not there before it has ended.
//
// A limit to know: the watch takes any earlier prefix as readable. That is
// how the cache behaves on the route through the author's inference
// gateway. On OpenAI's plain API an entry exists only where the earlier
// request had one of its four marks, so there the watch can expect more
// than the vendor can give.

import { Clock, Context, Effect, Layer, Stream } from "effect"
import type { Event, Request, Usage, Wire, WireError } from "./request.ts"

// A cached prefix lives at least this long (OpenAI: 30 minutes by default).
export const ALIVE = 30 * 60_000

// An entry is readable this long after its request was sent. Measured
// through the author's inference gateway on 2026-11-10 (tools/probe.ts): requests 4 to 5 s
// apart read the entry each time; at 3 s they did so only sometimes.
export const READY = 5_000

// The vendor caches nothing shorter than this many tokens.
export const MIN = 1024

// A shared part of fewer tokens than this is not counted on: when nothing
// of it is read, the verdict is `small` and not `miss`. Measured on
// 2026-11-10: a shared head of about 1,300 tokens was read by requests that
// were equal almost to their end, and by no request that differed after the
// head. A head of 2,560 tokens was read each time.
export const WORTH = 2048

// A request that can wait does so only when it then reads at least this
// many bytes more (about MIN tokens).
export const GAIN = 4096

// How long a request waits before it looks again, while the request that
// it waits for still runs.
export const LOOK = 250

export type Verdict = "first" | "small" | "hit" | "partial" | "miss"

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
  const verdict: Verdict = expected < MIN
    ? "first"
    : read === 0
    ? (expected < WORTH ? "small" : "miss")
    : read < expected / 2
    ? "partial"
    : "hit"
  return { verdict, expected, read }
}

// What the watch says to a request that wants to go: wait this long and ask
// again, or go, with what it should read.
type Admission = { readonly wait: number } | { readonly go: Expectation; readonly noted: ReadonlyArray<string>; readonly at: number }

export class Cache extends Context.Service<Cache, {
  // Notes that `request` is sent now, and says what it should read.
  expect(request: Request): Effect.Effect<Expectation>
  // Sends `request` through `wire`. A request that can wait (`patient`)
  // first waits for a long prefix of its own that is not readable yet. The
  // reply gets the judgment (`Reply.cache`), and a miss or a partial read is
  // logged.
  send(wire: Wire, request: Request, patient: boolean): Stream.Stream<Event, WireError>
  // A wire that judges each reply, with no wait.
  watch(wire: Wire): Wire
}>()("everchat/cache/Cache") {
  static readonly layer = Layer.sync(Cache, () => {
    // Each prefix that was sent, by its fingerprint: when it was first sent,
    // when its entry becomes readable, whether the request that first sent
    // it still runs, and when it was last sent (an entry that is read lives
    // on). An entry is readable READY after its first request was sent, and
    // not before that request's reply has ended.
    const sent = new Map<string, { readonly at: number; ready: number; open: boolean; last: number }>()

    // One look at the state, with no pause: wait, or go and note the request.
    // `open`: the caller says later when the request has ended (`close`).
    const admit = (request: Request, patient: boolean, open: boolean, now: number): Admission => {
      for (const [key, entry] of sent) {
        if (now - entry.last > ALIVE) sent.delete(key)
      }
      let [bytes, total, age]: [number, number, number | null] = [0, 0, null]
      let flying: { readonly bytes: number; readonly wait: number } | null = null
      const hasher = new Bun.CryptoHasher("sha256")
      const prints: Array<string> = []
      for (const part of parts(request)) {
        total += Buffer.byteLength(part, "utf8")
        hasher.update(part).update("\u0000")
        const print = hasher.copy().digest("hex")
        prints.push(print)
        const entry = sent.get(print)
        if (entry !== undefined && !entry.open && now >= entry.ready) {
          bytes = total
          age = now - entry.at
        } else if (entry !== undefined) {
          // A request that still runs has no known end: look again soon.
          flying = { bytes: total, wait: entry.open ? Math.max(LOOK, entry.ready - now) : entry.ready - now }
        }
      }
      if (patient && flying !== null && flying.bytes - bytes >= GAIN) {
        return { wait: flying.wait }
      }
      const noted: Array<string> = []
      for (const print of prints) {
        const entry = sent.get(print)
        if (entry === undefined) {
          sent.set(print, { at: now, ready: now + READY, open, last: now })
          noted.push(print)
        } else {
          entry.last = now
        }
      }
      return { go: { bytes, total, age }, noted, at: now }
    }

    // The request that was admitted has ended. If it failed before the model
    // began, it wrote no entry: the prefixes that it was the first to send
    // are taken back, so that no request waits for them. Else they are
    // readable from now, or from READY after the request was sent.
    const close = (admission: { readonly noted: ReadonlyArray<string>; readonly at: number }, wrote: boolean, now: number): void => {
      for (const print of admission.noted) {
        const entry = sent.get(print)
        if (entry === undefined || entry.at !== admission.at || !entry.open) continue
        if (wrote) {
          entry.open = false
          entry.ready = Math.max(entry.ready, now)
        } else {
          sent.delete(print)
        }
      }
    }

    const expect = (request: Request): Effect.Effect<Expectation> =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const admission = admit(request, false, false, now)
        return "go" in admission ? admission.go : { bytes: 0, total: 0, age: null }
      })

    // Waits until the request may go.
    const turn = (request: Request, patient: boolean): Effect.Effect<Extract<Admission, { go: Expectation }>> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const admission = admit(request, patient, true, now)
        return "go" in admission
          ? Effect.succeed(admission)
          : Effect.andThen(Effect.sleep(admission.wait), turn(request, patient))
      })

    const send = (wire: Wire, request: Request, patient: boolean): Stream.Stream<Event, WireError> =>
      Stream.unwrap(Effect.map(turn(request, patient), (admission) => {
        const expectation = admission.go
        // `wrote`: false only when the request failed before the model began.
        let wrote = true
        return wire.send(request).pipe(
          Stream.tapError((error) => Effect.sync(() => {
            wrote = error.began
          })),
          // However the request ends (a reply, a failure, an interrupt), it
          // is closed, so that no request waits for it for ever.
          Stream.ensuring(Effect.map(Clock.currentTimeMillis, (now) => close(admission, wrote, now))),
          Stream.mapEffect((event): Effect.Effect<Event> => {
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
          })
        )
      }))

    return Cache.of({ expect, send, watch: (wire) => ({ send: (request) => send(wire, request, false) }) })
  })
}
