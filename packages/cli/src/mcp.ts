/**
 * An MCP server over stdio, for agents that speak MCP rather than run commands. Each tool
 * is a CLI command: it reaches the same session the CLI does, through the same socket,
 * and returns what that command would print. There is no second way to control an app.
 *
 * Only the tools part of MCP is served. Each call opens its own connection to the session,
 * so a session can be started, stopped or reset between calls, and a cancelled call
 * closes its connection, which ends its waits on the session as any departing peer does.
 */
import {
  type AccessPolicy,
  accessPolicy,
  boundedText,
  FULL_CONTROL,
  ErrorCode,
  isRecord,
  type Json,
  json,
  ProtocolError,
  paramParsers,
  toNodeId,
  WAIT_TIMEOUT_MS_DEFAULT,
  WAIT_TIMEOUT_MS_MAX,
  ADVANCE_TIME_MS_MAX,
} from "@reflex/protocol"
import { type Client, restrictClient } from "@reflex/rpc"
import { reportToConsole } from "@reflex/runtime/internal"
import * as commands from "./commands.ts"
import type { Target } from "./config.ts"

/** Newest first. A client asking for another is answered with the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
/** From this version on, a result may carry its value as structured content. */
const STRUCTURED_CONTENT_SINCE = "2025-06-18"
/** Calls at once. Each holds a session connection, and the session limits those. */
export const MCP_CALLS_MAX = 16
const ARGUMENT_CHARACTERS_MAX = 256

const INSTRUCTIONS = `Inspect and drive the app through its Reflex session: the same session \
the reflex CLI uses. Start with reflex_inspect to see the focused screen, its state and \
the actions available, with their input schemas; reflex_dispatch runs one and shows \
where the app is afterwards. Every tool takes target "headless" (the app running with no \
UI, started with \`reflex start <app-module>\`) or "device" (the app live through a bridge, using \`reflex --target device start\`).`

type JsonSchema = { readonly [key: string]: Json }

interface ToolOutcome {
  readonly value: unknown
  /** The call worked, but what it reports is a failure, such as an action that failed. */
  readonly failed?: boolean
}

interface Tool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly properties: { readonly [name: string]: JsonSchema }
  readonly required?: ReadonlyArray<string>
  readonly readOnly: boolean
  /** Discards app state that cannot be got back. */
  readonly destructive: boolean
  /**
   * Checks every argument first, before any connection: a call with a bad one must not
   * reach the session at all. Returns the work to do once connected.
   */
  readonly prepare: (args: Arguments) => (client: Client) => Promise<ToolOutcome>
}

/** The model's arguments, refused with a message it can act on. */
class ArgumentError extends Error {}

class Arguments {
  constructor(
    private readonly values: { readonly [key: string]: unknown },
    allowed: ReadonlyArray<string>,
  ) {
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) {
        throw new ArgumentError(`Unknown argument "${key.slice(0, ARGUMENT_CHARACTERS_MAX)}"`)
      }
    }
  }

  string(name: string): string | undefined {
    const value = this.values[name]
    if (value === undefined) {
      return undefined
    }
    if (typeof value !== "string" || value.length === 0 || value.length > ARGUMENT_CHARACTERS_MAX) {
      throw new ArgumentError(
        `${name} must be a string of 1 to ${ARGUMENT_CHARACTERS_MAX} characters`,
      )
    }
    return value
  }

  requiredString(name: string): string {
    const value = this.string(name)
    if (value === undefined) {
      throw new ArgumentError(`${name} is required`)
    }
    return value
  }

  integer(name: string, maximum: number): number | undefined {
    const value = this.values[name]
    if (value === undefined) {
      return undefined
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new ArgumentError(`${name} must be an integer from 0 to ${maximum}`)
    }
    return value
  }

  boolean(name: string): boolean | undefined {
    const value = this.values[name]
    if (value === undefined || typeof value === "boolean") {
      return value
    }
    throw new ArgumentError(`${name} must be true or false`)
  }

  json(name: string): Json | undefined {
    const value = this.values[name]
    return value === undefined ? undefined : json(value, name)
  }

  raw(): { readonly [key: string]: unknown } {
    return this.values
  }
}

const TARGET_PROPERTY: JsonSchema = {
  type: "string",
  enum: ["headless", "device"],
  description:
    "Which session: the headless app, or the app live through a bridge. Defaults to the server's.",
}
const NODE_ID_PROPERTY: JsonSchema = {
  type: "string",
  description:
    "A node's id, from reflex_inspect or reflex_tree. Defaults to the focused screen, then ambient nodes.",
}
const TIMEOUT_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: WAIT_TIMEOUT_MS_MAX,
  description: `How long to wait, in milliseconds (default ${WAIT_TIMEOUT_MS_DEFAULT})`,
}

