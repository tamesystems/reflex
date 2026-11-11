import * as React from "react"
import { ErrorCode, ProtocolError } from "@reflex/protocol"
import {
  APP_HOST_ADAPTER,
  definitionIdentity,
  mountSessionRoute,
  type AppHost,
  type Runtime,
  type ConsumerDefinition,
  type NodeHandle,
  type ActionOutcome,
} from "@reflex/runtime/internal"
import { developmentBridge } from "@reflex/live/dev"
import {
  ReflexProvider,
  createLegacyReflex,
  useRouteLease,
  useNodeFocus,
  useNodeView,
  useRuntimeSession,
  useNodeHandle,
  useAction,
} from "./react.tsx"
import type { App, ReflexBinding, NodeView } from "./binding-types.ts"

type Calls = Record<string, (...args: never[]) => Promise<ActionOutcome<unknown>>>
type Definition = ConsumerDefinition<unknown, Calls> & {
  resolve(
    runtime: Runtime,
    id?: import("@reflex/protocol").NodeId,
  ): NodeHandle<unknown, Calls> | undefined
}
export interface RouteLocation {
  readonly key: string
  readonly contract: object
  readonly params: unknown
  readonly navigationType: "POP" | "PUSH" | "REPLACE"
}
export const RouteContext = React.createContext<RouteLocation | null>(null)
export const useRouteRetry = (): (() => Promise<void>) => {
  const retry = React.useContext(RetryContext)
  return retry ?? (async () => undefined)
}
const RetryContext = React.createContext<(() => Promise<void>) | null>(null)
export const RouteRetryProvider = RetryContext.Provider
const definitions = (value: unknown): Definition[] => {
  if (value == null) {
    return []
  }
  if (Array.isArray(value)) {
    return value as Definition[]
  }
  if (typeof value === "object" && "name" in value) {
    return [value as Definition]
  }
  return Object.values(value as Record<string, Definition>)
}
export const appHost = (app: App): AppHost =>
  APP_HOST_ADAPTER in app ? (app[APP_HOST_ADAPTER] as AppHost) : (app as AppHost)
export const screenDefinitions = (app: App) => definitions(app.screens)
export const matchesContract = (definition: ConsumerDefinition, contract: object) =>
  definition === contract ||
  (definition["~reflex"].contract === undefined
    ? definitionIdentity(definition) === definitionIdentity(contract)
    : definition["~reflex"].contract === contract)
const published = async (work: Promise<ActionOutcome<unknown>>) => {
  const result = await work
  if (result.status === "domain-error") {
    return { status: "error" as const, error: result.error.data }
  }
  if (result.status === "defect") {
    return { status: "defect" as const, message: result.error.message }
  }
  return result
}
const usePublishedView = (
  node: NodeHandle<unknown, Calls> | null,
): NodeView<ConsumerDefinition<unknown, Calls>> => {
  const view = useNodeView(node)
  const actions = React.useMemo(
    () =>
      view.status === "ready"
        ? Object.fromEntries(
            Object.entries(view.actions).map(([name, action]) => [
              name,
              { ...action, run: (...args: never[]) => published(action.run(...args)) },
            ]),
          )
        : null,
    [view.actions, view.status],
  )
  return view.status === "pending"
    ? view
    : ({ ...view, actions } as NodeView<ConsumerDefinition<unknown, Calls>>)
}
const resolveOptional = (definition: Definition, runtime: Runtime) => {
  try {
    return definition.resolve(runtime)
  } catch (error) {
    if (error instanceof ProtocolError && error.code === ErrorCode.NodeNotFound) {
      return undefined
    }
    throw error
  }
}
const waitForNode = (runtime: Runtime, definition: Definition, signal?: AbortSignal) =>
  new Promise<{ id: import("@reflex/protocol").NodeId; dispose(): void }>((resolve, reject) => {
    let stop: () => void = () => undefined as undefined
    const abort = () => {
      stop()
      reject(signal?.reason)
    }
    const check = () => {
      const node = resolveOptional(definition, runtime)
      if (node) {
        stop()
        signal?.removeEventListener("abort", abort)
        resolve({ id: node.id, dispose: () => undefined })
      }
    }
    if (signal?.aborted) {
      abort()
      return
    }
    stop = runtime.subscribe(check)
    signal?.addEventListener("abort", abort, { once: true })
    check()
  })
