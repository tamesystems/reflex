import { DEFINITION_IDENTITY } from "./definition-identity.ts"
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
import {
  actionOutcome,
  reportActionOutcome,
  decodeActionInput,
  bindActions,
  type ActionOutcome,
  type NodeHandle,
  type DeepReadonly,
} from "./node-handle.ts"
import type { Invocation } from "./operations.ts"
import type { NodeAdapter, Runtime } from "./runtime.ts"

/** Structural subset shared by Zustand, Redux and an application-owned external store. */
export interface Store<S> {
  getState(): S
  subscribe(listener: () => void): () => void
}

/** Standard Schema v1's validation contract; validators need no Reflex dependency. */
export interface StandardValidator<T, I = T> {
  readonly "~standard": {
    readonly types?: { readonly input: I; readonly output: T } | undefined
    readonly version: 1
    readonly vendor: string
    readonly jsonSchema?: { input(options: { readonly target: "draft-2020-12" }): unknown }
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

export interface StoreInput<T, I = T> {
  /** Input before validation/transforms; used only for consumer inference. */
  readonly inputType?: I
  readonly jsonSchema: JsonSchema
  decode(value: unknown): T
}

/** Supply the validator's *input* JSON Schema, including its strictness/refinements. */
export const standardInput = <T, I = unknown>(
  validator: StandardValidator<T, I>,
  jsonSchema?: unknown,
): StoreInput<T, I> => ({
  jsonSchema: schemaFor(validator["~standard"], jsonSchema),
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

const validateStandard = <T>(validator: StandardValidator<T, unknown>, value: unknown): T => {
  const result = validator["~standard"].validate(value)
  if (result instanceof Promise || "then" in result) {
    void Promise.resolve(result).catch(() => undefined)
    throw new Error("Store error validators must be synchronous")
  }
  if (result.issues !== undefined) {
    throw new Error(
      `Store failure does not match its declared error: ${result.issues.map(issueText).join("; ")}`,
    )
  }
  return result.value
}

const schemaFor = (
  standard: StandardValidator<unknown>["~standard"],
  override: unknown,
): JsonSchema => {
  const schema = override ?? standard.jsonSchema?.input({ target: "draft-2020-12" })
  if (schema === undefined) {
    throw new Error(
      `Validator "${standard.vendor}" has no Standard JSON Schema converter; pass an input JSON Schema as standardInput's second argument`,
    )
  }
  return schemaOf(schema)
}

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
    readonly data?: Json,
  ) {
    super(message)
  }
}

const CHECKED_STORE_ACTION = Symbol("reflex/checked-store-action")

export interface StoreAction<S, I = unknown, T extends Store<S> = Store<S>, W = I, E = never> {
  readonly [CHECKED_STORE_ACTION]: true
  readonly input?: StoreInput<I, W>
  readonly error?: StandardValidator<E, unknown>
  readonly description?: string
  readonly available?: (state: S) => true | string
  handler(
    input: NoInfer<I>,
    context: {
      readonly store: T
      readonly signal: AbortSignal
    } & ([E] extends [never] ? unknown : { readonly fail: (error: NoInfer<E>) => never }),
  ): unknown
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

const invoke = (
  handler: (signal: AbortSignal) => unknown,
  validatedFailures: WeakSet<StoreFailure>,
): Invocation => {
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
      (error: unknown) => finish(failedOutcome(error, validatedFailures)),
    )
  } catch (error) {
    finish(failedOutcome(error, validatedFailures))
  }
  return { done, cancel }
}

const failedOutcome = (
  error: unknown,
  validatedFailures: WeakSet<StoreFailure>,
): OperationOutcome => {
  try {
    const limited = error instanceof ProtocolError && error.code === ErrorCode.ResourceExhausted
    return {
      status: "failed",
      error: {
        tag: limited
          ? "ResourceExhausted"
          : error instanceof StoreFailure && validatedFailures.has(error)
            ? boundedText(error.tag)
            : "Defect",
        message: boundedText(error instanceof Error ? error.message : String(error)),
        defect: !limited && !(error instanceof StoreFailure && validatedFailures.has(error)),
        ...(error instanceof StoreFailure &&
        validatedFailures.has(error) &&
        error.data !== undefined
          ? { data: publicState(error.data) }
          : {}),
      },
    }
  } catch {
    return {
      status: "failed",
      error: { tag: "Defect", defect: true, message: "The failure could not be described" },
    }
  }
}

// Heterogeneous definitions erase variance only after the builder checked each action.
type AnyStoreAction<S> = Omit<
  StoreAction<S, unknown, Store<S>, unknown, never>,
  "error" | typeof CHECKED_STORE_ACTION
> & {
  readonly error?: StandardValidator<unknown, unknown>
}
/** Transport values are JSON; rich objects may only appear after decoding. */
type TransportInput<T> = unknown extends T
  ? Json | undefined
  : T extends Date | Map<unknown, unknown> | Set<unknown>
    ? never
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: TransportInput<T[K]> }
      : T extends object
        ? { readonly [K in keyof T]: TransportInput<T[K]> }
        : T extends Json | undefined
          ? T
          : never
