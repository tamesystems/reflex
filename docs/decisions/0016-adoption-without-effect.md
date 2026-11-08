# 0016. Existing stores expose behavior through a public projection

Status: Accepted

## Context

ADR 0002 leaves the runtime open to other state containers, but hand-written adapters
repeat validation, public-state bounds, operation correlation and lifecycle work. The
Expo root's runtime import of Effect also makes a plain app bundle Effect under Metro.
Existing routers cannot adopt ADR 0003's projection incrementally without changing who
owns their stack. ADR 0015 demonstrates why event acceptance is insufficient evidence
that asynchronous business work finished.

## Decision

Add `mountStore`, `standardInput`, structural Store/StandardValidator types, and
`StoreFailure` to the framework-free runtime. This is a NodeAdapter helper, not another
state container or a Zustand-specific package. Zustand/Redux stores satisfy the small
getState/subscribe contract; app code retains writes. Real Zustand 5.1.0 and Zod 4.6.7
are exact example/test dev dependencies only, including the mobile fixture's install.

Every mount requires an explicit public JSON projection. Copy and freeze it, reject
non-JSON/accessors and enforce the protocol's state depth and escaped-character limits
before retaining it. Only changed projected JSON emits a state notification. Availability
reads the current store; the projection must include its dependencies to give availability
changes revisions. External invalid writes cannot be rolled back; throw and retain the
last valid public snapshot. There is no automatic Effect Redacted scan on this path.
Error messages and declared tags must also be safe for publication.

Standard Schema supplies validation, not JSON Schema. Accept an explicit input schema,
including converter output, and reject async validation before acceptance because
NodeAdapter.prepare is synchronous. Observe any returned rejected Promise. Do not widen
the runtime dispatch contract or run validators as operations. Test the example's
published input schema against the real validator with valid and invalid inputs.

Handlers receive an AbortSignal. Their returned Promise is the unit of work: completion
means that Promise succeeded, not that unreturned work finished. Synchronous throws and
Promise rejections become failed operations; StoreFailure is declared, other errors are
defects. Cancellation settles cancelled and aborts the signal. Disposal unregisters,
unsubscribes and cancels owned work. Cancellation cannot stop arbitrary JavaScript or
undo external writes; application handlers must cooperate. No automatic error-data
serialization, generators, virtual time or structured concurrency is promised.

The Expo default entry imports no Effect. `useNode` adapts any registered handle to public
JSON/subscription/send, regardless of its optional live object; useNodeState and send are
structural. Generic useRouteNode takes a resolver. Capability identity lookup moves to
`@reflex/expo/effect`, and the inventory app changes imports. No wire/controller/CLI/MCP
change is needed. NodeAdapter itself remains unchanged.

Existing routers report focus through `useNodeFocus(id, isFocused)`. Cleanup cannot clear
a newer screen's focus. Services remain ambient; screens refuse new actions when blurred.
Applications dispose popped nodes to cancel work. RouterProjection still requires
Navigation's core stack, normally created by defineNavigation; it is not an adapter for
an arbitrary router. Incremental exposure does not promise headless navigation equivalence
until the application supplies that behavior.

## Consequences and evidence

- A real Zustand/Zod core and separate Expo entry under apps/mobile/plain share the
  mobile install, avoiding a third lockfile. The isolated entry imports no inventory code.
- BACKENDS runs shared conformance/policy tests against this helper headless and over the
  bridge. A browser journey uses real CLI and MCP calls against the plain screen.
- e2e:plain exports through Metro with source maps and checks the complete module graph:
  the helper and Zod must occur, Effect must not. It also verifies bridge/token exclusion
  in production. This journey runs in both Linux and Windows browser CI jobs.
- Focus, adapter-independent subscriptions, projection safety and unchanged-state events,
  input/schema agreement, async-validator refusal, true Promise completion, cooperative
  cancellation, failure classification and unsubscribe/disposal have deterministic tests.
- [Adopting](../adopting.md) explains incremental exposure and the guarantees that differ.
