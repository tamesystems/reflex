/**
 * The live bridge's acceptance check. Starts a bridge with the real CLI, runs the app in
 * development under Metro with the bridge's setting, opens it in Chrome, and has the
 * journey drive it with CLI commands and the same commands against a headless session.
 * Also builds the app both ways with the same setting, and checks that only the
 * development build holds the bridge and its token.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseBridgeSetting } from "@reflex/protocol"

/** Text only the app's side of the bridge holds: its protocol is in every build. */
const DIALLER_MARKER = "The Reflex bridge refused this app"

const BUILD_TIMEOUT_MS = 240_000
const JOURNEY_TIMEOUT_MS = 270_000
const CLI = resolve(import.meta.dirname, "../../../packages/cli/src/cli.ts")

const work = mkdtempSync(join(tmpdir(), "reflex-live-"))
const reflexDirectory = join(work, "reflex")
const devExport = join(work, "dev")
const productionExport = join(work, "production")

const reflex = (...args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, REFLEX_DIR: reflexDirectory },
    encoding: "utf8",
  })

const build = (outputDirectory: string, setting: string, dev: boolean): boolean => {
  const built = Bun.spawnSync(
    [
      "bunx",
      "expo",
      "export",
      "--platform",
      "web",
      "--output-dir",
      outputDirectory,
      ...(dev ? ["--dev"] : []),
    ],
    {
      env: { ...process.env, EXPO_PUBLIC_REFLEX_BRIDGE: setting },
      stdout: "ignore",
      stderr: "inherit",
      timeout: BUILD_TIMEOUT_MS,
    },
  )
  return built.success
}

/** Every JavaScript file an export holds, as one string. */
const bundleText = (directory: string): string =>
  readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n")

/** Metro, as `expo start` runs it in development: what an app under development talks to. */
const startMetro = async (port: number, setting: string) => {
  const metro = Bun.spawn(["bunx", "expo", "start", "--web", "--port", String(port)], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, CI: "1", EXPO_PUBLIC_REFLEX_BRIDGE: setting },
    stdout: "ignore",
    stderr: "inherit",
  })
  const deadline = Date.now() + BUILD_TIMEOUT_MS
  while (Date.now() < deadline && metro.exitCode === null) {
    const answered = await fetch(`http://localhost:${port}/`).then(
      (response) => response.ok,
      () => false,
    )
    if (answered) {
      return metro
    }
    await Bun.sleep(250)
  }
  metro.kill()
  throw new Error("Metro did not start")
}

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port ?? 0
  probe.stop(true)
  return port
}

const check = (ok: boolean, label: string): boolean => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`)
  return ok
}

const run = async (): Promise<number> => {
  const started = reflex("--target", "device", "start", "--port", String(freePort()))
  if (started.status !== 0) {
    console.error(started.stderr)
    return 1
  }
  const { appSetting } = JSON.parse(started.stdout) as { readonly appSetting: string }
  try {
    if (!build(productionExport, appSetting, false) || !build(devExport, appSetting, true)) {
      return 1
    }
    const { token } = parseBridgeSetting(appSetting)
    const production = bundleText(productionExport)
    const development = bundleText(devExport)
    const excluded = check(
      !production.includes(DIALLER_MARKER),
      "a production build leaves the bridge out, even with its setting given",
    )
    const tokenless = check(!production.includes(token), "a production build holds no token")
    const included = check(
      development.includes(DIALLER_MARKER) && development.includes(token),
      "a development build with the setting has the bridge",
    )
    if (!excluded || !tokenless || !included) {
      return 1
    }
    const metroPort = freePort()
    const metro = await startMetro(metroPort, appSetting)
    try {
      const journey = Bun.spawn(["node", join(import.meta.dirname, "live-journey.ts")], {
        env: {
          ...process.env,
          PORT: String(metroPort),
          REFLEX_DIR: reflexDirectory,
          REFLEX_CLI: CLI,
          BUN: process.execPath,
        },
        stdout: "inherit",
        stderr: "inherit",
        timeout: JOURNEY_TIMEOUT_MS,
      })
      const exitCode = await journey.exited
      return journey.signalCode === null ? exitCode : 1
    } finally {
      metro.kill()
      await metro.exited
    }
  } finally {
    reflex("--target", "device", "stop")
    reflex("stop")
  }
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error: unknown) => {
    console.error(String(error).slice(0, 500))
    process.exitCode = 1
  })
  .finally(() => rmSync(work, { recursive: true, force: true }))
