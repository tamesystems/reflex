import { InventoryList } from "@reflex/example-inventory/screens.ts"
import { isLowStock } from "@reflex/example-inventory/domain.ts"
import { useScreenStatus } from "../src/routes.ts"
import { Pressable, Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function InventoryListView() {
  const node = useScreenStatus(InventoryList)
  const { status, state, actions } = node
  if (status === "error") {
    return (
      <Text
        onPress={() => {
          void node.retry()
        }}
      >
        {node.error.message} — Retry
      </Text>
    )
  }
  if (status === "pending") {
    return null
  }

  if (state._tag === "loading") {
    return (
      <Screen>
        <Text style={styles.title}>Inventory</Text>
        <Text>Loading…</Text>
        <Action {...actions.OpenSettings} title="Settings" />
      </Screen>
    )
  }
  if (state._tag === "failed") {
    return (
      <Screen>
        <Text style={styles.title}>Inventory</Text>
        <Text style={styles.error}>{state.error}</Text>
        <Action {...actions.OpenSettings} title="Settings" />
      </Screen>
    )
  }
  return (
    <Screen>
      <Text style={styles.title}>Inventory</Text>
      {state.products.map((product) => (
        <Pressable
          accessibilityRole="button"
          key={product.id}
          onPress={() => actions.OpenProduct.run({ productId: product.id })}
          style={styles.row}
        >
          <Text>{product.title}</Text>
          <Text>
            {product.quantity}
            {isLowStock(product, state.lowStockThreshold) ? " (low)" : ""}
          </Text>
        </Pressable>
      ))}
      <Action {...actions.OpenSettings} title="Settings" />
    </Screen>
  )
}
