import { includes, type JourneyClientFor } from "@reflex/test"
import type inventoryApp from "../src/app.ts"
import { InventoryList } from "../src/features/inventory-list.ts"
import { InventoryDetail } from "../src/features/inventory-detail.ts"
import { Settings } from "../src/features/settings.ts"

/** The same typed story runs against fixtures and the live CLI transport. */
export const servicesJourney = async (
  app: JourneyClientFor<typeof inventoryApp>,
  failNextSave: () => Promise<void>,
): Promise<void> => {
  const list = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 5 }),
  })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await app.focused(InventoryDetail, {
    _tag: "editing",
    title: "Blue T-Shirt",
    quantity: 5,
  })
  await detail.actions.SetQuantity({ quantity: 12 })
  await detail.actions.Save()
  await app.back()
  const updated = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await updated.actions.OpenProduct({ productId: "product-123" })
  const reopened = await app.focused(InventoryDetail, {
    _tag: "editing",
    quantity: 12,
    error: null,
  })
  await reopened.actions.SetQuantity({ quantity: 19 })
  await failNextSave()
  await reopened.expectFailure.Save()
  await app.focused(InventoryDetail, { _tag: "editing", quantity: 19, error: "Server error" })
  await app.back()
  const saved = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await saved.actions.OpenSettings()
  const settings = await app.focused(Settings, { _tag: "ready" })
  await settings.actions.SetLowStockThreshold({ threshold: 3 })
  await app.back()
  const refreshed = await app.focused(InventoryList, { lowStockThreshold: 3 })
  await refreshed.actions.OpenSettings()
  await app.focused(Settings, { lowStockThreshold: 3 })
}
