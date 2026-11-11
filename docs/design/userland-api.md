# Reflex userland API specification, revision 2

Status: proposed target API; **no runtime implementation is changed or claimed**.
Revision 1 baseline: `9debc24` on `origin/userland-api-spec`. Rubric:
[api-principles.md](../api-principles.md). Architecture, protocol/controller parity,
access policy and dependency boundaries remain authoritative. This design does not
implement a roadmap item or supersede a shipped ADR. An implementation needs its own
ADR and roadmap update. Changes in this revision stay in this file and prototypes/.

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
diagnostics, and measures the 0/10/50/100-screen graph with 0/1/10 hooks per screen.
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
The repository check does not invoke this proposed API; both commands are required for
this design review. Wiring the harness into CI is an implementation acceptance task
because this change may not edit package.json or scripts/.

## 2. Core model and decisions

1. **Contract and implementation identities stay separate.** `Screen(name, spec)`
   produces a base constructor; a class contract carries state/params and `.implement`
   returns a separate frozen definition with actions/requirements. A session selects
   implementations. UI and navigation accept contract values, never implementation
   names as strings. Implementations do not have `resolve` or carry a global selection.
   A one-step `Screen.define(name, {state, initial, actions})` returns a combined
   constructor/implementation when there is no implementation selection. It has the
   same app-bound consumer API. Its identity is still its actual runtime constructor.
2. **Drop Self.** Authored split contracts use `declare private readonly nominal: undefined`.
   This distinguishes independent same-shape classes; Self adds no protection. TS cannot
   inspect a private member, and subclasses inherit it. We choose the cheaper honest
   limit: runtime registration/lookup uses **exact constructor equality**, never
   `instanceof`, `prototype` ancestry or string name equality. Missing-private-line
   contracts and inherited subclasses can be structurally assignable statically;
   `static-limits.ts` preserves these counterexamples. A missing private line is lintable,
   not a claimed compiler diagnostic. A registered constructor's subclass is a distinct,
   unregistered contract. JS class names may differ from declared names: registration
   keys and diagnostics use the declared string; identities use constructors.
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
   `action.navigates` must return `Effect<NavigationCommand>`; a missing return, discarded
   command or an `Effect<void>` helper in this tier fails compilation. `action` and
   `onFocus` infer success/error before checking: visible command successes produce
   `Use action.navigates for actions that navigate`; undeclared errors produce
   `Declare action failures with error:`; lifecycle errors produce
   `Handle onFocus failures into state`. The declared error field is `error`, the outcome
   status is `"error"`, and journeys use `expectError`. No command is an Effect or has
   `pipe`; `yield* Nav.back` produces **TS2488**, with no invented custom diagnostic.
6. **Static erasure is real.** TS permits an Effect command to be widened to `Effect<void>`
   and accepts unused expression statements in a plain action. Types cannot recover this.
   Require a lint rule for command expressions, commands erased through void-returning
   helpers, and yielded commands. Runtime tracks command creation by operation: exactly
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
8. **Correlated complete argument tuples.** `push` and `href` take a union of whole tuples,
   not a generic target plus a separately inferred params object. Initial routes are
   a union of whole `{screen, params}` objects or a param-free contract. `Link` props are
   likewise a union. Narrow a union target first, or carry the entire correlated tuple.
   Navigation and initial routes take **decoded** params. href, Link and advanced URL
   codecs consume **encoded** params; NumberFromString therefore takes a number for
   push and a string for href. No params means zero arguments, not `{}`.
9. **Store inference and codecs.** `StateOf<T>` derives the return of getState, never
   infers state from `T extends Store<S>`. NoInfer prevents project/availability/builders
   from changing it. Parameterized store factories may need one definition-site params
   annotation; the web Detail file demonstrates the TS inference boundary, without a
   call-site generic. Infer the whole Effect codec or Standard Schema validator; use
   decoded output for handlers and encoded input for consumers. Standard Schema only
   validates: it cannot invert an arbitrary transform. Transformed store errors require
   projectError to explicitly encode their decoded domain error; the codecs example does
   so. An automatic inverse for Standard Schema is **unproven and not promised**.
   Effect codecs have their own encode operation. jsonCodec preserves its source C (including Type and Encoded) and returns a
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
14. **Provider is app-bound.** Ordinary `<reflex.Provider>` needs no app prop. Only a
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
    hooks acquire at commit; Suspense may request at render, but the session owns the
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
19. **Host idioms.** Both hosts offer `<reflex.Link to={Detail} params={{id}} />` and
    `reflex.href(Detail, {id})`. Expo owns its files/Stack and puts Suspense/error boundaries
    per screen, never around the entire Stack. React Router routes accepts host options
    `{ Component, loader, action, errorElement, shouldRevalidate, lazy }` per screen;
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
    Journey actions have one map: detail.actions.Save(), .Save.expectError(),
    .Save.expectRefusal(), .Save.start(). A TypedClient is JourneyClient with outcome
    mode, not a parallel interface. Shared stories accept Pick of the capabilities they
    use. Both fixture and real-service calls compile. Use await using or pool+afterEach;
    no unowned test session. advanceTime takes Duration.Input. Match timeouts name the
    contract, requested match, timeout and **last state seen**, including pending/error.
