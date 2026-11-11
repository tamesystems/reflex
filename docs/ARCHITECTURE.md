# Architecture

The canonical map of this repository, for people and coding agents. It describes what
cannot be read off the code cheaply: the boundaries, the flows and the rules. Terms are
defined in [domain.md](domain.md); decisions are explained in [decisions/](decisions/).

## 1. Purpose and boundary

Reflex is an **application control protocol** and the runtime behind it. It lets a client
inspect an app's behavior and drive it, with or without its UI.

Reflex owns:

- the protocol: JSON-RPC methods, events, error codes and every limit a peer can reach;
- the runtime: the registry of live nodes, operations, revisions and the event log;
- sessions: starting, resetting and serving an app, headless or live on a device;
- the clients: the `reflex` CLI, the journey test SDK and the MCP server;
- the bindings that let one app core serve both its React UI and the protocol.

Reflex does not own:

- **rendering**. The app's React components render state; Reflex only hands them nodes.
- **app data**. Sessions are in memory. Persistence, networking and auth belong to the
  app's services, which scenarios replace with fixtures.
- **end-user security**. The control surface is development tooling: it trusts whoever
  can authenticate to the session transport (see [SECURITY.md](../SECURITY.md)).
- **the router's own behavior**. Expo Router decides what a gesture does; Reflex follows.

## 2. Context

```text
   developer / CI / agent
     │          │       │
     │ reflex   │ bun   │ MCP (stdio)
     ▼ CLI      ▼ test  ▼
 ┌────────────────────────────────────────────────┐
 │ CLI process (packages/cli)                     │
 │   commands.ts — the one implementation of each │
 │   command, shared by the CLI and the MCP tools │
 └───────────────┬────────────────────────────────┘
                 │ JSON-RPC over Unix socket (0600) or authenticated Windows pipe
                 ▼
 ┌────────────────────────────────────────────────┐
 │ Session daemon (reflex start / serve)          │
 │   PeerConnection ─► Controller                 │
 │                      ├─ SessionController ─────┼─► app core in this process
 │                      └─ BridgeController ──────┼─┐  (headless target)
 └────────────────────────────────────────────────┘ │
                                                     │ WebSocket, token hello
                                                     ▼ (device target)
 ┌────────────────────────────────────────────────┐
 │ App process (any framework, or no UI)   │
 │   connectBridge ─► LiveController ─► session ──┼─► the same app core
 │   React may render that same session     │
 └────────────────────────────────────────────────┘
```

The app always dials out to the bridge; it never listens
([ADR 0008](decisions/0008-the-device-dials-out.md)).

## 3. Code map

