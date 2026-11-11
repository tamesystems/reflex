import { useTesting } from "@reflex/expo/testing"
import production from "../src/app.ts"
import { testScenarios } from "@reflex/example-inventory/scenarios.ts"
import { InventoryFixture } from "@reflex/example-inventory/fixtures.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { fixtureApi, fixtureSettings, seedProducts } from "@reflex/example-inventory/fixtures.ts"
import { router } from "expo-router"
import { useEffect } from "react"

declare global {
  var __failLateStart: () => void
}

export const LATE_FAILURE_SCENARIO = "e2e-late-failure"
const lateFailure = Layer.effectDiscard(
  Effect.callback<never>((resume) => {
    globalThis.__failLateStart = () => resume(Effect.die(new Error("late failure")))
  }),
)
const app = production.withScenarios(testScenarios, {
  defaultScenario: "inventory-with-products",
  fixtures: [InventoryFixture],
})
const failureScenarios = {
  [LATE_FAILURE_SCENARIO]: {
    layer: Layer.merge(
      Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings),
      lateFailure,
    ),
  },
} as const
export const instrumentedApp = app.withScenarios(failureScenarios)
export const testHost = instrumentedApp

/** Lets the browser journey read and steer the core. Absent from other builds. */

export const E2EBridge = ({
  setScenario,
}: {
  readonly setScenario: (scenario: (typeof testHost.scenarioNames)[number]) => void
}) => {
  const { runtime, stack, shownToken } = useTesting()
  useEffect(() => {
    Object.assign(globalThis, { __reflex: { router, runtime, stack, setScenario, shownToken } })
  }, [runtime, stack, setScenario, shownToken])
  return null
}
