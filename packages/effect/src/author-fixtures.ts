import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mountWithAccess } from "./capability.ts"
import { stateAccess } from "./author-actions.ts"
import { AUTHOR, type AuthorDefinition } from "./author-screen.ts"
import type { Erased } from "./erased.ts"

interface Environment {
  context: Context.Context<Erased>
}
class FixtureEnvironment extends Context.Service<FixtureEnvironment, Environment>()(
  "@reflex/effect/FixtureEnvironment",
) {}

/** Mount state before layers build; bind fixture handlers to the final service environment. */
export const fixtureLayer = (fixtures: readonly AuthorDefinition[]) =>
  Layer.suspend(() => {
    const environment: Environment = { context: Context.empty() as Context.Context<Erased> }
    return Layer.mergeAll(
      Layer.succeed(FixtureEnvironment, environment),
      ...fixtures.map((fixture) => {
        const { capability, tag } = fixture[AUTHOR]
        if (tag === undefined) {
          throw new Error(`${fixture.name} is not a fixture`)
        }
        const mounted = {
          ...capability,
          actions: Object.fromEntries(
            Object.entries(capability.actions).map(([name, value]) => {
              const action = value as Erased
              return [
                name,
                {
                  ...action,
                  handler: (input: Erased, access: Erased) =>
                    Effect.flatMap(Effect.context<Erased>(), (invocation) =>
                      action
                        .handler(input, access)
                        .pipe(
                          Effect.provideContext(Context.merge(environment.context, invocation)),
                        ),
                    ),
                },
              ]
            }),
          ),
        }
        return Layer.effect(
          tag,
          Effect.map(mountWithAccess(mounted, capability.initial({})), ({ access }) =>
            stateAccess(access),
          ),
        )
      }),
    )
  })

export const bindFixtureHandlers = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* FixtureEnvironment
    environment.context = yield* Effect.context<Erased>()
  }),
)
