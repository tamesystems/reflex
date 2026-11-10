import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

/** Per-invocation queue: navigation runs after the handler's fiber has completed. */
export class ActionNavigation extends Context.Service<
  ActionNavigation,
  { readonly pending: Effect.Effect<void, unknown>[] }
>()("@reflex/effect/ActionNavigation") {}

export const afterAction = <E>(navigation: Effect.Effect<void, E>): Effect.Effect<void, E> =>
  Effect.flatMap(Effect.serviceOption(ActionNavigation), (queue) => {
    if (queue._tag === "None") {
      return navigation
    }
    return Effect.sync(() => {
      queue.value.pending.push(navigation)
    })
  })
