import {
  boundedText,
  ErrorCode,
  type Json,
  type JsonSchema,
  json,
  isRecord,
  measureJson,
  NODE_LISTENERS_MAX,
  NODE_STATE_CHARACTERS_MAX,
  NODE_STATE_DEPTH_MAX,
  type NodeType,
  type OperationOutcome,
  ProtocolError,
} from "@reflex/protocol"
import type { Invocation } from "./operations.ts"
import type { NodeAdapter, Runtime } from "./runtime.ts"

/** Structural subset shared by Zustand, Redux and an application-owned external store. */
export interface Store<S> {
  getState(): S
  subscribe(listener: () => void): () => void
}

/** Standard Schema v1's validation contract; validators need no Reflex dependency. */
export interface StandardValidator<T> {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    validate(
      value: unknown,
    ):
      | { readonly value: T; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<StandardIssue> }
      | Promise<
          | { readonly value: T; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<StandardIssue> }
        >
  }
}

interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

/** Enough for a client to correct itself. Bounded, because a peer chose the input. */
const INPUT_ISSUES_SHOWN_MAX = 5

const issueText = ({ message, path }: StandardIssue): string => {
  const keys = (path ?? []).map((part) =>
    String(typeof part === "object" && part !== null ? part.key : part),
  )
  return keys.length === 0 ? message : `${keys.join(".")}: ${message}`
}

export interface StoreInput<T> {
  readonly jsonSchema: JsonSchema
  decode(value: unknown): T
}

/** Supply the validator's *input* JSON Schema, including its strictness/refinements. */
export const standardInput = <T>(
  validator: StandardValidator<T>,
  jsonSchema: unknown,
): StoreInput<T> => ({
  jsonSchema: schemaOf(jsonSchema),
  decode(value) {
    const result = validator["~standard"].validate(value)
    if (
      result instanceof Promise ||
      (typeof result === "object" && result !== null && "then" in result)
    ) {
      void Promise.resolve(result).catch(() => undefined)
      throw new ProtocolError(
        ErrorCode.InvalidInput,
        "Async Standard Schema validators are unsupported: prepare must be synchronous",
      )
    }
    if (result.issues !== undefined) {
      const shown = result.issues.slice(0, INPUT_ISSUES_SHOWN_MAX).map(issueText).join("; ")
      throw new ProtocolError(ErrorCode.InvalidInput, boundedText(`Invalid input: ${shown}`))
    }
    return result.value
  },
})

const schemaOf = (schema: unknown): JsonSchema => {
  if (!isRecord(schema)) {
    throw new Error("Input JSON Schema must be an object")
  }
  return json(schema, "input JSON Schema") as JsonSchema
}

/** Explicit expected failure. Messages are public; never put secrets in them. */
export class StoreFailure extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message)
  }
}

export interface StoreAction<S, I = unknown> {
  readonly input?: StoreInput<I>
  readonly description?: string
  readonly available?: (state: S) => true | string
  handler(input: I, context: { readonly store: Store<S>; readonly signal: AbortSignal }): unknown
}

/** Validate, detach and freeze the public projection before retaining or publishing it. */
const publicState = (value: unknown): Json => {
  // Reject accessors before reading them: JSON.stringify must not run application code.
  let budget = NODE_STATE_CHARACTERS_MAX
  const copy = (item: unknown, depth: number): unknown => {
    if (depth > NODE_STATE_DEPTH_MAX || --budget < 0) {
      throw new ProtocolError(
        ErrorCode.ResourceExhausted,
        "State cannot be sent: too-deep or too-large",
      )
    }
    if (item === null || typeof item !== "object") {
      return item
    }
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new Error("Public state must contain only plain JSON objects")
    }
    const result: Record<string, unknown> | unknown[] = Array.isArray(item)
      ? []
      : Object.create(null)
    for (const key of Object.keys(item)) {
      if (Array.isArray(item) && (String(Number(key)) !== key || Number(key) >= item.length)) {
        throw new Error("Public arrays cannot contain named properties")
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("Public state cannot contain accessors")
      }
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    // Preserve holes so measureJson rejects them rather than silently dropping them.
    if (Array.isArray(item) && Array.isArray(result)) {
      result.length = item.length
    }
    return result
  }
  value = copy(value, 1)
  const measure = measureJson(value, NODE_STATE_CHARACTERS_MAX, NODE_STATE_DEPTH_MAX)
  if (measure !== "fits") {
    throw new ProtocolError(ErrorCode.ResourceExhausted, `State cannot be sent: ${measure}`)
  }
  const text = JSON.stringify(value)
  if (text.length > NODE_STATE_CHARACTERS_MAX) {
    throw new ProtocolError(ErrorCode.ResourceExhausted, "State cannot be sent: too-large")
  }
  const freeze = (item: Json): Json => {
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) {
        freeze(child)
      }
      Object.freeze(item)
    }
    return item
  }
  return freeze(JSON.parse(text) as Json)
}

