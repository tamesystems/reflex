import { useAction, useNodeState, useScreen } from "@reflex/expo/effect"
import { routes } from "../../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../../src/ui.tsx"

export default function InventoryDetailScreen() {
  const node = useScreen(routes.InventoryDetail)
  const increment = useAction(node, "Increment")
  const save = useAction(node, "Save")
  const state = useNodeState(node)
  if (node === null || state === null) {
    return null
  }
  if (state._tag === "loading") {
    return <Screen>{null}</Screen>
  }
  if (state._tag === "missing") {
    return (
      <Screen>
        <Text>SKU: {state.productId}</Text>
        <Text style={styles.error}>{state.error}</Text>
      </Screen>
    )
  }

  const saving = state._tag === "saving"
  return (
    <Screen>
      <Text style={styles.title}>{state.title}</Text>
      <Text>SKU: {state.productId}</Text>
      <Text>Quantity: {state.quantity}</Text>
      {state._tag === "editing" && state.error !== null && (
        <Text style={styles.error}>{state.error}</Text>
      )}
      <Action disabled={!increment.available} onPress={() => increment.run()} title="Increment" />
      <Action
        disabled={!save.available}
        onPress={() => save.run()}
        title={saving ? "Saving…" : "Save"}
      />
    </Screen>
  )
}
