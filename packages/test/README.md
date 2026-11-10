# @reflex/test

Journey tests and bounded exploration over the real Reflex protocol.

## Responsibilities

createTestApp journeys, operation/state waits, virtual-time driving and explore random walks with shrinking.

## Does not own

Application logic, rendering, UI frameworks or Effect integration.

## Start reading

1. `src/test-app.ts`.
2. `src/explore.ts`.

## Important invariants

Depends only on protocol/runtime/rpc. Headless and bridged controllers share the same contract. Virtual time advances explicitly; accepted dispatch is not completion. The precondition convenience helper asserts focus; named waits can target ambient nodes.

See [architecture](../../docs/ARCHITECTURE.md) and [development](../../docs/development.md).
