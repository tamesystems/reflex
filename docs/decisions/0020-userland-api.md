# 0020. Userland contracts, composition and app-bound consumers

Date: 2026-11-11. Status: accepted.

## Context

The protocol and runtime already support headless and live control, but the original
application API made consumers reconstruct relationships between definitions, actions,
routes and scenarios. Three review rounds and the additive A1–C migration settled the
[implementation contract](../design/userland-api.md). This record consolidates the
unmerged 0020–0028 drafts; those drafts are not historical merged decisions.

## Decision

Definitions carry state, action inputs, declared errors, guards and identity. Consumers
pass encoded inputs and observe detached, deeply frozen, encoded/redacted JSON. Handlers
receive decoded inputs and retain their app's state model. Author phantom metadata lives
under a symbol. Runtime lookup checks exact definition and constructor identity;
TypeScript's structural type system cannot mint a unique type for each factory call.

Effect screen contracts use `class Detail extends Screen("Detail", spec) {}` before
implementations import navigation. `.implement` attaches handlers; `Screen.define` is the
one-step, no-params form. `defineService` declares ambient production nodes and
`defineFixture` declares scenario-local state access and controls. Only builder values
belong in action maps. `action.when(tag)` narrows guards and rechecks state at commit.
State access is revoked with its owner, including during finalization and cancellation.

Navigation consumes contracts, then `Nav.implement([definitions], { initial })` supplies
the app composition. `action.navigates` returns a terminal `Nav.push`, `Nav.back` or
`Nav.stay` command. Handler scopes finish before navigation; back completes without
cancelling its caller. Refusals remain refusals after optional state recovery. Runtime
command tracking diagnoses discarded and foreign commands. Fixtures, common layers,
scenario layers and handlers build in that order; no layer satisfies its own inputs.

Stores use `defineStoreNode({ name, store, actions, params?, project? })` with direct
Standard Schema validators. JSON state needs no projection; rich state requires a safe
public projection. `standardInput(validator, jsonSchema)` supplies a wire schema for an
opaque validator. Declared errors provide `fail`, with `projectError` for decoded rich
errors. `defineStoreApp({ name, screens, services })` checks names, roles and public JSON.
Scenarios override definitions with `stores: [Counter.withStore(factory)]`. Fresh stores
belong to each session. Invocation facades revoke extracted methods before abort listeners
run; raw stores independently retained by the app stay application-owned.

`createReflex`, `createReflexRouter` and `createReflexExpo` bind one app at module scope.
The bound Provider owns sessions and development bridge lifetime. `useScreen` suspends;
`useScreenStatus` exposes pending/error/retry and acquires only at commit.
`from(Definition)` narrows repeated selector/action hooks independently of app size.
`useService` handles ambient definitions. `withScenarios` preserves app identity.
Session controls reject stale generations after reset.

React owns a single route registry per session for host preparation, status hooks and
Suspense. Abandoned resources remain bounded and are disposed on reset; late mounts are
disposed after cancellation. History retention uses host entry identity, with the existing
64-entry protocol budget and forward-entry disposal. Registration is total over screens,
checks encoded string params and unique mappings, and derives contract Link/href. Custom
`routeCodec` owns excluded grammar and array policies. React Router owns its navigation;
Expo projects core Navigation when present and supports host-owned store routes otherwise.
Sibling adapter plumbing uses internal entries, separate from root and advanced author
exports. Expo's development helper and the host-neutral live helper are Effect-free.

Typed journeys derive membership, scenarios, inputs and matches from the app descriptor.
Each node has one action map: ordinary calls assert completion; `run`, `expectError`,
`expectRefusal` and operation handles expose deliberate alternatives. Reset returns a new
client and revokes old handles; the original disposer retains ownership. `connectJourney`
uses the CLI's authenticated endpoint. Descriptor fingerprints detect structural drift,
not behavioral equivalence or authorization. Raw protocol tests use the explicit raw seam
or the advanced protocol-session helper. Exploration inputs are keyed by node and action.

The production entry uses offline services unless a development API setting is explicit.
E2E instrumentation extends the same app identity in a separate selected module; normal
production imports exclude test scenarios, instrumentation, bridge code and tokens.

### Relationship to merged decisions

- **0002, 0004:** supersedes the Effect capability author surface and mutable/decoded
  consumer views; preserves the Effect-free runtime and plain listener-based registry.
- **0003, 0005, 0010:** supersedes navigation author setup, manual router registration and
  navigation self-cancellation; preserves core navigation ownership, Expo's private-action
  observation, scoped screen work and accepted-versus-completed wire operations.
- **0011:** extends fail-closed redaction with detached/frozen publication and declared
  public error outcomes; encoded state and error data remain the public boundary.
- **0015, 0016:** supersedes store author setup and manual projection wrappers where JSON
  state and Standard Schema are sufficient; preserves explicit actor completion semantics,
  safe projection and application-owned persistence.
- **0017, 0018:** supersedes unbound React hooks/providers and public sibling plumbing;
  preserves framework-free live serving, router-neutral projection and host-owned React
  Router navigation.
- **0019:** supersedes service wiring at the author surface; preserves app-only HTTP and
  device storage, explicit settings and persistence across session reset.
- **0001, 0006–0009, 0012–0014:** retains transport, resource bounds, authentication,
  dial-out bridge, CLI/MCP reuse, access policies and hand-written wire decisions.

### Deviations and limits

Store journey `open` takes encoded validator inputs because Standard Schema provides no
inverse for arbitrary transforms. Effect params remain decoded and use bidirectional
codecs. Duration inputs are structurally compatible with Effect while the test package
stays Effect-free. Fingerprints use public declaration schemas; store projections have
no complete public state/error schema and projected errors are marked opaque.
`app.open` is an additive control method implemented by both controllers using existing
protocol budgets; this cleanup does not change the protocol package.

