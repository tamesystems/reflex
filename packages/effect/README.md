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
