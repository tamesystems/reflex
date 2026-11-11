import type { Json, NodeId, NodeSnapshot, OperationInfo, OperationId } from "@reflex/protocol"
import {
  actionOutcome,
  type ActionOutcome,
  type ConsumerDefinition,
  type InferState,
  type InferActions,
} from "@reflex/runtime/internal"

export type JourneyClientFor<H> = JourneyClient<
  H extends { readonly nodes: infer N } ? Extract<N[keyof N], ConsumerDefinition> : never
>

export type { InferState, InferActions } from "@reflex/runtime/internal"
export type CheckedActions<A, Status extends string> = {
  readonly [K in keyof A]: A[K] extends (...args: infer Args) => Promise<infer Outcome>
    ? (...args: Args) => Promise<Extract<Outcome, { readonly status: Status }>>
    : never
}
const inclusion = Symbol("reflex/includes")
export interface Includes<M> {
  readonly [inclusion]: readonly M[]
}
/** Match array members by content, without positional placeholders. */
export const includes = <E>(...items: readonly Partial<NoInfer<E>>[]): Includes<E> => ({
  [inclusion]: items as readonly E[],
})
const contains = (value: unknown): value is Includes<unknown> =>
  typeof value === "object" && value !== null && inclusion in value
const wireMatch = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(wireMatch)
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => !contains(item))
      .map(([key, item]) => [key, wireMatch(item)]),
  )
}
const matchesState = (actual: unknown, expected: unknown): boolean => {
  if (contains(expected)) {
    return (
      Array.isArray(actual) &&
      expected[inclusion].every((item) => actual.some((candidate) => matchesState(candidate, item)))
    )
  }
  if (expected === null || typeof expected !== "object") {
    return actual === expected
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesState(actual[index], item))
    )
  }
  if (actual === null || typeof actual !== "object") {
    return false
  }
  return Object.entries(expected).every(([key, item]) =>
    matchesState((actual as Record<string, unknown>)[key], item),
  )
}
export type StateMatch<S> = S extends readonly (infer Item)[]
  ?
      | (number extends S["length"]
          ? readonly StateMatch<Item>[]
          : { readonly [K in keyof S]: StateMatch<S[K]> })
      | Includes<StateMatch<Item>>
  : S extends object
    ? { readonly [K in keyof S]?: StateMatch<S[K]> }
    : S
export type MatchedState<S, M> = S extends unknown
  ? keyof M extends keyof S
    ? M extends { readonly _tag: infer Tag }
      ? S extends { readonly _tag: Tag }
        ? S
        : never
      : S
    : never
  : never
export interface JourneyNode<D, M> {
  /** Read this exact node again, rather than retaining a captured snapshot. */
  state(): Promise<MatchedState<InferState<D>, M>>
  readonly actions: JourneyActions<InferActions<D>>
  readonly expectFailure: CheckedActions<InferActions<D>, "domain-error">
  readonly expectRefusal: CheckedActions<InferActions<D>, "refused">
  readonly allowCancellation: CheckedActions<InferActions<D>, "completed" | "cancelled">
  readonly id: NodeId
}

export interface JourneyTransport {
  inspect(name?: string, nodeId?: NodeId): Promise<NodeSnapshot>
  wait(name: string, match?: Json): Promise<void>
  dispatch(nodeId: NodeId, action: string, input?: Json): Promise<OperationInfo>
  start?(nodeId: NodeId, action: string, input?: Json): Promise<OperationInfo>
  complete?(operationId: OperationId): Promise<OperationInfo>
  cancel?(operationId: OperationId): Promise<void>
  readonly timeoutMs?: number
  subscribe?(listener: () => void): () => void
  validateDefinition?(definition: ConsumerDefinition): void
}

/** One typed client for loopback tests, RPC and a device's CLI harness. */
export interface JourneyClient<D extends ConsumerDefinition = ConsumerDefinition> {
  back(): Promise<ActionOutcome>
  node<C extends D>(definition: C): Promise<JourneyNode<C, unknown>>
  focused<C extends D, const M extends StateMatch<InferState<C>> = StateMatch<InferState<C>>>(
    definition: C,
    match?: M,
  ): Promise<JourneyNode<C, M>>
}

