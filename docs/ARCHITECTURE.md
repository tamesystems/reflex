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
 │ App on a device, simulator or browser (Expo)   │
 │   connectBridge ─► LiveController ─► session ──┼─► the same app core
 │   ReflexProvider renders that same session     │
 └────────────────────────────────────────────────┘
```

The app always dials out to the bridge; it never listens
([ADR 0008](decisions/0008-the-device-dials-out.md)).

## 3. Code map

```text
packages/
  protocol/   The contract. Types, parsers for every message, error codes, limits.ts.
              Depends on nothing. Start: contracts.ts, limits.ts.
  runtime/    Node registry, operations, waits, event log (runtime.ts), and the
              SessionController that starts, resets and closes sessions (controller.ts).
              No Effect, no platform APIs. Start: runtime.ts, then controller.ts.
  rpc/        JSON-RPC 2.0 over newline-delimited JSON. server.ts is one peer's
              connection to a Controller; client.ts the other end; socket.ts the Unix socket, Windows pipe and stdio transports;
              local-auth.ts authenticates Windows pipe peers; local-cipher.ts encrypts
              frames and validates proof-of-read credits for bounded native buffers;
              socket-writer.ts counts queued bytes until write callbacks complete;
              socket-shutdown.ts waits for the Windows shutdown reply receipt; bridge-controller.ts a Controller that
              forwards to whichever app is connected.
  effect/     How an Effect app becomes nodes. capability.ts (defineCapability, mount),
              navigation.ts (defineNavigation: the stack, a scope per screen),
              app.ts (defineApp: scenarios as Layers, virtual time), redaction.ts.
  test/       createTestApp journeys and explore random walks, through the real protocol.
  cli/        The reflex command. cli.ts parses; commands.ts does; session.ts runs and
              finds daemons; bridge-server.ts accepts apps; mcp.ts serves MCP tools.
              See packages/cli/README.md.
  expo/       React bindings (react.tsx), the Expo Router projection (projection.ts,
              projection-controller.ts), the app's side of the bridge (bridge.ts,
              live-sessions.ts, live-controller.ts). See packages/expo/README.md.
examples/
  inventory/  A three-screen app core with fixture scenarios. Imports only Effect and
              @reflex/effect: no React, no Expo.
apps/
  mobile/     The same inventory core rendered by Expo Router. Own install. e2e/ holds
              the browser journeys, hermes-smoke/ runs a journey on a Hermes VM.
test/         Cross-package suites: conformance (one suite, several backends),
              boundaries (the dependency rules), lifecycle, the bridge end to end.
bench/        Wire and encoding costs.
```

### Dependency rules

```text
protocol ◄── runtime ◄── rpc ◄── test
    ▲           ▲         ▲  ◄── cli
    │           │         │
    └──── effect ◄────── expo (uses rpc/connection only) ◄── apps/mobile
                ▲
     examples/inventory
```

- `protocol` depends on nothing. `runtime` depends only on `protocol`.
- Nothing below `effect` imports Effect; `test` and `cli` need no Effect and no app.
- `expo` reaches `rpc` only through `@reflex/rpc/connection`, which has no Node APIs.
- An app core (`examples/inventory`) never imports React, Expo or a device API.
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
inventory-list.ts   OpenProduct's handler calls nav.push("InventoryDetail", …)
navigation.ts       build the screen in a scope of its own, push it, set focus,
                    start its onFocus as a tracked operation; the Navigation
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
the app started with `EXPO_PUBLIC_REFLEX_BRIDGE` set.

```text
cli.ts ─► commands.ts ─► device transport ─► server.ts   (as in 4.1)
bridge-controller.ts   forward to the connected app's client; if none is
                       connected, wait up to REFLEX_APP_WAIT_MS for one
bridge-server.ts       one WebSocket per app, admitted by a token hello
expo/bridge.ts         the app's side: createConnection over that socket
live-controller.ts     a Controller over the session ReflexProvider shows
runtime.ts             as in 4.1; React re-renders through useSyncExternalStore
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

There is no database. A session's state is its nodes' state, in memory, for as long as
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
- **Secrets.** `Schema.Redacted` values are replaced before any state, error data or route
  param is encoded. Unusual cases fail closed rather than leak
  ([ADR 0011](decisions/0011-secrets-fail-closed.md)).
- **Errors.** Expected outcomes are `ProtocolError`s with a code from
  `packages/protocol/src/contracts.ts`, or a failed operation. Failures with nobody to
  answer go to the session's `onBackgroundError` reporter.
- **Cancellation.** A peer that disconnects aborts its waits. A client can cancel one
  request with `$/cancelRequest`; the bridge forwards it to the app.

## 7. Invariants

What must stay true when you change things. Most have a test; the test names say which.

- **The core is the source of truth.** Navigation lives in the `Navigation` node; the
  router is a projection. App code navigates through actions, never `router.replace`.
- **State is written only through `StateAccess`.** Action handlers and `onFocus` receive
  it; an owner that mounts with `mountWithAccess` holds it too. Nothing else can write a
  node's state.
- **State is immutable.** An update returns a new value. Returning the same object is
  taken as no change: no encoding, no event, no new revision. The UI reads the decoded
  value; the protocol reads its encoded, redacted copy, so mutating in place would
  silently separate the two.
- **Accepted is not completed.** `app.dispatch` answers once an operation is recorded.
  Its outcome is an `operation.finished` event or a wait.
- **Screens are actionable only while focused.** Navigation, service and fixture nodes
  are ambient and actionable always. An action without a node goes to the focused screen
  first, then to the one ambient node that has it, else it is ambiguous.
- **Popping a screen cancels its work.** Each screen owns a scope; popping it interrupts
  every running action and its `onFocus`. Pushing another screen on top only takes its
  focus: it refuses new actions, but work already running carries on.
- **Nothing survives a reset.** Handles, operations and waits belong to one session.
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

## 8. Decisions

| ADR                                                                 | Decision                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| [0001](decisions/0001-hand-written-json-rpc.md)                     | The wire is hand-written JSON-RPC over NDJSON                   |
| [0002](decisions/0002-the-runtime-is-effect-free.md)                | The runtime is free of Effect; Effect is one way to build nodes |
| [0003](decisions/0003-the-core-owns-navigation.md)                  | The core owns navigation; the router is a projection            |
| [0004](decisions/0004-plain-state-with-listeners.md)                | Node state is a plain value with listeners                      |
| [0005](decisions/0005-expo-router-private-actions.md)               | Read Expo Router's private action event, pinned                 |
| [0006](decisions/0006-everything-is-bounded.md)                     | Everything a peer can reach is bounded, in one file             |
| [0007](decisions/0007-socket-permissions-are-the-authentication.md) | Socket permissions are the authentication                       |
| [0008](decisions/0008-the-device-dials-out.md)                      | The device dials out to a bridge                                |
| [0009](decisions/0009-mcp-reuses-the-cli.md)                        | MCP tools reuse the CLI's commands                              |
| [0010](decisions/0010-operations-and-interruption.md)               | Operations are accepted, then finish; back acts as return       |
| [0011](decisions/0011-secrets-fail-closed.md)                       | Secrets are removed before encoding, failing closed             |
| [0012](decisions/0012-windows-sessions-use-authenticated-pipes.md)  | Windows sessions use authenticated, encrypted pipes             |
