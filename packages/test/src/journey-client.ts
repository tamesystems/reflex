import type { Json, NodeId, NodeSnapshot, OperationInfo } from "@reflex/protocol"
import {
  actionOutcome,
  type ActionOutcome,
  type ConsumerDefinition,
} from "@reflex/runtime/internal"

export type JourneyClientFor<H> = JourneyClient<
  H extends { readonly nodes: infer N } ? Extract<N[keyof N], ConsumerDefinition> : never
>

export type StateOf<D> = D extends ConsumerDefinition<infer S, unknown> ? S : never
export type ActionsOf<D> = D extends ConsumerDefinition<unknown, infer A> ? A : never
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
  ? readonly StateMatch<Item>[] | Includes<StateMatch<Item>>
  : S extends object
    ? { readonly [K in keyof S]?: StateMatch<S[K]> }
    : S
export type MatchedState<S, M> = M extends { readonly _tag: infer Tag }
  ? Extract<S, { readonly _tag: Tag }>
  : S
export interface JourneyNode<D, M> {
  /** Read this exact node again, rather than retaining a captured snapshot. */
  state(): Promise<MatchedState<StateOf<D>, M>>
  readonly actions: ActionsOf<D>
  readonly expectFailure: ActionsOf<D>
  readonly allowCancellation: ActionsOf<D>
  readonly id: NodeId
}

export interface JourneyTransport {
  inspect(name?: string, nodeId?: NodeId): Promise<NodeSnapshot>
  wait(name: string, match?: Json): Promise<void>
  dispatch(nodeId: NodeId, action: string, input?: Json): Promise<OperationInfo>
}

/** One typed client for loopback tests, RPC and a device's CLI harness. */
export interface JourneyClient<D extends ConsumerDefinition = ConsumerDefinition> {
  back(): Promise<ActionOutcome>
  node<C extends D>(definition: C): Promise<JourneyNode<C, unknown>>
  focused<C extends D, const M extends StateMatch<StateOf<C>> = StateMatch<StateOf<C>>>(
    definition: C,
    match?: M,
  ): Promise<JourneyNode<C, M>>
}

const checked = <A>(actions: A, mode: "success" | "failure" | "cancellation"): A =>
  Object.fromEntries(
    Object.entries(
      actions as Record<string, (...args: unknown[]) => Promise<ActionOutcome<unknown>>>,
    ).map(([name, run]) => [
      name,
      async (...args: unknown[]) => {
        const outcome = await run(...args)
        const accepted =
          mode === "failure"
            ? outcome.status === "domain-error" || outcome.status === "refused"
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
): JourneyNode<C, M> => {
  const actions = definition["~reflex"].actions((action, input) =>
    transport.dispatch(snapshot.id, action, input),
  ) as ActionsOf<C>
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
        typeof snapshot.state === "object" &&
        snapshot.state !== null &&
        "_tag" in snapshot.state &&
        (typeof state !== "object" ||
          state === null ||
          !("_tag" in state) ||
          state._tag !== snapshot.state._tag)
      ) {
        throw new Error(
          `Node "${definition.name}" changed state tag; acquire a new typed handle with focused()`,
        )
      }
      return state as MatchedState<StateOf<C>, M>
    },
    actions: checked(actions, "success"),
    expectFailure: checked(actions, "failure"),
    allowCancellation: checked(actions, "cancellation"),
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
  node: async (definition) =>
    bindSnapshot(definition, await transport.inspect(definition.name), transport),
  async focused(definition, match) {
    await transport.wait(definition.name, wireMatch(match) as Json | undefined)
    let snapshot = await transport.inspect()
    const deadline = Date.now() + 2_000
    while (match !== undefined && !matchesState(snapshot.state, match)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out matching state of "${definition.name}"`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
      snapshot = await transport.inspect()
    }
    if (snapshot.name !== definition.name) {
      throw new Error(`Expected focus on "${definition.name}", found "${snapshot.name}"`)
    }
    return bindSnapshot(definition, snapshot, transport)
  },
})
