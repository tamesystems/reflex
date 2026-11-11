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

The repository has three installs: the workspace, `apps/mobile` for Metro, and
`apps/web` for Vite/React Router. Browser tooling stays in each app’s own lockfile. Metro compiles workspace sources directly; there is no build step.

```console
$ bun install --frozen-lockfile
$ bun install --frozen-lockfile --cwd apps/mobile
$ bun install --frozen-lockfile --cwd apps/web
```

## Run

**Headless.** A background session, then commands against it:

```console
$ bun run reflex start examples/inventory/src/scenarios.ts [--scenario slow-network]
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

**Real inventory services.** Run `bun examples/inventory/server.ts` in another terminal
(default http://127.0.0.1:8791), then set EXPO_PUBLIC_INVENTORY_API to that URL before
starting Expo. This development setting adds and selects `device-services`; absent it,
offline inventory and in-memory settings remain the default. For Android emulators use http://10.0.2.2:8791 and start the
API with INVENTORY_HOST=0.0.0.0. Metro must restart after variable changes. The API prints
its bound URL; INVENTORY_PORT=0 chooses a port safely. On PowerShell set the variables
with `$env:NAME = 'value'`. See [mobile setup](../apps/mobile/README.md).

`reflex --target device reset` retains the scenario and re-reads server inventory and
AsyncStorage settings. It never seeds or clears them. POST /reset on the API explicitly
reseeds inventory; POST /fail-next-save makes one valid save return JSON 503. The server
is unauthenticated, in-memory local development tooling. Headless scenarios still use
fixtures and reject unexpected network requests.

**An agent over MCP.** `bun run reflex mcp` serves the commands as MCP tools on stdio.
See [packages/cli/README.md](../packages/cli/README.md#mcp).

## Test

| Command                                           | What it runs                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                                   | Biome format and lint, the real-package inventory design check, all three typechecks, every `bun test` suite. What CI runs first                                                                    |
| `bun test path/to/file.test.ts`                   | One suite. `-t "name"` for one test                                                                                                                                                                 |
| `bun run --cwd apps/mobile e2e`                   | Exports the web app and runs `e2e/journey.ts` in headless Chrome                                                                                                                                    |
| `bun run --cwd apps/mobile e2e:plain`             | Isolated plain Zustand/Zod Expo screen driven by CLI/MCP, Metro module graph proves no Effect; runs on Linux and Windows                                                                            |
| `bun run --cwd apps/mobile e2e:live`              | Runs the app under Metro with a bridge and drives it with CLI and MCP calls, comparing each answer with a headless session's; checks production exports hold no bridge or token. Runs in Windows CI |
| `bun run --cwd apps/mobile e2e:services`          | Shared headless/live behavior definition against HTTP and AsyncStorage on Chrome; server and settings survive reset/reload; runs on Ubuntu and Windows                                              |
| `HERMES=… bun run --cwd apps/mobile hermes-smoke` | Runs a journey from a Metro bundle on a Hermes VM                                                                                                                                                   |
| `bun run bench`                                   | Wire and encoding costs                                                                                                                                                                             |

The `bun test` suites, by kind:

- **Unit**, beside each package (`packages/*/test`): pure functions and one class at a
  time, with ports faked (timers, the router, sockets).
- **Journeys**, through `@reflex/test`: `createTestApp(app)` drives an app through the real
  protocol, serialized to JSON as a remote peer would see it. `advanceTime` moves virtual
  time; nothing sleeps. `explore(host, { invariants })` walks random available actions with
  schema-generated inputs and shrinks a failure, within a budget of 200 replays. Give it
  `inputs: { Node: { Action: [input] } }` for values a schema cannot know, such as ids that must exist: otherwise
  a walk only ever finds the "not found" path.
- **Process**, in `packages/cli/test`: each command is a real `reflex` process against a
  real daemon.
- **Cross-package**, in `test/`: `conformance.test.ts` runs one suite against an Effect
  app, a plain store, an XState actor, and the Effect and Zustand apps live through the real bridge daemon
  and a device in a worker. The same tests include access policies for every backend.
  `xstate.test.ts` checks invoked async work, event completion, validation and actor disposal
  on close/reset, with controlled promises and deadline-bounded state waits (ADR 0015).
  `boundaries.test.ts` enforces the dependency rules.

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

For incremental adoption with an existing store/router, see [adopting.md](adopting.md).
The plain Expo fixture shares the mobile install: `cd apps/mobile/plain && bunx expo start`.
Its exact Zustand/Zod dev dependencies are installed in apps/mobile; no third install.

### Add a screen

1. Define state, params and `initial(params)` with `Screen` in a contract module.
2. Build navigation from contracts. Attach handlers with `.implement`, and compose implementations with `Nav.implement([definitions], { initial })` in `defineApp`.
3. Add a typed journey using `session.focused(Capability, match)` and `node.actions`.
4. Register every file path and param-name mapping with `createReflexExpo(app, registration)` and render with `useScreen`.
5. Use the composed `useScreen` view for state and action controls; granular hooks remain available.

Navigate with `Nav.push`/`Nav.back` Effects from handlers. See [adopting.md](adopting.md).

### Add a scenario or a fixture control

A scenario is a name and a `Layer` of services in `defineApp`'s `scenarios`; set
`virtualTime: true` to run it on a `TestClock`. To let tests and agents steer a double,
declare controls with `defineFixture`, list them in `defineApp({ fixtures })`, and give them actions, as `fixtures.ts`'s
`FailNextSave` does. Fixture nodes are ambient, so their actions work from any screen.

### Add a CLI command

Implement it once in `packages/cli/src/commands.ts`, parse its arguments in `cli.ts`, and,
if an agent should have it, add a tool in `mcp.ts` whose `prepare` checks every argument
before connecting. Add a process test in `cli.test.ts` and an MCP test in `mcp.test.ts`.

### Add a protocol method

1. Add its params and result to `Methods` in `packages/protocol/src/contracts.ts`, and
   parsers for both in `parsers.ts`.
2. Handle it in **both** controllers: `SessionController` (`runtime/src/controller.ts`)
   and `LiveController` (`live/src/live-controller.ts`). The bridge forwards it unchanged.
3. If it can take long, give it a reply budget in `replyTimeoutMs` (`rpc/src/client.ts`).
4. Classify it in `packages/protocol/src/access.ts`, as observing or controlling, or
   restricted peers will be refused it.
5. Add it to the conformance suite, which then runs it headless and live.

### Add or change a limit

Name it in `packages/protocol/src/limits.ts`, refuse past it with `ResourceExhausted`, and
test both sides of the boundary.

### Change how the router is followed

Decisions are pure functions in `packages/navigation/src/projection.ts`; test them there first.
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
bun --% run reflex do OpenProduct "{\"productId\":\"product-123\"}"
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
ACL checks use .NET directly, avoiding module-path conflicts when launched from
PowerShell 7. Windows frames carry unpredictable proof-of-read receipts that bound
native write queues even when Bun reports a queued native write as completed. Slow-peer
tests stop a separate process's JavaScript thread, so it cannot return receipts.
NDJSON accepts CRLF as well as LF; paths containing spaces are supported. Git checkouts
use LF through `.gitattributes`, so formatting checks also pass with `core.autocrlf`.

CI runs `check` on Linux and a real `windows-latest` runner. The browser journey also
runs on Windows with Node and Chrome, including `e2e:live` (CLI/MCP against the live app).
Hermes CI also runs on both systems, using the release v0.13.0 VM archive for each
platform with its SHA-256 pinned. Xcode/iOS simulators require macOS.

Windows skips only POSIX socket-mode/chmod assertions, an unauthenticated Unix silent
socket fixture, and the two `mkfifo` fixtures (Windows has no POSIX FIFOs). Windows ACL,
authenticated stalled-reader, stdio write-budget/logging and bridge tests run there.
Native IPC rejection tests await/catch before `toMatchObject`: Bun 1.4.4's async matcher
can stall Windows pipe progress while waiting for the rejection.

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

### Framework-free live consumer

`examples/live-counter/src/serve.ts` runs with `REFLEX_BRIDGE` set to the bridge's printed
appSetting. It uses only `@reflex/runtime` and `@reflex/live`, a service node with no focus,
and the process's global WebSocket (Bun, or Node 22+ with TypeScript execution support).
`test/framework-free.test.ts` starts the daemon and app as separate processes and drives
inspect (`tree` and `ls --schema`), dispatch, wait and reset through real CLI invocations.
It runs as part of `bun run check`, hence on both Ubuntu and Windows CI.
The generic React entry also has a browser bundle test refusing Expo, React Native,
Effect and the bridge. Run the mobile `e2e`, `e2e:plain`, and `e2e:live` after changing
these bindings; the latter checks production bridge/token exclusion.

### React Router browser fixture

From apps/web run `bun run dev`, with VITE_REFLEX_BRIDGE set to the bridge’s appSetting.
`bun run --cwd apps/web e2e` builds production with a real setting and rejects both token
and bridge dialler in output JS, then drives development through Playwright, CLI and MCP.
It covers list/detail focus, same-URL entries, back/refusal, forward and reset. The daemon
runs out of process. This journey runs in the Ubuntu and Windows browser CI jobs. Root
`bun run check` typechecks the web fixture and React Router hook; no Vite build runs there.

## Userland API checks

Judge changes against [api-principles.md](api-principles.md). `test/userland.types.ts`,
`packages/live/test/typed-actions.types.ts` and `apps/mobile/test/api.types.ts` are typechecked
negative/positive inference tests, not executable journeys. Keep expected errors on the
actual invalid call. Record root diagnostics before and after with
`bunx tsc --noEmit -p tsconfig.json --extendedDiagnostics`; all three typechecks still run
in `bun run check`. Integration plumbing belongs under explicit internal subpaths.

### Userland API validation

The consolidated design and deviations are in [ADR 0020](decisions/0020-userland-api.md).
`bun run check` includes real-package compilation of the extracted examples, negative
inference cases, complete documentation snippets, root/mobile/web typechecks and tests.
Intentionally partial snippets use `ts partial: reason` or `tsx partial: reason`.

`bun docs/design/prototypes/check.ts --real` also compares the exact type and value
export-name sets for all 16 specified runtime, live, test, Effect, React, React Router
and Expo root/advanced/dev entries against the declarations. Internal entries serve
sibling integration and deliberately malformed host fixtures. The store author entry
accepts only screen/service arrays and withStore overrides; conformance tests drive the
wire client directly. Run
`bun docs/design/prototypes/check.ts` for the declaration examples, diagnostic locations
and reference performance gates. Run `bun docs/design/prototypes/check.ts --real --performance`
for the real-package gates. Measurements print to stdout; no generated reports are tracked.

`scripts/type-budget.ts` gates root instantiations at 505,132: the unchanged 459,211
baseline in `performance/type-budget.json` plus 10%, rounded down. Inspect graph growth
before changing this budget. Timing and memory depend on the machine; instantiation
counts remain the stable acceptance gate. `bunx tsc --noEmit -p tsconfig.json --extendedDiagnostics`
prints the root measurements directly.

The pre-cleanup B2 benchmark on Bun 1.4.4 / TypeScript 5.9.3 measured 1.05/1.72/3.29 s
check time for 100/200/400 heterogeneous screens with one hook (561,961 / 1,189,761 /
2,865,361 instantiations). Incremental slopes were 6.70/7.85 ms per screen, under the
25 ms gate. Additional narrowed hooks cost at most 0.050 ms, under the 5 ms gate.
Root B2 diagnostics were 460,241 instantiations, 533,064 K memory, 1.66 s check and
2.51 s total. These are historical local measurements; rerun the commands above for
current results.

Pass `developmentBridge` from `@reflex/live/vite` or `@reflex/expo/dev` directly as
the Provider's `bridge` value. Neither example needs a development bridge alias. Normal production imports exclude E2E modules.
Run mobile e2e, e2e:plain, e2e:live, e2e:services and web e2e after binding changes.
These cover production bridge/token/instrumentation exclusion and the plain Metro
graph's Effect exclusion as well as browser behavior. All three frozen installs are
required before checking a checkout.

Current local root diagnostics after the review fix-up: 504,864 instantiations under the
unchanged 505,132 ceiling. All 97 real-package negatives assert diagnostic locations and
message fragments, and extracted examples are diffed against the real app files.
The scale mode gates at 12,000 instantiations per added screen and 2,000 per extra narrowed
hook; timings are informational. It currently fails the screen gate (43,517.9). Two-way
reference declaration type parity also remains unfinished; the ordinary check currently
compares export names. See ADR 0020 for this explicitly incomplete part of review item 11.
