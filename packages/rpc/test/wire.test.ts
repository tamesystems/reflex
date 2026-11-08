/** Peers here speak raw JSON over a socket: no client library, no Effect. */
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineApp, defineCapability, mount, Registry } from "@reflex/effect"
import {
  BATCH_REQUESTS_MAX,
  CLIENT_LISTENERS_MAX,
  CLIENT_PENDING_REQUESTS_MAX,
  CONNECTION_REQUESTS_MAX,
  CONNECTION_SUBSCRIPTIONS_MAX,
  ErrorCode,
  FRAME_CHARACTERS_MAX,
  JSON_DEPTH_MAX,
  type Json,
  PROTOCOL_VERSION,
  ProtocolError,
  REQUEST_ID_CHARACTERS_MAX,
  type RuntimeEvent,
  SERVER_CONNECTIONS_MAX,
  SESSION_DISPOSE_TIMEOUT_MS_DEFAULT,
  SESSION_START_TIMEOUT_MS_MAX,
} from "@reflex/protocol"
import {
  connectSocket,
  createClient,
  createConnection,
  createLineReader,
  serveSocket,
} from "@reflex/rpc"
import { createController } from "@reflex/runtime"
import { nextTurn, waitUntil } from "@reflex/test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import app from "../../../examples/inventory/src/app.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

const serve = async () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-"))
  const path = join(directory, "s.sock")
  const controller = await createController(app)
  const server = await serveSocket(controller, path)
  cleanups.push(async () => {
    server.close()
    await controller.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { path }
}

interface RawPeer {
  write(text: string): void
  next(): Promise<unknown>
}

/** Send raw bytes; collect parsed lines. */
const rawPeer = (path: string) =>
  new Promise<RawPeer>((resolve) => {
    const socket = connect(path)
    cleanups.push(() => void socket.destroy())
    const queue: Array<unknown> = []
    const waiting: Array<(value: unknown) => void> = []
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() as string
      for (const line of lines) {
        const value = JSON.parse(line)
        const waiter = waiting.shift()
        if (waiter) {
          waiter(value)
        } else {
          queue.push(value)
        }
      }
    })
    socket.once("connect", () =>
      resolve({
        write: (text) => void socket.write(text),
        next: () =>
          queue.length > 0
            ? Promise.resolve(queue.shift())
            : new Promise((done) => waiting.push(done)),
      }),
    )
  })

test("a plain JSON-RPC 2.0 peer can inspect and dispatch", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)

  peer.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.wait", params: { focus: "InventoryList", idle: true } })}\n`,
  )
  expect(await peer.next()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} })

  peer.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: "two", method: "app.inspect", params: {} })}\n`,
  )
  expect(await peer.next()).toMatchObject({
    id: "two",
    result: {
      protocolVersion: PROTOCOL_VERSION,
      node: {
        name: "InventoryList",
        actions: { OpenProduct: { inputSchema: { required: ["productId"] } } },
      },
    },
  })

  peer.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "app.dispatch", params: { action: "OpenSettings", await: true } })}\n`,
  )
  expect(await peer.next()).toMatchObject({ id: 3, result: { status: "completed" } })
})

test("malformed traffic gets standard errors and does not kill the connection", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)

  peer.write("not json\n")
  expect(await peer.next()).toMatchObject({ id: null, error: { code: -32700 } })

  peer.write(`${JSON.stringify({ id: 1, method: "app.inspect" })}\n`)
  expect(await peer.next()).toMatchObject({ id: 1, error: { code: -32600 } })

  peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "app.eval", params: {} })}\n`)
  expect(await peer.next()).toMatchObject({ id: 2, error: { code: -32601 } })

  peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "app.dispatch", params: {} })}\n`)
  expect(await peer.next()).toMatchObject({ id: 3, error: { code: -32602 } })

  peer.write("null\n")
  expect(await peer.next()).toMatchObject({ id: null, error: { code: -32600 } })

  peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "app.describe" })}\n`)
  expect(await peer.next()).toMatchObject({ id: 4, result: { app: "inventory" } })
})

test("notifications receive no response", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  peer.write(`${JSON.stringify({ jsonrpc: "2.0", method: "app.describe" })}\n`)
  peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" })}\n`)
  expect(await peer.next()).toMatchObject({ id: 1 })
})

