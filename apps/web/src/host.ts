import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { z } from "zod"

const createCounterStore = (id = "list") => {
  let state = { count: 0, id }
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
      state = { ...state, count: state.count + 1 }
      for (const listener of listeners) {
        listener()
      }
    },
  }
}
export const List = defineStoreNode({
  name: "List",
  store: () => createCounterStore(),
  actions: (action) => ({ Increment: action({ handler: (_, { store }) => store.increment() }) }),
})
export const Detail = defineStoreNode({
  name: "Detail",
  params: z.strictObject({ id: z.string() }),
  store: ({ id }) => createCounterStore(id),
  actions: (action) => ({ Increment: action({ handler: (_, { store }) => store.increment() }) }),
})
export const host = defineStoreApp({ name: "router-counter", screens: [List, Detail] })
