# Adopting Reflex in an existing app

Expose a service or one screen first. Keep your Zustand/Redux store, hooks, router and
business logic. Reflex registers a deliberate public view and named actions over that
logic; it does not take ownership of the store. The complete example is
[examples/plain](../examples/plain/src/app.ts), rendered by
[apps/mobile/plain](../apps/mobile/plain/index.tsx) without Effect.

## 1. Expose an existing store

`mountStore` from `@reflex/runtime` accepts structural `getState()` and
`subscribe(listener): unsubscribe` methods. Zustand vanilla stores and Redux stores fit;
for hooks, hoist only the behavior you want to expose into an external store and keep
using `useSyncExternalStore` to render it. Do not copy hook state into a second Reflex
store: that would create two sources of truth.

```ts
import { mountStore, standardInput } from "@reflex/runtime"
import { z } from "zod"

const input = z.strictObject({ by: z.int() })
const node = mountStore(runtime, {
  name: "Counter",
  type: "service", // ambient; works without any router or focus
  store, // your existing Zustand or Redux store
  project: ({ count }) => ({ count }), // deliberately exclude token, functions, etc.
  actions: {
    Add: {
      input: standardInput(input, z.toJSONSchema(input, { io: "input" })),
      available: ({ count }) => (count < 100 ? true : "At limit"),
      handler: ({ by }: z.infer<typeof input>, { signal }) => addToCounter(by, signal),
    },
  },
})
// When this owner ends:
node.dispose()
```

