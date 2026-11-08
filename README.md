# Reflex

Reflex makes an application's behavior inspectable and executable without its UI. An
app exposes a graph of stateful nodes; a client (the `reflex` CLI, a test, or a coding
agent over MCP) reads their state, discovers their typed actions, runs them, and
watches what changes. The same commands work against the app running headless or live
on a device.

It is inspired by Shopify's Reflex, as described in
[their engineering post](https://shopify.engineering/reflex). This is an independent
project, not affiliated with or endorsed by Shopify.

## Why it exists

Agents and tests usually learn what an app does from screenshots and source code, and
drive it through a simulator. Both are slow and lossy. If behavior lives in a headless
core with an explicit control surface, an agent can run most checks with no UI at all,
then confirm selected behavior against the real app through the same commands. Reflex is
that control surface for Expo apps, with adapters for existing stores and [Effect](https://effect.website) v4.

## System at a glance

```text
 reflex CLI ─┐                          ┌─► headless session ──► app core (store/Effect)
 MCP client ─┼─► session socket ─► CLI ─┤
 journeys ───┘   (JSON-RPC)    daemon   └─► device bridge ──WebSocket──► app on a device
                                                                         (Expo, same core)
```

- **Protocol and runtime**: JSON contracts, a registry of nodes, operations and events,
  and `mountStore` for existing stores with Standard Schema inputs.
- **Effect integration**: `defineCapability`, `defineNavigation`, `defineApp`.
- **CLI**: background sessions, the device bridge and the MCP server.
- **Expo binding**: React hooks, and Expo Router as a projection of the core's navigation.

## What it looks like

Behavior is declared once; validation, JSON Schema, availability and input generators
derive from it. From `examples/inventory/src/features/inventory-detail.ts`:

```ts
SetQuantity: action({
  description: "Set the quantity directly",
  input: Schema.Struct({ quantity: Quantity }),
  available: whenEditing, // true, or why not: "Product is loading"
  handler: ({ quantity }, state) => edit(state, (s) => ({ ...s, quantity })),
}),
```

A journey drives the app through the real protocol, on virtual time. From
`examples/inventory/test/journey.test.ts`:

```ts
const session = await pool.open(app, { scenario: "slow-network" })
await session.do("OpenProduct", { productId: "product-123" })
const operation = await session.start("Save")
await session.advanceTime(5_000) // returns at once: the clock is virtual
await session.waitFor({ operationId: operation.operationId })
expect(session.state).toMatchObject({ _tag: "editing", error: "Save timed out" })
```

## Start here

- [Architecture](docs/ARCHITECTURE.md): the map, the runtime flows and the rules. Read this first.
- [Adopting in an existing app](docs/adopting.md): Zustand, Standard Schema and selected screens without Effect.
- [Development](docs/development.md): set up, run, test, debug and make common changes.
- [Domain](docs/domain.md): what nodes, operations, sessions, cursors and the rest mean.
- [Decisions](docs/decisions/): why it is built this way.
- [Roadmap](docs/roadmap.md): what is not built yet.
- [Security](SECURITY.md): the trust model.

## Quick start

You need [Bun](https://bun.sh) 1.4.4 on macOS, Linux or Windows. See the
[PowerShell notes](docs/development.md#windows) for JSON arguments and environment variables.

```console
$ bun install --frozen-lockfile
$ bun install --frozen-lockfile --cwd apps/mobile
$ bun run check
$ bun run reflex start examples/inventory/src/app.ts
$ bun run reflex do OpenProduct '{"productId":"product-123"}'
$ bun run reflex ls
$ bun run reflex stop
```

This is an experimental workspace to clone, not a set of published npm packages: every
package is private, at version 0.0.0, and exports its TypeScript sources directly.

## Status

The original design's milestones are built: the headless core, introspection and the
CLI, navigation and journey tests, the live Expo bridge, and the MCP adapter. Evidence and
its limits are in [Development](docs/development.md#what-the-tests-prove); what is still
to do is in the [roadmap](docs/roadmap.md). It has not
run on iOS or on a physical phone.

## License

[MIT](LICENSE)