export interface JourneyOperation<E> {
  readonly id?: OperationId
  completed(options?: { readonly allowCancellation?: boolean }): Promise<void>
  cancelled(): Promise<{ readonly status: "cancelled" }>
  expectError(): Promise<{ readonly status: "error"; readonly error: E }>
  expectRefusal(): Promise<{ readonly status: "refused"; readonly reason: string }>
  cancel(): Promise<void>
}
type PublishedError<O> = O extends { status: "domain-error"; error: { data?: infer E } } ? E : never
export type JourneyActions<A> = {
  readonly [K in keyof A]: A[K] extends (...args: infer Args) => Promise<infer O>
    ? ((...args: Args) => Promise<Extract<O, { status: "completed" }>>) & {
        run(
          ...args: Args
        ): Promise<import("@reflex/runtime/advanced").ActionOutcome<PublishedError<O>>>
        expectCompleted(...args: Args): Promise<void>
        expectError(
          ...args: Args
        ): Promise<{ readonly status: "error"; readonly error: PublishedError<O> }>
        expectRefusal(
          ...args: Args
        ): Promise<{ readonly status: "refused"; readonly reason: string }>
        start(...args: Args): Promise<JourneyOperation<PublishedError<O>>>
      }
    : never
}
const assertOutcome = (
  name: string,
  outcome: ActionOutcome<unknown>,
  expected: string,
  allowCancellation = false,
) => {
  if (outcome.status !== expected && !(allowCancellation && outcome.status === "cancelled")) {
    throw new Error(
      `${name}: expected ${expected}, received ${outcome.status}${"error" in outcome ? ` (${outcome.error.tag}: ${outcome.error.message})` : "reason" in outcome ? ` (${outcome.reason})` : ""}`,
    )
  }
}
const checked = <A>(actions: A, mode: "success" | "failure" | "refusal" | "cancellation"): A =>
  Object.fromEntries(
    Object.entries(
      actions as Record<string, (...args: unknown[]) => Promise<ActionOutcome<unknown>>>,
    ).map(([name, run]) => [
      name,
      async (...args: unknown[]) => {
        const outcome = await run(...args)
        assertOutcome(
          name,
          outcome,
          mode === "failure" ? "domain-error" : mode === "refusal" ? "refused" : "completed",
          mode === "cancellation",
        )
        return outcome
      },
    ]),
  ) as A

const operationHandle = (
  name: string,
  operation: OperationInfo,
  transport: JourneyTransport,
): JourneyOperation<unknown> => {
  const result = () =>
    actionOutcome(() =>
      operation.status === "running"
        ? transport.complete === undefined
          ? Promise.reject(new Error("Transport cannot await operations"))
          : transport.complete(operation.operationId)
        : Promise.resolve(operation),
    )
  return outcomeHandle(name, result, transport, operation.operationId)
}
const outcomeHandle = (
  name: string,
  result: () => Promise<ActionOutcome<unknown>>,
  transport: JourneyTransport,
  operationId?: OperationId,
): JourneyOperation<unknown> => {
  return {
    ...(operationId === undefined ? {} : { id: operationId }),
    async completed(options) {
      assertOutcome(name, await result(), "completed", options?.allowCancellation)
    },
    async cancelled() {
      assertOutcome(name, await result(), "cancelled")
      return { status: "cancelled" }
    },
    async expectError() {
      const outcome = await result()
      assertOutcome(name, outcome, "domain-error")
      if (outcome.status !== "domain-error") {
        throw new Error("Expected declared error")
      }
      return { status: "error", error: outcome.error.data }
    },
    async expectRefusal() {
      const outcome = await result()
      assertOutcome(name, outcome, "refused")
      if (outcome.status !== "refused") {
        throw new Error("Expected refusal")
      }
      return { status: "refused", reason: outcome.reason }
    },
    async cancel() {
      if (operationId === undefined) {
        return
      }
      if (transport.cancel === undefined) {
        throw new Error("Transport cannot cancel operations")
      }
      await transport.cancel(operationId)
    },
  }
}
const bindJourneyActions = <C extends ConsumerDefinition>(
  definition: C,
  snapshot: NodeSnapshot,
  transport: JourneyTransport,
  actions: InferActions<C>,
): JourneyActions<InferActions<C>> => {
  return Object.fromEntries(
    Object.entries(
      actions as Record<string, (...args: unknown[]) => Promise<ActionOutcome<unknown>>>,
    ).map(([name, run]) => {
      const call = async (...args: unknown[]) => {
        const outcome = await run(...args)
        assertOutcome(name, outcome, "completed")
        return outcome
      }
      return [
        name,
        Object.assign(call, {
          run: async (...args: unknown[]) => {
            const outcome = await run(...args)
            if (outcome.status === "domain-error") {
              return { status: "error", error: outcome.error.data }
            }
            if (outcome.status === "defect") {
              return { status: "defect", message: outcome.error.message }
            }
            return outcome
          },
          expectCompleted: async (...args: unknown[]) => {
            await call(...args)
          },
          expectError: async (...args: unknown[]) => {
            const outcome = await run(...args)
            assertOutcome(name, outcome, "domain-error")
            if (outcome.status !== "domain-error") {
              throw new Error("Expected declared error")
            }
            return { status: "error", error: outcome.error.data }
          },
          expectRefusal: async (...args: unknown[]) => {
            const outcome = await run(...args)
            assertOutcome(name, outcome, "refused")
            if (outcome.status !== "refused") {
              throw new Error("Expected refusal")
            }
            return { status: "refused", reason: outcome.reason }
          },
          start: async (...args: unknown[]) => {
            if (transport.start === undefined) {
              throw new Error("Transport cannot start operations")
            }
            try {
              return operationHandle(
                name,
                await transport.start(snapshot.id, name, definition["~reflex"].input(name, args)),
                transport,
              )
            } catch (error) {
              const outcome = await actionOutcome(() => Promise.reject(error))
              return outcomeHandle(name, () => Promise.resolve(outcome), transport)
            }
          },
        }),
      ]
    }),
  ) as JourneyActions<InferActions<C>>
}
const bindSnapshot = <C extends ConsumerDefinition, M>(
  definition: C,
  snapshot: NodeSnapshot,
  transport: JourneyTransport,
  match?: unknown,
): JourneyNode<C, M> => {
  const actions = definition["~reflex"].actions((action, input) =>
    transport.dispatch(snapshot.id, action, input),
  ) as InferActions<C>
  const journeyActions = bindJourneyActions(definition, snapshot, transport, actions)
  return {
    id: snapshot.id,
    state: async () => {
      const current = await transport.inspect(definition.name, snapshot.id)
      if (current.id !== snapshot.id) {
        throw new Error(`Node "${definition.name}" is no longer mounted`)
      }
      const state = definition["~reflex"].state(current.state)
      // A focused() discriminant is a proof at a point in time. Re-establish it on every read.
      if (
        typeof match === "object" &&
        match !== null &&
        (typeof state !== "object" ||
          state === null ||
          Object.keys(match).some((key) => !(key in state)) ||
          ("_tag" in match && (!("_tag" in state) || state._tag !== match._tag)))
      ) {
        throw new Error(
          `Node "${definition.name}" changed state tag; acquire a new typed handle with focused()`,
        )
      }
      return state as MatchedState<InferState<C>, M>
    },
    actions: journeyActions,
    expectFailure: checked(actions, "failure") as CheckedActions<InferActions<C>, "domain-error">,
    expectRefusal: checked(actions, "refusal") as CheckedActions<InferActions<C>, "refused">,
    allowCancellation: checked(actions, "cancellation") as CheckedActions<
      InferActions<C>,
      "completed" | "cancelled"
    >,
  }
}

