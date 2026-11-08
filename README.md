# Reflex

A small protocol and runtime that makes application behavior inspectable and
executable without its UI. Inspired by Shopify's Reflex, as described in
[their engineering post](https://shopify.engineering/reflex); this is an independent
project, not affiliated with or endorsed by Shopify. [IDEA.md](IDEA.md) is the original
design research, kept as written.

This is an experimental workspace to clone, not a set of published npm packages: every
package is private, at version 0.0.0, and exports its TypeScript sources directly.

An app exposes a graph of stateful nodes. Clients can read their state, discover
typed actions, dispatch them, and observe what changes. The client can be a CLI,
a test, or a coding agent, and no simulator or renderer is involved.

```console
$ bun run reflex start examples/inventory/src/app.ts
$ bun run reflex do OpenProduct '{"productId":"product-123"}'
$ bun run reflex do SetQuantity '{"quantity":12}'
$ bun run reflex do Save
$ bun run reflex ls
$ bun run reflex stop
```

## Getting started

You need [Bun](https://bun.sh) 1.4.4 on macOS or Linux. The browser journeys also need
Node 24 and Google Chrome; the Hermes smoke test needs a Hermes VM (see
`.github/workflows/ci.yml`).

```console
$ bun install --frozen-lockfile
$ bun install --frozen-lockfile --cwd apps/mobile   # the Expo app has its own install
$ bun run check                                     # format, lint, typecheck, tests
```

Run Expo commands, such as `bunx expo start`, from `apps/mobile`.

## Packages

| Package              | Purpose                                                          | May depend on                                       |
| -------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `@reflex/protocol`   | JSON contracts, error codes                                      | nothing                                             |
| `@reflex/runtime`    | Node registry, revisions, operations, events, session controller | protocol                                            |
| `@reflex/rpc`        | JSON-RPC 2.0 over NDJSON: Unix socket, stdio, loopback, bridge   | protocol, runtime                                   |
| `@reflex/effect`     | `defineCapability`, `defineNavigation`, `defineApp`              | protocol, runtime, effect                           |
| `@reflex/test`       | `createTestApp` journey SDK, `explore` random walks              | protocol, rpc, runtime                              |
| `@reflex/cli`        | The `reflex` command                                             | protocol, rpc, runtime                              |
| `@reflex/expo`       | React bindings, the Expo Router projection, the app's bridge     | protocol, runtime, effect, `@reflex/rpc/connection` |
| `examples/inventory` | Three-screen app with fixture scenarios                          | effect                                              |
| `apps/mobile`        | The same app rendered by Expo                                    | expo                                                |

Effect is optional. `test/conformance.test.ts` runs one suite against an
Effect-backed app and a plain store, and `test/boundaries.test.ts` enforces the
dependency column above.

## Defining behavior

One definition yields validation, JSON Schema, availability, and input generators:

```ts
export const InventoryDetail = defineCapability({
  name: "InventoryDetail",
  state: State,
  onFocus: (state) => /* load, as an Effect */,
  actions: (action) => ({
    SetQuantity: action({
      input: Schema.Struct({ quantity: Quantity }),
      available: (s) => (s.saving ? "Save in progress" : true),
      handler: ({ quantity }, state) => state.update((s) => ({ ...s, quantity }))
    })
  })
})
```

Services are ordinary Effect requirements, so a scenario is a `Layer` that
satisfies them. Fixtures can mount `type: "fixture"` nodes, which lets journeys
and agents observe doubles and steer them (`FailNextSave`) through the protocol.

## Testing

```ts
const app = await createTestApp(host, { scenario: "slow-network" })
await app.do("OpenProduct", { productId: "product-123" })
const save = await app.start("Save")
await app.advanceTime(5_000) // virtual: returns immediately
await app.waitFor({ operationId: save.operationId })
expect(app.state.error).toBe("Save timed out")
```

`explore(host, { invariant })` walks whatever the app says is available, generates
inputs from each action's schema, and shrinks any failure as far as its budget allows.
Use `knownInputs` for values a schema cannot know, such as ids that must exist.

`bun run check` runs the formatter, linter, both typechecks and the tests, as CI
does. CI also runs the browser journey and the Hermes smoke test. `bun run --cwd apps/mobile
e2e:live` runs the live bridge in Chrome.

## Semantics worth knowing

- **Accepted is not completed.** `app.dispatch` returns an operation. Pass
  `await: true` or call `app.wait` to see how it ended.
- **Leaving a screen cancels its work.** Each route instance owns a scope.
- **`nav.back` from a handler acts like `return`.** It interrupts that handler, so
  the operation reports `cancelled` even if its work finished. Assert on state.
- **Handlers run synchronously until they first suspend.** To block a second
  dispatch through `available`, update state before suspending.
- **`expectedRevision` is per node**, so unrelated background changes don't
  invalidate an observation.
- **Screens are actionable only while focused.** Other node types are ambient.
- **Secrets:** `Schema.Redacted` encodes to plaintext through `Schema.toCodecJson`.
  State, typed error data and route params are checked for secrets before encoding.
  The real decoded value is validated against its schema; a separate publishing
  codec encodes the redacted view without applying secret refinements to placeholder
  text. This includes `RedactedFromValue`, collections and renamed keys. Collection
  insertion order is preserved. Four cases fail closed instead of being encoded: a secret
  behind an accessor, one on a prototype, one attached to an ArrayBuffer view,
  and a `Redacted` that does not hold a string. Native views keep their internal
  slots; their own and inherited properties are checked but cannot be replaced.
  Options are copied with their own properties, including any extra fields.
  Strings you write into an error `message` are not scrubbed.
- **Focus failures are observable.** Every failed `onFocus`, including a declared
  error, finishes a tracked operation and reaches the session's `onBackgroundError`
  reporter (structured console output by default). The framework leaves state to
  the app: catch expected loading failures in `onFocus` and update state for recovery.
  Expo's fire-and-forget `send` reports defects and `ResourceExhausted` outcomes;
  declared business failures remain the app's to reflect in state. Stale taps on a
  closing screen and actions already unavailable are ignored.
- **Resets end things.** Handles never survive a reset, pending waits reject with
  `SessionClosed`, and `sessionId` on a dispatch rejects stale observations. A
  cursor from another session always gets `resync.required`.
- **Everything is bounded.** `packages/protocol/src/limits.ts` lists every limit a
  peer can reach. Going past one is refused with `ResourceExhausted`, and a reply
  too large or too deep to send becomes that error. An event that cannot be sent
  becomes `resync.required`.
- **Slow peers are disconnected** once a reply would take the write queue past
  32 MiB, and frames are capped at 8M characters. Reconnect and subscribe with
  a `since` cursor to resynchronize.
- **`Struct({})` is not an empty object.** Its JSON Schema allows any non-null
  value, so omit `input` for actions that take none.

## Status

| Milestone (IDEA.md)             | Status |
| ------------------------------- | ------ |
| 1. Headless core                | Done   |
| 2. Introspection and CLI        | Done   |
| 3. Navigation and journey tests | Done   |
| 4. Live Expo bridge             | Done   |
| MCP adapter                     | Done   |

### Live bridge

The same commands drive the app running on a device. The app dials out to a bridge on
your machine and serves the protocol over that one WebSocket, so it opens no port:

```console
$ bun run reflex --target device start          # prints appSetting and androidEmulatorSetting
$ EXPO_PUBLIC_REFLEX_BRIDGE='ws://127.0.0.1:8790#<token>' bunx expo start
$ bun run reflex --target device do OpenProduct '{"productId":"product-123"}'
$ bun run reflex --target device ls
```

`--target device` (or `REFLEX_TARGET=device`) works with every command. Each target has
its own session files, so a headless session and a bridge can run side by side. The app
passes its setting to `ReflexProvider`'s `bridge` prop, as `apps/mobile/app/_layout.tsx` does.

- **Development only.** The app loads the bridge behind `__DEV__`, reading the setting
  inside that branch. A production build drops both the bridge and the token, even with
  the variable set. `bun run e2e:live` checks the exported bundles for both.
- **Authenticated.** The token is 32 random bytes in `.reflex/device.token` (`0600`),
  kept across restarts so a configured app stays configured. An app must say hello with
  it within 5 seconds. A wrong token or protocol version closes the connection with a
  code the app treats as final, so it stops redialling. Strangers that have not said
  hello are capped at 32.
- **Loopback by default.** iOS simulators and the web reach `127.0.0.1`; the Android
  emulator reaches it as `10.0.2.2`. A phone on Wi-Fi needs `--host 0.0.0.0`. Traffic is
  plain `ws://`, so only do that on a network you trust.
- **One app at a time.** The newest app to connect is the one driven. The one it replaced
  is told so, and stops redialling until it is reloaded.
- **Apps come and go.** A command sent while no app is connected waits up to
  `REFLEX_APP_WAIT_MS` (default 15 seconds) for one, so a command sent during a reload
  still lands. An app that loses its connection redials, backing off from 0.5 to 5
  seconds. Subscriptions resume from their cursor, so a dropped link repeats and loses
  nothing, while a reload or reset is a new session and arrives as `resync.required`.
  A command in flight when the app drops fails with `SessionClosed`, and may or may not
  have run.
- **Cancellation crosses the bridge.** A caller that goes away, such as an interrupted
  `reflex wait`, sends JSON-RPC's `$/cancelRequest`, so the app stops waiting too. Any
  client may send it; work already started is not undone.
- **Held to the headless limits.** Resets run one at a time, and `sample` and
  `advanceTime` have the same deadline and cap as a headless session.
- **A reset replaces what is on screen**, on another scenario if asked, until the app
  itself next changes `ReflexProvider`'s `scenario` or `host`.

The bridge is `createBridgeController` in `@reflex/rpc`: a `Controller` that forwards to
whichever app is connected, so the CLI, journeys (`createTestAppOn`) and agents need no
changes. The conformance suite runs a third time through it, against the real bridge
daemon and an app in a worker.

### MCP

`reflex mcp` serves the same commands as MCP tools over stdio, for agents whose client
speaks MCP. With Claude Code:

```console
$ claude mcp add reflex -- bun run /path/to/reflex-effect/packages/cli/src/cli.ts mcp
```

| Tool                  | CLI command                                             |
| --------------------- | ------------------------------------------------------- |
| `reflex_status`       | `reflex status`                                         |
| `reflex_inspect`      | `reflex ls --schema`, or one node by `name` or `nodeId` |
| `reflex_tree`         | `reflex tree`                                           |
| `reflex_dispatch`     | `reflex do`                                             |
| `reflex_wait`         | `reflex wait`                                           |
| `reflex_reset`        | `reflex reset`                                          |
| `reflex_sample`       | `reflex sample`                                         |
| `reflex_advance_time` | `reflex advance`                                        |

Each tool runs the CLI command's code (`packages/cli/src/commands.ts`) against the same
session, through the same socket, and returns what the command prints, so there is no
second way to control an app. Every tool takes `target: "headless" | "device"`,
defaulting to the server's own (`reflex --target device mcp`). Sessions are still
started with `reflex start`; a tool with no session to reach says how to start one.

- Each call opens its own connection, so a session can be stopped, started or reset
  between calls. A cancelled call closes its connection, which ends its waits.
- An MCP client given these tools can do whatever the app's actions can, so
  `reflex_dispatch` and `reflex_reset` are marked destructive. The marks are hints for
  the client; the session is the only authority.
- Arguments are all checked before a call reaches the session. A bad one, a refusal
  from the session, or an action that fails is a tool error (`isError`) with the
  session's detail, for the model to act on. An unknown tool or method is a protocol
  error.
- Checked by hand with the official MCP Inspector's CLI (0.17.2), which listed the tools
  and ran a dispatch; `bun run e2e:live` drives the live app through it too.
- Only tools are served. Protocol versions 2024-11-05 to 2025-11-25 are accepted, and
  results carry `structuredContent` from 2025-06-18 on. At most 16 calls run at once.
- Navigation is an action (`Navigate`, `GoBack`) and fixtures are scenarios, so IDEA.md's
  `navigate` and `load_fixture` are `reflex_dispatch` and `reflex_reset`. There is no
  `run_journey`: journeys are tests, run with `bun test`.

### Expo

`apps/mobile` renders the same core through Expo Router, with `@reflex/expo`
providing `useRouteNode`, `useNodeState`, `send` and `RouterProjection`. It has its
own install, and Metro resolves workspace sources directly.

The core owns navigation. Each core push carries its node's handle as a route
param (`reflexNode`), so entries are identified by instance, never by URL: two
entries can share a URL. Mappers work on route files and decoded params, and paths
are never parsed. Decisions live in pure functions in `projection.ts`, and
`ProjectionController` owns the state, behind ports that tests can fake.

| Evidence                                                                                                                                                                                                                                                               | How to rerun                      | What it does not prove                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Journey, virtual time and cancellation pass on a Hermes VM from a Metro bundle                                                                                                                                                                                         | `HERMES=... bun run hermes-smoke` | The VM (GitHub release v0.13.0, which reports itself as 0.12.0) is older than RN 0.88's. Newer syntax is lowered and `TextEncoder`/`TextDecoder` are stubbed |
| Clicks, browser back, deep links, encoded URLs, identical URLs and refused navigation pass through the web export in Chrome                                                                                                                                            | `bun run e2e`                     | Web is not Hermes, and browser back only stands in for native gestures                                                                                       |
| The iOS export compiles to Hermes bytecode                                                                                                                                                                                                                             | `bunx expo export --platform ios` | It has never launched on a simulator or device                                                                                                               |
| The same CLI commands answer identically against the app live in Chrome (under Metro, through the bridge) and a headless session, and the page shows each change; a tap in the page is what the CLI sees next                                                          | `bun run e2e:live`                | Web is not a phone. The bundle checks read an export, not a store build                                                                                      |
| On an Android 16 emulator in Expo Go, CLI commands through the bridge (`10.0.2.2`) moved the app; a tap and a hardware back showed up in the CLI; after the app was killed and relaunched, a running `reflex watch` got `resync.required` and the new session's events | By hand: no script is checked in  | Not a device, and not iOS. Expo Go, not a development build                                                                                                  |
| Hardware back during a pending push, with and without a 2 s JS stall, leaves router and core agreeing on an Android 16 emulator in Expo Go                                                                                                                             | By hand: no script is checked in  | Not a device. Header back, predictive back and iOS swipe-back were not tried, and `adb` cannot time a back inside a few-ms window without a stall            |

App code must navigate through the core, not call `router.replace` or similar: the
projection cannot tell a replace from a push by watching the router.

A push the user undoes before it ever shows leaves the rendered location unchanged. The
projection sees it anyway, through Expo Router's private `actionDispatched` event, which
reports each accepted action with the state it left. On the web the core follows in about
10 ms rather than 500. That event is private, so `expo-router` is pinned to the exact
version `packages/expo/test/router-actions.test.ts` checks, and `src/router-actions.ts`
is the only file that imports it.

Android's hardware back does not undo a pending push. Expo Router runs it ahead of the
queued push, so it pops the screen beneath, or leaves the app from the root, and the
push lands anyway. The projection follows what the router did, so the screen pushed is
recreated in the core.

Size, measured with Expo SDK 58: Metro does not tree-shake, and `Schema` alone
statically imports much of Effect. Reflex and Effect are about 1.1 MB of minified
JS (2.2 MB of bytecode, 260 KB gzipped); `expo export --platform ios` produces a
4.6 MB bytecode bundle for the full app.
Import from `effect/Schema`, not `effect`: the root barrel measured about 50% larger.

Effect constructs `TextDecoder` at module load. Hermes's source enables it through
`contrib` extensions by default at the version RN 0.88 pins, but no native run has
confirmed that.

Import `TestClock` from `effect/testing/TestClock`. The `effect/testing` barrel
imports `node:assert`, which Metro cannot resolve.

Decisions that differ from IDEA.md:

- The wire protocol is hand-written JSON-RPC. IDEA.md suggested
  prototyping Effect RPC first; that comparison was skipped, not disproven.
- Node state uses a plain variable with listeners rather than `SubscriptionRef`,
  because `useSyncExternalStore` needs synchronous reads and notification.
- The Unix socket is user-only (`0600`), which is the only authentication today.
  Windows named pipes are not implemented.
- A background session logs to `session.log.<pid>` in its directory, up to 1 MiB.
  Stdio sessions use the same lifetime byte budget on stderr. Both emit one
  truncation notice and reserve room for a final failure; individual lines are bounded.
- `REFLEX_START_TIMEOUT_MS` (default 10 seconds, maximum 10 minutes) governs the
  whole CLI start, including module loading and controller startup. Foreground
  `serve` and subsequent resets use it for controller startup too. RPC clients
  allow resets the maximum startup budget plus disposal and reply time. Wait names
  and focus selectors are limited to 256 characters before they can be retained.
- `reflex watch` exits non-zero when its session goes away, even a clean stop: it
  cannot tell the two apart.
- Closing a stdio session's stdin ends it once requests in flight are answered, for up
  to 5 seconds, and written out. Losing its stdout ends it at once, and so does a peer
  that lets 32 MiB of replies queue up. Either way the app is disposed.
- If the router has shown no sign of a push after 500 ms, the projection reads the
  router's own state. Showing the new screen, it waits for the report, for about 10 seconds
  more. Not showing it, it takes the router to have dropped the push, and the core pops
  that screen. A deadline that fires over 100 ms late is waited out again instead: it
  means JavaScript was blocked, and the router's queued push has not had a turn.
- `bun run bench` measures a loopback request, logging and encoding a large event, and
  one change to 25,000 rows reaching a subscriber. A long string costs about 0.1 ms per
  MiB each way. Rows cost far more, at about 21 ms a change, nearly all of it walking
  them to redact, encode and check. Rendering an event twice is a small part of that.
- `reflex stop` asks the session over its socket and never signals a process, so
  a hung session must be killed by hand.
