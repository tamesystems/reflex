# 0020. Type-bearing userland contracts

Date: 2026-11-10. Status: accepted.

## Context

The protocol was validated, but application authors reconstructed its contracts in UI
handlers, route mappers and journeys. Store mounts erased input and projected-state types;
Effect UI dispatch could infer an unrelated argument tuple. Existing-router focus also
skipped the capability's lifecycle hook. These costs made the correct integration harder
than a plausible incorrect one. [API principles](../api-principles.md) are the review bar.

This follows ADRs 0003 (core navigation), 0005 (journeys), 0016 (incremental adoption),
0017 (framework-free live serving), 0018 (router adapters) and 0019 (real services).
It supersedes their author-facing setup and export placement where described below;
wire behavior, application-owned persistence and navigation ownership remain intact.

## Decision

Definitions are values retaining state, exact actions, input validation, declared error
and availability. Consumers pass encoded inputs; handlers receive decoded values on both
paths. The secondary Effect node.send method remains an advanced decoded-input operation seam. Both adapters expose a structural NodeHandle with typed `actions`,
subscription, snapshot, availability and disposal. UI actions return discriminated
outcomes; secondary `send` retains correlated argument tuples and returns the same outcome union.
Effect error channels must match a declared schema. Store handlers can `fail` with the
schema's decoded error, validated before publication. Encoded/redacted data is what a
journey observes, never an Error instance reconstructed from the server.

A capability may own params and `initial(params)`. The screen map is a lazy callback, so feature-first imports cannot capture partially initialized definitions. The default navigator derives schemas
and mounting factories from screens. Its direct push/back Effects use a service requirement
independent of the whole screen type graph. Mutual navigation modules need explicit handler
return types to break TypeScript's circular inference; they do not restate route params.
The advanced schema/factory navigator moves to the internal entry.

Expo registers file paths and parameter-name mapping once. Incoming params are validated;
projection and screen lookup share the registration. React owns committed mounts and
history-entry retention. Runtime focus owns both the focus event and `onFocus` activation;
repeated reports are idempotent. `useSession` exposes controls; raw runtime access is an
explicit advanced import. Root exports exclude integration plumbing.

App factories retain scenario names and validate defaults. Effect scenarios compose through
`withScenarios`; store apps own runtime construction, fresh nodes, default focus and disposal.
Custom AppHost remains the escape hatch. Development bridge modules own platform guards;
serveLive owns plain-process serving. Test instrumentation has a development-only dependency
edge, separate from the production entry's component tree.

Journey clients accept definitions. The app's node map controls membership, and typed state
matches narrow captured snapshots. A transport interface runs the same story over loopback
or a live CLI target. Raw dispatch remains explicitly named for protocol testing. Exploration
inputs are derived per node/action, avoiding action-name collisions.

## Consequences

Changing an input or route param breaks consumers at their calls or mapping keys. No-input
actions accept no payload. Narrowed reducers enforce their guard at commit; async handlers
retain the full union at update, so a suspended continuation must recheck its own transition.
Library boundaries contain a few casts for heterogeneous maps and validated wire views;
authors do not repeat JSON schemas or parse their own node state.

The JSON-RPC contract, CLI/MCP implementation, limits and access policies are unchanged.
Protocol-focused tests use raw dispatch. Type-level tests cover invalid and inferred use;
`tsc --extendedDiagnostics` measures the root graph before and after. Existing adapter,
bridge, browser and Hermes tests remain required evidence.
