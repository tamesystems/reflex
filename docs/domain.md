# Domain

The vocabulary of Reflex. Several words here have everyday meanings that differ from what
they mean in this code; the definitions below are the ones the code uses.

```text
host (an app definition)
  └─ starts → session (one per start or reset; has a session id)
                ├─ runtime: the registry
                │    ├─ nodes ── screen, navigation, service, fixture
                │    │     ├─ state  (JSON on the wire, a revision when it changes)
                │    │     └─ actions ── run as → operations
                │    ├─ focus  (one screen, or none)
                │    └─ event log  (events, numbered by sequence)
                └─ scenario: the services it was started with

client ── connects to → controller ── serves → the current session
                         ├─ SessionController (the app runs here: headless)
                         ├─ LiveController    (the running app: inside the app)
                         └─ BridgeController  (forwards to a live app: device target)
```

## The app

**Host** (`AppHost`). An app definition that can start sessions: its name, its scenarios,
and `start`. `defineApp` makes one from Effect layers; anything with the same shape works.

**Scenario.** A named way to start the app: the services it runs with, usually fixtures in
place of the network. Some run on **virtual time**, a clock that moves only when a client
calls `advanceTime`. A **fixture** is a stand-in service, often with a node of its own.

**Capability.** The definition of a kind of node: a state schema, actions and an optional
`onFocus`. `defineCapability` makes one; `mount` turns it into a live node. A screen also owns its params schema and `initial(params)`. Store definitions use `defineStoreNode`; both produce the same consumer-facing `NodeHandle`.

**Node.** A live, stateful thing a client can see and act on. Its **type** decides when it
can act:

- **screen**: a place the user can be. Actionable only while it has **focus**.
- **navigation**: the route stack (one per app, named `Navigation`). Ambient.
- **service**, **fixture**: app or test machinery exposed on purpose. Ambient.

**Ambient.** Actionable whatever has focus. An action sent without a node goes to the
focused screen if it has one by that name, otherwise to the one ambient node that does.

**Node id** (`NodeId`). A node's identity, such as `screen/InventoryDetail/session-ab12-1/4`.
It names its session, so it means nothing after a reset. Two screens of the same kind,
even with the same params, have different handles.

**Action.** A named, typed operation on a node: an input schema, an `available` check that
returns `true` or why not, and a handler. Its input schema is published as JSON Schema.

**Operation.** One run of an action, or of `onFocus`. It is **running**, then **completed**,
**failed** (with a typed error, or a **defect** for a bug) or **cancelled**. Dispatch returns
it as soon as it is **accepted**; that is not completion.

**Public projection.** The explicit JSON-only view of an existing store published by
`mountStore`. It excludes secrets and internal machinery; the store remains application-owned.

**Focus.** The screen the user is on: the top of the core navigation stack, or the screen
reported by an existing router through `useNodeFocus`. Every focus arrival starts the screen's `onFocus`, if present, as a tracked operation. Repeating the current focus does not restart it.

**Route**, **stack**, **entry**. A route is a kind of screen with a params schema; the stack
is the list of entries the user has opened, each an instance of a route with its own scope
and handle. Popping an entry ends its scope, which cancels its work.

## Sessions and their history

**Session.** One running instance of the app, from a start to its end. A **reset** ends it
and starts a new one, on the same or another scenario. Node state does not carry over. App-owned external service data may persist; the
inventory live scenario re-reads its API and device storage.

**Revision.** A count of changes in a session. Each node's snapshot carries the revision at
which it last changed, so `expectedRevision` on a dispatch refuses to act on a node that has
changed since it was looked at.

**Event**, **sequence.** Every change produces an event (`state.changed`, `node.added`,
`focus.changed`, `operation.started`, `operation.finished`, …), numbered by the session's
sequence. The **event log** keeps the most recent ones.

**Cursor** (`{ sessionId, sequence }`). Where a subscriber has read up to. Subscribing with
it replays what came after, if the log still has it. A cursor from another session, or
one older than the log, gets **`resync.required`**: discard what you knew and inspect again.

**Wait.** A request that returns when a condition holds: a screen has focus, a node's state
contains a subset (`match`), an operation has finished, or nothing is running (`idle`). It
fails with `WaitTimeout`, carrying the state at the time, if the condition does not hold.

## Serving and reaching sessions

**Controller.** What serves the protocol for one app: requests, subscriptions, close. The
three kinds above all speak the same protocol, so a client cannot tell them apart.

**Access policy.** What a peer may do: `control` (everything), `observe` (read, wait and
subscribe), or an allowlist of actions it may also run. Refusals are `NotPermitted`.

**Target.** Which session a CLI command reaches: **headless** (the app running in a daemon
on this machine, with no UI) or **device** (any live app, including a plain server process, through a
bridge). Each target has its own socket, so both can run at once.

**Daemon.** A background session process, started by `reflex start`, that serves its
controller on a Unix socket or authenticated Windows named pipe.

**Bridge.** The device target's daemon: a WebSocket server the app dials, plus a
controller that forwards to whichever app is connected. The app's **setting**
(`ws://host:port#token`) tells it where the bridge is and how to prove it may connect.

**Projection.** A router showing the core's navigation through @reflex/navigation ports.
Expo Router is the current concrete adapter. The core decides; the router
is told what to show, and what it does on its own (gestures, links) is fed back as
actions. `reflexNode` is the route param carrying an entry's handle, so router entries are
matched to core entries by identity, never by URL.

**Journey.** A behavior test written as a user's path through the app, using
`@reflex/test`. **Exploration** is a random walk through whatever is available.

Navigation and focus are optional. A service-only app needs neither; `screen` remains
the protocol name for a focus-gated node. Expo Router projection is one optional binding.

## Author contracts

**Definition.** A real value carrying state, input, actions, declared errors and guards.
UI bindings and journeys consume this value; they do not reconstruct its types.

**Node handle** (`NodeHandle`). The consumer's typed snapshot/subscription, action object,
availability. Ownership is separate from consumer access. Distinct from its opaque protocol id. `actions.Save()` takes no
input; `actions.SetQuantity({ quantity })` requires exactly that action's input.

**Action outcome.** The local result: completed, cancelled, refused with a reason,
domain-error with safe declared data, or defect. Wire operations retain their original
running/completed/failed/cancelled statuses. Consumers see encoded/redacted public state and error data; handlers retain decoded state.

**Guarded reducer.** `action.when(tag).reduce(...)` narrows state and rechecks its tag before
the synchronous commit. Async guarded updates recheck the tag at commit. `state.when(tag)` selects another phase.

**History-entry lifetime.** A React node mounted after commit and retained by the library
under the router's location key within a 64-entry budget. It survives back/forward without an
application cache; a new push frees unreachable forward entries. Component lifetime disposes when its owning component releases it.

**Screen contract.** State, params and initial state established before implementations.
`.implement` attaches actions/lifecycle hooks. Navigation depends only on contracts.

**Node view.** A composed React hook result with explicit pending/ready status, public
state and per-action run/available/reason/pending controls.
