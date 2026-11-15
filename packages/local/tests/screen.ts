// A terminal for the tests: what the program writes goes to a terminal
// emulator in memory (xterm.js, with no window), and a test reads the rows
// that a person would see. A test types with `type`.
//
// It follows the virtual terminal of pi-tui's own tests.

import type { Terminal as Tty } from "@earendil-works/pi-tui"
import xterm from "@xterm/headless"

export const KEYS = { enter: "\r", escape: "\x1b", ctrlC: "\x03", ctrlD: "\x04", up: "\x1b[A", newRow: "\n" } as const

export class Screen implements Tty {
  private readonly emulator: InstanceType<typeof xterm.Terminal>
  private input: ((data: string) => void) | undefined
  private resized: (() => void) | undefined
  private width: number
  private height: number
  started = 0
  stopped = 0
  // All that was written, as it was written.
  written = ""

  constructor(columns = 80, rows = 24) {
    this.width = columns
    this.height = rows
    this.emulator = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 5000 })
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started++
    this.input = onInput
    this.resized = onResize
  }

  stop(): void {
    this.stopped++
    this.input = undefined
    this.resized = undefined
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.written += data
    this.emulator.write(data)
  }

  get columns(): number {
    return this.width
  }

  get rows(): number {
    return this.height
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(rows: number): void {
    if (rows !== 0) {
      this.write(rows > 0 ? `\x1b[${rows}B` : `\x1b[${-rows}A`)
    }
  }

  hideCursor(): void {
    this.write("\x1b[?25l")
  }

  showCursor(): void {
    this.write("\x1b[?25h")
  }

  clearLine(): void {
    this.write("\x1b[K")
  }

  clearFromCursor(): void {
    this.write("\x1b[J")
  }

  clearScreen(): void {
    this.write("\x1b[2J\x1b[H")
  }

  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}

  // What the tests use
  // ------------------

  // The person types `data`: text, or the bytes of a key (KEYS).
  type(data: string): void {
    this.input?.(data)
  }

  resize(columns: number, rows: number): void {
    this.width = columns
    this.height = rows
    this.emulator.resize(columns, rows)
    this.resized?.()
  }

  // Every row from the top of the scrollback to the last row with text,
  // each with no spaces at its end.
  async all(): Promise<Array<string>> {
    await new Promise<void>((done) => this.emulator.write("", done))
    const buffer = this.emulator.buffer.active
    const rows: Array<string> = []
    for (let k = 0; k < buffer.length; k++) {
      rows.push((buffer.getLine(k)?.translateToString(true) ?? "").trimEnd())
    }
    while (rows.length > 0 && rows[rows.length - 1] === "") {
      rows.pop()
    }
    return rows
  }

  // The same as one text.
  async text(): Promise<string> {
    return (await this.all()).join("\n")
  }
}
