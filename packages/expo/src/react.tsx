import { isRecord, type NodeId } from "@reflex/protocol"
import type { AppSession, Runtime } from "@reflex/runtime/internal"
import {
  router,
  useGlobalSearchParams,
  useLocalSearchParams,
  useNavigationContainerRef,
  useSegments,
} from "expo-router"
import * as React from "react"
import {
  useRuntimeSession as useSession,
  useRouteNode as useBoundRouteNode,
} from "@reflex/react/advanced"
import { reportFailure } from "@reflex/live/session"
import {
  corePortOf,
  stackReader,
  ProjectionController,
  type Destination,
  type RouterLocation,
  type StackEntry,
} from "@reflex/navigation"
import { onRouterAction } from "./router-actions.ts"

/** Expo route parameter carrying the core entry identity. */
export { NODE_PARAM } from "./route-token.ts"
import { NODE_PARAM, ROUTE_MAPPING } from "./route-token.ts"

export interface RouterHref {
  readonly pathname: string
  readonly params?: Record<string, string>
}

export type RouteParams = Record<string, string | ReadonlyArray<string> | undefined>

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

export const useRouteNode = <N,>(
  resolve: (runtime: Runtime, nodeId: NodeId) => N | undefined,
  params?: Record<string, unknown>,
): N | null =>
  useBoundRouteNode(resolve, {
    stack: useCoreStack(),
    token: routeParam(useLocalSearchParams()[NODE_PARAM]),
    ...(params === undefined ? {} : { params }),
  })

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
  routes,
}: {
  readonly routes: {
    readonly [ROUTE_MAPPING]: { readonly toHref: ToHref; readonly fromLocation: FromLocation }
  }
}) => {
  const { toHref, fromLocation } = routes[ROUTE_MAPPING]

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
