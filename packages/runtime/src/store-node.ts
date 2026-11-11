import { publishJson } from "./publication.ts"
import { DEFINITION_IDENTITY } from "./definition-identity.ts"
import {
  boundedText,
  ErrorCode,
  type Json,
  type JsonSchema,
  json,
  isRecord,
  NODE_LISTENERS_MAX,
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
): StoreInput<T, I> & StandardValidator<T, I> => ({
  "~standard": validator["~standard"],
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
class DeclaredStoreError extends Error {
  constructor(
    readonly tag: string,
    message: string,
    readonly data?: Json,
  ) {
    super(message)
  }
}

const STORE_ACTION_ERROR = Symbol("reflex/store-action-error")
const CHECKED_STORE_ACTION = Symbol("reflex/checked-store-action")

export interface StoreAction<
  S,
  I = unknown,
  T extends Store<S> = Store<S>,
  W = I,
  E = never,
  Published = E,
> {
  readonly [STORE_ACTION_ERROR]?: Published
  readonly [CHECKED_STORE_ACTION]: true
  readonly input?: StoreInput<I, W>
  readonly error?: StandardValidator<E, unknown>
  projectError?(error: E): unknown
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

const invoke = (
  handler: (signal: AbortSignal) => unknown,
  validatedFailures: WeakSet<DeclaredStoreError>,
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

/** Revoke handler access before abort callbacks or late Promise continuations run. */
const guardedStore = <T extends object>(store: T, active: () => boolean): T => {
  const methods = new WeakMap<(...args: never[]) => unknown, (...args: unknown[]) => unknown>()
  const check = () => {
    if (!active()) {
      throw new ProtocolError(ErrorCode.SessionClosed, "The store handler is no longer active")
    }
  }
  // A facade also supports frozen stores: replacing a frozen target's method in a
  // proxy get trap would violate Proxy invariants. Bind methods to the original
  // receiver so class-based stores retain access to private fields.
  return new Proxy(Object.create(Object.getPrototypeOf(store)) as T, {
    get(_, key) {
      check()
      const value: unknown = Reflect.get(store, key, store)
      if (typeof value !== "function") {
        return value
      }
      const method = value as (...args: never[]) => unknown
      let guarded = methods.get(method)
      if (guarded === undefined) {
        guarded = (...args) => {
          check()
          return Reflect.apply(method, store, args)
        }
        methods.set(method, guarded)
      }
      return guarded
    },
    set(_, key, value) {
      check()
      return Reflect.set(store, key, value, store)
    },
    defineProperty(_, key, descriptor) {
      check()
      return Reflect.defineProperty(store, key, descriptor)
    },
    deleteProperty(_, key) {
      check()
      return Reflect.deleteProperty(store, key)
    },
    has: (_, key) => Reflect.has(store, key),
    ownKeys: () => Reflect.ownKeys(store),
    getOwnPropertyDescriptor(_, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(store, key)
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
  })
}

const failedOutcome = (
  error: unknown,
  validatedFailures: WeakSet<DeclaredStoreError>,
): OperationOutcome => {
  try {
    const limited = error instanceof ProtocolError && error.code === ErrorCode.ResourceExhausted
    return {
      status: "failed",
      error: {
        tag: limited
          ? "ResourceExhausted"
          : error instanceof DeclaredStoreError && validatedFailures.has(error)
            ? boundedText(error.tag)
            : "Defect",
        message: boundedText(error instanceof Error ? error.message : String(error)),
        defect: !limited && !(error instanceof DeclaredStoreError && validatedFailures.has(error)),
        ...(error instanceof DeclaredStoreError &&
        validatedFailures.has(error) &&
        error.data !== undefined
          ? { data: publishJson(error.data) }
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
  "error" | typeof CHECKED_STORE_ACTION | typeof STORE_ACTION_ERROR
> & {
  readonly error?: StandardValidator<unknown, unknown>
  projectError?(error: unknown): unknown
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
  ) => Promise<ActionOutcome<A[K] extends { readonly [STORE_ACTION_ERROR]?: infer E } ? E : never>>
}
type StoreInputOption =
  | StoreInput<unknown, unknown>
  | StandardValidator<unknown, unknown>
  | undefined
type StoreErrorOption = StandardValidator<unknown, unknown> | undefined
type DecodedStoreInput<I> =
  I extends StoreInput<infer D, unknown>
    ? D
    : I extends StandardValidator<infer D, unknown>
      ? D
      : undefined
type EncodedStoreInput<I> =
  I extends StoreInput<unknown, infer W>
    ? W
    : I extends StandardValidator<unknown, infer W>
      ? W
      : undefined
type StoreErrorOutput<E> = E extends StandardValidator<infer O, unknown> ? O : never
export type JsonShape<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends string | number | boolean | null
    ? T
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: JsonShape<T[K]> }
      : T extends object
        ? { readonly [K in keyof T]: JsonShape<T[K]> }
        : never
type JsonCheck<T, Message extends string> = [T] extends [undefined]
  ? unknown
  : [T] extends [Json]
    ? unknown
    : [T] extends [JsonShape<T>]
      ? unknown
      : { readonly [K in Message]: never }

export const STORE_AUTHOR = Symbol("reflex/store-author")
export const STORE_OVERRIDE = Symbol("reflex/store-override")

const asInput = <T, I>(input: StoreInput<T, I> | StandardValidator<T, I>): StoreInput<T, I> =>
  "jsonSchema" in input ? input : standardInput(input)

type StoreActionSpec<S, T, I, E, F, O> = {
  readonly input?: I
  readonly error?: E
  readonly description?: string
  readonly available?: (state: S) => true | string
  readonly handler: (
    input: NoInfer<DecodedStoreInput<I>>,
    context: { readonly store: T; readonly signal: AbortSignal } & (E extends undefined
      ? Record<never, never>
      : { fail(error: F): never }),
  ) => O
} & ([Extract<Awaited<O>, { readonly kind: "navigation" }>] extends [never]
  ? unknown
  : { readonly "Store handlers cannot return NavigationCommand": never }) &
  JsonCheck<
    I extends StoreInput<unknown, unknown> ? Json : EncodedStoreInput<I>,
    "Input must encode JSON; use jsonCodec"
  >
type BuiltStoreAction<S, T extends Store<S>, I, E, W> = NoInfer<
  StoreAction<S, DecodedStoreInput<I>, T, EncodedStoreInput<I>, StoreErrorOutput<E>, W> &
    (I extends Exclude<StoreInputOption, undefined>
      ? { readonly input: StoreInput<DecodedStoreInput<I>, EncodedStoreInput<I>> }
      : Record<never, never>) &
    (E extends StandardValidator<unknown, unknown> ? { readonly error: E } : Record<never, never>)
>
export interface StoreActionBuilder<S, T extends Store<S> = Store<S>> {
  <
    const I extends StoreInputOption = undefined,
    const E extends StoreErrorOption = undefined,
    W extends Json = Json,
    O = void,
  >(
    action: StoreActionSpec<S, T, I, E, StoreErrorOutput<NoInfer<E>>, O> & {
      readonly projectError: (error: StoreErrorOutput<NoInfer<E>>) => W
    },
  ): BuiltStoreAction<S, T, I, E, W>
  <
    const I extends StoreInputOption = undefined,
    const E extends StoreErrorOption = undefined,
    O = void,
  >(
    action: StoreActionSpec<S, T, I, E, StoreErrorOutput<NoInfer<E>>, O> & {
      readonly projectError?: never
    } & (E extends StandardValidator<infer Out, unknown>
        ? JsonCheck<Out, "Store error must be JSON; provide projectError">
        : unknown),
  ): BuiltStoreAction<S, T, I, E, StoreErrorOutput<E>>
}

const checkInitialState = <S>(
  name: string,
  store: Store<S>,
  project: (state: S) => unknown,
  explicit: boolean,
): void => {
  try {
    publishJson(project(store.getState()))
  } catch (error) {
    if (!explicit) {
      throw new Error(`Store ${name} state must be JSON; provide project`, { cause: error })
    }
    throw error
  }
}

const hasStoreParams = (params: { readonly jsonSchema: JsonSchema } | undefined) =>
  params !== undefined &&
  (params.jsonSchema.type !== "object" ||
    Object.keys(params.jsonSchema.properties ?? {}).length > 0)
const storeParamsSchema = (params: { readonly jsonSchema: JsonSchema } | undefined): JsonSchema =>
  params?.jsonSchema ?? { type: "object", properties: {}, required: [] }
const actionDescriptors = <S>(actions: Readonly<Record<string, AnyStoreAction<S>>>) =>
  Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      {
        input: action.input?.jsonSchema ?? {},
        error:
          action.error === undefined
            ? {}
            : action.projectError === undefined
              ? standardInput(action.error).jsonSchema
              : { projected: true },
      },
    ]),
  )

/** Capture a store's projection and exact action map once, creating a fresh store per mount. */
export const defineStoreNode = <
  // biome-ignore lint/suspicious/noExplicitAny: factory variance only; handler inputs are checked separately.
  T extends Store<any>,
  A extends Record<
    string,
    AnyStoreAction<ReturnType<T["getState"]>> & { readonly [CHECKED_STORE_ACTION]: true }
  >,
  const Name extends string,
  const Params extends StoreInputOption = undefined,
  P = ReturnType<T["getState"]>,
>(definition: {
  readonly name: Name
  readonly type?: NodeType
  readonly params?: Params
  readonly store: (params: NoInfer<DecodedStoreInput<Params>>) => T
  readonly project?: (state: ReturnType<T["getState"]>) => P & Json
  readonly actions: (action: StoreActionBuilder<ReturnType<T["getState"]>, T>) => A
}) => {
  const identity = {}
  const project = definition.project ?? ((state: ReturnType<T["getState"]>) => state as P)
  const params = definition.params === undefined ? undefined : asInput(definition.params)
  const actions = definition.actions(((action: object) => ({
    ...action,
    ...("input" in action && action.input !== undefined
      ? { input: asInput(action.input as Exclude<StoreInputOption, undefined>) }
      : {}),
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
    [STORE_AUTHOR]: {
      hasParams: hasStoreParams(params),
      state: undefined as P,
      params: undefined as DecodedStoreInput<Params>,
      encodedParams: undefined as EncodedStoreInput<Params>,
    },
    withStore<D>(
      this: D,
      factory: (
        params: Params extends undefined ? Record<never, never> : DecodedStoreInput<Params>,
      ) => T,
    ) {
      return { [STORE_OVERRIDE]: true as const, definition: this, factory }
    },
    [DEFINITION_IDENTITY]: identity,
    "~reflex": {
      descriptor: () => ({ params: params?.jsonSchema ?? {}, actions: actionDescriptors(actions) }),
      paramsSchema: () => storeParamsSchema(params),
      decodeParams: (raw: unknown) => params?.decode(raw) ?? {},
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
      ...args: Params extends Exclude<StoreInputOption, undefined>
        ? [params: DecodedStoreInput<Params>]
        : [params?: undefined]
    ) => definition.store(args[0] as DecodedStoreInput<Params>),
    mount(
      runtime: Runtime,
      store: T = definition.store(
        (params === undefined ? undefined : params.decode({})) as DecodedStoreInput<Params>,
      ),
      type = definition.type ?? "service",
    ) {
      checkInitialState(definition.name, store, project, definition.project !== undefined)
      return new StoreNode(runtime, {
        identity,
        name: definition.name,
        type,
        store,
        project,
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

interface StoreDefinition<S, P = unknown, A = Readonly<Record<string, AnyStoreAction<S>>>> {
  readonly identity?: object
  readonly name: string
  readonly type?: NodeType
  readonly store: Store<S>
  readonly project: (state: S) => P
  readonly actions: A
}

/** Register existing behavior; ownership of the store stays with the application. */
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
        `${definition.name}.${name}`,
      ),
    )
    this.name = definition.name
    this.type = definition.type ?? "service"
    this.id = runtime.nextId(this.type, this.name)
    this.state = publishJson(definition.project(definition.store.getState()))
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
    const declaredError = action.error
    return () => {
      const validatedFailures = new WeakSet<DeclaredStoreError>()
      const work = invoke(
        (signal) =>
          Promise.resolve(
            action.handler(
              input,
              Object.assign(
                {
                  store: guardedStore(
                    this.definition.store,
                    () => !this.disposed && !this.runtime.closed && !signal.aborted,
                  ),
                  signal,
                },
                declaredError === undefined
                  ? {}
                  : {
                      fail: (error: unknown) => {
                        const projected =
                          action.projectError === undefined ? error : action.projectError(error)
                        let validated: unknown
                        try {
                          validated = validateStandard(declaredError, error)
                        } catch (invalid) {
                          if (action.projectError === undefined) {
                            throw invalid
                          }
                          validated = validateStandard(declaredError, projected)
                        }
                        if (action.projectError === undefined) {
                          // Validators may reorder object keys without changing the JSON value.
                          const canonical = (value: unknown) =>
                            JSON.stringify(publishJson(value), (_, item) =>
                              isRecord(item)
                                ? Object.fromEntries(
                                    Object.keys(item)
                                      .sort()
                                      .map((key) => [key, item[key]]),
                                  )
                                : item,
                            )
                          if (canonical(validated) !== canonical(error)) {
                            throw new Error(
                              "Transformed store errors require projectError: validation changed the value passed to fail",
                            )
                          }
                        }
                        const data = publishJson(
                          action.projectError === undefined ? validated : projected,
                        )
                        const tag =
                          isRecord(data) && typeof data._tag === "string" ? data._tag : "Failure"
                        const message =
                          isRecord(data) && typeof data.message === "string" ? data.message : tag
                        const failure = new DeclaredStoreError(tag, message, data)
                        validatedFailures.add(failure)
                        throw failure
                      },
                    },
              ),
            ),
          ).then((result) => {
            if (isRecord(result) && result.kind === "navigation") {
              throw new Error("Store handlers cannot return NavigationCommand")
            }
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
      next = publishJson(this.definition.project(this.definition.store.getState()))
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