export const createJourneyClient = <D extends ConsumerDefinition = ConsumerDefinition>(
  transport: JourneyTransport,
): JourneyClient<D> => ({
  back: async () => {
    const node = await transport.inspect("Navigation")
    const outcome = await actionOutcome(() => transport.dispatch(node.id, "GoBack"))
    if (outcome.status !== "completed") {
      throw new Error(`GoBack: ${outcome.status}`)
    }
    return outcome
  },
  node: async (definition) => {
    transport.validateDefinition?.(definition)
    return bindSnapshot(definition, await transport.inspect(definition.name), transport)
  },
  async focused(definition, match) {
    transport.validateDefinition?.(definition)
    await transport.wait(definition.name, wireMatch(match) as Json | undefined)
    const snapshot = await waitForMatch(transport, match, definition.name)
    if (snapshot.name !== definition.name) {
      throw new Error(`Expected focus on "${definition.name}", found "${snapshot.name}"`)
    }
    return bindSnapshot(definition, snapshot, transport, match)
  },
})

/** Subscribe before reading so a state change between inspection and waiting cannot be lost. */
const waitForMatch = async (
  transport: JourneyTransport,
  match: unknown,
  name: string,
): Promise<NodeSnapshot> => {
  if (match === undefined) {
    return transport.inspect()
  }
  return new Promise((resolve, reject) => {
    let reading = false
    let dirty = false
    let finished = false
    let unsubscribe = () => {}
    let poll: ReturnType<typeof setInterval> | undefined
    let lastState: unknown
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out matching state of "${name}"; last state: ${JSON.stringify(lastState)}`,
          ),
        ),
      transport.timeoutMs ?? 2_000,
    )
    const finish = (result: NodeSnapshot | Error) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      clearInterval(poll)
      unsubscribe()
      if (result instanceof Error) {
        reject(result)
      } else {
        resolve(result)
      }
    }
    const read = async () => {
      dirty = true
      if (reading || finished) {
        return
      }
      reading = true
      try {
        do {
          dirty = false
          const snapshot = await transport.inspect()
          lastState = snapshot.state
          if (snapshot.name === name && matchesState(snapshot.state, match)) {
            finish(snapshot)
          }
        } while (dirty && !finished)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      } finally {
        reading = false
      }
    }
    unsubscribe =
      transport.subscribe?.(() => {
        void read()
      }) ?? (() => {})
    if (transport.subscribe === undefined) {
      poll = setInterval(() => {
        void read()
      }, 10)
    }
    void read()
  })
}
