# 0026 — Additive React host bindings

Status: accepted for the B1 migration; implementation remains partial as recorded below.

## Decision

Add the app-bound React API alongside the round-3 exports needed by Expo. Bound
screen hooks suspend by default; status hooks are explicit. An indexed definition
table serves ordinary hooks, and `from(Definition)` captures one implementation for
flat repeated-hook checking. Runtime membership checks exact authored constructors.
Effect implementations preserve the declared constructor name for legacy adapters
in minified bundles and publish the original constructor through consumer metadata.
Scenario extensions retain their original app descriptor identity.

A session owns one route registry across status hooks, Suspense and host preparation.
The Provider decorates session disposal to drain it before starting replacement
routes, rather than tying provisional resources to a component effect. History is
bounded, forward entries are released, and retries replace failed promises. The
protocol owns the build deadline; abort-aware Effect mounts close their scope, while
late results from abort-ignoring factories are disposed.

The host-neutral development bridge entry is inert. Vite aliases it to the existing
Vite development entry, allowing production tree-shaking to exclude both the bridge
and token. The Provider owns the bridge effect. React Router supplies location and
params, wraps each registered view, and continues to own navigation.

## Evidence and outstanding acceptance

The real-package harness includes the exact web examples and app-bound negative
cases. The web journey includes CLI/MCP, history, reset, production exclusion, shared
status/Suspense retry, Effect session services, granular selectors, stale controls,
startup errors and StrictMode bridge cleanup. Runtime tests exercise registry bounds,
late disposal, deadlines, conflicting params and ordered UI resets.

Mobile files and Expo remain unchanged. Mobile `e2e` and `e2e:plain` pass. The unchanged
`e2e:live` headless comparison starts the production-only inventory app instead of
scenarios.ts; the production mobile Provider also lacks fixture scenarios used by
`e2e:services`. These acceptance failures are recorded in the B1 report and must be
resolved with the mobile test wiring in B2. This is not full B1 acceptance.

The B1 report also records unfinished commit-time status acquisition, observed/ignored
action-failure reporting, and the advanced routeCodec escape hatch. Root/web green
does not establish full spec parity.

Core-owned React Router projection has not shipped, so its roadmap entry remains.
