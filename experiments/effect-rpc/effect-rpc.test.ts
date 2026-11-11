import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
/**
 * The comparison behind ADR 0014: identical plain JSON-RPC traffic, sent to the hand-written
 * connection and to the prototype in `connection.ts`, which serves the request methods
 * through Effect RPC (effect 4.1.2, `ndJsonRpc({ controlMessages: false })`) and maps
 * `app.subscribe` to an Effect stream. Each test pins what that configuration does where
 * the two differ. If one fails after an Effect upgrade, reread ADR 0014.
 *
 * Nothing here sleeps for a fixed time. Replies are awaited with a deadline, and "no reply"
 * is asserted only after a later request on the same connection has been answered.
 */
import { afterEach, expect, test } from "bun:test"
import { ErrorCode } from "@reflex/protocol"
import { createConnection } from "@reflex/rpc"
import { type Controller, createController } from "@reflex/runtime/internal"
import inventoryDefinition from "../../examples/inventory/src/scenarios.ts"
const app = inventoryDefinition[APP_HOST_ADAPTER]
import { createEffectRpcConnection } from "./connection.ts"

const REPLY_DEADLINE_MS = 10_000

type Message = {
  readonly id?: unknown
  readonly method?: string
  readonly chunk?: boolean
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly data?: unknown; readonly _tag?: string }
}

type Written = Message | ReadonlyArray<Message>

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

type Server = "hand-written" | "effect"

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + REPLY_DEADLINE_MS
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`No ${what} within ${REPLY_DEADLINE_MS} ms`)
    }
    await Bun.sleep(2)
  }
}

const request = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })

const flat = (written: ReadonlyArray<Written>): ReadonlyArray<Message> =>
  written.flatMap((message) => (Array.isArray(message) ? message : [message as Message]))

/** A peer of one server: what it has written back, and how to wait for it. */
const open = async (server: Server) => {
  const controller: Controller = await createController(app)
  cleanups.push(() => controller.close())
  const written: Array<Written> = []
  const send = (line: string) => written.push(JSON.parse(line) as Written)
  const peer =
    server === "effect"
      ? await createEffectRpcConnection(controller, send)
      : createConnection(controller, send)
  cleanups.push(() => peer.close())
  let lastBarrier = 1_000_000
  return {
    written,
    send: (line: string) => peer.receive(line),
    replyTo: async (id: number): Promise<Message> => {
      await until(() => flat(written).some((message) => message.id === id), `reply to ${id}`)
      return flat(written).find((message) => message.id === id) ?? {}
    },
    /** Everything sent so far has been read once a later request is answered. */
    barrier: async (): Promise<void> => {
      const id = ++lastBarrier
      peer.receive(request(id, "app.describe"))
      await until(() => flat(written).some((message) => message.id === id), "barrier reply")
    },
  }
}

test("both answer an ordinary request alike", async () => {
  for (const server of ["hand-written", "effect"] as const) {
    const peer = await open(server)
    peer.send(request(1, "app.describe"))
    expect(await peer.replyTo(1)).toMatchObject({ jsonrpc: "2.0", result: { app: "inventory" } })
  }
})

test("an error's data is the session's detail, or Effect's encoded Cause", async () => {
  const line = request(2, "app.dispatch", { action: "Nope" })
  const ours = await open("hand-written")
  ours.send(line)
  const mine = await ours.replyTo(2)
  expect(mine.error?.code).toBe(ErrorCode.ActionNotFound)
  expect(mine.error?.data).toMatchObject({ available: expect.arrayContaining(["OpenProduct"]) })

  const effect = await open("effect")
  effect.send(line)
  const theirs = await effect.replyTo(2)
  expect(theirs.error?.code).toBe(ErrorCode.ActionNotFound)
  // The serializer always wraps a failure in a Cause; the detail is nested inside it.
  expect(theirs.error?._tag).toBe("Cause")
  expect(Array.isArray(theirs.error?.data)).toBe(true)
})

