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

Rendering, framework lifecycle, environment variables, the bridge daemon or application state.
The application decides whether and when to connect, and supplies its AppHost and safe projections.

## Start reading

1. `src/bridge.ts`: dialling and reconnect lifecycle.
2. `src/live-sessions.ts`, `src/session-owner.ts`: session ownership.
3. `src/live-controller.ts`: protocol methods and subscriptions.
4. [live-counter](../../examples/live-counter/README.md): a complete plain process.

## Using it

```ts
import { connectBridge, createLiveController, LiveSessions } from "@reflex/live"
import { systemTimers } from "@reflex/runtime"

const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: report })
const close = sessions.open(host, undefined)
const controller = createLiveController(sessions, report)
const stop = connectBridge(setting)(controller)
// On application shutdown: stop(); close(); await controller.close()
```

## Important invariants

- No framework, Effect or Node imports. Only `@reflex/rpc/connection` from RPC.
- `@reflex/live/session` exports lifecycle/node helpers without importing the bridge.
  UI bindings use this entry. Load the root entry and read its setting inside `__DEV__`
  in Expo apps, so production bundles exclude both bridge code and token.
- Starts use the runtime's default budget, not the headless REFLEX_START_TIMEOUT_MS setting.
- A reset replaces the app's actual session; there is no separate protocol-only state.
