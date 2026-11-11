# 0020. Userland contracts, composition and app-bound consumers

Date: 2026-11-11. Status: accepted; implementation cleanup in progress.

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

## Consequences and implementation status

The ordinary API follows one definition into the UI and journeys without hand-written
consumer generics. Explicit ownership and host entries keep framework and transport
boundaries intact. Protocol, controller parity, bridge, CLI and MCP coverage must remain.

A1–C implement the authored paths. The first D cleanup removes the unbound React surface,
legacy React hooks and unused Suspense adapters, and aligns all six React/React Router/
Expo root and advanced export-name sets with the declarations. The real-package harness
checks those sets, including type-only exports. Sibling integration imports move to the
React internal entry; Expo gains its specified advanced entry. No experiment is deleted
in this partial cleanup.

Source lines in the first D cleanup (all files under each package's src):

| Package      | Before |  After |
| ------------ | -----: | -----: |
| effect       |  4,096 |  4,096 |
| runtime      |  3,727 |  3,727 |
| react        |  1,258 |  1,115 |
| expo         |    861 |    766 |
| react-router |    290 |    290 |
| live         |    821 |    821 |
| test         |  1,889 |  1,889 |
| Total        | 12,942 | 12,704 |

D remains incomplete: the Effect/store/test legacy paths and their internal test,
conformance, benchmark and experiment users still need migration and deletion. The
7,600-line target and full-package export equality remain acceptance requirements, not
waived deviations; the remaining 5,104-line gap reflects unfinished cleanup, not evidence
that the final budget is impossible. The implementation branch must not land on
`userland-api` until these and every required verification pass. The spec remains
explicitly in progress. This status is narrower than the final design decision.

### D2 store and conformance cleanup

The store composition now accepts only the authored screen/service arrays. Its internal
host builder no longer has the eager-screen branch or a second scenario extension
implementation. Store mounting is private to definitions; the exported raw mount helper
and throwable failure constructor are removed. Expected errors can originate only from
a declared action's validated `fail` helper. Store regression tests now build definitions,
including limits, invalid publication, cancellation, extracted methods and late writes.
The builder already checks action inputs and brands its results, so the duplicate mapped
handler check is removed. Overlapping store type cases are consolidated in the store
author suite, retaining encoded-input, declared-error, scenario and override checks.

The conformance Effect app uses Screen and contract navigation; the large-row benchmark
uses a service reducer. The production plain example no longer exports a compatibility
screen host. A test host opens its declared store screen through the session route factory.
All five conformance backends use the wire client directly, with event recording beginning
after startup. This retains malformed input, state, revision, wait and access-policy
assertions independently of the old TestApp facade. The external-focus regression uses
an authored Effect screen and the session's route factory. No experiment is deleted.

This is a partial item 1 checkpoint. Effect/test/Expo legacy deletion, remaining consumer
migration, complete declaration parity, the source budget, final docs audit and full
acceptance still block landing. The protocol and CLI/MCP implementations are unchanged.

Source lines after this partial D2 checkpoint (all files under each package's src):

| Package      | D start | D2 checkpoint |
| ------------ | ------: | ------------: |
| effect       |   4,096 |         4,096 |
| runtime      |   3,727 |         3,671 |
| react        |   1,115 |         1,115 |
| expo         |     766 |           766 |
| react-router |     290 |           290 |
| live         |     821 |           821 |
| test         |   1,889 |         1,889 |
| Total        |  12,704 |        12,648 |

These counts do not justify an exception to the final budget: most legacy Effect/test
machinery still remains. A final per-package budget assessment is premature.

### D3 Effect checkpoint

The Effect root and advanced entries now equal their target declaration export names,
including types. The harness checks all eight Effect/React/React Router/Expo entries.
The old screen module, string-keyed contract navigation, public capability/action and
mount exports, consumer lookup wrapper, Effect inference aliases and author-host adapter
are removed. App composition and scenario extension now have one author implementation;
the internal host engine handles session lifetime without a second composition path.
Explicit advanced ownership is implemented by scoped `mountEffect`. Authored descriptors
and their scenario extensions now expose the same stable definition identity as their
internal hosts.

[The module/export inventory](../design/effect-cleanup.md) classifies all source modules
and exports, including what remains. Round-three behavior and type tests use Screen,
terminal navigation and implementation arrays. Route codec, encoded-input, exploration,
RPC/bridge and UI reporting fixtures also use authored definitions. Their limits,
cancellation, event, wait and refusal assertions are retained. Advanced ownership tests
cover dependencies, focus, encoded publication/errors, change notifications, pending
work, explicit and scope disposal, independent owners and resource refusal. No experiment
was deleted.

| Effect line count                        | Before D3 | After D3 |
| ---------------------------------------- | --------: | -------: |
| All `src/*.ts`                           |     4,096 |    3,788 |
| Entire package, excluding `node_modules` |     6,022 |    5,813 |

This is a green partial checkpoint, not final Effect acceptance. Remaining work is
specifically the internal capability/action builder and legacy type branches in
`capability.ts`, their adapters in `author-screen.ts` and `author-actions.ts`, and the
low-level capability/schema-navigation fixtures in `test/lifecycle.test.ts` and
`packages/effect/test/capability.test.ts`. Port those fixtures before removing their
internal exports, then reduce the remaining state guard, action, coverage and navigation
types to one representation. Shared mounting, registry, redaction and scoped navigation
are runtime behavior and must be preserved. The full source budget and the other
packages' remaining export cleanup still block final landing. Protocol and CLI/MCP
implementations are unchanged.

D3 verification: `bun run check` passes (688 tests passed, four platform/device skips),
with 486,449 root instantiations under the unchanged 505,132 ceiling. Both declaration
and real-package harness performance modes pass. Mobile `e2e`, `e2e:plain`, `e2e:live`,
`e2e:services` and web `e2e` pass; the final services run needed a retry after Metro's
chosen port was occupied. CLI/MCP process, access-policy and both-mode conformance
suites are included in the green check.

### Public entry parity

All 16 specified root, advanced and dev entries have exact type/value export-name
equality with the declarations, enforced by the real-package harness. Runtime store
compatibility types, the string-based test facade and test scheduling helpers are no
longer root exports. The public test factory accepts authored descriptors only and its
pool has no low-level open method. Authored regressions use descriptors, action-level
error/refusal assertions and reset generations. Deliberately malformed host/lifecycle
fixtures retain the private loopback engine; their assertions remain intact. Shared
journey contracts live in runtime to preserve dependency direction.
