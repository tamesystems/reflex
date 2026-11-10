/**
 * Limits of the example's own HTTP service. They belong to this app, not to Reflex:
 * the protocol's limits (packages/protocol/src/limits.ts) bound what a peer can make
 * Reflex itself hold, while these bound one app's requests to one server.
 */

/** Below the domain's five-second save deadline, so a hung server fails as `ApiError`. */
export const INVENTORY_HTTP_TIMEOUT_MS = 4_000
/** Three products fit in a few hundred bytes; anything this large is not this server. */
export const INVENTORY_HTTP_BODY_BYTES_MAX = 64 * 1024
