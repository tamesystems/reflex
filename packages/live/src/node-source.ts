import { ErrorCode, type Json, type NodeId, ProtocolError } from "@reflex/protocol"
import type { Runtime } from "@reflex/runtime"

/** Public JSON and protocol dispatch for any adapter, including one without `live`. */
export const nodeSource = (runtime: Runtime, id: NodeId) => {
  let revision: number | undefined
  let state: Json | null = null
  return {
    id,
    getSnapshot() {
      try {
        const { node } = runtime.inspect({ nodeId: id })
        if (node && node.revision !== revision) {
          revision = node.revision
          state = node.state
        }
      } catch (error) {
        if (!(error instanceof ProtocolError && error.code === ErrorCode.NodeNotFound)) {
          throw error
        }
      }
      return state
    },
    subscribe(listener: () => void) {
      return runtime.subscribe((event) => {
        if (
          (event.type === "state.changed" || event.type === "node.removed") &&
          event.nodeId === id
        ) {
          listener()
        }
      })
    },
    send(action: string, input?: Json) {
      return runtime.dispatch({
        nodeId: id,
        action,
        ...(input === undefined ? {} : { input }),
        await: true,
      })
    },
  }
}

export const reportFocus = (runtime: Runtime, id: NodeId): (() => void) => {
  runtime.setFocus(id)
  return () => {
    if (runtime.focus === id) {
      runtime.setFocus(null)
    }
  }
}
