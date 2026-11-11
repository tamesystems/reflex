import { InventoryList, InventoryDetail, Settings } from "../screens.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InventoryApi, SettingsStore } from "../domain.ts"
import { Nav } from "../navigation.ts"

const load = InventoryList.handler(({ state }) =>
  Effect.gen(function* () {
    const api = yield* InventoryApi
    const settings = yield* SettingsStore
    yield* state.set({ _tag: "loading" })
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

export const InventoryListLive = InventoryList.implement({
  onFocus: load,
  actions: (action) => ({
    OpenProduct: action.when("ready").navigates({
      description: "Open a product's detail screen",
      input: Schema.Struct({ productId: Schema.String }),
      handler: ({ productId }) => Effect.succeed(Nav.push(InventoryDetail, { productId })),
    }),
    OpenSettings: action.navigates({
      handler: () => Effect.succeed(Nav.push(Settings)),
    }),
    Refresh: action({
      available: (state) => (state._tag === "loading" ? "Products are loading" : true),
      handler: (_, { state }) => load({ state }),
    }),
  }),
})