```text
packages/
  protocol/   The contract. Types, parsers for every message, error codes, limits.ts,
              and access.ts: what each access policy allows. Depends on nothing.
              Start: contracts.ts, limits.ts.
  runtime/    Node registry, operations, waits, event log (runtime.ts), the
              SessionController that starts, resets and closes sessions (controller.ts),
              and restrictController, which holds any controller to a policy.
              store-node.ts defines typed store nodes; store-app.ts owns their app lifetime.
              node-handle.ts is the shared consumer contract. The store adapter wraps existing stores with public JSON projections, Standard Schema
              validation and Promise operations. No Effect, no platform APIs.
              Start: runtime.ts, then controller.ts.
  rpc/        JSON-RPC 2.0 over newline-delimited JSON. server.ts is one peer's
              connection to a Controller; client.ts the other end; socket.ts the Unix socket, Windows pipe and stdio transports;
              local-auth.ts authenticates Windows pipe peers; local-cipher.ts encrypts
              frames and validates proof-of-read credits for bounded native buffers;
              socket-writer.ts counts queued bytes until write callbacks complete;
              socket-shutdown.ts waits for the Windows shutdown reply receipt; bridge-controller.ts a Controller that
              forwards to whichever app is connected.
  effect/     How an Effect app becomes nodes. capability.ts (defineCapability, mount), screen.ts (contracts before handlers),
              navigation.ts (defineNavigation: the stack, a scope per screen),
              app.ts (legacy AppHost lifecycle), author-*.ts (Screen, services, fixtures,
              action commands and ordered scenario composition), json-codec.ts, redaction.ts.
  test/       createTestApp journeys and explore random walks, through the real protocol.
  cli/        The reflex command. cli.ts parses; commands.ts does; session.ts runs and
              finds daemons; bridge-server.ts accepts apps; mcp.ts serves MCP tools.
              See packages/cli/README.md.
  live/       Framework-free bridge.ts, live-sessions.ts, live-controller.ts,
              session-owner.ts, node-source.ts and ui-actions.ts. session.ts excludes
              the bridge for UI bundles. See packages/live/README.md.
  react/      React-only provider and hooks (react.tsx), generic route binding,
              app-bound factories and advanced session/route seams. See packages/react/README.md.
  navigation/ Router-neutral projection rules/controller and Navigation core port.
              No framework, router or Effect. See packages/navigation/README.md.
  react-router/ Existing React Router 8 route focus, via @reflex/react.
              See packages/react-router/README.md.
  expo/       Expo Router projection adapter, router-actions.ts,
              app-bound hooks and symbol-hidden URL bindings.
              See packages/expo/README.md.
examples/
  inventory/  A three-screen app core with fixture scenarios and an optional HTTP service
              implementation. Imports Effect and @reflex/effect; no UI
              or device APIs. server.ts is the separate local Bun JSON API.
  plain/      Real Zustand/Zod app core, no Effect; rendered by apps/mobile/plain.
  live-counter/ Plain process serving a service node through @reflex/live; no UI framework.
apps/
  web/        Vite/React Router existing-route fixture; own install, live CLI/MCP journey.
  mobile/     The same inventory core rendered by Expo Router; src/app.ts optionally
              composes HTTP and app-only AsyncStorage layers (ADR 0019). Own install. e2e/ holds
              the browser journeys (including the isolated plain Expo entry), hermes-smoke/ runs a journey on a Hermes VM.
test/         Cross-package suites: conformance (Effect, Zustand, XState, Effect/Zustand live),
              xstate-counter.ts (test-only NodeAdapter), xstate.test.ts (actor semantics),
              boundaries (the dependency rules), lifecycle, the bridge end to end.
bench/        Wire and encoding costs.
experiments/  Prototypes kept as evidence for a decision: effect-rpc/ serves the
              protocol through Effect RPC and compares it with ours (ADR 0014).
```

### Dependency rules

```text
protocol ◄── runtime ◄── rpc ◄── test / cli
                ▲         ▲
                ├── live ─┘ (rpc/connection only)
                │    ▲
                │  react ◄── expo ◄── apps/mobile
                │    ▲       ▲
                │    └── react-router ◄── apps/web
                ├── navigation ─┘
                │    ▲
                └── effect ◄── react/effect, expo/effect

runtime + live ◄── examples/live-counter
```

- `protocol` depends on nothing. `runtime` depends only on `protocol`.
- Core packages (`protocol`, `runtime`, `rpc`, `cli`, `test`, `effect`) import no UI framework.
- `live` imports no React, React Native, Expo, Effect or Node APIs; it needs a global WebSocket.
- `live` reaches RPC only through the platform-free `@reflex/rpc/connection` entry.
- `react` depends on React, with no React Native or Expo imports. Its root and advanced entries remain Effect-free.
- UI bindings import `@reflex/live/session`, whose exports exclude the bridge. Apps load
  `@reflex/live` and read the bridge setting only behind `__DEV__` (Expo) or
  `import.meta.env.DEV` (Vite) in UI builds.
