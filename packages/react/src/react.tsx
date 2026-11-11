import { assertNever, ErrorCode, ProtocolError, type NodeId } from "@reflex/protocol"
import {
  createRouteRegistry,
  type RouteLease,
  type BackgroundReporter,
  type ActionOutcome,
  type ScenarioName,
  type AppHost,
  type AppSession,
  type Runtime,
  definitionIdentity,
  systemTimers,
} from "@reflex/runtime/internal"
import {
  type Bridge,
  reportFocus,
  createLiveController,
  LiveSessions,
  reportFailure,
} from "@reflex/live/session"
import * as React from "react"
const SessionContext = React.createContext<AppSession | null>(null)

export const useRuntimeSession = (): AppSession => {
  const session = React.useContext(SessionContext)
  if (session === null) {
    throw new Error("useSession requires the app's <Provider>")
  }
  return session
}

const ControlsContext = React.createContext<{
  readonly host: AppHost
  readonly scenario: string
  readonly status: "starting" | "live" | "failed" | "closed"
  reset(scenario?: string): Promise<unknown>
} | null>(null)
/** Session controls; raw registry access is an explicit advanced import. */
export const useBoundSession = <H extends AppHost>(host: H): SessionControls<H> => {
  const controls = React.useContext(ControlsContext)
  if (controls === null) {
    throw new Error("useSession requires the app's <Provider>")
  }
  if (definitionIdentity(controls.host) !== definitionIdentity(host)) {
    throw new Error(
      `useSession is bound to app "${host.name}" but the provider owns "${controls.host.name}"`,
    )
  }
  return controls as unknown as SessionControls<H>
}
export interface SessionControls<H extends AppHost> {
  readonly scenario: ScenarioName<H>
  readonly status: "starting" | "live" | "failed" | "closed"
  reset(scenario?: ScenarioName<H>): Promise<SessionControls<H>>
}
const sessionControls = <H extends AppHost>(
  sessions: LiveSessions,
  settled?: {
    readonly scenario: string
    readonly generation: string
  },
  defaultScenario = "default",
): SessionControls<H> => {
  const snapshot = sessions.getSnapshot()
  const generation =
    settled?.generation ??
    (snapshot.kind === "live" ? snapshot.session.runtime.sessionId : snapshot)
  const scenarioName = settled?.scenario ?? sessions.scenario ?? defaultScenario
  return {
    scenario: scenarioName as ScenarioName<H>,
    status: settled ? "live" : snapshot.kind,
    reset: async (scenario) => {
      const current = sessions.getSnapshot()
      const active = current.kind === "live" ? current.session.runtime.sessionId : current
      if (active !== generation) {
        throw new ProtocolError(
          ErrorCode.StaleSession,
          "SessionChanged: reacquire controls after reset",
        )
      }
      const nextScenario = scenario ?? scenarioName ?? undefined
      const result = await sessions.reset(nextScenario)
      if (result.kind === "failed") {
        throw result.cause
      }
      return sessionControls<H>(sessions, {
        scenario: nextScenario ?? "default",
        generation: result.session.runtime.sessionId,
      })
    },
  }
}
export const useRuntime = (): Runtime => useRuntimeSession().runtime

export type { Bridge } from "@reflex/live/session"

/**
 * Owns one session. Replacing it unmounts everything beneath, so that nothing
 * can outlive it holding a disposed node. A session that cannot start is thrown
 * during render, for the nearest error boundary.
 *
 * With `bridge`, the protocol is served to it for as long as this is mounted, against
 * the session on screen. A bridge's reset replaces that session, until `scenario` or
 * `host` next changes.
 */
