import { expect, test } from "bun:test"
import { createTestApp, connectJourney, explore, includes } from "@reflex/test"
import { nextTurn } from "../test/support.ts"
import {
  createProtocolTestSession,
  protocolEvents,
  createJourneyClient,
} from "@reflex/test/advanced"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { Screen, defineApp } from "@reflex/effect"
import {
  createController,
  systemTimers,
  createRuntime,
  registerRouteFactories,
  type Timers,
  type AppHost,
} from "@reflex/runtime/internal"
import { createLoopbackClient, serveSocket, sessionEndpoint } from "@reflex/rpc"
import { preparePrivateDirectory } from "@reflex/rpc/windows-security"
import { ErrorCode, toNodeId } from "@reflex/protocol"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "zustand/vanilla"
import { z } from "zod"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"
import app from "../examples/inventory/src/app.ts"
import inventory from "../examples/inventory/src/scenarios.ts"
import { InventoryList, InventoryDetail } from "../examples/inventory/src/screens.ts"
import { InventoryFixture } from "../examples/inventory/src/fixtures.ts"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import { createLiveController } from "../packages/live/src/live-controller.ts"
import { LiveSessions } from "../packages/live/src/live-sessions.ts"

const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => ({ count: 0 })),
  actions: (a) => ({
    Set: a({ input: z.number(), handler: (count, { store }) => store.setState({ count }) }),
    Reject: a({
      error: z.object({ _tag: z.literal("Rejected") }),
      handler: (_, { fail }) => fail({ _tag: "Rejected" }),
    }),
    Crash: a({
      handler: () => {
        throw new Error("crash")
      },
    }),
    Unavailable: a({ available: () => "disabled", handler: () => {} }),
  }),
})
const counterApp = defineStoreApp({ name: "test-counter", services: [Counter] })

test("one actions map asserts declared errors and refusals, fails defects, and publishes run outcomes", async () => {
  await using session = await createTestApp(counterApp)
  const counter = await session.service(Counter)
  await counter.actions.Set(3)
  expect(await counter.state()).toEqual({ count: 3 })
  expect(await counter.actions.Reject.expectError()).toEqual({
    status: "error",
    error: { _tag: "Rejected" },
  })
  expect(await counter.actions.Reject.run()).toEqual({
    status: "error",
    error: { _tag: "Rejected" },
  })
  expect(await counter.actions.Unavailable.expectRefusal()).toEqual({
    status: "refused",
    reason: "disabled",
  })
  await expect(counter.actions.Reject()).rejects.toThrow("domain-error")
  await expect(counter.actions.Crash()).rejects.toThrow("crash")
  await expect(counter.actions.Unavailable()).rejects.toThrow("disabled")
  const refused = await counter.actions.Unavailable.start()
  expect(await refused.expectRefusal()).toEqual({ status: "refused", reason: "disabled" })
  await expect(refused.completed()).rejects.toThrow("disabled")
})

test("operation handles await, cancel, and explicitly allow navigation cancellation", async () => {
  await using session = await createTestApp(inventory, { scenario: "sluggish-network" })
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  const saving = await detail.actions.Save.start()
  await saving.cancel()
  expect(await saving.cancelled()).toEqual({ status: "cancelled" })
  await expect(saving.completed()).rejects.toThrow("cancelled")
  await saving.completed({ allowCancellation: true })
  expect(
    protocolEvents(session).some(
      (event) => event.type === "operation.finished" && event.operation.operationId === saving.id,
    ),
  ).toBe(true)
  await session.back()
  await list.actions.OpenProduct({ productId: "product-123" })
  const reopened = await session.focused(InventoryDetail, { _tag: "editing" })
  const leaving = await reopened.actions.Save.start()
  await session.back()
  await leaving.completed({ allowCancellation: true })
})

test("reset returns a new scenario client, revokes old clients and handles, and retains disposer ownership", async () => {
  await using session = await createTestApp(inventory)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  const next = await session.reset("empty-inventory")
  expect(next.scenario).toBe("empty-inventory")
  await expect(session.focused(InventoryList)).rejects.toThrow("reset")
  await expect(list.state()).rejects.toThrow()
  const empty = await next.focused(InventoryList, { _tag: "ready" })
  expect((await empty.state()).products).toEqual([])
  const live = await next.reset("production")
  // JavaScript callers get the same membership check as TypeScript callers.
  await expect(
    (live.fixture as (d: unknown) => Promise<unknown>)(InventoryFixture),
  ).rejects.toThrow("does not belong")
})