test("a message split across packets is reassembled", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  const message = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" })}\n`
  peer.write(message.slice(0, 10))
  await nextTurn()
  peer.write(message.slice(10))
  expect(await peer.next()).toMatchObject({ id: 1, result: { app: "inventory" } })
})

test("subscribers receive ordered events, and missed ones replay from a cursor", async () => {
  const { path } = await serve()
  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  await client.request("app.wait", { idle: true })

  const live: Array<number> = []
  client.onEvent((event) => live.push(event.sequence))
  const { sequence, sessionId } = await client.request("app.subscribe", {})
  await client.request("app.dispatch", { action: "OpenSettings", await: true })
  const { sequence: latest } = await client.request("app.wait", { idle: true })
  await waitUntil(() => live.at(-1) === latest, "the last event has arrived")
  expect(live).toEqual([...live].sort((a, b) => a - b))

  const replayed: Array<number> = []
  const second = await connectSocket(path)
  cleanups.push(() => second.close())
  second.onEvent((event) => replayed.push(event.sequence))
  await second.request("app.subscribe", { since: { sessionId, sequence } })
  await waitUntil(() => replayed.at(-1) === latest, "the replay has finished")
  expect(replayed).toEqual(live)
})

test("a client ahead of the server is told to resynchronize", async () => {
  const { path } = await serve()
  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  const { sessionId } = await client.request("app.describe", {})
  const types: Array<RuntimeEvent["type"]> = []
  client.onEvent((event) => types.push(event.type))
  await client.request("app.subscribe", { since: { sessionId, sequence: 1_000_000 } })
  await waitUntil(() => types.length > 0, "the resync has arrived")
  expect(types).toEqual(["resync.required"])
})

test("unsubscribing stops events", async () => {
  const { path } = await serve()
  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  await client.request("app.wait", { idle: true })
  const seen: Array<RuntimeEvent> = []
  client.onEvent((event) => seen.push(event))
  const { subscriptionId } = await client.request("app.subscribe", {})
  await client.request("app.unsubscribe", { subscriptionId })
  await client.request("app.dispatch", { action: "OpenSettings", await: true })
  await client.request("app.wait", { idle: true })
  expect(seen).toEqual([])
})

test("the socket is private to its user", async () => {
  const { path } = await serve()
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("the envelope is validated and only real methods are callable", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  const send = (message: unknown) => peer.write(`${JSON.stringify(message)}\n`)

  send({ jsonrpc: "2.0", id: { a: 1 }, method: "app.describe" })
  expect(await peer.next()).toMatchObject({ id: null, error: { code: -32600 } })

  send({ jsonrpc: "2.0", id: 1, method: "app.describe", params: 5 })
  expect(await peer.next()).toMatchObject({ id: 1, error: { code: -32602 } })

  for (const method of ["constructor", "toString", "__proto__", "session.shutdown"]) {
    send({ jsonrpc: "2.0", id: method, method, params: {} })
    expect(await peer.next()).toMatchObject({ id: method, error: { code: -32601 } })
  }

  send({ jsonrpc: "2.0", id: 2, method: "app.wait", params: { timeoutMs: "soon" } })
  expect(await peer.next()).toMatchObject({ id: 2, error: { code: -32602 } })

  send({ jsonrpc: "2.0", id: 3, method: "app.inspect", params: { tree: "yes" } })
  expect(await peer.next()).toMatchObject({ id: 3, error: { code: -32602 } })
})

test("batches are answered together, leaving out notifications", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  peer.write(
    `${JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "app.describe" },
      { jsonrpc: "2.0", method: "app.describe" },
      { jsonrpc: "2.0", id: 2, method: "nope" },
    ])}\n`,
  )
  expect(await peer.next()).toMatchObject([
    { id: 1, result: { app: "inventory" } },
    { id: 2, error: { code: -32601 } },
  ])

  peer.write("[]\n")
  expect(await peer.next()).toMatchObject({ id: null, error: { code: -32600 } })

  const item = { jsonrpc: "2.0", id: 1, method: "app.describe" }
  peer.write(`${JSON.stringify(Array.from({ length: BATCH_REQUESTS_MAX }, () => item))}\n`)
  expect(await peer.next()).toHaveLength(BATCH_REQUESTS_MAX)

  peer.write(`${JSON.stringify(Array.from({ length: BATCH_REQUESTS_MAX + 1 }, () => item))}\n`)
  expect(await peer.next()).toMatchObject({ id: null, error: { code: -32600 } })
})

