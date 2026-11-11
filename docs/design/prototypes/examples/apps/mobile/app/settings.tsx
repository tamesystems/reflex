import type { ErrorBoundaryProps } from "expo-router"
import { Suspense } from "react"
import { Settings } from "@reflex/example-inventory/screens.ts"
import { reflex } from "../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

function SettingsContent() {
  const node = reflex.useScreenSuspense(Settings)
  const { state, actions } = node
  if (state._tag === "loading") {
    return null
  }

  const { lowStockThreshold } = state
  return (
    <Screen>
      <Text style={styles.title}>Settings</Text>
      <Text>Low stock below: {lowStockThreshold}</Text>
      <Action {...actions.RaiseLowStockThreshold} title="Raise threshold" />
    </Screen>
  )
}

export default function SettingsView() {
  return (
    <Suspense fallback={null}>
      <SettingsContent />
    </Suspense>
  )
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <Text
      onPress={() => {
        void retry()
      }}
    >
      Retry Settings: {error.message}
    </Text>
  )
}
