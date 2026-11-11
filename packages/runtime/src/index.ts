export { defineStoreNode, standardInput } from "./store-node.ts"
export type {
  Store,
  StandardValidator,
  StoreInput,
  StoreAction,
  StoreActionBuilder,
} from "./store-node.ts"
export { defineStoreApp } from "./store-author-app.ts"
export type { StoreApp, StoreScenario } from "./store-app.ts"
export type {
  ActionOutcome,
  NodeHandle,
  ConsumerDefinition,
  InferState,
  InferActions,
  InferInput,
  InferError,
} from "./node-handle.ts"
export type { AppHost, ScenarioName } from "./controller.ts"

export type StateOf<T> = T extends { getState(): infer S } ? S : never
