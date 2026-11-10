import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

export const addSchema = z.strictObject({ by: z.int() })
export const addInput = standardInput(addSchema)

/** The app still owns its state and can write it without going through Reflex. */
export const createCounterStore = () => createStore(() => ({ count: 0, token: "private-token" }))

export const Counter = defineStoreNode({
  name: "Counter",
  store: createCounterStore,
  project: ({ count }) => ({ count }),
  actions: (action) => ({
    Add: action({
      input: addInput,
      handler: ({ by }, { store }) => {
        const current = store.getState()
        store.setState({ count: current.count + by })
      },
    }),
    Reset: action({
      available: ({ count }) => (count === 0 ? "Already zero" : true),
      handler: (_, { store }) => store.setState({ count: 0 }),
    }),
  }),
})
export const plainBackend = defineStoreApp({ name: "counter", nodes: { Counter } })
export default plainBackend
