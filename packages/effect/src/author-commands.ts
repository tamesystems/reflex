import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import type { Erased } from "./erased.ts"

export const COMMAND = Symbol("reflex/navigation-command")
export interface RuntimeCommand {
  readonly [COMMAND]: true
  readonly kind: "navigation"
  readonly run: Effect.Effect<void, unknown, Erased>
}
export class IssuedCommands extends Context.Service<IssuedCommands, Set<RuntimeCommand>>()(
  "@reflex/effect/IssuedCommands",
) {}
export const isCommand = (value: unknown): value is RuntimeCommand =>
  typeof value === "object" && value !== null && COMMAND in value

/** A getter records commands even when a handler discards its expression. */
export const navigationCommand = (run: RuntimeCommand["run"]): RuntimeCommand => {
  const command: RuntimeCommand = { [COMMAND]: true, kind: "navigation", run }
  const fiber = Fiber.getCurrent()
  if (fiber !== undefined) {
    const issued = Context.getOption(fiber.context, IssuedCommands)
    if (Option.isSome(issued)) {
      issued.value.add(command)
    }
  }
  return command
}

export class AuthorAction extends Context.Service<AuthorAction, string>()(
  "@reflex/effect/AuthorAction",
) {}
