/**
 * The live bridge: an app on a device dials out to the developer's machine, says who it
 * is, and from then on answers JSON-RPC over that connection, one message per frame. The
 * app is the server and the bridge is its client, so the app needs no listening socket.
 */
import { PROTOCOL_VERSION } from "./contracts.ts"
import { BRIDGE_HELLO_CHARACTERS_MAX, BRIDGE_TOKEN_CHARACTERS_MAX } from "./limits.ts"
import { isRecord } from "./parsers.ts"

/** The type of the one message an app sends before any JSON-RPC. */
export const BRIDGE_HELLO = "reflex.bridge.hello"

export interface BridgeHello {
  readonly type: typeof BRIDGE_HELLO
  readonly protocolVersion: string
  readonly token: string
}

/**
 * Why the bridge closed a connection. The app stops redialling on the first three: no
 * retry can fix a wrong token or version, and a replaced app would take the bridge back.
 */
export const BridgeCloseCode = {
  Unauthorized: 4401,
  Incompatible: 4400,
  Replaced: 4409,
  /** A peer sent a frame over the limit, or let too many replies queue up. */
  Overloaded: 4413,
} as const

export const isFinalBridgeClose = (code: number): boolean =>
  code === BridgeCloseCode.Unauthorized ||
  code === BridgeCloseCode.Incompatible ||
  code === BridgeCloseCode.Replaced

/** Long enough to guess at, never long enough to page through a frame with. */
export const BRIDGE_TOKEN_CHARACTERS_MIN = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/

export const isBridgeToken = (token: string): boolean =>
  token.length >= BRIDGE_TOKEN_CHARACTERS_MIN &&
  token.length <= BRIDGE_TOKEN_CHARACTERS_MAX &&
  TOKEN_PATTERN.test(token)

export interface BridgeSetting {
  readonly url: string
  readonly token: string
}

/**
 * One value names both, as `ws://host:port#token`, so that one environment variable
 * configures an app. The token rides in the fragment, which a WebSocket never sends.
 */
export const parseBridgeSetting = (setting: string): BridgeSetting => {
  const hash = setting.indexOf("#")
  const url = hash === -1 ? setting : setting.slice(0, hash)
  const token = hash === -1 ? "" : setting.slice(hash + 1)
  if (!/^wss?:\/\/[^/?#\s]+\/?$/.test(url)) {
    throw new Error("The bridge setting must look like ws://host:port#token")
  }
  if (!isBridgeToken(token)) {
    throw new Error("The bridge setting's token is missing or malformed")
  }
  return { url, token }
}

export const formatBridgeSetting = ({ url, token }: BridgeSetting): string => `${url}#${token}`

export const bridgeHello = (token: string): string =>
  JSON.stringify({ type: BRIDGE_HELLO, protocolVersion: PROTOCOL_VERSION, token })

/** Null for anything that is not a well-formed hello; the caller decides what that costs. */
export const parseBridgeHello = (text: string): BridgeHello | null => {
  if (text.length > BRIDGE_HELLO_CHARACTERS_MAX) {
    return null
  }
  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(message) || message.type !== BRIDGE_HELLO) {
    return null
  }
  const { protocolVersion, token } = message
  if (typeof protocolVersion !== "string" || typeof token !== "string") {
    return null
  }
  return { type: BRIDGE_HELLO, protocolVersion, token }
}
