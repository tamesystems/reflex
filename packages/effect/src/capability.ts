import { ActionNavigation } from "./action-navigation.ts"
import type { NavigationRefused } from "./navigation.ts"
import { contractIdentity } from "./screen-identity.ts"
import {
  type ActionDescriptor,
  assert,
  assertNever,
  boundedText,
  defined,
  ErrorCode,
  type Json,
  type JsonSchema,
  NODE_LISTENERS_MAX,
  type NodeId,
  type NodeType,
  type OperationError,
  type OperationInfo,
  type OperationOutcome,
  ProtocolError,
} from "@reflex/protocol"
import {
  actionOutcome,
  publishJson,
  reportActionOutcome,
  decodeActionInput,
  bindActions,
  type ActionOutcome,
  type NodeHandle,
  type ConsumerDefinition,
  type Invocation,
  type NodeAdapter,
  type Runtime,
} from "@reflex/runtime/internal"
import * as Arbitrary from "effect/Arbitrary"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberSet from "effect/FiberSet"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Redacted from "effect/Redacted"
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
export interface StateAccess<S, Next = S> {
  readonly get: Effect.Effect<S>
  update(transition: (state: S) => Next): Effect.Effect<void>
  when<K extends Next extends { readonly _tag: infer T } ? T & string : never>(
    tag: K,
  ): StateAccess<Extract<Next, { readonly _tag: K }>, Next>
}

/** Recheck the discriminant at commit; suspended handlers cannot overwrite a newer state. */
const narrowAccess = <S, K extends S extends { readonly _tag: infer T } ? T & string : never>(
  access: StateAccess<S>,
  tag: K,
): StateAccess<Extract<S, { readonly _tag: K }>, S> => {
  type N = Extract<S, { readonly _tag: K }>
  const matches = (state: S): state is N =>
    typeof state === "object" && state !== null && "_tag" in state && state._tag === tag
  return {
    get: Effect.flatMap(access.get, (state) =>
      matches(state) ? Effect.succeed(state) : Effect.interrupt,
    ),
    update: (transition) => access.update((state) => (matches(state) ? transition(state) : state)),
    when: access.when,
  }
}

/** What an action without an input gets. Distinct from `unknown`, a real input type. */
// biome-ignore lint/suspicious/noConfusingVoidType: void models a handler parameter, including ignored return values.
export type NoInput = void

const CHECKED_ACTION = Symbol("reflex/checked-action")

export interface ActionDefinition<S, I, E, R, Next = S, W = E, In = I> {
  readonly [CHECKED_ACTION]: true
  readonly description?: string
  /** Omit for actions that take no input. */
  readonly input?: Schema.Codec<I, In>
  /** Declare the failure's shape to carry it over the wire as `error.data`. */
  readonly error?: Schema.Codec<E, W>
  /** Return `true`, or a reason the action cannot run in this state. */
  readonly available?: (state: S) => true | string
  /**
   * Runs synchronously up to its first suspension. To exclude a second dispatch
   * through `available`, update state before suspending.
   */
  readonly handler: (
    input: NoInfer<I>,
    state: StateAccess<S, Next>,
  ) => Effect.Effect<unknown, E | NavigationRefused, R>
}

// Actions differ in I, E and R, and `Requirements` below is what recovers R.
type AnyAction<S> = ActionDefinition<S, Erased, Erased, Erased>
export type ActionsOf<S> = { readonly [name: string]: AnyAction<S> }

type Requirements<A> = A[keyof A] extends infer D
  ? D extends ActionDefinition<Erased, Erased, Erased, infer R>
    ? R
    : never
  : never

export type PublicState<T> =
  T extends Redacted.Redacted<unknown>
    ? string
    : T extends ReadonlyMap<infer K, infer V>
      ? readonly (readonly [PublicState<K>, PublicState<V>])[]
      : T extends ReadonlySet<infer Item>
        ? readonly PublicState<Item>[]
        : T extends Date | bigint
          ? string
          : T extends readonly unknown[]
            ? { readonly [K in keyof T]: PublicState<T[K]> }
            : T extends object
              ? {
                  readonly [K in keyof T as K extends string
                    ? T[K] extends (...args: never[]) => unknown
                      ? never
                      : K
                    : never]: PublicState<T[K]>
                }
              : T

