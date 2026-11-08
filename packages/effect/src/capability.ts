import {
  type ActionDescriptor,
  assert,
  assertNever,
  boundedText,
  defined,
  ErrorCode,
  type Json,
  type JsonSchema,
  measureJson,
  NODE_LISTENERS_MAX,
  NODE_STATE_CHARACTERS_MAX,
  NODE_STATE_DEPTH_MAX,
  type NodeId,
  type NodeType,
  type OperationError,
  type OperationInfo,
  type OperationOutcome,
  ProtocolError,
} from "@reflex/protocol"
import type { Invocation, NodeAdapter, Runtime } from "@reflex/runtime"
import * as Arbitrary from "effect/Arbitrary"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberSet from "effect/FiberSet"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { Erased } from "./erased.ts"
import { redact } from "./redaction.ts"
import { redactedCodec } from "./redacted-codec.ts"
import { isLimitReached } from "./failures.ts"

/** A schema whose wire form is known only as "some JSON", which is never read here. */
export type WireCodec<A> = Schema.Codec<A, Erased>

const NO_INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false }

/** The session's control-plane runtime, available to everything that mounts. */
export class Registry extends Context.Service<Registry, Runtime>()("@reflex/effect/Registry") {}

/** State's single write path. Handlers receive it; nothing else can write. */
export interface StateAccess<S> {
  readonly get: Effect.Effect<S>
  update(transition: (state: S) => S): Effect.Effect<void>
}

declare const noInput: unique symbol

/** What an action without an input gets. Distinct from `unknown`, a real input type. */
export type NoInput = typeof noInput

export interface ActionDefinition<S, I, E, R> {
  readonly description?: string
  /** Omit for actions that take no input. */
  readonly input?: WireCodec<I>
  /** Declare the failure's shape to carry it over the wire as `error.data`. */
  readonly error?: WireCodec<E>
  /** Return `true`, or a reason the action cannot run in this state. */
  readonly available?: (state: S) => true | string
  /**
   * Runs synchronously up to its first suspension. To exclude a second dispatch
   * through `available`, update state before suspending.
   */
  readonly handler: (input: I, state: StateAccess<S>) => Effect.Effect<unknown, E, R>
}

// Actions differ in I, E and R, and `Requirements` below is what recovers R.
type AnyAction<S> = ActionDefinition<S, Erased, Erased, Erased>
export type ActionsOf<S> = { readonly [name: string]: AnyAction<S> }

type Requirements<A> = A[keyof A] extends infer D
  ? D extends ActionDefinition<Erased, Erased, Erased, infer R>
    ? R
    : never
  : never

export interface Capability<S, A extends ActionsOf<S>, R> {
  readonly name: string
  readonly type: NodeType
  readonly state: WireCodec<S>
  readonly actions: A
  readonly onFocus: ((state: StateAccess<S>) => Effect.Effect<unknown, unknown, R>) | undefined
}

/** Binds `S` so that each action infers its own input, error and services. */
type ActionBuilder<S> = <I = NoInput, E = never, R = never>(
  definition: ActionDefinition<S, I, E, R>,
) => ActionDefinition<S, I, E, R>

/**
 * Declare state and actions once. Validation, JSON Schema, availability and
 * input generators all derive from this definition.
 */
export const defineCapability = <S, A extends ActionsOf<S>, R = never>(definition: {
  readonly name: string
  readonly type?: NodeType
  readonly state: WireCodec<S>
  readonly actions: (action: ActionBuilder<S>) => A
  /** Runs each time the node gains focus; use it to load or refresh. */
  readonly onFocus?: (state: StateAccess<S>) => Effect.Effect<unknown, unknown, R>
}): Capability<S, A, R | Requirements<A>> => ({
  name: definition.name,
  type: definition.type ?? "screen",
  state: definition.state,
  actions: definition.actions((action) => action),
  onFocus: definition.onFocus,
})

