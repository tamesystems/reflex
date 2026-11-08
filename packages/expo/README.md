# @reflex/expo

Lets one app core serve both its React Native UI and the protocol: React bindings, Expo
Router as a projection of the core's navigation, and the app's side of the device bridge.

## Responsibilities

- Own the provider's sessions (`LiveSessions`): start, replace on a scenario change or a
  bridge reset, and end them, whatever order their starts finish in.
- Bind screens to live nodes (`useRouteNode`, `useNodeState`, `send`).
- Keep Expo Router showing the core's stack, and feed what the router does by itself back
  to the core (`RouterProjection`).
- In development builds, serve the protocol to a bridge (`@reflex/expo/bridge`).

## Does not own

- Navigation decisions: the core's `Navigation` node owns the stack
  ([ADR 0003](../../docs/decisions/0003-the-core-owns-navigation.md)).
- What the router does with a gesture: Expo Router decides; this follows.

## Start reading

1. `react.tsx`: `ReflexProvider`, the hooks, `RouterProjection`.
2. `projection.ts`: every synchronization decision, as pure functions.
3. `projection-controller.ts`: the one place navigation state is owned, behind ports.
4. `bridge.ts`, `live-sessions.ts`, `live-controller.ts`: the device bridge, app side.

## Using it

```tsx
;<ReflexProvider host={app} scenario={scenario} bridge={bridge} fallback={<Loading />}>
  <RouterProjection toHref={toHref} fromLocation={fromLocation} />
  <Stack />
</ReflexProvider>
```

- `toHref` and `fromLocation` (see `apps/mobile/src/routes.ts`) map core routes to route
  files and back. They work on route files and decoded params; paths are never parsed.
- An Effect screen imports from `@reflex/expo/effect` and calls `useRouteNode(Capability, params)` for its node, `useNodeState(node)` for
  its state, and `send(node, "Action", input)` from UI events. `send` ignores expected
  refusals (a tap on a closing screen, an action just made unavailable) and reports
  defects and `ResourceExhausted`; declared business failures are the app's to show in state.
- `bridge` comes from `connectBridge(setting)` in `@reflex/expo/bridge`. Load that module
  only behind `__DEV__`, reading the setting inside the same branch, as
  `apps/mobile/app/_layout.tsx` does, so production bundles hold neither.

## Existing stores and routers

The default `@reflex/expo` entry imports no Effect. `useNode(id)` works with any adapter,
including one without a live object; `useNodeState` takes a structural snapshot/subscription
source and `send` takes its send method. Generic `useRouteNode` takes a resolver
`(runtime, nodeId) => node | undefined` for the core stack. Only `@reflex/expo/effect`
loads capability bindings and Effect.

Keep an existing router and call `useNodeFocus(id, isFocused)` from selected screens;
service nodes need no focus. Dispose popped screen nodes yourself. RouterProjection
requires the core Navigation stack (defineNavigation), so omit it in this mode. See
[the adoption guide](../../docs/adopting.md) and the isolated Expo screen in
[apps/mobile/plain](../../apps/mobile/plain/index.tsx). `e2e:plain` tests its CLI/MCP bridge
and checks Metro source maps contain no Effect modules in Linux and Windows CI.

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

## The bridge, app side

- `connectBridge` dials, says hello, and serves `createConnection` over the socket. It
  redials with backoff (0.5 s to 5 s), and stops for good on a wrong token, a protocol
  mismatch, or being replaced by another app; `onStatus` reports each.
- `LiveController` serves the session on screen, with the headless controller's limits,
  reset ordering, and deadlines for `sample` and `advanceTime`. Session starts use the
  runtime's default budget (30 s); `REFLEX_START_TIMEOUT_MS` does not reach the app. A bridge reset replaces what the screen shows, until the
  provider's own `scenario` or `host` next changes.
- Each run of the app has its own session-id prefix, so a cursor from before a reload never
  resumes against the new session.

## Important invariants

- With core-owned navigation, components never call `router.push` or `router.replace`; they send actions.
- A session's subtree is keyed by its id, so nothing outlives the session holding a
  disposed node.
- Only `router-actions.ts` imports Expo Router's private modules.
- Nothing here imports `@reflex/rpc` except `@reflex/rpc/connection`, which has no Node APIs.

## Platform notes

See [development.md](../../docs/development.md#platform-notes): Metro import paths, bundle
size, and `TextDecoder` on Hermes.