const useSelectedNode = (definition: Definition, suspense: boolean) => {
  const { runtime } = useRuntimeSession()
  const location = React.useContext(RouteContext)
  const ambientDefinition = React.useMemo(
    () => ({
      resolve: (runtime: Runtime) =>
        location === null ? resolveOptional(definition, runtime) : undefined,
    }),
    [definition, location],
  )
  const ambient = useNodeHandle(ambientDefinition)
  const lease = useRouteLease(
    {
      identity: definition,
      mount: (_, signal) =>
        location === null
          ? waitForNode(runtime, definition, signal)
          : mountSessionRoute(runtime, definition, location.params, signal),
    },
    {
      key: location?.key ?? `ambient/${definition.name}`,
      lifetime: location === null ? "component" : "history-entry",
      navigationType: location?.navigationType ?? "POP",
      params: location?.params,
      enabled: location !== null || ambient === null,
    },
  )
  const snapshot = React.useSyncExternalStore(
    lease?.subscribe ?? (() => () => undefined),
    lease?.getSnapshot ?? (() => null),
  )
  const owned =
    suspense && lease
      ? React.use(lease.ready)
      : snapshot?.status === "ready"
        ? snapshot.value
        : null
  const node =
    lease === null ? ambient : owned ? (definition.resolve(runtime, owned.id) ?? null) : null
  useNodeFocus(node, location !== null)
  return { node, snapshot, lease }
}
const useSelectedState = (
  node: NodeHandle<unknown, Calls> | null,
  selector: (state: unknown) => unknown,
) => {
  const getSelected = React.useMemo(() => {
    let cached: { state: unknown; selected: unknown } | undefined
    return () => {
      const state = node?.getSnapshot()
      if (!cached || cached.state !== state) {
        cached = { state, selected: selector(state) }
      }
      return cached.selected
    }
  }, [node, selector])
  return React.useSyncExternalStore(node?.subscribe ?? (() => () => undefined), getSelected)
}
const featureBinding = (
  definition: Definition,
  legacy: { useSession(): unknown },
  resolve: (contract: { name: string }) => Definition,
  useScreen: (contract: { name: string }) => unknown,
  useScreenStatus: (contract: { name: string }) => unknown,
) => {
  return {
    useScreen: () => useScreen(definition),
    useScreenStatus: () => useScreenStatus(definition),
    useNodeState: (selector: (state: unknown) => unknown) => {
      legacy.useSession()
      const { node } = useSelectedNode(resolve(definition), true)
      return useSelectedState(node, selector)
    },
    useAction: (name: string) => {
      legacy.useSession()
      const { node } = useSelectedNode(resolve(definition), true)
      const action = useAction(node, name)
      return { ...action, run: (...args: never[]) => published(action.run(...args)) }
    },
  }
}
/** App-bound hooks are created once at module scope. */
export function createReflex<A extends App>(app: A): ReflexBinding<A> {
  const host = appHost(app)
  const legacy = createLegacyReflex(host)
  const screens = new Map(screenDefinitions(app).map((d) => [d.name, d]))
  const services = new Map(
    definitions(app.services ?? (host as AppHost & { nodes?: unknown }).nodes)
      .filter((d) => !screens.has(d.name))
      .map((d) => [d.name, d]),
  )
  const resolve = (contract: { name: string }) => {
    const definition = screens.get(contract.name)
    if (!definition) {
      throw new Error(`${contract.name} is not a screen of app '${app.name}'`)
    }
    if (!matchesContract(definition, contract)) {
      throw new Error(`Screen "${contract.name}" must use the app's registered contract`)
    }
    return definition
  }
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit app binding factory, called once at module scope.
  const useScreenStatus = (contract: { name: string }) => {
    legacy.useSession()
    const selected = useSelectedNode(resolve(contract), false)
    const view = usePublishedView(selected.node)
    if (selected.snapshot?.status === "error") {
      return {
        status: "error",
        state: null,
        actions: null,
        error: selected.snapshot.error,
        retry: async () => {
          await selected.lease?.retry()
        },
      }
    }
    return view
  }
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit app binding factory, called once at module scope.
  const useScreen = (contract: { name: string }) => {
    legacy.useSession()
    const { node } = useSelectedNode(resolve(contract), true)
    return usePublishedView(node)
  }
  return {
    ...legacy,
    // biome-ignore lint/correctness/noComponentHookFactories: Explicit app binding factory, called once at module scope.
    Provider: ({
      app: provided,
      bridge,
      ...props
    }: React.ComponentProps<ReflexBinding<A>["Provider"]>) => {
      const target = provided === undefined ? host : appHost(provided as A)
      if (definitionIdentity(target) !== definitionIdentity(host)) {
        throw new Error(`Provider app must be a withScenarios variant of '${app.name}'`)
      }
      const ownedBridge = React.useMemo(
        () => (bridge === "development" ? developmentBridge() : bridge),
        [bridge],
      )
      return <ReflexProvider {...props} host={target} bridge={ownedBridge} />
    },
    useScreen,
    useScreenStatus,
    useScreenSuspense: useScreen,
    useService: (definition: Definition) => {
      legacy.useSession()
      if (services.get(definition.name) !== definition) {
        throw new Error(`${definition.name} is not a service of app '${app.name}'`)
      }
      return usePublishedView(useNodeHandle(definition))
    },
    from: (definition: Definition) => {
      if (screens.get(definition.name) !== definition) {
        throw new Error(
          `from requires the registered definition of ${definition.name} in app '${app.name}'`,
        )
      }
      return featureBinding(definition, legacy, resolve, useScreen, useScreenStatus)
    },
  } as unknown as ReflexBinding<A>
}

export interface RouteAdapter {
  useLocation(): RouteLocation
  project?(stack: readonly object[]): void
}
export function createRouteAdapter<A extends App>(
  _binding: ReflexBinding<A>,
  adapter: RouteAdapter,
) {
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope host binding factory.
  return function RouteAdapterProvider({ children }: { children?: React.ReactNode }) {
    return <RouteContext.Provider value={adapter.useLocation()}>{children}</RouteContext.Provider>
  }
}
