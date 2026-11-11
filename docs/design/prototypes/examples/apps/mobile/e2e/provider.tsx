import type { ReactNode } from "react"
import * as Layer from "effect/Layer"
import { developmentBridge } from "@reflex/expo/dev"
import {
  fixtureApi,
  fixtureSettings,
  InventoryFixture,
  seedProducts,
} from "@reflex/example-inventory/fixtures.ts"
import app from "../src/app.ts"
import { reflex } from "../src/routes.ts"

const e2e = {
  e2e: {
    layer: Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings),
    fixtures: [InventoryFixture],
  },
}
const instrumented = app.withScenarios(e2e, { defaultScenario: "e2e" })
const bridge = developmentBridge()
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <reflex.Provider app={instrumented} fallback={null} bridge={bridge}>
      {children}
    </reflex.Provider>
  )
}
