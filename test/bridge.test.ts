/**
 * The live bridge, end to end: the real bridge daemon, apps dialling it from workers,
 * and this process driving them as the CLI does. What a device adds over a headless
 * session is that it comes and goes; these are about that.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { BridgeCloseCode, ErrorCode, type RuntimeEvent } from "@reflex/protocol"
import { type Client, createLoopbackClient } from "@reflex/rpc"
import type { Controller } from "@reflex/runtime"
import { COUNTER_APP_MODULE } from "./counter-app.ts"
import { type BridgedOptions, type Device, openBridged, openDevice } from "./live-bridge.ts"
import type { DeviceReport } from "./live-device.ts"

const CONDITION_TIMEOUT_MS = 5_000

if (process.platform === "win32") {
  setDefaultTimeout(30_000) // Real daemon startup includes Windows ACL verification.
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

const eventually = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + CONDITION_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting until ${what}`)
    }
    await Bun.sleep(5)
  }
}

interface Driven {
  readonly client: Client
  readonly device: Device
  readonly events: Array<RuntimeEvent>
}

/** A bridged app, a client driving it, and every event its subscription delivers. */
const drive = async (options: Omit<BridgedOptions, "onDevice"> = {}): Promise<Driven> => {
  let device: Device | null = null
  const controller: Controller = await openBridged(COUNTER_APP_MODULE, {
    ...options,
    onDevice: (opened) => {
      device = opened
    },
  })
  cleanups.push(() => controller.close())
  const client = createLoopbackClient(controller)
  cleanups.push(() => client.close())
  if (device === null) {
    throw new Error("openBridged reports its device")
  }
  return { client, device, events: [] }
}

const subscribe = async ({ client, events }: Driven): Promise<void> => {
  client.onEvent((event) => events.push(event))
  await client.request("app.subscribe", {})
}

const counts = ({ events }: Driven): ReadonlyArray<unknown> =>
  events.flatMap((event) => (event.type === "state.changed" ? [event.state] : []))

const statuses = (reports: ReadonlyArray<DeviceReport>) =>
  reports.flatMap((report) => (report.type === "status" ? [report.status] : []))

const add = (client: Client, by: number) =>
  client.request("app.dispatch", { action: "Add", input: { by }, await: true })

test("a command sent before the app has connected lands once it does", async () => {
  const { client } = await drive()
  const description = await client.request("app.describe", {})
  expect(description).toMatchObject({ app: "counter", scenario: "default" })
})

test("an app that loses its connection resumes where it left off, repeating nothing", async () => {
  const driven = await drive()
  const { client, device } = driven
  await subscribe(driven)
  await add(client, 1)
  await eventually(() => counts(driven).length === 1, "the first change arrives")

  device.send({ type: "stop-serving" })
  await eventually(
    () => statuses(device.reports).at(-1)?.kind === "disconnected",
    "the app has closed its connection",
  )
  // Sent while the app is away: it waits for the app to come back, then lands.
  const whileAway = add(client, 2)
  device.send({ type: "serve-again" })
  await whileAway
  await add(client, 3)

  await eventually(() => counts(driven).length === 3, "every change arrives")
  expect(counts(driven)).toEqual([{ count: 1 }, { count: 3 }, { count: 6 }])
  expect(driven.events.some((event) => event.type === "resync.required")).toBe(false)
})

test("a reload tells subscribers to resynchronize, and commands reach the new session", async () => {
  const driven = await drive()
  const { client, device } = driven
  await subscribe(driven)
  const before = await client.request("app.describe", {})
  await add(client, 5)

  device.send({ type: "reload" })
  await eventually(
    () =>
      driven.events.some((e) => e.type === "resync.required" && e.sessionId !== before.sessionId),
    "the new session says to resynchronize",
  )
  const after = await client.request("app.describe", {})
  expect(after.sessionId).not.toBe(before.sessionId)
  const { node } = await client.request("app.inspect", {})
  expect(node?.state).toEqual({ count: 0 })
  await add(client, 1)
  await eventually(() => counts(driven).at(-1) !== undefined, "changes arrive from the new session")
  expect(counts(driven).at(-1)).toEqual({ count: 1 })
})

test("a reset through the bridge restarts the app on screen", async () => {
  const { client } = await drive()
  const before = await client.request("app.describe", {})
  await add(client, 4)
  const after = await client.request("app.reset", {})
  expect(after.sessionId).not.toBe(before.sessionId)
  const { node } = await client.request("app.inspect", {})
  expect(node?.state).toEqual({ count: 0 })
  const refused = await client.request("app.reset", { scenario: "nope" }).catch((e) => e)
  expect(refused).toMatchObject({ code: ErrorCode.ScenarioNotFound })
})

test("an app with the wrong token is refused once, and stops dialling", async () => {
  const { device } = await drive({ token: "w".repeat(43) })
  await eventually(
    () => statuses(device.reports).some((status) => status.kind === "refused"),
    "the app is refused",
  )
  expect(statuses(device.reports).at(-1)).toMatchObject({
    kind: "refused",
    code: BridgeCloseCode.Unauthorized,
  })
  await Bun.sleep(1_200)
  expect(statuses(device.reports).filter((status) => status.kind === "dialling")).toHaveLength(1)
})

test("a second app takes the bridge over, and the first stops dialling", async () => {
  const { client, device } = await drive()
  const first = await client.request("app.describe", {})
  const second = openDevice(device, COUNTER_APP_MODULE)
  cleanups.push(second.stop)
  await eventually(
    () => statuses(device.reports).some((status) => status.kind === "refused"),
    "the first app is told it was replaced",
  )
  expect(statuses(device.reports).at(-1)).toMatchObject({ code: BridgeCloseCode.Replaced })
  const now = await client.request("app.describe", {})
  expect(now.sessionId).not.toBe(first.sessionId)
})

test("the bridge closes a connection that does not open with a valid hello", async () => {
  const { client, device } = await drive()
  await client.request("app.describe", {})
  const closes: Array<number> = []
  for (const opening of ["not json", JSON.stringify({ type: "reflex.bridge.hello" })]) {
    const socket = new WebSocket(`ws://127.0.0.1:${device.port}`)
    socket.onopen = () => socket.send(opening)
    socket.onclose = ({ code }) => closes.push(code ?? 0)
  }
  await eventually(() => closes.length === 2, "both strangers are closed")
  expect(closes).toEqual([BridgeCloseCode.Unauthorized, BridgeCloseCode.Unauthorized])
  // The app being driven is not disturbed by them.
  expect((await client.request("app.describe", {})).app).toBe("counter")
})
