import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import type * as M from "./model"
export type { StateAccess, EffectContext, NavigationCommand, NavigationRefused } from "./model"
export interface ScreenBase<N extends string, C extends M.Codec, F extends Schema.Struct.Fields>
  extends M.Contract {
  new (): object
  readonly name: N
  readonly state: C
  readonly paramsType: Schema.Struct<F>["Type"]
  readonly encodedParams: Schema.Struct<F>["Encoded"]
  implement<This extends M.Contract, const A, O = void, FE = never, R = never>(
    this: This,
    spec: {
      actions: (action: M.EffectActionBuilder<C["Type"]>) => A
      onFocus?: ((ctx: M.EffectContext<C["Type"]>) => Effect.Effect<O, FE, R>) &
        M.HasCommand<O> &
        ([Exclude<FE, M.StateChanged>] extends [never]
          ? unknown
          : M.Msg<"Handle onFocus failures into state">)
    },
  ): M.Definition<This, A, M.Public<C["Encoded"]>, M.Requirements<A> | R, "screen"> & {
    readonly name: N
    readonly paramsType: This["paramsType"]
    readonly encodedParams: This["encodedParams"]
  }
  handler<O, E, R>(f: (ctx: M.EffectContext<C["Type"]>) => Effect.Effect<O, E, R>): typeof f
  when<K extends M.Tags<C["Type"]>>(
    tag: K,
  ): {
    handler<O, E, R>(
      f: (
        ctx: M.EffectContext<M.Narrow<C["Type"], K>, C["Type"], M.StateChanged>,
      ) => Effect.Effect<O, E, R>,
    ): typeof f
  }
}
export declare function Screen<
  const N extends string,
  const C extends M.Codec,
  const F extends Schema.Struct.Fields = M.Empty,
>(
  name: N,
  spec: {
    state: C
    params?: F
    initial: (params: Schema.Struct<F>["Type"]) => C["Type"]
  } & M.JsonCheck<M.Public<NoInfer<C["Encoded"]>>, "Effect state must encode JSON; use jsonCodec">,
): ScreenBase<N, C, F>
export interface OneStep<N extends string, C extends M.Codec, A> extends M.Contract {
  readonly name: N
  readonly state: C
  readonly publicState: M.Public<C["Encoded"]>
  readonly actions: A
  readonly requirements: M.Requirements<A>
  readonly role: "screen"
  readonly paramsType: M.Empty
  readonly encodedParams: M.Empty
  readonly contract: OneStep<N, C, A>
}
export declare namespace Screen {
  function define<const N extends string, const C extends M.Codec, const A>(
    name: N,
    spec: {
      state: C
      initial: () => C["Type"]
      actions: (action: M.EffectActionBuilder<NoInfer<C["Type"]>>) => A
    } & M.JsonCheck<
      M.Public<NoInfer<C["Encoded"]>>,
      "Effect state must encode JSON; use jsonCodec"
    >,
  ): OneStep<N, C, A>
}
export declare function defineService<const N extends string, const C extends M.Codec, const A>(
  spec: {
    name: N
    state: C
    initial: () => C["Type"]
    actions: (action: M.PlainEffectActionBuilder<NoInfer<C["Type"]>>) => A
  } & M.JsonCheck<M.Public<NoInfer<C["Encoded"]>>, "Effect state must encode JSON; use jsonCodec">,
): M.Definition<never, A, M.Public<C["Encoded"]>, M.Requirements<A>, "service"> & {
  readonly name: N
}
export interface FixtureService<N extends string> {
  readonly fixture: N
}
export declare function defineFixture<const N extends string, const C extends M.Codec, const A>(
  spec: {
    name: N
    state: C
    initial: () => C["Type"]
    actions: (action: M.PlainEffectActionBuilder<NoInfer<C["Type"]>>) => A
  } & M.JsonCheck<M.Public<NoInfer<C["Encoded"]>>, "Effect state must encode JSON; use jsonCodec">,
): M.Definition<never, A, M.Public<C["Encoded"]>, M.Requirements<A>, "fixture"> &
  Effect.Effect<M.StateAccess<C["Type"]>, never, FixtureService<N>> & { readonly name: N }
export interface Navigation<C extends Record<string, M.Contract>, K extends string> {
  push(...args: M.RouteArgs<C[keyof C]>): M.NavigationCommand<K>
  readonly back: M.NavigationCommand<K>
  readonly stay: M.NavigationCommand<K>
  implement<const I extends readonly M.AnyDef[]>(
    implementations: I &
      M.Unique<I> &
      ([Exclude<C[keyof C], M.Contracts<I[number]>>] extends [never]
        ? unknown
        : M.Msg<`${M.Names<Exclude<C[keyof C], M.Contracts<I[number]>>>} requires one implementation`>),
    options: { initial: M.Initial<C[keyof C]> },
  ): { readonly screens: I[number]; readonly navigator: M.Navigator<K> }
}
export declare function defineNavigation<
  const C extends Record<string, M.Contract>,
  const K extends string = "default",
