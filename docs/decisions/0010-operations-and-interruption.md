# 0010. Operations are accepted, then finish; back acts as return

Status: Accepted

## Context

Actions do real work: saves that take seconds, loads on focus, navigation. A client must
be able to start one, see that it started, and learn how it ended, including when the
user leaves the screen meanwhile. A handler that pops its own screen would otherwise
close the scope it is running in and wait on itself forever.

## Decision

Dispatch answers once the operation is recorded: accepted, not completed. Its end is an
`operation.finished` event, a wait on its id, or `await: true`. Handlers run in their
screen's scope, synchronously until they first suspend. Navigation runs on the
navigator's own fiber, so `nav.back` from a handler interrupts that handler, like a
`return`, and its operation reports `cancelled` even if its work finished.

## Consequences

- Clients must wait to see outcomes; `reflex do` and the journey SDK do it for them.
- To block a second dispatch through `available`, a handler must update state before it
  first suspends.
- Tests of an action that navigates back should assert on state, not on `completed`.