test("requests in flight are limited exactly", async () => {
  const controller = await createController(app)
  cleanups.push(() => controller.close())
  const lines: Array<unknown> = []
  const connection = createConnection(controller, (line) => lines.push(JSON.parse(line)))
  cleanups.push(() => connection.close())
  const wait = (id: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "app.wait",
      params: { focus: "Never", timeoutMs: 60_000 },
    })
  for (let id = 1; id <= CONNECTION_REQUESTS_MAX + 1; id++) {
    connection.receive(wait(id))
  }
  await waitUntil(() => lines.length > 0, "the request over the limit is refused")
  expect(lines).toEqual([
    expect.objectContaining({
      id: CONNECTION_REQUESTS_MAX + 1,
      error: expect.objectContaining({ code: ErrorCode.ResourceExhausted }),
    }),
  ])
})

test("a subscription's reply comes before its replay", async () => {
  const { path } = await serve()
  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  await client.request("app.wait", { idle: true })
  const { sessionId } = await client.request("app.describe", {})
  const peer = await rawPeer(path)
  const since = { sessionId, sequence: 0 }
  const message = { jsonrpc: "2.0", id: 1, method: "app.subscribe", params: { since } }
  peer.write(`${JSON.stringify(message)}\n`)
  expect(await peer.next()).toMatchObject({ id: 1, result: {} })
  expect(await peer.next()).toMatchObject({ method: "app.event" })
})

test("a client says why it ended", async () => {
  const closed = createClient({ send: () => undefined })
  closed.close()
  expect(await closed.ended).toBeNull()
  const failed = createClient({ send: () => undefined })
  failed.fail(new Error("Connection closed"))
  expect(await failed.ended).toMatchObject({ message: "Connection closed" })
})

test("a reset is given as long as the server may take", async () => {
  let timeoutMs = 0
  const client = createClient({
    send: () => undefined,
    timers: {
      setTimeout: (_, durationMs) => {
        timeoutMs = durationMs
        return undefined
      },
      clearTimeout: () => undefined,
    },
  })
  client.request("app.reset", {}).catch(() => undefined)
  expect(timeoutMs).toBeGreaterThan(
    SESSION_START_TIMEOUT_MS_MAX + SESSION_DISPOSE_TIMEOUT_MS_DEFAULT,
  )
  client.close()
})

test("the last line of a stream needs no newline", () => {
  const lines: Array<string> = []
  const read = createLineReader({ onLine: (line) => lines.push(line), onOverflow: () => undefined })
  read("first\nlast")
  read.flush()
  expect(lines).toEqual(["first", "last"])
})

test("params must be an object if they are given at all", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe", params: null })}\n`)
  expect(await peer.next()).toMatchObject({ id: 1, error: { code: -32602 } })
})

test("an id that does not survive being echoed is refused", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  peer.write('{"jsonrpc":"2.0","id":1e400,"method":"app.describe"}\n')
  expect(await peer.next()).toMatchObject({ id: null, error: { code: -32600 } })
})

