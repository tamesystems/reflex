import type { ActionsOf, Capability, LiveNode } from "@reflex/effect"
import { liveNodeOf } from "@reflex/effect/internal"
import { useRouteNode as useGenericRouteNode } from "./react.tsx"
export * from "./index.ts"
export { send, useNodeState } from "@reflex/react"

export { expoRoutes } from "./routes-effect.ts"
import type { ScreenRoute } from "./routes-effect.ts"
import { useLocalSearchParams } from "expo-router"
export const useScreen = <S, A extends ActionsOf<S>, R, P, W>(
  route: ScreenRoute<Capability<S, A, R, P, W>>,
): LiveNode<S, A> | null => {
  const params = route.encodedParams(useLocalSearchParams())
  const node = useGenericRouteNode(
    (runtime, id) => liveNodeOf(runtime, id, route.capability),
    params ?? undefined,
  )
  return params === null ? null : node
}
export { useAction } from "@reflex/react"
