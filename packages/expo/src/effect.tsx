import type { ActionsOf, Capability } from "@reflex/effect"
import { type PublicState, liveNodeOf } from "@reflex/effect/internal"
import { useRouteNode as useGenericRouteNode } from "./react.tsx"

import { useNodeView, type NodeView } from "@reflex/react"
import type { ActionCalls } from "@reflex/effect"

export { expoRoutes } from "./routes-effect.ts"
import type { ScreenRoute } from "./routes-effect.ts"
import { useLocalSearchParams } from "expo-router"
export const useScreen = <S, A extends ActionsOf<S>, R, P, W>(
  route: ScreenRoute<Capability<S, A, R, P, W>>,
): NodeView<PublicState<W>, ActionCalls<A>> => {
  const params = route.encodedParams(useLocalSearchParams())
  const node = useGenericRouteNode(
    (runtime, id) => liveNodeOf(runtime, id, route.capability),
    params ?? undefined,
  )
  return useNodeView(params === null ? null : node)
}
