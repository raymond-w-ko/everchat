// Limit
// =====
// The output limit: the most text of a program's result that the model is
// shown (docs/schema.html, "The output limit"). The database keeps a result
// whole. When a result is over the limit:
//
// - the model gets its head and its tail, with a line between them that
//   says how much was left out and where the whole text is;
// - the whole text is written to a file, so that a program can read or
//   search it with `shell` and `read`;
// - `result(id)` gives the whole text to a program too, from the database.
//
// The file is a copy, not state. It is in a private directory under the
// system's temporary directory. When it is gone (after a reboot, for
// example), `result(id)` writes it again.
//
// The limit is on what the model reads, not on what a program gets: a
// function gives its whole result to the program that called it. A second,
// hard limit keeps a command that never stops printing from filling the
// memory and the database.
//
// This file is the core's part: the cap, and the tag. The layer, which
// writes the files, is in limitfile.ts.

import { Context, Effect } from "effect"

// The most characters of a result that the model is shown, when the config
// gives no other number. Three harnesses agree on about this size.
export const LIMIT = 30000

// The most bytes that one call may produce: the hard limit.
export const HARD = 64 * 1024 * 1024

// The characters that the line between the head and the tail may take.
const ROOM = 512

// The bytes of one character of `text` at `at`, in UTF-8, and how many
// code units it takes (2 for a surrogate pair). A lone surrogate is written
// as U+FFFD, in 3 bytes, as Node's `Buffer.byteLength` counts it.
const char = (text: string, at: number): readonly [bytes: number, units: number] => {
  const code = text.charCodeAt(at)
  if (code < 0x80) return [1, 1]
  if (code < 0x800) return [2, 1]
  if (code >> 10 === 0x36 && at + 1 < text.length && text.charCodeAt(at + 1) >> 10 === 0x37) return [4, 2]
  return [3, 1]
}

// The bytes of `text` in UTF-8.
export const bytes = (text: string): number => {
  let total = 0
  for (let at = 0; at < text.length;) {
    const [size, units] = char(text, at)
    total += size
    at += units
  }
  return total
}

// True when a cut at `at` would part the two halves of a surrogate pair.
const parts = (text: string, at: number) => at > 0 && at < text.length && text.charCodeAt(at) >> 10 === 0x37

// A result as the model is shown it: whole when it fits in `limit`
// characters, else its head and its tail (half each), with `where` in the
// line between them. `where` says how to get the whole text.
export const shorten = (text: string, limit: number, where: string): string => {
  if (text.length <= limit) {
    return text
  }
  const half = Math.floor(limit / 2)
  let head = half
  let tail = text.length - Math.max(0, half - ROOM)
  if (parts(text, head)) head -= 1
  if (parts(text, tail)) tail += 1
  const out = tail - head
  return text.slice(0, head) + "\n[... " + out + " of " + text.length + " characters left out. " + where + " ...]\n" + text.slice(tail)
}

// A text of at most `most` bytes: the start of `text`, never with half a
// character at its end. The longest start that fits, then one unit less if
// the cut is before the second half of a pair.
export const capped = (text: string, most: number): string => {
  let total = 0
  let at = 0
  while (at < text.length) {
    const [size, units] = char(text, at)
    if (total + size > most) {
      break
    }
    total += size
    at += units
  }
  return at === text.length ? text : text.slice(0, parts(text, at) ? at - 1 : at)
}

export interface Shown {
  readonly text: string // what the model reads
  readonly shown: number // its bytes
}

export class Limit extends Context.Service<Limit, {
  // A call's result as the model is shown it. A result over the limit is
  // shortened, and its whole text is written to the call's file. This never
  // fails: with no file, the line names only `result(id)`.
  show(call: number, text: string): Effect.Effect<Shown>
  // The path of a call's file, whether it exists or not.
  file(call: number): string
  // Writes a call's whole result to its file again. False: it could not.
  put(call: number, text: string): Effect.Effect<boolean>
}>()("everchat/limit/Limit") {}