/** A live instance. The same object serves the UI and the protocol. */
export interface LiveNode<S, A> {
  readonly id: NodeId
  readonly name: string
  /** Stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot(): S
  subscribe(listener: () => void): () => void
  /** Goes through the same validation and tracking as a remote dispatch. */
  send<K extends keyof A & string>(action: K, ...args: SendArgs<A[K]>): Promise<OperationInfo>
  /** Start `onFocus`. Called by whatever owns focus. */
  focused(): void
  /** Refuse further actions and leave the registry. Closing its scope does this too. */
  withdraw(): void
}

export type SendArgs<D> =
  D extends ActionDefinition<Erased, infer I, Erased, Erased>
    ? [I] extends [NoInput]
      ? []
      : [input: I]
    : never

/** A screen of a known capability behind a protocol handle, for UI bindings. */
export const liveNodeOf = <S, A extends ActionsOf<S>, R>(
  runtime: Runtime,
  nodeId: NodeId,
  capability: Capability<S, A, R>,
): LiveNode<S, A> | undefined => {
  const live = runtime.liveOf(nodeId)
  if (live instanceof NodeInstance && live.isInstanceOf(capability)) {
    // Identity of the capability object is what proves `S` and `A`: names can repeat.
    return live as unknown as LiveNode<S, A>
  }
  return undefined
}

export interface MountedNode<S, A> {
  readonly node: LiveNode<S, A>
  readonly access: StateAccess<S>
}

/**
 * Create and register a live node. It lives as long as the surrounding scope;
 * closing that scope interrupts its running actions and unregisters it.
 */
export const mount = <S, A extends ActionsOf<S>, R>(
  capability: Capability<S, A, R>,
  initial: S,
): Effect.Effect<LiveNode<S, A>, never, R | Registry | Scope.Scope> =>
  Effect.map(mountWithAccess(capability, initial), ({ node }) => node)

/** Like `mount`, for owners that also write state from outside an action. */
export const mountWithAccess = <S, A extends ActionsOf<S>, R>(
  capability: Capability<S, A, R>,
  initial: S,
): Effect.Effect<MountedNode<S, A>, never, R | Registry | Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const context = yield* Effect.context<R>()
    const fibers = yield* FiberSet.make()
    const fork = Effect.runForkWith(context)
    const instance = new NodeInstance(capability, initial, {
      registry,
      fork,
      supervise: (fiber) => FiberSet.addUnsafe(fibers, fiber),
      interruptAll: () => {
        fork(FiberSet.clear(fibers))
      },
    })
    instance.register()
    yield* Effect.addFinalizer(() => Effect.sync(() => instance.withdraw()))
    return { node: instance, access: instance.access }
  })

/**
 * `toJsonSchemaDocument` returns a wrapper; external clients need a standalone
 * schema. The published schema is always the encoded wire form. `Struct({})`
 * compiles to "anything non-null", which is why no input is its own case.
 */
export const toInputSchema = (schema: WireCodec<unknown> | undefined): JsonSchema => {
  if (schema === undefined) {
    return NO_INPUT_SCHEMA
  }
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const hasDefinitions = Object.keys(document.definitions).length > 0
  // A JSON Schema document is JSON by definition.
  return {
    ...document.schema,
    ...(hasDefinitions ? { $defs: document.definitions } : {}),
  } as JsonSchema
}

/** The wire encoder for a schema, with secrets removed first. */
export const secretFreeEncoder = <A>(schema: WireCodec<A>): ((value: A) => Json) => {
  const publishing = redactedCodec(schema)
  const encode = Schema.encodeSync(Schema.toCodecJson(schema))
  const encodeView = Schema.encodeSync(Schema.toCodecJson(publishing))
  const validate = Schema.is(Schema.toType(schema))
  return (value) => {
    const view = redact(value)
    // Validate the real secret before projection, without ever encoding its plaintext.
    if (view === value) {
      // `toCodecJson` guarantees JSON, including schemas whose encoded type is erased.
      return requireWithinStateLimit(encode(value) as Json)
    }
    if (!validate(value)) {
      throw new Error("State does not match its schema")
    }
    return requireWithinStateLimit(encodeView(view))
  }
}

