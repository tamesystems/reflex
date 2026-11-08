/**
 * Where apps dial in. Each connection must open with a hello that carries the token;
 * until then nothing is forwarded to it, and if it does not say hello in time, or says
 * the wrong thing, it is closed with a code the app takes as final. The newest app to
 * connect is the one driven, and the one it replaces is told so.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import {
  BRIDGE_FRAME_BYTES_MAX,
  type BridgeHello,
  BRIDGE_HELLO_TIMEOUT_MS,
  BridgeCloseCode,
  FRAME_CHARACTERS_MAX,
  isBridgeToken,
  PROTOCOL_VERSION,
  parseBridgeHello,
  SERVER_CONNECTIONS_MAX,
  WRITE_QUEUE_BYTES_MAX,
} from "@reflex/protocol"
import { type BridgeController, createClient, type TransportClient } from "@reflex/rpc"
import type { BackgroundReporter } from "@reflex/runtime"
import { hasCode } from "./session-lock.ts"

/** 32 random bytes, as base64url: 43 characters. */
const TOKEN_BYTES = 32

/** The token outlives any one bridge, so that an app's configuration does too. */
export const loadOrCreateToken = (path: string): string => {
  try {
    const token = readFileSync(path, "utf8").trim()
    if (!isBridgeToken(token)) {
      throw new Error(`${path} does not hold a bridge token; remove it to make a new one`)
    }
    return token
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error
    }
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url")
  // `wx`: if another start made one meanwhile, theirs stands and this one fails loudly.
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" })
  return token
}

const sameToken = (offered: string, expected: string): boolean => {
  const a = Buffer.from(offered)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface SocketData {
  client: TransportClient | null
  helloTimer: ReturnType<typeof setTimeout> | null
}

type BridgeSocket = Bun.ServerWebSocket<SocketData>

export interface BridgeServerOptions {
  readonly hostname: string
  readonly port: number
  readonly token: string
  readonly controller: BridgeController
  readonly onBackgroundError: BackgroundReporter
}

export interface BridgeServer {
  readonly port: number
  stop(): void
}

/** Who is connected, and who has yet to say who they are. */
class Connections {
  private current: BridgeSocket | null = null
  /** Connections yet to say hello. Only these can be opened by anyone who can reach the port. */
  private strangerCount = 0

  constructor(private readonly options: BridgeServerOptions) {}

  get full(): boolean {
    return this.strangerCount >= SERVER_CONNECTIONS_MAX
  }

  opened(socket: BridgeSocket): void {
    this.strangerCount++
    socket.data.helloTimer = setTimeout(
      () => socket.close(BridgeCloseCode.Unauthorized, "No hello in time"),
      BRIDGE_HELLO_TIMEOUT_MS,
    )
  }

  received(socket: BridgeSocket, message: string | Buffer): void {
    if (typeof message !== "string") {
      socket.close(BridgeCloseCode.Overloaded, "Frames are text")
      return
    }
    const { client } = socket.data
    if (client === null) {
      this.accept(socket, message)
      return
    }
    if (message.length > FRAME_CHARACTERS_MAX) {
      socket.close(BridgeCloseCode.Overloaded, "A frame over the limit")
      return
    }
    client.receive(message)
  }

  closed(socket: BridgeSocket): void {
    clearHelloTimer(socket)
    if (this.current === socket) {
      this.current = null
    }
    const { client } = socket.data
    if (client === null) {
      this.strangerCount--
      return
    }
    client.fail(new Error("The app disconnected"))
    this.options.controller.detach(client)
  }

  private accept(socket: BridgeSocket, text: string): void {
    const refusal = refusalOf(parseBridgeHello(text), this.options.token)
    if (refusal !== null) {
      socket.close(refusal.code, refusal.reason)
      return
    }
    clearHelloTimer(socket)
    this.strangerCount--
    const client = createClient({
      // Bun queues what it cannot send yet, and closes the socket past the limit below.
      send: (line) => {
        socket.send(line)
      },
      close: () => socket.close(1000, "The bridge let this app go"),
      onBackgroundError: this.options.onBackgroundError,
    })
    socket.data.client = client
    const previous = this.current
    this.current = socket
    previous?.close(BridgeCloseCode.Replaced, "Another app connected to the bridge")
    this.options.controller.attach(client)
  }
}

const refusalOf = (
  hello: BridgeHello | null,
  token: string,
): { readonly code: number; readonly reason: string } | null => {
  if (hello === null) {
    return { code: BridgeCloseCode.Unauthorized, reason: "Expected a hello" }
  }
  if (hello.protocolVersion !== PROTOCOL_VERSION) {
    const theirs = hello.protocolVersion.slice(0, 32)
    const reason = `This bridge speaks ${PROTOCOL_VERSION}, the app ${theirs}`
    return { code: BridgeCloseCode.Incompatible, reason }
  }
  if (!sameToken(hello.token, token)) {
    return { code: BridgeCloseCode.Unauthorized, reason: "Wrong token" }
  }
  return null
}

export const serveBridge = (options: BridgeServerOptions): BridgeServer => {
  const connections = new Connections(options)
  const server = Bun.serve<SocketData>({
    hostname: options.hostname,
    port: options.port,
    fetch: (request, bun) => {
      if (connections.full) {
        return new Response("Too many connections are waiting to say hello\n", { status: 503 })
      }
      if (bun.upgrade(request, { data: { client: null, helloTimer: null } })) {
        return undefined
      }
      return new Response("This is a Reflex bridge. Apps connect over WebSocket.\n", {
        status: 426,
      })
    },
    websocket: {
      maxPayloadLength: BRIDGE_FRAME_BYTES_MAX,
      backpressureLimit: WRITE_QUEUE_BYTES_MAX,
      closeOnBackpressureLimit: true,
      open: (socket) => connections.opened(socket),
      message: (socket, message) => connections.received(socket, message),
      close: (socket) => connections.closed(socket),
    },
  })
  return {
    port: server.port ?? options.port,
    stop: () => {
      server.stop(true)
    },
  }
}

const clearHelloTimer = (socket: BridgeSocket): void => {
  if (socket.data.helloTimer !== null) {
    clearTimeout(socket.data.helloTimer)
    socket.data.helloTimer = null
  }
}