No Reflex package depends on Zustand or Zod. `standardInput` accepts Standard Schema v1
validators, with an explicit JSON Schema (or a converter's output). The published schema
must describe the wire input, not the transformed output. Use strict objects when the JSON
Schema rejects extra properties. Tests should run the same valid and invalid inputs through
both validators; the example does this with Ajv. Schema conversion cannot express every
custom refinement, so supplying a JSON Schema is an application responsibility.

`prepare` is synchronous. A validator that returns a Promise is refused with `InvalidInput`
and a clear async-validator message before any operation starts. Rejected validation
Promises are observed. Async business work belongs in the handler, after synchronous
validation. Omit `input` for no-input actions (omitted input, null, or an empty object).

`project` must return plain JSON, without accessors. Reflex checks the existing protocol
state size and depth limits, copies and freezes the result, and publishes only that copy.
Every notification rechecks it; identical projected JSON causes no event or revision.
Include every state field that determines availability in the public projection so that
changes in availability also change the public revision. Do not put secrets there.
**Automatic `Schema.Redacted` scanning does not apply to this path.** No full-store
serialization or automatic secret detection happens. Error tags and messages are public,
too; never include credentials in them.

An invalid external write has already happened in your store: Reflex cannot roll it back.
Your write still succeeds and your store's other subscribers still run: Reflex reports the
problem to the session's background reporter, once until the state is publishable again,
keeps the last valid public snapshot, and emits no change. Clients see stale state until
then, so treat a report as a bug to fix. An operation that finishes while the state is
unpublishable fails, though its work ran. Validate your own writes
before committing them when you need atomic store/public-state updates.

## 2. Own session lifetime, without rewriting the core

Create an `AppHost` with `name`, `defaultScenario`, `scenarios`, and async `start` (see the
plain example). `start` receives a session id and background reporter. Create a runtime
with those, mount your exposed nodes, and return `{ runtime, dispose }`; dispose every
mounted node. Existing services can be injected into this factory. The example creates a
fresh store per session so reset really resets it. If you attach an existing singleton,
reset must explicitly reset it or document that its data persists; Reflex cannot reset
application-owned state implicitly.

A handler may return a value or a Promise. `app.dispatch` accepts it first; operation
completion means that returned Promise settled successfully, including any work it
awaited. Return/await the business work you want clients to wait for. Fire-and-forget work
is outside this operation and protocol idle. Throw `new StoreFailure(tag, message)` for
an expected business failure; other throws and rejections are defects. Public error data
is deliberately unsupported; expose a safe error state instead.

Cancellation settles the operation as cancelled and aborts the handler's `AbortSignal`.
Disposal unregisters, unsubscribes and cancels all owned invocations. JavaScript cannot
forcibly stop a Promise: handlers must pass the signal to I/O and check it before late
writes. A cancelled handler that ignores it can still mutate the application store.
Disposal prevents further Reflex publication; it does not destroy your store.

## 3. Render selected screens using the generic bindings

Import from `@reflex/react` for the Effect-free entry. `ReflexProvider` accepts any `AppHost`,
serves the session via the existing live controller and remounts its subtree on reset.
`useNode(id)` binds any adapter's public JSON and protocol dispatch, even if it has no
`live` object. `useNodeState(source)` accepts any structural snapshot/subscription source.
`send(node, action, input)` uses that node's send method and reports defects/resource
failures; show expected business errors in application state. The plain Expo screen uses
all these bindings and a real Zustand store. UI code can also keep calling existing store
functions directly; the store subscription publishes their public changes.

Keep your router. Use `type: "screen"` for a selected screen and call
`useNodeFocus(nodeId, isFocused)` with your router's actual focus boolean (for example,
React Navigation's `useIsFocused()`). The hook sets runtime focus on arrival and clears
it on departure only if that screen still owns it. Mount the provider above the selected
screens; register nodes with the session and dispose them when their owner ends. A screen
covered by another refuses new actions; existing operations continue until cancelled or
disposed. Dispose a popped screen's node yourself to cancel its work. Unexposed screens
should report departure of the exposed screen; they need no nodes. Ambient `service`
nodes need no focus and remain actionable from every screen.

This mode exposes only selected behavior, not automatic navigation. `RouterProjection`
requires the `Navigation` node and stack contract produced by `defineNavigation`; it
cannot drive an arbitrary existing router without that core navigation model. Do not
mount it in incremental adoption mode. Navigation remains application-owned, and headless
fixtures must explicitly model focus changes if their tests need them. The plain example
switches between an exposed counter and an unexposed screen using application-owned
React state. Leaving the counter clears focus; returning restores it. It uses no projection.

For Expo Router capabilities, import `useRouteNode` from `@reflex/expo/effect`.
Without Expo Router, `@reflex/react` has a generic `useRouteNode(resolve, binding)`;
`binding` supplies `{ stack, token, params? }`, where entries have `{ nodeId, params }`.
`@reflex/react/effect` accepts a capability and the same explicit binding. It retains the bound node during exit
animations. Neither route lookup nor projection is needed for an existing router.

## 4. Connect the same CLI and MCP

Pass `connectBridge(setting)` as the provider's `bridge`, loading `@reflex/live`
only inside `__DEV__` and reading `EXPO_PUBLIC_REFLEX_BRIDGE` there. See the plain entry.
Start the device bridge and give the app its printed setting:

```console
bun run reflex --target device start
# Start your app with EXPO_PUBLIC_REFLEX_BRIDGE set to the printed appSetting
bun run reflex --target device ls --schema
bun run reflex --target device do Add '{"by":2}'
bun run reflex --target device mcp
```

The controller is unchanged. Access policies, wire validation, revisions, waits,
subscriptions, CLI and MCP use exactly the existing protocol. Start a headless instance
with `bun run reflex start examples/plain/src/app.ts` to exercise the same behavior.

## Guarantees and tradeoffs

| Guarantee                                         | Store path                                                                   | Effect capability path                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| Explicit public state; bounded JSON               | Required projection, checked before publication                              | Schema encoding, bounds and automatic redaction       |
| Automatic `Schema.Redacted` scanning              | No; select safe fields yourself                                              | Yes                                                   |
| State write ownership/atomic validation           | Application store owns writes; invalid external writes cannot be rolled back | StateAccess validates before commit                   |
| No public event for unchanged projection          | Yes                                                                          | Identity-based unchanged-state suppression            |
| Input validation before acceptance                | Synchronous Standard Schema + supplied JSON Schema                           | Effect Schema derives both                            |
| Availability and focus refusal                    | Yes; router reports focus                                                    | Yes; core navigation owns focus                       |
| Declared failure versus defect                    | StoreFailure versus other throws/rejections                                  | Typed failure versus defect; optional safe error data |
| Returned async work tracked to completion         | Yes, await the returned Promise                                              | Yes, scoped fibers                                    |
| Cancellation on dispose                           | AbortSignal, cooperative; unregister and unsubscribe                         | Scope interruption and unregister                     |
| Structured concurrency, virtual clock, generators | No; app supplies fixtures/time, no automatic sampling                        | Effect scopes, TestClock, schema generators           |
| Automatic navigation and pop lifetime             | No; existing router/application owns these                                   | defineNavigation + RouterProjection                   |
| CLI, MCP, bridge, policies, events, waits         | Same controllers and protocol                                                | Same controllers and protocol                         |
| Effect in a generic Expo bundle                   | None; checked from Metro's module graph in CI                                | Explicit capability entry includes Effect             |

For a live app without React, see [live-counter](../examples/live-counter/README.md).
