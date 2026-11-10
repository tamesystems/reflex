import { afterEach, expect, test } from "bun:test"
import { ErrorCode, SUBSCRIBERS_MAX } from "@reflex/protocol"
import { createTestAppPool } from "@reflex/test"
import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import { z } from "zod"
import { createStore } from "zustand/vanilla"
import app from "../examples/inventory/src/app.ts"
import { InventoryList } from "../examples/inventory/src/features/inventory-list.ts"
import { InventoryDetail } from "../examples/inventory/src/features/inventory-detail.ts"
import { Nav } from "../examples/inventory/src/navigation.ts"
import { QUANTITY_MAX } from "../examples/inventory/src/domain.ts"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

test("typed journey actions expose declared data and guard refusals", async () => {
  const session = await pool.open(app)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  expect(list.state.products[0]?.id).toBe("product-123")
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity({ quantity: QUANTITY_MAX })
  expect(await detail.actions.Increment()).toMatchObject({
    status: "refused",
    code: ErrorCode.ActionUnavailable,
    reason: "Quantity is already at its maximum",
  })
  await session.dispatchRaw("FailNextSave")
  const outcome = await detail.actions.Save()
  expect(outcome.status).toBe("domain-error")
  if (outcome.status === "domain-error") {
    const tag: "ApiError" | undefined = outcome.error.data?._tag
    expect(tag).toBe("ApiError")
    expect(outcome.error.data?.message).toBe("Server error")
  }
})

test("store handles retain transformed inputs, projected state, errors and focus availability", async () => {
  const Counter = defineStoreNode({
    name: "Counter",
    store: () => createStore(() => ({ count: 0, token: "private" })),
    project: ({ count }) => ({ count }),
    actions: (action) => ({
      Set: action({
        input: standardInput(z.string().transform(Number)),
        handler: (count, { store }) => store.setState({ count }),
      }),
      Refuse: action({
        error: standardInput(z.strictObject({ _tag: z.literal("Rejected"), message: z.string() })),
        handler: (_, { fail }) => fail({ _tag: "Rejected", message: "Try again" }),
      }),
      Crash: action({
        handler: () => {
          throw new Error("bug")
        },
      }),
    }),
  })
  const host = defineStoreApp({ name: "counter", nodes: { Counter } })
  const extended = host.withScenarios(
    {
      full: {
        description: "Seeded counter",
        stores: { Counter: () => createStore(() => ({ count: 99, token: "private" })) },
      },
    },
    { defaultScenario: "full" },
  )
  const seeded = await pool.open(extended, { scenario: "full" })
  expect((await seeded.node(Counter)).state).toEqual({ count: 99 })
  await seeded.reset("default")
  expect((await seeded.node(Counter)).state).toEqual({ count: 0 })
  const session = await host.start("default", { sessionId: "store-contract" })
  try {
    const node = Counter.resolve(session.runtime)
    expect(node).toBeDefined()
    if (node === undefined) {
      throw new Error("Counter must be mounted")
    }
    expect(await node.actions.Set("12")).toEqual({ status: "completed" })
    expect(node.getSnapshot()).toEqual({ count: 12 })
    expect(await node.actions.Refuse()).toMatchObject({
      status: "domain-error",
      error: { data: { _tag: "Rejected", message: "Try again" } },
    })
    expect(await node.actions.Crash()).toMatchObject({
      status: "defect",
      error: { message: "bug" },
    })
    let changed = 0
    const stop = node.subscribeAvailability(() => changed++)
    const localListeners = Array.from({ length: SUBSCRIBERS_MAX + 1 }, () =>
      node.subscribeAvailability(() => undefined),
    )
    const revision = session.runtime.inspect({ nodeId: node.id }).node?.revision
    session.runtime.setFocus(null)
    expect(session.runtime.inspect({ nodeId: node.id }).node?.revision).toBe(revision)
    for (const unsubscribe of localListeners) {
      unsubscribe()
    }
    expect(changed).toBeGreaterThan(0)
    expect(node.availability("Set")).toBe("The screen is not focused")
    expect(await node.actions.Set("13")).toMatchObject({
      status: "refused",
      code: ErrorCode.ActionUnavailable,
    })
    stop()
  } finally {
    await session.dispose()
  }
})

