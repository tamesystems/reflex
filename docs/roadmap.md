# Roadmap

What the original design called for and is not built yet, in priority order. Each item
says why it matters, where things stand, and what done looks like. When one ships, move
what it decided into an ADR and delete its entry here.

## 1. Adoption without Effect

**Why.** Most existing Expo apps use Zustand, Redux or plain hooks. They should be able to
expose behavior without rewriting their state in Effect.

**Now.** The runtime accepts any `NodeAdapter`, but the Expo bindings (`useRouteNode`,
`send`) take Effect capabilities, and inputs are validated only with Effect Schema.

**Done when.**

- React bindings work with any node adapter, not only Effect capabilities.
- A Zustand (or Promise-based) adapter exists with an example screen.
- Inputs can be declared with any Standard Schema validator, such as Zod, through an
  adapter, with JSON Schema still published.
- An existing-app guide shows exposing an app incrementally: some screens, no core rewrite.

## 2. Native end-to-end coverage

**Why.** A headless session cannot check native gestures, layout, accessibility, animation
or platform integrations. Those need a small set of native tests and visual checks.

**Now.** Browser journeys run in Chrome; the Android emulator has been driven by hand; iOS
has never launched (see [development.md](development.md#what-the-tests-prove)).

**Done when.** Maestro or Detox flows cover a few journeys on an iOS simulator and an
Android emulator in CI, including a back gesture and the live bridge, plus a run on a
physical phone.

## 3. Real services in the Expo app

**Why.** The architecture's promise is the same logic against real services in the app and
fixtures headless. Every run so far has used fixtures on both sides.

**Now.** `apps/mobile` runs only the fixture scenarios from `examples/inventory`.

**Done when.** The example app has a live scenario backed by a real (local) API and device
storage, while the headless sessions keep using fixtures, and a journey passes against both.

## 4. MCP extras

**Why.** Agents with a fixed set of frequent actions may work better with a tool per action,
and running a whole journey from an agent saves many calls.

**Now.** One generic `reflex_dispatch` tool, with schemas discovered through
`reflex_inspect` ([ADR 0009](decisions/0009-mcp-reuses-the-cli.md)). Journeys are `bun test`
files.

**Done when.** The MCP server can optionally generate a tool per action, with its input
schema, and can run a named journey and report its result.

## Deliberately deferred

Not planned until the contract has been proved in use, because each widens the design a
lot: time travel and action replay, setting state directly, graph queries over the node
tree, sessions spread across processes, a visual inspector, and sending state as diffs
rather than whole snapshots.
