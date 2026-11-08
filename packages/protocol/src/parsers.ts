/**
 * Everything arriving from a peer starts as `unknown` and is parsed here, once,
 * into the contract types. The rest of the system does not re-check it.
 *
 * Protocol has no dependencies, so that clients in any stack can use it. That
 * rules out a schema library, and these few combinators are all it needs.
 */
import {
  type ActionDescriptor,
  type AmbientAction,
  type DescribeResult,
  type DispatchParams,
  ErrorCode,
  type EventCursor,
  type InspectParams,
  type InspectResult,
  type Json,
  type JsonSchema,
  type Method,
  type Methods,
  type NodeId,
  type NodeSnapshot,
  type NodeType,
  type OperationError,
  type OperationId,
  type OperationInfo,
  ProtocolError,
  type ResetParams,
  type RunningOperation,
  type RuntimeEvent,
  type SampleParams,
  type ScenarioDescriptor,
  type SettledOperation,
  type SubscribeParams,
  type SubscribeResult,
  toNodeId,
  toOperationId,
  type WaitParams,
  type WaitResult,
} from "./contracts.ts"
import { defined, ownValue } from "./invariants.ts"
import {
  ADVANCE_TIME_MS_MAX,
  JSON_DEPTH_MAX,
  WAIT_MATCH_CHARACTERS_MAX,
  WAIT_NAME_CHARACTERS_MAX,
  WAIT_TIMEOUT_MS_MAX,
} from "./limits.ts"

export type Parser<A> = (value: unknown, path: string) => A

type Shape = { readonly [key: string]: Parser<unknown> }
type Parsed<S extends Shape> = { readonly [K in keyof S]: ReturnType<S[K]> }

const invalid = (path: string, expected: string): ProtocolError =>
  new ProtocolError(ErrorCode.InvalidParams, `"${path}" must be ${expected}`)

export const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const string: Parser<string> = (value, path) => {
  if (typeof value !== "string") {
    throw invalid(path, "a string")
  }
  return value
}

export const nonEmptyString: Parser<string> = (value, path) => {
  const text = string(value, path)
  if (text.length === 0) {
    throw invalid(path, "a non-empty string")
  }
  return text
}

export const boolean: Parser<boolean> = (value, path) => {
  if (typeof value !== "boolean") {
    throw invalid(path, "a boolean")
  }
  return value
}

export const integer =
  (range: { readonly minimum: number; readonly maximum: number }): Parser<number> =>
  (value, path) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw invalid(path, "an integer")
    }
    if (value < range.minimum) {
      throw invalid(path, `at least ${range.minimum}`)
    }
    if (value > range.maximum) {
      throw invalid(path, `at most ${range.maximum}`)
    }
    return value
  }

const count = integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })

const literal =
  <const A extends string>(expected: A): Parser<A> =>
  (value, path) => {
    if (value !== expected) {
      throw invalid(path, `"${expected}"`)
    }
    return expected
  }

const exactly =
  <const A extends boolean>(expected: A): Parser<A> =>
  (value, path) => {
    if (value !== expected) {
      throw invalid(path, String(expected))
    }
    return expected
  }

const oneOf =
  <const A extends string>(allowed: ReadonlyArray<A>): Parser<A> =>
  (value, path) => {
    const match = allowed.find((candidate) => candidate === value)
    if (match === undefined) {
      throw invalid(path, `one of ${allowed.join(", ")}`)
    }
    return match
  }

const nullable =
  <A>(parser: Parser<A>): Parser<A | null> =>
  (value, path) => {
    if (value === null) {
      return null
    }
    return parser(value, path)
  }

export const array =
  <A>(item: Parser<A>): Parser<ReadonlyArray<A>> =>
  (value, path) => {
    if (!Array.isArray(value)) {
      throw invalid(path, "an array")
    }
    return value.map((element, index) => item(element, `${path}[${index}]`))
  }

const record =
  <A>(item: Parser<A>): Parser<{ readonly [key: string]: A }> =>
  (value, path) => {
    if (!isRecord(value)) {
      throw invalid(path, "an object")
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, element]) => [key, item(element, `${path}.${key}`)]),
    )
  }

