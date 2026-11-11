import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import { afterEach, expect, test } from "bun:test"
import { ErrorCode, toNodeId } from "@reflex/protocol"
import { createTestAppPool } from "../packages/test/src/test-app.ts"
import type { InferState } from "@reflex/runtime/internal"
import inventoryDefinition from "../examples/inventory/src/scenarios.ts"
const app = inventoryDefinition[APP_HOST_ADAPTER]
import { QUANTITY_MAX } from "../examples/inventory/src/domain.ts"

import { InventoryFixture } from "../examples/inventory/src/fixtures.ts"
import { InventoryListLive as InventoryList } from "../examples/inventory/src/features/inventory-list.ts"
import { InventoryDetailLive as InventoryDetail } from "../examples/inventory/src/features/inventory-detail.ts"
import { SettingsLive as Settings } from "../examples/inventory/src/features/settings.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

/** The ids the list shows as low, derived from the definition's public state. */
const lowStockIds = ({
  products,
  lowStockThreshold,
}: Extract<InferState<typeof InventoryList>, { readonly _tag: "ready" }>): ReadonlyArray<string> =>
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

  await session.raw.dispatchRaw("GoBack")
  await session.raw.precondition("InventoryList", { _tag: "ready" })
  expect(session.raw.state).toMatchObject({
    products: [{ id: "product-123", quantity: 12 }, {}, {}],
  })
})

test("a failed save surfaces in state and as a typed operation failure", async () => {
  const session = await pool.open(app)
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.raw.dispatchRaw("FailNextSave")

  const result = await session.raw.dispatchRaw("Save")

  expect(result).toMatchObject({
    status: "failed",
    error: {
      tag: "ApiError",
      message: "Server error",
      defect: false,
      data: { _tag: "ApiError", message: "Server error" },
    },
  })
  expect(session.raw.state).toMatchObject({ _tag: "editing", error: "Server error" })
  expect(await (await session.node(InventoryFixture)).state()).toMatchObject({ saved: [] })

  // The failure was one-shot: retrying works and clears the error.
  expect((await session.raw.dispatchRaw("Save")).status).toBe("completed")
  expect(session.raw.state).toMatchObject({ error: null })
})

test("virtual time drives timeouts without waiting for them", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })

  const operation = await session.raw.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  await session.advanceTime(4_999)
  expect(session.raw.state).toMatchObject({ _tag: "saving" })

  await session.advanceTime(1)
  await session.waitFor({ operationId: operation.operationId })

  expect(session.raw.state).toMatchObject({ _tag: "editing", error: "Save timed out" })
})

test("leaving a screen cancels its in-flight save", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  const operation = await session.raw.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  await session.raw.dispatchRaw("GoBack")
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
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  const operation = await session.raw.start("Save")
  await session.client.request("app.cancel", { operationId: operation.operationId })
  await session.waitFor({ operationId: operation.operationId })
  const finished = await session.client.request("app.operation", {
    operationId: operation.operationId,
  })
  expect(finished.status).toBe("cancelled")
})

test("availability is enforced, not just advertised", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.raw.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })

  const { node } = await session.inspect()
  expect(node?.actions.Save).toMatchObject({
    available: false,
    unavailableReason: "Requires editing state",
  })
  await expect(session.raw.start("Save")).rejects.toMatchObject({ code: -32004 })
})

test("GoBack is unavailable at the root and comes from the navigation node", async () => {
  const session = await pool.open(app)
  const { ambient } = await session.inspect()
  expect(ambient.find((a) => a.action === "GoBack")).toMatchObject({
    nodeId: expect.stringContaining("navigation/"),
    available: false,
  })
  await expect(session.raw.dispatchRaw("GoBack")).rejects.toMatchObject({ code: -32004 })
})

test("inputs are validated against the encoded schema", async () => {
  const session = await pool.open(app)
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  for (const input of [
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: "3" },
    { quantity: 1, extra: true },
    {},
  ]) {
    await expect(session.raw.dispatchRaw("SetQuantity", input)).rejects.toMatchObject({
      code: -32003,
    })
  }
  await expect(session.raw.dispatchRaw("Save", { unexpected: 1 })).rejects.toMatchObject({
    code: -32003,
  })
  expect(session.raw.state).toMatchObject({ quantity: 5 })
})

