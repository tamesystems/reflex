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

Imports only protocol. Screen actions require focus; service and fixture nodes are ambient. Accepted operations are distinct from completion. Public store state is checked JSON, detached and frozen. Reset changes session identity. Handler store access is revoked before cancellation abort
listeners run and when its node is disposed. Extracted store methods retain the revocation
check; independently retained raw stores remain application-owned.

See [architecture](../../docs/ARCHITECTURE.md) and [development](../../docs/development.md).

## Author API

`defineStoreNode` infers state from `store.getState`. JSON state needs no `project`;
otherwise supply an explicit safe JSON projection. Inputs and params accept Standard
Schema validators directly, including Zod. `standardInput(schema, jsonSchema)` supplies
an explicit wire schema for opaque validators. Handlers receive decoded inputs and
`{ store, signal }`; declared errors add `fail`. `projectError` publishes rich failures
as JSON. Undeclared or invalid failures are defects.

`defineStoreApp({ name, screens, services })` checks roles, unique names, JSON state and
params. Services mount immediately and cannot require params; screens mount on demand.
Scenarios use `stores: [Counter.withStore(factory)]`, preserving store and decoded
params types. Foreign overrides are rejected. `.withScenarios` retains app identity.

`createRuntime(app, { scenario })` and `mountOwned(runtime, Counter)` under
`@reflex/runtime/advanced` expose owned state, subscriptions, typed action views and
disposal. Runtime disposal revokes the generation before ending its stores. Independently
retained raw stores remain application-owned. Owned action views return `completed`,
`error`, `refused`, `cancelled` or `defect` outcomes.

See [ADR 0020](../../docs/decisions/0020-userland-api.md).

`src/node-handle.ts` defines the shared Effect/store consumer contract and definition-owned
journey serialization. See [adopting](../../docs/adopting.md) and ADR 0020.

`src/publication.ts` shares detached, deeply frozen JSON publication with the Effect
adapter. Publication rejects accessors, non-JSON values and values outside protocol limits.
