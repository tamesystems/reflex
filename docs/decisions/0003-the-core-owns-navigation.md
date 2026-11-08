# 0003. The core owns navigation; the router is a projection

Status: Accepted

## Context

A headless session has no router, yet journeys and agents must navigate. If Expo Router
owned the stack, headless and live sessions would navigate differently, and every
screen's lifetime would be the router's to decide. Routers also identify entries by URL,
but two entries can share one: the same product opened twice.

## Decision

The `Navigation` node owns the stack, and each entry owns a scope. The router shows the
core's stack: `projection.ts` decides each step as a pure function, and
`ProjectionController` carries it out. Each core push carries its node's handle as the
`reflexNode` route param, so entries are matched by identity. What the router does by
itself (gestures, hardware back, deep links) is fed back to the core as actions.

## Consequences

- Navigation works the same headless and live, and popping a screen cancels its work.
  A screen covered by another keeps its scope and its running work, but loses focus.
- App code must navigate through actions. `router.replace` from a component cannot be told
  apart from a push by watching the router, so it would corrupt the history.
- The projection has to reason about timing: a push the router drops is detected by a
  500 ms deadline, which waits again if JavaScript was blocked rather than the router.
- Where the router does something the core did not ask for, the router's choice stands
  and the core follows. On Android, a hardware back during a pending push pops the
  screen beneath, and the pushed screen is recreated in the core.
