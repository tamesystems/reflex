import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import {
  LOCAL_AUTH_SECRET_BYTES,
  boundedText,
  type DescribeResult,
  scenarioDescriptor,
  SESSION_LOG_BYTES_MAX,
  SESSION_LOG_DRAIN_TIMEOUT_MS,
  SESSION_LOG_FAILURE_RESERVE_BYTES,
  LOG_LINE_CHARACTERS_MAX,
} from "@reflex/protocol"
import { networkInterfaces } from "node:os"
import { formatBridgeSetting } from "@reflex/protocol"
import {
  type Client,
  connectSocket,
  createBridgeController,
  serveSocket,
  serveStdio,
} from "@reflex/rpc"
import {
  type AppHost,
  APP_HOST_ADAPTER,
  type Controller,
  createController,
  reportToConsole,
} from "@reflex/runtime/internal"
import { type BridgeServer, loadOrCreateToken, serveBridge } from "./bridge-server.ts"
import { type Config, stopCommand } from "./config.ts"
import {
  acquireLock,
  clearLeftovers,
  hasCode,
  isAlive,
  lockOwner,
  logPathOf,
  releaseLock,
} from "./session-lock.ts"

import { checkSecretAcl, preparePrivateDirectory } from "./windows-security.ts"
const SHUTDOWN_COMPLETE_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 25
/** Kept back in the log, so that a noisy app cannot crowd out why it failed. */
const FAILURE_RESERVE_BYTES = SESSION_LOG_FAILURE_RESERVE_BYTES
/** Enough to find why a start failed, which is the last thing it logs. */
const STARTUP_FAILURE_BYTES_MAX = 4096
/** How a daemon marks the reason it failed, among whatever else its app logged. */
const FAILURE_PREFIX = "error: "

/** `daemon` is a socket session with no terminal, so it keeps its own log. */
export type Transport = "socket" | "stdio" | "daemon"

/** A headless session runs an app module; a device session bridges to an app elsewhere. */
export type ServeOptions =
  | {
      readonly kind: "app"
      readonly module: string
      readonly scenario: string | undefined
      readonly transport: Transport
    }
  | {
      readonly kind: "bridge"
      readonly hostname: string
      readonly port: number
      readonly transport: Transport
    }

/** What `start` reports about a bridge: where it listens, and what an app needs to dial it. */
export interface BridgeDescription {
  readonly target: "device"
  readonly listening: string
  /** For `EXPO_PUBLIC_REFLEX_BRIDGE`. */
  readonly appSetting: string
  /** The same, as an Android emulator reaches this machine. */
  readonly androidEmulatorSetting?: string
  readonly tokenFile: string
}

export const connectToSession = async (config: Config): Promise<Client> => {
  if (!existsSync(process.platform === "win32" ? config.authPath : config.socketPath)) {
    const how =
      config.target === "device" ? "reflex --target device start" : "reflex start <app-module>"
    throw new Error(`No session running. Start one with: ${how}`)
  }
  try {
    return await connectSocket(config.socketPath, undefined, readLocalSecret(config))
  } catch (error: unknown) {
    const reason = boundedText(String(error))
    throw new Error(`Session is not responding (${reason}). Remove it with: ${stopCommand(config)}`)
  }
}

export const serve = async (config: Config, options: ServeOptions): Promise<void> => {
  if (options.transport === "stdio") {
    await serveOverStdio(config, options)
  } else {
    await serveOverSocket(config, options)
  }
}

const serveOverStdio = async (config: Config, options: ServeOptions): Promise<void> => {
  let writable = true
  process.stderr.on("error", () => {
    writable = false
  })
  const log = boundedLogWriter((line) => {
    // At most the lifetime byte budget queues here, even if stderr is never read.
    if (writable) {
      process.stderr.write(line)
    }
  })
  redirectConsole(log.write)
  let exitCode = 0
  try {
    const controller = await startController(config, options)
    await serveStdio(controller)
    await controller.close()
  } catch (error: unknown) {
    log.writeFailure(`${FAILURE_PREFIX}${failureMessage(error)}`)
    exitCode = 1
  }
  await drainStderr()
  // The app may hold handles open, and with stdin gone this session has no peer.
  process.exit(exitCode)
}

