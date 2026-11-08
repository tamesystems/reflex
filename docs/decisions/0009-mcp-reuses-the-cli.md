# 0009. MCP tools reuse the CLI's commands

Status: Accepted

## Context

The original design asked for MCP support that uses "the same underlying session and introspection
system as the CLI" and does not "create a separate application-control API". Agents with
a shell can already run the CLI; MCP is for clients that speak only MCP.

## Decision

Each command is implemented once, in `packages/cli/src/commands.ts`. The CLI prints its
result; `reflex mcp` returns it from a tool of the same meaning. Each tool call opens its
own connection to the target's session. The MCP server is written by hand and serves only
tools, over stdio, with the framing the protocol already uses.

## Consequences

- A tool's answer is the CLI's answer; a test checks they are equal.
- A session can be stopped, started or reset between calls, and a cancelled call closes
  its connection, which ends its waits.
- No MCP SDK dependency, so new MCP protocol versions must be added by hand. It has been
  checked against the official MCP Inspector, not every client.
- There are no resources or prompts, and no `run_journey`: journeys are tests.
