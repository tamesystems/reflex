# @reflex/expo

Expo Router projection for Reflex, the first platform binding of the application control
protocol. Generic React bindings live in `@reflex/react`; live serving in `@reflex/live`.

## Responsibilities

- `RouterProjection` keeps Expo Router showing the core Navigation stack and feeds accepted
  gestures, links and router actions back to the core.
- `useCoreStack`, `useShownToken`, `routeParam` and `useRouteNode(resolve, params?)` adapt
  router state and route params to node binding.
- `@reflex/expo/effect` offers `useRouteNode(capability, params?)` with Expo route inputs.
- Router-neutral projection functions/controller live in `@reflex/navigation` and are
  re-exported from the Expo root and the compatibility `/projection` entry.

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

```tsx
import { ReflexProvider } from "@reflex/react"
import { RouterProjection } from "@reflex/expo"

;<ReflexProvider host={app} bridge={bridge}>
  <RouterProjection toHref={toHref} fromLocation={fromLocation} />
  <Stack />
</ReflexProvider>
```

`toHref` and `fromLocation` map route files and decoded params (see apps/mobile/src/routes.ts).
Load `connectBridge` from `@reflex/live` and read EXPO_PUBLIC_REFLEX_BRIDGE only behind
`__DEV__`, as apps/mobile/app/_layout.tsx does. Screens import `send`/`useNodeState` from
`@reflex/react`; the Expo Effect convenience entry re-exports these two helpers.

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
- Default imports contain no Effect. Production UI bundles contain no bridge or token.
- `e2e:plain` proves the generic store screen's Metro graph has no Effect modules.

See [development.md](../../docs/development.md) for browser, live and Hermes checks.
