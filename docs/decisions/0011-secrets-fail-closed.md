# 0011. Secrets are removed before encoding, failing closed

Status: Accepted

## Context

App state can hold secrets, such as an API token in settings. Effect's
`Schema.toCodecJson` encodes `Schema.Redacted` to its plaintext, so publishing state
through its schema would leak it to every client and log.

## Decision

State, typed error data and route params are scanned for secrets and redacted before
encoding. The real value is validated against its schema; a separate publishing codec
encodes the redacted copy without applying the secret's refinements to the placeholder.
Where a secret cannot be safely replaced (behind an accessor, on a prototype, attached to
a binary view, or a `Redacted` that does not hold a string), encoding fails instead.

## Consequences

- A secret reaches no client, event or log through state.
- Some unusual state shapes are refused rather than published.
- Text an app writes into an error `message` is not scrubbed; keep secrets out of it.
