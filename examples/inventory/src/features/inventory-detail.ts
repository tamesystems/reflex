import { InventoryDetail } from "../screens.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ApiError, InventoryApi, Quantity, QUANTITY_MAX } from "../domain.ts"
import { Nav } from "../navigation.ts"

const SAVE_TIMEOUT = "5 seconds"

const save = InventoryDetail.when("editing").handler((_, { state }) =>
  Effect.gen(function* () {
    const api = yield* InventoryApi
    const current = yield* state.get
    const { productId, title, quantity } = current
    yield* state.update(() => ({ _tag: "saving", productId, title, quantity }))
    const finish = (error: string | null) =>
      state.when("saving").update(() => ({ _tag: "editing", productId, title, quantity, error }))
    yield* api.saveQuantity(productId, quantity).pipe(
      Effect.timeoutOrElse({
        duration: SAVE_TIMEOUT,
        orElse: () => Effect.fail(new ApiError({ message: "Save timed out" })),
      }),
      Effect.tapError(({ message }) => finish(message)),
      Effect.tap(() => finish(null)),
      Effect.onInterrupt(() => finish(null)),
    )
  }),
)

export const InventoryDetailLive = InventoryDetail.implement({
  onFocus: ({ state }) =>
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
      handler: save,
    }),
    SaveAndClose: action.when("editing").navigates({
      description: "Persist the quantity and return to the previous screen",
      error: ApiError,
      handler: (_, { state }) =>
        Effect.gen(function* () {
          yield* save(undefined, { state })
          return Nav.back
        }),
      onRefused: ({ reason }, { state }) =>
        state.when("editing").update((current) => ({ ...current, error: reason })),
    }),
  }),
})

export { InventoryDetailLive as InventoryDetail }
