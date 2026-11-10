import type { NodeId } from "@reflex/protocol"
import { matches } from "@reflex/runtime"
import type { Json } from "@reflex/protocol"

export interface RouteEntry {
  readonly nodeId: NodeId
  readonly params: Json
}

export interface RouteQuery<N> {
  readonly stack: ReadonlyArray<RouteEntry>
  /** The token on the router entry, which names its node exactly if it is current. */
  readonly token: string | null
  readonly params: Readonly<Record<string, unknown>> | undefined
  /** The live node for an entry, if it is of the wanted capability. */
  readonly resolve: (nodeId: NodeId) => N | undefined
}

/** Which node a router entry shows: its own if it can say, or else the topmost match. */
export const findRouteNode = <N>({ stack, token, params, resolve }: RouteQuery<N>): N | null => {
  const candidates = new Map<string, N>()
  for (const entry of [...stack].reverse()) {
    if (params === undefined || matches(entry.params, params)) {
      const node = resolve(entry.nodeId)
      if (node !== undefined) {
        candidates.set(entry.nodeId, node)
      }
    }
  }
  const exact = token === null ? undefined : candidates.get(token)
  const [first] = candidates.values()
  return exact ?? first ?? null
}