test("a stale observation cannot act", async () => {
  const session = await pool.open(app)
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  const { node } = await session.inspect()
  await session.raw.dispatchRaw("Increment")

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
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  await expect(
    session.client.request("app.dispatch", {
      nodeId: toNodeId(String(list?.id)),
      action: "Refresh",
    }),
  ).rejects.toMatchObject({ code: -32004 })
})

test("navigation is reachable like a deep link, with validated params", async () => {
  const session = await pool.open(app)
  await session.raw.dispatchRaw("Navigate", {
    route: "InventoryDetail",
    params: { productId: "product-456" },
  })
  await session.raw.precondition("InventoryDetail", { title: "Grey Hoodie" })
  await expect(
    session.raw.dispatchRaw("Navigate", { route: "Nope", params: {} }),
  ).rejects.toMatchObject({
    code: -32003,
  })
  await expect(
    session.raw.dispatchRaw("Navigate", { route: "InventoryDetail", params: {} }),
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
  await session.raw.dispatchRaw("OpenSettings")
  await session.raw.precondition("Settings", { _tag: "ready" })

  expect(session.raw.state).toMatchObject({ apiToken: "<redacted>" })
  await session.raw.dispatchRaw("SetLowStockThreshold", { threshold: 3 })

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
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.raw.dispatchRaw("SetQuantity", { quantity: 99 })
  await session.raw.dispatchRaw("Save")
  const { node: stale } = await session.inspect()

  await session.reset("empty-inventory")

  expect(session.raw.state).toMatchObject({ _tag: "ready", products: [] })
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
  await session.raw.dispatchRaw("OpenProduct", { productId: "does-not-exist" })
  expect(session.raw.state).toMatchObject({ _tag: "missing", error: 'No product "does-not-exist"' })
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
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })

  await session.raw.dispatchRaw("SetQuantity", { quantity: QUANTITY_MAX })
  expect(session.raw.state).toMatchObject({ quantity: QUANTITY_MAX })
  await expect(
    session.raw.dispatchRaw("SetQuantity", { quantity: QUANTITY_MAX + 1 }),
  ).rejects.toMatchObject({
    code: ErrorCode.InvalidInput,
  })
  await expect(session.raw.dispatchRaw("Increment")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })

  await session.raw.dispatchRaw("SetQuantity", { quantity: 0 })
  await expect(session.raw.dispatchRaw("Decrement")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })
  await session.raw.dispatchRaw("Increment")
  expect(session.raw.state).toMatchObject({ quantity: 1 })
})

test("the low stock threshold is bounded at both ends", async () => {
  const session = await pool.open(app)
  await session.raw.dispatchRaw("OpenSettings")
  await session.raw.precondition("Settings", { _tag: "ready" })
  await session.raw.dispatchRaw("SetLowStockThreshold", { threshold: 0 })
  await session.raw.dispatchRaw("SetLowStockThreshold", { threshold: 1_000 })
  for (const threshold of [-1, 1_001]) {
    await expect(
      session.raw.dispatchRaw("SetLowStockThreshold", { threshold }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidInput,
    })
  }
})

test("a route without params refuses junk from a deep link", async () => {
  const session = await pool.open(app)
  for (const params of [5, "junk", [1, 2], true, { x: 1 }]) {
    await expect(
      session.raw.dispatchRaw("Navigate", { route: "Settings", params }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidInput,
    })
  }
  await session.raw.dispatchRaw("Navigate", { route: "Settings", params: {} })
  await session.raw.precondition("Settings")
})

test("the shared real-services behavior journey passes with guarded headless fixtures", async () => {
  const { servicesJourney } = await import("../examples/inventory/journeys/services.ts")
  const { default: authoredApp } = await import("../examples/inventory/src/scenarios.ts")
  await using session = await import("@reflex/test").then(({ createTestApp }) =>
    createTestApp(authoredApp),
  )
  await servicesJourney(session, async () => {
    await session.raw.dispatchRaw("FailNextSave")
  })
})
