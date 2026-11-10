import { defineApp, defineCapability, defineNavigation, type NodeOf } from "@reflex/effect"
import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { z } from "zod"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"
import { createTestAppPool, inputsFor } from "@reflex/test"

const Detail = defineCapability({
  name: "Detail",
  state: Schema.TaggedStruct("editing", { quantity: Schema.Number }),
  params: Schema.Struct({ productId: Schema.String }),
  initial: () => ({ _tag: "editing" as const, quantity: 0 }),
  actions: (action) => ({
    SetQuantity: action.when("editing").reduce({
      input: Schema.Struct({ quantity: Schema.Number }),
      reducer: ({ quantity }, state) => ({ ...state, quantity }),
    }),
  }),
})
const Home = defineCapability({
  name: "Home",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const Nav = defineNavigation("types", () => ({ Detail, Home }))
defineNavigation("invalid", () => ({
  // @ts-expect-error Navigation screens must own initial(params).
  Missing: defineCapability({ name: "Missing", state: Schema.Number, actions: () => ({}) }),
}))

const app = defineApp({
  name: "typed",
  root: Nav.layer({ initial: { route: "Home", params: {} } }),
  nodes: Nav.screens,
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
  const quantity: number = detail.state.quantity
  await detail.actions.SetQuantity({ quantity })
  await session.focused(
    // @ts-expect-error Tests accept only nodes declared by this app.
    defineCapability({ name: "Foreign", state: Schema.Boolean, actions: () => ({}) }),
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
  inputsFor(Detail, { SetQuantity: [{ quantity: 1 }] })
  // @ts-expect-error Exploration inputs derive from the node's actions.
  inputsFor(Detail, { SetQuantity: [{ quantity: "wrong" }] })
  // @ts-expect-error Unknown action.
  inputsFor(Detail, { Save: [{}] })
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
      error: standardInput(z.strictObject({ _tag: z.literal("Rejected"), message: z.string() })),
      handler: (_, { fail }) => fail({ _tag: "Rejected", message: "no" }),
    }),
    BadFailure: action({
      error: standardInput(z.strictObject({ _tag: z.literal("Rejected") })),
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
