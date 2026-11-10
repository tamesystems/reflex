# @reflex/runtime

The framework-free node registry and session runtime.

## Responsibilities

Node registration, public store projections, operations, revisions, waits, event history and headless SessionController lifecycle.

## Does not own

Rendering, routing, Effect, platform APIs or application persistence.

## Start reading

1. `src/runtime.ts`.
2. `src/store-node.ts`.
3. `src/controller.ts`.
4. `src/session-lifecycle.ts`.

## Important invariants

Imports only protocol. Screen actions require focus; service and fixture nodes are ambient. Accepted operations are distinct from completion. Public store state is checked JSON, detached and frozen. Reset changes session identity.

See [architecture](../../docs/ARCHITECTURE.md) and [development](../../docs/development.md).
