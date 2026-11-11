import type { ConsumerDefinition, InferState as ConsumerState } from "@reflex/runtime/internal"
import type { Public } from "./author-model.ts"

/** Definitions publish encoded state; contracts retain the same encoded state type. */
export type InferState<D> = D extends ConsumerDefinition
  ? ConsumerState<D>
  : D extends { readonly state: { readonly Encoded: infer S } }
    ? Public<S>
    : never
export type { InferActions, InferInput, InferError } from "@reflex/runtime/internal"
