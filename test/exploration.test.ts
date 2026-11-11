import { expect, test } from "bun:test"
import { defineApp, defineService } from "@reflex/effect"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import { explore } from "@reflex/test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import inventoryDefinition from "../examples/inventory/src/scenarios.ts"
const app = inventoryDefinition

const hostWithInput = (inputs: Array<unknown>) => {
  const Recording = defineService({
    name: "Recording",
    state: Schema.Number,
    initial: () => 0,
    actions: (action) => ({
      Go: action({
        input: Schema.NullOr(Schema.String),
        handler: (input) => Effect.sync(() => inputs.push(input)),
      }),
    }),
  })
  return defineApp({
    name: "explored",
    services: [Recording],
  })[APP_HOST_ADAPTER]
}

const Hanging = defineService({
  name: "Hanging",
  state: Schema.Number,
  initial: () => 0,
  actions: (action) => ({ Hang: action({ handler: () => Effect.never }) }),
})
const hangingHost = defineApp({
  name: "explored",
  services: [Hanging],
})[APP_HOST_ADAPTER]

const knownInputs = {
  InventoryList: { OpenProduct: [{ productId: "product-123" }, { productId: "product-456" }] },
}

const quantityNeverNegative = (state: unknown) => {
  if (typeof state !== "object" || state === null || !("quantity" in state)) {
    return undefined
  }
  return Number(state.quantity) < 0 ? `Negative quantity: ${state.quantity}` : undefined
}

test("random walks hold the invariants and reach every screen's actions", async () => {
  const result = await explore(app, {
    runCount: 15,
    steps: 25,
    seed: 7,
    inputs: knownInputs,
    invariants: { InventoryDetail: quantityNeverNegative },
  })
  expect(result.failure).toBeUndefined()
  expect(result.actionsCovered).toEqual(
    expect.arrayContaining([
      "Decrement",
      "GoBack",
      "Increment",
      "Navigate",
      "OpenProduct",
      "OpenSettings",
      "Save",
      "SetLowStockThreshold",
      "SetQuantity",
    ]),
  )
}, 30_000)

test("walks survive virtual time", async () => {
  const result = await explore(app, {
    scenario: "slow-network",
    runCount: 5,
    steps: 15,
    seed: 3,
    inputs: knownInputs,
  })
  expect(result.failure).toBeUndefined()
}, 30_000)

test("a violated invariant is reported with a shrunk reproduction", async () => {
  const result = await explore(app, {
    runCount: 20,
    steps: 25,
    seed: 11,
    invariants: { Settings: () => "Reached Settings" },
  })
  expect(result.failure?.message).toBe("Reached Settings")
  expect(result.failure?.steps.map((step) => step.action).at(-1)).toMatch(/OpenSettings|Navigate/)
  expect(result.failure?.steps.length).toBeLessThanOrEqual(2)
}, 30_000)

test("shrinking removes a push and its back together, across seeds", async () => {
  for (const seed of [7, 8, 11, 12]) {
    const result = await explore(app, {
      runCount: 20,
      steps: 25,
      seed,
      invariants: { Settings: () => "Reached Settings" },
    })
    expect(result.failure?.steps.length).toBeLessThanOrEqual(2)
  }
}, 60_000)

test("the run and step counts and the seed are checked", async () => {
  await expect(explore(app, { runCount: 0 })).rejects.toThrow("runCount")
  await expect(explore(app, { steps: 1_001 })).rejects.toThrow("steps")
  await expect(explore(app, { seed: 1.5 })).rejects.toThrow("seed")
  await expect(explore(app, { seed: Number.MAX_SAFE_INTEGER })).rejects.toThrow("seed")
})

test("the invariant is checked before the first step", async () => {
  let checkCount = 0
  const result = await explore(app, {
    runCount: 1,
    steps: 1,
    invariants: {
      InventoryList: () => {
        checkCount++
        return checkCount === 1 ? "Bad from the start" : undefined
      },
    },
  })
  expect(result.failure).toMatchObject({ message: "Bad from the start", steps: [] })
})

test("a null among known inputs is used, not replaced by a generated one", async () => {
  const inputs: Array<unknown> = []
  const result = await explore(hostWithInput(inputs), {
    runCount: 1,
    steps: 3,
    inputs: { Recording: { Go: [null] } },
  })
  expect(result.failure).toBeUndefined()
  expect(inputs.length).toBeGreaterThan(0)
  expect(new Set(inputs)).toEqual(new Set([null]))
})

test("a step that never finishes is a failure with its seed", async () => {
  const result = await explore(hangingHost, { runCount: 1, steps: 1 })
  expect(result.failure?.message).toContain("did not finish")
  expect(result.failure?.seed).toBe(1)
}, 15_000)