- `navigation` imports only protocol/runtime; no framework, router, Effect or platform.
- `expo` adapts navigation ports to Expo Router and owns route-param integration.
- `react-router` imports only `@reflex/react`, React Router, live/session and runtime/protocol;
  it reports focus in existing routes and owns no navigation. It uses React to memoize URL bindings and delegates node/session ownership to
  `@reflex/react`; no Expo, React Native or Effect.
- An app core never imports React, Expo or a device API.
- Only `packages/expo/src/router-actions.ts` imports Expo Router's private modules.

`test/boundaries.test.ts` enforces each package's allowed imports; change it in the same
change as a rule. It allows the private router modules anywhere in `packages/expo`, so
keeping them to one file is for review to hold.

## 4. Runtime flows

### 4.1 A command against a headless session

`reflex do SetQuantity '{"quantity":12}'`, with a session started by `reflex start`.

```text
cli.ts          read --target; connectToSession (session.ts); parse and check the
  │             command's arguments, all of them before anything is sent
  │
commands.ts     doAction: app.dispatch, then app.wait {operationId}, then app.wait
  │             {idle}, then app.inspect, over one client (rpc/client.ts)
  │  Unix socket / authenticated pipe
server.ts       PeerConnection: parse the frame, check limits, controller.request
  │
controller.ts   SessionController: wait out any reset, then the session's runtime
  │
runtime.ts      dispatch: find the owner (focused screen first, then ambient nodes),
  │             check sessionId, expectedRevision and availability, adapter.prepare
  │             (validates input), record an operation, then start it
capability.ts   the action's handler runs as an Effect in the screen's scope, and
  │             writes state through StateAccess; a new value is encoded, redacted
  │             and checked before it replaces the old one
runtime.ts      state.changed, operation.started and operation.finished events,
                each with the session's next sequence, into the event log and out
                to every subscriber
```

The reply to `app.dispatch` means the action was **accepted**. Completion is a separate
wait. `reflex do` waits up to `--timeout` (default 5 s) for the operation, then up to 1 s
for nothing to be running, and prints both: an operation that outlasts the wait is
reported as `running`, with `settled: false`, and the command still succeeds. Only a
`failed` operation sets a non-zero exit. `--no-wait` returns once the action is accepted.

### 4.2 Navigation, and the router following it

`reflex do OpenProduct '{"productId":"product-123"}'` with the app rendered by Expo.

```text
inventory-list.ts   OpenProduct's action.navigates handler returns Nav.push(InventoryDetail, …)
author-actions.ts   queue the command after its handler and child scope finish
navigation.ts       execute the command: build the screen in a scope of its own, push it, set focus (the runtime starts onFocus as a tracked operation); the Navigation
                    node's state (the stack) changes
react.tsx           useCoreStack sees the new stack; RouterProjection hands it to
projection-         ProjectionController.onStack ─► syncRouter (pure, projection.ts)
  controller.ts     says push; router.push with the entry's node handle as the
                    reflexNode route param
router-actions.ts   Expo Router reports the action it accepted; onLocation sees the
                    new top; the push has arrived
```

Navigation is authoritative in the core; the router is a projection of it
([ADR 0003](decisions/0003-the-core-owns-navigation.md)).

### 4.3 The user navigates

A back gesture, hardware back, browser back or deep link.

```text
Expo Router         changes its state by itself
router-actions.ts   reports it ─► ProjectionController.onLocation
projection.ts       interpret: a lower entry is a return, so pop the core to it; an
                    unknown location is a new destination, so Navigate to it
core-port.ts        dispatch GoBack or Navigate on the Navigation node
```

What the router decides stands. If Android's hardware back lands during a pending push,
the router pops the screen beneath and the push still lands; the core follows both.

### 4.4 A command against the app on a device

`reflex --target device do Increment`, with `reflex --target device start` running and
the app connecting with the printed appSetting (`EXPO_PUBLIC_REFLEX_BRIDGE` in Expo).

