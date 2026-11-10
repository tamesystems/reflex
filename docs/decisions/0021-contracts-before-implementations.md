# 0021. Contracts before implementations

Date: 2026-11-10. Status: accepted.

## Context

ADR 0020's lazy screen map avoided module initialization failures but preserved a
TypeScript inference cycle: handlers imported navigation, whose type depended on those
handlers. It also left independent guard subscriptions coupled to public projections,
and journey action outcomes could be ignored without failing a test.

## Decision

This supersedes 0020's lazy navigation setup, handler return annotations, captured
journey state, consumer disposal, secondary root dispatch, and unbounded router retention.
The protocol, CLI, MCP and core navigation ownership are unchanged.

`defineScreen({ name, state, params, initial })` establishes the contract in a module that
imports no implementations. `.implement({ actions, onFocus })` attaches handlers.
`Screen.handler` and `Screen.when(tag).handler` infer shared helper arguments. Navigation
is built from the contract map; `Nav.layer({ screens, initial })` supplies implementations
at app composition. Push argument tuples remain correlated, and service requirements
include the navigator's literal key. Navigator keys must be unique within an application.
The old lazy definition builder is an advanced compatibility entry only.

Schema presence has separate action overloads. Missing input is an unusable handler
parameter and a zero-argument consumer call; declared `unknown` remains a real argument.
Only declared store errors expose `fail`. Focus hooks have no error channel: handle
expected load errors into state; unexpected focus failures are reported as defects.
Guarded updates receive narrowed state and recheck the tag at commit. `state.when(tag)`
selects a different transition phase after suspension, as saving does in inventory.

Effect handles publish encoded/redacted state just like protocol journeys. Handlers keep
decoded state. Store projections are constrained to JSON and deeply readonly snapshots.
Built-in JSON derivation includes BigInt strings. Custom schema JSON hooks remain a
precision limitation; explicit JSON codecs are preferable for custom representations.

`node.actions` is the ordinary dispatch path. Local defects and domain failures report
through the runtime even when event handlers ignore the promise. `LiveNode` has neither
`send` nor disposal. Advanced `dispatchDecoded` and `mountOwned` serve integration owners.
Store mounts still own their store subscription; structural `NodeHandle` consumers do not.

React's composed view has `status`, `state` and per-action `run`, `available`, `reason`,
`pending`. The pending variant makes mounting after commit explicit. Ambient `useNode`
and adapter `useScreen` return the same view. Granular hooks remain. React Router reports
entry identity and match focus in one hook. React owns retained entries, discards forward
entries made unreachable by a new push, and bounds retention at 64. Older evicted entries
are recreated on return. React Router currently requires a synchronous mount definition;
a service-layer-backed Effect route mounting adapter remains future work.

Navigation layers declare their mounted implementations as metadata. Scenario service
layers declare fixtures with `withNodes`; `defineApp` derives membership from both.
Explicit nodes remain supported for non-navigation roots. An omitted map is empty, never
unrestricted. Store apps distinguish ambient `nodes` from router-mounted `routes`.
Definition names carry literal type identity; independently-created definitions sharing
an identical name/shape are not generatively nominal in TypeScript. Runtime resolution
still checks definition object identity. This remains short of the requested static
identity guarantee.

Expo registration checks URL string encodings, encoded key mappings and pathname
placeholders. Number URL fields use `NumberFromString` with appropriate domain checks
(such as `isFinite`). Optional-only params still require mappings; omitted query values
are omitted on output. Invalid known inbound routes throw `InvalidRouteParams` with
route, raw params and cause. Projection mapping functions live behind a sibling-only
symbol and do not appear on the consumer route surface.

Journey actions fail fast, including cancellation unless explicitly allowed.
`expectFailure.Action()` requires a refusal/domain failure; `allowCancellation.Action()`
allows a navigation action to cancel itself. `state()` reads the exact node live and
checks that a previously-proved tag still holds. `includes(...)` matches array members
locally without extending the wire protocol. Exploration has per-definition typed
invariants and checked scenario names. Protocol probes live under root test/, rather
than teaching examples.

## Consequences and limits

The inventory contract and feature files need no state or handler-return annotations.
Changing action input or route params propagates into UI, typed stories and mappings.
Root, mobile and web typechecks run in `check`. Root instantiations are measured and
capped by `scripts/type-budget.ts`; a 10% margin above the recorded budget fails CI.

Some review requests remain incomplete: generative static definition identity, precise
custom JSON-hook types, decoded/encoded store error transforms, fully inferred plain
store action literals, typed conditional back availability, a bound Zustand store reset
adapter, and Effect service-layer route mounting for React Router. No factor is claimed
to meet 9 while these gaps remain. This ADR records the shipped behavior, rather than
asserting the entire redesign is finished.
