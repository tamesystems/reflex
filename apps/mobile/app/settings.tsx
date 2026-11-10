import { useScreen } from "@reflex/expo/effect"
import { routes } from "../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function SettingsScreen() {
  const node = useScreen(routes.Settings)
  const { status, state, actions } = node
  if (status === "pending" || state._tag === "loading") {
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
