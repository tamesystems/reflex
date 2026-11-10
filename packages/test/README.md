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

## Typed stories

`pool.open(app, { scenario })` checks scenario names. `await session.focused(Definition,
{ _tag: "editing" })` returns a narrowed captured wire snapshot and typed node.actions.
`session.node(Definition)` binds fixture/service nodes too. Node membership derives from app.nodes. `JourneyClientFor<typeof app>` and
`createJourneyClient(transport)` run one story against loopback or a live device CLI.
`inputsFor(Definition, { Action: [input] })` supplies exploration cases per node/action.

`inspectRaw`, `dispatchRaw`, start, waits, client.request and operation ids are explicit protocol-level
seams for invalid inputs, cancellation and virtual time. The ordinary story uses definitions.
See [the shared journey](../../examples/inventory/journeys/services.ts).
