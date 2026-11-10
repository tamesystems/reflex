import {
  definitionIdentity,
  DEFINITION_IDENTITY,
  mountSessionRoute,
  type AppHost,
  type ConsumerDefinition,
  type NodeHandle,
  type Runtime,
  type ActionOutcome,
  type StoreInput,
} from "@reflex/runtime/internal"
import {
  createReflex,
  useMountedNode,
  useNodeFocus,
  useNodeView,
  type ScreenView,
} from "@reflex/react"
import { useSuspenseRoute, useRuntimeSession } from "@reflex/react/advanced"
import { useLocation, useMatch, useResolvedPath, useNavigationType, useParams } from "react-router"
import { useMemo } from "react"

type Calls = Record<string, (...args: never[]) => Promise<ActionOutcome<unknown>>>
type Definition = ConsumerDefinition & {
  resolve(runtime: Runtime, id?: import("@reflex/protocol").NodeId): unknown
}
type Contract<D extends Record<string, Definition>> = {
  [K in keyof D]: D[K] extends { readonly [DEFINITION_IDENTITY]: infer I }
    ? { readonly name: D[K]["name"]; readonly [DEFINITION_IDENTITY]: I }
    : { readonly name: D[K]["name"] }
}[keyof D]
type Selected<D, C> = Extract<
  D[keyof D],
  { readonly name: C extends { readonly name: infer N } ? N : never }
>
type WireParams<D> = D extends { readonly params: { readonly Encoded: infer P } }
  ? P
  : D extends { readonly params: StoreInput<unknown, infer P> }
    ? P
    : Record<string, never>
type Registration<D> = string extends keyof WireParams<D>
  ? string
  : keyof WireParams<D> extends never
    ? string
    : {
        readonly pathname: string
        readonly params: {
          readonly [K in keyof WireParams<D>]-?: WireParams<D>[K] extends string | undefined
            ? string
            : "URL params must encode strings"
        }
      }
type Unique<M extends Record<string, unknown>> = {
  [K in keyof M]: { [J in Exclude<keyof M, K>]: M[J] extends M[K] ? J : never }[Exclude<keyof M, K>]
}[keyof M] extends never
  ? unknown
  : { readonly "URL param mapping targets must be unique": never }
type Check<R> = R extends { readonly params: infer M extends Record<string, unknown> }
  ? Unique<M>
  : unknown

const validateRegistration = (
  screens: Record<string, Definition>,
  registration: Record<string, string | { readonly pathname: string; readonly params: object }>,
) => {
  for (const key of Object.keys(screens)) {
    const route = registration[key]
    if (route === undefined) {
      throw new Error(`Screen "${key}" needs a URL registration`)
    }
    if (
      typeof route !== "string" &&
      new Set(Object.values(route.params)).size !== Object.keys(route.params).length
    ) {
      throw new Error(`Screen "${key}" URL param mapping targets must be unique`)
    }
  }
}
type BoundDefinition = Definition & {
  resolve(
    runtime: Runtime,
    id?: import("@reflex/protocol").NodeId,
  ): NodeHandle<unknown, Calls> | undefined
}
const useRegistration = (
  app: AppHost & { readonly screens: Record<string, Definition> },
  registration: Record<string, string | { readonly pathname: string; readonly params: object }>,
  contract: { readonly name: string },
) => {
  const location = useLocation()
  const path = useResolvedPath(".")
  const match = useMatch({ path: path.pathname, end: true })
  const navigationType = useNavigationType()
  const raw = useParams()
  const { runtime } = useRuntimeSession()
  const entry = Object.entries(app.screens).find(([, screen]) => screen.name === contract.name)
  if (entry === undefined) {
    throw new Error(`Screen "${contract.name}" is not part of app "${app.name}"`)
  }
  const [key, selected] = entry
  const definition = selected as BoundDefinition
  if (definitionIdentity(definition) !== definitionIdentity(contract)) {
    throw new Error(`Screen "${contract.name}" must use the app's registered contract`)
  }
  const route = registration[key]
  if (route === undefined) {
    throw new Error(`Screen "${key}" needs a URL registration`)
  }
  const mapping = typeof route === "string" ? {} : (route.params as Record<string, string>)
  const paramsKey = JSON.stringify(
    Object.fromEntries(
      Object.entries(mapping)
        .filter(([, target]) => raw[target] !== undefined)
        .map(([source, target]) => [source, raw[target]]),
    ),
  )
  const params = useMemo(
    () => definition["~reflex"].decodeParams?.(JSON.parse(paramsKey)) ?? JSON.parse(paramsKey),
    [definition, paramsKey],
  )
  return { location, match, navigationType, runtime, definition, params }
}
const routeMount = (runtime: Runtime, definition: BoundDefinition, params: unknown) => ({
  identity: definition,
  mount: () =>
    Promise.resolve(mountSessionRoute(runtime, definition, params)).then((owned) => {
      const node = definition.resolve(runtime, owned.id)
      if (node === undefined) {
        owned.dispose()
        throw new Error(`Screen "${definition.name}" did not resolve after mounting`)
      }
      return Object.assign(Object.create(node), { dispose: owned.dispose }) as NodeHandle<
        unknown,
        Calls
      > & { dispose(): void }
    }),
})

/** Call once at module scope, like createTRPCReact; bindings have stable identities. */
export const createReflexRouter = <
  H extends AppHost,
  const D extends Record<string, Definition>,
  const R extends { readonly [K in keyof D]: Registration<D[K]> },
>(
  app: H & { readonly screens: D },
  registration: R & { readonly [K in keyof R]: Check<R[K]> },
) => {
  validateRegistration(app.screens, registration)
  const bound = createReflex(app)
  // biome-ignore lint/correctness/noComponentHookFactories: This is an explicit module-scope binding factory, never called during render.
  const useScreen = <C extends Contract<D>>(contract: C): ScreenView<Selected<D, C>> => {
    bound.useSession()
    const { location, match, navigationType, runtime, definition, params } = useRegistration(
      app,
      registration,
      contract,
    )
    const mount = useMemo(
      () => routeMount(runtime, definition, params),
      [runtime, definition, params],
    )
    const node = useMountedNode(mount, {
      key: location.key,
      lifetime: "history-entry",
      navigationType,
    })
    useNodeFocus(node, match !== null)
    return useNodeView(node) as ScreenView<Selected<D, C>>
  }
  // biome-ignore lint/correctness/noComponentHookFactories: This is an explicit module-scope binding factory, never called during render.
  const useScreenSuspense = <C extends Contract<D>>(
    contract: C,
  ): Extract<ScreenView<Selected<D, C>>, { readonly status: "ready" }> => {
    bound.useSession()
    const { location, match, definition, params } = useRegistration(app, registration, contract)
    const node = useSuspenseRoute(definition, params, location.key)
    useNodeFocus(node, match !== null)
    return useNodeView(node) as Extract<ScreenView<Selected<D, C>>, { readonly status: "ready" }>
  }
  return { ...bound, useScreen, useScreenSuspense }
}