test("the write queue is counted in bytes, whatever the characters", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-"))
  const path = join(directory, "s.sock")
  const Wide = defineCapability({
    name: "Wide",
    state: Schema.Struct({ text: Schema.String }),
    actions: () => ({}),
  })
  const host = defineApp({
    name: "wide",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Wide, { text: "語".repeat(1000) })
        const runtime = yield* Registry
        runtime.setFocus(node.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const controller = await createController(host)
  // Under the reply's bytes, but over its characters.
  const server = await serveSocket(controller, path, { writeQueueBytesMax: 2500 })
  cleanups.push(async () => {
    server.close()
    await controller.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const socket = connect(path)
  cleanups.push(() => void socket.destroy())
  socket.on("error", () => undefined)
  const closed = new Promise((resolve) => socket.once("close", resolve))
  await new Promise((resolve) => socket.once("connect", resolve))
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.inspect" })}\n`)
  await closed
})

test("a server that stops reading cannot fill the client's memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-"))
  const path = join(directory, "s.sock")
  const peers: Array<{ destroy(): void }> = []
  const silent = createServer((socket) => {
    socket.pause()
    peers.push(socket)
  })
  await new Promise<void>((resolve) => silent.listen(path, resolve))
  cleanups.push(() => {
    for (const peer of peers) {
      peer.destroy()
    }
    silent.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  const input = "x".repeat(4 * 1024 * 1024)
  const outcomes: Array<unknown> = []
  for (let index = 0; index < 20; index++) {
    const request = client.request("app.dispatch", { action: "A", input }, { timeoutMs: 1 })
    outcomes.push(await request.catch((error: unknown) => error))
  }
  expect(outcomes.some((outcome) => outcome instanceof ProtocolError)).toBe(true)
}, 20_000)

test("a request id too long to echo is refused", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  const id = "x".repeat(REQUEST_ID_CHARACTERS_MAX + 1)
  peer.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "app.describe" })}\n`)
  expect(await peer.next()).toMatchObject({ id: null, error: { code: -32600 } })
})

test("a peer that sends an endless frame is disconnected", async () => {
  const { path } = await serve()
  const socket = connect(path)
  cleanups.push(() => void socket.destroy())
  const closed = new Promise((resolve) => socket.once("close", resolve))
  socket.on("error", () => {})
  const chunk = "x".repeat(1024 * 1024)
  for (let index = 0; index < 10; index++) {
    socket.write(chunk)
  }
  await closed
}, 20_000)

test("a subscriber that stops reading is cut off, not buffered without limit", async () => {
  const { path } = await serve()
  const peer = connect(path)
  cleanups.push(() => void peer.destroy())
  await new Promise((resolve) => peer.once("connect", resolve))
  peer.on("error", () => {})
  const closed = new Promise((resolve) => peer.once("close", resolve))
  const subscribed = new Promise((resolve) => peer.once("data", resolve))
  peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.subscribe" })}\n`)
  await subscribed
  peer.pause()

  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  await client.request("app.wait", { idle: true })
  await client.request("app.dispatch", {
    action: "OpenProduct",
    input: { productId: "p" },
    await: true,
  })
  await client.request("app.wait", { idle: true })
  // The product id is state, so each visit fans multi-megabyte events out.
  const big = "x".repeat(3 * 1024 * 1024)
  for (let index = 0; index < 8; index++) {
    await client.request("app.dispatch", { action: "GoBack", await: true })
    await client.request("app.wait", { idle: true })
    await client.request("app.dispatch", {
      action: "OpenProduct",
      input: { productId: big },
      await: true,
    })
    await client.request("app.wait", { idle: true })
  }
  // A paused socket reports nothing. Had the server kept it, this would hang.
  peer.resume()
  await closed
}, 20_000)

