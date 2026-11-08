import { afterEach, expect, test } from "bun:test"
import { createCipheriv, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalCipher } from "../src/local-cipher.ts"
import { authenticateLocal } from "../src/local-auth.ts"

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

test("modified authenticated frames are rejected and CRLF frames are accepted", async () => {
  const [server, client] = await pair("secret", "secret")
  if (server?.status !== "fulfilled" || client?.status !== "fulfilled") {
    throw new Error("Handshake failed")
  }
  const encoded = client.value.encode("hello")
  expect(server.value.decode(`${encoded}\r`)).toBe("hello")
  const next = client.value.encode("tamper")
  const changed = `${next[0] === "A" ? "B" : "A"}${next.slice(1)}`
  expect(() => server.value.decode(changed)).toThrow()
})

test("write credit is released only by an unpredictable proof of reading", async () => {
  const [server, client] = await pair("secret", "secret")
  if (server?.status !== "fulfilled" || client?.status !== "fulfilled") {
    throw new Error("Handshake failed")
  }
  const first = client.value.encode("x".repeat(100), 400)
  expect(() => client.value.encode("x".repeat(100), 400)).toThrow("not reading")
  // A peer sending without reading cannot return any credit.
  expect(client.value.decode(server.value.encode(null))).toBeNull()
  expect(() => client.value.encode("x".repeat(100), 400)).toThrow("not reading")
  expect(server.value.decode(first)).toBe("x".repeat(100))
  expect(client.value.decode(server.value.encode(null))).toBeNull()
  expect(() => client.value.encode("x".repeat(100), 400)).not.toThrow()
})

test("a peer knowing the encryption key cannot invent unread receipt challenges", () => {
  const key = Buffer.alloc(32, 1)
  const sender = new LocalCipher(key, key)
  sender.encode("unread")
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12))
  const forged = Buffer.concat([
    cipher.update(`1:${"0".repeat(32)}:a\n${"1".repeat(32)}`),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64")
  expect(() => sender.decode(forged)).toThrow("receipt proof")
})