TypeScript 5.9 needs one-step builders to use inferred codec state directly, and the
omitted-scenarios overload to infer the whole spec before checking layer coverage.
Readable diagnostic properties also carry a fixed `Reflex type error` property so
widened names cannot bypass checks through template index signatures. Exact runtime
identity remains necessary for structurally identical contracts and empty subclasses.

The command-erasure lint rule remains deferred: TypeScript permits `Effect<void>` to
erase a navigation command, and discarded expressions need runtime diagnostics. Custom
JSON hooks cannot always describe exact wire types; use an explicit `jsonCodec`.
Core-owned React Router projection remains a separate roadmap item under 0018.

### Type-performance gates

Bun 1.4.4 and TypeScript 5.9.3 are pinned. Root instantiations must stay at or below
505,132 (459,211 baseline plus 10%, rounded down). This cleanup does not raise the budget.
The real-package heterogeneous 100/200/400-screen benchmark permits at most 25 ms per
added screen with one hook and 5 ms per additional narrowed hook. Before cleanup, B2
measured 1.05/1.72/3.29 s check time, slopes 6.70/7.85 ms per screen and at most 0.050 ms
per additional hook; instantiations were 561,961 / 1,189,761 / 2,865,361. Timings depend
on the machine; instantiation counts are the stable root gate. Maintainer commands and
current measurements belong in [development.md](../development.md), not scratch reports.

## Consequences and retained internals

The ordinary API follows one definition into UI and journeys without hand-written
consumer generics. All 16 specified root, advanced and dev entries have exact type/value
export-name equality with the declarations, enforced by the real-package harness.
Runtime store compatibility exports, the string-based test facade, test scheduling
helpers and the old Effect/React/Expo author exports are absent from these entries.
The public test factory accepts authored descriptors only. Its pool has no low-level
open method. Authored regressions use descriptors, action-level error/refusal assertions
and reset generations. Shared journey contracts and structural duration inputs live in
runtime so live/test consumers share types without upward package dependencies.

Protocol limits, both controllers, bridge behavior, CLI/MCP reuse, conformance and
experiments are preserved. Store composition has one array/override path; expected store
errors originate from a declared action's checked fail helper. Effect composition has
one author implementation over the internal session engine. Explicit Effect ownership
uses scoped mountEffect. Definition/scenario extensions preserve stable identity.

The original 7,600-source-line allocation is no longer a landing requirement. Current
physical source lines (all files recursively under each package's src, including entry
files, comments and shared types) are:

| Package      | Source lines |
| ------------ | -----------: |
| effect       |        3,780 |
| runtime      |        4,013 |
| react        |        1,115 |
| expo         |          766 |
| react-router |          290 |
| live         |          833 |
| test         |        1,595 |
| Total        |       12,392 |

The gap from the original allocation is 4,792 lines. It is retained implementation
cost, not a claim that the planning target was met.

Mounting, state publication/encoding/redaction, scoped navigation, registry bounds,
session lifecycle, route retention and protocol-backed journeys remain necessary runtime
behavior. Removing these to reach the line target would weaken the contract. The
following specific shrink candidates remain follow-up work requiring coordinated fixture
migration and type changes:

- capability.ts retains the internal capability/action builder, guard/reducer and state
  access paths. author-screen.ts and author-actions.ts adapt authored definitions to it;
  collapse the legacy capability and action branches into the authored representation.
- Consolidate guard and decoded-dispatch paths: dispatchDecoded, ActionArgs/SendArgs,
  OwnedLiveNode.send and its decoded-input encoding branch still support low-level tests.
- Consolidate consumer-type branches (PublicState, action arguments/errors, coverage and
  navigation requirements) with the authored encoded consumer model. LiveNode remains a
  sibling contract, not an ordinary author export.
- Port the deliberately malformed capability/schema-navigation fixtures in
  test/lifecycle.test.ts and packages/effect/test/capability.test.ts before removing
  their private builders. Their failure, focus, cancellation, encoding and resource-limit
  assertions must remain. The private test loopback/exploration engine remains for these
  raw host fixtures and bounded shrinking; it is not a public string API.
- Consolidate the private Expo URL-binding fixture path with the bound registration
  implementation. Sibling session/route integration entries remain internal plumbing.

These changes are deferred because they require a substantial internal refactor; public
surface parity and behavioral acceptance, rather than further internal shrinking, define
this landing. The command-erasure lint rule and core-owned React Router projection remain
explicit follow-ups. No report or module inventory file is part of the maintained API.
Maintainer validation commands and performance budgets live in development.md.

## Acceptance evidence

On Bun 1.4.4 / TypeScript 5.9.3, `bun run check` passes: 688 tests, four
platform/device skips, all three typechecks, documentation examples and all 16 export
sets. Root instantiations are 495,490 under the unchanged 505,132 ceiling.

Mobile e2e, e2e:plain, e2e:live and e2e:services and web e2e pass, including
production bridge/token/instrumentation exclusions, the plain Effect-free graph, and
HTTP/AsyncStorage persistence across reset/reload. The live run required one retry
after Metro's selected port was occupied. Frozen installs at root/mobile/web pass.
Both declaration and real-package harness performance modes pass: maximum added-screen
costs are 5.8 and 6.8 ms, respectively, below 25 ms; additional narrowed hooks cost at
most 0.067 and 0.089 ms, below 5 ms. Timings are local measurements, not new budgets.

The protocol package and CLI/MCP implementation are unchanged by this final cleanup.
The six Ubuntu/Windows check, browser and Hermes jobs remain the remote landing gate.
