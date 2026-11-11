import { authorMessages } from "./author-messages.ts"
import * as Effect from "effect/Effect"
import type { StateAccess as LegacyAccess } from "./capability.ts"
import { actionBuilder } from "./capability.ts"
import type { Erased } from "./erased.ts"
import type * as M from "./author-model.ts"
import { afterAction } from "./action-navigation.ts"

import { isCommand, IssuedCommands, AuthorAction } from "./author-commands.ts"

const changed = { _tag: "StateChanged" } as const
const matches = (value: unknown, tag: string) =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === tag

/** Recheck the guard inside the atomic write, including after a suspension. */
export const stateAccess = (
  access: LegacyAccess<Erased>,
  tag?: string,
): M.StateAccess<Erased, Erased, M.StateChanged> => {
  const update = (f: (s: Erased) => Erased) =>
    Effect.suspend(() => {
      let stale = false
      return access
        .update((current) => {
          if (tag !== undefined && !matches(current, tag)) {
            stale = true
            return current
          }
          return f(current)
        })
        .pipe(Effect.flatMap(() => (stale ? Effect.fail(changed) : Effect.void)))
    })
  return {
    get: Effect.flatMap(access.get, (s) =>
      tag === undefined || matches(s, tag) ? Effect.succeed(s) : Effect.interrupt,
    ),
    set: (s) => update(() => s),
    update,
    when: (next) => stateAccess(access, next),
  }
}

interface ActionSpec {
  readonly input?: Erased
  readonly error?: Erased
  readonly description?: string
  readonly available?: (s: Erased) => true | string
  readonly handler?: (i: Erased, ctx: M.EffectContext<Erased, Erased, M.StateChanged>) => Erased
  readonly reducer?: (i: Erased, s: Erased) => Erased
  readonly onRefused?: (
    e: M.NavigationRefused,
    ctx: M.EffectContext<Erased, Erased, M.StateChanged>,
  ) => Effect.Effect<void, Erased, Erased>
}

const runCommand = (command: unknown, spec: ActionSpec, state: ReturnType<typeof stateAccess>) => {
  if (!isCommand(command)) {
    return Effect.die(new Error(authorMessages.navigationReturn))
  }
  return Effect.flatMap(Effect.serviceOption(AuthorAction), (action) =>
    afterAction(
      Effect.provideService(
        command.run,
        AuthorAction,
        action._tag === "Some" ? action.value : "unknown",
      ).pipe(
        Effect.catch((error) => {
          const reason =
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : String(error)
          const refusal = { _tag: "NavigationRefused", reason } as const
          const recoveryCommands = new Set<import("./author-commands.ts").RuntimeCommand>()
          return Effect.suspend(() => spec.onRefused?.(refusal, { state }) ?? Effect.void).pipe(
            Effect.flatMap((value) =>
              value !== undefined || recoveryCommands.size > 0
                ? Effect.die(new Error(authorMessages.refusalRecovery))
                : Effect.fail(refusal),
            ),
            Effect.provideService(IssuedCommands, recoveryCommands),
          )
        }),
      ) as Effect.Effect<void, unknown>,
    ),
  )
}

export const authorActionBuilder = (tag?: string): M.EffectActionBuilder<Erased> => {
  const build = (spec: ActionSpec, navigates = false) =>
    actionBuilder<Erased>()({
      ...spec,
      available: (s) =>
        tag !== undefined && !matches(s, tag)
          ? `Requires ${tag} state`
          : (spec.available?.(s) ?? true),
      handler: (input, access) => {
        const state = stateAccess(access, tag)
        const issued = new Set<import("./author-commands.ts").RuntimeCommand>()
        return Effect.suspend(() => {
          if (spec.reducer !== undefined) {
            return state.update((s) => spec.reducer?.(input, s))
          }
          const result = spec.handler?.(input, { state })
          const effect = Effect.isEffect(result) ? result : Effect.succeed(result)
          return Effect.flatMap(effect, (value) => {
            if (isCommand(value)) {
              issued.delete(value)
            }
            if (issued.size > 0) {
              return Effect.die(new Error(authorMessages.discardedCommand))
            }
            if (navigates) {
              return runCommand(value, spec, state)
            }
            return isCommand(value)
              ? Effect.die(new Error(authorMessages.plainNavigation))
              : Effect.void
          })
        }).pipe(Effect.provideService(IssuedCommands, issued))
      },
    })
  return Object.assign((spec: ActionSpec) => build(spec), {
    when: (next: string) => authorActionBuilder(next),
    reduce: (spec: ActionSpec) => build(spec),
    navigates: (spec: ActionSpec) => build(spec, true),
  }) as Erased
}
