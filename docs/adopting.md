# Adopting Reflex in an existing app

Expose one store or screen first. Keep the application's state and router; Reflex owns
its public contract and session lifetime. See [plain](../examples/plain/src/app.ts) and
[web](../apps/web/src/main.tsx) for complete examples.

## Define the contract once

```ts partial: excerpt; surrounding imports and application definitions are omitted
const Counter = defineStoreNode({
  name: "Counter",
  type: "screen",
  store: createCounterStore,
  project: ({ count }) => ({ count }),
  actions: (action) => ({
    Add: action({
      input: standardInput(z.strictObject({ by: z.int() })),
      handler: ({ by }, { store }) => store.setState({ count: store.getState().count + by }),
    }),
  }),
})
const app = defineStoreApp({ name: "counter", nodes: { Counter } })
```

Store nodes default to `service`; opt into `type: "screen"` for focus gating.
`defineStoreNode` retains the concrete store, projected state and action map. Handlers
receive decoded inputs; consumers supply the validator's input type. This applies to both
Standard Schema and Effect codecs: a NumberFromString input accepts a string at the
action call and gives the handler a number. `standardInput`
uses Standard Schema v1 and Standard JSON Schema when available, including Zod 4. A second
argument overrides the input JSON Schema for validators without a converter or refinements
it cannot express. Prepare is synchronous: async validation is refused before acceptance.

`defineStoreApp` creates fresh stores on start/reset, owns the reporter and disposal, and
focuses the first screen. Its optional scenarios provide typed `stores` overrides, keyed by node; `.withScenarios`
composes them while preserving names and store types. Use a handwritten `AppHost` only
for custom ownership beyond these factories. For a process, use
`await serveLive(app, { setting })` from `@reflex/live`, then `await server.close()`.

## Render typed nodes

```tsx partial: component or binding excerpt; application definitions are omitted
const view = useNode(Counter, { focus: true })
if (view.status === "pending") return <p>Loading…</p>
return <button disabled={!view.actions.Add.available} onClick={() => view.actions.Add.run({ by: 1 })}>
  {view.state.count}
</button>
```

`ReflexProvider` owns the session. `useNode` accepts the definition value; the application
never inspects JSON to find its own state. `useAction` returns `run`, `available`, `reason`,
`pending` and `outcome`. Its guard comes from the same definition the runtime enforces.
`node.actions.Add({ by: 1 })` works outside React too. Outcomes distinguish `completed`,
`cancelled`, `refused`, `domain-error` and `defect`. Refusals include a code and reason.
Unexpected local failures report through the runtime even if a UI ignores the promise.
Secondary dispatch is available only through the advanced integration tier.

Bind the real app with `const { Provider, useNode, useSession } = createReflex(app)`.
The bound `useSession()` checks scenario names and provider identity. `useRuntime` and
`useRawNode` live in `@reflex/react/advanced`, alongside sibling adapter seams.

## Keep an existing router

For a selected screen, `useNodeFocus(node, focused)` reports the router's focus boolean.
Focus is one runtime operation: an arrival publishes focus and runs Effect `onFocus` as
tracked work. Repeated reports do not reload; departure and return do. Older cleanup
cannot clear a newer screen's focus. Covered screens refuse new actions; existing work
continues until cancelled or disposed. Ambient service/fixture nodes need no focus.

For React Router 8.5.1, mount a definition after commit and retain its history entry:

```tsx partial: component or binding excerpt; application definitions are omitted
const view = useScreen(Detail)
if (view.status === "pending") return <p>Loading…</p>
```

Obtain `useScreen` and `Provider` from `createReflexRouter(app, registration)` in
`@reflex/react-router`. The registration covers every screen. It keys ownership by `location.key`,
reports match focus, and retains at most 64 entries. A new push frees unreachable forward
entries; an evicted entry mounts afresh on return. No app cache or entry key is needed.
Register the route definitions with `defineStoreApp({ name, screens: { Detail } })`.
Do not mount during render. This adapter follows existing routes; it does not navigate
headlessly. Core-owned React Router projection remains deferred (ADR 0018).

## Effect screens and Expo

Establish state, params and initial state with `defineScreen` in a module with no handler
imports. Build `defineNavigation("app/Navigation", { List: ListScreen, Detail: DetailScreen })`
from these contracts. Attach handlers with `.implement`, then pass their definitions to
`defineApp({ navigation: Nav.implement({ List, Detail }, { initial }), fixtures, scenarios, ... })` at app composition.
`Nav.push("Settings")` is an Effect ready to return from a handler; required params remain
required. Navigation runs after the handler completes; a successful pop reports `completed`.
Navigation refusals surface automatically, without an error declaration.

