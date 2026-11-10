# Reflex userland API specification

Status: proposed, implementation deliberately absent. Baseline: origin/userland-api,
2a26d9e. This document supersedes the _target author API_ in ADRs 0020–0022; it does
not claim those changes have shipped. Protocol, access policy, controller parity,
core navigation ownership, dependency boundaries and resource limits remain as in
ARCHITECTURE.md. No roadmap item is implemented by this design-only change.

## 1. Decisions

1. Contracts carry state and params; implementations carry actions and requirements.
   `X`, `XLive`, `XView` name those three things. A contract is a class constructor,
   and that constructor is its runtime identity. An implementation is a frozen object
   `{ contract, actions, onFocus }`; that object is its separate implementation identity.
   No identity token, SCREEN_CONTRACT, DEFINITION_IDENTITY, or public `resolve` exists.
   Resolution always goes through the session's selected implementation table.
2. **Nominality has one unavoidable line.** Each authored Screen class declares
   `declare private readonly nominal: undefined`. `Self` is invariant on the generated
   instance, and static methods infer `this`, retaining the subclass. Empty same-name
   subclasses are structurally interchangeable in TS 5.9, including with a Self field;
   the prototype includes this counterexample. A private member declared in the factory
   would also be shared. We choose a private declaration in the author class over
   pretending the requested empty-body spelling is generatively nominal. It emits no JS,
   writes the screen name once, and needs no manual symbol. Different contracts with
   the same name are additionally rejected at app construction. ESLint/private-field
   rules must allow this documented nominal member.
3. One `defineApp` value selects implementations. Effect apps choose navigation or
   `screens` plus `services`; store apps choose `screens` plus `services`. Arrays derive
   keys from names, reject duplicate names, and never expose `root`, `nodes`, `type`, or
   `Nav.layer`. `defineStoreNode` defaults to a service; placing it in `screens` gives it
   screen lifetime. No separate screen-node kind is authored. A single navigator is
   named `default`; an optional key is for multiple navigator integration in advanced.
4. **Navigation is terminal data, not a queued Effect.** `Nav.push(Contract, params)`
   and `Nav.back` produce opaque commands. A handler must return a command, directly
   in a store handler or as the success value of its Effect. A command is not yieldable,
   has no `pipe`, and has no error channel. One invocation can return at most one.
   `onRefused(error, ctx)` belongs to the action definition and runs before departure
   when the command is refused. It returns void, cannot navigate, and cannot fail in
   the Effect error channel. Handling a refusal still yields a refused action outcome;
   the callback updates UI state, it does not relabel failure as success.
5. Terminal execution is owned by the session operation supervisor. It prepares the
   target in a provisional scope, validates limits, and atomically commits stack/focus
   only on success. Refusal closes the provisional scope, leaves the source alive and
   invokes its recovery callback. Successful back commits before closing the departing
   scope; its originating operation is excluded from that scope's cancellation and
   completes under the supervisor. Other departing work is interrupted. Cancellation
   before commit abandons preparation; after commit it cannot undo navigation. No
   source state access is permitted after commit. Effect failures before returning a
   command discard it. Back at the root is refused with `AtRoot`. Defects are defects,
   not NavigationRefused. External router gestures reconcile the core and may cancel
   in-flight handlers; this does not turn a command into an immediate Effect.
6. A scenario owns its fixture list. `defineFixture` creates a yielding Effect service
   for write access and an observable definition for journeys. Session construction
   mounts the listed fixtures _before_ building the scenario layer and automatically
   supplies their access services. A layer requiring an unlisted fixture is a composition
   error. Scenario layers cannot independently mount hidden fixtures. Fixtures are
   services on the wire, with fixture access policy; there is no new node kind.
7. `open(app, { scenario: "x" })` / `connectJourney` returns a session specialized to x.
   With a union scenario it grants only fixtures present in every possible scenario.
   `reset("y")` returns a **new typed client** specialized to y and invalidates all older
   clients by session generation; callers must use the returned client. UI binding
   controls expose `scenario: string`: `withScenarios` preserves identity and can add
   scenarios unknown to a base binding. `useSession().forScenario(app, "x")` returns a
   checked, generation-bound view or undefined; it is the only UI fixture access path.
   Base hooks accept screens and services common to all base scenarios, never optional
   fixture unions. Runtime identity/membership is checked even for widened JS callers.
8. Each host has one binding object, created at module scope. `Provider app={app}` is
   required and validates the bound app's identity, including identity-preserving
   `withScenarios`. It can never accept an independently constructed same-name app.
   Provider props and hook vocabulary agree across React, Expo and React Router.
9. Each session has **one route registry** keyed by `(contract object, history entry
   key)`, storing params hash, generation, pending promise, node, scope and lease state.
   Both normal and Suspense hooks read it. A second lookup reuses the pending promise;
   conflicting params for one key are an error. Acquisition is idempotent. Normal hooks
   initiate in a commit effect; Suspense may request during render, but the session owns
   provisional work. Unclaimed work is aborted at the existing route-build deadline;
   no render owns a resource. Navigation-owned entries pin their existing registry node.
   Host-only entries retain at most 64 history entries; unreachable forward entries are
   released immediately. Eviction cancels pending builds, removes the registry/store
   entry, unsubscribes, disposes once and closes the scope. Late completion is disposed
   rather than installed. Reset/Provider teardown drains the registry. No append-only
   `nodes` array or second Suspense cache survives. Every peer-reachable bound/deadline
   is named in protocol/limits.ts at implementation time, including the existing bounds
   currently expressed locally. The bound applies to provisional as well as live entries.
10. Expo Provider includes projection. Expo uses its files/Stack; URLs mirror the core.
    React Router `routes(views)` emits ordinary RouteObject[] from the registration;
    its wrappers read pathname, params and history key. Router-owned apps (no `navigation`)
    follow the router, including POP/deep links; core-navigation apps project the core
    and reconcile external location changes through the navigation port. One binding
    cannot silently switch ownership modes. Links use the same registration. Native
    `<Link>` and browser back remain idiomatic host operations.
11. Required params are path placeholders, optional params default to query fields.
    Both adapters default URL names to schema field names; `params` maps _only changed_
    names. Literal Expo `[x]` and React Router `:x` segments are checked. All placeholders
    must correspond to fields, all required fields must occur, and targets are unique.
    URL field encodings must be strings (optionally undefined); numeric values use a
    string codec. Root grammar excludes catchalls, optional path segments, regexes and
    router groups; advanced `routeCodec` handles these explicitly and validates at
    runtime. Extra router query keys are ignored, never inserted into schema params.
12. Store `input:`/`error:` accept Standard Schema directly. Async validators are refused
    when preparation must be synchronous. `standardInput` exists only to provide JSON
    Schema when the vendor has no converter. Handler signature is `(input, ctx)` on
    both paths; Effect uses `ctx.state`, stores use `ctx.store`. No-input handlers receive
    undefined; calls take zero args. Error schema presence alone enables `ctx.fail` for
    stores. Unprojected state and errors must be JSON statically and are validated at
    publication; rich state/errors require `project`/`projectError`. Returned snapshots
    are detached, deeply readonly JSON. Default projection is identity, never a lossy
    `JSON.stringify` trick. Effect default projection uses encoded schema state, with
    redaction; custom schema JSON hooks require an explicit advanced wire codec.
13. Production providers import no test code. An entry alias selects the E2E provider,
    which passes `app.withScenarios(e2e)` with the same identity. Bridge code is isolated
    in Effect-free `@reflex/expo/dev` and `@reflex/live/dev`, guarded by bundler development
    constants. `dev` is a platform entry, not a third API tier. Root/advanced exports are
    explicit lists; sibling plumbing uses workspace-private source imports allowed by
    boundaries, never a package `/internal` export or user-facing wildcard barrel.

## 2. Complete authored files

The following are target source files, not snippets against the current implementation.
Each file is complete: no omitted handler, transport, wrapper, or hidden helper is needed.
Existing package manifests, Expo configuration, HTML shell and server.ts remain normal
infrastructure; the files below replace their author-facing API use. Inventory domain
limits are application business limits, not new protocol limits. The HTTP adapter keeps
app-owned parsing because HTTP is the application's external boundary; journeys do not
parse JSON. Future implementation must compile these files together in fixture projects;
the current docs compiler does not compile this proposed API. Only prototypes are verified
in this design change.

### examples/inventory/src/domain.ts

```ts
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export const QUANTITY_MAX = 100_000
export const LOW_STOCK_THRESHOLD_MAX = 1_000

export const Quantity = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: QUANTITY_MAX }))

export const Product = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  quantity: Quantity,
})
export type Product = typeof Product.Type

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String,
}) {}

/** Everything core logic needs from the outside world, as interfaces only. */
export class InventoryApi extends Context.Service<
  InventoryApi,
  {
    readonly list: Effect.Effect<ReadonlyArray<Product>, ApiError>
    get(id: string): Effect.Effect<Product, ApiError>
    saveQuantity(id: string, quantity: number): Effect.Effect<void, ApiError>
  }
>()("inventory/InventoryApi") {}

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly load: Effect.Effect<{
      readonly lowStockThreshold: number
      readonly apiToken: Redacted.Redacted<string>
    }>
    setLowStockThreshold(value: number): Effect.Effect<void>
  }
>()("inventory/SettingsStore") {}

export const isLowStock = (product: Product, lowStockThreshold: number): boolean =>
  product.quantity < lowStockThreshold
```

### examples/inventory/src/screens.ts

```ts
import { Screen } from "@reflex/effect"
import * as Schema from "effect/Schema"
import { Product, Quantity } from "./domain.ts"

const InventoryListState = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("failed", { error: Schema.String }),
  Schema.TaggedStruct("ready", {
    products: Schema.Array(Product),
    lowStockThreshold: Schema.Int,
  }),
])

export class InventoryList extends Screen<InventoryList>()("InventoryList", {
  state: InventoryListState,
  initial: () => ({ _tag: "loading" }),
}) {
  declare private readonly nominal: undefined
}

const Loaded = {
  productId: Schema.String,
  title: Schema.String,
  quantity: Quantity,
}

const InventoryDetailState = Schema.Union([
  Schema.TaggedStruct("loading", { productId: Schema.String }),
  Schema.TaggedStruct("missing", { productId: Schema.String, error: Schema.String }),
  Schema.TaggedStruct("editing", { ...Loaded, error: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("saving", Loaded),
])

export class InventoryDetail extends Screen<InventoryDetail>()("InventoryDetail", {
  state: InventoryDetailState,
  params: { productId: Schema.String },
  initial: ({ productId }) => ({ _tag: "loading", productId }),
}) {
  declare private readonly nominal: undefined
}

const SettingsState = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("ready", {
    lowStockThreshold: Schema.Int,
    apiToken: Schema.Redacted(Schema.String),
  }),
])

export class Settings extends Screen<Settings>()("Settings", {
  state: SettingsState,
  initial: () => ({ _tag: "loading" }),
}) {
  declare private readonly nominal: undefined
}
```

### examples/inventory/src/navigation.ts

```ts
import { defineNavigation } from "@reflex/effect"
import { InventoryList, InventoryDetail, Settings } from "./screens.ts"

export const Nav = defineNavigation([InventoryList, InventoryDetail, Settings])
```

### examples/inventory/src/features/inventory-list.ts

```ts
import { InventoryList, InventoryDetail, Settings } from "../screens.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InventoryApi, SettingsStore } from "../domain.ts"
import { Nav } from "../navigation.ts"

const load = InventoryList.handler(({ state }) =>
  Effect.gen(function* () {
    const api = yield* InventoryApi
    const settings = yield* SettingsStore
    yield* state.set({ _tag: "loading" })
    const { lowStockThreshold } = yield* settings.load
    yield* api.list.pipe(
      Effect.matchEffect({
        onFailure: ({ message }) => state.update(() => ({ _tag: "failed", error: message })),
        onSuccess: (products) =>
          state.update(() => ({ _tag: "ready", products, lowStockThreshold })),
      }),
    )
  }),
)

export const InventoryListLive = InventoryList.implement({
  onFocus: load,
  actions: (action) => ({
    OpenProduct: action.when("ready")({
      description: "Open a product's detail screen",
      input: Schema.Struct({ productId: Schema.String }),
      handler: ({ productId }) => Effect.succeed(Nav.push(InventoryDetail, { productId })),
    }),
    OpenSettings: action({
      handler: () => Effect.succeed(Nav.push(Settings)),
    }),
    Refresh: action({
      available: (state) => (state._tag === "loading" ? "Products are loading" : true),
      handler: (_, { state }) => load({ state }),
    }),
  }),
})
```

