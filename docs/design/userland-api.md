# Reflex userland API specification, revision 3 (implementation contract)

Status: Effect author tier implemented in A1; consumer and store tiers remain proposed.
Revision 1 baseline: `9debc24` on `origin/userland-api-spec`. Rubric:
[api-principles.md](../api-principles.md). Architecture, protocol/controller parity,
access policy and dependency boundaries remain authoritative. A1 is recorded in [ADR 0024](../decisions/0024-additive-effect-author-api.md). It does not
implement a roadmap item. The remaining consumer migration is not claimed by A1.

## 1. Reading and verification contract

The normative callable surface is [prototypes/api/](prototypes/api/), a declarations-only
API for each package's root and advanced entry. Every named export is explicit; the
shared model is declaration plumbing, not a public package entry. Importing these
files cannot run an app. They deliberately do not map to the current package sources.
The authored files in section 4 are exact copies of
[prototypes/examples/](prototypes/examples/), compiled together against these declarations
and the installed **TypeScript 5.9.3**, Effect 4.1.2, Zod, Zustand, React, Expo and React
Router types. The JS Metro file is checked with `checkJs`; JSON files are configuration,
not TypeScript programs. The mobile tsconfig describes future package paths; the
executable-spec tsconfig substitutes target declarations without touching those packages.

Run `bun docs/design/prototypes/check.ts`. It checks example/spec drift, invokes tsc,
checks target declaration bodies (excluding upstream dependency diagnostics by path),
asserts each negative marker at its **file and next-line location**, rejects unexpected
diagnostics, checks that every public value export is exercised by an example, and measures the
0/100/200/400-screen graph with 0/1/10 hooks per screen.
Normal examples use skipLibCheck, matching the repository. The separate body check
turns it off: errors in dependencies do not become evidence against our declarations,
and errors in our declarations cannot be hidden. No positive example uses `any`,
`@ts-expect-error`, internal package imports, or a double cast. The deliberate compiling
counterexamples are isolated in `static-limits.ts` and identified as such.

A **verified** statement means a successful compilation or asserted diagnostic in that
harness. A **runtime obligation** means required future behavior with acceptance steps,
not a passing test against an imaginary implementation. **Unproven** means the proposed
surface or policy still lacks executable evidence. Runtime obligations are listed
separately from the executable misuse table, rather than misrepresented as tsc failures.
The repository check now invokes the real-package inventory mode. The full declaration
harness remains a separate check for consumer and store tiers that have not migrated.

## 2. Core model and decisions

1. **Contract and implementation identities stay separate.** `Screen(name, spec)`
   produces a base constructor; a class contract carries state/params and `.implement`
   returns a separate frozen definition with actions/requirements. A session selects
   implementations. UI and navigation accept contract values, never implementation
   names as strings. Implementations do not have `resolve` or carry a global selection.
   A one-step `Screen.define(name, {state, initial, actions})` returns a combined
   constructor/implementation when there is no implementation selection. It has the
   same app-bound consumer API. Its identity is still its actual runtime constructor.
2. **Structural types, exact runtime identity.** Contracts need no hand-written private
   nominal field. TypeScript classes and stores are structural; a subclass or an independently
   declared same-shape contract can be statically assignable. Registration and lookup use
   exact constructors/definition objects, never prototype ancestry or names. Composition
   rejects duplicate declared names, including navigation screens versus ambient services.
   Runtime errors name the declared contract and explain how to register it. The limit is
   demonstrated in static-limits.ts; no static nominality is claimed.
3. **One role model.** Both Effect and store apps compose `screens` and `services`;
   Effect apps with core navigation select `navigation` instead of `screens`.
   `useService(Definition)` reads an ambient session-owned service in every host.
   `useScreen(Contract)` reads a route-owned screen in every host. No `useNode` alias.
   Store definitions acquire their role from composition; their stores remain idiomatic
   stores. Arrays are checked for duplicate names, including screens/services collisions.
   Runtime validation covers widened arrays and fixture collisions too.
4. **Navigation record form is retained.** `defineNavigation({ InventoryList,
   InventoryDetail, Settings })` checks record keys against declared names, avoiding
   duplicate keys and aliases. Implementations remain a tuple because selection has no
   redundant name keys; its small Unique check rejects duplicates and reports missing
   contracts. An app must select exactly one implementation per contract, with no extras
   (the extra-implementation identity check is a runtime obligation). One session owns
   one route registry across normal hooks, Suspense and navigation preparation.
5. **Commands are returned, never yielded.** `Nav.push`, `Nav.back`, `Nav.stay` are data.
   `action.navigates` returns a bare `NavigationCommand` or `Effect<NavigationCommand>`; a missing return, discarded
   command or an `Effect<void>` helper in this tier fails compilation. `action` and
   `onFocus` infer success/error before checking: visible command successes produce
   `Use action.navigates for actions that navigate`; undeclared errors produce
   `Declare action failures with error:`; lifecycle errors produce
   `Handle onFocus failures into state`. The declared error field is `error`, the outcome
   status is `"error"`, and journeys use `expectError`. No command is an Effect or has
   `pipe`; `yield* Nav.back` produces **TS2488**, with no invented custom diagnostic.
6. **Static erasure is real.** TS permits an Effect command to be widened to `Effect<void>`
   and accepts unused expression statements in a plain action. Types cannot recover this.
   A command-erasure lint rule is explicitly follow-up work, not a shipped part of this
   revision. It must cover command expressions, void-returning helpers and yielded commands. Runtime tracks command creation by operation: exactly
   one command must be returned for a navigating action; unused/multiple commands are
   defects, even if hidden by void. Commands made outside an invocation cannot be
   dispatched. A plain action or onFocus returning a hidden command is a defect, not
   silently ignored. Service and fixture actions cannot navigate: inferred direct
   commands get the same plain-action marker, and composition/runtime rejects navigator
   requirements or hidden commands from those roles. Service/fixture builders omit navigates entirely; a negative fixture case
   checks the missing method, while runtime checks cover hidden commands.
7. **One terminal command per action.** `Nav.stay` explicitly chooses no transition.
   `onRefused` is void-only, cannot fail except `StateChanged` converted by the builder,
   and cannot navigate. Multi-step flows become separate actions with state transitions,
   or one action that performs all domain I/O and returns its final destination.
   Redirect-on-refusal becomes a refused state plus a separate redirect action; a journey
   can await refusal and drive that next action. Navigation is not an imperative service.
8. **Correlated arguments.** `push` infers the target first and checks params with
   NoInfer against that target. It does not print the union of every screen on an input
   mismatch. `href` accepts a union of complete tuples. Initial routes are
   a union of whole `{screen, params}` objects or a param-free contract. `Link` props are
   likewise a union. Narrow a union target first, or carry the entire correlated tuple.
   Navigation and initial routes take **decoded** params. href, Link and advanced URL
   codecs consume **encoded** params; NumberFromString therefore takes a number for
   push and a string for href. No params means zero arguments, not `{}`.
9. **Store inference and codecs.** `StateOf<T>` derives the return of getState, never
   infers state from `T extends Store<S>`. NoInfer prevents project/availability/builders
   from changing it. Destructured parameterized factories infer their params directly
   from the validator. JSON-state checking occurs at composition, naming the store and
   suggesting project; it does not intersect the factory spec and break param inference. Infer the whole Effect codec or Standard Schema validator; use
   decoded output for handlers and encoded input for consumers. Standard Schema only
   validates: it cannot invert an arbitrary transform. Transformed store errors require
   projectError to explicitly encode their decoded domain error; the codecs example does
   so. An automatic inverse for Standard Schema is **unproven and not promised**.
   Opaque validators use standardInput(validator, jsonSchema), including for error and
   param validators. Effect codecs have their own encode operation. jsonCodec preserves its source C (including Type and Encoded) and returns a
   Schema.Codec<C.Type, Wire> for the explicit JSON wire representation;
   its explicit wire encoder may need a typed helper at this advanced boundary.
10. **Publication is validated.** JSON-shaped interfaces pass a shape compatibility check;
    Date, functions and rich values fail unless projected. This is not `S extends Json`,
    which rejects interfaces without index signatures. Numbers still need a runtime
    finiteness check. Publication makes detached deeply readonly snapshots, validates
    schemas and always redacts secrets, including custom codecs. Consumer views derive encoded state, map Redacted to the fixed safe marker and
    make nested properties readonly. consumer-state.ts proves transformed state and
    redaction types; runtime encoding/publication remains an acceptance obligation.
    `initial()` is checked statically against its state type and validated against its
    full runtime schema before installation (TS cannot enforce refinements such as Int).
11. **Guarded writes have a typed failure.** `state.when(tag).update(f)` and guarded
    handler state writes have `Effect<void, StateChanged>`. The action/lifecycle supervisor
    converts StateChanged to a refused outcome; it never becomes a domain error or a
    successful overwrite of another phase. Each write rechecks its phase after suspension.
    Cancellation cleanup cannot use a closed state capability to write after departure.
12. **Scenario defaults and fixtures.** Define fixtures once in app-level `fixtures`;
    a scenario can override with `fixtures: []`. A test-only withScenarios extension may
    set its app-level defaults in its options. Scenario membership stays specific: a
    union scenario admits only fixtures present in every member. Fixtures mount once,
    before the layer; their access services provision that layer and their action
    requirements must also be covered. Production app.ts imports no fixtures; scenarios.ts
    extends it for tests/E2E. The production descriptor fingerprint excludes scenario
    names, descriptions, fixture defaults and virtual clock settings, so this extension
    matches the same device app. It includes selected screen/service/action wire schemas,
    route encodings and protocol version, not function bodies. It is compatibility,
    not proof that remote handlers are identical or trusted.
13. **withScenarios is immutable and additive.** Fresh names only. Existing app values,
    their default scenario and their fixture defaults never change. Extensions normalize
    old scenario fixture membership before applying new defaults to new scenarios. A
    later extension retains all earlier scenarios and retains the previous default
    unless explicitly changed. A missing requested default fails. Existing scenario names
    cannot be overwritten. Common-layer provisioning is retained across extensions; consumer-state.ts
    compiles a common-layer app and two extensions, checking their defaults. Missing service diagnostics currently expose the service identifier;
    the exact runtime message must name its Context key, e.g.
    `App inventory scenario live-services must provide inventory/InventoryApi.`
14. **Provider is app-bound.** Export destructured Provider/useScreen/useService/Link/href
    bindings so eslint-plugin-react-hooks recognizes the hooks. Ordinary `<Provider>`
    needs no app prop. Provider bridge="development" opens the development bridge on
    mount and closes it on unmount, including Fast Refresh. Only a
    compatible withScenarios variant passes `app={instrumented}`. Runtime checks original
    descriptor identity. `fallback` renders while starting, including when outside the
    router. A failure stores the cause then rethrows during render to the nearest React
    error boundary; retry requires that boundary to reset and the Provider to reset or
    remount. A stable context remains above the fallback/error gate so a surrounding
    status component can observe `useSession` starting/failed/closed. The boundary itself
    cannot use a child context. `onBackgroundError` receives unobserved UI action failures,
    lifecycle defects, and publication failures with node/action names. Journeys observe
    outcomes directly; do not double-report observed expected failures.
15. **Reset returns new controls.** Both UI reset and journey reset return the new
    generation-bound controls/client. Reacquire screen/fixture handles. Old methods fail
    with SessionChanged; an old view's run never dispatches into a new generation.
    Resets queue in invocation order; each reply identifies its own generation, which
    may already be superseded by a later queued reset. The returned generation is
    checked on its next use. Reset during an action cancels it and drains the old registry
    before starting the next scenario. Operation awaiters may still observe their own settled cancellation after reset;
    this grants no dispatch or state access. The owning test client's async disposer remains
    a resource owner across resets; disposal is idempotent and closes the current session.
16. **Cancellation isolates generations, not just AbortSignal.** Each store build owns
    a fresh store, guarded handler access and a generation-filtered subscription.
    AbortSignal is advisory for arbitrary Promises. On close/reset, mark the generation
    closed before notifying cancellation, detach subscriptions and revoke handler writes.
    A Promise that ignores abort may finish, but neither a proxied store write nor a late
    notification can publish into a closed generation or a new store. Externally retained
    raw stores may mutate themselves; Reflex cannot undo arbitrary application side
    effects and must never share such a store with a new generation. Late factory results
    are disposed rather than installed. Forked fibers use scoped forks; escaped daemon
    fibers still lose state capability on close. No closed-state write is permitted.
17. **Single route registry and atomic navigation.** Key `(constructor, history entry
    key)` stores generation, encoded params hash, pending promise, scope, node and leases.
    A second lookup reuses the pending build. Conflicting params are an error. Normal
    useScreen suspends by default and sends failures to the route ErrorBoundary.
    useScreenStatus is the opt-in pending/error/ready API. Normal hooks acquire at
    commit; Suspense may request at render, but the session owns the
    provisional scope. Abandoned work has a deadline. Provisional and committed entries
    share bounded capacity; unreachable forward entries are released, reset/teardown
    drains all entries exactly once. A failed build is evicted before retry; normal hooks
    expose status:error/error/retry, Suspense throws to a per-screen error boundary whose
    reset calls the same registry retry and rerenders. There is no permanently rejected
    cached promise or second Suspense cache. Previous core focus survives preparation
    failure. Terminal success commits focus atomically before source scope closes;
    the originating navigation operation is supervised outside that source scope.
    Cancellation before commit abandons preparation; after commit cannot undo history.
    Peer-reachable bounds and deadlines must be named in protocol/limits.ts at implementation
    time. No design-local numeric limit becomes a hidden implementation limit.
