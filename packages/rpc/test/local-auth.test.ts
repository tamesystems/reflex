import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authenticateLocal, type LocalCipher } from "../src/local-auth.ts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup()
  }
})

const pair = async (
  serverSecret: string,
  clientSecret: string,
): Promise<ReadonlyArray<PromiseSettledResult<LocalCipher>>> => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-auth-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\reflex-auth-${randomUUID()}`
      : join(directory, "s.sock")
  const accepted = Promise.withResolvers<LocalCipher>()
  const server = createServer((socket) => {
    cleanups.push(() => socket.destroy())
    void authenticateLocal(socket, serverSecret, true).then(accepted.resolve, accepted.reject)
  })
  cleanups.push(() => {
    server.close()
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const socket = connect(path)
  cleanups.push(() => socket.destroy())
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  return Promise.allSettled([accepted.promise, authenticateLocal(socket, clientSecret, false)])
}

test("local peers mutually authenticate without sending a secret", async () => {
  expect((await pair("secret", "secret")).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])
})

test("a squatted endpoint cannot authenticate and wrong clients are rejected", async () => {
  expect((await pair("attacker", "secret")).map((r) => r.status)).toEqual(["rejected", "rejected"])
})

test("authenticated frames resist reading, modification, reflection and replay", async () => {
  const [server, client] = await pair("secret", "secret")
  if (server?.status !== "fulfilled" || client?.status !== "fulfilled") {
    throw new Error("Handshake failed")
  }
  const encoded = client.value.encode('{"secret":"state"}')
  expect(encoded).not.toContain("state")
  expect(server.value.decode(encoded)).toBe('{"secret":"state"}')
  expect(() => server.value.decode(encoded)).toThrow()
  expect(() => client.value.decode(encoded)).toThrow()
})
