# 0023. Revoke userland state access with its owner

Date: 2026-11-10. Status: accepted.

## Context

The [userland API contract](../design/userland-api.md) requires closed generations to
lose their write capabilities even when asynchronous application work ignores
cancellation. Stopping publication alone leaves a handler able to mutate its old store.
Effect finalizers and escaped work can likewise retain state access after node disposal.
The contract also requires consumer state to be detached and deeply readonly at runtime.

This supersedes the lifecycle and publication guarantees in ADRs 0020–0022 to the extent
that they allowed retained handler access after cancellation or node disposal, or mutable
encoded Effect snapshots. Their other API decisions remain in place until migrated.
This decision establishes the runtime ownership foundation; it does not mark the full
userland API contract implemented.

## Decision

Store handlers receive a revocable facade of their store. Every method lookup and call
checks that its invocation has not been cancelled and its node and runtime remain open.
Extracting a method retains the check. Cancellation marks AbortSignal aborted before
calling abort listeners; disposal marks the node closed before cancelling its work.
Both therefore revoke access before application cleanup runs. Methods retain the
original receiver so class private fields work; the facade also supports frozen stores.
Raw stores independently retained by application code stay application-owned. Reflex
cannot undo arbitrary external effects performed by a Promise that ignores cancellation.

Effect state access checks ownership before reading or invoking a transition, then
rechecks before committing its encoded result. A closed access interrupts rather than
running a transition or publishing a new revision. In particular, cancellation cleanup
that attempts a closed write cannot turn the cancelled operation into a defect. Reading an already published snapshot
remains possible; this grants no write capability.

Both adapters publish through the runtime's shared JSON boundary. It rejects accessors
and non-JSON objects, checks the existing protocol size and depth limits, and detaches
and deeply freezes the result. Effect encoding and secret redaction precede that boundary.
The helper is internal integration plumbing, not an application-author API.

## Evidence and consequences

Store tests cover extracted methods, abort-listener writes, late Promise settlement,
disposal followed by a fresh store, and frozen class stores. Cancellation and disposal
regressions fail with the facade removed. Effect tests cover retained state access after
scope closure and nested unknown JSON values that must be detached and deeply frozen.
Existing protocol behavior and package dependency rules remain unchanged.

Detachment adds a copy to Effect publication. Large snapshots retain their existing
protocol bounds; the implementation must include this cost when measuring the finished
userland API. The root/advanced surface migration, hosts and journeys remain governed
by the settled contract.
