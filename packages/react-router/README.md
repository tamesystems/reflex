# @reflex/react-router

Keep React Router beneath `ReflexProvider`. A leaf route uses one hook:

```tsx
const view = useScreen(Detail)
if (view.status === "pending") return <p>Loading…</p>
return <button disabled={!view.actions.Save.available} onClick={() => view.actions.Save.run()}>Save</button>
```

Mounting happens after commit. The hook reports focus while the leaf matches, and uses
the router's location key internally. No entry key, separate focus hook, or app cache is
needed. Entries survive back/forward within a 64-entry budget. New pushes dispose
unreachable forward entries; evicted older entries mount afresh if visited again.
Register router-mounted definitions with `defineStoreApp({ name, routes: { Detail } })`;
ambient nodes belong in `nodes` and start eagerly.

The adapter imports no Effect, Expo, React Native, or private router modules. It currently
accepts synchronous mount definitions; a service-layer Effect route adapter is outstanding.
See [ADR 0021](../../docs/decisions/0021-contracts-before-implementations.md).
