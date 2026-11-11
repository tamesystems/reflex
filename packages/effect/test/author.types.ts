import type { InferState, InferInput, InferError } from "@reflex/runtime"
import { Screen, defineApp, defineNavigation, defineService, defineFixture } from "@reflex/effect"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

class Count extends Screen("Count", {
  state: Schema.NumberFromString,
  params: { count: Schema.NumberFromString },
  initial: ({ count }) => count,
}) {}
class Home extends Screen("Home", { state: Schema.Number, initial: () => 0 }) {}
const Nav = defineNavigation({ Count, Home })
const count = Count.implement({
  actions: (a) => ({
    Set: a({
      input: Schema.NumberFromString,
      error: Schema.NumberFromString,
      handler: (n, { state }) => (n < 0 ? Effect.fail(n) : state.set(n)),
    }),
    Back: a.navigates({ handler: () => Nav.back }),
  }),
})
const home = Home.implement({ actions: () => ({}) })
const initial: InferState<typeof count> = "1"
const input: InferInput<typeof count, "Set"> = "2"
const error: InferError<typeof count, "Set"> = "3"
void initial
void input
void error
Nav.push(Count, { count: 1 })
// @ts-expect-error Navigation params use decoded values.
Nav.push(Count, { count: "1" })
// @ts-expect-error Infer the target before checking its params.
Nav.push(Count, {})
// @ts-expect-error Param-free routes accept no second argument.
Nav.push(Home, {})
// @ts-expect-error Commands are terminal values, never yieldable Effects.
Nav.back.pipe(Effect.asVoid)
Effect.gen(function* () {
  // @ts-expect-error Commands are not yieldable.
  yield* Nav.back
})
// @ts-expect-error Implement each contract once.
Nav.implement([home, home], { initial: Home })
// @ts-expect-error Missing Count implementation.
Nav.implement([home], { initial: Home })
Home.implement({
  actions: (a) => ({
    Plain: a({
      // @ts-expect-error Navigation commands require action.navigates.
      handler: () => Effect.succeed(Nav.back),
    }),
    Error: a({
      // @ts-expect-error Declare failures with error.
      handler: () => Effect.fail("oops"),
    }),
    Input: a({
      // @ts-expect-error A handler annotation cannot replace an input codec.
      handler: (_n: number) => Effect.void,
    }),
    Nav: a.navigates({
      // @ts-expect-error Navigation actions must return a command on every branch.
      handler: () => Effect.void,
    }),
    Recovery: a.navigates({
      handler: () => Nav.back,
      // @ts-expect-error Refusal recovery returns void.
      onRefused: () => Effect.succeed(Nav.stay),
    }),
    JsonInput: a({
      // @ts-expect-error Inputs must encode JSON.
      input: Schema.Date,
      handler: () => Effect.void,
    }),
    JsonError: a({
      // @ts-expect-error Errors must encode JSON.
      error: Schema.Date,
      handler: () => Effect.fail(new Date()),
    }),
  }),
})
Home.implement({
  actions: () => ({}),
  // @ts-expect-error onFocus must handle errors into state.
  onFocus: () => Effect.fail("oops"),
})
// @ts-expect-error Action maps reject fabricated values.
Home.implement({ actions: () => ({ Save: 123 }) })
// @ts-expect-error State must encode JSON.
Screen("Date", { state: Schema.Date, initial: () => new Date() })
// @ts-expect-error Params must encode JSON.
Screen("Params", { state: Schema.Number, params: { date: Schema.Date }, initial: () => 0 })
const Wrong = Screen.define("Wrong", {
  state: Schema.String,
  initial: () => "",
  actions: (a) => ({ Set: a.reduce({ reducer: () => "" }) }),
})
// @ts-expect-error Actions are invariant in decoded state.
Home.implement({ actions: () => ({ Set: Wrong.actions.Set }) })
const Service = defineService({
  name: "Service",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
// @ts-expect-error Services cannot be screens.
defineApp({ name: "role", screens: [Service] })
// @ts-expect-error Screens cannot be ambient services.
defineApp({ name: "role", services: [home] })
// @ts-expect-error Screens with navigation actions need navigation.
defineApp({ name: "missing-navigation", screens: [count] })
class Api extends Context.Service<Api, number>()("author/types/Api") {}
const NeedsApi = defineService({
  name: "NeedsApi",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({ Read: a({ handler: () => Effect.asVoid(Api) }) }),
})
// @ts-expect-error Omitted scenarios still check production coverage.
defineApp({ name: "coverage", services: [NeedsApi] })
// @ts-expect-error A layer cannot satisfy its own inputs.
defineApp({ name: "self", services: [NeedsApi], layer: Layer.effect(Api, Api) })
const Fixture = defineFixture({
  name: "Fixture",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const base = defineApp({ name: "base", services: [NeedsApi], layer: Layer.succeed(Api, 1) })
const extended = base.withScenarios(
  { fixture: {} },
  { defaultScenario: "fixture", fixtures: [Fixture] },
)
const defaultName: "fixture" = extended.defaultScenario
void defaultName
// @ts-expect-error Scenarios cannot replace earlier names.
base.withScenarios({ default: {} })
// @ts-expect-error Defaults must exist.
base.withScenarios({ next: {} }, { defaultScenario: "missing" })
// @ts-expect-error Common layer inputs precede scenario layer outputs.
defineApp({
  name: "order",
  layer: Layer.effect(Api, Api),
  scenarios: { default: { layer: Layer.succeed(Api, 1) } },
})
