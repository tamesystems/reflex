import type { Json, NodeId, NodeSnapshot, OperationInfo } from "@reflex/protocol"
import {
  actionOutcome,
  type ActionOutcome,
  type ConsumerDefinition,
} from "@reflex/runtime/internal"

export type JourneyClientFor<H> = JourneyClient<
  H extends { readonly nodes: infer N }
    ? Extract<N[keyof N], ConsumerDefinition>
    : ConsumerDefinition
>

export type StateOf<D> = D extends ConsumerDefinition<infer S, unknown> ? S : never
export type ActionsOf<D> = D extends ConsumerDefinition<unknown, infer A> ? A : never
export type StateMatch<S> = S extends readonly (infer Item)[]
  ? readonly StateMatch<Item>[]
  : S extends object
    ? { readonly [K in keyof S]?: StateMatch<S[K]> }
    : S
export type MatchedState<S, M> = M extends { readonly _tag: infer Tag }
  ? Extract<S, { readonly _tag: Tag }>
  : S
export interface JourneyNode<D, M> {
  /** A snapshot at focused(); subsequent actions do not change this captured value. */
  readonly state: MatchedState<StateOf<D>, M>
  readonly actions: ActionsOf<D>
  readonly id: NodeId
}

export interface JourneyTransport {
  inspect(name?: string): Promise<NodeSnapshot>
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

const bindSnapshot = <C extends ConsumerDefinition, M>(
  definition: C,
  snapshot: NodeSnapshot,
  transport: JourneyTransport,
): JourneyNode<C, M> => ({
  id: snapshot.id,
  state: definition.client.state(snapshot.state) as MatchedState<StateOf<C>, M>,
  actions: definition.client.actions((action, input) =>
    transport.dispatch(snapshot.id, action, input),
  ) as ActionsOf<C>,
})

export const createJourneyClient = <D extends ConsumerDefinition = ConsumerDefinition>(
  transport: JourneyTransport,
): JourneyClient<D> => ({
  back: async () => {
    const node = await transport.inspect("Navigation")
    return actionOutcome(() => transport.dispatch(node.id, "GoBack"))
  },
  node: async (definition) =>
    bindSnapshot(definition, await transport.inspect(definition.name), transport),
  async focused(definition, match) {
    await transport.wait(definition.name, match as Json | undefined)
    const snapshot = await transport.inspect()
    if (snapshot.name !== definition.name) {
      throw new Error(`Expected focus on "${definition.name}", found "${snapshot.name}"`)
    }
    return bindSnapshot(definition, snapshot, transport)
  },
})
