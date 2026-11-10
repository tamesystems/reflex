import { defineStoreApp, defineStoreNode } from "@reflex/runtime"

const Counter = defineStoreNode({
  name: "Counter",
  type: "service",
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
  project: (state) => state,
  actions: (action) => ({ Increment: action({ handler: (_, { store }) => store.increment() }) }),
})
export default defineStoreApp({ name: "live-counter", nodes: { Counter } })
