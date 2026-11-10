import { afterEach, expect, test } from "bun:test"
import { createTestAppPool, includes } from "@reflex/test"
import app from "../src/app.ts"
import { InventoryList } from "../src/features/inventory-list.ts"
import { InventoryDetail } from "../src/features/inventory-detail.ts"
import { InventoryFixture } from "../src/fixtures.ts"
import { servicesJourney } from "../journeys/services.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

test("a user edits and saves a product, then sees the updated list", async () => {
  const session = await pool.open(app)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity({ quantity: 12 })
  expect((await detail.state()).quantity).toBe(12)
  await detail.actions.Save()
  await session.back()
  await session.focused(InventoryList, { products: includes({ id: "product-123", quantity: 12 }) })
})

test("a server failure leaves the user's edits available for retry", async () => {
  const session = await pool.open(app)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity({ quantity: 19 })
  const fixture = await session.node(InventoryFixture)
  await fixture.actions.FailNextSave()
  expect(await detail.expectFailure.Save()).toMatchObject({
    status: "domain-error",
    error: { tag: "ApiError" },
  })
  expect((await detail.state()).error).toBe("Server error")
  await detail.actions.Save()
  expect((await detail.state()).error).toBeNull()
})

test("the same behavior story runs with fixture layers and real services", async () => {
  const session = await pool.open(app)
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave()
  })
})
