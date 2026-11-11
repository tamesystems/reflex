import {
  legacyDefineApp as defineApp,
  legacyDefineNavigation as defineNavigation,
} from "@reflex/effect/internal"
import { defineScreen, defineCapability } from "@reflex/effect"
import type { InferState, InferError } from "@reflex/effect"
import { defineStoreNode, standardInput } from "@reflex/runtime"
import { createTestAppPool } from "@reflex/test"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import { z } from "zod"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"

const firstIdentity = Symbol("First")
const secondIdentity = Symbol("Second")
const First = defineScreen({
  identity: firstIdentity,
  name: "Same",
  state: Schema.Number,
  initial: () => 0,
})
const Second = defineScreen({
  identity: secondIdentity,
  name: "Same",
  state: Schema.Number,
  initial: () => 0,
})
const Nav = defineNavigation("nominal", { First })
const Impl = First.implement({ actions: () => ({}) })
const Foreign = Second.implement({ actions: () => ({}) })
Nav.layer({ screens: { First: Impl }, initial: "First" })
// @ts-expect-error Explicit unique tokens distinguish even same-name/same-shape contracts.
Nav.layer({ screens: { First: Foreign }, initial: "First" })
const OtherName = defineScreen({ name: "Other", state: Schema.Number, initial: () => 0 }).implement(
  { actions: () => ({}) },
)
// @ts-expect-error A slot checks its contract's literal name.
Nav.layer({ screens: { First: OtherName }, initial: "First" })
defineNavigation("bare", {
  // @ts-expect-error Navigation requires contracts rather than bare capabilities.
  OtherName: defineCapability({
    name: "Other",
    state: Schema.Number,
    initial: () => 0,
    actions: () => ({}),
  }),
})

const Tuple = defineScreen({
  name: "Tuple",
  state: Schema.Tuple([Schema.String, Schema.Number]),
  initial: () => ["a", 1],
}).implement({ actions: () => ({}) })
const tuple: InferState<typeof Tuple> = ["a", 1]
void tuple
// @ts-expect-error Tuple positions remain distinct.
const swapped: InferState<typeof Tuple> = [1, "a"]
// @ts-expect-error Tuple length is preserved.
const empty: InferState<typeof Tuple> = []
void swapped
void empty
const URL = defineScreen({
  name: "URL",
  state: Schema.Number,
  params: Schema.Struct({ a: Schema.String, b: Schema.String }),
  initial: () => 0,
})
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
const app = defineApp({
  name: "nominal",
  navigation: Nav.implement({ First: Impl }, { initial: "First" }),
  scenarios: { default: { layer: Layer.empty } },
  defaultScenario: "default",
})
export const checkRaw = async () => {
  const pool = createTestAppPool()
  const session = await pool.open(app)
  // @ts-expect-error Raw controls do not appear on a typed session.
  await session.precondition("Bogus")
  await session.raw.precondition("Same")
  await pool.disposeAll()
}
defineCapability({
  name: "Raw",
  state: Schema.Number,
  actions: () => ({
    // @ts-expect-error Action maps only accept checked builder values.
    Bad: { input: Schema.Number, handler: (value: string) => Effect.succeed(value) },
  }),
})

const NoErrors = defineCapability({
  name: "NoErrors",
  state: Schema.Number,
  actions: (action) => ({ Run: action({ handler: () => Effect.void }) }),
})
// @ts-expect-error An action with no declared errors cannot invent an InferError value.
const noError: InferError<typeof NoErrors, "Run"> = { _tag: "invented" }
void noError
const Errors = defineCapability({
  name: "Errors",
  state: Schema.Number,
  actions: (action) => ({
    Fail: action({
      error: Schema.Union([
        Schema.TaggedStruct("A", { a: Schema.String }),
        Schema.TaggedStruct("B", { b: Schema.Number }),
      ]),
      handler: () => Effect.fail({ _tag: "A", a: "no" }),
    }),
  }),
})
export const declaredErrors = async (
  node: import("@reflex/test").JourneyNode<typeof Errors, unknown>,
) => {
  const { error } = await node.expectFailure.Fail()
  if (error.tag === "A") {
    const value: string = error.data.a
    void value
    // @ts-expect-error Checking the declared tag narrows its data.
    error.data.b
  }
  const completed: "completed" = (await node.actions.Fail()).status
  void completed
}

const opaqueNavigation = Layer.merge(
  Nav.layer({ screens: { First: Impl }, initial: "First" }),
  Nav.layer({ screens: { First: Impl }, initial: "First" }),
)
defineApp({
  name: "opaque",
  // @ts-expect-error Opaque Layer composition loses the navigator keys needed by defineApp.
  root: opaqueNavigation,
  scenarios: { default: { layer: Layer.empty } },
  defaultScenario: "default",
})

// @ts-expect-error Navigation depends on contracts, even when an implementation carries their identity.
defineNavigation("implementation", { First: Impl })
