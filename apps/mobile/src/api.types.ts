import { useSession } from "./routes.ts"
import app from "./app.ts"
import { useAction, ReflexProvider } from "@reflex/react"
import type { NodeOf } from "@reflex/effect/advanced"
import type { InventoryDetail } from "@reflex/example-inventory/features/inventory-detail.ts"

export const useContracts = (node: NodeOf<typeof InventoryDetail> | null) => {
  const controls = useSession()
  void controls.reset("production")
  // @ts-expect-error Session resets derive scenario names from the app value.
  void controls.reset("missing-scenario")
  ReflexProvider({
    host: app,
    children: null,
    // @ts-expect-error Provider scenarios derive from the host, never from this argument.
    scenario: "missing-scenario",
  })
  const save = useAction(node, "Save")
  const set = useAction(node, "SetQuantity")
  void save.run()
  void set.run({ quantity: 3 })
  // @ts-expect-error Save takes no input.
  void save.run({ quantity: 1 })
  // @ts-expect-error Input is required.
  void set.run()
  // @ts-expect-error Input types derive from the definition.
  void set.run({ quantity: "3" })
  // @ts-expect-error Unknown action.
  useAction(node, "Missing")
}

import { createReflexExpo } from "@reflex/expo"
import { InventoryDetailScreen, InventoryListScreen } from "@reflex/example-inventory/screens.ts"
import { InventoryFixture } from "@reflex/example-inventory/fixtures.ts"
import { useNode, useScreen } from "./routes.ts"
// @ts-expect-error A bound URL registration is total over the app's screens.
createReflexExpo(app, { InventoryList: "/" })
export const useBoundContracts = () => {
  const view = useScreen(InventoryDetailScreen)
  if (view.status === "ready") {
    void view.actions.SetQuantity.run({ quantity: 1 })
    // @ts-expect-error Inputs flow from implementation through the contract-only hook.
    void view.actions.SetQuantity.run({ quantity: "1" })
  }
  useScreen(InventoryListScreen)
  useNode(InventoryFixture)
}
