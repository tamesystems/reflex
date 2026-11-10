/** The app's dialler, against a socket the test plays the bridge with. */
import { expect, test } from "bun:test"
import {
  BRIDGE_HELLO,
  BRIDGE_REDIAL_DELAY_MS_MAX,
  BRIDGE_REDIAL_DELAY_MS_MIN,
  BridgeCloseCode,
  FRAME_CHARACTERS_MAX,
} from "@reflex/protocol"
import { createController, type Timers } from "@reflex/runtime"
import { nextTurn } from "@reflex/test"
import app from "../../../examples/inventory/src/app.ts"
import { type BridgeSocket, type BridgeStatus, connectBridge } from "../src/bridge.ts"

const TOKEN = "t".repeat(43)
const SETTING = `ws://127.0.0.1:8790#${TOKEN}`

class FakeSocket implements BridgeSocket {
  readyState = 0
  bufferedAmount = 0
  readonly sent: Array<string> = []
  closedWith: number | null = null
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000): void {
    this.closedWith = code
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  /** The bridge's side of a close. */
  closeFromBridge(code: number, reason = ""): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const harness = () => {
  const sockets: Array<FakeSocket> = []
  const delays: Array<number> = []
  const due = new Set<() => void>()
  const timers: Timers = {
    setTimeout: (callback, delayMs) => {
      delays.push(delayMs)
      due.add(callback)
      return callback
    },
    clearTimeout: (handle) => {
      due.delete(handle as () => void)
    },
  }
  const fire = () => {
    for (const callback of [...due]) {
      due.delete(callback)
      callback()
    }
  }
  const statuses: Array<BridgeStatus> = []
  const reported: Array<unknown> = []
  const bridge = connectBridge(SETTING, {
    timers,
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    onStatus: (status) => statuses.push(status),
    onBackgroundError: (error) => reported.push(error),
  })
  return { bridge, sockets, delays, fire, statuses, reported, due }
}

test("a malformed setting is refused at once", () => {
  expect(() => connectBridge("ws://127.0.0.1:8790")).toThrow("token")
  expect(() => connectBridge(`http://127.0.0.1:8790#${TOKEN}`)).toThrow("ws://")
  expect(() => connectBridge("ws://127.0.0.1:8790#short")).toThrow("token")
})

test("the app says hello first, then answers the bridge's requests", async () => {
  const { bridge, sockets } = harness()
  const controller = await createController(app)
  const stop = bridge(controller)
  const socket = sockets[0]
  expect(socket?.url).toBe("ws://127.0.0.1:8790")
  socket?.open()
  expect(JSON.parse(socket?.sent[0] ?? "")).toMatchObject({ type: BRIDGE_HELLO, token: TOKEN })
  socket?.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" }) })
  await nextTurn()
  await nextTurn()
  expect(JSON.parse(socket?.sent[1] ?? "")).toMatchObject({ id: 1, result: { app: "inventory" } })
  stop()
  expect(socket?.closedWith).toBe(1000)
  await controller.close()
})

test("a lost connection is redialled, backing off up to a limit", async () => {
  const { bridge, sockets, delays, fire, statuses } = harness()
  const controller = await createController(app)
  const stop = bridge(controller)
  for (let index = 0; index < 6; index++) {
    sockets.at(-1)?.closeFromBridge(1006)
    fire()
  }
  expect(sockets).toHaveLength(7)
  expect(delays[0]).toBe(BRIDGE_REDIAL_DELAY_MS_MIN)
  expect(delays.at(-1)).toBe(BRIDGE_REDIAL_DELAY_MS_MAX)
  expect(statuses.filter((status) => status.kind === "disconnected")).toHaveLength(6)
  stop()
  await controller.close()
})

test("a message from the bridge resets the backoff", async () => {
  const { bridge, sockets, delays, fire } = harness()
  const controller = await createController(app)
  const stop = bridge(controller)
  sockets.at(-1)?.closeFromBridge(1006)
  fire()
  sockets.at(-1)?.closeFromBridge(1006)
  fire()
  const socket = sockets.at(-1)
  socket?.open()
  socket?.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "app.describe" }) })
  socket?.closeFromBridge(1006)
  expect(delays.at(-1)).toBe(BRIDGE_REDIAL_DELAY_MS_MIN)
  stop()
  await controller.close()
})

test("a final refusal stops the dialling, and is reported", async () => {
  for (const code of [
    BridgeCloseCode.Unauthorized,
    BridgeCloseCode.Incompatible,
    BridgeCloseCode.Replaced,
  ]) {
    const { bridge, sockets, due, statuses, reported } = harness()
    const controller = await createController(app)
    const stop = bridge(controller)
    sockets[0]?.closeFromBridge(code, "why")
    expect(due.size).toBe(0)
    expect(statuses.at(-1)).toEqual({ kind: "refused", code, reason: "why" })
    expect(reported).toHaveLength(1)
    stop()
    await controller.close()
  }
})

test("a frame that is not text, or over the limit, closes the connection", async () => {
  for (const data of [new ArrayBuffer(4), "x".repeat(FRAME_CHARACTERS_MAX + 1)]) {
    const { bridge, sockets } = harness()
    const controller = await createController(app)
    const stop = bridge(controller)
    sockets[0]?.open()
    sockets[0]?.onmessage?.({ data })
    expect(sockets[0]?.closedWith).toBe(BridgeCloseCode.Overloaded)
    stop()
    await controller.close()
  }
})

test("a bridge that stops reading is dropped rather than queued for without end", async () => {
  const { bridge, sockets } = harness()
  const controller = await createController(app)
  const stop = bridge(controller)
  const socket = sockets[0]
  socket?.open()
  if (socket !== undefined) {
    socket.bufferedAmount = Number.MAX_SAFE_INTEGER
  }
  socket?.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" }) })
  await nextTurn()
  await nextTurn()
  expect(socket?.closedWith).toBe(BridgeCloseCode.Overloaded)
  expect(socket?.sent).toHaveLength(1)
  stop()
  await controller.close()
})
