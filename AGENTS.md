# Agents

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: the code map, the runtime flows,
the dependency rules and the invariants. [docs/development.md](docs/development.md) has
the commands and the common changes; [docs/domain.md](docs/domain.md) the vocabulary.

- Run `bun run check` before saying a change works. It formats, lints, typechecks and tests.
- `test/boundaries.test.ts` enforces which package may import which. Do not work around it.
- Every limit a peer can reach belongs in `packages/protocol/src/limits.ts`.
- A protocol method is handled in both `SessionController` and `LiveController`.
- A CLI command is implemented once, in `packages/cli/src/commands.ts`, for the CLI and MCP.
- Update the docs in the same change as the code they describe (see development.md,
  "Keeping the docs true"). When you build a roadmap item, record its decisions in an ADR
  and remove it from docs/roadmap.md.

To drive the example app yourself: `bun run reflex start examples/inventory/src/app.ts`,
then `bun run reflex ls --schema` and `bun run reflex do <action> '<json>'`, or use
`bun run reflex mcp` as an MCP server.
