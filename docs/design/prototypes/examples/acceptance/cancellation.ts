import { expect } from "bun:test"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createTestApp } from "@reflex/test"
import { protocolEvents } from "@reflex/test/advanced"
import { createStore } from "zustand/vanilla"

// Compile-only acceptance case until the target runtime exists. Ignores AbortSignal.
export async function abortIgnoringPromise() {
  let entered = () => {}
  const suspended = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finished = () => {}
  const settled = new Promise<void>((resolve) => {
    finished = resolve
  })
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
          entered()
          await gate
          store.setState({ count: 99 })
          finished()
        },
      }),
    }),
  })
  const app = defineStoreApp({ name: "abort-ignoring", services: [Counter] })
  await using first = await createTestApp(app)
  const old = await first.node(Counter)
  const operation = await old.actions.IgnoreAbort.start()
  await suspended
  const next = await first.reset("default")
  const beforeRelease = protocolEvents(next).length
  release()
  await settled
  await operation.cancelled()
  expect(
    protocolEvents(next)
      .slice(beforeRelease)
      .filter((event) => event.type === "state.changed"),
  ).toEqual([])
  const fresh = await next.node(Counter)
  expect(await fresh.state()).toEqual({ count: 0 })
}
