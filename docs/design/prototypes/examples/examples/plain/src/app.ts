import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

// The existing Zustand store remains usable without Reflex.
export const createCounterStore = () => createStore(() => ({ count: 0, token: "private-token" }))
export const Counter = defineStoreNode({
  name: "Counter",
  store: createCounterStore,
  project: ({ count }) => ({ count }),
  actions: (action) => ({
    Add: action({
      input: z.strictObject({ by: z.int() }),
      handler: ({ by }, { store }) => store.setState((s) => ({ count: s.count + by })),
    }),
    Reset: action({
      available: ({ count }) => (count === 0 ? "Already zero" : true),
      handler: (_, { store }) => store.setState({ count: 0 }),
    }),
  }),
})
export default defineStoreApp({ name: "plain-counter", services: [Counter] })
