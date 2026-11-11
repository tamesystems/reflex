import { createReflex } from "@reflex/react"
import {
  RouteContext,
  RouteRetryProvider,
  screenDefinitions,
  matchesContract,
  useRuntimeSession,
  useRouteLease,
  type App,
  type Screens,
  type Contract,
  type URLParams,
  type ReflexBinding,
} from "@reflex/react/advanced"
import { mountSessionRoute } from "@reflex/runtime/internal"
import {
  Link as HostLink,
  useLocation,
  useNavigationType,
  useParams,
  type LinkProps,
  type RouteObject,
} from "react-router"
import * as React from "react"
import type { ValidateRoutes } from "./route-types.ts"

export type HostRouteOptions = Omit<
  RouteObject,
  "path" | "index" | "children" | "id" | "Component" | "element" | "lazy"
> &
  (
    | { Component: NonNullable<RouteObject["Component"]> }
    | { element: NonNullable<RouteObject["element"]> }
    | { lazy: NonNullable<RouteObject["lazy"]> }
  )
type RouteArgs<C> = C extends unknown
  ? [contract: C, ...params: keyof URLParams<C> extends never ? [] : [params: URLParams<C>]]
  : never
type BoundLinkProps<C> = C extends unknown
  ? { to: C; children?: React.ReactNode } & (keyof URLParams<C> extends never
      ? { params?: never }
      : { params: URLParams<C> }) &
      Omit<LinkProps, "to" | "href" | "params" | "asChild">
  : never
export interface RouterBinding<A extends App> extends ReflexBinding<A> {
  href(...args: RouteArgs<Contract<Screens<A>>>): string
  Link(props: BoundLinkProps<Contract<Screens<A>>>): React.ReactElement
  routes(
    views: {
      [K in Screens<A> extends { name: infer N extends string } ? N : never]: HostRouteOptions
    },
  ): RouteObject[]
}
type Registration =
  | import("@reflex/react/advanced").RouteCodec<Record<string, string | undefined>>
  | string
  | {
      readonly path?: string
      readonly pathname?: string
      readonly params?: Readonly<Record<string, string>>
    }
const pathOf = (entry: Registration) =>
  (typeof entry === "string"
    ? entry
    : "path" in entry
      ? entry.path
      : (entry.pathname ?? "")
  ).replace(/\[([^\]]+)\]/g, ":$1")
const mapOf = (entry: Registration): Readonly<Record<string, string>> =>
  typeof entry === "string" ? {} : "params" in entry ? (entry.params ?? {}) : {}
class ScreenBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode; retry(): Promise<void> },
  { error: Error | null }
> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (this.state.error === null) {
      return this.props.children
    }
    return (
      <>
        {this.props.fallback ?? <p>{this.state.error.message}</p>}
        <button
          type="button"
          onClick={() => {
            void this.props
              .retry()
              .finally(() => this.setState({ error: null }))
              .catch(() => undefined)
          }}
        >
          Retry
        </button>
      </>
    )
  }
}
const RouteScreen = ({
  definition,
  entry,
  children,
  fallback,
}: {
  definition: ReturnType<typeof screenDefinitions>[number]
  entry: Registration
  children: React.ReactNode
  fallback?: React.ReactNode
}) => {
  const location = useLocation()
  const navigationType = useNavigationType()
  const raw = { ...Object.fromEntries(new URLSearchParams(location.search)), ...useParams() }
  const mapping = mapOf(entry)
  const reverse = Object.fromEntries(
    Object.entries(mapping).map(([source, target]) => [target, source]),
  )
  const paramsKey = JSON.stringify(
    typeof entry !== "string" && "decode" in entry
      ? entry.decode(raw)
      : Object.fromEntries(Object.entries(raw).map(([key, value]) => [reverse[key] ?? key, value])),
  )
  const params = React.useMemo(
    () => definition["~reflex"].decodeParams?.(JSON.parse(paramsKey)) ?? JSON.parse(paramsKey),
    [definition, paramsKey],
  )
  const { runtime } = useRuntimeSession()
  const lease = useRouteLease(
    {
      identity: definition,
      mount: (_, signal) => mountSessionRoute(runtime, definition, params, signal),
    },
    { key: location.key, lifetime: "history-entry", navigationType, params },
  )
  const retry = async () => {
    await lease?.retry()
  }
  return (
    <RouteContext.Provider
      value={{ key: location.key, contract: definition, params, navigationType }}
    >
      <RouteRetryProvider value={retry}>
        <ScreenBoundary key={location.key} retry={retry} fallback={fallback}>
          <React.Suspense fallback={<p>Loading…</p>}>{children}</React.Suspense>
        </ScreenBoundary>
      </RouteRetryProvider>
    </RouteContext.Provider>
  )
}

