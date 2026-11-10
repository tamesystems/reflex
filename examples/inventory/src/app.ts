import { defineApp } from "@reflex/effect"
import * as Layer from "effect/Layer"
import {
  fixtureApi,
  fixtureSettings,
  seedProducts,
  InventoryFixture,
  type ScenarioOptions,
} from "./fixtures.ts"
import { InventoryList } from "./features/inventory-list.ts"
import { InventoryDetail } from "./features/inventory-detail.ts"
import { Settings } from "./features/settings.ts"
import { Nav } from "./navigation.ts"

const services = (options: ScenarioOptions) => Layer.merge(fixtureApi(options), fixtureSettings)

export default defineApp({
  name: "inventory",
  navigation: Nav.implement(
    { InventoryList, InventoryDetail, Settings },
    { initial: "InventoryList" },
  ),
  fixtures: { InventoryFixture },
  defaultScenario: "inventory-with-products",
  scenarios: {
    "inventory-with-products": {
      description: "Three products, saves succeed immediately",
      layer: services({ products: seedProducts }),
    },
    "empty-inventory": {
      description: "No products at all",
      layer: services({ products: [] }),
    },
    "sluggish-network": {
      description: "Saves take 1 second, on virtual time",
      virtualTime: true,
      layer: services({ products: seedProducts, saveDelay: "1 second" }),
    },
    "slow-network": {
      description: "Saves take 30 seconds, on virtual time",
      virtualTime: true,
      layer: services({ products: seedProducts, saveDelay: "30 seconds" }),
    },
  },
})
