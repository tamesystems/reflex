import { createReflexExpo } from "@reflex/expo"
import app from "./app.ts"

export const { Provider, useScreen, useScreenSuspense, useNode, useSession, RouterProjection } =
  createReflexExpo(app, {
    InventoryList: "/",
    InventoryDetail: { pathname: "/inventory/[id]", params: { productId: "id" } },
    Settings: "/settings",
  })
