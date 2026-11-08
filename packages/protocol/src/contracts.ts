/**
 * The application control protocol: plain JSON contracts, no runtime
 * dependencies. Clients need only these shapes, never Effect.
 *
 * Carried as JSON-RPC 2.0; see `@reflex/rpc` for the transports.
 */

import type { AccessPolicy } from "./access.ts"

export const PROTOCOL_VERSION = "0.2"

/** Sent by the server for each event on a subscription. */
export const EVENT_NOTIFICATION = "app.event"

/**
 * Sent by a client that no longer wants the answer to request `id`. The server stops
 * waiting on its behalf, as it does for every request of a peer that disconnects; work
 * already started is not undone. A notification, so it has no reply.
 */
export const CANCEL_NOTIFICATION = "$/cancelRequest"

export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json }

export type JsonSchema = { readonly [key: string]: Json }

declare const nodeIdBrand: unique symbol
declare const operationIdBrand: unique symbol

/** Handles look alike on the wire, and mixing them up fails only at runtime. */
export type NodeId = string & { readonly [nodeIdBrand]: true }
export type OperationId = string & { readonly [operationIdBrand]: true }

export const toNodeId = (value: string): NodeId => value as NodeId
export const toOperationId = (value: string): OperationId => value as OperationId

/**
 * `screen` nodes are only actionable while focused. Everything else is
 * ambient: its actions stay reachable from any screen.
 */
export type NodeType = "screen" | "navigation" | "service" | "fixture"

export type ActionDescriptor = {
  readonly description?: string
  readonly inputSchema: JsonSchema
} & (
  | { readonly available: true }
  | { readonly available: false; readonly unavailableReason: string }
)

export interface NodeSnapshot {
  readonly id: NodeId
  readonly type: NodeType
  readonly name: string
  /** Session revision at which this node last changed. */
  readonly revision: number
  readonly state: Json
  readonly actions: { readonly [name: string]: ActionDescriptor }
}

export type AmbientAction = ActionDescriptor & {
  readonly nodeId: NodeId
  readonly nodeType: NodeType
  readonly action: string
}

/** A node is named by handle or by name, never both. Neither means the focus. */
export type NodeTarget =
  | { readonly nodeId?: never; readonly name?: never }
  | { readonly nodeId: NodeId; readonly name?: never }
  | { readonly name: string; readonly nodeId?: never }

export type InspectParams = NodeTarget & {
  /** Include every registered node. */
  readonly tree?: boolean
}

export interface InspectResult {
  readonly protocolVersion: string
  readonly sessionId: string
  readonly revision: number
  readonly focus: NodeId | null
  readonly node: NodeSnapshot | null
  /** Actions reachable from here that belong to non-screen nodes. */
  readonly ambient: ReadonlyArray<AmbientAction>
  readonly tree?: ReadonlyArray<NodeSnapshot>
}

export interface DispatchParams {
  /** Defaults to the focused node, then to ambient nodes. */
  readonly nodeId?: NodeId
  readonly action: string
  readonly input?: Json
  /** Reject if the target node has changed since this revision. */
  readonly expectedRevision?: number
  /** Reject if this observation came from a session that has since been reset. */
  readonly sessionId?: string
  /**
   * `false` (default) returns once the action is accepted. `true` returns once
   * its effect has finished. Acceptance says nothing about business success.
   */
  readonly await?: boolean
}

export interface OperationError {
  readonly tag: string
  readonly message: string
  /** True for unexpected defects, false for declared failures. */
  readonly defect: boolean
  readonly data?: Json
}

export type OperationOutcome =
  | { readonly status: "completed" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: OperationError }

export interface OperationTarget {
  readonly operationId: OperationId
  readonly nodeId: NodeId
  readonly action: string
}

export type RunningOperation = OperationTarget & { readonly status: "running" }
export type SettledOperation = OperationTarget & OperationOutcome
export type OperationInfo = RunningOperation | SettledOperation

export type OperationStatus = OperationInfo["status"]

/** Wait names and focus are limited to `WAIT_NAME_CHARACTERS_MAX` characters. */
export type WaitParams = NodeTarget & {
  /** Focused node's name must equal this. */
  readonly focus?: string
  /** Deep subset the target node's state must contain. */
  readonly match?: Json
  /** Operation must have finished. */
  readonly operationId?: OperationId
  /** No operation may be running. */
  readonly idle?: boolean
  readonly timeoutMs?: number
}

