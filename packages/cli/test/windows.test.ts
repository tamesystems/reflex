import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, sessionEndpoint } from "../src/config.ts"
import { clearLeftovers, isAlive } from "../src/session-lock.ts"
import {
  checkSecretAcl,
  checkWindowsAcl,
  preparePrivateDirectory,
} from "../src/windows-security.ts"

test("Windows pipe identity includes the resolved directory and target", () => {
  const a = sessionEndpoint("alpha", "headless", "win32")
  expect(a.startsWith("\\\\.\\pipe\\reflex-")).toBe(true)
  expect(a).toBe(sessionEndpoint("alpha/../alpha", "headless", "win32"))
  expect(a).not.toBe(sessionEndpoint("beta", "headless", "win32"))
  expect(a).not.toBe(sessionEndpoint("alpha", "device", "win32"))
  expect(a.length).toBeLessThan(256)
})

test("pid liveness recognizes this process", () => expect(isAlive(process.pid)).toBe(true))

test.skipIf(process.platform !== "win32")(
  "private Windows directories reject a broad ACL",
  () => {
    const parent = mkdtempSync(join(tmpdir(), "reflex-acl-"))
    const directory = join(parent, "private")
    try {
      preparePrivateDirectory({ directory })
      checkWindowsAcl(directory)
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdio: "pipe" })
      expect(() => checkWindowsAcl(directory)).toThrow("Windows ACL")
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  },
  15_000,
)

test.skipIf(process.platform !== "win32")("stale cleanup never treats the pipe as a file", () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-stale-"))
  try {
    const config = loadConfig({ ...process.env, REFLEX_DIR: directory })
    clearLeftovers(config)
    expect(config.socketPath.startsWith("\\\\.\\pipe\\")).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "win32")(
  "Windows secrets reject a broad explicit file ACL",
  () => {
    const parent = mkdtempSync(join(tmpdir(), "reflex-secret-acl-"))
    const directory = join(parent, "private")
    try {
      preparePrivateDirectory({ directory })
      const path = join(directory, "session.auth")
      writeFileSync(path, "")
      checkSecretAcl(path)
      execFileSync("icacls.exe", [path, "/grant", "*S-1-1-0:R"], { stdio: "pipe" })
      expect(() => checkSecretAcl(path)).toThrow("Windows ACL")
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  },
  15_000,
)
