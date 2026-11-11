import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

export const List = defineStoreNode({
  name: "List",
  store: () => createStore(() => ({ count: 0 })),
  actions: (action) => ({
    Increment: action({
      handler: (_, { store }) => store.setState((s) => ({ count: s.count + 1 })),
    }),
  }),
})
export const Detail = defineStoreNode({
  name: "Detail",
  params: z.strictObject({ id: z.string() }),
  store: ({ id }) => createStore(() => ({ id, count: 0 })),
  actions: (action) => ({
    Increment: action({
      handler: (_, { store }) => store.setState((s) => ({ count: s.count + 1 })),
    }),
  }),
})
export default defineStoreApp({ name: "web-counter", screens: [List, Detail] })
