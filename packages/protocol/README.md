# @reflex/protocol

The framework-free application control contract.

## Responsibilities

JSON-RPC method/event types, parsers, error codes, bridge handshake and access policies.

## Does not own

Runtime execution, transports, framework bindings or application behavior.

## Start reading

1. `src/contracts.ts`.
2. `src/parsers.ts`.
3. `src/limits.ts`.
4. `src/access.ts`.

## Important invariants

Depends on nothing. Every peer-reachable limit belongs in limits.ts. Keep parsers and method result types aligned; wire changes require an explicit compatibility decision.

See [architecture](../../docs/ARCHITECTURE.md) and [development](../../docs/development.md).
