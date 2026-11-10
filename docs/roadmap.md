# Roadmap

What the original design called for and is not built yet, in priority order. Each item
says why it matters, where things stand, and what done looks like. When one ships, move
what it decided into an ADR and delete its entry here.

## 1. Native end-to-end coverage

**Why.** A headless session cannot check native gestures, layout, accessibility, animation
or platform integrations. Those need a small set of native tests and visual checks.

**Now.** Browser journeys run in Chrome; the Android emulator has been driven by hand; iOS
has never launched (see [development.md](development.md#what-the-tests-prove)).

**Done when.** Maestro or Detox flows cover a few journeys on an iOS simulator and an
Android emulator in CI, including a back gesture and the live bridge, plus a run on a
physical phone.

## 2. MCP extras

**Why.** Agents with a fixed set of frequent actions may work better with a tool per action,
and running a whole journey from an agent saves many calls.

**Now.** One generic `reflex_dispatch` tool, with schemas discovered through
`reflex_inspect` ([ADR 0009](decisions/0009-mcp-reuses-the-cli.md)). Journeys are `bun test`
files.

**Done when.** The MCP server can optionally generate a tool per action, with its input
schema, and can run a named journey and report its result.

## 3. Core-owned React Router data-mode projection

**Why.** Existing-route focus binding does not provide headless/live navigation equivalence.
A second core-owned router adapter would share the tested @reflex/navigation rules.

**Now.** @reflex/react-router supports existing routes only. ADR 0018 audits 8.5.1:
state/subscribe/numeric navigate exist on the data router but are marked private. It
sketches ports, state/key identity, POP interpretation and loader/redirect handling.

**Done when.** A supported upstream subscription contract or an explicit pinned-private-API
ADR supports an opt-in data-router adapter. Shared projection rules drive list/detail
navigation with identical URLs, back/forward, loaders, redirects, blockers, rapid undone
pushes and reset covered through live CLI/MCP and headless journeys. No existing-route
adopter must change navigation ownership.

## Deliberately deferred

Not planned until the contract has been proved in use, because each widens the design a
lot: time travel and action replay, setting state directly, graph queries over the node
tree, sessions spread across processes, a visual inspector, and sending state as diffs
rather than whole snapshots.
