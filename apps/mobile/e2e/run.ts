/** Exports the web build, serves it on a private port, and runs the journey. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

const BUILD_TIMEOUT_MS = 180_000
/** Longer than the journey's own deadline, which is the one that should fire. */
const JOURNEY_TIMEOUT_MS = 150_000

const exportDirectory = mkdtempSync(join(tmpdir(), "reflex-e2e-"))

/** Single-page routing: anything that is not a file is the app. */
const serveExport = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url)
  const target = resolve(exportDirectory, `.${decodeURIComponent(pathname)}`)
  if (target.startsWith(exportDirectory + sep)) {
    const file = Bun.file(target)
    if (await file.exists()) {
      return new Response(file)
    }
  }
  return new Response(Bun.file(join(exportDirectory, "index.html")), {
    headers: { "content-type": "text/html" },
  })
}

const run = async (): Promise<number> => {
  const built = Bun.spawnSync(
    ["bunx", "expo", "export", "--platform", "web", "--output-dir", exportDirectory],
    {
      env: { ...process.env, REFLEX_E2E: "1" },
      stdout: "ignore",
      stderr: "inherit",
      timeout: BUILD_TIMEOUT_MS,
    },
  )
  // A build killed by its timeout has no exit code, and must not read as a success.
  if (!built.success) {
    return 1
  }
  // Port 0: a fixed port could silently test whatever else is already listening.
  const server = Bun.serve({ port: 0, fetch: serveExport })
  try {
    // Under Node, because Playwright is not supported on Bun.
    const journey = Bun.spawn(["node", join(import.meta.dirname, "journey.ts")], {
      env: { ...process.env, PORT: String(server.port) },
      stdout: "inherit",
      stderr: "inherit",
      timeout: JOURNEY_TIMEOUT_MS,
    })
    const exitCode = await journey.exited
    return journey.signalCode === null ? exitCode : 1
  } finally {
    await server.stop(true)
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
  .finally(() => rmSync(exportDirectory, { recursive: true, force: true }))
