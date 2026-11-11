import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import type { ConsumerDefinition, ActionOutcome as LegacyOutcome } from "@reflex/runtime/internal"
import type { Erased } from "./erased.ts"
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type * as Redacted from "effect/Redacted"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
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
export type JsonCheck<T, M extends string> = [T] extends [undefined]
  ? unknown
  : [T] extends [import("@reflex/protocol").Json]
    ? unknown
    : [T] extends [JsonShape<T>]
      ? unknown
      : Msg<M>
export declare const authorTypes: unique symbol
export interface Contract {
  new (): object
  readonly name: string
  readonly state: { readonly Type: unknown }
  readonly [authorTypes]: { readonly paramsType: unknown; readonly encodedParams: unknown }
}
export interface Definition<
  C = unknown,
  A = unknown,
  S = unknown,
  R = never,
  Role extends string = string,
> extends ConsumerCompatibility<S, A> {
  readonly name: string
  readonly actions: A
  readonly [authorTypes]: {
    readonly contract: C
    readonly publicState: S
    readonly requirements: R
    readonly role: Role
    readonly paramsType: unknown
    readonly encodedParams: unknown
  }
}
export type AnyDef = Definition<unknown, unknown, unknown, unknown>
export type StateOf<T> = T extends { getState(): infer S } ? S : never
export type Actions<D> = D extends { actions: infer A } ? A : never
export type State<D> = D extends { [authorTypes]: { publicState: infer S } } ? Public<S> : never
export type Params<C> = C extends { [authorTypes]: { paramsType: infer P } } ? P : never
export type URLParams<C> = C extends { [authorTypes]: { encodedParams: infer P } } ? P : never
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
export type { NavigationCommand } from "@reflex/runtime/advanced"
import type { NavigationCommand } from "@reflex/runtime/advanced"
import type { terminal, navigationOwner } from "@reflex/runtime/internal"
export type Navigator<K extends string> = string extends K
  ? { readonly navigator: string }
  : {
      readonly navigator: K
      readonly [navigationOwner]: (key: K) => K
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
declare const actionBuilder: unique symbol
export interface Action<I = undefined, E = never, R = never, S = unknown> {
  readonly [actionBuilder]: (state: S) => S
  readonly [authorTypes]: { readonly input: I; readonly error: E; readonly requirements: R }
}
export type HasCommand<O> = [Extract<O, NavigationCommand>] extends [never]
  ? unknown
  : Msg<"Use action.navigates for actions that navigate">
export type ErrorCheck<E, C> = [Exclude<E, StateChanged>] extends [
  C extends undefined ? never : Dec<C>,
]
  ? unknown
  : Msg<"Declare action failures with error:">
export type NavRequirement<O> = O extends { readonly [terminal]: infer K extends string }
  ? Navigator<K>
  : never
export interface PlainEffectActionBuilder<S, All = S, G = never> {
  <
    I extends Codec | undefined = undefined,
    E extends Codec | undefined = undefined,
    O = void,
    HE = never,
    R = never,
  >(spec: {
    input?: I & JsonCheck<Enc<I>, "Input must encode JSON; use jsonCodec">
    error?: E & JsonCheck<Public<Enc<E>>, "Error must encode JSON; use jsonCodec">
    description?: string
    available?: (s: NoInfer<S>) => true | string
    handler: ((i: NoInfer<Dec<I>>, c: EffectContext<S, All, G>) => Effect.Effect<O, HE, R>) &
      HasCommand<O> &
      ErrorCheck<HE, E>
  }): Action<Enc<I>, E extends undefined ? never : Public<Enc<E>>, R, All>
  when<K extends Tags<S>>(tag: K): PlainEffectActionBuilder<Narrow<S, K>, All, StateChanged>
  reduce<I extends Codec | undefined = undefined>(spec: {
    input?: I & JsonCheck<Enc<I>, "Input must encode JSON; use jsonCodec">
    description?: string
    available?: (s: S) => true | string
    reducer: (i: NoInfer<Dec<I>>, s: S) => All
  }): Action<Enc<I>, never, never, All>
}
type Success<H> = H extends Effect.Effect<infer O, infer _E, infer _R> ? O : H
type Failure<H> = H extends Effect.Effect<infer _O, infer E, infer _R> ? E : never
type Environment<H> = H extends Effect.Effect<infer _O, infer _E, infer R> ? R : never
export interface EffectActionBuilder<S, All = S, G = never> {
  <
    I extends Codec | undefined = undefined,
    E extends Codec | undefined = undefined,
    O = void,
    HE = never,
    R = never,
  >(spec: {
    input?: I & JsonCheck<Enc<I>, "Input must encode JSON; use jsonCodec">
    error?: E & JsonCheck<Public<Enc<E>>, "Error must encode JSON; use jsonCodec">
    description?: string
    available?: (s: NoInfer<S>) => true | string
    handler: ((i: NoInfer<Dec<I>>, c: EffectContext<S, All, G>) => Effect.Effect<O, HE, R>) &
      HasCommand<O> &
      ErrorCheck<HE, E>
  }): Action<Enc<I>, E extends undefined ? never : Public<Enc<E>>, R, All>
  navigates<
    I extends Codec | undefined = undefined,
    E extends Codec | undefined = undefined,
    H extends
      | NavigationCommand
      | Effect.Effect<NavigationCommand, unknown, unknown> = NavigationCommand,
    RO = void,
    RR = never,
  >(spec: {
    input?: I & JsonCheck<Enc<I>, "Input must encode JSON; use jsonCodec">
    error?: E & JsonCheck<Public<Enc<E>>, "Error must encode JSON; use jsonCodec">
    description?: string
    available?: (s: NoInfer<S>) => true | string
    handler: ((i: NoInfer<Dec<I>>, c: EffectContext<S, All, G>) => H) & ErrorCheck<Failure<H>, E>
    onRefused?: ((
      error: NavigationRefused,
      c: EffectContext<S, All>,
    ) => Effect.Effect<RO, StateChanged, RR>) &
      // biome-ignore lint/suspicious/noConfusingVoidType: Effect void is distinct from undefined.
      ([RO] extends [void] ? unknown : Msg<"Navigation refusal recovery must return void">)
  }): Action<
    Enc<I>,
    E extends undefined ? never : Public<Enc<E>>,
    Environment<H> | RR | NavRequirement<Success<H>>,
    All
  >
  when<K extends Tags<S>>(tag: K): EffectActionBuilder<Narrow<S, K>, All, StateChanged>
  reduce<I extends Codec | undefined = undefined>(spec: {
    input?: I & JsonCheck<Enc<I>, "Input must encode JSON; use jsonCodec">
    description?: string
    available?: (s: S) => true | string
    reducer: (i: NoInfer<Dec<I>>, s: S) => All
  }): Action<Enc<I>, never, never, All>
}
export type ActionMapCheck<A, S> = [A[keyof A]] extends [Action<unknown, unknown, unknown, S>]
  ? unknown
  : Msg<"Actions must be built for this state with the action builder">
export type Requirements<A> = A[keyof A] extends infer V
  ? V extends { [authorTypes]: { requirements: infer R } }
    ? R
    : never
  : never
export type Names<D> = D extends { name: infer N extends string } ? N : never
export type Contracts<D> = D extends { [authorTypes]: { role: "store" } }
  ? D
  : D extends { [authorTypes]: { contract: infer C } }
    ? C
    : never
export type DefinitionMap<D> = {
  [Item in Extract<D, { readonly name: string }> as Item["name"]]: Item
}
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
export interface StoreOverride<D = unknown> {
  readonly definition: D
  readonly factory: (...params: never[]) => unknown
}
export interface Scenario {
  readonly stores?: readonly StoreOverride[]
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
type DefinitionReq<D> = D extends { [authorTypes]: { requirements: infer R } } ? R : never
type FixtureAccess<F> = F extends { name: infer N extends string } ? { readonly fixture: N } : never
export type Normalize<Sc, F> = {
  [K in keyof Sc]: Sc[K] & { readonly fixtures: readonly FixtureOf<Sc[K], F>[] }
}
type CommonOutput<C> = unknown extends C
  ? never
  : C extends Layer.Layer<infer P, infer _E, infer _R>
    ? P
    : C
type MissingStage<Req, Available> = Exclude<Req, Available | Scope.Scope>
export type Coverage<Sc, Req, Common, F, Nav = never> = {
  [K in keyof Sc]:
    | MissingStage<LayerInput<Common>, FixtureAccess<FixtureOf<Sc[K], F>>>
    | MissingStage<
        LayerInput<ScenarioLayer<Sc[K]>>,
        CommonOutput<Common> | FixtureAccess<FixtureOf<Sc[K], F>>
      >
    | MissingStage<
        Req | DefinitionReq<FixtureOf<Sc[K], F>>,
        | CommonOutput<Common>
        | LayerOutput<ScenarioLayer<Sc[K]>>
        | FixtureAccess<FixtureOf<Sc[K], F>>
        | Nav
      > extends infer Missing
    ? [Missing] extends [never]
      ? unknown
      : { readonly [P in `Scenario '${K & string}' must provide`]: Missing }
    : never
}
export type ScenarioCoverage<Sc, D, V, F, Common = never> = Coverage<
  Sc,
  DefinitionReq<D> | DefinitionReq<V>,
  Common,
  F,
  Navigator<string>
>
type FixtureDefault<F, FF> = FF extends readonly (infer D)[] ? D : F
type OverrideDefinition<O> = O extends { readonly definition: infer D } ? D : never
type StoreOverrideCheck<Sc, Allowed> = {
  [K in keyof Sc]: Sc[K] extends { stores: readonly (infer O)[] }
    ? Exclude<Names<OverrideDefinition<O>>, Names<Allowed>> extends never
      ? unknown
      : Msg<"Scenario stores must belong to this app">
    : unknown
}
export interface App<
  N extends string = string,
  D = unknown,
  V = unknown,
  Sc extends ScenarioMap = ScenarioMap,
  Default extends keyof Sc = keyof Sc,
  F = never,
  Common = never,
> {
  readonly [APP_HOST_ADAPTER]: import("@reflex/runtime/internal").AppHost & {
    readonly nodes: DefinitionMap<D | V | F | ScenarioFixtureUnion<Sc>>
    readonly screens: DefinitionMap<D>
    readonly scenarioNames: readonly (keyof Sc & string)[]
    readonly defaultScenario: Default & string
  }
  readonly nodes: DefinitionMap<D | V | F | ScenarioFixtureUnion<Sc>>
  readonly name: N
  readonly screens: D
  readonly services: V
  readonly scenarios: Sc
  readonly defaultScenario: Default
  readonly scenarioNames: readonly (keyof Sc & string)[]
  readonly fixtures: F
  readonly provided: Common
  withScenarios<
    const Extra extends ScenarioMap,
    const K extends string,
    const FF extends readonly AnyDef[] | undefined = undefined,
  >(
    extra: Extra &
      NoInfer<StoreOverrideCheck<Extra, D | V>> & {
        [P in keyof Extra &
          keyof Sc]: Msg<`Scenario ${P & string} already exists; choose a new name`>
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
    extra: Extra &
      NoInfer<StoreOverrideCheck<Extra, D | V>> & {
        [P in keyof Extra &
          keyof Sc]: Msg<`Scenario ${P & string} already exists; choose a new name`>
      } & NoInfer<ScenarioCoverage<Extra, D, V, F, Common>>,
  ): App<N, D, V, Normalize<Sc, F> & Normalize<Extra, F>, Default, F, Common>
}

/** Compatibility with the existing journey and UI consumers during migration. */
export interface ConsumerCompatibility<S, A>
  extends ConsumerDefinition<Public<S>, ConsumerCalls<A>> {
  resolve(
    runtime: import("@reflex/runtime/internal").Runtime,
    id?: import("@reflex/protocol").NodeId,
  ): import("./capability.ts").LiveNode<Public<S>, A> | undefined
}
type ConsumerCalls<A> = {
  readonly [K in keyof A]: A[K] extends Action<infer I, infer E, unknown, Erased>
    ? (...args: [I] extends [undefined] ? [] : [input: I]) => Promise<LegacyOutcome<E>>
    : never
}

type ScenarioFixtureUnion<S> = S[keyof S] extends infer V
  ? V extends { fixtures: readonly (infer F)[] }
    ? F
    : never
  : never