/** Valid pieces can add up to more than a session should hold. */
const requireWithinStateLimit = (encoded: Json): Json => {
  const measure = measureJson(encoded, NODE_STATE_CHARACTERS_MAX, NODE_STATE_DEPTH_MAX)
  if (measure !== "fits") {
    throw new ProtocolError(ErrorCode.ResourceExhausted, `State cannot be sent: ${measure}`)
  }
  // The walk's count is a lower bound: escapes alone can double what it saw.
  if (JSON.stringify(encoded).length > NODE_STATE_CHARACTERS_MAX) {
    throw new ProtocolError(ErrorCode.ResourceExhausted, "State cannot be sent: too-large")
  }
  return encoded
}

const isEmptyInput = (raw: unknown): boolean => {
  if (raw === undefined || raw === null) {
    return true
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return false
  }
  return Object.keys(raw).length === 0
}

/** Building a codec is not free, so each action's is built once, when mounted. */
const inputDecoder = (schema: WireCodec<unknown> | undefined): ((raw: unknown) => unknown) => {
  if (schema === undefined) {
    return (raw) => {
      if (!isEmptyInput(raw)) {
        throw new ProtocolError(ErrorCode.InvalidInput, "This action takes no input")
      }
      return undefined
    }
  }
  const decode = Schema.decodeUnknownExit(Schema.toCodecJson(schema))
  return (raw) => decodedOrThrow(decode(raw, { onExcessProperty: "error" }))
}

const inputEncoder = (schema: WireCodec<unknown> | undefined): ((input: unknown) => Json) => {
  if (schema === undefined) {
    return () => ({})
  }
  // `toCodecJson` targets JSON by construction, which its types do not record.
  return Schema.encodeSync(Schema.toCodecJson(schema)) as (input: unknown) => Json
}

const decodedOrThrow = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  throw new ProtocolError(ErrorCode.InvalidInput, summarizeCause(exit.cause))
}

interface FailureFields {
  readonly _tag?: unknown
  readonly message?: unknown
}

const failureFields = (error: unknown): FailureFields =>
  typeof error === "object" && error !== null ? error : {}

const describeFailure = (
  error: unknown,
  schema: WireCodec<unknown> | undefined,
): OperationError => {
  const { _tag: tag, message } = failureFields(error)
  return {
    tag: typeof tag === "string" ? boundedText(tag) : "Failure",
    message: boundedText(typeof message === "string" ? message : String(error)),
    defect: false,
    ...(schema === undefined ? {} : dataWithinLimits(schema, error)),
  }
}

/** Data too large to carry is left out: what failed, and why, still has to arrive. */
const dataWithinLimits = (schema: WireCodec<unknown>, error: unknown) => {
  try {
    return { data: secretFreeEncoder(schema)(error) }
  } catch (cause: unknown) {
    if (isLimitReached(cause)) {
      return {}
    }
    throw cause
  }
}

/** A limit reached is expected, however deep in a handler, unless something else broke too. */
const describeDefects = (defects: ReadonlyArray<unknown>): OperationError | undefined => {
  const [first] = defects
  if (first === undefined) {
    return undefined
  }
  const genuine = defects.find((defect) => !isLimitReached(defect))
  const shown = genuine ?? first
  const message = boundedText(shown instanceof Error ? shown.message : String(shown))
  return genuine === undefined
    ? { tag: "ResourceExhausted", message, defect: false }
    : { tag: "Defect", message, defect: true }
}

const toOutcome = (
  exit: Exit.Exit<unknown, unknown>,
  schema: WireCodec<unknown> | undefined,
): OperationOutcome => {
  if (Exit.isSuccess(exit)) {
    return { status: "completed" }
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { status: "cancelled" }
  }
  // First, as a failure beside a defect would hide it, and the defect is what matters.
  const defects = exit.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)
  const error = describeDefects(defects)
  if (error !== undefined) {
    return { status: "failed", error }
  }
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) {
    return { status: "failed", error: describeFailure(failure.value, schema) }
  }
  const message = summarizeCause(exit.cause)
  return { status: "failed", error: { tag: "Defect", message, defect: true } }
}