/** Excess keys are refused: a misspelled option must not silently do nothing. */
export const object =
  <R extends Shape, O extends Shape = Record<never, never>>(
    required: R,
    optional?: O,
  ): Parser<Parsed<R> & Partial<Parsed<O>>> =>
  (value, path) => {
    if (!isRecord(value)) {
      throw invalid(path, "an object")
    }
    const allowed: Shape = { ...required, ...optional }
    const result: Record<string, unknown> = {}
    for (const [key, element] of Object.entries(value)) {
      const parser = ownValue(allowed, key)
      if (parser === undefined) {
        throw new ProtocolError(ErrorCode.InvalidParams, `"${path}" has unknown field "${key}"`)
      }
      if (element !== undefined) {
        result[key] = parser(element, `${path}.${key}`)
      }
    }
    for (const key of Object.keys(required)) {
      if (!Object.hasOwn(result, key)) {
        throw invalid(`${path}.${key}`, "present")
      }
    }
    // Every key was just checked against the shape that this type is derived from.
    return result as Parsed<R> & Partial<Parsed<O>>
  }

const discriminated =
  <A>(key: string, cases: { readonly [tag: string]: Parser<A> }): Parser<A> =>
  (value, path) => {
    if (!isRecord(value)) {
      throw invalid(path, "an object")
    }
    const tag = String(value[key])
    const parser = ownValue(cases, tag)
    if (parser === undefined) {
      throw invalid(`${path}.${key}`, `one of ${Object.keys(cases).join(", ")}`)
    }
    return parser(value, path)
  }

/**
 * A work list rather than recursion: this runs on untrusted input, and how deep
 * that input goes is exactly what is being checked.
 */
export const json: Parser<Json> = (value, path) => {
  const pending: Array<{ readonly item: unknown; readonly depth: number }> = [
    { item: value, depth: 1 },
  ]
  while (pending.length > 0) {
    const { item, depth } = defined(pending.pop(), "the loop checks there is one")
    if (depth > JSON_DEPTH_MAX) {
      throw invalid(path, `at most ${JSON_DEPTH_MAX} levels deep`)
    }
    if (isJsonContainer(item)) {
      for (const child of Object.values(item)) {
        pending.push({ item: child, depth: depth + 1 })
      }
    } else if (!isJsonScalar(item)) {
      throw invalid(path, "JSON")
    }
  }
  // Every value in it was just visited and is a JSON scalar or container.
  return value as Json
}

export type JsonMeasure = "fits" | "too-large" | "too-deep" | "not-json"

/**
 * Checks a value can be sent, in one walk that stops at the limit, without rendering it:
 * what the limit is for may be a value too large to render. Every appearance of a shared
 * value counts, so a small graph that renders enormous stops here. The count is a lower
 * bound on the rendered length. A hole in an array is not JSON, though it renders as one.
 */
export const measureJson = (
  root: unknown,
  characterCountMax: number,
  depthMax: number = JSON_DEPTH_MAX,
): JsonMeasure => {
  const pending: Array<{ readonly item: object; readonly depth: number }> = []
  let characterCount = 0
  const visit = (item: unknown, depth: number): JsonMeasure => {
    if (depth > depthMax) {
      return "too-deep"
    }
    if (isJsonContainer(item)) {
      characterCount += 1
      pending.push({ item, depth })
    } else if (!isJsonScalar(item)) {
      return "not-json"
    } else {
      characterCount += typeof item === "string" ? Math.max(item.length, 1) : 1
    }
    return characterCount > characterCountMax ? "too-large" : "fits"
  }
  let measure = visit(root, 1)
  while (measure === "fits") {
    const next = pending.pop()
    if (next === undefined) {
      return "fits"
    }
    const { item, depth } = next
    measure = Array.isArray(item)
      ? visitElements(item, (element) => visit(element, depth + 1))
      : visitProperties(item, (key, value) => {
          characterCount += key.length
          return visit(value, depth + 1)
        })
  }
  return measure
}

/** By index, as a whole array of entries could be far more than the limit allows. */
const visitElements = (
  items: ReadonlyArray<unknown>,
  visit: (item: unknown) => JsonMeasure,
): JsonMeasure => {
  for (let index = 0; index < items.length; index++) {
    const measure = visit(items[index])
    if (measure !== "fits") {
      return measure
    }
  }
  return "fits"
}

const visitProperties = (
  item: object,
  visit: (key: string, value: unknown) => JsonMeasure,
): JsonMeasure => {
  for (const key in item) {
    if (Object.hasOwn(item, key)) {
      const measure = visit(key, Reflect.get(item, key))
      if (measure !== "fits") {
        return measure
      }
    }
  }
  return "fits"
}

const isJsonContainer = (value: unknown): value is object => {
  if (Array.isArray(value)) {
    return true
  }
  if (typeof value !== "object" || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** `1e400` parses to `Infinity`, which would not survive being serialized again. */
const isJsonScalar = (value: unknown): boolean => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true
    case "number":
      return Number.isFinite(value)
    default:
      return value === null
  }
}

