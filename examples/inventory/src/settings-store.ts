import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { SettingsStore } from "./domain.ts"
export const memorySettings = Layer.sync(SettingsStore, () => {
  let lowStockThreshold = 10
  return SettingsStore.of({
    load: Effect.sync(() => ({ lowStockThreshold, apiToken: Redacted.make("") })),
    setLowStockThreshold: (value) =>
      Effect.sync(() => {
        lowStockThreshold = value
      }),
  })
})
