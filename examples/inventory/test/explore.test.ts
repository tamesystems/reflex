import { expect, test } from "bun:test"
import { explore } from "@reflex/test"
import app from "../src/scenarios.ts"

const knownInputs = {
  InventoryList: { OpenProduct: [{ productId: "product-123" }, { productId: "product-456" }] },
}

test("exploration keeps quantities nonnegative", async () => {
  const result = await explore(app, {
    runCount: 15,
    stepCount: 25,
    seed: 7,
    knownInputs,
    invariants: {
      InventoryDetail: (state) =>
        state._tag === "editing" || state._tag === "saving"
          ? state.quantity < 0
            ? `Negative quantity: ${state.quantity}`
            : undefined
          : undefined,
    },
  })
  expect(result.failure).toBeUndefined()
  expect(result.actionsCovered).toEqual(
    expect.arrayContaining(["Save", "SetQuantity", "OpenSettings"]),
  )
}, 30_000)

test("the slow-network scenario explores under virtual time", async () => {
  const result = await explore(app, {
    scenario: "slow-network",
    runCount: 5,
    stepCount: 15,
    seed: 3,
    knownInputs,
  })
  expect(result.failure).toBeUndefined()
}, 30_000)