### examples/inventory/src/features/inventory-detail.ts

```ts
import { InventoryDetail } from "../screens.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ApiError, InventoryApi, Quantity, QUANTITY_MAX } from "../domain.ts"
import { Nav } from "../navigation.ts"

const SAVE_TIMEOUT = "5 seconds"

const save = InventoryDetail.when("editing").handler(({ state }) =>
  Effect.gen(function* () {
    const api = yield* InventoryApi
    const current = yield* state.get
    const { productId, title, quantity } = current
    yield* state.update(() => ({ _tag: "saving", productId, title, quantity }))
    const finish = (error: string | null) =>
      state.when("saving").update(() => ({ _tag: "editing", productId, title, quantity, error }))
    yield* api.saveQuantity(productId, quantity).pipe(
      Effect.timeoutOrElse({
        duration: SAVE_TIMEOUT,
        orElse: () => Effect.fail(new ApiError({ message: "Save timed out" })),
      }),
      Effect.tapError(({ message }) => finish(message)),
      Effect.tap(() => finish(null)),
      Effect.onInterrupt(() => finish(null)),
    )
  }),
)

export const InventoryDetailLive = InventoryDetail.implement({
  onFocus: ({ state }) =>
    Effect.gen(function* () {
      const api = yield* InventoryApi
      const current = yield* state.get
      // Coming back must not discard edits, or forget a save that is still running.
      if (current._tag !== "loading") {
        return
      }
      const { productId } = current
      yield* api.get(productId).pipe(
        Effect.matchEffect({
          onFailure: ({ message }) =>
            state.update(() => ({ _tag: "missing", productId, error: message })),
          onSuccess: ({ title, quantity }) =>
            state.update(() => ({ _tag: "editing", productId, title, quantity, error: null })),
        }),
      )
    }),
  actions: (action) => ({
    Increment: action.when("editing").reduce({
      available: (state) =>
        state.quantity < QUANTITY_MAX ? true : "Quantity is already at its maximum",
      reducer: (_, state) => ({ ...state, quantity: state.quantity + 1 }),
    }),
    Decrement: action.when("editing").reduce({
      available: (state) => (state.quantity > 0 ? true : "Quantity is already zero"),
      reducer: (_, state) => ({ ...state, quantity: state.quantity - 1 }),
    }),
    SetQuantity: action.when("editing").reduce({
      description: "Set the quantity directly",
      input: Schema.Struct({ quantity: Quantity }),
      reducer: ({ quantity }, state) => ({ ...state, quantity }),
    }),
    Save: action.when("editing")({
      description: "Persist the quantity; gives up after 5 seconds",
      error: ApiError,
      handler: (_, { state }) => save({ state }),
    }),
    SaveAndClose: action.when("editing")({
      description: "Persist the quantity and return to the previous screen",
      error: ApiError,
      handler: (_, { state }) =>
        Effect.gen(function* () {
          yield* save({ state })
          return Nav.back
        }),
      onRefused: ({ reason }, { state }) =>
        state.when("editing").update((current) => ({ ...current, error: reason })),
    }),
  }),
})
```

### examples/inventory/src/features/settings.ts

```ts
import { Settings } from "../screens.ts"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import { LOW_STOCK_THRESHOLD_MAX, SettingsStore } from "../domain.ts"

export const SettingsLive = Settings.implement({
  onFocus: ({ state }) =>
    Effect.gen(function* () {
      const store = yield* SettingsStore
      const loaded = yield* store.load
      yield* state.update(() => ({ _tag: "ready", ...loaded }))
    }),
  actions: (action) => ({
    RaiseLowStockThreshold: action.when("ready")({
      available: (state) =>
        state.lowStockThreshold < LOW_STOCK_THRESHOLD_MAX ? true : "Threshold is at its maximum",
      handler: (_, { state }) =>
        Effect.gen(function* () {
          const current = yield* state.get
          const store = yield* SettingsStore
          const threshold = current.lowStockThreshold + 1
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((value) => ({ ...value, lowStockThreshold: threshold }))
        }),
    }),
    SetLowStockThreshold: action.when("ready")({
      input: Schema.Struct({
        threshold: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: LOW_STOCK_THRESHOLD_MAX }),
        ),
      }),
      handler: ({ threshold }, { state }) =>
        Effect.gen(function* () {
          const store = yield* SettingsStore
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((current) => ({ ...current, lowStockThreshold: threshold }))
        }),
    }),
  }),
})
```

### examples/inventory/src/fixtures.ts

```ts
import { defineFixture } from "@reflex/effect"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ApiError, InventoryApi, type Product, SettingsStore } from "./domain.ts"

/** Journeys look at the last few saves. Keeping more only costs copying. */
const SAVED_HISTORY_MAX = 32
const LOW_STOCK_THRESHOLD_DEFAULT = 10

const FixtureState = Schema.Struct({
  saved: Schema.Array(Schema.Struct({ productId: Schema.String, quantity: Schema.Int })),
  failNextSave: Schema.Boolean,
})

/** Test doubles are nodes too, so journeys and agents can observe and steer them. */
export const InventoryFixture = defineFixture({
  name: "InventoryFixture",
  state: FixtureState,
  initial: () => ({ saved: [], failNextSave: false }),
  actions: (action) => ({
    FailNextSave: action({
      description: "Make the next save fail, as a server error would",
      handler: (_, { state }) => state.update((s) => ({ ...s, failNextSave: true })),
    }),
  }),
})

export const seedProducts: ReadonlyArray<Product> = [
  { id: "product-123", title: "Blue T-Shirt", quantity: 5 },
  { id: "product-456", title: "Grey Hoodie", quantity: 40 },
  { id: "product-789", title: "Canvas Tote", quantity: 2 },
]

export interface ScenarioOptions {
  readonly products: ReadonlyArray<Product>
  readonly saveDelay?: Duration.Input
}
export const fixtureApi = (options: ScenarioOptions) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const products = new Map(options.products.map((product) => [product.id, product]))
      const state = yield* InventoryFixture

      const saveQuantity = Effect.fnUntraced(function* (productId: string, quantity: number) {
        if (options.saveDelay !== undefined) {
          yield* Effect.sleep(options.saveDelay)
        }
        const { failNextSave } = yield* state.get
        if (failNextSave) {
          yield* state.update((s) => ({ ...s, failNextSave: false }))
          return yield* new ApiError({ message: "Server error" })
        }
        const product = products.get(productId)
        if (product !== undefined) {
          products.set(productId, { ...product, quantity })
        }
        yield* state.update((s) => ({
          ...s,
          saved: [...s.saved, { productId, quantity }].slice(-SAVED_HISTORY_MAX),
        }))
      })

      return InventoryApi.of({
        list: Effect.sync(() => [...products.values()]),
        get: (id) => {
          const product = products.get(id)
          if (product === undefined) {
            return Effect.fail(new ApiError({ message: `No product "${id}"` }))
          }
          return Effect.succeed(product)
        },
        saveQuantity,
      })
    }),
  )

export const fixtureSettings = Layer.sync(SettingsStore, () => {
  let lowStockThreshold = LOW_STOCK_THRESHOLD_DEFAULT
  return SettingsStore.of({
    load: Effect.sync(() => ({
      lowStockThreshold,
      apiToken: Redacted.make("secret-fixture-token"),
    })),
    setLowStockThreshold: (value) =>
      Effect.sync(() => {
        lowStockThreshold = value
      }),
  })
})
```

### examples/inventory/src/http-api.ts

```ts
import { INVENTORY_HTTP_BODY_BYTES_MAX, INVENTORY_HTTP_TIMEOUT_MS } from "./limits.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { ApiError, InventoryApi, Product } from "./domain.ts"

const ErrorBody = Schema.Struct({ message: Schema.String })
const Saved = Schema.Struct({ ok: Schema.Literal(true) })

/** Platform-neutral transport; imported only by the app's real-service composition. */
export const httpInventoryApi = (baseUrl: string) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const client = HttpClient.withScope(yield* HttpClient.HttpClient)
      const base = baseUrl.replace(/\/$/, "")
      const request = <A>(path: string, schema: Schema.Codec<A>, quantity?: number) =>
        Effect.gen(function* () {
          const req =
            quantity === undefined
              ? HttpClientRequest.get(`${base}${path}`)
              : HttpClientRequest.put(`${base}${path}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ quantity }),
                )
          const response = yield* client.execute(req)
          // A declared size is refused before any of it is read; the rest is checked after.
          const declared = Number(response.headers["content-length"] ?? Number.NaN)
          if (declared > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const bytes = yield* response.arrayBuffer
          if (bytes.byteLength > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const json = yield* Effect.try({
            try: () => JSON.parse(new TextDecoder().decode(bytes)),
            catch: () => new ApiError({ message: "Invalid inventory JSON" }),
          })
          if (response.status < 200 || response.status >= 300) {
            const body = yield* Schema.decodeUnknownEffect(ErrorBody)(json)
            return yield* new ApiError({ message: body.message })
          }
          return yield* Schema.decodeUnknownEffect(schema)(json)
        }).pipe(
          Effect.scoped,
          Effect.mapError((error) =>
            error instanceof ApiError
              ? error
              : new ApiError({ message: "Inventory request failed" }),
          ),
          Effect.timeoutOrElse({
            duration: INVENTORY_HTTP_TIMEOUT_MS,
            orElse: () => Effect.fail(new ApiError({ message: "Inventory request timed out" })),
          }),
        )
      return InventoryApi.of({
        list: request("/products", Schema.Array(Product)),
        get: (id) => request(`/products/${encodeURIComponent(id)}`, Product),
        saveQuantity: (id, quantity) =>
          request(`/products/${encodeURIComponent(id)}`, Saved, quantity).pipe(Effect.asVoid),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
```

### examples/inventory/src/limits.ts

```ts
/**
 * Limits of the example's own HTTP service. They belong to this app, not to Reflex:
 * the protocol's limits (packages/protocol/src/limits.ts) bound what a peer can make
 * Reflex itself hold, while these bound one app's requests to one server.
 */

/** Below the domain's five-second save deadline, so a hung server fails as `ApiError`. */
export const INVENTORY_HTTP_TIMEOUT_MS = 4_000
/** Three products fit in a few hundred bytes; anything this large is not this server. */
export const INVENTORY_HTTP_BODY_BYTES_MAX = 64 * 1024
```

### examples/inventory/src/app.ts

```ts
import { defineApp } from "@reflex/effect"
import * as Layer from "effect/Layer"
import { fixtureApi, fixtureSettings, seedProducts, InventoryFixture } from "./fixtures.ts"
import { InventoryListLive } from "./features/inventory-list.ts"
import { InventoryDetailLive } from "./features/inventory-detail.ts"
import { SettingsLive } from "./features/settings.ts"
import { InventoryList } from "./screens.ts"
import { Nav } from "./navigation.ts"

const services = (products: typeof seedProducts, saveDelay?: "1 second" | "30 seconds") =>
  Layer.merge(
    fixtureApi({ products, ...(saveDelay === undefined ? {} : { saveDelay }) }),
    fixtureSettings,
  )

export default defineApp({
  name: "inventory",
  navigation: Nav.implement([InventoryListLive, InventoryDetailLive, SettingsLive], {
    initial: InventoryList,
  }),
  defaultScenario: "inventory-with-products",
  scenarios: {
    "inventory-with-products": {
      layer: services(seedProducts),
      fixtures: [InventoryFixture],
    },
    "empty-inventory": {
      layer: services([]),
      fixtures: [InventoryFixture],
    },
    "sluggish-network": {
      layer: services(seedProducts, "1 second"),
      fixtures: [InventoryFixture],
      virtualTime: true,
    },
    "slow-network": {
      layer: services(seedProducts, "30 seconds"),
      fixtures: [InventoryFixture],
      virtualTime: true,
    },
  },
})
```

### examples/inventory/journeys/services.ts

```ts
import { includes, type JourneyClientFor } from "@reflex/test"
import { InventoryList, InventoryDetail, Settings } from "../src/screens.ts"
import type inventoryApp from "../src/app.ts"

/** The same typed story runs against fixtures and the live CLI transport. */
export const servicesJourney = async (
  app: JourneyClientFor<typeof inventoryApp>,
  failNextSave: () => Promise<void>,
): Promise<void> => {
  const list = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 5 }),
  })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await app.focused(InventoryDetail, {
    _tag: "editing",
    title: "Blue T-Shirt",
    quantity: 5,
  })
  await detail.actions.SetQuantity({ quantity: 12 })
  await detail.actions.Save()
  await app.back()
  const updated = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await updated.actions.OpenProduct({ productId: "product-123" })
  const reopened = await app.focused(InventoryDetail, {
    _tag: "editing",
    quantity: 12,
    error: null,
  })
  await reopened.actions.SetQuantity({ quantity: 19 })
  await failNextSave()
  await reopened.expectFailure.Save()
  await app.focused(InventoryDetail, { _tag: "editing", quantity: 19, error: "Server error" })
  await app.back()
  const saved = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await saved.actions.OpenSettings()
  const settings = await app.focused(Settings, { _tag: "ready" })
  await settings.actions.SetLowStockThreshold({ threshold: 3 })
  await app.back()
  const refreshed = await app.focused(InventoryList, { lowStockThreshold: 3 })
  await refreshed.actions.OpenSettings()
  await app.focused(Settings, { lowStockThreshold: 3 })
}
```

### examples/inventory/test/journey.test.ts

```ts
import { expect, test } from "bun:test"
import { connectJourney, createTestApp, includes } from "@reflex/test"
import app from "../src/app.ts"
import { InventoryList, InventoryDetail } from "../src/screens.ts"
import { InventoryFixture } from "../src/fixtures.ts"
import { servicesJourney } from "../journeys/services.ts"

