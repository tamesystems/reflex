import * as React from "react"
import {
  Link as HostLink,
  useLocalSearchParams,
  useRoute,
  useIsFocused,
  type Href,
} from "expo-router"
import {
  createBinding,
  validateRouteKeys,
  screenDefinitions,
  matchesContract,
  useSelectedNode,
  useRuntimeSession,
  findRouteNode,
  type App,
  type Contract,
  type Screens,
  type URLParams,
  type ReflexBinding,
  type ValidateRoutes,
  type RouteCodec,
} from "@reflex/react/internal"
import { isRecord, type Json } from "@reflex/protocol"
import { RouterProjection, routeParam } from "./react.tsx"
import { ROUTE_MAPPING, NODE_PARAM } from "./route-token.ts"
import { stackReader } from "@reflex/navigation"

type Registration =
  | RouteCodec<Record<string, string | undefined>>
  | string
  | {
      readonly pathname: string
      readonly params?: Readonly<Record<string, string>>
    }
type Args<C> = C extends unknown
  ? [contract: C, ...params: keyof URLParams<C> extends never ? [] : [params: URLParams<C>]]
  : never
type LinkProps<C> = C extends unknown
  ? { to: C } & (keyof URLParams<C> extends never ? { params?: never } : { params: URLParams<C> }) &
      Omit<React.ComponentProps<typeof HostLink>, "href" | "to" | "params">
  : never
export interface ExpoBinding<A extends App> extends ReflexBinding<A> {
  href(...args: Args<Contract<Screens<A>>>): Href
  Link(props: LinkProps<Contract<Screens<A>>>): React.ReactElement
}
const pathOf = (entry: Registration) =>
  typeof entry === "string" ? entry : "path" in entry ? entry.path : entry.pathname
const mapOf = (entry: Registration) =>
  typeof entry === "string" || !("params" in entry) ? {} : (entry.params ?? {})

type HostPath = Extract<Href, { pathname: unknown }>["pathname"]
type HostRoutes<R> = {
  [K in keyof R]: R[K] extends string
    ? R[K] extends HostPath
      ? unknown
      : { readonly "Pathname must be an Expo typed route": never }
    : R[K] extends { pathname: infer P }
      ? P extends HostPath
        ? unknown
        : { readonly "Pathname must be an Expo typed route": never }
      : unknown
}

/** Bind one descriptor to Expo's file routes; the core projection remains authoritative. */
export function createReflexExpo<A extends App, const R>(
  app: A,
  registration: R & ValidateRoutes<A, NoInfer<R>> & HostRoutes<NoInfer<R>>,
): ExpoBinding<A> {
  const { definitions, entryFor, resolve, encoded, href, routes } = createRoutes(app, registration)
  const useView = createView(definitions, entryFor, resolve, encoded)
  const bound = createBinding(app, useView)
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope binding factory.
  const Projection = () => {
    const session = useRuntimeSession()
    return session.runtime.stateOf("Navigation") === undefined ? null : (
      <RouterProjection routes={routes} />
    )
  }
  return {
    ...bound,
    withApp: (next: A) => {
      bound.withApp(next)
      return createReflexExpo(next, registration)
    },
    // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope binding factory.
    Provider: ({ children, ...props }: React.ComponentProps<typeof bound.Provider>) => (
      <bound.Provider {...props}>
        <Projection />
        {children}
      </bound.Provider>
    ),
    href,
    // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope binding factory.
    Link: ({ to, params, ...props }: { to: { name: string }; params?: Record<string, string> }) => (
      <HostLink {...props} href={href(to, params)} />
    ),
  } as unknown as ExpoBinding<A>
}

function createRoutes(app: App, registration: unknown) {
  const definitions = screenDefinitions(app)
  const entries = registration as Record<string, Registration>
  validateRouteKeys(
    definitions.map((d) => d.name),
    entries,
  )
  const entryFor = (name: string) => {
    const entry = entries[name]
    if (entry === undefined) {
      throw new Error(`${name} needs a route registration`)
    }
    return entry
  }
  const resolve = (contract: { name: string }) => {
    const definition = definitions.find((d) => d.name === contract.name)
    if (
      definition?.["~reflex"].contract !== undefined &&
      definition["~reflex"].contract !== contract &&
      "~reflex" in contract
    ) {
      throw new Error(
        `Pass the contract \`${contract.name}\` from screens.ts, not its implementation`,
      )
    }
    if (!definition || !matchesContract(definition, contract)) {
      throw new Error(`Screen "${contract.name}" must use the app's registered contract`)
    }
    return definition
  }
  const fields = new Map(
    definitions.map((definition) => [
      definition.name,
      validateEntry(definition, entryFor(definition.name)),
    ]),
  )
  const encoded = (name: string, raw: Record<string, string | readonly string[] | undefined>) =>
    encodedParams(entryFor(name), name, raw, fields.get(name))
  const href = (contract: { name: string }, params: Record<string, string> = {}): Href => {
    const definition = resolve(contract)
    definition["~reflex"].decodeParams?.(params)
    const entry = entryFor(contract.name)
    if (typeof entry !== "string" && "encode" in entry) {
      return entry.encode(params) as Href
    }
    const mapping = mapOf(entry)
    return {
      pathname: pathOf(entry),
      params: Object.fromEntries(
        Object.entries(params).map(([key, value]) => [mapping[key] ?? key, value]),
      ),
    } as Href
  }
  const routes = {
    [ROUTE_MAPPING]: {
      toHref: ({ route, params }: { route: string; params: Json }) =>
        projectionHref(
          href(
            (definitions.find((d) => d.name === route)?.["~reflex"].contract ??
              definitions.find((d) => d.name === route)) as { name: string },
            params as Record<string, string>,
          ),
        ),
      fromLocation: (
        segments: readonly string[],
        raw: Record<string, string | readonly string[] | undefined>,
      ) => {
        const definition = definitions.find(
          (d) => pathOf(entryFor(d.name)) === `/${segments.join("/")}`,
        )
        if (!definition) {
          return null
        }
        const params = encoded(definition.name, raw)
        definition["~reflex"].decodeParams?.(params)
        return { route: definition.name, params: params as Json }
      },
    },
  }
  return { definitions, entryFor, resolve, encoded, href, routes }
}

