import { chmodSync, rmSync } from "node:fs"
import { connect, createServer, type Server, type Socket } from "node:net"
import {
  type AccessPolicy,
  ErrorCode,
  LOCAL_ENCRYPTED_FRAME_CHARACTERS_MAX,
  FRAME_CHARACTERS_MAX,
  ProtocolError,
  SERVER_CONNECTIONS_MAX,
  WRITE_QUEUE_BYTES_MAX,
} from "@reflex/protocol"
import {
  type BackgroundReporter,
  type Controller,
  reportToConsole,
  systemTimers,
  type Timers,
} from "@reflex/runtime/internal"
import { type Client, createClient } from "./client.ts"
import { authenticateLocal, type LocalCipher } from "./local-auth.ts"
import { socketShutdown } from "./socket-shutdown.ts"
import { socketWriter } from "./socket-writer.ts"
import { FrameSink } from "./frame-sink.ts"
import { createConnection, createEventEncoder } from "./server.ts"

const SOCKET_CONNECT_TIMEOUT_MS = 2_000
const STDIO_DRAIN_TIMEOUT_MS = 5_000
const STDOUT_FD = 1
/** Only the owner: the socket's mode is the connection's authentication. */
const SOCKET_MODE = 0o600

export interface LineReaderOptions {
  readonly onLine: (line: string) => void
  /** The peer exceeded the frame limit and nothing further will be delivered. */
  readonly onOverflow: () => void
  readonly frameCharactersMax?: number
}

/**
 * Split a byte stream into lines. Decoding is streaming, so a multi-byte
 * character split across chunks survives, and a frame cannot grow without bound.
 */
export const createLineReader = (options: LineReaderOptions) => {
  const frameCharactersMax = options.frameCharactersMax ?? FRAME_CHARACTERS_MAX
  const decoder = new TextDecoder()
  let buffer = ""
  /** Where the search for a newline resumes, so that a frame is scanned once. */
  let searchIndex = 0
  let overflowed = false

  const overflow = () => {
    overflowed = true
    buffer = ""
    options.onOverflow()
  }

  const read = (chunk: Uint8Array | string): void => {
    if (overflowed) {
      return
    }
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let newlineIndex = buffer.indexOf("\n", searchIndex)
    while (newlineIndex >= 0) {
      if (newlineIndex > frameCharactersMax) {
        overflow()
        return
      }
      options.onLine(buffer.slice(0, newlineIndex))
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf("\n")
    }
    searchIndex = buffer.length
    if (buffer.length > frameCharactersMax) {
      overflow()
    }
  }

  /** At the end of input, a last line needs no newline to be a line. */
  const flush = (): void => {
    if (!overflowed && buffer.length > 0) {
      options.onLine(buffer)
      buffer = ""
    }
  }

  return Object.assign(read, { flush })
}

export interface ServeSocketOptions {
  /** What every peer of this socket may do. Full control unless given. */
  readonly access?: AccessPolicy
  readonly localSecret?: string | undefined
  readonly onShutdown?: () => void
  readonly writeQueueBytesMax?: number
  readonly onBackgroundError?: BackgroundReporter
}

/**
 * Buffers, not strings: a stream counts a queued string in characters, which would
 * let the limit be passed by up to three times over.
 */
const frameOf = (line: string): Buffer => Buffer.from(`${line}\n`)

/**
 * Serve on a Unix socket. The caller must own `path`: anything there is
 * replaced. It must also be in a directory private to the user, since the socket
 * exists for a moment between `listen` and `chmod`.
 */
export const serveSocket = (
  controller: Controller,
  path: string,
  options: ServeSocketOptions = {},
): Promise<Server> =>
  new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      rmSync(path, { force: true })
    }
    const report = options.onBackgroundError ?? reportToConsole
    const writeQueueBytesMax = options.writeQueueBytesMax ?? WRITE_QUEUE_BYTES_MAX
    const encodeEvent = createEventEncoder(report)
    const attach = (socket: Socket, cipher?: LocalCipher): void => {
      const write = socketWriter(socket, writeQueueBytesMax)
      const shutdown = socketShutdown(cipher, options.onShutdown)
      const connection = createConnection(
        controller,
        (line) => {
          let frame: Buffer
          try {
            frame = frameOf(cipher === undefined ? line : cipher.encode(line, writeQueueBytesMax))
          } catch {
            socket.destroy()
            return
          }
          // Once a peer is this far behind, disconnecting is the only signal left.
          if (!write(frame)) {
            socket.destroy()
          }
        },
        {
          encodeEvent,
          ...(options.access === undefined ? {} : { access: options.access }),
          ...(options.onShutdown === undefined ? {} : { onShutdown: shutdown.request }),
          ...(options.onBackgroundError === undefined
            ? {}
            : { onBackgroundError: options.onBackgroundError }),
        },
      )
      const read = createLineReader({
        onLine: (line) => {
          try {
            const decoded = cipher === undefined ? line : cipher.decode(line)
            shutdown.received()
            if (decoded !== null) {
              if (
                cipher !== undefined &&
                !write(frameOf(cipher.encode(null, writeQueueBytesMax)))
              ) {
                throw new Error("Peer is not reading")
              }
              connection.receive(decoded)
            }
          } catch {
            socket.destroy()
          }
        },
        frameCharactersMax:
          cipher === undefined ? FRAME_CHARACTERS_MAX : LOCAL_ENCRYPTED_FRAME_CHARACTERS_MAX,
        onOverflow: () => socket.destroy(),
      })
      socket.on("data", read)
      socket.on("close", () => {
        connection.close()
        shutdown.closed()
      })
      socket.on("error", () => {
        connection.close()
        shutdown.closed()
      })
      socket.resume()
    }
    const server = createServer((socket) => {
      if (options.localSecret === undefined) {
        attach(socket)
      } else {
        void authenticateLocal(socket, options.localSecret, true).then(
          (cipher) => attach(socket, cipher),
          () => socket.destroy(),
        )
      }
    })
    server.maxConnections = SERVER_CONNECTIONS_MAX
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      server.on("error", report)
      try {
        if (process.platform !== "win32") {
          chmodSync(path, SOCKET_MODE)
        }
        resolve(server)
      } catch (error: unknown) {
        server.close()
        reject(error)
      }
    })
  })