export const nodeId: Parser<NodeId> = (value, path) => toNodeId(nonEmptyString(value, path))
const operationId: Parser<OperationId> = (value, path) => toOperationId(nonEmptyString(value, path))
const nodeType: Parser<NodeType> = oneOf(["screen", "navigation", "service", "fixture"])
const jsonSchema: Parser<JsonSchema> = record(json)

const timeoutMs = integer({ minimum: 0, maximum: WAIT_TIMEOUT_MS_MAX })

/** A handle and a name would be two answers to one question. */
const refuseTwoTargets = (value: { readonly nodeId?: unknown; readonly name?: unknown }): void => {
  if (value.nodeId !== undefined && value.name !== undefined) {
    throw new ProtocolError(ErrorCode.InvalidParams, `Pass "nodeId" or "name", not both`)
  }
}

const inspectParams: Parser<InspectParams> = (value, path) => {
  const params = object({}, { nodeId, name: nonEmptyString, tree: boolean })(value, path)
  refuseTwoTargets(params)
  // The check above is the part of the type that a field-by-field parser cannot state.
  return params as InspectParams
}

const waitMatch: Parser<Json> = (value, path) => {
  const match = json(value, path)
  if (JSON.stringify(match).length > WAIT_MATCH_CHARACTERS_MAX) {
    throw invalid(path, `at most ${WAIT_MATCH_CHARACTERS_MAX} characters`)
  }
  return match
}

const waitName: Parser<string> = (value, path) => {
  const name = nonEmptyString(value, path)
  if (name.length > WAIT_NAME_CHARACTERS_MAX) {
    throw invalid(path, `at most ${WAIT_NAME_CHARACTERS_MAX} characters`)
  }
  return name
}

const waitParams: Parser<WaitParams> = (value, path) => {
  const params = object(
    {},
    {
      nodeId,
      name: waitName,
      focus: waitName,
      match: waitMatch,
      operationId,
      idle: boolean,
      timeoutMs,
    },
  )(value, path)
  refuseTwoTargets(params)
  // The check above is the part of the type that a field-by-field parser cannot state.
  return params as WaitParams
}

const dispatchParams: Parser<DispatchParams> = object(
  { action: nonEmptyString },
  { nodeId, input: json, expectedRevision: count, sessionId: nonEmptyString, await: boolean },
)

const eventCursor: Parser<EventCursor> = object({ sessionId: nonEmptyString, sequence: count })

const subscribeParams: Parser<SubscribeParams> = object({}, { since: eventCursor })
const resetParams: Parser<ResetParams> = object({}, { scenario: nonEmptyString })
const sampleParams: Parser<SampleParams> = object(
  { action: nonEmptyString },
  { nodeId, seed: count },
)
const noParams: Parser<Record<string, never>> = (value, path) => {
  object({})(value, path)
  return {}
}
const operationParams = object({ operationId })

/** One parser per method: adding a method without one is a compile error. */
export const paramParsers: { readonly [M in Method]: Parser<Methods[M]["params"]> } = {
  "app.describe": noParams,
  "app.inspect": inspectParams,
  "app.dispatch": dispatchParams,
  "app.operation": operationParams,
  "app.cancel": operationParams,
  "app.wait": waitParams,
  "app.reset": resetParams,
  "app.advanceTime": object({ durationMs: integer({ minimum: 0, maximum: ADVANCE_TIME_MS_MAX }) }),
  "app.sample": sampleParams,
  "app.subscribe": subscribeParams,
  "app.unsubscribe": object({ subscriptionId: nonEmptyString }),
  "session.shutdown": noParams,
}

const actionFields = { description: string }

const actionDescriptor: Parser<ActionDescriptor> = discriminated<ActionDescriptor>("available", {
  true: object({ available: exactly(true), inputSchema: jsonSchema }, actionFields),
  false: object(
    { available: exactly(false), inputSchema: jsonSchema, unavailableReason: string },
    actionFields,
  ),
})

const nodeSnapshot: Parser<NodeSnapshot> = object({
  id: nodeId,
  type: nodeType,
  name: string,
  revision: count,
  state: json,
  actions: record(actionDescriptor),
})

const ambientAction: Parser<AmbientAction> = (value, path) => {
  const {
    nodeId: owner,
    nodeType: ownerType,
    action,
    ...descriptor
  } = object(
    { nodeId, nodeType, action: string },
    { available: boolean, inputSchema: jsonSchema, unavailableReason: string, description: string },
  )(value, path)
  return { ...actionDescriptor(descriptor, path), nodeId: owner, nodeType: ownerType, action }
}