test("one reply larger than the queue limit disconnects a slow peer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-"))
  const path = join(directory, "s.sock")
  const controller = await createController(app)
  const server = await serveSocket(controller, path, { writeQueueBytesMax: 64 })
  cleanups.push(async () => {
    server.close()
    await controller.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const socket = connect(path)
  cleanups.push(() => void socket.destroy())
  socket.on("error", () => {})
  const closed = new Promise((resolve) => socket.once("close", resolve))
  await new Promise((resolve) => socket.once("connect", resolve))
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.inspect", params: { tree: true } })}\n`,
  )
  await closed
})

const isFailure = (reply: unknown): boolean =>
  typeof reply === "object" && reply !== null && "error" in reply

const closedClient = () => {
  const client = createClient({ send: () => undefined })
  client.close()
  return client
}

test("a client that has ended refuses new requests instead of hanging", async () => {
  await expect(closedClient().request("app.describe", {})).rejects.toThrow("closed")

  const failed = createClient({ send: () => undefined })
  failed.fail(new Error("Connection closed"))
  await expect(failed.request("app.describe", {})).rejects.toThrow("Connection closed")
  await failed.ended
})

test("a request that cannot be sent frees its slot", async () => {
  const client = createClient({
    send: () => {
      throw new Error("unsendable")
    },
  })
  for (let attempt = 0; attempt < CLIENT_PENDING_REQUESTS_MAX + 1; attempt++) {
    await expect(client.request("app.describe", {})).rejects.toThrow("unsendable")
  }
  client.close()
})

test("subscriptions are capped even when requested all at once", async () => {
  const { path } = await serve()
  const peer = await rawPeer(path)
  const subscribe = (id: number) => ({ jsonrpc: "2.0", id, method: "app.subscribe" })
  const requestCount = CONNECTION_SUBSCRIPTIONS_MAX + 1
  peer.write(`${JSON.stringify(Array.from({ length: requestCount }, (_, id) => subscribe(id)))}\n`)
  const replies = await peer.next()
  expect(Array.isArray(replies) ? replies.filter(isFailure) : []).toHaveLength(1)
})

test("unsubscribing frees a slot", async () => {
  const { path } = await serve()
  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  const ids = []
  for (let index = 0; index < CONNECTION_SUBSCRIPTIONS_MAX; index++) {
    ids.push((await client.request("app.subscribe", {})).subscriptionId)
  }
  await client.request("app.unsubscribe", { subscriptionId: ids[0] ?? "" })
  await client.request("app.subscribe", {})
  await expect(client.request("app.subscribe", {})).rejects.toMatchObject({ code: -32013 })
})

test("an overloaded connection stays silent about notifications", async () => {
  const controller = await createController(app)
  cleanups.push(() => controller.close())
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  cleanups.push(() => connection.close())
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "app.describe" })
  for (let index = 0; index < CONNECTION_REQUESTS_MAX + 1; index++) {
    connection.receive(notification)
  }
  await nextTurn()
  expect(lines).toEqual([])
})

test("a request with no reply times out", async () => {
  const client = createClient({ send: () => undefined })
  await expect(client.request("app.describe", {}, { timeoutMs: 1 })).rejects.toThrow("No reply")
  client.close()
})

test("a server that sends nonsense ends the client, with its requests", async () => {
  for (const line of ["null", "not json", '{"jsonrpc":"2.0","id":1,"result":{"wrong":true}}']) {
    const client = createClient({ send: () => undefined })
    const pending = client.request("app.describe", {})
    client.receive(line)
    await expect(pending).rejects.toThrow()
    await expect(client.request("app.describe", {})).rejects.toThrow("Invalid message")
  }
})

test("a frame exactly at the limit passes, and one past it does not", () => {
  const lines: Array<string> = []
  let overflowCount = 0
  const reader = () =>
    createLineReader({
      onLine: (line) => lines.push(line),
      onOverflow: () => overflowCount++,
      frameCharactersMax: 4,
    })
  reader()("abcd\n")
  expect(lines).toEqual(["abcd"])
  reader()("abcde\n")
  expect(lines).toEqual(["abcd"])
  expect(overflowCount).toBe(1)
})