>(
  contracts: C & {
    [P in keyof C]: P extends C[P]["name"]
      ? unknown
      : M.Msg<`Navigation key ${P & string} must match contract name ${C[P]["name"]}`>
  },
  options?: { key?: K },
): Navigation<C, K>
type Scenarios<S> = S extends M.ScenarioMap ? S : { default: M.Empty }
type Default<S, K> = K extends keyof Scenarios<S> ? K : keyof Scenarios<S>
type Screens<Nav, I> = Nav extends { screens: infer D }
  ? D
  : I extends readonly (infer D)[]
    ? D
    : never
type LayerOut<L> = L extends Layer.Layer<infer P, infer _E, infer _R> ? P : never
type LayerIn<L> = L extends Layer.Layer<infer _P, infer _E, infer R> ? R : never
type LayerOf<S> = S extends { layer: infer L } ? L : never
type FixtureList<S, F> = S extends { fixtures: readonly (infer D)[] } ? D : F
type DefReq<D> = D extends { requirements: infer R } ? R : never
type FixtureAccess<F> = F extends { name: infer N extends string } ? FixtureService<N> : never
type Coverage<Sc, Req, Common, F, Nav> = {
  [K in keyof Sc]: [
    Exclude<
      Req | DefReq<FixtureList<Sc[K], F>> | LayerIn<LayerOf<Sc[K]>>,
      LayerOut<LayerOf<Sc[K]>> | LayerOut<Common> | FixtureAccess<FixtureList<Sc[K], F>> | Nav
    >,
  ] extends [never]
    ? unknown
    : {
        readonly [P in `Scenario '${K & string}' must provide`]: Exclude<
          Req | DefReq<FixtureList<Sc[K], F>> | LayerIn<LayerOf<Sc[K]>>,
          LayerOut<LayerOf<Sc[K]>> | LayerOut<Common> | FixtureAccess<FixtureList<Sc[K], F>> | Nav
        >
      }
}
type NavigationIssue<D, N extends string> = D extends { actions: infer A }
  ? {
      [K in keyof A]: A[K] extends { requirements: infer R }
        ? [Extract<R, M.Navigator<string>>] extends [never]
          ? never
          : `Action ${K & string} of app '${N}' requires a navigator`
        : never
    }[keyof A]
  : never
type CheckNavigation<D, N extends string> = [NavigationIssue<D, N>] extends [never]
  ? unknown
  : M.Msg<NavigationIssue<D, N>>
type IsUnion<T, C = T> = T extends C ? ([C] extends [T] ? false : true) : never
export declare function defineApp<
  const N extends string,
  const S extends M.ScenarioMap,
  const K extends keyof S,
  Nav = undefined,
  const I extends readonly M.AnyDef[] = readonly [],
  const V extends readonly M.AnyDef[] = readonly [],
  const F extends readonly M.AnyDef[] = readonly [],
  L = undefined,
>(
  spec: {
    name: N
    navigation?: Nav
    screens?: I & M.Unique<I>
    services?: V & M.Unique<V>
    fixtures?: F
    scenarios?: S &
      NoInfer<
        Coverage<
          S,
          DefReq<Screens<Nav, I>> | DefReq<V[number]>,
          L,
          F[number],
          Nav extends { navigator: infer NN } ? NN : never
        >
      >
    defaultScenario?: K & keyof NoInfer<S>
    layer?: L
  } & (IsUnion<keyof S> extends true ? { defaultScenario: K } : unknown) &
    M.Unique<[...I, ...V]> &
    (Nav extends undefined
      ? CheckNavigation<I[number] | V[number], N>
      : I extends readonly []
        ? unknown
        : M.Msg<"Choose navigation or screens, not both">),
): M.App<N, Screens<Nav, I>, V[number], Scenarios<S>, Default<S, K>, F[number], LayerOut<L>>
export declare function defineApp<
  const N extends string,
  Nav = undefined,
  const I extends readonly M.AnyDef[] = readonly [],
  const V extends readonly M.AnyDef[] = readonly [],
  L = undefined,
>(
  spec: {
    name: N
    navigation?: Nav
    screens?: I & M.Unique<I>
    services?: V & M.Unique<V>
    scenarios?: never
    layer?: L
  } & NoInfer<
    Coverage<
      { default: M.Empty },
      DefReq<Screens<Nav, I>> | DefReq<V[number]>,
      L,
      never,
      Nav extends { navigator: infer NN } ? NN : never
    >["default"]
  > &
    M.Unique<[...I, ...V]> &
    (Nav extends undefined
      ? CheckNavigation<I[number] | V[number], N>
      : I extends readonly []
        ? unknown
        : M.Msg<"Choose navigation or screens, not both">),
): M.App<N, Screens<Nav, I>, V[number], { default: M.Empty }, "default", never, LayerOut<L>>