const validateRegistration = (
  screens: ReturnType<typeof screenDefinitions>,
  entries: Record<string, Registration>,
) => {
  for (const definition of screens) {
    const entry = entries[definition.name]
    if (entry === undefined) {
      throw new Error(`${definition.name} needs a route registration`)
    }
    if (typeof entry !== "string" && "decode" in entry) {
      continue
    }
    const path = pathOf(entry)
    const placeholders = path
      .split("/")
      .filter((part) => part.startsWith(":"))
      .map((part) => part.slice(1))
    if (new Set(placeholders).size !== placeholders.length) {
      throw new Error("Repeated path placeholder")
    }
    const targets = Object.values(mapOf(entry))
    if (new Set(targets).size !== targets.length) {
      throw new Error("URL param mapping targets must be unique")
    }
  }
}
const makeHref = (
  byName: Map<string, ReturnType<typeof screenDefinitions>[number]>,
  entries: Record<string, Registration>,
) => {
  const href = (contract: { name: string }, params: Record<string, string | undefined> = {}) => {
    const definition = byName.get(contract.name)
    const entry = entries[contract.name]
    if (!definition || entry === undefined || !matchesContract(definition, contract)) {
      throw new Error(`Screen "${contract.name}" must use the app's registered contract`)
    }
    if (typeof entry !== "string" && "encode" in entry) {
      return entry.encode(params)
    }
    const mapping = mapOf(entry)
    const values = Object.fromEntries(
      Object.entries(params).map(([key, value]) => [mapping[key] ?? key, value]),
    )
    const path = pathOf(entry).replace(/:([^/]+)/g, (_, key: string) => {
      const value = values[key]
      if (value === undefined) {
        throw new Error(`Missing route param "${key}"`)
      }
      return encodeURIComponent(value)
    })
    const used = new Set(
      pathOf(entry)
        .split("/")
        .filter((part) => part.startsWith(":"))
        .map((part) => part.slice(1)),
    )
    const query = new URLSearchParams(
      Object.entries(values).filter(([key, value]) => !used.has(key) && value !== undefined) as [
        string,
        string,
      ][],
    ).toString()
    return path + (query ? `?${query}` : "")
  }
  return href
}
const loadRoute = async (lazy: NonNullable<RouteObject["lazy"]>) => {
  if (typeof lazy === "function") {
    return lazy()
  }
  return Object.fromEntries(
    await Promise.all(Object.entries(lazy).map(async ([key, load]) => [key, await load()])),
  ) as RouteObject
}
/** Bind the app once; the host owns navigation, Reflex owns entry resources. */
export function createReflexRouter<A extends App, const R>(
  app: A,
  registration: R & ValidateRoutes<A, NoInfer<R>>,
): RouterBinding<A> {
  const entries = registration as Record<string, Registration>
  const screens = screenDefinitions(app)
  const byName = new Map(screens.map((d) => [d.name, d]))
  validateRegistration(screens, entries)
  const bound = createReflex(app)
  const href = makeHref(byName, entries)
  return {
    ...bound,
    href,
    // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope binding factory.
    Link: ({ to, params, ...props }: { to: { name: string }; params?: Record<string, string> }) => (
      <HostLink {...props} to={href(to, params)} />
    ),
    routes: (views: Record<string, HostRouteOptions>) =>
      screens.map((definition) => {
        const entry = entries[definition.name]
        const options = views[definition.name]
        if (!entry || !options) {
          throw new Error(`${definition.name} needs a rendering source`)
        }
        const wrap = (element: React.ReactNode) => (
          <RouteScreen definition={definition} entry={entry} fallback={options.errorElement}>
            {element}
          </RouteScreen>
        )
        const { Component, element, lazy, ...rest } = options as HostRouteOptions & {
          Component?: React.ComponentType
          element?: React.ReactNode
          lazy?: NonNullable<RouteObject["lazy"]>
        }
        if (lazy) {
          return {
            ...rest,
            path: pathOf(entry),
            errorElement: options.errorElement ?? <p>Could not load {definition.name}</p>,
            lazy: async () => {
              const result = await loadRoute(lazy)
              const View = result.Component
              return {
                ...result,
                Component: undefined,
                element: wrap(View ? <View /> : result.element),
              }
            },
          } as RouteObject
        }
        return {
          ...rest,
          path: pathOf(entry),
          element: wrap(Component ? <Component /> : element),
          errorElement: options.errorElement ?? <p>Could not load {definition.name}</p>,
        } as RouteObject
      }),
  } as unknown as RouterBinding<A>
}
