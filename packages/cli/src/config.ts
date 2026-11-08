import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { BRIDGE_APP_WAIT_MS, SESSION_START_TIMEOUT_MS_MAX } from "@reflex/protocol"
export { SESSION_LOG_BYTES_MAX } from "@reflex/protocol"

export const START_TIMEOUT_MS_DEFAULT = 10_000
export const SHUTDOWN_REPLY_TIMEOUT_MS_DEFAULT = 5_000
const TIMEOUT_MS_MAX = SESSION_START_TIMEOUT_MS_MAX

/** A headless session runs the app itself; a device session bridges to one running elsewhere. */
export type Target = "headless" | "device"

export interface Config {
  readonly target: Target
  readonly directory: string
  readonly socketPath: string
  readonly authPath: string
  readonly lockPath: string
  readonly reclaimPath: string
  readonly logPath: string
  /** The device bridge's token, kept so that an app configured once stays configured. */
  readonly tokenPath: string
  readonly startTimeoutMs: number
  /** How long a device session holds a request for an app to connect. */
  readonly appWaitMs: number
  readonly shutdownReplyTimeoutMs: number
}

const parseTarget = (value: string | undefined): Target => {
  if (value === undefined || value === "headless") {
    return "headless"
  }
  if (value === "device") {
    return "device"
  }
  throw new Error(`The target must be "headless" or "device", not "${value.slice(0, 64)}"`)
}

/**
 * The environment is read here, once, and nowhere else. `--target` wins over
 * `REFLEX_TARGET`. Each target has its own files, so both can run at once.
 */
export const loadConfig = (
  environment: NodeJS.ProcessEnv,
  targetFlag: string | undefined = undefined,
): Config => {
  if (environment.REFLEX_DIR === "") {
    throw new Error("REFLEX_DIR must not be empty")
  }
  const target = parseTarget(targetFlag ?? environment.REFLEX_TARGET)
  const directory = resolve(environment.REFLEX_DIR ?? ".reflex")
  const base = target === "device" ? "device" : "session"
  return {
    target,
    directory,
    socketPath: sessionEndpoint(directory, target),
    authPath: resolve(directory, `${base}.auth`),
    lockPath: resolve(directory, `${base}.lock`),
    reclaimPath: resolve(directory, `${base}.reclaim`),
    logPath: resolve(directory, `${base}.log`),
    tokenPath: resolve(directory, "device.token"),
    appWaitMs: parseTimeoutMs({
      name: "REFLEX_APP_WAIT_MS",
      value: environment.REFLEX_APP_WAIT_MS,
      defaultMs: BRIDGE_APP_WAIT_MS,
    }),
    startTimeoutMs: parseTimeoutMs({
      name: "REFLEX_START_TIMEOUT_MS",
      value: environment.REFLEX_START_TIMEOUT_MS,
      defaultMs: START_TIMEOUT_MS_DEFAULT,
    }),
    shutdownReplyTimeoutMs: parseTimeoutMs({
      name: "REFLEX_SHUTDOWN_TIMEOUT_MS",
      value: environment.REFLEX_SHUTDOWN_TIMEOUT_MS,
      defaultMs: SHUTDOWN_REPLY_TIMEOUT_MS_DEFAULT,
    }),
  }
}

const parseTimeoutMs = ({
  name,
  value,
  defaultMs,
}: {
  readonly name: string
  readonly value: string | undefined
  readonly defaultMs: number
}): number => {
  if (value === undefined) {
    return defaultMs
  }
  const refusal = `${name} must be an integer from 1 to ${TIMEOUT_MS_MAX}`
  if (!/^\d+$/.test(value)) {
    throw new Error(refusal)
  }
  const timeoutMs = Number(value)
  if (timeoutMs < 1) {
    throw new Error(refusal)
  }
  if (timeoutMs > TIMEOUT_MS_MAX) {
    throw new Error(refusal)
  }
  return timeoutMs
}

/** How to stop the session a config names, for messages that suggest it. */
export const stopCommand = (config: Config): string =>
  config.target === "device" ? "reflex --target device stop" : "reflex stop"

/** Pipes are kernel objects, never files. Hash the entire resolved directory and target. */
export const sessionEndpoint = (
  directory: string,
  target: Target,
  platform: NodeJS.Platform = process.platform,
): string =>
  platform === "win32"
    ? `\\\\.\\pipe\\reflex-${createHash("sha256")
        .update(`${resolve(directory).toLowerCase()}\0${target}`)
        .digest("hex")}`
    : resolve(directory, `${target === "device" ? "device" : "session"}.sock`)