test("one story through headless services", async () => {
  await using session = await createTestApp(app, { scenario: "inventory-with-products" })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave()
  })
})

test("slow save times out without losing edits", async () => {
  await using session = await createTestApp(app, { scenario: "slow-network" })
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity({ quantity: 12 })
  const saving = await detail.start.Save()
  await session.focused(InventoryDetail, { _tag: "saving" })
  await session.advanceTime(5_000)
  expect(await saving.expectFailure()).toMatchObject({ status: "domain-error" })
  await session.focused(InventoryDetail, { _tag: "editing", quantity: 12, error: "Save timed out" })
  await session.back()
  await session.focused(InventoryList, { products: includes({ id: "product-123", quantity: 5 }) })
})

test.skipIf(process.env.REFLEX_LIVE !== "1")("the same story through the device", async () => {
  await using session = await connectJourney(app, {
    target: "device",
    scenario: "inventory-with-products",
  })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave()
  })
})
```

### apps/mobile/src/app.ts

```ts
import { Layer } from "effect"
import AsyncStorage from "@react-native-async-storage/async-storage"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import inventory from "@reflex/example-inventory"
import { SettingsStore } from "@reflex/example-inventory/domain.ts"
import { httpInventoryApi } from "@reflex/example-inventory/http-api.ts"

const SavedSettings = Schema.Struct({ lowStockThreshold: Schema.Int })
const storage = Layer.succeed(
  SettingsStore,
  SettingsStore.of({
    load: Effect.promise(() => AsyncStorage.getItem("inventory-settings")).pipe(
      Effect.flatMap((raw) =>
        raw === null
          ? Effect.succeed({ lowStockThreshold: 10 })
          : Schema.decodeUnknownEffect(Schema.fromJsonString(SavedSettings))(raw),
      ),
      Effect.catch(() => Effect.succeed({ lowStockThreshold: 10 })),
      Effect.map((value) => ({ ...value, apiToken: Redacted.make("app-token") })),
    ),
    setLowStockThreshold: (lowStockThreshold) =>
      Effect.promise(() =>
        AsyncStorage.setItem("inventory-settings", JSON.stringify({ lowStockThreshold })),
      ),
  }),
)
const baseUrl = process.env.EXPO_PUBLIC_INVENTORY_API
export default baseUrl === undefined
  ? inventory
  : inventory.withScenarios(
      {
        "live-services": { layer: Layer.merge(httpInventoryApi(baseUrl), storage), fixtures: [] },
      },
      { defaultScenario: "live-services" },
    )
```

The conditional export intentionally has a union type. The mobile binding never promises
fixture presence; the live-services scenario has none. A real-service test can reuse
`servicesJourney` by supplying an application-owned HTTP fail-next-save function; fixture
journeys above need no HTTP transport adapter. `connectJourney` itself owns CLI target
discovery, auth, protocol negotiation, subscription and outcome decoding.

### apps/mobile/src/routes.ts

```ts
import { createReflexExpo } from "@reflex/expo"
import app from "./app.ts"

export const reflex = createReflexExpo(app, {
  InventoryList: "/",
  InventoryDetail: "/inventory/[productId]",
  Settings: "/settings",
})
```

### apps/mobile/provider.tsx

```tsx
import type { ReactNode } from "react"
import { developmentBridge } from "@reflex/expo/dev"
import app from "./src/app.ts"
import { reflex } from "./src/routes.ts"

const bridge = developmentBridge()
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <reflex.Provider app={app} bridge={bridge}>
      {children}
    </reflex.Provider>
  )
}
```

### apps/mobile/app/_layout.tsx

```tsx
import { Suspense } from "react"
import { Stack } from "expo-router"
import { AppProvider } from "@inventory-provider"

export default function Layout() {
  return (
    <AppProvider>
      <Suspense fallback={null}>
        <Stack />
      </Suspense>
    </AppProvider>
  )
}
```

### apps/mobile/app/index.tsx

```tsx
import { InventoryList } from "@reflex/example-inventory/screens.ts"
import { isLowStock } from "@reflex/example-inventory/domain.ts"
import { reflex } from "../src/routes.ts"
import { Pressable, Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function InventoryListView() {
  const node = reflex.useScreen(InventoryList)
  const { status, state, actions } = node
  if (status === "pending") {
    return null
  }

  if (state._tag === "loading") {
    return (
      <Screen>
        <Text style={styles.title}>Inventory</Text>
        <Text>Loading…</Text>
        <Action {...actions.OpenSettings} title="Settings" />
      </Screen>
    )
  }
  if (state._tag === "failed") {
    return (
      <Screen>
        <Text style={styles.title}>Inventory</Text>
        <Text style={styles.error}>{state.error}</Text>
        <Action {...actions.OpenSettings} title="Settings" />
      </Screen>
    )
  }
  return (
    <Screen>
      <Text style={styles.title}>Inventory</Text>
      {state.products.map((product) => (
        <Pressable
          accessibilityRole="button"
          key={product.id}
          onPress={() => actions.OpenProduct.run({ productId: product.id })}
          style={styles.row}
        >
          <Text>{product.title}</Text>
          <Text>
            {product.quantity}
            {isLowStock(product, state.lowStockThreshold) ? " (low)" : ""}
          </Text>
        </Pressable>
      ))}
      <Action {...actions.OpenSettings} title="Settings" />
    </Screen>
  )
}
```

### apps/mobile/app/inventory/[productId].tsx

```tsx
import { InventoryDetail } from "@reflex/example-inventory/screens.ts"
import { reflex } from "../../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../../src/ui.tsx"

export default function InventoryDetailView() {
  const node = reflex.useScreen(InventoryDetail)
  const { status, state, actions } = node
  if (status === "pending") {
    return null
  }
  if (state._tag === "loading") {
    return <Screen>{null}</Screen>
  }
  if (state._tag === "missing") {
    return (
      <Screen>
        <Text>SKU: {state.productId}</Text>
        <Text style={styles.error}>{state.error}</Text>
      </Screen>
    )
  }

  const saving = state._tag === "saving"
  return (
    <Screen>
      <Text style={styles.title}>{state.title}</Text>
      <Text>SKU: {state.productId}</Text>
      <Text>Quantity: {state.quantity}</Text>
      {state._tag === "editing" && state.error !== null && (
        <Text style={styles.error}>{state.error}</Text>
      )}
      <Action {...actions.Increment} title="Increment" />
      <Action {...actions.Save} title={saving ? "Saving…" : "Save"} />
    </Screen>
  )
}
```

### apps/mobile/app/settings.tsx

```tsx
import { Settings } from "@reflex/example-inventory/screens.ts"
import { reflex } from "../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function SettingsView() {
  const node = reflex.useScreenSuspense(Settings)
  const { state, actions } = node
  if (state._tag === "loading") {
    return null
  }

  const { lowStockThreshold } = state
  return (
    <Screen>
      <Text style={styles.title}>Settings</Text>
      <Text>Low stock below: {lowStockThreshold}</Text>
      <Action {...actions.RaiseLowStockThreshold} title="Raise threshold" />
    </Screen>
  )
}
```

### apps/mobile/src/ui.tsx

```tsx
import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

export const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: "600" },
  row: { padding: 12, flexDirection: "row", justifyContent: "space-between" },
  error: { color: "#a00" },
})
export function Screen({ children }: { children: ReactNode }) {
  return <View style={{ padding: 20, gap: 12 }}>{children}</View>
}
export function Action({
  title,
  available,
  pending,
  reason,
  run,
}: {
  title: string
  available: boolean
  pending: boolean
  reason: string | null
  run: () => Promise<unknown>
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={reason ?? undefined}
      disabled={!available || pending}
      onPress={() => {
        void run()
      }}
    >
      <Text>{title}</Text>
    </Pressable>
  )
}
```

### apps/mobile/e2e/provider.tsx

```tsx
import type { ReactNode } from "react"
import * as Layer from "effect/Layer"
import { developmentBridge } from "@reflex/expo/dev"
import {
  fixtureApi,
  fixtureSettings,
  InventoryFixture,
  seedProducts,
} from "@reflex/example-inventory/fixtures.ts"
import app from "../src/app.ts"
import { reflex } from "../src/routes.ts"

const e2e = {
  e2e: {
    layer: Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings),
    fixtures: [InventoryFixture],
  },
}
const instrumented = app.withScenarios(e2e, { defaultScenario: "e2e" })
const bridge = developmentBridge()
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <reflex.Provider app={instrumented} bridge={bridge}>
      {children}
    </reflex.Provider>
  )
}
```

### apps/mobile/metro.config.js

```js
const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)
const original = config.resolver.resolveRequest
const provider = process.env.REFLEX_E2E === "1" ? "e2e/provider.tsx" : "provider.tsx"
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === "@inventory-provider") {
    return { type: "sourceFile", filePath: path.join(__dirname, provider) }
  }
  return original === undefined
    ? context.resolveRequest(context, name, platform)
    : original(context, name, platform)
}
module.exports = config
```

### apps/mobile/tsconfig.json

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "paths": {
      "@reflex/protocol": ["../../packages/protocol/src/index.ts"],
      "@reflex/runtime": ["../../packages/runtime/src/index.ts"],
      "@reflex/rpc/connection": ["../../packages/rpc/src/server.ts"],
      "@reflex/effect": ["../../packages/effect/src/index.ts"],
      "@reflex/expo": ["../../packages/expo/src/index.ts"],
      "@reflex/example-plain": ["../../examples/plain/src/app.ts"],
      "@reflex/example-inventory": ["../../examples/inventory/src/app.ts"],
      "@reflex/example-inventory/*": ["../../examples/inventory/src/*"],
      "effect": ["./node_modules/effect"],
      "effect/*": ["./node_modules/effect/dist/*"],
      "react": ["./node_modules/@types/react/index.d.ts"],
      "expo-router": ["./node_modules/expo-router"],
      "react/jsx-runtime": ["./node_modules/@types/react/jsx-runtime.d.ts"],
      "@reflex/live": ["../../packages/live/src/index.ts"],
      "@reflex/react": ["../../packages/react/src/index.ts"],
      "@reflex/navigation": ["../../packages/navigation/src/index.ts"],
      "@reflex/react/advanced": ["../../packages/react/src/advanced.ts"],
      "@reflex/effect/advanced": ["../../packages/effect/src/advanced.ts"],
      "@inventory-provider": ["./provider.tsx"],
      "@reflex/runtime/advanced": ["../../packages/runtime/src/advanced.ts"],
      "@reflex/live/advanced": ["../../packages/live/src/advanced.ts"],
      "@reflex/expo/advanced": ["../../packages/expo/src/advanced.ts"],
      "@reflex/expo/dev": ["../../packages/expo/src/dev.ts"]
    },
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true
  },
  "include": ["app", "src", "e2e/*.ts", "hermes-smoke/*.ts", "plain", "../../packages/react/src"]
}
```

