import * as React from "react"
import { ErrorCode, ProtocolError } from "@reflex/protocol"
import {
  APP_HOST_ADAPTER,
  definitionIdentity,
  mountSessionRoute,
  reportUnobserved,
  type AppHost,
  type Runtime,
  type ConsumerDefinition,
  type NodeHandle,
  type ActionOutcome,
} from "@reflex/runtime/internal"
import { developmentBridge } from "@reflex/live/dev"
import {
  SessionProvider,
  useBoundSession,
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
const published = (work: Promise<ActionOutcome<unknown>>, runtime: Runtime, label: string) =>
  reportUnobserved(
    work.then((result) => {
      if (result.status === "domain-error") {
        return { status: "error" as const, error: result.error.data }
      }
      if (result.status === "defect") {
        return { status: "defect" as const, message: result.error.message }
      }
      return result
    }),
    (error) => runtime.report(error),
    (result) =>
      result.status === "error"
        ? new Error(`${label}: ${JSON.stringify(result.error)}`)
        : undefined,
  )
export const usePublishedView = (
  node: NodeHandle<unknown, Calls> | null,
): NodeView<ConsumerDefinition<unknown, Calls>> => {
  const { runtime } = useRuntimeSession()
  const view = useNodeView(node)
  const actions = React.useMemo(
    () =>
      view.status === "ready"
        ? Object.fromEntries(
            Object.entries(view.actions).map(([name, action]) => [
              name,
              {
                ...action,
                run: (...args: never[]) =>
                  published(action.run(...args), runtime, `${node?.name}.${name}`),
              },
            ]),
          )
        : null,
    [view.actions, view.status, runtime, node],
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
export const useSelectedNode = (
  definition: Definition,
  suspense: boolean,
  route?: RouteLocation | null,
  identity: object = definition,
  focused = true,
) => {
  const { runtime } = useRuntimeSession()
  const context = React.useContext(RouteContext)
  const location = route === undefined ? context : route
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
      identity,
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
      suspense,
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
  useNodeFocus(node, location !== null && focused)
  return { node, snapshot, lease }
}
export type Selection = (
  contract: { name: string },
  suspense: boolean,
) => ReturnType<typeof useSelectedNode>
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
const useView = (selected: ReturnType<typeof useSelectedNode>) => {
  const view = usePublishedView(selected.node)
  if (selected.snapshot?.status === "error") {
    return {
      status: "error" as const,
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
const featureBinding = (contract: { name: string }, select: Selection) => ({
  useScreen: () => useView(select(contract, true)),
  useScreenStatus: () => useView(select(contract, false)),
  useNodeState: (selector: (state: unknown) => unknown) =>
    useSelectedState(select(contract, true).node, selector),
  useAction: (name: string) => {
    const { node } = select(contract, true)
    const action = useAction(node, name)
    const { runtime } = useRuntimeSession()
    return React.useMemo(
      () => ({
        ...action,
        run: (...args: never[]) =>
          published(action.run(...args), runtime, `${contract.name}.${name}`),
      }),
      [action, runtime, name],
    )
  },
})
/** App-bound hooks are created once at module scope. */
export function createReflex<A extends App>(app: A): ReflexBinding<A> {
  return createBinding(app)
}
export function createBinding<A extends App>(
  app: A,
  useHostSelection?: Selection,
): ReflexBinding<A> {
  const host = appHost(app)
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit app binding factory, called once at module scope.
  const useSession = () => useBoundSession(host)
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
    if (
      definition["~reflex"].contract !== undefined &&
      definition["~reflex"].contract !== contract &&
      "~reflex" in contract
    ) {
      throw new Error(
        `Pass the contract \`${contract.name}\` from screens.ts, not its implementation`,
      )
    }
    if (!matchesContract(definition, contract)) {
      throw new Error(`Screen "${contract.name}" must use the app's registered contract`)
    }
    return definition
  }
  const select =
    useHostSelection ?? ((contract, suspense) => useSelectedNode(resolve(contract), suspense))
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope binding factory.
  const useSelection: Selection = (contract, suspense) => {
    useSession()
    return select(contract, suspense)
  }
  // biome-ignore lint/correctness/noComponentHookFactories: Explicit module-scope binding factory.
  const useServiceStatus = (definition: Definition) => {
    useSession()
    if (services.get(definition.name) !== definition) {
      throw new Error(`${definition.name} is not a service of app '${app.name}'`)
    }
    return usePublishedView(useNodeHandle(definition))
  }
  return {
    withApp: (next: A) => {
      if (definitionIdentity(appHost(next)) !== definitionIdentity(host)) {
        throw new Error(`Provider app must be a withScenarios variant of '${app.name}'`)
      }
      return createBinding(next, useHostSelection)
    },
    useSession,
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
      return <SessionProvider {...props} host={target} bridge={ownedBridge} />
    },
    useScreen: (contract: { name: string }) => useView(useSelection(contract, true)),
    useScreenStatus: (contract: { name: string }) => useView(useSelection(contract, false)),
    useServiceStatus,
    useService: (definition: Definition) => {
      useSession()
      if (services.get(definition.name) !== definition) {
        throw new Error(`${definition.name} is not a service of app '${app.name}'`)
      }
      return usePublishedView(useSelectedNode(definition, true, null).node)
    },
    from: (contract: { name: string }) => {
      resolve(contract)
      return featureBinding(contract, useSelection)
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
