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
  Layer.succeed(
    InventoryApi,
    InventoryApi.of({
      list: Effect.succeed([]),
      get: () => Effect.fail(new ApiError({ message: "No inventory API configured" })),
      saveQuantity: () => Effect.fail(new ApiError({ message: "No inventory API configured" })),
    }),
  ),
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
      description: "Offline inventory and in-memory settings",
      layer: productionServices,
    },
  },
})
