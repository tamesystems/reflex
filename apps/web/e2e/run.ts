/** Daemon is a separate process: never host bridge WebSockets inside bun test. */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseBridgeSetting } from "@reflex/protocol"

const directory = resolve(import.meta.dirname, "..")
const cli = resolve(directory, "../../packages/cli/src/cli.ts")
const work = mkdtempSync(join(tmpdir(), "reflex-web-"))
const env = { ...process.env, REFLEX_DIR: join(work, "reflex") }
const reflex = (...args: string[]) =>
  spawnSync(process.execPath, [cli, "--target", "device", ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  })
const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  return port
}
const bundles = (path: string): string =>
  readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(path, file), "utf8"))
    .join("\n")
/** Source maps prove exclusion of modules, independently of minified text markers. */
const checkGraph = (directory: string) => {
  const sources = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".map"))
    .flatMap(
      (file) =>
        (JSON.parse(readFileSync(join(directory, file), "utf8")) as { sources: string[] }).sources,
    )
    .map((source) => source.replaceAll("\\", "/"))
  if (
    !sources.some((source) => source.includes("runtime/src/store-node")) ||
    !sources.some((source) => source.includes("react-router/")) ||
    sources.some((source) =>
      /live\/src\/bridge\.ts$|(?:node_modules|packages)\/(?:effect|expo|react-native)\//.test(
        source,
      ),
    )
  ) {
    throw new Error("Production module graph violates web boundaries")
  }
  console.log(
    "ok   production graph includes store/router, excludes bridge, Effect and native frameworks",
  )
}
const run = async () => {
  const started = reflex("start", "--port", String(freePort()))
  if (started.status !== 0) {
    throw new Error(started.stderr)
  }
  const { appSetting } = JSON.parse(started.stdout) as { appSetting: string }
  const appEnv = { ...env, VITE_REFLEX_BRIDGE: appSetting }
  const production = join(work, "production")
  const built = Bun.spawnSync(["bun", "run", "build", "--outDir", production], {
    cwd: directory,
    env: appEnv,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 120_000,
  })
  if (!built.success) {
    throw new Error("Production build failed")
  }
  checkGraph(production)
  const text = bundles(production)
  if (
    text.includes(parseBridgeSetting(appSetting).token) ||
    text.includes("The Reflex bridge refused this app")
  ) {
    throw new Error("Production contains bridge/token")
  }
  console.log("ok   production contains neither bridge nor token")
  const port = freePort()
  const vite = Bun.spawn(["bun", "run", "dev", "--port", String(port), "--strictPort"], {
    cwd: directory,
    env: appEnv,
    stdout: "ignore",
    stderr: "inherit",
  })
  try {
    await ready(`http://127.0.0.1:${port}`, vite)
    const journey = Bun.spawn(["node", join(import.meta.dirname, "journey.ts")], {
      env: { ...env, PORT: String(port), REFLEX_CLI: cli, BUN: process.execPath },
      stdout: "inherit",
      stderr: "inherit",
      timeout: 150_000,
    })
    if ((await journey.exited) !== 0) {
      throw new Error("Web journey failed")
    }
  } finally {
    vite.kill()
    await vite.exited
  }
}
const ready = async (url: string, process: ReturnType<typeof Bun.spawn>) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && process.exitCode === null) {
    if (
      await fetch(url).then(
        (response) => response.ok,
        () => false,
      )
    ) {
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Vite did not start")
}
try {
  await run()
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  reflex("stop")
  rmSync(work, { recursive: true, force: true })
}
