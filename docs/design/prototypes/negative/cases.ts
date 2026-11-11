import { InventoryApi } from "../examples/examples/inventory/src/domain.ts"
import { Screen, defineNavigation, defineApp, defineFixture } from "@reflex/effect"
import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createReflex } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import { createTestApp, includes } from "@reflex/test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createStore } from "zustand/vanilla"
import { z } from "zod"
import app from "../examples/examples/inventory/src/scenarios.ts"
import {
  InventoryList,
  InventoryDetail,
  Settings,
} from "../examples/examples/inventory/src/screens.ts"
import { fixtureApi, seedProducts } from "../examples/examples/inventory/src/fixtures.ts"
import { InventoryFixture } from "../examples/examples/inventory/src/fixtures.ts"
import { Nav } from "../examples/examples/inventory/src/navigation.ts"
import { InventoryDetailLive } from "../examples/examples/inventory/src/features/inventory-detail.ts"
import { SettingsLive } from "../examples/examples/inventory/src/features/settings.ts"
import { InventoryListLive } from "../examples/examples/inventory/src/features/inventory-list.ts"
import {
  Count,
  CountLive,
  Nav as CodecNav,
  reflex as codecReflex,
  storeBinding,
  StoreCounter,
} from "../examples/codecs.ts"
import { route } from "../api/routes"

