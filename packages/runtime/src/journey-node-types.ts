import type { NodeId, OperationId } from "@reflex/protocol"
import type { InferState, InferActions } from "./node-handle.ts"
export const inclusion = Symbol("reflex/includes")
export interface Includes<M> {
  readonly [inclusion]: readonly M[]
}
export type CheckedActions<A, Status extends string> = {
  readonly [K in keyof A]: A[K] extends (...args: infer Args) => Promise<infer Outcome>
    ? (...args: Args) => Promise<Extract<Outcome, { readonly status: Status }>>
    : never
}
export type StateMatch<S> = S extends readonly (infer Item)[]
  ?
      | (number extends S["length"]
          ? readonly StateMatch<Item>[]
          : { readonly [K in keyof S]: StateMatch<S[K]> })
      | Includes<StateMatch<Item>>
  : S extends object
    ? { readonly [K in keyof S]?: StateMatch<S[K]> }
    : S
export type MatchedState<S, M> = S extends unknown
  ? keyof M extends keyof S
    ? M extends { readonly _tag: infer Tag }
      ? S extends { readonly _tag: Tag }
        ? S
        : never
      : S
    : never
  : never
export interface JourneyNode<D, M> {
  /** Read this exact node again, rather than retaining a captured snapshot. */
  state(): Promise<MatchedState<InferState<D>, M>>
  readonly actions: JourneyActions<InferActions<D>>
  readonly expectFailure: CheckedActions<InferActions<D>, "domain-error">
  readonly expectRefusal: CheckedActions<InferActions<D>, "refused">
  readonly allowCancellation: CheckedActions<InferActions<D>, "completed" | "cancelled">
  readonly id: NodeId
}

export interface JourneyOperation<E> {
  readonly id?: OperationId
  completed(options?: { readonly allowCancellation?: boolean }): Promise<void>
  cancelled(): Promise<{ readonly status: "cancelled" }>
  expectError(): Promise<{ readonly status: "error"; readonly error: E }>
  expectRefusal(): Promise<{ readonly status: "refused"; readonly reason: string }>
  cancel(): Promise<void>
}
type PublishedError<O> = O extends { status: "domain-error"; error: { data?: infer E } } ? E : never
export type JourneyActions<A> = {
  readonly [K in keyof A]: A[K] extends (...args: infer Args) => Promise<infer O>
    ? ((...args: Args) => Promise<Extract<O, { status: "completed" }>>) & {
        run(...args: Args): Promise<import("./public-types.ts").ActionOutcome<PublishedError<O>>>
        expectCompleted(...args: Args): Promise<void>
        expectError(
          ...args: Args
        ): Promise<{ readonly status: "error"; readonly error: PublishedError<O> }>
        expectRefusal(
          ...args: Args
        ): Promise<{ readonly status: "refused"; readonly reason: string }>
        start(...args: Args): Promise<JourneyOperation<PublishedError<O>>>
      }
    : never
}