export interface WaitResult {
  readonly revision: number
  readonly sequence: number
  readonly operation?: OperationInfo
}

export interface ScenarioDescriptor {
  readonly name: string
  readonly description?: string
  readonly virtualTime: boolean
}

export interface DescribeResult {
  readonly protocolVersion: string
  readonly app: string
  readonly sessionId: string
  readonly scenario: string
  readonly scenarios: ReadonlyArray<ScenarioDescriptor>
  readonly capabilities: {
    readonly virtualTime: boolean
  }
  /** What this connection may do, when it is less than full control. */
  readonly access?: AccessPolicy
}

export interface ResetParams {
  /** Defaults to the current scenario. */
  readonly scenario?: string
}

/** Where a client left off. A sequence means nothing outside its session. */
export interface EventCursor {
  readonly sessionId: string
  readonly sequence: number
}

export interface SubscribeParams {
  /** Replay retained events after this point. */
  readonly since?: EventCursor
}

export interface SubscribeResult {
  readonly subscriptionId: string
  readonly sessionId: string
  readonly sequence: number
}

export interface SampleParams {
  readonly nodeId?: NodeId
  readonly action: string
  readonly seed?: number
}

export interface EventBase {
  readonly sessionId: string
  readonly sequence: number
  readonly revision: number
}

export type RuntimeEvent = EventBase &
  (
    | { readonly type: "state.changed"; readonly nodeId: NodeId; readonly state: Json }
    | { readonly type: "node.added"; readonly nodeId: NodeId; readonly name: string }
    | { readonly type: "node.removed"; readonly nodeId: NodeId }
    | { readonly type: "focus.changed"; readonly nodeId: NodeId | null }
    | { readonly type: "operation.started"; readonly operation: RunningOperation }
    | { readonly type: "operation.finished"; readonly operation: SettledOperation }
    /** Events were lost: discard local state and call `app.inspect`. */
    | { readonly type: "resync.required" }
  )

type Empty = Record<string, never>

export interface Methods {
  readonly "app.describe": { readonly params: Empty; readonly result: DescribeResult }
  readonly "app.inspect": { readonly params: InspectParams; readonly result: InspectResult }
  readonly "app.dispatch": { readonly params: DispatchParams; readonly result: OperationInfo }
  readonly "app.operation": {
    readonly params: { readonly operationId: OperationId }
    readonly result: OperationInfo
  }
  readonly "app.cancel": {
    readonly params: { readonly operationId: OperationId }
    readonly result: OperationInfo
  }
  readonly "app.wait": { readonly params: WaitParams; readonly result: WaitResult }
  readonly "app.reset": { readonly params: ResetParams; readonly result: DescribeResult }
  readonly "app.advanceTime": {
    readonly params: { readonly durationMs: number }
    /** Virtual time since the session began, which is not a Unix timestamp. */
    readonly result: { readonly nowVirtualMs: number }
  }
  readonly "app.sample": {
    readonly params: SampleParams
    readonly result: { readonly input: Json }
  }
  readonly "app.subscribe": { readonly params: SubscribeParams; readonly result: SubscribeResult }
  readonly "app.unsubscribe": {
    readonly params: { readonly subscriptionId: string }
    readonly result: { readonly ok: true }
  }
  /** Offered only to the session's owner, on its private socket. */
  readonly "session.shutdown": { readonly params: Empty; readonly result: { readonly ok: true } }
}

export type Method = keyof Methods

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  NodeNotFound: -32001,
  ActionNotFound: -32002,
  InvalidInput: -32003,
  ActionUnavailable: -32004,
  StaleRevision: -32005,
  WaitTimeout: -32006,
  AmbiguousAction: -32007,
  OperationNotFound: -32008,
  Unsupported: -32009,
  ScenarioNotFound: -32010,
  SessionClosed: -32011,
  StaleSession: -32012,
  ResourceExhausted: -32013,
  AmbiguousName: -32014,
  /** The connection's access policy does not allow this request. */
  NotPermitted: -32015,
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export class ProtocolError extends Error {
  override readonly name = "ProtocolError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: Json,
  ) {
    super(message)
  }
}
