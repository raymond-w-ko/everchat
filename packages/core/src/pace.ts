// Pace
// ====
// What streams, at a grain that a person can read. The model gives its
// thought, its text and its program a few characters at a time. An
// interface that shows each of these pieces moves on every word. This
// module holds the pieces back, and gives them on at a boundary.
//
// It takes the turn loop's events (turn.ts) and gives events of the same
// type. Only the pieces of what streams (`thought`, `text`, `program`)
// change: there are fewer of them, and each one ends at a boundary. So an
// interface reads paced events as it reads the turn loop's own.
//
// The module knows no terminal and no screen. `pacer` is plain code with
// no clock of its own: the caller gives the time. So any interface can use
// it, also one that sends the events to another program.
//
// Nothing here is state. What streams is never in the database: a step is
// written when it ends, whole (turn.ts). A crash loses what was held and
// what was shown, and the restart asks the step again.
//
// When a held text is given on
//
// 1. At the end of a paragraph, at once. A paragraph of a thought or of
//    a text ends with an empty line. Code between two fence lines (a line
//    of three or more backticks or tildes) is one paragraph, whatever
//    empty lines it has: it ends with its second fence line. A whole
//    paragraph never changes again, so it is drawn once, and half of a
//    bold mark or of a table is never shown.
// 2. When its oldest part is older than LIMIT: up to the end of its last
//    whole line, or else of its last sentence. So a long paragraph
//    still moves, in whole lines.
// 3. When nothing came for QUIET: all of it. The model stopped for a
//    while, and nothing is gained by a wait.
// 4. When it is older than LONG and has no boundary: up to its last space.
// 5. When the model goes on to another thing (from its thought to its
//    text, from its text to a program): all of it. That text is over.
//
// A program has no paragraphs: it is given on in whole lines, by rules 2
// to 5.
//
// When a held text is dropped
//
// When an event says that the step's streams are over: EverChat's message
// entered the log (it holds the whole text), a program started (the event
// holds the whole program), or the turn ended. What is held then is in
// that event already, or it is not in the log.

import { Clock, Effect, type PubSub, Stream } from "effect"
import type { TurnEvent } from "./turn.ts"

// The times, in milliseconds.
export const LIMIT = 1000
export const QUIET = 400
export const LONG = 3000

// How often `paced` looks at what is held, at most.
export const TICK = 200

export interface Pace {
  readonly limit?: number | undefined
  readonly quiet?: number | undefined
  readonly long?: number | undefined
}

export interface Pacer {
  // An event of the turn loop, at the time `now`. It gives the events to
  // show, in order.
  push(event: TurnEvent, now: number): Array<TurnEvent>
  // The time is `now`: it gives what was held for long enough.
  tick(now: number): Array<TurnEvent>
}

type Kind = "thought" | "text" | "program"
const KINDS: ReadonlyArray<Kind> = ["thought", "text", "program"]

// What is held of one stream.
interface Held {
  text: string // not given on yet
  since: number // when its oldest part came
  last: number // when its newest part came
  scan: number // `text` up to here is whole lines that were looked at
  head: string // the part of the present line that was given on already
  fence: string | null // the fence line that opened the code that is open
  carry: string // white space that was due: it goes with the next text
}

const held = (): Held => ({ text: "", since: 0, last: 0, scan: 0, head: "", fence: null, carry: "" })

// The end of the last sentence in `text`, or 0.
const SENTENCE = /[.!?…]["'”’)\]*_`]*\s+|[。！？]["”’」』）]*/g
const sentence = (text: string): number => {
  let end = 0
  for (const found of text.matchAll(SENTENCE)) {
    end = found.index + found[0].length
  }
  return end
}

// Looks at the new whole lines. It gives the end of the last paragraph
// that ended in them, or 0.
const paragraphs = (one: Held): number => {
  let end = 0
  for (;;) {
    const newline = one.text.indexOf("\n", one.scan)
    if (newline === -1) {
      return end
    }
    const line = one.head + one.text.slice(one.scan, newline)
    one.head = ""
    one.scan = newline + 1
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (one.fence === null) {
      if (mark !== undefined) {
        one.fence = mark
      } else if (line.trim() === "") {
        end = one.scan
      }
    } else if (mark !== undefined && mark[0] === one.fence[0] && mark.length >= one.fence.length && line.trim() === mark) {
      one.fence = null
      end = one.scan
    }
  }
}