test("match timeout diagnostics contain the last state, including includes matches", async () => {
  await using session = await createTestApp(inventory, { timeoutMs: 20 })
  await expect(
    session.focused(InventoryList, { _tag: "ready", lowStockThreshold: 999 }),
  ).rejects.toThrow("last state:")
  await expect(
    session.focused(InventoryList, { products: includes({ id: "missing" }) }),
  ).rejects.toThrow("Blue T-Shirt")
})

const HostDetail = defineStoreNode({
  name: "HostDetail",
  params: z.object({ id: z.string().transform((id) => id.toUpperCase()) }),
  store: ({ id }) => createStore(() => ({ id })),
  actions: () => ({}),
})
class EffectDetail extends Screen("EffectDetail", {
  state: Schema.Struct({ id: Schema.String }),
  params: { id: Schema.NumberFromString },
  initial: ({ id }) => ({ id: String(id) }),
}) {}
const effectApp = defineApp({
  name: "host-effect",
  screens: [
    EffectDetail.implement({
      actions: (a) => ({ Keep: a.reduce({ reducer: (_, state) => state }) }),
      onFocus: () => Effect.void,
    }),
  ],
})
test("open mounts scenario-local store and Effect host routes through the protocol", async () => {
  await using store = await createTestApp(
    defineStoreApp({ name: "host-store", screens: [HostDetail] }),
  )
  expect(await (await store.open(HostDetail, { id: "one" })).state()).toEqual({ id: "ONE" })
  await expect(
    store.raw.request("app.open", { name: "HostDetail", params: { id: 1 } }),
  ).rejects.toMatchObject({ code: ErrorCode.InvalidInput })
  await using effect = await createTestApp(effectApp)
  expect(await (await effect.open(EffectDetail, { id: 2 })).state()).toEqual({ id: "2" })
})

test("raw session parses malformed requests and exposes operation ids and recorded events", async () => {
  await using session = await createProtocolTestSession(counterApp)
  await expect(session.request("app.dispatch", { action: 123 })).rejects.toMatchObject({
    code: ErrorCode.InvalidParams,
  })
  await expect(session.request("app.operation", { operationId: "missing" })).rejects.toMatchObject({
    code: ErrorCode.OperationNotFound,
  })
  const operation = (await session.request("app.dispatch", { action: "Set", input: 7 })) as {
    operationId: string
  }
  await session.request("app.wait", { operationId: operation.operationId })
  expect(
    session
      .events()
      .some(
        (event) =>
          event.type === "operation.finished" &&
          event.operation.operationId === operation.operationId,
      ),
  ).toBe(true)
})

test("Duration.Input values drive virtual scenarios", async () => {
  await using session = await createTestApp(inventory, { scenario: "slow-network" })
  for (const duration of [
    Duration.millis(1),
    "1 milli",
    1_000_000n,
    [0, 1_000_000],
    { milliseconds: 1 },
  ] as const) {
    await session.advanceTime(duration)
  }
})

test("keyed exploration checks ambient services before and after actions", async () => {
  const result = await explore(counterApp, {
    steps: 3,
    runCount: 1,
    inputs: { Counter: { Set: [2] } },
    invariants: { Counter: (state) => (state.count === 0 ? "zero" : undefined) },
  })
  expect(result.failure?.message).toBe("zero")
  const checked = await explore(counterApp, {
    steps: 1,
    runCount: 1,
    inputs: { Counter: { Set: [2] } },
    invariants: {
      Counter: (state) => {
        expect(state).toHaveProperty("count")
        return undefined
      },
    },
  })
  expect(checked.failure).toBeUndefined()
})

test("advanced request transport owns disposal and runs the same typed client", async () => {
  const controller = await createController(counterApp)
  const client = createLoopbackClient(controller)
  let disposed = 0
  try {
    await using session = createJourneyClient(counterApp, "default", {
      request: (method, params) =>
        (client.request as (m: string, p: unknown) => Promise<unknown>)(method, params),
      close: async () => {
        disposed++
        client.close()
      },
    })
    await (await session.service(Counter)).actions.Set(8)
    expect(await (await session.service(Counter)).state()).toEqual({ count: 8 })
  } finally {
    await controller.close()
  }
  expect(disposed).toBe(1)
})

