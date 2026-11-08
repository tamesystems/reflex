/** Reuse the real CLI/browser journey and Metro bundle checks with an isolated entry. */
import { fileURLToPath } from "node:url"
const child = Bun.spawn(
  [process.execPath, fileURLToPath(new URL("./live-run.ts", import.meta.url).href)],
  {
    env: { ...process.env, REFLEX_PLAIN: "1" },
    stdout: "inherit",
    stderr: "inherit",
  },
)
process.exitCode = await child.exited
