# @reflex/rpc

Protocol connections and transports for headless and live applications.

## Responsibilities

JSON-RPC peers/clients, cancellation, bounded framing, local IPC authentication/encryption and bridge forwarding.

## Does not own

Application execution, UI frameworks, command semantics or bridge WebSocket admission.

## Start reading

1. `src/server.ts`.
2. `src/client.ts`.
3. `src/bridge-controller.ts`.
4. `src/socket.ts`.

## Important invariants

Depends only on protocol/runtime and Node APIs. The /connection entry has no Node APIs and is safe in browsers and mobile apps. Keep framing bounded and observe transport backpressure; local Windows IPC authenticates and encrypts before JSON-RPC.

See [architecture](../../docs/ARCHITECTURE.md) and [development](../../docs/development.md).
