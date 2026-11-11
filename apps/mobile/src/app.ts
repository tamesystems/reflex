import app, { productionServices } from "@reflex/example-inventory"
import { legacyApp } from "@reflex/effect/internal"
import { httpInventoryApi } from "@reflex/example-inventory/http-api.ts"
import * as Layer from "effect/Layer"
import { deviceSettings } from "./settings-store.ts"

const apiUrl = __DEV__ ? process.env.EXPO_PUBLIC_INVENTORY_API : undefined
export const mobileServices = apiUrl
  ? Layer.merge(httpInventoryApi(apiUrl), deviceSettings)
  : productionServices
const scenarios = { "live-services": { layer: mobileServices } } as const
export const authoredApp = app.withScenarios(scenarios, {
  defaultScenario: apiUrl ? "live-services" : "production",
})
export default legacyApp(authoredApp)
