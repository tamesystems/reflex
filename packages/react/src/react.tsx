import { assertNever, type NodeId } from "@reflex/protocol"
import {
  type AppHost,
  type AppSession,
  type Controller,
  type Runtime,
  systemTimers,
} from "@reflex/runtime"
import {
  nodeSource,
  reportFocus,
  createLiveController,
  LiveSessions,
  reportFailure,
} from "@reflex/live/session"
import * as React from "react"
import { findRouteNode, type RouteEntry } from "./route-binding.ts"
export { send } from "@reflex/live/session"
export * from "./route-binding.ts"
export interface RouteBinding {
  readonly stack: ReadonlyArray<RouteEntry>
  readonly token: string | null
  readonly params?: Record<string, unknown>
}
const SessionContext = React.createContext<AppSession | null>(null)

export const useSession = (): AppSession => {
  const session = React.useContext(SessionContext)
  if (session === null) {
    throw new Error("useSession must be used inside <ReflexProvider>")
  }
  return session
}

/** Serves the live app to a bridge, as `connectBridge` from `@reflex/live` does. */
export type BridgeConnector = (controller: Controller) => () => void

/**
 * Owns one session. Replacing it unmounts everything beneath, so that nothing
 * can outlive it holding a disposed node. A session that cannot start is thrown
 * during render, for the nearest error boundary.
 *
 * With `bridge`, the protocol is served to it for as long as this is mounted, against
 * the session on screen. A bridge's reset replaces that session, until `scenario` or
 * `host` next changes.
 */
export const ReflexProvider = ({
  host,
  scenario,
  bridge,
  fallback = null,
  children,
}: {
  readonly host: AppHost
  readonly scenario?: string
  readonly bridge?: BridgeConnector | undefined
  readonly fallback?: React.ReactNode
  readonly children: React.ReactNode
}) => {
  const [sessions] = React.useState(
    () => new LiveSessions({ timers: systemTimers, onBackgroundError: reportFailure }),
  )
  const lifecycle = React.useSyncExternalStore(sessions.subscribe, sessions.getSnapshot)
  React.useEffect(() => sessions.open(host, scenario), [sessions, host, scenario])
  React.useEffect(() => {
    if (bridge === undefined) {
      return undefined
    }
    const controller = createLiveController(sessions, reportFailure)
    const stop = bridge(controller)
    return () => {
      stop()
      controller.close().catch(reportFailure)
    }
  }, [sessions, bridge])

  switch (lifecycle.kind) {
    case "starting":
      return <>{fallback}</>
    case "failed":
      throw lifecycle.cause
    case "live":
      // Keyed, because a replacement can arrive in the same commit as the old session
      // ending, and screens must not keep nodes bound to a session that has gone.
      return (
        <SessionContext.Provider
          key={lifecycle.session.runtime.sessionId}
          value={lifecycle.session}
        >
          {children}
        </SessionContext.Provider>
      )
    default:
      return assertNever(lifecycle)
  }
}

export const useRouteNode = <N,>(
  resolve: (runtime: Runtime, nodeId: NodeId) => N | undefined,
  { stack, token, params }: RouteBinding,
): N | null => {
  const { runtime } = useSession()
  const key = JSON.stringify([token, params])
  const bound = React.useRef<{ key: string; node: N } | null>(null)
  const node =
    bound.current?.key === key
      ? bound.current.node
      : findRouteNode({
          stack,
          token,
          params,
          resolve: (nodeId) => resolve(runtime, nodeId),
        })

  // Kept across renders, so that a screen stays on its node after the core pops it.
  React.useEffect(() => {
    if (node !== null) {
      bound.current = { key, node }
    }
  }, [key, node])

  return node
}

const noSubscription = () => () => undefined

/** The part of a node a subscriber needs. */
export interface StateSource<S> {
  getSnapshot(): S
  subscribe(listener: () => void): () => void
}

/** Subscribe to a node the way any external store is subscribed to. */
export const useNodeState = <S,>(node: StateSource<S> | null): S | null =>
  React.useSyncExternalStore(node?.subscribe ?? noSubscription, () => node?.getSnapshot() ?? null)

/** Report focus from an existing router; cleanup never clears a newer screen's focus. */
export const useNodeFocus = (nodeId: NodeId | null, focused: boolean): void => {
  const { runtime } = useSession()
  React.useEffect(() => {
    if (!focused || nodeId === null) {
      return undefined
    }
    return reportFocus(runtime, nodeId)
  }, [runtime, nodeId, focused])
}

/** Bind a public node handle without assumptions about the adapter's live object. */
export const useNode = (id: NodeId | null) => {
  const { runtime } = useSession()
  return React.useMemo(() => (id === null ? null : nodeSource(runtime, id)), [runtime, id])
}
