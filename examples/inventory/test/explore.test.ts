import { expect, test } from "bun:test"
import type { InspectResult } from "@reflex/protocol"
import {
  type ActionsOf,
  type Capability,
  defineApp,
  defineCapability,
  mount,
  NoParams,
} from "@reflex/effect"
import { Registry } from "@reflex/effect/internal"
import { explore, inputsFor } from "@reflex/test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import app from "../src/app.ts"

const hostWithInput = (inputs: Array<unknown>) => {
  const Recording = defineCapability({
    name: "Recording",
    state: NoParams,
    actions: (action) => ({
      Go: action({
        input: Schema.NullOr(Schema.String),
        handler: (input) => Effect.sync(() => inputs.push(input)),
      }),
    }),
  })
  return focusedApp(Recording)
}

const focusedApp = <A extends ActionsOf<Record<string, never>>>(
  capability: Capability<Record<string, never>, A, never>,
) =>
  defineApp({
    name: "explored",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(capability, {})
        const registry = yield* Registry
        registry.setFocus(node.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })

const hangingHost = focusedApp(
  defineCapability({
    name: "Hanging",
    state: NoParams,
    actions: (action) => ({ Hang: action({ handler: () => Effect.never }) }),
  }),
)

const knownInputs = [
  inputsFor(app.nodes.InventoryList, {
    OpenProduct: [{ productId: "product-123" }, { productId: "product-456" }],
  }),
]

const quantityNeverNegative = ({ node }: InspectResult) => {
  const state = node?.state
  if (typeof state !== "object" || state === null || !("quantity" in state)) {
    return undefined
  }
  return Number(state.quantity) < 0 ? `Negative quantity: ${state.quantity}` : undefined
}

test("random walks hold the invariants and reach every screen's actions", async () => {
  const result = await explore(app, {
    runCount: 15,
    stepCount: 25,
    seed: 7,
    knownInputs,
    invariant: quantityNeverNegative,
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
    stepCount: 15,
    seed: 3,
    knownInputs,
  })
  expect(result.failure).toBeUndefined()
}, 30_000)

test("a violated invariant is reported with a shrunk reproduction", async () => {
  const result = await explore(app, {
    runCount: 20,
    stepCount: 25,
    seed: 11,
    invariant: ({ node }) => (node?.name === "Settings" ? "Reached Settings" : undefined),
  })
  expect(result.failure?.message).toBe("Reached Settings")
  expect(result.failure?.steps.map((step) => step.action).at(-1)).toMatch(/OpenSettings|Navigate/)
  expect(result.failure?.steps.length).toBeLessThanOrEqual(2)
}, 30_000)

test("shrinking removes a push and its back together, across seeds", async () => {
  for (const seed of [7, 8, 11, 12]) {
    const result = await explore(app, {
      runCount: 20,
      stepCount: 25,
      seed,
      invariant: ({ node }) => (node?.name === "Settings" ? "Reached Settings" : undefined),
    })
    expect(result.failure?.steps.length).toBeLessThanOrEqual(2)
  }
}, 60_000)

test("the run and step counts and the seed are checked", async () => {
  await expect(explore(app, { runCount: 0 })).rejects.toThrow("runCount")
  await expect(explore(app, { stepCount: 1_001 })).rejects.toThrow("stepCount")
  await expect(explore(app, { seed: 1.5 })).rejects.toThrow("seed")
  await expect(explore(app, { seed: Number.MAX_SAFE_INTEGER })).rejects.toThrow("seed")
})

test("the invariant is checked before the first step", async () => {
  let checkCount = 0
  const result = await explore(app, {
    runCount: 1,
    stepCount: 1,
    invariant: () => {
      checkCount++
      return checkCount === 1 ? "Bad from the start" : undefined
    },
  })
  expect(result.failure).toMatchObject({ message: "Bad from the start", steps: [] })
})

test("a null among known inputs is used, not replaced by a generated one", async () => {
  const inputs: Array<unknown> = []
  const result = await explore(hostWithInput(inputs), {
    runCount: 1,
    stepCount: 3,
    knownInputs: [{ node: "Recording", inputs: { Go: [null] } }],
  })
  expect(result.failure).toBeUndefined()
  expect(inputs.length).toBeGreaterThan(0)
  expect(new Set(inputs)).toEqual(new Set([null]))
})

test("a step that never finishes is a failure with its seed", async () => {
  const result = await explore(hangingHost, { runCount: 1, stepCount: 1 })
  expect(result.failure?.message).toContain("did not finish")
  expect(result.failure?.seed).toBe(1)
}, 15_000)
