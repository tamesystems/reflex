import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Socket } from "node:net"
import {
  LOCAL_AUTH_LINE_CHARACTERS_MAX,
  LOCAL_AUTH_SECRET_BYTES,
  LOCAL_AUTH_TIMEOUT_MS,
} from "@reflex/protocol"

import { LocalCipher } from "./local-cipher.ts"
export type { LocalCipher } from "./local-cipher.ts"

const nonce = (): string => randomBytes(LOCAL_AUTH_SECRET_BYTES).toString("hex")
const validHex = (value: string): boolean => /^[a-f0-9]{64}$/.test(value)
const proof = (secret: string, role: string, client: string, server: string): string =>
  createHmac("sha256", secret).update(`reflex-local-v1:${role}:${client}:${server}`).digest("hex")
const matches = (actual: string, expected: string): boolean =>
  validHex(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))

/**
 * Mutual challenge-response. Neither side sends the secret; role-separated proofs
 * prevent reflection. Fresh nonces prevent replay, including against a squatted pipe.
 * The socket is paused on completion so the caller can attach its JSON-RPC reader.
 */
export const authenticateLocal = (
  socket: Socket,
  secret: string,
  serverSide: boolean,
): Promise<LocalCipher> =>
  new Promise((resolve, reject) => {
    let buffer = ""
    let client = serverSide ? "" : nonce()
    let server = serverSide ? nonce() : ""
    let step = 0
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      socket.off("data", read)
      socket.off("error", failed)
      socket.off("close", closed)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        socket.pause()
        if (buffer.length > 0) {
          socket.unshift(Buffer.from(buffer))
        }
        const key = (role: string) =>
          Buffer.from(proof(secret, `key-${role}`, client, server), "hex")
        resolve(
          new LocalCipher(
            key(serverSide ? "server" : "client"),
            key(serverSide ? "client" : "server"),
          ),
        )
      }
    }
    const failed = (error: Error): void => finish(error)
    const closed = (): void => finish(new Error("Local authentication connection closed"))
    const timer = setTimeout(
      () => finish(new Error("Local authentication timed out")),
      LOCAL_AUTH_TIMEOUT_MS,
    )
    const read = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8")
      const newline = buffer.indexOf("\n")
      if ((newline < 0 ? buffer.length : newline) > LOCAL_AUTH_LINE_CHARACTERS_MAX) {
        finish(new Error("Local authentication frame too large"))
        return
      }
      if (newline < 0) {
        return
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (step === 0 && buffer.length !== 0) {
        finish(new Error("Unexpected pipelined authentication frame"))
        return
      }
      if (serverSide && step === 0 && validHex(line)) {
        client = line
        step = 1
        socket.write(`${server} ${proof(secret, "server", client, server)}\n`)
      } else if (
        serverSide &&
        step === 1 &&
        matches(line, proof(secret, "client", client, server))
      ) {
        socket.write("ok\n")
        finish()
      } else if (!serverSide && step === 0) {
        const [offered = "", signature = ""] = line.split(" ")
        if (!validHex(offered) || !matches(signature, proof(secret, "server", client, offered))) {
          finish(new Error("Local server authentication failed"))
          return
        }
        server = offered
        step = 1
        socket.write(`${proof(secret, "client", client, offered)}\n`)
      } else if (!serverSide && step === 1 && line === "ok") {
        finish()
      } else {
        finish(new Error("Local authentication failed"))
      }
    }
    socket.on("data", read)
    socket.once("error", failed)
    socket.once("close", closed)
    if (!serverSide) {
      socket.write(`${client}\n`)
    }
    socket.resume()
  })
