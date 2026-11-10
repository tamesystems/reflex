import type { Json, NodeId, NodeSnapshot, OperationInfo } from "@reflex/protocol"
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
export const includes = <const M>(...items: readonly M[]): Includes<M> => ({ [inclusion]: items })
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
export type MatchedState<S, M> = M extends { readonly _tag: infer Tag }
  ? Extract<S, { readonly _tag: Tag }>
  : S
export interface JourneyNode<D, M> {
  /** Read this exact node again, rather than retaining a captured snapshot. */
  state(): Promise<MatchedState<InferState<D>, M>>
  readonly actions: CheckedActions<InferActions<D>, "completed">
  readonly expectFailure: CheckedActions<InferActions<D>, "domain-error">
  readonly expectRefusal: CheckedActions<InferActions<D>, "refused">
  readonly allowCancellation: CheckedActions<InferActions<D>, "completed" | "cancelled">
  readonly id: NodeId
}

export interface JourneyTransport {
  inspect(name?: string, nodeId?: NodeId): Promise<NodeSnapshot>
  wait(name: string, match?: Json): Promise<void>
  dispatch(nodeId: NodeId, action: string, input?: Json): Promise<OperationInfo>
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

const checked = <A>(actions: A, mode: "success" | "failure" | "refusal" | "cancellation"): A =>
  Object.fromEntries(
    Object.entries(
      actions as Record<string, (...args: unknown[]) => Promise<ActionOutcome<unknown>>>,
    ).map(([name, run]) => [
      name,
      async (...args: unknown[]) => {
        const outcome = await run(...args)
        const accepted =
          mode === "failure"
            ? outcome.status === "domain-error"
            : mode === "refusal"
              ? outcome.status === "refused"
              : outcome.status === "completed" ||
                (mode === "cancellation" && outcome.status === "cancelled")
        if (!accepted) {
          throw new Error(
            `${name}: expected ${mode}, received ${outcome.status}${"error" in outcome ? ` (${outcome.error.tag}: ${outcome.error.message})` : "reason" in outcome ? ` (${outcome.reason})` : ""}`,
          )
        }
        return outcome
      },
    ]),
  ) as A

const bindSnapshot = <C extends ConsumerDefinition, M>(
  definition: C,
  snapshot: NodeSnapshot,
  transport: JourneyTransport,
  match?: unknown,
): JourneyNode<C, M> => {
  const actions = definition["~reflex"].actions((action, input) =>
    transport.dispatch(snapshot.id, action, input),
  ) as InferActions<C>
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
        "_tag" in match &&
        (typeof state !== "object" ||
          state === null ||
          !("_tag" in state) ||
          state._tag !== match._tag)
      ) {
        throw new Error(
          `Node "${definition.name}" changed state tag; acquire a new typed handle with focused()`,
        )
      }
      return state as MatchedState<InferState<C>, M>
    },
    actions: checked(actions, "success") as CheckedActions<InferActions<C>, "completed">,
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
    const timer = setTimeout(
      () => finish(new Error(`Timed out matching state of "${name}"`)),
      2_000,
    )
    const finish = (result: NodeSnapshot | Error) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
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
    void read()
  })
}
