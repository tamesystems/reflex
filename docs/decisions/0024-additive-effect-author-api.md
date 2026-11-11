# 0024. Introduce the Effect author API alongside legacy consumers

Status: Accepted

## Context

The settled userland contract separates screen contracts, implementations, terminal
navigation commands, production services and scenario-local fixtures. Existing
journeys and UI bindings still consume AppHost and legacy node handles. Replacing all
consumers at once would make the implementation and its evidence difficult to review.

## Decision

Implement the Effect author tier in `author-*.ts`, reusing capability mounting, the
registry, scoped navigation and legacy AppHost lifecycle. Keep the legacy overloads
until their consumers migrate. Pack author-only phantom types under one symbol.
Each action owns a child scope. Navigation commands execute after the handler exits;
a pop cannot cancel the completed handler. Track issued commands through the Effect
fiber context so discarded commands produce diagnostics. Preserve refusals in the
existing protocol operation representation and consumer outcome conversion.

Compose fixtures, common layers, scenario layers and handlers in that order. Mount
fixture state before layers build and bind fixture action handlers to the final
services without replacing their invocation context. Normalize fixtures per scenario
before extending an app so new defaults cannot change old scenarios.

Expose `legacyApp` only from `@reflex/effect/internal`. It returns the AppHost and its
mapped definitions for old journeys and UI bindings. The CLI recognizes the same
symbol-keyed host adapter without importing Effect. Inventory's production entry
uses offline services; its scenario entry exposes a compatible host for current tests.
The production import-boundary test continues to reject HTTP and device storage;
its filename matcher now distinguishes inventory's in-memory settings module from
mobile's persistent settings module.

## Consequences

Inventory uses the authored API while other Effect applications retain their APIs.
Inventory feature and screen aliases remain for mobile until its consumer migration.
The exact extracted inventory author examples compile against the real package as
part of `bun run check`; the declaration harness remains evidence for later tiers.
New runtime tests cover both controllers' author diagnostics, ordered layers, fixture
isolation, codecs, guards and terminal commands. The added graph has an audited type
budget in `docs/performance/userland-api-a1.md`.

This implements A1 of the design migration, not a roadmap item. New consumer APIs,
store integration and deletion of the legacy surface remain later steps.
