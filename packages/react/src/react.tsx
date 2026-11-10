import { assertNever, ErrorCode, ROUTER_RETAINED_ENTRIES_MAX, type NodeId } from "@reflex/protocol"
import {
  type ActionOutcome,
  type ScenarioName,
  type AppHost,
  type AppSession,
  type Runtime,
  systemTimers,
} from "@reflex/runtime/internal"
import {
  type Bridge,
  nodeSource,
  reportFocus,
  createLiveController,
  LiveSessions,
  reportFailure,
} from "@reflex/live/session"
import * as React from "react"
import { findRouteNode, type RouteEntry } from "./route-binding.ts"
export interface RouteBinding {
  readonly stack: ReadonlyArray<RouteEntry>
  readonly token: string | null
  readonly params?: Record<string, unknown>
}
const SessionContext = React.createContext<AppSession | null>(null)

export const useRuntimeSession = (): AppSession => {
  const session = React.useContext(SessionContext)
  if (session === null) {
    throw new Error("useSession must be used inside <ReflexProvider>")
  }
  return session
}

const ControlsContext = React.createContext<{
  readonly host: AppHost
  readonly scenario: string
  reset(scenario?: string): Promise<void>
} | null>(null)
/** Session controls; raw registry access is an explicit advanced import. */
export const useSession = <H extends AppHost = AppHost>(
  host?: H,
): { readonly scenario: ScenarioName<H>; reset(scenario?: ScenarioName<H>): Promise<void> } => {
  const controls = React.useContext(ControlsContext)
  if (controls === null) {
    throw new Error("useSession requires ReflexProvider")
  }
  // The app is a type witness: providers may wrap a host with development services.
  void host
  return { scenario: controls.scenario as ScenarioName<H>, reset: controls.reset }
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
export const ReflexProvider = <H extends AppHost>({
  host,
  scenario,
  bridge,
  fallback = null,
  children,
}: {
  readonly host: H
  readonly scenario?: NoInfer<ScenarioName<H>>
  readonly bridge?: Bridge | undefined
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
          <ControlsContext.Provider
            value={{
              host,
              scenario: sessions.scenario ?? host.defaultScenario,
              reset: async (scenario) => {
                const result = await sessions.reset(scenario)
                if (result.kind === "failed") {
                  throw result.cause
                }
              },
            }}
          >
            <OwnedNodes>{children}</OwnedNodes>
          </ControlsContext.Provider>
        </SessionContext.Provider>
      )
    default:
      return assertNever(lifecycle)
  }
}

export const useRouteNode = <N,>(
  resolve: (runtime: Runtime, nodeId: NodeId) => N | undefined,
  { stack, token, params }: RouteBinding,
): N | null => {
  const { runtime } = useRuntimeSession()
  const key = JSON.stringify([token, params])
  const bound = React.useRef<{ key: string; node: N } | null>(null)
  const node =
    bound.current?.key === key
      ? bound.current.node
      : findRouteNode({
          stack,
          token,
          params,
          resolve: (nodeId) => resolve(runtime, nodeId),
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

/** Bind a public node handle without assumptions about the adapter's live object. */
export const useRawNode = (id: NodeId | null) => {
  const { runtime } = useRuntimeSession()
  return React.useMemo(() => (id === null ? null : nodeSource(runtime, id)), [runtime, id])
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
  return {
    run,
    pending: current.pending > 0,
    available: verdict === true,
    reason: verdict === true ? null : verdict,
    outcome: current.outcome,
  }
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
interface Ownership {
  readonly definition: object
  readonly node: OwnedNode
  users: number
  retained: boolean
}
const OwnershipContext = React.createContext<Map<string, Ownership> | null>(null)
const OwnedNodes = ({ children }: { readonly children: React.ReactNode }) => {
  const [nodes] = React.useState(() => new Map<string, Ownership>())
  React.useEffect(
    () => () => {
      for (const { node } of nodes.values()) {
        node.dispose()
      }
      nodes.clear()
    },
    [nodes],
  )
  return <OwnershipContext.Provider value={nodes}>{children}</OwnershipContext.Provider>
}

const historyEntries = new WeakMap<Map<string, Ownership>, { keys: string[]; index: number }>()
const retainHistoryEntry = (
  owner: Map<string, Ownership>,
  key: string,
  kind: "POP" | "PUSH" | "REPLACE" | undefined,
): void => {
  if (kind === undefined) {
    return
  }
  const history = historyEntries.get(owner) ?? { keys: [], index: -1 }
  historyEntries.set(owner, history)
  const existing = history.keys.indexOf(key)
  if (existing >= 0) {
    history.index = existing
    return
  }
  const discard =
    kind === "REPLACE"
      ? history.keys.splice(Math.max(0, history.index))
      : history.keys.splice(history.index + 1)
  for (const obsolete of discard) {
    const entry = owner.get(obsolete)
    if (entry !== undefined && entry.users === 0) {
      owner.delete(obsolete)
      entry.node.dispose()
    }
  }
  history.keys.push(key)
  if (history.keys.length > ROUTER_RETAINED_ENTRIES_MAX) {
    history.keys.shift()
  }
  history.index = history.keys.length - 1
}

/** Mount after commit; history entries are retained until the session ends. */
export const useMountedNode = <N extends OwnedNode>(
  definition: { mount(runtime: Runtime): N },
  options: {
    readonly key: string
    readonly lifetime?: "component" | "history-entry"
    readonly navigationType?: "POP" | "PUSH" | "REPLACE"
  },
): N | null => {
  const { runtime } = useRuntimeSession()
  const owner = React.useContext(OwnershipContext)
  const { key, lifetime = "component", navigationType } = options
  const [mounted, setMounted] = React.useState<{ key: string; definition: object; node: N } | null>(
    null,
  )
  React.useEffect(() => {
    if (owner === null) {
      throw new Error("useMountedNode requires ReflexProvider")
    }
    retainHistoryEntry(owner, key, navigationType)
    let entry = owner.get(key)
    if (entry !== undefined && entry.definition !== definition) {
      throw new Error(`History entry "${key}" already owns another definition`)
    }
    if (entry === undefined) {
      if (lifetime === "history-entry") {
        for (const [oldKey, old] of owner) {
          if (owner.size < ROUTER_RETAINED_ENTRIES_MAX) {
            break
          }
          if (old.users === 0) {
            owner.delete(oldKey)
            old.node.dispose()
          }
        }
      }
      entry = {
        definition,
        node: definition.mount(runtime),
        users: 0,
        retained: lifetime === "history-entry",
      }
      owner.set(key, entry)
    }
    entry.users++
    entry.retained ||= lifetime === "history-entry"
    const owned = entry
    setMounted({ key, definition, node: entry.node as N })
    return () => {
      owned.users--
      if (!owned.retained && owned.users === 0 && owner.get(key) === owned) {
        owner.delete(key)
        owned.node.dispose()
      }
    }
  }, [runtime, owner, definition, key, lifetime, navigationType])
  return mounted?.key === key && mounted.definition === definition ? mounted.node : null
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

/** Ambient lookup subscribes to membership and optionally owns focus while displayed. */
export const useNode = <S, A extends ViewActions>(
  definition: {
    resolve(runtime: Runtime): import("@reflex/runtime/internal").NodeHandle<S, A> | undefined
  },
  options: { readonly focus?: boolean } = {},
): NodeView<S, A> => {
  const node = useNodeHandle(definition)
  useNodeFocus(node, options.focus === true)
  return useNodeView(node)
}
