import { InventoryListScreen } from "../screens.ts"
import { NavigationRefused } from "@reflex/effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InventoryApi, type Product, SettingsStore } from "../domain.ts"
import { Nav } from "../navigation.ts"

export const isLowStock = (product: Product, lowStockThreshold: number): boolean =>
  product.quantity < lowStockThreshold

const load = InventoryListScreen.handler((state) =>
  Effect.gen(function* () {
    const api = yield* InventoryApi
    const settings = yield* SettingsStore
    yield* state.update(() => ({ _tag: "loading" }))
    const { lowStockThreshold } = yield* settings.load
    yield* api.list.pipe(
      Effect.matchEffect({
        onFailure: ({ message }) => state.update(() => ({ _tag: "failed", error: message })),
        onSuccess: (products) =>
          state.update(() => ({ _tag: "ready", products, lowStockThreshold })),
      }),
    )
  }),
)

export const InventoryList = InventoryListScreen.implement({
  onFocus: load,
  actions: (action) => ({
    OpenProduct: action.when("ready")({
      error: NavigationRefused,
      description: "Open a product's detail screen",
      input: Schema.Struct({ productId: Schema.String }),
      handler: ({ productId }) => Nav.push("InventoryDetail", { productId }),
    }),
    OpenSettings: action({
      error: NavigationRefused,
      handler: () => Nav.push("Settings"),
    }),
    Refresh: action({
      available: (state) => (state._tag === "loading" ? "Products are loading" : true),
      handler: (_, state) => load(state),
    }),
  }),
})
