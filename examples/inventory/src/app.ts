import { defineApp, withNodes } from "@reflex/effect"
import * as Layer from "effect/Layer"
import { fixtureApi, fixtureSettings, seedProducts, InventoryFixture } from "./fixtures.ts"
import { InventoryList } from "./features/inventory-list.ts"
import { InventoryDetail } from "./features/inventory-detail.ts"
import { Settings } from "./features/settings.ts"
import { Nav } from "./navigation.ts"

export const screens = { InventoryList, InventoryDetail, Settings }
export const root = Nav.layer({
  screens,
  initial: { route: "InventoryList", params: {} },
})

const services = (options: Parameters<typeof fixtureApi>[0]) =>
  withNodes(Layer.merge(fixtureApi(options), fixtureSettings), { InventoryFixture })

export default defineApp({
  name: "inventory",
  root,
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
