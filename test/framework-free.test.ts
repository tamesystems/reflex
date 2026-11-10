/** Real CLI and app processes, with the bridge daemon outside bun test. */
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("a framework-free process serves inspect, dispatch, wait and reset through the CLI", async () => {
  const root = resolve(import.meta.dirname, "..")
  const directory = mkdtempSync(join(tmpdir(), "reflex-framework-free-"))
  const env = { ...process.env, REFLEX_DIR: directory }
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, join(root, "packages/cli/src/cli.ts"), "--target", "device", ...args],
      { cwd: root, env, timeout: 30_000 },
    )
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString())
    }
    return JSON.parse(result.stdout.toString())
  }
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  let app: ReturnType<typeof Bun.spawn> | undefined
  try {
    const started = cli("start", "--port", String(port))
    app = Bun.spawn([process.execPath, join(root, "examples/live-counter/src/serve.ts")], {
      cwd: root,
      env: { ...env, REFLEX_BRIDGE: started.appSetting },
      stdout: "ignore",
      stderr: "inherit",
    })
    const before = cli("tree").nodes[0]
    expect(cli("ls", "--schema")).toMatchObject({ name: null, actions: [{ name: "Increment" }] })
    expect(before).toMatchObject({ name: "Counter", state: { count: 0 } })
    expect(cli("do", "Increment")).toMatchObject({ operation: { status: "completed" } })
    expect(cli("wait", JSON.stringify({ name: "Counter", match: { count: 1 } }))).toBeDefined()
    cli("reset")
    const after = cli("tree").nodes[0]
    expect(after).toMatchObject({ name: "Counter", state: { count: 0 } })
    expect(after.id).not.toBe(before.id)
  } finally {
    app?.kill()
    if (app) {
      await app.exited
    }
    try {
      cli("stop")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}, 120_000)