21. **Export reduction.** No Self, resolve, root node map, queued-navigation layer,
    public /internal entries, duplicated mountOwned/routeCodec/developmentBridge functions,
    StateSource, or parallel Bridge types. runtime/advanced owns mountOwned;
    effect/advanced owns mountEffect. live owns Bridge and live/dev implements
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

The proposed performance gate is **at most 2,000 additional instantiations per screen**
between 10→50 and 50→100, including a unique useScreen consumer, plus **100 per repeated
identical useScreen call**. It is enforced in check.ts, in addition to recording the
baseline. These are provisional upper gates, not a claim that 1,999 is cheap. Compare
same compiler/dependencies and graph; lower the gate after representative implementation
measurements. A count of repeated identical calls measures compiler caching, not the
cost of a new contract selection. The harness reports 0/1/10 hooks and both slopes so
that caching cannot disguise the unique-consumer cost. No claim is made about editor
latency from tsc counts alone. Results are recorded in prototypes/results.json.

Static misuse rows below are generated from @case annotations. The checker asserts
marker **text plus exact source line** and rejects additional diagnostics. Ordinary TS
messages are used when the surface cannot supply a marker. The old row numbers are
superseded by stable case IDs. In particular old rows 19/21 now use inferred error channels;
old row 20 honestly uses the TS parameter incompatibility; old row 35 honestly uses the
missing component property; none relies on exactOptionalPropertyTypes wording.

### Verified negative cases

