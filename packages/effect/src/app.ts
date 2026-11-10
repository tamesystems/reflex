import { ErrorCode, ProtocolError, type ScenarioDescriptor } from "@reflex/protocol"
import {
  type AppHost,
  type AppSession,
  type ConsumerDefinition,
  createRuntime,
  type Timers,
  type SessionStartOptions,
} from "@reflex/runtime/internal"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
// Not the "effect/testing" barrel: it imports node:assert, which Metro cannot resolve.
import * as TestClock from "effect/testing/TestClock"
import { Registry } from "./capability.ts"

/**
 * A test clock warns about sleepers it has not woken. In a long-lived session
 * that is the expected state between `advanceTime` calls, not a mistake.
 */
const VIRTUAL_CLOCK_WARNING_DELAY = "1 hour"

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

/**
 * Compose an app from a root layer and the scenarios that can satisfy it. Each
 * session owns one long-lived runtime; disposing it closes every scope.
 */
export interface DefinedApp<
  Services,
  Root,
  S extends Record<string, Scenario<Exclude<Services, Registry>>>,
  N extends Record<string, ConsumerDefinition>,
> extends AppHost {
  readonly nodes: N
  readonly scenarioNames: ReadonlyArray<keyof S & string>
  withScenarios<const Extra extends Record<string, Scenario<Exclude<Services, Registry>>>>(
    scenarios: Extra,
    options?: { readonly defaultScenario?: keyof (S & Extra) & string },
  ): DefinedApp<Services, Root, S & Extra, N>
}

export const defineApp = <
  Services,
  Root,
  const S extends Record<string, Scenario<Exclude<Services, Registry>>>,
  const N extends Record<string, ConsumerDefinition> = Record<string, ConsumerDefinition>,
>(
  definition: Omit<AppDefinition<Services, Root>, "scenarios" | "defaultScenario"> & {
    readonly nodes?: N
    readonly scenarios: S
    readonly defaultScenario: NoInfer<keyof S & string>
  },
): DefinedApp<Services, Root, S, N> => ({
  nodes: definition.nodes ?? ({} as N),
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
  withScenarios: (scenarios, options) =>
    defineApp({
      ...definition,
      scenarios: { ...definition.scenarios, ...scenarios },
      defaultScenario: options?.defaultScenario ?? definition.defaultScenario,
    }),
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
    return {
      runtime,
      dispose: () => managed.dispose(),
      advanceTime: (durationMs) =>
        managed.runPromise(Effect.andThen(TestClock.adjust(durationMs), Clock.currentTimeMillis)),
    }
  }
  const managed = ManagedRuntime.make(composed)
  await managed.context()
  return { runtime, dispose: () => managed.dispose() }
}
