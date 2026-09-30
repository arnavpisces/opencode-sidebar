import { expect, test } from "bun:test"
import { Writable } from "node:stream"
import { TerminalFrames } from "../src/lib/render-terminal.js"

function fixture() {
  const writes: string[] = []
  const terminal = Object.assign(new Writable({ write(chunk, _encoding, callback) { writes.push(chunk.toString()); callback() } }), { columns: 20, rows: 4, isTTY: true })
  const frames = new TerminalFrames(terminal as unknown as NodeJS.WriteStream)
  writes.length = 0
  const send = (output: string) => new Promise<void>((resolve, reject) => frames.write(output, (error) => error ? reject(error) : resolve()))
  return { frames, terminal, writes, send }
}

test("terminal frames anchor diffs absolutely and skip unchanged frames", async () => {
  const { frames, writes, send } = fixture()
  await send("first\nsecond")
  expect(writes.join("")).toContain("\x1b[1;1H")
  expect(writes.join("")).toContain("\x1b[2;1H")
  expect(writes.join("")).not.toContain("\n")
  writes.length = 0
  await send("first\nsecond")
  expect(writes).toHaveLength(0)
  await send("first\nchanged")
  expect(writes.join("")).toContain("\x1b[2;1H")
  expect(writes.join("")).not.toContain("\x1b[1;1H")
  expect(writes.join("")).not.toContain("\x1b[2J")
  frames.dispose()
})

test("terminal frames erase removed rows, invalidate on resize, and forward controls", async () => {
  const { frames, terminal, writes, send } = fixture()
  await send("first\nsecond")
  writes.length = 0
  await send("first")
  expect(writes.join("")).toContain("\x1b[2;1H\x1b[0m\x1b[K")
  writes.length = 0
  terminal.emit("resize")
  await send("first")
  expect(writes.join("")).toContain("\x1b[1;1H")
  writes.length = 0
  await send("\x1b]11;#123456\x1b\\")
  expect(writes).toEqual(["\x1b]11;#123456\x1b\\"])
  writes.length = 0
  frames.dispose()
  frames.dispose()
  await new Promise((resolve) => setImmediate(resolve))
  expect(writes).toEqual(["\x1b[?7h\x1b[?25h"])
})
