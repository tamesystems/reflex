# React Router example

Vite + React 19.2.7 + React Router 8.5.1, with application-owned list/detail routes and a
plain mountStore node per history entry. No Effect or core Navigation node.

```console
bun install --cwd apps/web --frozen-lockfile
bun run reflex --target device start
# Set VITE_REFLEX_BRIDGE to the printed appSetting, then:
bun run --cwd apps/web dev
bun run reflex --target device ls --schema
bun run reflex --target device do Increment
bun run --cwd apps/web e2e
```

The own install keeps browser tooling out of the workspace lock. Vite aliases workspace
sources and dedupes React/router. Entry state is retained until session disposal to support
forward. Detail elements remain mounted across same-URL pushes to exercise focus gating; reset replaces all nodes and keeps the current URL. Production never loads the
bridge or reads the setting. e2e verifies that with a real token supplied, then runs the
live CLI/MCP/Playwright journey using Chrome and Node 24+, with a separate daemon process.
