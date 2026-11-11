import { InventoryDetail } from "@reflex/example-inventory/screens.ts"
import { useScreenStatus } from "../../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, ScreenStatus, styles } from "../../src/ui.tsx"

export default function InventoryDetailView() {
  const node = useScreenStatus(InventoryDetail)
  return (
    <ScreenStatus view={node}>
      {({ state, actions }) => {
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
            <Action {...actions.Increment} title="Increment" />
            <Action {...actions.Save} title={saving ? "Saving…" : "Save"} />
          </Screen>
        )
      }}
    </ScreenStatus>
  )
}
