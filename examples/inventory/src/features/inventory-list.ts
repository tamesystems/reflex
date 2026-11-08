import { defineCapability, type StateAccess } from "@reflex/effect"
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

export const initialState: State = { _tag: "loading" }

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

const whenLoaded = (state: State) => (state._tag === "loading" ? "Products are loading" : true)

export const InventoryList = defineCapability({
  name: "InventoryList",
  state: State,
  onFocus: load,
  actions: (action) => ({
    OpenProduct: action({
      description: "Open a product's detail screen",
      input: Schema.Struct({ productId: Schema.String }),
      available: whenLoaded,
      handler: ({ productId }) =>
        Effect.gen(function* () {
          const nav = yield* Nav.Tag
          yield* nav.push("InventoryDetail", { productId })
        }),
    }),
    OpenSettings: action({
      handler: () =>
        Effect.gen(function* () {
          const nav = yield* Nav.Tag
          yield* nav.push("Settings", {})
        }),
    }),
    Refresh: action({
      available: whenLoaded,
      handler: (_, state) => load(state),
    }),
  }),
})