const onTarget = async (host: AppHost, body: () => Promise<void>, live = false) => {
  const parent = mkdtempSync(join(tmpdir(), "reflex-journey-"))
  const directory = join(parent, "private")
  preparePrivateDirectory({ directory })
  const previous = process.env.REFLEX_DIR
  process.env.REFLEX_DIR = directory
  const secret = "a".repeat(64)
  writeFileSync(join(directory, "device.auth"), secret)
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => {} })
  const release = live ? sessions.open(host, undefined) : () => {}
  const controller = live ? createLiveController(sessions, () => {}) : await createController(host)
  const server = await serveSocket(
    controller,
    sessionEndpoint(directory, "device"),
    process.platform === "win32" ? { localSecret: secret } : {},
  )
  try {
    await body()
  } finally {
    await controller.close()
    release()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    if (previous === undefined) {
      delete process.env.REFLEX_DIR
    } else {
      process.env.REFLEX_DIR = previous
    }
    rmSync(parent, { recursive: true, force: true })
  }
}
for (const live of [false, true]) {
  test(`connectJourney matches instrumented descriptors (${live ? "live" : "session"})`, async () => {
    const host = inventory[APP_HOST_ADAPTER]
    await onTarget(
      host,
      async () => {
        await using session = await connectJourney(
          app.withScenarios({
            "inventory-with-products": {
              layer: inventory.scenarios["inventory-with-products"].layer,
              fixtures: [InventoryFixture],
            },
          }),
          { target: "device", scenario: "inventory-with-products" },
        )
        await session.focused(InventoryList, { _tag: "ready" })
        expect((await session.fixture(InventoryFixture)).id).toContain("InventoryFixture")
        const changed = defineStoreApp({ name: "inventory", services: [Counter] })
        await expect(connectJourney(changed, { target: "device" })).rejects.toThrow(
          "descriptor mismatch",
        )
      },
      live,
    )
  })
}

for (const live of [false, true]) {
  test(`remote open uses the active host's screen factories (${live ? "live" : "session"})`, async () => {
    const app = defineStoreApp({ name: "remote-host", screens: [HostDetail] })
    await onTarget(
      app,
      async () => {
        await using session = await connectJourney(app, { target: "device" })
        expect(await (await session.open(HostDetail, { id: "remote" })).state()).toEqual({
          id: "REMOTE",
        })
      },
      live,
    )
  })
}

test("connectJourney rejects a changed input schema with the same app, node and action names", async () => {
  const Changed = defineStoreNode({
    name: "Counter",
    store: () => createStore(() => ({ count: 0 })),
    actions: (a) => ({ Set: a({ input: z.string(), handler: () => {} }) }),
  })
  const changed = defineStoreApp({ name: "test-counter", services: [Changed] })
  await onTarget(counterApp, async () => {
    await expect(connectJourney(changed, { target: "device" })).rejects.toThrow(
      "descriptor mismatch",
    )
    await using session = await connectJourney(counterApp, { target: "device" })
    await (await session.service(Counter)).actions.Set(4)
    expect(await (await session.service(Counter)).state()).toEqual({ count: 4 })
  })
})

test("an open that outlives its control deadline disposes the late route without focusing it", async () => {
  const pending = new Set<() => void>()
  const timers: Timers = {
    setTimeout: (callback) => {
      pending.add(callback)
      return callback
    },
    clearTimeout: (handle) => {
      pending.delete(handle as () => void)
    },
  }
  const late = Promise.withResolvers<{ id: ReturnType<typeof toNodeId>; dispose(): void }>()
  const runtime = createRuntime({ sessionId: "late-route" })
  registerRouteFactories(runtime, new Map([[HostDetail, () => late.promise]]))
  const host: AppHost & { screens: { HostDetail: typeof HostDetail } } = {
    name: "late-route",
    defaultScenario: "default",
    scenarios: [{ name: "default", virtualTime: false }],
    screens: { HostDetail },
    start: async () => ({
      runtime,
      dispose: async () => {
        runtime.close()
      },
    }),
  }
  const controller = await createController(host, { timers, onBackgroundError: () => {} })
  try {
    const opened = controller.request("app.open", { name: "HostDetail", params: { id: "late" } })
    void opened.catch(() => {})
    await nextTurn()
    for (const expire of [...pending]) {
      expire()
    }
    await expect(opened).rejects.toMatchObject({ code: ErrorCode.WaitTimeout })
    let disposed = 0
    late.resolve({
      id: toNodeId("late"),
      dispose: () => {
        disposed++
      },
    })
    await nextTurn()
    expect(disposed).toBe(1)
    expect(runtime.focus).toBeNull()
  } finally {
    await controller.close()
  }
})