Metro selects the E2E provider only with `REFLEX_E2E=1`; production build jobs forbid
that setting. The alias's TypeScript shape is the production provider's public shape.
The filename changes from `[id].tsx` to `[productId].tsx`. provider.tsx is the dev entry:
its bridge helper is imported from the Effect-free dev subpath. Production provider.tsx
contains no test import or dynamic provider selector.

### apps/web/src/app.ts

```ts
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
```

### apps/web/src/routes.ts

```ts
import { createReflexRouter } from "@reflex/react-router"
import app from "./app.ts"

export const reflex = createReflexRouter(app, { List: "/", Detail: "/detail/:id" })
```

### apps/web/src/views.tsx

```tsx
import { List, Detail } from "./app.ts"
import { reflex } from "./routes.ts"

export function ListView() {
  const view = reflex.useScreen(List)
  if (view.status === "pending") return <p>Loading…</p>
  return (
    <main>
      <h1>List</h1>
      <p>Count: {view.state.count}</p>
      <button
        type="button"
        disabled={!view.actions.Increment.available}
        onClick={() => {
          void view.actions.Increment.run()
        }}
      >
        Add one
      </button>
      <reflex.Link to="Detail" params={{ id: "one" }}>
        Open detail
      </reflex.Link>
    </main>
  )
}
export function DetailView() {
  const { state, actions } = reflex.useScreenSuspense(Detail)
  return (
    <main>
      <h1>Detail {state.id}</h1>
      <p>Count: {state.count}</p>
      <button
        type="button"
        disabled={!actions.Increment.available}
        onClick={() => {
          void actions.Increment.run()
        }}
      >
        Add one
      </button>
      <reflex.Link to="List">List</reflex.Link>
    </main>
  )
}
```

### apps/web/src/main.tsx

```tsx
import { Suspense } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import { developmentBridge } from "@reflex/live/dev"
import app from "./app.ts"
import { reflex } from "./routes.ts"
import { ListView, DetailView } from "./views.tsx"

const router = createBrowserRouter(reflex.routes({ List: ListView, Detail: DetailView }))
const bridge = developmentBridge()
const root = document.getElementById("root")
if (root === null) throw new Error("Missing root element")
createRoot(root).render(
  <reflex.Provider app={app} bridge={bridge}>
    <Suspense fallback={<p>Loading…</p>}>
      <RouterProvider router={router} />
    </Suspense>
  </reflex.Provider>,
)
```

### examples/plain/src/app.ts

```ts
import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

// The existing Zustand store remains usable without Reflex.
export const createCounterStore = () => createStore(() => ({ count: 0, token: "private-token" }))
export const Counter = defineStoreNode({
  name: "Counter",
  store: createCounterStore,
  project: ({ count }) => ({ count }),
  actions: (action) => ({
    Add: action({
      input: z.strictObject({ by: z.int() }),
      handler: ({ by }, { store }) => store.setState((s) => ({ count: s.count + by })),
    }),
    Reset: action({
      available: ({ count }) => (count === 0 ? "Already zero" : true),
      handler: (_, { store }) => store.setState({ count: 0 }),
    }),
  }),
})
export default defineStoreApp({ name: "plain-counter", screens: [Counter] })
```

### apps/mobile/plain/index.tsx

```tsx
import "expo-router/entry"
```

The existing plain package keeps `main: "index.tsx"`; this entry now delegates to Expo
Router so the following file routes supply its Effect-free screen and layout.

### apps/mobile/plain/routes.ts

```ts
import { createReflexExpo } from "@reflex/expo"
import app from "@reflex/example-plain"
export const reflex = createReflexExpo(app, { Counter: "/" })
```

### apps/mobile/plain/app/_layout.tsx

```tsx
import { Stack } from "expo-router"
import { developmentBridge } from "@reflex/expo/dev"
import app from "@reflex/example-plain"
import { reflex } from "../routes.ts"

const bridge = developmentBridge()
export default function Layout() {
  return (
    <reflex.Provider app={app} bridge={bridge}>
      <Stack />
    </reflex.Provider>
  )
}
```

### apps/mobile/plain/app/index.tsx

```tsx
import { Pressable, Text, View } from "react-native"
import { Counter } from "@reflex/example-plain"
import { reflex } from "../routes.ts"

export default function CounterView() {
  const view = reflex.useScreen(Counter)
  if (view.status === "pending") return null
  return (
    <View>
      <Text>Count: {view.state.count}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void view.actions.Add.run({ by: 1 })
        }}
      >
        <Text>Add one</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={!view.actions.Reset.available}
        onPress={() => {
          void view.actions.Reset.run()
        }}
      >
        <Text>Reset</Text>
      </Pressable>
    </View>
  )
}
```

### examples/live-counter/src/app.ts

```ts
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"

export const Counter = defineStoreNode({
  name: "Counter",
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
        for (const listener of listeners) listener()
      },
    }
  },
  actions: (action) => ({ Increment: action({ handler: (_, { store }) => store.increment() }) }),
})
export default defineStoreApp({ name: "live-counter", services: [Counter] })
```

### examples/live-counter/src/serve.ts

```ts
import { serveLive } from "@reflex/live"
import app from "./app.ts"

const setting = process.env.REFLEX_BRIDGE
if (!setting) {
  throw new Error("Set REFLEX_BRIDGE to the appSetting printed by reflex --target device start")
}
const server = await serveLive(app, { setting })
const shutdown = () => {
  void server.close().catch(console.error)
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
```

## 3. Public declarations and package boundaries

The exports below are exhaustive for the seven changed userland packages. Type parameters
named `C`, `D`, `A`, `S`, `P`, `W`, `E`, `R` mean contract, definition, checked action map,
decoded state, decoded params, wire state, declared decoded error and Effect requirements.
`AnyContract`, `AnyDefinition`, `AnyApp`, `AnyImplementation` are existential implementation
constraints, not exported types that consumers instantiate. The declarations abbreviate
schema extraction and the mapped validations using the named rules immediately below;
no user writes those generic arguments. Omitted properties are not public compatibility
aliases. Protocol, RPC, CLI and navigation keep their existing protocol/integration APIs;
this design adds no exports to them. Their explicit existing exports are outside the
userland redesign. Ownership seams move from `/internal` to each package's advanced
entry; private cross-package imports must stay within the existing dependency DAG.

### Shared rules used by declarations

- `MapByName<T>` maps the literal `name` of every tuple item to that item. `Unique<T>`
  rejects repeated names and repeated contract objects. Literal tuples get a diagnostic
  marker; widened arrays get the same runtime validation. No last-wins merge exists.
- `Selected<A,C>` indexes `A.screens[C.name]` then checks its **nominal contract**, not
  only its name. It extracts only that implementation's actions. Actions are not carried
  in the navigation contract graph. `InferActions<A,C>` and `InferState<A,C>` are the
  only public selection helpers; definitions can also be used alone as `InferState<D>`.
- `Wire<T>` defaults only when Schema's encoded type is statically JSON, with built-in
  redaction transformation. Unknown/custom encoding hooks require `jsonCodec`; this
  replaces the current recursive best-effort PublicState derivation. Arrays/tuples keep
  their shape. UI and journey receive `DeepReadonly<W>`, handlers receive decoded S.
- `Checked<X,Message>` (X is the boolean check result) evaluates to unknown on success and a required object property
  `{ readonly [Message]: never }` on failure. Intersect it with the erroneous argument,
  using `NoInfer` in the check so it cannot widen the inferred operand to pass. It never
  makes the entire parameter `never`. Ordinary TS scalar/arity errors stay ordinary TS
  errors; the library cannot replace the compiler's English text. The misuse table
  specifies the stable marker text for relationships and runtime sentences for dynamics.
- `ScreenMember<A,C>` checks nominal membership; `ServiceMember<A,D>` checks service
  membership. `ScenarioFixtures<A,K>` is the **intersection** of fixture memberships
  for every K, not their union. For a literal K, just that scenario's tuple is indexed.
  Scenario fixtures are automatically mounted from the tuple before scenario layer build.
- `Needs<A>` is the union of selected implementation requirements. Every scenario must
  supply `Exclude<Needs<A>, Navigator<Key> | Scope | fixture services of that scenario>`.
  Extra unrelated services are allowed. A missing service is a labeled property named
  `Scenario 'x' must provide InventoryApi`; a missing navigation provider prints the
  shallow requirement `Navigator<"key">`, not the implementation graph. For unnamed
  third-party Effect services whose name is not retained statically, use the ordinary
  Effect identifier type; a runtime build failure names its actual key.
- `ValidateRoutes` applies the grammar and rules in decision 11, on encoded params.
  Every screen is covered exactly once. Literal keys outside the app are rejected;
  dynamic keys/paths belong in advanced `routeCodec`, which does the same runtime checks.
- `Member` checks occur at hooks, journeys, mounting and app composition, not through
  global declaration merging. Multi-app tests can coexist in one TS program.

### Normalized public values

These are the public read-only shapes used by the declarations below. Runtime internals
keep mutable registries and ownership maps out of these objects. `App` carries a private
library brand for compatible-app typing; actual identity is validated by a WeakMap entry,
so spreading an app object does not clone its identity.

```ts
interface App<Screens, Services, Scenarios> {
  readonly name: string
  readonly screens: Screens
  readonly services: Services
  readonly scenarioNames: readonly (keyof Scenarios & string)[]
  readonly defaultScenario: keyof Scenarios & string
}
interface ScreenContract<Name, StateCodec, ParamsCodec, Self> {
  new (): { readonly self: (value: Self) => Self }
  readonly name: Name
  readonly state: StateCodec
  readonly params: ParamsCodec
}
interface ScreenImplementation<C, A, R> {
  readonly contract: C
  readonly actions: A
  readonly onFocus:
    | ((ctx: EffectContext<DecodedState<C>>) => Effect.Effect<void, never, R>)
    | undefined
}
interface StoreDefinition<N, P, W, A, T> {
  readonly name: N
  readonly params: StandardValidator<P> | undefined
  readonly actions: A
  readonly createStore: (params: P) => T
  readonly project: (state: ReturnType<T["getState"]>) => W
}
interface NodeHandle<D> {
  readonly id: NodeId
  readonly name: string
  readonly actions: InferActions<D>
  getSnapshot(): DeepReadonly<InferState<D>>
  subscribe(listener: () => void): () => void
}
```

Implementation/definition type constructors above are constrained by their corresponding
schema/store interfaces in the actual declarations. Consumers use the exported Infer
helpers; the R parameter stops at the Effect composition boundary. The App's Screens table
is flattened to `{ contract, wireState, wireParams, consumerActions }` per entry before
host inference, with no retained Layer or Effect requirement types. DefinedApp retains
its construction requirements only for withScenarios. These are distinct type parameters,
so passing it to a host does not force traversal of the construction graph.

### @reflex/runtime

Root value exports: **defineStoreNode, defineStoreApp, standardInput**.
Root type exports: **Store, StandardValidator, StoreInput, StoreDefinition, StoreApp,
StoreScenario, StoreActionBuilder, StoreContext, App, SessionControls, ActionOutcome,
NodeHandle, InferState, InferActions, InferInput, InferError, ScenarioName, DeepReadonly**.
`App` is the host-neutral descriptor; Effect does not become a runtime dependency.

