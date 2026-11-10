# Userland API round two: implementation report

This round improves the contracts and examples, but **does not meet the requested 9/10
on every factor**. ADR 0021 records the exact behavior and remaining limitations. ADR 0020
is unchanged. Wire messages, CLI and MCP implementations are unchanged.

## A. Contracts and navigation

Before:

```ts
export const Detail = defineCapability({
  state: State,
  initial: (): State => initial /* handlers importing Nav */,
})
export const Nav = defineNavigation("app/nav", () => ({ Detail }))
handler: (): Effect.Effect<void, NavigationRefused, NavigationService> => Nav.push("Detail", params)
```

After:

```ts
const DetailScreen = defineScreen({
  name: "Detail",
  state: State,
  params: Params,
  initial: ({ id }) => ({ _tag: "loading", id }),
})
const Nav = defineNavigation("app/nav", { Detail: DetailScreen })
const Detail = DetailScreen.implement({
  actions: (action) => ({
    Open: action({ error: NavigationRefused, handler: () => Nav.push("Detail", { id: "one" }) }),
  }),
})
const root = Nav.layer({
  screens: { Detail },
  initial: { route: "Detail", params: { id: "first" } },
})
```

Inventory's contracts and features now compile without state or handler-return annotations.
Helper arguments infer through `Screen.handler` and `Screen.when(tag).handler`. Navigator
requirements include their literal key, and correlated tuple unions reject uncorrelated
route/params unions. App membership derives from navigation implementations and scenario
`withNodes` declarations; omitted membership is empty. Same-name independently-created
definitions remain structurally indistinguishable in TypeScript; full nominal identity is
not delivered.

## B. Schema presence

Before: missing input could contextually become `any`; `fail` was always present.

```ts
handler: (input) => input.misspelled
handler: (_, { fail }) => fail({ undeclared: true })
```

After: absent/present schema overloads prevent invented handler inputs; undeclared `fail`
is rejected. Real unknown is still a required argument:

```ts
Unknown: action({
  input: standardInput(z.unknown(), {}),
  handler: (value) => {
    /* value: unknown */
  },
})
node.actions.Unknown(undefined)
node.actions.Empty()
```

Plain store literals receive `unknown`, rather than `any`, and no undeclared `fail`.
Use `action({ input, handler })` for decoded sibling-schema inference. Full inference for
plain literals remains incomplete. Focus hooks reject undeclared Effect failures.

## C. Wire state

Before: a BigInt could be typed as bigint while a journey received a string.

```ts
// state schema: Schema.BigInt; observed value: "12"
```

After:

```ts
const value: InferState<typeof Big> = "12"
// bigint is rejected as a consumer state
```

Effect consumer snapshots now use encoded/redacted state; handler access stays decoded.
Store projections must satisfy JSON and their snapshots are deeply readonly. Built-in
canonical types include BigInt strings. Custom JSON hooks and transformed store error
wire types still need a fully explicit codec design; this item is incomplete.

## D. Expo routes

Before:

```ts
expoRoutes(Nav, { Detail: { pathname: "/detail/[id]", params: { id: "wrong" } } })
routes.toHref({ route: "Nope" })
```

After:

```ts
expoRoutes({ screens }, { Detail: { pathname: "/detail/[id]", params: { id: "id" } } })
// NumberFromString (with domain checks) supports numeric decoded params.
// Schema.Number fields and missing placeholder mappings are rejected.
```

Encoded URL fields must be strings. Optional-only params require mappings; absent query
values stay absent. Invalid known inbound routes throw `InvalidRouteParams` carrying
route, raw params and cause. Projection functions live behind an internal symbol;
consumers receive screen bindings only. Expo's generated Href type is not integrated.

## E. Dispatch and ownership

Before:

```ts
send(node, "Save")
node.send("Save")
node.dispose()
```

After:

```ts
await node.actions.Save()
// advanced integration only:
await dispatchDecoded(node, "Save")
```

Root `send` re-exports and consumer Effect `send`/disposal are removed. Structural
`NodeHandle` has no disposal. Mount owners retain explicit cleanup seams. Local action
calls report defects/domain failures through the runtime even when callers ignore the
promise. The protocol acceptance/completion path is unchanged.

## F. Hooks and host lifecycle

Before:

```tsx
const node = useRouteNode(Detail, { lifetime: "history-entry", entryKey })
useRouteFocus(node, entryKey)
const state = useNodeState(node)
```

After:

```tsx
const view = useScreen(Detail)
if (view.status === "pending") return <p>Loading…</p>
return <Action {...view.actions.Save} />
```

Ambient `useNode` and router-bound `useScreen` share pending/ready state and per-action
run/available/reason/pending controls. Pending views cannot expose actions prematurely.
Granular hooks remain; non-null state sources have a non-null overload. Registry lookups
subscribe to membership; private store changes re-notify guards. React Router owns focus
in its one hook, retains at most 64 entries, and drops unreachable forward entries.
`mount(cap, initial, { focus: true })` supports Effect without navigation.
Service-layer-backed Effect mounting in React Router and bound Zustand reset adapters
remain incomplete.

