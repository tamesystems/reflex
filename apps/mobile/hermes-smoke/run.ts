/**
 * Builds the smoke bundle with Metro and runs it on a Hermes VM.
 * Usage: HERMES=/path/to/hermes bun run hermes-smoke
 * The VM comes from https://github.com/facebook/hermes/releases (hermes-cli-*).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const VERDICT = "HERMES SMOKE PASSED"
const BUILD_TIMEOUT_MS = 180_000
const VM_TIMEOUT_MS = 60_000
/** The journey prints a line per check; anything like this much is a runaway. */
const VM_OUTPUT_BYTES_MAX = 1024 * 1024

const hermes = process.env.HERMES
if (hermes === undefined || hermes === "") {
  throw new Error("Set HERMES to the path of a Hermes VM")
}

const directory = mkdtempSync(join(tmpdir(), "reflex-hermes-"))
const bundle = join(directory, "smoke.js")

const step = (command: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync([...command], {
    stdout: "ignore",
    stderr: "inherit",
    timeout: BUILD_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed`)
  }
}

try {
  step([
    "bunx",
    "expo",
    "export:embed",
    "--config",
    "hermes-smoke/metro.config.js",
    "--entry-file",
    "hermes-smoke/smoke.ts",
    "--platform",
    "ios",
    "--dev",
    "false",
    "--minify",
    "false",
    "--reset-cache",
    "--bundle-output",
    bundle,
  ])
  // Under Node, because Babel's plugins are resolved through `require`.
  step(["node", "hermes-smoke/lower.cjs", bundle])
  const vm = Bun.spawnSync([hermes, "-w", "-Xes6-promise", "-Xmicrotask-queue", bundle], {
    timeout: VM_TIMEOUT_MS,
    maxBuffer: VM_OUTPUT_BYTES_MAX,
  })
  const output = vm.stdout.toString().trim()
  console.log(output)
  // The VM exits 0 whatever the script does, so success must be a printed verdict.
  if (output.split("\n").at(-1) !== VERDICT) {
    console.error(vm.stderr.toString().slice(0, 2_000))
    process.exitCode = 1
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