/** Flush available log output without waiting forever on a peer's stderr reader. */
const drainStderr = (): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, SESSION_LOG_DRAIN_TIMEOUT_MS)
    process.stderr.write("", () => {
      clearTimeout(timer)
      resolve()
    })
  })

const serveOverSocket = async (config: Config, options: ServeOptions): Promise<void> => {
  preparePrivateDirectory(config)
  const logPath = logPathOf(config, process.pid)
  const log = options.transport === "daemon" ? boundedLog(logPath) : null
  if (log !== null) {
    redirectConsole(log.write)
    logCrashes(config, log)
  }
  let exitCode = 0
  try {
    acquireLock(config, Date.now())
    if (process.platform === "win32") {
      if (!existsSync(config.authPath)) {
        writeFileSync(config.authPath, "", { flag: "wx", mode: 0o600 })
      }
      checkSecretAcl(config.authPath)
      writeFileSync(config.authPath, randomBytes(LOCAL_AUTH_SECRET_BYTES).toString("hex"), {
        mode: 0o600,
      })
      checkSecretAcl(config.authPath)
    }
    await serveUntilShutdown(config, await startController(config, options))
    // Only after a clean run: a failed start's log is how `start` learns the reason.
    rmSync(logPath, { force: true })
  } catch (error: unknown) {
    const line = `${FAILURE_PREFIX}${failureMessage(error)}`
    if (log === null) {
      console.error(line)
    } else {
      log.writeFailure(line)
    }
    exitCode = 1
  } finally {
    releaseLock(config)
  }
  // Open connections and app handles must not keep a stopped session alive.
  process.exit(exitCode)
}

/** Nobody is watching a daemon, so what kills it has to reach its log. */
const logCrashes = (config: Config, log: { writeFailure(line: string): void }): void => {
  const crash = (error: unknown): void => {
    log.writeFailure(`${FAILURE_PREFIX}${failureMessage(error)}`)
    releaseLock(config)
    process.exit(1)
  }
  process.on("uncaughtException", crash)
  process.on("unhandledRejection", crash)
}

const failureMessage = (error: unknown): string =>
  boundedText(error instanceof Error ? error.message : String(error))

/**
 * Apps log through `console`, so that is what has to be replaced. A session
 * speaking on stdout, or with no terminal, cannot let them write to stdout.
 */
const redirectConsole = (write: (...values: ReadonlyArray<unknown>) => void): void => {
  console.log = write
  console.info = write
  console.debug = write
  console.warn = write
  console.error = write
}

/**
 * A summary, chosen so that its cost does not depend on the value: rendering an
 * arbitrary object would run its code, and take as long and as much as it likes.
 */
