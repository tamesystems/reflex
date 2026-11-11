# Adopting Reflex in an existing app

Expose one store or screen first. The application keeps its state and router; Reflex
owns the public contract and session lifetime. See [plain](../examples/plain/src/app.ts)
and [web](../apps/web/src/main.tsx) for complete examples.

## Define once

```ts
import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

export const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => ({ count: 0 })),
  actions: (action) => ({
    Add: action({
      input: z.strictObject({ by: z.int() }),
      handler: ({ by }, { store }) => store.setState({ count: store.getState().count + by }),
    }),
  }),
})
export const app = defineStoreApp({ name: "counter", services: [Counter] })
```

JSON state needs no projection. Rich state requires `project` to publish safe JSON.
Inputs and params accept Standard Schema validators directly, including Zod. Use
`standardInput(validator, jsonSchema)` from runtime only when a validator needs an
explicit wire schema. Consumers pass encoded inputs; handlers receive decoded values.
Async validation is refused before acceptance.

Services mount at session start. Screens belong in `screens: [Detail]` and mount through
the host's route factory. Scenarios replace definitions with
`stores: [Counter.withStore(factory)]`, preserving decoded params and concrete store
types. `.withScenarios` retains app identity and adds typed names. Fresh session stores
do not reset application-owned servers or databases.

## Render the app

Call `createReflex(app)` once at module scope to get `Provider`, `useService`,
`useScreen`, `useScreenStatus`, `from` and `useSession`. Router hosts use
`createReflexRouter` or `createReflexExpo` instead. The Provider owns its session.

```tsx partial: component excerpt; useService and Counter come from the app binding
const view = useService(Counter)
if (view.status !== "ready") return <p>Loading…</p>
return <button disabled={!view.actions.Add.available} onClick={() => view.actions.Add.run({ by: 1 })}>
  {view.state.count}
</button>
```

`useScreen(Contract)` suspends and throws build failures to the nearest boundary.
`useScreenStatus(Contract)` returns pending/error/ready, with `retry()` on errors, and
acquires after commit. `useScreenSuspense` is the specified alias for `useScreen`.
The ready view has state and per-action `run`, `available`, `reason` and `pending`.
`from(Definition)` captures one implementation for narrow `useNodeState(selector)` and
`useAction(name)` hooks. No consumer generics or JSON parsing are needed.

Local outcomes are completed, cancelled, refused, error or defect. Expected errors
report to the background reporter when ignored; defects always report. `useSession()`
provides status, scenario and typed reset. Reset returns new controls; old controls
refuse further resets. Reacquire nodes after a session change.

## Keep an existing router

React Router 8.5.1 registers every screen with its URL once:

```ts partial: app and DetailView are defined by the application
const { Provider, useScreen, useScreenStatus, routes, Link, href } = createReflexRouter(app, {
  Detail: "/detail/:id",
})
const router = createBrowserRouter(routes({ Detail: { Component: DetailView } }))
```

Put the router beneath the bound Provider. The binding reports focus from matched
entries and retains state by `location.key`, including separate entries at identical
URLs. It retains at most 64 entries, frees unreachable forward entries on push, and
recreates evicted entries on return. Effect routes receive session services; stores
receive scenario overrides. Existing navigation stays with React Router. Core-owned
React Router projection remains deferred under ADR 0018.

Registration checks placeholder coverage, encoded string params and unique mappings.
`{ pathname: "/detail/:id", params: { productId: "id" } }` renames a field. Contract
`Link` and `href` use the same encoding. Custom grammar and array policy use
`routeCodec` from the host's advanced entry. A custom host can implement `RouteAdapter`
and call `createRouteAdapter` from `@reflex/react/advanced`; sibling adapter internals
are not author APIs.

## Effect screens and Expo

Declare `class Detail extends Screen("Detail", { state, params, initial }) {}` in a
contract module. Navigation imports those contracts; implementations import navigation.
`defineNavigation({ List, Detail })` builds terminal commands. Attach `.implement` to
each contract and compose `Nav.implement([list, detail], { initial })` in `defineApp`.
Use `defineService` for ambient production state and `defineFixture` for scenario
controls. Provision order is fixtures, common layer, scenario layer, handlers.

