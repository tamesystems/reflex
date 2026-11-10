import { SCREEN_CONTRACT } from "./screen-identity.ts"
import { NoParams } from "./navigation.ts"
import { defineCapability, type ActionsOf, type StateAccess, type WireCodec } from "./capability.ts"
import type * as Effect from "effect/Effect"

/** Establish a screen's contract before importing handlers or navigation. */
export const defineScreen = <
  const C extends WireCodec<import("./erased.ts").Erased>,
  const Name extends string,
  const Identity extends symbol | string = Name,
  const P extends WireCodec<import("./erased.ts").Erased> = typeof NoParams,
>(contract: {
  readonly identity?: Identity
  readonly name: Name
  readonly state: C
  readonly params?: P
  readonly initial: (params: P["Type"]) => C["Type"]
}) => {
  const identity = { key: (contract.identity ?? contract.name) as Identity }
  const screen = {
    [SCREEN_CONTRACT]: identity,
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
      return Object.assign(capability, {
        [SCREEN_CONTRACT]: identity,
      }) as Omit<typeof capability, "params"> & {
        readonly params: P
        readonly [SCREEN_CONTRACT]: { readonly key: Identity }
      }
    },
  }
  return screen
}

export type { InferState, InferActions, InferInput, InferError } from "@reflex/runtime/internal"