function createView(
  definitions: ReturnType<typeof screenDefinitions>,
  entryFor: (name: string) => Registration,
  resolve: ReturnType<typeof createRoutes>["resolve"],
  encoded: ReturnType<typeof createRoutes>["encoded"],
) {
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope binding factory.
  const useView = (contract: { name: string }, suspense: boolean) => {
    const session = useRuntimeSession()
    const raw = useLocalSearchParams()
    const route = useRoute()
    const focused = useIsFocused()
    const pathname = route.name === "index" ? "/" : `/${route.name}`
    const expected = definitions.find((d) => pathOf(entryFor(d.name)) === pathname)
    if (expected && expected.name !== contract.name) {
      throw new Error(
        `Route ${route.key} (${pathname}) expected ${expected.name}, received ${contract.name}`,
      )
    }
    const definition = resolve(contract)
    const paramsKey = JSON.stringify(encoded(contract.name, raw))
    const params = React.useMemo(() => JSON.parse(paramsKey), [paramsKey])
    const token = routeParam(raw[NODE_PARAM])
    const navigates = session.runtime.stateOf("Navigation") !== undefined
    const selectedDefinition = React.useMemo(
      () =>
        navigates
          ? {
              ...definition,
              resolve: (runtime: typeof session.runtime) =>
                findRouteNode({
                  stack: stackReader(session)(),
                  token,
                  params,
                  resolve: (id) => definition.resolve(runtime, id),
                }) ?? undefined,
            }
          : definition,
      [definition, session, navigates, token, params],
    )
    const selected = useSelectedNode(
      selectedDefinition,
      suspense,
      navigates
        ? null
        : {
            key: route.key,
            contract: definition,
            params: definition["~reflex"].decodeParams?.(params) ?? params,
            navigationType: "POP",
          },
      definition,
      focused,
    )
    return selected
  }
  return useView
}

function validateEntry(
  definition: ReturnType<typeof screenDefinitions>[number],
  entry: Registration,
) {
  if (typeof entry !== "string" && "decode" in entry) {
    return undefined
  }
  const path = pathOf(entry)
  if (/[()*?]|\.\.\./.test(path)) {
    throw new Error("Excluded route grammar; use routeCodec")
  }
  const placeholders = [...path.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])
  if (new Set(placeholders).size !== placeholders.length) {
    throw new Error("Repeated path placeholder")
  }
  const schema = definition["~reflex"].paramsSchema?.()
  const properties = schema && isRecord(schema.properties) ? schema.properties : undefined
  const mapping = mapOf(entry)
  const fields = properties ? Object.keys(properties) : undefined
  const targets = (fields ?? Object.keys(mapping)).map((field) => mapping[field] ?? field)
  if (new Set(targets).size !== targets.length) {
    throw new Error("URL param mapping targets must be unique")
  }
  if (!properties) {
    return fields
  }
  for (const [field, spec] of Object.entries(properties)) {
    if (!isRecord(spec) || spec.type !== "string") {
      throw new Error(`URL param ${field} must encode a string; use a string codec`)
    }
    const target = mapping[field] ?? field
    const required = Array.isArray(schema?.required) && schema.required.includes(field)
    if (required && !placeholders.includes(target)) {
      throw new Error(`Required route param ${field} must appear as a path placeholder`)
    }
    if (!required && placeholders.includes(target)) {
      throw new Error(`Optional route param ${field} cannot be a path placeholder`)
    }
  }
  for (const field of Object.keys(mapping)) {
    if (!(field in properties)) {
      throw new Error("URL param mapping names must be schema fields")
    }
  }
  for (const placeholder of placeholders) {
    if (!targets.includes(placeholder ?? "")) {
      throw new Error(`Path placeholder ${placeholder} has no matching param; add a params mapping`)
    }
  }
  return fields
}

function projectionHref(href: Href): { pathname: string; params?: Record<string, string> } {
  if (typeof href !== "string") {
    return href as { pathname: string; params?: Record<string, string> }
  }
  const url = new URL(href, "http://reflex.invalid")
  return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) }
}

function encodedParams(
  entry: Registration,
  name: string,
  raw: Record<string, string | readonly string[] | undefined>,
  fields: string[] | undefined,
) {
  if (typeof entry !== "string" && "decode" in entry) {
    return entry.decode(raw as Record<string, string | string[] | undefined>)
  }
  const reverse = Object.fromEntries(
    Object.entries(mapOf(entry)).map(([core, file]) => [file, core]),
  )
  return Object.fromEntries(
    Object.entries(raw)
      .filter(
        ([key, value]) =>
          key !== NODE_PARAM &&
          value !== undefined &&
          (fields?.includes(reverse[key] ?? key) ?? true),
      )
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          throw new Error(`Route ${name} param ${key} is an array; use routeCodec`)
        }
        return [reverse[key] ?? key, routeParam(value) ?? undefined]
      }),
  )
}
