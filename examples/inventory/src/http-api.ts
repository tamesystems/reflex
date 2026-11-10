import { INVENTORY_HTTP_BODY_BYTES_MAX, INVENTORY_HTTP_TIMEOUT_MS } from "@reflex/protocol"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { ApiError, InventoryApi, Product } from "./domain.ts"

const ErrorBody = Schema.Struct({ message: Schema.String })
const Saved = Schema.Struct({ ok: Schema.Literal(true) })

/** Platform-neutral transport; imported only by the app's real-service composition. */
export const httpInventoryApi = (baseUrl: string) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const client = HttpClient.withScope(yield* HttpClient.HttpClient)
      const base = baseUrl.replace(/\/$/, "")
      const request = <A>(path: string, schema: Schema.Codec<A>, quantity?: number) =>
        Effect.gen(function* () {
          const req =
            quantity === undefined
              ? HttpClientRequest.get(`${base}${path}`)
              : HttpClientRequest.put(`${base}${path}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ quantity }),
                )
          const response = yield* client.execute(req)
          const bytes = yield* response.arrayBuffer
          if (bytes.byteLength > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const json = yield* Effect.try({
            try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
            catch: () => new ApiError({ message: "Invalid inventory JSON" }),
          })
          if (response.status < 200 || response.status >= 300) {
            const body = yield* Schema.decodeUnknownEffect(ErrorBody)(json)
            return yield* new ApiError({ message: body.message })
          }
          return yield* Schema.decodeUnknownEffect(schema)(json)
        }).pipe(
          Effect.scoped,
          Effect.mapError((error) =>
            error instanceof ApiError
              ? error
              : new ApiError({ message: "Inventory request failed" }),
          ),
          Effect.timeoutOrElse({
            duration: INVENTORY_HTTP_TIMEOUT_MS,
            orElse: () => Effect.fail(new ApiError({ message: "Inventory request timed out" })),
          }),
        )
      return InventoryApi.of({
        list: request("/products", Schema.Array(Product)),
        get: (id) => request(`/products/${encodeURIComponent(id)}`, Product),
        saveQuantity: (id, quantity) =>
          request(`/products/${encodeURIComponent(id)}`, Saved, quantity).pipe(Effect.asVoid),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