const invoke = (handler: (signal: AbortSignal) => unknown): Invocation => {
  const controller = new AbortController()
  let finish!: (outcome: OperationOutcome) => void
  const done = new Promise<OperationOutcome>((resolve) => {
    finish = resolve
  })
  const cancel = () => {
    controller.abort()
    finish({ status: "cancelled" })
  }
  try {
    Promise.resolve(handler(controller.signal)).then(
      () => finish({ status: "completed" }),
      (error: unknown) => finish(failedOutcome(error)),
    )
  } catch (error) {
    finish(failedOutcome(error))
  }
  return { done, cancel }
}

const failedOutcome = (error: unknown): OperationOutcome => {
  const limited = error instanceof ProtocolError && error.code === ErrorCode.ResourceExhausted
  return {
    status: "failed",
    error: {
      tag: limited
        ? "ResourceExhausted"
        : error instanceof StoreFailure
          ? boundedText(error.tag)
          : "Defect",
      message: boundedText(error instanceof Error ? error.message : String(error)),
      defect: !limited && !(error instanceof StoreFailure),
    },
  }
}

export interface StoreDefinition<S> {
  readonly name: string
  readonly type?: NodeType
  readonly store: Store<S>
  readonly project: (state: S) => unknown
  readonly actions: Readonly<Record<string, StoreAction<S>>>
}

/** Register existing behavior; ownership of the store stays with the application. */
export const mountStore = <S>(runtime: Runtime, definition: StoreDefinition<S>) =>
  new StoreNode(runtime, definition)

class StoreNode<S> implements NodeAdapter {
  readonly id
  readonly name
  readonly type
  readonly live = this
  private state: Json
  private previous: string
  private readonly running = new Set<Invocation>()
  private readonly listeners = new Set<() => void>()
  private disposed = false
  /** Why the store's current state cannot be published, while that lasts. */
  private unpublishable: { readonly error: unknown } | null = null
  private readonly unregister: () => void
  private readonly stop: () => void

  constructor(
    private readonly runtime: Runtime,
    private readonly definition: StoreDefinition<S>,
  ) {
    this.name = definition.name
    this.type = definition.type ?? "service"
    this.id = runtime.nextId(this.type, this.name)
    this.state = publicState(definition.project(definition.store.getState()))
    this.previous = JSON.stringify(this.state)
    this.unregister = runtime.register(this)
    try {
      this.stop = definition.store.subscribe(() => this.refresh())
    } catch (error) {
      this.unregister()
      throw error
    }
  }

  readonly getSnapshot = (): Json => this.state
  snapshot(): Json {
    return this.state
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size >= NODE_LISTENERS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many node listeners")
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  send(action: string, input?: unknown) {
    return this.runtime.dispatch({
      nodeId: this.id,
      action,
      ...(input === undefined ? {} : { input: input as Json }),
      await: true,
    })
  }

  actions() {
    return Object.fromEntries(
      Object.entries(this.definition.actions).map(([name, action]) => {
        const verdict = action.available?.(this.definition.store.getState()) ?? true
        return [
          name,
          {
            inputSchema: action.input?.jsonSchema ?? {
              type: "object",
              additionalProperties: false,
            },
            ...(action.description === undefined ? {} : { description: action.description }),
            ...(verdict === true
              ? { available: true as const }
              : { available: false as const, unavailableReason: verdict }),
          },
        ]
      }),
    )
  }

  prepare(name: string, raw: unknown): () => Invocation {
    const action = this.definition.actions[name]
    if (action === undefined) {
      throw new ProtocolError(ErrorCode.ActionNotFound, "Unknown action")
    }
    const input = decodeInput(action.input, raw)
    return () => {
      const work = invoke((signal) =>
        Promise.resolve(action.handler(input, { store: this.definition.store, signal })).then(
          () => {
            if (this.unpublishable !== null) {
              throw this.unpublishable.error
            }
          },
        ),
      )
      this.running.add(work)
      void work.done.then(() => this.running.delete(work))
      return work
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.unregister()
    this.stop()
    for (const work of this.running) {
      work.cancel()
    }
    this.listeners.clear()
  }

  /**
   * Runs inside the application's own store write, so it must not throw: that would fail a
   * write that has nothing to do with Reflex and skip the store's other subscribers, such
   * as its UI. State that cannot be published is reported, once until it recovers, and the
   * last valid snapshot stands. An operation that finishes meanwhile fails instead.
   */
  private refresh(): void {
    if (this.disposed) {
      return
    }
    let next: Json
    try {
      next = publicState(this.definition.project(this.definition.store.getState()))
    } catch (error) {
      if (this.unpublishable === null) {
        this.runtime.report(error)
      }
      this.unpublishable = { error }
      return
    }
    this.unpublishable = null
    const encoded = JSON.stringify(next)
    if (encoded === this.previous) {
      return
    }
    this.state = next
    this.previous = encoded
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.runtime.report(error)
      }
    }
  }
}

const decodeInput = (input: StoreInput<unknown> | undefined, raw: unknown): unknown => {
  if (input !== undefined) {
    return input.decode(raw)
  }
  if (
    raw !== undefined &&
    raw !== null &&
    (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 0)
  ) {
    throw new ProtocolError(ErrorCode.InvalidInput, "This action takes no input")
  }
  return undefined
}
