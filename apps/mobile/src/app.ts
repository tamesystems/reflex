import fixtureApp from "@reflex/example-inventory"
import { httpInventoryApi } from "@reflex/example-inventory/http-api.ts"
import * as Layer from "effect/Layer"
import { deviceSettings } from "./settings-store.ts"

const apiUrl = __DEV__ ? process.env.EXPO_PUBLIC_INVENTORY_API : undefined
export default apiUrl
  ? fixtureApp.withScenarios(
      {
        "live-services": {
          description:
            "Local HTTP inventory and persistent device settings; reset re-reads without seeding",
          layer: Layer.merge(httpInventoryApi(apiUrl), deviceSettings),
        },
      },
      { defaultScenario: "live-services" },
    )
  : fixtureApp
