# Development

How to run, test, debug and change Reflex. Read [ARCHITECTURE.md](ARCHITECTURE.md) first
for where things live and why.

## Environment

| Tool                  | Version         | Needed for                                        |
| --------------------- | --------------- | ------------------------------------------------- |
| Bun                   | 1.4.4           | Everything                                        |
| macOS, Linux, Windows |                 | Unix sockets or authenticated Windows named pipes |
| Windows PowerShell    | 5.1 (built in)  | Windows filesystem ACL creation and checks        |
| Node                  | 24              | Browser journeys (Playwright is not on Bun)       |
| Google Chrome         | any current     | Browser journeys                                  |
| Hermes VM             | release v0.13.0 | `hermes-smoke` (CI downloads it)                  |
| Android SDK, Xcode    | optional        | Trying the app on an emulator or simulator        |

The repository has two installs: the workspace, and `apps/mobile`, which Metro needs to
resolve on its own. Metro compiles workspace sources directly; there is no build step.

```console
$ bun install --frozen-lockfile
$ bun install --frozen-lockfile --cwd apps/mobile
```

## Run

**Headless.** A background session, then commands against it:

```console
$ bun run reflex start examples/inventory/src/app.ts [--scenario slow-network]
$ bun run reflex ls --schema        # focused screen, state, actions and their inputs
$ bun run reflex do OpenProduct '{"productId":"product-123"}'
$ bun run reflex watch              # events as JSON lines
$ bun run reflex stop
```

`reflex serve <module>` runs in the foreground instead, and `--stdio` speaks the protocol
on stdin and stdout. `bun run reflex help` lists every command.

**The app.** From `apps/mobile`: `bunx expo start`, then press `w` for the web, or open it
in Expo Go.

**The app, driven live.** Start a bridge, give the app its setting, and add
`--target device` to any command:

```console
$ bun run reflex --target device start     # prints appSetting and androidEmulatorSetting
$ cd apps/mobile && EXPO_PUBLIC_REFLEX_BRIDGE='ws://127.0.0.1:8790#<token>' bunx expo start
$ bun run reflex --target device ls
```

Metro inlines the variable when it bundles, so restart Metro after changing it. The token
persists in `.reflex/device.token`, so the setting stays valid across bridge restarts.

