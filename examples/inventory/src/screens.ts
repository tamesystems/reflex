import { Screen } from "@reflex/effect"
import * as Schema from "effect/Schema"
import { Product, Quantity } from "./domain.ts"

const InventoryListState = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("failed", { error: Schema.String }),
  Schema.TaggedStruct("ready", {
    products: Schema.Array(Product),
    lowStockThreshold: Schema.Int,
  }),
])

export class InventoryList extends Screen("InventoryList", {
  state: InventoryListState,
  initial: () => ({ _tag: "loading" }),
}) {}

const Loaded = {
  productId: Schema.String,
  title: Schema.String,
  quantity: Quantity,
}

const InventoryDetailState = Schema.Union([
  Schema.TaggedStruct("loading", { productId: Schema.String }),
  Schema.TaggedStruct("missing", { productId: Schema.String, error: Schema.String }),
  Schema.TaggedStruct("editing", { ...Loaded, error: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("saving", Loaded),
])

export class InventoryDetail extends Screen("InventoryDetail", {
  state: InventoryDetailState,
  params: { productId: Schema.String },
  initial: ({ productId }) => ({ _tag: "loading", productId }),
}) {}

const SettingsState = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("ready", {
    lowStockThreshold: Schema.Int,
    apiToken: Schema.Redacted(Schema.String),
  }),
])

export class Settings extends Screen("Settings", {
  state: SettingsState,
  initial: () => ({ _tag: "loading" }),
}) {}

export {
  InventoryList as InventoryListScreen,
  InventoryDetail as InventoryDetailScreen,
  Settings as SettingsScreen,
}
