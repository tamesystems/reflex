# @reflex/test

Typed journeys and bounded exploration over the real Reflex protocol. The test package
depends only on protocol, runtime and RPC; it loads no Effect runtime or UI framework.

Use `await using session = await createTestApp(app, { scenario })`, or register sessions
with `createTestAppPool()` and pass `pool.disposeAll` to your runner's cleanup hook.
Scenario names and the default scenario come from the app. A shared story can accept
`Pick<JourneyClientFor<typeof app>, "focused" | "back">` to work across scenarios.

`session.focused(Contract, match)` resolves the app's implementation and returns typed
public state and actions. `includes({ id, quantity })` matches array members and checks
field names against their expected element type. `node.state()` reads that exact node
again and rechecks the keys/tag that narrowed it. Match timeouts print the last state.

The node has one actions map:

- `await node.actions.Save()` and `.Save.expectCompleted()` assert completion.
- `.Save.expectError()` returns `{ status: "error", error }` with declared public data.
- `.Save.expectRefusal()` returns `{ status: "refused", reason }`.
- `.Save.run()` returns the public outcome without asserting success.
- `.Save.start()` returns an operation handle with `cancel`, `completed`, `cancelled`,
  `expectError` and `expectRefusal`. Use `completed({ allowCancellation: true })` when
  leaving a screen intentionally cancels work; ordinary completion rejects cancellation.

`session.service(Definition)` and `session.fixture(Definition)` check app/scenario
membership. `node(Definition)` supports either ambient role. `open(Contract, params)`
mounts a store or Effect host-owned screen using the active scenario's route factory.
Effect params are decoded values, encoded through the codec before sending. Store params
use the validator's input type, since a one-way Standard Schema transform has no inverse.
`back()` asserts core Navigation success. `advanceTime(duration)` accepts Duration.Input
values only on virtual-time scenario clients; the protocol's millisecond limits apply.
`const next = await session.reset("other")` gives the new scenario client. Reacquire
handles through `next`; the old client is revoked, and its disposer retains ownership.

`connectJourney(app, { target: "device", scenario })` runs the same story through the
bridge, using the CLI's authenticated target endpoint and `REFLEX_DIR`. It verifies the
remote descriptor before selecting the scenario. Adding test scenarios or fixture nodes
with `withScenarios` preserves its fingerprint. Changed registered actions/input schemas
fail the connection. Disposal closes the journey connection and leaves the remote app up.
The mobile services E2E uses this API without a custom transport.

`explore` is exported from the package root. `inputs: { Node: { Action: [input] } }` and
`invariants: { Node: state => messageOrUndefined }` are keyed and typed by the app. It
checks mounted services as well as focused screens. `steps`, `scenario`, `seed`, and an
async `invariant(session)` are also supported, as in the compiled spec examples. `knownInputs` supplies values that need application-specific knowledge.
Exploration is bounded and shrinks failing walks.
Supply known inputs for store actions that cannot generate samples from their schemas.

`session.raw.request(method, params)` permits malformed requests for protocol tests;
`raw.client` permits typed operation-id requests, and `raw.events` holds bounded event
history from the same connection. Raw dispatch/start/precondition helpers remain for
legacy protocol tests. `@reflex/test/advanced` exports `createProtocolTestSession`, whose
`request` and `events()` isolate that seam, `protocolEvents(journey)`, and the custom
`createJourneyClient(app, scenario, transport)` integration port. Custom transports may
supply `onEvent`; request-only transports poll state matches and do not record events.

See [the shared story](../../examples/inventory/journeys/services.ts),
[ADR 0020](../../docs/decisions/0020-userland-api.md),
[architecture](../../docs/ARCHITECTURE.md) and [development](../../docs/development.md).
