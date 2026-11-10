/** The MCP server, against a real headless session reached through the real protocol. */
import { afterEach, expect, test } from "bun:test"
import { type AccessPolicy, ErrorCode } from "@reflex/protocol"
import { type Client, createLoopbackClient } from "@reflex/rpc"
import { type Controller, createController } from "@reflex/runtime/internal"
import { nextTurn, waitUntil } from "@reflex/test"
import app from "../../../examples/inventory/src/app.ts"
import * as commands from "../src/commands.ts"
import type { Target } from "../src/config.ts"
import { createMcpServer, MCP_CALLS_MAX, MCP_PROTOCOL_VERSIONS, TOOLS } from "../src/mcp.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

interface Message {
  readonly id?: string | number | null
  readonly result?: {
    readonly isError?: boolean
    readonly structuredContent?: Record<string, unknown>
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text: string }>
    readonly [key: string]: unknown
  }
  readonly error?: { readonly code: number; readonly message: string }
}

const setup = async (
  options: {
    readonly connect?: (target: Target) => Promise<Client>
    readonly access?: AccessPolicy
  } = {},
) => {
  const controller: Controller = await createController(app)
  cleanups.push(() => controller.close())
  const clients: Array<Client> = []
  const targets: Array<Target> = []
  const sent: Array<Message> = []
  const server = createMcpServer({
    target: "headless",
    version: "test",
    ...(options.access === undefined ? {} : { access: options.access }),
    connect:
      options.connect ??
      (async (target) => {
        targets.push(target)
        const client = createLoopbackClient(controller)
        clients.push(client)
        return client
      }),
    send: (line) => sent.push(JSON.parse(line)),
  })
  cleanups.push(() => server.close())
  let lastId = 0
  const request = (method: string, params?: unknown): number => {
    const id = ++lastId
    server.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return id
  }
  const answer = async (id: number): Promise<Message> => {
    await waitUntil(() => sent.some((message) => message.id === id), `an answer to ${id}`)
    return sent.find((message) => message.id === id) ?? {}
  }
  const call = async (name: string, args?: unknown) =>
    answer(request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }))
  const initialize = (protocolVersion: string) =>
    answer(
      request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
    )
  return { server, controller, clients, targets, sent, request, answer, call, initialize }
}

test("initialize agrees on the client's version if supported, and the newest otherwise", async () => {
  const { initialize } = await setup()
  expect((await initialize("2025-06-18")).result).toMatchObject({
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "reflex" },
  })
  expect((await initialize("1999-01-01")).result?.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0])
})

test("every tool is listed with a closed schema that takes a target", async () => {
  const { request, answer } = await setup()
  const { result } = await answer(request("tools/list"))
  const tools = result?.tools as ReadonlyArray<{
    readonly name: string
    readonly inputSchema: {
      readonly properties: Record<string, unknown>
      readonly additionalProperties: boolean
    }
    readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean }
  }>
  expect(tools.map(({ name }) => name)).toEqual(TOOLS.map(({ name }) => name))
  for (const tool of tools) {
    expect(tool.inputSchema.properties.target).toBeDefined()
    expect(tool.inputSchema.additionalProperties).toBe(false)
  }
  const reset = tools.find(({ name }) => name === "reflex_reset")
  expect(reset?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
})

test("a tool answers exactly what the CLI command prints", async () => {
  const { call, initialize, controller } = await setup()
  await initialize("2025-06-18")
  const viaMcp = await call("reflex_inspect")
  const direct = createLoopbackClient(controller)
  cleanups.push(() => direct.close())
  const viaCli = await commands.list(direct, "with-schema")
  expect(viaMcp.result?.structuredContent).toEqual(viaCli as never)
  expect(JSON.parse(viaMcp.result?.content?.[0]?.text ?? "")).toEqual(viaCli)
})

test("a dispatch runs the action and shows where the app is afterwards", async () => {
  const { call, initialize } = await setup()
  await initialize("2025-06-18")
  const { result } = await call("reflex_dispatch", {
    action: "OpenProduct",
    input: { productId: "product-123" },
  })
  expect(result?.isError).toBe(false)
  expect(result?.structuredContent).toMatchObject({
    operation: { status: "completed" },
    settled: true,
    now: { name: "InventoryDetail", state: { quantity: 5 } },
  })
})

test("an action that fails is a tool error, carrying the operation", async () => {
  const { call, initialize } = await setup()
  await initialize("2025-06-18")
  await call("reflex_dispatch", { action: "OpenProduct", input: { productId: "product-123" } })
  await call("reflex_dispatch", { action: "FailNextSave" })
  const { result } = await call("reflex_dispatch", { action: "Save" })
  expect(result?.isError).toBe(true)
  expect(result?.structuredContent).toMatchObject({ operation: { status: "failed" } })
})

test("the session's refusals are tool errors with their detail, for the model to act on", async () => {
  const { call } = await setup()
  const { result } = await call("reflex_dispatch", { action: "Nope" })
  expect(result?.isError).toBe(true)
  const text = JSON.parse(result?.content?.[0]?.text ?? "")
  expect(text.error).toMatchObject({ code: ErrorCode.ActionNotFound })
  expect(text.error.data.available).toContain("OpenProduct")
})

