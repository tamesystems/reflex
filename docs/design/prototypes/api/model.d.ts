import type * as Effect from "effect/Effect"
import type * as Duration from "effect/Duration"
import type * as Schema from "effect/Schema"
import type * as Redacted from "effect/Redacted"
import type * as Layer from "effect/Layer"
export type Msg<S extends string> = { readonly [K in S]: never }
export type Check<B, S extends string> = B extends true ? unknown : Msg<S>
export interface StandardValidator {
  readonly "~standard": {
    readonly types?: { readonly input: unknown; readonly output: unknown } | undefined
    validate(value: unknown): unknown
  }
}
export type Codec = Schema.Codec<unknown, unknown, never, never>
export type Dec<C> = C extends { readonly Type: infer T }
  ? T
  : C extends StandardValidator
    ? NonNullable<C["~standard"]["types"]>["output"]
    : undefined
export type Enc<C> = C extends { readonly Encoded: infer T }
  ? T
  : C extends StandardValidator
    ? NonNullable<C["~standard"]["types"]>["input"]
    : undefined
export type Public<T> =
  T extends Redacted.Redacted<unknown>
    ? "<redacted>"
    : T extends (...args: never[]) => unknown
      ? T
      : T extends readonly unknown[]
        ? { readonly [K in keyof T]: Public<T[K]> }
        : T extends object
          ? { readonly [K in keyof T]: Public<T[K]> }
          : T
export type JsonShape<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends string | number | boolean | null
    ? T
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: JsonShape<T[K]> }
      : T extends object
        ? {
            readonly [K in keyof T]: T[K] extends (...args: never[]) => unknown
              ? never
              : JsonShape<T[K]>
          }
        : never
export type JsonCheck<T, M extends string> = [T] extends [JsonShape<T>] ? unknown : Msg<M>
export interface Contract {
  new (): object
  readonly name: string
  readonly state: { readonly Type: unknown }
  readonly paramsType: unknown
  readonly encodedParams: unknown
}
export interface Definition<
  C = unknown,
  A = unknown,
  S = unknown,
  R = never,
  Role extends string = string,
> {
  readonly name: string
  readonly contract: C
  readonly actions: A
  readonly publicState: S
  readonly requirements: R
  readonly role: Role
  readonly paramsType: unknown
  readonly encodedParams: unknown
}
export type AnyDef = Definition<unknown, unknown, unknown, unknown>
export type StateOf<T> = T extends { getState(): infer S } ? S : never
export type Actions<D> = D extends { actions: infer A } ? A : never
export type State<D> = D extends { publicState: infer S } ? Public<S> : never
export type Params<C> = C extends { paramsType: infer P } ? P : never
export type URLParams<C> = C extends { encodedParams: infer P } ? P : never
export type Empty = Record<never, never>
export type Args<P> = keyof P extends never ? [] : [params: P]
export type RouteArgs<C, URL extends boolean = false> = C extends unknown
  ? [to: C, ...params: Args<URL extends true ? URLParams<C> : Params<C>>]
  : never
export type Initial<C> = C extends unknown
  ? keyof Params<C> extends never
    ? C
    : { screen: C; params: Params<C> }
  : never
declare const terminal: unique symbol
export interface NavigationCommand<K extends string = string> {
  readonly [terminal]: K
  readonly kind: "navigation"
}
export interface Navigator<K extends string> {
  readonly navigator: K
}
export interface NavigationRefused {
  readonly _tag: "NavigationRefused"
  readonly reason: string
}
export interface StateChanged {
  readonly _tag: "StateChanged"
}
export type Tags<S> = S extends { _tag: infer K extends string } ? K : never
export type Narrow<S, K> = Extract<S, { _tag: K }>
export interface StateAccess<S, All = S, Guard = never> {
  readonly get: Effect.Effect<S>
  set(value: All): Effect.Effect<void, Guard>
  update(f: (s: S) => All): Effect.Effect<void, Guard>
  when<K extends Tags<All>>(tag: K): StateAccess<Narrow<All, K>, All, StateChanged>
}
export interface EffectContext<S, All = S, G = never> {
  readonly state: StateAccess<S, All, G>
}
export interface Action<I = undefined, E = never, R = never> {
  readonly input: I
  readonly error: E
  readonly requirements: R
}
export type HasCommand<O> = [Extract<O, NavigationCommand>] extends [never]
  ? unknown
  : Msg<"Use action.navigates for actions that navigate">
export type ErrorCheck<E, C> = [Exclude<E, StateChanged>] extends [
  C extends undefined ? never : Dec<C>,
]
  ? unknown
  : Msg<"Declare action failures with error:">
