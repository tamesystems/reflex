import { Settings } from "../screens.ts"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import { ApiError, LOW_STOCK_THRESHOLD_MAX, SettingsStore } from "../domain.ts"

export const SettingsLive = Settings.implement({
  onFocus: ({ state }) =>
    Effect.gen(function* () {
      const store = yield* SettingsStore
      const loaded = yield* store.load
      yield* state.update(() => ({ _tag: "ready", ...loaded }))
    }),
  actions: (action) => ({
    RaiseLowStockThreshold: action.when("ready")({
      error: ApiError,
      available: (state) =>
        state.lowStockThreshold < LOW_STOCK_THRESHOLD_MAX ? true : "Threshold is at its maximum",
      handler: (_, { state }) =>
        Effect.gen(function* () {
          const current = yield* state.get
          const store = yield* SettingsStore
          const threshold = current.lowStockThreshold + 1
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((value) => ({ ...value, lowStockThreshold: threshold }))
        }),
    }),
    SetLowStockThreshold: action.when("ready")({
      error: ApiError,
      input: Schema.Struct({
        threshold: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: LOW_STOCK_THRESHOLD_MAX }),
        ),
      }),
      handler: ({ threshold }, { state }) =>
        Effect.gen(function* () {
          const store = yield* SettingsStore
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((current) => ({ ...current, lowStockThreshold: threshold }))
        }),
    }),
  }),
})
