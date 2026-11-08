# 0006. Everything a peer can reach is bounded, in one file

Status: Accepted

## Context

A session serves whatever connects to it: agents that loop, scripts that never read
their replies, apps that send huge states. Any unbounded queue, map or wait is a way to
exhaust it, and a limit chosen in passing is hard to find later.

## Decision

Every resource a peer can make a session spend has a named limit in
`packages/protocol/src/limits.ts`: frame size, requests in flight, subscriptions, waits,
retained events and operations, node count, state size, stack depth, unfinished work, and
more. Past one, the request is refused, generally with `ResourceExhausted` (a full
navigation stack is the typed failure `NavigationStackFull`); a reply too large to send
becomes that error; an event that cannot be delivered becomes `resync.required`; a peer
that lets 32 MiB of replies queue up is disconnected.

## Consequences

- The most a session can be asked to do can be read in one place.
- Legitimate large uses hit limits, and the error says which.
- Each new feature has to name its limits; review should ask where they are.
