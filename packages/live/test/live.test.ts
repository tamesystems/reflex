import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
/** The app's side of the bridge: the sessions a provider shows, and the protocol over them. */
import { afterEach, expect, test } from "bun:test"
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  ErrorCode,
  OUTSTANDING_CONTROL_REQUESTS_MAX,
  type RuntimeEvent,
} from "@reflex/protocol"
import { type AppHost, createRuntime, systemTimers, type Timers } from "@reflex/runtime/internal"
import { nextTurn, waitUntil } from "@reflex/test"
import inventoryDefinition from "../../../examples/inventory/src/scenarios.ts"
const app = inventoryDefinition[APP_HOST_ADAPTER]
import { createLiveController } from "../src/live-controller.ts"
import { LiveSessions, liveSessionOf } from "../src/live-sessions.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

const live = (host: AppHost = app, scenario?: string) => {
  const reported: Array<unknown> = []
  const sessions = new LiveSessions({
    timers: systemTimers,
    onBackgroundError: (error) => reported.push(error),
  })
  cleanups.push(sessions.open(host, scenario))
  const controller = createLiveController(sessions, (error) => reported.push(error))
  cleanups.push(() => controller.close())
  return { sessions, controller, reported }
}

test("requests reach the session on screen, once it has started", async () => {
  const { sessions, controller } = live()
  const described = await controller.request("app.describe", {})
  const session = await liveSessionOf(sessions)
  expect(described).toMatchObject({
    app: "inventory",
    scenario: "inventory-with-products",
    sessionId: session.runtime.sessionId,
    capabilities: { virtualTime: false },
  })
  const { node } = await controller.request("app.inspect", {})
  expect(node?.name).toBe("InventoryList")
})

test("two runs of an app hand out different session ids", async () => {
  const first = await liveSessionOf(live().sessions)
  const second = await liveSessionOf(live().sessions)
  expect(first.runtime.sessionId).not.toBe(second.runtime.sessionId)
})

test("a reset replaces the session on screen, on another scenario if asked", async () => {
  const { sessions, controller } = live()
  const before = await liveSessionOf(sessions)
  const described = await controller.request("app.reset", { scenario: "sluggish-network" })
  const after = await liveSessionOf(sessions)
  expect(after).not.toBe(before)
  expect(before.runtime.closed).toBe(true)
  expect(described).toMatchObject({
    scenario: "sluggish-network",
    sessionId: after.runtime.sessionId,
    capabilities: { virtualTime: true },
  })
  expect(sessions.scenario).toBe("sluggish-network")
  await controller.request("app.advanceTime", { durationMs: 1_000 })
})

test("a reset to an unknown scenario is refused, and leaves the session alone", async () => {
  const { sessions, controller } = live()
  const before = await liveSessionOf(sessions)
  const refusal = await controller
    .request("app.reset", { scenario: "nope" })
    .catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.ScenarioNotFound })
  expect(await liveSessionOf(sessions)).toBe(before)
})

test("virtual time is refused on a scenario that runs on real time", async () => {
  const { controller } = live()
  const refusal = await controller
    .request("app.advanceTime", { durationMs: 1 })
    .catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.Unsupported })
})

test("subscribers move to each new session and are told to resynchronize", async () => {
  const { controller } = live()
  const events: Array<RuntimeEvent> = []
  const { sessionId } = await controller.subscribe((event) => events.push(event))
  const { sessionId: next } = await controller.request("app.reset", {})
  await waitUntil(() => events.some((e) => e.type === "resync.required"), "a resync arrives")
  const resync = events.find((e) => e.type === "resync.required")
  expect(resync?.sessionId).toBe(next)
  expect(next).not.toBe(sessionId)
})

test("the provider's own change of scenario wins over an earlier reset", async () => {
  const { sessions, controller } = live()
  await controller.request("app.reset", { scenario: "empty-inventory" })
  const close = sessions.open(app, "slow-network")
  cleanups.push(close)
  const described = await controller.request("app.describe", {})
  expect(described.scenario).toBe("slow-network")
})

test("a failed start is reported to callers, and a reset recovers", async () => {
  let failing = true
  const host: AppHost = {
    name: "flaky",
    scenarios: [{ name: "default", virtualTime: false }],
    defaultScenario: "default",
    start: async (_, { sessionId }) => {
      if (failing) {
        throw new Error("no start")
      }
      return { runtime: createRuntime({ sessionId }), dispose: async () => undefined }
    },
  }
  const { controller } = live(host)
  const refusal = await controller.request("app.describe", {}).catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.SessionClosed })
  failing = false
  await controller.request("app.reset", {})
  expect((await controller.request("app.describe", {})).app).toBe("flaky")
})

test("closing an older opening does not end a newer one", async () => {
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => undefined })
  const closeFirst = sessions.open(app, undefined)
  const closeSecond = sessions.open(app, "empty-inventory")
  cleanups.push(closeSecond)
  closeFirst()
  await nextTurn()
  expect(sessions.scenario).toBe("empty-inventory")
  expect((await liveSessionOf(sessions)).runtime.closed).toBe(false)
})

