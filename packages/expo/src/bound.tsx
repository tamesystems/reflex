import { screenReady } from "./screen-ready.ts"
import { SCREEN_BINDING, NODE_PARAM } from "./route-token.ts"
import {
  definitionIdentity,
  DEFINITION_IDENTITY,
  type AppHost,
  type ConsumerDefinition,
  type NodeHandle,
} from "@reflex/runtime/internal"
import { createReflex, useNodeView, type ScreenView } from "@reflex/react"
import { useLocalSearchParams } from "expo-router"
import { expoRoutes, type AnyScreen, type Registration, type CheckPath } from "./routes-effect.ts"
import { useRouteNode, RouterProjection, routeParam } from "./react.tsx"
import type { ActionOutcome } from "@reflex/runtime/internal"
import { useRuntimeSession } from "@reflex/react/advanced"
import { liveNodeOf } from "@reflex/effect/internal"
import type { Capability } from "@reflex/effect/advanced"
import { use, type ComponentProps } from "react"

type Screen = AnyScreen &
  ConsumerDefinition & { readonly [DEFINITION_IDENTITY]: { readonly key: symbol | string } }
type Contract<D extends Record<string, Screen>> = {
  [K in keyof D]: Pick<D[K], "name" | typeof DEFINITION_IDENTITY>
}[keyof D]
type Calls = Record<string, (...args: never[]) => Promise<ActionOutcome<unknown>>>
type Selected<D, C> = Extract<
  D[keyof D],
  { readonly name: C extends { readonly name: infer N } ? N : never }
>

/** One app supplies identity, scenarios, implementations and all consumer types. */
export const createReflexExpo = <
  H extends AppHost,
  const D extends Record<string, Screen>,
  const R extends { readonly [K in keyof D]: Registration<D[K]> },
>(
  app: H & { readonly screens: D },
  registration: R & { readonly [K in keyof R]: CheckPath<R[K]> },
) => {
  const bound = createReflex(app)
  const routes = expoRoutes({ screens: app.screens }, registration)
  // biome-ignore lint/correctness/noComponentHookFactories: This explicit binding factory is called once at module scope.
  const useScreen = <C extends Contract<D>>(contract: C): ScreenView<Selected<D, C>> => {
    bound.useSession()
    const entry = Object.values(routes)
      .map((entry) => entry[SCREEN_BINDING])
      .find((entry) => entry.capability.name === contract.name)
    if (entry === undefined) {
      throw new Error(`Screen "${contract.name}" is not part of app "${app.name}"`)
    }
    if (definitionIdentity(entry.capability) !== definitionIdentity(contract)) {
      throw new Error(`Screen "${contract.name}" must use the app's registered contract`)
    }
    const params = entry.encodedParams(useLocalSearchParams())
    const node = useRouteNode(
      (runtime, id) =>
        liveNodeOf(runtime, id, contract as unknown as Capability<unknown, never, never>),
      params ?? undefined,
    )
    return useNodeView(node as NodeHandle<unknown, Calls> | null) as ScreenView<Selected<D, C>>
  }
  // biome-ignore lint/correctness/noComponentHookFactories: This explicit binding factory is called once at module scope.
  const useScreenSuspense = <C extends Contract<D>>(
    contract: C,
  ): Extract<ScreenView<Selected<D, C>>, { readonly status: "ready" }> => {
    const view = useScreen(contract)
    const session = useRuntimeSession()
    const raw = useLocalSearchParams()
    const entry = Object.values(routes)
      .map((entry) => entry[SCREEN_BINDING])
      .find((entry) => entry.capability.name === contract.name)
    if (entry === undefined) {
      throw new Error(`Screen "${contract.name}" needs a URL binding`)
    }
    const params = entry.encodedParams(raw)
    const node =
      view.status === "pending"
        ? use(screenReady(session, contract, params ?? undefined, routeParam(raw[NODE_PARAM])))
        : null
    const ready = useNodeView(node)
    return (view.status === "ready" ? view : ready) as Extract<
      ScreenView<Selected<D, C>>,
      { readonly status: "ready" }
    >
  }

  return {
    ...bound,
    useScreenSuspense,
    useScreen,
    // biome-ignore lint/correctness/noComponentHookFactories: This explicit binding factory is called once at module scope.
    RouterProjection: (props: Omit<ComponentProps<typeof RouterProjection>, "routes">) => (
      <RouterProjection {...props} routes={routes} />
    ),
  }
}
