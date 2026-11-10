import { defineCapability } from "@reflex/effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { LOW_STOCK_THRESHOLD_MAX, SettingsStore } from "../domain.ts"

const State = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("ready", {
    lowStockThreshold: Schema.Int,
    apiToken: Schema.Redacted(Schema.String),
  }),
])
type State = typeof State.Type

export const Settings = defineCapability({
  name: "Settings",
  state: State,
  initial: (): State => ({ _tag: "loading" }),
  onFocus: (state) =>
    Effect.gen(function* () {
      const store = yield* SettingsStore
      const loaded = yield* store.load
      yield* state.update(() => ({ _tag: "ready", ...loaded }))
    }),
  actions: (action) => ({
    RaiseLowStockThreshold: action.when("ready")({
      available: (state) =>
        state.lowStockThreshold < LOW_STOCK_THRESHOLD_MAX ? true : "Threshold is at its maximum",
      handler: (_, state) =>
        Effect.gen(function* () {
          const current = yield* state.get
          const store = yield* SettingsStore
          const threshold = current.lowStockThreshold + 1
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((value) =>
            value._tag === "ready" ? { ...value, lowStockThreshold: threshold } : value,
          )
        }),
    }),
    SetLowStockThreshold: action({
      input: Schema.Struct({
        threshold: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: LOW_STOCK_THRESHOLD_MAX }),
        ),
      }),
      available: (state) => (state._tag === "ready" ? true : "Settings are loading"),
      handler: ({ threshold }, state) =>
        Effect.gen(function* () {
          const store = yield* SettingsStore
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((current) =>
            current._tag === "ready" ? { ...current, lowStockThreshold: threshold } : current,
          )
        }),
    }),
  }),
})