`action.when("editing").reduce({ input, reducer })` narrows state and rechecks the tag
at commit. Async guarded handlers use `{ state }`; `state.when(tag)` selects a new
phase after suspension. Closed state access interrupts before running a transition.
`action.navigates` returns `Nav.push(Detail, params)`, `Nav.back` or `Nav.stay`, directly
or from an Effect. Navigation starts after the handler's scope closes, so a successful
back completes its caller. A navigation refusal stays refused after optional recovery.

```tsx partial: app and Stack are defined by the host
const { Provider, useScreen, useScreenStatus, Link, href } = createReflexExpo(app, {
  List: "/",
  Detail: { pathname: "/inventory/[id]", params: { productId: "id" } },
  Settings: "/settings",
})
;<Provider bridge="development">
  <Stack />
</Provider>
```

The Provider includes Navigation projection and bridge lifetime. Each screen supplies a
local Suspense boundary for `useScreen`, or uses `useScreenStatus`. UI modules import
contracts; hooks resolve their registered implementation. Store-only hosts use Expo's
entry keys and the same session route registry. `routeCodec` lives in
`@reflex/expo/advanced`; ordinary pathname checks also honor Expo's generated Href types.

## Failures and journeys

Effect failures must match a declared error schema. Store errors declare a validator;
only those handlers receive `fail`, and rich decoded errors supply `projectError`.
Consumers observe encoded/redacted public error data. Invalid and undeclared failures
are defects. All published messages must be safe.

```ts partial: app, Detail and the test runner's pool are application definitions
const session = await pool.open(app, { scenario: "default" })
const detail = await session.focused(Detail, { _tag: "editing" })
await detail.actions.SetQuantity.expectCompleted({ quantity: 12 })
await detail.actions.Save.expectCompleted()
```

`createTestApp(app)` returns an async-disposable journey, and `createTestAppPool()`
owns runner cleanup. Membership and scenario names derive from the app. `focused` can
narrow state by a typed partial match; `state()` rechecks that match. Use `includes` for
array members. `service`, `fixture` and `node` acquire ambient nodes; `open` mounts a
host-owned screen. Store open params use encoded validator inputs because arbitrary
Standard Schema transforms have no inverse; Effect params use decoded codec values.

Ordinary action calls and `expectCompleted` assert completion. `run` exposes the outcome;
`expectError` and `expectRefusal` assert deliberate alternatives. `start` returns an
operation handle for cancellation and completion. Reset returns a new typed scenario
client and revokes old handles while the original disposer retains ownership.
`connectJourney(app, { target: "device", scenario })` runs the same story through the
CLI's authenticated endpoint. `JourneyClientFor<typeof app>` derives story types.

`explore(app, { knownInputs: { Detail: { SetQuantity: [{ quantity: 12 }] } }, invariant })`
walks available actions with bounded replay/shrinking. An async invariant reads typed
journey state. Protocol probes use `session.raw` or `createProtocolTestSession` from
`@reflex/test/advanced`; custom transports use `createJourneyClient` from that entry.

## Development bridges and ownership

Use `bridge="development"` on the bound Provider. Metro selects `@reflex/expo/dev` and
Vite selects `@reflex/live/vite` through the host-neutral live/dev alias. The development
module owns the guarded setting read. Production exports exclude bridge code, tokens and
E2E instrumentation; browser journeys verify those boundaries. Plain processes call
`serveLive(app, { setting })` and await `close()` at shutdown.

Published state is bounded, detached, frozen JSON. Identical public projections produce
no revision; availability subscriptions update independently. Store projections explicitly
select safe fields and do not automatically scan for secrets. Invalid external writes
retain the last good snapshot and report failure; Reflex cannot roll back application
stores. Validate writes when atomicity matters.

Cancellation aborts the handler's signal and revokes its store facade, including extracted
methods, before abort listeners run. Independently retained raw stores remain application
owned. Pass signals to I/O; JavaScript cannot stop a Promise that ignores cancellation.
Effect scopes interrupt owned fibers. See [architecture](ARCHITECTURE.md) for flows and
[ADR 0020](decisions/0020-userland-api.md) for the final API and retained internals.