export interface Capability<S, A extends ActionsOf<S>, R, P = Record<string, never>, W = S>
  extends ConsumerDefinition<PublicState<W>, ActionCalls<A>> {
  resolve(runtime: Runtime, id?: NodeId): LiveNode<PublicState<W>, A> | undefined
  readonly params: WireCodec<P>
  readonly initial: ((params: P) => S) | undefined
  readonly name: string
  readonly type: NodeType
  readonly state: WireCodec<S>
  readonly actions: A
  readonly onFocus: ((state: StateAccess<S>) => Effect.Effect<unknown, never, R>) | undefined
}

type SchemaOption = WireCodec<Erased> | undefined
type DecodedInput<I> = I extends WireCodec<Erased> ? I["Type"] : undefined
type EncodedInput<I> = I extends WireCodec<Erased> ? I["Encoded"] : undefined
type DeclaredError<E> = E extends WireCodec<Erased> ? E["Type"] : never
type EncodedError<E> = E extends WireCodec<Erased> ? E["Encoded"] : never
type HandlerInput<I> =
  I extends WireCodec<Erased>
    ? I["Type"]
    :
        | undefined
        | {
            readonly "Annotating the handler input does not declare a schema; add input:": never
          }

/** Schema presence, rather than the handler's annotations, determines input and errors. */
type CheckedActionBuilder<S, N = S> = <
  const I extends SchemaOption = undefined,
  const E extends SchemaOption = undefined,
  R = never,
>(definition: {
  readonly description?: string
  readonly input?: I
  readonly error?: E
  readonly available?: (state: N) => true | string
  readonly handler: (
    input: NoInfer<HandlerInput<I>>,
    state: StateAccess<N, S>,
  ) => Effect.Effect<
    unknown,
    | NoInfer<
        E extends WireCodec<Erased>
          ? E["Type"]
          : { readonly "Declare action failures with error:": never }
      >
    | NavigationRefused,
    R
  >
}) => NoInfer<
  ActionDefinition<
    S,
    DecodedInput<NoInfer<I>>,
    DeclaredError<NoInfer<E>>,
    R,
    S,
    EncodedError<NoInfer<E>>,
    EncodedInput<NoInfer<I>>
  > &
    (NoInfer<I> extends WireCodec<Erased> ? { readonly input: I } : Record<never, never>)
>
interface GuardedActionBuilder<S, N> extends CheckedActionBuilder<S, N> {
  reduce<I extends SchemaOption = undefined>(definition: {
    readonly description?: string
    readonly input?: I
    readonly available?: (state: N) => true | string
    readonly reducer: (
      input: NoInfer<I extends WireCodec<Erased> ? I["Type"] : undefined>,
      state: N,
    ) => S
  }): NoInfer<
    ActionDefinition<
      S,
      DecodedInput<NoInfer<I>>,
      never,
      never,
      S,
      never,
      EncodedInput<NoInfer<I>>
    > &
      (NoInfer<I> extends WireCodec<Erased> ? { readonly input: I } : Record<never, never>)
  >
}
interface ActionBuilder<S> extends CheckedActionBuilder<S> {
  when<K extends S extends { readonly _tag: infer T } ? T & string : never>(
    tag: K,
    reason?: string,
  ): GuardedActionBuilder<S, Extract<S, { readonly _tag: K }>>
}

