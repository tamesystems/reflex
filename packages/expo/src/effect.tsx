import { type ActionsOf, type Capability, type LiveNode, liveNodeOf } from "@reflex/effect"
import { useRouteNode as useGenericRouteNode } from "./react.tsx"
export * from "./react.tsx"
export const useRouteNode = <S, A extends ActionsOf<S>, R>(
  capability: Capability<S, A, R>,
  params?: Record<string, unknown>,
): LiveNode<S, A> | null =>
  useGenericRouteNode((runtime, id) => liveNodeOf(runtime, id, capability), params)
