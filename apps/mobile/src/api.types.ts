import { useAction } from "@reflex/react"
import type { NodeOf } from "@reflex/effect"
import type { InventoryDetail } from "@reflex/example-inventory/features/inventory-detail.ts"

export const useContracts = (node: NodeOf<typeof InventoryDetail> | null) => {
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
