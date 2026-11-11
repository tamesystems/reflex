import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { connectSocket } from "./socket.ts"
import { sessionEndpoint } from "./session-endpoint.ts"
import { checkSecretAcl } from "./windows-security.ts"
export const readTargetSecret = (
  directory: string,
  target: "headless" | "device",
): string | undefined => {
  if (process.platform !== "win32") {
    return undefined
  }
  const path = resolve(directory, `${target === "device" ? "device" : "session"}.auth`)
  checkSecretAcl(directory)
  checkSecretAcl(path)
  const secret = readFileSync(path, "utf8")
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("Invalid local session secret")
  }
  return secret
}
/** The same authenticated local endpoint used by the CLI, including the device bridge. */
export const connectTarget = (
  target: "headless" | "device",
  directory = process.env.REFLEX_DIR ?? ".reflex",
) => {
  if (directory === "") {
    throw new Error("REFLEX_DIR must not be empty")
  }
  return connectSocket(
    sessionEndpoint(directory, target),
    undefined,
    readTargetSecret(directory, target),
  )
}
