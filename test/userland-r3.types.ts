import { Screen, defineApp, defineNavigation, defineService } from "@reflex/effect"
import type { InferState, InferError } from "@reflex/runtime"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import { defineStoreNode, standardInput } from "@reflex/runtime"
import { createTestAppPool } from "@reflex/test"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import { z } from "zod"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"

class First extends Screen("First", { state: Schema.Number, initial: () => 0 }) {}
class Second extends Screen("Second", { state: Schema.Number, initial: () => 0 }) {}
const Nav = defineNavigation({ First })
const Impl = First.implement({ actions: () => ({}) })
const Foreign = Second.implement({ actions: () => ({}) })
Nav.implement([Impl], { initial: First })
// @ts-expect-error A slot checks its contract's literal name.
Nav.implement([Foreign], { initial: First })
defineNavigation({
  // @ts-expect-error Navigation requires screen contracts rather than ambient services.
  Other: defineService({
    name: "Other",
    state: Schema.Number,
    initial: () => 0,
    actions: () => ({}),
  }),
})

const Tuple = Screen.define("Tuple", {
  state: Schema.Tuple([Schema.String, Schema.Number]),
  initial: () => ["a", 1],
  actions: () => ({}),
})
const tuple: InferState<typeof Tuple> = ["a", 1]
void tuple
// @ts-expect-error Tuple positions remain distinct.
const swapped: InferState<typeof Tuple> = [1, "a"]
// @ts-expect-error Tuple length is preserved.
const empty: InferState<typeof Tuple> = []
void swapped
void empty
class URL extends Screen("URL", {
  state: Schema.Number,
  params: { a: Schema.String, b: Schema.String },
  initial: () => 0,
}) {}
// @ts-expect-error Every route needs a binding.
expoRoutes({ screens: { URL } }, {})
// @ts-expect-error Param mapping targets must be unique.
expoRoutes({ screens: { URL } }, { URL: { pathname: "/[id]", params: { a: "id", b: "id" } } })

const Dates = defineStoreNode({
  name: "Dates",
  store: () => ({ getState: () => 0, subscribe: () => () => {} }),
  project: (s) => s,
  actions: (action) => ({
    Set: action({
      input: standardInput(z.date(), { type: "string" }),
      handler: (date) => {
        const decoded: Date = date
        void decoded
      },
    }),
  }),
})
export const checkDates = (node: ReturnType<typeof Dates.mount>) => {
  // @ts-expect-error Rich values cannot be supplied over the JSON transport boundary.
  void node.actions.Set(new Date())
}
const app = defineApp({ name: "nominal", navigation: Nav.implement([Impl], { initial: First }) })
export const checkRaw = async () => {
  const pool = createTestAppPool()
  const session = await pool.open(app[APP_HOST_ADAPTER])
  // @ts-expect-error Raw controls do not appear on a typed session.
  await session.precondition("Bogus")
  await session.raw.precondition("First")
  await pool.disposeAll()
}
// @ts-expect-error Action maps only accept checked builder values.
First.implement({
  actions: () => ({
    Bad: { input: Schema.Number, handler: (value: string) => Effect.succeed(value) },
  }),
})
const NoErrors = defineService({
  name: "NoErrors",
  state: Schema.Number,
  initial: () => 0,
  actions: (action) => ({ Run: action({ handler: () => Effect.void }) }),
})
// @ts-expect-error An action with no declared errors cannot invent an InferError value.
const noError: InferError<typeof NoErrors, "Run"> = { _tag: "invented" }
void noError
const Errors = defineService({
  name: "Errors",
  state: Schema.Number,
  initial: () => 0,
  actions: (action) => ({
    Fail: action({
      error: Schema.Union([
        Schema.TaggedStruct("A", { a: Schema.String }),
        Schema.TaggedStruct("B", { b: Schema.Number }),
      ]),
      handler: () => Effect.fail({ _tag: "A" as const, a: "no" }),
    }),
  }),
})
export const declaredErrors = async (
  node: import("@reflex/test").JourneyNode<typeof Errors, unknown>,
) => {
  const { error } = await node.actions.Fail.expectError()
  if (error._tag === "A") {
    const value: string = error.a
    void value
    // @ts-expect-error Checking the declared tag narrows its data.
    error.b
  }
  const completed: "completed" = (await node.actions.Fail()).status
  void completed
}
// @ts-expect-error Navigation consumes contracts rather than implementations.
defineNavigation({ First: Impl })
// @ts-expect-error Raw root layers are absent from authored composition.
defineApp({ name: "opaque", root: {} })
