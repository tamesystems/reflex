import { defineApp } from "@reflex/effect"
import * as Layer from "effect/Layer"
import { ApiError, InventoryApi } from "./domain.ts"
import * as Effect from "effect/Effect"
import { memorySettings } from "./settings-store.ts"
import { InventoryListLive } from "./features/inventory-list.ts"
import { InventoryDetailLive } from "./features/inventory-detail.ts"
import { SettingsLive } from "./features/settings.ts"
import { InventoryList } from "./screens.ts"
import { Nav } from "./navigation.ts"

export const productionServices = Layer.merge(
  Layer.sync(InventoryApi, () => {
    const products = new Map([
      ["product-123", { id: "product-123", title: "Blue T-Shirt", quantity: 5 }],
      ["product-456", { id: "product-456", title: "Grey Hoodie", quantity: 40 }],
      ["product-789", { id: "product-789", title: "Canvas Tote", quantity: 2 }],
    ])
    return InventoryApi.of({
      list: Effect.sync(() => [...products.values()]),
      get: (id) =>
        Effect.suspend(() => {
          const product = products.get(id)
          return product === undefined
            ? Effect.fail(new ApiError({ message: `No product "${id}"` }))
            : Effect.succeed(product)
        }),
      saveQuantity: (id, quantity) =>
        Effect.suspend(() => {
          const product = products.get(id)
          if (product === undefined) {
            return Effect.fail(new ApiError({ message: `No product "${id}"` }))
          }
          products.set(id, { ...product, quantity })
          return Effect.void
        }),
    })
  }),
  memorySettings,
)

export default defineApp({
  name: "inventory",
  navigation: Nav.implement([InventoryListLive, InventoryDetailLive, SettingsLive], {
    initial: InventoryList,
  }),
  defaultScenario: "production",
  scenarios: {
    production: {
      description: "Offline in-memory inventory and settings; rebuilt on reset",
      layer: productionServices,
    },
  },
})
