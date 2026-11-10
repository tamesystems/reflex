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

## Author API

`defineStoreNode` captures the store factory, public projection and contextual action builder.
`standardInput(schema)` derives JSON Schema through the Standard JSON Schema contract,
with an explicit override when needed. Input types before/after validation remain distinct.
`defineStoreApp({ name, nodes })` owns runtime construction, default focus and disposal.
Scenarios accept typed stores overrides; `.withScenarios` composes them without losing
node/state/scenario contracts.
`node.actions.Action(input)` returns an ActionOutcome; `availability` is shared with the
protocol and React. Declared store errors use a schema and typed context.fail(error).
AppHost remains an explicit escape hatch. `mountStore` and createRuntime are advanced
ownership seams under `@reflex/runtime/internal`.

`src/node-handle.ts` defines the shared Effect/store consumer contract and definition-owned
journey serialization. See [adopting](../../docs/adopting.md) and ADR 0020.
