# @reflex/react

React bindings for any AppHost. React is the only UI dependency; no Expo Router or React Native.

## Responsibilities

- `ReflexProvider` owns live sessions and keys its subtree by session id on replacement.
- `useSession`, `useNode(id)`, `useNodeState(source)` and `useNodeFocus(id, focused)` expose
  session state, structural node sources, subscriptions and optional router-reported focus.
- `send(node, action, input)` reports defects/resource refusals from UI actions.
- `useRouteNode(resolve, { stack, token, params? })` binds a node from explicit router data,
  retaining it while an outgoing view animates. Stack entries carry `{ nodeId, params }`.
- `@reflex/react/effect` provides `useRouteNode(capability, binding)` for Effect nodes.

## Does not own

Routing, navigation decisions, React Native APIs, Expo environment variables, application
state or bridge connection settings. Services can run without focus or navigation.

## Start reading

1. `src/react.tsx`: provider, session and node hooks.
2. `src/route-binding.ts`: pure node selection.
3. `src/effect.tsx`: optional capability lookup.
4. [adopting](../../docs/adopting.md): existing stores and routers.

## Using it

```tsx
import { ReflexProvider, useNode, useNodeState } from "@reflex/react"
// Place your existing React UI inside <ReflexProvider host={host}>.
// Bind node handles with useNode and subscribe with useNodeState.
```

A provider's optional `bridge` prop accepts `connectBridge(setting)` from `@reflex/live`.
Load that module only in development in UI builds; the provider itself imports the
bridge-free `@reflex/live/session` entry.

## Important invariants

- No Expo or React Native imports, including the default entry's transitive dependencies.
- Only the explicit `/effect` entry imports Effect capability lookup.
- Replacing sessions unmounts their subtree, preventing stale node ownership.
- Focus cleanup cannot clear a newer node's focus. Existing routers report focus themselves.