type StoreArgs<D> = D extends { readonly input: StoreInput<unknown, infer I> }
  ? [input: TransportInput<I>]
  : D extends { readonly input?: StoreInput<infer I, infer W> }
    ? [I] extends [undefined]
      ? []
      : [input: TransportInput<W>]
    : []

export type StoreActions<A> = {
  readonly [K in keyof A]: (
    ...args: StoreArgs<A[K]>
  ) => Promise<
    ActionOutcome<A[K] extends { readonly error?: StandardValidator<infer E, unknown> } ? E : never>
  >
}
type StoreInputOption = StoreInput<unknown, unknown> | undefined
type StoreErrorOption = StandardValidator<unknown, unknown> | undefined
type DecodedStoreInput<I> = I extends StoreInput<infer D, unknown> ? D : undefined
type EncodedStoreInput<I> = I extends StoreInput<unknown, infer W> ? W : undefined
type StoreErrorOutput<E> = E extends StandardValidator<infer O, unknown> ? O : never
export type StoreActionBuilder<S, T extends Store<S> = Store<S>> = <
  const I extends StoreInputOption = undefined,
  const E extends StoreErrorOption = undefined,
>(action: {
  readonly input?: I
  readonly error?: E
  readonly description?: string
  readonly available?: (state: S) => true | string
  readonly handler: (
    input: NoInfer<DecodedStoreInput<I>>,
    context: {
      readonly store: T
      readonly signal: AbortSignal
    } & (E extends StandardValidator<unknown, infer In>
      ? { fail(error: In): never }
      : Record<never, never>),
  ) => unknown
}) => NoInfer<
  StoreAction<S, DecodedStoreInput<I>, T, EncodedStoreInput<I>, StoreErrorOutput<E>> &
    (I extends StoreInput<unknown, unknown> ? { readonly input: I } : Record<never, never>) &
    (E extends StandardValidator<unknown, unknown> ? { readonly error: E } : Record<never, never>)
>

type CheckedStoreActions<A> = {
  readonly [K in keyof A]: A[K] extends { readonly input: StoreInput<infer I, unknown> }
    ? { readonly handler: (input: I, ...rest: never[]) => unknown }
    : A[K] extends { readonly input?: StoreInput<infer I, unknown> }
      ? { readonly handler: (input: I, ...rest: never[]) => unknown }
      : { readonly handler: (input: undefined, ...rest: never[]) => unknown }
}

/** Capture a store's projection and exact action map once, creating a fresh store per mount. */
export const defineStoreNode = <
  // biome-ignore lint/suspicious/noExplicitAny: factory variance only; handler inputs are checked separately.
  T extends Store<any>,
  P extends Json,
  A extends Record<
    string,
    AnyStoreAction<ReturnType<T["getState"]>> & { readonly [CHECKED_STORE_ACTION]: true }
  >,
  const Name extends string,
  const Params extends StoreInputOption = undefined,
>(definition: {
  readonly name: Name
  readonly type?: NodeType
  readonly params?: Params
  readonly store: (params: NoInfer<DecodedStoreInput<Params>>) => T
  readonly project: (state: ReturnType<T["getState"]>) => P
  readonly actions: (
    action: StoreActionBuilder<ReturnType<T["getState"]>, T>,
  ) => A & CheckedStoreActions<A>
}) => {
  const identity = {}
  const actions = definition.actions(((action: object) => ({
    ...action,
    [CHECKED_STORE_ACTION]: true,
  })) as StoreActionBuilder<ReturnType<T["getState"]>, T>)
  for (const [name, action] of Object.entries(actions)) {
    if (action[CHECKED_STORE_ACTION] !== true) {
      throw new Error(
        `Store "${definition.name}" action "${name}" must be created with the action builder`,
      )
    }
  }
  return {
    [DEFINITION_IDENTITY]: identity,
    "~reflex": {
      decodeParams: (raw: unknown) => definition.params?.decode(raw) ?? {},
      input: (_name: string, args: readonly unknown[]) => args[0] as Json | undefined,
      state: (raw: Json): DeepReadonly<P> => raw as DeepReadonly<P>,
      actions: (
        run: (action: string, input?: Json) => Promise<import("@reflex/protocol").OperationInfo>,
      ): StoreActions<A> =>
        bindActions<StoreActions<A>>(Object.keys(actions), (name, args) =>
          actionOutcome(() => run(name, args[0] as Json | undefined)),
        ),
    },
    params: definition.params as Params,
    name: definition.name,
    type: definition.type ?? "service",
    createStore: (
      ...args: Params extends StoreInput<unknown, unknown>
        ? [params: DecodedStoreInput<Params>]
        : [params?: undefined]
    ) => definition.store(args[0] as DecodedStoreInput<Params>),
    mount(runtime: Runtime, store: T = definition.store(undefined as DecodedStoreInput<Params>)) {
      return mountStore(runtime, {
        identity,
        name: definition.name,
        type: definition.type ?? "service",
        store,
        project: definition.project,
        actions,
      })
    },
    resolve(runtime: Runtime, id?: import("@reflex/protocol").NodeId) {
      const nodeId = id ?? runtime.inspect({ name: definition.name }).node?.id
      const live = nodeId === undefined ? undefined : runtime.liveOf(nodeId)
      return live instanceof StoreNode && live.identity === identity
        ? (live as StoreNode<ReturnType<T["getState"]>, P, A>)
        : undefined
    },
  }
}

