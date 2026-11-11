import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { defineApp, defineService, defineFixture, Screen } from "@reflex/effect"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import { createTestApp } from "@reflex/test"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

const Numeric = defineStoreNode({
  name: "Numeric",
  store: () => createStore(() => ({ count: 0 })),
  actions: () => ({}),
})
const Text = defineStoreNode({
  name: "Text",
  store: () => createStore(() => ({ text: "" })),
  actions: () => ({}),
})
defineStoreApp({
  name: "correlated",
  services: [Numeric, Text],
  scenarios: {
    // @ts-expect-error Raw pairs cannot forge correlated overrides.
    wrong: { stores: [{ definition: Numeric, factory: () => createStore(() => ({ text: "" })) }] },
  },
})
// @ts-expect-error withStore checks its own store, before app composition.
Numeric.withStore(() => createStore(() => ({ text: "" })))
const storeApp = defineStoreApp({ name: "store", services: [Numeric, Text] })
const count: number = storeApp.services[0].createStore().getState().count
void count
// @ts-expect-error Services are a collection at runtime.
storeApp.services.name
// @ts-expect-error Extensions cannot overwrite existing scenarios.
storeApp.withScenarios({ default: {} })
// @ts-expect-error Multiple scenarios require an explicit default.
defineStoreApp({ name: "ambiguous", scenarios: { one: {}, two: {} } })

defineStoreNode({
  name: "errors",
  store: () => createStore(() => 0),
  actions: (action) => ({
    // @ts-expect-error Rich errors need a JSON projection.
    Reject: action({ error: z.date(), handler: () => {} }),
  }),
})
const Home = Screen.define("Home", { state: Schema.Number, initial: () => 0, actions: () => ({}) })
const Service = defineService({
  name: "Service",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const Fixture = defineFixture({
  name: "Fixture",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const app = defineApp({ name: "effect", screens: [Home], services: [Service] })
// @ts-expect-error Screens are a collection at runtime.
app.screens.name
// @ts-expect-error Phantom fixture information is symbol-only.
app.fixtures
// @ts-expect-error Phantom layer output is symbol-only.
app.provided
// @ts-expect-error A non-Layer cannot enter coverage inference.
defineApp({ name: "bad-layer", layer: { hello: 1 } })
// @ts-expect-error Only fixtures belong in fixtures.
defineApp({ name: "bad-fixture", fixtures: [Service], scenarios: { default: {} } })
const variant = app.withScenarios(
  { timed: { virtualTime: true, layer: Layer.empty } },
  { fixtures: [Fixture] },
)
const session = await createTestApp(variant, { scenario: "timed" })
void session.advanceTime(1)

const numericOverride = Numeric.withStore(() => createStore(() => ({ count: 1 })))
defineStoreApp({
  name: "branded-correlation",
  services: [Numeric, Text],
  scenarios: {
    // @ts-expect-error Even a branded override cannot decouple its definition and factory.
    wrong: { stores: [{ ...numericOverride, factory: () => createStore(() => ({ text: "" })) }] },
  },
})