const nodeIdOf = (args: Arguments) => {
  const nodeId = args.string("nodeId")
  return nodeId === undefined ? {} : { nodeId: toNodeId(nodeId) }
}

export const TOOLS: ReadonlyArray<Tool> = [
  {
    name: "reflex_status",
    title: "Session status",
    description: "The app, its session id, the scenario it runs and the scenarios it can run.",
    properties: {},
    readOnly: true,
    destructive: false,
    prepare: () => async (client) => ({ value: await commands.status(client) }),
  },
  {
    name: "reflex_inspect",
    title: "Inspect a node",
    description:
      "The focused screen, or the node named, with its state and every action available, " +
      "including each action's input schema and why an unavailable one is unavailable.",
    properties: {
      name: { type: "string", description: "A node's name, such as a screen's or a fixture's" },
      nodeId: NODE_ID_PROPERTY,
    },
    readOnly: true,
    destructive: false,
    prepare: (args) => {
      const name = args.string("name")
      const nodeId = args.string("nodeId")
      if (name !== undefined && nodeId !== undefined) {
        throw new ArgumentError("Give name or nodeId, not both")
      }
      return async (client) => {
        if (name !== undefined) {
          return { value: await commands.inspectNode(client, { name }) }
        }
        if (nodeId !== undefined) {
          return { value: await commands.inspectNode(client, { nodeId: toNodeId(nodeId) }) }
        }
        return { value: await commands.list(client, "with-schema") }
      }
    },
  },
  {
    name: "reflex_tree",
    title: "Every node",
    description: "Every active node: screens, navigation and fixtures, and which one has focus.",
    properties: {},
    readOnly: true,
    destructive: false,
    prepare: () => async (client) => ({ value: await commands.tree(client) }),
  },
  {
    name: "reflex_dispatch",
    title: "Run an action",
    description:
      "Run an action, by default on the focused screen, then wait for it and for whatever " +
      "it started to settle, and show where the app is afterwards. Navigation is an action " +
      "too: Navigate and GoBack, on the Navigation node.",
    properties: {
      action: { type: "string", description: "The action's name, as reflex_inspect lists it" },
      input: { description: "The action's input, matching its input schema" },
      nodeId: NODE_ID_PROPERTY,
      wait: {
        type: "boolean",
        description: "Wait for the action to finish (default true)",
      },
      timeoutMs: TIMEOUT_PROPERTY,
    },
    required: ["action"],
    readOnly: false,
    // An action can do anything the app does, including overwrite what it holds.
    destructive: true,
    prepare: (args) => {
      const input = args.json("input")
      const options = {
        action: args.requiredString("action"),
        ...(input === undefined ? {} : { input }),
        ...nodeIdOf(args),
        wait: args.boolean("wait") ?? true,
        timeoutMs: args.integer("timeoutMs", WAIT_TIMEOUT_MS_MAX) ?? WAIT_TIMEOUT_MS_DEFAULT,
      }
      return async (client) => {
        const result = await commands.doAction(client, options)
        return { value: result, failed: result.operation.status === "failed" }
      }
    },
  },
  {
    name: "reflex_wait",
    title: "Wait for a condition",
    description:
      "Wait until the app reaches a condition: a screen in focus, a node's state containing " +
      "a subset, an operation finished, or nothing running. Refused with the state at the " +
      "time if it does not happen in time.",
    properties: {
      focus: { type: "string", description: "The focused node's name must be this" },
      match: { description: "A deep subset the node's state must contain" },
      operationId: { type: "string", description: "This operation must have finished" },
      idle: { type: "boolean", description: "No operation may be running" },
      name: { type: "string", description: "The node `match` applies to, by name" },
      nodeId: NODE_ID_PROPERTY,
      timeoutMs: TIMEOUT_PROPERTY,
    },
    readOnly: true,
    destructive: false,
    prepare: (args) => {
      const { target: _, ...condition } = args.raw()
      const params = paramParsers["app.wait"](condition, "arguments")
      const timeoutMs = params.timeoutMs ?? WAIT_TIMEOUT_MS_DEFAULT
      return async (client) => ({ value: await commands.wait(client, params, timeoutMs) })
    },
  },
  {
    name: "reflex_reset",
    title: "Reset to a scenario",
    description:
      "Rebuild the app from a fixture scenario, the current one by default. Everything the " +
      "session held is discarded. In a live app, reset replaces the running session.",
    properties: { scenario: { type: "string", description: "As reflex_status lists them" } },
    readOnly: false,
    destructive: true,
    prepare: (args) => {
      const scenario = args.string("scenario")
      return async (client) => ({ value: await commands.reset(client, scenario) })
    },
  },
  {
    name: "reflex_sample",
    title: "Generate an input",
    description: "Generate an input that an action's schema accepts, to try it with.",
    properties: {
      action: { type: "string" },
      seed: { type: "integer", minimum: 0, description: "The same seed gives the same input" },
      nodeId: NODE_ID_PROPERTY,
    },
    required: ["action"],
    readOnly: true,
    destructive: false,
    prepare: (args) => {
      const seed = args.integer("seed", Number.MAX_SAFE_INTEGER)
      const options = {
        action: args.requiredString("action"),
        ...(seed === undefined ? {} : { seed }),
        ...nodeIdOf(args),
      }
      return async (client) => ({ value: await commands.sample(client, options) })
    },
  },
  {
    name: "reflex_advance_time",
    title: "Move virtual time",
    description:
      "Move a virtual-time scenario's clock forward, firing whatever comes due: timeouts, " +
      "slow saves. Refused on scenarios that run on real time.",
    properties: {
      durationMs: { type: "integer", minimum: 0, maximum: ADVANCE_TIME_MS_MAX },
    },
    required: ["durationMs"],
    readOnly: false,
    destructive: false,
    prepare: (args) => {
      const durationMs = args.integer("durationMs", ADVANCE_TIME_MS_MAX)
      if (durationMs === undefined) {
        throw new ArgumentError("durationMs is required")
      }
      return async (client) => ({ value: await commands.advance(client, durationMs) })
    },
  },
]

const toolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** Whether a policy leaves a tool anything to do. Hidden tools are refused as unknown. */
const offers = (access: AccessPolicy, tool: Tool): boolean => {
  if (tool.readOnly || access.kind === "control") {
    return true
  }
  return access.kind === "actions" && tool.name === "reflex_dispatch"
}

const describeTool = (access: AccessPolicy) => (tool: Tool) => ({
  name: tool.name,
  title: tool.title,
  description:
    access.kind === "actions" && tool.name === "reflex_dispatch"
      ? `${tool.description} This server may run only: ${access.actions.join(", ")}.`
      : tool.description,
  inputSchema: {
    type: "object",
    properties: { ...tool.properties, target: TARGET_PROPERTY },
    ...(tool.required === undefined ? {} : { required: tool.required }),
    additionalProperties: false,
  },
  annotations: {
    title: tool.title,
    readOnlyHint: tool.readOnly,
    destructiveHint: tool.destructive,
    idempotentHint: tool.readOnly,
    openWorldHint: false,
  },
})

type Id = string | number

export interface McpServerOptions {
  readonly target: Target
  /**
   * What the agent may do through this server. Every call's connection is held to it,
   * and tools it leaves nothing to do are not offered. Full control unless given.
   */
  readonly access?: AccessPolicy
  readonly version: string
  /** A fresh connection to a target's session, as the CLI makes one. */
  readonly connect: (target: Target) => Promise<Client>
  readonly send: (line: string) => void
}

export interface McpServer {
  receive(line: string): void
  /** Settles once every call so far has been answered or cancelled. */
  drained(): Promise<void>
  close(): void
}

export const createMcpServer = (options: McpServerOptions): McpServer => new Server(options)

const reply = (id: Id, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result })

const failure = (id: Id | null, code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: boundedText(message) } })

const isId = (value: unknown): value is Id =>
  (typeof value === "string" && value.length <= ARGUMENT_CHARACTERS_MAX) ||
  (typeof value === "number" && Number.isFinite(value))

class Server implements McpServer {
  private readonly access: AccessPolicy
  private protocolVersion: string = MCP_PROTOCOL_VERSIONS[0] ?? ""
  private readonly calls = new Map<Id, AbortController>()
  private readonly drainWaiters: Array<() => void> = []
  private closed = false

  constructor(private readonly options: McpServerOptions) {
    this.access = accessPolicy(options.access ?? FULL_CONTROL)
  }