```text
cli.ts ─► commands.ts ─► device transport ─► server.ts   (as in 4.1)
bridge-controller.ts   forward to the connected app's client; if none is
                       connected, wait up to REFLEX_APP_WAIT_MS for one
bridge-server.ts       one WebSocket per app, admitted by a token hello
live/bridge.ts         the app's side: createConnection over that socket
live-controller.ts     a Controller over the app's current live session
runtime.ts             as in 4.1; an optional React UI subscribes through useSyncExternalStore
```

### 4.5 The app reloads, or loses its connection

```text
socket closes        bridge-server.ts detaches the app; requests in flight fail
                     SessionClosed ("may or may not have run"); new ones wait
app redials          bridge.ts backs off 0.5 s to 5 s; hello; attach
subscriptions        each resumes from its cursor. Same session: replays only what
                     was missed. A reload is a new session, so the cursor means
                     nothing there and the subscriber gets resync.required
```

A wrong token, a protocol mismatch or being replaced by another app closes the
connection with a code the app treats as final; it stops redialling.

### 4.6 An MCP tool call

```text
mcp-stdio.ts   a line on stdin
mcp.ts         tools/call: check every argument, then connect to the target's
               session, then run the matching commands.ts function
commands.ts    exactly what the CLI command runs, as in 4.1 or 4.4
mcp.ts         the result as text and structuredContent; failures as isError
```

There is no MCP-specific control path ([ADR 0009](decisions/0009-mcp-reuses-the-cli.md)).

### 4.7 A reset

`reflex reset slow-network`, or `app.reset` from a journey.

```text
controller.ts   check the scenario exists (an unknown one leaves the session as it
                was); queue behind any reset in progress; end the old session (its
                scopes close, so every screen's work is interrupted); start the
                scenario's Layers under a new session id; move subscribers with
                a cursor from the old session, so each gets resync.required
```

Once the old session has ended there is no way back to it. If the new one fails to start,
the controller has no session: every request fails with `SessionClosed`, saying to reset
again, which is how to recover.

On a device the same request goes through `LiveSessions.reset`, and the screen shows the
new session. Live starts use the runtime's default start budget (30 s), not
`REFLEX_START_TIMEOUT_MS`, which configures only headless sessions.

## 5. State and storage

The runtime has no database. App services may persist independently of sessions
(the inventory live scenario uses a local API and AsyncStorage; ADR 0019). A session's
state is its nodes' state, in memory, for as long as
the session lives. On disk, per `REFLEX_DIR` (default `./.reflex`, which must be private to
its owner):

| File                                    | What it is                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `session.auth`, `device.auth`           | Windows per-session secret, checked private ACL; removed on stop           |
| `session.sock`, `device.sock`           | Each target's Unix socket, `0600` (no pipe file on Windows)                |
| `session.lock`, `device.lock`           | The daemon's pid, created atomically                                       |
| `session.log.<pid>`, `device.log.<pid>` | A daemon's log, at most 1 MiB, removed after a clean run                   |
| `device.token`                          | The bridge's token, kept across restarts; Unix `0600`, Windows private ACL |

Windows pipe names hash the resolved directory and target; they are kernel objects,
probed by connection rather than file existence. Windows storage uses checked ACLs,
not Unix mode bits. `windows-security.ts` owns ACL creation/checking. Clients authenticate
and encrypt frames before the controller sees JSON-RPC, including shutdown. The daemon
rotates its local secret only after obtaining its lock; the device bridge token persists.

## 6. Cross-cutting concepts

- **Local authentication.** Unix permissions remain the boundary; Windows peers mutually
  authenticate and encrypt traffic using an ACL-protected secret (ADR 0012). Random
  receipt challenges bound native queues independently of Bun's write completion API. Same-user
  processes, SYSTEM and administrators are trusted. StdIO has its parent as the boundary.
- **Limits.** Every resource a peer can make a session spend is bounded in
  `packages/protocol/src/limits.ts`. Past a limit, a request is generally refused with
  `ResourceExhausted`, or the peer is disconnected if it cannot be told. Navigation is
  the exception: a full stack is the typed failure `NavigationStackFull`, or makes
  `Navigate` unavailable ([ADR 0006](decisions/0006-everything-is-bounded.md)).
