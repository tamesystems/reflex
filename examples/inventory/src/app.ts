import { defineApp, mount } from "@reflex/effect"
import * as Layer from "effect/Layer"
import { InventoryDetail, initialState as detailState } from "./features/inventory-detail.ts"
import { InventoryList, initialState as listState } from "./features/inventory-list.ts"
import { Settings, initialState as settingsState } from "./features/settings.ts"
import { fixtureApi, fixtureSettings, seedProducts } from "./fixtures.ts"
import { Nav } from "./navigation.ts"

export const root = Nav.layer({
  initial: { route: "InventoryList", params: {} },
  screens: {
    InventoryList: () => mount(InventoryList, listState),
    InventoryDetail: ({ productId }) => mount(InventoryDetail, detailState(productId)),
    Settings: () => mount(Settings, settingsState),
  },
})

const services = (options: Parameters<typeof fixtureApi>[0]) =>
  Layer.merge(fixtureApi(options), fixtureSettings)

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
