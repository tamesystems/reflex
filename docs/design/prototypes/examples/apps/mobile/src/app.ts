import * as Layer from "effect/Layer"
import AsyncStorage from "@react-native-async-storage/async-storage"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import inventory from "@reflex/example-inventory"
import { SettingsStore } from "@reflex/example-inventory/domain.ts"
import { httpInventoryApi } from "@reflex/example-inventory/http-api.ts"

const KEY = "inventory-settings:v1"
const SETTINGS_BYTES_MAX = 1024
const SavedSettings = Schema.Struct({
  version: Schema.Literal(1),
  lowStockThreshold: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
})
const defaults = { version: 1, lowStockThreshold: 10 } as const
// No credentials in AsyncStorage or EXPO_PUBLIC variables. Supply real credentials
// through the app's secure credential service; an absent credential is empty here.
const storage = Layer.succeed(
  SettingsStore,
  SettingsStore.of({
    load: Effect.tryPromise({
      try: () => AsyncStorage.getItem(KEY),
      catch: () => new Error("Settings read failed"),
    }).pipe(
      Effect.flatMap((raw) =>
        raw === null || new TextEncoder().encode(raw).byteLength > SETTINGS_BYTES_MAX
          ? Effect.succeed(defaults)
          : Schema.decodeUnknownEffect(Schema.fromJsonString(SavedSettings))(raw),
      ),
      Effect.catch(() => Effect.succeed(defaults)),
      Effect.map((value) => ({
        lowStockThreshold: value.lowStockThreshold,
        apiToken: Redacted.make(""),
      })),
    ),
    setLowStockThreshold: (lowStockThreshold) =>
      Schema.encodeEffect(Schema.fromJsonString(SavedSettings))({
        version: 1,
        lowStockThreshold,
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.tryPromise({
            try: () => AsyncStorage.setItem(KEY, raw),
            catch: () => new Error("Settings write failed"),
          }),
        ),
        Effect.orDie,
      ),
  }),
)
const baseUrl = __DEV__ ? process.env.EXPO_PUBLIC_INVENTORY_API : undefined
const deviceScenarios = {
  "device-services": {
    description: "Development HTTP and device settings",
    layer: Layer.merge(httpInventoryApi(baseUrl ?? "http://127.0.0.1:4318"), storage),
    fixtures: [],
  },
}
const deviceApp = inventory.withScenarios(deviceScenarios, {
  defaultScenario: baseUrl === undefined ? "live-services" : "device-services",
})

export default deviceApp
