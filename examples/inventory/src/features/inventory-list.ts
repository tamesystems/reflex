import {
  defineCapability,
  type StateAccess,
  NavigationRefused,
  type NavigationService,
} from "@reflex/effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InventoryApi, Product, SettingsStore } from "../domain.ts"
import { Nav } from "../navigation.ts"

const State = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("failed", { error: Schema.String }),
  Schema.TaggedStruct("ready", {
    products: Schema.Array(Product),
    lowStockThreshold: Schema.Int,
  }),
])
type State = typeof State.Type

export const isLowStock = (product: Product, lowStockThreshold: number): boolean =>
  product.quantity < lowStockThreshold

const load = Effect.fnUntraced(function* (state: StateAccess<State>) {
  const api = yield* InventoryApi
  const settings = yield* SettingsStore
  yield* state.update(() => ({ _tag: "loading" }))
  const { lowStockThreshold } = yield* settings.load
  yield* api.list.pipe(
    Effect.matchEffect({
      onFailure: ({ message }) => state.update(() => ({ _tag: "failed", error: message })),
      onSuccess: (products) => state.update(() => ({ _tag: "ready", products, lowStockThreshold })),
    }),
  )
})

export const InventoryList = defineCapability({
  name: "InventoryList",
  state: State,
  initial: (): State => ({ _tag: "loading" }),
  onFocus: load,
  actions: (action) => ({
    OpenProduct: action.when("ready")({
      error: NavigationRefused,
      description: "Open a product's detail screen",
      input: Schema.Struct({ productId: Schema.String }),
      handler: ({ productId }): Effect.Effect<void, NavigationRefused, NavigationService> =>
        Nav.push("InventoryDetail", { productId }),
    }),
    OpenSettings: action({
      error: NavigationRefused,
      handler: (): Effect.Effect<void, NavigationRefused, NavigationService> =>
        Nav.push("Settings"),
    }),
    Refresh: action({
      available: (state) => (state._tag === "loading" ? "Products are loading" : true),
      handler: (_, state) => load(state),
    }),
  }),
})