export const actionBuilder = <S>(): ActionBuilder<S> =>
  Object.assign(
    <I = NoInput, E = never, R = never>(
      definition: Omit<ActionDefinition<S, I, E, R>, typeof CHECKED_ACTION>,
    ) => ({ ...definition, [CHECKED_ACTION]: true as const }),
    {
      when: <K extends S extends { readonly _tag: infer T } ? T & string : never>(
        tag: K,
        reason = `Requires ${tag} state`,
      ) => {
        type N = Extract<S, { readonly _tag: K }>
        const matches = (state: S): state is N =>
          typeof state === "object" && state !== null && "_tag" in state && state._tag === tag
        const build = <I = NoInput, E = never, R = never>(
          definition: Omit<ActionDefinition<N, I, E, R, S, Erased, Erased>, typeof CHECKED_ACTION>,
        ): ActionDefinition<S, I, E, R, S, Erased, Erased> => ({
          ...definition,
          [CHECKED_ACTION]: true,
          available: (state) => (matches(state) ? (definition.available?.(state) ?? true) : reason),
          handler: (input, state) =>
            definition.handler(input, {
              get: Effect.flatMap(state.get, (current) =>
                matches(current) ? Effect.succeed(current) : Effect.interrupt,
              ),
              update: (transition) =>
                state.update((current) => (matches(current) ? transition(current) : current)),
              when: state.when,
            }),
        })
        return Object.assign(build, {
          reduce: <I = NoInput>(
            definition: Omit<
              ActionDefinition<N, I, never, never, S>,
              "handler" | typeof CHECKED_ACTION
            > & {
              readonly reducer: (input: I, state: N) => S
            },
          ) =>
            build({
              ...definition,
              handler: (input, state) =>
                state.update((current) =>
                  matches(current) ? definition.reducer(input, current) : current,
                ),
            }),
        })
      },
    },
  ) as unknown as ActionBuilder<S>

/**
 * Declare state and actions once. Validation, JSON Schema, availability and
 * input generators all derive from this definition.
 */
interface CapabilityDefinition<S, A extends ActionsOf<S>, R, P, W, Name extends string> {
  readonly params?: WireCodec<P>
  readonly initial?: (params: P) => NoInfer<S>
  readonly name: Name
  readonly type?: NodeType
  readonly state: Schema.Codec<S, W>
  readonly actions: (action: ActionBuilder<S>) => A
  /** Runs each time the node gains focus; use it to load or refresh. */
  readonly onFocus?: (state: StateAccess<S>) => Effect.Effect<unknown, never, R>
}

export function defineCapability<
  S,
  A extends ActionsOf<S>,
  R = never,
  P = Record<string, never>,
  W = S,
  const Name extends string = string,
>(
  definition: CapabilityDefinition<S, A, R, P, W, Name> & {
    readonly initial: (params: P) => NoInfer<S>
  },
): Capability<S, A, R | Requirements<A>, P, W> & {
  readonly name: Name
  readonly initial: (params: P) => S
}
export function defineCapability<
  S,
  A extends ActionsOf<S>,
  R = never,
  P = Record<string, never>,
  W = S,
  const Name extends string = string,
>(
  definition: Omit<CapabilityDefinition<S, A, R, P, W, Name>, "initial"> & {
    readonly initial?: never
  },
): Capability<S, A, R | Requirements<A>, P, W> & { readonly name: Name }
export function defineCapability<
  S,
  A extends ActionsOf<S>,
  R = never,
  P = Record<string, never>,
  W = S,
  const Name extends string = string,
