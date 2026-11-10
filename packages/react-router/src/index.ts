import type { Runtime, NodeHandle, ActionOutcome } from "@reflex/runtime/internal"
import { useMountedNode, useNodeFocus, useNodeView, type NodeView } from "@reflex/react"
import { useLocation, useMatch, useResolvedPath, useNavigationType } from "react-router"

/** The router supplies entry identity and focus; React owns mounting and bounded retention. */
export const useScreen = <
  S,
  A extends Record<string, (...args: never) => Promise<ActionOutcome<unknown>>>,
>(definition: {
  mount(runtime: Runtime): NodeHandle<S, A> & { dispose(): void }
}): NodeView<S, A> => {
  const location = useLocation()
  const path = useResolvedPath(".")
  const match = useMatch({ path: path.pathname, end: true })
  const node = useMountedNode(definition, {
    key: location.key,
    lifetime: "history-entry",
    navigationType: useNavigationType(),
  })
  useNodeFocus(node, match !== null)
  return useNodeView(node)
}
