import { afterEach, expect, test } from "bun:test"
import { ErrorCode, toNodeId } from "@reflex/protocol"
import { createTestAppPool, type StateOf } from "@reflex/test"
import app from "../examples/inventory/src/app.ts"
import { QUANTITY_MAX } from "../examples/inventory/src/domain.ts"

import { InventoryFixture } from "../examples/inventory/src/fixtures.ts"
import { InventoryList } from "../examples/inventory/src/features/inventory-list.ts"
import { InventoryDetail } from "../examples/inventory/src/features/inventory-detail.ts"
import { Settings } from "../examples/inventory/src/features/settings.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

/** The ids the list shows as low, derived from the definition's public state. */
const lowStockIds = ({
  products,
  lowStockThreshold,
}: Extract<StateOf<typeof InventoryList>, { readonly _tag: "ready" }>): ReadonlyArray<string> =>
  products.filter((product) => product.quantity < lowStockThreshold).map((product) => product.id)

test("user updates inventory quantity", async () => {
  const session = await pool.open(app)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenProduct({ productId: "product-123" })
  const detail = await session.focused(InventoryDetail, {
    _tag: "editing",
    title: "Blue T-Shirt",
    quantity: 5,
  })
  await detail.actions.SetQuantity({ quantity: 12 })
  expect((await detail.actions.Save()).status).toBe("completed")
  expect(await (await session.focused(InventoryDetail, { _tag: "editing" })).state()).toMatchObject(
    {
      quantity: 12,
      error: null,
    },
  )
  expect(await (await session.node(InventoryFixture)).state()).toMatchObject({
    saved: [{ productId: "product-123", quantity: 12 }],
  })

  await session.dispatchRaw("GoBack")
  await session.precondition("InventoryList", { _tag: "ready" })
  expect(session.state).toMatchObject({ products: [{ id: "product-123", quantity: 12 }, {}, {}] })
})

test("a failed save surfaces in state and as a typed operation failure", async () => {
  const session = await pool.open(app)
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.dispatchRaw("FailNextSave")

  const result = await session.dispatchRaw("Save")

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
  expect(await (await session.node(InventoryFixture)).state()).toMatchObject({ saved: [] })

  // The failure was one-shot: retrying works and clears the error.
  expect((await session.dispatchRaw("Save")).status).toBe("completed")
  expect(session.state).toMatchObject({ error: null })
})

test("virtual time drives timeouts without waiting for them", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })

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
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
  const operation = await session.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  await session.dispatchRaw("GoBack")
  await session.waitFor({ operationId: operation.operationId })

  const result = await session.client.request("app.operation", {
    operationId: operation.operationId,
  })
  expect(result.status).toBe("cancelled")

  // Time passing afterwards must not resurrect the write.
  await session.advanceTime(60_000)
  expect(await (await session.node(InventoryFixture)).state()).toMatchObject({ saved: [] })
  expect(
    session.events.some((e) => e.type === "node.removed" && e.nodeId === operation.nodeId),
  ).toBe(true)
})

test("an operation can be cancelled by its id", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
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
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  const { node } = await session.inspect()
  expect(node?.actions.Save).toMatchObject({
    available: false,
    unavailableReason: "Requires editing state",
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
  await expect(session.dispatchRaw("GoBack")).rejects.toMatchObject({ code: -32004 })
})

test("inputs are validated against the encoded schema", async () => {
  const session = await pool.open(app)
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
  for (const input of [
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: "3" },
    { quantity: 1, extra: true },
    {},
  ]) {
    await expect(session.dispatchRaw("SetQuantity", input)).rejects.toMatchObject({ code: -32003 })
  }
  await expect(session.dispatchRaw("Save", { unexpected: 1 })).rejects.toMatchObject({
    code: -32003,
  })
  expect(session.state).toMatchObject({ quantity: 5 })
})

test("a stale observation cannot act", async () => {
  const session = await pool.open(app)
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
  const { node } = await session.inspect()
  await session.dispatchRaw("Increment")

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
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
  await expect(
    session.client.request("app.dispatch", {
      nodeId: toNodeId(String(list?.id)),
      action: "Refresh",
    }),
  ).rejects.toMatchObject({ code: -32004 })
})

