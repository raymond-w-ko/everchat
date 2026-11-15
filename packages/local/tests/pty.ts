// A real process in a real pseudo-terminal, for the tests of the whole
// program. What the process writes goes to a terminal emulator in memory
// (xterm.js), which also answers the process's queries as a terminal does.
// A test types with `type`, and reads the rows that a person would see.

import xterm from "@xterm/headless"

export class Pty {
  private readonly emulator: InstanceType<typeof xterm.Terminal>
  private readonly proc: Bun.Subprocess
  // All that the process wrote, as it wrote it.
  raw = ""
  code: number | null = null
  signal: string | null = null

  constructor(argv: ReadonlyArray<string>, env: Record<string, string | undefined>, cwd: string, columns = 100, rows = 30) {
    this.emulator = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 5000 })
    this.proc = Bun.spawn([...argv], {
      cwd,
      env: { ...env, TERM: "xterm-ghostty" },
      terminal: {
        cols: columns,
        rows,
        data: (_terminal, data) => {
          const text = Buffer.from(data).toString("utf8")
          this.raw += text
          this.emulator.write(text)
        }
      }
    })
    this.emulator.onData((data) => this.proc.terminal?.write(data))
    void this.proc.exited.then((code) => {
      this.code = code
      this.signal = this.proc.signalCode === null ? null : String(this.proc.signalCode)
    })
  }

  get pid(): number {
    return this.proc.pid
  }

  type(data: string): void {
    this.proc.terminal?.write(data)
  }

  resize(columns: number, rows: number): void {
    this.proc.terminal?.resize(columns, rows)
    this.emulator.resize(columns, rows)
  }

  kill(signal: NodeJS.Signals): void {
    this.proc.kill(signal)
  }

  // The terminal closes, as when its window does.
  close(): void {
    this.proc.terminal?.close()
  }

  // Every row from the top of the scrollback to the last row with text.
  async text(): Promise<string> {
    await new Promise<void>((done) => this.emulator.write("", done))
    const buffer = this.emulator.buffer.active
    const rows: Array<string> = []
    for (let k = 0; k < buffer.length; k++) {
      rows.push((buffer.getLine(k)?.translateToString(true) ?? "").trimEnd())
    }
    while (rows.length > 0 && rows[rows.length - 1] === "") {
      rows.pop()
    }
    return rows.join("\n")
  }

  // Waits until the screen holds every one of `texts`.
  async sees(...texts: ReadonlyArray<string>): Promise<string> {
    let text = ""
    for (let k = 0; k < 1500; k++) {
      text = await this.text()
      if (texts.every((one) => text.includes(one))) {
        return text
      }
      if (this.code !== null) {
        break
      }
      await Bun.sleep(10)
    }
    throw new Error("the screen never showed: " + texts.join(" and ") + " (exit " + this.code + ")\n" + text)
  }

  // Waits until the process has ended, at most `ms`. It gives the time that it took.
  async ends(ms = 10_000): Promise<number> {
    const start = Date.now()
    while (this.code === null && Date.now() - start < ms) {
      await Bun.sleep(10)
    }
    if (this.code === null) {
      this.proc.kill("SIGKILL")
      throw new Error("the process did not end in " + ms + " ms\n" + (await this.text()))
    }
    return Date.now() - start
  }
}
