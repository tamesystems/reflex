import { defineNavigation, NoParams } from "@reflex/effect"
import * as Schema from "effect/Schema"

export const Nav = defineNavigation("inventory/Navigation", {
  InventoryList: NoParams,
  InventoryDetail: Schema.Struct({ productId: Schema.String }),
  Settings: NoParams,
})