test("navigation is reachable like a deep link, with validated params", async () => {
  const session = await pool.open(app)
  await session.dispatchRaw("Navigate", {
    route: "InventoryDetail",
    params: { productId: "product-456" },
  })
  await session.precondition("InventoryDetail", { title: "Grey Hoodie" })
  await expect(
    session.dispatchRaw("Navigate", { route: "Nope", params: {} }),
  ).rejects.toMatchObject({
    code: -32003,
  })
  await expect(
    session.dispatchRaw("Navigate", { route: "InventoryDetail", params: {} }),
  ).rejects.toMatchObject({ code: -32003 })
  expect((await session.inspectRaw("Navigation")).state).toMatchObject({
    stack: [
      { route: "InventoryList" },
      { route: "InventoryDetail", params: { productId: "product-456" } },
    ],
  })
})

test("secrets never leave the process", async () => {
  const session = await pool.open(app)
  await session.dispatchRaw("OpenSettings")
  await session.precondition("Settings", { _tag: "ready" })

  expect(session.state).toMatchObject({ apiToken: "<redacted>" })
  await session.dispatchRaw("SetLowStockThreshold", { threshold: 3 })

  const everything = JSON.stringify([
    await session.client.request("app.inspect", { tree: true }),
    session.events,
  ])
  expect(everything).not.toContain("secret-fixture-token")
})

test("settings change what other screens compute", async () => {
  const session = await pool.open(app)
  const list = await session.focused(InventoryList, { _tag: "ready" })
  expect(lowStockIds(await list.state())).toEqual(["product-123", "product-789"])
  await list.actions.OpenSettings()
  const settings = await session.focused(Settings, { _tag: "ready" })
  await settings.actions.SetLowStockThreshold({ threshold: 3 })
  await session.back()
  expect(
    lowStockIds(await (await session.focused(InventoryList, { _tag: "ready" })).state()),
  ).toEqual(["product-789"])
})

test("reset rebuilds the app, and stale handles die with the old session", async () => {
  const session = await pool.open(app)
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.dispatchRaw("SetQuantity", { quantity: 99 })
  await session.dispatchRaw("Save")
  const { node: stale } = await session.inspect()

  await session.reset("empty-inventory")

  expect(session.state).toMatchObject({ _tag: "ready", products: [] })
  expect(await (await session.node(InventoryFixture)).state()).toMatchObject({ saved: [] })
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
  await session.dispatchRaw("OpenProduct", { productId: "does-not-exist" })
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
  await session.dispatchRaw("OpenProduct", { productId: "product-123" })

  await session.dispatchRaw("SetQuantity", { quantity: QUANTITY_MAX })
  expect(session.state).toMatchObject({ quantity: QUANTITY_MAX })
  await expect(
    session.dispatchRaw("SetQuantity", { quantity: QUANTITY_MAX + 1 }),
  ).rejects.toMatchObject({
    code: ErrorCode.InvalidInput,
  })
  await expect(session.dispatchRaw("Increment")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })

  await session.dispatchRaw("SetQuantity", { quantity: 0 })
  await expect(session.dispatchRaw("Decrement")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })
  await session.dispatchRaw("Increment")
  expect(session.state).toMatchObject({ quantity: 1 })
})

test("the low stock threshold is bounded at both ends", async () => {
  const session = await pool.open(app)
  await session.dispatchRaw("OpenSettings")
  await session.precondition("Settings", { _tag: "ready" })
  await session.dispatchRaw("SetLowStockThreshold", { threshold: 0 })
  await session.dispatchRaw("SetLowStockThreshold", { threshold: 1_000 })
  for (const threshold of [-1, 1_001]) {
    await expect(session.dispatchRaw("SetLowStockThreshold", { threshold })).rejects.toMatchObject({
      code: ErrorCode.InvalidInput,
    })
  }
})

test("a route without params refuses junk from a deep link", async () => {
  const session = await pool.open(app)
  for (const params of [5, "junk", [1, 2], true, { x: 1 }]) {
    await expect(
      session.dispatchRaw("Navigate", { route: "Settings", params }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidInput,
    })
  }
  await session.dispatchRaw("Navigate", { route: "Settings", params: {} })
  await session.precondition("Settings")
})

test("the shared real-services behavior journey passes with guarded headless fixtures", async () => {
  const { servicesJourney } = await import("../examples/inventory/journeys/services.ts")
  const session = await pool.open(app)
  await servicesJourney(session, async () => {
    await session.dispatchRaw("FailNextSave")
  })
})