export type NavRequirement<O> = O extends NavigationCommand<infer K> ? Navigator<K> : never
export interface PlainEffectActionBuilder<S, All = S, G = never> {
  <
    I extends Codec | undefined = undefined,
    E extends Codec | undefined = undefined,
    O = void,
    HE = never,
    R = never,
  >(spec: {
    input?: I
    error?: E
    description?: string
    available?: (s: NoInfer<S>) => true | string
    handler: ((i: NoInfer<Dec<I>>, c: EffectContext<S, All, G>) => Effect.Effect<O, HE, R>) &
      HasCommand<O> &
      ErrorCheck<HE, E>
  }): Action<Enc<I>, E extends undefined ? never : Enc<E>, R>
  when<K extends Tags<S>>(tag: K): PlainEffectActionBuilder<Narrow<S, K>, All, StateChanged>
  reduce<I extends Codec | undefined = undefined>(spec: {
    input?: I
    description?: string
    available?: (s: S) => true | string
    reducer: (i: NoInfer<Dec<I>>, s: S) => All
  }): Action<Enc<I>>
}
export interface EffectActionBuilder<S, All = S, G = never> {
  <
    I extends Codec | undefined = undefined,
    E extends Codec | undefined = undefined,
    O = void,
    HE = never,
    R = never,
  >(spec: {
    input?: I
    error?: E
    description?: string
    available?: (s: NoInfer<S>) => true | string
    handler: ((i: NoInfer<Dec<I>>, c: EffectContext<S, All, G>) => Effect.Effect<O, HE, R>) &
      HasCommand<O> &
      ErrorCheck<HE, E>
  }): Action<Enc<I>, E extends undefined ? never : Enc<E>, R>
  navigates<
    I extends Codec | undefined = undefined,
    E extends Codec | undefined = undefined,
    O extends NavigationCommand = NavigationCommand,
    HE = never,
    R = never,
    RO = void,
    RR = never,
  >(spec: {
    input?: I
    error?: E
    description?: string
    available?: (s: NoInfer<S>) => true | string
    handler: ((i: NoInfer<Dec<I>>, c: EffectContext<S, All, G>) => Effect.Effect<O, HE, R>) &
      ErrorCheck<HE, E>
    onRefused?: ((
      error: NavigationRefused,
      c: EffectContext<S, All>,
    ) => Effect.Effect<RO, StateChanged, RR>) &
      // biome-ignore lint/suspicious/noConfusingVoidType: Effect void success is distinct from undefined.
      ([RO] extends [void] ? unknown : Msg<"Navigation refusal recovery must return void">)
  }): Action<Enc<I>, E extends undefined ? never : Enc<E>, R | RR | NavRequirement<O>>
  when<K extends Tags<S>>(tag: K): EffectActionBuilder<Narrow<S, K>, All, StateChanged>
  reduce<I extends Codec | undefined = undefined>(spec: {
    input?: I
    description?: string
    available?: (s: S) => true | string
    reducer: (i: NoInfer<Dec<I>>, s: S) => All
  }): Action<Enc<I>>
}
export type Requirements<A> = A[keyof A] extends infer V
  ? V extends { requirements: infer R }
    ? R
    : never
  : never
export type Names<D> = D extends { name: infer N extends string } ? N : never
export type Contracts<D> = D extends { role: "store" }
  ? D
  : D extends { contract: infer C }
    ? C
    : never
export type DefinitionMap<D> = { [Item in D as Names<Item>]: Item }
export type Selected<D, C extends { readonly name: string }> = DefinitionMap<D>[C["name"] &
  keyof DefinitionMap<D>]
export type SelectedFromTable<T, C extends { readonly name: string }> = T[C["name"] & keyof T]
export type MemberFromTable<T, C extends { readonly name: string }, N extends string> = Member<
  C,
  Contracts<SelectedFromTable<T, C>>,
  N,
  "screen"
>
export type ScreenMember<D, C extends { readonly name: string }, N extends string> = Member<
  C,
  Contracts<Selected<D, C>>,
  N,
  "screen"
>
export type ContractArg<C> = C extends abstract new (
  ...args: never[]
) => infer I
  ? { readonly prototype: I }
  : C
type IdentityOf<T> = T extends abstract new (...args: never[]) => infer I ? I : T
export type Member<
  C extends { readonly name: string },
  Allowed,
  N extends string,
  Role extends string,
> = [IdentityOf<C>] extends [IdentityOf<Allowed>]
  ? unknown
  : C["name"] extends Names<Allowed>
    ? Msg<`This ${C["name"]} is a different contract from app '${N}''s ${C["name"]}`>
    : Msg<`${C["name"]} is not a ${Role} of app '${N}'`>