>(
  definition: CapabilityDefinition<S, A, R, P, W, Name>,
): Capability<S, A, R | Requirements<A>, P, W> & { readonly name: Name } {
  const actions = definition.actions(actionBuilder<S>())
  for (const [name, action] of Object.entries(actions)) {
    if (action[CHECKED_ACTION] !== true) {
      throw new Error(
        `Capability "${definition.name}" action "${name}" must be created with the action builder`,
      )
    }
  }
  return {
    resolve(runtime, id) {
      const nodeId = id ?? runtime.inspect({ name: definition.name }).node?.id
      return nodeId === undefined ? undefined : liveNodeOf(runtime, nodeId, this)
    },
    params: definition.params ?? (Schema.Record(Schema.String, Schema.Never) as WireCodec<P>),
    initial: definition.initial,
    name: definition.name,
    type: definition.type ?? "screen",
    state: definition.state,
    actions,
    "~reflex": {
      decodeParams: (raw) =>
        Schema.decodeUnknownSync(
          Schema.toCodecJson(definition.params ?? Schema.Record(Schema.String, Schema.Never)),
        )(raw),
      input: (name, args) => {
        const action = defined(actions[name], "action names come from the definition")
        return action.input === undefined ? undefined : (args[0] as Json)
      },
      // State was validated and redacted by the producing adapter. Journeys observe its wire view.
      state: (raw) => raw as PublicState<W>,
      actions: (run) =>
        bindActions<ActionCalls<A>>(Object.keys(actions), (name, args) =>
          actionOutcome(() => {
            const action = defined(actions[name], "action names come from the definition")
            return run(name, action.input === undefined ? undefined : (args[0] as Json))
          }),
        ),
    },
    onFocus: definition.onFocus,
  }
}

/** A live instance. The same object serves the UI and the protocol. */
export type NodeOf<C> = C extends ConsumerDefinition<infer S, unknown> & {
  readonly actions: infer A
}
  ? LiveNode<S, A>
  : never

export type ActionCalls<A> = {
  readonly [K in keyof A]: (
    ...args: ConsumerArgs<A[K]>
  ) => Promise<ActionOutcome<ActionError<A[K]>>>
}
type ConsumerArgs<D> = D extends import("./author-model.ts").Action<infer I, Erased, Erased, Erased>
  ? [I] extends [undefined]
    ? []
    : [input: I]
  : D extends { readonly input: Schema.Codec<unknown, infer In> }
    ? [input: PublicState<In>]
    : D extends ActionDefinition<Erased, infer I, Erased, Erased, Erased, Erased, infer In>
      ? [I] extends [NoInput]
        ? []
        : [input: PublicState<In>]
      : never
type ActionError<D> = D extends import("./author-model.ts").Action<Erased, infer E, Erased, Erased>
  ? E
  : D extends ActionDefinition<Erased, Erased, Erased, Erased, Erased, infer W>
    ? PublicState<W>
    : never

export interface LiveNode<S, A> extends NodeHandle<S, ActionCalls<A>> {
  readonly id: NodeId
  readonly name: string
  /** Stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot(): S
  subscribe(listener: () => void): () => void
}

/** Resource ownership and decoded dispatch are reserved for integrations. */
export interface OwnedLiveNode<S, A> extends LiveNode<S, A> {
  dispose(): void
  send(...args: ActionArgs<A>): Promise<OperationInfo>
}

export type ActionArgs<A> = {
  [K in keyof A & string]: [action: K, ...args: SendArgs<A[K]>]
}[keyof A & string]

export type SendArgs<D> =
  D extends ActionDefinition<Erased, infer I, Erased, Erased>
    ? [I] extends [NoInput]
      ? []
      : [input: I]
    : never

/** A screen of a known capability behind a protocol handle, for UI bindings. */
export const liveNodeOf = <S, A extends ActionsOf<S>, R, P, W>(
  runtime: Runtime,
  nodeId: NodeId,
  capability: Capability<S, A, R, P, W>,
): LiveNode<PublicState<W>, A> | undefined => {
  const live = runtime.liveOf(nodeId)
  if (live instanceof NodeInstance && live.isInstanceOf(capability)) {
    // Identity of the capability object is what proves `S` and `A`: names can repeat.
    return live as unknown as LiveNode<PublicState<W>, A>
  }
  return undefined
}

export interface MountedNode<S, A, W = S> {
  readonly node: OwnedLiveNode<PublicState<W>, A>
  readonly access: StateAccess<S>
}

/**
 * Create and register a live node. It lives as long as the surrounding scope;
 * closing that scope interrupts its running actions and unregisters it.
 */
export const mount = <S, A extends ActionsOf<S>, R, P, W>(
  capability: Capability<S, A, R, P, W>,
  initial: S,
  options: { readonly focus?: boolean } = {},
): Effect.Effect<LiveNode<PublicState<W>, A>, never, R | Registry | Scope.Scope> =>
  Effect.flatMap(mountWithAccess(capability, initial), ({ node }) =>
    Effect.map(Registry, (runtime) => {
      if (options.focus === true) {
        runtime.setFocus(node.id)
      }
      return node
    }),
  )

/** Like `mount`, for owners that also write state from outside an action. */
export const mountWithAccess = <S, A extends ActionsOf<S>, R, P, W>(
  capability: Capability<S, A, R, P, W>,
  initial: S,
): Effect.Effect<MountedNode<S, A, W>, never, R | Registry | Scope.Scope> =>
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
    yield* Effect.addFinalizer(() => Effect.sync(() => instance.dispose()))
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
      return publishJson(encode(value) as Json)
    }
    if (!validate(value)) {
      throw new Error("State does not match its schema")
    }
    return publishJson(encodeView(view))
  }
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
    const tag = failureFields(failure.value)._tag
    if (tag === "NavigationRefused" || tag === "StateChanged") {
      return {
        status: "failed",
        error: {
          tag,
          message: boundedText(
            String(
              (failure.value as { reason?: string }).reason ?? "State changed during the action",
            ),
          ),
          defect: false,
        },
      }
    }
    if (tag === "NavigationStackFull" || tag === "ScreenBuildTimedOut") {
      return { status: "failed", error: describeFailure(failure.value, undefined) }
    }
    if (
      schema === undefined &&
      failureFields(failure.value)._tag !== "NavigationStackFull" &&
      failureFields(failure.value)._tag !== "ScreenBuildTimedOut"
    ) {
      return {
        status: "failed",
        error: {
          tag: "UndeclaredFailure",
          defect: true,
          message: boundedText(
            `Undeclared failure: ${describeFailure(failure.value, undefined).message}`,
          ),
        },
      }
    }
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

