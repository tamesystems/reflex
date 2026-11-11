# 0028: App-typed journeys over the shared protocol

Status: accepted.

`@reflex/test` accepts author descriptors alongside legacy AppHosts. An author client
resolves screen contracts to their registered implementation, checks service membership,
and exposes only fixtures common to every possible selected scenario. Scenario names,
action arguments, route params and state matches come from those definitions. Array
inclusion takes its element type from the expected state. Reads re-establish the keys
and discriminant used to narrow a handle.

Each node has one actions map. Calling an action or `expectCompleted` asserts success;
`run`, `expectError`, `expectRefusal` and `start` expose deliberate alternatives. Operation
handles can cancel, assert cancellation, or allow it explicitly when awaiting completion.
Headless and remote sessions implement async disposal. Pools register ownership for a
runner's cleanup hook. Reset returns a new scenario client and revokes the previous
client while its original disposer still owns the session. Legacy maps and raw helpers
remain during migration.

`connectJourney` uses RPC's authenticated target connector, shared with the CLI's
endpoint and Windows secret handling. It closes its connection, never the remote app.
Headless and live descriptions carry a structural descriptor fingerprint. Fingerprints
include registered screen/service names, available declaration schemas and action names;
they exclude scenarios, fixture instrumentation, handlers and service implementations.
Store projections do not supply a public state/error schema: projected errors are marked
opaque rather than trying to serialize their decoded validator. Fingerprints detect
structural drift; they are not a security credential or a proof of behavioral equivalence.

`app.open` mounts a host-owned screen through its active session's route factory, validates
its params and sets focus. Both controllers implement it. It requires control access,
uses decoded params for bidirectional Effect codecs and encoded input params for store
validators. Standard Schema supplies no general inverse for a one-way transform. This
minimal deviation keeps store route params validated across the protocol. Opening uses
the existing name/JSON/node/control-work budgets, and disposes late routes after
cancellation or a closed session. Control deadlines now abort their work signal.

The ordinary raw seam shares the journey's serialized protocol connection and recorded
events. The advanced entry supplies standalone protocol test sessions and custom request
transports. Exploration accepts keyed inputs and state invariants, checks ambient nodes
as well as focus, and supports the compiled examples' async journey invariant. Existing
summaries, seeds and shrinking remain available.

Duration inputs are structurally compatible with Effect's Duration.Input, with a small
platform-free conversion at the test boundary. Test consumers need no Effect runtime.
The wire still enforces finite, nonnegative, bounded integer milliseconds.

Inventory's shared story requires only focused/back capabilities and runs against fixtures
and mobile HTTP/storage services. Protocol and HTTP tests live at root. The real-package
harness compiles the inventory test/story, reset and capability test examples and the
ported test API negative cases. Legacy conformance backends remain supported.