/** One failure's message: formatting a whole cause could be arbitrarily large. */
const summarizeCause = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause)
  return boundedText(failure instanceof Error ? failure.message : String(failure))
}

/** An operation must always settle, even if describing its failure cannot work. */
const toSafeOutcome = (
  exit: Exit.Exit<unknown, unknown>,
  schema: WireCodec<unknown> | undefined,
  report: (error: unknown) => void,
): OperationOutcome => {
  try {
    return toOutcome(exit, schema)
  } catch (error: unknown) {
    report(error)
    // The cause may quote the failing value, which can be sensitive, so it stays out.
    const message = "The failure could not be described"
    return { status: "failed", error: { tag: "Defect", message, defect: true } }
  }
}

/**
 * At most one focus run at a time, however often focus comes and goes: the previous
 * run is cancelled, and cancelling can take a while, so what is left is to remember
 * that another is wanted once it has finished.
 */
type FocusWork =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly work: Invocation }
  | { readonly kind: "restarting"; readonly work: Invocation }
  | { readonly kind: "retired" }

/** What a node needs from the scope that mounted it. */
interface NodeHost<R> {
  readonly registry: Runtime
  readonly fork: ReturnType<typeof Effect.runForkWith<R>>
  readonly supervise: (fiber: ReturnType<ReturnType<typeof Effect.runForkWith<R>>>) => void
  /** Without waiting for them to stop. */
  readonly interruptAll: () => void
}

interface CompiledAction<S> {
  readonly definition: AnyAction<S>
  readonly inputSchema: JsonSchema
  readonly decode: (raw: unknown) => unknown
  /** Whole, secrets included: an input is meant to reach its handler. */
  readonly encode: (input: unknown) => Json
}

class NodeInstance<S, A extends ActionsOf<S>, R> implements NodeAdapter, LiveNode<S, A> {
  readonly id: NodeId
  readonly type: NodeType
  readonly name: string
  readonly live = this
  private state: S
  /** Encoded state, kept until the next change. */
  private encoded: Json
  private readonly encodeState: (state: S) => Json
  private readonly compiled: ReadonlyMap<string, CompiledAction<S>>
  private readonly listeners = new Set<() => void>()
  private focus: FocusWork = { kind: "idle" }
  private unregister: () => void = () => undefined

  readonly access: StateAccess<S> = {
    get: Effect.sync(() => this.state),
    update: (transition) => Effect.sync(() => this.apply(transition)),
  }

  constructor(
    private readonly capability: Capability<S, A, R>,
    initial: S,
    private readonly host: NodeHost<R>,
  ) {
    this.type = capability.type
    this.name = capability.name
    this.id = host.registry.nextId(capability.type, capability.name)
    this.state = initial
    this.encodeState = secretFreeEncoder(capability.state)
    // Now, not on first use: a state that cannot be sent must not go live.
    this.encoded = this.encodeState(initial)
    this.compiled = new Map(
      Object.entries(capability.actions).map(([key, definition]) => [
        key,
        {
          definition,
          inputSchema: toInputSchema(definition.input),
          decode: inputDecoder(definition.input),
          encode: inputEncoder(definition.input),
        },
      ]),
    )
  }

  isInstanceOf(capability: unknown): boolean {
    return this.capability === capability
  }