/**
 * Speak the protocol on stdin/stdout, for a parent process that owns the session.
 * Closing stdin means no more requests: those already made are answered and written
 * out, for up to `STDIO_DRAIN_TIMEOUT_MS`. Losing stdout means nobody can be answered,
 * so it ends the session at once, and the app is still disposed.
 */
export const serveStdio = (controller: Controller, timers: Timers = systemTimers): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      connection.close()
      // Reading stdin would otherwise keep the process alive with nothing to do.
      process.stdin.destroy()
      resolve()
    }
    const sink = new FrameSink({ fd: STDOUT_FD, onBroken: finish, timers })
    const connection = createConnection(controller, (line) => {
      if (!sink.offer(frameOf(line))) {
        finish()
      }
    })
    const read = createLineReader({
      onLine: (line) => connection.receive(line),
      onOverflow: finish,
    })
    process.stdin.on("error", finish)
    process.stdin.on("data", read)
    process.stdin.on("end", () => {
      read.flush()
      const timer = timers.setTimeout(finish, STDIO_DRAIN_TIMEOUT_MS)
      connection
        .drained()
        .then(() => sink.flushed())
        .then(() => timers.clearTimeout(timer))
        .then(finish, finish)
    })
  })

export const connectSocket = (
  path: string,
  timers: Timers = systemTimers,
  localSecret?: string,
): Promise<Client> =>
  new Promise((resolve, reject) => {
    const socket = connect(path)
    const timer = timers.setTimeout(() => {
      socket.destroy()
      reject(new Error(`Could not connect within ${SOCKET_CONNECT_TIMEOUT_MS}ms`))
    }, SOCKET_CONNECT_TIMEOUT_MS)
    const write = socketWriter(socket, WRITE_QUEUE_BYTES_MAX)
    let cipher: LocalCipher | undefined
    const client = createClient({
      send: (line) => {
        let frame: Buffer
        try {
          frame = frameOf(cipher === undefined ? line : cipher.encode(line))
        } catch {
          throw new ProtocolError(ErrorCode.ResourceExhausted, "The server is not reading")
        }
        // A server that stops reading must not fill this process's memory instead.
        if (!write(frame)) {
          throw new ProtocolError(ErrorCode.ResourceExhausted, "The server is not reading")
        }
      },
      close: () => socket.destroy(),
      timers,
    })
    const read = createLineReader({
      onLine: (line) => {
        try {
          const decoded = cipher === undefined ? line : cipher.decode(line)
          if (decoded !== null) {
            if (cipher !== undefined && !write(frameOf(cipher.encode(null)))) {
              throw new Error("Server is not reading")
            }
            client.receive(decoded)
          }
        } catch {
          client.fail(new Error("Invalid authenticated frame"))
          socket.destroy()
        }
      },
      frameCharactersMax:
        localSecret === undefined ? FRAME_CHARACTERS_MAX : LOCAL_ENCRYPTED_FRAME_CHARACTERS_MAX,
      onOverflow: () => client.fail(new Error("Server sent an oversized frame")),
    })
    socket.once("error", (error) => {
      timers.clearTimeout(timer)
      client.fail(error)
      reject(error)
    })
    socket.on("close", () => client.fail(new Error("Connection closed")))
    socket.once("connect", () => {
      timers.clearTimeout(timer)
      const ready = (): void => {
        socket.on("data", read)
        socket.resume()
        resolve(client)
      }
      if (localSecret === undefined) {
        ready()
      } else {
        void authenticateLocal(socket, localSecret, false).then((authenticated) => {
          cipher = authenticated
          ready()
        }, reject)
      }
    })
  })
