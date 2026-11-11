import { useRuntime } from "@reflex/react/advanced"
import { useCoreStack, useShownToken } from "@reflex/expo/internal"
import production from "@reflex/example-inventory"
import { testScenarios } from "@reflex/example-inventory/scenarios.ts"
import { InventoryFixture } from "@reflex/example-inventory/fixtures.ts"
import { mobileServices } from "../src/app.ts"
import { legacyApp } from "@reflex/effect/internal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { fixtureApi, fixtureSettings, seedProducts } from "@reflex/example-inventory/fixtures.ts"
import { router } from "expo-router"
import { useEffect } from "react"

export const LATE_FAILURE_SCENARIO = "e2e-late-failure"
const lateFailure = Layer.effectDiscard(
  Effect.callback<never>((resume) => {
    globals.__failLateStart = () => resume(Effect.die(new Error("late failure")))
  }),
)
const app = production.withScenarios(
  { ...testScenarios, "live-services": { layer: mobileServices, fixtures: [] } },
  { defaultScenario: "inventory-with-products", fixtures: [InventoryFixture] },
)
const failureScenarios = {
  [LATE_FAILURE_SCENARIO]: {
    layer: Layer.merge(
      Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings),
      lateFailure,
    ),
  },
} as const
export const testHost = legacyApp(app.withScenarios(failureScenarios))

/** Lets the browser journey read and steer the core. Absent from other builds. */
const globals = globalThis as Record<string, unknown>

export const E2EBridge = ({
  setScenario,
}: {
  readonly setScenario: (scenario: (typeof testHost.scenarioNames)[number]) => void
}) => {
  const runtime = useRuntime()
  const stack = useCoreStack()
  const shownToken = useShownToken()
  useEffect(() => {
    globals.__reflex = { router, runtime, stack, setScenario, shownToken }
  }, [runtime, stack, setScenario, shownToken])
  return null
}
