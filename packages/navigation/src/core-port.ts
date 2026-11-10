import { defined } from "@reflex/protocol"
import type { AppSession } from "@reflex/runtime/internal"
import { navigationState, type StackEntry } from "./projection.ts"
import type { CorePort } from "./projection-controller.ts"

const emptyStack: ReadonlyArray<StackEntry> = []

/** Caches by the state's identity, which `useSyncExternalStore` needs to be stable. */
export const stackReader = (session: AppSession) => {
  let lastState: unknown
  let lastStack = emptyStack
  return (): ReadonlyArray<StackEntry> => {
    const state = session.runtime.stateOf("Navigation")
    if (state === undefined) {
      return emptyStack
    }
    if (state !== lastState) {
      lastState = state
      lastStack = navigationState(state, "Navigation").stack
    }
    return lastStack
  }
}

/**
 * Names its node, because an action without one goes to the focused screen first, and a
 * screen may well have a `GoBack` of its own. That one is not the router's to call.
 */
export const corePortOf = (session: AppSession): CorePort => {
  const { runtime } = session
  const nodeId = () => {
    const { node } = runtime.inspect({ name: "Navigation" })
    return defined(node?.id, "a session that navigates has its node")
  }
  return {
    isOpen: () => !runtime.closed,
    readStack: stackReader(session),
    goBack: async () => runtime.dispatch({ nodeId: nodeId(), action: "GoBack", await: true }),
    navigate: async ({ route, params }) =>
      runtime.dispatch({
        nodeId: nodeId(),
        action: "Navigate",
        input: { route, params },
        await: true,
      }),
  }
}
