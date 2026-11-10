import { SettingsScreen as SettingsScreenContract } from "@reflex/example-inventory/screens.ts"
import { useScreenSuspense } from "../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function SettingsScreen() {
  const node = useScreenSuspense(SettingsScreenContract)
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
