/**
 * What each command does, over a session's client: the CLI prints these, and the MCP
 * server returns them as tool results. One place, so the two cannot drift apart into
 * separate ways of controlling an app.
 */
import {
  type DescribeResult,
  ErrorCode,
  type InspectResult,
  type Json,
  type NodeId,
  type NodeSnapshot,
  type OperationInfo,
  ProtocolError,
  type WaitParams,
  type WaitResult,
} from "@reflex/protocol"
import type { Client } from "@reflex/rpc"

/** Follow-up work usually settles at once; virtual time may never settle at all. */
const SETTLE_TIMEOUT_MS = 1_000
/** Time for a reply to cross the socket, on top of what the server itself waits. */
export const REPLY_MARGIN_MS = 1_000

export type ActionDetail = "summary" | "with-schema"

/** Compact, agent-oriented view: what is here and what can be done. */
export const summarize = (result: InspectResult, detail: ActionDetail) => {
  const { node, ambient } = result
  const own = Object.entries(node?.actions ?? {})
  return {
    name: node?.name ?? null,
    id: node?.id ?? null,
    revision: node?.revision ?? null,
    state: node?.state ?? null,
    actions: [
      ...own.map(([name, descriptor]) => viewAction(name, descriptor, detail)),
      ...ambient.map((entry) => ({
        ...viewAction(entry.action, entry, detail),
        node: entry.nodeId,
      })),
    ],
  }
}

export type Summary = ReturnType<typeof summarize>

const viewAction = (
  name: string,
  descriptor: NodeSnapshot["actions"][string],
  detail: ActionDetail,
) => ({
  name,
  ...(descriptor.available ? {} : { unavailable: descriptor.unavailableReason }),
  ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
  ...(detail === "with-schema" ? { inputSchema: descriptor.inputSchema } : {}),
})

export const status = (client: Client): Promise<DescribeResult> =>
  client.request("app.describe", {})

export const reset = (client: Client, scenario: string | undefined): Promise<DescribeResult> =>
  client.request("app.reset", scenario === undefined ? {} : { scenario })

export const list = async (client: Client, detail: ActionDetail): Promise<Summary> =>
  summarize(await client.request("app.inspect", {}), detail)

/** One node by name or handle, with its schemas: what `ls` shows for the focused one. */
export const inspectNode = async (
  client: Client,
  target: { readonly name: string } | { readonly nodeId: NodeId },
): Promise<Summary> => summarize(await client.request("app.inspect", target), "with-schema")

export const tree = async (client: Client) => {
  const { tree: nodes, focus, revision } = await client.request("app.inspect", { tree: true })
  return { focus, revision, nodes: nodes ?? [] }
}

export interface DoOptions {
  readonly action: string
  readonly input?: Json
  readonly nodeId?: NodeId
  /** Wait for the operation and what it started, rather than return once accepted. */
  readonly wait: boolean
  readonly timeoutMs: number
}

export type DoResult =
  | { readonly operation: OperationInfo; readonly now: Summary }
  | { readonly operation: OperationInfo; readonly settled: boolean; readonly now: Summary }

export const doAction = async (client: Client, options: DoOptions): Promise<DoResult> => {
  const { action, input, nodeId } = options
  const operation = await client.request("app.dispatch", {
    action,
    ...(input === undefined ? {} : { input }),
    ...(nodeId === undefined ? {} : { nodeId }),
  })
  if (!options.wait) {
    return { operation, now: await list(client, "summary") }
  }
  const finished = await awaitOperation(client, operation, options.timeoutMs)
  const settled = await awaitIdle(client)
  return { operation: finished, settled, now: await list(client, "summary") }
}

/** An operation that outlasts this is reported as still running, not as an error. */
const awaitOperation = async (
  client: Client,
  operation: OperationInfo,
  timeoutMs: number,
): Promise<OperationInfo> => {
  const { operationId } = operation
  try {
    const result = await client.request(
      "app.wait",
      { operationId, timeoutMs },
      { timeoutMs: timeoutMs + REPLY_MARGIN_MS },
    )
    return result.operation ?? operation
  } catch (error: unknown) {
    if (isWaitTimeout(error)) {
      return operation
    }
    throw error
  }
}

const awaitIdle = async (client: Client): Promise<boolean> => {
  try {
    await client.request("app.wait", { idle: true, timeoutMs: SETTLE_TIMEOUT_MS })
    return true
  } catch (error: unknown) {
    if (isWaitTimeout(error)) {
      return false
    }
    throw error
  }
}

const isWaitTimeout = (error: unknown): boolean =>
  error instanceof ProtocolError && error.code === ErrorCode.WaitTimeout

export const wait = (client: Client, params: WaitParams, timeoutMs: number): Promise<WaitResult> =>
  client.request("app.wait", { ...params, timeoutMs }, { timeoutMs: timeoutMs + REPLY_MARGIN_MS })

export const sample = (
  client: Client,
  options: { readonly action: string; readonly seed?: number; readonly nodeId?: NodeId },
) => client.request("app.sample", options)

export const advance = (client: Client, durationMs: number) =>
  client.request("app.advanceTime", { durationMs })