  getSnapshot = (): S => this.state

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size >= NODE_LISTENERS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many listeners on one node")
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): Json {
    return this.encoded
  }

  actions(): { readonly [name: string]: ActionDescriptor } {
    return Object.fromEntries(
      [...this.compiled].map(([key, action]) => [key, this.describeAction(action)]),
    )
  }

  prepare(key: string, raw: unknown): () => Invocation {
    const { definition, decode } = defined(
      this.compiled.get(key),
      "the runtime checked the action exists",
    )
    const input = decode(raw)
    return () =>
      this.run(
        Effect.suspend(() => definition.handler(input, this.access)),
        definition.error,
      )
  }

  async sample(key: string, seed: number): Promise<Json> {
    const action = this.compiled.get(key)
    const schema = action?.definition.input
    if (action === undefined || schema === undefined) {
      return {}
    }
    const generate = Arbitrary.sampleEffect(Arbitrary.schema(schema), { count: 1, seed })
    const [value] = await Effect.runPromise(generate)
    assert(value !== undefined, "one sample was requested")
    return action.encode(value)
  }

  /**
   * Async so that an input that will not encode is a rejection, like any other
   * refusal. Inputs are encoded whole: a password in an input is meant to arrive.
   */
  async send<K extends keyof A & string>(
    action: K,
    ...args: SendArgs<A[K]>
  ): Promise<OperationInfo> {
    const compiled = defined(this.compiled.get(action), "action names are typed")
    const target = { nodeId: this.id, action, await: true }
    if (compiled.definition.input === undefined) {
      return this.host.registry.dispatch(target)
    }
    // `SendArgs` is a one-element tuple for an action that has an input.
    const [value] = args as ReadonlyArray<unknown>
    return this.host.registry.dispatch({ ...target, input: compiled.encode(value) })
  }

  register(): void {
    this.unregister = this.host.registry.register(this)
  }

  /**
   * Out of reach and stopping from here on, ahead of a cleanup that may take its time.
   * Nothing may start here again, including a queued refocus.
   */
  withdraw(): void {
    this.focus = { kind: "retired" }
    this.unregister()
    this.unregister = () => undefined
    this.host.interruptAll()
  }

  focused(): void {
    const { focus } = this
    switch (focus.kind) {
      case "idle":
        this.startFocusWork()
        break
      case "running":
        focus.work.cancel()
        this.focus = { kind: "restarting", work: focus.work }
        break
      case "restarting":
      case "retired":
        break
      default:
        assertNever(focus)
    }
  }

  private startFocusWork(): void {
    const { onFocus } = this.capability
    if (onFocus === undefined) {
      return
    }
    const work = this.host.registry.track(this.id, "onFocus", () =>
      this.run(
        Effect.suspend(() => onFocus(this.access)),
        undefined,
      ),
    )
    this.focus = { kind: "running", work }
    work.done
      .then((outcome) => {
        if (outcome.status === "failed") {
          this.host.registry.report(new Error(`onFocus failed: ${outcome.error.message}`))
        }
        this.onFocusWorkDone()
      })
      .catch((error: unknown) => this.host.registry.report(error))
  }

  private onFocusWorkDone(): void {
    const { kind } = this.focus
    if (kind === "retired") {
      return
    }
    this.focus = { kind: "idle" }
    if (kind === "restarting") {
      this.startFocusWork()
    }
  }

  private describeAction({ definition, inputSchema }: CompiledAction<S>): ActionDescriptor {
    const { description } = definition
    const described = description === undefined ? { inputSchema } : { description, inputSchema }
    const verdict = definition.available?.(this.state) ?? true
    if (verdict === true) {
      return { ...described, available: true }
    }
    return { ...described, available: false, unavailableReason: verdict }
  }

  /** Encodes first: state that cannot be published must not become the state. */
  private apply(transition: (state: S) => S): void {
    const next = transition(this.state)
    if (next === this.state) {
      return
    }
    const encoded = this.encodeState(next)
    this.state = next
    this.encoded = encoded
    for (const listener of [...this.listeners]) {
      this.notify(listener)
    }
  }

  /** The state has changed: one listener's failure cannot undo that for the others. */
  private notify(listener: () => void): void {
    try {
      listener()
    } catch (error: unknown) {
      this.host.registry.report(error)
    }
  }

  private run(
    effect: Effect.Effect<unknown, unknown, R>,
    schema: WireCodec<unknown> | undefined,
  ): Invocation {
    const fiber = this.host.fork(effect)
    this.host.supervise(fiber)
    return {
      done: new Promise((resolve) => {
        fiber.addObserver((exit) => {
          resolve(toSafeOutcome(exit, schema, (error) => this.host.registry.report(error)))
        })
      }),
      cancel: () => fiber.interruptUnsafe(),
    }
  }
}
