import type { ActionsOf, Capability, LiveNode } from "@reflex/effect"
import { type PublicState, liveNodeOf } from "@reflex/effect/internal"
import { type RouteBinding, useRouteNode as useGenericRouteNode } from "./react.tsx"
export const useCapabilityNode = <S, A extends ActionsOf<S>, R, P, W>(
  capability: Capability<S, A, R, P, W>,
  binding: RouteBinding,
): LiveNode<PublicState<W>, A> | null =>
  useGenericRouteNode((runtime, id) => liveNodeOf(runtime, id, capability), binding)