type NameTuple<T extends readonly unknown[]> = { [K in keyof T]: Names<T[K]> }
type UniqueNames<T extends readonly string[], Seen extends string = never> = T extends readonly [
  infer H extends string,
  ...infer Tail extends string[],
]
  ? H extends Seen
    ? Msg<`${H} is declared more than once`>
    : UniqueNames<Tail, Seen | H>
  : unknown
export type Unique<T extends readonly unknown[]> = UniqueNames<NameTuple<T>>
export interface Scenario {
  readonly layer?: unknown
  readonly fixtures?: readonly AnyDef[]
  readonly virtualTime?: boolean
  readonly description?: string
}
export type ScenarioMap = Record<string, Scenario>
type LayerOutput<L> = L extends Layer.Layer<infer P, infer _E, infer _R> ? P : never
type LayerInput<L> = L extends Layer.Layer<infer _P, infer _E, infer R> ? R : never
type ScenarioLayer<S> = S extends { layer: infer L } ? L : never
type FixtureOf<S, F> = S extends { fixtures: readonly (infer D)[] } ? D : F
type DefinitionReq<D> = D extends { requirements: infer R } ? R : never
type FixtureAccess<F> = F extends { name: infer N extends string } ? { readonly fixture: N } : never
export type Normalize<Sc, F> = {
  [K in keyof Sc]: Sc[K] & { readonly fixtures: readonly FixtureOf<Sc[K], F>[] }
}
export type ScenarioCoverage<Sc, D, V, F, Common = never> = {
  [K in keyof Sc]: [
    Exclude<
      | DefinitionReq<D>
      | DefinitionReq<V>
      | DefinitionReq<FixtureOf<Sc[K], F>>
      | LayerInput<ScenarioLayer<Sc[K]>>,
      | LayerOutput<ScenarioLayer<Sc[K]>>
      | Common
      | FixtureAccess<FixtureOf<Sc[K], F>>
      | Navigator<string>
    >,
  ] extends [never]
    ? unknown
    : {
        readonly [P in `Scenario '${K & string}' must provide`]: Exclude<
          | DefinitionReq<D>
          | DefinitionReq<V>
          | DefinitionReq<FixtureOf<Sc[K], F>>
          | LayerInput<ScenarioLayer<Sc[K]>>,
          | LayerOutput<ScenarioLayer<Sc[K]>>
          | Common
          | FixtureAccess<FixtureOf<Sc[K], F>>
          | Navigator<string>
        >
      }
}
type FixtureDefault<F, FF> = FF extends readonly (infer D)[] ? D : F
export interface App<
  N extends string = string,
  D = unknown,
  V = unknown,
  Sc extends ScenarioMap = ScenarioMap,
  Default extends keyof Sc = keyof Sc,
  F = never,
  Common = never,
> {
  readonly name: N
  readonly screens: D
  readonly services: V
  readonly scenarios: Sc
  readonly defaultScenario: Default
  readonly fixtures: F
  readonly provided: Common
  withScenarios<
    const Extra extends ScenarioMap,
    const K extends string,
    const FF extends readonly AnyDef[] | undefined = undefined,
  >(
    extra: Extra & {
      [P in keyof Extra & keyof Sc]: Msg<`Scenario ${P & string} already exists; choose a new name`>
    } & NoInfer<ScenarioCoverage<Extra, D, V, FixtureDefault<F, FF>, Common>>,
    options: { defaultScenario: K; fixtures?: FF } & ([K] extends [keyof Sc | keyof NoInfer<Extra>]
      ? unknown
      : Msg<"withScenarios defaultScenario must exist">),
  ): App<
    N,
    D,
    V,
    Normalize<Sc, F> & Normalize<Extra, FixtureDefault<F, FF>>,
    K & keyof (Sc & Extra),
    FixtureDefault<F, FF>,
    Common
  >
  withScenarios<const Extra extends ScenarioMap>(
    extra: Extra & {
      [P in keyof Extra & keyof Sc]: Msg<`Scenario ${P & string} already exists; choose a new name`>
    } & NoInfer<ScenarioCoverage<Extra, D, V, F, Common>>,
  ): App<N, D, V, Normalize<Sc, F> & Normalize<Extra, F>, Default, F, Common>
}
export interface AnyApp {
  readonly name: string
  readonly screens: unknown
  readonly services: unknown
  readonly scenarios: ScenarioMap
  readonly defaultScenario: string
  readonly fixtures: unknown
  readonly provided: unknown
}
export type ScNames<A extends AnyApp> = keyof A["scenarios"] & string
export type DefaultOf<A extends AnyApp> = A["defaultScenario"] & ScNames<A>
export type Fixtures<A extends AnyApp, K extends ScNames<A>> = {
  [P in K]: A["scenarios"][P] extends { fixtures: readonly (infer F)[] } ? F : A["fixtures"]
}[K]
export type CommonFixtures<A extends AnyApp, K extends ScNames<A>> =
  Fixtures<A, K> extends infer F
    ? F extends unknown
      ? { [P in K]: F extends Fixtures<A, P> ? true : false }[K] extends true
        ? F
        : never
      : never
    : never
