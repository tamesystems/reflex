import { Screen, defineApp, defineNavigation, defineService } from "@reflex/effect"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createTestApp } from "@reflex/test"
import { createReflexRouter } from "@reflex/react-router"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { createStore } from "zustand/vanilla"
import { z } from "zod"
class First extends Screen("First", { state: Schema.Number, initial: () => 0 }) {}
class Second extends Screen("Second", { state: Schema.String, initial: () => "" }) {}
// @case invalid-action | Actions must be built for this state with the action builder
First.implement({ actions: () => ({ Save: 123 }) })
const first = First.implement({ actions: (a) => ({ Add: a.reduce({ reducer: (_, n) => n + 1 }) }) })
// @case wrong-action-state | Actions must be built for this state with the action builder
Second.implement({ actions: () => first.actions })
First.implement({
  actions: (a) => ({
    Big: a({
      // @case bigint-input | Input must encode JSON; use jsonCodec
      input: Schema.BigInt,
      handler: () => Effect.void,
    }),
  }),
})
First.implement({
  actions: (a) => ({
    Big: a({
      // @case bigint-error | Error must encode JSON; use jsonCodec
      error: Schema.BigInt,
      handler: () => Effect.fail(1n),
    }),
  }),
})
Screen("BigParams", {
  state: Schema.Number,
  // @case bigint-params | Params must encode JSON; use jsonCodec
  params: { id: Schema.BigInt },
  initial: () => 0,
})
defineStoreNode({
  name: "BigStore",
  store: () => createStore(() => 0),
  actions: (a) => ({
    Big: a({
      // @case store-bigint-input | Input must encode JSON; use jsonCodec
      input: z.bigint(),
      handler: () => {},
    }),
  }),
})
class Needed extends Context.Service<Needed, { readonly n: number }>()("Needed") {}
const dependent = Layer.effect(
  Needed,
  Effect.map(Needed, (s) => s),
)
// @case common-layer-input | Property '"Scenario 'default' must provide"' is missing in type '{ name: "common-input"; screens: [Definition<typeof First, { readonly Add: Action<undefined, never, never, number>; }, number, never, "screen"> & { readonly name: "First"; readonly paramsType: {}; readonly encodedParams: {}; }]; layer: Layer.Layer<...>; }' but required in type '{ readonly "Scenario 'default' must provide": Needed; }'.
defineApp({ name: "common-input", screens: [first], layer: dependent })
// @case self-provided-layer | Property '"Scenario 'self' must provide"' is missing in type '{ layer: Layer.Layer<Needed, never, Needed>; }' but required in type '{ readonly "Scenario 'self' must provide": Needed; }'.
defineApp({ name: "self-input", screens: [first], scenarios: { self: { layer: dependent } } })
const requires = First.implement({
  actions: (a) => ({ Load: a({ handler: () => Effect.asVoid(Needed) }) }),
})
// @case absent-scenarios-coverage | Property '"Scenario 'default' must provide"' is missing in type '{ name: "uncovered"; screens: [Definition<typeof First, { readonly Load: Action<undefined, never, Needed, number>; }, number, Needed, "screen"> & { ...; }]; }' but required in type '{ readonly "Scenario 'default' must provide": Needed; }'.
defineApp({ name: "uncovered", screens: [requires] })
const service = defineService({
  name: "Service",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
// @case screen-role | screens accepts only screens or stores
defineApp({ name: "screen-role", screens: [service] })
// @case service-role | services accepts only services or stores
defineApp({ name: "service-role", services: [first] })
// @case effect-store-app | defineStoreApp accepts only stores
defineStoreApp({ name: "store-app", screens: [first] })
const paramStore = defineStoreNode({
  name: "Detail",
  params: z.object({ id: z.string() }),
  store: ({ id }) => createStore(() => ({ id })),
  actions: () => ({}),
})
// @case ambient-params | Ambient services must not require params
defineStoreApp({ name: "ambient", services: [paramStore] })
const Nav = defineNavigation({ First })
const Other = defineNavigation({ Second })
const foreign = First.implement({
  actions: (a) => ({ Go: a.navigates({ handler: () => Other.back }) }),
})
// @case foreign-navigator | No overload matches this call.
defineApp({ name: "foreign", navigation: Nav.implement([foreign], { initial: First }) })
const app = defineApp({ name: "first", screens: [first] })
const journey = await createTestApp(app)
// @case real-time-advance | advanceTime requires a virtualTime scenario
journey.advanceTime(100)
const router = createReflexRouter(app, { First: "/" })
// @case no-render-source | Type '{}' is not assignable to type 'HostRouteOptions'.
router.routes({ First: {} })
// @case nav-role-collision | First is declared more than once
defineApp({
  name: "duplicate",
  navigation: Nav.implement([first], { initial: First }),
  services: [
    defineStoreNode({ name: "First", store: () => createStore(() => 0), actions: () => ({}) }),
  ],
})
// @case store-invalid-action | Actions must be built for this state with the action builder
defineStoreNode({
  name: "Invalid",
  store: () => createStore(() => 0),
  actions: () => ({ Save: 123 }),
})
const ForeignStore = defineStoreNode({
  name: "ForeignStore",
  store: () => createStore(() => 0),
  actions: () => ({}),
})
defineStoreApp({ name: "empty" }).withScenarios({
  // @case foreign-store-override | Scenario stores must belong to this app
  seeded: { stores: [ForeignStore.withStore(() => createStore(() => 1))] },
})
// @case wrong-store-factory | Type 'StoreApi<string>' is not assignable to type 'StoreApi<number>'.
ForeignStore.withStore(() => createStore(() => "wrong"))
const BigParamStore = defineStoreNode({
  name: "BigParam",
  params: z.object({ id: z.bigint() }),
  store: ({ id }) => createStore(() => ({ id: String(id) })),
  actions: () => ({}),
})
// @case store-bigint-params | Params must encode JSON; use jsonCodec
defineStoreApp({ name: "params", screens: [BigParamStore] })
const Combined = defineNavigation({ First, Second })
const toFirst = First.implement({
  actions: (a) => ({ Go: a.navigates({ handler: () => Nav.back }) }),
})
const second = Second.implement({ actions: () => ({}) })
// @case navigator-subset | No overload matches this call.
defineApp({
  name: "subset-owner",
  navigation: Combined.implement([toFirst, second], { initial: First }),
})
