export { defineStoreNode, standardInput } from "./store-node.ts"
export type { Store, StoreActionBuilder } from "./store-node.ts"
export { defineStoreApp } from "./store-author-app.ts"
export type { ActionOutcome } from "./public-types.ts"
export type { StateChanged } from "./public-types.ts"
export type { JourneyClient } from "./journey-types.ts"
export type StateOf<T> = T extends { getState(): infer S } ? S : never
