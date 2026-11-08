# 0014. Keep the hand-written wire rather than adopt Effect RPC

Status: Accepted; follows up [0001](0001-hand-written-json-rpc.md), which deferred this comparison

## Context

ADR 0001 chose a hand-written JSON-RPC layer and deferred comparing it with Effect v4's
RPC, which has JSON-RPC 2.0 serializers (whole messages, or newline-delimited) and a
`controlMessages: false` option for plain JSON-RPC peers. If it could serve the protocol
as documented, it might replace much of `@reflex/rpc`.

`experiments/effect-rpc/connection.ts` serves the request methods through Effect RPC
(effect 4.1.2, `ndJsonRpc({ controlMessages: false })`) over the same controller, with
params still validated by our parsers. It maps `app.subscribe` to an Effect stream, omits
`app.unsubscribe`, and uses a custom transport. `effect-rpc.test.ts` sends it and the
hand-written connection identical plain JSON-RPC traffic. A review of Effect's source
then separated what is inherent to Effect RPC from what this prototype chose:

| Plain peer sends                     | Hand-written                            | Effect RPC                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An ordinary request                  | `result`                                | The same                                                                                                                                                                                                              |
| A request that fails, with detail    | `error.data` is the detail              | Always wrapped in an encoded `Cause`, detail nested. A serializer wrapper can unwrap it                                                                                                                               |
| An unknown method                    | `MethodNotFound` (-32601)               | A defect with code `0`, with or without `disableFatalDefects`                                                                                                                                                         |
| Malformed JSON                       | `ParseError` (-32700)                   | Never a parse error: Effect's socket protocol answers with a defect (id `-32603`, code `1`); its stdio protocol logs and retries; the prototype drops it                                                              |
| `"jsonrpc": "1.0"`                   | `InvalidRequest` (-32600)               | Served: the version is not checked                                                                                                                                                                                    |
| A batch                              | One array of replies                    | One array with `jsonRpc()`; separate lines with `ndJsonRpc()`. An empty batch gets nothing, and invalid elements are skipped rather than refused                                                                      |
| `"id": null`                         | Answered with `null`                    | Treated as `""`                                                                                                                                                                                                       |
| `app.subscribe`                      | A reply, then `app.event` notifications | As a stream (the prototype): no reply, events as repeated `chunk` responses. As a unary method that sends notifications: possible, but subscriptions' ordering, held events, replay and resync would have to be built |
| `$/cancelRequest` for a pending wait | The wait ends, answered                 | Ignored as is. Translating it to Effect's `Interrupt` message interrupts the request; the error still needs mapping                                                                                                   |

Resources differ more than the table shows. Effect offers framing limits (16 Mi
characters by default, against our 8 Mi), writer backpressure, stream acknowledgements and
a `concurrency` option. But `concurrency` bounds running handlers, not admitted requests:
each request still gets a fiber, so 300 requests at `concurrency: 2` make 300 fibers and run
2, and the default is unbounded. Acknowledgements are control messages, which plain peers
do not send, and a callback stream's buffer is unbounded by default. Our limits on admitted
requests, batches, subscriptions, held events, queued output and stalled peers
([ADR 0006](0006-everything-is-bounded.md)) would all have to be rebuilt around it.

## Decision

Keep the hand-written wire. Effect RPC can be adapted closer to the protocol than its
defaults suggest, but several adaptations are needed (an error-unwrapping serializer, a
batch-preserving framing, translating cancellation, a notification-based subscription,
version and parse-error handling), and our admission, subscription and stalled-peer limits
would still be ours to build on top. That is a lot of new work to replace a working
implementation that already meets the protocol, for benefits we do not yet need.

## Consequences

- Clients keep the protocol exactly as documented, and `@reflex/rpc` stays free of Effect
  ([ADR 0002](0002-the-runtime-is-effect-free.md)). An Effect-backed server alone would
  not force Effect on the CLI or test SDK; switching them to Effect's client would.
- The prototype uses `Schema.Unknown` and our parsers, so Effect RPC's schema-driven
  benefits went unmeasured: request and response validation from schemas, typed clients,
  middleware, scoped interruption, tracing, streaming flow control, and ready transports
  for HTTP, WebSockets and workers.
- Revisit if those benefits become needed, or if the protocol stops promising plain
  JSON-RPC. The comparison runs in `bun run check`: an Effect upgrade that changes one of
  the behaviors it pins fails it, but it pins only the prototype's configuration, not
  every adaptation above.
