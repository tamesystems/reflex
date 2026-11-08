# 0002. The runtime is free of Effect; Effect is one way to build nodes

Status: Accepted

## Context

Effect v4 gives schemas, structured concurrency and virtual time, which suit app cores
well. But a control protocol tied to one state library would not fit apps built on
reducers, Zustand or XState, and the original design research argued the runtime should be smaller
than the protocol.

## Decision

`@reflex/runtime` knows only `NodeAdapter`: snapshot, actions, prepare, subscribe. It
imports nothing but the protocol. `@reflex/effect` is one adapter, built on capabilities.
`test/conformance.test.ts` runs one suite against an Effect app and a plain store, and
`test/boundaries.test.ts` keeps Effect out of everything below `@reflex/effect`.

## Consequences

- An app can adopt the protocol without adopting Effect.
- The CLI, the test SDK and the RPC layer carry no Effect.
- The Expo bindings are Effect-specific: `useRouteNode` and `send` take Effect capabilities.
  A plain store needs bindings of its own.
