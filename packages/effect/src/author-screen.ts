import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { defineCapability } from "./capability.ts"
import { SCREEN_CONTRACT } from "./screen-identity.ts"
import { authorActionBuilder } from "./author-actions.ts"
import { AuthorAction } from "./author-commands.ts"
import type * as Contract from "./author-contracts.ts"
import type { Erased } from "./erased.ts"

export const AUTHOR = Symbol("reflex/author-definition")
/** Class names are JavaScript implementation details; the contract declares its name. */
export const authorName = (contract: Erased): string =>
  contract[SCREEN_CONTRACT]?.key ?? contract.name
export interface AuthorDefinition {
  readonly name: string
  readonly [AUTHOR]: {
    readonly capability: Erased
    readonly contract: object
    readonly role: "screen" | "service" | "fixture"
    readonly tag?: Context.Service<Erased, Erased>
  }
}

interface Implementation {
  readonly actions: (action: Erased) => Erased
  readonly onFocus?: (ctx: Erased) => Effect.Effect<Erased, Erased, Erased>
}
const implement = (
  contract: Erased,
  role: "screen" | "service" | "fixture",
  spec: Implementation,
) => {
  Object.defineProperty(contract, "name", { value: authorName(contract) })
  const capability = defineCapability({
    name: authorName(contract),
    state: contract.state,
    params: contract.params,
    initial: contract.initial,
    type: role,
    actions: () =>
      Object.fromEntries(
        Object.entries(spec.actions(authorActionBuilder())).map(([name, value]) => {
          const action = value as Erased
          return [
            name,
            {
              ...action,
              handler: (input: Erased, access: Erased) =>
                Effect.provideService(action.handler(input, access), AuthorAction, name),
            },
          ]
        }),
      ),
    ...(spec.onFocus === undefined
      ? {}
      : {
          onFocus: (access: Erased) =>
            (
              authorActionBuilder()({
                handler: (_, ctx) => spec.onFocus?.(ctx) as Erased,
              }) as Erased
            ).handler(undefined, access),
        }),
  })
  return Object.assign(capability, {
    "~reflex": { ...capability["~reflex"], contract },
    [SCREEN_CONTRACT]: contract[SCREEN_CONTRACT],
    [AUTHOR]: { capability, contract, role },
  })
}

const makeScreen = (name: string, spec: Erased) => {
  // biome-ignore lint/complexity/noStaticOnlyClass: Screen contracts must support class extension.
  class ScreenContract {
    static readonly [SCREEN_CONTRACT] = { key: name }
    static readonly state = spec.state
    static readonly params =
      spec.params === undefined
        ? Schema.Record(Schema.String, Schema.Never)
        : Schema.Struct(spec.params)
    static readonly initial = spec.initial
    static implement(this: Erased, implementation: Implementation) {
      // biome-ignore lint/complexity/noThisInStatic: The exact subclass is the contract identity.
      return implement(this, "screen", implementation)
    }
    static handler(handler: Erased) {
      return handler
    }
    static when(_tag: string) {
      return { handler: (handler: Erased) => handler }
    }
  }
  Object.defineProperty(ScreenContract, "name", { value: name })
  return ScreenContract
}
export const Screen = Object.assign(makeScreen, {
  define: (name: string, spec: Erased) => {
    const definition = implement(makeScreen(name, spec), "screen", spec)
    definition[AUTHOR].contract = definition
    return definition
  },
}) as unknown as typeof Contract.screenContract

export const defineService = ((spec: Erased) =>
  implement(
    makeScreen(spec.name, spec),
    "service",
    spec,
  )) as unknown as typeof Contract.serviceContract

export const defineFixture = ((spec: Erased) => {
  const definition = implement(makeScreen(spec.name, spec), "fixture", spec)
  const tag = Context.Service<Erased, Erased>(`reflex/fixture/${spec.name}`)
  // The fixture is an Effect value that yields its scenario-local state access.
  return Object.assign(
    Effect.map(tag, (state) => state),
    definition,
    {
      [AUTHOR]: { ...definition[AUTHOR], tag },
    },
  )
}) as unknown as typeof Contract.fixtureContract
