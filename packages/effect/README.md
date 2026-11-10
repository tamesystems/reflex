# @reflex/effect

Optional Effect v4 integration for application cores.

## Responsibilities

Capabilities, scoped nodes, typed actions, redaction, scenarios/Layers, virtual time and optional core-owned navigation.

## Does not own

Rendering, Expo routing, transports or CLI commands.

## Start reading

1. `src/capability.ts`.
2. `src/app.ts`.
3. `src/navigation.ts`.
4. `src/redaction.ts`.

## Important invariants

Runs on any JS engine; imports protocol/runtime and Effect only. State writes go through StateAccess. Navigation entries own scopes, so popping cancels their work. The default screen type is focus-gated; service nodes need no navigation.

See [architecture](../../docs/ARCHITECTURE.md) and [development](../../docs/development.md).

## Author API

A capability owns state, actions, optional params/initial and onFocus. The contextual action
builder infers inputs, services and declared errors. `action.when(tag).reduce(...)` narrows
synchronous reducers; async handlers recheck the full union in update. Nodes expose typed
action functions and the same NodeHandle shape as stores.

`defineNavigation(key, () => ({ List, Detail }))` derives screen mounting and route schemas;
`Nav.push("Detail", params)` and Nav.back are Effects ready for handlers. `defineApp`
retains scenario literals and composes with `.withScenarios`. Register `nodes: Nav.screens`
for typed test membership. Navigation handler return annotations break mutually recursive
module inference without reconstructing route params.

Fixture/service owners can use `mountWithAccess` to retain the sole state write path.
Registry, encoding, redaction and capability lookup helpers are under `/internal`, together
with the advanced schema/factory navigator. Roots expose author APIs. See ADR 0020 and
[adopting](../../docs/adopting.md).