## G. Journeys and exploration

Before:

```ts
await detail.actions.Save() // a failed outcome could be ignored
const snapshot = detail.state // captured once
products: [{ id, quantity }, {}, {}]
```

After:

```ts
await detail.actions.Save() // rejects on refusal, failure, defect or cancellation
await detail.expectFailure.Save()
await detail.allowCancellation.SaveAndClose()
const current = await detail.state()
products: includes({ id, quantity })
```

State reads target the exact node and re-establish a previously-proved discriminant.
Exploration has typed per-definition invariant callbacks and checked scenario names;
serveLive scenario names are checked too. Back fails fast, but does not statically prove
that a navigation stack exists/can go back. Teaching tests use typed handles; adversarial
protocol and HTTP/controller probes moved to root test/.

## H. Surface and names

Before:

```ts
Definition.client.state(json)
import type { PublicState, ActionDefinition, NoInput } from "@reflex/effect"
```

After:

```ts
import type { InferState, InferInput, InferError } from "@reflex/effect"
```

Serialization plumbing sits under `~reflex`. Redundant session/root re-exports are removed.
Both store construction paths default to service; UI definitions opt into screen.
Development bridge helpers are synchronous in Expo and Vite. domain.md defines the new
terms. `/advanced` is the app escape hatch; `/internal` remains the sibling-adapter seam,
with the reason documented. Store error wire transforms remain a gap.

## I. Examples

Before:

```tsx
useRouteNode(name === "List" ? List : Detail, { lifetime: "history-entry", entryKey })
// hidden retained entries; production layout directly composes E2E Tools
```

After:

```tsx
<Route path="/" element={<ListScreen />} />
<Route path="/detail/:id" element={<DetailScreen />} />
// each leaf calls useScreen with its own definition
```

The web fixture has real route components with library-owned retention. Mobile E2E
instrumentation lives in e2e/ behind the compile-time provider selector. Plain imports a
package name and uses explicit pending state. Inventory helpers/initializers/navigation
handlers need no state/return annotations or repeated guarded update tag checks.

## J. Type probes and performance

Before: root tsc measured 290,689 instantiations without a CI budget.

After:

```console
bun scripts/type-budget.ts
# fails above 325000 instantiations + 10%
```

Root typecheck, including the budget script itself, runs before mobile/web typechecks.
The recorded post-change graph has 323,447 instantiations (+11.27%). Reference local
measurements: 93,262 → 100,809 types; 475,957K → 502,275K memory; 1.23s → 1.26s check time;
2.50s → 2.17s total time. Timings/memory vary by machine. Raw diagnostics are in
performance/userland-api-r2-{before,after}.txt.

`test/userland.types.ts` adds positive contract-first inference and negative probes for
navigator identity, correlated pushes, absent/unknown inputs, invented handler inputs,
undeclared fail, empty membership, scenario names, readonly snapshots, JSON projections,
BigInt wire state, URL codecs/placeholders/optional params, hidden mapping functions and
consumer ownership. The old membership probe now gives the foreign definition the same
state/initial shape, so membership causes the error. Runtime regressions cover independent
private guards, ignored defects, strict journey failures/live reads/cancellation, Effect
focus without navigation, numeric/optional URL round trips and route-only store apps.

## Honest rubric scores

| Factor                      | Score | What holds it below 9                                                                          |
| --------------------------- | ----: | ---------------------------------------------------------------------------------------------- |
| Ceremony                    |     8 | Contracts and composition remain separate concepts; mounted hooks require a pending branch.    |
| Inference/end-to-end types  |     8 | Plain store literals and custom wire hooks lack full inference.                                |
| Correctness by construction |     7 | Same-name definition identity, custom wire codecs and store error transforms remain gaps.      |
| Consistency/naming          |     8 | Effect service mounting and advanced ownership still differ from store routes.                 |
| Progressive disclosure      |     8 | Compatibility and sibling internal seams remain alongside the documented advanced tier.        |
| Errors                      |     8 | Better action/route diagnostics, but some overload failures still show structural types.       |
| Host idioms                 |     8 | React Router still lacks Effect service-layer mounting; bound Zustand stores are not accepted. |
| Testability                 |     8 | Strict/live journeys work; back availability is not statically proven.                         |
| Examples as teaching        |     9 | Typed stories and real route components; protocol probes are separated.                        |
| Surface hygiene             |     8 | Explicit ownership/integration seams and legacy advanced APIs remain.                          |

## Validation

The implementation was exercised with `bun run check`, all four mobile browser commands
(e2e, e2e:plain, e2e:live, e2e:services), and web e2e. Browser commands also check production
bridge/token exclusion. The Windows import fix converts the bundled Playwright external
path to a file URL; the worker import path is converted too. The final delivery message
records the final check results, remote CI run id/result and pushed head SHA. Earlier
failing experiments were fixed and rerun; they are not counted as passing validation.
