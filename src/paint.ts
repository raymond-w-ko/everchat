// Paint
// =====
// What the terminal shows for each thing of the chat: a message of each
// kind, a program, and what the program itself tells the person. Each is a
// component of the library `pi-tui`: an object that gives its rows for a
// width. A row is one row of the screen. (A "line" is the memory's word,
// for a node as the model reads it.)
//
// - EverChat's words, and an agent's report, are drawn as markdown.
// - The person's words, a program, a result and a note are plain text,
//   wrapped to the width, each with its own mark before the first row.
// - A long program or result shows its first rows and its last two. The
//   log holds it whole.
// - The colors are the terminal's own (the 16 of its palette, and dim), so
//   a light and a dark terminal both read well.
//
// No control character of a text reaches the terminal: a result that holds
// an escape sequence must not move the cursor or change the screen.

import { type Component, Markdown, type MarkdownTheme, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { Kind } from "./store.ts"

// The most rows of a program, and of a result, on the screen.
export const MOST = 12

// Inks
// ----

const ink = (on: number, off: number) => (text: string): string => `\x1b[${on}m${text}\x1b[${off}m`

export const plain = (text: string): string => text
export const bold = ink(1, 22)
export const dim = ink(2, 22)
export const italic = ink(3, 23)
const underline = ink(4, 24)
const strike = ink(9, 29)
const cyan = ink(36, 39)

export const MARKDOWN: MarkdownTheme = {
  heading: bold,
  link: underline,
  linkUrl: dim,
  code: cyan,
  codeBlock: plain,
  codeBlockBorder: dim,
  quote: italic,
  quoteBorder: dim,
  hr: dim,
  listBullet: dim,
  bold,
  italic,
  strikethrough: strike,
  underline
}

// Text
// ----

// A text with no control character but the newline: escape sequences are
// taken out whole, a tab is 4 spaces, and every other control character is
// dropped.
export const clean = (text: string): string =>
  stripTerminalSequences(text.replace(/\r\n?/g, "\n"))
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")

// How a plain text is drawn.
export interface Look {
  readonly mark: string // before the first row; the other rows are indented by its width
  readonly ink: (text: string) => string
  readonly most?: number | undefined // the most rows; with more, some are left out
  readonly keep?: "ends" | "tail" | undefined // the rows that stay: the first ones and the last two, or the last ones
}

// A plain text, wrapped to the width.
export class Wrapped implements Component {
  private text: string
  private readonly look: Look
  private drawn: { readonly width: number; readonly rows: Array<string> } | null = null

  constructor(text: string, look: Look) {
    this.text = clean(text)
    this.look = look
  }

  setText(text: string): void {
    const next = clean(text)
    if (next !== this.text) {
      this.text = next
      this.drawn = null
    }
  }

  invalidate(): void {
    this.drawn = null
  }

  render(width: number): Array<string> {
    if (this.drawn === null || this.drawn.width !== width) {
      this.drawn = { width, rows: this.rows(width) }
    }
    return this.drawn.rows
  }

  private rows(width: number): Array<string> {
    const indent = visibleWidth(this.look.mark)
    const room = Math.max(1, width - indent)
    let rows = this.text.split("\n").flatMap((row) => (row === "" ? [""] : wrapTextWithAnsi(row, room)))
    const most = this.look.most
    if (most !== undefined && rows.length > most) {
      const out = rows.length - (most - 1)
      rows = this.look.keep === "tail"
        ? ["… " + out + " rows above", ...rows.slice(rows.length - (most - 1))]
        : [...rows.slice(0, most - 3), "… " + out + " more rows", ...rows.slice(rows.length - 2)]
    }
    const pad = " ".repeat(indent)
    // The last step keeps every row within the width, whatever the text is.
    return rows.map((row, k) => (row === "" && k > 0 ? "" : truncateToWidth((k === 0 ? this.look.mark : pad) + this.look.ink(row), width, "")))
  }
}

// One row that is never wrapped: what does not fit is left out.
export class Row implements Component {
  private text = ""

  setText(text: string): void {
    this.text = text
  }

  invalidate(): void {}

  render(width: number): Array<string> {
    return [truncateToWidth(this.text, width, "…")]
  }
}

// The things of the chat
// ----------------------

// The mark of each kind that is plain text. EverChat's words, and an
// agent's report, have none.
export const MARKS: Readonly<Record<Exclude<Kind, "asst" | "work">, string>> = { user: "› ", tool: "▸ ", echo: "◂ ", note: "· " }

export const LOOKS: Readonly<Record<Exclude<Kind, "asst" | "work">, Look>> = {
  user: { mark: bold(MARKS.user), ink: plain },
  tool: { mark: dim(MARKS.tool), ink: dim, most: MOST },
  echo: { mark: dim(MARKS.echo), ink: dim, most: MOST },
  note: { mark: dim(MARKS.note), ink: (text) => dim(italic(text)) }
}

// A thought while the model thinks it: its last rows.
export const THOUGHT: Look = { mark: dim("  "), ink: (text) => dim(italic(text)), most: 6, keep: "tail" }

// What the program itself tells the person. It is not a message.
export const TOLD: Look = { mark: dim("  "), ink: dim }

export const markdown = (text: string): Markdown => new Markdown(clean(text), 0, 0, MARKDOWN)

// A message of the log, as the terminal shows it.
export const message = (kind: Kind, text: string): Component =>
  kind === "asst" || kind === "work" ? markdown(text) : new Wrapped(text, LOOKS[kind])

// A message of the log as plain text, for pipe mode: no ink, not wrapped,
// and whole. EverChat's words are as the model wrote them. Another kind has
// its mark, and its lines after the first are indented under the text.
export const written = (kind: Kind, text: string): string =>
  kind === "asst" || kind === "work" ? clean(text) : MARKS[kind] + clean(text).split("\n").join("\n  ")
