import type { NodeId } from "@reflex/protocol"
import { useNodeFocus } from "@reflex/react"
import { type PathPattern, useLocation, useMatch } from "react-router"

/**
 * Report an exact route match through the generic focus binding. Supply entryKey
 * for retained route elements: identical URLs can belong to different history entries.
 * Call in a leaf screen; layouts should not compete with their focused children.
 * Node lifetime remains application-owned.
 */
export const useRouteFocus = (
  nodeId: NodeId | null,
  pattern: string | PathPattern,
  entryKey?: string,
): void => {
  const location = useLocation()
  const match = useMatch(typeof pattern === "string" ? { path: pattern, end: true } : pattern)
  useNodeFocus(nodeId, match !== null && (entryKey === undefined || entryKey === location.key))
}
