import AsyncStorage from "@react-native-async-storage/async-storage"
import { LOW_STOCK_THRESHOLD_MAX, SettingsStore } from "@reflex/example-inventory/domain.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const KEY = "reflex.inventory.lowStockThreshold.v1"
const Threshold = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: LOW_STOCK_THRESHOLD_MAX }),
)

/** Storage failure remains a defect under the existing infallible SettingsStore port. */
export const deviceSettings = Layer.succeed(SettingsStore, {
  load: Effect.promise(async () => {
    const stored = await AsyncStorage.getItem(KEY)
    return {
      lowStockThreshold:
        stored === null ? 10 : Schema.decodeUnknownSync(Threshold)(JSON.parse(stored)),
      // This example has no authentication; never store credentials in unencrypted AsyncStorage.
      apiToken: Redacted.make(""),
    }
  }),
  setLowStockThreshold: (value) =>
    Effect.promise(() => AsyncStorage.setItem(KEY, JSON.stringify(value))),
})
