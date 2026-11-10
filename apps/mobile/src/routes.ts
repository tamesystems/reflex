import { expoRoutes } from "@reflex/expo/effect"
import { Nav } from "@reflex/example-inventory/navigation.ts"

export const routes = expoRoutes(Nav, {
  InventoryList: "/",
  InventoryDetail: { pathname: "/inventory/[id]", params: { productId: "id" } },
  Settings: "/settings",
})
export const { toHref, fromLocation } = routes
