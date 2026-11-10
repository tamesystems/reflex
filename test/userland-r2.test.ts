import { afterEach, expect, test } from "bun:test"
import { defineApp, defineCapability, defineScreen, mount } from "@reflex/effect"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createTestAppPool } from "@reflex/test"
import { createRuntime } from "@reflex/runtime/internal"
import { createStore } from "zustand/vanilla"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"
import { ROUTE_MAPPING } from "../packages/expo/src/route-token.ts"
import inventory from "../examples/inventory/src/app.ts"
import { InventoryList } from "../examples/inventory/src/features/inventory-list.ts"
import { InventoryDetail } from "../examples/inventory/src/features/inventory-detail.ts"
import { InventoryFixture } from "../examples/inventory/src/fixtures.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

test("private store changes notify guards even when public state is unchanged", () => {
  const Counter = defineStoreNode({
    name: "Private",
    type: "service",
    store: () => createStore(() => ({ count: 1, enabled: true })),
    project: ({ count }) => ({ count }),
    actions: (action) => ({
      Save: action({
        available: ({ enabled }) => (enabled ? true : "Disabled"),
        handler: () => undefined,
      }),
    }),
  })
  const store = Counter.createStore()
  const node = Counter.mount(createRuntime({ sessionId: "private" }), store)
  let stateNotifications = 0
  let guards = 0
  node.subscribe(() => {
    stateNotifications++
  })
  node.subscribeAvailability(() => {
    guards++
  })
  store.setState({ enabled: false })
  expect(stateNotifications).toBe(0)
  expect(guards).toBe(1)
  expect(node.availability("Save")).toBe("Disabled")
  node.dispose()
})

test("ignored local actions still report defects", async () => {
  const messages: unknown[] = []
  const Counter = defineStoreNode({
    name: "Broken",
    type: "service",
    store: () => createStore(() => 0),
    project: (value) => value,
    actions: (action) => ({
      Crash: action({
        handler: () => {
          throw new Error("broken action")
        },
      }),
    }),
  })
  const node = Counter.mount(
    createRuntime({ sessionId: "report", onBackgroundError: (error) => messages.push(error) }),
  )
  expect((await node.actions.Crash()).status).toBe("defect")
  expect(messages.map(String)).toEqual(["Error: Defect: broken action"])
  node.dispose()
})

test("journeys fail on refusal and domain errors, and handles read live state", async () => {
  const session = await pool.open(inventory)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity({ quantity: 12 })
  expect((await detail.state()).quantity).toBe(12)
  const fixture = await session.node(InventoryFixture)
  await fixture.actions.FailNextSave()
  await expect(detail.actions.Save()).rejects.toThrow("ApiError: Server error")
  await detail.actions.SetQuantity({ quantity: 0 })
  await expect(detail.actions.Decrement()).rejects.toThrow("refused")
  expect((await detail.expectFailure.Decrement()).status).toBe("refused")
  await detail.allowCancellation.SaveAndClose()
  await session.focused(InventoryList, { _tag: "ready" })
  await expect(detail.state()).rejects.toThrow()
})

test("mount can focus an Effect node without a navigator; BigInt's wire state is a string", async () => {
  const Counter = defineCapability({ name: "Big", state: Schema.BigInt, actions: () => ({}) })
  const host = defineApp({
    name: "effect-only",
    nodes: { Counter },
    defaultScenario: "default",
    scenarios: { default: { layer: Layer.empty } },
    root: Layer.effectDiscard(mount(Counter, 12n, { focus: true })),
  })
  const session = await pool.open(host)
  const node = await session.focused(Counter)
  expect(await node.state()).toBe("12")
})

test("URL codecs round trip transformed and optional fields; invalid params name the route", () => {
  const Detail = defineScreen({
    name: "Detail",
    state: Schema.Number,
    params: Schema.Struct({
      id: Schema.NumberFromString.check(Schema.isFinite()),
      query: Schema.optionalKey(Schema.String),
    }),
    initial: () => 0,
  }).implement({ actions: () => ({}) })
  const routes = expoRoutes(
    { screens: { Detail } },
    { Detail: { pathname: "/detail/[id]", params: { id: "id", query: "query" } } },
  )
  expect(routes.Detail.params({ id: "12" })).toEqual({ id: 12 })
  expect(routes[ROUTE_MAPPING].toHref({ route: "Detail", params: { id: "12" } })).toEqual({
    pathname: "/detail/[id]",
    params: { id: "12" },
  })
  expect(routes[ROUTE_MAPPING].fromLocation(["detail", "[id]"], { id: "12" })).toEqual({
    route: "Detail",
    params: { id: "12" },
  })
  expect(() => routes.Detail.params({ id: "invalid" })).toThrow(
    'Route "Detail" has invalid URL params',
  )
})

test("store app membership includes router-mounted definitions without eagerly mounting them", async () => {
  const Route = defineStoreNode({
    name: "Route",
    store: () => createStore(() => 0),
    project: (value) => value,
    actions: () => ({}),
  })
  const host = defineStoreApp({ name: "routes", routes: { Route } })
  expect(host.nodes.Route).toBe(Route)
  const session = await host.start("default", { sessionId: "routes" })
  expect(session.runtime.inspect().node).toBeNull()
  await session.dispose()
})