const logText = (value: unknown): string => {
  if (typeof value === "string") {
    return value.slice(0, LOG_LINE_CHARACTERS_MAX)
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`.slice(0, LOG_LINE_CHARACTERS_MAX)
  }
  if (typeof value === "object" && value !== null) {
    return Object.prototype.toString.call(value)
  }
  return String(value)
}

/** One lifetime byte budget for either a log file or stderr. */
const boundedLogWriter = (writeLine: (line: string) => void) => {
  let bytesWritten = 0
  let truncated = false
  const notice = "Session log truncated\n"
  const budgetBytes = SESSION_LOG_BYTES_MAX - FAILURE_RESERVE_BYTES - Buffer.byteLength(notice)
  return {
    write: (...values: ReadonlyArray<unknown>): void => {
      if (truncated) {
        return
      }
      // Stop reading arguments once the line is full; even a single call can be huge.
      let text = ""
      for (const value of values) {
        if (text.length >= LOG_LINE_CHARACTERS_MAX) {
          break
        }
        text += `${text.length === 0 ? "" : " "}${logText(value)}`
      }
      const line = `${text.slice(0, LOG_LINE_CHARACTERS_MAX)}\n`
      const lineBytes = Buffer.byteLength(line)
      if (bytesWritten + lineBytes > budgetBytes) {
        truncated = true
        writeLine(notice)
        return
      }
      bytesWritten += lineBytes
      writeLine(line)
    },
    writeFailure: (line: string): void => {
      writeLine(`${line.slice(0, FAILURE_RESERVE_BYTES / 4)}\n`)
    },
  }
}

/** The daemon and stdio transports share formatting, limits and failure reserve. */
const boundedLog = (path: string) => {
  const file = openSync(path, "a", 0o600)
  return boundedLogWriter((line) => {
    writeSync(file, line)
  })
}

const startController = async (config: Config, options: ServeOptions): Promise<Controller> => {
  if (options.kind === "bridge") {
    return startBridge(config, options)
  }
  const { module, scenario } = options
  const host = await loadHost(module)
  // Distinct per process, so a handle from an earlier session cannot match this one.
  const sessionPrefix = `session-${randomUUID().slice(0, 8)}`
  return createController(host, {
    sessionPrefix,
    startTimeoutMs: config.startTimeoutMs,
    ...(scenario === undefined ? {} : { scenario }),
  })
}

const startBridge = (
  config: Config,
  { hostname, port }: { readonly hostname: string; readonly port: number },
): Controller => {
  const token = loadOrCreateToken(config.tokenPath)
  let server: BridgeServer | null = null
  const controller = createBridgeController({
    disconnectedMessage:
      `No app is connected to the bridge on port ${port}. Connect the app using @reflex/live connectBridge(appSetting), with ` +
      "the appSetting that `reflex --target device start` printed (Expo: EXPO_PUBLIC_REFLEX_BRIDGE).",
    onClose: () => server?.stop(),
    appWaitMs: config.appWaitMs,
  })
  server = serveBridge({ hostname, port, token, controller, onBackgroundError: reportToConsole })
  return controller
}

/** Hosts the Android emulator reaches as `10.0.2.2`, which is this machine's IPv4 loopback. */
const IPV4_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"])
/** Both are dual-stack on the systems this runs on, so IPv4 clients reach them too. */
const ALL_INTERFACES: ReadonlySet<string> = new Set(["0.0.0.0", "::"])
const ANDROID_EMULATOR_HOST = "10.0.2.2"

/** An address this machine can be reached at from the local network, if it has one. */
const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address

/** A URL needs an IPv6 literal in brackets. */
const urlHost = (host: string): string => (host.includes(":") ? `[${host}]` : host)

/** Where an app on this machine, or on the network for all interfaces, should dial. */
const dialHostFor = (hostname: string): string => {
  if (ALL_INTERFACES.has(hostname)) {
    return lanAddress() ?? "127.0.0.1"
  }
  return IPV4_LOOPBACK_HOSTS.has(hostname) ? "127.0.0.1" : hostname
}

export const describeBridge = (
  config: Config,
  { hostname, port }: { readonly hostname: string; readonly port: number },
): BridgeDescription => {
  const token = loadOrCreateToken(config.tokenPath)
  const emulatorReaches = IPV4_LOOPBACK_HOSTS.has(hostname) || ALL_INTERFACES.has(hostname)
  const setting = (host: string) =>
    formatBridgeSetting({ url: `ws://${urlHost(host)}:${port}`, token })
  return {
    target: "device",
    listening: `ws://${urlHost(hostname)}:${port}`,
    appSetting: setting(dialHostFor(hostname)),
    ...(emulatorReaches ? { androidEmulatorSetting: setting(ANDROID_EMULATOR_HOST) } : {}),
    tokenFile: config.tokenPath,
  }
}

const loadHost = async (module: string): Promise<AppHost> => {
  const loaded: { default?: unknown; app?: unknown } = await import(
    pathToFileURL(resolve(module)).href
  )
  return parseHost(loaded.default ?? loaded.app, module)
}

const parseHost = (value: unknown, module: string): AppHost => {
  const refuse = () => new Error(`${module} must export an app as "default" or "app"`)
  if (typeof value === "object" && value !== null && APP_HOST_ADAPTER in value) {
    value = value[APP_HOST_ADAPTER]
  }
  if (typeof value !== "object" || value === null) {
    throw refuse()
  }
  // Only read, and every field is checked below before it is used.
  const { name, scenarios, defaultScenario, start } = value as Partial<AppHost>
  if (typeof name !== "string" || typeof defaultScenario !== "string") {
    throw refuse()
  }
  if (typeof start !== "function" || !Array.isArray(scenarios)) {
    throw refuse()
  }
  const parsed = scenarios.map((scenario, index) =>
    scenarioDescriptor(scenario, `scenarios[${index}]`),
  )
  if (!parsed.some((scenario) => scenario.name === defaultScenario)) {
    throw new Error(`${module} has no scenario "${defaultScenario}"`)
  }
  return { name, scenarios: parsed, defaultScenario, start: start.bind(value) }
}

const serveUntilShutdown = async (config: Config, controller: Controller): Promise<void> => {
  const { promise: shutdownRequested, resolve: requestShutdown } = Promise.withResolvers<void>()
  try {
    const server = await serveSocket(controller, config.socketPath, {
      onShutdown: requestShutdown,
      ...(process.platform === "win32" ? { localSecret: readLocalSecret(config) } : {}),
    })
    process.on("SIGTERM", requestShutdown)
    process.on("SIGINT", requestShutdown)
    await shutdownRequested
    server.close()
  } finally {
    await controller.close()
  }
}

/** Time and waiting, passed in so that a test can stand in for them. */
export interface Clock {
  nowUnixMs(): number
  sleep(durationMs: number): Promise<void>
}

const systemClock: Clock = {
  nowUnixMs: () => Date.now(),
  sleep: (durationMs) => Bun.sleep(durationMs),
}

export const start = async (
  config: Config,
  options: ServeOptions,
  serveArguments: ReadonlyArray<string>,
  clock: Clock = systemClock,
): Promise<DescribeResult | BridgeDescription> => {
  preparePrivateDirectory(config)
  // Made here, before the daemon, so that a failure to make it is reported here.
  const bridge = options.kind === "bridge" ? describeBridge(config, options) : null
  const child = spawn(process.execPath, [cliPath(), "serve", ...serveArguments, "--daemon"], {
    detached: true,
    windowsHide: true,
    env: {
      ...process.env,
      REFLEX_DIR: config.directory,
      REFLEX_TARGET: config.target,
      REFLEX_START_TIMEOUT_MS: String(config.startTimeoutMs),
    },
    // The daemon writes its own bounded log. A redirect here could not be limited.
    stdio: "ignore",
  })
  // Held until it is ready, not released at once: while this process is waiting on
  // the child, an unref'd one could leave nothing keeping its event loop alive, and it
  // would quietly exit as a success.
  const probe: (remainingMs: number) => Promise<DescribeResult | BridgeDescription | undefined> =
    bridge === null
      ? (remainingMs: number) => describeIfReady(config, child.pid, remainingMs)
      : async () => ((await listeningAs(config, child.pid)) ? bridge : undefined)
  const description = await awaitReady(config, child, clock, probe)
  child.unref()
  return description
}

/** A sibling file, whatever the current directory is. */
const cliPath = (): string => resolve(import.meta.dirname, "cli.ts")

const awaitReady = async <A>(
  config: Config,
  child: ReturnType<typeof spawn>,
  clock: Clock,
  probe: (remainingMs: number) => Promise<A | undefined>,
): Promise<A> => {
  let stopped = false
  const exited = new Promise<void>((done) => {
    child.once("exit", () => {
      stopped = true
      done()
    })
  })
  const deadlineUnixMs = clock.nowUnixMs() + config.startTimeoutMs
  try {
    while (clock.nowUnixMs() < deadlineUnixMs && !stopped) {
      const remainingMs = deadlineUnixMs - clock.nowUnixMs()
      const description = await probe(remainingMs)
      if (description !== undefined) {
        return description
      }
      await clock.sleep(POLL_INTERVAL_MS)
    }
    throw new Error("Session failed to start")
  } catch (error: unknown) {
    // Reporting failure means it must not come up later. This is our own child.
    if (!stopped) {
      child.kill("SIGKILL")
      await exited
    }
    throw startFailure(config, child.pid, error)
  }
}

const startFailure = (config: Config, pid: number | undefined, cause: unknown): Error => {
  const fallback = cause instanceof Error ? cause : new Error(String(cause))
  if (pid === undefined) {
    return fallback
  }
  const path = logPathOf(config, pid)
  const reason = existsSync(path) ? reasonInLog(path) : undefined
  rmSync(path, { force: true })
  return reason === undefined ? fallback : new Error(reason)
}

/** Not simply the first line: an app can log plenty before it fails. */
const reasonInLog = (path: string): string | undefined => {
  const lines = readLogEnd(path).split("\n")
  const reason = lines.findLast((line) => line.startsWith(FAILURE_PREFIX))
  return reason?.slice(FAILURE_PREFIX.length)
}

const describeIfReady = async (
  config: Config,
  childPid: number | undefined,
  remainingMs: number,
): Promise<DescribeResult | undefined> => {
  if (lockOwner(config) !== childPid) {
    return undefined
  }
  const client = await connectIfListening(config)
  if (client === undefined) {
    return undefined
  }
  try {
    return await client.request("app.describe", {}, { timeoutMs: Math.max(remainingMs, 1) })
  } finally {
    client.close()
  }
}

/** A bridge is ready once it answers on its socket; no app need have connected yet. */
const listeningAs = async (config: Config, childPid: number | undefined): Promise<boolean> => {
  if (lockOwner(config) !== childPid) {
    return false
  }
  const client = await connectIfListening(config)
  client?.close()
  return client !== undefined
}

/** A socket file nothing listens on is one being set up, or a crash's leftover. */
const connectIfListening = async (config: Config): Promise<Client | undefined> => {
  try {
    return await connectSocket(config.socketPath, undefined, readLocalSecret(config))
  } catch (error: unknown) {
    if (hasCode(error, "ECONNREFUSED") || hasCode(error, "ENOENT")) {
      return undefined
    }
    throw error
  }
}

const readLogEnd = (path: string): string => {
  const file = openSync(path, "r")
  try {
    const { size } = statSync(path)
    const start = Math.max(size - STARTUP_FAILURE_BYTES_MAX, 0)
    const buffer = Buffer.alloc(size - start)
    const bytesRead = readSync(file, buffer, 0, buffer.length, start)
    return buffer.toString("utf8", 0, bytesRead)
  } finally {
    closeSync(file)
  }
}

/**
 * Ask over the socket rather than signal a pid: a recorded pid may since have
 * been reused, and only the session itself can answer on its socket.
 */
export const stop = async (config: Config, clock: Clock = systemClock): Promise<void> => {
  const client = await connectIfListening(config)
  if (client === undefined) {
    const owner = lockOwner(config)
    if (owner !== undefined && isAlive(owner)) {
      throw new Error(`The lock names running process ${owner}, but no session answers.`)
    }
    clearLeftovers(config)
    return
  }
  try {
    await client.request("session.shutdown", {}, { timeoutMs: config.shutdownReplyTimeoutMs })
  } catch (error: unknown) {
    const owner = lockOwner(config)
    throw new Error(
      `Session is not responding (${boundedText(String(error))}). Inspect process ${owner}.`,
    )
  } finally {
    client.close()
  }
  await awaitRelease(config, clock)
}

const awaitRelease = async (config: Config, clock: Clock): Promise<void> => {
  const deadlineUnixMs = clock.nowUnixMs() + SHUTDOWN_COMPLETE_TIMEOUT_MS
  while (existsSync(config.lockPath)) {
    if (clock.nowUnixMs() >= deadlineUnixMs) {
      throw new Error(`Session accepted shutdown but process ${lockOwner(config)} is still up.`)
    }
    await clock.sleep(POLL_INTERVAL_MS)
  }
}

const readLocalSecret = (config: Config): string | undefined => {
  if (process.platform !== "win32") {
    return undefined
  }
  checkSecretAcl(config.directory)
  checkSecretAcl(config.authPath)
  const secret = readFileSync(config.authPath, "utf8")
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("Invalid local session secret")
  }
  return secret
}
