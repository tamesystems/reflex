import { descriptorFingerprint } from "./descriptor.ts"
import type { ConsumerDefinition } from "./node-handle.ts"
import { DEFINITION_IDENTITY, definitionIdentity } from "./definition-identity.ts"
import { STORE_AUTHOR, STORE_OVERRIDE, type JsonShape } from "./store-node.ts"
import {
  createStoreHost,
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
type IsUnion<T, C = T> = T extends C ? ([C] extends [T] ? false : true) : never
type Named<D extends readonly MountableNode[]> = { readonly [N in D[number] as N["name"]]: N }
type Override<D extends AuthorStore> = D extends unknown
  ? {
      readonly [STORE_OVERRIDE]: true
      readonly definition: D
      readonly factory: (...args: never[]) => ReturnType<D["createStore"]>
    }
  : never
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
  readonly services: V
  withScenarios<const E extends Record<string, Scenario<D[number] | V[number]>>>(
    extra: E & {
      [K in keyof E & keyof S]: { readonly "Scenario already exists; choose a new name": never }
    },
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
  } & Unique<readonly [...D, ...V]> &
    (IsUnion<keyof S> extends true ? { readonly defaultScenario: keyof S & string } : unknown),
): AuthorStoreApp<D, V, S>
export function defineStoreApp(spec: AuthorSpec): unknown {
  return authorApp(spec)
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
  const hostScenarios = Object.fromEntries(
    Object.entries(scenarios).map(([name, scenario]) => {
      const stores = Object.fromEntries(
        (scenario.stores ?? []).map((override) => {
          if (override[STORE_OVERRIDE] !== true) {
            throw new Error("Scenario stores must use Definition.withStore(factory)")
          }
          if (!definitions.includes(override.definition)) {
            throw new Error("Scenario stores must belong to this app")
          }
          return [override.definition.name, override.factory]
        }),
      )
      return [name, { ...scenario, stores }]
    }),
  )
  const app = createStoreHost({
    name: spec.name,
    services: Object.fromEntries(services.map((d) => [d.name, d])),
    screens: Object.fromEntries(screens.map((d) => [d.name, d])),
    scenarios: hostScenarios,
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
    ) => {
      for (const name of Object.keys(extra)) {
        if (Object.hasOwn(scenarios, name)) {
          throw new Error(`Scenario ${name} already exists; choose a new name`)
        }
      }
      return Object.assign(
        authorApp({
          ...spec,
          scenarios: { ...scenarios, ...extra },
          defaultScenario: options?.defaultScenario ?? app.defaultScenario,
        }) as object,
        { [DEFINITION_IDENTITY]: definitionIdentity(app) },
      )
    },
  })
}
