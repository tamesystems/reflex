# 0001. The wire is hand-written JSON-RPC over NDJSON

Status: Accepted

## Context

The original design suggested prototyping the wire with Effect RPC, whose v4 serializer
speaks JSON-RPC 2.0 over NDJSON, though its APIs were marked unstable. But the clients
that matter most, the CLI, the test SDK, agents and tools in other languages, should
need neither Effect nor this codebase to talk to a session. The protocol also had to bound every frame,
batch and reply itself, which a framework would hide.

## Decision

The wire is JSON-RPC 2.0, one message per line, over a Unix socket, stdio, a loopback pair
or a WebSocket. Contracts and parsers live in `@reflex/protocol`; the connection and client
in `@reflex/rpc` are written by hand.

## Consequences

- Any JSON-RPC peer can drive a session; `packages/rpc/test/wire.test.ts` does so with raw
  JSON over a socket, and the MCP server reuses the same framing. On Windows, a peer must
  first complete the pipe's authentication handshake and frame its messages as
  [ADR 0012](0012-windows-sessions-use-authenticated-pipes.md) describes.
- Every parser, limit and batch rule is ours to maintain and test.
- The comparison with Effect RPC was skipped, not run. It could still win.
