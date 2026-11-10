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
{ _tag: "editing" })` returns a typed handle; `await node.state()` reads live wire state and rechecks a tag only when that narrowing was explicitly requested.
Ordinary action calls fail the test on refusal, defect, domain failure or cancellation.
Use `node.expectFailure.Action()` for narrowed declared errors, `node.expectRefusal.Action()`
for refusals, and `node.allowCancellation.Action()` for intentional cancellation.
Navigating actions normally complete.
`session.node(Definition)` binds fixture/service nodes too. Membership derives from navigation and app fixtures (or explicit ambient nodes). `JourneyClientFor<typeof app>` and
`createJourneyClient(transport)` run one story against loopback or a live device CLI.
`knownInputs: { Node: { Action: [input] } }` supplies exploration cases per node/action.
`includes({ id, quantity })` matches array members without positional placeholders.
`explore(app, { invariants: { Detail: state => ... } })` checks typed focused state;
scenario names are checked for exploration and live serving too.

`session.raw.precondition`, `session.raw.dispatchRaw`, `session.raw.start` and
`session.raw.state`, plus inspectRaw, waits, client.request and operation ids are explicit protocol-level
seams for invalid inputs, cancellation and virtual time. The ordinary story uses definitions.
See [the shared journey](../../examples/inventory/journeys/services.ts).

Focused matching is event-driven. Custom transports can provide subscribe(listener) to
wait for includes matches beyond their initial protocol wait.