export const SessionProvider = <H extends AppHost>({
  host,
  scenario,
  bridge,
  fallback = null,
  onBackgroundError = reportFailure,
  children,
}: {
  readonly host: H
  readonly scenario?: NoInfer<ScenarioName<H>>
  readonly bridge?: Bridge | undefined
  readonly fallback?: React.ReactNode
  readonly onBackgroundError?: BackgroundReporter
  readonly children?: React.ReactNode
}) => {
  const [sessions] = React.useState(
    () => new LiveSessions({ timers: systemTimers, onBackgroundError }),
  )
  const lifecycle = React.useSyncExternalStore(sessions.subscribe, sessions.getSnapshot)
  const ownedHost = React.useMemo(() => ownHost(host), [host])
  React.useEffect(() => sessions.open(ownedHost, scenario), [sessions, ownedHost, scenario])
  React.useEffect(() => {
    if (bridge === undefined) {
      return undefined
    }
    const controller = createLiveController(sessions, onBackgroundError)
    const stop = bridge(controller)
    return () => {
      stop()
      controller.close().catch(onBackgroundError)
    }
  }, [sessions, bridge, onBackgroundError])

  return (
    <ControlsContext.Provider
      value={{ host, ...sessionControls(sessions, undefined, scenario ?? host.defaultScenario) }}
    >
      <SessionGate lifecycle={lifecycle} fallback={fallback}>
        {children}
      </SessionGate>
    </ControlsContext.Provider>
  )
}
const SessionGate = ({
  lifecycle,
  fallback,
  children,
}: {
  readonly lifecycle: ReturnType<LiveSessions["getSnapshot"]>
  readonly fallback: React.ReactNode
  readonly children: React.ReactNode
}) => {
  switch (lifecycle.kind) {
    case "starting":
      return <>{fallback}</>
    case "failed":
      throw lifecycle.cause
    case "live":
      return (
        <SessionContext.Provider
          key={lifecycle.session.runtime.sessionId}
          value={lifecycle.session}
        >
          <OwnedNodes>{children}</OwnedNodes>
        </SessionContext.Provider>
      )
    default:
      return assertNever(lifecycle)
  }
}

const noSubscription = () => () => undefined

/** The part of a node a subscriber needs. */
export interface StateSource<S> {
  getSnapshot(): S
  subscribe(listener: () => void): () => void
}

/** Subscribe to a node the way any external store is subscribed to. */
export function useNodeState<S>(node: StateSource<S>): S
export function useNodeState<S>(node: StateSource<S> | null): S | null
export function useNodeState<S>(node: StateSource<S> | null): S | null {
  return React.useSyncExternalStore(
    node?.subscribe ?? noSubscription,
    () => node?.getSnapshot() ?? null,
  )
}

/** Report focus from an existing router; cleanup never clears a newer screen's focus. */
export const useNodeFocus = (node: { readonly id: NodeId } | null, focused: boolean): void => {
  const nodeId = node?.id ?? null
  const { runtime } = useRuntimeSession()
  React.useEffect(() => {
    if (!focused || nodeId === null) {
      return undefined
    }
    return reportFocus(runtime, nodeId)
  }, [runtime, nodeId, focused])
}

/** Subscribe to the definition's guard and retain the latest typed action outcome. */
export const useAction = <
  A extends Record<string, (...args: never[]) => Promise<ActionOutcome<unknown>>>,
  K extends keyof A & string,
>(
  node: {
    readonly actions: A
    subscribe(listener: () => void): () => void
    subscribeAvailability(listener: () => void): () => void
    availability(action: keyof A & string): true | string
  } | null,
  action: K,
) => {
  const verdict = React.useSyncExternalStore(
    node?.subscribeAvailability ?? noSubscription,
    () => node?.availability(action) ?? "Screen is not mounted",
  )
  type Outcome = Awaited<ReturnType<A[K]>>
  const [state, setState] = React.useState<{
    node: typeof node
    action: K
    pending: number
    outcome: Outcome | null
  }>({ node, action, pending: 0, outcome: null })
  const current =
    state.node === node && state.action === action ? state : { pending: 0, outcome: null }
  const run = React.useCallback(
    async (...args: Parameters<A[K]>): Promise<Awaited<ReturnType<A[K]>>> => {
      if (node === null) {
        const outcome = {
          status: "refused",
          code: ErrorCode.NodeNotFound,
          reason: "Screen is not mounted",
        } as Outcome
        setState({ node, action, pending: 0, outcome })
        return outcome
      }
      setState((previous) =>
        previous.node === node && previous.action === action
          ? { ...previous, pending: previous.pending + 1 }
          : { node, action, pending: 1, outcome: null },
      )
      try {
        const invoke = node.actions[action]
        if (invoke === undefined) {
          throw new Error(`Unknown action "${action}"`)
        }
        const result = (await invoke(...args)) as Awaited<ReturnType<A[K]>>
        setState((previous) =>
          previous.node === node && previous.action === action
            ? { ...previous, outcome: result }
            : previous,
        )
        return result
      } finally {
        setState((previous) =>
          previous.node === node && previous.action === action
            ? { ...previous, pending: previous.pending - 1 }
            : previous,
        )
      }
    },
    [node, action],
  )
  return React.useMemo(
    () => ({
      run,
      pending: current.pending > 0,
      available: verdict === true,
      reason: verdict === true ? null : verdict,
      outcome: current.outcome,
    }),
    [run, current.pending, current.outcome, verdict],
  )
}

