import { InventoryList, isLowStock } from "@reflex/example-inventory/features/inventory-list.ts"
import { send, useNodeState, useRouteNode } from "@reflex/expo/effect"
import { Pressable, Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function InventoryListScreen() {
  const node = useRouteNode(InventoryList)
  const state = useNodeState(node)
  if (node === null || state === null) {
    return null
  }

  return (
    <Screen>
      <Text style={styles.title}>Inventory</Text>
      {state._tag === "loading" && <Text>Loading…</Text>}
      {state._tag === "failed" && <Text style={styles.error}>{state.error}</Text>}
      {state._tag === "ready" &&
        state.products.map((product) => (
          <Pressable
            accessibilityRole="button"
            key={product.id}
            onPress={() => send(node, "OpenProduct", { productId: product.id })}
            style={styles.row}
          >
            <Text>{product.title}</Text>
            <Text>
              {product.quantity}
              {isLowStock(product, state.lowStockThreshold) ? " (low)" : ""}
            </Text>
          </Pressable>
        ))}
      <Action onPress={() => send(node, "OpenSettings")} title="Settings" />
    </Screen>
  )
}
