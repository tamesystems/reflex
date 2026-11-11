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
    } & M.ActionMapCheck<NoInfer<A>, C["Type"]>,
  ): M.Definition<This, A, M.Public<C["Encoded"]>, M.Requirements<A> | R, "screen"> & {
    readonly name: N
    readonly paramsType: This["paramsType"]
    readonly encodedParams: This["encodedParams"]
  }
  handler<I = undefined, O = void, E = never, R = never>(
    f: (input: I, ctx: M.EffectContext<C["Type"]>) => Effect.Effect<O, E, R>,
  ): typeof f
  when<K extends M.Tags<C["Type"]>>(
    tag: K,
  ): {
    handler<I = undefined, O = void, E = never, R = never>(
      f: (
        input: I,
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
    params?: F &
      M.JsonCheck<M.Public<Schema.Struct<F>["Encoded"]>, "Params must encode JSON; use jsonCodec">
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
    } & M.ActionMapCheck<NoInfer<A>, C["Type"]> &
      M.JsonCheck<M.Public<NoInfer<C["Encoded"]>>, "Effect state must encode JSON; use jsonCodec">,
  ): OneStep<N, C, A>
}
export declare function defineService<const N extends string, const C extends M.Codec, const A>(
  spec: {
    name: N
    state: C
    initial: () => C["Type"]
    actions: (action: M.PlainEffectActionBuilder<NoInfer<C["Type"]>>) => A
  } & M.ActionMapCheck<NoInfer<A>, C["Type"]> &
    M.JsonCheck<M.Public<NoInfer<C["Encoded"]>>, "Effect state must encode JSON; use jsonCodec">,
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
  } & M.ActionMapCheck<NoInfer<A>, C["Type"]> &
    M.JsonCheck<M.Public<NoInfer<C["Encoded"]>>, "Effect state must encode JSON; use jsonCodec">,
): M.Definition<never, A, M.Public<C["Encoded"]>, M.Requirements<A>, "fixture"> &
  Effect.Effect<M.StateAccess<C["Type"]>, never, FixtureService<N>> & { readonly name: N }
export interface Navigation<C extends Record<string, M.Contract>, K extends string> {
  push<const Target extends C[keyof C]>(
    to: Target,
    ...params: M.Args<M.Params<NoInfer<Target>>>
  ): M.NavigationCommand<K>
  readonly back: M.NavigationCommand<K>
  readonly stay: M.NavigationCommand<K>
  implement<const I extends readonly M.AnyDef[]>(
    implementations: I &
      M.Unique<I> &
      RoleCheck<I[number], "screen" | "store", "screens accepts only screens or stores"> &
      ([Exclude<keyof C, M.Names<I[number]>>] extends [never]
        ? unknown
        : M.Msg<`${Exclude<keyof C, M.Names<I[number]>> & string} requires one implementation`>),
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
): Navigation<C, K | M.Names<C[keyof C]>>
type Scenarios<S> = S extends M.ScenarioMap ? S : { default: M.Empty }
type Default<S, K> = K extends keyof Scenarios<S> ? K : keyof Scenarios<S>
type Screens<Nav, I> = Nav extends { screens: infer D }
  ? D
  : I extends readonly (infer D)[]
    ? D
    : never
type LayerOut<L> = L extends Layer.Layer<infer P, infer _E, infer _R> ? P : never
type DefReq<D> = D extends { requirements: infer R } ? R : never
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
type CrossRoleNames<S, V> = [Extract<M.Names<S>, M.Names<V>>] extends [never]
  ? unknown
  : M.Msg<`${Extract<M.Names<S>, M.Names<V>>} is declared more than once`>
type RoleCheck<D, Allowed, Message extends string> = [D] extends [{ role: Allowed }]
  ? unknown
  : M.Msg<Message>
type AmbientParams<D> = D extends unknown
  ? keyof M.Params<D> extends never
    ? unknown
    : M.Msg<"Ambient services must not require params">
  : never
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
    screens?: I &
      M.Unique<I> &
      RoleCheck<I[number], "screen" | "store", "screens accepts only screens or stores"> &
      RoleCheck<I[number], "screen" | "store", "screens accepts only screens or stores">
    services?: V &
      M.Unique<V> &
      RoleCheck<V[number], "service" | "store", "services accepts only services or stores"> &
      AmbientParams<V[number]>
    fixtures?: F
    scenarios: S &
      NoInfer<
        M.Coverage<
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
    CrossRoleNames<Screens<Nav, I>, V[number]> &
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
    screens?: I &
      M.Unique<I> &
      RoleCheck<I[number], "screen" | "store", "screens accepts only screens or stores"> &
      RoleCheck<I[number], "screen" | "store", "screens accepts only screens or stores">
    services?: V &
      M.Unique<V> &
      RoleCheck<V[number], "service" | "store", "services accepts only services or stores"> &
      AmbientParams<V[number]>
    scenarios?: never
    layer?: L
  } & NoInfer<
    M.Coverage<
      { default: M.Empty },
      DefReq<Screens<Nav, I>> | DefReq<V[number]>,
      L,
      never,
      Nav extends { navigator: infer NN } ? NN : never
    >["default"]
  > &
    M.Unique<[...I, ...V]> &
    CrossRoleNames<Screens<Nav, I>, V[number]> &
    (Nav extends undefined
      ? CheckNavigation<I[number] | V[number], N>
      : I extends readonly []
        ? unknown
        : M.Msg<"Choose navigation or screens, not both">),
): M.App<N, Screens<Nav, I>, V[number], { default: M.Empty }, "default", never, LayerOut<L>>
