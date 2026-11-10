# @reflex/react-router

`createReflexRouter(app, registration)` binds one app to React Router 8.5.1. Registration
covers every screen and maps decoded schema field names to URL names. Param codecs must
encode strings; use `Schema.NumberFromString` for numeric domain values. Mapping targets
must be unique. Route params are decoded before initial state is constructed.

```tsx partial: app and DetailScreen are imported from application modules
const { Provider, useScreen, useScreenSuspense, useSession } = createReflexRouter(app, {
  List: "/",
  Detail: { pathname: "/detail/:id", params: { productId: "id" } },
})
const view = useScreen(DetailScreen)
```

Place React Router beneath the bound `Provider`. Ordinary mounting happens after commit;
`useScreenSuspense` reads a session-owned resource during render. Effect routes use the
session's service layer. Store routes use that session's scenario store override.
Focus follows the leaf match, and history ownership uses `location.key`. Entries survive
back/forward within a 64-entry budget. New pushes dispose unreachable forward entries;
evicted older entries mount afresh if visited again. No app cache or entry key is needed.

The adapter imports no Effect, Expo, React Native, or private router modules. It follows
an existing router; core-owned React Router projection remains deferred (ADR 0018).
Use granular `@reflex/react` hooks for independently owned mounts.