- **Time.** Code takes a `Timers` port instead of calling `setTimeout`, so tests control
  time. Virtual-time scenarios run on Effect's `TestClock`, moved only by `advanceTime`.
- **Identity.** Node handles name their session (`screen/InventoryDetail/session-ab12-1/4`),
  so a handle from before a reset cannot match anything after it. Revisions count changes;
  sequences count events; a cursor is a session id and a sequence.
- **Secrets.** Store nodes require an explicit safe projection; there is no automatic
  redaction on that path. Effect `Schema.Redacted` values are replaced before any state, error data or route
  param is encoded. Unusual cases fail closed rather than leak
  ([ADR 0011](decisions/0011-secrets-fail-closed.md)).
- **Errors.** Expected outcomes are `ProtocolError`s with a code from
  `packages/protocol/src/contracts.ts`, or a failed operation. Failures with nobody to
  answer go to the session's `onBackgroundError` reporter.
- **Access.** A peer has a policy: `control` (the default), `observe`, or an allowlist of
  actions. `restrictController` enforces it for a connection before a request reaches the
  session; the CLI's `--access` and the MCP server hold themselves to one as a guard
  ([ADR 0013](decisions/0013-access-policies.md)).
- **Cancellation.** A peer that disconnects aborts its waits. A client can cancel one
  request with `$/cancelRequest`; the bridge forwards it to the app.

## 7. Invariants

What must stay true when you change things. Most have a test; the test names say which.

- **Core-owned navigation is authoritative when adopted.** Navigation lives in the `Navigation` node; the
  router is a projection. App code in that mode navigates through actions, never `router.replace`.
  Incremental adopters keep their router, report focus, and do not mount RouterProjection.
- **Effect state is written only through `StateAccess`.** Action handlers and `onFocus` receive
  it; an owner that mounts with `mountWithAccess` holds it too. Nothing else can write a
  node's state.
- **Closed write capabilities cannot be used.** Effect state access rejects reads and writes
  after its node closes, before invoking a transition. Store handlers receive revocable
  store access: cancellation revokes it before abort listeners run, and disposal revokes
  every handler. Extracted methods retain this check. Raw stores retained outside the
  handler remain application-owned.
- **Effect state is immutable.** An update returns a new value. Returning the same object is
  taken as no change: no encoding, no event, no new revision. The UI and protocol read a detached, deeply frozen
  encoded, redacted copy, so mutating the decoded value in place would
  silently separate the two.
- **Store state has a public boundary.** mountStore requires a bounded, checked JSON
  projection, retains a detached frozen copy, and emits no event for identical public
  JSON. Application stores retain write ownership; invalid external writes cannot be
  rolled back. Availability dependencies belong in that projection.
- **Accepted is not completed.** `app.dispatch` answers once an operation is recorded.
  Its outcome is an `operation.finished` event or a wait.
- **Screens are actionable only while focused.** Navigation, service and fixture nodes
  are ambient and actionable always. An action without a node goes to the focused screen
  first, then to the one ambient node that has it, else it is ambiguous.
- **Popping a core-owned screen cancels its work.** Each screen owns a scope; popping it interrupts
  every running action and its `onFocus`. Pushing another screen on top only takes its
  focus: it refuses new actions, but work already running carries on. Existing routers
  report focus with useNodeFocus and must dispose their own popped nodes; store work
  cancels cooperatively through AbortSignal.
- **Session resources do not survive a reset.** Handles, operations and waits belong to one session.
  Pending waits reject with `SessionClosed`; a cursor from another session always gets
  `resync.required`.
- **A peer that missed events is told so.** An event that cannot be delivered or retained
  becomes `resync.required`, never a silent gap.
