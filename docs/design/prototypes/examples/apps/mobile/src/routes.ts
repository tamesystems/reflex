import { createReflexExpo } from "@reflex/expo"
import app from "./app.ts"

export const reflex = createReflexExpo(app, {
  InventoryList: "/",
  InventoryDetail: "/inventory/[productId]",
  Settings: "/settings",
})
