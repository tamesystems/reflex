import fixtureApp, { root } from "@reflex/example-inventory"
import { defineApp } from "@reflex/effect"
import { httpInventoryApi } from "@reflex/example-inventory/http-api.ts"
import * as Layer from "effect/Layer"
import { deviceSettings } from "./settings-store.ts"

const apiUrl = __DEV__ ? process.env.EXPO_PUBLIC_INVENTORY_API : undefined
const liveApp = apiUrl
  ? defineApp({
      name: fixtureApp.name,
      root,
      defaultScenario: "live-services",
      scenarios: {
        "live-services": {
          description:
            "Local HTTP inventory and persistent device settings; reset re-reads without seeding",
          layer: Layer.merge(httpInventoryApi(apiUrl), deviceSettings),
        },
      },
    })
  : undefined

export default liveApp
  ? {
      ...fixtureApp,
      defaultScenario: liveApp.defaultScenario,
      scenarios: [...fixtureApp.scenarios, ...liveApp.scenarios],
      start: (name: string, options: Parameters<typeof fixtureApp.start>[1]) =>
        name === "live-services" ? liveApp.start(name, options) : fixtureApp.start(name, options),
    }
  : fixtureApp
