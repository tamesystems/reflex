import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { type Config, stopCommand } from "./config.ts"

const RECLAIM_MUTEX_STALE_MS = 5_000

const running = (config: Config) =>
  new Error(`A session is already running. Stop it with: ${stopCommand(config)}`)

export const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

/** Only a process that certainly does not exist counts as dead. */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (hasCode(error, "ESRCH")) {
      return false
    }
    if (hasCode(error, "EPERM")) {
      return true
    }
    throw error
  }
}

export const lockOwner = (config: Config): number | undefined => {
  let text: string
  try {
    text = readFileSync(config.lockPath, "utf8")
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return undefined
    }
    throw error
  }
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * One session per directory. `link` is atomic and fails if the lock exists, and
 * the lock appears with its pid already inside, so nobody can read it half-made
 * and mistake it for stale.
 */
export const acquireLock = (config: Config, nowUnixMs: number): void => {
  const claimPath = `${config.lockPath}.${process.pid}`
  writeFileSync(claimPath, String(process.pid), { mode: 0o600 })
  try {
    try {
      linkSync(claimPath, config.lockPath)
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) {
        throw error
      }
      reclaimLock(config, claimPath, nowUnixMs)
    }
  } finally {
    rmSync(claimPath, { force: true })
  }
}

/**
 * Replacing a dead owner's lock takes a check and then a delete. Only the holder
 * of this mutex may delete, so what it read cannot change under it.
 */
const reclaimLock = (config: Config, claimPath: string, nowUnixMs: number): void => {
  acquireReclaimMutex(config, nowUnixMs)
  try {
    const owner = lockOwner(config)
    if (owner !== undefined && isAlive(owner)) {
      throw running(config)
    }
    rmSync(config.lockPath, { force: true })
    linkSync(claimPath, config.lockPath)
  } catch (error: unknown) {
    throw hasCode(error, "EEXIST") ? running(config) : error
  } finally {
    rmdirSync(config.reclaimPath)
  }
}

/** A holder needs microseconds, so an old mutex belonged to a process that crashed. */
const acquireReclaimMutex = (config: Config, nowUnixMs: number): void => {
  try {
    mkdirSync(config.reclaimPath)
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw error
    }
    if (nowUnixMs - statSync(config.reclaimPath).mtimeMs < RECLAIM_MUTEX_STALE_MS) {
      throw running(config)
    }
    rmdirSync(config.reclaimPath)
    mkdirSync(config.reclaimPath)
  }
}

/** One log per process, so that a start which loses a race cannot touch the winner's. */
export const logPathOf = (config: Config, pid: number): string => `${config.logPath}.${pid}`

/** Remove only what this process still owns. */
export const releaseLock = (config: Config): void => {
  if (lockOwner(config) === process.pid) {
    if (process.platform !== "win32") {
      rmSync(config.socketPath, { force: true })
    }
    if (process.platform === "win32") {
      rmSync(config.authPath, { force: true })
    }
    rmSync(config.lockPath, { force: true })
  }
}

/** For a session known to be gone, whoever it was. */
export const clearLeftovers = (config: Config): void => {
  const owner = lockOwner(config)
  if (owner !== undefined) {
    rmSync(logPathOf(config, owner), { force: true })
  }
  if (process.platform !== "win32") {
    rmSync(config.socketPath, { force: true })
  }
  rmSync(config.lockPath, { force: true })
  if (process.platform === "win32") {
    rmSync(config.authPath, { force: true })
  }
  rmSync(config.reclaimPath, { recursive: true, force: true })
}
