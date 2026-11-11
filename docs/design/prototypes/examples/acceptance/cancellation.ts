import { expect } from "bun:test"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createTestApp } from "@reflex/test"
import { createStore } from "zustand/vanilla"

// Compile-only acceptance case until the target runtime exists. Ignores AbortSignal.
export async function abortIgnoringPromise() {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const Counter = defineStoreNode({
    name: "Counter",
    store: () => createStore(() => ({ count: 0 })),
    actions: (action) => ({
      IgnoreAbort: action({
        handler: async (_, { store }) => {
          await gate
          store.setState({ count: 99 })
        },
      }),
    }),
  })
  const app = defineStoreApp({ name: "abort-ignoring", services: [Counter] })
  await using first = await createTestApp(app)
  const old = await first.node(Counter)
  const operation = await old.actions.IgnoreAbort.start()
  const next = await first.reset("default")
  release()
  await operation.cancelled()
  const fresh = await next.node(Counter)
  expect(await fresh.state()).toEqual({ count: 0 })
}