Use `action.when("editing").reduce({ input, reducer })` for synchronous state updates.
The guard narrows both availability and the reducer. Async guarded handlers receive a
narrowed `get` and `update`; writes recheck the tag at commit. Use `state.when(tag)`
when asynchronous work changes phase.
A stale narrowed read interrupts rather than inventing a state that no longer exists.

```ts partial: excerpt; surrounding imports and application definitions are omitted
const { Provider, RouterProjection, useScreen, useSession } = createReflexExpo(app, {
  List: "/",
  Detail: { pathname: "/inventory/[id]", params: { productId: "id" } },
  Settings: "/settings",
})
```

Import `createReflexExpo` and `developmentBridge` from `@reflex/expo`. The total mapping
derives both directions and validates incoming params. Mapping targets must be unique.
Render the bound `<RouterProjection />`, and read a screen with `useScreen(DetailScreen)`.
UI modules import contracts, never implementations. `useScreenSuspense` returns the ready
view; the ordinary hook returns pending/ready. Param parsing belongs to the adapter.
Use `defineNavigationFactories` from `@reflex/effect/internal` only for custom ownership.

## Failures and journeys

Effect actions that can fail declare an error schema; their handler's error channel must
match it. The client observes encoded, redacted error data, which may be omitted if it
exceeds wire limits; local consumers then receive a defect rather than a false typed value. Store actions declare a Standard Schema validator directly as `error` and
call their typed context's `fail(error)`. Other throws are defects. `StoreFailure` construction is internal and cannot publish undeclared domain data. All public error messages/data must be safe.

```ts partial: excerpt; surrounding imports and application definitions are omitted
const session = await pool.open(app, { scenario: "default" })
const detail = await session.focused(Detail, { _tag: "editing" })
await detail.actions.SetQuantity({ quantity: 12 })
```

Navigation and app `fixtures` provide membership. Scenarios remain plain Layers;
use explicit `nodes` for a custom non-navigation root.
Scenario literals and node membership flow into the test client. `focused` validates a
typed partial state match. `await detail.state()` reads live state and rechecks the
tag only if the caller requested a discriminant match. Actions fail the test on failure or refusal; use
`detail.expectFailure.Save()` for narrowed declared errors and `detail.expectRefusal.Save()`
for refusals. `allowCancellation` remains for intentional cancellation unrelated to navigation. Array matches can use `includes({ id, quantity })`. `createJourneyClient(transport)` provides the
same API for a live RPC/CLI target; `JourneyClientFor<typeof app>` derives a reusable story's
contract. `explore(app, { knownInputs: { Detail: { SetQuantity: [{ quantity: 12 }] } } })`
supplies typed inputs keyed by node then action; `invariants: { Detail: state => ... }`
receives typed public state. `node(Definition)` also binds ambient fixture/service nodes. `session.raw.precondition`, `session.raw.dispatchRaw`, `session.raw.start`,
`session.raw.state`, `inspectRaw` and `client.request` are explicit protocol escape
hatches, including deliberately invalid-input tests and cancellation/virtual-time work.

## Development bridges

Expo uses `developmentBridge()` from `@reflex/expo`; Vite uses
`developmentBridge()` from `@reflex/live/vite`. Pass the result as the provider's
`bridge`. Read `EXPO_PUBLIC_REFLEX_BRIDGE` or `VITE_REFLEX_BRIDGE` only in those development
modules. Production builds exclude the dialler and token; the browser journeys check it.
CLI, MCP, access policies, revisions, waits and wire validation are unchanged.

## Boundaries that remain application-owned

Store projection deliberately selects safe public fields. It is copied, frozen and
bounded JSON, and unchanged projections produce no revision. There is no automatic secret
scanning on the store path. Availability can depend on private fields; its subscription updates independently.
An invalid external write cannot be rolled back: Reflex reports it, retains the previous
snapshot and fails operations finishing while publication is invalid. Validate store
writes when atomicity matters.

Cancellation aborts a store handler's signal, but JavaScript cannot forcibly stop a
Promise. Pass the signal to I/O and check it before late writes. Effect scopes interrupt
owned fibers. Persistence belongs to app services; resetting fresh stores does not reset
an external server or database. See [architecture](ARCHITECTURE.md) for limits and flows.