test("bad arguments are tool errors that say what is wrong, and nothing runs", async () => {
  const { call, clients } = await setup()
  for (const [args, message] of [
    [{}, "action is required"],
    [{ action: "Save", extra: 1 }, 'Unknown argument "extra"'],
    [{ action: "Save", target: "phone" }, "target must be"],
    [{ action: "Save", timeoutMs: -1 }, "timeoutMs must be an integer"],
    [[1], "arguments must be an object"],
  ] as const) {
    const { result } = await call("reflex_dispatch", args)
    expect(result?.isError).toBe(true)
    expect(JSON.parse(result?.content?.[0]?.text ?? "").error.message).toContain(message)
  }
  expect(clients).toHaveLength(0)
})

test("the target argument picks the session, and the server's is the default", async () => {
  const { call, targets } = await setup()
  await call("reflex_status")
  await call("reflex_status", { target: "device" })
  expect(targets).toEqual(["headless", "device"])
})

test("a session that cannot be reached is a tool error naming how to start one", async () => {
  const { call } = await setup({
    connect: async () => {
      throw new Error("No session running. Start one with: reflex start <app-module>")
    },
  })
  const { result } = await call("reflex_status")
  expect(result?.isError).toBe(true)
  expect(result?.content?.[0]?.text).toContain("reflex start")
})

test("results before 2025-06-18 carry text only", async () => {
  const { call, initialize } = await setup()
  await initialize("2025-03-26")
  const { result } = await call("reflex_status")
  expect(result?.structuredContent).toBeUndefined()
  expect(JSON.parse(result?.content?.[0]?.text ?? "")).toMatchObject({ app: "inventory" })
})

test("a cancelled call gets no answer, and its connection to the session is closed", async () => {
  const { server, request, sent, clients } = await setup()
  const id = request("tools/call", {
    name: "reflex_wait",
    arguments: { focus: "Never", timeoutMs: 600_000 },
  })
  await waitUntil(() => clients.length === 1, "the call connects")
  server.receive(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id },
    }),
  )
  await server.drained()
  await nextTurn()
  expect(clients[0]?.isEnded).toBe(true)
  expect(sent.some((message) => message.id === id)).toBe(false)
})

test("calls running at once are bounded", async () => {
  const { request, answer, server } = await setup()
  const waitForever = { name: "reflex_wait", arguments: { focus: "Never", timeoutMs: 600_000 } }
  for (let index = 0; index < MCP_CALLS_MAX; index++) {
    request("tools/call", waitForever)
  }
  const refused = await answer(request("tools/call", waitForever))
  expect(refused.error).toMatchObject({ code: ErrorCode.ResourceExhausted })
  server.close()
})

test("unknown tools and methods, and malformed messages, are protocol errors", async () => {
  const { request, answer, server, sent } = await setup()
  expect((await answer(request("tools/call", { name: "nope" }))).error?.code).toBe(
    ErrorCode.InvalidParams,
  )
  expect((await answer(request("resources/list"))).error?.code).toBe(ErrorCode.MethodNotFound)
  expect((await answer(request("ping"))).result).toEqual({})
  server.receive("{not json")
  expect(sent.at(-1)?.error?.code).toBe(ErrorCode.ParseError)
})

const toolNames = async (setupResult: Awaited<ReturnType<typeof setup>>) => {
  const { request, answer } = setupResult
  const { result } = await answer(request("tools/list"))
  const tools = (result?.tools ?? []) as ReadonlyArray<{ name: string }>
  return tools.map(({ name }) => name)
}

test("an observing server offers only tools that change nothing", async () => {
  const observing = await setup({ access: { kind: "observe" } })
  expect(await toolNames(observing)).toEqual([
    "reflex_status",
    "reflex_inspect",
    "reflex_tree",
    "reflex_wait",
    "reflex_sample",
  ])
  const refused = await observing.call("reflex_dispatch", { action: "OpenProduct" })
  expect(refused.error?.code).toBe(ErrorCode.InvalidParams)
  const { result } = await observing.call("reflex_status")
  expect(JSON.parse(result?.content?.[0]?.text ?? "").access).toEqual({ kind: "observe" })
})

test("an allowlist server dispatches only the actions it names, and says which", async () => {
  const limited = await setup({ access: { kind: "actions", actions: ["OpenProduct"] } })
  const { request, answer } = limited
  const { result: listed } = await answer(request("tools/list"))
  const tools = listed?.tools as ReadonlyArray<{ name: string; description: string }>
  expect(tools.map(({ name }) => name)).toContain("reflex_dispatch")
  expect(tools.map(({ name }) => name)).not.toContain("reflex_reset")
  expect(tools.find(({ name }) => name === "reflex_dispatch")?.description).toContain(
    "may run only: OpenProduct",
  )
  const opened = await limited.call("reflex_dispatch", {
    action: "OpenProduct",
    input: { productId: "product-123" },
  })
  expect(opened.result?.isError).toBe(false)
  const refused = await limited.call("reflex_dispatch", { action: "Increment" })
  expect(refused.result?.isError).toBe(true)
  expect(JSON.parse(refused.result?.content?.[0]?.text ?? "").error.code).toBe(
    ErrorCode.NotPermitted,
  )
  const inspected = await limited.call("reflex_inspect")
  expect(JSON.parse(inspected.result?.content?.[0]?.text ?? "").actions).toContainEqual(
    expect.objectContaining({ name: "Increment", unavailable: "Not permitted on this connection" }),
  )
})