- **Live and headless answer alike.** The conformance suite runs against both. The live
  controller shares the headless one's limits, reset ordering and control deadlines; only
  the session start budget differs (see 4.7).
- **The production app has no bridge.** It is loaded only behind `__DEV__`, with its
  setting read inside that branch. `e2e:live` checks a production export for it.
- **No unauthenticated Windows commands.** Pipe peers authenticate before any controller
  request; frames have confidentiality, integrity and replay protection. Pipe names are
  discovery, never authentication.
- **One implementation per command.** The CLI and the MCP tools both call `commands.ts`.
- **A restricted peer changes only what its policy allows**, and a refused request has no
  effect. Every protocol method is classified in `access.ts`; an unclassified one is refused.

## 8. Decisions

| ADR                                                                  | Decision                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [0001](decisions/0001-hand-written-json-rpc.md)                      | The wire is hand-written JSON-RPC over NDJSON                    |
| [0002](decisions/0002-the-runtime-is-effect-free.md)                 | The runtime is free of Effect; Effect is one way to build nodes  |
| [0003](decisions/0003-the-core-owns-navigation.md)                   | The core owns navigation; the router is a projection             |
| [0004](decisions/0004-plain-state-with-listeners.md)                 | Node state is a plain value with listeners                       |
| [0005](decisions/0005-expo-router-private-actions.md)                | Read Expo Router's private action event, pinned                  |
| [0006](decisions/0006-everything-is-bounded.md)                      | Everything a peer can reach is bounded, in one file              |
| [0007](decisions/0007-socket-permissions-are-the-authentication.md)  | Socket permissions are the authentication                        |
| [0008](decisions/0008-the-device-dials-out.md)                       | The device dials out to a bridge                                 |
| [0009](decisions/0009-mcp-reuses-the-cli.md)                         | MCP tools reuse the CLI's commands                               |
| [0010](decisions/0010-operations-and-interruption.md)                | Operations are accepted, then finish; back acts as return        |
| [0011](decisions/0011-secrets-fail-closed.md)                        | Secrets are removed before encoding, failing closed              |
| [0012](decisions/0012-windows-sessions-use-authenticated-pipes.md)   | Windows sessions use authenticated, encrypted pipes              |
| [0013](decisions/0013-access-policies.md)                            | Access policies: observe, an action allowlist, or control        |
| [0014](decisions/0014-keep-the-hand-written-wire.md)                 | Keep the hand-written wire rather than adopt Effect RPC          |
| [0015](decisions/0015-xstate-fits-the-node-adapter.md)               | XState fits NodeAdapter with explicit event-completion semantics |
| [0016](decisions/0016-adoption-without-effect.md)                    | Existing stores, public projections and generic Expo bindings    |
| [0017](decisions/0017-framework-free-live-and-react-bindings.md)     | Framework-free live serving and generic React bindings           |
| [0018](decisions/0018-router-neutral-projection-and-react-router.md) | Router-neutral projection and existing React Router apps         |
| [0019](decisions/0019-real-services-in-the-expo-app.md)              | Real HTTP and device storage composed only in the app            |

## 9. Influences

Where the design comes from, and what each source taught. The reasoning that became a
decision is in its ADR; what is still to do is in [roadmap.md](roadmap.md).

