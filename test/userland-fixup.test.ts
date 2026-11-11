import { expect, test } from "bun:test"
import { defineStoreApp, defineStoreNode } from "@reflex/runtime"
import { defineApp, Screen } from "@reflex/effect"
import * as Schema from "effect/Schema"
import { createTestApp } from "@reflex/test"
import { createStore } from "zustand/vanilla"
import app from "../examples/inventory/src/app.ts"
import { InventoryList, InventoryDetail } from "../examples/inventory/src/screens.ts"

const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => 0),
  actions: () => ({}),
})
test("store scenarios reject widened collisions and ambiguous defaults without mutating the base", () => {
  const base = defineStoreApp({ name: "scenarios", services: [Counter] })
  const extended = base.withScenarios({
    seeded: { stores: [Counter.withStore(() => createStore(() => 10))] },
  })
  expect(base.scenarioNames).toEqual(["default"])
  expect(extended.defaultScenario).toBe("default")
  const duplicate: Record<string, Record<never, never>> = { seeded: {} }
  expect(() => Reflect.apply(extended.withScenarios, extended, [duplicate])).toThrow(
    "Scenario seeded already exists; choose a new name",
  )
  const ambiguous: Record<string, Record<never, never>> = { one: {}, two: {} }
  expect(() => defineStoreApp({ name: "ambiguous", scenarios: ambiguous })).toThrow(
    "Apps with multiple scenarios require defaultScenario",
  )
})

test("ordinary descriptor collections agree with their runtime shape", () => {
  const Home = Screen.define("Home", {
    state: Schema.Number,
    initial: () => 0,
    actions: () => ({}),
  })
  const effect = defineApp({ name: "collections", screens: [Home] })
  expect(effect.screens).toEqual([Home])
  expect(() =>
    Reflect.apply(defineApp, undefined, [{ name: "invalid", layer: { hello: 1 } }]),
  ).toThrow("layer must be an Effect Layer")
  expect(() =>
    Reflect.apply(defineApp, undefined, [{ name: "invalid", fixtures: [Home] }]),
  ).toThrow("fixtures accepts only fixtures")
  expect(Object.hasOwn(effect, "fixtures")).toBe(false)
  expect(Object.hasOwn(effect, "provided")).toBe(false)
  const store = defineStoreApp({ name: "collections", services: [Counter] })
  expect(store.services).toEqual([Counter])
})

test("production inventory is a real session-local offline service", async () => {
  await using session = await createTestApp(app)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  expect((await list.state()).products).toHaveLength(3)
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, { _tag: "editing" })
  await detail.actions.SetQuantity({ quantity: 12 })
  await detail.actions.Save()
  await session.back()
  const saved = await session.focused(InventoryList, { _tag: "ready" })
  expect(
    (await saved.state()).products.find((product) => product.id === "product-123")?.quantity,
  ).toBe(12)
})

test("JSON error brands/defaults pass while changed values require an explicit projection", async () => {
  const { z } = await import("zod")
  const Brand = z.string().brand<"Code">()
  const Errors = defineStoreNode({
    name: "Errors",
    store: () => createStore(() => 0),
    actions: (a) => ({
      Brand: a({ error: Brand, handler: (_, { fail }) => fail(Brand.parse("code")) }),
      Default: a({ error: z.string().default("default"), handler: (_, { fail }) => fail("code") }),
      Transform: a({
        error: z.number().transform((n) => n + 1),
        handler: (_, { fail }) => fail(1),
      }),
      Trim: a({ error: z.string().trim(), handler: (_, { fail }) => fail(" code ") }),
      Projected: a({
        error: z.number().transform((n) => n + 1),
        projectError: (n) => n,
        handler: (_, { fail }) => fail(1),
      }),
    }),
  })
  await using session = await createTestApp(
    defineStoreApp({ name: "error-validation", services: [Errors] }),
  )
  const errors = await session.service(Errors)
  expect((await errors.actions.Brand.expectError()).error).toEqual(Brand.parse("code"))
  expect((await errors.actions.Default.expectError()).error).toEqual(Brand.parse("code"))
  for (const action of [errors.actions.Transform, errors.actions.Trim]) {
    expect(await action.run()).toMatchObject({
      status: "defect",
      message: expect.stringContaining("Transformed store errors require projectError"),
    })
  }
  expect((await errors.actions.Projected.expectError()).error).toBe(1)
})

test("host-neutral developmentBridge has the same controller-to-disposer shape as host helpers", async () => {
  const { developmentBridge } = await import("@reflex/live/dev")
  expect(developmentBridge).toBeFunction()
  // The no-op has no reason to inspect its controller.
  const dispose = Reflect.apply(developmentBridge, undefined, [{}])
  expect(dispose).toBeFunction()
  expect(dispose()).toBeUndefined()
})
