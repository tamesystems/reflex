import { expect, test } from "bun:test"
import {
  BRIDGE_HELLO,
  BRIDGE_HELLO_CHARACTERS_MAX,
  BRIDGE_TOKEN_CHARACTERS_MAX,
  BRIDGE_TOKEN_CHARACTERS_MIN,
  BridgeCloseCode,
  bridgeHello,
  formatBridgeSetting,
  isFinalBridgeClose,
  PROTOCOL_VERSION,
  parseBridgeHello,
  parseBridgeSetting,
} from "@reflex/protocol"

const TOKEN = "a".repeat(BRIDGE_TOKEN_CHARACTERS_MIN)

test("a setting names the bridge and its token, and survives a round trip", () => {
  for (const url of ["ws://127.0.0.1:8790", "ws://10.0.2.2:8790", "wss://dev.example:443/"]) {
    const setting = formatBridgeSetting({ url, token: TOKEN })
    expect(parseBridgeSetting(setting)).toEqual({ url, token: TOKEN })
  }
})

test("a setting without a usable url or token is refused", () => {
  for (const setting of [
    "",
    TOKEN,
    `http://127.0.0.1:8790#${TOKEN}`,
    `ws://127.0.0.1:8790/path#${TOKEN}`,
    `ws://127.0.0.1:8790?x=1#${TOKEN}`,
    "ws://127.0.0.1:8790",
    "ws://127.0.0.1:8790#",
    `ws://127.0.0.1:8790#${"a".repeat(BRIDGE_TOKEN_CHARACTERS_MIN - 1)}`,
    `ws://127.0.0.1:8790#${"a".repeat(BRIDGE_TOKEN_CHARACTERS_MAX + 1)}`,
    `ws://127.0.0.1:8790#${"a".repeat(BRIDGE_TOKEN_CHARACTERS_MIN)}!`,
  ]) {
    expect(() => parseBridgeSetting(setting)).toThrow()
  }
})

test("a hello carries the protocol version and the token, and nothing else passes for one", () => {
  expect(parseBridgeHello(bridgeHello(TOKEN))).toEqual({
    type: BRIDGE_HELLO,
    protocolVersion: PROTOCOL_VERSION,
    token: TOKEN,
  })
  for (const text of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ type: "something else", protocolVersion: PROTOCOL_VERSION, token: TOKEN }),
    JSON.stringify({ type: BRIDGE_HELLO, protocolVersion: 2, token: TOKEN }),
    JSON.stringify({ type: BRIDGE_HELLO, protocolVersion: PROTOCOL_VERSION }),
    JSON.stringify({
      type: BRIDGE_HELLO,
      protocolVersion: PROTOCOL_VERSION,
      token: "x".repeat(BRIDGE_HELLO_CHARACTERS_MAX),
    }),
  ]) {
    expect(parseBridgeHello(text)).toBeNull()
  }
})

test("only refusals no retry could fix are final", () => {
  expect(isFinalBridgeClose(BridgeCloseCode.Unauthorized)).toBe(true)
  expect(isFinalBridgeClose(BridgeCloseCode.Incompatible)).toBe(true)
  expect(isFinalBridgeClose(BridgeCloseCode.Replaced)).toBe(true)
  expect(isFinalBridgeClose(BridgeCloseCode.Overloaded)).toBe(false)
  expect(isFinalBridgeClose(1000)).toBe(false)
  expect(isFinalBridgeClose(1006)).toBe(false)
})
