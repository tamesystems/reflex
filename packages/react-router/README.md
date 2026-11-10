# @reflex/react-router

Thin, ESM-only focus binding for application-owned React Router 8 routes. Requires exactly
react-router 8.5.1 and React 19.2.7 or later in React 19.

## Using it

```tsx
import { useRouteFocus } from "@reflex/react-router"
import { useLocation } from "react-router"

function Detail({ nodeId }) {
  const location = useLocation()
  useRouteFocus(nodeId, "/detail/:id", location.key)
  // Render the existing store; useNode/useNodeState remain in @reflex/react.
}
```

Place screens beneath `ReflexProvider` from `@reflex/react` and your existing router.
`useRouteFocus(nodeId, pattern, entryKey?)` uses an exact match for string patterns;
PathPattern accepts React Router's explicit matching options. Pass null for no node.
Call in leaf screens so layouts do not compete for focus. For retained route elements,
pass their owning entry's key, captured when that entry was created, rather than a key
updated to the current location. Only that entry can report focus, even at identical URLs.

## Does not own

Routes, navigation, node creation/disposal, providers, stores or dispatch. Back/forward
updates follow router location. If separate entries need separate nodes, associate handles
with location.key in your application; see apps/web. Dispose them when their application
owner ends. Services need no focus. Reset navigation policy remains application-owned.
Core-owned React Router data-mode projection is future work, not exported here.

## Important invariants

No Expo, React Native, Effect or private router imports. Focus lifecycle and stale cleanup
are delegated to `useNodeFocus`. Load the bridge only inside a development branch and
read its setting there. See [adopting](../../docs/adopting.md) and
[ADR 0018](../../docs/decisions/0018-router-neutral-projection-and-react-router.md).
