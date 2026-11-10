# 0018. Router-neutral projection and existing React Router apps

Date: 2026-11-10. Status: accepted.

## Context

ADR 0017 separated live serving and React hooks from Expo. The projection rules already
use ports, but their package placement prevents another router binding from sharing them.
ADR 0016 permits incremental adoption with application-owned routing. React Router 8.5.1
is the second router binding; core-owned React Router navigation is a later step.

This follows ADRs 0003, 0005, 0016 and 0017. It supersedes only ADR 0017's placement of
projection rules, controller and core port in Expo. Earlier ADRs remain unchanged.

## Decision

Move projection.ts, projection-controller.ts, core-port.ts and their tests unchanged in
behavior to @reflex/navigation. Its only dependencies are protocol and runtime: no React,
React Native, Expo, router, Effect or platform APIs. Tokens are opaque entry identity;
Expo owns the reflexNode route parameter, route-file mapping and private action listener.
Expo imports the new package and re-exports its symbols from the root; the old
@reflex/expo/projection subpath remains a thin re-export for compatibility, including
Expo’s NODE_PARAM. New router adapters import @reflex/navigation directly. Boundary tests cover all new package source files.

@reflex/react-router is an ESM-only existing-router binding, with react-router pinned
exactly to 8.5.1 and React >=19.2.7 <20. useRouteFocus(nodeId, pattern, entryKey?) combines
useMatch and useLocation with @reflex/react's useNodeFocus. String patterns match to the
end. Call it in leaf screens, not competing parent layouts. For retained elements supply
the owning location.key: matching URLs alone cannot distinguish two history entries.
The generic React peer range also accepts >=19.2.7 <20 so this baseline is usable.
The app chooses node identity and lifetime, registers/disposes nodes, and owns routes,
back/forward and reset navigation policy. The binding has no Navigation node or projection.
Providers, subscriptions, dispatch and cleanup remain in @reflex/react.

apps/web has its own install and lockfile, following mobile. Vite compiles workspace
sources with aliases and dedupes the app's React/router. Its plain store fixture retains
one node per history key until session disposal; retained detail elements exercise entry-key
focus gating across same-URL pushes. Browser forward restores that entry's
state. Reset creates fresh nodes at the current URL. This is example policy, not a library
cache. A same-URL Link explicitly uses replace={false}: React Router otherwise defaults
to replacement for a link to the current URL. Development dynamically imports the bridge
and reads VITE_REFLEX_BRIDGE only inside import.meta.env.DEV. Production is checked with a
real setting supplied: neither token nor bridge dialler may occur in any output JS.
Production source maps also exclude the bridge, Effect and native framework modules.

## React Router 8.5.1 API audit for step 2 (not implemented)

Inspected the installed package under apps/web/node_modules/react-router/, including its
package.json version. These are package files, not deep imports used by our binding:

- dist/development/index.d.ts exports createBrowserRouter, DataRouter, RouterState,
  RouterSubscriber and Location from the root.
- dist/development/lib/dom/lib.d.ts: createBrowserRouter(routes, opts?): Router.
  lib/dom/lib.js constructs createRouter with createBrowserHistory and initializes it.
- dist/development/lib/router/router.d.ts exposes get state(): RouterState and
  subscribe(fn: RouterSubscriber): () => void. RouterState includes location,
  historyAction (POP/PUSH/REPLACE), and navigation (idle/loading/submitting and destination).
  **Both state and subscribe are explicitly annotated @private, PRIVATE - DO NOT USE.**
  They are structurally accessible through a root-exported object, but are not promised
  public extension APIs. This prevents claiming that a projection has a wholly public,
  stable subscription surface just because TypeScript accepts it.
- The same router.d.ts declares navigate(to: To | null, opts?) and
  navigate(to: number): Promise<void>. The numeric overload is also annotated private;
  the path overload is not. RouterNavigateOptions includes state and replace.
  lib/router/router.js handles numeric navigation with history.go(to), and routes its
  history listener through startNavigation. subscribe stores callbacks in a Set;
  updateState invokes them synchronously independently of React rendering.
- dist/development/lib/router/history.d.ts documents Location.state and Location.key.
  State carries arbitrary per-entry data; key is unique per entry, with "default" on
  initial entry. lib/router/history.js persists user state and keys in browser history
  (usr/key), restores them on POP, and creates keys for new locations. Do not write the
  router's private browser-history representation directly.

Compared with Expo's private actionDispatched event (ADR 0005), the data router object
provides a typed, root-reachable subscription before React renders, plus the accepted
history action and pending navigation state. It does not require Expo-style private module
imports. However, it is still explicitly private API in this version. Subscribers report
router state transitions, not every attempted/dropped action, and POP includes both back
and forward. Async loaders, redirects, blocked or aborted navigation and rapid push/back
need specific acceptance tests before claiming the Expo timing guarantee.

## Concrete step 2 sketch

A future opt-in data-mode adapter would consume the AppSession and application-created
createBrowserRouter instance, plus destination/To mappers. It would reuse
ProjectionController and corePortOf, never replace the application's route definitions.
A router port implements push/replace using router.navigate(to, { state, replace }), back
using navigate(-1), tag using replacement at the current destination, and shownToken by
reading the router's committed location. Adapter-owned subscriptions feed onLocation;
core stack subscriptions feed onStack; dispose unsubscribes/cancels adapter-owned work.

Carry a namespaced Reflex node handle in location.state, preserving application state
with an explicit merge/validation policy. Do not use a URL param. Track location.key to
recognize untagged adopted entries; replacement/tagging may change the key, so the Reflex
handle is the durable identity. Include session identity in the tag and handle stale tags
after reset/reload as adoption, not live node references.

A committed POP whose token matches a lower applied entry means core GoBack; a POP to an
entry the core closed means forward/adopt and Navigate. POP alone cannot tell direction.
Compare identities with the applied stack, and retain enough entry ordering for any
additional forward policy. Ignore loader-only/revalidation updates at the same location;
track pending destinations separately from committed locations so a cancelled loader does
not prematurely pop the core. Preserve outbound command correlation and the arrival
backstop for silent drops. Test rapid push/back, loaders/redirects/blockers, identical URLs,
reset and subscriptions arriving before render. Before implementation, either obtain a
supported subscription contract upstream or explicitly accept and pin this private object
API with version/source regression tests, as ADR 0005 does for Expo. This decision is
left open; step 1 imports only public React Router hooks.

## Evidence

The moved deterministic projection/core-port tests preserve the same fake ports and
scenarios. Existing mobile browser journeys exercise the same Expo behavior. The web
Playwright journey starts the daemon out of process, then verifies focused inspection,
CLI dispatch/page updates, direct UI writes/CLI state, identical URL entry identity,
back with departed-action refusal, forward, reset and MCP reflex_dispatch. It also checks
production bridge/token exclusion. The browser CI matrix runs it on Ubuntu and Windows;
root check typechecks web and both bindings without running browser builds.
