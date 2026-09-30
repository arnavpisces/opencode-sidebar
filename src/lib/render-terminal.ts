import { Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"
import type { ReactNode } from "react"
import { render, type RenderOptions } from "ink"

const BEGIN_UPDATE = "\u001b[?2026h"
const END_UPDATE = "\u001b[?2026l"

/** Own cursor placement: Ink 6.8's incremental trailing-newline path drifts a row. */
export class TerminalFrames extends Writable {
  readonly isTTY = true
  private previousRows: string[] = []
  private invalidated = true
  private disposed = false
  private readonly resize = () => {
    this.invalidated = true
    this.emit("resize")
  }

  constructor(private readonly terminal: NodeJS.WriteStream) {
    super()
    terminal.on("resize", this.resize)
    terminal.write("\u001b[?25l")
  }

  get columns() { return this.terminal.columns }
  get rows() { return this.terminal.rows }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const output = chunk.toString()
    if (!stripVTControlCharacters(output)) {
      // OSC background, mouse/keyboard protocol, and cursor visibility controls.
      this.terminal.write(output, callback)
      return
    }
    const nextRows = output.split("\n").slice(0, this.rows)
    const changes: string[] = []
    for (let row = 0; row < Math.min(this.rows, Math.max(nextRows.length, this.previousRows.length)); row++) {
      const next = nextRows[row] ?? ""
      if (this.invalidated || next !== this.previousRows[row]) {
        changes.push(`\u001b[${row + 1};1H\u001b[0m\u001b[K${next}`)
      }
    }
    this.previousRows = nextRows
    this.invalidated = false
    if (!changes.length) { callback(); return }
    // No line feeds or relative cursor moves. Full-width rows cannot wrap into
    // an unchanged neighbor, and the terminal reveals the whole diff together.
    this.terminal.write(BEGIN_UPDATE + "\u001b[?7l" + changes.join("") + "\u001b[?7h" + END_UPDATE, callback)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.terminal.off("resize", this.resize)
    this.terminal.write("\u001b[?7h\u001b[?25h")
  }
}

export function renderTerminalApp(node: ReactNode, options: RenderOptions = {}) {
  const terminal = options.stdout ?? process.stdout
  if (!terminal.isTTY) return render(node, options)
  const frames = new TerminalFrames(terminal)
  const instance = render(node, {
    ...options,
    stdout: frames as unknown as NodeJS.WriteStream,
    debug: true,
    incrementalRendering: false,
    patchConsole: false,
  })
  const completed = instance.waitUntilExit().finally(() => frames.dispose())
  return { ...instance, waitUntilExit: () => completed }
}
