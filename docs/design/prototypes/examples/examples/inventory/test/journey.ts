import { expect, test } from "bun:test"
import { connectJourney, createTestApp, includes } from "@reflex/test"
import app from "../src/scenarios.ts"
import { InventoryList, InventoryDetail } from "../src/screens.ts"
import { InventoryFixture } from "../src/fixtures.ts"
import { servicesJourney } from "../journeys/services.ts"

test("one story through headless services", async () => {
  await using session = await createTestApp(app, { scenario: "inventory-with-products" })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave.expectCompleted()
  })
})

test("slow save times out without losing edits", async () => {
  await using session = await createTestApp(app, { scenario: "slow-network" })
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct.expectCompleted({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity.expectCompleted({ quantity: 12 })
  const saving = await detail.actions.Save.start()
  await session.focused(InventoryDetail, { _tag: "saving" })
  await session.advanceTime("5 seconds")
  expect(await saving.expectError()).toMatchObject({ status: "error" })
  await session.focused(InventoryDetail, { _tag: "editing", quantity: 12, error: "Save timed out" })
  await session.back()
  await session.focused(InventoryList, { products: includes({ id: "product-123", quantity: 5 }) })
})

test.skipIf(process.env.REFLEX_LIVE !== "1")("the same story through the device", async () => {
  await using session = await connectJourney(app, {
    target: "device",
    scenario: "inventory-with-products",
  })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave.expectCompleted()
  })
})
