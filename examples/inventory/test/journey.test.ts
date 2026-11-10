import { afterEach, expect, test } from "bun:test"
import { ErrorCode, toNodeId } from "@reflex/protocol"
import { createTestAppPool } from "@reflex/test"
import * as Schema from "effect/Schema"
import app from "../src/app.ts"
import { Product, QUANTITY_MAX } from "../src/domain.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

const parseListState = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.Literal("ready"),
    products: Schema.Array(Product),
    lowStockThreshold: Schema.Int,
  }),
)

/** The ids the list shows as low, as a screen would derive them. */
const lowStockIds = (state: unknown): ReadonlyArray<string> => {
  const { products, lowStockThreshold } = parseListState(state)
  return products.filter((product) => product.quantity < lowStockThreshold).map(({ id }) => id)
}

test("user updates inventory quantity", async () => {
  const session = await pool.open(app)
  await session.precondition("InventoryList", { _tag: "ready" })

  await session.do("OpenProduct", { productId: "product-123" })
  await session.precondition("InventoryDetail", { title: "Blue T-Shirt", quantity: 5 })

  await session.do("SetQuantity", { quantity: 12 })
  const saved = await session.do("Save")

  expect(saved.status).toBe("completed")
  expect(session.state).toMatchObject({ _tag: "editing", quantity: 12, error: null })
  expect((await session.node("InventoryFixture")).state).toMatchObject({
    saved: [{ productId: "product-123", quantity: 12 }],
  })

  await session.do("GoBack")
  await session.precondition("InventoryList", { _tag: "ready" })
  expect(session.state).toMatchObject({ products: [{ id: "product-123", quantity: 12 }, {}, {}] })
})

test("a failed save surfaces in state and as a typed operation failure", async () => {
  const session = await pool.open(app)
  await session.do("OpenProduct", { productId: "product-123" })
  await session.do("FailNextSave")

  const result = await session.do("Save")

  expect(result).toMatchObject({
    status: "failed",
    error: {
      tag: "ApiError",
      message: "Server error",
      defect: false,
      data: { _tag: "ApiError", message: "Server error" },
    },
  })
  expect(session.state).toMatchObject({ _tag: "editing", error: "Server error" })
  expect((await session.node("InventoryFixture")).state).toMatchObject({ saved: [] })

  // The failure was one-shot: retrying works and clears the error.
  expect((await session.do("Save")).status).toBe("completed")
  expect(session.state).toMatchObject({ error: null })
})

test("virtual time drives timeouts without waiting for them", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.do("OpenProduct", { productId: "product-123" })

  const operation = await session.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  await session.advanceTime(4_999)
  expect(session.state).toMatchObject({ _tag: "saving" })

  await session.advanceTime(1)
  await session.waitFor({ operationId: operation.operationId })

  expect(session.state).toMatchObject({ _tag: "editing", error: "Save timed out" })
})

test("leaving a screen cancels its in-flight save", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.do("OpenProduct", { productId: "product-123" })
  const operation = await session.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  await session.do("GoBack")
  await session.waitFor({ operationId: operation.operationId })

  const result = await session.client.request("app.operation", {
    operationId: operation.operationId,
  })
  expect(result.status).toBe("cancelled")

  // Time passing afterwards must not resurrect the write.
  await session.advanceTime(60_000)
  expect((await session.node("InventoryFixture")).state).toMatchObject({ saved: [] })
  expect(
    session.events.some((e) => e.type === "node.removed" && e.nodeId === operation.nodeId),
  ).toBe(true)
})

test("an operation can be cancelled by its id", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.do("OpenProduct", { productId: "product-123" })
  const operation = await session.start("Save")
  await session.client.request("app.cancel", { operationId: operation.operationId })
  await session.waitFor({ operationId: operation.operationId })
  const finished = await session.client.request("app.operation", {
    operationId: operation.operationId,
  })
  expect(finished.status).toBe("cancelled")
})

test("availability is enforced, not just advertised", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.do("OpenProduct", { productId: "product-123" })
  await session.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  const { node } = await session.inspect()
  expect(node?.actions.Save).toMatchObject({
    available: false,
    unavailableReason: "Save in progress",
  })
  await expect(session.start("Save")).rejects.toMatchObject({ code: -32004 })
})

test("GoBack is unavailable at the root and comes from the navigation node", async () => {
  const session = await pool.open(app)
  const { ambient } = await session.inspect()
  expect(ambient.find((a) => a.action === "GoBack")).toMatchObject({
    nodeId: expect.stringContaining("navigation/"),
    available: false,
  })
  await expect(session.do("GoBack")).rejects.toMatchObject({ code: -32004 })
})

test("inputs are validated against the encoded schema", async () => {
  const session = await pool.open(app)
  await session.do("OpenProduct", { productId: "product-123" })
  for (const input of [
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: "3" },
    { quantity: 1, extra: true },
    {},
  ]) {
    await expect(session.do("SetQuantity", input)).rejects.toMatchObject({ code: -32003 })
  }
  await expect(session.do("Save", { unexpected: 1 })).rejects.toMatchObject({ code: -32003 })
  expect(session.state).toMatchObject({ quantity: 5 })
})

test("a stale observation cannot act", async () => {
  const session = await pool.open(app)
  await session.do("OpenProduct", { productId: "product-123" })
  const { node } = await session.inspect()
  await session.do("Increment")

  await expect(
    session.client.request("app.dispatch", {
      action: "Increment",
      expectedRevision: Number(node?.revision),
    }),
  ).rejects.toMatchObject({ code: -32005 })
})