18. **Route grammar.** Root adapters accept literal /:x and /[x] segments, required
    placeholders plus optional query fields. Repeats, groups, catchalls, spread and optional
    path grammar fail with a routeCodec hint (repeats identify the repeated field).
    Optional schema fields cannot become path placeholders. Encoded params must be strings
    or optional strings; mapping keys must be fields, and changed URL targets must be
    unique including default names. The parser is a tail-recursive accumulator; the
    60-segment positive example verifies it. Error text interpolates field names.
    Advanced routeCodec, shared and re-exported from both host advanced entries, handles
    excluded grammar. Runtime validates encode output and decode output against that
    screen's **encoded** schema before decoded navigation args enter core logic. Extra
    query keys are ignored; arrays need the explicit codec policy.
19. **Host idioms.** Both hosts offer `<Link to={Detail} params={{id}} />` and
    `href(Detail, {id})`, accepting the host link props minus owned navigation fields. Expo owns its files/Stack and puts Suspense/error boundaries
    per screen, never around the entire Stack. React Router routes accepts host options
    (RouteObject fields minus owned path/index/children/id/rendering wrappers) per screen;
    Component, element or lazy is required, and handle and other host fields pass through.
    Each screen has its own Suspense and error element; resetting the error element
    evicts the failed route lease and retries it. Expo accepts pathname as well as path;
    registration owns path, wrapper and focus key. Wrappers report the actual matched
    location/history key; no useResolvedPath substitute. A lazy result may supply host
    components/data handlers but cannot replace the owned route wrapper/path. Framework
    mode and route modules are out of scope; this design targets ordinary RouteObjects
    and createBrowserRouter. Loader errors use host errorElement and refuse preparation.
    A contract hook called from another route file fails against route context at runtime;
    TS cannot infer filenames. A missing Suspense boundary is a React/lint obligation,
    not a claimed type error.
20. **Progressive disclosure and tests.** Start with the first ten lines of
    tiers/one-step.ts; move to tiers/selected.ts when selection becomes necessary;
    advanced.ts adds explicit scoped ownership. The first plain counter is router-free:
    services:[Counter] plus useService(Counter). Routing comes later in the web sample.
    Journey actions have one mode: .Save.run() returns an outcome, and
    .Save.expectCompleted()/expectError()/expectRefusal() assert it. expectRefusal returns
    status and reason. .Save.start() returns a tracked operation. There is no TypedClient
    or forScenario. session.open(Detail, params) mounts a host/store route. explore is
    public, with typed invariants and knownInputs. The advanced protocol test seam accepts
    malformed requests, operation ids and exposes events for assertions. Shared stories accept Pick of the capabilities they
    use. Both fixture and real-service calls compile. Use await using or pool+afterEach;
    no unowned test session. advanceTime takes Duration.Input and requires a virtualTime
    scenario, including every member when the scenario name is a union. Match timeouts name the
    contract, requested match, timeout and **last state seen**, including pending/error.
21. **Export reduction.** No Self, resolve, root node map, queued-navigation layer,
    public /internal entries, duplicated mountOwned/routeCodec/developmentBridge functions,
    StateSource, or parallel Bridge types. runtime/advanced owns mountOwned;
    effect/advanced owns mountEffect; it returns an OwnedNode with typed state, changes
    and actions and requires Scope. createRuntime(app, { scenario }) makes mountOwned
    reachable. Registry and adapter APIs are explicitly integration plumbing. live owns Bridge and live/dev implements
    developmentBridge; expo/dev re-exports it. Root/advanced files under api/ are the
    exhaustive target author surface, not wildcard compatibility barrels. Controller,
    protocol, RPC, CLI and navigation integration APIs remain outside this redesign.
    Root codecs are context-free; service-requiring schema codecs are outside this
    revision, rather than silently erasing their requirements. The declaration model is intentionally smaller than the current implementation;
    unlisted existing userland APIs require migration, not compatibility shims.

## 3. Executable evidence and open obligations

The revision-1 four isolated probes are replaced by the full declarations plus examples,
negative cases and the slope harness. Reviewer probes p1–p10, store-inference, codecs,
extra, long-path and fixes.ts were read; their counterexamples are represented by
static-limits.ts, codecs.ts, the negative cases and the generated scale graph.

The type-performance workload contains distinct union states, input codecs, guarded
reducers, params, navigation and route registrations. It reports TypeScript check time
and instantiations at 0/100/200/400 screens, with 0/1/10 hooks per screen. Feature bindings
from(Definition) capture a selected definition directly and expose zero-argument hooks. Lookup uses an
indexed definition table for ordinary hooks. The from(Definition) tier checks exact
membership at runtime and uses only that definition in its hook types, avoiding an
N-member overload intersection or repeated app-membership computation.
The gates are 25 ms per added screen (100→200 and 200→400 with one hook) and 5 ms per
additional narrowed hook, allowing scheduling noise. These are batch checker measurements,
not editor latency measurements. Results are printed by the checker and recorded in
prototypes/results.json when REFLEX_RECORD_TYPE_PERF=1 is set.

Static misuse rows below are generated from @case annotations. The checker asserts
the complete custom message or a full TypeScript diagnostic sentence **plus exact source
line**, rejects fragment-only markers and rejects additional diagnostics. Ordinary TS
messages are used when the surface cannot supply a marker. The old row numbers are
superseded by stable case IDs. In particular old rows 19/21 now use inferred error channels;
old row 20 honestly uses the TS parameter incompatibility; old row 35 honestly uses the
missing component property; none relies on exactOptionalPropertyTypes wording.

### Verified negative cases

