# 0025. Introduce the store author API alongside legacy hosts

Status: Accepted

## Context

A2 implements the settled store author path without migrating existing host bindings,
journeys or conformance backends. The store adapter already owns publication,
validation, cancellation and revocable handler access; duplicating those mechanisms
would create competing lifecycle rules.

## Decision

Extend `defineStoreNode` with direct Standard Schema inputs and params, inferred
unprojected state, optional JSON projections, `projectError`, and definition-keyed
`withStore` overrides. Author metadata lives under one symbol. Check unprojected
state and transport params at app composition in TypeScript; check actual state at
mount without constructing stores during composition. Store handlers cannot return
navigation commands.

Normalize array-based `screens` and `services` in `store-author-app.ts` to the existing
store app engine. Reject duplicate names, foreign override definitions and required
ambient params. Route factories receive decoded params, including scenario overrides,
and mount screen nodes; services are ambient. Preserve app identity across scenario
extensions. Existing record-based `nodes`/`screens` overloads remain for their consumers.

Expose `createRuntime` and `mountOwned` under `@reflex/runtime/advanced`. Runtime disposal
closes the generation before disposing nodes. Owned handles expose state, changes and
action views with the new outcome vocabulary. They reuse mounted ambient services;
each owned screen mount creates its own store using the session's scenario factory.

Reuse the existing revocable store facade. A suspended handler's extracted methods
check node disposal, runtime closure and cancellation before accessing the store.
Application-owned raw references remain outside that guarantee.

## Consequences

The real-package harness now compiles the exact plain and live-counter author examples.
The live-counter process uses the existing `serveLive`; no new transport is needed.
Plain exposes its service-based composition as `authoredApp` and retains a screen-based
`plainBackend` default for unchanged mobile and live conformance consumers until B.

Legacy callable actions and transformed-error validation remain supported. Existing
transformed-error handlers may pass the validator's input to `fail`; authored handlers
may pass its decoded value and use `projectError` to publish JSON. Explicit projections
continue to require JSON at the node declaration to preserve existing negative tests.
The new advanced handles publish projected error types and convert legacy outcomes;
consumer migration and legacy API deletion remain later steps.

Tests exercise both controllers, including a suspension handshake before reset and
an explicit release afterward, with no stale mutation, notification or publication.
This is A2 of the migration, not a roadmap item.