/** Resolve a definition mounted by the app, retaining its exact consumer contract. */
export const useNodeHandle = <N,>(definition: {
  resolve(runtime: Runtime): N | undefined
}): N | null => {
  const { runtime } = useRuntimeSession()
  return React.useSyncExternalStore(
    React.useCallback((listener) => runtime.subscribe(() => listener()), [runtime]),
    () => definition.resolve(runtime) ?? null,
  )
}

interface OwnedNode {
  dispose(): void
}
type OwnedFactory = (params: unknown, signal: AbortSignal) => OwnedNode | Promise<OwnedNode>
interface RouteOwnership {
  readonly factories: Map<object, OwnedFactory>
  readonly registry: ReturnType<typeof createRouteRegistry<OwnedNode>>
}
const runtimeRoutes = new WeakMap<Runtime, RouteOwnership>()
const routesForRuntime = (runtime: Runtime): RouteOwnership => {
  let owner = runtimeRoutes.get(runtime)
  if (owner === undefined) {
    const factories = new Map<object, OwnedFactory>()
    owner = {
      factories,
      registry: createRouteRegistry(factories, (error) => runtime.report(error)),
    }
    runtimeRoutes.set(runtime, owner)
  }
  return owner
}
const ownHost = (host: AppHost): AppHost => {
  let routeDrain: Promise<void> = Promise.resolve()
  return {
    ...host,
    start: async (...args) => {
      await routeDrain
      const session = await host.start(...args)
      return {
        ...session,
        dispose: async () => {
          routeDrain = releaseRuntimeRoutes(session.runtime)
          await routeDrain
          await session.dispose()
        },
      }
    },
  }
}
const releaseRuntimeRoutes = async (runtime: Runtime) => {
  const owner = runtimeRoutes.get(runtime)
  runtimeRoutes.delete(runtime)
  await owner?.registry.dispose()
  owner?.factories.clear()
}
const OwnershipContext = React.createContext<RouteOwnership | null>(null)
const OwnedNodes = ({ children }: { readonly children: React.ReactNode }) => {
  const { runtime } = useRuntimeSession()
  return (
    <OwnershipContext.Provider value={routesForRuntime(runtime)}>
      {children}
    </OwnershipContext.Provider>
  )
}

