/**
 * The prototype behind ADR 0014. The protocol's request methods, served through Effect
 * v4's RPC server and its newline-delimited JSON-RPC serializer, with control messages off
 * as the docs advise for plain JSON-RPC peers. `app.subscribe` is mapped to an Effect
 * stream, which changes its shape on the wire; `app.unsubscribe` is left out. The
 * transport is custom, with the shape of `createConnection` in `@reflex/rpc` (lines in,
 * lines out, over one controller), so the two can be fed identical traffic. It drops a
 * frame it cannot decode, and does not use stream acknowledgements, which plain peers
 * cannot send. Params are still validated by our parsers. For comparison, not production.
 */
import { paramParsers, ProtocolError, type RuntimeEvent } from "@reflex/protocol"
import type { Controller, ControllerMethod } from "@reflex/runtime/internal"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import type { FromClientEncoded } from "effect/rpc/RpcMessage"

/** A `ProtocolError`, as Effect RPC encodes a typed failure. */
class ProtocolFailure extends Schema.TaggedError<ProtocolFailure>()("ProtocolFailure", {
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
}) {}

const REQUEST_METHODS = [
  "app.describe",
  "app.inspect",
  "app.dispatch",
  "app.operation",
  "app.cancel",
  "app.wait",
  "app.reset",
  "app.advanceTime",
  "app.sample",
] as const satisfies ReadonlyArray<ControllerMethod>

const requestRpc = <const Tag extends (typeof REQUEST_METHODS)[number]>(tag: Tag) =>
  Rpc.make(tag, { payload: Schema.Unknown, success: Schema.Unknown, error: ProtocolFailure })

const Group = RpcGroup.make(
  requestRpc("app.describe"),
  requestRpc("app.inspect"),
  requestRpc("app.dispatch"),
  requestRpc("app.operation"),
  requestRpc("app.cancel"),
  requestRpc("app.wait"),
  requestRpc("app.reset"),
  requestRpc("app.advanceTime"),
  requestRpc("app.sample"),
  // Events arrive as a stream, Effect RPC's own way to send more than one result.
  Rpc.make("app.subscribe", {
    payload: Schema.Unknown,
    success: Schema.Unknown,
    error: ProtocolFailure,
    stream: true,
  }),
)

const failureOf = (error: unknown): ProtocolFailure =>
  error instanceof ProtocolError
    ? new ProtocolFailure({
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      })
    : new ProtocolFailure({ code: -32603, message: String(error) })

/** Our parsers still validate params, so only the transport differs from `createConnection`. */
const forward = (controller: Controller, method: ControllerMethod) => (payload: unknown) =>
  Effect.tryPromise({
    try: (signal) =>
      controller.request(method, paramParsers[method](payload ?? {}, "params") as never, {
        signal,
      }) as Promise<unknown>,
    catch: failureOf,
  })

const handlersFor = (controller: Controller) =>
  Group.toLayer({
    "app.describe": forward(controller, "app.describe"),
    "app.inspect": forward(controller, "app.inspect"),
    "app.dispatch": forward(controller, "app.dispatch"),
    "app.operation": forward(controller, "app.operation"),
    "app.cancel": forward(controller, "app.cancel"),
    "app.wait": forward(controller, "app.wait"),
    "app.reset": forward(controller, "app.reset"),
    "app.advanceTime": forward(controller, "app.advanceTime"),
    "app.sample": forward(controller, "app.sample"),
    "app.subscribe": (payload: unknown) =>
      Stream.callback<RuntimeEvent, ProtocolFailure>((queue) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              controller.subscribe(
                (event) => {
                  Queue.offerUnsafe(queue, event)
                },
                paramParsers["app.subscribe"](payload ?? {}, "params"),
              ),
            catch: failureOf,
          }),
          (subscription) => Effect.sync(() => subscription.unsubscribe()),
        ),
      ),
  })

export interface EffectRpcConnection {
  receive(line: string): void
  close(): Promise<void>
}

/** One peer, served the protocol through Effect RPC. Lines are JSON-RPC 2.0, one each. */
export const createEffectRpcConnection = async (
  controller: Controller,
  send: (line: string) => void,
): Promise<EffectRpcConnection> => {
  let deliver: (line: string) => void = () => undefined
  const ready = Promise.withResolvers<void>()
  const ProtocolLive = Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization
      return yield* RpcServer.Protocol.make(
        Effect.fnUntraced(function* (writeRequest) {
          const parser = serialization.makeUnsafe()
          const services = yield* Effect.context<never>()
          const run = Effect.runForkWith(services)
          deliver = (line) => {
            let decoded: ReadonlyArray<unknown>
            try {
              decoded = parser.decode(`${line}\n`)
            } catch {
              // Effect's own stdio and socket protocols log a frame they cannot decode
              // and drop it. No JSON-RPC parse error is sent.
              return
            }
            run(
              Effect.forEach(decoded, (message) => writeRequest(0, message as FromClientEncoded), {
                discard: true,
              }),
            )
          }
          ready.resolve()
          return {
            disconnects: yield* Queue.make<number>(),
            send: (_clientId, response) =>
              Effect.sync(() => {
                const encoded = parser.encode(response)
                if (encoded === undefined) {
                  return
                }
                const text =
                  typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded)
                for (const frame of text.split("\n")) {
                  if (frame !== "") {
                    send(frame)
                  }
                }
              }),
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set([0])),
            initialMessage: Effect.succeedNone,
            supportsAck: false,
            supportsTransferables: false,
            supportsSpanPropagation: false,
            supportsNotifications: true,
            codecFor: serialization.codecFor,
          }
        }),
      )
    }),
  )
  const server = RpcServer.layer(Group).pipe(
    Layer.provide(handlersFor(controller)),
    Layer.provide(ProtocolLive),
    Layer.provide(RpcSerialization.layerNdJsonRpc({ controlMessages: false })),
  )
  const fiber = Effect.runFork(Layer.launch(server))
  await ready.promise
  return {
    receive: (line) => deliver(line),
    close: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber))
    },
  }
}