```ts
interface Store<S> {
  getState(): S
  subscribe(listener: () => void): () => void
}
interface StandardValidator<Out, In = Out> {
  readonly "~standard": StandardSchemaV1<In, Out>["~standard"]
}
interface StoreInput<Out, In> {
  readonly validator: StandardValidator<Out, In>
  readonly jsonSchema: JsonSchema
}
function standardInput<O, I>(
  schema: StandardValidator<O, I>,
  jsonSchema: JsonSchema,
): StoreInput<O, I>

function defineStoreNode<const N extends string, P, T extends Store<S>, S, W, A>(
  spec: {
    name: N
    params?: StandardValidator<P> | StoreInput<P, Json>
    store: (params: P) => T
    project?: (state: S) => W
    actions: (action: StoreActionBuilder<S, T>) => A
  } & ValidStoreState<S, W>,
): StoreDefinition<N, P, W, A, T>
// Without params: store is () => T, P is empty; without project: W=S and S must be JSON.
// Availability uses raw S consistently, even with a projected W.

interface StoreContext<T, E = never> {
  readonly store: T
  readonly signal: AbortSignal
  // `fail` exists only when error: was declared; never exposed as a never parameter.
  fail(error: E): never
}
interface StoreActionBuilder<S, T> {
  <I = undefined, E = never, EW = E>(
    spec: {
      description?: string
      input?: StandardValidator<I> | StoreInput<I, Json>
      error?: StandardValidator<E>
      projectError?: (error: E) => EW
      available?: (state: S) => true | string
      handler: (
        input: NoInfer<I>,
        ctx: StoreContext<T, E>,
      ) => void | NavigationCommand | Promise<void | NavigationCommand>
      onRefused?: (error: NavigationRefused, ctx: StoreContext<T, never>) => void | Promise<void>
    } & ValidStoreError<E, EW>,
  ): CheckedStoreAction<I, E, EW>
}
// Overloads remove fail when E=never; I is schema output, consumer input is schema input.
// Store action maps accept only branded results of this builder; arbitrary raw handlers fail.

function defineStoreApp<
  const N extends string,
  D extends readonly StoreDefinition[],
  V extends readonly StoreDefinition[],
  Sc,
>(
  spec: {
    name: N
    screens?: D & Unique<D>
    services?: V & Unique<V>
    scenarios?: Sc
    defaultScenario?: keyof Sc
  } & ValidStoreScenarios<Sc, D, V>,
): StoreApp<N, MapByName<D>, MapByName<V>, Sc>
interface StoreScenario {
  description?: string
  // Overrides keyed by declared definition name; parameterized screens keep (params) => Store.
  stores?: Record<string, (params: Json) => Store<Json>>
}
// Actual mapped stores member uses each selected definition's P and T; Record above is
// the existential shape only. An override cannot change T, W, actions, params or identity.
// Sc omitted creates { default: {} }; one key chooses itself; 2+ keys require defaultScenario.
```

`ActionOutcome<E>` is exactly the existing semantic union: completed, domain-error with
encoded/redacted E, refused with public reason, cancelled, defect. No error data omitted
on the wire is ever asserted as E. Consumer action functions return Promise<ActionOutcome>.
StoreFailure is private; only the current invocation's validated fail helper can create
a domain-error. Thrown Error values are defects. A duplicate definition in screens and
services is an error; screens are route-mounted, services are session-mounted exactly once.
A store-only app with one param-free screen starts it headless; several screens require
`initial` in the scenario (contract value plus params) for headless tests, or the first
router location for UI. A parameterized initial screen always needs params. No guessed
first member is used for multiple screens. This is a `StoreScenario.initial` optional
member, typed as the union of `{ screen: D, params: Params<D> }` or a param-free D.

Advanced value exports: **createRuntime, createSessionController, restrictController,
mountOwned, createAppAdapter, createRouteRegistry**.
Advanced type exports: **Runtime, Controller, ControllerMethod, ControllerSubscription,
AppSession, AppAdapter, NodeAdapter, OwnedNode, RouteRegistry, RouteLease,
SessionStartOptions, BackgroundReporter, Timers, NavigationCommand, NavigationRefused**.
These are existing low-level contracts narrowed to owned lifetimes; no wildcard exports.

```ts
function mountOwned<D>(runtime: Runtime, definition: D, ...params: ParamsArgs<D>): OwnedNode<D>
// ParamsArgs<D> is [] for no params, [params: Params<D>] otherwise.
interface OwnedNode<D> extends NodeHandle<D> {
  dispose(): Promise<void>
}
function createAppAdapter<C>(spec: AppAdapter<C>): App<C>
interface AppAdapter<C> {
  name: string
  start(scenario: string, options: SessionStartOptions): Promise<AppSession<C>>
  // Descriptor tables and scenario metadata use the same membership rules as built-ins.
  screens: C
  services: Readonly<Record<string, AnyDefinition>>
  scenarios: readonly ScenarioDescriptor[]
}
function createRouteRegistry(factories: ReadonlyMap<object, RouteFactory>): RouteRegistry
interface RouteRegistry {
  acquire(contract: object, entryKey: string, params: Json): RouteLease
  discard(entryKey: string): Promise<void>
  dispose(): Promise<void>
}
interface RouteLease {
  readonly ready: Promise<NodeHandle>
  retain(): () => void
}
```

The existing runtime/controller methods keep their current wire signatures; they are
integration APIs, not independently redefined typed dispatch paths. No raw access is on
SessionControls. `createRuntime`, controller creation and restriction retain their current
option interfaces and access-policy types. `createRouteRegistry` is the only route owner.
Advanced callers must use its leases rather than keep independent mount caches.

### @reflex/effect

Root values: **Screen, defineService, defineFixture, defineNavigation, defineApp**.
Root types: **ScreenContract, ScreenImplementation, ServiceDefinition, FixtureDefinition,
DefinedApp, Scenario, Navigator, InferState, InferActions, InferInput, InferError**.
The inference helpers re-export the same runtime helpers, with no parallel definitions.

```ts
function Screen<Self>(): <
  const N extends string,
  C extends Schema.Codec,
  const Fields extends Schema.Struct.Fields = Record<never, never>,
>(
  name: N,
  spec: {
    state: C
    params?: Fields
    initial: (params: Schema.Struct<Fields>["Type"]) => NoInfer<C["Type"]>
  },
) => ScreenBase<Self, N, C, Fields>
interface ScreenBase<Self, N, C, Fields> {
  new (): { readonly self: (value: Self) => Self }
  readonly name: N
  readonly state: C
  readonly params: Schema.Struct<Fields>
  implement<This extends ScreenContract, A, R>(
    this: This,
    spec: {
      actions: (action: EffectActionBuilder<State<This>>) => A
      onFocus?: (ctx: EffectContext<State<This>>) => Effect.Effect<void, never, R>
    },
  ): ScreenImplementation<This, A, Requirements<A> | R>
  handler<A, E, R>(f: (ctx: EffectContext<Decoded<C>>) => Effect.Effect<A, E, R>): typeof f
  when<K extends Tags<Decoded<C>>>(
    tag: K,
  ): {
    handler<A, E, R>(
      f: (ctx: EffectContext<Narrow<Decoded<C>, K>, Decoded<C>>) => Effect.Effect<A, E, R>,
    ): typeof f
  }
}
interface EffectContext<S, All = S> {
  readonly state: StateAccess<S, All>
}
interface StateAccess<S, All = S> {
  readonly get: Effect.Effect<S>
  set(value: All): Effect.Effect<void>
  update(f: (state: S) => All): Effect.Effect<void>
  when<K extends Tags<All>>(tag: K): StateAccess<Narrow<All, K>, All>
}
interface EffectActionBuilder<S> {
  <I = undefined, E = never, R = never, K extends string = never, Recovery = void>(spec: {
    description?: string
    input?: Schema.Codec<I>
    error?: Schema.Codec<E>
    available?: (state: S) => true | string
    handler: (
      input: NoInfer<I>,
      ctx: EffectContext<S>,
    ) => Effect.Effect<void | NavigationCommand<K>, NoInfer<E>, R>
    onRefused?: ((
      error: NavigationRefused,
      ctx: EffectContext<S>,
    ) => Effect.Effect<Recovery, never, R>) &
      Checked<
        [Recovery] extends [void] ? true : false,
        "Navigation refusal recovery must return void"
      >
  }): CheckedEffectAction<I, E, R | ([K] extends [never] ? never : Navigator<K>)>
  when<K extends Tags<S>>(tag: K, reason?: string): GuardedEffectActionBuilder<Narrow<S, K>, S>
}
// Guarded builder has the same call signature but narrows ctx.state/get and availability.
// Its .reduce({ input?, description?, available?, reducer(input, state): All }) is synchronous.
// set/update after suspension recheck the phase before commit. A changed phase refuses
// the operation with StateChanged; it never silently overwrites a newer unrelated phase.

function defineService<const N, C, A, R>(spec: {
  name: N
  state: C
  initial: () => Decoded<C>
  actions: (action: EffectActionBuilder<Decoded<C>>) => A
}): ServiceDefinition<N, C, A, R>
function defineFixture<const N, C, A>(spec: {
  name: N
  state: C
  initial: () => Decoded<C>
  actions: (action: EffectActionBuilder<Decoded<C>>) => A
}): FixtureDefinition<N, C, A>
// FixtureDefinition is yieldable as Effect<StateAccess<Decoded<C>>, never, FixtureService<N>>.
// defineService is for ambient Effect nodes, not domain Context.Service dependencies.

function defineNavigation<const C extends readonly ScreenContract[]>(
  contracts: C & Unique<C>,
  options?: { key?: string },
): Navigation<C>
interface Navigation<C> {
  push<T extends C[number]>(to: T, ...params: ParamsArgs<T>): NavigationCommand<KeyOf<this>>
  readonly back: NavigationCommand<KeyOf<this>>
  implement<const I extends readonly ScreenImplementation[]>(
    implementations: I & ExactlyOnePerContract<C, I>,
    options: { initial: InitialRoute<C> },
  ): NavigationSelection<C, I>
}
// InitialRoute is a param-free contract OR { screen: Contract, params: Params<Contract> }.
// Explicit key uses a const generic overload, preserving Navigator<"inventory"> literally.

function defineApp<const N, Selection, Sc>(
  spec: {
    name: N
    navigation?: Selection
    screens?: readonly ScreenImplementation[]
    services?: readonly ServiceDefinition[]
    layer?: Layer.Layer
    scenarios?: Sc
    defaultScenario?: keyof Sc
  } & ValidAppComposition<Selection, Sc>,
): DefinedApp<N, Selection, Sc>
interface Scenario<Provided, RequiredFixtures> {
  layer: Layer.Layer<Provided, never, RequiredFixtures>
  fixtures?: readonly FixtureDefinition[]
  virtualTime?: boolean
  description?: string
}
// navigation XOR screens; services are additive; no root Layer/node-map alternative.
// layer is common service provisioning. A scenario's layer is composed with it.
// No scenarios => one implicit "default", optional layer defaults Layer.empty.
// One explicit scenario => default inferred. Two or more => defaultScenario required.
// All inference occurs before checking service coverage for EACH scenario.
interface DefinedApp<N, Selection, Sc> extends App<Selection, Sc> {
  withScenarios<const Extra>(
    extra: Extra & ValidNewScenarios<Extra>,
    options?: { defaultScenario?: keyof Sc | keyof Extra },
  ): DefinedApp<N, Selection, Sc & Extra>
}
```

`withScenarios` adds fresh names only, never replaces existing names or selected
implementations. This avoids incompatible intersection types for overwritten scenarios.
StoreApp has the identical method with store scenarios. Common layers cannot depend on
scenario fixtures; otherwise every scenario would have to list them. A scenario may use
a fixture in its layer only if its own list includes it. Fixture state is initialized
exactly once; yielding access does not mount another node. The app brand/runtime reference
is retained by withScenarios. There is no public app constructor that can copy that brand.

Advanced values: **mountOwned, jsonCodec**.
Advanced types: **StateAccess, EffectContext, EffectActionBuilder, GuardedEffectActionBuilder,
NavigationCommand, NavigationRefused, Registry, WireCodec, OwnedEffectNode**.

```ts
function mountOwned<D>(
  definition: D,
  initial: DecodedState<D>,
): Effect.Effect<OwnedEffectNode<D>, never, Requirements<D> | Registry | Scope.Scope>
function jsonCodec<S, W extends Json>(
  codec: Schema.Codec<S>,
  wire: {
    encode(value: S): W
    decode(value: unknown): Effect.Effect<S, Schema.SchemaError>
    jsonSchema: JsonSchema
  },
): WireCodec<S, W>
```

jsonCodec must be an explicit opt-in for nonstandard schema hooks, not a promise that
an arbitrary JSON annotation changes TypeScript's encoded type. Redacted values always
pass through the redaction pass before publication, including custom encoders.

### @reflex/react

