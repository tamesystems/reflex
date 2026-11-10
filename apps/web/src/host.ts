import { defineStoreApp, defineStoreNode } from "@reflex/runtime"

const counter = <const Name extends string>(name: Name) =>
  defineStoreNode({
    name,
    type: "screen",
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
export const List = counter("List")
export const Detail = counter("Detail")
export const host = defineStoreApp({ name: "router-counter", routes: { List, Detail } })
