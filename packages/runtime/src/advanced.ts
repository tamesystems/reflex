import type { AppHost, ScenarioName } from "./controller.ts"
import type { Runtime as CoreRuntime } from "./runtime.ts"
import type { InferActions, InferState, NodeHandle } from "./node-handle.ts"
import { actionOutcome } from "./node-handle.ts"
import type { OperationInfo } from "@reflex/protocol"
import { mountSessionRoute } from "./route-mount.ts"
import { STORE_AUTHOR } from "./store-node.ts"

export interface Runtime {
  readonly id: string
}
interface Definition {
  readonly name: string
  readonly [STORE_AUTHOR]: { readonly params: unknown }
  createStore(...args: never[]): unknown
  mount(runtime: CoreRuntime, store?: never): NodeHandle<unknown, unknown> & { dispose(): void }
}
const sessions = new WeakMap<
  Runtime,
  {
    readonly runtime: CoreRuntime
    readonly owned: Set<() => void>
    readonly definitions: readonly object[]
  }
>()

export async function createRuntime<A extends AppHost>(
  app: A,
  options: { readonly scenario?: ScenarioName<NoInfer<A>> } = {},
): Promise<Runtime & AsyncDisposable> {
  const session = await app.start(options.scenario ?? app.defaultScenario, {
    sessionId: `owned-${Math.random().toString(36).slice(2)}`,
  })
  const owned = new Set<() => void>()
  const handle = {
    id: session.runtime.sessionId,
    async [Symbol.asyncDispose]() {
      session.runtime.close()
      for (const dispose of owned) {
        dispose()
      }
      owned.clear()
      await session.dispose()
    },
  }
  sessions.set(handle, {
    runtime: session.runtime,
    owned,
    definitions: "nodes" in app ? (Object.values(app.nodes as object) as object[]) : [],
  })
  return handle
}
export type ActionOutcome<E = never> =
  | { readonly status: "completed" | "cancelled" }
  | { readonly status: "error"; readonly error: E }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "defect"; readonly message: string }
type PublishedError<O> = O extends {
  readonly status: "domain-error"
  readonly error: { readonly data?: infer E }
}
  ? E
  : never
type ActionView<F> = F extends (...args: infer I) => Promise<infer O>
  ? {
      run(...args: I): Promise<ActionOutcome<PublishedError<O>>>
      readonly available: boolean
      readonly pending: boolean
      readonly reason: string | null
    }
  : never
export interface OwnedNode<D> {
  readonly definition: D
  readonly state: InferState<D>
  readonly changes: { subscribe(listener: (state: InferState<D>) => void): () => void }
  readonly actions: { readonly [K in keyof InferActions<D>]: ActionView<InferActions<D>[K]> }
  dispose(): Promise<void>
}
export function mountOwned<D extends Definition>(
  runtime: Runtime,
  definition: D,
  ...params: keyof D[typeof STORE_AUTHOR]["params"] extends never
    ? []
    : [params: D[typeof STORE_AUTHOR]["params"]]
): OwnedNode<D> {
  const session = sessions.get(runtime)
  if (!session || session.runtime.closed) {
    throw new Error("The runtime is closed")
  }
  if (!session.definitions.includes(definition)) {
    throw new Error("The store definition is not registered in this runtime’s app")
  }
  const existing = session.runtime
    .inspect({ tree: true })
    .tree?.find((node) => node.name === definition.name && node.type !== "screen")
  const mounted =
    existing == null ? mountSessionRoute(session.runtime, definition, params[0] ?? {}) : existing
  if (mounted instanceof Promise) {
    throw new Error("mountOwned requires a synchronous store factory")
  }
  const node = session.runtime.liveOf(mounted.id) as NodeHandle<InferState<D>, InferActions<D>> & {
    readonly type: string
    dispose(): void
    dispatchRaw(action: string, input?: unknown): Promise<OperationInfo>
  }
  if (node.type === "screen") {
    session.runtime.setFocus(node.id)
  }
  const dispose = () => {
    node.dispose()
    session.owned.delete(dispose)
  }
  session.owned.add(dispose)
  return {
    definition,
    get state() {
      return node.getSnapshot()
    },
    changes: { subscribe: (listener) => node.subscribe(() => listener(node.getSnapshot())) },
    actions: Object.fromEntries(
      Object.keys(node.actions as object).map((name) => {
        let pending = 0
        return [
          name,
          {
            get available() {
              return node.availability(name as keyof InferActions<D> & string) === true
            },
            get reason() {
              const verdict = node.availability(name as keyof InferActions<D> & string)
              return verdict === true ? null : verdict
            },
            get pending() {
              return pending > 0
            },
            async run(...args: unknown[]): Promise<ActionOutcome<unknown>> {
              pending++
              try {
                const result = await actionOutcome<unknown>(() => node.dispatchRaw(name, args[0]))
                if (result.status === "domain-error") {
                  return { status: "error", error: result.error.data }
                }
                if (result.status === "defect") {
                  return { status: "defect", message: result.error.message }
                }
                return result
              } finally {
                pending--
              }
            },
          },
        ]
      }),
    ) as OwnedNode<D>["actions"],
    async dispose() {
      dispose()
    },
  }
}
