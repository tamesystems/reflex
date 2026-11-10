import type { Runtime } from "@reflex/runtime/internal"
import { useMountedNode, useNodeFocus } from "@reflex/react"
import { useLocation, useMatch, useResolvedPath } from "react-router"

/** The enclosing route's history entry owns this node until reset. */
export const useRouteNode = <N extends { dispose(): void }>(
  definition: { mount(runtime: Runtime): N },
  options: {
    readonly lifetime: "history-entry"
    readonly entryKey?: string
  },
): N | null => {
  const location = useLocation()
  return useMountedNode(definition, {
    key: options.entryKey ?? location.key,
    lifetime: options.lifetime,
  })
}

/** Read the match from the enclosing route; retained entries report their owning key. */
export const useRouteFocus = (
  node: { readonly id: import("@reflex/protocol").NodeId } | null,
  entryKey?: string,
): void => {
  const location = useLocation()
  const path = useResolvedPath(".")
  const match = useMatch({ path: path.pathname, end: true })
  useNodeFocus(node, match !== null && (entryKey === undefined || entryKey === location.key))
}