**An agent over MCP.** `bun run reflex mcp` serves the commands as MCP tools on stdio.
See [packages/cli/README.md](../packages/cli/README.md#mcp).

## Test

| Command                                           | What it runs                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run check`                                   | Biome format and lint, both typechecks, every `bun test` suite. What CI runs first                                                                                                         |
| `bun test path/to/file.test.ts`                   | One suite. `-t "name"` for one test                                                                                                                                                        |
| `bun run --cwd apps/mobile e2e`                   | Exports the web app and runs `e2e/journey.ts` in headless Chrome                                                                                                                           |
| `bun run --cwd apps/mobile e2e:live`              | Runs the app under Metro with a bridge and drives it with CLI and MCP calls, comparing each answer with a headless session's; checks production exports hold no bridge or token. Not in CI |
| `HERMES=… bun run --cwd apps/mobile hermes-smoke` | Runs a journey from a Metro bundle on a Hermes VM                                                                                                                                          |
| `bun run bench`                                   | Wire and encoding costs                                                                                                                                                                    |

The `bun test` suites, by kind:

- **Unit**, beside each package (`packages/*/test`): pure functions and one class at a
  time, with ports faked (timers, the router, sockets).
- **Journeys**, through `@reflex/test`: `createTestApp(host)` drives an app through the real
  protocol, serialized to JSON as a remote peer would see it. `advanceTime` moves virtual
  time; nothing sleeps. `explore(host, { invariant })` walks random available actions with
  schema-generated inputs and shrinks a failure, within a budget of 200 replays. Give it
  `knownInputs` for values a schema cannot know, such as ids that must exist: otherwise
  a walk only ever finds the "not found" path.
- **Process**, in `packages/cli/test`: each command is a real `reflex` process against a
  real daemon.
- **Cross-package**, in `test/`: `conformance.test.ts` runs one suite against an Effect
  app, a plain store, and the Effect app live through the real bridge daemon and a device
  in a worker. `boundaries.test.ts` enforces the dependency rules.

A behavior test may not call `fetch`: the journey SDK replaces it while a test app is open.

### What the tests prove

| Evidence                                                                                                                                                                | How to rerun                      | What it does not prove                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Journey, virtual time and cancellation pass on a Hermes VM from a Metro bundle                                                                                          | `hermes-smoke`                    | The VM (v0.13.0, reporting 0.12.0) is older than RN 0.88's; newer syntax is lowered and `TextEncoder`/`TextDecoder` stubbed |
| Clicks, browser back, deep links, encoded and identical URLs, refused navigation, through the web export in Chrome                                                      | `e2e`                             | Web is not Hermes, and browser back only stands in for native gestures                                                      |
| The same CLI and MCP calls answer alike against the app live in Chrome and a headless session; the page shows each change; a tap reaches the CLI                        | `e2e:live`                        | Web is not a phone. The bundle checks read an export, not a store build                                                     |
| The iOS export compiles to Hermes bytecode                                                                                                                              | `bunx expo export --platform ios` | It has never launched on a simulator or device                                                                              |
| On an Android 16 emulator in Expo Go: CLI commands moved the app, a tap and a hardware back reached the CLI, a relaunch gave a running `reflex watch` `resync.required` | By hand                           | Not a device, not iOS, not a development build                                                                              |
| Hardware back during a pending push, with and without a 2 s JS stall, leaves router and core agreeing on that emulator                                                  | By hand                           | Header back, predictive back and iOS swipe-back were not tried                                                              |
| The MCP server lists its tools and runs a dispatch for the official MCP Inspector CLI (0.17.2)                                                                          | By hand                           | Other MCP clients                                                                                                           |

When you add a test that guards a fix, check it fails without the fix.

## Debug

- **What is the app doing?** `reflex watch` streams every event. `reflex tree` lists every
  node; `reflex ls --schema` shows why an action is unavailable.
- **Why did a start fail?** `reflex start` prints the reason the daemon logged. A running
  daemon logs to `.reflex/session.log.<pid>` (or `device.log.<pid>`), at most 1 MiB.
- **Failures with nobody to answer** are logged as one JSON line each:
  `{"event":"background_failure","message":…}`. A failed `onFocus` lands here.
- **Is the app connected to the bridge?** A `--target device` command with no app waits
  `REFLEX_APP_WAIT_MS` (default 15 s), then says how to connect one. Set it lower to fail
  fast. The app reports its bridge status through `connectBridge`'s `onStatus`.
- **The live journey** prints the page's console with `REFLEX_LIVE_VERBOSE=1`.
- **A hung daemon.** `reflex stop` asks over the socket and never signals a process; kill a
  hung one by the pid in its `.lock` file.

## Common changes

### Add a screen

1. Define its capability in `examples/inventory/src/features/`: a state `Schema`, actions,
   and `onFocus` if it loads. See `inventory-detail.ts`.
2. Add its route and params schema to `navigation.ts`, and mount it in `app.ts`'s `screens`.
3. Add a journey test that reaches it through actions.
4. For the app: add a route file under `apps/mobile/app/`, map it both ways in
   `apps/mobile/src/routes.ts` (`toHref`, `fromLocation`), and render it with
   `useRouteNode`, `useNodeState` and `send`.

Navigate with actions that call `nav.push`; never with `router.push` from a component.

### Add a scenario or a fixture control

A scenario is a name and a `Layer` of services in `defineApp`'s `scenarios`; set
`virtualTime: true` to run it on a `TestClock`. To let tests and agents steer a double,
mount a node with `type: "fixture"` and give it actions, as `fixtures.ts`'s
`FailNextSave` does. Fixture nodes are ambient, so their actions work from any screen.

### Add a CLI command

Implement it once in `packages/cli/src/commands.ts`, parse its arguments in `cli.ts`, and,
if an agent should have it, add a tool in `mcp.ts` whose `prepare` checks every argument
before connecting. Add a process test in `cli.test.ts` and an MCP test in `mcp.test.ts`.

### Add a protocol method

1. Add its params and result to `Methods` in `packages/protocol/src/contracts.ts`, and
   parsers for both in `parsers.ts`.
2. Handle it in **both** controllers: `SessionController` (`runtime/src/controller.ts`)
   and `LiveController` (`expo/src/live-controller.ts`). The bridge forwards it unchanged.
3. If it can take long, give it a reply budget in `replyTimeoutMs` (`rpc/src/client.ts`).
4. Add it to the conformance suite, which then runs it headless and live.

### Add or change a limit

Name it in `packages/protocol/src/limits.ts`, refuse past it with `ResourceExhausted`, and
test both sides of the boundary.

### Change how the router is followed

Decisions are pure functions in `packages/expo/src/projection.ts`; test them there first.
`ProjectionController` owns timing and state behind fakeable ports. Then run `e2e`.

## Keeping the docs true

A change is incomplete if it leaves the documentation describing something else. In the
same change:

- a new or moved module, flow, rule or invariant updates [ARCHITECTURE.md](ARCHITECTURE.md);
- a new architectural rule, or a reversed one, gets an ADR in [decisions/](decisions/)
  (supersede old ones; do not rewrite them);
- a changed command, variable or workflow updates this file or a package README;
- a new term updates [domain.md](domain.md).

## Windows

The same Bun 1.4.4 commands run in PowerShell. Use PowerShell 7.3+ for native argument
passing of JSON; on Windows PowerShell 5.1 use its stop-parsing token for literal JSON:

```powershell
bun run reflex --% do OpenProduct '{"productId":"product-123"}'
$env:REFLEX_DIR = "$PWD\.reflex"
$env:EXPO_PUBLIC_REFLEX_BRIDGE = 'ws://127.0.0.1:8790#<token>'
Set-Location apps/mobile
bunx expo start
# To run the optional VM smoke test:
$env:HERMES = 'C:\tools\hermes.exe'
bun run hermes-smoke
```

Sessions use named pipes, with mutual authentication and encrypted frames, rather than
`.sock` files. REFLEX_DIR and secrets must have Windows ACLs allowing only the current
user, SYSTEM and Administrators; new directories get a private ACL automatically.
Existing shared directories are refused. Use a new directory under a trusted parent
(such as your user profile), or have its owner correct its ACL. `chmod` is not a Windows
security check. See [ADR 0012](decisions/0012-windows-sessions-use-authenticated-pipes.md).
`reflex stop` is the portable graceful shutdown; Windows process termination may leave
stale files, reclaimed after the pid is gone. Ctrl+C is supported for foreground serving.
NDJSON accepts CRLF as well as LF; paths containing spaces are supported.

CI runs `check` on Linux and a real `windows-latest` runner. The browser journey also
runs on Windows with Node and Chrome. Hermes CI stays on Linux: its pinned download is
the Linux VM artifact; a Windows VM supplied through HERMES can run the same harness,
but is not verified by that job. Xcode/iOS simulators require macOS.

## Platform notes

- **Imports for Metro.** Import from `effect/Schema` and the like, not `effect`: the root
  barrel measured about 50% larger, and Metro does not tree-shake. Import `TestClock` from
  `effect/testing/TestClock`; the `effect/testing` barrel imports `node:assert`.
- **Size**, with Expo SDK 58: Reflex and Effect are about 1.1 MB of minified JS (2.2 MB of
  bytecode, 260 KB gzipped); the full app's iOS export is a 4.6 MB bytecode bundle.
- **`TextDecoder`.** Effect constructs one at module load. Hermes enables it through
  `contrib` extensions at the version RN 0.88 pins, but no native run has confirmed it.
- **Encoding cost** (`bun run bench`): a long string costs about 0.1 ms per MiB each way;
  one change to 25,000 rows costs about 21 ms, nearly all of it walking them to redact,
  encode and check.
- **`Struct({})` is not an empty object**: its JSON Schema allows any non-null value. Omit
  `input` for an action that takes none, and use `NoParams` for a route with none.
