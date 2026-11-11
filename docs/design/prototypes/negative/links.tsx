import { createReflexExpo } from "@reflex/expo"
import { createReflexRouter } from "@reflex/react-router"
import app from "../examples/examples/inventory/src/scenarios.ts"
import {
  InventoryList,
  InventoryDetail,
  type Settings,
} from "../examples/examples/inventory/src/screens.ts"
import { Nav } from "../examples/examples/inventory/src/navigation.ts"
import { InventoryListLive } from "../examples/examples/inventory/src/features/inventory-list.ts"
import { InventoryDetailLive } from "../examples/examples/inventory/src/features/inventory-detail.ts"
import { SettingsLive } from "../examples/examples/inventory/src/features/settings.ts"
const web = createReflexRouter(app, {
  InventoryList: "/",
  InventoryDetail: "/:productId",
  Settings: "/settings",
})
const expo = createReflexExpo(app, {
  InventoryList: "/",
  InventoryDetail: "/[productId]",
  Settings: "/settings",
})
// @case link-required | Type '{ to: typeof InventoryDetail; }' is not assignable to type
const missing = <web.Link to={InventoryDetail} />
// @case link-name | Type 'string' is not assignable to type 'typeof InventoryList | typeof InventoryDetail | typeof Settings'.
const named = <web.Link to="InventoryDetail" params={{ productId: "p" }} />
// @case expo-link-name | Type 'string' is not assignable to type 'typeof InventoryList | typeof InventoryDetail | typeof Settings'.
const expoNamed = <expo.Link to="Settings" />
declare const target: typeof InventoryDetail | typeof Settings
// @case link-union | Type '"Settings"' is not assignable to type '"InventoryDetail"'.
const uncorrelated = <web.Link to={target} params={{ productId: "p" }} />
Nav.implement([InventoryListLive, InventoryDetailLive, SettingsLive], {
  // @case initial-union | Type '"Settings"' is not assignable to type '"InventoryDetail"'.
  initial: { screen: target, params: { productId: "p" } },
})
// @case expo-href-union | Type '"Settings"' is not assignable to type '"InventoryDetail"'.
expo.href(target, { productId: "p" })
void missing
void named
void expoNamed
void uncorrelated
void InventoryList
