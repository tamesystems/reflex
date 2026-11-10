import { isLowStock } from "@reflex/example-inventory/features/inventory-list.ts"
import { useScreen } from "@reflex/expo/effect"
import { routes } from "../src/routes.ts"
import { Pressable, Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function InventoryListScreen() {
  const node = useScreen(routes.InventoryList)
  const { status, state, actions } = node
  if (status === "pending") {
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
