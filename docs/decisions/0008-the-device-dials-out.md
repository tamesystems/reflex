# 0008. The device dials out to a bridge

Status: Accepted

## Context

The original design's fourth milestone asked for a development-only, authenticated bridge
to the running app, with a CLI target switch, so that the same CLI actions work against
headless and live sessions. React Native
cannot reliably run a general socket server, a phone's address is often unreachable, and
the bridge must never ship in a production build.

## Decision

The developer's machine runs a bridge (`reflex --target device start`). The app, in
development builds only, dials it over a WebSocket, says hello with a token, and then
serves the protocol over that connection: it is the JSON-RPC server, the bridge its
client. The bridge is a `Controller` that forwards to whichever app is connected, so every
client works unchanged. The newest app to connect is the one driven.

## Consequences

- The app opens no port, and the bridge listens on loopback unless told otherwise.
- The token (32 random bytes, kept in `.reflex/device.token`) is the bridge's only
  authentication. Traffic is plain `ws://`, so binding to a network exposes it.
- The app loads the bridge behind `__DEV__` and reads its setting there, so a production
  build holds neither; `e2e:live` checks an export for both.
- Apps come and go, so the bridge holds requests while none is connected, and
  subscriptions resume by cursor across reconnects. A request in flight when the app
  drops may or may not have run.
- A replaced app stops redialling until reloaded, so two apps cannot fight over the bridge.
