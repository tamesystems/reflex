import { expect, test } from "bun:test"
import { Screen, defineService } from "@reflex/effect"
import { mountEffect } from "@reflex/effect/advanced"
import { NODE_STATE_CHARACTERS_MAX } from "@reflex/protocol"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import * as Exit from "effect/Exit"

import * as Schema from "effect/Schema"

class Amount extends Context.Service<Amount, number>()("owned/Amount") {}
const Counter = Screen.define("Counter", {
  state: Schema.NumberFromString,
  initial: () => 0,
  actions: (a) => ({
    Add: a({
      handler: (_, { state }) => Effect.flatMap(Amount, (n) => state.update((s) => s + n)),
    }),
    Set: a({ input: Schema.NumberFromString, handler: (n, { state }) => state.set(n) }),
    Reject: a({ error: Schema.NumberFromString, handler: () => Effect.fail(3) }),
    Crash: a({ handler: () => Effect.die(new Error("broken")) }),
    Wait: a({ handler: () => Effect.never }),
  }),
})

test("scoped ownership focuses screens, provides dependencies and publishes encoded state and errors", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const node = yield* mountEffect(Counter)
        const changes: string[] = []
        const stop = node.changes.subscribe((state) => changes.push(state))
        expect(node.definition).toBe(Counter)
        expect(node.actions.Add.available).toBe(true)
        expect(node.actions.Add.reason).toBeNull()
        expect(yield* Effect.promise(() => node.actions.Add.run())).toEqual({ status: "completed" })
        expect(yield* Effect.promise(() => node.actions.Set.run("7"))).toEqual({
          status: "completed",
        })
        expect(node.state).toBe("7")
        expect(changes).toEqual(["2", "7"])
        stop()
        expect(yield* Effect.promise(() => node.actions.Reject.run())).toEqual({
          status: "error",
          error: "3",
        })
        expect(yield* Effect.promise(() => node.actions.Crash.run())).toEqual({
          status: "defect",
          message: "broken",
        })
      }),
    ).pipe(Effect.provideService(Amount, 2)),
  )
})

test("explicit disposal cancels pending work, revokes actions and closes only its own scope", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* mountEffect(Counter)
        const second = yield* mountEffect(Counter)
        const pending = first.actions.Wait.run()
        expect(first.actions.Wait.pending).toBe(true)
        yield* Effect.promise(() => first.dispose())
        expect(yield* Effect.promise(() => pending)).toEqual({ status: "cancelled" })
        expect(first.actions.Wait.pending).toBe(false)
        expect(yield* Effect.promise(() => first.actions.Add.run())).toMatchObject({
          status: "refused",
        })
        expect(yield* Effect.promise(() => second.actions.Add.run())).toEqual({
          status: "completed",
        })
        expect(second.state).toBe("2")
      }),
    ).pipe(Effect.provideService(Amount, 2)),
  )
})

const Full = defineService({
  name: "Full",
  state: Schema.String,
  initial: () => "before",
  actions: (a) => ({
    Fill: a.reduce({ reducer: () => "x".repeat(NODE_STATE_CHARACTERS_MAX + 1) }),
  }),
})

test("ambient owned nodes preserve resource refusals and surrounding scope cleanup", async () => {
  const scope = Effect.runSync(Scope.make())
  const node = await Effect.runPromise(mountEffect(Full).pipe(Scope.provide(scope)))
  expect(await node.actions.Fill.run()).toMatchObject({ status: "refused" })
  expect(node.state).toBe("before")
  await Effect.runPromise(Scope.close(scope, Exit.void))
  expect(await node.actions.Fill.run()).toMatchObject({ status: "refused" })
})
