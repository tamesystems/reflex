# @reflex/live

Serve any running JavaScript app through the Reflex bridge. Requires a global WebSocket,
provided by browsers, React Native, Bun and Node 22+. No React, React Native, Expo or Effect.

## Responsibilities

- `connectBridge(setting)` dials out, authenticates and serves a Controller over WebSocket.
  It retries with backoff and reports status; authentication/version/replacement refusals stop retries.
- `LiveSessions` owns the current session, starts and resets it; `SessionOwner` ends abandoned
  sessions, including late starts. Each run has a distinct session-id prefix.
- `createLiveController` implements the protocol over those sessions, with the same limits,
  reset ordering and deadlines as headless serving.
- `nodeSource`, `reportFocus` and `send` provide structural node access and UI event helpers.

## Does not own

Rendering, framework lifecycle, the bridge daemon or application state.
The application decides whether and when to connect, and supplies its AppHost and safe projections.

## Start reading

1. `src/bridge.ts`: dialling and reconnect lifecycle.
2. `src/live-sessions.ts`, `src/session-owner.ts`: session ownership.
3. `src/live-controller.ts`: protocol methods and subscriptions.
4. [live-counter](../../examples/live-counter/README.md): a complete plain process.

## Using it

```ts partial: integration excerpt; the host and environment are application-owned
import { serveLive } from "@reflex/live"
const server = await serveLive(app, { setting })
// On shutdown:
await server.close()
```

## Important invariants

- No framework, Effect or Node imports. Only `@reflex/rpc/connection` from RPC.
- `@reflex/live/session` exports lifecycle/node helpers without importing the bridge.
  UI bindings use this entry. Expo dev and live/vite modules own guarded environment reads,
  so production bundles exclude both bridge code and token.
- Starts use the runtime's default budget, not the headless REFLEX_START_TIMEOUT_MS setting.
- A reset replaces the app's actual session; there is no separate protocol-only state.

`Bridge` is the single connector type. `serveLive` owns a controller and awaits disposal
on close. Low-level LiveSessions/controller/node-source helpers remain available through
the bridge-free session entry. `send` is secondary to typed node.actions and returns its
correlated outcome union. See [adopting](../../docs/adopting.md).

## Entry points

`@reflex/live` owns bridge connections and framework-free serving. `@reflex/live/session`
provides platform-free session/controller and UI action infrastructure without the dialler.
`@reflex/live/vite` owns Vite's development guard and dynamically loads the bridge. These
entries deliberately remain separate so production UI builds exclude transport code.

`@reflex/live/advanced` provides `createSessionOwner(start)`: `close()` waits for an
in-flight start and closes its result once. The root exposes only `connectBridge`,
`serveLive`, `Bridge`, `BackgroundReporter` and the shared `JourneyClient` type.