| Case                      | Expected marker or diagnostic fragment                                                | Executable source                           |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| role-fixture              | `InventoryFixture is not a screen of app 'inventory'`                                 | [case](prototypes/negative/cases.ts#L35)    |
| nominal                   | `This InventoryDetail is a different contract from app 'inventory''s InventoryDetail` | [case](prototypes/negative/cases.ts#L44)    |
| screen-service            | `InventoryDetail is not a service of app 'inventory'`                                 | [case](prototypes/negative/cases.ts#L46)    |
| fixture-service           | `InventoryFixture is not a service of app 'inventory'`                                | [case](prototypes/negative/cases.ts#L48)    |
| absent-fixture            | `InventoryFixture is not a fixture of this scenario of app 'inventory'`               | [case](prototypes/negative/cases.ts#L51)    |
| union-fixture             | `InventoryFixture is not a fixture of this scenario of app 'inventory'`               | [case](prototypes/negative/cases.ts#L55)    |
| duplicate-implementation  | `InventoryList is declared more than once`                                            | [case](prototypes/negative/cases.ts#L57)    |
| missing-implementation    | `InventoryDetail`                                                                     | [case](prototypes/negative/cases.ts#L59)    |
| unknown-params            | `productId`                                                                           | [case](prototypes/negative/cases.ts#L61)    |
| union-push                | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L63)    |
| no-params                 | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L65)    |
| decoded-command           | `not assignable to type 'number'`                                                     | [case](prototypes/negative/cases.ts#L67)    |
| encoded-href              | `not assignable to type 'string'`                                                     | [case](prototypes/negative/cases.ts#L69)    |
| union-href                | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L72)    |
| initial-correlation       | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L74)    |
| yielded-command           | `TS2488`                                                                              | [case](prototypes/negative/cases.ts#L77)    |
| command-pipe              | `Property 'pipe' does not exist`                                                      | [case](prototypes/negative/cases.ts#L80)    |
| plain-navigation          | `Use action.navigates for actions that navigate`                                      | [case](prototypes/negative/cases.ts#L85)    |
| undeclared-error          | `Declare action failures with error:`                                                 | [case](prototypes/negative/cases.ts#L89)    |
| undeclared-input          | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L93)    |
| dropped-navigation        | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L98)    |
| erased-navigation         | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L105)   |
| refusal-command           | `Navigation refusal recovery must return void`                                        | [case](prototypes/negative/cases.ts#L110)   |
| focus-error               | `Handle onFocus failures into state`                                                  | [case](prototypes/negative/cases.ts#L117)   |
| focus-navigation          | `Use action.navigates for actions that navigate`                                      | [case](prototypes/negative/cases.ts#L122)   |
| transformed-store-input   | `not assignable to parameter of type 'string'`                                        | [case](prototypes/negative/cases.ts#L127)   |
| transformed-effect-input  | `not assignable to parameter of type 'string'`                                        | [case](prototypes/negative/cases.ts#L132)   |
| json-date                 | `Store state must be JSON; provide project`                                           | [case](prototypes/negative/cases.ts#L135)   |
| json-function             | `Store state must be JSON; provide project`                                           | [case](prototypes/negative/cases.ts#L141)   |
| no-fail                   | `Property 'fail' does not exist`                                                      | [case](prototypes/negative/cases.ts#L156)   |
| rich-error                | `Store error must be JSON; provide projectError`                                      | [case](prototypes/negative/cases.ts#L161)   |
| store-command             | `Store handlers cannot return NavigationCommand`                                      | [case](prototypes/negative/cases.ts#L164)   |
| duplicate-service         | `Counter is declared more than once`                                                  | [case](prototypes/negative/cases.ts#L169)   |
| multiple-roles            | `Choose navigation or screens, not both`                                              | [case](prototypes/negative/cases.ts#L171)   |
| initial-schema            | `not assignable to type 'number'`                                                     | [case](prototypes/negative/cases.ts#L181)   |
| includes-typo             | `qty`                                                                                 | [case](prototypes/negative/cases.ts#L184)   |
| match-variant             | `State match fields must belong to one variant`                                       | [case](prototypes/negative/cases.ts#L186)   |
| unknown-scenario          | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L188)   |
| extension-default         | `withScenarios defaultScenario must exist`                                            | [case](prototypes/negative/cases.ts#L190)   |
| extension-repeat          | `Scenario live-services already exists; choose a new name`                            | [case](prototypes/negative/cases.ts#L192)   |
| repeated-placeholder      | `Repeated path placeholder id`                                                        | [case](prototypes/negative/cases.ts#L195)   |
| group                     | `Excluded route grammar; use routeCodec`                                              | [case](prototypes/negative/cases.ts#L197)   |
| catchall                  | `Excluded route grammar; use routeCodec`                                              | [case](prototypes/negative/cases.ts#L199)   |
| spread                    | `Excluded route grammar; use routeCodec`                                              | [case](prototypes/negative/cases.ts#L201)   |
| optional-grammar          | `Excluded route grammar; use routeCodec`                                              | [case](prototypes/negative/cases.ts#L203)   |
| optional-placeholder      | `Optional route param tab cannot be a path placeholder`                               | [case](prototypes/negative/cases.ts#L205)   |
| unmatched-placeholder     | `Path placeholder other has no matching param; add a params mapping`                  | [case](prototypes/negative/cases.ts#L207)   |
| missing-placeholder       | `Required route param id must appear as a path placeholder`                           | [case](prototypes/negative/cases.ts#L209)   |
| mapping-duplicates        | `URL param mapping targets must be unique`                                            | [case](prototypes/negative/cases.ts#L211)   |
| mapping-keys              | `URL param mapping names must be schema fields`                                       | [case](prototypes/negative/cases.ts#L213)   |
| dynamic-path              | `Route path must be a literal; use advanced routeCodec for dynamic paths`             | [case](prototypes/negative/cases.ts#L215)   |
| numeric-url               | `URL param id must encode a string; use a string codec`                               | [case](prototypes/negative/cases.ts#L217)   |
| registration-missing      | `Settings`                                                                            | [case](prototypes/negative/cases.ts#L219)   |
| component-missing         | `Settings`                                                                            | [case](prototypes/negative/cases.ts#L226)   |
| href-union                | `not assignable`                                                                      | [case](prototypes/negative/cases.ts#L228)   |
| zero-arity                | `Expected 0 arguments, but got 1`                                                     | [case](prototypes/negative/cases.ts#L239)   |
| missing-navigator         | `Action Go of app 'no-nav' requires a navigator`                                      | [case](prototypes/negative/cases.ts#L245)   |
| missing-service           | `Scenario 'missing' must provide`                                                     | [case](prototypes/negative/cases.ts#L247)   |
| missing-fixture           | `Scenario 'missing-fixture' must provide`                                             | [case](prototypes/negative/cases.ts#L255)   |
| fixture-action-service    | `Scenario 'missing' must provide`                                                     | [case](prototypes/negative/cases.ts#L267)   |
| role-collision            | `ParamFree is declared more than once`                                                | [case](prototypes/negative/cases.ts#L269)   |
| missing-default           | `defaultScenario`                                                                     | [case](prototypes/negative/cases.ts#L271)   |
| record-alias              | `Navigation key Second must match contract name InventoryDetail`                      | [case](prototypes/negative/cases.ts#L273)   |
| effect-rich-state         | `Effect state must encode JSON; use jsonCodec`                                        | [case](prototypes/negative/cases.ts#L275)   |
| fixture-navigates         | `Property 'navigates' does not exist`                                                 | [case](prototypes/negative/cases.ts#L282)   |
| readonly-state            | `read-only property`                                                                  | [case](prototypes/negative/cases.ts#L288)   |
| transformed-error-encoder | `projectError`                                                                        | [case](prototypes/negative/cases.ts#L295)   |
| unknown-input-presence    | `Expected 1 arguments, but got 0`                                                     | [case](prototypes/negative/cases.ts#L310)   |
| link-required             | `params`                                                                              | [case](prototypes/negative/links.tsx#L24)   |
| link-name                 | `not assignable`                                                                      | [case](prototypes/negative/links.tsx#L26)   |
| expo-link-name            | `not assignable`                                                                      | [case](prototypes/negative/links.tsx#L28)   |
| link-union                | `not assignable`                                                                      | [case](prototypes/negative/links.tsx#L31)   |
| initial-union             | `not assignable`                                                                      | [case](prototypes/negative/links.tsx#L34)   |
| expo-href-union           | `not assignable`                                                                      | [case](prototypes/negative/links.tsx#L37)   |
| owned-params              | `Expected 3 arguments, but got 2`                                                     | [case](prototypes/negative/ownership.ts#L5) |

### Runtime obligations and unproven acceptance cases

These rows are **not passing runtime tests**. The target runtime does not exist. Every
row must become an executable negative acceptance test against both SessionController
and LiveController where the protocol exposes it. It would be dishonest to assert a tsc
marker for a Promise's behavior, disposal, a React boundary or a device fingerprint.
The compiled abort-ignoring case is an acceptance program, not runtime evidence.

| Case                            | Required rejection or observable result                                                                                                                                                                              | Phase                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| missing-nominal/subclass        | Exact constructor registry rejects an unregistered Subclass; message names InventoryDetail and suggests registering its own contract. Missing private line remains statically assignable; lint documents this limit. | Runtime obligation + static counterexample               |
| class/string mismatch           | DifferentClassName diagnostics name DeclaredName; identity remains its constructor.                                                                                                                                  | Runtime obligation                                       |
| extra implementation            | Reject foreign or extra definitions, even when every required contract also has an implementation.                                                                                                                   | Runtime obligation                                       |
| duplicate dynamic definitions   | App x declares Counter more than once; keep one definition. Check all screens, services and effective fixtures.                                                                                                      | Runtime obligation                                       |
| shared contract in navigations  | Reject a contract registered in two session navigation owners; separate app values may reuse contracts.                                                                                                              | Runtime obligation; advanced multi-owner typing unproven |
| fixture service key             | App inventory scenario live-services must provide inventory/InventoryApi. Static coverage names the identifier; Context key string interpolation is unproven.                                                        | Runtime obligation                                       |
| invalid initial refinement      | Counter initial.count must be an integer; fix initial(). Never install the invalid node.                                                                                                                             | Runtime obligation                                       |
| invalid projected number        | Counter state.count must be a finite JSON number; fix the projection.                                                                                                                                                | Runtime obligation                                       |
| malformed URL                   | InventoryDetail route params.productId are invalid; correct the URL. Preserve previous committed focus.                                                                                                              | Runtime obligation                                       |
| wrong route file                | useScreen(Settings) in InventoryDetail's entry reports expected InventoryDetail, received Settings, and the route key.                                                                                               | Runtime obligation                                       |
| no Suspense boundary            | React/lint reports missing per-screen boundary; no library compile marker is promised.                                                                                                                               | Unproven lint/integration obligation                     |
| normal rejected build           | Observe status:error, retry once, get a fresh build; pending lease and subscription are released once.                                                                                                               | Runtime obligation                                       |
| Suspense rejected build         | Boundary sees build error; resetting it retries the same registry entry with a new promise, without affecting sibling screens.                                                                                       | Runtime obligation                                       |
| startup failure                 | Fallback while starting; status observer sees failed; nearest error boundary receives cause; reset/remount retries.                                                                                                  | Runtime obligation                                       |
| Provider identity               | Provider app must share the binding's app identity; use app.withScenarios. Structural same-name apps fail runtime validation.                                                                                        | Runtime obligation                                       |
| unused/erased command           | Reject unused, multiple, void-erased, service/fixture or onFocus commands; require action.navigates and Nav.stay. Lint must catch discarded expressions and TS2488 misuse earlier.                                   | Runtime obligation + unproven lint                       |
| abort-ignoring Promise          | Run acceptance/cancellation.ts: cancel/reset while gate waits, release gate, operation stays cancelled and new state remains count:0; observe no old-generation state.changed.                                       | Runtime obligation; program compiles                     |
| ignored raw notification        | After reset, invoke an old raw store subscriber and late factory resolution; neither may publish. Dispose late factory exactly once.                                                                                 | Runtime obligation                                       |
| fork after close                | Fork scoped fiber then close; join observes interruption. Escaped daemon write receives SessionChanged/closed capability and never publishes.                                                                        | Runtime obligation                                       |
| concurrent reset                | Queue reset A then B; returned A client is stale after B, B remains usable; no orphaned sessions/scopes.                                                                                                             | Runtime obligation                                       |
| reset while pending             | Old action outcome cancelled before reset resolves; returned client/controls name the new generation; reacquire handles.                                                                                             | Runtime obligation                                       |
| disposed view run               | Counter.Add belongs to a closed session; reacquire Counter from the current session. No dispatch or notification occurs.                                                                                             | Runtime obligation                                       |
| disposed journey/read           | Old client, node, action function and narrowed state reader all reject SessionChanged; dispose itself remains idempotent.                                                                                            | Runtime obligation                                       |
| stale matched variant           | A narrowed journey read checks its phase again, never asserts an editing state after loading.                                                                                                                        | Runtime obligation                                       |
| matcher timeout                 | InventoryList did not match requested products within 5 seconds; last state: {…}. Include last pending/error state too.                                                                                              | Runtime obligation                                       |
| fingerprint extension           | connectJourney accepts base descriptor with test scenarios added and rejects a changed selected action/schema. Repeated withScenarios never mutates earlier defaults.                                                | Runtime obligation                                       |
| production exclusion            | Metro/Vite production graphs contain no fixtures/test provider or bridge dialler/token. Keep ADR 0017 development gates. No real credentials in public env/AsyncStorage.                                             | Runtime obligation                                       |
| advanced codec                  | Catchall encode/decode validates encoded schema, rejects arrays/invalid output as specified, and never guesses decoded URL values.                                                                                   | Runtime obligation                                       |
| transformed store error         | Validate explicit projectError output and detach it; automatic inversion of Standard Schema transforms is unavailable.                                                                                               | Runtime obligation                                       |
| redacted/encoded consumer state | Validate actual encode/redaction behavior and custom wire codecs; consumer-state.ts verifies the derived encoded/read-only/redacted types.                                                                           | Runtime obligation; static types verified                |
| common layer extensions         | Runtime provisioning agrees with the retained common output; two extensions/defaults compile in consumer-state.ts.                                                                                                   | Runtime obligation; static coverage verified             |
| resource/type budgets           | Prove registry deadlines and limits under abort/reset; implement within the 7,600-line allocation, without hiding logic in tests.                                                                                    | Runtime obligation; implementation size unproven         |

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
}) {
  declare private readonly nominal: undefined
}
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
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await app.focused(InventoryDetail, {
    _tag: "editing",
    title: "Blue T-Shirt",
    quantity: 5,
  })
  await detail.actions.SetQuantity({ quantity: 12 })
  await detail.actions.Save()
  await app.back()
  const updated = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await updated.actions.OpenProduct({ productId: "product-123" })
  const reopened = await app.focused(InventoryDetail, {
    _tag: "editing",
    quantity: 12,
    error: null,
  })
  await reopened.actions.SetQuantity({ quantity: 19 })
  await failNextSave()
  await reopened.actions.Save.expectError()
  await app.focused(InventoryDetail, { _tag: "editing", quantity: 19, error: "Server error" })
  await app.back()
  const saved = await app.focused(InventoryList, {
    _tag: "ready",
    products: includes({ id: "product-123", quantity: 12 }),
  })
  await saved.actions.OpenSettings()
  const settings = await app.focused(Settings, { _tag: "ready" })
  await settings.actions.SetLowStockThreshold({ threshold: 3 })
  await app.back()
  const refreshed = await app.focused(InventoryList, { lowStockThreshold: 3 })
  await refreshed.actions.OpenSettings()
  await app.focused(Settings, { lowStockThreshold: 3 })
}
```

### examples/inventory/src/app.ts

<!-- file: examples/examples/inventory/src/app.ts -->
```ts
import { defineApp } from "@reflex/effect"
import * as Layer from "effect/Layer"
import { httpInventoryApi } from "./http-api.ts"
import { memorySettings } from "./settings-store.ts"
import { InventoryListLive } from "./features/inventory-list.ts"
import { InventoryDetailLive } from "./features/inventory-detail.ts"
import { SettingsLive } from "./features/settings.ts"
import { InventoryList } from "./screens.ts"
import { Nav } from "./navigation.ts"

export default defineApp({
  name: "inventory",
  navigation: Nav.implement([InventoryListLive, InventoryDetailLive, SettingsLive], {
    initial: InventoryList,
  }),
  defaultScenario: "live-services",
  scenarios: {
    "live-services": {
      description: "Local HTTP inventory and in-memory settings",
      layer: Layer.merge(httpInventoryApi("http://127.0.0.1:4318"), memorySettings),
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

const save = InventoryDetail.when("editing").handler(({ state }) =>
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
      handler: (_, { state }) => save({ state }),
    }),
    SaveAndClose: action.when("editing").navigates({
      description: "Persist the quantity and return to the previous screen",
      error: ApiError,
      handler: (_, { state }) =>
        Effect.gen(function* () {
          yield* save({ state })
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

const load = InventoryList.handler(({ state }) =>
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
  onFocus: load,
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
      handler: (_, { state }) => load({ state }),
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
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { ApiError, InventoryApi, Product } from "./domain.ts"

const ErrorBody = Schema.Struct({ message: Schema.String })
const Saved = Schema.Struct({ ok: Schema.Literal(true) })

/** Platform-neutral transport; imported only by the app's real-service composition. */
export const httpInventoryApi = (baseUrl: string) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const client = HttpClient.withScope(yield* HttpClient.HttpClient)
      const base = baseUrl.replace(/\/$/, "")
      const request = <C extends Schema.Codec<unknown, unknown>>(
        path: string,
        schema: C,
        quantity?: number,
      ) =>
        Effect.gen(function* () {
          const req =
            quantity === undefined
              ? HttpClientRequest.get(`${base}${path}`)
              : HttpClientRequest.put(`${base}${path}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ quantity }),
                )
          const response = yield* client.execute(req)
          // A declared size is refused before any of it is read; the rest is checked after.
          const declared = Number(response.headers["content-length"] ?? Number.NaN)
          if (declared > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const bytes = yield* response.arrayBuffer
          if (bytes.byteLength > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const json = new TextDecoder().decode(bytes)
          if (response.status < 200 || response.status >= 300) {
            const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ErrorBody))(json)
            return yield* new ApiError({ message: body.message })
          }
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(json)
        }).pipe(
          Effect.scoped,
          Effect.mapError((error) =>
            error instanceof ApiError
              ? error
              : new ApiError({ message: "Inventory request failed" }),
          ),
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
import { fixtureApi, fixtureSettings, seedProducts, InventoryFixture } from "./fixtures.ts"

const services = (products: typeof seedProducts, saveDelay?: "1 second" | "30 seconds") =>
  Layer.merge(
    fixtureApi({ products, ...(saveDelay === undefined ? {} : { saveDelay }) }),
    fixtureSettings,
  )
export default app.withScenarios(
  {
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
  },
  { defaultScenario: "inventory-with-products", fixtures: [InventoryFixture] },
)
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
}) {
  declare private readonly nominal: undefined
}

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
}) {
  declare private readonly nominal: undefined
}

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
}) {
  declare private readonly nominal: undefined
}
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
    await fixture.actions.FailNextSave()
  })
})

test("slow save times out without losing edits", async () => {
  await using session = await createTestApp(app, { scenario: "slow-network" })
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity({ quantity: 12 })
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
    await fixture.actions.FailNextSave()
  })
})
```

### acceptance/cancellation.ts

<!-- file: examples/acceptance/cancellation.ts -->
```ts
import { expect } from "bun:test"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { createTestApp } from "@reflex/test"
import { createStore } from "zustand/vanilla"

// Compile-only acceptance case until the target runtime exists. Ignores AbortSignal.
export async function abortIgnoringPromise() {
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
          await gate
          store.setState({ count: 99 })
        },
      }),
    }),
  })
  const app = defineStoreApp({ name: "abort-ignoring", services: [Counter] })
  await using first = await createTestApp(app)
  const old = await first.node(Counter)
  const operation = await old.actions.IgnoreAbort.start()
  const next = await first.reset("default")
  release()
  await operation.cancelled()
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
import { reflex } from "../src/routes.ts"
import { Pressable, Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

export default function InventoryListView() {
  const node = reflex.useScreen(InventoryList)
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
import { reflex } from "../../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../../src/ui.tsx"

export default function InventoryDetailView() {
  const node = reflex.useScreen(InventoryDetail)
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
import { reflex } from "../src/routes.ts"
import { Text } from "react-native"
import { Action, Screen, styles } from "../src/ui.tsx"

function SettingsContent() {
  const node = reflex.useScreenSuspense(Settings)
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
import { developmentBridge } from "@reflex/expo/dev"
import {
  fixtureApi,
  fixtureSettings,
  InventoryFixture,
  seedProducts,
} from "@reflex/example-inventory/fixtures.ts"
import app from "../src/app.ts"
import { reflex } from "../src/routes.ts"

const e2e = {
  e2e: {
    layer: Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings),
    fixtures: [InventoryFixture],
  },
}
const instrumented = app.withScenarios(e2e, { defaultScenario: "e2e" })
const bridge = developmentBridge()
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <reflex.Provider app={instrumented} fallback={null} bridge={bridge}>
      {children}
    </reflex.Provider>
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
import { developmentBridge } from "@reflex/expo/dev"
import { reflex } from "../routes.ts"

const bridge = developmentBridge()
export default function Layout() {
  return (
    <reflex.Provider fallback={null} bridge={bridge}>
      <Stack />
    </reflex.Provider>
  )
}
```

### apps/mobile/plain/app/index.tsx

<!-- file: examples/apps/mobile/plain/app/index.tsx -->
```tsx
import { Pressable, Text, View } from "react-native"
import { Counter } from "@reflex/example-plain"
import { reflex } from "../routes.ts"

export default function CounterView() {
  const view = reflex.useService(Counter)
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
```

### apps/mobile/provider.tsx

<!-- file: examples/apps/mobile/provider.tsx -->
```tsx
import type { ReactNode } from "react"
import { developmentBridge } from "@reflex/expo/dev"
import { reflex } from "./src/routes.ts"

const bridge = developmentBridge()
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <reflex.Provider fallback={null} bridge={bridge}>
      {children}
    </reflex.Provider>
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
import inventory from "@reflex/example-inventory"
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
    layer: Layer.merge(httpInventoryApi(baseUrl ?? "http://127.0.0.1:4318"), storage),
    fixtures: [],
  },
}
const deviceApp = inventory.withScenarios(deviceScenarios, {
  defaultScenario: baseUrl === undefined ? "live-services" : "device-services",
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
import { developmentBridge } from "@reflex/live/dev"
import { reflex } from "./routes.ts"
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
const bridge = developmentBridge()
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root element")
}
createRoot(root).render(
  <reflex.Provider fallback={null} bridge={bridge}>
    <Suspense fallback={<p>Loading…</p>}>
      <RouterProvider router={router} />
    </Suspense>
  </reflex.Provider>,
)
```

### apps/web/src/routes.ts

<!-- file: examples/apps/web/src/routes.ts -->
```ts
import { createReflexRouter } from "@reflex/react-router"
import app from "./app.ts"

export const reflex = createReflexRouter(app, { List: "/", Detail: "/detail/:id" })
```

### apps/web/src/views.tsx

<!-- file: examples/apps/web/src/views.tsx -->
```tsx
import { List, Detail } from "./app.ts"
import { reflex } from "./routes.ts"

export function ListView() {
  const view = reflex.useScreen(List)
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
      <reflex.Link to={Detail} params={{ id: "one" }}>
        Open detail
      </reflex.Link>
    </main>
  )
}
export function DetailView() {
  const { state, actions } = reflex.useScreenSuspense(Detail)
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
      <reflex.Link to={List}>List</reflex.Link>
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
}) {
  declare private readonly nominal: undefined
}
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
  const view = effectBinding.useScreen(Count)
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

export class WireCount extends Screen("WireCount", { state: wire, initial: () => 1 }) {
  declare private readonly nominal: undefined
}
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
}) {
  declare private readonly nominal: undefined
}
export const EncodedLive = EncodedState.implement({
  actions: (action) => ({ Increment: action.reduce({ reducer: (_, n) => n + 1 }) }),
})
const reflex = createReflex(defineApp({ name: "encoded-state", screens: [EncodedLive] }))
export function EncodedView() {
  const view = reflex.useScreen(EncodedState)
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
}) {
  declare private readonly nominal: undefined
}
const SecretLive = Secret.implement({ actions: () => ({}) })
const secretBinding = createReflex(defineApp({ name: "secret", screens: [SecretLive] }))
export function SecretView() {
  const view = secretBinding.useScreen(Secret)
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
  await list.actions.OpenSettings()
  // initial and its handles are invalid now. Ownership stays with initial's disposer.
}
export async function fixtureStory() {
  await using session = await createTestApp(app, { scenario: "inventory-with-products" })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave()
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
// Private declarations are inherited. Registry lookup must use exact constructors.
export class Subclass extends InventoryDetail {}
const assignable: typeof InventoryDetail = Subclass
void assignable
// Private nominal line cannot be inspected structurally by a library.
export class MissingNominal extends Screen("MissingNominal", {
  state: Schema.Number,
  initial: () => 0,
}) {}
// JS class name differs from declared contract name. Diagnostics use the latter.
export class DifferentClassName extends Screen("DeclaredName", {
  state: Schema.Number,
  initial: () => 0,
}) {
  declare private readonly nominal: undefined
}
// A 60-segment root route is accepted without TS2589 (tail accumulator parser).
export const longPath = createReflexRouter(app, {
  Count:
    "/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/:count",
})
longPath.href(Count, { count: "1" })
```

## 5. Changes against review items 1–31

| Item | Revision and evidence                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | getState-derived StateOf, NoInfer for store projections, availability and builders; plain/live stores and JSON interface compile. Parameterized factories document their one annotation.                                                                                                               |
| 2    | Whole codec/validator inference separates handler decoded output and consumer encoded input; codecs.ts covers action input, errors, jsonCodec, navigation and URL params. Store transformed errors explicitly project because Standard Schema cannot invert them.                                      |
| 3    | JsonShape compatibility accepts interfaces; Date/functions fail in asserted cases. Runtime publication validates richer constraints.                                                                                                                                                                   |
| 4    | Contextual `includes<E>` uses Partial<NoInfer<E>>; typo and cross-variant match cases assert actual diagnostics.                                                                                                                                                                                       |
| 5    | Links and href accept contracts in both host declarations; web views demonstrate Link and codecs.ts demonstrates href.                                                                                                                                                                                 |
| 6    | Full tuple unions for push/href and complete initial-route objects, including zero params; union and encoded/decoded negative cases compile-fail.                                                                                                                                                      |
| 7    | action.navigates requires a returned command and Nav.stay; plain action/onFocus use inferred-success markers. Erasure remains a documented lint/runtime limit, including services/fixtures.                                                                                                            |
| 8    | Guarded state writes explicitly fail with StateChanged; builders exclude it from domain error declarations and convert it to refusal. Runtime conversion remains acceptance work.                                                                                                                      |
| 9    | Tail accumulator parser rejects repeats, excluded grammar, optional path fields, non-string encodings and mapping errors with interpolated names; long path compiles.                                                                                                                                  |
| 10   | Removed Self; private line preserves independent nominal classes. Chose exact runtime constructors and documented inherited/missing-line static limits and class/string name mismatch.                                                                                                                 |
| 11   | Generation isolation/revoked writes/filtered notifications specified; abort-ignoring Promise acceptance program compiles but awaits runtime implementation.                                                                                                                                            |
| 12   | App/extension-level fixture defaults with per-scenario overrides; normalized memberships preserve previous extension defaults. scenarios.ts lists defaults once.                                                                                                                                       |
| 13   | App-bound Provider, optional compatible extension prop, fallback, boundary startup behavior, observable statuses and onBackgroundError defined consistently.                                                                                                                                           |
| 14   | screens/services in both backends; useService throughout the plain examples and declarations.                                                                                                                                                                                                          |
| 15   | error/status:error/expectError; reset returns new controls/client; Duration.Input; one mountOwned, mountEffect, one shared routeCodec, one bridge helper re-export and Bridge type; TypedClient aliases JourneyClient mode; store command returns rejected.                                            |
| 16   | Screen.define one-step tier added; first ten actual lines per tier appear in three compiled small files.                                                                                                                                                                                               |
| 17   | First plain counter uses services and useService with no Reflex router binding; web routing follows it.                                                                                                                                                                                                |
| 18   | Inferred-then-checked handler and lifecycle errors verified at source lines. Same-name identity marker corrected; TS2488 accepted; missing navigator names action/app. Missing component/input use honest TS diagnostics. Context key message and last-state timeout specified as runtime obligations. |
| 19   | React Router host route options preserved, loader/errorElement authored; paths/wrappers stay registered. Framework/route-module mode explicitly excluded.                                                                                                                                              |
| 20   | Removed Stack-wide Suspense; Settings owns its boundary. Error-boundary retry is a runtime acceptance case.                                                                                                                                                                                            |
| 21   | Effect namespace imports, tryPromise, fromJsonString, Duration.Input; removed untyped JSON.parse and hard-coded production credential.                                                                                                                                                                 |
| 22   | One terminal command, void refusal recovery; explicit state/action replacement workflows for multi-step and refusal redirects.                                                                                                                                                                         |
| 23   | Shared story takes Pick<JourneyClientFor, focused/back>; fixture and live-services calls compile; reset.ts reacquires after returned reset.                                                                                                                                                            |
| 24   | One journey action map with call/expectError/expectRefusal/start members; removed five parallel maps.                                                                                                                                                                                                  |
| 25   | Every created/connected test session is await using; resource owner remains disposable across resets.                                                                                                                                                                                                  |
| 26   | Fingerprint excludes scenario metadata; withScenarios immutable/additive/default-preserving semantics and repeated-extension fixture normalization specified. Transport behavior remains runtime acceptance work.                                                                                      |
| 27   | Pending view has state:null/actions:null and normal build errors have the same slots; mobile destructuring and ready narrowing compile.                                                                                                                                                                |
| 28   | Production app.ts uses real services only; scenarios.ts imports fixtures and only tests/E2E use it. E2E alias remains separate. Bundle proof is runtime work.                                                                                                                                          |
| 29   | `__DEV__` gate, bounded versioned settings, no embedded production token, credential warning, scenario descriptions, complete Metro resolver/watchFolders/module paths and consistent import style restored.                                                                                           |
| 30   | Navigation record retained and alias keys rejected; only implementation selection uses a tuple with duplicate checking.                                                                                                                                                                                |
| 31   | Complete compiled codec transformations, store domain error, loader/errorElement, advanced catchall codec, and returned-reset client files added.                                                                                                                                                      |

## 6. Scores and validation report

The target remains **9 on each factor**, not a self-certified reviewer result. Honest
predictions for an independent review of this revision:

| Factor                      | Predicted score | Remaining reason to withhold 9 where applicable                                                      |
| --------------------------- | --------------: | ---------------------------------------------------------------------------------------------------- |
| Common-case brevity         |               9 | One-step screen and router-free store counter.                                                       |
| Inference                   |               9 | No call-site generics; parameterized factories and advanced wire helpers use definition annotations. |
| End-to-end typing           |               9 | Encoded/redacted consumer-state examples compile.                                                    |
| Misuse resistance           |             8.5 | Command erasure and lifecycle safety depend on unimplemented lint/runtime guards.                    |
| Naming and consistency      |               9 | Shared vocabulary, roles and command surface.                                                        |
| Layering and escape hatches |               9 | Common layer coverage and repeated extensions compile.                                               |
| Errors                      |             8.5 | Marker locations asserted; service key strings/runtime sentences still unexecuted.                   |
| Host idiom fit              |               9 | Host options, namespace Effect imports and screen-level Suspense.                                    |
| No leaked internals         |               9 | Examples use public entries and no unchecked decoded-value assertions.                               |
| Testability                 |               9 | Shared capability story, one action map and reset/reacquire ownership.                               |
| Examples                    |               9 | Entire authored graph and JS configuration typecheck; runtime acceptance distinguished.              |
| Type performance            |               9 | Screen slope passes the gate; editor latency is still unmeasured.                                    |

This design does **not yet meet 9 on every factor**. The remaining lint/runtime evidence
above is concrete acceptance work, not hidden
behind predicted implementation success. No runtime test count is claimed for this target.
Repository `bun run check` validates compatibility with the unchanged implementation.
The executable-spec results and final validation command outcomes are recorded below.

### Recorded validation, TypeScript 5.9.3

`bun docs/design/prototypes/check.ts` passes. **44 authored files** are mirrored exactly:
42 TS/TSX files and the Metro JavaScript file typecheck; the JSON config parses.
All **75 executable negative cases** assert their marker text and exact source line,
and the table's marker and link are checked against the same source. The checker itself
is typechecked. Declaration-body checking reports no target declaration errors.

| Graph                               | Instantiations |
| ----------------------------------- | -------------: |
| Harness                             |          1,088 |
| Complete authored API/example graph |         90,535 |
| Negative graph                      |         77,643 |

| Screens | Definitions/app only | One unique hook per screen | Ten identical hooks per screen |
| ------- | -------------------: | -------------------------: | -----------------------------: |
| 0       |                  449 |                        449 |                            449 |
| 10      |               16,316 |                     19,834 |                         19,834 |
| 50      |               58,556 |                     74,794 |                         74,794 |
| 100     |              115,856 |                    147,994 |                        147,994 |

The definition/app slope is **1,056** (10→50) and **1,146** (50→100) instantiations per
screen. Including one unique hook makes those slopes **1,374** and **1,464**. The
marginal unique-hook slope is **318**, compared with the reviewers' roughly 660; the
whole-app declaration graph differs, so this is a workload comparison, not a controlled
before/after benchmark. Repeating an identical hook adds **0 measured instantiations**
because TypeScript caches it. That does not establish zero editor or checker work.
The proposed **2,000 per-screen / 100 per repeated-hook gates pass**.

The first implementation of this executable target failed the screen gate (about 10,000
per screen). Duplicate detection now maps definitions to a tuple of names before tail
recursion, avoiding recursively copying full definitions. Hook signatures are generated
once as an overload intersection at binding creation, with a diagnostic fallback for
misuse, rather than re-instantiating the complete app union at each call. The 100-screen
measurement validates this specific overload design; no claim is made about arbitrary
thousands of screens or editor completion latency.

`bun run check` passes: formatting/lint, documentation snippets, root/mobile/web typechecks,
**631 tests passed, 3 platform-specific skips, 0 failures**. These tests validate the
unchanged implementation, not the proposed runtime. `git diff --check` is clean.
No packages, live examples or apps changed, and no PR was opened.
