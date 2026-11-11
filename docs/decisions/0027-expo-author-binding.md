# 0027: Expo author binding and explicit device scenarios

Status: accepted.

Expo uses the same app descriptor, consumer types and route registry as React. Its
Provider installs the existing Navigation projection when the session has a Navigation
node. Core entries keep their protocol node token; host-owned store screens instead
use Expo's own route key and session route factories. Each screen places its Suspense
boundary locally. Status hooks acquire their lease after commit, so abandoned status
renders cannot start screen work.

URL registration checks share React Router's literal grammar and encoded-param rules.
Expo also checks pathnames against the host Href type, which becomes restrictive when
Expo generates typed routes. Contract Link/href preserve host link props. The shared
route/routeCodec helpers live in React's advanced tier and are re-exported by host
integration entries. Expo has one author root, an Effect-free dev entry and one internal
entry; only router-actions.ts uses private Expo modules.

Metro aliases @inventory-provider to the production or instrumented module. Production
entries import no E2E instrumentation. The instrumented module extends the same mobile
app identity with exported testScenarios. Device HTTP/settings use device-services;
without an explicit development API URL, the production-safe offline layer remains the
default. The live parity journey compares shared scenarios, excluding the device-only
scenario and startup-failure probe. Its headless side starts scenarios.ts, not app.ts.
Plain uses its authored ambient Counter service and no longer defaults to a legacy
screen host. The conformance fixture explicitly opts into that legacy screen adapter.

Local action defects always reach the background reporter. Expected action errors reach
it only when the caller ignores the result. A Promise subclass tracks await/then
consumption; bound views apply that tracking after translating the public outcome.
Journeys continue to receive their outcomes directly.
