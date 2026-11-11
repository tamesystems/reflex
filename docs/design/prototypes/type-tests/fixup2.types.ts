// Implicit default scenarios validate and retain top-level fixture definitions.
import { Screen, defineApp, defineService, defineFixture } from "@reflex/effect"
import * as Schema from "effect/Schema"
import { defineStoreNode } from "@reflex/runtime"
import { createTestAppPool } from "@reflex/test"
import { z } from "zod"
const Tuple = Screen.define("Tuple", {
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const NoErrors = defineService({
  name: "NoErrors",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const app = defineApp({ name: "inline", screens: [Tuple] })
const Fx = defineFixture({
  name: "Fx",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({ Set: a.reduce({ input: Schema.Number, reducer: (n) => n }) }),
})
// @ts-expect-error Top-level fixtures cannot contain a service without explicit scenarios.
defineApp({ name: "bad-fixture", screens: [Tuple], fixtures: [NoErrors] })
// @ts-expect-error Top-level fixtures cannot contain a screen without explicit scenarios.
defineApp({ name: "bad-fixture", screens: [Tuple], fixtures: [Tuple] })
// @ts-expect-error Mixed fixture arrays validate every member.
defineApp({ name: "bad-fixture", screens: [Tuple], fixtures: [Fx, NoErrors] })
const implicitFixtures = defineApp({ name: "implicit-fixtures", screens: [Tuple], fixtures: [Fx] })
export const inferredFixture = async () => {
  const pool = createTestAppPool()
  const session = await pool.open(implicitFixtures)
  await (await session.fixture(Fx)).actions.Set(2)
  // @ts-expect-error Inferred fixtures retain their action inputs.
  await (await session.fixture(Fx)).actions.Set("2")
  await pool.disposeAll()
}
import * as Layer from "effect/Layer"
const inlineScenario = app.withScenarios({
  inline: { layer: Layer.merge(Layer.empty, Layer.empty) },
})
const inlineName: "default" | "inline" | undefined = inlineScenario.scenarioNames[0]
void inlineName
const brandedErrors = defineStoreNode({
  name: "branded-errors",
  store: () => ({ getState: () => 0, subscribe: () => () => {} }),
  actions: (a) => ({
    Brand: a({
      error: z.string().brand<"Code">(),
      handler: (_, { fail }) => fail(z.string().brand<"Code">().parse("code")),
    }),
    Default: a({ error: z.string().default("code"), handler: (_, { fail }) => fail("code") }),
    SameType: a({ error: z.number().transform((n) => n + 1), handler: (_, { fail }) => fail(1) }),
  }),
})
void brandedErrors

import { explore } from "@reflex/test"
export const keyedInvariants = () =>
  explore(implicitFixtures, {
    // @ts-expect-error Invariants use one node-keyed record shape.
    invariants: async () => {},
  })

import inventory, { productionServices } from "../examples/examples/inventory/src/app.ts"
import {
  fixtureApi,
  fixtureSettings,
  InventoryFixture,
  seedProducts,
} from "../examples/examples/inventory/src/fixtures.ts"
const inlineProduction = inventory.withScenarios({
  inline: { layer: Layer.merge(productionServices, Layer.empty) },
})
const inlineFixtures = inventory.withScenarios(
  { inline: { layer: Layer.merge(fixtureApi({ products: seedProducts }), fixtureSettings) } },
  { fixtures: [InventoryFixture] },
)
const productionNames: "production" | "inline" | undefined = inlineProduction.scenarioNames[0]
const fixtureNames: "production" | "inline" | undefined = inlineFixtures.scenarioNames[0]
void productionNames
void fixtureNames
