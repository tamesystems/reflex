import app from "../src/app.ts"
import { type BridgeConnector, ReflexProvider } from "@reflex/react"
import { RouterProjection } from "@reflex/expo"
import { Stack } from "expo-router"
import { useState } from "react"
import { Text } from "react-native"
import { E2EBridge, withLateFailure } from "../src/e2e.tsx"
import { fromLocation, toHref } from "../src/routes.ts"

const isE2E = process.env.EXPO_PUBLIC_REFLEX_E2E === "1"
const host = isE2E ? withLateFailure(app) : app

/**
 * Development builds only, and only when asked for. A production build folds this to
 * `undefined` before collecting dependencies, so neither the bridge nor its setting,
 * which holds the token, is in the bundle at all. Keep every read of the setting inside.
 */
const bridge: BridgeConnector | undefined =
  __DEV__ && process.env.EXPO_PUBLIC_REFLEX_BRIDGE
    ? (require("@reflex/live") as typeof import("@reflex/live")).connectBridge(
        process.env.EXPO_PUBLIC_REFLEX_BRIDGE,
      )
    : undefined

export default function Layout() {
  const [scenario, setScenario] = useState(app.defaultScenario)
  return (
    <ReflexProvider
      bridge={bridge}
      fallback={<Text>Starting…</Text>}
      host={host}
      scenario={scenario}
    >
      <RouterProjection fromLocation={fromLocation} toHref={toHref} />
      {isE2E && <E2EBridge setScenario={setScenario} />}
      <Stack />
    </ReflexProvider>
  )
}