export type SessionMember<
  A extends AnyApp,
  K extends ScNames<A>,
  D extends { readonly name: string },
> = Member<D, A["services"] | CommonFixtures<A, K>, A["name"], "fixture of this scenario">
export type InputArgs<I> = [I] extends [undefined] ? [] : [input: I]
export type ActionOutcome<E = unknown> =
  | { status: "completed" }
  | { status: "error"; error: E }
  | { status: "refused"; reason: string }
  | { status: "cancelled" }
  | { status: "defect"; message: string }
export type ActionViews<A> = {
  [K in keyof A]: A[K] extends Action<infer I, infer E, unknown>
    ? {
        run(...args: InputArgs<I>): Promise<ActionOutcome<E>>
        available: boolean
        pending: boolean
        reason: string | null
      }
    : never
}
export type ReadyNodeView<D> = {
  readonly status: "ready"
  readonly state: State<D>
  readonly actions: ActionViews<Actions<D>>
}
export type NodeView<D> =
  | { readonly status: "pending"; readonly state: null; readonly actions: null }
  | {
      readonly status: "error"
      readonly state: null
      readonly actions: null
      readonly error: Error
      retry(): Promise<void>
    }
  | ReadyNodeView<D>
declare const includesId: unique symbol
export interface Includes<E> {
  readonly [includesId]: E
}
export type StateMatch<T> = T extends readonly (infer E)[]
  ? Includes<E> | T
  : T extends object
    ? { readonly [K in keyof T]?: StateMatch<T[K]> }
    : T
type MatchVariant<T, M> = T extends unknown
  ? keyof M extends keyof T
    ? M extends { _tag: infer G }
      ? T extends { _tag: G }
        ? true
        : false
      : true
    : false
  : never
export type MatchCheck<T, M> =
  true extends MatchVariant<T, M> ? unknown : Msg<"State match fields must belong to one variant">
export type Matched<T, M> = T extends unknown
  ? keyof M extends keyof T
    ? M extends { _tag: infer G }
      ? T extends { _tag: G }
        ? T
        : never
      : T
    : never
  : never
export interface JourneyOperation<E> {
  cancelled(): Promise<{ status: "cancelled" }>
  completed(): Promise<void>
  expectError(): Promise<{ status: "error"; error: E }>
  expectRefusal(): Promise<{ status: "refused" }>
  cancel(): Promise<void>
}
export type JourneyActions<A, Mode> = {
  [K in keyof A]: A[K] extends Action<infer I, infer E, unknown>
    ? ((...args: InputArgs<I>) => Promise<Mode extends "outcome" ? ActionOutcome<E> : void>) & {
        expectError: (...args: InputArgs<I>) => Promise<{ status: "error"; error: E }>
        expectRefusal: (...args: InputArgs<I>) => Promise<{ status: "refused" }>
        start: (...args: InputArgs<I>) => Promise<JourneyOperation<E>>
      }
    : never
}
export interface JourneyNode<D, M = unknown, Mode = "assert"> {
  state(): Promise<Matched<State<D>, M>>
  readonly actions: JourneyActions<Actions<D>, Mode>
}
export interface JourneyClient<
  A extends AnyApp,
  K extends ScNames<A> = DefaultOf<A>,
  Mode = "assert",
> extends AsyncDisposable {
  readonly scenario: K
  focused<
    C extends Contract | AnyDef,
    const M extends StateMatch<State<Selected<A["screens"], NoInfer<C>>>> = StateMatch<
      State<Selected<A["screens"], C>>
    >,
  >(
    contract: C & ScreenMember<A["screens"], NoInfer<C>, A["name"]>,
    match?: M & NoInfer<MatchCheck<State<Selected<A["screens"], C>>, M>>,
  ): Promise<JourneyNode<Selected<A["screens"], C>, M, Mode>>
  node<D extends AnyDef>(
    definition: D & SessionMember<A, K, NoInfer<D>>,
  ): Promise<JourneyNode<D, unknown, Mode>>
  back(): Promise<void>
  advanceTime(duration: Duration.Input): Promise<void>
  reset<S extends ScNames<A>>(scenario: S): Promise<JourneyClient<A, S, Mode>>
  dispose(): Promise<void>
}
export type JourneyClientFor<A extends AnyApp, K extends ScNames<A> = DefaultOf<A>> = JourneyClient<
  A,
  K
>
export type TypedClient<A extends AnyApp, K extends ScNames<A> = DefaultOf<A>> = JourneyClient<
  A,
  K,
  "outcome"
>
