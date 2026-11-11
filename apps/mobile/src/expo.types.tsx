import { Screen, defineApp } from "@reflex/effect"
import * as Schema from "effect/Schema"
import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"
import { createReflexExpo } from "@reflex/expo"
import { InventoryList, InventoryDetail, type Settings } from "@reflex/example-inventory/screens.ts"
import app from "./app.ts"
import { routeCodec } from "@reflex/expo/advanced"
const expo = createReflexExpo(app, {
  InventoryList: "/",
  InventoryDetail: "/inventory/[productId]",
  Settings: "/settings",
})
expo.href(InventoryDetail, { productId: "one" })
const hostProps = (
  <expo.Link to={InventoryList} replace accessibilityLabel="Inventory">
    {null}
  </expo.Link>
)
void hostProps
// @ts-expect-error Contracts, not screen names.
const named = <expo.Link to="InventoryList" />
// @ts-expect-error Detail params are required.
const missing = <expo.Link to={InventoryDetail} />
// @ts-expect-error Detail params are required.
expo.href(InventoryDetail)
// @ts-expect-error Placeholder has no matching param.
createReflexExpo(app, { InventoryList: "/", InventoryDetail: "/[id]", Settings: "/settings" })
createReflexExpo(app, {
  InventoryList: "/",
  // @ts-expect-error Repeated placeholders are rejected.
  InventoryDetail: "/[productId]/[productId]",
  Settings: "/settings",
})
createReflexExpo(app, {
  InventoryList: "/",
  // @ts-expect-error Optional and catch-all grammar requires a codec.
  InventoryDetail: "/[...productId]",
  Settings: "/settings",
})
// @ts-expect-error Missing route registration.
createReflexExpo(app, { InventoryList: "/" })
class RouteScreen extends Screen("RouteScreen", {
  params: { id: Schema.String, tab: Schema.optionalKey(Schema.String) },
  state: Schema.Number,
  initial: () => 0,
}) {}
const routeScreen = RouteScreen.implement({
  actions: (a) => ({ Noop: a.reduce({ reducer: (_, s) => s }) }),
})
const routeApp = defineApp({ name: "route-checks", screens: [routeScreen] })
createReflexExpo(routeApp, { RouteScreen: "/[id]" })
// @ts-expect-error Optional params cannot be placeholders.
createReflexExpo(routeApp, { RouteScreen: "/[id]/[tab]" })
// @ts-expect-error Repeated mapping target.
createReflexExpo(routeApp, { RouteScreen: { pathname: "/[id]", params: { tab: "id" } } })
// @ts-expect-error Wrong mapping key.
createReflexExpo(routeApp, { RouteScreen: { pathname: "/[id]", params: { typo: "id" } } })
// @ts-expect-error Dynamic paths need routeCodec.
createReflexExpo(routeApp, { RouteScreen: "/[id]" as string })
routeCodec({
  path: "/[...tail]",
  decode: () => ({ id: "1" }),
  encode: ({ id }: { id: string }) => `/${id}`,
})
void named
void missing

const StoreScreen = defineStoreNode({
  name: "StoreScreen",
  params: z.object({ id: z.string() }),
  store: ({ id }) => createStore(() => ({ id })),
  actions: () => ({}),
})
const stores = createReflexExpo(defineStoreApp({ name: "expo-stores", screens: [StoreScreen] }), {
  StoreScreen: "/store/[id]",
})
stores.href(StoreScreen, { id: "one" })
const custom = createReflexExpo(app, {
  InventoryList: "/",
  Settings: "/settings",
  InventoryDetail: routeCodec({
    path: "/inventory/[...tail]",
    decode: (raw) => ({ productId: typeof raw.tail === "string" ? raw.tail : "" }),
    encode: ({ productId }: { productId: string }) => `/inventory/${encodeURIComponent(productId)}`,
  }),
})
custom.href(InventoryDetail, { productId: "one" })

declare const target: typeof InventoryDetail | typeof Settings
// @ts-expect-error Contract unions cannot be paired with just one member's params.
expo.href(target, { productId: "one" })