/** Both status and Suspense consumers acquire the same session-owned lease. */
export const useRouteLease = <N extends OwnedNode>(
  definition: {
    readonly identity?: object
    mount(runtime: Runtime, signal?: AbortSignal): N | Promise<N>
  },
  options: {
    readonly key: string
    readonly lifetime?: "component" | "history-entry"
    readonly navigationType?: "POP" | "PUSH" | "REPLACE"
    readonly params?: unknown
    readonly enabled?: boolean
    readonly suspense?: boolean
  },
): RouteLease<N> | null => {
  const { runtime } = useRuntimeSession()
  const owner = React.useContext(OwnershipContext)
  if (owner === null) {
    throw new Error("Route hooks require the app's <Provider>")
  }
  const identity = definition.identity ?? definition
  owner.factories.set(identity, (_, signal) => definition.mount(runtime, signal))
  const [committed, setCommitted] = React.useState<{
    identity: object
    key: string
    lease: RouteLease<N>
  } | null>(null)
  const enabled = options.enabled !== false
  const suspense = options.suspense !== false
  const paramsKey = JSON.stringify(options.params ?? {})
  const lease = !enabled
    ? null
    : suspense
      ? (owner.registry.acquire(identity, options.key, options.params ?? {}) as RouteLease<N>)
      : committed?.identity === identity && committed.key === options.key
        ? committed.lease
        : null
  const prepared = suspense ? lease : null
  React.useEffect(() => {
    if (!enabled) {
      return undefined
    }
    const acquired = suspense
      ? prepared
      : (owner.registry.acquire(identity, options.key, JSON.parse(paramsKey)) as RouteLease<N>)
    if (acquired === null) {
      return undefined
    }
    const release = acquired.retain()
    if (!suspense) {
      setCommitted({ identity, key: options.key, lease: acquired })
    }
    if (options.lifetime === "history-entry") {
      owner.registry.visit(options.key, options.navigationType ?? "POP")
    }
    return release
  }, [
    owner,
    identity,
    enabled,
    suspense,
    prepared,
    options.key,
    options.lifetime,
    options.navigationType,
    paramsKey,
  ])
  return lease
}

export type ActionViews<A> = {
  readonly [K in keyof A]: {
    readonly run: A[K]
    readonly available: boolean
    readonly reason: string | null
    readonly pending: boolean
  }
}
type ViewActions = Record<string, (...args: never) => Promise<ActionOutcome<unknown>>>
export type NodeView<S, A> =
  | { readonly status: "pending"; readonly state: null; readonly actions: null }
  | { readonly status: "ready"; readonly state: S; readonly actions: ActionViews<A> }
const noPending: ReadonlyMap<string, number> = new Map()

/** Compose state, independent guards and action progress with one fixed set of hooks. */
export const useNodeView = <S, A extends ViewActions>(
  node: {
    readonly actions: A
    getSnapshot(): S
    subscribe(listener: () => void): () => void
    subscribeAvailability(listener: () => void): () => void
    availability(action: keyof A & string): true | string
  } | null,
): NodeView<S, A> => {
  const state = useNodeState(node)
  const guards = React.useSyncExternalStore(node?.subscribeAvailability ?? noSubscription, () =>
    node === null
      ? ""
      : JSON.stringify(Object.keys(node.actions).map((name) => node.availability(name))),
  )
  const [progress, setProgress] = React.useState<{
    node: typeof node
    counts: ReadonlyMap<string, number>
  }>({ node, counts: noPending })
  const pending = progress.node === node ? progress.counts : noPending
  const actions = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(node?.actions ?? {}).map(([name, invoke], index) => {
          const verdict =
            (JSON.parse(guards) as readonly (true | string)[])[index] ?? "Screen is not mounted"
          return [
            name,
            {
              available: verdict === true,
              reason: verdict === true ? null : verdict,
              pending: (pending.get(name) ?? 0) > 0,
              run: async (...args: never[]) => {
                setProgress((previous) => {
                  const counts = previous.node === node ? previous.counts : noPending
                  return { node, counts: new Map(counts).set(name, (counts.get(name) ?? 0) + 1) }
                })
                try {
                  return await (invoke as (...input: unknown[]) => Promise<ActionOutcome<unknown>>)(
                    ...args,
                  )
                } finally {
                  setProgress((previous) =>
                    previous.node === node
                      ? {
                          node,
                          counts: new Map(previous.counts).set(
                            name,
                            Math.max(0, (previous.counts.get(name) ?? 1) - 1),
                          ),
                        }
                      : previous,
                  )
                }
              },
            },
          ]
        }),
      ) as unknown as ActionViews<A>,
    [node, guards, pending],
  )
  return node === null
    ? { status: "pending", state: null, actions: null }
    : { status: "ready", state: state as S, actions }
}
