import { createTestApp, createTestAppPool, includes } from "../src/index.ts"
import { authoredApp as app } from "../../../examples/inventory/src/scenarios.ts"
import { InventoryList, InventoryDetail } from "../../../examples/inventory/src/screens.ts"
import { InventoryFixture } from "../../../examples/inventory/src/fixtures.ts"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

declare const scenario: "live-services" | "inventory-with-products"
async function assertions() {
  // @ts-expect-error unknown scenario
  await createTestApp(app, { scenario: "typo" })
  // @ts-expect-error pool also checks scenario names
  await createTestAppPool().open(app, { scenario: "typo" })
  await using live = await createTestApp(app, { scenario: "live-services" })
  // @ts-expect-error real-time scenario
  await live.advanceTime("1 second")
  // @ts-expect-error fixture absent in live-services
  await live.node(InventoryFixture)
  const union = await createTestApp(app, { scenario })
  // @ts-expect-error fixture must be in every possible scenario
  await union.node(InventoryFixture)
  // @ts-expect-error union includes a real-time scenario
  await union.advanceTime(1)
  // @ts-expect-error fixture absent in live-services
  await live.fixture(InventoryFixture)
  // @ts-expect-error fixture is not a service
  await live.service(InventoryFixture)
  // @ts-expect-error includes uses the expected element type
  await live.focused(InventoryList, { _tag: "ready", products: includes({ id: "p", qty: 5 }) })
  // @ts-expect-error match must fit one variant
  await live.focused(InventoryList, { _tag: "loading", products: includes({ id: "p" }) })
  const list = await live.focused(InventoryList, { _tag: "ready" })
  // @ts-expect-error checked action input
  await list.actions.OpenProduct({ productID: "p" })
  // @ts-expect-error declared input is required
  await list.actions.OpenProduct.start()
  // @ts-expect-error params required
  await live.open(InventoryDetail)
  // @ts-expect-error wrong route param
  await live.open(InventoryDetail, { productID: "p" })
  const slow = await live.reset("slow-network")
  await slow.advanceTime("5 seconds")
  await slow.fixture(InventoryFixture)
  const detail = await slow.focused(InventoryDetail, { _tag: "editing" })
  const error = await detail.actions.Save.expectError()
  const tag: "ApiError" | "SaveTimedOut" = error.error._tag
  void tag
  // @ts-expect-error zero arity
  await detail.actions.Save({})
  // @ts-expect-error unknown scenario on reset
  await slow.reset("typo")
}
const StoreScreen = defineStoreNode({
  name: "StoreScreen",
  params: z.object({ id: z.string().transform(Number) }),
  store: ({ id }) => createStore(() => ({ id })),
  actions: () => ({}),
})
async function storeAssertions() {
  await using session = await createTestApp(
    defineStoreApp({ name: "store", screens: [StoreScreen] }),
  )
  await session.open(StoreScreen, { id: "p" })
  // @ts-expect-error one-way store params accept the validator input, not its decoded output
  await session.open(StoreScreen, { id: 1 })
  // @ts-expect-error route params required
  await session.open(StoreScreen)
  // @ts-expect-error store scenario uses real time
  await session.advanceTime(1)
}
void assertions
void storeAssertions