Root value: **createReflex**.
Root types: **ReflexBinding, NodeView, ReadyNodeView, ScreenView, ActionViews**.
No unbound Provider/useNode/useRuntime/useMountedNode root exports remain.

```ts
function createReflex<A extends App>(app: A): ReflexBinding<A>
interface ReflexBinding<A> {
  Provider: ComponentType<{ app: CompatibleApp<A>; bridge?: Bridge; children: ReactNode }>
  useScreen<C>(contract: C & ScreenMember<A, C>): ScreenView<Selected<A, C>>
  useScreenSuspense<C>(contract: C & ScreenMember<A, C>): ReadyNodeView<Selected<A, C>>
  useNode<D>(definition: D & ServiceMember<A, D>): NodeView<D>
  useSession(): SessionControls<A>
}
type NodeView<D> = { readonly status: "pending" } | ReadyNodeView<D>
interface ReadyNodeView<D> {
  readonly status: "ready"
  readonly state: DeepReadonly<InferState<D>>
  readonly actions: ActionViews<InferActions<D>>
}
// Each ActionView has run(...encodedArgs): Promise<ActionOutcome<EncodedError>>,
// available: boolean, reason: string|null, pending: boolean. No send or dispose.
interface SessionControls<A> {
  readonly scenario: string
  readonly status: "starting" | "live" | "failed" | "closed"
  reset<K extends ScenarioName<A>>(scenario: K): Promise<void>
  forScenario<B extends CompatibleApp<A>, K extends ScenarioName<B>>(
    app: B,
    scenario: K,
  ): ScenarioControls<B, K> | undefined
}
// ScenarioControls adds use-free node lookup for fixtures of K, and is invalid after reset.
// Its node(D) returns Promise<NodeHandle<SelectedOrFixture<B,K,D>>>; hooks are never conditional.
```

A plain React binding requires a route entry context from a router adapter for useScreen;
without it the runtime sentence explains the missing route context. useNode handles
ambient services only. Applications rendering a single store screen can use createReflex
with the headless initial entry. Hooks never invent a second route. SessionControls
contains no raw runtime or `node` admitting scenario-optional fixtures. UI event handlers
may ignore outcome promises because defects/domain failures also reach the background
reporter, and the state/actions view updates. Journeys always fail fast.

Advanced values: **createRouteAdapter, useRuntimeSession, useNodeView**.
Advanced types: **RouteAdapter, RuntimeSession, StateSource, Bridge**.

```ts
function createRouteAdapter<A>(binding: ReflexBinding<A>, adapter: RouteAdapter): ComponentType
interface RouteAdapter {
  useLocation(): {
    key: string
    contract: object
    params: Json
    navigationType: "POP" | "PUSH" | "REPLACE"
  }
  project?(stack: readonly RouteEntry[]): void
}
function useRuntimeSession(): RuntimeSession
function useNodeView<D>(source: StateSource<D> | null): NodeView<D>
```

These are composition seams, not another userland mount lifecycle. createRouteAdapter
uses the same session registry and focus reporting as the built-in hosts. Raw runtime
access validates Provider presence, not a caller-supplied type witness.

### @reflex/expo

Root value: **createReflexExpo**. Root types: **ExpoBinding, ExpoRegistration**.
Advanced value: **routeCodec**. Advanced types: **ExpoRouteCodec, RouterActions**.
`/dev` value: **developmentBridge**, type: **Bridge** (type-only re-export).

```ts
function createReflexExpo<A extends App, const R>(
  app: A,
  routes: R & ValidateRoutes<A, R, "expo">,
): ExpoBinding<A, R>
interface ExpoBinding<A, R> extends ReflexBinding<A> {
  // Provider wraps children in the session and includes RouterProjection automatically.
  href<C>(to: C & ScreenMember<A, C>, ...params: ParamsArgs<C>): Href
}
function routeCodec<P>(options: {
  path: string
  decode(raw: Readonly<Record<string, string | string[] | undefined>>): P
  encode(params: P): Href
}): ExpoRouteCodec<P>
function developmentBridge(): Bridge | undefined
```

Registrations are `"/literal"` or `{ path: "/literal/[x]", params: { renamedField: "x" } }`.
`pathname` is removed; use `path` consistently in both hosts. Only renamed fields need
mapping. Advanced routeCodec is checked against that screen's encoded params and every
returned URL is revalidated before dispatch. It is also the documented catchall escape.
Root and dev have no executable Effect imports, including transitive imports. Effect
apps supply host-neutral factories through their app descriptor. No RouterProjection
export is needed: the Provider owns it. No platform-private router action import escapes
router-actions.ts.

### @reflex/react-router

Root value: **createReflexRouter**. Root types: **RouterBinding, RouterRegistration**.
Advanced value: **routeCodec**. Advanced type: **RouterRouteCodec**.

```ts
function createReflexRouter<A extends App, const R>(
  app: A,
  routes: R & ValidateRoutes<A, R, "react-router">,
): RouterBinding<A, R>
interface RouterBinding<A, R> extends ReflexBinding<A> {
  routes(views: { [K in ScreenNames<A>]: ComponentType }): RouteObject[]
  Link: <K extends ScreenNames<A>>(props: {
    to: K
    params: EncodedParamsFor<A, K>
    children?: ReactNode
    replace?: boolean
    state?: unknown
    className?: string
  }) => ReactElement
  href<K extends ScreenNames<A>>(to: K, ...params: ParamsArgsFor<A, K>): string
}
// Link has a param-free overload omitting params; remaining props are the host LinkProps
// minus to, discover/prefetch route data remains governed by React Router.
function routeCodec<P>(options: {
  path: string
  decode(raw: Readonly<Record<string, string | undefined>>, search: URLSearchParams): P
  encode(params: P): string
}): RouterRouteCodec<P>
```

The wrapper RouteObject reads the actual matched pathname/params/location.key and reports
focus in a layout effect; no useResolvedPath(".") substitute. Parent layout composition
is ordinary `{ element, children: reflex.routes(views) }`. Router errors from invalid params
render the host errorElement and fail the pending protocol navigation as refused; the
previous core entry is kept until commit. Provider supports rendering outside RouterProvider:
projection is in the returned route wrappers, where router context actually exists.
No new independent navigation context is introduced. Router registration is shared by
routes, href, Link and location decoding; JSX never repeats path strings.

### @reflex/live

Root values: **connectBridge, serveLive**.
Root types: **Bridge, BridgeOptions, BridgeStatus, LiveServer**.
Advanced values: **createLiveSessions, createLiveController, createSessionOwner, nodeSource**.
Advanced types: **LiveSessions, LiveController, SessionOwner, StateSource, BridgeSocket**.
`/dev` value: **developmentBridge**. `/session` and `/vite` are removed (migration to
advanced and dev respectively). React imports only advanced modules that exclude bridge
code through explicit named modules/exports; bundle tests must prove this edge stays cold.

```ts
function connectBridge(setting: string, options?: BridgeOptions): Bridge
function serveLive<A extends App>(
  app: A,
  options: {
    setting: string
    scenario?: ScenarioName<A>
    onBackgroundError?: BackgroundReporter
  },
): Promise<LiveServer<A>>
interface LiveServer<A> {
  readonly client: TypedClient<A>
  close(): Promise<void>
}
// TypedClient<A> is a scenario-generation-bound consumer using the SAME membership and
// selected-action helpers as JourneyClientFor<A>; raw RPC is advanced only.
function createLiveSessions(): LiveSessions
function createLiveController(
  sessions: LiveSessions,
  report: BackgroundReporter,
  timers?: Timers,
): Controller
function createSessionOwner(app: App, options?: SessionOwnerOptions): SessionOwner
function nodeSource(runtime: Runtime, id: NodeId): StateSource
function developmentBridge(): Bridge | undefined
```

`TypedClient` is a root **type export** too. It exposes `focused`, `node`, `reset` and
`scenario` with the same signatures below, but ordinary actions return ActionOutcome
rather than enforce journey success. Bridge remains an untyped transport lifecycle
capability; it cannot claim membership. BridgeOptions/BridgeStatus/BridgeSocket retain
their current transport-only signatures. No Effect import is introduced.

### @reflex/test

Root values: **createTestApp, createTestAppPool, connectJourney, includes, explore**.
Root types: **JourneyClientFor, JourneyClient, JourneyNode, JourneyOperation, StateMatch,
MatchedState, Includes, TestAppPool, ExploreOptions, ExploreResult**.
Advanced values: **createJourneyClient**. Advanced types: **JourneyTransport, RawJourney**.
Every export is explicit. Inference helpers come from runtime; there is no test-specific
redefinition of action signatures.

```ts
function createTestApp<A extends App, K extends ScenarioName<A> = DefaultScenario<A>>(
  app: A,
  options?: { scenario?: K; timeoutMs?: number },
): Promise<JourneyClientFor<A, K>>
function connectJourney<A extends App, K extends ScenarioName<A> = DefaultScenario<A>>(
  app: A,
  options: { target: "headless" | "device"; scenario?: K; timeoutMs?: number; directory?: string },
): Promise<JourneyClientFor<A, K>>
interface JourneyClientFor<A, K = DefaultScenario<A>> {
  readonly scenario: K
  focused<C, const M extends StateMatch<InferState<A, C>>>(
    contract: C & ScreenMember<A, C>,
    match?: M,
  ): Promise<JourneyNode<Selected<A, C>, M>>
  node<D>(definition: D & SessionMember<A, K, D>): Promise<JourneyNode<SelectedOrFixture<A, K, D>>>
  back(): Promise<Completed>
  advanceTime(ms: number): Promise<void>
  reset<S extends ScenarioName<A>>(scenario: S): Promise<JourneyClientFor<A, S>>
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
interface JourneyNode<D, M = unknown> {
  state(): Promise<MatchedState<InferState<D>, M>>
  actions: CheckedActions<D, "completed">
  expectFailure: CheckedActions<D, "domain-error">
  expectRefusal: CheckedActions<D, "refused">
  allowCancellation: CheckedActions<D, "completed" | "cancelled">
  start: { [K in ActionNames<D>]: (...input: InputArgs<D, K>) => Promise<JourneyOperation<D, K>> }
}
interface JourneyOperation<D, K> {
  completed(): Promise<Completed>
  expectFailure(): Promise<DomainError<InferError<D, K>>>
  expectRefusal(): Promise<Refused>
  cancel(): Promise<void>
}
function createTestAppPool(): TestAppPool
interface TestAppPool {
  open: typeof createTestApp
  disposeAll(): Promise<void>
}
function includes<const M>(...items: readonly M[]): Includes<M>
function explore<A>(app: A, options: ExploreOptions<A>): Promise<ExploreResult>
// ExploreOptions preserves existing budget/seed, typed per-member invariants and knownInputs.
function createJourneyClient<A, K>(
  app: A,
  scenario: K,
  transport: JourneyTransport,
): JourneyClientFor<A, K>
```

JourneyClient is the exported structural interface underlying JourneyClientFor (same
methods; no app selection is erased). Ordinary actions throw an assertion with node,
action, expected success and actual outcome on refusal/domain-error/cancellation/defect.
`expectFailure` only includes actions with declared domain errors. Narrowed state()
rechecks a requested discriminant on each read; it never promises arbitrary matched
quantities remain unchanged. start permits virtual-clock tests without deadlocking an
await before advancing time. `raw` is removed from the root client; advanced RawJourney
is obtained only by createJourneyClient with a protocol transport, for protocol tests.

`connectJourney` imports session discovery from the platform RPC layer, not CLI command
implementations. It connects to an already-running target, performs describe, checks app
name/scenario/action schema compatibility, resets to the requested scenario, and takes a
subscription before reading focus. It never starts a daemon or resets an unrequested app.
Runtime constructor identity cannot cross a transport: a canonical descriptor fingerprint
covers names, schemas and selected action names, and the client validates every response
against local wire schemas. Matching names alone is insufficient. Semantically different
handlers with identical descriptors are intentionally indistinguishable remotely; this is
not a claim to authenticate application code. close disposes the client connection only;
headless createTestApp additionally closes its owned controller/session.

### Reduction budget and deletion plan

Measured baseline for `src` in the seven packages is **8,500 lines** at 2a26d9e (including
entry modules). Implementation acceptance ceiling is **7,600 total lines**, not +3,200.
Tests are counted separately and must not hide production logic. Per-package planning
ceilings: effect 2,350; runtime 2,550; react 600; expo 400; react-router 250; live 700;
test 750 = 7,600. These are allocation ceilings, not proof of achievable implementation.
Resource ownership work must fit them; do not cut validation to meet a line count.

