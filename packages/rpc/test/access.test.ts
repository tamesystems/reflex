import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ErrorCode } from "@reflex/protocol"
import {
  connectSocket,
  createConnection,
  createLoopbackClient,
  restrictClient,
  serveSocket,
} from "@reflex/rpc"
import { createController, restrictController } from "@reflex/runtime/internal"
import { waitUntil } from "../../../test/support.ts"
import inventoryDefinition from "../../../examples/inventory/src/scenarios.ts"
const app = inventoryDefinition[APP_HOST_ADAPTER]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

const controller = async () => {
  const created = await createController(app)
  cleanups.push(() => created.close())
  return created
}

test("a connection held to observing refuses changes and shutdown on the wire", async () => {
  const lines: Array<{ id: number; error?: { code: number }; result?: unknown }> = []
  let shutdowns = 0
  const connection = createConnection(await controller(), (line) => lines.push(JSON.parse(line)), {
    access: { kind: "observe" },
    onShutdown: () => {
      shutdowns++
    },
  })
  cleanups.push(() => connection.close())
  const send = (id: number, method: string, params: unknown = {}) =>
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  send(1, "app.inspect")
  send(2, "app.dispatch", { action: "OpenProduct", input: { productId: "product-123" } })
  send(3, "session.shutdown")
  send(4, "app.reset")
  await waitUntil(() => lines.length === 4, "every request is answered")
  const byId = new Map(lines.map((line) => [line.id, line]))
  expect(byId.get(1)?.result).toBeDefined()
  for (const id of [2, 3, 4]) {
    expect(byId.get(id)?.error?.code).toBe(ErrorCode.NotPermitted)
  }
  expect(shutdowns).toBe(0)
})

test("a restricted client refuses before anything is sent", async () => {
  const sent: Array<string> = []
  const inner = createLoopbackClient(await controller())
  const counting = {
    ...inner,
    request: ((method: string, params: never, options?: never) => {
      sent.push(method)
      return inner.request(method as never, params, options)
    }) as typeof inner.request,
  }
  cleanups.push(() => inner.close())
  const client = restrictClient(counting, { kind: "actions", actions: ["OpenProduct"] })
  const refused = await client
    .request("app.dispatch", { action: "Increment" })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ code: ErrorCode.NotPermitted })
  expect(sent).toEqual([])
  const opened = await client.request("app.dispatch", {
    action: "OpenProduct",
    input: { productId: "product-123" },
    await: true,
  })
  expect(opened.status).toBe("completed")
  expect((await client.request("app.describe", {})).access).toEqual({
    kind: "actions",
    actions: ["OpenProduct"],
  })
})

test("cancelling is judged by the action the operation runs", async () => {
  const session = await controller()
  const client = restrictClient(createLoopbackClient(session), {
    kind: "actions",
    actions: ["Save"],
  })
  cleanups.push(() => client.close())
  const full = createLoopbackClient(session)
  cleanups.push(() => full.close())
  const opening = await full.request("app.dispatch", {
    action: "OpenProduct",
    input: { productId: "product-123" },
  })
  const refused = await client
    .request("app.cancel", { operationId: opening.operationId })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ code: ErrorCode.NotPermitted })
})

/** A connection's peer, speaking raw JSON-RPC, answered in order of id. */
const peer = (connection: { receive(line: string): void }, lines: ReadonlyArray<string>) => {
  let lastId = 0
  return async (method: string, params: unknown = {}) => {
    const id = ++lastId + 1000
    const before = lines.length
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    await waitUntil(() => lines.slice(before).some((line) => JSON.parse(line).id === id), method)
    return JSON.parse(lines.slice(before).find((line) => JSON.parse(line).id === id) ?? "{}") as {
      readonly result?: { readonly status?: string; readonly operationId?: string }
      readonly error?: { readonly code: number }
    }
  }
}

test("a controller restricted by wrapping alone still refuses shutdown", async () => {
  let shutdowns = 0
  const lines: Array<string> = []
  const connection = createConnection(
    restrictController(await controller(), { kind: "observe" }),
    (line) => lines.push(line),
    { onShutdown: () => shutdowns++ },
  )
  cleanups.push(() => connection.close())
  const call = peer(connection, lines)
  expect((await call("session.shutdown")).error?.code).toBe(ErrorCode.NotPermitted)
  expect(shutdowns).toBe(0)
})

test("the session refuses to cancel an operation whose action is not allowed", async () => {
  const session = await createController(app, { scenario: "slow-network" })
  cleanups.push(() => session.close())
  const owner = createLoopbackClient(session)
  cleanups.push(() => owner.close())
  await owner.request("app.dispatch", {
    action: "OpenProduct",
    input: { productId: "product-123" },
    await: true,
  })
  const saving = await owner.request("app.dispatch", { action: "Save" })

  const lines: Array<string> = []
  const forbidden = createConnection(session, (line) => lines.push(line), {
    access: { kind: "actions", actions: ["Increment"] },
  })
  cleanups.push(() => forbidden.close())
  const refused = await peer(forbidden, lines)("app.cancel", { operationId: saving.operationId })
  expect(refused.error?.code).toBe(ErrorCode.NotPermitted)
  expect((await owner.request("app.operation", { operationId: saving.operationId })).status).toBe(
    "running",
  )

  const allowedLines: Array<string> = []
  const allowed = createConnection(session, (line) => allowedLines.push(line), {
    access: { kind: "actions", actions: ["Save"] },
  })
  cleanups.push(() => allowed.close())
  const cancelling = await peer(allowed, allowedLines)("app.cancel", {
    operationId: saving.operationId,
  })
  expect(cancelling.error).toBeUndefined()
  // Cancelling interrupts the operation; it is over once the interruption has run.
  const { operation } = await owner.request("app.wait", { operationId: saving.operationId })
  expect(operation?.status).toBe("cancelled")
})

test.skipIf(process.platform === "win32")(
  "a socket served with an access policy holds every peer to it",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "reflex-access-"))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, "observe.sock")
    const server = await serveSocket(await controller(), path, { access: { kind: "observe" } })
    cleanups.push(() => {
      server.close()
    })
    const client = await connectSocket(path)
    cleanups.push(() => client.close())
    expect((await client.request("app.inspect", {})).node?.name).toBe("InventoryList")
    const refused = await client
      .request("app.dispatch", { action: "OpenProduct", input: { productId: "product-123" } })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: ErrorCode.NotPermitted })
    expect((await client.request("app.inspect", {})).node?.name).toBe("InventoryList")
  },
)

test("the client guard lets an allowed cancel through", async () => {
  const session = await createController(app, { scenario: "slow-network" })
  cleanups.push(() => session.close())
  const owner = createLoopbackClient(session)
  cleanups.push(() => owner.close())
  await owner.request("app.dispatch", {
    action: "OpenProduct",
    input: { productId: "product-123" },
    await: true,
  })
  const saving = await owner.request("app.dispatch", { action: "Save" })
  const guarded = restrictClient(createLoopbackClient(session), {
    kind: "actions",
    actions: ["Save"],
  })
  cleanups.push(() => guarded.close())
  await guarded.request("app.cancel", { operationId: saving.operationId })
  const { operation } = await owner.request("app.wait", { operationId: saving.operationId })
  expect(operation?.status).toBe("cancelled")
})
