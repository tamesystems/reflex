import { expoRoutes } from "@reflex/expo/effect"
import { screens } from "@reflex/example-inventory/app.ts"

export const routes = expoRoutes(
  { screens },
  {
    InventoryList: "/",
    InventoryDetail: { pathname: "/inventory/[id]", params: { productId: "id" } },
    Settings: "/settings",
  },
)
