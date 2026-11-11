import { ErrorCode, ProtocolError, type ScenarioDescriptor } from "@reflex/protocol"
import {
  type AppHost,
  type AppSession,
  type ConsumerDefinition,
  createRuntime,
  registerRouteFactories,
  DEFINITION_IDENTITY,
  type Timers,
  type SessionStartOptions,
} from "@reflex/runtime/internal"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
// Not the "effect/testing" barrel: it imports node:assert, which Metro cannot resolve.
import * as TestClock from "effect/testing/TestClock"
import * as Scope from "effect/Scope"
import * as Exit from "effect/Exit"
import { mountOwned, type Capability } from "./capability.ts"
import type { Erased } from "./erased.ts"
import { Registry } from "./capability.ts"

/**
 * A test clock warns about sleepers it has not woken. In a long-lived session
 * that is the expected state between `advanceTime` calls, not a mistake.
 */
const VIRTUAL_CLOCK_WARNING_DELAY = "1 hour"

type NodeMap = Record<string, ConsumerDefinition>
export interface Scenario<Services> {
  readonly description?: string
  /** Everything the app needs from the outside world. */
  readonly layer: Layer.Layer<Services, never, Registry>
  /** Run on a `TestClock`, moved only by `app.advanceTime`. */
  readonly virtualTime?: boolean
}

export interface AppDefinition<Services, Root> {
  readonly name: string
  readonly root: Layer.Layer<Root, never, Services | Registry>
  readonly scenarios: { readonly [name: string]: Scenario<Exclude<Services, Registry>> }
  readonly defaultScenario: string
  /** For a runtime whose waits should not use real time. */
  readonly timers?: Timers
}

/** Build the infrastructure session host after authored composition has been validated. */
export const createEffectHost = <
  Services,
  Root,
  const S extends Record<string, Scenario<Exclude<Services, Registry>>>,
  const N extends NodeMap = Record<never, never>,
>(
  definition: Omit<AppDefinition<Services, Root>, "scenarios" | "defaultScenario"> & {
    readonly nodes?: N
    readonly scenarios: S
    readonly defaultScenario: NoInfer<keyof S & string>
  },
): AppHost & {
  readonly [DEFINITION_IDENTITY]: object
  readonly nodes: N
  readonly screens: NodeMap
  readonly defaultScenario: keyof S & string
  readonly scenarioNames: readonly (keyof S & string)[]
} => ({
  [DEFINITION_IDENTITY]: {},
  nodes: definition.nodes ?? ({} as N),
  screens: ("nodes" in definition.root ? definition.root.nodes : {}) as NodeMap,
  name: definition.name,
  defaultScenario: definition.defaultScenario,
  scenarioNames: Object.keys(definition.scenarios),
  scenarios: Object.entries(definition.scenarios).map(
    ([name, scenario]): ScenarioDescriptor => ({
      name,
      ...(scenario.description === undefined ? {} : { description: scenario.description }),
      virtualTime: scenario.virtualTime === true,
    }),
  ),
  start: (name, options) => startSession(definition, name, options),
})

const startSession = async <Services, Root>(
  definition: AppDefinition<Services, Root>,
  name: string,
  { sessionId, onBackgroundError }: SessionStartOptions,
): Promise<AppSession> => {
  const scenario = Object.hasOwn(definition.scenarios, name)
    ? definition.scenarios[name]
    : undefined
  if (scenario === undefined) {
    throw new ProtocolError(ErrorCode.ScenarioNotFound, `Unknown scenario "${name}"`)
  }
  const { timers } = definition
  const runtime = createRuntime({
    sessionId,
    ...(timers === undefined ? {} : { timers }),
    ...(onBackgroundError === undefined ? {} : { onBackgroundError }),
  })
  const composed = definition.root.pipe(
    Layer.provideMerge(scenario.layer),
    Layer.provideMerge(Layer.succeed(Registry, runtime)),
    // All requirements are Services or Registry; Exclude on a generic cannot simplify this.
  ) as Layer.Layer<Root | Registry | Exclude<Services, Registry>>
  if (scenario.virtualTime === true) {
    const clock = TestClock.layer({ warningDelay: VIRTUAL_CLOCK_WARNING_DELAY })
    const managed = ManagedRuntime.make(composed.pipe(Layer.provideMerge(clock)))
    await managed.context()
    const disposeRoutes = attachRoutes(runtime, definition, managed)
    return {
      runtime,
      dispose: async () => {
        const closing = managed.dispose()
        await disposeRoutes()
        await closing
      },
      advanceTime: (durationMs) =>
        managed.runPromise(Effect.andThen(TestClock.adjust(durationMs), Clock.currentTimeMillis)),
    }
  }
  const managed = ManagedRuntime.make(composed)
  await managed.context()
  const disposeRoutes = attachRoutes(runtime, definition, managed)
  return {
    runtime,
    dispose: async () => {
      const closing = managed.dispose()
      await disposeRoutes()
      await closing
    },
  }
}

const attachRoutes = (
  runtime: import("@reflex/runtime/internal").Runtime,
  definition: { readonly root: object },
  managed: {
    runPromise(
      effect: Effect.Effect<Erased, never, Erased>,
      options?: Effect.RunOptions,
    ): Promise<Erased>
  },
) => {
  const nodes = ("nodes" in definition.root ? definition.root.nodes : {}) as Record<
    string,
    Capability<Erased, Erased, Erased, Erased, Erased>
  >
  const scopes = new Set<Scope.Closeable>()
  registerRouteFactories(
    runtime,
    new Map(
      Object.values(nodes).map((screen) => [
        screen,
        async (params: unknown, signal?: AbortSignal) => {
          const scope = Effect.runSync(Scope.make())
          scopes.add(scope)
          try {
            if (screen.initial === undefined) {
              throw new Error(`Screen "${screen.name}" needs initial(params)`)
            }
            const node = await managed.runPromise(
              mountOwned(screen, screen.initial(params)).pipe(Scope.provide(scope)),
              signal === undefined ? undefined : { signal },
            )
            return {
              ...node,
              id: node.id,
              dispose: () => {
                node.dispose()
                scopes.delete(scope)
                void Effect.runPromise(Scope.close(scope, Exit.void)).catch((error) =>
                  runtime.report(error),
                )
              },
            }
          } catch (error) {
            scopes.delete(scope)
            await Effect.runPromise(Scope.close(scope, Exit.void))
            throw error
          }
        },
      ]),
    ),
  )
  return async () => {
    for (const scope of scopes) {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    scopes.clear()
  }
}
