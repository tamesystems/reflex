import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
/** Pipes are kernel objects, never files. Hash the entire resolved directory and target. */
export const sessionEndpoint = (
  directory: string,
  target: "headless" | "device",
  platform: NodeJS.Platform = process.platform,
): string =>
  platform === "win32"
    ? `\\\\.\\pipe\\reflex-${createHash("sha256")
        .update(`${canonicalDirectory(resolve(directory))}\0${target}`)
        .digest("hex")}`
    : resolve(directory, `${target === "device" ? "device" : "session"}.sock`)

/** Resolve existing ancestors too, so the name is stable before and after directory creation. */
const canonicalDirectory = (directory: string): string => {
  if (existsSync(directory)) {
    return realpathSync.native(directory)
  }
  const parent = dirname(directory)
  return parent === directory ? directory : resolve(canonicalDirectory(parent), basename(directory))
}
