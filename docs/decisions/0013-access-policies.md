# 0013. Access policies: observe, an action allowlist, or control

Status: Accepted

## Context

Watching an app and changing it are different powers. An agent diagnosing a bug, a
dashboard or a recorder should be able to watch without acting, and a client that may act
should be limited to what it needs. Every peer could call every method, so the only
choice was all or nothing. XState keeps inspection observational for the same reason.

## Decision

A peer has one of three policies (`packages/protocol/src/access.ts`):

- `control`: everything, as the session's owner has. The default.
- `observe`: describe, inspect, look up operations, wait, sample inputs, subscribe.
- `actions`: observe, and dispatch (or cancel) only the named actions.

Resets, virtual time and shutdown need `control`. One pure check, `requirePermitted`,
judges every request; a method it does not classify is refused, so a new method is closed
until someone decides. A cancel is judged by the action of the operation it names.
Inspections show a forbidden action as unavailable, with the reason, and `describe`
reports the policy, so a peer can tell what it may do without trying.

The check is applied in three places:

- `restrictController` wraps any controller, headless, live or bridged. A connection's
  `access` option (and `serveSocket`'s) uses it, so the session enforces the policy
  before a request reaches it. This is the boundary. A wrapped controller carries its
  policy, so a connection also applies it to what the connection handles itself
  (`session.shutdown`), and wrapping twice holds a peer to both policies.
- `restrictClient` refuses before sending. The CLI's `--access` and `REFLEX_ACCESS` use it.
- The MCP server holds every call's connection to its `--access`, and does not offer
  tools the policy leaves nothing to do.

## Consequences

- A session can serve a peer that cannot change it. The conformance suite checks observing
  and an allowlist against every backend, the live app included; cancellation, shutdown,
  a socket served with a policy, and policies arriving on the wire are tested at the
  connection (`packages/rpc/test/access.test.ts`).
- A policy reported on the wire is held to the same bounds as one made locally.
- The CLI's and MCP server's policies are guards for whoever runs them, not boundaries: a
  process that can open the session's socket can connect without them. Give an agent only
  the MCP server, not a shell, when the policy must hold. The default daemon socket still
  grants control; a session that must serve a restricted peer serves it its own socket
  with `access` set.
- Every new protocol method must be classified in `access.ts`, or restricted peers cannot
  call it.