- **[Shopify Reflex](https://shopify.engineering/reflex).** Behavior lives in a core with a
  strict boundary from the UI, runs headless, and is driven by fixtures and a CLI. Shopify
  argued against publishing it as a library, because it was coupled to their navigation,
  sessions and fixtures. Reflex draws the reusable line lower: the protocol, the runtime,
  transports, the CLI and the test SDK are reusable; the navigation model is optional; an
  app's state architecture, business logic and fixtures stay the app's own.
- **[XState](https://stately.ai/docs/inspection).** The actor contract (a stable identity
  while alive, events in, snapshots out, subscriptions, a lifecycle) is what a node is.
  XState also keeps inspection observational, separate from sending events; so can a
  Reflex peer ([ADR 0013](decisions/0013-access-policies.md)). A real XState actor now passes
  the shared conformance suite; event completion and actor lifecycle have explicit mappings
  ([ADR 0015](decisions/0015-xstate-fits-the-node-adapter.md)).
- **[Redux DevTools](https://github.com/reduxjs/redux-devtools).** Transitions are actions,
  not state writes. A protocol that could set `cart.quantity` would bypass validation,
  business rules and effects, so clients can only dispatch named, validated actions.
- **[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) and the
  [Dart VM Service](https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md).**
  Never send live objects across a process boundary; refer to them by handle. Reflex's
  handles are semantic (`screen/InventoryDetail/<session>/4`), name their session, and exist
  only for explicitly registered nodes. Versioned RPC and ordered event streams come from
  here too.
- **[Playwright MCP snapshots](https://playwright.dev/mcp/snapshots).** Give agents a
  compact, semantic observation, not a dump: which screen is active, what it shows, what can
  be done and with what input, and what changed. That is `reflex ls`.
- **[MCP](https://modelcontextprotocol.io).** An external interface for agents, not the
  internal contract: revisions, node lifecycle, event order and resets need semantics of
  their own ([ADR 0009](decisions/0009-mcp-reuses-the-cli.md)).
- **[Effect](https://effect.website) v4.** Schemas that yield validation, JSON Schema and
  generators from one definition; services as Layers, so scenarios swap fixtures in;
  scopes and fibers, so popping a screen interrupts its work; `TestClock` for virtual time.
  Effect is how the example app is built, not what the protocol requires
  ([ADR 0002](decisions/0002-the-runtime-is-effect-free.md)).

## 8. Author-facing contracts

[ADR 0020](decisions/0020-type-bearing-userland-contracts.md) records the value-based API.
Effect capabilities and store definitions retain exact consumer action maps and state.
NodeHandle is structural and framework-free; outcomes adapt existing operations/refusals
without changing protocol messages. The test client's transport binds the definition's
own serializers. Apps register node definitions for typed journey membership.

Screen capabilities own params and initial state. Navigation derives screen factories;
Expo's registration derives both mapping directions. React owns commit-time mounting and
history-entry retention. Runtime setFocus invokes the adapter lifecycle only on arrival;
routers and core navigation call this same operation.

Public roots expose author APIs. Effect integration helpers are under `/internal`, with ownership APIs under `/advanced`;
React has only its root and `/advanced`. These subpaths keep their package's existing
dependency direction. Expo exports its bound factory, projection and guarded development bridge from the root;
its `/internal` entry also supplies the bridge to plain integrations without importing Effect.
Expo URL binding helpers may import Effect. Generic React entries remain Effect-free. Vite's live/vite entry dynamically imports the dialler only in development.
Production exclusion is checked by browser builds. UI entry files delegate optional test
instrumentation to a development module, which production Metro removes.

## Contract and consumer boundary

Screen contracts precede handler imports (ADRs 0021 and 0022) and share identity with
implementations. `defineApp` composes a navigation implementation and declares fixtures
once; scenario layers remain plain Layers. UI and journey
consumers read wire state, while handlers read decoded state. Store projections are JSON
and guards publish independently of projection equality. React owns bounded history-entry
retention; router adapters supply only location identity and focus. Protocol probes live
in root test/, and examples teach typed stories. Mobile E2E instrumentation lives in
e2e/, loaded only through the compile-time selector in e2e/entry.tsx.

Host binding factories attach the app to a Provider and typed screen/session hooks (ADR 0022).
Session route factories provide Effect services and scenario store overrides. React Router
mounts through these factories; Expo resolves core-owned screen instances. Navigating actions
finish their handler before queued navigation can retire the screen, so a successful back
reports completed. Other work on a popped screen is still cancelled. Documentation snippets
and compiler diagnostic text are checked in CI alongside the instantiation budget.
