import { Screen, defineApp, defineNavigation } from "@reflex/effect"
import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createReflex } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import { routeCodec } from "@reflex/react-router/advanced"
import { jsonCodec } from "@reflex/effect/advanced"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

export class Count extends Screen("Count", {
  state: Schema.Struct({ count: Schema.Number }),
  params: { count: Schema.NumberFromString },
  initial: ({ count }) => ({ count }),
}) {}
export const Nav = defineNavigation({ Count })
export const CountLive = Count.implement({
  actions: (action) => ({
    Set: action({
      input: Schema.NumberFromString,
      error: Schema.NumberFromString,
      handler: (n, { state }) => (n < 0 ? Effect.fail(n) : state.set({ count: n })),
    }),
    Stay: action.navigates({ handler: () => Effect.succeed(Nav.stay) }),
  }),
})
export const app = defineApp({
  name: "codecs",
  navigation: Nav.implement([CountLive], { initial: { screen: Count, params: { count: 1 } } }),
})
export const reflex = createReflexRouter(app, { Count: "/count/:count" })
// Commands use decoded values; href/Link use encoded values.
Nav.push(Count, { count: 2 })
reflex.href(Count, { count: "2" })
const effectBinding = createReflex(app)
export function useSetCount() {
  const view = effectBinding.useScreenStatus(Count)
  return async () => {
    if (view.status !== "ready") {
      return null
    }
    const outcome = await view.actions.Set.run("2")
    if (outcome.status === "error") {
      const encodedError: string = outcome.error
      return encodedError
    }
    return null
  }
}
export const custom = createReflexRouter(app, {
  Count: routeCodec({
    path: "/count/*",
    decode: (raw) => ({ count: typeof raw.tail === "string" ? raw.tail : "0" }),
    encode: (params) => `/count/${encodeURIComponent(params.count)}`,
  }),
})
const encodeCount = (n: number) => ({ count: n })
const wireSpec = {
  encode: encodeCount,
  decode: (value: unknown) =>
    Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Number }))(value).pipe(
      Effect.map((value) => value.count),
    ),
  jsonSchema: { type: "object" },
}
export const wire = jsonCodec(Schema.NumberFromString, wireSpec)
interface CounterState {
  count: number
}
const initial: CounterState = { count: 0 }
export const StoreCounter = defineStoreNode({
  name: "StoreCounter",
  store: () => createStore(() => initial),
  actions: (action) => ({
    Set: action({
      input: z.string().transform(Number),
      error: z.string().transform(Number),
      projectError: (n) => String(n),
      handler: (n, { store, fail }) => {
        if (n < 0) {
          fail(n)
        }
        store.setState({ count: n })
      },
    }),
  }),
})
export const storeApp = defineStoreApp({ name: "store-codecs", services: [StoreCounter] })
export const storeBinding = createReflex(storeApp)

export class WireCount extends Screen("WireCount", { state: wire, initial: () => 1 }) {}