const inspectResult: Parser<InspectResult> = object(
  {
    protocolVersion: string,
    sessionId: string,
    revision: count,
    focus: nullable(nodeId),
    node: nullable(nodeSnapshot),
    ambient: array(ambientAction),
  },
  { tree: array(nodeSnapshot) },
)

const operationError: Parser<OperationError> = object(
  { tag: string, message: string, defect: boolean },
  { data: json },
)

const operationFields = { operationId, nodeId, action: string }

const runningOperation: Parser<RunningOperation> = object({
  ...operationFields,
  status: literal("running"),
})

const settledOperation: Parser<SettledOperation> = discriminated<SettledOperation>("status", {
  completed: object({ ...operationFields, status: literal("completed") }),
  cancelled: object({ ...operationFields, status: literal("cancelled") }),
  failed: object({ ...operationFields, status: literal("failed"), error: operationError }),
})

export const operationInfo: Parser<OperationInfo> = discriminated<OperationInfo>("status", {
  running: runningOperation,
  completed: settledOperation,
  cancelled: settledOperation,
  failed: settledOperation,
})

const waitResult: Parser<WaitResult> = object(
  { revision: count, sequence: count },
  { operation: operationInfo },
)

export const scenarioDescriptor: Parser<ScenarioDescriptor> = object(
  { name: string, virtualTime: boolean },
  { description: string },
)

const describeResult: Parser<DescribeResult> = object({
  protocolVersion: string,
  app: string,
  sessionId: string,
  scenario: string,
  scenarios: array(scenarioDescriptor),
  capabilities: object({ virtualTime: boolean }),
})

const subscribeResult: Parser<SubscribeResult> = object({
  subscriptionId: string,
  sessionId: string,
  sequence: count,
})

const acknowledged = object({ ok: exactly(true) })

/** One parser per method, for clients: a server is a boundary too. */
export const resultParsers: { readonly [M in Method]: Parser<Methods[M]["result"]> } = {
  "app.describe": describeResult,
  "app.inspect": inspectResult,
  "app.dispatch": operationInfo,
  "app.operation": operationInfo,
  "app.cancel": operationInfo,
  "app.wait": waitResult,
  "app.reset": describeResult,
  "app.advanceTime": object({ nowVirtualMs: count }),
  "app.sample": object({ input: json }),
  "app.subscribe": subscribeResult,
  "app.unsubscribe": acknowledged,
  "session.shutdown": acknowledged,
}

const eventBase = { sessionId: string, sequence: count, revision: count }

export const runtimeEvent: Parser<RuntimeEvent> = discriminated<RuntimeEvent>("type", {
  "state.changed": object({
    ...eventBase,
    type: literal("state.changed"),
    nodeId,
    state: json,
  }),
  "node.added": object({ ...eventBase, type: literal("node.added"), nodeId, name: string }),
  "node.removed": object({ ...eventBase, type: literal("node.removed"), nodeId }),
  "focus.changed": object({
    ...eventBase,
    type: literal("focus.changed"),
    nodeId: nullable(nodeId),
  }),
  "operation.started": object({
    ...eventBase,
    type: literal("operation.started"),
    operation: runningOperation,
  }),
  "operation.finished": object({
    ...eventBase,
    type: literal("operation.finished"),
    operation: settledOperation,
  }),
  "resync.required": object({ ...eventBase, type: literal("resync.required") }),
})

const responseId = integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })

export type ServerMessage =
  | { readonly kind: "event"; readonly subscriptionId: string; readonly event: RuntimeEvent }
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | {
      readonly kind: "failure"
      readonly id: number
      readonly code: number
      readonly message: string
      readonly data?: Json
    }

const failureBody = object(
  { code: integer({ minimum: -65_536, maximum: 65_536 }), message: string },
  { data: json },
)

/** The envelope only: `result` needs the parser of the method it answers. */
export const parseServerMessage = (value: unknown): ServerMessage => {
  if (!isRecord(value)) {
    throw invalid("message", "an object")
  }
  if (value.method !== undefined) {
    const { params } = object({
      jsonrpc: literal("2.0"),
      method: literal("app.event"),
      params: object({ subscriptionId: string, event: runtimeEvent }),
    })(value, "message")
    return { kind: "event", ...params }
  }
  if (value.error !== undefined) {
    const { id, error } = object({
      jsonrpc: literal("2.0"),
      id: responseId,
      error: failureBody,
    })(value, "message")
    return { kind: "failure", id, ...error }
  }
  const { id, result } = object({
    jsonrpc: literal("2.0"),
    id: responseId,
    result: (item: unknown) => item,
  })(value, "message")
  return { kind: "result", id, result }
}
