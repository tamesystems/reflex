# @reflex/expo

Expo Router projection for Reflex, the first platform binding of the application control
protocol. Generic React bindings live in `@reflex/react`; live serving in `@reflex/live`.

## Responsibilities

- `RouterProjection` keeps Expo Router showing the core Navigation stack and feeds accepted
  gestures, links and router actions back to the core.
- `createReflexExpo(app, registration)` from `@reflex/expo` provides bound `Provider`,
  `RouterProjection`, `useScreen`, `useScreenSuspense`, `useNode` and `useSession`.
- `developmentBridge()` is exported from the root; the integration `/internal` entry
  keeps the plain store bundle free of Effect.
- Router-neutral infrastructure is available through `/internal` and @reflex/navigation,
  outside the root author surface.

## Does not own

Generic providers/hooks, session lifetime, bridge connections, rendering, application state,
or navigation decisions. The core owns its stack when RouterProjection is adopted; Expo
Router decides gesture behavior. Existing routers can use `@reflex/react` independently.

## Start reading

1. `src/react.tsx`: RouterProjection and Expo route hooks.
2. `../navigation/src/projection.ts`: pure synchronization rules.
3. `../navigation/src/projection-controller.ts`: state and timing behind ports.
4. `src/router-actions.ts`: the only Expo Router private-module imports.

## Using it

```tsx partial: application bindings; app and Stack come from the host
import { createReflexExpo, developmentBridge } from "@reflex/expo"
const { Provider, RouterProjection, useScreen, useSession } = createReflexExpo(app, {
  InventoryList: "/",
  InventoryDetail: { pathname: "/inventory/[id]", params: { productId: "id" } },
  Settings: "/settings",
})
;<Provider bridge={developmentBridge()}>
  <RouterProjection />
  <Stack />
</Provider>
```

UI modules import contracts and call `useScreen(InventoryDetailScreen)`. Registration is
total and mapping targets are unique, checked statically and at runtime. Pending/ready
views expose state and action controls; `useScreenSuspense` supplies the ready view.
The bound `useSession()` checks scenario names and provider identity. `/internal` holds
projection plumbing behind symbols; the plain integration gets its bridge from `/internal`.

## How the router is followed

- Each core push carries its node's handle as the `reflexNode` route param, so router
  entries are matched to core entries by identity; two can share a URL.
- The projection learns of every action the router accepts through Expo Router's private
  `actionDispatched` event, read only in `router-actions.ts`, with `expo-router` pinned to
  the exact version its test checks
  ([ADR 0005](../../docs/decisions/0005-expo-router-private-actions.md)).
- A push with no sign of arrival after 500 ms makes the projection read the router's own
  state. If the router shows it, it waits for the report, up to about 10 s more; if not, the
  router dropped it, and the core pops that screen. A deadline that fires more than 100 ms
  late means JavaScript was blocked, so it waits again instead.
- Android's hardware back during a pending push pops the screen beneath (or leaves the app
  at the root), and the push still lands. The core follows, so the pushed screen is
  recreated there.

## Important invariants

- Components using core-owned navigation send actions rather than router.push/replace.
- Only router-actions.ts imports Expo Router private modules; its exact version is pinned.
- Production UI bundles contain no bridge or token. The bound factory supports Effect screens.
- `e2e:plain` proves the generic store screen's Metro graph has no Effect modules.

See [development.md](../../docs/development.md) for browser, live and Hermes checks.

Registration requires URL string codecs (for numbers use `NumberFromString` and domain checks), checks placeholders and encoded keys, and reports `InvalidRouteParams` with route and cause. Mapping functions are behind an internal symbol used only by RouterProjection.
