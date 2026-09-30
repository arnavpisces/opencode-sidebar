import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const root = process.cwd()
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sidebar-rendering-"))
const controlFile = path.join(temp, "control.json")
const socket = `sidebar-rendering-${process.pid}`
const tmux = async (...args) => {
  const output = (await exec("tmux", ["-L", socket, ...args])).stdout
  // send-keys returns when bytes reach the PTY, before Ink consumes them.
  // Give each input a render turn before subsequent keys or assertions.
  if (args[0] === "send-keys") await new Promise((resolve) => setTimeout(resolve, 500))
  return args[0] === "capture-pane" ? output.trimEnd() : output.trim()
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitForCapture(predicate, target = "rendering") {
  let capture = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    capture = await tmux("capture-pane", "-p", "-t", target)
    if (predicate(capture)) return capture
    await pause(100)
  }
  assert.fail(`rendering did not settle\n${capture}`)
}
const captures = []
let sequence = 0
async function update(control) {
  const currentSequence = sequence++
  await fs.writeFile(controlFile, JSON.stringify({ ...control, sequence: currentSequence }))
  const running = await tmux("has-session", "-t", "rendering").then(() => true, () => false)
  if (!running) return
  for (let attempt = 0; attempt < 100; attempt++) {
    const applied = await fs.readFile(`${controlFile}.applied`, "utf8").catch(() => "")
    if (applied === String(currentSequence)) { await pause(100); return }
    await pause(100)
  }
  assert.fail(`fixture did not apply snapshot ${currentSequence}`)
}
async function check(label, expected = true) {
  const capture = await tmux("capture-pane", "-p", "-t", "rendering")
  captures.push({ label, capture })
  const boxes = capture.split("\n").filter((line) => line.includes("┌")).length
  assert.ok(boxes <= 1, `${label}: only banner or help gets a box`)
  for (const marker of ["OPENCODE SIDEBAR", "PROJECTS", "/tmp/render-project-"]) {
    const count = capture.split("\n").filter((line) => line.includes(marker)).length
    assert.ok(count <= 1, `${label}: duplicate ${marker} (${count})\n${capture}`)
    if (expected && !["OPENCODE SIDEBAR", "/tmp/render-project-"].includes(marker)) {
      assert.equal(count, 1, `${label}: missing ${marker}\n${capture}`)
    }
  }
}
async function resize(width, height) {
  await tmux("resize-window", "-t", "rendering", "-x", String(width), "-y", String(height))
  await pause(350)
}
async function railChecks() {
  // Verify the rail itself, restoring focus, mouse controls, and retained input.
  await resize(140, 45)
  const sidebarPane = await tmux("display-message", "-p", "-t", "rendering", "#{pane_id}")
  const rightPane = await tmux("split-window", "-h", "-d", "-t", sidebarPane, "-l", "87", "-P", "-F", "#{pane_id}", "sleep 60")
  await pause(350)
  const beforeRail = await tmux("capture-pane", "-p", "-t", sidebarPane)
  const selectedBeforeRail = beforeRail.split("\n").find((line) => line.trimStart().startsWith("> "))
  const paneValue = (target, format) => tmux("display-message", "-p", "-t", target, format)
  const verifyRail = async () => {
    let rail = ""
    for (let attempt = 0; attempt < 50; attempt++) {
      rail = await tmux("capture-pane", "-p", "-t", sidebarPane)
      if (rail.includes("›") && rail.includes("≡") && await paneValue(sidebarPane, "#{pane_width}") === "5") break
      await pause(100)
    }
    captures.push({ label: "collapsed sidebar rail", capture: rail })
    assert.deepEqual(rail.split("\n").map((line) => line.trim()).filter(Boolean), ["›", "≡", "○"], "collapsed view contains only centered icons, with no labels or counts")
    assert.ok(rail.split("\n").every((line) => Array.from(line).length <= 5), "icons stay inside the five-column pane")
    assert.equal(await paneValue(sidebarPane, "#{pane_width}"), "5")
    assert.equal(await paneValue(sidebarPane, "#{window_zoomed_flag}"), "0", "both panes remain visible")
    assert.equal(await paneValue(rightPane, "#{pane_active}"), "1", "collapse focuses OpenCode")
  }
  await tmux("send-keys", "-t", sidebarPane, "Tab")
  await verifyRail()
  await update({ count: 1, sessions: 3, working: true, label: "window removal" })
  await waitForCapture((capture) => capture.includes("●"), sidebarPane)
  await update({ error: "Rail connection error" })
  await waitForCapture((capture) => capture.includes("!"), sidebarPane)
  await update({ count: 1, sessions: 3, label: "window removal" })
  await waitForCapture((capture) => capture.includes("○"), sidebarPane)
  await tmux("select-pane", "-t", sidebarPane)
  await tmux("send-keys", "-t", sidebarPane, "Enter")
  await pause(400)
  assert.equal(await paneValue(sidebarPane, "#{pane_width}"), "52")
  assert.equal(await paneValue(sidebarPane, "#{pane_active}"), "1", "expand restores sidebar focus")
  const afterRail = await tmux("capture-pane", "-p", "-t", sidebarPane)
  assert.equal(afterRail.split("\n").find((line) => line.trimStart().startsWith("> ")), selectedBeforeRail, "collapse preserves selection")
  await tmux("send-keys", "-t", sidebarPane, "-l", "\x1b[<0;3;2M\x1b[<0;3;2m")
  await verifyRail()
  await tmux("select-pane", "-t", sidebarPane)
  await tmux("send-keys", "-t", sidebarPane, "-l", "\x1b[<0;1;1M\x1b[<0;1;1m")
  await pause(400)
  assert.equal(await paneValue(sidebarPane, "#{pane_width}"), "52", "clicking the rail's top padding expands it")
  await tmux("send-keys", "-t", sidebarPane, "Tab")
  await verifyRail()
  await tmux("select-pane", "-t", sidebarPane)
  await tmux("send-keys", "-t", sidebarPane, "-l", "\x1b[<0;5;30M\x1b[<0;5;30m")
  await waitForCapture((capture) => capture.includes("PROJECTS"), sidebarPane)
  assert.equal(await paneValue(sidebarPane, "#{pane_width}"), "52", "clicking empty space at the rail's edge expands it")
  await tmux("send-keys", "-t", sidebarPane, "/")
  await tmux("send-keys", "-t", sidebarPane, "-l", "saved query")
  await pause(250)
  const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`
  await tmux("run-shell", "-t", sidebarPane, `${quote(process.execPath)} ${quote(path.join(root, "dist/sidebar-layout.js"))} ${sidebarPane}`)
  await verifyRail()
  await tmux("select-pane", "-t", sidebarPane)
  await tmux("send-keys", "-t", sidebarPane, "Enter")
  await pause(400)
  const restoredSearch = await waitForCapture((capture) => capture.includes("/ saved query"), sidebarPane)
  captures.push({ label: "expanded sidebar preserves search", capture: restoredSearch })
  assert.ok(restoredSearch.includes("/ saved query"), "expanding retains search text without submitting it")
  await tmux("send-keys", "-t", sidebarPane, "Escape")
  await pause(150)
  await tmux("send-keys", "-t", sidebarPane, "Escape")
  await tmux("kill-pane", "-t", rightPane)
  await pause(350)
  assert.ok((await tmux("capture-pane", "-p", "-t", sidebarPane)).includes("PROJECTS"), "closing preview leaves the full sidebar usable")
  await tmux("send-keys", "-t", "rendering", "?")
  await pause(200)
  assert.ok((await tmux("capture-pane", "-p", "-t", "rendering")).includes("[Esc/?] Back"), "quit coverage begins in help")
  await tmux("send-keys", "-t", "rendering", "q")
  await pause(350)
  await assert.rejects(() => tmux("list-panes", "-t", "rendering"), "q quits from help")
}
async function redrawChecks() {
  const rawLog = path.join(temp, "redraw-raw.log")
  await update({ count: 3, sessions: 9, working: true, snapshotDelay: 450 })
  await tmux("new-session", "-d", "-s", "rendering", "-x", "52", "-y", "45", "-c", root,
    "env", `SIDEBAR_RENDER_CONTROL=${controlFile}`, `SIDEBAR_RENDER_RAW_LOG=${rawLog}`, process.execPath, path.join(root, "test/rendering-fixture.mjs"))
  const sample = async (label, times = 20) => {
    for (let index = 0; index < times; index++) {
      const capture = await tmux("capture-pane", "-p", "-t", "rendering")
      captures.push({ label: `${label}-${index}`, capture })
      for (const marker of ["OPENCODE SIDEBAR", "PROJECTS", "Choose theme"]) {
        assert.ok(capture.split("\n").filter((line) => line.includes(marker)).length <= 1, `${label}: duplicate ${marker}\n${capture}`)
      }
      const connectionRows = capture.split("\n").filter((line) => /^\s*(Connected|Connecting…|Connection issue)\s*$/u.test(line))
      assert.ok(connectionRows.length <= 1, `${label}: stale connection state\n${capture}`)
      await pause(80)
    }
  }
  await sample("startup animation", 35)
  const stable = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(stable.includes("Connected") && !stable.includes("Connecting…"), "successful startup replaces connecting state")
  assert.equal(stable.split("\n").filter((line) => line.includes("OPENCODE SIDEBAR")).length, 1, "settled title is present")
  assert.equal(stable.split("\n").filter((line) => line.includes("PROJECTS")).length, 1, "settled project heading is present")
  const rawStart = (await fs.readFile(rawLog)).length
  for (const [width, height, count] of [[35, 24, 1], [52, 45, 4], [25, 12, 2], [52, 45, 3]]) {
    await resize(width, height)
    await update({ count, working: true, label: "日本語 👩‍💻 redraw" })
    await sample(`resize ${width}x${height}`, 10)
  }
  await tmux("send-keys", "-t", "rendering", "-l", "t")
  await sample("theme preview", 10)
  await tmux("send-keys", "-t", "rendering", "Down")
  await sample("theme changes", 10)
  await tmux("send-keys", "-t", "rendering", "Escape")
  await sample("theme cancel", 10)
  const raw = (await fs.readFile(rawLog)).subarray(rawStart).toString()
  assert.ok((raw.match(/\x1b\[\?2026h/g) ?? []).length >= 5, "animation and resize continue to repaint multiple frames")
  assert.ok(!raw.includes("\x1b[2J") && !raw.includes("\x1b[3J"), "owned redraws never clear whole screen or scrollback")
}

async function themeChecks() {
  const { getThemeScheme } = await import("../dist/lib/themes.js")
  const colorsByRow = (ansi) => {
    let background = "#000000"
    return ansi.split("\n").map((line) => {
      const cells = []
      for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/gu) ?? []) {
        if (!token.startsWith("\x1b")) { cells.push({ char: token, background }); continue }
        const codes = token.slice(2, -1).split(";").map(Number)
        for (let index = 0; index < codes.length; index++) {
          const code = codes[index]
          if (code === 0 || code === 49) background = "#000000"
          else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
            if (code === 48) background = "#" + codes.slice(index + 2, index + 5).map((value) => value.toString(16).padStart(2, "0")).join("")
            index += 4
          } else if ((code === 38 || code === 48) && codes[index + 1] === 5) index += 2
        }
      }
      return cells
    })
  }
  const waitFor = async (marker) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const capture = await tmux("capture-pane", "-p", "-t", "rendering")
      if (capture.includes(marker)) return capture
      await pause(100)
    }
    assert.fail(`rendering did not become ready: ${marker}`)
  }
  const checkFrame = async (themeID, label) => {
    const theme = getThemeScheme(themeID)
    const capture = await tmux("capture-pane", "-p", "-e", "-N", "-t", "rendering")
    captures.push({ label, capture })
    const edges = colorsByRow(capture).flat().filter((cell) => /[┌┐└┘│]/u.test(cell.char))
    assert.ok(edges.length >= 6, `${label}: drawn frame edges present`)
    assert.ok(edges.every((cell) => cell.background === theme.base.background.toLowerCase()), `${label}: actual frame cells paint theme background, treating reset49 as black`)
    return capture
  }
  for (const themeID of ["nordic-frost", "paper-terminal"]) {
    const rawLog = path.join(temp, `${themeID}-raw.log`)
    await update({ count: 1 })
    await tmux("new-session", "-d", "-s", "rendering", "-x", "52", "-y", "45", "-c", root,
      "env", `SIDEBAR_RENDER_CONTROL=${controlFile}`, `SIDEBAR_RENDER_THEME=${themeID}`, `SIDEBAR_RENDER_RAW_LOG=${rawLog}`, process.execPath, path.join(root, "test/rendering-fixture.mjs"))
    await waitFor("Connected")
    await checkFrame(themeID, `${themeID} title background`)
    const rawStart = (await fs.readFile(rawLog)).length
    await update({ count: 1, working: true })
    await pause(1600)
    const animationOutput = (await fs.readFile(rawLog)).subarray(rawStart).toString()
    assert.ok(animationOutput.length > 0, "working animations still repaint")
    assert.ok(!animationOutput.includes("\x1b[2J") && !animationOutput.includes("\x1b[3J"), "animation uses incremental writes without fullscreen or scrollback clears")
    await update({ count: 1 })
    await tmux("send-keys", "-t", "rendering", "?")
    await waitFor("Theme:")
    await checkFrame(themeID, `${themeID} help background`)
    await tmux("send-keys", "-t", "rendering", "Escape")
    await waitFor("PROJECTS")
    await tmux("send-keys", "-t", "rendering", "-l", "t")
    await waitFor("Choose theme")
    const ansi = await tmux("capture-pane", "-p", "-e", "-N", "-t", "rendering")
    captures.push({ label: `${themeID} palette picker`, capture: ansi })
    const row = colorsByRow(ansi).find((cells) => cells.map((cell) => cell.char).join("").includes(getThemeScheme(themeID).name) && cells.some((cell) => cell.char === "█"))
    const theme = getThemeScheme(themeID)
    assert.deepEqual(row.filter((cell) => cell.char === "█").map((cell) => cell.background), [theme.base.background, theme.semantic.panelBg, theme.semantic.info, theme.semantic.highlight].map((color) => color.toLowerCase()), "selected palette preserves its own colors")
    assert.equal(row.map((cell) => cell.char).join("").match(/█ █ █ █/g)?.length, 1, "four palette roles are uniformly spaced")
    assert.equal(colorsByRow(ansi).filter((cells) => cells.some((cell) => cell.char === "█")).length, 8, "picker shows eight themes when height permits")
    assert.ok(ansi.includes(`Theme ${themeID === "nordic-frost" ? 1 : 8} of 14`), "header names current ordinal and total")
    if (themeID === "nordic-frost") {
      await tmux("send-keys", "-t", "rendering", "Up")
      await waitFor("Glacier Mist")
      for (const [width, height] of [[25, 24], [25, 12], [35, 24]]) {
        await resize(width, height)
        const narrow = await waitFor("Glacier Mist")
        captures.push({ label: `theme picker ${width}x${height}`, capture: narrow })
        assert.ok(narrow.includes("[Enter] Apply") && narrow.includes("[Esc] Cancel"), `picker keeps selection and controls visible at ${width}x${height}`)
        const selected = narrow.split("\n").find((line) => line.includes("█") && line.includes("Glacier Mist"))
        assert.ok(selected && selected.trimStart().startsWith(">"), "wrapped theme navigation reveals selected final option")
        assert.equal([...selected.matchAll(/█/g)].length, 4, "narrow picker preserves all four palette roles")
        assert.ok(selected.includes("█ █ █ █"), "narrow swatches preserve spacing")
        assert.ok(narrow.includes("Theme 14 of 14"), "wrapped option has current ordinal")
      }
    }
    await tmux("kill-session", "-t", "rendering")
  }
}

try {
  if (process.env.SIDEBAR_RENDER_FOCUS === "rail") {
    await update({ count: 1, sessions: 3, label: "window removal" })
    await tmux("new-session", "-d", "-s", "rendering", "-x", "52", "-y", "45", "-c", root,
      "env", `SIDEBAR_RENDER_CONTROL=${controlFile}`, process.execPath, path.join(root, "test/rendering-fixture.mjs"))
    await waitForCapture((capture) => capture.includes("Connected"))
    await railChecks()
    console.log("rendering-rail-ok")
  } else if (process.env.SIDEBAR_RENDER_FOCUS === "redraw") {
    await redrawChecks()
    console.log("rendering-redraw-ok")
  } else if (process.env.SIDEBAR_RENDER_FOCUS === "theme") {
    await themeChecks()
    console.log("rendering-theme-ok")
  } else {
  await update({ error: "Starting up" })
  const appRoot = process.env.SIDEBAR_RENDER_ROOT ?? root
  const args = [`SIDEBAR_RENDER_CONTROL=${controlFile}`, `SIDEBAR_RENDER_ROOT=${appRoot}`]
  if (process.env.SIDEBAR_RENDER_INCREMENTAL) args.push(`SIDEBAR_RENDER_INCREMENTAL=${process.env.SIDEBAR_RENDER_INCREMENTAL}`)
  await tmux("new-session", "-d", "-s", "rendering", "-x", "120", "-y", "45", "-c", root,
    "env", ...args, process.execPath, path.join(root, "test/rendering-fixture.mjs"))
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await tmux("capture-pane", "-p", "-t", "rendering")).includes("Connection issue")) break
    await pause(150)
  }
  await pause(350)
  await check("initial error", false)
  for (let i = 0; i < 5; i++) { await update({ count: 8, working: i % 2 === 0, label: `update-${i}` }); await check(`refresh-${i}`) }
  await update({ count: 1 })
  await check("list shrinks")
  await update({ error: "Long status that wraps. ".repeat(12) })
  await check("status grows")
  const failedSnapshot = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(failedSnapshot.includes("Connection issue") && !failedSnapshot.includes("Connected"), "error takes priority over retained successful snapshot")
  await update({ count: 4 })
  await check("status shrinks")
  await tmux("send-keys", "-t", "rendering", "r")
  await pause(150)
  await check("busy spinner")
  await pause(600)
  await check("spinner completes")
  const feedback = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(feedback.includes("No active session to restart"), "temporary action feedback stays visible")
  await pause(4500)
  const expiredFeedback = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(!expiredFeedback.includes("No active session to restart"), "temporary feedback expires")
  assert.ok(!expiredFeedback.includes("Preview:") && !expiredFeedback.includes("127.0.0.1") && !expiredFeedback.includes("BACKEND") && !expiredFeedback.includes("STATE LINK"), "idle status removes preview and server noise")
  await tmux("send-keys", "-t", "rendering", "e")
  await pause(1500)
  await tmux("send-keys", "-t", "rendering", "e")
  await pause(1500)
  assert.ok((await tmux("capture-pane", "-p", "-t", "rendering")).includes("Select a session to rename"), "repeated identical feedback holds from latest action")
  await pause(1300)
  await waitForCapture((capture) => !capture.includes("Select a session to rename"))
  await update({ count: 4, preview: true, label: "preview 日本語 👩‍💻 title" })
  await check("active preview")
  const previewCapture = await waitForCapture((capture) => capture.includes("Preview:"))
  assert.equal(previewCapture.split("\n").filter((line) => line.includes("Preview:")).length, 1, "active preview occupies one row")
  for (const [width, height] of [[52, 60], [35, 24], [120, 45], [25, 12], [120, 45], [12, 8], [90, 30]]) {
    await resize(width, height)
    await update({ count: 3, label: "wide title" })
    await check(`resize ${width}x${height}`, width >= 35 && height >= 24)
  }
  await resize(52, 60)
  await update({ count: 3, label: "clean list" })
  // The initial project remains selected as the fixture refreshes.
  await tmux("send-keys", "-t", "rendering", "Right")
  await pause(350)
  const expanded = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.equal(expanded.split("\n").filter((line) => line.includes("Session 0-")).length, 4, "expanded directory exposes every session")
  assert.ok(expanded.includes("Add project folder"), "add action spells out folder without shortcut prefix")
  assert.ok(!expanded.includes("|--") && !expanded.includes("PROJECT MATRIX") && !expanded.includes("FOCUS ::") && !expanded.includes("[ADD]"), "list removes redundant chrome")
  await tmux("send-keys", "-t", "rendering", "Down")
  await pause(350)
  const selectedSession = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(selectedSession.split("\n").some((line) => /^\s*>\s+[·•*><]/u.test(line) && line.includes("Session 0-")), "keyboard selects a session with stable marker")
  assert.ok(selectedSession.includes("[?] Help") && !selectedSession.includes("SHORTCUTS") && !selectedSession.includes("[Double-click]"), "browse uses compact contextual hints")
  await tmux("send-keys", "-t", "rendering", "?")
  await pause(350)
  const fullHelp = await waitForCapture((capture) => capture.includes("[Esc/?] Back"))
  captures.push({ label: "full grouped help", capture: fullHelp })
  assert.ok(fullHelp.includes("Sessions and projects") && fullHelp.includes("Toggle sidebar") && fullHelp.includes("Opt+Delete"), "full help discovers session, sidebar, and text bindings")
  assert.ok(!fullHelp.includes("PROJECTS") && fullHelp.includes("[Esc/?] Back"), "help replaces main list and exposes return")
  await tmux("send-keys", "-t", "rendering", "d")
  await pause(150)
  assert.ok(!(await tmux("capture-pane", "-p", "-t", "rendering")).includes('Delete session "'), "help blocks destructive binding")
  for (const [width, height] of [[35, 24], [25, 12]]) {
    await resize(width, height)
    const firstHelpPage = await tmux("capture-pane", "-p", "-t", "rendering")
    await tmux("send-keys", "-t", "rendering", "PageDown")
    const scrolledHelp = await waitForCapture((capture) => capture !== firstHelpPage)
    captures.push({ label: `help scroll ${width}x${height}`, capture: scrolledHelp })
    assert.notEqual(scrolledHelp, firstHelpPage, `help scrolls at ${width}x${height}`)
    assert.ok(scrolledHelp.includes("[Esc]") && scrolledHelp.includes("Scroll"), `help back hint stays visible at ${width}x${height}`)
    await tmux("send-keys", "-t", "rendering", "PageUp")
    await waitForCapture((capture) => capture === firstHelpPage)
  }
  await resize(52, 60)
  await update({ error: "Help connection error" })
  const erroredHelp = await waitForCapture((capture) => capture.includes("Error: Help connection error"))
  assert.ok(erroredHelp.includes("Error: Help connection error"), "help retains connection errors")
  await update({ count: 3, label: "clean list" })
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(350)
  const returnedSelection = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(returnedSelection.split("\n").some((line) => /^\s*>\s+[·•*><]/u.test(line) && line.includes("Session 0-")), "help preserves selection")
  await tmux("send-keys", "-t", "rendering", "e")
  await pause(200)
  await tmux("send-keys", "-t", "rendering", "-l", "?")
  await pause(200)
  const renameQuestion = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(renameQuestion.includes("Rename session") && renameQuestion.includes("clean list?") && !renameQuestion.includes("[?] Help"), "question mark stays literal in rename input without browse hints")
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(200)
  await tmux("send-keys", "-t", "rendering", "?")
  await pause(200)
  await tmux("send-keys", "-t", "rendering", "?")
  await pause(200)
  assert.ok((await tmux("capture-pane", "-p", "-t", "rendering")).includes("PROJECTS"), "question mark toggles help back")
  const selectedAnsi = await tmux("capture-pane", "-p", "-e", "-t", "rendering")
  captures.push({ label: "selected session ANSI", capture: selectedAnsi })
  const selectedAnsiRow = selectedAnsi.split("\n").find((line) => line.includes("Session 0-") && line.replace(/\x1b\[[0-9;]*m/g, "").trimStart().startsWith(">"))
  assert.ok(selectedAnsiRow && /\x1b\[[0-9;]*(?:48;|4[0-7])/.test(selectedAnsiRow), "selected session paints background")
  const highlightThroughAge = selectedAnsiRow.slice(0, selectedAnsiRow.lastIndexOf("now") + 3)
  const backgroundChanges = [...highlightThroughAge.matchAll(/\x1b\[(?:48;[0-9;]+|4[0-9]|0)m/g)]
  assert.equal(backgroundChanges.length, 1, "selection background remains continuous through gutter, title padding, and age")
  assert.ok(backgroundChanges[0].index < highlightThroughAge.indexOf(">"), "selection background starts before gutter marker")
  await tmux("send-keys", "-t", "rendering", "Up")
  await pause(150)
  await tmux("send-keys", "-t", "rendering", "Left")
  await pause(350)
  const collapsed = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(!collapsed.includes("Session 0-"), "keyboard collapses directory")
  await tmux("send-keys", "-t", "rendering", "Right")
  await pause(350)
  await check("keyboard expands directory")
  await tmux("send-keys", "-t", "rendering", "/")
  await pause(200)
  await tmux("send-keys", "-t", "rendering", "-l", "Session 0-2")
  await pause(350)
  const searched = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(searched.includes("Session 0-2") && !searched.includes("Session 0-1 clean list"), "search filters session list")
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(350)
  await check("search closes")
  await tmux("send-keys", "-t", "rendering", "-l", "?")
  await pause(200)
  const searchQuestion = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(searchQuestion.includes("/ ?") && !searchQuestion.includes("Navigate"), "question mark stays literal in search")
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(150)
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(150)
  await tmux("send-keys", "-t", "rendering", "a")
  await pause(200)
  await tmux("send-keys", "-t", "rendering", "-l", "?")
  await pause(200)
  const addQuestion = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(addQuestion.includes("Path :: ?") && !addQuestion.includes("[?] Help"), `add input keeps literal question mark and contextual hints\n${addQuestion}`)
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(200)
  for (const width of [25, 35, 52]) {
    await resize(width, 60)
    await update({ count: 1, label: "日本語 👩‍💻 長い名前の検証" })
    const unicodeCapture = await tmux("capture-pane", "-p", "-t", "rendering")
    captures.push({ label: `Unicode list ${width}x60`, capture: unicodeCapture })
    const sessionRows = unicodeCapture.split("\n").filter((line) => line.includes("Session 0-"))
    assert.equal(sessionRows.length, 4, `Unicode titles stay on four rows at ${width} columns`)
    assert.ok(sessionRows.every((line) => line.trimEnd().endsWith("now")), `Unicode titles preserve age column at ${width} columns`)
  }
  await resize(52, 60)
  await update({ count: 3, label: "clean list" })
  await tmux("send-keys", "-t", "rendering", "-l", "t")
  await pause(350)
  await check("theme modal", false)
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(350)
  await check("modal closes")
  await update({ count: 3, idle: true })
  await check("animations stop")
  for (const [width, height] of [[35, 24], [120, 45], [90, 30], [120, 45]]) {
    await resize(width, height)
    await check(`idle resize ${width}x${height}`)
  }
  await resize(52, 60)
  await update({ count: 2, sessions: 9, label: "window coverage" })
  await tmux("send-keys", "-t", "rendering", "Right")
  await pause(350)
  const sessionIDs = (capture, project) => [...capture.matchAll(new RegExp(`[·•*oO0>] Session ${project}-(\\d+)`, "g"))].map((match) => Number(match[1]))
  let windows = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.deepEqual(sessionIDs(windows, 0), [0, 1, 2, 3, 4], "initial project shows first five sessions")
  assert.ok(windows.includes("... 4 more"), "overflow below is explicit")
  for (let index = 0; index < 7; index++) {
    await tmux("send-keys", "-t", "rendering", "Down")
    await pause(450)
  }
  windows = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.deepEqual(sessionIDs(windows, 0), [2, 3, 4, 5, 6], "keyboard reveals seventh session through logical list")
  assert.ok(windows.includes("... 2 above") && windows.includes("... 2 more"), "both overflow directions appear")
  const sendMouse = async (code, x, y, release = false) => tmux("send-keys", "-t", "rendering", "-l", `\x1b[<${code};${x};${y}${release ? "m" : "M"}`)
  const directoryY = windows.split("\n").findIndex((line) => line.includes("render-project-1") && line.includes("›")) + 1
  await sendMouse(0, 4, directoryY)
  await pause(100)
  await sendMouse(0, 4, directoryY, true)
  await pause(350)
  windows = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.deepEqual(sessionIDs(windows, 1), [0, 1, 2, 3, 4], "mouse expands second project using decorative-row coordinates")
  const wheelY = windows.split("\n").findIndex((line) => line.includes("Session 1-0")) + 1
  await tmux("send-keys", "-t", "rendering", "-l", `\x1b[<65;8;${wheelY}M`.repeat(6))
  await pause(350)
  windows = await tmux("capture-pane", "-p", "-t", "rendering")
  captures.push({ label: "independent five-session windows", capture: windows })
  assert.deepEqual(sessionIDs(windows, 1), [4, 5, 6, 7, 8], "batched wheel events clamp to second project's final five")
  assert.deepEqual(sessionIDs(windows, 0), [2, 3, 4, 5, 6], "hovered wheel preserves other project window and selection")
  for (let index = 0; index < 3; index++) { await tmux("send-keys", "-t", "rendering", "Down"); await pause(450) }
  windows = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.ok(windows.split("\n").some((line) => /^\s*> ⌄ render-project-1/u.test(line)), "keyboard crosses project boundary after final session")
  for (const width of [35, 25, 52]) {
    await resize(width, 40)
    windows = await tmux("capture-pane", "-p", "-t", "rendering")
    assert.ok(sessionIDs(windows, 0).length <= 5 && sessionIDs(windows, 1).length <= 5, "resize keeps project display cap")
  }
  await resize(52, 60)
  await update({ count: 1, sessions: 3, label: "window removal" })
  windows = await tmux("capture-pane", "-p", "-t", "rendering")
  assert.deepEqual(sessionIDs(windows, 0), [0, 1, 2], "session/project removal clamps window and selection")
  assert.ok(!windows.includes("..."), "removed overflow disappears")
  await tmux("send-keys", "-t", "rendering", "Left")
  await pause(350)
  assert.equal(sessionIDs(await tmux("capture-pane", "-p", "-t", "rendering"), 0).length, 0, "collapse hides projected sessions")
  await tmux("send-keys", "-t", "rendering", "Right")
  await pause(350)
  await tmux("send-keys", "-t", "rendering", "/")
  await pause(200)
  await tmux("send-keys", "-t", "rendering", "-l", "Session 0-2")
  await pause(350)
  assert.deepEqual(sessionIDs(await tmux("capture-pane", "-p", "-t", "rendering"), 0), [2], "search filters window before applying cap")
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(150)
  await tmux("send-keys", "-t", "rendering", "Escape")
  await pause(200)
  await railChecks()
  console.log("rendering-tmux-ok")
  }
} finally {
  await fs.writeFile(path.join(root, "test/rendering-captures.json"), JSON.stringify(captures, null, 2))
  await tmux("kill-server").catch(() => {})
  await fs.rm(temp, { recursive: true, force: true })
}
