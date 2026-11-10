# @reflex/react-router

Existing-route binding for React Router 8.5.1 and React >=19.2.7 <20. Keep the application's
router beneath ReflexProvider; Reflex does not own navigation.

```tsx
const node = useRouteNode(Detail, { lifetime: "history-entry" })
useRouteFocus(node)
const state = useNodeState(node)
```

`useRouteNode` mounts after commit, keyed by location.key, retaining state for browser
back/forward until session end. No application entry cache is required. `useRouteFocus`
reads the enclosing match. Retained route elements supply `entryKey` in the mount options
and as the focus hook's second argument, so hidden same-URL entries cannot take focus.
Use leaf screens; layouts should not compete for focus.

The package has no Expo, React Native, Effect or private router imports. React owns the
mounting/disposal mechanics; the adapter supplies router identity and match information.
Core-owned data-router projection is deferred (ADR 0018). See [adopting](../../docs/adopting.md)
and [web](../../apps/web/src/main.tsx).
