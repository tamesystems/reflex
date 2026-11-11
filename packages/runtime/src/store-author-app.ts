import { descriptorFingerprint } from "./descriptor.ts"
import type { ConsumerDefinition } from "./node-handle.ts"
import { DEFINITION_IDENTITY, definitionIdentity } from "./definition-identity.ts"
import { STORE_AUTHOR, type JsonShape } from "./store-node.ts"
import {
  defineLegacyStoreApp,
  type MountableNode,
  type StoreApp,
  type StoreScenario,
} from "./store-app.ts"

type AuthorStore = MountableNode & {
  readonly [STORE_AUTHOR]: {
    readonly hasParams: boolean
    readonly state: unknown
    readonly params: unknown
    readonly encodedParams: unknown
  }
}
type Check<D> = D extends AuthorStore
  ? D[typeof STORE_AUTHOR]["state"] extends JsonShape<D[typeof STORE_AUTHOR]["state"]>
    ? D[typeof STORE_AUTHOR]["encodedParams"] extends undefined
      ? unknown
      : D[typeof STORE_AUTHOR]["encodedParams"] extends JsonShape<
            D[typeof STORE_AUTHOR]["encodedParams"]
          >
        ? unknown
        : { readonly "Params must encode JSON; use jsonCodec": never }
    : { readonly [K in `Store ${D["name"]} state must be JSON; provide project`]: never }
  : { readonly "defineStoreApp accepts only stores": never }
type Checks<D extends readonly unknown[]> = { readonly [K in keyof D]: Check<D[K]> }
type Ambient<D extends readonly AuthorStore[]> = {
  readonly [K in keyof D]: keyof D[K][typeof STORE_AUTHOR]["params"] extends never
    ? unknown
    : { readonly "Ambient services must not require params": never }
}
type Unique<D extends readonly unknown[], Seen = never> = D extends readonly [
  infer H extends { name: string },
  ...infer R,
]
  ? H["name"] extends Seen
    ? { readonly "Duplicate definition name": never }
    : Unique<R, Seen | H["name"]>
  : unknown
type Named<D extends readonly MountableNode[]> = { readonly [N in D[number] as N["name"]]: N }
type Override<D extends AuthorStore> = {
  readonly definition: D
  readonly factory: (...args: never[]) => ReturnType<D["createStore"]>
}
type Scenario<D extends AuthorStore> = {
  readonly description?: string
  readonly stores?: readonly Override<D>[]
}
export type AuthorStoreApp<
  D extends readonly AuthorStore[],
  V extends readonly AuthorStore[],
  S extends Record<string, Scenario<D[number] | V[number]>>,
> = Omit<
  StoreApp<
    Named<readonly [...D, ...V]>,
    Record<keyof S, StoreScenario<Named<readonly [...D, ...V]>>>,
    Named<D>
  >,
  "withScenarios"
> & {
  readonly services: V[number]
  withScenarios<const E extends Record<string, Scenario<D[number] | V[number]>>>(
    extra: E,
    options?: { readonly defaultScenario?: keyof (S & E) & string },
  ): AuthorStoreApp<D, V, S & E>
}

export function defineStoreApp<
  const D extends readonly AuthorStore[] = readonly [],
  const V extends readonly AuthorStore[] = readonly [],
  const S extends Record<string, Scenario<D[number] | V[number]>> = {
    default: Record<never, never>
  },
>(
  spec: {
    readonly name: string
    readonly screens?: D & Checks<D>
    readonly services?: V & Checks<V> & Ambient<V>
    readonly scenarios?: S
    readonly defaultScenario?: keyof S & string
  } & Unique<readonly [...D, ...V]>,
): AuthorStoreApp<D, V, S>
export function defineStoreApp<
  const N extends Record<string, MountableNode> = Record<never, never>,
  const R extends Record<string, MountableNode> = Record<never, never>,
  const S extends Record<string, StoreScenario<N & R>> = { default: Record<string, never> },
>(spec: {
  readonly name: string
  readonly nodes?: N
  readonly screens?: R
  readonly scenarios?: S
  readonly defaultScenario?: NoInfer<keyof S & string>
}): StoreApp<N & R, S, R>
export function defineStoreApp(spec: object): unknown {
  if (
    !("services" in spec) &&
    !("screens" in spec && Array.isArray(spec.screens)) &&
    ("nodes" in spec || "screens" in spec)
  ) {
    return defineLegacyStoreApp(spec as Parameters<typeof defineLegacyStoreApp>[0])
  }
  return authorApp(spec as AuthorSpec)
}
interface AuthorSpec {
  readonly name: string
  readonly screens?: readonly AuthorStore[]
  readonly services?: readonly AuthorStore[]
  readonly scenarios?: Record<string, Scenario<AuthorStore>>
  readonly defaultScenario?: string
}
function authorApp(spec: AuthorSpec): unknown {
  const screens = spec.screens ?? []
  const services = spec.services ?? []
  const definitions = [...screens, ...services]
  const names = new Set<string>()
  for (const definition of definitions) {
    if (!(STORE_AUTHOR in definition)) {
      throw new Error("defineStoreApp accepts only stores")
    }
    if (names.has(definition.name)) {
      throw new Error(`Duplicate definition name "${definition.name}"`)
    }
    names.add(definition.name)
    if (services.includes(definition) && definition[STORE_AUTHOR].hasParams) {
      throw new Error("Ambient services must not require params")
    }
  }
  const scenarios = spec.scenarios ?? { default: {} }
  const legacyScenarios = Object.fromEntries(
    Object.entries(scenarios).map(([name, scenario]) => {
      const stores = Object.fromEntries(
        (scenario.stores ?? []).map((override) => {
          if (!definitions.includes(override.definition)) {
            throw new Error("Scenario stores must belong to this app")
          }
          return [override.definition.name, override.factory]
        }),
      )
      return [name, { ...scenario, stores }]
    }),
  )
  const app = defineLegacyStoreApp({
    name: spec.name,
    ambientType: "service",
    nodes: Object.fromEntries(services.map((d) => [d.name, d])),
    screens: Object.fromEntries(screens.map((d) => [d.name, d])),
    scenarios: legacyScenarios,
    ...(spec.defaultScenario === undefined ? {} : { defaultScenario: spec.defaultScenario }),
  })
  return Object.assign(app, {
    services,
    descriptorFingerprint: descriptorFingerprint(
      spec.name,
      screens as unknown as ConsumerDefinition[],
      services as unknown as ConsumerDefinition[],
    ),
    withScenarios: (
      extra: Record<string, Scenario<AuthorStore>>,
      options?: { defaultScenario?: string },
    ) =>
      Object.assign(
        authorApp({
          ...spec,
          scenarios: { ...scenarios, ...extra },
          defaultScenario: options?.defaultScenario ?? app.defaultScenario,
        }) as object,
        { [DEFINITION_IDENTITY]: definitionIdentity(app) },
      ),
  })
}
