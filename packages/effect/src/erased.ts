/**
 * The one sanctioned `any`, for variance erasure at Effect's generics. Containers
 * of heterogeneous actions and schemas cannot state a type for each member, and
 * each member is checked against its own types where it is written.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above.
export type Erased = any
