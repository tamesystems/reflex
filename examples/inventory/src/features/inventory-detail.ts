import { defineCapability, type StateAccess } from "@reflex/effect"
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
type Editing = Extract<State, { readonly _tag: "editing" }>

export const initialState = (productId: string): State => ({ _tag: "loading", productId })

const whenEditing = (state: State): true | string => {
  switch (state._tag) {
    case "loading":
      return "Product is loading"
    case "missing":
      return "Product does not exist"
    case "saving":
      return "Save in progress"
    case "editing":
      return true
  }
}

/** Actions are only reachable while editing, which `available` enforces. */
const edit = (state: StateAccess<State>, f: (editing: Editing) => Editing) =>
  state.update((current) => (current._tag === "editing" ? f(current) : current))

const save = Effect.fnUntraced(function* (state: StateAccess<State>) {
  const api = yield* InventoryApi
  const current = yield* state.get
  if (current._tag !== "editing") {
    return
  }
  const { productId, title, quantity } = current
  yield* state.update(() => ({ _tag: "saving", productId, title, quantity }))
  const finish = (error: string | null) =>
    state.update(() => ({ _tag: "editing", productId, title, quantity, error }))
  yield* api.saveQuantity(productId, quantity).pipe(
    Effect.timeoutOrElse({
      duration: SAVE_TIMEOUT,
      orElse: () => Effect.fail(new ApiError({ message: "Save timed out" })),
    }),
    Effect.onExit((exit) => {
      if (exit._tag === "Success") {
        return finish(null)
      }
      // A cancelled save is not an error, but the screen must become usable again.
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      return finish(failure === undefined ? null : failure.error.message)
    }),
  )
})

export const InventoryDetail = defineCapability({
  name: "InventoryDetail",
  state: State,
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
    Increment: action({
      available: (state) => {
        const verdict = whenEditing(state)
        if (verdict === true && state._tag === "editing" && state.quantity >= QUANTITY_MAX) {
          return "Quantity is already at its maximum"
        }
        return verdict
      },
      handler: (_, state) => edit(state, (s) => ({ ...s, quantity: s.quantity + 1 })),
    }),
    Decrement: action({
      available: (state) => {
        const verdict = whenEditing(state)
        if (verdict === true && state._tag === "editing" && state.quantity === 0) {
          return "Quantity is already zero"
        }
        return verdict
      },
      handler: (_, state) => edit(state, (s) => ({ ...s, quantity: s.quantity - 1 })),
    }),
    SetQuantity: action({
      description: "Set the quantity directly",
      input: Schema.Struct({ quantity: Quantity }),
      available: whenEditing,
      handler: ({ quantity }, state) => edit(state, (s) => ({ ...s, quantity })),
    }),
    Save: action({
      description: "Persist the quantity; gives up after 5 seconds",
      available: whenEditing,
      error: ApiError,
      handler: (_, state) => save(state),
    }),
    SaveAndClose: action({
      description: "Persist the quantity and return to the previous screen",
      available: whenEditing,
      error: ApiError,
      handler: (_, state) =>
        Effect.gen(function* () {
          yield* save(state)
          const nav = yield* Nav.Tag
          yield* nav.back
        }),
    }),
  }),
})
