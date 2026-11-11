import {
  legacyDefineApp as defineApp,
  legacyDefineNavigation as defineNavigation,
} from "@reflex/effect/internal"
import { defineCapability, defineScreen } from "@reflex/effect"
import type { NodeOf } from "@reflex/effect/advanced"
import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { z } from "zod"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"
import { createTestAppPool, explore } from "@reflex/test"

const DetailContract = defineScreen({
  name: "Detail",
  state: Schema.TaggedStruct("editing", { quantity: Schema.Number }),
  params: Schema.Struct({ productId: Schema.String }),
  initial: () => ({ _tag: "editing" as const, quantity: 0 }),
})
const Detail = DetailContract.implement({
  actions: (action) => ({
    SetQuantity: action.when("editing").reduce({
      input: Schema.Struct({ quantity: Schema.Number }),
      reducer: ({ quantity }, state) => ({ ...state, quantity }),
    }),
  }),
})
const HomeContract = defineScreen({
  name: "Home",
  state: Schema.Number,
  initial: () => 0,
})
const Home = HomeContract.implement({ actions: () => ({}) })
const Nav = defineNavigation("types", { Detail: DetailContract, Home: HomeContract })
defineNavigation("invalid", {
  // @ts-expect-error Navigation screens must own initial(params).
  Missing: defineCapability({ name: "Missing", state: Schema.Number, actions: () => ({}) }),
})

const app = defineApp({
  name: "typed",
  root: Nav.layer({ screens: { Detail, Home }, initial: { route: "Home", params: {} } }),
  nodes: { Detail, Home },
  scenarios: { default: { layer: Layer.empty } },
  defaultScenario: "default",
})
defineApp({
  name: "bad",
  root: Layer.empty,
  scenarios: { default: { layer: Layer.empty } },
  // @ts-expect-error The default must name a defined scenario.
  defaultScenario: "missing",
})

export const contracts = async (node: NodeOf<typeof Detail>) => {
  const pool = createTestAppPool()
  const session = await pool.open(app, { scenario: "default" })
  // @ts-expect-error Scenario names derive from app.
  await pool.open(app, { scenario: "missing" })
  const detail = await session.focused(Detail, { _tag: "editing" })
  const quantity: number = (await detail.state()).quantity
  await detail.actions.SetQuantity({ quantity })
  await session.focused(
    // @ts-expect-error Tests accept only nodes declared by this app.
    defineCapability({
      name: "Foreign",
      state: Schema.Number,
      initial: () => 0,
      actions: () => ({}),
    }),
  )
  // @ts-expect-error The state match is checked too.
  await session.focused(Detail, { quantity: "wrong" })
  // @ts-expect-error Missing required input.
  await detail.actions.SetQuantity()
  // @ts-expect-error Wrong input.
  await detail.actions.SetQuantity({ quantity: "wrong" })
  // @ts-expect-error Wrong route param.
  Nav.push("Detail", { productId: 123 })
  // @ts-expect-error Extra route param.
  Nav.push("Detail", { productId: "x", nonsense: true })
  // @ts-expect-error Unknown route.
  Nav.push("Missing")
  Nav.push("Home")
  Nav.push("Detail", { productId: "x" })
  expoRoutes(Nav, { Home: "/", Detail: { pathname: "/detail/[id]", params: { productId: "id" } } })
  // @ts-expect-error Mapper keys derive from route params.
  expoRoutes(Nav, { Home: "/", Detail: { pathname: "/detail/[id]", params: { id: "id" } } })
  await explore(app, { knownInputs: { Detail: { SetQuantity: [{ quantity: 1 }] } } })
  // @ts-expect-error Exploration inputs derive from the node's actions.
  await explore(app, { knownInputs: { Detail: { SetQuantity: [{ quantity: "wrong" }] } } })
  // @ts-expect-error Unknown action.
  await explore(app, { knownInputs: { Detail: { Save: [{}] } } })
  await node.actions.SetQuantity({ quantity: 2 })
  await pool.disposeAll()
}

