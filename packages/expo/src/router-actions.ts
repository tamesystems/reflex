/**
 * Expo Router's private report of each action its reducer accepted, with the state
 * that action left. It is private API, so it is used here and nowhere else, against
 * the exact version that `test/router-actions.test.ts` checks. Nothing public will do:
 * the container's `state` event and every hook see only what a render committed, and
 * a push the user undoes before it renders leaves that unchanged.
 */
import { getRouteInfoFromState } from "expo-router/build/global-state/getRouteInfoFromState"
import { internalNavigationEvents } from "expo-router/build/global-state/internalNavigationEvents"

type RouterState = Parameters<typeof getRouteInfoFromState>[0]

/** What `useSegments` and `useGlobalSearchParams` would say about one state. */
export interface RouteInfo {
  readonly segments: ReadonlyArray<string>
  readonly params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
}

/**
 * Calls `listener` after each accepted action, in order, as its render commits. The
 * route info comes from the function the hooks' own values come from, so the two
 * sources cannot describe one state differently. Returns how to stop.
 */
export const onRouterAction = (listener: (info: RouteInfo) => void): (() => void) =>
  internalNavigationEvents.addListener("actionDispatched", ({ state }) => {
    // The container hands this exact state to the same function; only Expo's two
    // declarations of it disagree under `exactOptionalPropertyTypes`.
    const { segments, params } = getRouteInfoFromState(state as RouterState)
    listener({ segments, params })
  })
