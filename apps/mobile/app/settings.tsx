import { LOW_STOCK_THRESHOLD_MAX } from "@reflex/example-inventory/domain.ts"
import { Settings } from "@reflex/example-inventory/features/settings.ts"
import { send, useNodeState, useRouteNode } from "@reflex/expo"
import { Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function SettingsScreen() {
  const node = useRouteNode(Settings)
  const state = useNodeState(node)
  if (node === null || state === null || state._tag === "loading") {
    return null
  }

  const { lowStockThreshold } = state
  return (
    <Screen>
      <Text style={styles.title}>Settings</Text>
      <Text>Low stock below: {lowStockThreshold}</Text>
      <Action
        disabled={lowStockThreshold >= LOW_STOCK_THRESHOLD_MAX}
        onPress={() => send(node, "SetLowStockThreshold", { threshold: lowStockThreshold + 1 })}
        title="Raise threshold"
      />
    </Screen>
  )
}