export const Store = defineStoreNode({
  name: "Store",
  store: () => ({ getState: () => ({ count: 0 }), subscribe: () => () => undefined }),
  project: (state) => state,
  actions: (action) => ({
    Parse: action({
      input: standardInput(z.string().transform(Number)),
      handler: (input) => {
        const number: number = input
        return number
      },
    }),
    Fail: action({
      error: z.strictObject({ _tag: z.literal("Rejected"), message: z.string() }),
      handler: (_, { fail }) => fail({ _tag: "Rejected", message: "no" }),
    }),
    BadFailure: action({
      error: z.strictObject({ _tag: z.literal("Rejected") }),
      handler: (_, { fail }) => {
        // @ts-expect-error Store failures match their declared schema.
        return fail({ _tag: "Wrong" })
      },
    }),
  }),
})
export const storeConsumer = (node: ReturnType<typeof Store.mount>) => {
  void node.actions.Parse("12")
  // @ts-expect-error A transformed input's consumer uses the wire input, not the decoded number.
  void node.actions.Parse(12)
  // @ts-expect-error Unknown action.
  void node.actions.Missing()
  const count: number = node.getSnapshot().count
  return count
}

const storeApp = defineStoreApp({ name: "store", nodes: { Store } })
export const scenarioContracts = () => {
  const extended = storeApp.withScenarios(
    {
      seeded: {
        stores: {
          Store: () => ({ getState: () => ({ count: 12 }), subscribe: () => () => undefined }),
        },
      },
    },
    { defaultScenario: "seeded" },
  )
  defineStoreApp({
    name: "bad",
    nodes: { Store },
    scenarios: { valid: {} },
    // @ts-expect-error A store app default must name a scenario.
    defaultScenario: "missing",
  })
  // @ts-expect-error Composed defaults must name an existing or added scenario.
  storeApp.withScenarios({ seeded: {} }, { defaultScenario: "missing" })
  storeApp.withScenarios({
    bad: {
      stores: {
        // @ts-expect-error Store overrides retain the definition's state type.
        Store: () => ({ getState: () => ({ count: "wrong" }), subscribe: () => () => undefined }),
      },
    },
  })
  return extended
}

