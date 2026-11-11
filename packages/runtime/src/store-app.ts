import { DEFINITION_IDENTITY, definitionIdentity } from "./definition-identity.ts"
import { registerRouteFactories } from "./route-mount.ts"
import { ErrorCode, ProtocolError } from "@reflex/protocol"
import type { AppHost } from "./controller.ts"
import { createRuntime, type Runtime } from "./runtime.ts"
import type { Store } from "./store-node.ts"

export interface MountableNode {
  readonly name: string
  readonly type: string
  readonly createStore: (...params: never[]) => Store<unknown>
  mount(
    runtime: Runtime,
    store?: unknown,
    type?: import("@reflex/protocol").NodeType,
  ): { readonly id: import("@reflex/protocol").NodeId; dispose(): void }
}
export interface StoreScenario<N extends Record<string, MountableNode>> {
  readonly description?: string
  readonly stores?: {
    readonly [K in keyof N]?: (...params: never[]) => ReturnType<N[K]["createStore"]>
  }
}
export interface StoreApp<
  N extends Record<string, MountableNode>,
  S extends Record<string, StoreScenario<N>>,
  Screens extends Record<string, MountableNode> = Record<never, never>,
> extends AppHost {
  readonly [DEFINITION_IDENTITY]: object
  readonly screens: Screens
  readonly nodes: N
  readonly defaultScenario: keyof S & string
  readonly scenarioNames: ReadonlyArray<keyof S & string>
  withScenarios<const Extra extends Record<string, StoreScenario<N>>>(
    scenarios: Extra,
    options?: { readonly defaultScenario?: keyof (S & Extra) & string },
  ): StoreApp<N, S & Extra, Screens>
}

const disposeNodes = async (nodes: ReturnType<MountableNode["mount"]>[]): Promise<void> => {
  for (const node of nodes.reverse()) {
    node.dispose()
  }
}

/** Own fresh stores, typed scenario overrides, focus and disposal on every start/reset. */
export const defineLegacyStoreApp = <
  const N extends Record<string, MountableNode> = Record<never, never>,
  const RN extends Record<string, MountableNode> = Record<never, never>,
  const S extends Record<string, StoreScenario<N & RN>> = { default: Record<string, never> },
>(definition: {
  readonly name: string
  /** Author composition assigns ambient roles; legacy nodes retain their declared type. */
  readonly ambientType?: "service"
  readonly nodes?: N
  /** Definitions mounted by route components, included in the application contract. */
  readonly screens?: RN
  readonly scenarios?: S
  readonly defaultScenario?: NoInfer<keyof S & string>
}): StoreApp<N & RN, S, RN> => {
  const defaults: Record<string, StoreScenario<N & RN>> = { default: {} }
  const scenarios = definition.scenarios ?? (defaults as S)
  const names = Object.keys(scenarios) as (keyof S & string)[]
  const defaultScenario = definition.defaultScenario ?? names[0]
  if (defaultScenario === undefined) {
    throw new Error("A store app needs at least one scenario")
  }
  const host: StoreApp<N & RN, S, RN> = {
    [DEFINITION_IDENTITY]: {},
    screens: (definition.screens ?? {}) as RN,
    name: definition.name,
    nodes: { ...definition.nodes, ...definition.screens } as N & RN,
    defaultScenario,
    scenarioNames: names,
    scenarios: Object.entries(scenarios).map(([name, scenario]) => ({
      name,
      virtualTime: false,
      ...(scenario.description === undefined ? {} : { description: scenario.description }),
    })),
    withScenarios: (extra, options) =>
      Object.assign(
        defineLegacyStoreApp({
          ...definition,
          scenarios: { ...scenarios, ...extra },
          defaultScenario: options?.defaultScenario ?? defaultScenario,
        }),
        { [DEFINITION_IDENTITY]: definitionIdentity(host) },
      ),
    async start(name, { sessionId, onBackgroundError }) {
      const scenario: StoreScenario<N & RN> | undefined = Object.hasOwn(scenarios, name)
        ? scenarios[name]
        : undefined
      if (scenario === undefined) {
        throw new ProtocolError(ErrorCode.ScenarioNotFound, `Unknown scenario "${name}"`)
      }
      const runtime = createRuntime({
        sessionId,
        ...(onBackgroundError === undefined ? {} : { onBackgroundError }),
      })
      registerRouteFactories(
        runtime,
        new Map(
          Object.entries({ ...definition.nodes, ...definition.screens }).map(([key, route]) => [
            route,
            (params: unknown) => {
              const node = route.mount(
                runtime,
                scenario.stores?.[key]?.(params as never) ?? route.createStore(params as never),
                Object.hasOwn(definition.screens ?? {}, key) ? "screen" : definition.ambientType,
              )
              nodes.push(node)
              return node
            },
          ]),
        ),
      )
      const nodes: ReturnType<MountableNode["mount"]>[] = []
      const dispose = () => disposeNodes(nodes)
      try {
        for (const [key, nodeDefinition] of Object.entries(definition.nodes ?? {})) {
          const node = nodeDefinition.mount(
            runtime,
            scenario.stores?.[key]?.(),
            definition.ambientType,
          )
          nodes.push(node)
          if (
            definition.ambientType === undefined &&
            nodeDefinition.type === "screen" &&
            runtime.focus === null
          ) {
            runtime.setFocus(node.id)
          }
        }
        return { runtime, dispose }
      } catch (error) {
        await dispose()
        throw error
      }
    },
  }
  return host
}
