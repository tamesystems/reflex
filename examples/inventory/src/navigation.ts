import { defineNavigation } from "@reflex/effect"
import { InventoryList, InventoryDetail, Settings } from "./screens.ts"

export const Nav = defineNavigation({ InventoryList, InventoryDetail, Settings })