// Round two: contracts establish state and routes before any handlers import navigation.
import type { InferState, InferInput, InferError } from "@reflex/effect"
import { NavigationRefused } from "@reflex/effect/advanced"
import * as Effect from "effect/Effect"
import { includes } from "@reflex/test"
import { serveLive } from "@reflex/live"
const First = defineScreen({
  name: "First",
  state: Schema.TaggedStruct("ready", {}),
  initial: () => ({ _tag: "ready" }),
})
const Second = defineScreen({
  name: "Second",
  state: Schema.Number,
  params: Schema.Struct({ id: Schema.String }),
  initial: () => 0,
})
const ContractNav = defineNavigation("contracts/one", { First, Second })
const OtherNav = defineNavigation("contracts/two", { First, Second })
const FirstImpl = First.implement({
  actions: (action) => ({
    Open: action({
      error: NavigationRefused,
      handler: () => ContractNav.push("Second", { id: "one" }),
    }),
    Empty: action({
      handler: (input) => {
        // @ts-expect-error No schema means void, never an unchecked input.
        input.foo
        return Effect.void
      },
    }),
    // @ts-expect-error Handler annotations cannot invent an input schema.
    Invented: action({ handler: (input: number) => Effect.succeed(input) }),
  }),
})
const SecondImpl = Second.implement({ actions: () => ({}) })
export const contractNavigation = (route: "First" | "Second") => {
  // @ts-expect-error A union route cannot be paired with just one member's params.
  ContractNav.push(route, { id: "one" })
  const onlyOther = OtherNav.layer({
    screens: { First: FirstImpl, Second: SecondImpl },
    initial: { route: "First", params: {} },
  })
  // @ts-expect-error Navigator service identity includes its literal key.
  const wrong: Layer.Success<typeof onlyOther> = null as unknown as Effect.Services<
    ReturnType<typeof ContractNav.push>
  >
  return wrong
}
const NoMembers = defineApp({
  name: "no-members",
  root: Layer.empty,
  scenarios: { default: { layer: Layer.empty } },
  defaultScenario: "default",
})
export const strictMembers = async () => {
  const session = await createTestAppPool().open(NoMembers)
  // @ts-expect-error Omitting membership never means accept every definition.
  await session.focused(Home)
  // @ts-expect-error Exploration scenario names derive from the host.
  await explore(NoMembers, { scenario: "missing" })
  // @ts-expect-error Live serving has the same scenario contract.
  await serveLive(NoMembers, { setting: "unused", scenario: "missing" })
}
const UnknownStore = defineStoreNode({
  name: "Unknown",
  store: () => ({ getState: () => ({ value: 0 }), subscribe: () => () => undefined }),
  project: (s) => s,
  actions: (action) => ({
    Unknown: action({
      input: standardInput(z.unknown(), {}),
      handler: (value) => {
        // @ts-expect-error A real unknown input is not usable without narrowing.
        value.field
      },
    }),
    Empty: action({
      handler: (value, context) => {
        // @ts-expect-error No schema means void.
        value.field
        // @ts-expect-error Action has no declared error.
        context.fail({ message: "undeclared" })
      },
    }),
    // @ts-expect-error No schema cannot be overridden by a handler annotation.
    Invented: action({ handler: (value: number) => value }),
  }),
})
export const unknownPresence = (node: ReturnType<typeof UnknownStore.mount>) => {
  node.actions.Unknown(undefined)
  // @ts-expect-error Unknown is still a present input schema and takes one argument.
  node.actions.Unknown()
  // @ts-expect-error No input takes zero arguments.
  node.actions.Empty(1)
  // @ts-expect-error Snapshots are deeply readonly.
  node.getSnapshot().value = 2
}
defineStoreNode({
  name: "invalid-projection",
  store: () => ({ getState: () => new Date(), subscribe: () => () => undefined }),
  // @ts-expect-error Projections must be JSON values.
  project: (state) => state,
  actions: () => ({}),
})
const Big = defineScreen({ name: "Big", state: Schema.BigInt, initial: () => 12n }).implement({
  actions: () => ({}),
})
const wireBig: InferState<typeof Big> = "12"
// @ts-expect-error BigInts arrive as strings on the wire.
const wrongBig: InferState<typeof Big> = 12n
const quantityInput: InferInput<typeof Detail, "SetQuantity"> = { quantity: 1 }
const refusal: InferError<typeof FirstImpl, "Open"> = {
  _tag: "NavigationStackFull",
  message: "full",
}
export const inferredTypes = { wireBig, wrongBig, quantityInput, refusal }
const bindings = expoRoutes(
  { screens: { First: FirstImpl, Second: SecondImpl } },
  { First: "/", Second: { pathname: "/second/[id]", params: { id: "id" } } },
)
// @ts-expect-error Router projection plumbing is absent from the consumer surface.
bindings.toHref({ route: "Nope" })
const NumberRoute = defineScreen({
  name: "NumberRoute",
  state: Schema.Number,
  params: Schema.Struct({ id: Schema.Number }),
  initial: () => 0,
}).implement({ actions: () => ({}) })
expoRoutes(
  { screens: { NumberRoute } },
  // @ts-expect-error URL fields must encode strings, with the field identified in the diagnostic.
  { NumberRoute: { pathname: "/number/[id]", params: { id: "id" } } },
)
export const readableMatches = includes({ id: "one", quantity: 1 })

// Literal actions cannot smuggle unchecked parameters or a failure helper past the builder.
defineStoreNode({
  name: "raw",
  store: () => ({ getState: () => 0, subscribe: () => () => undefined }),
  project: (s) => s,
  actions: () => ({
    // @ts-expect-error Raw action objects must pass through the checked builder.
    Raw: {
      handler: (value, context) => {
        // @ts-expect-error Plain handlers receive unknown, rather than any; use action({input, handler}) for schema inference.
        value.field
        // @ts-expect-error Undeclared raw actions have no fail helper.
        context.fail("no")
      },
    },
  }),
})
const OptionalRoute = defineScreen({
  name: "Optional",
  state: Schema.Number,
  params: Schema.Struct({ query: Schema.optionalKey(Schema.String) }),
  initial: () => 0,
}).implement({ actions: () => ({}) })
// @ts-expect-error Optional-only params still require a mapping.
expoRoutes({ screens: { OptionalRoute } }, { OptionalRoute: "/optional" })
expoRoutes(
  { screens: { Second: SecondImpl } },
  {
    // @ts-expect-error Every pathname placeholder must name a mapped URL param.
    Second: { pathname: "/second/[wrong]", params: { id: "id" } },
  },
)
export const noOwnership = (node: NodeOf<typeof Detail>) => {
  // @ts-expect-error Consumer handles do not own disposal.
  node.dispose()
  // @ts-expect-error Decoded dispatch is an explicit advanced function.
  node.send("SetQuantity", { quantity: 1 })
}

// @ts-expect-error Optional fields still need a URL field-name mapping.
expoRoutes({ screens: { OptionalRoute } }, { OptionalRoute: { pathname: "/optional", params: {} } })