const reflex = createReflex(app)
// @case role-fixture | InventoryFixture is not a screen of app 'inventory'
reflex.useScreen(InventoryFixture)
class ForeignDetail extends Screen("InventoryDetail", {
  state: InventoryDetail.state,
  params: { productId: Schema.String },
  initial: ({ productId }) => ({ _tag: "loading", productId }),
}) {
  declare private readonly nominal: undefined
}
// @case nominal | This InventoryDetail is a different contract from app 'inventory''s InventoryDetail
reflex.useScreen(ForeignDetail)
// @case screen-service | InventoryDetail is not a service of app 'inventory'
reflex.useService(InventoryDetail)
// @case fixture-service | InventoryFixture is not a service of app 'inventory'
reflex.useService(InventoryFixture)
const live = await createTestApp(app, { scenario: "live-services" })
// @case absent-fixture | InventoryFixture is not a fixture of this scenario of app 'inventory'
live.node(InventoryFixture)
declare const scenario: "live-services" | "inventory-with-products"
const union = await createTestApp(app, { scenario })
// @case union-fixture | InventoryFixture is not a fixture of this scenario of app 'inventory'
union.node(InventoryFixture)
// @case duplicate-implementation | InventoryList is declared more than once
Nav.implement([InventoryListLive, InventoryListLive], { initial: InventoryList })
// @case missing-implementation | InventoryDetail
Nav.implement([InventoryListLive], { initial: InventoryList })
// @case unknown-params | productId
Nav.push(InventoryDetail, {})
// @case union-push | not assignable
Nav.push(Math.random() ? InventoryDetail : Settings, { productId: "p" })
// @case no-params | not assignable
Nav.push(Settings, {})
// @case decoded-command | not assignable to type 'number'
CodecNav.push(Count, { count: "2" })
// @case encoded-href | not assignable to type 'string'
codecReflex.href(Count, { count: 2 })
// This heterogeneous navigator mirrors href's full tuple correlation.
// @case union-href | not assignable
Nav.push(Math.random() ? Settings : InventoryDetail, { productId: "p" })
// @case initial-correlation | not assignable
CodecNav.implement([CountLive], { initial: { screen: Count, params: { count: "1" } } })
Effect.gen(function* () {
  // @case yielded-command | TS2488
  yield* Nav.back
})
// @case command-pipe | Property 'pipe' does not exist
Nav.back.pipe(Effect.asVoid)
InventoryList.implement({
  actions: (action) => ({
    Bad: action({
      // @case plain-navigation | Use action.navigates for actions that navigate
      handler: () => Effect.succeed(Nav.back),
    }),
    BadFailure: action({
      // @case undeclared-error | Declare action failures with error:
      handler: () => Effect.fail("oops"),
    }),
    BadInput: action({
      // @case undeclared-input | not assignable
      handler: (_input: { by: number }) => Effect.void,
    }),
    MissingReturn: action.navigates({
      handler: () =>
        // @case dropped-navigation | not assignable
        Effect.gen(function* () {
          yield* Effect.void
          Nav.back
        }),
    }),
    Erased: action.navigates({
      // @case erased-navigation | not assignable
      handler: (): Effect.Effect<void> => Effect.succeed(Nav.back),
    }),
    BadRecovery: action.navigates({
      handler: () => Effect.succeed(Nav.back),
      // @case refusal-command | Navigation refusal recovery must return void
      onRefused: () => Effect.succeed(Nav.back),
    }),
  }),
})
InventoryList.implement({
  actions: () => ({}),
  // @case focus-error | Handle onFocus failures into state
  onFocus: () => Effect.fail("oops"),
})
InventoryList.implement({
  actions: () => ({}),
  // @case focus-navigation | Use action.navigates for actions that navigate
  onFocus: () => Effect.succeed(Nav.back),
})
const storeView = storeBinding.useService(StoreCounter)
if (storeView.status === "ready") {
  // @case transformed-store-input | not assignable to parameter of type 'string'
  storeView.actions.Set.run(2)
}
const codecView = codecReflex.useScreen(Count)
if (codecView.status === "ready") {
  // @case transformed-effect-input | not assignable to parameter of type 'string'
  codecView.actions.Set.run(2)
}
// @case json-date | Store state must be JSON; provide project
defineStoreNode({
  name: "Date",
  store: () => createStore(() => ({ now: new Date() })),
  actions: () => ({}),
})
// @case json-function | Store state must be JSON; provide project
defineStoreNode({
  name: "Function",
  store: () => createStore(() => ({ f: () => 1 })),
  actions: () => ({}),
})
const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => ({ count: 0 })),
  actions: (action) => ({
    NoError: action({
      handler: (
        _,
        {
          store,
          // @case no-fail | Property 'fail' does not exist
          fail: _fail,
        },
      ) => store.setState({ count: 0 }),
    }),
    // @case rich-error | Store error must be JSON; provide projectError
    Rich: action({ error: z.instanceof(Error), handler: () => {} }),
    Nav: action({
      // @case store-command | Store handlers cannot return NavigationCommand
      handler: () => Nav.back,
    }),
  }),
})
// @case duplicate-service | Counter is declared more than once
defineStoreApp({ name: "x", services: [Counter, Counter] })
// @case multiple-roles | Choose navigation or screens, not both
defineApp({
  name: "x",
  navigation: Nav.implement([InventoryListLive, InventoryDetailLive, SettingsLive], {
    initial: InventoryList,
  }),
  screens: [InventoryListLive],
})
Screen("Invalid", {
  state: Schema.Struct({ count: Schema.Number }),
  // @case initial-schema | not assignable to type 'number'
  initial: () => ({ count: "one" }),
})
// @case includes-typo | qty
live.focused(InventoryList, { _tag: "ready", products: includes({ id: "p", qty: 5 }) })
// @case match-variant | State match fields must belong to one variant
live.focused(InventoryList, { _tag: "loading", products: includes({ id: "p" }) })
// @case unknown-scenario | not assignable
createTestApp(app, { scenario: "typo" })
// @case extension-default | withScenarios defaultScenario must exist
defineStoreApp({ name: "empty" }).withScenarios({ extra: {} }, { defaultScenario: "missing" })
// @case extension-repeat | Scenario live-services already exists; choose a new name
app.withScenarios({ "live-services": {} })
const path = route<{ id: string; tab?: string }>()
// @case repeated-placeholder | Repeated path placeholder id
path("/:id/:id")
// @case group | Excluded route grammar; use routeCodec
path("/(group)/:id")
// @case catchall | Excluded route grammar; use routeCodec
path("/:id/*")
// @case spread | Excluded route grammar; use routeCodec
path("/[...id]")
// @case optional-grammar | Excluded route grammar; use routeCodec
path("/:id?")
// @case optional-placeholder | Optional route param tab cannot be a path placeholder
path("/:id/:tab")
// @case unmatched-placeholder | Path placeholder other has no matching param; add a params mapping
path("/:other")
// @case missing-placeholder | Required route param id must appear as a path placeholder
path("/")
// @case mapping-duplicates | URL param mapping targets must be unique
path("/:id", { tab: "id" })
// @case mapping-keys | URL param mapping names must be schema fields
path("/:id", { typo: "id" })
// @case dynamic-path | Route path must be a literal; use advanced routeCodec for dynamic paths
path("/:id" as string)
// @case numeric-url | URL param id must encode a string; use a string codec
route<{ id: number }>()("/:id")
// @case registration-missing | Settings
createReflexRouter(app, { InventoryList: "/", InventoryDetail: "/:productId" })
const router = createReflexRouter(app, {
  InventoryList: "/",
  InventoryDetail: "/:productId",
  Settings: "/settings",
})
// @case component-missing | Settings
router.routes({ InventoryList: {}, InventoryDetail: {} })
// @case href-union | not assignable
router.href(Math.random() ? InventoryDetail : Settings, { productId: "p" })
const ParamFree = defineStoreNode({
  name: "ParamFree",
  store: () => createStore(() => ({ count: 0 })),
  actions: (action) => ({ Reset: action({ handler: () => {} }) }),
})
const service = createReflex(defineStoreApp({ name: "plain", services: [ParamFree] })).useService(
  ParamFree,
)
if (service.status === "ready") {
  // @case zero-arity | Expected 0 arguments, but got 1
  service.actions.Reset.run({})
}
const NeedsNav = InventoryList.implement({
  actions: (action) => ({ Go: action.navigates({ handler: () => Effect.succeed(Nav.back) }) }),
})
// @case missing-navigator | Action Go of app 'no-nav' requires a navigator
defineApp({ name: "no-nav", screens: [NeedsNav] })
// @case missing-service | Scenario 'missing' must provide
defineApp({
  name: "coverage",
  screens: [InventoryListLive],
  scenarios: { missing: {} },
  defaultScenario: "missing",
})
const importedFixtureLayer = fixtureApi({ products: seedProducts })
// @case missing-fixture | Scenario 'missing-fixture' must provide
app.withScenarios({ "missing-fixture": { layer: importedFixtureLayer, fixtures: [] } })
const needsApi = Effect.gen(function* () {
  yield* InventoryApi
})
const NeedsServices = defineFixture({
  name: "NeedsServices",
  state: Schema.Number,
  initial: () => 0,
  actions: (action) => ({ Load: action({ handler: () => needsApi }) }),
})
const fixtureApp = defineStoreApp({ name: "fixture-coverage" })
// @case fixture-action-service | Scenario 'missing' must provide
fixtureApp.withScenarios({ missing: { fixtures: [NeedsServices] } })
// @case role-collision | ParamFree is declared more than once
defineStoreApp({ name: "collision", screens: [ParamFree], services: [ParamFree] })
// @case missing-default | defaultScenario
defineApp({ name: "two", scenarios: { one: {}, two: {} } })
// @case record-alias | Navigation key Second must match contract name InventoryDetail
defineNavigation({ InventoryDetail, Second: InventoryDetail })
// @case effect-rich-state | Effect state must encode JSON; use jsonCodec
Screen("Rich", { state: Schema.Date, initial: () => new Date() })
const NoNavigationFixture = defineFixture({
  name: "Fixture",
  state: Schema.Number,
  initial: () => 0,
  actions: (action) => ({
    // @case fixture-navigates | Property 'navigates' does not exist
    Go: action.navigates({ handler: () => Effect.succeed(Nav.back) }),
  }),
})
const readonlyView = codecReflex.useScreen(Count)
if (readonlyView.status === "ready") {
  // @case readonly-state | read-only property
  readonlyView.state.count = 2
}
const serviceDefinition = defineStoreNode({
  name: "TransformedError",
  store: () => createStore(() => ({ count: 0 })),
  actions: (action) => ({
    // @case transformed-error-encoder | projectError
    Save: action({ error: z.string().transform(Number), handler: () => {} }),
  }),
})
void NoNavigationFixture
void serviceDefinition
const UnknownInput = defineStoreNode({
  name: "UnknownInput",
  store: () => createStore(() => ({ count: 0 })),
  actions: (action) => ({ Send: action({ input: z.unknown(), handler: () => {} }) }),
})
const unknownView = createReflex(
  defineStoreApp({ name: "unknown", services: [UnknownInput] }),
).useService(UnknownInput)
if (unknownView.status === "ready") {
  // @case unknown-input-presence | Expected 1 arguments, but got 0
  unknownView.actions.Send.run()
}
