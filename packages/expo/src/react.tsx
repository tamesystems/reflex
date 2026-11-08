import { type ActionsOf, type Capability, type LiveNode, liveNodeOf } from "@reflex/effect"
import { assertNever, isRecord } from "@reflex/protocol"
import { type AppHost, type AppSession, type Controller, systemTimers } from "@reflex/runtime"
import {
  router,
  useGlobalSearchParams,
  useLocalSearchParams,
  useNavigationContainerRef,
  useSegments,
} from "expo-router"
import * as React from "react"
import { corePortOf, stackReader } from "./core-port.ts"
import { type Destination, NODE_PARAM, type RouterLocation, type StackEntry } from "./projection.ts"
import { ProjectionController } from "./projection-controller.ts"
import { findRouteNode } from "./route-binding.ts"
import { onRouterAction } from "./router-actions.ts"
import { createLiveController } from "./live-controller.ts"
import { LiveSessions } from "./live-sessions.ts"
import { reportFailure } from "./ui-actions.ts"
export { send } from "./ui-actions.ts"

export * from "./projection.ts"
export * from "./projection-controller.ts"
export * from "./route-binding.ts"
export * from "./live-controller.ts"
export * from "./live-sessions.ts"
export * from "./session-owner.ts"

export interface RouterHref {
  readonly pathname: string
  readonly params?: Record<string, string>
}

export type RouteParams = Record<string, string | ReadonlyArray<string> | undefined>

const SessionContext = React.createContext<AppSession | null>(null)

export const useSession = (): AppSession => {
  const session = React.useContext(SessionContext)
  if (session === null) {
    throw new Error("useSession must be used inside <ReflexProvider>")
  }
  return session
}

/** Serves the live app to a bridge, as `connectBridge` from `@reflex/expo/bridge` does. */
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

/** The core's route stack, as React state. */
export const useCoreStack = (): ReadonlyArray<StackEntry> => {
  const session = useSession()
  const read = React.useMemo(() => stackReader(session), [session])
  const subscribe = React.useCallback(
    (listener: () => void) =>
      session.runtime.subscribe((event) => {
        if (event.type === "state.changed") {
          listener()
        }
      }),
    [session],
  )
  return React.useSyncExternalStore(subscribe, read)
}

/** Route params can repeat; the first is the one meant. */
export const routeParam = (value: string | ReadonlyArray<string> | undefined): string | null => {
  if (typeof value === "string") {
    return value
  }
  return value?.[0] ?? null
}

/**
 * The live node behind this router entry. A core push names its node exactly;
 * an entry from a deep link is found by `params`, once the core has adopted it.
 * It keeps its last state after the core pops it, so a screen can animate out.
 */
export const useRouteNode = <S, A extends ActionsOf<S>, R>(
  capability: Capability<S, A, R>,
  params?: Record<string, unknown>,
): LiveNode<S, A> | null => {
  const { runtime } = useSession()
  const stack = useCoreStack()
  const token = routeParam(useLocalSearchParams()[NODE_PARAM])
  const key = JSON.stringify([token, params])
  const bound = React.useRef<{ key: string; node: LiveNode<S, A> } | null>(null)
  const node =
    bound.current?.key === key
      ? bound.current.node
      : findRouteNode({
          stack,
          token,
          params,
          resolve: (nodeId) => liveNodeOf(runtime, nodeId, capability),
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
type StateSource<S> = Pick<LiveNode<S, never>, "getSnapshot" | "subscribe">

/** Subscribe to a node the way any external store is subscribed to. */
export const useNodeState = <S,>(node: StateSource<S> | null): S | null =>
  React.useSyncExternalStore(node?.subscribe ?? noSubscription, () => node?.getSnapshot() ?? null)

type ToHref = (destination: Destination) => RouterHref

const hrefFor = (toHref: ToHref, entry: StackEntry) => {
  const { pathname, params } = toHref(entry)
  // Expo types `router.push` against generated routes, which these mappers go around.
  return { pathname, params: { ...params, [NODE_PARAM]: entry.nodeId } } as never
}

/** Expo leaves this route's type open, which comes out as `never`. */
const paramsOf = (route: { readonly params?: unknown } | undefined): unknown => route?.params

const tokenParam = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** Reads the token the router's own state holds, which its render can lag behind. */
export const useShownToken = (): (() => string | null) => {
  const navigation = useNavigationContainerRef()
  return () => {
    const shownParams = paramsOf(navigation.getCurrentRoute())
    return isRecord(shownParams) ? routeParam(tokenParam(shownParams[NODE_PARAM])) : null
  }
}

const createProjection = (
  session: AppSession,
  mapToHref: { readonly current: ToHref },
  initialLocation: RouterLocation,
  shownToken: () => string | null,
): ProjectionController =>
  new ProjectionController({
    router: {
      push: (entry) => router.push(hrefFor(mapToHref.current, entry)),
      replace: (entry) => router.replace(hrefFor(mapToHref.current, entry)),
      tag: (entry) => router.setParams({ [NODE_PARAM]: entry.nodeId } as never),
      back: () => router.back(),
      shownToken: () => shownToken(),
    },
    core: corePortOf(session),
    initialLocation,
    onError: reportFailure,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
    now: () => performance.now(),
  })

type FromLocation = (segments: ReadonlyArray<string>, params: RouteParams) => Destination | null

/** One way to read a router state, for both the hooks' values and an action's. */
const locationAt = (
  fromLocation: FromLocation,
  segments: ReadonlyArray<string>,
  params: RouteParams,
): RouterLocation => ({
  token: routeParam(params[NODE_PARAM]),
  destination: fromLocation(segments, params),
})

/**
 * Keeps Expo Router showing the core's stack, and feeds what the router does by
 * itself (gestures, hardware back, deep links) back in as core actions.
 *
 * Both mappers work on route files and decoded params. Paths are never parsed
 * here, so there is no second encoding to disagree with the router's.
 *
 * App code must navigate through the core. `router.replace` in particular cannot
 * be told apart from a push by watching the router, so it would corrupt history.
 */
export const RouterProjection = ({
  toHref,
  fromLocation,
}: {
  readonly toHref: ToHref
  /** The core destination for a route file, or null if it has none. */
  readonly fromLocation: FromLocation
}) => {
  const session = useSession()
  const stack = useCoreStack()
  // Expo types these against generated routes, which the mappers deliberately go around.
  const segments = useSegments() as ReadonlyArray<string>
  const params = useGlobalSearchParams()

  const { token, destination } = locationAt(fromLocation, segments, params)
  const location = React.useMemo<RouterLocation>(
    () => ({ token, destination }),
    [token, destination],
  )

  const mapToHref = React.useRef(toHref)
  const mapFromLocation = React.useRef(fromLocation)
  const shownToken = useShownToken()
  // State, not a memo: this component is keyed to the session, and the controller
  // must live exactly as long as it does. A memo may be discarded.
  const [controller] = React.useState(() =>
    createProjection(session, mapToHref, location, shownToken),
  )

  React.useEffect(() => {
    mapToHref.current = toHref
    mapFromLocation.current = fromLocation
  }, [toHref, fromLocation])

  React.useEffect(
    () =>
      onRouterAction(({ segments, params }) =>
        controller.onLocation(locationAt(mapFromLocation.current, segments, params)),
      ),
    [controller],
  )
  React.useEffect(() => controller.onStack(stack), [controller, stack])
  React.useEffect(() => controller.onLocation(location), [controller, location])

  return null
}