| ID                        | Required diagnostic                                                                                                                                                                                                                                                                                                                                                                                                                                       | Source                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| role-fixture              | `InventoryFixture is not a screen of app 'inventory'`                                                                                                                                                                                                                                                                                                                                                                                                     | [case](prototypes/negative/cases.ts#L35)    |
| nominal                   | `InventoryDetail is declared more than once`                                                                                                                                                                                                                                                                                                                                                                                                              | [case](prototypes/negative/cases.ts#L45)    |
| screen-service            | `InventoryDetail is not a service of app 'inventory'`                                                                                                                                                                                                                                                                                                                                                                                                     | [case](prototypes/negative/cases.ts#L54)    |
| fixture-service           | `InventoryFixture is not a service of app 'inventory'`                                                                                                                                                                                                                                                                                                                                                                                                    | [case](prototypes/negative/cases.ts#L56)    |
| absent-fixture            | `InventoryFixture is not a fixture of this scenario of app 'inventory'`                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/cases.ts#L59)    |
| union-fixture             | `InventoryFixture is not a fixture of this scenario of app 'inventory'`                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/cases.ts#L63)    |
| duplicate-implementation  | `InventoryList is declared more than once`                                                                                                                                                                                                                                                                                                                                                                                                                | [case](prototypes/negative/cases.ts#L65)    |
| missing-implementation    | `InventoryDetail requires one implementation`                                                                                                                                                                                                                                                                                                                                                                                                             | [case](prototypes/negative/cases.ts#L67)    |
| unknown-params            | `Argument of type '{}' is not assignable to parameter of type '{ readonly productId: string; }'.`                                                                                                                                                                                                                                                                                                                                                         | [case](prototypes/negative/cases.ts#L69)    |
| union-push                | `Expected 1 arguments, but got 2.`                                                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/cases.ts#L71)    |
| no-params                 | `Expected 1 arguments, but got 2.`                                                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/cases.ts#L73)    |
| decoded-command           | `Type 'string' is not assignable to type 'number'.`                                                                                                                                                                                                                                                                                                                                                                                                       | [case](prototypes/negative/cases.ts#L75)    |
| encoded-href              | `Type 'number' is not assignable to type 'string'.`                                                                                                                                                                                                                                                                                                                                                                                                       | [case](prototypes/negative/cases.ts#L77)    |
| union-href                | `Expected 1 arguments, but got 2.`                                                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/cases.ts#L80)    |
| initial-correlation       | `Type 'string' is not assignable to type 'number'.`                                                                                                                                                                                                                                                                                                                                                                                                       | [case](prototypes/negative/cases.ts#L82)    |
| yielded-command           | `Type 'AnyNavigationCommand & { readonly [terminal]: "InventoryList" \| "InventoryDetail" \| "Settings" \| "default"; readonly [navigationOwner]: (key: "InventoryList" \| ... 2 more ... \| "default") => "InventoryList" \| ... 2 more ... \| "default"; }' must have a '[Symbol.iterator]()' method that returns an iterator.`                                                                                                                         | [case](prototypes/negative/cases.ts#L85)    |
| command-pipe              | `Property 'pipe' does not exist on type 'AnyNavigationCommand & { readonly [terminal]: "InventoryList" \| "InventoryDetail" \| "Settings" \| "default"; readonly [navigationOwner]: (key: "InventoryList" \| ... 2 more ... \| "default") => "InventoryList" \| ... 2 more ... \| "default"; }'.`                                                                                                                                                         | [case](prototypes/negative/cases.ts#L88)    |
| plain-navigation          | `Use action.navigates for actions that navigate`                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L93)    |
| undeclared-error          | `Declare action failures with error:`                                                                                                                                                                                                                                                                                                                                                                                                                     | [case](prototypes/negative/cases.ts#L97)    |
| undeclared-input          | `Type 'undefined' is not assignable to type '{ by: number; }'.`                                                                                                                                                                                                                                                                                                                                                                                           | [case](prototypes/negative/cases.ts#L101)   |
| dropped-navigation        | `Type 'Effect<void, never, never>' is not assignable to type 'AnyNavigationCommand \| Effect<AnyNavigationCommand, unknown, unknown>'.`                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/cases.ts#L106)   |
| erased-navigation         | `Type 'Effect<void, never, never>' is not assignable to type 'AnyNavigationCommand \| Effect<AnyNavigationCommand, unknown, unknown>'.`                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/cases.ts#L113)   |
| refusal-command           | `Navigation refusal recovery must return void`                                                                                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/cases.ts#L118)   |
| focus-error               | `Handle onFocus failures into state`                                                                                                                                                                                                                                                                                                                                                                                                                      | [case](prototypes/negative/cases.ts#L125)   |
| focus-navigation          | `Use action.navigates for actions that navigate`                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L130)   |
| transformed-store-input   | `Argument of type 'number' is not assignable to parameter of type 'string'.`                                                                                                                                                                                                                                                                                                                                                                              | [case](prototypes/negative/cases.ts#L135)   |
| transformed-effect-input  | `Argument of type 'number' is not assignable to parameter of type 'string'.`                                                                                                                                                                                                                                                                                                                                                                              | [case](prototypes/negative/cases.ts#L140)   |
| json-date                 | `Store Date state must be JSON; provide project`                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L148)   |
| json-function             | `Store Function state must be JSON; provide project`                                                                                                                                                                                                                                                                                                                                                                                                      | [case](prototypes/negative/cases.ts#L155)   |
| no-fail                   | `Property 'fail' does not exist on type 'Context<StoreApi<{ count: number; }>, undefined>'.`                                                                                                                                                                                                                                                                                                                                                              | [case](prototypes/negative/cases.ts#L166)   |
| rich-error                | `Store error must be JSON; provide projectError`                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L171)   |
| store-command             | `Store handlers cannot return NavigationCommand`                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L174)   |
| duplicate-service         | `Counter is declared more than once`                                                                                                                                                                                                                                                                                                                                                                                                                      | [case](prototypes/negative/cases.ts#L179)   |
| multiple-roles            | `No overload matches this call.`                                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L181)   |
| initial-schema            | `Type 'string' is not assignable to type 'number'.`                                                                                                                                                                                                                                                                                                                                                                                                       | [case](prototypes/negative/cases.ts#L191)   |
| includes-typo             | `Object literal may only specify known properties, and 'qty' does not exist in type 'Partial<NoInfer<{ readonly id: string; readonly title: string; readonly quantity: number; }>>'.`                                                                                                                                                                                                                                                                     | [case](prototypes/negative/cases.ts#L194)   |
| match-variant             | `State match fields must belong to one variant`                                                                                                                                                                                                                                                                                                                                                                                                           | [case](prototypes/negative/cases.ts#L196)   |
| unknown-scenario          | `Type '"typo"' is not assignable to type 'ScNames<App<"inventory", (Definition<typeof InventoryList, { readonly OpenProduct: Action<{ readonly productId: string; }, never, { readonly navigator: "InventoryList" \| "InventoryDetail" \| "Settings" \| "default"; readonly [navigationOwner]: (key: "InventoryList" \| ... 2 more ... \| "default") => "InventoryList" \| .....'.`                                                                       | [case](prototypes/negative/cases.ts#L198)   |
| extension-default         | `withScenarios defaultScenario must exist`                                                                                                                                                                                                                                                                                                                                                                                                                | [case](prototypes/negative/cases.ts#L200)   |
| extension-repeat          | `Scenario live-services already exists; choose a new name`                                                                                                                                                                                                                                                                                                                                                                                                | [case](prototypes/negative/cases.ts#L202)   |
| repeated-placeholder      | `Repeated path placeholder id`                                                                                                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/cases.ts#L205)   |
| group                     | `Excluded route grammar; use routeCodec`                                                                                                                                                                                                                                                                                                                                                                                                                  | [case](prototypes/negative/cases.ts#L207)   |
| catchall                  | `Excluded route grammar; use routeCodec`                                                                                                                                                                                                                                                                                                                                                                                                                  | [case](prototypes/negative/cases.ts#L209)   |
| spread                    | `Excluded route grammar; use routeCodec`                                                                                                                                                                                                                                                                                                                                                                                                                  | [case](prototypes/negative/cases.ts#L211)   |
| optional-grammar          | `Excluded route grammar; use routeCodec`                                                                                                                                                                                                                                                                                                                                                                                                                  | [case](prototypes/negative/cases.ts#L213)   |
| optional-placeholder      | `Optional route param tab cannot be a path placeholder`                                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/cases.ts#L215)   |
| unmatched-placeholder     | `Path placeholder other has no matching param; add a params mapping`                                                                                                                                                                                                                                                                                                                                                                                      | [case](prototypes/negative/cases.ts#L217)   |
| missing-placeholder       | `Required route param id must appear as a path placeholder`                                                                                                                                                                                                                                                                                                                                                                                               | [case](prototypes/negative/cases.ts#L219)   |
| mapping-duplicates        | `URL param mapping targets must be unique`                                                                                                                                                                                                                                                                                                                                                                                                                | [case](prototypes/negative/cases.ts#L221)   |
| mapping-keys              | `URL param mapping names must be schema fields`                                                                                                                                                                                                                                                                                                                                                                                                           | [case](prototypes/negative/cases.ts#L223)   |
| dynamic-path              | `Route path must be a literal; use advanced routeCodec for dynamic paths`                                                                                                                                                                                                                                                                                                                                                                                 | [case](prototypes/negative/cases.ts#L225)   |
| numeric-url               | `URL param id must encode a string; use a string codec`                                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/cases.ts#L227)   |
| registration-missing      | `Argument of type '{ InventoryList: "/"; InventoryDetail: "/:productId"; }' is not assignable to parameter of type '{ readonly InventoryList: "/"; readonly InventoryDetail: "/:productId"; } & ValidateRoutes<App<"inventory", (Definition<typeof InventoryList, { readonly OpenProduct: Action<{ readonly productId: string; }, never, { ...; }, { ...; } \| ... 1 more ... \| { ...; }>; readonly OpenSettings: Action<...>; readonly Refresh: A...'.` | [case](prototypes/negative/cases.ts#L229)   |
| component-missing         | `Argument of type '{ InventoryList: { Component: () => null; }; InventoryDetail: { Component: () => null; }; }' is not assignable to parameter of type '{ InventoryList: HostRouteOptions; InventoryDetail: HostRouteOptions; Settings: HostRouteOptions; }'.`                                                                                                                                                                                            | [case](prototypes/negative/cases.ts#L236)   |
| href-union                | `Type '"Settings"' is not assignable to type '"InventoryDetail"'.`                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/cases.ts#L241)   |
| zero-arity                | `Expected 0 arguments, but got 1.`                                                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/cases.ts#L252)   |
| missing-navigator         | `No overload matches this call.`                                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L258)   |
| missing-service           | `No overload matches this call.`                                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L260)   |
| missing-fixture           | `Type '{ layer: Layer<InventoryApi, never, FixtureService<"InventoryFixture">>; fixtures: []; }' is not assignable to type '{ readonly layer: Layer<InventoryApi, never, FixtureService<"InventoryFixture">>; readonly fixtures: readonly []; } & { readonly "Scenario 'missing-fixture' must provide": SettingsStore \| FixtureService<...>; }'.`                                                                                                        | [case](prototypes/negative/cases.ts#L268)   |
| fixture-action-service    | `Property '"Scenario 'missing' must provide"' is missing in type '{ fixtures: [Definition<never, { readonly Load: Action<undefined, never, InventoryApi, number>; }, number, InventoryApi, "fixture"> & Effect.Effect<...> & { ...; }]; }' but required in type '{ readonly "Scenario 'missing' must provide": InventoryApi; }'.`                                                                                                                         | [case](prototypes/negative/cases.ts#L280)   |
| role-collision            | `ParamFree is declared more than once`                                                                                                                                                                                                                                                                                                                                                                                                                    | [case](prototypes/negative/cases.ts#L282)   |
| missing-default           | `Property 'defaultScenario' is missing in type '{ name: "two"; scenarios: { one: {}; two: {}; }; }' but required in type '{ defaultScenario: "one" \| "two"; }'.`                                                                                                                                                                                                                                                                                         | [case](prototypes/negative/cases.ts#L284)   |
| record-alias              | `Navigation key Second must match contract name InventoryDetail`                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L286)   |
| effect-rich-state         | `Effect state must encode JSON; use jsonCodec`                                                                                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/cases.ts#L288)   |
| fixture-navigates         | `Property 'navigates' does not exist on type 'PlainEffectActionBuilder<number, number, never>'.`                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/cases.ts#L295)   |
| readonly-state            | `Cannot assign to 'count' because it is a read-only property.`                                                                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/cases.ts#L301)   |
| transformed-error-encoder | `Property 'projectError' is missing in type '{ error: z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>; handler: () => void; }' but required in type '{ projectError: (error: number) => string; }'.`                                                                                                                                                                                                                                               | [case](prototypes/negative/cases.ts#L308)   |
| unknown-input-presence    | `Expected 1 arguments, but got 0.`                                                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/cases.ts#L323)   |
| invalid-action            | `Actions must be built for this state with the action builder`                                                                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/fixes.ts#L14)    |
| wrong-action-state        | `Actions must be built for this state with the action builder`                                                                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/fixes.ts#L17)    |
| bigint-input              | `Input must encode JSON; use jsonCodec`                                                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/fixes.ts#L22)    |
| bigint-error              | `Error must encode JSON; use jsonCodec`                                                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/fixes.ts#L31)    |
| bigint-params             | `Params must encode JSON; use jsonCodec`                                                                                                                                                                                                                                                                                                                                                                                                                  | [case](prototypes/negative/fixes.ts#L39)    |
| store-bigint-input        | `Input must encode JSON; use jsonCodec`                                                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/fixes.ts#L48)    |
| common-layer-input        | `Property '"Scenario 'default' must provide"' is missing in type '{ name: "common-input"; screens: [Definition<typeof First, { readonly Add: Action<undefined, never, never, number>; }, number, never, "screen"> & { readonly name: "First"; readonly paramsType: {}; readonly encodedParams: {}; }]; layer: Layer.Layer<...>; }' but required in type '{ readonly "Scenario 'default' must provide": Needed; }'.`                                       | [case](prototypes/negative/fixes.ts#L59)    |
| self-provided-layer       | `Property '"Scenario 'self' must provide"' is missing in type '{ layer: Layer.Layer<Needed, never, Needed>; }' but required in type '{ readonly "Scenario 'self' must provide": Needed; }'.`                                                                                                                                                                                                                                                              | [case](prototypes/negative/fixes.ts#L61)    |
| absent-scenarios-coverage | `Property '"Scenario 'default' must provide"' is missing in type '{ name: "uncovered"; screens: [Definition<typeof First, { readonly Load: Action<undefined, never, Needed, number>; }, number, Needed, "screen"> & { ...; }]; }' but required in type '{ readonly "Scenario 'default' must provide": Needed; }'.`                                                                                                                                        | [case](prototypes/negative/fixes.ts#L66)    |
| screen-role               | `screens accepts only screens or stores`                                                                                                                                                                                                                                                                                                                                                                                                                  | [case](prototypes/negative/fixes.ts#L74)    |
| service-role              | `services accepts only services or stores`                                                                                                                                                                                                                                                                                                                                                                                                                | [case](prototypes/negative/fixes.ts#L76)    |
| effect-store-app          | `defineStoreApp accepts only stores`                                                                                                                                                                                                                                                                                                                                                                                                                      | [case](prototypes/negative/fixes.ts#L78)    |
| ambient-params            | `Ambient services must not require params`                                                                                                                                                                                                                                                                                                                                                                                                                | [case](prototypes/negative/fixes.ts#L86)    |
| foreign-navigator         | `No overload matches this call.`                                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/fixes.ts#L93)    |
| real-time-advance         | `advanceTime requires a virtualTime scenario`                                                                                                                                                                                                                                                                                                                                                                                                             | [case](prototypes/negative/fixes.ts#L97)    |
| no-render-source          | `Type '{}' is not assignable to type 'HostRouteOptions'.`                                                                                                                                                                                                                                                                                                                                                                                                 | [case](prototypes/negative/fixes.ts#L100)   |
| nav-role-collision        | `First is declared more than once`                                                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/fixes.ts#L102)   |
| store-invalid-action      | `Actions must be built for this state with the action builder`                                                                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/fixes.ts#L110)   |
| foreign-store-override    | `Scenario stores must belong to this app`                                                                                                                                                                                                                                                                                                                                                                                                                 | [case](prototypes/negative/fixes.ts#L122)   |
| wrong-store-factory       | `Type 'StoreApi<string>' is not assignable to type 'StoreApi<number>'.`                                                                                                                                                                                                                                                                                                                                                                                   | [case](prototypes/negative/fixes.ts#L125)   |
| store-bigint-params       | `Params must encode JSON; use jsonCodec`                                                                                                                                                                                                                                                                                                                                                                                                                  | [case](prototypes/negative/fixes.ts#L133)   |
| navigator-subset          | `No overload matches this call.`                                                                                                                                                                                                                                                                                                                                                                                                                          | [case](prototypes/negative/fixes.ts#L140)   |
| link-required             | `Type '{ to: typeof InventoryDetail; }' is not assignable to type 'IntrinsicAttributes & ((({ to: typeof InventoryList; children?: ReactNode; replace?: boolean; className?: string; } & { params?: never; }) \| ({ ...; } & { ...; }) \| ({ ...; } & { ...; })) & Omit<...>)'.`                                                                                                                                                                          | [case](prototypes/negative/links.tsx#L24)   |
| link-name                 | `Type 'string' is not assignable to type 'typeof InventoryList \| typeof InventoryDetail \| typeof Settings'.`                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/links.tsx#L26)   |
| expo-link-name            | `Type 'string' is not assignable to type 'typeof InventoryList \| typeof InventoryDetail \| typeof Settings'.`                                                                                                                                                                                                                                                                                                                                            | [case](prototypes/negative/links.tsx#L28)   |
| link-union                | `Type '"Settings"' is not assignable to type '"InventoryDetail"'.`                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/links.tsx#L31)   |
| initial-union             | `Type '"Settings"' is not assignable to type '"InventoryDetail"'.`                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/links.tsx#L34)   |
| expo-href-union           | `Type '"Settings"' is not assignable to type '"InventoryDetail"'.`                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/links.tsx#L37)   |
| owned-params              | `Expected 3 arguments, but got 2.`                                                                                                                                                                                                                                                                                                                                                                                                                        | [case](prototypes/negative/ownership.ts#L5) |

### Runtime obligations and unproven acceptance cases

These rows are **not passing runtime tests**. The target runtime does not exist. Every
row must become an executable negative acceptance test against both SessionController
and LiveController where the protocol exposes it. It would be dishonest to assert a tsc
marker for a Promise's behavior, disposal, a React boundary or a device fingerprint.
The compiled abort-ignoring case is an acceptance program, not runtime evidence.

| Case                            | Required rejection or observable result                                                                                                                                                                        | Phase                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| missing-nominal/subclass        | Exact constructor registry rejects an unregistered Subclass; message names InventoryDetail and suggests registering its own contract. TypeScript remains structural; no hand-written private line is required. | Runtime obligation + static counterexample               |
| class/string mismatch           | DifferentClassName diagnostics name DeclaredName; identity remains its constructor.                                                                                                                            | Runtime obligation                                       |
| extra implementation            | Reject foreign or extra definitions, even when every required contract also has an implementation.                                                                                                             | Runtime obligation                                       |
| duplicate dynamic definitions   | App x declares Counter more than once; keep one definition. Check all screens, services and effective fixtures.                                                                                                | Runtime obligation                                       |
| shared contract in navigations  | Reject a contract registered in two session navigation owners; separate app values may reuse contracts.                                                                                                        | Runtime obligation; advanced multi-owner typing unproven |
| fixture service key             | App inventory scenario live-services must provide inventory/InventoryApi. Static coverage names the identifier; Context key string interpolation is unproven.                                                  | Runtime obligation                                       |
| invalid initial refinement      | Counter initial.count must be an integer; fix initial(). Never install the invalid node.                                                                                                                       | Runtime obligation                                       |
| invalid projected number        | Counter state.count must be a finite JSON number; fix the projection.                                                                                                                                          | Runtime obligation                                       |
| malformed URL                   | InventoryDetail route params.productId are invalid; correct the URL. Preserve previous committed focus.                                                                                                        | Runtime obligation                                       |
| wrong route file                | useScreen(Settings) in InventoryDetail's entry reports expected InventoryDetail, received Settings, and the route key.                                                                                         | Runtime obligation                                       |
| no Suspense boundary            | React/lint reports missing per-screen boundary; no library compile marker is promised.                                                                                                                         | Unproven lint/integration obligation                     |
| normal rejected build           | Observe status:error, retry once, get a fresh build; pending lease and subscription are released once.                                                                                                         | Runtime obligation                                       |
| Suspense rejected build         | Boundary sees build error; resetting it retries the same registry entry with a new promise, without affecting sibling screens.                                                                                 | Runtime obligation                                       |
| startup failure                 | Fallback while starting; status observer sees failed; nearest error boundary receives cause; reset/remount retries.                                                                                            | Runtime obligation                                       |
| Provider identity               | Provider app must share the binding's app identity; use app.withScenarios. Structural same-name apps fail runtime validation.                                                                                  | Runtime obligation                                       |
| unused/erased command           | Reject unused, multiple, void-erased, service/fixture or onFocus commands; require action.navigates and Nav.stay. Lint must catch discarded expressions and TS2488 misuse earlier.                             | Runtime obligation + unproven lint                       |
| abort-ignoring Promise          | Run acceptance/cancellation.ts: cancel/reset while gate waits, release gate, operation stays cancelled and new state remains count:0; observe no old-generation state.changed.                                 | Runtime obligation; program compiles                     |
| ignored raw notification        | After reset, invoke an old raw store subscriber and late factory resolution; neither may publish. Dispose late factory exactly once.                                                                           | Runtime obligation                                       |
| fork after close                | Fork scoped fiber then close; join observes interruption. Escaped daemon write receives SessionChanged/closed capability and never publishes.                                                                  | Runtime obligation                                       |
| concurrent reset                | Queue reset A then B; returned A client is stale after B, B remains usable; no orphaned sessions/scopes.                                                                                                       | Runtime obligation                                       |
| reset while pending             | Old action outcome cancelled before reset resolves; returned client/controls name the new generation; reacquire handles.                                                                                       | Runtime obligation                                       |
| disposed view run               | Counter.Add belongs to a closed session; reacquire Counter from the current session. No dispatch or notification occurs.                                                                                       | Runtime obligation                                       |
| disposed journey/read           | Old client, node, action function and narrowed state reader all reject SessionChanged; dispose itself remains idempotent.                                                                                      | Runtime obligation                                       |
| stale matched variant           | A narrowed journey read checks its phase again, never asserts an editing state after loading.                                                                                                                  | Runtime obligation                                       |
| matcher timeout                 | InventoryList did not match requested products within 5 seconds; last state: {…}. Include last pending/error state too.                                                                                        | Runtime obligation                                       |
| fingerprint extension           | connectJourney accepts base descriptor with test scenarios added and rejects a changed selected action/schema. Repeated withScenarios never mutates earlier defaults.                                          | Runtime obligation                                       |
| production exclusion            | Metro/Vite production graphs contain no fixtures/test provider or bridge dialler/token. Keep ADR 0017 development gates. No real credentials in public env/AsyncStorage.                                       | Runtime obligation                                       |
| advanced codec                  | Catchall encode/decode validates encoded schema, rejects arrays/invalid output as specified, and never guesses decoded URL values.                                                                             | Runtime obligation                                       |
| transformed store error         | Validate explicit projectError output and detach it; automatic inversion of Standard Schema transforms is unavailable.                                                                                         | Runtime obligation                                       |
| redacted/encoded consumer state | Validate actual encode/redaction behavior and custom wire codecs; consumer-state.ts verifies the derived encoded/read-only/redacted types.                                                                     | Runtime obligation; static types verified                |
| common layer extensions         | Runtime provisioning agrees with the retained common output; two extensions/defaults compile in consumer-state.ts.                                                                                             | Runtime obligation; static coverage verified             |
| resource/type budgets           | Prove registry deadlines and limits under abort/reset; implement within the 7,600-line allocation, without hiding logic in tests.                                                                              | Runtime obligation; implementation size unproven         |

The implementation allocation remains 7,600 source lines across the seven packages
(effect 2,350; runtime 2,550; react 600; expo 400; react-router 250; live 700; test 750).
This is a planning ceiling, not measured implementation feasibility. Delete redundant
identity tokens, queued afterAction navigation, separate Suspense caches, append-only
store retention, manual provider wrappers and duplicate typed clients. Reuse protocol
validation, access checks, redaction, transport/auth, projection and controllers.

## 4. Complete authored files

These paths describe the future app layout. The physical compiled copies are under
prototypes/examples/. Production scenarios live in app.ts; test fixtures enter only
through scenarios.ts or the E2E provider alias. The plain example precedes routing.
One-step, split and advanced tiers show their actual first ten lines, with no hidden
setup. Effect imports consistently use namespace subpaths, including type-only imports.
The future test file is physically named test/journey.ts so the repository runner
does not execute a target-API fixture as an implementation test; it can be renamed
journey.test.ts when implementing the design. The only assertions are literal `as const` values, never assertions of decoded external
input. HTTP uses Schema.fromJsonString instead of untyped JSON.parse; settings I/O uses
Effect.tryPromise and versioned bounded storage. The HTTP response size check is after
buffering when content-length is absent: bounded streaming reads remain an application
transport acceptance obligation, not a claim that this buffer prevents all allocation.

### tiers/advanced.ts

<!-- file: examples/tiers/advanced.ts -->
```ts
import { mountEffect } from "@reflex/effect/advanced"
import { CounterLive } from "./selected.ts"
// Advanced mounting remains scoped: this Effect requires Scope and cannot run unscoped.
export const owned = mountEffect(CounterLive)
```

### tiers/one-step.ts

<!-- file: examples/tiers/one-step.ts -->
```ts
import { Screen, defineApp } from "@reflex/effect"
import * as Schema from "effect/Schema"

export const Counter = Screen.define("Counter", {
  state: Schema.Struct({ count: Schema.Int }),
  initial: () => ({ count: 0 }),
  actions: (action) => ({
    Increment: action.reduce({ reducer: (_, s) => ({ count: s.count + 1 }) }),
  }),
})
export const app = defineApp({ name: "counter", screens: [Counter] })
```

### tiers/selected.ts

<!-- file: examples/tiers/selected.ts -->
```ts
import { Screen, defineApp } from "@reflex/effect"
import * as Schema from "effect/Schema"
export class CounterContract extends Screen("Counter", {
  state: Schema.Struct({ count: Schema.Int }),
  initial: () => ({ count: 0 }),
}) {}
export const CounterLive = CounterContract.implement({
  actions: (action) => ({
    Increment: action.reduce({ reducer: (_, s) => ({ count: s.count + 1 }) }),
  }),
})
export const selected = defineApp({ name: "counter", screens: [CounterLive] })
```

### examples/plain/src/app.ts

<!-- file: examples/examples/plain/src/app.ts -->
```ts
import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

// The existing Zustand store remains usable without Reflex.
export const createCounterStore = () => createStore(() => ({ count: 0, token: "private-token" }))
export const Counter = defineStoreNode({
  name: "Counter",
  store: createCounterStore,
  project: ({ count }) => ({ count }),
  actions: (action) => ({
    Add: action({
      input: z.strictObject({ by: z.int() }),
      handler: ({ by }, { store }) => store.setState((s) => ({ count: s.count + by })),
    }),
    Reset: action({
      available: ({ count }) => (count === 0 ? "Already zero" : true),
      handler: (_, { store }) => store.setState({ count: 0 }),
    }),
  }),
})
export default defineStoreApp({ name: "plain-counter", services: [Counter] })
```

### examples/inventory/journeys/services.ts

<!-- file: examples/examples/inventory/journeys/services.ts -->
```ts
import { includes, type JourneyClientFor } from "@reflex/test"
import { InventoryList, InventoryDetail, Settings } from "../src/screens.ts"
import type inventoryApp from "../src/app.ts"

/** The same typed story runs against fixtures and the live CLI transport. */
export const servicesJourney = async (
  app: Pick<JourneyClientFor<typeof inventoryApp>, "focused" | "back">,
  failNextSave: () => Promise<void>,
): Promise<void> => {
  const list = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 5 }),
  })
  await list.actions.OpenProduct.expectCompleted({ productId: "product-123" })
  const detail = await app.focused(InventoryDetail, {
    _tag: "editing",
    title: "Blue T-Shirt",
    quantity: 5,
  })
  await detail.actions.SetQuantity.expectCompleted({ quantity: 12 })
  await detail.actions.Save.expectCompleted()
  await app.back()
  const updated = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await updated.actions.OpenProduct.expectCompleted({ productId: "product-123" })
  const reopened = await app.focused(InventoryDetail, {
    _tag: "editing",
    quantity: 12,
    error: null,
  })
  await reopened.actions.SetQuantity.expectCompleted({ quantity: 19 })
  await failNextSave()
  await reopened.actions.Save.expectError()
  await app.focused(InventoryDetail, { _tag: "editing", quantity: 19, error: "Server error" })
  await app.back()
  const saved = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await saved.actions.OpenSettings.expectCompleted()
  const settings = await app.focused(Settings, { _tag: "ready" })
  await settings.actions.SetLowStockThreshold.expectCompleted({ threshold: 3 })
  await app.back()
  const refreshed = await app.focused(InventoryList, { lowStockThreshold: 3 })
  await refreshed.actions.OpenSettings.expectCompleted()
  await app.focused(Settings, { lowStockThreshold: 3 })
}
```

### examples/inventory/src/app.ts

<!-- file: examples/examples/inventory/src/app.ts -->
```ts
import { defineApp } from "@reflex/effect"
import * as Layer from "effect/Layer"
import { ApiError, InventoryApi } from "./domain.ts"
import * as Effect from "effect/Effect"
import { memorySettings } from "./settings-store.ts"
import { InventoryListLive } from "./features/inventory-list.ts"
import { InventoryDetailLive } from "./features/inventory-detail.ts"
import { SettingsLive } from "./features/settings.ts"
import { InventoryList } from "./screens.ts"
import { Nav } from "./navigation.ts"

export const productionServices = Layer.merge(
  Layer.succeed(
    InventoryApi,
    InventoryApi.of({
      list: Effect.succeed([]),
      get: () => Effect.fail(new ApiError({ message: "No inventory API configured" })),
      saveQuantity: () => Effect.fail(new ApiError({ message: "No inventory API configured" })),
    }),
  ),
  memorySettings,
)

export default defineApp({
  name: "inventory",
  navigation: Nav.implement([InventoryListLive, InventoryDetailLive, SettingsLive], {
    initial: InventoryList,
  }),
  defaultScenario: "production",
  scenarios: {
    production: {
      description: "Offline inventory and in-memory settings",
      layer: productionServices,
    },
  },
})
```

### examples/inventory/src/domain.ts

<!-- file: examples/examples/inventory/src/domain.ts -->
```ts
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export const QUANTITY_MAX = 100_000
export const LOW_STOCK_THRESHOLD_MAX = 1_000

export const Quantity = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: QUANTITY_MAX }))

export const Product = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  quantity: Quantity,
})
export type Product = typeof Product.Type

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String,
}) {}

/** Everything core logic needs from the outside world, as interfaces only. */
export class InventoryApi extends Context.Service<
  InventoryApi,
  {
    readonly list: Effect.Effect<ReadonlyArray<Product>, ApiError>
    get(id: string): Effect.Effect<Product, ApiError>
    saveQuantity(id: string, quantity: number): Effect.Effect<void, ApiError>
  }
>()("inventory/InventoryApi") {}

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly load: Effect.Effect<{
      readonly lowStockThreshold: number
      readonly apiToken: Redacted.Redacted<string>
    }>
    setLowStockThreshold(value: number): Effect.Effect<void>
  }
>()("inventory/SettingsStore") {}

export const isLowStock = (product: Product, lowStockThreshold: number): boolean =>
  product.quantity < lowStockThreshold
```

### examples/inventory/src/features/inventory-detail.ts

<!-- file: examples/examples/inventory/src/features/inventory-detail.ts -->
```ts
import { InventoryDetail } from "../screens.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ApiError, InventoryApi, Quantity, QUANTITY_MAX } from "../domain.ts"
import { Nav } from "../navigation.ts"

const SAVE_TIMEOUT = "5 seconds"

const save = InventoryDetail.when("editing").handler((_, { state }) =>
  Effect.gen(function* () {
    const api = yield* InventoryApi
    const current = yield* state.get
    const { productId, title, quantity } = current
    yield* state.update(() => ({ _tag: "saving", productId, title, quantity }))
    const finish = (error: string | null) =>
      state.when("saving").update(() => ({ _tag: "editing", productId, title, quantity, error }))
    yield* api.saveQuantity(productId, quantity).pipe(
      Effect.timeoutOrElse({
        duration: SAVE_TIMEOUT,
        orElse: () => Effect.fail(new ApiError({ message: "Save timed out" })),
      }),
      Effect.tapError(({ message }) => finish(message)),
      Effect.tap(() => finish(null)),
      Effect.onInterrupt(() => finish(null)),
    )
  }),
)

export const InventoryDetailLive = InventoryDetail.implement({
  onFocus: ({ state }) =>
    Effect.gen(function* () {
      const api = yield* InventoryApi
      const current = yield* state.get
      // Coming back must not discard edits, or forget a save that is still running.
      if (current._tag !== "loading") {
        return
      }
      const { productId } = current
      yield* api.get(productId).pipe(
        Effect.matchEffect({
          onFailure: ({ message }) =>
            state.update(() => ({ _tag: "missing", productId, error: message })),
          onSuccess: ({ title, quantity }) =>
            state.update(() => ({ _tag: "editing", productId, title, quantity, error: null })),
        }),
      )
    }),
  actions: (action) => ({
    Increment: action.when("editing").reduce({
      available: (state) =>
        state.quantity < QUANTITY_MAX ? true : "Quantity is already at its maximum",
      reducer: (_, state) => ({ ...state, quantity: state.quantity + 1 }),
    }),
    Decrement: action.when("editing").reduce({
      available: (state) => (state.quantity > 0 ? true : "Quantity is already zero"),
      reducer: (_, state) => ({ ...state, quantity: state.quantity - 1 }),
    }),
    SetQuantity: action.when("editing").reduce({
      description: "Set the quantity directly",
      input: Schema.Struct({ quantity: Quantity }),
      reducer: ({ quantity }, state) => ({ ...state, quantity }),
    }),
    Save: action.when("editing")({
      description: "Persist the quantity; gives up after 5 seconds",
      error: ApiError,
      handler: save,
    }),
    SaveAndClose: action.when("editing").navigates({
      description: "Persist the quantity and return to the previous screen",
      error: ApiError,
      handler: (_, { state }) =>
        Effect.gen(function* () {
          yield* save(undefined, { state })
          return Nav.back
        }),
      onRefused: ({ reason }, { state }) =>
        state.when("editing").update((current) => ({ ...current, error: reason })),
    }),
  }),
})
```

### examples/inventory/src/features/inventory-list.ts

<!-- file: examples/examples/inventory/src/features/inventory-list.ts -->
```ts
import { InventoryList, InventoryDetail, Settings } from "../screens.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InventoryApi, SettingsStore } from "../domain.ts"
import { Nav } from "../navigation.ts"

const load = InventoryList.handler((_, { state }) =>
  Effect.gen(function* () {
    const api = yield* InventoryApi
    const settings = yield* SettingsStore
    yield* state.set({ _tag: "loading" })
    const { lowStockThreshold } = yield* settings.load
    yield* api.list.pipe(
      Effect.matchEffect({
        onFailure: ({ message }) => state.update(() => ({ _tag: "failed", error: message })),
        onSuccess: (products) =>
          state.update(() => ({ _tag: "ready", products, lowStockThreshold })),
      }),
    )
  }),
)

export const InventoryListLive = InventoryList.implement({
  onFocus: (ctx) => load(undefined, ctx),
  actions: (action) => ({
    OpenProduct: action.when("ready").navigates({
      description: "Open a product's detail screen",
      input: Schema.Struct({ productId: Schema.String }),
      handler: ({ productId }) => Effect.succeed(Nav.push(InventoryDetail, { productId })),
    }),
    OpenSettings: action.navigates({
      handler: () => Effect.succeed(Nav.push(Settings)),
    }),
    Refresh: action({
      available: (state) => (state._tag === "loading" ? "Products are loading" : true),
      handler: load,
    }),
  }),
})
```

### examples/inventory/src/features/settings.ts

<!-- file: examples/examples/inventory/src/features/settings.ts -->
```ts
import { Settings } from "../screens.ts"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import { LOW_STOCK_THRESHOLD_MAX, SettingsStore } from "../domain.ts"

export const SettingsLive = Settings.implement({
  onFocus: ({ state }) =>
    Effect.gen(function* () {
      const store = yield* SettingsStore
      const loaded = yield* store.load
      yield* state.update(() => ({ _tag: "ready", ...loaded }))
    }),
  actions: (action) => ({
    RaiseLowStockThreshold: action.when("ready")({
      available: (state) =>
        state.lowStockThreshold < LOW_STOCK_THRESHOLD_MAX ? true : "Threshold is at its maximum",
      handler: (_, { state }) =>
        Effect.gen(function* () {
          const current = yield* state.get
          const store = yield* SettingsStore
          const threshold = current.lowStockThreshold + 1
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((value) => ({ ...value, lowStockThreshold: threshold }))
        }),
    }),
    SetLowStockThreshold: action.when("ready")({
      input: Schema.Struct({
        threshold: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: LOW_STOCK_THRESHOLD_MAX }),
        ),
      }),
      handler: ({ threshold }, { state }) =>
        Effect.gen(function* () {
          const store = yield* SettingsStore
          yield* store.setLowStockThreshold(threshold)
          yield* state.update((current) => ({ ...current, lowStockThreshold: threshold }))
        }),
    }),
  }),
})
```

### examples/inventory/src/fixtures.ts

<!-- file: examples/examples/inventory/src/fixtures.ts -->
```ts
import { defineFixture } from "@reflex/effect"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ApiError, InventoryApi, type Product, SettingsStore } from "./domain.ts"

/** Journeys look at the last few saves. Keeping more only costs copying. */
const SAVED_HISTORY_MAX = 32
const LOW_STOCK_THRESHOLD_DEFAULT = 10

const FixtureState = Schema.Struct({
  saved: Schema.Array(Schema.Struct({ productId: Schema.String, quantity: Schema.Int })),
  failNextSave: Schema.Boolean,
})

/** Test doubles are nodes too, so journeys and agents can observe and steer them. */
export const InventoryFixture = defineFixture({
  name: "InventoryFixture",
  state: FixtureState,
  initial: () => ({ saved: [], failNextSave: false }),
  actions: (action) => ({
    FailNextSave: action({
      description: "Make the next save fail, as a server error would",
      handler: (_, { state }) => state.update((s) => ({ ...s, failNextSave: true })),
    }),
  }),
})

export const seedProducts: ReadonlyArray<Product> = [
  { id: "product-123", title: "Blue T-Shirt", quantity: 5 },
  { id: "product-456", title: "Grey Hoodie", quantity: 40 },
  { id: "product-789", title: "Canvas Tote", quantity: 2 },
]

export interface ScenarioOptions {
  readonly products: ReadonlyArray<Product>
  readonly saveDelay?: Duration.Input
}
export const fixtureApi = (options: ScenarioOptions) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const products = new Map(options.products.map((product) => [product.id, product]))
      const state = yield* InventoryFixture

      const saveQuantity = Effect.fnUntraced(function* (productId: string, quantity: number) {
        if (options.saveDelay !== undefined) {
          yield* Effect.sleep(options.saveDelay)
        }
        const { failNextSave } = yield* state.get
        if (failNextSave) {
          yield* state.update((s) => ({ ...s, failNextSave: false }))
          return yield* new ApiError({ message: "Server error" })
        }
        const product = products.get(productId)
        if (product !== undefined) {
          products.set(productId, { ...product, quantity })
        }
        yield* state.update((s) => ({
          ...s,
          saved: [...s.saved, { productId, quantity }].slice(-SAVED_HISTORY_MAX),
        }))
      })

      return InventoryApi.of({
        list: Effect.sync(() => [...products.values()]),
        get: (id) => {
          const product = products.get(id)
          if (product === undefined) {
            return Effect.fail(new ApiError({ message: `No product "${id}"` }))
          }
          return Effect.succeed(product)
        },
        saveQuantity,
      })
    }),
  )

export const fixtureSettings = Layer.sync(SettingsStore, () => {
  let lowStockThreshold = LOW_STOCK_THRESHOLD_DEFAULT
  return SettingsStore.of({
    load: Effect.sync(() => ({
      lowStockThreshold,
      apiToken: Redacted.make("secret-fixture-token"),
    })),
    setLowStockThreshold: (value) =>
      Effect.sync(() => {
        lowStockThreshold = value
      }),
  })
})
```

### examples/inventory/src/http-api.ts

<!-- file: examples/examples/inventory/src/http-api.ts -->
```ts
import { INVENTORY_HTTP_BODY_BYTES_MAX, INVENTORY_HTTP_TIMEOUT_MS } from "./limits.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { ApiError, InventoryApi, Product } from "./domain.ts"

const ErrorBody = Schema.Struct({ message: Schema.String })
const Saved = Schema.Struct({ ok: Schema.Literal(true) })

/** Platform-neutral transport; imported only by the app's real-service composition. */
export const httpInventoryApi = (baseUrl: string) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(HttpClient.withScope(yield* HttpClient.HttpClient))
      const base = baseUrl.replace(/\/$/, "")
      const request = <A>(path: string, schema: Schema.Codec<A, unknown>, quantity?: number) =>
        Effect.gen(function* () {
          const req =
            quantity === undefined
              ? HttpClientRequest.get(`${base}${path}`)
              : HttpClientRequest.put(`${base}${path}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ quantity }),
                )
          const response = yield* client
            .execute(req)
            .pipe(
              Effect.catchTag("HttpClientError", (error) =>
                error.reason._tag === "StatusCodeError"
                  ? Effect.succeed(error.reason.response)
                  : Effect.fail(error),
              ),
            )
          // A declared size is refused before any of it is read; the rest is checked after.
          const declared = Number(response.headers["content-length"] ?? Number.NaN)
          if (declared > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const bytes = yield* response.arrayBuffer
          if (bytes.byteLength > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const buffered = HttpClientResponse.fromWeb(req, new Response(bytes))
          const decode = <T>(codec: Schema.Codec<T, unknown>) =>
            HttpClientResponse.schemaBodyJson(codec)(buffered)
          if (response.status < 200 || response.status >= 300) {
            const body = yield* decode(ErrorBody)
            return yield* new ApiError({ message: body.message })
          }
          return yield* decode(schema)
        }).pipe(
          Effect.scoped,
          Effect.catchTags({
            HttpClientError: (error) =>
              Effect.fail(
                new ApiError({
                  message:
                    error.reason._tag === "DecodeError"
                      ? "Invalid inventory JSON"
                      : "Inventory request failed",
                }),
              ),
            SchemaError: () => Effect.fail(new ApiError({ message: "Inventory request failed" })),
          }),
          Effect.timeoutOrElse({
            duration: INVENTORY_HTTP_TIMEOUT_MS,
            orElse: () => Effect.fail(new ApiError({ message: "Inventory request timed out" })),
          }),
        )
      return InventoryApi.of({
        list: request("/products", Schema.Array(Product)),
        get: (id) => request(`/products/${encodeURIComponent(id)}`, Product),
        saveQuantity: (id, quantity) =>
          request(`/products/${encodeURIComponent(id)}`, Saved, quantity).pipe(Effect.asVoid),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
```

### examples/inventory/src/limits.ts

<!-- file: examples/examples/inventory/src/limits.ts -->
```ts
/**
 * Limits of the example's own HTTP service. They belong to this app, not to Reflex:
 * the protocol's limits (packages/protocol/src/limits.ts) bound what a peer can make
 * Reflex itself hold, while these bound one app's requests to one server.
 */

/** Below the domain's five-second save deadline, so a hung server fails as `ApiError`. */
export const INVENTORY_HTTP_TIMEOUT_MS = 4_000
/** Three products fit in a few hundred bytes; anything this large is not this server. */
export const INVENTORY_HTTP_BODY_BYTES_MAX = 64 * 1024
```

### examples/inventory/src/navigation.ts

<!-- file: examples/examples/inventory/src/navigation.ts -->
```ts
import { defineNavigation } from "@reflex/effect"
import { InventoryList, InventoryDetail, Settings } from "./screens.ts"

export const Nav = defineNavigation({ InventoryList, InventoryDetail, Settings })
```

### examples/inventory/src/scenarios.ts

<!-- file: examples/examples/inventory/src/scenarios.ts -->
```ts
import * as Layer from "effect/Layer"
import app from "./app.ts"
import { httpInventoryApi } from "./http-api.ts"
import { memorySettings } from "./settings-store.ts"
import { fixtureApi, fixtureSettings, seedProducts, InventoryFixture } from "./fixtures.ts"

const services = (products: typeof seedProducts, saveDelay?: "1 second" | "30 seconds") =>
  Layer.merge(
    fixtureApi({ products, ...(saveDelay === undefined ? {} : { saveDelay }) }),
    fixtureSettings,
  )
export const testScenarios = {
  "live-services": {
    layer: Layer.merge(httpInventoryApi("http://127.0.0.1:4318"), memorySettings),
    fixtures: [],
  },
  "inventory-with-products": { description: "Three products", layer: services(seedProducts) },
  "empty-inventory": { description: "No products", layer: services([]) },
  "slow-network": {
    description: "Save exceeds deadline",
    layer: services(seedProducts, "30 seconds"),
    virtualTime: true,
  },
  "sluggish-network": {
    description: "Save in flight",
    layer: services(seedProducts, "1 second"),
    virtualTime: true,
  },
} as const
export default app.withScenarios(testScenarios, {
  defaultScenario: "inventory-with-products",
  fixtures: [InventoryFixture],
})
```

### examples/inventory/src/screens.ts

<!-- file: examples/examples/inventory/src/screens.ts -->
```ts
import { Screen } from "@reflex/effect"
import * as Schema from "effect/Schema"
import { Product, Quantity } from "./domain.ts"

const InventoryListState = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("failed", { error: Schema.String }),
  Schema.TaggedStruct("ready", {
    products: Schema.Array(Product),
    lowStockThreshold: Schema.Int,
  }),
])

export class InventoryList extends Screen("InventoryList", {
  state: InventoryListState,
  initial: () => ({ _tag: "loading" }),
}) {}

const Loaded = {
  productId: Schema.String,
  title: Schema.String,
  quantity: Quantity,
}

const InventoryDetailState = Schema.Union([
  Schema.TaggedStruct("loading", { productId: Schema.String }),
  Schema.TaggedStruct("missing", { productId: Schema.String, error: Schema.String }),
  Schema.TaggedStruct("editing", { ...Loaded, error: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("saving", Loaded),
])

export class InventoryDetail extends Screen("InventoryDetail", {
  state: InventoryDetailState,
  params: { productId: Schema.String },
  initial: ({ productId }) => ({ _tag: "loading", productId }),
}) {}

const SettingsState = Schema.Union([
  Schema.TaggedStruct("loading", {}),
  Schema.TaggedStruct("ready", {
    lowStockThreshold: Schema.Int,
    apiToken: Schema.Redacted(Schema.String),
  }),
])

export class Settings extends Screen("Settings", {
  state: SettingsState,
  initial: () => ({ _tag: "loading" }),
}) {}
```

### examples/inventory/src/settings-store.ts

<!-- file: examples/examples/inventory/src/settings-store.ts -->
```ts
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { SettingsStore } from "./domain.ts"
export const memorySettings = Layer.sync(SettingsStore, () => {
  let lowStockThreshold = 10
  return SettingsStore.of({
    load: Effect.sync(() => ({ lowStockThreshold, apiToken: Redacted.make("") })),
    setLowStockThreshold: (value) =>
      Effect.sync(() => {
        lowStockThreshold = value
      }),
  })
})
```

### examples/inventory/test/journey.ts

<!-- file: examples/examples/inventory/test/journey.ts -->
```ts
import { expect, test } from "bun:test"
import { connectJourney, createTestApp, includes } from "@reflex/test"
import app from "../src/scenarios.ts"
import { InventoryList, InventoryDetail } from "../src/screens.ts"
import { InventoryFixture } from "../src/fixtures.ts"
import { servicesJourney } from "../journeys/services.ts"

test("one story through headless services", async () => {
  await using session = await createTestApp(app, { scenario: "inventory-with-products" })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave.expectCompleted()
  })
})

test("slow save times out without losing edits", async () => {
  await using session = await createTestApp(app, { scenario: "slow-network" })
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct.expectCompleted({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity.expectCompleted({ quantity: 12 })
  const saving = await detail.actions.Save.start()
  await session.focused(InventoryDetail, { _tag: "saving" })
  await session.advanceTime("5 seconds")
  expect(await saving.expectError()).toMatchObject({ status: "error" })
  await session.focused(InventoryDetail, { _tag: "editing", quantity: 12, error: "Save timed out" })
  await session.back()
  await session.focused(InventoryList, { products: includes({ id: "product-123", quantity: 5 }) })
})

test.skipIf(process.env.REFLEX_LIVE !== "1")("the same story through the device", async () => {
  await using session = await connectJourney(app, {
    target: "device",
    scenario: "inventory-with-products",
  })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave.expectCompleted()
  })
})
```

### acceptance/cancellation.ts

<!-- file: examples/acceptance/cancellation.ts -->
```ts
import { expect } from "bun:test"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createTestApp } from "@reflex/test"
import { protocolEvents } from "@reflex/test/advanced"
import { createStore } from "zustand/vanilla"

// Compile-only acceptance case until the target runtime exists. Ignores AbortSignal.
export async function abortIgnoringPromise() {
  let entered = () => {}
  const suspended = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finished = () => {}
  const settled = new Promise<void>((resolve) => {
    finished = resolve
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const Counter = defineStoreNode({
    name: "Counter",
    store: () => createStore(() => ({ count: 0 })),
    actions: (action) => ({
      IgnoreAbort: action({
        handler: async (_, { store }) => {
          entered()
          await gate
          store.setState({ count: 99 })
          finished()
        },
      }),
    }),
  })
  const app = defineStoreApp({ name: "abort-ignoring", services: [Counter] })
  await using first = await createTestApp(app)
  const old = await first.node(Counter)
  const operation = await old.actions.IgnoreAbort.start()
  await suspended
  const next = await first.reset("default")
  const beforeRelease = protocolEvents(next).length
  release()
  await settled
  await operation.cancelled()
  expect(
    protocolEvents(next)
      .slice(beforeRelease)
      .filter((event) => event.type === "state.changed"),
  ).toEqual([])
  const fresh = await next.node(Counter)
  expect(await fresh.state()).toEqual({ count: 0 })
}
```

### apps/mobile/app/_layout.tsx

<!-- file: examples/apps/mobile/app/_layout.tsx -->
```tsx
import { Stack } from "expo-router"
import { AppProvider } from "@inventory-provider"

export default function Layout() {
  return (
    <AppProvider>
      <Stack />
    </AppProvider>
  )
}
```

### apps/mobile/app/index.tsx

<!-- file: examples/apps/mobile/app/index.tsx -->
```tsx
import { InventoryList } from "@reflex/example-inventory/screens.ts"
import { isLowStock } from "@reflex/example-inventory/domain.ts"
import { useScreenStatus } from "../src/routes.ts"
import { Pressable, Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function InventoryListView() {
  const node = useScreenStatus(InventoryList)
  const { status, state, actions } = node
  if (status === "error") {
    return (
      <Text
        onPress={() => {
          void node.retry()
        }}
      >
        {node.error.message} — Retry
      </Text>
    )
  }
  if (status === "pending") {
    return null
  }

  if (state._tag === "loading") {
    return (
      <Screen>
        <Text style={styles.title}>Inventory</Text>
        <Text>Loading…</Text>
        <Action {...actions.OpenSettings} title="Settings" />
      </Screen>
    )
  }
  if (state._tag === "failed") {
    return (
      <Screen>
        <Text style={styles.title}>Inventory</Text>
        <Text style={styles.error}>{state.error}</Text>
        <Action {...actions.OpenSettings} title="Settings" />
      </Screen>
    )
  }
  return (
    <Screen>
      <Text style={styles.title}>Inventory</Text>
      {state.products.map((product) => (
        <Pressable
          accessibilityRole="button"
          key={product.id}
          onPress={() => actions.OpenProduct.run({ productId: product.id })}
          style={styles.row}
        >
          <Text>{product.title}</Text>
          <Text>
            {product.quantity}
            {isLowStock(product, state.lowStockThreshold) ? " (low)" : ""}
          </Text>
        </Pressable>
      ))}
      <Action {...actions.OpenSettings} title="Settings" />
    </Screen>
  )
}
```

### apps/mobile/app/inventory/[productId].tsx

<!-- file: examples/apps/mobile/app/inventory/[productId].tsx -->
```tsx
import { InventoryDetail } from "@reflex/example-inventory/screens.ts"
import { useScreenStatus } from "../../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../../src/ui.tsx"

export default function InventoryDetailView() {
  const node = useScreenStatus(InventoryDetail)
  const { status, state, actions } = node
  if (status === "error") {
    return (
      <Text
        onPress={() => {
          void node.retry()
        }}
      >
        {node.error.message} — Retry
      </Text>
    )
  }
  if (status === "pending") {
    return null
  }
  if (state._tag === "loading") {
    return <Screen>{null}</Screen>
  }
  if (state._tag === "missing") {
    return (
      <Screen>
        <Text>SKU: {state.productId}</Text>
        <Text style={styles.error}>{state.error}</Text>
      </Screen>
    )
  }

  const saving = state._tag === "saving"
  return (
    <Screen>
      <Text style={styles.title}>{state.title}</Text>
      <Text>SKU: {state.productId}</Text>
      <Text>Quantity: {state.quantity}</Text>
      {state._tag === "editing" && state.error !== null && (
        <Text style={styles.error}>{state.error}</Text>
      )}
      <Action {...actions.Increment} title="Increment" />
      <Action {...actions.Save} title={saving ? "Saving…" : "Save"} />
    </Screen>
  )
}
```

### apps/mobile/app/settings.tsx

<!-- file: examples/apps/mobile/app/settings.tsx -->
```tsx
import type { ErrorBoundaryProps } from "expo-router"
import { Suspense } from "react"
import { Settings } from "@reflex/example-inventory/screens.ts"
import { useScreen } from "../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

function SettingsContent() {
  const node = useScreen(Settings)
  const { state, actions } = node
  if (state._tag === "loading") {
    return null
  }

  const { lowStockThreshold } = state
  return (
    <Screen>
      <Text style={styles.title}>Settings</Text>
      <Text>Low stock below: {lowStockThreshold}</Text>
      <Action {...actions.RaiseLowStockThreshold} title="Raise threshold" />
    </Screen>
  )
}

export default function SettingsView() {
  return (
    <Suspense fallback={null}>
      <SettingsContent />
    </Suspense>
  )
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <Text
      onPress={() => {
        void retry()
      }}
    >
      Retry Settings: {error.message}
    </Text>
  )
}
```

### apps/mobile/e2e/provider.tsx

<!-- file: examples/apps/mobile/e2e/provider.tsx -->
```tsx
import type { ReactNode } from "react"
import * as Layer from "effect/Layer"
import {
  fixtureApi,
  fixtureSettings,
  InventoryFixture,
  seedProducts,
} from "@reflex/example-inventory/fixtures.ts"
import app from "../src/app.ts"
import { testScenarios } from "@reflex/example-inventory/scenarios.ts"
import { Provider } from "../src/routes.ts"

const e2e = {
  e2e: {
    layer: Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings),
    fixtures: [InventoryFixture],
  },
}
const instrumented = app.withScenarios(
  { ...testScenarios, ...e2e },
  { defaultScenario: "e2e", fixtures: [InventoryFixture] },
)
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <Provider app={instrumented} fallback={null} bridge="development">
      {children}
    </Provider>
  )
}
```

### apps/mobile/metro.config.js

<!-- file: examples/apps/mobile/metro.config.js -->
```js
const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const root = path.resolve(__dirname, "../..")
const config = getDefaultConfig(__dirname)

const original = config.resolver.resolveRequest
const provider = process.env.REFLEX_E2E === "1" ? "e2e/provider.tsx" : "provider.tsx"
/** @type {NonNullable<typeof original>} */
const resolveRequest = (context, name, platform) => {
  if (name === "@inventory-provider") {
    return { type: "sourceFile", filePath: path.join(__dirname, provider) }
  }
  return original == null
    ? context.resolveRequest(context, name, platform)
    : original(context, name, platform)
}
module.exports = {
  ...config,
  watchFolders: [path.join(root, "packages"), path.join(root, "examples")],
  resolver: {
    ...config.resolver,
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.join(__dirname, "node_modules")],
    resolveRequest,
    extraNodeModules: {
      "@reflex/protocol": path.join(root, "packages/protocol"),
      "@reflex/runtime": path.join(root, "packages/runtime"),
      "@reflex/rpc": path.join(root, "packages/rpc"),
      "@reflex/effect": path.join(root, "packages/effect"),
      "@reflex/live": path.join(root, "packages/live"),
      "@reflex/react": path.join(root, "packages/react"),
      "@reflex/navigation": path.join(root, "packages/navigation"),
      "@reflex/expo": path.join(root, "packages/expo"),
      "@reflex/example-plain": path.join(root, "examples/plain"),
      "@reflex/example-inventory": path.join(root, "examples/inventory"),
    },
  },
}
```

### apps/mobile/plain/app/_layout.tsx

<!-- file: examples/apps/mobile/plain/app/_layout.tsx -->
```tsx
import { Stack } from "expo-router"
import { Provider } from "../routes.ts"

export default function Layout() {
  return (
    <Provider fallback={null} bridge="development">
      <Stack />
    </Provider>
  )
}
```

### apps/mobile/plain/app/index.tsx

<!-- file: examples/apps/mobile/plain/app/index.tsx -->
```tsx
import { Pressable, Text, View } from "react-native"
import { Counter } from "@reflex/example-plain"
import { useService } from "../routes.ts"

export default function CounterView() {
  const view = useService(Counter)
  if (view.status === "error") {
    return (
      <Text
        onPress={() => {
          void view.retry()
        }}
      >
        {view.error.message} — Retry
      </Text>
    )
  }
  if (view.status === "pending") {
    return null
  }
  return (
    <View>
      <Text>Count: {view.state.count}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void view.actions.Add.run({ by: 1 })
        }}
      >
        <Text>Add one</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={!view.actions.Reset.available}
        onPress={() => {
          void view.actions.Reset.run()
        }}
      >
        <Text>Reset</Text>
      </Pressable>
    </View>
  )
}
```

### apps/mobile/plain/index.tsx

<!-- file: examples/apps/mobile/plain/index.tsx -->
```tsx
import "expo-router/entry"
```

### apps/mobile/plain/routes.ts

<!-- file: examples/apps/mobile/plain/routes.ts -->
```ts
import { createReflex } from "@reflex/react"
import app from "@reflex/example-plain"
export const reflex = createReflex(app)

export const { Provider, useScreen, useScreenStatus, useService } = reflex
```

### apps/mobile/provider.tsx

<!-- file: examples/apps/mobile/provider.tsx -->
```tsx
import type { ReactNode } from "react"
import { Provider } from "./src/routes.ts"

export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <Provider fallback={null} bridge="development">
      {children}
    </Provider>
  )
}
```

### apps/mobile/src/app.ts

<!-- file: examples/apps/mobile/src/app.ts -->
```ts
import * as Layer from "effect/Layer"
import AsyncStorage from "@react-native-async-storage/async-storage"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import inventory, { productionServices } from "@reflex/example-inventory"
import { SettingsStore } from "@reflex/example-inventory/domain.ts"
import { httpInventoryApi } from "@reflex/example-inventory/http-api.ts"

const KEY = "inventory-settings:v1"
const SETTINGS_BYTES_MAX = 1024
const SavedSettings = Schema.Struct({
  version: Schema.Literal(1),
  lowStockThreshold: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
})
const defaults = { version: 1, lowStockThreshold: 10 } as const
// No credentials in AsyncStorage or EXPO_PUBLIC variables. Supply real credentials
// through the app's secure credential service; an absent credential is empty here.
const storage = Layer.succeed(
  SettingsStore,
  SettingsStore.of({
    load: Effect.tryPromise({
      try: () => AsyncStorage.getItem(KEY),
      catch: () => new Error("Settings read failed"),
    }).pipe(
      Effect.flatMap((raw) =>
        raw === null || new TextEncoder().encode(raw).byteLength > SETTINGS_BYTES_MAX
          ? Effect.succeed(defaults)
          : Schema.decodeUnknownEffect(Schema.fromJsonString(SavedSettings))(raw),
      ),
      Effect.catch(() => Effect.succeed(defaults)),
      Effect.map((value) => ({
        lowStockThreshold: value.lowStockThreshold,
        apiToken: Redacted.make(""),
      })),
    ),
    setLowStockThreshold: (lowStockThreshold) =>
      Schema.encodeEffect(Schema.fromJsonString(SavedSettings))({
        version: 1,
        lowStockThreshold,
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.tryPromise({
            try: () => AsyncStorage.setItem(KEY, raw),
            catch: () => new Error("Settings write failed"),
          }),
        ),
        Effect.orDie,
      ),
  }),
)
const baseUrl = __DEV__ ? process.env.EXPO_PUBLIC_INVENTORY_API : undefined
const deviceScenarios = {
  "device-services": {
    description: "Development HTTP and device settings",
    layer:
      baseUrl === undefined ? productionServices : Layer.merge(httpInventoryApi(baseUrl), storage),
    fixtures: [],
  },
}
const deviceApp = inventory.withScenarios(deviceScenarios, {
  defaultScenario: baseUrl === undefined ? "production" : "device-services",
})

export default deviceApp
```

### apps/mobile/src/routes.ts

<!-- file: examples/apps/mobile/src/routes.ts -->
```ts
import { createReflexExpo } from "@reflex/expo"
import app from "./app.ts"

export const reflex = createReflexExpo(app, {
  InventoryList: "/",
  InventoryDetail: "/inventory/[productId]",
  Settings: "/settings",
})

export const { Provider, useScreen, useScreenStatus, useService, Link, href } = reflex
```

### apps/mobile/src/ui.tsx

<!-- file: examples/apps/mobile/src/ui.tsx -->
```tsx
import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

export const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: "600" },
  row: { padding: 12, flexDirection: "row", justifyContent: "space-between" },
  error: { color: "#a00" },
})
export function Screen({ children }: { children: ReactNode }) {
  return <View style={{ padding: 20, gap: 12 }}>{children}</View>
}
export function Action({
  title,
  available,
  pending,
  reason,
  run,
}: {
  title: string
  available: boolean
  pending: boolean
  reason: string | null
  run: () => Promise<unknown>
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={reason ?? undefined}
      disabled={!available || pending}
      onPress={() => {
        void run()
      }}
    >
      <Text>{title}</Text>
    </Pressable>
  )
}
```

### apps/mobile/tsconfig.json

<!-- file: examples/apps/mobile/tsconfig.json -->
```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "paths": {
      "@reflex/protocol": ["../../packages/protocol/src/index.ts"],
      "@reflex/runtime": ["../../packages/runtime/src/index.ts"],
      "@reflex/rpc/connection": ["../../packages/rpc/src/server.ts"],
      "@reflex/effect": ["../../packages/effect/src/index.ts"],
      "@reflex/expo": ["../../packages/expo/src/index.ts"],
      "@reflex/example-plain": ["../../examples/plain/src/app.ts"],
      "@reflex/example-inventory": ["../../examples/inventory/src/app.ts"],
      "@reflex/example-inventory/*": ["../../examples/inventory/src/*"],
      "effect": ["./node_modules/effect"],
      "effect/*": ["./node_modules/effect/dist/*"],
      "react": ["./node_modules/@types/react/index.d.ts"],
      "expo-router": ["./node_modules/expo-router"],
      "react/jsx-runtime": ["./node_modules/@types/react/jsx-runtime.d.ts"],
      "@reflex/live": ["../../packages/live/src/index.ts"],
      "@reflex/react": ["../../packages/react/src/index.ts"],
      "@reflex/navigation": ["../../packages/navigation/src/index.ts"],
      "@reflex/react/advanced": ["../../packages/react/src/advanced.ts"],
      "@reflex/effect/advanced": ["../../packages/effect/src/advanced.ts"],
      "@inventory-provider": ["./provider.tsx"],
      "@reflex/runtime/advanced": ["../../packages/runtime/src/advanced.ts"],
      "@reflex/live/advanced": ["../../packages/live/src/advanced.ts"],
      "@reflex/expo/advanced": ["../../packages/expo/src/advanced.ts"],
      "@reflex/expo/dev": ["../../packages/expo/src/dev.ts"]
    },
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true
  },
  "include": ["app", "src", "e2e/*.ts", "hermes-smoke/*.ts", "plain", "../../packages/react/src"]
}
```

### apps/web/src/app.ts

<!-- file: examples/apps/web/src/app.ts -->
```ts
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

export const List = defineStoreNode({
  name: "List",
  store: () => createStore(() => ({ count: 0 })),
  actions: (action) => ({
    Increment: action({
      handler: (_, { store }) => store.setState((s) => ({ count: s.count + 1 })),
    }),
  }),
})
export const Detail = defineStoreNode({
  name: "Detail",
  params: z.strictObject({ id: z.string() }),
  store: ({ id }: { id: string }) => createStore(() => ({ id, count: 0 })),
  actions: (action) => ({
    Increment: action({
      handler: (_, { store }) => store.setState((s) => ({ count: s.count + 1 })),
    }),
  }),
})
export default defineStoreApp({ name: "web-counter", screens: [List, Detail] })
```

### apps/web/src/main.tsx

<!-- file: examples/apps/web/src/main.tsx -->
```tsx
import { Suspense } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import { Provider, reflex } from "./routes.ts"
import { ListView, DetailView } from "./views.tsx"

const router = createBrowserRouter(
  reflex.routes({
    List: { Component: ListView },
    Detail: {
      Component: DetailView,
      loader: async ({ params }) => ({ id: params.id }),
      errorElement: <p>Could not load detail</p>,
    },
  }),
)
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root element")
}
createRoot(root).render(
  <Provider fallback={null} bridge="development">
    <Suspense fallback={<p>Loading…</p>}>
      <RouterProvider router={router} />
    </Suspense>
  </Provider>,
)
```

### apps/web/src/routes.ts

<!-- file: examples/apps/web/src/routes.ts -->
```ts
import { createReflexRouter } from "@reflex/react-router"
import app from "./app.ts"

export const reflex = createReflexRouter(app, { List: "/", Detail: "/detail/:id" })

export const { Provider, useScreen, useScreenStatus, useService, Link, href } = reflex
```

### apps/web/src/views.tsx

<!-- file: examples/apps/web/src/views.tsx -->
```tsx
import { List, Detail } from "./app.ts"
import { useScreenStatus, Link, useScreen } from "./routes.ts"

export function ListView() {
  const view = useScreenStatus(List)
  if (view.status === "error") {
    return (
      <button
        type="button"
        onClick={() => {
          void view.retry()
        }}
      >
        Retry: {view.error.message}
      </button>
    )
  }
  if (view.status === "pending") {
    return <p>Loading…</p>
  }
  return (
    <main>
      <h1>List</h1>
      <p>Count: {view.state.count}</p>
      <button
        type="button"
        disabled={!view.actions.Increment.available}
        onClick={() => {
          void view.actions.Increment.run()
        }}
      >
        Add one
      </button>
      <Link to={Detail} params={{ id: "one" }}>
        Open detail
      </Link>
    </main>
  )
}
export function DetailView() {
  const { state, actions } = useScreen(Detail)
  return (
    <main>
      <h1>Detail {state.id}</h1>
      <p>Count: {state.count}</p>
      <button
        type="button"
        disabled={!actions.Increment.available}
        onClick={() => {
          void actions.Increment.run()
        }}
      >
        Add one
      </button>
      <Link to={List}>List</Link>
    </main>
  )
}
```

### codecs.ts

<!-- file: examples/codecs.ts -->
```ts
import { Screen, defineApp, defineNavigation } from "@reflex/effect"
import { defineStoreNode, defineStoreApp } from "@reflex/runtime"
import { createReflex } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import { routeCodec } from "@reflex/react-router/advanced"
import { jsonCodec } from "@reflex/effect/advanced"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

export class Count extends Screen("Count", {
  state: Schema.Struct({ count: Schema.Number }),
  params: { count: Schema.NumberFromString },
  initial: ({ count }) => ({ count }),
}) {}
export const Nav = defineNavigation({ Count })
export const CountLive = Count.implement({
  actions: (action) => ({
    Set: action({
      input: Schema.NumberFromString,
      error: Schema.NumberFromString,
      handler: (n, { state }) => (n < 0 ? Effect.fail(n) : state.set({ count: n })),
    }),
    Stay: action.navigates({ handler: () => Effect.succeed(Nav.stay) }),
  }),
})
export const app = defineApp({
  name: "codecs",
  navigation: Nav.implement([CountLive], { initial: { screen: Count, params: { count: 1 } } }),
})
export const reflex = createReflexRouter(app, { Count: "/count/:count" })
// Commands use decoded values; href/Link use encoded values.
Nav.push(Count, { count: 2 })
reflex.href(Count, { count: "2" })
const effectBinding = createReflex(app)
export function useSetCount() {
  const view = effectBinding.useScreenStatus(Count)
  return async () => {
    if (view.status !== "ready") {
      return null
    }
    const outcome = await view.actions.Set.run("2")
    if (outcome.status === "error") {
      const encodedError: string = outcome.error
      return encodedError
    }
    return null
  }
}
export const custom = createReflexRouter(app, {
  Count: routeCodec({
    path: "/count/*",
    decode: (raw) => ({ count: typeof raw.tail === "string" ? raw.tail : "0" }),
    encode: (params) => `/count/${encodeURIComponent(params.count)}`,
  }),
})
const encodeCount = (n: number) => ({ count: n })
const wireSpec = {
  encode: encodeCount,
  decode: (value: unknown) =>
    Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Number }))(value).pipe(
      Effect.map((value) => value.count),
    ),
  jsonSchema: { type: "object" },
}
export const wire = jsonCodec(Schema.NumberFromString, wireSpec)
interface CounterState {
  count: number
}
const initial: CounterState = { count: 0 }
export const StoreCounter = defineStoreNode({
  name: "StoreCounter",
  store: () => createStore(() => initial),
  actions: (action) => ({
    Set: action({
      input: z.string().transform(Number),
      error: z.string().transform(Number),
      projectError: (n) => String(n),
      handler: (n, { store, fail }) => {
        if (n < 0) {
          fail(n)
        }
        store.setState({ count: n })
      },
    }),
  }),
})
export const storeApp = defineStoreApp({ name: "store-codecs", services: [StoreCounter] })
export const storeBinding = createReflex(storeApp)

export class WireCount extends Screen("WireCount", { state: wire, initial: () => 1 }) {}
```

### consumer-state.ts

<!-- file: examples/consumer-state.ts -->
```ts
import { Screen, defineApp } from "@reflex/effect"
import { createReflex } from "@reflex/react"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import { InventoryList } from "./examples/inventory/src/screens.ts"
import { InventoryApi } from "./examples/inventory/src/domain.ts"
import * as Effect from "effect/Effect"
import { httpInventoryApi } from "./examples/inventory/src/http-api.ts"
import { memorySettings } from "./examples/inventory/src/settings-store.ts"

export class EncodedState extends Screen("EncodedState", {
  state: Schema.NumberFromString,
  initial: () => 1,
}) {}
export const EncodedLive = EncodedState.implement({
  actions: (action) => ({ Increment: action.reduce({ reducer: (_, n) => n + 1 }) }),
})
const reflex = createReflex(defineApp({ name: "encoded-state", screens: [EncodedLive] }))
export function EncodedView() {
  const view = reflex.useScreenStatus(EncodedState)
  if (view.status === "ready") {
    const encoded: string = view.state
    void encoded
  }
  return null
}
const Reader = InventoryList.implement({
  actions: (action) => ({
    Read: action({
      handler: () =>
        Effect.gen(function* () {
          yield* InventoryApi
        }),
    }),
  }),
})
const commonLayer = Layer.merge(httpInventoryApi("http://127.0.0.1:4318"), memorySettings)
export const common = defineApp({
  name: "common",
  screens: [Reader],
  layer: commonLayer,
  scenarios: { default: {} },
  defaultScenario: "default",
})
export const extended = common.withScenarios({ other: {} }, { defaultScenario: "other" })
export const twice = extended.withScenarios({ third: {} })
const oldDefault: "default" = common.defaultScenario
const newDefault: "other" = twice.defaultScenario
void oldDefault
void newDefault

export class Secret extends Screen("Secret", {
  state: Schema.Struct({ token: Schema.Redacted(Schema.String) }),
  initial: () => ({ token: Redacted.make("fixture-only") }),
}) {}
const SecretLive = Secret.implement({ actions: () => ({}) })
const secretBinding = createReflex(defineApp({ name: "secret", screens: [SecretLive] }))
export function SecretView() {
  const view = secretBinding.useScreenStatus(Secret)
  if (view.status === "ready") {
    const safe: "<redacted>" = view.state.token
    void safe
  }
  return null
}
```

### examples/live-counter/src/app.ts

<!-- file: examples/examples/live-counter/src/app.ts -->
```ts
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"

export const Counter = defineStoreNode({
  name: "Counter",
  store: () => {
    let state = { count: 0 }
    const listeners = new Set<() => void>()
    return {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      increment: () => {
        state = { count: state.count + 1 }
        for (const listener of listeners) {
          listener()
        }
      },
    }
  },
  actions: (action) => ({ Increment: action({ handler: (_, { store }) => store.increment() }) }),
})
export default defineStoreApp({ name: "live-counter", services: [Counter] })
```

### examples/live-counter/src/serve.ts

<!-- file: examples/examples/live-counter/src/serve.ts -->
```ts
import { serveLive } from "@reflex/live"
import app from "./app.ts"

const setting = process.env.REFLEX_BRIDGE
if (!setting) {
  throw new Error("Set REFLEX_BRIDGE to the appSetting printed by reflex --target device start")
}
const server = await serveLive(app, { setting })
const shutdown = () => {
  void server.close().catch(console.error)
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
```

### reset.ts

<!-- file: examples/reset.ts -->
```ts
import { createTestApp, connectJourney } from "@reflex/test"
import app from "./examples/inventory/src/scenarios.ts"
import { InventoryFixture } from "./examples/inventory/src/fixtures.ts"
import { InventoryList } from "./examples/inventory/src/screens.ts"
import { servicesJourney } from "./examples/inventory/journeys/services.ts"

export async function resetAndReacquire() {
  await using initial = await createTestApp(app)
  const next = await initial.reset("empty-inventory")
  const list = await next.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenSettings.expectCompleted()
  // initial and its handles are invalid now. Ownership stays with initial's disposer.
}
export async function fixtureStory() {
  await using session = await createTestApp(app, { scenario: "inventory-with-products" })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave.expectCompleted()
  })
}
export async function realServiceStory(failNextSave: () => Promise<void>) {
  await using session = await connectJourney(app, { target: "device", scenario: "live-services" })
  await servicesJourney(session, failNextSave)
}
```

### static-limits.ts

<!-- file: examples/static-limits.ts -->
```ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Screen } from "@reflex/effect"
import { Nav } from "./examples/inventory/src/navigation.ts"
import { InventoryDetail, InventoryList } from "./examples/inventory/src/screens.ts"
import { createReflexRouter } from "@reflex/react-router"
import { app } from "./codecs.ts"
import { Count } from "./codecs.ts"

// Deliberate compilable counterexamples, NOT recommended author idioms.
// TypeScript erases commands through Effect<void>. Lint/runtime remains necessary.
const erased: Effect.Effect<void> = Effect.succeed(Nav.back)
InventoryList.implement({ actions: (action) => ({ Erased: action({ handler: () => erased }) }) })
// A plain action can discard an expression. The runtime rejects an unused command.
InventoryList.implement({
  actions: (action) => ({
    Dropped: action({
      handler: () =>
        Effect.gen(function* () {
          yield* Effect.void
          Nav.back
        }),
    }),
  }),
})
// TypeScript is structural. Registry lookup must use exact constructors.
export class Subclass extends InventoryDetail {}
const assignable: typeof InventoryDetail = Subclass
void assignable
// Empty subclasses do not create a new static identity.
export class StructuralScreen extends Screen("StructuralScreen", {
  state: Schema.Number,
  initial: () => 0,
}) {}
// JS class name differs from declared contract name. Diagnostics use the latter.
export class DifferentClassName extends Screen("DeclaredName", {
  state: Schema.Number,
  initial: () => 0,
}) {}
// A 60-segment root route is accepted without TS2589 (tail accumulator parser).
export const longPath = createReflexRouter(app, {
  Count:
    "/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/:count",
})
longPath.href(Count, { count: "1" })
```

## 5. Implementation boundary requirements

- Every action input/error and route param must encode JSON. Diagnostics say
  Input/Error/Params must encode JSON; use jsonCodec. Consumer errors expose the
  published <redacted> marker, never the Effect Redacted wrapper.
- Provision stages are fixtures → common layer → scenario layer → handlers. A layer
  cannot satisfy its own inputs; check inputs against the preceding stage. Coverage
  excludes Scope because each action owns a child scope. Omitting scenarios still
  checks production coverage and preserves the literal default scenario name.
- Action values carry their decoded state and a private runtime builder brand. Reject
  Save: 123 and reducers moved between incompatible state types. Composition enforces
  screen/service/store roles and duplicate names across navigation and ambient roles.
- Navigation identity includes contract names even without an explicit key; runtime
  validates the exact owner. Foreign-owner errors name the action and navigator and
  explain which navigation to use. push infers its target before checking params.
- Ambient services cannot require unprovided params. Store projections and param JSON
  are checked at composition without disrupting destructured factory inference.
- Scenario store overrides are definition-keyed: stores: [Counter.withStore(factory)].
  Factories retain store and params types; overrides must belong to the app.
- The E2E provider installs exported testScenarios so device journeys can reset to
  fixture scenarios. With no API env var, production uses offline/production-safe
  services. A loopback HTTP endpoint is never an implicit production fallback.
- HTTP services use HttpClient.filterStatusOk, HttpClientResponse.schemaBodyJson and
  catchTags, retaining the response-size and timeout bounds.
- Public phantom requirements/publicState/paramsType/encodedParams/role/contract
  fields must be packed under one symbol key. Coverage has one implementation.
  Constructor-family aliases are optional where cheap; Effect-free store composition
  remains separate so adopting stores does not import Effect.
- Runtime diagnostics need a message catalogue exercised through both SessionController
  and LiveController. The command-erasure lint rule is explicit follow-up work.
- Real-package compilation of the exact authored examples is an implementation
  acceptance requirement; declaration-only compilation cannot establish runtime parity.

The Effect author tier now packs phantom metadata under a symbol and implements the
HTTP rewrite, runtime command diagnostics and real-package inventory harness. Consumer
and store tiers, complete type-export example coverage, and the command-erasure lint
rule remain later work; the full design is not yet a shipped API.

## 6. Validation

Run bun docs/design/prototypes/check.ts for the executable target. This validates the
proposed declarations and compiled examples; it does not validate the package runtime.
The implementation migration must additionally compile these exact examples against real
package exports and run the runtime/browser/production-exclusion suites. Do not mark this
reference implemented until that evidence exists.

### Restored capabilities

<!-- file: examples/capabilities.tsx -->
```tsx
import { expect } from "bun:test"
import { Screen, defineApp, defineNavigation } from "@reflex/effect"
import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import { createRuntime, mountOwned } from "@reflex/runtime/advanced"
import { createReflex } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import { createReflexExpo } from "@reflex/expo"
import { createTestApp, explore } from "@reflex/test"
import { createProtocolTestSession } from "@reflex/test/advanced"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

class Detail extends Screen("Detail", {
  state: Schema.Struct({ id: Schema.String, count: Schema.Number }),
  params: { id: Schema.String },
  initial: ({ id }) => ({ id, count: 0 }),
}) {}
const Nav = defineNavigation({ Detail })
const save = (
  input: number,
  { state }: import("@reflex/effect").EffectContext<typeof Detail.state.Type>,
) => state.update((s) => ({ ...s, count: input }))
const detail = Detail.implement({
  actions: (a) => ({
    Save: a({ input: Schema.Number, handler: save }),
    Back: a.navigates({ handler: () => Nav.back }),
    Scoped: a({ handler: () => Effect.asVoid(Effect.forkScoped(Effect.void)) }),
    SecretError: a({
      error: Schema.Redacted(Schema.String),
      handler: () => Effect.fail(Redacted.make("private")),
    }),
  }),
})
export const app = defineApp({
  name: "capabilities",
  navigation: Nav.implement([detail], { initial: { screen: Detail, params: { id: "first" } } }),
})
const { Provider, useScreen, useScreenStatus, Link, href, from } = createReflexRouter(app, {
  Detail: "/:id",
})
const feature = from(detail)
export function DetailView() {
  const { state, actions } = useScreen(Detail)
  const count = feature.useNodeState((s) => s.count)
  const saveAction = feature.useAction("Save")
  return (
    <Provider bridge="development">
      <Link
        to={Detail}
        params={{ id: state.id }}
        title={href(Detail, { id: state.id })}
        onClick={() => {
          void saveAction.run(count + 1)
          void actions.Back.run()
        }}
      >
        Detail
      </Link>
    </Provider>
  )
}
export function OptionalStatus() {
  return useScreenStatus(Detail).status
}
export const expo = createReflexExpo(app, { Detail: { pathname: "/[id]" } })
const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => ({ count: 0 })),
  actions: (a) => ({
    Set: a({
      input: standardInput(z.number(), { type: "number" }),
      handler: (count, { store }) => store.setState({ count }),
    }),
  }),
})
export const storeApp = defineStoreApp({ name: "overrides", services: [Counter] }).withScenarios({
  seeded: { stores: [Counter.withStore(() => createStore(() => ({ count: 5 })))] },
})
export const { useService } = createReflex(storeApp)
export async function journey() {
  await using session = await createTestApp(app)
  const node = await session.focused(Detail)
  const outcome = await node.actions.SecretError.run()
  if (outcome.status === "error") {
    const marker: "<redacted>" = outcome.error
    expect(marker).toBe("<redacted>")
  }
  const refused = await node.actions.Back.expectRefusal()
  expect(refused.reason).toBeString()
}
export async function storeOverride() {
  await using session = await createTestApp(storeApp, { scenario: "seeded" })
  const counter = await session.node(Counter)
  expect(await counter.state()).toEqual({ count: 5 })
}
export async function advanced() {
  await using runtime = await createRuntime(storeApp)
  const node = mountOwned(runtime, Counter)
  const stop = node.changes.subscribe((state) => {
    const count: number = state.count
    void count
  })
  await node.actions.Set.run(node.state.count + 1)
  stop()
  await node.dispose()
}
export async function exploreCounter() {
  await explore(storeApp, {
    steps: 10,
    knownInputs: { Counter: { Set: [1, 2] } },
    invariant: async (session) => {
      const node = await session.node(Counter)
      expect((await node.state()).count).toBeGreaterThanOrEqual(0)
    },
  })
}
export async function protocol() {
  await using session = await createProtocolTestSession(storeApp)
  await session.request("app.dispatch", { action: 123 })
  await session.request("app.wait", { operationId: "missing" })
  expect(session.events().map((event) => event.type)).toEqual([])
}
const HostDetail = defineStoreNode({
  name: "HostDetail",
  params: z.object({ id: z.string() }),
  store: ({ id }) => createStore(() => ({ id })),
  actions: () => ({}),
})
export async function openStoreRoute() {
  const app = defineStoreApp({ name: "host-routed", screens: [HostDetail] })
  await using session = await createTestApp(app)
  const detail = await session.open(HostDetail, { id: "one" })
  expect(await detail.state()).toEqual({ id: "one" })
}
```

### Integration plumbing

<!-- file: examples/plumbing.ts -->
```ts
import { createReflex } from "@reflex/react"
import { createRouteAdapter } from "@reflex/react/advanced"
import { createRouteRegistry } from "@reflex/runtime/advanced"
import { createSessionOwner } from "@reflex/live/advanced"
import { connectBridge } from "@reflex/live"
import { developmentBridge } from "@reflex/live/dev"
import { createTestAppPool } from "@reflex/test"
import { createJourneyClient, type JourneyTransport } from "@reflex/test/advanced"
import { defineService } from "@reflex/effect"
import * as Schema from "effect/Schema"
import app from "./examples/plain/src/app.ts"

// Registry and adapter ports are integration plumbing, not the application-author tier.
export async function registryLifecycle(contract: object) {
  const registry = createRouteRegistry(
    new Map([[contract, async (params: unknown) => ({ params })]]),
  )
  const lease = registry.acquire(contract, "history-entry", {})
  const release = lease.retain()
  await lease.ready
  await lease.retry()
  release()
  await registry.discard("history-entry")
  await registry.dispose()
}
export const HostAdapter = createRouteAdapter(createReflex(app), {
  useLocation: () => ({ key: "host-key", contract: {}, params: {}, navigationType: "POP" }),
})
export async function bridgeLifecycle(setting: string) {
  const owner = createSessionOwner(async () => connectBridge(setting))
  await owner.close()
  // The React Provider owns this lifecycle in the normal host tier.
  const bridge = developmentBridge()
  await bridge?.close()
}
export async function remoteJourney(transport: JourneyTransport) {
  await using journey = createJourneyClient(app, "default", transport)
  await journey.reset("default")
}
export async function pooledJourney() {
  const pool = createTestAppPool()
  try {
    await pool.open(app)
  } finally {
    await pool.disposeAll()
  }
}
export const Metrics = defineService({
  name: "Metrics",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({ Increment: a.reduce({ reducer: (_, n) => n + 1 }) }),
})
```

## Implementation deviations

A1 retains legacy overloads and adds `legacyApp` under `@reflex/effect/internal` while
old consumers migrate. Inventory's `scenarios.ts` exports the authored value as
`authoredApp` and adapts its default export to the existing journey API. Feature and
screen aliases preserve mobile imports. Production composition remains the exact
compiled example, with no implicit HTTP fallback.

TypeScript 5.9 requires two declaration-level inference corrections: one-step builders
use the already inferred codec state directly (the outer `NoInfer` made tagged guards
infer `never`), and the omitted-scenarios `defineApp` overload infers the whole spec
before checking common-layer coverage. Callable behavior and coverage rules are
unchanged. The declaration harness and real-package negative tests include these
corrections. Author phantom metadata is symbol-packed in the implementation; the
reference model's consumer fields remain declaration plumbing until their migration.

The HTTP example now uses `filterStatusOk`, `schemaBodyJson`, and `catchTags`, while
retaining byte/deadline bounds and the established invalid-JSON error message. Its
extracted example and this document are kept identical.

A2 adds the store author path alongside the legacy store overloads. The plain example
exports its service-based composition as `authoredApp`; its default remains the
screen-based `plainBackend` adapter for unchanged mobile and live conformance consumers
until B. The exact extracted plain and live-counter examples compile against the real
packages. `serveLive` already satisfied the process example and needed no change.

Legacy callable actions and transformed-error handlers remain supported: `fail` also
accepts a validator's input for those existing handlers. Authored decoded failures can
use `projectError`; both the declaration and published JSON are checked. Explicit
`project` callbacks retain the existing node-level JSON constraint, while omitted
projections are checked at app composition. Actual state is checked at mount, so app
composition does not instantiate stores. Advanced owned store handles use the new
outcome vocabulary; old hosts and journeys retain their current outcomes until B.

B1 adds the app-bound React and React Router bindings while retaining the round-3
exports for Expo. New bound action views use the target outcomes; legacy node views
retain their earlier outcomes. The host-neutral development bridge entry is inert;
Vite selects the existing Vite implementation through an alias, so the Provider owns
its lifecycle without pulling a dialler into other hosts or production bundles.

TypeScript diagnostics also carry a fixed `Reflex type error` property alongside the
readable mapped message. Legacy app names can be widened to string, and a template
index signature alone would otherwise permit invalid contracts without an error.
Authored constructor names are restored from their declared contract name after
implementation, preserving unchanged legacy adapters in minified bundles.

B2 installs the authored Expo binding and mobile examples alongside retained legacy
integration internals. Expo exposes its advanced route helpers through the single
internal entry rather than adding a second integration subpath. The Effect-free dev
entry is separate; round-3 root aliases remain during the additive migration. Metro
aliases the host-neutral development helper to Expo's helper.
The E2E provider additionally retains startup-failure instrumentation and scenario
selection needed by the existing browser journeys. Plain's legacy adapter remains a
named conformance fixture; its default is now the authored composition. The real-package
harness includes exact mobile examples and Expo negative cases. See ADR 0027.