test("a closed provider refuses requests", async () => {
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => undefined })
  const close = sessions.open(app, undefined)
  const controller = createLiveController(sessions, () => undefined)
  await controller.request("app.describe", {})
  close()
  const refusal = await controller.request("app.describe", {}).catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.SessionClosed })
  await controller.close()
})

/** A host whose sessions run on virtual time, starting only when the test says. */
const gatedHost = () => {
  const starts: Array<() => void> = []
  let hangingAdvance = false
  const host: AppHost = {
    name: "gated",
    scenarios: ["a", "b", "c"].map((name) => ({ name, virtualTime: true })),
    defaultScenario: "a",
    start: (_, { sessionId }) =>
      new Promise((resolve) => {
        starts.push(() =>
          resolve({
            runtime: createRuntime({ sessionId }),
            advanceTime: () =>
              hangingAdvance ? new Promise<number>(() => undefined) : Promise.resolve(0),
            dispose: async () => undefined,
          }),
        )
      }),
  }
  const startNext = async () => {
    await waitUntil(() => starts.length > 0, "a start is pending")
    starts.shift()?.()
  }
  return { host, startNext, hang: () => (hangingAdvance = true) }
}

test("concurrent resets run in order, and each reports the session it made", async () => {
  const { host, startNext } = gatedHost()
  const { controller } = live(host)
  await startNext()
  await controller.request("app.describe", {})
  const toB = controller.request("app.reset", { scenario: "b" })
  const toC = controller.request("app.reset", { scenario: "c" })
  await startNext()
  await startNext()
  const [b, c] = await Promise.all([toB, toC])
  expect(b.scenario).toBe("b")
  expect(c.scenario).toBe("c")
  expect(b.sessionId).not.toBe(c.sessionId)
})

test("control work on a live app has the headless deadline and limit", async () => {
  const { host, startNext, hang } = gatedHost()
  const due = new Map<() => void, number>()
  const timers: Timers = {
    setTimeout: (callback, delayMs) => {
      due.set(callback, delayMs)
      return callback
    },
    clearTimeout: (handle) => {
      due.delete(handle as () => void)
    },
  }
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => undefined })
  cleanups.push(sessions.open(host, undefined))
  const controller = createLiveController(sessions, () => undefined, timers)
  cleanups.push(() => controller.close())
  await startNext()
  await controller.request("app.describe", {})
  hang()
  const calls = Array.from({ length: OUTSTANDING_CONTROL_REQUESTS_MAX + 1 }, () =>
    controller.request("app.advanceTime", { durationMs: 1 }).catch((error: unknown) => error),
  )
  await waitUntil(() => due.size === OUTSTANDING_CONTROL_REQUESTS_MAX, "each call has a deadline")
  expect([...due.values()].every((delayMs) => delayMs === CONTROL_REQUEST_TIMEOUT_MS)).toBe(true)
  for (const callback of [...due.keys()]) {
    callback()
  }
  const outcomes = await Promise.all(calls)
  expect(
    outcomes.filter((e) => (e as { code?: number }).code === ErrorCode.WaitTimeout),
  ).toHaveLength(OUTSTANDING_CONTROL_REQUESTS_MAX)
  expect(outcomes.at(-1)).toMatchObject({ code: ErrorCode.ResourceExhausted })
})

test("a provider unmounted while its app starts tells whoever was waiting", async () => {
  const { host } = gatedHost()
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => undefined })
  const close = sessions.open(host, undefined)
  const controller = createLiveController(sessions, () => undefined)
  const describing = controller.request("app.describe", {}).catch((error: unknown) => error)
  await nextTurn()
  close()
  expect(await describing).toMatchObject({ code: ErrorCode.SessionClosed })
  await controller.close()
})

test("a controller closed while a start is pending takes no subscriber", async () => {
  const { host, startNext } = gatedHost()
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => undefined })
  cleanups.push(sessions.open(host, undefined))
  const controller = createLiveController(sessions, () => undefined)
  const subscribing = controller.subscribe(() => undefined).catch((error: unknown) => error)
  await nextTurn()
  await controller.close()
  await startNext()
  expect(await subscribing).toMatchObject({ code: ErrorCode.SessionClosed })
})

test("UI resets share an ordered queue and retain their own generation", async () => {
  const { host, startNext } = gatedHost()
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => undefined })
  cleanups.push(sessions.open(host, undefined))
  await startNext()
  await sessions.settled()
  const toB = sessions.reset("b")
  const toC = sessions.reset("c")
  await startNext()
  const b = await toB
  expect(b.kind).toBe("live")
  await startNext()
  const c = await toC
  expect(c.kind).toBe("live")
  if (b.kind === "live" && c.kind === "live") {
    expect(b.session.runtime.sessionId).not.toBe(c.session.runtime.sessionId)
    expect(b.session.runtime.closed).toBe(true)
    expect(c.session.runtime.closed).toBe(false)
  }
})
