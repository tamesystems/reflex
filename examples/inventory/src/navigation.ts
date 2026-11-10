import { defineNavigation } from "@reflex/effect"
import { InventoryListScreen, InventoryDetailScreen, SettingsScreen } from "./screens.ts"

export const Nav = defineNavigation("inventory/Navigation", {
  InventoryList: InventoryListScreen,
  InventoryDetail: InventoryDetailScreen,
  Settings: SettingsScreen,
})