  receive(line: string): void {
    if (line.trim() === "") {
      return
    }
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.send(failure(null, ErrorCode.ParseError, "Parse error"))
      return
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      // Replies to requests this server never makes, and anything else, are ignored.
      if (!isRecord(message) || !("result" in message || "error" in message)) {
        this.send(failure(null, ErrorCode.InvalidRequest, "Invalid request"))
      }
      return
    }
    const { id, method, params } = message
    if (id === undefined) {
      this.notified(method, params)
    } else if (isId(id)) {
      this.requested(id, method, params)
    } else {
      this.send(failure(null, ErrorCode.InvalidRequest, "Invalid id"))
    }
  }

  drained(): Promise<void> {
    if (this.calls.size === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  close(): void {
    this.closed = true
    for (const call of this.calls.values()) {
      call.abort()
    }
  }

  private notified(method: string, params: unknown): void {
    if (method === "notifications/cancelled" && isRecord(params) && isId(params.requestId)) {
      this.calls.get(params.requestId)?.abort()
    }
    // `notifications/initialized` and the rest need nothing from this server.
  }

  private requested(id: Id, method: string, params: unknown): void {
    switch (method) {
      case "initialize":
        this.send(reply(id, this.initialize(params)))
        return
      case "ping":
        this.send(reply(id, {}))
        return
      case "tools/list":
        this.send(
          reply(id, {
            tools: TOOLS.filter((tool) => offers(this.access, tool)).map(describeTool(this.access)),
          }),
        )
        return
      case "tools/call":
        this.call(id, params)
        return
      default:
        this.send(failure(id, ErrorCode.MethodNotFound, `Unknown method "${method.slice(0, 64)}"`))
    }
  }

  private initialize(params: unknown) {
    const requested = isRecord(params) ? params.protocolVersion : undefined
    this.protocolVersion =
      typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : (MCP_PROTOCOL_VERSIONS[0] ?? "")
    return {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "reflex", title: "Reflex", version: this.options.version },
      instructions: INSTRUCTIONS,
    }
  }

  private call(id: Id, params: unknown): void {
    if (!isRecord(params) || typeof params.name !== "string") {
      this.send(failure(id, ErrorCode.InvalidParams, "tools/call needs a tool name"))
      return
    }
    const tool = toolsByName.get(params.name)
    if (tool === undefined || !offers(this.access, tool)) {
      this.send(failure(id, ErrorCode.InvalidParams, `Unknown tool "${params.name.slice(0, 64)}"`))
      return
    }
    if (this.calls.has(id)) {
      this.send(failure(id, ErrorCode.InvalidRequest, "A call with this id is still running"))
      return
    }
    if (this.calls.size >= MCP_CALLS_MAX) {
      this.send(failure(id, ErrorCode.ResourceExhausted, "Too many tool calls are running"))
      return
    }
    const cancel = new AbortController()
    this.calls.set(id, cancel)
    this.run(tool, params.arguments, cancel.signal)
      .then((result) => {
        // A cancelled call gets no reply: the client has stopped listening for one.
        if (!cancel.signal.aborted && !this.closed) {
          this.send(reply(id, result))
        }
      })
      .finally(() => {
        this.calls.delete(id)
        if (this.calls.size === 0) {
          for (const resolve of this.drainWaiters.splice(0)) {
            resolve()
          }
        }
      })
      // `run` never rejects, so this is the reply failing to go out: nobody left to tell.
      .catch(reportToConsole)
  }

  /** Never rejects: whatever goes wrong is the model's to read, as a tool error. */
  private async run(tool: Tool, rawArguments: unknown, signal: AbortSignal) {
    let client: Client | null = null
    // Closing the connection ends the session's waits for this call.
    const abandon = () => client?.close()
    signal.addEventListener("abort", abandon, { once: true })
    try {
      const values = rawArguments === undefined ? {} : rawArguments
      if (!isRecord(values)) {
        throw new ArgumentError("arguments must be an object")
      }
      const args = new Arguments(values, [...Object.keys(tool.properties), "target"])
      const target = this.targetOf(args)
      const work = tool.prepare(args)
      client = restrictClient(await this.options.connect(target), this.access)
      if (signal.aborted) {
        client.close()
      }
      const { value, failed } = await work(client)
      return this.result(value, failed === true)
    } catch (error: unknown) {
      return this.result(errorValue(error), true)
    } finally {
      signal.removeEventListener("abort", abandon)
      client?.close()
    }
  }

  private targetOf(args: Arguments): Target {
    const target = args.string("target") ?? this.options.target
    if (target !== "headless" && target !== "device") {
      throw new ArgumentError('target must be "headless" or "device"')
    }
    return target
  }

  private result(value: unknown, isError: boolean) {
    const structured = this.protocolVersion >= STRUCTURED_CONTENT_SINCE && isRecord(value)
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      ...(structured ? { structuredContent: value } : {}),
      isError,
    }
  }

  private send(line: string): void {
    if (!this.closed) {
      this.options.send(line)
    }
  }
}

/** What a model needs to correct itself: the message, and the session's detail if any. */
const errorValue = (error: unknown) => {
  const message = boundedText(error instanceof Error ? error.message : String(error))
  if (error instanceof ProtocolError) {
    return {
      error: {
        code: error.code,
        message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    }
  }
  return { error: { message } }
}