export interface StoreDefinition<S, P = unknown, A = Readonly<Record<string, AnyStoreAction<S>>>> {
  readonly identity?: object
  readonly name: string
  readonly type?: NodeType
  readonly store: Store<S>
  readonly project: (state: S) => P
  readonly actions: A
}

/** Register existing behavior; ownership of the store stays with the application. */
export const mountStore = <S, P, A extends Readonly<Record<string, AnyStoreAction<S>>>>(
  runtime: Runtime,
  definition: StoreDefinition<S, P, A>,
) => new StoreNode(runtime, definition)

class StoreNode<S, P, A extends Readonly<Record<string, AnyStoreAction<S>>>>
  implements NodeAdapter, NodeHandle<DeepReadonly<P>, StoreActions<A>>
{
  readonly actions: StoreActions<A>
  readonly identity: object | undefined
  readonly id
  readonly name
  readonly type
  readonly live = this
  private state: Json
  private previous: string
  private readonly running = new Set<Invocation>()
  private readonly listeners = new Set<() => void>()
  private readonly availabilityListeners = new Set<() => void>()
  private disposed = false
  /** Why the store's current state cannot be published, while that lasts. */
  private unpublishable: { readonly error: unknown } | null = null
  private readonly unregister: () => void
  private readonly stop: () => void

  constructor(
    private readonly runtime: Runtime,
    private readonly definition: StoreDefinition<S, P, A>,
  ) {
    this.identity = definition.identity
    this.actions = bindActions<StoreActions<A>>(Object.keys(definition.actions), (name, args) =>
      reportActionOutcome(
        actionOutcome(() => this.dispatchRaw(name, args[0])),
        (error) => runtime.report(error),
      ),
    )
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

  readonly getSnapshot = (): DeepReadonly<P> => this.state as DeepReadonly<P>
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

  dispatchRaw(action: string, input?: unknown) {
    return this.runtime.dispatch({
      nodeId: this.id,
      action,
      ...(input === undefined ? {} : { input: input as Json }),
      await: true,
    })
  }

  subscribeAvailability = (listener: () => void): (() => void) => {
    if (this.availabilityListeners.size >= NODE_LISTENERS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many guard listeners on one node")
    }
    this.availabilityListeners.add(listener)
    return () => {
      this.availabilityListeners.delete(listener)
    }
  }

  availabilityChanged(): void {
    for (const listener of [...this.availabilityListeners]) {
      try {
        listener()
      } catch (error) {
        this.runtime.report(error)
      }
    }
  }

  availability(action: keyof A & string): true | string {
    if (this.disposed || this.runtime.closed) {
      return "The node is disposed"
    }
    if (this.type === "screen" && this.runtime.focus !== this.id) {
      return "The screen is not focused"
    }
    return this.definition.actions[action]?.available?.(this.definition.store.getState()) ?? true
  }

  describeActions() {
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
    const input = decodeActionInput(this.name, name, raw, (value) =>
      decodeInput(action.input, value),
    )
    return () => {
      const validatedFailures = new WeakSet<StoreFailure>()
      const work = invoke(
        (signal) =>
          Promise.resolve(
            action.handler(
              input,
              Object.assign(
                {
                  store: this.definition.store,
                  signal,
                },
                {
                  fail: (error: unknown) => {
                    if (action.error === undefined) {
                      throw new Error(`Action "${name}" has no declared error`)
                    }
                    const data = publicState(validateStandard(action.error, error))
                    const tag =
                      isRecord(data) && typeof data._tag === "string" ? data._tag : "Failure"
                    const message =
                      isRecord(data) && typeof data.message === "string" ? data.message : tag
                    const failure = new StoreFailure(tag, message, data)
                    validatedFailures.add(failure)
                    throw failure
                  },
                },
              ),
            ),
          ).then(() => {
            if (this.unpublishable !== null) {
              throw this.unpublishable.error
            }
          }),
        validatedFailures,
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
    this.availabilityChanged()
    this.availabilityListeners.clear()
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
      this.availabilityChanged()
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
    this.availabilityChanged()
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
