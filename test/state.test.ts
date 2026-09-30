import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("state isolates defaults, preserves valid fields and serializes concurrent updates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidebar-state-"))
  try {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import fs from "node:fs/promises";
      import { loadState, loadStateSync, updateState } from "./src/lib/state.ts";
      const first = await loadState(); first.pinnedDirectories.push("/leaked");
      assert.deepEqual(loadStateSync().pinnedDirectories, []);
      await fs.writeFile(process.env.OPENCODE_SIDEBAR_DIR + "/state.json", JSON.stringify({serverPort: -4, pinnedDirectories: false, hiddenDirectories: ["/hidden", 4, "/hidden"], themeID: "custom"}));
      assert.deepEqual(await loadState(), {serverPort: 42112, pinnedDirectories: [], hiddenDirectories: ["/hidden"], themeID: "custom"});
      await Promise.all([
        updateState(async state => { await new Promise(resolve => setTimeout(resolve, 30)); return {...state, pinnedDirectories: ["/pin"]}; }),
        updateState(state => ({...state, themeID: "changed"})),
      ]);
      assert.deepEqual((await loadState()).pinnedDirectories, ["/pin"]);
      assert.equal((await loadState()).themeID, "changed");
      await updateState(() => { throw new Error("failed update"); }).catch(() => {});
      await updateState(state => ({...state, serverPort: 1234}));
      assert.equal((await loadState()).serverPort, 1234);
    `], { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env, OPENCODE_SIDEBAR_DIR: directory }, stdout: "pipe", stderr: "pipe" })
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