test("a frame split across many chunks is reassembled", () => {
  const lines: Array<string> = []
  const read = createLineReader({ onLine: (line) => lines.push(line), onOverflow: () => undefined })
  for (const chunk of ["ab", "cd", "\nef", "\n"]) {
    read(chunk)
  }
  expect(lines).toEqual(["abcd", "ef"])
})

test("a reply a client would refuse is not sent, and says why", async () => {
  const deep = (depth: number): Json => (depth === 0 ? 1 : [deep(depth - 1)])
  const controller = {
    request: async () => ({ value: deep(JSON_DEPTH_MAX) }),
    subscribe: async () => ({ unsubscribe: () => undefined, sessionId: "s", sequence: 0 }),
    close: async () => undefined,
  } as unknown as Parameters<typeof createConnection>[0]
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  cleanups.push(() => connection.close())
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.inspect", params: {} }))
  await waitUntil(() => lines.length > 0, "the request is answered")
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    id: 1,
    error: { code: ErrorCode.ResourceExhausted },
  })
})

const largeStateController = async () => {
  const Large = defineCapability({
    name: "Large",
    state: Schema.Struct({ text: Schema.String }),
    actions: () => ({}),
  })
  const host = defineApp({
    name: "large",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Large, { text: "x".repeat(FRAME_CHARACTERS_MAX * 0.6) })
        const runtime = yield* Registry
        runtime.setFocus(node.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const controller = await createController(host)
  cleanups.push(() => controller.close())
  return controller
}

test("a batch too large to send still answers each of its requests", async () => {
  const controller = await largeStateController()
  const lines: Array<unknown> = []
  const connection = createConnection(controller, (line) => lines.push(JSON.parse(line)))
  cleanups.push(() => connection.close())
  const inspect = (id: number) => ({ jsonrpc: "2.0", id, method: "app.inspect", params: {} })
  connection.receive(JSON.stringify([inspect(10), inspect(11)]))
  await waitUntil(() => lines.length > 0, "the batch is answered")
  expect(lines[0]).toMatchObject([
    { id: 10, result: expect.anything() },
    { id: 11, error: { code: ErrorCode.ResourceExhausted } },
  ])
})

test("a batch's acknowledgments arrive however large its other replies are", async () => {
  const controller = await largeStateController()
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  cleanups.push(() => connection.close())
  const inspect = (id: number) => ({ jsonrpc: "2.0", id, method: "app.inspect", params: {} })
  const subscribe = { jsonrpc: "2.0", id: 12, method: "app.subscribe", params: {} }
  connection.receive(JSON.stringify([inspect(10), inspect(11), subscribe]))
  await waitUntil(() => lines.length > 0, "the batch is answered")
  expect(lines[0]?.length).toBeLessThanOrEqual(FRAME_CHARACTERS_MAX)
  expect(JSON.parse(lines[0] ?? "")).toMatchObject([
    { id: 10 },
    { id: 11, error: { code: ErrorCode.ResourceExhausted } },
    { id: 12, result: { subscriptionId: expect.any(String) } },
  ])
})

test("a socket server's failures reach the reporter it was given", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-"))
  const path = join(directory, "s.sock")
  const controller = await createController(app)
  const reported: Array<unknown> = []
  const failing: typeof controller = {
    ...controller,
    subscribe: controller.subscribe.bind(controller),
    close: controller.close.bind(controller),
    request: async () => {
      throw new Error("a failure with no request to tell")
    },
  }
  const server = await serveSocket(failing, path, {
    onBackgroundError: (error) => reported.push(error),
  })
  cleanups.push(async () => {
    await server.close()
    await controller.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const socket = connect(path)
  cleanups.push(() => {
    socket.destroy()
  })
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "app.describe" })}\n`)
  await waitUntil(() => reported.length === 1, "the failure is reported")
})

test("client listeners are capped", () => {
  const client = createClient({ send: () => undefined })
  for (let index = 0; index < CLIENT_LISTENERS_MAX; index++) {
    client.onEvent(() => undefined)
  }
  expect(() => client.onEvent(() => undefined)).toThrow("Too many")
  client.close()
})

test("connections past the limit are not served", async () => {
  const { path } = await serve()
  const sockets = Array.from({ length: SERVER_CONNECTIONS_MAX + 1 }, () => connect(path))
  cleanups.push(() => {
    for (const socket of sockets) {
      socket.destroy()
    }
  })
  const closes = sockets.map(
    (socket) =>
      new Promise<void>((resolve) => {
        socket.on("error", () => undefined)
        socket.once("close", () => resolve())
      }),
  )
  await Promise.race(closes)
})

test("shutdown validates its params like any other method", async () => {
  const controller = await createController(app)
  cleanups.push(() => controller.close())
  let shutdownCount = 0
  const lines: Array<unknown> = []
  const connection = createConnection(controller, (line) => lines.push(JSON.parse(line)), {
    onShutdown: () => shutdownCount++,
  })
  cleanups.push(() => connection.close())
  const message = { jsonrpc: "2.0", id: 1, method: "session.shutdown", params: { force: true } }
  connection.receive(JSON.stringify(message))
  await waitUntil(() => lines.length > 0, "the request is answered")
  expect(lines[0]).toMatchObject({ error: { code: -32602 } })
  await nextTurn()
  expect(shutdownCount).toBe(0)
})

test("an event listener that throws does not end the client", async () => {
  const reported: Array<unknown> = []
  const client = createClient({
    send: () => undefined,
    onBackgroundError: (error) => reported.push(error),
  })
  client.onEvent(() => {
    throw new Error("listener failed")
  })
  const event = { type: "resync.required", sessionId: "s", sequence: 1, revision: 1 }
  const params = { subscriptionId: "sub-1", event }
  client.receive(JSON.stringify({ jsonrpc: "2.0", method: "app.event", params }))
  expect(reported).toHaveLength(1)
  const pending = client.request("app.describe", {}, { timeoutMs: 1 })
  await expect(pending).rejects.toThrow("No reply")
  client.close()
})

test("listeners can tell subscriptions apart", async () => {
  const { path } = await serve()
  const client = await connectSocket(path)
  cleanups.push(() => client.close())
  await client.request("app.wait", { idle: true })
  const seen = new Set<string>()
  client.onEvent((_, subscriptionId) => seen.add(subscriptionId))
  await client.request("app.subscribe", {})
  await client.request("app.subscribe", {})
  await client.request("app.dispatch", { action: "OpenSettings", await: true })
  await waitUntil(() => seen.size === 2, "both subscriptions have delivered")
})

test("an error code this client does not know is reported as such", async () => {
  const client = createClient({ send: () => undefined })
  const pending = client.request("app.describe", {})
  const error = { code: -32999, message: "from the future" }
  client.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, error }))
  await expect(pending).rejects.toMatchObject({
    code: ErrorCode.InternalError,
    message: expect.stringContaining("-32999"),
  })
  client.close()
})

test("held events that would overrun the write queue resynchronize, and the peer stays", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-"))
  const path = join(directory, "s.sock")
  let emit: (event: RuntimeEvent) => void = () => undefined
  let finishWait: () => void = () => undefined
  const controller = {
    request: async (method: string) => {
      if (method === "app.wait") {
        await new Promise<void>((resolve) => {
          finishWait = resolve
        })
      }
      return { ok: true }
    },
    subscribe: async (listener: (event: RuntimeEvent) => void) => {
      emit = listener
      return { unsubscribe: () => undefined, sessionId: "s", sequence: 0 }
    },
    close: async () => undefined,
  } as unknown as Parameters<typeof serveSocket>[0]
  const server = await serveSocket(controller, path)
  cleanups.push(async () => {
    await server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const socket = connect(path)
  cleanups.push(() => {
    socket.destroy()
  })
  let received = ""
  let closed = false
  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    received += chunk
  })
  socket.on("close", () => {
    closed = true
  })
  const call = (id: number, method: string) => ({ jsonrpc: "2.0", id, method, params: {} })
  socket.write(`${JSON.stringify([call(1, "app.subscribe"), call(2, "app.wait")])}\n`)
  await waitUntil(() => received === "" && emit.length === 1, "the subscription to open")
  await nextTurn()
  // Three bytes a character: over the write queue, though well under the event log's count.
  const state = "漢".repeat(1024 * 1024)
  const nodeId = "n" as never
  for (let sequence = 1; sequence <= 12; sequence++) {
    emit({ type: "state.changed", sessionId: "s", sequence, revision: sequence, nodeId, state })
  }
  finishWait()
  await waitUntil(() => received.includes("resync.required"), "the peer to be told")
  expect(closed).toBe(false)
})

test("a socket server's event failures reach the reporter it was given", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-"))
  const path = join(directory, "s.sock")
  let emit: (event: RuntimeEvent) => void = () => undefined
  const controller = {
    request: async () => ({}),
    subscribe: async (listener: (event: RuntimeEvent) => void) => {
      emit = listener
      return { unsubscribe: () => undefined, sessionId: "s", sequence: 0 }
    },
    close: async () => undefined,
  } as unknown as Parameters<typeof serveSocket>[0]
  const reported: Array<unknown> = []
  const server = await serveSocket(controller, path, {
    onBackgroundError: (error) => reported.push(error),
  })
  const socket = connect(path)
  cleanups.push(async () => {
    socket.destroy()
    await server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  let received = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    received += chunk
  })
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.subscribe" })}\n`)
  await waitUntil(() => received.includes("subscriptionId"), "the subscription to open")
  const state = { error: undefined } as never
  const nodeId = "n" as never
  emit({ type: "state.changed", sessionId: "s", sequence: 1, revision: 1, nodeId, state })
  await waitUntil(() => reported.length === 1, "the failure is reported")
})

