# 0004. Node state is a plain value with listeners

Status: Accepted

## Context

Effect offers `SubscriptionRef` for observable state. React's `useSyncExternalStore`
needs a synchronous read of the current value and synchronous notification, and the
runtime needs to read a snapshot while handling a request.

## Decision

Each node holds its state in a plain variable, written only through `StateAccess`
(given to action handlers and `onFocus`, and to owners that use `mountWithAccess`), with a
set of listeners notified on each write. Each new value is encoded and redacted once, when
it is written, and that encoding is what the protocol serves.

## Consequences

- The UI and the protocol read the same state at the same moment, without running an
  Effect: the UI its decoded value, the protocol its encoded, redacted copy.
- State must be treated as immutable. An update that returns the same object is taken as
  no change, so mutating in place would leave the protocol's copy stale, with no event.
- Writes do not compose with Effect's own concurrency primitives.
