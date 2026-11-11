# React Router example

Vite + React 19.2.7 + React Router 8.5.1, with application-owned list/detail routes and a
typed store node per history entry, mounted and retained by the library. No Effect or core Navigation node.

```console
bun install --cwd apps/web --frozen-lockfile
bun run reflex --target device start
# Set VITE_REFLEX_BRIDGE to the printed appSetting, then:
bun run --cwd apps/web dev
bun run reflex --target device ls --schema
bun run reflex --target device do Increment
bun run --cwd apps/web e2e
```

The own install keeps browser tooling out of the workspace lock. The app's app/routes/
views/main modules are the exact compiled spec example: two store screens, contract
links, and a route-derived detail id. Vite aliases the Provider's inert development
bridge seam to the Vite implementation and dedupes React/router. History uses bounded
session-owned leases, so same-URL entries keep separate state. Reset keeps the URL.

The journey checks production module/token exclusion before driving CLI/MCP and
Playwright with a separate daemon. Its separate binding probe also exercises shared
status/Suspense retry, Effect services, granular selectors, stale reset controls,
startup error propagation and StrictMode bridge cleanup.
