/**
 * Dials a bridge on the developer's machine and serves the protocol over that one
 * connection, so the app opens no port of its own. Development only: import this
 * module behind `__DEV__`, so that production bundles leave it out entirely.
 */
import {
  BRIDGE_REDIAL_DELAY_MS_MAX,
  BRIDGE_REDIAL_DELAY_MS_MIN,
  BridgeCloseCode,
  bridgeHello,
  FRAME_CHARACTERS_MAX,
  isFinalBridgeClose,
  parseBridgeSetting,
  WRITE_QUEUE_BYTES_MAX,
} from "@reflex/protocol"
import { type Connection, createConnection } from "@reflex/rpc/connection"
import {
  type BackgroundReporter,
  type Controller,
  reportToConsole,
  systemTimers,
  type Timers,
} from "@reflex/runtime/internal"

/** Serves a controller until the returned function is called. */
export type Bridge = (controller: Controller) => () => void

/** What this module needs of a WebSocket, which React Native and browsers both have. */
export interface BridgeSocket {
  readonly readyState: number
  readonly bufferedAmount?: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type BridgeStatus =
  | { readonly kind: "dialling" }
  | { readonly kind: "connected" }
  /** The connection has closed, its close handshake done. A redial may follow. */
  | { readonly kind: "disconnected"; readonly code: number }
  /** The bridge turned this app away for good: a wrong token, version, or another app. */
  | { readonly kind: "refused"; readonly code: number; readonly reason: string }

export interface BridgeOptions {
  readonly onStatus?: (status: BridgeStatus) => void
  readonly onBackgroundError?: BackgroundReporter
  readonly timers?: Timers
  readonly openSocket?: (url: string) => BridgeSocket
}

const SOCKET_OPEN = 1

const openGlobalSocket = (url: string): BridgeSocket => {
  const { WebSocket } = globalThis as unknown as {
    readonly WebSocket: new (url: string) => BridgeSocket
  }
  return new WebSocket(url)
}

/**
 * `setting` is `ws://host:port#token`, as `reflex --target device start` prints it. A
 * malformed one throws here, at once, rather than failing quietly on every dial.
 */
export const connectBridge = (setting: string, options: BridgeOptions = {}): Bridge => {
  const { url, token } = parseBridgeSetting(setting)
  const timers = options.timers ?? systemTimers
  const report = options.onBackgroundError ?? reportToConsole
  const openSocket = options.openSocket ?? openGlobalSocket
  const onStatus = options.onStatus ?? (() => undefined)

  return (controller) => {
    let stopped = false
    let socket: BridgeSocket | null = null
    let redial: unknown = null
    let delayMs = BRIDGE_REDIAL_DELAY_MS_MIN

    const send = (target: BridgeSocket, line: string): void => {
      if (target.readyState !== SOCKET_OPEN) {
        return
      }
      // Not every platform counts what is queued; where one does, a stalled bridge is dropped.
      if ((target.bufferedAmount ?? 0) > WRITE_QUEUE_BYTES_MAX) {
        target.close(BridgeCloseCode.Overloaded, "Replies are not being read")
        return
      }
      target.send(line)
    }

    const dial = (): void => {
      redial = null
      onStatus({ kind: "dialling" })
      const current = openSocket(url)
      socket = current
      let connection: Connection | null = null
      current.onopen = () => {
        current.send(bridgeHello(token))
        connection = createConnection(controller, (line) => send(current, line), {
          onBackgroundError: report,
        })
        onStatus({ kind: "connected" })
      }
      current.onmessage = ({ data }) => {
        if (typeof data !== "string" || data.length > FRAME_CHARACTERS_MAX) {
          current.close(BridgeCloseCode.Overloaded, "Frames are text, within the limit")
          return
        }
        // The bridge only speaks once it has accepted this app.
        delayMs = BRIDGE_REDIAL_DELAY_MS_MIN
        connection?.receive(data)
      }
      current.onerror = () => undefined // A close follows, and that is where this is handled.
      current.onclose = ({ code, reason }) => {
        connection?.close()
        connection = null
        onStatus({ kind: "disconnected", code })
        if (stopped || socket !== current) {
          return
        }
        socket = null
        if (isFinalBridgeClose(code)) {
          onStatus({ kind: "refused", code, reason })
          report(new Error(`The Reflex bridge refused this app (${code}): ${reason}`))
          return
        }
        redial = timers.setTimeout(dial, delayMs)
        delayMs = Math.min(delayMs * 2, BRIDGE_REDIAL_DELAY_MS_MAX)
      }
    }

    dial()
    return () => {
      stopped = true
      if (redial !== null) {
        timers.clearTimeout(redial)
      }
      socket?.close(1000, "The app stopped serving")
      socket = null
    }
  }
}