// Takes the first `to` characters out. It gives them, or "" when they are
// only white space: that goes with the next text.
const release = (one: Held, to: number, now: number): string => {
  const out = one.carry + one.text.slice(0, to)
  if (to > one.scan) {
    one.head += one.text.slice(one.scan, to)
    one.scan = 0
  } else {
    one.scan -= to
  }
  one.text = one.text.slice(to)
  one.since = now
  if (out.trim() === "") {
    one.carry = out
    return ""
  }
  one.carry = ""
  return out
}

export const pacer = (options: Pace = {}): Pacer => {
  const limit = options.limit ?? LIMIT
  const quiet = options.quiet ?? QUIET
  const long = options.long ?? LONG
  const turns = new Map<number, Record<Kind, Held>>()

  const of = (turn: number): Record<Kind, Held> => {
    let streams = turns.get(turn)
    if (streams === undefined) {
      streams = { thought: held(), text: held(), program: held() }
      turns.set(turn, streams)
    }
    return streams
  }

  // How much of `one` the time gives on: rules 2, 3 and 4.
  const due = (one: Held, kind: Kind, now: number): number => {
    if (one.text === "") {
      return 0
    }
    if (now - one.last >= quiet) {
      return one.text.length
    }
    if (now - one.since < limit) {
      return 0
    }
    const line = one.text.lastIndexOf("\n") + 1
    if (line > 0) {
      return line
    }
    const end = kind === "program" ? 0 : sentence(one.text)
    if (end > 0) {
      return end
    }
    if (now - one.since < long) {
      return 0
    }
    const space = kind === "program" ? 0 : one.text.search(/\s\S*$/) + 1
    return space > 0 ? space : one.text.length
  }

  const give = (out: Array<TurnEvent>, turn: number, kind: Kind, one: Held, to: number, now: number) => {
    const delta = to > 0 ? release(one, to, now) : ""
    if (delta !== "") {
      out.push({ type: kind, turn, delta })
    }
  }

  const push = (event: TurnEvent, now: number): Array<TurnEvent> => {
    switch (event.type) {
      case "thought":
      case "text":
      case "program": {
        const streams = of(event.turn)
        const out: Array<TurnEvent> = []
        // Rule 5: the model went on to this one, so the others are over.
        for (const kind of KINDS) {
          if (kind !== event.type) {
            give(out, event.turn, kind, streams[kind], streams[kind].text.length, now)
          }
        }
        const one = streams[event.type]
        if (one.text === "") {
          one.since = now
        }
        one.text += event.delta
        one.last = now
        const whole = event.type === "program" ? 0 : paragraphs(one)
        give(out, event.turn, event.type, one, whole > 0 ? whole : due(one, event.type, now), now)
        return out
      }
      case "message": {
        if (event.message.kind === "asst" && event.message.turn !== null) {
          turns.delete(event.message.turn)
        }
        return [event]
      }
      case "call":
      case "end": {
        turns.delete(event.turn)
        return [event]
      }
      default: {
        return [event]
      }
    }
  }

  const tick = (now: number): Array<TurnEvent> => {
    const out: Array<TurnEvent> = []
    for (const [turn, streams] of turns) {
      for (const kind of KINDS) {
        give(out, turn, kind, streams[kind], due(streams[kind], kind, now), now)
      }
    }
    return out
  }

  return { push, tick }
}

// The events of a subscription to the turn loop, paced, with the clock's
// time. An interface runs this stream, and shows each event.
export const paced = (events: PubSub.Subscription<TurnEvent>, options: Pace = {}): Stream.Stream<TurnEvent> =>
  Stream.suspend(() => {
    const pace = pacer(options)
    const every = Math.max(10, Math.min(TICK, (options.quiet ?? QUIET) / 2))
    return Stream.merge(Stream.fromSubscription(events), Stream.tick(every).pipe(Stream.as(null))).pipe(
      Stream.mapEffect((event) => Effect.map(Clock.currentTimeMillis, (now) => (event === null ? pace.tick(now) : pace.push(event, now)))),
      Stream.flattenIterable
    )
  })