class NodeInstance<S, A extends ActionsOf<S>, R, P, W>
  implements NodeAdapter, OwnedLiveNode<PublicState<W>, A>
{
  readonly id: NodeId
  readonly type: NodeType
  readonly name: string
  readonly live = this
  readonly actions: ActionCalls<A>
  private state: S
  /** Encoded state, kept until the next change. */
  private encoded: Json
  private readonly encodeState: (state: S) => Json
  private readonly compiled: ReadonlyMap<string, CompiledAction<S>>
  private readonly listeners = new Set<() => void>()
  private readonly availabilityListeners = new Set<() => void>()
  private focus: FocusWork = { kind: "idle" }
  private unregister: () => void = () => undefined

  readonly access: StateAccess<S> = {
    get: Effect.suspend(() => (this.isClosed() ? Effect.interrupt : Effect.sync(() => this.state))),
    update: (transition) =>
      Effect.suspend(() =>
        this.isClosed() ? Effect.interrupt : Effect.sync(() => this.apply(transition)),
      ),
    when: (tag) => narrowAccess(this.access, tag),
  }

  constructor(
    private readonly capability: Capability<S, A, R, P, W>,
    initial: S,
    private readonly host: NodeHost<R>,
  ) {
    this.actions = bindActions<ActionCalls<A>>(Object.keys(capability.actions), (name, args) =>
      reportActionOutcome(
        actionOutcome(() =>
          this.host.registry.dispatch({
            nodeId: this.id,
            action: name,
            await: true,
            ...(capability.actions[name]?.input === undefined ? {} : { input: args[0] as Json }),
          }),
        ),
        (error) => this.host.registry.report(error),
      ),
    )
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
    return (
      (typeof capability === "object" || typeof capability === "function") &&
      capability !== null &&
      contractIdentity(this.capability) === contractIdentity(capability)
    )
  }

  getSnapshot = (): PublicState<W> => this.encoded as PublicState<W>

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

  describeActions(): { readonly [name: string]: ActionDescriptor } {
    return Object.fromEntries(
      [...this.compiled].map(([key, action]) => [key, this.describeAction(action)]),
    )
  }

  prepare(key: string, raw: unknown): () => Invocation {
    const { definition, decode } = defined(
      this.compiled.get(key),
      "the runtime checked the action exists",
    )
    const input = decodeActionInput(this.name, key, raw, decode)
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
  async send(...[action, ...args]: ActionArgs<A>): Promise<OperationInfo> {
    const compiled = defined(this.compiled.get(action), "action names are typed")
    const target = { nodeId: this.id, action, await: true }
    if (compiled.definition.input === undefined) {
      return this.host.registry.dispatch(target)
    }
    // `SendArgs` is a one-element tuple for an action that has an input.
    const [value] = args as ReadonlyArray<unknown>
    return this.host.registry.dispatch({ ...target, input: compiled.encode(value) })
  }

  availability(action: keyof A & string): true | string {
    if (this.focus.kind === "retired" || this.host.registry.closed) {
      return "The node is disposed"
    }
    if (this.type === "screen" && this.host.registry.focus !== this.id) {
      return "The screen is not focused"
    }
    return this.capability.actions[action]?.available?.(this.state) ?? true
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
        this.host.registry.report(error)
      }
    }
  }

  register(): void {
    this.unregister = this.host.registry.register(this)
  }

  /**
   * Out of reach and stopping from here on, ahead of a cleanup that may take its time.
   * Nothing may start here again, including a queued refocus.
   */
  dispose(): void {
    this.focus = { kind: "retired" }
    this.availabilityChanged()
    this.availabilityListeners.clear()
    this.unregister()
    this.unregister = () => undefined
    this.host.interruptAll()
  }

  onFocus(): void {
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
    this.requireActive()
    const next = transition(this.state)
    this.requireActive()
    if (next === this.state) {
      return
    }
    const encoded = this.encodeState(next)
    this.requireActive()
    this.state = next
    this.encoded = encoded
    for (const listener of [...this.listeners]) {
      this.notify(listener)
    }
    this.availabilityChanged()
  }

  private requireActive(): void {
    if (this.isClosed()) {
      throw new ProtocolError(
        ErrorCode.SessionClosed,
        `State access for ${this.name} belongs to a closed node`,
      )
    }
  }

  private isClosed(): boolean {
    return this.focus.kind === "retired" || this.host.registry.closed
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
    const pending: Effect.Effect<void, unknown>[] = []
    let fiber = this.host.fork(
      Effect.provideService(Effect.scoped(effect), ActionNavigation, { pending }),
    )
    this.host.supervise(fiber)
    return {
      done: new Promise((resolve) => {
        const finish = (exit: Exit.Exit<unknown, unknown>) =>
          resolve(toSafeOutcome(exit, schema, (error) => this.host.registry.report(error)))
        fiber.addObserver((exit) => {
          if (Exit.isFailure(exit) || pending.length === 0) {
            finish(exit)
            return
          }
          // The handler is finished before a pop can retire its scope. Navigation's
          // own lifetime belongs to the navigator rather than the departed screen.
          fiber = this.host.fork(
            Effect.scoped(Effect.forEach(pending, (work) => work, { discard: true })),
          )
          fiber.addObserver(finish)
        })
      }),
      cancel: () => fiber.interruptUnsafe(),
    }
  }
}

/** Explicit advanced decoded-input seam; ordinary consumers call node.actions. */
export const dispatchDecoded = <S, A>(
  node: LiveNode<S, A>,
  ...args: NoInfer<ActionArgs<A>>
): Promise<OperationInfo> => {
  if (!(node instanceof NodeInstance)) {
    throw new Error("Decoded dispatch requires an Effect node")
  }
  return (node as unknown as OwnedLiveNode<S, A>).send(...args)
}

/** Integration ownership for factories that retire a node before closing its scope. */
export const mountOwned = <S, A extends ActionsOf<S>, R, P, W>(
  capability: Capability<S, A, R, P, W>,
  initial: S,
) => Effect.map(mountWithAccess(capability, initial), ({ node }) => node)
