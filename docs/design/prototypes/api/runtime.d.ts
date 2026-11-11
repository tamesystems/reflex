import type * as M from "./model"
export type { ActionOutcome, StateOf, JourneyClient, StateChanged } from "./model"
export interface Store {
  getState(): unknown
  subscribe(listener: () => void): () => void
}
type Context<T, E> = { readonly store: T; readonly signal: AbortSignal } & (E extends undefined
  ? M.Empty
  : { fail(error: M.Dec<E>): never })
export type StoreActionBuilder<T extends Store> = <
  I extends M.StandardValidator | undefined = undefined,
  E extends M.StandardValidator | undefined = undefined,
  O = void,
  W = E extends undefined ? never : M.Enc<E>,
>(
  spec: {
    input?: I & M.JsonCheck<M.Enc<I>, "Input must encode JSON; use jsonCodec">
    error?: E
    description?: string
    available?: (s: M.StateOf<NoInfer<T>>) => true | string
    projectError?: (error: M.Dec<NoInfer<E>>) => W
    handler: ((i: NoInfer<M.Dec<I>>, ctx: Context<T, E>) => O) &
      ([Extract<Awaited<O>, M.NavigationCommand>] extends [never]
        ? unknown
        : M.Msg<"Store handlers cannot return NavigationCommand">)
  } & ([M.Dec<E>] extends [M.Enc<E>]
    ? unknown
    : { projectError: (error: M.Dec<NoInfer<E>>) => W }) &
    (E extends undefined
      ? unknown
      : M.JsonCheck<W, "Store error must be JSON; provide projectError">),
) => M.Action<M.Enc<I>, W, never, M.StateOf<T>>
export declare function defineStoreNode<
  const N extends string,
  Factory extends (params: M.Dec<P>) => Store,
  W = M.StateOf<ReturnType<Factory>>,
  const A = unknown,
  P extends M.StandardValidator | undefined = undefined,
>(
  spec: {
    name: N
    params?: P
    store: Factory
    project?: (state: M.StateOf<ReturnType<NoInfer<Factory>>>) => W
    actions: (action: StoreActionBuilder<ReturnType<NoInfer<Factory>>>) => A
  } & M.ActionMapCheck<NoInfer<A>, M.StateOf<ReturnType<Factory>>>,
): M.Definition<never, A, W, never, "store"> & {
  readonly name: N
  readonly contract: M.Definition<never, A, W, never, "store"> & { readonly name: N }
  readonly paramsType: P extends undefined ? M.Empty : M.Dec<P>
  readonly encodedParams: P extends undefined ? M.Empty : M.Enc<P>
  withStore(factory: (params: P extends undefined ? M.Empty : M.Dec<P>) => ReturnType<Factory>): {
    readonly definition: { readonly name: N }
    readonly factory: typeof factory
  }
}
export declare function defineStoreApp<
  const N extends string,
  const D extends readonly M.AnyDef[] = readonly [],
  const V extends readonly M.AnyDef[] = readonly [],
>(
  spec: {
    name: N
    screens?: D & M.Unique<D>
    services?: V & M.Unique<V> & AmbientParams<V[number]>
  } & M.Unique<[...D, ...V]> &
    StoreCheck<D[number] | V[number]>,
): M.App<N, D[number], V[number], { default: M.Empty }, "default">

type AmbientParams<D> = D extends unknown
  ? keyof M.Params<D> extends never
    ? unknown
    : M.Msg<"Ambient services must not require params">
  : never
type StoreIssue<D> = D extends { name: infer N extends string; role: "store" }
  ? [M.State<D>] extends [M.JsonShape<M.State<D>>]
    ? [M.Public<M.URLParams<D>>] extends [M.JsonShape<M.Public<M.URLParams<D>>>]
      ? never
      : "Params must encode JSON; use jsonCodec"
    : `Store ${N} state must be JSON; provide project`
  : "defineStoreApp accepts only stores"
type StoreCheck<D> = [StoreIssue<D>] extends [never] ? unknown : M.Msg<StoreIssue<D>>

/** Adds a JSON Schema description for validators whose schema cannot be introspected. */
export declare function standardInput<V extends M.StandardValidator>(
  validator: V,
  jsonSchema: object,
): V