Delete screen-identity.ts, definition-identity.ts, action-navigation.ts and their tokens;
delete queued afterAction handling, public resolve methods, factory/schema navigation
compatibility wrappers and Nav.layer. Delete `/internal` package entries, the unbound
React root hooks/Provider, separate screen-ready.ts Suspense resources, duplicate
useMountedNode/useSuspenseRoute registries, the append-only store nodes retention array,
Expo Effect-only routes/binding plumbing, route-token symbol lookup and manual identity
options. Replace rather than retain capability-vs-screen duplicated mount façades.
Keep the protocol dispatch engine, redaction safeguards, route projection controller,
network/auth implementations, limits and controller behavior. Reuse those primitives.
Delete hand-written live journey transports and repeated JSX path registrations.
Internal low-level mount primitives may remain, but have exactly one owner implementation.

## 4. Misuse and diagnostic contract

“Compile marker” means the exact required property text, inside the compiler's normal
assignability diagnostic. TS chooses prefixes, quotes and type display; this design does
not promise control over those. Ordinary compiler diagnostics below name their stable
TS message. Runtime sentences include concrete example names. Dynamic/JS/`as` callers
always get runtime checks even when a literal caller would fail statically. Error markers
must be snapshot-tested with TS 5.9.3 during implementation; only the risky relationship
markers in the prototypes have been proved here. No entire argument becomes `never`.

| #   | Mistake and code                                                                  | Intended diagnostic                                                                                     | Why / phase                                                                                                                                    |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `reflex.useScreen(InventoryFixture)`                                              | `InventoryFixture is not a screen of app 'inventory'`                                                   | Compile marker; wrong role.                                                                                                                    |
| 2   | `reflex.useScreen(ForeignDetail)`                                                 | `InventoryDetail is not a screen of app 'inventory'`                                                    | Compile marker; nominal check even with same name.                                                                                             |
| 3   | `reflex.useNode(InventoryDetail)`                                                 | `InventoryDetail is not a service of app 'inventory'`                                                   | Compile marker; route hooks own screens.                                                                                                       |
| 4   | `reflex.useNode(InventoryFixture)`                                                | `InventoryFixture is scenario-specific; use session.forScenario(app, name)`                             | Compile marker; optional fixture is not an ambient base member.                                                                                |
| 5   | `liveServices.node(InventoryFixture)`                                             | `InventoryFixture is not a fixture of scenario 'live-services'`                                         | Compile marker; no fixture declared.                                                                                                           |
| 6   | `unionSession.node(InventoryFixture)`                                             | `InventoryFixture is not present in every selected scenario`                                            | Compile marker; union requires intersection.                                                                                                   |
| 7   | `Nav.implement([ListLive, ListLive], { initial: InventoryList })`                 | `InventoryList has more than one implementation`                                                        | Compile marker; literal tuple duplicate.                                                                                                       |
| 8   | `Nav.implement([ListLive], { initial: InventoryList })`                           | `InventoryDetail requires one implementation`                                                           | Compile marker; first missing contract in declaration order.                                                                                   |
| 9   | `Nav.implement([ForeignLive, DetailLive, SettingsLive], options)`                 | `InventoryList implementation must belong to its declared contract`                                     | Compile marker; identity, not shape.                                                                                                           |
| 10  | `defineStoreApp({ name: 'x', services: [Counter, Counter] })`                     | `Counter is declared more than once`                                                                    | Compile marker for tuples; same runtime sentence for widened arrays.                                                                           |
| 11  | `defineStoreApp({ name: 'x', screens: dynamicDefinitions })` with duplicate names | `App 'x' declares Counter more than once; keep one definition.`                                         | Runtime; widened arrays hide duplicate counts.                                                                                                 |
| 12  | `mountOwned(runtime, Detail)`                                                     | `Expected 3 arguments, but got 2.`                                                                      | TS arity; params required.                                                                                                                     |
| 13  | `Nav.push(InventoryDetail, {})`                                                   | `Property 'productId' is missing in type '{}' but required in type '{ readonly productId: string; }'.`  | Ordinary TS shape error.                                                                                                                       |
| 14  | `Nav.push(ForeignDetail, { productId: 'p' })`                                     | `InventoryDetail is not a screen of navigator 'default'`                                                | Compile marker, using nominal contract set.                                                                                                    |
| 15  | `yield* Nav.back`                                                                 | `NavigationCommand must be returned from the handler, not yielded`                                      | Cannot replace TS iterator diagnostic; stable marker is on non-iterable command's display name. Actual TS reports missing `[Symbol.iterator]`. |
| 16  | `Nav.back.pipe(Effect.catchTag(...))`                                             | `Property 'pipe' does not exist on type 'NavigationCommand<"default">'.`                                | Ordinary TS error; command is not an Effect.                                                                                                   |
| 17  | Action returns `Nav.back` but app has no navigation                               | `Navigator<"default">`                                                                                  | Compile requirement/marker on composition; handler cannot fabricate a navigator.                                                               |
| 18  | `onRefused: () => Effect.succeed(Nav.back)`                                       | `Navigation refusal recovery must return void`                                                          | Compile marker; recovery cannot schedule another terminal command.                                                                             |
| 19  | `onFocus: () => Effect.fail(new ApiError({message:'x'}))`                         | `Handle onFocus failures into state`                                                                    | Compile marker; lifecycle has no declared error channel.                                                                                       |
| 20  | `action({ handler: (x: {by:number}) => ... })` without input                      | `Declare input: before annotating handler input`                                                        | Compile marker; annotation cannot invent a codec.                                                                                              |
| 21  | `action({ handler: () => Effect.fail(new ApiError({message:'x'})) })`             | `Declare action failures with error:`                                                                   | Compile marker; error presence controls channel.                                                                                               |
| 22  | `view.actions.Add.run({ by: 'one' })`                                             | `Type 'string' is not assignable to type 'number'.`                                                     | Ordinary TS scalar error at by.                                                                                                                |
| 23  | `view.actions.Reset.run({})`                                                      | `Expected 0 arguments, but got 1.`                                                                      | Ordinary TS arity.                                                                                                                             |
| 24  | `action({ input: z.unknown(), handler })`; then `.run()`                          | `Expected 1 arguments, but got 0.`                                                                      | Presence of unknown input still requires one argument.                                                                                         |
| 25  | `ctx.fail({message:'x'})` with no error declaration                               | `Property 'fail' does not exist on type 'StoreContextWithoutError<...>'.`                               | Ordinary TS missing member; overload removes it.                                                                                               |
| 26  | `error: z.instanceof(Error)` with no projectError                                 | `Store error must be JSON; provide projectError`                                                        | Compile marker; class instance cannot publish by default.                                                                                      |
| 27  | `store: () => createStore(() => ({ now: new Date() }))` without project           | `Store state must be JSON; provide project`                                                             | Compile marker; rich object is not JSON.                                                                                                       |
| 28  | `project: () => ({ count: NaN })`                                                 | `Counter state.count must be a finite JSON number; fix the projection.`                                 | Runtime; number type cannot express finiteness.                                                                                                |
| 29  | `createReflexExpo(app, { InventoryDetail: '/inventory/[id]', ...otherRoutes })`   | `Path placeholder id has no matching param; add a params mapping`                                       | Compile marker (prototype proves generic sentence without interpolated id).                                                                    |
| 30  | `{ InventoryDetail: '/inventory' }`                                               | `Required route param productId must appear as a path placeholder`                                      | Compile marker; cannot lose a required param.                                                                                                  |
| 31  | `{ Detail: { path: '/:id', params: { productId:'id', tab:'id' } } }`              | `URL param mapping targets must be unique`                                                              | Compile marker/runtime fallback; default targets included.                                                                                     |
| 32  | `{ Detail: { path: '/:id', params: { typo:'id' } } }`                             | `URL param mapping names must be schema fields`                                                         | Compile marker.                                                                                                                                |
| 33  | `createReflexRouter(app, { List: '/' })`                                          | `Detail needs a route registration`                                                                     | Compile marker; every screen covered.                                                                                                          |
| 34  | `<reflex.Link to="Detail" />`                                                     | `Detail requires params`                                                                                | Compile marker; param-free overload cannot absorb Detail.                                                                                      |
| 35  | `reflex.routes({ List: ListView })`                                               | `Detail needs a route component`                                                                        | Compile marker.                                                                                                                                |
| 36  | `{ Detail: dynamicPath }`                                                         | `Route path must be a literal; use advanced routeCodec for dynamic paths`                               | Compile marker, runtime codec is escape hatch.                                                                                                 |
| 37  | Numeric codec encodes number in `Detail.params`                                   | `URL param id must encode a string; use a string codec`                                                 | Compile marker; URL is not decoded number.                                                                                                     |
| 38  | Deep link `/inventory/` or malformed encoded id                                   | `InventoryDetail route params.productId are invalid; correct the URL.`                                  | Runtime schema validation; raw URL is unknown.                                                                                                 |
| 39  | `<reflex.Provider app={anotherApp} />`                                            | `Provider app must share the binding's app identity`                                                    | Runtime for independently constructed structural matches; compile when types differ.                                                           |
| 40  | `defineApp({ scenarios: { a, b }, ...composition })` without default              | `Choose defaultScenario when declaring multiple scenarios`                                              | Compile marker; no order-dependent default.                                                                                                    |
| 41  | `app.withScenarios({ existingName: replacement })`                                | `Scenario existingName already exists; choose a new name`                                               | Compile marker/runtime fallback; only additive extensions.                                                                                     |
| 42  | `createTestApp(app, { scenario: 'typo' })`                                        | `typo is not a scenario of app 'inventory'`                                                             | Compile marker, runtime validation for string from environment.                                                                                |
| 43  | Scenario layer requires InventoryFixture but fixtures is empty                    | `Scenario 'live-services' must declare fixture InventoryFixture`                                        | Compile marker; list provides the service.                                                                                                     |
| 44  | Scenario layer omits InventoryApi                                                 | `Scenario 'empty-inventory' must provide InventoryApi`                                                  | Compile marker; coverage independent per scenario.                                                                                             |
| 45  | Read old client after `await session.reset('empty-inventory')`                    | `Session was reset; use the client returned by reset.`                                                  | Runtime generation check; TS cannot revoke aliases.                                                                                            |
| 46  | `detail.state()` after an explicitly matched editing tag became saving            | `InventoryDetail changed state tag; acquire a new handle with focused().`                               | Runtime revalidation of narrowing.                                                                                                             |
| 47  | `await detail.actions.Save()` returns domain error                                | `InventoryDetail.Save expected completed, received domain-error (ApiError: Server error).`              | Runtime journey assertion, not silently ignored outcome.                                                                                       |
| 48  | `connectJourney(wrongApp, {target:'device'})`                                     | `Connected app descriptor differs from inventory; connect to the matching target.`                      | Runtime; remote identity is a descriptor, never a constructor object.                                                                          |
| 49  | `useScreen` outside Provider                                                      | `Reflex hooks need their bound Provider; wrap this tree with reflex.Provider.`                          | Runtime; React tree cannot be statically proved.                                                                                               |
| 50  | Same history key, different decoded params                                        | `InventoryDetail entry key changed params; use a new history entry.`                                    | Runtime registry consistency.                                                                                                                  |
| 51  | Call `A.resolve(runtime)`                                                         | `Property 'resolve' does not exist on type 'ScreenImplementation<...>'.`                                | Ordinary TS error; resolution can only use the selected app entry.                                                                             |
| 52  | No private declaration on two empty same-name Screen subclasses                   | No compile error; runtime `App 'inventory' declares InventoryDetail more than once; keep one contract.` | TS limitation proved in prototype. Nominal guarantee requires the authored private line; lint/template check should flag its omission.         |
| 53  | Store input validator returns Promise                                             | `Counter.Add input validator must be synchronous; use synchronous validation before dispatch.`          | Runtime; Standard Schema validate signature admits promises.                                                                                   |
| 54  | Back at root                                                                      | `Navigation refused: already at the root screen.`                                                       | Runtime refused outcome with reason AtRoot; onRefused runs if supplied.                                                                        |
| 55  | Retained fixture view used after another reset                                    | `Scenario view expired; acquire it again with forScenario(app, name).`                                  | Runtime generation check.                                                                                                                      |