test("screens below the top of the stack cannot be driven by handle", async () => {
  const session = await pool.open(app)
  const { node: list } = await session.inspect()
  await session.do("OpenProduct", { productId: "product-123" })
  await expect(
    session.client.request("app.dispatch", {
      nodeId: toNodeId(String(list?.id)),
      action: "Refresh",
    }),
  ).rejects.toMatchObject({ code: -32004 })
})

test("navigation is reachable like a deep link, with validated params", async () => {
  const session = await pool.open(app)
  await session.do("Navigate", { route: "InventoryDetail", params: { productId: "product-456" } })
  await session.precondition("InventoryDetail", { title: "Grey Hoodie" })
  await expect(session.do("Navigate", { route: "Nope", params: {} })).rejects.toMatchObject({
    code: -32003,
  })
  await expect(
    session.do("Navigate", { route: "InventoryDetail", params: {} }),
  ).rejects.toMatchObject({ code: -32003 })
  expect((await session.node("Navigation")).state).toMatchObject({
    stack: [
      { route: "InventoryList" },
      { route: "InventoryDetail", params: { productId: "product-456" } },
    ],
  })
})

test("secrets never leave the process", async () => {
  const session = await pool.open(app)
  await session.do("OpenSettings")
  await session.precondition("Settings", { _tag: "ready" })

  expect(session.state).toMatchObject({ apiToken: "<redacted>" })
  await session.do("SetLowStockThreshold", { threshold: 3 })

  const everything = JSON.stringify([
    await session.client.request("app.inspect", { tree: true }),
    session.events,
  ])
  expect(everything).not.toContain("secret-fixture-token")
})

test("settings change what other screens compute", async () => {
  const session = await pool.open(app)
  expect(lowStockIds(session.state)).toEqual(["product-123", "product-789"])
  await session.do("OpenSettings")
  await session.precondition("Settings", { _tag: "ready" })
  await session.do("SetLowStockThreshold", { threshold: 3 })
  await session.do("GoBack")
  expect(lowStockIds(session.state)).toEqual(["product-789"])
})

test("reset rebuilds the app, and stale handles die with the old session", async () => {
  const session = await pool.open(app)
  await session.do("OpenProduct", { productId: "product-123" })
  await session.do("SetQuantity", { quantity: 99 })
  await session.do("Save")
  const { node: stale } = await session.inspect()

  await session.reset("empty-inventory")

  expect(session.state).toMatchObject({ _tag: "ready", products: [] })
  expect((await session.node("InventoryFixture")).state).toMatchObject({ saved: [] })
  await expect(
    session.client.request("app.dispatch", {
      nodeId: toNodeId(String(stale?.id)),
      action: "Save",
    }),
  ).rejects.toMatchObject({ code: -32001 })
  expect(session.events.some((e) => e.type === "resync.required")).toBe(true)
})

test("a missing product is reported on the screen", async () => {
  const session = await pool.open(app)
  await session.do("OpenProduct", { productId: "does-not-exist" })
  expect(session.state).toMatchObject({ _tag: "missing", error: 'No product "does-not-exist"' })
})

test("real-time sessions refuse to advance time", async () => {
  const session = await pool.open(app)
  await expect(session.advanceTime(1)).rejects.toMatchObject({ code: -32009 })
})

test("network access fails loudly during a journey", async () => {
  const _session = await pool.open(app)
  expect(() => fetch("https://example.com")).toThrow("Unexpected network request")
})

test("quantity is bounded the same way by every action that sets it", async () => {
  const session = await pool.open(app)
  await session.do("OpenProduct", { productId: "product-123" })

  await session.do("SetQuantity", { quantity: QUANTITY_MAX })
  expect(session.state).toMatchObject({ quantity: QUANTITY_MAX })
  await expect(session.do("SetQuantity", { quantity: QUANTITY_MAX + 1 })).rejects.toMatchObject({
    code: ErrorCode.InvalidInput,
  })
  await expect(session.do("Increment")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })

  await session.do("SetQuantity", { quantity: 0 })
  await expect(session.do("Decrement")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })
  await session.do("Increment")
  expect(session.state).toMatchObject({ quantity: 1 })
})

test("the low stock threshold is bounded at both ends", async () => {
  const session = await pool.open(app)
  await session.do("OpenSettings")
  await session.precondition("Settings", { _tag: "ready" })
  await session.do("SetLowStockThreshold", { threshold: 0 })
  await session.do("SetLowStockThreshold", { threshold: 1_000 })
  for (const threshold of [-1, 1_001]) {
    await expect(session.do("SetLowStockThreshold", { threshold })).rejects.toMatchObject({
      code: ErrorCode.InvalidInput,
    })
  }
})

test("a route without params refuses junk from a deep link", async () => {
  const session = await pool.open(app)
  for (const params of [5, "junk", [1, 2], true, { x: 1 }]) {
    await expect(session.do("Navigate", { route: "Settings", params })).rejects.toMatchObject({
      code: ErrorCode.InvalidInput,
    })
  }
  await session.do("Navigate", { route: "Settings", params: {} })
  await session.precondition("Settings")
})

test("the shared real-services behavior journey passes with guarded headless fixtures", async () => {
  const { servicesJourney } = await import("../journeys/services.ts")
  const session = await pool.open(app)
  await servicesJourney({
    do: (action, input) => session.do(action, input as import("@reflex/protocol").Json),
    precondition: (screen, match) =>
      session.precondition(screen, match as import("@reflex/protocol").Json),
    failNextSave: async () => {
      await session.do("FailNextSave")
    },
  })
})
