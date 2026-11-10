# 0022. Contract identity and app-bound host bindings

Date: 2026-11-10. Status: accepted.

## Context

Round two separated contracts from handlers, but implementations still had independent
runtime identities and consumers reconstructed app relationships. Same-shape foreign
screens could fill a navigation slot and leave UI lookup waiting indefinitely. A session
hook's optional app argument supplied types without checking the provider. Route mounts
also bypassed scenario overrides and Effect service layers.

This supersedes ADR 0020's host registration/export placement and ADR 0021's implementation
identity, action overloads, fixture-layer metadata, navigation cancellation, journey tag
latching and synchronous-only React Router mounting. Protocol messages, controllers,
CLI/MCP commands, navigation ownership and persistence are unchanged.

## Decision

A screen contract and its implementations share a runtime identity behind the runtime's
`DEFINITION_IDENTITY` symbol. Navigation slots check literal names, encoded state and an
optional explicit identity type. Composition rejects foreign contract objects, duplicate
contract implementations and conflicting app definitions. Journey membership checks runtime
identity too. Calling implement twice does not create two contracts.

TypeScript cannot mint a fresh unique type per function invocation. Ordinary unique names
provide literal identity; authors needing static separation of independently declared
same-name contracts supply `const token = Symbol("Detail")` as `identity: token`. Runtime
identity checks apply whether a token was supplied or not. This requirement is explicit;
structural sameness is never presented as generative nominal identity.

`Nav.implement(screens, { initial })` supplies an app composition value. `defineApp` takes
it as `navigation`, and declares ambient fixtures once as `fixtures`. Scenario layers remain
plain Layers. Custom non-navigation roots retain `root` and `nodes`. Navigator requirements
carry their literal key as `NavigatorRequirement<Key>`. App composition checks retained
navigator-key metadata. Typed contract-navigation roots require that metadata, so an opaque
Layer merge cannot silently erase the check. Internal schema/factory navigation is also
checked when built in the session, since Effect's Layer combinators do not preserve
arbitrary metadata.

Each host binds a real app value: `createReflex`, `createReflexExpo` and
`createReflexRouter`. Their Provider and hooks share that app identity. `useSession()`
checks scenario names and provider identity; no public type-witness hook remains.
withScenarios explicitly retains its parent app identity, allowing a development scenario
extension to serve bindings created from the base app. Independently defined apps have
separate identities, even with matching names and shapes.
`useScreen(Contract)` derives actions from the app's implementation and resolves the
contract's identity. UI modules import contracts only. `useNode` accepts either adapter's
definition. Pending/ready views and `ScreenView<Definition>` remain; router factories also
provide `useScreenSuspense`; Settings in mobile and Detail in web exercise it in the
browser journeys. Binding factories are called once at module scope.

URL registration covers every screen. Param-name mappings have unique targets, checked
statically and at runtime. URL params come from the screen codec, including decoded
numeric values from string codecs. Expo binding/param plumbing is behind `SCREEN_BINDING`
and `ROUTE_MAPPING` symbols. The word routes refers to URL bindings; store apps declare
router-mounted definitions with `screens`.

The session registers route factories. React Router mounts through those factories, so
Effect routes receive the session's service layer and store routes receive the scenario's
store overrides. Store definitions can declare params via `standardInput`. Ordinary React
mounts happen after commit; Suspense resources are session-owned even if React abandons
a render. Retained entries use definition identity, not an ephemeral wrapper's identity.
Normal history retention keeps its existing bounds and forward-entry disposal behavior.

An invocation queues navigation separately from its handler. On successful handler exit,
the node starts queued navigation outside the departing screen's owned fibers and waits
for it before resolving the action. Back therefore completes instead of cancelling its
caller. Handler failure abandons queued navigation. Navigation stack/build failures map
to refused outcomes automatically; actions need no NavigationRefused schema. Param-free
initial routes accept a string. Legacy capability-based navigation builders are removed;
custom schema/factory ownership remains internal.

Only action-builder values may appear in author action maps. Both adapters brand checked
values and reject raw author maps at runtime. Effect actions use one conditional call
signature shared by guarded and unguarded builders. Handler annotations cannot invent a
schema or an error channel. Diagnostic-text tests run the TypeScript compiler and assert
that missing input and error declarations receive actionable text.

Decoded and encoded state remain distinct throughout navigation. Public tuples retain
length and position. Store consumer inputs are transport-safe; rich values belong after
decoding. Store errors accept a Standard Schema validator directly and apply its transforms
before publishing. Only failures validated by that invocation's fail helper publish domain
data. Constructing StoreFailure cannot bypass validation. Tagged domain-error outcomes
distribute over declared tags and carry their corresponding data. A wire failure whose
safe data was omitted cannot claim a typed domain value; local consumers receive a defect.

Journey ordinary actions return completed, and expectFailure actions return narrowed
declared errors. expectRefusal is separate.
Raw precondition/dispatch/start/state live under session.raw. Live state reads recheck only
an explicitly requested discriminant. Focused matching subscribes to transport events
instead of polling; external transports can supply subscribe for matches that must wait
beyond their protocol wait. Exploration inputs are keyed by node then action; invariant
callbacks receive typed public state.

Effect's root exports only definers, the action builder and Infer types. Ownership contracts
and mount live under advanced; fixture write access and sibling plumbing are internal.
React has root and advanced. Expo has root and internal: the plain store integration reads
its development bridge from internal to preserve its Effect-free graph. Live retains root,
session and vite. No vendor-specific Zustand hook is added: the store-definition adapter,
bound useNode and per-session fresh stores/reset already provide the required lifecycle
without introducing another state owner.

Complete TypeScript documentation blocks are compiled by scripts/check-docs.ts in check.
Intentionally partial excerpts must be marked with a reason. Inventory and both host
examples use app-bound bindings; test instrumentation selection lives in the e2e entry.

## Consequences and limits

The instantiation gate remains unchanged at 325,000 plus 10%. New precision and regression
coverage must fit it; this change does not raise the budget. Exact custom JSON-hook types
remain a schema limitation. Explicit unique tokens remain necessary for strict static
same-name identity. Typed contract-navigation roots cannot discard key metadata. Opaque internal
schema/factory Layer composition cannot be inspected before it builds; its fallback
navigator-key check therefore runs at session construction. Existing-router React Router
navigation ownership remains with React Router, as decided in ADR 0018.