## 5. Feasibility, performance and acceptance evidence

### Proven boundaries

Run `bunx tsc --noEmit -p docs/design/prototypes/tsconfig.json --extendedDiagnostics`.
The project uses installed TypeScript 5.9.3 and Effect 4.1.2 with strict mode,
exactOptionalPropertyTypes and noUncheckedIndexedAccess. It imports no Reflex package.
`@ts-expect-error` cases assert rejection rather than silence arbitrary diagnostics.
These are declaration prototypes, not substitute implementations or runtime tests.

- **contracts.ts:** curried Self factory, nominal declaration, inherited static `this`
  extraction, independent A/B action maps, bound selection and readable membership
  intersection. Same-name empty subclasses are intentionally shown assignable.
- **routes.ts:** template-literal segment recursion for Expo and Router placeholders,
  identity default mapping, renamed required fields, duplicate default/explicit targets,
  missing required params and dynamic path rejection. The local curried route validator
  isolates this mechanism; the host registration will invoke it per named screen.
- **scenarios.ts:** intersection membership for literal and union scenario keys, and
  honest string controls with explicit refinement. This isolates the set operation;
  actual app factories retain schema/action types in parallel tables.
- **navigation.ts:** an opaque command is not an Effect; terminal handler output carries
  a shallow Navigator requirement, validates params and rejects foreign nominal contracts.
  The prototype proves the type model, not atomic navigation/cancellation execution.

### Implementation of remaining type-level claims

| Claim                                                    | Implementation strategy                                                                                                                                                                                                                                       | Instantiation risk / acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self actions and helpers infer without cycles            | Infer static `this` constructor; extract state from its schema, not recursively from Self. Self exists only in a shallow invariant instance slot. Navigation imports contracts only; implementations import navigation; app imports implementations.          | Medium. Do not recurse through the app from a contract. Verify the three-file import cycle example.                                                                                                                                                                                                                                                                                                                                                                              |
| No-input and declared unknown stay distinct              | Overloads selected by schema **presence**, not `unknown extends I`. NoInfer on handler input/error; action's inferred I/E come only from schemas.                                                                                                             | Medium; overload count stays constant, not multiplied by action count. Existing regression tests migrate.                                                                                                                                                                                                                                                                                                                                                                        |
| Error schema limits Effect channel                       | Infer E from schema, check handler against Effect<void\|Command, E, R>; provide labeled alternatives for absent schema. Infer R from handler only, never from a whole app union.                                                                              | Medium. Prove annotated callback cannot broaden E; preserve existing negative tests.                                                                                                                                                                                                                                                                                                                                                                                             |
| Human errors instead of never/dumps                      | A shallow Check property on the value, separated inference and validation with NoInfer. Ordinary shape errors stay native. Missing service helpers use service identifiers/literal keys.                                                                      | Medium. Compiler formatting is not controllable; snapshot marker text and location, not complete compiler prose. No claim that every TypeScript error can be rewritten.                                                                                                                                                                                                                                                                                                          |
| Exactly one implementation per contract                  | Map tuple once by contract.name; check nominal assignability at each indexed slot; a shallow tuple uniqueness fold checks duplicate names. Runtime Map uses constructor objects and implementation objects separately.                                        | Medium for large tuples; O(n²) uniqueness checks capped by existing node limits. Avoid union-to-tuple permutations.                                                                                                                                                                                                                                                                                                                                                              |
| Services/layers covered per scenario                     | Infer requirement union once from each selected action. Exclude built-in Scope/Registry/Navigator and listed fixture services; compare against Layer output. Never use layer object metadata to infer fixture presence.                                       | High until integrated. Must stay below budget on inventory and 50 synthetic screens; do not carry Layer types through UI bindings.                                                                                                                                                                                                                                                                                                                                               |
| Fixture service yields access                            | defineFixture returns a Context.Service-compatible yielding facade keyed by its actual definition object; mounted fixtures provide that service. Compile witness is FixtureService<Name>; duplicate same-name fixture objects are caught at app construction. | Low static cost. Function calls cannot mint fresh types; runtime identity remains required for same-name independently made fixtures. Do not claim generative nominality for defineFixture.                                                                                                                                                                                                                                                                                      |
| Per-scenario fixture membership                          | Literal scenario indexes a cached membership table; union scenario checks each candidate against all possible keys (prototype). Defaults are a separate literal parameter, not keyof Sc. reset returns a new specialization.                                  | Medium O(scenarios × fixture count), local to opening/narrowing a client. Hooks do not instantiate every scenario graph.                                                                                                                                                                                                                                                                                                                                                         |
| withScenarios preserves identity but extends truth       | Runtime reference is reused; implementation selection frozen. Additive name-only check avoids intersection overrides. Base Provider validates runtime reference; base controls use string; checked scenario views require the extended app witness.           | Low. Full generative nominality of factory apps is impossible; runtime validation is intentional.                                                                                                                                                                                                                                                                                                                                                                                |
| Route placeholder mapping                                | Split on `/`, recognize one segment at a time; cache defaulted mapping once per registration. Match required-field keys to placeholders and optional fields to query. Partial mapping uses identity for absent keys.                                          | Low at normal URL length; reject paths exceeding protocol string limits at runtime. Advanced codec avoids unbounded recursive types for runtime strings.                                                                                                                                                                                                                                                                                                                         |
| Host accepts store and Effect apps without Effect import | App descriptor holds public schema validators/factory closures and a flattened consumer table. Bindings never import Effect implementation types/executable modules. `InferState` reads the public table.                                                     | Medium declaration/bundle risk. Inspect emitted declarations and production/Effect-free module graphs.                                                                                                                                                                                                                                                                                                                                                                           |
| Default project is honest                                | Conditional overload requires S extends Json (readonly forms allowed); runtime deep JSON validator checks prototypes, accessors, cycles, sparse arrays, nonfinite values and size. Error output uses E or projected EW under the same check.                  | Medium. Limit recursive validation types to JSON shape extraction; runtime handles recursive values. Do not infer Date as `{}` via mapped keys.                                                                                                                                                                                                                                                                                                                                  |
| Narrowed state across async suspension                   | StateAccess carries Narrow + All. Guarded commit rechecks the tag. Journey state() validates the requested discriminant every read; all other fields remain mutable values, not literal proofs.                                                               | Low type cost; runtime races need tests. An expired view cannot be made statically unusable in TS.                                                                                                                                                                                                                                                                                                                                                                               |
| Suspense does not double mount                           | One registry keyed by constructor and entry key owns the memoized promise, generation and disposer; both hooks share lookup/acquisition and differ only in read behavior.                                                                                     | Runtime claim, no generic proof. StrictMode, abandoned render, pending eviction/reset and normal/Suspense mixed tests are mandatory.                                                                                                                                                                                                                                                                                                                                             |
| Terminal navigation requirement                          | Branded success value carries literal Key; action extracts Key once and adds Navigator<Key> to requirements. No command => no requirement. Refusal callback admits void only and runs under operation supervisor before source disposal.                      | Medium. Prototype covers one key, ordinary void actions and refusal callbacks. Recovery success must be inferred as its own generic and then checked: Effect<Command> can otherwise flow into Effect<void> through TypeScript void-return assignability. Runtime also rejects a recovery result containing a command. Union-of-keys tests remain required. No discarded-command detection is claimed: TS permits unused expressions; optional lint can catch an ignored command. |
| Live membership and wire types                           | Local descriptor carries encoded schemas; handshake compares descriptor and validates responses. A/B implementation selection comes from the local app table. No remote constructor identity assertion.                                                       | Low type cost; runtime compatibility tests mandatory, including descriptor mismatch and omitted error data.                                                                                                                                                                                                                                                                                                                                                                      |

### Measured versus predicted

The isolated prototypes measured **6,115 instantiations**, **0.34 seconds total**, and
about **137 MB** (TypeScript 5.9.3, this checkout). The run uses the small prototype
tsconfig rather than the integrated workspace program. This is a small proof, **not** an estimate of the final integrated
program. The current branch is about 349k of 357.5k, leaving only about 8.5k. Do not add
prototype counts to that number: separate TS programs count shared library work differently.
The implementation must replace the old generic graph and stay at or below 357,500;
target ≤325,000 to regain margin. Keep the gate unchanged. Record --extendedDiagnostics
for root/mobile/web and fixture projects, plus 10/50/100-screen scaling cases. Compare
per-node hook additions separately so a large union does not hide superlinear cost.

For budget control, the implementation erases service requirements at the host-neutral
app boundary, uses flat per-contract consumer entries, caches scenario tables, and computes
route validation only once in the binding factory. UI useScreen indexes one name then
checks nominal identity; it never maps every action of every screen. No global module
augmentation, app-wide distributive recursive conditional, or schema re-derivation in each
hook is permitted. If 50-screen validation exceeds the gate, simplify selection tables
before implementation review; raising the ceiling is not an accepted escape.

### Implementation acceptance plan (future work)

1. Build declarations and compile every authored file above in linked fixture projects,
   including both store and Effect apps in Expo/Router. Put every misuse row into a
   diagnostic/runtime test with its marker/message; preserve existing protocol conformance.
2. Implement the single registry and supervisor once; run lifecycle tests for A/B selected
   implementations, duplicate names, pending eviction, normal/Suspense sharing, stale
   reset handles, store unsubscribe/disposal, navigation refusal/recovery and self-back.
3. Check root/advanced/dev export allowlists, no `/internal` imports, and production
   Metro/Vite graphs for test code, Effect on the plain path, bridge tokens and diallers.
4. Run bun run check, host E2E journeys, descriptor mismatch tests, and type budgets.
   Require line totals ≤7,600 and reviewers' independent 9/10-per-factor acceptance before
   declaring the implementation finished. This design turn does not launch reviewers or
   claim their approval; the requested deliverable is the design and feasibility evidence.

### Honest predicted rubric scores

These are predictions for this specification, not independent review results or measured
implementation scores. A 9 is not asserted where prototype/host evidence is still missing.

| Factor                                          | Prediction | Main remaining risk                                                                        |
| ----------------------------------------------- | ---------: | ------------------------------------------------------------------------------------------ |
| Ceremony / common-case brevity                  |          8 | Private nominal line and contract/implementation split remain visible.                     |
| Inference                                       |          9 | Self annotation is the sole contract annotation; integrated layer inference unproved.      |
| End-to-end typing                               |          9 | Selection is explicit; remote compatibility needs validation implementation.               |
| Correctness by construction / misuse resistance |          8 | Alias revocation and omitted nominal declarations need runtime/lint safeguards.            |
| Consistency                                     |          9 | Same Provider/app, hooks, roles and handler shape across adapters.                         |
| Progressive disclosure                          |          9 | Explicit root/advanced tiers; dev is platform-only.                                        |
| Errors                                          |          8 | Relationship markers proved locally; full negative diagnostic suite still required.        |
| Host idioms                                     |          9 | Zustand stores, Effect layers, RouteObject[], Link and Expo Stack are preserved.           |
| Surface hygiene                                 |          9 | Explicit exports, no public internal paths or duplicate resolution API.                    |
| Testability                                     |          9 | Shared stories and built-in connection; virtual-time start is explicit.                    |
| Examples                                        |          8 | Complete authored files are specified; they cannot compile against unimplemented APIs yet. |
| Type performance                                |          8 | Small prototype measured; integrated 349k baseline leaves little margin.                   |

The design is ready for independent criticism, not a claim that the 9/10 threshold has
already been reached. In particular, reviewers should decide whether the one-line nominal
trade-off is acceptable and challenge the supervisor/host integration before packages change.

## 6. Validation of this design change

The prototype project passes `bunx tsc --noEmit -p docs/design/prototypes/tsconfig.json`.
All negative cases are consumed. Removing the expected-error directives in an in-memory
compiler run confirms the foreign-contract and fixture errors include the intended
`is not a screen of app 'inventory'` property marker at the calling expression.

`bun run check` passes on this checkout: formatting/lint, existing documentation snippets,
root/mobile/web typechecks and 631 tests pass (3 platform-specific tests skipped). This
validates that the documentation-only branch preserves the existing implementation; it
does not validate unimplemented target APIs or the authored target example files.
