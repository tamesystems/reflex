# 0017 — Framework-free live serving and React bindings

Date: 2026-11-10. Status: accepted.

## Context

Reflex is an application control protocol. Its core already runs without any UI framework,
but @reflex/expo mixed live serving, React hooks and Expo Router projection. Its default
entry eagerly imported Expo Router private modules, preventing plain React adoption.

This supersedes the package placement in ADR 0008 (device dials out) and ADR 0016
(store adoption); their transport, store, lifecycle and navigation decisions remain.
Earlier ADRs are retained unchanged.

## Decision

Split the former Expo package into three layers:

- @reflex/live owns bridge, LiveController, LiveSessions, SessionOwner and structural
  node-source/UI-action helpers. It imports only protocol, runtime and rpc/connection;
  no React, React Native, Expo, Effect or Node APIs. WebSocket comes from the host.
- @reflex/react owns ReflexProvider and generic node/session/focus/state hooks. Its generic
  useRouteNode takes explicit stack/token/params, rather than reading a router. Route
  binding is pure. React is the only UI dependency. /effect adds capability lookup.
- @reflex/expo owns RouterProjection, pure projection rules/controller, core port, private
  router events and Expo route-param hooks. /effect retains the convenient Expo-aware
  capability hook; no compatibility facade restores the generic provider exports.

The live root exports connectBridge for plain processes. UI bindings use /session, whose
exports exclude bridge.ts, because Metro includes barrel exports without tree-shaking.
Expo apps load the live root and read EXPO_PUBLIC_REFLEX_BRIDGE only inside **DEV**.
Production bridge/token exclusion and the plain screen's Effect-free Metro graph remain
acceptance checks. A browser bundle test also rejects framework and bridge imports from
the generic React entry. Boundaries tests enforce the new dependency rules.

## Core audit

Audited protocol, runtime, rpc, cli, test and effect source imports and mobile vocabulary.
None depends on React, React Native or Expo. Fixed the bridge-disconnected CLI guidance,
which previously prescribed EXPO_PUBLIC_REFLEX_BRIDGE for every app: it now points to
connectBridge(appSetting), with Expo's setting as an example. Generalized CLI/MCP live
connection descriptions and the bridge contract's introduction. No wire change.

The following remain deliberately unchanged:

- `device` is the CLI/MCP target and on-disk transport/token prefix, including for server
  processes. Renaming adds migration cost without enabling behavior.
- NodeType is screen/navigation/service/fixture, with screen actions focus-gated and
  focused-first default dispatch/inspect. Service and fixture nodes already support
  applications without screens, focus or navigation. Renaming/extending the wire union
  requires a separate compatibility decision and consumer evidence.
- `ls` and the follow-up `do.now` summarize the focused node and ambient actions. With
  no focus their state is null; `tree` exposes service state and named waits work. Adding
  CLI named inspection is useful future work, outside this split; MCP already has it.
- The test SDK's precondition(screen, match) expresses focused-node expectations. Generic
  named state waits remain available; broadening that convenience API needs separate design.
- Effect capabilities default to screen; defineNavigation owns a Navigation node, scopes,
  routes, GoBack/Navigate and focus/onFocus semantics. These are optional conveniences;
  changing defaults or replacing the navigation model risks existing apps.
- Some examples and UI-specific diagnostics speak of screens, taps, gestures and devices.
  These remain appropriate for their optional UI/navigation functionality.

Expo-specific behavior remains route-file mapping, reflexNode route-param extraction,
Expo Router's private accepted-action events, and reconciliation of gestures/deep links
with the optional core-owned stack. No generic React hook imports these adapters.

## Evidence and consequences

examples/live-counter mounts a service node with mountStore in a plain Bun process.
It has no React, React Native, Expo, Effect, router, focus or store-library dependency.
A process test starts the bridge daemon out of process, launches that app, and uses real
CLI --target device invocations to inspect schemas/tree, dispatch, wait and reset. Reset
must restore state and change handles. It runs in check on Ubuntu and Windows CI.
Keeping the daemon outside bun test avoids the known in-process WebSocket frame corruption.
The process API also supports Node 22+'s global WebSocket; direct TypeScript execution
requires a suitable Node release or loader. Node execution is not separately exercised.

Consumers now choose layers explicitly. Expo inventory screens can keep the Expo-aware
/effect hook; providers and generic store screens import @reflex/react. The core/wire,
controller method coverage, peer limits and CLI/MCP command ownership remain unchanged.
