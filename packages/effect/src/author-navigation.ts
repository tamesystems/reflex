import { authorMessages } from "./author-messages.ts"
import * as Effect from "effect/Effect"
import { Registry, mountWithAccess } from "./capability.ts"
import { defineNavigationFactories } from "./navigation.ts"
import { navigationCommand, AuthorAction } from "./author-commands.ts"
import { AUTHOR, authorName, type AuthorDefinition } from "./author-screen.ts"
import type * as Contract from "./author-contracts.ts"
import type { Erased } from "./erased.ts"

export const NAVIGATION = Symbol("reflex/author-navigation")
let navigatorSequence = 0

const validateContracts = (contracts: Record<string, Erased>) => {
  for (const [name, contract] of Object.entries(contracts)) {
    if (name !== authorName(contract)) {
      throw new Error(`Navigation key ${name} must match contract name ${authorName(contract)}`)
    }
  }
}

export const authorNavigation = ((
  contracts: Record<string, Erased>,
  options?: { key?: string },
) => {
  const key = options?.key ?? "default"
  validateContracts(contracts)
  const core = defineNavigationFactories(
    `reflex/navigation/${key}/${++navigatorSequence}`,
    Object.fromEntries(
      Object.entries(contracts).map(([name, contract]) => [name, contract.params]),
    ),
  )
  const withNavigator = (f: (nav: Erased) => Effect.Effect<void, Erased, Erased>) =>
    Effect.flatMap(Effect.serviceOption(core.Tag), (option) => {
      if (option._tag === "Some") {
        return f(option.value)
      }
      return Effect.flatMap(Effect.serviceOption(AuthorAction), (action) =>
        Effect.die(
          new Error(
            authorMessages.foreignNavigator(
              action._tag === "Some" ? action.value : "unknown",
              key,
              Object.keys(contracts),
            ),
          ),
        ),
      )
    })
  const command = navigationCommand
  return {
    push: (target: Erased, params: Erased = {}) =>
      command(
        withNavigator((nav) => {
          if (contracts[authorName(target)] !== target) {
            return Effect.die(
              new Error(`Navigator "${key}" requires its exact ${authorName(target)} contract`),
            )
          }
          return nav.push(authorName(target), params)
        }),
      ),
    get back() {
      return command(
        withNavigator((nav) =>
          Effect.gen(function* () {
            const registry = yield* Registry
            const navigation = registry.inspect({ name: "Navigation" }).node
            const state = navigation?.state as { stack?: unknown[] } | undefined
            if ((state?.stack?.length ?? 0) <= 1) {
              return yield* Effect.fail({
                _tag: "NavigationRefused",
                message: "Already at the root screen",
              })
            }
            yield* nav.back
          }),
        ),
      )
    },
    get stay() {
      return command(withNavigator(() => Effect.void))
    },
    implement: (implementations: readonly AuthorDefinition[], { initial }: { initial: Erased }) => {
      return implementNavigation(contracts, key, core, implementations, initial)
    },
  }
}) as unknown as typeof Contract.navigationContract

const implementNavigation = (
  contracts: Record<string, Erased>,
  key: string,
  core: Erased,
  implementations: readonly AuthorDefinition[],
  initial: Erased,
) => {
  const nodes: Record<string, Erased> = {}
  for (const definition of implementations) {
    const meta = definition[AUTHOR]
    if (meta?.role !== "screen" || contracts[definition.name] !== meta.contract) {
      throw new Error(
        `Navigator "${key}" screen "${definition.name}" must implement its registered contract`,
      )
    }
    if (nodes[definition.name] !== undefined) {
      throw new Error(`${definition.name} is declared more than once`)
    }
    nodes[definition.name] = meta.capability
  }
  for (const name of Object.keys(contracts)) {
    if (nodes[name] === undefined) {
      throw new Error(`${name} requires one implementation`)
    }
  }
  const target = "screen" in initial ? initial.screen : initial
  if (contracts[authorName(target)] !== target) {
    throw new Error(`Navigator "${key}" initial screen must be a registered contract`)
  }
  const layer = core.layer({
    initial: { route: authorName(target), params: "screen" in initial ? initial.params : {} },
    screens: Object.fromEntries(
      Object.entries(nodes).map(([name, screen]) => [
        name,
        (params: Erased) =>
          Effect.map(mountWithAccess(screen, screen.initial(params)), ({ node }) => node),
      ]),
    ),
  })
  return { [NAVIGATION]: { layer, nodes, key }, screens: implementations }
}
