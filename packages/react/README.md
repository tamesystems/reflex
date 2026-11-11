# @reflex/react

Call `createReflex(app)` once at module scope and destructure its `Provider`,
`useScreen`, `useScreenStatus`, `useService`, `from` and `useSession` bindings.
The default entry is host-neutral and imports no Effect, router or native framework.

`useScreen(Contract)` suspends until ready and throws build errors to the nearest
boundary. `useScreenSuspense` is its compatibility alias. `useScreenStatus(Contract)`
returns pending/error/ready; an error includes `error` and `retry()`. Screen membership
uses a name-indexed type table, with exact constructor checks at runtime.
`useService(Definition)` subscribes to ambient service state and action controls.

`from(Definition)` checks the registered implementation once and captures its types.
Its zero-argument screen hooks, `useNodeState(selector)` and `useAction(name)` keep
repeated hook checking independent of app size. Selectors subscribe to their selected
value, and action hooks subscribe to availability independently of state.

The Provider starts a session on mount, shows `fallback` while starting and rethrows
startup failure during render. `onBackgroundError` supplies the session reporter.
Session controls include status, scenario and typed `reset(scenario)`, which returns
controls for the new generation. Retained old controls refuse reset with SessionChanged.
UI and bridge resets use the same bounded queue. Session replacement drains the route
registry and remounts the subtree with fresh handles.

`bridge="development"` resolves the host's development entry. The host-neutral
`@reflex/live/dev` implementation is inert; Vite hosts alias it to `@reflex/live/vite`
(as apps/web does). The bridge is opened by the Provider effect and closed at unmount.
The production branch excludes the dialler and setting. A custom `Bridge` also works.

`/advanced` exports `createRouteAdapter` and its `RouteAdapter` port for a custom host.
Sibling adapters and development instrumentation use `/internal`. All route hooks use
one registry per session, including abandoned Suspense work. Builds have a protocol-defined
deadline and cancellation signal; late results are disposed. History retains at most the
protocol budget and releases unreachable forward entries. Retry replaces the promise in
the existing lease.

Status-only acquisition begins at commit. Observed expected action errors are returned
without duplicate background reporting; ignored errors and defects still report with
node/action context. The host advanced entries expose the shared `routeCodec` escape hatch.
