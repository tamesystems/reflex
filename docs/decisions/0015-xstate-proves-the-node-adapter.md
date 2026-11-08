# 0015. XState fits NodeAdapter with explicit event-completion semantics

Status: Accepted

## Context

ADR 0002 claims that the runtime is backend-agnostic. A plain store does not test an
independent actor lifecycle, mailbox, guarded transitions or invoked asynchronous work.
The roadmap required a real XState counter to pass the existing conformance suite without
special cases in the suite or runtime.

## Decision

Use XState 5.33.4 (the registry's current stable release on 2026-11-08), pinned exactly as
one root devDependency. No package depends on it. `test/xstate-counter.ts` implements an
explicit, Effect-free `NodeAdapter` using `setup().createMachine`, `createActor`,
`start`, `getSnapshot`, `send`, `subscribe` and `stop`. The existing `BACKENDS` list runs
all conformance tests, including access policies, against it. Neither `NodeAdapter` nor
any runtime code needed a change.

The adapter exposes only named events. Its hand-written JSON Schemas and validators agree:
`Add` requires exactly one integer `by`; `Reset` and `Load` accept an empty object or
omitted input. Validation happens in `prepare`, before an operation is recorded or an
event sent. XState's event types provide compile-time checking, not wire validation.
Availability comes from `snapshot.can(event)`, including the nonzero guard on `Reset` and
the absence of transitions while loading. `Add` uses a representative valid event because
its transition has no input-dependent guard; a generic adapter could not infer availability
for all possible event payloads this way.

Dispatch launches `actor.send(event)` after the runtime records acceptance. These sends
come from outside the actor's processing loop, so XState processes the transition
synchronously. The invocation resolves `completed` after that send returns. This is event
processing completion, not completion of every descendant actor or effect. Cancellation
is a no-op for this already synchronous unit of work; it cannot undo a transition.

Public state is a deliberate JSON projection `{ count }` from `getSnapshot().context`,
not serialization of the full actor snapshot (which contains functions and actor refs).
Finite state is reflected in action availability. Each actor subscription notification
calls the runtime listener; the runtime owns revisions and event sequencing. Entering
`loading` publishes a notification and advances the revision even though the public
count is unchanged, because availability changed. Start precedes registration, so the
initial emission is not a spurious runtime change. Unregister unsubscribes; session
disposal then stops the actor and its children. Controller reset disposes the old session
and creates a fresh actor and session-scoped node handle.

## Consequences

- The shared suite passes with three unrelated backends, and Effect also served live.
  This supports ADR 0002's boundary without adding a production XState integration.
- `test/xstate.test.ts` holds an invoked promise behind a controlled resolver. Its `Load`
  operation and a wait for protocol idle complete while the machine is still loading.
  Resolving the promise later publishes the new count, after `operation.finished`.
  State waits have deadlines; there are no fixed-time sleeps.
- An invoked actor's eventual failure is likewise not a failure of the completed event
  operation. This machine handles `onError` by returning to ready with the old count.
  An adapter that promises business-work completion must explicitly correlate events
  with outcomes and cancellation through `Invocation.done`/`cancel`, or use
  `runtime.track` for separately owned background work. NodeAdapter cannot infer that
  correlation from an arbitrary actor graph. Protocol idle means no tracked operations,
  not quiescence of the whole actor system.
- Disposal tests verify the child's abort signal, stopped parent status, no subsequent
  actor snapshots or runtime events from late results or sends, and actor replacement
  on controller reset/close. Stopping cancels the actor's participation; arbitrary promise
  code must honor its abort signal to cancel external work. The test deliberately resolves
  a promise that ignores cancellation and verifies its result is discarded.
- A generic actor adapter still needs application choices: public JSON and redaction,
  wire validation, the event allowlist, completion correlation and error reporting.
  This test adapter makes those choices explicitly; it is not a universal adapter.

XState's [actor lifecycle documentation](https://stately.ai/docs/actors) describes the
snapshot, subscription and stop contracts used here.
