import { defineApp } from "@reflex/effect"
import * as Layer from "effect/Layer"
import { httpInventoryApi } from "./http-api.ts"
import { memorySettings } from "./settings-store.ts"
import { InventoryListLive } from "./features/inventory-list.ts"
import { InventoryDetailLive } from "./features/inventory-detail.ts"
import { SettingsLive } from "./features/settings.ts"
import { InventoryList } from "./screens.ts"
import { Nav } from "./navigation.ts"

export default defineApp({
  name: "inventory",
  navigation: Nav.implement([InventoryListLive, InventoryDetailLive, SettingsLive], {
    initial: InventoryList,
  }),
  defaultScenario: "live-services",
  scenarios: {
    "live-services": {
      description: "Local HTTP inventory and in-memory settings",
      layer: Layer.merge(httpInventoryApi("http://127.0.0.1:4318"), memorySettings),
    },
  },
})
