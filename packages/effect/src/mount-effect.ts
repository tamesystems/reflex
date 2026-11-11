import { createRuntime } from "@reflex/runtime/internal"
import type { ActionOutcome, OwnedNode } from "@reflex/runtime/advanced"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import { AUTHOR, type AuthorDefinition } from "./author-screen.ts"
import type * as M from "./author-model.ts"
import { Registry, mountOwned } from "./capability.ts"
import type { Erased } from "./erased.ts"

let sequence = 0

/** Mount an authored definition in a child scope, using the app registry when present. */
export const mountEffect = <D extends M.AnyDef>(
  definition: D,
): Effect.Effect<OwnedNode<D>, never, D[typeof M.authorTypes]["requirements"] | Scope.Scope> =>
  Effect.gen(function* () {
    const existing = yield* Effect.serviceOption(Registry)
    const runtime =
      existing._tag === "Some"
        ? existing.value
        : createRuntime({ sessionId: `effect-owned-${++sequence}` })
    if (existing._tag === "None") {
      yield* Effect.addFinalizer(() => Effect.sync(() => runtime.close()))
    }
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
    const meta = (definition as unknown as AuthorDefinition)[AUTHOR]
    const capability = meta.capability
    const node = yield* mountOwned(capability, capability.initial({})).pipe(
      Effect.provideService(Registry, runtime),
      Scope.provide(scope),
    )
    if (meta.role === "screen") {
      runtime.setFocus(node.id)
    }
    return {
      definition,
      get state() {
        return node.getSnapshot()
      },
      changes: {
        subscribe: (listener: (state: Erased) => void) =>
          node.subscribe(() => listener(node.getSnapshot())),
      },
      actions: Object.fromEntries(
        Object.keys(node.actions).map((name) => {
          let pending = 0
          return [
            name,
            {
              get available() {
                return node.availability(name) === true
              },
              get reason() {
                const verdict = node.availability(name)
                return verdict === true ? null : verdict
              },
              get pending() {
                return pending > 0
              },
              async run(...args: unknown[]): Promise<ActionOutcome<unknown>> {
                pending++
                try {
                  const outcome = await (node.actions as Erased)[name](...args)
                  if (outcome.status === "domain-error") {
                    return { status: "error", error: outcome.error.data }
                  }
                  if (outcome.status === "defect" && outcome.error.tag === "ResourceExhausted") {
                    return { status: "refused", reason: outcome.error.message }
                  }
                  if (outcome.status === "defect") {
                    return { status: "defect", message: outcome.error.message }
                  }
                  return outcome
                } finally {
                  pending--
                }
              },
            },
          ]
        }),
      ),
      async dispose() {
        node.dispose()
        await Effect.runPromise(Scope.close(scope, Exit.void))
      },
    } as OwnedNode<D>
  }) as Effect.Effect<OwnedNode<D>, never, D[typeof M.authorTypes]["requirements"] | Scope.Scope>
