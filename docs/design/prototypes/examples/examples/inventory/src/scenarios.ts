import * as Layer from "effect/Layer"
import app from "./app.ts"
import { httpInventoryApi } from "./http-api.ts"
import { memorySettings } from "./settings-store.ts"
import { fixtureApi, fixtureSettings, seedProducts, InventoryFixture } from "./fixtures.ts"

const services = (products: typeof seedProducts, saveDelay?: "1 second" | "30 seconds") =>
  Layer.merge(
    fixtureApi({ products, ...(saveDelay === undefined ? {} : { saveDelay }) }),
    fixtureSettings,
  )
export const testScenarios = {
  "live-services": {
    layer: Layer.merge(httpInventoryApi("http://127.0.0.1:4318"), memorySettings),
    fixtures: [],
  },
  "inventory-with-products": { description: "Three products", layer: services(seedProducts) },
  "empty-inventory": { description: "No products", layer: services([]) },
  "slow-network": {
    description: "Save exceeds deadline",
    layer: services(seedProducts, "30 seconds"),
    virtualTime: true,
  },
  "sluggish-network": {
    description: "Save in flight",
    layer: services(seedProducts, "1 second"),
    virtualTime: true,
  },
} as const
export default app.withScenarios(testScenarios, {
  defaultScenario: "inventory-with-products",
  fixtures: [InventoryFixture],
})
