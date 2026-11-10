import { defineCapability, type StateAccess, type NavigationService } from "@reflex/effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ApiError, InventoryApi, Quantity, QUANTITY_MAX } from "../domain.ts"
import { Nav } from "../navigation.ts"

const SAVE_TIMEOUT = "5 seconds"

const Loaded = {
  productId: Schema.String,
  title: Schema.String,
  quantity: Quantity,
}

const State = Schema.Union([
  Schema.TaggedStruct("loading", { productId: Schema.String }),
  Schema.TaggedStruct("missing", { productId: Schema.String, error: Schema.String }),
  Schema.TaggedStruct("editing", { ...Loaded, error: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("saving", Loaded),
])
type State = typeof State.Type

const save = Effect.fnUntraced(function* (
  state: StateAccess<Extract<State, { readonly _tag: "editing" }>, State>,
) {
  const api = yield* InventoryApi
  const current = yield* state.get
  const { productId, title, quantity } = current
  yield* state.update(() => ({ _tag: "saving", productId, title, quantity }))
  const finish = (error: string | null) =>
    state.update(() => ({ _tag: "editing", productId, title, quantity, error }))
  yield* api.saveQuantity(productId, quantity).pipe(
    Effect.timeoutOrElse({
      duration: SAVE_TIMEOUT,
      orElse: () => Effect.fail(new ApiError({ message: "Save timed out" })),
    }),
    Effect.tapError(({ message }) => finish(message)),
    Effect.tap(() => finish(null)),
    Effect.onInterrupt(() => finish(null)),
  )
})

export const InventoryDetail = defineCapability({
  name: "InventoryDetail",
  state: State,
  params: Schema.Struct({ productId: Schema.String }),
  initial: ({ productId }): State => ({ _tag: "loading", productId }),
  onFocus: (state) =>
    Effect.gen(function* () {
      const api = yield* InventoryApi
      const current = yield* state.get
      // Coming back must not discard edits, or forget a save that is still running.
      if (current._tag !== "loading") {
        return
      }
      const { productId } = current
      yield* api.get(productId).pipe(
        Effect.matchEffect({
          onFailure: ({ message }) =>
            state.update(() => ({ _tag: "missing", productId, error: message })),
          onSuccess: ({ title, quantity }) =>
            state.update(() => ({ _tag: "editing", productId, title, quantity, error: null })),
        }),
      )
    }),
  actions: (action) => ({
    Increment: action.when("editing").reduce({
      available: (state) =>
        state.quantity < QUANTITY_MAX ? true : "Quantity is already at its maximum",
      reducer: (_, state) => ({ ...state, quantity: state.quantity + 1 }),
    }),
    Decrement: action.when("editing").reduce({
      available: (state) => (state.quantity > 0 ? true : "Quantity is already zero"),
      reducer: (_, state) => ({ ...state, quantity: state.quantity - 1 }),
    }),
    SetQuantity: action.when("editing").reduce({
      description: "Set the quantity directly",
      input: Schema.Struct({ quantity: Quantity }),
      reducer: ({ quantity }, state) => ({ ...state, quantity }),
    }),
    Save: action.when("editing")({
      description: "Persist the quantity; gives up after 5 seconds",
      error: ApiError,
      handler: (_, state) => save(state),
    }),
    SaveAndClose: action.when("editing")({
      description: "Persist the quantity and return to the previous screen",
      error: ApiError,
      handler: (_, state): Effect.Effect<void, ApiError, NavigationService | InventoryApi> =>
        Effect.gen(function* () {
          yield* save(state)
          yield* Nav.back
        }),
    }),
  }),
})
