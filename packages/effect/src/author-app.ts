import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { defineApp as legacyDefineApp } from "./app.ts"
import { mountWithAccess } from "./capability.ts"
import { AUTHOR, type AuthorDefinition } from "./author-screen.ts"
import { NAVIGATION } from "./author-navigation.ts"
import { fixtureLayer, bindFixtureHandlers } from "./author-fixtures.ts"
import type * as Contract from "./author-contracts.ts"
import type * as M from "./author-model.ts"
import type { Erased } from "./erased.ts"
import { APP_HOST_ADAPTER, type AppHost, type ConsumerDefinition } from "@reflex/runtime/internal"

const HOST = APP_HOST_ADAPTER
type DefMap<D> = { readonly [P in Extract<D, { name: string }> as P["name"]]: P }
type ScenarioFixtures<S, F> =
  | F
  | (S[keyof S] extends infer V
      ? V extends { fixtures: readonly (infer D)[] }
        ? D
        : never
      : never)
/** Compatibility seam for bindings and journeys that still consume AppHost. */
export const legacyApp = <N extends string, D, V, S extends M.ScenarioMap, K extends keyof S, F, C>(
  app: M.App<N, D, V, S, K, F, C>,
): AppHost & {
  readonly nodes: DefMap<D | V | ScenarioFixtures<S, F>>
  readonly screens: DefMap<D>
  readonly scenarioNames: readonly (keyof S & string)[]
  readonly defaultScenario: K & string
} => (app as Erased)[HOST]

interface Spec {
  readonly name: string
  readonly navigation?: Erased
  readonly screens?: readonly AuthorDefinition[]
  readonly services?: readonly AuthorDefinition[]
  readonly fixtures?: readonly AuthorDefinition[]
  readonly layer?: Erased
  readonly scenarios?: Record<string, Scenario>
  readonly defaultScenario?: string
}
interface Scenario {
  readonly layer?: Erased
  readonly fixtures?: readonly AuthorDefinition[]
  readonly description?: string
  readonly virtualTime?: boolean
}
const mountAmbient = (definitions: readonly AuthorDefinition[]) =>
  Layer.effectDiscard(
    Effect.forEach(
      definitions,
      (definition) => {
        const capability = definition[AUTHOR].capability
        return mountWithAccess(capability, capability.initial({}))
      },
      { discard: true },
    ),
  )
const mapDefinitions = (definitions: readonly AuthorDefinition[]) =>
  Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
const validateDefinitions = (definitions: readonly AuthorDefinition[]) => {
  const names = new Set<string>()
  for (const definition of definitions) {
    if (names.has(definition.name)) {
      throw new Error(`${definition.name} is declared more than once`)
    }
    names.add(definition.name)
  }
}

const buildApp = (spec: Spec): Erased => {
  const scenarios = spec.scenarios ?? { default: {} }
  const nav = spec.navigation?.[NAVIGATION]
  if (nav !== undefined && spec.screens !== undefined) {
    throw new Error("Choose navigation or screens, not both")
  }
  const screens = spec.navigation?.screens ?? spec.screens ?? []
  const services = spec.services ?? []
  for (const definition of screens) {
    if (definition[AUTHOR]?.role !== "screen") {
      throw new Error("screens accepts only screens")
    }
  }
  for (const definition of services) {
    if (definition[AUTHOR]?.role !== "service") {
      throw new Error("services accepts only services")
    }
  }
  validateDefinitions([...screens, ...services])
  const normalized = Object.fromEntries(
    Object.entries(scenarios).map(([name, scenario]) => [
      name,
      { ...scenario, fixtures: scenario.fixtures ?? spec.fixtures ?? [] },
    ]),
  )
  const root = Object.assign(
    Layer.mergeAll(nav?.layer ?? Layer.empty, mountAmbient(services)).pipe(
      Layer.provideMerge(bindFixtureHandlers),
    ),
    {
      nodes: mapDefinitions(screens),
    },
  )
  const composed = Object.fromEntries(
    Object.entries(normalized).map(([name, scenario]) => {
      validateDefinitions([...screens, ...services, ...scenario.fixtures])
      const layer = (scenario.layer ?? Layer.empty).pipe(
        Layer.provideMerge(
          (spec.layer ?? Layer.empty).pipe(Layer.provideMerge(fixtureLayer(scenario.fixtures))),
        ),
      )
      return [name, { ...scenario, layer }]
    }),
  )
  const defaultScenario = spec.defaultScenario ?? Object.keys(scenarios)[0] ?? "default"
  if (!Object.hasOwn(scenarios, defaultScenario)) {
    throw new Error(`withScenarios defaultScenario must exist: ${defaultScenario}`)
  }
  if (Object.keys(scenarios).length > 1 && spec.defaultScenario === undefined) {
    throw new Error("Apps with multiple scenarios require defaultScenario")
  }
  const host = legacyDefineApp({
    name: spec.name,
    root: root as Erased,
    scenarios: composed,
    defaultScenario,
    nodes: mapDefinitions([
      ...screens,
      ...services,
      ...Object.values(normalized).flatMap((s) => s.fixtures),
    ]) as unknown as Record<string, ConsumerDefinition>,
  })
  return {
    nodes: host.nodes,
    scenarioNames: host.scenarioNames,
    name: spec.name,
    screens,
    services,
    scenarios: normalized,
    defaultScenario,
    [HOST]: host,
    withScenarios: (
      extra: Record<string, Scenario>,
      options?: { defaultScenario?: string; fixtures?: readonly AuthorDefinition[] },
    ) => {
      for (const name of Object.keys(extra)) {
        if (Object.hasOwn(scenarios, name)) {
          throw new Error(`Scenario ${name} already exists; choose a new name`)
        }
      }
      return buildApp({
        ...spec,
        scenarios: { ...normalized, ...extra },
        defaultScenario: options?.defaultScenario ?? defaultScenario,
        fixtures: options?.fixtures ?? spec.fixtures ?? [],
      })
    },
  }
}
export const authorApp = buildApp as unknown as typeof Contract.appContract