test("the client refuses requests past its limit, and timed-out ones free their slots", async () => {
  const sent: Array<string> = []
  const client = createClient({ send: (line) => sent.push(line) })
  cleanups.push(() => client.close())
  const outstanding = Array.from({ length: CLIENT_PENDING_REQUESTS_MAX }, () =>
    client.request("app.describe", {}, { timeoutMs: 20 }).catch((error: unknown) => error),
  )
  await expect(client.request("app.describe", {})).rejects.toMatchObject({
    code: ErrorCode.ResourceExhausted,
  })
  expect(sent).toHaveLength(CLIENT_PENDING_REQUESTS_MAX)
  await Promise.all(outstanding)
  client.request("app.describe", {}, { timeoutMs: 20 }).catch(() => undefined)
  expect(sent).toHaveLength(CLIENT_PENDING_REQUESTS_MAX + 1)
})

test("awaited dispatches survive the ordinary deadline and expire after the server budget", async () => {
  let nowMs = 0
  let lastId = 0
  const timers = new Map<number, { atMs: number; fire: () => void }>()
  const client = createClient({
    send: () => undefined,
    timers: {
      setTimeout: (fire, durationMs) => {
        const id = ++lastId
        timers.set(id, { atMs: nowMs + durationMs, fire })
        return id
      },
      clearTimeout: (id) => {
        if (typeof id === "number") {
          timers.delete(id)
        }
      },
    },
  })
  const advance = (durationMs: number) => {
    nowMs += durationMs
    for (const [id, timer] of timers) {
      if (timer.atMs <= nowMs) {
        timers.delete(id)
        timer.fire()
      }
    }
  }
  let result: unknown = "pending"
  const pending = client
    .request("app.dispatch", { action: "Slow", await: true })
    .catch((error: unknown) => {
      result = error
    })
  try {
    advance(30_000)
    await Promise.resolve()
    expect(result).toBe("pending")
    advance(570_000)
    await Promise.resolve()
    expect(result).toBe("pending")
    advance(1_000)
    await pending
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain("No reply to app.dispatch")
  } finally {
    client.close()
  }
})