test("Expo registration derives both directions and validates renamed incoming params", () => {
  const routes = expoRoutes(Nav, {
    InventoryList: "/",
    InventoryDetail: { pathname: "/inventory/[sku]", params: { productId: "sku" } },
    Settings: "/settings",
  })
  expect(routes.toHref({ route: "InventoryDetail", params: { productId: "a/b" } })).toEqual({
    pathname: "/inventory/[sku]",
    params: { sku: "a/b" },
  })
  expect(routes.fromLocation(["inventory", "[sku]"], { sku: ["a/b", "ignored"] })).toEqual({
    route: "InventoryDetail",
    params: { productId: "a/b" },
  })
  expect(routes.fromLocation(["inventory", "[sku]"], {})).toBeNull()
  expect(routes.fromLocation(["unknown"], {})).toBeNull()
  expect(() => routes.toHref({ route: "InventoryDetail", params: { productId: 12 } })).toThrow()
})

test("route binding compares encoded params after decoding an incoming transform", async () => {
  const { defineCapability, defineNavigation } = await import("@reflex/effect")
  const Schema = await import("effect/Schema")
  const Detail = defineCapability({
    name: "NumericDetail",
    state: Schema.Number,
    params: Schema.Struct({ id: Schema.NumberFromString }),
    initial: () => 0,
    actions: () => ({}),
  })
  const navigation = defineNavigation("numeric-routes", () => ({ Detail }))
  const routes = expoRoutes(navigation, {
    Detail: { pathname: "/detail/[sku]", params: { id: "sku" } },
  })
  expect(routes.Detail.params({ sku: "42" })).toEqual({ id: 42 })
  expect(routes.Detail.encodedParams({ sku: "42" })).toEqual({ id: "42" })
  expect(routes.fromLocation(["detail", "[sku]"], { sku: "42" })).toEqual({
    route: "Detail",
    params: { id: "42" },
  })
})

test("typed focused access selects the top instance when screen names repeat", async () => {
  const session = await pool.open(app)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const lower = await session.focused(InventoryDetail, { _tag: "editing" })
  await session.dispatchRaw("Navigate", {
    route: "InventoryDetail",
    params: { productId: "product-123" },
  })
  const upper = await session.focused(InventoryDetail, { _tag: "editing" })
  expect(upper.id).not.toBe(lower.id)
  await upper.actions.SetQuantity({ quantity: 12 })
  await session.back()
  const restored = await session.focused(InventoryDetail, { _tag: "editing" })
  expect(restored.id).toBe(lower.id)
  expect(restored.state.quantity).toBe(5)
})

test("Effect actions accept encoded inputs locally and in journeys, decoding once for handlers", async () => {
  const { defineApp, defineCapability, mount } = await import("@reflex/effect")
  const Effect = await import("effect/Effect")
  const Layer = await import("effect/Layer")
  const Schema = await import("effect/Schema")
  const Parsed = defineCapability({
    name: "Parsed",
    type: "service",
    state: Schema.Number,
    actions: (action) => ({
      Set: action({
        input: Schema.NumberFromString,
        handler: (value, state) => state.update(() => value),
      }),
    }),
  })
  const host = defineApp({
    name: "parsed",
    nodes: { Parsed },
    defaultScenario: "default",
    scenarios: { default: { layer: Layer.empty } },
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Parsed, 0)
        expect(yield* Effect.promise(() => node.actions.Set("12"))).toEqual({ status: "completed" })
        expect(node.getSnapshot()).toBe(12)
      }),
    ),
  })
  const session = await pool.open(host)
  const node = await session.node(Parsed)
  expect(node.state).toBe(12)
  expect(await node.actions.Set("13")).toEqual({ status: "completed" })
  expect((await session.node(Parsed)).state).toBe(13)
})
