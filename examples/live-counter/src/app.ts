import { defineStoreApp, defineStoreNode } from "@reflex/runtime"

export const Counter = defineStoreNode({
  name: "Counter",
  store: () => {
    let state = { count: 0 }
    const listeners = new Set<() => void>()
    return {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      increment: () => {
        state = { count: state.count + 1 }
        for (const listener of listeners) {
          listener()
        }
      },
    }
  },
  actions: (action) => ({ Increment: action({ handler: (_, { store }) => store.increment() }) }),
})
export default defineStoreApp({ name: "live-counter", services: [Counter] })
