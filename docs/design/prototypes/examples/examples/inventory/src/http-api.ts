import { INVENTORY_HTTP_BODY_BYTES_MAX, INVENTORY_HTTP_TIMEOUT_MS } from "./limits.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { ApiError, InventoryApi, Product } from "./domain.ts"

const ErrorBody = Schema.Struct({ message: Schema.String })
const Saved = Schema.Struct({ ok: Schema.Literal(true) })

/** Platform-neutral transport; imported only by the app's real-service composition. */
export const httpInventoryApi = (baseUrl: string) =>
  Layer.effect(
    InventoryApi,
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(HttpClient.withScope(yield* HttpClient.HttpClient))
      const base = baseUrl.replace(/\/$/, "")
      const request = <A>(path: string, schema: Schema.Codec<A, unknown>, quantity?: number) =>
        Effect.gen(function* () {
          const req =
            quantity === undefined
              ? HttpClientRequest.get(`${base}${path}`)
              : HttpClientRequest.put(`${base}${path}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ quantity }),
                )
          const response = yield* client
            .execute(req)
            .pipe(
              Effect.catchTag("HttpClientError", (error) =>
                error.reason._tag === "StatusCodeError"
                  ? Effect.succeed(error.reason.response)
                  : Effect.fail(error),
              ),
            )
          // A declared size is refused before any of it is read; the rest is checked after.
          const declared = Number(response.headers["content-length"] ?? Number.NaN)
          if (declared > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const bytes = yield* response.arrayBuffer
          if (bytes.byteLength > INVENTORY_HTTP_BODY_BYTES_MAX) {
            return yield* new ApiError({ message: "Inventory response too large" })
          }
          const buffered = HttpClientResponse.fromWeb(req, new Response(bytes))
          const decode = <T>(codec: Schema.Codec<T, unknown>) =>
            HttpClientResponse.schemaBodyJson(codec)(buffered)
          if (response.status < 200 || response.status >= 300) {
            const body = yield* decode(ErrorBody)
            return yield* new ApiError({ message: body.message })
          }
          return yield* decode(schema)
        }).pipe(
          Effect.scoped,
          Effect.catchTags({
            HttpClientError: (error) =>
              Effect.fail(
                new ApiError({
                  message:
                    error.reason._tag === "DecodeError"
                      ? "Invalid inventory JSON"
                      : "Inventory request failed",
                }),
              ),
            SchemaError: () => Effect.fail(new ApiError({ message: "Inventory request failed" })),
          }),
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
