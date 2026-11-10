import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export const QUANTITY_MAX = 100_000
export const LOW_STOCK_THRESHOLD_MAX = 1_000

export const Quantity = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: QUANTITY_MAX }))

export const Product = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  quantity: Quantity,
})
export type Product = typeof Product.Type

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String,
}) {}

/** Everything core logic needs from the outside world, as interfaces only. */
export class InventoryApi extends Context.Service<
  InventoryApi,
  {
    readonly list: Effect.Effect<ReadonlyArray<Product>, ApiError>
    get(id: string): Effect.Effect<Product, ApiError>
    saveQuantity(id: string, quantity: number): Effect.Effect<void, ApiError>
  }
>()("inventory/InventoryApi") {}

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly load: Effect.Effect<{
      readonly lowStockThreshold: number
      readonly apiToken: Redacted.Redacted<string>
    }>
    setLowStockThreshold(value: number): Effect.Effect<void>
  }
>()("inventory/SettingsStore") {}

export const isLowStock = (product: Product, lowStockThreshold: number): boolean =>
  product.quantity < lowStockThreshold
