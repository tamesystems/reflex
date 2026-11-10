import { INVENTORY_HTTP_BODY_BYTES_MAX } from "@reflex/protocol"
import * as Schema from "effect/Schema"
import { Quantity, type Product } from "./src/domain.ts"
import { seedProducts } from "./src/fixtures.ts"

const Save = Schema.Struct({ quantity: Quantity })

const readQuantity = async (request: Request): Promise<number | Response> => {
  const reader = request.body?.getReader()
  if (!reader) {
    return Response.json({ message: "Expected a valid quantity" }, { status: 400 })
  }
  const decoder = new TextDecoder()
  let body = ""
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > INVENTORY_HTTP_BODY_BYTES_MAX) {
        await reader.cancel()
        return Response.json({ message: "Request body too large" }, { status: 413 })
      }
      body += decoder.decode(value, { stream: true })
    }
    return Schema.decodeUnknownSync(Save)(JSON.parse(body + decoder.decode()), {
      onExcessProperty: "error",
    }).quantity
  } catch {
    return Response.json({ message: "Expected a valid quantity" }, { status: 400 })
  } finally {
    reader.releaseLock()
  }
}

/** Local development server. Test controls are intentionally unauthenticated: do not expose publicly. */
export const startInventoryServer = (port = 0, hostname = "127.0.0.1") => {
  let products = new Map(seedProducts.map((product) => [product.id, product]))
  let failNextSave = false
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, b3, traceparent, tracestate",
        "Cache-Control": "no-store",
      },
    })
  return Bun.serve({
    hostname,
    port,
    // Enforce the smaller application limit while streaming, so oversize replies are JSON too.
    maxRequestBodySize: Infinity,
    async fetch(request) {
      try {
        const { pathname } = new URL(request.url)
        if (request.method === "OPTIONS") {
          return json({ ok: true })
        }
        if (request.method === "POST" && pathname === "/reset") {
          products = new Map(seedProducts.map((product) => [product.id, product]))
          failNextSave = false
          return json({ ok: true })
        }
        if (request.method === "POST" && pathname === "/fail-next-save") {
          failNextSave = true
          return json({ ok: true })
        }
        if (request.method === "GET" && pathname === "/products") {
          return json([...products.values()])
        }
        const match = /^\/products\/([^/]+)$/.exec(pathname)
        if (!match?.[1]) {
          return json({ message: "Not found" }, 404)
        }
        const id = decodeURIComponent(match[1])
        const product: Product | undefined = products.get(id)
        if (!product) {
          return json({ message: `No product "${id}"` }, 404)
        }
        if (request.method === "GET") {
          return json(product)
        }
        if (request.method !== "PUT") {
          return json({ message: "Method not allowed" }, 405)
        }
        const quantity = await readQuantity(request)
        if (quantity instanceof Response) {
          return json(await quantity.json(), quantity.status)
        }
        if (failNextSave) {
          failNextSave = false
          return json({ message: "Server error" }, 503)
        }
        products.set(id, { ...product, quantity })
        return json({ ok: true })
      } catch {
        return json({ message: "Invalid request" }, 400)
      }
    },
    error: () => json({ message: "Server error" }, 500),
  })
}

if (import.meta.main) {
  const port = Number(process.env.INVENTORY_PORT ?? 8791)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid INVENTORY_PORT")
  }
  const server = startInventoryServer(port, process.env.INVENTORY_HOST ?? "127.0.0.1")
  console.log(JSON.stringify({ url: `http://${server.hostname}:${server.port}` }))
}
