# @reflex/expo

Expo Router projection for Reflex, the first platform binding of the application control
protocol. Generic React bindings live in `@reflex/react`; live serving in `@reflex/live`.

## Using it

`createReflexExpo(app, registration)` provides Provider, useScreen, useScreenStatus,
useService, Link, href and useSession. Register every screen with a literal pathname;
params default to their schema names. Explicit params mappings rename fields. Literal
placeholder checks share React Router's implementation; generated Expo Href types also
validate registered pathnames. The author root imports no Effect.

```tsx partial: app and Stack come from the host
import { createReflexExpo } from "@reflex/expo"
const { Provider, useScreen, useScreenStatus, Link, href } = createReflexExpo(app, {
  InventoryList: "/",
  InventoryDetail: "/inventory/[productId]",
  Settings: "/settings",
})
;<Provider bridge="development">
  <Stack />
</Provider>
```

Provider includes the core Navigation projection and owns bridge lifetime. Metro aliases
`@reflex/live/dev` to the Effect-free `@reflex/expo/dev` implementation. That helper gates
the setting read and dialler behind **DEV**. Put a Suspense boundary in each screen
using useScreen; useScreenStatus instead exposes pending/error/retry and acquires at
commit. Effect and store screens use the same consumer definitions. Store screens
without core Navigation use Expo entry keys and session-owned route factories.

Link accepts a contract, correlated encoded params and Expo Link props. href returns
an Expo Href. Integration plumbing lives under the internal entry; `routeCodec` and its type live
under `@reflex/expo/advanced`. Custom codecs own advanced grammar and array policies.

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
- Production UI bundles contain no bridge or token. The bound factory supports Effect and store screens.
- `e2e:plain` proves the generic store screen's Metro graph has no Effect modules.

See [development.md](../../docs/development.md) for browser, live and Hermes checks.

Registration requires URL string codecs, total registrations, unique mappings and
matching placeholders. Projection mapping remains behind an internal symbol.