test("an unknown method is MethodNotFound, or a defect with code 0", async () => {
  for (const [server, code] of [
    ["hand-written", ErrorCode.MethodNotFound],
    ["effect", 0],
  ] as const) {
    const peer = await open(server)
    peer.send(request(4, "app.nope"))
    expect((await peer.replyTo(4)).error?.code).toBe(code)
  }
})

test("malformed JSON gets a parse error, or no answer from this prototype", async () => {
  const ours = await open("hand-written")
  ours.send("{not json")
  await ours.barrier()
  expect(flat(ours.written)[0]?.error?.code).toBe(ErrorCode.ParseError)

  // The prototype drops it. Effect's own socket protocol answers with a defect instead
  // (ADR 0014); neither is a JSON-RPC parse error.
  const effect = await open("effect")
  effect.send("{not json")
  await effect.barrier()
  expect(flat(effect.written)).toHaveLength(1)
})

test("a request that is not JSON-RPC 2.0 is refused, or served", async () => {
  const line = JSON.stringify({ jsonrpc: "1.0", id: 6, method: "app.describe" })
  const ours = await open("hand-written")
  ours.send(line)
  expect((await ours.replyTo(6)).error?.code).toBe(ErrorCode.InvalidRequest)
  const effect = await open("effect")
  effect.send(line)
  expect((await effect.replyTo(6)).result).toBeDefined()
})

test("a batch is answered with one array, or with separate messages over NDJSON", async () => {
  const line = `[${request(7, "app.describe")},${request(8, "app.describe")}]`
  const ours = await open("hand-written")
  ours.send(line)
  await ours.replyTo(8)
  expect(ours.written).toHaveLength(1)
  expect(Array.isArray(ours.written[0])).toBe(true)

  const effect = await open("effect")
  effect.send(line)
  await effect.replyTo(7)
  await effect.replyTo(8)
  expect(effect.written.every((message) => !Array.isArray(message))).toBe(true)
})

test("an empty batch is an error, or answered with nothing", async () => {
  const ours = await open("hand-written")
  ours.send("[]")
  await ours.barrier()
  expect(flat(ours.written)[0]?.error?.code).toBe(ErrorCode.InvalidRequest)
  const effect = await open("effect")
  effect.send("[]")
  await effect.barrier()
  expect(flat(effect.written)).toHaveLength(1)
})

test("events are notifications, or chunks of a stream when subscribe is mapped to one", async () => {
  const dispatch = request(10, "app.dispatch", {
    action: "OpenProduct",
    input: { productId: "product-123" },
  })
  const ours = await open("hand-written")
  ours.send(request(9, "app.subscribe", {}))
  expect((await ours.replyTo(9)).result).toMatchObject({ subscriptionId: "sub-1" })
  ours.send(dispatch)
  await until(
    () => flat(ours.written).some((message) => message.method === "app.event"),
    "an event notification",
  )

  const effect = await open("effect")
  effect.send(request(9, "app.subscribe", {}))
  await effect.barrier()
  effect.send(dispatch)
  await until(
    () => flat(effect.written).some((message) => message.id === 9 && message.chunk === true),
    "an event chunk",
  )
  const chunks = flat(effect.written).filter((message) => message.id === 9)
  // No reply opens the subscription: every message for id 9 is a chunk of events, which
  // JSON-RPC 2.0 does not allow. One request, one response.
  expect(chunks.length).toBeGreaterThan(0)
  expect(chunks.every((message) => message.chunk === true)).toBe(true)
  expect(JSON.stringify(chunks)).toContain("OpenProduct")
  expect(flat(effect.written).some((message) => message.method === "app.event")).toBe(false)
})

test("$/cancelRequest ends a pending wait, or is ignored without an adapter", async () => {
  const wait = request(11, "app.wait", { focus: "Never", timeoutMs: 600_000 })
  const cancel = JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 11 } })
  const ours = await open("hand-written")
  ours.send(wait)
  await ours.barrier()
  ours.send(cancel)
  expect((await ours.replyTo(11)).error?.code).toBe(ErrorCode.SessionClosed)

  const effect = await open("effect")
  effect.send(wait)
  await effect.barrier()
  effect.send(cancel)
  await effect.barrier()
  expect(flat(effect.written).some((message) => message.id === 11)).toBe(false)
})
