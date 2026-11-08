import { InventoryDetail } from "@reflex/example-inventory/features/inventory-detail.ts"
import { routeParam, send, useNodeState, useRouteNode } from "@reflex/expo"
import { useLocalSearchParams } from "expo-router"
import { Text } from "react-native"
import { Action, Screen, styles } from "../../src/ui.tsx"

export default function InventoryDetailScreen() {
  const productId = routeParam(useLocalSearchParams().id)
  const node = useRouteNode(InventoryDetail, { productId })
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
      <Action disabled={saving} onPress={() => send(node, "Increment")} title="Increment" />
      <Action
        disabled={saving}
        onPress={() => send(node, "Save")}
        title={saving ? "Saving…" : "Save"}
      />
    </Screen>
  )
}
