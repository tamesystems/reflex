import { expect, test } from "bun:test"
import { createController } from "@reflex/runtime/internal"
import { defineApp } from "@reflex/effect"
import { createLoopbackClient } from "@reflex/rpc"
import {
  INVENTORY_HTTP_BODY_BYTES_MAX,
  INVENTORY_HTTP_TIMEOUT_MS,
} from "../examples/inventory/src/limits.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { root } from "../examples/inventory/src/app.ts"
import { InventoryApi } from "../examples/inventory/src/domain.ts"
import { fixtureSettings, seedProducts } from "../examples/inventory/src/fixtures.ts"
import { httpInventoryApi } from "../examples/inventory/src/http-api.ts"

const withFetch = (fetcher: typeof fetch) =>
  Layer.mergeAll(
    httpInventoryApi("http://inventory.test"),
    Layer.succeed(FetchHttpClient.Fetch, fetcher),
    fixtureSettings,
  )
const fakeFetch = (run: (url: URL, init: RequestInit) => Promise<Response>) =>
  ((url: string | URL | Request, init?: RequestInit) =>
    run(new URL(String(url)), init ?? {})) as typeof fetch

for (const [label, fetcher, message] of [
  [
    "network",
    fakeFetch(async () => {
      throw new Error("offline")
    }),
    "Inventory request failed",
  ],
  [
    "non-2xx",
    fakeFetch(async () => Response.json({ message: "Server error" }, { status: 503 })),
    "Server error",
  ],
  ["invalid JSON", fakeFetch(async () => new Response("{")), "Invalid inventory JSON"],
  [
    "invalid schema",
    fakeFetch(async () => Response.json([{ id: "x", title: "X", quantity: -1 }])),
    "Inventory request failed",
  ],
  [
    "oversize",
    fakeFetch(async () => new Response(" ".repeat(INVENTORY_HTTP_BODY_BYTES_MAX + 1))),
    "Inventory response too large",
  ],
] as const) {
  test(`HTTP ${label} maps to ApiError`, async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.flip((yield* InventoryApi).list)
      }).pipe(Effect.provide(withFetch(fetcher))),
    )
    expect(error).toMatchObject({ _tag: "ApiError", message })
  })
}

test("HTTP refuses a declared oversize response without reading its body", async () => {
  let pulled = false
  const fetcher = fakeFetch(
    async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              // A body that never ends: reading it at all would hang this test.
              pulled = true
            },
          },
          // Without this the stream pulls once on its own, before anyone reads.
          { highWaterMark: 0 },
        ),
        { headers: { "content-length": String(INVENTORY_HTTP_BODY_BYTES_MAX + 1) } },
      ),
  )
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Effect.flip((yield* InventoryApi).list)
    }).pipe(Effect.provide(withFetch(fetcher))),
  )
  expect(error).toMatchObject({ _tag: "ApiError", message: "Inventory response too large" })
  expect(pulled).toBe(false)
})

test("HTTP accepts a valid response at the byte limit", async () => {
  const fetcher = fakeFetch(
    async () =>
      new Response(JSON.stringify(seedProducts).padEnd(INVENTORY_HTTP_BODY_BYTES_MAX, " ")),
  )
  const products = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* InventoryApi).list
    }).pipe(Effect.provide(withFetch(fetcher))),
  )
  expect(products).toEqual(seedProducts)
})

for (const leave of ["pop", "reset"] as const) {
  test(`${leave} aborts the actual fetch signal for an in-flight screen save`, async () => {
    let signal: RequestInit["signal"]
    let started!: () => void
    const saving = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetcher = fakeFetch(async (url, init) => {
      if (init.method === "PUT") {
        signal = init.signal ?? undefined
        started()
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }
      return Response.json(url.pathname === "/products" ? seedProducts : seedProducts[0])
    })
    const host = defineApp({
      name: "cancellation",
      root,
      defaultScenario: "http",
      scenarios: { http: { layer: withFetch(fetcher) } },
    })
    const controller = await createController(host)
    const client = createLoopbackClient(controller)
    try {
      await client.request("app.wait", { idle: true })
      await client.request("app.dispatch", {
        action: "OpenProduct",
        input: { productId: "product-123" },
      })
      await client.request("app.wait", { idle: true })
      const save = await client.request("app.dispatch", { action: "Save" })
      await saving
      expect(signal?.aborted).toBe(false)
      if (leave === "reset") {
        await client.request("app.reset", {})
      } else {
        await client.request("app.dispatch", { action: "GoBack" })
        const finished = await client.request("app.wait", { operationId: save.operationId })
        expect(finished.operation?.status).toBe("cancelled")
      }
      expect(signal?.aborted).toBe(true)
    } finally {
      client.close()
      await controller.close()
    }
  })
}

test(
  "HTTP deadline aborts a stalled response body and returns ApiError",
  async () => {
    let signal: RequestInit["signal"]
    const fetcher = fakeFetch(async (_url, init) => {
      signal = init.signal ?? undefined
      // Headers have arrived, but the body never finishes: scope must cover decoding too.
      return new Response(new ReadableStream({ start() {} }))
    })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.flip((yield* InventoryApi).list)
      }).pipe(Effect.provide(withFetch(fetcher))),
    )
    expect(error).toMatchObject({ _tag: "ApiError", message: "Inventory request timed out" })
    expect(signal?.aborted).toBe(true)
  },
  INVENTORY_HTTP_TIMEOUT_MS + 2_000,
)
