# @reflex/react-router

`createReflexRouter(app, registration)` binds an app to React Router 8.5.1. Register
all screen names with literal paths, for example `{ List: "/", Detail: "/detail/:id" }`.
Params default to their schema names; `{ pathname: "/detail/:id", params: { productId:
"id" } }` renames one. Encoded params must be strings. Placeholder coverage, optional
fields, repetitions, excluded grammar and duplicate targets are checked statically.
Bracket placeholders are normalized to React Router's colon grammar.

Destructure `Provider`, `useScreen`, `useScreenStatus`, `useService`, `Link`, `href`
and `useSession`. `Link` takes a screen contract and correlated encoded params, plus
host link props. `href(Contract, params)` uses the same URL encoding and mapping.

`routes({ List: { Component: ListView }, Detail: { Component: DetailView, loader } })`
returns `RouteObject[]`. Each route requires Component, element or lazy, and accepts
host options except the fields Reflex owns (path/index/children/id and rendering
sources). Both host lazy forms are supported. Every screen has a Suspense boundary
and an error element. Screen build retry goes through the shared registry.

Put the router beneath the bound Provider. The host owns navigation; focus follows
its matched entry. History uses `location.key`, preserving separate same-URL entries
and back/forward state within a bounded budget. Effect screens mount with that
session's services; store screens use its scenario overrides. Reset replaces nodes
while retaining the current URL. See apps/web for the exact compiled spec example.

This adapter imports no Effect, Expo, React Native or private router modules.
Core-owned React Router projection remains deferred (ADR 0018).

Use `routeCodec` from `@reflex/react-router/advanced` for custom path grammar. A codec supplies path, decode and encode; it owns array
policy and encoding. Ordinary registrations retain the literal placeholder checks.

Route registration requires exactly the app's screen keys and rejects duplicate ordinary paths.
Each route's `errorElement` supplies its complete failure UI. When omitted, the documented
default displays the error and a Retry button that evicts the failed lease and resets the boundary.
Pass `developmentBridge` from `@reflex/live/vite` as the Provider's `bridge` value; no alias is needed.
