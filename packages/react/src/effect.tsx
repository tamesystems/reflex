import type { ActionsOf, Capability, LiveNode } from "@reflex/effect"
import { liveNodeOf } from "@reflex/effect/internal"
import { type RouteBinding, useRouteNode as useGenericRouteNode } from "./react.tsx"
export * from "./index.ts"
export const useCapabilityNode = <S, A extends ActionsOf<S>, R, P, W>(
  capability: Capability<S, A, R, P, W>,
  binding: RouteBinding,
): LiveNode<S, A> | null =>
  useGenericRouteNode((runtime, id) => liveNodeOf(runtime, id, capability), binding)
