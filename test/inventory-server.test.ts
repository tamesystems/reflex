import { expect, test } from "bun:test"
import { INVENTORY_HTTP_BODY_BYTES_MAX } from "../examples/inventory/src/limits.ts"
import { startInventoryServer } from "../examples/inventory/server.ts"
import { QUANTITY_MAX } from "../examples/inventory/src/domain.ts"

// HTTP server tests are transport tests, not guarded behavior journeys.
test("local API validates requests, persists, fails one save, and resets", async () => {
  const server = startInventoryServer()
  const base = `http://127.0.0.1:${server.port}`
  const request = (path: string, method = "GET", body?: string) =>
    fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }),
    })
  try {
    expect(await (await request("/products")).json()).toHaveLength(3)
    for (const body of [
      "{",
      "{}",
      '{"quantity":-1}',
      '{"quantity":1.5}',
      '{"quantity":"3"}',
      '{"quantity":1,"extra":true}',
      JSON.stringify({ quantity: QUANTITY_MAX + 1 }),
    ]) {
      const response = await request("/products/product-123", "PUT", body)
      expect(response.status).toBe(400)
      expect(await response.json()).toHaveProperty("message")
    }
    expect(
      (
        await request(
          "/products/product-123",
          "PUT",
          '{"quantity":5}'.padEnd(INVENTORY_HTTP_BODY_BYTES_MAX, " "),
        )
      ).status,
    ).toBe(200)
    const oversized = await request(
      "/products/product-123",
      "PUT",
      " ".repeat(INVENTORY_HTTP_BODY_BYTES_MAX + 1),
    )
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ message: "Request body too large" })
    expect((await request("/products/missing")).status).toBe(404)
    expect((await request("/products/product-123", "DELETE")).status).toBe(405)
    expect((await request("/unknown")).status).toBe(404)
    expect((await request("/products", "OPTIONS")).headers.get("Access-Control-Allow-Origin")).toBe(
      "*",
    )
    for (const quantity of [0, QUANTITY_MAX, 12]) {
      expect(
        (await request("/products/product-123", "PUT", JSON.stringify({ quantity }))).status,
      ).toBe(200)
      expect(await (await request("/products/product-123")).json()).toHaveProperty(
        "quantity",
        quantity,
      )
    }
    await request("/fail-next-save", "POST")
    const failure = await request("/products/product-123", "PUT", '{"quantity":19}')
    expect(failure.status).toBe(503)
    expect(await failure.json()).toEqual({ message: "Server error" })
    expect(await (await request("/products/product-123")).json()).toHaveProperty("quantity", 12)
    expect((await request("/products/product-123", "PUT", '{"quantity":19}')).status).toBe(200)
    await request("/reset", "POST")
    expect(await (await request("/products/product-123")).json()).toHaveProperty("quantity", 5)
  } finally {
    await server.stop(true)
  }
})
