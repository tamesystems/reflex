import { defineNavigation } from "@reflex/effect"
import { InventoryList } from "./features/inventory-list.ts"
import { InventoryDetail } from "./features/inventory-detail.ts"
import { Settings } from "./features/settings.ts"

export const Nav = defineNavigation("inventory/Navigation", () => ({
  InventoryList,
  InventoryDetail,
  Settings,
}))
