import { type ActionsOf, type Capability, type LiveNode, liveNodeOf } from "@reflex/effect"
import { type RouteBinding, useRouteNode as useGenericRouteNode } from "./react.tsx"
export * from "./react.tsx"
export const useRouteNode = <S, A extends ActionsOf<S>, R>(
  capability: Capability<S, A, R>,
  binding: RouteBinding,
): LiveNode<S, A> | null =>
  useGenericRouteNode((runtime, id) => liveNodeOf(runtime, id, capability), binding)
