import * as Effect from "effect/Effect"
import type { Contract, Message } from "./contracts.ts"
import { Detail, ForeignDetail } from "./contracts.ts"

declare const terminal: unique symbol
export interface NavigationCommand<K extends string> {
  readonly [terminal]: K
  readonly kind: "navigation"
}
export interface Navigator<K extends string> {
  readonly navigator: K
}
export interface NavigationRefused {
  readonly _tag: "NavigationRefused"
  readonly reason: string
}
export declare function defineNavigation<const C extends readonly Contract[]>(
  contracts: C,
): {
  push<T extends C[number]>(
    contract: T,
    params: NoInfer<T["paramsType"]>,
  ): NavigationCommand<"default">
  readonly back: NavigationCommand<"default">
}
export declare function action<E, R, K extends string = never, Recovery = void>(spec: {
  // biome-ignore lint/suspicious/noConfusingVoidType: Effect void success is distinct from undefined.
  handler: () => Effect.Effect<void | NavigationCommand<K>, E, R>
  onRefused?: ((error: NavigationRefused) => Effect.Effect<Recovery, never, R>) &
    // biome-ignore lint/suspicious/noConfusingVoidType: Compare inferred success to void before Effect erases it.
    ([Recovery] extends [void] ? unknown : Message<"Navigation refusal recovery must return void">)
}): Effect.Effect<void, E, R | ([K] extends [never] ? never : Navigator<K>)>
const Nav = defineNavigation([Detail])
const operation = action({
  handler: () => Effect.succeed(Nav.push(Detail, { id: "one" })),
  onRefused: ({ reason }) =>
    Effect.sync(() => {
      void reason
    }),
})
const typed: Effect.Effect<void, never, Navigator<"default">> = operation
void typed
// @ts-expect-error NavigationCommand is not an Effect: refusal cannot be caught inside the handler.
Nav.back.pipe(Effect.catchTag("NavigationRefused", () => Effect.void))
// @ts-expect-error Foreign same-name nominal contract is not in Nav.
Nav.push(ForeignDetail, { id: "one" })
// @ts-expect-error Param is required and typed from the chosen contract.
Nav.push(Detail, {})
// @ts-expect-error Running requires the selected navigator; the requirement is honest.
void Effect.runPromise(operation)

const ordinary = action({ handler: () => Effect.void })
const noNavigator: Effect.Effect<void> = ordinary
void noNavigator
const recovery = action({
  handler: () => Effect.succeed(Nav.back),
  // @ts-expect-error Recovery can update state but cannot return another terminal command.
  onRefused: () => Effect.succeed(Nav.back),
})
void recovery
