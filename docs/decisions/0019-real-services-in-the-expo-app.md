# 0019. Compose real services only in the Expo app

Date: 2026-11-10. Status: accepted.

## Context

The inventory service ports existed, but headless and live sessions both used fixtures.
We need evidence that the same capabilities work with real networking and device storage
without making headless journeys depend on either.

## Decision

Export the inventory root layer separately from its fixture host. The app composes it
with a platform-neutral HTTP InventoryApi and an app-only AsyncStorage SettingsStore.
The headless host imports neither implementation and retains the unexpected-network
request guard. No device dependency moves into the example core. The Bun JSON server lives outside src, runs on all Bun platforms, stores three
products in memory, validates writes with the domain Schema and exposes explicit POST
/reset and /fail-next-save test controls. It is local development machinery with open
CORS, no authentication and no production deployment claim.

Use Effect 4.1.2's effect/http/FetchHttpClient, which uses global fetch and AbortController
without Node APIs. HttpClient.withScope and Effect.scoped own the whole exchange,
including reading and Schema-decoding its body. Closing a screen/session interrupts
that scope and aborts the fetch signal. A four-second request deadline also aborts it;
it sits below the existing five-second domain save deadline. Named HTTP deadline and
64 KiB payload limits live in the example's own src/limits.ts: they bound one app's
requests to its server, not anything a Reflex peer can make Reflex hold, so they stay
out of protocol/limits.ts. The client refuses a declared Content-Length over the limit
before reading, and checks the buffered bytes before JSON decoding otherwise (it does
not claim to bound the fetch implementation's internal buffering of an undeclared body). Network, status, JSON and Schema errors
become ApiError; valid non-2xx JSON supplies its message. Cancellation stays interruption,
not an ApiError. No retries: interruption cannot roll back a write already accepted by
the server.

Pin @react-native-async-storage/async-storage to 2.2.0, the version in the installed Expo
SDK 58 bundledNativeModules manifest. It works on native and uses localStorage on web,
without SQLite's web worker/WASM setup. Store only the validated low-stock threshold
under a versioned key, never credentials. The example has no authentication and supplies
an empty redacted token. The existing infallible SettingsStore interface is unchanged:
storage I/O failure or corrupt stored data is a defect, not silently successful persistence.

Only a development build with EXPO_PUBLIC_INVENTORY_API adds and initially selects
live-services. Otherwise the existing fixture scenarios remain the default. The combined
host advertises live-services through status and accepts it on reset alongside fixtures.
Reset without a scenario retains the current scenario: it replaces nodes/scopes and
re-reads server data and stored settings, never calls the server's reset endpoint or
clears storage. Fixture reset continues to recreate fixture data. Production ignores the
API dev setting just as it excludes the bridge setting.

## Evidence and consequences

journeys/services.ts is one behavior definition shared by @reflex/test and the browser
CLI harness. It lists, opens, edits, saves, reopens to read persisted quantity, exercises
a one-shot typed failing save without changing server data, and reopens settings. The
browser additionally reads the server directly and checks quantity and threshold after
both protocol reset and full page reload. Its API binds port zero in a separate process;
the bridge daemon also runs outside bun test. e2e:services runs in both browser CI jobs.
Transport tests check schema/status/network/JSON mapping, response size, fetch signal
abortion on pop and reset, and a stalled body timing out. Server tests check validation,
status codes, persistence, one-shot failure and explicit reseeding.

This proves the real seam on Chrome/react-native-web, not native AsyncStorage, native
fetch or device networking. Native iOS/Android, physical phones, gestures and platform
storage failures remain under roadmap item "Native end-to-end coverage". The API's
in-memory data disappears when its process ends; a session reset is not a database reset.
