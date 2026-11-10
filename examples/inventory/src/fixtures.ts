import { defineCapability, mountWithAccess } from "@reflex/effect"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ApiError, InventoryApi, type Product, SettingsStore } from "./domain.ts"

/** Journeys look at the last few saves. Keeping more only costs copying. */
const SAVED_HISTORY_MAX = 32
const LOW_STOCK_THRESHOLD_DEFAULT = 10

const FixtureState = Schema.Struct({
  saved: Schema.Array(Schema.Struct({ productId: Schema.String, quantity: Schema.Int })),
  failNextSave: Schema.Boolean,
})

/** Test doubles are nodes too, so journeys and agents can observe and steer them. */
export const InventoryFixture = defineCapability({
  name: "InventoryFixture",
  type: "fixture",
  state: FixtureState,
  actions: (action) => ({
    FailNextSave: action({
      description: "Make the next save fail, as a server error would",
      handler: (_, state) => state.update((s) => ({ ...s, failNextSave: true })),
    }),
  }),
})

export const seedProducts: ReadonlyArray<Product> = [
  { id: "product-123", title: "Blue T-Shirt", quantity: 5 },
  { id: "product-456", title: "Grey Hoodie", quantity: 40 },
  { id: "product-789", title: "Canvas Tote", quantity: 2 },
]

export const fixtureApi = (options: {
  readonly products: ReadonlyArray<Product>
  readonly saveDelay?: Duration.Input
}) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const products = new Map(options.products.map((product) => [product.id, product]))
      const { access: state } = yield* mountWithAccess(InventoryFixture, {
        saved: [],
        failNextSave: false,
      })

      const saveQuantity = Effect.fnUntraced(function* (productId: string, quantity: number) {
        if (options.saveDelay !== undefined) {
          yield* Effect.sleep(options.saveDelay)
        }
        const { failNextSave } = yield* state.get
        if (failNextSave) {
          yield* state.update((s) => ({ ...s, failNextSave: false }))
          return yield* new ApiError({ message: "Server error" })
        }
        const product = products.get(productId)
        if (product !== undefined) {
          products.set(productId, { ...product, quantity })
        }
        yield* state.update((s) => ({
          ...s,
          saved: [...s.saved, { productId, quantity }].slice(-SAVED_HISTORY_MAX),
        }))
      })

      return InventoryApi.of({
        list: Effect.sync(() => [...products.values()]),
        get: (id) => {
          const product = products.get(id)
          if (product === undefined) {
            return Effect.fail(new ApiError({ message: `No product "${id}"` }))
          }
          return Effect.succeed(product)
        },
        saveQuantity,
      })
    }),
  )

export const fixtureSettings = Layer.sync(SettingsStore, () => {
  let lowStockThreshold = LOW_STOCK_THRESHOLD_DEFAULT
  return SettingsStore.of({
    load: Effect.sync(() => ({
      lowStockThreshold,
      apiToken: Redacted.make("secret-fixture-token"),
    })),
    setLowStockThreshold: (value) =>
      Effect.sync(() => {
        lowStockThreshold = value
      }),
  })
})
