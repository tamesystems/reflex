# @reflex/navigation

Framework-free projection of the core Navigation stack through router and core ports.

## Responsibilities

- `projection.ts`: pure synchronization, adoption and entry identity rules.
- `projection-controller.ts`: ordering, inbound/outbound correlation and arrival deadlines.
- `core-port.ts`: `corePortOf(session)` and stable `stackReader(session)` for Navigation.

## Using it

Import `ProjectionController`, `corePortOf`, `stackReader`, pure rules and their types
from `@reflex/navigation`. Supply push/replace/tag/back/shownToken router operations,
a core port, location reports, scheduling and a monotonic clock. Tokens identify entries,
not URLs. The core owns the stack. See `@reflex/expo` for the concrete adapter.

## Important invariants

No React, React Native, Expo, router, Effect or platform imports. Router-specific identity
encoding stays behind the ports. This package does not implement existing-router focus
or own rendering. The controller retains the Expo-proven reconciliation behavior.
See [ADR 0018](../../docs/decisions/0018-router-neutral-projection-and-react-router.md).
