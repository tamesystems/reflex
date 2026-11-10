import { NoParams } from "./navigation.ts"
import { defineCapability, type ActionsOf, type StateAccess, type WireCodec } from "./capability.ts"
import type * as Effect from "effect/Effect"

/** Establish a screen's contract before importing handlers or navigation. */
export const defineScreen = <
  const C extends WireCodec<import("./erased.ts").Erased>,
  const Name extends string,
  const P extends WireCodec<import("./erased.ts").Erased> = typeof NoParams,
>(contract: {
  readonly name: Name
  readonly state: C
  readonly params?: P
  readonly initial: (params: P["Type"]) => C["Type"]
}) => ({
  ...contract,
  params: (contract.params ?? NoParams) as P,
  handler<A, E, R>(handler: (state: StateAccess<C["Type"]>) => Effect.Effect<A, E, R>) {
    return handler
  },
  when<K extends C["Type"] extends { readonly _tag: infer Tag } ? Tag & string : never>(_tag: K) {
    return {
      handler<A, E, R>(
        handler: (
          state: StateAccess<Extract<C["Type"], { readonly _tag: K }>, C["Type"]>,
        ) => Effect.Effect<A, E, R>,
      ) {
        return handler
      },
    }
  },
  implement<A extends ActionsOf<C["Type"]>, R = never>(implementation: {
    readonly actions: Parameters<
      typeof defineCapability<C["Type"], A, R, P["Type"], C["Encoded"], Name>
    >[0]["actions"]
    readonly onFocus?: (state: StateAccess<C["Type"]>) => Effect.Effect<unknown, never, R>
  }) {
    const capability = defineCapability<C["Type"], A, R, P["Type"], C["Encoded"], Name>({
      ...contract,
      params: (contract.params ?? NoParams) as P,
      ...implementation,
    })
    return capability as Omit<typeof capability, "params"> & { readonly params: P }
  },
})

/** Infer the consumer-observed wire state and action contracts. */
export type InferState<C> = C extends import("@reflex/runtime/internal").ConsumerDefinition<
  infer S,
  unknown
>
  ? S
  : never
type Calls<C> = C extends import("@reflex/runtime/internal").ConsumerDefinition<unknown, infer A>
  ? A
  : never
export type InferInput<C, K extends keyof Calls<C>> = Calls<C>[K] extends (
  ...args: infer Args
) => unknown
  ? Args extends [infer I]
    ? I
    : undefined
  : never
export type InferError<C, K extends keyof Calls<C>> = Calls<C>[K] extends (
  ...args: never
) => Promise<import("@reflex/runtime/internal").ActionOutcome<infer E>>
  ? E
  : never
