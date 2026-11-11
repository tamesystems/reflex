import type { ReactNode } from "react"
import * as Layer from "effect/Layer"
import {
  fixtureApi,
  fixtureSettings,
  InventoryFixture,
  seedProducts,
} from "@reflex/example-inventory/fixtures.ts"
import app from "../src/app.ts"
import { testScenarios } from "@reflex/example-inventory/scenarios.ts"
import { Provider } from "../src/routes.ts"

const e2e = {
  e2e: {
    layer: Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings),
    fixtures: [InventoryFixture],
  },
}
const instrumented = app.withScenarios(
  { ...testScenarios, ...e2e },
  { defaultScenario: "e2e", fixtures: [InventoryFixture] },
)
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <Provider app={instrumented} fallback={null} bridge="development">
      {children}
    </Provider>
  )
}
